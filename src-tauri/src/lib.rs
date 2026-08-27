//! toptopduck -- local-first AI data analysis desktop tool.
//!
//! Slice 1 (issue #5): CSV ingest end-to-end tracer bullet. The ingest pipeline
//! (ingest / session / workingset) is driven as a black box by
//! tests/ingest_blackbox.rs -- the PRD's main seam.
//!
//! Query loop (PRD #1, ADR-0077/0081): ask -> outcome. The session facade
//! (session::Session::ask) drives the native agent loop
//! (session::yoagent) over the provider abstraction (provider::Provider,
//! ADR-0007): tool-calling round-trips (explore / materialize / describe /
//! sample) dispatched on the session DuckDB, tool-level errors routed back to
//! the model for self-correction, and one ADR-0028 outcome (result / textual
//! / failed / cancelled) at the end. tests/query_blackbox.rs drives it
//! through a scripted FakeProvider at the ask -> outcome seam -- offline and
//! deterministic.

pub mod app_config;
pub mod approval;
pub(crate) mod bounded_line;
pub mod cancel;
pub mod cli_tools;
pub mod commands;
pub mod fs_acl;
pub mod guardrail;
pub mod ingest;
pub mod mcp;
pub mod model;
pub mod persistence;
pub mod provenance;
pub mod provider;
pub mod runtime;
pub mod sandbox_sql;
pub mod session;
pub mod session_store;
pub mod skills;
pub mod tools;
pub mod util;
pub mod window;
pub mod workingset;

pub use app_config::{
    AppConfig, EngineDefaults, ExportDefaults, PrivacyDefaults, Theme, Tunables,
    APP_CONFIG_FORMAT_VERSION,
};
pub use approval::{
    auto_allowed, classify, ApprovalRequest, ApprovalRequestBody, ApprovalRequestPayload,
    ApprovalResolvedPayload, ApprovalResponse, ApprovalSink, ApprovalState, AuthMode,
    Classification, GateCancelled, GateOutcome, OperationKind, RespondError, ToolKey,
};
pub use cancel::CancelToken;
pub use commands::StoreCommandError;
pub use model::{
    ChartKind, ColumnSchema, DatasetDescriptor, DatasetPrivacy, GuidanceRequest, GuidanceSheet,
    LoadError, LoadOutcome, ProfileId, ProfileKeyStatus, ProfileTestOutcome, Protocol,
    ProviderConfig, ProviderConfigView, ProviderProfile, RectifyProvenance, RemoveSourceError,
    RenameError, RowPage, RowReadError, SheetGuidance, SheetRectify, SkillProvenance,
    SourceLifecycleEvent, SourceLifecycleKind, StaleAnchor, StaleReason, TextKind, ThinkingTrace,
    ThreadEntry, TraceEntryView, TraceRound, TurnFailure, TurnOutcome, TurnPhase, TurnProgress,
    TurnProvenance, TurnRecord, TurnRuntime, VizSpec, DEFAULT_PROFILE_ID,
    DEFAULT_PROVIDER_BASE_URL, DEFAULT_PROVIDER_MODEL,
};
pub use persistence::{
    DuckPath, LoadError as DuckLoadError, MigrationError, RecipeError, SaveError, SessionMetadata,
    SessionsRoot, SourceSummary,
};
pub use provider::fake::FakeProvider;
pub use provider::keychain::{KeychainStore, ProviderConfigSource, StaticConfig};
pub use provider::live_config::LiveProviderConfig;
pub use provider::prompt::ResponseLocale;
pub use provider::{
    ColumnRef, DatasetRef, LiveProvider, Provider, ProviderError, ProviderRequest, ResponsePayload,
    TurnPayload, UnwiredProvider,
};
pub use session::{
    is_resuming, ActiveAbandoned, ActiveResolution, PendingConflict, RenameSessionError,
    ResumeError, ResumeEvent, ResumeProgress, Session, SourceIssue, SourceResolution, TurnInputs,
};
pub use session_store::{
    ClosingFlag, SessionError, SessionHandle, SessionId, SessionStore, UNKNOWN_SESSION,
};
pub use skills::{
    Acquired, DiscoveredSkill, DiscoveredSkillStatus, ImportItem, ImportMode, ImportOutcome,
    SkillEntry, SkillError, SkillListing, SkillSource, SkillSourceCandidate, SkillUpdate,
    SkillsRoot, SkippedSkill,
};

