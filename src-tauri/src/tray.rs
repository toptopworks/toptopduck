//! System tray residency (ADR-0125, issue #1140). The tray is the app's
//! resident surface while the main window is hidden: closing the window
//! always hides (never kills) the process while a turn may be in flight
//! -- the turn's execution lives in backend threads + external CLIs, and
//! the approval surface lives in the webview, so destroying the window
//! would deadlock the turn (ADR-0125 Context).
//!
//! Menu shape (the ChatGPT/WorkBuddy consensus form, ADR-0125 Decision 3):
//! a disabled "recent" header + the 3 most recent sessions + a "more"
//! submenu holding the next 10 (omitted entirely when empty) + new
//! session / open main window / quit. Session data comes from the SAME
//! directory scan the sidebar uses (ADR-0089), so the tray list and the
//! sidebar can never disagree about what exists. The menu is rebuilt on
//! tray click (throttled) rather than kept live -- a stale-by-one-click
//! list is the accepted cost of not running a watcher.
//!
//! Exit semantics (ADR-0125 Decision 1): the tray Quit item is the ONLY
//! exit channel, via a plain `app.exit(0)`. `ExitRequested` is not
//! intercepted, there is no confirmation, and no ghost-icon prevention
//! code (no restart flow, no `std::process::exit` bypass exists to route
//! around).
//!
//! Degradation (ADR-0125 Decision 2): tray creation failure returns
//! `false` from [`init`], and the close handler falls back to a real
//! close -- the catastrophic "window hidden, no tray, no exit path"
//! state is unreachable by construction. Linux trays may be entirely
//! absent (no StatusNotifierItem host), so the fallback is a real path,
//! not defensive dead code.
//!
//! Tray strings mirror the locale preference's three states
//! (ADR-0052): explicit zh-CN / en-US override, `System` resolved via
//! sys-locale exactly like the Rust-side response-locale directive (the
//! frontend never pushes locale over IPC).

use std::time::{Duration, Instant};

use tauri::menu::IsMenuItem;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_config::LocalePreference;
use crate::persistence::{scan_sessions_dir, SessionMetadata, SessionsRoot};
use crate::provider::live_config::LiveProviderConfig;

/// The tray's registered id; the rebuild path re-resolves the tray by it.
const TRAY_ID: &str = "main-tray";

/// Emitted when a tray menu session item is clicked. Payload is the `.duck`
/// path (the stable session identity, ADR-0089) -- the frontend resolves the
/// display name from its persisted-session list, keeping the wire shape
/// minimal and the payload type shared with nothing else.
pub(crate) const OPEN_SESSION_EVENT: &str = "tray://open-session";

/// Emitted when the tray "new session" item is clicked. No payload: the
/// frontend action is the same as the sidebar "+" (navigate to the empty
/// state, ADR-0092) -- zero new session semantics on the tray side.
pub(crate) const NEW_SESSION_EVENT: &str = "tray://new-session";

const ID_NEW_SESSION: &str = "tray-new-session";
const ID_OPEN_MAIN: &str = "tray-open-main";
const ID_QUIT: &str = "tray-quit";
const ID_RECENT_HEADER: &str = "tray-recent-header";
const ID_MORE: &str = "tray-more";
/// Session item ids embed the `.duck` path after this prefix; the click
/// handler parses it back out. A path collision with the fixed ids is
/// impossible because the prefix is checked after the exact matches.
const ID_SESSION_PREFIX: &str = "tray-open-session::";

/// How many sessions the top level of the menu shows (Decision 3: 3 + more).
const RECENT_CAP: usize = 3;
/// How many sessions the "more" submenu holds (Decision 3: next 10).
const MORE_CAP: usize = 10;
/// Minimum spacing between on-click menu rebuilds (Decision 3: rebuild on
/// click, throttled -- rapid clicking must not scan the directory per click).
const REBUILD_THROTTLE: Duration = Duration::from_secs(5);

/// The `tray://open-session` payload. `duck_path` alone; see
/// [`OPEN_SESSION_EVENT`].
#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct OpenSessionPayload {
    pub(crate) duck_path: String,
}

