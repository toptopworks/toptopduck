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
import { useTrayEvents } from "./shell/useTrayEvents";
import { useAppConfigState } from "./shell/useAppConfigState";
import {
  ColdStartGuideBanner,
  deriveColdStartGap,
} from "./shell/ColdStartGuideBanner";
import { useStartupRuntime } from "./shell/useStartupRuntime";
import { useSidebarResize } from "./shell/useSidebarResize";
import { useRailResize } from "./shell/useRailResize";
import { railMaxWidth, sidebarMaxWidth } from "./shell/layoutBounds";
import { useProfileKeys } from "./shell/useProfileKeys";
import { useShellBarSlotMetrics } from "./shell/useShellBarSlotMetrics";
import { useBarWheelForward } from "./shell/useBarWheelForward";
import { useComposerState } from "./session/useComposerState";
import type { ComposerSessionFields } from "./session/useComposerState";
import { useComposerRegistry } from "./session/composerRegistry";
import { COMPOSER_INPUT_ID, QuestionBar } from "./components/thread/QuestionBar";
import { ComposerAuthModeChip } from "./components/thread/ComposerAuthModeChip";
import { ComposerWorkspacePicker } from "./components/thread/ComposerWorkspacePicker";
import type { PendingWorkspace } from "./components/thread/ComposerWorkspacePicker";
import { ComposerOccupancy } from "./components/thread/OccupancyRing";
import { ComposerContextPanel } from "./components/thread/ComposerContextPanel";
import { ComposerSkillChips } from "./components/thread/ComposerSkillChips";
import {
  ComposerProviderPicker,
  type ComposerProviderPickerProps,
} from "./components/thread/ComposerProviderPicker";
import { useColdStartSelection } from "./components/thread/composer-selection-write";
import type { AppConfig } from "./types/app-config";
import type { AuthMode } from "./types/approval";
import { AUTH_MODE_DEFAULT } from "./types/approval";
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
import type { SettingsSection, WorkspaceExitIntent } from "./components/settings/sections";
import { Alert } from "./components/ui/alert";
import { TooltipProvider } from "./components/ui/tooltip";
import { log } from "./lib/log";
import { createQueryClient } from "./lib/queryClient";
import { catalogFor } from "./i18n";
import { useTheme } from "./theme/useTheme";
import { adapterKeys, workspaceKeys } from "./session/queryKeys";
import { useTurnFailureSids } from "./session/useTurnFailureSids";

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
 *  for editing. Consumed by SettingsView/ProfilesSection at mount; reset to
 *  the default on close so a later sidebar-gear open does not re-target
 *  stale hints. */
type SettingsEntry = {
  section: SettingsSection;
  editProfileId?: string;
};

// Module-level so the IntlProvider `onError` prop is a STABLE reference across
// App renders (react-intl shallow-compares ALL provider props to decide
// whether to rebuild the `intl` context object; an inline arrow would rebuild
// it -- and every handler listing `intl` in its useCallback deps -- on every
// render). Why that identity matters is the composer registry's identity
// contract; see composerRegistry.ts.
function handleIntlError(err: Error): void {
  log.warn("i18n", err.message);
}

