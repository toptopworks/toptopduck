import { vi, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry, TurnOutcome } from "../types/thread";
import { askQuestion, conversation, readRows } from "../api";
import { recordedTurn } from "../session/__tests__/fixtures";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { materializedTurn, openSession, ROW_PAGE, src, buildDropWindowMock } from "./setup/shellFixtures";
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
  // Dynamic import: the factory runs lazily, and a static import of the
  // harness would re-enter this factory while the harness module is still
  // initializing (the harness never statically depends on the api).
  const { buildShellApiMocks } = await import("./setup/shellFixtures");
  return {
    ...actual,
    ...buildShellApiMocks({ state, turnProgressCb, resumeProgressCb }),
  };
});

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

  it("renders the three-column grid + thin top bar (R1: session bar / rail / right sidebar)", async () => {
    render(<App />);
    await openSession();
    // Three columns + topbar + questionbar all render.
    expect(document.querySelector(".session-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".session-rail")).toBeInTheDocument();
    expect(document.querySelector(".session-right-sidebar")).toBeInTheDocument();
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
    const outcome = {
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
        viz: null,
        body: null,
        assumption: null,
      },
    } satisfies TurnOutcome;
    vi.mocked(askQuestion).mockResolvedValue(outcome);
    state.thread = [recordedTurn("总共几行", outcome)];
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "总共几行" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The right-sidebar ResultView heading appears (chart+table pane).
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /总共几行/ })).toBeInTheDocument(),
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
      expect(screen.getByRole("heading", { name: /q:result_2/ })).toBeInTheDocument(),
    );
    // Baseline: openSession's creation turn already fired one (rejected) ask.
    const asksBeforeClick = vi.mocked(askQuestion).mock.calls.length;
    // Click result_1 in the rail (the Thread result-link button).
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    // viewedResult moved to result_1; the right sidebar now shows result_1.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_1/ })).toBeInTheDocument(),
    );
    // No NEW ask / mutation IPC fired by the click -- active is untouched.
    expect(vi.mocked(askQuestion).mock.calls.length).toBe(asksBeforeClick);
  });

  it("appends optimistically, then the turn-end refresh converges onto the recorded row (ADR-0051, #1088)", async () => {
    // The thread cache is the single truth: on a successful ask the new turn
    // is appended via setQueryData first (the rail shows it immediately),
    // then the turn-end refresh refetches the thread ONCE -- the recorded row
    // carries settle-computed fields the append cannot know (ADR-0124's
    // artifact manifest), and record_turn commits before the ask resolves,
    // so the refetch lands a richer row, never a wipe.
    state.workingSet = [src("people")];
    const outcome = {
      kind: "Materialized",
      data: {
        promotions: [{ dataset: { ...src("result_1"), row_count: 1 }, sql: "SELECT 1" }],
        viz: null,
        body: null,
        assumption: null,
      },
    } satisfies TurnOutcome;
    vi.mocked(askQuestion).mockResolvedValue(outcome);
    // The recorded row the backend would have committed (mock parity).
    state.thread = [recordedTurn("总共几行", outcome)];
    render(<App />);
    await openSession();
    // The thread query (useSessionState) fires conversation() in a post-open
    // effect; wait for it to fire before asserting the count, so a slow CI
    // runner that mounts the textbox before scheduling the effect does not
    // read 0 calls.
    await waitFor(() => expect(conversation).toHaveBeenCalled());
    expect(conversation).toHaveBeenCalledTimes(1); // the initial load
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "总共几行" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The new turn's question lands in the rail from the optimistic append.
    // Scope to the rail: the textarea's value also renders as text content
    // (unlike the former <Input>), so a global getByText would match both.
    await waitFor(() =>
      expect(within(document.querySelector(".session-rail")!).getByText("总共几行")).toBeInTheDocument(),
    );
    // The turn-end refresh: exactly one refetch, and it converges the append
    // onto the recorded row -- the question stays on the rail after it.
    await waitFor(() => expect(conversation).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(document.querySelector(".session-rail")!).getByText("总共几行")).toBeInTheDocument(),
    );
  });

  it("keeps the right sidebar inert to a textual last turn; a rail click moves viewedResult (ADR-0114)", async () => {
    // End-to-end chain: R5 resume lands viewedResult on the LAST Materialized
    // (result_2). The last turn is a Clarify -- the rail is its read surface,
    // and the right sidebar reacts not at all (still showing result_2, the exact
    // "keep showing what was being viewed" AC). Clicking an EARLIER
    // Materialized result in the rail moves ONLY viewedResult (no pin flag)
    // -> the right sidebar shows result_1's table. This is the full
    // handleSelectResult -> deriveRightSidebarContent path the pure-function
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
    // The rail renders the Clarify turn; the right sidebar still shows result_2
    // (resume landing) -- the textual last turn changed nothing.
    await waitFor(() => expect(document.querySelector(".turn-outcome.textual")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /q:result_2/ })).toBeInTheDocument();
    // Click result_1 in the rail -> only viewedResult moves -> right sidebar shows result_1's table.
    fireEvent.click(screen.getByRole("button", { name: /结果：result_1/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /q:result_1/ })).toBeInTheDocument(),
    );
  });

  it("renders a failed turn's typed failure via the locale catalog (issue #125)", async () => {
    // The rail's Failed card renders the failure by TurnFailure kind through
    // the locale catalog (no backend Display string crosses IPC); the engine
    // detail rides the collapsed TechnicalDetailsFold. ADR-0114: the
    // the right sidebar is inert to turn outcomes -- the rail is the read surface,
    // so the right sidebar stays on the hero.
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
    expect(within(card).getByText("执行失败")).toBeInTheDocument(); // error.turn.execution
    expect(within(card).getByText("no_such_col")).toBeInTheDocument(); // fold detail
    // The right sidebar shows no outcome card for the failed turn.
    expect(document.querySelector(".right-sidebar-hero")).toBeInTheDocument();
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
