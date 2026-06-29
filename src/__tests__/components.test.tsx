import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DatasetDetail } from "../components/DatasetDetail";
import { DisclosureBanner } from "../components/DisclosureBanner";
import { GuidedLoadDialog } from "../components/GuidedLoadDialog";
import { PrivacyControls } from "../components/PrivacyControls";
import { ResultView } from "../components/ResultView";
import { Thread } from "../components/Thread";
import { WorkingSetList } from "../components/WorkingSetList";
import { readRows } from "../api";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  GuidanceRequest,
  TurnRecord,
} from "../types";

// WorkingSetList's replace action opens the Tauri file dialog; stub it so the
// tests can drive the picker without the native bridge.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, readRows: vi.fn() };
});

import { open } from "@tauri-apps/plugin-dialog";

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
  privacy: { send_samples: true, type_only_columns: [] },
};

// The ADR-0011 default: samples on, no type-only columns.
const defaultPrivacy: DatasetPrivacy = { send_samples: true, type_only_columns: [] };

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

  it("discloses the per-dataset / per-column privacy control surface (issue #9)", () => {
    const { container } = render(<DisclosureBanner />);
    expect(container).toHaveTextContent(/按数据集关闭样本发送/);
    expect(container).toHaveTextContent(/按列标记「仅类型」/);
  });
});

