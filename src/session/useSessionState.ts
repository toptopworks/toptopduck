import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activeDataset,
  conversation,
  listWorkingSet,
  removeActiveSource,
  removeSource,
  renameDataset,
  replaceSource,
  setDatasetPrivacy,
  takePersistError,
} from "../api";
import { toAppError } from "../lib/error-presentation";
import { loadErrorDisplay } from "../lib/loadErrorDisplay";
import { sessionKeys } from "./queryKeys";
import { useIngestFlow } from "./useIngestFlow";
import { useTurnFlow, type LiveTurn } from "./useTurnFlow";
import { useViewedResult } from "./useViewedResult";
import { useWorkspaceCollapse } from "./useWorkspaceCollapse";
import type { ApprovalEntry } from "./useApprovalEvents";
import {
  deriveWorkspaceContent,
  type ViewedResult,
  type WorkspaceContent,
} from "./workspace";
import type { AppError, SessionFlowKind } from "../types/error";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  GuidanceRequest,
  SheetGuidance,
  StaleAnchor,
} from "../types/dataset";
import type { SaveError, TurnPhase } from "../types/session";
import type { ThreadEntry } from "../types/thread";

// Per-session state + actions (ADR-0051). The shell (<App>) creates the
// session id and renders <SessionPane key={sid} sessionId={sid} />; this hook
// owns everything inside: server state (workingSet / active / thread via
// TanStack Query) and client UI state (viewedResult / pinnedToHistory /
// loading / dialogs). The hook IS the ADR-0051 "per-tab component autonomy" --
// a future multi-session shell renders one SessionPane per open id and the
// keyed caches stay isolated by the `['session', sid, ...]` prefix.

// AppError / AppErrorKind / SessionFlowKind live in ../types/error (issue
// #194). The verb prefix logic ("{verb} failed:" / "{verb} saved, but
// refreshing ...") is module-internal to error-presentation (ADR-0069): every
// reject + the two post-mutation refresh rejects below reach it through the
// single kind-driven toAppError entry (refresh rejects pass { refreshFailed:
// true }).

// Module-level empty constants so `query.data ?? EMPTY` keeps a stable reference
// across renders while the query is still loading (avoids cascading re-renders
// in the useMemo/useCallback that consume `datasets` / `thread`).
const EMPTY_DATASETS: DatasetDescriptor[] = [];
const EMPTY_THREAD: ThreadEntry[] = [];

