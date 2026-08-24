//! Gateway + fake MCP server end-to-end integration (issue #301 slice C-gw).
//!
//! Spawns the `mcp-fake-server` fixture (a stdio MCP server declared as a
//! `[[bin]]` in Cargo.toml) and drives it through the gateway's per-turn
//! lifecycle: [`McpAggregator::connect_all`] spawns + initializes + lists each
//! server, the merged table is namespaced (`mcp__<slug>__<tool>`), and
//! [`McpAggregator::route`] forwards a `tools/call` to the matching server with
//! the prefix stripped. The aggregator owns the spawned children; dropping it
//! kills them (per-turn lifecycle, issue #301 Q2) -- a leaked child would hold
//! the stdin pipe open and hang the test process at exit, so the tests passing
//! + the process exiting cleanly is the implicit kill-on-drop check.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use toptopduck_lib::mcp::aggregator::{McpAggregator, RouteError};
use toptopduck_lib::mcp::client::SecretEnv;
use toptopduck_lib::mcp::config::{McpServerConfig, McpServerId, McpTransport};
use toptopduck_lib::mcp::McpClient;
use toptopduck_lib::provider::keychain::KeychainStore;

/// Path to the compiled fake MCP server fixture (Cargo sets this at build time;
/// the `[[bin]]` declaration in Cargo.toml is what makes it available).
const FAKE_BIN: &str = env!("CARGO_BIN_EXE_mcp-fake-server");

/// Build a stdio `McpServerConfig` pointing at the fake server fixture. No
/// keychain env keys, so `connect_all` injects no secrets -- the keychain read
/// path is exercised by the slice B unit tests, not here.
fn fake_config(id: &str, display: &str) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    }
}

/// Collect the meta-tool names the aggregator mounts on the tool surface
/// (sorted for assertion stability regardless of definition order).
fn meta_names(agg: &McpAggregator) -> Vec<String> {
    let mut names: Vec<String> = agg
        .meta_tool_definitions()
        .iter()
        .map(|d| d.name.clone())
        .collect();
    names.sort();
    names
}

#[test]
fn connect_all_mounts_the_trio_and_discovers_by_handle() {
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    agg.connect_all(&[fake_config("srv-1", "FakeMCP")], &keychain);

    // The external surface is the fixed trio (ADR-0105) -- no per-tool
    // flattened advertisement. (meta_names sorts: invoke < list < search.)
    assert_eq!(
        meta_names(&agg),
        vec![
            "mcp_invoke".to_string(),
            "mcp_list_servers".to_string(),
            "mcp_search_tools".to_string(),
        ],
        "meta-tool trio mounted"
    );

    // An empty query returns the whole catalog; each card's `tool` field is
    // the handle. display "FakeMCP" slugifies to "fakemcp".
    let catalog = agg.search_catalog("");
    let handles: Vec<&str> = catalog["tools"]
        .as_array()
        .expect("cards")
        .iter()
        .map(|c| c["tool"].as_str().expect("handle"))
        .collect();
    assert_eq!(
        handles,
        vec![
            "mcp__fakemcp__echo",
            "mcp__fakemcp__add",
            "mcp__fakemcp__echo_env"
        ],
        "empty query returns the full catalog in advertised order"
    );
    assert_eq!(catalog["total_matched"], 3);
    let card = &catalog["tools"][1];
    assert_eq!(card["server"], "FakeMCP", "card names the display name");
    assert!(
        card["inputSchema"].is_object(),
        "card carries the full schema"
    );

    // The manifest names the connected server with its outcome.
    let listing = agg.server_listing();
    assert_eq!(listing["servers"][0]["server"], "FakeMCP");
    assert_eq!(listing["servers"][0]["connected"], true);
    assert_eq!(listing["servers"][0]["tool_count"], 3);

    // Invoke resolution: a catalog handle passes, a wrong slug fails naming
    // the handle (ADR-0105 Decision 4).
    assert!(agg
        .resolve_invoke(&json!({"tool": "mcp__fakemcp__add"}))
        .is_ok());
    let err = agg
        .resolve_invoke(&json!({"tool": "mcp__ghost__echo"}))
        .expect_err("unknown slug");
    assert!(
        err.contains("mcp__ghost__echo"),
        "error names the handle: {err}"
    );

    // Route a namespaced call: the gateway strips the prefix, the server sees
    // its native "add" name, and the result content comes back verbatim.
    let result = agg
        .route("mcp__fakemcp__add", &json!({"a": 2, "b": 3}))
        .expect("route ok");
    let text = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .expect("content text");
    assert_eq!(text, "5");

    // Echo verifies the string-arg path + that a second call reuses the same
    // spawned child (id monotonicity exercised inside the client).
    let echo = agg
        .route("mcp__fakemcp__echo", &json!({"message": "hi"}))
        .expect("echo route ok");
    let echo_text = echo
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .expect("echo content");
    assert_eq!(echo_text, "Echo: hi");
}

