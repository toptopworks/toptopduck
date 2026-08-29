import { describe, expect, it } from "vitest";

import { agentActivationOwner, lifecycleRunMarks } from "../turn-visual";
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
});
