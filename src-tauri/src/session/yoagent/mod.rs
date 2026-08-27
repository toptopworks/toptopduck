//! The yoagent integration layer (ADR-0107): the in-process agent-loop
//! runtime behind the built-in turn (wired by #669; the self-written loop +
//! protocol adapters it replaced are deleted, issue #670).
//!
//! Integration shape (ADR-0107 Decision 2): every turn is a stateless
//! `agent_loop()` call fed the app-assembled full windowed context -- no
//! `Agent` wrapper, no session tree, no compaction (`context_config` stays
//! `None`; windowing is the app's, preventing double truncation), no skills
//! loader, no MCP client, no sub-agents, no tool middleware (the app gateway
//! is the single enforcement point). Safety net (Decision 4): the step cap
//! (24) + wall clock (120s, ADR-0081) map onto `ExecutionLimits` and the
//! caller-thread watchdog (ADR-0081 values); cancellation
//! maps the app's `CancelToken` onto the upstream task token; loop detection
//! is ON (consecutive identical calls steer, then stop). Retries for
//! rate-limit / transient network faults ride the upstream backoff; a
//! terminal fault maps into the existing `Termination` vocabulary.
//!
//! Threading: the session's dispatch collaborators (`TurnDeps`, materializer,
//! `McpAggregator`) are not `Sync` and never leave the caller's thread --
//! so `run` serves dispatch requests on the caller's thread (through the
//! shared `dispatch_gated_call` core) while a scoped driver thread runs the
//! async loop on a dedicated single-threaded runtime. Only owned data
//! crosses (channels + shared state).

mod adapter;
mod fold;
mod live;
mod model_config;

pub(crate) use live::turn_loop_for;

#[cfg(test)]
mod tests;

use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use yoagent::agent_loop::AGENT_STOPPED_PREFIX;
use yoagent::context::ExecutionLimits;
use yoagent::provider::StreamProvider;
use yoagent::types::{
    AgentContext, AgentEvent, AgentMessage, CacheConfig, Content, Message, StopReason,
    ToolExecutionStrategy,
};

use crate::cancel::CancelToken;
use crate::mcp::aggregator::McpAggregator;
use crate::model::TurnPhase;
use crate::provider::tool_calling::{ThinkingBlock, ToolTurnMessage, ToolTurnRequest};
use crate::session::loop_contract::{
    retain_landed_rounds, LoopOutcome, Termination, DEFAULT_STEP_CAP, DEFAULT_WALL_CLOCK,
};
use crate::session::materializer::{Materializer, TurnDeps};
use crate::session::skills::SkillActivationCtx;
use crate::session::turn_dispatch::{
    dispatch_gated_call, panic_to_transient, spawn_wall_clock_watchdog, DispatchAbort, GateCtx,
};

use adapter::{DispatchOutcome, DispatchRequest, GatewayToolAdapter, PhaseSink, SharedTurnState};
use fold::EventFold;
use model_config::{thinking_level_for, ResolvedYoagentModel};

/// Upstream limit/error wording the terminal classification matches against.
/// These are NOT exported constants on the yoagent side -- the limits render
/// through `check_limits`' stop-marker text (context.rs) and the auth fault
/// through `ProviderError::Auth`'s Display template (provider/traits.rs) --
/// so each prefix is pinned here with its source, and the offline tests pin
/// the mapping itself (a wording drift under the `"0.18"` minor gate turns
/// the pinned classification red instead of silently degrading every auth
/// failure into a retryable `Transient`). A mismatch degrades to the honest
/// `Transient` fallbacks in `derive_reply_termination`.
const MAX_TURNS_PREFIX: &str = "Max turns"; // check_limits, yoagent context.rs
const MAX_DURATION_PREFIX: &str = "Max duration"; // check_limits, yoagent context.rs
const AUTH_ERROR_PREFIX: &str = "Auth error"; // ProviderError::Auth Display

/// The bridge's error-side encoding for an app `InvalidConfig` fault (issue
/// #669): the app provider bridge (live.rs) writes this prefix into the
/// upstream error channel, and `derive_reply_termination` strips it back
/// into `Termination::InvalidConfig` -- the same write/read pairing the
/// upstream `Auth error` wording has, but for a classification the upstream
/// vocabulary has no variant for. Both sides live in this module, so the
/// contract cannot drift apart.
const INVALID_CONFIG_PREFIX: &str = "Invalid config";

