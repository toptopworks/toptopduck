//! Probe timeout + child-kill integration (issue #392).
//!
//! Tests the `spawn_stdio_child` + `stdio_handshake` building blocks the
//! async `probe_mcp_server` command composes. Three scenarios:
//!
//! 1. **Responsive server** ([`mcp_fake_server`]): spawn + handshake
//!    completes within the deadline; tool list returned; child killed +
//!    reaped after.
//! 2. **Hanging server** ([`mcp_hang_server`]): spawn succeeds, handshake
//!    hangs (server never replies to initialize). A short `recv_timeout`
//!    deadline fires; the child is killed + reaped, proving no process leak.
//! 3. **Paginated server** ([`mcp_paginated_server`]): the handshake folds a
//!    two-page `tools/list` joined by `nextCursor` (issue #900).
//!
//! The command layer wraps these in `tokio::time::timeout` +
//! `spawn_blocking`; here we use `std::thread` + `mpsc::recv_timeout` to
//! exercise the same logic without needing a Tauri runtime. The child kill +
//! reap is the explicit invariant under test — a leaked child would hold the
//! stdin pipe open and hang the test process at exit.

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use toptopduck_lib::mcp::client::{spawn_stdio_child, stdio_handshake, StdioChildHandle};
use toptopduck_lib::mcp::config::{McpServerConfig, McpServerId, McpTransport};

/// Path to the compiled fake MCP server (responsive fixture).
const FAKE_BIN: &str = env!("CARGO_BIN_EXE_mcp-fake-server");

/// Path to the compiled hang MCP server (never-responds fixture).
const HANG_BIN: &str = env!("CARGO_BIN_EXE_mcp-hang-server");

/// Path to the compiled paginated MCP server fixture (issue #900): a
/// two-page `tools/list` answer joined by `nextCursor`.
const PAGINATED_BIN: &str = env!("CARGO_BIN_EXE_mcp-paginated-server");

/// Path to the CLI fake-tool fixture (shared test asset): its `--orphan`
/// mode spawns a grandchild that inherits stdout and outlives it.
const CLI_TOOL_BIN: &str = env!("CARGO_BIN_EXE_cli-fake-tool");

/// Build a stdio `McpServerConfig` pointing at a fixture binary.
fn stdio_config(id: &str, bin: &str) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: id.into(),
        transport: McpTransport::stdio(bin, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    }
}

/// Kill the child's tree and reap the direct child, asserting the reap
/// (wait() succeeding confirms the child was reaped — no zombie/leak). The
/// tests run on plain threads, so the async reap rides a throwaway
/// current-thread runtime.
fn kill_and_reap(child: &mut StdioChildHandle) {
    child.kill();
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("test reap runtime");
    rt.block_on(child.reap()).expect("child reaped");
}

/// Run the handshake on a worker thread, returning a receiver so the caller
/// can `recv_timeout`. Mirrors the `spawn_blocking` + `tokio::time::timeout`
/// pattern the command uses, without requiring a Tauri runtime. `server` is
/// the attribution label `stdio_handshake` threads into `list_tools`.
fn handshake_async(
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    server: &str,
) -> mpsc::Receiver<Result<Vec<serde_json::Value>, String>> {
    let (tx, rx) = mpsc::channel();
    let server = server.to_string();
    thread::spawn(move || {
        let result = stdio_handshake(stdin, stdout, &server).map_err(|e| e.to_string());
        let _ = tx.send(result);
    });
    rx
}

#[test]
fn probe_succeeds_on_responsive_server() {
    let config = stdio_config("test-ok", FAKE_BIN);
    let mut child = spawn_stdio_child(&config, &[]).expect("spawn fake server");

    let stdin = child.take_stdin().expect("child stdin");
    let stdout = child.take_stdout().expect("child stdout");
    let rx = handshake_async(stdin, stdout, "test-ok");

    // 10 s deadline — generous; the fake server responds instantly.
    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("handshake should complete within deadline");

    // Always kill + reap the child (probe is one-shot).
    kill_and_reap(&mut child);

    let tools = result.expect("handshake should succeed");
    assert!(
        !tools.is_empty(),
        "fake server should advertise tools, got {tools:?}"
    );
}

/// Issue #900: the probe handshake folds the whole multi-page `tools/list` --
/// the page-2 tool (`fetch_page2`) is only reachable via the cursor, so its
/// presence pins the pagination through the exact building blocks
/// `probe_mcp_server` composes (the settings page's tool count reads every
/// page, not just the first).
#[test]
fn probe_lists_all_tools_across_pages() {
    let config = stdio_config("test-pages", PAGINATED_BIN);
    let mut child = spawn_stdio_child(&config, &[]).expect("spawn paginated server");

    let stdin = child.take_stdin().expect("child stdin");
    let stdout = child.take_stdout().expect("child stdout");
    let rx = handshake_async(stdin, stdout, "test-pages");

    // 10 s deadline — generous; the fake server responds instantly.
    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("handshake should complete within deadline");

    // Always kill + reap the child (probe is one-shot).
    kill_and_reap(&mut child);

    let tools = result.expect("handshake should succeed");
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    assert_eq!(
        names,
        vec!["echo", "add", "fetch_page2"],
        "both pages' tools listed, got {tools:?}"
    );
}

