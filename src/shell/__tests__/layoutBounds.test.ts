import { describe, expect, it } from "vitest";
import {
  COMPENSATED_MIN_WIDTH,
  RIGHT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  rightSidebarDefaultWidth,
  rightSidebarMaxWidth,
  sidebarMaxWidth,
} from "../layoutBounds";

// layoutBounds pins the issue-#1685 width algebra: the negotiated explicit
// right sidebar (default clamp + 300px floor + 1200px static ceiling + the
// 420px conversation protection floor baked into its dynamic ceiling), and
// the sidebar ceiling. These formulas are the single source the App getters
// consume (and the CSS --right-sidebar-width fallback mirrors in
// styles.css), so pinning the arithmetic with literals here turns silent
// threshold drift into a conscious test update.

describe("layoutBounds", () => {
  it("pins the right-sidebar floor at 300 (negotiated minimum)", () => {
    expect(RIGHT_SIDEBAR_MIN_WIDTH).toBe(300);
  });

  it("pins the conversation protection floor at 420", () => {
    // The conversation column's protected floor, enforced through the right
    // sidebar's dynamic ceiling (track host − 420) rather than a drag floor.
    expect(COMPENSATED_MIN_WIDTH).toBe(420);
  });

  it("pins the right-sidebar static ceiling at 1200", () => {
    expect(RIGHT_SIDEBAR_MAX_WIDTH).toBe(1200);
  });

  it("sidebar ceiling = shell width − conversation floor − right-sidebar floor", () => {
    // A 1024px shell: 1024 − 420 − 300 = 304.
    expect(sidebarMaxWidth(1024)).toBe(304);
    // Minimum window width 840: 840 − 720 = 120 — below the sidebar's own
    // 238 static floor, so the three column floors are NOT simultaneously
    // satisfiable at the narrowest legal window; the floors win in clamp
    // order and the grid overflows (the right sidebar still stops at its
    // minimum, per the issue #1685 AC).
    expect(sidebarMaxWidth(840)).toBe(120);
  });

  it("right-sidebar ceiling = min(1200, track host − conversation floor)", () => {
    // Default window 1200 with the factory sidebar 280: the track host is
    // 920px wide → 920 − 420 = 500.
    expect(rightSidebarMaxWidth(920)).toBe(500);
    // Wide host: the static ceiling binds.
    expect(rightSidebarMaxWidth(1620)).toBe(1200);
    // Narrow host: the negotiation still subtracts the full 420 protection;
    // the hook's rendered floor bottoms out at 300 instead.
    expect(rightSidebarMaxWidth(700)).toBe(280);
  });

  it("right-sidebar default = clamp(viewport × 0.42, 360, 640)", () => {
    // Default window: 1200 × 0.42 = 504.
    expect(rightSidebarDefaultWidth(1200)).toBe(504);
    // Narrow viewport floors at 360.
    expect(rightSidebarDefaultWidth(800)).toBe(360);
    // Wide viewport ceilings at 640.
    expect(rightSidebarDefaultWidth(2000)).toBe(640);
  });
});
