//! The gateway tool adapter (ADR-0107 Decision 3, issue #668): the single
//! `AgentTool` implementation yoagent sees. One adapter instance per catalog
//! entry -- name / description / schema come verbatim from the app's
//! gateway-assembled tool table (built-in DuckDB tools direct-listed + the
//! external meta-tool trio + registered CLI tools, ADR-0105/0108), so the
//! upstream surface IS the gateway surface. Execution routes the shared
//! [`dispatch_gated_call`] core (the same code path the built-in loop's
//! `execute_call` drives), so classification, approval gating, audit,
//! `result_N` numbering, and trace-entry shape are identical by construction.
//!
//! None of yoagent's own tooling is registered: no upstream built-ins (bash /
//! file read-write-edit / search), no MCP client, no skills loader, no
//! sub-agent -- the app gateway is the single enforcement point (ADR-0105)
//! and the only tool surface (pinned by `mod.rs`'s context-construction
//! test).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde_json::Value as JsonValue;
use tokio_util::sync::CancellationToken;

use crate::model::{Promotion, TurnPhase};
use crate::provider::tool_calling::{ToolDefinition, ToolResult, ToolUse};
use crate::session::agent_loop::Termination;

/// One dispatch request crossing from the async loop to the caller thread's
/// dispatch server: the call to route, plus the response channel for its
/// outcome. Owned data only -- the session's borrowed collaborators
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
        result: ToolResult,
        entry: Option<crate::session::agent_loop::TraceEntry>,
        promotion: Option<Promotion>,
    },
    /// The approval gate was cancelled mid-call -- the whole turn aborts
    /// (the built-in loop's `GateCancelled` semantics).
    GateCancelled,
    /// A dispatch panic (issue #321 guard) -- the whole turn fails honestly.
    Aborted(Termination),
}

/// State shared between the adapter instances (async side), the caller-side
/// dispatch server, and the runner's event fold. All fields are
/// interior-mutability + lock/atomic guarded; the entries map is drained by
/// the fold as `ToolExecutionEnd` events arrive (the adapter records each
/// entry BEFORE returning from `execute`, which happens-before the
/// `ToolExecutionEnd` send -- so the fold always finds a recorded entry for
/// a dispatched call).
pub(crate) struct SharedTurnState {
    /// Trace entries keyed by tool-call id, recorded by the adapter as each
    /// dispatch lands.
    pub(crate) entries: Mutex<HashMap<String, crate::session::agent_loop::TraceEntry>>,
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
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            promotions: Mutex::new(Vec::new()),
            gate_cancelled: AtomicBool::new(false),
            aborted: Mutex::new(None),
        }
    }
}

/// The per-catalog-entry gateway adapter (ADR-0107 Decision 3). Holds the
/// app-side definition (name / description / schema ride verbatim to the
/// upstream tool table) plus the shared turn state and the request channel
/// into the caller-thread dispatch server. `Send + Sync + 'static` -- only
/// owned / channel state, never a session borrow.
pub(crate) struct GatewayToolAdapter {
    def: ToolDefinition,
    state: Arc<SharedTurnState>,
    dispatch: mpsc::Sender<DispatchRequest>,
    upstream_cancel: CancellationToken,
}

impl GatewayToolAdapter {
    pub(crate) fn new(
        def: ToolDefinition,
        state: Arc<SharedTurnState>,
        dispatch: mpsc::Sender<DispatchRequest>,
        upstream_cancel: CancellationToken,
    ) -> Self {
        Self {
            def,
            state,
            dispatch,
            upstream_cancel,
        }
    }
}

#[async_trait::async_trait]
impl yoagent::types::AgentTool for GatewayToolAdapter {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn label(&self) -> &str {
        &self.def.name
    }

    fn description(&self) -> &str {
        &self.def.description
    }

    fn parameters_schema(&self) -> JsonValue {
        self.def.input_schema.clone()
    }

