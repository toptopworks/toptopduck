//! The named delegation tool family's execution (issue #933, ADR-0117):
//! each enabled agent definition becomes one [`DynamicTool`] on the main
//! loop's face whose callback runs a SUB-AGENT -- a nested rig agent built
//! from the definition's preamble (+ assembly-time skill injections) over
//! the subtracted tool face (see [`crate::agents::delegation`]) -- and
//! feeds the sub-agent's final report back to the main model as the tool's
//! text result.
//!
//! Failure honesty (ADR-0117 Decision 5): a sub-agent that exhausts its
//! step cap or faults at the provider returns an explicit failure TEXT
//! through the tool result -- the main turn keeps running, and any
//! `result_N` the sub-agent promoted before dying stays promoted. Loop
//! detection is the one arm that escalates past this vocabulary: a
//! nudge-ignoring repeat aborts the MAIN turn as its budget protection
//! (see the Loop-detection paragraph below), everything else stays
//! tool-level. The callback always resolves `Ok` (the gateway
//! adapter's stance): rig's fail-fast error channel stays structurally
//! unreachable, so a sub-agent failure can never escalate into a turn
//! termination by accident. Cancellation is forwarded, not mapped -- the
//! sub-agent's watcher hook reads the SAME token / shared state, so a user
//! cancel stops the sub-agent at its next checkpoint and the main loop
//! lands the turn as Cancelled exactly as it would without delegation.
//!
//! Budget accounting: one delegation call = one main-loop step (rig counts
//! the tool call itself; the sub-agent's internal rounds never touch the
//! main cap), the sub-agent's internal cap is
//! [`SUBAGENT_STEP_CAP`], and the same-batch width cap
//! ([`DELEGATION_BATCH_CAP`]) refuses the 9th delegation of one
//! model-turn's batch with an explicit error text. rig's executor runs a
//! batch's calls under `tool_concurrency = 1` (the pinned ordering
//! guarantee), so "same batch" counts by execution order with the counter
//! reset at every turn-boundary usage record -- the committed calls of a
//! batch all arrive before the first one executes.
//!
//! Loop-detection status quo: a sub-agent's repeated identical calls
//! screen through the SHARED dispatch seam's identical-arguments detector
//! -- the steer text feeds back into the sub-agent for self-correction
//! (ADR-0028), and only a sub-agent that ignores the nudge and keeps
//! repeating aborts, as the main turn's budget protection (an honest
//! Transient), not as a sub-agent terminal channel. The sub-agent's own
//! budget terminations (step cap, provider fault) are the failure arms
//! that feed back as tool text.
//!
//! Trace + phases: the delegation call lands its own trace entry through
//! the same record-before-send discipline the dispatch server applies
//! (entry queued and counted on the MAIN completion channel before the
//! result crosses -- the delegation's result event surfaces on the MAIN
//! stream, so the main fold stays the channel's one consumer and the
//! order pairing stays exact), and the live rail sees the same
//! `ToolCallStarted` / `ToolCallCompleted` pair every dispatched call
//! fires. The sub-agent's own rounds are NOT projected onto the main
//! trace here -- the nested sub-trace projection is the chain's next
//! ticket (#934); its executed calls record onto the sub-agent's PRIVATE
//! completion channel (dropped with it until #934 lands), and their
//! promotions ride the shared promotion list.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use futures::StreamExt;
use rig_agent::agent::{AgentBuilder, StreamingError, StreamingPromptRequest};
use rig_agent::tool::DynamicTool;
use std::future::IntoFuture;

use crate::agents::delegation::{
    subagent_preamble, subagent_tool_face, DelegationSpec, DELEGATION_BATCH_CAP, SUBAGENT_STEP_CAP,
};
use crate::approval::OperationKind;
use crate::cancel::CancelToken;
use crate::model::TurnPhase;
use crate::provider::tool_calling::ToolDefinition;
use crate::session::loop_contract::{truncate_trace_excerpt, TraceEntry, TRACE_EXCERPT_MAX};
use crate::session::progress::ProgressClock;

use super::adapter::{emit_phase, next_call_id, DispatchRequest, PhaseSink, SharedTurnState};
use super::cancel::CancelWatcher;
use super::EventFold;

