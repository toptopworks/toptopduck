//! Multi-session addressing store (ADR-0056): the managed Tauri state that
//! replaces the single `Arc<Mutex<Session>>`. A [`SessionStore`] holds a
//! `Map<SessionId, Arc<SessionHandle>>`; every session-scoped command looks up
//! its target by `session_id` (the new first parameter), clones the
//! `Arc<SessionHandle>`, and runs against it.
//!
//! ## Concurrency model (ADR-0056)
//!
//! The store lock is held ONLY for the brief map lookup / insert / remove -- a
//! long turn (`ask`, `read_rows`) clones the `Arc<SessionHandle>` and releases
//! the store lock before the turn runs. This is why `close_session` (write
//! lock) is never blocked by an in-flight `ask`: the ask holds only its own
//! `Arc<SessionHandle>` clone + the per-session `Mutex<Session>` (ADR-0021
//! single-flight, per session), NOT the store lock. Session-to-session turns
//! do not contend (distinct DuckDB instances, ADR-0027 physical isolation).
//!
//! ## Tear-down via reference counting (ADR-0055)
//!
//! `close_session` removes the entry from the map + marks closing + fires
//! cancel, then returns immediately (it does NOT wait for an in-flight ask).
//! An in-flight ask keeps the `Session` (and its DuckDB connection) alive via
//! its own `Arc` clone until the turn finishes; its post-turn check sees
//! `closing` and discards the outcome (ADR-0055 -- no thread append, no recipe
//! persist). When the last `Arc` drops, the `Session` drops: DuckDB memory is
//! freed and the bound `.duck` canonical-writer key is released.
//!
//! ## Type-enforced invariants (issue #73)
//!
//! Previously several ADR-0055/0056 invariants lived at the doc/convention
//! layer only; this module sinks them into the type system so illegal states
//! are unrepresentable:
//!
//! - [`SessionId`] is a newtype: the command boundary parses `&str -> SessionId`
//!   once, and a malformed id surfaces as [`SessionError::InvalidId`] rather
//!   than collapsing into "unknown session".
//! - [`SessionHandle`] fields are private and reached only through accessors;
//!   [`ClosingFlag`] exposes `set` (store true) but NO unset, so a holder of a
//!   cloned flag cannot revoke a close (ADR-0055 once-closing).
//! - [`SessionError`] distinguishes `InvalidId` / `NotFound` / `Resuming` /
//!   `InFlight` / `Engine` instead of merging them into one `Err(String)`.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::cancel::CancelToken;
use crate::provider::Provider;
use crate::session::Session;

/// IPC error string carried by [`SessionError::NotFound`] -- the wording the
/// frontend has always rendered for an unknown / closed session. Kept as a
/// named constant so the Display string and the tests reference one symbol;
/// `SessionError::NotFound.to_string()` is asserted to equal this.
pub const UNKNOWN_SESSION: &str = "会话不存在或已关闭";

/// Backend-generated session id (ADR-0056). A newtype over UUID v4
/// so a session-scoped command cannot accept an arbitrary string: the command
/// boundary parses `&str -> SessionId` once (a malformed id fails as
/// [`SessionError::InvalidId`], NOT collapsed into "unknown session"), and the
/// store deals only in the typed id. Only [`SessionStore::create`] mints ids;
/// every other site receives one already typed.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SessionId(uuid::Uuid);

impl SessionId {
    /// Parse a wire string into a typed id. A malformed id, OR a well-formed
    /// UUID of a non-v4 version, is [`SessionError::InvalidId`] -- distinct
    /// from a well-formed v4 id that no longer resolves
    /// ([`SessionError::NotFound`]). The two used to both collapse into
    /// [`UNKNOWN_SESSION`], so a typo read identically to a stale id from a
    /// closed session. Only v4 is accepted because that is the only version
    /// [`SessionStore::create`] mints; a non-v4 id was never a real session id.
    pub fn parse(s: &str) -> Result<Self, SessionError> {
        let id = uuid::Uuid::parse_str(s).map_err(|_| SessionError::InvalidId)?;
        if id.get_version() != Some(uuid::Version::Random) {
            return Err(SessionError::InvalidId);
        }
        Ok(Self(id))
    }

