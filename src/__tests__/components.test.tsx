import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DatasetDetail } from "../components/DatasetDetail";
import { DisclosureBanner } from "../components/DisclosureBanner";
import { GuidedLoadDialog } from "../components/GuidedLoadDialog";
import { WorkingSetList } from "../components/WorkingSetList";
import type { DatasetDescriptor, GuidanceRequest } from "../types";

const mockDataset: DatasetDescriptor = {
  reference_name: "people",
  display_name: "people",
  source_path: "/x/people.csv",
  row_count: 5,
  fingerprint: "abc123def4560000000000000000000000000000000000000000000000000999",
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "name", canonical_type: "VARCHAR" },
  ],
  sample: [
    ["1", "Alice"],
    ["2", "Bob"],
  ],
  rectify: { kind: "NotApplicable" },
};

describe("DisclosureBanner", () => {
  it("discloses the default-to-send payload and local-only guarantee", () => {
    render(<DisclosureBanner />);
    expect(screen.getByText(/完整数据集永不离开本机/)).toBeInTheDocument();
    expect(screen.getByText(/首 3 行样本/)).toBeInTheDocument();
  });

  it("discloses Excel formula cells use cached snapshot values (issue #7 AC4)", () => {
    const { container } = render(<DisclosureBanner />);
    expect(container).toHaveTextContent(/Excel 工作簿按 sheet 分别加载为独立/);
    expect(container).toHaveTextContent(/隐藏的工作表会被跳过/);
    expect(container).toHaveTextContent(/公式单元格取加载时的缓存值（不重算）/);
    // issue #10: disclose auto-tidy + guided fallback + .xls rejection.
    expect(container).toHaveTextContent(/自动规整/);
    expect(container).toHaveTextContent(/请另存为 .xlsx/);
  });
});

describe("DatasetDetail", () => {
  it("renders canonical column types and the frozen sample", () => {
    render(<DatasetDetail dataset={mockDataset} />);
    expect(screen.getByText("BIGINT")).toBeInTheDocument();
    expect(screen.getByText("VARCHAR")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
  });

  it("shows a no-rows hint when the sample is empty", () => {
    render(<DatasetDetail dataset={{ ...mockDataset, sample: [], row_count: 0 }} />);
    expect(screen.getByText(/无数据行/)).toBeInTheDocument();
  });

  it("renders fully expanded nested DuckDB types (issue #6)", () => {
    const nested: DatasetDescriptor = {
      ...mockDataset,
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "address", canonical_type: "STRUCT(city VARCHAR, zip VARCHAR)" },
        { name: "tags", canonical_type: "LIST(VARCHAR)" },
      ],
      sample: [["1", "{'city': NYC}", "[a, b]"]],
    };
    render(<DatasetDetail dataset={nested} />);
    expect(screen.getByText("STRUCT(city VARCHAR, zip VARCHAR)")).toBeInTheDocument();
    expect(screen.getByText("LIST(VARCHAR)")).toBeInTheDocument();
  });
});

describe("WorkingSetList", () => {
  // window.prompt spies must not leak between tests (jsdom default returns null).
  afterEach(() => vi.restoreAllMocks());

  it("lists datasets and marks the active one", () => {
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName="people"
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    // The select button's accessible name starts with the display label; the
    // rename sibling's starts with "重命名" -- anchor on the leading label so
    // the two buttons never collide on a /people/ substring match.
    expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument();
    expect(screen.getByText(/当前表/)).toBeInTheDocument();
  });

  it("shows an empty hint when there are no datasets", () => {
    render(
      <WorkingSetList datasets={[]} activeName={null} onSelect={() => {}} onRename={() => {}} />,
    );
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
  });

  it("renames a dataset's display label via prompt (ADR-0037, issue #8)", () => {
    const onRename = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    // Carries the stable reference name + the new display label; the reference
    // name is what the parent keys selection off, so it survives the rename.
    expect(onRename).toHaveBeenCalledWith("people", "员工表");
  });

  it("ignores an empty, cancelled, or no-change rename prompt", () => {
    const onRename = vi.fn();
    const promptSpy = vi.spyOn(window, "prompt");
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    const renameBtn = screen.getByRole("button", { name: /重命名/ });
    // Cancel (null), empty string, and a no-change answer all count as "no
    // rename" -- onRename must never fire. One render, repeated clicks, so the
    // queries don't accumulate across renders.
    for (const answer of [null, "", mockDataset.display_name]) {
      onRename.mockClear();
      promptSpy.mockReturnValue(answer);
      fireEvent.click(renameBtn);
      expect(onRename).not.toHaveBeenCalled();
    }
  });
});

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
    render(
      <GuidedLoadDialog
        request={request}
        loading={false}
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
    render(
      <GuidedLoadDialog
        request={request}
        loading={false}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /取消/ }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
