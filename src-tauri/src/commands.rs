//! Tauri command boundary (frontend <-> Rust). Thin wrappers over [`Session`];
//! the ingest pipeline is the black box tested in tests/ingest_blackbox.rs, and
//! the ask -> result loop in tests/query_blackbox.rs (issue #22).

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::cancel::CancelToken;
use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadOutcome, ProviderConfig, ProviderConfigView, RowPage,
    SheetGuidance, ThreadEntry, TurnOutcome, DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL,
};
use crate::provider::keychain::KeychainStore;
use crate::session::Session;

/// Ingest a file. Runs the DuckDB copy-in off the async/UI thread (AC8: does not
/// freeze the app) and returns the outcome descriptor or a clear error.
#[tauri::command]
pub async fn ingest_file(
    state: State<'_, Arc<Mutex<Session>>>,
    path: String,
) -> Result<LoadOutcome, String> {
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
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.set_privacy(&reference_name, privacy)
        .ok_or_else(|| format!("找不到引用名为「{reference_name}」的数据集"))
}

/// Remove a source Dataset from the working set (issue #38, ADR-0040). The first
/// source-removal path: detaches the snapshot, deletes its file, drops the
/// reference name from the shared namespace, and appends a `Deleted` source
/// lifecycle event to the thread. Refuses the active source (→ #39) and any
/// removal while materialized results exist (→ #40 cascade). Synchronous: the
/// session Mutex already serializes this against an in-flight turn (ADR-0040
/// execution window), and the only I/O is a best-effort DETACH + remove_file.
#[tauri::command]
pub fn remove_source(
    state: State<'_, Arc<Mutex<Session>>>,
    reference_name: String,
) -> Result<(), String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.remove_source(&reference_name).map_err(|e| e.to_string())
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

// --- LLM provider key + config (issue #29, ADR-0007/0019/0029) -------------
//
// The API key crosses IPC exactly once (frontend -> Rust, stored), and
// thereafter the frontend learns only a boolean. The non-secret config (base
// URL + model) crosses both ways. Every read/write hits the OS keychain via the
// managed [`KeychainStore`] (ADR-0029 invariant 3: the decrypted key lives only
// in the Rust core; the webview has no keychain access and no HTTP egress).

/// Whether an API key is stored. Returns a boolean only -- never the key
/// itself (ADR-0029 invariant 3). The frontend uses this to decide whether to
/// prompt for configuration before the first turn.
#[tauri::command]
pub fn has_api_key(store: State<'_, KeychainStore>) -> Result<bool, String> {
    Ok(store.has_key())
}

/// Store the API key the frontend collected (ADR-0029: a one-shot
/// frontend-to-Rust transfer; the key is never returned back across IPC).
#[tauri::command]
pub fn set_api_key(store: State<'_, KeychainStore>, key: String) -> Result<(), String> {
    store.set_key(&key)
}

/// Remove the stored API key. Idempotent: a missing entry is success; a real
/// keychain error propagates so the frontend can tell the user the key did not
/// come out. After a successful clear, `has_api_key` is false and the next turn
/// refuses as not-wired.
#[tauri::command]
pub fn clear_api_key(store: State<'_, KeychainStore>) -> Result<(), String> {
    store.clear_key()
}

/// Read the effective provider config + whether a key is set (ADR-0019/0029).
/// The base URL + model cross IPC; the key does not (only the boolean).
#[tauri::command]
pub fn get_provider_config(store: State<'_, KeychainStore>) -> Result<ProviderConfigView, String> {
    let cfg = store.get_config();
    Ok(ProviderConfigView {
        base_url: cfg.base_url,
        model: cfg.model,
        has_key: store.has_key(),
    })
}

/// Save the non-secret provider config (Anthropic-protocol base URL + model,
/// ADR-0019). Empty fields normalize to the v1 defaults so the stored blob is
/// always valid (and `get_provider_config` then reads consistent values). The
/// API key never enters this path (ADR-0029: key confined to its own entry).
#[tauri::command]
pub fn set_provider_config(
    store: State<'_, KeychainStore>,
    mut config: ProviderConfig,
) -> Result<ProviderConfigView, String> {
    if config.base_url.trim().is_empty() {
        config.base_url = DEFAULT_PROVIDER_BASE_URL.to_string();
    }
    if config.model.trim().is_empty() {
        config.model = DEFAULT_PROVIDER_MODEL.to_string();
    }
    store.set_config(&config)?;
    Ok(ProviderConfigView {
        base_url: config.base_url,
        model: config.model,
        has_key: store.has_key(),
    })
}
