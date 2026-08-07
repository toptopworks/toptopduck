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
//! provider / app config / recent file / session listing) return
//! `Result<T, StoreCommandError>` for the cold-store subset (issue #130):
//! [`StoreCommandError`] is serde-structured like [`SessionError`], so the
//! frontend narrows on `kind` and renders a locale message -- the Chinese
//! wording no longer crosses IPC. The cold-store subset covers `delete_session`
//! / `rename_persisted_session` (a cross-session `.duck` file), the keychain
//! commands, and `set_provider_config` / `set_app_config`. The remaining
//! session-agnostic commands (read-only listing / has-key / recent-file) cannot
//! fail with a user-facing refusal and keep returning `Result<T, String>`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, Manager, State};

use crate::app_config::AppConfig;
use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink, AuthMode, ToolKey};
use crate::cancel::CancelToken;
use crate::mcp::config::{McpServerConfig, McpServerId, McpTransport};
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadOutcome, ProfileId, ProfileKeyStatus,
    ProfileTestOutcome, Protocol, ProviderConfig, ProviderConfigView, RemoveSourceError, RowPage,
    SheetGuidance, ThreadEntry, TurnOutcome, TurnProgress,
};
use crate::persistence::{list_session_metadata, SaveError, SessionMetadata};
use crate::provider::live_config::LiveProviderConfig;
use crate::runtime::acp::adapter::{detect_adapter, v1_adapters, AdapterSpec};
use crate::session::{RenameSessionError, ResumeEvent, ResumeProgress, Session, TurnInputs};
use crate::session_store::{SessionError, SessionHandle, SessionId, SessionStore};
use crate::skills::{
    discover_skill_sources, import_skills as import_skills_impl, resolve_prompt_fragments,
    ImportItem, ImportMode, ImportOutcome, SkillEntry, SkillError, SkillListing, SkillSource,
    SkillSourceCandidate, SkillUpdate, SkillsRoot,
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
    /// An underlying IO failure (canonicalize / read / atomic-save / file
    /// remove) carrying the English technical detail for the fold.
    #[error("{0}")]
    IoFailure(String),
    /// The OS keychain access failed (ADR-0029 trust root). Carries the English
    /// technical detail; no key is ever leaked in the message.
    #[error("{0}")]
    KeychainFailure(String),
    /// An app-config write failed (serialize / temp-write / rename). Carries the
    /// English technical detail for the fold; the three WriteError stages are
    /// one refusal to the user, not three messages.
    #[error("{0}")]
    ConfigWriteFailure(String),
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

/// Create a new session (ADR-0056): the backend builds an independent in-memory
/// DuckDB instance (ADR-0012/0027), allocates a per-session cancel token
/// (ADR-0021), binds them to a backend-generated id (UUID v4), and returns the
/// id. The id <-> resource binding is atomic (the id is minted only after the
/// instance exists and the insert lands -- no "id issued, resource unbuilt"
/// window, ADR-0056 Why 2). This is the `+ tab` action; the frontend tracks the
/// returned id and passes it as the first parameter to every session-scoped
/// command. The returned id is the typed [`SessionId`] Display string (the
/// wire form the frontend stores and replays).
#[tauri::command]
pub fn create_session(
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
) -> Result<String, SessionError> {
    let cancel = Arc::new(CancelToken::new());
    // The real LLM provider (ADR-0007/0064): a LiveProvider router that reads
    // the active profile's protocol per turn and dispatches to the anthropic
    // or openai adapter. Reads the API key from the OS keychain and the
    // endpoint config from app-config (ADR-0038) via the shared
    // LiveProviderConfig. A fresh session starts usable once a key is stored;
    // before that every turn refuses honestly as not-wired.
    let provider = Box::new(crate::LiveProvider::new(live.inner().clone()));
    let id = store.create(cancel, provider)?;
    Ok(id.to_string())
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
#[tauri::command]
pub fn close_session(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    store.close(&id)?;
    Ok(())
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
    let sink = TauriApprovalSink::new(app.clone(), session_id.clone());
    let handle = Arc::clone(&handle);
    // The user's configured external MCP servers ride the turn (issue #301
    // slice C-gw): the gateway connects each one per turn (ADR-0076 Q2). A
    // cheap LiveProviderConfig clone (stateless keychain + PathBuf) carries the
    // keychain borrow into the spawn_blocking closure so get_mcp_secret can
    // read each server's secret env at spawn (ADR-0029 -- the value never
    // crosses IPC back out). mcp_servers is a fresh per-turn snapshot of the
    // app-config file; a config edit between turns is reflected next turn.
    let live = live.inner().clone();
    let mcp_servers = live.mcp_servers();
    // Issue #301 slice D, AC#3 + #369: the effective enabled set is computed
    // inside the closure (below) so it can fold in skill-declared servers.
    // `enabled_mcp` (the user's toggle set) is read here from the handle; the
    // skill-declared ids are resolved from the mounted set inside the closure.
    // The session lock is held inside the closure, so the mounted set cannot
    // change between the read and the turn.
    let enabled = handle.enabled_mcp_servers();
    // ADR-0059: build the side-channel `turn-progress` emit callback here at the
    // command boundary (the only layer allowed to hold a Tauri AppHandle,
    // ADR-0029) and inject it into the turn via Session::ask_with_phase. Each
    // discrete event (Thinking + the tool-call started/completed stream,
    // ADR-0078) is emitted addressed by sessionId so a multi-session frontend
    // filters the global broadcast to its own pane (ADR-0056/0059). Cloning
    // AppHandle + the id string is cheap; the closure is FnMut (called once
    // per wait boundary + per tool call, across every loop step).
    let app_for_cb = app.clone();
    let sid = session_id.clone();
    // Clone the skills-root path off the managed State so it can move into the
    // spawn_blocking closure (the State borrow does not cross the await). The
    // registry root is read below to resolve each mounted skill's SKILL.md body
    // + whole-file SHA-256 for prompt injection + provenance (issue #364).
    let skills_root = skills_root.0.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        // Issue #353: feed the session's runtime choice into the turn's
        // dispatch at the turn boundary. The choice lives on the handle
        // (lock-light writes via set_session_runtime); the Session consumes
        // it for THIS turn only -- a switch lands between turns, never
        // mid-turn, and a resumed Session (fresh, built-in default) reads
        // the reset choice.
        s.set_external_runtime(handle.runtime_choice());
        // Issue #364 (ADR-0086): resolve the session's mounted skills into
        // prompt fragments (name + verbatim body + whole-file SHA-256) here
        // at the command boundary, where the registry root lives, so the
        // session stays I/O-free for skill content (it consumes fragments,
        // mirroring the mcp_servers "data passed in" pattern). The session
        // lock is held, so the mounted set cannot change between this read
        // and the turn.
        let mounted = s.mounted_skills();
        let skill_fragments = resolve_prompt_fragments(&skills_root, &mounted);
        // Issue #369: mirror the mounted-skills snapshot onto the handle so
        // `list_mcp_server_status` stays lock-light (it reads the snapshot
        // instead of taking this lock, which an in-flight turn holds).
        handle.set_mounted_skills_snapshot(mounted.clone());
        // Issue #369: compute the effective MCP set = enabled_mcp (user intent)
        // ∪ (skill-declared ids ∩ globally configured). Reuse
        // [`resolve_skill_mcp_map`] so the skill→id mapping has one source of
        // truth (shared with `list_mcp_server_status`). Mount/unmount does not
        // change enabled_mcp -- the skill contribution is a computed layer
        // recalculated each turn.
        let skill_mcp = resolve_skill_mcp_map(&skills_root, &mounted);
        let active: Vec<McpServerConfig> = mcp_servers
            .iter()
            .filter(|srv| enabled.contains(&srv.id) || skill_mcp.contains_key(&srv.id.0))
            .cloned()
            .collect();
        let inputs = TurnInputs {
            mcp_servers: &active,
            keychain: live.keychain(),
            skills: &skill_fragments,
        };
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
        // Issue #301 slice D: mirror the Session's last-turn connect cache into
        // the handle so list_mcp_server_status is lock-light (it never takes
        // the session lock an in-flight turn holds). Done while s is still
        // locked -- the write touches only the handle's own Mutex, no
        // session-lock re-entry.
        handle.set_last_mcp_connect(s.last_mcp_connect().to_vec());
        Ok::<TurnOutcome, SessionError>(outcome)
    })
    .await
    .map_err(|e| SessionError::Engine(e.to_string()))??;
    Ok(outcome)
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
/// typed `SessionError::Turn(TurnError)` (issue #121).
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
            .map_err(SessionError::Turn)
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
    live.set_key(&key)
        .map_err(StoreCommandError::KeychainFailure)
}

