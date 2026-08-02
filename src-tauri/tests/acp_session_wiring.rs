//! Session external-runtime wiring integration (issue #299 slice 9c).
//!
//! Drives the full Session -> AcpEngine -> fake-CLI -> bridge -> gateway ->
//! tools::dispatch chain in CI. The fake-CLI's `gateway_tool_call` scenario
//! spawns the real bridge binary (its path injected via the `session/new` MCP
//! descriptor); the bridge connects back to the per-turn gateway, which serves
//! the MCP subset and routes `tools/call` (explore) through `tools::dispatch`
//! against the session's live DuckDB connection. Real claude-code E2E is
//! manual (the #299 AC, not in CI); #300 covers the other ACP CLIs against the
//! same engine. The trace-merge dedup is unit-tested at the merge function;
//! these tests pin the WIRING -- the scoped-thread serve, the bridge
//! spawn/connect, and the parallel engine drive rejoin without deadlock.

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use toptopduck_lib::runtime::acp::adapter::{AdapterId, AdapterSpec};
use toptopduck_lib::{Session, TurnOutcome};

/// The fake-CLI adapter: the fixture binary (named `acp-fake-cli`) driven with
/// no argv prefix -- it reads its scenario from `ACP_FAKE_SCENARIO`. A bespoke
/// adapter (not `claude_code()`) so the PATH scan resolves the fixture, not any
/// real claude-code install on the dev box.
fn fake_cli_adapter() -> AdapterSpec {
    AdapterSpec {
        id: AdapterId::new("fake-cli"),
        display_name: "fake-cli",
        binary_names: &["acp-fake-cli"],
        argv: &[],
    }
}

/// Process-wide lock: the global env (`PATH`, `ACP_FAKE_SCENARIO`,
/// `TOPTOPDUCK_ACP_BRIDGE_BIN`) is set under this mutex so the two tests in
/// this binary do not race. Cargo runs test binaries sequentially, so this
/// never contends with `acp_engine.rs`'s own lock; it only serializes the
/// tests within this file. Mirrors the 9a env-lock pattern.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Prepend `dir` to `PATH` so the adapter PATH scan resolves the fixture
/// binary. Returns the prior `PATH` for restoration.
fn prepend_path(dir: &std::path::Path) -> std::ffi::OsString {
    let old = std::env::var_os("PATH").unwrap_or_default();
    let mut entries: Vec<PathBuf> = std::env::split_paths(&old).collect();
    entries.insert(0, dir.to_path_buf());
    let joined = std::env::join_paths(entries).expect("PATH joins");
    std::env::set_var("PATH", &joined);
    old
}

/// Lock the global env, point it at the fixture (scenario + bridge binary +
/// PATH), and build a Session wired to the fake-CLI adapter. Returns the
/// session + the prior `PATH` + the env-lock guard (held across the turn so a
/// sibling test cannot reset the global env mid-drive).
fn external_session(scenario: &str) -> (Session, std::ffi::OsString, MutexGuard<'static, ()>) {
    let guard = ENV_LOCK.lock().unwrap();
    let fake_cli = PathBuf::from(env!("CARGO_BIN_EXE_acp-fake-cli"));
    let old_path = prepend_path(fake_cli.parent().expect("fixture has a parent dir"));
    std::env::set_var("ACP_FAKE_SCENARIO", scenario);
    std::env::set_var(
        "TOPTOPDUCK_ACP_BRIDGE_BIN",
        env!("CARGO_BIN_EXE_toptopduck-acp-bridge"),
    );
    let mut session = Session::new().expect("session");
    session.set_external_runtime(Some(fake_cli_adapter()));
    (session, old_path, guard)
}

/// The vanilla external path: a no-tool turn completes `Textual` through the
/// ACP pump. The bridge still spawns + connects (the descriptor always rides
/// `session/new`), but no `tools/call` fires -- this pins the engine + serve
/// rejoin for a turn that leaves the gateway idle, the baseline the
/// gateway-call test layers a dispatch on top of.
#[test]
fn external_text_reply_turn_completes() {
    let (mut session, old_path, _guard) = external_session("text_reply");
    let outcome = session.ask("what is the answer?");
    std::env::set_var("PATH", old_path);
    match outcome {
        TurnOutcome::Textual { body, .. } => {
            assert!(
                body.contains("42"),
                "agent text round-tripped through the pump: got {body:?}"
            );
        }
        other => panic!("text_reply must complete Textual, got {other:?}"),
    }
}

/// The full chain: the fake-CLI's `gateway_tool_call` scenario drives one MCP
/// `tools/call` (explore) through the spawned bridge -> the per-turn gateway
/// -> `tools::dispatch`, then emits a terminal agent message. The turn must
/// complete `Textual` -- proving the bridge spawns + connects, the gateway
/// serves the MCP subset, dispatch runs against the live session resources,
/// and the scoped-thread serve rejoins the parallel engine drive without
/// deadlock.
#[test]
fn external_gateway_tool_call_drives_dispatch() {
    let (mut session, old_path, _guard) = external_session("gateway_tool_call");
    let outcome = session.ask("run one gateway tool call");
    std::env::set_var("PATH", old_path);
    match outcome {
        TurnOutcome::Textual { body, .. } => {
            assert!(
                body.contains("done via gateway"),
                "agent message round-tripped through the pump: got {body:?}"
            );
        }
        other => panic!("gateway_tool_call must complete Textual, got {other:?}"),
    }
}
