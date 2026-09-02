import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { WorkspaceToggle } from "../WorkspaceToggle";

// className pin (issue #774): the workspace-panel toggle carries the same
// topbar ghost icon button spec as the sidebar toggle and the nav buttons --
// 28px hit area (h-7 w-7) with a 14px glyph (h-3.5 w-3.5). Unlike the nav
// pair, this className is an independent copy (no shared constant), so both
// glyph states are pinned to guard drift against the other two components.
// jsdom computes no layout, so the pin asserts the Tailwind utilities; visual
// density is reviewed against DESIGN.md. Empty-catalog English IntlProvider
// resolves aria-labels to the defaultMessage literals (ADR-0052).

function renderToggle(collapsed: boolean) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <WorkspaceToggle collapsed={collapsed} onToggle={() => {}} />
    </IntlProvider>,
  );
}

function pinButtonAndGlyph(name: string) {
  const button = screen.getByRole("button", { name });
  expect(button).toHaveClass("h-7", "w-7");
  const glyph = button.querySelector("svg");
  expect(glyph).toHaveClass("h-3.5", "w-3.5");
}

describe("WorkspaceToggle hit-area pin", () => {
  it("pins 28px hit area and 14px glyph in the expanded state", () => {
    renderToggle(false);
    pinButtonAndGlyph("Close workspace");
  });

  it("keeps the pinned utilities in the collapsed state", () => {
    renderToggle(true);
    pinButtonAndGlyph("Open workspace");
  });
});