/// Remove the stored API key. Idempotent: a missing entry is success; a real
/// keychain error propagates so the frontend can tell the user the key did not
/// come out. After a successful clear, the active profile's `has_key` is false
/// and the next turn refuses honestly as not-wired.
#[tauri::command]
pub fn clear_api_key(live: State<'_, LiveProviderConfig>) -> Result<(), StoreCommandError> {
    live.clear_key().map_err(StoreCommandError::KeychainFailure)
}

/// Read the effective provider endpoint + the active profile's key status
/// (ADR-0019/0029/0038/0064). The base URL + model come from the ACTIVE profile
/// in app-config; the key does not cross IPC -- only a boolean + a keychain
/// read-fault detail, from the active profile's keychain slot
/// `key-<active_profile_id>` (issue #275: a read fault rides `keychain_fault`
/// so the header indicator renders "keychain unavailable", not "no key").
#[tauri::command]
pub fn get_provider_config(
    live: State<'_, LiveProviderConfig>,
) -> Result<ProviderConfigView, String> {
    let cfg = live.load();
    // view() shares the active-missing fallback with the live provider read
    // path, so the IPC never hands the frontend "" (ADR-0019/0029/0064).
    Ok(cfg.provider.view(live.has_key()))
}

/// Save the non-secret provider config (ADR-0019/0038/0064) into app-config --
/// the multi-profile shape `{profiles, active_profile}`. normalize clamps the
/// active profile's empty endpoint fields to the canonical defaults and
/// repairs an empty profiles list / dangling active id, so the stored config is
/// always valid. The API key never enters this path (ADR-0029/0038: key confined
/// to the OS keychain; app-config has no key field at all).
#[tauri::command]
pub fn set_provider_config(
    live: State<'_, LiveProviderConfig>,
    config: ProviderConfig,
) -> Result<ProviderConfigView, StoreCommandError> {
    let mut cfg = live.load();
    cfg.provider = config;
    let stored = live
        .store(cfg)
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

/// Remove the MCP server with the given id from app-config (issue #301).
/// Idempotent: a missing id is success. Does NOT clear the server's keychain
/// secrets (the frontend orchestrates clear-then-remove).
#[tauri::command]
pub fn remove_mcp_server(
    live: State<'_, LiveProviderConfig>,
    id: McpServerId,
) -> Result<(), StoreCommandError> {
    live.remove_mcp_server(&id)
        .map_err(|e| StoreCommandError::ConfigWriteFailure(e.to_string()))
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
            let mut client = crate::mcp::client::connect_transport(&server_for_blocking, &secrets)?;
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
) -> Result<Vec<crate::mcp::import::DiscoveredServer>, String> {
    crate::mcp::import::discover(source)
}

/// Why a server is enabled in this session (issue #369). Distinguishes
/// user-toggled from skill-declared so the "+" panel renders three states:
/// off (`None`) / on-user (`User`, toggle off allowed) / on-skill (`Skill`,
/// read-only with a "via skill `<name>`" label). v1 does not let the user
/// override a skill's enablement.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum McpEnabledSource {
    /// Enabled by the user via the "+" panel toggle.
    User,
    /// Enabled by a mounted skill's `metadata.toptopduck_mcp_servers`.
    /// `name` is the skill that brought the server in (for the "via skill"
    /// label). When multiple skills declare the same server, the first-mounted
    /// skill wins the label.
    Skill { name: String },
}

