import { useCallback, useEffect, useRef, useState } from "react";
import type { IntlShape } from "react-intl";
import { ingestFile, ingestFileGuided } from "../api";
import { toAppError } from "../lib/error-presentation";
import { loadErrorDisplay } from "../lib/loadErrorDisplay";
import type { UseViewedResult } from "./useViewedResult";
import type { AppError, SessionFlowKind } from "../types/error";
import type { GuidanceRequest, SheetGuidance } from "../types/dataset";

// The ingest-orchestration domain (issue #231), extracted from useSessionState
// (slice 3 of the three-slice deepening). This hook owns the guidance dialog
// state (NeedsGuidance route), the drop-on-cold-start consumption dedup
// (ADR-0061), and the three handlers that route a LoadOutcome: handleIngest
// (Loaded / NeedsGuidance / Error), handleGuidedSubmit (Loaded / Error /
// NeedsGuidance-recur), and handleGuidedCancel. The parent drives it through
// injected deps and never reaches for the raw viewed setter / refreshServerState
// from here.
//
// Boundary is INGEST ORCHESTRATION, which -- unlike the turn domain (useTurnFlow,
// issue #230) -- goes through the parent's GENERIC refreshServerState on a Loaded
// outcome. The difference is honest: ingest never optimistic-appends the thread,
// so invalidating thread cannot wipe an in-flight append (ADR-0051's turn-unique
// risk does not apply here). refreshServerState therefore IS in the deps, where
// useTurnFlow deliberately omits it. A Loaded outcome additionally calls
// viewed.clearForNewSource (a fresh source has no result yet -> hero, ADR-0062
// R2); the hook touches ONLY that semantic method, never the raw viewed state.
//
// handleIngest is also the single path that can route a NeedsGuidance (xlsx)
// result into the guidance dialog this hook owns -- which is why the cold-start
// drop effect (ADR-0061) calls handleIngest instead of a bare ingestFile.

export interface UseIngestFlowDeps {
  intl: IntlShape;
  setLoading: (loading: boolean) => void;
  setError: (error: AppError | null) => void;
  /** The generic post-mutation refresh (workingSet + active + thread). ingest
   *  has no optimistic append, so refreshing thread is harmless -- the inverse
   *  of useTurnFlow, which must skip it (ADR-0051). */
  refreshServerState: (kind: SessionFlowKind) => Promise<void>;
  pollPersistError: () => Promise<void>;
  /** The one viewed method an ingest touches (issue #229): clearForNewSource on
   *  a Loaded outcome (setViewedResult(null) + pin=false). The hook never
   *  touches raw viewed state. */
  viewed: Pick<UseViewedResult, "clearForNewSource">;
}

export interface UseIngestFlow {
  /** The open guidance dialog state (NeedsGuidance route), or null. Renders the
   *  GuidedLoadDialog in the session pane; the { request, path } pair carries
   *  the workbook sheets to preview + the original path to feed back into
   *  ingestFileGuided. */
  guidance: { request: GuidanceRequest; path: string } | null;
  // Declared Promise<void> (not void) so the contract reflects the async
  // implementation: the cold-start drop effect fire-and-forgets it via `void`,
  // and external callers (WorkspaceResult onIngest) accept it through
  // TypeScript's void-return covariance once useSessionState re-exports it.
  handleIngest: (path: string) => Promise<void>;
  handleGuidedSubmit: (sheetGuidance: SheetGuidance[]) => Promise<void>;
  handleGuidedCancel: () => void;
}

export function useIngestFlow(
  sessionId: string,
  pendingIngestPath: string | null,
  onIngestConsumed: () => void,
  deps: UseIngestFlowDeps,
): UseIngestFlow {
  const { intl, setLoading, setError, refreshServerState, pollPersistError, viewed } = deps;
  // Pull the single stable viewed method out of the injected `viewed` object so
  // the handler dep arrays stay identity-stable: the parent rebuilds `viewed`
  // every render, but the method inside is useCallback-stable (issue #229).
  // setLoading / setError are also listed in the dep arrays below -- both are
  // useState-dispatch-stable, but listing them satisfies exhaustive-deps now
  // that they arrive via injection (mirrors useTurnFlow, issue #230) and does
  // not change handler identity.
  const { clearForNewSource } = viewed;
  const [guidance, setGuidance] = useState<{ request: GuidanceRequest; path: string } | null>(null);

  // Load one source (PRD ingest entrypoint). Routes the LoadOutcome:
  // - Loaded -> generic refresh + clear viewed (a fresh source has no result).
  // - NeedsGuidance -> open the guidance dialog (this hook's state).
  // - Error -> loadErrorDisplay, tagged "load".
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
        } else if (result.kind === "Error") {
          setError({ ...loadErrorDisplay(result.data, intl), kind: "load" });
        } else {
          // Exhaustiveness guard: LoadOutcome crosses IPC unchecked, so a
          // future backend variant must throw at the boundary rather than
          // silently fall through (mirrors loadErrorDisplay / toAppError).
          const unhandled: never = result;
          throw new Error(`unhandled LoadOutcome kind: ${JSON.stringify(unhandled)}`);
        }
      } catch (e) {
        setError(toAppError(e, intl, "load"));
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [sessionId, refreshServerState, pollPersistError, intl, setLoading, setError, clearForNewSource],
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

  // Submit explicit header/skip picks from the guidance dialog. Loaded clears
  // the dialog + refreshes; Error keeps it open for retry; a NeedsGuidance recur
  // is unexpected after an explicit pick and surfaces a dedicated locale message.
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
        } else if (result.kind === "NeedsGuidance") {
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
        } else {
          // Exhaustiveness guard (see handleIngest above).
          const unhandled: never = result;
          throw new Error(`unhandled LoadOutcome kind: ${JSON.stringify(unhandled)}`);
        }
      } catch (e) {
        setError(toAppError(e, intl, "load"));
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [guidance, sessionId, refreshServerState, pollPersistError, intl, setLoading, setError, clearForNewSource],
  );

  const handleGuidedCancel = useCallback(() => setGuidance(null), []);

  return { guidance, handleIngest, handleGuidedSubmit, handleGuidedCancel };
}
