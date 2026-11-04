import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { WorkspaceDatasetsDialog } from "../WorkspaceDatasetsDialog";
import { withIntl } from "../../components/common/__tests__/helpers";
import type { ListedWorkspaceDataset } from "../../types/workspace-datasets";

// The panel's add / replace channel is the Tauri file dialog; stub it so the
// tests can drive the picker without the native bridge.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// Partial api mock (the WorkingSetList.test pattern): every panel mutation is
// stubbed, the rest of the module rides the real implementation.
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listWorkspaceDatasets: vi.fn(),
    addWorkspaceDataset: vi.fn(),
    removeWorkspaceDataset: vi.fn(),
    renameWorkspaceDataset: vi.fn(),
    replaceWorkspaceDataset: vi.fn(),
    setWorkspaceDatasetPrivacy: vi.fn(),
    previewDeleteImpact: vi.fn(),
  };
});

import {
  addWorkspaceDataset,
  listWorkspaceDatasets,
  previewDeleteImpact,
  removeWorkspaceDataset,
  renameWorkspaceDataset,
  replaceWorkspaceDataset,
  setWorkspaceDatasetPrivacy,
} from "../../api";
import { open } from "@tauri-apps/plugin-dialog";

// One manifest entry fixture (the wire shape, ADR-0141): stable identity +
// shape facts + frozen 2-row sample.
function entry(overrides: Partial<ListedWorkspaceDataset>): ListedWorkspaceDataset {
  return {
    reference_name: "people",
    display_name: "people",
    fingerprint: "f".repeat(64),
    size_bytes: 0,
    columns: [
      { name: "name", canonical_type: "VARCHAR" },
      { name: "score", canonical_type: "BIGINT" },
    ],
    row_count: 2,
    sample: [
      ["Ada", "9"],
      ["Grace", "7"],
    ],
    privacy: { send_samples: true, type_only_columns: [] },
    source_path: "/src/people.csv",
    file_missing: false,
    ...overrides,
  };
}

// The dialog's queries run inside React Query; withIntl already carries the
// Intl + Tooltip context the list rows need. The panel mounts bound to the
// demo workspace in every test, so the element is fixed.
function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      {withIntl(
        <WorkspaceDatasetsDialog
          workspace={{ path: "/ws", label: "Demo" }}
          onOpenChange={() => {}}
        />,
      )}
    </QueryClientProvider>,
  );
}

