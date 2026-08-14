import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { IntlShape } from "react-intl";
import { askQuestion, cancelQuery, onTurnProgress } from "../api";
import { toAppError } from "../lib/error-presentation";
import { sessionKeys } from "./queryKeys";
import type { ApprovalEntry } from "./useApprovalEvents";
import type { UseViewedResult } from "./useViewedResult";
import type { AppError } from "../types/error";
import type { ApprovalResponse, OperationKind } from "../types/approval";
import type { TurnPhase } from "../types/session";
import type { ThreadEntry, TraceEntry } from "../types/thread";

// The turn-orchestration domain (issue #230), extracted from useSessionState
// (slice 2 of the three-slice deepening). This hook owns the turn-progress
// event lifecycle + the in-flight turn's LIVE TRACE (ADR-0078, issue #297) +
// handleAsk + handleCancel. The parent drives it through injected deps and
// never reaches for the raw queryClient / viewed setters from here.
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

// Module-level empty constants keep the optional deps' defaults referentially
// stable across renders (the useMemo over live state must not recompute on an
// every-render fresh []).
const NO_APPROVALS: ApprovalEntry[] = [];
const NO_ROWS: LiveTraceRow[] = [];

/** One in-flight tool call as the turn-progress stream reports it: started
 *  (running spinner) then completed (success/failure + excerpt). The completed
 *  fields mirror the TraceEntry wire shape (the ToolCallCompleted payload), so
 *  a settled turn's optimistic record carries exactly what the backend
 *  recorded. */
export interface LiveCall {
  /** Stable render key: arrival order (`call-0`, `call-1`, ...). */
  key: string;
  name: string;
  operationKind: OperationKind;
  summary: string;
  running: boolean;
  /** null until the completion event lands (a running dispatch). */
  success: boolean | null;
  resultExcerpt: string;
}

/** One row of the in-flight turn's live trace: a tool call MERGED with its
 *  approval card when the call went through the gateway gate (ADR-0083) --
 *  one row per call across both event channels, so an external tool renders
 *  pending card -> resolved badge + running spinner -> success/failure on a
 *  single line. Rows with `approval` render the card chrome; rows without are
 *  plain built-in call rows. */
export interface LiveTraceRow {
  /** Stable render key: the approval requestId for gated calls (the card's
   *  identity survives the started/completed merge), else the call key. */
  key: string;
  name: string;
  /** The external MCP server for gated calls; null for built-in calls. */
  server: string | null;
  operationKind: OperationKind;
  summary: string;
  /** The approval card's state when this call went through the gate:
   *  `response` null while PENDING (three live buttons), the user's answer
   *  once resolved (badge). null for ungated built-in calls. */
  approval: { requestId: string; response: ApprovalResponse | null } | null;
  running: boolean;
  success: boolean | null;
  resultExcerpt: string;
}

/** The in-flight turn the rail renders progressively (ADR-0078, issue #297):
 *  the asking question + the live trace rows + the current Thinking step.
 *  Client UI state only (ADR-0051/0059) -- never enters the thread cache; the
 *  settled turn folds the rows into its optimistic TurnRecord.trace. */
export interface LiveTurn {
  question: string;
  /** The 1-based step of the latest Thinking event (round-trip count,
   *  ADR-0081); null until the first event arrives. */
  step: number | null;
  rows: LiveTraceRow[];
}

/** Merge the two live channels into one ordered row list (pure -- unit-tested
 *  without the hook). Calls keep dispatch order; each call absorbs the
 *  matching approval entry (same tool name + summary: both channels source
 *  the summary from the gateway's classify step, so the strings agree).
 *  Unmatched approvals (still pending -- the call hasn't passed the gate yet,
 *  or a gate-cancelled call that never dispatched) trail the list: they ARE
 *  the most recent events. */