/// All user-facing tray strings in one locale. Two languages only -- the app
/// ships exactly en/zh catalogs, so a tray table for more would be
/// speculative (YAGNI).
#[derive(Debug, Clone, Copy)]
pub(crate) struct TrayTexts {
    pub(crate) recent_header: &'static str,
    pub(crate) more: &'static str,
    pub(crate) new_session: &'static str,
    pub(crate) open_main: &'static str,
    pub(crate) quit: &'static str,
    pub(crate) unnamed_session: &'static str,
}

const ZH: TrayTexts = TrayTexts {
    recent_header: "最近会话",
    more: "更多",
    new_session: "新会话",
    open_main: "打开主窗",
    quit: "退出",
    unnamed_session: "未命名会话",
};

const EN: TrayTexts = TrayTexts {
    recent_header: "Recent sessions",
    more: "More",
    new_session: "New session",
    open_main: "Open main window",
    quit: "Quit",
    unnamed_session: "Unnamed session",
};

/// Resolve the tray strings for one locale preference. `System` follows the
/// OS locale through the SAME zh/en bucketing the response-locale directive
/// uses (`resolve_locale_from_tag`, ADR-0052 -- one mapping, not a tray
/// copy of it); an explicit preference overrides the OS. `os_locale` is a
/// parameter so the mapping is unit-testable without touching the real OS
/// locale.
pub(crate) fn texts_for(pref: LocalePreference, os_locale: Option<&str>) -> TrayTexts {
    let zh = match pref {
        LocalePreference::ZhCN => true,
        LocalePreference::EnUS => false,
        LocalePreference::System => os_locale.is_some_and(|tag| {
            matches!(
                crate::provider::prompt::resolve_locale_from_tag(tag),
                crate::provider::prompt::ResponseLocale::ZhCN
            )
        }),
    };
    if zh {
        ZH
    } else {
        EN
    }
}

/// Split the session list into (top-level recent, "more" submenu) slices.
/// `metas` MUST already be newest-first -- [`scan_sessions_dir`] sorts by
/// descending mtime, and this function preserves that order verbatim
/// (display-name-only menu, no re-sorting).
pub(crate) fn split_recent(metas: &[SessionMetadata]) -> (&[SessionMetadata], &[SessionMetadata]) {
    let recent_len = metas.len().min(RECENT_CAP);
    let more_len = (metas.len() - recent_len).min(MORE_CAP);
    (
        &metas[..recent_len],
        &metas[recent_len..recent_len + more_len],
    )
}

/// One menu session item's label. A session with no name AND no sources has
/// an empty `display_name`; an empty tray row is unreadable, so it falls
/// back to the localized "unnamed" string.
pub(crate) fn session_label<'a>(m: &'a SessionMetadata, texts: &'a TrayTexts) -> &'a str {
    if m.display_name.trim().is_empty() {
        texts.unnamed_session
    } else {
        &m.display_name
    }
}

/// What a tray menu click asks for, parsed back out of the menu item id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TrayAction {
    /// Open (or reveal) the persisted session bound to this `.duck` path.
    OpenSession {
        duck_path: String,
    },
    NewSession,
    OpenMain,
    Quit,
}

/// Parse a menu item id back into its action. Session ids embed the path;
/// the three fixed actions match exactly; anything else (a submenu/header
/// id, or a foreign id) is `None` and silently ignored -- an unknown id has
/// no honest action, and erroring on it would only log noise.
pub(crate) fn parse_menu_id(id: &str) -> Option<TrayAction> {
    if id == ID_NEW_SESSION {
        return Some(TrayAction::NewSession);
    }
    if id == ID_OPEN_MAIN {
        return Some(TrayAction::OpenMain);
    }
    if id == ID_QUIT {
        return Some(TrayAction::Quit);
    }
    id.strip_prefix(ID_SESSION_PREFIX)
        .map(|path| TrayAction::OpenSession {
            duck_path: path.to_string(),
        })
}

/// One session menu item per metadata entry, in list order. Shared by the
/// top-level recent rows and the "more" submenu rows (same item shape, same
/// id scheme -- where the row lands is the caller's split, not the item's).
fn session_items(
    app: &AppHandle,
    metas: &[SessionMetadata],
    texts: &TrayTexts,
) -> tauri::Result<Vec<tauri::menu::MenuItem<tauri::Wry>>> {
    metas
        .iter()
        .map(|m| {
            tauri::menu::MenuItem::with_id(
                app,
                format!("{ID_SESSION_PREFIX}{}", m.duck_path.as_str()),
                session_label(m, texts),
                true,
                None::<&str>,
            )
        })
        .collect()
}

