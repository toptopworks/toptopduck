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

/// Path to the compiled paginated MCP server fixture (issue #900): a
/// two-page `tools/list` answer joined by `nextCursor`.
const PAGINATED_BIN: &str = env!("CARGO_BIN_EXE_mcp-paginated-server");

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
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    }
}

/// A two-page `tools/list` fixture config (issue #900): page 1 returns
/// `echo` + `add` with a `nextCursor`, page 2 returns `fetch_page2` -- the
/// tool only a cursor-following client can ever see.
fn paginated_config(id: &str, display: &str) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio(PAGINATED_BIN, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    }
}

/// A fake-server config that never stops paging (`FAKE_CURSOR_LOOP=1` in the
/// child env): every `tools/list` page returns a tool plus a fresh cursor --
/// the page-cap shape (issue #900).
fn cursor_loop_config(id: &str, display: &str) -> McpServerConfig {
    let mut env = BTreeMap::new();
    env.insert("FAKE_CURSOR_LOOP".to_string(), "1".to_string());
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env,
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
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

/// The meta-tool trio as `meta_names` sorts it (invoke < list < search) --
/// the expected mount surface wherever a test asserts the trio (issue #661:
/// the sorted list was inlined at every site).
const META_TRIO: [&str; 3] = ["mcp_invoke", "mcp_list_servers", "mcp_search_tools"];

/// A stdio config whose command does not exist: the connect fails instantly
/// and deterministically (the broken sibling in the mixed-outcome tests).
fn broken_config(id: &str, display: &str) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio("/no/such/toptopduck-binary", Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    }
}

/// The handle cards of a FETCHED catalog, in advertised order (the shared
/// extraction the mount / collision / skip / transport tests assert on).
/// Taking the catalog (not the aggregator) lets a caller that already holds
/// it reuse it instead of re-running the search.
fn catalog_handles(catalog: &Value) -> Vec<String> {
    catalog["tools"]
        .as_array()
        .expect("cards")
        .iter()
        .map(|c| c["tool"].as_str().expect("handle").to_string())
        .collect()
}

#[test]
fn connect_all_mounts_the_trio_and_discovers_by_handle() {
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[fake_config("srv-1", "FakeMCP")], &keychain);

    // The external surface is the fixed trio (ADR-0105) -- no per-tool
    // flattened advertisement. (meta_names sorts: invoke < list < search.)
    assert_eq!(
        meta_names(&agg),
        META_TRIO.to_vec(),
        "meta-tool trio mounted"
    );

    // An empty query returns the whole catalog; each card's `tool` field is
    // the handle. display "FakeMCP" slugifies to "fakemcp".
    let catalog = agg.search_catalog("");
    let handles = catalog_handles(&catalog);
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
    // The card carries the server's OWN schema verbatim (issue #661: the
    // fake's `add` schema is non-trivial). Full-schema equality (issue #663
    // review: the previous two-field probe let a re-wrap that adds a field
    // while preserving the probe pair pass).
    assert_eq!(
        card["inputSchema"],
        json!({"type": "object",
               "properties": {"a": {"type": "integer"},
                              "b": {"type": "integer"}},
               "required": ["a", "b"]}),
        "card carries the server's schema verbatim, field for field"
    );

    // The manifest names the connected server with its outcome, mirroring
    // the returned ConnectResult from the one typed outcome (issue #661).
    let listing = agg.server_listing();
    assert_eq!(listing["servers"][0]["server"], "FakeMCP");
    assert_eq!(listing["servers"][0]["connected"], true);
    assert_eq!(listing["servers"][0]["tool_count"], results[0].tool_count);
    assert_eq!(results[0].tool_count, 3);

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

/// Issue #900: a multi-page server's SECOND page reaches the aggregated
/// catalog -- pre-#900 the client read one page and silently dropped the
/// rest, so `fetch_page2` was unfindable and invokable-nowhere. The full
/// mount surface: Connected result, catalog handles (page-2 tool included,
/// advertised order), invoke resolution, and the manifest.
#[test]
fn connect_all_folds_a_multi_page_server_into_the_catalog() {
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[paginated_config("srv-pages", "PageMCP")], &keychain);

    assert_eq!(results.len(), 1);
    assert!(results[0].connected, "two pages are a healthy server");
    assert_eq!(results[0].tool_count, 3, "both pages' tools count");

    let catalog = agg.search_catalog("");
    let handles = catalog_handles(&catalog);
    assert_eq!(
        handles,
        vec![
            "mcp__pagemcp__echo",
            "mcp__pagemcp__add",
            "mcp__pagemcp__fetch_page2"
        ],
        "the page-2-only tool is in the catalog, in advertised order"
    );

    // The page-2 tool resolves for invoke too -- it is a first-class catalog
    // citizen, not a search-only ghost.
    assert!(agg
        .resolve_invoke(&json!({"tool": "mcp__pagemcp__fetch_page2"}))
        .is_ok());

    let listing = agg.server_listing();
    assert_eq!(listing["servers"][0]["server"], "PageMCP");
    assert_eq!(listing["servers"][0]["connected"], true);
    assert_eq!(listing["servers"][0]["tool_count"], 3);
}

/// Issue #900: a server that never stops paging trips the page cap; the
/// connect path records it as the server's failure (an explicit
/// `ConnectOutcome::Failed` with the guardrail reason -- no
/// silently-partial catalog) and the manifest carries the outcome.
#[test]
fn connect_all_page_cap_marks_the_server_failed_with_reason() {
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[cursor_loop_config("srv-loop", "LoopMCP")], &keychain);

    assert_eq!(results.len(), 1);
    assert!(
        !results[0].connected,
        "the cap is a failure, not a truncation"
    );
    let error = results[0].error.as_deref().expect("the failure reason");
    assert!(
        error.contains("LoopMCP"),
        "the reason names the server: {error}"
    );
    assert!(
        error.contains("page cap"),
        "the reason names the tripped dimension: {error}"
    );

    // The manifest (mcp_list_servers) carries the same failure, and the
    // catalog stays empty -- nothing from the looping server was mounted.
    let listing = agg.server_listing();
    assert_eq!(listing["servers"][0]["server"], "LoopMCP");
    assert_eq!(listing["servers"][0]["connected"], false);
    let catalog = agg.search_catalog("");
    let catalog_tools = catalog["tools"].as_array().expect("catalog tools array");
    assert!(
        catalog_tools.is_empty(),
        "no silently-partial catalog: {catalog_tools:?}"
    );
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
    let handles = catalog_handles(&agg.search_catalog(""));
    assert!(
        handles.iter().any(|h| h == "mcp__fakemcp__echo"),
        "first server keeps bare slug, got {handles:?}"
    );
    assert!(
        handles.iter().any(|h| h == "mcp__fakemcp_2__echo"),
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
    agg.connect_all(&[broken_config("bad", "Bad")], &keychain);
    assert_eq!(
        meta_names(&agg),
        META_TRIO.to_vec(),
        "all-failed turn still mounts the trio for diagnostics"
    );
    let listing = agg.server_listing();
    assert_eq!(listing["servers"][0]["server"], "Bad");
    assert_eq!(listing["servers"][0]["connected"], false);
    assert!(listing["servers"][0]["error"].is_string());
    // An all-failed turn's catalog is EMPTY (not merely matchless): the
    // search result self-explains via the note (issue #661).
    let search = agg.search_catalog("");
    assert_eq!(search["total_matched"], 0, "catalog empty");
    assert!(
        search["note"]
            .as_str()
            .unwrap()
            .contains("mcp_list_servers"),
        "the empty-catalog note points at the manifest"
    );
}

