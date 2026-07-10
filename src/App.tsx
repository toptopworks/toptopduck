import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FormattedMessage, IntlProvider, useIntl } from "react-intl";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { LogicalPosition, LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
import { SessionPane } from "./session/SessionPane";
import { DisclosureBanner } from "./components/DisclosureBanner";
import { SettingsDialog } from "./components/SettingsDialog";
import { createQueryClient } from "./lib/queryClient";
import { catalogFor, coerceLocalePreference, useLocale } from "./i18n";
import { useTheme } from "./theme/useTheme";
import {
  closeSession,
  createSession,
  fmtError,
  getAppConfig,
  getProviderConfig,
  openDuck,
  onResumeProgress,
  recordRecentFile,
  saveAsDuck,
  setAppConfig,
} from "./api";
import type { AppConfig } from "./types";

// The Chat-style three-column shell (ADR-0045/0060/0062). App owns APP-level
// state (session id, app-config, theme, locale, window geometry, save/open,
// settings) and lays out the three columns; each open session renders a
// <SessionPane> (ADR-0051) that owns its working-set / active / thread queries
// + client UI state. Single-session this slice: the sidebar renders the one
// active session (multi-session listing/switching is a later issue).

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
        title={intl.formatMessage({
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

// The leftmost session sidebar (ADR-0060). Chat-style chrome (沉色 background,
// distinct from the work area). Single-session this slice: shows the one active
// session as a selected entry; "+ 新建会话" + the multi-session list land with
// the multi-session issue. Recent .duck files render as clickable entries
// (resume-on-click) so the persistence entry point survives the shell rewrite.
function SessionSidebar({
  sessionName,
  recentFiles,
  disabled,
  onOpenRecent,
}: {
  sessionName: string;
  recentFiles: string[];
  disabled: boolean;
  onOpenRecent: (path: string) => void;
}) {
  return (
    <aside className="session-sidebar" aria-label="会话">
      <h2 className="sidebar-title">会话</h2>
      <ul className="session-list">
        {/* The one active session, highlighted as the current selection. */}
        <li className="session-entry active" aria-current="true">
          <span className="session-name">{sessionName}</span>
        </li>
        {recentFiles.map((p) => {
          const base = p.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? p;
          return (
            <li key={p} className="session-entry recent">
              <button
                type="button"
                className="recent-session"
                title={p}
                disabled={disabled}
                onClick={() => onOpenRecent(p)}
              >
                {base}
              </button>
            </li>
          );
        })}
      </ul>
      <details className="sidebar-disclosure">
        <summary className="muted">隐私披露</summary>
        <DisclosureBanner />
      </details>
    </aside>
  );
}

export default function App() {
  // QueryClient (ADR-0051): lazy-init once per App mount so test renders never
  // share cache.
  const [queryClient] = useState(() => createQueryClient());

  // --- Session lifecycle (ADR-0056) ----------------------------------------
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Bumped after a resume (open .duck) so <SessionPane> remounts and resets its
  // client UI state (viewedResult re-initializes from the resumed thread,
  // ADR-0062 R5). The query cache (keyed by sessionId) survives the remount.
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [sessionName, setSessionName] = useState<string>("新会话");
  const sessionIdRef = useRef<string | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);

  // --- App-level config (ADR-0038) ----------------------------------------
  const [appConfig, setAppConfigState] = useState<AppConfig | null>(null);
  const appConfigRef = useRef<AppConfig | null>(null);
  const geometryRestoredRef = useRef(false);

  // --- App-level UI state --------------------------------------------------
  const [hasKey, setHasKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resumeStatus, setResumeStatus] = useState<string | null>(null);
  const [persistenceBusy, setPersistenceBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ADR-0056: mint the single session id once on mount. Lands before any
  // session-scoped call runs (the gated render waits on sessionId).
  useEffect(() => {
    let cancelled = false;
    let createdId: string | null = null;
    createSession()
      .then((id) => {
        if (cancelled) {
          void closeSession(id);
          return;
        }
        createdId = id;
        sessionIdRef.current = id;
        setSessionId(id);
      })
      .catch((e) => {
        if (cancelled) return;
        setShellError(fmtError(e));
      });
    return () => {
      cancelled = true;
      if (createdId) void closeSession(createdId);
    };
  }, []);

  const refreshKeyStatus = useCallback(async () => {
    try {
      setHasKey((await getProviderConfig()).has_key);
    } catch {
      // keep the previous indicator; the ask path surfaces real failures.
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    // External system -> state: a legitimate one-shot fetch (the persisted
    // config + the key indicator land once after the session opens).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshKeyStatus();
    void getAppConfig()
      .then((cfg) => {
        appConfigRef.current = cfg;
        setAppConfigState(cfg);
      })
      .catch(() => {
        // Keep null; theme defaults to "system", no recent files.
      });
  }, [sessionId, refreshKeyStatus]);

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
            // Geometry persistence is advisory (ADR-0038), so a failure must
            // not block the UI; but appConfigRef was updated optimistically, so
            // a silent swallow leaves memory != disk. Warn in dev so the drift
            // surfaces before a restart quietly reverts the geometry.
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

  const refreshRecentFiles = useCallback(async () => {
    try {
      const cfg = await getAppConfig();
      appConfigRef.current = cfg;
      setAppConfigState(cfg);
    } catch {
      // advisory; leave the stale list.
    }
  }, []);

  // --- Save / Open .duck (ADR-0034/0036) ----------------------------------
  const handleSaveAs = useCallback(async () => {
    setPersistenceBusy(true);
    try {
      const path = await saveDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
      });
      if (!path) return;
      const stem =
        path.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? "session";
      const sid = sessionIdRef.current;
      if (!sid) return;
      await saveAsDuck(sid, path, stem);
      setSessionName(stem);
      void recordRecentFile(path).then(() => void refreshRecentFiles());
    } catch (e) {
      setShellError(fmtError(e));
    } finally {
      setPersistenceBusy(false);
    }
  }, [refreshRecentFiles]);

  const openDuckByPath = useCallback(
    async (path: string) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      // Subscribe BEFORE openDuck so the first Source event is never missed.
      const unlisten = await onResumeProgress(({ event }) => {
        // Single-session shell reads the inner ResumeEvent directly; the
        // multi-session shell (#75) filters on `.session_id` instead.
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
      setResumeStatus("正在打开…");
      try {
        await openDuck(sid, path);
        void recordRecentFile(path).then(() => void refreshRecentFiles());
        const stem =
          path.split(/[\\/]/).pop()?.replace(/\.duck$/i, "") ?? "session";
        setSessionName(stem);
        // Invalidate the session queries so they refetch the resumed state,
        // then bump the epoch so <SessionPane> remounts and resets viewedResult
        // from the resumed thread (ADR-0062 R5).
        await queryClient.invalidateQueries({ queryKey: ["session", sid] });
        setSessionEpoch((e) => e + 1);
        setResumeStatus(null);
      } catch (e) {
        setShellError(fmtError(e));
        setResumeStatus(null);
      } finally {
        void unlisten();
      }
    },
    [queryClient, refreshRecentFiles],
  );

  const handleOpenDuck = useCallback(async () => {
    setPersistenceBusy(true);
    try {
      const selected = await openDialog({
        filters: [{ name: "toptopduck", extensions: ["duck"] }],
        multiple: false,
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      await openDuckByPath(path);
    } catch (e) {
      // openDuckByPath can throw before its inner try (the onResumeProgress
      // subscribe, the invalidate); surface it the same way handleSaveAs does
      // rather than letting it escape as an unhandled rejection.
      setShellError(fmtError(e));
    } finally {
      setPersistenceBusy(false);
    }
  }, [openDuckByPath]);

  const headerDisabled = persistenceBusy || resumeStatus !== null;

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
        {!sessionId ? (
          <main className="shell-init">
            {shellError ? (
              <p>初始化会话失败：{shellError}</p>
            ) : (
              <p>正在初始化会话…</p>
            )}
          </main>
        ) : (
          <div className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
            {/* Col 1: session sidebar (ADR-0060) -- full height, independent
                column (R1: QuestionBar does NOT span over it). */}
            <SessionSidebar
              sessionName={sessionName}
              recentFiles={appConfig?.recent_files ?? []}
              disabled={headerDisabled}
              onOpenRecent={(p) => void openDuckByPath(p)}
            />

            {/* Row 1 (cols 2+): thin top bar (ADR-0060/0062 R1). */}
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
              <span className="topbar-session-name">{sessionName}</span>
              <HeaderActions
                disabled={headerDisabled}
                hasKey={hasKey}
                onOpenDuck={() => void handleOpenDuck()}
                onSaveAs={() => void handleSaveAs()}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </header>

            {/* Resume progress strip (ADR-0034). Absent unless a resume runs. */}
            {resumeStatus && (
              <p className="resume-progress" role="status" aria-live="polite">
                {resumeStatus}
              </p>
            )}

            {/* Row 2 (cols 2+): the session pane host (rail + workspace +
                QuestionBar). key bump on resume forces remount so viewedResult
                re-initializes from the resumed thread (ADR-0062 R5). */}
            <main className="session-pane-host">
              <SessionPane key={`${sessionId}:${sessionEpoch}`} sessionId={sessionId} />
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
        )}
      </IntlProvider>
    </QueryClientProvider>
  );
}
