import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type {
  DatasetDescriptor,
  ResumeProgress,
  RowPage,
  ThreadEntry,
  TurnOutcome,
  TurnProgress,
} from "../types";

// Black-box shell tests (issue #79 ACs). Drives the rendered three-column App
// like a user and asserts VISIBLE DOM / structure signals -- never the Query
// cache internals. Mirrors the App black-box pattern (mock api + stub the Tauri
// bridge) so the shell renders offline.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const dropEvent = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: { type: string; paths: string[] } }) => void),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: (cb: (e: { payload: { type: string; paths: string[] } }) => void) => {
      dropEvent.handler = cb;
      return Promise.resolve(() => {});
    },
  }),
}));

const state = vi.hoisted(() => ({
  workingSet: [] as DatasetDescriptor[],
  thread: [] as ThreadEntry[],
}));

// ADR-0059 turn-progress capture: the SessionPane mounts a long-lived listener
// on mount. Capturing the callback here lets a test emit a Thinking/Querying
// phase event and assert the QuestionBar renders the discrete feedback, then
// assert it clears when the ask resolves.
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
  return {
    ...actual,
    closeSession: vi.fn(async () => {}),
    closeSessionAndWaitRelease: vi.fn(async () => {}),
    createSession: vi.fn(async () => "sess-1"),
    deleteSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    renameSession: vi.fn(async () => ""),
    ingestFile: vi.fn(),
    listWorkingSet: vi.fn(async () => state.workingSet),
    activeDataset: vi.fn(async () => null),
    askQuestion: vi.fn(),
    cancelQuery: vi.fn(async () => {}),
    conversation: vi.fn(async () => state.thread),
    // ADR-0059: capture the listener callback so a test can emit phases; the
    // returned unlisten is a no-op (jsdom has no real Tauri event bus).
    onTurnProgress: vi.fn(async (cb: (ev: TurnProgress) => void) => {
      turnProgressCb.current = cb;
      return () => {};
    }),
    // #83 R5: capture the resume-progress listener so a test can emit events
    // addressed to a stranger vs this session (ADR-0056 multi-session filter).
    openDuck: vi.fn(async () => {}),
    onResumeProgress: vi.fn(async (cb: (ev: ResumeProgress) => void) => {
      resumeProgressCb.current = cb;
      return () => {};
    }),
    readRows: vi.fn(),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: true,
    })),
    getAppConfig: vi.fn(async () => null),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
  };
});

import App from "../App";
import {
  activeDataset,
  askQuestion,
  cancelQuery,
  closeSession,
  closeSessionAndWaitRelease,
  conversation,
  createSession,
  deleteSession,
  getAppConfig,
  ingestFile,
  listSessions,
  listWorkingSet,
  openDuck,
  readRows,
  renameSession,
  setAppConfig,
} from "../api";
import type { AppConfig } from "../types";

// ADR-0061 cold start: <App/> renders no session on mount, so a session-internal
// assertion first opens one via the sidebar "+ 新建会话" button (scoped by class
// to disambiguate from the cold-start hero's same-label CTA).
async function openSession(): Promise<void> {
  fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
  );
}

function src(name: string): DatasetDescriptor {
  return {
    reference_name: name,
    display_name: name,
    source_path: `/x/${name}.csv`,
    columns: [
      { name: "id", canonical_type: "BIGINT" },
      { name: "label", canonical_type: "VARCHAR" },
    ],
    row_count: 1,
    sample: [["1", "a"]],
    fingerprint: "ff".repeat(32),
    rectify: { kind: "NotApplicable" },
    privacy: { send_samples: true, type_only_columns: [] },
  };
}

function materializedTurn(referenceName: string): ThreadEntry {
  return {
    entry: "Turn",
    data: {
      question: `q:${referenceName}`,
      outcome: {
        kind: "Materialized",
        data: { dataset: src(referenceName), viz: null, assumption: null, sql: null },
      },
    },
  };
}

const ROW_PAGE: RowPage = {
  columns: [
    { name: "id", canonical_type: "BIGINT" },
    { name: "label", canonical_type: "VARCHAR" },
  ],
  rows: [["1", "a"]],
  total: 1,
  offset: 0,
  limit: 100,
};

