//! Codex event stream engine integration tests (ADR-0094, issue #523; renamed
//! from `json_event_stream` by ADR-0097 Decision 2).
//!
//! Drives the real [`AcpEngine`] (via the `CodexEventStream` dispatch arm)
//! against the codex fake-CLI fixture (`codex-fake-cli`, declared as a
//! `[[bin]]`) across every observable pump branch: clean text reply, tool-call
//! trajectory, turn failure, step-cap overflow, crash (EOF without text), and
//! stdout close with accumulated text. The fake CLI emits NDJSON events; the
//! engine's `codex_event_stream::run_codex_event_stream` reads them and maps
//! to the SAME [`LoopOutcome`] shape the ACP path returns.
//!
//! Real-CLI E2E verification (the exact codex `exec --json` wire format) is
//! tracked by #342.

use std::path::PathBuf;
use std::sync::Arc;

use toptopduck_lib::approval::{ApprovalResponse, ApprovalSink, ApprovalState};
use toptopduck_lib::cancel::CancelToken;
use toptopduck_lib::model::TurnPhase;
use toptopduck_lib::runtime::acp::adapter::codex;
use toptopduck_lib::runtime::acp::engine::{AcpEngine, AcpTurnInput};
use toptopduck_lib::runtime::acp::wire::{ContentBlock, McpServer};
use toptopduck_lib::session::agent_loop::{LoopOutcome, Termination};

/// Resolve the codex fake-CLI binary path.
fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codex-fake-cli"))
}

