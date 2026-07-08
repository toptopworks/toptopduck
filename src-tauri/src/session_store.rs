//! Multi-session addressing store (ADR-0056): the managed Tauri state that
//! replaces the single `Arc<Mutex<Session>>`. A [`SessionStore`] holds a
//! `Map<SessionId, Arc<SessionHandle>>`; every session-scoped command looks up
//! its target by `session_id` (the new first parameter), clones the
//! `Arc<SessionHandle>`, and runs against it.
//!
//! ## Concurrency model (ADR-0056 Decision 3)
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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::cancel::CancelToken;
use crate::provider::Provider;
use crate::session::Session;

/// IPC error string for a session-scoped command addressing an unknown /
/// already-closed session. Surfaced verbatim to the frontend (which treats
/// every session-scoped reject as a plain error string).
pub const UNKNOWN_SESSION: &str = "会话不存在或已关闭";

/// One live session's shared handle. Cloned out of the store under a read lock
/// so a long turn can run against it WITHOUT holding the store lock
/// (ADR-0056). The `Session` (and its DuckDB connection) lives until the last
/// `Arc<SessionHandle>` is released -- `close_session` removes the store's
/// entry, but an in-flight ask's clone keeps it alive until the turn finishes
/// (ADR-0055).
pub struct SessionHandle {
    /// The session itself (DuckDB connection, working set, thread, recipe
    /// binding) behind its own `Mutex` -- the per-session single-flight gate
    /// (ADR-0021). Distinct from the store lock: held for a whole turn, never
    /// blocks another session's store lookup.
    pub session: Arc<Mutex<Session>>,
    /// The per-session cancel + in-flight signal (ADR-0021). Shared with the
    /// `Session` (cloned into it at construction); `close_session` and the
    /// `cancel` command fire it through this clone without the session lock.
    pub cancel: Arc<CancelToken>,
    /// ADR-0055 closing flag: set by `close_session`, read by `Session::ask`'s
    /// post-turn check (via the clone attached to the `Session`) to discard an
    /// in-flight turn that finished after close fired cancel.
    pub closing: Arc<AtomicBool>,
    /// ADR-0053 resume guard, made per-session in the multi-session store.
    /// While `open_duck` rebuilds THIS session's contents, mutating commands
    /// targeting it reject rather than silently operating on the stale
    /// pre-resume session whose work `*s = new_session` would overwrite.
    /// Interior-mutable so it toggles through `&Arc<SessionHandle>`.
    resuming: AtomicBool,
}

impl SessionHandle {
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
}

/// The multi-session map (ADR-0056). Managed once as Tauri state; every
/// session-scoped command looks up its target here by `session_id`.
pub struct SessionStore {
    sessions: RwLock<HashMap<String, Arc<SessionHandle>>>,
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
    /// no "id issued, resource unbuilt" window (ADR-0056 Why 2). The cancel
    /// token is supplied by the caller (the command layer) so a test with a
    /// blocking `FakeProvider` can share the token with the provider before
    /// the session exists; the real `create_session` command allocates a fresh
    /// one. The closing flag is allocated here and attached to the `Session`
    /// so `close_session` (via the handle) and `ask` (via the session field)
    /// read the same `Arc<AtomicBool>`.
    pub fn create(
        &self,
        cancel: Arc<CancelToken>,
        provider: Box<dyn Provider>,
    ) -> Result<String, String> {
        let closing = Arc::new(AtomicBool::new(false));
        let mut session = Session::with_provider_and_cancel(provider, Arc::clone(&cancel))
            .map_err(|e| e.to_string())?;
        session.set_closing_flag(Arc::clone(&closing));
        let handle = Arc::new(SessionHandle {
            session: Arc::new(Mutex::new(session)),
            cancel,
            closing,
            resuming: AtomicBool::new(false),
        });
        // Generate the id only after the resource exists; insert under the
        // write lock; return the id only after the insert lands.
        let id = uuid::Uuid::new_v4().to_string();
        let mut map = self.sessions.write().map_err(|e| e.to_string())?;
        map.insert(id.clone(), handle);
        Ok(id)
    }

    /// Look up a session handle under a read lock and return a cloned
    /// `Arc<SessionHandle>` (the lock is released immediately). The caller runs
    /// any long turn against the clone without holding the store lock
    /// (ADR-0056 concurrency). Errors for an unknown / closed session.
    pub fn get(&self, session_id: &str) -> Result<Arc<SessionHandle>, String> {
        let map = self.sessions.read().map_err(|e| e.to_string())?;
        map.get(session_id)
            .cloned()
            .ok_or_else(|| UNKNOWN_SESSION.to_string())
    }

    /// Close a session (ADR-0055): mark closing, fire cancel, and remove the
    /// entry from the map. Returns immediately -- it does NOT wait for an
    /// in-flight ask. Closing is set BEFORE the cancel fires and BEFORE the
    /// map removal so every observable ordering is safe: an in-flight ask that
    /// sees cancel (set after closing) is guaranteed to see closing at its
    /// post-turn check and discard; a turn that finishes in the narrow window
    /// before removal is discarded too (closing already set). New commands
    /// after removal reject as unknown. The `Session` (DuckDB + canonical
    /// writer key) drops when the last `Arc` is released -- immediately if no
    /// ask is in flight, or when the in-flight ask's clone drops after its
    /// post-check discard.
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        // Read-lock the handle (still in the map) so closing/cancel reach the
        // in-flight ask before the entry is removed.
        let handle = self.get(session_id)?;
        handle.closing.store(true, Ordering::SeqCst);
        handle.cancel.request();
        // Remove so subsequent lookups reject. Idempotent: a concurrent close
        // that already removed it leaves nothing to remove (harmless).
        let mut map = self.sessions.write().map_err(|e| e.to_string())?;
        map.remove(session_id);
        Ok(())
    }
}
