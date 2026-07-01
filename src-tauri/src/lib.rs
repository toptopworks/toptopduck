//! toptopduck -- local-first AI data analysis desktop tool.
//!
//! Slice 1 (issue #5): CSV ingest end-to-end tracer bullet. The ingest pipeline
//! (ingest / session / workingset) is driven as a black box by
//! tests/ingest_blackbox.rs -- the PRD's main seam.
//!
//! Query loop (issue #22/#23): ask -> outcome. A turn orchestrator
//! (session::Session::ask) calls the provider abstraction (provider::Provider,
//! ADR-0007) for one SQL or a textual response (ADR-0009), runs any SQL on the
//! session DuckDB, and produces one ADR-0028 outcome (result / textual / failed
//! / cancelled). Slice #23 adds the full four-way classification, the always-
//! visible conversation thread, and the single retry budget.
//! tests/query_blackbox.rs drives it through a scripted FakeProvider at the ask
//! -> outcome seam -- offline and deterministic.

pub mod cancel;
pub mod commands;
pub mod guardrail;
pub mod ingest;
pub mod model;
pub mod provider;
pub mod session;
pub mod window;
pub mod workingset;

pub use cancel::CancelToken;
pub use model::{
    ChartKind, ColumnSchema, DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet,
    LoadError, LoadOutcome, RectifyProvenance, RenameError, RowPage, SheetGuidance, SheetRectify,
    TextKind, TurnError, TurnOutcome, TurnRecord, VizSpec,
};
pub use provider::fake::FakeProvider;
pub use provider::{
    ColumnRef, DatasetRef, Provider, ProviderError, ProviderReply, ProviderRequest,
    ResponsePayload, TurnPayload, UnwiredProvider,
};
pub use session::Session;

use std::sync::{Arc, Mutex};

/// Boots the Tauri shell. The shared Session is created once and managed behind
/// an Arc<Mutex>; ingest and turns run on a blocking thread so the UI never
/// freezes (AC8). The cancel token is shared (Arc) between the Session and the
/// cancel command so a cancel fires without the session lock `ask` holds for the
/// whole turn (ADR-0021, issue #28).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cancel = Arc::new(CancelToken::new());
    let session = Session::with_provider_and_cancel(
        Box::new(crate::provider::UnwiredProvider),
        cancel.clone(),
    )
    .expect("failed to create session");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Mutex::new(session)))
        .manage(cancel)
        .invoke_handler(tauri::generate_handler![
            commands::ingest_file,
            commands::ingest_file_guided,
            commands::list_working_set,
            commands::active_dataset,
            commands::get_dataset,
            commands::rename_dataset,
            commands::replace_source,
            commands::set_dataset_privacy,
            commands::ask,
            commands::cancel,
            commands::conversation,
            commands::read_rows,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
