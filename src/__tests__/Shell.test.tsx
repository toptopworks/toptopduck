import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { DatasetDescriptor, RowPage } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { ThreadEntry, TurnOutcome } from "../types/thread";

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

// WindowControls (custom titlebar, ADR-0074) is the sole remaining
// consumer of getCurrentWindow. The shared stub keeps jsdom off the real
// runtime (which reads window.__TAURI metadata and crashes the shell-level
// boundary).
import { buildTauriWindowMock } from "./setup/tauriWindowMock";

vi.mock("@tauri-apps/api/window", () => buildTauriWindowMock().module);

const state = vi.hoisted(() => ({
  workingSet: [] as DatasetDescriptor[],
  thread: [] as ThreadEntry[],
}));

// ADR-0059 turn-progress capture: the SessionPane mounts a long-lived listener
// on mount. Capturing the callback here lets a test emit a turn-progress event
// (Thinking / the tool-call stream, ADR-0078) and assert the QuestionBar
// renders the discrete feedback, then assert it clears when the ask resolves.
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
    // The app-level approval channel (issue #297) mounts on App render; no
    // Shell.test scenario drives approvals, so inert no-op listeners keep the
    // real @tauri-apps/api/event listen (absent in jsdom) from firing.
    onApprovalRequest: vi.fn(async () => () => {}),
    onApprovalResolved: vi.fn(async () => () => {}),
    respondToolApproval: vi.fn(async () => {}),
    readRows: vi.fn(),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: true,
      keychain_fault: null,
    })),
    // listProviderProfiles feeds the per-profile has_key overlay consumed by
    // ColdStartHero + ComposerProviderPicker (mounted via SessionPane) on App
    // mount. Default empty; no Shell.test override relies on a populated overlay.
    listProviderProfiles: vi.fn(async () => []),
    // Per-session MCP status feeds the composer "+" badge (issue #351).
    // Default empty read; the badge tests override it.
    listMcpServerStatus: vi.fn(async () => []),
    getAppConfig: vi.fn(async () => null),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
  };
});

