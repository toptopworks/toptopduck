import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";

import { Toaster } from "../toaster";
import { useToast, toast } from "../use-toast";

// Real-Radix toast pins (issue #1494): the face IS the library's
// semantics, so these suites mount the REAL primitives and pin only what
// the ticket owns: the two starting variants render distinguishably,
// multiple toasts stack (the recipe's TOAST_LIMIT cap is deliberately
// dropped, ADR-0142 Decision 4), the 5s auto-dismiss runs on the clock,
// hover pauses the countdown, swipe-up removes (swipeDirection matches
// the column-top placement), the viewport anchors to the main-area
// column top and re-centers through a firing ResizeObserver (the
// rail-fold re-measure, Decision 3), the close button carries its
// sr-only name and dismisses, and a closed toast releases the
// viewport's pointer-events. jsdom runs no CSS animations, so radix's close falls back
// to immediate unmount -- which is also the reduced-motion posture on
// the JS side (no behavior waits on animation completion); the CSS side
// is gated by app.css's global prefers-reduced-motion block, which
// covers the transform/opacity enter/exit utilities used here.
// Module-state isolation: the store is module-level (plain call sites
// fire toast() with no React context), so each test dismisses all
// leftovers through the public hook before the next render.

function fireToast(props: Parameters<typeof toast>[0]) {
  act(() => {
    toast(props);
  });
}

function toastEl(title: string): HTMLElement {
  const el = screen.getByText(title).closest("[data-slot=\"toast\"]");
  if (!el) throw new Error(`toast root for "${title}" not found`);
  return el as HTMLElement;
}

function viewportEl(): HTMLElement {
  const el = document.querySelector("[data-slot=\"toast-viewport\"]");
  if (!el) throw new Error("toast viewport not found");
  return el as HTMLElement;
}

