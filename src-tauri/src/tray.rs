//! System tray residency (ADR-0125, issue #1140). The tray is the app's
//! resident surface while the main window is hidden: closing the window
//! ALWAYS hides (never kills) the process -- unconditionally, with no
//! turn-state branching (ADR-0125 Decision 1) -- because a running turn's
//! execution lives in backend threads + external CLIs and its approval
//! surface lives in the webview, so destroying the window would strand
//! the turn (ADR-0125 Context).
//!
//! Menu shape (ADR-0125 Decision 3): a disabled "recent" header + the 3
//! most recent sessions + a "more" submenu holding the next 10 (omitted
//! entirely when empty) + new session / open main window / quit. Session
//! data comes from the SAME directory scan the sidebar uses (ADR-0089) --
//! same source, same fields. The two lists refresh independently (the
//! sidebar on demand, the tray per visit), so a transient freshness gap
//! is normal; the scan is shared, so the shape never diverges. The menu
//! is rebuilt on tray hover/click (throttled) rather than kept live -- a
//! stale-by-one-visit list is the accepted cost of not running a watcher.
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
const OPEN_SESSION_EVENT: &str = "tray://open-session";

/// Emitted when the tray "new session" item is clicked. No payload: the
/// frontend action is the same as the sidebar "+" (navigate to the empty
/// state, ADR-0092) -- zero new session semantics on the tray side.
const NEW_SESSION_EVENT: &str = "tray://new-session";

const ID_NEW_SESSION: &str = "tray-new-session";
const ID_OPEN_MAIN: &str = "tray-open-main";
const ID_QUIT: &str = "tray-quit";
const ID_RECENT_HEADER: &str = "tray-recent-header";
const ID_MORE: &str = "tray-more";
/// Session item ids embed the `.duck` path after this prefix; the click
/// handler parses it back out. A path collision with the fixed ids is
/// impossible by namespace: session ids always start with this prefix,
/// the fixed ids never do.
const ID_SESSION_PREFIX: &str = "tray-open-session::";

/// How many sessions the top level of the menu shows (Decision 3: 3 + more).
const RECENT_CAP: usize = 3;
/// How many sessions the "more" submenu holds (Decision 3: next 10).
const MORE_CAP: usize = 10;
/// Minimum spacing between menu rebuilds (throttled -- sweeping the tray area
/// must not scan the directory per visit; the trigger set lives in
/// [`plan_tray_event`]).
const REBUILD_THROTTLE: Duration = Duration::from_secs(5);

/// The `tray://open-session` payload. `duck_path` alone; see
/// [`OPEN_SESSION_EVENT`].
#[derive(Debug, Clone, serde::Serialize)]
struct OpenSessionPayload {
    duck_path: String,
}