describe("App three-column shell (issue #79 ACs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // App resolves the "system" locale preference from navigator.language; pin
    // it to zh-CN so the Thread rail's i18n'd chrome (ADR-0052) renders in
    // Chinese alongside the still-hardcoded chrome of the other components these
    // assertions rely on. getAppConfig stays null (first-launch, no app-config).
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("renders the three-column grid + thin top bar (R1: session bar / rail / workspace)", async () => {
    render(<App />);
    await openSession();
    // Three columns + topbar + questionbar all render.
    expect(document.querySelector(".session-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".session-rail")).toBeInTheDocument();
    expect(document.querySelector(".session-workspace")).toBeInTheDocument();
    expect(document.querySelector(".topbar")).toBeInTheDocument();
    expect(document.querySelector(".session-questionbar")).toBeInTheDocument();
  });

  it("collapses the session sidebar via the top-bar toggle", async () => {
    render(<App />);
    await openSession();
    const shell = document.querySelector(".shell");
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(true);
    // Toggling back expands.
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(false);
  });

  it("shows the hero empty state when no result is viewed (ADR-0062 R2 hero)", async () => {
    render(<App />);
    await openSession();
    // Hero drop zone is visible in the default 结果 tab.
    expect(screen.getByText(/拖入或选择一个数据文件开始分析/)).toBeInTheDocument();
  });

  it("derives result content after a Materialized ask (R2 result state)", async () => {
    state.workingSet = [src("people")];
    vi.mocked(askQuestion).mockResolvedValue({
      kind: "Materialized",
      data: { dataset: { ...src("result_1"), row_count: 1 }, viz: null, assumption: null },
    });
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "总共几行" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The workspace ResultView heading appears (chart+table pane).
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
  });

  it("separates active from viewed: clicking a rail result moves viewed, not active (ADR-0051)", async () => {
    // Two results in the thread; R5 init views the last (result_2). Clicking
    // result_1 in the rail moves viewedResult to result_1 with no backend
    // mutation -- active is server truth, untouched by the click.
    const r1 = src("result_1");
    const r2 = src("result_2");
    state.workingSet = [r1, r2];
    state.thread = [materializedTurn("result_1"), materializedTurn("result_2")];
    render(<App />);
    await openSession();
    // R5 init: viewedResult <- last Materialized (result_2).
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
    // Click result_1 in the rail (the Thread result-link button).
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    // viewedResult moved to result_1; the workspace now shows result_1.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
    // No ask / mutation IPC fired by the click -- active is untouched.
    expect(askQuestion).not.toHaveBeenCalled();
  });

  it("appends the new turn optimistically without a thread refetch (ADR-0051)", async () => {
    // The thread cache is the single truth; on a successful ask the new turn is
    // appended via setQueryData and the thread query is NEVER invalidated, so a
    // stale/empty refetch cannot wipe the turn the user just produced. The new
    // turn's question renders in the rail from the optimistic append, not from
    // a refetch -- conversation is called exactly once (the initial load).
    state.workingSet = [src("people")];
    vi.mocked(askQuestion).mockResolvedValue({
      kind: "Materialized",
      data: { dataset: { ...src("result_1"), row_count: 1 }, viz: null, assumption: null },
    });
    render(<App />);
    await openSession();
    // The thread query (useSessionState) fires conversation() in a post-open
    // effect; wait for it to fire before asserting the count, so a slow CI
    // runner that mounts the textbox before scheduling the effect does not
    // read 0 calls. The assert below still pins "exactly once, no refetch".
    await waitFor(() => expect(conversation).toHaveBeenCalled());
    expect(conversation).toHaveBeenCalledTimes(1); // initial load only
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "总共几行" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The new turn's question lands in the rail from the optimistic append.
    await waitFor(() => expect(screen.getByText("总共几行")).toBeInTheDocument());
    // No refetch: conversation was not called again (thread never invalidated).
    expect(conversation).toHaveBeenCalledTimes(1);
  });

  it("pins to a history result so it overrides the last textual turn (ADR-0062 R2)", async () => {
    // End-to-end pin chain: the last turn is a Clarify (workspace would show the
    // textual card), but clicking an earlier Materialized result in the rail sets
    // pinnedToHistory so the viewed result overrides the last-turn text. This is
    // the full handleSelectResult -> deriveWorkspaceContent path the pure-function
    // unit test alone cannot cover.
    const r1 = src("result_1");
    state.workingSet = [r1];
    state.thread = [
      materializedTurn("result_1"),
      {
        entry: "Turn",
        data: {
          question: "哪个名字",
          outcome: {
            kind: "Textual",
            data: { text_kind: "Clarify", body: "请说明哪个名字", assumption: null },
          },
        },
      },
    ];
    render(<App />);
    await openSession();
    // Last turn is Clarify -> workspace shows the textual card.
    await waitFor(() => expect(document.querySelector(".textual-card")).toBeInTheDocument());
    // Click result_1 in the rail -> pin -> workspace shows result_1's table.
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
    // The workspace textual card is gone (the rail still renders the turn text,
    // but under a different class -- .turn-outcome, not .textual-card).
    expect(document.querySelector(".textual-card")).not.toBeInTheDocument();
  });
});

describe("App multi-session shell (issue #81 ACs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("cold start shows the hero empty state and does not createSession (ADR-0061)", async () => {
    // No auto-resume, no auto-create: the right side is the new-session hero,
    // the question bar is absent, and createSession has not been called.
    render(<App />);
    expect(screen.getByText(/开始一次分析/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "提问" })).not.toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keep-alive switch does not refetch an inactive session (ADR-0051)", async () => {
    // Two sessions opened; each SessionPane fetches its thread once on mount.
    // Switching active never remounts them (CSS hidden keep-alive), so the
    // thread query is NOT re-issued -- conversation stays at one call per
    // session.
    vi.mocked(createSession)
      .mockResolvedValueOnce("sess-1")
      .mockResolvedValueOnce("sess-2");
    render(<App />);
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    expect(conversation).toHaveBeenCalledTimes(2); // one per session mount

    // Switch back to the first session via its sidebar entry. Keep-alive: the
    // inactive SessionPane was never unmounted, so no refetch.
    const entries = document.querySelectorAll(".session-entry-main");
    expect(entries.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(entries[0]);
    expect(conversation).toHaveBeenCalledTimes(2); // unchanged -- no refetch
  });

  it("closes the active session: closeSession + drops it from the open set (ADR-0055)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce("sess-1");
    render(<App />);
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );

    // Open the context menu on the one open entry, then Close.
    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭" }));

    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("sess-1"));
    // The session pane is gone -- the question bar is no longer in the document.
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "提问" })).not.toBeInTheDocument(),
    );
  });

  it("renames the open session via the sidebar context menu (ADR-0060 single entry)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce("sess-1");
    vi.mocked(renameSession).mockResolvedValue("季报");
    render(<App />);
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );

    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    // Rename dialog: the input is labelled "会话名" (Radix Label htmlFor),
    // disambiguating it from the active session's question-bar textbox ("提问").
    const input = screen.getByRole("textbox", { name: "会话名" });
    fireEvent.change(input, { target: { value: "季报" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(renameSession).toHaveBeenCalledWith("sess-1", "季报"));
  });

  // ADR-0061 drop-to-create (#81 A1): a file dropped on the cold-start hero
  // mints a session and the new SessionPane ingests the path via handleIngest
  // (the only path that can surface an xlsx NeedsGuidance result). Asserts the
  // createSession + ingestFile wiring at the shell boundary.
  it("drop on the cold hero mints a session and ingests the file (ADR-0061, #81 A1)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce("sess-drop");
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("dropped") });
    render(<App />);
    // Cold start: the hero is showing, no session yet.
    await waitFor(() => expect(dropEvent.handler).not.toBeNull());
    // Simulate a webview drop of one data file.
    dropEvent.handler!({ payload: { type: "drop", paths: ["/x/foo.csv"] } });
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    // The minted session's SessionPane consumes the path via handleIngest.
    await waitFor(() => expect(ingestFile).toHaveBeenCalledWith("sess-drop", "/x/foo.csv"));
  });
});

