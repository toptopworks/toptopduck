import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { NavButtons } from "../NavButtons";
import { NavigationHistoryContext } from "../useNavigationHistory";

// className pin (issue #774): the back/forward buttons share NAV_BUTTON_CLASS
// -- the single source of truth for the ghost-button styling -- so both must
// carry the 28px hit area (h-7 w-7) and 14px glyph (h-3.5 w-3.5). jsdom
// computes no layout, so the pin asserts the Tailwind utilities; visual
// density is reviewed against DESIGN.md. useNavigationHistory throws outside
// a provider, so a stub context value satisfies the contract instead of
// mounting the full history provider. Empty-catalog English IntlProvider
// resolves aria-labels to the defaultMessage literals (ADR-0052).

function renderNavButtons() {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <NavigationHistoryContext.Provider
        value={{ canBack: true, canForward: true, back: () => {}, forward: () => {} }}
      >
        <NavButtons />
      </NavigationHistoryContext.Provider>
    </IntlProvider>,
  );
}

function pinButtonAndGlyph(name: string) {
  const button = screen.getByRole("button", { name });
  expect(button).toHaveClass("h-7", "w-7");
  const glyph = button.querySelector("svg");
  expect(glyph).toHaveClass("h-3.5", "w-3.5");
}

describe("NavButtons hit-area pin", () => {
  it("pins 28px hit area and 14px glyph on the back button", () => {
    renderNavButtons();
    pinButtonAndGlyph("Back");
  });

  it("pins the same utilities on the forward button (no drift)", () => {
    renderNavButtons();
    pinButtonAndGlyph("Forward");
  });
});