export function mergeLiveTrace(
  calls: LiveCall[],
  approvals: ReadonlyArray<ApprovalEntry>,
): LiveTraceRow[] {
  const rows: LiveTraceRow[] = [];
  const merged = new Set<string>();
  for (const call of calls) {
    const match = approvals.find(
      (a) => !merged.has(a.requestId) && a.tool === call.name && a.summary === call.summary,
    );
    if (match) {
      merged.add(match.requestId);
      rows.push({
        key: match.requestId,
        name: call.name,
        server: match.server,
        operationKind: call.operationKind,
        summary: call.summary,
        approval: {
          requestId: match.requestId,
          response: match.status.kind === "resolved" ? match.status.response : null,
        },
        running: call.running,
        success: call.success,
        resultExcerpt: call.resultExcerpt,
      });
    } else {
      rows.push({
        key: call.key,
        name: call.name,
        server: null,
        operationKind: call.operationKind,
        summary: call.summary,
        approval: null,
        running: call.running,
        success: call.success,
        resultExcerpt: call.resultExcerpt,
      });
    }
  }
  for (const a of approvals) {
    if (merged.has(a.requestId)) continue;
    rows.push({
      key: a.requestId,
      name: a.tool,
      server: a.server,
      operationKind: a.operationKind,
      summary: a.summary,
      approval: {
        requestId: a.requestId,
        response: a.status.kind === "resolved" ? a.status.response : null,
      },
      running: false,
      success: null,
      resultExcerpt: "",
    });
  }
  return rows;
}

/** Project the settled rows onto the persisted TraceEntry shape for the
 *  optimistic thread append (issue #297): completed calls only -- a row still
 *  at success===null (a gate-cancelled call, resolved-deny with no dispatch)
 *  has NO backend trace entry, so including it would diverge from the refetch.
 *  The field mapping is identity with the ToolCallCompleted payload, so the
 *  optimistic trace equals the backend's recorded trace entry-for-entry. */
export function rowsToTrace(rows: ReadonlyArray<LiveTraceRow>): TraceEntry[] {
  const trace: TraceEntry[] = [];
  for (const row of rows) {
    if (row.success === null) continue;
    trace.push({
      name: row.name,
      operation_kind: row.operationKind,
      summary: row.summary,
      success: row.success,
      result_excerpt: row.resultExcerpt,
    });
  }
  return trace;
}

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
  /** This session's approval entries (the app-level useApprovalEvents slice,
   *  ADR-0083). Merged into the live trace rows so a gated external call
   *  renders its card inside the turn. Optional for call sites that don't
   *  exercise approvals (tests); defaults to empty (no cards). */
  approvals?: ReadonlyArray<ApprovalEntry>;
  /** Called once per settled turn (every ask end, incl. failure / cancel):
   *  the app-level approval hook clears this session's cards, folded into the
   *  optimistic record by then. Optional; defaults to a no-op. */
  onApprovalsSettled?: () => void;
}

export interface UseTurnFlow {
  /** The in-flight turn's latest progress event (ADR-0059): Thinking with the
   *  1-based step, or the last tool-call event. null when no turn is running.
   *  Client UI state only -- drives the QuestionBar's compact phase label. */
  phase: TurnPhase | null;
  /** The in-flight turn's live trace (ADR-0078, issue #297): the rail renders
   *  it as a progressive turn card (question + rows + approval cards). null
   *  when no turn is running. Built from the turn-progress tool-call events
   *  merged with the session's approval entries; folds into the optimistic
   *  TurnRecord.trace when the turn settles. */
  liveTurn: LiveTurn | null;
  // Declared Promise<void> (not void) so the contract reflects the async
  // implementation: callers can await/.catch to chain post-ask work. Fire-
  // and-forget callers (QuestionBar onSubmit/onCancel) still accept it via
  // TypeScript's void-return covariance.
  handleAsk: (question: string) => Promise<void>;
  handleCancel: () => Promise<void>;
}

/** The in-flight turn's raw progress state: the turn-progress channel alone
 *  (approval cards merge in at the liveTurn derivation). */
interface LiveState {
  question: string;
  step: number | null;
  calls: LiveCall[];
}