// A helper that holds an in-flight ask open so a test can observe the loading
// window (phase feedback / cancel) then resolve it to let the turn finish.
// The resolver is read through a ref so the returned `resolve` always invokes
// the LATEST promise's resolver (not a stale copy captured before askQuestion
// was called).
function pendingAsk(): { resolve: (o: TurnOutcome) => void } {
  const ref: { current: ((o: TurnOutcome) => void) | null } = { current: null };
  vi.mocked(askQuestion).mockImplementation(
    () =>
      new Promise<TurnOutcome>((r) => {
        ref.current = r;
      }),
  );
  return { resolve: (o) => ref.current?.(o) };
}

describe("App turn-progress phase feedback (issue #82 / ADR-0059)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [src("people")];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("renders Thinking / Querying phase labels during an in-flight ask", async () => {
    const { resolve } = pendingAsk();
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The ask is in flight: the stop button replaces submit.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument(),
    );

    // Thinking{attempt: 1} -> bare verb "思考中…" (no "第 1 次" noise).
    turnProgressCb.current!({
      session_id: "sess-1",
      phase: { Thinking: { attempt: 1 } },
    });
    await waitFor(() => expect(screen.getByText("思考中…")).toBeInTheDocument());

    // Querying{attempt: 2} -> blind retry surfaces "第 2 次" (守 0017 honest).
    turnProgressCb.current!({
      session_id: "sess-1",
      phase: { Querying: { attempt: 2 } },
    });
    await waitFor(() =>
      expect(screen.getByText("查询中（第 2 次）…")).toBeInTheDocument(),
    );

    // Outcome lands -> phase clears (ADR-0059 handleAsk finally).
    resolve({ kind: "Cancelled" });
    await waitFor(() =>
      expect(screen.queryByText(/查询中/)).not.toBeInTheDocument(),
    );
  });

  it("ignores turn-progress events addressed to a different session (ADR-0056 filter)", async () => {
    const { resolve } = pendingAsk();
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument(),
    );
    // A phase for a DIFFERENT session is filtered out -- no indicator.
    turnProgressCb.current!({
      session_id: "other-session",
      phase: { Thinking: { attempt: 1 } },
    });
    expect(screen.queryByText(/思考中/)).not.toBeInTheDocument();
    // The same phase for THIS session lights up.
    turnProgressCb.current!({
      session_id: "sess-1",
      phase: { Thinking: { attempt: 1 } },
    });
    await waitFor(() => expect(screen.getByText("思考中…")).toBeInTheDocument());
    resolve({ kind: "Cancelled" });
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
    resolve({ kind: "Cancelled" });
  });

  it("stop fires cancelQuery on the session (ADR-0021)", async () => {
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
    resolve({ kind: "Cancelled" });
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
      {
        entry: "Turn",
        data: { question: "x", outcome: { kind: "Bogus" } },
      } as unknown as ThreadEntry,
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
      {
        entry: "Turn",
        data: { question: "x", outcome: { kind: "Bogus" } },
      } as unknown as ThreadEntry,
    ];
    vi.mocked(conversation).mockImplementation(async () => threadData);
    render(<App />);
    await openSession();
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    // Fix the data source, then retry.
    threadData = [
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" } } },
    ];
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    // The remounted pane reads the refetched (clean) data -- the question
    // renders and the degrade card is gone.
    await waitFor(() => expect(screen.getByText("你好")).toBeInTheDocument());
    expect(document.querySelector(".degrade-card")).not.toBeInTheDocument();
  });

  it("retry removes the session cache slice (ADR-0058 removeQueries contract)", async () => {
    // Locks the ADR-0058 decision that retry REMOVES (not invalidates) the
    // session query cache: invalidate would leave stale data for the remounted
    // children to re-render and re-throw against. A regression to invalidate
    // (or a no-op) would still pass the existing retry test above (the mock
    // returns fresh data either way), so this spy is the distinguishing guard.
    const removeSpy = vi.spyOn(QueryClient.prototype, "removeQueries");
    let threadData: ThreadEntry[] = [
      {
        entry: "Turn",
        data: { question: "x", outcome: { kind: "Bogus" } },
      } as unknown as ThreadEntry,
    ];
    vi.mocked(conversation).mockImplementation(async () => threadData);
    render(<App />);
    await openSession();
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    // Fix the data, then retry.
    threadData = [
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" } } },
    ];
    const conversationCallsBefore = vi.mocked(conversation).mock.calls.length;
    removeSpy.mockClear(); // isolate retry's own removeQueries call
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    // The remounted pane reads the refetched (clean) data.
    await waitFor(() => expect(screen.getByText("你好")).toBeInTheDocument());
    // ADR-0058: retry called removeQueries (the cache was dropped, not left
    // stale), and the drop drove a fresh conversation() refetch.
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
      .mockResolvedValueOnce("sess-1")
      .mockResolvedValueOnce("sess-2");
    vi.mocked(conversation).mockImplementation(async (sid) => {
      if (sid === "sess-1") {
        return [
          {
            entry: "Turn",
            data: { question: "bad", outcome: { kind: "Bogus" } },
          } as unknown as ThreadEntry,
        ];
      }
      return [];
    });
    render(<App />);
    // Open sess-1 (the crashing session).
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    // sess-1 shows a degrade card (thread partition caught the crash).
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    // Open sess-2 (a second "+ 新建会话").
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    // sess-2 is now active and shows NO degrade card -- it is unaffected.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument();
  });
});

