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
//! lands the turn as Cancelled exactly as it would without delegation; a
//! cancel that lands mid-call instead drops the delegation's future tree,
//! and the run's abandonment guard collects and lands the cancelled entry
//! before the drop finishes (PR #946 review Important 3) -- either way the
//! sub-agent's completed calls stay under the delegation entry.
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
//! fires. The sub-agent's own rounds hang under that entry as the NESTED
//! SUB-TRACE (ADR-0117 Decision 6, issue #934): its executed calls record
//! onto the sub-agent's PRIVATE completion channel, the run's local fold
//! drains it, and the fold's rounds ride the report onto the entry --
//! projected through the same slim projection the main rounds take, never
//! onto the main trace as flat rows. Their promotions ride the shared
//! promotion list.

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
use crate::session::loop_contract::{
    retain_landed_rounds, truncate_trace_excerpt, LoopRound, Termination, TraceEntry,
    TRACE_EXCERPT_MAX,
};
use crate::session::progress::ProgressClock;

use super::adapter::{emit_phase, next_call_id, DispatchRequest, PhaseSink, SharedTurnState};
use super::cancel::CancelWatcher;
use super::truncation;
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
    /// The #1001 cap stamp's PRESENCE (issue #1044): the sub-agent
    /// inherits the stamped cap VALUE through `max_tokens`, but the
    /// truncation re-attribution keys on the stamp's presence -- the
    /// bridged face's assembled default is not a #1001 cap, and its
    /// EOF-family faults keep the verbatim detail (#669).
    pub(crate) cap_stamped: bool,
    /// The subtracted face (ADR-0117 Decision 4, calibrated by ADR-0119
    /// Decision 4), precomputed once per turn: the turn's tool table minus
    /// every delegation tool minus `invoke_skill` (subagents stay excluded
    /// from the invocation channel; their skill path is the definition's
    /// skill-name marker injection).
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
                        land_delegation_entry(&ctx, &name, "", &refusal, false, Vec::new());
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
                    land_delegation_entry(&ctx, &name, &task, &refusal, false, Vec::new());
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
                let entry = land_delegation_entry(
                    &ctx,
                    &name,
                    &task,
                    &report.text,
                    report.success,
                    report.rounds,
                );
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
/// excerpt in the failed-entry shape), plus the run's round-grouped
/// trajectory -- the nested sub-trace (ADR-0117 Decision 6, issue #934)
/// that hangs under the delegation entry.
struct SubagentReport {
    text: String,
    success: bool,
    /// Every round the run's local fold accumulated, including entries the
    /// finish-time residual drain landed after a cancellation abandoned the
    /// event stream -- on EITHER cancel path: a checkpoint exit collects
    /// through `finish_run`, and a mid-call driver abandonment collects
    /// through the guard's Drop (PR #946 review Important 3) -- so a
    /// cancelled sub-agent's completed calls stay visible under the
    /// delegation entry instead of vanishing with the private channel
    /// (PR #944 review Advisory G).
    rounds: Vec<LoopRound>,
}

/// How the sub-agent's event stream ended, as the collection sees it: the
/// three honest exits plus the driver's abandonment (PR #946 review
/// Important 3 -- a token-requested cancel breaks the driver's biased
/// select and drops the whole tool-future tree while the delegation's
/// future is still pending; the guard's Drop is the only code that runs
/// then).
enum RunExit {
    /// The stream ended cleanly (with or without a final report).
    Done,
    /// The stream surfaced a structured error (the failure vocabulary).
    Failed(StreamingError),
    /// The driver dropped the future mid-run (a token-requested cancel).
    Abandoned,
}

/// The run's collection state, owned by the abandonment guard: the local
/// fold, the private channel, the promotions watermark, and the identity a
/// landed entry needs -- owned copies, no borrows, because its Drop runs
/// while the surrounding callback state is itself being torn down.
/// `armed` is the disarm flag: the normal path collects through the same
/// [`finish_run`] and disarms, so the Drop arm is exactly the abandoned
/// collection, nothing else.
struct SubagentRun {
    ctx: Arc<SubagentCtx>,
    name: String,
    task: String,
    channel: Arc<super::adapter::CompletionChannel>,
    promotions_before: usize,
    fold: EventFold,
    /// The driver's reader half of the finish-reason pair (issue #1044):
    /// read once the stream ends, to mark a Length-stopped final report.
    finish_record: truncation::FinishReasonRecord,
    armed: bool,
}

impl Drop for SubagentRun {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // The abandoned collection: land the cancelled entry so the
        // sub-agent's completed calls and promotions stay answerable (the
        // entry carries the drained sub-trace; the orphan note names the
        // promotions the working set keeps; PR #946 review Important 3).
        // No phase pair -- the same #921 posture the main finish's residual
        // drain takes; the main finish then pairs the landed entry.
        let report = finish_run(self, RunExit::Abandoned);
        land_delegation_entry(
            &self.ctx,
            &self.name,
            &self.task,
            &report.text,
            report.success,
            report.rounds,
        );
    }
}