#[test]
fn connect_all_assigns_unique_slug_suffix_on_display_name_collision() {
    // Two servers sharing display name "FakeMCP": the first keeps the bare slug
    // "fakemcp", the second gets "fakemcp_2" so both stay routable
    // (unique_slug, ADR-0076 same-name distinctness).
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    agg.connect_all(
        &[
            fake_config("srv-1", "FakeMCP"),
            fake_config("srv-2", "FakeMCP"),
        ],
        &keychain,
    );
    // Collision de-duplication surfaces in the catalog's handles (ADR-0105:
    // the card's `tool` field is the composed handle).
    let catalog = agg.search_catalog("");
    let handles: Vec<&str> = catalog["tools"]
        .as_array()
        .expect("cards")
        .iter()
        .map(|c| c["tool"].as_str().expect("handle"))
        .collect();
    assert!(
        handles.contains(&"mcp__fakemcp__echo"),
        "first server keeps bare slug, got {handles:?}"
    );
    assert!(
        handles.contains(&"mcp__fakemcp_2__echo"),
        "second server gets _2 suffix, got {handles:?}"
    );

    // Both servers are independently routable under their own slug.
    agg.route("mcp__fakemcp__add", &json!({"a": 1, "b": 1}))
        .expect("first server routable");
    agg.route("mcp__fakemcp_2__add", &json!({"a": 2, "b": 2}))
        .expect("second server routable under suffixed slug");
}

