//! The gateway tool adapter (ADR-0116 Decision 4, issue #917): the single
//! tool surface the rig loop runtime sees. One [`DynamicTool`] per catalog
//! entry -- name / description / schema ride verbatim from the app's
//! gateway-assembled tool table, so the upstream surface IS the gateway
//! surface. Execution routes the shared [`dispatch_gated_call`] core on the
//! caller's thread via the std-mpsc dispatch channel.
//!
//! The callback always resolves `Ok`: a tool-level failure (including the
//! gateway's error results) feeds back to the model as an error-text result
//! it can self-correct from (ADR-0077), so the upstream fail-fast error
//! channel is structurally unreachable. Cancel / abort states latch in the
//! shared turn state, where the cancel-watcher hook stops the run at its
//! next checkpoint (the rig loop has no external cancellation token to
//! fire; the driver's select race covers the silence between checkpoints).
//!
//! Call identity: rig's [`DynamicTool`] callback receives no tool-call id
//! (the context it hands over is a blank typed map, ADR-0116 Decision 2's
//! inert `ToolContext`), so each dispatch carries a locally minted
//! uuid-backed id. The rig-side correlation of a result back to its call
//! never crosses this boundary -- rig assembles that itself from the call
//! it issued; the app's trace entries pair with the event stream by
//! completion order (single-concurrency execution makes dispatch order ==
//! call order == result-forwarding order -- the ordering guarantee
//! ADR-0116 Decision 4 pins here with `tool_concurrency = 1`).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use crate::model::{Promotion, TurnPhase};
use crate::provider::tool_calling::{ToolDefinition, ToolUse};
use crate::session::loop_contract::Termination;

/// One dispatch request crossing from the driver thread to the caller
/// thread's dispatch server: the call to route, plus the response channel
/// for its outcome. Owned data only -- the session's borrowed collaborators
/// (`TurnDeps` / materializer / aggregator) never cross threads (they are
/// not `Sync`; ADR-0104's `OnceLock<Connection>` engine among them), which
/// is why the dispatch server runs on the caller's thread and only these
/// messages move.
pub(crate) struct DispatchRequest {
    pub(crate) call: ToolUse,
    /// Where the server records this call's trace entry
    /// (record-before-send, #921): the dispatching family's completion
    /// channel -- the main channel for the main loop's tools, a
    /// sub-agent-private channel for the sub-face's (#944 review Critical
    /// 1: the record follows the CONSUMER, so a fold can only ever pair
    /// its own dispatches' entries).
    pub(crate) channel: Arc<CompletionChannel>,
    pub(crate) resp: mpsc::Sender<DispatchOutcome>,
}

/// The dispatch server's reply for one call. The executed call's trace
/// entry and promotion never ride this channel: the server records them on
/// the shared state BEFORE the reply crosses (record-before-send, #921) -- a driver-side
/// cancellation that abandons the callback's async segment cannot strand
/// an executed call's accounting.
pub(crate) enum DispatchOutcome {
    /// The routed outcome's model-facing result.
    Done {
        result: crate::provider::tool_calling::ToolResult,
    },
    /// The approval gate was cancelled mid-call -- the whole turn aborts
    /// (the built-in loop's `GateCancelled` semantics).
    GateCancelled,
    /// A dispatch panic (issue #321 guard) -- the whole turn fails honestly.
    Aborted(Termination),
}

/// One consumer family's completion ledger (#944 review Critical 1): the
/// recorded-entry queue that family's fold drains one per result event,
/// plus the recorded count its finish-time pairing asserts against. The
/// queue is keyed by nothing (rig's callback surface carries no call id,
/// see the module doc), so pairing is ORDER -- and order is an exact
/// pairing only while ONE family consumes ONE queue. The main channel
/// serves the main fold; every sub-agent mints a private channel, because
/// rig surfaces a batch's tool results only after the whole batch
/// settles -- over a shared queue, a delegation's earlier siblings'
/// recorded entries sat at the head when the sub-agent's fold popped, and
/// the main trace lost a row while another wore its identity.
pub(crate) struct CompletionChannel {
    /// Completed calls' trace entries, completion order.
    pub(crate) completed: Mutex<VecDeque<crate::session::loop_contract::TraceEntry>>,
    /// Count of trace entries recorded for executed calls (incremented at
    /// the record-before-send site). The accounting side of the
    /// exactly-once pairing the family's finish asserts against its
    /// fold's `landed_calls`: every recorded entry lands once -- by its
    /// result event, or drained at finish when a cancellation left the
    /// event stream abandoned (#921).
    pub(crate) recorded_calls: AtomicUsize,
}

impl CompletionChannel {
    pub(crate) fn new() -> Self {
        Self {
            completed: Mutex::new(VecDeque::new()),
            recorded_calls: AtomicUsize::new(0),
        }
    }
}

/// State shared between the tool callbacks (driver side), the caller-side
/// dispatch server, and the runner's event fold. All fields are
/// interior-mutability + lock/atomic guarded. Completed entries queue in
/// completion order; the fold drains one per executed-tool-result event,
/// which the sequential execution strategy forwards in the same order.
pub(crate) struct SharedTurnState {
    /// The MAIN fold's completion channel (#944): gateway dispatches and
    /// delegation entries record here; the main fold drains here. Every
    /// sub-agent runs on a private channel minted per run (see
    /// `run_subagent`) so the order-pairing stays single-consumer.
    pub(crate) main: Arc<CompletionChannel>,
    /// Promotions in dispatch order (sequential strategy makes dispatch
    /// order == promotion order, ADR-0022 monotonic `result_N`).
    pub(crate) promotions: Mutex<Vec<Promotion>>,
    /// Whether a gate-cancel aborted the turn.
    pub(crate) gate_cancelled: AtomicBool,
    /// An honest termination overriding the fold's derivation (a dispatch
    /// panic, issue #321).
    pub(crate) aborted: Mutex<Option<Termination>>,
}

