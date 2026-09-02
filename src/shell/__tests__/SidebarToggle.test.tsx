import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { SidebarToggle } from "../SidebarToggle";

// className pin (issue #774): the topbar ghost icon buttons carry a 28px hit
// area (h-7 w-7) with a 14px glyph (h-3.5 w-3.5) -- WCAG 2.5.8 minimum plus
// margin. jsdom computes no layout, so the pin asserts the Tailwind utilities
// that produce the sizes; visual density is reviewed against DESIGN.md. Both
// `kind` flavors render the same className string, so pinning each flavor's
// state guards the "no drift between the rails" contract from the inside.
// Empty-catalog English IntlProvider resolves aria-labels to the defaultMessage
// literals (the canonical English source, ADR-0052).

function renderToggle(props: { collapsed: boolean; kind?: "session" | "settings" }) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <SidebarToggle onToggle={() => {}} {...props} />
    </IntlProvider>,
  );
}

function pinButtonAndGlyph(name: string) {
  const button = screen.getByRole("button", { name });
  expect(button).toHaveClass("h-7", "w-7");
  const glyph = button.querySelector("svg");
  expect(glyph).toHaveClass("h-3.5", "w-3.5");
}

describe("SidebarToggle hit-area pin", () => {
  it("pins 28px hit area and 14px glyph in the session flavor, expanded state", () => {
    renderToggle({ collapsed: false });
    pinButtonAndGlyph("Collapse session bar");
  });

  it("keeps the pinned utilities in the session flavor, collapsed state", () => {
    renderToggle({ collapsed: true });
    pinButtonAndGlyph("Expand session bar");
  });

  it("pins the same utilities in the settings-overlay flavor", () => {
    renderToggle({ collapsed: false, kind: "settings" });
    pinButtonAndGlyph("Collapse settings navigation");
  });
});