/// One row of the per-session MCP server status (issue #301 slice D, AC#3).
/// The UI renders every configured server with its on/off toggle state + its
/// last connect outcome + tool count. Joined at the command boundary from
/// app-config (the full registry) + the handle's enablement set + the last
/// turn's connect cache.
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpServerStatusEntry {
    /// The server's stable id (matches `McpServerConfig::id`).
    pub id: McpServerId,
    /// The renamable display label.
    pub display_name: String,
    /// Whether this session has the server in the EFFECTIVE enabled set -- user
    /// OR skill (issue #369). `false` when neither source enabled it.
    pub enabled: bool,
    /// The enablement source (issue #369): `None` when disabled, `User` when
    /// user-toggled, `Skill { name }` when skill-declared. When both sources
    /// enable the same server, skill takes priority (v1 read-only).
    pub source: Option<McpEnabledSource>,
    /// Whether the last turn's connect_all succeeded for this server. `false`
    /// when the server is enabled-but-failed or has not connected yet this
    /// session (cache miss).
    pub connected: bool,
    /// The tool count the server advertised at the last connect (0 when not
    /// connected).
    pub tool_count: usize,
    /// The tool list the server advertised at the last connect (empty when not
    /// connected). The settings page renders this in the expandable per-row
    /// detail (issue #387).
    pub tools: Vec<crate::mcp::aggregator::McpToolInfo>,
    /// The last connect's error message (`None` on success or when not
    /// attempted).
    pub error: Option<String>,
}

