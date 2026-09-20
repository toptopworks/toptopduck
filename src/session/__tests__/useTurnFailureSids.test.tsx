// Tests for useTurnFailureSids + isLatestTurnFailed (issue #1005) -- the
// sidebar's cross-session turn-failure view. The predicate tail-scans a
// thread for the latest settled turn; the hook derives the failed-sid set
// from the open sessions' thread query caches (read-only observers, never
// fetching -- each pane's own useQuery owns the fetch, so a thread never
// taken stays dark). Drives the hook through setQueryData on a real
// QueryClient, mirroring how the ask tail appends the optimistic TurnRecord.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../lib/queryClient";
import { conversation } from "../../api";
import { sessionKeys } from "../queryKeys";
import { isLatestTurnFailed, useTurnFailureSids } from "../useTurnFailureSids";
import { cancelled, failed, materialized, textual } from "./fixtures";
import type { ThreadEntry } from "../../types/thread";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    conversation: vi.fn(async (): Promise<ThreadEntry[]> => {
      throw new Error("the hook must never fetch (enabled: false)");
    }),
  };
});

// A source lifecycle event entry -- never a turn, so it must never displace
// the predicate's verdict nor light the hook.
function sourceAdded(referenceName: string): ThreadEntry {
  return {
    entry: "Source",
    data: { kind: "Added", reference_name: referenceName, display_name: referenceName },
  };
}

describe("isLatestTurnFailed", () => {
  it("reads false on an empty timeline", () => {
    expect(isLatestTurnFailed([])).toBe(false);
  });

  it("reads false when the timeline carries no turn at all (lifecycle events only)", () => {
    expect(isLatestTurnFailed([sourceAdded("r1"), sourceAdded("r2")])).toBe(false);
  });

  it("reads the latest turn's verdict, skipping trailing lifecycle events", () => {
    const entries = [materialized("r1"), failed("boom"), sourceAdded("r2")];
    expect(isLatestTurnFailed(entries)).toBe(true);
  });

  it("extinguishes once a newer turn settles non-Failed", () => {
    expect(isLatestTurnFailed([failed("boom"), textual("recovered")])).toBe(false);
  });

  it("reads false when the latest turn is Cancelled (a user action, not an error)", () => {
    expect(isLatestTurnFailed([failed("boom"), cancelled("stop")])).toBe(false);
  });

  it("reads true when the latest turn is Failed after a Cancelled one", () => {
    expect(isLatestTurnFailed([cancelled("stop"), failed("boom")])).toBe(true);
  });
});

describe("useTurnFailureSids", () => {
  let queryClient: ReturnType<typeof createQueryClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = createQueryClient();
  });

  afterEach(() => {
    queryClient.clear();
  });

  function renderSids(sids: string[]) {
    // The hook takes the client explicitly (no provider needed).
    return renderHook(() => useTurnFailureSids(queryClient, sids));
  }

  // TanStack's notifyManager queues observer notifications onto
  // systemSetTimeoutZero (one macrotask per batch), so the re-render the hook
  // derives from lands one timer tick after the cache write. One
  // deterministic tick flushes every queued update -- no polling, no sleep.
  async function flushNotifications() {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }

  it("keeps a cold session dark and never fetches its thread (live-only, enabled: false)", () => {
    const { result } = renderSids(["s1"]);
    expect(result.current.has("s1")).toBe(false);
    expect(vi.mocked(conversation)).not.toHaveBeenCalled();
  });

  it("lights a session whose cached thread's latest turn is Failed", async () => {
    const { result } = renderSids(["s1", "s2"]);
    act(() => {
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread("s2"), [failed("boom")]);
    });
    await flushNotifications();
    expect(result.current.has("s2")).toBe(true);
    expect(result.current.has("s1")).toBe(false);
  });

  it("extinguishes when a newer turn settles non-Failed (optimistic append updates the cache)", async () => {
    const { result } = renderSids(["s1"]);
    act(() => {
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread("s1"), [failed("boom")]);
    });
    await flushNotifications();
    expect(result.current.has("s1")).toBe(true);
    act(() => {
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread("s1"), [
        failed("boom"),
        textual("recovered"),
      ]);
    });
    await flushNotifications();
    expect(result.current.has("s1")).toBe(false);
  });

  it("never lights a Cancelled-only thread", async () => {
    const { result } = renderSids(["s1"]);
    act(() => {
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread("s1"), [cancelled("stop")]);
    });
    // The flush proves the hook SAW the cancelled thread and still keeps the
    // session dark (not merely that the update has not landed yet).
    await flushNotifications();
    expect(result.current.has("s1")).toBe(false);
  });

  it("drops a closed session when its sid leaves the open set (ADR-0055 close tab)", async () => {
    const view = renderHook(({ sids }) => useTurnFailureSids(queryClient, sids), {
      initialProps: { sids: ["s1"] },
    });
    act(() => {
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread("s1"), [failed("boom")]);
    });
    await flushNotifications();
    expect(view.result.current.has("s1")).toBe(true);
    // The close drops the open entry (the pane unmounts; removeQueries rides
    // the same close) -- the derive loses the row with the sid.
    view.rerender({ sids: [] });
    expect(view.result.current.has("s1")).toBe(false);
  });

  it("goes dark when a kept-open session's caches reset (the pane-level L2 reset)", async () => {
    const { result } = renderSids(["s1"]);
    act(() => {
      queryClient.setQueryData<ThreadEntry[]>(sessionKeys.thread("s1"), [failed("boom")]);
    });
    await flushNotifications();
    expect(result.current.has("s1")).toBe(true);
    // SessionPane's error-boundary reset clears the data while the sid stays
    // open; the row goes dark until the pane's refetch lands again.
    act(() => {
      void queryClient.resetQueries({ queryKey: sessionKeys.all("s1") });
    });
    await flushNotifications();
    expect(result.current.has("s1")).toBe(false);
  });
});
