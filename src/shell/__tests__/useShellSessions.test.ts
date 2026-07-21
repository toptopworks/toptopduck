import { act, renderHook, waitFor } from "@testing-library/react";
import { createIntl } from "react-intl";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogFor } from "../../i18n";

// Issue #195: useShellSessions owns the runtime OPEN set + every mutating
// action. These tests pin the contracts hardest to assert through the App
// black-box (Shell.test.tsx): registerOpen + activate, onWebviewDrop routing
// (cold-start vs active), clearPendingIngest, and closeOpen's synchronous
// unmount + background closeSession. The deps (intl, queryClient,
// refreshSessions, setShellError) are injected, so the hook is exercised in
// isolation from <App>. importOriginal keeps the pure helpers (describeReject
// / fmtError) real while the Tauri invoke wrappers are stubbed.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  // The drop-listener effect registers on mount (busy=false). A no-op unlisten
  // keeps jsdom off the real Tauri event bus; the routing logic is exercised
  // by calling onWebviewDrop directly.
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    createSession: vi.fn(),
    closeSession: vi.fn(async () => {}),
    closeSessionAndWaitRelease: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    onResumeProgress: vi.fn(async () => () => {}),
    openDuck: vi.fn(async () => {}),
    recordRecentFile: vi.fn(async () => {}),
    renamePersistedSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ""),
    saveAsDuck: vi.fn(async () => {}),
  };
});

import { closeSession, createSession } from "../../api";
import { useShellSessions } from "../useShellSessions";

const intl = createIntl({ locale: "en-US", messages: catalogFor("en-US") });

function renderSessions() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const refreshSessions = vi.fn();
  const setShellError = vi.fn();
  const helpers = renderHook(() =>
    useShellSessions({ intl, queryClient, refreshSessions, setShellError }),
  );
  return { ...helpers, refreshSessions, setShellError, queryClient };
}

describe("useShellSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts cold: empty open set, null active id, not busy", () => {
    const { result } = renderSessions();
    expect(result.current.openSessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.activeSession).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.resumeStatus).toBeNull();
  });

  it("openNew mints + registers + activates a session", async () => {
    vi.mocked(createSession).mockResolvedValue("s1");
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(result.current.openSessions).toHaveLength(1);
    expect(result.current.openSessions[0]).toMatchObject({
      sid: "s1",
      name: "",
      path: null,
      pendingIngestPath: null,
    });
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.activeSession?.sid).toBe("s1");
  });

  it("onWebviewDrop on cold start (activeSessionId null) mints via dropFile with the path as pendingIngestPath (#81 A1)", async () => {
    vi.mocked(createSession).mockResolvedValue("drop-sid");
    const { result } = renderSessions();
    expect(result.current.activeSessionId).toBeNull();
    act(() => {
      result.current.onWebviewDrop("/x/foo.csv");
    });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.activeSessionId).toBe("drop-sid"));
    expect(result.current.openSessions[0].pendingIngestPath).toBe("/x/foo.csv");
  });

  it("onWebviewDrop on an active session routes to its pendingIngestPath (no new mint, #81)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce("s1");
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    const mintsBefore = vi.mocked(createSession).mock.calls.length;
    // Drop while s1 is active -> the file lands on s1's ingest pipe, no new mint.
    act(() => {
      result.current.onWebviewDrop("/x/new.csv");
    });
    expect(vi.mocked(createSession).mock.calls.length).toBe(mintsBefore);
    expect(result.current.openSessions[0].pendingIngestPath).toBe("/x/new.csv");
  });

  it("clearPendingIngest drops the consumed path so a remount cannot re-ingest (#81 A1)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce("s1");
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    act(() => {
      result.current.onWebviewDrop("/x/new.csv");
    });
    expect(result.current.openSessions[0].pendingIngestPath).toBe("/x/new.csv");
    act(() => {
      result.current.clearPendingIngest("s1");
    });
    expect(result.current.openSessions[0].pendingIngestPath).toBeNull();
  });

  it("closeOpen unmounts synchronously + fires closeSession in the background (ADR-0055)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce("s1");
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(closeSession).toHaveBeenCalledWith("s1");
    expect(result.current.openSessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
  });

  it("closeOpen survives a closeSession reject without throwing (ADR-0055 .catch seam)", async () => {
    // closeOpen returns closeSession().catch(...) -- a reject MUST be swallowed
    // (not surface as an unhandled rejection). The session is already unmounted.
    vi.mocked(createSession).mockResolvedValueOnce("s1");
    vi.mocked(closeSession).mockRejectedValueOnce(new Error("backend gone"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(closeSession).toHaveBeenCalledWith("s1");
    expect(result.current.openSessions).toEqual([]);
  });
});