/// The per-turn yoagent runner -- the layer's mirror of
/// the retired built-in loop. Built per turn (cheap): the
/// resolved model + key, the provider, and the two execution-level caps.
pub(crate) struct YoagentLoop {
    provider: Arc<dyn StreamProvider>,
    model: ResolvedYoagentModel,
    step_cap: u32,
    wall_clock: Option<Duration>,
}

impl YoagentLoop {
    /// Default caps (step cap 24, wall clock 120s, ADR-0081).
    pub(crate) fn new(provider: Arc<dyn StreamProvider>, model: ResolvedYoagentModel) -> Self {
        Self {
            provider,
            model,
            step_cap: DEFAULT_STEP_CAP,
            wall_clock: Some(DEFAULT_WALL_CLOCK),
        }
    }

    /// Override the caps (the test seam). Test-only at the call sites: the
    /// production wiring always runs the ADR-0081 defaults.
    #[allow(dead_code)]
    pub(crate) fn with_caps(mut self, step_cap: u32, wall_clock: Option<Duration>) -> Self {
        self.step_cap = step_cap;
        self.wall_clock = wall_clock;
        self
    }

    /// Drive one agent turn through the upstream loop: serve gateway
    /// dispatches on this thread while the driver thread runs the loop, then
    /// fold the event stream into the round-grouped trace and derive the
    /// termination -- the single-in-flight + watchdog + panic-guard contract
    /// (ADR-0021/0081, issue #321).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn run(
        &self,
        request: &ToolTurnRequest,
        deps: &mut TurnDeps,
        materializer: &mut dyn Materializer,
        mcp: &mut McpAggregator,
        cli: &[crate::cli_tools::config::CliToolConfig],
        skills: &mut SkillActivationCtx<'_>,
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
        let upstream_cancel = CancellationToken::new();
        // Releases the cancel watcher once the drive is over (a normal run
        // never cancels, so the watcher needs a second exit condition or it
        // would outlive the scope).
        let drive_done = Arc::new(std::sync::atomic::AtomicBool::new(false));

