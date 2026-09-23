//! The loop-runtime integration layer (ADR-0116, issue #917): the in-process
//! agent-loop runtime built on rig (rig-core + rig-agent). It replaced a
//! linked-in loop crate whose 0.18 wire defects (batched `tool_result`
//! splitting, thinking-loss 400s) made it unservable; ADR-0116 records the
//! full decision. Borrow the kernel, not
//! the framework: rig's completion / streaming / tool surfaces drive; rig's
//! hooks carry two (the cancel watcher's checkpoints and the passive
//! finish-reason observer), memory is absent
//! (`without_memory` semantics -- the app owns the window), `ToolContext`
//! stays blank, and model selection is the single model this runtime was
//! built with.
//!
//! Threading: the session's dispatch
//! collaborators (`TurnDeps`, materializer, `McpAggregator`) are not `Sync`
//! and never leave the caller's thread, so `run` serves dispatch requests
//! on the caller's thread (through the shared `dispatch_gated_call` core)
//! while a scoped driver thread runs the rig loop on a dedicated
//! single-threaded runtime (issue #321 constraint kept). Only owned data
//! crosses: channels + shared state.
//!
//! Naming is deliberately neutral (`LoopRuntime`, `loop_runtime/`): the
//! upstream's name never escapes this module (ADR-0116 Decision 7), so the
//! NEXT runtime swap, if any, touches no type or path outside it.
//!
//! Wired since the swap slice (issue #918): `turn_loop_for` (in `live`)
//! is the wiring seam's single entry -- live facts construct the real
//! upstream model with the app-injected no-redirect client; facts-less
//! providers bridge onto the completion face.

mod adapter;
mod cancel;
mod fold;
mod live;
mod model;
mod subagent;
mod truncation;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use futures::StreamExt;
use rig_agent::agent::{
    AgentBuilder, ModelHandle, MultiTurnStreamItem, StreamingError, StreamingPromptRequest,
};
use rig_agent::completion::PromptError;
use std::future::IntoFuture;

use crate::cancel::CancelToken;
use crate::mcp::aggregator::McpAggregator;
use crate::model::TurnPhase;
use crate::provider::tool_calling::ToolTurnRequest;
use crate::session::loop_contract::{
    retain_landed_rounds, truncate_trace_excerpt, LoopOutcome, Termination, TraceEntry,
    DEFAULT_NO_PROGRESS_CAP, DEFAULT_STEP_CAP, TRACE_EXCERPT_MAX,
};
use crate::session::materializer::{Materializer, TurnDeps};
use crate::session::progress::ProgressClock;
use crate::session::turn_dispatch::{
    classify_call, dispatch_gated_call, panic_to_transient, DispatchAbort, GateCtx,
};

use adapter::{DispatchOutcome, DispatchRequest, PhaseSink, SharedTurnState};
use cancel::CancelWatcher;
use fold::EventFold;
use model::INVALID_CONFIG_PREFIX;

pub(crate) use live::turn_loop_for;

/// The per-turn loop runner (rig-backed).
/// Built per turn (cheap): the erased model handle and the
/// two execution-level caps.
pub(crate) struct LoopRuntime {
    model: ModelHandle,
    step_cap: u32,
    no_progress_cap: Option<Duration>,
    /// The live face's protocol: the posture's thought level renders onto
    /// the wire in a protocol-specific shape (anthropic thinking budget vs
    /// openai reasoning effort, ADR-0103 / #918), while the bridged face
    /// (`None`) carries it under an app-private key instead.
    protocol: Option<crate::model::Protocol>,
    /// The live face's stamped output cap (issue #1001): the
    /// [`provider::output_cap`] formula's answer for the model, computed
    /// at the live factory from the same facts that built the model
    /// handle -- the cap can never drift from the model actually
    /// serving the turn. `None` on the bridged face: the request keeps
    /// its assembled cap (the window's model-blind default; tests script
    /// their own).
    output_cap: Option<u32>,
}

impl LoopRuntime {
    /// Default caps (step cap 24, no-progress cap 120s, ADR-0081).
    pub(crate) fn new(model: ModelHandle) -> Self {
        Self {
            model,
            step_cap: DEFAULT_STEP_CAP,
            no_progress_cap: Some(DEFAULT_NO_PROGRESS_CAP),
            protocol: None,
            output_cap: None,
        }
    }

    /// The live construction -- the live factory's three inputs in one step
    /// (the model handle, the wire-shape protocol the thought level
    /// renders into, and the model-keyed output cap the drive stamps onto
    /// the request), so no half-stamped live runtime exists between them
    /// (issue #926; the cap rides the same step since #1001; the bridged /
    /// mock faces keep [`LoopRuntime::new`]'s stamp-less shape).
    pub(crate) fn live(
        model: ModelHandle,
        protocol: crate::model::Protocol,
        output_cap: u32,
    ) -> Self {
        Self {
            protocol: Some(protocol),
            output_cap: Some(output_cap),
            ..Self::new(model)
        }
    }

