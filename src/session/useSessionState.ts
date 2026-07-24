import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activeDataset,
  askQuestion,
  cancelQuery,
  conversation,
  ingestFile,
  ingestFileGuided,
  listWorkingSet,
  onTurnProgress,
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
import { useViewedResult } from "./useViewedResult";
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
  loading: boolean;
  /** The in-flight turn's discrete phase (ADR-0059): Thinking/Querying with a
   *  1-based attempt. null when no turn is running. Client UI state only --
   *  never enters TanStack Query / the thread cache (ADR-0051 single truth:
   *  the thread holds completed TurnRecords; phase is a transient hint). */
  phase: TurnPhase | null;
  error: AppError | null;
  /** The most recent per-turn save failure as a typed SaveError (issue #120),
   *  rendered via the locale catalog in the session pane's persist-warning
   *  banner. null after a clean save or once read. */
  persistError: SaveError | null;
  guidance: { request: GuidanceRequest; path: string } | null;
  pendingActiveDelete: DatasetDescriptor | null;
  // Actions.
  handleAsk: (question: string) => void;
  handleCancel: () => void;
  handleIngest: (path: string) => void;
  handleGuidedSubmit: (sheetGuidance: SheetGuidance[]) => void;
  handleGuidedCancel: () => void;
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
  clearError: () => void;
}

