import { useCallback, useRef, useState } from "react";
import type { IntlShape } from "react-intl";
import { ingestFile, ingestFileGuided } from "../api";
import { toAppError } from "../lib/error-presentation";
import { loadErrorDisplay } from "../lib/loadErrorDisplay";
import { log } from "../lib/log";
import type { UseViewedResult } from "./useViewedResult";
import type { AppError, SessionFlowKind } from "../types/error";
import type { GuidanceRequest, LoadOutcome, SheetGuidance } from "../types/dataset";

// The ingest-orchestration domain (issue #231), extracted from useSessionState
// (slice 3 of the three-slice deepening). This hook owns the guidance dialog
// state (NeedsGuidance route) and the three handlers that route a LoadOutcome:
// handleIngest (Loaded / NeedsGuidance / Error), handleGuidedSubmit
// (Loaded / Error / NeedsGuidance-recur), and handleGuidedCancel. The parent
// drives it through injected deps and never reaches for the raw viewed setter
// / refreshServerState from here.
//
// Issue #748 deepened the batch + guidance pairing:
// - Guided-submit failures (Error / NeedsGuidance-recur / IPC reject) land in
//   the dialog-dedicated guidanceError state, rendered inline above the dialog
//   footer -- NOT the shared setError banner, which the modal scrim hides.
// - A multi-file batch PARKS on NeedsGuidance instead of halting: the
//   handleIngestMany Promise stays pending (#500 gate: no auto-ask fires
//   underneath the dialog), and a guided Loaded auto-resumes the queued
//   remainder through the same LoadOutcome routing. Only a user cancel or an
//   Error route halts terminally; both surface the remaining-file count
//   (haltedRemaining) when files were left unprocessed.
//
// Pending-ingest consumption (#500): the drop-on-cold-start / cold-start file
// list consumption moved UP to SessionPane, which coordinates the two pending
// payloads (files ingest BEFORE the pending question fires); this hook stays a
// pure orchestrator the pane awaits through handleIngestMany's boolean return.
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
// handleIngest / handleIngestMany are the only paths that can route a
// NeedsGuidance (xlsx) result into the guidance dialog this hook owns --
// which is why the SessionPane's pending-payload consumption (#500) awaits
// handleIngestMany instead of calling ingestFile directly.

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
  /** Guided-submit failure dedicated to the dialog (issue #748): the Error /
   *  NeedsGuidance-recur / IPC-reject branches of handleGuidedSubmit write
   *  here INSTEAD of the shared setError, because the workspace banner sits
   *  behind the modal scrim and would be invisible. Rendered inline above the
   *  dialog footer. Cleared on re-submit, on cancel, and when a freshly
   *  routed guidance opens. */
  guidanceError: AppError | null;
  /** Files left unprocessed by a terminally halted batch (issue #748), or
   *  null. Set by the cancel-halt and Error-halt paths when files remain past
   *  the halt; rendered as a workspace notice (with the error banner on the
   *  Error-halt screen). Cleared at the start of the next ingest. */
  haltedRemaining: number | null;
  // Declared Promise<void> (not void) so the contract reflects the async
  // implementation: the cold-start drop effect fire-and-forgets it via `void`,
  // and external callers (WorkspaceResult onIngest) accept it through
  // TypeScript's void-return covariance once useSessionState re-exports it.
  handleIngest: (path: string) => Promise<void>;
  /** Multi-file ingest (ADR-0083, issue #351; #748 auto-resume): the composer
   *  "+" file section picks N files and hands them here. Files ingest
   *  SEQUENTIALLY through the same LoadOutcome routing as handleIngest; on a
   *  NeedsGuidance the batch PARKS (the guidance dialog opens) and the Promise
   *  stays PENDING -- a guided Loaded then resumes the queued remainder, while
   *  only a user cancel or an Error route halts terminally (both settle the
   *  Promise false and surface the remaining count). Resolves true when EVERY
   *  file loaded (#500): the SessionPane's pending-payload consumption gates
   *  the cold-start auto-ask on it -- while the dialog parks the batch the
   *  pending question must not fire underneath it. An IPC reject resolves
   *  false too (the error banner owns the same gate). An empty list resolves
   *  true (nothing to halt on). */
  handleIngestMany: (paths: string[]) => Promise<boolean>;
  handleGuidedSubmit: (sheetGuidance: SheetGuidance[]) => Promise<void>;
  handleGuidedCancel: () => void;
}

// Which route a single file's LoadOutcome took (issue #351): the batch
// continues only on Loaded; NeedsGuidance parks it on the guidance dialog and
// Error halts it terminally (see runBatchSegment, issue #748).
type IngestRoute = LoadOutcome["kind"];

// A multi-file batch parked on the guidance dialog (issue #748): `remaining`
// is the queue still to attempt once the guided file loads, and `resolve`
// keeps handleIngestMany's caller pending until the queue drains or the batch
// halts terminally (#500 gate). Held in a ref, not state: nothing renders off
// the queue itself -- the render-relevant projections are `guidance` (the
// dialog) and `haltedRemaining` (the halt count).
interface ParkedBatch {
  remaining: string[];
  resolve: (allLoaded: boolean) => void;
}

