import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for useWorkingSet (the working-set seam, ADR-0123) -- the AUTHORITY
// layer for the domain knowledge that previously lived dispersed through
// useSessionState / SessionPane / WorkspaceWorkingSet: the invalidation
// cascade (three-key fan-out + previewRows nested-prefix inheritance), the
// active-source delete state machine, and the detail-pick resolution +
// preview gating. The component layer keeps only the render contract
// (WorkspaceWorkingSet.test). Runs offline via vi.mock on the api entries.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listWorkingSet: vi.fn(),
    activeDataset: vi.fn(),
    readRows: vi.fn(),
    renameDataset: vi.fn(),
    replaceSource: vi.fn(),
    removeSource: vi.fn(),
    removeActiveSource: vi.fn(),
    setDatasetPrivacy: vi.fn(),
  };
});

import {
  activeDataset,
  listWorkingSet,
  readRows,
  removeActiveSource,
  removeSource,
  renameDataset,
  replaceSource,
  setDatasetPrivacy,
} from "../../api";
import {
  invalidateSessionData,
  SAMPLE_ROW_LIMIT,
  useWorkingSet,
  type UseWorkingSetSurfaces,
} from "../useWorkingSet";
import { sessionKeys } from "../queryKeys";
import { src } from "./fixtures";
import type { DatasetDescriptor, RowPage } from "../../types/dataset";

const SID = "sess-1";
const PEOPLE = src("people");
const ORDERS = src("orders");

const EMPTY_PAGE: RowPage = {
  columns: [{ name: "ref", canonical_type: "VARCHAR" }],
  rows: [],
  total: 0,
  offset: 0,
  limit: SAMPLE_ROW_LIMIT,
};

// The pane-level mutation surfaces (ADR-0123): plain spies, so the
// cross-domain reports (error banner sink / busy sink / persist poll) are
// as assertable as useIngestFlow's injected deps are in its own tests.
function makeSurfaces(): UseWorkingSetSurfaces {
  return {
    setError: vi.fn(),
    setMutationLoading: vi.fn(),
    pollPersistError: vi.fn(async () => {}),
  };
}

