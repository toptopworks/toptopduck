import { useCallback, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FormattedMessage, IntlProvider } from "react-intl";
import { SessionPane } from "./session/SessionPane";
import { SessionSidebar } from "./session/SessionSidebar";
import { useShellError } from "./shell/useShellError";
import { usePersistedSessions } from "./shell/usePersistedSessions";
import { useShellSessions } from "./shell/useShellSessions";
import { useAppConfigState } from "./shell/useAppConfigState";
import { HeaderActions } from "./shell/HeaderActions";
import { SidebarToggle } from "./shell/SidebarToggle";
import { RailToggle } from "./shell/RailToggle";
import { ResumeProgress } from "./shell/ResumeProgress";
import { ColdStartHero } from "./shell/ColdStartHero";
import { ErrorBanner } from "./components/common/ErrorBanner";
import { DegradeCard, ErrorBoundary } from "./components/common/ErrorBoundary";
import { ProfileSwitcher } from "./components/settings/ProfileSwitcher";
import { SettingsView } from "./components/settings/SettingsView";
import { Alert } from "./components/ui/alert";
import { TooltipProvider } from "./components/ui/tooltip";
import { log } from "./lib/log";
import { createQueryClient } from "./lib/queryClient";
import { catalogFor } from "./i18n";
import { useTheme } from "./theme/useTheme";
import { getProviderConfig } from "./api";

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

export default function App() {
  // QueryClient (ADR-0051): lazy-init once per App mount so test renders never
  // share cache.
  const [queryClient] = useState(() => createQueryClient());

  const { shellError, setShellError } = useShellError();

  // --- App-level UI state --------------------------------------------------
  const [hasKey, setHasKey] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // refreshKeyStatus: reads the active profile's keychain slot (ADR-0029) into
  // hasKey. Fired once on mount by useAppConfigState's load effect, again after
  // a profile switch, and on settings-close (a Save may have changed the slot).
  // Stays in App because hasKey is App-level UI state rendered by HeaderActions;
  // the hook consumes it as a dep.
  const refreshKeyStatus = useCallback(async () => {
    try {
      setHasKey((await getProviderConfig()).has_key);
    } catch {
      // keep the previous indicator; the ask path surfaces real failures.
    }
  }, []);

  // --- App-level config (ADR-0038, issue #196) ----------------------------
  // Delegated to useAppConfigState (see that hook for the ADR-0068/0052
  // contract + restore / persist effects). App injects setShellError
  // (switchActiveProfile reject path) + refreshKeyStatus (mount + post-switch
  // kick + settings-close) as deps; reads back AppConfig state + the derived
  // effectiveLocale / intl + the two collapse toggles. hasKey + settingsOpen
  // are App-local UI state (below).
  const {
    appConfig,
    effectiveLocale,
    intl,
    commitAppConfig,
    switchActiveProfile,
    sidebarCollapsed,
    railCollapsed,
    toggleSidebarCollapse,
    toggleRailCollapse,
  } = useAppConfigState({ setShellError, refreshKeyStatus });

  // --- Session shell (issue #195) -----------------------------------------
  // usePersistedSessions: the disk-derived sidebar list (ADR-0061 cold start;
  // ADR-0068 advisory state -- React useState + sessionsEpoch manual invalidate,
  // NOT TanStack Query). useShellSessions: the runtime OPEN set + active id +
  // every mutating action (open / close / drop / rename / save / delete) + the
  // resume + persistence-busy gates + the single webview drop router (#81).
  // useShellSessions also takes the QueryClient seam (ADR-0051/0055 cache drop
  // on unmount) + refreshSessions (save/delete/rename re-fetch) + setShellError
  // (shell-layer AppError surface, issue #194).
  const { sessions, sessionsError, refreshSessions } = usePersistedSessions({ intl });
  const {
    openSessions,
    activeSessionId,
    activeSession,
    activateSession,
    busy,
    resumeStatus,
    openNew,
    openPersisted,
    clearPendingIngest,
    closeOpen,
    deletePersisted,
    renameEntry,
    handleSaveAs,
    handleOpenDuck,
  } = useShellSessions({ intl, queryClient, refreshSessions, setShellError });

  // ADR-0060 soft cap: a non-blocking badge in the top bar (not the sidebar)
  // signals memory pressure once the open keep-alive set reaches the cap; it
  // never forces a close.
  const atSoftCap = openSessions.length >= SOFT_CAP_OPEN_SESSIONS;

  // Theme (ADR-0050): applied to <html>, follows the persisted three-state
  // preference (defaulting to system before app-config resolves). The Vega
  // bridge listens to the theme-change event this fires. effectiveLocale +
  // intl are resolved inside useAppConfigState (where the owned appConfig
  // lives); the IntlProvider subtree + document.lang consume them here.
  useTheme(appConfig?.theme ?? "system");

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = effectiveLocale;
    }
  }, [effectiveLocale]);

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
                onActivate={activateSession}
                onOpenPersisted={(path, name) => void openPersisted(path, name)}
                onClose={(sid) => void closeOpen(sid)}
                onDelete={(path, sid) => void deletePersisted(path, sid)}
                onRename={(sid, path, newName) => void renameEntry(sid, path, newName)}
              />

              {/* Row 1 (cols 2+): thin top bar (ADR-0060/0062 R1). The session name
              is READ-ONLY (ADR-0060: naming goes through the sidebar menu, the
              single entry point -- DRY). ADR-0067 (#171): visual rules -> inline
              utilities; the .topbar grid + flex layout shell stays in styles.css. */}
              <header className="topbar gap-3 px-4 border-b border-border bg-background">
                <SidebarToggle
                  collapsed={sidebarCollapsed}
                  onToggle={toggleSidebarCollapse}
                />
                <RailToggle
                  collapsed={railCollapsed}
                  disabled={!activeSession}
                  onToggle={toggleRailCollapse}
                />
                <span className="topbar-session-name flex-1 min-w-0 font-semibold text-base truncate">
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

              {/* Resume progress strip (ADR-0034). Absent unless an open/resume
                  runs -- `idle` is the ADT's resting state (issue #205), so the
                  gate discriminates on `kind` instead of truthiness-coercing a
                  nullable. */}
              {resumeStatus.kind !== "idle" && <ResumeProgress status={resumeStatus} />}

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
                <ErrorBanner className="shell-error" error={shellError} />
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
