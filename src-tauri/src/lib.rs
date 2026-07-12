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
pub mod session_store;
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
    TurnPhase, TurnProgress, TurnRecord, VizSpec, DEFAULT_PROVIDER_BASE_URL,
    DEFAULT_PROVIDER_MODEL,
};
pub use persistence::{RecipeError, SessionMetadata, SourceSummary};
pub use provider::anthropic::AnthropicProvider;
pub use provider::fake::FakeProvider;
pub use provider::keychain::{KeychainStore, ProviderConfigSource, StaticConfig};
pub use provider::live_config::LiveProviderConfig;
pub use provider::prompt::{build_system_prompt, ResponseLocale};
pub use provider::{
    ColumnRef, DatasetRef, Provider, ProviderError, ProviderReply, ProviderRequest,
    ResponsePayload, TurnPayload, UnwiredProvider,
};
pub use session::{
    is_resuming, ActiveAbandoned, ActiveResolution, PendingConflict, ResumeError, ResumeEvent,
    ResumeProgress, Session, SourceIssue, SourceResolution,
};
pub use session_store::{
    ClosingFlag, SessionError, SessionHandle, SessionId, SessionStore, UNKNOWN_SESSION,
};

use std::sync::Arc;
use tauri::Manager;

/// Boots the Tauri shell. A single [`SessionStore`] (ADR-0056) is created once
/// and managed as Tauri state; it holds the `Map<SessionId, Arc<SessionHandle>>`
/// the session-scoped commands address. The store starts EMPTY -- the frontend
/// mints each session via `create_session` (the `+ tab` action) and passes the
/// returned id as the first parameter to every session-scoped command. Each
/// session owns an independent in-memory DuckDB instance (ADR-0012/0027), its
/// own per-session cancel token (ADR-0021), and its own `Mutex<Session>` (the
/// single-flight gate); the store lock is held only for the brief lookup, so a
/// long turn never blocks another session's `close_session` / `create_session`
/// (ADR-0056 concurrency model). The real LLM provider (AnthropicProvider, #29)
/// is wired per session at `create_session` -- it reads the API key from the OS
/// keychain per turn and the endpoint config (`{base_url, model}`) from the
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
    let mut app_builder = tauri::Builder::default();

    // Multi-instance guard (issue #100). single-instance MUST be the first
    // registered plugin: when a second instance launches, this callback runs
    // in the FIRST instance and focuses its main window instead of letting a
    // second process start. Without it each instance owns an independent
    // SessionStore (ADR-0056) and the two race on the app-config atomic write
    // (ADR-0038). cfg(desktop) mirrors the Cargo.toml target guard -- mobile
    // builds neither pull the plugin nor register it.
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));
    }

    // Window position/size/maximized persistence across launches (issue #100).
    // Replaces the role the app-config WindowGeometry field (ADR-0038) was
    // meant to fill -- whether that field retires is left for a follow-up.
    // Only SIZE + POSITION + MAXIMIZED are persisted -- NOT the plugin's full
    // default (StateFlags::all() also captures VISIBLE / DECORATIONS /
    // FULLSCREEN, which this app does not manage: fullscreen is never toggled,
    // decorations never change, and the main window must always show on launch
    // so VISIBLE must not be restored from a hidden state). No denylist (the
    // template's quick-pane denylist is an NSPanel is_maximized crash
    // workaround that does not apply here -- we have no floating panel).
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        );
    }

    app_builder
        .plugin(tauri_plugin_dialog::init())
        // Multi-target log sink (issue #98, ADR-0029 invariant 2). Routes the
        // `log` facade to two destinations so the existing log::warn! calls
        // (app-config path fallback, create_dir_all failure, ingest
        // type-inference degradation) are observable, not silent:
        //   - Stdout: the launching terminal (cargo tauri dev DX; a no-op
        //     when a bundled app has no console -- the file target still
        //     captures everything).
        //   - LogDir: persistent file in app_log_dir (the Tauri-recommended
        //     log directory, e.g. %LOCALAPPDATA%/<identifier>/logs on Windows,
        //     ~/Library/Logs on macOS). Unconditional on all platforms -- this
        //     app needs the file everywhere, unlike templates that gate LogDir
        //     to one OS and rely on stdout+Webview elsewhere.
        // A Webview target (Rust logs mirrored into the devtools console) is
        // intentionally omitted: it requires the frontend to call
        // @tauri-apps/plugin-log attachConsole(), and would duplicate the dev
        // mirror in src/lib/log.ts. Add it as a deliberate follow-up if
        // devtools visibility for Rust logs is ever needed.
        // Registered on the Builder -- not in setup -- because Tauri v2 only
        // allows plugin registration before build (App has no plugin()
        // method at runtime), and app_data_dir requires an App handle the
        // Builder chain lacks (app_log_dir is auto-created by the plugin).
        // The sink is compatible with the `log` facade, so existing call sites
        // need zero changes. LevelFilter dev=Debug / release=Info; max_file_size
        // caps growth at ~5MB with the default RotationStrategy::KeepOne (the
        // prior file is removed on overflow, so only the latest ~5MB window
        // survives -- a richer rotation strategy is deferred per issue #98).
        // The frontend @tauri-apps/plugin-log IPCs into the same sink (one
        // file, one format: DATE[TARGET][LEVEL] MESSAGE, both ends).
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets(vec![
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .max_file_size(5_000_000)
                .build(),
        )
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
            // ADR-0056: the multi-session store is the single managed state for
            // session-scoped commands. It starts empty; the frontend creates
            // sessions on demand. LiveProviderConfig is shared -- the per-session
            // provider reads key + endpoint through it.
            app.manage(Arc::new(SessionStore::new()));
            app.manage(live);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::close_session,
            commands::close_session_and_wait_release,
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
            commands::list_sessions,
            commands::delete_session,
            commands::rename_session,
            commands::rename_persisted_session,
            commands::save_as_duck,
            commands::open_duck,
            commands::take_persist_error,
            commands::take_pending_conflict,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
