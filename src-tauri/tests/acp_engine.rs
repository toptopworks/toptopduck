//! ACP adapter engine integration tests (ADR-0081 test seam C, issue #299).
//!
//! Drives the real [`AcpEngine`] against the fake-CLI fixture
//! (`acp-fake-cli`, declared as a `[[bin]]`) across every observable branch:
//! clean text reply, multi-step tool-call trajectory, failed tool call,
//! stop_reason ceilings, cooperative cancel, permission handshake, runaway
//! step-cap trip, and mid-turn crash (EOF). The fake CLI + the engine share
//! the `wire` types, so this is a faithful ACP v1 stdio round-trip -- the same
//! path the real claude-code drive will take in slice 9c (manual E2E only, per
//! the PRD's testing decisions; real three-CLI verification is #300).

use std::path::PathBuf;
use std::sync::Arc;

use toptopduck_lib::approval::{ApprovalResponse, ApprovalSink, ApprovalState, AuthMode};
use toptopduck_lib::cancel::CancelToken;
use toptopduck_lib::model::TurnPhase;
use toptopduck_lib::runtime::acp::adapter::{claude_code, codex, gemini_cli, AdapterSpec};
use toptopduck_lib::runtime::acp::engine::{AcpEngine, AcpTurnInput};
use toptopduck_lib::runtime::acp::wire::{ContentBlock, McpServer};
use toptopduck_lib::session::agent_loop::{LoopOutcome, Termination};

/// Resolve the fake-CLI binary path (cargo sets `CARGO_BIN_EXE_acp-fake-cli`
/// for integration tests of the same package).
fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_acp-fake-cli"))
}

/// A minimal turn input: one text block carrying the question + a placeholder
/// bridge descriptor (the fixture ignores both).
fn input() -> AcpTurnInput {
    AcpTurnInput {
        cwd: std::env::temp_dir().to_string_lossy().to_string(),
        mcp_servers: vec![McpServer::stdio_bridge(
            "toptopduck-gateway",
            "/placeholder/bridge",
            Vec::new(),
            std::collections::BTreeMap::new(),
        )],
        prompt_blocks: vec![ContentBlock::text("what is the answer?")],
    }
}

/// Build an engine with a short wall-clock (so a stuck scenario fails the test
/// fast, not the 120s production default) + a tunable step cap.
fn engine(cancel: Arc<CancelToken>, step_cap: u32) -> AcpEngine {
    AcpEngine::new(claude_code(), cancel)
        .with_caps(step_cap, Some(std::time::Duration::from_secs(10)))
}

/// A recording sink (thread-safe): the engine emits approval card events on
/// every permission handshake; tests assert them.
#[derive(Default)]
struct RecordingSink {
    requests: std::sync::Mutex<Vec<String>>,
    resolved: std::sync::Mutex<Vec<ApprovalResponse>>,
}

impl ApprovalSink for RecordingSink {
    fn emit_request(&self, body: &toptopduck_lib::approval::ApprovalRequestBody) {
        self.requests.lock().unwrap().push(body.tool.clone());
    }
    fn emit_resolved(
        &self,
        _body: &toptopduck_lib::approval::ApprovalRequestBody,
        response: ApprovalResponse,
    ) {
        self.resolved.lock().unwrap().push(response);
    }
}

/// Process-wide lock so the global `ACP_FAKE_SCENARIO` env var is not raced by
/// concurrent tests (each test sets it + spawns + waits under this mutex).
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run the engine against the fixture under `scenario`, collecting the phase
/// events under the default (PerCall) approval. Returns the outcome + phases.
fn run(scenario: &str, step_cap: u32) -> (LoopOutcome, Vec<TurnPhase>) {
    let cancel = Arc::new(CancelToken::new());
    let eng = engine(Arc::clone(&cancel), step_cap);
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let mut phases = Vec::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", scenario);
    let outcome = eng.run(&input(), &fake_cli(), &approval, &sink, |p| phases.push(p));
    (outcome, phases)
}

