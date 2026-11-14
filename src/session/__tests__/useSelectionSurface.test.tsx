import { useCallback, useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogFor } from "../../i18n";
import { useSelectionSurface } from "../useSelectionSurface";
import { SelectionToolbar } from "../../components/thread/SelectionToolbar";

// The gesture machine's pins (#1573): appear on release, the dismiss
// matrix, right-click coexistence, focus-in-toolbar immunity, and
// reposition-without-dismiss on scroll. Geometry is jsdom-blind -- the
// placement math is pinned separately (selectionSurfacePosition.test.ts);
// here the toolbar renders (its data hook queries it directly) while its
// inline visibility may stay hidden.

function selectText(el: HTMLElement): void {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(el);
  const selection = doc.getSelection();
  if (selection === null) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function toolbarEl(): HTMLElement | null {
  return document.querySelector("[data-selection-toolbar]");
}

function Harness({
  onQuote,
  enabled = true,
}: {
  onQuote: (text: string) => void;
  enabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { active, toolbarRef, dismiss, clearSelection } = useSelectionSurface(
    rootRef,
    enabled,
  );
  const [lastQuote, setLastQuote] = useState<string | null>(null);
  const handleQuote = useCallback(() => {
    if (active === null) return;
    setLastQuote(active.text);
    onQuote(active.text);
    dismiss();
    clearSelection();
  }, [active, onQuote, dismiss, clearSelection]);
  return (
    <IntlProvider locale="en-US" messages={catalogFor("en-US")}>
      <div ref={rootRef} id="surface-root">
        <div data-selection-source="">
          <span id="prose-a">first passage</span>
        </div>
        <div data-selection-source="">
          <span id="prose-b">second passage</span>
        </div>
        <div id="unmarked">
          <span id="plain">plain text</span>
        </div>
        {active !== null && (
          <SelectionToolbar ref={toolbarRef} onQuote={handleQuote} onCopy={() => {}} />
        )}
        {lastQuote !== null && <output>quoted:{lastQuote}</output>}
      </div>
    </IntlProvider>
  );
}

function appearViaPointer(): void {
  const prose = document.getElementById("prose-a") as HTMLElement;
  selectText(prose);
  const root = document.getElementById("surface-root") as HTMLElement;
  fireEvent.pointerDown(root, { button: 0 });
  fireEvent.pointerUp(root, { button: 0 });
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe("useSelectionSurface (#1573 gesture machine)", () => {
  it("appears when a drag selection releases (pointerup window)", () => {
    render(<Harness onQuote={() => {}} />);
    const prose = document.getElementById("prose-a") as HTMLElement;
    selectText(prose);
    // The selection exists BEFORE the gesture window opens: the pointerdown
    // re-arms, and only the release may show it.
    const root = document.getElementById("surface-root") as HTMLElement;
    expect(toolbarEl()).toBeNull();
    fireEvent.pointerDown(root, { button: 0 });
    expect(toolbarEl()).toBeNull();
    fireEvent.pointerUp(root, { button: 0 });
    expect(toolbarEl()).not.toBeNull();
  });

  it("appears when a Shift keyboard selection releases", () => {
    render(<Harness onQuote={() => {}} />);
    const root = document.getElementById("surface-root") as HTMLElement;
    // A toolbar from a prior selection closes while Shift is held.
    appearViaPointer();
    expect(toolbarEl()).not.toBeNull();
    fireEvent.keyDown(root, { key: "Shift" });
    expect(toolbarEl()).toBeNull();
    selectText(document.getElementById("prose-b") as HTMLElement);
    fireEvent.keyUp(root, { key: "Shift" });
    expect(toolbarEl()).not.toBeNull();
  });

  it("never appears for a selection outside a marked prose container", () => {
    render(<Harness onQuote={() => {}} />);
    selectText(document.getElementById("unmarked") as HTMLElement);
    const root = document.getElementById("surface-root") as HTMLElement;
    fireEvent.pointerDown(root, { button: 0 });
    fireEvent.pointerUp(root, { button: 0 });
    expect(toolbarEl()).toBeNull();
  });

  it("quotes the staged selection and clears itself", () => {
    const onQuote = vi.fn();
    render(<Harness onQuote={onQuote} />);
    appearViaPointer();
    // The toolbar may be visibility:hidden under jsdom's zero geometry (the
    // placement hides what it cannot place) -- text queries see it anyway.
    // Copy leads the toolbar (#1573 reference shots); the quote button is
    // found by its label, not by position.
    const quoteButton = [...(toolbarEl() as HTMLElement).querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Add to conversation"));
    expect(quoteButton).toBeDefined();
    fireEvent.click(quoteButton as HTMLElement);
    expect(onQuote).toHaveBeenCalledWith("first passage");
    // The dismissal + selection clear rode the quote handler.
    expect(toolbarEl()).toBeNull();
    expect(document.getSelection()?.isCollapsed ?? true).toBe(true);
    expect(screen.getByText("quoted:first passage")).toBeInTheDocument();
  });

  it("dismisses when the selection collapses or clears", () => {
    render(<Harness onQuote={() => {}} />);
    appearViaPointer();
    expect(toolbarEl()).not.toBeNull();
    document.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(toolbarEl()).toBeNull();
  });

  it("dismisses on Escape, pointercancel, and window blur", () => {
    render(<Harness onQuote={() => {}} />);
    const root = document.getElementById("surface-root") as HTMLElement;
    const cases: Array<() => void> = [
      () => fireEvent.keyDown(root, { key: "Escape" }),
      () => fireEvent.pointerCancel(root),
      () => fireEvent(window, new Event("blur")),
    ];
    for (const fire of cases) {
      appearViaPointer();
      expect(toolbarEl()).not.toBeNull();
      fire();
      expect(toolbarEl()).toBeNull();
    }
  });

  it("right-click coexists: a non-primary press neither dismisses nor re-arms", () => {
    render(<Harness onQuote={() => {}} />);
    appearViaPointer();
    const root = document.getElementById("surface-root") as HTMLElement;
    fireEvent.pointerDown(root, { button: 2 });
    expect(toolbarEl()).not.toBeNull();
    // The right press also re-armed nothing: a later pointerup without a
    // primary press shows nothing new.
    fireEvent.pointerUp(root, { button: 2 });
    expect(toolbarEl()).not.toBeNull();
  });

  it("dismisses on a primary press outside the toolbar", () => {
    render(<Harness onQuote={() => {}} />);
    appearViaPointer();
    const root = document.getElementById("surface-root") as HTMLElement;
    fireEvent.pointerDown(root, { button: 0 });
    expect(toolbarEl()).toBeNull();
  });

  it("keeps the toolbar while focus sits inside it, even as the selection moves", () => {
    render(<Harness onQuote={() => {}} />);
    appearViaPointer();
    const toolbar = toolbarEl() as HTMLElement;
    const button = toolbar.querySelector("button");
    (button as HTMLButtonElement).focus();
    selectText(document.getElementById("prose-b") as HTMLElement);
    fireEvent(document, new Event("selectionchange"));
    expect(toolbarEl()).not.toBeNull();
    // Focus elsewhere resumes the normal dismiss contract.
    (button as HTMLButtonElement).blur();
    fireEvent(document, new Event("selectionchange"));
    expect(toolbarEl()).toBeNull();
  });

  it("repositions on scroll without dismissing", () => {
    render(<Harness onQuote={() => {}} />);
    appearViaPointer();
    const rail = document.createElement("div");
    document.body.appendChild(rail);
    fireEvent.scroll(rail);
    expect(toolbarEl()).not.toBeNull();
    rail.remove();
  });

  it("dismisses when the pane deactivates (session switch)", () => {
    const { rerender } = render(<Harness onQuote={() => {}} enabled={true} />);
    appearViaPointer();
    expect(toolbarEl()).not.toBeNull();
    rerender(<Harness onQuote={() => {}} enabled={false} />);
    expect(toolbarEl()).toBeNull();
  });

  it("selection changes during the drag window never appear early", () => {
    render(<Harness onQuote={() => {}} />);
    const root = document.getElementById("surface-root") as HTMLElement;
    const prose = document.getElementById("prose-a") as HTMLElement;
    fireEvent.pointerDown(root, { button: 0 });
    selectText(prose);
    fireEvent(document, new Event("selectionchange"));
    expect(toolbarEl()).toBeNull();
    fireEvent.pointerUp(root, { button: 0 });
    expect(toolbarEl()).not.toBeNull();
  });
});