#[test]
fn connect_all_skips_a_server_that_fails_to_spawn_without_bricking_others() {
    // A misconfigured server (command does not exist) is logged + skipped; the
    // turn still aggregates the good server's tools. This is the
    // "a misconfigured server must not brick the gateway" contract.
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let good = fake_config("good", "Good");
    agg.connect_all(&[broken_config("bad", "Bad"), good], &keychain);
    // The catalog holds only the connected server (ADR-0105 Decision 3: a
    // failed connect leaves no placeholder); the manifest still names the
    // failed attempt with its reason (Decision 1).
    let handles = catalog_handles(&agg.search_catalog(""));
    assert!(
        handles.iter().any(|h| h == "mcp__good__echo"),
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
        META_TRIO.to_vec(),
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
    // each value into the child env via `StdioClient::connect_with_kill`.
    // `connect_one` takes the already-resolved `SecretEnv` pairs (the
    // keychain READ is exercised by the slice B unit tests); this test
    // verifies the INJECTION -- a declared secret reaches the spawned child,
    // an undeclared key stays unset. Uses `connect_one` (not `connect_all`)
    // to bypass the keychain (a real OS store, not an in-memory mock) and
    // inject the pair directly. The key name is distinctive to avoid
    // collision with a real env var on the host running the tests.
    let secret_value = "test-secret-xyz";
    let secrets: Vec<SecretEnv> = vec![("TOPTOPDUCK_TEST_MCP_SECRET".into(), secret_value.into())];
    let config = McpServerConfig {
        id: McpServerId("secret-srv".into()),
        display_name: "SecretMCP".into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: vec!["TOPTOPDUCK_TEST_MCP_SECRET".into()],
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let mut agg = McpAggregator::empty();
    agg.connect_one(&config, &secrets, &[]);

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
    let bad_spawn = broken_config("bad-spawn", "BadSpawn");
    let http_fail = McpServerConfig {
        id: McpServerId("http-fail".into()),
        display_name: "HttpFail".into(),
        transport: McpTransport::Http {
            url: "http://127.0.0.1:1".into(),
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
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
    /// Every request's captured headers (name lowercased, value verbatim),
    /// appended per connection in arrival order (issue #901): the
    /// header-injection pins read this back to assert what the transports
    /// actually put on the wire.
    captured_headers: Mutex<Vec<(String, String)>>,
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
    /// Streamable HTTP whose SSE `message` event carries non-JSON data —
    /// exercises `HttpClient`'s malformed-SSE-data framing error (the
    /// streamable-HTTP half of the shared `malformed_sse_event` attribution).
    HttpSseMalformed,
    /// Legacy SSE: GET opens SSE stream; POST sends messages.
    Sse,
    /// Legacy SSE that accepts the POST but never forwards the response
    /// onto the GET stream (issue #889): the client's `recv` parks on a
    /// live-but-silent connection -- the deadline fixture for the SSE half.
    SseSilent,
    /// Legacy SSE whose silence starts at the handshake (issue #897): the
    /// endpoint event rides the GET stream, every POST is acknowledged,
    /// but no response event is EVER forwarded -- the initialize `recv`
    /// parks mid-connect, the connect-phase half that `SseSilent` (which
    /// silences only `tools/call`) never modeled.
    SseHandshakeSilent,
    /// Legacy SSE that sends `event: message` (not `event: endpoint`) as the
    /// first event — exercises `SseClient`'s first-event rejection guard (H1,
    /// issue #389).
    SseBadFirstEvent,
    /// Streamable HTTP answering every POST with `301` + a Location header —
    /// exercises the no-redirect guardrail: the error must name the refused
    /// redirect, not follow it (issue #901).
    HttpRedirect,
    /// Legacy SSE answering the GET stream with `301` + a Location header —
    /// the SSE half of the no-redirect guardrail (issue #901).
    SseRedirectGet,
    /// Legacy SSE answering ONE JSON-RPC method's POST with `301` + a
    /// Location header (issue #904): the GET stream and every other POST
    /// behave stock, so the handshake advances exactly far enough to reach
    /// the parameterized method — pinning `check_no_redirect` on both POST
    /// paths in isolation (`initialize` rides `SseClient::request`, the
    /// `notifications/initialized` ack rides `post_notification`).
    SseRedirectPost(&'static str),
    /// Legacy SSE whose endpoint event advertises an absolute CROSS-ORIGIN
    /// POST url — exercises the same-origin guardrail: refused when headers
    /// are configured, plain connection failure (no guard) when not
    /// (issue #901).
    SseCrossOriginEndpoint,
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
            captured_headers: Mutex::new(Vec::new()),
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

    // Read headers to get content-length; capture every header (name
    // lowercased) for the issue-901 header-injection pins.
    let mut content_length = 0usize;
    let mut captured: Vec<(String, String)> = Vec::new();
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
        if let Some((name, value)) = line.split_once(':') {
            captured.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    state
        .captured_headers
        .lock()
        .expect("captured_headers poisoned")
        .extend(captured);

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
        (ServerMode::HttpSseMalformed, "POST") => handle_jsonrpc_sse_malformed_post(&mut stream),
        (ServerMode::Sse, "GET") => handle_sse_stream(&mut stream, &state, base_url),
        (ServerMode::Sse, "POST") => handle_sse_post(&mut stream, &body, &state),
        (ServerMode::SseSilent, "GET") => handle_sse_stream(&mut stream, &state, base_url),
        (ServerMode::SseSilent, "POST") => handle_sse_post_silent(&mut stream, &body, &state),
        (ServerMode::SseHandshakeSilent, "GET") => handle_sse_stream(&mut stream, &state, base_url),
        (ServerMode::SseHandshakeSilent, "POST") => {
            handle_sse_post_handshake_silent(&mut stream, &body)
        }
        (ServerMode::SseBadFirstEvent, "GET") => {
            handle_sse_stream_bad_first_event(&mut stream, base_url);
        }
        (ServerMode::HttpRedirect, "POST") => handle_redirect(&mut stream, "/moved"),
        (ServerMode::SseRedirectGet, "GET") => handle_redirect(&mut stream, "/elsewhere"),
        (ServerMode::SseRedirectPost(_), "GET") => handle_sse_stream(&mut stream, &state, base_url),
        (ServerMode::SseRedirectPost(method), "POST") => {
            handle_sse_post_redirect(&mut stream, &body, &state, method)
        }
        (ServerMode::SseCrossOriginEndpoint, "GET") => {
            // A cross-origin absolute endpoint: port 9 (discard) is not this
            // listener's port, so the origin differs by construction.
            handle_sse_stream_with_endpoint(&mut stream, "http://127.0.0.1:9/message");
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

/// POST handler for streamable HTTP whose SSE `message` event carries
/// non-JSON data: the client must fail the request with the framing
/// attribution instead of skipping the event and waiting for a well-formed
/// one. The request body is drained by the shared accept path.
fn handle_jsonrpc_sse_malformed_post(stream: &mut TcpStream) {
    let body = "event: message\r\ndata: not-json\r\n\r\n";
    write_response(stream, 200, "text/event-stream", body);
}

// --- Legacy SSE handlers ---------------------------------------------------

/// Answer with `301` + a Location header and hold the connection briefly
/// (issue #901): the no-redirect guardrail pins must see the redirect status,
/// not a followed second hop.
fn handle_redirect(stream: &mut TcpStream, location: &str) {
    let header = format!(
        "HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.flush();
    thread::sleep(Duration::from_millis(200));
}

/// Open an SSE stream whose first event is a well-formed `endpoint` event
/// carrying the GIVEN url verbatim (issue #901): unlike
/// [`handle_sse_stream`], which derives the endpoint from the listener's own
/// base url, this pins the server-advertised-absolute-endpoint shape the
/// same-origin guardrail reasons about.
fn handle_sse_stream_with_endpoint(stream: &mut TcpStream, endpoint_url: &str) {
    let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.flush();

    let endpoint = format!("event: endpoint\r\ndata: {endpoint_url}\r\n\r\n");
    let _ = stream.write_all(endpoint.as_bytes());
    let _ = stream.flush();
    thread::sleep(Duration::from_secs(5));
}

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

/// Parse one SSE POST body as JSON-RPC: a malformed body is answered with a
/// 400 and yields `None` (shared by every SSE POST handler).
fn parse_sse_post(stream: &mut TcpStream, body: &[u8]) -> Option<Value> {
    match serde_json::from_slice(body) {
        Ok(v) => Some(v),
        Err(_) => {
            write_response(stream, 400, "text/plain", "bad json");
            None
        }
    }
}

/// The shared tail of both SSE POST handlers: push the response onto the
/// shared queue (the GET thread writes it as an SSE event), return 202.
fn enqueue_and_ack_sse_response(stream: &mut TcpStream, req: &Value, state: &ServerState) {
    let resp = build_rpc_response(req, "sse-fake");
    if resp != Value::Null {
        state.sse_queue.lock().unwrap().push_back(resp.to_string());
    }
    write_response(stream, 202, "application/json", "");
}

/// POST handler for SSE transport: process JSON-RPC, push response to the
/// shared queue (the GET thread writes it as an SSE event), return 202.
fn handle_sse_post(stream: &mut TcpStream, body: &[u8], state: &ServerState) {
    let Some(req) = parse_sse_post(stream, body) else {
        return;
    };
    enqueue_and_ack_sse_response(stream, &req, state);
}

/// POST handler for the silent-SSE fixture (issue #889): the handshake
/// (`initialize` / `tools/list`) is answered normally so the connect phase
/// succeeds, but a `tools/call` is acknowledged and never forwarded onto
/// the GET stream -- the client's `recv` parks on a live-but-silent
/// connection, the SSE half of the deadline shape.
fn handle_sse_post_silent(stream: &mut TcpStream, body: &[u8], state: &ServerState) {
    let Some(req) = parse_sse_post(stream, body) else {
        return;
    };
    if req.get("method").and_then(Value::as_str) == Some("tools/call") {
        write_response(stream, 202, "application/json", "");
        return;
    }
    enqueue_and_ack_sse_response(stream, &req, state);
}

/// POST handler for the handshake-silent SSE fixture (issue #897): every
/// POST is acknowledged (202) but nothing is ever enqueued -- the initialize
/// handshake itself parks the client's `recv` on a live-but-silent
/// connection.
fn handle_sse_post_handshake_silent(stream: &mut TcpStream, body: &[u8]) {
    if parse_sse_post(stream, body).is_none() {
        return;
    }
    write_response(stream, 202, "application/json", "");
}

/// POST handler for the redirect-on-one-method SSE fixture (issue #904): the
/// parameterized method's POST is answered `301` + Location, every other
/// POST behaves stock. The redirect ALSO shuts the fixture down, closing the
/// GET stream: a mutant client that skips the redirect check parks its
/// `recv` on a stream that will never carry the response -- with the stream
/// closed it surfaces a terminal `ServerClosed` instead, so the pin fails
/// with an assertion (wrong error), not a hang.
fn handle_sse_post_redirect(
    stream: &mut TcpStream,
    body: &[u8],
    state: &ServerState,
    redirect_method: &str,
) {
    let Some(req) = parse_sse_post(stream, body) else {
        return;
    };
    if req.get("method").and_then(Value::as_str) == Some(redirect_method) {
        state.shutdown.store(true, Ordering::SeqCst);
        handle_redirect(stream, "/sse-post-redirected");
        return;
    }
    enqueue_and_ack_sse_response(stream, &req, state);
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

    let mut client = toptopduck_lib::mcp::client::HttpClient::connect(&url, &BTreeMap::new())
        .expect("http connect");

    let tools = client.list_tools("http-fake").expect("tools/list");
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
        transport: McpTransport::Http {
            url,
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[config], &keychain);
    assert_eq!(results.len(), 1);
    assert!(results[0].connected, "http server connected via aggregator");

    // The catalog carries the server's tools as handle cards (ADR-0105).
    let handles = catalog_handles(&agg.search_catalog(""));
    assert!(
        handles.iter().any(|h| h == "mcp__httpmcp__add"),
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

    let mut client = toptopduck_lib::mcp::client::HttpClient::connect(&url, &BTreeMap::new())
        .expect("http-sse connect");

    let tools = client
        .list_tools("http-sse-fake")
        .expect("tools/list via SSE response");
    assert_eq!(tools.len(), 2, "http-sse server advertises echo + add");

    let result = client
        .call("add", &json!({"a": 20, "b": 22}))
        .expect("tools/call via SSE response");
    assert_eq!(first_text(&result), "42");
}

/// `HttpClient`'s SSE branch fails the request when the `message` event's
/// data is not JSON: `Framing(InvalidData)` carrying the malformed-JSON
/// wording — the streamable-HTTP half of the shared attribution (the legacy
/// reader thread's half is pinned in the unit tests). The handshake itself
/// hits the malformed event, so the failure surfaces at `connect`.
#[test]
fn http_transport_sse_malformed_data_fails_as_framing() {
    let server = HttpMcpServer::spawn(ServerMode::HttpSseMalformed);
    let url = format!("{}/mcp", server.url());

    let err = match toptopduck_lib::mcp::client::HttpClient::connect(&url, &BTreeMap::new()) {
        Ok(_) => panic!("malformed SSE data must fail the request"),
        Err(e) => e,
    };
    match err {
        toptopduck_lib::mcp::client::ClientError::Framing(ref e) => {
            assert_eq!(
                e.kind(),
                std::io::ErrorKind::InvalidData,
                "malformed -> Framing(InvalidData), got {e:?}"
            );
            assert!(
                e.to_string().contains("malformed JSON in SSE event"),
                "the shared wording, got {e}"
            );
        }
        other => panic!("expected Err(Framing), got {other:?}"),
    }
}

// --- SSE first-event rejection tests (issue #389 I4) ------------------------

/// `SseClient::connect` rejects a server whose first SSE event is not
/// `event: endpoint` (H1 security guard). The fixture sends
/// `event: message` first (issue #389 I4).
#[test]
fn sse_transport_rejects_non_endpoint_first_event() {
    let server = HttpMcpServer::spawn(ServerMode::SseBadFirstEvent);
    let url = format!("{}/sse", server.url());

    let result = toptopduck_lib::mcp::client::SseClient::connect(&url, &BTreeMap::new());
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

    let mut client = toptopduck_lib::mcp::client::SseClient::connect(&url, &BTreeMap::new())
        .expect("sse connect");

    let tools = client.list_tools("sse-fake").expect("tools/list");
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
        transport: McpTransport::Sse {
            url,
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[config], &keychain);
    assert_eq!(results.len(), 1);
    assert!(results[0].connected, "sse server connected via aggregator");

    // The catalog carries the server's tools as handle cards (ADR-0105).
    let handles = catalog_handles(&agg.search_catalog(""));
    assert!(
        handles.iter().any(|h| h == "mcp__ssemcp__add"),
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
    // connect_transport -> StdioClient::connect_with_kill -> stdio_command env injection
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

// --- Per-call deadline + cancel teardown (issue #889) ----------------------

/// The never-responds stdio fixture (the connect-deadline shape): spawns,
/// keeps the pipe open, never answers any request.
const HANG_BIN: &str = env!("CARGO_BIN_EXE_mcp-hang-server");

/// A stdio config whose command never responds, under a short per-call
/// deadline.
fn hang_config(id: &str, display: &str, timeout_ms: u32) -> McpServerConfig {
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio(HANG_BIN, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: Some(timeout_ms),
        enabled: true,
    }
}

/// A fake-server config that answers the handshake but swallows every
/// `tools/call` (`FAKE_HANG_ON_CALL=1` in the child env), under a short
/// per-call deadline.
fn hang_call_config(id: &str, display: &str, timeout_ms: u32) -> McpServerConfig {
    let mut env = BTreeMap::new();
    env.insert("FAKE_HANG_ON_CALL".to_string(), "1".to_string());
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env,
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: Some(timeout_ms),
        enabled: true,
    }
}

/// A fake-server config that answers `initialize` but swallows `tools/list`
/// (`FAKE_HANG_ON_LIST=1` in the child env), under a short per-call
/// deadline -- the tools/list half of the connect-phase park (issue #889
/// review H).
fn hang_list_config(id: &str, display: &str, timeout_ms: u32) -> McpServerConfig {
    let mut env = BTreeMap::new();
    env.insert("FAKE_HANG_ON_LIST".to_string(), "1".to_string());
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env,
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: Some(timeout_ms),
        enabled: true,
    }
}

/// A fake-server config that answers exactly ONE `tools/call` and then exits
/// (`FAKE_DIE_AFTER_CALL=1` in the child env) -- the server-death shape the
/// aggregator's dead latch normalizes (issue #889 review I3).
fn die_call_config(id: &str, display: &str) -> McpServerConfig {
    let mut env = BTreeMap::new();
    env.insert("FAKE_DIE_AFTER_CALL".to_string(), "1".to_string());
    McpServerConfig {
        id: McpServerId(id.into()),
        display_name: display.into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env,
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    }
}

/// A stdio child that spawns but never responds parks the connect phase on
/// a blocking read (issue #889): the per-call deadline bounds it, the server
/// is skipped with a timeout attribution naming it, and the turn is not
/// bricked (the trio still mounts on the attempted set).
#[test]
fn connect_deadline_skips_a_never_responding_stdio_server() {
    use std::time::Instant;

    let started = Instant::now();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(
        &[hang_config("hang-1", "HungMCP", 250)],
        &KeychainStore::new(),
    );

    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the connect park is bounded by the deadline"
    );
    assert_eq!(results.len(), 1);
    let r = &results[0];
    assert!(!r.connected, "a hung server is skipped, not fatal");
    let error = r.error.as_deref().expect("the timeout reason");
    assert!(
        error.contains("timed out") && error.contains("HungMCP"),
        "attribution names the server + the timeout, got: {error}"
    );
    // The trio mounts on the attempted set; the catalog stays empty.
    assert_eq!(meta_names(&agg), META_TRIO.to_vec());
    assert_eq!(catalog_handles(&agg.search_catalog("")).len(), 0);
}

/// A `tools/call` parked on a swallowing server returns at the deadline with
/// server + tool attribution, and the server is unavailable for the rest of
/// the turn: the next call fails fast instead of re-parking for the full
/// budget (issue #889).
#[test]
fn route_deadline_attributed_and_server_unavailable_for_the_turn() {
    use std::time::Instant;
    use toptopduck_lib::mcp::client::ClientError;

    let mut agg = McpAggregator::empty();
    agg.connect_all(
        &[hang_call_config("hang-2", "HangCall", 2_000)],
        &KeychainStore::new(),
    );
    assert_eq!(
        meta_names(&agg).len(),
        3,
        "the handshake answered normally -- only tools/call swallows"
    );

    let started = Instant::now();
    let err = match agg.route("mcp__hangcall__echo", &json!({"message": "x"})) {
        Ok(_) => panic!("a swallowed tools/call must hit the deadline"),
        Err(RouteError::Client(e)) => e,
        Err(other) => panic!("expected RouteError::Client, got {other:?}"),
    };
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the call park is bounded by the deadline"
    );
    let msg = err.to_string();
    assert!(
        msg.contains("HangCall") && msg.contains("echo") && msg.contains("timed out"),
        "attribution names server + tool + timeout, got: {msg}"
    );

    // Disconnected for the rest of the turn: the next call fails FAST.
    let started = Instant::now();
    let err2 = match agg.route("mcp__hangcall__echo", &json!({"message": "x"})) {
        Err(RouteError::Client(e)) => e,
        other => panic!("fast fail expected, got {other:?}"),
    };
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "a dead server fails fast, no re-park"
    );
    assert!(
        matches!(err2, ClientError::ServerClosed),
        "a dead server reports ServerClosed, got {err2:?}"
    );
}

/// The cancel-aware teardown (issue #889): a token fire while a call is
/// parked kills the transport, the parked read returns `ServerClosed` well
/// under the budget, and the stand-down contract holds -- a token fire AFTER
/// the turn is done kills nothing.
#[test]
fn cancel_teardown_unblocks_a_parked_call_and_stands_down_when_done() {
    use std::time::Instant;
    use toptopduck_lib::cancel::CancelToken;
    use toptopduck_lib::mcp::client::ClientError;

    // --- unblock half ------------------------------------------------------
    let cancel = Arc::new(CancelToken::new());
    let turn_done = Arc::new(AtomicBool::new(false));
    let mut agg = McpAggregator::empty();
    // A long budget: only the CANCEL path can unblock this test in time.
    agg.connect_all(
        &[hang_call_config("hang-3", "HangCancel", 60_000)],
        &KeychainStore::new(),
    );
    agg.arm_cancel_teardown(Arc::clone(&cancel), Arc::clone(&turn_done));

    let firer = Arc::clone(&cancel);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        firer.request();
    });

    let started = Instant::now();
    let err = match agg.route("mcp__hangcancel__echo", &json!({"message": "x"})) {
        Ok(_) => panic!("a cancelled park must not succeed"),
        Err(RouteError::Client(e)) => e,
        Err(other) => panic!("expected RouteError::Client, got {other:?}"),
    };
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancel unblocks the parked read well under the 60s budget"
    );
    assert!(
        matches!(err, ClientError::ServerClosed),
        "a killed transport surfaces ServerClosed, got {err:?}"
    );

    // --- stand-down half ---------------------------------------------------
    let cancel = Arc::new(CancelToken::new());
    let turn_done = Arc::new(AtomicBool::new(true));
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[fake_config("live-1", "LiveMCP")], &KeychainStore::new());
    assert!(
        results[0].connected,
        "the live server connected -- otherwise the route below fails for a \
         connect reason, not the stand-down contract (an environment flake \
         must surface HERE, self-diagnosing)"
    );
    agg.arm_cancel_teardown(Arc::clone(&cancel), Arc::clone(&turn_done));

    cancel.request();
    // Give the watcher a poll cycle to (wrongly) fire if it were to ignore
    // the stand-down flag.
    thread::sleep(Duration::from_millis(100));
    let result = agg
        .route("mcp__livemcp__echo", &json!({"message": "still alive"}))
        .expect("a done turn's token fire must not kill the transport");
    assert_eq!(
        first_text(&result),
        "Echo: still alive",
        "the live server answers after stand-down"
    );
}

/// The SSE half (issue #889): a live connection that acknowledges the POST
/// but never delivers the response event parks the `recv` -- the same
/// per-call deadline bounds it with the same attribution shape.
#[test]
fn route_deadline_bounds_a_silent_sse_connection() {
    use std::time::Instant;

    let server = HttpMcpServer::spawn(ServerMode::SseSilent);
    let config = McpServerConfig {
        id: McpServerId("sse-silent".into()),
        display_name: "SilentSSE".into(),
        transport: McpTransport::Sse {
            url: format!("{}/sse", server.url()),
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: Some(250),
        enabled: true,
    };
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[config], &KeychainStore::new());
    assert!(
        results[0].connected,
        "the handshake answered normally -- only tools/call goes silent"
    );

    let started = Instant::now();
    let err = match agg.route("mcp__silentsse__echo", &json!({"message": "x"})) {
        Err(RouteError::Client(e)) => e,
        other => panic!("deadline expected, got {other:?}"),
    };
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the recv park is bounded by the deadline"
    );
    let msg = err.to_string();
    assert!(
        msg.contains("SilentSSE") && msg.contains("timed out"),
        "attribution names the server + the timeout, got: {msg}"
    );
}

/// The SSE cancel half (issue #889): a token fire while the `recv` is
/// parked on a silent stream sets the reader stop flag -- the reader exits,
/// the channel disconnects, and the parked call returns `ServerClosed` well
/// under the budget.
#[test]
fn cancel_teardown_unblocks_a_silent_sse_park() {
    use std::time::Instant;
    use toptopduck_lib::cancel::CancelToken;
    use toptopduck_lib::mcp::client::ClientError;

    let server = HttpMcpServer::spawn(ServerMode::SseSilent);
    let config = McpServerConfig {
        id: McpServerId("sse-silent-cancel".into()),
        display_name: "SilentSSECancel".into(),
        transport: McpTransport::Sse {
            url: format!("{}/sse", server.url()),
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        // A long budget: only the CANCEL path can unblock this test in time.
        timeout_ms: Some(60_000),
        enabled: true,
    };
    let cancel = Arc::new(CancelToken::new());
    let turn_done = Arc::new(AtomicBool::new(false));
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(&[config], &KeychainStore::new());
    assert!(results[0].connected, "the handshake answered normally");
    agg.arm_cancel_teardown(Arc::clone(&cancel), Arc::clone(&turn_done));

    let firer = Arc::clone(&cancel);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        firer.request();
    });

    let started = Instant::now();
    let err = match agg.route("mcp__silentssecancel__echo", &json!({"message": "x"})) {
        Ok(_) => panic!("a cancelled park must not succeed"),
        Err(RouteError::Client(e)) => e,
        Err(other) => panic!("expected RouteError::Client, got {other:?}"),
    };
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "cancel unblocks the recv park well under the 60s budget"
    );
    assert!(
        matches!(err, ClientError::ServerClosed),
        "a stop-flagged reader disconnects the channel into ServerClosed, got {err:?}"
    );
}

