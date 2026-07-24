import { useCallback, useEffect, useRef, useState } from "react";
import { lastTurnEntry, type ViewedResult } from "./workspace";
import type { ThreadEntry } from "../types/thread";

// The viewedResult domain (state + ADR-0062 R5 resume init + R2 pin rule),
// extracted from useSessionState (issue #229). The parent drives it through
// the four semantic methods below and never touches the raw setters or
// viewedInitRef, so the pin rule reads from one module, not three call sites.
// Boundary is STATE OWNERSHIP (viewedResult + pinnedToHistory travel
// together), not action domain -- the shared viewedInitRef (R5 init +
// handleAsk suppress) stays inside one hook.
//
// `thread` is injected: R5 scans it for the last Materialized on resume, and
// selectResult tests "is the clicked ref the last Materialized?" against it.
// The workspaceContent derivation stays in the parent (it fuses thread +
// viewed + the working-set stale map), so this hook takes no staleByReference.

export interface UseViewedResult {
  viewedResult: ViewedResult | null;
  pinnedToHistory: boolean;
  /** Rail click on a Materialized result (ADR-0047 + ADR-0062 R2 pin rule). */
  selectResult: (referenceName: string) => void;
  /** Turn Materialized auto-selects: view follows, pin resets to false (ADR-0062 R2). */
  markProduced: (referenceName: string) => void;
  /** Ingest / guided Loaded: a fresh source has no result yet -> hero (ADR-0062 R2). */
  clearForNewSource: () => void;
  /** A turn was appended (any outcome): the R5 resume init is moot (ADR-0062 R5). */
  suppressInit: () => void;
}

export function useViewedResult(thread: ThreadEntry[]): UseViewedResult {
  const [viewedResult, setViewedResult] = useState<ViewedResult | null>(null);
  const [pinnedToHistory, setPinnedToHistory] = useState(false);

  // R5 (ADR-0062): the first time the thread resolves WITH content, point
  // viewedResult at its last Materialized turn (resume lands on the prior
  // working position). Fresh sessions (empty thread) stay on hero until the
  // user's first ask. Guarded by a ref so it runs at most once per mount.
  const viewedInitRef = useRef(false);
  useEffect(() => {
    if (viewedInitRef.current || thread.length === 0) return;
    viewedInitRef.current = true;
    for (let i = thread.length - 1; i >= 0; i--) {
      const entry = thread[i];
      if (entry.entry === "Turn" && entry.data.outcome.kind === "Materialized") {
        setViewedResult({
          referenceName: entry.data.outcome.data.dataset.reference_name,
        });
        setPinnedToHistory(false);
        return;
      }
    }
  }, [thread]);

  // ADR-0047 + ADR-0062 R2 (rail click): moves ONLY viewedResult (never the
  // backend active). A non-last Materialized pins so the viewed result holds
  // even if the last turn is a textual B/C/D; the last Materialized un-pins
  // (it IS the current working position). The thread is the single source of
  // truth for "which ref did the last turn produce" (ADR-0051).
  const selectResult = useCallback(
    (referenceName: string) => {
      setViewedResult({ referenceName });
      const last = lastTurnEntry(thread);
      const isLastMaterialized =
        last !== null &&
        last.outcome.kind === "Materialized" &&
        last.outcome.data.dataset.reference_name === referenceName;
      setPinnedToHistory(!isLastMaterialized);
    },
    [thread],
  );

  // Turn Materialized auto-selects (ADR-0062 R2 "new-turn produce -> pinned=false"): the
  // just-produced result becomes the viewed result and pin resets, so a prior
  // pinned history view never outlives a new turn.
  const markProduced = useCallback((referenceName: string) => {
    setViewedResult({ referenceName });
    setPinnedToHistory(false);
  }, []);

  // A freshly added source has no result yet -> hero / active default (ADR-0062
  // R2 "source loaded, not yet asked" hero extension). Pin resets so a stale history pin does
  // not survive a source load.
  const clearForNewSource = useCallback(() => {
    setViewedResult(null);
    setPinnedToHistory(false);
  }, []);

  // Called by the parent's handleAsk after the optimistic thread append (any
  // outcome): the user has acted, so the R5 resume init must not fire later
  // even if the thread query resolves with content afterward.
  const suppressInit = useCallback(() => {
    viewedInitRef.current = true;
  }, []);

  return {
    viewedResult,
    pinnedToHistory,
    selectResult,
    markProduced,
    clearForNewSource,
    suppressInit,
  };
}