export function useSessionState(
  sessionId: string,
  pendingIngestPath: string | null = null,
  onIngestConsumed: () => void = () => {},
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
  // viewedResult domain (state + ADR-0062 R5 resume init + R2 pin rule) lives
  // in useViewedResult (issue #229): the parent drives it through semantic
  // methods (markProduced / clearForNewSource / selectResult / suppressInit)
  // and never touches a raw setter; the pin rule reads from one module. The
  // workspaceContent derivation stays here (cross-domain view fusion below).
  const {
    viewedResult,
    pinnedToHistory,
    selectResult,
    markProduced,
    clearForNewSource,
    suppressInit,
  } = useViewedResult(thread);
  const [loading, setLoading] = useState(false);
  // ADR-0059: the in-flight turn's discrete phase. Client UI state (NOT in
  // TanStack Query) -- it is a transient "in-progress" hint, lifecycle-distinct
  // from the completed TurnRecord thread cache (ADR-0051). Updated by the long
  // listener below; cleared in handleAsk's finally on every outcome (incl.
  // Cancelled).
  const [phase, setPhase] = useState<TurnPhase | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [guidance, setGuidance] = useState<{ request: GuidanceRequest; path: string } | null>(null);
  const [pendingActiveDelete, setPendingActiveDelete] =
    useState<DatasetDescriptor | null>(null);
  const [persistError, setPersistError] = useState<SaveError | null>(null);

  // ADR-0059 C-4: a LONG-LIVED turn-progress listener -- mount listen once,
  // unmount unlisten. Reused across ALL turns (NOT a per-turn listen, which
  // would amplify a subscribe-before-ask race + cost one IPC per turn). The
  // global Tauri broadcast is filtered to this pane's sessionId so a sibling
  // pane's phase never leaks in. On unmount (close tab, ADR-0055) the cleanup
  // unlistens + the phase state is destroyed; any orphan event from the
  // in-flight turn has no listener and is harmlessly dropped.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void onTurnProgress((ev) => {
      if (!active || ev.session_id !== sessionId) return;
      setPhase(ev.phase);
    }).then((un) => {
      // If the effect already cleaned up before listen resolved, unlisten
      // immediately so the orphan callback cannot fire setPhase post-unmount.
      if (!active) {
        un();
        return;
      }
      unlisten = un;
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [sessionId]);

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

  // Ask one question (PRD #1): run one turn -> one ADR-0028 outcome. On
  // success the new turn is optimistically appended to the thread cache
  // (ADR-0051) so the user sees it before the background refetch reconciles;
  // a Materialized outcome additionally moves viewedResult (auto-selects) and
  // invalidates workingSet + active (a new result_N registered server-side).
  const handleAsk = useCallback(
    async (question: string) => {
      setLoading(true);
      setError(null);
      let outcome;
      try {
        outcome = await askQuestion(sessionId, question);
      } catch (e) {
        setError(toAppError(e, intl, "ask"));
        setLoading(false);
        void pollPersistError();
        return;
      } finally {
        // ADR-0059: clear phase on every ask end (incl. Cancelled outcome /
        // IPC failure) -- the in-flight turn is done. Loading stays on through
        // the post-outcome invalidation below; phase is a turn-lifecycle hint,
        // not a UI-busy flag.
        setPhase(null);
      }
      // Optimistic thread append (ADR-0051): the outcome object is the same
      // shape the backend recorded, so the appended entry matches the refetch.
      const newEntry: ThreadEntry = {
        entry: "Turn",
        data: { question, outcome },
      };
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread(sessionId), (old) =>
        old ? [...old, newEntry] : [newEntry],
      );
      suppressInit(); // the user has acted; the R5 init is moot.
      if (outcome.kind === "Materialized") {
        const referenceName = outcome.data.dataset.reference_name;
        // Auto-selects + pin resets (ADR-0062 R2 "new-turn produce -> pinned=false"):
        // the pin rule is encapsulated in useViewedResult (issue #229).
        markProduced(referenceName);
        // ADR-0051: the optimistic thread append IS the thread truth (the
        // outcome object is the same shape the backend recorded), so the thread
        // query is NOT invalidated -- invalidating would wipe the appended entry
        // against a stale/empty refetch. Only workingSet + active change (a new
        // result_N registered server-side + active may have moved).
        // Guarded so a refresh failure surfaces as a tagged error instead of
        // skipping setLoading(false) below (which would lock QuestionBar
        // forever). Mirrors refreshServerState's "saved but refresh failed"
        // contract; thread stays un-invalidated to preserve the optimistic
        // append.
        try {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: sessionKeys.workingSet(sessionId) }),
            queryClient.invalidateQueries({ queryKey: sessionKeys.active(sessionId) }),
          ]);
        } catch (refreshErr) {
          setError(toAppError(refreshErr, intl, "ask", { refreshFailed: true }));
        }
      }
      // Textual / Failed / Cancelled: no working-set change; the optimistic
      // append is the thread state, nothing to invalidate.
      setLoading(false);
      void pollPersistError();
    },
    [sessionId, queryClient, pollPersistError, intl, markProduced, suppressInit],
  );

  const handleCancel = useCallback(async () => {
    try {
      await cancelQuery(sessionId);
    } catch (e) {
      setError(toAppError(e, intl, "ask"));
    }
  }, [sessionId, intl]);

  const handleIngest = useCallback(
    async (path: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await ingestFile(sessionId, path);
        if (result.kind === "Loaded") {
          await refreshServerState("load");
          // A freshly-added source has no result yet -> hero / active default.
          clearForNewSource();
        } else if (result.kind === "NeedsGuidance") {
          setGuidance({ request: result.data, path });
        } else {
          setError({ ...loadErrorDisplay(result.data, intl), kind: "load" });
        }
      } catch (e) {
        setError(toAppError(e, intl, "load"));
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [sessionId, refreshServerState, pollPersistError, intl, clearForNewSource],
  );

  // Consume a drop-on-cold-start file (ADR-0061, #81 A1). The shell mints the
  // session on drop but defers the actual ingest to here -- handleIngest is the
  // only path that can route a NeedsGuidance (xlsx) result into the guidance
  // dialog this hook owns. Dedup by path so each distinct dropped file ingests
  // exactly once while a repeat of the SAME path (a React StrictMode dev
  // double-invoke, or a remount before the shell clears the prop) is a no-op.
  // The shell clears the prop via onIngestConsumed once ingest kicks off.
  const consumedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingIngestPath) return;
    if (consumedRef.current === pendingIngestPath) return;
    consumedRef.current = pendingIngestPath;
    const path = pendingIngestPath;
    onIngestConsumed();
    void handleIngest(path);
  }, [pendingIngestPath, handleIngest, onIngestConsumed]);

  const handleGuidedSubmit = useCallback(
    async (sheetGuidance: SheetGuidance[]) => {
      if (!guidance) return;
      const { path } = guidance;
      setLoading(true);
      setError(null);
      try {
        const result = await ingestFileGuided(sessionId, path, sheetGuidance);
        if (result.kind === "Loaded") {
          setGuidance(null);
          await refreshServerState("load");
          clearForNewSource();
        } else if (result.kind === "Error") {
          setError({ ...loadErrorDisplay(result.data, intl), kind: "load" });
        } else {
          // NeedsGuidance should not recur after an explicit header pick.
          setError({
            message: intl.formatMessage({
              id: "error.flow.guidedStillNeedsGuidance",
              defaultMessage:
                "The worksheet still cannot be rectified; adjust the header selection and retry",
            }),
            kind: "load",
            detail: null,
          });
        }
      } catch (e) {
        setError(toAppError(e, intl, "load"));
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [guidance, sessionId, refreshServerState, pollPersistError, intl, clearForNewSource],
  );

  const handleGuidedCancel = useCallback(() => setGuidance(null), []);

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

  const clearError = useCallback(() => setError(null), []);

  return {
    datasets,
    activeName,
    thread,
    staleByReference,
    viewedResult,
    workspaceContent,
    loading,
    phase,
    error,
    persistError,
    guidance,
    pendingActiveDelete,
    handleAsk,
    handleCancel,
    handleIngest,
    handleGuidedSubmit,
    handleGuidedCancel,
    handleReplace,
    handleDelete,
    handleConfirmActiveDelete,
    handleCancelActiveDelete,
    handleRename,
    handlePrivacyChange,
    handleSelectResult: selectResult,
    clearError,
  };
}