/// Everything a delegation callback needs to run its sub-agent, shared by
/// every tool of the family (one per turn): the same model handle the main
/// loop runs (ADR-0117 Decision 2 -- no model axis; the sub-agent reuses
/// the active profile's model and the turn's thought-level posture), the
/// shared dispatch channel + turn state (identical-by-construction
/// approval / audit / promotion), and the turn's execution inputs.
pub(crate) struct SubagentCtx {
    pub(crate) model: rig_agent::agent::ModelHandle,
    pub(crate) state: Arc<SharedTurnState>,
    pub(crate) dispatch: mpsc::Sender<DispatchRequest>,
    pub(crate) phases: PhaseSink,
    pub(crate) clock: Option<Arc<ProgressClock>>,
    pub(crate) token: Arc<CancelToken>,
    /// The live face's protocol + the turn's thought level, re-rendered
    /// onto the sub-agent's requests (the same posture the main loop
    /// stamps -- a sub-agent thinks exactly as its parent does).
    pub(crate) protocol: Option<crate::model::Protocol>,
    pub(crate) thought_level: Option<String>,
    pub(crate) max_tokens: u64,
    /// The subtracted face (ADR-0117 Decision 4), precomputed once per
    /// turn: the turn's tool table minus every delegation tool minus
    /// `activate_skill`.
    pub(crate) sub_face: Vec<ToolDefinition>,
}

/// Build one named delegation tool (ADR-0117 Decision 1): tool name =
/// definition name, description = the spec's routing description, single
/// `prompt` parameter. The callback consults `batch` (the current
/// model-turn's delegation count, reset by the driver at each turn
/// boundary) before running anything.
pub(crate) fn delegation_dynamic_tool(
    spec: DelegationSpec,
    batch: Arc<AtomicUsize>,
    ctx: Arc<SubagentCtx>,
) -> DynamicTool {
    let name = spec.name.clone();
    let definition = spec.tool_definition();
    DynamicTool::new(
        definition.name,
        definition.description,
        definition.input_schema,
        move |_context, args| {
            let spec = spec.clone();
            let name = name.clone();
            let batch = Arc::clone(&batch);
            let ctx = Arc::clone(&ctx);
            Box::pin(async move {
                // A missing, non-string, or blank prompt is refused up
                // front (#944 review Advisory A): the schema says
                // required, but providers do not enforce schemas against a
                // misbehaving model, and a sub-agent run on an empty task
                // spends up to a full step budget for nothing. The refusal
                // rides the same failed-row shape the batch cap uses.
                let task = match args.get("prompt").and_then(serde_json::Value::as_str) {
                    Some(task) if !task.trim().is_empty() => task.to_string(),
                    _ => {
                        let refusal = "delegation refused: no task prompt was provided".to_string();
                        land_delegation_entry(&ctx, &name, "", &refusal, false);
                        return Ok(rig_agent::tool::ToolOutput::text(refusal));
                    }
                };
                // The batch width cap (ADR-0117 Decision 5): the count is
                // per model-turn (the driver resets it at each turn's usage
                // record, which precedes the batch's committed calls and --
                // under the pinned sequential execution -- their callbacks).
                // A refused delegation lands its entry like the dispatch
                // server's loop-detector refusal: honest failed row, no
                // phase pair (the call never ran).
                let batch_index = batch.fetch_add(1, Ordering::SeqCst);
                if batch_index >= DELEGATION_BATCH_CAP {
                    let refusal = format!(
                        "delegation refused: this batch already carries \
                         {DELEGATION_BATCH_CAP} delegations (the cap); defer the task to a \
                         later batch or narrow the delegation"
                    );
                    land_delegation_entry(&ctx, &name, &task, &refusal, false);
                    return Ok(rig_agent::tool::ToolOutput::text(refusal));
                }
                emit_phase(
                    &ctx.phases,
                    TurnPhase::ToolCallStarted {
                        name: name.clone(),
                        operation_kind: OperationKind::Execute,
                        summary: delegation_summary(&task),
                    },
                );
                let report = run_subagent(&spec, &task, &ctx).await;
                let entry = land_delegation_entry(&ctx, &name, &task, &report.text, report.success);
                emit_phase(
                    &ctx.phases,
                    TurnPhase::ToolCallCompleted(crate::model::TraceEntryView::from(&entry)),
                );
                Ok(rig_agent::tool::ToolOutput::text(report.text))
            })
        },
    )
}

