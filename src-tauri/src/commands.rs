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

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::{Emitter, State};

use crate::app_config::AppConfig;
use crate::cancel::CancelToken;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadOutcome, ProviderConfig, ProviderConfigView,
    RemoveSourceError, RowPage, SheetGuidance, ThreadEntry, TurnOutcome, TurnProgress,
};
use crate::persistence::{list_session_metadata, SaveError, SessionMetadata};
use crate::provider::live_config::LiveProviderConfig;
use crate::session::{RenameSessionError, ResumeEvent, ResumeProgress, Session};
use crate::session_store::{SessionError, SessionHandle, SessionId, SessionStore};

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
    // The real LLM provider (ADR-0007): reads the API key from the OS keychain
    // and the endpoint config from app-config (ADR-0038) via the shared
    // LiveProviderConfig. A fresh session starts usable once a key is stored;
    // before that every turn refuses honestly as not-wired.
    let provider = Box::new(crate::AnthropicProvider::new(Box::new(
        live.inner().clone(),
    )));
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

/// Ask one question (PRD #1) against the named session: run one turn and
/// return its ADR-0028 outcome (result / textual / failed / cancelled). The
/// single retry budget is consumed invisibly inside the turn. Runs off the
/// async/UI thread (AC8) so a slow provider never freezes the app. A turn
/// always produces an outcome; the only `Err` here is an unknown session, a
/// resume guard rejection, an in-flight guard rejection, or a session-lock
/// failure (not a turn failure -- that is a `Failed` outcome). ADR-0055: if the
/// session was closed while this turn was in flight, the outcome is discarded
/// inside `Session::ask` (no thread append, no recipe persist).
#[tauri::command]
pub async fn ask(
    app: tauri::AppHandle,
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    question: String,
) -> Result<TurnOutcome, SessionError> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    reject_if_in_flight(&handle)?;
    let handle = Arc::clone(&handle);
    // ADR-0059: build the side-channel `turn-progress` emit callback here at the
    // command boundary (the only layer allowed to hold a Tauri AppHandle,
    // ADR-0029) and inject it into the turn via Session::ask_with_phase. Each
    // discrete phase (Thinking / Querying) is emitted addressed by sessionId so
    // a multi-session frontend filters the global broadcast to its own pane
    // (ADR-0056/0059). Cloning AppHandle + the id string is cheap; the closure
    // is FnMut (called once per phase boundary, fires across blind retries).
    let app_for_cb = app.clone();
    let sid = session_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        Ok::<TurnOutcome, SessionError>(s.ask_with_phase(&question, move |phase| {
            let _ = app_for_cb.emit(
                "turn-progress",
                &TurnProgress {
                    session_id: sid.clone(),
                    phase,
                },
            );
        }))
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
    Ok(s.conversation().to_vec())
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

/// Whether an API key is stored. Returns a boolean only -- never the key
/// itself (ADR-0029 invariant 3). The frontend uses this to decide whether to
/// prompt for configuration before the first turn.
#[tauri::command]
pub fn has_api_key(live: State<'_, LiveProviderConfig>) -> Result<bool, String> {
    Ok(live.has_key())
}

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
/// come out. After a successful clear, `has_api_key` is false and the next turn
/// refuses honestly as not-wired.
#[tauri::command]
pub fn clear_api_key(live: State<'_, LiveProviderConfig>) -> Result<(), StoreCommandError> {
    live.clear_key().map_err(StoreCommandError::KeychainFailure)
}

/// Read the effective provider endpoint + whether a key is set (ADR-0019/0029/
/// 0038/0064). The base URL + model come from the ACTIVE profile in app-config;
/// the key does not cross IPC (only the boolean, from the active profile's
/// keychain slot `key-<active_profile_id>`).
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

// --- App-level config (issue #53, ADR-0038) --------------------------------
//
// The second at-rest artifact: preferences, defaults, window geometry, recent
// files, and the no-key endpoint config. Lives in the OS app-data directory,
// orthogonal to the portable `.duck`. Honest-degrades to defaults on any read
// failure (missing/corrupt -> built-in defaults, never a crash). The frontend
// loads it on startup (theme + window geometry + recent files) and persists
// edits through `set_app_config`.

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
    // (ADR-0007): the real Anthropic client reading the key from the OS keychain
    // and the endpoint from app-config (ADR-0038), via the shared
    // LiveProviderConfig. Resume itself is LLM-free (it re-executes stored SQL),
    // but the next new turn after resume must reach a live provider -- so the
    // provider is wired at open time, not deferred.
    let provider = Box::new(crate::AnthropicProvider::new(Box::new(
        live.inner().clone(),
    )));
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
        // TurnRunner internally); the handle shares the same Arc<CancelToken>.
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
}