/** Mint a call row keyed by arrival order (the trace is append-only within
 *  a turn, so the sequence is a stable key). Shared by the two paths that
 *  append a row (a started call, a gate-denied completion with no start). */
function callRow(
  seq: number,
  name: string,
  operationKind: OperationKind,
  summary: string,
  running: boolean,
  success: boolean | null,
  resultExcerpt: string,
): LiveCall {
  return { key: `call-${seq}`, name, operationKind, summary, running, success, resultExcerpt };
}

/** The index of the LAST running call matching (name, summary) -- the
 *  completion event's target. Last-wins pairs a completion with its own
 *  started row when the same tool + summary repeats across steps; -1 when no
 *  running match exists (a gate-denied call completes without ever starting).
 *  Manual scan: the ES2022 lib predates findLastIndex. */
function lastRunningMatchIdx(calls: LiveCall[], name: string, summary: string): number {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (c.running && c.name === name && c.summary === summary) return i;
  }
  return -1;
}

/** One progress event applied to the live state (pure). null passes through
 *  -- a late event past the ask's finally finds no live turn and drops. */
function applyPhase(live: LiveState | null, phase: TurnPhase): LiveState | null {
  if (live === null) return null;
  if ("Thinking" in phase) {
    // The LLM round-trip wait: surface the 1-based step.
    return { ...live, step: phase.Thinking.attempt };
  }
  if ("ToolCallStarted" in phase) {
    const { name, operation_kind, summary } = phase.ToolCallStarted;
    return {
      ...live,
      calls: [...live.calls, callRow(live.calls.length, name, operation_kind, summary, true, null, "")],
    };
  }
  // ToolCallCompleted: the trace entry as it lands. Completes the matching
  // running row; a gate-denied call (no started event) appends a completed
  // row directly.
  const entry = phase.ToolCallCompleted;
  const idx = lastRunningMatchIdx(live.calls, entry.name, entry.summary);
  if (idx >= 0) {
    return {
      ...live,
      calls: live.calls.map((c, i) =>
        i === idx
          ? { ...c, running: false, success: entry.success, resultExcerpt: entry.result_excerpt }
          : c,
      ),
    };
  }
  return {
    ...live,
    calls: [
      ...live.calls,
      callRow(
        live.calls.length,
        entry.name,
        entry.operation_kind,
        entry.summary,
        false,
        entry.success,
        entry.result_excerpt,
      ),
    ],
  };
}

