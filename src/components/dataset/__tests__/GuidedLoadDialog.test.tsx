import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { GuidedLoadDialog } from "../GuidedLoadDialog";
import type { GuidanceRequest } from "../../../types/dataset";
import type { AppError } from "../../../types/error";
import { renderI18n } from "../../common/__tests__/helpers";

describe("GuidedLoadDialog", () => {
  const request: GuidanceRequest = {
    source_path: "/x/m.xlsx",
    workbook_name: "m",
    sheets: [
      {
        name: "people",
        preview: [
          ["meta", "info"],
          ["id", "name"],
          ["1", "Alice"],
        ],
      },
    ],
  };

  it("submits one SheetGuidance per sheet with the chosen header row", () => {
    const onSubmit = vi.fn();
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    // Default header row is 1; switch to row 2 (the real header).
    const select = screen.getByLabelText(/表头所在行/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /按选择加载/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      { name: "people", rectify: { header_row: 2, skip_rows: [] } },
    ]);
  });

  it("cancel calls onCancel without submitting", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Escape dismisses via the onOpenChange→onCancel bridge, not onSubmit (issue #111)", async () => {
    // The Radix Dialog routes ESC through onOpenChange(false), which this dialog
    // bridges to onCancel. The prior cancel test only exercised the button; this
    // pins the ESC→onCancel path and that it never reaches onSubmit.
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("prevents ESC + overlay dismiss while loading (ingest cannot be interrupted, issue #111)", async () => {
    // onEscapeKeyDown / onInteractOutside call preventDefault mid-load so a
    // pending ingest isn't aborted by an accidental ESC or overlay click --
    // mirroring the cancel / submit buttons' loading-disabled state.
    const onCancel = vi.fn();
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={true}
        error={null}
        onSubmit={() => {}}
        onCancel={onCancel}
      />,
    );
    // ESC while loading is swallowed by the guard.
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    // Radix attaches its pointerdown listener on a setTimeout(0) after mount.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.pointerDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, { button: 0 });
    fireEvent.click(document.body);
    await new Promise((r) => setTimeout(r, 0));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("renders the preview table via the Table primitive with the .preview class hook (ADR-0067)", () => {
    // ADR-0067: GuidedLoadDialog's native <table className="preview"> was
    // migrated to the Table primitive. The .preview class hook must survive
    // cn() onto the real <table>, and every preview row must render. A
    // regression that drops the className or breaks the primitive render would
    // fail here -- the other GuidedLoadDialog tests only assert onSubmit /
    // onCancel wiring, not the preview-table DOM.
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={false}
        error={null}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Radix Dialog renders into a portal on document.body, so query the
    // document, not the render container. The .preview class hook survives
    // cn() onto the real <table>, and every preview row renders.
    expect(document.querySelector("table.preview")).not.toBeNull();
    expect(document.querySelectorAll("table.preview tr")).toHaveLength(
      request.sheets[0]!.preview.length,
    );
  });

  describe("inline error (issue #748)", () => {
    const guidanceError: AppError = {
      message: "加载失败：文件无法解析",
      kind: "load",
      detail: "parse boom",
    };

    it("renders the error banner inside the dialog, above the footer", () => {
      // The workspace banner sits behind the modal scrim, so a guided-submit
      // failure must surface INSIDE the dialog. ErrorBanner renders a
      // role="alert" Alert with the message + the technical-details fold.
      renderI18n(
        <GuidedLoadDialog
          request={request}
          loading={false}
          error={guidanceError}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      );
      const dialog = screen.getByRole("dialog");
      const alert = screen.getByRole("alert");
      expect(dialog.contains(alert)).toBe(true);
      expect(alert).toHaveTextContent("加载失败：文件无法解析");
      // The technical detail rides the shared collapsed fold.
      const fold = document.querySelector(".error-details");
      expect(fold).not.toBeNull();
      expect(fold).toHaveTextContent("parse boom");
      // Above the footer: the banner precedes the footer in document order.
      const footer = document.querySelector("[data-slot=\"dialog-footer\"]");
      expect(footer).not.toBeNull();
      expect(
        alert.compareDocumentPosition(footer!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("renders no alert when error is null", () => {
      renderI18n(
        <GuidedLoadDialog
          request={request}
          loading={false}
          error={null}
          onSubmit={() => {}}
          onCancel={() => {}}
        />,
      );
      expect(document.querySelector("[role=\"alert\"]")).toBeNull();
    });
  });
});
