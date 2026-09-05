import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_FOLD_THRESHOLD,
  agentActivationOwner,
  lifecycleRunMarks,
  lifecycleVisualRows,
  runtimeMarkerName,
  type ActivationOwner,
} from "../turn-visual";
import type { SkillEntry } from "../../../types/skills";
import type { ThreadEntry, TurnRuntime } from "../../../types/thread";

// The issue #721 run-position contract, pinned at the pure-algebra seam. The
// Thread.test.tsx data-run pins cover the DOM wiring, but Thread never reads
// the mark inside the turn branch -- the null-for-turns half of the return
// contract is only observable here.

const source = (kind: "Added" | "Replaced" | "Deleted"): ThreadEntry => ({
  entry: "Source",
  data: { kind, reference_name: "people", display_name: "员工表" },
});
const skill = (kind: "Mount" | "Activate" | "Unmount"): ThreadEntry => ({
  entry: "Skill",
  data: { kind, name: "pdf-tools", actor: null },
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
// single-sourcing), so every #721/#722 pin below goes through the projector.
// These fixtures never reach the fold threshold (their kinds alternate), so
// the projection is the identity over the marker rows and the pinned marks
// read exactly as they did in the per-entry era.
const marksOf = (entries: ThreadEntry[], owned?: ActivationOwner[]) =>
  lifecycleRunMarks(lifecycleVisualRows(entries, owned));

describe("lifecycleRunMarks (run-position contract)", () => {
  it("stamps first/mid/last across a mixed run and null on every turn", () => {
    const entries: ThreadEntry[] = [
      source("Added"),
      skill("Mount"),
      source("Deleted"),
      turn,
      source("Replaced"),
      turn,
      skill("Unmount"),
      source("Deleted"),
    ];
    // The head run spans BOTH species (mixed contiguity) from the thread's
    // very first entry; the tail run is flushed at entries.length. A turn
    // always carries null -- it never enters the line.
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
    expect(marksOf([turn, skill("Activate"), turn])).toEqual([null, "single", null]);
  });

  it("returns all null for a turn-only thread (consecutive turns no-op)", () => {
    expect(marksOf([turn, turn])).toEqual([null, null]);
  });

  it("returns an empty array for an empty thread", () => {
    expect(marksOf([])).toEqual([]);
  });
});

// The D5 association invariant (issue #722), pinned at the same pure-algebra
// seam: the backend inserts an agent activation at occurrence -- inside the
// turn that settles after it -- so an actor=Agent event belongs to the NEXT
// Turn entry, never the previous one. The sandwich pin is the mutation
// tripwire: flipping the association to "previous turn" turns it red.

const agentActivate = (name: string): ThreadEntry => ({
  entry: "Skill",
  data: { kind: "Activate", name, actor: "Agent" },
});

describe("agentActivationOwner (association invariant)", () => {
  it("maps an agent activation to the turn that settles after it, never the one before", () => {
    // Sandwiched between two turns the activation belongs to the LATER one
    // (it happened inside that turn) -- the interleaving is the invariant.
    expect(agentActivationOwner([turn, agentActivate("python"), turn])).toEqual([
      null,
      2,
      null,
    ]);
  });

  it("keeps an ownerless activation standalone when no turn follows and none runs live", () => {
    // The resume inconsistency edge (honest degrade): with no settled turn
    // ahead and no live exchange to host it, the event stays a top-level row.
    expect(agentActivationOwner([turn, agentActivate("python")])).toEqual([null, null]);
  });

  it("falls back to the live turn for the tail while a turn runs", () => {
    // In flight the owning turn has no entry yet -- the activation renders
    // at the live exchange's head until settle swaps it into the turn card.
    expect(agentActivationOwner([turn, agentActivate("python")], true)).toEqual([
      null,
      "live",
    ]);
  });

  it("keeps a settled owner even while a later turn runs live", () => {
    // The live fallback only catches the tail: an activation with a settled
    // turn ahead stays with that turn regardless of the live flag.
    expect(agentActivationOwner([agentActivate("python"), turn], true)).toEqual([1, null]);
  });

  it("never absorbs a user-initiated activation into a turn", () => {
    const userActivate: ThreadEntry = {
      entry: "Skill",
      data: { kind: "Activate", name: "pdf-tools", actor: "User" },
    };
    expect(agentActivationOwner([userActivate, turn])).toEqual([null, null]);
  });

  it("never absorbs a contract-violating non-Activate event stamped with the agent actor", () => {
    // The wire contract says the actor is present IFF Activate; a Mount
    // carrying actor "Agent" can only come from a hand-edited or imported
    // recipe. The kind guard keeps it on the honest standalone path instead
    // of absorbing it into a turn it did not happen inside.
    const mountByAgent: ThreadEntry = {
      entry: "Skill",
      data: { kind: "Mount", name: "pdf-tools", actor: "Agent" },
    };
    expect(agentActivationOwner([mountByAgent, turn])).toEqual([null, null]);
  });
});

// The absorbed-activation half of the run-position contract (issue #722):
// an activation absorbed into its turn -- settled owner or live -- never
// enters the standalone line, so it carries null and breaks the run around
// it exactly like a turn does. The Thread DOM pins never read the mark on
// an absorbed entry (the standalone row returns early), so this half is
// only observable here, same as the null-for-turns half above.

describe("lifecycleRunMarks (absorbed-activation contract)", () => {
  it("stamps null on a settled-owned activation and breaks the run around it", () => {
    const entries = [skill("Mount"), agentActivate("python"), skill("Unmount"), turn];
    expect(agentActivationOwner(entries)).toEqual([null, 3, null, null]);
    // The Mount/Unmount on either side are lone standalone nodes -- the line
    // never crosses the turn that swallowed the activation.
    expect(marksOf(entries, agentActivationOwner(entries))).toEqual([
      "single",
      null,
      "single",
      null,
    ]);
  });

  it("flushes the run on a live-owned activation the same as a settled one", () => {
    // "live" is an owner too while the turn runs -- the flush must treat it
    // identically to a settled owner index (not just any number).
    const entries = [skill("Mount"), agentActivate("python"), skill("Unmount")];
    const owners = agentActivationOwner(entries, true);
    expect(owners).toEqual([null, "live", null]);
    expect(marksOf(entries, owners)).toEqual(["single", null, "single"]);
  });
});

// The per-turn attribution gate (issue #818), pinned at the pure seam:
// which runtimes earn a marker. The optimistic append stamps the ask-time
// runtime choice (issue #725), but the choice-unknown degradation and a
// crashed pre-read both still mint unrecorded turns -- every silent shape
// is a live state, pinned here alongside the naming rule.

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
// owned-break fixture is the breakpoint predicate's pin (dropping the
// owned[i] != null flush merges the halves into one fold of four).

const srcNamed = (
  name: string,
  kind: "Added" | "Replaced" | "Deleted" = "Added",
): ThreadEntry => ({
  entry: "Source",
  data: { kind, reference_name: name, display_name: name },
});
const skillNamed = (
  name: string,
  kind: "Mount" | "Activate" | "Unmount" = "Mount",
): ThreadEntry => ({
  entry: "Skill",
  data: { kind, name, actor: null },
});
// The fold inputs only ever read has()/get() here, so a minimal cast keeps
// the fixture light (Thread.test.tsx exercises the full SkillEntry shape).
const registry = (...names: string[]): ReadonlyMap<string, SkillEntry> =>
  new Map(names.map((n) => [n, { name: n } as SkillEntry]));

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

  it("splits subsegments on species and kind; only same-(species × kind) runs fold", () => {
    const entries = [
      srcNamed("a"),
      skillNamed("pdf-tools"),
      skillNamed("pdf-tools"),
      skillNamed("pdf-tools"),
      srcNamed("b"),
      srcNamed("c", "Replaced"),
      srcNamed("d", "Replaced"),
    ];
    // Added(a) scatter | Mount×3 folds | Added(b) scatter | Replaced×2
    // scatter (kind change cuts even within the source species).
    const rows = lifecycleVisualRows(entries);
    const shape = (r: (typeof rows)[number]) =>
      r.row === "fold" ? { fold: [r.group.species, r.group.kind] } : r;
    expect(rows.map(shape)).toEqual([
      { row: "marker", idx: 0 },
      { fold: ["Skill", "Mount"] },
      { row: "marker", idx: 4 },
      { row: "marker", idx: 5 },
      { row: "marker", idx: 6 },
    ]);
  });

  it("breaks subsegments at a turn and at an activation its turn absorbed", () => {
    // Two Added pairs around a turn: neither half reaches the threshold and
    // the turn keeps them from merging into one fold of four.
    expect(
      lifecycleVisualRows([srcNamed("a"), srcNamed("b"), turn, srcNamed("c"), srcNamed("d")]).map(
        (r) => r.row,
      ),
    ).toEqual(["marker", "marker", "turn", "marker", "marker"]);

    // The absorbed activation occupies its visual slot (renders nothing) and
    // cuts the Mount run exactly like a turn: dropping the owned[i] != null
    // condition would emit the activation as a marker row instead (the row
    // shape above goes red), so the fixture pins the breakpoint predicate.
    const withOwned = [
      skillNamed("a"),
      skillNamed("b"),
      agentActivate("python"),
      skillNamed("c"),
      skillNamed("d"),
      turn,
    ];
    expect(lifecycleVisualRows(withOwned, agentActivationOwner(withOwned)).map((r) => r.row)).toEqual(
      ["marker", "marker", "absorbed", "marker", "marker", "turn"],
    );
  });

  it("sums invalidation counts onto the fold; an Added never contributes", () => {
    // Even a stale map keyed for an Added (impossible via StaleReason, but
    // the input is just a map) must not leak into the fold: the aggregation
    // skips Added members outright.
    const added = Array.from({ length: LIFECYCLE_FOLD_THRESHOLD }, (_, i) => srcNamed(`s${i}`));
    const noise = new Map([["s0:Added", 7]]);
    const addedRows = lifecycleVisualRows(added, [], { staleCountsByKey: noise });
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
    const replacedRows = lifecycleVisualRows(replaced, [], { staleCountsByKey });
    expect(replacedRows[0].row).toBe("fold");
    if (replacedRows[0].row !== "fold") return;
    expect(replacedRows[0].group.invalidatedCount).toBe(3);
  });

  it("counts drift only against a wired registry that lacks the name", () => {
    const mounts = [skillNamed("keep"), skillNamed("gone"), skillNamed("lost")];
    // Unwired: the caller opted out of drift detection entirely.
    const unwired = lifecycleVisualRows(mounts);
    expect(unwired[0].row).toBe("fold");
    if (unwired[0].row !== "fold") return;
    expect(unwired[0].group.driftCount).toBe(0);
    // Wired with only "keep": two of three names are gone.
    const wired = lifecycleVisualRows(mounts, [], { skillIndex: registry("keep") });
    expect(wired[0].row).toBe("fold");
    if (wired[0].row !== "fold") return;
    expect(wired[0].group.driftCount).toBe(2);
  });

  it("treats a fold row as its segment's single node (marks over the projection)", () => {
    // marker(Added) | marker(Mount) | fold(Added×3): one mixed run of three
    // VISUAL rows -- the fold participates like any node, so its connector
    // derives from the same projection the render consumes (single source).
    const entries = [
      srcNamed("a"),
      skillNamed("pdf-tools"),
      srcNamed("b"),
      srcNamed("c"),
      srcNamed("d"),
    ];
    expect(marksOf(entries)).toEqual(["first", "mid", "last"]);
  });
});