// A fresh client per hook so the test cache never bleeds. retry:false: the
// mock's rejection IS the test's subject, not a transient to retry. The
// invalidate spy documents the fan-out shape; the preview assertions stay
// behavioral (a refetch actually fires -- the #1061 cascade precedent).
function setup(
  datasets = [PEOPLE, ORDERS],
  selectedName: string | null = null,
  active?: DatasetDescriptor | null,
) {
  const surfaces = makeSurfaces();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  vi.mocked(listWorkingSet).mockResolvedValue(datasets);
  // The active defaults to the first dataset (the common posture); the
  // third parameter overrides it BEFORE the first render fires the query
  // (mocking activeDataset after setup() would race the initial fetch).
  vi.mocked(activeDataset).mockResolvedValue(active ?? datasets[0] ?? null);
  vi.mocked(readRows).mockResolvedValue(EMPTY_PAGE);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        {children}
      </IntlProvider>
    </QueryClientProvider>
  );
  const view = renderHook(
    (pick: string | null) => useWorkingSet(SID, pick, surfaces),
    {
      wrapper,
      initialProps: selectedName,
    },
  );
  return { ...view, queryClient, invalidateSpy, surfaces };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useWorkingSet", () => {
  describe("detail-pick resolution and preview gating", () => {
    it("resolves the detail target as pick, then active, then first", async () => {
      const { result, rerender } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));
      // No pick: the active shows. (Same as the first fixture here -- the
      // arms are told apart by the test below.)
      expect(result.current.shown?.reference_name).toBe("people");
      // An explicit pick wins.
      rerender("orders");
      expect(result.current.shown?.reference_name).toBe("orders");
      // A pick that no longer resolves falls back to the active, never a
      // dead name (the deleted-pick fallback).
      rerender("ghost");
      expect(result.current.shown?.reference_name).toBe("people");
    });

    it("falls back to the active, not the first item, when the two differ", async () => {
      // The default fixture's active IS the first item, which makes the
      // active and first fallback arms indistinguishable; this is the
      // pair's only composition-level pin (issue #792's old component
      // test covered it before the seam migration).
      const { result, rerender } = setup([PEOPLE, ORDERS], null, ORDERS);
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));
      // No pick: the active shows, and it is not the first item.
      expect(result.current.shown?.reference_name).toBe("orders");
      // A dead pick falls back to the active too, still not the first item.
      rerender("ghost");
      expect(result.current.shown?.reference_name).toBe("orders");
    });

    it("idles the preview when the set is empty and reads the resolved pick's first window", async () => {
      const empty = setup([]);
      await waitFor(() => expect(empty.result.current.shown).toBeNull());
      expect(readRows).not.toHaveBeenCalled();

      const { result } = setup();
      await waitFor(() =>
        expect(readRows).toHaveBeenCalledWith(SID, "people", 0, SAMPLE_ROW_LIMIT),
      );
      expect(result.current.sample).toBe(EMPTY_PAGE);
    });
  });

  describe("invalidation cascade", () => {
    it("fans the three-key cascade after a mutation and refreshes the nested preview", async () => {
      vi.mocked(renameDataset).mockResolvedValue(PEOPLE);
      const { result, invalidateSpy } = setup();
      await waitFor(() => expect(readRows).toHaveBeenCalled());
      vi.mocked(readRows).mockClear();
      invalidateSpy.mockClear();

      await act(async () => {
        result.current.handleRename("people", "renamed");
      });

      // The fan-out hits all three descriptor keys -- thread included: a
      // rename appends a source lifecycle event, so the rail goes stale
      // without it.
      const invalidated = invalidateSpy.mock.calls.map(([filters]) =>
        JSON.stringify(filters?.queryKey),
      );
      expect(invalidated).toContain(JSON.stringify(sessionKeys.workingSet(SID)));
      expect(invalidated).toContain(JSON.stringify(sessionKeys.active(SID)));
      expect(invalidated).toContain(JSON.stringify(sessionKeys.thread(SID)));
      // And the previewRows key inherits the workingSet prefix, so the
      // sample page refetches alongside the descriptor -- staleTime Infinity
      // app-wide makes invalidation the ONLY refetch trigger.
      await waitFor(() =>
        expect(readRows).toHaveBeenCalledWith(SID, "people", 0, SAMPLE_ROW_LIMIT),
      );
    });

    it("surfaces a refresh failure as a refresh-tagged error", async () => {
      vi.mocked(renameDataset).mockResolvedValue(PEOPLE);
      const { result, invalidateSpy, surfaces } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));
      invalidateSpy.mockRejectedValueOnce(new Error("refresh boom"));

      await act(async () => {
        result.current.handleRename("people", "renamed");
      });

      await waitFor(() => expect(surfaces.setError).toHaveBeenCalled());
      const last = vi.mocked(surfaces.setError).mock.calls.at(-1)?.[0];
      expect(last?.kind).toBe("rename");
      // The refresh-failure wording, not a fresh "{verb} failed": the
      // refreshFailed tag rides the composed message (toAppError's opts),
      // not a separate AppError field, so the message is the assertion.
      expect(last?.message).toMatch(
        /saved, but refreshing the working set failed/i,
      );
    });
  });

  describe("active-source delete state machine", () => {
    it("routes an active-source delete with others remaining through the confirm machine", async () => {
      const { result } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));

      await act(async () => {
        result.current.handleDelete("people");
      });
      expect(result.current.pendingActiveDelete?.reference_name).toBe("people");
      expect(removeSource).not.toHaveBeenCalled();
      expect(removeActiveSource).not.toHaveBeenCalled();

      // Cancel is a no-op: nothing crosses IPC and the machine closes.
      act(() => {
        result.current.handleCancelActiveDelete();
      });
      expect(result.current.pendingActiveDelete).toBeNull();
      expect(removeActiveSource).not.toHaveBeenCalled();
    });

    it("confirm runs removeActiveSource with the continuation, closes the machine, and cascades", async () => {
      vi.mocked(removeActiveSource).mockResolvedValue(undefined);
      const { result, invalidateSpy } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));
      await act(async () => {
        result.current.handleDelete("people");
      });
      invalidateSpy.mockClear();

      await act(async () => {
        result.current.handleConfirmActiveDelete("orders");
      });
      expect(removeActiveSource).toHaveBeenCalledWith(SID, "people", "orders");
      expect(result.current.pendingActiveDelete).toBeNull();
      expect(
        invalidateSpy.mock.calls.some(
          ([filters]) =>
            JSON.stringify(filters?.queryKey) === JSON.stringify(sessionKeys.workingSet(SID)),
        ),
      ).toBe(true);
    });

    it("deletes a non-active source and the last remaining source directly", async () => {
      vi.mocked(removeSource).mockResolvedValue(undefined);
      const { result } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));
      await act(async () => {
        result.current.handleDelete("orders");
      });
      expect(removeSource).toHaveBeenCalledWith(SID, "orders");
      expect(result.current.pendingActiveDelete).toBeNull();

      // The LAST active source also goes straight through: with nothing left
      // to continue to, the confirm dialog has no candidates to offer.
      const last = setup([PEOPLE]);
      await waitFor(() => expect(last.result.current.datasets).toHaveLength(1));
      await act(async () => {
        last.result.current.handleDelete("people");
      });
      expect(removeSource).toHaveBeenCalledWith(SID, "people");
      expect(last.result.current.pendingActiveDelete).toBeNull();
    });

    it("keeps the machine open when the confirmed removal fails", async () => {
      vi.mocked(removeActiveSource).mockRejectedValue(new Error("boom"));
      const { result, surfaces } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));
      await act(async () => {
        result.current.handleDelete("people");
      });
      await act(async () => {
        result.current.handleConfirmActiveDelete("orders");
      });
      // The dialog stays mounted for retry; the failure reports verb-tagged
      // into the pane-level banner sink.
      expect(result.current.pendingActiveDelete?.reference_name).toBe("people");
      await waitFor(() => expect(surfaces.setError).toHaveBeenCalled());
      expect(vi.mocked(surfaces.setError).mock.calls.at(-1)?.[0]?.kind).toBe("delete");
    });
  });

  describe("replace branches", () => {
    it("refreshes on Loaded and surfaces the typed error without refreshing on Error", async () => {
      vi.mocked(replaceSource).mockResolvedValueOnce({ kind: "Loaded", data: PEOPLE });
      const loaded = setup();
      await waitFor(() => expect(loaded.result.current.datasets).toHaveLength(2));
      await act(async () => {
        loaded.result.current.handleReplace("people", "/x/new.csv");
      });
      expect(replaceSource).toHaveBeenCalledWith(SID, "people", "/x/new.csv");
      expect(
        loaded.invalidateSpy.mock.calls.some(
          ([filters]) =>
            JSON.stringify(filters?.queryKey) === JSON.stringify(sessionKeys.active(SID)),
        ),
      ).toBe(true);

      vi.mocked(replaceSource).mockResolvedValueOnce({
        kind: "Error",
        data: { kind: "Parse", data: { detail: "bad" } },
      });
      const failed = setup();
      await waitFor(() => expect(failed.result.current.datasets).toHaveLength(2));
      await act(async () => {
        failed.result.current.handleReplace("people", "/x/bad.csv");
      });
      await waitFor(() => expect(failed.surfaces.setError).toHaveBeenCalled());
      expect(vi.mocked(failed.surfaces.setError).mock.calls.at(-1)?.[0]?.kind).toBe("replace");
      // An Error outcome changed nothing server-side: no cascade fires.
      expect(failed.invalidateSpy).not.toHaveBeenCalled();
    });
  });

  describe("mutation wiring and domain state", () => {
    it("wires rename and privacy through their IPC entries", async () => {
      vi.mocked(renameDataset).mockResolvedValue(PEOPLE);
      vi.mocked(setDatasetPrivacy).mockResolvedValue(PEOPLE);
      const { result } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));

      await act(async () => {
        result.current.handleRename("people", "new label");
      });
      expect(renameDataset).toHaveBeenCalledWith(SID, "people", "new label");

      const privacy = { send_samples: false, type_only_columns: [] };
      await act(async () => {
        result.current.handlePrivacyChange("people", privacy);
      });
      expect(setDatasetPrivacy).toHaveBeenCalledWith(SID, "people", privacy);
    });

    it("tracks the mutation in-flight window", async () => {
      let resolveRename: (d: typeof PEOPLE) => void = () => {};
      vi.mocked(renameDataset).mockImplementation(
        () => new Promise((resolve) => (resolveRename = resolve)),
      );
      const { result, surfaces } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));

      act(() => {
        result.current.handleRename("people", "x");
      });
      expect(surfaces.setMutationLoading).toHaveBeenNthCalledWith(1, true);
      resolveRename(PEOPLE);
      await waitFor(() =>
        expect(surfaces.setMutationLoading).toHaveBeenLastCalledWith(false),
      );
    });

    it("polls the pane-level persist flag after a settled mutation", async () => {
      vi.mocked(renameDataset).mockResolvedValue(PEOPLE);
      const { result, surfaces } = setup();
      await waitFor(() => expect(result.current.datasets).toHaveLength(2));

      await act(async () => {
        result.current.handleRename("people", "x");
      });
      expect(surfaces.pollPersistError).toHaveBeenCalled();
    });
  });
});

describe("invalidateSessionData", () => {
  it("runs the three-key fan-out (the ingest consumer's single entry)", async () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries");

    await invalidateSessionData(queryClient, SID);

    expect(spy.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))).toEqual([
      JSON.stringify(sessionKeys.workingSet(SID)),
      JSON.stringify(sessionKeys.active(SID)),
      JSON.stringify(sessionKeys.thread(SID)),
    ]);
  });
});