/// Issue #897: the SSE half of the connect-phase cancel. The silence starts
/// at the handshake (every POST acked, no response event ever forwarded), so
/// the initialize `recv` parks mid-connect with nobody but the
/// pre-registered stop flag to break it -- arming before `connect_all`
/// means the token fire stop-flags the reader, the channel disconnects, and
/// the connect returns a transport death within one `SSE_READ_TIMEOUT` wake
/// instead of the 60s budget. The failure must be the killed transport,
/// not a skip: the fire landed mid-connect, so only the first server was
/// parked (an inverted gap check -- armed means skip -- turns the wording
/// assertion red at 0s).
///
/// No fixture mirrors this for streamable HTTP (issue #897): its kill is a
/// no-op (`TransportKill::Http`) and the connect phase is bounded by the
/// per-read timeout + the phase budget instead of a kill.
#[test]
fn connect_phase_cancel_unblocks_a_silent_sse_handshake() {
    use std::time::Instant;
    use toptopduck_lib::cancel::CancelToken;

    let server = HttpMcpServer::spawn(ServerMode::SseHandshakeSilent);
    let config = McpServerConfig {
        id: McpServerId("sse-hs-silent".into()),
        display_name: "HandshakeSilentSSE".into(),
        transport: McpTransport::Sse {
            url: format!("{}/sse", server.url()),
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        // A long budget: only the CANCEL path can unblock this test in time.
        timeout_ms: Some(60_000),
        enabled: true,
    };
    let cancel = Arc::new(CancelToken::new());
    let turn_done = Arc::new(AtomicBool::new(false));
    let mut agg = McpAggregator::empty();
    // The post-#892 arming posture: the watcher is live BEFORE the connects
    // (the session paths arm ahead of `connect_all`).
    agg.arm_cancel_teardown(Arc::clone(&cancel), Arc::clone(&turn_done));

    let firer = Arc::clone(&cancel);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        firer.request();
    });

    let started = Instant::now();
    let results = agg.connect_all(&[config], &KeychainStore::new());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cancel unblocks the parked handshake well under the 60s budget"
    );
    assert_eq!(results.len(), 1, "every attempt still reports an outcome");
    assert!(
        !results[0].connected,
        "the killed handshake must not connect: {:?}",
        results[0].error
    );
    assert!(
        !results[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("skipped"),
        "the parked handshake died a transport death, not a skip: {:?}",
        results[0].error
    );
}

