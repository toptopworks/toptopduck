import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { DeleteSessionDialog, RenameSessionDialog } from "../SessionSidebar";

// Both dialogs route their chrome through react-intl (ADR-0052). Rendered inside
// an empty-catalog English IntlProvider so FormattedMessage falls back to its
// defaultMessage -- the canonical English source (ADR-0052) -- and assertions
// anchor on stable English strings without coupling to the zh-CN catalog.
// onError silences the expected missing-message warnings.
function renderDialog(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

describe("DeleteSessionDialog (issue #111)", () => {
  it("overlay-click does not close the dialog or fire a callback (AlertDialog destructive semantics)", async () => {
    // Radix AlertDialog prevents onPointerDownOutside / onInteractOutside, so a
    // pointer-down on the overlay leaves the destructive confirm open and fires
    // neither onCancel nor onConfirm -- the user must take an explicit action.
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderDialog(<DeleteSessionDialog name="sess" path="/x/s.duck" onCancel={onCancel} onConfirm={onConfirm} />);
    // Radix attaches its pointerdown listener on a setTimeout(0) after mount.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, { button: 0 });
    fireEvent.click(document.body);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Escape does not fire the destructive onConfirm (AlertDialog safety)", () => {
    // Radix AlertDialog blocks outside-click but NOT Escape -- the shell closes
    // on ESC. The contract that matters for a destructive dialog is that ESC
    // never fires the destructive action, so onConfirm stays un-called.
    const onConfirm = vi.fn();
    renderDialog(<DeleteSessionDialog name="sess" path={null} onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Cancel routes to onCancel only (no cross-talk to onConfirm)", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderDialog(<DeleteSessionDialog name="sess" path={null} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Delete routes to onConfirm only (no cross-talk to onCancel)", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    renderDialog(<DeleteSessionDialog name="sess" path={null} onCancel={onCancel} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("RenameSessionDialog (issue #111)", () => {
  it("Escape routes to onCancel via the onOpenChange bridge (does not submit)", async () => {
    // The Radix Dialog routes ESC through onOpenChange(false), which this dialog
    // bridges to onCancel -- ESC never reaches onSubmit.
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    renderDialog(<RenameSessionDialog initialName="old" onCancel={onCancel} onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("overlay-click routes to onCancel via the onOpenChange bridge (does not submit)", async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    renderDialog(<RenameSessionDialog initialName="old" onCancel={onCancel} onSubmit={onSubmit} />);
    // Radix attaches its pointerdown listener on a setTimeout(0) after mount.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, { button: 0 });
    fireEvent.click(document.body);
    await new Promise((r) => setTimeout(r, 0));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables Save when the name is blank", () => {
    renderDialog(<RenameSessionDialog initialName="" onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("disables Save when the name is whitespace-only", () => {
    renderDialog(<RenameSessionDialog initialName="   " onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("submits the edited value via onSubmit on Save", () => {
    const onSubmit = vi.fn();
    renderDialog(<RenameSessionDialog initialName="old" onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "new name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith("new name");
  });

  it("does not submit when the edited name is blank", () => {
    // The Save button is disabled for a blank value, so the form cannot submit a
    // blank name (the guard is value.trim() on both the disabled prop and the
    // submit handler).
    const onSubmit = vi.fn();
    renderDialog(<RenameSessionDialog initialName="old" onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // A direct form submit (e.g. Enter) is also refused by the trim guard.
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
