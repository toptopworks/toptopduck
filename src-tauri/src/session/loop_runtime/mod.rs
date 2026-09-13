//! The loop-runtime integration layer (ADR-0116, issue #917): the in-process
//! agent-loop runtime built on rig (rig-core + rig-agent), the replacement
//! for the yoagent layer the 0.18 wire defects (batched `tool_result`
//! splitting, thinking-loss 400s) made unservable. Borrow the kernel, not
//! the framework: rig's completion / streaming / tool surfaces drive; rig's
//! hooks carry exactly one (the cancel watcher), memory is absent
//! (`without_memory` semantics -- the app owns the window), `ToolContext`
//! stays blank, and model selection is the single model this runtime was
//! built with.
//!
//! Threading mirrors the yoagent layer exactly: the session's dispatch
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
//! Not yet wired: the integration slice (issue #917) lands the runtime
//! offline-verified with the wiring seam untouched; the swap slice (#918)
//! points `turn_loop_for` here and removes this attribute with it. Until
//! then only the `#[cfg(test)]` suites reference the module, so normal lib
//! builds would fire dead_code lints (the runtime/gateway slice-9b
//! precedent).
#![allow(dead_code)]

mod adapter;
mod cancel;
mod fold;
mod model;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use futures::StreamExt;
use rig_agent::agent::{AgentBuilder, ModelHandle, StreamingError, StreamingPromptRequest};
use rig_agent::completion::PromptError;
use std::future::IntoFuture;

use crate::cancel::CancelToken;
use crate::mcp::aggregator::McpAggregator;
use crate::model::TurnPhase;
use crate::provider::tool_calling::ToolTurnRequest;
use crate::session::loop_contract::{
    retain_landed_rounds, LoopOutcome, Termination, DEFAULT_NO_PROGRESS_CAP, DEFAULT_STEP_CAP,
};
use crate::session::materializer::{Materializer, TurnDeps};
use crate::session::progress::ProgressClock;
use crate::session::skills::SkillActivationCtx;
use crate::session::turn_dispatch::{
    dispatch_gated_call, panic_to_transient, DispatchAbort, GateCtx,
};

use adapter::{DispatchOutcome, DispatchRequest, PhaseSink, SharedTurnState};
use cancel::CancelWatcher;
use fold::EventFold;
use model::INVALID_CONFIG_PREFIX;

/// The per-turn loop runner -- the rig-backed twin of the yoagent layer's
/// `YoagentLoop`. Built per turn (cheap): the erased model handle and the
/// two execution-level caps.
pub(crate) struct LoopRuntime {
    model: ModelHandle,
    step_cap: u32,
    no_progress_cap: Option<Duration>,
}

