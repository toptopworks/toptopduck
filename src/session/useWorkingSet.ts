import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  activeDataset,
  listWorkingSet,
  previewDeleteImpact,
  readRows,
  removeActiveSource,
  removeSource,
  renameDataset,
  replaceSource,
  setDatasetPrivacy,
} from "../api";
import { toAppError } from "../lib/error-presentation";
import { loadErrorDisplay } from "../lib/loadErrorDisplay";
import { sessionKeys } from "./queryKeys";
import { resolveWorkingSetDetail } from "./workspace";
import type { AppError, SessionFlowKind } from "../types/error";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  DeleteImpactEntry,
  RowPage,
  StaleAnchor,
} from "../types/dataset";

// The working-set seam (ADR-0123): the single owner of the working-set
// domain -- its descriptor queries (workingSet / active / previewRows /
// deleteImpact), its four mutations (rename / replace / delete / privacy),
// the active-source delete state machine, the detail-pick resolution, and
// the post-mutation invalidation cascade. Consumers: the working-set container renders this
// hook directly (the pane passes it session addressing, the cross-domain
// busy gate, the empty card's ingest entry, and the mutation reporting
// surfaces -- nothing else); useSessionState renders the read slice below
// for the pane's own surfaces (rail badges, Targets chip, error
// aggregation, hero empties); useIngestFlow reaches the cascade through
// useSessionState's refreshServerState wrapper around the exported
// full-cascade entry (ingest stays an orchestration consumer, never an
// owner -- ADR-0123 Decision 3); useTurnFlow reaches the turn-end entry
// (invalidateSessionData) directly.
//
// Invalidation cascade (the authoritative narrative; previously dispersed
// across queryKeys doc comments and the callers' refresh helpers): every
// mutation fans out to the three session descriptors -- workingSet, active,
// thread. thread shares the fan-out even though this seam never observes it:
// source lifecycle events append to the thread, so a mutation without the
// thread refresh would leave the rail stale. The turn-end refresh joined the
// full cascade with ADR-0124 (issue #1088): the recorded row carries the
// settle-computed artifact manifest the optimistic append cannot know, and
// record_turn commits before `ask` resolves, so the refetch converges the
// append onto the authoritative row -- the #1080-era working-set-only
// divergence retired with it. The previewRows key NESTS
// under the workingSet prefix, so the workingSet invalidation refreshes the
// sample page alongside the descriptor -- with the app-wide staleTime
// Infinity (ADR-0051) a replaced source's cached rows would otherwise
// linger forever. The deleteImpact key nests the same way, so a reopened
// confirm dialog can never show a stale cascade list.
//
// Detail-pick resolution + preview gating: the pick (selectedName) arrives
// as a parameter -- the useState lives in the consuming component (ADR-0123
// Decision 2). Resolution is pick ?? active ?? first list item; the pick
// starts unset, so a fresh mount follows the active dataset until the user
// picks. The preview query's enabled gate keys on the RESOLVED pick, never
// on tab visibility or unmount -- both tab panels stay mounted across
// switches (issue #1060), so an unmount-based gate would never fire; a null
// pick on an empty set simply idles the query.
//
// Mutation surfaces are INJECTED (ADR-0123): the error banner, the busy
// union, and the persist poll stay pane-level -- the strip renders outside
// both tab panels, so a working-set mutation's failure stays visible
// whichever tab is active (issue #1060) -- and this seam reports through
// the same sinks useIngestFlow takes as deps. The seam itself owns no
// cross-domain UI state.

// Module-level empty constant so `query.data ?? EMPTY` keeps a stable
// reference across renders while the query is still loading (avoids
// cascading re-renders in the derivations that consume `datasets`).
const EMPTY_DATASETS: DatasetDescriptor[] = [];

/** The working-set read slice: the two descriptor queries plus their
 *  derivations. Single wiring site for the workingSet / active queries --
 *  useWorkingSet (below) and useSessionState's pane reads both consume this
 *  slice, sharing the same cache entries, never a second wiring. */
export interface WorkingSetData {
  datasets: DatasetDescriptor[];
  activeName: string | null;
  /** Stale map derived from the working set (runtime truth, ADR-0051):
   *  feeds the rail's stale badges + the workspace content derivation. */
  staleByReference: ReadonlyMap<string, StaleAnchor>;
  /** The slice's query errors in fixed order (workingSet -> active); empty
   *  while both are healthy. The pane composes thread's error after these
   *  (the session banner's aggregate order, issue #763). */
  queryErrors: ReadonlyArray<Error>;
  /** Refetch only the slice's errored queries -- the banner Retry's half;
   *  useSessionState composes the thread retry beside it. */
  retryFailed: () => void;
}

