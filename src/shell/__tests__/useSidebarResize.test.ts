import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_DEFAULT_WIDTH, useSidebarResize } from "../useSidebarResize";

const STORAGE_KEY = "toptopduck.sidebar-width";

// useSidebarResize owns the sidebar's draggable pixel width: lazy-init from
// localStorage, pointer-driven resize with clamp, persistence on pointerup,
// and body cursor lifecycle. These tests pin the contracts hardest to verify
// through the App black-box: clamp boundaries, persistence round-trip,
// localStorage-unavailable degradation, and the drag lifecycle (start →
// move → end / cancel).

describe("useSidebarResize", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Initial state + localStorage init --------------------------------

  it("starts at the default width when no stored value exists", () => {
    const { result } = renderHook(() => useSidebarResize());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(result.current.isDragging).toBe(false);
  });

  it("restores a valid stored width on mount", () => {
    localStorage.setItem(STORAGE_KEY, "400");
    const { result } = renderHook(() => useSidebarResize());
    expect(result.current.width).toBe(400);
  });

  it("clamps a stored width below the minimum to the minimum", () => {
    localStorage.setItem(STORAGE_KEY, "100");
    const { result } = renderHook(() => useSidebarResize());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps a stored width above the maximum to the maximum", () => {
    localStorage.setItem(STORAGE_KEY, "9999");
    const { result } = renderHook(() => useSidebarResize());
    expect(result.current.width).toBe(518);
  });

  it("falls back to default when localStorage holds a non-numeric value", () => {
    localStorage.setItem(STORAGE_KEY, "not-a-number");
    const { result } = renderHook(() => useSidebarResize());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("falls back to default when localStorage throws on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useSidebarResize());
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  // --- Drag lifecycle (start → move → end) ------------------------------

  it("enters dragging state + sets body cursor on pointerdown", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    expect(result.current.isDragging).toBe(true);
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
  });

  it("updates width on pointermove while dragging, clamped to range", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });

    // Within range
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400 }));
    });
    expect(result.current.width).toBe(400);

    // Below minimum
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 50 }));
    });
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);

    // Above maximum
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 9999 }));
    });
    expect(result.current.width).toBe(518);
  });

  it("does not update width on pointermove when not dragging", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400 }));
    });
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("exits dragging + persists width + restores body cursor on pointerup", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });

    expect(result.current.isDragging).toBe(false);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("400");
  });

  it("restores body cursor on pointercancel (touch gesture abort)", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
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

  it("does not persist width on pointerup when no drag was active", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    expect(result.current.isDragging).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // --- Cleanup ----------------------------------------------------------

  it("restores body styles on unmount mid-drag", () => {
    const { result, unmount } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    expect(document.body.style.cursor).toBe("col-resize");

    unmount();

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  // --- onDelta callback (sidebar → rail compensation) -------------------

  it("fires onDelta with the per-frame delta during drag", () => {
    const deltas: number[] = [];
    const { result } = renderHook(() =>
      useSidebarResize({ onDelta: (d) => deltas.push(d) }),
    );

    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });

    // Sidebar starts at default (238). Move to 300 → delta = 62.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    });
    // Move to 350 → delta = 50.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 350 }));
    });

    expect(deltas).toEqual([62, 50]);
  });

  it("does not fire onDelta when delta is zero (clamped to same value)", () => {
    const onDelta = vi.fn();
    const { result } = renderHook(() => useSidebarResize({ onDelta }));

    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });

    // clientX below MIN_WIDTH → clamped to 238 (the current width) → delta = 0.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 50 }));
    });

    expect(onDelta).not.toHaveBeenCalled();
  });

  it("does not fire onDelta when not dragging", () => {
    const onDelta = vi.fn();
    renderHook(() => useSidebarResize({ onDelta }));

    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400 }));
    });

    expect(onDelta).not.toHaveBeenCalled();
  });

  it("fires negative delta when sidebar shrinks", () => {
    const deltas: number[] = [];
    const { result } = renderHook(() =>
      useSidebarResize({ onDelta: (d) => deltas.push(d) }),
    );

    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });

    // Move to 300 first (delta = 62).
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    });
    // Move back to 260 (delta = 260 - 300 = -40).
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 260 }));
    });

    expect(deltas).toEqual([62, -40]);
  });

  it("onDelta is optional — hook works without it", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    // Should not throw even though onDelta is undefined.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    });
    expect(result.current.width).toBe(300);
  });

  // --- Dynamic availability ceiling (issue #770) -------------------------

  it("clamps pointermove to the dynamic max when it is below the static max", () => {
    const { result } = renderHook(() =>
      useSidebarResize({ getMaxWidth: () => 424 }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 900 }));
    });
    expect(result.current.width).toBe(424);
  });

  it("keeps the static max when the dynamic max is above it", () => {
    const { result } = renderHook(() =>
      useSidebarResize({ getMaxWidth: () => 4000 }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 9999 }));
    });
    expect(result.current.width).toBe(518);
  });

  it("falls back to the static max when the getter returns undefined", () => {
    const { result } = renderHook(() =>
      useSidebarResize({ getMaxWidth: () => undefined }),
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 9999 }));
    });
    expect(result.current.width).toBe(518);
  });

  it("restores a stored width clamped to the dynamic max", () => {
    localStorage.setItem(STORAGE_KEY, "518");
    const { result } = renderHook(() =>
      useSidebarResize({ getMaxWidth: () => 424 }),
    );
    expect(result.current.width).toBe(424);
  });

  it("restore clamp bottoms out at the static minimum, never below it", () => {
    localStorage.setItem(STORAGE_KEY, "400");
    const { result } = renderHook(() =>
      useSidebarResize({ getMaxWidth: () => 100 }),
    );
    // 238 = the static floor (MIN_WIDTH), pinned as a literal like the 518
    // ceiling asserts above.
    expect(result.current.width).toBe(238);
  });

  it("re-clamps the live width on window shrink without persisting it", () => {
    localStorage.setItem(STORAGE_KEY, "424");
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useSidebarResize({ getMaxWidth }),
      { initialProps: { getMaxWidth: () => 424 } },
    );
    expect(result.current.width).toBe(424);

    // Window shrinks: the availability ceiling drops to 240.
    rerender({ getMaxWidth: () => 240 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(240);
    // The stored preference keeps the pre-shrink value — a transient narrow
    // window must not overwrite it (the restore path re-clamps per launch).
    expect(localStorage.getItem(STORAGE_KEY)).toBe("424");
  });

  it("window widen does not grow the live width (one-way re-clamp)", () => {
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useSidebarResize({ getMaxWidth }),
      { initialProps: { getMaxWidth: () => 240 } },
    );
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);

    rerender({ getMaxWidth: () => 500 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("window shrink never pushes the live width below the static minimum", () => {
    localStorage.setItem(STORAGE_KEY, "424");
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useSidebarResize({ getMaxWidth }),
      { initialProps: { getMaxWidth: () => 424 } },
    );

    rerender({ getMaxWidth: () => 100 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    // 238 = the static floor (MIN_WIDTH).
    expect(result.current.width).toBe(238);
  });

  it("does not persist a width that was only re-clamped by a mid-drag window shrink", () => {
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useSidebarResize({ getMaxWidth }),
      { initialProps: { getMaxWidth: () => 424 } },
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 424 }));
    });
    expect(result.current.width).toBe(424);

    // Window shrinks mid-drag, before the pointer is released.
    rerender({ getMaxWidth: () => 240 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.width).toBe(240);

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    // The shrink was environmental, not a user width choice — nothing stored.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("persists again once the user drags after a mid-drag shrink", () => {
    const { result, rerender } = renderHook(
      ({ getMaxWidth }: { getMaxWidth: () => number | undefined }) =>
        useSidebarResize({ getMaxWidth }),
      { initialProps: { getMaxWidth: () => 424 } },
    );
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
      } as unknown as React.PointerEvent);
    });
    rerender({ getMaxWidth: () => 240 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    // The user moves again — the width is theirs once more (clamped to the
    // shrunken ceiling), so the release persists it.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup"));
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe("240");
  });
});
