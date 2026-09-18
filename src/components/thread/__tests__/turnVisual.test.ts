import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_FOLD_THRESHOLD,
  lifecycleRunMarks,
  lifecycleVisualRows,
  runtimeMarkerName,
} from "../turn-visual";
import type { ThreadEntry, TurnRuntime } from "../../../types/thread";

// The issue #721 run-position contract, pinned at the pure-algebra seam. The
// Thread.test.tsx data-run pins cover the DOM wiring, but Thread never reads
// the mark inside the turn branch -- the null-for-turns half of the return
// contract is only observable here.

const source = (kind: "Added" | "Replaced" | "Deleted"): ThreadEntry => ({
  entry: "Source",
  data: { kind, reference_name: "people", display_name: "员工表" },
});
// The lightest legal TurnRecord -- the run computation discriminates on the
// tag alone and never reads a turn's data.
const turn: ThreadEntry = {
  entry: "Turn",
  data: {
    question: "问",
    outcome: { kind: "Textual", data: { text_kind: "Clarify", body: "", assumption: null } },
    trace: [],
    provenance: { skills: [] },
  },
};

// The marks derive from the visual row projection (issue #737
// single-sourcing), so every #721 pin below goes through the projector.
// These fixtures never reach the fold threshold (their kinds alternate), so
// the projection is the identity over the marker rows and the pinned marks
// read exactly as they did in the per-entry era.
const marksOf = (entries: ThreadEntry[]) =>
  lifecycleRunMarks(lifecycleVisualRows(entries));

describe("lifecycleRunMarks (run-position contract)", () => {
  it("stamps first/mid/last across a run and null on every turn", () => {
    const entries: ThreadEntry[] = [
      source("Added"),
      source("Deleted"),
      source("Replaced"),
      turn,
      source("Replaced"),
      turn,
      source("Added"),
      source("Deleted"),
    ];
    // The head run spans from the thread's very first entry; the tail run is
    // flushed at entries.length. A turn always carries null -- it never
    // enters the line.
    expect(marksOf(entries)).toEqual([
      "first",
      "mid",
      "last",
      null,
      "single",
      null,
      "first",
      "last",
    ]);
  });

  it("marks a lone lifecycle event between turns single", () => {
    expect(marksOf([turn, source("Added"), turn])).toEqual([null, "single", null]);
  });

  it("returns all null for a turn-only thread (consecutive turns no-op)", () => {
    expect(marksOf([turn, turn])).toEqual([null, null]);
  });

  it("returns an empty array for an empty thread", () => {
    expect(marksOf([])).toEqual([]);
  });
});

describe("runtimeMarkerName (issue #818 per-turn attribution gate)", () => {
  const external = (adapterId: string | null): TurnRuntime => ({
    kind: "external",
    data: { adapter_id: adapterId },
  });

  it("names an external turn by its adapter id", () => {
    expect(runtimeMarkerName(external("claude-code"))).toBe("claude-code");
  });

  it("stays silent for the built-in default -- an unmarked turn reads as default", () => {
    expect(runtimeMarkerName({ kind: "built_in" })).toBeNull();
  });

  it("stays silent when provenance carries no runtime (failed read, old IPC peer)", () => {
    expect(runtimeMarkerName(undefined)).toBeNull();
  });

  it("stays silent for an external turn recorded before adapter ids existed", () => {
    // Same honest degradation as a missing runtime: an attribution that
    // cannot name the runner renders nothing (issue #818 addendum).
    expect(runtimeMarkerName(external(null))).toBeNull();
  });
});

// The issue #737 fold segmentation, pinned at the same pure seam: which
// subsegments collapse into one visual row and what that row aggregates.
// The threshold pair (one below / exactly at) is the constant's mutation
// pin -- an off-by-one in either direction turns one of the two red; the
// turn-break fixture is the breakpoint predicate's pin (dropping the turn
// flush merges the halves into one fold of four).

const srcNamed = (
  name: string,
  kind: "Added" | "Replaced" | "Deleted" = "Added",
): ThreadEntry => ({
  entry: "Source",
  data: { kind, reference_name: name, display_name: name },
});

