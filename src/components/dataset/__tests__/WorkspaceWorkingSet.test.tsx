import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceWorkingSet } from "../WorkspaceWorkingSet";
import { listWorkingSet, activeDataset, readRows, removeActiveSource } from "../../../api";
import { SAMPLE_ROW_LIMIT, type UseWorkingSetSurfaces } from "../../../session/useWorkingSet";
import { sessionKeys } from "../../../session/queryKeys";
import type { DatasetDescriptor, RowPage } from "../../../types/dataset";
import { mockDataset, mockSamplePage, staleDataset } from "./helpers";
import { withIntl } from "../../common/__tests__/helpers";

// The working-set tab's master/detail composition, extracted from SessionPane
// so the tab's shell decisions (issue #792: one empty card vs the two-column
// pair) are testable without the pane's IPC mock layer. The detail pane is
// anchored through DatasetDetail's row-count line (行数：N) -- the row list
// renders "N 行", so the two never collide. ADR-0123: the component consumes
// the useWorkingSet seam, so the descriptor queries ride the mocked api and
// every render needs a QueryClientProvider; the domain authority (cascade,
// delete machine, resolution fallbacks) lives in the hook's own tests -- this
// layer pins the render contract only.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listWorkingSet: vi.fn(),
    activeDataset: vi.fn(),
    readRows: vi.fn(),
    removeActiveSource: vi.fn(),
  };
});

// row_count 9 makes the orders detail distinguishable from people's (both
// fixtures spread the shared mockDataset otherwise; the sample field is a
// wire-shape requirement with no rendering consumer, issue #1061).
const orders: DatasetDescriptor = {
  ...mockDataset,
  reference_name: "orders",
  display_name: "orders",
  row_count: 9,
  sample: [["1", "ord-1"]],
};

const SESSION = "sess-1";
const NOOP_ADD: (paths: string[]) => void = () => {};

// The pane-level mutation surfaces (ADR-0123) as plain spies -- the
// cross-domain reports are assertable, and no error face renders inside the
// panel (the pane strip owns that, pinned in App's issue #1060 test).
function makeSurfaces(): UseWorkingSetSurfaces {
  return {
    setError: vi.fn(),
    setMutationLoading: vi.fn(),
    pollPersistError: vi.fn(async () => {}),
  };
}

// The query's default answer: an empty page. The composition asserts (行数
// line, band, empty card) which a hidden preview never disturbs; the
// preview-focused tests below override per behavior.
const EMPTY_PAGE: RowPage = {
  columns: [{ name: "ref", canonical_type: "VARCHAR" }],
  rows: [],
  total: 0,
  offset: 0,
  limit: SAMPLE_ROW_LIMIT,
};

// A fresh client per render (test cache never bleeds), but the SAME client
// across a test's rerenders so the fetched page stays cached. retry:false:
// the mock's rejection IS the test's subject, not a transient to retry.
// Exposed for the invalidation-cascade pin: the seam's mutations invalidate
// the workingSet prefix.
function renderSet(
  datasets: DatasetDescriptor[] = [mockDataset, orders],
  active: DatasetDescriptor | null = datasets[0] ?? null,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.mocked(listWorkingSet).mockResolvedValue(datasets);
  vi.mocked(activeDataset).mockResolvedValue(active);
  const surfaces = makeSurfaces();
  const wrap = (element: ReactElement) => (
    <QueryClientProvider client={queryClient}>{withIntl(element)}</QueryClientProvider>
  );
  const view = render(
    wrap(
      <WorkspaceWorkingSet
        sessionId={SESSION}
        busy={false}
        onAddFiles={NOOP_ADD}
        surfaces={surfaces}
      />,
    ),
  );
  return { ...view, queryClient, surfaces };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readRows).mockResolvedValue(EMPTY_PAGE);
});

