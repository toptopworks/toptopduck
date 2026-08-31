import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { GuidedLoadDialog } from "../GuidedLoadDialog";
import type { GuidanceRequest, SheetGuidance } from "../../../types/dataset";
import type { AppError } from "../../../types/error";
import { renderI18n } from "../../common/__tests__/helpers";

// Radix Select's portal + animation model does not cooperate with jsdom's
// synchronous fireEvent inside a Dialog (the dropdown portal never mounts
// before findByRole times out). Mock the primitives as a plain <select> so
// header-row assertions stay integration-level without depending on Radix
// internals (tested upstream by Radix themselves) — same convention as
// ImportSkillsDialog.test.tsx. The skip checkboxes are NOT mocked: Radix
// Checkbox has no portal and cooperates with plain jsdom clicks.
vi.mock("../../ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <select
      data-testid="header-row-select"
      value={value}
      disabled={disabled}
      onChange={(e) => onValueChange(e.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectValue: () => null,
}));

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

  type DialogProps = {
    request: GuidanceRequest;
    loading: boolean;
    error: AppError | null;
    onSubmit: (guidance: SheetGuidance[]) => void;
    onCancel: () => void;
  };

  function renderGuided(props: Partial<DialogProps> = {}) {
    const onSubmit = props.onSubmit ?? vi.fn();
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={() => {}}
        {...props}
      />,
    );
    return { onSubmit };
  }

  const previewRows = () => document.querySelectorAll("table.preview tr");

  it("submits one SheetGuidance per sheet with the chosen header row", () => {
    const { onSubmit } = renderGuided();
    // Default header row is 1; switch to row 2 (the real header).
    fireEvent.change(screen.getByTestId("header-row-select"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加载" }));
    expect(onSubmit).toHaveBeenCalledWith([
      { name: "people", rectify: { header_row: 2, skip_rows: [] } },
    ]);
  });

  it("cancel calls onCancel without submitting", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderGuided({ onSubmit, onCancel });
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
    renderGuided({ onSubmit, onCancel });
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
    renderGuided({ loading: true, onCancel });
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

  it("disables the header select and every skip checkbox while loading", () => {
    renderGuided({ loading: true });
    expect(screen.getByTestId("header-row-select")).toBeDisabled();
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box).toBeDisabled();
    }
  });

  it("renders the preview table via the Table primitive with the .preview class hook (ADR-0067)", () => {
    // ADR-0067: GuidedLoadDialog's native <table className="preview"> was
    // migrated to the Table primitive. The .preview class hook must survive
    // cn() onto the real <table>, and every preview row must render. A
    // regression that drops the className or breaks the primitive render would
    // fail here -- the other GuidedLoadDialog tests only assert onSubmit /
    // onCancel wiring, not the preview-table DOM.
    renderGuided();
    // Radix Dialog renders into a portal on document.body, so query the
    // document, not the render container. The .preview class hook survives
    // cn() onto the real <table>, and every preview row renders.
    expect(document.querySelector("table.preview")).not.toBeNull();
    expect(previewRows()).toHaveLength(request.sheets[0]!.preview.length);
  });

  describe("fixed-height skeleton (issue #749)", () => {
    it("pins header + footer and scrolls only the middle body", () => {
      renderGuided();
      const dialog = screen.getByRole("dialog");
      const dialogClasses = dialog.className.split(/\s+/);
      // The dialog is a fixed-height flex column; it never scrolls itself.
      expect(dialogClasses).toContain("flex");
      expect(dialogClasses).toContain("flex-col");
      expect(dialogClasses).toContain("h-[85vh]");
      expect(dialogClasses).toContain("overflow-hidden");
      const header = dialog.querySelector("[data-slot=\"dialog-header\"]");
      const footer = dialog.querySelector("[data-slot=\"dialog-footer\"]");
      const body = dialog.querySelector("[data-slot=\"dialog-body\"]");
      expect(header).not.toBeNull();
      expect(footer).not.toBeNull();
      expect(body).not.toBeNull();
      // Header + footer never shrink away; only the body scrolls.
      expect(header!.className.split(/\s+/)).toContain("shrink-0");
      expect(footer!.className.split(/\s+/)).toContain("shrink-0");
      const bodyClasses = body!.className.split(/\s+/);
      expect(bodyClasses).toContain("flex-1");
      expect(bodyClasses).toContain("min-h-0");
      expect(bodyClasses).toContain("overflow-y-auto");
      // Sheets stack vertically with a 1px hairline between sections.
      expect(bodyClasses).toContain("divide-y");
    });
  });

  describe("row-state visuals (issue #749)", () => {
    it("marks the header row with the accent tint + a caption 表头 mark", () => {
      renderGuided();
      const first = previewRows()[0]!;
      const classes = first.className.split(/\s+/);
      // Dual channel: the accent background rides the token (dark-mode aware)…
      expect(classes).toContain("bg-accent");
      expect(classes).toContain("text-accent-foreground");
      // …and the caption mark names the row in text, not color alone.
      expect(first).toHaveTextContent("表头");
    });

    it("moves the highlight when the header selection moves", () => {
      renderGuided();
      fireEvent.change(screen.getByTestId("header-row-select"), {
        target: { value: "2" },
      });
      const rows = previewRows();
      expect(rows[0]!.className.split(/\s+/)).not.toContain("bg-accent");
      expect(rows[0]).not.toHaveTextContent("表头");
      expect(rows[1]!.className.split(/\s+/)).toContain("bg-accent");
      expect(rows[1]).toHaveTextContent("表头");
    });

    it("marks a skipped row with the muted tint + desaturated text + a 跳过 mark", () => {
      renderGuided();
      fireEvent.click(
        screen.getByRole("checkbox", { name: "跳过 people 第 3 行" }),
      );
      const third = previewRows()[2]!;
      const classes = third.className.split(/\s+/);
      expect(classes).toContain("bg-muted");
      expect(classes).toContain("text-muted-foreground");
      expect(third).toHaveTextContent("跳过");
    });
  });

  describe("header/skip contradiction invariant (issue #749)", () => {
    it("disables checkboxes for rows at or above the header row", () => {
      renderGuided();
      fireEvent.change(screen.getByTestId("header-row-select"), {
        target: { value: "2" },
      });
      const boxes = screen.getAllByRole("checkbox");
      expect(boxes).toHaveLength(3);
      expect(boxes[0]).toBeDisabled(); // row 1 — above the header
      expect(boxes[1]).toBeDisabled(); // row 2 — the header itself
      expect(boxes[2]).toBeEnabled(); // row 3 — data below the header
    });

    it("moving the header clears any skips the header overtakes", () => {
      const onSubmit = vi.fn();
      renderGuided({ onSubmit });
      fireEvent.click(
        screen.getByRole("checkbox", { name: "跳过 people 第 2 行" }),
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: "跳过 people 第 3 行" }),
      );
      // Move the header onto row 2: the overtaken row-2 skip clears, row 3
      // survives.
      fireEvent.change(screen.getByTestId("header-row-select"), {
        target: { value: "2" },
      });
      expect(
        screen.getByRole("checkbox", { name: "跳过 people 第 2 行" }),
      ).toHaveAttribute("aria-checked", "false");
      expect(
        screen.getByRole("checkbox", { name: "跳过 people 第 3 行" }),
      ).toHaveAttribute("aria-checked", "true");
      // The submitted payload carries no header<=skip combination.
      fireEvent.click(screen.getByRole("button", { name: "加载" }));
      expect(onSubmit).toHaveBeenCalledWith([
        { name: "people", rectify: { header_row: 2, skip_rows: [3] } },
      ]);
    });
  });

  describe("loading + copy (issue #749)", () => {
    it("shows a spinner on the submit button while loading", () => {
      renderGuided({ loading: true });
      const button = screen.getByRole("button", { name: /加载中/ });
      expect(button).toBeDisabled();
      const spinner = button.querySelector("svg");
      expect(spinner).not.toBeNull();
      // SVG elements carry className as an SVGAnimatedString — read the
      // attribute instead.
      expect(spinner!.getAttribute("class")).toContain("animate-spin");
    });

    it("spells out the automatic exclusion of rows above the header", () => {
      renderGuided();
      expect(screen.getByRole("dialog")).toHaveTextContent("自动排除");
    });
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
      renderGuided({ error: guidanceError });
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
      renderGuided();
      expect(document.querySelector("[role=\"alert\"]")).toBeNull();
    });
  });
});