/// ADR-0105 Decision 1's manifest intent: a turn where EVERY enabled server
/// failed to connect still mounts the trio (the mount condition is the
/// attempted set), `mcp_list_servers` surfaces the failure reasons, and the
/// search catalog stays honestly empty.
#[test]
fn all_failed_connects_still_mount_the_trio() {
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let bad = McpServerConfig {
        id: McpServerId("bad".into()),
        display_name: "Bad".into(),
        transport: McpTransport::stdio("/no/such/toptopduck-binary", Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    agg.connect_all(&[bad], &keychain);
    assert_eq!(
        meta_names(&agg),
        vec![
            "mcp_invoke".to_string(),
            "mcp_list_servers".to_string(),
            "mcp_search_tools".to_string(),
        ],
        "all-failed turn still mounts the trio for diagnostics"
    );
    let listing = agg.server_listing();
    assert_eq!(listing["servers"][0]["server"], "Bad");
    assert_eq!(listing["servers"][0]["connected"], false);
    assert!(listing["servers"][0]["error"].is_string());
    assert_eq!(agg.search_catalog("")["total_matched"], 0, "catalog empty");
}

#[test]
fn connect_all_skips_a_server_that_fails_to_spawn_without_bricking_others() {
    // A misconfigured server (command does not exist) is logged + skipped; the
    // turn still aggregates the good server's tools. This is the
    // "a misconfigured server must not brick the gateway" contract.
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let good = fake_config("good", "Good");
    let bad = McpServerConfig {
        id: McpServerId("bad".into()),
        display_name: "Bad".into(),
        transport: McpTransport::stdio("/no/such/toptopduck-binary", Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    agg.connect_all(&[bad, good], &keychain);
    // The catalog holds only the connected server (ADR-0105 Decision 3: a
    // failed connect leaves no placeholder); the manifest still names the
    // failed attempt with its reason (Decision 1).
    let catalog = agg.search_catalog("");
    let handles: Vec<&str> = catalog["tools"]
        .as_array()
        .expect("cards")
        .iter()
        .map(|c| c["tool"].as_str().expect("handle"))
        .collect();
    assert!(
        handles.contains(&"mcp__good__echo"),
        "good server aggregated despite bad sibling, got {handles:?}"
    );
    assert!(
        !handles.iter().any(|h| h.starts_with("mcp__bad")),
        "bad server contributed nothing, got {handles:?}"
    );
    let listing = agg.server_listing();
    let entries = listing["servers"].as_array().expect("manifest");
    assert_eq!(entries.len(), 2, "manifest names both attempts");
    let bad_entry = entries
        .iter()
        .find(|e| e["server"] == "Bad")
        .expect("bad attempt listed");
    assert_eq!(bad_entry["connected"], false);
    assert!(bad_entry["error"].is_string(), "skip reason carried");
    // The mount condition is the ATTEMPTED set (ADR-0105 Decision 1): a
    // turn with at least one enabled server mounts the trio regardless of
    // connect outcomes. (The all-failed shape is pinned in
    // all_failed_connects_still_mount_the_trio below.)
    assert_eq!(
        meta_names(&agg),
        vec![
            "mcp_invoke".to_string(),
            "mcp_list_servers".to_string(),
            "mcp_search_tools".to_string(),
        ],
        "trio mounted while at least one server connected"
    );
}

#[test]
fn route_to_unknown_slug_surfaces_unknown_server_error() {
    // A namespaced shape but a slug no connected server owns -> UnknownServer.
    // The gateway surfaces this as a tool-level error the agent self-corrects
    // from (ADR-0077) rather than silently dropping the call.
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    agg.connect_all(&[fake_config("srv-1", "FakeMCP")], &keychain);
    let err = agg
        .route("mcp__ghost__echo", &json!({}))
        .expect_err("unknown slug");
    assert!(
        matches!(err, RouteError::UnknownServer(ref s) if s == "ghost"),
        "unknown slug -> UnknownServer(\"ghost\"), got {err:?}"
    );
}

#[test]
fn connect_one_injects_secrets_into_the_child_env() {
    // The gateway resolves `keychain_env_keys` at spawn (ADR-0029) and injects
    // each value into the child env via `StdioClient::connect`. `connect_one`
    // takes the already-resolved `SecretEnv` pairs (the keychain READ is
    // exercised by the slice B unit tests); this test verifies the INJECTION --
    // a declared secret reaches the spawned child, an undeclared key stays
    // unset. Uses `connect_one` (not `connect_all`) to bypass the keychain (a
    // real OS store, not an in-memory mock) and inject the pair directly. The
    // key name is distinctive to avoid collision with a real env var on the
    // host running the tests.
    let secret_value = "test-secret-xyz";
    let secrets: Vec<SecretEnv> = vec![("TOPTOPDUCK_TEST_MCP_SECRET".into(), secret_value.into())];
    let config = McpServerConfig {
        id: McpServerId("secret-srv".into()),
        display_name: "SecretMCP".into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: vec!["TOPTOPDUCK_TEST_MCP_SECRET".into()],
        timeout_ms: None,
        enabled: true,
    };
    let mut agg = McpAggregator::empty();
    agg.connect_one(&config, &secrets);

    // The declared secret reaches the child env (the fake server's echo_env
    // tool reflects std::env::var).
    let result = agg
        .route(
            "mcp__secretmcp__echo_env",
            &json!({"key": "TOPTOPDUCK_TEST_MCP_SECRET"}),
        )
        .expect("route ok");
    let text = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .expect("content text");
    assert_eq!(text, secret_value);

    // An absent var reports `<unset>` -- this confirms echo_env distinguishes
    // "set" from "unset" (so the positive assertion above is meaningful, not a
    // tool that always echoes a value). The distinctive name guarantees the var
    // is absent from the child env (which inherits the test process's env).
    let unset = agg
        .route(
            "mcp__secretmcp__echo_env",
            &json!({"key": "TOPTOPDUCK_TEST_MCP_NOT_INJECTED"}),
        )
        .expect("route ok");
    let unset_text = unset
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .expect("content text");
    assert_eq!(
        unset_text, "<unset>",
        "an absent env var reports <unset>, not a stale or fabricated value"
    );
}

#[test]
fn connect_all_returns_per_server_connect_results_with_failure_reasons() {
    // The per-server ConnectResult (issue #301 slice D) pins the shape for
    // the three reachable return paths in connect_one -- success, stdio spawn
    // failure, and HTTP transport failure (issue #389: SSE/HTTP now attempt
    // to connect instead of being rejected upfront as "unsupported
    // transport").
    // (The fourth path, tools/list failure, needs a fixture that corrupts
    // tools/list; its construction site is byte-identical to the other two
    // skip paths and is shape-covered by them.)
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let bad_spawn = McpServerConfig {
        id: McpServerId("bad-spawn".into()),
        display_name: "BadSpawn".into(),
        transport: McpTransport::stdio("/no/such/toptopduck-binary", Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let http_fail = McpServerConfig {
        id: McpServerId("http-fail".into()),
        display_name: "HttpFail".into(),
        transport: McpTransport::Http {
            url: "http://127.0.0.1:1".into(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let good = fake_config("good", "Good");

    // connect_all preserves the configured order in its returned Vec.
    let results = agg.connect_all(&[bad_spawn, http_fail, good], &keychain);
    assert_eq!(results.len(), 3, "one ConnectResult per configured server");

    // Spawn failure -> connected:false, no tools, a carried reason.
    let bad = &results[0];
    assert_eq!(bad.id, McpServerId("bad-spawn".into()));
    assert!(!bad.connected, "bad-spawn did not connect");
    assert_eq!(bad.tool_count, 0);
    assert!(bad.error.is_some(), "spawn failure carries a reason");

    // HTTP connect failure (port 1 unreachable) -> connected:false with an
    // HTTP transport error (no longer "unsupported transport", issue #389).
    let fail = &results[1];
    assert_eq!(fail.id, McpServerId("http-fail".into()));
    assert!(!fail.connected);
    assert_eq!(fail.tool_count, 0);
    let fail_reason = fail.error.as_deref().unwrap_or("");
    assert!(
        fail_reason.contains("HTTP transport error") || fail_reason.contains("Connection refused"),
        "HTTP connect failure carries a transport-level reason, got: {fail_reason}"
    );

    // Success -> connected:true with the live tool count + no error.
    let ok = &results[2];
    assert_eq!(ok.id, McpServerId("good".into()));
    assert!(ok.connected, "good server connected");
    assert_eq!(
        ok.tool_count, 3,
        "fake server advertises add + echo + echo_env"
    );
    assert!(ok.error.is_none(), "good server has no error");
}

// ---------------------------------------------------------------------------
// SSE + HTTP transport integration tests (issue #389)
// ---------------------------------------------------------------------------

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Per-server shared state: carries the SSE response queue (for legacy SSE
/// mode) and the shutdown flag. Each connection handler gets a clone of the
/// `Arc` so the GET stream thread and POST handler thread can coordinate.
struct ServerState {
    sse_queue: Mutex<VecDeque<String>>,
    shutdown: AtomicBool,
}

/// Which transport protocol the test server speaks.
#[derive(Clone, Copy)]
enum ServerMode {
    /// Streamable HTTP: each POST gets a JSON response.
    Http,
    /// Streamable HTTP with SSE response: each POST gets a
    /// `text/event-stream` response carrying the JSON-RPC envelope (exercises
    /// `HttpClient`'s SSE branch, issue #389).
    HttpSse,
    /// Legacy SSE: GET opens SSE stream; POST sends messages.
    Sse,
    /// Legacy SSE that sends `event: message` (not `event: endpoint`) as the
    /// first event — exercises `SseClient`'s first-event rejection guard (H1,
    /// issue #389).
    SseBadFirstEvent,
}

/// A minimal in-process HTTP MCP server for integration testing (issue #389).
/// Runs on a background thread; the port is chosen by the OS (bind 0). The
/// tool table mirrors the stdio fake server (`echo`, `add`) so assertions are
/// cross-comparable.
struct HttpMcpServer {
    port: u16,
    state: Arc<ServerState>,
    handle: Option<thread::JoinHandle<()>>,
}

impl HttpMcpServer {
    fn spawn(mode: ServerMode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let state = Arc::new(ServerState {
            sse_queue: Mutex::new(VecDeque::new()),
            shutdown: AtomicBool::new(false),
        });
        let state_clone = state.clone();
        listener.set_nonblocking(true).expect("set_nonblocking");
        let handle = thread::spawn(move || {
            run_server(listener, mode, state_clone);
        });
        Self {
            port,
            state,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for HttpMcpServer {
    fn drop(&mut self) {
        self.state.shutdown.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// Accept loop with non-blocking IO so the shutdown flag is checked between
/// connections. Each accepted connection runs on its own thread with a clone
/// of the shared state.
fn run_server(listener: TcpListener, mode: ServerMode, state: Arc<ServerState>) {
    let base_url = format!("http://{}", listener.local_addr().expect("local_addr"));
    while !state.shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let st = state.clone();
                let url = base_url.clone();
                thread::spawn(move || handle_connection(stream, mode, st, &url));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
}

/// Handle one HTTP connection. Parses the request line + headers, reads the
/// body, and dispatches by method + transport mode.
fn handle_connection(
    mut stream: TcpStream,
    mode: ServerMode,
    state: Arc<ServerState>,
    base_url: &str,
) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let request_line = match read_line(&mut reader) {
        Some(l) => l,
        None => return,
    };
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];
    let _path = parts[1];

    // Read headers to get content-length.
    let mut content_length = 0usize;
    loop {
        let line = match read_line(&mut reader) {
            Some(l) => l,
            None => return,
        };
        if line.is_empty() {
            break;
        }
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        }
    }

    // Read body.
    let mut body = vec![0u8; content_length];
    if content_length > 0 && reader.read_exact(&mut body).is_err() {
        return;
    }

    match (mode, method) {
        (ServerMode::Http, "POST") => handle_jsonrpc_post(&mut stream, &body, "http-fake"),
        (ServerMode::HttpSse, "POST") => {
            handle_jsonrpc_sse_post(&mut stream, &body, "http-sse-fake")
        }
        (ServerMode::Sse, "GET") => handle_sse_stream(&mut stream, &state, base_url),
        (ServerMode::Sse, "POST") => handle_sse_post(&mut stream, &body, &state),
        (ServerMode::SseBadFirstEvent, "GET") => {
            handle_sse_stream_bad_first_event(&mut stream, base_url);
        }
        _ => {
            write_response(&mut stream, 404, "text/plain", "not found");
        }
    }
}

// --- Streamable HTTP handler ----------------------------------------------

/// POST handler for HTTP transport: parse JSON-RPC, return a JSON response.
fn handle_jsonrpc_post(stream: &mut TcpStream, body: &[u8], server_name: &str) {
    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            write_response(stream, 400, "text/plain", "bad json");
            return;
        }
    };
    let resp = build_rpc_response(&req, server_name);
    if let Value::Null = resp {
        // Notification (no id) → 202 with empty body.
        write_response(stream, 202, "application/json", "");
    } else {
        write_response(stream, 200, "application/json", &resp.to_string());
    }
}

/// POST handler for streamable HTTP with SSE response: parse JSON-RPC, wrap the
/// response in a single SSE `message` event (exercises `HttpClient`'s
/// `text/event-stream` branch, issue #389 I3).
fn handle_jsonrpc_sse_post(stream: &mut TcpStream, body: &[u8], server_name: &str) {
    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            write_response(stream, 400, "text/plain", "bad json");
            return;
        }
    };
    let resp = build_rpc_response(&req, server_name);
    if let Value::Null = resp {
        // Notification (no id) → 202 with empty body.
        write_response(stream, 202, "application/json", "");
    } else {
        // Wrap the JSON-RPC response in a single SSE event.
        let sse_body = format!("event: message\r\ndata: {}\r\n\r\n", resp);
        write_response(stream, 200, "text/event-stream", &sse_body);
    }
}

// --- Legacy SSE handlers ---------------------------------------------------

/// GET handler for SSE transport that sends `event: message` as the first
/// event instead of `event: endpoint` — exercises `SseClient`'s first-event
/// rejection guard (H1, issue #389 I4).
fn handle_sse_stream_bad_first_event(stream: &mut TcpStream, base_url: &str) {
    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Connection: keep-alive\r\n\
                  \r\n";
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.flush();

    // Send a `message` event first (wrong — should be `endpoint`).
    let payload = json!({"jsonrpc": "2.0", "id": 1, "result": {}}).to_string();
    let bad = format!("event: message\r\ndata: {}\r\n\r\n", payload);
    let _ = stream.write_all(bad.as_bytes());
    let _ = stream.flush();

    // Keep the connection open briefly so the client reads the first event.
    let _ = base_url;
    thread::sleep(Duration::from_secs(5));
}

/// GET handler for SSE transport: write SSE headers + endpoint event, then
/// poll the shared queue for responses to relay as SSE events.
fn handle_sse_stream(stream: &mut TcpStream, state: &ServerState, base_url: &str) {
    let header = "HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Connection: keep-alive\r\n\
                  \r\n";
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.flush();

    // Send the endpoint event with the full POST URL.
    let post_url = format!("{}/message", base_url);
    let endpoint = format!("event: endpoint\r\ndata: {}\r\n\r\n", post_url);
    let _ = stream.write_all(endpoint.as_bytes());
    let _ = stream.flush();

    // Poll the queue for responses until shutdown or the client disconnects.
    while !state.shutdown.load(Ordering::SeqCst) {
        while let Some(resp) = state.sse_queue.lock().unwrap().pop_front() {
            let sse = format!("event: message\r\ndata: {}\r\n\r\n", resp);
            if stream.write_all(sse.as_bytes()).is_err() {
                return;
            }
            let _ = stream.flush();
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// POST handler for SSE transport: process JSON-RPC, push response to the
/// shared queue (the GET thread writes it as an SSE event), return 202.
fn handle_sse_post(stream: &mut TcpStream, body: &[u8], state: &ServerState) {
    let req: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            write_response(stream, 400, "text/plain", "bad json");
            return;
        }
    };
    let resp = build_rpc_response(&req, "sse-fake");
    if resp != Value::Null {
        state.sse_queue.lock().unwrap().push_back(resp.to_string());
    }
    write_response(stream, 202, "application/json", "");
}

// --- Shared JSON-RPC response builder --------------------------------------

/// Build a JSON-RPC response for a request. Returns `Value::Null` for
/// notifications (no id). Mirrors the stdio fake server's tool table.
fn build_rpc_response(req: &Value, server_name: &str) -> Value {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");

    if id.is_none() {
        return Value::Null; // Notification — no response body.
    }

    match method {
        "initialize" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "serverInfo": {"name": server_name, "version": "0.0.0"}
            }
        }),
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "tools": [
                    {"name": "echo", "description": "echo the message field",
                     "inputSchema": {"type": "object"}},
                    {"name": "add", "description": "sum a and b",
                     "inputSchema": {"type": "object"}},
                ]
            }
        }),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            let text = match name {
                "add" => {
                    let a = args.get("a").and_then(Value::as_i64).unwrap_or(0);
                    let b = args.get("b").and_then(Value::as_i64).unwrap_or(0);
                    format!("{}", a + b)
                }
                _ => {
                    let msg = args.get("message").and_then(Value::as_str).unwrap_or("");
                    format!("Echo: {msg}")
                }
            };
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{"type": "text", "text": text}],
                    "isError": false
                }
            })
        }
        _ => json!({
            "jsonrpc": "2.0", "id": id,
            "error": {"code": -32601, "message": "method not found"}
        }),
    }
}

