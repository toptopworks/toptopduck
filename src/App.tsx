import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FormattedMessage, IntlProvider } from "react-intl";
import { SessionPane } from "./session/SessionPane";
import { SessionSearchDialog } from "./session/SessionSearchDialog";
import { SessionSidebar } from "./session/SessionSidebar";
import { useShellError } from "./shell/useShellError";
import { usePersistedSessions } from "./shell/usePersistedSessions";
import { useShellSessions } from "./shell/useShellSessions";
import { useAppConfigState } from "./shell/useAppConfigState";
import { usePlatform } from "./shell/use-platform";
import { HeaderActions } from "./shell/HeaderActions";
import { type KeyStatus } from "./shell/ConnectionStatus";
import { SidebarToggle } from "./shell/SidebarToggle";
import { WindowControls } from "./shell/WindowControls";
import { ResumeProgress } from "./shell/ResumeProgress";
import { ColdStartHero } from "./shell/ColdStartHero";
import { ErrorBanner } from "./components/common/ErrorBanner";
import { DegradeCard, ErrorBoundary } from "./components/common/ErrorBoundary";
import { SettingsView } from "./components/settings/SettingsView";
import type { SettingsSection } from "./components/settings/sections";
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
// locale, save/open, settings. Each open session renders a
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

/** Entry hint for the settings overlay (issue #239): which section to land on
 *  when it opens, and (for the Profiles section) which profile to pre-select
 *  for editing. Consumed by SettingsView/ProfilesSection at mount; reset to
 *  the default on close so a later sidebar-gear open does not re-target a
 *  stale profile. */
type SettingsEntry = { section: SettingsSection; editProfileId?: string };

