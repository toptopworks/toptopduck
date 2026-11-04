import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useStagedWorkspaceSweep } from "../useStagedWorkspaceSweep";
import { listWorkspaces } from "../../api";
import type { WorkspaceListing } from "../../api";
import { workspaceKeys } from "../../session/queryKeys";
import type { PendingWorkspace } from "../../components/thread/ComposerWorkspacePicker";

// Pins for useStagedWorkspaceSweep; the sweep's contract, the once-listed
// guard, and the degraded-listing hold (issue #1481) are documented at the
// hook. The tests drive the hook directly over a real QueryClient -- the
// mutation side is pinned as the invalidate, the same invalidateQueries the
// sidebar's remove onSuccess fires (WorkspaceSidebarSection.tsx); if that
// call site changes its invalidation strategy, these pins must be
// re-checked against it. The second test pins the guard's browse-survival
// half; the last two pin the degraded hold: a registry read failure lists
// empty WITHOUT dropping the staged pick, and the judgment resumes on the
// next healthy listing (a removal arriving with the recovery still resets).

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
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [
        { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
      ],
      degraded: false,
    });
    const { onReset, queryClient, view } = renderSweep(null);

    // Unstaged mount: the listing query stays disabled, zero IPC.
    expect(listWorkspaces).not.toHaveBeenCalled();

    // Stage the pick: the query enables, fetches, and the listing lands --
    // the "once-listed" baseline. Await the DATA, not the fetcher call: the
    // sweep's baseline is the effect that ran over the first listing.
    view.rerender({ staged: { path: "/w/alpha", label: "alpha" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(workspaceKeys.all())).toEqual({
          workspaces: [
            { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
          ],
          degraded: false,
        }),
      );
    });
    expect(onReset).not.toHaveBeenCalled();

    // The sidebar remove landed: its invalidation refetches the shared key
    // and the record is gone (a single-record registry losing its only
    // record -- the degradation hold must never mask THIS).
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [],
      degraded: false,
    });
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
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [],
      degraded: false,
    });
    const { onReset, queryClient, view } = renderSweep(null);

    view.rerender({ staged: { path: "/w/local", label: "local" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(workspaceKeys.all())).toEqual({
          workspaces: [],
          degraded: false,
        }),
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
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [
        { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
        { path: "/w/beta", label: "beta", explicit: true, exists: true },
      ],
      degraded: false,
    });
    const { onReset, queryClient, view } = renderSweep(null);

    view.rerender({ staged: { path: "/w/alpha", label: "alpha" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryData<WorkspaceListing>(workspaceKeys.all())
            ?.workspaces,
        ).toHaveLength(2),
      );
    });

    // The user staged alpha but removed beta: the fresh listing still
    // carries alpha, so the staged pick survives.
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [
        { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
      ],
      degraded: false,
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(onReset).not.toHaveBeenCalled();
  });

  it("holds the staged pick through a degraded listing", async () => {
    // Issue #1481: a registry read failure (corrupt file, version rollback,
    // a locked file) lists EMPTY -- wire-indistinguishable from "every
    // record was removed" without the degraded flag. The sweep must hold
    // its judgment (and its once-listed baseline) through the failure.
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [
        { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
      ],
      degraded: false,
    });
    const { onReset, queryClient, view } = renderSweep(null);

    view.rerender({ staged: { path: "/w/alpha", label: "alpha" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryData<WorkspaceListing>(workspaceKeys.all())
            ?.workspaces,
        ).toHaveLength(1),
      );
    });

    // The registry goes unreadable: the refetch degrades to an empty
    // listing. The still-valid pick must survive it.
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [],
      degraded: true,
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(onReset).not.toHaveBeenCalled();

    // The read recovers with the record still there: no reset either -- the
    // degraded window neither cleared the pick nor polluted the baseline.
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [
        { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
      ],
      degraded: false,
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(3));
    expect(onReset).not.toHaveBeenCalled();
  });

  it("resumes the removal judgment once a healthy listing returns", async () => {
    // The other half of the degraded hold (issue #1481): holding through a
    // read failure must not become a permanent grace period. The removal
    // that arrives WITH the recovery still resets -- the flag channel must
    // never mask the sweep's primary behavior (#1479).
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [
        { path: "/w/alpha", label: "alpha", explicit: true, exists: true },
      ],
      degraded: false,
    });
    const { onReset, queryClient, view } = renderSweep(null);

    view.rerender({ staged: { path: "/w/alpha", label: "alpha" } });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          queryClient.getQueryData<WorkspaceListing>(workspaceKeys.all())
            ?.workspaces,
        ).toHaveLength(1),
      );
    });

    // A degraded window passes over the staged pick -- held, not cleared.
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [],
      degraded: true,
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    await waitFor(() => expect(listWorkspaces).toHaveBeenCalledTimes(2));
    expect(onReset).not.toHaveBeenCalled();

    // The recovery listing no longer carries the record: a real removal --
    // the judgment resumes and the pick resets.
    vi.mocked(listWorkspaces).mockResolvedValue({
      workspaces: [],
      degraded: false,
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
    });
    await waitFor(() => expect(onReset).toHaveBeenCalledWith(null));

    view.rerender({ staged: null });
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
