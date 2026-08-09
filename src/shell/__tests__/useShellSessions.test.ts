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
// isolation from <App>. The api mock stubs the Tauri invoke wrappers; the
// reject path runs the real toAppError + fmtError (imported from
// lib/error-presentation, outside the api mock).

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

// The drop-listener effect registers onDragDropEvent on mount (busy=false) and
// tears it down when busy flips true (issue #204 busy-gate). The hoisted slot
// captures the registered callback + clears it on unlisten so a test can assert
// listener (un)registration and fire a synthetic drop payload. Other tests
// exercise routing via onWebviewDrop directly and ignore the slot.
type DragDropEvent = { payload: { type: string; paths: string[] } };
const dropListener = vi.hoisted(() => ({
  current: null as ((event: DragDropEvent) => void) | null,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: (cb: (event: DragDropEvent) => void) => {
      dropListener.current = cb;
      return Promise.resolve(() => {
        dropListener.current = null;
      });
    },
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
    renamePersistedSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ""),
    saveAsDuck: vi.fn(async () => {}),
  };
});

// The hook logs closeOpen / onResumeProgress outcomes through the structured
// sink; mock it so the closeOpen kind-triage and the resume defensive catches
// are assertable (issue #203).
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
  renamePersistedSession,
  renameSession,
  saveAsDuck,
} from "../../api";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { log } from "../../lib/log";
import { useShellSessions } from "../useShellSessions";

const intl = createIntl({ locale: "en-US", messages: catalogFor("en-US") });