import App from "../App";
import { open } from "@tauri-apps/plugin-dialog";
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
  getProviderConfig,
  ingestFile,
  listMcpServerStatus,
  listSessions,
  listWorkingSet,
  openDuck,
  readRows,
  renameSession,
  setAppConfig,
} from "../api";
import type { AppConfig } from "../types/app-config";
import type { McpServerConfig, McpServerStatusEntry } from "../types/mcp";

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
        data: {
          promotions: [{ dataset: src(referenceName), sql: "SELECT 1" }],
          viz: null,
          assumption: null,
        },
      },
      trace: [],
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
    const sidebar = document.querySelector(".session-sidebar");
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(false);
    // Expanded sidebar stays in the Tab sequence (issue #287).
    expect(sidebar?.hasAttribute("inert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "收起会话栏" }));
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(true);
    // Collapsed sidebar is inert: the subtree leaves the Tab sequence + a11y
    // tree so keyboard / screen-reader focus cannot land on the opacity-0
    // controls (ghost-focus fix, issue #287).
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    // Toggling back expands + restores the Tab sequence.
    fireEvent.click(screen.getByRole("button", { name: "展开会话栏" }));
    expect(shell?.classList.contains("sidebar-collapsed")).toBe(false);
    expect(sidebar?.hasAttribute("inert")).toBe(false);
  });

  it("shows the hero empty state when no result is viewed (ADR-0062 R2 hero)", async () => {
    render(<App />);
    await openSession();
    // The hero's drop hint is visible in the default 结果 tab. The
    // standalone pick button retired into the composer "+" file section
    // (issue #351); the hero keeps the drag-and-drop shortcut copy.
    expect(screen.getByText(/把数据文件拖到窗口/)).toBeInTheDocument();
  });

  it("derives result content after a Materialized ask (R2 result state)", async () => {
    state.workingSet = [src("people")];
    vi.mocked(askQuestion).mockResolvedValue({
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
        viz: null,
        assumption: null,
      },
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
      data: {
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
        viz: null,
        assumption: null,
      },
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
          trace: [],
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

  it("renders a failed turn's typed failure via the locale catalog (issue #125)", async () => {
    // The workspace's TextualOutcomeCard renders a Failed turn by TurnFailure
    // kind through the locale catalog (no backend Display string crosses IPC);
    // the engine detail rides the collapsed TechnicalDetailsFold.
    state.workingSet = [src("result_1")];
    state.thread = [
      {
        entry: "Turn",
        data: {
          question: "坏查询",
          outcome: {
            kind: "Failed",
            data: { kind: "Execute", data: { detail: "no_such_col" } },
          },
          trace: [],
        },
      },
    ];
    render(<App />);
    await openSession();
    // The workspace shows the Failed textual card (distinct from the Thread
    // rail's .turn-outcome.failed). Scope the message assertions to the card:
    // the rail renders the same Execute locale message under a different class.
    await waitFor(() =>
      expect(document.querySelector(".textual-card.failed")).toBeInTheDocument(),
    );
    const card = document.querySelector(".textual-card.failed") as HTMLElement;
    expect(within(card).getByText("执行查询失败")).toBeInTheDocument(); // error.turn.execute
    expect(within(card).getByText("no_such_col")).toBeInTheDocument(); // fold detail
  });

  it("elevates in-content cards (textual-card + working-set panels) with shadow-sm (issue #222)", async () => {
    // ADR-0067 (2) + issue #222: in-content cards share one elevation language
    // with the floating dialog (shadow-lg) / popover (shadow-md) layer above
    // them. The workspace textual-card (full-width outcome) and the working-set
    // master/detail panels carry the Tailwind shadow-sm utility -- no new
    // --shadow-* token (ADR-0067 (2) rules one out). The rail turn-card
    // (ADR-0047) stays flat (rail density should not lift) and the degrade-card
    // stays shadow-none (its left border is the emphasis), so neither is pinned
    // here. jsdom cannot paint a box-shadow, but it CAN assert the className,
    // so a regression that drops shadow-sm while leaving the bg-card/border
    // chrome stays caught (same pin shape as the SessionSidebar
    // session-menu shadow-md tests).
    state.workingSet = [src("result_1")];
    state.thread = [
      {
        entry: "Turn",
        data: {
          question: "哪个名字",
          outcome: {
            kind: "Textual",
            data: { text_kind: "Clarify", body: "请说明哪个名字", assumption: null },
          },
          trace: [],
        },
      },
    ];
    render(<App />);
    await openSession();
    // Result tab: the workspace textual-card carries shadow-sm.
    await waitFor(() => expect(document.querySelector(".textual-card")).toBeInTheDocument());
    expect(document.querySelector(".textual-card")?.className.split(/\s+/)).toContain("shadow-sm");
    // Working set tab: both master/detail .panel sections carry shadow-sm.
    fireEvent.click(screen.getByRole("tab", { name: /工作集/ }));
    await waitFor(() => expect(document.querySelectorAll(".panel")).toHaveLength(2));
    document.querySelectorAll(".panel").forEach((panel) => {
      expect(panel.className.split(/\s+/)).toContain("shadow-sm");
    });
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
    // Wait for both panes to fire their thread query -- conversation runs in
    // the SessionPane mount effect (async), so asserting it synchronously
    // right after createSession races the query fire (flake on slower CI).
    await waitFor(() => expect(conversation).toHaveBeenCalledTimes(2));

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

  it("renders Thinking / tool-call phase labels during an in-flight ask", async () => {
    const { resolve } = pendingAsk();
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The ask is in flight: the stop button replaces submit.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument(),
    );
    // Phase-label assertions scope to the QuestionBar: the rail's live turn
    // card (issue #297) shows its own 思考中 hint from ask start, so a global
    // text query would match two surfaces.
    const bar = () => document.querySelector(".question-bar") as HTMLElement;

    // Thinking{attempt: 1} -> bare verb "思考中…" (no "第 1 次" noise).
    turnProgressCb.current!({
      session_id: "sess-1",
      phase: { Thinking: { attempt: 1 } },
    });
    await waitFor(() => expect(within(bar()).getByText("思考中…")).toBeInTheDocument());

    // A tool-call event (ADR-0078 stream) -> the bar's compact "执行中…"; the
    // per-call detail rides the rail's live trace card, not the bar.
    turnProgressCb.current!({
      session_id: "sess-1",
      phase: {
        ToolCallStarted: {
          name: "materialize",
          operation_kind: "write",
          summary: "SELECT 1",
        },
      },
    });
    await waitFor(() => expect(within(bar()).getByText("执行中…")).toBeInTheDocument());

    // Outcome lands -> phase clears (ADR-0059 handleAsk finally).
    resolve({ kind: "Cancelled" });
    await waitFor(() =>
      expect(within(bar()).queryByText(/执行中/)).not.toBeInTheDocument(),
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
    const bar = () => document.querySelector(".question-bar") as HTMLElement;
    // A phase for a DIFFERENT session is filtered out -- the bar carries no
    // indicator (the rail's live card shows its own ask-start 思考中 hint, so
    // the filter contract is asserted on the bar surface).
    turnProgressCb.current!({
      session_id: "other-session",
      phase: { Thinking: { attempt: 1 } },
    });
    await waitFor(() =>
      expect(within(bar()).queryByText(/思考中/)).not.toBeInTheDocument(),
    );
    // The same phase for THIS session lights up.
    turnProgressCb.current!({
      session_id: "sess-1",
      phase: { Thinking: { attempt: 1 } },
    });
    await waitFor(() => expect(within(bar()).getByText("思考中…")).toBeInTheDocument());
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
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" }, trace: [] } },
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
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" }, trace: [] } },
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

    // ADR-0067 (issue #182): the strip migrated from a bespoke <p> tint to a
    // shadcn Alert default variant, with role="status" + aria-live="polite"
    // OVERRIDING the Alert's role="alert" assertive default (alert.tsx sets
    // role before spreading props, so the caller override wins). A regression
    // that drops either attribute lets a screen reader interrupt the user on
    // every resume tick. Pin the override so the a11y contract is guarded.
    const resumeAlert = document.querySelector(".resume-progress") as HTMLElement;
    expect(resumeAlert).not.toBeNull();
    expect(resumeAlert.getAttribute("role")).toBe("status");
    expect(resumeAlert.getAttribute("aria-live")).toBe("polite");
    expect(resumeAlert.getAttribute("data-slot")).toBe("alert");

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
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
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
    // Real IPC shape (issue #119): a typed SessionError reject, not a JS Error.
    // The close-wait timeout detail rides Engine.data; the shell must surface
    // it in the collapsed fold (review H1), not drop it for "Internal error".
    vi.mocked(closeSessionAndWaitRelease).mockRejectedValue({
      kind: "Engine",
      data: "close-wait timed out (in-flight ask unfinished after 120s); retry shortly",
    });

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

    // Review H1: the shell surfaces the Engine detail in a collapsed fold
    // (mirroring the session pane), so the actionable "retry shortly" hint is
    // not lost when a close-wait reject lands at the shell layer. Previously
    // the shell rendered only the bare locale message and the detail vanished.
    const shellFold = document.querySelector(".shell-error .error-details");
    expect(shellFold).not.toBeNull();
    expect(shellFold?.textContent).toContain("close-wait timed out");
  });
});

// A minimal valid AppConfig for the #84 persistence tests (the shell prefs are
// the only field under test; the rest are just-shape defaults). The helper fills
// `sidebar_grouping: "flat"` (the serde default) so callers stay focused on the
// collapse prefs they actually exercise (#251 added the grouping field).
function baseAppConfig(
  shell: Omit<AppConfig["shell"], "sidebar_grouping">,
): AppConfig {
  return {
    format_version: 1,
    theme: "system",
    locale: "system",
    engine: { memory_limit: "512MB", threads: 1, row_cap: 100, statement_timeout_ms: 30000 },
    privacy: { send_samples: true },
    provider: {
      profiles: [
        {
          id: "default",
          display_name: "Anthropic",
          protocol: "anthropic",
          base_url: "https://api.anthropic.com",
          model: "claude-sonnet-4-6",
        },
      ],
      active_profile: "default",
    },
    export: { last_dir: null, default_format: "csv" },
    tunables: { window_turns: 6, far_window: 12 },
    recent_files: [],
    shell: { ...shell, sidebar_grouping: "flat" },
    mcp_servers: { servers: [] },
  };
}

// A minimal configured MCP server (issue #301 wire shape) so a composer "+"
// test can flip the registry non-empty and leave the degraded mode.
function mcpServer(id: string): McpServerConfig {
  return {
    id,
    display_name: id,
    transport: { type: "stdio", command: "/bin/srv", args: [] },
    env: {},
    keychain_env_keys: [],
    timeout_ms: null,
  };
}

// A per-session MCP status row (issue #301 slice D shape).
function mcpStatus(id: string, enabled: boolean): McpServerStatusEntry {
  return { id, display_name: id, enabled, connected: false, tool_count: 0, error: null };
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
    const rail = document.querySelector(".session-rail");
    expect(shell?.classList.contains("rail-collapsed")).toBe(false);
    expect(rail?.hasAttribute("inert")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "折叠对话栏" }));
    expect(shell?.classList.contains("rail-collapsed")).toBe(true);
    // Collapsed rail is inert (ghost-focus fix, issue #287).
    expect(rail?.hasAttribute("inert")).toBe(true);
    // Toggle back expands + restores the Tab sequence.
    fireEvent.click(screen.getByRole("button", { name: "展开对话栏" }));
    expect(shell?.classList.contains("rail-collapsed")).toBe(false);
    expect(rail?.hasAttribute("inert")).toBe(false);
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

  it("starts a session with the workspace collapsed (ADR-0083 cold start, issue #298)", async () => {
    // The workspace panel defaults to COLLAPSED -- a fresh session (and every
    // pane mount: new / resume / app start) begins folded; the header toggle
    // is the manual open path.
    render(<App />);
    await openSession();
    const pane = document.querySelector(".session-pane");
    expect(pane?.classList.contains("workspace-collapsed")).toBe(true);
    expect(screen.getByRole("button", { name: "展开工作区" })).toBeInTheDocument();
  });

  it("opens / closes the workspace via the header toggle (manual fold)", async () => {
    render(<App />);
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "展开工作区" }));
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(false);
    // The toggle flips to its close label once open.
    fireEvent.click(screen.getByRole("button", { name: "收起工作区" }));
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(true);
  });

  it("the first Materialized promotion auto-expands the workspace ONCE (ADR-0083)", async () => {
    vi.mocked(askQuestion)
      .mockResolvedValueOnce({
        kind: "Materialized",
        data: {
          promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
          viz: null,
          assumption: null,
        },
      })
      .mockResolvedValueOnce({
        kind: "Materialized",
        data: {
          promotions: [{ dataset: { ...src("result_2"), row_count: 1 }, sql: "SELECT 2" }],
          viz: null,
          assumption: null,
        },
      });
    render(<App />);
    await openSession();
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(true);
    // First promotion -> the panel opens with the produced dataset.
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第一问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(false),
    );
    // The user folds it back; the one-shot is spent.
    fireEvent.click(screen.getByRole("button", { name: "收起工作区" }));
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(true);
    // A SECOND promotion must not steal focus -- the fold stays.
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第二问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(true);
  });

  it("on resume, the first NEW promotion still auto-expands (one-shot survives R5 init, ADR-0083)", async () => {
    // Resume lands viewedResult on the prior Materialized primary via the R5
    // init effect in useViewedResult -- NOT via markProduced, so the workspace
    // auto-expand one-shot stays intact. A subsequent first ask must still open
    // the panel. Locks the seam against rerouting R5 through markProduced
    // (which would silently spend the one-shot on a turn the user never asked).
    state.thread = [materializedTurn("result_1")];
    vi.mocked(askQuestion).mockResolvedValueOnce({
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_2"), row_count: 1 }, sql: "SELECT 2" }],
        viz: null,
        assumption: null,
      },
    });
    render(<App />);
    await openSession();
    // Resume cold-start: folded (the one-shot is intact, not spent by R5).
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(true);
    // The first NEW promotion after resume opens the panel.
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "新问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(false),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
  });

  it("a rail preview-card click opens the workspace on the same dataset (dual view, issue #298)", async () => {
    // The rail preview card and the workspace panel are dual views of the
    // same dataset: clicking the card selects its result AND unfolds the
    // workspace onto it (cold start is collapsed).
    state.thread = [materializedTurn("result_1")];
    render(<App />);
    await openSession();
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: /result_1 的预览/ }));
    // The fold opens and the workspace shows result_1's table (the viewed
    // selection landed -- the card reads back as active).
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /result_1 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("switching the viewed dataset with the panel already open (dual view, issue #298)", async () => {
    // Dual-view linkage is not only "collapsed -> click -> open": with the
    // panel already open, clicking another card swaps viewedResult and the
    // active marker follows. expandWorkspace is a no-op when already open;
    // selectResult carries the switch.
    state.thread = [materializedTurn("result_1"), materializedTurn("result_2")];
    render(<App />);
    await openSession();
    // Open the workspace onto result_1.
    fireEvent.click(await screen.findByRole("button", { name: /result_1 的预览/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /result_1 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // Click result_2's card: the workspace swaps + the active marker moves.
    fireEvent.click(screen.getByRole("button", { name: /result_2 的预览/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_2/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /result_2 的预览/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    // result_1's card drops the active marker (aria-current absent).
    expect(screen.getByRole("button", { name: /result_1 的预览/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("a rail result-link click also unfolds the workspace (issue #298)", async () => {
    state.thread = [materializedTurn("result_1")];
    render(<App />);
    await openSession();
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: /结果：result_1/ }));
    expect(document.querySelector(".session-pane")?.classList.contains("workspace-collapsed")).toBe(false);
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
        // Nested objectContaining: the commit also carries sidebar_grouping
        // (#251), which this collapse-only test stays agnostic to.
        expect.objectContaining({
          shell: expect.objectContaining({ sidebar_collapsed: true, rail_collapsed: false }),
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
          shell: expect.objectContaining({ sidebar_collapsed: false, rail_collapsed: true }),
        }),
      ),
    );
  });

  it("collapses the settings overlay left nav via the top-bar toggle (issue #285)", async () => {
    // The settings overlay's left nav collapses from the SAME topbar slot as
    // the workspace session-sidebar toggle (settings-mode swaps in the settings
    // kind). Unlike the workspace collapse prefs this is a TEMP state -- it
    // never rides app-config, so this test asserts only the className flip, not
    // a setAppConfig commit.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    // Settings open: the topbar toggle now folds the settings nav. Default is
    // expanded, so the button offers the collapse action.
    const shell = document.querySelector(".shell");
    expect(shell?.classList.contains("settings-nav-collapsed")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "折叠设置导航" }));
    expect(shell?.classList.contains("settings-nav-collapsed")).toBe(true);
    // Toggle back expands.
    fireEvent.click(screen.getByRole("button", { name: "展开设置导航" }));
    expect(shell?.classList.contains("settings-nav-collapsed")).toBe(false);
  });

  it("resets the settings nav to expanded on each open (temp state, issue #285)", async () => {
    // The collapse is per-open temp state (not persisted): closing + reopening
    // settings always starts expanded, even if the user folded the nav on the
    // prior visit. openSettings resets the flag on every entry, so a folded nav
    // does not leak across a close/reopen. ESC closes the overlay (the folded
    // nav hides its own back button, so the window-level Escape listener is the
    // reachable close path in the collapsed state).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    fireEvent.click(screen.getByRole("button", { name: "折叠设置导航" }));
    expect(
      document.querySelector(".shell")?.classList.contains("settings-nav-collapsed"),
    ).toBe(true);
    // Close via ESC, then reopen -- the nav is expanded again (no persisted
    // collapse to recall).
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(
      document.querySelector(".shell")?.classList.contains("settings-nav-collapsed"),
    ).toBe(false);
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

  it("recovers the full verbatim question via hover Tooltip (ADR-0050/0054, #106)", async () => {
    // The rail truncates the verbatim question at a fixed width with a TAIL
    // ellipsis (keeps the head -- the identity handle, ADR-0039). jsdom has no
    // layout so the rendered glyph is not assertable; the contract is that the
    // full text rides a Radix Tooltip (ADR-0050 maps Tooltip to card-truncation
    // full-text recovery) so a hover recovers it, replacing the v0 native title
    // attribute.
    const longQuestion = "前".repeat(120);
    state.thread = [
      {
        entry: "Turn",
        data: { question: longQuestion, outcome: { kind: "Cancelled" }, trace: [] },
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
    // The native title is gone (replaced by the Radix Tooltip); moving the
    // pointer over the truncated span opens the tooltip. Radix renders the
    // content into a portal and also mirrors it once in a visually-hidden
    // role="tooltip" node (the trigger's aria-describedby target, a single
    // unmirrored text copy), so getByRole("tooltip") carries the full verbatim
    // text exactly once.
    expect(q.getAttribute("title")).toBeNull();
    fireEvent.pointerMove(q);
    await waitFor(() => {
      expect(screen.getByRole("tooltip").textContent).toBe(longQuestion);
    });
  });
});

describe("App session soft-cap hint (ADR-0046/0050, issue #108)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("renders the soft-cap hint as a warning status Alert once open sessions hit the cap", async () => {
    // ADR-0046: too many open sessions risk memory pressure. The hint migrated
    // from a bespoke .topbar-softcap span to a warning Alert (ADR-0050);
    // role="status" is polite. Opening >= SOFT_CAP_OPEN_SESSIONS (8) sessions
    // lights it. within(topbar) scopes the role query: each open SessionPane's
    // QuestionBar also carries a role="status" phase-indicator, so a global
    // getByRole would match many; the soft-cap Alert is the only status inside
    // the topbar.
    let n = 0;
    vi.mocked(createSession).mockImplementation(async () => `sess-${++n}`);
    render(<App />);
    for (let i = 0; i < 8; i++) {
      fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
      );
    }
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(8));
    const topbar = document.querySelector(".topbar") as HTMLElement;
    const alert = within(topbar).getByRole("status");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/打开的会话较多/);
  });
});

