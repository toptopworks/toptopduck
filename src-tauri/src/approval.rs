//! Tiered tool-approval gateway (ADR-0080, issue #294).
//!
//! The gateway is the single enforcement point for tool-call trust
//! (ADR-0076). Every model-emitted tool call passes through [`classify`]
//! before it reaches [`crate::tools::dispatch`]:
//!
//! 1. **Built-in read-only + materialize pass through** (ADR-0080 Decision 1):
//!    explore / describe / sample are in-DB with no egress; materialize is
//!    in-DB only. Zero approval friction.
//! 2. **External MCP tools default to per-call confirmation** (ADR-0080
//!    Decision 3): the gateway suspends that turn's call and waits for the
//!    user's answer via the in-flow approval card (ADR-0083). The wait blocks
//!    ONLY that turn -- every session owns its own [`ApprovalState`] on its
//!    [`crate::session_store::SessionHandle`], so a pending approval in one
//!    session never blocks another (ADR-0080 "仅阻断该轮次").
//! 3. **"Always allow"** escalates a single `server::tool` to session-level
//!    trust (ADR-0080 Decision 3) -- same tool, different params share trust;
//!    param-pattern granularity is deliberately out of scope (v1).
//! 4. **Authorization mode** is a session-level posture (ADR-0080 Decision 4):
//!    the default [`AuthMode::PerCall`] confirms each external call;
//!    [`AuthMode::NoConfirmation`] auto-passes every external call. Both the
//!    mode and the trust set are session-level, reset to default on resume,
//!    and never enter the recipe / app-config (ADR-0080 -- trust state is a
//!    machine/session-level safety state, not a portable workspace
//!    description).
//!
//! State lives on the [`SessionHandle`], NOT inside the `Session` mutex: a
//! turn runs under `spawn_blocking` while holding the session lock, so the
//! `respond_tool_approval` command (which arrives on a different IPC call)
//! must reach the approval state without acquiring the lock the waiting turn
//! holds. The handle is the natural boundary -- it already carries the cancel
//! token / closing flag / resume flag as interior-mutable per-session state.
//!
//! ACP `session/request_permission` (ADR-0081) is serviced by
//! [`auto_allowed`]: the bridge (#299) maps each permission option to a
//! [`ToolKey`] and the gateway returns the subset the policy auto-permits.
//! An empty return = fail-fast (no interactive confirmation over ACP).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cancel::CancelToken;

// ---------------------------------------------------------------------------
// Identifiers + posture
// ---------------------------------------------------------------------------

/// The trust granularity (ADR-0080): `server::tool`. Built-in tools live
/// under a reserved `builtin` server so they are trivially distinguishable
/// from external MCP tools (whose server is the user-configured MCP server
/// name, ADR-0076).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ToolKey {
    pub server: String,
    pub tool: String,
}

impl ToolKey {
    /// Reserved server name for the four built-in DuckDB tools
    /// (ADR-0076/0080). Tools under this server always pass the gate.
    pub const BUILTIN_SERVER: &'static str = "builtin";

    /// A built-in tool key (explore / materialize / describe / sample).
    pub fn builtin(tool: impl Into<String>) -> Self {
        Self {
            server: Self::BUILTIN_SERVER.to_string(),
            tool: tool.into(),
        }
    }

    /// An external MCP tool key. `server` is the user-configured MCP server
    /// name (ADR-0076); `tool` is the tool name that server advertises.
    pub fn external(server: impl Into<String>, tool: impl Into<String>) -> Self {
        Self {
            server: server.into(),
            tool: tool.into(),
        }
    }

    /// Whether this key names a built-in tool (always passes the gate,
    /// ADR-0080 Decision 1).
    pub fn is_builtin(&self) -> bool {
        self.server == Self::BUILTIN_SERVER
    }
}

/// Session-level authorization posture (ADR-0080 Decision 4). The default is
/// [`AuthMode::PerCall`]; [`AuthMode::NoConfirmation`] is an explicit,
/// session-scoped, resume-resetting posture that auto-passes every external
/// tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// Default: every external tool call is confirmed individually unless it
    /// is in the session trust set ("always allow").
    #[default]
    PerCall,
    /// Explicit no-confirmation posture: all external tool calls auto-pass.
    /// Resume resets to [`AuthMode::PerCall`]; the UI marks it with a warning
    /// color (ADR-0083).
    NoConfirmation,
}

/// Operation category for the approval-card badge (ADR-0083 read / write /
/// execute / network). Presentation-only -- the gateway does not branch on
/// it. The external-tool bridge classifies each call; the gateway just
/// carries the label through to the event so the frontend renders the right
/// badge without re-inferring.
///
/// The serde form is a `.duck` persistence contract (issue #316): persisted
/// recipe traces reuse this enum (`RecipeTraceEntry.operation_kind`,
/// ADR-0078), so the `rename_all = "snake_case"` variant spellings (`read` /
/// `write` / `execute` / `network`) are part of the recipe wire format,
/// frozen by the backward-compatibility constraint. Renaming a variant or
/// reworking the case convention breaks historical `.duck` readability;
/// appending a variant is append-only-safe (no historical file carries it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    #[default]
    Read,
    Write,
    Execute,
    Network,
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

