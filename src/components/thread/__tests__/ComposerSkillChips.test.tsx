import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { fireEvent } from "@testing-library/react";
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
    expect(screen.getByRole("list", { name: "技能" })).toBeInTheDocument();
    const chips = screen.getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual(["charting", "data-cleaning"]);
  });

  it("renders a removal button per chip and reports the removed name", () => {
    // The in-session exit (issue #961, ADR-0118 Decision 4): every chip
    // carries a visible removal affordance; a click reports the name (the
    // App-level dispatch cascades unmount + intent withdrawal).
    const onRemove = vi.fn();
    renderChips(
      <ComposerSkillChips names={["charting"]} onRemove={onRemove} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "移除技能 charting" }));
    expect(onRemove).toHaveBeenCalledWith("charting");
  });

  it("renders no removal buttons without the callback", () => {
    // The pure display posture (the Backspace withdrawal alone) stays
    // available for callers that do not wire the dispatch.
    renderChips(<ComposerSkillChips names={["charting"]} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
