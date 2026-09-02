import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
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
  // The suite-wide setup installs a no-op ResizeObserver class (constructor
  // discards the callback); this stub records the callback so tests fire
  // container changes (and the observe-time initial callback) synchronously.
  // The setup's afterEach unstub restores the no-op class after each test.
  let fireContainerChange: (() => void) | undefined;

  class ResizeObserverStub {
    static last: ResizeObserverStub | undefined;
    static constructed = 0;

    disconnected = false;
    observed: unknown[] = [];

    constructor(callback: () => void) {
      fireContainerChange = callback;
      ResizeObserverStub.last = this;
      ResizeObserverStub.constructed += 1;
    }

    observe(element: unknown): void {
      this.observed.push(element);
    }

    unobserve(): void {}

    disconnect(): void {
      this.disconnected = true;
    }
  }

  beforeEach(() => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fireContainerChange = undefined;
    ResizeObserverStub.last = undefined;
    ResizeObserverStub.constructed = 0;
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

  // --- Window-shrink re-clamp (issue #781) --------------------------------
  // The rail's availability ceiling lags the sidebar's own re-clamp by one
  // layout pass inside a single window-resize event (the track host's
  // clientWidth still reflects the old sidebar width), so a window-resize
  // listener alone misses snap-style one-shot shrinks. The re-clamp instead
  // rides a ResizeObserver on the track host: it fires after the layout has
  // actually settled, and its observe-time initial callback covers cold
  // start.

  function renderWithTarget(getMaxWidth?: () => number | undefined) {
    const target: React.RefObject<HTMLElement | null> = {
      current: document.createElement("div"),
    };
    const { result } = renderHook(() =>
      useRailResize({ getMaxWidth, observeTarget: target }),
    );
    return result;
  }

  it("re-clamps to the availability ceiling on the initial container observation (cold start)", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    // Factory entry at W=840, sidebar 238: track host 602 -> ceiling 282.
    const result = renderWithTarget(() => 282);
    // The observe-time callback is asynchronous: the first render keeps the
    // default width, then the initial observation clamps it.
    expect(result.current.width).toBe(350);
    act(() => fireContainerChange?.());
    expect(result.current.width).toBe(282);
  });

  it("keeps COMPENSATED_MIN_WIDTH as the re-clamp floor when the ceiling sinks below it", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    // Not reachable for W >= 840 by the width algebra, but the clamp stays
    // defensive (same shape as the sidebar's re-clamp).
    const result = renderWithTarget(() => 270);
    act(() => fireContainerChange?.());
    expect(result.current.width).toBe(280);
  });

  it("does not re-clamp when the getter reads undefined (no dynamic constraint)", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const result = renderWithTarget(() => undefined);
    act(() => fireContainerChange?.());
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
  });

  it("keeps the default width when ResizeObserver is unavailable", () => {
    // The suite-wide setup installs a no-op observer class, so stubbing the
    // global away entirely is what exercises the static-only early return
    // (the pre-#781 behavior the App tests rely on).
    vi.stubGlobal("ResizeObserver", undefined);
    const result = renderWithTarget(() => 282);
    expect(result.current.width).toBe(RAIL_DEFAULT_WIDTH);
  });

  it("re-clamps on a container shrink (window resize / sidebar re-clamp)", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    let ceiling = 466;
    const result = renderWithTarget(() => ceiling);
    act(() => fireContainerChange?.()); // initial observation: no-op (350 <= 466)
    ceiling = 280;
    act(() => fireContainerChange?.());
    expect(result.current.width).toBe(280);
  });

  it("does not spring back when the container widens again", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    let ceiling = 280;
    const result = renderWithTarget(() => ceiling);
    act(() => fireContainerChange?.());
    expect(result.current.width).toBe(280);
    ceiling = 600;
    act(() => fireContainerChange?.());
    expect(result.current.width).toBe(280); // one-way by design; re-drag instead
  });

  it("re-anchors an in-flight drag so the next move does not jump past the ceiling", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    let ceiling = 466;
    const result = renderWithTarget(() => ceiling);
    act(() => {
      result.current.onResizeStart({
        preventDefault: vi.fn(),
        clientX: 500,
      } as unknown as React.PointerEvent);
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 616 }),
      ); // 350 + 116 = 466
    });
    expect(result.current.width).toBe(466);
    ceiling = 280;
    act(() => fireContainerChange?.()); // mid-drag container shrink
    expect(result.current.width).toBe(280);
    // Further moves recompute from the re-anchored width. Without the
    // re-anchor, startWidth(466) + delta with floor min(350, 466) = 350
    // would clamp back up to 350 (inverted range) and the handle would
    // jump outside the rendered rail again.
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 1000 }));
    });
    expect(result.current.width).toBe(280);
  });

  it("observes exactly the target element and disconnects on unmount", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const target: React.RefObject<HTMLElement | null> = {
      current: document.createElement("div"),
    };
    const { unmount } = renderHook(() =>
      useRailResize({ observeTarget: target }),
    );
    const observer = ResizeObserverStub.last;
    expect(observer).toBeDefined();
    // The construction wiring is anchored end-to-end: the hook observed
    // exactly the target element once — dropping or reordering the observe
    // call must fail here, not only in a real browser.
    expect(observer?.observed).toEqual([target.current]);
    unmount();
    expect(observer?.disconnected).toBe(true);
  });

  it("does not construct an observer when observeTarget is omitted", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    renderHook(() => useRailResize());
    expect(ResizeObserverStub.constructed).toBe(0);
    expect(ResizeObserverStub.last).toBeUndefined();
  });

  it("does not churn the observer across re-renders", () => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const target: React.RefObject<HTMLElement | null> = {
      current: document.createElement("div"),
    };
    const { rerender } = renderHook(() =>
      useRailResize({ observeTarget: target }),
    );
    expect(ResizeObserverStub.constructed).toBe(1);
    act(() => rerender());
    expect(ResizeObserverStub.constructed).toBe(1);
    expect(ResizeObserverStub.last?.observed).toEqual([target.current]);
  });

  it("re-observes when the ref's element is replaced", () => {
    // A boundary retry (ADR-0058 L3) remounts the tracked host under the
    // same ref object: the observer must follow the new node or it stays
    // attached to a detached one that never fires again, silently
    // disabling the re-clamp until reload.
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const target: React.RefObject<HTMLElement | null> = {
      current: document.createElement("div"),
    };
    const { rerender } = renderHook(() =>
      useRailResize({ observeTarget: target }),
    );
    const firstObserver = ResizeObserverStub.last;
    expect(firstObserver?.observed).toEqual([target.current]);
    target.current = document.createElement("div");
    act(() => rerender());
    expect(ResizeObserverStub.constructed).toBe(2);
    expect(firstObserver?.disconnected).toBe(true);
    expect(ResizeObserverStub.last?.observed).toEqual([target.current]);
  });

  it("rebuilds the observer after a StrictMode double-invoke cycle", () => {
    // StrictMode mounts, cleans up, remounts: the cleanup resets the
    // observation state so the remount re-runs the sync and rebuilds the
    // observer instead of skipping it as a no-op on a stale node record.
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    const target: React.RefObject<HTMLElement | null> = {
      current: document.createElement("div"),
    };
    renderHook(() => useRailResize({ observeTarget: target }), {
      wrapper: StrictMode,
    });
    expect(ResizeObserverStub.constructed).toBe(2);
    expect(ResizeObserverStub.last?.disconnected).toBe(false);
    expect(ResizeObserverStub.last?.observed).toEqual([target.current]);
  });
});
