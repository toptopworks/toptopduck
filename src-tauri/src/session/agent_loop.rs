//! The Rust-native agent loop (ADR-0081, issue #295).
//!
//! [`AgentLoop::run`] drives a multi-step tool-calling conversation: assemble a
//! [`ToolTurnRequest`] (system prompt + windowed messages + tool table), call
//! [`Provider::generate_tool_turn`] (ADR-0081 native tool-calling, #291), route
//! each model-emitted tool call through the approval gateway (ADR-0080, #294)
//! and [`crate::tools::dispatch`] (the built-in DuckDB tool server, #292), feed
//! the [`ToolResult`]s back to the model, and repeat until the model emits a
//! terminal text reply or an execution-level cap fires. Tool-level errors (SQL
//! failure, approval denial, MCP fault) route BACK to the model for
//! self-correction (ADR-0077) -- the legacy blind-SQL-retry is abolished.
//!
//! Execution-level safety net (ADR-0081): a step cap (default 24) bounds a
//! non-converging agent, and a wall-clock watchdog (default 120s, aligned with
//! ADR-0021 `REQUEST_TIMEOUT`) fires cancel so a runaway turn cannot hang. A
//! cancel (user / close / watchdog) aborts the WHOLE turn -- the loop + any
//! in-flight tool call -- via the shared [`CancelToken`], landing as
//! [`Termination::Cancelled`].
//!
//! Pure orchestration: the loop does NOT read conversation history and does
//! NOT persist. The caller (the [`crate::session::Session::ask_with_phase`]
//! wiring seam, issue #318) assembles the [`ToolTurnRequest`] (windowed
//! context + tool table + system prompt) and maps the returned
//! [`LoopOutcome`] onto the four-way `TurnOutcome` + the conversation thread.
//! This keeps a unit test with a fake provider + the real materializer
//! exhaustive over every termination branch (multi-step success /
//! self-correction / step cap / cancel / not-wired / invalid-config /
//! transient) without constructing a whole `Session`.
//!
//! The legacy single-SQL path (`TurnRunner` + its blind retry budget) was
//! retired by the same slice that wired this loop into `Session::ask`
//! (issue #318, ADR-0077): tool-calling turns are the sole live contract.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::Value;

use super::inline_materialize;
use crate::approval::{
    ApprovalRequest, ApprovalSink, ApprovalState, GateCancelled, GateOutcome, OperationKind,
    ToolKey,
};
use crate::cancel::CancelToken;
use crate::ingest::schema::quote_ident;
use crate::mcp::aggregator::{self, McpAggregator, RouteError};
use crate::mcp::meta_tools;
use crate::model::{Promotion, ThinkingTrace, TraceEntryView, TraceRound, TurnPhase};
use crate::persistence::recipe::{truncate_trace_summary, RecipeTraceEntry, RecipeTraceRound};
use crate::provider::tool_calling::{
    ThinkingBlock, ToolResult, ToolTurnMessage, ToolTurnOutcome, ToolTurnReply, ToolTurnRequest,
    ToolUse,
};
use crate::provider::{Provider, ProviderError};
use crate::session::materializer::{Materializer, TurnDeps};
use crate::tools;
use crate::tools::definitions;

/// Default step cap (ADR-0081): a turn may make up to this many tool-call
/// round-trips before the loop aborts as [`Termination::StepCap`]. The agent is
/// expected to converge well within this; the cap is the last-line safety net
/// for a non-converging trajectory, not a target.
pub(crate) const DEFAULT_STEP_CAP: u32 = 24;

/// Default wall-clock ceiling (ADR-0081, aligned with ADR-0021
/// `REQUEST_TIMEOUT`). The watchdog fires cancel on expiry; the loop lands as
/// [`Termination::Cancelled`] (ADR-0021 timeout -> cancel mapping).
pub(crate) const DEFAULT_WALL_CLOCK: Duration = Duration::from_secs(120);

/// Maximum length of a trace entry's result excerpt (ADR-0078). The full result
/// rides the trace; the far window carries only a summary, so an excerpt is all
/// the loop needs to keep for the collapsible trace. Shared across runtimes --
/// the ACP gateway reuses it so a trace row renders identically regardless of
/// which runtime produced it (ADR-0085 cross-runtime trace contract).
pub(crate) const TRACE_EXCERPT_MAX: usize = 240;

/// The Rust-native agent loop (ADR-0081). Holds the provider (borrowed, so the
/// loop is cheap to build per turn), the shared cancel token (owned `Arc` so the
/// watchdog can fire cancel without the session lock), and the two
/// execution-level caps. Built per turn; [`Self::run`] consumes it.
pub(crate) struct AgentLoop<'p> {
    provider: &'p dyn Provider,
    cancel: Arc<CancelToken>,
    step_cap: u32,
    wall_clock: Option<Duration>,
}

impl<'p> AgentLoop<'p> {
    /// Build a loop with the default caps (step cap 24, wall-clock 120s,
    /// ADR-0081). The provider is borrowed -- the loop does not own it -- and
    /// the cancel token is `Arc`-cloned so the watchdog thread can fire cancel
    /// across the `spawn` boundary.
    pub(crate) fn new(provider: &'p dyn Provider, cancel: Arc<CancelToken>) -> Self {
        Self {
            provider,
            cancel,
            step_cap: DEFAULT_STEP_CAP,
            wall_clock: Some(DEFAULT_WALL_CLOCK),
        }
    }

    /// Override the default caps. Tunable so a unit test can drive the step cap
    /// (`StepCap` after N round-trips) and the watchdog (`Cancelled` within
    /// milliseconds) deterministically. `wall_clock = None` disables the
    /// watchdog (step cap still applies); production keeps the default.
    // Test-only tuning seam: the production wiring (Session::ask_with_phase)
    // keeps the ADR-0081 defaults, so the non-test build sees no caller.
    #[allow(dead_code)]
    pub(crate) fn with_caps(mut self, step_cap: u32, wall_clock: Option<Duration>) -> Self {
        self.step_cap = step_cap;
        self.wall_clock = wall_clock;
        self
    }

    /// Drive one agent turn (ADR-0081): loop `generate_tool_turn` -> gate +
    /// dispatch each tool call -> feed the results back, until the model emits a
    /// terminal text reply or an execution-level cap fires. Returns the
    /// structured outcome; the caller maps it onto `TurnOutcome` + the trace +
    /// the far-window summary.
    ///
    /// `on_phase` receives the discrete [`TurnPhase`] event stream (ADR-0059,
    /// calibrated by ADR-0078): `Thinking` before each `generate_tool_turn`
    /// call (the 1-based step rises across round-trips so the UI surfaces
    /// "step N" honestly) and the `ToolCallStarted` / `ToolCallCompleted` pair
    /// around each dispatch (a gate-denied call fires only the completion,
    /// `success: false`). The completed payload IS the trace entry that lands
    /// on `TurnRecord::trace`, so the frontend renders the in-flight trace
    /// progressively from the very events the turn later persists.
    // 8 borrowed/owned handles with distinct lifetimes (per-turn request +
    // deps vs session-level approval + sink). A single call site means a
    // builder struct would shuffle fields without clarifying the borrow split;
    // `runtime/acp/engine.rs:441`/`:717` + `session/mod.rs:1900` use the same
    // pattern.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn run(
        self,
        request: &ToolTurnRequest,
        deps: &mut TurnDeps,
        materializer: &mut dyn Materializer,
        mcp: &mut McpAggregator,
        cli: &[crate::cli_tools::config::CliToolConfig],
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
        mut on_phase: impl FnMut(TurnPhase),
    ) -> LoopOutcome {
        // Single in-flight + cancellation (ADR-0021): begin the turn on the
        // shared token (marks in-flight, clears any stale
        // request from a prior turn) and arm the optional wall-clock watchdog.
        // The guard is held to end of scope -- its Drop clears in-flight + the
        // interrupt slot on every exit (including the early Cancelled returns)
        // and invalidates the watchdog so a late timeout cannot fire into the
        // next turn.
        let cancel = Arc::clone(&self.cancel);
        let guard = cancel.begin_turn();
        if let Some(timeout) = self.wall_clock {
            let alive = guard.watchdog_alive();
            let token = Arc::clone(&cancel);
            // Detached: the alive flag is its only tie to this turn. KNOWN
            // RACE: if the watchdog reads alive=true and then the turn ends
            // and a new turn begins before request() runs, the cancel lands
            // on the new turn. The window is a handful of instructions
            // between the load and request(), only reachable when the timeout
            // ~= the prior turn's runtime; the 120s default makes production
            // exposure near zero. A generation/turn-id guard closes it fully
            // (deferred). catch_unwind keeps this detached thread
            // self-sufficient.
            thread::spawn(move || {
                thread::sleep(timeout);
                if alive.load(Ordering::SeqCst)
                    && catch_unwind(AssertUnwindSafe(|| token.request())).is_err()
                {
                    log::error!(
                        target: "toptopduck::agent_loop",
                        "wall-clock watchdog panicked firing cancel; timeout path may be impaired"
                    );
                }
            });
        }

        // The in-progress conversation, grown one round-trip at a time. Begins
        // with the asking question (a User turn); each tool-call batch appends
        // an Assistant turn + one ToolResult turn per executed call.
        let mut messages = request.messages.clone();
        let mut outputs = CallOutputs {
            rounds: Vec::new(),
            promotions: Vec::new(),
        };
        let mut round_trips = 0u32;

        for step in 1..=self.step_cap {
            // Loop-top cancel check: a cancel that arrived before the first step
            // or during the prior step aborts immediately (ADR-0021). Covers
            // user cancel, close, and the watchdog firing between round-trips.
            if cancel.is_requested() {
                return outcome(Termination::Cancelled, outputs, round_trips);
            }
            // ADR-0059: signal the discrete "thinking" wait right before the
            // provider call. step is 1-based; surface it so the UI reads
            // "step N" naturally across round-trips.
            on_phase(TurnPhase::Thinking { attempt: step });
            round_trips += 1;
            let turn_req = ToolTurnRequest {
                system: request.system.clone(),
                messages: messages.clone(),
                tools: request.tools.clone(),
                max_tokens: request.max_tokens,
                thought_level: request.thought_level.clone(),
            };
            // Issue #321: guard the provider call against a panic. The adapter
            // (anthropic/openai HTTP + JSON parsing) is a trust boundary whose
            // panic must be an honest failed turn, not a silent unwind. A
            // generate_tool_turn panic cannot leave a ghost result_N (no tool
            // dispatched yet), so no rollback is needed -- the working set is
            // untouched.
            let turn_outcome = match catch_unwind(AssertUnwindSafe(|| {
                self.provider.generate_tool_turn(&turn_req)
            })) {
                Err(payload) => {
                    return outcome(
                        panic_to_transient("generate_tool_turn", &*payload),
                        outputs,
                        round_trips,
                    );
                }
                Ok(outcome) => outcome,
            };
            match turn_outcome {
                // Terminal text: the model answered. A cancel that arrived
                // during the (possibly slow) provider call wins over a textual
                // reply (ADR-0021) -- the user asked to stop.
                Ok(ToolTurnOutcome {
                    thinking,
                    reply: ToolTurnReply::Text(text),
                }) => {
                    if cancel.is_requested() {
                        return outcome(Termination::Cancelled, outputs, round_trips);
                    }
                    // ADR-0103 (issue #614): the terminal reply's thinking
                    // completes live and opens a thinking-only trailing round
                    // -- the answer itself rides the terminal text, mirroring
                    // the ACP path's trailing-round semantics.
                    if let Some(trace) = complete_round_thinking(&thinking, &mut on_phase) {
                        outputs.rounds.push(LoopRound {
                            thinking: Some(trace),
                            text: None,
                            calls: Vec::new(),
                        });
                    }
                    return outcome(Termination::Text(text), outputs, round_trips);
                }
                Ok(ToolTurnOutcome {
                    thinking,
                    reply: ToolTurnReply::ToolCalls { text, calls },
                }) => {
                    // Re-check after the (possibly slow) provider call.
                    if cancel.is_requested() {
                        return outcome(Termination::Cancelled, outputs, round_trips);
                    }
                    // ADR-0103 (issues #608/#614): one round per provider
                    // reply. The round's thinking completes FIRST (only when
                    // the round earned a trace -- readable thinking text
                    // present; a redacted-only round stays silent), then the
                    // connective prose (when present) rides the live channel
                    // BEFORE the batch's call events -- the rail can render
                    // the round's thinking fold + prose as they happen --
                    // then the trace round the batch's calls land on opens.
                    let trace = complete_round_thinking(&thinking, &mut on_phase);
                    if let Some(t) = text.as_ref() {
                        on_phase(TurnPhase::RoundText { text: t.clone() });
                    }
                    outputs.rounds.push(LoopRound {
                        thinking: trace,
                        text: text.clone(),
                        calls: Vec::new(),
                    });
                    // Append the assistant turn (thinking + prose + calls --
                    // the anthropic protocol carries the reasoning blocks and
                    // text alongside tool_use in one assistant turn; the
                    // openai protocol drops the thinking blocks, its honest
                    // degrade), then dispatch each call serially (ADR-0021
                    // single-flight within a session).
                    messages.push(ToolTurnMessage::Assistant {
                        text,
                        tool_calls: calls.clone(),
                        thinking,
                    });
                    let mut aborted = false;
                    let gate = GateCtx {
                        approval,
                        sink,
                        cancel: &cancel,
                    };
                    for call in &calls {
                        if cancel.is_requested() {
                            aborted = true;
                            break;
                        }
                        // ADR-0078: the tool-call event stream replaces the
                        // retired `Querying` marker; execute_call emits the
                        // started/completed pair around the dispatch (or only
                        // the completion for a gate-denied call).
                        //
                        // Issue #321: guard the tool dispatch against a panic.
                        // The materialize path registers result_N partway
                        // through try_materialize; a panic in any subsequent
                        // step (record_provenance, gc_stale_results,
                        // apply_display_label, descriptor_json, ToolOutcome
                        // construction) can leave a ghost result_N. The
                        // snapshot + diff in rollback_ghost_result detects +
                        // reverts any orphan so the working_set <-> history
                        // invariant holds (ADR-0084).
                        let prev_next = deps.working_set.next_result_number();
                        match catch_unwind(AssertUnwindSafe(|| {
                            execute_call(
                                call,
                                deps,
                                materializer,
                                mcp,
                                cli,
                                &gate,
                                &mut outputs,
                                &mut on_phase,
                            )
                        })) {
                            Err(payload) => {
                                rollback_ghost_result(deps, prev_next);
                                let site = format!("tool dispatch `{}`", call.name);
                                return outcome(
                                    panic_to_transient(&site, &*payload),
                                    outputs,
                                    round_trips,
                                );
                            }
                            // The gate was cancelled (close / resume / cancel
                            // interrupted an in-flight approval). The whole
                            // turn aborts.
                            Ok(Err(GateCancelled)) => {
                                aborted = true;
                                break;
                            }
                            Ok(Ok(result)) => messages.push(ToolTurnMessage::tool_result(result)),
                        }
                    }
                    if aborted || cancel.is_requested() {
                        return outcome(Termination::Cancelled, outputs, round_trips);
                    }
                    // Loop continues: the next iteration re-calls
                    // generate_tool_turn with the fed-back results.
                }
                // Permanent provider fault (ADR-0044): no retry, no agent
                // self-correction -- the turn fails immediately.
                Err(ProviderError::NotWired) => {
                    return outcome(Termination::NotWired, outputs, round_trips);
                }
                Err(ProviderError::InvalidConfig(detail)) => {
                    return outcome(Termination::InvalidConfig(detail), outputs, round_trips);
                }
                // Transient provider fault: blind retry is abolished
                // (ADR-0077); the HTTP layer already retried inside the
                // adapter, so a surfaced Unavailable is an honest turn failure.
                // It is NOT fed to the agent (transport errors never reach the
                // model, ADR-0077/0081).
                Err(ProviderError::Unavailable(detail)) => {
                    return outcome(Termination::Transient(detail), outputs, round_trips);
                }
            }
        }
        // Step cap exhausted without a terminal reply (ADR-0081): the agent did
        // not converge. Carries the cap so the wiring seam can render an honest
        // "did not converge in N steps" detail. Maps to TurnOutcome::Failed.
        outcome(Termination::StepCap(self.step_cap), outputs, round_trips)
    }
}

