import { useCallback, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FormattedMessage, IntlProvider, useIntl } from "react-intl";
import { SessionPane } from "./session/SessionPane";
import { SessionSidebar } from "./session/SessionSidebar";
import { useShellError } from "./shell/useShellError";
import { usePersistedSessions } from "./shell/usePersistedSessions";
import { useShellSessions, type ResumeStatus } from "./shell/useShellSessions";
import { useAppConfigState } from "./shell/useAppConfigState";
import { ErrorBanner } from "./components/ErrorBanner";
import { DegradeCard, ErrorBoundary } from "./components/ErrorBoundary";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import { SettingsView } from "./components/settingsView/SettingsView";
import { Alert } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
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
  // ADR-0067 (issue #182): the .header-actions container + .header-actions
  // button + .key-ok / .key-missing visual rules (bespoke border/bg/radius,
  // hardcoded #1a7a3a / #b06000) retired from styles.css. The container rides
  // utility (flex row + density), the three action buttons became shadcn Button
  // outline variants, and the key-state span became a shadcn Badge outline
  // variant with the green/orange status semantic re-anchored on ADR-0050
  // tokens: --primary teal (green family, "configured/active") for key-ok and
  // --warning amber for key-missing. Two clarifications vs the legacy rule:
  // (1) the outline variant rides bg-background (shadcn default), not the
  // legacy var(--card) -- in dark mode this flattens the button into the topbar
  // (also bg-background), aligning with the shadcn outline surface contract
  // instead of the v0 card-raised tint; (2) each Button adds
  // disabled:pointer-events-auto to override the shadcn base's
  // disabled:pointer-events-none, which otherwise suppresses the native title
  // tooltip (saveDisabledTitle / header.openDuck.title / header.saveAs.title)
  // on the disabled open/save buttons -- a native disabled <button> still does
  // not dispatch click, so re-enabling pointer-events is safe. The
  // .header-actions / .key-ok / .key-missing class hooks stay on the elements
  // for selector / test stability.
  return (
    <div className="header-actions flex items-center gap-3 my-2 text-sm">
      <Button
        variant="outline"
        size="sm"
        className="disabled:pointer-events-auto"
        onClick={onOpenDuck}
        disabled={disabled}
        title={intl.formatMessage({
          id: "header.openDuck.title",
          defaultMessage: "Open a .duck to resume a prior analysis",
        })}
      >
        <FormattedMessage id="header.openDuck" defaultMessage="Open .duck" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="disabled:pointer-events-auto"
        onClick={onSaveAs}
        disabled={disabled}
        title={disabled ? saveDisabledTitle : intl.formatMessage({
          id: "header.saveAs.title",
          defaultMessage: "Save the current session as .duck (auto-saves each turn after)",
        })}
      >
        <FormattedMessage id="header.saveAs" defaultMessage="Save as .duck" />
      </Button>
      <Badge
        variant="outline"
        className={hasKey ? "key-ok text-primary" : "key-missing text-warning"}
      >
        {hasKey ? (
          <FormattedMessage id="header.keyOk" defaultMessage="LLM key configured" />
        ) : (
          <FormattedMessage
            id="header.keyMissing"
            defaultMessage="No LLM key configured — asking will fail"
          />
        )}
      </Badge>
      <Button
        variant="outline"
        size="sm"
        className="disabled:pointer-events-auto"
        onClick={onOpenSettings}
        disabled={settingsDisabled}
      >
        <FormattedMessage id="header.settings" defaultMessage="Settings" />
      </Button>
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
      // ADR-0067 (#171): visual rule -> inline utilities; semantic hook kept.
      className="sidebar-toggle py-0.5 px-2 text-base leading-none cursor-pointer border border-border bg-card rounded-md"
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
      // ADR-0067 (#171): visual rule -> inline utilities; disabled dims +
      // drops the pointer (cold-start hero has no rail to collapse).
      className="rail-toggle py-0.5 px-2 text-base leading-none cursor-pointer border border-border bg-card rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
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

// Resume progress status (ADR-0034). ResumeStatus is a structured discriminated
// union produced by useShellSessions (openPersisted's Source/Replay events) --
// not a pre-baked string. App sits above <IntlProvider> and cannot format
// messages itself, so ResumeProgress (a child inside the provider) renders the
// union into the active locale. Each intl.formatMessage id is a STATIC literal
// so @formatjs/cli extract resolves them.
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
  // ADR-0067 (issue #182): the .resume-progress bespoke tint (hardcoded
  // #eef6ff bg + #b6d4ff border + 6px radius + 0.4/0.8 padding) retired from
  // styles.css onto a shadcn Alert default variant -- the "shadcn info surface"
  // per alert-variants.ts (bg-card + border + rounded-lg). The legacy tint was
  // a v0-scaffold Bootstrap-style blue with no matching ADR-0050 token; landing
  // on Alert default retires it onto the same info surface other disclosures
  // use, eliminating the cross-surface drift ADR-0067 Decision 1 targets. The
  // transient info-line weight is preserved (single short status line, polite
  // aria-live + role=status override the Alert's assertive default). The
  // .resume-progress class hook stays on the Alert for selector stability and
  // for the .shell > .resume-progress grid placement (still in styles.css as
  // layout-only, grid-column/grid-row).
  return (
    <Alert
      className="resume-progress my-1.5"
      role="status"
      aria-live="polite"
    >
      {text}
    </Alert>
  );
}

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
  // useAppConfigState owns the AppConfig advisory state + every mutating action
  // (commitAppConfig / switchActiveProfile / the two collapse toggles) + the
  // load + geometry + collapse restore / persist effects + the locale / intl
  // derived from appConfig.locale (ADR-0052). App reads effectiveLocale
  // (IntlProvider + document.lang) + intl (the downstream shell hooks) from the
  // return. commitAppConfig stays optimistic -- state + ref flip before the IPC
  // await; a write failure surfaces the error but does NOT roll back
  // (ADR-0068, mirrors SettingsView Save).
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
  // ADR-0067 (issue #173): the .workspace-hero visual rule (flex column,
  // centered, gap, padding, text-align) retired from styles.css onto utility.
  // .cold-start-hero (positioning overlay) stays in styles.css as a layout-only
  // hook; the workspace-hero hook stays for selector stability.
  // ADR-0067 (issue #182): the .cold-start-title bespoke font-size (1.4rem) +
  // margin retired onto utility (text-[1.4rem] + m-0 mb-2) -- arbitrary value
  // preserves the exact retired size (Tailwind's nearest scale step text-2xl is
  // 1.5rem, a 0.1rem drift from the AC "字号渲染不变"), and the .primary-cta
  // bespoke primary teal styling retired onto a shadcn Button default variant
  // (bg-primary + text-primary-foreground + rounded-md) sized lg for the CTA
  // weight. The disabled progress cursor is preserved via className override
  // (disabled:pointer-events-auto disabled:cursor-progress disabled:opacity-60):
  // disabled:pointer-events-auto re-opens the shadcn base's
  // disabled:pointer-events-none (without it browsers ignore cursor under
  // pointer-events:none and the cursor-progress hint never renders), and
  // disabled:opacity-60 nudges the Button default's disabled:opacity-50 back to
  // 0.6 to match the retired rule. A native disabled <button> still does not
  // dispatch click, so re-enabling pointer-events is safe. The .cold-start-title
  // / .primary-cta class hooks stay on the elements for selector / test stability.
  return (
    <div className="workspace-hero cold-start-hero flex flex-col items-center gap-4 p-8 text-center">
      <h2 className="cold-start-title m-0 mb-2 text-[1.4rem]">
        <FormattedMessage id="coldStart.title" defaultMessage="Start an analysis" />
      </h2>
      <p className="text-muted-foreground">
        <FormattedMessage
          id="coldStart.hint"
          defaultMessage="Click “New session” on the left, or open a saved session to resume. Drop a data file to start a new analysis in one step."
        />
      </p>
      <Button
        size="lg"
        className="primary-cta disabled:pointer-events-auto disabled:cursor-progress disabled:opacity-60"
        disabled={disabled}
        onClick={onNew}
      >
        <FormattedMessage id="coldStart.newSession" defaultMessage="New session" />
      </Button>
    </div>
  );
}
