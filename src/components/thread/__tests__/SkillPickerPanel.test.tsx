import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { catalogFor } from "../../../i18n";
import { skillEntry } from "../../../test-fixtures";
import { SkillPickerPanel } from "../SkillPickerPanel";

// The row text anatomy while a query is active (ADR-0112 Decision 5, issue
// #978): every case-insensitive hit of the query renders in the foreground
// through the shared search core's needle, and the row text dims around it.
// These pins ride the panel's rendered spans so the highlighting cannot
// silently split from the match core it must agree with.

function renderPanel(ui: ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      {ui}
    </IntlProvider>,
  );
}

function makePanel(query: string, name = "Charting") {
  return (
    <SkillPickerPanel
      id="test-panel"
      mode="skills"
      skills={[skillEntry(name, { description: "Draw charts" })]}
      query={query}
      totalSkills={1}
      activatedNames={new Set()}
      highlightIndex={0}
      onHoverIndex={vi.fn()}
      onSelect={vi.fn()}
    />
  );
}

describe("SkillPickerPanel hit highlighting", () => {
  it("wraps case-insensitive hits of the query in foreground spans", () => {
    renderPanel(makePanel("CHART"));
    // The hit span keeps the row text's own casing ("Chart" out of
    // "Charting"); the description's hit keeps its lower-case slice.
    expect(screen.getByText("Chart").className).toContain("text-foreground");
    expect(screen.getByText("chart").className).toContain("text-foreground");
  });

  it("trims the query before matching hits", () => {
    renderPanel(makePanel("  CHART  "));
    expect(screen.getByText("Chart").className).toContain("text-foreground");
  });

  it("highlights every occurrence across name and description", () => {
    renderPanel(makePanel("a", "data-cleaning"));
    const hits = screen.getAllByText("a");
    expect(hits).toHaveLength(5); // three in d[a]t[a]-cle[a]ning, two in Dr[a]w ch[a]rts
    for (const hit of hits) {
      expect(hit.className).toContain("text-foreground");
    }
  });

  it("renders plain row text for an empty query -- no hit spans", () => {
    const { container } = renderPanel(makePanel("   "));
    expect(container.querySelectorAll(".text-foreground")).toHaveLength(0);
  });
});
