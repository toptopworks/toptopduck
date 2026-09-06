import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveTurn } from "../useTurnFlow";
import { useRailFollow } from "../useRailFollow";

// useRailFollow owns the rail's stick-to-bottom posture (issue #829): the
// four-behavior state machine (submit -> bottom / append -> rAF follow /
// user scroll beyond the band -> pause / scroll back within the band ->
// resume). jsdom has no layout engine, so the machine is pinned as pure
// state-machine assertions: geometry (scrollHeight / clientHeight) is stubbed
// on the rail element, scrollTop is a counting spy (hook writes count; the
// test's user-scroll simulation bypasses the counter, standing in for the
// browser setting scrollTop), and scroll events are dispatched by hand.

// --- rAF scheduler stub ----------------------------------------------------
// jsdom's visual-frame timer fires ~16ms out, so a zero-timeout await would
// race it. The stub swaps the scheduler only -- the hook still goes through
// the globals -- and flushFrame() runs exactly the queued callbacks,
// deterministically, inside act.

type FrameCb = (t: number) => void;
let queued: { id: number; cb: FrameCb }[] = [];
let nextId = 1;

beforeEach(() => {
  queued = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameCb): number => {
    const id = nextId++;
    queued.push({ id, cb });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    queued = queued.filter((entry) => entry.id !== id);
  });
});

function flushFrame(): void {
  const pending = queued;
  queued = [];
  act(() => {
    for (const { cb } of pending) cb(0);
  });
}

// --- Geometry rig ----------------------------------------------------------
// scrollHeight=1000, clientHeight=300 -> maxScroll=700 (the bottom). The band
// is the trailing 40px (scrollTop >= 660). rig.geo mutates between rerenders
// to stand in for streamed content growing the scroll extent.

function rigRail(rail: HTMLElement) {
  const geo = { scrollHeight: 1000, clientHeight: 300 };
  Object.defineProperty(rail, "scrollHeight", {
    configurable: true,
    get: () => geo.scrollHeight,
  });
  Object.defineProperty(rail, "clientHeight", {
    configurable: true,
    get: () => geo.clientHeight,
  });
  let top = 0;
  let writes = 0;
  Object.defineProperty(rail, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
      writes += 1;
    },
  });
  return {
    geo,
    /** Simulate a browser-driven scroll (user wheel / scrollIntoView): moves
     *  the position WITHOUT counting a hook write, then the test dispatches
     *  the event itself. */
    userScrollTo: (v: number) => {
      top = v;
    },
    scrollTop: (): number => top,
    hookWrites: (): number => writes,
  };
}

function makeLiveTurn(): LiveTurn {
  return { question: "q", askedAt: 0, step: null, rounds: [] };
}

// The hook owns the rail ref, so the host attaches it to a real element --
// the same wiring SessionPane performs (a <section>, matching the .session-rail
// element; the listener effect only sees an element the commit actually
// placed the ref on). `active` mirrors the keep-alive layer state (ADR-0051).
function Host({
  active,
  entryCount,
  liveTurn,
}: {
  active: boolean;
  entryCount: number;
  liveTurn: LiveTurn | null;
}) {
  const { railRef, isFollowing } = useRailFollow({ active, entryCount, liveTurn });
  return (
    <main>
      <section ref={railRef} data-testid="rail" />
      <output data-testid="following">{String(isFollowing)}</output>
    </main>
  );
}

function followingText(): string {
  return screen.getByTestId("following").textContent ?? "";
}

