import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { GuidedLoadDialog } from "../GuidedLoadDialog";
import type { GuidanceRequest } from "../../../types/dataset";
import { renderI18n } from "../../common/__tests__/helpers";

// Control-systematization audit (issue #749): the dialog swept its native
// <select> / <input type=checkbox> / bare <h3> onto the design-system
// primitives. This file renders the REAL primitives (the behavior suite
// mocks only the Select portal, which jsdom cannot open) and pins the
// static contract: roles present, native controls absent, label/heading
// wiring intact.
describe("GuidedLoadDialog control systematization (issue #749)", () => {
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
        // Deferred state -> the full form renders (a resolved sheet would
        // start collapsed on its summary, #751).
        state: { kind: "NeedsGuidance", data: { reason: "MultipleHeaderRows" } },
      },
    ],
  };

  function renderDialog(overrides?: Partial<{ request: GuidanceRequest }>) {
    renderI18n(
      <GuidedLoadDialog
        request={request}
        loading={false}
        error={null}
        onSubmit={() => {}}
        onCancel={() => {}}
        onFetchWindow={() => Promise.resolve([])}
        {...overrides}
      />,
    );
  }

  it("renders design-system controls only — no native select or checkbox inputs", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("select")).toBeNull();
    expect(dialog.querySelector("input[type=\"checkbox\"]")).toBeNull();
    // Header row = Select primitive (combobox trigger).
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    // Skip toggles = Checkbox primitives, one per preview row.
    expect(screen.getAllByRole("checkbox")).toHaveLength(
      request.sheets[0]!.preview.length,
    );
  });

  it("associates the header-row label with the Select trigger", () => {
    renderDialog();
    const label = document.querySelector("label");
    const trigger = screen.getByRole("combobox");
    expect(label).not.toBeNull();
    expect(label!.getAttribute("for")).toBe(trigger.id);
    expect(trigger.id).not.toBe("");
  });

  it("styles the sheet heading with headline-sm tokens instead of a bare h3", () => {
    renderDialog();
    const h3 = document.querySelector("h3");
    expect(h3).not.toBeNull();
    expect(h3).toHaveTextContent("people");
    const classes = h3!.className.split(/\s+/);
    expect(classes).toContain("text-base");
    expect(classes).toContain("font-semibold");
  });

  it("labels the preview table by its sheet heading", () => {
    renderDialog();
    const table = document.querySelector("table.preview");
    const labelledBy = table?.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent("people");
  });

  it("labels each skip checkbox with the sheet name and row number", () => {
    renderDialog();
    expect(
      screen.getByRole("checkbox", { name: "跳过 people 第 1 行" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "跳过 people 第 2 行" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "跳过 people 第 3 行" }),
    ).toBeInTheDocument();
  });

  it("joins the checkbox and its row number into one hit target", () => {
    renderDialog();
    const box = screen.getByRole("checkbox", { name: "跳过 people 第 3 行" });
    const label = document.querySelector(`label[for="${box.id}"]`);
    // The row number + state mark ride a label bound to the checkbox, so the
    // whole first cell is clickable — not just the 16px button (#749 review).
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent("3");
    fireEvent.click(label!);
    expect(box).toHaveAttribute("aria-checked", "true");
  });

  it("renders the pager as Button primitives + a polite live position (issue #750)", () => {
    // A sheet that outgrows one 3-row window: the pager appears, built from
    // the design-system Button (outline/icon), with the position indicator
    // as the live region a page swap announces through.
    renderDialog({
      request: {
        source_path: "/x/big.xlsx",
        workbook_name: "big",
        sheets: [
          {
            name: "big",
            preview: [["r1"], ["r2"], ["r3"]],
            total_rows: 8,
            state: { kind: "NeedsGuidance", data: { reason: "MultipleHeaderRows" } },
          },
        ],
      },
    });
    const prev = screen.getByRole("button", { name: "上一页" });
    const next = screen.getByRole("button", { name: "下一页" });
    for (const button of [prev, next]) {
      expect(button.getAttribute("data-slot")).toBe("button");
      const classes = button.className.split(/\s+/);
      // Outline variant (border + background surface) at the icon size --
      // the 36px size-9 hit target stays over the 24px minimum.
      expect(classes).toContain("border");
      expect(classes).toContain("bg-background");
      expect(classes).toContain("size-9");
    }
    const live = document.querySelector("[aria-live=\"polite\"]");
    expect(live).not.toBeNull();
    expect(live).toHaveTextContent("第 1–3 行 / 共 8 行");
  });
});