    /// Override the caps (the test seam). Test-only at the call sites: the
    /// production wiring always runs the ADR-0081 defaults.
    #[allow(dead_code)]
    pub(crate) fn with_caps(mut self, step_cap: u32, no_progress_cap: Option<Duration>) -> Self {
        self.step_cap = step_cap;
        self.no_progress_cap = no_progress_cap;
        self
    }

    /// Stamp an output cap onto the bridged face (the test seam for the
    /// dispatch-stamp pin, issue #1001): production reaches the stamp only
    /// through the live factory, so this exists for the module suite to
    /// drive a stamped runtime against the scripted bridge. Test-only at
    /// the call sites; mirrors [`Self::with_caps`]'s posture.
    #[allow(dead_code)]
    pub(crate) fn with_output_cap(mut self, output_cap: u32) -> Self {
        self.output_cap = Some(output_cap);
        self
    }

    /// The bridged construction -- the module's factory for an app provider
    /// behind the rig completion face. No rig type crosses this signature,
    /// so the #918 wiring seam names nothing upstream (ADR-0116 Decision 7's
    /// closure extends to construction).
    pub(crate) fn bridged(provider: Arc<dyn crate::provider::Provider>) -> Self {
        Self::new(ModelHandle::new(model::ProviderCompletionModel::new(
            provider,
        )))
    }

