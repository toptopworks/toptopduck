import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef, type FocusEvent } from "react";
import {
  MENU_REENTRY_GRACE_MS,
  useSidebarHoverCard,
  useSidebarHoverCardBridge,
} from "../sidebarHoverCard";

// Direct specs for the sidebar hover-card machine + row bridge (issue
// #1325): the choreography specs that used to drive the rendered
// SessionSidebar now pin the hooks' verb contracts -- same fake-timer
// timelines, asserted against isOpen/cardOpen instead of card content.

afterEach(() => {
  vi.useRealTimers();
});

function renderMachine() {
  return renderHook(() => useSidebarHoverCard());
}

// The machine + one row's bridge, the SidebarRow wiring shape (the li ref
// stays with the row).
function useRowFixtureHook(key: string) {
  const liRef = useRef<HTMLLIElement | null>(null);
  const machine = useSidebarHoverCard();
  const bridge = useSidebarHoverCardBridge(machine, key, liRef);
  return { machine, bridge };
}

function renderRowFixture(key = "a") {
  return renderHook(() => useRowFixtureHook(key));
}

// The classifier's keyboard-modality branch, without jsdom's :focus-visible
// machinery: the bridge only reads e.target.matches(":focus-visible").
const kbFocusEvent = {
  target: { matches: (sel: string) => sel === ":focus-visible" },
} as unknown as FocusEvent<HTMLElement>;

describe("useSidebarHoverCard machine (issue #1175, collected by #1325)", () => {
  it("retires the shown card the moment a different row is entered, before its own dwell", async () => {
    // The retire line is the sweep fix: without it the OLD card stays on
    // screen the whole time the pointer travels (every enter cancels the
    // pending close; the new card only opens after its own 300 ms dwell).
    vi.useFakeTimers();
    const { result } = renderMachine();

    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current.isOpen("a")).toBe(true);

    act(() => result.current.enter("b"));
    // NO timer advance: A's card must be gone immediately...
    expect(result.current.isOpen("a")).toBe(false);
    // ...and B's card opens only after its own dwell.
    await act(async () => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current.isOpen("b")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.isOpen("b")).toBe(true);
  });

  it("honors the 200 ms close grace, and entering the card cancels the close", async () => {
    vi.useFakeTimers();
    const { result } = renderMachine();

    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current.isOpen("a")).toBe(true);

    // Leave the row: the grace window keeps the card readable...
    act(() => result.current.leave("a"));
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(result.current.isOpen("a")).toBe(true);
    // ...and sweeping onto the card itself cancels the pending close
    // (read-only per ADR-0127, but the pointer may rest there to read).
    act(() => result.current.cardEnter());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.isOpen("a")).toBe(true);
    // Leaving the CARD schedules its own close (the row-leave guard cannot
    // serve this path -- the row's leave already ran).
    act(() => result.current.cardLeave());
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.isOpen("a")).toBe(false);
  });

  it("closes the card when the pointer leaves the whole list (backstop)", async () => {
    // A pointerleave lost to the pill's pointer-events toggling never
    // reaches the row; the list-level leave is the final backstop.
    vi.useFakeTimers();
    const { result } = renderMachine();

    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current.isOpen("a")).toBe(true);
    act(() => result.current.listLeave());
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.isOpen("a")).toBe(false);
  });

  it("ignores a stale leave from a row the pointer already left", async () => {
    // After A -> B, a late leave of A must not clear B's pending open (the
    // stale-key guard); B's card still opens on schedule.
    vi.useFakeTimers();
    const { result } = renderMachine();

    act(() => result.current.enter("a"));
    act(() => result.current.leave("a"));
    act(() => result.current.enter("b"));
    // Stale: the pointer's tracked row is B now.
    act(() => result.current.leave("a"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.isOpen("b")).toBe(true);
  });

  it("menu close arms an enter suppression until a real leave (synthetic re-entry)", async () => {
    // The modal menu holds body pointer-events:none; on release the browser
    // re-dispatches a pointerEnter at the pointer's position -- the pointer
    // never left the row (Escape close) -- and that synthetic re-entry must
    // not re-arm the 300 ms dwell. The next enter after a real leave opens
    // again.
    vi.useFakeTimers();
    const { result } = renderMachine();

    // Sanity arm of the machine: a dwell opens the card.
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current.isOpen("a")).toBe(true);

    // Menu open retires the card AND arms the suppression: Radix's own
    // controlled-open intent (fired through the HoverCard bridge ~17 ms
    // after the content mounts, CDP-measured) must not re-arm the dwell.
    act(() => result.current.menuOpenChange("a", true));
    expect(result.current.isOpen("a")).toBe(false);
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.isOpen("a")).toBe(false);

    // Pointer travels onto the open menu (real pointerleave -- it clears
    // the arm) and Radix keeps firing bridge intents afterwards (CDP:
    // three enters after the leave): silenced by the open-menu mark.
    act(() => result.current.leave("a"));
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.isOpen("a")).toBe(false);

    // Menu close refreshes the arm; the synthetic re-entry is consumed.
    act(() => result.current.menuOpenChange("a", false));
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.isOpen("a")).toBe(false);

    // Past the grace window (a real leave + re-enter), the card opens again.
    act(() => result.current.leave("a"));
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.isOpen("a")).toBe(true);
  });

  it("the close-burst suppression expires by time, not only by a real leave", async () => {
    // The re-entry pin above exercises disarm-by-leave; this one drives the
    // expiry half. A lost pointerleave (portal layers -- the design premise
    // of menuArmRef) never clears the arm, so past MENU_REENTRY_GRACE_MS the
    // stale arm must fall away at the next enter and the card opens again:
    // the row cannot go dark forever. Vitest's fake timers mock Date
    // alongside the clock, so advancing also advances the arm's
    // event-instant read.
    vi.useFakeTimers();
    const { result } = renderMachine();

    // Sanity arm of the machine: a dwell opens the card, opening the menu
    // retires it and arms the suppression.
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current.isOpen("a")).toBe(true);
    act(() => result.current.menuOpenChange("a", true));

    // Menu close refreshes the arm and NO leave ever arrives (the
    // lost-leave premise). The enter inside the grace is consumed...
    act(() => result.current.menuOpenChange("a", false));
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(MENU_REENTRY_GRACE_MS + 150);
    });
    expect(result.current.isOpen("a")).toBe(false);

    // ...and the next enter, with no intervening leave anywhere, meets the
    // stale arm past the grace, disarms it through the expiry branch, and
    // opens the card.
    act(() => result.current.enter("a"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.isOpen("a")).toBe(true);
  });
});