describe("WorkspaceDatasetsDialog", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.mocked(previewDeleteImpact).mockResolvedValue([]);
  });

  // Spies must not leak between tests; every test seeds its own listing.
  const seed = (rows: ListedWorkspaceDataset[]) =>
    vi.mocked(listWorkspaceDatasets).mockResolvedValue(rows);

  it("renders the master/detail shell: both rows list, the first entry's detail shows with the frozen sample", async () => {
    seed([entry({}), entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" })]);
    renderPanel();
    // Both rows list (the select button's accessible name starts with the
    // display label -- the WorkingSetList.test anchor convention).
    expect(await screen.findByRole("button", { name: /^people/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^orders/ })).toBeInTheDocument();
    // The detail pane shows the resolved pick (unset -> first): its heading,
    // its schema, and its frozen manifest sample. Column names render in the
    // schema, sample AND privacy tables -- anchor within the DOM-ordered
    // tables (schema, then sample) instead of a bare text match.
    expect(screen.getByRole("heading", { name: /^people/ })).toBeInTheDocument();
    const tables = screen.getAllByRole("table");
    expect(within(tables[0]).getByText("VARCHAR")).toBeInTheDocument();
    expect(within(tables[1]).getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText(/引用名：people/)).toBeInTheDocument();
  });

  it("moves the detail to the picked row; a 0-sample entry renders no preview section", async () => {
    seed([
      entry({}),
      entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv", sample: [] }),
    ]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^orders/ }));
    expect(await screen.findByRole("heading", { name: /^orders/ })).toBeInTheDocument();
    // The frozen sample is the only preview source: no rows, no section
    // (the meta line's row count already says it -- the DatasetDetail pose).
    expect(screen.queryByText("数据样本")).not.toBeInTheDocument();
  });

  it("renames through the row dialog and the IPC carries the new display label", async () => {
    seed([entry({})]);
    vi.mocked(renameWorkspaceDataset).mockResolvedValue(entry({ display_name: "Folks" }));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /重命名/ }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Folks" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(renameWorkspaceDataset).toHaveBeenCalledWith("/ws", "people", "Folks"),
    );
  });

  it("surfaces a rename rejection through the panel's error banner", async () => {
    seed([entry({}), entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" })]);
    vi.mocked(renameWorkspaceDataset).mockRejectedValue({ kind: "DisplayTaken", data: "orders" });
    renderPanel();
    // Two rows, two rename buttons: scope to the people row.
    const row = (await screen.findByRole("button", { name: /^people/ })).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("显示名 orders 已被占用");
  });

  it("replace rides the row action through the picker to the replace IPC", async () => {
    seed([entry({})]);
    vi.mocked(open).mockResolvedValue("/src/people_v2.csv");
    vi.mocked(replaceWorkspaceDataset).mockResolvedValue(entry({}));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /换源/ }));
    await waitFor(() =>
      expect(replaceWorkspaceDataset).toHaveBeenCalledWith("/ws", "people", "/src/people_v2.csv"),
    );
  });

  it("the delete confirm names the workspace and fires the remove -- no session impact preview", async () => {
    seed([entry({})]);
    vi.mocked(removeWorkspaceDataset).mockResolvedValue();
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /删除/ }));
    // The workspace override copy (never "working set"), and the confirm
    // renders without the session-scoped impact preview.
    const confirm = screen.getAllByRole("alertdialog").at(-1)!;
    expect(confirm).toHaveTextContent("从此工作区移除 people？");
    expect(previewDeleteImpact).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(removeWorkspaceDataset).toHaveBeenCalledWith("/ws", "people"));
  });

  it("flags a missing store file in the list and warns above the fully-rendered detail", async () => {
    seed([entry({ file_missing: true })]);
    renderPanel();
    // The list row's short badge...
    expect(await screen.findByText("缺文件")).toBeInTheDocument();
    // ...and the detail's honest warning, above meta/schema/sample/privacy
    // that all still render.
    const warning = screen.getAllByRole("alert").find((el) =>
      el.textContent.includes("底层文件缺失"),
    );
    expect(warning).toBeDefined();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText("隐私控制")).toBeInTheDocument();
  });

  it("the privacy toggle rides the whole-replace IPC", async () => {
    seed([entry({})]);
    vi.mocked(setWorkspaceDatasetPrivacy).mockResolvedValue(
      entry({ privacy: { send_samples: false, type_only_columns: [] } }),
    );
    renderPanel();
    fireEvent.click(await screen.findByLabelText(/发送样本值/));
    await waitFor(() =>
      expect(setWorkspaceDatasetPrivacy).toHaveBeenCalledWith("/ws", "people", {
        send_samples: false,
        type_only_columns: [],
      }),
    );
  });

  it("falls the detail back to the first row when the picked row is deleted", async () => {
    // Two listings: before and after the remove's invalidate refetch. A pick
    // naming the deleted row re-resolves to the first entry -- band and pane
    // never go blank (the working-set seam's deleted-pick fallback).
    vi.mocked(listWorkspaceDatasets)
      .mockResolvedValueOnce([
        entry({}),
        entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" }),
      ])
      .mockResolvedValue([entry({})]);
    vi.mocked(removeWorkspaceDataset).mockResolvedValue();
    renderPanel();
    const ordersRow = (await screen.findByRole("button", { name: /^orders/ })).closest("li")!;
    fireEvent.click(screen.getByRole("button", { name: /^orders/ }));
    fireEvent.click(within(ordersRow).getByRole("button", { name: /删除/ }));
    fireEvent.click(within(screen.getAllByRole("alertdialog").at(-1)!).getByRole("button", { name: "删除" }));
    // The refetch drops orders; the detail re-resolves to people.
    expect(await screen.findByRole("heading", { name: /^people/ })).toBeInTheDocument();
    const peopleRow = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    expect(peopleRow.className.split(/\s+/)).toContain("bg-accent");
  });

  it("clears the error banner on the reopen edge, not mid-animation", async () => {
    // The close animation must play over the exact face the user is
    // leaving, so the close edge keeps every rendered input (the workspace
    // prop is nulled by the sidebar the moment close is requested); the
    // reopen edge clears the residue. jsdom runs no exit animation, so the
    // frozen close face itself is real-browser QA; this pins the reopen
    // cleanup.
    seed([
      entry({}),
      entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" }),
    ]);
    vi.mocked(renameWorkspaceDataset).mockRejectedValue({ kind: "DisplayTaken", data: "orders" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const bound = (ws: { path: string; label: string } | null) => (
      <QueryClientProvider client={client}>
        {withIntl(<WorkspaceDatasetsDialog workspace={ws} onOpenChange={() => {}} />)}
      </QueryClientProvider>
    );
    const view = render(bound({ path: "/ws", label: "Demo" }));
    // The dialog's Save guard refuses blanks up front, so the backend
    // rejection rides the display-taken path (a label the other row holds).
    const row = (await screen.findByRole("button", { name: /^people/ })).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // Close (the workspace prop nulls; the panel keeps its state), then
    // reopen the same workspace: the banner is gone.
    view.rerender(bound(null));
    view.rerender(bound({ path: "/ws", label: "Demo" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^people/ })).toBeInTheDocument();
  });

  it("selects the freshly added dataset as the detail pick", async () => {
    // One listing before the add's refetch, one after (the manifest gains
    // the new entry). The IPC returns the landed entry; its reference name
    // becomes the pick.
    vi.mocked(listWorkspaceDatasets)
      .mockResolvedValueOnce([entry({})])
      .mockResolvedValue([
        entry({}),
        entry({ reference_name: "new", display_name: "new", source_path: "/src/new.csv" }),
      ]);
    vi.mocked(open).mockResolvedValue("/src/new.csv");
    vi.mocked(addWorkspaceDataset).mockResolvedValue(
      entry({ reference_name: "new", display_name: "new", source_path: "/src/new.csv" }),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    // The detail re-resolves onto the new row; the band rides with it.
    expect(await screen.findByRole("heading", { name: /^new/ })).toBeInTheDocument();
    const newRow = screen.getByRole("button", { name: /^new/ }).closest("li")!;
    expect(newRow.className.split(/\s+/)).toContain("bg-accent");
    const peopleRow = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    expect(peopleRow.className.split(/\s+/)).not.toContain("bg-accent");
  });

  it("an empty manifest renders the single empty card, not the two-column shell", async () => {
    seed([]);
    renderPanel();
    expect(await screen.findByText(/还没有数据集/)).toBeInTheDocument();
    expect(screen.queryByText(/^数据集 · /)).not.toBeInTheDocument();
    // No rows, no detail pane: the empty card is the only section.
    expect(screen.queryByRole("button", { name: /^people/ })).not.toBeInTheDocument();
  });

  it("renders a renamed label across the row, the heading and the delete confirm; the reference name stays the anchor line", async () => {
    seed([entry({ display_name: "Folks" })]);
    renderPanel();
    // The dual-name contract's visible half: the label carries the row and
    // the heading; the reference name survives as the SQL anchor line.
    expect(await screen.findByRole("button", { name: /^Folks/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Folks/ })).toBeInTheDocument();
    expect(screen.getByText(/引用名：people/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^people/ })).not.toBeInTheDocument();
    // The destructive confirm names the label too (the target the user sees).
    fireEvent.click(screen.getByRole("button", { name: /删除/ }));
    expect(screen.getAllByRole("alertdialog").at(-1)!).toHaveTextContent("从此工作区移除 Folks？");
  });

  it("clears the error banner the moment a rename retry fires", async () => {
    seed([
      entry({}),
      entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" }),
    ]);
    vi.mocked(renameWorkspaceDataset)
      .mockRejectedValueOnce({ kind: "DisplayTaken", data: "orders" })
      .mockResolvedValue(entry({ display_name: "Folks" }));
    renderPanel();
    const row = (await screen.findByRole("button", { name: /^people/ })).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "orders" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("显示名 orders 已被占用");
    // Retry with a free label: the banner clears on fire, before the IPC
    // settles -- a stale refusal must not contradict a visible success.
    const rowAgain = screen.getByRole("button", { name: /^people/ }).closest("li")!;
    fireEvent.click(within(rowAgain).getByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Folks" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(renameWorkspaceDataset).toHaveBeenLastCalledWith("/ws", "people", "Folks"),
    );
  });

  it("maps the backend's blank-label refusal onto the banner (defense in depth)", async () => {
    // The row dialog's trim guard makes this near-unreachable from the UI;
    // the mapping is the backend refusal's honest landing spot.
    seed([entry({})]);
    vi.mocked(renameWorkspaceDataset).mockRejectedValue({ kind: "InvalidLabel" });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /重命名/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Folks" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("显示名不能为空白");
  });

  it("locks the row actions while a removal is in flight", async () => {
    let resolveRemove: (() => void) | undefined;
    vi.mocked(removeWorkspaceDataset).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRemove = resolve;
        }),
    );
    seed([entry({})]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /删除/ }));
    fireEvent.click(
      within(screen.getAllByRole("alertdialog").at(-1)!).getByRole("button", { name: "删除" }),
    );
    // busy rides the loading prop: the row's rename / replace / delete lock
    // until the remove settles (the private face's posture).
    expect(await screen.findByRole("button", { name: /重命名/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /换源/ })).toBeDisabled();
    resolveRemove!();
    await waitFor(() => expect(screen.getByRole("button", { name: /重命名/ })).toBeEnabled());
  });

  it("renders neither face when the listing itself fails -- the banner is the face", async () => {
    vi.mocked(listWorkspaceDatasets).mockRejectedValue({
      kind: "ManifestCorrupt",
      data: "datasets.json",
    });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/已损坏/);
    // No empty card asserting an empty workspace, no two-column shell: the
    // refusal is the face, and an Add it would refuse is not invited.
    expect(screen.queryByText(/还没有数据集/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^数据集 · /)).not.toBeInTheDocument();
  });

  it("renders the CSV-unreadable refusal as its own sentence, engine detail riding after", async () => {
    // Issue #1483: the sniff-failure reject must not bare the raw engine
    // string as the whole banner (the Io echo it used to fall through to);
    // the catalog sentence leads, the detail stays for triage.
    seed([entry({})]);
    vi.mocked(open).mockResolvedValue("/src/bad.csv");
    vi.mocked(addWorkspaceDataset).mockRejectedValue({
      kind: "DataUnreadable",
      data: `Error when sniffing file "/src/bad.csv".`,
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("无法解析该数据文件");
    expect(banner).toHaveTextContent("Error when sniffing file");
  });
  // Issue #1485: the picker's add batch runs the mutations SEQUENTIALLY (the
  // backend manifest lock serializes anyway), so each landed file invalidates
  // the listing and the status line names the file in flight until the batch
  // settles.
  it("runs the add batch sequentially, naming the file in flight in the status line", async () => {
    vi.mocked(listWorkspaceDatasets)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" })])
      .mockResolvedValue([
        entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" }),
        entry({ reference_name: "b", display_name: "b", source_path: "/src/b.csv" }),
      ]);
    vi.mocked(open).mockResolvedValue(["/src/a.csv", "/src/b.csv"]);
    vi.mocked(addWorkspaceDataset).mockClear();
    const gates: Array<(e: ListedWorkspaceDataset) => void> = [];
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { gates.push(resolve); }),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    // File 1 in flight: the line names it; the second IPC has not fired.
    expect(await screen.findByText(/正在添加 a\.csv（第 1\/2 个）/)).toBeInTheDocument();
    expect(addWorkspaceDataset).toHaveBeenCalledTimes(1);
    await act(async () => {
      gates[0](entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" }));
    });
    expect(await screen.findByText(/正在添加 b\.csv（第 2\/2 个）/)).toBeInTheDocument();
    expect(addWorkspaceDataset).toHaveBeenCalledTimes(2);
    await act(async () => {
      gates[1](entry({ reference_name: "b", display_name: "b", source_path: "/src/b.csv" }));
    });
    await waitFor(() => expect(screen.queryByText(/正在添加/)).toBeNull());
  });

  it("names the row in the status line while a replace round-trips and clears it on settle", async () => {
    seed([entry({})]);
    vi.mocked(open).mockResolvedValue("/src/people_v2.csv");
    vi.mocked(replaceWorkspaceDataset).mockClear();
    const gates: Array<(e: ListedWorkspaceDataset) => void> = [];
    vi.mocked(replaceWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { gates.push(resolve); }),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /换源/ }));
    await waitFor(() => expect(replaceWorkspaceDataset).toHaveBeenCalled());
    expect(await screen.findByText(/正在替换 people/)).toBeInTheDocument();
    await act(async () => {
      gates[0](entry({}));
    });
    await waitFor(() => expect(screen.queryByText(/正在替换/)).toBeNull());
  });
});
