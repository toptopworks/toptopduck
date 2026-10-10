// The wait-elapsed suffix leaf (issue #1264): derives the whole elapsed
// seconds from the turn-flow-owned wait stamp on a 1s interval. What stays
// here is what only the derivation can pin: derive-from-stamp (a throttled
// ticker heals to the TRUE elapsed time -- never a self-incrementing
// counter), the null-window silence, and the aria-hidden face that keeps
// the per-second change out of the host live regions' announcements.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { catalogFor } from "../../../i18n";
import { WaitElapsedSuffix } from "../WaitElapsedSuffix";

function renderSuffix(
  startedAt: number | null,
  opts: { pausedSince?: number | null } = {},
) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <WaitElapsedSuffix startedAt={startedAt} pausedSince={opts.pausedSince ?? null} />
    </IntlProvider>,
  );
}

describe("WaitElapsedSuffix (issue #1264)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing outside a wait window (stamp null)", () => {
    const { container } = renderSuffix(null);
    expect(container).toBeEmptyDOMElement();
  });

  it("derives the elapsed seconds from the stamp and ticks every second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 30));
    const { container } = renderSuffix(Date.now());
    expect(container.textContent).toContain("· 0s");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toContain("· 5s");
  });

  it("heals to the true elapsed time after hidden-page throttling (derive-from-stamp)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const { container } = renderSuffix(Date.now());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 1s");
    // A hidden keep-alive page's interval fires at most once a minute: a
    // 30s gap between ticks must still land on the TRUE elapsed seconds --
    // derived from the stamp, not a self-incrementing counter. (The advance
    // itself moves the mocked clock one more second, landing on 31s.)
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 30));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 31s");
  });

  it("keeps the ticking number out of the host live regions' announcements (aria-hidden)", () => {
    const { container } = renderSuffix(Date.now());
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("freezes at the pause origin and stops ticking while the turn waits on the user", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 1, 0));
    const start = Date.now() - 30_000; // 12:00:30
    const paused = Date.now() - 10_000; // 12:00:50
    const { container } = renderSuffix(start, { pausedSince: paused });
    // The figure reads the clock as of the pause's start (20s of system
    // time; the last 10s are the user's).
    expect(container.textContent).toContain("· 20s");
    // The ticker is stopped while paused: advancing wall time (and any
    // timer the pause left behind -- there are none to fire) moves nothing.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toContain("· 20s");
  });

  it("re-arms the ticker on release: the figure jumps to the wall age and ticks on", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 1, 0));
    const start = Date.now() - 30_000; // 12:00:30
    const paused = Date.now() - 10_000; // 12:00:50
    // A factory per rerender: a reused element would bail out at the root
    // and never re-derive from the changed props.
    const tree = (pausedSince: number | null) => (
      <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
        <WaitElapsedSuffix startedAt={start} pausedSince={pausedSince} />
      </IntlProvider>
    );
    const { rerender, container } = render(tree(paused));
    expect(container.textContent).toContain("· 20s");
    // The user answers: the figure jumps to the turn's true wall age -- the
    // hold is hidden while it lasted, never subtracted.
    rerender(tree(null));
    expect(container.textContent).toContain("· 30s");
    // The interval is running again: a mount-only-arming regression would
    // leave the figure frozen at the pause value for the rest of the turn.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toContain("· 35s");
  });

  it("clamps at 0 when a fresh stamp postdates the stale now a tick left behind", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const t0 = Date.now();
    const tree = (startedAt: number) => (
      <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
        <WaitElapsedSuffix startedAt={startedAt} />
      </IntlProvider>
    );
    const { rerender, container } = render(tree(t0));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 1s");
    // A host that keeps the leaf mounted across windows hands it a stamp
    // the stale now trails (the shipped hosts remount per window -- this is
    // the defensive pin for the documented clamp).
    rerender(tree(t0 + 2_500));
    expect(container.textContent).toContain("· 0s");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 0s");
  });
});
