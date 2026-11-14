// The selection toolbar's own pins (#1573): the right-click coexistence
// posture -- the toolbar's area never opens the native menu (the ADR-0149
// policy layer's default stays untouched everywhere else).

import { describe, expect, it } from "vitest";
import { renderI18n } from "../../common/__tests__/helpers";
import { SelectionToolbar } from "../SelectionToolbar";

describe("SelectionToolbar (#1573)", () => {
  it("swallows the context menu on its own area", () => {
    const { container } = renderI18n(
      <SelectionToolbar onQuote={() => {}} onCopy={() => {}} />,
    );
    const toolbar = container.querySelector("[data-selection-toolbar]");
    expect(toolbar).not.toBeNull();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    (toolbar as HTMLElement).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
