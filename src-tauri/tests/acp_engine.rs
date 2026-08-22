//! ACP adapter engine integration tests (ADR-0081 test seam C, issue #299).
//!
//! Drives the real [`AcpEngine`] against the fake-CLI fixture
//! (`acp-fake-cli`, declared as a `[[bin]]`) across every observable branch:
//! clean text reply, multi-step tool-call trajectory, failed tool call,
//! stop_reason ceilings, cooperative cancel, permission handshake, runaway
//! step-cap trip, and mid-turn crash (EOF). The fake CLI + the engine share
//! the `wire` types, so this is a faithful ACP v1 stdio round-trip -- the same
//! path the real gemini-cli drive will take in slice 9c (manual E2E only, per
//! the PRD's testing decisions; real-CLI E2E verification is tracked by #342).

use std::path::PathBuf;
use std::sync::Arc;

use toptopduck_lib::approval::{ApprovalResponse, ApprovalSink, ApprovalState, AuthMode};
use toptopduck_lib::cancel::CancelToken;
use toptopduck_lib::model::TurnPhase;
use toptopduck_lib::runtime::acp::adapter::{codex, gemini_cli, opencode, qwen_code, AdapterSpec};
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

/// Build an engine with a short wall-clock (so a stuck scenario fails the test
/// fast, not the 120s production default) + a tunable step cap.
fn engine(cancel: Arc<CancelToken>, step_cap: u32) -> AcpEngine {
    AcpEngine::new(gemini_cli(), cancel)
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

/// Drive one scenario through the engine built from `spec`, returning the
/// outcome + the phase stream. Holds ENV_LOCK so the global `ACP_FAKE_SCENARIO`
/// is not raced by concurrent tests. The fixture ignores argv, so any spec
/// spawns + pumps through the same engine entry point; the isomorphism test
/// relies on this to exercise all v1 specs uniformly.
fn run_with_spec(
    spec: &AdapterSpec,
    scenario: &str,
    step_cap: u32,
) -> (LoopOutcome, Vec<TurnPhase>, std::time::Instant) {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(spec.clone(), cancel)
        .with_caps(step_cap, Some(std::time::Duration::from_secs(10)));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let mut phases = Vec::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", scenario);
    // Start the clock AFTER acquiring ENV_LOCK: under the default parallel
    // runner many tests queue on this lock, and a start taken outside the
    // lock would charge that wait to this turn, masking the watchdog bound
    // (assert_not_via_watchdog measures the turn itself, not queue time).
    let start = std::time::Instant::now();
    let outcome = eng.run(&input(), &fake_cli(), &approval, &sink, |p| phases.push(p));
    (outcome, phases, start)
}

/// The default scenario runner: gemini-cli (the v1 reference spec). Most
/// scenarios assert behavior independent of which spec drives them, so they go
/// through here; the isomorphism test calls [`run_with_spec`] directly to
/// exercise all v1 specs.
fn run(scenario: &str, step_cap: u32) -> (LoopOutcome, Vec<TurnPhase>) {
    let (outcome, phases, _) = run_with_spec(&gemini_cli(), scenario, step_cap);
    (outcome, phases)
}

/// Assert a cancel/step-cap test resolved via the intended path, not the 10s
/// wall-clock watchdog. Both paths yield `Termination::Cancelled`, so the
/// termination assertion alone cannot tell them apart (the original #356 bug:
/// the suite silently fell back to the watchdog). The intended paths finish in
/// well under 1s; a 2s bound turns any watchdog fallback into a loud failure.
fn assert_not_via_watchdog(label: &str, start: std::time::Instant) {
    let elapsed = start.elapsed();
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "{label}: took {elapsed:?} -- resolved via the wall-clock watchdog, \
         not the intended cancel/step-cap path",
    );
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
    assert_eq!(
        outcome.trace.len(),
        1,
        "one round wrapping the flat trajectory"
    );
    let entry = &outcome.trace[0].calls[0];
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

/// Index of the first phase matching `pred` -- the phase-stream order
/// assertions need positions, not just membership (issue #611).
fn phase_index(phases: &[TurnPhase], label: &str, pred: impl Fn(&TurnPhase) -> bool) -> usize {
    phases
        .iter()
        .position(pred)
        .unwrap_or_else(|| panic!("phase {label} missing from the stream"))
}

/// Issue #611: thought + prose chunks ahead of each tool-call batch fold into
/// per-round slots (round boundary = the tool-call batch split); the live
/// channel carries ThinkingCompleted + RoundText between the round's Thinking
/// wait and its call events (the ADR-0103 order); the terminal text is the
/// trailing stretch only, not the concatenation of every chunk.
#[test]
fn round_prose_and_thinking_group_per_round() {
    let (outcome, phases) = run("round_prose_thinking", 24);
    match &outcome.termination {
        Termination::Text(t) => assert_eq!(t, "both rounds folded"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(
        outcome.trace.len(),
        2,
        "two batch rounds; terminal prose rides the outcome"
    );
    let r1 = &outcome.trace[0];
    assert_eq!(
        r1.thinking.as_ref().expect("round 1 thinking").text,
        "weighing schema options"
    );
    assert_eq!(r1.text.as_deref(), Some("checking the data first"));
    assert_eq!(r1.calls.len(), 1);
    assert_eq!(r1.calls[0].name, "explore SELECT 1");
    let r2 = &outcome.trace[1];
    assert_eq!(
        r2.thinking.as_ref().expect("round 2 thinking").text,
        "narrowing the filter"
    );
    assert_eq!(r2.text.as_deref(), Some("refining the query"));
    assert_eq!(r2.calls.len(), 1);

    // Live order: Thinking{1} < ThinkingCompleted < RoundText < Started{tc_1}
    // < Thinking{2} < ThinkingCompleted < RoundText < Started{tc_2}.
    let i_think1 = phase_index(&phases, "Thinking{1}", |p| {
        matches!(p, TurnPhase::Thinking { attempt: 1 })
    });
    let i_fold1 = phase_index(&phases, "ThinkingCompleted{1}", |p| {
        matches!(
            p,
            TurnPhase::ThinkingCompleted { text, .. } if text == "weighing schema options"
        )
    });
    let i_prose1 = phase_index(&phases, "RoundText{1}", |p| {
        matches!(
            p,
            TurnPhase::RoundText { text } if text == "checking the data first"
        )
    });
    let i_start1 = phase_index(&phases, "Started{tc_1}", |p| {
        matches!(
            p,
            TurnPhase::ToolCallStarted { name, .. } if name == "explore SELECT 1"
        )
    });
    let i_think2 = phase_index(&phases, "Thinking{2}", |p| {
        matches!(p, TurnPhase::Thinking { attempt: 2 })
    });
    let i_fold2 = phase_index(&phases, "ThinkingCompleted{2}", |p| {
        matches!(
            p,
            TurnPhase::ThinkingCompleted { text, .. } if text == "narrowing the filter"
        )
    });
    let i_prose2 = phase_index(&phases, "RoundText{2}", |p| {
        matches!(
            p,
            TurnPhase::RoundText { text } if text == "refining the query"
        )
    });
    let i_start2 = phase_index(&phases, "Started{tc_2}", |p| {
        matches!(
            p,
            TurnPhase::ToolCallStarted { name, .. } if name == "explore SELECT 2"
        )
    });
    let mut cursor = i_think1;
    for (i, label) in [
        (i_fold1, "ThinkingCompleted{1}"),
        (i_prose1, "RoundText{1}"),
        (i_start1, "Started{tc_1}"),
        (i_think2, "Thinking{2}"),
        (i_fold2, "ThinkingCompleted{2}"),
        (i_prose2, "RoundText{2}"),
        (i_start2, "Started{tc_2}"),
    ] {
        assert!(
            i > cursor,
            "{label} at {i} must come after the preceding phase at {cursor}"
        );
        cursor = i;
    }
}

/// Issue #611 honest degrade: an agent that never streams thought chunks (and
/// streams no prose ahead of its batch) yields no thinking folds, no round
/// prose, and a turn that still succeeds -- the terminal prose AFTER the batch
/// rides the outcome, not a round slot.
#[test]
fn absent_thought_stream_degrades_honestly() {
    let (outcome, phases) = run("tool_calls", 24);
    assert!(
        !phases
            .iter()
            .any(|p| matches!(p, TurnPhase::ThinkingCompleted { .. })),
        "no thought chunks -> no ThinkingCompleted"
    );
    assert!(
        !phases
            .iter()
            .any(|p| matches!(p, TurnPhase::RoundText { .. })),
        "no batch-ahead prose -> no RoundText"
    );
    assert_eq!(outcome.trace.len(), 1);
    assert_eq!(outcome.trace[0].thinking, None);
    assert_eq!(
        outcome.trace[0].text, None,
        "terminal prose is not round prose"
    );
}

/// Issue #611 schema verification, end to end: hand-built lines in the schema
/// crate 0.13.8 v1 wire shape (`sessionUpdate` discriminator + ONE content
/// block) parse and fold exactly like the typed-helper chunks.
#[test]
fn schema_wire_shapes_parse_end_to_end() {
    let (outcome, phases) = run("real_wire_chunks", 24);
    match &outcome.termination {
        Termination::Text(t) => assert_eq!(t, "real terminal"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(outcome.trace.len(), 1);
    assert_eq!(
        outcome.trace[0].thinking.as_ref().expect("thinking").text,
        "real thought"
    );
    assert_eq!(outcome.trace[0].text.as_deref(), Some("real prose"));
    assert!(phases.iter().any(|p| matches!(
        p,
        TurnPhase::RoundText { text } if text == "real prose"
    )));
}

/// Issue #611 fallback: prose that arrived alongside the final batch with no
/// trailing stretch still yields it as the terminal text (the accumulation
/// fallback), while the round carries it as its prose.
#[test]
fn terminal_text_falls_back_to_accumulation_without_trailing_stretch() {
    let (outcome, _) = run("midturn_prose_no_terminal", 24);
    match &outcome.termination {
        Termination::Text(t) => assert_eq!(t, "checking alongside"),
        other => panic!("expected Text, got {other:?}"),
    }
    assert_eq!(outcome.trace.len(), 1);
    assert_eq!(outcome.trace[0].text.as_deref(), Some("checking alongside"));
}

/// A failed tool call lands in the trace with success=false + the error
/// message kept as the failure anchor (ADR-0078).
#[test]
fn failed_tool_call_records_failure_anchor() {
    let (outcome, _) = run("tool_failure", 24);
    assert_eq!(outcome.trace.len(), 1);
    let entry = &outcome.trace[0].calls[0];
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
    let (outcome, _, start) = run_with_spec(&gemini_cli(), "step_cap_overflow", 5);
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "step-cap trip + cooperative fixture -> Cancelled: {:?}",
        outcome.termination
    );
    // The 10s wall-clock watchdog also collapses to Cancelled, so the
    // termination match alone cannot tell the paths apart (the #356
    // regression). The step-cap path resolves in well under 1s; pin it.
    assert_not_via_watchdog("step_cap_overflow", start);
}

/// The wall-clock watchdog fires the shared token on a stuck agent (one that
/// never reaches a prompt response); the pump sends session/cancel and the
/// cooperative fixture responds Cancelled. Exercises the watchdog path no
/// other scenario reaches.
#[test]
fn wall_clock_watchdog_fires_cancel_on_a_stuck_agent() {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(gemini_cli(), Arc::clone(&cancel))
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

/// A crash between initialize and session/new exercises the round-trip's own
/// EOF path (distinct from the prompt pump's): the shared loop's Disconnected
/// maps onto the frozen "ACP agent closed stdout" transient (issue #540 pins
/// the engine-site round-trip mapping, previously untested).
#[test]
fn crash_during_handshake_lands_as_transient_via_roundtrip_eof() {
    let (outcome, _) = run("handshake_crash", 24);
    match outcome.termination {
        Termination::Transient(msg) => {
            assert!(
                msg.contains("ACP agent closed stdout"),
                "the round-trip EOF carries the frozen wording: {msg}"
            );
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// A session/new response whose result has the wrong type fails the
/// round-trip's response parse (the shared loop's Parse arm -> the frozen
/// "response parse:" transient), never a hang (issue #540).
#[test]
fn malformed_session_new_response_is_transient_parse_failure() {
    let (outcome, _) = run("session_new_malformed", 24);
    match outcome.termination {
        Termination::Transient(msg) => {
            assert!(
                msg.contains("response parse:"),
                "carries the parse prefix: {msg}"
            );
            assert!(
                !msg.contains("closed stdout"),
                "must not misreport as EOF: {msg}"
            );
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}

/// Stray lines ahead of a handshake response (a notification + a response
/// with an unrelated id) are dropped, not errors: the handshake still
/// completes and the turn proceeds (issue #540 pins the shared loop's
/// stray-drop policy, previously untested).
#[test]
fn stray_lines_during_handshake_are_dropped_not_fatal() {
    let (outcome, _) = run("chatty_handshake", 24);
    assert!(
        matches!(outcome.termination, Termination::Text(_)),
        "stray lines must not break the handshake: {:?}",
        outcome.termination
    );
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
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", "cancel");
    // Fire cancel shortly after run starts (the fixture emits "working..."
    // until cancel arrives). Spawned AFTER ENV_LOCK + env so a wait on the
    // lock does not eat the cancel window: begin_turn (inside run) clears
    // any stale `requested` at turn start, so a cancel fired while blocked
    // on the lock would be wiped before the turn observes it. The 200ms
    // delay covers spawn + handshake.
    let cancel_for_thread = Arc::clone(&cancel);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        cancel_for_thread.request();
    });
    let start = std::time::Instant::now();
    let outcome = eng.run(&input(), &fake_cli(), &approval, &sink, |_| {});
    assert!(
        matches!(outcome.termination, Termination::Cancelled),
        "user cancel -> Cancelled: {:?}",
        outcome.termination
    );
    // The user-cancel path resolves in ~200ms (the spawn delay); a watchdog
    // fallback takes ~10s. Same rationale as the step-cap test above.
    assert_not_via_watchdog("user_cancel", start);
}

/// The engine takes the adapter spec as data and never names the CLI: the same
/// engine drives any spec. Smoke: a text_reply run completes (the spec's argv
/// is what the spawn used; the fixture tolerates the `--experimental-acp` arg).
#[test]
fn engine_runs_against_the_gemini_cli_spec() {
    let spec: AdapterSpec = gemini_cli();
    assert_eq!(spec.adapter_id().as_str(), "gemini-cli");
    let (outcome, _) = run("text_reply", 24);
    assert!(matches!(outcome.termination, Termination::Text(_)));
}

/// #300 structural coverage of AC "the engine gains no per-CLI branch": drive
/// the same text-reply (success path) and the same step-cap overflow (the
/// step-cap cancel fallback path) through each of the three ACP-format specs
/// (gemini-cli, qwen-code, opencode) and assert identical
/// termination + phase emission. The fixture ignores argv, so the per-spec
/// launch shapes (gemini-cli `--experimental-acp`,
/// qwen-code `--acp`, opencode `acp` subcommand) all spawn + pump
/// through the SAME engine entry point. Combined with the
/// engine's spec-consumption surface being only `argv` (spawn) + `id` (error
/// message + ToolKey) -- audited, never a dispatch -- this pins ONE uniform
/// outcome + phase stream per scenario across all ACP specs, so a future
/// per-CLI branch that changes outcomes or phases would trip it.
///
/// Codex is excluded: ADR-0094 migrated it to `CodexEventStream` (native
/// `exec --json`), and claude-code never spoke ACP (ADR-0097's
/// `ClaudeStreamJson` headless format), so the ACP fake-CLI fixture does
/// not apply to either.
///
/// What this does NOT prove: behavioral isomorphism of the REAL CLIs (cancel /
/// step-cap / wall-clock fallback, the rest of AC #3). The fixture erases the
/// very dimension (argv) a per-CLI branch would consume, so it cannot observe
/// real-CLI divergence by design; that coverage is manual E2E per the PRD. The
/// wall-clock fallback path across specs is also not exercised here (only the
/// gemini-cli `wall_clock_watchdog_*` test drives it). The real-CLI E2E for
/// AC #1-3 is tracked by #342.
#[test]
fn engine_outcome_is_identical_across_all_v1_specs() {
    let specs = [gemini_cli(), qwen_code(), opencode()];
    for spec in &specs {
        // Success path: a clean text reply -> Text for every spec, and the
        // Thinking phase fires before the prompt for every spec (the phase
        // stream is spec-independent too).
        let (outcome, phases, _) = run_with_spec(spec, "text_reply", 24);
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
        assert!(
            phases
                .iter()
                .any(|p| matches!(p, TurnPhase::Thinking { attempt: 1 })),
            "{}: Thinking phase fires before the prompt",
            spec.id
        );

        // Fallback path: a runaway trajectory trips the step cap -> Cancelled
        // for every spec (cancel / step-cap behave isomorphically). Timed so
        // a watchdog fallback fails the test, not just slows it (#356).
        let (outcome, _, start) = run_with_spec(spec, "step_cap_overflow", 5);
        assert!(
            matches!(outcome.termination, Termination::Cancelled),
            "{}: step-cap trip -> Cancelled, got {:?}",
            spec.id,
            outcome.termination
        );
        assert_not_via_watchdog(&format!("{} step_cap_overflow", spec.id), start);
    }
}

/// ADR-0094: the three ACP-format adapters carry `StreamFormat::Acp`. Codex
/// migrated to `CodexEventStream` (native `exec --json`) and claude-code is
/// `ClaudeStreamJson` (ADR-0097); both are asserted at the spec level in
/// adapter.rs.
#[test]
fn acp_adapters_are_acp_format() {
    use toptopduck_lib::runtime::acp::adapter::StreamFormat;
    let specs = [gemini_cli(), qwen_code(), opencode()];
    for spec in &specs {
        assert_eq!(
            spec.stream_format,
            StreamFormat::Acp,
            "{}: ACP-format adapters must carry StreamFormat::Acp",
            spec.id
        );
    }
}

/// ADR-0094: the codex adapter uses native `exec --json` direct-connect. Pin
/// the detection binary (`codex`, not the retired `codex-acp`), the exec argv
/// shape, and the `CodexEventStream` format so a regression is caught at the
/// spec level.
#[test]
fn codex_adapter_is_native_exec_codex_event_stream() {
    use toptopduck_lib::runtime::acp::adapter::StreamFormat;
    let spec = codex();
    assert_eq!(spec.stream_format, StreamFormat::CodexEventStream);
    assert_eq!(spec.binary_names, &["codex"]);
    assert_eq!(
        spec.argv,
        &[
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "read-only",
        ]
    );
}

// --- ADR-0095: discovery + injection -----------------------------------------

/// A turn against the fake fixture (whose `session/new` response carries
/// `config_options`) returns the discovered model + thought-level catalog on
/// the LoopOutcome.
#[test]
fn acp_turn_returns_discovered_runtime_catalog() {
    let (outcome, _, _) = run_with_spec(&gemini_cli(), "text_reply", 24);
    let d = outcome
        .discovered_runtime
        .as_ref()
        .expect("ACP turns carry a discovered catalog");
    assert_eq!(
        d.models,
        vec!["fake-opus".to_string(), "fake-sonnet".to_string()]
    );
    assert_eq!(d.current_model.as_deref(), Some("fake-opus"));
    assert_eq!(
        d.thought_levels,
        vec!["low".to_string(), "medium".to_string(), "high".to_string()]
    );
    assert_eq!(d.current_thought_level.as_deref(), Some("medium"));
    // Issue #529: the engine stamps the producing adapter onto the catalog
    // (provenance for the frontend's stale-cache detection across a runtime
    // switch). The fake fixture runs under the gemini-cli spec.
    assert_eq!(d.adapter_id.as_deref(), Some("gemini-cli"));
}

/// A handshake failure exits with `discovered_runtime: None` (discovery only
/// exists once session/new answered).
#[test]
fn acp_turn_handshake_failure_carries_no_discovery() {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(gemini_cli(), cancel);
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = eng.run(
        &input(),
        std::path::Path::new("/nonexistent-acp-cli-527"),
        &approval,
        &sink,
        |_| {},
    );
    assert!(outcome.discovered_runtime.is_none());
}

/// A temp-file trace channel for the fake CLI: the fixture appends every
/// received `session/set_config_option` to the file named by
/// `ACP_FAKE_TRACE_FILE` (the engine owns stdout; stderr inherits to the CI
/// console where a test cannot assert on it). Dropping the guard unsets the
/// var so later tests never trace into a stale file.
struct TraceFile {
    path: std::path::PathBuf,
}

impl TraceFile {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "acp-fake-trace-{}.log",
            std::process::id() as u64
                ^ (std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .subsec_nanos() as u64)
        ));
        Self { path }
    }

    fn read_all(&self) -> String {
        std::fs::read_to_string(&self.path).unwrap_or_default()
    }
}

impl Drop for TraceFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        // Only clear when another test has not installed its own trace file
        // (ENV_LOCK serializes the tests, so the check is exact).
        if std::env::var_os("ACP_FAKE_TRACE_FILE") == Some(self.path.clone().into_os_string()) {
            std::env::remove_var("ACP_FAKE_TRACE_FILE");
        }
    }
}

/// A selected model + thought level each ride their own
/// `session/set_config_option` between the handshake and the prompt, keyed
/// on the catalog entry's agent-chosen id (D4 -- the fixture's thought_level
/// entry declares id `thought`, NOT `thought_level`, so a hardcoded category
/// id fails). Observed via the fixture's trace file (the engine owns stdout).
#[test]
fn acp_turn_injects_model_and_thought_level() {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(gemini_cli(), cancel)
        .with_caps(24, Some(std::time::Duration::from_secs(10)));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let mut input = input();
    input.model = Some("fake-sonnet".into());
    input.thought_level = Some("high".into());
    let trace = TraceFile::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", "text_reply");
    std::env::set_var("ACP_FAKE_TRACE_FILE", &trace.path);
    let outcome = eng.run(&input, &fake_cli(), &approval, &sink, |_| {});
    // The turn itself succeeds (the injection must not break the protocol).
    assert!(matches!(outcome.termination, Termination::Text(_)));
    // Discovery still rides the outcome (the catalog is independent of the
    // selection).
    assert!(outcome.discovered_runtime.is_some());
    // The CLI received BOTH selections under the catalog's own ids, in order
    // (model first, thought level second -- both after the handshake).
    let got = trace.read_all();
    assert!(
        got.contains("ACP_FAKE_RECEIVED_SETOPTION=model=fake-sonnet"),
        "model selection must reach the CLI under the catalog id `model`; trace: {got}"
    );
    assert!(
        got.contains("ACP_FAKE_RECEIVED_SETOPTION=thought=high"),
        "thought level must reach the CLI under the catalog's agent-chosen id `thought` (not the category constant); trace: {got}"
    );
}

/// A CLI that rejects the config injection (RPC error on
/// `session/set_config_option`) fails the turn honestly as a Transient
/// naming the config id and the rejected value -- the acknowledged posture,
/// now behaviorally pinned (the fixture acks only its catalog-declared ids,
/// so an off-catalog id lands here too).
#[test]
fn acp_turn_set_config_option_rejection_fails_the_turn() {
    let cancel = Arc::new(CancelToken::new());
    let eng = AcpEngine::new(gemini_cli(), cancel)
        .with_caps(24, Some(std::time::Duration::from_secs(10)));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let mut input = input();
    input.model = Some("fake-sonnet".into());
    let trace = TraceFile::new();
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_SCENARIO", "set_config_option_reject");
    std::env::set_var("ACP_FAKE_TRACE_FILE", &trace.path);
    let outcome = eng.run(&input, &fake_cli(), &approval, &sink, |_| {});
    match outcome.termination {
        Termination::Transient(msg) => {
            assert!(
                msg.contains("session/set_config_option"),
                "the failure must name the injection call: {msg}"
            );
            assert!(
                msg.contains("`model` = `fake-sonnet`"),
                "the failure must name the config id and the rejected value in order: {msg}"
            );
        }
        other => panic!("expected Transient, got {other:?}"),
    }
    // The rejected request still reached the CLI (the fixture's reject is a
    // response, not a dropped request).
    assert!(
        trace
            .read_all()
            .contains("ACP_FAKE_RECEIVED_SETOPTION=model=fake-sonnet"),
        "the fixture must have seen the injection before rejecting it"
    );
}
