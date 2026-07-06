//! Tauri command boundary (frontend <-> Rust). Thin wrappers over [`Session`];
//! the ingest pipeline is the black box tested in tests/ingest_blackbox.rs, and
//! the ask -> result loop in tests/query_blackbox.rs (issue #22).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, State};

use crate::app_config::AppConfig;
use crate::cancel::CancelToken;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadOutcome, ProviderConfig, ProviderConfigView, RowPage,
    SheetGuidance, ThreadEntry, TurnOutcome,
};
use crate::provider::live_config::LiveProviderConfig;
use crate::session::{is_resuming, ResumeEvent, Session};

/// Reject a mutating command while a resume is in flight. The managed
/// `Arc<Mutex<Session>>` still holds the PRE-resume session while
/// [`Session::open_duck`] runs in `open_duck`'s `spawn_blocking`, so a
/// concurrent mutating command (`ask` / `ingest_file` / `ingest_file_guided`
/// / `replace_source` / `remove_source` / `remove_active_source` /
/// `rename_dataset` / `set_dataset_privacy` / `save_as_duck`) would silently
/// operate on the stale session and be overwritten when the resumed session
/// lands (`*s = new_session`). The frontend's shared `loading` flag is the
/// primary defense; this check is the Rust-side backstop for races the
/// frontend cannot see (a second window, an IPC replay). It SHRINKS the
/// window, not closes it: the flag is sampled before the session lock is
/// taken, so a resume that lands in between lets the command proceed against
/// the resumed session (correct) rather than reject. Returns a user-facing
/// Chinese error so a rejected call surfaces honestly rather than appearing
/// to succeed then vanishing.
fn reject_if_resuming() -> Result<(), String> {
    if is_resuming() {
        return Err("正在恢复会话，请稍候再操作".into());
    }
    Ok(())
}

/// Ingest a file. Runs the DuckDB copy-in off the async/UI thread (AC8: does not
/// freeze the app) and returns the outcome descriptor or a clear error.
#[tauri::command]
pub async fn ingest_file(
    state: State<'_, Arc<Mutex<Session>>>,
    path: String,
) -> Result<LoadOutcome, String> {
    reject_if_resuming()?;
    let session = state.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = session.lock().map_err(|e| e.to_string())?;
        Ok::<LoadOutcome, String>(s.ingest(Path::new(&path)))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(outcome)
}

/// Re-ingest an Excel workbook with the user's guided rectify choices
/// (ADR-0015/0042). Called after a `NeedsGuidance` outcome once the UI has
/// gathered header/skip choices per sheet. Runs off the async/UI thread (AC8).
#[tauri::command]
pub async fn ingest_file_guided(
    state: State<'_, Arc<Mutex<Session>>>,
    path: String,
    guidance: Vec<SheetGuidance>,
) -> Result<LoadOutcome, String> {
    reject_if_resuming()?;
    let session = state.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = session.lock().map_err(|e| e.to_string())?;
        Ok::<LoadOutcome, String>(s.ingest_guided(Path::new(&path), &guidance))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(outcome)
}

#[tauri::command]
pub fn list_working_set(
    state: State<'_, Arc<Mutex<Session>>>,
) -> Result<Vec<DatasetDescriptor>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.list())
}

#[tauri::command]
pub fn active_dataset(
    state: State<'_, Arc<Mutex<Session>>>,
) -> Result<Option<DatasetDescriptor>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.active())
}

#[tauri::command]
pub fn get_dataset(
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
) -> Result<Option<DatasetDescriptor>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.get(&reference_name))
}

/// Rename a dataset's display label (ADR-0037, slice 4a issue #8): display-only
/// -- the reference name is untouched, so SQL / recipe / active references stay
/// valid. Synchronous: no copy-in, just an in-memory label swap. Rejects an
/// unknown reference or a label already shown by another dataset.
#[tauri::command]
pub fn rename_dataset(
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
    new_display: String,
) -> Result<DatasetDescriptor, String> {
    reject_if_resuming()?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.rename_display(&reference_name, &new_display)
        .map_err(|e| e.to_string())
}

/// Re-upload a file onto an existing dataset's reference name (ADR-0042, issue
/// #11 slice 4b): a fresh snapshot takes over the name and the old one is
/// discarded. Distinct entry from `ingest_file` (add) -- the reference name to
/// take over is explicit. Runs the copy-in off the async/UI thread (AC8).
#[tauri::command]
pub async fn replace_source(
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
    path: String,
) -> Result<LoadOutcome, String> {
    reject_if_resuming()?;
    let session = state.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = session.lock().map_err(|e| e.to_string())?;
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
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
    privacy: DatasetPrivacy,
) -> Result<DatasetDescriptor, String> {
    reject_if_resuming()?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.set_privacy(&reference_name, privacy)
        .ok_or_else(|| format!("找不到引用名为「{reference_name}」的数据集"))
}