    /// Drive one agent turn through the rig loop: serve gateway dispatches
    /// on this thread while the driver thread runs the loop, then fold the
    /// event stream into the round-grouped trace and derive the termination
    /// -- the single-in-flight + watchdog + panic-guard contract
    /// (ADR-0021/0081, issue #321). `delegations` is the turn's enabled
    /// agent-definition snapshot (issue #933): every spec whose name the
    /// request's tool table advertises becomes a named delegation tool --
    /// the sub-agent runs on the driver's runtime while its own dispatches
    /// keep crossing to THIS thread's server, so approval / audit /
    /// promotion stay identical by construction.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn run(
        &self,
        request: &ToolTurnRequest,
        deps: &mut TurnDeps,
        materializer: &mut dyn Materializer,
        mcp: &mut McpAggregator,
        cli: &[crate::cli_tools::config::CliToolConfig],
        delegations: &[crate::agents::DelegationSpec],
        invocations: &mut crate::skills::invocation::SkillInvocationCtx<'_>,
        read: &crate::skills::read::SkillReadGate<'_>,
        create: &crate::skills::create::SkillCreateGate<'_>,
        approval: &crate::approval::ApprovalState,
        sink: &dyn crate::approval::ApprovalSink,
        cancel: Arc<CancelToken>,
        on_phase: impl FnMut(TurnPhase) + Send + 'static,
    ) -> LoopOutcome {
        // In-flight + stale-request reset (ADR-0021): every exit drops the
        // guard, which invalidates the watchdog.
        let guard = cancel.begin_turn();
        let phases: PhaseSink = Arc::new(Mutex::new(on_phase));
        let state = Arc::new(SharedTurnState::new());
        let (req_tx, req_rx) = mpsc::channel::<DispatchRequest>();
        // Wakes the driver when the app token requests cancel -- the select
        // leg that covers the silence between hook checkpoints (a
        // whole-message model call fires no deltas, so the watcher hook
        // alone would only stop the loop at the NEXT model-call boundary).
        let notify = Arc::new(tokio::sync::Notify::new());
        // Releases the watcher once the drive is over (a normal run never
        // cancels, so the watcher needs a second exit condition or it would
        // outlive the scope).
        let drive_done = Arc::new(AtomicBool::new(false));

        std::thread::scope(|scope| {
            // Cancel watcher thread (ADR-0116 Decision 3's poll bridge, the
            // rig shape): the app token is poll-based, so a scoped thread
            // watches it at 25ms -- the order of the UI's cancel round-trip;
            // dispatch-side cancellation is immediate regardless (the gate
            // and the tool executors honor the app token directly).
            {
                let token = Arc::clone(&cancel);
                let notify = Arc::clone(&notify);
                let done = Arc::clone(&drive_done);
                scope.spawn(move || {
                    while !done.load(Ordering::SeqCst) {
                        if token.is_requested() {
                            notify.notify_one();
                            return;
                        }
                        thread::sleep(Duration::from_millis(25));
                    }
                });
            }
            // No-progress watchdog (ADR-0115): the cap times ONLY the
            // generation segment -- the fold's stream activity re-arms it
            // (touch), and the dispatch server below freezes it across
            // gateway tool executions / CLI tool runs / approval pendings.
            // The watcher hook reads the latched clock to fork the stop
            // reason, and the termination derivation below lands the turn
            // as Cancelled -- or NoProgress when the clock fired.
            let clock = self.no_progress_cap.map(|timeout| {
                ProgressClock::arm_and_publish(guard.generation(), &cancel, timeout)
            });
            // The driver: one scoped thread owning a dedicated single-thread
            // runtime. The dispatch server below outlives it -- its request
            // channel closes when the driver's context (and with it every
            // tool callback) drops, which ends the server loop; the join
            // order cannot deadlock.
            let driver = {
                let model = self.model.clone();
                let state = Arc::clone(&state);
                let phases = Arc::clone(&phases);
                let notify = Arc::clone(&notify);
                let req_tx = req_tx.clone();
                let request = request.clone();
                let step_cap = self.step_cap;
                let protocol = self.protocol;
                let output_cap = self.output_cap;
                let clock = clock.clone();
                let token = Arc::clone(&cancel);
                // Keyed by name (issue #945): the map IS the name set --
                // the driver's tool-table split reads it directly, no
                // parallel `BTreeSet` to keep in step.
                let delegations: std::collections::BTreeMap<String, crate::agents::DelegationSpec> =
                    delegations
                        .iter()
                        .cloned()
                        .map(|spec| (spec.name.clone(), spec))
                        .collect();
                scope.spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt,
                        Err(e) => {
                            let fold = EventFold::new();
                            *state.aborted.lock().expect("aborted lock poisoned") = Some(
                                Termination::Transient(format!("loop runtime build failed: {e}")),
                            );
                            return DriveOutcome {
                                fold,
                                exit: DriveExit::Done,
                                finish_reason: None,
                            };
                        }
                    };
                    runtime.block_on(drive_turn(DriveInputs {
                        model,
                        request,
                        state: Arc::clone(&state),
                        phases,
                        notify,
                        req_tx,
                        step_cap,
                        protocol,
                        output_cap,
                        clock: clock.clone(),
                        token,
                        delegations,
                    }))
                })
            };
            // Drop THIS thread's sender: the server loop below ends when the
            // driver's tool callbacks (the only remaining senders) drop --
            // holding the original here would keep `req_rx` open past the
            // run and deadlock the join below.
            drop(req_tx);
            // The dispatch server: THIS thread, so the session's non-Sync
            // collaborators never cross threads. The issue #321 guard lives
            // inside the shared `dispatch_gated_call` core (snapshot + ghost
            // rollback + honest Transient), so a dispatch panic surfaces here
            // as a pre-derived `DispatchAbort::Panic`.
            let gate = GateCtx {
                approval,
                sink,
                cancel: &cancel,
            };
            let mut detector = LoopDetector::default();
            for DispatchRequest {
                call,
                channel,
                origin,
                resp,
            } in req_rx
            {
                // Mid-batch stop check -- the per-call cancel gate: the rig
                // executor checks neither cancel nor steering BETWEEN the
                // calls of one batch, so once the turn is over (a user
                // cancel, a gate cancel, or a dispatch panic) the remaining
                // queued calls must be answered, not run. The
                // GateCancelled answer routes the callback onto its cancel
                // path (latches the shared state, feeds an inert result
                // back) so the executor drains without anything dispatching
                // for real -- break-on-cancel semantics.
                if state.turn_over(&cancel) {
                    let _ = resp.send(DispatchOutcome::GateCancelled);
                    continue;
                }
                // The identical-arguments screen (#918): a call the
                // detector refuses never dispatches -- the refusal text
                // rides back as the error result the model self-corrects
                // from (ADR-0028), recorded as the call's failed trace
                // entry so every model-issued call keeps an honest row.
                let (refusal, abort) = match detector.screen(&call) {
                    ScreenDecision::Dispatch => (None, None),
                    ScreenDecision::Steer(text) => (Some(text), None),
                    ScreenDecision::Abort {
                        refusal,
                        termination,
                    } => (Some(refusal), Some(termination)),
                };
                if let Some(refusal) = refusal {
                    if let Some(termination) = abort {
                        *state.aborted.lock().expect("aborted lock poisoned") = Some(termination);
                    }
                    let (_, operation_kind, summary) = classify_call(&call);
                    channel
                        .completed
                        .lock()
                        .expect("completed lock poisoned")
                        .push_back(TraceEntry::failed(
                            call.id.clone(),
                            call.name.clone(),
                            operation_kind,
                            summary,
                            truncate_trace_excerpt(&refusal, TRACE_EXCERPT_MAX),
                        ));
                    channel.recorded_calls.fetch_add(1, Ordering::SeqCst);
                    let result = crate::provider::tool_calling::ToolResult {
                        tool_use_id: call.id.clone(),
                        content: refusal,
                        is_error: true,
                    };
                    if resp.send(DispatchOutcome::Done { result }).is_err() {
                        break;
                    }
                    continue;
                }
                let phases = Arc::clone(&phases);
                let mut forward = |phase: TurnPhase| adapter::emit_phase(&phases, phase);
                // Freeze across the dispatch (ADR-0115): a gateway tool
                // execution, a CLI tool's run, or an approval pending on the
                // condvar is a wait on an external principal -- never billed
                // to the generation cap.
                let _frozen = clock.as_ref().map(|c| c.freeze());
                let outcome = match dispatch_gated_call(
                    &call,
                    deps,
                    materializer,
                    mcp,
                    cli,
                    invocations,
                    read,
                    create,
                    &gate,
                    &mut forward,
                    origin.as_deref(),
                ) {
                    Err(DispatchAbort::Gate) => DispatchOutcome::GateCancelled,
                    Err(DispatchAbort::Panic(termination)) => DispatchOutcome::Aborted(termination),
                    Ok((result, entry, promotion)) => {
                        // Record-before-send (#921): the executed
                        // call's trace entry and promotion land on the
                        // shared state HERE, on the executing thread, before
                        // the reply crosses -- strictly ahead of any
                        // driver-side cancellation that abandons the
                        // callback's post-`spawn_blocking` async segment.
                        // The interrupted call still accounts; the fold
                        // drains its entry by result event, or the finish
                        // drains the queue the abandoned stream left.
                        if let Some(entry) = entry {
                            channel
                                .completed
                                .lock()
                                .expect("completed lock poisoned")
                                .push_back(entry);
                            channel.recorded_calls.fetch_add(1, Ordering::SeqCst);
                        }
                        if let Some(promotion) = promotion {
                            state
                                .promotions
                                .lock()
                                .expect("promotions lock poisoned")
                                .push(promotion);
                        }
                        DispatchOutcome::Done { result }
                    }
                };
                // A closed response channel means the driver is gone; the
                // remaining requests are dropped with it.
                if resp.send(outcome).is_err() {
                    break;
                }
            }
            // Termination derivation: an honest abort (a dispatch/driver
            // panic, issue #321) wins first -- its detail carries more than
            // a bare Cancelled would; then cancel (a cancel that arrived
            // during the run wins over any reply, ADR-0021); then the run's
            // own exit -- its error vocabulary mapped, else the reply.
            let joined = driver.join();
            // A driver panic swaps in a fresh fold below: the finish-time
            // pairing assert is exempted for the replacement (#321).
            let fold_replaced = joined.is_err();
            let DriveOutcome {
                mut fold,
                exit,
                finish_reason,
            } = joined.unwrap_or_else(|payload| {
                *state.aborted.lock().expect("aborted lock poisoned") =
                    Some(panic_to_transient("loop runtime driver", &*payload));
                DriveOutcome {
                    fold: EventFold::new(),
                    exit: DriveExit::Done,
                    finish_reason: None,
                }
            });
            // Release the watcher thread: the drive is over, its notify
            // would be inert (the exit below decides), and it must not
            // outlive the scope.
            drive_done.store(true, Ordering::SeqCst);
            if let Some(termination) = state.aborted.lock().expect("aborted lock poisoned").take() {
                return finish(fold, &state, termination, fold_replaced);
            }
            if state.turn_over(&cancel) {
                // ADR-0115: the clock latches whether the cancel is the
                // watchdog's (generation silence past the cap) or a user /
                // close cancel -- same landing, different reason.
                return finish(
                    fold,
                    &state,
                    ProgressClock::cancel_landing(clock.as_ref()),
                    fold_replaced,
                );
            }
            let termination = match exit {
                // The select race abandoned the wait -- the token is
                // requested (that is the only thing it races on).
                DriveExit::Abandoned => ProgressClock::cancel_landing(clock.as_ref()),
                DriveExit::Error(err) => match err {
                    StreamingError::Prompt(err) => {
                        termination_for_prompt(&err, self.step_cap, clock.as_ref())
                    }
                    // The tool-input truncation shape (issue #1003): rig's
                    // accumulator pre-empts the completion event that carried
                    // the Length bit, so the parse error is the only trace of
                    // the cap cut -- re-attributed on cap-stamped runs (the
                    // live face and the test seam; the bridged production
                    // face keeps `None` and its verbatim detail).
                    StreamingError::Completion(err) => {
                        truncation::reattribute_tool_input_truncation(
                            termination_for_completion(&err),
                            self.output_cap.is_some(),
                        )
                    }
                },
                DriveExit::Done => match fold.final_output.take() {
                    // The terminal reply's Length stop surfaces as an
                    // explicit marker (issue #1003), not a silent success.
                    Some(text) => truncation::terminal_reply(text, finish_reason.as_ref()),
                    None => {
                        Termination::Transient("loop runtime ended without a reply".to_string())
                    }
                },
            };
            finish(fold, &state, termination, fold_replaced)
        })
    }
}