/// The gateway's classification of a tool call (ADR-0080). The
/// [`ApprovalState`] gate maps this to a concrete action (pass / suspend /
/// refuse).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Classification {
    /// Pass through: built-in (Decision 1), OR trusted via "always allow"
    /// (Decision 3), OR the session is in [`AuthMode::NoConfirmation`]
    /// (Decision 4).
    Allow,
    /// Hard refusal. The gateway does not classify anything as `Deny` today
    /// -- external tools default to [`Classification::NeedsApproval`] -- but
    /// the variant is kept so a future deny-list can refuse without
    /// suspending.
    Deny,
    /// External tool under [`AuthMode::PerCall`] that is not in the trust
    /// set: suspend this turn's call and surface the in-flow approval card
    /// (ADR-0083).
    NeedsApproval,
}

/// Pure policy check (ADR-0080). Given the tool, the session posture, and the
/// trust set, return the classification. Stateful side effects (suspending
/// the turn, emitting the card) live in [`ApprovalState::gate`]; this fn is
/// the testable, side-effect-free core.
pub fn classify(key: &ToolKey, mode: AuthMode, trust: &HashSet<ToolKey>) -> Classification {
    // (1) Built-in read-only + materialize: zero approval (ADR-0080 Decision 1).
    if key.is_builtin() {
        return Classification::Allow;
    }
    // (4) No-confirmation posture: every external call auto-passes (Decision 4).
    if mode == AuthMode::NoConfirmation {
        return Classification::Allow;
    }
    // (3) "Always allow" (per-tool session trust) overrides per-call (Decision 3).
    if trust.contains(key) {
        return Classification::Allow;
    }
    // (3) Default: external tool under PerCall, not trusted -> suspend + ask.
    Classification::NeedsApproval
}

/// Auto-select the tool keys the gateway permits without interactive
/// confirmation (ADR-0081 ACP `session/request_permission`, issue #294).
///
/// The ACP bridge (#299) maps each permission option to a [`ToolKey`] and
/// calls this against the live policy. The returned subset is what the bridge
/// answers with; an empty return = no selectable option = fail-fast (ACP
/// carries no interactive confirmation channel -- that path is the MCP-side
/// approval card, not the ACP permission handshake).
pub fn auto_allowed<'a, I>(keys: I, mode: AuthMode, trust: &HashSet<ToolKey>) -> Vec<&'a ToolKey>
where
    I: IntoIterator<Item = &'a ToolKey>,
{
    keys.into_iter()
        .filter(|k| classify(k, mode, trust) == Classification::Allow)
        .collect()
}

// ---------------------------------------------------------------------------
// Wire payloads + sink
// ---------------------------------------------------------------------------

/// The user's answer to an approval request (ADR-0083 three-button card).
/// Wire form crosses IPC both as a command argument
/// (`respond_tool_approval`) and inside the resolved event payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalResponse {
    /// Allow this single call; do not persist trust.
    AllowOnce,
    /// Allow this call AND escalate the `server::tool` to the session trust
    /// set (ADR-0080 Decision 3). Subsequent calls to the same tool pass the
    /// gate without surfacing the card.
    AlwaysAllow,
    /// Refuse this call. The turn receives a tool-level denial the agent can
    /// self-correct from (ADR-0077).
    Deny,
}

/// The body of an approval request -- the parts the gateway produces. The
/// session id + request id are stamped on emission: the session id is closed
/// over by the sink (built at the command boundary like the `on_phase`
/// callback), and the request id is minted per gate call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalRequestBody {
    pub request_id: String,
    pub server: String,
    pub tool: String,
    pub operation_kind: OperationKind,
    /// Short agent-readable parameter summary for the card body (ADR-0083).
    /// NOT the full call arguments -- those may be large or sensitive; the
    /// bridge summarizes (e.g. "GET https://example.com/x" / "write ~/file").
    pub summary: String,
}

/// Full `approval-request` event payload (ADR-0083, addressed by session id).
/// Mirrored on the frontend as `ApprovalRequestPayload`.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequestPayload {
    pub session_id: String,
    pub request_id: String,
    pub server: String,
    pub tool: String,
    pub operation_kind: OperationKind,
    pub summary: String,
}

/// Full `approval-resolved` event payload -- the frontend uses this to flip a
/// pending card to its resolved state in place (ADR-0083).
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalResolvedPayload {
    pub session_id: String,
    pub request_id: String,
    pub response: ApprovalResponse,
}

/// Emit side-channel for approval events (ADR-0083). Implemented at the
/// command boundary with a Tauri `AppHandle` + the session id; the gate calls
/// it to surface the card and to announce the resolution. The trait keeps the
/// gateway decoupled from Tauri -- tests supply a recording sink. `Send +
/// Sync` so the agent loop (#295) can thread a sink across the
/// `spawn_blocking` boundary without changing the trait's API surface.
pub trait ApprovalSink: Send + Sync {
    /// Surface a new pending approval (emits `approval-request`).
    fn emit_request(&self, body: &ApprovalRequestBody);
    /// Announce that a pending request was answered (emits `approval-resolved`).
    fn emit_resolved(&self, body: &ApprovalRequestBody, response: ApprovalResponse);
}