impl SharedTurnState {
    /// The mid-run turn-over verdict the dispatch server's per-call gate and
    /// the cancel watcher's checkpoints share: an honest abort latched, a
    /// gate cancel, or the app token requested. One implementation so the
    /// two surfaces cannot drift.
    pub(crate) fn turn_over(&self, token: &crate::cancel::CancelToken) -> bool {
        self.aborted
            .lock()
            .expect("aborted lock poisoned")
            .is_some()
            || self.gate_cancelled.load(Ordering::SeqCst)
            || token.is_requested()
    }

    pub(crate) fn new() -> Self {
        Self {
            main: Arc::new(CompletionChannel::new()),
            promotions: Mutex::new(Vec::new()),
            gate_cancelled: AtomicBool::new(false),
            aborted: Mutex::new(None),
        }
    }
}

/// Mint the per-dispatch call id: uuid-backed, prefixed so an id can never
/// be mistaken for a provider-issued handle (the gateway mints its own).
/// Uniqueness is intrinsic to the mint, never an artifact of counter scope:
/// the runtime rebuilds per turn, so a scoped counter would mint colliding
/// `gateway-0`s across a session (#922).
pub(crate) fn next_call_id() -> String {
    format!("gateway-{}", uuid::Uuid::new_v4())
}

/// Build the per-catalog-entry gateway adapter (ADR-0116 Decision 4): a
/// [`DynamicTool`] whose name / description / schema ride verbatim from the
/// app tool table. `Send + Sync + 'static` -- only owned / channel state,
/// never a session borrow.
pub(crate) fn gateway_dynamic_tool(
    def: ToolDefinition,
    state: Arc<SharedTurnState>,
    channel: Arc<CompletionChannel>,
    dispatch: mpsc::Sender<DispatchRequest>,
) -> rig_agent::tool::DynamicTool {
    let name = def.name.clone();
    rig_agent::tool::DynamicTool::new(
        def.name.clone(),
        def.description.clone(),
        def.input_schema.clone(),
        move |_context, args| {
            let call = ToolUse {
                id: next_call_id(),
                name: name.clone(),
                input: args,
            };
            let state = Arc::clone(&state);
            let channel = Arc::clone(&channel);
            let dispatch = dispatch.clone();
            Box::pin(async move {
                // The blocking dispatch round-trip (channel send + the
                // caller thread's gated execution) must not sit on the async
                // runtime's thread.
                let outcome = tokio::task::spawn_blocking(move || {
                    let (resp_tx, resp_rx) = mpsc::channel::<DispatchOutcome>();
                    if dispatch
                        .send(DispatchRequest {
                            call,
                            channel,
                            resp: resp_tx,
                        })
                        .is_err()
                    {
                        // The dispatch server is gone -- the turn is over.
                        // Latch gate-cancel so the watcher hook stops the
                        // run; the return value is inert (the consumer is
                        // gone with the run).
                        return DispatchOutcome::GateCancelled;
                    }
                    match resp_rx.recv() {
                        Ok(outcome) => outcome,
                        // The server dropped without replying -- treat as a
                        // cancellation, never a silent success.
                        Err(_) => DispatchOutcome::GateCancelled,
                    }
                })
                .await;
                match outcome {
                    Ok(DispatchOutcome::Done { result }) => {
                        // Always Ok, error results included: the content
                        // string IS the error text the model self-corrects
                        // from (ADR-0077); rig's fail-fast channel stays
                        // unreachable by construction. The trace entry and
                        // promotion already landed on the shared state at
                        // the server's record-before-send site, so this
                        // segment's abandonment (a cancel that drops the
                        // callback future) strands nothing (#921).
                        Ok(rig_agent::tool::ToolOutput::text(result.content))
                    }
                    Ok(DispatchOutcome::GateCancelled) => {
                        state.gate_cancelled.store(true, Ordering::SeqCst);
                        Ok(rig_agent::tool::ToolOutput::text(
                            "tool call aborted: the turn was cancelled",
                        ))
                    }
                    Ok(DispatchOutcome::Aborted(termination)) => {
                        *state.aborted.lock().expect("aborted lock poisoned") = Some(termination);
                        Ok(rig_agent::tool::ToolOutput::text(
                            "tool call aborted: the turn failed",
                        ))
                    }
                    // The spawn_blocking task itself panicked -- the honest
                    // abort path (issue #321's adapter-side twin).
                    Err(join_err) => {
                        *state.aborted.lock().expect("aborted lock poisoned") =
                            Some(Termination::Transient(format!(
                                "gateway dispatch task failed: {join_err}"
                            )));
                        Ok(rig_agent::tool::ToolOutput::text(
                            "tool call aborted: the turn failed",
                        ))
                    }
                }
            })
        },
    )
}

/// The type of the shared live-phase sink: both the dispatch server (call
/// events, post-gate timing exactly like `execute_call`) and the runner's
/// event fold (thinking / prose events) forward through this, so one
/// callback sees the whole ADR-0059 stream in order.
pub(crate) type PhaseSink = Arc<Mutex<dyn FnMut(TurnPhase) + Send>>;

/// Emit one phase through the shared sink. A poisoned lock means the phase
/// callback itself panicked mid-turn -- surfaced, not swallowed (the turn is
/// unrecoverable at that point).
pub(crate) fn emit_phase(sink: &PhaseSink, phase: TurnPhase) {
    (sink.lock().expect("phase sink poisoned"))(phase);
}