/// Build the tray's menu from the current session list + texts. The
/// disabled header, the 3 recent items, the optional "more" submenu, then
/// the three fixed actions. A failure (menu construction is fallible on
/// every platform) propagates to the caller, which degrades.
fn build_menu(
    app: &AppHandle,
    metas: &[SessionMetadata],
    texts: &TrayTexts,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let (recent, more) = split_recent(metas);
    let header = tauri::menu::MenuItem::with_id(
        app,
        ID_RECENT_HEADER,
        texts.recent_header,
        // Disabled: the header is a label, not an action.
        false,
        None::<&str>,
    )?;
    let recent_items = session_items(app, recent, texts)?;
    let more_items = session_items(app, more, texts)?;
    // The "more" submenu is omitted entirely when there is nothing to hold
    // (Decision 3: an empty submenu renders as a dead-end item on some
    // platforms).
    let more_submenu = if more_items.is_empty() {
        None
    } else {
        let submenu = tauri::menu::Submenu::with_id(app, ID_MORE, texts.more, true)?;
        let refs: Vec<&dyn IsMenuItem<_>> =
            more_items.iter().map(|i| i as &dyn IsMenuItem<_>).collect();
        submenu.append_items(&refs)?;
        Some(submenu)
    };
    let new_item =
        tauri::menu::MenuItem::with_id(app, ID_NEW_SESSION, texts.new_session, true, None::<&str>)?;
    let open_item =
        tauri::menu::MenuItem::with_id(app, ID_OPEN_MAIN, texts.open_main, true, None::<&str>)?;
    let quit_item = tauri::menu::MenuItem::with_id(app, ID_QUIT, texts.quit, true, None::<&str>)?;
    let mut items: Vec<&dyn IsMenuItem<_>> = Vec::with_capacity(3 + recent_items.len() + 1);
    items.push(&header);
    for i in &recent_items {
        items.push(i);
    }
    if let Some(sub) = &more_submenu {
        items.push(sub);
    }
    items.push(&new_item);
    items.push(&open_item);
    items.push(&quit_item);
    tauri::menu::Menu::with_items(app, &items)
}

/// Reveal the main window from any state (hidden resident, minimized,
/// taskbar-skipped). Shared by the tray left click, the tray menu's
/// open/session/new actions, and the single-instance second-launch
/// callback -- every "the user wants the window" path funnels here so the
/// reveal ordering (taskbar restore -> unminimize -> show -> focus) is
/// defined once. Windows additionally clears the hide-time taskbar skip;
/// the other platforms' set_skip_taskbar calls in the hide path are
/// Windows-only too, so they stay symmetric.
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(target_os = "windows")]
        let _ = window.set_skip_taskbar(false);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The current locale preference, read through the same config carrier the
/// rest of the backend uses. A read failure degrades to the default
/// (`System`) preference -- the tray must never fail to build over strings.
fn current_texts(app: &AppHandle) -> TrayTexts {
    let pref = app
        .try_state::<LiveProviderConfig>()
        .map(|live| live.load().locale)
        .unwrap_or_default();
    texts_for(pref, sys_locale::get_locale().as_deref())
}