/// Toggle one MCP server's enabled state for this session (issue #301 slice D,
/// AC#3). Server granularity: enabling a server includes all its tools in the
/// next turn's aggregated tool table; disabling drops them all. The toggle
/// takes effect on the next turn -- per-turn spawn (ADR-0076 Q2) means no live
/// connection to tear down. Resume resets the set to empty (the user re-enables
/// explicitly, ADR-0080 lineage).
#[tauri::command]
pub fn toggle_mcp_server(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    server_id: McpServerId,
    enabled: bool,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    handle.set_mcp_enabled(server_id, enabled);
    Ok(())
}

/// List every configured MCP server with this session's effective enablement +
/// last connect outcome (issue #301 slice D AC#3, extended #369 for skill
/// sources). Lock-light: reads the handle's mirrored mounted-skills snapshot +
/// enablement set + connect cache, never the session lock (an in-flight turn
/// holds it). Resolves each mounted skill's `metadata.toptopduck_mcp_servers`
/// via the snapshot to build a server-id → skill-name map. A server enabled by
/// either the user toggle set OR a mounted skill is `enabled: true`; the
/// `source` field distinguishes user-toggled (`User`) from skill-declared
/// (`Skill { name }`). When both sources enable the same server, skill takes
/// priority (v1 read-only, issue #369 spec). A configured-but-not-enabled
/// server appears with `enabled: false` + `source: None`; an enabled server
/// that has not connected yet this session (or whose last connect failed)
/// surfaces `connected: false` via the cache miss.
#[tauri::command]
pub fn list_mcp_server_status(
    store: State<'_, Arc<SessionStore>>,
    live: State<'_, LiveProviderConfig>,
    skills_root: State<'_, SkillsRoot>,
    session_id: String,
) -> Result<Vec<McpServerStatusEntry>, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let enabled = handle.enabled_mcp_servers();
    let last_connect = handle.last_mcp_connect();
    // Issue #369: read the mirrored mounted-skills snapshot (lock-light --
    // never takes the session lock). The snapshot is updated on mount/unmount
    // and inside `ask`, so it is current outside an in-flight turn.
    let mounted = handle.mounted_skills_snapshot();
    let skill_mcp = resolve_skill_mcp_map(&skills_root.0, &mounted);
    let entries = live
        .mcp_servers()
        .into_iter()
        .map(|srv| {
            let user_enabled = enabled.contains(&srv.id);
            let skill_name = skill_mcp.get(&srv.id.0).cloned();
            // Skill takes priority for display (v1 read-only, issue #369).
            let source = if let Some(name) = skill_name {
                Some(McpEnabledSource::Skill { name })
            } else if user_enabled {
                Some(McpEnabledSource::User)
            } else {
                None
            };
            let result = last_connect.iter().find(|r| r.id == srv.id);
            McpServerStatusEntry {
                id: srv.id,
                display_name: srv.display_name,
                enabled: source.is_some(),
                source,
                connected: result.map(|r| r.connected).unwrap_or(false),
                tool_count: result.map(|r| r.tool_count).unwrap_or(0),
                tools: result.map(|r| r.tools.clone()).unwrap_or_default(),
                error: result.and_then(|r| r.error.clone()),
            }
        })
        .collect();
    Ok(entries)
}

