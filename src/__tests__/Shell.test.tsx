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
    closeSession: vi.fn(async () => false),
    closeSessionAndWaitRelease: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" })),
    deleteSession: vi.fn(async () => {}),
    listSessions: vi.fn(async () => []),
    renameSession: vi.fn(async () => ""),
    ingestFile: vi.fn(),
    listWorkingSet: vi.fn(async () => state.workingSet),
    activeDataset: vi.fn(async () => null),
    // Default: never resolves — the pendingQuestion from openSession() fires
    // handleAsk, but the turn stays in-flight without processing a result,
    // avoiding state updates that could leak across the test cleanup boundary.
    // Tests that need a result override via mockResolvedValueOnce.
    askQuestion: vi.fn(() => new Promise(() => {})),
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
    prepareImportSession: vi.fn(),
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
    // listProviderProfiles feeds the per-profile has_key overlay consumed by
    // ComposerProviderPicker (mounted via shell-level bar) on App
    // mount. Default empty; no Shell.test override relies on a populated overlay.
    listProviderProfiles: vi.fn(async () => []),
    // Per-session MCP status feeds the composer "+" badge (issue #351).
    // Default empty read; the badge tests override it.
    listMcpServerStatus: vi.fn(async () => []),
    // The composer auth-mode chip reads / writes the session's authorization
    // posture (issue #352). Default per_call read + no-op write; the chip
    // tests override per scenario.
    getAuthorizationMode: vi.fn(async () => "per_call" as const),
    setAuthorizationMode: vi.fn(async () => {}),
    // The composer runtime picker reads / writes the session's runtime choice
    // + the v1 adapter table (issue #353). Default built-in read + empty
    // adapter list + no-op write/rescan; no Shell.test scenario drives a
    // runtime switch, so the defaults keep the picker quiet.
    getSessionRuntime: vi.fn(async () => ({ kind: "built_in" }) as const),
    setSessionRuntime: vi.fn(async () => {}),
    listAdapters: vi.fn(async () => [] as const),
    rescanAdapters: vi.fn(async () => [] as const),
    getAppConfig: vi.fn(async () => null),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
    // The composer "+" panel reads the skill registry + the session's mount set
    // + drives mount / unmount (issue #365, ADR-0086). Defaults: empty registry
    // + empty mount set + no-op writes; the panel stays in degraded mode and no
    // Shell.test scenario drives a toggle, so the defaults keep the panel quiet.
    listSkills: vi.fn(async () => ({ skills: [], ignored: [] })),
    listMountedSkills: vi.fn(async () => []),
    mountSkill: vi.fn(async () => {}),
    unmountSkill: vi.fn(async () => {}),
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
  getAuthorizationMode,
  getSessionRuntime,
  ingestFile,
  listAdapters,
  listMcpServerStatus,
  listSessions,
  listWorkingSet,
  openDuck,
  readRows,
  renameSession,
  rescanAdapters,
  setAppConfig,
  setAuthorizationMode,
  setSessionRuntime,
} from "../api";
import type { AppConfig } from "../types/app-config";
import type { McpServerConfig, McpServerStatusEntry } from "../types/mcp";

