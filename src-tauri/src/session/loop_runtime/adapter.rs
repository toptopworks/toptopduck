//! The gateway tool adapter (ADR-0116 Decision 4, issue #917): the single
//! tool surface the rig loop runtime sees. One [`DynamicTool`] per catalog
//! entry -- name / description / schema ride verbatim from the app's
//! gateway-assembled tool table, so the upstream surface IS the gateway
//! surface. Execution routes the shared [`dispatch_gated_call`] core on the
//! caller's thread via the std-mpsc dispatch channel.
//!
//! The callback always resolves `Ok`: a tool-level failure (including the
//! gateway's error results) feeds back to the model as an error-text result
//! it can self-correct from (ADR-0028), so the upstream fail-fast error
//! channel is structurally unreachable. Cancel / abort states latch in the
//! shared turn state, where the cancel-watcher hook stops the run at its
//! next checkpoint (the rig loop has no external cancellation token to
//! fire; the driver's select race covers the silence between checkpoints).
//!
//! Call identity: rig's [`DynamicTool`] callback receives no tool-call id
//! (the context it hands over is a blank typed map, ADR-0116 Decision 2's
//! inert `ToolContext`), so each dispatch carries a locally minted
//! sequential id. The rig-side correlation of a result back to its call
//! never crosses this boundary -- rig assembles that itself from the call
//! it issued; the app's trace entries pair with the event stream by
//! completion order (single-concurrency execution makes dispatch order ==
//! call order == result-forwarding order, the sequential-strategy
//! guarantee ADR-0107 pinned for the yoagent layer and Decision 4 keeps
//! here with `tool_concurrency = 1`).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    pub(crate) resp: mpsc::Sender<DispatchOutcome>,
}

/// The dispatch server's reply for one call.
// One message crosses per tool call (never a hot loop), so the variant size
// spread between `Done` and the two abort arms is not worth boxing.
#[allow(clippy::large_enum_variant)]
pub(crate) enum DispatchOutcome {
    /// The routed outcome: the model-facing result, its trace entry (`None`
    /// for a meta-tool resolution failure that never reached a tool), and
    /// any promotion.
    Done {
        result: crate::provider::tool_calling::ToolResult,
        entry: Option<crate::session::loop_contract::TraceEntry>,
        promotion: Option<Promotion>,
    },
    /// The approval gate was cancelled mid-call -- the whole turn aborts
    /// (the built-in loop's `GateCancelled` semantics).
    GateCancelled,
    /// A dispatch panic (issue #321 guard) -- the whole turn fails honestly.
    Aborted(Termination),
}

/// State shared between the tool callbacks (driver side), the caller-side
/// dispatch server, and the runner's event fold. All fields are
/// interior-mutability + lock/atomic guarded. Completed entries queue in
/// completion order; the fold drains one per executed-tool-result event,
/// which the sequential execution strategy forwards in the same order.
pub(crate) struct SharedTurnState {
    /// Completed calls' trace entries, completion order. Keyed by nothing:
    /// rig's callback surface carries no call id (see the module doc), and
    /// single-concurrency execution makes order the exact pairing.
    pub(crate) completed: Mutex<VecDeque<crate::session::loop_contract::TraceEntry>>,
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
    /// two surfaces cannot drift (the yoagent layer spelled this predicate
    /// out twice; the twin keeps its own copy until its retirement).
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
            completed: Mutex::new(VecDeque::new()),
            promotions: Mutex::new(Vec::new()),
            gate_cancelled: AtomicBool::new(false),
            aborted: Mutex::new(None),
        }
    }
}

/// Mint the per-dispatch call id: sequential, prefixed so an id can never be
/// mistaken for a provider-issued handle (the gateway mints its own).
pub(crate) fn next_call_id(counter: &AtomicU64) -> String {
    format!("gateway-{}", counter.fetch_add(1, Ordering::Relaxed))
}

/// Build the per-catalog-entry gateway adapter (ADR-0116 Decision 4): a
/// [`DynamicTool`] whose name / description / schema ride verbatim from the
/// app tool table. `Send + Sync + 'static` -- only owned / channel state,
/// never a session borrow.
pub(crate) fn gateway_dynamic_tool(
    def: ToolDefinition,
    state: Arc<SharedTurnState>,
    dispatch: mpsc::Sender<DispatchRequest>,
    call_ids: Arc<AtomicU64>,
) -> rig_agent::tool::DynamicTool {
    let name = def.name.clone();
    rig_agent::tool::DynamicTool::new(
        def.name.clone(),
        def.description.clone(),
        def.input_schema.clone(),
        move |_context, args| {
            let call = ToolUse {
                id: next_call_id(&call_ids),
                name: name.clone(),
                input: args,
            };
            let state = Arc::clone(&state);
            let dispatch = dispatch.clone();
            Box::pin(async move {
                // The blocking dispatch round-trip (channel send + the
                // caller thread's gated execution) must not sit on the async
                // runtime's thread, mirroring the yoagent adapter's
                // spawn_blocking hop.
                let outcome = tokio::task::spawn_blocking(move || {
                    let (resp_tx, resp_rx) = mpsc::channel::<DispatchOutcome>();
                    if dispatch
                        .send(DispatchRequest {
                            call,
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
                    Ok(DispatchOutcome::Done {
                        result,
                        entry,
                        promotion,
                    }) => {
                        if let Some(entry) = entry {
                            state
                                .completed
                                .lock()
                                .expect("completed lock poisoned")
                                .push_back(entry);
                        }
                        if let Some(promotion) = promotion {
                            state
                                .promotions
                                .lock()
                                .expect("promotions lock poisoned")
                                .push(promotion);
                        }
                        // Always Ok, error results included: the content
                        // string IS the error text the model self-corrects
                        // from (ADR-0028); rig's fail-fast channel stays
                        // unreachable by construction.
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
