import { act, renderHook, waitFor } from "@testing-library/react";
import { createIntl } from "react-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogFor } from "../../i18n";
import type { SessionMetadata } from "../../types/session";

// Issue #195: usePersistedSessions owns the list_sessions advisory state
// (ADR-0068 -- React useState + sessionsEpoch, NOT TanStack Query). The hook
// fires list_sessions on mount, surfaces a reject into sessionsError, and
// re-fetches when refreshSessions bumps sessionsEpoch. importOriginal keeps the
// real fmtError (a pure helper) while the Tauri invoke wrapper is stubbed.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, listSessions: vi.fn() };
});

// The hook logs an unmount-race reject through the structured sink; mock it so
// the fail-open log.warn is assertable (issue #203).
vi.mock("../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { listSessions } from "../../api";
import { log } from "../../lib/log";
import { usePersistedSessions } from "../usePersistedSessions";

const intl = createIntl({ locale: "en-US", messages: catalogFor("en-US") });

const SESSION_A: SessionMetadata = {
  duck_path: "/x/a.duck",
  display_name: "A",
  last_modified_at: 1000,
  source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
  format_version: 1,
};

describe("usePersistedSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads list_sessions on mount and surfaces the list", async () => {
    vi.mocked(listSessions).mockResolvedValue([SESSION_A]);
    const { result } = renderHook(() => usePersistedSessions({ intl }));
    await waitFor(() => expect(result.current.sessions).toEqual([SESSION_A]));
    expect(result.current.sessionsError).toBeNull();
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("captures a list_sessions reject into sessionsError (not thrown, list stays empty)", async () => {
    vi.mocked(listSessions).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => usePersistedSessions({ intl }));
    await waitFor(() => expect(result.current.sessionsError).not.toBeNull());
    // The list stays empty; the error message surfaces the reject verbatim.
    expect(result.current.sessions).toEqual([]);
    expect(result.current.sessionsError).toMatch(/boom/);
  });

  it("refreshSessions bumps the epoch and re-fetches list_sessions (ADR-0068 manual invalidate)", async () => {
    // Pins the advisory-state contract: sessionsEpoch is the single-consumer
    // manual invalidate knob (NOT a Query invalidate). A regression that drops
    // the epoch from the effect deps, or stops bumping it on refresh, leaves a
    // save/delete/rename stale on the sidebar until a remount.
    vi.mocked(listSessions).mockResolvedValue([]);
    const { result } = renderHook(() => usePersistedSessions({ intl }));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    act(() => result.current.refreshSessions());
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    // refreshSessions identity is stable (raw useCallback with no deps) so App
    // handlers that close over it do not churn.
    const first = result.current.refreshSessions;
    act(() => result.current.refreshSessions());
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(3));
    expect(result.current.refreshSessions).toBe(first);
  });

  it("refreshSessions in flight does not blank the list mid-fetch (stale-then-refetch)", async () => {
    // A refresh in flight must NOT blank the sidebar mid-flight -- the previous
    // list stays visible until the new one lands, mirroring stale-then-refetch.
    let resolveList: (list: SessionMetadata[]) => void = () => {};
    vi.mocked(listSessions).mockImplementation(
      () => new Promise((r) => { resolveList = r; }),
    );
    const { result } = renderHook(() => usePersistedSessions({ intl }));
    // First fetch lands SESSION_A.
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    resolveList([SESSION_A]);
    await waitFor(() => expect(result.current.sessions).toEqual([SESSION_A]));
    // Second fetch stays pending; sessions stays at [SESSION_A] (no blank).
    let resolveSecond: (list: SessionMetadata[]) => void = () => {};
    vi.mocked(listSessions).mockImplementationOnce(
      () => new Promise((r) => { resolveSecond = r; }),
    );
    act(() => result.current.refreshSessions());
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));
    expect(result.current.sessions).toEqual([SESSION_A]);
    resolveSecond([]);
    await waitFor(() => expect(result.current.sessions).toEqual([]));
  });

  it("logs a list_sessions reject that lands after unmount (fail-open stays observable, #203)", async () => {
    // The cancelled flag correctly skips setSessionsError after unmount, but the
    // reject itself must not vanish silently -- a deterministic reader failure
    // (DuckDB reader break, etc.) would otherwise stay hidden until the next app
    // open. The fail-open branch logs at warn so the dropped reject is still
    // observable in devtools.
    let rejectList: (e: unknown) => void = () => {};
    vi.mocked(listSessions).mockImplementation(
      () => new Promise((_resolve, reject) => { rejectList = reject; }),
    );
    const { unmount } = renderHook(() => usePersistedSessions({ intl }));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      rejectList(new Error("reader broke"));
    });
    expect(log.warn).toHaveBeenCalledWith(
      "listSessions",
      expect.any(String),
      expect.anything(),
    );
  });
});