/// Issue #889 review I3: the dead latch's NON-deadline half -- a server
/// that dies on its own mid-turn. `FAKE_DIE_AFTER_CALL` answers one
/// `tools/call` then exits; the SECOND route meets the corpse (the raw
/// death shape is platform-dependent, so it is pinned only as a fast
/// error), and the THIRD route must report `ServerClosed` from the latch's
/// fast-fail arm -- the normalization the latch exists for. Deleting the
/// latch degrades the third route to the platform's raw error on Linux
/// (`Framing(BrokenPipe)`) -- the shape assertion is the mutant's
/// discriminant there.
#[test]
fn route_after_a_server_death_fails_fast_with_server_closed() {
    use std::time::Instant;
    use toptopduck_lib::mcp::client::ClientError;

    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(
        &[die_call_config("die-1", "DieAfterCall")],
        &KeychainStore::new(),
    );
    assert!(
        results[0].connected,
        "the handshake + listing answered normally before the death"
    );

    // The first call is answered, then the fixture exits.
    let result = agg
        .route("mcp__dieaftercall__echo", &json!({"message": "x"}))
        .expect("the one pre-death call succeeds");
    assert_eq!(first_text(&result), "Echo: x");

    // The SECOND route meets the corpse: the raw error is platform-shaped
    // (Linux fails the pipe write with EPIPE -> Framing(BrokenPipe); Windows
    // buffers the write and the read EOFs -> ServerClosed) -- either is the
    // death signal that latches `dead`, so only speed + failure are pinned
    // here; the latch's normalization is what the THIRD route pins.
    let started = Instant::now();
    let second = agg
        .route("mcp__dieaftercall__echo", &json!({"message": "x"}))
        .expect_err("a corpse returns an error, fast");
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "a dead server fails fast, no re-park for the deadline"
    );
    assert!(
        matches!(second, RouteError::Client(_)),
        "the corpse error is a client error, got {second:?}"
    );

    // The third route rides the latch's fast-fail arm -- the ServerClosed
    // normalization holds regardless of which raw death shape the platform
    // surfaced on the second call. Deleting the latch degrades this to the
    // platform's raw error on Linux (Framing(BrokenPipe)) -- the shape
    // assertion is the mutant's discriminant there.
    let started = Instant::now();
    let err = match agg.route("mcp__dieaftercall__echo", &json!({"message": "x"})) {
        Err(RouteError::Client(e)) => e,
        other => panic!("expected RouteError::Client, got {other:?}"),
    };
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "the latched corpse fails fast"
    );
    assert!(
        matches!(err, ClientError::ServerClosed),
        "the latch normalizes every subsequent call to ServerClosed, got {err:?}"
    );
}