/// Remove a source Dataset from the working set (issue #38/#39, ADR-0040).
/// Detaches the snapshot, deletes its file, drops the reference name from the
/// shared namespace, and appends a `Deleted` source lifecycle event to the
/// thread. Refuses removal while materialized results exist (→ #40 cascade),
/// and refuses the ACTIVE source when OTHER sources remain (ADR-0035 → issue
/// #39: no silent focus jump -- the caller must use `remove_active_source` to
/// name an explicit continuation). The LAST active source is allowed through
/// here to an empty working set (AC4, issue #39). Synchronous: the session
/// Mutex serializes this against an in-flight turn (correctness), and the
/// frontend additionally disables source management via its shared `loading`
/// flag during the ADR-0040 execution window (UX) -- the two layers are
/// independent. The only I/O is a best-effort DETACH + remove_file.
#[tauri::command]
pub fn remove_source(
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
) -> Result<(), String> {
    reject_if_resuming()?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.remove_source(&reference_name).map_err(|e| e.to_string())
}

/// Remove the ACTIVE source and repoint focus at an explicit continuation
/// source (issue #39, ADR-0035): the user-facing answer to `remove_source`'s
/// `IsActive` refusal. The frontend's confirm dialog picks `continue_with` from
/// the remaining sources; this command atomically switches the active pointer
/// to it, drops the removed source, and appends a `Deleted` event. Same
/// `HasDerivatives` guard as `remove_source` (→ #40). Refuses with
/// `NotActive`/`InvalidContinueWith` when the view raced a concurrent mutation
/// (the working set is left untouched in those cases). Surfaces all refusals as
/// a plain error string -- no typed `RemoveSourceError` crosses IPC (same shape
/// as rename / replace / remove_source).
#[tauri::command]
pub fn remove_active_source(
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
    continue_with: String,
) -> Result<(), String> {
    reject_if_resuming()?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.remove_active_source(&reference_name, &continue_with)
        .map_err(|e| e.to_string())
}

/// Ask one question (PRD #1): run one turn and return its ADR-0028 outcome
/// (result / textual / failed / cancelled). The single retry budget is consumed
/// invisibly inside the turn. Runs off the async/UI thread (AC8) so a slow
/// provider never freezes the app. A turn always produces an outcome; the only
/// `Err` here is a session-lock failure (not a turn failure -- that is a
/// `Failed` outcome).
#[tauri::command]
pub async fn ask(
    state: State<'_, Arc<Mutex<Session>>>,
    question: String,
) -> Result<TurnOutcome, String> {
    reject_if_resuming()?;
    let session = state.inner().clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut s = session.lock().map_err(|e| e.to_string())?;
        Ok::<TurnOutcome, String>(s.ask(&question))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(outcome)
}

/// Cancel the in-flight turn (ADR-0021, issue #28). Fires the shared cancel
/// token, which sets the cooperative flag AND interrupts the running DuckDB
/// query; the in-flight `ask` lands as a Cancelled outcome at its next check.
/// Crucially this does NOT take the session lock -- `ask` holds it for the whole
/// turn, so cancel reaches the token through a separate managed `Arc`. Safe when
/// no turn is in flight (sets a flag the next `ask` resets before it starts).
/// Always succeeds: cancel is a best-effort signal, not a transaction.
#[tauri::command]
pub fn cancel(cancel: State<'_, Arc<CancelToken>>) -> Result<(), String> {
    cancel.request();
    Ok(())
}

/// Read the conversation thread (ADR-0028/0039/0040): the unified timeline of
/// turns AND source lifecycle events, in order. Synchronous -- a snapshot read
/// of the session history with no copy-in. The frontend renders this as the
/// always-visible thread (turns + source events); the window assembler reads
/// only the turns (the session filters source events out before assembly), so
/// source events never enter the LLM payload.
#[tauri::command]
pub fn conversation(state: State<'_, Arc<Mutex<Session>>>) -> Result<Vec<ThreadEntry>, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.conversation().to_vec())
}