export function useTurnFlow(sessionId: string, deps: UseTurnFlowDeps): UseTurnFlow {
  const {
    queryClient,
    intl,
    setLoading,
    setError,
    pollPersistError,
    viewed,
    approvals = NO_APPROVALS,
    onApprovalsSettled,
  } = deps;
  // Pull the two stable viewed methods out of the injected `viewed` object so
  // the handleAsk dep array stays identity-stable: the parent rebuilds the
  // `viewed` object every render, but the methods inside are useCallback-stable
  // (issue #229), so destructuring here lets handleAsk keep its prior identity
  // across renders instead of rebuilding on every parent render.
  const { markProduced, suppressInit } = viewed;
  const [phase, setPhase] = useState<TurnPhase | null>(null);
  // The in-flight turn's question + Thinking step + tool-call rows. null = no
  // turn running. The approval cards merge in at the liveTurn derivation below
  // (single source of truth: this state owns ONLY the turn-progress channel).
  const [live, setLive] = useState<LiveState | null>(null);
  // Synchronous mirrors of `live` + the merged rows. The event listener and
  // handleAsk update the refs FIRST, then schedule the same value as render
  // state, so the async ask tail reads the settled rows WITHOUT waiting for
  // the render flush: the backend emits the final event before returning the
  // outcome, but the two ride different channels (Tauri event vs command
  // reply) and can land in the same task -- and the thread is never refetched
  // post-turn (ADR-0051), so the optimistic trace must capture the final
  // event even when its state update has not rendered yet.
  const liveRef = useRef<LiveState | null>(null);
  const rowsRef = useRef<LiveTraceRow[]>(NO_ROWS);
  // The approvals prop mirrored for the same synchronous-read reason (the
  // merge inside commitLive reads it; the prop itself drives the memo).
  const approvalsRef = useRef(approvals);
  useEffect(() => {
    approvalsRef.current = approvals;
  }, [approvals]);

  // Advance the live state: refs first (the synchronous truth the ask tail
  // reads), then the render state. The rows mirror merges the approvals
  // channel in, so both event streams fold into one row list at the moment
  // each event lands (the render-time memo recomputes the same value).
  // useCallback-stable (it closes over refs + a setter + module constants
  // only), so the listener effect mounts once and handleAsk keeps its
  // identity across renders.
  const commitLive = useCallback((next: LiveState | null) => {
    liveRef.current = next;
    rowsRef.current = next === null ? NO_ROWS : mergeLiveTrace(next.calls, approvalsRef.current);
    setLive(next);
  }, []);

  // ADR-0059 C-4: a LONG-LIVED turn-progress listener -- mount listen once,
  // unmount unlisten. Reused across ALL turns (NOT a per-turn listen, which
  // would amplify a subscribe-before-ask race + cost one IPC per turn). The
  // global Tauri broadcast is filtered to this pane's sessionId so a sibling
  // pane's events never leak in. On unmount (close tab, ADR-0055) the cleanup
  // unlistens + the state is destroyed; any orphan event from the in-flight
  // turn has no listener and is harmlessly dropped.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void onTurnProgress((ev) => {
      if (!active || ev.session_id !== sessionId) return;
      setPhase(ev.phase);
      // applyPhase passes null through: a late event past the ask's finally
      // finds no live turn and drops.
      commitLive(applyPhase(liveRef.current, ev.phase));
    }).then((un) => {
      // If the effect already cleaned up before listen resolved, unlisten
      // immediately so the orphan callback cannot fire setters post-unmount.
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
  }, [sessionId, commitLive]);

  // The merged live trace (tool-call rows + approval cards). Recomputed on
  // either channel's change; null when no turn runs. The derivation is the
  // only place the two event channels meet, so the render tree reads one row
  // list (the rail never reconciles channels itself).
  const liveTurn = useMemo<LiveTurn | null>(() => {
    if (live === null) return null;
    return {
      question: live.question,
      step: live.step,
      rows: mergeLiveTrace(live.calls, approvals),
    };
  }, [live, approvals]);

  // Ask one question (PRD #1): run one turn -> one ADR-0028 outcome. On
  // success the new turn is optimistically appended to the thread cache
  // (ADR-0051) -- question + outcome + the live trace rows the events
  // delivered (issue #297: the optimistic record matches the backend's
  // recorded TurnRecord.trace entry-for-entry); a Materialized outcome
  // additionally moves viewedResult (auto-selects) and invalidates workingSet
  // + active (a new result_N registered server-side).
  const handleAsk = useCallback(
    async (question: string) => {
      setLoading(true);
      setError(null);
      // The live turn card mounts with the question; events grow its trace.
      commitLive({ question, step: null, calls: [] });
      let outcome;
      // The settled trace, snapshotted in the finally BEFORE the live state
      // folds away (the optimistic append below reads it on the success
      // path; the failure path early-returns without appending). The
      // finally ALWAYS assigns it, so the definite-assignment needs no
      // initializer (which no-useless-assignment would flag as dead).
      let settledTrace: TraceEntry[];
      try {
        outcome = await askQuestion(sessionId, question);
      } catch (e) {
        setError(toAppError(e, intl, "ask"));
        setLoading(false);
        void pollPersistError();
        return;
      } finally {
        // ADR-0059: clear the phase on every ask end (incl. Cancelled outcome /
        // IPC failure) -- the in-flight turn is done. Loading stays on through
        // the post-outcome invalidation below; phase is a turn-lifecycle hint,
        // not a UI-busy flag. The live card folds here too: rowsRef holds the
        // synchronously-mirrored settled rows (captured above, so the final
        // event's row survives even when its render is still pending), and
        // the app-level approval hook clears this session's folded cards.
        settledTrace = rowsToTrace(rowsRef.current);
        setPhase(null);
        commitLive(null);
        onApprovalsSettled?.();
      }
      // Optimistic thread append (ADR-0051): the outcome object is the same
      // shape the backend recorded; the trace is the event stream's settled
      // rows (completed calls only), so the appended entry matches the
      // refetch.
      const newEntry: ThreadEntry = {
        entry: "Turn",
        // Issue #381: the optimistic entry's provenance is empty -- the frontend
        // does not know the assembly-time content_hashes (the backend records
        // them in record_turn). The refetch replaces this entry with the real
        // TurnRecord carrying the live provenance, so the drift check activates
        // only after the refetch lands.
        data: { question, outcome, trace: settledTrace, provenance: { skills: [] } },
      };
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread(sessionId), (old) =>
        old ? [...old, newEntry] : [newEntry],
      );
      suppressInit(); // the user has acted; the R5 init is moot.
      if (outcome.kind === "Materialized") {
        // ADR-0084: the just-produced primary is the promotion chain's tail --
        // the result the answer references. Auto-selects + pin resets (ADR-0062
        // R2 "new-turn produce -> pinned=false"); the pin rule is encapsulated
        // in useViewedResult (issue #229).
        const { promotions } = outcome.data;
        const referenceName = promotions[promotions.length - 1]?.dataset.reference_name;
        if (referenceName !== undefined) {
          markProduced(referenceName);
        }
        // Only workingSet + active change here (a new result_N registered
        // server-side + active may have moved); thread stays un-invalidated
        // (ADR-0051) -- see the hook header for the why. The try/catch guard
        // surfaces a refresh failure as a tagged error instead of skipping
        // setLoading(false) below (would lock QuestionBar forever); mirrors
        // refreshServerState's "saved but refresh failed" contract.
        try {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: sessionKeys.workingSet(sessionId) }),
            queryClient.invalidateQueries({ queryKey: sessionKeys.active(sessionId) }),
          ]);
        } catch (invalidateErr) {
          // invalidateErr because this try wraps invalidateQueries (workingSet +
          // active); the refreshFailed option stays -- it selects toAppError's
          // user-facing "saved but refreshing..." prefix (ADR-0069), not the impl.
          setError(toAppError(invalidateErr, intl, "ask", { refreshFailed: true }));
        }
      }
      // Textual / Failed / Cancelled: no working-set change; the optimistic
      // append is the thread state, nothing to invalidate.
      // ADR-0095: refresh the model config on EVERY outcome kind -- an
      // external-runtime turn's LoopOutcome.discovered_runtime lands on the
      // handle cache regardless of how the turn terminated, and the selector
      // must re-read it (dedupe is inherent: the backend cache is
      // single-slot). Fire-and-forget like pollPersistError.
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.modelConfig(sessionId),
      });
      setLoading(false);
      void pollPersistError();
    },
    [
      sessionId,
      queryClient,
      pollPersistError,
      intl,
      setLoading,
      setError,
      markProduced,
      suppressInit,
      onApprovalsSettled,
      commitLive,
    ],
  );

  // Cancel is the abort of ask -- a turn-domain semantic, so it lives here
  // alongside handleAsk, not with the ingest/dataset mutations.
  const handleCancel = useCallback(async () => {
    try {
      await cancelQuery(sessionId);
    } catch (e) {
      // Cancel owns only the error surface, not phase/loading. Those clear via
      // handleAsk's lifecycle once the in-flight ask settles: a successful cancel
      // lands a Cancelled outcome -> handleAsk's finally clears phase + its tail
      // clears loading. A cancel REJECT means the turn may still be running, so
      // leaving loading=true is the honest state, not a stuck bug.
      setError(toAppError(e, intl, "ask"));
    }
  }, [sessionId, intl, setError]);

  return { phase, liveTurn, handleAsk, handleCancel };
}