// --- HTTP helpers ----------------------------------------------------------

/// Read one CRLF-terminated line, returning the trimmed string. None at EOF.
fn read_line(reader: &mut impl BufRead) -> Option<String> {
    let mut line = String::new();
    let n = reader.read_line(&mut line).ok()?;
    if n == 0 {
        return None;
    }
    Some(line.trim_end_matches(['\r', '\n']).to_string())
}

/// Write a minimal HTTP response with a body.
fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let status_text = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

// --- HTTP transport integration tests --------------------------------------

#[test]
fn http_transport_connect_tools_list_and_call() {
    let server = HttpMcpServer::spawn(ServerMode::Http);
    let url = format!("{}/mcp", server.url());

    let mut client = toptopduck_lib::mcp::client::HttpClient::connect(&url).expect("http connect");

    let tools = client.list_tools().expect("tools/list");
    assert_eq!(tools.len(), 2, "http server advertises echo + add");
    assert_eq!(tools[0]["name"], "echo");
    assert_eq!(tools[1]["name"], "add");

    let result = client
        .call("add", &json!({"a": 7, "b": 8}))
        .expect("tools/call");
    let text = first_text(&result);
    assert_eq!(text, "15");

    let echo = client
        .call("echo", &json!({"message": "hello-http"}))
        .expect("echo call");
    assert_eq!(first_text(&echo), "Echo: hello-http");
}

