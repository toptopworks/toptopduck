import { vi, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry } from "../types/thread";
import { cancelQuery, conversation, createSession, readRows } from "../api";
import { QueryClient } from "@tanstack/react-query";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { ROW_PAGE, bogusTurn, buildDropWindowMock, openSession, pendingAsk, src } from "./setup/shellFixtures";
import App from "../App";

// Black-box shell tests. Drives the rendered three-column App
// like a user and asserts VISIBLE DOM / structure signals -- never the Query
// cache internals. Mirrors the App black-box pattern (mock api + stub the Tauri
// bridge) so the shell renders offline. Shared mocks and helpers live in
// ./setup/shellFixtures.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
// The viz suites' posture: jsdom has no canvas, so every chart render in
// this file draws through the mocked embed.
vi.mock("vega-embed", () => ({ default: vi.fn() }));

// ArtifactView's HTML branch rides convertFileSrc (the asset protocol); the
// real transform reads window.__TAURI_INTERNALS__ (absent in jsdom), so a
// pure stand-in keeps the iframe's src observable (issue #1088). Partial:
// api.ts's invoke keeps the real binding via importOriginal spreads.
vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, convertFileSrc: (p: string) => "asset://mock/" + p };
});
const dropEvent = vi.hoisted(() => ({
  handler: null as DropCapture["handler"],
}));
vi.mock("@tauri-apps/api/webviewWindow", () => buildDropWindowMock(dropEvent));

// WindowsWindowControls (custom titlebar, ADR-0074) is the sole remaining
// consumer of getCurrentWindow. The shared stub keeps jsdom off the real
// runtime (which reads window.__TAURI metadata and crashes the shell-level
// boundary).
vi.mock("@tauri-apps/api/window", () => buildTauriWindowMock().module);

const state = vi.hoisted(() => ({
  workingSet: [] as DatasetDescriptor[],
  thread: [] as ThreadEntry[],
}));

// ADR-0059 turn-progress capture: the SessionPane mounts a long-lived listener
// on mount. Capturing the callback here lets a test emit a turn-progress event
// (Thinking / the tool-call stream, ADR-0078) and assert the rail's activity
// line rotates its face, then assert it folds away when the ask resolves.
const turnProgressCb = vi.hoisted(() => ({
  current: null as null | ((ev: TurnProgress) => void),
}));

// #83 R5: capture the resume-progress listener so a test can emit Source/Replay
// events -- addressed to THIS session vs a stranger -- and assert the
// multi-session filter (ADR-0056) discards the stranger before it can move the
// opener's progress strip.
const resumeProgressCb = vi.hoisted(() => ({
  current: null as null | ((ev: ResumeProgress) => void),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  // Dynamic import: the factory runs lazily, and a static import of the
  // harness would re-enter this factory while the harness module is still
  // initializing (the harness never statically depends on the api).
  const { buildShellApiMocks } = await import("./setup/shellFixtures");
  return {
    ...actual,
    ...buildShellApiMocks({ state, turnProgressCb, resumeProgressCb }),
  };
});

describe("App turn-progress feedback (issue #82 / ADR-0059)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [src("people")];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("routes turn-progress events into the rail's activity line, filtered by session (ADR-0056)", async () => {
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" });
    const { resolve } = pendingAsk();
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The ask is in flight: the stop button replaces submit.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument(),
    );
    // The in-flight ask mounts the activity line with the ask-start thinking
    // face -- the ONE wait surface since #1612 retired the bar's phase
    // mirror (the composer carries no wait feedback of its own).
    const line = () => document.querySelector(".process-toggle") as HTMLElement;
    await waitFor(() => expect(within(line()).getByText("思考中…")).toBeInTheDocument());

    // A tool-call event for a DIFFERENT session is filtered out (ADR-0056):
    // the face stays on the wait -- no verb face, no row folds.
    turnProgressCb.current!({
      session_id: "other-session",
      phase: {
        ToolCallStarted: {
          name: "explore",
          operation_kind: "read",
          summary: "SELECT 1",
        },
      },
    });
    expect(within(line()).getByText("思考中…")).toBeInTheDocument();

    // The same event for THIS session folds a running row: the face
    // rotates onto the tool verb (entry is immediate, the anti-dead-line
    // ruling).
    turnProgressCb.current!({
      session_id: "sess-1",
      phase: {
        ToolCallStarted: {
          name: "explore",
          operation_kind: "read",
          summary: "SELECT 1",
        },
      },
    });
    await waitFor(() =>
      expect(within(line()).getByText(/正在读取/)).toBeInTheDocument(),
    );

    // The settle folds the live turn away: the line leaves with it.
    resolve({ kind: "Cancelled", data: null });
    await waitFor(() =>
      expect(document.querySelector(".process-toggle")).toBeNull(),
    );
  });
});

describe("App single in-flight + cancel (issue #82 / ADR-0021/0028)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [src("people")];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("disables the input and offers stop while a turn runs (single in-flight, ADR-0021)", async () => {
    const { resolve } = pendingAsk();
    render(<App />);
    await openSession();
    const input = screen.getByLabelText("提问");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // While the turn runs: input disabled, stop shown, submit gone.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument(),
    );
    expect(input).toBeDisabled();
    expect(screen.queryByRole("button", { name: "提问" })).not.toBeInTheDocument();
    resolve({ kind: "Cancelled", data: null });
  });

  it("stop fires cancelQuery on the session (ADR-0021)", async () => {
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" });
    const { resolve } = pendingAsk();
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await waitFor(() => expect(cancelQuery).toHaveBeenCalledWith("sess-1"));
    resolve({ kind: "Cancelled", data: null });
  });
});

