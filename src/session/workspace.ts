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

import type { DatasetDescriptor, StaleAnchor } from "../types/dataset";
import type { ThreadEntry, TurnArtifact, VizSpec } from "../types/thread";

/** The user's workspace view selection (ADR-0051, generalized by ADR-0124
 * Decision 3): a thin reference to what the result pane is showing -- either
 * a Materialized result (dataset) or a delivered artifact (file). The two
 * are mutually exclusive on the single stage; the last selection wins. A
 * dataset view is NEVER the active dataset (which is server truth) --
 * clicking a past result moves ONLY this, never the backend active pointer.
 * A file view names the manifest entry by its absolute path (settle-frozen,
 * never rewritten), so the display facts (file name) re-derive from the
 * thread like the dataset payload does. */
export type ViewedResult =
  | { kind: "dataset"; referenceName: string }
  | { kind: "file"; path: string };

/** The payload a viewed Materialized result renders with (ADR-0051: derived
 * from the thread, not held as a fat snapshot). null when no turn in the thread
 * materialized that reference name (a race during optimistic append, or a stale
 * view pointing at a GC'd result). */
export interface ResultPayload {
  // No live agent source emits an assumption (#847); the field stays
  // reserved for a future provider, mirroring the Rust comment on the
  // outcome -- populated only on turns persisted before #847.
  assumption: string | null;
  viz: VizSpec | null;
  /** Issue #758: the question the matched turn asked -- the stale banner's
   *  rerun fires it as a fresh turn. Rides the payload so the result pane
   *  never re-scans the thread itself. */
  question: string;
}

/** Look up the Materialized turn that produced `referenceName` and return its
 * payload (assumption + viz + the producing question). Thread is the single
 * source of truth for turn payloads (ADR-0051), so a re-selected past result
 * re-renders its chart and assumption side-note without a separate snapshot. */
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
      return {
        assumption: outcome.data.assumption,
        viz: outcome.data.viz,
        question: entry.data.question,
      };
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

/** How a viewed artifact renders (ADR-0124 Decision 4's matrix, keyed by the
 * file's extension): HTML rides the sandboxed asset-protocol iframe, md rides
 * the IPC text read + the prose renderer, everything else (and every degrade)
 * is the file card with the external-open action. */
export type ArtifactRenderKind = "html" | "markdown" | "card";

/** The render kind for one artifact path (ADR-0124 Decision 4). Extension-
 * keyed off the path itself (the file_name is a display mirror); the
 * deliverable whitelist (pdf/docx/xlsx/pptx/html/htm/md) makes the
 * extension-less fallthrough unreachable in practice -- it degrades to the
 * card, the honest shape for an unknown format. */
export function artifactRenderKind(path: string): ArtifactRenderKind {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md") return "markdown";
  return "card";
}

/** Look up a manifest entry by its absolute path (the viewed file's thin
 * reference, ADR-0124 Decision 3). Tail-first like the dataset scans: the
 * same path re-delivered by a later turn resolves to that turn's entry --
 * the newest delivery owns the display facts. null when no turn in the
 * thread carries the path (the manifest is settle-frozen and the thread is
 * append-only, so this is a foreign view, not a GC race). */
export function findArtifact(
  thread: ThreadEntry[],
  path: string,
): TurnArtifact | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const entry = thread[i];
    if (entry.entry !== "Turn") continue;
    const hit = entry.data.artifacts?.find((a) => a.path === path);
    if (hit) return hit;
  }
  return null;
}

/** Whether an artifact path sits inside the per-session artifacts directory
 * (ADR-0124 Decision 4): `artifacts/` under the bound .duck's parent -- the
 * one directory the asset protocol's runtime scope grants. Only in-scope
 * HTML is iframe-servable; a user-directory original (or an unbound temp
 * path) degrades to the card + external open instead of a denied iframe.
 * Case-insensitive: Windows (the app's host) folds path case, and a
 * case-differing collision on a case-sensitive host is pathological.
 * ponytail: hand-rolled dirname/sep (no path polyfill in the webview); if
 * mixed-separator duck paths ever appear, normalize at the IPC edge. */
export function isWithinArtifactsDir(path: string, duckPath: string): boolean {
  const sep = duckPath.includes("\\") ? "\\" : "/";
  const last = Math.max(duckPath.lastIndexOf("/"), duckPath.lastIndexOf("\\"));
  const prefix = `${last === -1 ? "" : duckPath.slice(0, last)}${sep}artifacts${sep}`;
  return path.toLowerCase().startsWith(prefix.toLowerCase());
}

