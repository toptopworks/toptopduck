import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  useStartupUpdateCheck,
  useUpdateAvailable,
} from "../useUpdateCheck";
import { checkForUpdates } from "../../api";
import { updateKeys } from "../../session/queryKeys";

// The startup auto-check (ADR-0143, issue #1509): one silent check 1s after
// mount -- never earlier, never repeated, never surfacing a failure. The
// subscription half mirrors the shared cache slice without ever fetching.
// The async fake-timer advance (advanceTimersByTimeAsync) is what lets the
// fetchQuery microtasks settle between timer callbacks under faked time.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    checkForUpdates: vi.fn(),
  };
});

const mockedCheck = vi.mocked(checkForUpdates);

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

beforeEach(() => {
  mockedCheck.mockReset();
});

describe("useStartupUpdateCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not check before the 1s delay elapses", () => {
    const { wrapper } = makeWrapper();
    renderHook(useStartupUpdateCheck, { wrapper });

    act(() => {
      vi.advanceTimersByTime(999);
    });

    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("fires exactly one check at the 1s mark and caches the result", async () => {
    mockedCheck.mockResolvedValue({
      version: "0.5.0",
      notes: null,
      currentVersion: "0.4.0",
    });
    const { wrapper, queryClient } = makeWrapper();
    renderHook(useStartupUpdateCheck, { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockedCheck).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(updateKeys.check())).toEqual({
      version: "0.5.0",
      notes: null,
      currentVersion: "0.4.0",
    });
    // Single shot, no polling: another 10s of clock adds no second call.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedCheck).toHaveBeenCalledTimes(1);
  });

  it("swallows a failing check silently", async () => {
    mockedCheck.mockRejectedValue(new Error("offline"));
    const { wrapper, queryClient } = makeWrapper();
    renderHook(useStartupUpdateCheck, { wrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // The rejection never lands anywhere observable: no unhandled rejection
    // (which would fail the run), no cache entry.
    expect(mockedCheck).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(updateKeys.check())).toBeUndefined();
  });
});

describe("useUpdateAvailable", () => {
  it("mirrors the shared cache slice and never fetches on its own", () => {
    const { wrapper, queryClient } = makeWrapper();
    queryClient.setQueryData(updateKeys.check(), {
      version: "0.5.0",
      notes: "notes",
      currentVersion: "0.4.0",
    });

    const { result } = renderHook(useUpdateAvailable, { wrapper });

    expect(result.current).toEqual({
      version: "0.5.0",
      notes: "notes",
      currentVersion: "0.4.0",
    });
    // enabled: false -- the subscription must not have fired the queryFn.
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("reads null while the slice is empty (cold start before the check)", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(useUpdateAvailable, { wrapper });
    expect(result.current).toBeNull();
    expect(mockedCheck).not.toHaveBeenCalled();
  });
});