    /// Mint a fresh v4 id. Store-internal: only [`SessionStore::create`] mints
    /// ids, keeping the id <-> resource binding atomic (the id is issued only
    /// after the DuckDB instance exists and the insert lands; see ADR-0056).
    fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl fmt::Display for SessionId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// Typed session-scoped command errors (issue #73; typed IPC boundary,
/// issue #119). Replaces the bare `Err(String)` the store and reject guards
/// used to return: the distinct failure modes (malformed id, unknown session,
/// resuming, in-flight, engine) were merged into one string, so the frontend
/// could not programmatically tell a typo from a resume-in-progress. The enum
/// keeps the distinction typed, and the session-scoped commands return it
/// across IPC as a serde-structured value -- `#[serde(tag = "kind", content =
/// "data")]`, the same adjacently-tagged shape the rest of the wire contract
/// uses -- so the frontend narrows on `kind` and renders a locale message
/// (the Chinese wording no longer crosses IPC). The thiserror `#[error(...)]`
/// attributes remain for Rust-side `Display` / logging only; they are NOT the
/// IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum SessionError {
    /// The session id was not a valid UUID. Distinct from
    /// [`Self::NotFound`] so a malformed id (typo, truncation, a value that was
    /// never an id) is not confused with a well-formed id whose session closed.
    #[error("会话 id 格式错误")]
    InvalidId,
    /// The id was well-formed but no session is bound to it (closed or never
    /// created). Carries the canonical [`UNKNOWN_SESSION`] wording.
    #[error("会话不存在或已关闭")]
    NotFound,
    /// A mutating command targeted a session that is currently resuming
    /// (ADR-0053, made per-session by ADR-0056).
    #[error("正在恢复会话，请稍候再操作")]
    Resuming,
    /// A second turn was attempted on a session with one already in flight
    /// (ADR-0021 single-flight, per session via ADR-0056).
    #[error("该会话有查询进行中，请先取消或等待完成")]
    InFlight,
    /// A resume failed (issue #120): the `open_duck` command wraps
    /// [`Session::open_duck`](crate::session::Session::open_duck)'s typed
    /// [`ResumeError`](crate::session::ResumeError) here instead of flattening
    /// it to [`Self::Engine`] (string), so the frontend recurses
    /// `Resume.data.kind` and renders the resume-domain locale message. The
    /// addressing failures (invalid id / unknown session / resuming) stay
    /// typed as the variants above; only the resume-domain failure rides this
    /// variant.
    #[error("{0}")]
    Resume(crate::session::ResumeError),
    /// A source removal was refused (issue #121): `remove_source` /
    /// `remove_active_source` wrap the typed
    /// [`RemoveSourceError`](crate::model::RemoveSourceError) here instead of
    /// flattening it to [`Self::Engine`] (string), so the frontend recurses
    /// `RemoveSource.data.kind` and renders the source-domain locale message.
    #[error("{0}")]
    RemoveSource(crate::model::RemoveSourceError),
    /// A dataset display-label rename was refused (issue #121): `rename_dataset`
    /// wraps the typed [`RenameError`](crate::model::RenameError) here.
    #[error("{0}")]
    RenameDataset(crate::model::RenameError),
    /// A session rename was refused (issue #121): `rename_session` wraps the
    /// typed [`RenameSessionError`](crate::session::RenameSessionError) here.
    #[error("{0}")]
    RenameSession(crate::session::RenameSessionError),
    /// A row read failed (issue #121): `read_rows` wraps the typed
    /// [`TurnError`](crate::model::TurnError) here.
    #[error("{0}")]
    Turn(crate::model::TurnError),
    /// An engine / internal failure (mutex poison, join error, etc.) -- the
    /// catch-all for failures that are not one of the addressing / guard
    /// states above. Carries the underlying detail string.
    #[error("{0}")]
    Engine(String),
}