/// Run a connection preflight against the named profile (ADR-0070, issue
/// #236). Reads the profile's stored key from the OS keychain by `profile_id`
/// (ADR-0029 -- the key never crosses IPC) and probes the caller-supplied
/// endpoint (`protocol` + `base_url` + `model` = the frontend's current edit
/// values, so a user who edits base_url and re-tests does not have to save
/// first) via `GET /models` with a minimal-turn ping fallback. A failed
/// keychain read short-circuits to `KeychainUnavailable` before any HTTP
/// (issue #243 -- previously swallowed into `None` and misclassified as
/// `KeyRejected`). Returns the six-state [`ProfileTestOutcome`] so the
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
) -> Result<ProfileTestOutcome, String> {
    let live = live.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let id = ProfileId(profile_id);
        let key_read = live.key_for_profile(&id);
        crate::provider::preflight::run(key_read, protocol, &base_url, &model)
    })
    .await
    .map_err(|e| format!("test_profile task failed: {e}"))
}

// --- App-level config (issue #53, ADR-0038) --------------------------------
//
// The second at-rest artifact: preferences, defaults, recent files, and the
// no-key endpoint config. Lives in the OS app-data directory, orthogonal to
// the portable `.duck`. Honest-degrades to defaults on any read failure
// (missing/corrupt -> built-in defaults, never a crash). The frontend loads it
// on startup (theme + recent files) and persists edits through `set_app_config`.

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

/// Record a recently-opened `.duck` path into the app-config recent-files list
/// (issue #53). Read-modify-write: load, unshift + dedupe + trim, persist.
/// Returns nothing -- the list is advisory; a write failure is swallowed inside
/// [`LiveProviderConfig::record_recent_file`] rather than failing the open.
#[tauri::command]
pub fn record_recent_file(live: State<'_, LiveProviderConfig>, path: String) -> Result<(), String> {
    live.record_recent_file(&path);
    Ok(())
}

/// List every persisted `.duck` session's metadata for the cold-start left
/// sidebar (ADR-0060/0061, issue #76). Reads the app-config `recent_files`
/// paths and derives each entry's metadata from its recipe + file mtime --
/// zero new persistence. A path that is no longer a readable recipe is skipped
/// (the listing never fabricates metadata). Thin wrapper over the pure
/// [`list_session_metadata`] so the derivation stays black-box testable.
///
/// Runs the per-entry file reads off the async/UI thread (AC8): each recent
/// entry pays a `read_duck` (file read + JSON parse) plus a `metadata` stat,
/// so the whole pass runs in `spawn_blocking` like `read_rows` / `ingest_file`
/// -- a cold start over slow or network-mounted storage must not freeze the
/// main window while the sidebar list is being derived.
#[tauri::command]
pub async fn list_sessions(
    live: State<'_, LiveProviderConfig>,
) -> Result<Vec<SessionMetadata>, String> {
    let live = live.inner().clone();
    let list = tauri::async_runtime::spawn_blocking(move || {
        let recent = live.load().recent_files;
        list_session_metadata(&recent)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(list)
}

/// Delete a persisted `.duck` session file (ADR-0060, issue #81). The frontend
/// closes the session FIRST when it is open (so no canonical-writer key is held
/// and the in-memory instance is gone), then calls this. Removes the file and
/// drops the path from recent_files so the next `list_sessions` no longer lists
/// it. Irreversible -- the frontend gates it behind a strong confirm that names
/// the .duck explicitly.
///
/// A missing file is NOT an error: the outcome the user wants (the session is
/// gone from the sidebar) already holds, and an idempotent delete tolerates a
/// stray double-call. Any OTHER removal failure (permission denied, path busy,
/// an external file handle) IS surfaced -- swallowing it would betray the
/// strong-confirm contract by silently leaving the file on disk, only for it to
/// reappear in the sidebar on the next launch.
///
/// The canonical-writer gate mirrors `rename_persisted_session`: a held key
/// means an open in-memory session owns this path, so a file-level delete would
/// race its writer and is refused. The frontend closes first; this is the
/// backend guard for a broken frontend contract (a second window, an IPC
/// replay). Runs the file IO off the async/UI thread (AC8), like
/// `rename_persisted_session` and `list_sessions`.
#[tauri::command]
pub async fn delete_session(
    live: State<'_, LiveProviderConfig>,
    path: String,
) -> Result<(), StoreCommandError> {
    use crate::persistence::{canonicalize_duck, release, try_acquire};
    let live = live.inner().clone();
    let trimmed = path.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), StoreCommandError> {
        if trimmed.is_empty() {
            return Ok(());
        }
        let path = PathBuf::from(&trimmed);
        // Canonicalize for the single-writer gate. canonicalize_duck succeeds
        // even when the file itself is gone (it canonicalizes the parent dir
        // and rejoins the file name), so an Err here means the parent is gone
        // too -- the file is definitely absent; treat as idempotent success.
        let canonical = match canonicalize_duck(&path) {
            Ok(c) => c,
            Err(_) => {
                live.remove_recent_file(&trimmed);
                return Ok(());
            }
        };
        // Gate: a held canonical key means an open session owns this path.
        if !try_acquire(&canonical) {
            return Err(StoreCommandError::OpenConflict);
        }
        let outcome = match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreCommandError::IoFailure(e.to_string())),
        };
        release(&canonical);
        // Drop from recent_files only when the file is actually gone -- a
        // failed remove leaves the .duck on disk, so recent_files must stay
        // consistent with it (and the caller already received the error).
        if outcome.is_ok() {
            live.remove_recent_file(&trimmed);
        }
        outcome
    })
    .await
    .map_err(|e| StoreCommandError::IoFailure(e.to_string()))?
}