/** Build a CreateSessionReply for mock returns (ADR-0089). */
function reply(sid: string) {
  return { session_id: sid, duck_path: `/sessions/${sid}/session.duck` };
}

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
    // RTL auto-cleanup unmounts the prior hook (clearing the slot via the
    // listener's unlisten), but reset defensively so a test starts from null.
    dropListener.current = null;
  });

  it("starts cold: empty open set, null active id, not busy", () => {
    const { result } = renderSessions();
    expect(result.current.openSessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.activeSession).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.resumeStatus).toEqual({ kind: "idle" });
  });

  it("openNew mints + registers + activates a session", async () => {
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(result.current.openSessions).toHaveLength(1);
    expect(result.current.openSessions[0]).toMatchObject({
      sid: "s1",
      name: "",
      path: "/sessions/s1/session.duck",
      pendingIngestPath: null,
    });
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.activeSession?.sid).toBe("s1");
  });

  it("onWebviewDrop on cold start (activeSessionId null) mints via dropFile with the path as pendingIngestPath (#81 A1)", async () => {
    vi.mocked(createSession).mockResolvedValue(reply("drop-sid"));
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
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
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
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
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
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
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
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
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
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
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
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
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

  it("handleSaveAs refreshes sessions after a successful export (ADR-0089)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    vi.mocked(saveDialog).mockResolvedValueOnce("/x/a.duck");
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.handleSaveAs();
    });
    expect(refreshSessions).toHaveBeenCalled();
  });

  it("handleOpenDuck refreshes sessions after a successful resume (ADR-0089)", async () => {
    vi.mocked(openDialog).mockResolvedValueOnce("/x/a.duck");
    vi.mocked(createSession).mockResolvedValueOnce(reply("o1"));
    vi.mocked(openDuck).mockResolvedValueOnce();
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.handleOpenDuck();
    });
    expect(refreshSessions).toHaveBeenCalled();
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
    vi.mocked(createSession).mockResolvedValueOnce(reply("r1"));
    vi.mocked(openDuck).mockResolvedValueOnce();
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openPersisted("/x/a.duck", "a");
    });
    // Happy path completed: session registered, resume cleared (no soft-lock).
    expect(result.current.activeSessionId).toBe("r1");
    expect(result.current.resumeStatus).toEqual({ kind: "idle" });
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

  // --- Issue #204: hook-level coverage gaps --------------------------------
  // These pin the concurrency + branch contracts a regression would silently
  // break (no black-box signal): the busy-gated drop listener, the in-flight
  // double-drop guard, the renameEntry closed / reject / blank branches, the
  // dialog-cancel paths, and the multi-session active-id fallback.

  it("suppresses a webview drop while busy and routes it once busy clears (#204)", async () => {
    // The drop-listener effect early-returns while busy, so a drop during a
    // persistence wait cannot mint a session; the effect re-binds on clear so a
    // later drop routes normally. Drive both halves through the bound Tauri
    // listener (the real event seam) and assert on the observable mint, not on
    // listener bookkeeping.
    let resolveDialog: (v: string | null) => void = () => {};
    vi.mocked(openDialog).mockImplementation(
      () => new Promise<string | null>((resolve) => { resolveDialog = resolve; }),
    );
    vi.mocked(createSession).mockResolvedValue(reply("drop-sid"));
    const { result } = renderSessions();
    // Enter busy: handleOpenDuck holds persistenceBusy true while openDialog
    // is pending (cold start -> activeSessionId null -> a routed drop mints).
    act(() => {
      void result.current.handleOpenDuck();
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    // While busy the listener is unbound, so a drop payload has nowhere to
    // route -- the cold-start mint never fires (the suppress half).
    await waitFor(() => expect(dropListener.current).toBeNull());
    expect(createSession).not.toHaveBeenCalled();
    // Cancel the dialog -> busy clears -> the effect re-binds the listener.
    await act(async () => {
      resolveDialog(null);
    });
    await waitFor(() => expect(result.current.busy).toBe(false));
    // The re-bound listener now routes a drop to dropFile -> createSession
    // (the re-bind half): fire the payload through the bound seam.
    await waitFor(() => expect(dropListener.current).not.toBeNull());
    await act(async () => {
      dropListener.current!({ payload: { type: "drop", paths: ["/x/a.csv"] } });
    });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(result.current.activeSessionId).toBe("drop-sid");
  });

  it("ignores a second drop while createSession is in flight and re-arms after it resolves (#204)", async () => {
    // A second cold-start drop while the first createSession is still in flight
    // is ignored (no second mint); the guard re-arms once the first mint
    // resolves, so a later drop mints again.
    let resolveCreate: (val: { session_id: string; duck_path: string }) => void = () => {};
    vi.mocked(createSession).mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );
    const { result } = renderSessions();
    // First drop: createSession pending, droppingRef held true.
    act(() => {
      void result.current.dropFile("/a");
    });
    // Second drop while the first is in flight: guarded, no second mint.
    act(() => {
      void result.current.dropFile("/b");
    });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // Resolve the first mint: droppingRef releases in the finally block.
    await act(async () => {
      resolveCreate(reply("s1"));
    });
    await waitFor(() => expect(result.current.activeSessionId).toBe("s1"));
    // The guard has re-armed: a subsequent drop mints again.
    vi.mocked(createSession).mockResolvedValueOnce(reply("s2"));
    await act(async () => {
      await result.current.dropFile("/c");
    });
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(result.current.openSessions).toHaveLength(2);
  });

  it("renameEntry rewrites a closed .duck header via renamePersistedSession + refreshes (closed branch, #204)", async () => {
    // The closed branch (sid=null, path set) rewrites the recipe header in place
    // by path, then refreshes the sidebar so list_sessions re-derives the name.
    vi.mocked(renamePersistedSession).mockResolvedValueOnce();
    const { result, refreshSessions, setShellError } = renderSessions();
    await act(async () => {
      await result.current.renameEntry(null, "/x/foo.duck", "new");
    });
    expect(renamePersistedSession).toHaveBeenCalledWith("/x/foo.duck", "new");
    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(setShellError).not.toHaveBeenCalled();
  });

  it("renameEntry surfaces a renamePersistedSession reject via setShellError and skips refresh (closed branch, #204)", async () => {
    // The catch returns BEFORE refreshSessions fires, so the sidebar never lists
    // a name the backend just rejected -- the next list_sessions re-derives the
    // on-disk truth instead.
    vi.mocked(renamePersistedSession).mockRejectedValueOnce(
      new Error("rename rejected"),
    );
    const { result, refreshSessions, setShellError } = renderSessions();
    await act(async () => {
      await result.current.renameEntry(null, "/x/foo.duck", "new");
    });
    expect(renamePersistedSession).toHaveBeenCalledWith("/x/foo.duck", "new");
    expect(setShellError).toHaveBeenCalledTimes(1);
    expect(refreshSessions).not.toHaveBeenCalled();
  });

  it("renameEntry trims input and bails on whitespace-only (no IPC, no refresh, #204)", async () => {
    // The trim guard runs before either branch: a blank name skips
    // renameSession / renamePersistedSession AND refreshSessions, so an
    // accidental empty rename cannot trigger a spurious sidebar re-fetch.
    const { result, refreshSessions, setShellError } = renderSessions();
    await act(async () => {
      await result.current.renameEntry("s1", "/sessions/s1/session.duck", "   ");
    });
    expect(renameSession).not.toHaveBeenCalled();
    expect(renamePersistedSession).not.toHaveBeenCalled();
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(setShellError).not.toHaveBeenCalled();
  });

  it("handleSaveAs bails on a cancelled save dialog (null path): no save, no extra refresh, busy clears (#204)", async () => {
    // saveDialog returning null is the cancel path: the hook returns inside the
    // try, the finally still clears persistenceBusy. saveAsDuck does not fire;
    // refreshSessions was called once by openNew (ADR-0089) but NOT again by
    // the cancelled handleSaveAs.
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    vi.mocked(saveDialog).mockResolvedValueOnce(null);
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    const callsAfterOpen = refreshSessions.mock.calls.length;
    await act(async () => {
      await result.current.handleSaveAs();
    });
    expect(saveAsDuck).not.toHaveBeenCalled();
    expect(refreshSessions.mock.calls.length).toBe(callsAfterOpen);
    expect(result.current.busy).toBe(false);
  });

  it("handleOpenDuck bails on a cancelled open dialog (null path): no open, no refresh, busy clears (#204)", async () => {
    vi.mocked(openDialog).mockResolvedValueOnce(null);
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.handleOpenDuck();
    });
    expect(openDuck).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("closeOpen falls back to the FIRST remaining session when the active one closes (multi-session, #204)", async () => {
    // Closing the ACTIVE session falls back to the first remaining entry
    // (next[0]?.sid) -- NOT null and NOT the last entry. The single-session
    // closeOpen test above only covers the -> null path; three sessions pin the
    // first-entry semantics so a regression to next[last] is caught (ADR-0060).
    vi.mocked(createSession)
      .mockResolvedValueOnce(reply("s1"))
      .mockResolvedValueOnce(reply("s2"))
      .mockResolvedValueOnce(reply("s3"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.openNew();
    });
    expect(result.current.activeSessionId).toBe("s3");
    await act(async () => {
      await result.current.closeOpen("s3");
    });
    expect(result.current.openSessions).toHaveLength(2);
    expect(result.current.activeSessionId).toBe("s1");
  });

  // --- Issue #205: type-invariant tightening -------------------------------
  // These pin the domain decision + the merged-state invariant the refactor
  // introduced, on paths the earlier black-box-style tests do not exercise.

  it("onWebviewDrop routes a drop onto an active PERSISTED session -- path + pendingIngestPath coexist (#205)", async () => {
    // Domain decision (issue #205): a drop onto an ALREADY-active session
    // routes to that session's ingest even when the session is resumed /
    // .duck-bound (path !== null). `path` and `pendingIngestPath` are
    // independent -- the resumed + pending-drop combination is legal, not a
    // type error. This pins the decision so a future "tighten OpenSession into
    // a discriminated union" refactor cannot silently break the active-session
    // drop route (#81 A1).
    vi.mocked(createSession).mockResolvedValueOnce(reply("p1"));
    vi.mocked(openDuck).mockResolvedValueOnce();
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openPersisted("/x/a.duck", "a");
    });
    expect(result.current.activeSessionId).toBe("p1");
    expect(result.current.openSessions[0]).toMatchObject({
      sid: "p1",
      path: "/x/a.duck",
      pendingIngestPath: null,
    });
    const mintsBefore = vi.mocked(createSession).mock.calls.length;
    // Drop while the persisted p1 is active -> routes to p1's ingest pipe, no
    // new mint, and pendingIngestPath now coexists with a bound path.
    act(() => {
      result.current.onWebviewDrop("/x/drop.csv");
    });
    expect(vi.mocked(createSession).mock.calls.length).toBe(mintsBefore);
    expect(result.current.openSessions[0]).toMatchObject({
      sid: "p1",
      path: "/x/a.duck",
      pendingIngestPath: "/x/drop.csv",
    });
  });

  it("closeOpen on a NON-active session leaves the active id unchanged (merged-state invariant, #205)", async () => {
    // The merged { sessions, activeId } state enforces activeId ∈ sessions at
    // the single `apply` chokepoint. Closing a session that is NOT the active
    // one must keep the active id exactly as-is (not flip, not dangle, not fall
    // back). This is the path the active-close fallback test above does NOT
    // cover, and the most likely regression vector for the unmountOpen
    // refactor's reconciliation.
    vi.mocked(createSession)
      .mockResolvedValueOnce(reply("s1"))
      .mockResolvedValueOnce(reply("s2"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.openNew();
    });
    expect(result.current.activeSessionId).toBe("s2");
    // Close the NON-active s1 -> active id stays on s2.
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(closeSession).toHaveBeenCalledWith("s1");
    expect(result.current.openSessions).toHaveLength(1);
    expect(result.current.openSessions[0].sid).toBe("s2");
    expect(result.current.activeSessionId).toBe("s2");
    expect(result.current.activeSession?.sid).toBe("s2");
  });

  it("activateSession switches on a valid sid and no-ops on a stale sid (reconciler invariant, #205)", async () => {
    // activateSession is the only public standalone active-id mutator, and the
    // sole route onto the reconciler's stale-id branch (next.activeId !== null
    // && !sessions.some(...)). A valid sid switches; a stale sid (a sidebar
    // click racing a close, or a sid never in the set) is a no-op that keeps
    // the current active id rather than silently jumping to sessions[0]. This
    // pins the merged-state contract the refactor introduced.
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1")).mockResolvedValueOnce(reply("s2"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.openNew();
    });
    await act(async () => {
      await result.current.openNew();
    });
    expect(result.current.activeSessionId).toBe("s2");
    // Valid sid -> switch.
    act(() => {
      result.current.activateSession("s1");
    });
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.activeSession?.sid).toBe("s1");
    // Stale sid -> no-op; active id stays on s1 (not "ghost", not sessions[0]).
    act(() => {
      result.current.activateSession("ghost");
    });
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.activeSession?.sid).toBe("s1");
    // Invariant holds: activeId ∈ sessions.
    expect(
      result.current.openSessions.some((s) => s.sid === result.current.activeSessionId),
    ).toBe(true);
  });
});
