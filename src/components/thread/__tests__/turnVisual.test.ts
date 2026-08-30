import { describe, expect, it } from "vitest";

import { agentActivationOwner, lifecycleRunMarks, runtimeSegmentBadges } from "../turn-visual";
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
    expect(lifecycleRunMarks(entries, agentActivationOwner(entries))).toEqual([
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
    expect(lifecycleRunMarks(entries, owners)).toEqual(["single", null, "single"]);
  });
});

// The ADR-0101 segment gate, pinned at the pure seam: which entries open a
// runtime segment and carry its badge. The optimistic append stamps the
// ask-time runtime choice (issue #725), but the choice-unknown degradation
// and a crashed pre-read both still mint unrecorded turns -- so the
// "unrecorded turn inside an external thread" shape is a live state, pinned
// here alongside the gate it must break.

describe("runtimeSegmentBadges (ADR-0101 segment gate)", () => {
  // Narrowed to the Turn entry so the runtime reads below type-check without
  // a per-assertion tag guard (the fixture always mints the Turn variant).
  const runtimeTurn = (runtime: TurnRuntime): Extract<ThreadEntry, { entry: "Turn" }> => ({
    ...turn,
    data: { ...turn.data, provenance: { skills: [], runtime } },
  });
  const external = (adapterId: string): TurnRuntime => ({
    kind: "external",
    data: { adapter_id: adapterId },
  });

  it("renders no badges anywhere while the thread holds no external runtime", () => {
    const builtIn = runtimeTurn({ kind: "built_in" });
    // Built-in and unrecorded alike: the has-external gate stays closed, so
    // no segment ever opens (the optimistic stamp must not flip this).
    expect(runtimeSegmentBadges([builtIn, turn, builtIn])).toEqual([null, null, null]);
    expect(runtimeSegmentBadges([turn])).toEqual([null]);
  });

  it("keeps one badge per segment; an unrecorded turn renders none but still breaks it", () => {
    // external | unrecorded | same adapter again: the middle turn carries no
    // badge (no fabrication) yet closes the segment, so the following turn
    // re-announces the SAME adapter -- the degradation is visible as a
    // segment break, never as a silent merge across the gap.
    const a = runtimeTurn(external("claude-code"));
    expect(runtimeSegmentBadges([a, turn, a])).toEqual([a.data.provenance.runtime, null, a.data.provenance.runtime]);
    // Two consecutive recorded turns on one adapter are one segment.
    expect(runtimeSegmentBadges([a, a])).toEqual([a.data.provenance.runtime, null]);
  });

  it("re-announces on an adapter change even while the gate stays open on one external", () => {
    const a = runtimeTurn(external("claude-code"));
    const b = runtimeTurn(external("codex"));
    expect(runtimeSegmentBadges([a, b])).toEqual([
      a.data.provenance.runtime,
      b.data.provenance.runtime,
    ]);
  });

  it("re-announces the built-in segment head after the common in-session switch (#725 AC2)", () => {
    // built-in -> external is the shape an in-session switch then first ask
    // stamps (the optimistic append carries the new choice): the built-in
    // turn opens a segment too -- in a mixed thread the reader must be able
    // to tell who ran which stretch.
    const bi = runtimeTurn({ kind: "built_in" });
    const b = runtimeTurn(external("codex"));
    expect(runtimeSegmentBadges([bi, b])).toEqual([
      bi.data.provenance.runtime,
      b.data.provenance.runtime,
    ]);
  });
});
