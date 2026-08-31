//! Tauri command boundary (frontend <-> Rust). Thin wrappers over the
//! multi-session [`SessionStore`](crate::session_store::SessionStore) (ADR-0056):
//! every session-scoped command takes `session_id` as its first parameter,
//! parses it into a typed [`SessionId`] (a malformed id surfaces as
//! [`SessionError::InvalidId`], distinct from a closed session's
//! [`SessionError::NotFound`] -- issue #73), looks up the target
//! handle, and runs against it. The store lock is held only for the brief
//! lookup; long turns run against a cloned `Arc<SessionHandle>` with no store
//! lock held (ADR-0056 concurrency model). Session-scoped commands return
//! `Result<T, SessionError>` for IPC (issue #119): [`SessionError`] is
//! serde-structured (`#[serde(tag = "kind", content = "data")]`) so the
//! frontend narrows on `kind` and renders a locale message -- the Chinese
//! wording no longer crosses IPC. Session-AGNOSTIC commands (api key /
//! provider / app config / session listing) return
//! `Result<T, StoreCommandError>` for the cold-store subset (issue #130):
//! [`StoreCommandError`] is serde-structured like [`SessionError`], so the
//! frontend narrows on `kind` and renders a locale message -- the Chinese
//! wording no longer crosses IPC. The cold-store subset covers `delete_session`
//! / `rename_persisted_session` (a cross-session `.duck` file), the keychain
//! commands, and `set_provider_config` / `set_app_config`. The remaining
//! session-agnostic commands (read-only listing / has-key) cannot
//! fail with a user-facing refusal and keep returning `Result<T, String>`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, Manager, State};

use crate::app_config::{AppConfig, DefaultRuntime, ModelPosture};
use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink, AuthMode, ToolKey};
use crate::cancel::CancelToken;
use crate::mcp::config::{McpServerConfig, McpServerId, McpTransport};
use crate::mcp::McpClient;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadOutcome, ProfileId, ProfileKeyStatus,
    ProfileTestOutcome, Protocol, ProviderConfig, ProviderConfigView, RemoveSourceError, RowPage,
    SheetGuidance, ThreadEntry, TurnOutcome, TurnProgress,
};
use crate::persistence::recipe::LastRuntime;
use crate::persistence::{
    default_sessions_root, scan_sessions_dir, validate_sessions_dir, SaveError, SessionMetadata,
    SessionsRoot,
};
use crate::provider::live_config::{ActiveKeyError, LiveProviderConfig};
use crate::runtime::acp::adapter::{detect_adapter, v1_adapters, AdapterSpec, StreamFormat};
use crate::runtime::acp::catalog_store::{
    now_millis, AdapterCatalogEntry, AdapterCatalogStore, AdapterCatalogs, CachedOutcome,
};
use crate::session::loop_contract::DiscoveredRuntime;
use crate::session::{
    PosturePair, RenameSessionError, ResumeEvent, ResumeProgress, Session, SessionRuntimeFacts,
    TurnInputs,
};
use crate::session_store::{SessionError, SessionHandle, SessionId, SessionStore};
use crate::skills::{
    discover_skill_sources, import_skills as import_skills_impl, resolve_prompt_fragments,
    ImportItem, ImportMode, ImportOutcome, SkillEntry, SkillError, SkillListing,
    SkillPromptFragment, SkillSource, SkillSourceCandidate, SkillUpdate, SkillsRoot,
};

/// ADR-0063: the close-and-wait-release variant's wait ceiling. Aligned to
/// ADR-0021's `REQUEST_TIMEOUT` (120s, the in-flight ask's longest possible
/// tail -- an HTTP soft-cancel). On timeout, the delete path surfaces an error
/// so the user can retry; the single-writer gate is NOT weakened (the canonical
/// key stays the sole release point in `Session::Drop`).
const CLOSE_WAIT_RELEASE_TIMEOUT: Duration = Duration::from_secs(120);

/// A session-AGNOSTIC cold-store command failed (issue #130). The cold-store
/// commands -- `delete_session` / `rename_persisted_session` (a cross-session
/// `.duck` file), `set_api_key` / `clear_api_key` (the OS keychain), and
/// `set_provider_config` / `set_app_config` (an app-config write) -- reject with
/// this typed enum instead of a free-text `String`, so the frontend renders each
/// refusal through the locale catalog (ADR-0052 layer 2) and the Chinese wording
/// no longer crosses IPC. Adjacently-tagged (`#[serde(tag = "kind", content =
/// "data")]`) like [`SessionError`]; the top-level `kind` set is disjoint from
/// every other typed IPC error's, so the frontend's kind dispatch is unambiguous.
///
/// `BlankName` wraps [`RenameSessionError`] so the blank-name refusal has ONE
/// typed shape across `rename_session` (open) and `rename_persisted_session`
/// (cold) -- the frontend renders the same catalog id for both. The three
/// failure variants carry the English technical detail for the fold; user-facing
/// wording lives in the catalog, not the backend string (ADR-0052).
///
/// `Display` is Rust-log-only -- NOT the IPC contract (the frontend reads the
/// serde `kind`, never this string).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum StoreCommandError {
    /// A delete / cold-rename targeted a `.duck` path an open in-memory session
    /// owns. The single-writer canonical-key gate refused it (ADR-0035 Decision
    /// 3); the frontend closes the session first.
    #[error("session is open; close it first")]
    OpenConflict,
    /// A cold-rename was given a blank name. Wraps
    /// [`RenameSessionError::EmptyName`] (issue #130 AC: the blank-name refusal
    /// is typed-identical to `rename_session`'s, not a second shape).
    #[error("{0}")]
    BlankName(RenameSessionError),
    /// An export targeted a destination that already exists (issue #449). A
    /// user-correctable refusal, like [`OpenConflict`] — the frontend prompts
    /// the user to pick a different name. Carries the destination path.
    #[error("destination already exists: {0}")]
    DestinationExists(String),
    /// An underlying IO failure (canonicalize / read / atomic-save / file
    /// remove) carrying the English technical detail for the fold.
    #[error("{0}")]
    IoFailure(String),
    /// The OS keychain access failed (ADR-0029 trust root). Carries the English
    /// technical detail; no key is ever leaked in the message.
    #[error("{0}")]
    KeychainFailure(String),
    /// An app-config write failed (read / serialize / temp-write / rename).
    /// Carries the English technical detail for the fold; the four WriteError
    /// stages are one refusal to the user, not four messages.
    #[error("{0}")]
    ConfigWriteFailure(String),
    /// An active-profile key write (`set_api_key` / `clear_api_key`) was refused
    /// because there is no active profile to address (ADR-0098 zero-profile
    /// state or null pointer). A user-correctable refusal like [`OpenConflict`]
    /// -- the OS keychain was never touched, so this is NOT a
    /// [`KeychainFailure`]; the remedy is creating/activating a profile.
    #[error("no active provider profile to write the key for")]
    NoActiveProfile,
    /// A `set_default_runtime` call named an adapter id outside the v1 adapter
    /// table (issue #569, ADR-0098 Decision 2). A client bug / stale picker,
    /// not a user mistake -- the settings control only offers `list_adapters`
    /// ids. The app-config was never touched. Carries the offending id for
    /// the technical-details fold.
    #[error("unknown adapter id: {0}")]
    UnknownAdapter(String),
    /// A `upsert_cli_tool` call failed entry validation (issue #671,
    /// ADR-0108 Decision 2: name shape / reserved-name collision / template
    /// inconsistency). User-correctable: the registry was never touched.
    /// Carries the validation detail.
    #[error("{0}")]
    InvalidCliTool(String),
}

/// The CLI-tool registry's typed error folds into the command lane once:
/// the validation refusal maps to [`StoreCommandError::InvalidCliTool`],
/// the app-config fault to [`StoreCommandError::ConfigWriteFailure`]
/// (every CLI command shares this; the single `From` keeps the four call
/// sites from drifting apart).
impl From<crate::provider::live_config::CliToolWriteError> for StoreCommandError {
    fn from(e: crate::provider::live_config::CliToolWriteError) -> Self {
        match e {
            crate::provider::live_config::CliToolWriteError::Invalid(detail) => {
                StoreCommandError::InvalidCliTool(detail)
            }
            crate::provider::live_config::CliToolWriteError::Write(e) => {
                StoreCommandError::ConfigWriteFailure(e.to_string())
            }
        }
    }
}

/// Reject a mutating command while THIS session is resuming (ADR-0053, made
/// per-session by ADR-0056). `open_duck(session_id, ...)` rebuilds that one
/// session's contents off-thread; a concurrent mutating command targeting the
/// SAME session would silently operate on the stale pre-resume session and be
/// overwritten when `*s = new_session` lands. The frontend's shared `loading`
/// flag is the primary defense; this per-session check is the Rust-side
/// backstop for races the frontend cannot see (a second window, an IPC
/// replay). A DIFFERENT session's resume does NOT block this command -- the
/// flag is per-handle, not process-global. Returns the typed
/// [`SessionError::Resuming`] so the command boundary's `?` maps it to the
/// user-facing Chinese error string the frontend renders.
fn reject_if_resuming(handle: &SessionHandle) -> Result<(), SessionError> {
    if handle.is_resuming() {
        return Err(SessionError::Resuming);
    }
    Ok(())
}

/// Reject a second turn on the SAME session while one is in flight (ADR-0021
/// single-flight, per session via ADR-0056). Read from the session's cancel
/// token via the handle accessor (no session lock needed -- the token is
/// `Arc`-shared). A DIFFERENT session's in-flight turn never trips this --
/// each session has its own token. The session `Mutex` is the correctness
/// backstop for the check-then-acquire race; this fast-path keeps a stray
/// second call from blocking <=120s on the first turn's HTTP. Returns the
/// typed [`SessionError::InFlight`].
fn reject_if_in_flight(handle: &SessionHandle) -> Result<(), SessionError> {
    if handle.is_in_flight() {
        return Err(SessionError::InFlight);
    }
    Ok(())
}

/// The wire reply from `create_session` (ADR-0089): the runtime session id +
/// the bound `session.duck` path. The frontend stores both so every open
/// session is known-persisted from creation.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CreateSessionReply {
    pub session_id: SessionId,
    pub duck_path: String,
}

/// Create a new session (ADR-0056/0089): the backend builds an independent
/// in-memory DuckDB instance (ADR-0012/0027), allocates a per-session cancel
/// token (ADR-0021), binds them to a backend-generated id (UUID v4), and
/// immediately persists by creating a per-session directory + initial
/// `session.duck` under the managed sessions root (ADR-0089 Decision 1). The
/// session is bound from creation -- no pure-memory phase, no manual first
/// save. Returns the id + the bound path so the frontend tracks a
/// known-persisted session.
#[tauri::command]
pub fn create_session(
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    sessions_root: State<'_, SessionsRoot>,
    skills_root: State<'_, SkillsRoot>,
) -> Result<CreateSessionReply, SessionError> {
    let cancel = Arc::new(CancelToken::new());
    // The real LLM provider (ADR-0007/0064): a LiveProvider router that reads
    // the active profile's protocol per turn and dispatches to the anthropic
    // or openai adapter. Reads the API key from the OS keychain and the
    // endpoint config from app-config (ADR-0038) via the shared
    // LiveProviderConfig. A fresh session starts usable once a key is stored;
    // before that every turn refuses honestly as not-wired.
    let provider = Box::new(crate::LiveProvider::new(live.inner().clone()));
    // Session-level engine-defaults snapshot (issue #741): read the CURRENT
    // app-config at the construction point -- later settings changes only
    // reach sessions created after them.
    let engine_defaults = live.load().engine.clone();
    let id = store.create(cancel, provider, engine_defaults)?;
    // ADR-0098 Decision 2 (issue #569): a fresh session starts on the
    // RESOLVED default runtime, not the hardcoded built-in -- the same
    // resolution resume falls back to (`startup_runtime_choice`), so both
    // startup points share one degrade rule (undetected default -> built-in
    // for this session only, config field untouched).
    let startup = startup_runtime_choice(live.inner());
    let handle = store.get(&id)?;
    // ADR-0100 Decision 1 (issue #581): the fresh session's startup model /
    // thought-level = the startup adapter's backfill entry -- SELECTED +
    // injected, not a display-only hint. The pair lands on BOTH slots (the
    // handle mirror the lock-light reads serve + the Session storage the
    // recipe persists) BEFORE the initial bind -- see
    // [`apply_startup_posture`] -- so the first recipe already carries it
    // and a restart before the first turn resumes selected (ADR-0095
    // Decision 6). No entry (never chosen / cleared) or a degraded built-in
    // start stays unselected. Resume never lands here: it restores the
    // session's own posture and never consults the backfill map.
    let posture = session_posture(segment_start_posture(startup.as_ref(), live.inner()));
    handle.set_runtime_choice(startup);
    // ADR-0089: per-session directory `{sessions_root}/{uuid}/session.duck`.
    // The UUID directory name is the stable identity; session.duck is the
    // fixed recipe filename.
    let session_dir = sessions_root.path().join(id.to_string());
    let duck_path = session_dir.join("session.duck");

    // Rollback closure: if any step after store.create() fails, the handle is
    // already in the store map (with a live DuckDB instance + cancel token).
    // The frontend never receives the id on failure, so it cannot close the
    // session itself. We must tear it down here to avoid a resource leak +
    // a held canonical-writer key (C1).
    let result = (|| -> Result<CreateSessionReply, SessionError> {
        std::fs::create_dir_all(&session_dir)
            .map_err(|e| SessionError::Engine(format!("failed to create session dir: {e}")))?;
        // Bind immediately (ADR-0089 Decision 1): empty session_name is the
        // placeholder; the first terminal turn's auto-naming overwrites it.
        let handle = store.get(&id)?;
        // Seat the backfill posture BEFORE the bind so the initial recipe
        // persists it (ADR-0100 Decision 1; see the helper's doc).
        apply_startup_posture(&handle, &posture)?;
        let mut s = handle.session_lock()?;
        // Auto-include (issue #677, ADR-0109 Decision 6): the MATERIALIZED
        // builtin skills whose companion CLI entries are detected + enabled
        // seed the folded active set's INITIAL state -- no Mount event, no
        // timeline entry, nothing persisted (the recipe stays event-only).
        // The materialized gate is the side-table mark (the same anchor the
        // frontend's `acquired: builtin` derives from), so a reverse-conflict
        // user file is never seeded.
        let auto_skills = crate::skills::builtin::auto_included_names(
            &live.cli_tools(),
            &crate::skills::BuiltinSkillMark::from_config(&live.load()),
            &skills_root.0,
        );
        s.seed_initial_skills(auto_skills);
        s.bind_duck(duck_path.clone(), String::new())
            .map_err(|e| SessionError::Engine(e.to_string()))?;
        Ok(CreateSessionReply {
            session_id: id.clone(),
            duck_path: duck_path.to_string_lossy().into_owned(),
        })
    })();

    if result.is_err() {
        // Best-effort rollback: drop the handle from the store (releases the
        // DuckDB instance + cancel token + canonical key via Session::Drop),
        // then remove the partially-created directory if it exists.
        let _ = store.close(&id);
        let _ = std::fs::remove_dir_all(&session_dir);
    }

    result
}

/// Import an external `.duck` into the managed sessions tree (ADR-0089
/// Decision 5, issue #450). Copies the external file (and companion `assets/`
/// if present) into a fresh per-session directory `{sessions_root}/{uuid}/`,
/// then returns the session id + the local duck path. The frontend follows up
/// with `open_duck` on the returned path to resume the copied recipe.
///
/// Unlike `create_session`, the store entry is NOT bound here — binding happens
/// inside `Session::open_duck` when the frontend calls `open_duck` with the
/// returned path. This avoids a canonical-writer registry conflict: the unbound
/// store entry holds no key, so `open_duck`'s `OpenDuckGuard::acquire` on the
/// same path succeeds cleanly.
///
/// The original external file is never modified — copy, not move. On any
/// failure after `store.create()`, the store entry is closed and the partially
/// created directory is removed (same rollback pattern as `create_session`).
/// Runs the file I/O off the async/UI thread (matching `export_session`),
/// because copying a large `assets/` tree can take noticeable time.
#[tauri::command]
pub async fn prepare_import_session(
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    sessions_root: State<'_, SessionsRoot>,
    external_path: String,
) -> Result<CreateSessionReply, SessionError> {
    let cancel = Arc::new(CancelToken::new());
    let provider = Box::new(crate::LiveProvider::new(live.inner().clone()));
    // Same snapshot source as `create_session` (issue #741): the placeholder
    // session takes the current config; the later `open_duck` re-reads the
    // config at ITS construction point, same rule.
    let engine_defaults = live.load().engine.clone();
    let id = store.create(cancel, provider, engine_defaults)?;
    let session_dir = sessions_root.path().join(id.to_string());
    let duck_path = session_dir.join("session.duck");
    let src = PathBuf::from(&external_path);

    let session_dir_for_task = session_dir.clone();
    let duck_path_for_task = duck_path.clone();
    let id_for_task = id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        import_session_files(&src, &session_dir_for_task)
            .map_err(|e| SessionError::Engine(format!("failed to import session: {e}")))?;
        Ok::<CreateSessionReply, SessionError>(CreateSessionReply {
            session_id: id_for_task,
            duck_path: duck_path_for_task.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))?;

    if result.is_err() {
        // Same rollback as create_session: close the store entry (releases the
        // DuckDB instance + cancel token; no canonical key since never bound)
        // and remove the partially-created directory. Log cleanup failures for
        // observability (matching cleanup_export_dest's pattern, commands.rs:1595).
        if let Err(e) = store.close(&id) {
            log::warn!(
                target: "toptopduck::session",
                "import rollback: store.close({id}) failed: {e}",
            );
        }
        if let Err(e) = std::fs::remove_dir_all(&session_dir) {
            log::warn!(
                target: "toptopduck::session",
                "import rollback: remove_dir_all({}) failed (partial dir may remain): {}",
                session_dir.display(),
                e,
            );
        }
    }

    result
}

/// Close a session (ADR-0055): mark closing, fire cancel, and remove the entry
/// from the store. Returns immediately -- it does NOT wait for an in-flight
/// ask. If a turn is in flight, cancel fires (HTTP still runs to completion
/// <=120s, ADR-0021 soft-cancel) and the ask's post-turn check sees `closing`
/// and discards the outcome (no thread append, no recipe persist). New commands
/// targeting this id after close reject as unknown session. The DuckDB instance
/// + the bound `.duck` canonical-writer key are released when the last
/// `Arc<SessionHandle>` drops (immediately if no ask is in flight, or when the
/// in-flight ask's clone drops after its discard).
///
/// ADR-0089 Decision 6: if the timeline is completely empty (no turns, no
/// source lifecycle events, no skill lifecycle events), the per-session
/// directory is deleted so empty sessions do not linger as sidebar entries.
/// Uses `try_lock` so the close never blocks on an in-flight ask (ADR-0055).
/// Returns `true` when cleanup happened, `false` for a normal close or when
/// the lock was unavailable (ask in flight).
#[tauri::command]
pub fn close_session(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<bool, SessionError> {
    let id = SessionId::parse(&session_id)?;
    store.close_and_cleanup_empty(&id)
}

/// Close a session AND block until the canonical single-writer key is released
/// (ADR-0063). The delete path's variant of close: `delete_session`'s
/// `try_acquire` gate (ADR-0035) succeeds only once [`Session::Drop`] has run,
/// so a delete that races an in-flight ask must wait for the ask's `Arc` clone
/// to drop. The pure-close variant ([`close_session`]) stays fire-and-forget
/// (ADR-0055) -- this command is the wait variant the delete path uses.
///
/// Resolves immediately when no ask is in flight (detach drops the last `Arc` ->
/// `Session::Drop` fires before `recv_timeout` starts). Resolves when the
/// in-flight ask's post-turn discard drops its clone. Times out at
/// [`CLOSE_WAIT_RELEASE_TIMEOUT`] (120s) -> the caller surfaces an error so the
/// user can retry; the single-writer gate is NOT bypassed.
#[tauri::command]
pub async fn close_session_and_wait_release(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    // Detach: mark closing + fire cancel + remove from the map + return the
    // handle. After this, no new commands can target the id (get -> NotFound).
    let detached = store.detach(&id)?;
    // Take the drop-signal receiver BEFORE releasing our handle clone so the
    // channel stays open regardless of refcount changes. A None here means a
    // second close-wait raced us -- the frontend calls once, so this is a
    // defensive refusal.
    let rx = detached.take_drop_signal()?.ok_or_else(|| {
        SessionError::Engine(
            "close-wait conflict (concurrent close-and-wait-release); retry shortly".into(),
        )
    })?;
    // Drop our handle reference. If no in-flight ask holds a clone, this is the
    // last Arc -> Session::Drop fires -> sender signals -> rx resolves at once.
    // If an ask is in flight, the signal fires when the ask's clone drops after
    // its post-turn discard (closing was set before cancel, so the discard is
    // guaranteed).
    drop(detached);
    // Block on a worker thread (std mpsc::recv_timeout is blocking); the
    // canonical key is released in Session::Drop on this same drop chain.
    // Disconnected (without a prior Ok) means the sender was never armed -- a
    // test Session outside any store -- treat as released (no key to wait on).
    let waited = tauri::async_runtime::spawn_blocking(move || {
        match rx.recv_timeout(CLOSE_WAIT_RELEASE_TIMEOUT) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(SessionError::Engine(
                "close-wait timed out (in-flight ask unfinished after 120s); retry shortly".into(),
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Ok(()),
        }
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))?;
    waited
}

/// Ingest a file into the named session. Runs the DuckDB copy-in off the
/// async/UI thread (AC8: does not freeze the app) and returns the outcome
/// descriptor or a clear error.
#[tauri::command]
pub async fn ingest_file(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    path: String,
) -> Result<LoadOutcome, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let handle = Arc::clone(&handle);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        Ok::<LoadOutcome, SessionError>(s.ingest(Path::new(&path)))
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))??;
    Ok(outcome)
}

/// Re-ingest an Excel workbook with the user's guided rectify choices
/// (ADR-0015/0042) into the named session. Called after a `NeedsGuidance`
/// outcome once the UI has gathered header/skip choices per sheet. Runs off the
/// async/UI thread (AC8).
#[tauri::command]
pub async fn ingest_file_guided(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    path: String,
    guidance: Vec<SheetGuidance>,
) -> Result<LoadOutcome, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let handle = Arc::clone(&handle);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        Ok::<LoadOutcome, SessionError>(s.ingest_guided(Path::new(&path), &guidance))
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))??;
    Ok(outcome)
}

/// Fetch one preview window for a sheet parked on the guided-load dialog
/// (issue #750): rows `[offset .. offset + limit)` rendered as strings, served
/// from the parse the `NeedsGuidance` outcome retained on the session -- zero
/// workbook re-parse per page. The (path, sheet) pair must match the retained
/// guidance; a miss (committed, discarded, or superseded) rejects so a stale
/// dialog can never render window rows from a different workbook. Read-only +
/// lock-light in effect (a plain retention read under the session lock).
#[tauri::command]
pub fn guidance_window(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    path: String,
    sheet_name: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<Vec<String>>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    s.guidance_window(&path, &sheet_name, offset, limit)
        .ok_or_else(|| {
            SessionError::Engine(format!(
                "no retained guidance for sheet \"{sheet_name}\" of {path} (already committed, discarded, or superseded)"
            ))
        })
}

/// Drop the session's retained guided-load parse (issue #750): the dialog's
/// cancel path frees the retained sheets (commit already drops them
/// server-side). Idempotent; the frontend fires it best-effort on cancel.
#[tauri::command]
pub fn discard_guided_retention(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let mut s = handle.session_lock()?;
    s.discard_guidance_retention();
    Ok(())
}

#[tauri::command]
pub fn list_working_set(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Vec<DatasetDescriptor>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    Ok(s.list())
}

#[tauri::command]
pub fn active_dataset(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Option<DatasetDescriptor>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    Ok(s.active())
}

#[tauri::command]
pub fn get_dataset(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
) -> Result<Option<DatasetDescriptor>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    Ok(s.get(&reference_name))
}

/// Rename a dataset's display label (ADR-0037, slice 4a issue #8): display-only
/// -- the reference name is untouched, so SQL / recipe / active references stay
/// valid. Synchronous: no copy-in, just an in-memory label swap. Rejects an
/// unknown reference or a label already shown by another dataset.
#[tauri::command]
pub fn rename_dataset(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    new_display: String,
) -> Result<DatasetDescriptor, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.rename_display(&reference_name, &new_display)
        .map_err(SessionError::RenameDataset)
}

/// Re-upload a file onto an existing dataset's reference name (ADR-0042, issue
/// #11 slice 4b): a fresh snapshot takes over the name and the old one is
/// discarded. Distinct entry from `ingest_file` (add) -- the reference name to
/// take over is explicit. Runs the copy-in off the async/UI thread (AC8).
#[tauri::command]
pub async fn replace_source(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    path: String,
) -> Result<LoadOutcome, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let handle = Arc::clone(&handle);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        Ok::<LoadOutcome, SessionError>(s.replace_source(&reference_name, Path::new(&path)))
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))??;
    Ok(outcome)
}

/// Map a working-set privacy outcome to the typed IPC result (issue #127).
/// [`Session::set_privacy`] returns `None` for an unknown reference name; this
/// maps that `None` to [`SessionError::RemoveSource`](
/// [`RemoveSourceError::NotFound`]) so the frontend renders the shared
/// `error.dataset.notFound` locale message instead of a free-text Engine
/// string. Extracted from the command so the unit test exercises the real
/// mapping path, not an inlined copy (the command's `State` arg blocks a
/// direct call).
fn privacy_update_to_result(
    outcome: Option<DatasetDescriptor>,
    reference_name: &str,
) -> Result<DatasetDescriptor, SessionError> {
    outcome.ok_or_else(|| {
        SessionError::RemoveSource(RemoveSourceError::NotFound(reference_name.to_string()))
    })
}