/// A minimal turn input: one text block + a placeholder bridge descriptor
/// (the fixture ignores both).
fn input() -> AcpTurnInput {
    AcpTurnInput {
        model: None,
        thought_level: None,
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

/// Process-wide lock so the global `CODEX_FAKE_SCENARIO` env var is not raced
/// by concurrent tests.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Drive one scenario through the JSON event stream engine, returning the
/// outcome + the phase stream. Uses a short wall-clock (5s) so a stuck
/// scenario fails the test fast.
fn run(scenario: &str, step_cap: u32) -> (LoopOutcome, Vec<TurnPhase>) {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(codex(), cancel)
        .with_caps(step_cap, Some(std::time::Duration::from_secs(5)));
    let approval = ApprovalState::new();
    let mut phases = Vec::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CODEX_FAKE_SCENARIO", scenario);
    let outcome = eng.run(&input(), &fake_cli(), &approval, &NoopSink, |p| {
        phases.push(p)
    });
    (outcome, phases)
}

/// A no-op approval sink (unused by the JSON event stream path but required by
/// the engine's signature).
struct NoopSink;
impl ApprovalSink for NoopSink {
    fn emit_request(&self, _: &toptopduck_lib::approval::ApprovalRequestBody) {}
    fn emit_resolved(
        &self,
        _: &toptopduck_lib::approval::ApprovalRequestBody,
        _: ApprovalResponse,
    ) {
    }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/// A clean text reply: agent_message + turn_completed -> Text with the streamed
/// text; no tool calls -> empty trace.
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
        "a Thinking phase fires before the event pump"
    );
}

/// A tool-call trajectory: one command_execution + agent_message + completed.
/// The trace carries one successful entry; the phase stream has the Started /
/// Completed pair.
#[test]
fn tool_call_yields_trace_with_one_successful_entry() {
    let (outcome, phases) = run("tool_call", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "found 3 rows"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(
        outcome.trace.len(),
        1,
        "one round wrapping the flat trajectory"
    );
    let entry = &outcome.trace[0].calls[0];
    assert!(entry.success, "the call completed");
    assert_eq!(entry.name, "explore SELECT 1");
    assert!(phases.iter().any(
        |p| matches!(p, TurnPhase::ToolCallStarted { name, .. } if name == "explore SELECT 1")
    ));
    assert!(phases
        .iter()
        .any(|p| matches!(p, TurnPhase::ToolCallCompleted(e) if e.success)));
}

/// A turn_failed event maps to Transient with the error message.
#[test]
fn turn_failed_maps_to_transient() {
    let (outcome, _) = run("turn_failed", 24);
    match &outcome.termination {
        Termination::Transient(msg) => {
            assert!(msg.contains("rate limited"), "carries the error: {msg}");
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// A runaway trajectory (more command_execution events than the step cap) trips
/// the engine's step cap -> StepCap termination.
#[test]
fn step_cap_overflow_yields_step_cap_termination() {
    let start = std::time::Instant::now();
    let (outcome, _) = run("step_cap_overflow", 3);
    match outcome.termination {
        Termination::StepCap(n) => assert_eq!(n, 3),
        other => panic!("expected StepCap, got {other:?}"),
    }
    // The step-cap path resolves in well under 1s; a watchdog fallback takes
    // 5s. Pin it so a regression does not silently fall back to the watchdog.
    assert!(
        start.elapsed() < std::time::Duration::from_secs(3),
        "took {:?} -- resolved via the wall-clock watchdog, not the step-cap path",
        start.elapsed()
    );
}

/// Stdout closes mid-turn after emitting partial agent text but no terminal
/// event. The pump's Disconnected fallback treats accumulated text as the
/// answer (codex may close stdout after the final message without an explicit
/// turn_completed), so the outcome is Text — not Transient.
#[test]
fn crash_with_partial_text_treats_as_success() {
    let (outcome, _) = run("crash", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "about to crash"),
        other => panic!("expected Text (Disconnected fallback), got {other:?}"),
    }
}

/// Stdout closes with accumulated agent text but no explicit turn_completed.
/// The pump's Disconnected fallback treats accumulated text as success (codex
/// may close stdout after the final message without an explicit terminal event).
#[test]
fn disconnected_with_text_treats_as_success() {
    let (outcome, _) = run("disconnected_with_text", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "partial reply"),
        other => panic!("expected Text, got {other:?}"),
    }
}

/// Stdout closes with no events and no text -> Transient (no recovery possible).
#[test]
fn empty_stdout_lands_as_transient() {
    let (outcome, _) = run("empty_stdout", 24);
    match outcome.termination {
        Termination::Transient(msg) => {
            assert!(msg.contains("without a terminal event"), "got: {msg}");
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// ADR-0095: a selected model + thought level ride the spawn argv as
/// `--model <id>` + `-c model_reasoning_effort=<level>` (asserted via the
/// fixture's argv trace -- the spawn shape, not just the pure flag builder).
#[test]
fn selected_model_and_effort_ride_the_spawn_argv() {
    let cancel = Arc::new(CancelToken::new());
    let eng =
        AcpEngine::new(codex(), cancel).with_caps(24, Some(std::time::Duration::from_secs(5)));
    let approval = ApprovalState::new();
    let mut input = input();
    input.model = Some("gpt-5.1".into());
    input.thought_level = Some("high".into());
    // The fixture traces its argv to this file (stdout carries the NDJSON
    // event stream the engine owns).
    let trace = std::env::temp_dir().join(format!(
        "codex-fake-trace-{}.log",
        std::process::id() as u64
            ^ (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos() as u64)
    ));
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CODEX_FAKE_SCENARIO", "text_reply");
    std::env::set_var("CODEX_FAKE_TRACE_FILE", &trace);
    let outcome = eng.run(&input, &fake_cli(), &approval, &NoopSink, |_| {});
    std::env::remove_var("CODEX_FAKE_TRACE_FILE");
    assert!(matches!(outcome.termination, Termination::Text(_)));
    let argv = std::fs::read_to_string(&trace).unwrap_or_default();
    let _ = std::fs::remove_file(&trace);
    assert!(
        argv.contains("CODEX_FAKE_ARGV=exec --json --skip-git-repo-check --ephemeral --sandbox read-only --model gpt-5.1 -c model_reasoning_effort=high"),
        "model + effort must ride the spawn argv in the documented order; got: {argv}"
    );
}
