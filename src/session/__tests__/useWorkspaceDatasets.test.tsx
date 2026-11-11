import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The seam's contract pins (#1519): the invariants the four hand-written
// copies previously synced by long comments, now structural inside
// useWorkspaceDatasets -- the ONE batch clock, the frozen settle face, the
// failure routing by where the panel stands at settle time, and the
// per-workspace flight counters (the identity gate the mutationCache scan
// used to approximate). Tests drive the hook interface (the
// useWorkingSet.test posture); the render contract stays with the panel.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("../../components/ui/use-toast", () => ({
  useToast: () => ({ toasts: [], toast: vi.fn(), dismiss: vi.fn() }),
  toast: vi.fn(),
}));

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
    previewWorkspaceDataset: vi.fn(),
    addWorkspaceDatasetGuided: vi.fn(),
    workspaceDatasetPreviewWindow: vi.fn(),
    discardWorkspaceDatasetPreview: vi.fn(),
  };
});

import {
  addWorkspaceDataset,
  addWorkspaceDatasetGuided,
  discardWorkspaceDatasetPreview,
  listWorkspaceDatasets,
  previewWorkspaceDataset,
  removeWorkspaceDataset,
  renameWorkspaceDataset,
  replaceWorkspaceDataset,
  setWorkspaceDatasetPrivacy,
} from "../../api";
import { toast } from "../../components/ui/use-toast";
import { open } from "@tauri-apps/plugin-dialog";
import { withIntl } from "../../components/common/__tests__/helpers";
import { useWorkspaceDatasets } from "../useWorkspaceDatasets";
import type { GuidanceRequest, SheetGuidance } from "../../types/dataset";
import type { ListedWorkspaceDataset } from "../../types/workspace-datasets";

const WS = { path: "/ws", label: "Demo" };
const OTHER = { path: "/other", label: "Other" };

function entry(overrides: Partial<ListedWorkspaceDataset>): ListedWorkspaceDataset {
  return {
    reference_name: "people",
    display_name: "people",
    fingerprint: "f".repeat(64),
    size_bytes: 0,
    columns: [{ name: "name", canonical_type: "VARCHAR" }],
    row_count: 2,
    sample: [["Ada", "9"]],
    privacy: { send_samples: true, type_only_columns: [] },
    source_path: "/src/people.csv",
    file_missing: false,
    ...overrides,
  };
}

// The guided Excel import's wire shapes (issue #1552): one auto-tidied
// sheet, the user's acceptance for it.
function guidanceRequest(): GuidanceRequest {
  return {
    source_path: "/src/book.xlsx",
    workbook_name: "book",
    sheets: [
      {
        name: "People",
        preview: [["name", "score"]],
        total_rows: 2,
        state: { kind: "AutoTidied", data: { header_row: 1 } },
      },
    ],
  };
}

const ACCEPT_PEOPLE: SheetGuidance[] = [
  { name: "People", rectify: { header_row: 1, skip_rows: [] } },
];

function setup() {
  const queryClient = new QueryClient({
    // The staleTime Infinity mirror (#1491/#1492): the mutations'
    // invalidation is the ONLY refetch trigger, so an invalidate-target
    // assertion cannot be faked green by key-switch noise.
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{withIntl(children as ReactElement)}</QueryClientProvider>
  );
  // The prop type is explicit: inference from initialProps would drop the
  // null member, and the rebind/close rerenders below pass null. RTL's
  // renderHook generics are <Result, Props> -- in that order.
  const view = renderHook<
    ReturnType<typeof useWorkspaceDatasets>,
    Parameters<typeof useWorkspaceDatasets>[0]
  >((ws) => useWorkspaceDatasets(ws), {
    wrapper,
    initialProps: WS,
  });
  return { ...view, queryClient, invalidateSpy };
}

// Listings must resolve before the snapshot's rows are meaningful; every
// test seeds its own impl and awaits the load.
function seed(rows: ListedWorkspaceDataset[]) {
  vi.mocked(listWorkspaceDatasets).mockResolvedValue(rows);
}

// A fire-and-forget launch: a gated batch never returns inside the act that
// started it -- the flight is started, then the test drives its gates.
function launch(result: { current: { pickAndAdd: () => Promise<void> } }) {
  let flight!: Promise<void>;
  act(() => {
    flight = result.current.pickAndAdd();
  });
  return flight;
}

// An in-flight gate: the mock parks every call; the test resolves by call
// index (a multi-file batch parks once per file). The wrapper reads the
// CURRENT resolver array -- each call mints its resolve at call time.
function gateAdd(): (i: number, e: ListedWorkspaceDataset) => void {
  const gates = gateAddPerFile();
  return (i, e) => gates[i].resolve(e);
}

// A per-file settle gate: the same per-call parking, but each file's gate
// settles in EITHER direction -- the single-captured reject variable does
// not scale past one file, and a whole-failed batch must be driven file by
// file (each gate settles exactly once: resolve XOR reject).
type AddGate = {
  resolve: (e: ListedWorkspaceDataset) => void;
  reject: (e: unknown) => void;
};

function gateAddPerFile(): AddGate[] {
  const gates: AddGate[] = [];
  vi.mocked(addWorkspaceDataset).mockImplementation(
    () => new Promise<ListedWorkspaceDataset>((resolve, reject) => { gates.push({ resolve, reject }); }),
  );
  return gates;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // The Date.now spies must not leak into the next test's clock.
  vi.restoreAllMocks();
});

