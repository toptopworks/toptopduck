import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { TechnicalDetailsFold } from "../TechnicalDetailsFold";

function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

// Issue #1363: the error-stack <pre> is a height-capped scroll container;
// tabindex/region semantics put it on the keyboard path (the scroll is
// browser-native once the container can take focus).
describe("TechnicalDetailsFold scroll container (issue #1363)", () => {
  it("renders the stack as a focusable scrollable region", () => {
    const { container } = renderWithProviders(
      <TechnicalDetailsFold detail="boom at line 1" defaultOpen />,
    );
    const stack = container.querySelector(".error-stack");
    expect(stack).not.toBeNull();
    expect(stack).toHaveAttribute("tabindex", "0");
    expect(stack).toHaveAttribute("role", "region");
    expect(stack).toHaveAttribute("aria-label", "Error stack");
  });
});