describe("ui toast face (issue #1494)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    render(<Toaster />);
  });

  afterEach(() => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.dismiss();
    });
    vi.useRealTimers();
  });

  it("renders default and destructive distinguishably", () => {
    fireToast({ title: "Neutral note" });
    fireToast({ title: "Upload failed", variant: "destructive" });
    expect(toastEl("Neutral note")).toHaveClass("bg-inverted");
    expect(toastEl("Neutral note")).not.toHaveClass("destructive");
    expect(toastEl("Upload failed")).toHaveClass(
      "bg-destructive",
      "text-destructive-foreground",
      "destructive",
    );
  });

  it("re-tints the description on the destructive surface", () => {
    // The inverted-surface dim (inverted-foreground/75) is correct on the
    // dark face but lands as low-contrast gray-on-red without the group
    // override (the copy-in gap found on the updater-failure toast, issue
    // #1509). The override class rides the string unconditionally -- the
    // variant distinction is the root's marker class (pinned above), not
    // the class list.
    fireToast({ title: "Failed", description: "raw detail" });
    fireToast({ title: "Failed red", description: "raw detail red", variant: "destructive" });
    expect(screen.getByText("raw detail")).toHaveClass("text-inverted-foreground/75");
    expect(screen.getByText("raw detail red")).toHaveClass(
      "text-inverted-foreground/75",
      "group-[.destructive]:text-destructive-foreground/90",
    );
  });

  it("stacks multiple toasts concurrently", () => {
    fireToast({ title: "First batch" });
    fireToast({ title: "Second batch" });
    expect(screen.getByText("First batch")).toBeTruthy();
    expect(screen.getByText("Second batch")).toBeTruthy();
    expect(document.querySelectorAll("[data-slot=\"toast\"]")).toHaveLength(2);
  });

  it("auto-dismisses after the 5s library default", () => {
    fireToast({ title: "Timed note" });
    expect(screen.getByText("Timed note")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.getByText("Timed note")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByText("Timed note")).toBeNull();
  });

  it("pauses the countdown while the viewport is hovered", () => {
    fireToast({ title: "Paused note" });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    // Radix pauses on pointermove over its viewport wrapper (and window
    // blur), not on pointerenter -- the library's own gesture pair is
    // pointermove / pointerleave.
    fireEvent.pointerMove(viewportEl());
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("Paused note")).toBeTruthy();
  });

  it("removes on swipe up (placement-matched direction)", () => {
    fireToast({ title: "Swiped note" });
    const el = toastEl("Swiped note");
    fireEvent.pointerDown(el, {
      button: 0,
      pointerType: "touch",
      clientX: 10,
      clientY: 100,
    });
    fireEvent.pointerMove(el, {
      pointerType: "touch",
      clientX: 10,
      clientY: -150,
    });
    fireEvent.pointerUp(el, {
      button: 0,
      pointerType: "touch",
      clientX: 10,
      clientY: -150,
    });
    expect(screen.queryByText("Swiped note")).toBeNull();
  });

  it("centers the viewport on the main-area column top", () => {
    const main = document.createElement("main");
    main.className = "main-area";
    document.body.appendChild(main);
    vi.spyOn(main, "getBoundingClientRect").mockReturnValue({
      left: 200,
      top: 64,
      width: 400,
      height: 600,
    } as DOMRect);
    // Scoped to THIS render's container: the beforeEach-mounted Toaster
    // predates the main element and stays on the fallback posture.
    const { container } = render(<Toaster />);
    const vp = container.querySelector("[data-slot=\"toast-viewport\"]");
    expect(vp).toBeTruthy();
    expect((vp as HTMLElement).style.left).toBe("400px");
    expect((vp as HTMLElement).style.top).toBe("64px");
    main.remove();
  });

  it("pins the column-top fallback posture without a main area", () => {
    expect(viewportEl()).toHaveClass(
      "fixed",
      "top-16",
      "left-1/2",
      "-translate-x-1/2",
      "z-[100]",
    );
  });

  it("re-centers the viewport through the fold (ResizeObserver re-fire)", () => {
    // test-setup's global RO never fires; a spy stub records observed
    // targets so the test fires the callback of the instance that
    // actually OBSERVED the main area (the Shell.test precedent) -- a
    // wiring deletion leaves no observing instance and reddens here.
    const instances: {
      cb: ResizeObserverCallback;
      targets: Element[];
    }[] = [];
    class FireableRO {
      cb: ResizeObserverCallback;

      targets: Element[] = [];

      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
        instances.push(this);
      }

      observe(target: Element) {
        this.targets.push(target);
      }

      unobserve() {}

      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FireableRO);
    const main = document.createElement("main");
    main.className = "main-area";
    document.body.appendChild(main);
    const rect = vi.spyOn(main, "getBoundingClientRect");
    rect.mockReturnValue({ left: 200, top: 64, width: 400 } as DOMRect);
    const { container } = render(<Toaster />);
    const vp = container.querySelector(
      "[data-slot=\"toast-viewport\"]",
    ) as HTMLElement;
    expect(vp.style.left).toBe("400px");
    const observer = instances.find((i) => i.targets.includes(main));
    expect(observer).toBeTruthy();
    // Rail fold: the column narrows and shifts; RO re-fires on the same
    // element and the callback must re-measure or the anchor goes stale.
    rect.mockReturnValue({ left: 100, top: 64, width: 200 } as DOMRect);
    act(() => {
      observer!.cb(
        [{ target: main } as unknown as ResizeObserverEntry],
        observer as unknown as ResizeObserver,
      );
    });
    expect(vp.style.left).toBe("200px");
    main.remove();
  });

  it("names and dismisses through the close button", () => {
    fireToast({ title: "Closable note" });
    // The sr-only Close span (dialog.tsx precedent) is the button's
    // accessible name -- getByRole name-matching proves the label exists.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Closable note")).toBeNull();
  });

  it("releases the viewport pointer-events once the toast closes", () => {
    fireToast({ title: "Releasing note" });
    // The region wrapper (the ol's parent div, where radix sets the
    // pointerEvents style) is live while the toast is open -- that IS the
    // hover-pause affordance.
    const wrapper = viewportEl().parentElement as HTMLElement;
    expect(wrapper.style.pointerEvents).toBe("");
    act(() => {
      vi.advanceTimersByTime(5001);
    });
    // Closed: radix Presence unmounts the closed toast (jsdom skips the
    // exit animation), the toast count returns to zero, and the wrapper
    // switches itself off -- a dismissed toast leaves no invisible
    // click-intercepting strip over the column top.
    expect(screen.queryByText("Releasing note")).toBeNull();
    expect(wrapper.style.pointerEvents).toBe("none");
  });
});