/// Issue #892: the connect-phase cancel gap -- the kill registry only ever
/// held COMPLETED connects' handles and the watcher's arming ran after
/// `connect_all`, so a token fire during the connect phase waited out each
/// hung server's own budget sequentially (N hung servers stacked N budgets;
/// three under the default cap held the session lock ~6 minutes). The fixed
/// shape: each connect's kill slot is pre-registered before its handshake,
/// the arming runs before the connects, and the gap between attempts checks
/// the token -- the hung read is killed immediately and the not-yet-attempted
/// servers are skipped outright.
#[test]
fn connect_phase_cancel_unblocks_hung_servers_without_stacking() {
    use std::time::Instant;
    use toptopduck_lib::cancel::CancelToken;

    let cancel = Arc::new(CancelToken::new());
    let turn_done = Arc::new(AtomicBool::new(false));
    let mut agg = McpAggregator::empty();
    // The post-#892 arming posture: the watcher is live BEFORE the connects
    // (the session paths arm ahead of `connect_all`).
    agg.arm_cancel_teardown(Arc::clone(&cancel), Arc::clone(&turn_done));

    let firer = Arc::clone(&cancel);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(300));
        firer.request();
    });

    // Three never-responding servers under a 60s budget each: only the
    // CANCEL path can return inside the assertion bound (stacked deadlines
    // would take 3+ minutes; a single unblocked-but-continuing shape still
    // takes one full budget for every remaining server).
    let started = Instant::now();
    let results = agg.connect_all(
        &[
            hang_config("stack-1", "StackOne", 60_000),
            hang_config("stack-2", "StackTwo", 60_000),
            hang_config("stack-3", "StackThree", 60_000),
        ],
        &KeychainStore::new(),
    );

    assert!(
        started.elapsed() < Duration::from_secs(10),
        "a token fire mid-connect unblocks the hung server and skips the rest"
    );
    assert_eq!(results.len(), 3, "every attempt still reports an outcome");
    for r in &results {
        assert!(
            !r.connected,
            "no server connects once the fire landed: {:?}",
            r.error
        );
    }
    // The direction and wording pins (issue #892 review): the parked server
    // died a transport death (the watcher expired its in-flight handshake),
    // NOT a skip -- while the unstarted ones carry the skip reason, which is
    // also the manifest-source string. An inverted gap check (armed -> skip
    // everything unconditionally) turns the first assertion red at 0s.
    assert!(
        !results[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("skipped"),
        "the parked server's failure is the killed transport, not a skip: {:?}",
        results[0].error
    );
    for r in &results[1..] {
        assert!(
            r.error.as_deref().is_some_and(|e| e.contains("skipped")),
            "unstarted servers must record the skip reason: {:?}",
            r.error
        );
    }
}

