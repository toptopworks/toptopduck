// The usage footer's own pins (ADR-0129 Decision 5, issue #1270; the line
// rework is issue #1276): the always-visible segments parted by ` · `
// (input with its cache-read breakdown, output), the label/number level
// split, the absent-breakdown shape, and the technical fold's presence
// rules -- a labeled native toggle whose numbers ride the [open] gate.

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("UsageFooter segments (ADR-0129/0130, issue #1276)", () => {
  it("renders the input / cache / output segments on the fixed K/M scale, parted by ` · `", () => {
    const { container } = renderFooter(usage());
    // 1234 -> "1.2K" under the fixed formatter; labels and numbers read as
    // separate elements (the muted-label / tabular-number level split).
    expect(screen.getByText("Input")).toBeInTheDocument();
    expect(screen.getByText("1.2K")).toBeInTheDocument();
    expect(screen.getByText("cache")).toBeInTheDocument();
    expect(screen.getByText("800")).toBeInTheDocument();
    expect(screen.getByText("Output")).toBeInTheDocument();
    expect(screen.getByText("567")).toBeInTheDocument();
    expect(container.textContent).toContain("Input 1.2K · cache 800 · Output 567");
  });

  it("levels the line: muted labels against foreground tabular numbers", () => {
    renderFooter(usage());
    // The muted-prefix convention (the turn card's `Thinking · 0.2s`
    // posture): the label spans carry the mute, the number spans the
    // foreground + tabular utilities.
    const label = screen.getByText("Output").closest("span.usage-seg");
    expect(label?.className).toContain("text-muted-foreground");
    expect(screen.getByText("567").className).toContain("tabular-nums");
    expect(screen.getByText("567").className).toContain("text-foreground");
  });

  it("omits the cache segment when the breakdown is zero", () => {
    renderFooter(usage({ cache_read_tokens: 0 }));
    expect(screen.queryByText("cache")).not.toBeInTheDocument();
    expect(screen.getByText("Input")).toBeInTheDocument();
  });
});

describe("UsageFooter technical fold (ADR-0129, issue #1276)", () => {
  it("mounts the labeled fold for cache write / reasoning and stays flat without them", () => {
    const { rerender } = renderFooter(usage());
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <UsageFooter
          usage={usage({ cache_write_tokens: 2300, reasoning_tokens: 641 })}
        />
      </IntlProvider>,
    );
    // The native <details> is the fold's group. Collapsed, the toggle
    // names its items -- the numbers ride the [open] gate (app.css), so
    // they sit in the DOM inside their gated spans in both postures.
    const fold = screen.getByRole("group");
    expect(fold.hasAttribute("open")).toBe(false);
    expect(within(fold).getByText("cache write")).toBeInTheDocument();
    expect(within(fold).getByText("reasoning")).toBeInTheDocument();
    const nums = fold.querySelectorAll(".usage-fold-num");
    expect(nums).toHaveLength(2);
    expect(nums[0].textContent).toBe("2.3K");
    expect(nums[1].textContent).toBe("641");
    // The full line reads as one flow, the toggle after the segments.
    expect(fold.textContent).toContain("cache write 2.3K · reasoning 641");
  });

  it("the marker is the fold's pointer, not a bare ellipsis", () => {
    renderFooter(usage({ cache_write_tokens: 90 }));
    const fold = screen.getByRole("group");
    const marker = fold.querySelector(".usage-fold-marker");
    expect(marker?.textContent).toBe("▸");
    // No legacy ellipsis summary, no dangling block body: the toggle is
    // the labeled summary line itself.
    expect(fold.textContent).not.toContain("…");
    expect(fold.querySelector(".usage-fold-body")).toBeNull();
  });
});