use std::path::PathBuf;
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
/// (ADR-0056 concurrency model). The live provider carrier ([`LiveProvider`])
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

    // Window geometry persistence across launches (issue #268). The plugin is
    // the SINGLE source of truth for window geometry: SIZE + POSITION +
    // MAXIMIZED + VISIBLE. ADR-0038's app-config `WindowGeometry` field + the
    // frontend restore/persist effects are retired by #268 -- they raced this
    // plugin's restore on launch, causing the window to jump from the OS-
    // default spot to the restored spot once the frontend IPC resolved.
    //
    // VISIBLE + `visible: false` in tauri.conf.json let the plugin own the
    // show() timing: the window stays hidden until `restore_state` (the
    // plugin's internal on-window-ready hook) applies the persisted geometry,
    // then `show()`s -- geometry is set before the window is visible. On a
    // first launch (no persisted state) `restore_state` takes its no-state
    // branch and leaves `should_show` at its `true` initial value, so `show()`
    // still fires and the window appears (centered by `center: true` in
    // tauri.conf.json). VISIBLE both persists the visibility flag and gates
    // `show()` on restore; a safety-net `show()` in `setup` (below) covers the
    // narrow case where `restore_state` itself errors and the plugin swallows
    // the `Err` with `let _ =`.
    //
    // DECORATIONS + FULLSCREEN stay off the flags: this app never toggles
    // them. No denylist (the template's quick-pane denylist is an NSPanel
    // is_maximized crash workaround that does not apply -- no floating panel).
    #[cfg(desktop)]
    {
        app_builder = app_builder.plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        );
    }

    app_builder
        .plugin(tauri_plugin_dialog::init())
        // Platform detection (ADR-0074, issue #262): plugin-os injects the
        // compile-time OS as a webview global the frontend reads synchronously
        // via `platform()`. Registered unconditionally like dialog/log -- the
        // plugin works on every target; the desktop-only plugins (single-
        // instance, window-state) stay under #[cfg(desktop)] above. The
        // `locale()` / `hostname()` IPC commands are authorized via `os:default`
        // in capabilities/default.json.
        .plugin(tauri_plugin_os::init())
        // Reveal paths in the OS file manager (issue #362): the settings
        // Skills section's "open source location" reveals a linked skill's
        // source directory. Registered unconditionally like dialog / os / log
        // -- the reveal surface works on every desktop target. The default
        // capability authorizes reveal-item-in-dir only.
        .plugin(tauri_plugin_opener::init())
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

            // Skills registry root (issue #362, ADR-0086): the single registry
            // lives under the OS app-data dir (`<app_data_dir>/skills`), with
            // the same honest temp-dir fallback the app-config path uses --
            // the app still boots, the registry just resets to empty each
            // launch instead of persisting. The directory itself is minted
            // lazily on first create; a never-created registry lists empty.
            let skills_root = match app.path().app_data_dir() {
                Ok(dir) => dir.join("skills"),
                Err(e) => {
                    log::warn!(
                        "failed to resolve app-data dir; skills registry falls back to a temp path: {e}"
                    );
                    std::env::temp_dir().join("toptopduck-skills")
                }
            };

            let keychain = KeychainStore::new();
            let live = LiveProviderConfig::new(keychain, app_config_path);
            // ADR-0089 + issue #452: managed sessions directory. Default root
            // is `<Documents>/toptopduck/sessions/` (platform-conventions
            // Documents, not hidden app-data). When app-config carries a
            // `sessions_dir` override, honor it with honest-degrade — a missing
            // / non-directory path logs a warning and falls back to the default
            // WITHOUT clearing the config (the path might be temporarily
            // unavailable, e.g. an unmounted external drive).
            let sessions_root = {
                let cfg = live.load();
                match cfg.sessions_dir.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    Some(p) => {
                        let path = PathBuf::from(p);
                        if path.is_dir() {
                            path
                        } else {
                            log::warn!(
                                "configured sessions_dir does not exist or is not a directory: {}; \
                                 falling back to the default (config retained for next launch)",
                                path.display()
                            );
                            persistence::default_sessions_root(app.handle())
                        }
                    }
                    None => persistence::default_sessions_root(app.handle()),
                }
            };
            // ADR-0056: the multi-session store is the single managed state for
            // session-scoped commands. It starts empty; the frontend creates
            // sessions on demand. LiveProviderConfig is shared -- the per-session
            // provider reads key + endpoint through it.
            app.manage(Arc::new(SessionStore::new()));
            // The builtin-CLI startup window (issue #675, ADR-0109 Decision 9):
            // detect the shipped definitions' executables on PATH (existence
            // only, never a spawn) and silently auto-register the hits BEFORE
            // the frontend loads its first config snapshot (setup completes
            // before any webview IPC -- the structural timing guarantee).
            // The same window materializes the companion builtin skills
            // (issue #677) into the skills registry. Failures log and
            // degrade: the settings-page rescan retries.
            if let Err(detail) = cli_tools::builtin::startup_register(&live, None, &skills_root) {
                log::warn!(
                    "builtin CLI startup registration failed (the settings-page \
                     rescan retries on demand): {detail}"
                );
            }
            app.manage(live);
            app.manage(SessionsRoot::new(sessions_root));
            app.manage(SkillsRoot(skills_root));
            // The adapter catalog cache sidecar (ADR-0096 D5, issue #536):
            // `adapter-catalogs.json` under the OS app-data dir, with the
            // same honest temp-dir fallback. The probe click is the only
            // write point; reads honest-degrade to empty on a corrupt file.
            let catalog_store = match app.path().app_data_dir() {
                Ok(dir) => runtime::acp::catalog_store::AdapterCatalogStore::new(dir.join(
                    runtime::acp::catalog_store::CATALOGS_FILE_NAME,
                )),
                Err(e) => {
                    log::warn!(
                        "failed to resolve app-data dir; adapter catalog cache falls back to a temp path: {e}"
                    );
                    runtime::acp::catalog_store::AdapterCatalogStore::new(
                        std::env::temp_dir().join("toptopduck-adapter-catalogs.json"),
                    )
                }
            };
            app.manage(catalog_store);

            // Visibility safety net (issue #268). `visible: false` in
            // tauri.conf.json + the window-state plugin's VISIBLE flag mean
            // the plugin's `restore_state` is the ONLY code path that calls
            // `show()` on the main window. The plugin swallows `restore_state`
            // errors with `let _ =`, so a failure inside it (a platform
            // set_position / set_size after a monitor unplug, a malformed
            // .window-state.json) would leave the window permanently hidden
            // with no log. This fallback checks visibility 2s after boot -- if
            // the plugin already showed the window, it is a no-op; if not, it
            // forces show() + set_focus() and logs the recovery so a future
            // regression is diagnosable instead of presenting as "app won't
            // open". Desktop-only: mobile has no main window managed here.
            #[cfg(desktop)]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let Some(window) = handle.get_webview_window("main") else {
                        return;
                    };
                    let already_visible = window.is_visible().unwrap_or(false);
                    if !already_visible {
                        log::error!(
                            "main window still hidden 2s after boot; the \
                             window-state plugin did not show() it -- forcing \
                             show() so the app is usable"
                        );
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                });
            }

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
            commands::set_api_key,
            commands::clear_api_key,
            commands::get_provider_config,
            commands::set_provider_config,
            commands::list_provider_profiles,
            commands::set_profile_key,
            commands::clear_profile_key,
            commands::test_profile,
            commands::get_app_config,
            commands::set_app_config,
            commands::upsert_mcp_server,
            commands::upsert_cli_tool,
            commands::remove_cli_tool,
            commands::restore_builtin_cli_tool,
            commands::restore_builtin_skill,
            commands::rescan_builtin_cli_tools,
            commands::set_mcp_server_secret,
            commands::clear_mcp_server_secret,
            commands::probe_mcp_server,
            commands::discover_mcp_servers,
            commands::list_sessions,
            commands::delete_session,
            commands::rename_session,
            commands::get_session_name,
            commands::rename_persisted_session,
            commands::export_session,
            commands::prepare_import_session,
            commands::set_sessions_dir,
            commands::get_sessions_dir,
            commands::set_default_runtime,
            commands::open_duck,
            commands::take_persist_error,
            commands::take_pending_conflict,
            commands::respond_tool_approval,
            commands::get_authorization_mode,
            commands::set_authorization_mode,
            commands::list_session_trust,
            commands::revoke_session_trust,
            commands::list_adapters,
            commands::rescan_adapters,
            commands::probe_adapter,
            commands::get_adapter_catalogs,
            commands::get_session_runtime,
            commands::set_session_runtime,
            commands::get_session_model_config,
            commands::set_session_posture,
            commands::get_last_model_posture,
            commands::clear_last_model_posture,
            commands::list_skills,
            commands::create_skill,
            commands::update_skill,
            commands::delete_skill,
            commands::list_skill_sources,
            commands::import_skills,
            commands::mount_skill,
            commands::unmount_skill,
            commands::list_mounted_skills,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