describe("useRailFollow", () => {
  // --- Mount: session switch lands at the bottom -------------------------

  it("lands at the bottom and starts following on mount (session switch)", () => {
    const { getByTestId } = render(<Host active={true} entryCount={3} liveTurn={null} />);
    const rig = rigRail(getByTestId("rail") as HTMLElement);
    flushFrame();
    // maxScroll = 1000 - 300 = 700; the fresh pane lands on the latest turn.
    expect(rig.scrollTop()).toBe(700);
    expect(followingText()).toBe("true");
  });

  // --- Append: rAF-aligned follow -----------------------------------------

  it("re-aligns to the bottom when settled entries append while following", () => {
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={null} />,
    );
    const rig = rigRail(getByTestId("rail") as HTMLElement);
    flushFrame();
    expect(rig.scrollTop()).toBe(700);

    rig.geo.scrollHeight = 1200; // content grew -> maxScroll = 900
    rerender(<Host active={true} entryCount={4} liveTurn={null} />);
    flushFrame();
    expect(rig.scrollTop()).toBe(900);
    expect(followingText()).toBe("true");
  });

  it("follows live-turn streaming updates (identity changes align)", () => {
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={null} />,
    );
    const rig = rigRail(getByTestId("rail") as HTMLElement);
    flushFrame();

    rerender(<Host active={true} entryCount={3} liveTurn={makeLiveTurn()} />);
    flushFrame();
    expect(rig.scrollTop()).toBe(700);

    rig.geo.scrollHeight = 1100; // a streamed delta grew the extent
    rerender(<Host active={true} entryCount={3} liveTurn={makeLiveTurn()} />);
    flushFrame();
    expect(rig.scrollTop()).toBe(800);
  });

  it("coalesces appends within a frame into one write (no per-delta hard scroll)", () => {
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={null} />,
    );
    const rig = rigRail(getByTestId("rail") as HTMLElement);
    flushFrame();
    expect(rig.hookWrites()).toBe(1); // the mount land

    // Two deltas land in the SAME frame (no flush between the rerenders):
    // both effects schedule, but the pending frame absorbs the second -> one
    // write for the batch.
    rig.geo.scrollHeight = 1200;
    rerender(<Host active={true} entryCount={4} liveTurn={null} />);
    rig.geo.scrollHeight = 1400;
    rerender(<Host active={true} entryCount={5} liveTurn={null} />);
    flushFrame();
    expect(rig.hookWrites()).toBe(2); // mount + ONE coalesced append write
    expect(rig.scrollTop()).toBe(1100); // the latest maxScroll wins

    // Nothing left pending: an idle frame writes nothing.
    flushFrame();
    expect(rig.hookWrites()).toBe(2);
  });

  // --- Pause: user scrolls beyond the band --------------------------------

  it("pauses when the user scrolls beyond the band and stays put across appends", () => {
    // Mounted with a turn ALREADY live, so the later liveTurn rerenders are
    // streaming deltas (same active state, new identity) -- not the submit
    // transition, which force-follows by design (see the submit test).
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={makeLiveTurn()} />,
    );
    const rail = getByTestId("rail") as HTMLElement;
    const rig = rigRail(rail);
    flushFrame();

    // Wheel up 200px past the bottom: distance = 200 > 40 -> pause.
    rig.userScrollTo(500);
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(followingText()).toBe("false");

    // Appends (settled growth AND live deltas) must not drag the viewport.
    rig.geo.scrollHeight = 1200;
    rerender(<Host active={true} entryCount={4} liveTurn={makeLiveTurn()} />);
    flushFrame();
    rig.geo.scrollHeight = 1300;
    rerender(<Host active={true} entryCount={4} liveTurn={makeLiveTurn()} />);
    flushFrame();
    expect(rig.scrollTop()).toBe(500);
    expect(rig.hookWrites()).toBe(1); // mount only
    expect(followingText()).toBe("false");
  });

  it("pauses on a mid-timeline jump (the stale-chip landing needs no special case)", () => {
    const { getByTestId } = render(<Host active={true} entryCount={3} liveTurn={null} />);
    const rail = getByTestId("rail") as HTMLElement;
    const rig = rigRail(rail);
    flushFrame();

    // scrollIntoView(block: "center") lands mid-timeline: distance >> 40.
    rig.userScrollTo(100);
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(followingText()).toBe("false");
    expect(rig.scrollTop()).toBe(100); // not pulled back to the bottom
  });

  // --- Resume: back within the band ---------------------------------------

  it("resumes following when the user scrolls back within the band", () => {
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={null} />,
    );
    const rail = getByTestId("rail") as HTMLElement;
    const rig = rigRail(rail);
    flushFrame();

    rig.userScrollTo(400); // pause
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(followingText()).toBe("false");

    // Scroll back to 20px from the bottom (<= 40): following resumes, and
    // the resume itself does NOT snap -- the next append realigns.
    rig.userScrollTo(680);
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(followingText()).toBe("true");
    expect(rig.scrollTop()).toBe(680);
    flushFrame();
    expect(rig.scrollTop()).toBe(680); // no idle snap on the resume event

    rig.geo.scrollHeight = 1200;
    rerender(<Host active={true} entryCount={4} liveTurn={null} />);
    flushFrame();
    expect(rig.scrollTop()).toBe(900); // the next append lands on the bottom
  });

  it("does not pause inside the band (a sub-threshold wiggle stays following)", () => {
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={null} />,
    );
    const rail = getByTestId("rail") as HTMLElement;
    const rig = rigRail(rail);
    flushFrame();

    rig.userScrollTo(680); // 20px up -- still inside the 40px band
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(followingText()).toBe("true");

    rig.geo.scrollHeight = 1200;
    rerender(<Host active={true} entryCount={4} liveTurn={null} />);
    flushFrame();
    expect(rig.scrollTop()).toBe(900); // the follow re-lands the bottom
  });

  // --- Submit: force-follow to the bottom ----------------------------------

  it("force-follows to the bottom on submit (liveTurn null -> live), overriding a pause", () => {
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={null} />,
    );
    const rail = getByTestId("rail") as HTMLElement;
    const rig = rigRail(rail);
    flushFrame();

    rig.userScrollTo(100); // the user is reading history
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(followingText()).toBe("false");

    // Submitting creates the live turn (the bubble mounts at submit): the
    // question is at the tail, so the rail force-returns to the bottom.
    rerender(<Host active={true} entryCount={3} liveTurn={makeLiveTurn()} />);
    flushFrame();
    expect(followingText()).toBe("true");
    expect(rig.scrollTop()).toBe(700);
  });

  // --- Keep-alive: hidden layers (ADR-0051) --------------------------------

  it("writes no scroll geometry while inactive (a hidden pane's stream must not corrupt the position)", () => {
    // Open panes stay mounted but display:none; turn listeners keep feeding
    // deltas. display:none reads scrollHeight/clientHeight as 0, so an align
    // would land scrollTop 0 and the switch-back would open at the TOP.
    const { getByTestId, rerender } = render(
      <Host active={false} entryCount={3} liveTurn={makeLiveTurn()} />,
    );
    const rig = rigRail(getByTestId("rail") as HTMLElement);
    flushFrame();
    expect(rig.hookWrites()).toBe(0);

    rig.geo.scrollHeight = 1200; // streamed while hidden
    rerender(<Host active={false} entryCount={3} liveTurn={makeLiveTurn()} />);
    flushFrame();
    expect(rig.hookWrites()).toBe(0);
    // Posture untouched while hidden: still the initial follow.
    expect(followingText()).toBe("true");
  });

  it("re-aligns a following pane on activation (catches up on content streamed while hidden)", () => {
    // Switching back to an already-open session fires no remount -- the
    // active option's false -> true transition IS the switch signal, and a
    // pane still in the follow posture reads the CURRENT extent (everything
    // streamed while hidden) on its catch-up align.
    const { getByTestId, rerender } = render(
      <Host active={false} entryCount={3} liveTurn={makeLiveTurn()} />,
    );
    const rig = rigRail(getByTestId("rail") as HTMLElement);
    flushFrame();

    rig.geo.scrollHeight = 1200; // content streamed while hidden
    rerender(<Host active={true} entryCount={3} liveTurn={makeLiveTurn()} />);
    flushFrame();
    // maxScroll = 1200 - 300 = 900: the follow catch-up lands on the LATEST.
    expect(rig.scrollTop()).toBe(900);
    expect(followingText()).toBe("true");
  });

  it("keeps a paused pane's reading position across the keep-alive switch (restored unchanged)", () => {
    // The keep-alive contract (ADR-0051) is "restored unchanged": a pane the
    // user deliberately scrolled up in must NOT be dragged to the bottom on
    // switch-back -- activation schedules, and the callback's posture gate
    // leaves a paused pane's scrollTop alone.
    const { getByTestId, rerender } = render(
      <Host active={true} entryCount={3} liveTurn={makeLiveTurn()} />,
    );
    const rail = getByTestId("rail") as HTMLElement;
    const rig = rigRail(rail);
    flushFrame();

    rig.userScrollTo(400); // the user reads history -> pause
    act(() => {
      rail.dispatchEvent(new Event("scroll"));
    });
    expect(followingText()).toBe("false");

    rerender(<Host active={false} entryCount={3} liveTurn={makeLiveTurn()} />);
    rig.geo.scrollHeight = 1200; // streamed while hidden
    rerender(<Host active={false} entryCount={4} liveTurn={makeLiveTurn()} />);
    flushFrame();
    rerender(<Host active={true} entryCount={4} liveTurn={makeLiveTurn()} />); // back
    flushFrame();
    expect(rig.scrollTop()).toBe(400); // reading position preserved
    expect(rig.hookWrites()).toBe(1); // the mount land -- nothing since
    expect(followingText()).toBe("false");
  });
});
