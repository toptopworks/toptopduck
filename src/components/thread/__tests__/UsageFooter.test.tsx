// The usage pill's own pins (ADR-0129 Decision 5 as recalibrated by
// issue #1278): the always-visible pill names the turn's derived total
// (input + output) on the fixed K/M scale, its click-open Popover carries
// the bucket detail -- input with its cache-read breakdown and hit rate,
// cache write, output, reasoning -- at the label/number level split, and
// the zero-breakdown shapes omit the cache row and the rate entirely.

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { UsageFooter } from "../UsageFooter";
import type { TokenUsage } from "../../../types/thread";

// defaultMessage-only (the dialog-test precedent): the en literals are the
// contract under test, so an empty message catalog + a silenced reporter
// keeps the assertions on the source strings.
function renderFooter(usage: TokenUsage) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <UsageFooter usage={usage} />
    </IntlProvider>,
  );
}

function usage(over: Partial<TokenUsage> = {}): TokenUsage {
  return {
    input_tokens: 1234,
    cache_read_tokens: 800,
    cache_write_tokens: 0,
    output_tokens: 567,
    reasoning_tokens: undefined,
    ...over,
  };
}

// The pill trigger opens the Popover on click (the picker-test precedent),
// and the bucket detail rides the portal's dialog surface.
function openDetail() {
  fireEvent.click(screen.getByRole("button", { name: /Used / }));
  return screen.getByRole("dialog");
}

describe("UsageFooter pill (ADR-0129 recalibrated, issue #1278)", () => {
  it("renders the always-visible pill with the derived total on the fixed K/M scale", () => {
    renderFooter(usage());
    // 1234 + 567 = 1801 -> "1.8K" under the fixed formatter; the pill is
    // a keyboard-reachable dialog trigger, not a hover fact (Decision 5's
    // always-visible essence, recalibrated).
    const pill = screen.getByRole("button", { name: "Used 1.8K" });
    expect(pill).toHaveAttribute("aria-haspopup", "dialog");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the bucket detail on click: cache-read breakdown with its hit rate", () => {
    renderFooter(usage());
    const detail = openDetail();
    expect(within(detail).getByText("Turn usage")).toBeInTheDocument();
    // 1234 -> "1.2K", 800 verbatim below 1K; the hit rate is cache-read
    // over input on the shared floored-decimal percent (64.8).
    expect(detail.textContent).toContain("Input 1.2K");
    expect(detail.textContent).toContain("cache 800 · 64.8%");
    expect(detail.textContent).toContain("Output 567");
  });

  it("levels the detail rows: muted labels against foreground tabular numbers", () => {
    renderFooter(usage());
    openDetail();
    // The muted-prefix convention (the turn card's posture): the row
    // carries the mute, the figure its own foreground + tabular element.
    expect(screen.getByText("Output").className).toContain("text-muted-foreground");
    expect(screen.getByText("567").className).toContain("tabular-nums");
    expect(screen.getByText("567").className).toContain("text-foreground");
  });

  it("omits the cache row and the hit rate when the read breakdown is zero", () => {
    renderFooter(usage({ cache_read_tokens: 0 }));
    const detail = openDetail();
    // A zero read after normalization cannot distinguish "no hits" from
    // "upstream did not report one" -- no row, no rate, no percent sign.
    expect(within(detail).queryByText(/cache/)).not.toBeInTheDocument();
    expect(detail.textContent).not.toContain("%");
    expect(detail.textContent).toContain("Input 1.2K");
  });

  it("rides cache write / reasoning rows only when the fields report", () => {
    renderFooter(usage({ cache_write_tokens: 2300, reasoning_tokens: 641 }));
    const detail = openDetail();
    expect(within(detail).getByText(/cache write/).textContent).toContain("2.3K");
    expect(within(detail).getByText(/reasoning/).textContent).toContain("641");
  });

  it("keeps the technical rows out when neither reports", () => {
    renderFooter(usage());
    const detail = openDetail();
    expect(within(detail).queryByText(/cache write/)).not.toBeInTheDocument();
    expect(within(detail).queryByText(/reasoning/)).not.toBeInTheDocument();
  });
});
