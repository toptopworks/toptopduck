import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createIntl, FormattedMessage, IntlProvider, useIntl } from "react-intl";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SessionPane } from "./session/SessionPane";
import { SessionSidebar } from "./session/SessionSidebar";
import { ErrorBanner } from "./components/ErrorBanner";
import { DegradeCard, ErrorBoundary } from "./components/ErrorBoundary";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { SettingsView } from "./components/settingsView/SettingsView";
import { Alert } from "./components/ui/alert";
import { TooltipProvider } from "./components/ui/tooltip";
import { log } from "./lib/log";
import { createQueryClient } from "./lib/queryClient";
import { catalogFor, coerceLocalePreference, useLocale } from "./i18n";
import { useTheme } from "./theme/useTheme";
import {
  closeSession,
  closeSessionAndWaitRelease,
  createSession,
  deleteSession,
  describeReject,
  fmtError,
  getAppConfig,
  getProviderConfig,
  listSessions,
  onResumeProgress,
  openDuck,
  recordRecentFile,
  renamePersistedSession,
  renameSession,
  saveAsDuck,
  setAppConfig,
} from "./api";
import type { AppConfig, SessionMetadata } from "./types";
import type { OpenSession } from "./session/sidebarModel";

// The Chat-style three-column shell (ADR-0045/0060/0062, issue #81). App owns
// APP-level state: the OPEN-session set + active id (ADR-0060 multi-session),
// the persisted-session sidebar list (ADR-0061 cold start), app-config, theme,
// locale, window geometry, save/open, settings. Each open session renders a
// <SessionPane> (ADR-0051) that owns its working-set / active / thread queries
// + client UI state. Non-active panes stay mounted under CSS `hidden` keep-alive
// (ADR-0060): switching is instant, no resume replay, no refetch (ADR-0051).
//
// Cold start (ADR-0061): no createSession, no resume, no last_session_id. The
// left sidebar loads list_sessions; the right shows a new-session hero empty
// state until the user clicks a session (resume), drops a file, or hits "+ New session".

/** Soft cap on keep-alive sessions (ADR-0046, non-blocking memory-pressure
 *  badge). Reaching it surfaces a sidebar badge; it never forces a close. */
const SOFT_CAP_OPEN_SESSIONS = 8;

/** Acquire the main window, or null when the Tauri bridge is absent (jsdom
 * tests). Every window-geometry call site is a no-op without it. */
function safeMainWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

// Header action cluster (ADR-0052 i18n). App sits above <IntlProvider> so it
// cannot call useIntl(); this child renders inside the provider. IDs are STATIC
// literals so @formatjs/cli extract can resolve them.
function HeaderActions({
  disabled,
  hasKey,
  onOpenDuck,
  onSaveAs,
  onOpenSettings,
  settingsDisabled,
}: {
  disabled: boolean;
  hasKey: boolean;
  onOpenDuck: () => void;
  onSaveAs: () => void;
  onOpenSettings: () => void;
  // C1: the gear stays disabled until appConfig resolves. Opening settings
  // while appConfig is null white-screens the shell -- .settings-mode hides
  // the session shell but SettingsView does not render (its own appConfig
  // gate) and its window ESC listener never mounts, leaving no exit. The
  // gate mirrors the SettingsView render condition (settingsOpen && appConfig)
  // so the unreachable state is never entered.
  settingsDisabled: boolean;
}) {
  const intl = useIntl();
  const saveDisabledTitle = intl.formatMessage({
    id: "header.saveAs.disabledTitle",
    defaultMessage: "Open or create a session first",
  });
  return (
    <div className="header-actions">
      <button
        onClick={onOpenDuck}
        disabled={disabled}
        title={intl.formatMessage({
          id: "header.openDuck.title",
          defaultMessage: "Open a .duck to resume a prior analysis",
        })}
      >
        <FormattedMessage id="header.openDuck" defaultMessage="Open .duck" />
      </button>
      <button
        onClick={onSaveAs}
        disabled={disabled}
        title={disabled ? saveDisabledTitle : intl.formatMessage({
          id: "header.saveAs.title",
          defaultMessage: "Save the current session as .duck (auto-saves each turn after)",
        })}
      >
        <FormattedMessage id="header.saveAs" defaultMessage="Save as .duck" />
      </button>
      <span className={hasKey ? "key-ok" : "key-missing"}>
        {hasKey ? (
          <FormattedMessage id="header.keyOk" defaultMessage="LLM key configured" />
        ) : (
          <FormattedMessage
            id="header.keyMissing"
            defaultMessage="No LLM key configured — asking will fail"
          />
        )}
      </span>
      <button onClick={onOpenSettings} disabled={settingsDisabled}>
        <FormattedMessage id="header.settings" defaultMessage="Settings" />
      </button>
    </div>
  );
}

