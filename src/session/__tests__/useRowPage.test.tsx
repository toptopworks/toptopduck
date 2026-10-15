import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tests for useRowPage (the row-page seam, issue #1079) -- the AUTHORITY
// layer for the thread-side paged read's query contract: the offset-in-key
// cache shape, the snapshot posture (staleTime/gcTime Infinity -- no
// refetch on remount, no eviction while the session lives), the
// keepPreviousData paging surface, retry:false, raw error pass-through,
// and late-response key isolation (the seqRef race guard this seam
// replaces; ResultView's component tests keep only the render contract).
// Runs offline via vi.mock on the api entry.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, readRows: vi.fn() };
});

import { readRows } from "../../api";
import { useRowPage } from "../useRowPage";
import type { RowPage } from "../../types/dataset";

function page(offset: number): RowPage {
  return {
    columns: [{ name: "id", canonical_type: "BIGINT" }],
    rows: [[`r${offset}`]],
    total: offset + 2,
    offset,
    limit: 2,
  };
}

// A deliberately BARE client (v5 defaults: staleTime 0, retry 3) -- the
// module's own options must carry the contract, not the harness. A pin
// that passes here proves the option is set at the seam, not inherited
// from friendly defaultOptions (the useWorkingSet harness precedent
// configures the client instead; this seam's contract is stricter).
// The optional client parameter lets the remount pin share one cache
// across two renderHook mounts (a fresh client would be an empty cache).
function setup(queryClient = new QueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(
    ({ offset, ref }: { offset: number; ref: string }) =>
      useRowPage("sess-1", ref, offset, 2),
    { wrapper, initialProps: { offset: 0, ref: "result_1" } },
  );
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useRowPage", () => {
  it("keys each offset as its own page: turning back to a fetched page serves the cache, no refetch", async () => {
    // The offset-in-key shape (ADR-0051 row pages): every window is its own
    // cache entry, so paging back is instant and readRows fires exactly
    // once per window.
    vi.mocked(readRows).mockResolvedValue(page(0));
    const { result, rerender } = setup();
    await waitFor(() =>
      expect(vi.mocked(readRows)).toHaveBeenCalledWith("sess-1", "result_1", 0, 2),
    );
    rerender({ offset: 2, ref: "result_1" });
    await waitFor(() =>
      expect(vi.mocked(readRows)).toHaveBeenCalledWith("sess-1", "result_1", 2, 2),
    );
    rerender({ offset: 0, ref: "result_1" });
    await waitFor(() => expect(result.current.page).toEqual(page(0)));
    expect(readRows).toHaveBeenCalledTimes(2);
  });

  it("does not refetch on remount (staleTime/gcTime Infinity -- a snapshot never goes stale)", async () => {
    // The snapshot contract's teeth: with the bare client's staleTime 0 a
    // remount would refetch -- that is the half this pin discriminates.
    // gcTime's 5-minute default never evicts inside a test's lifetime, so
    // the eviction half is not observable here; both options are pinned to
    // Infinity at the seam, and the session's slice sweep drops the cache.
    vi.mocked(readRows).mockResolvedValue(page(0));
    const sharedClient = new QueryClient();
    const first = setup(sharedClient);
    await waitFor(() => expect(first.result.current.page).not.toBeNull());
    first.unmount();
    const second = setup(sharedClient);
    // The cached page is served with no pending window and no new fetch.
    expect(second.result.current.page).toEqual(page(0));
    expect(second.result.current.firstLoadPending).toBe(false);
    expect(readRows).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous page on screen while the next offset is in flight (keepPreviousData)", async () => {
    // The #773 paging surface: an in-flight turn keeps the last real page
    // rendered instead of clearing to empty -- the count bar's "no
    // clear-flash" contract rides this placeholder.
    let resolveNext: (p: RowPage) => void = () => {};
    vi.mocked(readRows)
      .mockResolvedValueOnce(page(0))
      .mockImplementationOnce(
        () => new Promise<RowPage>((resolve) => {
          resolveNext = resolve;
        }),
      );
    const { result, rerender } = setup();
    await waitFor(() => expect(result.current.page).toEqual(page(0)));
    rerender({ offset: 2, ref: "result_1" });
    expect(result.current.page).toEqual(page(0)); // placeholder, not null
    expect(result.current.inFlight).toBe(true);
    resolveNext(page(2));
    await waitFor(() => expect(result.current.page).toEqual(page(2)));
  });

  it("fails after exactly one call (retry: false -- a read reject surfaces immediately)", async () => {
    // The bare client's default retries 3 times; the seam must not -- a
    // read failure lands on the error surface now (kind `read`, issue
    // #194), never after a blind retry delay.
    vi.mocked(readRows).mockRejectedValue(new Error("read boom"));
    const { result } = setup();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(readRows).toHaveBeenCalledTimes(1);
    // Settling is success OR failure (issue #773): an errored first load
    // still clears the pending window.
    expect(result.current.firstLoadPending).toBe(false);
  });

  it("passes the reject through raw (identity) -- formatting belongs to the consumer", async () => {
    // Tauri IPC rejects with the raw serialized error, not an Error; the
    // seam must hand the consumer the same object untouched (the
    // toAppError call stays at the render site, the sampleError
    // pass-through precedent).
    const reject = { kind: "RowRead", data: { kind: "UnknownReference" } };
    vi.mocked(readRows).mockRejectedValue(reject);
    const { result } = setup();
    await waitFor(() => expect(result.current.error).toBe(reject));
  });

  it("a late-arriving page lands on its own key and never overwrites the current window", async () => {
    // The seqRef race guard's replacement: the offset is part of the key,
    // so a superseded response writes a cache entry nothing observes --
    // isolation by construction, not by a hand-rolled sequence check.
    let resolveFirst: (p: RowPage) => void = () => {};
    vi.mocked(readRows)
      .mockImplementationOnce(
        () =>
          new Promise<RowPage>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(page(2));
    const { result, rerender } = setup();
    rerender({ offset: 2, ref: "result_1" });
    await waitFor(() => expect(result.current.page).toEqual(page(2)));
    resolveFirst(page(0)); // the superseded offset-0 response lands late
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.page).toEqual(page(2));
  });

  it("a late page for a switched-away reference never overwrites the new reference's window", async () => {
    // The result-switch twin of the race guard: switching references while
    // the old reference's page-0 is pending, then letting the stale
    // response land, must leave the new reference's rows on screen. The
    // new reference's page carries a distinguishable value so the assertion
    // cannot pass on the stale page itself.
    let resolveOld: (p: RowPage) => void = () => {};
    vi.mocked(readRows).mockImplementation((_sid, ref) => {
      if (ref === "result_1") {
        return new Promise<RowPage>((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve(page(2));
    });
    const { result, rerender } = setup();
    rerender({ offset: 0, ref: "result_2" });
    await waitFor(() => expect(result.current.page).toEqual(page(2)));
    resolveOld(page(0));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.page).toEqual(page(2));
    // The stale response went to the old reference's own key.
    expect(result.current.inFlight).toBe(false);
  });
});
