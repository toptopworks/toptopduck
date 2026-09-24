import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceWorkingSet } from "../WorkspaceWorkingSet";
import { SAMPLE_ROW_LIMIT } from "../DatasetDetail";
import { readRows } from "../../../api";
import type { DatasetDescriptor, RowPage } from "../../../types/dataset";
import { mockDataset } from "./helpers";
import { withIntl } from "../../common/__tests__/helpers";

// The working-set tab's master/detail composition, extracted from SessionPane
// so the tab's shell decisions (issue #792: one empty card vs the two-column
// pair; the detail's delete fallback) are testable without the pane's IPC
// mock layer. The detail pane is anchored through DatasetDetail's row-count
// line (行数：N) -- the row list renders "N 行", so the two never collide.
// Issue #1061: the container also owns the live sample preview query, so the
// readRows IPC is mocked and every render rides a QueryClientProvider.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    readRows: vi.fn(),
  };
});

// row_count 9 + its own sample make the orders detail distinguishable from
// people's (both fixtures spread the shared mockDataset otherwise).
const orders: DatasetDescriptor = {
  ...mockDataset,
  reference_name: "orders",
  display_name: "orders",
  row_count: 9,
  sample: [["1", "ord-1"]],
};

const SESSION = "sess-1";

const NOOPS = {
  onRename: () => {},
  onReplace: () => {},
  onDelete: () => {},
  onPrivacyChange: () => {},
  onAddFiles: () => {},
} as const;

// The query's default answer: an empty page. Existing shell tests assert the
// composition (行数 line, band, empty card) which a hidden preview never
// disturbs; the preview-focused tests below override per behavior.
const EMPTY_PAGE: RowPage = {
  columns: [{ name: "ref", canonical_type: "VARCHAR" }],
  rows: [],
  total: 0,
  offset: 0,
  limit: SAMPLE_ROW_LIMIT,
};

// A fresh client per render (test cache never bleeds), but the SAME client
// across a test's rerenders so the pick state survives the prop update --
// a new provider would remount the tab and reset the pick. retry:false: the
// mock's rejection IS the test's subject, not a transient to retry.
function renderSet(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (element: ReactElement) => (
    <QueryClientProvider client={queryClient}>{withIntl(element)}</QueryClientProvider>
  );
  const view = render(wrap(ui));
  return { ...view, rerender: (element: ReactElement) => view.rerender(wrap(element)) };
}

beforeEach(() => {
  vi.mocked(readRows).mockClear();
  vi.mocked(readRows).mockResolvedValue(EMPTY_PAGE);
});

