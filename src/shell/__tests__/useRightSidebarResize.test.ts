import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRightSidebarResize } from "../useRightSidebarResize";

const STORAGE_KEY = "toptopduck.right-sidebar-width";

// useRightSidebarResize owns the right sidebar's EXPLICIT draggable pixel
// width (issue #1685): lazy-init from localStorage (or the viewport-derived
// default), pointer-driven resize with clamp, persistence on pointerup, the
// #1303 preference/render split, and the container observation that keeps
// the rendered width within the availability ceiling. These tests pin the
// contracts: clamp boundaries, persistence round-trip, the inverted
// boundary drag (the handle sits on the panel's LEFT edge — dragging left
// grows the panel), and the degradation paths.

// jsdom reports documentElement.clientWidth as 0 — the zero-viewport
// default bottoms out at the 360 clamp floor.
const ZERO_VIEWPORT_DEFAULT = 360;
const STATIC_MIN = 300;
const STATIC_MAX = 1200;

function setViewportWidth(px: number): void {
  Object.defineProperty(window.document.documentElement, "clientWidth", {
    configurable: true,
    value: px,
  });
}

describe("useRightSidebarResize", () => {
  beforeEach(() => {
    localStorage.clear();
    setViewportWidth(0);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setViewportWidth(0);
  });

  // --- Initial state + localStorage init --------------------------------

  it("starts at the clamp floor (zero viewport × 0.42) when no stored value exists", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    expect(result.current.width).toBe(ZERO_VIEWPORT_DEFAULT);
    expect(result.current.isDragging).toBe(false);
  });

  it("derives the default from the viewport (clamp(viewport × 0.42, 360, 640))", () => {
    setViewportWidth(1000);
    const { result } = renderHook(() => useRightSidebarResize());
    expect(result.current.width).toBe(420);
  });

  it("restores a valid stored width on mount", () => {
    localStorage.setItem(STORAGE_KEY, "500");
    const { result } = renderHook(() => useRightSidebarResize());
    expect(result.current.width).toBe(500);
  });

  it("clamps a stored width below the minimum to the minimum", () => {
    localStorage.setItem(STORAGE_KEY, "100");
    const { result } = renderHook(() => useRightSidebarResize());
    expect(result.current.width).toBe(STATIC_MIN);
  });

  it("clamps a stored width above the maximum to the maximum", () => {
    localStorage.setItem(STORAGE_KEY, "9999");
    const { result } = renderHook(() => useRightSidebarResize());
    expect(result.current.width).toBe(STATIC_MAX);
  });

  it("falls back to the viewport default when localStorage holds a non-numeric value", () => {
    localStorage.setItem(STORAGE_KEY, "not-a-number");
    const { result } = renderHook(() => useRightSidebarResize());
    expect(result.current.width).toBe(ZERO_VIEWPORT_DEFAULT);
  });

  it("falls back to the viewport default when localStorage throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useRightSidebarResize());
    expect(result.current.width).toBe(ZERO_VIEWPORT_DEFAULT);
  });

  // --- Inverted delta drag lifecycle (start → move → end) ---------------

  it("enters dragging state + sets body cursor on pointerdown", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    expect(result.current.isDragging).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
  });

  it("captures the pointer on drag start", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    const capture = vi.fn();
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        pointerId: 7,
        currentTarget: { setPointerCapture: capture },
      } as unknown as React.PointerEvent);
    });
    expect(capture).toHaveBeenCalledWith(7);
  });

  it("grows the width when the pointer moves LEFT (handle on the panel's left edge)", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    // 100px left: width = start (360) + (800 − 700) = 460.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 700 }));
    });
    expect(result.current.width).toBe(460);
  });

  it("shrinks the width when the pointer moves RIGHT", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 900 }));
    });
    // 360 − 100 = 260 → below the floor → 300.
    expect(result.current.width).toBe(STATIC_MIN);
  });

  it("does not update width on pointermove when not dragging", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 700 }));
    });
    expect(result.current.width).toBe(ZERO_VIEWPORT_DEFAULT);
  });

  it("exits dragging + persists width + restores body cursor on pointerup", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 700 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("460");
  });

  it("restores body cursor on pointercancel (touch gesture abort)", () => {
    const { result } = renderHook(() => useRightSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointercancel"));
    });
    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });

  it("does not persist width on pointerup when no drag was active", () => {
    renderHook(() => useRightSidebarResize());
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("restores body styles on unmount mid-drag", () => {
    const { result, unmount } = renderHook(() => useRightSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    unmount();
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  // --- Dynamic availability ceiling (issue #770 merge pattern) ----------

  it("clamps a drag to the dynamic max when it is below the static max", () => {
    const { result } = renderHook(() =>
      useRightSidebarResize({ getMaxWidth: () => 424 }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100 }));
    });
    // Requested 360 + 700 = far above 424 → clamped to the ceiling.
    expect(result.current.width).toBe(424);
  });

  it("keeps the static max when the dynamic max is above it", () => {
    // Seed 1100 so the inverted drag (startX 800 → 100 adds 700) swings
    // past the static ceiling instead of stopping mid-range.
    localStorage.setItem(STORAGE_KEY, "1100");
    const { result } = renderHook(() =>
      useRightSidebarResize({ getMaxWidth: () => 4000 }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100 }));
    });
    expect(result.current.width).toBe(STATIC_MAX);
  });

  it("falls back to the static max when the getter returns undefined", () => {
    localStorage.setItem(STORAGE_KEY, "1100");
    const { result } = renderHook(() =>
      useRightSidebarResize({ getMaxWidth: () => undefined }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 100 }));
    });
    expect(result.current.width).toBe(STATIC_MAX);
  });

  it("restore clamp bottoms out at the static minimum, never below it", () => {
    localStorage.setItem(STORAGE_KEY, "400");
    const { result } = renderHook(() =>
      useRightSidebarResize({ getMaxWidth: () => 100 }),
    );
    expect(result.current.width).toBe(STATIC_MIN);
  });

  // --- #1303 preference/render split ------------------------------------

  it("re-clamps the live width on window shrink, then springs back on widen", () => {
    localStorage.setItem(STORAGE_KEY, "424");
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useRightSidebarResize({ getMaxWidth }),
      { initialProps: { getMaxWidth: () => 424 } },
    );
    expect(result.current.width).toBe(424);

    rerender({ getMaxWidth: () => 240 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(STATIC_MIN);
    // The stored preference keeps the pre-shrink value (#1303).
    expect(localStorage.getItem(STORAGE_KEY)).toBe("424");

    rerender({ getMaxWidth: () => 424 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(424);
  });

  it("persists the user's drag width even when a mid-drag shrink re-rendered narrower", () => {
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useRightSidebarResize({ getMaxWidth }),
      { initialProps: { getMaxWidth: () => 424 } },
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 800,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 700 }));
    });
    expect(result.current.width).toBe(424);

    // Mid-drag ceiling drop: rendered caps, the preference holds.
    rerender({ getMaxWidth: () => 240 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(STATIC_MIN);

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    // The release persists the drag's clamped target (424 — the ceiling
    // owned the requested 460), not the mid-drag capped render (#1303: a
    // drag write is user-owned at the clamped value).
    expect(localStorage.getItem(STORAGE_KEY)).toBe("424");

    rerender({ getMaxWidth: () => 424 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(424);
  });

  // --- Container observation (issue #781 pattern) ------------------------

  it("re-derives the rendered width when the observed container changes", () => {
    let fireContainerChange: (() => void) | undefined;
    class ResizeObserverStub {
      constructor(callback: () => void) {
        fireContainerChange = callback;
      }

      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);

    localStorage.setItem(STORAGE_KEY, "600");
    const target = { current: null } as React.RefObject<HTMLElement | null>;
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useRightSidebarResize({ getMaxWidth, observeTarget: target }),
      { initialProps: { getMaxWidth: () => 700 } },
    );
    expect(result.current.width).toBe(600);

    // The container (track host) settles narrower: the ceiling drops below
    // the preference and the rendered width re-derives without a window
    // resize event (the sidebar-drag path).
    rerender({ getMaxWidth: () => 500 });
    act(() => {
      fireContainerChange?.();
    });
    expect(result.current.width).toBe(500);
    // The preference survives (#1303).
    expect(localStorage.getItem(STORAGE_KEY)).toBe("600");
  });

  it("keeps the initial rendered width when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    localStorage.setItem(STORAGE_KEY, "600");
    const target = { current: null } as React.RefObject<HTMLElement | null>;
    const { result } = renderHook(() =>
      useRightSidebarResize({ getMaxWidth: () => 700, observeTarget: target }),
    );
    expect(result.current.width).toBe(600);
  });
});
