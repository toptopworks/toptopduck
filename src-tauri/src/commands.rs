//! Tauri command boundary (frontend <-> Rust). Thin wrappers over the
//! multi-session [`SessionStore`](crate::session_store::SessionStore) (ADR-0056):
//! every session-scoped command takes `session_id` as its first parameter,
//! parses it into a typed [`SessionId`] (a malformed id surfaces as
//! [`SessionError::InvalidId`], distinct from a closed session's
//! [`SessionError::NotFound`] -- issue #73), looks up the target
//! handle, and runs against it. The store lock is held only for the brief
//! lookup; long turns run against a cloned `Arc<SessionHandle>` with no store
//! lock held (ADR-0056 concurrency model). All command functions return
//! `Result<T, String>` for IPC (the frontend string-matches the error); the
//! typed [`SessionError`] is mapped to that string via `From<SessionError> for
//! String` so `?` propagates the exact wording.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Emitter, State};

use crate::app_config::AppConfig;
use crate::cancel::CancelToken;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadOutcome, ProviderConfig, ProviderConfigView, RowPage,
    SheetGuidance, ThreadEntry, TurnOutcome, TurnProgress,
};
use crate::persistence::{list_session_metadata, SessionMetadata};
use crate::provider::live_config::LiveProviderConfig;
use crate::session::{ResumeEvent, ResumeProgress, Session};
use crate::session_store::{SessionError, SessionHandle, SessionId, SessionStore};

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
) -> Result<String, String> {
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
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    store.close(&id)?;
    Ok(())
}

/// Ingest a file into the named session. Runs the DuckDB copy-in off the
/// async/UI thread (AC8: does not freeze the app) and returns the outcome
/// descriptor or a clear error.
#[tauri::command]
pub async fn ingest_file(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    path: String,
) -> Result<LoadOutcome, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let handle = Arc::clone(&handle);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        Ok::<LoadOutcome, String>(s.ingest(Path::new(&path)))
    })
    .await
    .map_err(|e| e.to_string())??;
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
) -> Result<LoadOutcome, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let handle = Arc::clone(&handle);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        Ok::<LoadOutcome, String>(s.ingest_guided(Path::new(&path), &guidance))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(outcome)
}

#[tauri::command]
pub fn list_working_set(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Vec<DatasetDescriptor>, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    Ok(s.list())
}

#[tauri::command]
pub fn active_dataset(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Option<DatasetDescriptor>, String> {
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
) -> Result<Option<DatasetDescriptor>, String> {
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
) -> Result<DatasetDescriptor, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.rename_display(&reference_name, &new_display)
        .map_err(|e| e.to_string())
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
) -> Result<LoadOutcome, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let handle = Arc::clone(&handle);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = handle.session_lock()?;
        Ok::<LoadOutcome, String>(s.replace_source(&reference_name, Path::new(&path)))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(outcome)
}

/// Set a dataset's privacy controls. See [`Session::set_privacy`]
/// -- this is the Tauri/IPC command boundary wrapper. Rejects an unknown
/// reference name with an error string.
#[tauri::command]
pub fn set_dataset_privacy(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    privacy: DatasetPrivacy,
) -> Result<DatasetDescriptor, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.set_privacy(&reference_name, privacy)
        .ok_or_else(|| format!("找不到引用名为「{reference_name}」的数据集"))
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
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.remove_source(&reference_name).map_err(|e| e.to_string())
}

