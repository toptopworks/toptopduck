import { describe, expect, it } from "vitest";
import {
  WORKSPACE_MIN_WIDTH,
  railMaxWidth,
  sidebarMaxWidth,
} from "../layoutBounds";

// layoutBounds pins the issue-#770 width algebra: the 320px workspace floor
// and the availability-derived column ceilings. These formulas are the single
// source the App getters consume (and the CSS --workspace-min-width mirrors
// in styles.css), so pinning the arithmetic with literals here turns silent
// threshold drift into a conscious test update.

describe("layoutBounds", () => {
  it("pins the workspace floor at 320 (minimum usable column convention)", () => {
    expect(WORKSPACE_MIN_WIDTH).toBe(320);
  });

  it("sidebar ceiling = shell width − rail floor − workspace floor", () => {
    // Default 1024px window: 1024 − 280 − 320 = 424.
    expect(sidebarMaxWidth(1024)).toBe(424);
    // New minimum window width 840: 840 − 600 = 240 — still above the 238
    // static floor, so all three column floors stay simultaneously
    // satisfiable at the narrowest legal window.
    expect(sidebarMaxWidth(840)).toBe(240);
  });

  it("rail ceiling = track-host width − workspace floor", () => {
    // 1024px shell with a 238px sidebar: the track host (main area) is 786px
    // wide → the rail can grow to 786 − 320 = 466.
    expect(railMaxWidth(786)).toBe(466);
  });
});