describe("useSidebarHoverCardBridge gate (issue #1321, collected by #1325)", () => {
  it("opens on keyboard focus and closes unconditionally through the gate", async () => {
    // A programmatic open intent with NEITHER marker set (a restore -- CDP:
    // the Rename dialog's close-restore) is silenced by the three-state
    // gate's early return. A keyboard focusin sets kbFocusRef, letting the
    // next open intent bridge through into the dwell -- the non-pointer
    // user's only path. CLOSE intents pass UNCONDITIONALLY: the li's onBlur
    // clears kbFocusRef synchronously during the focusout dispatch, while
    // Radix defers its close intent a macrotask even at closeDelay 0 -- a
    // gated close would read both markers false and strand the card the
    // moment a keyboard user Tabs off the row.
    vi.useFakeTimers();
    const { result } = renderRowFixture("a");

    act(() => result.current.bridge.hoverOpenChange(true));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.bridge.cardOpen).toBe(false);

    act(() => result.current.bridge.liProps.onFocus(kbFocusEvent));
    act(() => result.current.bridge.hoverOpenChange(true));
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current.bridge.cardOpen).toBe(true);

    // Tab away: the blur clears kbFocusRef first, the close intent lands a
    // macrotask later -- it must still retire the card.
    act(() => result.current.bridge.liProps.onBlur());
    act(() => result.current.bridge.hoverOpenChange(false));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current.bridge.cardOpen).toBe(false);
  });
});
