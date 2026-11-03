import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useStagedWorkspaceSweep } from "../useStagedWorkspaceSweep";
import { listWorkspaces } from "../../api";
import { workspaceKeys } from "../../session/queryKeys";
import type { PendingWorkspace } from "../../components/thread/ComposerWorkspacePicker";

// Pins for useStagedWorkspaceSweep; the sweep's contract and the once-listed
// guard are documented at the hook. The tests drive the hook directly over a
// real QueryClient -- the mutation side is pinned as the invalidate, the same
// invalidateQueries the sidebar's remove onSuccess fires
// (WorkspaceSidebarSection.tsx); if that call site changes its invalidation
// strategy, these pins must be re-checked against it. The second test pins
// the guard's browse-survival half.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, listWorkspaces: vi.fn() };
});

function renderSweep(staged: PendingWorkspace | null) {
  const onReset = vi.fn();
  // staleTime mirrors the app default the sweep rides (src/lib/queryClient.ts)
  // so harness refetches stay invalidate-driven like production.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const view = renderHook(
    ({ staged: s }: { staged: PendingWorkspace | null }) =>
      useStagedWorkspaceSweep({ staged: s, onReset }),
    { initialProps: { staged }, wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ) },
  );
  return { onReset, queryClient, view };
}

describe("useStagedWorkspaceSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resets a staged pick whose registry record a refetch dropped", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
    ]);
    const { onReset, queryClient, view } = renderSweep(null);

    // Unstaged mount: the listing query stays disabled, zero IPC.
    expect(listWorkspaces).not.toHaveBeenCalled();

    // Stage the pick: the query enables, fetches, and the listing lands --
    // the "once-listed" baseline. Await the DATA, not the fetcher call: the
    // sweep's baseline is the effect that ran over the first listing.
    view.rerender({ staged: { path: "/w/alpha", label: "alpha" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(workspaceKeys.all())).toEqual([
          { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
        ]),
      );
    });
    expect(onReset).not.toHaveBeenCalled();

    // The sidebar remove landed: its invalidation refetches the shared key
    // and the record is gone.
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    // The cache has the fresh listing by now; the observer's notify pass is
    // batched behind it, so the effect (and the reset) lands on the next
    // flushed render -- poll for it instead of asserting synchronously.
    await waitFor(() => expect(onReset).toHaveBeenCalledWith(null));

    // The production reset feeds back: App nulls the pick, the effect re-runs
    // with staged null -- no crash on the re-run, and exactly one reset.
    view.rerender({ staged: null });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("keeps a browse-picked directory staged across registry refetches", async () => {
    // Empty registry: the pick came from the folder browse, never a record.
    vi.mocked(listWorkspaces).mockResolvedValue([]);
    const { onReset, queryClient, view } = renderSweep(null);

    view.rerender({ staged: { path: "/w/local", label: "local" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(workspaceKeys.all())).toEqual([]),
      );
    });

    // A registry refresh (e.g. the mint path's invalidation) must NOT sweep
    // a path that was never listed.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    expect(onReset).not.toHaveBeenCalled();
  });

  it("keeps the staged pick when a refetch drops a different record", async () => {
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
      { path: "/w/beta", label: "beta", explicit: true, exists: true },
    ]);
    const { onReset, queryClient, view } = renderSweep(null);

    view.rerender({ staged: { path: "/w/alpha", label: "alpha" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(workspaceKeys.all())).toHaveLength(2),
      );
    });

    // The user staged alpha but removed beta: the fresh listing still
    // carries alpha, so the staged pick survives.
    vi.mocked(listWorkspaces).mockResolvedValue([
      { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
    ]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(onReset).not.toHaveBeenCalled();
  });
});
