import { describe, expect, it } from "vitest";
import {
  computeToolbarPlacement,
  type Rect,
} from "../selectionSurfacePosition";

// The selection toolbar's placement math (#1573): anchor on the first
// selection rect intersecting the visible area, above preferred (8px gap,
// falls below when the headroom is short), clipped to the three boundaries
// -- viewport ∩ scroll containers ∩ composer floor.

function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

const VIEWPORT = rect(0, 0, 800, 600);
const TOOLBAR = { width: 120, height: 36 };

function place(overrides?: Partial<Parameters<typeof computeToolbarPlacement>[0]>) {
  return computeToolbarPlacement({
    viewport: VIEWPORT,
    clipRects: [],
    composerRect: null,
    anchorRects: [rect(300, 200, 500, 216)],
    toolbar: TOOLBAR,
    gap: 8,
    ...overrides,
  });
}

describe("computeToolbarPlacement", () => {
  it("places above the anchor's visible span, horizontally centered on it", () => {
    expect(place()).toEqual({
      left: 340, // (300 + 500 - 120) / 2
      top: 200 - 8 - 36, // above: anchor.top - gap - height
      maxWidth: 800,
    });
  });

  it("falls below when the headroom above the anchor is short", () => {
    expect(place({ anchorRects: [rect(300, 20, 500, 100)] })).toEqual({
      left: 340,
      top: 100 + 8, // below: anchor.bottom + gap
      maxWidth: 800,
    });
  });

  it("clips to the scroll container rect (first clip boundary)", () => {
    // The anchor's upper half scrolls out through the rail's top edge.
    const result = place({
      clipRects: [rect(0, 160, 760, 560)],
      anchorRects: [rect(300, 100, 500, 216)],
    });
    expect(result).toEqual({
      left: 340,
      top: 216 + 8, // above is clipped away -> below the anchor's tail
      maxWidth: 760,
    });
  });

  it("floors on the composer's top edge (third clip boundary)", () => {
    // A low anchor: above has no headroom and below-placement would land on
    // the composer, so the floor squeezes the toolbar against the
    // composer's top edge (84 -- without the floor the same anchor places
    // at 208, on top of the composer).
    expect(
      place({ composerRect: rect(40, 120, 760, 600), anchorRects: [rect(300, 20, 500, 200)] }),
    ).toEqual({ left: 340, top: 120 - 36, maxWidth: 800 });
    // The composer only floors when it horizontally overlaps the visible
    // area (a narrow bar past the right edge): the same anchor then places
    // below itself -- the floor alone made the difference.
    expect(
      place({ composerRect: rect(900, 120, 960, 600), anchorRects: [rect(300, 20, 500, 200)] }),
    ).toEqual({ left: 340, top: 200 + 8, maxWidth: 800 });
  });

  it("anchors on the first selection rect intersecting the visible area", () => {
    // Two rects: the first is fully scrolled out, the second is visible and
    // its headroom above the clip top is short, so it seats below itself.
    expect(
      place({
        clipRects: [rect(0, 300, 800, 600)],
        anchorRects: [rect(300, 100, 500, 150), rect(300, 320, 500, 336)],
      }),
    ).toEqual({ left: 340, top: 336 + 8, maxWidth: 800 });
  });

  it("returns null when the selection is fully clipped away", () => {
    expect(place({ clipRects: [rect(0, 400, 800, 500)] })).toBeNull();
  });

  it("returns null when the toolbar is taller than the visible area", () => {
    // The default anchor intersects the 20px-tall visible band, so the
    // null can only come from the height guard -- not the anchor-miss path.
    expect(place({ clipRects: [rect(0, 200, 800, 220)] })).toBeNull();
  });

  it("clamps the toolbar inside the visible area horizontally", () => {
    // Anchor's visible span sits at the far right edge: centering would
    // overflow, so the clamp pins the toolbar to the boundary.
    const result = place({ anchorRects: [rect(700, 200, 800, 216)] });
    expect(result?.left).toBe(800 - 120);
  });
});
