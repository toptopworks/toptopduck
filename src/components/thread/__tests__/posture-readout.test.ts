import { describe, expect, it } from "vitest";

import { derivePostureReadout } from "../posture-readout";
import type { PostureReadoutReads } from "../posture-readout";

// posture-readout tests: the trigger's readout verdict as a pure
// projection. Each pin is one mutation the mounted suite used to pay the
// full-tree tax for -- the label chain's fixes (#1648/#584) land on single
// assertions here.

const reads = (
  posture: Partial<PostureReadoutReads["posture"]> = {},
  rest: Partial<PostureReadoutReads> = {},
): PostureReadoutReads => ({
  posture: { model: null, thought_level: null, ...posture },
  isExternal: false,
  noProfiles: false,
  builtInModel: null,
  ...rest,
});

describe("derivePostureReadout", () => {
  it("built-in arm: held pair first, the pinned model backs the model half, honest states past it", () => {
    expect(
      derivePostureReadout(
        reads({ model: "m-1", thought_level: "high" }, { builtInModel: "pinned" }),
      ),
    ).toEqual({ labelKind: { kind: "held", parts: ["m-1", "high"] }, tooltipModel: "m-1" });
    // An unselected model runs the pinned model next turn (ADR-0154): a
    // lone held strength reads "{pinned} · {strength}" (issue #1648).
    expect(derivePostureReadout(reads({ thought_level: "high" }, { builtInModel: "pinned" }))).toEqual({
      labelKind: { kind: "held", parts: ["pinned", "high"] },
      tooltipModel: "pinned",
    });
    expect(derivePostureReadout(reads({}, { builtInModel: "pinned" }))).toEqual({
      labelKind: { kind: "held", parts: ["pinned"] },
      tooltipModel: "pinned",
    });
    // An unpinned profile with a lone held strength keeps its bare-strength
    // label while the tooltip half stays null -- the one built-in input
    // where the two halves diverge.
    expect(derivePostureReadout(reads({ thought_level: "high" }))).toEqual({
      labelKind: { kind: "held", parts: ["high"] },
      tooltipModel: null,
    });
    // An unpinned profile with nothing held: the next turn refuses.
    expect(derivePostureReadout(reads())).toEqual({
      labelKind: { kind: "noModel" },
      tooltipModel: null,
    });
    // Zero profiles: never a fake default.
    expect(derivePostureReadout(reads({}, { noProfiles: true }))).toEqual({
      labelKind: { kind: "notConfigured" },
      tooltipModel: null,
    });
  });

  it("external arm: the held pair's three forms, the default verdict when nothing is held", () => {
    expect(
      derivePostureReadout(reads({ model: "m-1", thought_level: "high" }, { isExternal: true })),
    ).toEqual({ labelKind: { kind: "held", parts: ["m-1", "high"] }, tooltipModel: null });
    // Either side omitted when unset: a lone model ...
    expect(derivePostureReadout(reads({ model: "m-1" }, { isExternal: true }))).toEqual({
      labelKind: { kind: "held", parts: ["m-1"] },
      tooltipModel: null,
    });
    // ... and a lone thought level is its own honest form (issue #584).
    expect(derivePostureReadout(reads({ thought_level: "medium" }, { isExternal: true }))).toEqual({
      labelKind: { kind: "held", parts: ["medium"] },
      tooltipModel: null,
    });
    expect(derivePostureReadout(reads({}, { isExternal: true }))).toEqual({
      labelKind: { kind: "defaultRecommended" },
      tooltipModel: null,
    });
    // The external arm pins the tooltip half null even with a pinned
    // built-in profile -- the external tooltip never reads this half.
    expect(
      derivePostureReadout(reads({}, { isExternal: true, builtInModel: "pinned" })),
    ).toEqual({
      labelKind: { kind: "defaultRecommended" },
      tooltipModel: null,
    });
  });

  it("the blank=unset convention rides the chain: a hand-edited blank cannot blank either face", () => {
    // The label falls to the pinned model past a blank ...
    expect(
      derivePostureReadout(reads({ model: "", thought_level: "high" }, { builtInModel: "pinned" })),
    ).toEqual({ labelKind: { kind: "held", parts: ["pinned", "high"] }, tooltipModel: "pinned" });
    // ... and a held model outranks a blank pinned slot.
    expect(derivePostureReadout(reads({ model: "m-1" }, { builtInModel: "" }))).toEqual({
      labelKind: { kind: "held", parts: ["m-1"] },
      tooltipModel: "m-1",
    });
  });
});
