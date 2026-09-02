import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRailResize } from "../useRailResize";
import {
  SIDEBAR_DEFAULT_WIDTH,
  useSidebarResize,
} from "../useSidebarResize";
import { railMaxWidth, sidebarMaxWidth } from "../layoutBounds";

// The two resize hooks are tested in isolation elsewhere; what those suites
// cannot see is the composition App.tsx wires — the sidebar's onDelta
// feeding the rail's adjustWidth with the negated delta, and the two
// availability getters agreeing on one shell width. This harness mirrors
// that wiring and pins the cross-hook invariants: the workspace column
// staying visually fixed (the column sum constant) while neither column
// leaves its floor or ceiling. A sign flip or a getter swap in the wiring
// breaks these assertions while leaving every hook-isolation suite green.

/** Simulated shell width (px) — the default window width. */
const SHELL_WIDTH = 1024;

// Bridge standing in for the measured DOM: the rail's ceiling reads the
// track host (shell minus sidebar) and lags one drag event behind the
// sidebar state, exactly like clientWidth does (the pointermove handler
// compensates the rail before React re-renders). Updating it inside
// onDelta — after adjustWidth has read the previous value — reproduces
// that one-event lag.
let sidebarWidthLive = SIDEBAR_DEFAULT_WIDTH;

function useColumnPair() {
  const rail = useRailResize({
    getMaxWidth: () => railMaxWidth(SHELL_WIDTH - sidebarWidthLive),
  });
  const sidebar = useSidebarResize({
    onDelta: (delta) => {
      rail.adjustWidth(-delta);
      sidebarWidthLive += delta;
    },
    getMaxWidth: () => sidebarMaxWidth(SHELL_WIDTH),
  });
  return { sidebar, rail };
}

describe("column resize composition", () => {
  beforeEach(() => {
    localStorage.clear();
    sidebarWidthLive = SIDEBAR_DEFAULT_WIDTH;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a sidebar drag compensates the rail, keeping the column sum fixed", () => {
    const { result } = renderHook(() => useColumnPair());
    const sumBefore =
      result.current.sidebar.width + result.current.rail.width;
    act(() => {
      result.current.sidebar.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    });
    // 238 -> 300; the rail absorbs the 62px delta (350 -> 288) so the
    // two columns move as one and the workspace keeps its width.
    expect(result.current.sidebar.width).toBe(300);
    expect(result.current.rail.width).toBe(288);
    expect(result.current.sidebar.width + result.current.rail.width).toBe(
      sumBefore,
    );
  });

  it("the drag tops out exactly where the rail bottoms out, leaving the workspace its floor", () => {
    const { result } = renderHook(() => useColumnPair());
    act(() => {
      result.current.sidebar.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 9999 }),
      );
    });
    // 1024 - 424 - 280 = 320: the sidebar's availability ceiling and the
    // rail's compensated floor meet with exactly the workspace floor left.
    expect(result.current.sidebar.width).toBe(424);
    expect(result.current.rail.width).toBe(280);
    expect(result.current.sidebar.width + result.current.rail.width).toBe(
      SHELL_WIDTH - 320,
    );
  });

  it("narrowing the sidebar gives the width back to the rail", () => {
    const { result } = renderHook(() => useColumnPair());
    act(() => {
      result.current.sidebar.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 260 }));
    });
    expect(result.current.sidebar.width).toBe(260);
    // 288 + (300 - 260): the reverse delta flows back to the rail.
    expect(result.current.rail.width).toBe(328);
  });
});
