import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { ThinkingFold } from "../ThinkingFold";
import type { ThinkingTrace } from "../../../types/thread";

function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

const THINKING: ThinkingTrace = { duration_ms: 1200, text: "inner reasoning" };

// Issue #1363: the expanded thinking block is a height-capped scroll
// container; without focusability keyboard users cannot reach its tail,
// so it carries tabindex/region semantics. The scroll itself is
// browser-native once the container can take focus -- jsdom cannot
// exercise it.
describe("ThinkingFold scroll container (issue #1363)", () => {
  it("keeps the block unmounted while collapsed", () => {
    renderWithProviders(<ThinkingFold thinking={THINKING} />);
    expect(document.querySelector(".round-thinking")).toBeNull();
  });

  it("exposes the expanded block as a focusable scrollable region", () => {
    renderWithProviders(<ThinkingFold thinking={THINKING} />);
    fireEvent.click(screen.getByRole("button", { name: /thinking/i }));
    const block = document.querySelector(".round-thinking");
    expect(block).not.toBeNull();
    expect(block).toHaveAttribute("tabindex", "0");
    expect(block).toHaveAttribute("role", "region");
    expect(block).toHaveAttribute("aria-label", "Agent thinking");
    // A stray `//` comment at the fragment's children position compiles to
    // literal text (#1363 review); the block must carry only its content.
    expect(screen.queryByText(/Keyboard-reachable/)).not.toBeInTheDocument();
  });
});