/** The auto-open candidate (ADR-0124 Decision 3): the LATEST turn carrying a
 * non-empty manifest, scanned tail-first. Non-artifact turns are skipped
 * like the dataset scans -- a trailing turn that delivered nothing never
 * re-arms an older turn's auto-open. */
export interface ArtifactAutoOpenCandidate {
  /** The one-shot consumption key: the manifest's paths in order. The same
   * candidate arriving again (a rerender, a duplicate refetch) never
   * re-consumes; a fresh delivery (a different manifest) does. */
  signature: string;
  /** The manifest's primary -- the first entry (#1090: derived order, never
   * a stored flag). */
  primaryPath: string;
  /** The candidate turn ALSO materialized a result: the existing promotion
   * semantics own the stage (the view follows the produced dataset), so the
   * artifact auto-open must not steal it. */
  turnMaterialized: boolean;
}

export function latestArtifactCandidate(
  thread: ThreadEntry[],
): ArtifactAutoOpenCandidate | null {
  for (let i = thread.length - 1; i >= 0; i--) {
    const entry = thread[i];
    if (entry.entry !== "Turn") continue;
    const artifacts = entry.data.artifacts;
    if (artifacts === undefined || artifacts.length === 0) continue;
    return {
      signature: artifacts.map((a) => a.path).join("\n"),
      primaryPath: artifacts[0].path,
      turnMaterialized: entry.data.outcome.kind === "Materialized",
    };
  }
  return null;
}

/** What the workspace "result" area shows (ADR-0062 R2 two-state, calibrated
 * by ADR-0114; extended to three states by ADR-0124 Decision 3 -- hero stays
 * the single non-data state):
 *  - `result`: the user selected a Materialized result (now or in the past)
 *    and its payload resolves from the thread -- show its chart + table.
 *  - `file`: the user selected a delivered artifact and its manifest entry
 *    resolves from the thread -- show it per the render matrix (Decision 4).
 *  - `hero`: otherwise -- the empty-state drop zone.
 * Non-materialized turns (B/C/D) still never reach the workspace on their
 * own; their read surface is the rail (ADR-0103) -- an artifact they
 * delivered reaches it only through the view selection. */
export type WorkspaceContent =
  | {
    kind: "result";
    referenceName: string;
    assumption: string | null;
    viz: VizSpec | null;
    /** Issue #758: the question that produced this result -- the stale
     *  banner's rerun fires it. Always present on the result branch: the
     *  branch implies the payload resolved, and the payload carries it. */
    question: string;
    staleAnchor: StaleAnchor | null;
    /** Issue #757: the viewed result is not the latest Materialized turn's
     *  primary -- the user is looking at a past result. A derived fact, not a
     *  state (ADR-0114): a trailing B/C/D turn does not flag the view as
     *  historical, and a non-tail promotion of the latest turn does. */
    viewingHistory: boolean;
  }
  | {
    kind: "file";
    /** The manifest entry's absolute path -- the view's identity. */
    path: string;
    /** The entry's display name (ADR-0124 Decision 2). */
    fileName: string;
    /** The render matrix branch for this path (Decision 4). */
    render: ArtifactRenderKind;
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
    if (viewedResult.kind === "file") {
      const artifact = findArtifact(thread, viewedResult.path);
      if (artifact) {
        return {
          kind: "file",
          path: artifact.path,
          fileName: artifact.file_name,
          render: artifactRenderKind(artifact.path),
        };
      }
      // The view names a path no turn in the thread carries (a foreign /
      // hand-set view). Fall through to hero rather than render a file whose
      // manifest entry we cannot resolve.
    } else {
      const payload = findMaterializedPayload(thread, viewedResult.referenceName);
      if (payload) {
        return {
          kind: "result",
          referenceName: viewedResult.referenceName,
          assumption: payload.assumption,
          viz: payload.viz,
          question: payload.question,
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
  }
  return { kind: "hero" };
}

/** The working-set tab's detail target (issue #792): the tab's own explicit
 * pick wins while it still resolves; a pick that no longer does (the dataset
 * was deleted) falls back to the ACTIVE dataset (server truth, ADR-0051),
 * then to the first list item. While the list is non-empty the detail always
 * shows SOMETHING -- the empty working set is the empty-state card, never a
 * placeholder detail pane. Pure in (datasets, selected, activeName). */
export function resolveWorkingSetDetail(
  datasets: DatasetDescriptor[],
  selected: string | null,
  activeName: string | null,
): DatasetDescriptor | null {
  const byName = (name: string | null) =>
    name === null ? undefined : datasets.find((d) => d.reference_name === name);
  return byName(selected) ?? byName(activeName) ?? datasets[0] ?? null;
}