describe("App error boundary partitioning (issue #82 / ADR-0058)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [src("people")];
    state.thread = [];
    // Reset conversation to the factory default (state.thread) so a prior
    // test's mockImplementation override does not leak across tests --
    // clearAllMocks only clears call history, not implementations.
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
    // React logs the intentional render throw; keep test output clean.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows a degrade card when Thread render throws (ADR-0058 partition fallback)", async () => {
    // A malformed outcome kind hits Thread's exhaustive `default: never` throw
    // (a genuine render crash). An L2 partition ErrorBoundary catches it and
    // renders the degrade card with the honest error detail. The session-level
    // boundary (wrapping each <SessionPane>) is the reliable catcher in the
    // test environment; the granular thread boundary is the architecturally
    // correct inner catcher and catches first-render throws.
    state.thread = [
      bogusTurn(),
    ];
    render(<App />);
    await openSession();
    // A degrade card is visible once the thread query resolves and Thread
    // throws on the malformed outcome.
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    const card = document.querySelector(".degrade-card")!;
    // The error message rides the expandable details (ADR-0058 honest detail).
    expect(card.textContent).toMatch(/Bogus/);
    // The shell skeleton (top bar + session sidebar) survives -- the crash
    // did not escape to L3.
    expect(document.querySelector(".topbar")).toBeInTheDocument();
    expect(document.querySelector(".session-sidebar")).toBeInTheDocument();
  });

  it("retry on a degrade card clears it after the data is fixed (key bump + invalidate)", async () => {
    // Thread starts malformed -> crash -> degrade card. After the retry's
    // onReset invalidates + error-clear remounts, the refetch returns a clean
    // thread and the pane renders the turn instead of the degrade card.
    let threadData: ThreadEntry[] = [
      bogusTurn(),
    ];
    vi.mocked(conversation).mockImplementation(async () => threadData);
    render(<App />);
    await openSession();
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    // Fix the data source, then retry.
    threadData = [
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } } },
    ];
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText("你好")).toBeInTheDocument());
    expect(document.querySelector(".degrade-card")).not.toBeInTheDocument();
  });

  it("retry resets the session cache slice (ADR-0058 resetQueries contract)", async () => {
    // Locks the ADR-0058 decision that retry RESETS (not invalidates) the
    // session query cache: invalidate would leave stale data for the remounted
    // children to re-render and re-throw against, and a bare remove would not
    // refetch the still-mounted observers (the region boundary never unmounts
    // useSessionState, so the remount would re-render the parent's stale JSX
    // snapshot and re-throw). A regression to invalidate (or a no-op) would
    // still pass the existing retry test above (the mock returns fresh data
    // either way), so this spy is the distinguishing guard.
    const removeSpy = vi.spyOn(QueryClient.prototype, "resetQueries");
    let threadData: ThreadEntry[] = [
      bogusTurn(),
    ];
    vi.mocked(conversation).mockImplementation(async () => threadData);
    render(<App />);
    await openSession();
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    // Fix the data, then retry.
    threadData = [
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled", data: null }, trace: [], provenance: { skills: [] } } },
    ];
    const conversationCallsBefore = vi.mocked(conversation).mock.calls.length;
    removeSpy.mockClear(); // isolate retry's own removeQueries call
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    // The remounted pane reads the refetched (clean) data.
    await waitFor(() => expect(screen.getByText("你好")).toBeInTheDocument());
    // ADR-0058: retry called resetQueries (the cache data was dropped AND the
    // active observers refetched), which drove the fresh conversation() call.
    expect(removeSpy).toHaveBeenCalled();
    expect(vi.mocked(conversation).mock.calls.length).toBeGreaterThan(
      conversationCallsBefore,
    );
  });

  it("one session crashing does not affect another open session (ADR-0058 session isolation)", async () => {
    // Two sessions: sess-1 has a crashing (malformed) thread, sess-2 is clean.
    // The L2 session-body boundary in sess-1 catches its crash; sess-2 is a
    // sibling pane and stays fully functional.
    vi.mocked(createSession)
      .mockResolvedValueOnce({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" })
      .mockResolvedValueOnce({ session_id: "sess-2", recipe_path: "/sessions/sess-2/recipe.json" });
    vi.mocked(conversation).mockImplementation(async (sid) => {
      if (sid === "sess-1") {
        return [
          bogusTurn("bad"),
        ];
      }
      return [];
    });
    render(<App />);
    // Open sess-1 (the crashing session).
    await openSession();
    // sess-1 shows a degrade card (thread partition caught the crash).
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    // Open sess-2 (a second session via the bar-submit path).
    await openSession();
    expect(createSession).toHaveBeenCalledTimes(2);
    // sess-2 is now active and shows NO degrade card -- it is unaffected. Only
    // sess-1's keep-alive pane carries the single crash card. (Asserted by class
    // count, not role="alert": the openSession helper rejects each creation turn,
    // leaving a benign per-session ErrorBanner — also role="alert" — that is a
    // test artifact, not a crash; querySelector counts hidden keep-alive panes.)
    expect(document.querySelectorAll(".degrade-card")).toHaveLength(1);
    expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument();
  });
});