/// Issue #892 review (the stale-request half): a stop clicked while no turn
/// is in flight is documented as a no-op besides the flag ("which the next
/// `ask` resets before it starts") -- but the gap check reads the flag
/// before the turn's `begin_turn` clears it, so without the arming consuming
/// the stale flag, every enabled server of the next turn would be skipped
/// outright while the turn itself runs on. The arming clears it; the
/// connect proceeds normally.
#[test]
fn arming_consumes_a_stale_cancel_request_before_the_connects() {
    use toptopduck_lib::cancel::CancelToken;

    let cancel = Arc::new(CancelToken::new());
    // A stop while idle: the flag latches, no turn ever claims it.
    cancel.request();
    assert!(cancel.is_requested(), "precondition: the stale flag is set");

    let turn_done = Arc::new(AtomicBool::new(false));
    let mut agg = McpAggregator::empty();
    // The post-#892 arming posture (ahead of the connects, as both session
    // paths do) -- this is the call that must consume the stale flag.
    agg.arm_cancel_teardown(Arc::clone(&cancel), Arc::clone(&turn_done));

    // A healthy fake server: the stale request must not skip it. Under the
    // mutant (arming does not clear), this lands as the gap check's
    // "skipped" outcome and connected=false.
    let results = agg.connect_all(&[fake_config("stale-1", "StaleOne")], &KeychainStore::new());
    assert_eq!(results.len(), 1);
    assert!(
        results[0].connected,
        "a stale idle-time stop must not skip the next turn's connects: {:?}",
        results[0].error
    );
}

