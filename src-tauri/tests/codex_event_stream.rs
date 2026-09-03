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
use toptopduck_lib::session::loop_contract::{LoopOutcome, Termination};

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
/// outcome, the phase stream, and the turn's elapsed time (measured AFTER the
/// scenario lock is held -- the harness runs tests in parallel, and the
/// lock-queue wait is not the engine's latency; the step-cap pin relies on
/// this). Uses a short wall-clock (5s) so a stuck scenario fails fast.
fn run(scenario: &str, step_cap: u32) -> (LoopOutcome, Vec<TurnPhase>, std::time::Duration) {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(codex(), cancel)
        .with_caps(step_cap, Some(std::time::Duration::from_secs(5)));
    let approval = ApprovalState::new();
    let mut phases = Vec::new();
    let _g = ENV_LOCK.lock().unwrap();
    let start = std::time::Instant::now();
    std::env::set_var("CODEX_FAKE_SCENARIO", scenario);
    let outcome = eng.run(&input(), &fake_cli(), &approval, &NoopSink, |p| {
        phases.push(p)
    });
    (outcome, phases, start.elapsed())
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

/// A clean text reply: agent_message + turn.completed -> Text with the streamed
/// text; no tool calls -> empty trace.
#[test]
fn text_reply_yields_text_outcome_and_no_trace() {
    let (outcome, phases, _) = run("text_reply", 24);
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

/// A tool-call trajectory: one command_execution (emitted as the measured
/// item.started / item.completed pair — the streaming variant must not double
/// the row) + agent_message + completed. The trace carries one successful
/// entry; the phase stream has the Started / Completed pair.
#[test]
fn tool_call_yields_trace_with_one_successful_entry() {
    let (outcome, phases, _) = run("tool_call", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "found 3 rows"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(outcome.trace.len(), 1, "one batch round wrapping the call");
    assert_eq!(
        outcome.trace[0].calls.len(),
        1,
        "the item.started streaming variant never doubles the row"
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

/// A failed command (non-zero exit) lands a failed trace row with the exit
/// code as the failure anchor — the end-to-end companion of the unit pins
/// (issue #804).
#[test]
fn failed_command_lands_failed_trace_row() {
    let (outcome, _, _) = run("tool_call_failure", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "the command failed"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(outcome.trace.len(), 1, "one batch round wrapping the call");
    let entry = &outcome.trace[0].calls[0];
    assert!(!entry.success, "the non-zero exit fails the row");
    assert_eq!(entry.result_excerpt, "command exited with code 1");
}

/// A multi-round trajectory (issue #613): each batch round settles with its
/// own prose + call, the trailing prose rides the terminal text, and the live
/// channel fires each round's RoundText BEFORE its batch's ToolCallStarted
/// plus the round-2 Thinking pointer. No thinking data source exists on this
/// path, so no ThinkingCompleted phase ever fires.
#[test]
fn round_prose_settles_per_round_with_live_variants() {
    let (outcome, phases, _) = run("round_prose", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "the answer is 42"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(outcome.trace.len(), 2, "two batch rounds settle");
    assert_eq!(outcome.trace[0].text.as_deref(), Some("checking the table"));
    assert_eq!(outcome.trace[0].calls.len(), 1);
    assert_eq!(
        outcome.trace[1].text.as_deref(),
        Some("verifying the count")
    );
    assert_eq!(outcome.trace[1].calls.len(), 1);
    assert!(
        outcome.trace.iter().all(|r| r.thinking.is_none()),
        "no thinking data source -- honest degrade"
    );
    // Each round's RoundText precedes its batch's ToolCallStarted (the
    // ADR-0103 live order the frontend's round grouping relies on).
    let round1_text = phases
        .iter()
        .position(|p| matches!(p, TurnPhase::RoundText { text } if text == "checking the table"))
        .expect("round-1 RoundText fired");
    let round1_call = phases
        .iter()
        .position(
            |p| matches!(p, TurnPhase::ToolCallStarted { name, .. } if name == "explore SELECT 1"),
        )
        .expect("round-1 ToolCallStarted fired");
    assert!(round1_text < round1_call);
    let round2_text = phases
        .iter()
        .position(|p| matches!(p, TurnPhase::RoundText { text } if text == "verifying the count"))
        .expect("round-2 RoundText fired");
    let round2_call = phases
        .iter()
        .position(
            |p| matches!(p, TurnPhase::ToolCallStarted { name, .. } if name == "explore SELECT COUNT(*)"),
        )
        .expect("round-2 ToolCallStarted fired");
    assert!(round2_text < round2_call);
    let round2_pointer = phases
        .iter()
        .position(|p| matches!(p, TurnPhase::Thinking { attempt: 2 }))
        .expect("the round-2 wait pointer fired");
    assert!(
        round2_pointer < round2_text,
        "the round pointer fires at the round's opening, before its RoundText"
    );
    assert!(
        !phases
            .iter()
            .any(|p| matches!(p, TurnPhase::RoundText { text } if text == "the answer is 42")),
        "the trailing prose rides the terminal text"
    );
    assert!(
        !phases
            .iter()
            .any(|p| matches!(p, TurnPhase::ThinkingCompleted { .. })),
        "no thinking data source -- no ThinkingCompleted"
    );
}

/// A turn.failed event maps to Transient with the error message.
#[test]
fn turn_failed_maps_to_transient() {
    let (outcome, _, _) = run("turn_failed", 24);
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
    let (outcome, _, elapsed) = run("step_cap_overflow", 3);
    match outcome.termination {
        Termination::StepCap(n) => assert_eq!(n, 3),
        other => panic!("expected StepCap, got {other:?}"),
    }
    // The step-cap path resolves in well under 1s; a watchdog fallback takes
    // 5s. Pin it so a regression does not silently fall back to the watchdog.
    // The elapsed time comes from `run` (measured after the scenario lock) so
    // parallel tests' lock-queue wait does not pollute the pin.
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "took {elapsed:?} -- resolved via the wall-clock watchdog, not the step-cap path"
    );
}

/// Stdout closes mid-turn after emitting partial agent text but no terminal
/// event. The pump's Disconnected fallback treats accumulated text as the
/// answer (codex may close stdout after the final message without an explicit
/// turn.completed), so the outcome is Text — not Transient.
#[test]
fn crash_with_partial_text_treats_as_success() {
    let (outcome, _, _) = run("crash", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "about to crash"),
        other => panic!("expected Text (Disconnected fallback), got {other:?}"),
    }
    // The promoted text rode the terminal -- no round double-carries it
    // (issue #628's Text settle stays consistent with the fallback).
    assert!(outcome.trace.is_empty(), "{:?}", outcome.trace);
}

/// Stdout closes with accumulated agent text but no explicit turn.completed.
/// The pump's Disconnected fallback treats accumulated text as success (codex
/// may close stdout after the final message without an explicit terminal event).
#[test]
fn disconnected_with_text_treats_as_success() {
    let (outcome, _, _) = run("disconnected_with_text", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "partial reply"),
        other => panic!("expected Text, got {other:?}"),
    }
    // The promoted text rode the terminal -- no round double-carries it
    // (issue #628's Text settle stays consistent with the fallback).
    assert!(outcome.trace.is_empty(), "{:?}", outcome.trace);
}

/// A single line past the 4-MiB line cap is dropped by the shared reader
/// and the connection stays up: the events after it still arrive and the
/// turn completes with their text (issue #639's stream-path cap pin).
#[test]
fn overlong_line_is_dropped_and_reading_continues() {
    let (outcome, _, _) = run("line_cap_overlong", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "still alive"),
        other => panic!("expected Text despite the overlong line, got {other:?}"),
    }
}

/// Stdout closes with no events and no text -> Transient (no recovery possible).
#[test]
fn empty_stdout_lands_as_transient() {
    let (outcome, _, _) = run("empty_stdout", 24);
    match outcome.termination {
        Termination::Transient(msg) => {
            assert!(msg.contains("without a terminal event"), "got: {msg}");
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// Issue #628: a user cancel mid-answer keeps the partial prose on the tail
/// round -- the Cancelled termination carries no text for the prose to ride,
/// so the trace is its only home.
#[test]
fn user_cancel_mid_prose_keeps_partial_prose_in_trace() {
    let cancel = Arc::new(CancelToken::new());
    // No wall-clock: the user-cancel path alone (the acp_engine.rs
    // `user_cancel_aborts_the_whole_turn` peer's rationale); the fixture's
    // 30s hold fails loudly if the cancel misses.
    let eng = AcpEngine::new(codex(), Arc::clone(&cancel)).with_caps(24, None);
    let approval = ApprovalState::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CODEX_FAKE_SCENARIO", "cancel_with_prose");
    // Deterministic ordering instead of a wall-clock bet (the
    // claude_stream_json.rs peer's rationale): the scenario emits a
    // command execution and the text event in one flush, so once the
    // call's ToolCallStarted phase fires the prose is already in the pipe
    // behind it. The cancel thread latches on that phase, waits out one
    // recv cycle (the pump polls at 50ms), and only then requests -- the
    // cancel cannot overtake the prose fold. The latch also subsumes the
    // spawn-after-env rule: phases only flow once the turn is live, and
    // begin_turn has already cleared any stale `requested`. The fixture's
    // 30s hold fails loudly if the latch never fires.
    let phases: Arc<std::sync::Mutex<Vec<TurnPhase>>> = Arc::default();
    let latch = Arc::clone(&phases);
    let cancel_for_thread = Arc::clone(&cancel);
    std::thread::spawn(move || {
        while !latch
            .lock()
            .unwrap()
            .iter()
            .any(|p| matches!(p, TurnPhase::ToolCallStarted { .. }))
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        cancel_for_thread.request();
    });
    let start = std::time::Instant::now();
    let outcome = eng.run(&input(), &fake_cli(), &approval, &NoopSink, |p| {
        phases.lock().unwrap().push(p);
    });
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "user cancel -> Cancelled: {:?}",
        outcome.termination
    );
    // Round 1 carries the settled call row (the completed command carries
    // exit_code 0, so it lands successful); the call-less tail round
    // keeps the prose the cancel interrupted.
    assert_eq!(outcome.trace.len(), 2, "{:?}", outcome.trace);
    assert_eq!(outcome.trace[0].calls.len(), 1, "{:?}", outcome.trace);
    assert_eq!(
        outcome.trace[1].text.as_deref(),
        Some("partial answer"),
        "the streamed-so-far prose survives the cancel"
    );
    // Same window pin as the claude_stream_json.rs peers: catch a
    // slow-but-correct resolution, not the outright miss.
    let elapsed = start.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "took {elapsed:?} -- a slow cancel resolution; the fixture sleeps 30s"
    );
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