// ---------------------------------------------------------------------------
// Gate outcome
// ---------------------------------------------------------------------------

/// The decision the gate returns to the agent loop (ADR-0080).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateOutcome {
    /// The call proceeds -- the agent loop runs [`crate::tools::dispatch`] (or
    /// the external bridge forwards the call).
    Allow,
    /// The user (or policy) refused the call. The agent loop surfaces a
    /// tool-level denial the model can self-correct from (ADR-0077) -- it is
    /// NOT a transport error and does NOT fail the turn.
    Denied,
}

/// The turn was cancelled (or the session closed) while the call was pending.
/// The agent loop maps this to the turn's `Cancelled` outcome (ADR-0077).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GateCancelled;

/// The gateway-facing request summary: what the agent loop hands the gate.
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub key: ToolKey,
    pub operation_kind: OperationKind,
    pub summary: String,
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

/// One in-flight approval. Only one can exist per session at a time: a turn
/// runs under the per-session single-flight gate (ADR-0021), so tool calls are
/// serial within a session and the next call cannot enter the gate until the
/// previous one returns.
struct Pending {
    request_id: uuid::Uuid,
    response: Option<ApprovalResponse>,
}

/// Per-session approval state (ADR-0080). Lives on the [`SessionHandle`] as an
/// `Arc<ApprovalState>` so the turn (holding the `Session` mutex) and the
/// `respond_tool_approval` command (which must NOT take that mutex) share it
/// directly.
pub struct ApprovalState {
    auth_mode: Mutex<AuthMode>,
    trust: Mutex<HashSet<ToolKey>>,
    pending: Mutex<Option<Pending>>,
    /// Paired with [`Self::pending`]: the gate waits on it; `respond` +
    /// [`Self::interrupt_pending`] notify it.
    cv: Condvar,
    /// Latched by [`Self::interrupt_pending`] so a cancel that arrives before
    /// the gate enters the wait is not lost (the gate checks this on entry).
    interrupted: AtomicBool,
}

impl Default for ApprovalState {
    fn default() -> Self {
        Self::new()
    }
}

/// Maximum wall time the gate waits between cancel re-checks. The response
/// arrives from a human clicking the approval card, so 200ms polling latency
/// is invisible; the interval is a safety net for a missed
/// `interrupt_pending` wake, not the primary wake path (the condvar notify).
const GATE_CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(200);

impl ApprovalState {
    pub fn new() -> Self {
        Self {
            auth_mode: Mutex::new(AuthMode::default()),
            trust: Mutex::new(HashSet::new()),
            pending: Mutex::new(None),
            cv: Condvar::new(),
            interrupted: AtomicBool::new(false),
        }
    }

    /// Read the current authorization mode (ADR-0080 Decision 4).
    pub fn auth_mode(&self) -> AuthMode {
        *self.auth_mode.lock().expect("auth_mode lock poisoned")
    }

    /// Set the authorization mode (ADR-0080 Decision 4). Session-level,
    /// resume-reset (see [`Self::reset`]).
    pub fn set_auth_mode(&self, mode: AuthMode) {
        *self.auth_mode.lock().expect("auth_mode lock poisoned") = mode;
    }

    /// A snapshot of the session trust set ("always allow", ADR-0080 Decision 3).
    pub fn trust_list(&self) -> Vec<ToolKey> {
        self.trust
            .lock()
            .expect("trust lock poisoned")
            .iter()
            .cloned()
            .collect()
    }

    /// Revoke a single tool's session-level trust (ADR-0080 Decision 3).
    pub fn revoke(&self, key: &ToolKey) {
        self.trust.lock().expect("trust lock poisoned").remove(key);
    }

    /// Reset to the default posture (ADR-0080: resume 归零). Clears the trust
    /// set, returns the mode to [`AuthMode::PerCall`], and wakes any in-flight
    /// pending approval so its gate returns [`GateCancelled`] and clears its
    /// own slot (the slot is owned by the gate, not this fn). Called on a
    /// successful resume by `open_duck` -- trust state is session-level and
    /// must not survive a
    /// resume (it is not in the recipe, ADR-0080).
    pub fn reset(&self) {
        *self.auth_mode.lock().expect("auth_mode lock poisoned") = AuthMode::default();
        self.trust.lock().expect("trust lock poisoned").clear();
        // Drop any pending approval: the waiting turn (if any -- resume runs
        // with no turn in flight in practice) wakes to a cancelled state.
        self.interrupt_pending();
    }

    /// Wake any waiting gate (cancel / close / resume). Idempotent: a no-op if
    /// no gate is waiting. The gate re-checks `CancelToken::is_requested` on
    /// wake and returns [`GateCancelled`]. Latching covers a cancel that
    /// lands before the gate enters the wait.
    pub fn interrupt_pending(&self) {
        self.interrupted.store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }

    /// Drive a tool call through the policy gate (ADR-0080).
    ///
    /// - Built-in / trusted / no-confirmation calls return
    ///   [`GateOutcome::Allow`] immediately and never touch
    ///   [`ApprovalSink::emit_request`].
    /// - External PerCall untrusted calls suspend this turn (emit the card,
    ///   wait on the condvar) until `respond` answers or the cancel token
    ///   fires.
    ///
    /// `sink` is built at the command boundary with the `AppHandle` + session
    /// id (mirrors the `on_phase` injection in `Session::ask_with_phase`); the
    /// gate calls it only -- never holds a reference across the wait beyond
    /// the call stack.
    pub fn gate(
        &self,
        request: ApprovalRequest,
        sink: &dyn ApprovalSink,
        cancel: &CancelToken,
    ) -> Result<GateOutcome, GateCancelled> {
        // Pure classify first -- the common case (built-in pass-through,
        // trusted, or no-confirmation) takes no lock on `pending` and never
        // reaches the sink. ADR-0080 AC: built-in read-only + materialize
        // pass with zero approval.
        let mode = self.auth_mode();
        let trust = self.trust.lock().expect("trust lock poisoned").clone();
        match classify(&request.key, mode, &trust) {
            Classification::Allow => return Ok(GateOutcome::Allow),
            Classification::Deny => return Ok(GateOutcome::Denied),
            Classification::NeedsApproval => {}
        }

        let request_id = uuid::Uuid::new_v4();
        let body = ApprovalRequestBody {
            request_id: request_id.to_string(),
            server: request.key.server.clone(),
            tool: request.key.tool.clone(),
            operation_kind: request.operation_kind,
            summary: request.summary,
        };

        // Clear any stale interrupt latch from a prior cancel BEFORE installing
        // the pending slot. Once the slot is live, any interrupt_pending() that
        // arrives is THIS gate's own cancel signal and must NOT be wiped; the
        // prior order (clear after install) could erase a legit interrupt that
        // landed between install and clear (a window future reset call sites
        // outside the session_lock serializer would reopen).
        self.interrupted.store(false, Ordering::SeqCst);
        // Install the pending slot, THEN emit. A respond() that races ahead of
        // the wait still finds the slot (matched by request_id) and stores its
        // answer durably in the mutex -- the gate's subsequent wait sees it
        // and breaks without blocking. No lost wake-up.
        {
            let mut g = self.pending.lock().expect("pending lock poisoned");
            // Serial tool calls within a session (ADR-0021 single-flight) mean
            // at most one in-flight approval; a stale slot here is a bug. Clear
            // it defensively so the new request is observable, then install.
            *g = Some(Pending {
                request_id,
                response: None,
            });
        }
        sink.emit_request(&body);

        // Wait for a response or a cancel. The cancel token is the turn's
        // shared token; fire_cancel() (cancel + close) calls
        // interrupt_pending() to wake this immediately. The poll interval is a
        // safety net, not the primary wake.
        let response = {
            let mut g = self.pending.lock().expect("pending lock poisoned");
            loop {
                if let Some(p) = g.as_ref() {
                    if let Some(resp) = p.response {
                        break Some(resp);
                    }
                }
                if self.interrupted.load(Ordering::SeqCst) || cancel.is_requested() {
                    break None;
                }
                let (g2, _) = self
                    .cv
                    .wait_timeout(g, GATE_CANCEL_POLL_INTERVAL)
                    .expect("pending lock poisoned");
                g = g2;
            }
        };

        // Read out + clear the slot under one lock so a late respond() after a
        // cancel sees no pending (and surfaces a typed error to the stale IPC
        // call instead of mutating a dead request).
        let resolved_response = {
            let mut g = self.pending.lock().expect("pending lock poisoned");
            let p = g.take();
            // Notify any watcher (defensive -- the only waiter was this gate).
            self.cv.notify_all();
            p.and_then(|p| p.response)
        };

        match (response, resolved_response) {
            // A response landed -- either the wait loop saw it (Some) OR it was
            // stored between the loop's cancel-break and the slot take
            // (None, Some). In both cases the user's answer is durable in the
            // mutex; honor it: apply_response emits the resolved event with the
            // ACTUAL answer and escalates trust on AlwaysAllow. The prior
            // `(None, _)` arm forced a synthetic Deny that contradicted a
            // respond() which had already returned Ok, and silently dropped the
            // AlwaysAllow trust escalation.
            (Some(resp), _) | (None, Some(resp)) => {
                self.apply_response(&request.key, resp, &body, sink)
            }
            (None, None) => {
                // Cancelled / closed with no landed answer. The card resolves
                // to a denial so the frontend does not leave a stale pending
                // entry; the agent loop sees `Cancelled` (not the card's
                // denial) because the turn-level outcome is driven by the Err
                // branch.
                sink.emit_resolved(&body, ApprovalResponse::Deny);
                Err(GateCancelled)
            }
        }
    }