export default function App() {
  // QueryClient (ADR-0051): lazy-init once per App mount so test renders never
  // share cache.
  const [queryClient] = useState(() => createQueryClient());

  const { shellError, setShellError } = useShellError();

  // Platform dispatch (ADR-0074, issue #263): macOS traffic-light window
  // controls render at the topbar's LEFT edge (before SidebarToggle); Windows
  // and Linux keep the right-side cluster at the topbar's tail. usePlatform()
  // is module-cached, so this is a cheap synchronous read in render.
  const platform = usePlatform();

  // --- App-level UI state --------------------------------------------------
  // Active-profile key status (issue #275): the connection row's source (the
  // shared ConnectionStatus footer the sidebar + the settings rail both
  // render, issue #282). has_key is authoritative when keychain_fault is null;
  // a non-null fault means the OS keychain read failed and the row renders
  // "keychain unavailable" instead of misreading as "no key configured".
  const [keyStatus, setKeyStatus] = useState<KeyStatus>({
    has_key: false,
    keychain_fault: null,
  });
  // settingsView (ADR-0065): the in-app settings overlay state. `open` gates
  // the render + the .settings-mode CSS class; `section` + `editProfileId` are
  // one-shot ENTRY hints consumed at mount (issue #239: the ColdStartHero CTAs
  // land on the Profiles tab, optionally with the active profile pre-selected
  // for key editing). openSettings() defaults to the sidebar-gear path
  // (general, no edit target); the hero + the sidebar connection row pass
  // { section: "profiles", editProfileId? }.
  const [settingsView, setSettingsView] = useState<{ open: boolean } & SettingsEntry>({
    open: false,
    section: "general",
  });
  function openSettings(entry: SettingsEntry = { section: "general" }) {
    setSettingsView({ open: true, ...entry });
  }

  // ColdStartHero CTAs (issue #239): open Settings on the Profiles tab. The
  // "no key" path forwards the active profile id so ProfilesSection lands on
  // its edit form; the "no profile" path omits it (there is nothing to edit).
  function openSettingsProfiles(editProfileId?: string) {
    openSettings(
      editProfileId ? { section: "profiles", editProfileId } : { section: "profiles" },
    );
  }
  // Invalidation counter for the composer picker's per-profile has_key overlay
  // (issue #238). Bumped on settings-close so the picker refetches its overlay
  // after a Save that may have changed a keychain slot -- ADR-0019 honest gate:
  // the popover must not keep showing "No key" after the user just configured
  // one. The connection row refreshes via refreshKeyStatus on the same close;
  // this counter does the same for the picker's own overlay (which has its own
  // profileKeys snapshot, separate from keyStatus).
  const [profileKeyEpoch, setProfileKeyEpoch] = useState(0);

  // Ctrl/⌘+K session-search modal open state (ADR-0072, issue #252).
  // The shell owns the single open state so the global keydown + the sidebar's
  // search button (#250) route to the same dialog. Toggled false by the dialog
  // itself on choose / ESC / overlay-click via onOpenChange.
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  // refreshKeyStatus: reads the active profile's keychain slot (ADR-0029) into
  // keyStatus. Fired once on mount by useAppConfigState's load effect, again
  // after a profile switch, and on settings-close (a Save may have changed the
  // slot). Stays in App because keyStatus is App-level UI state consumed by
  // both connection rows (sidebar + settings rail, issue #282); the hook
  // consumes refreshKeyStatus as a dep.
  const refreshKeyStatus = useCallback(async () => {
    try {
      const view = await getProviderConfig();
      setKeyStatus({ has_key: view.has_key, keychain_fault: view.keychain_fault });
    } catch {
      // keep the previous indicator; the ask path surfaces real failures.
    }
  }, []);

  // --- App-level config (ADR-0038, issue #196) ----------------------------
  // Delegated to useAppConfigState (see that hook for the ADR-0068/0052
  // contract + restore / persist effects). App injects setShellError
  // (switchActiveProfile reject path) + refreshKeyStatus (mount + post-switch
  // kick + settings-close) as deps; reads back AppConfig state + the derived
  // effectiveLocale / intl + the two collapse toggles. keyStatus + settingsView
  // are App-local UI state (below).
  const {
    appConfig,
    effectiveLocale,
    intl,
    commitAppConfig,
    switchActiveProfile,
    switchActiveProfileModel,
    sidebarCollapsed,
    railCollapsed,
    toggleSidebarCollapse,
    toggleRailCollapse,
    sidebarGrouping,
    switchSidebarGrouping,
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

  // Global Ctrl/⌘+K keydown -> toggle the search modal (ADR-0072,
  // issue #252). The listener binds once on mount; a ref carries the latest
  // busy gate so a busy shell blocks the toggle without re-binding on every busy
  // change (same shape as SettingsView's Escape listener). preventDefault stops
  // the browser's native ⌘K page-searcher intercept so the modal is the only
  // consumer. metaKey covers macOS (⌘), ctrlKey covers Win/Linux (Ctrl).
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        if (!busyRef.current) setSearchOpen((cur) => !cur);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
              className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${railCollapsed ? " rail-collapsed" : ""}${settingsView.open ? " settings-mode" : ""}`}
            >
              {/* Col 1: session sidebar (ADR-0060) -- full height, independent
              column (R1: QuestionBar does NOT span over it). */}
              <SessionSidebar
                sessions={sessions}
                openSessions={openSessions}
                activeSessionId={activeSessionId}
                disabled={busy}
                loadError={sessionsError}
                grouping={sidebarGrouping}
                onNew={() => void openNew()}
                onActivate={activateSession}
                onOpenPersisted={(path, name) => void openPersisted(path, name)}
                onClose={(sid) => void closeOpen(sid)}
                onDelete={(path, sid) => void deletePersisted(path, sid)}
                onRename={(sid, path, newName) => void renameEntry(sid, path, newName)}
                onSwitchGrouping={switchSidebarGrouping}
                onOpenSearch={openSearch}
                provider={appConfig?.provider ?? null}
                keyStatus={keyStatus}
                onOpenSettings={() => openSettings()}
                onOpenSettingsProfiles={() => openSettingsProfiles()}
              />

              {/* Row 1: thin top bar (ADR-0060/0062 R1), spans the full shell
              width as a custom titlebar (decorations: false). Shell-wide
              controls only: the sidebar collapse toggle (left) + header actions
              + window controls (right). The session name + rail collapse toggle
              moved into each SessionPane's own header (session-scoped chrome
              lives with the session). ADR-0067 (#171): visual rules -> inline
              utilities; the .topbar grid + flex layout shell stays in styles.css.
              Settings mode (ADR-0075 overlay) unmounts the WORKSPACE children
              (sidebar toggle / soft-cap / header actions) but the titlebar
              itself persists: with decorations:false its window controls +
              drag region are shell-wide chrome that must stay reachable in
              every view (ADR-0074) -- the settings-mode CSS exempts .topbar
              from the overlay hide, and the rail owns settings chrome (the
              dual-state gear + connection row live at the left columns'
              bottoms, issue #282 -- the topbar carries no settings entry). */}
              <header className="topbar gap-3 px-4 border-b border-border bg-background" data-tauri-drag-region>
                {platform === "macos" && <WindowControls />}
                {!settingsView.open && (
                  <SidebarToggle
                    collapsed={sidebarCollapsed}
                    onToggle={toggleSidebarCollapse}
                  />
                )}
                <div className="flex-1" data-tauri-drag-region />
                {!settingsView.open && (
                  <>
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
                      onOpenDuck={() => void handleOpenDuck()}
                      onSaveAs={() => void handleSaveAs()}
                    />
                  </>
                )}
                {platform !== "macos" && <WindowControls />}
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
                  <ColdStartHero
                    disabled={busy}
                    provider={appConfig?.provider ?? null}
                    profileKeyEpoch={profileKeyEpoch}
                    onNew={() => void openNew()}
                    onOpenSettingsProfiles={openSettingsProfiles}
                  />
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
                        railCollapsed={railCollapsed}
                        onToggleRail={toggleRailCollapse}
                        sessionName={s.name}
                        providerPicker={
                          // ADR-0071 (issue #238): the composer provider/model
                          // picker is app-level state (active profile + writes +
                          // the settings-open path) rendered at each session's
                          // QuestionBar edge. Absent until app-config resolves;
                          // the picker renders only in the visible pane but is
                          // mounted per keep-alive session like QuestionBar.
                          appConfig
                            ? {
                                provider: appConfig.provider,
                                onSwitchActive: (id) => void switchActiveProfile(id),
                                onSwitchModel: (model) =>
                                  void switchActiveProfileModel(model),
                                onOpenSettings: () => openSettings(),
                                profileKeyEpoch,
                              }
                            : undefined
                        }
                      />
                    </ErrorBoundary>
                  </div>
                ))}
              </main>

              {shellError && (
                <ErrorBanner className="shell-error" error={shellError} />
              )}

              {settingsView.open && appConfig && (
                <SettingsView
                  appConfig={appConfig}
                  initialSection={settingsView.section}
                  initialEditProfileId={settingsView.editProfileId}
                  // Returns the IPC promise (unwrapped) so per-control commits
                  // inside SettingsView can await + catch failures and revert
                  // (ADR-0075). commitAppConfig itself stays optimistic /
                  // no-rollback (ADR-0068); the revert is the view's compensating
                  // write on a caught reject.
                  onCommitAppConfig={(cfg) => commitAppConfig(cfg)}
                  onRefreshKeyStatus={() => void refreshKeyStatus()}
                  keyStatus={keyStatus}
                  onClose={() => {
                    setSettingsView({ open: false, section: "general" });
                    void refreshKeyStatus();
                    // A Settings Save may have changed a keychain slot; bump
                    // the epoch so each keep-alive picker + the ColdStartHero
                    // refetch their overlays (ADR-0019 honest gate, issue #238;
                    // issue #239 extends the epoch to the hero).
                    setProfileKeyEpoch((n) => n + 1);
                  }}
                />
              )}

              {/* Ctrl/⌘+K session-search modal (ADR-0072, issue
                  #252). Rendered unconditionally (Radix mounts the content
                  lazily on open); shares the shell-owned searchOpen state with
                  the global keydown + the sidebar search button. Reuses the
                  sessions / openSessions / activate handlers already in App --
                  zero new IPC, zero new persistence (ADR-0072 slice scope). */}
              <SessionSearchDialog
                open={searchOpen}
                onOpenChange={setSearchOpen}
                sessions={sessions}
                openSessions={openSessions}
                activeSessionId={activeSessionId}
                onActivate={activateSession}
                onOpenPersisted={(path, name) => void openPersisted(path, name)}
              />
            </div>
          </ErrorBoundary>
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
