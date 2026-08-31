import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { useIngestFlow } from "../useIngestFlow";
import { src } from "./fixtures";
import type {
  GuidanceRequest,
  LoadOutcome,
  SheetGuidance,
} from "../../types/dataset";

// Tests for useIngestFlow (issue #231, extended by #748) -- pins the behaviors
// extracted from useSessionState: the three handleIngest branches (Loaded ->
// refresh + clear, NeedsGuidance -> guidance dialog, Error -> loadErrorDisplay),
// the guided submit variants (Loaded / Error / NeedsGuidance-recur), and the
// shared IPC-reject path via toAppError. Issue #748 adds: inline guided errors
// (guidanceError, NOT the shared workspace banner), the parked-batch queue with
// a Promise that stays pending until the queue drains or halts terminally
// (#500 gate), the Loaded-triggered auto-resume, and the cancel / Error /
// reject halt remaining-count (haltedRemaining). Runs offline via vi.mock on
// the two api entry points.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    ingestFile: vi.fn(),
    ingestFileGuided: vi.fn(),
  };
});

// useIngestFlow logs batch halts via the shared log sink (issue #351 I1); mock
// it so the plugin-log IPC never fires under jsdom and the halt tests can
// assert the diagnostic is emitted.
vi.mock("../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ingestFile, ingestFileGuided } from "../../api";
import { log } from "../../lib/log";

const SID = "sess-1";

// Minimal-but-real fixtures (all required fields, no hand-rolled subsets) so a
// shape change surfaces at compile time.
const guidanceRequest: GuidanceRequest = {
  source_path: "/x.xlsx",
  workbook_name: "x.xlsx",
  sheets: [{ name: "Sheet1", preview: [["a", "b"]] }],
};

const sheetGuidance: SheetGuidance[] = [
  { name: "Sheet1", rectify: { header_row: 1, skip_rows: [] } },
];

const loaded = (ref: string): LoadOutcome => ({ kind: "Loaded", data: src(ref) });
const needsGuidance = (): LoadOutcome => ({ kind: "NeedsGuidance", data: guidanceRequest });
const loadError: LoadOutcome = { kind: "Error", data: { kind: "Parse", data: { detail: "bad" } } };

function setup() {
  const refreshServerState = vi.fn(async () => {});
  const viewed = { clearForNewSource: vi.fn() };
  const setLoading = vi.fn();
  const setError = vi.fn();
  const pollPersistError = vi.fn(async () => {});
  // formatMessage is a spy so the NeedsGuidance-recur test can assert the
  // canonical id; it returns a fixed "err" so loadErrorDisplay's message is
  // deterministic for the Error-branch assertion.
  const intl = { formatMessage: vi.fn(() => "err") } as unknown as IntlShape;
  const deps = { intl, setLoading, setError, refreshServerState, pollPersistError, viewed };
  return {
    deps,
    refreshServerState,
    viewed,
    setLoading,
    setError,
    pollPersistError,
    intl,
  };
}

// Prime the guidance dialog (NeedsGuidance route) so a guided-submit / cancel
// test starts from the non-null guidance state. Asserts the route landed so a
// silent regression in handleIngest does not cascade into false greens below.
async function primeGuidance(
  result: { current: ReturnType<typeof useIngestFlow> },
  path = "/x.xlsx",
) {
  vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
  await act(async () => {
    await result.current.handleIngest(path);
  });
  expect(result.current.guidance).toEqual({ request: guidanceRequest, path });
  return result;
}

// Track when (and with what) a parked batch's Promise settles: the #748
// contract is that handleIngestMany does NOT resolve while the guidance dialog
// parks the batch, so tests assert `resolved === null` until the queue drains
// or halts terminally.
function trackResolution(promise: Promise<boolean>) {
  const tracker: { resolved: boolean | null } = { resolved: null };
  void promise.then((v) => {
    tracker.resolved = v;
  });
  return tracker;
}

describe("useIngestFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleIngest - Loaded branch", () => {
    it("refreshes server state with 'load' and clears viewed for the new source", async () => {
      const { deps, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loaded("result_1"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      await act(async () => {
        await result.current.handleIngest("/x.csv");
      });

      expect(ingestFile).toHaveBeenCalledWith(SID, "/x.csv");
      expect(refreshServerState).toHaveBeenCalledWith("load");
      expect(viewed.clearForNewSource).toHaveBeenCalledTimes(1);
      expect(result.current.guidance).toBeNull();
    });
  });

  describe("handleIngest - NeedsGuidance branch", () => {
    it("routes NeedsGuidance into the guidance dialog (sets guidance state)", async () => {
      const { deps, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile).mockResolvedValue(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      await act(async () => {
        await result.current.handleIngest("/x.xlsx");
      });

      expect(result.current.guidance).toEqual({
        request: guidanceRequest,
        path: "/x.xlsx",
      });
      // NeedsGuidance yields no dataset -> no refresh, no viewed clear.
      expect(refreshServerState).not.toHaveBeenCalled();
      expect(viewed.clearForNewSource).not.toHaveBeenCalled();
    });

    it("a freshly routed guidance opens without a stale inline error (#748)", async () => {
      // A failed guided submit leaves guidanceError set; the NEXT file's
      // NeedsGuidance route must open the dialog clean (no stale error from
      // the previous workbook). No cancel and no re-submit runs in between,
      // so the routed clear at the NeedsGuidance branch is the only thing
      // retiring the stale error.
      const { deps } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loadError);
      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });
      expect(result.current.guidanceError).not.toBeNull();

      vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
      await act(async () => {
        await result.current.handleIngest("/y.xlsx");
      });

      expect(result.current.guidance).toEqual({
        request: guidanceRequest,
        path: "/y.xlsx",
      });
      expect(result.current.guidanceError).toBeNull();
    });
  });

  describe("handleIngest - Error branch", () => {
    it("surfaces a LoadError via loadErrorDisplay tagged 'load'", async () => {
      const { deps, setError, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loadError);
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      await act(async () => {
        await result.current.handleIngest("/bad.csv");
      });

      // setError(null) runs first (clear), then the typed LoadError sets the
      // AppError with kind "load" and the loadErrorDisplay message.
      expect(setError).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "load", detail: "bad" }),
      );
      expect(result.current.guidance).toBeNull();
      expect(refreshServerState).not.toHaveBeenCalled();
      expect(viewed.clearForNewSource).not.toHaveBeenCalled();
    });
  });

  describe("handleIngest - IPC reject", () => {
    it("surfaces a reject via toAppError tagged 'load'", async () => {
      const { deps, setError } = setup();
      vi.mocked(ingestFile).mockRejectedValue(new Error("ipc down"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      await act(async () => {
        await result.current.handleIngest("/x.csv");
      });

      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));
      expect(result.current.guidance).toBeNull();
    });

    it("clears loading in the finally even on reject", async () => {
      const { deps, setLoading } = setup();
      vi.mocked(ingestFile).mockRejectedValue(new Error("ipc down"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      await act(async () => {
        await result.current.handleIngest("/x.csv");
      });

      expect(setLoading).toHaveBeenLastCalledWith(false);
    });
  });

  describe("handleIngestMany - multi-file batch (issue #351)", () => {
    it("ingests every file sequentially, refreshing ONCE after the batch", async () => {
      const { deps, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loaded("result_1"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let allLoaded = false;
      await act(async () => {
        allLoaded = await result.current.handleIngestMany(["/a.csv", "/b.csv", "/c.csv"]);
      });

      // #500: a fully-loaded batch reports true (the SessionPane's auto-ask
      // gate consumes it).
      expect(allLoaded).toBe(true);
      expect(ingestFile).toHaveBeenCalledTimes(3);
      expect(ingestFile).toHaveBeenNthCalledWith(1, SID, "/a.csv");
      expect(ingestFile).toHaveBeenNthCalledWith(2, SID, "/b.csv");
      expect(ingestFile).toHaveBeenNthCalledWith(3, SID, "/c.csv");
      // One refresh + one viewed clear for the whole batch, not per file.
      expect(refreshServerState).toHaveBeenCalledTimes(1);
      expect(refreshServerState).toHaveBeenCalledWith("load");
      expect(viewed.clearForNewSource).toHaveBeenCalledTimes(1);
      expect(result.current.guidance).toBeNull();
      // Nothing halted -> no remaining-count surface.
      expect(result.current.haltedRemaining).toBeNull();
    });

    it("parks the batch on NeedsGuidance without resolving the Promise (#748)", async () => {
      const { deps, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/a.csv", "/x.xlsx", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      // Flush microtasks so an (incorrect) immediate resolve would be caught.
      await act(async () => {});

      // The batch parks on the guidance dialog: the third file is NOT
      // attempted yet, and the Promise stays pending until the queue drains
      // or halts terminally (#500 gate: no auto-ask under an open dialog).
      expect(tracker.resolved).toBeNull();
      expect(ingestFile).toHaveBeenCalledTimes(2);
      expect(result.current.guidance).toEqual({
        request: guidanceRequest,
        path: "/x.xlsx",
      });
      // The first file DID load before the park -> the working set refreshes
      // once so it is visible while the user resolves the dialog.
      expect(refreshServerState).toHaveBeenCalledTimes(1);
      expect(viewed.clearForNewSource).toHaveBeenCalledTimes(1);
      // Parking is not a halt -> no remaining-count surface yet.
      expect(result.current.haltedRemaining).toBeNull();
      // The parked queue is invisible to loading state: the dialog is
      // interactive (submit / cancel enabled).
      expect(deps.setLoading).toHaveBeenLastCalledWith(false);
    });

    it("a cancel during the post-park refresh halt-settles the parked batch (#748)", async () => {
      // The park handle must be readable the moment the dialog becomes
      // interactive: the post-park refresh is a real IPC round trip during
      // which Cancel / ESC are enabled (loading false), so a cancel in that
      // window must settle-halt instead of orphaning the batch.
      const { deps } = setup();
      let releaseRefresh: (() => void) | null = null;
      deps.refreshServerState.mockImplementation(
        () => new Promise<void>((r) => { releaseRefresh = r; }),
      );
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/a.csv", "/x.xlsx", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      // The segment is parked inside the pending refresh; the dialog is open
      // and interactive.
      expect(result.current.guidance).not.toBeNull();
      expect(tracker.resolved).toBeNull();

      act(() => {
        result.current.handleGuidedCancel();
      });
      await act(async () => {});
      expect(tracker.resolved).toBe(false);
      expect(result.current.haltedRemaining).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        "useIngestFlow",
        "batch halted; remaining files skipped",
        { reason: "cancelled", remaining: 1 },
      );

      // Releasing the refresh must not resurrect the consumed park handle.
      await act(async () => {
        releaseRefresh?.();
      });
      expect(tracker.resolved).toBe(false);
      expect(result.current.haltedRemaining).toBe(1);
    });

    it("a rejecting post-park refresh settles the gate instead of rejecting unhandled (#748)", async () => {
      // Everything past the ingest loop used to be unguarded: an exception
      // there rejected the segment unhandled and the #500 gate never
      // settled. The escape guard routes it to the banner + halt path.
      const { deps, setError } = setup();
      deps.refreshServerState.mockRejectedValueOnce(new Error("refresh down"));
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/a.csv", "/x.xlsx", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      await act(async () => {});

      expect(tracker.resolved).toBe(false);
      expect(setError).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "load" }),
      );
      expect(result.current.haltedRemaining).toBe(1);
      expect(result.current.guidance).not.toBeNull();

      // The in-loop park handle did not outlive the terminated batch:
      // cancelling the still-open dialog halts nothing further (exactly one
      // diagnostic).
      act(() => {
        result.current.handleGuidedCancel();
      });
      expect(log.warn).toHaveBeenCalledTimes(1);
    });

    it("stops the batch on Error but keeps the earlier Loaded files", async () => {
      const { deps, setError, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockResolvedValueOnce(loadError);
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let allLoaded = true;
      await act(async () => {
        allLoaded = await result.current.handleIngestMany(["/a.csv", "/bad.csv", "/c.csv"]);
      });

      // #500: an error-halted batch reports false too.
      expect(allLoaded).toBe(false);
      expect(ingestFile).toHaveBeenCalledTimes(2);
      expect(setError).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "load", detail: "bad" }),
      );
      // The first file loaded before the error -> refresh + clear still run so
      // it is visible, alongside the error banner.
      expect(refreshServerState).toHaveBeenCalledTimes(1);
      expect(viewed.clearForNewSource).toHaveBeenCalledTimes(1);
      expect(result.current.guidance).toBeNull();
      // #748: one file (c.csv) remained past the Error halt -> the count is
      // surfaced (the banner's screen-mate in the workspace).
      expect(result.current.haltedRemaining).toBe(1);
      // The skip is observable in logs too (operation semantics only), with
      // the halt reason discriminating Error / reject / cancelled paths.
      expect(log.warn).toHaveBeenCalledWith(
        "useIngestFlow",
        "batch halted; remaining files skipped",
        { reason: "error", remaining: 1 },
      );
    });

    it("does not refresh when the FIRST file already fails (nothing loaded)", async () => {
      const { deps, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loadError);
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let allLoaded = true;
      await act(async () => {
        allLoaded = await result.current.handleIngestMany(["/bad.csv", "/b.csv"]);
      });

      expect(allLoaded).toBe(false);
      expect(ingestFile).toHaveBeenCalledTimes(1);
      expect(refreshServerState).not.toHaveBeenCalled();
      expect(viewed.clearForNewSource).not.toHaveBeenCalled();
      // #748: b.csv never ran -> the halt count surfaces.
      expect(result.current.haltedRemaining).toBe(1);
    });

    it("does not set a halt count when the Error-halting file is the last", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockResolvedValueOnce(loadError);
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      await act(async () => {
        await result.current.handleIngestMany(["/a.csv", "/bad.csv"]);
      });

      expect(result.current.haltedRemaining).toBeNull();
      expect(log.warn).not.toHaveBeenCalled();
    });

    it("is a no-op for an empty path list", async () => {
      const { deps, setLoading, refreshServerState } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let allLoaded = false;
      await act(async () => {
        allLoaded = await result.current.handleIngestMany([]);
      });

      // #500: nothing to halt on -- an empty batch is vacuously all-loaded so
      // a bare-question cold-start submit never gates.
      expect(allLoaded).toBe(true);
      expect(ingestFile).not.toHaveBeenCalled();
      expect(refreshServerState).not.toHaveBeenCalled();
      // No loading churn for a no-op batch.
      expect(setLoading).not.toHaveBeenCalled();
    });

    it("surfaces an IPC reject via toAppError tagged 'load' and clears loading", async () => {
      const { deps, setError, setLoading } = setup();
      vi.mocked(ingestFile).mockRejectedValue(new Error("ipc down"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let allLoaded = true;
      await act(async () => {
        allLoaded = await result.current.handleIngestMany(["/a.csv"]);
      });

      // #500: a reject resolves false (the error banner owns the same gate).
      expect(allLoaded).toBe(false);
      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));
      expect(setLoading).toHaveBeenLastCalledWith(false);
      // The rejected file was the only one -> nothing remained.
      expect(result.current.haltedRemaining).toBeNull();
    });

    it("counts the skipped remainder on an IPC reject mid-batch (#748)", async () => {
      const { deps, setError } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockRejectedValueOnce(new Error("ipc down"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let allLoaded = true;
      await act(async () => {
        allLoaded = await result.current.handleIngestMany(["/a.csv", "/b.csv", "/c.csv"]);
      });

      expect(allLoaded).toBe(false);
      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));
      // c.csv never ran (b.csv is the failing one) -> count 1.
      expect(result.current.haltedRemaining).toBe(1);
      expect(log.warn).toHaveBeenCalledWith(
        "useIngestFlow",
        "batch halted; remaining files skipped",
        { reason: "reject", remaining: 1 },
      );
    });

    it("clears a stale halt count at the start of a new batch (#748)", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockResolvedValueOnce(loadError);
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await act(async () => {
        await result.current.handleIngestMany(["/a.csv", "/bad.csv", "/c.csv"]);
      });
      expect(result.current.haltedRemaining).toBe(1);

      vi.mocked(ingestFile).mockResolvedValue(loaded("result_2"));
      await act(async () => {
        await result.current.handleIngestMany(["/d.csv"]);
      });

      expect(result.current.haltedRemaining).toBeNull();
    });

    it("clears a stale halt count when the next single-file ingest starts (#748)", async () => {
      // A cancel-halt leaves the count on screen; the next single-file drop
      // routes through handleIngest, whose start-of-ingest clear is the only
      // thing retiring the notice on that path.
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x.xlsx", "/b.csv", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      act(() => {
        result.current.handleGuidedCancel();
      });
      await act(async () => {});
      expect(tracker.resolved).toBe(false);
      expect(result.current.haltedRemaining).toBe(2);

      vi.mocked(ingestFile).mockResolvedValueOnce(loaded("result_1"));
      await act(async () => {
        await result.current.handleIngest("/d.csv");
      });

      expect(result.current.haltedRemaining).toBeNull();
    });
  });

  describe("handleIngestMany - auto-resume after a guided Loaded (issue #748)", () => {
    it("resumes the parked queue and resolves true when it drains", async () => {
      const { deps, refreshServerState } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(loaded("result_1"))
        .mockResolvedValueOnce(needsGuidance())
        .mockResolvedValueOnce(loaded("result_3"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/a.csv", "/x.xlsx", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      expect(result.current.guidance).not.toBeNull();
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loaded("result_2"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      // The guided file loaded -> the queue resumed and drained on its own.
      expect(tracker.resolved).toBe(true);
      expect(ingestFile).toHaveBeenCalledTimes(3);
      expect(ingestFile).toHaveBeenNthCalledWith(3, SID, "/c.csv");
      expect(result.current.guidance).toBeNull();
      expect(result.current.haltedRemaining).toBeNull();
      // One refresh per loaded segment: pre-park file, the guided file, and
      // the resumed file.
      expect(refreshServerState).toHaveBeenCalledTimes(3);
    });

    it("re-parks when the resumed file also needs guidance (dialog replaced)", async () => {
      const { deps, refreshServerState } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(needsGuidance())
        .mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x1.xlsx", "/x2.xlsx", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      expect(result.current.guidance).toEqual({
        request: guidanceRequest,
        path: "/x1.xlsx",
      });
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loaded("result_1"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      // The resume hit the next file's NeedsGuidance: the dialog now targets
      // the new path (SessionPane keys the dialog on it, #748 remount), the
      // Promise stays pending, and only the first guided file refreshed.
      expect(tracker.resolved).toBeNull();
      expect(result.current.guidance).toEqual({
        request: guidanceRequest,
        path: "/x2.xlsx",
      });
      expect(refreshServerState).toHaveBeenCalledTimes(1);

      // Cancelling the second dialog cancel-halts the batch: /c.csv remains.
      act(() => {
        result.current.handleGuidedCancel();
      });
      await act(async () => {});
      expect(tracker.resolved).toBe(false);
      expect(result.current.haltedRemaining).toBe(1);
    });

    it("halts terminally when the resumed file errors (banner + count)", async () => {
      const { deps, setError } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(needsGuidance())
        .mockResolvedValueOnce(loadError);
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x.xlsx", "/bad.csv", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loaded("result_1"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      expect(tracker.resolved).toBe(false);
      expect(result.current.guidance).toBeNull();
      expect(setError).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "load", detail: "bad" }),
      );
      expect(result.current.haltedRemaining).toBe(1);
    });

    it("halts terminally when the resumed file rejects IPC (#748)", async () => {
      const { deps, setError } = setup();
      vi.mocked(ingestFile)
        .mockResolvedValueOnce(needsGuidance())
        .mockRejectedValueOnce(new Error("ipc down"));
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x.xlsx", "/b.csv", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loaded("result_1"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      expect(tracker.resolved).toBe(false);
      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));
      expect(result.current.haltedRemaining).toBe(1);
    });

    it("resolves true when the guided file was the last in the batch", async () => {
      const { deps, refreshServerState } = setup();
      vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x.xlsx"]);
      });
      const tracker = trackResolution(promise);
      expect(tracker.resolved).toBeNull();
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loaded("result_1"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      expect(tracker.resolved).toBe(true);
      expect(result.current.haltedRemaining).toBeNull();
      // Nothing loaded pre-park; only the guided file's refresh runs.
      expect(refreshServerState).toHaveBeenCalledTimes(1);
    });

    it("a new batch supersedes a parked one (stale Promise resolves false)", async () => {
      // Defensive: the modal dialog makes this unreachable through the UI, but
      // the stale #500 gate must still settle instead of leaking a pending
      // Promise.
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let stale!: Promise<boolean>;
      await act(async () => {
        stale = result.current.handleIngestMany(["/x.xlsx", "/b.csv"]);
      });
      const staleTracker = trackResolution(stale);
      expect(staleTracker.resolved).toBeNull();

      vi.mocked(ingestFile).mockResolvedValue(loaded("result_2"));
      let allLoaded = false;
      await act(async () => {
        allLoaded = await result.current.handleIngestMany(["/y.csv"]);
      });

      expect(allLoaded).toBe(true);
      await act(async () => {});
      expect(staleTracker.resolved).toBe(false);
      // The superseded queue is dropped without a count (the new batch owns
      // the surface; the start-of-batch clear already ran).
      expect(result.current.haltedRemaining).toBeNull();
    });
  });

  describe("handleGuidedSubmit - Loaded branch", () => {
    it("clears guidance + refreshes with 'load' + clears viewed", async () => {
      const { deps, refreshServerState, viewed } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockResolvedValue(loaded("result_2"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      expect(ingestFileGuided).toHaveBeenCalledWith(SID, "/x.xlsx", sheetGuidance);
      expect(result.current.guidance).toBeNull();
      expect(refreshServerState).toHaveBeenCalledWith("load");
      expect(viewed.clearForNewSource).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleGuidedSubmit - Error branch (#748 inline error)", () => {
    it("surfaces a LoadError INLINE and leaves guidance open for retry", async () => {
      const { deps, setError } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockResolvedValue(loadError);

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      // The error lands in the dialog-dedicated state, NOT the shared
      // workspace banner (the workspace body sits behind the modal scrim).
      expect(result.current.guidanceError).toEqual(
        expect.objectContaining({ kind: "load", detail: "bad" }),
      );
      expect(setError).toHaveBeenLastCalledWith(null);
      // Guidance stays open so the user can adjust + retry (not cleared).
      expect(result.current.guidance).not.toBeNull();
    });

    it("keeps a parked batch pending while the dialog retries (#748)", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x.xlsx", "/b.csv"]);
      });
      const tracker = trackResolution(promise);
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loadError);

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      // Failed submit: the dialog stays open with the inline error, and the
      // queue stays parked -- neither halt path ran.
      expect(tracker.resolved).toBeNull();
      expect(result.current.guidanceError).not.toBeNull();
      expect(result.current.haltedRemaining).toBeNull();

      // A successful retry then resumes the queue.
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loaded("result_1"));
      vi.mocked(ingestFile).mockResolvedValueOnce(loaded("result_2"));
      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });
      expect(tracker.resolved).toBe(true);
      expect(result.current.guidanceError).toBeNull();
    });
  });

  describe("handleGuidedSubmit - NeedsGuidance-recur", () => {
    it("surfaces the guidedStillNeedsGuidance locale message INLINE tagged 'load'", async () => {
      const { deps, setError, intl } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockResolvedValue(needsGuidance());

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      // The recur branch calls intl.formatMessage with the canonical id, then
      // builds the AppError by hand (detail null, kind load) -- inline.
      expect(intl.formatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "error.flow.guidedStillNeedsGuidance" }),
      );
      expect(result.current.guidanceError).toEqual(
        expect.objectContaining({ kind: "load", detail: null }),
      );
      expect(setError).toHaveBeenLastCalledWith(null);
      expect(result.current.guidance).not.toBeNull();
    });
  });

  describe("handleGuidedSubmit - IPC reject", () => {
    it("surfaces a reject INLINE via toAppError tagged 'load'", async () => {
      const { deps, setError } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockRejectedValue(new Error("ipc down"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      expect(result.current.guidanceError).toEqual(
        expect.objectContaining({ kind: "load" }),
      );
      expect(setError).toHaveBeenLastCalledWith(null);
    });

    it("is a no-op when guidance is null (no dialog open)", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      // No prime -> guidance is null. A stray submit (should not happen in
      // practice -- the dialog is conditionally rendered) is a safe no-op.
      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });
      expect(ingestFileGuided).not.toHaveBeenCalled();
    });
  });

  describe("handleGuidedCancel", () => {
    it("clears guidance to null", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await primeGuidance(result);
      expect(result.current.guidance).not.toBeNull();

      act(() => {
        result.current.handleGuidedCancel();
      });

      expect(result.current.guidance).toBeNull();
      // Single-file guidance has no parked queue -> no halt count.
      expect(result.current.haltedRemaining).toBeNull();
    });

    it("clears a pending inline error (#748)", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockResolvedValueOnce(loadError);
      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });
      expect(result.current.guidanceError).not.toBeNull();

      act(() => {
        result.current.handleGuidedCancel();
      });

      expect(result.current.guidanceError).toBeNull();
    });

    it("cancel-halts a parked batch: resolves false + surfaces the remaining count (#748)", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x.xlsx", "/b.csv", "/c.csv"]);
      });
      const tracker = trackResolution(promise);
      expect(tracker.resolved).toBeNull();

      act(() => {
        result.current.handleGuidedCancel();
      });
      await act(async () => {});

      expect(tracker.resolved).toBe(false);
      expect(result.current.guidance).toBeNull();
      expect(result.current.haltedRemaining).toBe(2);
      expect(log.warn).toHaveBeenCalledWith(
        "useIngestFlow",
        "batch halted; remaining files skipped",
        { reason: "cancelled", remaining: 2 },
      );
    });

    it("cancel on the last parked file resolves false without a halt count", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValueOnce(needsGuidance());
      const { result } = renderHook(() => useIngestFlow(SID, deps));

      let promise!: Promise<boolean>;
      await act(async () => {
        promise = result.current.handleIngestMany(["/x.xlsx"]);
      });
      const tracker = trackResolution(promise);

      act(() => {
        result.current.handleGuidedCancel();
      });
      await act(async () => {});

      expect(tracker.resolved).toBe(false);
      expect(result.current.haltedRemaining).toBeNull();
      expect(log.warn).not.toHaveBeenCalled();
    });
  });
});
