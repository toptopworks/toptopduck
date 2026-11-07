//! In-app updater (ADR-0143, issue #1509): the one-shot atomic
//! check -> download -> cleanup -> install -> relaunch chain.
//!
//! Every orchestration step lives here on the Rust side -- the frontend never
//! touches the updater plugin's IPC surface, so no `updater:default`
//! capability entry exists. The frontend drives UX only: it queries
//! [`check_for_updates`] (startup delayed auto-check + the settings-page
//! button), gates [`install_update`] behind a confirm dialog when turns are
//! in flight, and renders the `update-download-progress` events.
//!
//! The cleanup chain rides the plugin's `on_before_exit` hook because Windows
//! `install()` exits the process from inside (`exit(0)`), bypassing both the
//! Tauri exit events and the window-state plugin's automatic save. The hook is
//! attached per-use on the `UpdaterBuilder` (not the plugin Builder at
//! registration time) so it can capture the [`AppHandle`] -- the dbx-proven
//! shape, and the only one that hands an app handle into the closure.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::session::store::SessionStore;

/// The download progress event channel. Payload: [`DownloadProgress`].
pub const DOWNLOAD_PROGRESS_EVENT: &str = "update-download-progress";

/// The window-geometry dimensions the app persists (issue #268): SIZE +
/// POSITION + MAXIMIZED, never VISIBLE/DECORATIONS/FULLSCREEN (the boot show
/// must not be gateable by a persisted hidden state -- see the window-state
/// registration comment in lib.rs). Shared by the plugin's builder-time flags
/// and the explicit pre-exit save here so the two cannot drift. A fn (not a
/// const) because bitflags' `|` is not const-evaluable.
pub fn window_state_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// Bounded wait for in-flight turns to release during the pre-exit cleanup.
/// The cancel path (external CLI kill -> turn discard) normally lands well
/// under a second; the bound only caps the pathological straggler.
const SHUTDOWN_RELEASE_WAIT: Duration = Duration::from_secs(10);

/// The Windows MSI installer property that suppresses reboots (ADR-0143
/// Decision 2): `msiexec /passive /promptrestart` may restart the machine
/// without asking when files are in use -- `REBOOT=ReallySuppress` as an
/// installer property is the only defense. Rides both Windows updater branches
/// (harmlessly ignored by the NSIS template). Unconditional so its pin test
/// runs on every CI OS (the test legs are Linux-only); only the use site is
/// cfg(windows).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const WINDOWS_INSTALLER_ARGS: &[&str] = &["REBOOT=ReallySuppress"];

/// The total request timeout for the check and download requests. The plugin
/// defaults to NO timeout ("the requests do not time out"), and the install
/// overlay is dismiss-free -- a stalled mirror would wedge the whole UI with
/// the install gate locked until the process is killed. reqwest's timeout is
/// total (connect through the last body byte), so the bound must also cover a
/// slow-network large payload: 300s spans a ~150MB updater package at
/// ~0.5MB/s, while still bounding a zero-byte stall.
const UPDATE_REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// The IPC-visible face of a discovered update: the target version, its
/// release notes, and the running version for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub notes: Option<String>,
    pub current_version: String,
}

/// The download progress event payload (camelCase for the frontend).
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub content_length: Option<u64>,
}

/// Build a fresh [`tauri_plugin_updater::Updater`] with the cleanup chain and
/// the Windows installer args attached. Per-use construction is deliberate:
/// the `on_before_exit` closure needs the [`AppHandle`], which only exists
/// after setup -- plugin-registration-time hooks cannot capture one.
fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let cleanup_app = app.clone();
    let builder = app
        .updater_builder()
        .timeout(UPDATE_REQUEST_TIMEOUT)
        .on_before_exit(move || cleanup_before_update_exit(&cleanup_app));
    #[cfg(windows)]
    let builder = builder.installer_args(WINDOWS_INSTALLER_ARGS);
    builder.build().map_err(|e| e.to_string())
}

