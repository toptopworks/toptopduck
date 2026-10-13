// The wait-elapsed suffix leaf (issue #1264): derives the whole elapsed
// seconds from the turn-flow-owned wait stamp on a 1s interval. What stays
// here is what only the derivation can pin: derive-from-stamp (a throttled
// ticker heals to the TRUE elapsed time -- never a self-incrementing
// counter), the null-window silence, and the aria-hidden face that keeps
// the per-second change out of the host live regions' announcements.
// The tiered-unit face (issue #1280) lives in its own describe: the leaf
// splits the derived seconds into seconds/minutes/hours tiers and the unit
// spelling stays in the locale catalog.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { catalogFor } from "../../../i18n";
import { WaitElapsedSuffix } from "../WaitElapsedSuffix";

function renderSuffix(
  startedAt: number | null,
  opts: { pausedSince?: number | null; locale?: "zh-CN" | "en-US" } = {},
) {
  const locale = opts.locale ?? "zh-CN";
  return render(
    <IntlProvider locale={locale} messages={catalogFor(locale)}>
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
    expect(container.textContent).toContain("· 1秒");
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toContain("· 5秒");
  });

  it("heals to the true elapsed time after hidden-page throttling (derive-from-stamp)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const { container } = renderSuffix(Date.now());
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 1秒");
    // A hidden keep-alive page's interval fires at most once a minute: a
    // 30s gap between ticks must still land on the TRUE elapsed seconds --
    // derived from the stamp, not a self-incrementing counter. (The advance
    // itself moves the mocked clock one more second, landing on 31s.)
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 30));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 31秒");
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
    expect(container.textContent).toContain("· 20秒");
    // The ticker is stopped while paused: advancing wall time (and any
    // timer the pause left behind -- there are none to fire) moves nothing.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toContain("· 20秒");
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
    expect(container.textContent).toContain("· 20秒");
    // The user answers: the figure jumps to the turn's true wall age -- the
    // hold is hidden while it lasted, never subtracted.
    rerender(tree(null));
    expect(container.textContent).toContain("· 30秒");
    // The interval is running again: a mount-only-arming regression would
    // leave the figure frozen at the pause value for the rest of the turn.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toContain("· 35秒");
  });

  it("floors the display at 1s when a fresh stamp postdates the stale now a tick left behind", () => {
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
    expect(container.textContent).toContain("· 1秒");
    // A host that keeps the leaf mounted across windows hands it a stamp
    // the stale now trails (the shipped hosts remount per window -- this is
    // the defensive pin for the documented clamp). The stale-now clamp
    // (>=0, issue #1264) merges with the first-second floor (>=1, issue
    // #1280): the merged read never shows zero.
    rerender(tree(t0 + 2_500));
    expect(container.textContent).toContain("· 1秒");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 1秒");
  });
});

describe("WaitElapsedSuffix tiered units (issue #1280)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the seconds tier under a minute with the localized unit (zh)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 12));
    const { container } = renderSuffix(Date.now() - 12_000);
    expect(container.textContent).toContain("· 12秒");
  });

  it("enters the minutes tier at 60s with zero-padded seconds (zh)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 5, 5));
    const { container } = renderSuffix(Date.now() - 307_000);
    expect(container.textContent).toContain("· 5分07秒");
  });

  it("enters the hours tier at 3600s with zero-padded minutes and seconds (zh)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 14, 5, 9));
    const { container } = renderSuffix(Date.now() - 7509_000);
    expect(container.textContent).toContain("· 2小时05分09秒");
  });

  it("crosses the minute boundary without a jump (59s -> 1m00s)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 59));
    const { container } = renderSuffix(Date.now() - 59_000);
    expect(container.textContent).toContain("· 59秒");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 1分00秒");
  });

  it("crosses the hour boundary without a jump (59m59s -> 1h00m00s)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 59, 59));
    const { container } = renderSuffix(Date.now() - 3599_000);
    expect(container.textContent).toContain("· 59分59秒");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("· 1小时00分00秒");
  });

  it("keeps the latin unit shape in en-US (seconds tier unchanged)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 12));
    const { container } = renderSuffix(Date.now() - 12_000, { locale: "en-US" });
    expect(container.textContent).toContain("· 12s");
  });

  it("formats the minutes and hours tiers in en-US", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 5, 5));
    const { container } = renderSuffix(Date.now() - 307_000, { locale: "en-US" });
    expect(container.textContent).toContain("· 5m 07s");
    vi.setSystemTime(new Date(2026, 0, 1, 14, 5, 9));
    const hourTier = renderSuffix(Date.now() - 7509_000, { locale: "en-US" });
    expect(hourTier.container.textContent).toContain("· 2h 05m 09s");
  });

  it("floors the first second at 1 in both locales", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const { container } = renderSuffix(Date.now());
    expect(container.textContent).toContain("· 1秒");
    const en = renderSuffix(Date.now(), { locale: "en-US" });
    expect(en.container.textContent).toContain("· 1s");
  });
});
