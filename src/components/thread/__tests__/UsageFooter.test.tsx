// The usage footer's own pins (ADR-0129 Decision 5, issue #1270): the
// always-visible segments (input with its cache-read breakdown, output),
// the absent-breakdown shape, and the technical fold's presence rules
// (cache write / reasoning mount it, their absence keeps the line flat).

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("UsageFooter (ADR-0129, issue #1270)", () => {
  it("renders the always-visible input / cache / output segments on the fixed K/M scale", () => {
    renderFooter(usage());
    // 1234 -> "1.2K" under the en compact formatter.
    expect(screen.getByText("Input 1.2K")).toBeInTheDocument();
    expect(screen.getByText("cache 800")).toBeInTheDocument();
    expect(screen.getByText("Output 567")).toBeInTheDocument();
  });

  it("omits the cache segment when the breakdown is zero", () => {
    renderFooter(usage({ cache_read_tokens: 0 }));
    expect(screen.queryByText(/^cache /)).not.toBeInTheDocument();
    expect(screen.getByText("Input 1.2K")).toBeInTheDocument();
  });

  it("mounts the technical fold for cache write / reasoning and stays flat without them", () => {
    const { rerender } = renderFooter(usage());
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <UsageFooter
          usage={usage({ cache_write_tokens: 90, reasoning_tokens: 12 })}
        />
      </IntlProvider>,
    );
    // The native <details> is the fold's group; its body carries both
    // counters (present in the DOM regardless of the open posture).
    const fold = screen.getByRole("group");
    expect(fold).toBeInTheDocument();
    expect(fold.textContent).toContain("cache write 90");
    expect(fold.textContent).toContain("reasoning 12");
  });
});
