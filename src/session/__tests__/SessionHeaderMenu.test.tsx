import { describe, it, expect, vi } from "vitest";
import { type ComponentProps, type ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { SessionHeaderMenu } from "../SessionHeaderMenu";
import { catalogFor } from "../../i18n";

// Session-header context menu tests (ADR-0093, issue #512). The menu renders
// four management items (Rename / Save a copy / Close / Delete) + opens local
// dialog state for Rename + Delete.
//
// Radix DropdownMenu's pointer-event handling recurses under jsdom (known
// limitation), so the dropdown-menu module is mocked as a simple controlled
// component: the trigger is a plain <button> that toggles a content div.
// The test verifies SessionHeaderMenu's LOGIC — which items, which callbacks,
// which dialog state — not Radix's portal/focus-trap internals.

vi.mock("@/components/ui/dropdown-menu", () => {
  function DropdownMenu({ children }: { children: ReactNode }) {
    return <div data-testid="dropdown-menu-root">{children}</div>;
  }
  function DropdownMenuTrigger({
    children,
    onClick,
    ...rest
  }: ComponentProps<"button"> & { children: ReactNode }) {
    return (
      <button type="button" onClick={onClick} {...rest}>
        {children}
      </button>
    );
  }
  function DropdownMenuContent({ children }: { children: ReactNode }) {
    return <div role="menu">{children}</div>;
  }
  function DropdownMenuItem({
    children,
    onSelect,
    variant,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    variant?: "default" | "destructive";
  }) {
    return (
      <div
        role="menuitem"
        data-variant={variant ?? "default"}
        onClick={onSelect}
        style={{ cursor: "pointer" }}
      >
        {children}
      </div>
    );
  }
  function DropdownMenuSeparator() {
    return <div role="separator" />;
  }
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
  };
});

// The mock trigger needs an onClick to open the menu. Radix opens on
// pointerDown; the mock opens on click. SessionHeaderMenu renders
// DropdownMenuTrigger as a controlled component, so we wrap it to capture
// the click and render the content.

function renderMenu(overrides: {
  onRename?: (sid: string, path: string, newName: string) => void;
  onExport?: (path: string, displayName: string) => void;
  onClose?: (sid: string) => void;
  onDelete?: (path: string, sid: string) => void;
} = {}) {
  const onRename = overrides.onRename ?? vi.fn();
  const onExport = overrides.onExport ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const onDelete = overrides.onDelete ?? vi.fn();
  render(
    <IntlProvider locale="en-US" messages={catalogFor("en-US")} defaultLocale="en-US">
      <SessionHeaderMenu
        sessionName="My Session"
        duckPath="/test/session.duck"
        sessionId="sess-1"
        onRename={onRename}
        onExport={onExport}
        onClose={onClose}
        onDelete={onDelete}
      />
    </IntlProvider>,
  );
  return { onRename, onExport, onClose, onDelete };
}

// With the mock, the DropdownMenuContent always renders (no open/close logic).
// The trigger button is identified by its aria-label.
function getTrigger() {
  return screen.getByRole("button", { name: "Session actions" });
}

describe("SessionHeaderMenu (issue #512)", () => {
  it("renders the trigger button with the session-actions aria label", () => {
    renderMenu();
    expect(getTrigger()).toBeTruthy();
  });

  it("shows Rename / Save a copy… / Close / Delete items", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: /Rename/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Save a copy…/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Close$/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Delete$/ })).toBeTruthy();
  });

  it("Delete item uses the destructive variant", () => {
    renderMenu();
    const deleteItem = screen.getByRole("menuitem", { name: /^Delete$/ });
    expect(deleteItem.getAttribute("data-variant")).toBe("destructive");
  });

  it("Export fires onExport with duckPath + displayName directly (no dialog)", () => {
    const { onExport } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Save a copy…/ }));
    expect(onExport).toHaveBeenCalledWith("/test/session.duck", "My Session");
  });

  it("Close fires onClose with the session id directly (no dialog)", () => {
    const { onClose } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Close$/ }));
    expect(onClose).toHaveBeenCalledWith("sess-1");
  });

  it("Rename opens the RenameSessionDialog and calls onRename on submit", async () => {
    const { onRename } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));

    // Dialog appears with the initial name prefilled.
    const input = await screen.findByLabelText("Session name");
    expect((input as HTMLInputElement).value).toBe("My Session");

    // Edit the name and save.
    fireEvent.change(input, { target: { value: "Renamed Session" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onRename).toHaveBeenCalledWith("sess-1", "/test/session.duck", "Renamed Session");
  });

  it("Delete opens the DeleteSessionDialog and calls onDelete on confirm", async () => {
    const { onDelete } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/ }));

    // Confirmation dialog appears.
    const confirmButton = await screen.findByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirmButton);

    expect(onDelete).toHaveBeenCalledWith("/test/session.duck", "sess-1");
  });

  it("Rename dialog dismisses after submit (setDialog(null) fires)", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));

    const input = await screen.findByLabelText("Session name");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The dialog input should no longer be in the document.
    expect(screen.queryByLabelText("Session name")).toBeNull();
  });

  it("Delete dialog dismisses after confirm (setDialog(null) fires)", async () => {
    renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/ }));

    const confirmButton = await screen.findByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirmButton);

    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();
  });

  it("Rename cancel does not call onRename and dismisses the dialog", async () => {
    const { onRename } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));

    const input = await screen.findByLabelText("Session name");
    expect(input).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Session name")).toBeNull();
  });

  it("Delete cancel does not call onDelete and dismisses the dialog", async () => {
    const { onDelete } = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^Delete$/ }));

    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    fireEvent.click(cancelButton);

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Delete permanently" })).toBeNull();
  });
});