/// Assemble a [`LoopOutcome`] from the accumulated outputs + a termination.
/// Every exit path funnels through here so the `LoopOutcome` shape has one
/// source of truth (trace, promotions, and round-trip count always travel
/// together); each branch contributes only its [`Termination`].
fn outcome(termination: Termination, mut outputs: CallOutputs, round_trips: u32) -> LoopOutcome {
    // ADR-0103 (issue #608): drop a round the reply opened but nothing
    // landed on -- no thinking, no prose, no completed call (a cancel
    // between the reply and the first dispatch, a gate-cancelled first
    // call). The recorded trace then matches the frontend fold, which
    // cannot see such a round (none of its events ever fired); a
    // prose-bearing round survives (the prose-only round of a mid-batch
    // cancel).
    outputs.rounds.retain(|round| {
        round.thinking.is_some() || round.text.is_some() || !round.calls.is_empty()
    });
    LoopOutcome {
        termination,
        promotions: outputs.promotions,
        trace: outputs.rounds,
        round_trips,
        // ADR-0095: the built-in runtime's model comes from the provider
        // profile -- there is no handshake catalog to discover.
        discovered_runtime: None,
    }
}

/// Extract a human-readable message from a panic payload (the `Err` variant of
/// `catch_unwind`, issue #321). Covers `&str` and `String` — the two common
/// payload types; anything else degrades to a placeholder so the detail string
/// is never empty. MSRV 1.80 precludes `std::panic::panic_message` (1.81+).
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Build the `Transient` termination for a caught panic (issue #321):
/// single-sources the detail format + the log target so the two guard
/// sites stay consistent.
fn panic_to_transient(site: &str, payload: &(dyn std::any::Any + Send)) -> Termination {
    let detail = format!("agent loop panicked in {site}: {}", panic_message(payload));
    log::error!(target: "toptopduck::agent_loop", "{detail}");
    Termination::Transient(detail)
}

/// Fold a round's thinking blocks into its trace entry (issue #614).
/// Redacted blocks contribute no text (honest degrade); a round whose
/// readable text is empty carries no trace entry, though on a tool batch
/// its blocks still ride the assistant re-feed for tool-use continuity (a
/// terminal reply's blocks are not re-fed -- the conversation ends there).
/// `duration_ms` is pinned to 0: the built-in provider call is one
/// non-streaming round-trip -- there is no observable thinking-only window,
/// and no wall-clock approximation is fabricated for it (the #612
/// precedent).
fn thinking_trace(blocks: &[ThinkingBlock]) -> Option<ThinkingTrace> {
    let text = blocks
        .iter()
        .filter_map(ThinkingBlock::readable_text)
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(ThinkingTrace {
        duration_ms: 0,
        text,
    })
}

/// Derive a round's thinking trace and complete its live phase (issue
/// #614): `ThinkingCompleted` fires exactly when the round earns a trace
/// (readable text present). The trace then rides whichever `LoopRound`
/// shape the caller records -- the thinking-only trailing round of a
/// terminal reply or the prose round of a tool batch.
fn complete_round_thinking(
    thinking: &[ThinkingBlock],
    on_phase: &mut impl FnMut(TurnPhase),
) -> Option<ThinkingTrace> {
    let trace = thinking_trace(thinking)?;
    on_phase(TurnPhase::ThinkingCompleted {
        duration_ms: trace.duration_ms,
        text: trace.text.clone(),
    });
    Some(trace)
}

/// Roll back a ghost `result_N` left by a panic mid-dispatch (issue #321).
/// `try_materialize` registers `result_N` partway through its body; a panic in
/// any subsequent step (record_provenance, gc_stale_results, apply_display_label,
/// ...) leaves a registered-but-unhistoried result. Detection: compare
/// `next_result_number()` before and after the `catch_unwind`; if it grew, the
/// orphan is `result_{prev_next}` — drop its admin table + unregister it from
/// the working set so the working_set <-> history invariant holds (ADR-0084: no
/// orphan working-set result without a matching promotion in history).
///
/// If the DROP fails the orphan is left registered so `next_result_number`
/// skips it — the visible orphan is manually deletable from the UI, which is
/// safer than rewinding the number and clashing on reuse. The ghost was never
/// user-visible, so ADR-0022's no-reuse constraint does not apply to the
/// rollback itself.
fn rollback_ghost_result(deps: &mut TurnDeps, prev_next: u64) {
    let curr_next = deps.working_set.next_result_number();
    if curr_next <= prev_next {
        return;
    }
    let ghost = format!("result_{prev_next}");
    log::warn!(
        target: "toptopduck::agent_loop",
        "rolling back ghost {ghost} left by a panicked dispatch"
    );
    let drop_sql = format!("DROP TABLE {}", quote_ident(&ghost));
    if let Err(e) = deps.engine.execute_batch(&drop_sql) {
        log::error!(
            target: "toptopduck::agent_loop",
            "ghost rollback of {ghost} failed: {e}; leaving result_{prev_next} \
             registered so next_result_number skips it -- delete manually"
        );
        return;
    }
    deps.working_set.remove(&ghost);
}

/// The mutable per-turn outputs [`execute_call`] accumulates: the round-
/// grouped trace (ADR-0078, grouped per ADR-0103) and the promotion list
/// (ADR-0022). Bundled into one struct so [`execute_call`] stays under
/// clippy's argument-count threshold and the two always-coupled accumulators
/// move together.
struct CallOutputs {
    rounds: Vec<LoopRound>,
    promotions: Vec<Promotion>,
}

impl CallOutputs {
    /// Record one completed call on the CURRENT round. The loop opens a
    /// round before dispatching its batch, so the last round is the current
    /// one; the fallback folds a call that arrives with no open round
    /// (structurally unreachable from the loop -- every dispatch site runs
    /// after the round push) into a fresh one so no trace entry is dropped.
    fn push_call(&mut self, entry: TraceEntry) {
        match self.rounds.last_mut() {
            Some(round) => round.calls.push(entry),
            None => self.rounds.push(LoopRound::flat(vec![entry])),
        }
    }
}

/// One round's in-memory trace accumulation (ADR-0103, issue #608): the
/// optional thinking + connective prose of one provider round-trip plus that
/// round's tool calls, in the in-memory [`TraceEntry`] form (still carrying
/// `tool_use_id` + the success payload -- the loop's own context; the
/// persisted / IPC projections drop both via `reduced_trace`). The
/// round-grouped counterpart of [`TraceEntry`]: `outcome` bundles these into
/// [`LoopOutcome::trace`], and the wiring seam maps them onto the
/// `TraceRound` view + the persisted recipe round.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopRound {
    /// The round's thinking block (ADR-0103, issue #614): the readable text
    /// the built-in runtime's provider round produced, `None` when the turn
    /// ran thinking-disabled (no posture level) or every block was redacted.
    pub thinking: Option<ThinkingTrace>,
    /// The round's connective prose (text the model emitted alongside its
    /// tool-call batch), `None` when the reply carried tool calls and no
    /// text.
    pub text: Option<String>,
    /// The round's tool calls, dispatch order.
    pub calls: Vec<TraceEntry>,
}

impl LoopRound {
    /// A round carrying only calls -- the flat-trajectory wrap the
    /// stream-format adapters (claude / codex) and the wiring merge emit
    /// (ADR-0103, issue #608): no prose, no thinking, ONE round for the
    /// whole call list. The ACP-native engine groups its own rounds at the
    /// tool-call batch boundary (issue #611); the remaining flat paths
    /// funnel through here until their grouping slices land, so the wrap
    /// shape (and its rationale) lives once.
    pub fn flat(calls: Vec<TraceEntry>) -> Self {
        Self {
            thinking: None,
            text: None,
            calls,
        }
    }

    /// Wrap a flat call trajectory into the round-grouped trace form: ONE
    /// [`LoopRound::flat`] round when the trajectory is non-empty, an EMPTY
    /// round list when it is empty (ADR-0103, issue #608). The
    /// empty-stays-empty rule matches the v4->v5 migration (`[]` never
    /// becomes a round with no calls) and the built-in loop (a zero-call
    /// turn records no round), so a zero-call turn's trace is `[]` on every
    /// runtime path -- no ghost round persisted as `[{}]`.
    pub fn flat_wrap(calls: Vec<TraceEntry>) -> Vec<Self> {
        if calls.is_empty() {
            Vec::new()
        } else {
            vec![Self::flat(calls)]
        }
    }
}

/// The approval-gateway context [`execute_call`] routes every call through
/// (ADR-0080): the session's gate state + the event sink + the cancel token
/// the gate suspends on. Bundled (like [`CallOutputs`]) so the call
/// signature stays under clippy's argument-count threshold now that the
/// ADR-0078 event emitter rides it too.
struct GateCtx<'a> {
    approval: &'a ApprovalState,
    sink: &'a dyn ApprovalSink,
    cancel: &'a CancelToken,
}

/// Drive one tool call through the gateway + dispatch, append a trace entry,
/// and capture any promotion. Returns the [`ToolResult`] to feed back to the
/// model, or [`GateCancelled`] if the approval gate was cancelled mid-call.
///
/// Emits the ADR-0078 tool-call event stream through `on_phase`:
/// `ToolCallStarted` right before dispatch (AFTER the gate, so a gated call
/// has already surfaced its `approval-request` card) and `ToolCallCompleted`
/// once the call lands -- for both a dispatched call and a gate denial (which
/// completes `success: false` without ever starting). The completed payload
/// mirrors the persisted trace shape (success excerpt emptied) so the live
/// row and the recorded [`TurnRecord::trace`] entry render identically.
///
/// A tool-level error (dispatch `is_error`, or a gateway [`GateOutcome::Denied`])
/// is NOT a turn failure -- it routes back to the model as a `ToolResult` with
/// `is_error = true` so the agent can self-correct (ADR-0077). Only a
/// gate-cancel ends the turn.
// 8 params mirrors run_external_turn's documented exception: each is a
// distinct dispatch collaborator (call, deps, materializer, mcp, cli, gate,
// outputs, on_phase) and bundling any two would blur ownership for callers
// that thread them separately.
#[allow(clippy::too_many_arguments)]
fn execute_call(
    call: &ToolUse,
    deps: &mut TurnDeps,
    materializer: &mut dyn Materializer,
    mcp: &mut McpAggregator,
    cli: &[crate::cli_tools::config::CliToolConfig],
    gate: &GateCtx<'_>,
    outputs: &mut CallOutputs,
    on_phase: &mut impl FnMut(TurnPhase),
) -> Result<ToolResult, GateCancelled> {
    // Meta-tool trio dispatch (ADR-0105): the classification -- list / search
    // run locally against the aggregator's catalog (read-only, short of the
    // gate -- the built-in read tools' trust shape); mcp_invoke resolves its
    // handle BEFORE the enforcement points and falls through under the
    // backend identity, so the gate / trace never see "mcp_invoke"; a
    // resolution / parse / direct-handle failure is the call's own error
    // result with no phase events and no trace entry -- the same semantics as
    // a call that never reached a tool. All of that lives in the shared
    // `meta_tools::resolve_meta_call` (issue #663 review); this site maps
    // each variant onto the loop's `ToolResult` shape.
    let resolved;
    let call: &ToolUse = match meta_tools::resolve_meta_call(mcp, call) {
        meta_tools::MetaDispatch::Local { summary, payload } => {
            return Ok(local_meta_call(call, &summary, payload, outputs, on_phase));
        }
        meta_tools::MetaDispatch::Refused(message) => return Ok(meta_failure(call, &message)),
        meta_tools::MetaDispatch::Resolved(replacement) => {
            resolved = replacement;
            &resolved
        }
        meta_tools::MetaDispatch::Fallthrough(call) => call,
    };
    // A registered CLI tool classifies under its own reserved server
    // (ADR-0108 Decision 7): the trust key is the registration name, the
    // badge is Execute, and the summary renders the full argv the approval
    // card shows (the approver signs exactly what will run).
    let cli_tool = cli.iter().find(|t| t.name == call.name);
    let (key, operation_kind, summary, file_attachments) = match cli_tool {
        Some(tool) => classify_cli_tool(tool, &call.input, deps.temp_path, &call.id),
        None => {
            let (key, operation_kind, summary) = classify_call(call);
            (key, operation_kind, summary, Vec::new())
        }
    };
    let gate_req = ApprovalRequest {
        key,
        operation_kind,
        summary: summary.clone(),
        file_attachments,
    };
    // ADR-0080: every tool call passes the gate before dispatch. Built-in tools
    // classify Allow (zero approval); external tools would suspend here.
    match gate.approval.gate(gate_req, gate.sink, gate.cancel) {
        Err(GateCancelled) => return Err(GateCancelled),
        Ok(GateOutcome::Denied) => {
            // A denial is a tool-level error the agent can self-correct from
            // (ADR-0077) -- e.g. retry without the denied tool, or surface it
            // to the user. The denied call never dispatches, so only the
            // completion event fires (success: false) -- the frontend's
            // pending approval card flips to its resolved-deny row in place.
            let entry = TraceEntry {
                tool_use_id: call.id.clone(),
                name: call.name.clone(),
                operation_kind,
                summary,
                success: false,
                result_excerpt: "denied by approval gateway".to_string(),
            };
            // The completed event carries the persisted-shape view (a failure
            // keeps its message -- here the denial -- so the resolved card
            // and the recorded trace show the same why).
            on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
            outputs.push_call(entry);
            return Ok(ToolResult {
                tool_use_id: call.id.clone(),
                content: "tool call denied by the approval gateway".to_string(),
                is_error: true,
            });
        }
        Ok(GateOutcome::Allow) => {}
    }
    // ADR-0078: the started event fires post-gate so a suspended approval card
    // is never doubled by a "running" row -- the card flips to resolved (via
    // the gateway's approval-resolved event) and only then does the call show
    // as running. The summary matches the approval card's (both come from
    // classify_call) so the frontend merges the two into one row.
    on_phase(TurnPhase::ToolCallStarted {
        name: call.name.clone(),
        operation_kind,
        summary: summary.clone(),
    });
    // ADR-0076 (slice C-loop) + ADR-0105 Decision 4: route by name shape. A
    // namespaced `mcp__<slug>__<tool>` name goes to the matching external
    // MCP server via the aggregator (the prefix is stripped server-side); a
    // bare name goes to the built-in DuckDB executor. Under the discovery
    // surface the namespaced arm is reached only via the `mcp_invoke`
    // fall-through above (a directly-emitted handle was already refused in
    // the trio match), so this dispatch stays the single external execution
    // point.
    // Both surface the outcome as the typed channel (issue #336): the
    // model-facing `result` (JSON payload on success or an error string on
    // failure -- both feed back to the model; the agent self-corrects on an
    // error) plus the side effect the executor reported. The external path
    // never promotes (external tools do not materialize a working-set
    // result), so `promotion` is always `None` there.
    let outcome = if aggregator::is_namespaced(&call.name) {
        let tool_output_dir = deps.temp_path.join(super::TOOL_OUTPUT_DIR_NAME);
        route_external_call(call, mcp, &tool_output_dir)
    } else if let Some(tool) = cli_tool {
        // The registered-CLI dispatch arm (issue #671, ADR-0108 Decision 3):
        // direct argv spawn, cwd = the session's work temp dir, cancel = the
        // turn's shared token (process-tree termination on round cancel).
        crate::cli_tools::executor::execute(tool, call, deps.temp_path, gate.cancel)
    } else {
        tools::dispatch(call, deps, gate.cancel, materializer)
    };
    let result = outcome.result;
    // ADR-0077: a tool-level error routes back to the model. Log it so a
    // non-converging turn (StepCap) leaves an operator-visible trail of what
    // the model was being told, not just the final cap.
    if result.is_error {
        log::debug!(
            target: "toptopduck::agent_loop",
            "tool `{}` returned an error (routing back for self-correction): {}",
            call.name,
            truncate(&result.content, 200)
        );
    }
    let success = !result.is_error;
    // The executor reports a promotion through the side-effect channel iff one
    // landed (today, only `materialize` produces one, and only on success --
    // the executor builds it from the typed sql + descriptor, so there is no
    // "success but no promotion" contract violation to guard). The loop is
    // tool-agnostic: it pushes `outcome.promotion` without naming any tool
    // (issue #336).
    if let Some(promotion) = outcome.promotion {
        outputs.promotions.push(promotion);
    }
    let entry = TraceEntry {
        tool_use_id: call.id.clone(),
        name: call.name.clone(),
        operation_kind,
        summary,
        success,
        result_excerpt: truncate(&result.content, TRACE_EXCERPT_MAX),
    };
    // ADR-0078: complete the live row with the persisted-shape view (success
    // excerpt emptied -- see TraceEntryView's mapping below), paired with the
    // ToolCallStarted emitted pre-dispatch.
    on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
    outputs.push_call(entry);
    Ok(result)
}

