import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { FormattedMessage, IntlProvider } from "react-intl";
import { SessionPane } from "./session/SessionPane";
import { SessionSearchDialog } from "./session/SessionSearchDialog";
import { SessionSidebar } from "./session/SessionSidebar";
import { useApprovalEvents } from "./session/useApprovalEvents";
import { useShellError } from "./shell/useShellError";
import { usePersistedSessions } from "./shell/usePersistedSessions";
import { useShellSessions } from "./shell/useShellSessions";
import { useAppConfigState } from "./shell/useAppConfigState";
import { useSidebarResize } from "./shell/useSidebarResize";
import { useRailResize } from "./shell/useRailResize";
import { useComposerState } from "./session/useComposerState";
import type { ComposerSessionFields } from "./session/useComposerState";
import { QuestionBar } from "./components/thread/QuestionBar";
import { ComposerAuthModeChip } from "./components/thread/ComposerAuthModeChip";
import { ComposerContextPanel } from "./components/thread/ComposerContextPanel";
import { ComposerSkillsTrigger } from "./components/thread/ComposerSkillsTrigger";
import { ComposerMcpTrigger } from "./components/thread/ComposerMcpTrigger";
import {
  ComposerProviderPicker,
  type ComposerProviderPickerProps,
} from "./components/thread/ComposerProviderPicker";
import type { AppConfig } from "./types/app-config";
import { usePlatform } from "./shell/use-platform";
import { SidebarToggle } from "./shell/SidebarToggle";
import { NavButtons } from "./shell/NavButtons";
import { NavigationHistoryProvider } from "./shell/NavigationHistoryContext";
import type { NavEntry } from "./shell/navigationHistory";
import { WindowControls } from "./shell/WindowControls";
import { ResumeProgress } from "./shell/ResumeProgress";
import { ErrorBanner } from "./components/common/ErrorBanner";
import { DegradeCard, ErrorBoundary } from "./components/common/ErrorBoundary";
import { SettingsView } from "./components/settings/SettingsView";
import type { SettingsSection } from "./components/settings/sections";
import type { RuntimeTab } from "./components/settings/RuntimeSection";
import { Alert } from "./components/ui/alert";
import { TooltipProvider } from "./components/ui/tooltip";
import { log } from "./lib/log";
import { createQueryClient } from "./lib/queryClient";
import { catalogFor } from "./i18n";
import { useTheme } from "./theme/useTheme";
import { adapterKeys } from "./session/queryKeys";

// The Chat-style three-column shell (ADR-0045/0060/0062, issue #81). App owns
// APP-level state: the OPEN-session set + active id (ADR-0060 multi-session),
// the persisted-session sidebar list (ADR-0061 cold start), app-config, theme,
// locale, save/open, settings. Each open session renders a
// <SessionPane> (ADR-0051) that owns its working-set / active / thread queries
// + client UI state. Non-active panes stay mounted under CSS `hidden` keep-alive
// (ADR-0060): switching is instant, no resume replay, no refetch (ADR-0051).
//
// ADR-0092: QuestionBar is a shell-level single instance. Cold start
// (activeSessionId === null) shows a centered bar + greeting; first submit
// creates the session. The sidebar "+" navigates to the centered empty state
// (does not create). SessionPane no longer renders QuestionBar; it reports its
// bar-relevant fields upward via onComposerFields.

/** Soft cap on keep-alive sessions (ADR-0046, non-blocking memory-pressure
 *  badge). Reaching it surfaces a sidebar badge; it never forces a close. */
const SOFT_CAP_OPEN_SESSIONS = 8;

/** Entry hint for the settings overlay (issue #239): which section to land on
 *  when it opens, and (for the Runtime section) which profile to pre-select
 *  for editing and which sub-tab to land on (issue #490). Consumed by
 *  SettingsView/ProfilesSection/RuntimeSection at mount; reset to the default
 *  on close so a later sidebar-gear open does not re-target stale hints. */
