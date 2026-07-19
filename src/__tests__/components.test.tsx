import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";
import { catalogFor } from "../i18n";
import { ActiveSourceDeleteDialog } from "../components/ActiveSourceDeleteDialog";
import { DatasetDetail } from "../components/DatasetDetail";
import { DisclosureBanner } from "../components/DisclosureBanner";
import { GuidedLoadDialog } from "../components/GuidedLoadDialog";
import { PrivacyControls } from "../components/PrivacyControls";
import { QuestionBar } from "../components/QuestionBar";
import { COLUMN_DISCLOSURE_THRESHOLD, ResultView, ROW_DISCLOSURE_THRESHOLD } from "../components/ResultView";
import { SettingsView } from "../components/settingsView/SettingsView";
import { Thread } from "../components/Thread";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { TooltipProvider } from "../components/ui/tooltip";
import { VegaChart } from "../components/VegaChart";
import { WorkingSetList } from "../components/WorkingSetList";
import { clearProfileKey, listProviderProfiles, readRows, setProfileKey } from "../api";
import embed, { type VisualizationSpec } from "vega-embed";
import type {
  AppConfig,
  DatasetDescriptor,
  DatasetPrivacy,
  GuidanceRequest,
  StaleReason,
  ThreadEntry,
  TurnRecord,
} from "../types";

// WorkingSetList's replace action opens the Tauri file dialog; stub it so the
// tests can drive the picker without the native bridge.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  // readRows: ResultView pagination. listProviderProfiles/setProfileKey/
  // clearProfileKey: SettingsView's Profiles pane keychain surface (issue #153,
  // mocked so the pane never reaches Tauri).
  return {
    ...actual,
    readRows: vi.fn(),
    listProviderProfiles: vi.fn(),
    setProfileKey: vi.fn(),
    clearProfileKey: vi.fn(),
  };
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

// QuestionBar routes all of its chrome (placeholder / aria-label / button
// labels / phase feedback) through react-intl (ADR-0052), so its tests render
// inside a zh-CN IntlProvider like the Thread tests above. useIntl() runs
// unconditionally at the top of QuestionBar, so the provider must wrap it.
function renderQuestionBar(ui: ReactElement) {
  return render(
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      {ui}
    </IntlProvider>,
  );
}

// DisclosureBanner + ResultView + WorkingSetList + ActiveSourceDeleteDialog route
// their chrome through react-intl (ADR-0052, issue #108/#137). withIntl wraps a
// node for a rerender call (RTL's rerender replaces the whole tree, so it must
// re-provide the provider); renderI18n is the render-time convenience. zh-CN
// keeps the Chinese chrome assertions holding, mirroring renderThread/renderQuestionBar.
function withIntl(ui: ReactElement) {
  return (
    <IntlProvider locale="zh-CN" messages={catalogFor("zh-CN")}>
      {ui}
    </IntlProvider>
  );
}
function renderI18n(ui: ReactElement) {
  return render(withIntl(ui));
}

// SettingsDialog routes its chrome through react-intl (ADR-0052). Rendered inside
// an empty-catalog English IntlProvider so FormattedMessage / useIntl fall back to
// the defaultMessage -- the canonical English source (ADR-0052) -- and assertions
// anchor on stable English strings without coupling to the zh-CN catalog.
// onError silences the expected missing-message warnings (the ids intentionally
// resolve via defaultMessage, not the empty catalog).
function renderSettings(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
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
    renderI18n(<DisclosureBanner />);
    expect(screen.getByText(/完整数据集永不离开本机/)).toBeInTheDocument();
    expect(screen.getByText(/首 3 行样本/)).toBeInTheDocument();
  });

  it("discloses Excel formula cells use cached snapshot values (issue #7 AC4)", () => {
    const { container } = renderI18n(<DisclosureBanner />);
    expect(container).toHaveTextContent(/Excel 工作簿按 sheet 分别加载为独立/);
    expect(container).toHaveTextContent(/隐藏的工作表会被跳过/);
    expect(container).toHaveTextContent(/公式单元格取加载时的缓存值（不重算）/);
    // issue #10: disclose auto-tidy + guided fallback + .xls rejection.
    expect(container).toHaveTextContent(/自动规整/);
    expect(container).toHaveTextContent(/请另存为 .xlsx/);
  });

  it("discloses the per-dataset / per-column privacy control surface (issue #9)", () => {
    const { container } = renderI18n(<DisclosureBanner />);
    expect(container).toHaveTextContent(/按数据集关闭样本发送/);
    expect(container).toHaveTextContent(/按列标记「仅类型」/);
  });

  it("renders as a static note Alert (ADR-0050, issue #108)", () => {
    // The privacy disclosure migrated from a bespoke <aside role="note"> to a
    // shadcn Alert (default variant). role="note" overrides the Alert's
    // assertive "alert" default -- this is static reference info shown inside a
    // collapsible <details>, not an announcement. getByRole asserts the a11y
    // semantics (not a DOM-structure query), mirroring the viz-degradation test.
    renderI18n(<DisclosureBanner />);
    const alert = screen.getByRole("note");
    expect(alert.getAttribute("data-slot")).toBe("alert");
  });

  it("resolves the <bold> rich-text tag to <strong> emphasis (ADR-0052, issue #108)", () => {
    // Each privacy message carries <bold>...</bold> tags resolved via the
    // values.bold renderer to <strong>. A regression that drops the renderer
    // would leak the raw tag name or flatten the emphasis; getByText alone can't
    // tell (it flattens text), so pin the <strong> count directly.
    const { container } = renderI18n(<DisclosureBanner />);
    expect(container.querySelectorAll("strong").length).toBeGreaterThan(0);
  });
});