/// Serve one locally-executed meta-tool (`mcp_list_servers` /
/// `mcp_search_tools`) on the built-in path (ADR-0105). The catalog payload
/// flattens to the model-facing content string (`ToolResult.content` is a
/// flat String on this path), with the standard started / completed phase
/// pair + trace entry so a meta-tool call renders like any other call. These
/// never touch a backend server, so there is no gate suspension (catalog
/// reads carry the built-in read tools' trust shape).
fn local_meta_call(
    call: &ToolUse,
    summary: &str,
    payload: serde_json::Value,
    outputs: &mut CallOutputs,
    on_phase: &mut impl FnMut(TurnPhase),
) -> ToolResult {
    on_phase(TurnPhase::ToolCallStarted {
        name: call.name.clone(),
        operation_kind: OperationKind::Read,
        summary: summary.to_string(),
    });
    let entry = TraceEntry {
        tool_use_id: call.id.clone(),
        name: call.name.clone(),
        operation_kind: OperationKind::Read,
        summary: summary.to_string(),
        success: true,
        // A success is emptied at the persisted mapping; the in-memory form
        // keeps nothing here either -- the payload itself rides the result.
        result_excerpt: String::new(),
    };
    on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
    outputs.push_call(entry);
    ToolResult {
        tool_use_id: call.id.clone(),
        content: payload.to_string(),
        is_error: false,
    }
}

/// A meta-tool resolution failure (a malformed `mcp_search_tools` input, or
/// an `mcp_invoke` handle that did not resolve): the call's own error result
/// the agent self-corrects from (ADR-0077), with NO phase events and NO
/// trace entry (ADR-0105 Decision 4 -- the call never reached a tool).
fn meta_failure(call: &ToolUse, message: &str) -> ToolResult {
    ToolResult {
        tool_use_id: call.id.clone(),
        content: message.to_string(),
        is_error: true,
    }
}

/// Classify a tool call for the approval gateway + the trace: the [`ToolKey`]
/// (built-in vs external server), the [`OperationKind`] badge (ADR-0083), and a
/// short agent-readable summary of the arguments. Built-in tools classify from
/// the single metadata table ([`definitions::builtin_metadata`], issue #336) --
/// no tool-name literal `match` here, so adding a built-in tool is one entry in
/// `builtin_tools`, not a parallel edit to this function. An unknown name falls
/// through to the external arm (the gateway surfaces the approval card for it).
/// Hard cap on the external-call argument preview inside the approval
/// summary (issue #661; cap added by the #663 review): sized so the preview
/// plus its ``external tool `name` with `` frame stays inside the card-body
/// budget ([`crate::approval::SUMMARY_MAX_CHARS`]) -- deliberately larger
/// than the 120-char trace cap so a realistic payload previews its head on
/// the card instead of degrading to a bare JSON fragment the approver cannot
/// read.
const ARGS_PREVIEW_MAX_CHARS: usize = 448;

/// The approval-gateway classification for a registered CLI tool call
/// (ADR-0108 Decision 7): the trust key anchors on the registration name
/// under the reserved `CLI` server, the badge is Execute, and the summary
/// is the card's full-argv rendering. `temp_dir` + `call_id` drive the same
/// deterministic temp paths the execution later renders (issue #672), so
/// the argv the approver signs is exactly the one that runs; the
/// file-delivery values ride along as expandable attachments (ADR-0109
/// Decision 8), captured NOW -- the temp file is deleted when the call
/// ends, so the payload snapshot is the approver's only durable view.
fn classify_cli_tool(
    tool: &crate::cli_tools::config::CliToolConfig,
    input: &Value,
    temp_dir: &Path,
    call_id: &str,
) -> (
    ToolKey,
    OperationKind,
    String,
    Vec<crate::approval::FileAttachment>,
) {
    let summary_and_files = |rendered: crate::cli_tools::config::RenderedCall| {
        let mut argv = Vec::with_capacity(rendered.argv.len() + 1);
        argv.push(tool.executable.clone());
        argv.extend(rendered.argv.iter().cloned());
        let attachments = rendered
            .files
            .into_iter()
            .map(|f| crate::approval::FileAttachment {
                param: f.param,
                content: f.content,
            })
            .collect();
        (
            crate::approval::truncate_summary(&argv.join(" "), ARGS_PREVIEW_MAX_CHARS),
            attachments,
        )
    };
    let (summary, file_attachments) =
        match crate::cli_tools::config::render_call(tool, input, temp_dir, call_id) {
            Ok(rendered) => summary_and_files(rendered),
            // Rendering can fail on a mis-shaped call (a missing parameter);
            // the summary then degrades to naming the failure honestly
            // rather than showing an argv that is NOT what would run.
            Err(detail) => (
                format!("cli tool `{}` argv unavailable: {detail}", tool.name),
                Vec::new(),
            ),
        };
    (
        ToolKey::external(ToolKey::CLI_SERVER, tool.name.clone()),
        OperationKind::Execute,
        summary,
        file_attachments,
    )
}

pub(crate) fn classify_call(call: &ToolUse) -> (ToolKey, OperationKind, String) {
    match definitions::builtin_metadata(&call.name) {
        Some(spec) => (
            ToolKey::builtin(spec.definition.name.as_str()),
            spec.operation_kind,
            summarize_field(&call.input, spec.summary_field, spec.summary_fallback),
        ),
        None => {
            // External arm (issue #301 slice C-loop): a namespaced
            // `mcp__<slug>__<tool>` name resolves the server slug for the
            // approval key + trace so a card / row names the real server; a
            // bare unknown name keeps the "unknown" server. Either way the
            // call badges Network.
            //
            // Issue #312: `try_external` rejects the reserved `"builtin"`
            // server name. A malicious model can spoof `mcp__builtin__*`; we
            // never panic (untrusted input) — the spoof falls back to
            // `RESERVED_SPOOF_SERVER` so classify returns `NeedsApproval`
            // (card surfaces) and routing finds no server (graceful failure).
            let other = call.name.as_str();
            let server = aggregator::parse_namespaced(other)
                .map(|(slug, _)| slug)
                .unwrap_or_else(|| "unknown".to_string());
            let key = match ToolKey::try_external(server, other.to_string()) {
                Ok(k) => k,
                Err(_) => {
                    log::warn!(
                        target: "toptopduck::agent_loop",
                        "model emitted tool name `{other}` resolving to reserved \
                         `builtin` server; routing to RESERVED_SPOOF sentinel so \
                         the gate surfaces a card"
                    );
                    ToolKey::external(ToolKey::RESERVED_SPOOF_SERVER, other)
                }
            };
            // The summary carries the call's arguments (issue #661): the
            // approval card's `summary` field is designed for a parameter
            // digest, and a handle-only card makes the user blind-sign
            // whatever the external server is about to receive. The input is
            // compact-JSON'd under the argument-preview cap (issue #663
            // review); the emit-side `truncate_summary` cap backstops the IPC
            // broadcast.
            let summary = format!(
                "external tool `{other}` with {}",
                crate::approval::truncate_summary(&call.input.to_string(), ARGS_PREVIEW_MAX_CHARS)
            );
            (key, OperationKind::Network, summary)
        }
    }
}

/// Route a namespaced external MCP call through the aggregator and shape the
/// outcome the loop consumes (issue #301 slice C-loop; unlike the gateway's
/// `external_call_outcome`, this path flattens the envelope -- see
/// `aggregator::first_text_block` for the asymmetry). The aggregator strips
/// the `mcp__<slug>__` prefix and forwards the native tool name + arguments
/// to the matching server; the server's envelope is relayed as the
/// model-facing `content` string (the first text block --
/// `ToolResult.content` is a flat string on this path, so a multi-block or
/// non-text result reduces to its first text block, with a placeholder when
/// there is none). A route failure (UnknownServer / Client fault) becomes a
/// tool error the agent self-corrects from (ADR-0077). No promotion:
/// external tools never materialize a working-set result.
fn route_external_call(
    call: &ToolUse,
    mcp: &mut McpAggregator,
    tool_output_dir: &Path,
) -> tools::ToolOutcome {
    shape_external_outcome(mcp.route(&call.name, &call.input), call, tool_output_dir)
}

/// Reduce a routed external MCP call's `Result` to the loop's `ToolOutcome`
/// (issue #301 slice C-loop). Split from [`route_external_call`] so the
/// envelope-shaping contract is unit-testable without a live server: a
/// successful envelope flattens to its first text block + the server's
/// `isError` flag (defaulting to `false` per the MCP spec -- a conformant
/// server omits it on success); a server-side error envelope keeps the text
/// (the model self-corrects, ADR-0077) but marks `is_error = true`; a route
/// failure becomes a tool error naming the tool. No promotion in any branch
/// (external tools never materialize a working-set result).
fn shape_external_outcome(
    route_result: Result<Value, RouteError>,
    call: &ToolUse,
    tool_output_dir: &Path,
) -> tools::ToolOutcome {
    let (content, is_error) = match route_result {
        Ok(envelope) => {
            let is_error = envelope
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let text = aggregator::first_text_block(&envelope);
            // Issue #442: on a success envelope, structured inline text is
            // materialized to tool_output/ (ADR-0087 D3/D4). An error's text
            // is a message, not data.
            let content = if is_error {
                text
            } else {
                inline_materialize::augment_with_hint(text, &call.id, tool_output_dir)
            };
            (content, is_error)
        }
        Err(e) => (format!("external tool `{}` failed: {}", call.name, e), true),
    };
    tools::ToolOutcome {
        result: ToolResult {
            tool_use_id: call.id.clone(),
            content,
            is_error,
        },
        promotion: None,
    }
}

/// Render one `input` field as the call summary, truncated. Falls back to
/// `fallback` when the field is absent (a mis-shaped call the executor will
/// itself refuse -- the summary is best-effort). Shared by the `sql`- and
/// `reference_name`-keyed tools so the truncation + fallback shape has one
/// source rather than one near-duplicate per field. The truncation cap +
/// helper live in `persistence::recipe` ([`truncate_trace_summary`]) so a
/// synthetic single-call trace and a live `materialize` summary match.
fn summarize_field(input: &Value, field: &str, fallback: &str) -> String {
    let value = input.get(field).and_then(Value::as_str).unwrap_or(fallback);
    truncate_trace_summary(value)
}

/// Truncate a string to `max` chars, appending an ellipsis when it was cut.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max.saturating_sub(1)).collect();
        format!("{head}…")
    }
}