type SettingsEntry = {
  section: SettingsSection;
  editProfileId?: string;
  runtimeTab?: RuntimeTab;
};

// Module-level so the IntlProvider `onError` prop is a STABLE reference across
// App renders. react-intl shallow-compares ALL provider props (incl. onError)
// to decide whether to rebuild the `intl` context object; an inline arrow here
// would rebuild `intl` every render, and every session handler that lists
// `intl` in its useCallback deps (handleAsk / handleCancel / handleIngestMany)
// would get a fresh identity -- which the ADR-0092 shell-level composer-fields
// report compares by reference, looping the bar's fields registry forever.
function handleIntlError(err: Error): void {
  log.warn("i18n", err.message);
}

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
  // settingsView (ADR-0065): the in-app settings overlay state. `open` gates
  // the render + the .settings-mode CSS class; `editProfileId` is a one-shot
  // ENTRY hint consumed by ProfilesSection at mount (issue #239); `runtimeTab`
  // is a one-shot ENTRY hint consumed by RuntimeSection at mount (issue #490).
  const [settingsView, setSettingsView] = useState<{
    open: boolean;
    editProfileId?: string;
    runtimeTab?: RuntimeTab;
  }>({
    open: false,
  });
  const [liveSettingsSection, setLiveSettingsSection] = useState<SettingsSection>("general");
  const [settingsNavCollapsed, setSettingsNavCollapsed] = useState(false);
  function openSettings(entry: SettingsEntry = { section: "general" }) {
    setSettingsView({
      open: true,
      editProfileId: entry.editProfileId,
      runtimeTab: entry.runtimeTab,
    });
    setLiveSettingsSection(entry.section);
    setSettingsNavCollapsed(false);
  }

  const [profileKeyEpoch, setProfileKeyEpoch] = useState(0);

  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  // --- App-level config (ADR-0038, issue #196) ----------------------------
  const {
    appConfig,
    effectiveLocale,
    intl,
    commitAppConfig,
    replaceAppConfig,
    switchActiveProfile,
    switchActiveProfileModel,
    sidebarCollapsed,
    toggleSidebarCollapse,
    sidebarGrouping,
    switchSidebarGrouping,
  } = useAppConfigState({ setShellError });

  // --- Draggable sidebar + rail widths ------------------------------------
  const { width: railWidth, isDragging: railDragging, onResizeStart: onRailResizeStart, adjustWidth: adjustRailWidth } = useRailResize();

  const { width: sidebarWidth, isDragging: sidebarDragging, onResizeStart: onSidebarResizeStart } = useSidebarResize({
    onDelta: (delta) => adjustRailWidth(-delta),
  });

  // --- Session shell (issue #195) -----------------------------------------
  const { sessions, sessionsError, refreshSessions } = usePersistedSessions({ intl });
  const {
    openSessions,
    activeSessionId,
    activateSession,
    goToEmptyState,
    busy,
    resumeStatus,
    createSessionWithQuestion,
    openPersisted,
    clearPendingIngest,
    clearPendingQuestion,
    closeOpen,
    deletePersisted,
    renameEntry,
    handleOpenDuck,
    handleExportSession,
    syncSessionName,
  } = useShellSessions({ intl, queryClient, refreshSessions, setShellError });

  const handleSessionsDirChanged = useCallback(
    (cfg: AppConfig) => {
      replaceAppConfig(cfg);
      refreshSessions();
    },
    [replaceAppConfig, refreshSessions],
  );

  const approvalEvents = useApprovalEvents();

  const atSoftCap = openSessions.length >= SOFT_CAP_OPEN_SESSIONS;

  // --- ADR-0092: Shell-level composer fields registry ---------------------
  // Each SessionPane reports its bar-relevant fields upward via
  // onComposerFields. The shell-level QuestionBar reads the active session's
  // entry (or idle defaults when activeSessionId is null). handleAsk /
  // handleCancel / handleIngestFiles are useCallback-stable inside
  // useSessionState; loading / phase change during a turn.
  const [composerFieldsMap, setComposerFieldsMap] = useState<
    Record<string, ComposerSessionFields>
  >({});
  const handleComposerFields = useCallback(
    (sid: string, fields: ComposerSessionFields) => {
      setComposerFieldsMap((prev) => {
        // Skip if nothing changed (referential equality of all fields).
        const prevFields = prev[sid];
        if (
          prevFields &&
          prevFields.loading === fields.loading &&
          prevFields.phase === fields.phase &&
          prevFields.handleAsk === fields.handleAsk &&
          prevFields.handleCancel === fields.handleCancel &&
          prevFields.handleIngestFiles === fields.handleIngestFiles
        ) {
          return prev;
        }
        return { ...prev, [sid]: fields };
      });
    },
    [],
  );

  // The active session's bar fields (or idle when null). The useComposerState
  // hook merges these with per-session drafts.
  const activeSessionFields =
    activeSessionId !== null ? composerFieldsMap[activeSessionId] : undefined;
  const composer = useComposerState(
    activeSessionId,
    activeSessionFields ?? {
      loading: false,
      phase: null,
      handleAsk: async () => {},
      handleCancel: async () => {},
      handleIngestFiles: () => {},
    },
  );

  // ADR-0092: shell-level bar submit handler. When activeSessionId is null,
  // create a session carrying the question as pendingQuestion. When non-null,
  // delegate to the active session's handleAsk. The draft is cleared on submit
  // for both paths.
  // Extract setDraft so the submit callback's dep array is stable (the
  // composer object is rebuilt every render; setDraft is useCallback-stable
  // inside useComposerState).
  const composerSetDraft = composer.setDraft;
  const handleShellSubmit = useCallback(
    (question: string) => {
      // Clear the draft after submit (standard chat-composer UX).
      composerSetDraft("");
      if (activeSessionId !== null) {
        const fields = composerFieldsMap[activeSessionId];
        if (fields) {
          void fields.handleAsk(question);
          return;
        }
      }
      // Cold start: create session + carry the question.
      void createSessionWithQuestion(question);
    },
    [activeSessionId, composerFieldsMap, createSessionWithQuestion, composerSetDraft],
  );

  // ADR-0092: shell-level cancel — delegates to the active session's
  // handleCancel. Idle when no session is active (no turn to cancel).
  const handleShellCancel = useCallback(() => {
    if (activeSessionId !== null) {
      const fields = composerFieldsMap[activeSessionId];
      if (fields) void fields.handleCancel();
    }
  }, [activeSessionId, composerFieldsMap]);

  // ADR-0092: shell-level file ingest. When active, delegate to the session's
  // handleIngestMany. When cold start, create a session via the drop-to-create
  // flow (single file; multi-file cold-start is a follow-up).
  const handleShellIngestFiles = useCallback(
    (paths: string[]) => {
      if (activeSessionId !== null) {
        const fields = composerFieldsMap[activeSessionId];
        if (fields) {
          fields.handleIngestFiles(paths);
          return;
        }
      }
      log.warn("App", "handleIngestFiles on cold start — not yet supported via picker");
    },
    [activeSessionId, composerFieldsMap],
  );

  // --- In-app navigation history (issue #288) -----------------------------
  const location = useMemo<NavEntry>(
    () => ({
      sessionId: activeSessionId,
      settings: { open: settingsView.open, section: liveSettingsSection },
    }),
    [activeSessionId, settingsView.open, liveSettingsSection],
  );
  const restore = useCallback(
    (entry: NavEntry): boolean => {
      let moved = false;
      if (entry.settings.open !== settingsView.open) {
        setSettingsView((prev) => ({ ...prev, open: entry.settings.open }));
        moved = true;
      }
      if (entry.settings.section !== liveSettingsSection) {
        setLiveSettingsSection(entry.settings.section);
        moved = true;
      }
      if (entry.sessionId !== null && entry.sessionId !== activeSessionId) {
        activateSession(entry.sessionId);
        moved = true;
      }
      return moved;
    },
    [settingsView.open, liveSettingsSection, activeSessionId, activateSession],
  );

  // Global Ctrl/⌘+K keydown -> toggle the search modal (ADR-0072,
  // issue #252).
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

  // Theme (ADR-0050): applied to <html>.
  useTheme(appConfig?.theme ?? "system");

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = effectiveLocale;
    }
  }, [effectiveLocale]);

  // The provider picker bundle for the shell-level bar (ADR-0071/0092).
  // Same shape as before — shell-owned state rendered at the bar's trailing
  // slot.
  const providerPicker = appConfig
    ? {
        provider: appConfig.provider,
        onSwitchActive: (id: string) => void switchActiveProfile(id),
        onSwitchModel: (model: string) => void switchActiveProfileModel(model),
        onOpenSettings: (tab: RuntimeTab) =>
          openSettings({ section: "runtime", runtimeTab: tab }),
        profileKeyEpoch,
      }
    : undefined;

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <IntlProvider
          locale={effectiveLocale}
          messages={catalogFor(effectiveLocale)}
          defaultLocale="en-US"
          onError={handleIntlError}
        >
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
            <NavigationHistoryProvider location={location} restore={restore}>
              <div
                className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarDragging ? " sidebar-dragging" : ""}${railDragging ? " rail-dragging" : ""}${settingsView.open ? " settings-mode" : ""}${settingsNavCollapsed ? " settings-nav-collapsed" : ""}${activeSessionId === null ? " cold-start-mode" : ""}`}
                style={{ "--sidebar-width": `${sidebarWidth}px`, "--rail-width": `${railWidth}px` } as CSSProperties}
              >
                {/* Col 1: session sidebar (ADR-0060) */}
                <SessionSidebar
                  collapsed={sidebarCollapsed}
                  sessions={sessions}
                  openSessions={openSessions}
                  activeSessionId={activeSessionId}
                  disabled={busy}
                  loadError={sessionsError}
                  grouping={sidebarGrouping}
                  pendingApprovalSids={approvalEvents.pendingApprovalSids}
                  onNew={goToEmptyState}
                  onOpenDuck={() => void handleOpenDuck()}
                  onActivate={activateSession}
                  onExport={(path, name) => void handleExportSession(path, name)}
                  onOpenPersisted={(path, name) => void openPersisted(path, name)}
                  onClose={(sid) => {
                    void closeOpen(sid);
                    approvalEvents.clearSession(sid);
                  }}
                  onDelete={(path, sid) => void deletePersisted(path, sid)}
                  onRename={(sid, path, newName) => void renameEntry(sid, path, newName)}
                  onSwitchGrouping={switchSidebarGrouping}
                  onOpenSearch={openSearch}
                  provider={appConfig?.provider ?? null}
                  onOpenSettings={() => openSettings()}
                />

                <div
                  className={`sidebar-resize-handle${sidebarDragging ? " dragging" : ""}`}
                  onPointerDown={onSidebarResizeStart}
                />

                {/* Row 1: thin top bar (ADR-0060/0062 R1) */}
                <header className="topbar gap-3 px-4 border-b border-border bg-background" data-tauri-drag-region>
                  {platform === "macos" && <WindowControls />}
                  {settingsView.open ? (
                    <SidebarToggle
                      kind="settings"
                      collapsed={settingsNavCollapsed}
                      onToggle={() => setSettingsNavCollapsed((c) => !c)}
                    />
                  ) : (
                    <SidebarToggle
                      collapsed={sidebarCollapsed}
                      onToggle={toggleSidebarCollapse}
                    />
                  )}
                  <NavButtons />
                  <div className="flex-1" data-tauri-drag-region />
                  {!settingsView.open && (
                    <>
                      {atSoftCap && (
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
                    </>
                  )}
                  {platform !== "macos" && <WindowControls />}
                </header>

                {resumeStatus.kind !== "idle" && <ResumeProgress status={resumeStatus} />}

                {/* Row 3 (cols 2+): main area = session panes + shell-level bar.
                    ADR-0092: the main area is a flex column. The session pane
                    host fills the available space; the shell bar sits at the
                    bottom (flex-shrink: 0). In cold-start mode the bar is
                    centered and the pane host collapses. */}
                <main className="main-area">
                  <div className="session-pane-host">
                    {openSessions.map((s) => (
                      <div
                        key={s.sid}
                        className={`session-pane-layer${s.sid === activeSessionId ? " active" : " hidden"}`}
                        aria-hidden={s.sid !== activeSessionId}
                      >
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
                            pendingQuestion={s.pendingQuestion}
                            onQuestionConsumed={() => clearPendingQuestion(s.sid)}
                            onComposerFields={handleComposerFields}
                            sessionName={s.name}
                            onFirstTurnSettled={syncSessionName}
                            approvalEvents={approvalEvents}
                            onRailResizeStart={onRailResizeStart}
                          />
                        </ErrorBoundary>
                      </div>
                    ))}
                  </div>

                  {/* ADR-0092: shell-level QuestionBar — single instance, never
                      unmount/remount. Centered when cold-start (no active
                      session), bottom when a session is active. CSS transitions
                      the position. */}
                  <div
                    className={`shell-bar-slot${activeSessionId === null ? " centered" : " bottom"}`}
                  >
                    {activeSessionId === null && (
                      <h2 className="cold-start-greeting m-0 text-center text-[1.4rem] font-semibold text-foreground">
                        <FormattedMessage
                          id="coldStart.greeting"
                          defaultMessage="What would you like to analyze?"
                        />
                      </h2>
                    )}
                    <QuestionBar
                      onSubmit={handleShellSubmit}
                      onCancel={handleShellCancel}
                      loading={composer.loading}
                      phase={composer.phase}
                      draft={composer.draft}
                      setDraft={composer.setDraft}
                      header={
                        activeSessionId !== null ? (
                          <>
                            <ComposerSkillsTrigger
                              sessionId={activeSessionId}
                              loading={composer.loading}
                              onOpenSettingsSkills={() => openSettings({ section: "skills" })}
                            />
                            <ComposerMcpTrigger
                              sessionId={activeSessionId}
                              loading={composer.loading}
                              onOpenSettingsMcp={() => openSettings({ section: "mcp" })}
                            />
                          </>
                        ) : undefined
                      }
                      trailing={
                        providerPicker && activeSessionId !== null ? (
                          <ComposerProviderPicker
                            sessionId={activeSessionId}
                            {...(providerPicker as Omit<ComposerProviderPickerProps, "sessionId">)}
                          />
                        ) : undefined
                      }
                    >
                      <ComposerContextPanel
                        onIngestFiles={handleShellIngestFiles}
                        loading={composer.loading}
                      />
                      {activeSessionId !== null && (
                        <ComposerAuthModeChip sessionId={activeSessionId} />
                      )}
                    </QuestionBar>
                  </div>
                </main>

                {shellError && (
                  <ErrorBanner className="shell-error" error={shellError} />
                )}

                {settingsView.open && appConfig && (
                  <SettingsView
                    collapsed={settingsNavCollapsed}
                    appConfig={appConfig}
                    section={liveSettingsSection}
                    onSectionChange={setLiveSettingsSection}
                    initialEditProfileId={settingsView.editProfileId}
                    initialRuntimeTab={settingsView.runtimeTab}
                    onCommitAppConfig={(cfg) => commitAppConfig(cfg)}
                    onSessionsDirChanged={handleSessionsDirChanged}
                    onClose={() => {
                      setSettingsView({ open: false });
                      setLiveSettingsSection("general");
                      setProfileKeyEpoch((n) => n + 1);
                      void queryClient.invalidateQueries({
                        queryKey: adapterKeys.all(),
                      });
                    }}
                  />
                )}

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
            </NavigationHistoryProvider>
          </ErrorBoundary>
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