describe("App resume + close-in-flight seams (issue #83)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // Defaults: each test overrides the IPC it needs. Reset implementations
    // so a prior test's mockImplementation (e.g. closeSession never-resolve)
    // does not leak across describe boundaries.
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    vi.mocked(conversation).mockResolvedValue([]);
    vi.mocked(closeSession).mockResolvedValue(undefined);
    vi.mocked(openDuck).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("resume lands viewedResult on the last Materialized and shows the stale disclosure (ADR-0062 R5 / 0047)", async () => {
    // A persisted session with two Materialized turns; result_2 is the last ->
    // R5 points viewedResult at it on resume. result_2's source was replaced
    // after materialization, so the workspace shows the old table + the
    // stage-stale disclosure banner (ADR-0047 honest wording).
    vi.mocked(listSessions).mockResolvedValue([
      {
        session_id: "/x/persisted.duck",
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: "people", source_count: 1, turn_count: 2 },
        format_version: 1,
      },
    ]);
    const r1 = src("result_1");
    const r2: DatasetDescriptor = {
      ...src("result_2"),
      stale: { reference_name: "result_2", display_name: "result_2", reason: "Replaced" },
    };
    vi.mocked(createSession).mockResolvedValue("sess-resume");
    vi.mocked(openDuck).mockResolvedValue(undefined);
    vi.mocked(listWorkingSet).mockResolvedValue([r1, r2]);
    vi.mocked(activeDataset).mockResolvedValue(r2);
    vi.mocked(conversation).mockResolvedValue([
      materializedTurn("result_1"),
      materializedTurn("result_2"),
    ]);

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    // R5: viewedResult lands on the LAST Materialized (result_2), not result_1.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
    // ADR-0047 stage-stale: the workspace shows the old table + disclosure.
    expect(screen.getByText(/此结果已失效/)).toBeInTheDocument();
  });

  it("filters resume-progress events by sessionId (ADR-0056 / #76, #83 R5)", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      {
        session_id: "/x/persisted.duck",
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: "people", source_count: 1, turn_count: 1 },
        format_version: 1,
      },
    ]);
    // Hold openDuck pending so resumeStatus stays visible for assertions.
    let resolveOpenDuck: () => void = () => {};
    vi.mocked(openDuck).mockImplementation(
      () => new Promise<void>((r) => { resolveOpenDuck = r; }),
    );
    vi.mocked(createSession).mockResolvedValue("sess-resume");

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    // openDuck is called AFTER `targetSid = sid`, so once it fires the filter
    // is armed.
    await waitFor(() =>
      expect(openDuck).toHaveBeenCalledWith("sess-resume", "/x/persisted.duck"),
    );

    // Event for a DIFFERENT session: filtered -> status stays "正在打开…".
    resumeProgressCb.current!({
      session_id: "other-sid",
      event: { Source: { index: 1, total: 2, reference_name: "X" } },
    });
    expect(screen.queryByText(/校验源/)).not.toBeInTheDocument();

    // Event for THIS session: status updates to source.
    resumeProgressCb.current!({
      session_id: "sess-resume",
      event: { Source: { index: 1, total: 2, reference_name: "people" } },
    });
    await waitFor(() => expect(screen.getByText(/校验源/)).toBeInTheDocument());

    // Cleanup: let openDuck resolve and AWAIT openPersisted finishing (invalidate
    // + registerOpen + setResumeStatus(null) + finally unlisten) so no orphan
    // resume-progress listener leaks into the next test.
    resolveOpenDuck();
    await waitFor(() =>
      expect(screen.queryByText(/正在打开/)).not.toBeInTheDocument(),
    );
  });

  it("closing an in-flight session unmounts the pane at once + fires closeSession (ADR-0055)", async () => {
    const { resolve } = pendingAsk();
    vi.mocked(createSession).mockResolvedValueOnce("sess-1");
    // closeSession NEVER resolves in this test -- proves the UI does NOT wait.
    vi.mocked(closeSession).mockImplementation(() => new Promise<void>(() => {}));

    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument(),
    );

    // Close via the sidebar context menu WHILE the ask is in-flight.
    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭" }));

    // ADR-0055: the pane unmounts IMMEDIATELY -- closeSession is still pending,
    // yet the question bar is already gone (no await on the IPC).
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "提问" })).not.toBeInTheDocument(),
    );
    expect(closeSession).toHaveBeenCalledWith("sess-1");

    // The orphan ask resolves after the pane is gone; the cold hero shows --
    // no ghost turn renders. This test asserts only the FRONTEND contract: the
    // session cache was removed before the orphan resolved, so its optimistic
    // setQueryData cannot surface a turn. (In production the backend's
    // post-check also discards the turn on closing -- ADR-0055 -- but that
    // backend path is not exercised by this IPC mock.)
    resolve({
      kind: "Materialized",
      data: {
        dataset: { ...src("result_1"), row_count: 1 },
        viz: null,
        assumption: null,
      },
    });
    await waitFor(() => expect(screen.getByText(/开始一次分析/)).toBeInTheDocument());
  });

  it("close still unmounts at once when closeSession rejects (ADR-0055 .catch seam, #83)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce("sess-1");
    // closeSession REJECTS -- closeOpen's .catch must swallow it so it does
    // NOT surface as an unhandled rejection. If someone drops the .catch (or
    // re-adds an await on closeSession), this test fails on the reject path.
    vi.mocked(closeSession).mockRejectedValueOnce(new Error("backend gone"));

    render(<App />);
    await openSession();
    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭" }));

    // The pane unmounts synchronously even though closeSession rejects.
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "提问" })).not.toBeInTheDocument(),
    );
    // Drain the microtask queue so the rejected closeSession promise settles
    // through closeOpen's .catch -- the seam this test exists to guard.
    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("sess-1"));
  });
});