export interface UseSessionState {
  // Server state (ADR-0051): backend is truth.
  datasets: DatasetDescriptor[];
  activeName: string | null;
  thread: ThreadEntry[];
  // Derived from the working set (runtime truth, ADR-0051). Shared with the
  // rail's stale badges so the map is built once per session, not twice.
  staleByReference: ReadonlyMap<string, StaleAnchor>;
  // Client UI state.
  viewedResult: ViewedResult | null;
  workspaceContent: WorkspaceContent;
  /** ADR-0083 (issue #298): the workspace panel's fold. Cold-start collapsed;
   *  the first result_N promotion auto-expands once, then it is manual. */
  workspaceCollapsed: boolean;
  loading: boolean;
  /** The in-flight turn's latest progress event (ADR-0059): Thinking with the
   *  1-based step or the last tool-call event. null when no turn is running.
   *  Client UI state only -- never enters TanStack Query / the thread cache
   *  (ADR-0051 single truth: the thread holds completed TurnRecords; phase is
   *  a transient hint). Drives the QuestionBar's compact label. */
  phase: TurnPhase | null;
  /** The in-flight turn's live trace (ADR-0078, issue #297): the rail renders
   *  it as a progressive turn card (question + tool-call rows + approval
   *  cards). null when no turn is running. Client UI state only; folds into
   *  the optimistic TurnRecord.trace when the turn settles. */
  liveTurn: LiveTurn | null;
  error: AppError | null;
  /** The most recent per-turn save failure as a typed SaveError (issue #120),
   *  rendered via the locale catalog in the session pane's persist-warning
   *  banner. null after a clean save or once read. */
  persistError: SaveError | null;
  guidance: { request: GuidanceRequest; path: string } | null;
  /** Issue #748: the guided-submit failure rendered inline inside the
   *  GuidedLoadDialog (the workspace banner would sit behind the modal
   *  scrim). null outside a failed guided submit; cleared on re-submit /
   *  cancel / a freshly routed guidance. */
  guidanceError: AppError | null;
  /** Issue #748: files left unprocessed by a terminally halted batch
   *  (cancel-halt / Error-halt), rendered as a workspace notice; null
   *  otherwise and cleared at the start of the next ingest. */
  haltedRemaining: number | null;
  pendingActiveDelete: DatasetDescriptor | null;
  // Actions.
  // Mirrors UseTurnFlow (async -> Promise<void>, honest + awaitable); the
  // QuestionBar consumer accepts it via void-return covariance.
  handleAsk: (question: string) => Promise<void>;
  handleCancel: () => Promise<void>;
  handleIngest: (path: string) => void;
  /** Multi-file ingest from the composer "+" file section (ADR-0083, issue
   *  #351; #748 auto-resume). Sequential with park-on-guidance: a
   *  NeedsGuidance parks the batch on the dialog and the Promise stays
   *  pending until the guided Loaded resumes + drains the queue, or a cancel
   *  / Error halts terminally; see useIngestFlow. Resolves true when every
   *  file loaded (#500): the SessionPane's pending-payload consumption gates
   *  the cold-start auto-ask on it. The bar's handleIngestFiles consumer
   *  accepts it via void-return covariance. */
  handleIngestMany: (paths: string[]) => Promise<boolean>;
  handleGuidedSubmit: (sheetGuidance: SheetGuidance[]) => void;
  handleGuidedCancel: () => void;
  /** Preview-window pager feed for the GuidedLoadDialog (issue #750): rows
   *  [offset, offset + limit) of the parked workbook's sheet, served from
   *  the backend retention (zero re-parse per page). */
  fetchGuidanceWindow: (sheetName: string, offset: number, limit: number) => Promise<string[][]>;
  handleRename: (referenceName: string, newDisplay: string) => void;
  handleReplace: (referenceName: string, path: string) => void;
  handleDelete: (referenceName: string) => void;
  handleConfirmActiveDelete: (continueWith: string) => void;
  handleCancelActiveDelete: () => void;
  handlePrivacyChange: (
    referenceName: string,
    privacy: DatasetPrivacy,
  ) => void;
  handleSelectResult: (referenceName: string) => void;
  /** The session header's workspace fold toggle (ADR-0083, issue #298). */
  handleToggleWorkspace: () => void;
  clearError: () => void;
}