describe("WorkspaceWorkingSet", () => {
  it("renders a single empty-state card when the set is empty (issue #792)", () => {
    const { container } = renderSet([], null);
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

  it("follows the active dataset until the user picks, with the band following the pick", async () => {
    renderSet();
    // No pick: the resolution floors at the active dataset (people).
    expect(await screen.findByText(/行数：5/)).toBeInTheDocument();
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

  it("pins the section heading to headline-sm 16px/600 (issue #864)", async () => {
    renderSet([mockDataset]);
    // The workspace body's 14px baseline (issue #864) inherits into the bare
    // h2 unless it carries the headline token explicitly -- dropping the
    // utility would flatten the list section's hierarchy to body size.
    const h2 = await screen.findByRole("heading", { level: 2, name: /工作集 · 1/ });
    expect(h2.className.split(/\s+/)).toContain("text-base");
    expect(h2.className.split(/\s+/)).toContain("font-semibold");
  });

  it("previews the shown dataset's first rows through readRows (issue #1061)", async () => {
    // The read rides the paged channel with the pane's session addressing and
    // the fixed first window; the page's own column list drives the headers.
    vi.mocked(readRows).mockResolvedValue({
      ...mockSamplePage,
      total: 5,
      offset: 0,
      limit: SAMPLE_ROW_LIMIT,
    });
    renderSet([mockDataset]);
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
    renderSet();
    expect(await screen.findByText("rows-people")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    expect(await screen.findByText("rows-orders")).toBeInTheDocument();
  });

  it("hides the preview section when the read returns zero rows (issue #1061)", async () => {
    renderSet([mockDataset]);
    await waitFor(() => expect(readRows).toHaveBeenCalled());
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    // No sample section at all -- no heading, no empty shell. The wait pins
    // the SETTLED state: between the fetch firing and resolving, the section
    // legitimately shows its loading line.
    await waitFor(() => expect(screen.queryByText(/数据样本/)).toBeNull());
  });

  it("shows a failed preview read inline and keeps the detail working (issue #1061)", async () => {
    vi.mocked(readRows).mockRejectedValue(new Error("boom"));
    renderSet([mockDataset]);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    // The management surface stays up: the meta line and the list remain.
    expect(screen.getByText(/行数：5/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument();
  });

  it("renders the stale badge on a stale dataset's detail title (issue #1061)", async () => {
    renderSet([staleDataset("Deleted")]);
    // Stale data still reads (ADR-0013) -- the preview fetch fires AND the
    // honest badge rides the title.
    expect(await screen.findByText("上游已删除")).toBeInTheDocument();
    expect(readRows).toHaveBeenCalledWith(SESSION, "people", 0, SAMPLE_ROW_LIMIT);
  });

  it("pins the preview window at 20 rows", () => {
    // Every other assertion references the exported constant, which pins
    // consistency but not the number itself -- a silent resize would
    // redden nothing. Pin the value.
    expect(SAMPLE_ROW_LIMIT).toBe(20);
  });

  it("shows the loading line while the seam's preview read is in flight (issue #1061)", async () => {
    // The renderer's loading arm is pinned by its direct-prop test; this
    // guards the seam's sampleLoading forwarding, which no other test
    // observes (dropping that wiring to a constant keeps everything green).
    let resolveRead: (page: RowPage) => void = () => {};
    vi.mocked(readRows).mockImplementation(
      () => new Promise<RowPage>((resolve) => (resolveRead = resolve)),
    );
    renderSet([mockDataset]);
    // The descriptors land async (the query-mocked shape), so wait for the
    // management surface before pinning the preview's in-flight line.
    expect(await screen.findByRole("button", { name: /^people/ })).toBeInTheDocument();
    expect(screen.getByText(/正在加载行数据/)).toBeInTheDocument();
    resolveRead(EMPTY_PAGE);
    await waitFor(() => expect(screen.queryByText(/正在加载行数据/)).toBeNull());
  });

  it("refetches the preview when the working-set prefix is invalidated (issue #1061)", async () => {
    // The cascade half: rename / replace / delete / privacy mutations
    // invalidate the workingSet prefix (the seam's cascade), and the
    // previewRows key must nest under it -- a replaced source's rows would
    // otherwise linger forever (staleTime is Infinity, so nothing else ever
    // refetches). The mutation-driven authority pin lives in the hook's
    // tests; this one pins the nesting from the consumption side.
    vi.mocked(readRows).mockImplementation(async (_sessionId, referenceName) => ({
      columns: [{ name: "tag", canonical_type: "VARCHAR" }],
      rows: [[`rows-${referenceName}`]],
      total: 1,
      offset: 0,
      limit: SAMPLE_ROW_LIMIT,
    }));
    const { queryClient } = renderSet([mockDataset]);
    expect(await screen.findByText("rows-people")).toBeInTheDocument();
    vi.mocked(readRows).mockClear();
    await queryClient.invalidateQueries({ queryKey: sessionKeys.workingSet(SESSION) });
    expect(readRows).toHaveBeenCalledWith(SESSION, "people", 0, SAMPLE_ROW_LIMIT);
  });

  it("mounts the active-source confirm dialog on the working-set side (ADR-0123)", async () => {
    // Issue #39 / ADR-0035: removing the ACTIVE source while others remain
    // routes through the confirm machine. ADR-0123 Decision 4: the dialog
    // mounts inside the tab (the pane's hoisting retired) -- row delete ->
    // list's own confirm -> the seam opens the continuation dialog.
    vi.mocked(removeActiveSource).mockResolvedValue(undefined);
    renderSet();
    expect(await screen.findByText(/行数：5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除 people" }));
    // The list's irreversibility confirm (alertdialog #1)...
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/确定从工作集删除「people」/);
    // ...whose bare-name 删除 Action forwards into the seam's machine...
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    // ...mounting the continuation dialog (alertdialog #2) with the
    // remaining source as its only candidate.
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/删除焦点源「people」/);
    expect(dialog).toHaveTextContent("orders");
    // Cancel is a no-op: the machine closes, nothing crosses IPC.
    fireEvent.click(screen.getByRole("button", { name: "中止" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removeActiveSource).not.toHaveBeenCalled();
  });

  it("reports a failed confirmed removal into the pane-level surfaces and keeps the machine open (ADR-0123)", async () => {
    // The cross-domain error face is the pane strip (visible from both tabs,
    // pinned in App's issue #1060 test); this layer pins the REPORT (the
    // sink receives the verb-tagged error) and the retry posture.
    vi.mocked(removeActiveSource).mockRejectedValue(new Error("remove boom"));
    const { surfaces } = renderSet();
    expect(await screen.findByText(/行数：5/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除 people" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/删除焦点源「people」/);
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(surfaces.setError).toHaveBeenCalled());
    expect(vi.mocked(surfaces.setError).mock.calls.at(-1)?.[0]?.kind).toBe("delete");
    // The machine stays mounted for retry.
    expect(screen.getByRole("alertdialog")).toHaveTextContent(/删除焦点源「people」/);
  });
});