/// Rebuild the tray menu off the event thread: scan the sessions directory
/// (spawn_blocking, the same posture as the `list_sessions` command),
/// re-resolve strings, and swap the menu in. Throttled so tray clicking
/// cannot hammer the scan; a FAILED rebuild releases the throttle window
/// (the timestamp is set to reserve the window against concurrent spawns,
/// then cleared on failure) so the next click retries instead of waiting
/// out a window a dead scan burned. A failure logs and keeps the previous
/// menu -- a stale list beats no tray.
fn rebuild_soon(app: AppHandle) {
    static LAST_REBUILD: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    tauri::async_runtime::spawn(async move {
        let release_throttle = || {
            *LAST_REBUILD
                .lock()
                .expect("tray rebuild throttle lock poisoned") = None;
        };
        {
            let mut last = LAST_REBUILD
                .lock()
                .expect("tray rebuild throttle lock poisoned");
            if last.is_some_and(|t| t.elapsed() < REBUILD_THROTTLE) {
                return;
            }
            *last = Some(Instant::now());
        }
        let Some(root) = app.try_state::<SessionsRoot>() else {
            return;
        };
        let dir = root.path();
        let metas =
            match tauri::async_runtime::spawn_blocking(move || scan_sessions_dir(&dir)).await {
                Ok(m) => m,
                Err(e) => {
                    log::warn!("tray menu rebuild scan failed: {e}");
                    release_throttle();
                    return;
                }
            };
        let menu = match build_menu(&app, &metas, &current_texts(&app)) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("tray menu rebuild failed: {e}");
                release_throttle();
                return;
            }
        };
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            if let Err(e) = tray.set_menu(Some(menu)) {
                log::warn!("tray menu swap failed: {e}");
                release_throttle();
            }
        }
    });
}