export function useSessionState(
  sessionId: string,
  /** This session's approval entries (the app-level useApprovalEvents slice,
   *  ADR-0083 / issue #297): merged into the live trace by useTurnFlow so a
   *  gated external call renders its in-flow card inside the turn. Undefined
   *  (not a fresh []) by default so the hook's stable-empty fallback keeps
   *  handleAsk's identity across renders. */
  approvals?: ReadonlyArray<ApprovalEntry>,
  /** Clears this session's approval entries once its turn settles (the
   *  resolved cards fold into the optimistic thread record). */
  onApprovalsSettled?: () => void,
  /** ADR-0089 Decision 4: called once after the session's FIRST terminal turn
   *  settles, so the shell can sync the auto-generated name into the sidebar
   *  + open-session header. Fires only when the thread had zero turns before
   *  this ask. Takes the sessionId so the shell can pass a useCallback-stable
   *  handler (an inline per-session arrow would rebuild handleAskWithAutoName
   *  on every App render -- ADR-0092's composer-fields report effect compares
   *  the reported handleAsk by reference, so an unstable identity loops the
   *  shell-level bar's fields registry). */
  onFirstTurnSettled?: (sessionId: string) => void,
): UseSessionState {
  const queryClient = useQueryClient();
  const intl = useIntl();

  // --- Server state (TanStack Query, ADR-0051) -----------------------------
  const workingSetQuery = useQuery({
    queryKey: sessionKeys.workingSet(sessionId),
    queryFn: () => listWorkingSet(sessionId),
  });
  const activeQuery = useQuery({
    queryKey: sessionKeys.active(sessionId),
    queryFn: () => activeDataset(sessionId),
  });
  const threadQuery = useQuery({
    queryKey: sessionKeys.thread(sessionId),
    queryFn: () => conversation(sessionId),
  });

  const datasets = workingSetQuery.data ?? EMPTY_DATASETS;
  const active = activeQuery.data ?? null;
  const activeName = active?.reference_name ?? null;
  const thread = threadQuery.data ?? EMPTY_THREAD;

  // --- Client UI state -----------------------------------------------------
  // viewedResult domain lives in useViewedResult (issue #229) -- see its header
  // for the boundary. workspaceContent derivation stays here (fusion below).
  const {
    viewedResult,
    pinnedToHistory,
    selectResult,
    markProduced,
    clearForNewSource,
    suppressInit,
  } = useViewedResult(thread);
  // Workspace fold (ADR-0083, issue #298): cold-start collapsed, the first
  // promotion auto-expands once, then purely manual. Session-ephemeral plain
  // state -- never persisted, reset on every pane mount (new / resume).
  const {
    workspaceCollapsed,
    expandWorkspace,
    toggleWorkspace,
    notePromotion,
  } = useWorkspaceCollapse();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [pendingActiveDelete, setPendingActiveDelete] =
    useState<DatasetDescriptor | null>(null);
  const [persistError, setPersistError] = useState<SaveError | null>(null);

  // --- Derived: stale map (working-set runtime truth, ADR-0051) + workspace ---
  const staleByReference = useMemo(() => {
    const m = new Map<string, StaleAnchor>();
    for (const d of datasets) if (d.stale) m.set(d.reference_name, d.stale);
    return m;
  }, [datasets]);

  const workspaceContent = useMemo(
    () => deriveWorkspaceContent(thread, viewedResult, pinnedToHistory, staleByReference),
    [thread, viewedResult, pinnedToHistory, staleByReference],
  );

  // --- Helpers -------------------------------------------------------------
  const pollPersistError = useCallback(async () => {
    try {
      setPersistError(await takePersistError(sessionId));
    } catch {
      // swallow -- persist-status polling must not surface its own failure.
    }
  }, [sessionId]);

  /** Invalidate the working-set + active + thread queries (post-mutation
   * refresh). A failure here surfaces as a distinct "saved but refresh failed"
   * error tagged with the operation kind, never a silent no-op. */
  const refreshServerState = useCallback(
    async (kind: SessionFlowKind): Promise<void> => {
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: sessionKeys.workingSet(sessionId) }),
          queryClient.invalidateQueries({ queryKey: sessionKeys.active(sessionId) }),
          queryClient.invalidateQueries({ queryKey: sessionKeys.thread(sessionId) }),
        ]);
      } catch (refreshErr) {
        setError(toAppError(refreshErr, intl, kind, { refreshFailed: true }));
      }
    },
    [queryClient, sessionId, intl],
  );

  // --- Actions -------------------------------------------------------------

  // Turn orchestration (handleAsk + handleCancel + phase) lives in useTurnFlow
  // (issue #230) -- the turn domain's "thread stays un-invalidated" rule is
  // distinct from the generic refreshServerState used by the ingest / dataset
  // mutations below. Driven through injected deps; this hook never reaches for
  // the raw queryClient / viewed setters for turn work.
  // A settled Materialized turn moves viewedResult (the useViewedResult seam)
  // AND spends the workspace's auto-expand one-shot (ADR-0083, issue #298):
  // the session's first result_N opens the panel with the produced dataset,
  // later promotions never steal focus. Composed here (not inside either
  // hook) so each hook keeps owning exactly one state domain.
  // INVARIANT: markProduced must run unconditionally before notePromotion --
  // notePromotion spends the one-shot whether or not viewedResult actually
  // moved, so any future guard inside markProduced would desync the two
  // ("one-shot spent but the workspace points nowhere"). useViewedResult's
  // markProduced is unconditional by contract; keep it so.
  const markProducedWithExpand = useCallback(
    (referenceName: string) => {
      markProduced(referenceName);
      notePromotion();
    },
    [markProduced, notePromotion],
  );
  const { phase, liveTurn, handleAsk, handleCancel } = useTurnFlow(sessionId, {
    queryClient,
    intl,
    setLoading,
    setError,
    pollPersistError,
    viewed: { markProduced: markProducedWithExpand, suppressInit },
    approvals,
    onApprovalsSettled,
  });

  // ADR-0089 Decision 4: wrap handleAsk so the first terminal turn triggers a
  // sidebar + header name sync. Reading the query cache directly (not the
  // reactive `thread`) keeps handleAsk's identity stable across renders -- the
  // original useTurnFlow handleAsk deliberately excludes thread from its deps.
  // The optimistic Turn append happens INSIDE handleAsk on the success path
  // only (the IPC-failure catch early-returns without appending), so checking
  // the cache AFTER the await distinguishes success from failure. After the
  // first turn, the name is never auto-changed again (the backend enforces
  // this in record_turn); subsequent turns never fire onFirstTurnSettled.
  const handleAskWithAutoName = useCallback(
    async (question: string) => {
      const key = sessionKeys.thread(sessionId);
      const hadTurns = (queryClient.getQueryData<ThreadEntry[]>(key) ?? []).some(
        (e) => e.entry === "Turn",
      );
      await handleAsk(question);
      // Fire only when this was the first turn AND it actually landed (the
      // optimistic append happened inside handleAsk on success). On IPC failure
      // handleAsk catches + returns without appending, so the cache is
      // unchanged and the guard correctly suppresses the callback.
      if (!hadTurns) {
        const after = queryClient.getQueryData<ThreadEntry[]>(key) ?? [];
        if (after.some((e) => e.entry === "Turn")) {
          onFirstTurnSettled?.(sessionId);
        }
      }
    },
    [handleAsk, queryClient, sessionId, onFirstTurnSettled],
  );

  // Ingest orchestration (handleIngest + handleIngestMany + handleGuidedSubmit
  // + handleGuidedCancel + guidance dialog state) lives in useIngestFlow
  // (issue #231) -- the ingest domain goes through the GENERIC refreshServerState
  // on a Loaded outcome (no optimistic thread append, so thread refresh is
  // harmless), the inverse of useTurnFlow above which must leave thread
  // un-invalidated. Driven through injected deps; this hook never reaches for
  // the raw guidance setter or the viewed setter for ingest work. Pending-ingest
  // consumption (#500) lives one level up in SessionPane, which sequences the
  // files BEFORE the pending question.
  const {
    guidance,
    guidanceError,
    haltedRemaining,
    handleIngest,
    handleIngestMany,
    handleGuidedSubmit,
    handleGuidedCancel,
    fetchGuidanceWindow,
  } = useIngestFlow(
    sessionId,
    {
      intl,
      setLoading,
      setError,
      refreshServerState,
      pollPersistError,
      viewed: { clearForNewSource },
    },
  );

  // Rename / privacy / delete share the simple mutation shape: call the API,
  // then refresh. Tagged per-kind so a refusal carries the right prefix.
  const runSimpleMutation = useCallback(
    async (kind: SessionFlowKind, fn: () => Promise<unknown>) => {
      setLoading(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(toAppError(e, intl, kind));
        setLoading(false);
        void pollPersistError();
        return;
      }
      await refreshServerState(kind);
      setLoading(false);
      void pollPersistError();
    },
    [refreshServerState, pollPersistError, intl],
  );

  const handleRename = useCallback(
    (referenceName: string, newDisplay: string) => {
      void runSimpleMutation("rename", () => renameDataset(sessionId, referenceName, newDisplay));
    },
    [runSimpleMutation, sessionId],
  );

  const handlePrivacyChange = useCallback(
    (referenceName: string, privacy: DatasetPrivacy) => {
      void runSimpleMutation("privacy", () =>
        setDatasetPrivacy(sessionId, referenceName, privacy),
      );
    },
    [runSimpleMutation, sessionId],
  );

  const handleReplace = useCallback(
    async (referenceName: string, path: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await replaceSource(sessionId, referenceName, path);
        if (result.kind === "Loaded") {
          await refreshServerState("replace");
        } else if (result.kind === "NeedsGuidance") {
          // Structured replace never yields NeedsGuidance; defensive guard.
          setError({
            message: intl.formatMessage({
              id: "error.flow.replaceNeedsGuidanceUnsupported",
              defaultMessage:
                "Replace source does not support files needing rectify guidance; use a structured file instead",
            }),
            kind: "replace",
            detail: null,
          });
        } else {
          setError({ ...loadErrorDisplay(result.data, intl), kind: "replace" });
        }
      } catch (e) {
        setError(toAppError(e, intl, "replace"));
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [sessionId, refreshServerState, pollPersistError, intl],
  );

  const handleRemoveSource = useCallback(
    (referenceName: string) => {
      void runSimpleMutation("delete", () => removeSource(sessionId, referenceName));
    },
    [runSimpleMutation, sessionId],
  );

  // Deleting the ACTIVE source while others remain routes through the confirm
  // dialog (issue #39 / ADR-0035 -- no silent focus jump). Any non-active
  // source, or the last active source, goes straight through removeSource.
  const handleDelete = useCallback(
    (referenceName: string) => {
      if (referenceName === activeName && datasets.length > 1) {
        const target = datasets.find((d) => d.reference_name === referenceName);
        if (target) {
          setPendingActiveDelete(target);
          return;
        }
      }
      handleRemoveSource(referenceName);
    },
    [activeName, datasets, handleRemoveSource],
  );

  const handleConfirmActiveDelete = useCallback(
    (continueWith: string) => {
      const target = pendingActiveDelete;
      if (!target) return;
      // Reuses runSimpleMutation (setLoading/setError/refresh/poll). The dialog
      // is closed inside fn so a removal failure leaves it open for retry.
      void runSimpleMutation("delete", async () => {
        await removeActiveSource(sessionId, target.reference_name, continueWith);
        setPendingActiveDelete(null);
      });
    },
    [pendingActiveDelete, sessionId, runSimpleMutation],
  );

  const handleCancelActiveDelete = useCallback(() => setPendingActiveDelete(null), []);

  // Rail result selection (preview card / result link, ADR-0083 issue #298):
  // moves viewedResult (the pin rule lives in useViewedResult) AND opens the
  // workspace when folded -- the rail and the panel are dual views of the same
  // dataset, so a rail selection must surface its panel half.
  // INVARIANT: callers must pass a referenceName that exists in the thread --
  // selectResult is unconditional, so a stale / foreign name would expand the
  // panel onto an empty workspace. Both current callers (result-link +
  // preview card) source the name from primary.dataset.reference_name, which
  // is always in-thread; add a guard here if that ever changes.
  const handleSelectResult = useCallback(
    (referenceName: string) => {
      selectResult(referenceName);
      expandWorkspace();
    },
    [selectResult, expandWorkspace],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    datasets,
    activeName,
    thread,
    staleByReference,
    viewedResult,
    workspaceContent,
    workspaceCollapsed,
    loading,
    phase,
    liveTurn,
    error,
    persistError,
    guidance,
    guidanceError,
    haltedRemaining,
    pendingActiveDelete,
    handleAsk: handleAskWithAutoName,
    handleCancel,
    handleIngest,
    handleIngestMany,
    handleGuidedSubmit,
    handleGuidedCancel,
    fetchGuidanceWindow,
    handleReplace,
    handleDelete,
    handleConfirmActiveDelete,
    handleCancelActiveDelete,
    handleRename,
    handlePrivacyChange,
    handleSelectResult,
    handleToggleWorkspace: toggleWorkspace,
    clearError,
  };
}
