//! Claude-code headless stream engine integration tests (ADR-0097, issue #561).
//!
//! Drives the real [`AcpEngine`] (via the `ClaudeStreamJson` dispatch arm)
//! against the claude fake-CLI fixture (`claude-fake-cli`, declared as a
//! `[[bin]]`) across every observable pump branch: clean text reply,
//! gateway-routed tool trajectory (phases without engine trace rows), a
//! native tool slipping past the deny list (engine trace row), hook-frame
//! tolerance, result-frame errors, the max-turns cap mapping, crash /
//! empty-stdout fallbacks, step-cap overflow, and the spawn argv injection
//! shape (model / effort / MCP config / deny list / session-persistence
//! opt-out). The fake CLI emits NDJSON frames; the engine's
//! `claude_stream_json::run_claude_stream_json` reads them and maps to the
//! SAME [`LoopOutcome`] shape the other paths return.
//!
//! Real-CLI E2E verification (the exact claude-code 2.1.222 wire) is an
//! ADR-0097 unresolved item (manual, needs an install + login).

use std::path::PathBuf;
use std::sync::Arc;

use toptopduck_lib::approval::{ApprovalResponse, ApprovalSink, ApprovalState};
use toptopduck_lib::cancel::CancelToken;
use toptopduck_lib::model::TurnPhase;
use toptopduck_lib::runtime::acp::adapter::claude_code;
use toptopduck_lib::runtime::acp::engine::{AcpEngine, AcpTurnInput};
use toptopduck_lib::runtime::acp::wire::{ContentBlock, McpServer};
use toptopduck_lib::session::agent_loop::{LoopOutcome, Termination};

/// Resolve the claude fake-CLI binary path.
fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_claude-fake-cli"))
}

/// A minimal turn input: one text block + the gateway bridge descriptor
/// (the fixture ignores both; the driver builds the `--mcp-config` argv
/// from the descriptor).
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

/// Process-wide lock so the global `CLAUDE_FAKE_SCENARIO` env var is not
/// raced by concurrent tests.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Drive one scenario through the claude stream engine, returning the
/// outcome + the phase stream. Uses a short wall-clock (5s) so a stuck
/// scenario fails the test fast.
fn run(scenario: &str, step_cap: u32) -> (LoopOutcome, Vec<TurnPhase>) {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(claude_code(), cancel)
        .with_caps(step_cap, Some(std::time::Duration::from_secs(5)));
    let approval = ApprovalState::new();
    let mut phases = Vec::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_FAKE_SCENARIO", scenario);
    let outcome = eng.run(&input(), &fake_cli(), &approval, &NoopSink, |p| {
        phases.push(p)
    });
    (outcome, phases)
}

/// A no-op approval sink (unused by the claude path but required by the
/// engine's signature).
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