describe("DatasetDetail", () => {
  it("renders canonical column types and the frozen sample", () => {
    render(<DatasetDetail dataset={mockDataset} />);
    expect(screen.getByText("BIGINT")).toBeInTheDocument();
    expect(screen.getByText("VARCHAR")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    // Privacy controls are absent when onPrivacyChange is not supplied.
    expect(screen.queryByText(/隐私控制/)).toBeNull();
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

  it("renders privacy controls + disclosure when onPrivacyChange is supplied (issue #9)", () => {
    render(<DatasetDetail dataset={mockDataset} onPrivacyChange={() => {}} />);
    // The sample toggle and the per-column "type only" header are present.
    expect(screen.getByText(/隐私控制/)).toBeInTheDocument();
    expect(screen.getByText(/向云端 LLM 发送样本值/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /仅类型/ })).toBeInTheDocument();
    // Default disclosure: samples sent, both columns' names sent.
    expect(screen.getByText(/发送冻结的首 3 行样本值/)).toBeInTheDocument();
    expect(screen.getByText(/id、name/)).toBeInTheDocument();
  });
});

describe("PrivacyControls", () => {
  it("defaults to samples on and no type-only columns (ADR-0011)", () => {
    render(
      <PrivacyControls dataset={mockDataset} loading={false} onPrivacyChange={() => {}} />,
    );
    const sampleToggle = screen.getByLabelText(/向云端 LLM 发送样本值/);
    expect(sampleToggle).toBeChecked();
    // Neither column is type-only by default.
    expect(screen.getByLabelText(/仅类型 id/)).not.toBeChecked();
    expect(screen.getByLabelText(/仅类型 name/)).not.toBeChecked();
  });

  it("turning off samples emits the whole config with send_samples=false (AC1)", () => {
    const onPrivacyChange = vi.fn();
    render(
      <PrivacyControls dataset={mockDataset} loading={false} onPrivacyChange={onPrivacyChange} />,
    );
    fireEvent.click(screen.getByLabelText(/向云端 LLM 发送样本值/));
    expect(onPrivacyChange).toHaveBeenCalledWith("people", {
      ...defaultPrivacy,
      send_samples: false,
    });
  });

  it("marking a column type-only adds it to type_only_columns (AC2)", () => {
    const onPrivacyChange = vi.fn();
    render(
      <PrivacyControls dataset={mockDataset} loading={false} onPrivacyChange={onPrivacyChange} />,
    );
    fireEvent.click(screen.getByLabelText(/仅类型 name/));
    expect(onPrivacyChange).toHaveBeenCalledWith("people", {
      ...defaultPrivacy,
      type_only_columns: ["name"],
    });
  });

  it("unmarking a type-only column removes it from the config", () => {
    const onPrivacyChange = vi.fn();
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: true, type_only_columns: ["name"] },
    };
    render(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={onPrivacyChange} />,
    );
    fireEvent.click(screen.getByLabelText(/仅类型 name/));
    expect(onPrivacyChange).toHaveBeenCalledWith("people", {
      send_samples: true,
      type_only_columns: [],
    });
  });

  it("discloses hidden columns as type-only in the current payload summary", () => {
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: false, type_only_columns: ["name"] },
    };
    render(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={() => {}} />,
    );
    // Samples off + one type-only column reflected honestly.
    expect(screen.getByText(/不发送任何样本值/)).toBeInTheDocument();
    expect(screen.getByText(/1 列仅类型/)).toBeInTheDocument();
    // The type-only column name is NOT listed among sent columns.
    expect(screen.getByText(/id）/)).toBeInTheDocument();
  });

  it("ignores stale type-only entries for columns that no longer exist", () => {
    // After a schema-changing replace, a type-only entry for a dropped column
    // must not show up as "hidden" -- only current columns count.
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: true, type_only_columns: ["gone"] },
    };
    render(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={() => {}} />,
    );
    // No hidden columns reported (the stale "gone" isn't a current column) --
    // the summary ends with the sent list and a period, never the "列仅类型" clause.
    expect(screen.queryByText(/列仅类型/)).toBeNull();
    expect(screen.getByText(/id、name）。/)).toBeInTheDocument();
  });

  it("shows empty sent columns when all columns are type-only", () => {
    // When every column is marked type-only, sentColumnNames is empty and the
    // disclosure renders "0 列发送" without a parenthesised column list.
    const dataset: DatasetDescriptor = {
      ...mockDataset,
      privacy: { send_samples: false, type_only_columns: ["id", "name"] },
    };
    render(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={() => {}} />,
    );
    expect(screen.getByText(/0 列发送/)).toBeInTheDocument();
    expect(screen.getByText(/2 列仅类型/)).toBeInTheDocument();
  });

  it("disables the toggles while loading (prevents concurrent IPC)", () => {
    render(
      <PrivacyControls dataset={mockDataset} loading={true} onPrivacyChange={() => {}} />,
    );
    expect(screen.getByLabelText(/向云端 LLM 发送样本值/)).toBeDisabled();
    expect(screen.getByLabelText(/仅类型 id/)).toBeDisabled();
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

  it("trims surrounding whitespace before renaming", () => {
    const onRename = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("  员工表  ");
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    // trimmed before reaching the parent -> backend gets a clean label
    expect(onRename).toHaveBeenCalledWith("people", "员工表");
  });

  it("ignores a whitespace-only rename prompt", () => {
    const onRename = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("   ");
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /重命名/ }));
    expect(onRename).not.toHaveBeenCalled();
  });

  it("disables the rename button while loading (prevents concurrent IPC)", () => {
    // A rename in flight locks the button: rapid double-clicks must not fire a
    // second IPC before the first settles (the backend would run its label-
    // collision check against stale state and reject a valid rename).
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByRole("button", { name: /重命名/ })).toBeDisabled();
  });

  it("picks a file and replaces the dataset via onReplace (issue #11)", async () => {
    // AC4: replace is a distinct entry from add. The per-row button opens a
    // structured-file picker (no xlsx) and forwards the choice with the stable
    // reference name -- the name the backend takes over.
    const onReplace = vi.fn();
    vi.mocked(open).mockResolvedValue("/x/new.csv");
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={onReplace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /换源/ }));
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith("people", "/x/new.csv"));
  });

  it("ignores a cancelled replace picker (issue #11)", async () => {
    const onReplace = vi.fn();
    vi.mocked(open).mockResolvedValue(null); // cancelled
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={onReplace}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /换源/ }));
    await waitFor(() => expect(vi.mocked(open)).toHaveBeenCalled());
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("disables the replace button while loading (issue #11)", () => {
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onReplace={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByRole("button", { name: /换源/ })).toBeDisabled();
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

describe("ResultView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders rows, total, and the assumption note from readRows", async () => {
    // AC: the materialized result is shown as a table + row count; the
    // assumption note (ADR-0009) renders as a correctable side note.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "n", canonical_type: "BIGINT" }],
      rows: [["5"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    render(<ResultView referenceName="result_1" assumption="把 id 当作主键" />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("result_1", 0, 100));
    expect(screen.getByText(/行数：1/)).toBeInTheDocument();
    expect(screen.getByText("n")).toBeInTheDocument(); // column header
    expect(screen.getByText("5")).toBeInTheDocument(); // cell value
    expect(screen.getByText(/假设：把 id 当作主键/)).toBeInTheDocument();
  });

  it("paginates forward and discloses a total larger than the page", async () => {
    // ADR-0024/0030: a bounded page is shown with the honest total, so a
    // truncated view never looks complete; the next-page button fetches onward.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"], ["2"]],
      total: 5,
      offset: 0,
      limit: 2,
    });
    render(<ResultView referenceName="result_1" assumption={null} pageSize={2} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("result_1", 0, 2));
    expect(screen.getByText(/共 5 行/)).toBeInTheDocument(); // total disclosed
    fireEvent.click(screen.getByRole("button", { name: /下一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("result_1", 2, 2));
  });

  it("renders the empty-state row and a zero total for a 0-row result", async () => {
    // ADR-0030: a 0-row result is a valid materialized result, shown with the
    // honest total (0) and the empty-state row -- never special-cased away.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [],
      total: 0,
      offset: 0,
      limit: 100,
    });
    render(<ResultView referenceName="result_1" assumption={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("result_1", 0, 100));
    expect(screen.getByText(/行数：0/)).toBeInTheDocument();
    expect(screen.getByText(/（无数据行）/)).toBeInTheDocument();
  });

  it("paginates backward via the previous button", async () => {
    vi.mocked(readRows)
      .mockResolvedValueOnce({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["1"], ["2"]],
        total: 5,
        offset: 0,
        limit: 2,
      })
      .mockResolvedValueOnce({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["3"], ["4"]],
        total: 5,
        offset: 2,
        limit: 2,
      })
      .mockResolvedValueOnce({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["1"], ["2"]],
        total: 5,
        offset: 0,
        limit: 2,
      });
    render(<ResultView referenceName="result_1" assumption={null} pageSize={2} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("result_1", 0, 2));
    fireEvent.click(screen.getByRole("button", { name: /下一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("result_1", 2, 2));
    fireEvent.click(screen.getByRole("button", { name: /上一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("result_1", 0, 2));
  });
});

describe("Thread", () => {
  // A materialized record built from the shared mock descriptor (reference_name
  // overridden) -- the only outcome that needs a full dataset payload.
  function materializedRecord(referenceName: string, assumption: string | null): TurnRecord {
    return {
      question: `问 ${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: { dataset: { ...mockDataset, reference_name: referenceName }, assumption },
      },
    };
  }

  it("renders every turn labeled by its verbatim question with its outcome kind", () => {
    // ADR-0028: all four outcomes are always visible, in order, each labeled by
    // the user's own question (ADR-0039). The assumption side note renders for
    // the outcomes that carry one (ADR-0009/0018).
    const records: TurnRecord[] = [
      materializedRecord("result_1", "把 id 当主键"),
      {
        question: "哪个名字",
        outcome: {
          kind: "Textual",
          data: { text_kind: "Clarify", body: "按产品名还是客户名？", assumption: null },
        },
      },
      {
        question: "预测销量",
        outcome: {
          kind: "Textual",
          data: { text_kind: "Refuse", body: "预测不在 v1 能力范围内", assumption: null },
        },
      },
      {
        question: "坏查询",
        outcome: { kind: "Failed", data: { reason: "执行查询失败：bad column" } },
      },
      { question: "中途取消", outcome: { kind: "Cancelled" } },
    ];
    render(
      <Thread records={records} selectedResult="result_1" onSelectResult={() => {}} />,
    );

    // Every verbatim question is a visible label.
    expect(screen.getByText("问 result_1")).toBeInTheDocument();
    expect(screen.getByText("哪个名字")).toBeInTheDocument();
    expect(screen.getByText("预测销量")).toBeInTheDocument();
    expect(screen.getByText("坏查询")).toBeInTheDocument();
    expect(screen.getByText("中途取消")).toBeInTheDocument();

    // Result turn: a result link + the assumption side note.
    expect(screen.getByRole("button", { name: /结果：result_1/ })).toBeInTheDocument();
    expect(screen.getByText(/假设：把 id 当主键/)).toBeInTheDocument();
    // Clarify and refuse render distinctly with their kind + body.
    expect(screen.getByText("需要澄清")).toBeInTheDocument();
    expect(screen.getByText("按产品名还是客户名？")).toBeInTheDocument();
    expect(screen.getByText("无法处理")).toBeInTheDocument();
    expect(screen.getByText("预测不在 v1 能力范围内")).toBeInTheDocument();
    // Failed renders the honest reason; cancelled renders the marker.
    expect(screen.getByText(/失败：执行查询失败：bad column/)).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
  });

  it("clicking a result turn selects it with its assumption preserved", () => {
    const onSelectResult = vi.fn();
    render(
      <Thread
        records={[materializedRecord("result_2", "用了简单计数")]}
        selectedResult={null}
        onSelectResult={onSelectResult}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /结果：result_2/ }));
    expect(onSelectResult).toHaveBeenCalledWith("result_2", "用了简单计数");
  });

  it("marks the selected result turn active", () => {
    render(
      <Thread
        records={[materializedRecord("result_1", null)]}
        selectedResult="result_1"
        onSelectResult={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /结果：result_1/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("renders nothing when the thread is empty", () => {
    const { container } = render(
      <Thread records={[]} selectedResult={null} onSelectResult={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
