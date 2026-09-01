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
  handler: null as
  | null
  | ((e: { payload: { type: string; paths: string[]; position?: { x: number; y: number } } }) => void),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: (
      cb: (e: { payload: { type: string; paths: string[]; position?: { x: number; y: number } } }) => void,
    ) => {
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
import { stubRenderedComposerBar } from "./setup/barRectStub";

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
    // the shell-level bar: the composer picker's badge + the ADR-0092
    // submit-time honest gate (useProfileKeys). Default: the "default" profile
    // (baseAppConfig's active profile) HAS a key, so tests that resolve
    // app-config pass the gate and the centered bar's submit creates a
    // session. The gate tests override this to has_key:false.
    listProviderProfiles: vi.fn(async () => [
      { profile_id: "default", has_key: true, keychain_fault: null },
    ]),
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
    // ADR-0112 picker pre-activation: the activated read feeds the picker's
    // Active badges + the section's badge; activateSkill is the
    // submit-time materialization write. Defaults keep both quiet.
    listActivatedSkills: vi.fn(async () => [] as const),
    activateSkill: vi.fn(async () => {}),
  };
});

import App from "../App";
import { open } from "@tauri-apps/plugin-dialog";
import {
  activateSkill,
  activeDataset,
  askQuestion,
  cancelQuery,
  closeSession,
  conversation,
  createSession,
  getAppConfig,
  getAuthorizationMode,
  getSessionRuntime,
  ingestFile,
  listAdapters,
  listActivatedSkills,
  listMountedSkills,
  listProviderProfiles,
  listSessions,
  listSkills,
  listWorkingSet,
  mountSkill,
  openDuck,
  readRows,
  rescanAdapters,
  setAppConfig,
  setAuthorizationMode,
  setSessionRuntime,
} from "../api";
import type { AppConfig } from "../types/app-config";
import type { McpServerConfig } from "../types/mcp";
import type { SkillEntry } from "../types/skills";

