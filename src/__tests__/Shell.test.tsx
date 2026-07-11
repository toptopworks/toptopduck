import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatasetDescriptor, RowPage, ThreadEntry, TurnOutcome, TurnProgress } from "../types";

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

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    closeSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => "sess-1"),
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
    readRows: vi.fn(),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: true,
    })),
    getAppConfig: vi.fn(async () => null),
  };
});

import App from "../App";
import {
  askQuestion,
  cancelQuery,
  closeSession,
  conversation,
  createSession,
  ingestFile,
  readRows,
  renameSession,
} from "../api";

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
    // Rename dialog: type a new name and save. The dialog input is class-scoped
    // (the active session's question bar also exposes a textbox).
    const input = document.querySelector(".rename-session-input") as HTMLInputElement;
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
