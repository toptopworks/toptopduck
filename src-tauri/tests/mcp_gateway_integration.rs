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

use serde_json::json;

use toptopduck_lib::mcp::aggregator::{McpAggregator, RouteError};
use toptopduck_lib::mcp::client::SecretEnv;
use toptopduck_lib::mcp::config::{McpServerConfig, McpServerId, McpTransport};
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
    }
}

/// Collect the namespaced tool names the aggregator advertises (sorted for
/// assertion stability regardless of server iteration order).
fn tool_names(agg: &McpAggregator) -> Vec<String> {
    let mut names: Vec<String> = agg
        .aggregated_tools()
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect();
    names.sort();
    names
}

#[test]
fn connect_all_aggregates_namespaced_tools_and_routes_calls() {
    let keychain = KeychainStore::new();
    let mut agg = McpAggregator::empty();
    agg.connect_all(&[fake_config("srv-1", "FakeMCP")], &keychain);

    // The merged table namespaces the server's native tools. display "FakeMCP"
    // slugifies to "fakemcp" (ASCII lowercased).
    let names = tool_names(&agg);
    assert_eq!(
        names,
        vec![
            "mcp__fakemcp__add".to_string(),
            "mcp__fakemcp__echo".to_string(),
            "mcp__fakemcp__echo_env".to_string(),
        ],
        "namespaced tool table"
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
    let names = tool_names(&agg);
    assert!(
        names.contains(&"mcp__fakemcp__echo".into()),
        "first server keeps bare slug, got {names:?}"
    );
    assert!(
        names.contains(&"mcp__fakemcp_2__echo".into()),
        "second server gets _2 suffix, got {names:?}"
    );

    // Both servers are independently routable under their own slug.
    agg.route("mcp__fakemcp__add", &json!({"a": 1, "b": 1}))
        .expect("first server routable");
    agg.route("mcp__fakemcp_2__add", &json!({"a": 2, "b": 2}))
        .expect("second server routable under suffixed slug");
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
    };
    agg.connect_all(&[bad, good], &keychain);
    let names = tool_names(&agg);
    assert!(
        names.contains(&"mcp__good__echo".into()),
        "good server aggregated despite bad sibling, got {names:?}"
    );
    assert!(
        !names.iter().any(|n| n.starts_with("mcp__bad")),
        "bad server contributed nothing, got {names:?}"
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
