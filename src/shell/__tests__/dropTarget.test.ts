import { afterEach, describe, expect, it, vi } from "vitest";
import { isPointOverComposerBar } from "../dropTarget";
import { mountComposerBarStub, type BarRect } from "../../__tests__/setup/barRectStub";

// Unit tests for the drop-router DOM hit test (#501). Tauri's onDragDropEvent
// is a window-level signal with no hit test (#81), and its drop position is
// PHYSICAL pixels from the webview's top-left; the helper converts to CSS px
// via devicePixelRatio before comparing against the composer bar's rect.
// jsdom has no layout, so each test mounts a `.question-bar` element with a
// stubbed getBoundingClientRect (shared barRectStub).

const BAR_RECT: BarRect = { left: 100, top: 200, right: 400, bottom: 300 };

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isPointOverComposerBar (#501)", () => {
  it("returns true when the drop point is inside the bar rect", () => {
    mountComposerBarStub(BAR_RECT);
    expect(isPointOverComposerBar({ x: 250, y: 250 })).toBe(true);
  });

  it("returns false when the drop point is outside the bar rect", () => {
    mountComposerBarStub(BAR_RECT);
    // Top-left of the empty-state area, clear of the bar.
    expect(isPointOverComposerBar({ x: 20, y: 20 })).toBe(false);
    // Below the bar.
    expect(isPointOverComposerBar({ x: 250, y: 350 })).toBe(false);
    // Right of the bar.
    expect(isPointOverComposerBar({ x: 450, y: 250 })).toBe(false);
  });

  it("treats the rect boundary as inclusive", () => {
    mountComposerBarStub(BAR_RECT);
    expect(isPointOverComposerBar({ x: 100, y: 200 })).toBe(true);
    expect(isPointOverComposerBar({ x: 400, y: 300 })).toBe(true);
  });

  it("returns false when the composer bar is not mounted (fail-open)", () => {
    // No `.question-bar` in the DOM: the guard must not swallow the drop --
    // the ADR-0061 drop-to-create path stays alive.
    expect(isPointOverComposerBar({ x: 250, y: 250 })).toBe(false);
  });

  it("converts physical drop positions by devicePixelRatio", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    // CSS rect 100,100 -> 200,150; at scale 2 the physical footprint is
    // 200,200 -> 400,300.
    mountComposerBarStub({ left: 100, top: 100, right: 200, bottom: 150 });
    // Physical (300, 250) = CSS (150, 125): inside.
    expect(isPointOverComposerBar({ x: 300, y: 250 })).toBe(true);
    // Physical (150, 150) = CSS (75, 75): left of the bar.
    expect(isPointOverComposerBar({ x: 150, y: 150 })).toBe(false);
  });
});