export function useIngestFlow(
  sessionId: string,
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
  const [guidanceError, setGuidanceError] = useState<AppError | null>(null);
  const [haltedRemaining, setHaltedRemaining] = useState<number | null>(null);
  const parkedBatchRef = useRef<ParkedBatch | null>(null);

  // Route ONE file's LoadOutcome into its side effects (issue #351 split):
  // - Loaded -> no side effect here (the caller refreshes + clears viewed).
  // - NeedsGuidance -> open the guidance dialog (this hook's state).
  // - Error -> loadErrorDisplay, tagged "load".
  // Returns the route kind so the caller decides refresh + (batch) continuation.
  const routeIngestOutcome = useCallback(
    (result: LoadOutcome, path: string): IngestRoute => {
      if (result.kind === "Loaded") {
        return "Loaded";
      } else if (result.kind === "NeedsGuidance") {
        // A fresh dialog opens clean (#748): a stale inline error from an
        // earlier guided submit must not ride into the next file's guidance
        // (the auto-resume re-park path makes this a live case, not just a
        // defensive one).
        setGuidanceError(null);
        setGuidance({ request: result.data, path });
        return "NeedsGuidance";
      } else if (result.kind === "Error") {
        setError({ ...loadErrorDisplay(result.data, intl), kind: "load" });
        return "Error";
      } else {
        // Exhaustiveness guard: LoadOutcome crosses IPC unchecked, so a
        // future backend variant must throw at the boundary rather than
        // silently fall through (mirrors loadErrorDisplay / toAppError).
        const unhandled: never = result;
        throw new Error(`unhandled LoadOutcome kind: ${JSON.stringify(unhandled)}`);
      }
    },
    [intl, setError],
  );

  // Terminal-halt surface (#748), shared by the Error/reject halt in
  // runBatchSegment and the cancel halt in handleGuidedCancel so both paths
  // stay in lockstep: the skipped count surfaces (the workspace notice,
  // screen-mate of the banner on an Error halt), the diagnostic carries the
  // halt reason, and the #500 gate settles false. ADR-0029: operation
  // semantics only, no source DATA -- the paths themselves are intentionally
  // not logged.
  const haltBatch = useCallback(
    (
      remaining: string[],
      reason: "error" | "reject" | "cancelled",
      resolve: (allLoaded: boolean) => void,
    ) => {
      if (remaining.length > 0) {
        setHaltedRemaining(remaining.length);
        log.warn("useIngestFlow", "batch halted; remaining files skipped", {
          reason,
          remaining: remaining.length,
        });
      }
      resolve(false);
    },
    [],
  );

  // Run ONE segment of a multi-file batch (issue #748 auto-resume split):
  // sequential ingestFile calls until the queue DRAINS, PARKS on
  // NeedsGuidance, or HALTS terminally (Error route / IPC reject). A segment
  // refreshes + clears viewed ONCE at its end when at least one file loaded
  // IN that segment -- the pre-park run and each post-guidance continuation
  // are separate segments. Settlement order matters: resolve runs AFTER the
  // refresh so the #500 gate's pending question can never race the
  // working-set invalidation. A PARK leaves the Promise pending: the batch
  // handle moves into parkedBatchRef for the post-Loaded resume.
  const runBatchSegment = useCallback(
    async (paths: string[], resolve: (allLoaded: boolean) => void): Promise<void> => {
      let loadedAny = false;
      // Paths not yet attempted. The loop head is consumed on EVERY route
      // (loaded, parked-on, or errored), so after a halt `unattempted` holds
      // exactly the files that never ran -> the halt count.
      let unattempted = paths;
      let outcome: "drained" | "parked" | "halted" = "drained";
      let haltReason: "error" | "reject" = "error";
      try {
        while (unattempted.length > 0) {
          const [path, ...rest] = unattempted;
          setLoading(true);
          let route: IngestRoute;
          try {
            route = routeIngestOutcome(await ingestFile(sessionId, path), path);
          } finally {
            setLoading(false);
          }
          unattempted = rest;
          if (route === "Loaded") {
            loadedAny = true;
            continue;
          }
          outcome = route === "NeedsGuidance" ? "parked" : "halted";
          break;
        }
      } catch (e) {
        // IPC reject mid-batch: the failing file is consumed like an Error
        // route (it failed; the rest never ran), and the banner owns the
        // shared error surface.
        setError(toAppError(e, intl, "load"));
        unattempted = unattempted.slice(1);
        haltReason = "reject";
        outcome = "halted";
      }
      if (loadedAny) {
        await refreshServerState("load");
        clearForNewSource();
      }
      if (outcome === "parked") {
        parkedBatchRef.current = { remaining: unattempted, resolve };
      } else if (outcome === "halted") {
        haltBatch(unattempted, haltReason, resolve);
      } else {
        resolve(true);
      }
      void pollPersistError();
    },
    [sessionId, routeIngestOutcome, haltBatch, refreshServerState, pollPersistError, intl, setLoading, setError, clearForNewSource],
  );

  // Load one source (PRD ingest entrypoint). Routes the LoadOutcome:
  // - Loaded -> generic refresh + clear viewed (a fresh source has no result).
  // - NeedsGuidance -> open the guidance dialog (this hook's state).
  // - Error -> loadErrorDisplay, tagged "load".
  const handleIngest = useCallback(
    async (path: string) => {
      // A fresh ingest supersedes the previous batch's halt notice (#748).
      setHaltedRemaining(null);
      setLoading(true);
      setError(null);
      try {
        const route = routeIngestOutcome(await ingestFile(sessionId, path), path);
        if (route === "Loaded") {
          await refreshServerState("load");
          // A freshly-added source has no result yet -> hero / active default.
          clearForNewSource();
        }
      } catch (e) {
        setError(toAppError(e, intl, "load"));
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [sessionId, routeIngestOutcome, refreshServerState, pollPersistError, intl, setLoading, setError, clearForNewSource],
  );

  // Load a multi-select batch (ADR-0083, issue #351; #748 auto-resume) -- see
  // the interface doc for the park / resume / halt semantics. The Promise is
  // minted here and settled by runBatchSegment: either synchronously within
  // this call (drained / Error halt) or later, after the guidance dialog
  // resolves the parked queue (handleGuidedSubmit / handleGuidedCancel).
  const handleIngestMany = useCallback(
    (paths: string[]): Promise<boolean> => {
      if (paths.length === 0) return Promise.resolve(true);
      // Defensive supersede (the modal dialog makes this unreachable through
      // the UI): settle a parked batch's stale #500 gate instead of leaking a
      // forever-pending Promise.
      if (parkedBatchRef.current !== null) {
        parkedBatchRef.current.resolve(false);
        parkedBatchRef.current = null;
      }
      setHaltedRemaining(null);
      setError(null);
      return new Promise<boolean>((resolve) => {
        void runBatchSegment(paths, resolve);
      });
    },
    [runBatchSegment, setError],
  );

  // Submit explicit header/skip picks from the guidance dialog. Loaded clears
  // the dialog + refreshes, then resumes the parked batch queue (#748); Error
  // and NeedsGuidance-recur keep the dialog open for retry with an INLINE
  // error (guidanceError -- the workspace banner would sit behind the modal
  // scrim). Re-submit clears any pending inline error first: a retry starts
  // clean.
  const handleGuidedSubmit = useCallback(
    async (sheetGuidance: SheetGuidance[]) => {
      if (!guidance) return;
      const { path } = guidance;
      setLoading(true);
      setError(null);
      setGuidanceError(null);
      let result: LoadOutcome;
      try {
        result = await ingestFileGuided(sessionId, path, sheetGuidance);
      } catch (e) {
        setGuidanceError(toAppError(e, intl, "load"));
        setLoading(false);
        void pollPersistError();
        return;
      }
      try {
        if (result.kind === "Loaded") {
          setGuidance(null);
          const parked = parkedBatchRef.current;
          parkedBatchRef.current = null;
          try {
            await refreshServerState("load");
            clearForNewSource();
            // Auto-resume (#748): the guided file loaded, so the queued
            // remainder continues through the same LoadOutcome routing --
            // re-parking on the next NeedsGuidance, halting on Error.
            if (parked !== null) {
              await runBatchSegment(parked.remaining, parked.resolve);
            }
          } catch (e) {
            // Past the Loaded the dialog is closed -- a failure here belongs
            // on the visible workspace banner again, and the parked batch's
            // #500 gate must settle (double-resolving a Promise is a no-op,
            // so this is safe even if runBatchSegment already settled it).
            if (parked !== null) parked.resolve(false);
            setError(toAppError(e, intl, "load"));
          }
        } else if (result.kind === "Error") {
          setGuidanceError({ ...loadErrorDisplay(result.data, intl), kind: "load" });
        } else if (result.kind === "NeedsGuidance") {
          // NeedsGuidance should not recur after an explicit header pick.
          setGuidanceError({
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
        // Only the exhaustiveness guard throws here; the dialog is still open,
        // so the failure surfaces inline like any guided-submit error instead
        // of escaping into an unhandled rejection.
        setGuidanceError(toAppError(e, intl, "load"));
      } finally {
        setLoading(false);
        void pollPersistError();
      }
    },
    [guidance, sessionId, runBatchSegment, refreshServerState, pollPersistError, intl, setLoading, setError, clearForNewSource],
  );

  // Cancel the guidance dialog. With a parked batch this is the cancel-halt
  // (#748): the queued remainder is dropped, its count surfaced, and the #500
  // gate settled false.
  const handleGuidedCancel = useCallback(() => {
    setGuidance(null);
    setGuidanceError(null);
    const parked = parkedBatchRef.current;
    if (parked !== null) {
      parkedBatchRef.current = null;
      haltBatch(parked.remaining, "cancelled", parked.resolve);
    }
  }, [haltBatch]);

  return {
    guidance,
    guidanceError,
    haltedRemaining,
    handleIngest,
    handleIngestMany,
    handleGuidedSubmit,
    handleGuidedCancel,
  };
}
