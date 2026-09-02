import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAIL_DEFAULT_WIDTH, useRailResize } from "../useRailResize";

// useRailResize owns the rail's draggable pixel width: delta-based pointer
// drag (the rail sits after the sidebar so clientX can't map directly),
// ephemeral state (no persistence — resets on mount), and the sidebar-
// compensation entry point (adjustWidth with a lower COMPENSATED_MIN_WIDTH
// floor). These tests pin the contracts hardest to verify through the App
// black-box: delta drag math, dual-floor clamp asymmetry, and the drag
// lifecycle (start → move → end / cancel).

describe("useRailResize", () => {
  beforeEach(() => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Initial state ----------------------------------------------------

  it("starts at the default width on mount", () => {
    const { result } = renderHook(() => useRailResize());
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
    expect(result.current.isDragging).toBe(false);
  });

  // --- Delta-based drag lifecycle (start → move → end) -------------------

  it("enters dragging state + sets body cursor on pointerdown", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    expect(result.current.isDragging).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
  });

  it("updates width by delta on pointermove, clamped to range", () => {
    const { result } = renderHook(() => useRailResize());
    // Pointer down at clientX=500; rail starts at default (350).
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });

    // Move right by 100 → width should be 350 + 100 = 450.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }));
    });
    expect(result.current.width).toBe(450);

    // Move left past the floor (delta = 200 - 500 = -300 → 350 - 300 = 50 → clamped to 350).
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 200 }));
    });
    expect(result.current.width).toBe(350);

    // Move right past the ceiling (delta = 1000 - 500 = 500 → 350 + 500 = 850 → clamped to 600).
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1000 }));
    });
    expect(result.current.width).toBe(600);
  });

  it("does not update width on pointermove when not dragging", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }));
    });
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
  });

  it("exits dragging + restores body cursor on pointerup", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 600 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });

    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("restores body cursor on pointercancel (touch gesture abort)", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    expect(document.body.style.cursor).toBe("col-resize");

    act(() => {
      window.dispatchEvent(new PointerEvent("pointercancel"));
    });

    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("does not change state on pointerup when no drag was active", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    expect(result.current.isDragging).toBe(false);
  });

  // --- Cleanup ----------------------------------------------------------

  it("restores body styles on unmount mid-drag", () => {
    const { result, unmount } = renderHook(() => useRailResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    expect(document.body.style.cursor).toBe("col-resize");

    unmount();

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  // --- adjustWidth (sidebar compensation) -------------------------------

  it("adjustWidth with negative delta shrinks the rail", () => {
    const { result } = renderHook(() => useRailResize());
    // Default width is 350.
    act(() => {
      result.current.adjustWidth(-50);
    });
    expect(result.current.width).toBe(300);
  });

  it("adjustWidth clamps to COMPENSATED_MIN_WIDTH (280), not MIN_WIDTH (350)", () => {
    const { result } = renderHook(() => useRailResize());
    // Push from 350 down past 280 — should stop at 280, not 350.
    act(() => {
      result.current.adjustWidth(-100);
    });
    expect(result.current.width).toBe(280);

    // Further push stays at 280.
    act(() => {
      result.current.adjustWidth(-50);
    });
    expect(result.current.width).toBe(280);
  });

  it("adjustWidth clamps to MAX_WIDTH (600) on large positive delta", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      result.current.adjustWidth(500);
    });
    expect(result.current.width).toBe(600);
  });

  it("adjustWidth with zero delta does not change width", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      result.current.adjustWidth(0);
    });
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
  });

  // --- Direct drag after compensation (no snap — review I2) --------------

  it("direct drag after compensation to 280 does not snap to 350", () => {
    const { result } = renderHook(() => useRailResize());
    // Simulate sidebar compensation pushing rail to 280.
    act(() => {
      result.current.adjustWidth(-70);
    });
    expect(result.current.width).toBe(280);

    // Now start a direct drag from 280.
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 400,
      } as unknown as React.PointerEvent);
    });

    // Move right by 10px — should be 290, NOT snapped to 350.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 410 }));
    });
    expect(result.current.width).toBe(290);
  });

  it("direct drag from 280 clamps at 280 when moving left (no further shrink)", () => {
    const { result } = renderHook(() => useRailResize());
    act(() => {
      result.current.adjustWidth(-70);
    });
    expect(result.current.width).toBe(280);

    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 400,
      } as unknown as React.PointerEvent);
    });

    // Move left by 50px — effective floor is 280 (startWidthRef), should stay.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 350 }));
    });
    expect(result.current.width).toBe(280);
  });

  // --- Dynamic availability ceiling (issue #770) -------------------------

  it("clamps pointermove to the dynamic max when it is below the static max", () => {
    const { result } = renderHook(() =>
      useRailResize({ getMaxWidth: () => 466 }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    // 350 + 500 = 850 → min(600, 466) = 466.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1000 }));
    });
    expect(result.current.width).toBe(466);
  });

  it("keeps the static max when the dynamic max is above it", () => {
    const { result } = renderHook(() =>
      useRailResize({ getMaxWidth: () => 4000 }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1000 }));
    });
    expect(result.current.width).toBe(600);
  });

  it("falls back to the static max when the getter returns undefined", () => {
    const { result } = renderHook(() =>
      useRailResize({ getMaxWidth: () => undefined }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1000 }));
    });
    expect(result.current.width).toBe(600);
  });

  it("adjustWidth respects the dynamic max on positive delta", () => {
    const { result } = renderHook(() =>
      useRailResize({ getMaxWidth: () => 466 }),
    );
    act(() => {
      result.current.adjustWidth(500);
    });
    expect(result.current.width).toBe(466);
  });
});