// Sidebar collapse toggle (ADR-0052 i18n). App sits above <IntlProvider> so the
// button lives in this child component to reach intl. Each
// intl.formatMessage branch is a STATIC literal so @formatjs/cli extract
// resolves both ids (a template id would break the i18n:check CI gate).
function SidebarToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  return (
    <button
      type="button"
      className="sidebar-toggle"
      aria-label={
        collapsed
          ? intl.formatMessage({ id: "sidebar.expand", defaultMessage: "Expand session bar" })
          : intl.formatMessage({ id: "sidebar.collapse", defaultMessage: "Collapse session bar" })
      }
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? "»" : "«"}
    </button>
  );
}

// Thread-rail collapse toggle (ADR-0054 level 2, issue #84). Mirrors
// SidebarToggle: the button lives in this child so it can reach intl (App sits
// above <IntlProvider>). Each intl.formatMessage branch is a STATIC literal so
// @formatjs/cli extract resolves both ids. Disabled when no session is active:
// the rail only exists inside a SessionPane, so on the cold-start hero the
// toggle has no visible target (the persisted pref still applies once a session
// opens). The single-angle glyph ‹› distinguishes it from the sidebar's «».
function RailToggle({
  collapsed,
  disabled,
  onToggle,
}: {
  collapsed: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  return (
    <button
      type="button"
      className="rail-toggle"
      disabled={disabled}
      aria-label={
        collapsed
          ? intl.formatMessage({ id: "rail.expand", defaultMessage: "Expand conversation rail" })
          : intl.formatMessage({ id: "rail.collapse", defaultMessage: "Collapse conversation rail" })
      }
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      {collapsed ? "›" : "‹"}
    </button>
  );
}

// Resume progress status (ADR-0034). A structured discriminated union, not a
// pre-baked string: App sits above <IntlProvider> and cannot format messages
// itself, so ResumeProgress (a child inside the provider) renders the union
// into the active locale. Each intl.formatMessage id is a STATIC literal so
// @formatjs/cli extract resolves them.
type ResumeStatus =
  | { kind: "opening" }
  | { kind: "source"; index: number; total: number; name: string }
  | { kind: "replay"; index: number; total: number; name: string };

function ResumeProgress({ status }: { status: ResumeStatus }) {
  const intl = useIntl();
  const text = (() => {
    switch (status.kind) {
      case "opening":
        return intl.formatMessage({ id: "resume.opening", defaultMessage: "Opening…" });
      case "source":
        return intl.formatMessage(
          { id: "resume.source", defaultMessage: "Verifying source {index}/{total}: {name}" },
          { index: status.index, total: status.total, name: status.name },
        );
      case "replay":
        return intl.formatMessage(
          { id: "resume.replay", defaultMessage: "Replaying {index}/{total}: {name}" },
          { index: status.index, total: status.total, name: status.name },
        );
    }
  })();
  return (
    <p className="resume-progress" role="status" aria-live="polite">
      {text}
    </p>
  );
}

export default function App() {
  // QueryClient (ADR-0051): lazy-init once per App mount so test renders never
  // share cache.
  const [queryClient] = useState(() => createQueryClient());

  // --- Multi-session shell (ADR-0060/0051) --------------------------------
  // openSessions: every session with a live in-memory instance, each rendered
  // as a keep-alive SessionPane. activeSessionId: the visible one (null = cold
  // hero). A close drops the entry + removeQueries its cache (ADR-0055).
  const [openSessions, setOpenSessions] = useState<OpenSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Bumped to re-fetch list_sessions after a save/delete/rename (the persisted
  // sidebar list is advisory state held in React, not TanStack Query, mirroring
  // how app-config is fetched).
  const [sessionsEpoch, setSessionsEpoch] = useState(0);
  const [sessions, setSessions] = useState<SessionMetadata[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  // Shell-level IPC reject (issue #119): the locale message plus the Engine
  // technical detail, so the shell surfaces the collapsed fold the same way the
  // session pane does -- a close-wait timeout/conflict reject carries an
  // actionable "retry shortly" hint in the detail that must not vanish here.
  const [shellError, setShellError] = useState<
    { message: string; detail: string | null } | null
  >(null);
  // Resume / open-busy indicator (ADR-0034). Resume blocks the open action; the
  // indicator shows globally while the clicked session is opening.
  const [resumeStatus, setResumeStatus] = useState<ResumeStatus | null>(null);
  const [persistenceBusy, setPersistenceBusy] = useState(false);

  // --- App-level config (ADR-0038) ----------------------------------------
  const [appConfig, setAppConfigState] = useState<AppConfig | null>(null);
  const appConfigRef = useRef<AppConfig | null>(null);
  const geometryRestoredRef = useRef(false);

  // Locale (ADR-0052): resolved once from the persisted three-state preference
  // (defaulting to system before app-config resolves). App sits ABOVE the
  // <IntlProvider> rendered below for the subtree, so useIntl() is unavailable
  // here -- a standalone IntlShape is built from the same catalog so fmtError
  // can localize SessionError rejects at the shell layer (issue #119).
  const effectiveLocale = useLocale(coerceLocalePreference(appConfig?.locale));
  const intl = useMemo(
    () => createIntl({ locale: effectiveLocale, messages: catalogFor(effectiveLocale) }),
    [effectiveLocale],
  );

  // --- App-level UI state --------------------------------------------------
  const [hasKey, setHasKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // ADR-0054 shell collapse (issue #84): two independent manual levels --
  // session sidebar (full hide + topbar call-out) and thread rail (workspace
  // goes full-width). Both default expanded; both restore from app-config once
  // on the first resolve (ADR-0038) and persist on every toggle.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const collapseRestoredRef = useRef(false);

  const busy = persistenceBusy || resumeStatus !== null;
  const activeSession =
    openSessions.find((s) => s.sid === activeSessionId) ?? null;
  // ADR-0060 soft cap: a non-blocking badge in the top bar (not the sidebar)
  // signals memory pressure once the open keep-alive set reaches the cap; it
  // never forces a close.
  const atSoftCap = openSessions.length >= SOFT_CAP_OPEN_SESSIONS;

  // ADR-0061 cold start: load list_sessions on mount (and after a save/delete/
  // rename bumps sessionsEpoch). NOT createSession -- zero instances until the
  // user acts.
  useEffect(() => {
    let cancelled = false;
    listSessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        setSessionsError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setSessionsError(fmtError(e, intl));
      });
    return () => {
      cancelled = true;
    };
  }, [intl, sessionsEpoch]);

  const refreshSessions = useCallback(() => setSessionsEpoch((e) => e + 1), []);

  const refreshKeyStatus = useCallback(async () => {
    try {
      setHasKey((await getProviderConfig()).has_key);
    } catch {
      // keep the previous indicator; the ask path surfaces real failures.
    }
  }, []);

  // Load app-config once on mount (theme/locale/recent files/geometry).
  useEffect(() => {
    let cancelled = false;
    // External system -> state: a legitimate one-shot fetch (provider config +
    // app-config land once on mount). refreshKeyStatus setState-in-effect is
    // intentional here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshKeyStatus();
    void getAppConfig()
      .then((cfg) => {
        if (cancelled) return;
        appConfigRef.current = cfg;
        setAppConfigState(cfg);
      })
      .catch(() => {
        // Keep null; theme defaults to "system".
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKeyStatus]);

  const commitAppConfig = useCallback(async (cfg: AppConfig): Promise<void> => {
    appConfigRef.current = cfg;
    setAppConfigState(cfg);
    await setAppConfig(cfg);
  }, []);

  // Switch the active profile from the top-bar quick switcher (issue #154,
  // ADR-0065). There is no separate set-active IPC: active_profile lives in
  // app-config (ADR-0038/0064), so the switch is one commitAppConfig write of
  // provider.active_profile -- the SAME persistence layer the settings Save
  // uses (#153 SettingsView.save -> onCommitAppConfig). The CONTRACT differs
  // from #153: settings stages the change in a draft and commits on Save
  // (batched with theme/locale/engine), while the top-bar switcher commits
  // IMMEDIATELY (a one-profile swap, no draft) so the next ask picks it up.
  // live_config reads active_profile fresh each turn (ADR-0064 -- the
  // ProviderConfigSource impl does a disk read per call, no caching), so the
  // next ask uses the new profile's endpoint + keychain slot. The active
  // profile changed -> refresh the header key indicator (hasKey reflects the
  // NEW active profile's keychain slot, ADR-0029 boolean). commitAppConfig is
  // optimistic (state flips before the IPC awaits); a write failure surfaces
  // the error but does NOT roll back, mirroring SettingsView Save --
  // live_config still reads disk truth, so a failed write leaves the next ask
  // on the OLD profile.
  const switchActiveProfile = useCallback(
    async (id: string): Promise<void> => {
      if (!appConfig) return;
      if (id === appConfig.provider.active_profile) return;
      try {
        await commitAppConfig({
          ...appConfig,
          provider: { ...appConfig.provider, active_profile: id },
        });
        void refreshKeyStatus();
      } catch (e) {
        setShellError(describeReject(e, intl));
      }
    },
    [appConfig, commitAppConfig, refreshKeyStatus, intl],
  );

  // Commit the two shell collapse prefs as one app-config write (ADR-0038/0054,
  // issue #84). No-op before app-config resolves (appConfigRef null) -- the
  // restore effect's one-shot then applies the persisted value on first load.
  const commitShellPrefs = useCallback(
    (next: { sidebar: boolean; rail: boolean }): void => {
      const base = appConfigRef.current;
      if (!base) return;
      void commitAppConfig({
        ...base,
        shell: { sidebar_collapsed: next.sidebar, rail_collapsed: next.rail },
      }).catch((e) => {
        // IPC write failed -- the UI already flipped optimistically (state is
        // set before the commit), so the only consequence is the pref not
        // surviving a restart. Mirror the geometry persist handler: log to
        // devtools, not a user toast (the toggle's visible effect landed).
        log.warn("shell", "collapse persist failed", e);
      });
    },
    [commitAppConfig],
  );

  const toggleSidebarCollapse = useCallback(() => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    commitShellPrefs({ sidebar: next, rail: railCollapsed });
  }, [sidebarCollapsed, railCollapsed, commitShellPrefs]);

  const toggleRailCollapse = useCallback(() => {
    const next = !railCollapsed;
    setRailCollapsed(next);
    commitShellPrefs({ sidebar: sidebarCollapsed, rail: next });
  }, [sidebarCollapsed, railCollapsed, commitShellPrefs]);

  // Theme (ADR-0050): applied to <html>, follows the persisted three-state
  // preference (defaulting to system before app-config resolves). The Vega
  // bridge listens to the theme-change event this fires. effectiveLocale is
  // resolved earlier (where the shell's IntlShape is built, above).
  useTheme(appConfig?.theme ?? "system");

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = effectiveLocale;
    }
  }, [effectiveLocale]);

  // Restore window geometry ONCE on the first app-config load (ADR-0038).
  useEffect(() => {
    if (!appConfig || geometryRestoredRef.current) return;
    const win = safeMainWindow();
    if (!win) return;
    geometryRestoredRef.current = true;
    const { width, height, x, y, maximized } = appConfig.window;
    if (maximized) {
      void win.maximize().catch(() => {});
    } else {
      void win
        .setSize(new LogicalSize(width, height))
        .then(async () => {
          if (x !== null && y !== null) {
            await win.setPosition(new LogicalPosition(x, y)).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, [appConfig]);

  // Restore shell collapse prefs ONCE on the first app-config load (ADR-0038 /
  // 0054, issue #84). Mirrors geometryRestoredRef: a one-shot so a later
  // app-config write (e.g. a toggle's own commit) does not re-clobber the
  // user's in-session state with the persisted value.
  useEffect(() => {
    if (!appConfig || collapseRestoredRef.current) return;
    collapseRestoredRef.current = true;
    setSidebarCollapsed(appConfig.shell.sidebar_collapsed);
    setRailCollapsed(appConfig.shell.rail_collapsed);
  }, [appConfig]);

  // Persist window geometry on resize/move, debounced (ADR-0038).
  useEffect(() => {
    const win = safeMainWindow();
    if (!win) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      Promise.all([win.innerSize(), win.outerPosition(), win.isMaximized()])
        .then(([size, pos, maximized]) => {
          const base = appConfigRef.current;
          if (!base) return;
          void commitAppConfig({
            ...base,
            window: {
              width: size.width,
              height: size.height,
              x: pos.x,
              y: pos.y,
              maximized,
            },
          }).catch((e) => {
            log.warn("geometry", "persist failed", e);
          });
        })
        .catch(() => {});
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 500);
    };
    const unresizedP = win.onResized(schedule).catch(() => () => {});
    const unmovedP = win.onMoved(schedule).catch(() => () => {});
    return () => {
      if (timer) clearTimeout(timer);
      void unresizedP.then((un) => un()).catch(() => {});
      void unmovedP.then((un) => un()).catch(() => {});
    };
  }, [commitAppConfig]);

  // --- Multi-session actions ----------------------------------------------

  /** Add a freshly-minted session to the open set and activate it. The caller
   *  hands the createSession result + an optional bound path/name (resume). */
  const registerOpen = useCallback((entry: OpenSession) => {
    setOpenSessions((prev) =>
      prev.some((s) => s.sid === entry.sid) ? prev : [...prev, entry],
    );
    setActiveSessionId(entry.sid);
  }, []);

  // "+ New session" (ADR-0061): mint an empty session and enter its empty state.
  const openNew = useCallback(async () => {
    try {
      const sid = await createSession();
      // name starts empty; the display layer renders a localized "New session"
      // placeholder until the user saves-as or renames (data, not chrome).
      registerOpen({ sid, name: "", path: null, pendingIngestPath: null });
    } catch (e) {
      setShellError(describeReject(e, intl));
    }
  }, [intl, registerOpen]);

  // Drop-to-create on the cold-start hero (ADR-0061, #81 A1): mint a session
  // and hand the dropped path to the new SessionPane as pendingIngestPath. The
  // pane consumes it via handleIngest (the only path that can surface an xlsx
  // NeedsGuidance dialog); the shell never ingests directly. droppingRef guards
  // a second drop landing while the first createSession is still in flight.
  const droppingRef = useRef(false);
  const dropFile = useCallback(
    async (path: string) => {
      if (droppingRef.current) return;
      droppingRef.current = true;
      try {
        const sid = await createSession();
        registerOpen({ sid, name: "", path: null, pendingIngestPath: path });
      } catch (e) {
        setShellError(describeReject(e, intl));
      } finally {
        droppingRef.current = false;
      }
    },
    [intl, registerOpen],
  );

  // Single webview-level drop router (#81): Tauri's onDragDropEvent is a
  // window-level signal with no hit-test, so exactly one listener (here, in the
  // shell) routes each drop -- cold start mints a new session, otherwise the
  // file lands on the ACTIVE session's ingest via the pendingIngestPath pipe
  // (#81 A1). This replaces the per-SessionPane FileDropzone listeners, which
  // stacked 1:1 with keep-alive panes and fired N ingests per single drop.
  const onWebviewDrop = useCallback(
    (path: string) => {
      if (activeSessionId === null) {
        void dropFile(path);
        return;
      }
      setOpenSessions((prev) =>
        prev.map((o) =>
          o.sid === activeSessionId ? { ...o, pendingIngestPath: path } : o,
        ),
      );
    },
    [activeSessionId, dropFile],
  );
  useEffect(() => {
    if (busy) return;
    const app = getCurrentWebviewWindow();
    const unlisten = app.onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        onWebviewDrop(event.payload.paths[0]);
      }
    });
    return () => {
      void unlisten.then((u) => u());
    };
  }, [busy, onWebviewDrop]);

  // Clear a consumed drop-on-cold-start path (#81 A1): once the SessionPane has
  // kicked off ingest, OpenSession.pendingIngestPath is dropped so a remount
  // cannot re-ingest.
  const clearPendingIngest = useCallback((sid: string) => {
    setOpenSessions((prev) =>
      prev.map((o) => (o.sid === sid ? { ...o, pendingIngestPath: null } : o)),
    );
  }, []);

  // Resume a persisted .duck into a fresh runtime instance (ADR-0061/0034).
  // open_duck reuses the id (ADR-0056), so createSession mints it first, then
  // openDuck loads the recipe + replays the chain into that id. If the same
  // path is already open, just switch to it (no second instance, keep-alive).
  const openPersisted = useCallback(
    async (path: string, name: string) => {
      const existing = openSessions.find((s) => s.path === path);
      if (existing) {
        setActiveSessionId(existing.sid);
        return;
      }
      setResumeStatus({ kind: "opening" });
      // ADR-0056 / issue #76: resume-progress is a global Tauri broadcast keyed
      // by session_id. The listener registers BEFORE createSession mints the id,
      // so targetSid starts null and is assigned the instant the id lands; every
      // event is then filtered to the session THIS resume opened. An event for a
      // different session (a concurrent resume path, or a stray broadcast) is
      // dropped before it can move our status indicator. #83 R5: this filter is
      // the multi-session seam -- without it a sibling resume's Source/Replay
      // ticks would hijack this opener's progress strip.
      let targetSid: string | null = null;
      const unlisten = await onResumeProgress((ev) => {
        if (ev.session_id !== targetSid) return;
        const { event } = ev;
        if ("Source" in event) {
          setResumeStatus({
            kind: "source",
            index: event.Source.index,
            total: event.Source.total,
            name: event.Source.reference_name,
          });
        } else if ("Replay" in event) {
          setResumeStatus({
            kind: "replay",
            index: event.Replay.index,
            total: event.Replay.total,
            name: event.Replay.reference_name,
          });
        }
      });
      try {
        const sid = await createSession();
        targetSid = sid;
        await openDuck(sid, path);
        await queryClient.invalidateQueries({ queryKey: ["session", sid] });
        registerOpen({ sid, name, path, pendingIngestPath: null });
        setResumeStatus(null);
      } catch (e) {
        setShellError(describeReject(e, intl));
        setResumeStatus(null);
      } finally {
        void unlisten();
      }
    },
    [intl, openSessions, queryClient, registerOpen],
  );

  // Synchronous UI teardown for an open session: drop the cache + open-set
  // entry + active id. Shared by closeOpen (ADR-0055, runs BEFORE the
  // background close fires) and deletePersisted (ADR-0063, runs AFTER the
  // wait-release variant resolves). The active-id decision runs as a SEPARATE
  // setState -- calling it inside a state updater violates React's purity
  // contract (updaters may double-fire in StrictMode / concurrent mode,
  // enqueueing the nested setter twice); `next` is computed inside the updater
  // (the source of truth for the latest prev) and read out after.
  const unmountOpen = useCallback(
    (sid: string): void => {
      queryClient.removeQueries({ queryKey: ["session", sid] });
      let next: OpenSession[] = [];
      setOpenSessions((prev) => {
        next = prev.filter((s) => s.sid !== sid);
        return next;
      });
      setActiveSessionId((cur) => (cur === sid ? next[0]?.sid ?? null : cur));
    },
    [queryClient],
  );

  // Close an open session (ADR-0055/0060). The user's view must disappear with
  // ZERO wait even when a turn is in-flight: unmount the pane SYNCHRONOUSLY,
  // THEN fire closeSession in the background. closeSession (cancel + mark
  // closing + drop the handle) returns immediately on the backend too -- it
  // does NOT wait for an in-flight ask; the ask's post-turn check sees closing
  // and discards (no thread append, no recipe entry). The orphan ask promise
  // resolves against an absent cache (TanStack setQueryData on a removed key
  // is a no-op) and the turn-progress listener cleanup runs in the pane's
  // unmount effect. The .duck stays on disk and remains in the sidebar
  // (re-openable). NOT delete -- the delete path uses the wait-release variant
  // (see deletePersisted), not this fire-and-forget close.
  const closeOpen = useCallback(
    (sid: string): Promise<void> => {
      unmountOpen(sid);
      // ADR-0055: the UI is already gone; cancel + mark closing only reaches
      // backend bookkeeping. The promise is RETURNED, not awaited here --
      // fire-cancel-don't-wait. Best-effort: NotFound is the expected idempotent
      // path (already dropped); other failures log to devtools so IPC/panic
      // stay observable. NOT a user toast -- pane is gone.
      return closeSession(sid).catch((e) => {
        log.warn("closeSession", "background close failed", fmtError(e, intl));
      });
    },
    [intl, unmountOpen],
  );

  // Delete a persisted .duck (ADR-0060/0063, irreversible). If the session is
  // open, close it via the WAIT-RELEASE variant: the UI pane STAYS mounted
  // during the wait (delete is an explicit user intent -- it does NOT get
  // close's zero-wait contract, ADR-0063 Decision 2), and only unmounts after
  // the canonical single-writer key is released. This guarantees deleteSession's
  // try_acquire gate sees the key free (no misleading "请先关闭" on an entry the
  // user is already deleting). On wait timeout the entry survives so the user
  // can retry. persistenceBusy gates the UI for the potentially long wait.
  const deletePersisted = useCallback(
    async (path: string, sid: string | null) => {
      setPersistenceBusy(true);
      try {
        if (sid) {
          try {
            await closeSessionAndWaitRelease(sid);
          } catch (e) {
            // Close-wait failed (timeout, or the backend already detached
            // the session). Unmount the pane so the entry falls back to the
            // cold sidebar (sid=null); a retry then takes the pure
            // deleteSession(path) path -- if the canonical key is now free
            // the gate succeeds, otherwise the user sees the real gate error.
            // Without this, the pane stays mounted on a sid the backend no
            // longer knows and every retry hits NotFound (dead loop).
            unmountOpen(sid);
            setShellError(describeReject(e, intl));
            return;
          }
          // The wait resolved -- canonical key is free, Session::Drop ran.
          // NOW unmount the pane (ADR-0063: UI teardown after the wait, not
          // before).
          unmountOpen(sid);
        }
        try {
          await deleteSession(path);
        } catch (e) {
          setShellError(describeReject(e, intl));
          return;
        }
        refreshSessions();
      } finally {
        setPersistenceBusy(false);
      }
    },
    [intl, unmountOpen, refreshSessions],
  );

  // Rename a sidebar entry (ADR-0060, single entry point). An OPEN session
  // renames in-memory + re-persists via its sid; a CLOSED .duck rewrites the
  // recipe header in place by path. The bound path is untouched either way.
  const renameEntry = useCallback(
    async (sid: string | null, path: string | null, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) return;
      try {
        if (sid) {
          const landed = await renameSession(sid, trimmed);
          setOpenSessions((prev) =>
            prev.map((s) => (s.sid === sid ? { ...s, name: landed } : s)),
          );
        } else if (path) {
          await renamePersistedSession(path, trimmed);
        }
      } catch (e) {
        setShellError(describeReject(e, intl));
        return;
      }
      refreshSessions();
    },
    [intl, refreshSessions],
  );

  // --- Save / Open .duck (ADR-0034/0036) ----------------------------------
  const handleSaveAs = useCallback(async () => {
    if (!activeSession) return;
    setPersistenceBusy(true);
    try {
      const path = await saveDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
      });
      if (!path) return;
      const stem =
        path.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? "session";
      await saveAsDuck(activeSession.sid, path, stem);
      // Bind the path + name on the open entry; the sidebar list refreshes.
      setOpenSessions((prev) =>
        prev.map((s) =>
          s.sid === activeSession.sid ? { ...s, path, name: stem } : s,
        ),
      );
      void recordRecentFile(path).then(() => void refreshSessions());
    } catch (e) {
      setShellError(describeReject(e, intl));
    } finally {
      setPersistenceBusy(false);
    }
  }, [intl, activeSession, refreshSessions]);

  const handleOpenDuck = useCallback(async () => {
    setPersistenceBusy(true);
    try {
      const selected = await openDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
        multiple: false,
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      const stem =
        path.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? "session";
      await openPersisted(path, stem);
      void recordRecentFile(path).then(() => void refreshSessions());
    } catch (e) {
      setShellError(describeReject(e, intl));
    } finally {
      setPersistenceBusy(false);
    }
  }, [intl, openPersisted, refreshSessions]);

  return (
    <QueryClientProvider client={queryClient}>
      {/* TooltipProvider (ADR-0050/0054, issue #106): one ancestor high in the
          tree so every tail-ellipsis card truncation site (Thread rail cards)
          can mount a Radix Tooltip without per-site providers. delayDuration 0
          matches the shadcn copy-in default; the truncation hover is a deliberate
          read, so an instant open is the right feel. */}
      <TooltipProvider>
        <IntlProvider
          locale={effectiveLocale}
          messages={catalogFor(effectiveLocale)}
          defaultLocale="en-US"
          onError={(err) => {
            log.warn("i18n", err.message);
          }}
        >
          {/* ADR-0058 L3 top-level fallback: the last line of defense against a
            shell-level render throw. Every session is already isolated by its
            own L2 session-body boundary (in SessionPane), so this boundary
            fires only for a chrome-level crash the partitions did not catch.
            Retry removes the whole cache (drop, not invalidate -- a remounted
            pane would otherwise re-render the stale throwing data via stale-
            then-refetch, same rationale as the L2 partition) and remounts the
            shell; the extra Reload exit reloads the window (a Tauri desktop SPA
            has no URL bar to refresh, ADR-0058 Context). */}
          <ErrorBoundary
            name="shell"
            onReset={() => {
              void queryClient.removeQueries();
            }}
            fallback={(error, retry) => (
              <DegradeCard
                error={error}
                onRetry={retry}
                name="shell"
                onReload={() => {
                  if (typeof window !== "undefined") window.location.reload();
                }}
              />
            )}
          >
            <div
              className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${railCollapsed ? " rail-collapsed" : ""}${settingsOpen ? " settings-mode" : ""}`}
            >
              {/* Col 1: session sidebar (ADR-0060) -- full height, independent
              column (R1: QuestionBar does NOT span over it). */}
              <SessionSidebar
                sessions={sessions}
                openSessions={openSessions}
                activeSessionId={activeSessionId}
                disabled={busy}
                loadError={sessionsError}
                onNew={() => void openNew()}
                onActivate={(sid) => setActiveSessionId(sid)}
                onOpenPersisted={(path, name) => void openPersisted(path, name)}
                onClose={(sid) => void closeOpen(sid)}
                onDelete={(path, sid) => void deletePersisted(path, sid)}
                onRename={(sid, path, newName) => void renameEntry(sid, path, newName)}
              />

              {/* Row 1 (cols 2+): thin top bar (ADR-0060/0062 R1). The session name
              is READ-ONLY (ADR-0060: naming goes through the sidebar menu, the
              single entry point -- DRY). */}
              <header className="topbar">
                <SidebarToggle
                  collapsed={sidebarCollapsed}
                  onToggle={toggleSidebarCollapse}
                />
                <RailToggle
                  collapsed={railCollapsed}
                  disabled={!activeSession}
                  onToggle={toggleRailCollapse}
                />
                <span className="topbar-session-name">
                  {activeSession?.name ? (
                    activeSession.name
                  ) : (
                    <FormattedMessage id="session.defaultName" defaultMessage="New session" />
                  )}
                </span>
                {appConfig && (
                  // Active-profile quick switcher (issue #154, ADR-0065). Sits
                  // next to the session name as the other "current context"
                  // indicator: which profile the next ask will use. Commits the
                  // new active_profile immediately (no draft -- the settings
                  // view's stage + Save is the management path); management
                  // stays behind the gear. .settings-mode CSS hides the whole
                  // topbar (this included) when settings are open, so no
                  // settings-open guard here.
                  <ProfileSwitcher
                    provider={appConfig.provider}
                    onSwitchActive={(id) => void switchActiveProfile(id)}
                    disableSwitch={busy}
                  />
                )}
                {atSoftCap && (
                  // Session-count soft-cap hint (ADR-0046): too many open
                  // sessions risk memory pressure. A warning Alert (ADR-0050,
                  // issue #108) -- role="status" is polite, matching the
                  // stale/viz-degradation warnings in ResultView. The topbar is
                  // a compact flex row, so className shrinks the Alert's default
                  // w-full block chrome to an inline chip (cn tailwind-merge
                  // reshapes the base, cf. DisclosureBanner's AlertDescription
                  // override); the variant still supplies the --warning token so
                  // this recolors with .dark like every other warning surface.
                  <Alert
                    variant="warning"
                    role="status"
                    className="w-auto inline-flex items-center gap-1.5 px-2 py-0.5 text-xs"
                  >
                    <FormattedMessage
                      id="header.softCap"
                      defaultMessage="Many sessions open — close some to free memory."
                    />
                  </Alert>
                )}
                <HeaderActions
                  disabled={busy || !activeSession}
                  hasKey={hasKey}
                  onOpenDuck={() => void handleOpenDuck()}
                  onSaveAs={() => void handleSaveAs()}
                  onOpenSettings={() => setSettingsOpen(true)}
                  settingsDisabled={!appConfig}
                />
              </header>

              {/* Resume progress strip (ADR-0034). Absent unless an open/resume runs. */}
              {resumeStatus && <ResumeProgress status={resumeStatus} />}

              {/* Row 3 (cols 2+): the session pane host. Every open session renders
              a keep-alive SessionPane; non-active panes are CSS `hidden` (mounted
              but not laid out) so switching is instant + refetch-free (ADR-0051).
              No active session = the cold-start hero (ADR-0061). */}
              <main className="session-pane-host">
                {activeSessionId === null && (
                  <ColdStartHero disabled={busy} onNew={() => void openNew()} />
                )}
                {openSessions.map((s) => (
                  <div
                    key={s.sid}
                    className={`session-pane-layer${s.sid === activeSessionId ? " active" : " hidden"}`}
                    aria-hidden={s.sid !== activeSessionId}
                  >
                    {/* ADR-0058 L2 session partition: per-session isolation. A
                    render crash inside this SessionPane that the Thread /
                    ResultView granular boundaries (inside SessionPane) do not
                    catch degrades only THIS session's pane -- sibling panes
                    stay alive. The key bump remounts the whole pane; onReset
                    drops its cache so the remount re-fetches fresh. */}
                    <ErrorBoundary
                      name="session"
                      onReset={() => {
                        void queryClient.removeQueries({ queryKey: ["session", s.sid] });
                      }}
                    >
                      <SessionPane
                        key={s.sid}
                        sessionId={s.sid}
                        pendingIngestPath={s.pendingIngestPath}
                        onIngestConsumed={() => clearPendingIngest(s.sid)}
                      />
                    </ErrorBoundary>
                  </div>
                ))}
              </main>

              {shellError && (
                <ErrorBanner
                  className="shell-error"
                  message={shellError.message}
                  detail={shellError.detail}
                />
              )}

              {settingsOpen && appConfig && (
                <SettingsView
                  appConfig={appConfig}
                  onCommitAppConfig={(cfg) => void commitAppConfig(cfg)}
                  onClose={() => {
                    setSettingsOpen(false);
                    void refreshKeyStatus();
                  }}
                />
              )}
            </div>
          </ErrorBoundary>
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

// Cold-start / all-closed hero (ADR-0061). The right side when no session is
// active: a "new session" call-to-action. The privacy disclosure lives in
// SettingsView's Privacy pane (ADR-0066) -- the hero no longer duplicates it.
// This is the shell-level empty state before any DuckDB instance exists (zero
// memory until the user acts). A freshly-created unsaved session shows its own
// hero inside its SessionPane.
function ColdStartHero({
  disabled,
  onNew,
}: {
  disabled: boolean;
  onNew: () => void;
}) {
  // Drop-to-create (ADR-0061, #81 A1) is now routed by the single shell-level
  // webview drop listener in App, which treats activeSessionId === null as the
  // cold-start case. This component is pure UI.
  return (
    <div className="workspace-hero cold-start-hero">
      <h2 className="cold-start-title">
        <FormattedMessage id="coldStart.title" defaultMessage="Start an analysis" />
      </h2>
      <p className="muted">
        <FormattedMessage
          id="coldStart.hint"
          defaultMessage="Click “New session” on the left, or open a saved session to resume. Drop a data file to start a new analysis in one step."
        />
      </p>
      <button
        type="button"
        className="primary-cta"
        disabled={disabled}
        onClick={onNew}
      >
        <FormattedMessage id="coldStart.newSession" defaultMessage="New session" />
      </button>
    </div>
  );
}
