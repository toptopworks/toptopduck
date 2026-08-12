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
import { useProfileKeys } from "./shell/useProfileKeys";
import { useComposerState, IDLE_SESSION_FIELDS } from "./session/useComposerState";
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
import type { AuthMode } from "./types/approval";
import { AUTH_MODE_DEFAULT } from "./types/approval";
import type { SessionRuntimeChoice } from "./types/runtime";
import { RUNTIME_CHOICE_DEFAULT } from "./types/runtime";
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
  // ENTRY hint consumed by ProfilesSection at mount (issue #239: the "no key"
  // CTA pre-selects the active profile for key editing); `runtimeTab` is a
  // one-shot ENTRY hint consumed by RuntimeSection at mount (issue #490: the
  // composer picker's two entry points each land a specific sub-tab). The
  // settings SECTION is no longer an entry hint: it is shell-owned live state
  // (liveSettingsSection below, issue #288) so the back/forward history can
  // restore it. openSettings() defaults to the sidebar-gear path (general, no
  // edit target); the cold-start submit-time honest gate (ADR-0092 Decision 4)
  // + the composer picker pass { section: "runtime", editProfileId? }.
  const [settingsView, setSettingsView] = useState<{
    open: boolean;
    editProfileId?: string;
    runtimeTab?: RuntimeTab;
  }>({
    open: false,
  });
  // The live settings section is shell-owned (issue #288): lifted out of
  // SettingsView so the back/forward history can restore it. Seeded "general"
  // and reset on close, matching the prior one-shot entry hint default.
  const [liveSettingsSection, setLiveSettingsSection] = useState<SettingsSection>("general");
  // Settings nav collapse toggle lives in the topbar (App-owned), so the state
  // stays here. Reset to expanded on every open so each visit starts from the
  // full nav (issue #285).
  const [settingsNavCollapsed, setSettingsNavCollapsed] = useState(false);
  // useCallback-stable (setters only): the ADR-0092 submit-time honest gate
  // lists it in a useCallback dep array.
  const openSettings = useCallback(
    (entry: SettingsEntry = { section: "general" }) => {
      setSettingsView({
        open: true,
        editProfileId: entry.editProfileId,
        runtimeTab: entry.runtimeTab,
      });
      setLiveSettingsSection(entry.section);
      setSettingsNavCollapsed(false);
    },
    [],
  );

  // Invalidation counter for the per-profile has_key overlay (issue #238).
  // Bumped on settings-close so the consumers refetch their overlays after a
  // Save that may have changed a keychain slot -- ADR-0019 honest gate: the
  // surfaces must not keep showing "No key" after the user just configured
  // one. Consumers: the composer picker's popover badge + the shell-level
  // submit-time gate (useProfileKeys, ADR-0092 Decision 4).
  const [profileKeyEpoch, setProfileKeyEpoch] = useState(0);

  // Ctrl/⌘+K session-search modal open state (ADR-0072, issue #252).
  // The shell owns the single open state so the global keydown + the sidebar's
  // search button (#250) route to the same dialog. Toggled false by the dialog
  // itself on choose / ESC / overlay-click via onOpenChange.
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);

  // --- App-level config (ADR-0038, issue #196) ----------------------------
  // Delegated to useAppConfigState (see that hook for the ADR-0068/0052
  // contract + restore / persist effects). App injects setShellError
  // (switchActiveProfile reject path) as a dep; reads back AppConfig state +
  // the derived effectiveLocale / intl + the two collapse toggles.
  // settingsView is App-local UI state (above).
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
  // Frontend-only localStorage persistence; the widths are exposed as CSS
  // custom properties on .shell so the grid + resize handles consume them
  // without a hardcoded px value. The rail width is declared first so the
  // sidebar hook can compensate it (sidebar grows -> rail shrinks by the same
  // delta, keeping the workspace visually fixed). The rail handle is
  // per-SessionPane but the width is global so it stays consistent across
  // keep-alive session switches.
  const { width: railWidth, isDragging: railDragging, onResizeStart: onRailResizeStart, adjustWidth: adjustRailWidth } = useRailResize();

  const { width: sidebarWidth, isDragging: sidebarDragging, onResizeStart: onSidebarResizeStart } = useSidebarResize({
    onDelta: (delta) => adjustRailWidth(-delta),
  });

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
    activateSession,
    goToEmptyState,
    busy,
    resumeStatus,
    createSessionWithQuestion,
    createSessionWithIngest,
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

  // Sessions directory change callback (issue #452): after `setSessionsDir`
  // IPC persists + returns the updated config, sync local state (no redundant
  // IPC write — the dedicated IPC already landed it) + refresh the sidebar so
  // it re-scans the new directory.
  const handleSessionsDirChanged = useCallback(
    (cfg: AppConfig) => {
      replaceAppConfig(cfg);
      refreshSessions();
    },
    [replaceAppConfig, refreshSessions],
  );

  // The tiered-approval side channel (ADR-0083, issue #297) is owned here at
  // the shell root: ONE listener pair feeds the per-session entry map that
  // BOTH the SessionPane of a suspended turn (in-flow approval cards) and the
  // SessionSidebar (unanswered-entry coloring) read. The sidebar needs the
  // cross-session view, so -- unlike the pane-local turn-progress listener
  // (ADR-0059) -- this channel cannot live inside a pane.
  const approvalEvents = useApprovalEvents();

  // ADR-0060 soft cap: a non-blocking badge in the top bar (not the sidebar)
  // signals memory pressure once the open keep-alive set reaches the cap; it
  // never forces a close.
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
        // SessionPane reports the IDLE_SESSION_FIELDS reference on unmount
        // (close / delete / error-boundary replacement): drop the entry so
        // the registry stays bounded by the open set.
        if (fields === IDLE_SESSION_FIELDS) {
          if (!(sid in prev)) return prev;
          const next = { ...prev };
          delete next[sid];
          return next;
        }
        // Skip if nothing changed (referential equality of all fields).
        const prevFields = prev[sid];
        if (
          prevFields &&
          prevFields.loading === fields.loading &&
          prevFields.phase === fields.phase &&
          prevFields.handleAsk === fields.handleAsk &&
          prevFields.handleCancel === fields.handleCancel &&
          prevFields.handleIngestFiles === fields.handleIngestFiles &&
          prevFields.workspaceCollapsed === fields.workspaceCollapsed
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
    activeSessionFields ?? IDLE_SESSION_FIELDS,
  );

  // ADR-0092 Decision 6: shell-level pending composer posture for the
  // cold-start bar. The runtime picker + auth-mode chip render on the
  // centered bar with NO session; their selections land here and are applied
  // to the session the first submit mints (consumed = reset to the backend
  // defaults, so each cold-start visit starts from the default posture).
  const [pendingRuntime, setPendingRuntime] =
    useState<SessionRuntimeChoice>(RUNTIME_CHOICE_DEFAULT);
  const [pendingAuthMode, setPendingAuthMode] = useState<AuthMode>(AUTH_MODE_DEFAULT);

  // ADR-0092 Decision 4 honest gate (submit-time). The centered bar is
  // always typeable; a cold-start submit on the built-in runtime requires a
  // profile WITH a key — otherwise the overlay opens on the Runtime tab
  // instead of minting a session whose first turn would fail on the missing
  // key (ADR-0019 honest guidance, replacing the retired ColdStartHero CTA
  // states). An external-runtime pick bypasses the key gate (the picker only
  // offers detected adapters). While the key overlay is unresolved
  // (app-config pending or first fetch in flight) the gate defers to
  // "ready", mirroring the hero's steady-state rule.
  const provider = appConfig?.provider ?? null;
  const profileKeys = useProfileKeys(provider, profileKeyEpoch);
  const builtInGateOpen =
    provider !== null &&
    !profileKeys.loading &&
    (!profileKeys.activeHasKey || profileKeys.activeKeychainFault !== null);

  // ADR-0092: shell-level bar submit handler. When activeSessionId is
  // non-null, delegate to the active session's handleAsk; when the pane has
  // not reported its fields yet (activation -> mount-report window), the
  // submit is a no-op — NEVER mint a second session for an active id. When
  // null, run the honest gate, then create a session carrying the question.
  // The draft is deliberately NOT cleared on submit (the pre-ADR-0092 bar
  // kept the text; a failed creation must never lose the question).
  const handleShellSubmit = useCallback(
    (question: string) => {
      if (activeSessionId !== null) {
        const fields = composerFieldsMap[activeSessionId];
        if (fields) void fields.handleAsk(question);
        return;
      }
      if (pendingRuntime.kind === "built_in" && builtInGateOpen) {
        openSettings({
          section: "runtime",
          editProfileId: profileKeys.activeProfileId ?? undefined,
        });
        return;
      }
      const runtime = pendingRuntime;
      const authMode = pendingAuthMode;
      void createSessionWithQuestion(question, { runtime, authMode }).then(
        (created) => {
          if (created) {
            setPendingRuntime(RUNTIME_CHOICE_DEFAULT);
            setPendingAuthMode(AUTH_MODE_DEFAULT);
          }
        },
      );
    },
    [
      activeSessionId,
      composerFieldsMap,
      createSessionWithQuestion,
      pendingRuntime,
      pendingAuthMode,
      builtInGateOpen,
      profileKeys.activeProfileId,
      openSettings,
    ],
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
  // handleIngestMany. On cold start a SINGLE picked file mints a session via
  // the drop-to-create twin (pendingIngestPath, same posture application as a
  // bar submit); multi-file cold-start picks are a follow-up (the open-set
  // pending shape carries one path).
  const handleShellIngestFiles = useCallback(
    (paths: string[]) => {
      if (activeSessionId !== null) {
        const fields = composerFieldsMap[activeSessionId];
        if (fields) fields.handleIngestFiles(paths);
        return;
      }
      if (paths.length !== 1) {
        setShellError({
          message: intl.formatMessage({
            id: "coldStart.ingestMultiFileUnsupported",
            defaultMessage: "Multi-file ingest is not available on the cold-start bar yet — open a session first, or pick one file at a time.",
          }),
          kind: "shell",
          detail: null,
        });
        return;
      }
      const runtime = pendingRuntime;
      const authMode = pendingAuthMode;
      void createSessionWithIngest(paths[0], { runtime, authMode }).then(
        (created) => {
          if (created) {
            setPendingRuntime(RUNTIME_CHOICE_DEFAULT);
            setPendingAuthMode(AUTH_MODE_DEFAULT);
          }
        },
      );
    },
    [activeSessionId, composerFieldsMap, createSessionWithIngest, pendingRuntime, pendingAuthMode, intl, setShellError],
  );

  // --- In-app navigation history (issue #288) -----------------------------
  // The back/forward stack is driven by a derived `location` NavEntry (active
  // session + settings overlay state). NavigationHistoryProvider pushes on
  // every location change; back/forward move the cursor and call `restore` to
  // re-apply the target view via RAW setters (not nav-wrappers), so the
  // resulting location change is skipped, not re-pushed. restore REPORTS
  // whether it moved the derived location: a non-restorable target returns
  // false so the provider treats the hop as a no-op instead of arming
  // skipNextRef and leaking the one-shot flag into the next genuine
  // navigation. editProfileId is deliberately NOT restored -- a back/forward
  // hop is a fresh view, not a profile-edit intent (issue #239).
  const location = useMemo<NavEntry>(
    () => ({
      sessionId: activeSessionId,
      settings: { open: settingsView.open, section: liveSettingsSection },
    }),
    [activeSessionId, settingsView.open, liveSettingsSection],
  );
  const restore = useCallback(
    (entry: NavEntry): boolean => {
      // Diff against the live state the location is derived from so the return
      // value is honest: false means this entry cannot move the location (the
      // provider then treats the hop as a no-op). The centered empty-state
      // target -- sessionId null with matching settings -- lands here: there
      // is no close-all-sessions path, so reporting false avoids leaking
      // skipNextRef.
      let moved = false;
      if (entry.settings.open !== settingsView.open) {
        setSettingsView((prev) => ({ ...prev, open: entry.settings.open }));
        moved = true;
      }
      if (entry.settings.section !== liveSettingsSection) {
        setLiveSettingsSection(entry.settings.section);
        moved = true;
      }
      // Direct null check (not a boolean alias) so TS narrows sessionId to
      // string for activateSession.
      if (entry.sessionId !== null && entry.sessionId !== activeSessionId) {
        activateSession(entry.sessionId);
        moved = true;
      }
      return moved;
    },
    [settingsView.open, liveSettingsSection, activeSessionId, activateSession],
  );

  // Global Ctrl/⌘+K keydown -> toggle the search modal (ADR-0072,
  // issue #252). The listener binds once on mount; a ref carries the latest
  // busy gate so a busy shell blocks the toggle without re-binding on every
  // busy change (same shape as SettingsView's Escape listener). preventDefault
  // stops the browser's native ⌘K page-searcher intercept so the modal is the
  // only consumer. metaKey covers macOS (⌘), ctrlKey covers Win/Linux (Ctrl).
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

  // The provider picker bundle for the shell-level bar (ADR-0071/0092):
  // app-level state (active profile + writes + the settings-open path)
  // rendered at the bar's trailing slot in BOTH positions — session-active
  // and cold start (sessionId null reads RUNTIME_CHOICE_DEFAULT + writes to
  // the shell-level pending state, Decision 6 no-degraded-controls). Absent
  // until app-config resolves. Explicitly typed so the render site spreads it
  // without an assertion.
  const providerPicker: Omit<ComposerProviderPickerProps, "sessionId" | "onPendingRuntimeChange"> | undefined = appConfig
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
          onError={handleIntlError}
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
            <NavigationHistoryProvider location={location} restore={restore}>
              <div
                className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarDragging ? " sidebar-dragging" : ""}${railDragging ? " rail-dragging" : ""}${settingsView.open ? " settings-mode" : ""}${settingsNavCollapsed ? " settings-nav-collapsed" : ""}${activeSessionId === null ? " cold-start-mode" : ""}`}
                style={{ "--sidebar-width": `${sidebarWidth}px`, "--rail-width": `${railWidth}px` } as CSSProperties}
              >
                {/* Col 1: session sidebar (ADR-0060) -- full height, independent
              column (R1: the shell-level bar does NOT span over it). */}
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
                    // A closed session's cards can never be answered (close
                    // fires cancel, the gate resolves to deny); drop them so
                    // the coloring + a later reopen start clean.
                    approvalEvents.clearSession(sid);
                    // A closed session's draft is unreachable (the pane is
                    // gone); drop the slot so the draft map tracks the open set.
                    composer.dropDraft(sid);
                  }}
                  onDelete={(path, sid) => {
                    void deletePersisted(path, sid);
                    if (sid !== null) composer.dropDraft(sid);
                  }}
                  onRename={(sid, path, newName) => void renameEntry(sid, path, newName)}
                  onSwitchGrouping={switchSidebarGrouping}
                  onOpenSearch={openSearch}
                  provider={appConfig?.provider ?? null}
                  onOpenSettings={() => openSettings()}
                />

                {/* Draggable resize handle at the sidebar/content boundary.
                    Absolutely positioned (see .sidebar-resize-handle in
                    styles.css); hidden via CSS when the sidebar is collapsed
                    or settings mode is active. */}
                <div
                  className={`sidebar-resize-handle${sidebarDragging ? " dragging" : ""}`}
                  onPointerDown={onSidebarResizeStart}
                />

                {/* Row 1: thin top bar (ADR-0060/0062 R1), spans the full shell
              width as a custom titlebar (decorations: false). Shell-wide
              controls only: the sidebar collapse toggle (left) + nav buttons
              + window controls (right). The session name + workspace toggle
              live in each SessionPane's own header (session-scoped chrome
              lives with the session). The Open / Save .duck buttons live in
              the session sidebar (below New session). ADR-0067 (#171): visual
              rules -> inline utilities; the .topbar grid + flex layout shell
              stays in styles.css. Settings mode (ADR-0075 overlay) unmounts
              the WORKSPACE children (sidebar toggle / soft-cap badge) but the
              titlebar itself persists: with decorations:false its window
              controls + drag region are shell-wide chrome that must stay
              reachable in every view (ADR-0074) -- the settings-mode CSS
              exempts .topbar from the overlay hide, and the rail owns settings
              chrome (the dual-state gear lives at the left columns' bottoms,
              issue #282 -- the topbar carries no settings entry). */}
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
                  {/* In-app back/forward (issue #288): browser-style nav history.
                    Rendered in every view (workspace + settings) so the
                    affordance is stable; the buttons disable at the stack
                    head/tail via useNavigationHistory. */}
                  <NavButtons />
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
                    </>
                  )}
                  {platform !== "macos" && <WindowControls />}
                </header>

                {/* Resume progress strip (ADR-0034). Absent unless an open/resume
                  runs -- `idle` is the ADT's resting state (issue #205), so the
                  gate discriminates on `kind` instead of truthiness-coercing a
                  nullable. */}
                {resumeStatus.kind !== "idle" && <ResumeProgress status={resumeStatus} />}

                {/* Row 3 (cols 2+): main area = session panes + shell-level bar.
                    ADR-0092: the main area is a flex column. The session pane
                    host fills the available space; the shell bar sits at the
                    bottom (flex-shrink: 0). In cold-start mode the bar is
                    centered and the pane host collapses. flex-grow interpolates
                    between the two postures (CSS transition), so the bar glides
                    centered <-> bottom on first submit / "+" navigation. */}
                <main className="main-area">
                  <div className="session-pane-host">
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
                      session), bottom when a session is active. The ws-collapsed
                      hook mirrors the active pane's workspace fold so the bar
                      width tracks the conversation column in both postures. */}
                  <div
                    className={`shell-bar-slot${activeSessionId === null ? " centered" : " bottom"}${activeSessionFields?.workspaceCollapsed ? " ws-collapsed" : ""}`}
                  >
                    {activeSessionId === null && (
                      <h2 className="cold-start-greeting m-0 text-center text-[1.4rem] font-semibold text-foreground">
                        <FormattedMessage
                          id="coldStart.greeting"
                          defaultMessage="What would you like to analyze?"
                        />
                      </h2>
                    )}
                    <div className="shell-bar-track">
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
                          // Cold-start Skills / MCP pending mode (ADR-0092
                          // Decision 6 "empty mount set + apply on create") is a
                          // follow-up slice: both popover sections are session-IPC
                          // bound and need a pending-state redesign. The runtime
                          // picker + auth-mode chip + context panel below already
                          // render cold-start.
                        }
                        trailing={
                          providerPicker ? (
                            <ComposerProviderPicker
                              sessionId={activeSessionId}
                              onPendingRuntimeChange={setPendingRuntime}
                              {...providerPicker}
                            />
                          ) : undefined
                        }
                      >
                        <ComposerContextPanel
                          onIngestFiles={handleShellIngestFiles}
                          loading={composer.loading}
                        />
                        <ComposerAuthModeChip
                          sessionId={activeSessionId}
                          pendingMode={pendingAuthMode}
                          onPendingModeChange={setPendingAuthMode}
                        />
                      </QuestionBar>
                    </div>
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
                    // Returns the IPC promise (unwrapped) so per-control commits
                    // inside SettingsView can await + catch failures and revert
                    // (ADR-0075). commitAppConfig itself stays optimistic /
                    // no-rollback (ADR-0068); the revert is the view's compensating
                    // write on a caught reject.
                    onCommitAppConfig={(cfg) => commitAppConfig(cfg)}
                    onSessionsDirChanged={handleSessionsDirChanged}
                    onClose={() => {
                      setSettingsView({ open: false });
                      setLiveSettingsSection("general");
                      // A Settings Save may have changed a keychain slot; bump
                      // the epoch so the picker overlay + the shell-level
                      // submit-time gate refetch (ADR-0019 honest gate,
                      // issue #238).
                      setProfileKeyEpoch((n) => n + 1);
                      // The Local CLI tab's Rescan may have changed adapter
                      // detection; invalidate the shared cache so the next
                      // popover open shows fresh data (ADR-0051 explicit
                      // invalidate; staleTime:Infinity means no auto-refetch).
                      void queryClient.invalidateQueries({
                        queryKey: adapterKeys.all(),
                      });
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
            </NavigationHistoryProvider>
          </ErrorBoundary>
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
