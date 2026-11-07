import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// The panel's render contract (#1519): this component is the consumer
// shell -- the seam module (useWorkspaceDatasets) owns the mutations, the
// batch machine, and the pending facts, so the suite mocks THE MODULE
// INTERFACE (the seven-api-function surface the pre-seam suite stubbed is
// gone) and pins what renders from the snapshot: the master/detail shell,
// the badge faces, the banners, the action wiring, and the locks. The
// module's behavioral contract (badge state machine, failure routing,
// per-workspace identity) lives in useWorkspaceDatasets.test.tsx.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../useWorkspaceDatasets", () => ({
  useWorkspaceDatasets: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    previewDeleteImpact: vi.fn(),
  };
});

import { previewDeleteImpact } from "../../api";
import { WorkspaceDatasetsDialog } from "../WorkspaceDatasetsDialog";
import { useWorkspaceDatasets, type UseWorkspaceDatasets } from "../useWorkspaceDatasets";
import { withIntl } from "../../components/common/__tests__/helpers";
import type { ListedWorkspaceDataset } from "../../types/workspace-datasets";

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

// The module stub: a full UseWorkspaceDatasets snapshot with spy actions,
// per-test overridden through the returned fields. Every test seeds its own
// stub before render.
function stubModule(overrides: Partial<UseWorkspaceDatasets> = {}) {
  const actions = {
    pickAndAdd: vi.fn(),
    rename: vi.fn(),
    replace: vi.fn(),
    remove: vi.fn(),
    setPrivacy: vi.fn(),
    select: vi.fn(),
    dismissBadge: vi.fn(),
    setError: vi.fn(),
  };
  const value: UseWorkspaceDatasets = {
    panel: { path: "/ws", label: "Demo" },
    rows: [],
    listingPending: false,
    listingError: null,
    resolvedName: null,
    shown: null,
    missingNames: new Set<string>(),
    error: null,
    setError: actions.setError,
    selectedName: null,
    select: actions.select,
    badge: null,
    dismissBadge: actions.dismissBadge,
    busy: false,
    privacyBusy: false,
    pickAndAdd: actions.pickAndAdd,
    rename: actions.rename,
    replace: actions.replace,
    remove: actions.remove,
    setPrivacy: actions.setPrivacy,
    ...overrides,
  };
  vi.mocked(useWorkspaceDatasets).mockReturnValue(value);
  return { actions };
}

// The panel mounts bound to the demo workspace in every test, so the
// element is fixed.
function renderPanel() {
  return render(
    withIntl(
      <WorkspaceDatasetsDialog workspace={{ path: "/ws", label: "Demo" }} onOpenChange={() => {}} />,
    ),
  );
}