/// Set a dataset's privacy controls. See [`Session::set_privacy`]
/// -- this is the Tauri/IPC command boundary wrapper. Rejects an unknown
/// reference name as a typed [`RemoveSourceError::NotFound`] (issue #127),
/// reusing the source-management domain error so the frontend renders the
/// shared `error.dataset.notFound` locale message instead of a free-text
/// Engine string.
#[tauri::command]
pub fn set_dataset_privacy(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    privacy: DatasetPrivacy,
) -> Result<DatasetDescriptor, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    privacy_update_to_result(s.set_privacy(&reference_name, privacy), &reference_name)
}

/// Remove a source Dataset from the working set (issue #38/#39, ADR-0040).
/// Detaches the snapshot, deletes its file, drops the reference name from the
/// shared namespace, and appends a `Deleted` source lifecycle event to the
/// thread. Refuses removal while materialized results exist (-> #40 cascade),
/// and refuses the ACTIVE source when OTHER sources remain (ADR-0035 -> issue
/// #39: no silent focus jump -- the caller must use `remove_active_source` to
/// name an explicit continuation). The LAST active source is allowed through
/// here to an empty working set (AC4, issue #39). Synchronous: the session
/// Mutex serializes this against an in-flight turn (correctness), and the
/// frontend additionally disables source management via its shared `loading`
/// flag during the ADR-0040 execution window (UX) -- the two layers are
/// independent. The only I/O is a best-effort DETACH + remove_file.
#[tauri::command]
pub fn remove_source(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.remove_source(&reference_name)
        .map_err(SessionError::RemoveSource)
}

/// Remove the ACTIVE source and repoint focus at an explicit continuation
/// source (issue #39, ADR-0035): the user-facing answer to `remove_source`'s
/// `IsActive` refusal. The frontend's confirm dialog picks `continue_with` from
/// the remaining sources; this command atomically switches the active pointer
/// to it, drops the removed source, and appends a `Deleted` event. Same
/// `HasDerivatives` guard as `remove_source` (-> #40). Refuses with
/// `NotActive`/`InvalidContinueWith` when the view raced a concurrent mutation
/// (the working set is left untouched in those cases). Refusals cross IPC as the
/// typed `SessionError::RemoveSource(RemoveSourceError)` (issue #121), so the
/// frontend narrows on `kind` and renders a locale message.
#[tauri::command]
pub fn remove_active_source(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    continue_with: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.remove_active_source(&reference_name, &continue_with)
        .map_err(SessionError::RemoveSource)
}

/// Ask one question (PRD #1) against the named session: run one agent turn
/// (multi-step tool calls with model-driven self-correction, ADR-0077/0081)
/// and return its ADR-0028 outcome (result / textual / failed / cancelled).
/// Runs off the async/UI thread (AC8) so a slow provider never freezes the
/// app. A turn always produces an outcome; the only `Err` here is an unknown
/// session, a resume guard rejection, an in-flight guard rejection, or a
/// session-lock failure (not a turn failure -- that is a `Failed` outcome).
/// ADR-0055: if the session was closed while this turn was in flight, the
/// outcome is discarded
/// inside `Session::ask` (no thread append, no recipe persist).
#[tauri::command]
pub async fn ask(
    app: tauri::AppHandle,
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    skills_root: State<'_, SkillsRoot>,
    session_id: String,
    question: String,
) -> Result<TurnOutcome, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    reject_if_in_flight(&handle)?;
    // ADR-0080/0083: the session's tiered-approval gateway rides the turn.
    // The store-attached ApprovalState is the SAME instance the
    // `respond_tool_approval` command wakes, so an in-flow approval card
    // suspends + resumes this turn; the TauriApprovalSink emits the card
    // events addressed by sessionId. Both are built here at the command
    // boundary (the only layer holding an AppHandle, ADR-0029) and borrowed
    // per turn, so the Session stays AppHandle-free.
    let approval = handle.approval_state();
    let sink = TauriApprovalSink::new(app.clone(), id.clone());
    let handle = Arc::clone(&handle);
    // The user's configured external MCP servers ride the turn (issue #301
    // slice C-gw): the gateway connects each one per turn (ADR-0076 Q2). A
    // cheap LiveProviderConfig clone (stateless keychain + PathBuf) carries the
    // keychain borrow into the spawn_blocking closure so get_mcp_secret can
    // read each server's secret env at spawn (ADR-0029 -- the value never
    // crosses IPC back out).
    let live = live.inner().clone();
    // ADR-0106: the effective set is single-axis -- config-level enablement
    // only (see [`LiveProviderConfig::enabled_mcp_servers`]). Skill MCP
    // references are declarative metadata and arm nothing (Decision 3). Fresh
    // per-turn snapshot of the app-config file; a config edit between turns
    // is reflected next turn.
    let mcp_servers = live.enabled_mcp_servers();
    // ADR-0059: build the side-channel `turn-progress` emit callback here at the
    // command boundary (the only layer allowed to hold a Tauri AppHandle,
    // ADR-0029) and inject it into the turn via Session::ask_with_phase. Each
    // discrete event (Thinking + the tool-call started/completed stream,
    // ADR-0078) is emitted addressed by sessionId so a multi-session frontend
    // filters the global broadcast to its own pane (ADR-0056/0059). Cloning
    // AppHandle + the id string is cheap; the closure is FnMut (called once
    // per wait boundary + per tool call, across every loop step).
    let app_for_cb = app.clone();
    let sid = id.clone();
    // Clone the skills-root path off the managed State so it can move into the
    // spawn_blocking closure (the State borrow does not cross the await). The
    // registry root is read below to resolve each mounted skill's SKILL.md body
    // + whole-file SHA-256 for prompt injection + provenance (issue #364).
    let skills_root = skills_root.0.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        // Issue #353 + ADR-0095: feed the session's runtime choice and the
        // session-level model + thought-level pair into the turn's dispatch
        // at the turn boundary. Both live on the handle (lock-light writes
        // via set_session_runtime / set_session_posture); the Session consumes
        // them for THIS turn only -- a switch lands between turns, never
        // mid-turn, and a resumed Session reads the restored choice. The
        // combined read takes the one slot lock (issue #600), so the pair
        // the turn consumes is namespaced by the runtime it runs on.
        let (external_runtime, external_posture) = handle.runtime_and_posture();
        s.set_external_runtime(external_runtime);
        s.set_external_model_config(external_posture);
        // Issue #364 (ADR-0086) + #707: the skill + CLI assembly reads both
        // session sets under this held lock (neither can change between the
        // read and the turn) and wires `TurnInputs` in one seam -- see
        // [`assemble_turn_inputs`].
        let assembled = assemble_turn_inputs(&s, &skills_root, &live);
        let inputs = assembled.turn_inputs(&mcp_servers);
        let outcome = s.ask_with_phase(
            &question,
            &approval,
            &sink,
            move |phase| {
                // Fire-and-forget by design: the turn result rides the command
                // reply, not this channel. But a failing sink must not be
                // invisible -- a stuck live card with no trail is undiagnosable,
                // so log the emit error (ADR-0029 honest-degrade; debug, since a
                // torn-down webview fails every emit and is the expected case).
                if let Err(e) = app_for_cb.emit(
                    "turn-progress",
                    &TurnProgress {
                        session_id: sid.clone(),
                        phase,
                    },
                ) {
                    log::debug!(
                        target: "toptopduck::commands",
                        "turn-progress emit failed (likely a torn-down webview): {e}"
                    );
                }
            },
            &inputs,
        );
        // ADR-0095: mirror the turn's discovered runtime catalog onto the
        // handle (lock-light reads for the selector). An ACP turn reports
        // the handshake catalog and a ClaudeStreamJson turn reports the
        // `system{init}` current model (ADR-0097 Decision 5 honest
        // rendering); the built-in / CodexEventStream `None` means "no
        // discovery", so the mirror is skipped and the previous cache
        // survives (issue #530 made the None arm unrepresentable at the
        // setter).
        if let Some(discovered) = s.last_discovered_runtime() {
            handle.set_cached_discovered(discovered);
        }
        Ok::<TurnOutcome, SessionError>(outcome)
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))??;
    Ok(outcome)
}

/// The turn-boundary skill + CLI assembly's owning buffers (issue #364/
/// ADR-0086; the seam itself is issue #707): the data behind `TurnInputs`'s
/// borrowed fields. `commands::ask` calls [`assemble_turn_inputs`] under the
/// held session lock, then borrows through [`Self::turn_inputs`] -- the
/// two-step shape exists because a `TurnInputs` borrows its buffers, so the
/// owning values must be built first and outlive the borrowed view: no Rust
/// signature can return a value and a borrow of that value as one tuple.
/// The keychain rides here as a borrowed field (taken from `live` at
/// assembly time) so the projection carries no source-config re-passes.
struct AssembledTurnInputs<'a> {
    skills: Vec<SkillPromptFragment>,
    activated: Vec<String>,
    /// The registry root borrow (ADR-0111, issue #714): the turn's read
    /// surface resolves skill names against it live, mid-turn.
    skills_root: &'a Path,
    cli_tools: Vec<crate::cli_tools::config::CliToolConfig>,
    keychain: &'a crate::provider::keychain::KeychainStore,
}

/// Read the session's mounted + activated skill sets and resolve the mounted
/// names into prompt fragments (name + description + verbatim body +
/// whole-file SHA-256) against the registry root, here at the command
/// boundary where the root lives, so the session stays I/O-free for skill
/// content (it consumes fragments, mirroring the mcp_servers "data passed in"
/// pattern). The caller must hold the session lock, so neither set can
/// change between this read and the turn. The activated names (ADR-0110,
/// issue
/// #700) are the L1/L2 sort key for the disclosure rendering and the
/// provenance's activated-subset filter. One seam so neither set read nor the
/// `TurnInputs` field wiring can silently pass the wrong set (issue #707's
/// wiring pin) -- the black-box tests hand-assemble their inputs, which left
/// the command body itself uncovered.
fn assemble_turn_inputs<'a>(
    session: &Session,
    skills_root: &'a Path,
    live: &'a LiveProviderConfig,
) -> AssembledTurnInputs<'a> {
    let mounted = session.mounted_skills();
    let activated = session.activated_skills();
    let skills = resolve_prompt_fragments(skills_root, &mounted);
    let cli_tools = live.enabled_cli_tools();
    AssembledTurnInputs {
        skills,
        activated,
        skills_root,
        cli_tools,
        keychain: live.keychain(),
    }
}

impl AssembledTurnInputs<'_> {
    /// Project the owning buffers (plus the caller's command-level MCP
    /// servers) into the turn's borrowed input view.
    fn turn_inputs<'b>(&'b self, mcp_servers: &'b [McpServerConfig]) -> TurnInputs<'b> {
        TurnInputs {
            mcp_servers,
            keychain: self.keychain,
            skills: &self.skills,
            activated: &self.activated,
            skills_root: self.skills_root,
            cli_tools: &self.cli_tools,
        }
    }
}

/// Cancel the named session's in-flight turn (ADR-0021, issue #28). Fires THAT
/// session's cancel token, which sets the cooperative flag AND interrupts the
/// running DuckDB query; the in-flight `ask` lands as a Cancelled outcome at
/// its next check. Addressed by `session_id` (ADR-0056): each session has its
/// own token, so a cancel reaches exactly one session's turn without touching
/// any other. Safe when no turn is in flight (sets a flag the next `ask`
/// resets before it starts). Always succeeds once the session is known: cancel
/// is a best-effort signal, not a transaction.
#[tauri::command]
pub fn cancel(store: State<'_, Arc<SessionStore>>, session_id: String) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    handle.fire_cancel();
    Ok(())
}

/// Read the named session's conversation thread (ADR-0028/0039/0040): the
/// unified timeline of turns AND source lifecycle events, in order.
/// Synchronous -- a snapshot read of the session history with no copy-in. The
/// frontend renders this as the always-visible thread (turns + source events);
/// the window assembler reads only the turns (the session filters source events
/// out before assembly), so source events never enter the LLM payload.
#[tauri::command]
pub fn conversation(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Vec<ThreadEntry>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    Ok(s.conversation())
}

/// Read one page of a dataset's rows from the named session (ADR-0024 windowed
/// display). Runs off the async/UI thread (AC8) like `ask`: a large OFFSET is
/// an O(offset) scan, so holding the session lock on the IPC path would block
/// every other command on that session. Rejects an unknown session as a typed
/// `SessionError`; an unknown reference name / engine error crosses IPC as the
/// typed `SessionError::RowRead(RowReadError)` (issue #121).
#[tauri::command]
pub async fn read_rows(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    offset: u64,
    limit: u64,
) -> Result<RowPage, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let handle = Arc::clone(&handle);
    tauri::async_runtime::spawn_blocking(move || {
        let s = handle.session_lock()?;
        s.read_rows(&reference_name, offset, limit)
            .map_err(SessionError::RowRead)
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))?
}

// --- LLM provider key + endpoint config (issue #29/#53, ADR-0007/0019/0029/0038) ---
//
// Session-AGNOSTIC commands (ADR-0056 Decision 4): the API key, the provider
// endpoint, and the app-level config are NOT tied to any one session, so they
// take no `session_id`. The API key crosses IPC exactly once (frontend -> Rust,
// stored), and thereafter the frontend learns only a boolean. The non-secret
// endpoint config (base URL + model) crosses both ways. As of ADR-0038 the key
// lives in the OS keychain and the endpoint config lives in the app-config
// file -- both reached through the single managed [`LiveProviderConfig`] (the
// key never enters app-config; the endpoint never enters the keychain).

/// Store the API key the frontend collected (ADR-0029: a one-shot
/// frontend-to-Rust transfer; the key is never returned back across IPC).
#[tauri::command]
pub fn set_api_key(
    live: State<'_, LiveProviderConfig>,
    key: String,
) -> Result<(), StoreCommandError> {
    live.set_key(&key).map_err(store_key_error)
}

/// Remove the stored API key. Idempotent: a missing entry is success; a real
/// keychain error propagates so the frontend can tell the user the key did not
/// come out. After a successful clear, the active profile's `has_key` is false
/// and the next turn refuses honestly as not-wired.
#[tauri::command]
pub fn clear_api_key(live: State<'_, LiveProviderConfig>) -> Result<(), StoreCommandError> {
    live.clear_key().map_err(store_key_error)
}

/// Map an active-profile key write failure onto the IPC error contract: the
/// no-active-profile refusal is a config-state rejection
/// ([`StoreCommandError::NoActiveProfile`] -- the OS keychain was never
/// touched), distinct from a real OS keychain fault
/// ([`StoreCommandError::KeychainFailure`], ADR-0029).
fn store_key_error(e: ActiveKeyError) -> StoreCommandError {
    match e {
        ActiveKeyError::NoActiveProfile => StoreCommandError::NoActiveProfile,
        ActiveKeyError::Keychain(detail) => StoreCommandError::KeychainFailure(detail),
    }
}

/// Read the effective provider endpoint + the active profile's key status
/// (ADR-0019/0029/0038/0064/0098). The base URL + model come from the ACTIVE
/// profile in app-config -- `null` when there is no active profile (the legal
/// zero-profile state, ADR-0098: no endpoint to read, exposed honestly rather
/// than masked by canonical defaults). The key does not cross IPC -- only a
/// boolean + a keychain read-fault detail, from the active profile's keychain
/// slot `key-<active_profile_id>` (issue #275: a read fault rides
/// `keychain_fault` so the header indicator renders "keychain unavailable",
/// not "no key").
#[tauri::command]
pub fn get_provider_config(
    live: State<'_, LiveProviderConfig>,
) -> Result<ProviderConfigView, String> {
    let cfg = live.load();
    // view() single-sources the empty-state policy for both provider-config
    // IPCs: null endpoints when no profile is active (ADR-0098).
    Ok(cfg.provider.view(live.has_key()))
}

/// Save the non-secret provider config (ADR-0019/0038/0064/0098) into
/// app-config -- the multi-profile shape `{profiles, active_profile}`. An
/// empty profiles list + a null active pointer is a legal save (ADR-0098);
/// normalize clamps the active profile's empty endpoint fields to the
/// canonical defaults and nulls a dangling active id. The API key never
/// enters this path (ADR-0029/0038: key confined to the OS keychain;
/// app-config has no key field at all).
#[tauri::command]
pub fn set_provider_config(
    live: State<'_, LiveProviderConfig>,
    config: ProviderConfig,
) -> Result<ProviderConfigView, StoreCommandError> {
    let stored = live
        .set_provider_section(config)
        .map_err(|e| StoreCommandError::ConfigWriteFailure(e.to_string()))?;
    Ok(stored.provider.view(live.has_key()))
}

/// Per-profile key status overlay (issue #153, ADR-0064/0029). Returns one
/// entry per profile currently in app-config: the profile id plus whether its
/// keychain slot (`key-<id>`) holds a key (a boolean, never the key). The
/// Profiles UI seeds its `has_key` view from this; profile records themselves
/// come from app-config (single-sourced). A profile minted client-side but not
/// yet saved is absent here -- the UI defaults it to `has_key=false` until
/// `set_profile_key` returns `true`. Read-only: cannot fail with a user-facing
/// refusal, so it returns `Result<_, String>`.
#[tauri::command]
pub fn list_provider_profiles(
    live: State<'_, LiveProviderConfig>,
) -> Result<Vec<ProfileKeyStatus>, String> {
    Ok(live.list_profile_key_status())
}

/// Store the API key for the named profile (issue #153, ADR-0029 one-shot
/// frontend -> Rust transfer; ADR-0064 per-profile slot `key-<profile_id>`).
/// Returns the NEW `has_key` (true on success) so the frontend updates its
/// overlay without a re-fetch. `profileId` is the opaque profile id; it need not
/// match a saved profile yet (a freshly-minted id before Save is a valid target
/// -- the key lands in its slot and the profile's later Save references it).
#[tauri::command]
pub fn set_profile_key(
    live: State<'_, LiveProviderConfig>,
    profile_id: String,
    key: String,
) -> Result<bool, StoreCommandError> {
    let id = ProfileId(profile_id);
    live.set_profile_key(&id, &key)
        .map_err(StoreCommandError::KeychainFailure)
}

/// Remove the key for the named profile (issue #153). Idempotent: a missing
/// entry is success. Returns the NEW `has_key` (false on success). A real
/// keychain error propagates so the frontend can tell the user the key did not
/// come out (ADR-0029 trust root -- a failed delete must not read as "removed").
#[tauri::command]
pub fn clear_profile_key(
    live: State<'_, LiveProviderConfig>,
    profile_id: String,
) -> Result<bool, StoreCommandError> {
    let id = ProfileId(profile_id);
    live.clear_profile_key(&id)
        .map_err(StoreCommandError::KeychainFailure)
}

/// Upsert one MCP server into app-config (issue #301, ADR-0076). The frontend
/// sends a [`McpServerConfig`] with an EMPTY id for a new server (Rust mints a
/// uuid v4) or the existing id for an edit; Rust fills an empty `display_name`
/// from the id, then replaces/appends. Returns the finalized config (with the
/// stable id) so the frontend can reference the server in subsequent secret /
/// remove calls.
#[tauri::command]
pub fn upsert_mcp_server(
    live: State<'_, LiveProviderConfig>,
    server: McpServerConfig,
) -> Result<McpServerConfig, StoreCommandError> {
    live.upsert_mcp_server(server)
        .map_err(|e| StoreCommandError::ConfigWriteFailure(e.to_string()))
}

/// Upsert one CLI tool registration (issue #671, ADR-0108). Validates the
/// entry (kebab-case name, reserved-name collisions, template/param-table
/// consistency) then read-modify-writes the app-config registry. Returns the
/// updated FULL app-config so the frontend syncs its snapshot without a
/// re-fetch (ADR-0109 Decision 9).
#[tauri::command]
pub fn upsert_cli_tool(
    live: State<'_, LiveProviderConfig>,
    tool: crate::cli_tools::config::CliToolConfig,
) -> Result<AppConfig, StoreCommandError> {
    live.upsert_cli_tool(tool).map_err(StoreCommandError::from)
}

/// Remove one CLI tool registration by name (issue #671). Idempotent.
/// A BUILTIN entry is refused (ADR-0109 Decision 2, issue #676 -- disabling
/// is the single shutdown axis); the refusal surfaces through the
/// InvalidCliTool lane. Returns the updated FULL app-config (ADR-0109
/// Decision 9).
#[tauri::command]
pub fn remove_cli_tool(
    live: State<'_, LiveProviderConfig>,
    name: String,
) -> Result<AppConfig, StoreCommandError> {
    live.remove_cli_tool(&name).map_err(StoreCommandError::from)
}

/// Restore one builtin CLI registration to the shipped definition (issue
/// #676, ADR-0109 Decision 2): the four tracked fields are rewritten, the
/// entry returns to FOLLOWING (upgrades follow the baseline again), and the
/// machine-local `executable` + `enabled` state stay. Refusals (a user
/// entry, an unregistered or unknown name) surface through the
/// InvalidCliTool lane. Returns the updated FULL app-config (ADR-0109
/// Decision 9).
#[tauri::command]
pub fn restore_builtin_cli_tool(
    live: State<'_, LiveProviderConfig>,
    name: String,
) -> Result<AppConfig, StoreCommandError> {
    live.restore_builtin_cli_tool(&name)
        .map_err(StoreCommandError::from)
}

/// The manual rescan (issue #675): detect the shipped builtin definitions'
/// executables on PATH (existence only, never a spawn) and auto-register
/// the hits in one read-modify-write. Also the conflict catch-up point:
/// after the user renames or removes an entry that owned a builtin name,
/// this registers the deferred builtin. Returns the updated full config
/// plus the detection snapshot (the frontend syncs both from the return).
#[tauri::command]
pub fn rescan_builtin_cli_tools(
    live: State<'_, LiveProviderConfig>,
    skills_root: State<'_, SkillsRoot>,
) -> Result<crate::cli_tools::builtin::BuiltinScanResult, StoreCommandError> {
    live.scan_and_register(None, &skills_root.0)
        .map_err(StoreCommandError::from)
}

/// Store one MCP server secret in the OS keychain under `mcp-<id>-<env_key>`
/// (issue #301, ADR-0029 one-shot frontend -> Rust transfer). The value never
/// crosses IPC back out.
#[tauri::command]
pub fn set_mcp_server_secret(
    live: State<'_, LiveProviderConfig>,
    id: McpServerId,
    env_key: String,
    value: String,
) -> Result<(), StoreCommandError> {
    live.set_mcp_secret(&id, &env_key, &value)
        .map_err(StoreCommandError::KeychainFailure)
}

/// Remove one MCP server secret (idempotent). A real keychain error surfaces
/// (ADR-0029 trust root) so the frontend can tell the user the secret did not
/// come out.
#[tauri::command]
pub fn clear_mcp_server_secret(
    live: State<'_, LiveProviderConfig>,
    id: McpServerId,
    env_key: String,
) -> Result<(), StoreCommandError> {
    live.clear_mcp_secret(&id, &env_key)
        .map_err(StoreCommandError::KeychainFailure)
}

/// The result of a manual connection probe (issue #387). The settings page's
/// per-row Test button triggers this: spawn the server, initialize, list tools,
/// teardown, and return the outcome so the status dot + expandable tool list
/// update without a full turn. Mirrors the shape the per-turn aggregator
/// produces but is a standalone global IPC (not session-scoped).
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpProbeResult {
    /// Whether the spawn + initialize + tools/list cycle succeeded.
    pub connected: bool,
    /// The tools the server advertised (name + description only; empty when not
    /// connected).
    pub tools: Vec<crate::mcp::aggregator::McpToolInfo>,
    /// The error message when `connected: false` (`None` on success).
    pub error: Option<String>,
}

/// Default probe deadline when [`McpServerConfig::timeout_ms`] is `None`
/// (issue #392). Generous enough for a well-behaved stdio server's spawn +
/// initialize + tools/list cycle on a cold start.
const PROBE_DEFAULT_TIMEOUT_MS: u32 = 30_000;

/// Kill + reap a child process, logging a warning if reaping fails (the kill
/// is best-effort; a failed wait would leak a zombie). Used by the stdio
/// probe path where the Child handle is retained outside `spawn_blocking`.
fn kill_and_reap_child(child: &mut std::process::Child) {
    if let Err(e) = child.kill() {
        log::warn!(target: "toptopduck::mcp", "probe child kill failed: {e}");
    }
    if let Err(e) = child.wait() {
        log::warn!(target: "toptopduck::mcp", "probe child reap failed: {e}");
    }
}

/// Map a timeout-bounded probe outcome to an [`McpProbeResult`]. Both the
/// stdio and SSE/HTTP branches produce the same shape after flattening:
/// `Result<Vec<Value>, String>` (tools on success, error string on failure)
/// wrapped in `tokio::time::timeout`. This helper consolidates the three-arm
/// match (success / error / timeout) so the two transport branches share one
/// mapping.
fn probe_result_from_outcome(
    outcome: Result<Result<Vec<serde_json::Value>, String>, tokio::time::error::Elapsed>,
    server_id: &str,
    deadline_ms: u32,
) -> McpProbeResult {
    match outcome {
        Ok(Ok(tools)) => McpProbeResult {
            connected: true,
            tools: crate::mcp::aggregator::extract_tool_info(&tools),
            error: None,
        },
        Ok(Err(e)) => {
            log::warn!(target: "toptopduck::mcp", "probe for server {server_id} failed: {e}");
            McpProbeResult {
                connected: false,
                tools: Vec::new(),
                error: Some(e),
            }
        }
        Err(_) => {
            log::warn!(
                target: "toptopduck::mcp",
                "probe for server {server_id} timed out after {deadline_ms} ms"
            );
            McpProbeResult {
                connected: false,
                tools: Vec::new(),
                error: Some(format!("probe timed out after {deadline_ms} ms")),
            }
        }
    }
}