/// All user-facing tray strings in one locale. Two languages only -- the app
/// ships exactly en/zh catalogs, so a tray table for more would be
/// speculative (YAGNI).
#[derive(Debug, Clone, Copy)]
struct TrayTexts {
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
fn texts_for(pref: LocalePreference, os_locale: Option<&str>) -> TrayTexts {
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
fn split_recent(metas: &[SessionMetadata]) -> (&[SessionMetadata], &[SessionMetadata]) {
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
fn session_label<'a>(m: &'a SessionMetadata, texts: &'a TrayTexts) -> &'a str {
    if m.display_name.trim().is_empty() {
        texts.unnamed_session
    } else {
        &m.display_name
    }
}

/// What a tray menu click asks for, parsed back out of the menu item id.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TrayAction {
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
fn parse_menu_id(id: &str) -> Option<TrayAction> {
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

/// One session menu item per metadata entry, in list order -- pure data:
/// the menu item id, the label, and clickability. `build_menu` materializes
/// rows against an app handle; the plan is what tests pin.
#[derive(Debug)]
struct MenuRow {
    id: String,
    text: String,
    enabled: bool,
}

/// One planned top-level menu slot: a row, or the "more" submenu in its
/// display position.
#[derive(Debug)]
enum MenuEntry {
    Row(MenuRow),
    More {
        title: String,
        children: Vec<MenuRow>,
    },
}

/// Plan the whole tray menu as pure data, in display order: the disabled
/// "recent" header, the recent rows, the optional "more" submenu, then the
/// three fixed actions. The submenu is omitted entirely when there is
/// nothing to hold (Decision 3: an empty submenu renders as a dead-end item
/// on some platforms). Pure so the assembly -- order, omission, disabled
/// header, fixed entries -- is pinnable without an app handle.
fn plan_menu(metas: &[SessionMetadata], texts: &TrayTexts) -> Vec<MenuEntry> {
    fn row(id: String, text: &str, enabled: bool) -> MenuRow {
        MenuRow {
            id,
            text: text.to_string(),
            enabled,
        }
    }
    fn session_row(m: &SessionMetadata, texts: &TrayTexts) -> MenuRow {
        row(
            format!("{ID_SESSION_PREFIX}{}", m.duck_path.as_str()),
            session_label(m, texts),
            true,
        )
    }
    let (recent, more) = split_recent(metas);
    let mut entries: Vec<MenuEntry> = Vec::with_capacity(5 + recent.len());
    // Disabled: the header is a label, not an action.
    entries.push(MenuEntry::Row(row(
        ID_RECENT_HEADER.into(),
        texts.recent_header,
        false,
    )));
    entries.extend(recent.iter().map(|m| MenuEntry::Row(session_row(m, texts))));
    if !more.is_empty() {
        entries.push(MenuEntry::More {
            title: texts.more.to_string(),
            children: more.iter().map(|m| session_row(m, texts)).collect(),
        });
    }
    entries.push(MenuEntry::Row(row(
        ID_NEW_SESSION.into(),
        texts.new_session,
        true,
    )));
    entries.push(MenuEntry::Row(row(
        ID_OPEN_MAIN.into(),
        texts.open_main,
        true,
    )));
    entries.push(MenuEntry::Row(row(ID_QUIT.into(), texts.quit, true)));
    entries
}

/// Build the tray's menu from the current session list + texts by
/// materializing [`plan_menu`]'s output. A failure (menu construction is
/// fallible on every platform) propagates to the caller, which degrades.
fn build_menu(
    app: &AppHandle,
    metas: &[SessionMetadata],
    texts: &TrayTexts,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let materialize = |rows: &[MenuRow]| -> tauri::Result<Vec<Box<dyn IsMenuItem<tauri::Wry>>>> {
        let mut out: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::with_capacity(rows.len());
        for r in rows {
            let item =
                tauri::menu::MenuItem::with_id(app, &r.id, &r.text, r.enabled, None::<&str>)?;
            out.push(Box::new(item));
        }
        Ok(out)
    };
    let mut items: Vec<Box<dyn IsMenuItem<tauri::Wry>>> = Vec::new();
    for entry in &plan_menu(metas, texts) {
        match entry {
            MenuEntry::Row(r) => items.extend(materialize(std::slice::from_ref(r))?),
            MenuEntry::More { title, children } => {
                let rows = materialize(children)?;
                let submenu = tauri::menu::Submenu::with_id(app, ID_MORE, title, true)?;
                let refs: Vec<&dyn IsMenuItem<_>> = rows.iter().map(|i| i.as_ref()).collect();
                submenu.append_items(&refs)?;
                items.push(Box::new(submenu));
            }
        }
    }
    let refs: Vec<&dyn IsMenuItem<_>> = items.iter().map(|i| i.as_ref()).collect();
    tauri::menu::Menu::with_items(app, &refs)
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

/// The close-requested decision (ADR-0125 Decisions 1 + 2): a live tray
/// means the window close HIDES (residency); anything else keeps the
/// default real close so the "window hidden, no tray, no exit path" state
/// stays unreachable. Extracted as a named, pinned seam -- the close
/// handler is imperative wiring around this boolean, which is the part
/// tests can hold.
pub(crate) fn close_hides(tray_available: bool) -> bool {
    tray_available
}

/// Rebuild the tray menu off the event thread: scan the sessions directory
/// (spawn_blocking, the same posture as the `list_sessions` command),
/// re-resolve strings, and swap the menu in. Throttled so tray hovering and
/// clicking cannot hammer the scan; a FAILED scan-join, build, or swap
/// releases the throttle window (the timestamp reserves it against
/// concurrent spawns, then clears on failure) so the next visit retries
/// instead of waiting out a window a dead build burned, and logs while
/// keeping the previous menu -- a stale list beats no tray. The scan itself
/// cannot fail loudly: it degrades to an empty list (the same face the
/// sidebar's error path shows), which swaps in honestly and self-heals on
/// the next post-throttle visit.
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

/// What the tray-icon event wiring does for one event: whether it reveals
/// the window and whether it triggers a menu rebuild. Extracted as a named,
/// pinned seam like [`close_hides`] -- the wiring around it is imperative.
#[derive(Debug)]
struct TrayEventPlan {
    reveal: bool,
    rebuild: bool,
}

/// Decide the wiring for one tray-icon event. The rebuild trigger rides
/// hover enter and the LEFT click; a RIGHT-click rebuild races Windows's
/// menu display: `set_menu` swapping the HMENU while it is open closes the
/// menu on the spot -- the first right click showed a flash of menu, and
/// the throttle then suppressed the rebuild so the second click worked.
/// Enter gives the rebuild the hover-to-click gap to settle BEFORE the menu
/// opens; the left click stays as a trigger (it never opens the menu) so
/// hover-less hosts (Linux SNI) still refresh.
fn plan_tray_event(event: &TrayIconEvent) -> TrayEventPlan {
    match event {
        TrayIconEvent::Enter { .. } => TrayEventPlan {
            reveal: false,
            rebuild: true,
        },
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } => TrayEventPlan {
            reveal: true,
            rebuild: true,
        },
        _ => TrayEventPlan {
            reveal: false,
            rebuild: false,
        },
    }
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
            let plan = plan_tray_event(&event);
            if plan.reveal {
                show_main(tray.app_handle());
            }
            if plan.rebuild {
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

    // --- close decision (ADR-0125 D1 + D2) ---------------------------------

    #[test]
    fn close_hides_only_with_a_live_tray() {
        // D1: with the tray live, close hides the window (residency).
        assert!(close_hides(true));
        // D2: with the tray unavailable, close falls through to the real
        // exit -- the stranded "hidden window, no exit path" state stays
        // unreachable.
        assert!(!close_hides(false));
    }

    // --- wire names (the frontend listens on these exact strings) ----------

    #[test]
    fn wire_names_match_the_frontend_listeners() {
        // api.ts listens on these literals with no parity test of its own;
        // this pin makes a one-side rename visible on the Rust side.
        assert_eq!(OPEN_SESSION_EVENT, "tray://open-session");
        assert_eq!(NEW_SESSION_EVENT, "tray://new-session");
    }

    // --- plan_menu (assembly: order, omission, fixed entries) --------------

    #[test]
    fn plan_pins_the_full_assembly_order() {
        let metas: Vec<_> = (0..4).map(|i| meta(&format!("s{i}.duck"), "n")).collect();
        let plan = plan_menu(&metas, &texts_for(LocalePreference::EnUS, None));
        let rows: Vec<(&str, &str, bool)> = plan
            .iter()
            .filter_map(|e| match e {
                MenuEntry::Row(r) => Some((r.id.as_str(), r.text.as_str(), r.enabled)),
                MenuEntry::More { .. } => None,
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                (ID_RECENT_HEADER, "Recent sessions", false),
                ("tray-open-session::s0.duck", "n", true),
                ("tray-open-session::s1.duck", "n", true),
                ("tray-open-session::s2.duck", "n", true),
                (ID_NEW_SESSION, "New session", true),
                (ID_OPEN_MAIN, "Open main window", true),
                (ID_QUIT, "Quit", true),
            ]
        );
        // The fourth session rides the "more" submenu in its display
        // position (after the recent rows, before the fixed actions), in
        // scan order.
        match &plan[4] {
            MenuEntry::More { title, children } => {
                assert_eq!(title, "More");
                assert_eq!(
                    children.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
                    vec!["tray-open-session::s3.duck"]
                );
            }
            other => panic!("expected the more submenu at index 4, got {other:?}"),
        }
    }

    #[test]
    fn plan_omits_the_more_submenu_when_empty() {
        let metas: Vec<_> = (0..3).map(|i| meta(&format!("s{i}.duck"), "n")).collect();
        let plan = plan_menu(&metas, &texts_for(LocalePreference::ZhCN, None));
        assert!(plan.iter().all(|e| !matches!(e, MenuEntry::More { .. })));
        // With no sessions at all the header + the three fixed actions
        // remain -- the empty tray still offers new/open/quit.
        let plan = plan_menu(&[], &texts_for(LocalePreference::ZhCN, None));
        assert_eq!(plan.len(), 4);
    }

    // --- plan_tray_event (rebuild trigger stays off the right click) ------

    use tauri::tray::TrayIconId;
    use tauri::{PhysicalPosition, PhysicalSize, Position, Rect, Size};

    /// A minimal Click event: id/position/rect carry no wiring weight.
    fn click(button: MouseButton, state: MouseButtonState) -> TrayIconEvent {
        TrayIconEvent::Click {
            id: TrayIconId(TRAY_ID.into()),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect {
                position: Position::Physical(PhysicalPosition::new(0, 0)),
                size: Size::Physical(PhysicalSize::new(0, 0)),
            },
            button,
            button_state: state,
        }
    }

    fn enter() -> TrayIconEvent {
        TrayIconEvent::Enter {
            id: TrayIconId(TRAY_ID.into()),
            position: PhysicalPosition::new(0.0, 0.0),
            rect: Rect {
                position: Position::Physical(PhysicalPosition::new(0, 0)),
                size: Size::Physical(PhysicalSize::new(0, 0)),
            },
        }
    }

    #[test]
    fn right_click_up_triggers_neither_action() {
        // The bug this pins: a right-click-up rebuild swapped the HMENU
        // while Windows had the menu open, closing it on the spot.
        let plan = plan_tray_event(&click(MouseButton::Right, MouseButtonState::Up));
        assert!(!plan.reveal);
        assert!(!plan.rebuild);
    }

    #[test]
    fn left_click_up_reveals_and_rebuilds() {
        let plan = plan_tray_event(&click(MouseButton::Left, MouseButtonState::Up));
        assert!(plan.reveal);
        assert!(plan.rebuild);
    }

    #[test]
    fn left_click_down_does_nothing() {
        let plan = plan_tray_event(&click(MouseButton::Left, MouseButtonState::Down));
        assert!(!plan.reveal);
        assert!(!plan.rebuild);
    }

    #[test]
    fn enter_rebuilds_without_revealing() {
        // Hover refreshes the menu without stealing focus from whatever the
        // user is doing -- Enter must not reveal.
        let plan = plan_tray_event(&enter());
        assert!(!plan.reveal);
        assert!(plan.rebuild);
    }
}