        std::thread::scope(|scope| {
            // Cancel mapping (ADR-0107 Decision 4): the app token is
            // poll-based (no notification hook), so a scoped watcher maps it
            // onto the upstream task token. 25ms granularity -- the order of
            // the UI's cancel round-trip; dispatch-side cancellation is
            // immediate regardless (the gate and the tool executors honor
            // the app token directly).
            {
                let token = Arc::clone(&cancel);
                let upstream = upstream_cancel.clone();
                let done = Arc::clone(&drive_done);
                scope.spawn(move || {
                    while !upstream.is_cancelled() && !done.load(Ordering::SeqCst) {
                        if token.is_requested() {
                            upstream.cancel();
                            return;
                        }
                        thread::sleep(Duration::from_millis(25));
                    }
                });
            }
            // Wall-clock watchdog (ADR-0081): the shared shape (the built-in
            // loop's own helper). The watcher above maps the fired token up,
            // and the termination derivation below lands the turn as
            // Cancelled (the ADR-0021 timeout -> cancel mapping).
            if let Some(timeout) = self.wall_clock {
                spawn_wall_clock_watchdog(
                    guard.generation(),
                    Arc::clone(&cancel),
                    timeout,
                    "toptopduck::yoagent",
                );
            }
            // The driver: one scoped thread owning a dedicated single-thread
            // runtime. The dispatch server below outlives it -- its request
            // channel closes when the driver's context (and with it every
            // adapter) drops, which ends the server loop; the join order
            // cannot deadlock.
            let driver = {
                let provider = Arc::clone(&self.provider);
                let model_config = self.model.config.clone();
                let api_key = self.model.api_key.clone();
                let state = Arc::clone(&state);
                let phases = Arc::clone(&phases);
                let upstream = upstream_cancel.clone();
                let req_tx = req_tx.clone();
                let request = request.clone();
                let step_cap = self.step_cap;
                let wall_clock = self.wall_clock;
                scope.spawn(move || {
                    let runtime = match tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        Ok(rt) => rt,
                        Err(e) => {
                            let mut fold = EventFold::new();
                            fold.final_messages = Vec::new();
                            *state.aborted.lock().expect("aborted lock poisoned") =
                                Some(Termination::Transient(format!(
                                    "yoagent runtime build failed: {e}"
                                )));
                            return fold;
                        }
                    };
                    runtime.block_on(drive_turn(DriveInputs {
                        provider,
                        model_config,
                        api_key,
                        request,
                        state,
                        phases,
                        upstream,
                        req_tx,
                        step_cap,
                        wall_clock,
                    }))
                })
            };
            // Drop THIS thread's sender: the server loop below ends when the
            // driver's adapters (the only remaining senders) drop -- holding
            // the original here would keep `req_rx` open past the run and
            // deadlock the join below.
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
                // Mid-batch stop check -- the per-call cancel gate:
                // upstream's executor checks neither cancel nor steering
                // BETWEEN the calls of one batch, so once the turn is over
                // (a user cancel, a gate cancel, or a dispatch panic) the
                // remaining queued calls must be answered, not run. The
                // GateCancelled answer routes the adapter onto its cancel
                // path (fires the upstream token, feeds an error result
                // back) so the executor stops at the next loop-top without
                // anything dispatching for real -- break-on-cancel semantics.
                let turn_over = cancel.is_requested()
                    || state.gate_cancelled.load(Ordering::SeqCst)
                    || state
                        .aborted
                        .lock()
                        .expect("aborted lock poisoned")
                        .is_some();
                if turn_over {
                    let _ = resp.send(DispatchOutcome::GateCancelled);
                    continue;
                }
                let phases = Arc::clone(&phases);
                let mut forward = |phase: TurnPhase| adapter::emit_phase(&phases, phase);
                let outcome = match dispatch_gated_call(
                    &call,
                    deps,
                    materializer,
                    mcp,
                    cli,
                    skills,
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
            // panic, issue #321) wins first -- its Transient detail carries
            // more than a bare Cancelled would; then cancel (a cancel that
            // arrived during the run wins over any reply, ADR-0021); then
            // the loop-abort, stop-marker, and reply derivations.
            let fold = driver.join().unwrap_or_else(|payload| {
                let mut fold = EventFold::new();
                fold.final_messages = Vec::new();
                *state.aborted.lock().expect("aborted lock poisoned") =
                    Some(panic_to_transient("yoagent driver", &*payload));
                fold
            });
            // Release the cancel watcher: the drive is over, a further
            // upstream cancel is inert (the termination is derived from the
            // state below), and the watcher must not outlive the scope.
            drive_done.store(true, Ordering::SeqCst);
            upstream_cancel.cancel();
            if let Some(termination) = state.aborted.lock().expect("aborted lock poisoned").take() {
                return finish(fold, &state, termination);
            }
            if cancel.is_requested() || state.gate_cancelled.load(Ordering::SeqCst) {
                return finish(fold, &state, Termination::Cancelled);
            }
            if let Some(reason) = fold.loop_abort.clone() {
                return finish(fold, &state, Termination::Transient(reason));
            }
            let termination = derive_reply_termination(&fold, self.step_cap);
            finish(fold, &state, termination)
        })
    }
}

/// Everything the driver thread needs, bundled so the spawn site stays
/// readable. Owned data only (the non-`Sync` session collaborators stay on
/// the caller thread).
struct DriveInputs {
    provider: Arc<dyn StreamProvider>,
    model_config: yoagent::provider::ModelConfig,
    api_key: String,
    request: ToolTurnRequest,
    state: Arc<SharedTurnState>,
    phases: PhaseSink,
    upstream: CancellationToken,
    req_tx: mpsc::Sender<DispatchRequest>,
    step_cap: u32,
    wall_clock: Option<Duration>,
}