describe("WorkspaceDatasetsDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(useWorkspaceDatasets).mockReset();
  });

  it("renders the master/detail shell: both rows list, the first entry's detail shows with the frozen sample", async () => {
    const rows = [
      entry({}),
      entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" }),
    ];
    stubModule({ rows, resolvedName: "people", shown: rows[0] });
    renderPanel();
    // Both rows list (the select button's accessible name starts with the
    // display label -- the WorkingSetList.test anchor convention).
    expect(await screen.findByRole("button", { name: /^people/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^orders/ })).toBeInTheDocument();
    // The detail pane shows the resolved pick: its heading, its schema, and
    // its frozen manifest sample. Column names render in the schema, sample
    // AND privacy tables -- anchor within the DOM-ordered tables (schema,
    // then sample) instead of a bare text match.
    expect(screen.getByRole("heading", { name: /^people/ })).toBeInTheDocument();
    const tables = screen.getAllByRole("table");
    expect(within(tables[0]).getByText("VARCHAR")).toBeInTheDocument();
    expect(within(tables[1]).getByText("Ada")).toBeInTheDocument();
    expect(screen.getByText(/引用名：people/)).toBeInTheDocument();
  });

  it("routes a row pick through the seam's select", async () => {
    const rows = [
      entry({}),
      entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" }),
    ];
    const { actions } = stubModule({
      rows,
      resolvedName: "people",
      shown: rows[0],
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /^orders/ }));
    expect(actions.select).toHaveBeenCalledWith("orders");
  });

  it("renames through the row dialog and the seam carries the new display label", async () => {
    const { actions } = stubModule({ rows: [entry({})], resolvedName: "people", shown: entry({}) });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /重命名/ }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Folks" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(actions.rename).toHaveBeenCalledWith("people", "Folks");
  });

  it("renders the seam's error message as the panel banner", async () => {
    stubModule({ rows: [entry({})], resolvedName: "people", shown: entry({}), error: "显示名 orders 已被占用" });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("显示名 orders 已被占用");
  });

  it("replace rides the row action to the seam's replace", async () => {
    const { actions } = stubModule({ rows: [entry({})], resolvedName: "people", shown: entry({}) });
    // The row's replace channel is the Tauri picker; the stub hands back a
    // chosen path (WorkingSetList routes onReplace only with a file).
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("/src/people_v2.csv");
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /换源/ }));
    // The picker's promise must flush before the routing assertion.
    await waitFor(() => expect(actions.replace).toHaveBeenCalledWith("people", "/src/people_v2.csv"));
  });

  it("the delete confirm names the workspace and routes the remove -- no session impact preview", async () => {
    const { actions } = stubModule({ rows: [entry({})], resolvedName: "people", shown: entry({}) });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /删除/ }));
    // The workspace override copy (never "working set"), and the confirm
    // renders without the session-scoped impact preview.
    const confirm = screen.getAllByRole("alertdialog").at(-1)!;
    expect(confirm).toHaveTextContent("从此工作区移除 people？");
    expect(previewDeleteImpact).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));
    expect(actions.remove).toHaveBeenCalledWith("people");
  });

  it("flags a missing store file in the list and warns above the fully-rendered detail", async () => {
    const row = entry({ file_missing: true });
    stubModule({ rows: [row], resolvedName: "people", shown: row, missingNames: new Set(["people"]) });
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

  it("the privacy toggle routes the whole-replace through the seam", async () => {
    const { actions } = stubModule({ rows: [entry({})], resolvedName: "people", shown: entry({}) });
    renderPanel();
    fireEvent.click(await screen.findByLabelText(/发送样本值/));
    expect(actions.setPrivacy).toHaveBeenCalledWith("people", {
      send_samples: false,
      type_only_columns: [],
    });
  });

  it("an empty manifest renders the single empty card, not the two-column shell", async () => {
    stubModule({ rows: [] });
    renderPanel();
    expect(await screen.findByText(/还没有数据集/)).toBeInTheDocument();
    expect(screen.queryByText(/^数据集 · /)).not.toBeInTheDocument();
    // No rows, no detail pane: the empty card is the only section.
    expect(screen.queryByRole("button", { name: /^people/ })).not.toBeInTheDocument();
  });

  it("renders a renamed label across the row, the heading and the delete confirm; the reference name stays the anchor line", async () => {
    const row = entry({ display_name: "Folks" });
    stubModule({ rows: [row], resolvedName: "people", shown: row });
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

  it("locks the row actions while the seam reports busy", async () => {
    stubModule({ rows: [entry({})], resolvedName: "people", shown: entry({}), busy: true });
    renderPanel();
    // busy rides the loading prop: the row's rename / replace / delete lock.
    expect(await screen.findByRole("button", { name: /重命名/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /换源/ })).toBeDisabled();
  });

  it("renders neither face when the listing itself fails -- the banner is the face", async () => {
    stubModule({
      rows: [],
      listingError: { kind: "ManifestCorrupt", data: "datasets.json" },
    });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/已损坏/);
    // No empty card asserting an empty workspace, no two-column shell: the
    // refusal is the face, and an Add it would refuse is not invited.
    expect(screen.queryByText(/还没有数据集/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^数据集 · /)).not.toBeInTheDocument();
  });

  it("renders the running badge with the elapsed suffix and locks Add; no dismiss while running", async () => {
    const { actions } = stubModule({
      rows: [],
      badge: { phase: "running", mode: "add", name: "a.csv", index: 1, total: 2, startedAt: 1_000 },
    });
    renderPanel();
    expect(await screen.findByText(/正在添加 a\.csv（第 1\/2 个）/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "关闭" })).not.toBeInTheDocument();
    expect(actions.pickAndAdd).not.toHaveBeenCalled();
  });

  it("parks the done badge with the frozen duration; dismiss routes through the seam", async () => {
    const { actions } = stubModule({
      rows: [],
      badge: { phase: "done", mode: "replace", name: "people", seconds: 42 },
    });
    renderPanel();
    expect(await screen.findByText(/已替换 people/)).toBeInTheDocument();
    // Done does not lock -- the Add button is live.
    expect(screen.getByRole("button", { name: "添加数据集…" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(actions.dismissBadge).toHaveBeenCalledTimes(1);
  });

  it("spins the detail's privacy toggle while the seam reports privacyBusy", async () => {
    stubModule({ rows: [entry({})], resolvedName: "people", shown: entry({}), privacyBusy: true });
    renderPanel();
    expect(await screen.findByLabelText(/发送样本值/)).toBeDisabled();
  });

  it("routes the Add button through the seam's pickAndAdd", async () => {
    const { actions } = stubModule({ rows: [] });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "添加数据集…" }));
    expect(actions.pickAndAdd).toHaveBeenCalledTimes(1);
  });
});