/// The identical-arguments loop detector (issue #918, the #920-review-I4
/// disposition): steer-then-abort ported to the dispatch seam. rig offers
/// neither loop detection nor a mid-run message-injection surface for a
/// steer nudge, so the steer
/// rides the ADR-0028 error channel instead -- the call is genuinely
/// refused, its refusal text feeds back for self-correction -- and the
/// repeat after that nudge latches an honest abort the cancel watcher
/// stops the run with, long before the step cap burns the API budget.
/// Detector state is per-turn and owned by the dispatch server's thread --
/// plain fields, no locking.
///
/// Counting is per (tool name, argument signature), accumulated over the
/// whole turn rather than reset by interleaving: a single last-signature
/// streak (any different call resets the count) lets a mixed batch
/// re-issuing [A, B] every round evade detection though it is just as
/// stuck (found by the merged-batch wire pin running to the step cap) --
/// so a sibling call with different arguments must not erase another
/// signature's history.
#[derive(Default)]
struct LoopDetector {
    /// Per (tool name, argument signature): that pair's counting state.
    calls: std::collections::HashMap<(String, String), CallState>,
}

/// One exact call's counting state: the arrival counter alone -- the
/// steer/abort fork is derived from it at screen time (issue #930), so
/// there is no steer latch to keep coherent with the count.
#[derive(Default)]
struct CallState {
    /// Arrivals this turn.
    arrivals: u32,
}