#[test]
fn probe_times_out_and_kills_child_when_server_hangs() {
    let config = stdio_config("test-hang", HANG_BIN);
    let mut child = spawn_stdio_child(&config, &[]).expect("spawn hang server");

    let stdin = child.take_stdin().expect("child stdin");
    let stdout = child.take_stdout().expect("child stdout");
    let rx = handshake_async(stdin, stdout, "test-hang");

    // 500 ms deadline — the hang server never responds, so this MUST time out.
    let result = rx.recv_timeout(Duration::from_millis(500));

    assert!(
        result.is_err(),
        "handshake should NOT complete — the hang server never replies"
    );

    // Kill + reap the child — this is the core invariant under test (issue #392
    // AC#3: child killed on timeout, no process leak). The reap assert
    // confirms the child was reaped, not left as a zombie.
    kill_and_reap(&mut child);
}

#[test]
fn spawn_stdio_child_rejects_non_stdio_transport() {
    let config = McpServerConfig {
        id: McpServerId("sse".into()),
        display_name: "SSE".into(),
        transport: McpTransport::Sse {
            url: "http://localhost:1".into(),
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let err = spawn_stdio_child(&config, &[]).unwrap_err();
    assert!(
        err.to_string().contains("unsupported transport"),
        "should reject SSE, got: {err}"
    );
}

/// #1456 AC2: the kill is idempotent — deadline expiry and cancel teardown
/// may both fire it (and the Drop backstop a third time), so re-firing on
/// an already-dead tree must be a harmless no-op: neither panic nor
/// unwind. The retired sync design's contract ("killing an already-dead
/// child ... is a harmless no-op") kept verbatim.
#[test]
fn kill_is_idempotent_on_an_already_dead_child() {
    let config = stdio_config("test-idem", FAKE_BIN);
    let mut child = spawn_stdio_child(&config, &[]).expect("spawn fake server");
    kill_and_reap(&mut child);
    // Two more fires on the reaped tree: both must return cleanly.
    child.kill();
    child.kill();
}

/// #1456 AC1: killing the stdio child takes the whole process tree down.
/// The fixture spawns a grandchild that inherits the child's stdout pipe
/// and outlives it (the `npx`/`uvx` wrapper shape), so the read end sees
/// EOF only when the GRANDCHILD dies — the direct child exits on its own
/// after its short sleep. A bare direct-child kill (the retired sync
/// design) would leave the grandchild holding the pipe's write end forever.
/// Both platforms ride the same assertion: the pipe write-end closing IS
/// the observable of the tree dying.
#[test]
fn kill_takes_the_spawned_grandchild_down_with_the_tree() {
    let config = McpServerConfig {
        id: McpServerId("test-tree".into()),
        display_name: "test-tree".into(),
        // `--orphan` spawns the grandchild immediately; the short `--sleep`
        // keeps the direct child alive past the spawn-side guard assignment
        // (a Windows job assign races an already-exited child), then it
        // exits on its own — well before the 30 s grandchild sleep.
        transport: McpTransport::stdio(
            CLI_TOOL_BIN.to_string(),
            vec!["--orphan".into(), "--sleep".into(), "500".into()],
        ),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let mut child = spawn_stdio_child(&config, &[]).expect("spawn orphaning tool");
    let stdout = child.take_stdout().expect("child stdout");

    // The read parks on the grandchild-held pipe: the direct child exits
    // within ~500 ms without writing, and the grandchild (asleep for 30 s)
    // never writes, so any return is the EOF the tree kill produced.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        use tokio::io::AsyncBufReadExt;
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .expect("pin runtime");
        let n = rt.block_on(async {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut line = String::new();
            reader.read_line(&mut line).await
        });
        let _ = tx.send(n);
    });

    // Let the direct child exit on its own first (its death must NOT settle
    // the read — only the grandchild's write end can), then fire the kill.
    thread::sleep(Duration::from_millis(800));
    child.kill();

    let n = rx
        .recv_timeout(Duration::from_secs(10))
        .expect(
            "the read settled within 10 s — the tree kill took the \
             pipe-holding grandchild down (a bare direct-child kill would \
             leave it holding the write end forever)",
        )
        .expect("the pipe read itself succeeded");
    assert_eq!(n, 0, "EOF on the grandchild-held pipe, not data");
}