/// Shared trace-excerpt truncation (ADR-0078). Exposed `pub(crate)` so the ACP
/// adapter engine ([`crate::runtime::acp`], ADR-0081) bounds a tool-call's
/// result excerpt with the SAME rule the built-in loop uses -- a trace row
/// from either runtime renders identically (the badge + the failure anchor are
/// the cross-runtime trace contract).
pub(crate) fn truncate_trace_excerpt(s: &str, max: usize) -> String {
    truncate(s, max)
}

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/// Why the loop terminated (ADR-0081). Maps onto the four-way `TurnOutcome`
/// (ADR-0028) at the wiring seam; kept as a distinct enum here so the loop is
/// unit-testable without committing to `TurnOutcome`'s single-promotion shape
/// (ADR-0084 carries the full promotion chain; ADR-0078 carries the trace).
#[derive(Debug, Clone, PartialEq)]
pub enum Termination {
    /// The model emitted a terminal text reply. Carries the verbatim text.
    /// Maps to `TurnOutcome::Textual` when the turn had no promotion, or
    /// `TurnOutcome::Materialized` when it also promoted >=1 result (the text
    /// rides as the assumption / side note).
    Text(String),
    /// The step cap was reached without a terminal reply (the agent did not
    /// converge). Carries the cap value so the wiring seam can render an honest
    /// "did not converge in N steps" detail. Maps to `TurnOutcome::Failed`
    /// (ADR-0081 execution-level cap).
    StepCap(u32),
    /// A cancel (user / close / wall-clock watchdog) aborted the turn
    /// (ADR-0021). Maps to `TurnOutcome::Cancelled`. The watchdog is one cause
    /// among several; it shares the cancel path (ADR-0021 timeout -> cancel).
    Cancelled,
    /// No LLM provider is wired / the key was refused (ADR-0044 permanent).
    /// Maps to `TurnOutcome::Failed(NotWired)`.
    NotWired,
    /// The provider configuration is permanently invalid (ADR-0044, e.g. a bad
    /// base_url scheme). Maps to `TurnOutcome::Failed(InvalidConfig)`.
    InvalidConfig(String),
    /// A transient provider fault surfaced after the adapter's own HTTP retry
    /// exhausted (ADR-0077/0081). Maps to `TurnOutcome::Failed(Execute)`.
    Transient(String),
}

/// One entry in the execution trace (ADR-0078). The trace is the persisted,
/// collapsible substructure of a turn; the far window carries only a summary
/// (call count + failure summary), never the full trace verbatim. Mapped to
/// its persisted recipe form ([`RecipeTraceEntry`]) when the turn is recorded
/// (issue #319) -- the mapping drops the ephemeral [`tool_use_id`](Self::tool_use_id).
#[derive(Debug, Clone, PartialEq)]
pub struct TraceEntry {
    pub tool_use_id: String,
    pub name: String,
    pub operation_kind: OperationKind,
    /// Short argument summary (the SQL or reference_name), NOT the full args.
    pub summary: String,
    pub success: bool,
    /// Bounded excerpt of the tool result content (or the denial / error
    /// message), captured for BOTH success and failure at dispatch time. Only
    /// the FAILED-call excerpt survives the persisted mapping (a success is
    /// emptied -- see [`RecipeTraceEntry::result_excerpt`]); the in-memory
    /// form keeps the success payload for the loop's own next-turn context.
    pub result_excerpt: String,
}

/// Project an in-memory [`TraceEntry`] to its reduced form (ADR-0078): the
/// per-provider `tool_use_id` is gone and a successful call's data-bearing
/// excerpt is emptied; a failed call keeps its bounded message. ONE mapping
/// feeds the persisted [`RecipeTraceEntry`], the display [`TraceEntryView`],
/// and the live `turn-progress` event -- a live row, the recorded trace, and
/// the resumed trace all render the same. The failure-message guard (issue
/// #316) fires once here for both projections: the excerpt is the cross-turn
/// retrospection anchor, so a silent failure panics in debug builds rather
/// than persisting an empty anchor.
fn reduced_trace(entry: &TraceEntry) -> TraceEntryView {
    debug_assert!(
        entry.success || !entry.result_excerpt.is_empty(),
        "a failed trace entry keeps its result message (ADR-0078 failure anchor)"
    );
    TraceEntryView {
        name: entry.name.clone(),
        operation_kind: entry.operation_kind,
        summary: entry.summary.clone(),
        success: entry.success,
        result_excerpt: if entry.success {
            String::new()
        } else {
            entry.result_excerpt.clone()
        },
    }
}

impl RecipeTraceRound {
    /// Map a live in-memory [`LoopRound`] to its persisted recipe form
    /// (ADR-0103, issue #608): the thinking block + connective prose carry
    /// verbatim (no lossy projection -- neither has a `tool_use_id` to drop
    /// or a success payload to empty), and each call maps through
    /// [`RecipeTraceEntry::from_live_trace`]. Named (not `From`) to match
    /// `from_live_trace`'s explicit-lossy-projection convention. Takes the
    /// round by value: the audit is the rounds' last consumer, so the
    /// unbounded thinking/prose texts move instead of cloning (issue #617).
    pub(crate) fn from_live_round(round: LoopRound) -> Self {
        Self {
            thinking: round.thinking,
            text: round.text,
            calls: round
                .calls
                .into_iter()
                .map(|entry| RecipeTraceEntry::from_live_trace(&entry))
                .collect(),
        }
    }
}

impl RecipeTraceEntry {
    /// Map a live in-memory [`TraceEntry`] to its persisted recipe form
    /// (ADR-0078, issue #319): the reduced projection (drop the in-memory
    /// `tool_use_id`, empty a success call's excerpt, keep a failure's message)
    /// is the persisted shape verbatim -- the surviving strings stay bounded at
    /// capture time (`summarize_field` / `TRACE_EXCERPT_MAX`), so no
    /// re-truncation. Named (not `From`) to make the lossy + conditional
    /// projection explicit at the call site (issue #325).
    pub(crate) fn from_live_trace(entry: &TraceEntry) -> Self {
        let v = reduced_trace(entry);
        Self {
            name: v.name,
            operation_kind: v.operation_kind,
            summary: v.summary,
            success: v.success,
            result_excerpt: v.result_excerpt,
        }
    }
}

impl From<&TraceEntry> for TraceEntryView {
    /// The display-trace mapping (ADR-0078, issue #297): the reduced projection
    /// feeds both the live `turn-progress` event and the `TurnRecord::trace`
    /// wire form, so a live row and the resumed trace render identically.
    fn from(entry: &TraceEntry) -> Self {
        reduced_trace(entry)
    }
}

impl From<&LoopRound> for TraceRound {
    /// The round-level display mapping (ADR-0103, issue #608): the live
    /// round projects onto the IPC view beside the entry-level mapping
    /// above, so `record_turn`'s trace view and the loop's recorded rounds
    /// stay field-identical.
    fn from(round: &LoopRound) -> Self {
        Self {
            thinking: round.thinking.clone(),
            text: round.text.clone(),
            calls: round.calls.iter().map(TraceEntryView::from).collect(),
        }
    }
}

/// The structured outcome the agent loop returns. Pure data -- the wiring seam
/// ([`crate::session::Session::ask_with_phase`], issue #318) maps the four-way
/// termination + promotions onto `TurnOutcome`, and carries the trace
/// alongside to the turn's persisted audit (issue #319, ADR-0078).
#[derive(Debug, Clone)]
pub struct LoopOutcome {
    pub termination: Termination,
    /// Promotions this turn, in promotion order (each successful `materialize`
    /// call). ADR-0022 monotonic numbering applies (result_1, result_2, ...);
    /// a turn with several promotions records the LAST as the turn's primary
    /// result at the wiring seam.
    pub promotions: Vec<Promotion>,
    /// The full round-grouped execution trace (ADR-0078, grouped per
    /// ADR-0103, issue #608): one [`LoopRound`] per provider round-trip.
    /// Collapsible; never enters the far window verbatim -- only its summary
    /// (call count + failure summary) does. The wiring seam persists it on
    /// the turn's recipe entry (issue #319): the real multi-round trajectory,
    /// mapped to [`crate::persistence::recipe::RecipeTraceRound`].
    pub trace: Vec<LoopRound>,
    /// Count of provider round-trips executed (one per `generate_tool_turn`).
    /// A loop-diagnostic surface (the loop tests assert it); NOT persisted --
    /// the trace entries already tell the trajectory (ADR-0078, issue #319).
    #[allow(dead_code)]
    pub round_trips: u32,
    /// The external runtime's discovered model / thought-level catalog
    /// (ADR-0095). `Some` only on the ACP path (handshake config_options
    /// extraction); the built-in loop and the CodexEventStream path have no
    /// discovery and carry `None` (the ClaudeStreamJson path reports the
    /// `system{init}` current model, ADR-0097) -- the Option distinguishes
    /// "this runtime does not support discovery" from "discovery found
    /// nothing".
    pub discovered_runtime: Option<crate::runtime::acp::adapter::DiscoveredRuntime>,
}

#[cfg(test)]
mod tests {
    //! Agent-loop termination branches (ADR-0081, issue #295). Each test
    //! scripts a precise trajectory via `FakeProvider::scripted_tool_turn_seq`
    //! and asserts the [`LoopOutcome`] -- termination + promotions + trace +
    //! round-trip count. No `Session`, no IPC; the real materializer + an
    //! in-memory DuckDB connection stand in for the engine.

    use super::*;
    use crate::approval::ApprovalResponse;
    use crate::guardrail::ExecError;
    use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
    use crate::provider::fake::FakeProvider;
    use crate::provider::prompt::ResponseLocale;
    use crate::provider::tool_calling::ToolTurnMessage;
    use crate::provider::{ProviderReply, ProviderRequest};
    use crate::session::engine::AdminEngine;
    use crate::session::materializer::RealMaterializer;
    use crate::tools::builtin_table;
    use crate::workingset::WorkingSet;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// A recording approval sink (mirrors the one in approval.rs's tests). The
    /// loop threads it so the gateway can emit approval events; built-in tools
    /// never reach the sink (they classify Allow before emitting). `request_ids`
    /// captures the UUIDs a concurrent responder threads back via
    /// `ApprovalState::respond` to drive the gate-deny path (ADR-0078).
    #[derive(Default)]
    struct RecordingSink {
        requests: Mutex<Vec<String>>,
        request_ids: Mutex<Vec<uuid::Uuid>>,
    }
    impl ApprovalSink for RecordingSink {
        fn emit_request(&self, body: &crate::approval::ApprovalRequestBody) {
            self.requests.lock().unwrap().push(body.summary.clone());
            // body.request_id is a String; parse to the Uuid respond() takes.
            if let Ok(id) = uuid::Uuid::parse_str(&body.request_id) {
                self.request_ids.lock().unwrap().push(id);
            }
        }
        fn emit_resolved(
            &self,
            _body: &crate::approval::ApprovalRequestBody,
            _response: ApprovalResponse,
        ) {
        }
    }

