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
//! entirely when empty) + new session / open main window / quit -- two
//! native separators split that run into three zones: sessions, window
//! actions, and the exit. Session
//! data comes from the SAME directory scan the sidebar uses (ADR-0089) --
//! same source, same fields. The two lists refresh independently (the
//! sidebar on demand, the tray per visit), so a transient freshness gap
//! is normal; the scan is shared, so the shape never diverges. The menu
//! is rebuilt on tray hover and left click (throttled) rather than kept
//! live -- a stale-by-one-visit list is the accepted cost of not running
//! a watcher.
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
//! Tray-ready handshake (issue #1142): `app.emit` is a fire-and-forget
//! broadcast that returns `Ok` with zero listeners, so a session-level
//! menu click before the webview's tray listeners register would be lost
//! without a trace (cold start, or a webview reload). Such clicks buffer
//! in a single slot (the last action wins) and replay when the frontend's
//! `tray_ready` arrives; a webview page-load Started drops readiness
//! again so a reload re-arms the buffer. The window reveal never waits
//! for the handshake -- it runs on the Rust side at click time, and once
//! ready the steady path emits directly with zero handshake traffic.
//!
//! Tray strings mirror the locale preference's three states
//! (ADR-0052): explicit zh-CN / en-US override, `System` resolved via
//! sys-locale exactly like the Rust-side response-locale directive (the
//! frontend never pushes locale over IPC).

use std::time::{Duration, Instant};

use tauri::menu::IsMenuItem;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::persistence::{scan_sessions_dir, SessionMetadata, SessionsRoot};
use crate::provider::keychain::ProviderConfigSource;
use crate::provider::live_config::LiveProviderConfig;
use crate::provider::prompt::ResponseLocale;

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Resolve the tray strings for one resolved locale. The three-state
/// preference dispatch (explicit override / `System` -> OS tag bucketing)
/// lives in ONE place -- `ProviderConfigSource::locale` (ADR-0052, issue
/// #1144) -- so this is a plain table lookup on its output, not a tray copy
/// of the dispatch.
fn texts_for(locale: ResponseLocale) -> TrayTexts {
    match locale {
        ResponseLocale::ZhCN => ZH,
        ResponseLocale::EnUS => EN,
    }
}

/// The tray is recency-only (ADR-0125 Decision 3). The scan itself now
/// leads with the pinned block (ADR-0127), which is a sidebar concern, not
/// a tray one -- re-sort by descending mtime so pinned rows cannot
/// displace the genuinely recent ones from the 3+10 split.
fn sort_recency_first(metas: &mut [SessionMetadata]) {
    metas.sort_by_key(|m| std::cmp::Reverse(m.last_modified_at));
}

/// Split the session list into (top-level recent, "more" submenu) slices.
/// `metas` MUST already be newest-first -- the tray's rebuild runs
/// [`sort_recency_first`] before this point -- and this function preserves
/// that order verbatim (display-name-only menu, no re-sorting).
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

/// One planned top-level menu slot: a row, a separator, or the "more"
/// submenu in its display position.
#[derive(Debug)]
enum MenuEntry {
    Row(MenuRow),
    Separator,
    More {
        title: String,
        children: Vec<MenuRow>,
    },
}

/// Plan the whole tray menu as pure data, in display order: the disabled
/// "recent" header, the recent rows, the optional "more" submenu, then the
/// three fixed actions. Separators split the menu into three zones --
/// sessions, window actions, and the exit -- so the eye can parse the
/// groups without reading every label. The submenu is omitted entirely when
/// there is nothing to hold (Decision 3: an empty submenu renders as a
/// dead-end item on some platforms). Pure so the assembly -- order,
/// omission, disabled header, separators, fixed entries -- is pinnable
/// without an app handle.
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
    let mut entries: Vec<MenuEntry> = Vec::with_capacity(7 + recent.len());
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
    entries.push(MenuEntry::Separator);
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
    entries.push(MenuEntry::Separator);
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
            MenuEntry::Separator => {
                items.push(Box::new(tauri::menu::PredefinedMenuItem::separator(app)?));
            }
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