/// Probe one MCP server's connectivity (issue #387). Global (not
/// session-scoped): the settings page calls this to test a configured server
/// without starting a turn. Connects via the transport dispatcher
/// (issue #389: stdio / SSE / HTTP), performs initialize + tools/list, then
/// tears down. Receives the full [`McpServerConfig`], resolves the server's
/// secret env values from the keychain
/// ([`McpServerConfig::keychain_env_keys`], ADR-0029 -- values never cross
/// IPC), connects, lists tools, then tears down. Returns the outcome so the
/// UI can render a status dot + expandable tool list.
///
/// Async + deadline-bounded (issue #392): the entire spawn + initialize +
/// tools/list cycle is wrapped in `tokio::time::timeout` with a deadline
/// from `server.timeout_ms` (or the 30 s default). For stdio the child is
/// spawned in the async scope (not inside `spawn_blocking`) so the Child
/// handle is retained for kill-on-timeout — `spawn_blocking` tasks are NOT
/// cancellable, and the only way to guarantee a hung child is reaped is to
/// keep the process handle outside the blocking closure.
#[tauri::command]
pub async fn probe_mcp_server(
    live: State<'_, LiveProviderConfig>,
    server: McpServerConfig,
) -> Result<McpProbeResult, StoreCommandError> {
    let secrets = crate::mcp::aggregator::collect_secrets(live.keychain(), &server);
    let deadline_ms = server.timeout_ms.unwrap_or(PROBE_DEFAULT_TIMEOUT_MS);
    let deadline = Duration::from_millis(deadline_ms as u64);
    let server_id = server.id.as_str();

    // Stdio: spawn the child in the async scope so we own the Child handle
    // for kill-on-timeout. The blocking handshake runs in spawn_blocking with
    // the child's stdin/stdout (issue #392).
    if let McpTransport::Stdio { .. } = &server.transport {
        let mut child = match crate::mcp::client::spawn_stdio_child(&server, &secrets) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(target: "toptopduck::mcp", "probe for server {server_id} spawn failed: {e}");
                return Ok(McpProbeResult {
                    connected: false,
                    tools: Vec::new(),
                    error: Some(e.to_string()),
                });
            }
        };
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();

        let join = tauri::async_runtime::spawn_blocking(move || {
            let stdin = stdin.ok_or_else(|| "child stdin not available".to_string())?;
            let stdout = stdout.ok_or_else(|| "child stdout not available".to_string())?;
            crate::mcp::client::stdio_handshake(stdin, stdout).map_err(|e| e.to_string())
        });

        let outcome = tokio::time::timeout(deadline, async {
            join.await.map_err(|e| e.to_string()).and_then(|r| r)
        })
        .await;

        kill_and_reap_child(&mut child);
        return Ok(probe_result_from_outcome(outcome, server_id, deadline_ms));
    }

    // SSE/HTTP: the blocking I/O runs inside spawn_blocking wrapped in a
    // deadline. The outer deadline is the primary bound — spawn_blocking
    // tasks are not cancelled, so the thread lingers until the I/O returns.
    // HTTP agents carry HTTP_READ_TIMEOUT so the task eventually resolves;
    // SSE has a per-read timeout on its reader thread (SSE_READ_TIMEOUT).
    let server_for_blocking = server.clone();
    let result = tokio::time::timeout(deadline, async {
        tauri::async_runtime::spawn_blocking(move || {
            let mut client =
                crate::mcp::client::connect_transport(&server_for_blocking, &secrets, None)?;
            client.list_tools()
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| e.to_string()))
    })
    .await;

    Ok(probe_result_from_outcome(result, server_id, deadline_ms))
}

/// Discover MCP servers from an external tool's config (issue #390). Reads the
/// source's local config file (Claude Desktop / Codex), parses server
/// definitions, and returns them as [`DiscoveredServer`] entries for the
/// frontend to show in an import checklist. Returns an empty vec when the
/// config file is not found (the frontend shows a "not found" message -- this
/// is NOT an error). A parse error (malformed file) returns an error string.
#[tauri::command]
pub fn discover_mcp_servers(
    source: crate::mcp::import::ImportSource,
) -> Result<crate::mcp::import::DiscoveryResult, String> {
    crate::mcp::import::discover(source)
}

/// Run a connection preflight against the named profile (ADR-0070, issue
/// #236). Reads the profile's stored key from the OS keychain by `profile_id`
/// (ADR-0029 -- the stored key never crosses IPC back to the frontend) and
/// probes the caller-supplied endpoint (`protocol` + `base_url` + `model` =
/// the frontend's current edit values, so a user who edits base_url and
/// re-tests does not have to save first) via `GET /models` with a
/// minimal-turn ping fallback. A failed keychain read short-circuits to
/// `KeychainUnavailable` before any HTTP (issue #243 -- previously swallowed
/// into `None` and misclassified as `KeyRejected`). `key` is the optional
/// one-shot add-mode override (issue #735, ADR-0070 calibration): the add
/// form's buffered draft key, which has not reached the keychain yet -- when
/// it trims non-empty it wins over the keychain read (the keychain is never
/// consulted), otherwise the probe falls back to the keychain read verbatim.
/// The transfer is frontend -> Rust, one request, never persisted and never
/// echoed back. Returns the six-state [`ProfileTestOutcome`] so the
/// frontend renders the result and feeds the listed models to the model
/// dropdown (the list is NOT persisted -- ADR-0038). Runs off the async/UI
/// thread (the probe is two blocking HTTP calls up to the 30s ceiling); the
/// only `Err` is a spawn-blocking join failure -- every preflight verdict
/// (including KeyRejected / KeychainUnavailable / EndpointUnreachable /
/// InvalidEndpoint / Incompatible) is an `Ok(ProfileTestOutcome)`.
#[tauri::command]
pub async fn test_profile(
    live: State<'_, LiveProviderConfig>,
    profile_id: String,
    protocol: Protocol,
    base_url: String,
    model: String,
    key: Option<String>,
) -> Result<ProfileTestOutcome, String> {
    let live = live.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = ProfileId(profile_id);
        // Lazy closure: the keychain read runs only in the fallback arm, so
        // an add-mode probe with an explicit key never touches the keychain
        // at all.
        let key_read = crate::provider::preflight::resolve_probe_key(key.as_deref(), || {
            live.key_for_profile(&id)
        });
        crate::provider::preflight::run(key_read, protocol, &base_url, &model)
    })
    .await
    .map_err(|e| format!("test_profile task failed: {e}"))
}

// --- App-level config (issue #53, ADR-0038) --------------------------------
//
// The second at-rest artifact: preferences, defaults, and the no-key endpoint
// config. Lives in the OS app-data directory, orthogonal to the portable
// `.duck`. Honest-degrades to defaults on any read failure (missing/corrupt ->
// built-in defaults, never a crash). The frontend loads it on startup (theme +
// locale) and persists edits through `set_app_config`.

/// Read the full app-config (ADR-0038). Honest-degrades to built-in defaults on
/// any failure, so the frontend always receives a usable config. On the first
/// launch after the ADR-0038 move, seeds the endpoint section from the legacy
/// keychain blob if one exists (one-time migration inside [`LiveProviderConfig`]).
#[tauri::command]
pub fn get_app_config(live: State<'_, LiveProviderConfig>) -> Result<AppConfig, String> {
    Ok(live.load())
}

/// Persist the full app-config atomically (ADR-0038). Normalizes (empty endpoint
/// -> defaults, threads/window_turns clamped to >=1) so the stored file is always
/// valid, and returns the normalized value that landed on disk. The key never
/// enters app-config -- the [`AppConfig`] model has no key field, and the write
/// path cannot synthesize one.
#[tauri::command]
pub fn set_app_config(
    live: State<'_, LiveProviderConfig>,
    config: AppConfig,
) -> Result<AppConfig, StoreCommandError> {
    live.store(config)
        .map_err(|e| StoreCommandError::ConfigWriteFailure(e.to_string()))
}

/// List every persisted session's metadata for the cold-start left sidebar
/// (ADR-0060/0061/0089). Scans the managed sessions directory for per-session
/// `*/session.duck` recipes (ADR-0089), replacing the former app-config
/// `recent_files` approach. A recipe that is no longer readable is skipped
/// (the listing never fabricates metadata). Runs the per-entry file reads off
/// the async/UI thread (AC8): a cold start over slow or network-mounted
/// storage must not freeze the main window while the sidebar list is being
/// derived.
#[tauri::command]
pub async fn list_sessions(
    sessions_root: State<'_, SessionsRoot>,
) -> Result<Vec<SessionMetadata>, String> {
    let dir = sessions_root.path();
    let list = tauri::async_runtime::spawn_blocking(move || scan_sessions_dir(&dir))
        .await
        .map_err(|e| e.to_string())?;
    Ok(list)
}

/// Delete a persisted session (ADR-0060/0089, issue #81). The frontend closes
/// the session FIRST when it is open (so no canonical-writer key is held and
/// the in-memory instance is gone), then calls this. Removes the entire
/// per-session directory (`{uuid}/` containing `session.duck` + optional
/// `assets/`) so the next `list_sessions` (directory scan) no longer lists it.
/// Irreversible -- the frontend gates it behind a strong confirm.
///
/// A missing directory is NOT an error: the outcome the user wants (the session
/// is gone from the sidebar) already holds, and an idempotent delete tolerates a
/// stray double-call. Any OTHER removal failure (permission denied, path busy)
/// IS surfaced -- swallowing it would betray the strong-confirm contract.
///
/// The canonical-writer gate mirrors `rename_persisted_session`: a held key
/// means an open in-memory session owns this path. The frontend closes first;
/// this is the backend guard for a broken frontend contract. Runs the IO off
/// the async/UI thread (AC8).
#[tauri::command]
pub async fn delete_session(
    sessions_root: State<'_, SessionsRoot>,
    path: String,
) -> Result<(), StoreCommandError> {
    use crate::persistence::{canonicalize_duck, release, try_acquire};
    let trimmed = path.trim().to_string();
    let root = sessions_root.path();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), StoreCommandError> {
        if trimmed.is_empty() {
            return Ok(());
        }
        let path = PathBuf::from(&trimmed);
        // Canonicalize the .duck for the single-writer gate. canonicalize_duck
        // succeeds even when the file itself is gone (it canonicalizes the
        // parent dir and rejoins the file name), so an Err means the parent is
        // gone too -- the session is definitely absent; idempotent success.
        // Log the error so a fabricated success (e.g. permission denied on the
        // parent) is diagnosable instead of silently lost.
        let canonical = match canonicalize_duck(&path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    target: "toptopduck::session",
                    "delete_session: canonicalize_duck failed for {}: {e}",
                    path.display()
                );
                return Ok(());
            }
        };
        // ADR-0089: delete the per-session directory (session.duck + assets/),
        // not just the .duck file. The .duck's parent is `{uuid}/`. Derive from
        // the canonical path (not the raw input) so the starts_with check below
        // matches the also-canonicalized root — on Windows, canonicalize adds
        // the `\\?\` verbatim prefix, and a non-prefixed path would never
        // starts_with a prefixed root (matching export_session's approach).
        let Some(session_dir) = canonical.parent().map(PathBuf::from) else {
            return Err(StoreCommandError::IoFailure(
                "path has no parent directory; cannot locate session dir".into(),
            ));
        };
        // Guard against a path whose parent is not under the managed sessions
        // root (M2). Without this, a malformed or future caller passing
        // `sessions_root/session.duck` would wipe the entire root. Propagate
        // canonicalize errors rather than falling back to the raw root — a
        // non-prefixed fallback would cause starts_with to fail against the
        // canonical session_dir on Windows.
        let canonical_root = std::fs::canonicalize(&root).map_err(|e| {
            StoreCommandError::IoFailure(format!(
                "cannot canonicalize sessions root {}: {e}",
                root.display()
            ))
        })?;
        if !session_dir.starts_with(&canonical_root) {
            return Err(StoreCommandError::IoFailure(format!(
                "session dir {} is not under the managed sessions root {}",
                session_dir.display(),
                canonical_root.display()
            )));
        }
        // Gate: a held canonical key means an open session owns this path.
        if !try_acquire(&canonical) {
            return Err(StoreCommandError::OpenConflict);
        }
        let outcome = match std::fs::remove_dir_all(&session_dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreCommandError::IoFailure(e.to_string())),
        };
        release(&canonical);
        outcome
    })
    .await
    .map_err(|e| StoreCommandError::IoFailure(e.to_string()))?
}

/// Rename the OPEN session bound to `session_id` (ADR-0060, issue #81). Sets the
/// user-facing session_name and rewrites the bound `.duck` recipe header; the
/// bound path is untouched, so sidebar addressing stays stable. Rejects a blank
/// name. Delegates to [`Session::rename`].
#[tauri::command]
pub fn rename_session(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    new_name: String,
) -> Result<String, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.rename(&new_name).map_err(SessionError::RenameSession)
}

/// Read the OPEN session's current display name (ADR-0089 Decision 4). After
/// the first terminal turn auto-names the session, the frontend uses this to
/// refresh the sidebar entry + the session header without re-reading the
/// `.duck` file from disk. Returns the name carried by the in-memory
/// persister (the same value the next atomic write will persist).
#[tauri::command]
pub fn get_session_name(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<String, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    Ok(s.session_name().unwrap_or_default().to_string())
}

/// The cold-rename file operation, extracted so the blank-name short-circuit
/// and gate ordering are unit-testable without a Tauri / async runtime (issue
/// #130). The command wrapper just moves this onto a blocking thread; every
/// behavioral branch -- BlankName before canonicalize, the OpenConflict gate,
/// and `release` on every post-acquire path -- lives here.
fn rename_persisted_session_blocking(path: &Path, new_name: &str) -> Result<(), StoreCommandError> {
    use crate::persistence::{canonicalize_duck, read_duck, release, save_atomic, try_acquire};
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(StoreCommandError::BlankName(RenameSessionError::EmptyName));
    }
    let canonical =
        canonicalize_duck(path).map_err(|e| StoreCommandError::IoFailure(e.to_string()))?;
    // Gate: try_acquire returns false when the canonical path is already
    // held -- an open session owns it. Refuse rather than race its writer.
    if !try_acquire(&canonical) {
        return Err(StoreCommandError::OpenConflict);
    }
    let outcome = (|| -> Result<(), StoreCommandError> {
        let mut recipe =
            read_duck(path).map_err(|e| StoreCommandError::IoFailure(e.to_string()))?;
        recipe.session_name = trimmed.to_string();
        save_atomic(path, &recipe).map_err(|e| StoreCommandError::IoFailure(e.to_string()))
    })();
    release(&canonical);
    outcome
}

/// Rename a CLOSED `.duck` recipe's session_name in place (ADR-0060, issue #81).
/// For a session that is not currently open: read the recipe, rewrite the
/// session_name header, atomic-save -- no DuckDB instance is built. The
/// canonical-writer key doubles as the "is this path open in a running session"
/// gate: a held key means an in-memory writer owns it, so a file-level rename
/// here would race that writer and is refused (the frontend renames open
/// sessions via `rename_session` by id). Runs the file IO off the async/UI
/// thread (AC8), like `list_sessions`.
#[tauri::command]
pub async fn rename_persisted_session(
    path: String,
    new_name: String,
) -> Result<(), StoreCommandError> {
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        rename_persisted_session_blocking(&path, &new_name)
    })
    .await
    .map_err(|e| StoreCommandError::IoFailure(e.to_string()))?
}

// --- Cross-session persistence (issue #48, ADR-0034/0036) -------------------
//
// Save / open a `.duck` recipe document. Save binds the live session to a
// path (every subsequent terminal turn atomically rewrites it). Open resumes
// the session across the restart boundary WITHIN THE SAME session_id
// (ADR-0056: tab <-> sessionId binding is stable; open_duck reuses the id and
// replaces the session's contents, it does NOT mint a new id -- that is
// create_session's job): each source is re-read + fingerprint-verified, the
// productive SQL chain is eagerly re-executed LLM-free, and the conversation
// thread + active pointer are restored. Resume progress is emitted as a
// `resume-progress` Tauri event the frontend renders.

/// Export a copy of the per-session directory to a user-chosen destination
/// (ADR-0089 Decision 5, issue #449). Copies `session.duck` + `assets/` (if
/// any) from the source session directory to `dest_dir`. Does NOT rebind the
/// session, touch the single-writer registry, or modify the original — pure
/// file I/O. Works for both open and closed sessions (path-based, no
/// session_id). Runs the IO off the async/UI thread, like `delete_session`.
#[tauri::command]
pub async fn export_session(
    sessions_root: State<'_, SessionsRoot>,
    duck_path: String,
    dest_dir: String,
) -> Result<(), StoreCommandError> {
    use crate::persistence::canonicalize_duck;
    let root = sessions_root.path();
    let src = PathBuf::from(&duck_path);
    let dest = PathBuf::from(&dest_dir);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), StoreCommandError> {
        // Validate the source is under the managed sessions root (defense-
        // in-depth, matching delete_session's M2 guard). canonicalize_duck
        // succeeds even when the .duck file itself is absent (it canonicalizes
        // the parent dir), so an Err means the parent is inaccessible.
        let canonical_src = canonicalize_duck(&src).map_err(|e| {
            StoreCommandError::IoFailure(format!("cannot resolve source path: {e}"))
        })?;
        let session_dir = canonical_src.parent().ok_or_else(|| {
            StoreCommandError::IoFailure(format!(
                "source duck_path has no parent directory: {}",
                src.display()
            ))
        })?;
        // Propagate canonicalize errors — a non-prefixed fallback would cause
        // starts_with to fail against the canonical session_dir on Windows
        // (matching delete_session's approach).
        let canonical_root = std::fs::canonicalize(&root).map_err(|e| {
            StoreCommandError::IoFailure(format!(
                "cannot canonicalize sessions root {}: {e}",
                root.display()
            ))
        })?;
        if !session_dir.starts_with(&canonical_root) {
            return Err(StoreCommandError::IoFailure(
                "source is not under the managed sessions root".into(),
            ));
        }
        export_session_files(&canonical_src, session_dir, &dest)
    })
    .await
    .map_err(|e| StoreCommandError::IoFailure(e.to_string()))?
}

/// Set the managed sessions directory (issue #452, ADR-0089 Decision 2).
/// Validates the path exists + is writable, persists to app-config via RMW
/// under the app-config write-lock, and updates the in-memory
/// `SessionsRoot` live — no restart needed. New sessions land in the new
/// directory immediately; already-open sessions stay in place (their bound
/// `duck_path` is unchanged). The sidebar re-scans the new directory on the
/// frontend's next `list_sessions` call. Returns the updated `AppConfig`.
///
/// `path = None` clears the override (falls back to the computed default).
/// The frontend always sends `Some(path)` (there is no reset button — the
/// user can navigate to the default path via the directory picker instead),
/// but the IPC contract accepts `None` for completeness.
#[tauri::command]
pub async fn set_sessions_dir(
    app_handle: tauri::AppHandle,
    live: State<'_, LiveProviderConfig>,
    sessions_root: State<'_, SessionsRoot>,
    path: Option<String>,
) -> Result<AppConfig, StoreCommandError> {
    let normalized = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());

    let new_root = match &normalized {
        Some(p) => {
            let dir = PathBuf::from(p);
            validate_sessions_dir(&dir).map_err(StoreCommandError::IoFailure)?;
            dir
        }
        None => default_sessions_root(&app_handle),
    };

    let cfg = live
        .set_sessions_dir(normalized)
        .map_err(|e| StoreCommandError::ConfigWriteFailure(e.to_string()))?;
    sessions_root.set(new_root);
    Ok(cfg)
}

/// Read the current managed sessions directory (issue #452). Returns the
/// resolved path string the frontend displays + uses for `revealItemInDir`
/// and the directory-picker's `defaultPath`. Always non-null — the root is
/// always resolved (to a default or a user-chosen path) at setup.
#[tauri::command]
pub fn get_sessions_dir(sessions_root: State<'_, SessionsRoot>) -> Result<String, String> {
    Ok(sessions_root.path().to_string_lossy().into_owned())
}

/// Core export logic (issue #449). Copies `session.duck` + `assets/` from the
/// per-session directory to `dest`. Refuses if `dest` already exists
/// (typed `DestinationExists`). Uses `create_dir` (not `create_dir_all`) so
/// a race-created leaf fails rather than being silently merged. On any copy
/// failure after `dest` is created, cleans up `dest` and logs if cleanup
/// itself fails (so a partial export is never silently left behind).
fn export_session_files(
    src_duck: &Path,
    session_dir: &Path,
    dest: &Path,
) -> Result<(), StoreCommandError> {
    // Refuse if destination already exists (prevent data loss).
    if dest.exists() {
        return Err(StoreCommandError::DestinationExists(format!(
            "{}",
            dest.display()
        )));
    }

    // Create the destination directory (create_dir, not create_dir_all: the
    // leaf must not exist; the parent is expected to exist from the save
    // dialog. This closes the TOCTOU window between the exists() check above
    // and directory creation).
    std::fs::create_dir(dest).map_err(|e| {
        StoreCommandError::IoFailure(format!("failed to create destination directory: {e}"))
    })?;

    // Copy session.duck (the recipe).
    std::fs::copy(src_duck, dest.join("session.duck")).map_err(|e| {
        cleanup_export_dest(dest);
        StoreCommandError::IoFailure(format!("failed to copy session.duck: {e}"))
    })?;

    // Copy assets/ if it exists (derived sources, ADR-0087 D2).
    let src_assets = session_dir.join("assets");
    if src_assets.is_dir() {
        copy_dir_all(&src_assets, &dest.join("assets")).map_err(|e| {
            cleanup_export_dest(dest);
            StoreCommandError::IoFailure(format!("failed to copy assets directory: {e}"))
        })?;
    }

    Ok(())
}

/// Core import logic (issue #450). Copies an external `.duck` into the
/// destination per-session directory as `session.duck` (fixed name, ADR-0089
/// D3), then copies a companion `assets/` directory if one exists alongside
/// the external `.duck`. The original file is never modified.
fn import_session_files(src_duck: &Path, dest_dir: &Path) -> std::io::Result<()> {
    // Refuse symlinks (defense-in-depth, matching copy_dir_all's hardening
    // from #449 c6e63fe). A symlinked .duck pointing outside the source
    // directory could exfiltrate arbitrary files (e.g. ~/.ssh/id_rsa) into
    // the managed sessions tree.
    let meta = std::fs::symlink_metadata(src_duck)?;
    if meta.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("refusing to follow symlink: {}", src_duck.display()),
        ));
    }
    std::fs::create_dir_all(dest_dir)?;
    std::fs::copy(src_duck, dest_dir.join("session.duck"))?;
    // Copy companion assets/ if present (issue #450 AC#2). Detects a sibling
    // `assets/` directory next to the external .duck — covers per-session
    // directory exports (#449) and ADR-0089 native structure. Old-style
    // `{stem}.assets/` flat format is intentionally not detected (resume
    // surfaces those as Missing → interactive re-link).
    if let Some(parent) = src_duck.parent() {
        let src_assets = parent.join("assets");
        // Use symlink_metadata (not is_dir, which follows symlinks) to reject
        // a symlinked assets/ directory — otherwise `assets -> /etc` would be
        // traversed and every regular file inside copied into the sessions
        // tree (same exfiltration threat as the .duck symlink check above).
        let assets_meta = std::fs::symlink_metadata(&src_assets);
        if let Ok(m) = assets_meta {
            if m.file_type().is_symlink() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("refusing to follow symlink: {}", src_assets.display()),
                ));
            }
            if m.is_dir() {
                copy_dir_all(&src_assets, &dest_dir.join("assets"))?;
            }
        }
    }
    Ok(())
}

/// Best-effort cleanup of a partial export destination. Logs a warning if the
/// cleanup itself fails so the user is not silently left with a partial tree
/// (commands.rs:884 / 1714 / 2254 precedent for best-effort + log::warn).
fn cleanup_export_dest(dest: &Path) {
    if let Err(cleanup_err) = std::fs::remove_dir_all(dest) {
        log::warn!(
            target: "toptopduck::session",
            "export cleanup failed (partial export may remain at {}): {}",
            dest.display(),
            cleanup_err,
        );
    }
}

/// Recursively copy a directory tree (issue #449). Uses `symlink_metadata`
/// (does NOT follow symlinks) and refuses symlinks outright — a symlink in
/// `assets/` pointing outside the session directory could exfiltrate
/// arbitrary files (e.g. `~/.ssh/id_rsa`) into the export destination.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&src_path)?;
        if meta.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "refusing to follow symlink in assets/: {}",
                    src_path.display()
                ),
            ));
        }
        if meta.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

/// Best-effort removal of the orphaned empty per-session directory left when
/// `open_duck` rebinds a session from the `create_session`-generated path to
/// the resume target (ADR-0089 Decision 6 parity for the open path, matching
/// `close_and_cleanup_empty` for the close path).
///
/// Guards (all best-effort — a failure logs a warning and the caller's resume
/// continues):
/// - `was_empty`: skip if the stale session carried any content (data-loss
///   guard — a non-empty session's directory must survive a rebind).
/// - Path equality: skip if the stale binding resolves to the same path as the
///   resume target (prevents deleting the directory the resume target lives
///   in). Uses direct `==` then `canonicalize` fallback for Windows path-
///   format differences (separator case, `\\?\` prefix, `..` components). If
///   either `canonicalize` fails, equality is indeterminate — skip cleanup
///   rather than risk deleting an equivalent path's parent.
/// - `starts_with(sessions_root)`: skip if the stale directory is outside the
///   managed sessions root (defense-in-depth, matches `delete_session`'s M2
///   guard at `commands.rs:1377-1395` — an external `.duck` rebind must never
///   trigger deletion of a user-chosen parent directory).
fn cleanup_orphaned_session_dir(
    stale_duck: Option<&Path>,
    resume_target: &Path,
    was_empty: bool,
    sessions_root: &Path,
) {
    let Some(stale) = stale_duck else {
        return;
    };
    if !was_empty {
        return;
    }
    // Path equality — prevents self-deletion of the resume target's parent.
    if stale == resume_target {
        return;
    }
    match (
        std::fs::canonicalize(stale),
        std::fs::canonicalize(resume_target),
    ) {
        (Ok(a), Ok(b)) if a == b => return,
        (Err(e), _) | (_, Err(e)) => {
            log::warn!(
                target: "toptopduck::session",
                "cleanup_orphaned_session_dir: cannot canonicalize for equality check, \
                 skipping: {e}",
            );
            return;
        }
        _ => {}
    }
    let Some(stale_dir) = stale.parent() else {
        log::warn!(
            target: "toptopduck::session",
            "cleanup_orphaned_session_dir: stale duck_path has no parent, skipping: {}",
            stale.display(),
        );
        return;
    };
    // Canonicalize both sides for starts_with — on Windows, canonicalize adds
    // the `\\?\` verbatim prefix, and a non-prefixed path would never
    // starts_with a prefixed root (matching delete_session's approach).
    let stale_dir_canonical = match std::fs::canonicalize(stale_dir) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!(
                target: "toptopduck::session",
                "cleanup_orphaned_session_dir: cannot canonicalize stale_dir, skipping: {e}",
            );
            return;
        }
    };
    let root_canonical = match std::fs::canonicalize(sessions_root) {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                target: "toptopduck::session",
                "cleanup_orphaned_session_dir: cannot canonicalize sessions_root, skipping: {e}",
            );
            return;
        }
    };
    if !stale_dir_canonical.starts_with(&root_canonical) {
        log::warn!(
            target: "toptopduck::session",
            "cleanup_orphaned_session_dir: stale_dir {} is not under sessions_root {}, \
             skipping",
            stale_dir.display(),
            sessions_root.display(),
        );
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(stale_dir) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                target: "toptopduck::session",
                "cleanup_orphaned_session_dir: failed to remove orphaned session dir {}: {e}",
                stale_dir.display(),
            );
        }
    }
}