describe("lifecycleVisualRows (fold segmentation, issue #737)", () => {
  it("folds at the threshold exactly; one below stays scatter", () => {
    const below = Array.from({ length: LIFECYCLE_FOLD_THRESHOLD - 1 }, (_, i) =>
      srcNamed(`s${i}`),
    );
    expect(lifecycleVisualRows(below)).toEqual(
      below.map((_, i) => ({ row: "marker", idx: i })),
    );

    const at = Array.from({ length: LIFECYCLE_FOLD_THRESHOLD }, (_, i) => srcNamed(`s${i}`));
    const rows = lifecycleVisualRows(at);
    expect(rows).toHaveLength(1);
    const fold = rows[0];
    expect(fold.row).toBe("fold");
    if (fold.row !== "fold") return;
    expect(fold.group.species).toBe("Source");
    expect(fold.group.kind).toBe("Added");
    // The FIRST member anchors the group (the expand-state key).
    expect(fold.group.anchorIdx).toBe(0);
    expect(fold.group.memberIdxs).toEqual([0, 1, 2]);
  });

  it("splits subsegments on kind; only same-kind runs fold", () => {
    const entries = [
      srcNamed("a"),
      srcNamed("b", "Replaced"),
      srcNamed("c", "Replaced"),
      srcNamed("d", "Replaced"),
      srcNamed("e"),
    ];
    // Added(a) scatter | Replaced×3 folds | Added(e) scatter -- a kind
    // change cuts the segment.
    const rows = lifecycleVisualRows(entries);
    const shape = (r: (typeof rows)[number]) =>
      r.row === "fold" ? { fold: [r.group.species, r.group.kind] } : r;
    expect(rows.map(shape)).toEqual([
      { row: "marker", idx: 0 },
      { fold: ["Source", "Replaced"] },
      { row: "marker", idx: 4 },
    ]);
  });

  it("breaks subsegments at a turn", () => {
    // Two Added pairs around a turn: neither half reaches the threshold and
    // the turn keeps them from merging into one fold of four.
    expect(
      lifecycleVisualRows([srcNamed("a"), srcNamed("b"), turn, srcNamed("c"), srcNamed("d")]).map(
        (r) => r.row,
      ),
    ).toEqual(["marker", "marker", "turn", "marker", "marker"]);
  });

  it("renders no row for a skill event (ADR-0119 Decision 2)", () => {
    // A migrated pre-v7 file's legacy skill events simply leave the line --
    // invocation records ride the turn now, so the timeline's skill species
    // is retired.
    const entries: ThreadEntry[] = [
      srcNamed("a"),
      { entry: "Skill", data: { kind: "Mount", name: "pdf-tools", actor: null } },
      turn,
    ];
    expect(lifecycleVisualRows(entries).map((r) => r.row)).toEqual(["marker", "turn"]);
  });

  it("sums invalidation counts onto the fold; an Added never contributes", () => {
    // Even a stale map keyed for an Added (impossible via StaleReason, but
    // the input is just a map) must not leak into the fold: the aggregation
    // skips Added members outright.
    const added = Array.from({ length: LIFECYCLE_FOLD_THRESHOLD }, (_, i) => srcNamed(`s${i}`));
    const noise = new Map([["s0:Added", 7]]);
    const addedRows = lifecycleVisualRows(added, { staleCountsByKey: noise });
    expect(addedRows[0].row).toBe("fold");
    if (addedRows[0].row !== "fold") return;
    expect(addedRows[0].group.invalidatedCount).toBe(0);

    const replaced = Array.from({ length: LIFECYCLE_FOLD_THRESHOLD }, (_, i) =>
      srcNamed(`s${i}`, "Replaced"),
    );
    const staleCountsByKey = new Map([
      ["s0:Replaced", 2],
      ["s2:Replaced", 1],
    ]);
    const replacedRows = lifecycleVisualRows(replaced, { staleCountsByKey });
    expect(replacedRows[0].row).toBe("fold");
    if (replacedRows[0].row !== "fold") return;
    expect(replacedRows[0].group.invalidatedCount).toBe(3);
  });

  it("treats a fold row as its segment's single node (marks over the projection)", () => {
    // marker(Replaced) | fold(Added×3): one run of two VISUAL rows -- the
    // fold participates like any node, so its connector derives from the
    // same projection the render consumes (single source).
    const entries = [
      srcNamed("a", "Replaced"),
      srcNamed("b"),
      srcNamed("c"),
      srcNamed("d"),
    ];
    expect(marksOf(entries)).toEqual(["first", "last"]);
  });
});
