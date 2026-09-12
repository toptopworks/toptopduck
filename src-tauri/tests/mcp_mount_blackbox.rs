//! Black-box MCP meta-tool mount seam (issue #661): drive a turn at the
//! `Session` boundary with MCP servers configured on `TurnInputs` and assert
//! the tool surface the provider actually received. The mount condition is
//! the ATTEMPTED set (ADR-0105 Decision 6): one enabled-but-broken server
//! (a stdio path that does not exist -- the connect fails instantly and
//! fully locally) still mounts the trio, while an empty effective set mounts
//! nothing. Pinned here because the mount point lives inside
//! `ask_with_phase`'s built-in branch (`request.tools.extend(...)` on the
//! session facade) -- no unit seam covers that extend end-to-end, and the
//! FakeProvider's captured tool-turn request is the honest read of what the
//! provider was offered.

use toptopduck_lib::mcp::config::{McpServerConfig, McpServerId, McpTransport};
use toptopduck_lib::provider::tool_calling::ToolTurnReply;
use toptopduck_lib::{
    ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState, FakeProvider,
    KeychainStore, Session, TurnInputs, TurnOutcome,
};

/// A no-op approval sink (the scripted turn never gates). Mirrors the
/// NullSink in skill_injection_blackbox.rs.
struct NullSink;
impl ApprovalSink for NullSink {
    fn emit_request(&self, _body: &ApprovalRequestBody) {}
    fn emit_resolved(&self, _body: &ApprovalRequestBody, _response: ApprovalResponse) {}
}

/// A stdio config whose command does not exist: the connect fails instantly,
/// locally, and deterministically -- the ATTEMPT is what mounts the trio, so
/// the assertion exercises the mount condition, not the transport.
fn broken_mcp_server() -> McpServerConfig {
    McpServerConfig {
        id: McpServerId("blackbox-broken".into()),
        display_name: "BrokenMCP".into(),
        transport: McpTransport::stdio("/no/such/toptopduck-binary", Vec::new()),
        env: std::collections::BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        timeout_ms: None,
        enabled: true,
    }
}

/// One enabled (but broken) server in `TurnInputs` -> the trio rides the
/// provider's tool table alongside the built-ins.
#[test]
fn a_configured_mcp_server_mounts_the_trio_on_the_provider_tool_surface() {
    let provider =
        FakeProvider::new().scripted_tool_turn("查询", ToolTurnReply::Text("done".into()));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    let server = broken_mcp_server();
    let approval = ApprovalState::new();
    let sink = NullSink;
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &sink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[server],
            keychain: &KeychainStore::new(),
            skills: &[],
            skills_root: std::path::Path::new(""),
            activated: &[],
            cli_tools: &[],
        },
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let guard = captured.lock().expect("capture lock");
    assert!(!guard.is_empty(), "provider saw no tool turns");
    let names: Vec<&str> = guard[0].tools.iter().map(|t| t.name.as_str()).collect();
    for meta in ["mcp_list_servers", "mcp_search_tools", "mcp_invoke"] {
        assert!(
            names.contains(&meta),
            "the trio must ride the provider tool surface, got {names:?}"
        );
    }
}

/// The complement: an empty effective set mounts nothing -- the surface
/// stays the built-in table only (zero standing meta-tool cost, Decision 6).
#[test]
fn an_empty_effective_set_mounts_no_meta_tools() {
    let provider =
        FakeProvider::new().scripted_tool_turn("查询", ToolTurnReply::Text("done".into()));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    let approval = ApprovalState::new();
    let sink = NullSink;
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &sink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[],
            keychain: &KeychainStore::new(),
            skills: &[],
            activated: &[],
            skills_root: std::path::Path::new(""),
            cli_tools: &[],
        },
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );

    let guard = captured.lock().expect("capture lock");
    assert!(!guard.is_empty(), "provider saw no tool turns");
    let names: Vec<&str> = guard[0].tools.iter().map(|t| t.name.as_str()).collect();
    assert!(
        !names.iter().any(|n| n.starts_with("mcp_")),
        "no meta tool rides the surface when nothing was attempted, got {names:?}"
    );
}

/// Issue #897: the built-in path's arming order pin. The aggregator API
/// contract (arm before `connect_all`) is pinned at the gateway seam
/// (mcp_gateway_integration), but the session facade's built-in branch
/// could silently regress to arm-after-connect -- with a hung MCP server
/// the connect parks the turn on the server's own budget with nobody
/// watching. This drives the real session path: one never-responding
/// stdio server under a long budget, a token fire 300ms in, and the turn
/// must return well under the budget (an arm-after-connect posture waits
/// the budget out -- the red this test exists to catch).
#[test]
fn a_connect_phase_token_fire_bounds_the_built_in_turn_with_a_hung_server() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    let provider =
        FakeProvider::new().scripted_tool_turn("查询", ToolTurnReply::Text("done".into()));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    let hang = McpServerConfig {
        id: McpServerId("blackbox-hang".into()),
        display_name: "HungMCP".into(),
        transport: McpTransport::stdio(env!("CARGO_BIN_EXE_mcp-hang-server"), Vec::new()),
        env: std::collections::BTreeMap::new(),
        keychain_env_keys: Vec::new(),
        keychain_header_keys: Vec::new(),
        // A long budget: only the CANCEL path can unblock this test in time.
        timeout_ms: Some(120_000),
        enabled: true,
    };
    let firer = Arc::clone(&session.cancel_token());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        firer.request();
    });

    let approval = ApprovalState::new();
    let sink = NullSink;
    let started = Instant::now();
    let outcome = session.ask_with_phase(
        "查询",
        &approval,
        &sink,
        |_| {},
        &TurnInputs {
            mcp_servers: &[hang],
            keychain: &KeychainStore::new(),
            skills: &[],
            skills_root: std::path::Path::new(""),
            activated: &[],
            cli_tools: &[],
        },
    );
    assert!(
        started.elapsed() < Duration::from_secs(45),
        "the token fire unblocks the parked connect well under the 120s budget"
    );
    assert!(
        matches!(
            outcome,
            TurnOutcome::Cancelled { .. } | TurnOutcome::Textual { .. }
        ),
        "the turn resolves after the cancelled connect, got {outcome:?}"
    );
}