/// Open a `.duck` and resume the named session across the restart boundary
/// (ADR-0034/0056). Runs off the async/UI thread (AC8): resume re-reads every
/// source and re-executes the productive SQL chain, which can take seconds.
/// Progress is emitted as a `resume-progress` event per source verification
/// and per replayed turn (ADR-0034 visible progress). On success the session's
/// CONTENTS are replaced with the resumed ones (ADR-0056: the SAME session_id
/// is reused -- tab <-> id binding is stable; open does NOT create a new
/// session). The resumed session inherits the handle's cancel token + closing
/// flag, so a `cancel` / `close_session` during or after resume still reaches
/// the right session.
#[tauri::command]
pub async fn open_duck(
    app: tauri::AppHandle,
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    sessions_root: State<'_, SessionsRoot>,
    skills_root: State<'_, SkillsRoot>,
    session_id: String,
    path: String,
) -> Result<(), SessionError> {
    // Addressing failures (invalid id / unknown session / resuming) stay typed
    // as SessionError variants; the resume-domain failure rides SessionError::
    // Resume (issue #120) -- both stay serde-structured across IPC.
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    // Symmetric with `ask` (which applies the same guard before entering a
    // turn): refuse resume while a turn is in flight. A turn blocked in the
    // approval gate still holds session_lock, so without this guard
    // open_duck's spawn_blocking would block on session_lock with resuming
    // latched, freezing every mutating command via reject_if_resuming until
    // the turn is respond/cancel unstuck. The frontend `busy` flag is the
    // primary defense; this is the Rust-side backstop for a second window /
    // IPC replay / automation that triggers resume during an approval-pending
    // turn.
    reject_if_in_flight(&handle)?;
    handle.set_resuming(true);
    let path = PathBuf::from(path);
    // Pull the handle's shared tokens out via accessors (the fields
    // are private). The resumed session reuses the SAME cancel token + closing
    // flag so a close/cancel during or after resume reaches it; the closing
    // flag is monotonic (ClosingFlag), so re-attaching it cannot weaken the
    // once-closing invariant.
    let cancel_token = handle.cancel_token();
    let closing_flag = handle.closing_flag();
    let handle_for_task = Arc::clone(&handle);
    // The resumed session reuses the SAME provider wiring as a fresh session
    // (ADR-0007/0064): a LiveProvider router that dispatches to the anthropic
    // or openai adapter based on the active profile's protocol, reading the
    // key from the OS keychain and the endpoint from app-config (ADR-0038),
    // via the shared LiveProviderConfig. Resume itself is LLM-free (it
    // re-executes stored SQL), but the next new turn after resume must reach a
    // live provider -- so the provider is wired at open time, not deferred.
    let provider = Box::new(crate::LiveProvider::new(live.inner().clone()));
    let app_for_cb = app.clone();
    let sid = id.clone();
    let sessions_root_path = sessions_root.path();
    // ADR-0102 Decision 1/4 (issue #589): resume restores the session's LAST
    // runtime (segment continuation) instead of resetting to the default. The
    // default resolution is still computed here BEFORE the swap closure (the
    // State handle must not cross into the 'static blocking task; the
    // resolved spec is plain data) -- it is the fallback for a pre-#589
    // recipe whose header carries no `last_runtime` (the ADR-0098 Decision 2
    // semantics, unchanged for old files).
    let startup = startup_runtime_choice(live.inner());
    // One config read feeds both the session-level engine-defaults snapshot
    // (issue #741: same source as create_session, resolved BEFORE the
    // blocking task -- the State handle must not cross into the 'static
    // closure; the snapshot is plain data) and the auto-include fold below.
    let cfg = live.load();
    let engine_defaults = cfg.engine.clone();
    // Auto-include recomputed at resume (issue #677, ADR-0109 Decision 6):
    // a tool disabled since the session last ran drops its skill from the
    // initial set; the recipe's own Mount/Unmount events still fold over
    // the initial set, so an explicit in-session unmount keeps winning. The
    // materialized gate (the side-table mark, mirroring the creation path)
    // keeps a reverse-conflict user file out.
    let auto_skills = crate::skills::builtin::auto_included_names(
        &live.cli_tools(),
        &crate::skills::BuiltinSkillMark::from_config(&cfg),
        &skills_root.0,
    );
    let inner = tauri::async_runtime::spawn_blocking(move || {
        let mut new_session = Session::open_duck(
            &path,
            cancel_token,
            provider,
            engine_defaults,
            |ev: ResumeEvent| {
                // ADR-0056 (issue #76): address the resume-progress event by
                // sessionId so a multi-session frontend filters the global
                // broadcast to the one SessionPane that owns the resume. v1
                // emitted a bare ResumeEvent -- a single-session legacy.
                let _ = app_for_cb.emit(
                    "resume-progress",
                    &ResumeProgress {
                        session_id: sid.clone(),
                        event: ev,
                    },
                );
            },
            // Issue #49 honest-degrade callbacks: the engine surfaces Missing
            // / Unreadable / Drift / ActiveAbandoned decisions to the caller.
            // The re-link / continuation UI is deferred to a follow-up of
            // #49 (not yet scheduled -- the engine + test seam land in this
            // slice, the frontend dialogs do not) -- until then any issue
            // aborts resume (matching the prior all-or-nothing behavior). The
            // engine never silently picks, so the typed ResumeError::Aborted
            // surfaces to the user as "resume stopped" rather than a guess.
            |_| crate::SourceResolution::Abort,
            |_| crate::ActiveResolution::Abort,
        )
        .map_err(SessionError::Resume)?;
        // Re-attach the handle's closing flag so a close_session after resume
        // still discards in-flight turns on this session (ADR-0055). The cancel
        // token was already shared via cancel_token above. The flag is the
        // monotonic ClosingFlag, so this re-attach preserves once-closing.
        new_session.set_closing_flag(closing_flag);
        // ADR-0063: re-arm the close-and-wait-release drop signal for the
        // resumed session. Install a fresh (sender, receiver) pair: the sender
        // goes into the NEW session (its Drop will fire it after the canonical
        // key release), the receiver replaces the handle's stale slot. The OLD
        // session's sender (still in the pre-swap Session) fires into a closed
        // receiver once `*s = new_session` lands -- a harmless no-op. Ordering
        // matters: install the new receiver on the handle BEFORE the swap so
        // a concurrent close-wait never observes a None slot. close-wait does
        // NOT call reject_if_resuming (close is terminal, not a mutating
        // command -- the pure close variant does not either); the frontend's
        // `busy` flag is the primary defense, and this ordering is the
        // Rust-side backstop for races the frontend cannot see (a second
        // window, an IPC replay).
        let (drop_tx, drop_rx) = std::sync::mpsc::channel();
        new_session.set_drop_signal(drop_tx);
        handle_for_task.set_drop_signal_rx(drop_rx);
        // ADR-0095 Decision 6: capture the resumed Session's recipe-header
        // runtime facts BEFORE the swap consumes new_session (the Session's
        // accessor borrows it). Restored onto the handle after the reset
        // batch below so the model / thought-level selections + the discovery
        // cache survive the resume (unlike the reset-to-default postures).
        let runtime_facts = new_session.runtime_facts().clone();
        let mut s = handle_for_task.session_lock()?;
        // Capture the pre-resume binding before the rebind. create_session
        // bound a fresh empty session.duck in a new per-session directory;
        // open_duck rebinds the session to `path` (the resume target),
        // orphaning that directory. Without cleanup, list_sessions surfaces a
        // phantom empty sidebar entry that multiplies on each click.
        let stale_duck = s.duck_path().map(|p| p.to_path_buf());
        let stale_was_empty = s.is_timeline_empty();
        *s = new_session;
        s.seed_initial_skills(auto_skills.clone());
        // Release the session lock before filesystem cleanup.
        drop(s);
        // The resumed postures in one batch: the security-plane resets
        // (approval + MCP enablement) fire first, then the execution-plane
        // restore -- the runtime continuation + the ADR-0095 posture trio,
        // restored after the resets so the restored values win. Extracted
        // into `apply_resumed_postures` so the wiring is testable without
        // an AppHandle.
        apply_resumed_postures(&handle_for_task, runtime_facts, startup, |spec| {
            detect_adapter(spec).is_some()
        });
        // Remove the orphaned empty per-session directory create_session made
        // when open_duck rebinds to a different resume target path. The old
        // Session::Drop (fired by the `*s = new_session` assignment above)
        // already released the canonical single-writer key, so remove_dir_all
        // cannot race a writer. Best-effort: a failure logs a warning (the
        // orphan is a cosmetic sidebar issue, not a correctness problem).
        cleanup_orphaned_session_dir(
            stale_duck.as_deref(),
            &path,
            stale_was_empty,
            &sessions_root_path,
        );
        Ok::<(), SessionError>(())
    })
    .await;
    // Clear the per-session resume flag on EVERY exit (success, resume error,
    // join panic) before propagating -- a stuck flag would reject every later
    // mutating command on this session (ADR-0053).
    handle.set_resuming(false);
    inner.map_err(|e| SessionError::Engine(e.to_string()))??;
    Ok(())
}

/// Read + clear the named session's most recent per-turn persistence failure,
/// if any (ADR-0034/0035 honest signal). The frontend polls this after each
/// turn / source event / resume: a non-blocking unsaved-to-disk banner surfaces
/// the disk-vs-memory drift so the user knows a save dropped (instead of
/// relying on the next successful write to silently self-heal, which would mask
/// the window where closing the app loses the unsaved turns). Returns the typed
/// [`SaveError`] (issue #120) so the frontend narrows on `kind` and renders a
/// locale message; `None` after a clean save or after a prior read cleared the
/// failure. The outer [`SessionError`] is the addressing failure (invalid id /
/// unknown session / lock poison) -- distinct from the persist error itself.
#[tauri::command]
pub fn take_persist_error(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Option<SaveError>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let mut s = handle.session_lock()?;
    Ok(s.take_persist_error())
}

/// Read + clear the named session's pending external-change conflict, if any
/// (ADR-0035 Decision 3 / issue #50). The frontend polls this after each turn /
/// source event / resume: a non-`None` value means the auto-write was
/// suspended because the `.duck` file's on-disk hash diverged from the
/// session's baseline (another window, a text editor, or a sync tool edited
/// the file). The frontend surfaces a three-option conflict UI (reload / keep
/// mine / save as new); the engine NEVER silently clobbers the externally-edited
/// file. Returns `None` when no conflict is pending or after a prior read
/// cleared it.
#[tauri::command]
pub fn take_pending_conflict(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Option<crate::PendingConflict>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let mut s = handle.session_lock()?;
    Ok(s.take_pending_conflict())
}

// --- Tiered tool approval (ADR-0080, issue #294) -------------------------
//
// The IPC contract for the in-flow approval card (ADR-0083): one command for
// the user's answer, two for the authorization-mode selector, two for
// inspecting / revoking session trust, and the `approval-request` /
// `approval-resolved` events emitted by [`TauriApprovalSink`]. The frontend
// rendering (pending/resolved trace entries, three-button card, unanswered
// badge) lands in #297 / #298; the auth-mode selector UI lands in #302. This
// slice owns the wire contract + the gateway mechanism only.

/// Tauri-backed [`ApprovalSink`] (ADR-0083). Built at the command boundary
/// (where the `AppHandle` lives, ADR-0029) with the session id baked in; the
/// agent loop (#295) and the external-tool bridge (#299) construct one per
/// turn and pass it to [`crate::approval::ApprovalState::gate`].
///
/// `session_id` is closed over (not derived per event) so the gate -- which
/// does not know its own session id -- emits events addressed correctly for a
/// multi-session frontend to filter (ADR-0056, mirroring the `turn-progress`
/// callback's `sid.clone()`).
pub struct TauriApprovalSink {
    app: tauri::AppHandle,
    session_id: SessionId,
}

impl TauriApprovalSink {
    pub fn new(app: tauri::AppHandle, session_id: SessionId) -> Self {
        Self { app, session_id }
    }
}

impl ApprovalSink for TauriApprovalSink {
    fn emit_request(&self, body: &ApprovalRequestBody) {
        // Best-effort UI delivery like `turn-progress`: a frontend that is
        // not yet listening (the card UI is #297) drops the event. Unlike
        // turn-progress, approval-request is a BLOCKING synchronous signal --
        // the turn stays suspended on the gate condvar until respond / cancel
        // wakes it -- so log the drop so a listener-less build is diagnosable
        // rather than hanging silently.
        if let Err(e) = self.app.emit(
            "approval-request",
            &crate::approval::ApprovalRequestPayload {
                session_id: self.session_id.clone(),
                request_id: body.request_id.clone(),
                server: body.server.clone(),
                tool: body.tool.clone(),
                operation_kind: body.operation_kind,
                summary: body.summary.clone(),
                file_attachments: body.file_attachments.clone(),
            },
        ) {
            log::warn!(
                target: "approval",
                "approval-request emit failed (session {}); turn stays suspended until respond/cancel: {}",
                self.session_id,
                e,
            );
        }
    }

    fn emit_resolved(&self, body: &ApprovalRequestBody, response: ApprovalResponse) {
        // A dropped resolved event leaves a stale pending card in the
        // frontend; the gateway's own state is already advanced, so this is
        // purely a UI reconciliation loss -- log for diagnosability.
        if let Err(e) = self.app.emit(
            "approval-resolved",
            &crate::approval::ApprovalResolvedPayload {
                session_id: self.session_id.clone(),
                request_id: body.request_id.clone(),
                response,
            },
        ) {
            log::warn!(
                target: "approval",
                "approval-resolved emit failed (session {}, request {}); frontend may show a stale pending card: {}",
                self.session_id,
                body.request_id,
                e,
            );
        }
    }
}

/// Answer the session's in-flight approval request (ADR-0083 three-button
/// card). The request id is the one carried by the `approval-request` event
/// the frontend received; the response is `allow_once` / `always_allow` /
/// `deny`. `always_allow` escalates the `server::tool` to session-level trust
/// (resume resets it). A respond that lands after the turn was cancelled, or a
/// duplicate answer, rejects with a [`SessionError::Engine`] carrying the
/// `Debug` representation of the underlying `RespondError` (the frontend
/// reconciles via the `approval-resolved` event rather than branching on this
/// string).
#[tauri::command]
pub fn respond_tool_approval(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    request_id: String,
    response: ApprovalResponse,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let request_uuid = uuid::Uuid::parse_str(&request_id)
        .map_err(|_| SessionError::Engine("approval request id malformed".into()))?;
    let approval = handle.approval_state();
    approval
        .respond(request_uuid, response)
        .map_err(|e| SessionError::Engine(format!("{e:?}")))?;
    Ok(())
}

/// Read the session's authorization posture (ADR-0080 Decision 4):
/// `per_call` (default) or `no_confirmation`. Session-level; resumes as
/// `per_call`. Drives the composer auth-mode selector (#302) + the warning
/// color while in no-confirmation mode.
#[tauri::command]
pub fn get_authorization_mode(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<AuthMode, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    Ok(handle.approval_state().auth_mode())
}

/// Switch the session's authorization posture (ADR-0080 Decision 4). Only
/// `per_call` <-> `no_confirmation` is accepted; both resume to `per_call`.
/// Rejected while resuming (the session contents are mid-swap).
#[tauri::command]
pub fn set_authorization_mode(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    mode: AuthMode,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    handle.approval_state().set_auth_mode(mode);
    Ok(())
}

/// Snapshot the session's "always allow" trust set (ADR-0080 Decision 3),
/// keyed by `server::tool`. Each entry is one tool the user escalated to
/// session-level trust via an `always_allow` answer. Resumes empty.
#[tauri::command]
pub fn list_session_trust(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Vec<ToolKey>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    Ok(handle.approval_state().trust_list())
}

/// Revoke one tool's session-level trust (ADR-0080 Decision 3). The next call
/// to that tool re-enters per-call confirmation. Rejected while resuming.
#[tauri::command]
pub fn revoke_session_trust(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    server: String,
    tool: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    handle.approval_state().revoke(&ToolKey { server, tool });
    Ok(())
}

// --- Runtime selector (issue #353, ADR-0076/0081/0083) ----------------------
//
// The composer runtime picker's IPC surface: the v1 adapter table with live
// PATH-scan detection (list / rescan) + the per-session runtime choice
// (get / set). The choice rides the SessionHandle (lock-light); `ask` mirrors
// it into the Session at turn top, so a switch takes effect exactly at the
// turn boundary. Adding a CLI never touches this surface -- the adapter table
// is the pure-data `v1_adapters()` projection (ADR-0081 zero per-CLI code).

/// The session's runtime selection for the next turn (issue #353, ADR-0076/
/// 0081/0083), in wire form. Adjacently tagged like the rest of the wire
/// contract: `{"kind":"built_in"}` for the built-in BYOK loop (the default),
/// `{"kind":"external","data":"<id>"}` for one external ACP CLI whose id
/// resolves against [`v1_adapters`]. The `kind` values are snake_case to
/// match the auth-mode chip's IPC enum (`AuthMode`); the `content` key is the
/// repo's generic `"data"` (consistent with every other tagged enum here).
/// The frontend mirrors the shape in `src/types/runtime.ts`; the wire
/// literals are pinned in `tests/ipc_contract.rs`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
#[serde(rename_all = "snake_case")]
pub enum SessionRuntimeChoice {
    /// The built-in BYOK Rust agent loop (ADR-0081) -- the honest default.
    BuiltIn,
    /// The external ACP engine driving the named adapter id (ADR-0085).
    External(String),
}

/// One v1 adapter projected for the composer runtime picker (issue #353,
/// ADR-0083) and the settings adapter panel (issue #489): the stable id (the
/// `set_session_runtime` key), the display name (the row label), the current
/// PATH-scan detection state, and the resolved binary path (shown in the
/// settings panel when detected). Detected rows are selectable; undetected
/// rows render disabled + "not installed" -- the picker never hardcodes the
/// list, it renders this table verbatim.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AdapterEntry {
    /// The adapter's stable id (provenance + set key; [`AdapterSpec::id`]).
    pub id: String,
    /// Human-readable picker label ([`AdapterSpec::display_name`]).
    pub display_name: String,
    /// Whether the PATH scan resolved one of the adapter's binary names.
    pub detected: bool,
    /// The absolute path of the resolved binary (`None` when not detected).
    /// Surfaced to the settings adapter panel so the user can verify WHICH
    /// binary was found (issue #489).
    #[serde(default)]
    pub binary_path: Option<PathBuf>,
    /// The adapter's stream format (ADR-0095): the composer's model /
    /// thought-level selectors render per format -- ACP adapters get
    /// dropdowns fed by handshake discovery; the non-ACP formats
    /// (CodexEventStream / ClaudeStreamJson) get probe-cache-fed per-model
    /// dropdowns once tested, read-only CLI-default labels before.
    /// `#[serde(default)]` so an older payload omitting the field degrades
    /// to the ACP surface.
    #[serde(default)]
    pub stream_format: StreamFormat,
}

/// Project every v1 adapter to a picker entry with a FRESH PATH-scan
/// detection state (ADR-0083). Detection is deliberately uncached -- the
/// composer re-scans on demand (the user may install a CLI between scans) --
/// so `list_adapters` and `rescan_adapters` share this one projection.
fn scan_adapters() -> Vec<AdapterEntry> {
    v1_adapters()
        .iter()
        .map(|spec| {
            let binary = detect_adapter(spec);
            AdapterEntry {
                id: spec.id.as_str().to_string(),
                display_name: spec.display_name.to_string(),
                detected: binary.is_some(),
                binary_path: binary,
                stream_format: spec.stream_format,
            }
        })
        .collect()
}

/// Resolve a wire adapter id to its v1 [`AdapterSpec`]. Unknown ids resolve
/// to `None` and the command boundary rejects them -- the frontend only ever
/// offers ids that `list_adapters` returned, so an unknown id is a stale /
/// buggy client, not a user mistake.
fn resolve_adapter(id: &str) -> Option<AdapterSpec> {
    v1_adapters()
        .iter()
        .find(|spec| spec.id.as_str() == id)
        .cloned()
}

/// Map the handle's storage form (`None` = built-in) onto the wire choice.
fn runtime_choice_to_wire(spec: Option<AdapterSpec>) -> SessionRuntimeChoice {
    match spec {
        None => SessionRuntimeChoice::BuiltIn,
        Some(spec) => SessionRuntimeChoice::External(spec.id.as_str().to_string()),
    }
}

/// Resolve a wire choice onto the handle's storage form. An unknown external
/// adapter id rejects with the English technical detail (the frontend renders
/// its resync path off the reject, ADR-0052 -- the wording never crosses IPC
/// as user-facing text).
fn resolve_runtime_choice(
    runtime: SessionRuntimeChoice,
) -> Result<Option<AdapterSpec>, SessionError> {
    Ok(match runtime {
        SessionRuntimeChoice::BuiltIn => None,
        SessionRuntimeChoice::External(adapter_id) => {
            Some(resolve_adapter(&adapter_id).ok_or_else(|| {
                SessionError::Engine(format!("unknown adapter id `{adapter_id}`"))
            })?)
        }
    })
}

/// List every v1 adapter with its live detection state (issue #353, AC:
/// expose `list_adapters` with detection to the frontend). Session-AGNOSTIC:
/// the adapter table + the PATH scan are process-global, not per-session.
/// Read-only -- cannot refuse. The composer runtime picker renders this
/// verbatim; adding a CLI upstream (`v1_adapters()`) grows the list with
/// zero frontend change.
#[tauri::command]
pub fn list_adapters() -> Vec<AdapterEntry> {
    scan_adapters()
}

/// Re-run the adapter PATH scan on demand (issue #353, AC: rescan IPC) -- the
/// composer's ↻ entry. Detection is uncached, so this is the same projection
/// as [`list_adapters`], exposed as its own command so the user-driven
/// re-detect is an explicit wire action (and a future cached scan has the
/// invalidation seam already).
#[tauri::command]
pub fn rescan_adapters() -> Vec<AdapterEntry> {
    scan_adapters()
}

