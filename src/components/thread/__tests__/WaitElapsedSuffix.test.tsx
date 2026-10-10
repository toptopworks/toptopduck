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

function renderSuffix(startedAt: number | null) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <WaitElapsedSuffix startedAt={startedAt} />
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
});