/// Read one page of a dataset's rows (ADR-0024 windowed display). Runs off the
/// async/UI thread (AC8) like `ask`: a large OFFSET is an O(offset) scan, so
/// holding the session lock on the IPC path would block every other command.
/// Rejects an unknown reference name or an engine error with an error string.
#[tauri::command]
pub async fn read_rows(
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
    offset: u64,
    limit: u64,
) -> Result<RowPage, String> {
    let session = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let s = session.lock().map_err(|e| e.to_string())?;
        s.read_rows(&reference_name, offset, limit)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- LLM provider key + endpoint config (issue #29/#53, ADR-0007/0019/0029/0038) ---
//
// The API key crosses IPC exactly once (frontend -> Rust, stored), and
// thereafter the frontend learns only a boolean. The non-secret endpoint config
// (base URL + model) crosses both ways. As of ADR-0038 the key lives in the OS
// keychain and the endpoint config lives in the app-config file -- both reached
// through the single managed [`LiveProviderConfig`] (the key never enters
// app-config; the endpoint never enters the keychain).

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

// --- Cross-session persistence (issue #48, ADR-0034/0036) -------------------
//
// Save / open a `.duck` recipe document. Save binds the live session to a
// path (every subsequent terminal turn atomically rewrites it). Open resumes
// the session across the restart boundary: each source is re-read + fingerprint-
// verified, the productive SQL chain is eagerly re-executed LLM-free, and the
// conversation thread + active pointer are restored. Resume progress is
// emitted as a `resume-progress` Tauri event the frontend renders.

/// Bind the session to a `.duck` path and write one recipe immediately
/// (ADR-0034). After this every terminal turn / source event atomically
/// rewrites the recipe. Synchronous: a small whole-file rewrite.
#[tauri::command]
pub fn save_as_duck(
    state: State<'_, Arc<Mutex<Session>>>,
    path: String,
    session_name: String,
) -> Result<(), String> {
    reject_if_resuming()?;
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.bind_duck(PathBuf::from(path), session_name)
        .map_err(|e| e.to_string())
}

/// Open a `.duck` and resume the session across the restart boundary
/// (ADR-0034). Runs off the async/UI thread (AC8): resume re-reads every
/// source and re-executes the productive SQL chain, which can take seconds.
/// Progress is emitted as a `resume-progress` event per source verification
/// and per replayed turn (ADR-0034 visible progress). On success the managed
/// Session is replaced with the resumed one (the SAME managed cancel-token
/// Arc is reused, so the cancel command keeps working against the new
/// session).
#[tauri::command]
pub async fn open_duck(
    app: tauri::AppHandle,
    state: State<'_, Arc<Mutex<Session>>>,
    cancel: State<'_, Arc<CancelToken>>,
    live: State<'_, LiveProviderConfig>,
    path: String,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    let session_arc = state.inner().clone();
    let cancel_arc = Arc::clone(cancel.inner());
    // The resumed session reuses the SAME provider wiring as a fresh session
    // (ADR-0007): the real Anthropic client reading the key from the OS keychain
    // and the endpoint from app-config (ADR-0038), via the shared
    // LiveProviderConfig. Resume itself is LLM-free (it re-executes stored SQL),
    // but the next new turn after resume must reach a live provider -- so the
    // provider is wired at open time, not deferred.
    let provider = Box::new(crate::AnthropicProvider::new(Box::new(
        live.inner().clone(),
    )));
    tauri::async_runtime::spawn_blocking(move || {
        let new_session = Session::open_duck(
            &path,
            cancel_arc,
            provider,
            |ev: ResumeEvent| {
                let _ = app.emit("resume-progress", &ev);
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
        let mut s = session_arc.lock().map_err(|e| e.to_string())?;
        *s = new_session;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read + clear the most recent per-turn persistence failure, if any
/// (ADR-0034/0035 honest signal). The frontend polls this after each turn /
/// source event / resume: a non-blocking "未保存到磁盘" banner surfaces the
/// disk-vs-memory drift so the user knows a save dropped (instead of relying
/// on the next successful write to silently self-heal, which would mask the
/// window where closing the app loses the unsaved turns). Returns `None`
/// after a clean save or after a prior read cleared the failure.
#[tauri::command]
pub fn take_persist_error(state: State<'_, Arc<Mutex<Session>>>) -> Result<Option<String>, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.take_persist_error())
}

/// Read + clear the pending external-change conflict, if any (ADR-0035 Decision 3 /
/// issue #50). The frontend polls this after each turn / source event / resume:
/// a non-`None` value means the auto-write was suspended because the `.duck`
/// file's on-disk hash diverged from the session's baseline (another window,
/// a text editor, or a sync tool edited the file). The frontend surfaces a
/// three-option conflict UI (reload / keep mine / save as new); the engine
/// NEVER silently clobbers the externally-edited file. Returns `None` when no
/// conflict is pending or after a prior read cleared it.
#[tauri::command]
pub fn take_pending_conflict(
    state: State<'_, Arc<Mutex<Session>>>,
) -> Result<Option<crate::PendingConflict>, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.take_pending_conflict())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The IPC-layer guard rejects mutating commands while a resume is in
    /// flight. The happy path (no resume) is exercised implicitly by every
    /// integration test that drives a command; this pins the rejection branch
    /// itself -- previously the only untested path in the resume-guard slice.
    #[test]
    fn reject_if_resuming_blocks_while_a_resume_is_in_flight() {
        let _guard = crate::session::acquire_test_resume_flag();
        let err = reject_if_resuming().unwrap_err();
        assert_eq!(err, "正在恢复会话，请稍候再操作");
        // `_guard` drops here -> RESUMING_COUNT decrements. We do NOT assert
        // resuming_count() == 0: parallel unit tests in this binary may also
        // hold a guard, so only the block-branch (not the drain) is pinned.
    }
}