/// Run the adapter diagnostic probe (ADR-0096, issues #534/#535): a session-
/// agnostic, one-shot spawn of the detected CLI in its probe mode -> a
/// per-format catalog query -> terminate. ACP adapters run the initialize +
/// `session/new` handshake; CodexEventStream adapters (codex) run the
/// `app-server` `model/list` query; ClaudeStreamJson adapters (claude-code)
/// run the stream-json control-plane `initialize` read (ADR-0097 Decision
/// 5). The catalog result caches to the app-data sidecar (ADR-0096 D5).
///
/// Async + deadline-bounded, the `probe_mcp_server` layering (issue #392):
/// the child is spawned in the async scope so the `Child` handle stays OUT
/// of the `spawn_blocking` closure (blocking tasks are not cancellable --
/// this is the only way to guarantee a hung CLI is reaped after the
/// timeout), the blocking query runs under `spawn_blocking`, and the wall
/// clock is [`PROBE_TIMEOUT`] (45s: generous for node-CLI cold starts, still
/// bounded for a hung one). Every exit path kills + reaps the child.
///
/// Refusals are typed ([`ProbeError`], a `kind`-tagged enum disjoint from
/// every other typed IPC error): unknown id / not currently detected reject
/// before any spawn; spawn + query failures carry the English technical
/// detail for the fold. A codex `model/list` RPC error is NOT a refusal -- it
/// degrades to a [`ProbeOk::CodexEventStream`] carrying `Unavailable`
/// (ADR-0096 D2); a claude-code control-plane error response degrades to a
/// [`ProbeOk::ClaudeStreamJson`] carrying `Unavailable`, and a silent /
/// EOF-ing claude child degrades to an EMPTY catalog (ADR-0097 Decision 5).
#[tauri::command]
pub async fn probe_adapter(
    catalog_store: State<'_, AdapterCatalogStore>,
    adapter_id: String,
) -> Result<crate::runtime::acp::probe::ProbeOk, crate::runtime::acp::probe::ProbeError> {
    use crate::runtime::acp::probe::{self, ProbeError, PROBE_TIMEOUT};

    let spec = resolve_adapter(&adapter_id);
    // Fresh detection, never the frontend's possibly-stale table state. An
    // unknown id (None) is a stale / buggy client (the settings tab only
    // offers `list_adapters` ids) -- same refusal shape as a vanished
    // binary, not a separate channel.
    let binary = spec.as_ref().and_then(detect_adapter);
    let (spec, binary) = match (spec, binary) {
        (Some(spec), Some(binary)) => (spec, binary),
        (Some(spec), None) => return Err(ProbeError::NotDetected(spec.id.to_string())),
        (None, _) => return Err(ProbeError::NotDetected(adapter_id)),
    };
    // The one shared spawn point (the per-format probe argv on the spec), with
    // the Child handle staying in the async scope (blocking tasks are not
    // cancellable, so the handle must stay outside them for the kill-on-timeout).
    let mut child = probe::spawn_child(&spec, Some(&binary))?;
    let (stdin, stdout, stderr_tail) = child.take_pipes();
    // The stderr tail travels with the blocking query (issue #542): the CLI's
    // own diagnosis lands in the failure detail, not the packaged app's
    // absent console. A clone stays in the async scope for the outer-timeout
    // path (see below).
    let timeout_tail = stderr_tail.clone();
    // ADR-0096 D2: dispatch the per-format query on the spec's stream format,
    // never the CLI's identity (zero per-CLI code).
    let join = tauri::async_runtime::spawn_blocking(move || match spec.stream_format {
        StreamFormat::Acp => {
            probe::handshake_with(stdin, stdout, stderr_tail, &spec, PROBE_TIMEOUT)
                .map(|discovered| probe::ProbeOk::Acp { discovered })
        }
        StreamFormat::CodexEventStream => crate::runtime::acp::app_server::query_catalog(
            stdin,
            stdout,
            stderr_tail,
            PROBE_TIMEOUT,
        )
        .map(|outcome| probe::ProbeOk::CodexEventStream { outcome }),
        StreamFormat::ClaudeStreamJson => crate::runtime::acp::claude_control::query_catalog(
            stdin,
            stdout,
            stderr_tail,
            PROBE_TIMEOUT,
        )
        .map(|outcome| probe::ProbeOk::ClaudeStreamJson { outcome }),
    });
    let outcome = tokio::time::timeout(PROBE_TIMEOUT, join).await;
    // A tokio timeout surfaces as ProbeError::Timeout; the blocking task
    // itself resolves (or lingers on a blocked read until the kill's EOF
    // wakes it) -- either way the child is dead before we return.
    let (result, outer_timeout) = match outcome {
        Ok(Ok(r)) => (r, false),
        Ok(Err(join_err)) => (
            Err(ProbeError::HandshakeFailure(format!(
                "probe task failed: {join_err}"
            ))),
            false,
        ),
        Err(_) => (Err(ProbeError::Timeout), true),
    };
    child.kill_and_wait();
    // The outer timeout drops the join, so the blocking task's
    // `attach_stderr_tail` never runs -- log the clone's tail here, after the
    // kill (the kill's EOF drains the pipe's final bytes into the reader).
    // Inner-timeout races are left to the blocking task's own log.
    if outer_timeout {
        timeout_tail.log_tail("probe timed out");
    }
    // Cache the catalog on success (ADR-0096 D5, issue #536): the probe
    // click is the cache's ONLY write point, overwriting just this
    // adapter's entry. Only a usable catalog caches -- the per-model
    // degraded state (`Unavailable`) keeps the last good entry. Write
    // failures are swallowed inside `store_entry` (the cache never gates
    // the probe's own answer); the write happens after the kill so the
    // child is always dead first, timeout path included.
    if let Ok(ok) = &result {
        if let Some((probe_kind, outcome)) = CachedOutcome::from_probe(ok) {
            catalog_store.store_entry(
                &adapter_id,
                AdapterCatalogEntry {
                    probe_kind,
                    outcome,
                    probed_at_millis: now_millis(),
                },
            );
        }
    }
    result
}

/// Read the adapter catalog cache (ADR-0096 D5/D6, issue #536): the
/// settings tab's "last tested" display and the composer picker's
/// global-cache fallback. Lock-light -- reads the sidecar file with no
/// process-wide lock held and never touches any session lock, so a call
/// during an in-flight turn never blocks. Honest-degrade: a missing or
/// corrupt file reads as empty (the consumer renders its empty state);
/// never refuses.
#[tauri::command]
pub fn get_adapter_catalogs(catalog_store: State<'_, AdapterCatalogStore>) -> AdapterCatalogs {
    catalog_store.load()
}

/// Read the session's runtime selection (issue #353). Lock-light: reads the
/// handle's choice, never the session lock an in-flight turn holds. Returns
/// the startup default for a fresh session; a resumed session returns the
/// restored last runtime (ADR-0102) -- degraded to the built-in start when
/// the recorded adapter is not detected, or the resolved default when the
/// recipe predates the field.
#[tauri::command]
pub fn get_session_runtime(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<SessionRuntimeChoice, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    Ok(runtime_choice_to_wire(handle.runtime_choice()))
}

/// Set the session's runtime selection (issue #353, AC: a switch takes effect
/// at the turn boundary). The choice lands on the handle (lock-light, never
/// blocks on an in-flight turn); `ask` mirrors it into the Session at the NEXT
/// turn top, so the switch takes effect exactly at the turn boundary --
/// the in-flight turn, if any, finishes on the runtime it started on. The
/// switch also opens a new segment, so the model-posture slot re-seeds from
/// the target adapter's backfill entry (ADR-0102 Decision 3, issue #590 --
/// [`apply_runtime_switch`]); the same handle-only write carries it into the
/// Session at the next turn top. Selecting an unknown adapter
/// id rejects (the picker only offers `list_adapters` ids). Rejected while
/// resuming (the session contents are mid-swap).
#[tauri::command]
pub fn set_session_runtime(
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    session_id: String,
    runtime: SessionRuntimeChoice,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let spec = resolve_runtime_choice(runtime)?;
    apply_runtime_switch(&handle, spec, live.inner());
    Ok(())
}

/// Seat an in-session runtime switch on the handle (ADR-0102 Decision 3,
/// issue #590): the runtime choice + the new segment's seeded posture, one
/// handle-only step. A switch opens a new segment whose posture slot starts
/// from the TARGET adapter's backfill entry ([`segment_start_posture`] --
/// external := the adapter's `last_model_postures` entry, absent =
/// unselected; built-in := empty, the built-in loop consumes no posture), so
/// a stale model id held under the OLD adapter's namespace never injects
/// into the new CLI, and a switch back to a previously used adapter
/// recovers its held selection. The runtime choice + the seeded posture land
/// under the ONE slot lock (issue #600 folded the two former slot mutexes):
/// every reader (the `ask` mirror, the set command) takes the same lock, so
/// no reader can observe the new runtime paired with the old posture -- a
/// torn pair would inject the stale id into the new CLI for one turn and
/// persist into the recipe. Handle-only (lock-light): the pair reaches the Session
/// -- and the recipe -- at the NEXT turn top via the same `ask` mirror that
/// lands the runtime choice, so the switch never blocks on an in-flight
/// turn. Resume never lands here: it restores the session's own persisted
/// pair (segment continuation, issue #589), never the backfill map.
fn apply_runtime_switch(
    handle: &SessionHandle,
    spec: Option<AdapterSpec>,
    live: &LiveProviderConfig,
) {
    let posture = session_posture(segment_start_posture(spec.as_ref(), live));
    handle.set_runtime_and_posture(spec, posture);
}

// --- Default runtime + startup resolution (ADR-0098 Decision 2/3, #569) -----

/// Resolve the app-config `default_runtime` (ADR-0098 Decision 2/3, issue
/// #569) onto the session-handle storage form (`None` = built-in) for ONE
/// startup -- a fresh session's creation or a pre-#589 recipe's resume
/// fallback (a recorded `last_runtime` continues otherwise).
/// `BuiltIn` passes through as `None`. `External(id)` resolves the id
/// against the v1 adapter table and degrades to `None` when the adapter is
/// unknown or not detected -- never to another detected adapter (the user
/// picked a specific CLI, not "some external runtime"). Detection is
/// INJECTED so the pure resolution stays PATH-scan-free for tests; the
/// command path ([`startup_runtime_choice`]) injects the same fresh
/// `detect_adapter` scan the picker's `scan_adapters` uses (the ADR-0092
/// "an undetected runtime is unselectable" signal, applied at startup). The
/// config field is NEVER rewritten by resolution: a degraded start is
/// per-startup only, so an environment restore (reinstall) auto re-enables
/// the external start with no re-configuration. Each degrade leaves a
/// diagnostic log line (warn for an out-of-table id, info for an
/// undetected adapter) so a "starts built-in despite my default" report
/// has something to look at in the log dir.
fn resolve_default_runtime(
    default: &DefaultRuntime,
    detected: impl Fn(&AdapterSpec) -> bool,
) -> Option<AdapterSpec> {
    match default {
        DefaultRuntime::BuiltIn => None,
        DefaultRuntime::External(id) => {
            let Some(spec) = resolve_adapter(id) else {
                // Only a hand-edited config reaches here (set_default_runtime
                // rejects unknown ids), so warn on the config anomaly.
                log::warn!(
                    "default_runtime names an adapter outside the v1 table ({id}); \
                     degrading this start to the built-in runtime"
                );
                return None;
            };
            if !detected(&spec) {
                // The specced common case (ADR-0098 Decision 3): the CLI is
                // not installed right now. Info, not warn -- the degrade is
                // per-startup and the field is kept for the environment's
                // return.
                log::info!(
                    "default_runtime names {id}, which is not currently detected; \
                     degrading this start to the built-in runtime (field kept)"
                );
                return None;
            }
            Some(spec)
        }
    }
}

/// The command-path resolution: an honest-degrade app-config read
/// (lock-light -- [`LiveProviderConfig::load`] takes no lock) + a fresh PATH
/// scan per candidate adapter. Shared by `create_session` and `open_duck` so
/// both startup points apply ONE degrade rule.
fn startup_runtime_choice(live: &LiveProviderConfig) -> Option<AdapterSpec> {
    resolve_default_runtime(&live.load().default_runtime, |spec| {
        detect_adapter(spec).is_some()
    })
}

/// Resolve the recipe-header `last_runtime` into the resumed session's
/// runtime choice (ADR-0102 Decision 1/4, issue #589). Segment continuation:
/// the session's own last runtime wins over the machine-level default. A
/// pre-#589 recipe (`None`) falls back to the caller's RESOLVED default
/// runtime (the ADR-0098 Decision 2 semantics); an adapter that is not
/// currently detected degrades THIS resume to the built-in start (mirroring
/// [`resolve_default_runtime`]'s rule) while the persisted value survives on
/// the recipe header -- a re-detected CLI is honored by the next resume.
fn resume_runtime_choice(
    last: Option<&LastRuntime>,
    default: Option<AdapterSpec>,
    detected: impl Fn(&AdapterSpec) -> bool,
) -> Option<AdapterSpec> {
    match last {
        // Pre-#589 recipe: no recorded runtime -- the old default-runtime
        // resolution applies unchanged.
        None => default,
        Some(LastRuntime::BuiltIn) => None,
        Some(LastRuntime::External(id)) => {
            let Some(spec) = resolve_adapter(id) else {
                // Only a hand-edited recipe reaches here (the stamp records a
                // v1-table id), so warn on the anomaly. The field is kept on
                // disk -- resolution degrades, never rewrites.
                log::warn!(
                    "recipe last_runtime names an adapter outside the v1 table ({id}); \
                     degrading this resume to the built-in runtime"
                );
                return None;
            };
            if !detected(&spec) {
                // The specced common case (ADR-0102 Decision 4): the CLI is
                // not installed right now. Info, not warn -- the degrade is
                // per-resume and the persisted value is kept for the
                // environment's return.
                log::info!(
                    "recipe last_runtime names {id}, which is not currently detected; \
                     degrading this resume to the built-in runtime (persisted value kept)"
                );
                return None;
            }
            Some(spec)
        }
    }
}

/// Apply the resumed session's postures to the handle after the swap
/// (`open_duck`). The whole reset + restore batch in one free function so
/// the command-layer wiring is testable without an AppHandle: the
/// security-plane resets fire first, then the execution-plane continuation,
/// then the ADR-0095 trio -- restored last so the restored values win.
/// `detected` is the same PATH-scan-free seam [`resume_runtime_choice`]
/// injects.
fn apply_resumed_postures(
    handle: &SessionHandle,
    runtime_facts: SessionRuntimeFacts,
    startup: Option<AdapterSpec>,
    detected: impl Fn(&AdapterSpec) -> bool,
) {
    // ADR-0080 (issue #294): resume zeroes trust. Trust state is
    // session-level and must not survive a resume (it is not in the recipe /
    // app-config), so the moment the resumed contents are live, drop the
    // authorization mode + trust set back to the default PerCall posture.
    // Reset is independent of the session rebind -- the approval state lives
    // on the handle, not inside the Session mutex.
    handle.reset_approval();
    // ADR-0102 Decision 2 (issue #589): the runtime choice is
    // execution-plane session state, so the resume continues the session's
    // OWN last runtime (unlike the approval reset above, the
    // security-plane posture). A pre-#589 recipe without `last_runtime`
    // keeps the old semantics (the resolved default runtime); an undetected
    // adapter degrades THIS resume to the built-in start while the persisted
    // value survives on the Session's recipe-header facts -- restored inside
    // `Session::open_duck`, whose phase-5 rewrite already re-emitted it
    // unchanged, so a re-detected CLI is honored by the next resume.
    handle.set_runtime_choice(resume_runtime_choice(
        runtime_facts.last_runtime.as_ref(),
        startup,
        detected,
    ));
    // ADR-0095 Decision 6: restore the model config AFTER the reset batch
    // (the restored values win over any stale pre-resume state).
    handle.restore_runtime_model_config(
        PosturePair {
            model: runtime_facts.model,
            thought_level: runtime_facts.thought_level,
        },
        runtime_facts.cached_discovered,
    );
}

/// Set the default runtime new sessions start on (ADR-0098 Decision 2, issue
/// #569; since ADR-0102 a resume continues the session's own last runtime
/// instead -- the default stays the fallback for a pre-#589 recipe whose
/// header carries no `last_runtime`). Returns the updated AppConfig so the
/// frontend syncs state
/// without a re-fetch (same shape as `set_sessions_dir`). Lock-light: the
/// only serialization is the config write lock inside the read-modify-write.
/// An `External` id must name a v1 adapter -- the settings control only
/// offers `list_adapters` ids, so an unknown id is a stale / buggy client,
/// not a user mistake. The check is a picker contract, NOT a model
/// invariant: `set_app_config` full-document writes intentionally skip it
/// (the config outlives any one build's adapter table), and startup
/// resolution covers an out-of-table id by degrading. The adapter does NOT
/// need to be detected: ADR-0098 Decision 3 declines write-time validation
/// so an absent environment (CLI uninstalled) never destroys the
/// preference; the startup resolution degrades per-start instead.
#[tauri::command]
pub fn set_default_runtime(
    live: State<'_, LiveProviderConfig>,
    runtime: DefaultRuntime,
) -> Result<AppConfig, StoreCommandError> {
    if let DefaultRuntime::External(id) = &runtime {
        if resolve_adapter(id).is_none() {
            return Err(StoreCommandError::UnknownAdapter(id.clone()));
        }
    }
    live.set_default_runtime(runtime)
        .map_err(|e| StoreCommandError::ConfigWriteFailure(e.to_string()))
}

// --- Startup model posture backfill (ADR-0100, issue #581) ------------------

/// The segment-start model posture (ADR-0100 Decision 1, extended to
/// in-session switches by ADR-0102 Decision 3, issues #581/#590): the
/// adapter's backfill entry, or the empty posture when the start is
/// built-in (or degraded to it) -- unselected, the CLI's own
/// defaults. Serves both segment starts: a fresh session's creation
/// (`create_session`) and an in-session runtime switch
/// ([`apply_runtime_switch`]); resume restores the session's own pair and
/// never reads this. Lock-light: one honest-degrade config read.
fn segment_start_posture(target: Option<&AdapterSpec>, live: &LiveProviderConfig) -> ModelPosture {
    match target {
        None => ModelPosture::default(),
        Some(spec) => live.last_model_posture(spec.id.as_str()),
    }
}

/// Convert the app-config posture (the backfill map's value shape) onto the
/// session-local pair (the handle slot / Session storage shape): the
/// boundary conversion lives here because `session_store` deliberately
/// imports no app-config types -- the two shapes are structurally identical
/// but never aliased.
fn session_posture(p: ModelPosture) -> PosturePair {
    PosturePair {
        model: p.model,
        thought_level: p.thought_level,
    }
}

/// Seat the resolved startup posture on a fresh session (ADR-0100 Decision 1,
/// issue #581): the pair lands on BOTH slots at once -- the handle-held slot
/// the lock-light reads serve and the Session storage the recipe persists.
/// Called before the initial `bind_duck`, so the first recipe already carries
/// the posture: without the Session-side half the injection would reach the
/// recipe only at the first turn top (the `ask` mirror), and a restart
/// before then would resume the session unselected even though the backfill
/// entry exists (ADR-0095 Decision 6 keeps only what the recipe holds).
/// Unconditional: the empty posture rewrites the same (None, None) a fresh
/// session starts with, so an absent / cleared entry keeps the session
/// unselected without a guard.
fn apply_startup_posture(
    handle: &SessionHandle,
    posture: &PosturePair,
) -> Result<(), SessionError> {
    handle.set_external_model_config(posture.clone());
    let mut s = handle.session_lock()?;
    s.set_external_model_config(posture.clone());
    Ok(())
}

/// Read one adapter's backfill posture entry (ADR-0100, issue #581): the
/// startup model / thought-level a NEW session on that adapter starts with.
/// The cold-start composer bar seeds its pending posture from this entry.
/// Lock-light honest-degrade read; no entry (or a cleared one) reads as the
/// empty posture -- this command never refuses.
#[tauri::command]
pub fn get_last_model_posture(
    live: State<'_, LiveProviderConfig>,
    adapter_id: String,
) -> ModelPosture {
    live.last_model_posture(&adapter_id)
}

/// Clear one adapter's backfill posture (ADR-0100 Decision 3, issue #581):
/// the posture cascade's "default (recommended)" row -- the NEXT new session
/// on that adapter starts unselected again, so the backfill never makes an
/// explicit clear pointless. The `adapter_id` must name a v1 adapter (the
/// picker contract, the same table-membership check as `set_default_runtime`);
/// detection is NOT required -- an installed-but-absent CLI's entry is exactly
/// the dangling case the ADR keeps. Returns the updated AppConfig so the
/// frontend syncs state without a re-fetch (same shape as
/// `set_default_runtime`).
#[tauri::command]
pub fn clear_last_model_posture(
    live: State<'_, LiveProviderConfig>,
    adapter_id: String,
) -> Result<AppConfig, StoreCommandError> {
    if resolve_adapter(&adapter_id).is_none() {
        return Err(StoreCommandError::UnknownAdapter(adapter_id));
    }
    live.set_last_model_posture(&adapter_id, ModelPosture::default())
        .map_err(|e| StoreCommandError::ConfigWriteFailure(e.to_string()))
}

// --- External-runtime model + thought level (ADR-0095, issue #527) ---------

/// The wire read shape for the session's external-runtime model config: the
/// two selections plus the cached discovered catalog. Mirrors the
/// handle-held trio; serialized camelCase-free (plain snake_case field names
/// via serde default) so the frontend type is a direct mirror.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionModelConfig {
    pub model: Option<String>,
    pub thought_level: Option<String>,
    pub cached_discovered: Option<DiscoveredRuntime>,
}

/// The persist-now verdict a successful set command carries back (issue
/// #529): read in-process, in the same critical section as the set, so the
/// selection's own persist outcome cannot be mis-attributed or swallowed
/// (no post-hoc shared-slot read racing the session banner poll).
/// `persist_error` is the typed [`SaveError`] of a failed write;
/// `persist_suspended` is true when the write was withheld because an
/// ADR-0035 pending conflict (externally modified .duck) suspends the
/// auto-write. Both None/false = the write landed (or the session is
/// unbound, in-memory-only, nothing to persist).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SetPosturePersistOutcome {
    pub persist_error: Option<SaveError>,
    pub persist_suspended: bool,
}

/// Project the Session's non-consuming persist snapshot (issue #529) onto
/// the wire verdict: Err = a typed write failure, Ok(false) = suspended on
/// a pending ADR-0035 conflict, Ok(true) = landed (or unbound).
fn persist_outcome(s: &crate::session::Session) -> SetPosturePersistOutcome {
    match s.persist_outcome() {
        Err(e) => SetPosturePersistOutcome {
            persist_error: Some(e),
            persist_suspended: false,
        },
        Ok(false) => SetPosturePersistOutcome {
            persist_error: None,
            persist_suspended: true,
        },
        Ok(true) => SetPosturePersistOutcome {
            persist_error: None,
            persist_suspended: false,
        },
    }
}

/// Read the session's external-runtime model config (ADR-0095). Lock-light:
/// reads the handle's own mutexes, never the session lock an in-flight turn
/// holds. `cached_discovered` is `None` until the first ACP turn (and is
/// restored from the recipe on resume). After an in-session runtime switch
/// it may still carry the PREVIOUS adapter's catalog -- retained by design
/// until the new runtime's first turn replaces it; the picker discriminates
/// it via `DiscoveredRuntime.adapter_id` (issue #529 provenance).
#[tauri::command]
pub fn get_session_model_config(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<SessionModelConfig, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    // The pair read takes the slot lock once: a concurrent set lands entirely
    // before or after this read, never as a torn (old, new) mix.
    let posture = handle.external_model_config();
    Ok(SessionModelConfig {
        model: posture.model,
        thought_level: posture.thought_level,
        cached_discovered: handle.cached_discovered(),
    })
}

/// Set the session's model + thought-level selections for the next
/// external-runtime turn (ADR-0095; a single full-pair command since issue
/// #603). The pair crosses as ONE struct argument (`PosturePair`, issue
/// #606) -- field-keyed, so the transposition protection holds at this
/// boundary too. The wire IS the complete posture: every field is an
/// explicit intent value -- `None` is the user's explicit clear (the CLI's
/// own default) and an untouched field arrives as its current value -- so
/// the backend never derives off the held slot (two concurrent sets cannot
/// interleave a read-modify-write; the #600 conditional write-back keeps
/// guarding the set-vs-switch direction). Takes effect at the next turn
/// boundary. The model id is NOT validated against the discovered catalog
/// at this boundary (ADR-0095 Decision 7): the picker only offers
/// discovered ids, so an unknown id means a stale cache or a manual call --
/// the CLI deals with it at spawn.
///
/// Persistence: the selection is mirrored into the Session's recipe-header
/// facts + persisted immediately, so a close-without-another-turn keeps the
/// resume promise (Decision 6). The same persist-now batch stamps the
/// handle's runtime choice into `last_runtime` (ADR-0102 Decision 1, the
/// last effective segment header) -- the persisted pair always travels under
/// its own runtime, so a switch followed by a selection and a close
/// without a turn resumes on the runtime the pair belongs to. Rejected
/// with a typed error while resuming or while a turn is in flight (the
/// same `reject_if_*` guards every other session-mutating command has);
/// on pass, the session lock is taken only briefly for the small atomic
/// write.
///
/// Backfill (ADR-0100 Decision 3, issue #581): a successful set also lands
/// the new pair on the session's runtime adapter's app-config entry (the
/// single write point shared with the cold-start pre-selection) via
/// [`record_last_model_posture`] -- best-effort, never fails this command.
/// The runtime choice comes off the ONE slot read (issue #600): the header
/// stamp, the write-back guard, and the backfill entry all key off that
/// atomic read, so a concurrent switch can never interleave between them
/// and pair this set's posture with the other runtime's namespace. The
/// handle write-back that follows is conditional on the runtime being
/// unchanged, so a switch landing mid-set keeps its own seeded pair.
///
/// Returns the persist-now verdict (issue #529): the write failure or the
/// ADR-0035 suspension read in-process right after the persist, so the
/// picker can warn without a second IPC racing the banner poll.
#[tauri::command]
pub fn set_session_posture(
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    session_id: String,
    posture: PosturePair,
) -> Result<SetPosturePersistOutcome, SessionError> {
    let handle = store.get(&SessionId::parse(&session_id)?)?;
    apply_posture_set(&handle, live.inner(), posture)
}

/// The set command's body (issue #600, single full-pair command since
/// #603): guards, then ONE atomic slot read -- the runtime choice and the
/// held pair off the single handle slot, so a concurrent switch can never
/// interleave between the two and pair this set's write with the other
/// runtime's seed -- then the session-side pair write + segment-header
/// stamp + persist-now batch, the CONDITIONAL handle slot write (dropped
/// when a switch re-seeded the slot since the read), and the adapter
/// backfill entry. The submitted pair is the COMPLETE posture: every field
/// lands verbatim, never mixed with the slot's held value.
fn apply_posture_set(
    handle: &SessionHandle,
    live: &LiveProviderConfig,
    posture: PosturePair,
) -> Result<SetPosturePersistOutcome, SessionError> {
    reject_if_resuming(handle)?;
    reject_if_in_flight(handle)?;
    // One atomic slot read: the runtime and the held pair are one unit (the
    // pair is namespaced by the runtime it was selected under). Every
    // runtime consumer below keys off THIS read -- the segment-header
    // stamp, the conditional write-back guard's expected runtime, and the
    // backfill entry's namespace -- so the set's writes always land under
    // the runtime it was read on. The held pair itself never feeds the
    // write: the pair comes whole off the wire (issue #603), unmixed with
    // the slot's held value.
    let (runtime, _) = handle.runtime_and_posture();
    let mut s = handle.session_lock()?;
    s.set_external_model_config(posture.clone());
    // Segment-header stamp (ADR-0102 Decision 1): same batch as the pair +
    // the persist below.
    s.stamp_last_runtime(runtime.clone());
    // Persist now (via the shared auto-write path) so a selection made
    // without a following turn survives a close (ADR-0095 Decision 6).
    s.persist_if_bound();
    // Snapshot the persist verdict BEFORE releasing the lock (issue #529):
    // in-process, non-consuming -- the banner's take_persist_error channel
    // is untouched.
    let outcome = persist_outcome(&s);
    // The handle write-back is conditional: a switch landing between the
    // atomic read above and this write has already re-seeded the slot with
    // the target adapter's posture -- dropping the stale-namespace write
    // keeps the slot on the switch's segment (the #590 seeding semantics).
    handle.set_posture_if_runtime(&runtime, posture.clone());
    // ADR-0100 Decision 3 (issue #581): record the post-set pair as the
    // adapter's startup backfill entry (the single write point shared with
    // the cold-start pre-selection) -- best-effort, never fails the set.
    record_last_model_posture(live, runtime, posture);
    Ok(outcome)
}

