import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { GuidedLoadDialog } from "../GuidedLoadDialog";
import type { GuidanceRequest, SheetGuidance } from "../../../types/dataset";
import type { AppError } from "../../../types/error";
import { renderI18n, withIntl } from "../../common/__tests__/helpers";

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
        total_rows: 3,
        reason: "MultipleHeaderRows",
      },
    ],
  };

  type DialogProps = {
    request: GuidanceRequest;
    loading: boolean;
    error: AppError | null;
    onSubmit: (guidance: SheetGuidance[]) => void;
    onCancel: () => void;
    onFetchWindow: (sheetName: string, offset: number, limit: number) => Promise<string[][]>;
  };

  function renderGuided(props: Partial<DialogProps> = {}) {
    const onSubmit = props.onSubmit ?? vi.fn();
    const onFetchWindow = props.onFetchWindow ?? vi.fn().mockResolvedValue([]);
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={false}
        error={null}
        onSubmit={onSubmit}
        onCancel={() => {}}
        onFetchWindow={onFetchWindow}
        {...props}
      />,
    );
    return { onSubmit, onFetchWindow };
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

    it("pins the sticky first column with its per-state opaque background", () => {
      renderGuided();
      // Skip row 3 so all three row states are present at once.
      fireEvent.click(
        screen.getByRole("checkbox", { name: "跳过 people 第 3 行" }),
      );
      const cellClasses = Array.from(previewRows()).map(
        (row) => row.querySelector("td")!.className.split(/\s+/),
      );
      // Every state: sticky positioning + z-lift, so the column survives the
      // table's horizontal scroll instead of scrolling away with the data.
      for (const classes of cellClasses) {
        expect(classes).toContain("sticky");
        expect(classes).toContain("left-0");
        expect(classes).toContain("z-10");
      }
      // The opaque fill matches the row state — this is the occlusion that
      // keeps scrolled-past cells from shining through the first column.
      expect(cellClasses[0]).toContain("bg-accent");
      expect(cellClasses[1]).toContain("bg-background");
      expect(cellClasses[2]).toContain("bg-muted");
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

    it("keeps each sheet's choices independent across sheets", () => {
      const onSubmit = vi.fn();
      const twoSheets: GuidanceRequest = {
        source_path: "/x/two.xlsx",
        workbook_name: "two",
        sheets: [
          { name: "people", preview: [["meta"], ["id"], ["1"]], total_rows: 3, reason: null },
          { name: "orders", preview: [["junk"], ["qty"], ["7"]], total_rows: 3, reason: null },
        ],
      };
      renderGuided({ request: twoSheets, onSubmit });
      // The mocked Select renders one native select per sheet, in workbook
      // order — index 0 is "people".
      const peopleSelect = screen.getAllByTestId("header-row-select")[0]!;
      // Independent choices per sheet: header + skip on people, a skip on orders.
      fireEvent.change(peopleSelect, { target: { value: "2" } });
      fireEvent.click(
        screen.getByRole("checkbox", { name: "跳过 people 第 3 行" }),
      );
      fireEvent.click(
        screen.getByRole("checkbox", { name: "跳过 orders 第 2 行" }),
      );
      fireEvent.click(screen.getByRole("button", { name: "加载" }));
      expect(onSubmit).toHaveBeenCalledWith([
        { name: "people", rectify: { header_row: 2, skip_rows: [3] } },
        { name: "orders", rectify: { header_row: 1, skip_rows: [2] } },
      ]);
      // Moving sheet A's header cannot disturb sheet B's skips — a toggle
      // that clobbers the other sheets' entries fails here.
      fireEvent.change(peopleSelect, { target: { value: "3" } });
      expect(
        screen.getByRole("checkbox", { name: "跳过 orders 第 2 行" }),
      ).toHaveAttribute("aria-checked", "true");
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

  describe("preview-window paging (issue #750)", () => {
    // A 30-row sheet: the first 12-row window rides the inlined preview, the
    // rest arrive through onFetchWindow. The fetch mock fabricates the rows
    // for whatever [offset, limit) the pager asks, so every window renders
    // with absolute numbering.
    function bigRequest(): GuidanceRequest {
      return {
        source_path: "/x/big.xlsx",
        workbook_name: "big",
        sheets: [
          {
            name: "big",
            preview: Array.from({ length: 12 }, (_, i) => [`r${i + 1}`]),
            total_rows: 30,
            reason: null,
          },
        ],
      };
    }

    const windowRows = (_sheet: string, offset: number, limit: number) =>
      Promise.resolve(
        Array.from({ length: Math.min(limit, 30 - offset) }, (_, i) => [`r${offset + i + 1}`]),
      );

    it("shows the pager with an accurate position when the sheet outgrows one window", () => {
      renderGuided({ request: bigRequest() });
      expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled();
      expect(screen.getByRole("dialog")).toHaveTextContent("第 1–12 行 / 共 30 行");
    });

    it("hides the pager entirely for a sheet that fits one window", () => {
      // The default fixture's 3 rows fit one window -- the experience stays
      // exactly what it was before paging landed (no pager, no indicator).
      renderGuided();
      expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
      expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
    });

    it("next fetches the next window and re-numbers rows absolutely", async () => {
      const onFetchWindow = vi.fn(windowRows);
      renderGuided({ request: bigRequest(), onFetchWindow });
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await waitFor(() => expect(onFetchWindow).toHaveBeenCalledWith("big", 12, 12));
      await screen.findByText("r13");
      // The position indicator moves with the window (polite live region).
      expect(screen.getByRole("dialog")).toHaveTextContent("第 13–24 行 / 共 30 行");
      // Row numbers stay ABSOLUTE -- the window's first row reads 13, not 1.
      expect(
        screen.getByRole("checkbox", { name: "跳过 big 第 13 行" }),
      ).toBeInTheDocument();
    });

    it("disables next on the last window and prev on the first", async () => {
      const onFetchWindow = vi.fn(windowRows);
      renderGuided({ request: bigRequest(), onFetchWindow });
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("r13");
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      // The final window is short: rows 25–30, and next-page disables.
      await screen.findByText("r25");
      expect(screen.getByRole("dialog")).toHaveTextContent("第 25–30 行 / 共 30 行");
      expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "上一页" }));
      await screen.findByText("r13");
      fireEvent.click(screen.getByRole("button", { name: "上一页" }));
      await screen.findByText("r1");
      expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    });

    it("a failed window fetch keeps the current window", async () => {
      // A retention miss (committed / discarded / superseded) or IPC failure
      // must not blank the preview: the dialog keeps the window it has, the
      // pager re-arms, and the user can still submit what they see.
      const onFetchWindow = vi.fn(() => Promise.reject(new Error("retention gone")));
      const onSubmit = vi.fn();
      renderGuided({ request: bigRequest(), onSubmit, onFetchWindow });
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await waitFor(() => expect(onFetchWindow).toHaveBeenCalledWith("big", 12, 12));
      // The fetch flag clears -> the pager re-arms on the original window.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled(),
      );
      expect(screen.getByText("r1")).toBeInTheDocument();
      expect(screen.queryByText("r13")).toBeNull();
      expect(screen.getByRole("dialog")).toHaveTextContent("第 1–12 行 / 共 30 行");
      // "Submit what they see" pinned: the default pick on the kept window
      // goes through.
      fireEvent.click(screen.getByRole("button", { name: "加载" }));
      expect(onSubmit).toHaveBeenCalledWith([
        { name: "big", rectify: { header_row: 1, skip_rows: [] } },
      ]);
    });

    it("the header dropdown offers only the current window's rows", async () => {
      const onFetchWindow = vi.fn(windowRows);
      renderGuided({ request: bigRequest(), onFetchWindow });
      const select = screen.getByTestId("header-row-select");
      const optionValues = () =>
        Array.from(select.querySelectorAll("option")).map((o) => o.getAttribute("value"));
      expect(optionValues()).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("r13");
      // After paging, rows 1–12 are invisible -> unselectable.
      expect(optionValues()).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 13)));
    });

    it("selections made across windows coexist and submit as absolute rows", async () => {
      const onSubmit = vi.fn();
      const onFetchWindow = vi.fn(windowRows);
      renderGuided({ request: bigRequest(), onSubmit, onFetchWindow });
      // Window 1: header row 3 + skip row 5.
      fireEvent.change(screen.getByTestId("header-row-select"), { target: { value: "3" } });
      fireEvent.click(screen.getByRole("checkbox", { name: "跳过 big 第 5 行" }));
      // Window 2: skip row 15 -- row 5's tick must survive the page swap.
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("r13");
      fireEvent.click(screen.getByRole("checkbox", { name: "跳过 big 第 15 行" }));
      fireEvent.click(screen.getByRole("button", { name: "加载" }));
      expect(onSubmit).toHaveBeenCalledWith([
        { name: "big", rectify: { header_row: 3, skip_rows: [5, 15] } },
      ]);
    });

    it("a header picked beyond the first window survives paging back and submits by absolute row", async () => {
      // AC3 end to end: a workbook whose header sits at row 13 is located via
      // paging, selected there, and submits with header_row 13 -- no suite
      // ever selected or submitted a header beyond the first window before
      // (review finding 1). jsdom note: the trigger's placeholder fallback
      // for an out-of-window value is a real-Radix rendering detail (the
      // behavior suite mocks SelectValue), so the pin is the data path --
      // the pick survives the page swap and submits as the absolute row.
      const onSubmit = vi.fn();
      const onFetchWindow = vi.fn(windowRows);
      renderGuided({ request: bigRequest(), onSubmit, onFetchWindow });
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("r13");
      fireEvent.change(screen.getByTestId("header-row-select"), { target: { value: "13" } });
      // Page back to window 1: row 13 is invisible again, but the pick rides
      // in absolute row numbers and must not be clobbered by the swap.
      fireEvent.click(screen.getByRole("button", { name: "上一页" }));
      await screen.findByText("r1");
      fireEvent.click(screen.getByRole("button", { name: "加载" }));
      expect(onSubmit).toHaveBeenCalledWith([
        { name: "big", rectify: { header_row: 13, skip_rows: [] } },
      ]);
    });

    it("a same-path re-route resets the window to the new first window", async () => {
      // The remount key is the path (#748), so a workbook fixed on disk and
      // re-dropped at the SAME path re-parks the dialog without remounting
      // it -- the inlined preview is replaced in place and the pager must
      // follow the new parse, or the table keeps rendering the old one
      // (review finding 2: stale rows past the new total, pager gone).
      const onFetchWindow = vi.fn(windowRows);
      const props = {
        loading: false,
        error: null as AppError | null,
        onSubmit: vi.fn(),
        onCancel: () => {},
        onFetchWindow,
      };
      const view = renderI18n(<GuidedLoadDialog request={bigRequest()} {...props} />);
      // Park on window 2 of the original 30-row parse.
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await screen.findByText("r13");
      // Same path, fresh parse: the fixed sheet now fits one window.
      view.rerender(
        withIntl(
          <GuidedLoadDialog
            request={{
              source_path: "/x/big.xlsx",
              workbook_name: "big",
              sheets: [
                {
                  name: "big",
                  preview: Array.from({ length: 8 }, (_, i) => [`n${i + 1}`]),
                  total_rows: 8,
                  reason: null,
                },
              ],
            }}
            {...props}
          />,
        ),
      );
      await screen.findByText("n1");
      // The old parse's rows are gone, and a sheet that fits one window
      // shows no pager at all (the position indicator rides the pager).
      expect(screen.queryByText("r13")).toBeNull();
      expect(screen.queryByRole("button", { name: "上一页" })).toBeNull();
    });
  });

  describe("auto-tidy failure reasons (issue #750)", () => {
    it("renders the sheet's failure reason under its heading", () => {
      // The default fixture sheet carries MultipleHeaderRows.
      renderGuided();
      expect(screen.getByRole("dialog")).toHaveTextContent("检测到多个疑似表头行");
    });

    it("renders no reason line for a sheet that tidied confidently", () => {
      renderGuided({
        request: {
          source_path: "/x/two.xlsx",
          workbook_name: "two",
          sheets: [
            { name: "clean", preview: [["id"], ["1"]], total_rows: 2, reason: null },
            { name: "rough", preview: [["x"], ["2"]], total_rows: 2, reason: "NoHeaderRow" },
          ],
        },
      });
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("数据从第一行开始");
      expect(dialog).not.toHaveTextContent("检测到多个疑似表头行");
    });
  });
});