    /// Map the user's answer to a gate outcome and apply trust escalation
    /// (ADR-0080 Decision 3).
    fn apply_response(
        &self,
        key: &ToolKey,
        response: ApprovalResponse,
        body: &ApprovalRequestBody,
        sink: &dyn ApprovalSink,
    ) -> Result<GateOutcome, GateCancelled> {
        sink.emit_resolved(body, response);
        match response {
            ApprovalResponse::AllowOnce => Ok(GateOutcome::Allow),
            ApprovalResponse::AlwaysAllow => {
                // Escalate to session-level trust (ADR-0080 Decision 3). Same
                // tool, different params share trust; param-pattern
                // granularity is out of scope (v1).
                self.trust
                    .lock()
                    .expect("trust lock poisoned")
                    .insert(key.clone());
                Ok(GateOutcome::Allow)
            }
            ApprovalResponse::Deny => Ok(GateOutcome::Denied),
        }
    }

    /// Answer the in-flight approval (ADR-0083). Called by the
    /// `respond_tool_approval` command. Returns `Err` if no pending request
    /// matches `request_id` -- the frontend's IPC call surfaces a typed error
    /// (a stale response after cancel, or a duplicate answer).
    pub fn respond(
        &self,
        request_id: uuid::Uuid,
        response: ApprovalResponse,
    ) -> Result<(), RespondError> {
        let mut g = self.pending.lock().expect("pending lock poisoned");
        let Some(p) = g.as_mut() else {
            return Err(RespondError::NoPending);
        };
        if p.request_id != request_id {
            return Err(RespondError::UnknownRequest);
        }
        // Idempotent guard: a second answer to the same request (a double-fire
        // race in the UI) is rejected rather than silently overwriting a
        // consumed response.
        if p.response.is_some() {
            return Err(RespondError::AlreadyAnswered);
        }
        p.response = Some(response);
        self.cv.notify_all();
        Ok(())
    }

    /// Whether a tool key is currently in the session trust set (test surface
    /// for the "always allow" AC).
    #[cfg(test)]
    pub fn is_trusted(&self, key: &ToolKey) -> bool {
        self.trust
            .lock()
            .expect("trust lock poisoned")
            .contains(key)
    }
}

/// Why a `respond_tool_approval` call did not land (issue #294).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RespondError {
    /// No approval is pending on this session.
    NoPending,
    /// The request id does not match the pending one (stale / duplicate).
    UnknownRequest,
    /// The pending request was already answered.
    AlreadyAnswered,
}

impl RespondError {
    /// Stable wire discriminant for the frontend (mirrors the Rust variant).
    pub fn as_kind(&self) -> &'static str {
        match self {
            Self::NoPending => "no_pending",
            Self::UnknownRequest => "unknown_request",
            Self::AlreadyAnswered => "already_answered",
        }
    }
}

/// Convenience alias for callers that hold the state behind an `Arc` (the
/// `SessionHandle` shape). The gate runs against `&ApprovalState` either way.
pub type SharedApprovalState = Arc<ApprovalState>;

#[cfg(test)]
mod tests {
    use super::*;

    /// Recording sink for tests: thread-safe (the gate may run on a spawned
    /// thread while the test thread reads the recordings).
    #[derive(Default)]
    struct RecordingSink {
        requests: Mutex<Vec<ApprovalRequestBody>>,
        resolved: Mutex<Vec<(ApprovalRequestBody, ApprovalResponse)>>,
    }

    impl ApprovalSink for RecordingSink {
        fn emit_request(&self, body: &ApprovalRequestBody) {
            self.requests.lock().unwrap().push(body.clone());
        }
        fn emit_resolved(&self, body: &ApprovalRequestBody, response: ApprovalResponse) {
            self.resolved.lock().unwrap().push((body.clone(), response));
        }
    }

    impl RecordingSink {
        fn last_request(&self) -> Option<ApprovalRequestBody> {
            self.requests.lock().unwrap().last().cloned()
        }
        fn request_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    // --- pure classify -----------------------------------------------------

    #[test]
    fn builtin_tools_always_pass() {
        let mode = AuthMode::PerCall;
        let trust = HashSet::new();
        for name in ["explore", "materialize", "describe", "sample"] {
            let key = ToolKey::builtin(name);
            assert_eq!(
                classify(&key, mode, &trust),
                Classification::Allow,
                "built-in {name} must pass with zero approval (ADR-0080 Decision 1)"
            );
        }
    }

    #[test]
    fn external_per_call_untrusted_needs_approval() {
        let key = ToolKey::external("acme", "fetch");
        assert_eq!(
            classify(&key, AuthMode::PerCall, &HashSet::new()),
            Classification::NeedsApproval
        );
    }

    #[test]
    fn external_per_call_trusted_passes() {
        let key = ToolKey::external("acme", "fetch");
        let mut trust = HashSet::new();
        trust.insert(key.clone());
        assert_eq!(
            classify(&key, AuthMode::PerCall, &trust),
            Classification::Allow,
            "always-allow trust overrides per-call (ADR-0080 Decision 3)"
        );
    }