/// ADR-0055 monotonic closing flag: once `close_session` marks a
/// session closing, it stays closing. The type exposes [`Self::set`] (store
/// true) and [`Self::get`] (load) only -- there is deliberately NO unset path,
/// so a holder of a cloned flag cannot revoke a close (the prior
/// `pub Arc<AtomicBool>` let any command clone the Arc and `store(false)`).
/// Shared across the [`SessionHandle`] and the [`Session`] (attached via
/// [`Session::set_closing_flag`](crate::session::Session::set_closing_flag)) so
/// `close_session` and `ask`'s post-turn check read one flag.
#[derive(Debug, Clone)]
pub struct ClosingFlag(Arc<AtomicBool>);

impl ClosingFlag {
    /// Allocate a fresh false flag. The store allocates one per session and
    /// attaches it to both the handle and the `Session`.
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    /// Set the flag. Monotonic -- no unset exists, by design. A second `set`
    /// is a harmless no-op (already true).
    pub fn set(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Whether the flag has been set. Read by `ask`'s post-turn check to
    /// discard an in-flight turn that finished after close fired cancel.
    pub fn get(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

impl Default for ClosingFlag {
    fn default() -> Self {
        Self::new()
    }
}

/// One live session's shared handle. Cloned out of the store under a read lock
/// so a long turn can run against it WITHOUT holding the store lock
/// (ADR-0056). The `Session` (and its DuckDB connection) lives until the last
/// `Arc<SessionHandle>` is released -- `close_session` removes the store's
/// entry, but an in-flight ask's clone keeps it alive until the turn finishes
/// (ADR-0055).
///
/// All four fields are private and reached only through accessors:
/// the `closing` flag is monotonic via [`ClosingFlag`] (no unset), the cancel
/// token and session mutex never escape as raw `Arc`s, and the resume flag
/// toggles through `&self`. A command that needs the session off-thread clones
/// the `Arc<SessionHandle>` (not the inner Arc) and locks inside the spawned
/// task -- the lock guard borrows the moved handle, so no internal handle field
/// can leak out and bypass a future `close`.
pub struct SessionHandle {
    /// The session itself (DuckDB connection, working set, thread, recipe
    /// binding) behind its own `Mutex` -- the per-session single-flight gate
    /// (ADR-0021). Distinct from the store lock: held for a whole turn, never
    /// blocks another session's store lookup. Reached via [`Self::session_lock`].
    session: Arc<Mutex<Session>>,
    /// The per-session cancel + in-flight signal (ADR-0021). Shared with the
    /// `Session` (cloned into it at construction); `close_session` and the
    /// `cancel` command fire it through [`Self::fire_cancel`] without the
    /// session lock. [`Self::cancel_token`] is the only escape hatch, used by
    /// `open_duck` to attach the SAME token to the resumed session.
    cancel: Arc<CancelToken>,
    /// ADR-0055 closing flag, monotonic via [`ClosingFlag`]. Set by
    /// [`Self::mark_closing`], read by [`Self::is_closing`] (and by the
    /// `Session`'s post-turn check via the clone attached at construction).
    closing: ClosingFlag,
    /// ADR-0053 resume guard, made per-session in the multi-session store.
    /// While `open_duck` rebuilds THIS session's contents, mutating commands
    /// targeting it reject rather than silently operating on the stale
    /// pre-resume session whose work `*s = new_session` would overwrite.
    /// Interior-mutable so it toggles through `&Arc<SessionHandle>`.
    resuming: AtomicBool,
    /// ADR-0063: the receiver half of the close-and-wait-release drop signal.
    /// The matching sender lives on the `Session`; its `Drop` fires it after
    /// releasing the canonical key. The wait variant takes this out (consumed
    /// once per close-wait) via [`Self::take_drop_signal`] before dropping its
    /// handle clone, then blocks on `recv_timeout` until `Session::Drop` fires.
    /// `Mutex` wraps the `!Sync` `mpsc::Receiver` so the handle stays `Sync`
    /// (it lives behind an `Arc`).
    drop_signal: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl SessionHandle {
    /// Lock the session mutex (the per-session single-flight gate, ADR-0021).
    /// The guard borrows this handle; for a `spawn_blocking` task, clone the
    /// `Arc<SessionHandle>` and move the clone into the task, then lock inside
    /// -- the guard is `!Send` and must not cross the await/blocking boundary.
    /// A poisoned mutex (a thread panicked while holding it) surfaces as
    /// [`SessionError::Engine`]; the session is otherwise unreachable.
    pub fn session_lock(&self) -> Result<std::sync::MutexGuard<'_, Session>, SessionError> {
        self.session
            .lock()
            .map_err(|_| SessionError::Engine("session lock poisoned".into()))
    }

    /// Fire cancel on this session's token (ADR-0021). Sets the cooperative
    /// flag and interrupts any running DuckDB query; the in-flight turn lands
    /// as `Cancelled` at its next check. Used by the `cancel` command and
    /// `close_session`. Safe when no turn is in flight (no-op besides the
    /// flag, which the next `ask` resets).
    pub fn fire_cancel(&self) {
        self.cancel.request();
    }

    /// Whether a turn is currently in flight on this session (ADR-0021
    /// single-flight, read off the shared token without the session lock).
    pub fn is_in_flight(&self) -> bool {
        self.cancel.is_in_flight()
    }

    /// Clone of the cancel token -- the only escape hatch for the inner `Arc`,
    /// used by `open_duck` to attach the SAME token to the resumed session so a
    /// `cancel` / `close_session` after resume still reaches it.
    pub fn cancel_token(&self) -> Arc<CancelToken> {
        Arc::clone(&self.cancel)
    }

    /// Mark this session closing (ADR-0055). Monotonic: there is deliberately
    /// NO unset -- once close fires, the session stays closing so every
    /// in-flight turn's post-turn check discards. Type-enforced via
    /// [`ClosingFlag`]; a cloned flag cannot revoke this either.
    pub fn mark_closing(&self) {
        self.closing.set();
    }

    /// Whether `close_session` has marked this session closing (ADR-0055).
    pub fn is_closing(&self) -> bool {
        self.closing.get()
    }

    /// Clone of the closing flag -- `open_duck` re-attaches the SAME flag to
    /// the resumed session so a `close_session` after resume still discards
    /// in-flight turns. Monotonic: the clone exposes `set` / `get` only.
    pub fn closing_flag(&self) -> ClosingFlag {
        self.closing.clone()
    }

    /// Whether `open_duck` is currently rebuilding this session (ADR-0053).
    /// Mutating commands read this to reject during resume.
    pub fn is_resuming(&self) -> bool {
        self.resuming.load(Ordering::SeqCst)
    }

    /// Toggle the resume flag. Set by the `open_duck` command before resume
    /// starts and cleared when it ends (success or error).
    pub fn set_resuming(&self, value: bool) {
        self.resuming.store(value, Ordering::SeqCst);
    }

    /// ADR-0063: take the drop-signal receiver out of the handle (consumed
    /// once per close-and-wait-release). Returns `Ok(None)` if already taken
    /// (a second close-wait on the same id -- the frontend calls once, so this
    /// is a defensive guard), `Err` if the lock is poisoned.
    pub fn take_drop_signal(&self) -> Result<Option<std::sync::mpsc::Receiver<()>>, SessionError> {
        self.drop_signal
            .lock()
            .map(|mut g| g.take())
            .map_err(|_| SessionError::Engine("drop signal lock poisoned".into()))
    }

    /// ADR-0063: install a fresh drop-signal receiver. Used by `open_duck` to
    /// re-arm the signal on resume (the new session gets the matching sender via
    /// [`crate::session::Session::set_drop_signal`]). See
    /// [`SessionStore::create`] for the pair's initial construction.
    pub fn set_drop_signal_rx(&self, rx: std::sync::mpsc::Receiver<()>) {
        if let Ok(mut g) = self.drop_signal.lock() {
            *g = Some(rx);
        }
        // A poisoned lock means a thread panicked while holding it; the rx
        // is dropped here and the slot keeps its pre-call value (Some or
        // None). A later close-wait surfaces the poison via take_drop_signal's
        // Engine error rather than panicking here (Drop-adjacent code must
        // not panic).
    }
}

/// The multi-session map (ADR-0056). Managed once as Tauri state; every
/// session-scoped command parses its `session_id` wire string into a
/// [`SessionId`] and looks up its target here.
pub struct SessionStore {
    sessions: RwLock<HashMap<SessionId, Arc<SessionHandle>>>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Build a fresh session, bind it to a backend-generated id (UUID v4), and
    /// insert it. The id is generated AFTER the DuckDB instance exists and the
    /// insert completes, so the id <-> resource binding is atomic -- there is
    /// no "id issued, resource unbuilt" window (see ADR-0056). The cancel
    /// token is supplied by the caller (the command layer) so a test with a
    /// blocking `FakeProvider` can share the token with the provider before
    /// the session exists; the real `create_session` command allocates a fresh
    /// one. The closing flag is allocated here and attached to the `Session`
    /// so `close_session` (via the handle) and `ask` (via the session field)
    /// read the same flag.
    pub fn create(
        &self,
        cancel: Arc<CancelToken>,
        provider: Box<dyn Provider>,
    ) -> Result<SessionId, SessionError> {
        let closing = ClosingFlag::new();
        let mut session = Session::with_provider_and_cancel(provider, Arc::clone(&cancel))
            .map_err(|e| SessionError::Engine(e.to_string()))?;
        session.set_closing_flag(closing.clone());
        // ADR-0063: allocate the close-and-wait-release drop signal pair. The
        // sender travels into the Session (fired from its Drop); the receiver
        // stays on the handle for the wait variant to take.
        let (drop_tx, drop_rx) = std::sync::mpsc::channel();
        session.set_drop_signal(drop_tx);
        let handle = Arc::new(SessionHandle {
            session: Arc::new(Mutex::new(session)),
            cancel,
            closing,
            resuming: AtomicBool::new(false),
            drop_signal: Mutex::new(Some(drop_rx)),
        });
        // Generate the id only after the resource exists; insert under the
        // write lock; return the id only after the insert lands.
        let id = SessionId::new();
        let mut map = self
            .sessions
            .write()
            .map_err(|_| SessionError::Engine("session store lock poisoned".into()))?;
        map.insert(id.clone(), handle);
        Ok(id)
    }

    /// Look up a session handle under a read lock and return a cloned
    /// `Arc<SessionHandle>` (the lock is released immediately). The caller runs
    /// any long turn against the clone without holding the store lock
    /// (ADR-0056 concurrency). Errors with [`SessionError::NotFound`] for an
    /// unknown / closed session (a malformed id is caught earlier by
    /// [`SessionId::parse`] and surfaces as [`SessionError::InvalidId`]).
    ///
    /// # ADR-0056 brief-lock invariant
    ///
    /// The returned `Arc<SessionHandle>` must NOT be held across Tauri turns:
    /// a single command clones it, uses it within that one invocation, and
    /// drops it before returning. Holding it longer would violate "the store
    /// lock is held only for lookup / insert / remove" (see ADR-0056) --
    /// a stale Arc bypasses the map and could race a `close` + `create` that
    /// recycles state. The handle's fields are private and reached only through
    /// accessors, so no internal field can escape; an offending cross-turn hold
    /// is limited to the Arc itself and is reviewable at the call site.
    pub fn get(&self, session_id: &SessionId) -> Result<Arc<SessionHandle>, SessionError> {
        let map = self
            .sessions
            .read()
            .map_err(|_| SessionError::Engine("session store lock poisoned".into()))?;
        map.get(session_id).cloned().ok_or(SessionError::NotFound)
    }

    /// Mark a session closing, fire cancel, and detach it from the map. Shared
    /// core of [`Self::close`] (ADR-0055 fire-and-forget) and the
    /// close-and-wait-release variant (ADR-0063, delete path). Closing is set
    /// BEFORE the cancel fires and BEFORE the map removal so every observable
    /// ordering is safe (an in-flight ask that sees cancel is guaranteed to see
    /// closing at its post-turn check and discard). Returns the detached handle
    /// so the wait variant can observe its Drop; the handle's `Arc` refcount
    /// determines when `Session::Drop` (canonical key release) fires --
    /// immediately if no ask is in flight, or when the in-flight ask's clone
    /// drops after its post-check discard.
    pub fn detach(&self, session_id: &SessionId) -> Result<Arc<SessionHandle>, SessionError> {
        // Read-lock the handle (still in the map) so closing/cancel reach the
        // in-flight ask before the entry is removed.
        let handle = self.get(session_id)?;
        handle.mark_closing();
        handle.fire_cancel();
        // Remove so subsequent lookups reject. `HashMap::remove` itself is
        // idempotent, but close/detach as a whole is NOT idempotent on a
        // missing id: the `get` above returns NotFound before this line runs,
        // so a second close of an already-closed id surfaces to the caller as
        // NotFound (the frontend treats any close error on a tab it is
        // discarding as success). The return of `remove` is intentionally
        // ignored -- in the narrow race where two concurrent closes both pass
        // `get` before either removes, the loser's `remove` yields None but
        // both still succeed (preserving the original `close` semantics; the
        // wait variant's `take_drop_signal` is the single-waiter guard).
        let mut map = self
            .sessions
            .write()
            .map_err(|_| SessionError::Engine("session store lock poisoned".into()))?;
        map.remove(session_id);
        Ok(handle)
    }

    /// Close a session (ADR-0055): mark closing, fire cancel, and remove the
    /// entry from the map. Returns immediately -- it does NOT wait for an
    /// in-flight ask. Delegates to [`Self::detach`] and drops the returned
    /// handle (the pure-close variant does not observe `Session::Drop`).
    pub fn close(&self, session_id: &SessionId) -> Result<(), SessionError> {
        self.detach(session_id)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A valid wire id round-trips through parse -> typed id -> Display, and a
    /// fresh store-minted id parses back to itself (the wire form is stable).
    #[test]
    fn session_id_parse_round_trips_a_valid_uuid() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("create session");
        let wire = id.to_string();
        let parsed = SessionId::parse(&wire).expect("valid id parses");
        assert_eq!(parsed, id, "parsed id equals the minted id");
        assert_eq!(parsed.to_string(), wire, "Display is the wire form");
    }

    /// A malformed id is `InvalidId`, distinct from `NotFound` (review H1).
    /// Previously both collapsed into the single UNKNOWN_SESSION string.
    #[test]
    fn malformed_id_is_invalid_not_not_found() {
        let err = SessionId::parse("not-a-uuid").expect_err("malformed id rejects");
        assert_eq!(err, SessionError::InvalidId);
        // A well-formed but absent id is NotFound, not InvalidId.
        let parsed = SessionId::parse("550e8400-e29b-41d4-a716-446655440000")
            .expect("well-formed id parses");
        let store = SessionStore::new();
        // `.err()` (not `unwrap_err`) so the assertion does not require
        // SessionHandle: Debug (the Ok arm is discarded without formatting).
        let err2 = store.get(&parsed).err().expect("absent session rejects");
        assert_eq!(err2, SessionError::NotFound);
    }

    /// A non-v4 UUID (nil, v1, v3, v5) is InvalidId, not silently accepted:
    /// the store only mints v4, so a well-formed non-v4 id was never a real
    /// session id. A well-formed v4 that is simply absent is NotFound (covered
    /// by `malformed_id_is_invalid_not_not_found` above). All four non-v4
    /// shapes are pinned: nil yields version `None`, v1 / v3 / v5 yield
    /// `Some(V1/V3/V5)` -- the nil case alone cannot prove the version-
    /// comparison branch fires.
    #[test]
    fn non_v4_uuid_is_invalid_even_if_well_formed() {
        // Nil (version None) and v1 / v3 / v5 (version Some(!=Random)): each is
        // a well-formed UUID but none is v4, so all reject as InvalidId. The
        // nil case exercises the None-branch of the version check; v1 / v3 /
        // v5 exercise the Some(!=Random)-branch.
        for wire in [
            "00000000-0000-0000-0000-000000000000", // nil -- version None
            "a0eebc99-9c0b-1ef8-bb6d-6249ebb38000", // v1
            "a0eebc99-9c0b-3ef8-bb6d-6249ebb38000", // v3
            "a0eebc99-9c0b-5ef8-bb6d-6249ebb38000", // v5
        ] {
            let err = SessionId::parse(wire).expect_err("non-v4 id should reject");
            assert_eq!(err, SessionError::InvalidId, "must be InvalidId: {wire}");
        }
    }

    /// `NotFound` carries the canonical wording the frontend has always
    /// rendered (UNKNOWN_SESSION), so the IPC contract is unchanged.
    #[test]
    fn not_found_display_matches_unknown_session_constant() {
        assert_eq!(SessionError::NotFound.to_string(), UNKNOWN_SESSION);
    }

    /// The five session-error variants carry distinct `kind` tags over IPC
    /// (issue #119): the frontend narrows on `kind` to pick a locale message,
    /// so two variants must never share a tag. Verified via the serde shape --
    /// `#[serde(tag = "kind", content = "data")]` -- rather than the Display
    /// string (Display is now Rust-log-only, not the IPC contract). `Engine`
    /// additionally carries its detail under `data`.
    #[test]
    fn session_error_variants_have_distinct_kinds() {
        let variants = [
            serde_json::to_value(SessionError::InvalidId).unwrap(),
            serde_json::to_value(SessionError::NotFound).unwrap(),
            serde_json::to_value(SessionError::Resuming).unwrap(),
            serde_json::to_value(SessionError::InFlight).unwrap(),
            serde_json::to_value(SessionError::Engine("boom".into())).unwrap(),
        ];
        let kinds: Vec<&str> = variants
            .iter()
            .map(|v| v["kind"].as_str().expect("kind tag present"))
            .collect();
        let unique: std::collections::HashSet<&str> = kinds.iter().copied().collect();
        assert_eq!(unique.len(), variants.len(), "all variant kinds differ");
        // Engine carries its detail string under `data` (the only variant with
        // content); the four guard variants serialize to a bare `kind`.
        let engine = &variants[4];
        assert_eq!(engine["kind"], "Engine");
        assert_eq!(engine["data"], "boom");
        assert!(
            variants[0]["data"].is_null(),
            "InvalidId carries no data (bare kind)"
        );
    }

    /// `ClosingFlag` is monotonic: `set` flips false -> true, and a
    /// second `set` stays true. There is no unset method on the type -- the
    /// non-existence is the invariant (a future `unset` would have to be added
    /// deliberately, and a code review would flag it).
    #[test]
    fn closing_flag_set_is_monotonic() {
        let flag = ClosingFlag::new();
        assert!(!flag.get(), "fresh flag is false");
        flag.set();
        assert!(flag.get(), "set flips to true");
        flag.set();
        assert!(flag.get(), "second set stays true");
    }

    /// A cloned `ClosingFlag` shares the underlying state: `set` on one is
    /// visible on the other (the handle and the Session read one flag). The
    /// clone also has no unset path.
    #[test]
    fn closing_flag_clone_shares_state() {
        let a = ClosingFlag::new();
        let b = a.clone();
        a.set();
        assert!(b.get(), "set on the original is visible on the clone");
    }

    /// `SessionHandle::mark_closing` is observable through `is_closing` and
    /// monotonic: the prior `pub Arc<AtomicBool>` path that let a
    /// caller `store(false)` no longer exists.
    #[test]
    fn handle_mark_closing_is_observable_and_monotonic() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        assert!(!handle.is_closing(), "fresh handle is not closing");
        handle.mark_closing();
        assert!(handle.is_closing(), "mark_closing sets the flag");
        // A second mark is a harmless no-op (already closing).
        handle.mark_closing();
        assert!(handle.is_closing());
    }
}
