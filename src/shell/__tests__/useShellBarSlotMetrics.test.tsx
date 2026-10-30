import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { useShellBarSlotMetrics } from "../useShellBarSlotMetrics";

// A minimal host so the hook's refs bind to real elements: the slot <div>
// the shell bar renders into, inside the <main> area element the vars land
// on.
function Host({ areaRef }: { areaRef: RefObject<HTMLElement | null> }) {
  const slotRef = useShellBarSlotMetrics(areaRef);
  return (
    <main ref={areaRef}>
      <div ref={slotRef} />
    </main>
  );
}

// A controllable ResizeObserver double: the hook constructs one on mount,
// the test fires its callback directly (jsdom has no layout, so a real
// observer would never fire).
let latestFakeRO: { callback: ResizeObserverCallback } | null = null;
class FakeResizeObserver implements ResizeObserver {
  callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    latestFakeRO = { callback };
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

describe("useShellBarSlotMetrics", () => {
  afterEach(() => {
    latestFakeRO = null;
    vi.unstubAllGlobals();
  });

  it("publishes the measured scrollbar width as --rail-sb-w on the main area", () => {
    const areaRef = { current: null as HTMLElement | null };
    render(<Host areaRef={areaRef} />);
    // jsdom has no layout: the hidden probe measures 0 -- exactly the
    // overlay-scrollbar case the measurement is for.
    expect(areaRef.current?.style.getPropertyValue("--rail-sb-w")).toBe("0px");
  });

  it("writes a reported slot height to --shell-bar-h and keeps the last real height on a zero report", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const areaRef = { current: null as HTMLElement | null };
    render(<Host areaRef={areaRef} />);
    const area = areaRef.current!;
    const fire = (height: number) => {
      act(() => {
        latestFakeRO!.callback(
          [
            {
              borderBoxSize: [{ blockSize: height }],
              contentRect: { height },
            } as unknown as ResizeObserverEntry,
          ],
          latestFakeRO as unknown as ResizeObserver,
        );
      });
    };
    fire(42);
    expect(area.style.getPropertyValue("--shell-bar-h")).toBe("42px");
    // A hidden slot (settings-mode display:none) reports 0 -- the var keeps
    // the last real height so the rail's bound never collapses.
    fire(0);
    expect(area.style.getPropertyValue("--shell-bar-h")).toBe("42px");
  });
});