/// Drive one scenario through the engine built from an arbitrary `spec`. The
/// default [`run`] hardcodes claude-code; this variant lets the isomorphism
/// test exercise gemini-cli + codex against the SAME fixture binary. The fixture
/// ignores argv, so claude-code/gemini-cli (`--acp`) and codex (empty argv) all
/// spawn + pump through one code path.
fn run_with_spec(spec: &AdapterSpec, scenario: &str, step_cap: u32) -> LoopOutcome {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(spec.clone(), cancel)
        .with_caps(step_cap, Some(std::time::Duration::from_secs(10)));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", scenario);
    eng.run(&input(), &fake_cli(), &approval, &sink, |_| {})
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/// A clean text reply: the agent emits one message chunk + succeeds. The
/// outcome is Text with the streamed text; no tool calls -> empty trace.
#[test]
fn text_reply_yields_text_outcome_and_no_trace() {
    let (outcome, phases) = run("text_reply", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "the answer is 42"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert!(outcome.trace.is_empty(), "no tool calls -> empty trace");
    assert!(
        phases
            .iter()
            .any(|p| matches!(p, TurnPhase::Thinking { attempt: 1 })),
        "a Thinking phase fires before the prompt"
    );
}

/// A multi-step tool trajectory: a tool call starts + completes, then a text
/// reply. The trace carries one successful entry; the phase stream has the
/// Started/Completed pair.
#[test]
fn tool_calls_yields_trace_with_one_successful_entry() {
    let (outcome, phases) = run("tool_calls", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "found 3 rows"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(outcome.trace.len(), 1, "one tool call -> one trace entry");
    let entry = &outcome.trace[0];
    assert!(entry.success, "the call completed");
    assert_eq!(entry.name, "explore SELECT 1");
    assert!(phases.iter().any(|p| matches!(
        p,
        TurnPhase::ToolCallStarted { name, .. } if name == "explore SELECT 1"
    )));
    assert!(phases
        .iter()
        .any(|p| matches!(p, TurnPhase::ToolCallCompleted(e) if e.success)));
}

/// A failed tool call lands in the trace with success=false + the error
/// message kept as the failure anchor (ADR-0078).
#[test]
fn failed_tool_call_records_failure_anchor() {
    let (outcome, _) = run("tool_failure", 24);
    assert_eq!(outcome.trace.len(), 1);
    let entry = &outcome.trace[0];
    assert!(!entry.success);
    assert!(
        entry.result_excerpt.contains("syntax error"),
        "failure keeps the error excerpt: {}",
        entry.result_excerpt
    );
}

/// The agent's own max_turns ceiling maps to StepCap (an execution-level cap).
#[test]
fn max_turns_stop_reason_maps_to_step_cap() {
    let (outcome, _) = run("max_turns", 24);
    match outcome.termination {
        Termination::StepCap(n) => assert_eq!(n, 24),
        other => panic!("expected StepCap, got {other:?}"),
    }
}

/// A refusal carries the agent's text (surfaced as a textual outcome the user
/// reads) -- the engine does NOT treat refusal as a failure.
#[test]
fn refusal_maps_to_text_outcome() {
    let (outcome, _) = run("refusal", 24);
    match outcome.termination {
        Termination::Text(t) => assert!(t.contains("can't do that"), "got: {t}"),
        other => panic!("expected Text, got {other:?}"),
    }
}

/// A runaway trajectory (more tool calls than the step cap) trips the engine's
/// own cancel; the cooperative fixture responds Cancelled, so the outcome is
/// deterministically Cancelled (no race with the success response).
#[test]
fn step_cap_overflow_trips_cancel_deterministically() {
    let (outcome, _) = run("step_cap_overflow", 5);
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "step-cap trip + cooperative fixture -> Cancelled: {:?}",
        outcome.termination
    );
}

/// The wall-clock watchdog fires the shared token on a stuck agent (one that
/// never reaches a prompt response); the pump sends session/cancel and the
/// cooperative fixture responds Cancelled. Exercises the watchdog path no
/// other scenario reaches.
#[test]
fn wall_clock_watchdog_fires_cancel_on_a_stuck_agent() {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(claude_code(), Arc::clone(&cancel))
        .with_caps(24, Some(std::time::Duration::from_millis(200)));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", "stuck");
    let outcome = eng.run(&input(), &fake_cli(), &approval, &sink, |_| {});
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "watchdog on a stuck agent -> Cancelled: {:?}",
        outcome.termination
    );
}

/// A prompt-response RPC error surfaces as a Transient carrying the agent's
/// message, NOT "closed stdout" (the diagnostic-misdirection regression fixed
/// alongside this fixture).
#[test]
fn prompt_rpc_error_lands_as_transient_with_the_agent_message() {
    let (outcome, _) = run("prompt_error", 24);
    match &outcome.termination {
        Termination::Transient(msg) => {
            assert!(
                msg.contains("agent internal error"),
                "carries the agent's message: {msg}"
            );
            assert!(
                !msg.contains("closed stdout"),
                "must not misreport as EOF: {msg}"
            );
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// A mid-turn crash (the fixture closes stdout) lands as a transient failure,
/// not a hang.
#[test]
fn crash_mid_turn_lands_as_transient() {
    let (outcome, _) = run("crash", 24);
    match outcome.termination {
        Termination::Transient(msg) => {
            assert!(msg.contains("closed stdout"), "got: {msg}");
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// A permission handshake under no-confirmation: the engine selects the allow
/// option + emits the approval card pair. The turn then succeeds.
#[test]
fn permission_under_no_confirmation_allows() {
    let cancel = Arc::new(CancelToken::new());
    let eng = engine(Arc::clone(&cancel), 24);
    let approval = ApprovalState::new();
    approval.set_auth_mode(AuthMode::NoConfirmation);
    let sink = RecordingSink::default();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", "permission");
    let outcome = eng.run(&input(), &fake_cli(), &approval, &sink, |_| {});
    assert!(
        matches!(outcome.termination, Termination::Text(_)),
        "permission allowed -> turn succeeds: {:?}",
        outcome.termination
    );
    assert!(
        sink.requests.lock().unwrap().iter().any(|t| t == "bash ls"),
        "the card surfaced the tool name"
    );
    assert!(
        sink.resolved
            .lock()
            .unwrap()
            .contains(&ApprovalResponse::AllowOnce),
        "the resolved event carries AllowOnce"
    );
}

/// A permission handshake under per-call + untrusted: fail-fast deny (the
/// engine selects the reject option so the agent self-corrects, ADR-0077).
#[test]
fn permission_under_per_call_untrusted_fail_fast_denies() {
    let cancel = Arc::new(CancelToken::new());
    let eng = engine(Arc::clone(&cancel), 24);
    let approval = ApprovalState::new(); // PerCall, empty trust
    let sink = RecordingSink::default();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", "permission");
    eng.run(&input(), &fake_cli(), &approval, &sink, |_| {});
    assert!(
        sink.resolved
            .lock()
            .unwrap()
            .contains(&ApprovalResponse::Deny),
        "fail-fast emits a Deny resolved event"
    );
}

/// A cooperative cancel: the engine fires cancel (via the shared token) mid-
/// turn; the fixture acknowledges + responds Cancelled. The outcome is
/// Cancelled, not a hang.
#[test]
fn user_cancel_aborts_the_whole_turn() {
    let cancel = Arc::new(CancelToken::new());
    let eng = engine(Arc::clone(&cancel), 24);
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let cancel_for_thread = Arc::clone(&cancel);
    // Fire cancel shortly after run starts (the fixture emits "working..."
    // until cancel arrives). The delay covers spawn + handshake.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        cancel_for_thread.request();
    });
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", "cancel");
    let outcome = eng.run(&input(), &fake_cli(), &approval, &sink, |_| {});
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "user cancel -> Cancelled: {:?}",
        outcome.termination
    );
}

/// The engine takes the adapter spec as data and never names the CLI: the same
/// engine drives any spec. Smoke: a text_reply run completes (the spec's argv
/// is what the spawn used; the fixture tolerates the `--acp` arg).
#[test]
fn engine_runs_against_the_claude_code_spec() {
    let spec: AdapterSpec = claude_code();
    assert_eq!(spec.adapter_id().as_str(), "claude-code");
    let (outcome, _) = run("text_reply", 24);
    assert!(matches!(outcome.termination, Termination::Text(_)));
}

/// #300 structural coverage of AC "the engine gains no per-CLI branch": drive
/// the same text-reply (success path) and the same step-cap overflow (the
/// step-cap cancel fallback path) through each of the three v1 specs
/// (claude-code, gemini-cli, codex) and assert identical termination. The
/// fixture ignores argv, so the `--acp` launch (claude-code / gemini-cli) vs the
/// empty-argv launch (codex) all spawn + pump through the SAME engine entry
/// point. Combined with the engine's spec-consumption surface being only `argv`
/// (spawn) + `id` (error message + ToolKey) -- audited, never a dispatch --
/// this pins ONE uniform outcome per scenario across all three specs, so a
/// future per-CLI branch that changes outcomes would trip it.
///
/// What this does NOT prove: behavioral isomorphism of the REAL CLIs (cancel /
/// step-cap / wall-clock fallback, the rest of AC #3). The fixture erases the
/// very dimension (argv) a per-CLI branch would consume, so it cannot observe
/// real-CLI divergence by design; that coverage is manual E2E per the PRD. The
/// wall-clock fallback path across specs is also not exercised here (only the
/// claude-code `wall_clock_watchdog_*` test drives it).
#[test]
fn engine_outcome_is_identical_across_all_three_specs() {
    let specs = [claude_code(), gemini_cli(), codex()];
    for spec in &specs {
        // Success path: a clean text reply -> Text for every spec.
        let outcome = run_with_spec(spec, "text_reply", 24);
        match &outcome.termination {
            Termination::Text(t) => assert_eq!(
                t, "the answer is 42",
                "{}: text_reply round-tripped through the pump",
                spec.id
            ),
            other => panic!("{} text_reply -> Text, got {other:?}", spec.id),
        }
        assert!(
            outcome.trace.is_empty(),
            "{}: no tool calls -> empty trace",
            spec.id
        );

        // Fallback path: a runaway trajectory trips the step cap -> Cancelled
        // for every spec (cancel / step-cap behave isomorphically).
        let outcome = run_with_spec(spec, "step_cap_overflow", 5);
        assert!(
            matches!(outcome.termination, Termination::Cancelled),
            "{}: step-cap trip -> Cancelled, got {:?}",
            spec.id,
            outcome.termination
        );
    }
}