/// Refuse first at this many arrivals of one exact call.
const IDENTICAL_STEER_AT: u32 = 3;

/// One screened call's verdict: dispatch it, steer it (first refusal --
/// the text feeds back as the error result the model self-corrects from),
/// or abort (the repeat after the nudge -- the refusal feeds back AND the
/// termination latches for the watcher to stop the run at its next
/// checkpoint).
enum ScreenDecision {
    Dispatch,
    Steer(String),
    Abort {
        refusal: String,
        termination: Termination,
    },
}

impl LoopDetector {
    /// Screen one call against the identical-arguments history (issue
    /// #926: the verdict is a flat three-state enum, not a nested Option).
    fn screen(&mut self, call: &crate::provider::tool_calling::ToolUse) -> ScreenDecision {
        let signature = serde_json::to_string(&call.input).unwrap_or_default();
        let key = (call.name.clone(), signature);
        let state = self.calls.entry(key).or_default();
        state.arrivals += 1;
        let repetitions = state.arrivals;
        if repetitions < IDENTICAL_STEER_AT {
            return ScreenDecision::Dispatch;
        }
        let tool_name = call.name.as_str();
        if repetitions == IDENTICAL_STEER_AT {
            // First refusal (the count's first crossing of the threshold
            // -- arrivals is monotonic, so this arm holds exactly once per
            // key): the steer -- the call does not run, the text routes
            // back as the error result the model can self-correct from
            // (ADR-0028).
            ScreenDecision::Steer(format!(
                "tool call refused: `{tool_name}` was called {repetitions} times with \
                 identical arguments. The result will not change -- change approach, or \
                 say why the repetition is needed."
            ))
        } else {
            // The repeat after the nudge: the honest abort, latched for
            // the watcher to stop the run at its next checkpoint.
            ScreenDecision::Abort {
                refusal: format!(
                    "tool call refused: the run was stopped -- `{tool_name}` was called \
                     {repetitions} times with identical arguments after being asked to \
                     change approach"
                ),
                termination: Termination::Transient(format!(
                    "loop detection aborted the run: `{tool_name}` repeated {repetitions} \
                     times with identical arguments after being asked to change approach"
                )),
            }
        }
    }
}

