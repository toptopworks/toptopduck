import { act, renderHook, waitFor } from "@testing-library/react";
import { createIntl } from "react-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogFor } from "../../i18n";
import type { SessionMetadata } from "../../types";

// Issue #195: usePersistedSessions owns the list_sessions advisory state
// (ADR-0068 -- React useState + sessionsEpoch, NOT TanStack Query). The hook
// fires list_sessions on mount, surfaces a reject into sessionsError, and
// re-fetches when refreshSessions bumps sessionsEpoch. importOriginal keeps the
// real fmtError (a pure helper) while the Tauri invoke wrapper is stubbed.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, listSessions: vi.fn() };
});

import { listSessions } from "../../api";
import { usePersistedSessions } from "../usePersistedSessions";

const intl = createIntl({ locale: "en-US", messages: catalogFor("en-US") });

const SESSION_A: SessionMetadata = {
  session_id: "/x/a.duck",
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
});
