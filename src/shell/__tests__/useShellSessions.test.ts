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
type DragDropEvent = {
  payload: { type: string; paths: string[]; position?: { x: number; y: number } };
};
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
    closeSession: vi.fn(async () => false),
    closeSessionAndWaitRelease: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    exportSession: vi.fn(async () => {}),
    onResumeProgress: vi.fn(async () => () => {}),
    openDuck: vi.fn(async () => {}),
    prepareImportSession: vi.fn(),
    renamePersistedSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => ""),
    getSessionName: vi.fn(async () => ""),
    // ADR-0092 cold-start posture application (runtime + auth mode + skill
    // mounts + MCP enables, all before registerOpen). Default no-ops; the
    // posture tests assert calls.
    setSessionRuntime: vi.fn(async () => {}),
    // The clean #529 persist verdict; fault-verdict tests override per case.
    setSessionPosture: vi.fn(async () => ({
      persist_error: null,
      persist_suspended: false,
    })),
    setAuthorizationMode: vi.fn(async () => {}),
    mountSkill: vi.fn(async () => {}),
    toggleMcpServer: vi.fn(async () => {}),
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
  exportSession,
  getSessionName,
  mountSkill,
  openDuck,
  onResumeProgress,
  prepareImportSession,
  renamePersistedSession,
  renameSession,
  setAuthorizationMode,
  setSessionPosture,
  setSessionRuntime,
  toggleMcpServer,
} from "../../api";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { log } from "../../lib/log";
import { mountComposerBarStub } from "../../__tests__/setup/barRectStub";
import { useShellSessions } from "../useShellSessions";
import type { PendingComposerPosture } from "../useShellSessions";
import { AUTH_MODE_DEFAULT } from "../../types/approval";

const intl = createIntl({ locale: "en-US", messages: catalogFor("en-US") });

// The backend-default composer posture. Passing it to the cold-start mint
// paths exercises the no-op posture branch (no runtime / auth-mode IPC):
// runtime null = the user never picked (the backend's own startup
// resolution already applies, issue #572).
const DEFAULT_POSTURE: PendingComposerPosture = {
  runtime: null,
  modelPosture: null,
  authMode: AUTH_MODE_DEFAULT,
  skills: [],
  mcpServers: [],
};

/** Build a CreateSessionReply for mock returns (ADR-0089). */
function reply(sid: string) {
  return { session_id: sid, duck_path: `/sessions/${sid}/session.duck` };
}