describe("WorkspaceWorkingSet", () => {
  it("renders a single empty-state card when the set is empty (issue #792)", () => {
    const { container } = renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[]}
        activeName={null}
        loading={false}
        {...NOOPS}
      />,
    );
    // The two-column master/detail shell does not mount at all -- one panel
    // card carries the hint + the inline add entry.
    expect(container.querySelector(".layout")).toBeNull();
    expect(container.querySelectorAll(".panel")).toHaveLength(1);
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加数据文件" })).toBeInTheDocument();
    // The old near-empty right pane's placeholder is gone with the shell.
    expect(screen.queryByText(/选择一个数据集/)).not.toBeInTheDocument();
    // Nothing to preview -> no read fires.
    expect(readRows).not.toHaveBeenCalled();
  });

  it("seeds the detail pick from the active dataset on mount (issue #1065)", () => {
    // The initial pick seeds from activeName alone -- the initializer
    // comment in WorkspaceWorkingSet carries the rationale (issue #1060).
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset, orders]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
  });

  it("shows the picked dataset's detail over the active one, with the band following the pick", () => {
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset, orders]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(screen.getByText(/行数：9/)).toBeInTheDocument();
    // The row band follows the click (the pick), NOT the active dataset:
    // before the split the band was keyed to activeName, so a management
    // pick left the highlight stranded on the active row while the detail
    // pane moved -- the two surfaces disagreed.
    const ordersRow = screen.getByRole("button", { name: /^orders/ }).closest("li")!;
    expect(ordersRow.className.split(/\s+/)).toContain("bg-accent");
    expect(ordersRow.className.split(/\s+/)).toContain("selected");
    const peopleRow = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    expect(peopleRow.className.split(/\s+/)).not.toContain("bg-accent");
    // The active dataset keeps its in-list marker: the bold label.
    expect(
      screen.getByRole("button", { name: /^people/ }).className.split(/\s+/),
    ).toContain("font-semibold");
  });

  it("falls back to the active dataset's detail after the pick is deleted (issue #792)", () => {
    const { rerender } = renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset, orders]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(screen.getByText(/行数：9/)).toBeInTheDocument();
    // The picked dataset is removed (a confirmed row delete); the detail must
    // follow the ACTIVE dataset, not drop to a placeholder mid-management.
    rerender(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    expect(screen.queryByText(/选择一个数据集/)).not.toBeInTheDocument();
    // The band rides the RESOLVED pick: after the fallback it sits on the
    // active row (what the pane shows), never on the deleted pick's name.
    const peopleRow = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    expect(peopleRow.className.split(/\s+/)).toContain("bg-accent");
  });

  it("falls back to the first list item when the active is absent too (issue #792)", () => {
    const { rerender } = renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset, orders]}
        activeName={null}
        loading={false}
        {...NOOPS}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^people/ }));
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    rerender(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[orders]}
        activeName={null}
        loading={false}
        {...NOOPS}
      />,
    );
    expect(screen.getByText(/行数：9/)).toBeInTheDocument();
    // The band rides the resolved pick on this fallback branch too: with
    // both the pick and the active gone it lands on the first item -- the
    // same row the detail pane shows.
    const ordersRow = screen.getByRole("button", { name: /^orders/ }).closest("li")!;
    expect(ordersRow.className.split(/\s+/)).toContain("bg-accent");
  });

  it("re-renders into the empty-state card when the last dataset is deleted (issue #792)", () => {
    const { rerender, container } = renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    rerender(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[]}
        activeName={null}
        loading={false}
        {...NOOPS}
      />,
    );
    expect(screen.getByText(/工作集为空/)).toBeInTheDocument();
    expect(container.querySelector(".layout")).toBeNull();
  });

  it("pins the section heading to headline-sm 16px/600 (issue #864)", () => {
    // The workspace body's 14px baseline (issue #864) inherits into the bare
    // h2 unless it carries the headline token explicitly -- dropping the
    // utility would flatten the list section's hierarchy to body size.
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    const h2 = screen.getByRole("heading", { level: 2, name: /工作集 · 1/ });
    expect(h2.className.split(/\s+/)).toContain("text-base");
    expect(h2.className.split(/\s+/)).toContain("font-semibold");
  });

  it("previews the shown dataset's first rows through readRows (issue #1061)", async () => {
    // The read rides the paged channel with the pane's session addressing and
    // the fixed first window; the page's own column list drives the headers.
    vi.mocked(readRows).mockResolvedValue({
      columns: [
        { name: "id", canonical_type: "BIGINT" },
        { name: "name", canonical_type: "VARCHAR" },
      ],
      rows: [
        ["1", "Zoe"],
        ["2", "Yan"],
      ],
      total: 5,
      offset: 0,
      limit: SAMPLE_ROW_LIMIT,
    });
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    expect(await screen.findByText("Zoe")).toBeInTheDocument();
    expect(readRows).toHaveBeenCalledWith(SESSION, "people", 0, SAMPLE_ROW_LIMIT);
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
  });

  it("previews the picked dataset when the selection switches", async () => {
    // Each reference's page carries a tag row only that dataset returns, so
    // the swap from the people preview to the orders preview is observable.
    vi.mocked(readRows).mockImplementation(async (_sessionId, referenceName) => ({
      columns: [{ name: "tag", canonical_type: "VARCHAR" }],
      rows: [[`rows-${referenceName}`]],
      total: 1,
      offset: 0,
      limit: SAMPLE_ROW_LIMIT,
    }));
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset, orders]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    expect(await screen.findByText("rows-people")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(await screen.findByText("rows-orders")).toBeInTheDocument();
  });

  it("hides the preview section when the read returns zero rows (issue #1061)", async () => {
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    // No sample section at all -- no heading, no empty shell. The wait pins
    // the SETTLED state: between the fetch firing and resolving, the section
    // legitimately shows its loading line.
    await waitFor(() => expect(screen.queryByText(/数据样本/)).toBeNull());
  });

  it("shows a failed preview read inline and keeps the detail working (issue #1061)", async () => {
    vi.mocked(readRows).mockRejectedValue(new Error("boom"));
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[mockDataset]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    // The management surface stays up: the meta line and the list remain.
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument();
  });

  it("renders the stale badge on a stale dataset's detail title (issue #1061)", async () => {
    const stalePeople: DatasetDescriptor = {
      ...mockDataset,
      stale: { reference_name: "people", display_name: "people", reason: "Deleted" },
    };
    renderSet(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        datasets={[stalePeople]}
        activeName="people"
        loading={false}
        {...NOOPS}
      />,
    );
    // Stale data still reads (ADR-0013) -- the preview fetch fires AND the
    // honest badge rides the title.
    expect(await screen.findByText("上游已删除")).toBeInTheDocument();
    expect(readRows).toHaveBeenCalledWith(SESSION, "people", 0, SAMPLE_ROW_LIMIT);
  });
});
