//! Integration tests for the `toptopduck-acp-bridge` binary (ADR-0085 slice 9b).
//!
//! Each test stands up a fake gateway TCP listener, spawns the bridge binary
//! with the matching env (`TOPTOPDUCK_GATEWAY_PORT` / `_TOKEN`), and asserts on
//! the wire protocol: the `BRIDGE_AUTH <token>` line, the `BRIDGE_OK` reply,
//! the post-handshake byte pump, and the exit codes for each failure mode.
//!
//! The bridge is a pure stdio<->TCP proxy with no awareness of MCP semantics,
//! so these tests never send real MCP -- any bytes will do to exercise the pump.
//! The full bridge + real gateway + real CLI loop is the 9c end-to-end surface.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};

/// The bridge's env var names, mirrored from the binary so a rename here fails
/// loudly rather than the bin silently reading a stale name.
const ENV_PORT: &str = "TOPTOPDUCK_GATEWAY_PORT";
const ENV_TOKEN: &str = "TOPTOPDUCK_GATEWAY_TOKEN";

/// `env!` resolves the built bin path at compile time; the cargo `[[bin]]`
/// target `toptopduck-acp-bridge` makes this macro available.
fn bridge_bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_toptopduck-acp-bridge"))
}

/// The happy path: the bridge connects, writes `BRIDGE_AUTH <token>`, reads
/// `BRIDGE_OK`, then pumps server bytes to stdout. Closing the server TCP side
/// ends the bridge's TCP read -> its pump thread sees EOF -> main returns 0.
#[test]
fn bridge_handshakes_then_pumps_server_to_stdout() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let token = "deadbeef";

    let mut child = bridge_bin()
        .env(ENV_PORT, port.to_string())
        .env(ENV_TOKEN, token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bridge");

    let (mut stream, _) = listener.accept().expect("accept");

    // Handshake: read the auth line, assert it carries the env token verbatim,
    // then acknowledge so the bridge enters the pump phase.
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    reader.read_line(&mut line).expect("read auth");
    assert_eq!(line, format!("BRIDGE_AUTH {token}\n"));
    stream.write_all(b"BRIDGE_OK\n").expect("write ok");

    // Pump phase: send one frame, expect it back on the bridge's stdout
    // byte-for-byte (the bridge forwards framing, it does not parse it).
    let frame = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n";
    stream.write_all(frame).expect("write frame");
    stream.flush().expect("flush");
    // Give the bridge time to read the frame from its TCP receive buffer and
    // pump it to stdout before the stream is closed. Without this delay the
    // bridge's BufReader (carried from the handshake) may see the connection
    // close before it has drained the frame from its internal buffer or the
    // kernel receive queue.
    std::thread::sleep(std::time::Duration::from_millis(100));

    // Drain stdout + stderr on background threads. Reading either pipe on the
    // main thread is a classic deadlock risk: the main thread blocks on
    // read_exact while the bridge blocks on a pipe write (or never sees a TCP
    // EOF because the main thread never reaches `drop(stream)`), so neither
    // progresses. Background threads keep both pipes draining and let the main
    // thread proceed straight to `drop(stream)` -> bridge TCP-EOF exit. Both
    // pipes return EOF when the bridge exits, so each join resolves then.
    let mut out = child.stdout.take().expect("stdout");
    let stdout = std::thread::spawn(move || {
        let mut buf = Vec::new();
        out.read_to_end(&mut buf).expect("read stdout");
        buf
    });
    let mut err = child.stderr.take().expect("stderr");
    let stderr = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = err.read_to_string(&mut buf);
        buf
    });

    // Closing the server side ends the bridge's TCP read -> its pump thread
    // forwards the already-buffered frame, then sees EOF -> signals completion
    // -> main returns SUCCESS.
    drop(stream);
    let status = child.wait().expect("wait");
    let stdout_buf = stdout.join().expect("stdout thread");
    let stderr_buf = stderr.join().expect("stderr thread");

    assert!(
        status.success(),
        "clean pump end -> exit 0, got {status}; stderr: {stderr_buf}"
    );
    assert!(
        stdout_buf.starts_with(&frame[..]),
        "TCP->stdout pump preserves the frame; got {:?}",
        String::from_utf8_lossy(&stdout_buf)
    );
}