impl LoopRuntime {
    /// Default caps (step cap 24, no-progress cap 120s, ADR-0081).
    pub(crate) fn new(model: ModelHandle) -> Self {
        Self {
            model,
            step_cap: DEFAULT_STEP_CAP,
            no_progress_cap: Some(DEFAULT_NO_PROGRESS_CAP),
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
    /// (ADR-0021/0081, issue #321), the same shape the yoagent layer runs.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn run(
        &self,
        request: &ToolTurnRequest,
        deps: &mut TurnDeps,
        materializer: &mut dyn Materializer,
        mcp: &mut McpAggregator,
        cli: &[crate::cli_tools::config::CliToolConfig],
        skills: &mut SkillActivationCtx<'_>,
        read: &crate::skills::read::SkillReadGate<'_>,
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
            // Cancel watcher thread (ADR-0107 Decision 4's poll bridge, the
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
                let clock = clock.clone();
                let token = Arc::clone(&cancel);
                scope.spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt,
                        Err(e) => {
                            let mut fold = EventFold::new();
                            fold.final_output = None;
                            *state.aborted.lock().expect("aborted lock poisoned") = Some(
                                Termination::Transient(format!("loop runtime build failed: {e}")),
                            );
                            return DriveOutcome {
                                fold,
                                exit: DriveExit::Done,
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
                        call_ids: Arc::new(AtomicU64::new(0)),
                        step_cap,
                        clock: clock.clone(),
                        token,
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
            for DispatchRequest { call, resp } in req_rx {
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
                    skills,
                    read,
                    &gate,
                    &mut forward,
                ) {
                    Err(DispatchAbort::Gate) => DispatchOutcome::GateCancelled,
                    Err(DispatchAbort::Panic(termination)) => DispatchOutcome::Aborted(termination),
                    Ok((result, entry, promotion)) => DispatchOutcome::Done {
                        result,
                        entry,
                        promotion,
                    },
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
            let DriveOutcome { mut fold, exit } = driver.join().unwrap_or_else(|payload| {
                *state.aborted.lock().expect("aborted lock poisoned") =
                    Some(panic_to_transient("loop runtime driver", &*payload));
                DriveOutcome {
                    fold: EventFold::new(),
                    exit: DriveExit::Done,
                }
            });
            // Release the watcher thread: the drive is over, its notify
            // would be inert (the exit below decides), and it must not
            // outlive the scope.
            drive_done.store(true, Ordering::SeqCst);
            if let Some(termination) = state.aborted.lock().expect("aborted lock poisoned").take() {
                return finish(fold, &state, termination);
            }
            if state.turn_over(&cancel) {
                // ADR-0115: the clock latches whether the cancel is the
                // watchdog's (generation silence past the cap) or a user /
                // close cancel -- same landing, different reason.
                return finish(fold, &state, ProgressClock::cancel_landing(clock.as_ref()));
            }
            let termination = match exit {
                // The select race abandoned the wait -- the token is
                // requested (that is the only thing it races on).
                DriveExit::Abandoned => ProgressClock::cancel_landing(clock.as_ref()),
                DriveExit::Error(err) => match err {
                    StreamingError::Prompt(err) => {
                        termination_for_prompt(&err, self.step_cap, clock.as_ref())
                    }
                    StreamingError::Completion(err) => termination_for_completion(&err),
                },
                DriveExit::Done => match fold.final_output.take() {
                    Some(text) => Termination::Text(text),
                    None => {
                        Termination::Transient("loop runtime ended without a reply".to_string())
                    }
                },
            };
            finish(fold, &state, termination)
        })
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
    call_ids: Arc<AtomicU64>,
    step_cap: u32,
    /// The turn's no-progress clock (ADR-0115): the fold touches it on every
    /// inbound stream event -- the generation segment's liveness signal.
    clock: Option<Arc<ProgressClock>>,
    token: Arc<CancelToken>,
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

/// The driver's product: the event fold plus its exit cause.
struct DriveOutcome {
    fold: EventFold,
    exit: DriveExit,
}

/// Drive the rig loop: build the agent (preamble + gateway tools + the one
/// cancel hook), open the streaming prompt request over the app-assembled
/// history, and fold the event stream as it arrives -- racing the cancel
/// notification for the silent stretches.
async fn drive_turn(inputs: DriveInputs) -> DriveOutcome {
    let DriveInputs {
        model,
        request,
        state,
        phases,
        notify,
        req_tx,
        call_ids,
        step_cap,
        clock,
        token,
    } = inputs;
    // The whole windowed conversation rides the request (the app assembled
    // it; the loop runtime re-feeds it verbatim) split at rig's boundary:
    // the LAST message is the prompt, everything before it the history.
    let history =
        model::to_rig_history(&request.messages[..request.messages.len().saturating_sub(1)]);
    let prompt = model::to_rig_history(&request.messages[request.messages.len() - 1..])
        .pop()
        .expect("the prompt split always yields exactly one message");
    let tools = request
        .tools
        .iter()
        .cloned()
        .map(|def| {
            adapter::gateway_dynamic_tool(
                def,
                Arc::clone(&state),
                req_tx.clone(),
                Arc::clone(&call_ids),
            )
        })
        .collect::<Vec<_>>();
    let agent = AgentBuilder::new(model)
        .preamble(request.system.as_str())
        .max_tokens(request.max_tokens as u64)
        .dynamic_tools(tools)
        .build();
    let mut stream = StreamingPromptRequest::from_agent(&agent, prompt)
        .history(history)
        .max_turns(step_cap as usize)
        .tool_concurrency(1)
        // Memoryless by construction, stated explicitly: the app owns the
        // windowed history (ADR-0116 Decision 2), so rig's session memory
        // stays off the run (the MemoryError arm of the terminal mapping is
        // unreachable).
        .without_memory()
        .add_hook(CancelWatcher::new(token, clock.clone(), Arc::clone(&state)))
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
                        fold.event(&item, &state, &phases);
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
    DriveOutcome { fold, exit }
}

/// Assemble the final [`LoopOutcome`] -- the layer's mirror of the yoagent
/// loop's `finish` fn: drop rounds nothing landed on, carry promotions in
/// dispatch order, and report no discovered runtime (the built-in protocol
/// surface has no handshake catalog, ADR-0095).
fn finish(
    mut fold: EventFold,
    state: &Arc<SharedTurnState>,
    termination: Termination,
) -> LoopOutcome {
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
            // reason words maps through the one landing rule.
            debug_assert!(
                reason == cancel::CANCEL_REASON_USER || reason == cancel::CANCEL_REASON_NO_PROGRESS,
                "unexpected stop reason `{reason}`: no hook outside the cancel watcher stops the run"
            );
            ProgressClock::cancel_landing(clock)
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
/// everything else -- after upstream retries exhausted -- is an honest
/// transient.
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
    Termination::Transient(err.to_string())
}
