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

/** Simulated shell width (px) — the default window width; mutable because
 *  the entry-3 scenario shrinks the window mid-test. */
let shellWidth = 1024;

// Bridge standing in for the measured DOM: the rail's ceiling reads the
// track host (shell minus sidebar) and lags one drag event behind the
// sidebar state, exactly like clientWidth does (the pointermove handler
// compensates the rail before React re-renders). Updating it inside
// onDelta — after adjustWidth has read the previous value — reproduces
// that one-event lag.
let sidebarWidthLive = SIDEBAR_DEFAULT_WIDTH;

// Stand-in for the measured track host: the harness mounts no real DOM, so a
// detached element satisfies the observeTarget contract (#781). jsdom has no
// ResizeObserver; the stub records the rail's observer callback so tests can
// fire the observe-time initial callback after syncing the bridge (which
// stands in for the layout having settled).
const trackHostTarget: React.RefObject<HTMLElement | null> = {
  current: document.createElement("div"),
};

let fireRailContainerChange: (() => void) | undefined;

class ResizeObserverStub {
  constructor(callback: () => void) {
    fireRailContainerChange = callback;
  }

  observe(): void {}

  unobserve(): void {}

  disconnect(): void {}
}

function useColumnPair() {
  const rail = useRailResize({
    getMaxWidth: () => railMaxWidth(shellWidth - sidebarWidthLive),
    observeTarget: trackHostTarget,
  });
  const sidebar = useSidebarResize({
    onDelta: (delta) => {
      rail.adjustWidth(-delta);
      sidebarWidthLive += delta;
    },
    getMaxWidth: () => sidebarMaxWidth(shellWidth),
  });
  return { sidebar, rail };
}

describe("column resize composition", () => {
  beforeEach(() => {
    localStorage.clear();
    shellWidth = 1024;
    sidebarWidthLive = SIDEBAR_DEFAULT_WIDTH;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fireRailContainerChange = undefined;
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
      shellWidth - 320,
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

  // --- Window-shrink re-clamp entries (issue #781) ------------------------

  it("a restored wide sidebar's settled layout re-clamps the rail on mount (entry 1)", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    localStorage.setItem("toptopduck.sidebar-width", "518");
    const { result } = renderHook(() => useColumnPair());
    // Sidebar restore: min(518, sidebarMaxWidth(1024) = 424) -> 424, which
    // leaves a 600px track host — the rail's default 350 no longer fits.
    expect(result.current.sidebar.width).toBe(424);
    // The layout settles at the restored sidebar, then the rail's initial
    // container observation re-clamps 350 -> 280.
    sidebarWidthLive = 424;
    act(() => fireRailContainerChange?.());
    expect(result.current.rail.width).toBe(280);
    // 424 + 280 = 1024 - 320: the workspace keeps exactly its floor.
    expect(result.current.sidebar.width + result.current.rail.width).toBe(
      shellWidth - 320,
    );
  });

  it("the factory window layout re-clamps the rail on mount (entry 2)", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    shellWidth = 840;
    const { result } = renderHook(() => useColumnPair());
    // Factory entry: no stored sidebar, both columns at their defaults.
    expect(result.current.sidebar.width).toBe(SIDEBAR_DEFAULT_WIDTH);
    // The layout settles (H = 840 - 238 = 602 -> ceiling 282) and the
    // rail's initial container observation re-clamps 350 -> 282. The
    // bridge already reads the factory sidebar, so no manual sync needed.
    act(() => fireRailContainerChange?.());
    expect(result.current.rail.width).toBe(282);
    // 238 + 282 = 840 - 320: the workspace keeps exactly its floor.
    expect(result.current.sidebar.width + result.current.rail.width).toBe(
      shellWidth - 320,
    );
  });

  it("a window shrink re-clamps the sidebar via window resize and the rail via the container observation (entry 3)", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    shellWidth = 1920;
    const { result } = renderHook(() => useColumnPair());
    // Widen both columns to their static maxima (1920 fits both).
    act(() => {
      result.current.sidebar.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 518 }));
    });
    expect(result.current.sidebar.width).toBe(518);
    expect(result.current.rail.width).toBe(280); // compensation bottomed out
    act(() => {
      result.current.rail.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 700,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1020 }));
    });
    expect(result.current.rail.width).toBe(600);
    // Snap-style shrink to 840: the sidebar re-clamps in the window-resize
    // event (518 -> 240), and that path does NOT flow through onDelta —
    // only the rail's own container observation closes the loop.
    shellWidth = 840;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.sidebar.width).toBe(240);
    sidebarWidthLive = 240; // layout settled at the re-clamped sidebar
    act(() => fireRailContainerChange?.());
    expect(result.current.rail.width).toBe(280);
    expect(result.current.sidebar.width + result.current.rail.width).toBe(
      shellWidth - 320,
    );
  });
});
