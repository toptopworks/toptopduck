import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { useBarWheelForward } from "../useBarWheelForward";

// A minimal shell: the main area hosting one active pane layer with a rail.
// The forward query reads `.session-pane-layer.active .session-rail`.
function buildShell() {
  const area = document.createElement("main");
  const layer = document.createElement("div");
  layer.className = "session-pane-layer active";
  const rail = document.createElement("div");
  rail.className = "session-rail";
  layer.append(rail);
  area.append(layer);
  document.body.append(area);
  return { area, rail };
}

describe("useBarWheelForward", () => {
  it("forwards wheel deltas to the active pane's rail (#834)", () => {
    const areaRef: RefObject<HTMLElement | null> = { current: null };
    const { result } = renderHook(() => useBarWheelForward(areaRef));
    const { area, rail } = buildShell();
    areaRef.current = area;
    // jsdom has no layout, so the pin stubs scrollBy on the live rail and
    // asserts the forwarded pair (same shape as the Shell-suite wheel pin).
    rail.scrollBy = vi.fn();
    // A slot subtree: the handler walks e.target up to e.currentTarget
    // checking for bar-internal scrollables (none here -- jsdom reads
    // scrollHeight 0).
    const slot = document.createElement("div");
    const span = document.createElement("span");
    slot.append(span);

    const wheel = {
      target: span,
      currentTarget: slot,
      ctrlKey: false,
      deltaY: 240,
      deltaMode: 0,
    } as unknown as React.WheelEvent;
    result.current(wheel);
    expect(rail.scrollBy).toHaveBeenCalledWith(0, 240);
  });

  it("leaves zoom gestures with the browser (ctrl+wheel never forwards)", () => {
    const areaRef: RefObject<HTMLElement | null> = { current: null };
    const { result } = renderHook(() => useBarWheelForward(areaRef));
    const { area, rail } = buildShell();
    areaRef.current = area;
    rail.scrollBy = vi.fn();
    const slot = document.createElement("div");
    const span = document.createElement("span");
    slot.append(span);
    const wheel = {
      target: span,
      currentTarget: slot,
      ctrlKey: true,
      deltaY: 60,
      deltaMode: 0,
    } as unknown as React.WheelEvent;
    result.current(wheel);
    expect(rail.scrollBy).not.toHaveBeenCalled();
  });
});