/// Manual check (settings-page button). Always fresh -- never a cached or
/// startup-carried result.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = updater(&app)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        notes: u.body.clone(),
        current_version: u.current_version.clone(),
    }))
}

/// The one-shot atomic install: fresh check -> download (progress events) ->
/// cleanup -> install -> relaunch. On Windows `install()` exits the process
/// from inside, so this command never resolves there; on macOS/Linux it
/// relaunches the app, which is also a non-resolving exit. The frontend treats
/// a resolved call as a failure (only the error path resolves in practice).
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    // Never reuse the discovery check's result (dsh discipline): the manifest
    // may have moved between the sidebar indicator landing and the click.
    let updater = updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;
    let progress_app = app.clone();
    let mut last_percent: Option<u64> = None;
    // The plugin's progress callback delivers CHUNK LENGTHS (delta bytes), not
    // cumulative totals (tauri-plugin-updater 2.14.1 calls
    // `on_chunk(chunk.len(), content_length)`) -- accumulate here so the
    // percent math (and the unknown-total 512 KiB cadence) see real progress.
    let mut downloaded: u64 = 0;
    // The plugin's on_before_exit hook is Windows-only in 2.14.1 (its single
    // call site sits inside the Windows install_inner), so macOS and Linux
    // run the session-release half of the cleanup from the download-finished
    // callback instead: after the payload has verified, before the installer
    // replaces files -- a failed download leaves every session intact. Core
    // cleanup is left to restart()'s normal exit path.
    #[cfg(not(windows))]
    let finish_app = app.clone();
    #[cfg(not(windows))]
    let on_download_finish = move || shutdown_sessions_and_save_state(&finish_app);
    #[cfg(windows)]
    let on_download_finish = || {};
    update
        .download_and_install(
            move |chunk_len, total| {
                downloaded += chunk_len as u64;
                emit_progress(&progress_app, downloaded, total, &mut last_percent);
            },
            on_download_finish,
        )
        .await
        .map_err(|e| e.to_string())?;
    // macOS/Linux: install() returns; relaunch into the new version (restart
    // never returns -- the process is replaced). Windows never reaches here
    // (install exits the process inside).
    app.restart()
}

/// The throttle decision (extracted so its test pins the SHIPPED logic, not a
/// copy): fire on the first chunk and each whole-percent change when the
/// content length is known, every 512 KiB otherwise.
fn should_emit_progress(
    downloaded: u64,
    total: Option<u64>,
    last_percent: &mut Option<u64>,
) -> bool {
    match total {
        Some(total) if total > 0 => {
            let percent = (downloaded.saturating_mul(100) / total).min(100);
            let changed = last_percent.is_none() || *last_percent.as_ref().unwrap() != percent;
            if changed {
                *last_percent = Some(percent);
            }
            changed
        }
        _ => downloaded % (512 * 1024) == 0,
    }
}

/// Emit a throttled download-progress event via [`should_emit_progress`]. A
/// torn-down webview fails the emit; that is the expected case during exit,
/// so the error is ignored.
fn emit_progress(
    app: &AppHandle,
    downloaded: u64,
    total: Option<u64>,
    last_percent: &mut Option<u64>,
) {
    if should_emit_progress(downloaded, total, last_percent) {
        let _ = app.emit(
            DOWNLOAD_PROGRESS_EVENT,
            DownloadProgress {
                downloaded,
                content_length: total,
            },
        );
    }
}

/// The session-release half of the update cleanup: cancel + detach every live
/// session (their release reaps the external CLI children and bridge sidecars
/// and drops each in-memory DuckDB), then the explicit window-state save.
/// Shared by the Windows `on_before_exit` chain and the non-Windows
/// download-finished seam. Best-effort-logged: the update proceeds even when
/// a step degrades -- the user confirmed the interruption at the dialog.
fn shutdown_sessions_and_save_state(app: &AppHandle) {
    if let Some(store) = app.try_state::<std::sync::Arc<SessionStore>>() {
        let stragglers = store.shutdown_all(SHUTDOWN_RELEASE_WAIT);
        if stragglers > 0 {
            log::warn!(
                "update-exit cleanup: {stragglers} session(s) still releasing at the \
                 deadline; proceeding with the update exit"
            );
        }
    } else {
        log::warn!("update-exit cleanup: session store not managed; sessions skipped");
    }
    if let Err(e) = {
        use tauri_plugin_window_state::AppHandleExt;
        app.save_window_state(window_state_flags())
    } {
        log::warn!("update-exit cleanup: window-state save failed: {e}");
    }
}