/// Rename the OPEN session bound to `session_id` (ADR-0060, issue #81). Sets the
/// user-facing session_name and rewrites the bound `.duck` recipe header; the
/// bound path is untouched, so recent_files / sidebar addressing stay stable.
/// Rejects a blank name. For a never-saved (unbound) session the name is held in
/// memory and carried by the next save-as. Delegates to [`Session::rename`].
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

/// Bind the named session to a `.duck` path and write one recipe immediately
/// (ADR-0034). After this every terminal turn / source event atomically
/// rewrites the recipe. Synchronous: a small whole-file rewrite.
#[tauri::command]
pub fn save_as_duck(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    path: String,
    session_name: String,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.bind_duck(PathBuf::from(path), session_name)
        .map_err(|e| SessionError::Engine(e.to_string()))
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
    let sid = session_id.clone();
    let inner = tauri::async_runtime::spawn_blocking(move || {
        let mut new_session = Session::open_duck(
            &path,
            cancel_token,
            provider,
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
        let mut s = handle_for_task.session_lock()?;
        *s = new_session;
        // ADR-0080 (issue #294): resume 归零. Trust state is session-level and
        // must not survive a resume (it is not in the recipe / app-config), so
        // the moment the resumed contents are live, drop the authorization
        // mode + trust set back to the default PerCall posture. Reset is
        // independent of the session swap -- the approval state lives on the
        // handle, not inside the Session mutex.
        handle_for_task.reset_approval();
        // Issue #301 slice D, AC#3: reset the per-session MCP server
        // enablement + connect cache alongside the approval posture. The
        // enablement is session-level (not in the recipe / app-config), so a
        // resumed session starts at the default empty set -- the user re-
        // enables servers explicitly, mirroring how trust resets (ADR-0080).
        handle_for_task.reset_mcp_enablement();
        // Issue #353: reset the per-session runtime choice alongside the
        // approval posture + MCP enablement. The runtime is a session-level
        // assembly posture (not in the recipe / app-config), so a resumed
        // session starts on the built-in default -- the user re-picks an
        // external runtime explicitly (the ADR-0080 reset lineage).
        handle_for_task.reset_runtime_choice();
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
    session_id: String,
}

impl TauriApprovalSink {
    pub fn new(app: tauri::AppHandle, session_id: String) -> Self {
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
/// ADR-0083): the stable id (the `set_session_runtime` key), the display name
/// (the row label), and the current PATH-scan detection state. Detected rows
/// are selectable; undetected rows render disabled + "not installed" -- the
/// picker never hardcodes the list, it renders this table verbatim.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AdapterEntry {
    /// The adapter's stable id (provenance + set key; [`AdapterSpec::id`]).
    pub id: String,
    /// Human-readable picker label ([`AdapterSpec::display_name`]).
    pub display_name: String,
    /// Whether the PATH scan resolved one of the adapter's binary names.
    pub detected: bool,
}

/// Project every v1 adapter to a picker entry with a FRESH PATH-scan
/// detection state (ADR-0083). Detection is deliberately uncached -- the
/// composer re-scans on demand (the user may install a CLI between scans) --
/// so `list_adapters` and `rescan_adapters` share this one projection.
fn scan_adapters() -> Vec<AdapterEntry> {
    v1_adapters()
        .iter()
        .map(|spec| AdapterEntry {
            id: spec.id.as_str().to_string(),
            display_name: spec.display_name.to_string(),
            detected: detect_adapter(spec).is_some(),
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

/// Read the session's runtime selection (issue #353). Lock-light: reads the
/// handle's choice, never the session lock an in-flight turn holds. Returns
/// the built-in default for a fresh / resumed session.
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
/// the in-flight turn, if any, finishes on the runtime it started on. Selecting an unknown adapter
/// id rejects (the picker only offers `list_adapters` ids). Rejected while
/// resuming (the session contents are mid-swap).
#[tauri::command]
pub fn set_session_runtime(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    runtime: SessionRuntimeChoice,
) -> Result<(), SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let spec = resolve_runtime_choice(runtime)?;
    handle.set_runtime_choice(spec);
    Ok(())
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
pub fn list_skills(root: State<'_, SkillsRoot>) -> SkillListing {
    crate::skills::registry::list_skills(&root.0)
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
    name: String,
    update: SkillUpdate,
) -> Result<SkillEntry, SkillError> {
    crate::skills::registry::update_skill(&root.0, &name, update)
}

/// Delete a skill from the registry (issue #362). A `local` skill's directory
/// is removed with all its contents; a `linked` skill's LINK is removed
/// without touching the external source directory.
#[tauri::command]
pub fn delete_skill(root: State<'_, SkillsRoot>, name: String) -> Result<(), SkillError> {
    crate::skills::registry::delete_skill(&root.0, &name)
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
    let existing: std::collections::HashSet<String> = crate::skills::registry::list_skills(&root.0)
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
/// declarations).
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
    // Issue #369: mirror the updated mounted-skills set onto the handle so
    // `list_mcp_server_status` stays lock-light.
    handle.set_mounted_skills_snapshot(s.mounted_skills());
    // Issue #369 AC#5: warn for declared MCP server ids not in the global
    // registry. The mount already succeeded (the skill is live for prompt
    // injection); the unknown ids are simply skipped in the effective set.
    drop(s);
    warn_unknown_mcp_ids(&live, &skills_root.0, &name);
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
    // Issue #369: mirror the updated mounted-skills set onto the handle so
    // `list_mcp_server_status` stays lock-light.
    handle.set_mounted_skills_snapshot(s.mounted_skills());
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

/// Resolve the mounted skills' declared MCP server ids into a server-id →
/// skill-name map (issue #369). Used by [`list_mcp_server_status`] to compute
/// each configured server's enablement source. A server declared by multiple
/// skills is mapped to the first-mounted skill's name (mount order preserved
/// by [`Session::mounted_skills`]). A skill whose `SKILL.md` is unreadable or
/// whose frontmatter is unparseable contributes nothing -- the resolution
/// reuses [`resolve_prompt_fragments`] which degrades honestly (empty
/// `mcp_servers` on failure).
fn resolve_skill_mcp_map(root: &Path, mounted: &[String]) -> HashMap<String, String> {
    let fragments = resolve_prompt_fragments(root, mounted);
    let mut map = HashMap::new();
    for frag in fragments {
        for id in &frag.mcp_servers {
            // First-mounted skill wins the label (insertion order from
            // mounted_skills is preserved by resolve_prompt_fragments).
            map.entry(id.clone()).or_insert_with(|| frag.name.clone());
        }
    }
    map
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_store::UNKNOWN_SESSION;
    use crate::CancelToken;

    /// The per-session resume guard rejects a mutating command while THAT
    /// session is resuming. Pin the rejection branch itself (the happy path is
    /// exercised implicitly by every command that drives a live session).
    #[test]
    fn reject_if_resuming_blocks_while_the_session_is_resuming() {
        let store = SessionStore::new();
        let cancel = Arc::new(CancelToken::new());
        let id = store
            .create(cancel, Box::new(crate::UnwiredProvider))
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
            )
            .expect("create a");
        let b = store
            .create(
                Arc::new(CancelToken::new()),
                Box::new(crate::UnwiredProvider),
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
            .create(cancel, Box::new(crate::UnwiredProvider))
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
    /// carrying its id + display name + a fresh PATH-scan detection flag. The
    /// composer picker renders this table verbatim -- a CLI added upstream
    /// never touches the picker.
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
            assert_eq!(
                entry.detected,
                detect_adapter(spec).is_some(),
                "detected mirrors the live PATH scan"
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
}
