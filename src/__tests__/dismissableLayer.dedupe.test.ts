import { describe, it, expect } from "vitest";
import lockfile from "../../package-lock.json";

// #518 regression pin: the whole app froze (body kept `pointer-events: none`)
// because react-menu (under the dropdown) and react-dialog resolved TWO copies
// of @radix-ui/react-dismissable-layer — each module instance keeps its own
// module-level `originalBodyPointerEvents` bookkeeping, and the dialog copy
// captured the menu-poisoned "none" as the "original" value, restoring it
// after every layer had closed. A single copy makes the bookkeeping sound.
//
// This guard is intentionally structural (lockfile), not behavioral: it pins
// the ROOT CAUSE and fails at test time the moment any radix upgrade splits
// the dismissable-layer versions again — no jsdom/Radix rendering involved.

const LAYER = "node_modules/@radix-ui/react-dismissable-layer";

describe("react-dismissable-layer dedupe (#518)", () => {
  it("resolves as a single top-level copy for all radix consumers", () => {
    const entries = Object.keys(lockfile.packages).filter((key) =>
      key.endsWith(LAYER),
    );
    // Exactly one entry, and it must be the top-level one (no nested copy
    // under any radix package).
    expect(entries).toEqual([LAYER]);
  });
});