#[test]
fn http_transport_aggregator_connect_and_route() {
    let server = HttpMcpServer::spawn(ServerMode::Http);
    let url = format!("{}/mcp", server.url());

    let config = McpServerConfig {
        id: McpServerId("http-srv".into()),
        display_name: "HttpMCP".into(),
        transport: McpTransport::Http { url },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[config], &keychain);
    assert_eq!(results.len(), 1);
    assert!(results[0].connected, "http server connected via aggregator");

    // The catalog carries the server's tools as handle cards (ADR-0105).
    let catalog = agg.search_catalog("");
    let handles: Vec<&str> = catalog["tools"]
        .as_array()
        .expect("cards")
        .iter()
        .map(|c| c["tool"].as_str().expect("handle"))
        .collect();
    assert!(
        handles.contains(&"mcp__httpmcp__add"),
        "handle cards, got {handles:?}"
    );

    let result = agg
        .route("mcp__httpmcp__add", &json!({"a": 10, "b": 20}))
        .expect("route ok");
    assert_eq!(first_text(&result), "30");
}

// --- Streamable HTTP SSE response tests (issue #389 I3) ---------------------

/// `HttpClient` handles `text/event-stream` responses (streamable HTTP), not
/// just plain JSON. The fixture wraps each JSON-RPC response in a single SSE
/// `message` event (issue #389 I3).
#[test]
fn http_transport_handles_sse_response_branch() {
    let server = HttpMcpServer::spawn(ServerMode::HttpSse);
    let url = format!("{}/mcp", server.url());

    let mut client =
        toptopduck_lib::mcp::client::HttpClient::connect(&url).expect("http-sse connect");

    let tools = client.list_tools().expect("tools/list via SSE response");
    assert_eq!(tools.len(), 2, "http-sse server advertises echo + add");

    let result = client
        .call("add", &json!({"a": 20, "b": 22}))
        .expect("tools/call via SSE response");
    assert_eq!(first_text(&result), "42");
}