describe("App topbar header actions + sidebar connection footer (issue #182 / #282)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // clearAllMocks only clears call history, not implementations set by prior
    // describes.
    // The C1 guard test below needs appConfig=null (the cold-start default) so
    // the sidebar footer -- the settings entry since issue #282 -- stays
    // ABSENT (its render-when-ready replaces the retired topbar gear's
    // settingsDisabled gate). getAppConfig's real signature is
    // Promise<AppConfig> (null is an App-level state, not an IPC return), so
    // hold the mock pending -- the mount effect's .then never fires and
    // appConfig stays at its useState(null) initial.
    vi.mocked(getAppConfig).mockImplementation(
      () => new Promise<AppConfig>(() => {}),
    );
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("disables both header buttons on cold start (no active session)", async () => {
    // Cold-start gate: Open/Save ride disabled={busy || !activeSession}. The
    // settings gear + key badge left the topbar for the sidebar footer (issue
    // #282); the header cluster is exactly the two file actions. A regression
    // that drops the gate lets Open/Save fire with nothing to act on.
    render(<App />);
    const buttons = await waitFor(() => {
      const list = document.querySelectorAll(
        ".header-actions [data-slot='button']",
      );
      expect(list.length).toBe(2);
      return list;
    });
    buttons.forEach((btn) =>
      expect((btn as HTMLButtonElement).disabled).toBe(true),
    );
  });

  it("re-enables open/save with a session active", async () => {
    render(<App />);
    await openSession();
    const buttons = document.querySelectorAll(
      ".header-actions [data-slot='button']",
    );
    expect(buttons).toHaveLength(2);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false); // Open
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(false); // Save
  });

  it("keeps the settings entry absent until appConfig resolves (C1 render-when-ready)", async () => {
    // C1: opening settings while appConfig is null white-screens the shell
    // (.settings-mode hides the shell but SettingsView does not render, no
    // ESC exit). The sidebar footer's render-when-ready keeps the state
    // unreachable -- the sidebar itself mounts (cold start) but carries no
    // gear + connection row while the config stays pending (the beforeEach
    // holds getAppConfig pending).
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".session-sidebar")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
    expect(document.querySelector(".session-sidebar .connection-status")).toBeNull();
  });

  it("mounts the sidebar gear + connection row once appConfig resolves", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    render(<App />);
    // The gear (workspace half of the dual-state toggle) + the connection row
    // carrying the active profile land at the sidebar bottom.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    const sidebar = document.querySelector(".session-sidebar") as HTMLElement;
    expect(within(sidebar).getByText("Anthropic")).toBeInTheDocument();
  });

  it("anchors the connected dot on the --primary token (ADR-0050, issue #182/#282)", async () => {
    // The key-state visual moved from the topbar badge (hardcoded #1a7a3a /
    // #b06000, later a shadcn Badge + text-primary / text-warning) to the
    // sidebar connection row's status dot, re-anchored on the same ADR-0050
    // semantic tokens: bg-primary (connected), bg-warning (no key),
    // bg-destructive (keychain fault).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    vi.mocked(getProviderConfig).mockResolvedValue({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: true,
      keychain_fault: null,
    });
    render(<App />);
    await waitFor(() => {
      const row = document.querySelector(
        ".session-sidebar .connection-row",
      ) as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.querySelector(".rounded-full")?.classList.contains("bg-primary")).toBe(true);
      expect(within(row).getByText("已连接")).toBeInTheDocument();
    });
  });

  it("anchors the no-key dot on the --warning token + reads 无 key", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    vi.mocked(getProviderConfig).mockResolvedValue({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: false,
      keychain_fault: null,
    });
    render(<App />);
    await waitFor(() => {
      const row = document.querySelector(
        ".session-sidebar .connection-row",
      ) as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.querySelector(".rounded-full")?.classList.contains("bg-warning")).toBe(true);
      expect(within(row).getByText("无 key")).toBeInTheDocument();
    });
  });

  it("renders the keychain-unavailable row when the active read faults (issue #275)", async () => {
    // The pre-#275 honest-degrade hid a keychain read fault behind
    // has_key=false; the row now carries keychain_fault and reads 密钥库不可用
    // + the destructive dot instead of misreading as "no key configured".
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    vi.mocked(getProviderConfig).mockResolvedValue({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: false,
      keychain_fault: "keychain access failed: locked",
    });
    render(<App />);
    await waitFor(() => {
      const row = document.querySelector(
        ".session-sidebar .connection-row",
      ) as HTMLElement;
      expect(row).not.toBeNull();
      expect(row.querySelector(".rounded-full")?.classList.contains("bg-destructive")).toBe(true);
      expect(within(row).getByText("密钥库不可用")).toBeInTheDocument();
    });
  });
});

