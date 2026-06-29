//! toptopduck -- local-first AI data analysis desktop tool.
//!
//! Slice 1 (issue #5): CSV ingest end-to-end tracer bullet. The ingest pipeline
//! (ingest / session / workingset) is driven as a black box by
//! tests/ingest_blackbox.rs -- the PRD's main seam.

pub mod commands;
pub mod ingest;
pub mod model;
pub mod session;
pub mod workingset;

pub use model::{
    ColumnSchema, DatasetDescriptor, GuidanceRequest, GuidanceSheet, LoadError, LoadOutcome,
    RectifyProvenance, RenameError, SheetGuidance, SheetRectify,
};
pub use session::Session;

use std::sync::{Arc, Mutex};

/// Boots the Tauri shell. The shared Session is created once and managed behind
/// an Arc<Mutex>; ingest runs on a blocking thread so the UI never freezes (AC8).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let session = Session::new().expect("failed to create session");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(session)))
        .invoke_handler(tauri::generate_handler![
            commands::ingest_file,
            commands::ingest_file_guided,
            commands::list_working_set,
            commands::active_dataset,
            commands::get_dataset,
            commands::rename_dataset,
            commands::replace_source,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
