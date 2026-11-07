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
  };
});

import {
  addWorkspaceDataset,
  listWorkspaceDatasets,
  renameWorkspaceDataset,
  replaceWorkspaceDataset,
  setWorkspaceDatasetPrivacy,
} from "../../api";
import { toast } from "../../components/ui/use-toast";
import { open } from "@tauri-apps/plugin-dialog";
import { withIntl } from "../../components/common/__tests__/helpers";
import { useWorkspaceDatasets } from "../useWorkspaceDatasets";
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
  const resolvers: Array<(e: ListedWorkspaceDataset) => void> = [];
  vi.mocked(addWorkspaceDataset).mockImplementation(
    () => new Promise<ListedWorkspaceDataset>((r) => { resolvers.push(r); }),
  );
  return (i, e) => resolvers[i](e);
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
    // The settle face froze the batch's total duration (read at settle,
    // outside the updater): deterministic under the stepped clock.
    expect(result.current.badge).toEqual({
      phase: "done",
      mode: "add",
      name: "b.csv",
      seconds: expect.any(Number),
    });
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

  it("a row action's failure lands on the banner with the catalog wording", async () => {
    seed([entry({}), entry({ reference_name: "orders", display_name: "orders", source_path: "/src/orders.csv" })]);
    vi.mocked(renameWorkspaceDataset).mockRejectedValue({ kind: "DisplayTaken", data: "orders" });
    const { result } = setup();
    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => {
      result.current.rename("people", "orders");
    });
    await waitFor(() => expect(result.current.error).toBe("显示名 orders 已被占用"));
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
});