/// A sub-agent run's terminal report: the text the main model reads plus
/// the success flag the trace entry records (a failed run keeps its
/// excerpt in the failed-entry shape).
struct SubagentReport {
    text: String,
    success: bool,
}

/// Run one sub-agent to its terminal reply (ADR-0117 Decisions 2/4/5) and
/// map its exit onto the report text the main model reads. The sub-agent's
/// events fold locally (the nested sub-trace data; projected by #934),
/// with a no-op phase sink -- its thinking markers never interleave with
/// the main rail's step numbering -- while every inbound event re-arms the
/// turn's no-progress clock: sub-agent generation activity IS turn
/// progress, so the watchdog's cap times the whole turn including the
/// sub-agent's model calls (the un-layered wall clock of Decision 5).
async fn run_subagent(spec: &DelegationSpec, task: &str, ctx: &SubagentCtx) -> SubagentReport {
    // The sub-agent's PRIVATE completion channel (#944 review Critical 1):
    // its fold must only ever pair its own dispatches' entries. Recording
    // into the main channel left one blind FIFO with two consumer
    // families -- and because rig surfaces a batch's results only after
    // the whole batch settles, the sub fold stole the main loop's earlier
    // siblings' queued entries while the main fold could not yet drain
    // them (the main trace lost a row, another wore its identity, and the
    // count pairing stayed balanced).
    let channel = Arc::new(super::adapter::CompletionChannel::new());
    let tools = ctx
        .sub_face
        .iter()
        .cloned()
        .map(|def| {
            super::adapter::gateway_dynamic_tool(
                def,
                Arc::clone(&ctx.state),
                Arc::clone(&channel),
                ctx.dispatch.clone(),
            )
        })
        .collect::<Vec<_>>();
    let agent = AgentBuilder::new(ctx.model.clone())
        .preamble(subagent_preamble(spec).as_str())
        .max_tokens(ctx.max_tokens)
        .dynamic_tools(tools)
        .build();
    let prompt =
        super::model::to_rig_history(&[crate::provider::tool_calling::ToolTurnMessage::user(task)])
            .pop()
            .expect("a single user message always converts to exactly one");
    let mut stream = StreamingPromptRequest::from_agent(&agent, prompt)
        .max_turns(SUBAGENT_STEP_CAP)
        .tool_concurrency(1)
        .without_memory()
        .merge_additional_params(super::live::thought_level_params(
            ctx.protocol,
            ctx.thought_level.as_deref(),
        ))
        .add_hook(CancelWatcher::new(
            Arc::clone(&ctx.token),
            ctx.clock.clone(),
            Arc::clone(&ctx.state),
        ))
        .into_future()
        .await;
    let noop_sink: PhaseSink = Arc::new(Mutex::new(|_phase: TurnPhase| {}));
    let mut fold = EventFold::new();
    let exit: Result<(), StreamingError> = loop {
        match stream.next().await {
            None => break Ok(()),
            Some(Err(err)) => break Err(err),
            Some(Ok(item)) => {
                fold.event(&item, &channel, &noop_sink);
                if let Some(clock) = &ctx.clock {
                    clock.touch();
                }
            }
        }
    };
    fold.finish();
    // The folded rounds and any residual queued entries stay local to the
    // private channel and are dropped with it (the nested sub-trace
    // projection is #934's scope; before it lands, a sub-agent's internal
    // calls deliberately leave no main-trace accounting -- the delegation
    // entry is the sub-agent's one row). Promotions still ride the shared
    // list: a sub-agent's `result_N` lands on the working set regardless
    // of the sub-agent's fate.
    match exit {
        Ok(()) => match fold.final_output.take() {
            Some(text) => SubagentReport {
                text,
                success: true,
            },
            None => SubagentReport {
                text: "sub-agent failed: ended without a final report".to_string(),
                success: false,
            },
        },
        Err(err) => SubagentReport {
            text: subagent_failure_text(&err),
            success: false,
        },
    }
}