/// The pre-exit cleanup chain (ADR-0143 Decision 5), riding `on_before_exit`
/// because Windows `install()` bypasses every exit hook: session release +
/// window state (above), then the Tauri core cleanup (tray icon, resource
/// tables).
fn cleanup_before_update_exit(app: &AppHandle) {
    shutdown_sessions_and_save_state(app);
    app.cleanup_before_exit();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The endpoints are burned into every shipped binary at compile time
    /// (ADR-0143: an endpoint added later is invisible to already-shipped
    /// versions), so this pin makes any accidental edit of the pair -- or of
    /// the updater artifacts switch -- fail in CI instead of shipping a
    /// self-bricking updater.
    #[test]
    fn updater_config_pins_endpoints_and_artifacts() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains("\"https://dl.toptopduck.dev/latest.json\""),
            "mirror (primary) endpoint missing or changed"
        );
        assert!(
            conf.contains(
                "\"https://github.com/toptopworks/toptopduck/releases/latest/download/latest.json\""
            ),
            "GitHub (fallback) endpoint missing or changed"
        );
        assert!(
            conf.contains("\"createUpdaterArtifacts\": true"),
            "updater artifact generation is off"
        );
    }

    /// The reboot-suppression property is the only defense against a silent
    /// machine restart on the MSI path; freeze the literal so a refactor
    /// cannot drop or rename it unnoticed. Runs on every OS (the const is
    /// unconditional; only the use site is cfg(windows)).
    #[test]
    fn windows_installer_args_pin_reboot_suppression() {
        assert_eq!(WINDOWS_INSTALLER_ARGS, &["REBOOT=ReallySuppress"]);
    }

    /// The IPC face is camelCase (the frontend types expect it); a rename in
    /// either direction fails here rather than as a runtime `undefined`.
    #[test]
    fn update_info_serializes_camel_case() {
        let info = UpdateInfo {
            version: "0.5.0".into(),
            notes: Some("notes".into()),
            current_version: "0.4.0".into(),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["version"], "0.5.0");
        assert_eq!(json["notes"], "notes");
        assert_eq!(json["currentVersion"], "0.4.0");
    }

    /// The progress payload's camelCase is equally load-bearing (the frontend
    /// reads `contentLength`; a dropped rename yields a forever-null percent
    /// with zero errors), so it gets the same pin.
    #[test]
    fn download_progress_serializes_camel_case() {
        let payload = DownloadProgress {
            downloaded: 512,
            content_length: Some(1024),
        };
        // By value (Copy): the newer CI clippy flags the borrowed form as a
        // needless borrow for generic args.
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["downloaded"], 512);
        assert_eq!(json["contentLength"], 1024);
    }

    /// The percent-step throttle: with a known total, an event fires on the
    /// first chunk and on each whole-percent boundary crossing -- and nowhere
    /// between (same-percent chunks stay silent). Pins the production
    /// [`should_emit_progress`] directly -- the decision the emit path rides.
    #[test]
    fn progress_emits_on_percent_change_only() {
        let mut last = None;
        let mut fired = 0;
        for downloaded in [0u64, 5, 9, 10, 14, 19, 20] {
            if should_emit_progress(downloaded, Some(1000), &mut last) {
                fired += 1;
            }
        }
        assert_eq!(
            fired, 3,
            "fires at 0 (first chunk), 10 (1%), 20 (2%); same-percent chunks stay silent"
        );
    }
}
