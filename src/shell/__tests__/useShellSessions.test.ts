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

// The hook logs closeOpen / recordRecentFile / onResumeProgress outcomes through
// the structured sink; mock it so the closeOpen kind-triage and the recents /
// resume defensive catches are assertable (issue #203).
vi.mock("../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  closeSession,
  createSession,
  openDuck,
  onResumeProgress,
  recordRecentFile,
} from "../../api";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { log } from "../../lib/log";
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

  // --- Issue #203: silent-failure chain in the session hooks ----------------

  it("closeOpen logs debug (not error) on a NotFound reject -- the idempotent path (#203)", async () => {
    // NotFound is the expected outcome when the session already dropped (a
    // double-close, or a close racing a delete's wait-release): debug-level, and
    // NOT an error, so the idempotent path stays quiet in devtools.
    vi.mocked(createSession).mockResolvedValueOnce("s1");
    vi.mocked(closeSession).mockRejectedValueOnce({ kind: "NotFound" });
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(log.debug).toHaveBeenCalledWith(
      "closeSession",
      expect.any(String),
      "s1",
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  it("closeOpen logs error with sid + kind on a non-NotFound reject (panic / lock leak, #203)", async () => {
    // A non-NotFound reject (panic, lock poison, canonical single-writer leak)
    // must surface at error level with the sid + raw kind so the cause of a
    // later deletePersisted try_acquire gate miss stays diagnosable.
    vi.mocked(createSession).mockResolvedValueOnce("s1");
    vi.mocked(closeSession).mockRejectedValueOnce({
      kind: "Engine",
      data: "lock poison",
    });
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(log.error).toHaveBeenCalledWith(
      "closeSession",
      expect.any(String),
      "s1",
      "Engine",
      expect.any(String),
      "lock poison",
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("handleSaveAs refreshes sessions + warns even when recordRecentFile rejects (#203)", async () => {
    // The recents IPC is best-effort: a reject must NOT block the sidebar
    // refresh or escape as an unhandled rejection. refreshSessions fires via
    // .finally regardless, and the reject is logged at warn.
    vi.mocked(createSession).mockResolvedValueOnce("s1");
    vi.mocked(saveDialog).mockResolvedValueOnce("/x/a.duck");
    vi.mocked(recordRecentFile).mockRejectedValueOnce(
      new Error("recents IPC down"),
    );
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.handleSaveAs();
    });
    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "recordRecentFile",
      expect.any(String),
      expect.anything(),
    );
  });

  it("handleOpenDuck refreshes sessions + warns even when recordRecentFile rejects (#203)", async () => {
    vi.mocked(openDialog).mockResolvedValueOnce("/x/a.duck");
    vi.mocked(createSession).mockResolvedValueOnce("o1");
    vi.mocked(openDuck).mockResolvedValueOnce();
    vi.mocked(recordRecentFile).mockRejectedValueOnce(
      new Error("recents IPC down"),
    );
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.handleOpenDuck();
    });
    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "recordRecentFile",
      expect.any(String),
      expect.anything(),
    );
  });

  it("openPersisted survives a throw inside the onResumeProgress listener (defensive try/catch, #203)", async () => {
    // Capture the listener Tauri would invoke, then fire a malformed event whose
    // body access throws (null event -> "Source" in null raises a TypeError).
    // The defensive catch MUST swallow it -- no throw escapes and log.error
    // records it -- or the shell soft-locks with busy stuck true (#203 AC3).
    let resumeCb: ((ev: unknown) => void) | null = null;
    vi.mocked(onResumeProgress).mockImplementationOnce(async (cb) => {
      resumeCb = cb as unknown as (ev: unknown) => void;
      return () => {};
    });
    vi.mocked(createSession).mockResolvedValueOnce("r1");
    vi.mocked(openDuck).mockResolvedValueOnce();
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openPersisted("/x/a.duck", "a");
    });
    // Happy path completed: session registered, resume cleared (no soft-lock).
    expect(result.current.activeSessionId).toBe("r1");
    expect(result.current.resumeStatus).toBeNull();
    // Fire the malformed event: the catch swallows the throw (no escape).
    expect(resumeCb).not.toBeNull();
    await act(async () => {
      expect(() => resumeCb!({ session_id: "r1", event: null })).not.toThrow();
    });
    expect(log.error).toHaveBeenCalledWith(
      "onResumeProgress",
      expect.any(String),
      expect.anything(),
    );
  });
});