/// The single backfill write point (ADR-0100 Decision 3, issue #581): every
/// successful posture set lands the new pair on the session's runtime
/// adapter's app-config entry, so a session-level selection and the
/// cold-start pre-selection (which reaches the set IPC right after session
/// creation) share one writer. A built-in session has no adapter namespace
/// to record under -- the posture is a no-op there (ADR-0095) -- so the write
/// is skipped, not refused. Best-effort: the session posture itself already
/// landed and was persisted per its own verdict, so a config-write failure
/// only costs the NEXT startup's convenience injection -- warn, never fail
/// the set.
fn record_last_model_posture(
    live: &LiveProviderConfig,
    runtime: Option<AdapterSpec>,
    posture: PosturePair,
) {
    let Some(spec) = runtime else {
        return;
    };
    if let Err(e) = live.set_last_model_posture(
        spec.id.as_str(),
        ModelPosture {
            model: posture.model,
            thought_level: posture.thought_level,
        },
    ) {
        log::warn!(
            target: "toptopduck::session",
            "failed to persist the {} model-posture backfill entry: {e}",
            spec.id
        );
    }
}

// --- Skills registry (issue #362, ADR-0086) ---------------------------------
//
// CRUD over the Agent Skills registry under `<app_data_dir>/skills`.
// Session-AGNOSTIC: the registry is process-global (one root shared by every
// session), addressed through the managed [`SkillsRoot`] state. The directory
// scan IS the registry (no sidecar, no app-config entry); a directory is a
// skill iff it holds a spec-valid `SKILL.md`. Rejects are the typed
// [`SkillError`] (adjacently tagged like every other typed IPC error) so the
// frontend renders each refusal through the locale catalog (ADR-0052).

/// List every spec-valid skill in the registry plus the directories the scan
/// skipped (issue #362 / #373). Skipped directories carry the English technical
/// reason so the settings UI can surface WHY a directory disappeared; the
/// spec-valid `skills` list keeps its sorted semantics. A never-created
/// registry lists empty. Read-only -- cannot refuse.
#[tauri::command]
pub fn list_skills(
    root: State<'_, SkillsRoot>,
    live: State<'_, LiveProviderConfig>,
) -> SkillListing {
    // The builtin mark comes from the app-config side table so a
    // materialized builtin skill reads `acquired: builtin` while a user's
    // pre-existing same-named skill keeps its own source (issue #677).
    let mark = crate::skills::BuiltinSkillMark::from_config(&live.load());
    crate::skills::registry::list_skills(&root.0, &mark)
}

/// Mint a new `local` skill (issue #362): `<root>/<name>/SKILL.md` with the
/// given description + the skeleton body. The name must be spec-shaped
/// (kebab-case, <= 64) and free; the registry root is minted lazily on first
/// create. Returns the entry read back from disk.
#[tauri::command]
pub fn create_skill(
    root: State<'_, SkillsRoot>,
    name: String,
    description: String,
) -> Result<SkillEntry, SkillError> {
    crate::skills::registry::create_skill(&root.0, &name, &description)
}

/// Rewrite one `local` skill's `SKILL.md` (frontmatter + body) atomically
/// (issue #362). `name` addresses the current directory; `update.name` is the
/// identity to write -- a different value renames the directory. Refuses a
/// `linked` skill (read-only), an unknown skill, and a taken rename target.
#[tauri::command]
pub fn update_skill(
    root: State<'_, SkillsRoot>,
    live: State<'_, LiveProviderConfig>,
    name: String,
    update: SkillUpdate,
) -> Result<SkillEntry, SkillError> {
    let mark = crate::skills::BuiltinSkillMark::from_config(&live.load());
    crate::skills::registry::update_skill(&root.0, &mark, &name, update)
}

/// Delete a skill from the registry (issue #362). A `local` skill's directory
/// is removed with all its contents; a `linked` skill's LINK is removed
/// without touching the external source directory.
#[tauri::command]
pub fn delete_skill(
    root: State<'_, SkillsRoot>,
    live: State<'_, LiveProviderConfig>,
    name: String,
) -> Result<(), SkillError> {
    let mark = crate::skills::BuiltinSkillMark::from_config(&live.load());
    crate::skills::registry::delete_skill(&root.0, &mark, &name)
}

/// Restore one builtin skill's SKILL.md to the shipped baseline (issue #677,
/// ADR-0109 Decision 5): the file is rewritten at the CURRENT locale and the
/// side table re-recorded (future version upgrades follow again). Refuses
/// anything that is not a materialized builtin skill. Returns the updated
/// full config (the ADR-0109 Decision 9 sync contract -- commit wholesale,
/// no re-fetch).
#[tauri::command]
pub fn restore_builtin_skill(
    live: State<'_, LiveProviderConfig>,
    skills_root: State<'_, SkillsRoot>,
    name: String,
) -> Result<crate::app_config::AppConfig, SkillError> {
    live.restore_builtin_skill(&skills_root.0, &name)
}

/// Discover external skill sources for the import dialog (issue #367,
/// ADR-0086). Resolves the standard agent skill libraries -- Claude Code
/// (`~/.claude/skills`), Codex CLI (`~/.codex/skills`) -- off the Tauri
/// home-dir path, appends the user-supplied `custom_paths` (each an absolute
/// OS path the frontend collected via the directory picker), and projects the
/// union through [`discover_skill_sources`]. A source that does not exist is
/// dropped silently (the "show only if it exists" rule, issue #367); each
/// surviving source's resident skills are classified `importable` / `already_exists` /
/// `invalid` against the CURRENT registry name set (a snapshot taken fresh per
/// call so a create / delete between calls is reflected). Read-only -- never
/// refuses.
#[tauri::command]
pub fn list_skill_sources(
    app: tauri::AppHandle,
    root: State<'_, SkillsRoot>,
    custom_paths: Vec<String>,
) -> Vec<SkillSource> {
    // The existing-name snapshot is read once per call so a create / delete
    // that lands between this call and the subsequent `import_skills` is
    // reflected (import re-checks at commit too -- the snapshot is for the
    // dialog's PREVIEW only, never an authority).
    let existing: std::collections::HashSet<String> =
        crate::skills::registry::list_skills(&root.0, &Default::default())
            .skills
            .iter()
            .map(|s| s.name.clone())
            .collect();
    let candidates = build_skill_source_candidates(&app, &custom_paths);
    discover_skill_sources(&candidates, &existing)
}

/// Import a batch of skills into the registry (issue #367, ADR-0086). Each
/// item is an absolute source directory; `mode` is shared across the batch
/// (the dialog's bottom dropdown). The result parallels the input so a
/// per-item failure never aborts the rest -- the frontend folds each `Failed`
/// through `fmtError` and invalidates the skills query once for the whole
/// batch. Each item is re-validated + name-re-checked at commit time (no
/// cached discovery status crosses the wire).
#[tauri::command]
pub fn import_skills(
    root: State<'_, SkillsRoot>,
    items: Vec<ImportItem>,
    mode: ImportMode,
) -> Vec<ImportOutcome> {
    import_skills_impl(&root.0, &items, mode)
}

/// Build the candidate source list for discovery (issue #367). The two
/// standard agent skill libraries live under the home dir; each `custom_paths`
/// entry is appended as its own candidate (id = path string for stable
/// expand/collapse state across re-discoveries, label = the directory's file
/// name so the row reads naturally). Duplicates are harmless -- discovery
/// filters by existence + the frontend keys off the id.
fn build_skill_source_candidates(
    app: &tauri::AppHandle,
    custom_paths: &[String],
) -> Vec<SkillSourceCandidate> {
    let mut candidates = Vec::new();
    let home = app.path().home_dir().ok();
    if let Some(home) = home.as_deref() {
        candidates.push(SkillSourceCandidate {
            id: "claude-code".into(),
            label: "Claude Code".into(),
            path: home.join(".claude").join("skills"),
        });
        candidates.push(SkillSourceCandidate {
            id: "codex-cli".into(),
            label: "Codex CLI".into(),
            path: home.join(".codex").join("skills"),
        });
        // Codex nests built-in system skills under `~/.codex/skills/.system/`.
        // The parent `skills/` dir holds user-installed skills as direct
        // children; `.system` is a hidden directory that
        // `scan_source_children` skips, so the two tiers surface as independent
        // sources in the import dialog (issue #418).
        candidates.push(SkillSourceCandidate {
            id: "codex-cli-system".into(),
            label: "Codex CLI (system)".into(),
            path: home.join(".codex").join("skills").join(".system"),
        });
    }
    for raw in custom_paths {
        let path = std::path::PathBuf::from(raw);
        let label = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| raw.clone());
        candidates.push(SkillSourceCandidate {
            id: raw.clone(),
            label,
            path,
        });
    }
    candidates
}

// --- Skills mount / unmount (issue #363, ADR-0086) --------------------------
//
// Session-SCOPED skill lifecycle (distinct from the registry CRUD above): the
// backend records each Mount / Unmount on the session timeline + folds the
// active set from the event sequence (no snapshot). The frontend's `loading`
// flag is the primary defense against mounting / unmounting during a turn;
// `reject_if_in_flight` is the Rust-side backstop (a second window / IPC
// replay / automation that triggers mount while an approval-pending turn
// holds the session lock). Rejects are the typed
// [`SkillMountError`](crate::session::skills::SkillMountError) (wrapped in
// [`SessionError::SkillMount`]) so the frontend renders each refusal through
// the locale catalog.

/// Mount a skill into the session's active set (issue #363, ADR-0086). Appends
/// a `Mount` event to the timeline + atomically persists the recipe. Refuses a
/// redundant mount (`AlreadyMounted`) and rejects during resume / an in-flight
/// turn (the loading gate, AC #5). Issue #369 AC#5: after a successful mount,
/// the skill's declared MCP server ids are checked against the globally
/// configured registry -- an id that is not configured is warned + skipped
/// (it contributes nothing to the effective MCP set; the mount itself
/// succeeds because the skill's prompt fragment is independent of its MCP
/// declarations). Issue #674: the declared CLI tool names get the same
/// post-mount warn, against the EFFECTIVE (enabled) CLI set.
#[tauri::command]
pub fn mount_skill(
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    skills_root: State<'_, SkillsRoot>,
    session_id: String,
    name: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    reject_if_in_flight(&handle)?;
    let mut s = handle.session_lock()?;
    s.mount_skill(&name).map_err(SessionError::SkillMount)?;
    // Issue #369 AC#5: warn for declared MCP server ids not in the global
    // registry. The mount already succeeded (the skill is live for prompt
    // injection); the unknown ids are simply skipped in the effective set.
    // Issue #674: same shape for the declared CLI tool names.
    drop(s);
    warn_unknown_mcp_ids(&live, &skills_root.0, &name);
    warn_unknown_cli_names(&live, &skills_root.0, &name);
    Ok(())
}

/// Unmount a skill from the session's active set (issue #363, ADR-0086).
/// Appends an `Unmount` event + atomically persists. Refuses an unmount of a
/// name not in the set (`NotMounted`) and rejects during resume / an in-flight
/// turn (the loading gate, AC #5).
#[tauri::command]
pub fn unmount_skill(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    name: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    reject_if_in_flight(&handle)?;
    let mut s = handle.session_lock()?;
    s.unmount_skill(&name).map_err(SessionError::SkillMount)?;
    Ok(())
}

/// The session's currently-mounted skill names, in first-mount insertion order
/// (issue #363). Read-only; the frontend uses this to render the active-set
/// chip list + drive the mount/unmount button states. The fold over the
/// timeline is the source of truth; this returns the live memoization.
#[tauri::command]
pub fn list_mounted_skills(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Vec<String>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let s = handle.session_lock()?;
    Ok(s.mounted_skills())
}

/// Activate a MOUNTED skill into the session's activated subset (issue #698,
/// ADR-0110 Decision 2). Appends an `Activate` event (carrying the user
/// actor) + atomically persists. A name not in the mounted set is a typed
/// refuse (`NotMountedForActivation`, no event); a repeat activation is
/// idempotent success with no second event (Decision 3). Rejects during
/// resume / an in-flight turn -- the same loading gate as the mount
/// commands. This ticket exposes the channel only; the user-visible
/// affordance rides #699, the agent channel + body-return semantics #701.
#[tauri::command]
pub fn activate_skill(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    name: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    reject_if_in_flight(&handle)?;
    let mut s = handle.session_lock()?;
    // The user channel: the IPC command always records the User actor (the
    // agent channel -- actor Agent -- is the gateway meta-tool, issue #701;
    // both ride the same Session::activate_skill transition).
    s.activate_skill(&name, crate::model::SkillLifecycleActor::User)
        .map_err(SessionError::SkillMount)?;
    Ok(())
}

/// The session's currently-ACTIVATED skill names, in first-activation
/// insertion order (issue #698, ADR-0110). Read-only mirror of
/// [`list_mounted_skills`]'s write/read split; the timeline fold is the
/// source of truth, this returns the live memoization (always a subset of
/// the mounted set).
#[tauri::command]
pub fn list_activated_skills(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Vec<String>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let s = handle.session_lock()?;
    Ok(s.activated_skills())
}

/// Warn for MCP server ids declared by a skill that are not in the globally
/// configured registry (issue #369 AC#5). Called after a successful mount so
/// the user sees immediate feedback; the mount itself is not affected (the
/// skill's prompt fragment is independent of its MCP declarations). An
/// unreadable or missing `SKILL.md` contributes no warning -- the skill still
/// mounted, and the effective set computation naturally excludes unknown ids.
fn warn_unknown_mcp_ids(live: &LiveProviderConfig, root: &Path, skill_name: &str) {
    let fragments = resolve_prompt_fragments(root, &[skill_name.to_string()]);
    let Some(frag) = fragments.into_iter().next() else {
        return;
    };
    if frag.mcp_servers.is_empty() {
        return;
    }
    let configured: HashSet<String> = live.mcp_servers().into_iter().map(|s| s.id.0).collect();
    for id in &frag.mcp_servers {
        if !configured.contains(id) {
            log::warn!(
                target: "toptopduck::mcp",
                "skill `{}` declares MCP server `{}` which is not in the global \
                 registry -- skipping (configure the server in Settings to enable it)",
                skill_name,
                id,
            );
        }
    }
}

/// The declared CLI tool names that are NOT live in the effective CLI set
/// (issue #674): a name dangles when it is unregistered OR
/// registered-but-disabled. Unlike the MCP sibling check (which consults the
/// full registry, so a disabled server is not flagged), this is checked
/// against the ENABLED slice on purpose: ADR-0106 disabled = dormant = no
/// tool-table entry, so a disabled registration is exactly as absent from
/// the model's tool surface as an unregistered name, and the reference warn
/// must cover both states (CONTEXT "技能": the referent must be configured
/// AND enabled to be usable; the reference itself never flips either).
fn dangling_cli_refs(
    referenced: &[String],
    tools: &[crate::cli_tools::config::CliToolConfig],
) -> Vec<String> {
    let effective: HashSet<&str> = tools
        .iter()
        .filter(|tool| tool.enabled)
        .map(|tool| tool.name.as_str())
        .collect();
    referenced
        .iter()
        .filter(|name| !effective.contains(name.as_str()))
        .cloned()
        .collect()
}

