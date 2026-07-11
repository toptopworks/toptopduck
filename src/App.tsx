import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FormattedMessage, IntlProvider, useIntl } from "react-intl";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { SessionPane } from "./session/SessionPane";
import { SessionSidebar } from "./session/SessionSidebar";
import { DisclosureBanner } from "./components/DisclosureBanner";
import { SettingsDialog } from "./components/SettingsDialog";
import { createQueryClient } from "./lib/queryClient";
import { catalogFor, coerceLocalePreference, useLocale } from "./i18n";
import { useTheme } from "./theme/useTheme";
import {
  closeSession,
  createSession,
  deleteSession,
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
}: {
  disabled: boolean;
  hasKey: boolean;
  onOpenDuck: () => void;
  onSaveAs: () => void;
  onOpenSettings: () => void;
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
      <button onClick={onOpenSettings}>
        <FormattedMessage id="header.settings" defaultMessage="Settings" />
      </button>
    </div>
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
  const [shellError, setShellError] = useState<string | null>(null);
  // Resume / open-busy indicator (ADR-0034). Resume blocks the open action; the
  // indicator shows globally while the clicked session is opening.
  const [resumeStatus, setResumeStatus] = useState<string | null>(null);
  const [persistenceBusy, setPersistenceBusy] = useState(false);

  // --- App-level config (ADR-0038) ----------------------------------------
  const [appConfig, setAppConfigState] = useState<AppConfig | null>(null);
  const appConfigRef = useRef<AppConfig | null>(null);
  const geometryRestoredRef = useRef(false);

  // --- App-level UI state --------------------------------------------------
  const [hasKey, setHasKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const busy = persistenceBusy || resumeStatus !== null;
  const activeSession =
    openSessions.find((s) => s.sid === activeSessionId) ?? null;

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
        setSessionsError(fmtError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionsEpoch]);

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

  // Theme (ADR-0050) + locale (ADR-0052): applied to <html>, follow the
  // persisted three-state preference (defaulting to system before app-config
  // resolves). The Vega bridge listens to the theme-change event these fire.
  useTheme(appConfig?.theme ?? "system");
  const effectiveLocale = useLocale(coerceLocalePreference(appConfig?.locale));

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
            if (import.meta.env.DEV) console.warn("[geometry] persist failed", e);
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
      registerOpen({ sid, name: "", path: null, epoch: 0 });
    } catch (e) {
      setShellError(fmtError(e));
    }
  }, [registerOpen]);

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
      setResumeStatus("正在打开…");
      const unlisten = await onResumeProgress(({ event }) => {
        if ("Source" in event) {
          setResumeStatus(
            `校验源 ${event.Source.index}/${event.Source.total}：${event.Source.reference_name}`,
          );
        } else if ("Replay" in event) {
          setResumeStatus(
            `重放 ${event.Replay.index}/${event.Replay.total}：${event.Replay.reference_name}`,
          );
        }
      });
      try {
        const sid = await createSession();
        await openDuck(sid, path);
        await queryClient.invalidateQueries({ queryKey: ["session", sid] });
        registerOpen({ sid, name, path, epoch: 0 });
        setResumeStatus(null);
      } catch (e) {
        setShellError(fmtError(e));
        setResumeStatus(null);
      } finally {
        void unlisten();
      }
    },
    [openSessions, queryClient, registerOpen],
  );

  // Close an open session (ADR-0055/0060): fire cancel + mark closing + drop
  // the instance (closeSession), removeQueries its whole cache, drop it from
  // the open set, and pick a new active if it was current. The .duck stays on
  // disk and remains in the sidebar (re-openable). NOT delete.
  const closeOpen = useCallback(
    async (sid: string) => {
      try {
        await closeSession(sid);
      } catch {
        // The instance may already be gone; proceed to drop the cache + entry.
      }
      queryClient.removeQueries({ queryKey: ["session", sid] });
      setOpenSessions((prev) => {
        const next = prev.filter((s) => s.sid !== sid);
        setActiveSessionId((cur) => (cur === sid ? next[0]?.sid ?? null : cur));
        return next;
      });
    },
    [queryClient],
  );

  // Delete a persisted .duck (ADR-0060, irreversible). Close first if it is
  // open (drops the instance + cache), then remove the file + drop from
  // recent_files. After delete, fall back to the cold hero if it was active.
  const deletePersisted = useCallback(
    async (path: string, sid: string | null) => {
      if (sid) await closeOpen(sid);
      try {
        await deleteSession(path);
      } catch (e) {
        setShellError(fmtError(e));
        return;
      }
      refreshSessions();
    },
    [closeOpen, refreshSessions],
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
        setShellError(fmtError(e));
        return;
      }
      refreshSessions();
    },
    [refreshSessions],
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
      setShellError(fmtError(e));
    } finally {
      setPersistenceBusy(false);
    }
  }, [activeSession, refreshSessions]);

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
      setShellError(fmtError(e));
    } finally {
      setPersistenceBusy(false);
    }
  }, [openPersisted, refreshSessions]);

  return (
    <QueryClientProvider client={queryClient}>
      <IntlProvider
        locale={effectiveLocale}
        messages={catalogFor(effectiveLocale)}
        defaultLocale="en-US"
        onError={(err) => {
          if (import.meta.env.DEV) console.warn("[i18n]", err.message);
        }}
      >
        <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
          {/* Col 1: session sidebar (ADR-0060) -- full height, independent
              column (R1: QuestionBar does NOT span over it). */}
          <SessionSidebar
            sessions={sessions}
            openSessions={openSessions}
            activeSessionId={activeSessionId}
            softCap={SOFT_CAP_OPEN_SESSIONS}
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
            <button
              type="button"
              className="sidebar-toggle"
              aria-label={sidebarCollapsed ? "展开会话栏" : "收起会话栏"}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((c) => !c)}
            >
              {sidebarCollapsed ? "»" : "«"}
            </button>
            <span className="topbar-session-name">
              {activeSession?.name ? (
                activeSession.name
              ) : (
                <FormattedMessage id="session.defaultName" defaultMessage="New session" />
              )}
            </span>
            <HeaderActions
              disabled={busy || !activeSession}
              hasKey={hasKey}
              onOpenDuck={() => void handleOpenDuck()}
              onSaveAs={() => void handleSaveAs()}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </header>

          {/* Resume progress strip (ADR-0034). Absent unless an open/resume runs. */}
          {resumeStatus && (
            <p className="resume-progress" role="status" aria-live="polite">
              {resumeStatus}
            </p>
          )}

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
                <SessionPane key={`${s.sid}:${s.epoch}`} sessionId={s.sid} />
              </div>
            ))}
          </main>

          {shellError && (
            <p className="error shell-error" role="alert">
              {shellError}
            </p>
          )}

          {settingsOpen && appConfig && (
            <SettingsDialog
              appConfig={appConfig}
              onCommitAppConfig={(cfg) => void commitAppConfig(cfg)}
              onClose={() => {
                setSettingsOpen(false);
                void refreshKeyStatus();
              }}
            />
          )}
        </div>
      </IntlProvider>
    </QueryClientProvider>
  );
}

// Cold-start / all-closed hero (ADR-0061). The right side when no session is
// active: a "new session" call-to-action + a privacy disclosure. This is the
// shell-level empty state before any DuckDB instance exists (zero memory until
// the user acts). A freshly-created unsaved session shows its own hero inside
// its SessionPane.
function ColdStartHero({
  disabled,
  onNew,
}: {
  disabled: boolean;
  onNew: () => void;
}) {
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
      <details className="sidebar-disclosure">
        <summary className="muted">
          <FormattedMessage id="coldStart.privacy" defaultMessage="Privacy disclosure" />
        </summary>
        <DisclosureBanner />
      </details>
    </div>
  );
}