/// Issue #889 review H: the tools/list half of the connect-phase park --
/// `initialize` answered, the listing swallows. Same budget, same timeout
/// attribution as the never-responds shape, but the park lands AFTER the
/// handshake (the fixture half the deadline family never modeled alone).
#[test]
fn connect_deadline_bounds_a_tools_list_hang() {
    use std::time::Instant;

    let started = Instant::now();
    let mut agg = McpAggregator::empty();
    let results = agg.connect_all(
        &[hang_list_config("hang-list-1", "HangListMCP", 250)],
        &KeychainStore::new(),
    );

    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the tools/list park is bounded by the deadline"
    );
    assert_eq!(results.len(), 1);
    assert!(!results[0].connected, "a hung listing skips the server");
    let error = results[0].error.as_deref().expect("the timeout reason");
    assert!(
        error.contains("timed out") && error.contains("HangListMCP"),
        "attribution names the server + the timeout, got: {error}"
    );
}

// --- Remote transport headers (issue #901) ----------------------------------

/// The captured-headers assertion helper: true when at least one captured
/// request carried the exact `(name, value)` pair. Name matching is
/// case-insensitive on the fixture side (the fixture lowercases what it
/// captures), mirroring HTTP header-name semantics.
fn captured_has(server: &HttpMcpServer, name: &str, value: &str) -> bool {
    let captured = server.state.captured_headers.lock().expect("poisoned");
    captured.iter().any(|(n, v)| n == name && v == value)
}

/// The configured (non-secret) headers reach the wire: `HttpClient` attaches
/// them to every POST (issue #901 AC: the injection is assertable by the
/// fixture). initialize + tools/list both POST, so the pair is captured
/// twice over; one hit suffices.
#[test]
fn http_transport_sends_configured_headers_on_every_post() {
    let server = HttpMcpServer::spawn(ServerMode::Http);
    let url = format!("{}/mcp", server.url());
    let mut headers = BTreeMap::new();
    headers.insert("X-Test-Token".into(), "plain-config-value".into());

    let mut client =
        toptopduck_lib::mcp::client::HttpClient::connect(&url, &headers).expect("http connect");
    client.list_tools("hdr-fake").expect("tools/list");

    assert!(
        captured_has(&server, "x-test-token", "plain-config-value"),
        "the POST carried the configured header, got {:?}",
        server.state.captured_headers.lock().expect("poisoned")
    );
}