/// Drive the upstream loop: build the per-turn context + config, spawn
/// `agent_loop`, and fold the event stream as it arrives (live phases ride
/// the fold's emissions; the call phases come from the dispatch server over
/// the same sink).
async fn drive_turn(inputs: DriveInputs) -> EventFold {
    let mut context = AgentContext {
        system_prompt: inputs.request.system.clone(),
        messages: convert_messages(&inputs.request.messages),
        tools: inputs
            .request
            .tools
            .iter()
            .cloned()
            .map(|def| {
                Box::new(GatewayToolAdapter::new(
                    def,
                    Arc::clone(&inputs.state),
                    inputs.req_tx.clone(),
                    inputs.upstream.clone(),
                )) as Box<dyn yoagent::types::AgentTool>
            })
            .collect(),
    };
    // Execution limits (ADR-0107 Decision 4): the step cap is the upstream
    // `max_turns` (both count LLM round-trips -- 24 turns are permitted and
    // the 25th loop-top check stops, the same boundary `AgentLoop`'s
    // `for step in 1..=cap` draws); the token cap has no app counterpart
    // and is disabled; the wall clock mirrors the caller-thread watchdog as
    // a boundary race belt (the watchdog's cancel normally lands first);
    // loop detection stays at the upstream default (steer at 3 consecutive
    // identical calls, abort on the second trip). `ExecutionLimits` is
    // `#[non_exhaustive]` upstream -- constructed via Default + mutation.
    let mut limits = ExecutionLimits::default();
    limits.max_turns = inputs.step_cap as usize;
    limits.max_total_tokens = usize::MAX;
    limits.max_duration = inputs.wall_clock.unwrap_or(Duration::MAX);
    limits.max_consecutive_identical_tool_calls = Some(3);
    // Wire parity with the built-in adapters (which never sent cache
    // hints): caching disabled so the request payload the upstream builds
    // matches what the app's own adapters sent. Revisit with #669's
    // two-protocol wire-equivalence pass.
    let config = yoagent::agent_loop::AgentLoopConfig {
        provider: inputs.provider,
        model: inputs.model_config.id.clone(),
        api_key: inputs.api_key,
        thinking_level: thinking_level_for(inputs.request.thought_level.as_deref()),
        max_tokens: Some(inputs.request.max_tokens),
        temperature: None,
        model_config: Some(inputs.model_config),
        convert_to_llm: None,
        transform_context: None,
        get_steering_messages: None,
        get_follow_up_messages: None,
        context_config: None,
        compaction_strategy: None,
        execution_limits: Some(limits),
        cache_config: CacheConfig::disabled(),
        tool_output_sink: None,
        tool_execution: ToolExecutionStrategy::Sequential,
        tool_middleware: Vec::new(),
        output_schema: None,
        retry_config: yoagent::RetryConfig::default(),
        before_turn: None,
        after_turn: None,
        on_error: None,
        input_filters: Vec::new(),
        turn_delay: None,
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    // The whole windowed conversation rides the context (the app assembled
    // it; the upstream sees it verbatim), so no prompt messages are needed.
    // context + config move into the task (tokio::spawn needs 'static);
    // nothing after this point reads them.
    let handle = tokio::spawn(async move {
        yoagent::agent_loop(Vec::new(), &mut context, &config, tx, inputs.upstream).await
    });
    let mut fold = EventFold::new();
    while let Some(event) = rx.recv().await {
        fold.event(&event, &inputs.state, &inputs.phases);
    }
    // The channel closes only when the loop task finished; propagate its
    // panic (if any) as an honest transient -- the fold's rounds survive.
    if let Err(join_err) = handle.await {
        let payload = join_err.into_panic();
        *inputs.state.aborted.lock().expect("aborted lock poisoned") =
            Some(panic_to_transient("yoagent agent_loop", &*payload));
    }
    fold
}

/// Assemble the final [`LoopOutcome`] -- the layer's mirror of the built-in
/// loop's `outcome` fn: drop rounds nothing landed on, carry promotions in
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

/// Derive the termination from the run's final messages when no cancel /
/// abort / loop-abort intervened. An upstream stop marker (a trailing User
/// message) parses into its cap semantics: max turns -> `StepCap` (the
/// honest "did not converge in N steps"), max duration -> `Cancelled` (the
/// ADR-0021 timeout -> cancel mapping; normally the watchdog's token fired
/// first and the run never reaches this arm). A terminal provider error
/// classifies through the existing vocabulary -- the upstream `Auth error`
/// prefix maps to `NotWired`, the bridge's `Invalid config` encoding (see
/// [`INVALID_CONFIG_PREFIX`]) back to `InvalidConfig`, everything else to
/// `Transient` (rate-limit / network faults reach here only after the
/// upstream backoff exhausted, so nothing transient leaks to the user
/// mid-run, ADR-0044). Otherwise the last assistant reply's text is the
/// terminal text, verbatim.
fn derive_reply_termination(fold: &EventFold, step_cap: u32) -> Termination {
    // A trailing stop-marker User message names the limit that stopped the
    // run (loop-abort markers were consumed earlier, before this fn).
    if let Some(reason) = fold
        .final_messages
        .iter()
        .rev()
        .find_map(stop_marker_reason)
    {
        if reason.starts_with(MAX_TURNS_PREFIX) {
            // The cap, not the turns taken: the wiring seam renders "did
            // not converge in N steps" off the configured cap.
            return Termination::StepCap(step_cap);
        }
        if reason.starts_with(MAX_DURATION_PREFIX) {
            return Termination::Cancelled;
        }
        return Termination::Transient(format!("execution limit: {reason}"));
    }
    // The last assistant message is the terminal reply (any trailing
    // non-assistant marker was handled above; tool results never follow a
    // terminal reply).
    let reply = fold.final_messages.iter().rev().find_map(|m| {
        m.as_llm().and_then(|l| match l {
            Message::Assistant { .. } => Some(l),
            _ => None,
        })
    });
    let Some(reply) = reply else {
        return Termination::Transient("yoagent run ended without a reply".to_string());
    };
    // The find_map above yields only assistant messages; the let-else keeps
    // the compiler's exhaustiveness honest without an unreachable!().
    let Message::Assistant {
        content,
        stop_reason,
        error_message,
        ..
    } = reply
    else {
        return Termination::Transient("yoagent run ended without a reply".to_string());
    };
    if matches!(stop_reason, StopReason::Error | StopReason::Aborted) {
        let detail = error_message
            .clone()
            .unwrap_or_else(|| "provider stream failed without a diagnostic".to_string());
        if detail.starts_with(AUTH_ERROR_PREFIX) {
            return Termination::NotWired;
        }
        // The app-provider bridge's encoding (live.rs): the prefix strips
        // back off, the payload rides verbatim -- the same diagnosis the
        // built-in adapters surfaced (issue #277's "scheme `file` is not
        // http/https" wording reaches the UI fold unchanged).
        if let Some(rest) = detail
            .strip_prefix(INVALID_CONFIG_PREFIX)
            .and_then(|rest| rest.strip_prefix(": "))
        {
            return Termination::InvalidConfig(rest.to_string());
        }
        return Termination::Transient(detail);
    }
    let text = content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    Termination::Text(text)
}

/// The stop-marker reason carried by a trailing upstream User message, when
/// it is one (`"[Agent stopped: <reason>]"`).
fn stop_marker_reason(message: &AgentMessage) -> Option<String> {
    let Message::User { content, .. } = message.as_llm()? else {
        return None;
    };
    let text = content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    text.strip_prefix(AGENT_STOPPED_PREFIX)
        .and_then(|rest| rest.strip_suffix(']'))
        .map(str::trim)
        .map(str::to_string)
}

/// Convert the app's protocol-neutral conversation onto the upstream message
/// shape. The tool-result `tool_name` (which the app's `ToolResult` does not
/// carry) is recovered from the preceding assistant turn's tool-call ids, so
/// the upstream re-feed round-trips each call's identity. Thinking blocks
/// ride verbatim (tool-use continuity, issue #614); a redacted block's
/// opaque payload travels as plain thinking text -- the upstream block
/// vocabulary has no redacted variant, and dropping it would break the
/// sequence the provider expects.
fn convert_messages(messages: &[ToolTurnMessage]) -> Vec<AgentMessage> {
    let mut converted = Vec::with_capacity(messages.len());
    let mut names = std::collections::HashMap::new();
    for message in messages {
        match message {
            ToolTurnMessage::User { content } => {
                converted.push(AgentMessage::Llm(Message::User {
                    content: vec![Content::Text {
                        text: content.clone(),
                    }],
                    timestamp: 0,
                }));
            }
            ToolTurnMessage::Assistant {
                text,
                tool_calls,
                thinking,
            } => {
                let mut content = Vec::new();
                for block in thinking {
                    match block {
                        ThinkingBlock::Thinking {
                            thinking,
                            signature,
                        } => {
                            content.push(Content::thinking_signed(
                                thinking.clone(),
                                signature.clone(),
                            ));
                        }
                        ThinkingBlock::Redacted { data } => {
                            content.push(Content::thinking(data.clone()));
                        }
                    }
                }
                if let Some(t) = text {
                    content.push(Content::Text { text: t.clone() });
                }
                for call in tool_calls {
                    names.insert(call.id.clone(), call.name.clone());
                    content.push(Content::tool_call(
                        call.id.clone(),
                        call.name.clone(),
                        call.input.clone(),
                    ));
                }
                let stop_reason = if tool_calls.is_empty() {
                    StopReason::Stop
                } else {
                    StopReason::ToolUse
                };
                converted.push(AgentMessage::Llm(Message::assistant(
                    content,
                    stop_reason,
                    "app",
                    "app",
                    yoagent::types::Usage::default(),
                )));
            }
            ToolTurnMessage::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let tool_name = names.get(tool_use_id).cloned().unwrap_or_default();
                converted.push(AgentMessage::Llm(Message::ToolResult {
                    tool_call_id: tool_use_id.clone(),
                    tool_name,
                    content: vec![Content::Text {
                        text: content.clone(),
                    }],
                    is_error: *is_error,
                    timestamp: 0,
                }));
            }
        }
    }
    converted
}
