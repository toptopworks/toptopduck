import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { TraceSummaryFold } from "../TraceSummaryFold";

function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

// Issue #1363: the expanded summary block is a height-capped scroll
// container; tabindex/region semantics put it on the keyboard path (the
// scroll is browser-native once the container can take focus).
describe("TraceSummaryFold scroll container (issue #1363)", () => {
  it("keeps the block unmounted while collapsed", () => {
    renderWithProviders(
      <TraceSummaryFold
        summary="SELECT * FROM result_1"
        summaryClassName="trace-summary"
      />,
    );
    expect(document.querySelector(".summary-fold-block")).toBeNull();
  });

  it("exposes the expanded block as a focusable scrollable region", () => {
    const { container } = renderWithProviders(
      <TraceSummaryFold
        summary="SELECT * FROM result_1"
        summaryClassName="trace-summary"
      />,
    );
    const toggle = container.querySelector(".summary-fold-toggle");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle as Element);
    const block = document.querySelector(".summary-fold-block");
    expect(block).not.toBeNull();
    expect(block).toHaveAttribute("tabindex", "0");
    expect(block).toHaveAttribute("role", "region");
    expect(block).toHaveAttribute("aria-label", "Full summary");
    // A stray `//` comment at the fragment's children position compiles to
    // literal text (#1363 review); the block must carry only its content.
    expect(screen.queryByText(/Keyboard-reachable/)).not.toBeInTheDocument();
  });
});
