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
/// `BRIDGE_OK`, then pumps server bytes to stdout. Closing the TCP write side
/// ends the pump and the bridge exits 0.
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

    let mut out = child.stdout.take().expect("stdout");
    let mut buf = vec![0u8; frame.len()];
    out.read_exact(&mut buf).expect("read stdout");
    assert_eq!(&buf[..], &frame[..], "TCP->stdout pump preserves bytes");

    // Closing the server side ends the bridge's TCP read -> its pump thread
    // signals completion -> main returns SUCCESS.
    drop(stream);
    let status = child.wait().expect("wait");
    assert!(status.success(), "clean pump end -> exit 0, got {status}");
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