describe("App Ctrl/⌘+K session-search modal (ADR-0072, issue #252)", () => {
  // Two persisted sessions feed the modal: alpha (fresher) + beta. The default
  // listSessions mock returns []; these tests override per-render.
  function twoSessions() {
    return [
      {
        session_id: "/x/alpha.duck",
        display_name: "alpha session",
        last_modified_at: 2000,
        source_summary: { first_source_name: "alpha_src", source_count: 1, turn_count: 3 },
        format_version: 2,
      },
      {
        session_id: "/x/beta.duck",
        display_name: "beta session",
        last_modified_at: 1000,
        source_summary: { first_source_name: "beta_src", source_count: 1, turn_count: 7 },
        format_version: 2,
      },
    ];
  }

  it("does not render the search modal on cold start", () => {
    render(<App />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Ctrl+K opens the search modal (Win/Linux) + lists persisted sessions", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    // Wait for the cold-start list_sessions fetch to land so the modal sees the
    // sessions on open.
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    // jsdom does NOT bubble DOM keydown to window-level listeners, so dispatch
    // on window directly (wrapped in act for the state toggle).
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Both persisted sessions render as options (alpha fresher -> first).
    const options = within(dialog).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("alpha session");
  });

  it("⌘+K opens the search modal (macOS metaKey)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("clicking the sidebar search button opens the same modal (issue #250 button)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    fireEvent.click(document.querySelector(".sidebar-search-button") as HTMLButtonElement);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("typing filters the result list (case-insensitive on name + source)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    // "ALPHA_SRC" hits alpha via its first_source_name.
    fireEvent.change(input, { target: { value: "ALPHA_SRC" } });
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("alpha session"),
    ]);
  });

  it("Enter on the highlighted option opens the persisted session", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    // Default selection is alpha (fresher); Enter resumes it via openPersisted
    // -> openDuck(sid, path). The IPC hop is async, so waitFor for the call to
    // land. openDuck takes the freshly-minted sid + the path; only the path
    // matters for this assertion (the sid is an internal correlation id).
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(openDuck).toHaveBeenCalledWith(expect.any(String), "/x/alpha.duck"),
    );
  });

  it("ESC closes the modal (Radix Dialog onOpenChange→false)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
  });

  it("Ctrl/⌘+K does not reopen the modal while the shell is busy (resume in flight)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    // openDuck never resolves -> resumeStatus sticks at "opening" -> busy=true,
    // which the App-level busyRef gate reads to drop the second Ctrl/⌘+K. This
    // is the keyboard-side mirror of the sidebar search button's disabled-when-
    // busy contract (SessionSidebar.shell.test.tsx); the two gates are独立.
    vi.mocked(openDuck).mockReturnValue(new Promise(() => {}));
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    // First Ctrl+K opens (busy still false); Enter on the default option kicks
    // openPersisted -> openDuck (now pending) -> busy flips true.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(within(dialog).getByRole("combobox"), { key: "Enter" });
    // Wait for the dialog to close (choose -> onOpenChange(false)) AND busy to
    // flip (resumeStatus moved to "opening" by the pending openDuck; busyRef
    // syncs via useEffect on the next commit).
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Now busy: a second Ctrl+K must NOT reopen the modal.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Ctrl/⌘+K toggles the modal closed when it is already open (not busy)", async () => {
    vi.mocked(listSessions).mockResolvedValue(twoSessions());
    render(<App />);
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    // First Ctrl+K opens.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Second Ctrl+K (shell not busy) toggles it closed -- matches the Linear /
    // Raycast / VS Code ⌘K convention.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Composer control row (ADR-0083, issues #350/#351)", () => {
  // The QuestionBar row evolves into the composer control row: three slots
  // ([+] session-context panel / approval mode / runtime) + the flex-1
  // question input. Issue #351 lights the add slot (panel shell + file
  // section + degraded mode + badge); approval mode stays an empty
  // placeholder until #302 lights it up; the runtime slot is occupied by the
  // existing provider/model picker (ADR-0071) until the runtime chip evolves.
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    // clearAllMocks only clears call history, not implementations set by prior
    // describes -- hold getAppConfig pending so appConfig stays at its
    // useState(null) initial and the picker bundle stays absent (per-test
    // overrides resolve it).
    vi.mocked(getAppConfig).mockImplementation(() => new Promise<AppConfig>(() => {}));
    // Same trap for the session-scoped mocks the pane rides: the resume /
    // delete / error-boundary / soft-cap describes swap implementations that
    // survive clearAllMocks, and this describe's ingest / badge assertions
    // depend on the exact sessionId + clean reads. Pin the factory behavior
    // back (mirrors the error-boundary describe's conversation reset).
    vi.mocked(createSession).mockResolvedValue("sess-1");
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(activeDataset).mockImplementation(async () => null);
    vi.mocked(listMcpServerStatus).mockResolvedValue([]);
    // The dialog starts cancelled; the ingest tests override per test.
    vi.mocked(open).mockResolvedValue(null);
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("people") });
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("renders the three composer slots before the question input", async () => {
    render(<App />);
    await openSession();
    const bar = document.querySelector(".session-questionbar");
    expect(bar).toBeInTheDocument();
    const addSlot = bar?.querySelector(".composer-slot-add");
    const approvalSlot = bar?.querySelector(".composer-slot-approval");
    const runtimeSlot = bar?.querySelector(".composer-slot-runtime");
    expect(addSlot).toBeInTheDocument();
    expect(approvalSlot).toBeInTheDocument();
    expect(runtimeSlot).toBeInTheDocument();
    // The slot order is fixed (ADR-0083): [+] / approval mode / runtime, all
    // ahead of the question input.
    const input = screen.getByRole("textbox", { name: "提问" });
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(
      (addSlot as HTMLElement).compareDocumentPosition(approvalSlot as HTMLElement) & FOLLOWING,
    ).toBeTruthy();
    expect(
      (approvalSlot as HTMLElement).compareDocumentPosition(runtimeSlot as HTMLElement) & FOLLOWING,
    ).toBeTruthy();
    expect(
      (runtimeSlot as HTMLElement).compareDocumentPosition(input) & FOLLOWING,
    ).toBeTruthy();
  });

  it("the [+] slot hosts the context-panel trigger; approval-mode stays an empty placeholder", async () => {
    render(<App />);
    await openSession();
    const bar = document.querySelector(".session-questionbar");
    // Issue #351 lights the add slot: with app-config still pending (no
    // configured MCP, no skill system) the trigger is the degraded pure
    // add-files button.
    const addSlot = bar?.querySelector(".composer-slot-add");
    const trigger = screen.getByRole("button", { name: "添加文件" });
    expect(addSlot?.contains(trigger)).toBe(true);
    expect(bar?.querySelector(".composer-slot-approval")).toBeEmptyDOMElement();
  });

  it("degraded [+] opens the multi-select dialog and ingests every picked file", async () => {
    vi.mocked(open).mockResolvedValue(["/a.csv", "/b.csv"]);
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("people") });
    render(<App />);
    await openSession();

    fireEvent.click(screen.getByRole("button", { name: "添加文件" }));

    // The batch rides the existing ingest pipeline, one call per file, in
    // pick order (handleIngestMany, issue #351).
    await waitFor(() => expect(ingestFile).toHaveBeenCalledWith("sess-1", "/a.csv"));
    await waitFor(() => expect(ingestFile).toHaveBeenCalledWith("sess-1", "/b.csv"));
  });

  it("with configured MCP servers [+] opens the three-section panel shell", async () => {
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
      mcp_servers: { servers: [mcpServer("srv")] },
    });
    render(<App />);
    await openSession();

    fireEvent.click(
      await screen.findByRole("button", { name: "添加会话上下文" }),
    );

    // File section live; skills + MCP sections disabled placeholders.
    expect(
      await screen.findByRole("button", { name: "选择数据文件…" }),
    ).toBeInTheDocument();
    expect(screen.getByText("技能")).toBeInTheDocument();
    expect(screen.getByText("MCP 工具")).toBeInTheDocument();
    expect(screen.getAllByText("即将开放")).toHaveLength(2);
  });

  it("badges the session-enabled MCP count on the [+] trigger", async () => {
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
      mcp_servers: { servers: [mcpServer("srv"), mcpServer("srv2")] },
    });
    vi.mocked(listMcpServerStatus).mockResolvedValue([
      mcpStatus("srv", true),
      mcpStatus("srv2", false),
    ]);
    render(<App />);
    await openSession();

    // One of the two configured servers is enabled for this session -> the
    // badge carries the count (and rides the accessible name).
    expect(
      await screen.findByRole("button", { name: "添加会话上下文（已挂 1 项）" }),
    ).toBeInTheDocument();
  });

  it("hosts the provider/model picker inside the runtime slot once app-config resolves", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false }),
    );
    render(<App />);
    await openSession();
    // The picker trigger (ADR-0071) lands inside the runtime slot of the
    // composer row -- not as a loose sibling of the input.
    const trigger = await screen.findByRole("button", { name: "接入档案与模型" });
    const runtimeSlot = document.querySelector(
      ".session-questionbar .composer-slot-runtime",
    ) as HTMLElement;
    expect(runtimeSlot.contains(trigger)).toBe(true);
  });

  it("keeps the runtime slot empty while app-config is pending", async () => {
    // beforeEach holds getAppConfig pending so appConfig stays at its
    // useState(null) initial -- App does not pass the picker bundle, leaving
    // the runtime slot empty until app-config resolves (SessionPane.tsx).
    render(<App />);
    await openSession();
    const runtimeSlot = document.querySelector(".composer-slot-runtime");
    expect(runtimeSlot).toBeEmptyDOMElement();
  });
});