/// Collect the run's terminal state -- shared by the normal exit and the
/// abandonment guard so the two paths cannot drift: finish the fold, drain
/// the private channel's residual recorded entries, drop the
/// landed-nothing rounds, and map the exit onto the report text. Every
/// failure arm carries the orphan note (PR #946 review Important 2 /
/// Advisory B): a failed run's already-landed promotions entered the
/// shared working set with no visible producer -- name them.
fn finish_run(run: &mut SubagentRun, exit: RunExit) -> SubagentReport {
    run.fold.finish();
    // A cancellation that abandoned the event stream mid-call leaves the
    // private channel's recorded entries queued with no result event ever
    // coming for them -- drain them onto the fold (the #921 residual-drain
    // posture the main finish applies; PR #944 review Advisory G), so the
    // cancelled sub-agent's completed calls still project under the
    // delegation entry.
    run.fold.drain_residual(&run.channel);
    // The same landed-round filter the main finish applies
    // (`retain_landed_rounds`): drop a round nothing landed on, so a batch
    // that confirmed but whose every call was gate-cancelled before dispatch
    // persists no empty ghost round under the delegation entry.
    retain_landed_rounds(&mut run.fold.rounds);
    let rounds = std::mem::take(&mut run.fold.rounds);
    // Promotions still ride the shared list: a sub-agent's `result_N` lands
    // on the working set regardless of the sub-agent's fate.
    let promoted = promoted_since(&run.ctx.state, run.promotions_before);
    // Read once, above the exit match: the Done arm owns the record
    // (the failure arms never consult it), and every arm sees the
    // same already-taken view.
    let finish_reason = run.finish_record.last();
    match exit {
        RunExit::Done => match run.fold.final_output.take() {
            // The final report's Length stop surfaces as the same explicit
            // marker the main reply mapping appends (issue #1044): the
            // report feeds back as tool text, so a cap-cut report must not
            // read as a finished one.
            Some(text) => SubagentReport {
                text: truncation::marked_reply(text, finish_reason.as_ref()),
                success: true,
                rounds,
            },
            None => SubagentReport {
                text: failure_text_with_orphans(
                    "sub-agent failed: ended without a final report",
                    &promoted,
                ),
                success: false,
                rounds,
            },
        },
        RunExit::Failed(err) => SubagentReport {
            text: failure_text_with_orphans(
                &subagent_failure_text(&err, run.ctx.cap_stamped),
                &promoted,
            ),
            success: false,
            rounds,
        },
        RunExit::Abandoned => SubagentReport {
            text: failure_text_with_orphans("sub-agent aborted: cancelled", &promoted),
            success: false,
            rounds,
        },
    }
}

/// The failure text carrying its orphan note (PR #944 review Advisory G).
/// The note rides the HEAD (PR #946 review Important 2): the excerpt
/// truncator keeps the head, so a tail-appended note was the first
/// casualty of any verbose failure body -- with the head placement every
/// trace surface (live card, persisted recipe, resumed view) still names
/// the promotions, and only the tool result the main model reads carries
/// the untruncated detail.
fn failure_text_with_orphans(base: &str, promoted: &[String]) -> String {
    if promoted.is_empty() {
        return base.to_string();
    }
    format!("(promoted before dying: {}) {base}", promoted.join(", "))
}

