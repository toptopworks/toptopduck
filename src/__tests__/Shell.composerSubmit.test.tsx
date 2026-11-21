import { vi, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MockInstance } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry } from "../types/thread";
import { activeDataset, askQuestion, conversation, createSession, getAppConfig, getAuthorizationMode, getSessionRuntime, listAdapters, listSkills, listWorkingSet, readRows, rescanAdapters, setAuthorizationMode, setSessionRuntime } from "../api";
import { skillEntry } from "../test-fixtures";
import { recordedTurn, textual } from "../session/__tests__/fixtures";
import { log } from "../lib/log";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { baseAppConfig, openSession, ROW_PAGE, src, STAMP_OUTCOME, UNMAPPED_RUNTIME_CHOICE, buildDropWindowMock } from "./setup/shellFixtures";
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
    // Every turn rejects so each ask settles immediately (openSession pattern).
    vi.mocked(askQuestion).mockRejectedValue(new Error("discard turns"));
  });

  it("staged picks ride the ask as the turn's invocations, cold start AND in-session", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");

    // Cold start: the trigger char opens the picker; Enter picks charting.
    // The pick lands the chip -- nothing fires yet (ADR-0119: staging, not
    // invocation).
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    // The landed chip renders as an inline token in the input area (its
    // name is the marker; withdrawal rides Backspace at the draft start).
    await screen.findByText("charting");

    // Submit: the staged name rides the first ask as its user invocation.
    fireEvent.change(bar, { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q", ["charting"]),
    );

    // In-session: after the first turn settles (the submit button returns
    // from the 停止 face; the draft itself was cleared by the ask), a second
    // picker pick lands a view chip; the next submit carries it the same way.
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
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q2", ["charting"]),
    );
  });

  it("submit clears the in-session staging; the next ask carries no stale pick (review I4, #991)", async () => {
    // Mint bare (no cold-start pick), then pick IN SESSION: the view-side
    // staging is the surface the submit boundary must clear -- the cold
    // start's own reset is pinned separately below.
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    fireEvent.change(bar, { target: { value: "mint" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "mint", []),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    // In-session pick: the chip lands on the view's staging.
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    fireEvent.change(bar, { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q", ["charting"]),
    );
    // The settle returns the submit face. NO re-pick: the view's staging was
    // cleared at the submit boundary, so the next ask must carry an empty
    // staging array -- a stale charting silently riding every later turn is
    // exactly the regression this pins (vitest matches call arguments
    // exactly, so a non-empty third argument fails the assertion).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    fireEvent.change(bar, { target: { value: "q2" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "q2", []));
  });

  it("cold-start pick lands a chip; Backspace withdraws it before submit", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    // The landed chip renders as an inline token in the input area; nothing
    // fires before the minting submit.
    await screen.findByText("charting");
    // Backspace at the draft start withdraws the chip -- the staging list is
    // the only surface.
    fireEvent.keyDown(bar, { key: "Backspace" });
    await waitFor(() =>
      expect(screen.queryByText("charting")).not.toBeInTheDocument(),
    );
  });

  it("consumed cold-start intents reset after the mint (no ghost chips on return)", async () => {
    // The mint's .then clears the cold-activation list with the other draft
    // facets: a pick consumed by the first submit must not re-render as a
    // ghost chip when the shell falls back to the cold-start bar (close the
    // only session through the header menu) -- nor re-apply on a later mint.
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    fireEvent.change(bar, { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    // The staged pick rides the ask (ADR-0119 submit-time materialization).
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q", ["charting"]),
    );
    // The turn settles, then the header menu's close drops the only pane --
    // the shell falls back to the cold-start bar.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(await screen.findByText("关闭"));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "会话操作" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("charting")).not.toBeInTheDocument();
  });

  it("a settled in-session submit clears the bar draft (no resurface on the next turn)", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    // Cold-start mint: the question rides the pendingQuestion channel, so
    // the minted session's bar starts empty (the creation turn rejects via
    // the queued one-shot and the session settles idle).
    fireEvent.change(bar, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "first", []));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    // Type the second question IN the session, submit, and the draft clears
    // at the ask instead of resurfacing when the next turn starts.
    vi.mocked(askQuestion).mockRejectedValueOnce(
      new Error("discard turns"),
    );
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "second", []));
    expect(screen.getByLabelText("提问")).toHaveValue("");
  });

  it("a failed cold-start creation keeps the draft (the question must not be lost)", async () => {
    vi.mocked(createSession).mockRejectedValueOnce(new Error("mint failed"));
    render(<App />);
    fireEvent.change(await screen.findByLabelText("提问"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    // The mint failed: the cold-start bar keeps the question for a retry.
    expect(screen.getByLabelText("提问")).toHaveValue("keep me");
  });

  it("a minted cold-start submit clears the cold-start draft (empty bar on the return to cold start)", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    fireEvent.change(bar, { target: { value: "only question" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "only question", []));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    // Close the only session: the shell falls back to the cold-start bar,
    // whose draft must not resurrect the consumed question.
    fireEvent.pointerDown(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(await screen.findByText("关闭"));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "会话操作" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("提问")).toHaveValue("");
  });

  it("in-session pick lands a view chip; Backspace withdraws it before submit", async () => {
    render(<App />);
    const bar = await screen.findByLabelText("提问");
    // Open the session with a first question (the turn rejects and settles).
    fireEvent.change(bar, { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q", []),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeInTheDocument(),
    );
    // A second picker pick lands the in-session chip (the session-scope
    // staging list is the whole intent -- this surface has no mount facet).
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
    // ...so the next submit fires the ask with an empty staging array (the
    // Rust fold treats it the same as an absent field).
    fireEvent.change(bar, { target: { value: "q2" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() => expect(askQuestion).toHaveBeenCalledWith("sess-1", "q2", []));
  });

  it("session-scope intents never leak into another session and restore on switch-back (issue #718)", async () => {
    vi.mocked(createSession)
      .mockResolvedValueOnce({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" })
      .mockResolvedValueOnce({ session_id: "sess-2", recipe_path: "/sessions/sess-2/recipe.json" });
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
    // Pick charting, then charting AGAIN: the intent set dedupes -- the
    // duplicate is a no-op (one chip, one intent).
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(screen.getAllByText("charting")).toHaveLength(1);
    // A different name joins: two chips, two intents.
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(bar, { key: "ArrowDown" });
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("data-cleaning");
    // Backspace withdraws the MOST RECENT pick only (data-cleaning); the
    // charting chip stays.
    fireEvent.keyDown(bar, { key: "Backspace" });
    await waitFor(() =>
      expect(screen.queryByText("data-cleaning")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("charting")).toBeInTheDocument();
  });
});

describe("shell submit fire-path defensive log (#825)", () => {
  // The composer fire path (the shell bar's submit delegating to the active
  // session's handleAsk) is the third turn-fire surface besides SessionPane's
  // pendingQuestion replay and ask-again sinks. handleAsk settles its designed
  // failures internally; an UNEXPECTED throw -- the unmapped runtime stamp
  // (#725's designed loud failure) -- must surface through the fire path's
  // defensive log.error, never as a silent unhandled rejection on
  // the main interaction path (#825).
  let logError: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { language: "zh-CN" });
    logError = vi.spyOn(log, "error");
    // clearAllMocks only clears call history, not implementations set by
    // prior describes -- pin the session-scoped reads the pane + picker ride
    // back to their factory behavior (mirrors the composer control row
    // describe).
    state.thread = [];
    state.workingSet = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig({ sidebar_collapsed: false }));
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" });
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(activeDataset).mockImplementation(async () => null);
    vi.mocked(getAuthorizationMode).mockResolvedValue("per_call");
    vi.mocked(setAuthorizationMode).mockResolvedValue(undefined);
    vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
    vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
    vi.mocked(listAdapters).mockResolvedValue([]);
    vi.mocked(rescanAdapters).mockResolvedValue([]);
    vi.mocked(listSkills).mockResolvedValue({ skills: [skillEntry("charting")], ignored: [], root_error: null });
    // Every turn rejects so the creation turn settles immediately (the
    // openSession pattern); the stamp tests override the test's own ask.
    vi.mocked(askQuestion).mockRejectedValue(new Error("discard turns"));
  });

  afterEach(() => {
    // clearAllMocks clears a spy's history but never restores it -- restore
    // it here so the spy detaches from log.error and a second spyOn of the
    // same method never chains onto this one.
    logError.mockRestore();
  });

  it("logs the stamp throw from the direct fire (no staged activations)", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue(UNMAPPED_RUNTIME_CHOICE);
    vi.mocked(askQuestion).mockResolvedValue(STAMP_OUTCOME);
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "q" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        "App",
        "shell submit handleAsk threw unexpectedly",
        expect.objectContaining({
          message: expect.stringContaining("unhandled runtime choice"),
        }),
      ),
    );
  });

  it("logs the stamp throw from the staged-invocation fire (ADR-0119 branch)", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue(UNMAPPED_RUNTIME_CHOICE);
    vi.mocked(askQuestion).mockResolvedValue(STAMP_OUTCOME);
    render(<App />);
    await openSession();
    // Stage an invocation the way a picker pick does (the ADR-0119
    // in-session pattern): the staging rides the ask itself, so the fire
    // carries it -- the same fire site the defensive log must cover.
    const bar = screen.getByLabelText("提问");
    fireEvent.change(bar, { target: { value: "/", selectionStart: 1 } });
    await screen.findByRole("option");
    fireEvent.keyDown(bar, { key: "Enter" });
    await screen.findByText("charting");
    fireEvent.change(bar, { target: { value: "q2" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(askQuestion).toHaveBeenCalledWith("sess-1", "q2", ["charting"]),
    );
    await waitFor(() =>
      expect(logError).toHaveBeenCalledWith(
        "App",
        "shell submit handleAsk threw unexpectedly",
        expect.objectContaining({
          message: expect.stringContaining("unhandled runtime choice"),
        }),
      ),
    );
  });

  it("the composer ring rides the trailing send cluster's head, ahead of the runtime picker (ADR-0130)", async () => {
    // The window rides the snapshot itself (#1290: a channel report or the
    // backend's catalog stamp) -- the ring is a pure snapshot consumer, so
    // a window-bearing reading draws the arc with no config in play.
    const turn = recordedTurn("总共几行", {
      kind: "Textual",
      data: { text_kind: "Agent", body: "答", assumption: null },
    });
    // Inline-narrowed to the Turn arm: recordedTurn's ThreadEntry union
    // does not carry the TurnRecord shape TS needs for the occupancy
    // field without the guard.
    if (turn.entry !== "Turn") throw new Error("fixture shape");
    state.thread = [
      { entry: "Turn", data: { ...turn.data, occupancy: { tokens: 50_000, limit: 200_000 } } },
    ];
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
    await openSession();
    await waitFor(() => expect(conversation).toHaveBeenCalled());
    const ring = await screen.findByRole("button", { name: "上下文占用" });
    expect(ring.querySelectorAll("circle")).toHaveLength(2);
    // ADR-0130 (issue #1276): the ring rides the trailing send cluster's
    // head -- ahead of the runtime picker in DOM order.
    const picker = screen.getByRole("combobox", { name: /运行时：/ });
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(
      ring.compareDocumentPosition(picker) & FOLLOWING,
    ).toBeTruthy();
  });
});

