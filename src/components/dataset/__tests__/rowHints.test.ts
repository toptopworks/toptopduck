import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  POINTER_SUPPRESSION_WINDOW_MS,
  isWithinSuppressionWindow,
  reduceTip,
  sameTipKey,
  useRowHints,
  type TipKey,
} from "../rowHints";

// Two layers pin the row-hint protocol (see rowHints.ts for the narrative):
// the pure transfer rules run with zero rendering, and the useRowHints hook's
// dialog-close handoff + suppression window run under fake timers so the
// deferred setTimeout chain is deterministic.

const key = (kind: TipKey["kind"], row = "people"): TipKey => ({ row, kind });

describe("sameTipKey", () => {
  it("matches on both row and kind", () => {
    expect(sameTipKey(key("rename"), key("rename"))).toBe(true);
  });

  it("distinguishes rows and kinds", () => {
    expect(sameTipKey(key("rename"), key("rename", "orders"))).toBe(false);
    expect(sameTipKey(key("rename"), key("delete"))).toBe(false);
  });
});

describe("reduceTip", () => {
  it("opens take the empty slot", () => {
    expect(reduceTip(null, key("rename"), true)).toEqual(key("rename"));
  });

  it("opens take the slot even when another key is held", () => {
    // A row unmounting mid-hover never fires pointerleave, so its hint key
    // stays in the slot; the next open must take the slot anyway (the
    // ghost-key shape a rejection branch would wedge forever).
    expect(reduceTip(key("delete", "people"), key("rename", "orders"), true)).toEqual(
      key("rename", "orders"),
    );
  });

  it("a close clears only its own key", () => {
    // A stale-timer close for another tooltip must not clear the one that is
    // open now.
    expect(reduceTip(key("rename"), key("delete"), false)).toEqual(key("rename"));
  });

  it("closing the open key empties the slot", () => {
    expect(reduceTip(key("rename"), key("rename"), false)).toBeNull();
  });

  it("closing on an empty slot stays empty", () => {
    expect(reduceTip(null, key("rename"), false)).toBeNull();
  });
});

describe("isWithinSuppressionWindow", () => {
  it("never suppresses before any dialog close", () => {
    // The sentinel 0 (no dialog ever closed) is epochs away from a real now.
    expect(isWithinSuppressionWindow(0, 1_800_000_000_000)).toBe(false);
  });

  it("suppresses up to and including the window boundary", () => {
    expect(isWithinSuppressionWindow(1_000, 1_000 + POINTER_SUPPRESSION_WINDOW_MS)).toBe(true);
  });

  it("stops suppressing past the window boundary", () => {
    expect(
      isWithinSuppressionWindow(1_000, 1_000 + POINTER_SUPPRESSION_WINDOW_MS + 1),
    ).toBe(false);
  });

  it("pins the window to the documented 300ms", () => {
    // Real pointer travel always arrives later than this; a Chromium
    // re-dispatched pointer enter after a dialog close does not.
    expect(POINTER_SUPPRESSION_WINDOW_MS).toBe(300);
  });
});

describe("useRowHints", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  // A stub target answering the keyboard heuristic, so the focus-restore
  // gate (the unit under test) is isolated from the selector engine.
  const focusVisibleTarget = (): Element =>
    ({ matches: (selector: string) => selector === ":focus-visible" }) as unknown as Element;

  const mountTrigger = (): HTMLButtonElement => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    return trigger;
  };

  it("routes opens and closes through the controls object", () => {
    const { result } = renderHook(() => useRowHints());
    act(() => result.current.tip.setTip(key("rename"), true));
    expect(result.current.tip.openKey).toEqual(key("rename"));
    act(() => result.current.tip.setTip(key("rename"), false));
    expect(result.current.tip.openKey).toBeNull();
  });

  it("shuts pointer enters inside the suppression window and opens outside it", () => {
    const { result } = renderHook(() => useRowHints());
    act(() => result.current.closeDialog(vi.fn())); // stamps the window
    // Exactly at the boundary the enter is still a dialog-close echo.
    act(() => {
      vi.advanceTimersByTime(POINTER_SUPPRESSION_WINDOW_MS);
    });
    act(() => result.current.tip.pointerEnter(key("rename"), "mouse"));
    expect(result.current.tip.openKey).toBeNull();
    // One tick past it, the enter is real pointer travel.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => result.current.tip.pointerEnter(key("rename"), "mouse"));
    expect(result.current.tip.openKey).toEqual(key("rename"));
    // Non-mouse pointers never open a hint, window aside.
    act(() => result.current.tip.setTip(key("rename"), false));
    act(() => result.current.tip.pointerEnter(key("delete"), "touch"));
    expect(result.current.tip.openKey).toBeNull();
  });

  it("defers the focus restore past the focus trap and lands it on the captured trigger", () => {
    const trigger = mountTrigger();
    const { result } = renderHook(() => useRowHints());
    act(() => result.current.captureTrigger(trigger));
    const clear = vi.fn();
    act(() => result.current.closeDialog(clear));
    // The dialog state clears synchronously; the restore waits out the trap.
    expect(clear).toHaveBeenCalledTimes(1);
    expect(trigger).not.toHaveFocus();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(trigger).toHaveFocus();
  });

  it("drops hint opens while the restore lands, and opens again once it clears", () => {
    const trigger = mountTrigger();
    const { result } = renderHook(() => useRowHints());
    let restoreFocusHandled = false;
    // The programmatic restore dispatches focus synchronously; both open
    // paths consult the in-flight flag inside that dispatch.
    trigger.addEventListener("focus", () => {
      restoreFocusHandled = true;
      result.current.tip.focusOpen(key("rename"), focusVisibleTarget());
      result.current.tip.hintOpenChange(key("replace"), true);
    });
    act(() => result.current.captureTrigger(trigger));
    act(() => result.current.closeDialog(vi.fn()));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(restoreFocusHandled).toBe(true);
    expect(result.current.tip.openKey).toBeNull();
    // After the flag clears (the flag-clearing timer sits one fake-timer
    // tick behind the restore), a real keyboard-focus open goes through.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    act(() => result.current.tip.focusOpen(key("rename"), focusVisibleTarget()));
    expect(result.current.tip.openKey).toEqual(key("rename"));
  });

  it("falls back to the list container when the captured trigger is disabled at restore time", () => {
    // focus() on a disabled opener is ignored -- the fallback keeps keyboard
    // focus inside the working-set region instead of stranding it on <body>.
    const trigger = mountTrigger();
    trigger.disabled = true;
    const list = document.createElement("ul");
    // The real list is focusable programmatically only (tabIndex -1) -- the
    // property the fallback restore keys on.
    list.tabIndex = -1;
    document.body.appendChild(list);
    const { result } = renderHook(() => useRowHints());
    result.current.listRef.current = list;
    act(() => result.current.captureTrigger(trigger));
    act(() => result.current.closeDialog(vi.fn()));
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(list).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });
});
