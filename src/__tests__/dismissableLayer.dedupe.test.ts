import { describe, it, expect } from "vitest";
import lockfile from "../../package-lock.json";

// #518 regression pin: the whole app froze (body kept `pointer-events: none`)
// because react-menu (under the dropdown) and react-dialog resolved TWO copies
// of @radix-ui/react-dismissable-layer — each module instance keeps its own
// module-level `originalBodyPointerEvents` bookkeeping AND its own
// `DismissableLayerContext`, so the dialog's layer set was empty at mount time
// (menu registered in a separate context) and it captured the menu-poisoned
// "none" as the "original" value, restoring it after every layer had closed.
// A single copy makes both the bookkeeping and the context sound.
//
// This guard is intentionally structural (lockfile), not behavioral: it pins
// the ROOT CAUSE and fails at test time the moment any radix upgrade splits
// the dismissable-layer versions again — no jsdom/Radix rendering involved.
//
// Scope: react-hover-card has the same module-level pattern for
// `body.style.userSelect` (`react-hover-card/dist/index.mjs`). This guard pins
// only dismissable-layer (the surface that caused #518); a future hover-card
// split would need its own guard.

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