export function useWorkingSetData(sessionId: string): WorkingSetData {
  const workingSetQuery = useQuery({
    queryKey: sessionKeys.workingSet(sessionId),
    queryFn: () => listWorkingSet(sessionId),
  });
  const activeQuery = useQuery({
    queryKey: sessionKeys.active(sessionId),
    queryFn: () => activeDataset(sessionId),
  });

  const datasets = workingSetQuery.data ?? EMPTY_DATASETS;
  const activeName = activeQuery.data?.reference_name ?? null;

  const staleByReference = useMemo(() => {
    const m = new Map<string, StaleAnchor>();
    for (const d of datasets) if (d.stale) m.set(d.reference_name, d.stale);
    return m;
  }, [datasets]);

  const { error: workingSetError, refetch: refetchWorkingSet } = workingSetQuery;
  const { error: activeError, refetch: refetchActive } = activeQuery;
  const queryErrors = useMemo(() => {
    const errs: Error[] = [];
    if (workingSetError !== null) errs.push(workingSetError);
    if (activeError !== null) errs.push(activeError);
    return errs;
  }, [workingSetError, activeError]);
  const retryFailed = useCallback(() => {
    if (workingSetError !== null) void refetchWorkingSet();
    if (activeError !== null) void refetchActive();
  }, [workingSetError, refetchWorkingSet, activeError, refetchActive]);

  return { datasets, activeName, staleByReference, queryErrors, retryFailed };
}

const invalidateKeys = (
  queryClient: QueryClient,
  keys: ReadonlyArray<QueryKey>,
): Promise<void> =>
  Promise.all(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ).then(() => undefined);

/** The three-key fan-out every working-set mutation runs, the ingest
 *  domain's refreshServerState dep, AND the turn-end refresh (issue #1088)
 *  -- one undifferentiated cascade (ADR-0123 Decision 3: no kind labels
 *  here, they stay on the error wrappers). Error tagging stays with each
 *  consumer's error surface. */
export function invalidateSessionData(
  queryClient: QueryClient,
  sessionId: string,
): Promise<void> {
  return invalidateKeys(queryClient, [
    sessionKeys.workingSet(sessionId),
    sessionKeys.active(sessionId),
    sessionKeys.thread(sessionId),
  ]);
}

/** The live sample preview's fixed first window (issue #1061): the query's
 *  limit; the detail renderer shows exactly the page it returns. Lives with
 *  the query owner. Exported for the tests to pin. */
export const SAMPLE_ROW_LIMIT = 20;

/** The session-level mutation surfaces the seam reports into (ADR-0123) --
 *  the same sinks useIngestFlow takes as deps: the pane-level error banner
 *  (the strip that stays visible from both tabs, issue #1060), the busy
 *  union's mutation domain, and the persist poll. */
export interface UseWorkingSetSurfaces {
  setError: (error: AppError | null) => void;
  setMutationLoading: (loading: boolean) => void;
  pollPersistError: () => Promise<void>;
}

export interface UseWorkingSet {
  // Data plane.
  datasets: DatasetDescriptor[];
  activeName: string | null;
  /** The resolved detail target: the pick, else the active, else the first
   *  list item; null only while the set is empty. */
  shown: DatasetDescriptor | null;
  // Sample preview (issue #1061): the fetched first window, its in-flight
  // flag, and the raw read error (formatted one-line by the renderer).
  sample: RowPage | null;
  sampleLoading: boolean;
  sampleError: Error | null;
  // The active-source delete state machine (issue #39 / ADR-0035): non-null
  // mounts the confirm dialog; the renderer lives with this seam.
  pendingActiveDelete: DatasetDescriptor | null;
  // Mutations.
  handleRename: (referenceName: string, newDisplay: string) => void;
  handleReplace: (referenceName: string, path: string) => void;
  handleDelete: (referenceName: string) => void;
  handleConfirmActiveDelete: (continueWith: string) => void;
  handleCancelActiveDelete: () => void;
  handlePrivacyChange: (
    referenceName: string,
    privacy: DatasetPrivacy,
  ) => void;
}