    #[test]
    fn no_confirmation_mode_passes_all_external() {
        let key = ToolKey::external("acme", "fetch");
        assert_eq!(
            classify(&key, AuthMode::NoConfirmation, &HashSet::new()),
            Classification::Allow,
            "no-confirmation posture auto-passes every external call (ADR-0080 Decision 4)"
        );
    }

    #[test]
    fn trust_is_scoped_to_server_tool() {
        // Same tool name, different server -> different trust (ADR-0076/0080).
        let trusted = ToolKey::external("acme", "fetch");
        let mut trust = HashSet::new();
        trust.insert(trusted);
        let other = ToolKey::external("other", "fetch");
        assert_eq!(
            classify(&other, AuthMode::PerCall, &trust),
            Classification::NeedsApproval,
            "trust is per server::tool, not per tool name"
        );
    }

    // --- ACP auto-select ---------------------------------------------------

    #[test]
    fn acp_auto_select_no_confirmation_allows_all() {
        let keys = vec![
            ToolKey::external("acme", "fetch"),
            ToolKey::external("other", "write"),
        ];
        let allowed = auto_allowed(&keys, AuthMode::NoConfirmation, &HashSet::new());
        assert_eq!(allowed.len(), 2, "no-confirmation selects every option");
    }

    #[test]
    fn acp_auto_select_per_call_only_allows_trusted() {
        let trusted = ToolKey::external("acme", "fetch");
        let mut trust = HashSet::new();
        trust.insert(trusted.clone());
        let keys = vec![
            trusted,
            ToolKey::external("acme", "write"),
            ToolKey::external("other", "fetch"),
        ];
        let allowed = auto_allowed(&keys, AuthMode::PerCall, &trust);
        assert_eq!(allowed.len(), 1, "only the trusted tool is selectable");
    }

    #[test]
    fn acp_auto_select_empty_is_fail_fast() {
        // PerCall + nothing trusted -> empty -> the bridge fail-fast (ADR-0081).
        let keys = vec![ToolKey::external("acme", "fetch")];
        let allowed = auto_allowed(&keys, AuthMode::PerCall, &HashSet::new());
        assert!(allowed.is_empty(), "empty selection = fail-fast");
    }

    // --- gate lifecycle ----------------------------------------------------

    #[test]
    fn gate_passes_builtin_without_emitting() {
        let state = ApprovalState::new();
        let cancel = CancelToken::new();
        let sink = RecordingSink::default();
        let req = ApprovalRequest {
            key: ToolKey::builtin("explore"),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1".into(),
        };
        let outcome = state.gate(req, &sink, &cancel).expect("builtin allowed");
        assert_eq!(outcome, GateOutcome::Allow);
        assert_eq!(sink.request_count(), 0, "built-in must not surface a card");
    }

    #[test]
    fn gate_passes_trusted_external_without_emitting() {
        let state = ApprovalState::new();
        let key = ToolKey::external("acme", "fetch");
        // Seed trust directly to test the gate short-circuit.
        state.trust.lock().unwrap().insert(key.clone());
        let cancel = CancelToken::new();
        let sink = RecordingSink::default();
        let req = ApprovalRequest {
            key,
            operation_kind: OperationKind::Network,
            summary: "GET /x".into(),
        };
        let outcome = state.gate(req, &sink, &cancel).expect("trusted allowed");
        assert_eq!(outcome, GateOutcome::Allow);
        assert_eq!(sink.request_count(), 0);
    }

    #[test]
    fn gate_passes_external_under_no_confirmation_without_emitting() {
        let state = ApprovalState::new();
        state.set_auth_mode(AuthMode::NoConfirmation);
        let cancel = CancelToken::new();
        let sink = RecordingSink::default();
        let req = ApprovalRequest {
            key: ToolKey::external("acme", "fetch"),
            operation_kind: OperationKind::Network,
            summary: "GET /x".into(),
        };
        let outcome = state.gate(req, &sink, &cancel).expect("no-confirm allowed");
        assert_eq!(outcome, GateOutcome::Allow);
        assert_eq!(sink.request_count(), 0);
    }

    #[test]
    fn gate_suspends_external_until_allow_once() {
        // The gate blocks the calling thread; run it on a worker and answer
        // from the test thread once the request is observable.
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());
        let key = ToolKey::external("acme", "fetch");

