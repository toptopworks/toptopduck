//! Tauri command boundary (frontend <-> Rust). Thin wrappers over [`Session`];
//! the ingest pipeline is the black box tested in tests/ingest_blackbox.rs, and
//! the ask -> result loop in tests/query_blackbox.rs (issue #22).

use std::path::Path;
use std::sync::{Arc, Mutex};

use tauri::State;

use crate::model::{
    DatasetDescriptor, DatasetPrivacy, LoadOutcome, RowPage, SheetGuidance, TurnOutcome, TurnRecord,
};
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

/// Read the conversation thread (ADR-0028/0039): every turn in order, each
/// labeled by its verbatim question and its outcome. Synchronous -- a snapshot
/// read of the session history with no copy-in. The frontend renders this as
/// the always-visible thread; the (future, #24) window assembler reads it to
/// build the provider prompt.
#[tauri::command]
pub fn conversation(state: State<'_, Arc<Mutex<Session>>>) -> Result<Vec<TurnRecord>, String> {
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
