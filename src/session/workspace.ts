// Pure workspace-derivation helpers (ADR-0051 / ADR-0062 R2, calibrated by
// ADR-0114). Kept out of the component so the derivation rule (viewedResult
// -> what the workspace shows) is unit-testable without React, and so the
// SessionPane component stays a thin caller of these functions.
//
// Truth-source split (ADR-0051 "two sources, no overlap"):
//  - THREAD is the single source of truth for turn PAYLOADS (question / outcome
//    / viz / assumption / SQL). deriveWorkspaceContent + findMaterializedPayload
//    + findLatestMaterializedPrimary read only the thread.
//  - WORKING SET is the single source of truth for DATASET RUNTIME STATE
//    (stale / columns / rows / privacy). The stale anchor on a viewed result
//    is read from the descriptor by the caller, never from the thread snapshot.

import type { StaleAnchor } from "../types/dataset";
import type { ThreadEntry, VizSpec } from "../types/thread";

/** The user's workspace view selection (ADR-0051): a thin reference to the
 * Materialized result pane the user is looking at. NEVER the active dataset
 * (which is server truth) -- clicking a past result moves ONLY this, never
 * touching the backend active pointer. */
export interface ViewedResult {
  referenceName: string;
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
    // ADR-0084: a result turn carries a promotion chain; the viewed result
    // matches if ANY promotion produced it. The payload (assumption + viz) is
    // turn-level -- it rides the whole turn, not a single promotion.
    if (
      outcome.kind === "Materialized" &&
      outcome.data.promotions.some((p) => p.dataset.reference_name === referenceName)
    ) {
      return { assumption: outcome.data.assumption, viz: outcome.data.viz };
    }
  }
  return null;
}

/** The primary result of the latest Materialized turn (issue #757 "latest"):
 * scan tail-first for the last turn whose outcome is Materialized AND carries
 * a primary (the promotion chain's tail, ADR-0084). Trailing non-materialized
 * turns are skipped -- the workspace is inert to them (ADR-0114), so they
 * never age the viewed result -- as are promotion-less Materialized turns.
 * null when the thread materialized no primary. Shared by the R5 resume
 * landing (useViewedResult) and the "viewing a past result" fact below so the
 * two stay one scan, never two drifting implementations. */
export function findLatestMaterializedPrimary(thread: ThreadEntry[]): string | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const entry = thread[i];
    if (entry.entry !== "Turn") continue;
    const { outcome } = entry.data;
    if (outcome.kind !== "Materialized") continue;
    const { promotions } = outcome.data;
    const primary = promotions[promotions.length - 1];
    if (!primary) continue;
    return primary.dataset.reference_name;
  }
  return null;
}

/** What the workspace "result" area shows (ADR-0062 R2 two-state, calibrated
 * by ADR-0114):
 *  - `result`: the user selected a Materialized result (now or in the past)
 *    and its payload resolves from the thread -- show its chart + table.
 *  - `hero`: otherwise -- the empty-state drop zone.
 * Non-materialized turns (B/C/D) never reach the workspace; their read
 * surface is the rail (ADR-0103), so the workspace is inert to them. */
export type WorkspaceContent =
  | {
    kind: "result";
    referenceName: string;
    assumption: string | null;
    viz: VizSpec | null;
    staleAnchor: StaleAnchor | null;
    /** Issue #757: the viewed result is not the latest Materialized turn's
     *  primary -- the user is looking at a past result. A derived fact, not a
     *  state (ADR-0114): a trailing B/C/D turn does not flag the view as
     *  historical, and a non-tail promotion of the latest turn does. */
    viewingHistory: boolean;
  }
  | { kind: "hero" };

/** Derive what the workspace shows right now (ADR-0062 R2, ADR-0114). Pure in
 * (thread, viewedResult, staleByReference) -- the caller supplies the stale map
 * derived from the working-set query (runtime truth, ADR-0051), so this
 * function reads no queries itself. */
export function deriveWorkspaceContent(
  thread: ThreadEntry[],
  viewedResult: ViewedResult | null,
  staleByReference: ReadonlyMap<string, StaleAnchor>,
): WorkspaceContent {
  if (viewedResult) {
    const payload = findMaterializedPayload(thread, viewedResult.referenceName);
    if (payload) {
      return {
        kind: "result",
        referenceName: viewedResult.referenceName,
        assumption: payload.assumption,
        viz: payload.viz,
        staleAnchor: staleByReference.get(viewedResult.referenceName) ?? null,
        // The result branch implies the thread materialized SOMETHING, so the
        // latest primary resolves; the comparison still holds when it
        // wouldn't (any non-null name !== null).
        viewingHistory: viewedResult.referenceName !== findLatestMaterializedPrimary(thread),
      };
    }
    // viewedResult points at a turn not currently in the thread (optimistic
    // append race, or the result was GC'd). Fall through to hero rather than
    // render a result whose rows/viz we cannot resolve.
  }
  return { kind: "hero" };
}
