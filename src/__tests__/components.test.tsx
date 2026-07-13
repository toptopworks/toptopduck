import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { catalogFor } from "../i18n";
import { ActiveSourceDeleteDialog } from "../components/ActiveSourceDeleteDialog";
import { DatasetDetail } from "../components/DatasetDetail";
import { DisclosureBanner } from "../components/DisclosureBanner";
import { GuidedLoadDialog } from "../components/GuidedLoadDialog";
import { PrivacyControls } from "../components/PrivacyControls";
import { QuestionBar } from "../components/QuestionBar";
import { ResultView } from "../components/ResultView";
import { Thread } from "../components/Thread";
import { TooltipProvider } from "../components/ui/tooltip";
import { VegaChart } from "../components/VegaChart";
import { WorkingSetList } from "../components/WorkingSetList";
import { readRows } from "../api";
import embed, { type VisualizationSpec } from "vega-embed";
import type {
  DatasetDescriptor,
  DatasetPrivacy,
  GuidanceRequest,
  ThreadEntry,
  TurnRecord,
} from "../types";

// WorkingSetList's replace action opens the Tauri file dialog; stub it so the
// tests can drive the picker without the native bridge.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, readRows: vi.fn() };
});
// Vega-Embed needs a real canvas; jsdom has none, so the render itself is
// mocked. ResultView still drives the real decodeViz + the embed call/catch
// branches -- the mock lets each test script a successful embed or a rejected
// one to exercise the degradation path (ADR-0033).
vi.mock("vega-embed", () => ({ default: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";

// Thread chrome routes through react-intl (ADR-0052). Renders the element inside
// a zh-CN IntlProvider so the Chinese chrome assertions hold. Other component
// tests keep the bare render (their chrome is still hardcoded). Wraps in
// TooltipProvider too: the rail card truncation sites use Radix Tooltip
// (ADR-0050/0054, issue #106), which needs the context App normally provides.
function renderThread(ui: ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      <TooltipProvider>{ui}</TooltipProvider>
    </IntlProvider>,
  );
}

// QuestionBar reaches react-intl for the ADR-0059 phase strings (ADR-0052), so
// its tests render inside a zh-CN IntlProvider like the Thread tests above. The
// bar's placeholder / aria-label / button labels are still hard-coded zh (a
// pre-existing follow-up); only the phase strings read the catalog, and these
// tests do not exercise them, but the provider must still wrap the component
// because useIntl() runs unconditionally at the top of QuestionBar.
function renderQuestionBar(ui: ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      {ui}
    </IntlProvider>,
  );
}

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

describe("QuestionBar (issue #28 single in-flight + cancel)", () => {
  it("submits the trimmed question and disables submit on empty", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "  几行  " } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    expect(onSubmit).toHaveBeenCalledWith("几行");
    // The submit button is the sole action when idle (no 停止 button rendered).
    expect(screen.queryByRole("button", { name: "停止" })).not.toBeInTheDocument();
  });

  it("disables the input and shows 停止 instead of 提问 while loading (ADR-0021)", () => {
    // Single in-flight: while a turn runs the input is disabled and the only
    // action is cancel -- the user cannot start a second concurrent turn.
    const onCancel = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={() => {}} onCancel={onCancel} loading={true} />);
    expect(screen.getByLabelText("提问")).toBeDisabled();
    // Submit is replaced by the stop button; clicking it fires cancel.
    expect(screen.queryByRole("button", { name: "提问" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("does not submit when the value is blank", () => {
    const onSubmit = vi.fn();
    renderQuestionBar(<QuestionBar onSubmit={onSubmit} onCancel={() => {}} loading={false} />);
    // The submit button is disabled for a blank question, so a form submit (e.g.
    // via Enter on an empty input) cannot fire a turn.
    expect(screen.getByRole("button", { name: "提问" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("textbox", { name: "提问" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

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

  it("deletes a dataset after a confirm, forwarding the stable reference name (issue #38)", () => {
    // The per-row delete button confirms, then forwards the reference name --
    // the identity the backend removes (not the display label).
    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("people"));
    expect(onDelete).toHaveBeenCalledWith("people");
  });

  it("ignores a cancelled delete confirm (issue #38)", () => {
    // A no at the confirm gate never reaches the backend -- no IPC, no removal.
    const onDelete = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("disables the delete button while loading (execution window, ADR-0040)", () => {
    // loading is true while any async op (incl. an in-flight turn) runs -- the
    // execution window disables source management so a mid-turn delete cannot
    // interleave with the query.
    render(
      <WorkingSetList
        datasets={[mockDataset]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        loading={true}
      />,
    );
    expect(screen.getByRole("button", { name: /删除/ })).toBeDisabled();
  });

  it("renders a stale badge whose verb follows the anchor reason (issue #41 AC4)", () => {
    // AC4: a stale result row carries a badge naming the invalidating source,
    // with "已删除" for a Deleted anchor and "已更新" for a Replaced anchor
    // (single-sourced via staleBadgeText, shared with the Thread badge).
    const stale: DatasetDescriptor = {
      ...mockDataset,
      reference_name: "result_1",
      display_name: "count",
      stale: {
        reference_name: "people",
        display_name: "员工表",
        reason: "Deleted" as const,
      },
    };
    render(
      <WorkingSetList
        datasets={[stale]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    expect(screen.getByText(/因「员工表」已删除而失效/)).toBeInTheDocument();
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
    render(<ResultView sessionId="sess-1" referenceName="result_1" assumption="把 id 当作主键" viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 100));
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
    render(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} pageSize={2} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 2));
    expect(screen.getByText(/共 5 行/)).toBeInTheDocument(); // total disclosed
    fireEvent.click(screen.getByRole("button", { name: /下一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 2, 2));
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
    render(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 100));
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
    render(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} pageSize={2} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 2));
    fireEvent.click(screen.getByRole("button", { name: /下一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 2, 2));
    fireEvent.click(screen.getByRole("button", { name: /上一页/ }));
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 2));
  });

  it("discards a late-arriving stale page when the result changes (seq race guard)", async () => {
    // ResultView's seqRef: switching results starts a new loadPage(0) that
    // supersedes the prior result's in-flight readRows. The stale response (for
    // the old reference name) must be discarded -- its seq is no longer current.
    // Without the guard, switching results then having the old page land late
    // would yank the workspace back to the stale rows.
    let resolveResult1: (page: Awaited<ReturnType<typeof readRows>>) => void = () => {};
    vi.mocked(readRows).mockImplementation((_sid, ref) => {
      if (ref === "result_1") {
        return new Promise((resolve) => {
          resolveResult1 = resolve;
        });
      }
      return Promise.resolve({
        columns: [{ name: "id", canonical_type: "BIGINT" }],
        rows: [["99"]],
        total: 1,
        offset: 0,
        limit: 100,
      });
    });
    const { rerender } = render(
      <ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />,
    );
    // result_1's page-0 is still pending; switch to result_2 (resolves fast).
    rerender(
      <ResultView sessionId="sess-1" referenceName="result_2" assumption={null} viz={null} />,
    );
    await waitFor(() => expect(screen.getByText("99")).toBeInTheDocument());
    // Now result_1's stale page-0 lands -- it must be discarded, not rendered.
    resolveResult1({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["11"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    // Flush microtasks; result_2's "99" stays, result_1's "11" never shows.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("99")).toBeInTheDocument();
    expect(screen.queryByText("11")).not.toBeInTheDocument();
  });
});

describe("ResultView viz (ADR-0016/0033, issue #26)", () => {
  // A minimal successful Vega-Embed Result -- ResultView only touches finalize.
  const embedOk = () =>
    ({ finalize: vi.fn() }) as unknown as Awaited<ReturnType<typeof embed>>;
  const page = {
    columns: [{ name: "n", canonical_type: "BIGINT" }],
    rows: [["5"]],
    total: 1,
    offset: 0,
    limit: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readRows).mockResolvedValue(page);
  });

  it("renders the chart above the table on success (ADR-0062 R4 layout)", async () => {
    // AC1 + ADR-0062 R4: a provider viz renders AND the table stays visible
    // below it (chart = answer, table = evidence); no degradation disclosure.
    vi.mocked(embed).mockResolvedValue(embedOk());
    const { container } = render(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "bar" }) }}
      />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".viz-chart")).toBeInTheDocument();
    // The table pagination is present below the chart (table is always shown).
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
  });

  it("degrades to the table with a disclosure when the spec is malformed JSON", async () => {
    // AC2/AC6: a malformed viz degrades to the table + an honest disclosure
    // (ADR-0033 -- silent degradation is a silent lie). Vega-Embed is never
    // called: decodeViz rejects before rendering.
    const { container } = render(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: "not-valid-json" }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(embed).not.toHaveBeenCalled();
    expect(screen.getByText(/图表无法渲染，已显示表格/)).toBeInTheDocument();
    expect(container.querySelector(".viz-chart")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
  });

  it("degrades to the table with a disclosure for a non-whitelisted mark", async () => {
    // AC2/AC6: a spec that draws a chart v1 does not ship (a heatmap "rect")
    // degrades. Whitelist = bar/line/area/scatter/pie only.
    render(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "rect" }) }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(embed).not.toHaveBeenCalled();
    expect(screen.getByText(/图表无法渲染，已显示表格/)).toBeInTheDocument();
    expect(screen.getByText(/rect/)).toBeInTheDocument();
  });

  it("degrades to the underlying table when Vega-Embed render fails", async () => {
    // AC5: a spec that decodes but fails to render degrades to the table with a
    // disclosure -- the underlying data is always shown, never lost.
    vi.mocked(embed).mockRejectedValue(new Error("vega render boom"));
    render(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "bar" }) }}
      />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByText(/图表无法渲染，已显示表格/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
  });

  it("renders a plain table with no disclosure when viz is null", async () => {
    // ADR-0033: a null viz is the default table turn -- NOT a degradation, so no
    // disclosure shows and Vega-Embed is never called.
    render(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(embed).not.toHaveBeenCalled();
    expect(screen.queryByText(/图表无法渲染/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下一页/ })).toBeInTheDocument();
  });

  it("finalizes the Vega view on unmount to free the chart resource", async () => {
    // The render effect's cleanup calls finalize so an unmounted chart frees its
    // Vega view (no canvas/view leak across result switches). ResultView is keyed
    // by reference name in App.tsx, so every result switch remounts and runs
    // this cleanup path -- leaving it unguarded would leak views silently.
    const finalize = vi.fn();
    vi.mocked(embed).mockResolvedValue(
      { finalize } as unknown as Awaited<ReturnType<typeof embed>>,
    );
    const { unmount } = render(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: JSON.stringify({ mark: "bar" }) }}
      />,
    );
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    unmount();
    // finalize fires either synchronously in cleanup (if embed already resolved)
    // or on the resolved promise (if unmount raced it); waitFor covers both.
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
  });
});

