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
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::approval::{
    ApprovalRequest, ApprovalSink, ApprovalState, GateCancelled, GateOutcome, OperationKind,
    ToolKey,
};
use crate::cancel::CancelToken;
use crate::model::{DatasetDescriptor, Promotion, TurnPhase};
use crate::persistence::recipe::RecipeTraceEntry;
use crate::provider::tool_calling::{
    ToolResult, ToolTurnMessage, ToolTurnReply, ToolTurnRequest, ToolUse,
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
/// the loop needs to keep for the collapsible trace.
const TRACE_EXCERPT_MAX: usize = 240;

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
    /// `on_phase` receives a discrete [`TurnPhase`] marker at each wait
    /// boundary (ADR-0059): `Thinking` before each `generate_tool_turn` call
    /// and `Querying` before each tool dispatch. The 1-based attempt rises
    /// across round-trips so the UI can surface "step N" honestly.
    pub(crate) fn run(
        self,
        request: &ToolTurnRequest,
        deps: &mut TurnDeps,
        materializer: &mut dyn Materializer,
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
            trace: Vec::new(),
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
            };
            match self.provider.generate_tool_turn(&turn_req) {
                // Terminal text: the model answered. A cancel that arrived
                // during the (possibly slow) provider call wins over a textual
                // reply (ADR-0021) -- the user asked to stop.
                Ok(ToolTurnReply::Text(text)) => {
                    if cancel.is_requested() {
                        return outcome(Termination::Cancelled, outputs, round_trips);
                    }
                    return outcome(Termination::Text(text), outputs, round_trips);
                }
                Ok(ToolTurnReply::ToolCalls(calls)) => {
                    // Re-check after the (possibly slow) provider call.
                    if cancel.is_requested() {
                        return outcome(Termination::Cancelled, outputs, round_trips);
                    }
                    // Append the assistant turn (owns a clone), then dispatch
                    // each call serially (ADR-0021 single-flight within a
                    // session).
                    messages.push(ToolTurnMessage::Assistant {
                        text: None,
                        tool_calls: calls.clone(),
                    });
                    let mut aborted = false;
                    for call in &calls {
                        if cancel.is_requested() {
                            aborted = true;
                            break;
                        }
                        on_phase(TurnPhase::Querying { attempt: step });
                        match execute_call(
                            call,
                            deps,
                            materializer,
                            approval,
                            sink,
                            &cancel,
                            &mut outputs,
                        ) {
                            // The gate was cancelled (close / resume / cancel
                            // interrupted an in-flight approval). The whole
                            // turn aborts.
                            Err(GateCancelled) => {
                                aborted = true;
                                break;
                            }
                            Ok(result) => messages.push(ToolTurnMessage::tool_result(result)),
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
fn outcome(termination: Termination, outputs: CallOutputs, round_trips: u32) -> LoopOutcome {
    LoopOutcome {
        termination,
        promotions: outputs.promotions,
        trace: outputs.trace,
        round_trips,
    }
}

/// The mutable per-turn outputs [`execute_call`] accumulates: the trace
/// (ADR-0078) and the promotion list (ADR-0022). Bundled into one struct so
/// [`execute_call`] stays under clippy's argument-count threshold and the two
/// always-coupled accumulators move together.
struct CallOutputs {
    trace: Vec<TraceEntry>,
    promotions: Vec<Promotion>,
}

/// Drive one tool call through the gateway + dispatch, append a trace entry,
/// and capture any promotion. Returns the [`ToolResult`] to feed back to the
/// model, or [`GateCancelled`] if the approval gate was cancelled mid-call.
///
/// A tool-level error (dispatch `is_error`, or a gateway [`GateOutcome::Denied`])
/// is NOT a turn failure -- it routes back to the model as a `ToolResult` with
/// `is_error = true` so the agent can self-correct (ADR-0077). Only a
/// gate-cancel ends the turn.
fn execute_call(
    call: &ToolUse,
    deps: &mut TurnDeps,
    materializer: &mut dyn Materializer,
    approval: &ApprovalState,
    sink: &dyn ApprovalSink,
    cancel: &CancelToken,
    outputs: &mut CallOutputs,
) -> Result<ToolResult, GateCancelled> {
    let (key, operation_kind, summary) = classify_call(call);
    let gate_req = ApprovalRequest {
        key,
        operation_kind,
        summary: summary.clone(),
    };
    // ADR-0080: every tool call passes the gate before dispatch. Built-in tools
    // classify Allow (zero approval); external tools would suspend here.
    match approval.gate(gate_req, sink, cancel) {
        Err(GateCancelled) => return Err(GateCancelled),
        Ok(GateOutcome::Denied) => {
            // A denial is a tool-level error the agent can self-correct from
            // (ADR-0077) -- e.g. retry without the denied tool, or surface it
            // to the user. Reachable once a deny-list / external tool exists;
            // today classify never returns Deny.
            outputs.trace.push(TraceEntry {
                tool_use_id: call.id.clone(),
                name: call.name.clone(),
                operation_kind,
                summary,
                success: false,
                result_excerpt: "denied by approval gateway".to_string(),
            });
            return Ok(ToolResult {
                tool_use_id: call.id.clone(),
                content: "tool call denied by the approval gateway".to_string(),
                is_error: true,
            });
        }
        Ok(GateOutcome::Allow) => {}
    }
    // ADR-0076: dispatch routes by name to the matching executor. The result is
    // either a JSON payload (is_error=false) or an error string (is_error=true)
    // -- both feed back to the model; the agent self-corrects on an error.
    let result = tools::dispatch(call, deps, cancel, materializer);
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
    // Capture a promotion: a successful materialize registers the full
    // descriptor in the working set; read it back for the promotions list. The
    // dispatch content carries the reference_name the materializer installed.
    // A `None` is a contract violation (the executor always emits
    // `reference_name` on success, and the working set holds what it just
    // registered) -- log it so a regression cannot silently drop a
    // user-visible `result_N`. The SQL itself ran, so the success `ToolResult`
    // still rides back to the model.
    if success && call.name == definitions::TOOL_MATERIALIZE {
        // The verbatim SQL the model materialized rides the promotion: the
        // wiring seam records it on the Materialized outcome (the recipe's
        // replayable chain reads it there), and the descriptor alone does not
        // carry it. Absent `sql` is a contract violation the executor would
        // have refused -- the empty string is a defensive fallback that never
        // shadows a real failure.
        let sql = call
            .input
            .get("sql")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match promotion_from_result(&result.content, deps) {
            Some(descriptor) => outputs.promotions.push(Promotion {
                dataset: descriptor,
                sql,
            }),
            None => log::error!(
                target: "toptopduck::agent_loop",
                "materialize reported success but the promotion could not be recovered; \
                 content=`{}`",
                truncate(&result.content, 200)
            ),
        }
    }
    outputs.trace.push(TraceEntry {
        tool_use_id: call.id.clone(),
        name: call.name.clone(),
        operation_kind,
        summary,
        success,
        result_excerpt: truncate(&result.content, TRACE_EXCERPT_MAX),
    });
    Ok(result)
}

/// Classify a tool call for the approval gateway + the trace: the [`ToolKey`]
/// (built-in vs external server), the [`OperationKind`] badge (ADR-0083), and a
/// short agent-readable summary of the arguments. Built-in tools key under the
/// reserved `builtin` server (ADR-0080 Decision 1); an unknown name is treated
/// as an external tool (the gateway surfaces the approval card for it).
fn classify_call(call: &ToolUse) -> (ToolKey, OperationKind, String) {
    let (tool, op, summary) = match call.name.as_str() {
        definitions::TOOL_EXPLORE => (
            definitions::TOOL_EXPLORE,
            OperationKind::Read,
            summarize_field(&call.input, "sql", "<no sql>"),
        ),
        definitions::TOOL_MATERIALIZE => (
            definitions::TOOL_MATERIALIZE,
            OperationKind::Write,
            summarize_field(&call.input, "sql", "<no sql>"),
        ),
        definitions::TOOL_DESCRIBE => (
            definitions::TOOL_DESCRIBE,
            OperationKind::Read,
            summarize_field(&call.input, "reference_name", "<no reference_name>"),
        ),
        definitions::TOOL_SAMPLE => (
            definitions::TOOL_SAMPLE,
            OperationKind::Read,
            summarize_field(&call.input, "reference_name", "<no reference_name>"),
        ),
        other => {
            return (
                ToolKey::external("unknown", other),
                OperationKind::Network,
                format!("external tool `{other}`"),
            );
        }
    };
    (ToolKey::builtin(tool), op, summary)
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
    crate::persistence::recipe::truncate_trace_summary(value)
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

/// Read the promoted descriptor out of a successful materialize result. The
/// dispatch content is the JSON the materialize executor built (carries
/// `reference_name`); the full descriptor lives in the working set, which the
/// materializer just registered it under. Returns `None` on a parse failure (a
/// logic bug -- the executor always emits the field on success).
fn promotion_from_result(content: &str, deps: &TurnDeps) -> Option<DatasetDescriptor> {
    let value: Value = serde_json::from_str(content).ok()?;
    let name = value.get("reference_name")?.as_str()?;
    deps.working_set.get(name).cloned()
}

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/// Why the loop terminated (ADR-0081). Maps onto the four-way `TurnOutcome`
/// (ADR-0028) at the wiring seam; kept as a distinct enum here so the loop is
/// unit-testable without committing to `TurnOutcome`'s single-promotion shape
/// (ADR-0084 carries the full promotion chain; ADR-0078 carries the trace).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Termination {
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
pub(crate) struct TraceEntry {
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

impl From<&TraceEntry> for RecipeTraceEntry {
    /// The persisted trace form (ADR-0078, issue #319): `name` / `operation_kind`
    /// / `summary` / `success` ride verbatim; two fields transform:
    /// - `tool_use_id` drops -- a per-provider-call id that does not survive
    ///   the turn, let alone a save/resume.
    /// - `result_excerpt` persists ONLY for a failed call; a successful call's
    ///   excerpt is emptied. See [`RecipeTraceEntry::result_excerpt`] for the
    ///   boundary rule (ADR-0078 failure anchor; ADR-0036 contents boundary).
    ///
    /// The surviving strings are already bounded at capture time
    /// (`summarize_field` / `TRACE_EXCERPT_MAX`), so no re-truncation.
    ///
    /// Failure-message guard (issue #316): a failed call MUST carry its
    /// result message -- the persisted excerpt is the cross-turn failure
    /// retrospection anchor (ADR-0078). A silent failure panics in debug
    /// builds rather than persisting an empty anchor.
    fn from(entry: &TraceEntry) -> Self {
        debug_assert!(
            entry.success || !entry.result_excerpt.is_empty(),
            "a failed trace entry persists its result message (ADR-0078 failure anchor)"
        );
        Self {
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
}

/// The structured outcome the agent loop returns. Pure data -- the wiring seam
/// ([`crate::session::Session::ask_with_phase`], issue #318) maps the four-way
/// termination + promotions onto `TurnOutcome`, and carries the trace
/// alongside to the turn's persisted audit (issue #319, ADR-0078).
#[derive(Debug, Clone)]
pub(crate) struct LoopOutcome {
    pub termination: Termination,
    /// Promotions this turn, in promotion order (each successful `materialize`
    /// call). ADR-0022 monotonic numbering applies (result_1, result_2, ...);
    /// a turn with several promotions records the LAST as the turn's primary
    /// result at the wiring seam.
    pub promotions: Vec<Promotion>,
    /// The full execution trace (ADR-0078). Collapsible; never enters the far
    /// window verbatim -- only its summary (call count + failure summary)
    /// does. The wiring seam persists it on the turn's recipe entry (issue
    /// #319): the real multi-call trajectory, mapped to [`RecipeTraceEntry`].
    pub trace: Vec<TraceEntry>,
    /// Count of provider round-trips executed (one per `generate_tool_turn`).
    /// A loop-diagnostic surface (the loop tests assert it); NOT persisted --
    /// the trace entries already tell the trajectory (ADR-0078, issue #319).
    #[allow(dead_code)]
    pub round_trips: u32,
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
    use crate::provider::fake::FakeProvider;
    use crate::provider::tool_calling::ToolTurnMessage;
    use crate::session::materializer::RealMaterializer;
    use crate::tools::builtin_table;
    use crate::workingset::WorkingSet;
    use duckdb::Connection;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::Path;
    use std::sync::Mutex;
    use tempfile::TempDir;

    /// A recording approval sink (mirrors the one in approval.rs's tests). The
    /// loop threads it so the gateway can emit approval events; built-in tools
    /// never reach the sink (they classify Allow before emitting).
    #[derive(Default)]
    struct RecordingSink {
        requests: Mutex<Vec<String>>,
    }
    impl ApprovalSink for RecordingSink {
        fn emit_request(&self, body: &crate::approval::ApprovalRequestBody) {
            self.requests.lock().unwrap().push(body.summary.clone());
        }
        fn emit_resolved(
            &self,
            _body: &crate::approval::ApprovalRequestBody,
            _response: ApprovalResponse,
        ) {
        }
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
        }
    }

    /// A tool-call reply carrying one call.
    fn call(name: &str, input: serde_json::Value) -> ToolTurnReply {
        ToolTurnReply::ToolCalls(vec![ToolUse {
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
        ToolTurnReply::ToolCalls(
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
        let ok = RecipeTraceEntry::from(&base(true, "42 rows"));
        assert!(ok.success);
        assert!(ok.result_excerpt.is_empty(), "success payload dropped");
        let failed = RecipeTraceEntry::from(&base(false, "no such table"));
        assert!(!failed.success);
        assert_eq!(
            failed.result_excerpt, "no such table",
            "the failure message rides verbatim"
        );
    }

    /// The failure-message guard (issue #316): the persisted excerpt is the
    /// cross-turn failure retrospection anchor (ADR-0078), so a failed call
    /// with no message panics in debug builds rather than persisting an
    /// empty anchor.
    #[test]
    #[should_panic(expected = "a failed trace entry persists its result message")]
    fn persisted_trace_mapping_rejects_a_silent_failure() {
        let entry = TraceEntry {
            tool_use_id: "tu_1".into(),
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1".into(),
            success: false,
            result_excerpt: String::new(),
        };
        let _ = RecipeTraceEntry::from(&entry);
    }

    /// Throwaway TurnDeps over a real in-memory connection. Mirrors the
    /// `tools::test_support` cap defaults so the loop drives the same engine
    /// shape the dispatch tests do.
    fn deps<'a>(
        conn: &'a Connection,
        ws: &'a mut WorkingSet,
        sources: &'a HashMap<String, std::path::PathBuf>,
        temp: &'a Path,
    ) -> TurnDeps<'a> {
        TurnDeps {
            conn,
            source_files: sources,
            working_set: ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: temp,
        }
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
        conn: &Connection,
        temp: &Path,
    ) -> LoopOutcome {
        let sources = HashMap::new();
        let mut d = deps(conn, ws, &sources, temp);
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        AgentLoop::new(provider, cancel)
            .with_caps(step_cap, None)
            .run(
                &request(question),
                &mut d,
                &mut RealMaterializer,
                &approval,
                &sink,
                |_| {},
            )
    }

    /// Shared engine setup: an in-memory DuckDB connection + a temp dir for the
    /// materializer. The loop tests use literal SQL (no working-set source
    /// registered), so the sandbox runs the same shape the real engine would
    /// for an empty working set.
    struct Engine {
        conn: Connection,
        temp: TempDir,
    }
    impl Engine {
        fn new() -> Self {
            let conn = Connection::open_in_memory().expect("in-memory db");
            let temp = TempDir::new().unwrap();
            Self { conn, temp }
        }
    }

    // --- happy paths --------------------------------------------------------

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
            &engine.conn,
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
        assert_eq!(outcome.trace.len(), 2, "explore + materialize");
        assert!(outcome.trace[0].success, "explore succeeded");
        assert!(outcome.trace[1].success, "materialize succeeded");
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
            &engine.conn,
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
            !outcome.trace[0].success,
            "first call failed: {}",
            outcome.trace[0].result_excerpt
        );
        assert!(outcome.trace[1].success, "corrected call succeeded");
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
            &engine.conn,
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
            &engine.conn,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Text("done".into()));
        assert_eq!(outcome.trace.len(), 2, "both calls in the batch dispatched");
        assert_eq!(outcome.trace[0].name, "explore");
        assert_eq!(
            outcome.trace[1].name, "materialize",
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
            ToolTurnMessage::Assistant { text, tool_calls } => {
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
            &engine.conn,
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
            &engine.conn,
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
            &engine.conn,
            engine.temp.path(),
        );
        assert_eq!(outcome.termination, Termination::Cancelled);
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
        let sources = HashMap::new();
        let mut d = deps(&engine.conn, &mut ws, &sources, engine.temp.path());
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let start = std::time::Instant::now();
        let outcome = AgentLoop::new(&provider, cancel)
            .with_caps(24, Some(Duration::from_millis(30)))
            .run(
                &request("stuck"),
                &mut d,
                &mut RealMaterializer,
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
            &engine.conn,
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
            &engine.conn,
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
            &engine.conn,
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
            &engine.conn,
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
}