    /// Route the call through the app gateway. The blocking dispatch (gate
    /// suspension + DuckDB execution) runs on `spawn_blocking` so the async
    /// runtime never carries the session's synchronous work; the channel
    /// round-trip lands the outcome back here, where it is recorded into the
    /// shared state and mapped onto the upstream result shape.
    ///
    /// Error mapping (ADR-0077 semantics, yoagent shape): a tool-level error
    /// feeds back to the model as an error result -- upstream, that is
    /// `Err(ToolError::Failed)` (an `Ok` result is always `is_error: false`
    /// in yoagent's executor), carrying the same content string the built-in
    /// loop feeds back. A gate-cancel or channel close maps onto
    /// `Err(ToolError::Cancelled)` after firing the upstream cancellation,
    /// stopping the run.
    async fn execute(
        &self,
        params: JsonValue,
        ctx: yoagent::types::ToolContext,
    ) -> Result<yoagent::types::ToolResult, yoagent::types::ToolError> {
        let call = ToolUse {
            id: ctx.tool_call_id,
            name: self.def.name.clone(),
            input: params,
        };
        let (resp_tx, resp_rx) = mpsc::channel::<DispatchOutcome>();
        let state = Arc::clone(&self.state);
        let dispatch = self.dispatch.clone();
        let upstream_cancel = self.upstream_cancel.clone();
        tokio::task::spawn_blocking(move || {
            if dispatch
                .send(DispatchRequest {
                    call,
                    resp: resp_tx,
                })
                .is_err()
            {
                // The dispatch server is gone -- the turn is over. Cancel so
                // the loop stops rather than spinning on dead channels.
                upstream_cancel.cancel();
                return Err(yoagent::types::ToolError::Cancelled);
            }
            match resp_rx.recv() {
                Ok(DispatchOutcome::Done {
                    result,
                    entry,
                    promotion,
                }) => {
                    if let Some(entry) = entry {
                        state
                            .entries
                            .lock()
                            .expect("entries lock poisoned")
                            .insert(result.tool_use_id.clone(), entry);
                    }
                    if let Some(promotion) = promotion {
                        state
                            .promotions
                            .lock()
                            .expect("promotions lock poisoned")
                            .push(promotion);
                    }
                    if result.is_error {
                        Err(yoagent::types::ToolError::Failed(result.content))
                    } else {
                        Ok(yoagent::types::ToolResult {
                            content: vec![yoagent::types::Content::Text {
                                text: result.content,
                            }],
                            details: JsonValue::Null,
                        })
                    }
                }
                Ok(DispatchOutcome::GateCancelled) => {
                    state.gate_cancelled.store(true, Ordering::SeqCst);
                    upstream_cancel.cancel();
                    Err(yoagent::types::ToolError::Cancelled)
                }
                Ok(DispatchOutcome::Aborted(termination)) => {
                    *state.aborted.lock().expect("aborted lock poisoned") = Some(termination);
                    upstream_cancel.cancel();
                    Err(yoagent::types::ToolError::Cancelled)
                }
                // The server dropped without replying -- treat as a
                // cancellation, never a silent success.
                Err(_) => {
                    upstream_cancel.cancel();
                    Err(yoagent::types::ToolError::Cancelled)
                }
            }
        })
        .await
        .unwrap_or_else(|join_err| {
            Err(yoagent::types::ToolError::Failed(format!(
                "gateway dispatch task failed: {join_err}"
            )))
        })
    }
}

/// The type of the shared live-phase sink: both the dispatch server (call
/// events, post-gate timing exactly like `execute_call`) and the runner's
/// event fold (thinking / prose events) forward through this, so one
/// callback sees the whole ADR-0059 stream in order.
pub(crate) type PhaseSink = Arc<Mutex<dyn FnMut(TurnPhase) + Send>>;

/// Emit one phase through the shared sink. A poisoned lock means the phase
/// callback itself panicked mid-turn -- surfaced, not swallowed (the turn is
/// unrecoverable at that point, mirroring the built-in loop's in-place
/// callback panic).
pub(crate) fn emit_phase(sink: &PhaseSink, phase: TurnPhase) {
    (sink.lock().expect("phase sink poisoned"))(phase);
}