/// Remove the ACTIVE source and repoint focus at an explicit continuation
/// source (issue #39, ADR-0035): the user-facing answer to `remove_source`'s
/// `IsActive` refusal. The frontend's confirm dialog picks `continue_with` from
/// the remaining sources; this command atomically switches the active pointer
/// to it, drops the removed source, and appends a `Deleted` event. Same
/// `HasDerivatives` guard as `remove_source` (-> #40). Refuses with
/// `NotActive`/`InvalidContinueWith` when the view raced a concurrent mutation
/// (the working set is left untouched in those cases). Surfaces all refusals as
/// a plain error string -- no typed `RemoveSourceError` crosses IPC (same shape
/// as rename / replace / remove_source).
#[tauri::command]
pub fn remove_active_source(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    continue_with: String,
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.remove_active_source(&reference_name, &continue_with)
        .map_err(|e| e.to_string())
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
) -> Result<TurnOutcome, String> {
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
        Ok::<TurnOutcome, String>(s.ask_with_phase(&question, move |phase| {
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
    .map_err(|e| e.to_string())??;
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
pub fn cancel(store: State<'_, Arc<SessionStore>>, session_id: String) -> Result<(), String> {
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
) -> Result<Vec<ThreadEntry>, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let s = handle.session_lock()?;
    Ok(s.conversation().to_vec())
}

/// Read one page of a dataset's rows from the named session (ADR-0024 windowed
/// display). Runs off the async/UI thread (AC8) like `ask`: a large OFFSET is
/// an O(offset) scan, so holding the session lock on the IPC path would block
/// every other command on that session. Rejects an unknown session, an unknown
/// reference name, or an engine error with an error string.
#[tauri::command]
pub async fn read_rows(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
    reference_name: String,
    offset: u64,
    limit: u64,
) -> Result<RowPage, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    let handle = Arc::clone(&handle);
    tauri::async_runtime::spawn_blocking(move || {
        let s = handle.session_lock()?;
        s.read_rows(&reference_name, offset, limit)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
pub fn set_api_key(live: State<'_, LiveProviderConfig>, key: String) -> Result<(), String> {
    live.set_key(&key)
}

/// Remove the stored API key. Idempotent: a missing entry is success; a real
/// keychain error propagates so the frontend can tell the user the key did not
/// come out. After a successful clear, `has_api_key` is false and the next turn
/// refuses honestly as not-wired.
#[tauri::command]
pub fn clear_api_key(live: State<'_, LiveProviderConfig>) -> Result<(), String> {
    live.clear_key()
}

/// Read the effective provider endpoint + whether a key is set (ADR-0019/0029/
/// 0038). The base URL + model cross IPC from app-config; the key does not (only
/// the boolean, from the keychain).
#[tauri::command]
pub fn get_provider_config(
    live: State<'_, LiveProviderConfig>,
) -> Result<ProviderConfigView, String> {
    let cfg = live.load();
    Ok(ProviderConfigView {
        base_url: cfg.provider.base_url,
        model: cfg.provider.model,
        has_key: live.has_key(),
    })
}

/// Save the non-secret provider endpoint (Anthropic-protocol base URL + model,
/// ADR-0019/0038) into app-config. Empty fields normalize to the v1 defaults so
/// the stored config is always valid (and `get_provider_config` then reads
/// consistent values). The API key never enters this path (ADR-0029/0038: key
/// confined to the OS keychain; app-config has no key field at all).
#[tauri::command]
pub fn set_provider_config(
    live: State<'_, LiveProviderConfig>,
    config: ProviderConfig,
) -> Result<ProviderConfigView, String> {
    let mut cfg = live.load();
    cfg.provider = config;
    let stored = live.store(cfg).map_err(|e| e.to_string())?;
    Ok(ProviderConfigView {
        base_url: stored.provider.base_url,
        model: stored.provider.model,
        has_key: live.has_key(),
    })
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
) -> Result<AppConfig, String> {
    live.store(config).map_err(|e| e.to_string())
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
/// the .duck explicitly. A missing file is NOT an error: the outcome the user
/// wants (the session is gone from the sidebar) already holds, and an idempotent
/// delete tolerates a stray double-call.
#[tauri::command]
pub fn delete_session(live: State<'_, LiveProviderConfig>, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if !trimmed.is_empty() {
        // Best-effort removal; a missing file is success (idempotent delete).
        let _ = std::fs::remove_file(trimmed);
    }
    live.remove_recent_file(trimmed);
    Ok(())
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
) -> Result<String, String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.rename(&new_name)
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
pub async fn rename_persisted_session(path: String, new_name: String) -> Result<(), String> {
    use crate::persistence::{canonicalize_duck, read_duck, release, save_atomic, try_acquire};
    let path = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let trimmed = new_name.trim();
        if trimmed.is_empty() {
            return Err("会话名不能为空".to_string());
        }
        let canonical = canonicalize_duck(&path).map_err(|e| e.to_string())?;
        // Gate: try_acquire returns false when the canonical path is already
        // held -- an open session owns it. Refuse rather than race its writer.
        if !try_acquire(&canonical) {
            return Err("该会话已打开，请在打开的会话中重命名".to_string());
        }
        let outcome = (|| -> Result<(), String> {
            let mut recipe = read_duck(&path).map_err(|e| e.to_string())?;
            recipe.session_name = trimmed.to_string();
            save_atomic(&path, &recipe).map_err(|e| e.to_string())
        })();
        release(&canonical);
        outcome
    })
    .await
    .map_err(|e| e.to_string())?
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
) -> Result<(), String> {
    let id = SessionId::parse(&session_id)?;
    let handle = store.get(&id)?;
    reject_if_resuming(&handle)?;
    let mut s = handle.session_lock()?;
    s.bind_duck(PathBuf::from(path), session_name)
        .map_err(|e| e.to_string())
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
) -> Result<(), String> {
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
        .map_err(|e| e.to_string())?;
        // Re-attach the handle's closing flag so a close_session after resume
        // still discards in-flight turns on this session (ADR-0055). The cancel
        // token was already shared via cancel_token above. The flag is the
        // monotonic ClosingFlag, so this re-attach preserves once-closing.
        new_session.set_closing_flag(closing_flag);
        let mut s = handle_for_task.session_lock()?;
        *s = new_session;
        Ok::<(), String>(())
    })
    .await;
    // Clear the per-session resume flag on EVERY exit (success, resume error,
    // join panic) before propagating -- a stuck flag would reject every later
    // mutating command on this session (ADR-0053).
    handle.set_resuming(false);
    inner.map_err(|e| e.to_string())??;
    Ok(())
}

/// Read + clear the named session's most recent per-turn persistence failure,
/// if any (ADR-0034/0035 honest signal). The frontend polls this after each
/// turn / source event / resume: a non-blocking unsaved-to-disk banner surfaces
/// the disk-vs-memory drift so the user knows a save dropped (instead of
/// relying on the next successful write to silently self-heal, which would mask
/// the window where closing the app loses the unsaved turns). Returns `None`
/// after a clean save or after a prior read cleared the failure.
#[tauri::command]
pub fn take_persist_error(
    store: State<'_, Arc<SessionStore>>,
    session_id: String,
) -> Result<Option<String>, String> {
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
) -> Result<Option<crate::PendingConflict>, String> {
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
}