describe("VegaChart (ADR-0016/0033/0050)", () => {
  // VegaChart owns the embed lifecycle: it renders one decoded spec, finalizes
  // the prior view on re-embed/unmount (no canvas leak, ADR-0033), and forwards
  // a render failure via onError so ResultView can degrade honestly. The
  // ResultView viz tests above drive the same mock through ResultView; these
  // cover VegaChart's own viewRef cleanup + onError path directly.
  const barSpec = { mark: "bar" } as unknown as VisualizationSpec;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("embeds the spec and finalizes the view on unmount", async () => {
    const finalize = vi.fn();
    vi.mocked(embed).mockResolvedValue({ finalize } as unknown as Awaited<ReturnType<typeof embed>>);
    const { unmount } = render(<VegaChart spec={barSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    unmount();
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
  });

  it("forwards a render failure via onError so the caller degrades", async () => {
    vi.mocked(embed).mockRejectedValue(new Error("vega boom"));
    const onError = vi.fn();
    render(<VegaChart spec={barSpec} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("渲染出错"));
  });

  it("finalizes the prior view when the spec changes (no leak across results)", async () => {
    const finalizeA = vi.fn();
    vi.mocked(embed).mockResolvedValue(
      { finalize: finalizeA } as unknown as Awaited<ReturnType<typeof embed>>,
    );
    const { rerender } = render(<VegaChart spec={barSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // A new spec identity re-runs the embed effect; the prior view is finalized
    // (cancelled branch if A is still pending, or overwrite-finalize if resolved).
    const lineSpec = { mark: "line" } as unknown as VisualizationSpec;
    rerender(<VegaChart spec={lineSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(finalizeA).toHaveBeenCalled());
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
        data: {
          dataset: { ...mockDataset, reference_name: referenceName },
          viz: null,
          assumption,
        },
      },
    };
  }

  // Wrap a TurnRecord as a ThreadEntry::Turn -- the shape conversation() now
  // returns (ADR-0040). Keeps the turn-focused tests readable.
  function turnEntry(record: TurnRecord): ThreadEntry {
    return { entry: "Turn", data: record };
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
    renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult="result_1"
        onSelectResult={() => {}}
      />,
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

  it("clicking a result turn selects it (reference name only, ADR-0051)", () => {
    const onSelectResult = vi.fn();
    renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_2", "用了简单计数"))]}
        selectedResult={null}
        onSelectResult={onSelectResult}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /结果：result_2/ }));
    // onSelectResult carries only referenceName -- assumption/viz are derived
    // from the thread by the caller (ADR-0051), not passed through the callback.
    expect(onSelectResult).toHaveBeenCalledWith("result_2");
  });

  it("marks the selected result turn active", () => {
    renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_1", null))]}
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
    const { container } = renderThread(
      <Thread entries={[]} selectedResult={null} onSelectResult={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders source lifecycle events as non-interactive markers interleaved with turns (ADR-0040)", () => {
    // A source event is first-class in the thread (always visible, occupies a
    // slot) but NOT a turn -- it shows no question/outcome, renders distinctly,
    // and is not clickable. Interleaving order is preserved.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "people" } },
      turnEntry(materializedRecord("result_1", null)),
      {
        entry: "Source",
        data: { kind: "Deleted", reference_name: "people", display_name: "people" },
      },
    ];
    renderThread(
      <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
    );
    // Added + Deleted markers render with their verbs, distinct from turns.
    expect(screen.getByText(/加载了「people」/)).toBeInTheDocument();
    expect(screen.getByText(/删除了「people」/)).toBeInTheDocument();
    // The turn's question still renders between them (ordering preserved).
    expect(screen.getByText("问 result_1")).toBeInTheDocument();
    // Source markers carry no clickable result link (only the turn does).
    expect(screen.getAllByRole("button").length).toBe(1);
  });

  it("renders a Replaced source event with its own marker verb (issue #41)", () => {
    // ADR-0025 / issue #41: a re-upload under an existing reference name lands a
    // Replaced event, distinct from Added (new name) and Deleted (name gone) --
    // its marker verb is "换源了", carrying the PRD term (CONTEXT.md).
    const entries: ThreadEntry[] = [
      {
        entry: "Source",
        data: { kind: "Replaced", reference_name: "people", display_name: "员工表" },
      },
    ];
    renderThread(<Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />);
    expect(screen.getByText(/换源了「员工表」/)).toBeInTheDocument();
  });

  it("ghosts a stale Materialized turn with CircleOff + a causal chip (issue #80, ADR-0041/0047)", () => {
    // A result that went stale renders as a ghost: reduced opacity (CSS on
    // .stale-ghost) + the outcome icon swapped to CircleOff, and a clickable
    // causal chip replaces the old full-sentence badge. The chip's wording
    // splits honestly by reason -- "源已更新" (Replaced: SQL still runs, v1 just
    // does not recompute) vs "上游已删除" (Deleted: the reference name is gone).
    const entries: ThreadEntry[] = [turnEntry(materializedRecord("result_1", null))];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // Ghost marker: the turn card carries data-stale + the stale-ghost class.
    const turnCard = container.querySelector(".turn-card");
    expect(turnCard?.classList.contains("stale-ghost")).toBe(true);
    expect(turnCard?.getAttribute("data-stale")).toBe("true");
    // CircleOff is the stale glyph (aria-label "结果已失效"), not the fresh
    // Materialized's Table2 ("已出结果").
    expect(screen.getByRole("img", { name: "结果已失效" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "已出结果" })).not.toBeInTheDocument();
    // Causal chip wording for a Replaced source.
    expect(screen.getByRole("button", { name: /源已更新/ })).toBeInTheDocument();
  });

  it("the stale causal chip wording distinguishes delete vs replace (issue #80, ADR-0041)", () => {
    // ADR-0041 honest split: a Deleted upstream -> "上游已删除" (truly gone,
    // cannot recompute); a Replaced source -> "源已更新" (new backing exists,
    // re-ask would recover). The wording signals recoverability.
    const replacedAnchor = { reference_name: "people", display_name: "员工表", reason: "Replaced" as const };
    const deletedAnchor = { reference_name: "people", display_name: "员工表", reason: "Deleted" as const };

    const { unmount: unmountReplaced } = renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_1", null))]}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={new Map([["result_1", replacedAnchor]])}
      />,
    );
    expect(screen.getByRole("button", { name: /源已更新/ })).toBeInTheDocument();
    unmountReplaced();

    renderThread(
      <Thread
        entries={[turnEntry(materializedRecord("result_1", null))]}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={new Map([["result_1", deletedAnchor]])}
      />,
    );
    expect(screen.getByRole("button", { name: /上游已删除/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /源已更新/ })).not.toBeInTheDocument();
  });

  it("clicking a stale causal chip jump-selects the nearest matching source event (issue #80, ADR-0047)", () => {
    // The chip-trace rule (ADR-0047): click a stale chip -> highlight the
    // SourceLifecycleEvent after this result's turn whose reference_name + kind
    // match the anchor. No event_id is stored; the match is derived from the
    // existing thread. Here result_1 (stale via Replaced on "people") jumps to
    // the Replaced source event after it, not the earlier Added.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      turnEntry(materializedRecord("result_1", null)),
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
    ];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // No source marker is highlighted before the click.
    expect(container.querySelector(`.source-entry[data-highlighted="true"]`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /源已更新/ }));
    // The Replaced marker (after result_1) is now the highlighted jump target;
    // the Added (before) and Deleted (orders, not people) are not.
    const highlighted = container.querySelector(`.source-entry[data-highlighted="true"]`);
    expect(highlighted?.getAttribute("data-source-kind")).toBe("replaced");
  });

  it("encodes the four outcomes by data-outcome + accessible icon label (issue #80, ADR-0047/0050)", () => {
    // Black-box AC: assert visible DOM/aria, not pixels. Each outcome kind
    // rides data-outcome on the <li> (the hue attribute hook) AND an aria-label
    // on the outcome icon, so the four are distinguishable without color sight.
    const records: TurnRecord[] = [
      materializedRecord("result_1", null),
      { question: "q", outcome: { kind: "Textual", data: { text_kind: "Clarify", body: "b", assumption: null } } },
      { question: "q", outcome: { kind: "Failed", data: { reason: "boom" } } },
      { question: "q", outcome: { kind: "Cancelled" } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    const kinds = ["materialized", "textual", "failed", "cancelled"];
    const outs = container.querySelectorAll(".turn-entry");
    expect(outs).toHaveLength(4);
    expect(Array.from(outs).map((li) => li.getAttribute("data-outcome"))).toEqual(kinds);
    // Each outcome's glyph is announced via its icon aria-label.
    expect(screen.getByRole("img", { name: "已出结果" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "需要澄清" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "失败" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "已取消" })).toBeInTheDocument();
  });

  it("keeps Failed and Cancelled visible but weakened, never collapsed (issue #80, ADR-0028)", () => {
    // ADR-0028 Why 2: collapsing B/C/D would hide high-value "recent intent
    // included a failure" context. v1 only weakens (CSS opacity on the card),
    // so the question + reason/marker stay in the DOM and are queryable.
    const records: TurnRecord[] = [
      { question: "坏查询", outcome: { kind: "Failed", data: { reason: "bad column" } } },
      { question: "中途取消", outcome: { kind: "Cancelled" } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    // Both are present in the DOM (not collapsed away).
    expect(screen.getByText("坏查询")).toBeInTheDocument();
    expect(screen.getByText(/失败：bad column/)).toBeInTheDocument();
    expect(screen.getByText("中途取消")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
    // Both carry their outcome attribute (weakening is CSS opacity, asserted at
    // the style layer, not duplicated here).
    expect(container.querySelector(`.turn-entry[data-outcome="failed"]`)).not.toBeNull();
    expect(container.querySelector(`.turn-entry[data-outcome="cancelled"]`)).not.toBeNull();
  });

  it("renders source markers as a distinct species with add/replace/delete glyphs + stale counts (issue #80)", () => {
    // The three source lifecycle kinds render as thin markers (data-source-kind)
    // distinct from turns; Replaced/Deleted disclose how many derivatives they
    // invalidated ("失效 N"), derived by matching reference_name + kind against
    // the stale map (no event_id, ADR-0047).
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
    ];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
      ["result_2", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
      ["result_3", { reference_name: "orders", display_name: "订单表", reason: "Deleted" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // Three distinct markers by kind; Added carries no stale count (adding never
    // invalidates), Replaced shows "失效 2" (two people-Replaced stale results),
    // Deleted shows "失效 1".
    const markers = container.querySelectorAll(".source-entry");
    expect(Array.from(markers).map((li) => li.getAttribute("data-source-kind"))).toEqual([
      "added",
      "replaced",
      "deleted",
    ]);
    expect(screen.getByText(/加载了「员工表」/)).toBeInTheDocument();
    expect(screen.getByText(/失效 2/)).toBeInTheDocument();
    expect(screen.getByText(/失效 1/)).toBeInTheDocument();
  });

  it("shows the active chip only when the question explicitly names a dataset (issue #80, ADR-0047)", () => {
    // Most turns act implicitly on the prior step -> no chip; a question that
    // names a working-set dataset ("在订单表上...") lights up ->订单表. Matching
    // is on the display label first, then the reference name; stale datasets
    // are excluded (they cannot be the target of a new question).
    const labels = [
      { reference_name: "people", display_name: "员工表" },
      { reference_name: "orders", display_name: "订单表" },
    ];
    const records: TurnRecord[] = [
      { question: "在订单表上统计总销售额", outcome: { kind: "Cancelled" } },
      { question: "总共几行", outcome: { kind: "Cancelled" } },
    ];
    const { container } = renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult={null}
        onSelectResult={() => {}}
        datasetLabels={labels}
      />,
    );
    // The naming turn gets a chip; the implicit one does not.
    expect(screen.getByText(/→订单表/)).toBeInTheDocument();
    expect(container.querySelectorAll(".turn-active-chip")).toHaveLength(1);
  });

  it("falls back to the reference name when the display name is absent from the question (issue #80)", () => {
    // findMentionedDataset tries the display label first, then the technical
    // reference name, so a user who knows the id ("在 people 上") still lights
    // up the chip. The chip label always uses the display name (what most users
    // recognize), never the matched token.
    const labels = [{ reference_name: "people", display_name: "员工表" }];
    const records: TurnRecord[] = [
      { question: "在 people 上统计总销售额", outcome: { kind: "Cancelled" } },
    ];
    renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult={null}
        onSelectResult={() => {}}
        datasetLabels={labels}
      />,
    );
    // Matched via reference name; chip label is still the display name.
    expect(screen.getByText(/→员工表/)).toBeInTheDocument();
  });

  it("attributes the active chip to the dataset whose name the question contains (issue #80)", () => {
    // ADR-0047 signal-vs-noise: lock the first-display-name-hit-wins rule so a
    // future refactor (flipping display/reference order, reordering labels)
    // cannot silently mis-attribute the chip to the wrong dataset.
    const labels = [
      { reference_name: "people", display_name: "员工表" },
      { reference_name: "orders", display_name: "订单表" },
    ];
    const records: TurnRecord[] = [
      { question: "在订单表上统计", outcome: { kind: "Cancelled" } },
    ];
    renderThread(
      <Thread
        entries={records.map(turnEntry)}
        selectedResult={null}
        onSelectResult={() => {}}
        datasetLabels={labels}
      />,
    );
    expect(screen.getByText(/→订单表/)).toBeInTheDocument();
    expect(screen.queryByText(/→员工表/)).not.toBeInTheDocument();
  });

  it("disables the stale causal chip when no matching source event follows the turn (issue #80, ADR-0047)", () => {
    // ADR-0047 honest control: the causal chip is clickable only when a matching
    // SourceLifecycleEvent actually follows this turn. When the stale map and the
    // thread disagree (resume / the invalidating event was filtered out), the
    // chip renders disabled with an explanatory title rather than silently
    // no-op'ing a click. The verb still names the stale reason -- only the jump
    // is withheld.
    const entries: ThreadEntry[] = [turnEntry(materializedRecord("result_1", null))];
    const staleByReference = new Map([
      ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
    ]);
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={staleByReference}
      />,
    );
    // The chip is present with its verb but disabled (no jump target after turn).
    const chip = screen.getByRole("button", { name: /源已更新/ });
    expect((chip as HTMLButtonElement).disabled).toBe(true);
    // No source marker is highlighted.
    expect(container.querySelector(`.source-entry[data-highlighted="true"]`)).toBeNull();
  });
});

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
    render(
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
    render(
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
    render(
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

  it("Escape does not close the dialog (AlertDialog semantics, issue #105)", () => {
    // Migrated to Radix AlertDialog: destructive-confirm semantics intentionally
    // block ESC + overlay dismiss -- the user must take an explicit 中止 / 继续
    // action. The hand-written window ESC listener is gone; ESC on the content
    // is inert, so onCancel never fires (mirroring the original "no accidental
    // dismiss" intent of the confirm, now enforced by the primitive).
    const onCancel = vi.fn();
    render(
      <ActiveSourceDeleteDialog
        target={target}
        candidates={candidates}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
