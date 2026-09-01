// Pure workspace-derivation helpers (ADR-0051 / ADR-0062 R2, calibrated by
// ADR-0114). Kept out of the component so the derivation rule (viewedResult
// -> what the workspace shows) is unit-testable without React, and so the
// SessionPane component stays a thin caller of these functions.
//
// Truth-source split (ADR-0051 "two sources, no overlap"):
//  - THREAD is the single source of truth for turn PAYLOADS (question / outcome
//    / viz / assumption / SQL). deriveWorkspaceContent + findMaterializedPayload
//    read only the thread.
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
      };
    }
    // viewedResult points at a turn not currently in the thread (optimistic
    // append race, or the result was GC'd). Fall through to hero rather than
    // render a result whose rows/viz we cannot resolve.
  }
  return { kind: "hero" };
}
