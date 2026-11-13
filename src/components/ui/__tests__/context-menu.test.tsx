import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../context-menu";

// The Radix ContextMenu wrapper (ADR-0149): opens on the `contextmenu` event
// at the pointer position, selects through onSelect, and dismisses on Escape /
// outside click. The policy layer (useContextMenuPolicy) exempts the
// trigger's own preventDefault, so opening a custom menu must claim the event
// (no native double-pop) and commit the open synchronously.
function triggerContextMenu(target: Element): boolean {
  let prevented = false;
  act(() => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    prevented = !target.dispatchEvent(event);
  });
  return prevented;
}

function Harness({ onSelect, disabled }: { onSelect: () => void; disabled?: boolean }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div data-testid="surface">surface</div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Row menu">
        <ContextMenuItem disabled={disabled} onSelect={onSelect}>
          Rename
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

describe("ContextMenu wrapper", () => {
  it("claims the event and opens role=menu in a portal", () => {
    render(<Harness onSelect={() => {}} />);
    const prevented = triggerContextMenu(screen.getByTestId("surface"));
    expect(prevented).toBe(true);
    expect(screen.getByRole("menu", { name: "Row menu" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
  });

  it("selects through onSelect and closes the menu", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    triggerContextMenu(screen.getByTestId("surface"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("does not select through a disabled item", () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} disabled />);
    triggerContextMenu(screen.getByTestId("surface"));
    const item = screen.getByRole("menuitem", { name: "Rename" });
    expect(item).toHaveAttribute("data-disabled");
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    render(<Harness onSelect={() => {}} />);
    triggerContextMenu(screen.getByTestId("surface"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