// The #501 drop tests pin the composer bar's geometry via the shared
// barRectStub (jsdom has no layout); jsdom's devicePixelRatio is 1, so CSS
// px == the physical drop positions the tests fire.
const BAR_RECT = { left: 100, top: 200, right: 400, bottom: 300 };

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
    // Drop any prior test's `.question-bar` hit-test stub (#501).
    document.body.innerHTML = "";
  });

  it("starts cold: empty open set, null active id, not busy", () => {
    const { result } = renderSessions();
    expect(result.current.openSessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.resumeStatus).toEqual({ kind: "idle" });
  });

  it("createSessionWithQuestion mints + registers + activates, carrying pendingQuestion", async () => {
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    let created = false;
    await act(async () => {
      created = await result.current.createSessionWithQuestion("how many rows?", DEFAULT_POSTURE, []);
    });
    expect(created).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(result.current.openSessions).toHaveLength(1);
    expect(result.current.openSessions[0]).toMatchObject({
      sid: "s1",
      name: "",
      path: "/sessions/s1/session.duck",
      pendingIngestPaths: [],
      pendingQuestion: "how many rows?",
    });
    expect(result.current.activeSessionId).toBe("s1");
  });

  it("createSessionWithQuestion applies a non-default posture BEFORE registering (ADR-0092 Decision 6)", async () => {
    // Ordering is the contract: the pane mounts (and fires a pendingQuestion)
    // only after registerOpen, so the posture writes must land BEFORE the
    // entry joins the open set for the first turn to run under them. Capture
    // the open-set size at the moment the runtime write lands.
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    let sessionsWhenRuntimeApplied = -1;
    vi.mocked(setSessionRuntime).mockImplementationOnce(async () => {
      sessionsWhenRuntimeApplied = result.current.openSessions.length;
    });
    await act(async () => {
      await result.current.createSessionWithQuestion("q", {
        runtime: { kind: "external", data: "gemini" },
        modelPosture: null,
        authMode: "no_confirmation",
        skills: [],
        mcpServers: [],
      }, []);
    });
    expect(setSessionRuntime).toHaveBeenCalledWith("s1", { kind: "external", data: "gemini" });
    expect(setAuthorizationMode).toHaveBeenCalledWith("s1", "no_confirmation");
    expect(sessionsWhenRuntimeApplied).toBe(0);
    expect(result.current.openSessions).toHaveLength(1);
  });

  it("createSessionWithQuestion skips posture IPC for the backend defaults", async () => {
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    expect(setSessionRuntime).not.toHaveBeenCalled();
    expect(setSessionPosture).not.toHaveBeenCalled();
    expect(setAuthorizationMode).not.toHaveBeenCalled();
    expect(mountSkill).not.toHaveBeenCalled();
    expect(toggleMcpServer).not.toHaveBeenCalled();
  });

  it("createSessionWithQuestion writes an explicit model posture AFTER the runtime write (ADR-0100)", async () => {
    // The backend namespaces the backfill entry by the session's runtime, so
    // the model / thought-level writes must land AFTER setSessionRuntime --
    // order is a correctness precondition, not an implementation detail.
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion(
        "q",
        {
          runtime: { kind: "external", data: "qwen-code" },
          modelPosture: { model: "fake-sonnet", thought_level: "high" },
          authMode: AUTH_MODE_DEFAULT,
          skills: [],
          mcpServers: [],
        },
        [],
      );
    });
    expect(setSessionPosture).toHaveBeenCalledWith("s1", { model: "fake-sonnet", thought_level: "high" });
    expect(
      vi.mocked(setSessionRuntime).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(setSessionPosture).mock.invocationCallOrder[0]);
    expect(result.current.openSessions).toHaveLength(1);
  });

  it("createSessionWithQuestion writes null posture fields as explicit clears", async () => {
    // A non-null pair is EXPLICIT: null fields are real clears the user made
    // on the bar, not "skip this dimension" -- the full pair rides one wire
    // submit with the null intact.
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion(
        "q",
        {
          runtime: { kind: "external", data: "qwen-code" },
          modelPosture: { model: "fake-sonnet", thought_level: null },
          authMode: AUTH_MODE_DEFAULT,
          skills: [],
          mcpServers: [],
        },
        [],
      );
    });
    expect(setSessionPosture).toHaveBeenCalledWith("s1", { model: "fake-sonnet", thought_level: null });
  });

  it("createSessionWithQuestion surfaces a persist fault returned by a successful posture set (#529)", async () => {
    // The set IPC resolves, but the persist verdict carries a typed write
    // failure: the verdict rides the resolved value (never a reject), so the
    // mint path must surface it like the picker's fault lines -- a silent
    // drop leaves the selection in memory only and a resume reverts it.
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    vi.mocked(setSessionPosture).mockResolvedValueOnce({
      persist_error: { kind: "Io", data: "disk full" },
      persist_suspended: false,
    });
    const { result, setShellError } = renderSessions();
    let created = false;
    await act(async () => {
      created = await result.current.createSessionWithQuestion(
        "q",
        {
          runtime: { kind: "external", data: "qwen-code" },
          modelPosture: { model: "fake-sonnet", thought_level: "high" },
          authMode: AUTH_MODE_DEFAULT,
          skills: [],
          mcpServers: [],
        },
        [],
      );
    });
    expect(created).toBe(true);
    expect(setShellError).toHaveBeenCalledTimes(1);
    expect(setShellError.mock.calls[0][0].message).toMatch(/Selection not saved/);
    // The full pair rode the one wire submit despite the persist fault.
    expect(setSessionPosture).toHaveBeenCalledTimes(1);
    expect(result.current.openSessions).toHaveLength(1);
  });

  it("createSessionWithQuestion writes an explicit built-in pick while null stays unwritten (issue #572)", async () => {
    // The unset marker is null, NOT the built-in value: with an external
    // default_runtime the backend already started the session externally, so
    // null skips the write -- while an EXPLICIT built-in pick must overwrite
    // that start (value equality against a constant cannot tell the two
    // apart, unlike authMode whose default is a true constant).
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion(
        "q",
        {
          runtime: { kind: "built_in" },
          modelPosture: null,
          authMode: AUTH_MODE_DEFAULT,
          skills: [],
          mcpServers: [],
        },
        [],
      );
    });
    expect(setSessionRuntime).toHaveBeenCalledWith("s1", { kind: "built_in" });
    expect(result.current.openSessions).toHaveLength(1);
  });

  it("createSessionWithQuestion mounts pending skills then enables pending MCP servers BEFORE registering (#500)", async () => {
    // Draft-mode picks land as one IPC per entry, skills BEFORE MCP enables (a
    // skill-declared server the user also picked lands either way), and all of
    // it before registerOpen so the pane mounts under the applied posture.
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    let sessionsWhenFirstSkillApplied = -1;
    vi.mocked(mountSkill).mockImplementationOnce(async () => {
      sessionsWhenFirstSkillApplied = result.current.openSessions.length;
    });
    await act(async () => {
      await result.current.createSessionWithQuestion(
        "q",
        {
          runtime: null,
          modelPosture: null,
          authMode: AUTH_MODE_DEFAULT,
          skills: ["data-cleaning", "charting"],
          mcpServers: ["srv-a"],
        },
        [],
      );
    });
    expect(mountSkill).toHaveBeenNthCalledWith(1, "s1", "data-cleaning");
    expect(mountSkill).toHaveBeenNthCalledWith(2, "s1", "charting");
    expect(toggleMcpServer).toHaveBeenCalledTimes(1);
    expect(toggleMcpServer).toHaveBeenCalledWith("s1", "srv-a", true);
    // Skills before MCP enables...
    expect(
      vi.mocked(mountSkill).mock.invocationCallOrder[1],
    ).toBeLessThan(vi.mocked(toggleMcpServer).mock.invocationCallOrder[0]);
    // ...and everything before the pane can mount.
    expect(sessionsWhenFirstSkillApplied).toBe(0);
    expect(result.current.openSessions).toHaveLength(1);
  });

  it("createSessionWithQuestion opens the session when a pending skill mount rejects (log + setShellError, keep going, #500)", async () => {
    // A rejected posture write never fails the whole creation: the session
    // opens on the backend default for that facet, the error is surfaced, and
    // the remaining picks still apply.
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    vi.mocked(mountSkill).mockRejectedValueOnce(new Error("skill gone"));
    const { result, setShellError } = renderSessions();
    let created = false;
    await act(async () => {
      created = await result.current.createSessionWithQuestion(
        "q",
        {
          runtime: null,
          modelPosture: null,
          authMode: AUTH_MODE_DEFAULT,
          skills: ["broken", "charting"],
          mcpServers: ["srv-a"],
        },
        [],
      );
    });
    expect(created).toBe(true);
    expect(setShellError).toHaveBeenCalledTimes(1);
    // The second skill + the MCP enable still land.
    expect(mountSkill).toHaveBeenNthCalledWith(2, "s1", "charting");
    expect(toggleMcpServer).toHaveBeenCalledWith("s1", "srv-a", true);
    expect(result.current.openSessions).toHaveLength(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("createSessionWithQuestion returns false + surfaces setShellError when createSession rejects", async () => {
    vi.mocked(createSession).mockRejectedValue(new Error("backend gone"));
    const { result, setShellError } = renderSessions();
    let created = true;
    await act(async () => {
      created = await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    expect(created).toBe(false);
    expect(setShellError).toHaveBeenCalled();
    expect(result.current.openSessions).toEqual([]);
  });

  it("createSessionWithQuestion carries the pending file list as pendingIngestPaths (#500)", async () => {
    // The cold-start "+" picks accumulate at shell level; the first submit
    // hands the whole list to the minted session, where the pane ingests it
    // before firing the question.
    vi.mocked(createSession).mockResolvedValue(reply("s1"));
    const { result } = renderSessions();
    let created = false;
    await act(async () => {
      created = await result.current.createSessionWithQuestion(
        "q",
        DEFAULT_POSTURE,
        ["/x/a.csv", "/x/b.parquet"],
      );
    });
    expect(created).toBe(true);
    expect(result.current.openSessions[0]).toMatchObject({
      sid: "s1",
      pendingIngestPaths: ["/x/a.csv", "/x/b.parquet"],
      pendingQuestion: "q",
    });
    expect(result.current.activeSessionId).toBe("s1");
  });

  it("onWebviewDrop on cold start (activeSessionId null) mints via dropFile with the path as a one-element pendingIngestPaths (#81 A1)", async () => {
    vi.mocked(createSession).mockResolvedValue(reply("drop-sid"));
    const { result } = renderSessions();
    expect(result.current.activeSessionId).toBeNull();
    act(() => {
      result.current.onWebviewDrop("/x/foo.csv");
    });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.activeSessionId).toBe("drop-sid"));
    expect(result.current.openSessions[0].pendingIngestPaths).toEqual(["/x/foo.csv"]);
  });

  it("onWebviewDrop on an active session routes to its pendingIngestPaths (no new mint, #81)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    const mintsBefore = vi.mocked(createSession).mock.calls.length;
    // Drop while s1 is active -> the file lands on s1's ingest pipe, no new mint.
    act(() => {
      result.current.onWebviewDrop("/x/new.csv");
    });
    expect(vi.mocked(createSession).mock.calls.length).toBe(mintsBefore);
    expect(result.current.openSessions[0].pendingIngestPaths).toEqual(["/x/new.csv"]);
  });

  it("clearPendingIngest drops the consumed path so a remount cannot re-ingest (#81 A1)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    act(() => {
      result.current.onWebviewDrop("/x/new.csv");
    });
    expect(result.current.openSessions[0].pendingIngestPaths).toEqual(["/x/new.csv"]);
    act(() => {
      result.current.clearPendingIngest("s1");
    });
    expect(result.current.openSessions[0].pendingIngestPaths).toEqual([]);
  });

  it("closeOpen unmounts synchronously + fires closeSession in the background (ADR-0055)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(closeSession).toHaveBeenCalledWith("s1");
    expect(result.current.openSessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
  });

  it("closeOpen refreshes sidebar when closeSession reports cleanup (ADR-0089 D6)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    vi.mocked(closeSession).mockResolvedValueOnce(true);
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(closeSession).toHaveBeenCalledWith("s1");
    expect(refreshSessions).toHaveBeenCalled();
  });

  it("closeOpen skips refresh when closeSession reports no cleanup (ADR-0089 D6)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    // Default mock returns false; explicit for clarity.
    vi.mocked(closeSession).mockResolvedValueOnce(false);
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    refreshSessions.mockClear();
    await act(async () => {
      await result.current.closeOpen("s1");
    });
    expect(closeSession).toHaveBeenCalledWith("s1");
    expect(refreshSessions).not.toHaveBeenCalled();
  });

  it("closeOpen survives a closeSession reject without throwing (ADR-0055 .catch seam)", async () => {
    // closeOpen returns closeSession().catch(...) -- a reject MUST be swallowed
    // (not surface as an unhandled rejection). The session is already unmounted.
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    vi.mocked(closeSession).mockRejectedValueOnce(new Error("backend gone"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
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
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
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
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
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

  it("handleOpenDuck imports external .duck then resumes the local copy (#450)", async () => {
    vi.mocked(openDialog).mockResolvedValueOnce("/x/a.duck");
    // prepareImportSession copies the file + returns the LOCAL duck path;
    // openDuck resumes from that local copy, not the external path.
    vi.mocked(prepareImportSession).mockResolvedValueOnce(reply("o1"));
    vi.mocked(openDuck).mockResolvedValueOnce();
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.handleOpenDuck();
    });
    expect(prepareImportSession).toHaveBeenCalledWith("/x/a.duck");
    expect(openDuck).toHaveBeenCalledWith("o1", "/sessions/o1/session.duck");
    expect(createSession).not.toHaveBeenCalled();
    expect(refreshSessions).toHaveBeenCalled();
  });

  it("handleOpenDuck closes the session + refreshes when openDuck rejects after a successful import (#450)", async () => {
    // Grilling decision #4: if prepareImportSession succeeds but openDuck
    // fails, the just-created session is closed best-effort so it does not
    // linger as a ghost row in the sidebar scan.
    vi.mocked(openDialog).mockResolvedValueOnce("/x/a.duck");
    vi.mocked(prepareImportSession).mockResolvedValueOnce(reply("o1"));
    vi.mocked(openDuck).mockRejectedValueOnce(new Error("resume failed"));
    const { result, refreshSessions, setShellError } = renderSessions();
    await act(async () => {
      await result.current.handleOpenDuck();
    });
    expect(closeSession).toHaveBeenCalledWith("o1");
    expect(refreshSessions).toHaveBeenCalled();
    expect(setShellError).toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
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

  it("handleOpenDuck bails on a cancelled open dialog (null path): no open, no refresh, busy clears (#204)", async () => {
    vi.mocked(openDialog).mockResolvedValueOnce(null);
    const { result, refreshSessions } = renderSessions();
    await act(async () => {
      await result.current.handleOpenDuck();
    });
    expect(openDuck).not.toHaveBeenCalled();
    expect(prepareImportSession).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  // --- handleExportSession (ADR-0089 Decision 5, issue #449) -----------------

  it("handleExportSession calls exportSession with duck path + save dialog result", async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce("/dest/my-copy");
    vi.mocked(exportSession).mockResolvedValueOnce();
    const { result, setShellError } = renderSessions();
    await act(async () => {
      await result.current.handleExportSession("/src/uuid/session.duck", "My Session");
    });
    expect(saveDialog).toHaveBeenCalledWith({ defaultPath: "My Session" });
    expect(exportSession).toHaveBeenCalledWith("/src/uuid/session.duck", "/dest/my-copy");
    expect(setShellError).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("handleExportSession bails on a cancelled save dialog (null): no export, busy clears", async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce(null);
    const { result, setShellError } = renderSessions();
    await act(async () => {
      await result.current.handleExportSession("/src/uuid/session.duck", "S");
    });
    expect(exportSession).not.toHaveBeenCalled();
    expect(setShellError).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("handleExportSession surfaces errors via setShellError", async () => {
    vi.mocked(saveDialog).mockResolvedValueOnce("/dest/copy");
    vi.mocked(exportSession).mockRejectedValueOnce(new Error("disk full"));
    const { result, setShellError } = renderSessions();
    await act(async () => {
      await result.current.handleExportSession("/src/uuid/session.duck", "S");
    });
    expect(exportSession).toHaveBeenCalled();
    expect(setShellError).toHaveBeenCalledOnce();
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
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
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

  it("onWebviewDrop routes a drop onto an active PERSISTED session -- path + pendingIngestPaths coexist (#205)", async () => {
    // Domain decision (issue #205): a drop onto an ALREADY-active session
    // routes to that session's ingest even when the session is resumed /
    // .duck-bound (path !== null). `path` and `pendingIngestPaths` are
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
      pendingIngestPaths: [],
    });
    const mintsBefore = vi.mocked(createSession).mock.calls.length;
    // Drop while the persisted p1 is active -> routes to p1's ingest pipe, no
    // new mint, and pendingIngestPaths now coexists with a bound path.
    act(() => {
      result.current.onWebviewDrop("/x/drop.csv");
    });
    expect(vi.mocked(createSession).mock.calls.length).toBe(mintsBefore);
    expect(result.current.openSessions[0]).toMatchObject({
      sid: "p1",
      path: "/x/a.duck",
      pendingIngestPaths: ["/x/drop.csv"],
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
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
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
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    expect(result.current.activeSessionId).toBe("s2");
    // Valid sid -> switch.
    act(() => {
      result.current.activateSession("s1");
    });
    expect(result.current.activeSessionId).toBe("s1");
    // Stale sid -> no-op; active id stays on s1 (not "ghost", not sessions[0]).
    act(() => {
      result.current.activateSession("ghost");
    });
    expect(result.current.activeSessionId).toBe("s1");
    // Invariant holds: activeId ∈ sessions.
    expect(
      result.current.openSessions.some((s) => s.sid === result.current.activeSessionId),
    ).toBe(true);
  });

  // ADR-0089 Decision 4: after the first terminal turn, the backend auto-names
  // the session. syncSessionName reads the live name and updates the in-memory
  // open-session entry + refreshes the sidebar.
  describe("syncSessionName (ADR-0089 auto-name sync)", () => {
    it("reads the backend name, updates the open entry, and refreshes the sidebar", async () => {
      const { result, refreshSessions } = renderSessions();
      vi.mocked(createSession).mockResolvedValue(reply("s1"));
      vi.mocked(getSessionName).mockResolvedValue("how many people?");

      await act(async () => {
        await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
      });
      // name starts empty (ADR-0089 placeholder).
      expect(result.current.openSessions[0].name).toBe("");

      await act(async () => {
        await result.current.syncSessionName("s1");
      });

      expect(getSessionName).toHaveBeenCalledWith("s1");
      expect(result.current.openSessions[0].name).toBe("how many people?");
      expect(refreshSessions).toHaveBeenCalled();
    });

    it("logs a warning + still refreshes sidebar when getSessionName rejects", async () => {
      const { result, refreshSessions } = renderSessions();
      vi.mocked(createSession).mockResolvedValue(reply("s2"));
      vi.mocked(getSessionName).mockRejectedValue(new Error("ipc down"));

      await act(async () => {
        await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
      });
      const originalName = result.current.openSessions[0].name;

      await act(async () => {
        await result.current.syncSessionName("s2");
      });

      // Best-effort: the open-session name is unchanged (the fetch failed),
      // but the sidebar still refreshes so a persisted re-read can catch up.
      expect(result.current.openSessions[0].name).toBe(originalName);
      expect(refreshSessions).toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    });
  });

  // --- Issue #501: cold-start empty-state drop zone -------------------------
  // ADR-0092 Decision 2: on cold start the empty-state main area around the
  // centered bar keeps the ADR-0061 drop-to-create, but the bar itself is
  // inert -- a drop ON the composer must not mint a session by accident.
  // Active-session drops route to the session's ingest regardless of where
  // the drop landed (AC #4: the per-session path is unchanged).

  it("onWebviewDrop on cold start ignores a drop landing on the composer bar (#501)", async () => {
    mountComposerBarStub(BAR_RECT);
    vi.mocked(createSession).mockResolvedValue(reply("drop-sid"));
    const { result } = renderSessions();
    expect(result.current.activeSessionId).toBeNull();
    act(() => {
      result.current.onWebviewDrop("/x/foo.csv", { x: 250, y: 250 });
    });
    // The guard runs synchronously before dropFile; no mint fires and the
    // shell stays on the centered empty state.
    expect(createSession).not.toHaveBeenCalled();
    expect(result.current.openSessions).toEqual([]);
    expect(result.current.activeSessionId).toBeNull();
  });

  it("onWebviewDrop on cold start mints when the drop lands outside the composer bar (#501)", async () => {
    mountComposerBarStub(BAR_RECT);
    vi.mocked(createSession).mockResolvedValue(reply("drop-sid"));
    const { result } = renderSessions();
    act(() => {
      // Clear of the bar rect -> the ADR-0061 drop-to-create path.
      result.current.onWebviewDrop("/x/foo.csv", { x: 20, y: 20 });
    });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.activeSessionId).toBe("drop-sid"));
    expect(result.current.openSessions[0].pendingIngestPaths).toEqual(["/x/foo.csv"]);
  });

  it("onWebviewDrop routes an active-session drop even when it lands over the bar (#501)", async () => {
    mountComposerBarStub(BAR_RECT);
    vi.mocked(createSession).mockResolvedValueOnce(reply("s1"));
    const { result } = renderSessions();
    await act(async () => {
      await result.current.createSessionWithQuestion("q", DEFAULT_POSTURE, []);
    });
    const mintsBefore = vi.mocked(createSession).mock.calls.length;
    act(() => {
      // Same position the cold-start guard swallows -- with a session active
      // it routes to that session's ingest (the guard is cold-start only).
      result.current.onWebviewDrop("/x/new.csv", { x: 250, y: 250 });
    });
    expect(vi.mocked(createSession).mock.calls.length).toBe(mintsBefore);
    expect(result.current.openSessions[0].pendingIngestPaths).toEqual(["/x/new.csv"]);
  });

  it("the drop listener threads the payload position through the bar guard (#501)", async () => {
    // Drive the real Tauri event seam (not onWebviewDrop directly): the
    // listener must hand the drop position to the router so the guard can
    // hit-test it.
    mountComposerBarStub(BAR_RECT);
    vi.mocked(createSession).mockResolvedValue(reply("drop-sid"));
    const { result } = renderSessions();
    await waitFor(() => expect(dropListener.current).not.toBeNull());
    // Over the bar: inert.
    act(() => {
      dropListener.current!({
        payload: { type: "drop", paths: ["/x/a.csv"], position: { x: 250, y: 250 } },
      });
    });
    expect(createSession).not.toHaveBeenCalled();
    // Off the bar: mints.
    act(() => {
      dropListener.current!({
        payload: { type: "drop", paths: ["/x/a.csv"], position: { x: 20, y: 20 } },
      });
    });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.activeSessionId).toBe("drop-sid"));
  });
});
