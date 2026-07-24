import { useCallback, useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { IntlShape } from "react-intl";
import { askQuestion, cancelQuery, onTurnProgress } from "../api";
import { toAppError } from "../lib/error-presentation";
import { sessionKeys } from "./queryKeys";
import type { UseViewedResult } from "./useViewedResult";
import type { AppError } from "../types/error";
import type { TurnPhase } from "../types/session";
import type { ThreadEntry } from "../types/thread";

// The turn-orchestration domain (issue #230), extracted from useSessionState
// (slice 2 of the three-slice deepening). This hook owns the phase lifecycle
// (ADR-0059 discrete feedback) + handleAsk + handleCancel -- the three
// turn-specific pieces that were inlined in the parent. The parent drives it
// through injected deps and never reaches for the raw queryClient / viewed
// setters from here.
//
// Boundary is TURN ORCHESTRATION, not the generic post-mutation refresh.
// handleAsk's Materialized branch invalidates workingSet + active DIRECTLY via
// the injected queryClient and deliberately skips the thread -- invalidating
// thread would wipe the optimistic append against a stale/empty refetch
// (ADR-0051). That "thread stays un-invalidated" rule is turn-unique: ingest /
// dataset mutations go through the parent's refreshServerState (which DOES
// refresh thread, harmless for them); turn cannot. The deps therefore do NOT
// include refreshServerState -- the interface honestly reflects "turn does not
// use the generic refresh".

export interface UseTurnFlowDeps {
  queryClient: QueryClient;
  intl: IntlShape;
  setLoading: (loading: boolean) => void;
  setError: (error: AppError | null) => void;
  pollPersistError: () => Promise<void>;
  /** The two viewed methods a turn touches (issue #229). markProduced on a
   *  Materialized outcome (auto-select + pin reset); suppressInit after the
   *  optimistic append (any outcome, R5 moot). The hook never touches raw
   *  viewed state -- only these two semantic methods. */
  viewed: Pick<UseViewedResult, "markProduced" | "suppressInit">;
}

export interface UseTurnFlow {
  /** The in-flight turn's discrete phase (ADR-0059): Thinking/Querying with a
   *  1-based attempt. null when no turn is running. Client UI state only. */
  phase: TurnPhase | null;
  handleAsk: (question: string) => void;
  handleCancel: () => void;
}

export function useTurnFlow(sessionId: string, deps: UseTurnFlowDeps): UseTurnFlow {
  const { queryClient, intl, setLoading, setError, pollPersistError, viewed } = deps;
  // Pull the two stable viewed methods out of the injected `viewed` object so
  // the handleAsk dep array stays identity-stable: the parent rebuilds the
  // `viewed` object every render, but the methods inside are useCallback-stable
  // (issue #229), so destructuring here lets handleAsk keep its prior identity
  // across renders instead of rebuilding on every parent render.
  const { markProduced, suppressInit } = viewed;
  const [phase, setPhase] = useState<TurnPhase | null>(null);

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
    [sessionId, queryClient, pollPersistError, intl, setLoading, setError, markProduced, suppressInit],
  );

  // Cancel is the abort of ask -- a turn-domain semantic, so it lives here
  // alongside handleAsk, not with the ingest/dataset mutations.
  const handleCancel = useCallback(async () => {
    try {
      await cancelQuery(sessionId);
    } catch (e) {
      setError(toAppError(e, intl, "ask"));
    }
  }, [sessionId, intl, setError]);

  return { phase, handleAsk, handleCancel };
}