// ADR-0092: the sidebar "+" navigates to the centered empty state (no longer
// creates a session); a session is created by submitting from the shell-level
// bar. This helper clicks "+" (cold start), types + submits on the centered
// bar. Can be called multiple times: each call navigates to the empty state
// first, then creates.
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

  it("keeps the workspace inert to a textual last turn; a rail click moves viewedResult (ADR-0114)", async () => {
    // End-to-end chain: R5 resume lands viewedResult on the LAST Materialized
    // (result_2). The last turn is a Clarify -- the rail is its read surface,
    // and the workspace reacts not at all (still showing result_2, the exact
    // "keep showing what was being viewed" AC). Clicking an EARLIER
    // Materialized result in the rail moves ONLY viewedResult (no pin flag)
    // -> the workspace shows result_1's table. This is the full
    // handleSelectResult -> deriveWorkspaceContent path the pure-function
    // unit test alone cannot cover.
    const r1 = src("result_1");
    const r2 = src("result_2");
    state.workingSet = [r1, r2];
    state.thread = [
      materializedTurn("result_1"),
      materializedTurn("result_2"),
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
    // The rail renders the Clarify turn; the workspace still shows result_2
    // (resume landing) -- the textual last turn changed nothing.
    await waitFor(() => expect(document.querySelector(".turn-outcome.textual")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /结果：result_2/ })).toBeInTheDocument();
    // Click result_1 in the rail -> only viewedResult moves -> workspace shows result_1's table.
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /结果：result_1/ })).toBeInTheDocument(),
    );
  });

  it("renders a failed turn's typed failure via the locale catalog (issue #125)", async () => {
    // The rail's Failed card renders the failure by TurnFailure kind through
    // the locale catalog (no backend Display string crosses IPC); the engine
    // detail rides the collapsed TechnicalDetailsFold. ADR-0114: the
    // workspace is inert to turn outcomes -- the rail is the read surface,
    // so the workspace stays on the hero.
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
    // The rail renders the Failed outcome card. Scope the message assertions
    // to the card.
    await waitFor(() =>
      expect(document.querySelector(".turn-outcome.failed")).toBeInTheDocument(),
    );
    const card = document.querySelector(".turn-outcome.failed") as HTMLElement;
    expect(within(card).getByText("执行查询失败")).toBeInTheDocument(); // error.turn.execute
    expect(within(card).getByText("no_such_col")).toBeInTheDocument(); // fold detail
    // The workspace shows no outcome card for the failed turn.
    expect(document.querySelector(".workspace-hero")).toBeInTheDocument();
  });

  it("elevates working-set panels with shadow-sm (issue #222)", async () => {
    // ADR-0067 (2) + issue #222: in-content cards share one elevation language
    // with the floating dialog (shadow-lg) / popover (shadow-md) layer above
    // them. The working-set master/detail panels carry the Tailwind shadow-sm
    // utility -- no new --shadow-* token (ADR-0067 (2) rules one out). The
    // rail turn-card (ADR-0047) stays flat (rail density should not lift) and
    // the degrade-card stays shadow-none (its left border is the emphasis),
    // so neither is pinned here. jsdom cannot paint a box-shadow, but it CAN
    // assert the className, so a regression that drops shadow-sm while
    // leaving the bg-card/border chrome stays caught (same pin shape as the
    // SessionSidebar session-menu shadow-md tests).
    state.workingSet = [src("result_1")];
    render(<App />);
    await openSession();
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

  it("cold-start submit without a key opens Settings instead of creating (ADR-0092 D4 honest gate)", async () => {
    // The centered bar stays typeable (never disabled); a built-in submit
    // while the active profile has no key redirects to the Settings overlay
    // instead of minting a session whose first turn would fail on the missing
    // key (ADR-0019 honest guidance, the retired ColdStartHero's successor).
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: false, keychain_fault: null },
    ]);
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      // Let app-config + the key overlay settle into the gate state before
      // submitting (both consumers fetch listProviderProfiles).
      await waitFor(() => expect(listProviderProfiles).toHaveBeenCalled());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      // The settings overlay opens; no session is created and the centered bar
      // persists (the submit navigated to settings, not out of cold start).
      await waitFor(() =>
        expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
      );
      expect(createSession).not.toHaveBeenCalled();
      expect(screen.getByText(/你想分析什么/)).toBeInTheDocument();
    } finally {
      // The beforeEach only clearAllMocks (call history), so mock IMPLEMENTATIONS
      // leak into later tests. Restore the factory defaults — a lingering
      // has_key:false overlay would gate every later cold-start bar submit.
      // (null is an App-level state, not an IPC return — cast per the real
      // getAppConfig signature.)
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listProviderProfiles).mockResolvedValue([
        { profile_id: "default", has_key: true, keychain_fault: null },
      ]);
    }
  });

  it("cold-start submit with zero profiles opens Settings on the API Access tab instead of creating (ADR-0098 D4, issue #570)", async () => {
    // ADR-0098 Decision 1 made zero profiles representable, activating the
    // honest gate's "no profile -> Settings" branch (ADR-0092 D4): a built-in
    // submit with an empty profile set redirects to the Runtime section's
    // API Access sub-tab instead of minting a session whose first turn would
    // fail unconfigured. useProfileKeys skips the key fetch on an empty set,
    // so the gate resolves without a key-overlay round-trip.
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      provider: { profiles: [], active_profile: null },
    });
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      // The settings overlay opens on the runtime section's API Access
      // sub-tab; no session is created and the centered bar persists.
      await waitFor(() =>
        expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
      );
      expect(createSession).not.toHaveBeenCalled();
      expect(screen.getByRole("tab", { name: "API 接入配置" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByText(/你想分析什么/)).toBeInTheDocument();
    } finally {
      // The beforeEach only clearAllMocks (call history), so the mock
      // IMPLEMENTATION must be restored (null is an App-level state, not an
      // IPC return -- cast per the real getAppConfig signature).
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
    }
  });

  it("cold-start submit with external runtime creates session + applies external via setSessionRuntime (#499 AC3)", async () => {
    // The cold-start bar's runtime picker writes to pendingRuntime (no IPC).
    // On submit, the handler bypasses the built-in key gate (external pick)
    // and mints a session; mintAndRegister then applies the posture via
    // setSessionRuntime. This verifies the full external cold-start path.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/local/bin/gemini", stream_format: "acp" },
    ]);
    // The creation turn rejects so it settles immediately (openSession pattern).
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard the creation turn"),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      // Wait for app-config to resolve so the picker trigger renders.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /运行时/ })).toBeInTheDocument(),
      );
      // Open the picker popover and select the external adapter from the
      // level-2 CLI select.
      fireEvent.click(screen.getByRole("button", { name: /运行时/ }));
      const cliTrigger = await screen.findByRole("combobox", { name: "本机 CLI" });
      fireEvent.pointerDown(cliTrigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(cliTrigger);
      const cliOption = await screen.findByRole("option", { name: "gemini-cli" });
      fireEvent.pointerUp(cliOption, { button: 0, pointerType: "mouse" });
      fireEvent.click(cliOption);
      // Type and submit from the centered bar.
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      // createSession fires and setSessionRuntime applies the external choice.
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
          kind: "external",
          data: "gemini-cli",
        }),
      );
    } finally {
      // Restore factory defaults so later tests see pending app-config.
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("cold-start picker opens on a detected default runtime; first submit mints on it without a frontend runtime write (issue #572)", async () => {
    // default_runtime = external(detected): the cold-start picker starts with
    // that CLI selected, and an unmodified first submit mints on it WITHOUT a
    // frontend setSessionRuntime -- the backend's create_session resolution
    // is the startup truth (ADR-0098 Decisions 2/3); the write only applies
    // an explicit user pick.
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      default_runtime: { kind: "external", data: "gemini-cli" },
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/local/bin/gemini", stream_format: "acp" },
    ]);
    // The creation turn rejects so it settles immediately (openSession pattern).
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard the creation turn"),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      // The trigger names the resolved default's adapter from the start --
      // no picker interaction needed.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      // Submit straight away: the external default bypasses the built-in key
      // gate and mints a session.
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      // Unmodified pending posture: no redundant runtime write.
      expect(setSessionRuntime).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("an unmodified submit on a detected external default bypasses the key gate even with a keyless profile (issue #572)", async () => {
    // The gate's keyless redirect fires only on the built-in KIND, and with
    // an external default_runtime the UNMODIFIED posture is already external:
    // has_key:false must not open Settings — the backend resolves the startup
    // runtime itself, so the submit mints with no runtime write. This is the
    // cell the factory's has_key:true default leaves unpinned: the gate is
    // under real tension here and only here.
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      default_runtime: { kind: "external", data: "gemini-cli" },
    });
    // No key — the gate would fire if the effective runtime were built-in.
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: false, keychain_fault: null },
    ]);
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/local/bin/gemini", stream_format: "acp" },
    ]);
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard the creation turn"),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      // The trigger opens on the resolved external default...
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      // ...and the keyless overlay settles BEFORE the submit, so the gate
      // state is real when the submit fires (useProfileKeys fetches it too).
      await waitFor(() => expect(listProviderProfiles).toHaveBeenCalled());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      // Submit straight away: the external effective runtime keeps the gate
      // shut — no Settings redirect, the session mints with no runtime write.
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      // The queued one-time rejection must be consumed before the test ends:
      // the once queue survives clearAllMocks, and a leaked reject would
      // settle the NEXT test's first turn mid-flight (#501 leak shape). The
      // ask call itself is the dequeue point, so wait for it directly — a
      // "submit button back" wait can pass before the turn even starts.
      await waitFor(() =>
        expect(vi.mocked(askQuestion).mock.calls.length).toBe(1),
      );
      expect(document.querySelector(".settings-overlay")).not.toBeInTheDocument();
      expect(setSessionRuntime).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listProviderProfiles).mockResolvedValue([
        { profile_id: "default", has_key: true, keychain_fault: null },
      ]);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("an explicit built-in pick on an external default overwrites the startup resolution (issue #572)", async () => {
    // The unset/explicit distinction survives the mint: with default_runtime
    // = external(detected), picking Built-in on the cold-start picker and
    // submitting applies the built-in choice via setSessionRuntime (the
    // session would otherwise run the external default the backend resolved).
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      default_runtime: { kind: "external", data: "gemini-cli" },
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/local/bin/gemini", stream_format: "acp" },
    ]);
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard the creation turn"),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      // The trigger opens on the resolved external default...
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      // ...then the user explicitly reverts to built-in.
      fireEvent.click(screen.getByRole("button", { name: "运行时：gemini-cli" }));
      const builtinHeader = await screen.findByRole("button", { name: "API 接入配置" });
      fireEvent.click(builtinHeader);
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      // The explicit pick lands -- the startup resolution does not swallow it.
      await waitFor(() =>
        expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
          kind: "built_in",
        }),
      );
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("the consumed posture resets: a revisit to the cold-start bar re-seeds from the resolved default (issue #572)", async () => {
    // ADR-0092 D4 / ADR-0098 D4: minting consumes the pending posture, so the
    // explicit built-in pick from the previous visit must NOT survive — back
    // on the cold-start bar the trigger re-reads the resolved external
    // default, and an unmodified second submit writes no runtime (a stale
    // pick would otherwise display, silently write built_in, and re-arm the
    // key gate).
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      default_runtime: { kind: "external", data: "gemini-cli" },
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/local/bin/gemini", stream_format: "acp" },
    ]);
    // The creation turn rejects so it settles immediately (openSession
    // pattern). Only visit 1's mint needs one: visit 2 mints the SAME session
    // id (the mock always returns sess-1), so the keep-alive pane is reused
    // and no second creation turn ever fires.
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard the creation turn"),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      // Visit 1: explicitly pick built-in against the external default and
      // mint — the pick lands as one setSessionRuntime write.
      fireEvent.click(screen.getByRole("button", { name: "运行时：gemini-cli" }));
      const builtinHeader = await screen.findByRole("button", { name: "API 接入配置" });
      fireEvent.click(builtinHeader);
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "first question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
          kind: "built_in",
        }),
      );
      // Let the mint settle: the posture reset lands in the mint's .then,
      // before the bar returns to idle.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
      );
      // Navigate back to the centered cold-start bar (sidebar "+").
      fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
      await waitFor(() => expect(screen.getByText(/你想分析什么/)).toBeInTheDocument());
      // The trigger re-seeds from the resolved default — the consumed
      // built-in pick is gone.
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      expect(
        screen.queryByRole("button", { name: "运行时：Anthropic" }),
      ).not.toBeInTheDocument();
      // Visit 2: an unmodified submit mints again WITHOUT a runtime write —
      // setSessionRuntime stays at the single visit-1 call.
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "second question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
      // Visit 2's runtime write decision happens inside its mint (before the
      // register), so let the mint's promise chain flush before pinning the
      // count — setSessionRuntime stays at the single visit-1 call.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(setSessionRuntime).toHaveBeenCalledTimes(1);
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("cold-start picker degrades to built-in when the default names an undetected CLI (issue #572)", async () => {
    // default_runtime = external but the CLI is not detected: the resolution
    // degrades per-start (ADR-0098 Decision 3), so the cold-start trigger
    // shows the built-in readout (the active profile), not the missing CLI.
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      default_runtime: { kind: "external", data: "gemini-cli" },
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "gemini-cli", display_name: "gemini-cli", detected: false, binary_path: null, stream_format: "acp" },
    ]);
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "运行时：Anthropic" }),
        ).toBeInTheDocument(),
      );
      // The degraded external default is NOT the trigger readout.
      expect(
        screen.queryByRole("button", { name: "运行时：gemini-cli" }),
      ).not.toBeInTheDocument();
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("cold-start bar renders the full composer control row — no degraded controls (ADR-0092 D6, #500)", async () => {
    // The centered bar carries the same control row as the session bar:
    // the Skills trigger chip, the "+" file button, the auth-mode chip,
    // and the runtime picker. None of them disappear or degrade on cold
    // start, and none of them mints a session by rendering. (The MCP trigger
    // chip is retired, ADR-0106 -- its assertion flipped to absence.)
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      const bar = document.querySelector(".question-bar") as HTMLElement;
      expect(bar).not.toBeNull();
      // Skills trigger chip (draft mode: empty mount set); no MCP chip.
      const skills = await screen.findByRole("button", { name: /技能 \(0\/0\)/ });
      expect(bar.contains(skills)).toBe(true);
      expect(
        screen.queryByRole("button", { name: /MCP/ }),
      ).not.toBeInTheDocument();
      // The "+" file button + the auth-mode chip.
      expect(bar.contains(screen.getByRole("button", { name: "添加文件" }))).toBe(true);
      expect(
        bar.contains(await screen.findByRole("combobox", { name: /授权模式/ })),
      ).toBe(true);
      // The runtime picker trailing slot.
      expect(
        bar.contains(await screen.findByRole("button", { name: /运行时/ })),
      ).toBe(true);
      // Draft mode fires NO per-session IPC.
      expect(getAuthorizationMode).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
    }
  });

  it("cold-start draft selections all apply to the minted session on first submit (#500)", async () => {
    // The draft-mode contract: a skill pick, a queued file, and an auth-mode
    // switch made on the centered bar (no session) all land on the session
    // the first submit mints — skill mount + auth-mode write via
    // mintAndRegister, the file through the ingest pipeline BEFORE the first
    // turn fires. (The MCP draft pick retired with the per-session mount
    // chain, ADR-0106; config enablement replaced it.)
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      cli_tools: { tools: [] },
      mcp_servers: { servers: [mcpServer("srv")] },
    });
    vi.mocked(listSkills).mockResolvedValue({
      skills: [skillEntry("charting")],
      ignored: [],
      root_error: null,
    });
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("people") });
    // The creation turn rejects so it settles immediately (openSession pattern).
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard the creation turn"),
    );
    vi.mocked(open).mockResolvedValue(["/x/a.csv"]);
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());

      // Skills draft: pick charting in the popover (draft toggle, no IPC).
      fireEvent.click(await screen.findByRole("button", { name: /技能/ }));
      fireEvent.click(
        await screen.findByRole("checkbox", { name: "挂载技能 charting" }),
      );
      expect(mountSkill).not.toHaveBeenCalled();

      // Files draft: the "+" pick queues into the pending list — the chip
      // shows the queue; nothing ingests yet.
      fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
      await waitFor(() =>
        expect(screen.getByLabelText(/1 个文件已排队/)).toBeInTheDocument(),
      );
      expect(ingestFile).not.toHaveBeenCalled();

      // Auth-mode draft: switch to no-confirmation (no IPC yet).
      const authTrigger = screen.getByRole("combobox", { name: "授权模式：请求批准" });
      fireEvent.pointerDown(authTrigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(authTrigger);
      const option = await screen.findByRole("option", { name: /完全访问权限/ });
      fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
      fireEvent.click(option);
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "授权模式：完全访问权限" }),
        ).toBeInTheDocument(),
      );
      expect(setAuthorizationMode).not.toHaveBeenCalled();

      // First submit mints the session and applies everything.
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "q" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(mountSkill).toHaveBeenCalledWith("sess-1", "charting"));
      await waitFor(() =>
        expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation"),
      );
      await waitFor(() => expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/a.csv"));
      await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "q"));
      // The file landed BEFORE the first turn fired.
      expect(vi.mocked(ingestFile).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(askQuestion).mock.invocationCallOrder[0],
      );
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listSkills).mockResolvedValue({ skills: [], ignored: [], root_error: null });
    }
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

  // ADR-0093 (issue #511): close + rename via sidebar context menu tests
  // retired — management moved to .session-header (slice 2, #512).

  // ADR-0061 drop-to-create (#81 A1), carrier moved to the ADR-0092 empty
  // state (#501): a file dropped on the empty-state main area around the
  // centered bar mints a session and the new SessionPane ingests the path via
  // handleIngestMany (the only path that can surface an xlsx NeedsGuidance
  // result). Asserts the createSession + ingestFile wiring at the shell
  // boundary.
  it("drop on the cold-start empty area mints a session and ingests the file (ADR-0061/0092, #81 A1, #501)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-drop", duck_path: "/sessions/sess-drop/session.duck" });
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("dropped") });
    render(<App />);
    // Cold start: the centered bar + greeting are showing, no session yet.
    await waitFor(() => expect(dropEvent.handler).not.toBeNull());
    // Simulate a webview drop of one data file in the window's top-left
    // corner -- the empty-state area, clear of the centered bar.
    dropEvent.handler!({ payload: { type: "drop", paths: ["/x/foo.csv"], position: { x: 5, y: 5 } } });
    await waitFor(() => expect(createSession).toHaveBeenCalled());
    // The minted session's SessionPane consumes the path via handleIngestMany.
    await waitFor(() => expect(ingestFile).toHaveBeenCalledWith("sess-drop", "/x/foo.csv"));
  });

  // ADR-0092 Decision 2 (#501): the centered composer bar itself is inert to
  // drops. The webview drop router hit-tests the drop position against the
  // bar's rect; a drop ON the bar must not mint a session (accidental-drop
  // guard), and the shell stays on the centered empty state.
  it("drop ON the centered composer bar is inert on cold start (ADR-0092 Decision 2, #501)", async () => {
    // No createSession return is staged on purpose: the contract is that the
    // IPC is never called. A queued mockResolvedValueOnce a test never
    // consumes survives clearAllMocks and would leak into a later test.
    render(<App />);
    await waitFor(() => expect(dropEvent.handler).not.toBeNull());
    // jsdom has no layout; pin the rendered bar's geometry so the router's
    // hit test reads a real rect (shared barRectStub).
    stubRenderedComposerBar({ left: 100, top: 200, right: 820, bottom: 400 });
    // Drop in the middle of the bar.
    dropEvent.handler!({ payload: { type: "drop", paths: ["/x/foo.csv"], position: { x: 400, y: 300 } } });
    // The guard runs synchronously ahead of dropFile; flush a microtask tick
    // anyway so an accidental async path would land before the negative
    // assertion.
    await act(async () => {});
    expect(createSession).not.toHaveBeenCalled();
    // Still on the centered empty state (no mint -> activeSessionId null).
    expect(document.querySelector(".shell")?.classList.contains("cold-start-mode")).toBe(true);
    expect(document.querySelector(".shell-bar-slot")?.classList.contains("centered")).toBe(true);
  });

  // #501 AC: the drop-minted session appears in the sidebar list, and the bar
  // slot glides centered -> bottom once activeSessionId flips.
  it("a drop-minted session appears in the sidebar + the bar moves to the bottom (#501)", async () => {
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-drop", duck_path: "/sessions/sess-drop/session.duck" });
    vi.mocked(ingestFile).mockResolvedValue({ kind: "Loaded", data: src("dropped") });
    render(<App />);
    await waitFor(() => expect(dropEvent.handler).not.toBeNull());
    expect(document.querySelector(".session-list [aria-current='true']")).toBeNull();
    // Drop in the empty-state area (top-left corner, clear of the bar).
    dropEvent.handler!({ payload: { type: "drop", paths: ["/x/foo.csv"], position: { x: 5, y: 5 } } });
    // The minted session joins the sidebar as the ACTIVE entry at once
    // (sidebarModel renders open sessions absent from the persisted scan).
    await waitFor(() => {
      expect(document.querySelector(".session-list [aria-current='true']")).not.toBeNull();
    });
    // ...and the bar slot left the centered posture.
    await waitFor(() => {
      expect(document.querySelector(".shell-bar-slot")?.classList.contains("bottom")).toBe(true);
    });
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

// A malformed turn (unknown outcome kind) for the ADR-0058 boundary tests:
// hardened with trace/provenance so the render crash reaches the exhaustive
// outcome switch, not the earlier provenance-badge / trace reads that would
// otherwise throw first.
function bogusTurn(question = "x"): ThreadEntry {
  return {
    entry: "Turn",
    data: { question, outcome: { kind: "Bogus" }, trace: [], provenance: { skills: [] } },
  } as unknown as ThreadEntry;
}

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
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } } },
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
      { entry: "Turn", data: { question: "你好", outcome: { kind: "Cancelled" }, trace: [], provenance: { skills: [] } } },
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
      .mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" })
      .mockResolvedValueOnce({ session_id: "sess-2", duck_path: "/sessions/sess-2/session.duck" });
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

    // Layout regression guard: the strip must render as an absolutely-
    // positioned overlay INSIDE .main-area, NOT as an in-flow child of the
    // .shell grid. An in-flow grid row shifted the whole main area down on
    // mount and back up on unmount, so the visible session header bounced on
    // every open/resume (the title position flicker). Pin the overlay parent
    // so a revert to the grid-flow placement fails here.
    expect(resumeAlert.parentElement?.classList.contains("main-area")).toBe(true);
    expect(resumeAlert.parentElement?.classList.contains("shell")).toBe(false);
    // The status text must ride a col-start-2 slot (AlertTitle): the Alert
    // base grid reserves col 1 (width 0) for an icon, and a bare text child
    // wraps one character per line there, turning the strip into a tall box.
    expect(
      resumeAlert.querySelector("[data-slot=alert-title]")?.textContent,
    ).toMatch(/校验源/);

    // Cleanup: let openDuck resolve and AWAIT openPersisted finishing (invalidate
    // + registerOpen + setResumeStatus(null) + finally unlisten) so no orphan
    // resume-progress listener leaks into the next test.
    resolveOpenDuck();
    await waitFor(() =>
      expect(screen.queryByText(/正在打开/)).not.toBeInTheDocument(),
    );
  });

  // ADR-0093 (issue #511): close-in-flight + close-reject tests retired —
  // the sidebar context menu trigger moved to .session-header (slice 2, #512).
});

