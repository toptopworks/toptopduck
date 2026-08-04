//! ACP bridge process (ADR-0085, issue #299 slice 9b).
//!
//! A thin stdio<->TCP proxy the external CLI launches as its MCP server (the
//! `McpServer::stdio_bridge` descriptor in the engine). The CLI injects the
//! gateway's localhost port + per-turn auth token via environment variables;
//! this binary connects back, presents the token, then pumps bytes both ways
//! for the rest of the turn.
//!
//! Pure std on purpose -- no `toptopduck_lib` import, no serde, no JSON parsing
//! (ADR-0085: the bridge is transport only). The MCP stdio transport already
//! carries one JSON-RPC message per line; the bridge forwards that identical
//! framing on both sides, so it has nothing to parse. All semantics live in the
//! gateway ([`toptopduck_lib::runtime::gateway::server::serve_connection`]):
//! approval, dispatch, materialization. Keeping this binary protocol-blind is
//! what lets the gateway stay the single enforcement point.
//!
//! Wire protocol (one turn, one bridge process):
//! 1. `TcpStream::connect("127.0.0.1:{TOPTOPDUCK_GATEWAY_PORT}")`.
//! 2. Write the literal line `BRIDGE_AUTH {TOPTOPDUCK_GATEWAY_TOKEN}\n`.
//! 3. Read one line; it must be exactly `BRIDGE_OK\n`. Anything else (a refuse,
//!    a closed stream, a timeout) is a fatal handshake failure -- exit 3 so the
//!    CLI surfaces "bridge refused" rather than hanging on a silent reject.
//! 4. Pump bytes both directions until one side closes: stdin -> TCP and
//!    TCP -> stdout. Either direction ending ends the process; the OS reaps
//!    the still-blocked half (a half-close + drain would be cleaner but adds
//!    machinery the protocol's request/response shape does not need -- the
//!    gateway closes the TCP side as soon as its serve loop returns).
//!
//! Exit codes: `0` clean (one pump half finished), `1` missing/invalid env,
//! `2` TCP connect or handshake-write failure, `3` handshake refused.

use std::env;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::process::ExitCode;
use std::sync::mpsc;
use std::thread;

/// The env var carrying the gateway's OS-assigned localhost port.
const ENV_PORT: &str = "TOPTOPDUCK_GATEWAY_PORT";
/// The env var carrying the per-turn auth token (64 hex chars, 244-bit entropy).
const ENV_TOKEN: &str = "TOPTOPDUCK_GATEWAY_TOKEN";

fn main() -> ExitCode {
    // The gateway mints both per turn (ADR-0085 per-bridge lifecycle), so a
    // missing var means the descriptor was misconfigured -- fail fast rather
    // than silently connecting to a wrong port.
    let port = match env::var(ENV_PORT) {
        Ok(v) => v,
        Err(_) => return ExitCode::from(1),
    };
    let token = match env::var(ENV_TOKEN) {
        Ok(v) => v,
        Err(_) => return ExitCode::from(1),
    };

    let stream = match TcpStream::connect(format!("127.0.0.1:{port}")) {
        Ok(s) => s,
        Err(_) => return ExitCode::from(2),
    };
    // A cloned handle for the write side; the original feeds BufReader for the
    // handshake read + the TCP->stdout pump (the reader may buffer bytes past
    // BRIDGE_OK if the gateway pipelines the first MCP frame, so the same
    // BufReader must carry into the pump -- a fresh stream would lose them).
    let mut write_half = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return ExitCode::from(2),
    };
    let mut read_half = BufReader::new(stream);

    match handshake(&mut read_half, &mut write_half, &token) {
        HandshakeOutcome::Ok => {}
        HandshakeOutcome::Refused => return ExitCode::from(3),
        HandshakeOutcome::IoError => return ExitCode::from(2),
    }

    pump(read_half, write_half)
}

/// The handshake's three terminal outcomes, kept as an enum so the caller can
/// map each to its distinct exit code without re-reading the stream state.
enum HandshakeOutcome {
    Ok,
    Refused,
    IoError,
}

/// Write `BRIDGE_AUTH <token>\n` and expect `BRIDGE_OK\n` back. A clean EOF or
/// any line that is not exactly `BRIDGE_OK` is a refuse -- the gateway drops
/// the socket on a token mismatch without responding (ADR-0085 security model:
/// a probing client learns nothing beyond "refused").
fn handshake(
    read_half: &mut impl BufRead,
    write_half: &mut impl Write,
    token: &str,
) -> HandshakeOutcome {
    if write_half
        .write_all(format!("BRIDGE_AUTH {token}\n").as_bytes())
        .is_err()
    {
        return HandshakeOutcome::IoError;
    }
    if write_half.flush().is_err() {
        return HandshakeOutcome::IoError;
    }
    let mut line = String::new();
    match read_half.read_line(&mut line) {
        Ok(0) | Err(_) => return HandshakeOutcome::Refused,
        Ok(_) => {}
    }
    if line.trim_end_matches(['\r', '\n']) == "BRIDGE_OK" {
        HandshakeOutcome::Ok
    } else {
        HandshakeOutcome::Refused
    }
}

/// Pump bytes both directions until one half closes, then return. The first
/// half to finish wins; the process exits and the OS reaps the other thread.
///
/// stdin -> TCP runs on a spawned thread because `StdinLock` is not `Send`; it
/// is locked inside the thread. TCP -> stdout runs on a second spawned thread
/// for symmetry (and so a server-side close ends the process even while stdin
/// is still open). A shared `mpsc::channel` signals completion from either.
///
/// Each chunk is `write_all` + `flush`, NOT `io::copy`. The TCP -> stdout sink
/// is `StdoutLock` (a `LineWriter`), which only drains its internal buffer past
/// a newline; a partial chunk read off the socket (TCP may segment a JSON-RPC
/// frame mid-line) would sit in that buffer until the *next* newline arrives,
/// so the fixture's `read_line` on the far side of the bridge pipe stalls.
/// `io::copy` would also eventually flush once the rest of the line arrived,
/// but under the fixture's tight request/response interleaving the deferred
/// drain deadlocks the turn (issue #357: the Linux CI suite parked for the full
/// wall-clock watchdog). Flushing per forwarded chunk drains the pipe promptly
/// regardless of how the kernel segments the stream.
fn pump(mut tcp_to_stdout: impl Read + Send + 'static, mut stdin_to_tcp: TcpStream) -> ExitCode {
    let (tx, rx) = mpsc::channel();
    let tcp_done = tx.clone();
    let stdin_done = tx;

    thread::spawn(move || {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        let mut buf = [0u8; 1024];
        loop {
            match tcp_to_stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if out.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = out.flush();
                }
                Err(_) => break,
            }
        }
        let _ = tcp_done.send(());
    });

    thread::spawn(move || {
        let stdin = io::stdin();
        let mut inp = stdin.lock();
        let mut buf = [0u8; 1024];
        loop {
            match inp.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if stdin_to_tcp.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    let _ = stdin_to_tcp.flush();
                }
                Err(_) => break,
            }
        }
        // Half-close the write side so the gateway's read loop sees EOF and can
        // return cleanly; if the gateway already closed first this is a no-op.
        let _ = stdin_to_tcp.shutdown(Shutdown::Write);
        let _ = stdin_done.send(());
    });

    // Block until either direction finishes, then let the process exit -- the
    // other thread is still blocked in its read and gets reaped by the OS.
    let _ = rx.recv();
    ExitCode::SUCCESS
}
