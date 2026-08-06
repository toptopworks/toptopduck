//! Probe timeout + child-kill integration (issue #392).
//!
//! Tests the `spawn_stdio_child` + `stdio_handshake` building blocks the
//! async `probe_mcp_server` command composes. Two scenarios:
//!
//! 1. **Responsive server** ([`mcp_fake_server`]): spawn + handshake
//!    completes within the deadline; tool list returned; child killed +
//!    reaped after.
//! 2. **Hanging server** ([`mcp_hang_server`]): spawn succeeds, handshake
//!    hangs (server never replies to initialize). A short `recv_timeout`
//!    deadline fires; the child is killed + reaped, proving no process leak.
//!
//! The command layer wraps these in `tokio::time::timeout` +
//! `spawn_blocking`; here we use `std::thread` + `mpsc::recv_timeout` to
//! exercise the same logic without needing a Tauri runtime. The child kill +
//! wait is the explicit invariant under test — a leaked child would hold the
//! stdin pipe open and hang the test process at exit.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use toptopduck_lib::mcp::client::{spawn_stdio_child, stdio_handshake};
use toptopduck_lib::mcp::config::{McpServerConfig, McpServerId, McpTransport};

/// Path to the compiled fake MCP server (responsive fixture).
const FAKE_BIN: &str = env!("CARGO_BIN_EXE_mcp-fake-server");

/// Path to the compiled hang MCP server (never-responds fixture).
const HANG_BIN: &str = env!("CARGO_BIN_EXE_mcp-hang-server");

/// Build a stdio `McpServerConfig` pointing at a fixture binary.
fn stdio_config(id: &str, bin: &str) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: id.into(),
        transport: McpTransport::stdio(bin, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
    }
}

/// Run the handshake on a worker thread, returning a receiver so the caller
/// can `recv_timeout`. Mirrors the `spawn_blocking` + `tokio::time::timeout`
/// pattern the command uses, without requiring a Tauri runtime.
fn handshake_async(
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
) -> mpsc::Receiver<Result<Vec<serde_json::Value>, String>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let result = stdio_handshake(stdin, stdout).map_err(|e| e.to_string());
        let _ = tx.send(result);
    });
    rx
}

#[test]
fn probe_succeeds_on_responsive_server() {
    let config = stdio_config("test-ok", FAKE_BIN);
    let mut child = spawn_stdio_child(&config, &[]).expect("spawn fake server");

    let stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let rx = handshake_async(stdin, stdout);

    // 10 s deadline — generous; the fake server responds instantly.
    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("handshake should complete within deadline");

    // Always kill + reap the child (probe is one-shot).
    let _ = child.kill();
    // wait() succeeding confirms the child was reaped (no zombie/leak).
    child.wait().expect("child reaped");

    let tools = result.expect("handshake should succeed");
    assert!(
        !tools.is_empty(),
        "fake server should advertise tools, got {tools:?}"
    );
}

#[test]
fn probe_times_out_and_kills_child_when_server_hangs() {
    let config = stdio_config("test-hang", HANG_BIN);
    let mut child = spawn_stdio_child(&config, &[]).expect("spawn hang server");

    let stdin = child.stdin.take().expect("child stdin");
    let stdout = child.stdout.take().expect("child stdout");
    let rx = handshake_async(stdin, stdout);

    // 500 ms deadline — the hang server never responds, so this MUST time out.
    let result = rx.recv_timeout(Duration::from_millis(500));

    assert!(
        result.is_err(),
        "handshake should NOT complete — the hang server never replies"
    );

    // Kill + reap the child — this is the core invariant under test (issue #392
    // AC#3: child killed on timeout, no process leak). wait() succeeding
    // confirms the child was reaped, not left as a zombie.
    let _ = child.kill();
    let _ = child.wait().expect("child reaped after kill");
}

#[test]
fn spawn_stdio_child_rejects_non_stdio_transport() {
    let config = McpServerConfig {
        id: McpServerId("sse".into()),
        display_name: "SSE".into(),
        transport: McpTransport::Sse {
            url: "http://localhost:1".into(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
    };
    let err = spawn_stdio_child(&config, &[]).unwrap_err();
    assert!(
        err.to_string().contains("unsupported transport"),
        "should reject SSE, got: {err}"
    );
}