// The composer fire path's defensive log (#825): the shell bar's submit
// delegates to the active session's handleAsk. handleAsk settles its
// designed failures internally (session error state), so this catch only
// records an UNEXPECTED throw -- the unmapped runtime stamp's loud failure
// (#725) or a settled callback -- instead of surfacing it as an unhandled
// rejection with no trace on the main interaction path. The same contract
// SessionPane's pendingQuestion replay and ask-again sinks carry; log-only
// -- once the tail try is entered, the busy gate reopens in useTurnFlow's
// tail finally, so nothing user-facing is compensated here.
function fireShellAsk(
  fields: Pick<ComposerSessionFields, "handleAsk">,
  question: string,
  invocations: string[],
): void {
  void fields.handleAsk(question, invocations).catch((e: unknown) =>
    log.error("App", "shell submit handleAsk threw unexpectedly", e),
  );
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
  // CTA pre-selects the active profile for key editing). The settings
  // SECTION is no longer an entry hint: it is shell-owned live state
  // (liveSettingsSection below, issue #288) so the back/forward history can
  // restore it. openSettings() defaults to the sidebar-gear path (general, no
  // edit target); the cold-start submit-time honest gate (ADR-0092 Decision 4)
  // + the composer picker pass { section: "runtime", editProfileId? }.
  const [settingsView, setSettingsView] = useState<{
    open: boolean;
    editProfileId?: string;
  }>({
    open: false,
  });
  // The live settings section is shell-owned (issue #288): lifted out of
  // SettingsView so the back/forward history can restore it. Seeded "general"
  // and reset on close, matching the prior one-shot entry hint default.
  const [liveSettingsSection, setLiveSettingsSection] =
    useState<SettingsSection>("general");
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
    sidebarCollapsed,
    toggleSidebarCollapse,
    bootSeed,
  } = useAppConfigState({ setShellError });

  // --- Draggable sidebar + rail widths ------------------------------------
  // Frontend-only localStorage persistence; the widths are exposed as CSS
  // custom properties on .shell so the grid + resize handles consume them
  // without a hardcoded px value. The rail width is declared first so the
  // sidebar hook can compensate it (sidebar grows -> rail shrinks by the same
  // delta, keeping the workspace visually fixed). The rail handle is
  // per-SessionPane but the width is global so it stays consistent across
  // keep-alive session switches.
  //
  // Availability ceilings (issue #770): both drags clamp to what the live
  // grid containers can actually fit (measured from the elements, not
  // window.innerWidth, so the semantics stay anchored to whatever hosts the
  // tracks). Non-positive measurements (jsdom has no layout) read as "no
  // dynamic constraint" and fall back to the hooks' static ceilings. The
  // sidebar's ceiling is deliberately NOT fold-gated: a sidebar dragged wide
  // while the workspace is folded must not crush the rail below its floor
  // once the workspace is expanded again.
  const shellRef = useRef<HTMLDivElement>(null);
  const mainAreaRef = useRef<HTMLElement>(null);
  const getSidebarMaxWidth = useCallback((): number | undefined => {
    // Pre-mount (the restore path) the shell ref is null: the shell fills the
    // viewport, so documentElement.clientWidth stands in for that one
    // instant.
    const shellWidth =
      shellRef.current?.clientWidth ?? document.documentElement.clientWidth;
    return shellWidth > 0 ? sidebarMaxWidth(shellWidth) : undefined;
  }, []);
  const getRailMaxWidth = useCallback((): number | undefined => {
    const trackHostWidth = mainAreaRef.current?.clientWidth ?? 0;
    return trackHostWidth > 0 ? railMaxWidth(trackHostWidth) : undefined;
  }, []);

  const {
    width: railWidth,
    isDragging: railDragging,
    onResizeStart: onRailResizeStart,
    adjustWidth: adjustRailWidth,
  } = useRailResize({
    getMaxWidth: getRailMaxWidth,
    // Issue #781: the rail's ceiling reads the track host, whose clientWidth
    // lags the sidebar's own re-clamp inside a single window-resize event —
    // so the re-clamp observes the host's settled layout instead of resize.
    observeTarget: mainAreaRef,
  });

  const {
    width: sidebarWidth,
    isDragging: sidebarDragging,
    onResizeStart: onSidebarResizeStart,
  } = useSidebarResize({
    onDelta: (delta) => adjustRailWidth(-delta),
    getMaxWidth: getSidebarMaxWidth,
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
  // showArchived (ADR-0127 Decision 7, issue #1175): the archived view's
  // visibility. Deliberately NOT persisted -- every startup resets the
  // archived view to hidden (the peek semantics), so plain useState.
  const [showArchived, setShowArchived] = useState(false);
  const { sessions, archivedSessions, sessionsError, sessionsLoaded, refreshSessions } =
    usePersistedSessions({ intl, includeArchived: showArchived });
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
    syncSessionName,
    setPinned,
    setArchived,
  } = useShellSessions({ intl, queryClient, refreshSessions, setShellError });

  // System tray events (issue #1140, ADR-0125): routes the tray menu's
  // open-session / new-session clicks onto the shell's existing session
  // actions (sidebar parity -- the tray introduces no session semantics of
  // its own; the window reveal is handled on the Rust side).
  useTrayEvents({
    sessions,
    openPersisted,
    goToEmptyState,
  });

  // Cold start (ADR-0092): no active session -- the centered bar + greeting
  // shell posture, and the composer's pending channels below are live.
  const isColdStart = activeSessionId === null;

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

  // Default runtime change callback (issue #571): the setDefaultRuntime IPC
  // persists + returns the updated config; sync local state only. No sidebar
  // re-scan -- a machine-level runtime preference does not move session files
  // (contrast handleSessionsDirChanged).
  const handleDefaultRuntimeChanged = useCallback(
    (cfg: AppConfig) => {
      replaceAppConfig(cfg);
    },
    [replaceAppConfig],
  );

  // CLI registry change callback (issue #671): the upsert/remove IPCs are
  // backend RMW commands that already persisted + returned the updated
  // config; sync local state only -- no second disk write (contrast the
  // onCommit read-modify-write path the other panes use).
  const handleCliToolsChanged = useCallback(
    (cfg: AppConfig) => {
      replaceAppConfig(cfg);
    },
    [replaceAppConfig],
  );

  // The tiered-approval side channel (ADR-0083, issue #297) is owned here at
  // the shell root: ONE listener pair feeds the per-session entry map that
  // BOTH the SessionPane of a suspended turn (in-flow approval cards) and the
  // SessionSidebar (unanswered-entry coloring) read. The sidebar needs the
  // cross-session view, so -- unlike the pane-local turn-progress listener
  // (ADR-0059) -- this channel cannot live inside a pane.
  const approvalEvents = useApprovalEvents();

  // Issue #1005: the cross-session turn-failure view -- the sidebar's error
  // state derives from each open session's thread query cache (read-only
  // subscribers; the panes own every fetch), standing beside
  // useApprovalEvents as the second shell-level cross-session read.
  const turnFailureSids = useTurnFailureSids(queryClient, openSessions.map((s) => s.sid));

  // ADR-0060 soft cap: a non-blocking badge in the top bar (not the sidebar)
  // signals memory pressure once the open keep-alive set reaches the cap; it
  // never forces a close.
  const atSoftCap = openSessions.length >= SOFT_CAP_OPEN_SESSIONS;

  // --- ADR-0092: Shell-level composer registry -----------------------------
  // The registry owns the per-session fields registry + the scoped
  // invocation staging (identity contract + lifecycle semantics live in its
  // module doc); App only wires the pane report face and reads the merged
  // view.
  const composerRegistry = useComposerRegistry(activeSessionId);
  const {
    report,
    reportUnmount,
    readFields,
    activeSessionFields,
    readInvocations,
    stage,
    withdraw,
    consumeCold,
    consumeView,
    dropSession,
  } = composerRegistry;
  // ADR-0130 (issue #1272): the composer occupancy ring -- the active
  // session's timeline is subscribed to the shared thread cache INSIDE the
  // ring's shell-side mount (App's body sits above the QueryClientProvider,
  // so the useQuery cannot live here); the denominator rides the snapshot
  // itself (#1290: a channel-reported window or the backend's catalog
  // stamp). null / absent on cold start: the ring renders nothing.
  const composer = useComposerState(activeSessionId, activeSessionFields);
  // Destructured so handleShellSubmit's dep array holds the useCallback-stable
  // setter itself (the composer object rebuilds every render, issue #229 idiom).
  const { setDraft: setComposerDraft } = composer;
  // The active pane's fold mirrored onto the shell-level layout (.main-area
  // class + the bar slot's ws-collapsed). Defaults to COLLAPSED while the
  // pane has not reported its fields yet (the activation -> mount-report
  // window): every SessionPane mount path starts folded (useWorkspaceCollapse
  // initial state), so the mirrors render the folded geometry from the entry
  // frame instead of one frame at rail-width geometry followed by a 280ms
  // slide into the collapsed track.
  const activeWsCollapsed =
    activeSessionId !== null &&
    (readFields(activeSessionId)?.workspaceCollapsed ?? true);

  // ADR-0092 Decision 6 (#500): shell-level pending composer posture for the
  // cold-start bar. Every composer control renders on the centered bar with
  // NO session in draft mode; the selections land here and are applied to the
  // session the first submit mints (consumed = reset to the unset posture /
  // empty lists, so each cold-start visit starts from the default posture).
  // runtime / authMode / skills apply via per-session IPC writes in
  // useShellSessions.mintAndRegister (MCP servers are config-level
  // enablement since ADR-0106 -- nothing to apply per session); the file
  // list rides the new session's pendingIngestPaths.
  //
  // ADR-0098 Decision 4 (issue #572): the runtime facet starts UNSET (null)
  // -- before any pick it reads as the resolved default_runtime below, so the
  // cold-start picker opens on the startup resolution instead of a built-in
  // constant. A pick replaces the whole value (never null again until
  // consumed).
  // ADR-0098 Decision 4 / ADR-0099/0100 (issues #572/#574): the cold-start
  // bar's pending selection state -- the runtime facet + the posture pair,
  // both null-sentineled (null = untouched) -- owned by the selection
  // write port module, which also holds the ADR-0100 Decision 2 namespace
  // reset (an explicit runtime switch or a startup-resolution drift resets
  // the pending posture) and the #592 rollback ledger. App reads the raw
  // facets at the mint submit and consumes them on success.
  const [pendingAuthMode, setPendingAuthMode] =
    useState<AuthMode>(AUTH_MODE_DEFAULT);
  const [pendingFiles, setPendingFiles] = useState<string[]>([]);
  // The session-creation workspace selector's pending value (ADR-0137/0138,
  // issue #1384): the directory the NEXT minted session binds, consumed once
  // by createSession's directory parameter and reset to unbound afterwards.
  // null = the default lazy mint -- the pre-#1384 behavior.
  const [pendingWorkspace, setPendingWorkspace] =
    useState<PendingWorkspace | null>(null);
  // Skill invocation staging (ADR-0112/0119) lives in the composer seam --
  // the scoped staging map with its lifecycle semantics (peek survival,
  // cross-facet coexistence, single-slot replacement, consume-at-submit).

  // The startup resolution of the persisted default_runtime against the
  // shared adapter table (ADR-0098 Decisions 2/3, issue #572): what a cold
  // start opens on before any user pick, degrading to built-in when the
  // named CLI is undetected / the table has not loaded. Display + gate read
  // this projection; the startup TRUTH stays the backend's own
  // create_session resolution, so an unset pending skips the runtime write
  // (the minted session already carries the resolved runtime) while an
  // explicit pick still applies via setSessionRuntime.
  const { runtime: startupRuntime, adapters: startupAdapters } =
    useStartupRuntime(queryClient, appConfig?.default_runtime);
  // The cold-start selection channel (composer-selection-write.ts): owns
  // the pending runtime + posture pair, the write port the picker routes
  // through, and the namespace reset for effective-runtime identity
  // changes (the picker-path switch and this resolution-only drift).
  const coldStartSelection = useColdStartSelection({
    startupRuntime,
    queryClient,
  });
  const { pendingRuntime, pendingModelPosture, consume: consumeColdStart } =
    coldStartSelection;
  const effectivePendingRuntime = coldStartSelection.channel.effectiveRuntime;

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

  // The cold-start guidance banner (issue #1337): a pure derivation over the
  // same primitives the submit gate reads. Null while any feed is still
  // unresolved (the adapter table / the key overlay's first fetch / the
  // provider feed's one-shot app-config read), so the first painted frame
  // carries the correct form; session-active renders never derive.
  // Disappearance is free: the epoch bump + the cache subscription re-derive
  // on every relevant change.
  const coldStartGap = isColdStart
    ? deriveColdStartGap({
        defaultRuntime: appConfig?.default_runtime,
        pendingRuntime: effectivePendingRuntime,
        adapters: startupAdapters,
        provider,
        keysLoading: profileKeys.loading,
        activeHasKey: profileKeys.activeHasKey,
        activeKeychainFault: profileKeys.activeKeychainFault,
        keysFetchFault: profileKeys.keysFetchFault,
      })
    : null;

  // ADR-0092: shell-level bar submit handler. When activeSessionId is
  // non-null, delegate to the active session's handleAsk; when the pane has
  // not reported its fields yet (mint -> first-report window), the submit is
  // a no-op — NEVER mint a second session for an active id. When
  // null, run the honest gate, then create a session carrying the question.
  // Draft lifecycle: an in-session submit clears the session draft at the
  // ask (the optimistic Turn append already carries the question into the
  // thread, so the bar's copy must not resurface on the next turn); the
  // cold-start draft clears ONLY on a minted session (a failed creation
  // must never lose the question).
  const handleShellSubmit = useCallback(
    (question: string) => {
      if (activeSessionId !== null) {
        const fields = readFields(activeSessionId);
        if (!fields) return;
        // The ask leaves the composer: one clear up front covers all three
        // fire sites below, and the no-op window above never reaches it.
        setComposerDraft("");
        // ADR-0119 Decision 1: the staging IS this turn's user invocation --
        // it rides the ask (the backend materializes the records at submit)
        // and the staging clears at the submit boundary.
        const intents = readInvocations(activeSessionId);
        consumeView();
        fireShellAsk(fields, question, intents);
        return;
      }
      if (effectivePendingRuntime.kind === "built_in" && builtInGateOpen) {
        openSettings({
          section: "runtime",
          editProfileId: profileKeys.activeProfileId ?? undefined,
        });
        return;
      }
      // Null passes through so mintAndRegister SKIPS the runtime write: the
      // backend's create_session resolution is the startup truth and already
      // started the session on the resolved runtime. An explicit pick --
      // including a built-in pick against an external default -- always
      // applies. modelPosture follows the same null-skip / explicit-apply
      // shape (issue #574).
      const runtime = pendingRuntime;
      const modelPosture = pendingModelPosture;
      // The session starts on the effective runtime (the explicit pick or
      // the startup resolution -- the backend resolves the same way), so
      // this is the adapter an explicit posture's set IPCs record under.
      const postureAdapter =
        modelPosture !== null && effectivePendingRuntime.kind === "external"
          ? effectivePendingRuntime.data
          : null;
      const authMode = pendingAuthMode;
      const invocations = readInvocations(null);
      const files = pendingFiles;
      void createSessionWithQuestion(
        question,
        invocations,
        { runtime, modelPosture, authMode },
        files,
        pendingWorkspace?.path ?? null,
      ).then((created) => {
        if (created) {
          // The question rode the pendingQuestion channel into the new
          // session's pane, so the cold-start draft's copy clears. The
          // closure's setter is still the null-keyed one: it writes the
          // cold-start slot even after activeSessionId flips to the mint.
          setComposerDraft("");
          consumeColdStart();
          setPendingAuthMode(AUTH_MODE_DEFAULT);
          consumeCold();
          setPendingFiles([]);
          // Issue #1384: the workspace selection is one-shot -- consumed by
          // the mint, the pill returns to unbound for the next session.
          setPendingWorkspace(null);
          // Issue #1392: the mint's explicit bind just made (or freshened) a
          // registry record -- the sidebar's workspace section must not wait
          // for the next popover open to show the group.
          void queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
          // The mint-time set IPCs landed the explicit pair in the startup
          // backfill entry (record_last_model_posture, the single write
          // point). Invalidate so a later return to cold start refetches the
          // post-set entry (staleTime: Infinity never auto-refetches,
          // ADR-0051).
          if (postureAdapter !== null) {
            void queryClient.invalidateQueries({
              queryKey: adapterKeys.posture(postureAdapter),
            });
          }
        }
      });
    },
    [
      activeSessionId,
      readFields,
      readInvocations,
      consumeCold,
      consumeView,
      setComposerDraft,
      createSessionWithQuestion,
      queryClient,
      effectivePendingRuntime,
      pendingRuntime,
      pendingModelPosture,
      consumeColdStart,
      pendingAuthMode,
      pendingFiles,
      pendingWorkspace,
      builtInGateOpen,
      profileKeys.activeProfileId,
      openSettings,
    ],
  );

  // ADR-0092: shell-level cancel — delegates to the active session's
  // handleCancel. Idle when no session is active (no turn to cancel).
  const handleShellCancel = useCallback(() => {
    if (activeSessionId !== null) {
      const fields = readFields(activeSessionId);
      if (fields) void fields.handleCancel();
    }
  }, [activeSessionId, readFields]);

  // ADR-0112 (issue #716): a picker selection reports here. The pick is a
  // single uniform state -- it never consults the mounted / activated caches
  // (display data only); it always lands a chip. The scope is the active
  // view (null on cold start): the seam's stage merges unique in-slot and
  // replaces the previous session's slot across sessions (its module doc
  // carries the single-slot semantics).
  const handleSkillPick = useCallback(
    (name: string) => {
      stage(activeSessionId, [name]);
    },
    [activeSessionId, stage],
  );

  // Review Important 1 (#991): the pane's ingest-abort branch re-seeds the
  // question into the bar draft; the staged invocations get the same
  // channel back into the session's staging. The pick + the question are
  // one atomic intent -- a resubmit after an aborted ingest carries both,
  // not just the question (merge-unique, matching the picker's own land).
  const handleSeedInvocations = useCallback(
    (sid: string, names: string[]) => {
      stage(sid, names);
    },
    [stage],
  );

  // The settings overlay's close handler (issue #1040): a "new-skill"
  // intent (the Skills pane's New) stages the teaching skill and seats
  // focus on the composer's textarea, caret right after the chip -- the
  // staging mechanics live on WorkspaceExitIntent. A plain exit (no
  // intent) closes only and stages nothing.
  const handleSettingsClose = useCallback(
    (intent?: WorkspaceExitIntent) => {
      if (intent === "new-skill") {
        handleSkillPick("skill-creator");
        // Runs after the overlay's synchronous focus restore to its
        // trigger, and after React has committed the chip onto the bar.
        window.setTimeout(() => {
          document.getElementById(COMPOSER_INPUT_ID)?.focus();
        }, 0);
      }
      setSettingsView({ open: false });
      setLiveSettingsSection("general");
      // A Settings Save may have changed a keychain slot; bump the epoch
      // so the picker overlay + the shell-level submit-time gate refetch
      // (ADR-0019 honest gate, issue #238).
      setProfileKeyEpoch((n) => n + 1);
      // The Local CLI tab's Rescan may have changed adapter detection;
      // invalidate the shared cache so the next popover open shows fresh
      // data (ADR-0051 explicit invalidate; staleTime:Infinity means no
      // auto-refetch).
      void queryClient.invalidateQueries({ queryKey: adapterKeys.all() });
    },
    [handleSkillPick, queryClient],
  );

  // Withdrawing a staged invocation (ADR-0112 Decision 3): the chip's
  // removal button (#961) and the composer's Backspace at the draft start
  // are the two user surfaces. Cold start and session picks withdraw the
  // same way -- the intent list is the only surface.
  const handleRemoveInvocation = useCallback(
    (name: string) => {
      withdraw(activeSessionId, name);
    },
    [activeSessionId, withdraw],
  );

  // The bar's live chip facet: the active scope's staging (the cold slot in
  // draft mode, the session slot otherwise).
  const pendingInvocations = readInvocations(activeSessionId);

  // Backspace at the draft's start withdraws the most recent intent: the
  // chips seat before the draft's first char, so the last chip deletes like
  // a text char (ADR-0112 Decision 3).
  const handleChipBackspace = useCallback(() => {
    const last = pendingInvocations[pendingInvocations.length - 1];
    if (last !== undefined) handleRemoveInvocation(last);
  }, [pendingInvocations, handleRemoveInvocation]);

  // Shared teardown for "close this session": the pane header menu (ADR-0093)
  // and the sidebar row menu (ADR-0133, issue #1319) both fire cancel +
  // approval cleanup + draft drop -- one body keeps the two surfaces in
  // lockstep.
  const closeSessionWithCleanup = (sid: string) => {
    void closeOpen(sid);
    // A closed session's cards can never be answered (close fires cancel, the
    // gate resolves to deny); drop them so the coloring + a later reopen start
    // clean (re-wired from the retired sidebar trigger by ADR-0093 slice 2,
    // #512).
    approvalEvents.clearSession(sid);
    // A closed session's draft is unreachable (the pane is gone); drop the
    // slot so the draft map tracks the open set.
    composer.dropDraft(sid);
    // Its staged invocations are unreachable the same way -- the explicit
    // drop replaces the sid-mismatch implicit invalidation.
    dropSession(sid);
  };

  // Symmetric teardown for "delete this session" (issue #1319): the pane
  // header menu and the sidebar row menu share the deletePersisted mutation +
  // draft drop -- one body keeps the two surfaces in lockstep. `sid` is null
  // for a cold persisted / archived row (nothing open to unmount or drop).
  const deleteSessionWithCleanup = (path: string, sid: string | null) => {
    void deletePersisted(path, sid);
    if (sid) {
      composer.dropDraft(sid);
      dropSession(sid);
    }
  };

  // ADR-0092 (#500): shell-level file ingest. When active, delegate to the
  // session's handleIngestMany. On cold start the picked files accumulate in
  // the shell-level pending file list (draft mode, Decision 6) — the bar's
  // "+" chip shows the queued count, and the first submit carries the whole
  // list onto the minted session (pendingIngestPaths), where the pane ingests
  // it BEFORE firing the pending question. Duplicates (the same path picked
  // twice) are dropped at accumulation time.
  const handleShellIngestFiles = useCallback(
    (paths: string[]) => {
      if (activeSessionId !== null) {
        const fields = readFields(activeSessionId);
        if (fields) fields.handleIngestFiles(paths);
        return;
      }
      setPendingFiles((prev) => {
        const known = new Set(prev);
        const fresh = paths.filter((p) => !known.has(p));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
    },
    [activeSessionId, readFields],
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

  // Issue #836: the bar slot's scrollbar probe + live-height observer --
  // named hook (see useShellBarSlotMetrics for the #836 sizing rationale).
  // App only binds the returned slot ref at the render site.
  const shellBarSlotRef = useShellBarSlotMetrics(mainAreaRef);
  // Issue #834: the bar slot's wheel forward to the active pane's rail --
  // named hook (see useBarWheelForward for the forwarding semantics).
  const handleBarWheel = useBarWheelForward(mainAreaRef);

  // Theme (ADR-0050): applied to <html>, follows the persisted three-state
  // preference (boot-seeded pre-paint, defaulting to system only when both
  // the seed and app-config are absent). The Vega
  // bridge listens to the theme-change event this fires. effectiveLocale +
  // intl are resolved inside useAppConfigState (where the owned appConfig
  // lives); the IntlProvider subtree + document.lang consume them here.
  useTheme(appConfig?.theme ?? bootSeed?.theme ?? "system");

  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = effectiveLocale;
    }
  }, [effectiveLocale]);

  // The provider picker bundle for the shell-level bar (ADR-0071/0092):
  // app-level state (active profile + writes + the settings-open path)
  // rendered at the bar's trailing slot in BOTH positions — session-active
  // and cold start (sessionId null reads the resolved default_runtime seed
  // and writes to the shell-level pending state, Decision 6
  // no-degraded-controls). Absent until app-config resolves. Explicitly
  // typed so the render site spreads it without an assertion. The pending
  // props sit in the Omit list so a same-named field on a future
  // appConfig-derived bundle could not ride the spread over the explicitly
  // written mode-conditional values at the render site.
  const providerPicker:
    | Omit<ComposerProviderPickerProps, "sessionId" | "coldStart">
    | undefined = appConfig
      ? {
          provider: appConfig.provider,
          onSwitchActive: (id: string) => void switchActiveProfile(id),
          onOpenSettings: () => openSettings({ section: "runtime" }),
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
                ref={shellRef}
                className={`shell${sidebarCollapsed ? " sidebar-collapsed" : ""}${sidebarDragging ? " sidebar-dragging" : ""}${railDragging ? " rail-dragging" : ""}${settingsView.open ? " settings-mode" : ""}${settingsNavCollapsed ? " settings-nav-collapsed" : ""}${isColdStart ? " cold-start-mode" : ""}`}
                style={
                  {
                    "--sidebar-width": `${sidebarWidth}px`,
                    "--rail-width": `${railWidth}px`,
                  } as CSSProperties
                }
              >
                {/* Col 1: session sidebar (ADR-0060) -- full height, independent
              column (R1: the shell-level bar does NOT span over it). */}
                <SessionSidebar
                  collapsed={sidebarCollapsed}
                  sessions={sessions}
                  sessionsLoaded={sessionsLoaded}
                  openSessions={openSessions}
                  activeSessionId={activeSessionId}
                  disabled={busy}
                  loadError={sessionsError}
                  pendingApprovalSids={approvalEvents.pendingApprovalSids}
                  turnFailedSids={turnFailureSids}
                  onNew={goToEmptyState}
                  onNewInWorkspace={(path, label) => {
                    // Issue #1392: the workspace section's ⊕ shortcut -- the
                    // same staged pendingWorkspace channel the composer pill
                    // uses (one-shot, consumed by the next mint), landing on
                    // the cold-start bar where the pill shows the staged
                    // selection.
                    setPendingWorkspace({ path, label });
                    goToEmptyState();
                  }}
                  onActivate={activateSession}
                  onOpenPersisted={(path, name) =>
                    void openPersisted(path, name)}
                  archivedSessions={archivedSessions}
                  showArchived={showArchived}
                  onToggleArchived={() => setShowArchived((v) => !v)}
                  onSetPinned={(path, pinned) => void setPinned(path, pinned)}
                  onArchive={(path, archived, sid) =>
                    void setArchived(path, archived, sid)}
                  onDelete={deleteSessionWithCleanup}
                  onRename={(path, sid, newName) =>
                    void renameEntry(sid, path, newName)}
                  onClose={closeSessionWithCleanup}
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
              lives with the session). The Open / Save recipe.json buttons live in
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
                <header
                  className="topbar gap-3 px-4 border-b border-border bg-background"
                  data-tauri-drag-region
                >
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

                {/* Row 3 (cols 2+): main area = session panes + shell-level bar.
                    ADR-0092: the pane host fills the main area's full height;
                    the shell bar is an absolute overlay on top of it (issue
                    #836), so the rail's scrollbar reaches the window's bottom
                    edge and the thread tail scrolls behind the bar. The two
                    postures interpolate between anchor pairs (centered:
                    bottom 50% + translateY(50%); bottom: bottom 0 +
                    translateY(0)), so the bar glides centered <-> bottom on
                    first submit / "+" navigation without resizing the pane
                    host. */}
                <main
                  ref={mainAreaRef}
                  className={`main-area${activeWsCollapsed ? " workspace-collapsed" : ""}`}
                >
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
                    drops its cache so the remount re-fetches fresh. The
                    artifact prefix rides along (issue #1212): its keys are
                    process-global, and a Query-driven re-render throw lands
                    HERE (the React 19 nested-boundary gap ADR-0058 records),
                    so a retry that skipped them would remount against the
                    cached throwing text entry (staleTime Infinity) and
                    re-degrade forever. */}
                        <ErrorBoundary
                          name="session"
                          onReset={() => {
                            void queryClient.removeQueries({
                              queryKey: ["session", s.sid],
                            });
                            void queryClient.removeQueries({
                              queryKey: ["artifact"],
                            });
                          }}
                        >
                          <SessionPane
                            key={s.sid}
                            sessionId={s.sid}
                            isActive={s.sid === activeSessionId}
                            pendingIngestPaths={s.pendingIngestPaths}
                            onIngestConsumed={() => clearPendingIngest(s.sid)}
                            pendingQuestion={s.pendingQuestion}
                            pendingSkillInvocations={s.pendingSkillInvocations}
                            onQuestionConsumed={() =>
                              clearPendingQuestion(s.sid)}
                            onSeedDraft={composer.seedDraft}
                            onSeedInvocations={handleSeedInvocations}
                            onComposerFields={report}
                            onComposerFieldsUnmount={reportUnmount}
                            sessionName={s.name}
                            onFirstTurnSettled={syncSessionName}
                            approvalEvents={approvalEvents}
                            recipePath={s.path}
                            onRename={renameEntry}
                            disabled={busy}
                            onClose={closeSessionWithCleanup}
                            onDelete={deleteSessionWithCleanup}
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
                    ref={shellBarSlotRef}
                    className={`shell-bar-slot${isColdStart ? " centered" : " bottom"}${activeWsCollapsed ? " ws-collapsed" : ""}`}
                    onWheel={handleBarWheel}
                  >
                    {isColdStart && (
                      <>
                        <label
                          htmlFor={COMPOSER_INPUT_ID}
                          className="cold-start-greeting m-0 text-center text-[1.4rem] font-semibold text-foreground"
                        >
                          <FormattedMessage
                            id="coldStart.greeting"
                            defaultMessage="Ask a data question — get analysis, reports, and insights."
                          />
                        </label>
                        {/* Issue #1337: the guidance banner sits between the
                            greeting and the bar track -- same slot width as
                            the bar, no scrollable inside (the slot's wheel
                            forwarding stays a structural no-op). */}
                        {coldStartGap !== null && (
                          <ColdStartGuideBanner
                            gap={coldStartGap}
                            onOpenSettings={() => openSettings({ section: "runtime" })}
                          />
                        )}
                      </>
                    )}
                    <div className="shell-bar-track">
                      {/* Issue #836: opaque backdrop over the conversation
                          column so scrolling content never peeks around the
                          floating card. Rendered in the bottom posture only
                          -- every backdrop rule is bottom-scoped, so
                          rendering it in cold start would be dead markup.
                          styles.css reserves the rail's scrollbar band
                          (measured scrollbar width plus the 1px column
                          border) at the column's right edge. */}
                      {!isColdStart && (
                        <div className="shell-bar-backdrop" aria-hidden="true" />
                      )}
                      <QuestionBar
                        onSubmit={handleShellSubmit}
                        onCancel={handleShellCancel}
                        loading={composer.loading}
                        phase={composer.phase}
                        turnStartedAt={composer.turnStartedAt}
                        turnPausedSince={composer.turnPausedSince}
                        draft={composer.draft}
                        setDraft={composer.setDraft}
                        skillPicker={{
                          onPick: handleSkillPick,
                          chips: {
                            node: (
                              // The skill chips flow inline in the input
                              // area and show THIS turn's staging only
                              // (ADR-0119: the activated-truth union of
                              // #961 retired with its channel); the caret
                              // seats right after the last chip.
                              <ComposerSkillChips
                                names={pendingInvocations}
                                onRemove={handleRemoveInvocation}
                              />
                            ),
                            onBackspace: handleChipBackspace,
                          },
                        }}
                        trailing={(
                          <>
                            {/* ADR-0130 calibration: the ring rides the
                                trailing cluster's head (before the runtime
                                picker), not the leading controls -- keeps the
                                reading adjacent to the send decision point. */}
                            <ComposerOccupancy sessionId={activeSessionId} />
                            {providerPicker ? (
                              <ComposerProviderPicker
                                sessionId={activeSessionId}
                                coldStart={
                                  isColdStart ? coldStartSelection.channel : null
                                }
                                {...providerPicker}
                              />
                            ) : undefined}
                          </>
                        )}
                      >
                        <ComposerContextPanel
                          onIngestFiles={handleShellIngestFiles}
                          loading={composer.loading}
                          pendingFiles={isColdStart ? pendingFiles : undefined}
                          onClearPendingFiles={() => setPendingFiles([])}
                        />
                        <ComposerAuthModeChip
                          sessionId={activeSessionId}
                          pendingMode={pendingAuthMode}
                          onPendingModeChange={setPendingAuthMode}
                        />
                      </QuestionBar>
                      {/* Cold-start only (issue #1384): the workspace
                          selection binds the session the bar is about to
                          mint; with a session active the binding is
                          immutable, so the selector would be a dead
                          control. The ChatGPT/WorkBuddy pedestal: a fully
                          rounded strip, inset on both flanks, whose top
                          slides BEHIND the card (negative margin; the card
                          is positioned and paints above this unpositioned
                          sibling) so only its lower half shows -- one
                          composer block, no seam. pt compensates the
                          hidden band so the row reads below the card. */}
                      {isColdStart && (
                        <div className="mx-3 -mt-3 flex items-center gap-1.5 rounded-lg bg-muted/70 px-1 pb-1 pt-4">
                          <ComposerWorkspacePicker
                            value={pendingWorkspace}
                            onChange={setPendingWorkspace}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Draggable rail resize handle at the conversation/workspace
                      boundary. Hoisted to .main-area (ADR-0092) so it spans the
                      full height — including the shell-level QuestionBar overlay
                      (z-index 10 keeps it grabbable across the bar strip) —
                      matching the sidebar handle's reach. Hidden via CSS when
                      cold-start, settings mode, or workspace folded. */}
                  <div
                    className="rail-resize-handle"
                    onPointerDown={onRailResizeStart}
                  />

                  {/* Resume progress strip (ADR-0034). Absent unless an open/
                      resume runs -- `idle` is the ADT's resting state (issue
                      #205), so the gate discriminates on `kind` instead of
                      truthiness-coercing a nullable. Rendered INSIDE main-area
                      as an absolutely-positioned overlay (see styles.css): the
                      former in-flow shell-grid row-2 placement shifted the whole
                      main area down on mount + back up on unmount, bouncing the
                      visible session header on every open/resume. */}
                  {resumeStatus.kind !== "idle" && (
                    <ResumeProgress status={resumeStatus} />
                  )}
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
                    // Returns the IPC promise (unwrapped) so per-control commits
                    // inside SettingsView can await + catch failures and revert
                    // (ADR-0075). commitAppConfig itself stays optimistic /
                    // no-rollback (ADR-0068); the revert is the view's compensating
                    // write on a caught reject.
                    onCommitAppConfig={(cfg) => commitAppConfig(cfg)}
                    // State-only sync for a double-failed commit (#659): the
                    // view re-reads the disk truth and hands it back here.
                    onReplaceAppConfig={replaceAppConfig}
                    onSessionsDirChanged={handleSessionsDirChanged}
                    onDefaultRuntimeChanged={handleDefaultRuntimeChanged}
                    onCliToolsChanged={handleCliToolsChanged}
                    onClose={handleSettingsClose}
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
                  onOpenPersisted={(path, name) =>
                    void openPersisted(path, name)}
                />
              </div>
            </NavigationHistoryProvider>
          </ErrorBoundary>
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