/// Register the system tray. Returns whether it is live; the caller keys the
/// close-to-hide semantics off this (ADR-0125 Decision 2 -- an unavailable
/// tray keeps close = real exit). The initial menu carries no sessions (zero
/// scan in the synchronous boot path); a first rebuild is kicked off right
/// after registration so the very first menu open shows live data without
/// requiring a prior click.
pub(crate) fn init(app: &AppHandle) -> bool {
    let Some(icon) = app.default_window_icon() else {
        log::warn!("no default window icon for the tray; tray residency unavailable");
        return false;
    };
    let menu = match build_menu(app, &[], &current_texts(app)) {
        Ok(m) => m,
        Err(e) => {
            log::warn!("tray initial menu build failed: {e}");
            return false;
        }
    };
    let built = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
        .tooltip("toptopduck")
        .menu(&menu)
        // Tauri v2's default shows the menu on LEFT click too; the resident
        // idiom (ADR-0125 Decision 4) is left = reveal window, right = menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match parse_menu_id(event.id().as_ref()) {
            Some(TrayAction::OpenSession { duck_path }) => {
                show_main(app);
                if let Err(e) = app.emit(OPEN_SESSION_EVENT, OpenSessionPayload { duck_path }) {
                    log::warn!("tray open-session emit failed: {e}");
                }
            }
            Some(TrayAction::NewSession) => {
                show_main(app);
                if let Err(e) = app.emit(NEW_SESSION_EVENT, ()) {
                    log::warn!("tray new-session emit failed: {e}");
                }
            }
            Some(TrayAction::OpenMain) => show_main(app),
            Some(TrayAction::Quit) => app.exit(0),
            None => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if button == MouseButton::Left {
                    show_main(tray.app_handle());
                }
                // Any-button click (left reveals, right opens the menu) is
                // the menu-freshness trigger; hover/move events do not
                // rebuild. The rebuild itself is throttled.
                rebuild_soon(tray.app_handle().clone());
            }
        })
        .build(app);
    match built {
        Ok(_) => {
            // Boot-time first fill: an empty menu satisfies nobody, and the
            // throttle gate starts open so this scan always runs.
            rebuild_soon(app.clone());
            true
        }
        Err(e) => {
            log::warn!("tray icon build failed; close stays a real exit: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::{DuckPath, SourceSummary};

    fn meta(path: &str, name: &str) -> SessionMetadata {
        SessionMetadata {
            duck_path: DuckPath::new(path),
            display_name: name.into(),
            last_modified_at: 0,
            source_summary: SourceSummary {
                first_source_name: None,
                source_count: 0,
                turn_count: 0,
            },
            format_version: 1,
        }
    }

    fn paths(metas: &[SessionMetadata]) -> Vec<&str> {
        metas.iter().map(|m| m.duck_path.as_str()).collect()
    }

    // --- texts_for (three-state mirror, ADR-0052) --------------------------

    #[test]
    fn system_follows_the_os_locale() {
        assert_eq!(
            texts_for(LocalePreference::System, Some("zh-CN")).quit,
            ZH.quit
        );
        assert_eq!(
            texts_for(LocalePreference::System, Some("zh")).quit,
            ZH.quit
        );
        assert_eq!(
            texts_for(LocalePreference::System, Some("en-US")).quit,
            EN.quit
        );
        // Case-insensitive tag matching.
        assert_eq!(
            texts_for(LocalePreference::System, Some("ZH-Hant")).quit,
            ZH.quit
        );
        // No OS locale at all: the English bucket is the fallback.
        assert_eq!(texts_for(LocalePreference::System, None).quit, EN.quit);
    }

    #[test]
    fn explicit_preference_overrides_the_os_locale() {
        assert_eq!(
            texts_for(LocalePreference::ZhCN, Some("en-US")).quit,
            ZH.quit
        );
        assert_eq!(
            texts_for(LocalePreference::EnUS, Some("zh-CN")).quit,
            EN.quit
        );
    }

    // --- split_recent (3 + more-10, Decision 3) ----------------------------

    #[test]
    fn split_empty_yields_no_menu_rows_and_no_submenu() {
        let metas: Vec<SessionMetadata> = Vec::new();
        let (recent, more) = split_recent(&metas);
        assert!(recent.is_empty());
        assert!(more.is_empty());
    }

    #[test]
    fn split_three_stays_top_level() {
        let metas: Vec<_> = (0..3).map(|i| meta(&format!("s{i}.duck"), "n")).collect();
        let (recent, more) = split_recent(&metas);
        assert_eq!(paths(recent), vec!["s0.duck", "s1.duck", "s2.duck"]);
        assert!(more.is_empty());
    }

    #[test]
    fn split_four_puts_the_fourth_into_more() {
        let metas: Vec<_> = (0..4).map(|i| meta(&format!("s{i}.duck"), "n")).collect();
        let (recent, more) = split_recent(&metas);
        assert_eq!(paths(recent), vec!["s0.duck", "s1.duck", "s2.duck"]);
        assert_eq!(paths(more), vec!["s3.duck"]);
    }

    #[test]
    fn split_caps_more_at_ten() {
        let metas: Vec<_> = (0..20).map(|i| meta(&format!("s{i}.duck"), "n")).collect();
        let (recent, more) = split_recent(&metas);
        assert_eq!(recent.len(), 3);
        assert_eq!(more.len(), 10);
        // Order is preserved newest-first (the scan's sort).
        assert_eq!(more[0].duck_path.as_str(), "s3.duck");
        assert_eq!(more[9].duck_path.as_str(), "s12.duck");
    }

    // --- session_label ------------------------------------------------------

    #[test]
    fn label_falls_back_to_unnamed_for_blank_display_names() {
        let texts = texts_for(LocalePreference::ZhCN, None);
        assert_eq!(
            session_label(&meta("a.duck", ""), &texts),
            texts.unnamed_session
        );
        // Whitespace-only is just as unreadable in a menu row.
        assert_eq!(
            session_label(&meta("a.duck", "  "), &texts),
            texts.unnamed_session
        );
        assert_eq!(
            session_label(&meta("a.duck", "我的分析"), &texts),
            "我的分析"
        );
    }

    // --- parse_menu_id ------------------------------------------------------

    #[test]
    fn parse_round_trips_a_session_path() {
        let id = format!("{ID_SESSION_PREFIX}C:\\sessions\\uuid\\session.duck");
        assert_eq!(
            parse_menu_id(&id),
            Some(TrayAction::OpenSession {
                duck_path: "C:\\sessions\\uuid\\session.duck".into()
            })
        );
    }

    #[test]
    fn parse_maps_the_fixed_actions_and_rejects_everything_else() {
        assert_eq!(parse_menu_id(ID_NEW_SESSION), Some(TrayAction::NewSession));
        assert_eq!(parse_menu_id(ID_OPEN_MAIN), Some(TrayAction::OpenMain));
        assert_eq!(parse_menu_id(ID_QUIT), Some(TrayAction::Quit));
        // Header / submenu / foreign ids carry no action.
        assert_eq!(parse_menu_id(ID_RECENT_HEADER), None);
        assert_eq!(parse_menu_id(ID_MORE), None);
        assert_eq!(parse_menu_id("tray-open-session:"), None);
        assert_eq!(parse_menu_id("anything-else"), None);
    }
}