/// Everything the driver thread needs, bundled so the spawn site stays
/// readable. Owned data only (the non-`Sync` session collaborators stay on
/// the caller thread).
struct DriveInputs {
    model: ModelHandle,
    request: ToolTurnRequest,
    state: Arc<SharedTurnState>,
    phases: PhaseSink,
    notify: Arc<tokio::sync::Notify>,
    req_tx: mpsc::Sender<DispatchRequest>,
    step_cap: u32,
    /// The live face's protocol (thought-level wire rendering); `None` on
    /// the bridged face.
    protocol: Option<crate::model::Protocol>,
    /// The live face's stamped output cap (issue #1001); `None` on the
    /// bridged face -- the assembled cap stands.
    output_cap: Option<u32>,
    /// The turn's no-progress clock (ADR-0115): the fold touches it on every
    /// inbound stream event -- the generation segment's liveness signal.
    clock: Option<Arc<ProgressClock>>,
    token: Arc<CancelToken>,
    /// The turn's delegation specs (issue #933), keyed by name: owned
    /// copies matched directly against the request's tool table. The map
    /// IS the name set -- no parallel `BTreeSet` to keep in step (the
    /// sub-agent context, built on the driver, derives its names from the
    /// keys).
    delegations: std::collections::BTreeMap<String, crate::agents::DelegationSpec>,
}

/// How the driver's consumption loop ended.
enum DriveExit {
    /// The event stream closed (the run finished -- success or its error
    /// surfaced through the stream's items, which the fold recorded).
    Done,
    /// The stream yielded an error item (the run failed).
    Error(StreamingError),
    /// The select race abandoned the wait: the app token requested cancel
    /// while the stream was silent (no checkpoint could fire).
    Abandoned,
}

/// The driver's product: the event fold plus its exit cause, plus the
/// last model turn's finish reason (the hook seam's record, issue #1003)
/// -- `None` when no turn completed, the reason went unreported, or a
/// driver panic replaced the outcome (the record dies with its thread).
struct DriveOutcome {
    fold: EventFold,
    exit: DriveExit,
    finish_reason: Option<rig_core::completion::FinishReason>,
}