// --- SSE first-event rejection tests (issue #389 I4) ------------------------

/// `SseClient::connect` rejects a server whose first SSE event is not
/// `event: endpoint` (H1 security guard). The fixture sends
/// `event: message` first (issue #389 I4).
#[test]
fn sse_transport_rejects_non_endpoint_first_event() {
    let server = HttpMcpServer::spawn(ServerMode::SseBadFirstEvent);
    let url = format!("{}/sse", server.url());

    let result = toptopduck_lib::mcp::client::SseClient::connect(&url);
    let err = match result {
        Ok(_) => panic!("non-endpoint first event should be rejected"),
        Err(e) => e,
    };
    let msg = err.to_string();
    assert!(
        msg.contains("expected") && msg.contains("endpoint"),
        "rejection reason mentions endpoint expectation, got: {msg}"
    );
}

// --- SSE transport integration tests ---------------------------------------

#[test]
fn sse_transport_connect_tools_list_and_call() {
    let server = HttpMcpServer::spawn(ServerMode::Sse);
    let url = format!("{}/sse", server.url());

    let mut client = toptopduck_lib::mcp::client::SseClient::connect(&url).expect("sse connect");

    let tools = client.list_tools().expect("tools/list");
    assert_eq!(tools.len(), 2, "sse server advertises echo + add");
    assert_eq!(tools[0]["name"], "echo");
    assert_eq!(tools[1]["name"], "add");

    let result = client
        .call("add", &json!({"a": 3, "b": 4}))
        .expect("tools/call");
    assert_eq!(first_text(&result), "7");

    let echo = client
        .call("echo", &json!({"message": "hello-sse"}))
        .expect("echo call");
    assert_eq!(first_text(&echo), "Echo: hello-sse");

    // Dropping the client stops the reader thread (stop flag + join).
    drop(client);
}

