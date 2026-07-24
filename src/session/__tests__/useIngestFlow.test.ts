import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntlShape } from "react-intl";
import { useIngestFlow } from "../useIngestFlow";
import { src } from "./fixtures";
import type {
  GuidanceRequest,
  LoadOutcome,
  SheetGuidance,
} from "../../types/dataset";

// Tests for useIngestFlow (issue #231) -- pins the behaviors extracted from
// useSessionState: the three handleIngest branches (Loaded -> refresh + clear,
// NeedsGuidance -> guidance dialog, Error -> loadErrorDisplay), the guided
// submit variants (Loaded / Error / NeedsGuidance-recur), the cold-start drop
// consumption with path-based dedup (ADR-0061), and the shared IPC-reject path
// via toAppError. Runs offline via vi.mock on the two api entry points.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    ingestFile: vi.fn(),
    ingestFileGuided: vi.fn(),
  };
});

import { ingestFile, ingestFileGuided } from "../../api";

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

describe("useIngestFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleIngest - Loaded branch", () => {
    it("refreshes server state with 'load' and clears viewed for the new source", async () => {
      const { deps, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loaded("result_1"));
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));

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
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));

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
  });

  describe("handleIngest - Error branch", () => {
    it("surfaces a LoadError via loadErrorDisplay tagged 'load'", async () => {
      const { deps, setError, refreshServerState, viewed } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loadError);
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));

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
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));

      await act(async () => {
        await result.current.handleIngest("/x.csv");
      });

      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));
      expect(result.current.guidance).toBeNull();
    });

    it("clears loading in the finally even on reject", async () => {
      const { deps, setLoading } = setup();
      vi.mocked(ingestFile).mockRejectedValue(new Error("ipc down"));
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));

      await act(async () => {
        await result.current.handleIngest("/x.csv");
      });

      expect(setLoading).toHaveBeenLastCalledWith(false);
    });
  });

  describe("cold-start drop consumption (ADR-0061)", () => {
    it("ingests a pending path once + calls onIngestConsumed", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loaded("result_1"));
      const onIngestConsumed = vi.fn();
      const { rerender } = renderHook(
        ({ path }) => useIngestFlow(SID, path, onIngestConsumed, deps),
        { initialProps: { path: null as string | null } },
      );

      rerender({ path: "/drop.csv" });

      await waitFor(() => expect(onIngestConsumed).toHaveBeenCalledTimes(1));
      expect(ingestFile).toHaveBeenCalledWith(SID, "/drop.csv");
    });

    it("dedups a repeated SAME path (StrictMode double-invoke / remount) -> no-op", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loaded("result_1"));
      const onIngestConsumed = vi.fn();
      const { rerender } = renderHook(
        ({ path }) => useIngestFlow(SID, path, onIngestConsumed, deps),
        { initialProps: { path: "/drop.csv" as string | null } },
      );

      // The mount effect already consumed "/drop.csv"; re-emitting the SAME
      // path (StrictMode dev double-invoke, or a remount before the shell
      // clears the prop) must not re-ingest.
      rerender({ path: "/drop.csv" });
      rerender({ path: "/drop.csv" });

      await waitFor(() => expect(ingestFile).toHaveBeenCalledTimes(1));
      expect(onIngestConsumed).toHaveBeenCalledTimes(1);
    });

    it("ingests each DISTINCT path once when the prop changes", async () => {
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loaded("result_1"));
      const onIngestConsumed = vi.fn();
      const { rerender } = renderHook(
        ({ path }) => useIngestFlow(SID, path, onIngestConsumed, deps),
        { initialProps: { path: "/a.csv" as string | null } },
      );

      await waitFor(() => expect(ingestFile).toHaveBeenCalledWith(SID, "/a.csv"));

      rerender({ path: "/b.csv" });

      await waitFor(() => expect(ingestFile).toHaveBeenCalledWith(SID, "/b.csv"));
      expect(ingestFile).toHaveBeenCalledTimes(2);
      expect(onIngestConsumed).toHaveBeenCalledTimes(2);
    });

    it("does nothing when pendingIngestPath is null", () => {
      const { deps } = setup();
      vi.mocked(ingestFile).mockResolvedValue(loaded("result_1"));
      const onIngestConsumed = vi.fn();
      renderHook(() => useIngestFlow(SID, null, onIngestConsumed, deps));

      expect(ingestFile).not.toHaveBeenCalled();
      expect(onIngestConsumed).not.toHaveBeenCalled();
    });
  });

  describe("handleGuidedSubmit - Loaded branch", () => {
    it("clears guidance + refreshes with 'load' + clears viewed", async () => {
      const { deps, refreshServerState, viewed } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));
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

  describe("handleGuidedSubmit - Error branch", () => {
    it("surfaces a LoadError and leaves guidance open for retry", async () => {
      const { deps, setError } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockResolvedValue(loadError);

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      expect(setError).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "load", detail: "bad" }),
      );
      // Guidance stays open so the user can adjust + retry (not cleared).
      expect(result.current.guidance).not.toBeNull();
    });
  });

  describe("handleGuidedSubmit - NeedsGuidance-recur", () => {
    it("surfaces the guidedStillNeedsGuidance locale message tagged 'load'", async () => {
      const { deps, setError, intl } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockResolvedValue(needsGuidance());

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      // The recur branch calls intl.formatMessage with the canonical id, then
      // builds the AppError by hand (detail null, kind load).
      expect(intl.formatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: "error.flow.guidedStillNeedsGuidance" }),
      );
      expect(setError).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "load", detail: null }),
      );
      expect(result.current.guidance).not.toBeNull();
    });
  });

  describe("handleGuidedSubmit - IPC reject", () => {
    it("surfaces a reject via toAppError tagged 'load'", async () => {
      const { deps, setError } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));
      await primeGuidance(result);
      vi.mocked(ingestFileGuided).mockRejectedValue(new Error("ipc down"));

      await act(async () => {
        await result.current.handleGuidedSubmit(sheetGuidance);
      });

      expect(setError).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "load" }));
    });

    it("is a no-op when guidance is null (no dialog open)", async () => {
      const { deps } = setup();
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));
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
      const { result } = renderHook(() => useIngestFlow(SID, null, () => {}, deps));
      await primeGuidance(result);
      expect(result.current.guidance).not.toBeNull();

      act(() => {
        result.current.handleGuidedCancel();
      });

      expect(result.current.guidance).toBeNull();
    });
  });
});