// ADR-0092: the sidebar "+" navigates to the centered empty state (no longer
// creates a session). The test helper creates a session via the drop-to-create
// path (dropFile), which mints a session with pendingIngestPath — no turn fires,
// keeping the helper lightweight. For multi-session creation, click "+" first to
// return to cold start, then drop again.
// ADR-0092: the sidebar "+" navigates to the centered empty state (no longer
// creates a session). A session is created by submitting from the shell-level
// bar. This helper clicks "+" (cold start), types + submits. Can be called
// multiple times: each call navigates to empty state first, then creates.
async function openSession(): Promise<void> {
  // Navigate to empty state (sidebar "+"). No-op on fresh render.
  fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
  // ADR-0092: submitting from the centered bar creates the session AND fires the
  // question as the first turn. The helper REJECTS that creation turn so it
  // settles immediately and the session is idle when we return: a resolved
  // outcome would APPEND a turn (hiding the hero / last-turn card many tests
  // assert) and a never-resolving one would leave the bar stuck on the stop
  // button. handleAsk's catch sets loading=false and appends nothing on reject,
  // so the thread stays exactly as `state.thread` provides. The reject surfaces
  // a session error banner, which these black-box assertions ignore. The
  // one-time rejection is queued ahead of any per-test mock so the creation turn
  // — not the test's own turn — consumes it.
  vi.mocked(askQuestion).mockRejectedValueOnce(
    new Error("openSession: discard the creation turn"),
  );
  // The centered bar is always rendered — type and submit to create a session.
  fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
  fireEvent.click(screen.getByRole("button", { name: "提问" }));
  await waitFor(() =>
    expect(document.querySelector(".session-rail")).toBeInTheDocument(),
  );
  // Wait for the creation turn to settle (reject) so the bar returns to idle
  // (submit button back) before the test drives its own interactions.
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
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
      trace: [], provenance: { skills: [] },
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
    expect(document.querySelector(".shell-bar-slot")).toBeInTheDocument();
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
    // Baseline: openSession's creation turn already fired one (rejected) ask.
    const asksBeforeClick = vi.mocked(askQuestion).mock.calls.length;
    // Click result_1 in the rail (the Thread result-link button).
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    // viewedResult moved to result_1; the workspace now shows result_1.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
    // No NEW ask / mutation IPC fired by the click -- active is untouched.
    expect(vi.mocked(askQuestion).mock.calls.length).toBe(asksBeforeClick);
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
    // Scope to the rail: the textarea's value also renders as text content
    // (unlike the former <Input>), so a global getByText would match both.
    await waitFor(() =>
      expect(within(document.querySelector(".session-rail")!).getByText("总共几行")).toBeInTheDocument(),
    );
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
          trace: [], provenance: { skills: [] },
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
          trace: [], provenance: { skills: [] },
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
          trace: [], provenance: { skills: [] },
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

  it("cold start shows the centered bar + greeting and does not createSession (ADR-0061/0092)", async () => {
    // ADR-0092: no auto-resume, no auto-create. The centered bar + greeting
    // show in the main area. createSession has not been called.
    render(<App />);
    expect(screen.getByText(/你想分析什么/)).toBeInTheDocument();
    // The shell-level bar IS rendered (centered), so the textbox is present.
    expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keep-alive switch does not refetch an inactive session (ADR-0051)", async () => {
    // Two sessions opened; each SessionPane fetches its thread once on mount.
    // Switching active never remounts them (CSS hidden keep-alive), so the
    // thread query is NOT re-issued -- conversation stays at one call per
    // session.
    vi.mocked(createSession)
      .mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" })
      .mockResolvedValueOnce({ session_id: "sess-2", duck_path: "/sessions/sess-2/session.duck" });
    render(<App />);
    await openSession();
    await openSession();
    expect(createSession).toHaveBeenCalledTimes(2);
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
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
    render(<App />);
    await openSession();

    // Open the context menu on the one open entry, then Close.
    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭" }));

    await waitFor(() => expect(closeSession).toHaveBeenCalledWith("sess-1"));
    // ADR-0092: the shell-level bar persists (it is always rendered). The
    // session chrome (rail) is gone — that proves the session was closed.
    await waitFor(() =>
      expect(document.querySelector(".session-rail")).not.toBeInTheDocument(),
    );
  });

  it("renames the open session via the sidebar context menu (ADR-0060 single entry)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
    vi.mocked(renameSession).mockResolvedValue("季报");
    render(<App />);
    await openSession();

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
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-drop", duck_path: "/sessions/sess-drop/session.duck" });
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
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
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
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
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
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
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
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } } },
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
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } } },
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
      .mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" })
      .mockResolvedValueOnce({ session_id: "sess-2", duck_path: "/sessions/sess-2/session.duck" });
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
    await openSession();
    // sess-1 shows a degrade card (thread partition caught the crash).
    await waitFor(() =>
      expect(document.querySelector(".degrade-card")).toBeInTheDocument(),
    );
    // Open sess-2 (a second session via the drop path).
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
    vi.mocked(closeSession).mockResolvedValue(false);
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
        duck_path: "/x/persisted.duck",
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
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-resume", duck_path: "/sessions/sess-resume/session.duck" });
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
        duck_path: "/x/persisted.duck",
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
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-resume", duck_path: "/sessions/sess-resume/session.duck" });

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
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
    // closeSession NEVER resolves in this test -- proves the UI does NOT wait.
    vi.mocked(closeSession).mockImplementation(() => new Promise<boolean>(() => {}));

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
    // yet the session chrome is already gone (no await on the IPC). ADR-0092:
    // the shell-level bar persists (always rendered); the session rail is the
    // signal that the pane unmounted.
    await waitFor(() =>
      expect(document.querySelector(".session-rail")).not.toBeInTheDocument(),
    );
    expect(closeSession).toHaveBeenCalledWith("sess-1");

    // The orphan ask resolves after the pane is gone; the cold-start centered
    // bar shows — no ghost turn renders. This test asserts only the FRONTEND
    // contract: the session cache was removed before the orphan resolved, so
    // its optimistic setQueryData cannot surface a turn.
    resolve({
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
        viz: null,
        assumption: null,
      },
    });
    await waitFor(() => expect(screen.getByText(/你想分析什么/)).toBeInTheDocument());
  });

  it("close still unmounts at once when closeSession rejects (ADR-0055 .catch seam, #83)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
    // closeSession REJECTS -- closeOpen's .catch must swallow it so it does
    // NOT surface as an unhandled rejection. If someone drops the .catch (or
    // re-adds an await on closeSession), this test fails on the reject path.
    vi.mocked(closeSession).mockRejectedValueOnce(new Error("backend gone"));

    render(<App />);
    await openSession();
    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭" }));

    // The pane unmounts synchronously even though closeSession rejects.
    // ADR-0092: the shell-level bar persists (always rendered), so the session
    // rail — not the bar's textbox — is the pane-unmounted signal.
    await waitFor(() =>
      expect(document.querySelector(".session-rail")).not.toBeInTheDocument(),
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
    vi.mocked(closeSession).mockResolvedValue(false);
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
        duck_path: path,
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
        format_version: 1,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-del", duck_path: "/sessions/sess-del/session.duck" });

    render(<App />);
    // Open the persisted session (createSession + openDuck).
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));
    // ADR-0092: the shell-level bar (textbox) is always rendered, so the session
    // rail — mounted only with the pane — is the "pane is mounted" signal.
    await waitFor(() =>
      expect(document.querySelector(".session-rail")).toBeInTheDocument(),
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
        duck_path: path,
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
        format_version: 1,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-del", duck_path: "/sessions/sess-del/session.duck" });
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
    // ADR-0092: the shell-level bar (textbox) is always rendered, so the session
    // rail — mounted only with the pane — is the "pane is mounted" signal.
    await waitFor(() =>
      expect(document.querySelector(".session-rail")).toBeInTheDocument(),
    );

    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

    // The wait was called (delete started), but the pane is STILL mounted --
    // UI teardown happens AFTER the wait resolves, not synchronously.
    await waitFor(() =>
      expect(closeSessionAndWaitRelease).toHaveBeenCalledWith("sess-del"),
    );
    // The session rail stays mounted with the pane during the wait.
    expect(document.querySelector(".session-rail")).toBeInTheDocument();
    // deleteSession has NOT fired yet -- it waits on the close-wait variant.
    expect(deleteSession).not.toHaveBeenCalled();

    // Resolve the wait -> the pane unmounts -> deleteSession fires.
    resolveWait();
    await waitFor(() =>
      expect(document.querySelector(".session-rail")).not.toBeInTheDocument(),
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
        duck_path: path,
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: null, source_count: 0, turn_count: 0 },
        format_version: 1,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-del", duck_path: "/sessions/sess-del/session.duck" });
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
    // ADR-0092: the shell-level bar (textbox) is always rendered, so the session
    // rail — mounted only with the pane — is the "pane is mounted" signal.
    await waitFor(() =>
      expect(document.querySelector(".session-rail")).toBeInTheDocument(),
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
      expect(document.querySelector(".session-rail")).not.toBeInTheDocument(),
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
  shell: Pick<AppConfig["shell"], "sidebar_collapsed">,
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
    shell: { ...shell, sidebar_grouping: "flat" },
    mcp_servers: { servers: [] },
    sessions_dir: null,
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
  return { id, display_name: id, enabled, source: enabled ? { kind: "user" } : null, connected: false, tool_count: 0, tools: [], error: null };
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
    render(<App />);
    await openSession();
    // Queue the test's own turns AFTER openSession so the creation turn consumes
    // the helper's one-time rejection, not these Materialized outcomes (which
    // would otherwise auto-expand the workspace during openSession).
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
    // 3 asks total: the creation turn (rejected) + the two user turns.
    await waitFor(() => expect(askQuestion).toHaveBeenCalledTimes(3));
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
    render(<App />);
    await openSession();
    // Queue the test's own turn AFTER openSession so the creation turn consumes
    // the helper's one-time rejection, not this Materialized outcome (which would
    // otherwise auto-expand the workspace + spend the one-shot during openSession).
    vi.mocked(askQuestion).mockResolvedValueOnce({
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_2"), row_count: 1 }, sql: "SELECT 2" }],
        viz: null,
        assumption: null,
      },
    });
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
    // A user who left the sidebar collapsed reopens to sidebar collapsed -- the
    // pref rides app-config (ADR-0038), restored once on the first resolve.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: true }),
    );
    render(<App />);
    await waitFor(() => {
      const shell = document.querySelector(".shell");
      expect(shell?.classList.contains("sidebar-collapsed")).toBe(true);
    });
  });

  it("persists a sidebar collapse toggle into app-config (ADR-0038)", async () => {
    // Toggling a collapse level commits the new shell prefs to app-config so
    // the choice survives a restart (the toggle is not a transient UI flip).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
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
          shell: expect.objectContaining({ sidebar_collapsed: true }),
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
      baseAppConfig({ sidebar_collapsed: false }),
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
      baseAppConfig({ sidebar_collapsed: false }),
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
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
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
        data: { question: longQuestion, outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } },
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
    vi.mocked(createSession).mockImplementation(async () => ({ session_id: `sess-${++n}`, duck_path: `/sessions/sess-${n}/session.duck` }));
    render(<App />);
    for (let i = 0; i < 8; i++) {
      // ADR-0092: each openSession() clicks "+" (cold start) + drops a file to
      // create a session. Wait for createSession call count to increment.
      await openSession();
    }
    expect(createSession).toHaveBeenCalledTimes(8);
    const topbar = document.querySelector(".topbar") as HTMLElement;
    const alert = within(topbar).getByRole("status");
    expect(alert.getAttribute("data-slot")).toBe("alert");
    expect(alert).toHaveTextContent(/打开的会话较多/);
  });
});

