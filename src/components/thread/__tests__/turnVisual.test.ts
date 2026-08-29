import { describe, expect, it } from "vitest";

import { lifecycleRunMarks } from "../turn-visual";
import type { ThreadEntry } from "../../../types/thread";

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
    expect(lifecycleRunMarks(entries)).toEqual([
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
    expect(lifecycleRunMarks([turn, skill("Activate"), turn])).toEqual([null, "single", null]);
  });

  it("returns all null for a turn-only thread (consecutive turns no-op)", () => {
    expect(lifecycleRunMarks([turn, turn])).toEqual([null, null]);
  });

  it("returns an empty array for an empty thread", () => {
    expect(lifecycleRunMarks([])).toEqual([]);
  });
});