describe("App quote lifecycle (#1573)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.workingSet = [];
    state.thread = [];
    vi.mocked(readRows).mockResolvedValue(ROW_PAGE);
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });

  const QUOTE_BODY = "可引用的正文内容比较长一些";

  async function openSessionWithProse(): Promise<void> {
    state.workingSet = [src("people")];
    state.thread = [textual(QUOTE_BODY)];
    render(<App />);
    await openSession();
    await waitFor(() => expect(screen.getByText(QUOTE_BODY)).toBeInTheDocument());
  }

  // Stage a quote through the real chain: select the thread's marked prose,
  // release the gesture (the window must see a selectionchange), click the
  // toolbar's quote action, then wait for the chip's excerpt.
  async function stageQuote(): Promise<void> {
    const prose = document.querySelector(".round-text") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(prose);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const conversation = document.querySelector(".session-conversation") as HTMLElement;
    fireEvent.pointerDown(conversation, { button: 0 });
    fireEvent(document, new Event("selectionchange"));
    fireEvent.pointerUp(conversation, { button: 0 });
    const toolbar = document.querySelector("[data-selection-toolbar]") as HTMLElement;
    expect(toolbar).not.toBeNull();
    const quote = [...toolbar.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("添加到对话"),
    );
    fireEvent.click(quote as HTMLElement);
    await waitFor(() =>
      expect(screen.getByText(`${QUOTE_BODY.slice(0, 8)}…`)).toBeInTheDocument(),
    );
  }

  it("materializes staged quotes at submit and clears the staging", async () => {
    await openSessionWithProse();
    const asksBefore = vi.mocked(askQuestion).mock.calls.length;
    await stageQuote();
    // Settle this turn so the bar returns to idle for the second submit.
    vi.mocked(askQuestion).mockRejectedValueOnce(new Error("settle turn one"));
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第二问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(vi.mocked(askQuestion).mock.calls.length).toBe(asksBefore + 1),
    );
    const ask = JSON.stringify(
      vi.mocked(askQuestion).mock.calls.at(-1),
    );
    expect(ask).toContain(`> ${QUOTE_BODY}`);
    expect(ask).toContain("第二问");
    // The staging cleared at the submit boundary: the next question carries
    // no blockquote.
    vi.mocked(askQuestion).mockRejectedValueOnce(new Error("settle turn two"));
    fireEvent.change(screen.getByLabelText("提问"), { target: { value: "第三问" } });
    fireEvent.click(screen.getByRole("button", { name: "提问" }));
    await waitFor(() =>
      expect(vi.mocked(askQuestion).mock.calls.length).toBe(asksBefore + 2),
    );
    const nextAsk = JSON.stringify(
      vi.mocked(askQuestion).mock.calls.at(-1),
    );
    expect(nextAsk).toContain("第三问");
    expect(nextAsk).not.toContain("> ");
  });

  it("Backspace at the draft's start withdraws the staged quote", async () => {
    await openSessionWithProse();
    await stageQuote();
    const excerpt = `${QUOTE_BODY.slice(0, 8)}…`;
    fireEvent.keyDown(screen.getByLabelText("提问"), { key: "Backspace" });
    await waitFor(() => expect(screen.queryByText(excerpt)).toBeNull());
  });
});