        let state_c = Arc::clone(&state);
        let sink_c = Arc::clone(&sink);
        let cancel_c = Arc::clone(&cancel);
        let key_c = key.clone();
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: key_c,
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            (
                state_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c),
                sink_c,
            )
        });

        // Wait for the card to surface, then answer AllowOnce.
        let request_id = poll_for_request(&sink, Duration::from_secs(2)).expect("request emitted");
        state
            .respond(request_id, ApprovalResponse::AllowOnce)
            .expect("respond ok");

        let (outcome, sink) = handle.join().expect("gate thread");
        assert_eq!(outcome.expect("allow"), GateOutcome::Allow);
        assert!(
            !state.is_trusted(&key),
            "AllowOnce must NOT escalate to session trust"
        );
        // Resolution event fired for the frontend.
        let resolved = sink.resolved.lock().unwrap();
        assert_eq!(resolved.len(), 1, "resolved event emitted once");
        assert_eq!(resolved[0].1, ApprovalResponse::AllowOnce);
    }

    #[test]
    fn gate_always_allow_escalates_trust() {
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());
        let key = ToolKey::external("acme", "fetch");

        let state_c = Arc::clone(&state);
        let sink_c = Arc::clone(&sink);
        let key_c = key.clone();
        let cancel_c = Arc::clone(&cancel);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: key_c,
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            state_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        let request_id = poll_for_request(&sink, Duration::from_secs(2)).expect("request emitted");
        state
            .respond(request_id, ApprovalResponse::AlwaysAllow)
            .expect("respond ok");
        let outcome = handle.join().expect("gate thread").expect("allow");
        assert_eq!(outcome, GateOutcome::Allow);
        assert!(
            state.is_trusted(&key),
            "AlwaysAllow must escalate the tool to session trust"
        );

        // A second call to the SAME tool now passes with zero approval.
        let cancel2 = CancelToken::new();
        let sink2 = RecordingSink::default();
        let req = ApprovalRequest {
            key,
            operation_kind: OperationKind::Network,
            summary: "GET /y".into(),
        };
        let outcome2 = state.gate(req, &sink2, &cancel2).expect("trusted now");
        assert_eq!(outcome2, GateOutcome::Allow);
        assert_eq!(sink2.request_count(), 0, "no card on the trusted retry");
    }

    #[test]
    fn gate_deny_returns_denied_outcome() {
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());

        let state_c = Arc::clone(&state);
        let sink_c = Arc::clone(&sink);
        let cancel_c = Arc::clone(&cancel);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            state_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        let request_id = poll_for_request(&sink, Duration::from_secs(2)).expect("request emitted");
        state
            .respond(request_id, ApprovalResponse::Deny)
            .expect("deny ok");
        let outcome = handle
            .join()
            .expect("gate thread")
            .expect("denied, not cancelled");
        assert_eq!(outcome, GateOutcome::Denied);
    }

    #[test]
    fn gate_cancel_returns_cancelled_and_clears_pending() {
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());

        let state_c = Arc::clone(&state);
        let sink_c = Arc::clone(&sink);
        let cancel_c = Arc::clone(&cancel);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            state_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        // Wait for the card, then fire cancel + interrupt (mirrors fire_cancel).
        poll_for_request(&sink, Duration::from_secs(2)).expect("request emitted");
        cancel.request();
        state.interrupt_pending();

        let err = handle.join().expect("gate thread").unwrap_err();
        assert_eq!(err, GateCancelled);

        // A late respond now finds no pending -> typed error (not a silent
        // mutation of a dead request).
        let stale_id = uuid::Uuid::new_v4();
        assert_eq!(
            state.respond(stale_id, ApprovalResponse::AllowOnce),
            Err(RespondError::NoPending)
        );
    }

    #[test]
    fn gate_cancel_before_wait_is_not_lost() {
        // interrupt_pending() lands BEFORE the gate enters the wait. The
        // latched flag must surface as Cancelled, not hang. Also covers a
        // pre-set cancel token (the gate checks is_requested on entry to the
        // wait loop).
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        cancel.request();
        state.interrupt_pending();

        let state_c = Arc::clone(&state);
        let cancel_c = Arc::clone(&cancel);
        let sink_arc: Arc<dyn ApprovalSink + Send + Sync> = Arc::new(RecordingSink::default());
        let sink_arc_c = Arc::clone(&sink_arc);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            state_c.gate(req, &*sink_arc_c, &cancel_c)
        });
        let err = handle.join().expect("gate thread").unwrap_err();
        assert_eq!(err, GateCancelled);
    }

    #[test]
    fn respond_rejects_unknown_and_duplicate() {
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());

        let state_c = Arc::clone(&state);
        let sink_c = Arc::clone(&sink);
        let cancel_c = Arc::clone(&cancel);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            state_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        let request_id = poll_for_request(&sink, Duration::from_secs(2)).expect("request emitted");
        // Wrong id -> UnknownRequest.
        assert_eq!(
            state.respond(uuid::Uuid::new_v4(), ApprovalResponse::AllowOnce),
            Err(RespondError::UnknownRequest)
        );
        // Correct id, first answer ok.
        state
            .respond(request_id, ApprovalResponse::AllowOnce)
            .expect("first answer");
        let _ = handle.join().expect("gate thread");

        // No pending after the gate returned -> NoPending.
        assert_eq!(
            state.respond(request_id, ApprovalResponse::Deny),
            Err(RespondError::NoPending)
        );
    }

    // --- resume reset ------------------------------------------------------

    #[test]
    fn reset_clears_trust_and_mode() {
        let state = ApprovalState::new();
        let key = ToolKey::external("acme", "fetch");
        state.trust.lock().unwrap().insert(key.clone());
        state.set_auth_mode(AuthMode::NoConfirmation);
        assert_eq!(state.auth_mode(), AuthMode::NoConfirmation);

        state.reset();

        assert_eq!(state.auth_mode(), AuthMode::PerCall, "resume resets mode");
        assert!(
            !state.is_trusted(&key),
            "resume clears the trust set (ADR-0080)"
        );
    }

    // --- per-session isolation --------------------------------------------

    #[test]
    fn pending_approval_in_one_session_does_not_block_another() {
        // Two independent states (the SessionHandle shape): a pending gate on
        // one leaves the other fully mutable. This is the structural guarantee
        // behind ADR-0080's per-turn blocking -- the turn's mutex is per
        // session, and so is the approval state.
        let a = Arc::new(ApprovalState::new());
        let b = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());

        let a_c = Arc::clone(&a);
        let sink_c = Arc::clone(&sink);
        let cancel_c = Arc::clone(&cancel);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            a_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        poll_for_request(&sink, Duration::from_secs(2)).expect("a emitted");

        // Session b is freely mutable while a is suspended.
        b.set_auth_mode(AuthMode::NoConfirmation);
        let b_req = ApprovalRequest {
            key: ToolKey::external("other", "fetch"),
            operation_kind: OperationKind::Network,
            summary: "GET /y".into(),
        };
        let b_cancel = CancelToken::new();
        let b_sink = RecordingSink::default();
        let b_outcome = b
            .gate(b_req, &b_sink, &b_cancel)
            .expect("no-confirm passes");
        assert_eq!(b_outcome, GateOutcome::Allow);
        assert_eq!(b_sink.request_count(), 0, "b does not surface a card");

        // Drain a so the worker thread exits.
        if let Some(body) = sink.last_request() {
            let id = uuid::Uuid::parse_str(&body.request_id).unwrap();
            let _ = a.respond(id, ApprovalResponse::Deny);
        }
        let _ = handle.join();
    }

    // --- race + resume-wake ------------------------------------------------

    #[test]
    fn gate_honors_landed_response_over_cancel() {
        // A respond() that returns Ok must be honored: the resolved event
        // carries the user's ACTUAL answer, never a synthetic Deny. Covers
        // both the (Some, _) arm (respond wins the wait loop) and the
        // (None, Some) arm (cancel broke the loop but respond stored before
        // the take); both must emit the user's answer. The prior `(None, _)`
        // arm emitted Deny on the race, contradicting the Ok respond.
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());

        let state_c = Arc::clone(&state);
        let sink_c = Arc::clone(&sink);
        let cancel_c = Arc::clone(&cancel);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            state_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        let request_id = poll_for_request(&sink, Duration::from_secs(2)).expect("request emitted");
        // Respond FIRST (lands the answer durably), then fire the cancel wake.
        // Whether the gate's loop sees the response before or after the
        // interrupt, the resolved event must reflect AllowOnce.
        state
            .respond(request_id, ApprovalResponse::AllowOnce)
            .expect("respond ok");
        cancel.request();
        state.interrupt_pending();

        let outcome = handle.join().expect("gate thread");
        assert_eq!(outcome.expect("user allowed"), GateOutcome::Allow);
        let resolved = sink.resolved.lock().unwrap();
        assert_eq!(resolved.len(), 1, "resolved emitted exactly once");
        assert_eq!(
            resolved[0].1,
            ApprovalResponse::AllowOnce,
            "user's actual answer wins over cancel"
        );
    }

    #[test]
    fn reset_wakes_waiting_gate_to_cancelled() {
        // reset() (the resume reset) must wake a gate blocked on the condvar
        // so the suspended turn returns GateCancelled -- not hang until the
        // 200ms cancel-poll. reset wakes via interrupt_pending ONLY (it does
        // NOT request the cancel token); this pins the resume-cancels-in-
        // flight-approval guarantee (ADR-0080).
        let state = Arc::new(ApprovalState::new());
        let cancel = Arc::new(CancelToken::new());
        let sink = Arc::new(RecordingSink::default());

        let state_c = Arc::clone(&state);
        let sink_c = Arc::clone(&sink);
        let cancel_c = Arc::clone(&cancel);
        let handle = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            state_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        poll_for_request(&sink, Duration::from_secs(2)).expect("request emitted");
        // reset clears trust/mode AND fires interrupt_pending (no cancel-token
        // request) -- the wake under test.
        state.reset();

        let err = handle.join().expect("gate thread").unwrap_err();
        assert_eq!(err, GateCancelled);
        assert!(
            !cancel.is_requested(),
            "reset wakes via interrupt_pending, not the cancel token"
        );
    }

    // --- helper ------------------------------------------------------------

    /// Poll the recording sink until a request body is observable, returning
    /// its parsed request id. Bounded by `timeout` so a logic bug fails the
    /// test instead of hanging CI.
    fn poll_for_request(sink: &Arc<RecordingSink>, timeout: Duration) -> Option<uuid::Uuid> {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if let Some(body) = sink.last_request() {
                return uuid::Uuid::parse_str(&body.request_id).ok();
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        None
    }
}
