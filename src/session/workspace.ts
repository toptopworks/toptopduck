// Pure workspace-derivation helpers (ADR-0051 / ADR-0062 R2). Kept out of the
// component so the derivation rule (viewedResult + thread last turn +
// pinnedToHistory -> what the workspace shows) is unit-testable without React,
// and so the SessionPane component stays a thin caller of these functions.
//
// Truth-source split (ADR-0051 "two sources, no overlap"):
//  - THREAD is the single source of truth for turn PAYLOADS (question / outcome
//    / viz / assumption / SQL). deriveWorkspaceContent + findMaterializedPayload
//    read only the thread.
//  - WORKING SET is the single source of truth for DATASET RUNTIME STATE
//    (stale / columns / rows / privacy). The stale anchor on a viewed result
//    is read from the descriptor by the caller, never from the thread snapshot.

import type {
  StaleAnchor,
  ThreadEntry,
  TurnOutcome,
  TurnRecord,
  VizSpec,
} from "../types";

/** The user's workspace view selection (ADR-0051): a thin reference to the
 * Materialized result pane the user is looking at. NEVER the active dataset
 * (which is server truth) -- clicking a past result moves ONLY this, never
 * touching the backend active pointer. */
export interface ViewedResult {
  referenceName: string;
}

/** Find the last Turn entry in the thread (source lifecycle events are skipped
 * -- they occupy a timeline slot but are not turns, ADR-0040). null when the
 * thread has no turns yet. */
export function lastTurnEntry(thread: ThreadEntry[]): TurnRecord | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const entry = thread[i];
    if (entry.entry === "Turn") return entry.data;
  }
  return null;
}

/** The non-materialized outcome family (ADR-0028 B/C/D -- Textual / Failed /
 * Cancelled): everything except Materialized. Narrowing TurnRecord onto this
 * makes the "a Materialized never reaches the textual card" invariant a
 * type-level guarantee, so the card's switch can end in `default: never`
 * instead of a defensive `return null`. */
export type NonMaterializedOutcome = Exclude<TurnOutcome, { kind: "Materialized" }>;
export type NonMaterializedTurn = { question: string; outcome: NonMaterializedOutcome };

/** Is this turn's outcome a non-materialized kind (ADR-0028 B/C/D -- Textual /
 * Failed / Cancelled)? These occupy a thread slot but produce no result_N. A
 * type predicate so deriveWorkspaceContent carries the narrowed turn type into
 * WorkspaceContent.lastTurnText, not the full TurnRecord. */
export function isNonMaterialized(turn: TurnRecord): turn is NonMaterializedTurn {
  return turn.outcome.kind !== "Materialized";
}

/** The payload a viewed Materialized result renders with (ADR-0051: derived
 * from the thread, not held as a fat snapshot). null when no turn in the thread
 * materialized that reference name (a race during optimistic append, or a stale
 * view pointing at a GC'd result). */
export interface ResultPayload {
  assumption: string | null;
  viz: VizSpec | null;
}

/** Look up the Materialized turn that produced `referenceName` and return its
 * payload (assumption + viz). Thread is the single source of truth for turn
 * payloads (ADR-0051), so a re-selected past result re-renders its chart and
 * assumption side-note without a separate snapshot. */
export function findMaterializedPayload(
  thread: ThreadEntry[],
  referenceName: string,
): ResultPayload | null {
  for (const entry of thread) {
    if (entry.entry !== "Turn") continue;
    const { outcome } = entry.data;
    if (
      outcome.kind === "Materialized" &&
      outcome.data.dataset.reference_name === referenceName
    ) {
      return { assumption: outcome.data.assumption, viz: outcome.data.viz };
    }
  }
  return null;
}

/** What the workspace "result" area shows (ADR-0062 R2). The three-state
 * derivation:
 *  - `lastTurnText`: the last turn is non-materialized (B/C/D) AND the user has
 *    not pinned to a history result -- show the textual card so the user can
 *    read/respond (ADR-0048).
 *  - `result`: otherwise, if the user selected a Materialized result (now or
 *    in the past) -- show its chart + table.
 *  - `hero`: otherwise (no viewed result, and no non-materialized last turn) --
 *    the empty-state drop zone. */
export type WorkspaceContent =
  | { kind: "lastTurnText"; turn: NonMaterializedTurn }
  | {
    kind: "result";
    referenceName: string;
    assumption: string | null;
    viz: VizSpec | null;
    staleAnchor: StaleAnchor | null;
  }
  | { kind: "hero" };

/** Derive what the workspace shows right now (ADR-0062 R2). Pure in
 * (thread, viewedResult, pinnedToHistory, staleByReference) -- the caller
 * supplies the stale map derived from the working-set query (runtime truth,
 * ADR-0051), so this function reads no queries itself. */
export function deriveWorkspaceContent(
  thread: ThreadEntry[],
  viewedResult: ViewedResult | null,
  pinnedToHistory: boolean,
  staleByReference: ReadonlyMap<string, StaleAnchor>,
): WorkspaceContent {
  const last = lastTurnEntry(thread);
  // R2: last turn B/C/D + unpinned -> textual card (transient; ADR-0051
  // "naturally renders" made explicit).
  if (last && isNonMaterialized(last) && !pinnedToHistory) {
    return { kind: "lastTurnText", turn: last };
  }
  if (viewedResult) {
    const payload = findMaterializedPayload(thread, viewedResult.referenceName);
    if (payload) {
      return {
        kind: "result",
        referenceName: viewedResult.referenceName,
        assumption: payload.assumption,
        viz: payload.viz,
        staleAnchor: staleByReference.get(viewedResult.referenceName) ?? null,
      };
    }
    // viewedResult points at a turn not currently in the thread (optimistic
    // append race, or the result was GC'd). Fall through to hero rather than
    // render a result whose rows/viz we cannot resolve.
  }
  return { kind: "hero" };
}
