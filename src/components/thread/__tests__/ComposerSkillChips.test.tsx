import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { catalogFor } from "../../../i18n";
import { ComposerSkillChips } from "../ComposerSkillChips";

// The pre-activation chip surface (ADR-0112 Decision 3): one chip per intent,
// in pick order, pure display -- withdrawal rides the composer's Backspace at
// the draft start, not a per-chip affordance. Rendered inside a zh-CN
// IntlProvider so the aria label reads through the real catalog.
function renderChips(ui: ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      {ui}
    </IntlProvider>,
  );
}

describe("ComposerSkillChips (ADR-0112 pre-activation display)", () => {
  it("renders nothing for an empty intent list", () => {
    const { container } = renderChips(<ComposerSkillChips names={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one chip per intent, in pick order", () => {
    renderChips(<ComposerSkillChips names={["charting", "data-cleaning"]} />);
    expect(screen.getByRole("list", { name: "预激活技能" })).toBeInTheDocument();
    const chips = screen.getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual(["charting", "data-cleaning"]);
  });
});