/// The current tray strings, read through the same config carrier the rest
/// of the backend uses: the provider source's already-resolved locale (the
/// ADR-0052 single dispatch point). A missing state degrades to the English
/// bucket -- the tray must never fail to build over strings.
fn current_texts(app: &AppHandle) -> TrayTexts {
    let locale = app
        .try_state::<LiveProviderConfig>()
        .map(|live| live.locale())
        .unwrap_or(ResponseLocale::EnUS);
    texts_for(locale)
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

/// A session-level tray action in the shape the readiness handshake
/// buffers it (issue #1142): only the two actions with a frontend
/// consequence. OpenMain reveals the window at click time and Quit exits
/// the process -- neither has a webview half, so neither is buffered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PendingSessionAction {
    OpenSession { duck_path: String },
    NewSession,
}

/// Mutable core of [`TrayReadiness`] -- one lock covers both fields so
/// the record / mark_ready / page-load decisions stay atomic against each
/// other.
#[derive(Default)]
struct ReadinessCore {
    ready: bool,
    pending: Option<PendingSessionAction>,
}

/// The tray-ready handshake state (issue #1142) -- the buffering
/// contract is the module doc's handshake paragraph. Deltas: the
/// lost-click symptom is a window that reveals while the session never
/// opens, and LAST-wins treats a rapid double click as one user
/// intent, not a queue.
#[derive(Default)]
// pub (not the module-default pub(crate)) because the pub `tray_ready`
// command's signature references the type; Rust's private-interfaces
// lint forces the wider visibility.
pub struct TrayReadiness(std::sync::Mutex<ReadinessCore>);

impl TrayReadiness {
    /// A session action arrived. `true` = it was buffered (the frontend
    /// is not ready; the caller skips its emit); `false` = the listeners
    /// are live (the caller emits directly). Borrows the action -- only
    /// the buffering branch stores it, so the steady-state click (the
    /// common case) clones nothing here.
    pub(crate) fn record(&self, action: &PendingSessionAction) -> bool {
        let mut core = self.0.lock().expect("tray readiness lock poisoned");
        if core.ready {
            false
        } else {
            core.pending = Some(action.clone());
            true
        }
    }

    /// The frontend finished registering its listeners: mark ready and
    /// hand back the buffered action, if any. Idempotent -- a repeated
    /// `tray_ready` replays nothing.
    pub(crate) fn mark_ready(&self) -> Option<PendingSessionAction> {
        let mut core = self.0.lock().expect("tray readiness lock poisoned");
        core.ready = true;
        core.pending.take()
    }

    /// The webview started (re)loading: its listeners are gone until the
    /// next `tray_ready`, so clicks must buffer again. The pending slot
    /// is retained -- an action that raced the reload still carries the
    /// user's intent, and the freshly loaded page replays it.
    pub(crate) fn page_load_started(&self) {
        self.0.lock().expect("tray readiness lock poisoned").ready = false;
    }
}

/// Emit one session-level tray action on its wire event -- the shared
/// tail of the direct path and the handshake replay.
pub(crate) fn emit_session_action(app: &AppHandle, action: &PendingSessionAction) {
    let result = match action {
        PendingSessionAction::OpenSession { duck_path } => app.emit(
            OPEN_SESSION_EVENT,
            OpenSessionPayload {
                duck_path: duck_path.clone(),
            },
        ),
        PendingSessionAction::NewSession => app.emit(NEW_SESSION_EVENT, ()),
    };
    if let Err(e) = result {
        log::warn!("tray session action emit failed ({action:?}): {e}");
    }
}