/// Map a sub-agent's structured run error onto the honest failure /
/// abort text (ADR-0117 Decision 5's vocabulary, mirrored from the main
/// loop's termination mapping but as tool-result text -- the main turn
/// keeps running). A cancel (the forwarded token) words itself as an
/// abort: the main loop's next checkpoint owns the Cancelled landing.
fn subagent_failure_text(err: &StreamingError) -> String {
    match err {
        StreamingError::Prompt(prompt) => match prompt.as_ref() {
            rig_agent::completion::PromptError::MaxTurnsError { .. } => format!(
                "sub-agent failed: did not converge within its {SUBAGENT_STEP_CAP}-step budget"
            ),
            rig_agent::completion::PromptError::PromptCancelled { reason, .. } => {
                format!("sub-agent aborted: {reason}")
            }
            rig_agent::completion::PromptError::CompletionError(err) => {
                format!("sub-agent failed: {err}")
            }
            rig_agent::completion::PromptError::UnknownToolCall { tool_name, .. } => {
                format!("sub-agent failed: attempted unknown tool `{tool_name}`")
            }
            // Structurally unreachable (`without_memory`), kept total.
            rig_agent::completion::PromptError::MemoryError(err) => {
                format!("sub-agent failed: conversation memory failed: {err}")
            }
        },
        StreamingError::Completion(err) => format!("sub-agent failed: {err}"),
    }
}

/// The delegation call's trace entry, landed through the same
/// record-before-send discipline the dispatch server applies: the entry is
/// queued and `recorded_calls` incremented BEFORE the result crosses back
/// to rig, so the main fold's result-event drain (or the finish-time
/// residual drain, if a cancellation abandoned the stream) pairs it
/// exactly once. A failed report keeps a bounded excerpt; a succeeded one
/// records the report's head (the final answer the sub-agent handed back
/// -- the one excerpt a reader of the trace actually wants).
fn land_delegation_entry(
    ctx: &SubagentCtx,
    name: &str,
    task: &str,
    report: &str,
    success: bool,
) -> TraceEntry {
    let entry = if success {
        TraceEntry::succeeded(
            next_call_id(),
            name.to_string(),
            OperationKind::Execute,
            delegation_summary(task),
            truncate_trace_excerpt(report, TRACE_EXCERPT_MAX),
        )
    } else {
        TraceEntry::failed(
            next_call_id(),
            name.to_string(),
            OperationKind::Execute,
            delegation_summary(task),
            truncate_trace_excerpt(report, TRACE_EXCERPT_MAX),
        )
    };
    ctx.state
        .main
        .completed
        .lock()
        .expect("completed lock poisoned")
        .push_back(entry.clone());
    ctx.state.main.recorded_calls.fetch_add(1, Ordering::SeqCst);
    entry
}

/// The call's summary (the argument digest the started phase, the trace
/// entry, and any approval card share): the task's head, bounded by the
/// trace excerpt cap.
fn delegation_summary(task: &str) -> String {
    truncate_trace_excerpt(task, TRACE_EXCERPT_MAX)
}

/// The per-turn sub-agent context over the turn's tool table: the shared
/// execution inputs plus the subtracted sub-face, computed once for the
/// whole family (every sub-agent of the turn sees the same face --
/// ADR-0117 Decision 4's "sub-face is a property of the turn").
#[allow(clippy::too_many_arguments)]
pub(crate) fn subagent_ctx(
    model: rig_agent::agent::ModelHandle,
    state: Arc<SharedTurnState>,
    dispatch: mpsc::Sender<DispatchRequest>,
    phases: PhaseSink,
    clock: Option<Arc<ProgressClock>>,
    token: Arc<CancelToken>,
    protocol: Option<crate::model::Protocol>,
    thought_level: Option<String>,
    max_tokens: u64,
    tools: &[ToolDefinition],
    delegation_names: &std::collections::BTreeSet<String>,
) -> Arc<SubagentCtx> {
    let names: std::collections::BTreeSet<&str> =
        delegation_names.iter().map(String::as_str).collect();
    Arc::new(SubagentCtx {
        model,
        state,
        dispatch,
        phases,
        clock,
        token,
        protocol,
        thought_level,
        max_tokens,
        sub_face: subagent_tool_face(tools, &names),
    })
}
