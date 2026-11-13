import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { catalogFor } from "../../../i18n";
import { ComposerQuoteChips } from "../ComposerQuoteChips";
import type { QuoteEntry } from "../../../session/useComposerState";

// Quote chips render zh-CN like the composer does (ADR-0052): the labels
// assert through the zh-CN catalog's own wording.

function renderChips(quotes: readonly QuoteEntry[], onRemove?: (id: number) => void) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <ComposerQuoteChips quotes={quotes} onRemove={onRemove} />
    </IntlProvider>,
  );
}

describe("ComposerQuoteChips (#1573)", () => {
  it("renders nothing for an empty staging", () => {
    const { container } = renderChips([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one chip per staged entry with a capped excerpt", () => {
    renderChips([
      { id: 1, text: "精简" },
      { id: 2, text: "很".repeat(40) },
    ]);
    expect(screen.getByLabelText("引用的段落")).toBeInTheDocument();
    expect(screen.getByText("精简")).toBeInTheDocument();
    // The long text caps at 30 chars + ellipsis (the excerpt helper's cap).
    expect(screen.getByText(`${"很".repeat(30)}…`)).toBeInTheDocument();
  });

  it("renders duplicated stagings as separate chips keyed by id", () => {
    renderChips([
      { id: 1, text: "同文" },
      { id: 2, text: "同文" },
    ]);
    expect(screen.getAllByText("同文")).toHaveLength(2);
  });

  it("removes by staging id from the per-chip button", () => {
    const onRemove = vi.fn();
    renderChips(
      [
        { id: 7, text: "甲" },
        { id: 9, text: "乙" },
      ],
      onRemove,
    );
    fireEvent.click(screen.getByRole("button", { name: "移除引用：乙" }));
    expect(onRemove).toHaveBeenCalledWith(9);
  });

  it("omits the removal button when onRemove is absent (pure display)", () => {
    renderChips([{ id: 1, text: "甲" }]);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