describe("App topbar header actions + sidebar settings footer (issue #182 / #282)", () => {
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

  it("keeps the settings entry absent until appConfig resolves (C1 render-when-ready)", async () => {
    // C1: opening settings while appConfig is null white-screens the shell
    // (.settings-mode hides the shell but SettingsView does not render, no
    // ESC exit). The sidebar footer's render-when-ready keeps the state
    // unreachable -- the sidebar itself mounts (cold start) but carries no
    // gear while the config stays pending (the beforeEach holds getAppConfig
    // pending).
    render(<App />);
    await waitFor(() =>
      expect(document.querySelector(".session-sidebar")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "设置" })).toBeNull();
    expect(document.querySelector(".session-sidebar .sidebar-footer")).toBeNull();
  });

  it("mounts the sidebar settings gear once appConfig resolves", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    render(<App />);
    // The settings gear lands at the sidebar bottom once app-config resolves
    // (the connection row + status dot were retired with ConnectionStatus).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    expect(
      document.querySelector(".session-sidebar .sidebar-footer"),
    ).not.toBeNull();
  });
});

describe("App Ctrl/⌘+K session-search modal (ADR-0072, issue #252)", () => {
  // Two persisted sessions feed the modal: alpha (fresher) + beta. The default
  // listSessions mock returns []; these tests override per-render.
  function twoSessions() {
    return [
      {
        duck_path: "/x/alpha.duck",
        display_name: "alpha session",
        last_modified_at: 2000,
        source_summary: { first_source_name: "alpha_src", source_count: 1, turn_count: 3 },
        format_version: 2,
      },
      {
        duck_path: "/x/beta.duck",
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
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" });
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(activeDataset).mockImplementation(async () => null);
    vi.mocked(listMcpServerStatus).mockResolvedValue([]);
    // Same pin for the auth-mode chip IPC pair (issue #352): the resume
    // describe's overrides survive clearAllMocks.
    vi.mocked(getAuthorizationMode).mockResolvedValue("per_call");
    vi.mocked(setAuthorizationMode).mockResolvedValue(undefined);
    // Same pin for the runtime picker IPC quartet (issue #353).
    vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
    vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
    vi.mocked(listAdapters).mockResolvedValue([]);
    vi.mocked(rescanAdapters).mockResolvedValue([]);
    // The dialog starts cancelled; the ingest tests override per test.
    vi.mocked(open).mockResolvedValue(null);
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("people") });
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("renders the three composer controls inside the question-bar toolbar", async () => {
    render(<App />);
    await openSession();
    const bar = document.querySelector(".question-bar");
    expect(bar).toBeInTheDocument();
    // The unified container holds the trigger (+), auth-mode Select, and the
    // textarea -- all inside .question-bar (ADR-0083 composer row restructured
    // into a single container).
    const trigger = screen.getByRole("button", { name: "添加文件" });
    const chip = await screen.findByRole("combobox", { name: "授权模式：请求批准" });
    expect(bar?.contains(trigger)).toBe(true);
    expect(bar?.contains(chip)).toBe(true);
    // The textarea sits above the toolbar row in DOM order.
    const input = screen.getByRole("textbox", { name: "提问" });
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(
      input.compareDocumentPosition(trigger as HTMLElement) & FOLLOWING,
    ).toBeTruthy();
    expect(
      (trigger as HTMLElement).compareDocumentPosition(chip as HTMLElement) & FOLLOWING,
    ).toBeTruthy();
  });

  it("the context-panel trigger and auth-mode chip live inside the question-bar", async () => {
    render(<App />);
    await openSession();
    const bar = document.querySelector(".question-bar");
    // Issue #351: with app-config still pending (no configured MCP, no skill
    // system) the trigger is the degraded pure add-files button.
    const trigger = screen.getByRole("button", { name: "添加文件" });
    expect(bar?.contains(trigger)).toBe(true);
    // Issue #352: the Select reads the session's posture (per_call default)
    // and renders INSIDE the question-bar, not as a loose sibling.
    const authTrigger = await screen.findByRole("combobox", { name: "授权模式：请求批准" });
    expect(bar?.contains(authTrigger)).toBe(true);
  });

  it("switches the auth-mode Select to no-confirmation with the warning color (ADR-0080)", async () => {
    render(<App />);
    await openSession();
    const authTrigger = await screen.findByRole("combobox", { name: "授权模式：请求批准" });

    fireEvent.pointerDown(authTrigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(authTrigger);

    const option = await screen.findByRole("option", { name: /完全访问权限/ });
    fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option);

    await waitFor(() =>
      expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation"),
    );
    // The flipped trigger reads 完全访问权限 and rides the --warning token
    // (border / fill / text all consume it).
    const flipped = await screen.findByRole("combobox", { name: "授权模式：完全访问权限" });
    expect(flipped.className).toContain("border-warning/40");
    expect(flipped.className).toContain("bg-warning/10");
    expect(flipped.className).toContain("text-warning");
  });

  it("resume renders the backend's actual posture for the NEW sid (ADR-0080 reset)", async () => {
    // The backend resets the posture on a successful resume (open_duck ->
    // reset_approval); the frontend contract is that the resumed session's
    // chip re-reads it for the NEW sid and renders the landed value -- NOT a
    // hardcoded default. Pin a non-default read (no_confirmation) so a
    // regression that ignores the backend would fail (the beforeEach default
    // is per_call, which a hardcoded-default Select would also render).
    vi.mocked(listSessions).mockResolvedValue([
      {
        duck_path: "/x/persisted.duck",
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: "people", source_count: 1, turn_count: 1 },
        format_version: 1,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-resume", duck_path: "/sessions/sess-resume/session.duck" });
    vi.mocked(openDuck).mockResolvedValue(undefined);
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));

    await waitFor(() =>
      expect(getAuthorizationMode).toHaveBeenCalledWith("sess-resume"),
    );
    // The Select renders the backend's actual answer for the NEW sid, not a
    // hardcoded per_call default.
    expect(
      await screen.findByRole("combobox", { name: "授权模式：完全访问权限" }),
    ).toBeInTheDocument();
  });

  it("close drops the auth-mode cache slice with the session prefix (ADR-0080, issue #352)", async () => {
    // The auth-mode cache lives under ["session", sid, "authMode"]; a close's
    // removeQueries(["session", sid]) must drop it so a stale no_confirmation
    // never silently re-arms on a reopened session. The contract holds by
    // prefix-sharing today; this spy pins it so a future key-shape drift
    // (authMode escaping the ["session", sid, ...] prefix) would fail.
    const removeSpy = vi.spyOn(QueryClient.prototype, "removeQueries");
    render(<App />);
    await openSession();
    // The Select populated the authMode cache for sess-1.
    await screen.findByRole("combobox", { name: "授权模式：请求批准" });
    removeSpy.mockClear(); // isolate close's own removeQueries call
    // Open the context menu on the one open entry, then Close.
    fireEvent.click(document.querySelector(".session-entry-menu") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "关闭" }));
    // ADR-0080 / ADR-0055: close called removeQueries with the session prefix,
    // which drops authMode with the rest of the slice.
    await waitFor(() =>
      expect(removeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["session", "sess-1"] }),
      ),
    );
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

  it("with configured MCP servers the trigger chips render and open popovers", async () => {
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      mcp_servers: { servers: [mcpServer("srv")] },
    });
    // Issue #369: mock one server so the MCP section has content.
    vi.mocked(listMcpServerStatus).mockResolvedValue([mcpStatus("srv", false)]);
    render(<App />);
    await openSession();

    // Skills + MCP trigger chips render above the QuestionBar.
    expect(await screen.findByRole("button", { name: /技能/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /MCP/ })).toBeInTheDocument();

    // Click MCP chip -> popover opens with the server list.
    fireEvent.click(screen.getByRole("button", { name: /MCP/ }));
    expect(await screen.findByText("srv")).toBeInTheDocument();
  });

  it("shows the enabled MCP count on the MCP trigger chip", async () => {
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      mcp_servers: { servers: [mcpServer("srv"), mcpServer("srv2")] },
    });
    vi.mocked(listMcpServerStatus).mockResolvedValue([
      mcpStatus("srv", true),
      mcpStatus("srv2", false),
    ]);
    render(<App />);
    await openSession();

    // One of the two configured servers is enabled -> chip shows (1/2).
    expect(
      await screen.findByRole("button", { name: /MCP \(1\/2\)/ }),
    ).toBeInTheDocument();
  });

  it("hosts the provider/model picker inside the question-bar once app-config resolves", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    render(<App />);
    await openSession();
    // The picker trigger (ADR-0071 + issue #353) lands inside the question-bar
    // toolbar -- not as a loose sibling. Its accessible name carries the active
    // runtime (built-in -> the active provider's preset name).
    const trigger = await screen.findByRole("button", { name: "运行时：Anthropic" });
    const bar = document.querySelector(".question-bar") as HTMLElement;
    expect(bar.contains(trigger)).toBe(true);
  });

  it("does not render the provider/model picker while app-config is pending", async () => {
    // beforeEach holds getAppConfig pending so appConfig stays at its
    // useState(null) initial -- App does not pass the picker bundle, so the
    // picker trigger is absent until app-config resolves.
    render(<App />);
    await openSession();
    expect(screen.queryByRole("button", { name: /运行时/ })).not.toBeInTheDocument();
  });
});