/// A clean text reply: system{init} + assistant text + result success ->
/// Text with the result frame's text; no tool calls -> empty trace. The
/// `system{init}` model rides the outcome's discovered catalog (the
/// honest-rendering current model, ADR-0097 Decision 5).
#[test]
fn text_reply_yields_text_outcome_and_init_model() {
    let (outcome, phases) = run("text_reply", 24);
    match &outcome.termination {
        Termination::Text(t) => assert_eq!(t, "the answer is 42"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert!(outcome.trace.is_empty(), "no tool calls -> empty trace");
    assert!(
        phases
            .iter()
            .any(|p| matches!(p, TurnPhase::Thinking { attempt: 1 })),
        "a Thinking phase fires before the frame pump"
    );
    let discovered = outcome
        .discovered_runtime
        .as_ref()
        .expect("system{init} reports the current model");
    assert_eq!(discovered.current_model.as_deref(), Some("claude-fake-4"));
    assert_eq!(discovered.adapter_id.as_deref(), Some("claude-code"));
    assert!(
        discovered.models.is_empty(),
        "the turn path reports ONLY the current model, never a catalog"
    );
}

/// A gateway-routed tool call: the engine emits the Started/Completed phase
/// pair naming the BARE tool, but the engine trace stays empty -- the
/// gateway owns those rows (ADR-0085; the merged trace would drop a
/// duplicate, so the driver never emits one).
#[test]
fn gateway_tool_call_emits_phases_without_engine_trace() {
    let (outcome, phases) = run("tool_call", 24);
    match &outcome.termination {
        Termination::Text(t) => assert_eq!(t, "found 3 rows"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert!(
        outcome.trace.is_empty(),
        "gateway-routed calls own their trace rows: {:?}",
        outcome.trace
    );
    assert!(
        phases
            .iter()
            .any(|p| matches!(p, TurnPhase::ToolCallStarted { name, .. } if name == "explore")),
        "the Started phase names the bare tool: {phases:?}"
    );
    assert!(phases
        .iter()
        .any(|p| matches!(p, TurnPhase::ToolCallCompleted(e) if e.success)));
}

/// A native tool that slipped past the deny list upstream rides the engine
/// trace with the headless auto-refusal's failure (ADR-0097 Decision 3's
/// backstop surface -- the trace shows the refusal honestly).
#[test]
fn native_tool_rides_engine_trace_as_failure() {
    let (outcome, _) = run("native_tool_denied", 24);
    match &outcome.termination {
        Termination::Text(t) => assert_eq!(t, "done without native tools"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(outcome.trace.len(), 1, "one native call -> one trace entry");
    let entry = &outcome.trace[0];
    assert_eq!(entry.name, "Bash");
    assert!(!entry.success, "headless auto-refusal fails the call");
    assert!(
        !entry.result_excerpt.is_empty(),
        "a failed entry keeps its ADR-0078 anchor"
    );
}

/// AC: unknown `system` subtype frames mix with business frames on the
/// same stream (measured) -- the turn still resolves end-to-end.
#[test]
fn hook_frames_are_tolerated_end_to_end() {
    let (outcome, _) = run("hook_frames", 24);
    match &outcome.termination {
        Termination::Text(t) => assert_eq!(t, "hooked but fine"),
        other => panic!("expected Text despite hook frames, got {other:?}"),
    }
}

/// Non-JSON lines between valid frames (a startup banner, an update
/// warning) hit the pump's line-level skip branch (`from_str` failure ->
/// continue), never a parse failure: the outcome stays a clean Text. Real
/// CLI stdout carries such noise (banners, warnings) -- a regression here
/// would kill whole turns.
#[test]
fn garbage_lines_are_skipped_not_fatal() {
    let (outcome, _) = run("garbage_lines", 24);
    match &outcome.termination {
        Termination::Text(t) => {
            assert_eq!(t, "the answer is 42");
            assert!(!t.contains("update available"), "no noise leaks: {t}");
        }
        other => panic!("expected Text despite garbage lines, got {other:?}"),
    }
}

/// An error result frame maps to Transient carrying the CLI's detail.
#[test]
fn result_error_maps_to_transient() {
    let (outcome, _) = run("result_error", 24);
    match &outcome.termination {
        Termination::Transient(msg) => {
            assert!(msg.contains("rate limited"), "carries the detail: {msg}");
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// The CLI's own max-turns ceiling maps onto the execution-level StepCap
/// (the ACP path's MaxTurns precedent).
#[test]
fn max_turns_maps_to_step_cap() {
    let (outcome, _) = run("max_turns", 24);
    match outcome.termination {
        Termination::StepCap(n) => assert_eq!(n, 24),
        other => panic!("expected StepCap, got {other:?}"),
    }
}

/// Stdout closes mid-turn after assistant text but no result frame: the
/// pump's EOF fallback treats the accumulated text as the answer.
#[test]
fn crash_with_text_treats_as_success() {
    let (outcome, _) = run("crash_with_text", 24);
    match outcome.termination {
        Termination::Text(t) => assert_eq!(t, "about to crash"),
        other => panic!("expected Text (EOF fallback), got {other:?}"),
    }
}

/// Stdout closes with no frames and no text -> Transient.
#[test]
fn empty_stdout_lands_as_transient() {
    let (outcome, _) = run("empty_stdout", 24);
    match outcome.termination {
        Termination::Transient(msg) => {
            assert!(msg.contains("without a result frame"), "got: {msg}");
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// A runaway trajectory (more tool_use frames than the step cap) trips the
/// engine's step cap -> StepCap termination.
#[test]
fn step_cap_overflow_yields_step_cap_termination() {
    let start = std::time::Instant::now();
    let (outcome, _) = run("step_cap_overflow", 3);
    match outcome.termination {
        Termination::StepCap(n) => assert_eq!(n, 3),
        other => panic!("expected StepCap, got {other:?}"),
    }
    // The step-cap path resolves in well under 1s; a watchdog fallback
    // takes 5s. Pin it so a regression does not silently fall back to the
    // watchdog (the codex test's precedent).
    assert!(
        start.elapsed() < std::time::Duration::from_secs(3),
        "took {:?} -- resolved via the wall-clock watchdog, not the step-cap path",
        start.elapsed()
    );
}

/// A stuck agent (system{init}, then stdout held open in silence) under a
/// short wall-clock: the watchdog fires the shared token and the pump's
/// loop-top cancel check resolves the turn as Cancelled -- the only
/// backstop when a real CLI hangs (the acp_engine.rs
/// `wall_clock_watchdog_fires_cancel_on_a_stuck_agent` peer).
#[test]
fn wall_clock_watchdog_fires_cancel_on_a_silent_turn() {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(claude_code(), cancel)
        .with_caps(24, Some(std::time::Duration::from_millis(300)));
    let approval = ApprovalState::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_FAKE_SCENARIO", "turn_silent");
    let start = std::time::Instant::now();
    let outcome = eng.run(&input(), &fake_cli(), &approval, &NoopSink, |_| {});
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "watchdog on a stuck agent -> Cancelled: {:?}",
        outcome.termination
    );
    // The watchdog resolves in ~300ms; a regression that fails to fire it
    // rides the fixture's 30s sleep to an EOF transient. Pin the window so
    // the regression fails fast instead of hanging the suite (the
    // acp_engine.rs timing-pin precedent).
    assert!(
        start.elapsed() < std::time::Duration::from_secs(3),
        "took {:?} -- the watchdog did not fire; the fixture sleeps 30s",
        start.elapsed()
    );
}

/// A cross-thread user cancel mid-turn (the stop button's path): the pump's
/// loop-top cancel check resolves the whole turn as Cancelled, no hang (the
/// acp_engine.rs `user_cancel_aborts_the_whole_turn` peer).
#[test]
fn user_cancel_aborts_the_whole_turn() {
    let cancel = Arc::new(CancelToken::new());
    // No wall-clock: the watchdog must stay out of the way so the test
    // observes the user-cancel path alone.
    let eng = AcpEngine::new(claude_code(), Arc::clone(&cancel)).with_caps(24, None);
    let approval = ApprovalState::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_FAKE_SCENARIO", "turn_silent");
    // Fire cancel shortly after run starts (the fixture holds stdout open
    // until cancel arrives). Spawned AFTER the env set (under the lock) --
    // begin_turn (inside run) clears any stale `requested` at turn start,
    // so a cancel fired while blocked on the lock would be wiped before the
    // turn observes it. The 200ms delay covers spawn + the stdin write.
    let cancel_for_thread = Arc::clone(&cancel);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        cancel_for_thread.request();
    });
    let start = std::time::Instant::now();
    let outcome = eng.run(&input(), &fake_cli(), &approval, &NoopSink, |_| {});
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "user cancel -> Cancelled: {:?}",
        outcome.termination
    );
    // The user-cancel path resolves in ~200ms (the spawn delay); the
    // fixture would otherwise hold the turn for 30s. Same pin rationale as
    // the watchdog test above.
    assert!(
        start.elapsed() < std::time::Duration::from_secs(3),
        "took {:?} -- the cancel was not observed; the fixture sleeps 30s",
        start.elapsed()
    );
}

/// AC (argv shape): a selected model + thought level ride the spawn argv
/// as `--model <id>` + `--effort <level>` (the argv-shaped effort
/// injection, ADR-0097 Decision 6); the bridge rides `--mcp-config <json>`
/// + `--strict-mcp-config`; the stateless + denial flags are present and
///   `--resume` / `--session-id` are NOT (ADR-0097 Decision 1/3).
#[test]
fn spawn_argv_carries_selections_mcp_config_and_stateless_flags() {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(claude_code(), cancel)
        .with_caps(24, Some(std::time::Duration::from_secs(5)));
    let approval = ApprovalState::new();
    let mut input = input();
    input.model = Some("claude-fake-picked".into());
    input.thought_level = Some("high".into());
    // The fixture traces its argv to this file (stdout carries the frame
    // stream the engine owns).
    let trace = std::env::temp_dir().join(format!(
        "claude-fake-trace-{}.log",
        std::process::id() as u64
            ^ (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos() as u64)
    ));
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_FAKE_SCENARIO", "text_reply");
    std::env::set_var("CLAUDE_FAKE_TRACE_FILE", &trace);
    let outcome = eng.run(&input, &fake_cli(), &approval, &NoopSink, |_| {});
    std::env::remove_var("CLAUDE_FAKE_TRACE_FILE");
    assert!(matches!(outcome.termination, Termination::Text(_)));
    let argv = std::fs::read_to_string(&trace).unwrap_or_default();
    let _ = std::fs::remove_file(&trace);

    // Stateless headless head: the pinned turn argv prefix.
    assert!(
        argv.contains("CLAUDE_FAKE_ARGV=--print --output-format stream-json --verbose --no-session-persistence"),
        "the stateless headless argv prefix rides verbatim; got: {argv}"
    );
    // AC: no upstream session addressing.
    assert!(!argv.contains("--resume"), "no --resume: {argv}");
    assert!(!argv.contains("--session-id"), "no --session-id: {argv}");
    // AC: the native-tool deny list.
    assert!(
        argv.contains("--disallowedTools Task,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite,BashOutput,KillShell,SlashCommand"),
        "the native-tool deny list rides the argv; got: {argv}"
    );
    // ADR-0095/0097 selections: `--model` then `--effort`.
    assert!(
        argv.contains("--model claude-fake-picked --effort high"),
        "model + effort ride the argv in the documented order; got: {argv}"
    );
    // AC: MCP injection -- inline gateway descriptor + strict.
    assert!(
        argv.contains("--mcp-config {\"mcpServers\":{\"toptopduck-gateway\":{"),
        "the inline gateway descriptor rides --mcp-config; got: {argv}"
    );
    assert!(
        argv.contains("--strict-mcp-config"),
        "strict MCP shields the machine's own servers; got: {argv}"
    );
}
