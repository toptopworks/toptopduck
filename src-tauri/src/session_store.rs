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
use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use crate::approval::SharedApprovalState;
use crate::cancel::CancelToken;
use crate::mcp::aggregator::ConnectResult;
use crate::mcp::config::McpServerId;
use crate::provider::Provider;
use crate::runtime::acp::adapter::AdapterSpec;
use crate::session::{PosturePair, Session};

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
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize)]
#[serde(transparent)]
pub struct SessionId(uuid::Uuid);

impl<'de> serde::Deserialize<'de> for SessionId {
    /// Deserialize delegates to [`SessionId::parse`] so the v4-only invariant
    /// is enforced on both construction paths (parse + serde). A derived
    /// Deserialize would accept any well-formed UUID regardless of version.
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        SessionId::parse(&s).map_err(serde::de::Error::custom)
    }
}

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
    /// [`RowReadError`](crate::model::RowReadError) here.
    #[error("{0}")]
    #[serde(rename = "Turn")]
    RowRead(crate::model::RowReadError),
    /// A skill mount / unmount was refused (issue #363, ADR-0086):
    /// `mount_skill` / `unmount_skill` wrap the typed
    /// [`SkillMountError`](crate::session::skills::SkillMountError) here instead
    /// of flattening it to [`Self::Engine`] (string), so the frontend recurses
    /// `SkillMount.data.kind` and renders the skill-domain locale message.
    #[error("{0}")]
    SkillMount(crate::session::skills::SkillMountError),
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

/// The handle-held runtime choice + posture pair as ONE value behind ONE
/// mutex (issue #600): the pair is namespaced by the runtime it was selected
/// under, and the two move together at every switch -- a reader taking the
/// lock sees one segment's (runtime, pair), never a mix of two segments (a
/// mix would stamp one runtime's segment header over the other's posture and
/// inject a foreign-namespace id on resume).
#[derive(Default)]
struct RuntimePosture {
    runtime: Option<AdapterSpec>,
    posture: PosturePair,
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
    /// ADR-0080 (issue #294): per-session tiered-approval state -- the
    /// authorization mode, the "always allow" trust set, and the in-flight
    /// approval slot. Lives on the handle (NOT inside the `Session` mutex) so
    /// `respond_tool_approval` reaches it while a waiting turn holds the
    /// session lock. Allocated once at [`SessionStore::create`]; reset on
    /// resume via [`Self::reset_approval`].
    approval: SharedApprovalState,
    /// Issue #301 slice D: the per-session enabled-server set (server
    /// granularity, AC#3). A whitelist -- only servers whose id is in this set
    /// are connected at turn top. Default-empty (ADR-0080 lineage: a freshly
    /// created session enables nothing until the user explicitly toggles a
    /// server on, mirroring how trust starts empty + the user explicitly
    /// grants "always allow"); reset on resume via
    /// [`Self::reset_mcp_enablement`].
    enabled_mcp: Mutex<HashSet<McpServerId>>,
    /// Issue #301 slice D: the cached per-server connect outcomes from the
    /// last turn's `connect_all`. Snapshotted from the Session after each turn
    /// (`Session::last_mcp_connect`) so `list_mcp_server_status` reads the
    /// last turn's outcome without taking the session lock an in-flight turn
    /// holds. Empty until the first turn + reset on resume alongside the
    /// enablement set (the Session is fresh, no connect has run yet).
    last_mcp_connect: Mutex<Vec<ConnectResult>>,
    /// The next segment's runtime choice + model posture pair, ONE mutex
    /// slot (issue #600) -- the runtime selector (issue #353,
    /// ADR-0076/0081/0083: `None` drives the built-in BYOK agent loop, the
    /// default; `Some(spec)` drives the external ACP engine for the one CLI)
    /// and the ADR-0095 model + thought-level pair (the named [`PosturePair`],
    /// one slot since issue #530) that the external runtime consumes under
    /// that runtime's namespace. Folding the two former slots into one lock
    /// makes the combined read ([`Self::runtime_and_posture`]) and the
    /// switch's combined write ([`Self::set_runtime_and_posture`]) atomic,
    /// so no interleaving can pair one runtime with the other runtime's
    /// posture. Lives on the handle (NOT inside the `Session` mutex) so the
    /// composer picker's get/set are lock-light -- a write never blocks on an
    /// in-flight turn; `ask` mirrors both into the Session at turn top, so a
    /// switch takes effect exactly at the turn boundary. The pair is
    /// PERSISTED to the recipe and restored on resume via open_duck's
    /// restore call; the runtime choice is restored from the recipe-header
    /// `last_runtime` (ADR-0102 Decision 1, issue #589 -- segment
    /// continuation; the runtime is execution-plane session state, so unlike
    /// the approval / MCP posture it survives a resume as the session's own
    /// last runtime).
    runtime_posture: Mutex<RuntimePosture>,
    /// ADR-0095: the cached discovered model / thought-level catalog from the
    /// last ACP turn. Lets the frontend render the selector immediately on
    /// session open / resume cold-start (before any turn re-discovers). None
    /// until the first ACP turn; persisted alongside the two selections.
    cached_discovered: Mutex<Option<crate::runtime::acp::adapter::DiscoveredRuntime>>,
    /// Issue #369: a snapshot of the session's mounted-skill names, mirrored
    /// from `Session::mounted_skills()` on mount/unmount (and inside `ask`).
    /// Lets `list_mcp_server_status` resolve skill-declared MCP servers without
    /// taking the session lock an in-flight turn holds -- the same lock-light
    /// pattern as `enabled_mcp` + `last_mcp_connect`. Reset to empty on resume
    /// alongside the MCP enablement set; the first post-resume `ask` repopulates
    /// it from the replayed recipe.
    mounted_skills_snapshot: Mutex<Vec<String>>,
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

