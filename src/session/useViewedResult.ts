import { useCallback, useEffect, useRef, useState } from "react";
import { findLatestMaterializedPrimary, type ViewedResult } from "./workspace";
import type { ThreadEntry } from "../types/thread";

// The viewedResult domain (state + ADR-0062 R5 resume init), extracted from
// useSessionState (issue #229). The parent drives it through the five
// semantic methods below and never touches the raw setters or viewedInitRef,
// so the rules read from one module, not three call sites. Boundary is STATE
// OWNERSHIP (viewedResult alone -- ADR-0114 retired the last-turn pin flag
// that used to travel with it; whether the view is on the latest result is a
// derived fact, not a state), not action domain -- the shared viewedInitRef
// (R5 init + handleAsk suppress) stays inside one hook.
//
// `thread` is injected: R5 scans it for the last Materialized on resume.
// The workspaceContent derivation stays in the parent (it fuses thread +
// viewed + the working-set stale map), so this hook takes no staleByReference.

export interface UseViewedResult {
  viewedResult: ViewedResult | null;
  /** Rail click on a Materialized result (ADR-0047 + ADR-0114): moves ONLY
   *  viewedResult, never the backend active pointer. No pin state. */
  selectResult: (referenceName: string) => void;
  /** Turn Materialized auto-selects: the view follows the produced result
   *  (ADR-0062 R2 "new-turn produce -> selected"). */
  markProduced: (referenceName: string) => void;
  /** Ingest / guided Loaded: a fresh source has no result yet -> hero (ADR-0062 R2). */
  clearForNewSource: () => void;
  /** A turn was appended (any outcome): the R5 resume init is moot (ADR-0062 R5). */
  suppressInit: () => void;
  /** The "back to latest" exit (issue #757): moves viewedResult to the latest
   *  Materialized turn's primary; falls back to hero (null) when the thread
   *  materialized no primary. Shares the find with the R5 resume landing. */
  jumpToLatest: () => void;
}

export function useViewedResult(thread: ThreadEntry[]): UseViewedResult {
  const [viewedResult, setViewedResult] = useState<ViewedResult | null>(null);

  // R5 (ADR-0062): the first time the thread resolves WITH content, point
  // viewedResult at its last Materialized turn (resume lands on the prior
  // working position). Fresh sessions (empty thread) stay on hero until the
  // user's first ask. Guarded by a ref so it runs at most once per mount.
  const viewedInitRef = useRef(false);
  useEffect(() => {
    if (viewedInitRef.current || thread.length === 0) return;
    viewedInitRef.current = true;
    // ADR-0084: view the turn's primary result (the promotion chain's tail --
    // the answer the question produced).
    const latest = findLatestMaterializedPrimary(thread);
    // External system -> state: the injected thread (resume query data) seeds
    // the initial view once; a legitimate one-shot init, not derived churn.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (latest !== null) setViewedResult({ referenceName: latest });
  }, [thread]);

  // ADR-0047 + ADR-0114 (rail click): moves ONLY viewedResult (never the
  // backend active). No pin flag anymore -- the workspace is inert to
  // non-materialized turns, so a history view holds on its own until a new
  // Materialized or another selection moves it.
  const selectResult = useCallback((referenceName: string) => {
    setViewedResult({ referenceName });
  }, []);

  // Turn Materialized auto-selects (ADR-0062 R2 "new-turn produce ->
  // selected"): the just-produced result becomes the viewed result, so a prior
  // history view never outlives a new turn.
  const markProduced = useCallback((referenceName: string) => {
    setViewedResult({ referenceName });
  }, []);

  // A freshly added source has no result yet -> hero (ADR-0062 R2 "source
  // loaded, not yet asked" hero extension).
  const clearForNewSource = useCallback(() => {
    setViewedResult(null);
  }, []);

  // Called by the parent's handleAsk after the optimistic thread append (any
  // outcome): the user has acted, so the R5 resume init must not fire later
  // even if the thread query resolves with content afterward.
  const suppressInit = useCallback(() => {
    viewedInitRef.current = true;
  }, []);

  // The "back to latest" exit (issue #757): the history indicator's action.
  // Same move semantics as selectResult (viewedResult only, never the backend
  // active) with the target derived from the thread. The no-primary fallback
  // is unreachable through the UI (the exit only renders while a result is
  // showing) but keeps the move total.
  const jumpToLatest = useCallback(() => {
    const latest = findLatestMaterializedPrimary(thread);
    setViewedResult(latest !== null ? { referenceName: latest } : null);
  }, [thread]);

  return {
    viewedResult,
    selectResult,
    markProduced,
    clearForNewSource,
    suppressInit,
    jumpToLatest,
  };
}