describe("useWorkspaceDatasets contract", () => {
  it("mints ONE clock per add batch: every per-file badge reuses the entry stamp", async () => {
    // The per-file clock would visibly reset on each file (issue #1485);
    // the entry stamp must hold across the whole batch.
    let step = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (step += 2500));
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/a.csv", "/src/b.csv"]);
    const resolveFirst = gateAdd();
    const { result } = setup();
    const flight = launch(result);
    // The resolver is minted when the mock is FIRST CALLED (the badge write
    // rides ahead of the IPC), so the wait anchors on the call, not the badge.
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    const firstStamp = result.current.badge?.phase === "running" ? result.current.badge.startedAt : -1;
    await act(async () => {
      resolveFirst(0, entry({ reference_name: "a" }));
    });
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(2));
    expect(result.current.badge?.phase).toBe("running");
    const secondStamp = result.current.badge?.phase === "running" ? result.current.badge.startedAt : -1;
    await act(async () => {
      resolveFirst(1, entry({ reference_name: "b" }));
    });
    await act(async () => {
      await flight;
    });
    // The settle face froze the batch's total duration. The EXACT number is
    // unanchorable here -- RTL's waitFor deadline loop is itself a Date.now
    // consumer, so the step count between entry and settle varies -- but the
    // SHAPE pin (done carries seconds, not a live stamp) plus the monotonic
    // floor (settle read strictly after the 2.5s entry tick) is the freeze:
    // an implementation that re-read the clock per render would drift this
    // badge's stored shape or read zero.
    const doneBadge = result.current.badge;
    expect(doneBadge).toMatchObject({ phase: "done", mode: "add", name: "b.csv" });
    expect(doneBadge?.phase === "done" && doneBadge.seconds).toBeGreaterThanOrEqual(1);
    expect(firstStamp).toBeGreaterThan(0);
    expect(secondStamp).toBe(firstStamp);
  });

  it("a failed file never reads as added: a whole-failed batch parks no badge, a trailing failure names the landed one", async () => {
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/bad.csv"]);
    vi.mocked(addWorkspaceDataset).mockRejectedValue({
      kind: "DataUnreadable",
      data: `Error when sniffing file "/src/bad.csv".`,
    });
    const { result } = setup();
    await act(async () => {
      await result.current.pickAndAdd();
    });
    expect(result.current.badge).toBeNull();
    expect(result.current.error).toContain("无法解析该数据文件");
    // The engine string rides along for triage -- #1483's second half.
    expect(result.current.error).toContain("Error when sniffing");
    // A trailing failure after a landed file: the done face names the
    // LANDED file (the banner owns the failure face).
    vi.mocked(open).mockResolvedValue(["/src/good.csv", "/src/bad.csv"]);
    vi.mocked(addWorkspaceDataset)
      .mockResolvedValueOnce(entry({ reference_name: "good", display_name: "good", source_path: "/src/good.csv" }))
      .mockRejectedValueOnce({ kind: "Io", data: "disk full" });
    await act(async () => {
      await result.current.pickAndAdd();
    });
    expect(result.current.badge).toEqual({
      phase: "done",
      mode: "add",
      name: "good.csv",
      seconds: expect.any(Number),
    });
  });

  it("routes an add failure by where the panel stands at settle time: on-site banner, closed toast, rebind toast", async () => {
    seed([]);
    vi.mocked(toast).mockClear();
    const { result, rerender } = setup();
    // On-site (the panel still shows the origin at settle): the banner owns
    // the face, no toast -- one failure, one face.
    vi.mocked(open).mockResolvedValue("/src/a.csv");
    let rejectAdd!: (e: unknown) => void;
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_r, reject) => { rejectAdd = reject; }),
    );
    const flight1 = launch(result);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      rejectAdd({ kind: "Io", data: "disk full" });
    });
    await act(async () => {
      await flight1;
    });
    expect(result.current.error).toBe("disk full");
    expect(toast).not.toHaveBeenCalled();
    // Closed at settle: the toast carries the failure attributed to the
    // origin; the error state stays clean (the reopen edge has nothing to
    // destroy unread).
    vi.mocked(addWorkspaceDataset).mockClear();
    let rejectAdd2!: (e: unknown) => void;
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_r, reject) => { rejectAdd2 = reject; }),
    );
    rerender(null);
    const flight2 = launch(result);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      rejectAdd2({ kind: "Io", data: "disk full" });
    });
    await act(async () => {
      await flight2;
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      variant: "destructive",
      title: "上传到 Demo 失败",
      description: "disk full",
    });
    expect(result.current.error).toBeNull();
    // Rebound at settle: fired on the origin, then the panel rebinds before
    // the failure lands -- same toast routing (a from-the-foreign-panel fire
    // would settle "on site" and take the banner, by design).
    vi.mocked(addWorkspaceDataset).mockClear();
    let rejectAdd3!: (e: unknown) => void;
    vi.mocked(addWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_r, reject) => { rejectAdd3 = reject; }),
    );
    rerender(WS);
    const flight3 = launch(result);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    rerender(OTHER);
    await act(async () => {
      rejectAdd3({ kind: "Io", data: "disk full" });
    });
    await act(async () => {
      await flight3;
    });
    expect(toast).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it("a whole-failed multi-file batch keeps the faces' granularity: one banner (last failure) on site, one toast per file offsite", async () => {
    // #1497: every failure-matrix test was single-file before -- a dedupe
    // or per-batch aggregation refactor could silently collapse the offsite
    // per-file face (or fan out the on-site banner) with nothing red. Both
    // directions are pinned here: on site the banner holds only the LAST
    // failure (the batch's continued write), offsite each failed file fires
    // its own toast, attributed to the origin, with its own description.
    seed([]);
    vi.mocked(toast).mockClear();
    vi.mocked(open).mockResolvedValue(["/src/a.csv", "/src/b.csv"]);
    const gates = gateAddPerFile();
    const { result, rerender } = setup();
    const flight = launch(result);
    // On site: both failures land on the banner, the second overwrites the
    // first -- one face, last failure wins, no toast.
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      gates[0].reject({ kind: "Io", data: "disk full on a" });
    });
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(2));
    await act(async () => {
      gates[1].reject({ kind: "Io", data: "disk full on b" });
    });
    await act(async () => {
      await flight;
    });
    expect(result.current.error).toBe("disk full on b");
    expect(toast).not.toHaveBeenCalled();
    // Closed at settle: each failed file fires its own destructive toast,
    // the title attributes the origin workspace, the descriptions stay
    // per-file (distinct) -- the granularity the aggregation refactor would
    // flatten into one toast. The banner never carries an offsite failure,
    // and a whole-failed batch parks no badge across the reopen edge.
    vi.mocked(toast).mockClear();
    vi.mocked(addWorkspaceDataset).mockClear();
    const closedGates = gateAddPerFile();
    rerender(null);
    const closedFlight = launch(result);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      closedGates[0].reject({ kind: "Io", data: "disk full on a" });
    });
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(2));
    await act(async () => {
      closedGates[1].reject({ kind: "Io", data: "disk full on b" });
    });
    await act(async () => {
      await closedFlight;
    });
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenNthCalledWith(1, {
      variant: "destructive",
      title: "上传到 Demo 失败",
      description: "disk full on a",
    });
    expect(toast).toHaveBeenNthCalledWith(2, {
      variant: "destructive",
      title: "上传到 Demo 失败",
      description: "disk full on b",
    });
    expect(result.current.error).toBeNull();
    rerender(WS);
    expect(result.current.badge).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("a partially landed batch settling offsite keeps both legs: the landed file invalidates the origin, the failed file fires the toast", async () => {
    // #1497's combination cell: one file lands, one fails, the panel left
    // the origin mid-batch. The landed leg's invalidation still targets the
    // MINTED workspace's listing (the rebind-retarget pin's combination
    // face), and the failed leg's toast still delivers -- neither leg may
    // suppress the other.
    seed([]);
    vi.mocked(toast).mockClear();
    vi.mocked(open).mockResolvedValue(["/src/good.csv", "/src/bad.csv"]);
    const gates = gateAddPerFile();
    const { result, rerender, invalidateSpy } = setup();
    const flight = launch(result);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    rerender(OTHER);
    await act(async () => {
      gates[0].resolve(
        entry({ reference_name: "good", display_name: "good", source_path: "/src/good.csv" }),
      );
    });
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(2));
    await act(async () => {
      gates[1].reject({ kind: "Io", data: "disk full" });
    });
    await act(async () => {
      await flight;
    });
    // The landed leg: the origin's listing refreshed, never the foreign
    // panel's.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workspace-datasets", "/ws"] });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ["workspace-datasets", "/other"] });
    // The failed leg: one toast, attributed to the origin.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({
      variant: "destructive",
      title: "上传到 Demo 失败",
      description: "disk full",
    });
    // The offsite face: the banner stays clean.
    expect(result.current.error).toBeNull();
  });

  it("a row action's failure lands on the banner with the catalog wording", async () => {
    seed([entry({}), entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" })]);
    vi.mocked(renameWorkspaceDataset).mockRejectedValue({ kind: "DisplayTaken", data: "orders" });
    const { result } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => {
      result.current.rename("people", "orders");
    });
    await waitFor(() => expect(result.current.error).toBe("显示名 orders 已被占用"));
    // The same plain-banner posture for remove: a row failure takes no
    // router (the scope cut the module header records).
    vi.mocked(removeWorkspaceDataset).mockRejectedValue({ kind: "Io", data: "disk gone" });
    act(() => {
      result.current.remove("people");
    });
    await waitFor(() => expect(result.current.error).toBe("disk gone"));
  });

  it("the row lock counts per workspace: a foreign fire neither locks nor unlocks the home rows", async () => {
    // #1492's identity gate, now as module-internal facts: two concurrent
    // renames on different workspaces (the supersede scenario the minted-
    // variables cache scan guarded against) keep each workspace's lock
    // independent; settling both releases the home rows.
    seed([entry({})]);
    const resolvers: Array<(value: ListedWorkspaceDataset) => void> = [];
    vi.mocked(renameWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { resolvers.push(resolve); }),
    );
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      result.current.rename("people", "Folks");
    });
    expect(result.current.busy).toBe(true);
    rerender(OTHER);
    await waitFor(() => expect(result.current.busy).toBe(false));
    act(() => {
      result.current.rename("people", "Other Folks");
    });
    expect(result.current.busy).toBe(true);
    // Back home: its own flight still holds the lock.
    rerender(WS);
    expect(result.current.busy).toBe(true);
    await act(async () => {
      resolvers.forEach((resolve) => resolve(entry({})));
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
  });

  it("the privacy flight rides the row lock and its own spinner gate independently", async () => {
    seed([entry({})]);
    let resolvePrivacy!: (e: ListedWorkspaceDataset) => void;
    vi.mocked(setWorkspaceDatasetPrivacy).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { resolvePrivacy = resolve; }),
    );
    const { result } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      result.current.setPrivacy("people", { send_samples: false, type_only_columns: [] });
    });
    expect(result.current.privacyBusy).toBe(true);
    expect(result.current.busy).toBe(true);
    await act(async () => {
      resolvePrivacy(entry({}));
    });
    await waitFor(() => {
      expect(result.current.privacyBusy).toBe(false);
      expect(result.current.busy).toBe(false);
    });
  });

  it("binds the invalidation to the minted workspace: a settle on a rebind refreshes the origin, never the foreign panel", async () => {
    seed([entry({})]);
    let resolveReplace!: (e: ListedWorkspaceDataset) => void;
    vi.mocked(replaceWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { resolveReplace = resolve; }),
    );
    const { result, rerender, invalidateSpy } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    // The IPC target pins at fire time to the firing workspace.
    act(() => {
      result.current.replace("people", "/src/people_v2.csv");
    });
    await waitFor(() =>
      expect(replaceWorkspaceDataset).toHaveBeenCalledWith("/ws", "people", "/src/people_v2.csv"),
    );
    invalidateSpy.mockClear();
    rerender(OTHER);
    await act(async () => {
      resolveReplace(entry({}));
    });
    const targets = invalidateSpy.mock.calls.map((call) => (call[0] as { queryKey: readonly unknown[] }).queryKey);
    expect(targets).toContainEqual(["workspace-datasets", "/ws"]);
    expect(targets).not.toContainEqual(["workspace-datasets", "/other"]);
  });

  it("keeps a RUNNING badge across close/reopen; the open edge clears DONE, the error and the pick", async () => {
    seed([entry({})]);
    let resolveReplace!: (e: ListedWorkspaceDataset) => void;
    vi.mocked(replaceWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { resolveReplace = resolve; }),
    );
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      result.current.replace("people", "/src/people_v2.csv");
    });
    expect(result.current.badge?.phase).toBe("running");
    // Close and reopen while the replace flies: the badge survives the edge.
    rerender(null);
    rerender(WS);
    expect(result.current.badge?.phase).toBe("running");
    // Settle: the done badge parks; a second reopen clears it (a reopen is
    // a fresh working session).
    await act(async () => {
      resolveReplace(entry({}));
    });
    expect(result.current.badge?.phase).toBe("done");
    rerender(null);
    rerender(WS);
    expect(result.current.badge).toBeNull();
    // The open edge also clears the error and the detail pick.
    act(() => {
      result.current.setError("stale");
    });
    act(() => {
      result.current.select("people");
    });
    rerender(null);
    rerender(WS);
    expect(result.current.error).toBeNull();
    expect(result.current.selectedName).toBeNull();
  });

  it("a foreign badge neither narrates nor locks a panel opened on another workspace", async () => {
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/a.csv"]);
    const inFlight = new Promise<ListedWorkspaceDataset>(() => {});
    vi.mocked(addWorkspaceDataset).mockImplementation(() => inFlight);
    const { result, rerender } = setup();
    launch(result);
    await waitFor(() => expect(result.current.badge?.phase).toBe("running"));
    rerender(OTHER);
    expect(result.current.badge).toBeNull();
    expect(result.current.busy).toBe(false);
    rerender(WS);
    expect(result.current.badge?.phase).toBe("running");
    expect(result.current.busy).toBe(true);
  });

  it("resolves the detail pick with the deleted-pick fallback and derives the missing set", async () => {
    seed([
      entry({}),
      entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv", file_missing: true }),
    ]);
    const { result } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    // Unset pick resolves to the first row.
    expect(result.current.resolvedName).toBe("people");
    act(() => {
      result.current.select("orders");
    });
    expect(result.current.resolvedName).toBe("orders");
    expect(result.current.shown?.reference_name).toBe("orders");
    expect(result.current.missingNames).toEqual(new Set(["orders"]));
  });

  it("remove runs end to end: the invalidation targets the minted workspace, the refetch drops the row, and the deleted pick falls back", async () => {
    const people = entry({});
    const orders = entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" });
    // Two listing generations: the mount load sees both rows, the
    // post-invalidation refetch sees the picked row gone (staleTime
    // Infinity makes the mutation's invalidation the ONLY refetch trigger,
    // so the second call IS the remove's refetch -- dropping it would
    // leave the row rendered forever).
    vi.mocked(listWorkspaceDatasets)
      .mockResolvedValueOnce([people, orders])
      .mockResolvedValueOnce([people]);
    vi.mocked(removeWorkspaceDataset).mockResolvedValue(undefined);
    const { result, invalidateSpy } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => {
      result.current.select("orders");
    });
    expect(result.current.resolvedName).toBe("orders");
    act(() => {
      result.current.remove("orders");
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    // The deleted pick falls back to the remaining first row -- the
    // existence predicate in resolvedName (a bare selectedName read would
    // point at no row and blank the pane).
    expect(result.current.resolvedName).toBe("people");
    expect(result.current.shown?.reference_name).toBe("people");
    // The invalidation targeted the minted workspace's listing key.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workspace-datasets", "/ws"] });
  });

  it("picks the freshly added dataset on settle, only while the panel still shows the batch's workspace", async () => {
    // The settle-time pick gate (#1492): the last landed file becomes the
    // detail pick -- but a rebind would park the pick on another workspace's
    // panel, so the write only lands when the live panel is the origin.
    seed([]);
    vi.mocked(open).mockResolvedValue("/src/new.csv");
    const resolveAdd = gateAdd();
    const { result, rerender, invalidateSpy } = setup();
    launch(result);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    rerender(OTHER);
    await act(async () => {
      resolveAdd(0, entry({ reference_name: "new", display_name: "new", source_path: "/src/new.csv" }));
    });
    // Settled while the panel showed /other: no pick write on the foreign
    // panel, and the invalidation still targeted the MINTED workspace's
    // listing (the add leg of the replace pin above).
    expect(result.current.selectedName).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workspace-datasets", "/ws"] });
  });

  it("a mid-batch rebind never retargets the files that have not fired yet", async () => {
    // #1491: the batch's target freezes in the flight closure at fire time,
    // so opening another workspace's panel mid-batch must not land the
    // remaining files in the wrong manifest.
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/a.csv", "/src/b.csv"]);
    const resolveFirst = gateAdd();
    const { result, rerender } = setup();
    launch(result);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    rerender(null);
    rerender(OTHER);
    await act(async () => {
      resolveFirst(0, entry({ reference_name: "a", display_name: "a", source_path: "/src/a.csv" }));
    });
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(addWorkspaceDataset).mock.calls.map((call) => call[0]),
    ).toEqual(["/ws", "/ws"]);
    // The second gate stays parked: the batch promise is dropped at cleanup
    // (never settled -- nothing to flush), the dialog test's precedent.
  });

  it("concurrent replaces on two workspaces keep both RUNNING faces alive", async () => {
    // The keyed-badge map: two replaces may fly at once, and a single slot
    // would let the second fire erase the first's RUNNING face. Each flight
    // narrates on its own workspace's read.
    seed([entry({})]);
    const resolvers: Array<(e: ListedWorkspaceDataset) => void> = [];
    vi.mocked(replaceWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((resolve) => { resolvers.push(resolve); }),
    );
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      result.current.replace("people", "/src/people_v2.csv");
    });
    await waitFor(() => expect(replaceWorkspaceDataset).toHaveBeenCalledTimes(1));
    rerender(OTHER);
    act(() => {
      result.current.replace("orders", "/src/orders_v2.csv");
    });
    await waitFor(() => expect(replaceWorkspaceDataset).toHaveBeenCalledTimes(2));
    // The foreign fire holds its own face...
    expect(result.current.badge).toEqual({
      phase: "running",
      mode: "replace",
      name: "orders",
      startedAt: expect.any(Number),
    });
    // ...and the origin's survives it.
    rerender(WS);
    expect(result.current.badge).toEqual({
      phase: "running",
      mode: "replace",
      name: "people",
      startedAt: expect.any(Number),
    });
    await act(async () => {
      resolvers.forEach((resolve) => resolve(entry({})));
    });
  });

  it("the privacy spinner follows the firing workspace, not the live panel", async () => {
    seed([entry({})]);
    vi.mocked(setWorkspaceDatasetPrivacy).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>(() => {}),
    );
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      result.current.setPrivacy("people", { send_samples: false, type_only_columns: [] });
    });
    expect(result.current.privacyBusy).toBe(true);
    rerender(OTHER);
    expect(result.current.privacyBusy).toBe(false);
    rerender(WS);
    expect(result.current.privacyBusy).toBe(true);
  });

  it("clears the error banner the moment a retry fires, before the IPC settles", async () => {
    // Clear-on-fire: a stale refusal must not contradict a retry's visible
    // outcome.
    seed([entry({})]);
    vi.mocked(renameWorkspaceDataset)
      .mockRejectedValueOnce({ kind: "DisplayTaken", data: "orders" })
      .mockResolvedValue(entry({ display_name: "Folks" }));
    const { result } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      result.current.rename("people", "orders");
    });
    await waitFor(() => expect(result.current.error).toBe("显示名 orders 已被占用"));
    act(() => {
      result.current.rename("people", "Folks");
    });
    expect(result.current.error).toBeNull();
  });

  it("a replace failing offsite fires the destructive toast -- the banner would render nowhere", async () => {
    // The live hole (#1519): a replace is a minute-scale copy-in, and a
    // failure landing after the panel closed had no face -- the banner
    // renders nowhere while closed, and the reopen edge destroyed the
    // error state unread. Offsite (closed or rebound), the failure changes
    // faces: the destructive toast, attributed to the origin workspace;
    // on site, the banner stays the face.
    seed([entry({})]);
    vi.mocked(toast).mockClear();
    let rejectReplace!: (e: unknown) => void;
    vi.mocked(replaceWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_r, reject) => { rejectReplace = reject; }),
    );
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => {
      result.current.replace("people", "/src/people_v2.csv");
    });
    await waitFor(() => expect(replaceWorkspaceDataset).toHaveBeenCalledTimes(1));
    // Closed at settle: the toast carries the failure, the badge cleared
    // with its flight, and the error state stays clean (the reopen edge
    // has nothing to destroy unread).
    rerender(null);
    await act(async () => {
      rejectReplace({ kind: "Io", data: "disk full" });
    });
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      variant: "destructive",
      title: "在 Demo 中替换数据集失败",
      description: "disk full",
    });
    expect(result.current.badge).toBeNull();
    expect(result.current.error).toBeNull();
    // The reopen leg (the AC's named survivor): the panel comes back with
    // no residue -- the toast already delivered the failure, the open-edge
    // sweep has no banner to destroy unread and no badge to resurrect.
    rerender(WS);
    expect(result.current.badge).toBeNull();
    expect(result.current.error).toBeNull();
    // Rebound at settle: the same routing, the foreign panel stays clean.
    vi.mocked(replaceWorkspaceDataset).mockClear();
    let rejectReplace2!: (e: unknown) => void;
    vi.mocked(replaceWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_r, reject) => { rejectReplace2 = reject; }),
    );
    rerender(WS);
    act(() => {
      result.current.replace("people", "/src/people_v2.csv");
    });
    await waitFor(() => expect(replaceWorkspaceDataset).toHaveBeenCalledTimes(1));
    rerender(OTHER);
    await act(async () => {
      rejectReplace2({ kind: "Io", data: "disk full" });
    });
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(2));
    expect(result.current.error).toBeNull();
    // On site: the banner stays the face, no toast -- one failure, one face.
    vi.mocked(replaceWorkspaceDataset).mockClear();
    let rejectReplace3!: (e: unknown) => void;
    vi.mocked(replaceWorkspaceDataset).mockImplementation(
      () => new Promise<ListedWorkspaceDataset>((_r, reject) => { rejectReplace3 = reject; }),
    );
    rerender(WS);
    act(() => {
      result.current.replace("people", "/src/people_v2.csv");
    });
    await waitFor(() => expect(replaceWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      rejectReplace3({ kind: "Io", data: "disk full" });
    });
    await waitFor(() => expect(result.current.error).toBe("disk full"));
    expect(toast).toHaveBeenCalledTimes(2);
  });

  // The guided Excel import (issue #1552, ADR-0141 D11 as revised): the
  // batch PARKS an xlsx on the confirm dialog while the direct formats copy
  // straight in -- the session pane's #748 shape, minus the halt.
  it("parks an xlsx on the guided dialog, lands the checked sheets on submit, and continues the batch", async () => {
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/book.xlsx", "/src/b.csv"]);
    vi.mocked(previewWorkspaceDataset).mockResolvedValue(guidanceRequest());
    vi.mocked(addWorkspaceDatasetGuided).mockResolvedValue([
      entry({ reference_name: "People", display_name: "People", source_path: "/src/book.xlsx" }),
    ]);
    vi.mocked(addWorkspaceDataset).mockResolvedValue(entry({ reference_name: "b" }));
    const { result, invalidateSpy } = setup();
    const flight = launch(result);
    // The park: the preview IPC fires, the dialog state mounts, and the
    // plain add has NOT fired yet -- the batch waits underneath.
    await waitFor(() =>
      expect(previewWorkspaceDataset).toHaveBeenCalledWith("/ws", "/src/book.xlsx"),
    );
    expect(result.current.guidance?.path).toBe("/src/book.xlsx");
    expect(result.current.guidance?.workspace).toBe("/ws");
    expect(result.current.badge?.phase).toBe("running");
    expect(addWorkspaceDataset).not.toHaveBeenCalled();
    expect(addWorkspaceDatasetGuided).not.toHaveBeenCalled();
    // Submit: the checked sheets commit, the pick rides the last landed
    // sheet, the park resolves, and the queued remainder continues.
    await act(async () => {
      result.current.handleGuidedSubmit(ACCEPT_PEOPLE);
    });
    expect(addWorkspaceDatasetGuided).toHaveBeenCalledWith("/ws", "/src/book.xlsx", ACCEPT_PEOPLE);
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    expect(vi.mocked(addWorkspaceDataset).mock.calls[0][0]).toBe("/ws");
    await act(async () => {
      await flight;
    });
    expect(result.current.guidance).toBeNull();
    // The pick follows the batch's posture -- the LAST LANDED file wins
    // (the guided file's pick lands first, b.csv's lands after).
    expect(result.current.selectedName).toBe("b");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workspace-datasets", "/ws"] });
    // The done badge names the LAST LANDED file (b.csv -- the guided file
    // landed first), the batch's single-clock shape unchanged.
    expect(result.current.badge).toMatchObject({ phase: "done", mode: "add", name: "b.csv" });
  });

  it("cancel skips the parked file, discards the backend park, and the batch continues", async () => {
    seed([]);
    vi.mocked(open).mockResolvedValue(["/src/book.xlsx", "/src/b.csv"]);
    vi.mocked(previewWorkspaceDataset).mockResolvedValue(guidanceRequest());
    vi.mocked(addWorkspaceDataset).mockResolvedValue(entry({ reference_name: "b" }));
    vi.mocked(discardWorkspaceDatasetPreview).mockResolvedValue(undefined);
    const { result } = setup();
    const flight = launch(result);
    await waitFor(() => expect(previewWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      result.current.handleGuidedCancel();
    });
    expect(discardWorkspaceDatasetPreview).toHaveBeenCalledWith("/ws", "/src/book.xlsx");
    expect(result.current.guidance).toBeNull();
    // The skipped file never reads as added; the remainder still lands.
    await waitFor(() => expect(addWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      await flight;
    });
    expect(addWorkspaceDatasetGuided).not.toHaveBeenCalled();
    expect(result.current.badge).toMatchObject({ phase: "done", mode: "add", name: "b.csv" });
    expect(result.current.guidanceError).toBeNull();
  });

  it("a preview failure routes like any batch failure and the batch continues", async () => {
    seed([]);
    vi.mocked(toast).mockClear();
    vi.mocked(open).mockResolvedValue(["/src/book.xlsx", "/src/b.csv"]);
    vi.mocked(previewWorkspaceDataset).mockRejectedValue({ kind: "Io", data: "workbook gone" });
    vi.mocked(addWorkspaceDataset).mockResolvedValue(entry({ reference_name: "b" }));
    const { result } = setup();
    await act(async () => {
      await result.current.pickAndAdd();
    });
    // On site: the banner owns the face (describeError's Io body), no
    // dialog mounted, the plain file still landed.
    expect(result.current.error).toBe("workbook gone");
    expect(toast).not.toHaveBeenCalled();
    expect(result.current.guidance).toBeNull();
    expect(addWorkspaceDataset).toHaveBeenCalledTimes(1);
    expect(result.current.badge).toMatchObject({ phase: "done", mode: "add", name: "b.csv" });
  });

  it("a guided-submit failure keeps the dialog open with the inline error; a retry lands", async () => {
    // The session pane's #748 posture: the panel's banner sits behind the
    // modal scrim, so the failure renders INLINE (guidanceError) and the
    // park stays parked for a retry -- the backend parse survives for the
    // dialog's paging.
    seed([]);
    vi.mocked(open).mockResolvedValue("/src/book.xlsx");
    vi.mocked(previewWorkspaceDataset).mockResolvedValue(guidanceRequest());
    vi.mocked(addWorkspaceDatasetGuided)
      .mockRejectedValueOnce({ kind: "Io", data: "store disk full" })
      .mockResolvedValue([
        entry({ reference_name: "People", display_name: "People", source_path: "/src/book.xlsx" }),
      ]);
    const { result } = setup();
    const flight = launch(result);
    await waitFor(() => expect(previewWorkspaceDataset).toHaveBeenCalledTimes(1));
    await act(async () => {
      result.current.handleGuidedSubmit(ACCEPT_PEOPLE);
    });
    expect(result.current.guidanceError).toEqual({
      message: "store disk full",
      kind: "shell",
      detail: null,
    });
    expect(result.current.guidance).not.toBeNull();
    // Retry: the same handler re-fires, the commit lands, the park closes,
    // the batch settles.
    await act(async () => {
      result.current.handleGuidedSubmit(ACCEPT_PEOPLE);
    });
    await act(async () => {
      await flight;
    });
    expect(result.current.guidance).toBeNull();
    expect(result.current.guidanceError).toBeNull();
    expect(result.current.selectedName).toBe("People");
    expect(result.current.badge).toMatchObject({ phase: "done", mode: "add", name: "book.xlsx" });
  });
});