describe("App delete wait-release variant (issue #93 / ADR-0063)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // Defaults: each test overrides the IPC it needs. Reset implementations
    // so a prior test's mockImplementation (e.g. a never-resolving wait) does
    // not leak across describe boundaries.
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    vi.mocked(conversation).mockResolvedValue([]);
    vi.mocked(closeSession).mockResolvedValue(undefined);
    vi.mocked(closeSessionAndWaitRelease).mockResolvedValue(undefined);
    vi.mocked(deleteSession).mockResolvedValue(undefined);
    vi.mocked(openDuck).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("delete of an open session calls closeSessionAndWaitRelease (not closeSession) then deleteSession (ADR-0063)", async () => {
    // The delete path's close variant: the canonical single-writer key must be
    // released (closeSessionAndWaitRelease blocks until Session::Drop) BEFORE
    // delete_session's try_acquire gate fires. Pure closeSession is NOT used
    // here -- it resolves before the key is free, the #93 race.
    const path = "/x/persisted.duck";
    vi.mocked(listSessions).mockResolvedValue([
      {
        session_id: path,
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
        format_version: 1,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue("sess-del");

    render(<App />);
    // Open the persisted session (createSession + openDuck).
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );

    // Trigger delete via the sidebar menu: open the menu, click 删除, confirm.
    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    // ADR-0063: the wait-release variant fires first; closeSession (pure) is
    // NOT called on the delete path. deleteSession runs after the wait resolves.
    await waitFor(() =>
      expect(closeSessionAndWaitRelease).toHaveBeenCalledWith("sess-del"),
    );
    expect(closeSession).not.toHaveBeenCalled();
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(path));
  });

  it("delete keeps the pane mounted until closeSessionAndWaitRelease resolves (ADR-0063 Decision 2)", async () => {
    // Delete is an explicit user intent -- it does NOT get pure close's
    // zero-wait UI contract (ADR-0055). The pane stays mounted during the
    // wait and only unmounts AFTER the canonical key is released. This keeps
    // the timeout-retry UX self-consistent (entry survives, in-place retry).
    const path = "/x/persisted.duck";
    vi.mocked(listSessions).mockResolvedValue([
      {
        session_id: path,
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
        format_version: 1,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue("sess-del");
    // Hold the wait-release pending so we can observe the pane STAYS mounted.
    let resolveWait: () => void = () => {};
    vi.mocked(closeSessionAndWaitRelease).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveWait = resolve;
        }),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );

    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    // The wait was called (delete started), but the pane is STILL mounted --
    // UI teardown happens AFTER the wait resolves, not synchronously.
    await waitFor(() =>
      expect(closeSessionAndWaitRelease).toHaveBeenCalledWith("sess-del"),
    );
    expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument();
    // deleteSession has NOT fired yet -- it waits on the close-wait variant.
    expect(deleteSession).not.toHaveBeenCalled();

    // Resolve the wait -> the pane unmounts -> deleteSession fires.
    resolveWait();
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "提问" })).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(path));
  });

  it("delete unmounts the pane when closeSessionAndWaitRelease fails (ADR-0063 retry path, issue #93)", async () => {
    // Close-wait failure (timeout, or the backend already detached): the pane
    // MUST unmount so the entry falls back to the cold sidebar (sid=null). A
    // retry then takes the pure deleteSession(path) path instead of re-calling
    // closeSessionAndWaitRelease on a sid the backend no longer knows (which
    // would NotFound-loop). Without the unmount, the pane is stuck on a dead
    // sid with no recovery short of restarting the app.
    const path = "/x/persisted.duck";
    vi.mocked(listSessions).mockResolvedValue([
      {
        session_id: path,
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
        format_version: 1,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue("sess-del");
    vi.mocked(closeSessionAndWaitRelease).mockRejectedValue(
      new Error("关闭会话超时（in-flight ask 未在 120s 内收尾），请稍后重试"),
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );

    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    // The wait-release variant fired and rejected -> the pane UNMOUNTS (the
    // fix for the NotFound dead-loop) and deleteSession is NOT called (the
    // delete aborted on the close-wait failure).
    await waitFor(() =>
      expect(closeSessionAndWaitRelease).toHaveBeenCalledWith("sess-del"),
    );
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "提问" })).not.toBeInTheDocument(),
    );
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

// A minimal valid AppConfig for the #84 persistence tests (the shell prefs are
// the only field under test; the rest are just-shape defaults).
function baseAppConfig(shell: AppConfig["shell"]): AppConfig {
  return {
    format_version: 1,
    theme: "system",
    locale: "system",
    window: { width: 800, height: 600, x: null, y: null, maximized: false },
    engine: { memory_limit: "512MB", threads: 1, row_cap: 100, statement_timeout_ms: 30000 },
    privacy: { send_samples: true },
    provider: { base_url: "https://api.anthropic.com", model: "claude-sonnet-4-6" },
    export: { last_dir: null, default_format: "csv" },
    tunables: { retry_budget: 3, window_turns: 6, far_window: 12 },
    recent_files: [],
    shell,
  };
}

describe("App shell window collapse + drag-drop bisection (issue #84)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.mocked(listSessions).mockResolvedValue([]);
    vi.mocked(activeDataset).mockResolvedValue(null);
    vi.mocked(listWorkingSet).mockResolvedValue([]);
    // mockImplementation (not mockResolvedValue) so state.thread mutations
    // within a test flow through to the rendered Thread (the truncation test
    // sets a long-question turn after beforeEach runs).
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("collapses the thread rail via the top-bar rail toggle (ADR-0054 level 2)", async () => {
    render(<App />);
    await openSession();
    const shell = document.querySelector(".shell");
    expect(shell?.classList.contains("rail-collapsed")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "折叠对话栏" }));
    expect(shell?.classList.contains("rail-collapsed")).toBe(true);
    // Toggle back expands.
    fireEvent.click(screen.getByRole("button", { name: "展开对话栏" }));
    expect(shell?.classList.contains("rail-collapsed")).toBe(false);
  });

  it("sidebar and rail collapse stack independently (ADR-0054)", async () => {
    // Both collapse levels are independent UI states; collapsing both at once
    // must surface BOTH classes (the cold-start three-column shell retreats to
    // sidebar-hidden + workspace-full-width).
    render(<App />);
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    fireEvent.click(screen.getByRole("button", { name: "折叠对话栏" }));
    const shell = document.querySelector(".shell");
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(true);
    expect(shell?.classList.contains("rail-collapsed")).toBe(true);
    // Expanding the sidebar leaves the rail collapsed (independence).
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(false);
    expect(shell?.classList.contains("rail-collapsed")).toBe(true);
  });

  it("restores persisted collapse prefs from app-config on mount (ADR-0038/0054)", async () => {
    // A user who left both levels collapsed reopens to both collapsed -- the
    // prefs ride app-config (ADR-0038), restored once on the first resolve.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: true, rail_collapsed: true }),
    );
    render(<App />);
    await waitFor(() => {
      const shell = document.querySelector(".shell");
      expect(shell?.classList.contains("sidebar-collapsed")).toBe(true);
      expect(shell?.classList.contains("rail-collapsed")).toBe(true);
    });
  });

  it("persists a sidebar collapse toggle into app-config (ADR-0038)", async () => {
    // Toggling a collapse level commits the new shell prefs to app-config so
    // the choice survives a restart (the toggle is not a transient UI flip).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    render(<App />);
    // Wait for getAppConfig to resolve AND the mount effect's .then to set
    // appConfigRef.current (commitShellPrefs is a no-op until the ref lands).
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    // setAppConfig receives a config whose shell reflects the toggle.
    await waitFor(() =>
      expect(setAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          shell: { sidebar_collapsed: true, rail_collapsed: false },
        }),
      ),
    );
  });

  it("persists a rail collapse toggle into app-config (ADR-0038)", async () => {
    // Symmetric to the sidebar persist test above: the rail toggle is a SEPARATE
    // callback (toggleRailCollapse) with its own dependency array, so its commit
    // path needs its own guard. Unlike the sidebar toggle, the rail toggle is
    // disabled until a session is active -- open one first. A regression that
    // drops commitShellPrefs from toggleRailCollapse would leave the rail
    // collapse a transient UI flip (lost on restart).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    render(<App />);
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "折叠对话栏" }));
    await waitFor(() =>
      expect(setAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          shell: { sidebar_collapsed: false, rail_collapsed: true },
        }),
      ),
    );
  });

  it("drops a file onto an active session as an added source (ADR-0062 R3)", async () => {
    // The bisection's ACTIVE-session branch: with a session open, a drop adds
    // the file to that session's working set (ADR-0022 source event) -- it does
    // NOT mint a new session. createSession is called once (for openSession),
    // never again for the drop.
    vi.mocked(createSession).mockResolvedValueOnce("sess-1");
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("dropped") });
    render(<App />);
    await openSession();
    // Simulate a webview drop while sess-1 is active.
    dropEvent.handler!({ payload: { type: "drop", paths: ["/x/new.csv"] } });
    await waitFor(() =>
      expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/new.csv"),
    );
    // The drop did NOT mint a new session (only the openSession create fired).
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("keeps the full verbatim question in title for head-preserving truncation (ADR-0054)", async () => {
    // The rail truncates the verbatim question at a fixed width with a TAIL
    // ellipsis (keeps the head -- the identity handle, ADR-0039). jsdom has no
    // layout so the rendered glyph is not assertable; the contract is that the
    // full text rides the span's title so hover recovers it and the head stays
    // visible in the truncated view.
    const longQuestion = "前".repeat(120);
    state.thread = [
      {
        entry: "Turn",
        data: { question: longQuestion, outcome: { kind: "Cancelled" } },
      },
    ];
    render(<App />);
    await openSession();
    // The thread loads async (conversation IPC); wait for the turn card to
    // render before asserting the truncation contract on its question span.
    const q = await waitFor(() => {
      const el = document.querySelector(".turn-question");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(q.getAttribute("title")).toBe(longQuestion);
  });
});