describe("DatasetDetail", () => {
  it("renders canonical column types and the frozen sample", () => {
    renderI18n(<DatasetDetail dataset={mockDataset} />);
    expect(screen.getByText("BIGINT")).toBeInTheDocument();
    expect(screen.getByText("VARCHAR")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    // Privacy controls are absent when onPrivacyChange is not supplied.
    expect(screen.queryByText(/隐私控制/)).toBeNull();
  });

  it("shows a no-rows hint when the sample is empty", () => {
    renderI18n(<DatasetDetail dataset={{ ...mockDataset, sample: [], row_count: 0 }} />);
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
    renderI18n(<DatasetDetail dataset={nested} />);
    expect(screen.getByText("STRUCT(city VARCHAR, zip VARCHAR)")).toBeInTheDocument();
    expect(screen.getByText("LIST(VARCHAR)")).toBeInTheDocument();
  });

  it("renders privacy controls + disclosure when onPrivacyChange is supplied (issue #9)", () => {
    renderI18n(<DatasetDetail dataset={mockDataset} onPrivacyChange={() => {}} />);
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
      <PrivacyControls dataset={dataset} loading={false} onPrivacyChange={() => {}} />,
    );
    expect(screen.getByText(/0 列发送/)).toBeInTheDocument();
    expect(screen.getByText(/2 列仅类型/)).toBeInTheDocument();
  });

  it("disables the toggles while loading (prevents concurrent IPC)", () => {
    renderI18n(
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
    renderI18n(
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
    renderI18n(
      <WorkingSetList datasets={[]} activeName={null} onSelect={() => {}} onRename={() => {}} />,
    );
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
  });

  it("renames a dataset's display label via prompt (ADR-0037, issue #8)", () => {
    const onRename = vi.fn();
    vi.spyOn(window, "prompt").mockReturnValue("员工表");
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    // (wording sourced from the workingSet.staleRow ICU select message; Thread's
    // chip uses its own i18n staleChipVerb, so the two surfaces do not share
    // wording -- issue #107 retired staleBadge.ts when the badge became a Badge).
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
    renderI18n(
      <WorkingSetList
        datasets={[stale]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    expect(screen.getByText(/因「员工表」已删除而失效/)).toBeInTheDocument();
  });

  it("renders the row-count plural 'one' branch via the en defaultMessage (ADR-0052)", () => {
    // The zh-CN catalog collapses workingSet.rowCount to "{count} 行", so the
    // en {count, plural, ...} branches are reachable only via defaultMessage.
    // An empty English provider (the renderSettings pattern) routes FormattedMessage
    // to the canonical defaultMessage so the plural stays covered. The negative
    // assertion guards against a one/other swap or a stray "rows" in the one arm.
    render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <WorkingSetList
          datasets={[{ ...mockDataset, row_count: 1 }]}
          activeName={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: /1 row/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1 rows/ })).not.toBeInTheDocument();
  });

  it("renders the row-count plural 'other' branch via the en defaultMessage (ADR-0052)", () => {
    render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <WorkingSetList
          datasets={[{ ...mockDataset, row_count: 5 }]}
          activeName={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: /5 rows/ })).toBeInTheDocument();
  });

  it("renders the stale badge verb for a Replaced anchor (issue #41 AC4)", () => {
    // Pins the Replaced arm of the workingSet.staleRow ICU select (the Deleted
    // arm is covered above) so a regression that drops the arm renders empty;
    // mirrors the ResultView stale-verb coverage in the Thread suite.
    const stale: DatasetDescriptor = {
      ...mockDataset,
      reference_name: "result_1",
      display_name: "count",
      stale: {
        reference_name: "people",
        display_name: "员工表",
        reason: "Replaced" as const,
      },
    };
    renderI18n(
      <WorkingSetList
        datasets={[stale]}
        activeName={null}
        onSelect={() => {}}
        onRename={() => {}}
      />,
    );
    expect(screen.getByText(/因「员工表」已更新而失效/)).toBeInTheDocument();
  });

  it("exhausts every StaleReason variant in the workingSet.staleRow select (ADR-0041)", () => {
    // Compile-time guard: the workingSet.staleRow ICU {reason, select} must name
    // every StaleReason variant as an arm. Adding a variant without extending
    // this map fails tsc (mirrors Thread.tsx staleChipVerb's never-guard), so the
    // select's `other` arm stays unreachable instead of silently masking a new case.
    const arms: Record<StaleReason, true> = {
      Deleted: true,
      Replaced: true,
    };
    expect(Object.keys(arms).sort()).toEqual(["Deleted", "Replaced"]);
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption="把 id 当作主键" viz={null} />);
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
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} pageSize={2} />);
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
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalledWith("sess-1", "result_1", 0, 100));
    expect(screen.getByText(/行数：0/)).toBeInTheDocument();
    expect(screen.getByText(/（无数据行）/)).toBeInTheDocument();
  });

  it("renders a NULL cell as muted whitespace, never the literal \"NULL\" (ADR-0057)", async () => {
    // ADR-0057: the server CASTs NULL to "" so a NULL cell renders as a muted
    // empty cell (td.cell-null), never the literal string "NULL". Pins the NULL
    // branch ResultView touches -- a regression would leak the literal or drop
    // the cell class that drives the muted background.
    vi.mocked(readRows).mockResolvedValue({
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "opt", canonical_type: "VARCHAR" },
      ],
      rows: [["1", ""]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    const { container } = renderI18n(
      <ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    // The empty-string cell carries the cell-null class (muted bg via CSS); the
    // populated cell does not.
    expect(container.querySelectorAll("td.cell-null")).toHaveLength(1);
    // The literal "NULL" never appears in the rendered output.
    expect(screen.queryByText("NULL")).not.toBeInTheDocument();
    // The non-NULL cell value still renders.
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("applies the .num class to a numeric column header + cell (ADR-0057)", async () => {
    // ADR-0057: numeric canonical types right-align. The alignment is a CSS rule
    // (table.result th.num/td.num { text-align: right }) -- not assertable in
    // jsdom (no layout engine), so this pins the className contract at the
    // component boundary: the class survives the Table primitive's cn() merge
    // and lands on the real <th>/<td> the primitive renders.
    vi.mocked(readRows).mockResolvedValue({
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "label", canonical_type: "VARCHAR" },
      ],
      rows: [["7", "x"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    const { container } = renderI18n(
      <ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    // The BIGINT column carries .num on both its header and its cell; the
    // VARCHAR column carries neither.
    expect(container.querySelectorAll("th.num")).toHaveLength(1);
    expect(container.querySelectorAll("td.num")).toHaveLength(1);
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
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} pageSize={2} />);
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
    const { rerender } = renderI18n(
      <ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />,
    );
    // result_1's page-0 is still pending; switch to result_2 (resolves fast).
    rerender(
      withIntl(<ResultView sessionId="sess-1" referenceName="result_2" assumption={null} viz={null} />),
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

  it("renders the large-result disclosure as a note Alert (ADR-0050/0057, issue #108)", async () => {
    // ADR-0057: a result crossing the row threshold discloses honestly (not
    // silent pagination). Migrated to a default info Alert (ADR-0050);
    // role="note" is static reference, not announced. Pins the migration so a
    // regression to the deleted .disclosure-banner class or a wrong variant is
    // caught (columns stay small so many-columns stays off -> one note).
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: ROW_DISCLOSURE_THRESHOLD + 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("note");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/此结果较大.*分页显示中/);
  });

  it("renders the many-column disclosure as a note Alert (ADR-0050/0057, issue #108)", async () => {
    // ADR-0057: columns render in full with horizontal scroll (no cap); this
    // banner tells the user to scroll. Same default info Alert + role="note" as
    // the large-result hint. Columns just over the threshold keep it a single
    // note (large-result stays off: total is 1).
    const manyColumns = Array.from({ length: COLUMN_DISCLOSURE_THRESHOLD + 1 }, (_, i) => ({
      name: `c${i}`,
      canonical_type: "VARCHAR",
    }));
    vi.mocked(readRows).mockResolvedValue({
      columns: manyColumns,
      rows: [manyColumns.map(() => "x")],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("note");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/可横向滚动查看全部/);
  });

  it("renders the stale-result disclosure as a warning status Alert (ADR-0050, issue #108)", async () => {
    // ADR-0047 stage-stale: the result is no longer valid to build on (the
    // invalidating source was replaced). Migrated to a warning Alert;
    // role="status" is polite -- important, not an interrupting emergency. The
    // verb splits via an ICU select on the anchor reason: Replaced -> 已更新.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={null}
        staleAnchor={{ reference_name: "people", display_name: "员工表", reason: "Replaced" as const }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("status");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/员工表/);
    expect(alert).toHaveTextContent(/已更新/);
  });

  it("splits the stale verb by anchor reason: Deleted -> 已删除 (ADR-0041, issue #108)", async () => {
    // The stale disclosure's ICU select has two branches: Replaced -> 已更新
    // (new backing exists, re-ask recovers) and Deleted -> 已删除 (truly gone).
    // The Replaced branch is covered above; this pins the Deleted / other branch
    // so a regression that drops the other arm renders empty, and a future
    // StaleReason kind still falls through honestly.
    vi.mocked(readRows).mockResolvedValue({
      columns: [{ name: "id", canonical_type: "BIGINT" }],
      rows: [["1"]],
      total: 1,
      offset: 0,
      limit: 100,
    });
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={null}
        staleAnchor={{ reference_name: "people", display_name: "员工表", reason: "Deleted" as const }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("status");
    expect(alert).toHaveTextContent(/已删除/);
    expect(alert).not.toHaveTextContent(/已更新/);
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
    const { container } = renderI18n(
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
    const { container } = renderI18n(
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
    renderI18n(
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
    renderI18n(
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
    renderI18n(<ResultView sessionId="sess-1" referenceName="result_1" assumption={null} viz={null} />);
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
    const { unmount } = renderI18n(
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

  it("renders the degradation as a warning status Alert (ADR-0050, issue #108)", async () => {
    // The viz-degradation disclosure migrated to a warning Alert; role="status"
    // is polite -- the table still shows, so it reads as a caution, not an
    // interrupting emergency. Pins the disclosure surfaces move to Alert.
    renderI18n(
      <ResultView
        sessionId="sess-1"
        referenceName="result_1"
        assumption={null}
        viz={{ kind: "bar", spec: "not-valid-json" }}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    const alert = screen.getByRole("status");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/图表无法渲染，已显示表格/);
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
    const { unmount } = renderI18n(<VegaChart spec={barSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    unmount();
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(1));
  });

  it("forwards a render failure as a typed render reason via onError so the caller degrades", async () => {
    // ADR-0033: a Vega-Embed rejection routes to onError so ResultView degrades.
    // The failure is forwarded as a typed { kind: "render" } reason, unified with
    // the decode-failure path (ADR-0052 i18n closeout, issue #138); the full error
    // is log.warn'd for diagnostics (the bare "渲染出错" used to be silently
    // discarded -- silent-failure finding on PR #115, preserved at the log layer).
    vi.mocked(embed).mockRejectedValue(new Error("vega boom"));
    const onError = vi.fn();
    renderI18n(<VegaChart spec={barSpec} onError={onError} />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith({ kind: "render" }));
  });

  it("finalizes the prior view when the spec changes (no leak across results)", async () => {
    const finalizeA = vi.fn();
    vi.mocked(embed).mockResolvedValue(
      { finalize: finalizeA } as unknown as Awaited<ReturnType<typeof embed>>,
    );
    const { rerender } = renderI18n(<VegaChart spec={barSpec} onError={() => {}} />);
    await waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    // A new spec identity re-runs the embed effect; the prior view is finalized
    // (cancelled branch if A is still pending, or overwrite-finalize if resolved).
    const lineSpec = { mark: "line" } as unknown as VisualizationSpec;
    rerender(withIntl(<VegaChart spec={lineSpec} onError={() => {}} />));
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
        outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } },
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
    // Failed renders the typed Execute message via the locale catalog (the
    // engine detail rides the collapsed fold); cancelled renders the marker.
    expect(screen.getByText("执行查询失败")).toBeInTheDocument();
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
      { question: "q", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } } },
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
      { question: "坏查询", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } } },
      { question: "中途取消", outcome: { kind: "Cancelled" } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    // Both are present in the DOM (not collapsed away).
    expect(screen.getByText("坏查询")).toBeInTheDocument();
    expect(screen.getByText("执行查询失败")).toBeInTheDocument();
    expect(screen.getByText("中途取消")).toBeInTheDocument();
    expect(screen.getByText("已取消")).toBeInTheDocument();
    // Both carry their outcome attribute (weakening is CSS opacity, asserted at
    // the style layer, not duplicated here).
    expect(container.querySelector(`.turn-entry[data-outcome="failed"]`)).not.toBeNull();
    expect(container.querySelector(`.turn-entry[data-outcome="cancelled"]`)).not.toBeNull();
  });

  it("renders source markers as a distinct species with add/replace/delete glyphs + stale counts (issue #80)", async () => {
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
    // Hover recovery (ADR-0050, issue #106): a Replaced marker truncated by the
    // fixed source-row width still discloses its name + stale count on hover. The
    // tooltip text carries both the verbatim name and the "失效 N" suffix -- this
    // is the PR's flagship fix (stale count in the source tooltip), so a regression
    // to a name-only tooltip fails here. The native title is gone on every site.
    const replacedSourceText = container.querySelector(
      `.source-entry[data-source-kind="replaced"] .source-text`,
    ) as HTMLElement;
    expect(replacedSourceText.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(replacedSourceText);
    await waitFor(() => {
      const tip = screen.getByRole("tooltip");
      expect(tip.textContent).toContain("员工表");
      expect(tip.textContent).toContain("失效 2");
    });
  });

  it("shows the active chip only when the question explicitly names a dataset (issue #80, ADR-0047)", async () => {
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
    // Hover recovery (ADR-0050, issue #106): the chip's hover Tooltip carries the
    // localized "提问点名「{name}」" label (ADR-0052), so the chip's meaning + full
    // name survive the 8rem max-width truncation. Guards the native title -> Radix
    // Tooltip migration: an orphaned i18n key, a lost {name} interpolation, or a
    // fallback to the native title, fails here.
    const chip = container.querySelector(".turn-active-chip") as HTMLElement;
    expect(chip.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(chip);
    await waitFor(() => {
      expect(screen.getByRole("tooltip").textContent).toBe("提问点名「订单表」");
    });
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

  // --- ADR-0067 (issue #169): visual expression migrated to Tailwind utility
  // + ADR-0050 token on the component; the four-outcome / stale-ghost / source-
  // marker / jump-select SEMANTICS are unchanged. These pin the className
  // contract so a regression that drops a utility silently reverts to the
  // retired styles.css rules. jsdom has no layout engine, so these are
  // className assertions on the real rendered elements (cf. the Table primitive
  // tests above), split(/\s+/) + toContain so `text-primary` does not match
  // `text-primary-foreground` etc.

  it("encodes the four outcomes by text-* tone on the outcome-icon (ADR-0047/0050, issue #169)", () => {
    // The outcome color encoding (ADR-0047 A/B/C/D hues mapped to ADR-0050
    // tokens) now lives on the outcome-icon span as a text-* utility, replacing
    // the [data-outcome] hue hooks retired from styles.css.
    const records: TurnRecord[] = [
      materializedRecord("result_1", null),
      { question: "q", outcome: { kind: "Textual", data: { text_kind: "Clarify", body: "b", assumption: null } } },
      { question: "q", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "boom" } } } },
      { question: "q", outcome: { kind: "Cancelled" } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    const tone = (outcome: string) =>
      container
        .querySelector(`.turn-entry[data-outcome="${outcome}"] .outcome-icon`)
        ?.className.split(/\s+/);
    expect(tone("materialized")).toContain("text-primary");
    // B (textual) MUST stay muted-neutral -- never warm -- so an honest refuse
    // is not misread as failure (ADR-0047 B!=C, ADR-0017).
    expect(tone("textual")).toContain("text-muted-foreground");
    expect(tone("failed")).toContain("text-destructive");
    expect(tone("cancelled")).toContain("text-muted-foreground");
  });

  it("ghosts a stale Materialized turn via opacity-50 + dotted line-through (ADR-0041/0047, issue #169)", () => {
    // The stale-ghost dim + question strike now ride the component as utilities
    // (opacity-50 on the card, line-through decoration-dotted on the question),
    // replacing the .stale-ghost CSS rules in styles.css.
    const entries: ThreadEntry[] = [turnEntry(materializedRecord("result_1", null))];
    const { container } = renderThread(
      <Thread
        entries={entries}
        selectedResult={null}
        onSelectResult={() => {}}
        staleByReference={
          new Map([
            ["result_1", { reference_name: "people", display_name: "员工表", reason: "Replaced" as const }],
          ])
        }
      />,
    );
    const card = container.querySelector(".turn-card");
    expect(card?.className.split(/\s+/)).toContain("opacity-50");
    const question = container.querySelector(".turn-question");
    expect(question?.className.split(/\s+/)).toContain("line-through");
    expect(question?.className.split(/\s+/)).toContain("decoration-dotted");
  });

  it("weakens Failed + Cancelled via opacity-60, never collapsed (ADR-0028 Why 2, issue #169)", () => {
    // ADR-0028 Why 2: recent intent stays visible even when it produced nothing.
    // The opacity-60 weak state now rides the card as a utility.
    const records: TurnRecord[] = [
      { question: "坏查询", outcome: { kind: "Failed", data: { kind: "Execute", data: { detail: "bad column" } } } },
      { question: "中途取消", outcome: { kind: "Cancelled" } },
    ];
    const { container } = renderThread(
      <Thread entries={records.map(turnEntry)} selectedResult={null} onSelectResult={() => {}} />,
    );
    const failedCard = container.querySelector(`.turn-entry[data-outcome="failed"] .turn-card`);
    const cancelledCard = container.querySelector(`.turn-entry[data-outcome="cancelled"] .turn-card`);
    expect(failedCard?.className.split(/\s+/)).toContain("opacity-60");
    expect(cancelledCard?.className.split(/\s+/)).toContain("opacity-60");
  });

  it("encodes the three source lifecycle kinds by border-l-* tone (ADR-0047, issue #169)", () => {
    // The three-way border-left hue (Added=primary / Replaced=accent-foreground /
    // Deleted=destructive) now rides the marker as a literal border-l-* utility,
    // replacing the .source-lifecycle.added/replaced/deleted CSS rules.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
      { entry: "Source", data: { kind: "Deleted", reference_name: "orders", display_name: "订单表" } },
    ];
    const { container } = renderThread(
      <Thread entries={entries} selectedResult={null} onSelectResult={() => {}} />,
    );
    const tone = (kind: string) =>
      container
        .querySelector(`.source-entry[data-source-kind="${kind}"] .source-lifecycle`)
        ?.className.split(/\s+/);
    expect(tone("added")).toContain("border-l-primary");
    expect(tone("replaced")).toContain("border-l-accent-foreground");
    expect(tone("deleted")).toContain("border-l-destructive");
  });

  it("jump-select lifts the matched source marker via bg-accent + ring (ADR-0047 chip-trace, issue #169)", () => {
    // The jump-select highlight now rides the marker as bg-accent + ring-2
    // ring-primary utilities, replacing the [data-highlighted] CSS rule. The
    // wrapping <li> still carries data-highlighted (the caller-derived flag) for
    // selector stability, but the visual lands on the inner .source-lifecycle.
    const entries: ThreadEntry[] = [
      { entry: "Source", data: { kind: "Added", reference_name: "people", display_name: "员工表" } },
      turnEntry(materializedRecord("result_1", null)),
      { entry: "Source", data: { kind: "Replaced", reference_name: "people", display_name: "员工表" } },
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
    fireEvent.click(screen.getByRole("button", { name: /源已更新/ }));
    const highlighted = container.querySelector(`.source-entry[data-highlighted="true"] .source-lifecycle`);
    expect(highlighted?.className.split(/\s+/)).toContain("bg-accent");
    expect(highlighted?.className.split(/\s+/)).toContain("ring-2");
    expect(highlighted?.className.split(/\s+/)).toContain("ring-primary");
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

  it("Escape does not close the dialog (AlertDialog semantics, issue #105)", () => {
    // Migrated to Radix AlertDialog: destructive-confirm semantics intentionally
    // block ESC + overlay dismiss -- the user must take an explicit 中止 / 继续
    // action. The hand-written window ESC listener is gone; ESC on the content
    // is inert, so onCancel never fires (mirroring the original "no accidental
    // dismiss" intent of the confirm, now enforced by the primitive).
    const onCancel = vi.fn();
    renderI18n(
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

describe("SettingsView (issue #151, ADR-0065)", () => {
  // A complete app-config fixture; only theme/locale are exercised, the rest
  // round-trips verbatim (the view commits the whole document atomically).
  const baseConfig: AppConfig = {
    format_version: 2,
    theme: "system",
    locale: "system",
    window: { width: 800, height: 600, x: null, y: null, maximized: false },
    engine: { memory_limit: "512MB", threads: 2, row_cap: 1000, statement_timeout_ms: 30000 },
    privacy: { send_samples: true },
    provider: {
      profiles: [
        {
          id: "default",
          display_name: "Anthropic",
          protocol: "anthropic",
          base_url: "https://api.anthropic.com",
          model: "claude-sonnet",
        },
      ],
      active_profile: "default",
    },
    export: { last_dir: null, default_format: "csv" },
    tunables: { retry_budget: 3, window_turns: 10, far_window: 30 },
    recent_files: [],
    shell: { sidebar_collapsed: false, rail_collapsed: false },
  };
  const profileKeysDefault = [{ profile_id: "default", has_key: false }];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue(profileKeysDefault);
  });

  // Issue #153: the General pane renders synchronously (the global loading gate
  // is gone -- the key-status overlay fetch lives inside ProfilesSection, which
  // only mounts when the user switches to Profiles). Tests that stay on General
  // wait on the Theme legend as a render-ready signal.

  it("commits the chosen theme + locale RadioGroup values on save", async () => {
    // The General pane is the default section; its theme + locale radios wire
    // to local state. A save commits them in one atomic app-config write. The
    // rest of the config round-trips unchanged.
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    await screen.findByText("Theme");
    // Switch theme to dark + locale to English via the RadioGroups.
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(1));
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.theme).toBe("dark");
    expect(committed.locale).toBe("en-US");
    expect(committed.engine).toEqual(baseConfig.engine);
    expect(committed.provider).toEqual(baseConfig.provider);
  });

  it("Save commits app-config and closes (no key IPC from the view, issue #153)", async () => {
    // Issue #153: key set/clear moved INTO ProfilesSection (immediate per-profile
    // IPC). SettingsView.save() is now a pure app-config write -- it never calls
    // any key IPC. The leave-as-is contract now lives in the Profiles key input
    // (an empty field disables Set), not in the Save path.
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={onClose}
      />,
    );
    await screen.findByText("Theme");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("prevents ESC exit while saving (atomic-write guard, ADR-0065)", async () => {
    // busy = saving (issue #153 dropped the loading gate). A never-resolving
    // onCommitAppConfig keeps saving true; the window-level ESC listener bails
    // so a mid-save ESC cannot close the view (the atomic write would be torn).
    const onCommitAppConfig = vi
      .fn()
      .mockImplementation(() => new Promise<void>(() => {}));
    const onClose = vi.fn();
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={onClose}
      />,
    );
    await screen.findByText("Theme");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Confirm the saving state is active before asserting the guard.
    await screen.findByText(/Saving/);
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("ESC exits when not busy (ADR-0065 keyboard exit)", async () => {
    // Without a mask, ESC is the keyboard exit. When not saving, ESC closes the
    // view via the window-level listener.
    const onClose = vi.fn();
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />,
    );
    await screen.findByText("Theme");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("switches panes via the left nav (ADR-0065)", async () => {
    // The left nav's four buttons swap the right pane; switching does NOT save
    // (no commit until Save). Engine shows the engine fieldset, Privacy shows
    // the disclosure banner, Profiles shows the profile list (issue #153: no
    // longer a placeholder).
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    await screen.findByText("Theme");
    // Default pane is General; switch to Engine.
    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
    expect(screen.getByText("Engine defaults (ADR-0005)")).toBeInTheDocument();
    // Switch to Privacy: the disclosure banner (ADR-0011/0019) mounts.
    fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    // Switch to Profiles: the profile list renders (New profile button present).
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    expect(screen.getByRole("button", { name: "New profile" })).toBeInTheDocument();
    // No save happened during the tour.
    expect(onCommitAppConfig).not.toHaveBeenCalled();
  });

  // --- Profiles pane: master-detail + CRUD + key status (issue #153 ACs) -----

  it("Profiles pane lists profiles with key-status badges (issue #153)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: true },
    ]);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // The single profile shows its display name + the "Key set" badge; the
    // active badge is also present (default is the active profile).
    await screen.findByText("Anthropic");
    expect(screen.getByText("Key set")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("No key")).not.toBeInTheDocument();
  });

  it("creates a new profile via New profile and commits it on save (issue #153)", async () => {
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByRole("button", { name: "New profile" });
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    // A second list item appears with the "Unnamed profile" placeholder (the
    // new profile's display_name starts empty).
    expect(screen.getByText("Unnamed profile")).toBeInTheDocument();
    // Save commits the new profile list (2 profiles now).
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles.length).toBe(2);
    // The new profile's id is stable + non-empty (ProfileId minted client-side).
    const created = committed.provider.profiles[1];
    expect(created.id).toBeTruthy();
    expect(created.protocol).toBe("anthropic");
  });

  it("delete opens an AlertDialog and confirming removes the profile (issue #153)", async () => {
    // Start with two profiles so deletion leaves one (the AlertDialog confirm
    // is the AC's accidental-delete guard).
    const twoProfileConfig: AppConfig = {
      ...baseConfig,
      provider: {
        profiles: [
          baseConfig.provider.profiles[0],
          {
            id: "second",
            display_name: "GLM",
            protocol: "openai",
            base_url: "https://open.bigmodel.cn/api/paas/v4",
            model: "glm-4",
          },
        ],
        active_profile: "default",
      },
    };
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: false },
      { profile_id: "second", has_key: false },
    ]);
    renderSettings(
      <SettingsView
        appConfig={twoProfileConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByText("GLM");
    // Open the delete confirm for the second profile.
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[1]);
    // AlertDialog mounts (destructive confirm: no accidental delete).
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    // Confirming scopes to the dialog (the list also has Delete buttons).
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    // The profile is gone from the list.
    expect(screen.queryByText("GLM")).not.toBeInTheDocument();
  });

  it("set key calls setProfileKey and flips the badge to Key set (issue #153)", async () => {
    // Key set is immediate IPC (ADR-0029 one-shot); the returned bool flips the
    // has_key overlay so the badge updates without a re-fetch.
    vi.mocked(setProfileKey).mockResolvedValue(true);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByText("No key");
    // Type a key + click Set key (the default profile is the selected one).
    fireEvent.change(screen.getByPlaceholderText("Paste key"), {
      target: { value: "sk-test-153" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await waitFor(() =>
      expect(vi.mocked(setProfileKey)).toHaveBeenCalledWith("default", "sk-test-153"),
    );
    // The badge flips to "Key set" (the IPC's returned bool updates the overlay).
    await screen.findByText("Key set");
    expect(screen.queryByText("No key")).not.toBeInTheDocument();
  });

  it("edits a profile's display name and commits it on save (issue #153)", async () => {
    // AC#3: display_name is the renamable half of the ADR-0037/0064 split
    // (ProfileId stays immutable). The edit form's Display name field patches
    // the selected profile via updateProfile; Save commits the renamed list in
    // one atomic app-config write.
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // The default profile is selected by default; its current name shows first.
    await screen.findByText("Anthropic");
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "My Claude" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    // display_name updated; the stable id is unchanged (ADR-0037/0064).
    expect(committed.provider.profiles[0].display_name).toBe("My Claude");
    expect(committed.provider.profiles[0].id).toBe("default");
  });

  it("clear key calls clearProfileKey and flips the badge to No key (issue #153)", async () => {
    // AC#4: clear is the symmetric immediate per-profile IPC (ADR-0029 one-shot);
    // the returned bool (false on success) flips the has_key overlay so the badge
    // updates without a re-fetch. Pins the clear path the set-key test does not.
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: true },
    ]);
    vi.mocked(clearProfileKey).mockResolvedValue(false);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // The default profile starts with a key stored; Clear key is available.
    await screen.findByText("Key set");
    fireEvent.click(screen.getByRole("button", { name: "Clear key" }));
    await waitFor(() => expect(vi.mocked(clearProfileKey)).toHaveBeenCalledWith("default"));
    // The badge flips to "No key" (the IPC's returned bool updates the overlay).
    await screen.findByText("No key");
    expect(screen.queryByText("Key set")).not.toBeInTheDocument();
  });

  it("a failed set-key leaves the badge unchanged and surfaces the error (issue #153, ADR-0029)", async () => {
    // Trust-root guard: if setProfileKey rejects, the has_key overlay MUST NOT
    // flip -- setProfileKeys runs only on the success branch, so the badge stays
    // at "No key", and the failure message reaches the user. A regression that
    // flips the badge optimistically (or drops the try/catch) would let the user
    // believe a key is stored when it is not (ADR-0029 violation).
    vi.mocked(setProfileKey).mockRejectedValue(new Error("keychain locked"));
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByText("No key");
    fireEvent.change(screen.getByPlaceholderText("Paste key"), {
      target: { value: "sk-test-153" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    // The badge stays "No key" (failure must not read as set); the error lands.
    await screen.findByText("keychain locked");
    expect(screen.getByText("No key")).toBeInTheDocument();
    expect(screen.queryByText("Key set")).not.toBeInTheDocument();
  });

  it("Profiles pane surfaces a key-status fetch failure without blocking CRUD (issue #153)", async () => {
    // If list_provider_profiles rejects (a keychain read outage), the pane must
    // render the error rather than silently showing an empty list. The rest of
    // the pane stays usable -- New profile is still enabled (the error is
    // informational, not a hard block on CRUD).
    vi.mocked(listProviderProfiles).mockRejectedValue(
      new Error("keychain unavailable"),
    );
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByText("keychain unavailable");
    expect(screen.getByRole("button", { name: "New profile" })).toBeEnabled();
  });
});

describe("Table primitives (ADR-0067, issue #168 self-contained)", () => {
  // ADR-0067 retires the styles.css global `table / th / td` element rules; the
  // Table primitives carry their own border / bg / padding utilities so they
  // render correctly with NO global table CSS. This pins the structural
  // invariant -- a regression that drops border / bg-muted would silently
  // revert to relying on the retired global rules. jsdom has no layout engine,
  // so these are className-contract assertions on the real rendered elements,
  // not visual checks. Each token is asserted via split(/\s+/) + toContain so
  // `border` does not match `border-collapse` / `border-b` etc. -- a bare
  // toMatch(/\bborder\b/) passes spuriously against any border-* utility.
  it("Table renders a <table> with border-collapse (no global table rule needed)", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.className.split(/\s+/)).toContain("border-collapse");
  });

  it("TableHead carries its own border + bg-muted + text-sm (no global th rule needed)", () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>h</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const th = container.querySelector("th");
    expect(th).not.toBeNull();
    // Grid border (border-color from app.css @layer base).
    expect(th?.className.split(/\s+/)).toContain("border");
    // Header tint.
    expect(th?.className.split(/\s+/)).toContain("bg-muted");
    // Font-size (ADR-0067 Decision 2: scale over arbitrary values).
    expect(th?.className.split(/\s+/)).toContain("text-sm");
  });

  it("TableCell carries its own border + text-sm (no global td rule needed)", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>c</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const td = container.querySelector("td");
    expect(td).not.toBeNull();
    expect(td?.className.split(/\s+/)).toContain("border");
    expect(td?.className.split(/\s+/)).toContain("text-sm");
  });
});