#[test]
fn sse_transport_aggregator_connect_and_route() {
    let server = HttpMcpServer::spawn(ServerMode::Sse);
    let url = format!("{}/sse", server.url());

    let config = McpServerConfig {
        id: McpServerId("sse-srv".into()),
        display_name: "SseMCP".into(),
        transport: McpTransport::Sse { url },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[config], &keychain);
    assert_eq!(results.len(), 1);
    assert!(results[0].connected, "sse server connected via aggregator");

    // The catalog carries the server's tools as handle cards (ADR-0105).
    let catalog = agg.search_catalog("");
    let handles: Vec<&str> = catalog["tools"]
        .as_array()
        .expect("cards")
        .iter()
        .map(|c| c["tool"].as_str().expect("handle"))
        .collect();
    assert!(
        handles.contains(&"mcp__ssemcp__add"),
        "handle cards, got {handles:?}"
    );

    let result = agg
        .route("mcp__ssemcp__add", &json!({"a": 5, "b": 6}))
        .expect("route ok");
    assert_eq!(first_text(&result), "11");

    // Dropping the aggregator drops the SseClient (stop flag + thread join).
    drop(agg);
}

/// Extract the first text block from an MCP tools/call envelope (test helper).
fn first_text(envelope: &Value) -> String {
    envelope
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string()
}