/// Route one session-level tray action through the handshake (issue
/// #1142): buffer for replay while the frontend listeners are not up,
/// emit directly once they are. The state is managed in setup before
/// [`init`], so the lookup is a structural invariant -- same crate,
/// same boot -- not a runtime option.
fn dispatch_session_action(app: &AppHandle, action: PendingSessionAction) {
    let buffered = app.state::<TrayReadiness>().record(&action);
    if !buffered {
        emit_session_action(app, &action);
    }
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
        // The tray is recency-only (ADR-0125 Decision 3); the scan's pinned
        // block (ADR-0127) is a sidebar concern, not a tray one.
        let mut metas = metas;
        sort_recency_first(&mut metas);
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
/// opens; the left click stays as a second trigger (it never opens the
/// menu). Caveat: the Linux GTK backend dispatches NO icon events
/// (AppIndicator exposes no click callback), so there the menu carries
/// only the boot-time fill -- no trigger of ours can fire.
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
        .tooltip("TOPTOPDuck")
        .menu(&menu)
        // Tauri v2's default shows the menu on LEFT click too; the resident
        // idiom (ADR-0125 Decision 4) is left = reveal window, right = menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match parse_menu_id(event.id().as_ref()) {
            Some(TrayAction::OpenSession { duck_path }) => {
                show_main(app);
                dispatch_session_action(app, PendingSessionAction::OpenSession { duck_path });
            }
            Some(TrayAction::NewSession) => {
                show_main(app);
                dispatch_session_action(app, PendingSessionAction::NewSession);
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
            // Organization flags are joined by the scan, not the tray -- the
            // tray consumes already-trimmed scan output (ADR-0127).
            pinned: false,
            archived: false,
        }
    }

    fn paths(metas: &[SessionMetadata]) -> Vec<&str> {
        metas.iter().map(|m| m.duck_path.as_str()).collect()
    }

    /// Test-only token for a separator slot in the plan kind assertions.
    const SEP: &str = "--";

    // --- texts_for (whole-table per locale, issue #1144) --------------------

    /// Whole-table equality against independently spelled expectations, not a
    /// single-field spot check: a swapped or mistranslated entry inside either
    /// catalog fails here. Comparing against the `ZH`/`EN` consts themselves
    /// would catch only a branch swap -- both sides would mutate together on
    /// an in-table edit. The plan tests already pin the EN strings
    /// positionally; this adds the ZH table.
    #[test]
    fn texts_for_pins_the_full_table_per_locale() {
        assert_eq!(
            texts_for(ResponseLocale::ZhCN),
            TrayTexts {
                recent_header: "最近会话",
                more: "更多",
                new_session: "新会话",
                open_main: "打开主窗",
                quit: "退出",
                unnamed_session: "未命名会话",
            }
        );
        assert_eq!(
            texts_for(ResponseLocale::EnUS),
            TrayTexts {
                recent_header: "Recent sessions",
                more: "More",
                new_session: "New session",
                open_main: "Open main window",
                quit: "Quit",
                unnamed_session: "Unnamed session",
            }
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

    #[test]
    fn recency_order_puts_mtime_before_the_pinned_block() {
        // ADR-0125 keeps the tray recency-only; the scan (ADR-0127) leads
        // with the pinned block instead, so the rebuild re-sorts before the
        // 3+10 split -- pinned rows must not displace the recent ones.
        let mut metas = vec![
            SessionMetadata {
                last_modified_at: 100,
                pinned: true,
                ..meta("pinned-old.duck", "p")
            },
            SessionMetadata {
                last_modified_at: 900,
                ..meta("fresh.duck", "f")
            },
            SessionMetadata {
                last_modified_at: 500,
                pinned: true,
                ..meta("pinned-mid.duck", "p")
            },
            SessionMetadata {
                last_modified_at: 700,
                ..meta("recent.duck", "r")
            },
        ];
        sort_recency_first(&mut metas);
        assert_eq!(
            paths(&metas),
            vec![
                "fresh.duck",
                "recent.duck",
                "pinned-mid.duck",
                "pinned-old.duck"
            ]
        );
    }

    // --- session_label ------------------------------------------------------

    #[test]
    fn label_falls_back_to_unnamed_for_blank_display_names() {
        let texts = texts_for(ResponseLocale::ZhCN);
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

    // --- TrayReadiness (the tray-ready handshake, issue #1142) ------------

    fn open(path: &str) -> PendingSessionAction {
        PendingSessionAction::OpenSession {
            duck_path: path.into(),
        }
    }

    #[test]
    fn not_ready_clicks_buffer_and_only_the_last_action_replays() {
        let readiness = TrayReadiness::default();
        // Three clicks before the frontend registers its listeners: each
        // reports buffered (the caller skips its emit)...
        assert!(readiness.record(&open("a.duck")));
        assert!(readiness.record(&open("b.duck")));
        assert!(readiness.record(&PendingSessionAction::NewSession));
        // ...and only the LAST action replays -- a rapid double click is
        // one user intent, not a queue.
        assert_eq!(
            readiness.mark_ready(),
            Some(PendingSessionAction::NewSession)
        );
        // A repeated ready (a stale tray_ready call) replays nothing.
        assert_eq!(readiness.mark_ready(), None);
    }

    #[test]
    fn once_ready_clicks_pass_through_untouched() {
        let readiness = TrayReadiness::default();
        readiness.mark_ready();
        // record returning false = not buffered = the caller emits
        // directly (the steady path: zero handshake traffic per click).
        assert!(!readiness.record(&open("a.duck")));
        assert_eq!(readiness.mark_ready(), None);
    }

    #[test]
    fn a_page_load_re_arms_the_buffer() {
        let readiness = TrayReadiness::default();
        readiness.mark_ready();
        // A reload tears the webview's listeners down; Started is the
        // earliest backend-visible signal, so clicks buffer again until
        // the next tray_ready.
        readiness.page_load_started();
        assert!(readiness.record(&open("c.duck")));
        assert_eq!(readiness.mark_ready(), Some(open("c.duck")));
    }

    #[test]
    fn a_page_load_keeps_an_action_that_raced_the_reload() {
        let readiness = TrayReadiness::default();
        assert!(readiness.record(&open("a.duck")));
        // The webview reloaded before the ready landed; the buffered
        // intent survives and the freshly loaded page replays it.
        readiness.page_load_started();
        assert_eq!(readiness.mark_ready(), Some(open("a.duck")));
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
        let plan = plan_menu(&metas, &texts_for(ResponseLocale::EnUS));
        let rows: Vec<(&str, &str, bool)> = plan
            .iter()
            .filter_map(|e| match e {
                MenuEntry::Row(r) => Some((r.id.as_str(), r.text.as_str(), r.enabled)),
                MenuEntry::Separator | MenuEntry::More { .. } => None,
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
        // position (after the recent rows, before the first zone
        // separator), in scan order.
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
        let plan = plan_menu(&metas, &texts_for(ResponseLocale::ZhCN));
        assert!(plan.iter().all(|e| !matches!(e, MenuEntry::More { .. })));
        // With no sessions at all the header + the three fixed actions
        // plus the two zone separators remain, in layout order -- the
        // empty tray still offers new/open/quit, with no doubled
        // separator anywhere.
        let plan = plan_menu(&[], &texts_for(ResponseLocale::ZhCN));
        let kinds: Vec<&str> = plan
            .iter()
            .map(|e| match e {
                MenuEntry::Row(r) => r.id.as_str(),
                MenuEntry::Separator => SEP,
                MenuEntry::More { .. } => ID_MORE,
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                ID_RECENT_HEADER,
                SEP,
                ID_NEW_SESSION,
                ID_OPEN_MAIN,
                SEP,
                ID_QUIT,
            ]
        );
    }

    #[test]
    fn plan_separates_sessions_from_actions_and_quit() {
        // Two separators, three zones: the session block (header + rows +
        // more), the window actions, and the exit on its own.
        let metas: Vec<_> = (0..4).map(|i| meta(&format!("s{i}.duck"), "n")).collect();
        let plan = plan_menu(&metas, &texts_for(ResponseLocale::EnUS));
        let kinds: Vec<&str> = plan
            .iter()
            .map(|e| match e {
                MenuEntry::Row(r) => r.id.as_str(),
                MenuEntry::Separator => SEP,
                MenuEntry::More { .. } => ID_MORE,
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                ID_RECENT_HEADER,
                "tray-open-session::s0.duck",
                "tray-open-session::s1.duck",
                "tray-open-session::s2.duck",
                ID_MORE,
                SEP,
                ID_NEW_SESSION,
                ID_OPEN_MAIN,
                SEP,
                ID_QUIT,
            ]
        );
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