// ADR-0093 (issue #511): the "App delete wait-release variant" describe block
// (3 tests, all triggered via .session-entry-menu) is retired — management
// moved to .session-header (slice 2, #512).

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
    engine: { memory_limit: "512MB", threads: 1, row_cap: 100 },
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
    cli_tools: { tools: [] },
    mcp_servers: { servers: [] },
    sessions_dir: null,
    default_runtime: { kind: "built_in" },
    builtin_skill_baselines: {},
    last_model_postures: {},
  };
}

// A minimal registry skill (#500 cold-start Skills draft tests) -- every
// required wire field present, only the name varies.
function skillEntry(name: string): SkillEntry {
  return {
    name,
    description: `${name} skill`,
    acquired: "local",
    license: null,
    compatibility: null,
    mcp_servers: [],
    cli_tools: [],
    body: "",
    link_target: null,
    content_hash: "ab".repeat(32),
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
    enabled: true,
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
    // Simulate a webview drop while sess-1 is active. The position rides the
    // payload as Tauri always sends it (#501); the active-session route
    // ignores it (the bar-inert guard is cold-start only).
    dropEvent.handler!({ payload: { type: "drop", paths: ["/x/new.csv"], position: { x: 5, y: 5 } } });
    await waitFor(() =>
      expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/new.csv"),
    );
    // The drop did NOT mint a new session (only the openSession create fired).
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("renders the verbatim question in full inside the user bubble (ADR-0103, #609)", async () => {
    // ADR-0103 retires the ADR-0054 truncation posture: the chat projection
    // wraps the question in full (pre-wrap) inside the right-aligned bubble --
    // no tail-ellipsis span, no hover-recovery Tooltip. jsdom has no layout,
    // so the contract is asserted at the class level: the question carries
    // the pre-wrap utility and no truncate, the full text is the element's
    // own content, and hovering opens no recovery tooltip.
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
    // render before asserting the wrap contract on its question span.
    const q = await waitFor(() => {
      const el = document.querySelector(".turn-question");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const classes = q.className.split(/\s+/);
    expect(classes).toContain("whitespace-pre-wrap");
    expect(classes).not.toContain("truncate");
    expect(q.textContent).toBe(longQuestion);
    // No truncation-recovery tooltip mounts for the question: the old
    // TruncatingTooltip wrapper opened one on hover (jsdom reports 0-width,
    // so the overflow gate always let it through); the bubble posture opens
    // none. A real-timer beat lets a would-be Radix open surface.
    fireEvent.pointerMove(q);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
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
      // ADR-0092: each openSession() clicks "+" (cold start), then types +
      // submits on the centered bar to create a session.
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

  // ADR-0093 (issue #511): "close drops the auth-mode cache slice" test
  // retired — triggered via .session-entry-menu; management moved to
  // .session-header (slice 2, #512).

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

  it("the skills trigger chip renders even with configured MCP servers; no MCP chip (ADR-0106)", async () => {
    // ADR-0106: the composer MCP mount chip is retired (config-level
    // enablement replaced per-session mounting). With servers configured the
    // skills chip still renders above the QuestionBar and opens its popover,
    // but no MCP trigger chip exists anywhere in the bar.
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      cli_tools: { tools: [] },
      mcp_servers: { servers: [mcpServer("srv")] },
    });
    render(<App />);
    await openSession();

    expect(await screen.findByRole("button", { name: /技能/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /MCP/ })).not.toBeInTheDocument();
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

describe("App composer refactor follow-ups (issue #504)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("pending question is consumed and not re-fired on re-render (#504)", async () => {
    // ADR-0092: a cold-start submit creates a session carrying pendingQuestion.
    // SessionPane fires it via handleAsk, then calls onQuestionConsumed so
    // OpenSession.pendingQuestion is cleared. After consumption, any re-render
    // (React reconciliation, keep-alive switch, or error-boundary retry) sees
    // pendingQuestion=null and skips the consumption effect.
    const { rerender } = render(<App />);
    await openSession();
    // The creation turn fired exactly once (the openSession rejection).
    expect(vi.mocked(askQuestion)).toHaveBeenCalledTimes(1);
    // Settle async: onQuestionConsumed fires after the turn starts.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    // Still exactly one call — no spurious re-fire from effect re-runs.
    expect(vi.mocked(askQuestion)).toHaveBeenCalledTimes(1);
    // Force a full re-render of the App tree. If clearPendingQuestion worked,
    // the session's pendingQuestion is null and the consumption effect does
    // not re-fire.
    rerender(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(vi.mocked(askQuestion)).toHaveBeenCalledTimes(1);
  });

  it("honest gate triggers on keychain_fault (not just missing key, ADR-0092 D4 / issue #275, #504)", async () => {
    // The submit-time gate fires not only when has_key is false but also when
    // the keychain read itself faulted (locked / service down). The gate's
    // condition is `!activeHasKey || activeKeychainFault !== null`; a profile
    // with has_key:true + a keychain_fault must still redirect to Settings
    // instead of minting a session whose first turn would fail on the broken
    // keychain read path.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: true, keychain_fault: "OS keychain locked" },
    ]);
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      await waitFor(() => expect(listProviderProfiles).toHaveBeenCalled());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      // The gate fires: settings overlay opens, no session created.
      await waitFor(() =>
        expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
      );
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listProviderProfiles).mockResolvedValue([
        { profile_id: "default", has_key: true, keychain_fault: null },
      ]);
    }
  });

  it("external runtime bypasses the built-in key gate (#499 / #504)", async () => {
    // The gate only fires for the built-in runtime kind. An external runtime
    // pick (ACP adapter) bypasses the key gate entirely: even with has_key
    // false + no keychain fault, the submit mints a session and applies the
    // external choice via setSessionRuntime. This is the black-box contract
    // the gate's `pendingRuntime.kind === "built_in"` condition guards.
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    // No key — the gate would fire for built_in.
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: false, keychain_fault: null },
    ]);
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/local/bin/gemini", stream_format: "acp" },
    ]);
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard the creation turn"),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /运行时/ })).toBeInTheDocument(),
      );
      // Pick the external adapter from the level-2 CLI select.
      fireEvent.click(screen.getByRole("button", { name: /运行时/ }));
      const cliTrigger = await screen.findByRole("combobox", { name: "本机 CLI" });
      fireEvent.pointerDown(cliTrigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(cliTrigger);
      const cliOption = await screen.findByRole("option", { name: "gemini-cli" });
      fireEvent.pointerUp(cliOption, { button: 0, pointerType: "mouse" });
      fireEvent.click(cliOption);
      // Type and submit — the gate is bypassed (external kind).
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "test question" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      // createSession fires despite has_key:false (external runtime bypass).
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
          kind: "external",
          data: "gemini-cli",
        }),
      );
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listProviderProfiles).mockResolvedValue([
        { profile_id: "default", has_key: true, keychain_fault: null },
      ]);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("cold-start greeting is a label for the textarea (no heading skip, #504 a11y)", async () => {
    // The cold-start greeting is a <label htmlFor="question-bar-input">, not an
    // <h2>, so screen-reader heading navigation does not skip from the page
    // root to h2. The textarea's accessible name still comes from aria-label
    // (consistent across cold-start and session modes); the visible <label>
    // adds click-to-focus association.
    render(<App />);
    // No h1 or h2 greeting — the cold-start text is a <label>, not a heading.
    expect(document.querySelector("h1")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /你想分析什么/ })).not.toBeInTheDocument();
    // The greeting renders as a visible <label> associated with the textarea.
    expect(screen.getByLabelText("提问")).toBeInTheDocument();
    expect(screen.getByText(/你想分析什么/)).toBeInTheDocument();
  });
});