#[test]
fn with_tool_output_injects_env_var_into_child() {
    // Issue #432 AC#3: a McpAggregator built with `with_tool_output` injects
    // `TOPTOPDUCK_TOOL_OUTPUT_DIR` into each stdio server's child env at spawn.
    // The fake server's `echo_env` tool reflects the child process's env, so
    // routing a call to it verifies the full chain: aggregator field ->
    // connect_transport -> StdioClient::connect -> stdio_command env injection
    // -> spawned child sees the var.
    use toptopduck_lib::mcp::client::TOOL_OUTPUT_ENV;
    let dir = "/tmp/toptopduck-test-tool-output-432";
    let mut agg = McpAggregator::with_tool_output(dir.to_string());
    agg.connect_all(&[fake_config("srv-1", "EnvMCP")], &KeychainStore::new());

    let result = agg
        .route("mcp__envmcp__echo_env", &json!({"key": TOOL_OUTPUT_ENV}))
        .expect("route ok");
    assert_eq!(
        first_text(&result),
        dir,
        "TOPTOPDUCK_TOOL_OUTPUT_DIR injected into child env"
    );
}

#[test]
fn empty_aggregator_does_not_inject_tool_output_env() {
    // The complement: an aggregator built via `empty()` (no tool_output_dir)
    // does NOT inject the env var. This confirms the `Option` semantics --
    // tests and probes that don't set a tool_output dir get a clean child env.
    use toptopduck_lib::mcp::client::TOOL_OUTPUT_ENV;
    let mut agg = McpAggregator::empty();
    agg.connect_all(&[fake_config("srv-1", "NoEnvMCP")], &KeychainStore::new());

    let result = agg
        .route("mcp__noenvmcp__echo_env", &json!({"key": TOOL_OUTPUT_ENV}))
        .expect("route ok");
    assert_eq!(
        first_text(&result),
        "<unset>",
        "empty() aggregator does not inject TOPTOPDUCK_TOOL_OUTPUT_DIR"
    );
}

#[test]
fn tool_output_env_overrides_user_configured_value() {
    // ADR-0087: the gateway is the path authority for TOPTOPDUCK_TOOL_OUTPUT_DIR.
    // If a user also sets it in config.env, the session's value must win
    // (last-write-wins in Command::env). This test locks the override direction
    // so a future reordering of .envs() calls cannot silently flip it.
    use std::collections::BTreeMap;
    use toptopduck_lib::mcp::client::TOOL_OUTPUT_ENV;

    let mut env = BTreeMap::new();
    env.insert(
        TOOL_OUTPUT_ENV.to_string(),
        "/user/should/not/win".to_string(),
    );
    let mut config = fake_config("srv-1", "OverrideMCP");
    config.env = env;

    let gateway_dir = "/tmp/toptopduck-test-tool-output-override";
    let mut agg = McpAggregator::with_tool_output(gateway_dir.to_string());
    agg.connect_all(&[config], &KeychainStore::new());

    let result = agg
        .route(
            "mcp__overridemcp__echo_env",
            &json!({"key": TOOL_OUTPUT_ENV}),
        )
        .expect("route ok");
    assert_eq!(
        first_text(&result),
        gateway_dir,
        "gateway tool_output_dir must override user-configured value"
    );
}