/// Drive the rig loop: build the agent (preamble + gateway tools + the one
/// cancel hook), open the streaming prompt request over the app-assembled
/// history, and fold the event stream as it arrives -- racing the cancel
/// notification for the silent stretches.
async fn drive_turn(inputs: DriveInputs) -> DriveOutcome {
    let DriveInputs {
        model,
        mut request,
        state,
        phases,
        notify,
        req_tx,
        step_cap,
        protocol,
        output_cap,
        clock,
        token,
        delegations,
    } = inputs;
    // The dispatch seam's cap stamp (issue #1001), the thought-level
    // stamp's #614 shape: the window assembled a model-blind default, and
    // the agent-build point -- the one place holding the model-keyed cap
    // -- rewrites it once, ahead of BOTH consumers (the main agent's
    // builder and the sub-agent context, which inherits the main
    // request's cap). `None` (the bridged face) keeps the assembled cap.
    if let Some(cap) = output_cap {
        request.max_tokens = cap;
    }
    // The whole windowed conversation rides the request (the app assembled
    // it; the loop runtime re-feeds it verbatim) split at rig's boundary:
    // the LAST message is the prompt, everything before it the history. An
    // empty request is a contract violation by the caller -- surfaced as an
    // honest transient rather than a slice-underflow panic misattributed to
    // the runtime.
    let (prompt, history) = match request.messages.split_last() {
        Some((last, rest)) => {
            let prompt = model::to_rig_history(std::slice::from_ref(last))
                .pop()
                .expect("a single message always converts to exactly one");
            (prompt, model::to_rig_history(rest))
        }
        None => {
            return DriveOutcome {
                fold: EventFold::new(),
                finish_reason: None,
                exit: DriveExit::Error(StreamingError::Completion(
                    rig_core::completion::CompletionError::ProviderError(
                        "empty turn request: no prompt message".to_string(),
                    ),
                )),
            };
        }
    };
    // The face split (issue #933, ADR-0117 Decision 1): every advertised
    // definition whose name a delegation spec owns becomes a named
    // delegation tool; everything else stays a gateway adapter. The
    // delegation counter is per model-turn -- reset at each turn's usage
    // record below (the boundary that precedes the batch's committed
    // calls), so the batch width cap counts exactly one model-turn's
    // delegations under the pinned sequential execution.
    let delegation_batch = Arc::new(AtomicUsize::new(0));
    let gateway = |def| {
        adapter::gateway_dynamic_tool(
            def,
            Arc::clone(&state),
            Arc::clone(&state.main),
            req_tx.clone(),
            // A main-loop dispatch carries no originator -- only a
            // sub-agent's sub-face names one (issue #934).
            None,
        )
    };
    // The empty family keeps the zero-cost posture (issue #945): no
    // sub-agent context (whose construction clones the whole tool table
    // into the sub-face), no per-name lookups -- straight gateway
    // adapters. A non-empty family builds the context ONCE here, for the
    // whole family (ADR-0117 Decision 4's "sub-face is a property of the
    // turn"); the clock rides it too -- a sub-agent's generation activity
    // is turn progress, so its inbound events re-arm the same un-layered
    // watchdog (Decision 5). The context's dispatch-channel sender is
    // cloned from this scope's `req_tx` -- both drop when the drive ends,
    // so the dispatch server below observes channel close and exits
    // (#933's join order).
    let tools = if delegations.is_empty() {
        request
            .tools
            .iter()
            .cloned()
            .map(&gateway)
            .collect::<Vec<_>>()
    } else {
        let delegation_names: std::collections::BTreeSet<&str> =
            delegations.keys().map(String::as_str).collect();
        let subagent_ctx = subagent::subagent_ctx(
            model.clone(),
            Arc::clone(&state),
            req_tx.clone(),
            Arc::clone(&phases),
            clock.clone(),
            Arc::clone(&token),
            protocol,
            request.thought_level.clone(),
            request.max_tokens as u64,
            &request.tools,
            &delegation_names,
        );
        request
            .tools
            .iter()
            .cloned()
            .map(|def| match delegations.get(&def.name) {
                Some(spec) => subagent::delegation_dynamic_tool(
                    spec.clone(),
                    Arc::clone(&delegation_batch),
                    Arc::clone(&subagent_ctx),
                ),
                None => gateway(def),
            })
            .collect::<Vec<_>>()
    };
    let agent = AgentBuilder::new(model)
        .preamble(request.system.as_str())
        .max_tokens(request.max_tokens as u64)
        .dynamic_tools(tools)
        .build();
    let (finish_watcher, finish_record) = truncation::FinishReasonWatcher::new();
    let mut stream = StreamingPromptRequest::from_agent(&agent, prompt)
        .history(history)
        .max_turns(step_cap as usize)
        // ADR-0103 (#918): the posture's thought level rides the request
        // in the protocol's wire shape (anthropic budget / openai effort)
        // or, on the bridged face, an app-private key the completion-model
        // bridge reads back.
        .merge_additional_params(live::thought_level_params(
            protocol,
            request.thought_level.as_deref(),
        ))
        .tool_concurrency(1)
        // Memoryless by construction, stated explicitly: the app owns the
        // windowed history (ADR-0116 Decision 2), so rig's session memory
        // stays off the run (the MemoryError arm of the terminal mapping is
        // unreachable).
        .without_memory()
        .add_hook(CancelWatcher::new(token, clock.clone(), Arc::clone(&state)))
        // The finish-reason observer (issue #1003): the run-level response
        // carries no top-level reason, so the driver learns how the (last)
        // turn stopped off the hook seam -- the same registration the
        // cancel watcher rides.
        .add_hook(finish_watcher)
        .into_future()
        .await;
    let mut fold = EventFold::new();
    let exit = loop {
        tokio::select! {
            biased;
            _ = notify.notified() => break DriveExit::Abandoned,
            item = stream.next() => {
                match item {
                    None => break DriveExit::Done,
                    Some(Err(err)) => break DriveExit::Error(err),
                    Some(Ok(item)) => {
                        // The delegation batch boundary (issue #933): each
                        // turn's usage record arrives exactly once per
                        // model turn and BEFORE the turn's committed calls,
                        // so resetting the counter here scopes it to one
                        // model-turn's batch.
                        if matches!(item, MultiTurnStreamItem::CompletionCall(_)) {
                            delegation_batch.store(0, Ordering::SeqCst);
                        }
                        fold.event(&item, &state.main, &phases);
                        // Inbound stream activity (ADR-0115): re-arm the
                        // no-progress clock.
                        if let Some(clock) = &clock {
                            clock.touch();
                        }
                    }
                }
            }
        }
    };
    // The stream is over: land whatever the last turn left waiting (a
    // thinking-only terminal reply's trailing round).
    fold.finish();
    DriveOutcome {
        fold,
        exit,
        finish_reason: finish_record.last(),
    }
}

/// Assemble the final [`LoopOutcome`]: drain the completed queue a cancellation may have
/// left behind (the executed-but-unconsumed calls, #921), drop rounds
/// nothing landed on, carry promotions in dispatch order, and report no
/// discovered runtime (the built-in protocol surface has no handshake
/// catalog, ADR-0095).
fn finish(
    mut fold: EventFold,
    state: &Arc<SharedTurnState>,
    termination: Termination,
    fold_replaced: bool,
) -> LoopOutcome {
    let drained = fold.drain_residual(&state.main);
    let recorded_calls = state.main.recorded_calls.load(Ordering::SeqCst);
    // The pairing is scoped to the MAIN channel (#944 review Critical 1):
    // every sub-agent runs on a private channel whose entries never cross
    // here, so this assert covers the main fold's own dispatches and the
    // delegation entries alone.
    // A driver panic swaps in a fresh fold: the entries the dead fold had
    // already landed go with it (#321's honest Transient landing), so the
    // exactly-once pairing has no baseline to check against -- the drain
    // above still salvages the residual queue onto the fresh fold.
    debug_assert!(
        fold_replaced || fold.landed_calls == recorded_calls,
        "every executed call's trace entry must land exactly once: {recorded_calls} recorded, {} landed by result event, {drained} drained at finish",
        fold.landed_calls - drained,
    );
    retain_landed_rounds(&mut fold.rounds);
    LoopOutcome {
        termination,
        promotions: std::mem::take(
            &mut *state.promotions.lock().expect("promotions lock poisoned"),
        ),
        trace: fold.rounds,
        discovered_runtime: None,
    }
}