/// A handshake line that is not exactly `BRIDGE_OK` is a refuse; the bridge
/// exits 3 so the CLI surfaces "bridge refused" rather than hanging.
#[test]
fn bridge_exits_3_when_handshake_refused() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();

    let mut child = bridge_bin()
        .env(ENV_PORT, port.to_string())
        .env(ENV_TOKEN, "abc")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn bridge");

    let (mut stream, _) = listener.accept().expect("accept");
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    reader.read_line(&mut line).expect("read auth");
    assert_eq!(line, "BRIDGE_AUTH abc\n");
    // Refuse: anything other than the exact `BRIDGE_OK` line.
    stream.write_all(b"REFUSED\n").expect("write refuse");
    drop(stream);

    let status = child.wait().expect("wait");
    assert_eq!(
        status.code(),
        Some(3),
        "refused handshake -> exit 3, got {status}"
    );
}

/// Missing env -> the bridge never even connects; it exits 1 at startup. The
/// `env_remove`s guard against a parent shell that happens to export the vars.
#[test]
fn bridge_exits_1_when_env_missing() {
    let mut child = bridge_bin()
        .env_remove(ENV_PORT)
        .env_remove(ENV_TOKEN)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn bridge");
    let status = child.wait().expect("wait");
    assert_eq!(
        status.code(),
        Some(1),
        "missing env -> exit 1, got {status}"
    );
}

/// Regression for issue #357: the TCP -> stdout pump must flush per forwarded
/// chunk, not defer like `io::copy`. The stdout sink is `StdoutLock` (a
/// `LineWriter`), which only drains its buffer past a newline; if a partial
/// JSON-RPC frame (TCP-segmented mid-line) sits in that buffer, the gateway's
/// `read_message` on the far side of the pipe stalls and the turn deadlocks.
/// This test splits one frame at a non-newline byte boundary across two TCP
/// writes with a pause between, and asserts the FIRST segment lands on the
/// bridge's stdout before the second write -- the behavior `io::copy` would
/// NOT exhibit (it would buffer the partial line in the `LineWriter` until the
/// newline arrives, and this assertion would time out).
#[test]
fn pump_flushes_each_chunk_under_mid_line_tcp_segmentation() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let token = "deadbeef";

    let mut child = bridge_bin()
        .env(ENV_PORT, port.to_string())
        .env(ENV_TOKEN, token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bridge");

    let (mut stream, _) = listener.accept().expect("accept");
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    reader.read_line(&mut line).expect("read auth");
    assert_eq!(line, format!("BRIDGE_AUTH {token}\n"));
    stream.write_all(b"BRIDGE_OK\n").expect("write ok");

    // Split one frame at a non-newline byte boundary. Part 1 carries no
    // newline; a `LineWriter` sink holds it until part 2 brings the newline.
    let frame = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n";
    let split = frame.len() / 2;
    let (part1, part2) = frame.split_at(split);

    // Stream the bridge's stdout on a background thread, forwarding each read
    // to a channel. A blocking read on the main thread would deadlock against
    // the bridge's pipe write if the pump buffered part 1.
    let mut out = child.stdout.take().expect("stdout");
    let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match out.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if chunk_tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let mut err = child.stderr.take().expect("stderr");
    let stderr = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = err.read_to_string(&mut buf);
        buf
    });

    // Send part 1 (no newline) + flush. Per-chunk flush forwards it at once;
    // `io::copy` would buffer it in the LineWriter.
    stream.write_all(part1).expect("write part1");
    stream.flush().expect("flush part1");

    // The first stdout chunk must arrive within the timeout. Under `io::copy`
    // the LineWriter holds part 1 and this recv times out -- that is the
    // regression this test pins.
    let first = chunk_rx
        .recv_timeout(std::time::Duration::from_millis(500))
        .expect("per-chunk flush forwards part 1 before part 2 is written");
    assert_eq!(first, part1, "first forwarded chunk is part 1 verbatim");

    // Part 2 completes the frame; drop the TCP side to end the bridge's read.
    stream.write_all(part2).expect("write part2");
    stream.flush().expect("flush part2");
    drop(stream);

    let status = child.wait().expect("wait");
    let stderr_buf = stderr.join().expect("stderr thread");
    assert!(
        status.success(),
        "clean pump end -> exit 0, got {status}; stderr: {stderr_buf}"
    );
}