/// Run one sub-agent to its terminal reply (ADR-0117 Decisions 2/4/5) and
/// map its exit onto the report text the main model reads. The sub-agent's
/// events fold locally (the nested sub-trace data; projected by #934),
/// with a no-op phase sink -- its thinking markers never interleave with
/// the main rail's step numbering -- while every inbound event re-arms the
/// turn's no-progress clock: sub-agent generation activity IS turn
/// progress, so the watchdog's cap times the whole turn including the
/// sub-agent's model calls (the un-layered wall clock of Decision 5).
async fn run_subagent(spec: &DelegationSpec, task: &str, ctx: &Arc<SubagentCtx>) -> SubagentReport {
    // The promotions watermark for the orphan note (PR #944 review Advisory
    // G): a failed run names the result_N it promoted before dying -- they
    // entered the shared working set with no visible producer in the report.
    let promotions_before = ctx
        .state
        .promotions
        .lock()
        .expect("promotions lock poisoned")
        .len();
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
                // The originator annotation (issue #934): every sub-face
                // dispatch names its delegating sub-agent, so the approval
                // card reads "sub-agent X wants to call Y".
                Some(spec.name.clone()),
            )
        })
        .collect::<Vec<_>>();
    let agent = AgentBuilder::new(ctx.model.clone())
        .preamble(subagent_preamble(spec).as_str())
        .max_tokens(ctx.max_tokens)
        .dynamic_tools(tools)
        .build();
    let (finish_watcher, finish_record) = truncation::FinishReasonWatcher::new();
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
        // The finish-reason observer (issue #1044): the sub-agent's final
        // report feeds back to the main model as tool text, so how its
        // last turn stopped is read off the same hook seam the main loop's
        // watcher rides.
        .add_hook(finish_watcher)
        .into_future()
        .await;
    let noop_sink: PhaseSink = Arc::new(Mutex::new(|_phase: TurnPhase| {}));
    // The abandonment guard (PR #946 review Important 3): owns the fold,
    // the private channel, and the watermark so a mid-run drop still
    // collects and lands the cancelled entry. Constructed AFTER the stream
    // (so the normal path's disarm runs before the stream's own teardown)
    // and armed from the start -- the loop feeds the guard's fold, the
    // normal exit collects through the same `finish_run` and disarms.
    let mut run = SubagentRun {
        ctx: Arc::clone(ctx),
        name: spec.name.clone(),
        task: task.to_string(),
        channel: Arc::clone(&channel),
        promotions_before,
        fold: EventFold::new(),
        finish_record,
        armed: true,
    };
    let exit = loop {
        match stream.next().await {
            None => break RunExit::Done,
            Some(Err(err)) => break RunExit::Failed(err),
            Some(Ok(item)) => {
                run.fold.event(&item, &run.channel, &noop_sink);
                if let Some(clock) = &ctx.clock {
                    clock.touch();
                }
            }
        }
    };
    let report = finish_run(&mut run, exit);
    run.armed = false;
    report
}

/// The result names promoted since the `before` watermark (PR #944 review
/// Advisory G). The shared promotion list is append-only and the sub-agent
/// is the only promoter while it runs (sequential execution), so the tail
/// slice is exactly this run's promotions.
fn promoted_since(state: &SharedTurnState, before: usize) -> Vec<String> {
    state.promotions.lock().expect("promotions lock poisoned")[before..]
        .iter()
        .map(|p| p.dataset.reference_name.clone())
        .collect()
}

/// Map a sub-agent's structured run error onto the honest failure /
/// abort text (ADR-0117 Decision 5's vocabulary, mirrored from the main
/// loop's termination mapping but as tool-result text -- the main turn
/// keeps running). A cancel (the forwarded token) words itself as an
/// abort: the main loop's next checkpoint owns the Cancelled landing.
/// The completion arm rides the main loop's own termination mapping plus
/// the #1003 re-attribution (issue #1044): on a cap-stamped turn the
/// accumulator's EOF-family fault reads as the output truncation it is,
/// and the transient detail lands in the same wording the main turn
/// would -- while the not-wired / invalid-config classes carry no
/// transient text and keep the verbatim Display.
fn subagent_failure_text(err: &StreamingError, cap_stamped: bool) -> String {
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
        StreamingError::Completion(err) => match truncation::reattribute_tool_input_truncation(
            super::termination_for_completion(err),
            cap_stamped,
        ) {
            Termination::Transient(detail) => format!("sub-agent failed: {detail}"),
            _ => format!("sub-agent failed: {err}"),
        },
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
    rounds: Vec<LoopRound>,
) -> TraceEntry {
    let mut entry = if success {
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
    // The nested sub-trace (ADR-0117 Decision 6, issue #934): the sub-agent's
    // rounds hang under the delegation entry. Absent when the run produced
    // none -- a refused (blank prompt / batch cap) or never-started
    // delegation carries no sub-trace, so no empty placeholder persists.
    if !rounds.is_empty() {
        entry.sub_trace = Some(rounds);
    }
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
    cap_stamped: bool,
    tools: &[ToolDefinition],
    delegation_names: &std::collections::BTreeSet<&str>,
) -> Arc<SubagentCtx> {
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
        cap_stamped,
        sub_face: subagent_tool_face(tools, delegation_names),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The orphan note survives the excerpt cap on a verbose failure body
    /// (PR #946 review Important 2): the note rides the HEAD of the failure
    /// text and the truncator keeps the head, so the bounded excerpt every
    /// trace surface records still names the promotion -- where the retired
    /// tail placement lost it to the cut. The no-orphans half: a clean
    /// failure text passes through unchanged.
    #[test]
    fn the_orphan_note_survives_excerpt_truncation() {
        let verbose = format!("sub-agent failed: {}", "payload ".repeat(120));
        let with_note = failure_text_with_orphans(&verbose, &["result_2".to_string()]);
        let excerpt = truncate_trace_excerpt(&with_note, TRACE_EXCERPT_MAX);
        assert!(
            excerpt.contains("promoted before dying: result_2"),
            "the note leads the excerpt: {excerpt}"
        );
        let clean =
            failure_text_with_orphans("sub-agent failed: ended without a final report", &[]);
        assert_eq!(
            clean, "sub-agent failed: ended without a final report",
            "no orphans: the base text rides untouched"
        );
    }
}