export function useWorkingSet(
  sessionId: string,
  /** The working-set tab's own pick (which dataset's detail to show); the
   *  useState lives in the consuming component (ADR-0123 Decision 2). */
  selectedName: string | null,
  surfaces: UseWorkingSetSurfaces,
): UseWorkingSet {
  const queryClient = useQueryClient();
  const intl = useIntl();
  // Destructured out first (the useIngestFlow / useTurnFlow pattern): the
  // sinks are dispatch- or useCallback-stable inside useSessionState, while
  // the surfaces object itself is rebuilt per render -- depending on the
  // methods keeps the handler identities below stable across renders.
  const { setError, setMutationLoading, pollPersistError } = surfaces;

  const { datasets, activeName } = useWorkingSetData(sessionId);

  // Resolved once, above everything: the preview query's gate needs the
  // same resolved pick the detail pane renders, so there is exactly one
  // resolution.
  const shown = resolveWorkingSetDetail(datasets, selectedName, activeName);
  const referenceName = shown?.reference_name ?? null;

  // The live sample preview (issue #1061): one fixed first window of the
  // shown dataset through the paged read (ADR-0024). enabled:false with no
  // pick simply idles the query (the `?? ""` placeholders never execute: a
  // disabled query's queryFn never runs).
  const preview = useQuery({
    queryKey: sessionKeys.previewRows(sessionId, referenceName ?? ""),
    queryFn: () => readRows(sessionId, referenceName ?? "", 0, SAMPLE_ROW_LIMIT),
    enabled: referenceName !== null,
  });

  // --- Mutation domain state ------------------------------------------------
  // The active-source delete machine is seam-owned (its dialog renders with
  // the working-set surface, ADR-0123 Decision 4); every cross-domain
  // surface -- error, busy, persist -- reports through the injected sinks.
  const [pendingActiveDelete, setPendingActiveDelete] =
    useState<DatasetDescriptor | null>(null);

  /** Run the cascade and surface a refresh failure as a distinct
   *  "saved but refresh failed" error tagged with the operation kind --
   *  never a silent no-op. */
  const refreshServerState = useCallback(
    async (kind: SessionFlowKind): Promise<void> => {
      try {
        await invalidateSessionData(queryClient, sessionId);
      } catch (refreshErr) {
        setError(toAppError(refreshErr, intl, kind, { refreshFailed: true }));
      }
    },
    [queryClient, sessionId, intl, setError],
  );

  // Rename / privacy / delete share the simple mutation shape: call the API,
  // then refresh. Tagged per-kind so a refusal carries the right prefix.
  const runSimpleMutation = useCallback(
    async (kind: SessionFlowKind, fn: () => Promise<unknown>) => {
      setMutationLoading(true);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(toAppError(e, intl, kind));
        setMutationLoading(false);
        void pollPersistError();
        return;
      }
      await refreshServerState(kind);
      setMutationLoading(false);
      void pollPersistError();
    },
    [refreshServerState, pollPersistError, intl, setError, setMutationLoading],
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
      setMutationLoading(true);
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
        setMutationLoading(false);
        void pollPersistError();
      }
    },
    [sessionId, refreshServerState, pollPersistError, intl, setError, setMutationLoading],
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
      // Reuses runSimpleMutation (setMutationLoading/setError/refresh/poll).
      // The dialog is closed inside fn so a removal failure leaves it open
      // for retry.
      void runSimpleMutation("delete", async () => {
        await removeActiveSource(sessionId, target.reference_name, continueWith);
        setPendingActiveDelete(null);
      });
    },
    [pendingActiveDelete, sessionId, runSimpleMutation],
  );

  const handleCancelActiveDelete = useCallback(() => setPendingActiveDelete(null), []);

  return {
    datasets,
    activeName,
    shown,
    sample: preview.data ?? null,
    sampleLoading: preview.isLoading,
    sampleError: preview.error,
    pendingActiveDelete,
    handleRename,
    handleReplace,
    handleDelete,
    handleConfirmActiveDelete,
    handleCancelActiveDelete,
    handlePrivacyChange,
  };
}

// Same stable-reference rationale as EMPTY_DATASETS: the fallback must not
// mint a fresh array per render.
const EMPTY_IMPACT: DeleteImpactEntry[] = [];

/** The delete-confirm dialogs' cascade-impact preview (issue #1063): the live
 *  results a source removal would mark stale, read through the read-only IPC
 *  command (`preview_delete_impact`). The dialogs mount conditionally (Radix
 *  confirm dialogs) and always pass a non-null target, so the mount itself
 *  gates the query: with no dialog open the hook never mounts and nothing
 *  fetches.
 *
 *  Lives in the seam module per ADR-0123 Decision 1: a working-set-domain
 *  query (keyed under the workingSet prefix so the seam's invalidation
 *  cascade refreshes it) belongs with the seam's other queries, not beside
 *  its consumers.
 *
 *  Failure is not fatal by contract: the dialogs degrade to today's copy and
 *  the delete stays executable (the preview is a read-only convenience, never
 *  a single point of dependency for the removal). The error type is unknown
 *  by structure -- Tauri IPC rejects with the raw serialized error, which
 *  fmtError narrows -- unlike the Error-typed sampleError above. */
export function useDeleteImpact(
  sessionId: string,
  referenceName: string,
): {
  entries: DeleteImpactEntry[];
  isFetching: boolean;
  error: unknown;
} {
  const query = useQuery<DeleteImpactEntry[], unknown>({
    queryKey: sessionKeys.deleteImpact(sessionId, referenceName),
    queryFn: () => previewDeleteImpact(sessionId, referenceName),
  });
  return {
    entries: query.data ?? EMPTY_IMPACT,
    isFetching: query.isFetching,
    error: query.error,
  };
}
