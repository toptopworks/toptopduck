import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ActiveSourceDeleteDialog } from "../ActiveSourceDeleteDialog";
import type { DatasetDescriptor } from "../../../types/dataset";
import { mockDataset } from "./helpers";
import { renderI18n } from "../../common/__tests__/helpers";

describe("ActiveSourceDeleteDialog (issue #39)", () => {
  const target: DatasetDescriptor = {
    ...mockDataset,
    reference_name: "orders",
    display_name: "orders",
  };
  // AC5: candidates are the FULL remaining set -- everyone but the removed one.
  const candidates: DatasetDescriptor[] = [
    { ...mockDataset, reference_name: "people", display_name: "people" },
    { ...mockDataset, reference_name: "items", display_name: "items" },
  ];

  it("pre-selects the first candidate and confirms with it (AC2/AC5)", () => {
    // AC5: every remaining source is a candidate. AC2: the first is pre-selected
    // so a single Confirm carries (ref, continueWith) to the backend.
    const onConfirm = vi.fn();
    renderI18n(
      <ActiveSourceDeleteDialog
        target={target}
        candidates={candidates}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    // The target is named in the dialog title.
    expect(screen.getByText(/删除焦点源「orders」/)).toBeInTheDocument();
    // AC5: full remaining set renders; the first is checked by default.
    expect(screen.getByRole("radio", { name: "people" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "items" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onConfirm).toHaveBeenCalledWith("people");
  });

  it("lets the user re-pick before confirming (AC2)", () => {
    // The focus moves to whichever source the user chooses, not always the
    // first -- picking items then confirming carries items as the continuation.
    const onConfirm = vi.fn();
    renderI18n(
      <ActiveSourceDeleteDialog
        target={target}
        candidates={candidates}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "items" }));
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onConfirm).toHaveBeenCalledWith("items");
  });

  it("cancel does not fire onConfirm (AC3)", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderI18n(
      <ActiveSourceDeleteDialog
        target={target}
        candidates={candidates}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "中止" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Escape does not close the dialog (explicit guard, issue #105/#766)", () => {
    // The AlertDialog primitive only blocks outside pointer interactions --
    // an unguarded AlertDialog still closes on ESC (issue #766: once closed,
    // pendingActiveDelete stayed mounted and the dialog could not be reopened).
    // The explicit onEscapeKeyDown preventDefault on the content keeps the
    // destructive confirm open: the user must take an explicit 中止 / 继续
    // action, and neither callback fires.
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderI18n(
      <ActiveSourceDeleteDialog
        target={target}
        candidates={candidates}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("overlay-click does not close the dialog or fire callbacks (AlertDialog, issue #111)", async () => {
    // Radix AlertDialog prevents onPointerDownOutside / onInteractOutside, so a
    // pointer-down on the overlay (outside the content) leaves the dialog open
    // and fires neither callback -- the user must take an explicit 中止 / 继续
    // action. Pins the overlay-dismiss path the prior ESC test did not cover.
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderI18n(
      <ActiveSourceDeleteDialog
        target={target}
        candidates={candidates}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    // Radix attaches its pointerdown listener on a setTimeout(0) after mount;
    // flush it before the pointer events so the outside-click is observed.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, { button: 0 });
    fireEvent.click(document.body);
    await new Promise((r) => setTimeout(r, 0));
    // AlertDialog semantics: the destructive confirm stays put; no accidental
    // confirm or cancel.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Action click fires onConfirm but keeps the dialog mounted (preventDefault retry, H-1)", () => {
    // H-1 regression guard (issue #111): AlertDialogAction auto-closes on click,
    // but the handler calls e.preventDefault() to defer close so the parent's
    // async remove decides unmount. A failure leaves the dialog open for retry --
    // verified by onConfirm firing AND the alertdialog still being in the DOM.
    const onConfirm = vi.fn();
    renderI18n(
      <ActiveSourceDeleteDialog
        target={target}
        candidates={candidates}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    expect(onConfirm).toHaveBeenCalledWith("people");
    // preventDefault deferred the auto-close: the dialog is still mounted.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