describe("Composer skill picker pre-activation (ADR-0112, issue #716)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { language: "zh-CN" });
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      cli_tools: { tools: [] },
    });
    vi.mocked(listSkills).mockResolvedValue({
      skills: [skillEntry("charting")],
      ignored: [],
      root_error: null,
    });
    vi.mocked(listMountedSkills).mockResolvedValue([]);
    vi.mocked(listActivatedSkills).mockResolvedValue([]);
    // Every turn rejects so each ask settles immediately (openSession pattern).
    vi.mocked(askQuestion).mockRejectedValue(new Error("discard turns"));
  });

  it("materializes picker picks at submit: mount → activate → ask, cold start AND in-session", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");

    // Cold start: the trigger char opens the picker; Enter picks charting.
    // The pick lands the chip (activation intent) AND the pending mount pick
    // (composite) -- nothing fires yet (预激活, not activation).
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    // The landed chip renders as an inline token in the input area (its
    // name is the marker; withdrawal rides Backspace at the draft start).
    await screen.findByText("charting");
    expect(mountSkill).not.toHaveBeenCalled();
    expect(activateSkill).not.toHaveBeenCalled();

    // Submit: mount → activate → first question, in that order.
    fireEvent.change(bar, { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "q"));
    expect(mountSkill).toHaveBeenCalledWith("sess-1", "charting");
    expect(activateSkill).toHaveBeenCalledWith("sess-1", "charting");
    expect(vi.mocked(mountSkill).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(activateSkill).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(activateSkill).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(askQuestion).mock.invocationCallOrder[0],
    );

    // In-session: after the first turn settles (the submit button returns
    // from the 停止 face; the draft itself was cleared by the ask), a second
    // picker pick lands a view chip; the next submit materializes it BEFORE
    // the ask fires (the activation lands before the turn assembles).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    // The landed chip renders as an inline token in the input area (its
    // name is the marker; withdrawal rides Backspace at the draft start).
    await screen.findByText("charting");
    fireEvent.change(bar, { target: { value: "q2" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q2"),
    );
    expect(
      vi.mocked(activateSkill).mock.calls.filter(([sid]) => sid === "sess-1"),
    ).toHaveLength(2);
    expect(vi.mocked(activateSkill).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(askQuestion).mock.invocationCallOrder[1],
    );
  });

  it("cold-start pick syncs the mount facet; Backspace withdrawal mirrors it out", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    // The trigger chip counts the cold-start pending mount picks against
    // the one-skill registry: nothing staged yet.
    expect(
      screen.getByRole("button", { name: "技能 (0/1)" }),
    ).toBeInTheDocument();
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    // The composite's mount half synced the checkbox authority: the
    // trigger's pending count rose with the chip.
    expect(
      screen.getByRole("button", { name: "技能 (1/1)" }),
    ).toBeInTheDocument();
    // Backspace at the draft start withdraws the chip AND mirrors the mount
    // half out of pendingSkills -- add and removal stay in sync.
    fireEvent.keyDown(bar, { key: "Backspace" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "技能 (0/1)" }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("charting")).not.toBeInTheDocument();
  });

  it("in-session pick lands a view chip; Backspace withdraws it before submit", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    // Open the session with a first question (the turn rejects and settles).
    fireEvent.change(bar, { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q"),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    // A second picker pick lands the in-session chip (the viewActivations
    // list is the whole intent -- this surface has no mount facet).
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    // Backspace at caret 0 (the draft is empty; the panel is closed)
    // withdraws the session-scope intent...
    fireEvent.keyDown(bar, { key: "Backspace" });
    await waitFor(() =>
      expect(screen.queryByText("charting")).not.toBeInTheDocument(),
    );
    // ...so the next submit fires the ask with NO materialization at all.
    fireEvent.change(bar, { target: { value: "q2" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q2"),
    );
    expect(activateSkill).not.toHaveBeenCalled();
  });

  it("session-scope intents never leak into another session and restore on switch-back (issue #718)", async () => {
    vi.mocked(createSession)
      .mockResolvedValueOnce({ session_id: "sess-1", duck_path: "/sessions/sess-1/session.duck" })
      .mockResolvedValueOnce({ session_id: "sess-2", duck_path: "/sessions/sess-2/session.duck" });
    render(<App />);
    await openSession(); // sess-1
    const bar = screen.getByLabelText("提问");
    // An unsubmitted pick lands sess-1's view chip.
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    // Open sess-2 (the helper navigates to the empty state, then submits):
    // sess-1's unsubmitted intent is invisible in sess-2's input area --
    // the derived read yields [] for a non-matching sid.
    await openSession(); // sess-2
    expect(screen.queryByText("charting")).not.toBeInTheDocument();
    // Switching back to sess-1 restores its unsubmitted intent: the intents
    // are scoped to their session, not destroyed by the switch.
    const entries = document.querySelectorAll(".session-entry-main");
    fireEvent.click(entries[0]);
    await screen.findByText("charting");
  });

  it("duplicate picks dedupe; Backspace withdraws the most recent pick only (LIFO)", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills: [skillEntry("charting"), skillEntry("data-cleaning")],
      ignored: [],
      root_error: null,
    });
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    // Pick charting, then charting AGAIN: the composite is a set -- the
    // duplicate is a no-op (one chip, one pending mount pick).
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getByRole("button", { name: "技能 (1/2)" })).toBeInTheDocument();
    // A different name joins: two chips, two pending picks.
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(bar, { key: "ArrowDown" });
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("data-cleaning");
    expect(screen.getByRole("button", { name: "技能 (2/2)" })).toBeInTheDocument();
    // Backspace withdraws the MOST RECENT pick only (data-cleaning); the
    // charting chip and its mount half stay.
    fireEvent.keyDown(bar, { key: "Backspace" });
    await waitFor(() =>
      expect(screen.queryByText("data-cleaning")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("charting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "技能 (1/2)" })).toBeInTheDocument();
  });
});
