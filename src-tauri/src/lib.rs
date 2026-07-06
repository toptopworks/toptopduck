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

pub mod app_config;
pub mod cancel;
pub mod commands;
pub mod guardrail;
pub mod ingest;
pub mod model;
pub mod persistence;
pub mod provenance;
pub mod provider;
pub mod session;
pub mod window;
pub mod workingset;

pub use app_config::{
    AppConfig, EngineDefaults, ExportDefaults, PrivacyDefaults, ProviderEndpoint, Theme, Tunables,
    WindowGeometry, APP_CONFIG_FORMAT_VERSION, RECENT_FILES_CAP,
};
pub use cancel::CancelToken;
pub use model::{
    ChartKind, ColumnSchema, DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet,
    LoadError, LoadOutcome, ProviderConfig, ProviderConfigView, RectifyProvenance,
    RemoveSourceError, RenameError, RowPage, SheetGuidance, SheetRectify, SourceLifecycleEvent,
    SourceLifecycleKind, StaleAnchor, StaleReason, TextKind, ThreadEntry, TurnError, TurnOutcome,
    TurnRecord, VizSpec, DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL,
};
pub use persistence::RecipeError;
pub use provider::anthropic::AnthropicProvider;
pub use provider::fake::FakeProvider;
pub use provider::keychain::{KeychainStore, ProviderConfigSource, StaticConfig};
pub use provider::live_config::LiveProviderConfig;
pub use provider::prompt::{render_schema_context, CAPABILITY_BOUNDARY_PROMPT};
pub use provider::{
    ColumnRef, DatasetRef, Provider, ProviderError, ProviderReply, ProviderRequest,
    ResponsePayload, TurnPayload, UnwiredProvider,
};
pub use session::{
    is_resuming, ActiveAbandoned, ActiveResolution, PendingConflict, ResumeError, ResumeEvent,
    Session, SourceIssue, SourceResolution,
};

use std::sync::{Arc, Mutex};
use tauri::Manager;

/// Boots the Tauri shell. The shared Session is created once and managed behind
/// an Arc<Mutex>; ingest and turns run on a blocking thread so the UI never
/// freezes (AC8). The cancel token is shared (Arc) between the Session and the
/// cancel command so a cancel fires without the session lock `ask` holds for the
/// whole turn (ADR-0021, issue #28). The real LLM provider (AnthropicProvider,
/// #29) is wired behind the Provider trait -- it reads the API key from the OS
/// keychain per turn, and the endpoint config (`{base_url, model}`) from the
/// app-config file (ADR-0038 / issue #53), via a single [`LiveProviderConfig`]
/// held as Tauri state. The app starts usable once a key is stored; before that
/// every turn refuses honestly as not-wired.
///
/// `setup` resolves the app-config path under the OS app-data directory
/// (ADR-0038) before constructing the provider: the path is needed to build the
/// [`LiveProviderConfig`] the provider reads endpoint config through. A failure
/// to resolve / create the directory falls back to an ephemeral temp path -- the
/// app still boots, app-config just honest-degrades to defaults (no persistence
/// across launches) rather than crashing.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let cancel = Arc::new(CancelToken::new());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // ADR-0038: app-config lives in the OS app-data dir (e.g.
            // %APPDATA%/<identifier>/config.json), NOT in the working directory
            // and NOT alongside any `.duck`. Fall back to a temp path if the OS
            // app-data dir cannot be resolved (the app still boots; prefs reset
            // each launch instead of persisting).
            let app_config_path = match app.path().app_data_dir() {
                Ok(dir) => dir.join("config.json"),
                Err(e) => {
                    log::warn!(
                        "failed to resolve app-data dir; app-config falls back to a temp path: {e}"
                    );
                    std::env::temp_dir().join("toptopduck-config.json")
                }
            };
            // The atomic write renames a temp file inside the parent dir, so the
            // parent must exist. create_dir_all is idempotent; a failure is
            // non-fatal (the write later honest-errors, app-config degrades),
            // but without this log the failure is invisible -- every subsequent
            // write_at also fails, prefs never persist across launches, and the
            // user sees "my config resets every restart" with no diagnostic.
            if let Some(parent) = app_config_path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    log::warn!(
                        "failed to create app-config dir {}: {e}; prefs will not persist",
                        parent.display()
                    );
                }
            }

            let keychain = KeychainStore::new();
            let live = LiveProviderConfig::new(keychain, app_config_path);
            let session = Session::with_provider_and_cancel(
                Box::new(AnthropicProvider::new(Box::new(live.clone()))),
                cancel.clone(),
            )
            .expect("failed to create session");
            app.manage(Arc::new(Mutex::new(session)));
            app.manage(cancel.clone());
            app.manage(live);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ingest_file,
            commands::ingest_file_guided,
            commands::list_working_set,
            commands::active_dataset,
            commands::get_dataset,
            commands::rename_dataset,
            commands::replace_source,
            commands::remove_source,
            commands::remove_active_source,
            commands::set_dataset_privacy,
            commands::ask,
            commands::cancel,
            commands::conversation,
            commands::read_rows,
            commands::has_api_key,
            commands::set_api_key,
            commands::clear_api_key,
            commands::get_provider_config,
            commands::set_provider_config,
            commands::get_app_config,
            commands::set_app_config,
            commands::record_recent_file,
            commands::save_as_duck,
            commands::open_duck,
            commands::take_persist_error,
            commands::take_pending_conflict,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