    /// Like [`Self::session_lock`] but returns `None` instead of blocking when
    /// the mutex is held or poisoned. Used by `close_and_cleanup_empty` to
    /// avoid blocking on an in-flight ask (ADR-0055 fire-and-forget — the
    /// `ask` command holds the session lock for the entire turn inside
    /// `spawn_blocking`).
    pub fn try_session_lock(&self) -> Option<std::sync::MutexGuard<'_, Session>> {
        self.session.try_lock().ok()
    }

    /// Fire cancel on this session's token (ADR-0021). Sets the cooperative
    /// flag and interrupts any running DuckDB query; the in-flight turn lands
    /// as `Cancelled` at its next check. Used by the `cancel` command and
    /// `close_session`. Safe when no turn is in flight (no-op besides the
    /// flag, which the next `ask` resets).
    ///
    /// Also wakes any in-flight approval gate (ADR-0080, issue #294): a turn
    /// blocked on the approval condvar is not inside DuckDB, so the engine
    /// interrupt alone would not reach it. Without this wake the gate would
    /// rely on its 200ms cancel-poll fallback, delaying the `Cancelled`
    /// outcome; the explicit wake makes cancel immediate.
    pub fn fire_cancel(&self) {
        self.cancel.request();
        self.approval.interrupt_pending();
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

    /// The per-session tiered-approval state (ADR-0080, issue #294). The
    /// approval commands read/mutate this; the future agent loop (#295) and
    /// external-tool bridge (#299) drive tool calls through its gate.
    pub fn approval_state(&self) -> SharedApprovalState {
        Arc::clone(&self.approval)
    }

    /// Reset the approval posture to the default (ADR-0080: resume 归零).
    /// Called by `open_duck` after a successful resume -- the authorization
    /// mode + trust set are session-level and must not survive a resume
    /// (they are not in the recipe / app-config).
    pub fn reset_approval(&self) {
        self.approval.reset();
    }

    // --- MCP server-granularity enablement (issue #301 slice D, AC#3) -------
    //
    // A per-session WHITELIST of connected external MCP servers. Default-empty
    // (a fresh session enables nothing until the user explicitly toggles a
    // server on -- the same ADR-0080 lineage as the tool-level trust set, scaled
    // to server granularity: an explicit user action widens the surface, never
    // a silent default). The status IPC joins app-config (the full server
    // registry) with this set + the last turn's connect cache so the UI shows
    // every configured server, its on/off state, and its last connect outcome
    // + tool count.

    /// The enabled-server ids for this session (issue #301 slice D, AC#3).
    /// `ask` reads this per turn to filter the configured server list down to
    /// the servers the user actually enabled this session.
    pub fn enabled_mcp_servers(&self) -> Vec<McpServerId> {
        self.enabled_mcp
            .lock()
            .expect("enabled_mcp lock poisoned")
            .iter()
            .cloned()
            .collect()
    }

    /// Toggle one server's enabled state for this session (issue #301 slice D,
    /// AC#3). `enabled = true` inserts (idempotent); `enabled = false` removes
    /// (idempotent). The next turn's `connect_all` reflects the change --
    /// per-turn spawn (ADR-0076 Q2) means no live connection to tear down.
    pub fn set_mcp_enabled(&self, id: McpServerId, enabled: bool) {
        let mut guard = self.enabled_mcp.lock().expect("enabled_mcp lock poisoned");
        if enabled {
            guard.insert(id);
        } else {
            guard.remove(&id);
        }
    }

    /// Reset the enabled set + connect cache to the default (issue #301 slice
    /// D, AC#3). Called by `open_duck` after a successful resume alongside
    /// [`Self::reset_approval`] -- the enablement is session-level and must
    /// not survive a resume (it is not in the recipe / app-config, same
    /// reasoning as the approval posture). Issue #369: also clears the
    /// mounted-skills snapshot so `list_mcp_server_status` does not surface
    /// stale skill-declared servers before the first post-resume turn
    /// repopulates it.
    pub fn reset_mcp_enablement(&self) {
        self.enabled_mcp
            .lock()
            .expect("enabled_mcp lock poisoned")
            .clear();
        self.last_mcp_connect
            .lock()
            .expect("last_mcp_connect lock poisoned")
            .clear();
        self.mounted_skills_snapshot
            .lock()
            .expect("mounted_skills_snapshot lock poisoned")
            .clear();
    }

    /// A snapshot of the last turn's per-server connect outcomes (issue #301
    /// slice D). `ask` mirrors the Session's post-turn cache here so
    /// `list_mcp_server_status` is lock-light (it never takes the session
    /// lock, which an in-flight turn holds). Empty until the first turn + after
    /// a resume.
    pub fn last_mcp_connect(&self) -> Vec<ConnectResult> {
        self.last_mcp_connect
            .lock()
            .expect("last_mcp_connect lock poisoned")
            .clone()
    }

    /// Mirror the Session's last-turn connect outcomes into the handle (issue
    /// #301 slice D). Called by `ask` after a turn finishes -- the Session is
    /// still locked at that point, but this write only touches the handle's
    /// own Mutex (no session-lock re-entry).
    pub fn set_last_mcp_connect(&self, results: Vec<ConnectResult>) {
        *self
            .last_mcp_connect
            .lock()
            .expect("last_mcp_connect lock poisoned") = results;
    }

    /// A snapshot of the session's mounted-skill names (issue #369). Mirrored
    /// from `Session::mounted_skills()` on mount/unmount and inside `ask`, so
    /// `list_mcp_server_status` can resolve skill-declared MCP servers without
    /// taking the session lock an in-flight turn holds. Empty until the first
    /// mount and after a resume (the first post-resume `ask` repopulates).
    pub fn mounted_skills_snapshot(&self) -> Vec<String> {
        self.mounted_skills_snapshot
            .lock()
            .expect("mounted_skills_snapshot lock poisoned")
            .clone()
    }

    /// Mirror the session's mounted-skill set into the handle (issue #369).
    /// Called by `mount_skill`/`unmount_skill` (session lock held) and `ask`
    /// (session lock held) so the snapshot stays current. Lock-light: touches
    /// only the handle's own Mutex, no session-lock re-entry.
    pub fn set_mounted_skills_snapshot(&self, names: Vec<String>) {
        *self
            .mounted_skills_snapshot
            .lock()
            .expect("mounted_skills_snapshot lock poisoned") = names;
    }

    // --- Runtime + posture slot (issue #353, ADR-0076/0081/0083) ------------
    //
    // The session's execution-plane posture: the runtime selector (the
    // built-in BYOK agent loop, None the default, or one external ACP CLI
    // adapter, Some) plus the model + thought-level pair the selected
    // external runtime consumes (ADR-0095). ONE mutex slot since issue #600:
    // the two move together at every switch, so no reader can see one
    // runtime paired with the other's posture. The command layer mirrors
    // both into the Session at each turn top, so the switch lands at the
    // turn boundary, never mid-turn.

    /// The runtime selected for the next turn (issue #353). `None` = the
    /// built-in runtime. Lock-light: reads the handle's own slot lock, never
    /// the session lock an in-flight turn holds.
    pub fn runtime_choice(&self) -> Option<AdapterSpec> {
        self.runtime_posture
            .lock()
            .expect("runtime_posture lock poisoned")
            .runtime
            .clone()
    }

    /// Set the runtime for the next turn(s) (issue #353). `None` reverts to
    /// the built-in runtime; `Some(spec)` selects the external ACP engine for
    /// the one CLI. Takes effect at the next turn boundary (`ask` reads this
    /// at turn top); an in-flight turn is untouched. The resume path writes
    /// the restored session runtime here (ADR-0102 Decision 1, issue #589).
    pub fn set_runtime_choice(&self, spec: Option<AdapterSpec>) {
        self.runtime_posture
            .lock()
            .expect("runtime_posture lock poisoned")
            .runtime = spec;
    }

    /// The session-level model + thought-level pair (ADR-0095), read under
    /// the ONE slot lock (issue #530; since issue #600 the same lock also
    /// covers the runtime choice) -- a consumer sees either the old
    /// pair or the new pair, never a torn mix. When the runtime choice is
    /// needed alongside, prefer [`Self::runtime_and_posture`]: it returns
    /// both off the same lock state.
    pub fn external_model_config(&self) -> PosturePair {
        self.runtime_posture
            .lock()
            .expect("runtime_posture lock poisoned")
            .posture
            .clone()
    }

    /// The cached discovered catalog (ADR-0095). Lock-light read.
    pub fn cached_discovered(&self) -> Option<crate::runtime::acp::adapter::DiscoveredRuntime> {
        self.cached_discovered
            .lock()
            .expect("cached_discovered lock poisoned")
            .clone()
    }

    /// Set the model + thought-level pair together (ADR-0095): they are
    /// one assembly posture, written by the same picker surface, so they
    /// share ONE mutex slot -- a torn write between them is not a
    /// representable intermediate state (issue #530). `None` fields clear
    /// (revert to the CLI's own defaults). Lock-light.
    pub fn set_external_model_config(&self, posture: PosturePair) {
        self.runtime_posture
            .lock()
            .expect("runtime_posture lock poisoned")
            .posture = posture;
    }

    /// Read the runtime choice + the posture pair under the ONE slot lock
    /// (issue #600): the pair is namespaced by the runtime it was selected
    /// under, so the two are one unit at every consumer that keys off both --
    /// the `ask` mirror at turn top and the posture set commands (whose
    /// segment-header stamp + backfill entry both derive from this single
    /// read). Atomic against [`Self::set_runtime_and_posture`]: a switch can
    /// never interleave between the two reads, so the caller sees one
    /// segment's (runtime, pair), never a mix.
    pub fn runtime_and_posture(&self) -> (Option<AdapterSpec>, PosturePair) {
        let slot = self
            .runtime_posture
            .lock()
            .expect("runtime_posture lock poisoned");
        (slot.runtime.clone(), slot.posture.clone())
    }

    /// Write the runtime choice + the posture pair under the ONE slot lock
    /// (issue #600) -- the in-session switch's single combined step
    /// (ADR-0102 Decision 3): a reader taking the same lock sees either the
    /// old (runtime, pair) or the switched one in full, never a mix.
    pub fn set_runtime_and_posture(&self, runtime: Option<AdapterSpec>, posture: PosturePair) {
        let mut slot = self
            .runtime_posture
            .lock()
            .expect("runtime_posture lock poisoned");
        slot.runtime = runtime;
        slot.posture = posture;
    }

    /// Conditionally write the posture pair under the ONE slot lock (issue
    /// #600): the write lands only while the slot's runtime still equals
    /// `expected` -- the runtime the caller read the held pair under. The
    /// set commands use this for their handle write-back so a switch landing
    /// between the combined read and the write-back cannot pair the new
    /// runtime with the OLD namespace's pair: the switch has already
    /// re-seeded the slot with the target adapter's posture (#590 segment
    /// semantics), and the stale write is dropped instead of overwriting
    /// it. Returns whether the write landed.
    pub fn set_posture_if_runtime(
        &self,
        expected: &Option<AdapterSpec>,
        posture: PosturePair,
    ) -> bool {
        let mut slot = self
            .runtime_posture
            .lock()
            .expect("runtime_posture lock poisoned");
        if &slot.runtime == expected {
            slot.posture = posture;
            true
        } else {
            false
        }
    }

    /// Snapshot the turn's discovered catalog onto the handle (ADR-0095).
    /// Called by the `ask` command after each ACP turn (the Session recorded
    /// the engine's `LoopOutcome.discovered_runtime`); replaces the cache
    /// unconditionally -- a post-handshake ACP exit always carries a catalog
    /// (an empty one is a real state: the CLI offered no models). Built-in /
    /// CodexEventStream turns and pre-handshake ACP failures yield `None`
    /// ("no discovery", not "discovered nothing") -- the caller skips the
    /// call, preserving the previous ACP cache (issue #530 removed the
    /// unreachable no-op arm from the setter).
    pub fn set_cached_discovered(
        &self,
        discovered: crate::runtime::acp::adapter::DiscoveredRuntime,
    ) {
        *self
            .cached_discovered
            .lock()
            .expect("cached_discovered lock poisoned") = Some(discovered);
    }

    /// Restore the persisted ADR-0095 trio from the resumed recipe
    /// (open_duck). Unlike the reset-to-default lineage (`reset_approval` /
    /// `reset_mcp_enablement`), the model + thought-level pair + the
    /// discovery cache SURVIVE a resume -- ADR-0095 Decision 6: losing the
    /// model selection is an unexpected degradation of the resume promise
    /// (the runtime choice survives the same way since ADR-0102 Decision 2,
    /// restored from the recipe header's `last_runtime`). Called right after
    /// the reset batch so the restored values win. The only writer that
    /// overwrites all three slots in one shot (the user-driven clear --
    /// `set_session_model(None)` / `set_session_thought_level(None)` -- goes
    /// through [`Self::set_external_model_config`] and never touches the
    /// catalog).
    pub fn restore_runtime_model_config(
        &self,
        posture: PosturePair,
        cached_discovered: Option<crate::runtime::acp::adapter::DiscoveredRuntime>,
    ) {
        self.set_external_model_config(posture);
        *self
            .cached_discovered
            .lock()
            .expect("cached_discovered lock poisoned") = cached_discovered;
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
            // ADR-0080 (issue #294): per-session approval state, defaulting to
            // PerCall mode + an empty trust set. Reset on resume
            // (SessionHandle::reset_approval via open_duck).
            approval: Arc::new(crate::approval::ApprovalState::new()),
            enabled_mcp: Mutex::new(HashSet::new()),
            last_mcp_connect: Mutex::new(Vec::new()),
            // Issue #353: the built-in runtime is the honest default (ADR-0081);
            // an external CLI is an explicit per-session pick, restored on
            // resume from the recipe header (ADR-0102).
            runtime_posture: Mutex::new(RuntimePosture::default()),
            cached_discovered: Mutex::new(None),
            mounted_skills_snapshot: Mutex::new(Vec::new()),
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

    /// Close a session and, if its timeline is completely empty (ADR-0089
    /// Decision 6), delete the per-session directory so empty sessions do not
    /// linger as sidebar "新会话" ghost entries.
    ///
    /// Uses [`SessionHandle::try_session_lock`] to avoid blocking on an
    /// in-flight ask: the `ask` command holds the session mutex for the entire
    /// turn inside `spawn_blocking`, so a blocking `session_lock()` here would
    /// hang for up to 120s (ADR-0021 HTTP timeout) — violating ADR-0055's
    /// fire-and-forget contract. When the lock is unavailable (ask in flight),
    /// cleanup is skipped (`Ok(false)`); the ask will discard its turn because
    /// [`Self::close`] sets the closing flag, but the directory survives until
    /// a future cleanup.
    ///
    /// Returns `true` when the directory was deleted (or was already gone),
    /// `false` for a normal close, when the lock was unavailable, or when the
    /// best-effort `remove_dir_all` failed.
    pub fn close_and_cleanup_empty(&self, id: &SessionId) -> Result<bool, SessionError> {
        let handle = self.get(id)?;
        // try_lock: never blocks. If the ask holds the lock, skip cleanup.
        let session_dir = handle.try_session_lock().and_then(|s| {
            if s.is_timeline_empty() {
                s.duck_path()
                    .and_then(|p| p.parent())
                    .map(std::path::PathBuf::from)
            } else {
                None
            }
        });
        self.close(id)?;
        if let Some(dir) = session_dir {
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
                Err(e) => {
                    log::warn!(
                        target: "toptopduck::session",
                        "close_and_cleanup_empty: failed to remove session dir {}: {e}",
                        dir.display()
                    );
                    Ok(false)
                }
            }
        } else {
            Ok(false)
        }
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

    /// The manual Deserialize impl delegates to parse(), so non-v4 UUIDs are
    /// rejected on the serde path too -- not just via parse(). Without this,
    /// a derived Deserialize would silently accept any well-formed UUID.
    #[test]
    fn deserialize_rejects_non_v4_uuid() {
        for wire in [
            "\"00000000-0000-0000-0000-000000000000\"", // nil
            "\"a0eebc99-9c0b-1ef8-bb6d-6249ebb38000\"", // v1
        ] {
            serde_json::from_str::<SessionId>(wire)
                .expect_err("non-v4 UUID must reject via Deserialize: {wire}");
        }
        // A valid v4 UUID round-trips through serde.
        let v4 = "\"550e8400-e29b-41d4-a716-446655440000\"";
        let id: SessionId = serde_json::from_str(v4).expect("valid v4 UUID deserializes");
        assert_eq!(id.to_string(), "550e8400-e29b-41d4-a716-446655440000");
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

    /// `SessionHandle::set_mcp_enabled` toggles server-granularity enablement
    /// (issue #301 slice D, AC#3): a fresh session enables nothing, toggle-on
    /// inserts, toggle-off removes (both idempotent), and reset_mcp_enablement
    /// returns the set to empty + clears the connect cache. The whole
    /// lifecycle is lock-light on the handle -- no session lock taken.
    #[test]
    fn mcp_enablement_toggles_idempotently_and_resets() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        let srv_a = McpServerId("srv-a".into());
        let srv_b = McpServerId("srv-b".into());

        // Fresh session: empty whitelist (ADR-0080 lineage, default-strict -- a
        // configured server does not connect until the user toggles it on).
        assert!(
            handle.enabled_mcp_servers().is_empty(),
            "fresh session enables no MCP server"
        );

        // Toggle on is idempotent + observable.
        handle.set_mcp_enabled(srv_a.clone(), true);
        handle.set_mcp_enabled(srv_a.clone(), true);
        let enabled = handle.enabled_mcp_servers();
        assert_eq!(enabled.len(), 1, "duplicate toggle-on is idempotent");
        assert!(enabled.contains(&srv_a), "srv_a is enabled");

        // A second server toggles on independently.
        handle.set_mcp_enabled(srv_b.clone(), true);
        assert_eq!(
            handle.enabled_mcp_servers().len(),
            2,
            "two distinct servers coexist"
        );

        // Toggle off is idempotent + removes only the target.
        handle.set_mcp_enabled(srv_a.clone(), false);
        handle.set_mcp_enabled(srv_a.clone(), false);
        let enabled = handle.enabled_mcp_servers();
        assert_eq!(enabled.len(), 1, "duplicate toggle-off is idempotent");
        assert!(
            enabled.contains(&srv_b),
            "srv_b stays enabled when srv_a is toggled off"
        );

        // Reset clears the set + the connect cache (resume resets it, AC#3).
        handle.set_last_mcp_connect(vec![ConnectResult {
            id: srv_b.clone(),
            connected: true,
            tool_count: 3,
            tools: Vec::new(),
            error: None,
        }]);
        handle.reset_mcp_enablement();
        assert!(
            handle.enabled_mcp_servers().is_empty(),
            "reset clears the enablement set"
        );
        assert!(
            handle.last_mcp_connect().is_empty(),
            "reset clears the connect cache alongside the enablement set"
        );
    }

    /// `fire_cancel` wakes a gate blocked on the approval condvar (not just
    /// the engine interrupt): while suspended the gate is outside DuckDB, so
    /// without `interrupt_pending` the engine interrupt alone would leave it
    /// waiting on the 200ms cancel-poll. This pins the SessionHandle wiring
    /// (ADR-0080); removing the `interrupt_pending` line would delay the wake
    /// by up to 200ms (the test has no time bound, so it would still pass --
    /// but the wiring is correct here and verified by inspection).
    #[test]
    fn fire_cancel_wakes_approval_gate() {
        use crate::approval::{
            ApprovalRequest, ApprovalSink, GateCancelled, OperationKind, ToolKey,
        };
        use std::sync::Mutex;
        use std::time::{Duration, Instant};

        // Minimal counting sink: the test only needs to observe the gate has
        // suspended (request emitted) before firing cancel.
        // (approval::tests::RecordingSink is private, so this is the local
        // test seam.)
        struct CountSink {
            requests: Mutex<usize>,
        }
        impl Default for CountSink {
            fn default() -> Self {
                Self {
                    requests: Mutex::new(0),
                }
            }
        }
        impl ApprovalSink for CountSink {
            fn emit_request(&self, _body: &crate::approval::ApprovalRequestBody) {
                *self.requests.lock().unwrap() += 1;
            }
            fn emit_resolved(
                &self,
                _body: &crate::approval::ApprovalRequestBody,
                _response: crate::approval::ApprovalResponse,
            ) {
            }
        }

        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("create session");
        let handle = store.get(&id).expect("get handle");

        let approval = handle.approval_state();
        let cancel = handle.cancel_token();
        let sink = Arc::new(CountSink::default());

        let approval_c = Arc::clone(&approval);
        let cancel_c = Arc::clone(&cancel);
        let sink_c = Arc::clone(&sink);
        let worker = std::thread::spawn(move || {
            let req = ApprovalRequest {
                key: ToolKey::external("acme", "fetch"),
                operation_kind: OperationKind::Network,
                summary: "GET /x".into(),
            };
            approval_c.gate(req, &*sink_c as &dyn ApprovalSink, &cancel_c)
        });

        // Wait for the gate to suspend (request emitted), then fire_cancel --
        // engine interrupt + interrupt_pending. The wake must be immediate.
        let deadline = Instant::now() + Duration::from_secs(2);
        while *sink.requests.lock().unwrap() == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(*sink.requests.lock().unwrap() > 0, "request emitted");
        handle.fire_cancel();

        let err = worker.join().expect("gate thread").expect_err("cancelled");
        assert_eq!(err, GateCancelled);
    }

    /// The runtime choice defaults to the built-in runtime (None) and
    /// round-trips an external adapter spec (issue #353). The choice lives on
    /// the handle, so a fresh session starts built-in (the command layer
    /// applies the default runtime on top) and the resume path overwrites it
    /// with the restored session runtime via the same setter (ADR-0102
    /// Decision 1, issue #589 -- segment continuation, not a reset).
    #[test]
    fn runtime_choice_defaults_to_none_and_round_trips() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("create session");
        let handle = store.get(&id).expect("get handle");

        assert!(
            handle.runtime_choice().is_none(),
            "a fresh session defaults to the built-in runtime"
        );

        let spec = crate::runtime::acp::adapter::gemini_cli();
        handle.set_runtime_choice(Some(spec.clone()));
        let chosen = handle
            .runtime_choice()
            .expect("an external choice round-trips");
        assert_eq!(chosen.id.as_str(), "gemini-cli");

        // The resume restore writes through the same setter -- an overwrite,
        // not a reset to the machine-level default.
        handle.set_runtime_choice(None);
        assert!(
            handle.runtime_choice().is_none(),
            "the restored built-in choice clears the external one"
        );
    }

    /// The runtime choice + the posture pair share ONE mutex slot (issue
    /// #600): the combined write lands both atomically, the combined read
    /// returns both from the same slot state, and a single-field write only
    /// touches its field -- so no read shape can observe one runtime paired
    /// with the other's posture.
    #[test]
    fn runtime_and_posture_share_one_slot() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("create session");
        let handle = store.get(&id).expect("get handle");

        // The combined write lands both fields; every read shape sees it.
        let spec = crate::runtime::acp::adapter::gemini_cli();
        let posture = PosturePair {
            model: Some("fake-opus".into()),
            thought_level: Some("high".into()),
        };
        handle.set_runtime_and_posture(Some(spec), posture.clone());
        assert_eq!(handle.runtime_choice().unwrap().id.as_str(), "gemini-cli");
        assert_eq!(handle.external_model_config(), posture);
        let (runtime, pair) = handle.runtime_and_posture();
        assert_eq!(runtime.unwrap().id.as_str(), "gemini-cli");
        assert_eq!(pair, posture);

        // A single-field write only touches its field; the combined read
        // still returns both under the one lock.
        handle.set_external_model_config(PosturePair::default());
        let (runtime, pair) = handle.runtime_and_posture();
        assert_eq!(runtime.as_ref().unwrap().id.as_str(), "gemini-cli");
        assert_eq!(pair, PosturePair::default());

        // The conditional write keys off the same slot state: it lands
        // while the runtime still matches the read, and drops after a
        // combined write changed the runtime (the set commands' write-back
        // guard).
        let pair = PosturePair {
            model: Some("fake-sonnet".into()),
            thought_level: None,
        };
        assert!(handle.set_posture_if_runtime(&runtime, pair.clone()));
        assert_eq!(handle.external_model_config(), pair);
        let codex = crate::runtime::acp::adapter::codex();
        handle.set_runtime_and_posture(Some(codex), PosturePair::default());
        assert!(!handle.set_posture_if_runtime(&runtime, pair));
        assert_eq!(
            handle.external_model_config(),
            PosturePair::default(),
            "the stale-namespace write-back is dropped after a switch"
        );
    }

    /// ADR-0095: the session-level model config trio round-trips through the
    /// lock-light accessors; the model + thought-level pair share ONE mutex
    /// slot (issue #530), so the pair reader returns both values from the
    /// same slot state; and `restore_runtime_model_config` (the resume path)
    /// overwrites all three in one shot -- it is the only writer that
    /// overwrites the catalog slot.
    #[test]
    fn external_model_config_round_trips_pair_slot_survives_restore() {
        let store = crate::session_store::SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("session");
        let handle = store.get(&id).expect("handle");

        assert_eq!(handle.external_model_config(), PosturePair::default());
        assert_eq!(handle.cached_discovered(), None);

        handle.set_external_model_config(PosturePair {
            model: Some("fake-opus".into()),
            thought_level: Some("high".into()),
        });
        // The pair reader returns both fields of the same slot state.
        assert_eq!(
            handle.external_model_config(),
            PosturePair {
                model: Some("fake-opus".into()),
                thought_level: Some("high".into())
            }
        );

        let catalog = crate::runtime::acp::adapter::DiscoveredRuntime {
            models: vec!["fake-opus".into(), "fake-sonnet".into()],
            current_model: Some("fake-opus".into()),
            thought_levels: vec!["low".into()],
            current_thought_level: None,
            model_config_id: Some("model".into()),
            thought_level_config_id: Some("reasoning_effort".into()),
            adapter_id: Some("gemini-cli".into()),
        };
        handle.set_cached_discovered(catalog.clone());
        assert_eq!(handle.cached_discovered(), Some(catalog.clone()));
        // A built-in / CodexEventStream turn never calls the setter (its None
        // means "no discovery"); a second ACP catalog replaces the first.
        let empty_catalog = crate::runtime::acp::adapter::DiscoveredRuntime::empty();
        handle.set_cached_discovered(empty_catalog.clone());
        assert_eq!(handle.cached_discovered(), Some(empty_catalog));

        // The resume restore overwrites all three in one shot.
        handle.restore_runtime_model_config(PosturePair::default(), None);
        assert_eq!(handle.external_model_config(), PosturePair::default());
        assert_eq!(handle.cached_discovered(), None);
    }

    /// `open_duck` calls `reset_approval` after the resume swap (ADR-0080:
    /// resume 归零). This test verifies the handle-level mechanism: set a
    /// non-default approval posture, call `reset_approval` (the exact call
    /// `open_duck` makes after the resumed Session is live), and confirm the
    /// defaults are restored. If the reset call were removed from `open_duck`
    /// or `reset_approval` stopped working, a resumed session would inherit the
    /// prior session's NoConfirmation mode (violating ADR-0080).
    #[test]
    fn reset_approval_restores_default_posture_after_resume() {
        use crate::approval::AuthMode;

        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
            )
            .expect("create session");
        let handle = store.get(&id).expect("get handle");

        // Simulate a session that ran under NoConfirmation before resume.
        let approval = handle.approval_state();
        approval.set_auth_mode(AuthMode::NoConfirmation);
        assert_eq!(
            approval.auth_mode(),
            AuthMode::NoConfirmation,
            "pre-condition: non-default mode"
        );

        // open_duck's resume swap calls reset_approval after the new Session
        // is live (ADR-0080: resume 归零).
        handle.reset_approval();

        assert_eq!(
            approval.auth_mode(),
            AuthMode::PerCall,
            "resume resets auth mode to PerCall (ADR-0080)"
        );
        assert!(
            approval.trust_list().is_empty(),
            "resume clears the session trust set (ADR-0080)"
        );
    }
}