/// Warn for CLI tool names declared by a skill that are neither registered
/// nor enabled (issue #674) -- the `warn_unknown_mcp_ids` sibling. Called
/// after a successful mount; the mount itself is not affected (declarative
/// metadata only -- a reference never configures or enables anything). An
/// unreadable or missing `SKILL.md` contributes no warning.
fn warn_unknown_cli_names(live: &LiveProviderConfig, root: &Path, skill_name: &str) {
    let fragments = resolve_prompt_fragments(root, &[skill_name.to_string()]);
    let Some(frag) = fragments.into_iter().next() else {
        return;
    };
    if frag.cli_tools.is_empty() {
        return;
    }
    let effective = live.enabled_cli_tools();
    for name in dangling_cli_refs(&frag.cli_tools, &effective) {
        log::warn!(
            target: "toptopduck::cli_tools",
            "skill `{skill_name}` references CLI tool `{name}` which is not \
             registered or enabled -- the tool stays absent (register/enable \
             it in Settings to make it available)",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::UNKNOWN_SESSION;
    use crate::CancelToken;

    // --- skill CLI tool references (issue #674, ADR-0108 Decision 7) -------

    /// A minimal CliToolConfig for the dangling-reference tests: only `name`
    /// and `enabled` matter to [`dangling_cli_refs`].
    fn cli_tool(name: &str, enabled: bool) -> crate::cli_tools::config::CliToolConfig {
        crate::cli_tools::config::CliToolConfig {
            name: name.to_string(),
            description: "does a thing".to_string(),
            executable: "/bin/tool".to_string(),
            argv_template: Vec::new(),
            params: Vec::new(),
            env: Default::default(),
            enabled,
            source: Default::default(),
            baseline: None,
        }
    }

    #[test]
    fn dangling_cli_refs_flags_missing_and_disabled_but_not_enabled() {
        let tools = vec![cli_tool("my-pandoc", true), cli_tool("my-office", false)];
        let referenced = vec![
            "my-pandoc".to_string(),
            "my-office".to_string(),
            "ghost-tool".to_string(),
        ];
        let dangling = dangling_cli_refs(&referenced, &tools);
        // Enabled: live on the tool surface -- not dangling.
        assert!(!dangling.contains(&"my-pandoc".to_string()));
        // Registered but disabled: dormant (ADR-0106) -- dangles exactly like
        // the unregistered name; both states must warn (issue #674 AC).
        assert!(dangling.contains(&"my-office".to_string()));
        assert!(dangling.contains(&"ghost-tool".to_string()));
        assert_eq!(dangling.len(), 2);
    }

    #[test]
    fn warn_unknown_cli_names_consults_the_real_enabled_slice() {
        // Pins the seam `warn_unknown_cli_names` reads: the dangling judgment
        // must consult the ENABLED slice of a real `LiveProviderConfig`
        // (`live.enabled_cli_tools()`), not the full registry -- swapping in
        // `live.cli_tools()` (the MCP sibling's shape) would silently stop
        // flagging disabled tools while every hand-built-input pin above stays
        // green.
        let cfg_dir = tempfile::tempdir().expect("config tempdir");
        let live = LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore::new(),
            cfg_dir.path().join("config.json"),
        );
        live.upsert_cli_tool(cli_tool("my-pandoc", true))
            .expect("upsert 1");
        live.upsert_cli_tool(cli_tool("my-office", false))
            .expect("upsert 2");

        let skills = tempfile::tempdir().expect("skills tempdir");
        let root = skills.path();
        std::fs::create_dir_all(root.join("doc-writer")).unwrap();
        std::fs::write(
            root.join("doc-writer").join("SKILL.md"),
            "---\nname: doc-writer\ndescription: Test skill.\nmetadata:\n  \
             toptopduck_cli_tools: my-pandoc, my-office\n---\nBody.\n",
        )
        .unwrap();

        // The exact reads `warn_unknown_cli_names` performs after a mount.
        let frag = resolve_prompt_fragments(root, &["doc-writer".to_string()])
            .into_iter()
            .next()
            .expect("fragment");
        assert_eq!(frag.cli_tools.len(), 2, "frontmatter parsed both refs");
        let dangling = dangling_cli_refs(&frag.cli_tools, &live.enabled_cli_tools());
        assert_eq!(
            dangling,
            vec!["my-office".to_string()],
            "registered-but-disabled dangles through the real enabled slice"
        );
    }

    // --- default runtime startup resolution (issue #569, ADR-0098 D2/D3) ----

    /// A detected-fn keyed by adapter id: the pure-seam stand-in for the PATH
    /// scan, so the resolution tests never touch process-global state.
    fn detected_ids<'a>(ids: &'a [&'a str]) -> impl Fn(&AdapterSpec) -> bool + 'a {
        move |spec| ids.contains(&spec.id.as_str())
    }

    #[test]
    fn default_runtime_built_in_resolves_to_none() {
        // The fresh-install default keeps the pre-#569 start: built-in (None
        // on the handle). The detected signal is irrelevant for BuiltIn.
        assert_eq!(
            resolve_default_runtime(&DefaultRuntime::BuiltIn, detected_ids(&["gemini-cli"])),
            None
        );
    }

    #[test]
    fn default_runtime_detected_external_resolves_to_that_cli() {
        // A default naming a DETECTED adapter starts every session on that
        // exact CLI (issue #569 AC2).
        let spec = resolve_default_runtime(
            &DefaultRuntime::External("gemini-cli".into()),
            detected_ids(&["gemini-cli"]),
        )
        .expect("detected default resolves external");
        assert_eq!(spec.id.as_str(), "gemini-cli");
    }

    #[test]
    fn default_runtime_undetected_degrades_field_effective_again_on_reprobe() {
        // AC3/AC4: an undetected default degrades this start to built-in;
        // re-detection (the environment restored) makes the very same config
        // value resolve external again -- the field was never rewritten.
        let default = DefaultRuntime::External("gemini-cli".into());
        assert_eq!(
            resolve_default_runtime(&default, detected_ids(&[])),
            None,
            "undetected default degrades to built-in for this start"
        );
        let spec = resolve_default_runtime(&default, detected_ids(&["gemini-cli"]))
            .expect("re-detected default resolves external again");
        assert_eq!(spec.id.as_str(), "gemini-cli");
    }

    #[test]
    fn default_runtime_never_resolves_to_a_different_detected_cli() {
        // AC4: the default names a SPECIFIC CLI -- a missing one degrades to
        // built-in, never silently to another detected adapter (here codex is
        // detected but the default names gemini-cli).
        assert_eq!(
            resolve_default_runtime(
                &DefaultRuntime::External("gemini-cli".into()),
                detected_ids(&["codex"])
            ),
            None
        );
        // An id outside the v1 table (hand-edited config) degrades the same
        // way -- resolution is total, the config field stays as written.
        assert_eq!(
            resolve_default_runtime(
                &DefaultRuntime::External("no-such-cli".into()),
                detected_ids(&["gemini-cli", "codex"])
            ),
            None
        );
    }

    // --- resume runtime continuation (issue #589, ADR-0102 D1/D4) ----------

    #[test]
    fn resume_continues_the_sessions_last_runtime() {
        // D1 segment continuation: a recorded external runtime resolves to
        // that exact CLI, and a recorded built-in runtime resumes built-in --
        // the machine-level default never overrides the session's own state.
        let spec = resume_runtime_choice(
            Some(&LastRuntime::External("gemini-cli".into())),
            None,
            detected_ids(&["gemini-cli"]),
        )
        .expect("a recorded detected runtime continues the session");
        assert_eq!(spec.id.as_str(), "gemini-cli");
        assert_eq!(
            resume_runtime_choice(
                Some(&LastRuntime::BuiltIn),
                Some(spec.clone()),
                detected_ids(&["gemini-cli"]),
            ),
            None,
            "a recorded built-in runtime resumes built-in, default ignored"
        );
    }

    #[test]
    fn resume_without_the_field_falls_back_to_the_default_runtime() {
        // Old-recipe compatibility (AC5): a pre-#589 recipe carries no
        // `last_runtime`, so the resume keeps the ADR-0098 Decision 2
        // semantics -- the RESOLVED default runtime, whatever it resolved to.
        let fallback = crate::runtime::acp::adapter::gemini_cli();
        assert_eq!(
            resume_runtime_choice(None, Some(fallback.clone()), detected_ids(&[])),
            Some(fallback),
            "no recorded runtime -> the resolved default lands verbatim"
        );
        assert_eq!(
            resume_runtime_choice(None, None, detected_ids(&["gemini-cli"])),
            None,
            "no recorded runtime + built-in default -> built-in"
        );
    }

    #[test]
    fn resume_undetected_adapter_degrades_but_never_substitutes() {
        // D4: an undetected adapter degrades THIS resume to the built-in
        // start (the persisted value itself is disk-side, untouched here);
        // re-detection makes the same recorded value resolve external again.
        // Resolution also never substitutes a different detected CLI.
        let last = LastRuntime::External("gemini-cli".into());
        assert_eq!(
            resume_runtime_choice(Some(&last), None, detected_ids(&[])),
            None,
            "undetected runtime degrades this resume to built-in"
        );
        assert_eq!(
            resume_runtime_choice(Some(&last), None, detected_ids(&["codex"])),
            None,
            "a missing CLI never silently resumes on another detected adapter"
        );
        let spec = resume_runtime_choice(Some(&last), None, detected_ids(&["gemini-cli"]))
            .expect("re-detected runtime resolves external again");
        assert_eq!(spec.id.as_str(), "gemini-cli");
        // An id outside the v1 table (hand-edited recipe) degrades the same
        // way -- resolution is total, the persisted field stays as written.
        assert_eq!(
            resume_runtime_choice(
                Some(&LastRuntime::External("no-such-cli".into())),
                None,
                detected_ids(&["gemini-cli", "codex"])
            ),
            None
        );
    }

    #[test]
    fn apply_resumed_postures_lands_the_resume_continuation_on_the_handle() {
        // The open_duck wiring -- the command itself needs an AppHandle, so
        // the batch lives in a free function (issue #589): the stale
        // pre-resume choice is OVERWRITTEN by the resume continuation, the
        // ADR-0095 trio restores after the resets, a pre-#589 recipe falls
        // back to the resolved default, and an undetected adapter degrades
        // to the built-in start.
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create session");
        let handle = store.get(&id).expect("get handle");
        let gemini = crate::runtime::acp::adapter::gemini_cli();

        // A stale pre-resume external choice + model -- the batch overwrites
        // both, never merges.
        handle.set_runtime_choice(Some(crate::runtime::acp::adapter::codex()));
        handle.set_external_model_config(PosturePair {
            model: Some("stale-model".into()),
            thought_level: None,
        });

        // Continuation (D1): the recorded detected runtime replaces the
        // stale choice; the startup default is never consulted; the restored
        // trio wins over the stale model.
        apply_resumed_postures(
            &handle,
            SessionRuntimeFacts {
                last_runtime: Some(LastRuntime::External("gemini-cli".into())),
                model: Some("fake-opus".into()),
                ..Default::default()
            },
            Some(crate::runtime::acp::adapter::codex()),
            detected_ids(&["gemini-cli"]),
        );
        assert_eq!(
            handle
                .runtime_choice()
                .expect("the continuation lands")
                .id
                .as_str(),
            "gemini-cli",
            "the recorded detected runtime overwrites the stale choice"
        );
        assert_eq!(
            handle.external_model_config().model.as_deref(),
            Some("fake-opus"),
            "the restored trio wins over the stale model"
        );

        // Pre-#589 recipe (no recorded runtime): the resolved default
        // runtime -- the ADR-0098 Decision 2 semantics.
        apply_resumed_postures(
            &handle,
            SessionRuntimeFacts::default(),
            Some(gemini.clone()),
            detected_ids(&[]),
        );
        assert_eq!(
            handle
                .runtime_choice()
                .expect("the fallback lands")
                .id
                .as_str(),
            "gemini-cli",
            "a pre-#589 recipe resumes on the resolved default"
        );

        // D4: an undetected recorded adapter degrades THIS resume to the
        // built-in start -- never to the startup default, never to another
        // detected CLI.
        apply_resumed_postures(
            &handle,
            SessionRuntimeFacts {
                last_runtime: Some(LastRuntime::External("gemini-cli".into())),
                ..Default::default()
            },
            Some(gemini.clone()),
            detected_ids(&[]),
        );
        assert!(
            handle.runtime_choice().is_none(),
            "an undetected recorded runtime degrades the resume to built-in"
        );
    }

    #[test]
    fn startup_runtime_choice_reads_the_real_config_and_degrades_unknown_ids() {
        // The command-path helper through a real config file (the two cases
        // that are PATH-independent, so the test is deterministic on any
        // machine): a fresh-install config resolves to built-in regardless of
        // what is installed, and a hand-edited unknown adapter id degrades
        // without the PATH scan ever deciding anything. The
        // detected-external case is environment-bound (gemini-cli may or may
        // not be on the dev box's PATH) and stays covered by the injected
        // seam tests above.
        let dir = tempfile::tempdir().expect("tempdir");
        let live = LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore::new(),
            dir.path().join("config.json"),
        );
        assert_eq!(
            startup_runtime_choice(&live),
            None,
            "fresh-install config starts built-in (AC1)"
        );
        live.set_default_runtime(DefaultRuntime::External("no-such-cli".into()))
            .expect("the store persists the value verbatim");
        assert_eq!(
            startup_runtime_choice(&live),
            None,
            "an id outside the v1 table degrades to built-in at startup"
        );
        // AC3's field-unchanged clause as an observable assertion, not just
        // the &DefaultRuntime type shape: the degrade never rewrote the
        // config (ADR-0098 Decision 3).
        assert_eq!(
            live.load().default_runtime,
            DefaultRuntime::External("no-such-cli".into()),
            "resolution never rewrites the config field"
        );
    }

    // --- startup model posture backfill (issue #581, ADR-0100) ---------------

    /// A LiveProviderConfig bound to a temp-dir config path (the same fixture
    /// shape as the startup-resolution test above).
    fn posture_live() -> (tempfile::TempDir, LiveProviderConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let live = LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore::new(),
            dir.path().join("config.json"),
        );
        (dir, live)
    }

    #[test]
    fn segment_start_posture_built_in_start_stays_unselected() {
        // A built-in start (fresh install, or an external default degraded
        // for this start) has no adapter namespace, so the segment-start
        // posture is the empty one -- the session begins unselected (issue
        // #581 AC3's degrade clause).
        let (_dir, live) = posture_live();
        assert_eq!(segment_start_posture(None, &live), ModelPosture::default());
    }

    #[test]
    fn segment_start_posture_reads_the_target_adapters_entry() {
        // The posture map is keyed by adapter id, so the read follows the
        // segment-start adapter exactly: an entry on it injects, an entry
        // on a sibling adapter never leaks across namespaces (ADR-0100
        // Decision 2).
        let (_dir, live) = posture_live();
        live.set_last_model_posture(
            "gemini-cli",
            ModelPosture {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
        )
        .expect("seed gemini-cli posture");
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        assert_eq!(
            segment_start_posture(Some(&gemini), &live),
            ModelPosture {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
            "the segment-start adapter's entry injects"
        );
        let codex = resolve_adapter("codex").expect("v1 adapter");
        assert_eq!(
            segment_start_posture(Some(&codex), &live),
            ModelPosture::default(),
            "a sibling adapter's entry does not leak"
        );
    }

    /// A fresh session handle for the injection seam tests (the store is
    /// returned alongside so it outlives the handle the test drives).
    fn posture_handle() -> (SessionStore, Arc<SessionHandle>) {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        (store, handle)
    }

    #[test]
    fn apply_startup_posture_seats_the_entry_on_both_slots() {
        // The injection join (ADR-0100 Decision 1): the pair lands on the
        // handle-held slot the lock-light reads serve AND the Session
        // storage the recipe persists -- so the initial bind already
        // carries the posture and a pre-first-turn restart resumes
        // selected (ADR-0095 Decision 6).
        let (_store, handle) = posture_handle();
        apply_startup_posture(
            &handle,
            &PosturePair {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
        )
        .expect("apply the startup posture");
        assert_eq!(
            handle.external_model_config(),
            PosturePair {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into())
            },
            "the handle slot serves the lock-light reads"
        );
        let s = handle.session_lock().expect("session lock");
        assert_eq!(
            s.runtime_facts().model.as_deref(),
            Some("gemini-2.5-pro"),
            "the Session storage feeds the recipe"
        );
        assert_eq!(
            s.runtime_facts().thought_level.as_deref(),
            Some("high"),
            "the Session storage feeds the recipe"
        );
    }

    #[test]
    fn apply_startup_posture_empty_entry_keeps_the_session_unselected() {
        // An absent / cleared entry applies the empty posture, which
        // rewrites the fresh session's own (None, None) -- the session
        // starts unselected without a guard (the "default (recommended)"
        // start).
        let (_store, handle) = posture_handle();
        apply_startup_posture(&handle, &PosturePair::default()).expect("apply the empty posture");
        assert_eq!(handle.external_model_config(), PosturePair::default());
        let s = handle.session_lock().expect("session lock");
        assert!(s.runtime_facts().model.is_none());
        assert!(s.runtime_facts().thought_level.is_none());
    }

    // --- in-session switch re-seeding (issue #590, ADR-0102 Decision 3) ------

    #[test]
    fn apply_runtime_switch_seeds_the_target_adapters_entry() {
        // Issue #590 AC1: switching to an external runtime seats that
        // adapter's backfill entry on the posture slot -- the pair held
        // under the OLD adapter's namespace never injects into the new CLI
        // (the pre-#590 dangling state the re-seed replaces).
        let (_dir, live) = posture_live();
        live.set_last_model_posture(
            "gemini-cli",
            ModelPosture {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
        )
        .expect("seed gemini-cli posture");
        let (_store, handle) = posture_handle();
        handle.set_external_model_config(PosturePair {
            model: Some("claude-opus-4-5".into()),
            thought_level: Some("max".into()),
        });
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        apply_runtime_switch(&handle, Some(gemini.clone()), &live);
        assert_eq!(handle.runtime_choice(), Some(gemini));
        assert_eq!(
            handle.external_model_config(),
            PosturePair {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into())
            },
            "the slot serves the target adapter's entry, not the stale pair"
        );
        // Issue #590 AC4: the switch path only READS the backfill map --
        // the seeded entry keeps exactly what was set and no new key
        // appears (a read-after-write here would rewrite the entry it just
        // served and break the single-write-point contract).
        let stored = live.load().last_model_postures;
        assert_eq!(stored.len(), 1, "the switch adds no backfill entries");
        assert_eq!(
            stored
                .get("gemini-cli")
                .map(|p| (&p.model, &p.thought_level)),
            Some((&Some("gemini-2.5-pro".into()), &Some("high".into()))),
            "the switch never writes the backfill map"
        );
    }

    #[test]
    fn apply_runtime_switch_without_an_entry_clears_the_slot() {
        // Issue #590 AC1 (no entry) + AC2 (built-in): both seed the empty
        // posture -- unselected, the CLI's own defaults. A target adapter
        // with no entry (never chosen / cleared) clears whatever was held,
        // and the built-in runtime (which consumes no posture) does too.
        let (_dir, live) = posture_live();
        let (_store, handle) = posture_handle();
        handle.set_external_model_config(PosturePair {
            model: Some("gemini-2.5-pro".into()),
            thought_level: Some("high".into()),
        });
        let codex = resolve_adapter("codex").expect("v1 adapter");
        apply_runtime_switch(&handle, Some(codex), &live);
        assert_eq!(
            handle.external_model_config(),
            PosturePair::default(),
            "an entry-less external target starts the segment unselected"
        );
        // Re-hold a pair, then switch to the built-in runtime: cleared again.
        handle.set_external_model_config(PosturePair {
            model: Some("gpt-5.1-codex".into()),
            thought_level: None,
        });
        apply_runtime_switch(&handle, None, &live);
        assert_eq!(handle.runtime_choice(), None);
        assert_eq!(handle.external_model_config(), PosturePair::default());
    }

    #[test]
    fn apply_runtime_switch_back_recovers_the_held_selection() {
        // Issue #590 AC3: switching back to a previously used adapter
        // recovers its held selection -- the single write point
        // (`record_last_model_posture`) keeps the entry synced with every
        // successful set made while on that adapter, so the re-seed reads
        // the last selection back.
        let (_dir, live) = posture_live();
        let (_store, handle) = posture_handle();
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        let codex = resolve_adapter("codex").expect("v1 adapter");
        apply_runtime_switch(&handle, Some(gemini.clone()), &live);
        // An explicit selection while on gemini lands on its entry (the
        // same helper the set command calls -- the write point stays ONE).
        record_last_model_posture(
            &live,
            Some(gemini.clone()),
            PosturePair {
                model: Some("gemini-2.5-flash".into()),
                thought_level: None,
            },
        );
        // Switch away (codex has no entry -> the slot clears) and back.
        apply_runtime_switch(&handle, Some(codex), &live);
        assert_eq!(handle.external_model_config(), PosturePair::default());
        apply_runtime_switch(&handle, Some(gemini), &live);
        assert_eq!(
            handle.external_model_config(),
            PosturePair {
                model: Some("gemini-2.5-flash".into()),
                thought_level: None
            },
            "the adapter's held selection recovers on the switch back"
        );
    }

    #[test]
    fn apply_runtime_switch_leaves_the_session_storage_alone() {
        // Issue #590 AC6: the switch lands on the HANDLE only -- the Session
        // (and the recipe it persists) keeps the old pair until the `ask`
        // mirror at the next turn top, exactly like the runtime choice
        // itself; the write therefore never blocks on an in-flight turn
        // holding the session lock.
        let (_dir, live) = posture_live();
        let (_store, handle) = posture_handle();
        {
            let mut s = handle.session_lock().expect("session lock");
            s.set_external_model_config(PosturePair {
                model: Some("old-namespace-model".into()),
                thought_level: Some("old-level".into()),
            });
        }
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        apply_runtime_switch(&handle, Some(gemini), &live);
        let s = handle.session_lock().expect("session lock");
        assert_eq!(
            s.runtime_facts().model.as_deref(),
            Some("old-namespace-model"),
            "the Session keeps the pre-switch pair until the turn-top mirror"
        );
        assert_eq!(
            handle.external_model_config(),
            PosturePair::default(),
            "the handle slot already serves the seeded (empty) posture"
        );
    }

    #[test]
    fn record_last_model_posture_lands_the_pair_under_the_adapter() {
        // The single write point: the post-set pair lands on the runtime
        // adapter's entry and survives a reload (issue #581 AC2).
        let (_dir, live) = posture_live();
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        record_last_model_posture(
            &live,
            Some(gemini),
            PosturePair {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
        );
        assert_eq!(
            live.last_model_posture("gemini-cli"),
            ModelPosture {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            }
        );
    }

    #[test]
    fn record_last_model_posture_skips_the_built_in_runtime() {
        // A built-in session has no adapter to key the entry under (the
        // posture is a no-op there, ADR-0095) -- nothing is written at all.
        let (_dir, live) = posture_live();
        record_last_model_posture(
            &live,
            None,
            PosturePair {
                model: Some("some-model".into()),
                thought_level: None,
            },
        );
        assert!(live.load().last_model_postures.is_empty());
    }

    #[test]
    fn record_last_model_posture_never_fails_the_set_on_config_write_failure() {
        // The best-effort contract (ADR-0100 Decision 3): the session
        // posture already landed, so a config-write failure only costs the
        // NEXT startup's convenience injection -- warn, never fail the set.
        // A config path under a nonexistent parent directory makes write_at
        // fail deterministically on every platform; the helper must return
        // normally. The `-> ()` signature is the compile-time pin: error
        // propagation would need a signature change that turns this call
        // red.
        let dir = tempfile::tempdir().expect("tempdir");
        let live = LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore::new(),
            dir.path().join("nonexistent").join("config.json"),
        );
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        record_last_model_posture(
            &live,
            Some(gemini),
            PosturePair {
                model: Some("gemini-2.5-pro".into()),
                thought_level: Some("high".into()),
            },
        );
        // The failed write landed nothing: the honest-degrade read sees no
        // map at all.
        assert!(live.load().last_model_postures.is_empty());
    }

    #[test]
    fn apply_posture_set_lands_the_submitted_pair_verbatim() {
        // The set command's body (issues #600 + #603): the submitted pair is
        // the COMPLETE posture -- every field lands verbatim, never mixed
        // with the slot's held value. The first set clears the held thought
        // level (`None` must NOT pass the old slot value through -- the
        // retired read-modify-write behavior this test pins dead); the
        // second carries a retained-value field, landing both dimensions.
        // The pair write, the segment-header stamp (ADR-0102 Decision 1),
        // and the backfill entry all key off the ONE atomic slot read -- so
        // the persisted pair travels under the runtime it was selected on.
        // Unbound session -> persist_if_bound is a no-op, the Session facts
        // are the observable.
        let (_dir, live) = posture_live();
        let (_store, handle) = posture_handle();
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        handle.set_runtime_and_posture(
            Some(gemini),
            PosturePair {
                model: Some("old-model".into()),
                thought_level: Some("low".into()),
            },
        );

        apply_posture_set(
            &handle,
            &live,
            PosturePair {
                model: Some("gemini-2.5-flash".into()),
                thought_level: None,
            },
        )
        .expect("set the posture");

        // The session side: the submitted pair lands verbatim -- the clear
        // is not filled back from the held `low` -- stamped with the pair's
        // own runtime.
        let s = handle.session_lock().expect("session lock");
        assert_eq!(s.runtime_facts().model.as_deref(), Some("gemini-2.5-flash"));
        assert_eq!(s.runtime_facts().thought_level.as_deref(), None);
        assert_eq!(
            s.runtime_facts().last_runtime,
            Some(LastRuntime::External("gemini-cli".into()))
        );
        drop(s);
        // The handle slot serves the new pair to the lock-light reads.
        assert_eq!(
            handle.external_model_config(),
            PosturePair {
                model: Some("gemini-2.5-flash".into()),
                thought_level: None,
            }
        );
        // The backfill entry lands under the READ runtime's namespace
        // (ADR-0100 Decision 3).
        assert_eq!(
            live.last_model_posture("gemini-cli"),
            ModelPosture {
                model: Some("gemini-2.5-flash".into()),
                thought_level: None,
            }
        );

        // A retained-value second set: both fields land verbatim.
        apply_posture_set(
            &handle,
            &live,
            PosturePair {
                model: Some("gemini-2.5-flash".into()),
                thought_level: Some("high".into()),
            },
        )
        .expect("set the posture again");
        let s = handle.session_lock().expect("session lock");
        assert_eq!(s.runtime_facts().model.as_deref(), Some("gemini-2.5-flash"));
        assert_eq!(s.runtime_facts().thought_level.as_deref(), Some("high"));
        drop(s);
        assert_eq!(
            handle.external_model_config(),
            PosturePair {
                model: Some("gemini-2.5-flash".into()),
                thought_level: Some("high".into()),
            }
        );
        assert_eq!(
            live.last_model_posture("gemini-cli"),
            ModelPosture {
                model: Some("gemini-2.5-flash".into()),
                thought_level: Some("high".into()),
            }
        );
    }

    #[test]
    fn apply_posture_set_stamps_built_in_and_records_no_backfill() {
        // The built-in half of the stamp: `None` is the built-in runtime and
        // stamps `BuiltIn` unconditionally; a built-in session has no adapter
        // namespace, so no backfill entry is written at all.
        let (_dir, live) = posture_live();
        let (_store, handle) = posture_handle();

        apply_posture_set(
            &handle,
            &live,
            PosturePair {
                model: Some("some-model".into()),
                thought_level: None,
            },
        )
        .expect("set the posture");

        let s = handle.session_lock().expect("session lock");
        assert_eq!(s.runtime_facts().last_runtime, Some(LastRuntime::BuiltIn));
        drop(s);
        assert!(live.load().last_model_postures.is_empty());
    }

    #[test]
    fn set_posture_if_runtime_drops_the_write_when_the_runtime_moved() {
        // The conditional write-back guard (issues #600 + #603): the set
        // command writes its pair back through this primitive with the
        // runtime it read the pair under, so a switch landing between the
        // atomic read and the write-back (already re-seeding the slot with
        // the target adapter's posture, the #590 segment semantics) makes
        // the stale-namespace write a no-op -- the slot stays on the
        // switch's segment while a matching runtime lets the write land.
        let (_dir, live) = posture_live();
        let (_store, handle) = posture_handle();
        let gemini = resolve_adapter("gemini-cli").expect("v1 adapter");
        let codex = resolve_adapter("codex").expect("v1 adapter");
        handle.set_runtime_and_posture(
            Some(gemini),
            PosturePair {
                model: Some("old-model".into()),
                thought_level: None,
            },
        );
        let (read_runtime, _) = handle.runtime_and_posture();

        // A switch lands before the write-back: the slot re-seeds under
        // codex (no entry -> unselected), and the stale write is dropped.
        apply_runtime_switch(&handle, Some(codex.clone()), &live);
        assert!(!handle.set_posture_if_runtime(
            &read_runtime,
            PosturePair {
                model: Some("gemini-2.5-flash".into()),
                thought_level: None,
            }
        ));
        assert_eq!(handle.runtime_choice(), Some(codex));
        assert_eq!(
            handle.external_model_config(),
            PosturePair::default(),
            "the stale-namespace write-back is dropped"
        );

        // A write under the CURRENT runtime lands.
        let (current, _) = handle.runtime_and_posture();
        assert!(handle.set_posture_if_runtime(
            &current,
            PosturePair {
                model: Some("codex-model".into()),
                thought_level: Some("high".into()),
            }
        ));
        assert_eq!(
            handle.external_model_config(),
            PosturePair {
                model: Some("codex-model".into()),
                thought_level: Some("high".into()),
            }
        );
    }

    /// The per-session resume guard rejects a mutating command while THAT
    /// session is resuming. Pin the rejection branch itself (the happy path is
    /// exercised implicitly by every command that drives a live session).
    #[test]
    fn reject_if_resuming_blocks_while_the_session_is_resuming() {
        let store = SessionStore::new();
        let cancel = Arc::new(CancelToken::new());
        let id = store
            .create(cancel, Box::new(crate::UnwiredProvider), Default::default())
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        handle.set_resuming(true);
        let err = reject_if_resuming(&handle).unwrap_err();
        assert_eq!(err, SessionError::Resuming);
    }

    /// A second session's resume flag is independent: resuming one session does
    /// NOT block a mutating command on another (ADR-0056 per-session isolation).
    #[test]
    fn resume_flag_is_per_session_not_global() {
        let store = SessionStore::new();
        let a = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create a");
        let b = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create b");
        store.get(&a).expect("a handle").set_resuming(true);
        // Session b is NOT resuming -- a mutating command on b proceeds.
        reject_if_resuming(&store.get(&b).expect("b handle")).expect("b not blocked");
    }

    /// ADR-0021 single-flight (per session, ADR-0056): while a turn is in
    /// flight on a session, a second ask on the SAME session rejects. The guard
    /// keeps in_flight true for the scope of the simulated turn.
    #[test]
    fn second_ask_on_same_session_rejects_while_one_is_in_flight() {
        let store = SessionStore::new();
        let cancel = Arc::new(CancelToken::new());
        let id = store
            .create(cancel, Box::new(crate::UnwiredProvider), Default::default())
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        // Without a turn in flight, an ask is allowed.
        reject_if_in_flight(&handle).expect("first ask allowed");
        // Simulate turn in flight via the token directly (ask does this via
        // the agent loop's begin_turn internally); the handle shares the same
        // Arc<CancelToken>.
        {
            let _guard = handle.cancel_token().clone().begin_turn();
            assert!(handle.is_in_flight());
            let err = reject_if_in_flight(&handle).unwrap_err();
            assert_eq!(err, SessionError::InFlight);
        }
        // Guard dropped -> in_flight clears -> a later ask is allowed again.
        assert!(!handle.is_in_flight());
        reject_if_in_flight(&handle).expect("ask allowed after turn ends");
    }

    /// An unknown / closed session_id rejects with NotFound. The
    /// malformed-id path (InvalidId) is covered in session_store tests; this
    /// pins the NotFound branch the command boundary surfaces.
    #[test]
    fn unknown_session_id_rejects_not_found() {
        let store = SessionStore::new();
        let parsed = SessionId::parse("550e8400-e29b-41d4-a716-446655440000")
            .expect("well-formed id parses");
        let err = store.get(&parsed).err().expect("expected not-found error");
        assert_eq!(err, SessionError::NotFound);
        assert_eq!(err.to_string(), UNKNOWN_SESSION);
    }

    /// A malformed id is InvalidId at the parse step, distinct from NotFound
    /// -- the command boundary surfaces the distinction so a typo
    /// reads differently from a closed session. Pins the command-layer parse
    /// the typed store cannot express (the store takes a typed SessionId).
    #[test]
    fn malformed_session_id_is_invalid_not_not_found() {
        let err = SessionId::parse("not-a-uuid").expect_err("malformed id rejects");
        assert_eq!(err, SessionError::InvalidId);
        assert_ne!(err, SessionError::NotFound);
    }

    /// set_dataset_privacy rejects an unknown reference name as the typed
    /// RemoveSourceError::NotFound (issue #127), not a free-text Engine
    /// string. The working-set layer returns None for an unknown name; the
    /// command boundary maps that None to the typed variant so the frontend
    /// renders the shared `error.dataset.notFound` locale message.
    #[test]
    fn set_privacy_unknown_reference_maps_to_typed_remove_source_error() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        let mut s = handle.session_lock().expect("lock");
        // Working-set layer: an unregistered reference name yields None.
        let outcome = s.set_privacy("nope", DatasetPrivacy::default());
        assert!(outcome.is_none());
        // Command-boundary mapping via the shared helper: None -> typed
        // NotFound -> RemoveSource (issue #127). Calls the real production
        // path -- a regression to a free-text Engine string here fails the
        // assertion (the command's State arg blocks a direct call).
        let err = privacy_update_to_result(outcome, "nope").unwrap_err();
        assert_eq!(
            err,
            SessionError::RemoveSource(RemoveSourceError::NotFound("nope".into())),
        );
    }

    // --- Skill lifecycle command wiring (issue #363, ADR-0086) -------------

    /// `mount_skill`'s command body routes `Session::mount_skill`'s typed
    /// `SkillMountError` through `.map_err(SessionError::SkillMount)`. The
    /// command's `State` arg blocks a direct call (same approach as
    /// set_privacy_unknown_reference above), so exercise the mapping at the
    /// layer the command wraps. AC#5's loading gate (resuming / in-flight) is
    /// pinned by `reject_if_resuming_blocks_while_the_session_is_resuming` and
    /// `second_ask_on_same_session_rejects_while_one_is_in_flight` above; the
    /// command body's `?` propagation is compile-time enforced, so a dropped
    /// reject fails the build rather than silently passing the gate.
    #[test]
    fn mount_skill_command_maps_already_mounted_to_session_skill_mount_error() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        let mut s = handle.session_lock().expect("lock");
        s.mount_skill("sql-coach").expect("first mount");
        // Reproduce the command body's `.map_err(SessionError::SkillMount)`
        // wrapping (the `State` arg blocks calling the command directly).
        let err = s
            .mount_skill("sql-coach")
            .map_err(SessionError::SkillMount)
            .unwrap_err();
        assert!(
            matches!(
                err,
                SessionError::SkillMount(
                    crate::session::skills::SkillMountError::AlreadyMounted { ref name }
                ) if name == "sql-coach"
            ),
            "expected SessionError::SkillMount(AlreadyMounted), got {err:?}",
        );
    }

    /// `unmount_skill`'s command body routes `Session::unmount_skill`'s typed
    /// `SkillMountError` through the same `.map_err(SessionError::SkillMount)`
    /// wrapping; the `NotMounted` refuse is symmetric with `AlreadyMounted`.
    #[test]
    fn unmount_skill_command_maps_not_mounted_to_session_skill_mount_error() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        let mut s = handle.session_lock().expect("lock");
        let err = s
            .unmount_skill("ghost")
            .map_err(SessionError::SkillMount)
            .unwrap_err();
        assert!(
            matches!(
                err,
                SessionError::SkillMount(
                    crate::session::skills::SkillMountError::NotMounted { ref name }
                ) if name == "ghost"
            ),
            "expected SessionError::SkillMount(NotMounted), got {err:?}",
        );
    }

    /// `activate_skill`'s command body routes `Session::activate_skill`'s
    /// typed refusal through the same `.map_err(SessionError::SkillMount)`
    /// wrapping (issue #698): an activation can only name a MOUNTED skill.
    /// The loading-gate posture is identical to the mount commands (pinned
    /// by the tests above); the repeat-activation idempotence is pinned in
    /// `session::skills`.
    #[test]
    fn activate_skill_command_maps_not_mounted_for_activation_to_session_skill_mount_error() {
        let store = SessionStore::new();
        let id = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
                Default::default(),
            )
            .expect("create session");
        let handle = store.get(&id).expect("handle");
        let mut s = handle.session_lock().expect("lock");
        let err = s
            .activate_skill("ghost", crate::model::SkillLifecycleActor::User)
            .map_err(SessionError::SkillMount)
            .unwrap_err();
        assert!(
            matches!(
                err,
                SessionError::SkillMount(
                    crate::session::skills::SkillMountError::NotMountedForActivation {
                        ref name
                    }
                ) if name == "ghost"
            ),
            "expected SessionError::SkillMount(NotMountedForActivation), got {err:?}",
        );
    }

    /// Blank name short-circuits to BlankName BEFORE canonicalize runs (issue
    /// #130). The path's parent does not exist, so a reorder that canonicalized
    /// first would surface IoFailure instead -- pinning the result as BlankName
    /// also pins the ordering. Exercises the extracted blocking helper directly;
    /// the command wrapper only moves it onto a blocking thread.
    #[test]
    fn rename_persisted_session_blank_name_short_circuits_before_canonicalize() {
        let dir = tempfile::tempdir().expect("tempdir");
        // `no_such_subdir` was never created -> canonicalize_duck (which
        // canonicalizes the parent dir) would fail here.
        let missing_parent = dir.path().join("no_such_subdir").join("file.duck");
        let err = rename_persisted_session_blocking(&missing_parent, "   ")
            .expect_err("blank name rejects");
        assert_eq!(
            err,
            StoreCommandError::BlankName(RenameSessionError::EmptyName)
        );
    }

    /// The complement: a non-blank name on the same missing-parent path reaches
    /// canonicalize and maps to IoFailure -- confirming the blank-name check is
    /// what differentiates the two outcomes, and that a canonicalize failure
    /// folds to IoFailure (not a later stage that never runs).
    #[test]
    fn rename_persisted_session_nonblank_name_reaches_canonicalize() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing_parent = dir.path().join("no_such_subdir").join("file.duck");
        let err = rename_persisted_session_blocking(&missing_parent, "new name")
            .expect_err("missing parent rejects");
        assert!(
            matches!(err, StoreCommandError::IoFailure(_)),
            "non-blank name with a missing-parent path should be IoFailure, got {err:?}",
        );
    }

    /// A held canonical key (an open session owns the path) makes try_acquire
    /// fail and the helper refuses with OpenConflict (ADR-0035 single-writer
    /// gate). Also pins that the OpenConflict path does NOT release a key it
    /// never acquired, and that the gate runs only after canonicalize succeeds.
    #[test]
    fn rename_persisted_session_held_key_yields_open_conflict() {
        use crate::persistence::{canonicalize_duck, release, try_acquire};
        let dir = tempfile::tempdir().expect("tempdir");
        // Parent (dir) exists, so canonicalize_duck succeeds even though the
        // file itself is absent (it canonicalizes the parent + rejoins the name).
        let file = dir.path().join("held.duck");
        let canonical = canonicalize_duck(&file).expect("canonicalize (parent-based)");
        assert!(try_acquire(&canonical), "test takes the canonical key");
        let err =
            rename_persisted_session_blocking(&file, "new name").expect_err("held key rejects");
        assert_eq!(err, StoreCommandError::OpenConflict);
        release(&canonical);
    }

    // --- Runtime selector helpers (issue #353) ------------------------------

    /// scan_adapters projects exactly the v1 table (count-agnostic), each entry
    /// carrying its id + display name + a fresh PATH-scan detection flag + the
    /// resolved binary path. The composer picker + the settings adapter panel
    /// render this table verbatim -- a CLI added upstream never touches either.
    #[test]
    fn scan_adapters_projects_the_v1_table_with_detection_state() {
        let entries = scan_adapters();
        let adapters = v1_adapters();
        assert_eq!(entries.len(), adapters.len(), "one entry per v1 adapter");
        for (entry, spec) in entries.iter().zip(adapters.iter()) {
            assert_eq!(entry.id, spec.id.as_str(), "id round-trips");
            assert_eq!(
                entry.display_name, spec.display_name,
                "display_name round-trips"
            );
            let live = detect_adapter(spec);
            assert_eq!(
                entry.detected,
                live.is_some(),
                "detected mirrors the live PATH scan"
            );
            assert_eq!(
                entry.binary_path, live,
                "binary_path mirrors the live PATH scan"
            );
        }
    }

    /// resolve_adapter round-trips every known id and rejects an unknown one --
    /// the picker only offers v1 ids, so an unknown id is a stale / buggy
    /// client and the command boundary must surface it (no silent fallback to
    /// the built-in runtime).
    #[test]
    fn resolve_adapter_round_trips_known_ids_and_rejects_unknown() {
        for spec in v1_adapters() {
            let resolved = resolve_adapter(spec.id.as_str()).expect("known id resolves");
            assert_eq!(resolved.id, spec.id);
        }
        assert!(
            resolve_adapter("definitely-not-an-adapter").is_none(),
            "unknown ids do not resolve"
        );
    }

    /// The wire <-> storage mapping round-trips every choice shape (issue #353):
    /// built-in maps to / from None, a known external id maps to / from its
    /// spec, and an unknown external id rejects. The compose picker offers only
    /// known ids, so the reject branch is the buggy-client backstop.
    #[test]
    fn runtime_choice_maps_round_trips_and_rejects_unknown_ids() {
        // None <-> BuiltIn.
        assert_eq!(runtime_choice_to_wire(None), SessionRuntimeChoice::BuiltIn);
        assert_eq!(
            resolve_runtime_choice(SessionRuntimeChoice::BuiltIn).unwrap(),
            None
        );
        // A known external id round-trips through both maps.
        let spec = v1_adapters()[0].clone();
        assert_eq!(
            runtime_choice_to_wire(Some(spec.clone())),
            SessionRuntimeChoice::External(spec.id.as_str().to_string())
        );
        let back = resolve_runtime_choice(SessionRuntimeChoice::External(spec.id.as_str().into()))
            .expect("known id resolves");
        assert_eq!(back.unwrap().id, spec.id);
        // An unknown external id rejects (Engine -- the frontend resync path
        // drives off the reject).
        let err = resolve_runtime_choice(SessionRuntimeChoice::External(
            "definitely-not-an-adapter".into(),
        ))
        .expect_err("unknown id rejects");
        assert!(
            matches!(err, SessionError::Engine(_)),
            "unknown adapter id surfaces as Engine, got {err:?}"
        );
    }

    // -----------------------------------------------------------------------
    // probe_result_from_outcome (issue #392)
    // -----------------------------------------------------------------------

    /// Produce a `tokio::time::error::Elapsed` for testing (no public
    /// constructor — obtained from a zero-duration timeout on a pending
    /// future via a throwaway current-thread runtime).
    fn make_elapsed() -> tokio::time::error::Elapsed {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("build test runtime");
        rt.block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_nanos(0),
                std::future::pending::<()>(),
            )
            .await
            .unwrap_err()
        })
    }

    #[test]
    fn probe_outcome_success_maps_to_connected_with_tools() {
        let tools = vec![serde_json::json!({"name": "echo", "description": "d"})];
        let result = probe_result_from_outcome(Ok(Ok(tools)), "srv", 30_000);
        assert!(result.connected);
        assert!(result.error.is_none());
        assert_eq!(result.tools.len(), 1);
    }

    #[test]
    fn probe_outcome_error_maps_to_disconnected_with_message() {
        let result =
            probe_result_from_outcome(Ok(Err("handshake failed".to_string())), "srv", 30_000);
        assert!(!result.connected);
        assert!(result.tools.is_empty());
        assert_eq!(result.error.as_deref(), Some("handshake failed"));
    }

    #[test]
    fn probe_outcome_timeout_maps_to_disconnected_with_deadline() {
        let result = probe_result_from_outcome(Err(make_elapsed()), "srv", 5000);
        assert!(!result.connected);
        assert!(result.tools.is_empty());
        let error = result.error.expect("timeout produces an error");
        assert!(
            error.contains("5000 ms"),
            "error should include the deadline, got: {error}"
        );
    }

    // --- export_session_files (issue #449) ----------------------------------

    #[test]
    fn export_copies_session_duck_and_assets() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let session_dir = tmp.path().join("uuid-abc");
        std::fs::create_dir_all(&session_dir).unwrap();
        let duck = session_dir.join("session.duck");
        std::fs::write(&duck, b"recipe content").unwrap();
        // Create assets/ with a derived source file.
        std::fs::create_dir_all(session_dir.join("assets")).unwrap();
        std::fs::write(
            session_dir.join("assets").join("derived.csv"),
            b"col\nval\n",
        )
        .unwrap();

        let dest = tmp.path().join("export-copy");
        export_session_files(&duck, &session_dir, &dest).expect("export succeeds");

        assert_eq!(
            std::fs::read_to_string(dest.join("session.duck")).unwrap(),
            "recipe content"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("assets").join("derived.csv")).unwrap(),
            "col\nval\n"
        );
    }

    #[test]
    fn export_copies_only_session_duck_when_no_assets() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let session_dir = tmp.path().join("uuid-noassets");
        std::fs::create_dir_all(&session_dir).unwrap();
        let duck = session_dir.join("session.duck");
        std::fs::write(&duck, b"recipe").unwrap();

        let dest = tmp.path().join("export-no-assets");
        export_session_files(&duck, &session_dir, &dest).expect("export succeeds");

        assert!(dest.join("session.duck").exists());
        assert!(!dest.join("assets").exists());
    }

    #[test]
    fn export_copies_nested_assets_subdirectories() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let session_dir = tmp.path().join("uuid-nested");
        std::fs::create_dir_all(&session_dir).unwrap();
        let duck = session_dir.join("session.duck");
        std::fs::write(&duck, b"recipe").unwrap();
        // Create assets/ with a nested subdirectory.
        std::fs::create_dir_all(session_dir.join("assets").join("sub")).unwrap();
        std::fs::write(
            session_dir.join("assets").join("sub").join("leaf.csv"),
            b"deep",
        )
        .unwrap();

        let dest = tmp.path().join("export-nested");
        export_session_files(&duck, &session_dir, &dest).expect("export succeeds");

        assert_eq!(
            std::fs::read_to_string(dest.join("assets").join("sub").join("leaf.csv")).unwrap(),
            "deep"
        );
    }

    #[test]
    fn export_refuses_existing_destination() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let session_dir = tmp.path().join("uuid");
        std::fs::create_dir_all(&session_dir).unwrap();
        let duck = session_dir.join("session.duck");
        std::fs::write(&duck, b"recipe").unwrap();

        let dest = tmp.path().join("existing");
        std::fs::create_dir_all(&dest).unwrap();

        let err = export_session_files(&duck, &session_dir, &dest).unwrap_err();
        assert!(matches!(err, StoreCommandError::DestinationExists(_)));
    }

    #[test]
    fn export_cleans_up_on_copy_failure() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let session_dir = tmp.path().join("uuid");
        std::fs::create_dir_all(&session_dir).unwrap();
        // session.duck does NOT exist → copy will fail.
        let duck = session_dir.join("session.duck");

        let dest = tmp.path().join("failed-export");
        let _ = export_session_files(&duck, &session_dir, &dest);

        // dest should not remain as a partial export.
        assert!(!dest.exists());
    }

    #[test]
    fn export_cleans_up_on_assets_copy_failure() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let session_dir = tmp.path().join("uuid");
        std::fs::create_dir_all(&session_dir).unwrap();
        let duck = session_dir.join("session.duck");
        std::fs::write(&duck, b"recipe").unwrap();
        // assets/ contains a symlink → copy_dir_all refuses it.
        let assets = session_dir.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink("/etc/passwd", assets.join("evil")).unwrap();
        }

        let dest = tmp.path().join("failed-assets-export");
        let result = export_session_files(&duck, &session_dir, &dest);

        #[cfg(unix)]
        {
            // Symlink refusal → error + full cleanup (session.duck removed too).
            assert!(result.is_err());
            assert!(!dest.exists());
        }
        #[cfg(not(unix))]
        {
            // On non-Unix we cannot create symlinks; just verify session.duck
            // was copied (the assets dir is empty, no failure path triggered).
            let _ = result;
            assert!(dest.join("session.duck").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn copy_dir_all_refuses_symlinks() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("real.txt"), b"data").unwrap();
        use std::os::unix::fs::symlink;
        // Symlink to a file outside src.
        symlink("/etc/passwd", src.join("evil")).unwrap();

        let err = copy_dir_all(&src, &dst).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("symlink"));
    }

    // --- import_session_files (issue #450) ----------------------------------

    #[test]
    fn import_copies_duck_as_session_duck() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // External .duck in its own directory (bare file, no assets).
        let ext_dir = tmp.path().join("external");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let ext_duck = ext_dir.join("report.duck");
        std::fs::write(&ext_duck, b"recipe content").unwrap();

        let dest = tmp.path().join("imported-uuid");
        import_session_files(&ext_duck, &dest).expect("import succeeds");

        // Destination always uses fixed name session.duck (ADR-0089 D3),
        // regardless of the source filename.
        assert_eq!(
            std::fs::read_to_string(dest.join("session.duck")).unwrap(),
            "recipe content"
        );
        // No companion assets/ → no assets/ in the destination.
        assert!(!dest.join("assets").exists());
    }

    #[test]
    fn import_copies_companion_assets_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // External per-session directory: session.duck + assets/.
        let ext_dir = tmp.path().join("exported-session");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let ext_duck = ext_dir.join("session.duck");
        std::fs::write(&ext_duck, b"recipe").unwrap();
        std::fs::create_dir_all(ext_dir.join("assets")).unwrap();
        std::fs::write(ext_dir.join("assets").join("derived.csv"), b"col\nval\n").unwrap();

        let dest = tmp.path().join("imported-with-assets");
        import_session_files(&ext_duck, &dest).expect("import succeeds");

        assert!(dest.join("session.duck").exists());
        assert_eq!(
            std::fs::read_to_string(dest.join("assets").join("derived.csv")).unwrap(),
            "col\nval\n"
        );
    }

    #[test]
    fn import_copies_nested_assets_subdirectories() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext_dir = tmp.path().join("nested-session");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let ext_duck = ext_dir.join("session.duck");
        std::fs::write(&ext_duck, b"recipe").unwrap();
        std::fs::create_dir_all(ext_dir.join("assets").join("sub")).unwrap();
        std::fs::write(ext_dir.join("assets").join("sub").join("leaf.csv"), b"deep").unwrap();

        let dest = tmp.path().join("imported-nested");
        import_session_files(&ext_duck, &dest).expect("import succeeds");

        assert_eq!(
            std::fs::read_to_string(dest.join("assets").join("sub").join("leaf.csv")).unwrap(),
            "deep"
        );
    }

    #[test]
    fn import_does_not_modify_original_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext_dir = tmp.path().join("source");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let ext_duck = ext_dir.join("original.duck");
        std::fs::write(&ext_duck, b"original content").unwrap();

        let dest = tmp.path().join("imported-copy");
        import_session_files(&ext_duck, &dest).expect("import succeeds");

        // The original file is untouched (copy, not move).
        assert_eq!(
            std::fs::read_to_string(&ext_duck).unwrap(),
            "original content"
        );
        assert!(ext_duck.exists());
    }

    #[test]
    fn import_ignores_old_style_stem_assets_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext_dir = tmp.path().join("legacy");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let ext_duck = ext_dir.join("report.duck");
        std::fs::write(&ext_duck, b"recipe").unwrap();
        // Old-style {stem}.assets/ — should NOT be detected (only sibling
        // `assets/` is, per issue #450 decision).
        std::fs::create_dir_all(ext_dir.join("report.assets")).unwrap();
        std::fs::write(ext_dir.join("report.assets").join("data.csv"), b"old").unwrap();

        let dest = tmp.path().join("imported-legacy");
        import_session_files(&ext_duck, &dest).expect("import succeeds");

        assert!(dest.join("session.duck").exists());
        // report.assets was NOT copied — only a sibling `assets/` dir would be.
        assert!(!dest.join("assets").exists());
    }

    #[test]
    fn import_fails_when_source_duck_does_not_exist() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dest = tmp.path().join("imported-fail");
        let nonexistent = tmp.path().join("no-such.duck");

        let err = import_session_files(&nonexistent, &dest).unwrap_err();
        // The dest directory may have been created (create_dir_all succeeds
        // before the copy fails), but session.duck should not exist.
        assert!(!dest.join("session.duck").exists());
        // The error is an IO error (file not found).
        assert!(
            err.kind() == std::io::ErrorKind::NotFound
                || err.to_string().contains("no such file")
                || err.to_string().contains("cannot find")
        );
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_symlink_source_duck() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().expect("tempdir");
        let real = tmp.path().join("real-target");
        std::fs::write(&real, b"secret").unwrap();
        let symlink_duck = tmp.path().join("link.duck");
        symlink(&real, &symlink_duck).unwrap();

        let dest = tmp.path().join("imported");
        let err = import_session_files(&symlink_duck, &dest).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("symlink"));
        assert!(!dest.join("session.duck").exists());
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_symlink_assets_directory() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().expect("tempdir");
        let ext_dir = tmp.path().join("external");
        std::fs::create_dir_all(&ext_dir).unwrap();
        let ext_duck = ext_dir.join("session.duck");
        std::fs::write(&ext_duck, b"recipe").unwrap();
        // Create a real directory with a file, then symlink assets/ to it.
        let real_dir = tmp.path().join("real-assets");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::write(real_dir.join("secret.csv"), b"sensitive").unwrap();
        symlink(&real_dir, ext_dir.join("assets")).unwrap();

        let dest = tmp.path().join("imported");
        let err = import_session_files(&ext_duck, &dest).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(err.to_string().contains("symlink"));
        // The .duck itself was valid, so it was copied before the assets
        // check — but the symlinked assets must NOT be traversed.
        assert!(!dest.join("assets").exists());
    }

    // --- cleanup_orphaned_session_dir (ADR-0089 D6 parity for open_duck) ---

    /// Helper: create a sessions-root-like temp tree with a stale session
    /// directory containing a `session.duck` placeholder.
    fn make_stale_session(root: &Path, uuid: &str) -> PathBuf {
        let dir = root.join(uuid);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("session.duck"), b"{}").unwrap();
        dir
    }

    #[test]
    fn cleanup_removes_empty_orphan_under_sessions_root() {
        // AC#1: empty stale session, different resume target → orphan deleted.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        let stale_dir = make_stale_session(&root, "uuid-a");
        let stale_duck = stale_dir.join("session.duck");
        let resume_target = tmp.path().join("external.duck");
        std::fs::write(&resume_target, b"{}").unwrap();

        cleanup_orphaned_session_dir(Some(&stale_duck), &resume_target, true, &root);
        assert!(!stale_dir.exists(), "orphan dir should be deleted");
    }

    #[test]
    fn cleanup_preserves_non_empty_stale_dir() {
        // AC#2: non-empty stale session → directory survives (data-loss guard).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        let stale_dir = make_stale_session(&root, "uuid-b");
        let stale_duck = stale_dir.join("session.duck");
        let resume_target = tmp.path().join("other.duck");
        std::fs::write(&resume_target, b"{}").unwrap();

        cleanup_orphaned_session_dir(
            Some(&stale_duck),
            &resume_target,
            false, // non-empty
            &root,
        );
        assert!(stale_dir.exists(), "non-empty dir must survive");
    }

    #[test]
    fn cleanup_skips_when_resume_target_is_same_path() {
        // AC#3: stale == resume target (direct ==) → no deletion.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        let stale_dir = make_stale_session(&root, "uuid-c");
        let stale_duck = stale_dir.join("session.duck");

        cleanup_orphaned_session_dir(
            Some(&stale_duck),
            &stale_duck, // same path
            true,
            &root,
        );
        assert!(stale_dir.exists(), "same-path must not trigger deletion");
    }

    #[test]
    fn cleanup_skips_dir_outside_sessions_root() {
        // C1 guard: stale dir outside sessions root → no deletion.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        let external_dir = tmp.path().join("external-session");
        std::fs::create_dir_all(&external_dir).unwrap();
        let external_duck = external_dir.join("session.duck");
        std::fs::write(&external_duck, b"{}").unwrap();
        let resume_target = tmp.path().join("other.duck");
        std::fs::write(&resume_target, b"{}").unwrap();

        cleanup_orphaned_session_dir(Some(&external_duck), &resume_target, true, &root);
        assert!(
            external_dir.exists(),
            "dir outside sessions_root must not be deleted"
        );
    }

    #[test]
    fn cleanup_skips_when_stale_duck_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();

        // No stale_duck path → pure no-op, must not panic.
        cleanup_orphaned_session_dir(None, &tmp.path().join("resume.duck"), true, &root);
    }

    #[test]
    fn cleanup_silent_when_dir_already_gone() {
        // NotFound on remove_dir_all → silent, no panic.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        // Create then manually delete to simulate "already gone".
        let stale_dir = make_stale_session(&root, "uuid-d");
        let stale_duck = stale_dir.join("session.duck");
        std::fs::remove_dir_all(&stale_dir).unwrap();
        let resume_target = tmp.path().join("other.duck");
        std::fs::write(&resume_target, b"{}").unwrap();

        // stale_duck path still points to the gone dir; canonicalize of the
        // stale_dir will return NotFound → silent return.
        cleanup_orphaned_session_dir(Some(&stale_duck), &resume_target, true, &root);
        // Should not panic — that's the assertion.
    }

    #[test]
    fn cleanup_skips_when_stale_and_target_share_parent() {
        // Parent-equality edge: stale and resume target in the same parent
        // directory but different filenames. The sessions-root guard already
        // prevents deletion here because the shared parent IS the sessions
        // root in this contrived case — but a deeper nesting under root still
        // allows the orphan to be cleaned (they are in different uuid dirs).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        // Two sessions under the same root, different uuid dirs.
        let stale_dir = make_stale_session(&root, "uuid-e");
        let target_dir = make_stale_session(&root, "uuid-f");
        let stale_duck = stale_dir.join("session.duck");
        let resume_target = target_dir.join("session.duck");

        cleanup_orphaned_session_dir(Some(&stale_duck), &resume_target, true, &root);
        assert!(!stale_dir.exists(), "stale orphan should be deleted");
        assert!(target_dir.exists(), "resume target dir must be preserved");
    }

    // --- turn-boundary skill assembly seam (issue #707) -------------------

    /// Write one spec-valid skill directory under `root/<name>/` (the same
    /// shape the black-box suite writes, kept local to this module).
    fn put_skill(root: &Path, name: &str, description: &str, body: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let content = format!("---\nname: {name}\ndescription: {description}\n---\n{body}");
        std::fs::write(dir.join("SKILL.md"), content).unwrap();
    }

    /// The wiring pin issue #707 adds: the seam reads the session's two sets
    /// and wires `TurnInputs`'s fields correctly. The black-box tests
    /// hand-assemble their inputs (mirroring the pre-#707 command body), so a
    /// wrong-set field (e.g. `activated: &mounted`) or `&[]` survived every
    /// test before this pin.
    #[test]
    fn assemble_turn_inputs_pins_the_activated_subset_and_field_wiring() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        put_skill(&root, "alpha", "Alpha description.", "Alpha body.\n");
        put_skill(&root, "beta", "Beta description.", "Beta body.\n");

        let mut session =
            Session::with_provider(Box::new(crate::UnwiredProvider)).expect("session");
        session.mount_skill("alpha").expect("mount alpha");
        session.mount_skill("beta").expect("mount beta");
        session
            .activate_skill("alpha", crate::model::SkillLifecycleActor::User)
            .expect("activate alpha");

        let live = LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore::new(),
            tmp.path().join("config.json"),
        );
        // The non-empty direction of the CLI wiring (review I1, issue #707):
        // one enabled registration upserted through the real config path, so
        // the projection is pinned against `cli_tools: &[]` too -- an
        // empty-only assert is vacuously satisfied by a missing config. This
        // also makes `load()` read the temp config file instead of the
        // missing-config path that would query the OS keychain for the
        // legacy blob (review C).
        live.upsert_cli_tool(cli_tool("pandoc-guide", true))
            .expect("upsert one enabled CLI tool");
        let assembled = assemble_turn_inputs(&session, &root, &live);
        let inputs = assembled.turn_inputs(&[]);

        // The sort key is the activated subset, NOT the mounted set -- the
        // mirror-drift this pin exists for fails here.
        assert_eq!(
            inputs.activated,
            &["alpha".to_string()],
            "activated carries the activated subset, not the mounted set"
        );
        // Every mounted skill resolves with its description + body verbatim.
        assert_eq!(inputs.skills.len(), 2, "every mounted skill resolves");
        let alpha = inputs
            .skills
            .iter()
            .find(|f| f.name == "alpha")
            .expect("alpha fragment");
        assert_eq!(alpha.description, "Alpha description.");
        assert_eq!(alpha.body, "Alpha body.\n");
        assert!(
            !alpha.content_hash.is_empty(),
            "the whole-file hash is recorded"
        );
        let beta = inputs
            .skills
            .iter()
            .find(|f| f.name == "beta")
            .expect("beta fragment");
        assert_eq!(beta.description, "Beta description.");
        assert_eq!(beta.body, "Beta body.\n");
        // The command-level wiring rides the same projection: the enabled
        // CLI registration flows through (an empty-direction assert alone
        // could not catch `cli_tools: &[]`), and the empty MCP set
        // contributes nothing.
        assert_eq!(
            inputs.cli_tools.len(),
            1,
            "the enabled CLI tool rides the seam"
        );
        assert_eq!(inputs.cli_tools[0].name, "pandoc-guide");
        assert!(inputs.mcp_servers.is_empty());
    }
}