/// The header face through the AGGREGATOR with the secret value resolved
/// from the keychain face (issue #901 AC: the secret value never enters the
/// config -- `transport.headers` is empty; `keychain_header_keys` names it;
/// the fixture sees the injected value). The keychain itself is bypassed by
/// passing the resolved pair straight to `connect_one` (its documented
/// seam -- the command / aggregator resolve from the OS store in production).
#[test]
fn aggregator_injects_keychain_header_secrets_into_http_requests() {
    let server = HttpMcpServer::spawn(ServerMode::Http);
    let config = McpServerConfig {
        id: McpServerId("hdr-secret".into()),
        display_name: "HdrSecret".into(),
        transport: McpTransport::Http {
            url: format!("{}/mcp", server.url()),
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        // The SECRET header rides only as a name -- the value lives in the
        // keychain face, never in this config.
        keychain_header_keys: vec!["X-Test-Token".into()],
        timeout_ms: None,
        enabled: true,
    };
    let mut agg = McpAggregator::empty();
    let header_secrets: Vec<SecretEnv> = vec![("X-Test-Token".into(), "keychain-value".into())];
    agg.connect_one(&config, &[], &header_secrets);

    assert!(
        captured_has(&server, "x-test-token", "keychain-value"),
        "the keychain-resolved value reached the wire, got {:?}",
        server.state.captured_headers.lock().expect("poisoned")
    );
}

/// The probe's remote transport entry (issue #904): `probe_mcp_server`
/// resolves both secret faces from the keychain then hands the pairs to
/// `connect_transport` -- the no-kill entry no other test drives (the
/// aggregator's `connect_one` wraps the kill-slot variant). This pins that
/// entry's header-face distribution: the declared name + resolved pair
/// reach the wire exactly as the aggregator path delivers them (a probe
/// regression that drops the resolved pairs here goes red, not green).
#[test]
fn connect_transport_injects_keychain_header_secrets_into_http_requests() {
    let server = HttpMcpServer::spawn(ServerMode::Http);
    let config = McpServerConfig {
        id: McpServerId("probe-hdr".into()),
        display_name: "ProbeHdr".into(),
        transport: McpTransport::Http {
            url: format!("{}/mcp", server.url()),
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: vec!["X-Test-Token".into()],
        timeout_ms: None,
        enabled: true,
    };
    let header_secrets: Vec<SecretEnv> =
        vec![("X-Test-Token".into(), "probe-keychain-value".into())];
    let mut client =
        toptopduck_lib::mcp::client::connect_transport(&config, &[], &header_secrets, None)
            .expect("connect via the probe's transport entry");
    client.list_tools("ProbeHdr").expect("tools/list");

    assert!(
        captured_has(&server, "x-test-token", "probe-keychain-value"),
        "the probe entry put the keychain-resolved header on the wire, got {:?}",
        server.state.captured_headers.lock().expect("poisoned")
    );
}

/// The aggregator's stdio transport entry (issue #904): `connect_transport`
/// routes a stdio config to `StdioClient::connect_with_kill`, sharing the
/// `stdio_command` env-injection seam with the probe's `spawn_stdio_child`
/// (which never goes through `connect_transport` -- the probe's stdio arm
/// in commands.rs spawns and handshakes the child directly, and is not
/// itself driven by any test). The resolved keychain env pair reaches the
/// spawned child's environment through that shared seam (the echo_env tool
/// reflects std::env::var). The keychain is bypassed at the documented
/// seam: the probe resolves from the OS store in production, the resolved
/// pair rides here.
#[test]
fn connect_transport_injects_keychain_env_secrets_into_the_child_env() {
    let config = McpServerConfig {
        id: McpServerId("probe-env".into()),
        display_name: "ProbeEnv".into(),
        transport: McpTransport::stdio(FAKE_BIN, Vec::new()),
        env: BTreeMap::new(),
        keychain_env_keys: vec!["TOPTOPDUCK_TEST_MCP_SECRET".into()],
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    };
    let secrets: Vec<SecretEnv> = vec![(
        "TOPTOPDUCK_TEST_MCP_SECRET".into(),
        "probe-env-value".into(),
    )];
    let mut client = toptopduck_lib::mcp::client::connect_transport(&config, &secrets, &[], None)
        .expect("stdio connect via the probe's transport entry");
    let result = client
        .call("echo_env", &json!({"key": "TOPTOPDUCK_TEST_MCP_SECRET"}))
        .expect("echo_env call ok");
    let text = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .expect("content text");
    assert_eq!(text, "probe-env-value");
}

/// The SSE transport attaches headers to BOTH faces: the GET stream open and
/// every POST to the advertised endpoint (issue #901). initialize + tools/list
/// produce one GET and two POSTs; both faces must show the pair.
#[test]
fn sse_transport_sends_headers_on_get_stream_and_post() {
    let server = HttpMcpServer::spawn(ServerMode::Sse);
    let url = format!("{}/sse", server.url());
    let mut headers = BTreeMap::new();
    headers.insert("X-Test-Token".into(), "sse-config-value".into());

    let mut client =
        toptopduck_lib::mcp::client::SseClient::connect(&url, &headers).expect("sse connect");
    client.list_tools("sse-hdr-fake").expect("tools/list");

    // The GET stream + at least one POST: two requests carrying the pair.
    let captured = server.state.captured_headers.lock().expect("poisoned");
    let hits = captured
        .iter()
        .filter(|(n, v)| n == "x-test-token" && v == "sse-config-value")
        .count();
    drop(captured);
    assert!(
        hits >= 2,
        "the GET stream and a POST both carried the header ({hits} hits, got {:?})",
        server.state.captured_headers.lock().expect("poisoned")
    );
}

/// A header-authenticated SSE connect REFUSES a cross-origin endpoint event:
/// the error names the refusal and BOTH origins (issue #901 guardrail two --
/// the POST target comes from the server's own event, so without the guard a
/// compromised server aims the authenticated POST at any host).
#[test]
fn sse_transport_rejects_cross_origin_endpoint_when_headers_configured() {
    let server = HttpMcpServer::spawn(ServerMode::SseCrossOriginEndpoint);
    let url = format!("{}/sse", server.url());
    let mut headers = BTreeMap::new();
    headers.insert("X-Test-Token".into(), "v".into());

    let err = toptopduck_lib::mcp::client::SseClient::connect(&url, &headers)
        .err()
        .expect("cross-origin endpoint must be refused");
    let msg = err.to_string();
    assert!(
        msg.contains("cross-origin"),
        "names the refusal, got: {msg}"
    );
    assert!(
        msg.contains("http://127.0.0.1:9")
            && msg.contains(&format!("http://127.0.0.1:{}", server.port)),
        "names both origins (post {} vs sse {}), got: {msg}",
        "http://127.0.0.1:9",
        server.port
    );
}

/// The stock behavior half of the guardrail (issue #901): with NO headers
/// configured, a cross-origin endpoint stays accepted at the origin check --
/// the connect proceeds to the advertised (dead) host and fails as a plain
/// connection error, not a guard refusal. Existing header-less configs keep
/// their pre-#901 semantics.
#[test]
fn sse_transport_cross_origin_endpoint_without_headers_is_not_guard_refused() {
    let server = HttpMcpServer::spawn(ServerMode::SseCrossOriginEndpoint);
    let url = format!("{}/sse", server.url());

    let err = toptopduck_lib::mcp::client::SseClient::connect(&url, &BTreeMap::new())
        .err()
        .expect("the dead advertised host still fails the connect");
    let msg = err.to_string();
    assert!(
        !msg.contains("cross-origin"),
        "no headers -> no same-origin guard, got: {msg}"
    );
}

/// The no-redirect guardrail, HTTP half (issue #901 guardrail one): a 301 is
/// NOT followed -- the error names the redirect and its target explicitly.
#[test]
fn http_transport_refuses_redirect_instead_of_following() {
    let server = HttpMcpServer::spawn(ServerMode::HttpRedirect);
    let url = format!("{}/mcp", server.url());

    let err = toptopduck_lib::mcp::client::HttpClient::connect(&url, &BTreeMap::new())
        .err()
        .expect("a redirecting endpoint must fail the connect");
    let msg = err.to_string();
    assert!(
        msg.contains("301") && msg.contains("/moved"),
        "names the status + target, got: {msg}"
    );
    assert!(
        msg.contains("redirect") && msg.to_lowercase().contains("refus"),
        "names the refusal, got: {msg}"
    );
}

/// The no-redirect guardrail, SSE GET half (issue #901): the stream open hits
/// the same agent-level refusal.
#[test]
fn sse_transport_refuses_redirect_on_get_stream() {
    let server = HttpMcpServer::spawn(ServerMode::SseRedirectGet);
    let url = format!("{}/sse", server.url());

    let err = toptopduck_lib::mcp::client::SseClient::connect(&url, &BTreeMap::new())
        .err()
        .expect("a redirecting stream must fail the connect");
    let msg = err.to_string();
    assert!(
        msg.contains("301") && msg.contains("redirect") && msg.contains("/elsewhere"),
        "names the refused redirect, got: {msg}"
    );
}

/// The no-redirect guardrail, SSE POST-request half (issue #904): the
/// `initialize` POST rides `SseClient::request` -- a `301` answer is refused
/// with the redirect named (status + target), not followed and not parked on.
/// The GET stream and the endpoint event behave stock, so the connect
/// reaches the POST before failing.
#[test]
fn sse_transport_refuses_redirect_on_initialize_post() {
    let server = HttpMcpServer::spawn(ServerMode::SseRedirectPost("initialize"));
    let url = format!("{}/sse", server.url());

    let err = toptopduck_lib::mcp::client::SseClient::connect(&url, &BTreeMap::new())
        .err()
        .expect("a redirecting initialize POST must fail the connect");
    let msg = err.to_string();
    assert!(
        msg.contains("301") && msg.contains("redirect") && msg.contains("/sse-post-redirected"),
        "names the refused redirect, got: {msg}"
    );
}

/// The no-redirect guardrail, SSE notification half (issue #904): the
/// `notifications/initialized` ack rides `post_notification` -- its `301`
/// answer is an explicit refusal, not a silent drop of the handshake ack.
/// Only that one POST redirects: `initialize` answers stock, so the failure
/// is attributable to the notification path (a connect error here means the
/// ack's redirect was refused, not the handshake request's).
#[test]
fn sse_transport_refuses_redirect_on_initialized_notification() {
    let server = HttpMcpServer::spawn(ServerMode::SseRedirectPost("notifications/initialized"));
    let url = format!("{}/sse", server.url());

    let err = toptopduck_lib::mcp::client::SseClient::connect(&url, &BTreeMap::new())
        .err()
        .expect("a redirecting notification POST must fail the connect");
    let msg = err.to_string();
    assert!(
        msg.contains("301") && msg.contains("redirect") && msg.contains("/sse-post-redirected"),
        "names the refused redirect, got: {msg}"
    );
}

/// Guardrail two keys on the CONFIGURED face (review fix): a server that
/// declares only a SECRET header name (`keychain_header_keys`) -- whose
/// keychain value is missing here, so the merged runtime map is empty --
/// still counts as header-authenticated and refuses a cross-origin endpoint
/// (issue #901: "配置了任意 header（密或非密）时").
#[test]
fn sse_transport_guard_trips_on_a_declared_secret_name_without_a_resolved_value() {
    let server = HttpMcpServer::spawn(ServerMode::SseCrossOriginEndpoint);
    let config = McpServerConfig {
        id: McpServerId("hdr-secret-only".into()),
        display_name: "HdrSecretOnly".into(),
        transport: McpTransport::Sse {
            url: format!("{}/sse", server.url()),
            // No plain headers; the declaration alone carries the guard.
            headers: BTreeMap::new(),
        },
        env: BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: vec!["X-Test-Token".into()],
        timeout_ms: None,
        enabled: true,
    };
    // No keychain entry exists, so the resolved header_secrets are empty --
    // exactly the shape the merged-map check would have waved through.
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    agg.connect_all(&[config], &keychain);

    let listing = agg.server_listing();
    let error = listing["servers"][0]["error"]
        .as_str()
        .expect("the connect failed");
    assert!(
        error.contains("cross-origin"),
        "the declared secret name alone trips the guard, got: {error}"
    );
}