/// Map the run's structured prompt error onto the termination vocabulary
/// (ADR-0116 Decision 5): the step-cap exhaustion, the cancel fork (the
/// watcher hook's reason words -- the private vocabulary of this module
/// tree), the completion fault's status classes, and the honest fallbacks.
/// Every arm is reachable except memory -- `without_memory` semantics make
/// the memory channel structurally idle; the arm keeps the mapping total.
fn termination_for_prompt(
    err: &PromptError,
    step_cap: u32,
    clock: Option<&Arc<ProgressClock>>,
) -> Termination {
    match err {
        PromptError::MaxTurnsError { .. } => {
            // The cap, not the turns taken: the wiring seam renders "did
            // not converge in N steps" off the configured cap.
            Termination::StepCap(step_cap)
        }
        PromptError::PromptCancelled { reason, .. } => {
            // The watcher hook's reason fork (ADR-0116 Decision 3) is pinned
            // by the cancel suites; the landing derives from the same clock
            // the hook read (its latch is the single source of truth for
            // the cancelled-vs-no-progress fork), so any of this module's
            // reason words maps through the one landing rule. A reason word
            // outside the vocabulary (a future hook of ours) is rejected
            // honestly in release builds too -- it can never silently
            // degrade into a cancel landing.
            debug_assert!(
                reason == cancel::CANCEL_REASON_USER || reason == cancel::CANCEL_REASON_NO_PROGRESS,
                "unexpected stop reason `{reason}`: no hook outside the cancel watcher stops the run"
            );
            match reason.as_str() {
                cancel::CANCEL_REASON_USER | cancel::CANCEL_REASON_NO_PROGRESS => {
                    ProgressClock::cancel_landing(clock)
                }
                other => Termination::Transient(format!(
                    "unexpected stop reason `{other}`: no hook outside the cancel watcher stops the run"
                )),
            }
        }
        PromptError::CompletionError(err) => termination_for_completion(err),
        PromptError::UnknownToolCall { tool_name, .. } => {
            // The model reached for a tool outside the advertised table --
            // an honest transient with the name, never a silent success.
            Termination::Transient(format!(
                "model attempted to call unknown tool `{tool_name}`"
            ))
        }
        PromptError::MemoryError(_) => {
            // Structurally unreachable: the loop runtime runs memoryless.
            Termination::Transient("conversation memory failed".to_string())
        }
    }
}

/// Map a completion fault (the provider path) onto the termination
/// vocabulary: HTTP 401/403 is the not-wired class (ADR-0044 permanent --
/// the bridge encodes `NotWired` as an honest 401); the bridge's
/// invalid-config encoding (400 + prefix) strips back to its payload; and
/// everything else is an honest transient -- generation-side retry is not
/// delegated (ADR-0116 Decision 5 retired the upstream-retry posture; no
/// retry stage exists on any path this slice can execute).
fn termination_for_completion(err: &rig_core::completion::CompletionError) -> Termination {
    if let Some(status) = err.provider_response_status() {
        if status == http::StatusCode::UNAUTHORIZED || status == http::StatusCode::FORBIDDEN {
            return Termination::NotWired;
        }
        if status == http::StatusCode::BAD_REQUEST {
            if let Some(body) = err.provider_response_body() {
                if let Some(detail) = body.strip_prefix(INVALID_CONFIG_PREFIX) {
                    return Termination::InvalidConfig(detail.to_string());
                }
            }
        }
    }
    // The bridge's transport faults ride this variant with the app's own
    // detail as the whole payload -- surfaced verbatim, not re-prefixed by
    // the variant's Display ("ProviderError: ..."), so a bridged
    // `Unavailable("connection reset")` still lands as exactly that string
    // (the #669 verbatim classification contract).
    if let rig_core::completion::CompletionError::ProviderError(detail) = err {
        return Termination::Transient(detail.clone());
    }
    Termination::Transient(err.to_string())
}