    /// Poll the sink for the first emitted request id (the gate-deny test's
    /// responder waits on this before answering Deny). Uses wall-clock sleep
    /// polling (approval.rs's equivalent switched to condvar, but this local
    /// sink predates that and the cost of porting is not justified here).
    fn poll_request_id(sink: &RecordingSink, timeout: std::time::Duration) -> Option<uuid::Uuid> {
        let start = std::time::Instant::now();
        loop {
            if let Some(id) = sink.request_ids.lock().unwrap().first().copied() {
                return Some(id);
            }
            if start.elapsed() >= timeout {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    /// A route failure (unknown slug) surfaces as a tool error the agent
    /// self-corrects from (ADR-0077) -- not a turn failure. The error names
    /// the slug so the model gets actionable feedback.
    #[test]
    fn a_registered_cli_tool_classifies_under_the_cli_server_with_execute_badge() {
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
            name: "pandoc".into(),
            description: "convert".into(),
            executable: "/bin/pandoc".into(),
            argv_template: vec!["-o".into(), "{output}".into()],
            params: vec![CliToolParam {
                name: "output".into(),
                description: "target".into(),
                delivery: CliParamDelivery::Argv,
                varargs: false,
            }],
            env: Default::default(),
            enabled: true,
            source: Default::default(),
            baseline: None,
        };
        let (key, kind, summary, attachments) = classify_cli_tool(
            &tool,
            &serde_json::json!({"output": "out.pdf"}),
            std::path::Path::new("/tmp"),
            "tu_1",
        );
        assert_eq!(key.server, ToolKey::CLI_SERVER);
        assert_eq!(key.tool, "pandoc");
        assert_eq!(kind, OperationKind::Execute);
        // ADR-0108 Decision 7: the card renders the complete argv that will
        // run -- the executable plus the rendered template.
        assert_eq!(summary, "/bin/pandoc -o out.pdf");
        assert!(attachments.is_empty(), "no file delivery, no attachments");
    }

    #[test]
    fn a_file_delivery_cli_call_carries_its_value_as_an_approval_attachment() {
        // Issue #672, ADR-0109 Decision 8: the argv shows the deterministic
        // temp path (captured before any file exists -- a denial leaves
        // nothing on disk), and the value itself rides the request as the
        // approver's expandable snapshot.
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
            name: "code-runner".into(),
            description: "runs code".into(),
            executable: "/bin/py".into(),
            argv_template: vec!["{code}".into()],
            params: vec![CliToolParam {
                name: "code".into(),
                description: "source".into(),
                delivery: CliParamDelivery::File,
                varargs: false,
            }],
            env: Default::default(),
            enabled: true,
            source: Default::default(),
            baseline: None,
        };
        let (_, _, summary, attachments) = classify_cli_tool(
            &tool,
            &serde_json::json!({"code": "print(1)"}),
            std::path::Path::new("/session/tmp"),
            "tu_7",
        );
        assert!(
            summary
                .replace('\\', "/")
                .ends_with("/cli-code-runner-code-tu_7.tmp"),
            "the argv carries the temp path, not the value: {summary}"
        );
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].param, "code");
        assert_eq!(attachments[0].content, "print(1)");
    }

    #[test]
    fn cli_summary_degrades_honestly_when_the_argv_cannot_render() {
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
            name: "pandoc".into(),
            description: "convert".into(),
            executable: "/bin/pandoc".into(),
            argv_template: vec!["{output}".into()],
            params: vec![CliToolParam {
                name: "output".into(),
                description: "target".into(),
                delivery: CliParamDelivery::Argv,
                varargs: false,
            }],
            env: Default::default(),
            enabled: true,
            source: Default::default(),
            baseline: None,
        };
        let (_, _, summary, _) = classify_cli_tool(
            &tool,
            &serde_json::json!({}),
            std::path::Path::new("/tmp"),
            "tu_1",
        );
        assert!(
            summary.contains("argv unavailable"),
            "a missing parameter names the failure: {summary}"
        );
    }

    #[test]
    fn route_external_call_surfaces_an_unknown_slug_as_a_tool_error() {
        let mut mcp = McpAggregator::empty();
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_1".into(),
            name: "mcp__ghost__echo".into(),
            input: serde_json::json!({}),
        };
        let outcome = route_external_call(&call, &mut mcp, dir.path());
        assert!(outcome.result.is_error, "unknown slug is a tool error");
        assert!(
            outcome.result.content.contains("ghost"),
            "error names the slug: {}",
            outcome.result.content
        );
        assert!(outcome.promotion.is_none());
    }

    /// A successful route flattens the envelope to its first text block and
    /// keeps the server's `isError: false` (issue #301 slice C-loop). Split
    /// from `route_external_call` so the shaping contract is unit-testable
    /// without a live server.
    #[test]
    fn shape_external_outcome_flattens_a_success_envelope() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_ok".into(),
            name: "mcp__github__search".into(),
            input: serde_json::json!({}),
        };
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": "5 rows"}],
            "isError": false,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(!outcome.result.is_error, "isError:false -> success");
        assert_eq!(outcome.result.content, "5 rows");
        assert_eq!(outcome.result.tool_use_id, "tu_ok");
        assert!(outcome.promotion.is_none(), "external tools never promote");
    }

    /// A server-side error envelope (`isError: true`) keeps the text block
    /// (the model self-corrects, ADR-0077) but marks the result as an error.
    #[test]
    fn shape_external_outcome_marks_a_server_side_error_envelope() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_err".into(),
            name: "mcp__github__search".into(),
            input: serde_json::json!({}),
        };
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": "rate limited"}],
            "isError": true,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(outcome.result.is_error, "isError:true -> tool error");
        assert_eq!(outcome.result.content, "rate limited");
        assert!(outcome.promotion.is_none());
    }

    /// A successful envelope whose inline text is structured CSV gets
    /// materialized to tool_output/ and the model-facing content includes the
    /// file path so the agent can reference it via read_csv_auto (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_csv_inline_text() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_csv".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let csv = "id,name,value\n1,alice,100\n2,bob,200\n";
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": csv}],
            "isError": false,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(!outcome.result.is_error);
        // The content carries the original CSV text plus a materialization hint.
        assert!(
            outcome
                .result
                .content
                .contains("Structured output saved to"),
            "content includes materialization hint: {}",
            outcome.result.content
        );
        assert!(
            outcome.result.content.contains("tu_csv.csv"),
            "hint names the materialized file: {}",
            outcome.result.content
        );
        // The file was written to the tool_output directory.
        let written = std::fs::read_to_string(dir.path().join("tu_csv.csv")).unwrap();
        assert_eq!(written, csv);
    }

    /// A successful envelope whose inline text is valid JSON gets materialized
    /// with a `.json` extension (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_json_inline_text() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_json".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let json = r#"[{"city":"Tokyo","pop":37},{"city":"Osaka","pop":19}]"#;
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": json}],
            "isError": false,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(!outcome.result.is_error);
        assert!(
            outcome.result.content.contains("tu_json.json"),
            "hint names the JSON file: {}",
            outcome.result.content
        );
        let written = std::fs::read_to_string(dir.path().join("tu_json.json")).unwrap();
        assert_eq!(written, json);
    }

    /// A successful envelope whose inline text is TSV gets materialized with
    /// a `.tsv` extension (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_tsv_inline_text() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_tsv".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let tsv = "id\tname\n1\talice\n2\tbob\n";
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": tsv}],
            "isError": false,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(!outcome.result.is_error);
        assert!(
            outcome.result.content.contains("tu_tsv.tsv"),
            "hint names the TSV file: {}",
            outcome.result.content
        );
        let written = std::fs::read_to_string(dir.path().join("tu_tsv.tsv")).unwrap();
        assert_eq!(written, tsv);
    }

    /// An error envelope with structured text must NOT be materialized — an
    /// error's text is a message, not data (issue #442 design decision).
    #[test]
    fn shape_external_outcome_does_not_materialize_error_envelope_with_structured_text() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_err_csv".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let csv = "id,name\n1,alice\n2,bob\n";
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": csv}],
            "isError": true,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(outcome.result.is_error);
        // No hint appended — content is the raw text only.
        assert_eq!(outcome.result.content, csv);
        // No file was written.
        assert!(dir.path().read_dir().unwrap().next().is_none());
    }

    /// A namespaced name classifies under its server slug (not "unknown") so
    /// the approval card + trace name the real server; a bare unknown name
    /// falls back to "unknown" (issue #301 slice C-loop).
    #[test]
    fn classify_call_keys_a_namespaced_name_under_its_slug() {
        let namespaced = ToolUse {
            id: "tu_1".into(),
            name: "mcp__github__search".into(),
            input: serde_json::json!({}),
        };
        let (key, kind, summary) = classify_call(&namespaced);
        assert_eq!(key, ToolKey::external("github", "mcp__github__search"));
        assert_eq!(kind, OperationKind::Network);
        assert!(summary.contains("mcp__github__search"));

        let bare = ToolUse {
            id: "tu_2".into(),
            name: "stray_tool".into(),
            input: serde_json::json!({}),
        };
        let (key, _, _) = classify_call(&bare);
        assert_eq!(key, ToolKey::external("unknown", "stray_tool"));
    }

    /// Build a minimal tool-turn request for `question` with the built-in tool
    /// table. The system prompt + max_tokens are inert for routing (the fake
    /// keys only on the first user message).
    fn request(question: &str) -> crate::provider::tool_calling::ToolTurnRequest {
        crate::provider::tool_calling::ToolTurnRequest {
            system: "sys".into(),
            messages: vec![ToolTurnMessage::user(question)],
            tools: builtin_table(),
            max_tokens: 1024,
            thought_level: None,
        }
    }

    /// A tool-call reply carrying one call.
    fn call(name: &str, input: serde_json::Value) -> ToolTurnReply {
        ToolTurnReply::tool_calls(vec![ToolUse {
            id: "tu_1".into(),
            name: name.into(),
            input,
        }])
    }

    /// A tool-call reply carrying several calls in one batch, with 1-based ids
    /// (`tu_1`, `tu_2`, ...) so each call's `ToolResult` / trace entry can be
    /// paired back to its request. The single-call [`call`] helper left the
    /// multi-call batch path -- the loop's serial dispatch plus the
    /// Assistant-turn + per-call `ToolResult` ordering -- untested.
    fn calls(items: &[(&str, serde_json::Value)]) -> ToolTurnReply {
        ToolTurnReply::tool_calls(
            items
                .iter()
                .enumerate()
                .map(|(i, (name, input))| ToolUse {
                    id: format!("tu_{}", i + 1),
                    name: (*name).into(),
                    input: input.clone(),
                })
                .collect(),
        )
    }

    /// The persisted-trace mapping contract (issue #316): a successful call's
    /// excerpt is emptied (the success payload is data-bearing -- the .duck
    /// carries none of it, ADR-0036), and a failed call carries its result
    /// message verbatim.
    #[test]
    fn persisted_trace_mapping_empties_success_and_carries_failure_messages() {
        let base = |success: bool, excerpt: &str| TraceEntry {
            tool_use_id: "tu_1".into(),
            name: "materialize".into(),
            operation_kind: OperationKind::Write,
            summary: "SELECT 1".into(),
            success,
            result_excerpt: excerpt.into(),
        };
        let ok = RecipeTraceEntry::from_live_trace(&base(true, "42 rows"));
        assert!(ok.success);
        assert!(ok.result_excerpt.is_empty(), "success payload dropped");
        let failed = RecipeTraceEntry::from_live_trace(&base(false, "no such table"));
        assert!(!failed.success);
        assert_eq!(
            failed.result_excerpt, "no such table",
            "the failure message rides verbatim"
        );
    }

    /// The display-trace mapping (issue #297) mirrors the persisted one: the
    /// success payload is dropped, the failure message rides verbatim -- a
    /// live row and the resumed trace render identically.
    #[test]
    fn display_trace_mapping_empties_success_and_carries_failure_messages() {
        let base = |success: bool, excerpt: &str| TraceEntry {
            tool_use_id: "tu_1".into(),
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1".into(),
            success,
            result_excerpt: excerpt.into(),
        };
        let ok = TraceEntryView::from(&base(true, "42 rows"));
        assert!(ok.success);
        assert!(ok.result_excerpt.is_empty(), "success payload dropped");
        let failed = TraceEntryView::from(&base(false, "no such table"));
        assert!(!failed.success);
        assert_eq!(
            failed.result_excerpt, "no such table",
            "the failure message rides verbatim"
        );
    }

    /// The ADR-0078 (issue #297) event stream: each dispatch emits the
    /// started/completed pair around it (completed payload = the display
    /// trace entry, success excerpt emptied), Thinking brackets the provider
    /// round-trips, and a failed call's completion carries the error message.
    #[test]
    fn tool_call_event_stream_pairs_started_and_completed_around_dispatch() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "stream",
            vec![
                // A failing explore (unknown table) -- its completion must
                // carry the error excerpt.
                Ok(call("explore", json!({"sql": "SELECT * FROM missing"}))),
                Ok(call("materialize", json!({"sql": "SELECT 1 AS x"}))),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let phases = std::sync::Mutex::new(Vec::new());
        AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("stream"),
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &sink,
            |p| phases.lock().unwrap().push(p),
        );
        let phases = phases.into_inner().unwrap();
        // Thinking{1}, explore started+completed, Thinking{2}, materialize
        // started+completed, Thinking{3} (the terminal-text round-trip).
        assert_eq!(phases.len(), 7, "3x Thinking + 2x (Started,Completed)");
        assert_eq!(phases[0], TurnPhase::Thinking { attempt: 1 });
        assert_eq!(
            phases[1],
            TurnPhase::ToolCallStarted {
                name: "explore".into(),
                operation_kind: OperationKind::Read,
                summary: "SELECT * FROM missing".into(),
            }
        );
        match &phases[2] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(view.name, "explore");
                assert!(!view.success, "the unknown-table explore failed");
                assert!(
                    !view.result_excerpt.is_empty(),
                    "the failure message rides the completion"
                );
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }
        assert_eq!(phases[3], TurnPhase::Thinking { attempt: 2 });
        assert_eq!(
            phases[4],
            TurnPhase::ToolCallStarted {
                name: "materialize".into(),
                operation_kind: OperationKind::Write,
                summary: "SELECT 1 AS x".into(),
            }
        );
        assert_eq!(
            phases[5],
            TurnPhase::ToolCallCompleted(TraceEntryView {
                name: "materialize".into(),
                operation_kind: OperationKind::Write,
                summary: "SELECT 1 AS x".into(),
                success: true,
                result_excerpt: String::new(),
            }),
            "a success completion empties the excerpt (persisted shape)"
        );
        assert_eq!(phases[6], TurnPhase::Thinking { attempt: 3 });
    }

    /// A gate-denied call (ADR-0078) fires ONLY ToolCallCompleted (success:
    /// false, excerpt "denied by approval gateway"), NEVER ToolCallStarted --
    /// the frontend's pending approval card flips straight to its resolved-deny
    /// row. The denial rides a concurrent `respond(Deny)` (classify never
    /// returns Deny directly; the only path to GateOutcome::Denied is the
    /// gate's suspend-then-respond), so a responder thread answers the request
    /// the sink captured.
    #[test]
    fn gate_denied_call_emits_only_completion_no_started() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        // An unknown tool name classifies as external (the gateway suspends
        // instead of passing through), so execute_call reaches the deny branch.
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "deny",
            vec![
                Ok(call("external_tool", json!({}))),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let phases = Arc::new(std::sync::Mutex::new(Vec::new()));

        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let request_id = poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            approval_c
                .respond(request_id, ApprovalResponse::Deny)
                .expect("deny ok");
        });

        AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("deny"),
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &*sink,
            {
                let phases = Arc::clone(&phases);
                move |p| phases.lock().unwrap().push(p)
            },
        );
        responder.join().expect("responder thread");

        let phases = phases.lock().unwrap().clone();
        // Thinking{1} (first round-trip), ToolCallCompleted(success:false) for
        // the denied call, Thinking{2} (the terminal Text round-trip). The
        // denial never started, so no ToolCallStarted.
        assert_eq!(
            phases.len(),
            3,
            "denied call: Thinking + completion + Thinking"
        );
        assert_eq!(phases[0], TurnPhase::Thinking { attempt: 1 });
        match &phases[1] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(view.name, "external_tool");
                assert!(!view.success, "the denied call completes failure");
                assert_eq!(view.result_excerpt, "denied by approval gateway");
            }
            other => panic!("expected ToolCallCompleted for the denied call, got {other:?}"),
        }
        assert!(
            !phases
                .iter()
                .any(|p| matches!(p, TurnPhase::ToolCallStarted { .. })),
            "a gate-denied call must never emit ToolCallStarted"
        );
    }

    /// A denied `mcp_invoke` (ADR-0105 Decision 4 + ADR-0078): the gate
    /// consumed the RESOLVED handle, so the deny completion names the backend
    /// handle -- never "mcp_invoke" (issue #663 review: this identity was
    /// pinned on the allow path only; the deny row's naming had no pin).
    #[test]
    fn denied_invoke_completion_names_the_resolved_handle() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "deny-invoke",
            vec![
                Ok(call("mcp_invoke", json!({"tool": "mcp__live__echo"}))),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        // A live catalog entry (dead-port transport: the denial lands at the
        // gate, before any dispatch, so the server is never contacted).
        // Display "Live" slugifies to "live".
        let mut mcp = McpAggregator::catalog_server_for_test(
            "Live",
            vec![json!({"name": "echo", "description": "echo", "inputSchema": {"type": "object"}})],
        );
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let phases = Arc::new(std::sync::Mutex::new(Vec::new()));

        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let request_id = poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            approval_c
                .respond(request_id, ApprovalResponse::Deny)
                .expect("deny ok");
        });

        AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("deny-invoke"),
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &approval,
            &*sink,
            {
                let phases = Arc::clone(&phases);
                move |p| phases.lock().unwrap().push(p)
            },
        );
        responder.join().expect("responder thread");

        let phases = phases.lock().unwrap().clone();
        let completed: Vec<&TurnPhase> = phases
            .iter()
            .filter(|p| matches!(p, TurnPhase::ToolCallCompleted { .. }))
            .collect();
        assert_eq!(completed.len(), 1, "one completion for the denied invoke");
        match completed[0] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(
                    view.name, "mcp__live__echo",
                    "the deny row names the resolved handle, never mcp_invoke"
                );
                assert!(!view.success);
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }
    }

    /// The failure-message guard (issue #316): the persisted excerpt is the
    /// cross-turn failure retrospection anchor (ADR-0078), so a failed call
    /// with no message panics in debug builds rather than persisting an
    /// empty anchor.
    #[test]
    #[should_panic(expected = "a failed trace entry keeps its result message")]
    fn persisted_trace_mapping_rejects_a_silent_failure() {
        let entry = TraceEntry {
            tool_use_id: "tu_1".into(),
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1".into(),
            success: false,
            result_excerpt: String::new(),
        };
        let _ = RecipeTraceEntry::from_live_trace(&entry);
    }

    /// Drive a loop with a scripted provider + the real materializer + a fresh
    /// approval state. No watchdog (wall_clock=None) so the step-cap /
    /// cancellation tests are deterministic.
    fn run_loop(
        provider: &FakeProvider,
        cancel: Arc<CancelToken>,
        step_cap: u32,
        question: &str,
        ws: &mut WorkingSet,
        engine: &AdminEngine,
        temp: &Path,
    ) -> LoopOutcome {
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(engine, ws, &mut sources, temp, &mut refs);
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        AgentLoop::new(provider, cancel)
            .with_caps(step_cap, None)
            .run(
                &request(question),
                &mut d,
                &mut RealMaterializer,
                &mut McpAggregator::empty(),
                &[],
                &approval,
                &sink,
                |_| {},
            )
    }

    /// Shared engine setup: a materialized in-memory admin engine + a temp
    /// dir for the materializer. The loop tests use literal SQL (no
    /// working-set source registered), so the sandbox runs the same shape the
    /// real engine would for an empty working set.
    struct Engine {
        admin_engine: AdminEngine,
        temp: TempDir,
    }
    impl Engine {
        fn new() -> Self {
            let admin_engine = AdminEngine::materialized();
            let temp = TempDir::new().unwrap();
            Self { admin_engine, temp }
        }
    }

    // --- happy paths --------------------------------------------------------

    #[test]
    fn round_text_rides_the_round_phase_stream_and_conversation() {
        // ADR-0103 (issue #608): a tool-call reply carrying connective prose
        // opens its round with that prose. The RoundText phase fires after
        // the round's Thinking wait and BEFORE the batch's call events; the
        // recorded round carries the text (and no thinking -- this script
        // carries none); the prose also re-feeds on the assistant message,
        // so the next round-trip's request carries it ("taken from the loop
        // conversation" -- the wire protocols accept text alongside tool_use
        // in one assistant turn).
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "narrated",
            vec![
                Ok(ToolTurnReply::ToolCalls {
                    text: Some("先看一眼数据。".into()),
                    calls: vec![ToolUse {
                        id: "tu_1".into(),
                        name: "explore".into(),
                        input: json!({"sql": "SELECT 1"}),
                    }],
                }),
                Ok(ToolTurnReply::ToolCalls {
                    text: None,
                    calls: vec![ToolUse {
                        id: "tu_2".into(),
                        name: "materialize".into(),
                        input: json!({"sql": "SELECT 1 AS x"}),
                    }],
                }),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let captured = provider.captured_tool_turns();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let phases = std::sync::Mutex::new(Vec::new());
        let outcome = AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("narrated"),
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &sink,
            |p| phases.lock().unwrap().push(p),
        );
        assert_eq!(outcome.termination, Termination::Text("done".into()));
        // The round grouping: round 1 carries the prose + its explore call;
        // round 2 is bare (no prose, no thinking).
        assert_eq!(outcome.trace.len(), 2, "one round per tool-call reply");
        assert_eq!(outcome.trace[0].text.as_deref(), Some("先看一眼数据。"));
        assert_eq!(
            outcome.trace[0].thinking, None,
            "no thinking source wired yet"
        );
        assert_eq!(outcome.trace[0].calls.len(), 1);
        assert_eq!(outcome.trace[1].text, None);
        assert_eq!(outcome.trace[1].calls.len(), 1);
        // The phase stream: RoundText fires after Thinking{1} and before the
        // batch's Started/Completed; round 2 fires no RoundText.
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases[0], TurnPhase::Thinking { attempt: 1 });
        assert_eq!(
            phases[1],
            TurnPhase::RoundText {
                text: "先看一眼数据。".into()
            },
            "RoundText fires between the Thinking wait and the call events"
        );
        assert!(matches!(phases[2], TurnPhase::ToolCallStarted { .. }));
        assert!(matches!(phases[3], TurnPhase::ToolCallCompleted { .. }));
        assert_eq!(phases[4], TurnPhase::Thinking { attempt: 2 });
        // The re-fed conversation carries the prose on the assistant turn.
        let captured = captured.lock().unwrap();
        let second = &captured[1];
        let carries_prose = second.messages.iter().any(|m| match m {
            ToolTurnMessage::Assistant {
                text, tool_calls, ..
            } => text.as_deref() == Some("先看一眼数据。") && !tool_calls.is_empty(),
            _ => false,
        });
        assert!(
            carries_prose,
            "the prose re-feeds on the assistant message of the next request"
        );
    }

    #[test]
    fn thinking_completes_between_thinking_wait_and_round_text() {
        // ADR-0103 (issue #614): with the built-in thinking source wired, a
        // round's phase order is Thinking{N} -> ThinkingCompleted{N} ->
        // RoundText{N} -> the batch's call events (the first-touch round
        // attribution premise: the opening round's thinking completes before
        // anything else of that round arrives). The round's trace entry
        // carries duration 0 (no thinking-only window in a non-streaming
        // call) + the readable text; the assistant re-feed carries the FULL
        // block sequence, redacted block included, verbatim.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_thinking_tool_turn_seq(
            "think",
            vec![
                Ok((
                    vec![
                        ThinkingBlock::Thinking {
                            thinking: "先想清楚。".into(),
                            signature: "sig-1".into(),
                        },
                        ThinkingBlock::Redacted {
                            data: "opaque".into(),
                        },
                    ],
                    ToolTurnReply::tool_calls_with(
                        Some("先看一眼数据。".into()),
                        vec![ToolUse {
                            id: "tu_1".into(),
                            name: "explore".into(),
                            input: json!({"sql": "SELECT 1"}),
                        }],
                    ),
                )),
                Ok((
                    vec![ThinkingBlock::Thinking {
                        thinking: "收尾。".into(),
                        signature: "sig-2".into(),
                    }],
                    ToolTurnReply::Text("done".into()),
                )),
            ],
        );
        let captured = provider.captured_tool_turns();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let phases = std::sync::Mutex::new(Vec::new());
        let outcome = AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("think"),
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &sink,
            |p| phases.lock().unwrap().push(p),
        );
        assert_eq!(outcome.termination, Termination::Text("done".into()));
        // Round 1 carries its thinking + prose + call; the terminal reply
        // opens a thinking-only trailing round (the answer rides the
        // terminal text).
        assert_eq!(outcome.trace.len(), 2);
        assert_eq!(
            outcome.trace[0].thinking,
            Some(ThinkingTrace {
                duration_ms: 0,
                text: "先想清楚。".into(),
            })
        );
        assert_eq!(
            outcome.trace[1].thinking.as_ref().map(|t| t.text.as_str()),
            Some("收尾。")
        );
        assert_eq!(outcome.trace[1].text, None);
        assert_eq!(outcome.trace[1].calls, Vec::new());
        // The phase stream: round 1 = Thinking, ThinkingCompleted, RoundText,
        // call pair; round 2 = Thinking, ThinkingCompleted, then the terminal
        // text (no RoundText -- the answer is not round prose).
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases[0], TurnPhase::Thinking { attempt: 1 });
        assert_eq!(
            phases[1],
            TurnPhase::ThinkingCompleted {
                duration_ms: 0,
                text: "先想清楚。".into(),
            },
            "ThinkingCompleted fires right after the round's Thinking wait"
        );
        assert_eq!(
            phases[2],
            TurnPhase::RoundText {
                text: "先看一眼数据。".into()
            },
            "RoundText fires after ThinkingCompleted and before the call events"
        );
        assert!(matches!(phases[3], TurnPhase::ToolCallStarted { .. }));
        assert!(matches!(phases[4], TurnPhase::ToolCallCompleted { .. }));
        assert_eq!(phases[5], TurnPhase::Thinking { attempt: 2 });
        assert_eq!(
            phases[6],
            TurnPhase::ThinkingCompleted {
                duration_ms: 0,
                text: "收尾。".into(),
            },
            "the terminal reply's thinking completes live too"
        );
        // The re-fed assistant turn carries the FULL block sequence
        // verbatim (redacted block included) for tool-use continuity.
        let captured = captured.lock().unwrap();
        let second = &captured[1];
        let refeed = second.messages.iter().find_map(|m| match m {
            ToolTurnMessage::Assistant { thinking, .. } if !thinking.is_empty() => Some(thinking),
            _ => None,
        });
        let refeed = refeed.expect("the round's thinking re-feeds");
        assert_eq!(
            refeed.as_slice(),
            [
                ThinkingBlock::Thinking {
                    thinking: "先想清楚。".into(),
                    signature: "sig-1".into(),
                },
                ThinkingBlock::Redacted {
                    data: "opaque".into(),
                },
            ]
        );
    }

    #[test]
    fn redacted_only_rounds_stay_silent_but_ride_the_refeed() {
        // Issue #614: a redacted-only round (safety-redacted reasoning, no
        // readable text) is silent both live and in the trace -- no
        // ThinkingCompleted phase, no trace entry, and no thinking-only
        // trailing round for a redacted-only terminal reply -- while its
        // blocks still ride the next request's assistant turn (tool-use
        // continuity). Pins the two-sided behavior at the loop level: the
        // gate is readable text, not block presence.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_thinking_tool_turn_seq(
            "redacted",
            vec![
                Ok((
                    vec![ThinkingBlock::Redacted {
                        data: "opaque-1".into(),
                    }],
                    ToolTurnReply::tool_calls(vec![ToolUse {
                        id: "tu_1".into(),
                        name: "explore".into(),
                        input: json!({"sql": "SELECT 1"}),
                    }]),
                )),
                Ok((
                    vec![ThinkingBlock::Redacted {
                        data: "opaque-2".into(),
                    }],
                    ToolTurnReply::Text("done".into()),
                )),
            ],
        );
        let captured = provider.captured_tool_turns();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let phases = std::sync::Mutex::new(Vec::new());
        let outcome = AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("redacted"),
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &sink,
            |p| phases.lock().unwrap().push(p),
        );
        assert_eq!(outcome.termination, Termination::Text("done".into()));
        // One trace round only -- the tool batch carries no thinking entry,
        // and the redacted-only terminal reply opens no thinking-only
        // trailing round.
        assert_eq!(outcome.trace.len(), 1);
        assert_eq!(outcome.trace[0].thinking, None);
        // No ThinkingCompleted anywhere in the live stream.
        let phases = phases.into_inner().unwrap();
        assert!(
            !phases
                .iter()
                .any(|p| matches!(p, TurnPhase::ThinkingCompleted { .. })),
            "redacted-only rounds complete no live thinking phase"
        );
        // The first round's redacted block still rides the second request's
        // assistant turn verbatim.
        let captured = captured.lock().unwrap();
        let second = &captured[1];
        let refeed = second.messages.iter().find_map(|m| match m {
            ToolTurnMessage::Assistant { thinking, .. } if !thinking.is_empty() => Some(thinking),
            _ => None,
        });
        let refeed = refeed.expect("the redacted block still re-feeds");
        assert_eq!(
            refeed.as_slice(),
            [ThinkingBlock::Redacted {
                data: "opaque-1".into(),
            }]
        );
    }

    #[test]
    fn thought_level_rides_every_round_trip_request() {
        // The posture's thought-level flows from the turn's outer request
        // onto EVERY per-round request the loop issues (the dispatch seam
        // copies it from the session's runtime facts; the adapter layer is
        // what maps it onto the wire).
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "leveled",
            vec![
                Ok(ToolTurnReply::tool_calls(vec![ToolUse {
                    id: "tu_1".into(),
                    name: "explore".into(),
                    input: json!({"sql": "SELECT 1"}),
                }])),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let mut outer = request("leveled");
        outer.thought_level = Some("high".into());
        AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &outer,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &sink,
            |_| {},
        );
        let captured = provider.captured_tool_turns();
        let captured = captured.lock().unwrap();
        assert_eq!(captured.len(), 2);
        for req in captured.iter() {
            assert_eq!(req.thought_level.as_deref(), Some("high"));
        }
    }

    #[test]
    fn multi_step_explore_then_materialize_lands_text_with_one_promotion() {
        // AC #1: one question unfolds into multi-step exploration ->
        // materialize -> terminal text. The agent explores first (scratch, no
        // promotion), then materializes (promotes result_1), then answers.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "summarize people",
            vec![
                Ok(call("explore", json!({"sql": "SELECT 1"}))),
                Ok(call("materialize", json!({"sql": "SELECT 1 AS x"}))),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "summarize people",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Text("done".into()));
        assert_eq!(
            outcome.promotions.len(),
            1,
            "explore does not promote; only materialize does"
        );
        assert_eq!(outcome.promotions[0].dataset.reference_name, "result_1");
        assert_eq!(
            outcome.promotions[0].sql, "SELECT 1 AS x",
            "the promotion carries its verbatim materialize SQL"
        );
        assert_eq!(
            outcome.trace.len(),
            2,
            "explore + materialize, one round each"
        );
        assert!(outcome.trace[0].calls[0].success, "explore succeeded");
        assert!(outcome.trace[1].calls[0].success, "materialize succeeded");
        assert_eq!(outcome.round_trips, 3, "three round-trips");
    }

    #[test]
    fn tool_error_routes_back_for_self_correction_then_succeeds() {
        // AC #1: a SQL error (typo) is fed back to the agent, which rewrites
        // the SQL and succeeds. Blind retry is abolished (ADR-0077) -- the
        // agent, not the loop, drives the correction.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "self-correct",
            vec![
                // Bad SQL (unknown reference) -> tool error fed back.
                Ok(call(
                    "materialize",
                    json!({"sql": "SELECT * FROM result_99"}),
                )),
                // Corrected SQL -> promotion.
                Ok(call("materialize", json!({"sql": "SELECT 1 AS x"}))),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "self-correct",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Text("done".into()));
        assert_eq!(
            outcome.promotions.len(),
            1,
            "only the corrected call promotes"
        );
        assert_eq!(outcome.trace.len(), 2);
        assert!(
            !outcome.trace[0].calls[0].success,
            "first call failed: {}",
            outcome.trace[0].calls[0].result_excerpt
        );
        assert!(
            outcome.trace[1].calls[0].success,
            "corrected call succeeded"
        );
    }

    #[test]
    fn multiple_promotions_recorded_in_order() {
        // ADR-0022: numbering is monotonic by promotion order. Two materialize
        // calls promote result_1 then result_2.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "two-promote",
            vec![
                Ok(call("materialize", json!({"sql": "SELECT 1 AS x"}))),
                Ok(call("materialize", json!({"sql": "SELECT 2 AS y"}))),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "two-promote",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        let names: Vec<String> = outcome
            .promotions
            .iter()
            .map(|p| p.dataset.reference_name.clone())
            .collect();
        assert_eq!(
            names,
            vec!["result_1".to_string(), "result_2".to_string()],
            "promotions are in monotonic order"
        );
    }

    #[test]
    fn multi_call_batch_dispatches_serially_and_preserves_order() {
        // AC #1: a ToolCalls batch with >=2 calls dispatches each serially,
        // appends one Assistant turn (the whole batch) then one ToolResult per
        // call, and the next round-trip's request carries the full assembled
        // conversation. The single-call `call()` helper left this path -- the
        // loop's serial dispatch + message ordering for a multi-call batch --
        // entirely untested; `captured_tool_turns()` was built for exactly this
        // assertion and no loop test had wired it up.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "two-in-one",
            vec![
                Ok(calls(&[
                    ("explore", json!({"sql": "SELECT 1"})),
                    ("materialize", json!({"sql": "SELECT 1 AS x"})),
                ])),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let handle = provider.captured_tool_turns();
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "two-in-one",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Text("done".into()));
        assert_eq!(
            outcome.trace.len(),
            1,
            "one round: both calls of the batch dispatched together"
        );
        assert_eq!(
            outcome.trace[0].calls.len(),
            2,
            "both calls in the batch dispatched"
        );
        assert_eq!(outcome.trace[0].calls[0].name, "explore");
        assert_eq!(
            outcome.trace[0].calls[1].name, "materialize",
            "serial dispatch order preserved"
        );
        assert_eq!(
            outcome.promotions.len(),
            1,
            "explore does not promote; only materialize does"
        );
        assert_eq!(
            outcome.round_trips, 2,
            "one batch round-trip + one terminal round-trip"
        );

        // The capture handle records every assembled ToolTurnRequest. The
        // second round-trip's request proves the loop built the right
        // conversation: [user, assistant(2 tool_calls), tool_result, tool_result].
        let captured = handle.lock().expect("capture not poisoned");
        assert_eq!(captured.len(), 2, "one capture per round-trip");
        let second = &captured[1];
        assert_eq!(
            second.messages.len(),
            4,
            "user + assistant + one tool_result per call"
        );
        assert!(
            matches!(&second.messages[0], ToolTurnMessage::User { content } if content.as_str() == "two-in-one"),
            "first turn is the asking question"
        );
        let tool_calls = match &second.messages[1] {
            ToolTurnMessage::Assistant {
                text, tool_calls, ..
            } => {
                assert!(text.is_none(), "no prose alongside the tool batch");
                tool_calls
            }
            other => panic!("expected Assistant, got {other:?}"),
        };
        assert_eq!(
            tool_calls.len(),
            2,
            "the assistant turn carries the whole batch"
        );
        assert_eq!(tool_calls[0].name, "explore");
        assert_eq!(tool_calls[1].name, "materialize");
        assert!(
            matches!(second.messages[2], ToolTurnMessage::ToolResult { .. }),
            "first tool result follows the assistant turn"
        );
        assert!(
            matches!(second.messages[3], ToolTurnMessage::ToolResult { .. }),
            "second tool result follows in order"
        );
    }

    // --- execution-level caps ------------------------------------------------

    #[test]
    fn step_cap_exhausted_without_terminal_reply_lands_step_cap() {
        // AC #2: the agent never converges (keeps exploring); the step cap
        // aborts the turn as StepCap -> Failed. step_cap=3 for determinism.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .scripted_tool_turn("loop-forever", call("explore", json!({"sql": "SELECT 1"})));
        let outcome = run_loop(
            &provider,
            cancel,
            3,
            "loop-forever",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::StepCap(3));
        assert_eq!(outcome.round_trips, 3, "ran exactly step_cap round-trips");
        assert!(
            outcome.promotions.is_empty(),
            "no promotion on a non-converging turn"
        );
        assert_eq!(outcome.trace.len(), 3, "one trace entry per explore");
    }

    #[test]
    fn cancel_during_provider_call_lands_cancelled() {
        // AC #3: a cancel during a (slow) provider call aborts the whole turn.
        // The blocking fake polls the token; once cancel fires it returns, and
        // the loop's post-call check lands Cancelled.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .with_cancel(cancel.clone())
            .scripted_tool_turn_blocking("slow", ToolTurnReply::Text("never".into()));
        let cancel_for_thread = cancel.clone();
        thread::spawn(move || {
            while !cancel_for_thread.is_in_flight() {
                thread::sleep(Duration::from_millis(1));
            }
            cancel_for_thread.request();
        });
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "slow",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Cancelled);
        assert!(outcome.promotions.is_empty());
    }

    #[test]
    fn cancel_between_round_trips_lands_cancelled() {
        // AC #3 alt: a cancel that lands between round-trips (the loop-top
        // check). A worker fires cancel shortly after the turn starts; the
        // stable explore loop aborts at the next loop-top check.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .scripted_tool_turn("loop", call("explore", json!({"sql": "SELECT 1"})));
        let cancel_for_thread = cancel.clone();
        thread::spawn(move || {
            // Wait for the turn to be in-flight, then cancel after a short
            // sleep so at least one round-trip runs.
            while !cancel_for_thread.is_in_flight() {
                thread::sleep(Duration::from_millis(1));
            }
            thread::sleep(Duration::from_millis(15));
            cancel_for_thread.request();
        });
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "loop",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Cancelled);
    }

    #[test]
    fn cancel_keeps_the_prose_round_of_a_narrated_turn() {
        // ADR-0103 (issue #608): the round a narrated reply opens survives a
        // cancel after the batch -- its prose + the completed calls stay on
        // the recorded trace, matching the frontend fold (which keeps the
        // prose-only round of a mid-batch cancel).
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        // The sequence clamps to the last (bare) reply, so the loop keeps
        // round-tripping until the cancel lands -- the turn can only end
        // Cancelled, after the narrated first round completed.
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "narrated-cancel",
            vec![
                Ok(ToolTurnReply::ToolCalls {
                    text: Some("先看一眼数据。".into()),
                    calls: vec![ToolUse {
                        id: "tu_1".into(),
                        name: "explore".into(),
                        input: json!({"sql": "SELECT 1"}),
                    }],
                }),
                Ok(ToolTurnReply::tool_calls(vec![ToolUse {
                    id: "tu_2".into(),
                    name: "explore".into(),
                    input: json!({"sql": "SELECT 1 AS x"}),
                }])),
            ],
        );
        let cancel_for_thread = cancel.clone();
        thread::spawn(move || {
            // Wait for the turn to be in-flight, then cancel after a sleep
            // long enough for the first round-trip + its explore to land.
            while !cancel_for_thread.is_in_flight() {
                thread::sleep(Duration::from_millis(1));
            }
            thread::sleep(Duration::from_millis(50));
            cancel_for_thread.request();
        });
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "narrated-cancel",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Cancelled);
        assert!(
            !outcome.trace.is_empty(),
            "the narrated round survives the cancel: {:?}",
            outcome.trace
        );
        let round = &outcome.trace[0];
        assert_eq!(round.text.as_deref(), Some("先看一眼数据。"));
        assert!(
            !round.calls.is_empty(),
            "the completed explore call rides the round"
        );
    }

    #[test]
    fn cancelled_turn_records_no_empty_round() {
        // ADR-0103 (issue #608): a reply that carried no prose opens a round
        // at arrival; if the cancel lands before the batch's first call
        // completes, nothing ever lands on that round -- the outcome drops
        // it, so the recorded trace never carries an empty round (the
        // frontend fold cannot see one either; optimistic/backend parity).
        // Holds at every cancel landing point: a round that survives always
        // carries its completed calls.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .scripted_tool_turn("bare-cancel", call("explore", json!({"sql": "SELECT 1"})));
        let cancel_for_thread = cancel.clone();
        thread::spawn(move || {
            while !cancel_for_thread.is_in_flight() {
                thread::sleep(Duration::from_millis(1));
            }
            thread::sleep(Duration::from_millis(10));
            cancel_for_thread.request();
        });
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "bare-cancel",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Cancelled);
        assert!(
            outcome
                .trace
                .iter()
                .all(|round| round.text.is_some() || !round.calls.is_empty()),
            "no empty round survives the cancel: {:?}",
            outcome.trace
        );
    }

    #[test]
    fn wall_clock_watchdog_fires_cancel() {
        // AC #2: the wall-clock watchdog fires cancel within the timeout. The
        // blocking provider never returns on its own; the watchdog (30ms) fires
        // cancel, the blocking fake returns, and the loop lands Cancelled.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .with_cancel(cancel.clone())
            .scripted_tool_turn_blocking("stuck", ToolTurnReply::Text("never".into()));
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let start = std::time::Instant::now();
        let outcome = AgentLoop::new(&provider, cancel)
            .with_caps(24, Some(Duration::from_millis(30)))
            .run(
                &request("stuck"),
                &mut d,
                &mut RealMaterializer,
                &mut McpAggregator::empty(),
                &[],
                &approval,
                &sink,
                |_| {},
            );
        let elapsed = start.elapsed();
        assert_eq!(outcome.termination, Termination::Cancelled);
        assert!(
            elapsed.as_millis() < 2000,
            "watchdog fired quickly; elapsed={elapsed:?}"
        );
    }

    // --- permanent / transient provider faults ------------------------------

    #[test]
    fn permanent_not_wired_lands_not_wired() {
        // ADR-0044: NotWired is permanent -- the turn fails immediately, no
        // retry, no agent self-correction.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        // Unscripted question -> FakeProvider returns NotWired.
        let provider = FakeProvider::new();
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "anything",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::NotWired);
        assert_eq!(outcome.round_trips, 1);
    }

    #[test]
    fn invalid_config_lands_invalid_config() {
        // ADR-0044: a permanently invalid provider config (e.g. a bad base_url
        // scheme) fails the turn immediately and carries the diagnosis.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "bad-config",
            vec![Err(ProviderError::InvalidConfig(
                "scheme `file` is not http/https".into(),
            ))],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "bad-config",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        match outcome.termination {
            Termination::InvalidConfig(d) => assert!(d.contains("http/https"), "{d}"),
            other => panic!("expected InvalidConfig, got {other:?}"),
        }
    }

    #[test]
    fn transient_unavailable_lands_transient_not_fed_to_agent() {
        // ADR-0077/0081: a transient fault surfaced after the adapter's own HTTP
        // retry exhausted is an honest turn failure -- it is NOT fed to the
        // agent and NOT blindly retried by the loop. Blind retry is abolished.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "transport",
            vec![Err(ProviderError::Unavailable("connection reset".into()))],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "transport",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        match outcome.termination {
            Termination::Transient(d) => assert!(d.contains("connection reset"), "{d}"),
            other => panic!("expected Transient, got {other:?}"),
        }
        assert_eq!(
            outcome.round_trips, 1,
            "Unavailable does not retry -- one round-trip"
        );
    }

    // --- terminal text without tools ----------------------------------------

    #[test]
    fn textual_terminal_carries_text_and_no_promotion() {
        // A clarify / refuse / plain answer with no tool calls -> Text, zero
        // promotions, zero trace entries, one round-trip.
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .scripted_tool_turn("just-text", ToolTurnReply::Text("please clarify".into()));
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "just-text",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(
            outcome.termination,
            Termination::Text("please clarify".into())
        );
        assert!(outcome.promotions.is_empty());
        assert!(outcome.trace.is_empty());
        assert_eq!(outcome.round_trips, 1);
    }

    // --- pure helpers -------------------------------------------------------

    /// The meta-tool trio serves locally in the loop (ADR-0105):
    /// `mcp_search_tools` runs against the aggregator's catalog and lands a
    /// normal trace row naming itself (empty catalog here -- the aggregator
    /// integration tests pin the match semantics + the non-empty card shape).
    #[test]
    fn meta_tool_search_serves_locally_with_a_trace_row() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "meta-search",
            vec![
                Ok(call("mcp_search_tools", json!({"query": "github"}))),
                Ok(ToolTurnReply::Text("nothing matched".into())),
            ],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "meta-search",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(
            outcome.termination,
            Termination::Text("nothing matched".into())
        );
        assert_eq!(outcome.trace.len(), 1, "one round");
        let calls = &outcome.trace[0].calls;
        assert_eq!(calls.len(), 1, "one meta call -> one trace entry");
        assert_eq!(calls[0].name, "mcp_search_tools");
        assert_eq!(calls[0].summary, "query \"github\"");
        assert!(calls[0].success, "local catalog read succeeds");
    }

    /// A `mcp_search_tools` call without a usable query fails through the
    /// SHARED parse (issue #661): the model gets the call's own error (the
    /// same `missing_query_failure` message the gateway serves) with no
    /// phase events and no trace entry -- the same traceless shape as a
    /// resolution failure.
    #[test]
    fn meta_tool_search_without_a_query_fails_traceless_with_the_shared_message() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "meta-search-malformed",
            vec![
                Ok(call("mcp_search_tools", json!({}))),
                Ok(ToolTurnReply::Text("recovered".into())),
            ],
        );
        let handle = provider.captured_tool_turns();
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "meta-search-malformed",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Text("recovered".into()));
        assert!(
            outcome.trace.is_empty(),
            "a malformed search never reached a tool -> no trace entry"
        );

        // The model-facing failure is the SHARED parse message (issue #661):
        // the second round-trip's request carries the call's error result,
        // and its content must equal `missing_query_failure()` -- the same
        // single source the gateway site pins -- so a re-inlined drifting
        // literal at this dispatch site fails here.
        let captured = handle.lock().expect("capture not poisoned");
        assert_eq!(captured.len(), 2, "one capture per round-trip");
        match &captured[1].messages[2] {
            ToolTurnMessage::ToolResult {
                content, is_error, ..
            } => {
                assert_eq!(
                    content,
                    &meta_tools::missing_query_failure(),
                    "the loop serves the shared missing-query message"
                );
                assert!(
                    is_error,
                    "the shared message rides back as the call's own error"
                );
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    /// A namespaced handle emitted DIRECTLY as a tool name is refused before
    /// the gate (ADR-0105 Consequences): the model gets the call's own error
    /// pointing at `mcp_invoke`, the round records no call, and the retained
    /// trace stays empty.
    #[test]
    fn direct_handle_emission_is_refused_pregate_in_the_loop() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "direct-handle",
            vec![
                Ok(call("mcp__github__search", json!({"q": "x"}))),
                Ok(ToolTurnReply::Text("switched to invoke".into())),
            ],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "direct-handle",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(
            outcome.termination,
            Termination::Text("switched to invoke".into())
        );
        assert!(
            outcome.trace.is_empty(),
            "direct emission leaves no trace entry"
        );
    }

    /// An `mcp_invoke` whose handle does not resolve produces NO trace entry
    /// (ADR-0105 Decision 4): the failure rides back to the model as the
    /// call's own error result and the round records no call -- the same
    /// semantics as a call that never reached a tool. The round-opening
    /// retain in `outcome` then drops the call-less, prose-less round
    /// entirely, so the recorded trace stays fully empty.
    #[test]
    fn meta_invoke_resolution_failure_is_traceless_in_the_loop() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "meta-invoke",
            vec![
                Ok(call("mcp_invoke", json!({"tool": "mcp__ghost__echo"}))),
                Ok(ToolTurnReply::Text("gave up".into())),
            ],
        );
        let outcome = run_loop(
            &provider,
            cancel,
            24,
            "meta-invoke",
            &mut ws,
            &engine.admin_engine,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Text("gave up".into()));
        assert!(
            outcome.trace.is_empty(),
            "resolution failure leaves no trace entry (and no empty round)"
        );
    }

    /// The `mcp_invoke` success composition (ADR-0105 Decision 4): a handle
    /// that resolves against the catalog flows the regular external path
    /// under the backend identity -- the gate consumes the handle (seeded
    /// trust), the trace row names the handle (never "mcp_invoke"), and the
    /// routing failure (the test server's transport is a dead port) rides
    /// back as the call's own error for self-correction. Pins the exact
    /// composition whose regression the PR #660 review caught: when the
    /// resolved handle was re-refused by the direct-emission guard, the call
    /// returned the refusal error with NO trace row, failing the row
    /// assertions below.
    #[test]
    fn meta_invoke_resolved_handle_dispatches_under_the_backend_identity() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "invoke-ok",
            vec![
                Ok(call(
                    "mcp_invoke",
                    json!({"tool": "mcp__fake__echo", "arguments": {"message": "hi"}}),
                )),
                Ok(ToolTurnReply::Text("routed".into())),
            ],
        );
        let mut mcp = McpAggregator::catalog_server_for_test(
            "Fake",
            vec![json!({
                "name": "echo",
                "description": "echo the message",
                "inputSchema": {"type": "object"},
            })],
        );
        let approval = ApprovalState::new();
        approval.seed_trust(&ToolKey::external("fake", "mcp__fake__echo"));
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let sink = RecordingSink::default();
        let outcome = AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("invoke-ok"),
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &approval,
            &sink,
            |_| {},
        );
        assert_eq!(outcome.termination, Termination::Text("routed".into()));
        assert_eq!(outcome.trace.len(), 1, "one round");
        let calls = &outcome.trace[0].calls;
        assert_eq!(calls.len(), 1, "one dispatched call");
        assert_eq!(
            calls[0].name, "mcp__fake__echo",
            "the trace row carries the backend handle, not an mcp_invoke shell"
        );
        assert!(
            !calls[0].success,
            "the dead transport surfaces as the call's own error"
        );
    }

    /// Characterization pin for `classify_call` (issue #336): the built-in tools
    /// each classify to a known `(ToolKey, OperationKind, summary)` triple,
    /// and an unknown name falls through to the external arm. Pinned BEFORE the
    /// metadata-table refactor (Move 1) so the table lookup must reproduce these
    /// exactly -- a dropped arm or a swapped summary field fails here, not in a
    /// live approval card. Covers a present-arg call per tool + the external arm.
    #[test]
    fn classify_call_pins_builtin_and_external_arms() {
        // explore: builtin server, Read badge, sql summary.
        let explore = classify_call(&ToolUse {
            id: "1".into(),
            name: "explore".into(),
            input: json!({"sql": "SELECT 1"}),
        });
        assert!(explore.0.is_builtin());
        assert_eq!(explore.0.tool, "explore");
        assert_eq!(explore.1, OperationKind::Read);
        assert_eq!(explore.2, "SELECT 1");

        // materialize: builtin server, Write badge, sql summary.
        let materialize = classify_call(&ToolUse {
            id: "2".into(),
            name: "materialize".into(),
            input: json!({"sql": "SELECT 2"}),
        });
        assert!(materialize.0.is_builtin());
        assert_eq!(materialize.0.tool, "materialize");
        assert_eq!(materialize.1, OperationKind::Write);
        assert_eq!(materialize.2, "SELECT 2");

        // describe: builtin server, Read badge, reference_name summary.
        let describe = classify_call(&ToolUse {
            id: "3".into(),
            name: "describe".into(),
            input: json!({"reference_name": "result_1"}),
        });
        assert!(describe.0.is_builtin());
        assert_eq!(describe.0.tool, "describe");
        assert_eq!(describe.1, OperationKind::Read);
        assert_eq!(describe.2, "result_1");

        // sample: builtin server, Read badge, reference_name summary.
        let sample = classify_call(&ToolUse {
            id: "4".into(),
            name: "sample".into(),
            input: json!({"reference_name": "result_2"}),
        });
        assert!(sample.0.is_builtin());
        assert_eq!(sample.0.tool, "sample");
        assert_eq!(sample.1, OperationKind::Read);
        assert_eq!(sample.2, "result_2");

        // External arm: an unknown name keys as external, badges Network, and
        // the summary names the tool so an approval card can surface it.
        let unknown = classify_call(&ToolUse {
            id: "5".into(),
            name: "acme_fetch".into(),
            input: json!({"q": "rust", "depth": 2}),
        });
        assert!(!unknown.0.is_builtin());
        assert_eq!(unknown.0.tool, "acme_fetch");
        assert_eq!(unknown.1, OperationKind::Network);
        assert!(
            unknown.2.contains("acme_fetch"),
            "external summary names the tool: {}",
            unknown.2
        );
        // Issue #661: the external summary carries the call's arguments (the
        // approval card's parameter digest) -- a handle-only summary makes
        // the user blind-sign what the external server receives. The
        // assertion pins actual argument CONTENT (compact JSON), so a
        // summary that hardcodes `{}` and drops the arguments fails here.
        assert!(
            unknown.2.contains(r#""q":"rust""#) && unknown.2.contains(r#""depth":2"#),
            "external summary carries the argument JSON: {}",
            unknown.2
        );
    }

    /// Issue #312: a model-emitted `mcp__builtin__*` spoof must not bypass the
    /// gate. `try_external` rejects the reserved name; the fallback routes to
    /// `RESERVED_SPOOF_SERVER` so classify surfaces a card and routing fails
    /// gracefully (no panic on untrusted input).
    #[test]
    fn classify_call_routes_builtin_spoof_to_reserved_sentinel() {
        let (key, _, _) = classify_call(&ToolUse {
            id: "x".into(),
            name: "mcp__builtin__foo".into(),
            input: json!({}),
        });
        assert_eq!(key.server, ToolKey::RESERVED_SPOOF_SERVER);
        assert!(!key.is_builtin());
        let trust = std::collections::HashSet::new();
        assert_eq!(
            crate::approval::classify(&key, crate::approval::AuthMode::PerCall, &trust),
            crate::approval::Classification::NeedsApproval
        );
    }

    /// A missing summary field falls back to the per-tool placeholder so an
    /// approval card / trace row still renders (the executor will itself refuse
    /// the mis-shaped call). Pinned so the metadata table's `summary_fallback`
    /// reproduces the prior literals.
    #[test]
    fn classify_call_uses_per_tool_summary_fallback_when_field_absent() {
        let explore = classify_call(&ToolUse {
            id: "1".into(),
            name: "explore".into(),
            input: json!({}),
        });
        assert_eq!(explore.2, "<no sql>");
        let describe = classify_call(&ToolUse {
            id: "2".into(),
            name: "describe".into(),
            input: json!({}),
        });
        assert_eq!(describe.2, "<no reference_name>");
    }

    #[test]
    fn classify_call_marks_materialize_as_write() {
        // The operation badge (ADR-0083) is presentation-only; the gate does not
        // branch on it. materialize = Write, the read-shaped tools = Read.
        let explore = classify_call(&ToolUse {
            id: "1".into(),
            name: "explore".into(),
            input: json!({"sql": "SELECT 1"}),
        });
        assert_eq!(explore.1, OperationKind::Read);
        let materialize = classify_call(&ToolUse {
            id: "2".into(),
            name: "materialize".into(),
            input: json!({"sql": "SELECT 1"}),
        });
        assert_eq!(materialize.1, OperationKind::Write);
        let unknown = classify_call(&ToolUse {
            id: "3".into(),
            name: "acme_fetch".into(),
            input: json!({}),
        });
        assert_eq!(unknown.1, OperationKind::Network);
        assert!(!unknown.0.is_builtin(), "unknown tool keys as external");
    }

    #[test]
    fn truncate_cuts_with_ellipsis() {
        assert_eq!(truncate("short", 10), "short");
        let long = "x".repeat(50);
        let cut = truncate(&long, 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'), "ends with ellipsis: {cut}");
    }

    // --- panic guards (issue #321) -----------------------------------------

    /// A provider that panics inside `generate_tool_turn`. The tool-calling loop
    /// never invokes `generate`; it is an unreachable stub.
    struct PanickingProvider;
    impl Provider for PanickingProvider {
        fn generate(&self, _: &ProviderRequest) -> Result<ProviderReply, ProviderError> {
            unreachable!("the tool-calling loop never invokes generate")
        }
        fn generate_tool_turn(
            &self,
            _: &ToolTurnRequest,
        ) -> Result<ToolTurnOutcome, ProviderError> {
            panic!("simulated provider panic in generate_tool_turn")
        }
        fn response_locale(&self) -> ResponseLocale {
            ResponseLocale::EnUS
        }
    }

    /// A materializer that creates the physical `result_N` table, registers it
    /// in the working set, then panics — simulating a panic in the
    /// register-to-return window. The ghost-result rollback in `AgentLoop::run`
    /// must detect + revert the orphan (DROP the physical table + unregister)
    /// so the working_set <-> history invariant holds.
    struct GhostThenPanicMaterializer;
    impl Materializer for GhostThenPanicMaterializer {
        fn try_materialize(
            &self,
            _sql: &str,
            _cancel: &CancelToken,
            result_name: String,
            deps: &mut TurnDeps,
        ) -> Result<DatasetDescriptor, ExecError> {
            // Create the physical table first (mirrors RealMaterializer's
            // install_result step) so the ghost rollback exercises the DROP
            // TABLE success path.
            let create_sql = format!(
                "CREATE TABLE {} AS SELECT 1 AS x",
                quote_ident(&result_name)
            );
            deps.engine
                .conn()
                .execute_batch(&create_sql)
                .expect("fixture CREATE TABLE");
            let descriptor = DatasetDescriptor {
                reference_name: result_name.clone(),
                display_name: result_name,
                source_path: String::new(),
                columns: Vec::new(),
                row_count: 0,
                sample: Vec::new(),
                fingerprint: String::new(),
                rectify: RectifyProvenance::NotApplicable,
                privacy: DatasetPrivacy::default(),
                stale: None,
            };
            deps.working_set.register_result(descriptor);
            panic!("simulated post-register panic in tool dispatch")
        }
    }

    /// Issue #321: a provider panic in `generate_tool_turn` lands as a failed
    /// turn (Transient) with a detail naming the step. No tool dispatched, so
    /// the working set is untouched — no ghost result_N.
    #[test]
    fn provider_panic_in_generate_tool_turn_lands_failed_turn() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        let provider = PanickingProvider;
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let outcome = AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("panic-test"),
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &sink,
            |_| {},
        );
        match &outcome.termination {
            Termination::Transient(detail) => {
                assert!(
                    detail.contains("generate_tool_turn"),
                    "detail names the panic step: {detail}"
                );
                assert!(
                    detail.contains("simulated provider panic"),
                    "detail carries the panic message: {detail}"
                );
            }
            other => panic!("expected Transient, got {other:?}"),
        }
        assert_eq!(
            ws.next_result_number(),
            1,
            "no ghost result: working set untouched"
        );
    }

    /// Issue #321: a panic in `tools::dispatch` (mid-materialize, after
    /// `result_N` is registered) lands as a failed turn AND rolls back the
    /// ghost `result_N` so the working_set <-> history 1:1 invariant holds.
    #[test]
    fn dispatch_panic_lands_failed_turn_and_rolls_back_ghost_result() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let cancel = Arc::new(CancelToken::new());
        // The provider emits a materialize call; GhostThenPanicMaterializer
        // registers result_1 then panics in the return window.
        let provider = FakeProvider::new().scripted_tool_turn(
            "panic-dispatch",
            call("materialize", json!({"sql": "SELECT 1 AS x"})),
        );
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let mut materializer = GhostThenPanicMaterializer;
        let outcome = AgentLoop::new(&provider, cancel).with_caps(24, None).run(
            &request("panic-dispatch"),
            &mut d,
            &mut materializer,
            &mut McpAggregator::empty(),
            &[],
            &approval,
            &sink,
            |_| {},
        );
        match &outcome.termination {
            Termination::Transient(detail) => {
                assert!(
                    detail.contains("tool dispatch"),
                    "detail names the panic step: {detail}"
                );
                assert!(
                    detail.contains("simulated post-register panic"),
                    "detail carries the panic message: {detail}"
                );
            }
            other => panic!("expected Transient, got {other:?}"),
        }
        assert_eq!(
            d.working_set.next_result_number(),
            1,
            "ghost result_1 rolled back; next_result_number is back to 1"
        );
        assert!(
            !d.working_set.is_result("result_1"),
            "result_1 unregistered from the working set"
        );
        // Verify the physical table was dropped by the rollback (not just
        // unregistered from the working set).
        let table_count: i64 = d
            .engine
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables \
                 WHERE table_name = 'result_1'",
                [],
                |row| row.get(0),
            )
            .expect("query information_schema");
        assert_eq!(
            table_count, 0,
            "physical result_1 table dropped by ghost rollback"
        );
    }

    // --- panic_message unit tests ------------------------------------------

    #[test]
    fn panic_message_extracts_str_payload() {
        assert_eq!(panic_message(&"boom"), "boom");
    }

    #[test]
    fn panic_message_extracts_string_payload() {
        assert_eq!(panic_message(&String::from("owned boom")), "owned boom");
    }

    #[test]
    fn panic_message_fallback_for_non_string_payload() {
        let payload: Box<dyn std::any::Any + Send> = Box::new(42i32);
        assert_eq!(panic_message(&*payload), "<non-string panic payload>");
    }
}
