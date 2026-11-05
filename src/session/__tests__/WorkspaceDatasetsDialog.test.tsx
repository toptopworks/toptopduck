import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { WorkspaceDatasetsDialog } from "../WorkspaceDatasetsDialog";
import { withIntl } from "../../components/common/__tests__/helpers";
import type { ListedWorkspaceDataset } from "../../types/workspace-datasets";

// The panel's add / replace channel is the Tauri file dialog; stub it so the
// tests can drive the picker without the native bridge.
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// The toast store is mocked, not rendered: this panel's contract is the
// FIRING leg (#1490 -- which failures route to a toast, with which copy);
// the rendering face is the #1494 infra's own covered ground. The module
// keeps every vi.fn in one instance for the file, so consuming tests
// mockClear before asserting.
vi.mock("../../components/ui/use-toast", () => ({
  useToast: () => ({ toasts: [], toast: vi.fn(), dismiss: vi.fn() }),
  toast: vi.fn(),
}));

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
import { toast } from "../../components/ui/use-toast";
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

// The badge's trailing elapsed face ("· 12秒"-shaped suffix): one named
// pattern for the badge assertions -- a face rewording would otherwise need
// an edit per site.
const ELAPSED_SUFFIX = /· \d+秒/;

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
  // the listing and the badge names the file in flight until the batch
  // settles.
  it("runs the add batch sequentially, naming the file in flight in the badge", async () => {
    vi.mocked(listWorkspaceDatasets)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" })])
      .mockResolvedValue([
        entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" }),
        entry({ reference_name: "b", display_name: "b", source_path: "/src/b.csv" }),
      ]);
    vi.mocked(open)
      .mockResolvedValueOnce(["/src/a.csv", "/src/b.csv"])
      .mockResolvedValue(["/src/c.csv"]);
    vi.mocked(addWorkspaceDataset).mockClear();
    const gates: Array<(e: ListedWorkspaceDataset) => void> = [];
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { gates.push(resolve); }),
    );
    // ONE batch clock (#1488): every Date.now call steps +2500, so the
    // suffix mounted for file 1 already reads 2s past the batch stamp and
    // file 2's window holds the same 2s-or-more -- the stamp never moves
    // (the step decouples the pin from render-noise call ordering). A
    // per-file re-stamp would move the origin past the mounted clock and
    // the suffix would fall back to the face's 1s floor -- the 2s-or-more
    // assertions are the discriminator. The spy must outlive the act
    // flushes (the file-global restoreAllMocks runs after the test).
    let step = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (step += 2500));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    // File 1 in flight: the badge names it; the second IPC has not fired.
    // The badge carries the batch clock's elapsed suffix (ONE stamp per
    // batch -- the suffix survives the per-file badge swaps); the RUNNING
    // window locks the Add button (a second submission here would overwrite
    // the live badge), the button keeps its idle face (no spinner inside
    // it), the running face carries no dismiss (closing a live badge is the
    // vanished-state hole), and the empty card stays mounted -- hiding it
    // would bounce the layout between the card, the gap, and the list.
    expect(await screen.findByText(/正在添加 a\.csv（第 1\/2 个）/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/· (?:[2-9]|\d{2,})秒/);
    expect(await screen.findByText(/还没有数据集/)).toBeInTheDocument();
    const addBtn = screen.getByRole("button", { name: "添加数据集…" });
    expect(addBtn.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    expect(addBtn).toBeDisabled();
    expect(addWorkspaceDataset).toHaveBeenCalledTimes(1);
    await act(async () => {
      gates[0](entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" }));
    });
    expect(await screen.findByText(/正在添加 b\.csv（第 2\/2 个）/)).toBeInTheDocument();
    // File 2's window still reads off the batch stamp: the suffix holds 2s
    // or more (a per-file clock would read the 1s floor here).
    expect(screen.getByRole("status")).toHaveTextContent(/· (?:[2-9]|\d{2,})秒/);
    expect(addWorkspaceDataset).toHaveBeenCalledTimes(2);
    // The RUNNING window locks the row actions too (the symmetric hole): a
    // replace fired here would overwrite the live add badge. File 2's IPC is
    // the distinguishing window -- replace.isPending is false there, so the
    // upload-window lock (not the mutation pendings) is what holds the row.
    expect(await screen.findByRole("button", { name: /^a/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /换源/ })).toBeDisabled();
    await act(async () => {
      gates[1](entry({ reference_name: "b", display_name: "b", source_path: "/src/b.csv" }));
    });
    // The done badge parks: the last LANDED file + the FROZEN total
    // duration. Done does not lock -- the Add button is live again.
    expect(await screen.findByText(/已添加 b\.csv/)).toBeInTheDocument();
    const badge = screen.getByText(/已添加 b\.csv/).closest("[data-slot='badge']")!;
    expect(badge).toHaveTextContent(ELAPSED_SUFFIX);
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeEnabled();
    // The done badge's third clear path (besides dismiss and the reopen
    // edge): the NEXT upload overwrites it -- the new running face replaces
    // the parked one the moment the picker lands a file.
    fireEvent.click(screen.getByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByText(/正在添加 c\.csv（第 1\/1 个）/)).toBeInTheDocument();
    expect(screen.queryByText(/已添加 b\.csv/)).not.toBeInTheDocument();
    await act(async () => {
      gates[2](entry({ reference_name: "c", display_name: "c", source_path: "/src/c.csv" }));
    });
    expect(await screen.findByText(/已添加 c\.csv/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByText(/已添加 c\.csv/)).not.toBeInTheDocument();
  });

  it("keeps the add batch running past a failed file -- the banner names it, the done face never does", async () => {
    // The `.catch(() => {})` over each `mutateAsync` is the documented
    // design: one bad file must not drop the remainder. The failure rides
    // TRAILING here (the good file lands first): "the last file that
    // landed" and "the last file attempted" only diverge in this order, and
    // the done face must name the landed one -- a failed file never reads
    // as added.
    vi.mocked(listWorkspaceDatasets)
      .mockResolvedValueOnce([])
      .mockResolvedValue([entry({ reference_name: "b", display_name: "b", source_path: "/src/b.csv" })]);
    vi.mocked(open).mockResolvedValue(["/src/b.csv", "/src/bad.csv"]);
    vi.mocked(addWorkspaceDataset).mockClear();
    let resolveGood!: (e: ListedWorkspaceDataset) => void;
    vi.mocked(addWorkspaceDataset)
      .mockImplementationOnce(
        () => new Promise<ListedWorkspaceDataset>((resolve) => { resolveGood = resolve; }),
      )
      .mockRejectedValueOnce({
        kind: "DataUnreadable",
        data: `Error when sniffing file "/src/bad.csv".`,
      });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    // The good file runs first; its gate holds the batch mid-flight.
    expect(await screen.findByText(/正在添加 b\.csv（第 1\/2 个）/)).toBeInTheDocument();
    expect(addWorkspaceDataset).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveGood(entry({ reference_name: "b", display_name: "b", source_path: "/src/b.csv" }));
    });
    // The trailing file's rejection lands on the banner...
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("无法解析该数据文件");
    // ...and the done badge names the LANDED file, never the failed one
    // (the banner above owns that face).
    expect(await screen.findByText(/已添加 b\.csv/)).toBeInTheDocument();
    expect(screen.queryByText(/已添加 bad\.csv/)).not.toBeInTheDocument();
  });

  it("parks a done badge after a replace settles -- the running window locks Add, done unlocks and dismisses", async () => {
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
    // A replace mints its own clock at the round-trip's entry; the suffix
    // rides the badge while it runs. The RUNNING window locks the Add
    // button -- a second submission here would overwrite the live badge.
    expect(screen.getByRole("status")).toHaveTextContent(ELAPSED_SUFFIX);
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeDisabled();
    await act(async () => {
      gates[0](entry({}));
    });
    // The done badge: the label + the frozen duration; the panel unlocks
    // (done does not lock) and the dismiss clears the badge.
    expect(await screen.findByText(/已替换 people/)).toBeInTheDocument();
    const badge = screen.getByText(/已替换 people/).closest("[data-slot='badge']")!;
    expect(badge).toHaveTextContent(ELAPSED_SUFFIX);
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByText(/已替换 people/)).not.toBeInTheDocument();
  });

  it("parks no done badge when the whole batch fails -- the banner owns the failure face", async () => {
    vi.mocked(listWorkspaceDatasets).mockResolvedValue([]);
    vi.mocked(open)
      .mockResolvedValueOnce(["/src/bad.csv"])
      .mockResolvedValue(["/src/good.csv"]);
    vi.mocked(addWorkspaceDataset).mockClear();
    vi.mocked(addWorkspaceDataset)
      .mockRejectedValueOnce({
        kind: "DataUnreadable",
        data: `Error when sniffing file "/src/bad.csv".`,
      })
      .mockResolvedValue(entry({ reference_name: "good", display_name: "good", source_path: "/src/good.csv" }));
    renderPanel();
    // The on-site face stays the banner alone (#1490): a failure landing on
    // the panel that minted the batch never fires a toast -- the two faces
    // must not double-narrate one failure. The spy clears up front so the
    // assertion covers the whole test window (failure and the retry below).
    vi.mocked(toast).mockClear();
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法解析该数据文件");
    // Neither face parks: the running badge cleared with its batch, and no
    // done badge ever minted -- "added" must stay a true statement.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/已添加/)).not.toBeInTheDocument();
    // The unlock follows: the failed window is over, the Add button is live.
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeEnabled();
    // A retry that succeeds clears the stale banner on fire (the same
    // clear-on-fire posture the row mutations carry): the fresh done face
    // must not sit beside the old failure.
    fireEvent.click(screen.getByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByText(/已添加 good\.csv/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("keeps a running badge across close/reopen; the done badge still clears on the open edge", async () => {
    // The panel stays mounted across close/reopen (the sidebar only nulls
    // the workspace prop), so the upload loop keeps running with the panel
    // closed. The open edge must therefore NOT clear a RUNNING badge -- its
    // IPC is still in flight and the badge is its only face -- while a DONE
    // badge is the previous session's residue and joins the cleanup.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const bound = (ws: { path: string; label: string } | null) => (
      <QueryClientProvider client={client}>
        {withIntl(<WorkspaceDatasetsDialog workspace={ws} onOpenChange={() => {}} />)}
      </QueryClientProvider>
    );
    seed([]);
    vi.mocked(open).mockResolvedValue("/src/a.csv");
    vi.mocked(addWorkspaceDataset).mockClear();
    let resolveAdd!: (e: ListedWorkspaceDataset) => void;
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { resolveAdd = resolve; }),
    );
    const view = render(bound({ path: "/ws", label: "Demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByText(/正在添加 a\.csv/)).toBeInTheDocument();
    // Close and reopen while the upload runs: the badge survives the edge.
    view.rerender(bound(null));
    view.rerender(bound({ path: "/ws", label: "Demo" }));
    expect(screen.getByText(/正在添加 a\.csv/)).toBeInTheDocument();
    // Settle: the done badge parks -- and a second reopen clears it.
    await act(async () => {
      resolveAdd(entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" }));
    });
    expect(await screen.findByText(/已添加 a\.csv/)).toBeInTheDocument();
    view.rerender(bound(null));
    view.rerender(bound({ path: "/ws", label: "Demo" }));
    expect(screen.queryByText(/已添加 a\.csv/)).not.toBeInTheDocument();
  });

  it("a mid-batch rebind never retargets the files that have not fired yet", async () => {
    // #1491: the add loop resolves its target from the LIVE panel state at
    // each call (TanStack builds the mutation from the latest options), so
    // opening another workspace's panel mid-batch would land the remaining
    // files in the wrong manifest. The batch's target must be pinned at
    // mint -- every file rides the workspace the panel showed at the click.
    // All defaults ride the constructor (setDefaultOptions replaces the
    // whole object, so a later call would drop the retry pins); the
    // staleTime Infinity mirror makes the invalidation the ONLY refetch
    // trigger, so the reopen assertion below pins the invalidate target
    // rather than key-switch noise.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    const bound = (ws: { path: string; label: string } | null) => (
      <QueryClientProvider client={client}>
        {withIntl(<WorkspaceDatasetsDialog workspace={ws} onOpenChange={() => {}} />)}
      </QueryClientProvider>
    );
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/a.csv", "/src/b.csv"]);
    let releaseFirst!: (e: ListedWorkspaceDataset) => void;
    const firstInFlight = new Promise<ListedWorkspaceDataset>((resolve) => {
      releaseFirst = resolve;
    });
    // The add mock carries the prior tests' call records (mockClear is the
    // file's per-consumer convention); the batch's own two calls must be the
    // only ones on the books.
    vi.mocked(addWorkspaceDataset).mockClear();
    vi.mocked(addWorkspaceDataset)
      .mockImplementationOnce(() => firstInFlight)
      .mockResolvedValueOnce(
        entry({ reference_name: "b", display_name: "b", source_path: "/src/b.csv" }),
      );
    const view = render(bound({ path: "/ws", label: "Demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByText(/正在添加 a\.csv/)).toBeInTheDocument();
    // File 1 still in flight: close the panel and open ANOTHER workspace's
    // -- the #1491 repro. The remaining file must keep landing in /ws.
    view.rerender(bound(null));
    view.rerender(bound({ path: "/other", label: "Other" }));
    await act(async () => {
      releaseFirst(entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" }));
    });
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(addWorkspaceDataset).mock.calls.map((call) => call[0]),
    ).toEqual(["/ws", "/ws"]);
    // The criterion's other half: the origin's listing is invalidated, so
    // reopening the home panel refetches it (staleTime Infinity makes the
    // invalidation the only refetch trigger -- a miss leaves the origin's
    // reopen without the new rows).
    const before = vi.mocked(listWorkspaceDatasets).mock.calls.length;
    view.rerender(bound(null));
    view.rerender(bound({ path: "/ws", label: "Demo" }));
    await waitFor(() =>
      expect(vi.mocked(listWorkspaceDatasets).mock.calls.length).toBeGreaterThan(
        before,
      ),
    );
    expect(vi.mocked(listWorkspaceDatasets).mock.calls.at(-1)).toEqual(["/ws"]);
  });

  it("a foreign running badge neither narrates nor locks a panel opened on another workspace", async () => {
    // #1491's sibling face: the badge and the Add lock are component state,
    // so a panel reopened on another workspace would narrate (and lock for)
    // a batch it does not own. The badge must follow its batch's workspace:
    // silent on the foreign panel, back on its home panel's reopen.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const bound = (ws: { path: string; label: string } | null) => (
      <QueryClientProvider client={client}>
        {withIntl(<WorkspaceDatasetsDialog workspace={ws} onOpenChange={() => {}} />)}
      </QueryClientProvider>
    );
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/a.csv", "/src/b.csv"]);
    // Never settled: the batch stays in flight for the test's whole life;
    // the cleanup unmounts the panel and the pending promise is simply
    // dropped (no rejection, nothing to flush).
    const inFlight = new Promise<ListedWorkspaceDataset>(() => {});
    vi.mocked(addWorkspaceDataset).mockImplementation(() => inFlight);
    const view = render(bound({ path: "/ws", label: "Demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByText(/正在添加 a\.csv/)).toBeInTheDocument();
    // Rebind to another workspace mid-flight: no badge face, no Add lock.
    view.rerender(bound(null));
    view.rerender(bound({ path: "/other", label: "Other" }));
    await waitFor(() =>
      expect(screen.queryByText(/正在添加 a\.csv/)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeEnabled();
    // The home panel's reopen restores its batch's narration.
    view.rerender(bound(null));
    view.rerender(bound({ path: "/ws", label: "Demo" }));
    expect(await screen.findByText(/正在添加 a\.csv/)).toBeInTheDocument();
  });

  it("an add failure landing while the panel is closed fires a destructive toast naming the origin workspace", async () => {
    // #1490's closed-panel variant: the banner renders only while the panel
    // does, so a batch failing after the sidebar nulled the workspace prop
    // would vanish unread -- the reopen edge would destroy the error state
    // before it ever rendered. Offsite, the failure changes faces: the
    // toast carries it, attributed to the workspace that minted the batch.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const bound = (ws: { path: string; label: string } | null) => (
      <QueryClientProvider client={client}>
        {withIntl(<WorkspaceDatasetsDialog workspace={ws} onOpenChange={() => {}} />)}
      </QueryClientProvider>
    );
    seed([]);
    vi.mocked(open).mockResolvedValue("/src/a.csv");
    vi.mocked(addWorkspaceDataset).mockClear();
    let rejectAdd!: (e: unknown) => void;
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_resolve, reject) => { rejectAdd = reject; }),
    );
    vi.mocked(toast).mockClear();
    const view = render(bound({ path: "/ws", label: "Demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByText(/正在添加 a\.csv/)).toBeInTheDocument();
    // Close while the upload runs; the failure lands with no panel present.
    view.rerender(bound(null));
    await act(async () => {
      rejectAdd({ kind: "DataUnreadable", data: `Error when sniffing file "/src/a.csv".` });
    });
    // Destructive, attributed to the origin workspace by name, the banner's
    // detail sentence riding as the description.
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      variant: "destructive",
      title: "上传到 Demo 失败",
      description: expect.stringContaining("无法解析该数据文件"),
    });
    // No double surface: the panel state never took the error, so the
    // reopen edge has nothing to destroy -- no banner greets the reopen.
    view.rerender(bound({ path: "/ws", label: "Demo" }));
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeInTheDocument();
  });

  it("an add failure landing on a rebound panel fires the toast attributed to the origin workspace, the foreign panel stays clean", async () => {
    // #1493's rebind variant shares the routing: the shared error state has
    // no workspace attribution, so the banner would narrate a Demo failure
    // on Other's panel and the reopen edge would then destroy it unread.
    // The toast names the origin; the foreign panel takes nothing.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const bound = (ws: { path: string; label: string } | null) => (
      <QueryClientProvider client={client}>
        {withIntl(<WorkspaceDatasetsDialog workspace={ws} onOpenChange={() => {}} />)}
      </QueryClientProvider>
    );
    seed([]);
    vi.mocked(open).mockResolvedValue("/src/a.csv");
    vi.mocked(addWorkspaceDataset).mockClear();
    let rejectAdd!: (e: unknown) => void;
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_resolve, reject) => { rejectAdd = reject; }),
    );
    vi.mocked(toast).mockClear();
    const view = render(bound({ path: "/ws", label: "Demo" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    expect(await screen.findByText(/正在添加 a\.csv/)).toBeInTheDocument();
    // Rebind mid-flight; the failure lands on the foreign panel's watch.
    view.rerender(bound(null));
    view.rerender(bound({ path: "/other", label: "Other" }));
    await act(async () => {
      rejectAdd({ kind: "Io", data: "disk full" });
    });
    // The Io echo rides verbatim as the description; the attribution names
    // Demo, not the panel the user is looking at.
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      variant: "destructive",
      title: "上传到 Demo 失败",
      description: "disk full",
    });
    // The foreign panel's error state is untouched, and the origin's
    // reopen is equally clean (the failure was delivered, not stored).
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.rerender(bound(null));
    view.rerender(bound({ path: "/ws", label: "Demo" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
