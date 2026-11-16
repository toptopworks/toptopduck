import { vi, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppConfig } from "../types/app-config";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry } from "../types/thread";
import { activeDataset, askQuestion, conversation, createSession, getAppConfig, getAuthorizationMode, getSessionRuntime, ingestFile, listAdapters, listProviderProfiles, listSessions, listWorkingSet, openRecipe, readRows, rescanAdapters, setAuthorizationMode, setSessionRuntime } from "../api";
import { open } from "@tauri-apps/plugin-dialog";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { baseAppConfig, mcpServer, openSession, ROW_PAGE, src, buildDropWindowMock } from "./setup/shellFixtures";
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
    // Same trap for the session-scoped mocks the pane rides: earlier tests in
    // this file override createSession with implementations that survive
    // clearAllMocks, and this describe's ingest / badge assertions depend on
    // the exact sessionId + clean reads. Pin the factory behavior back each run.
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" });
    vi.mocked(conversation).mockImplementation(async () => state.thread);
    vi.mocked(listWorkingSet).mockImplementation(async () => state.workingSet);
    vi.mocked(activeDataset).mockImplementation(async () => null);
    // Same pin for the auth-mode chip IPC pair (issue #352): earlier tests'
    // overrides survive clearAllMocks.
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
    // The unified container holds the trigger (+), auth-mode chip, and the
    // textarea -- all inside .question-bar (ADR-0083 composer row restructured
    // into a single container).
    const trigger = screen.getByRole("button", { name: "添加文件" });
    const chip = await screen.findByRole("button", { name: "授权模式：请求批准" });
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
    // Issue #352: the chip reads the session's posture (per_call default)
    // and renders INSIDE the question-bar, not as a loose sibling.
    const authTrigger = await screen.findByRole("button", { name: "授权模式：请求批准" });
    expect(bar?.contains(authTrigger)).toBe(true);
  });

  it("switches the auth-mode Select to no-confirmation with the warning color (ADR-0080)", async () => {
    render(<App />);
    await openSession();
    const authTrigger = await screen.findByRole("button", { name: "授权模式：请求批准" });

    fireEvent.click(authTrigger);

    const radio = await screen.findByRole("radio", { name: /完全访问权限/ });
    fireEvent.click(radio);

    await waitFor(() =>
      expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation"),
    );
    // The flipped trigger reads 完全访问权限 and rides the --warning token
    // (border / fill / text all consume it).
    const flipped = await screen.findByRole("button", { name: "授权模式：完全访问权限" });
    expect(flipped.className).toContain("border-warning/40");
    expect(flipped.className).toContain("bg-warning/10");
    expect(flipped.className).toContain("text-warning");
  });

  it("resume renders the backend's actual posture for the NEW sid (ADR-0080 reset)", async () => {
    // The backend resets the posture on a successful resume (open_recipe ->
    // reset_approval); the frontend contract is that the resumed session's
    // chip re-reads it for the NEW sid and renders the landed value -- NOT a
    // hardcoded default. Pin a non-default read (no_confirmation) so a
    // regression that ignores the backend would fail (the beforeEach default
    // is per_call, which a hardcoded-default Select would also render).
    vi.mocked(listSessions).mockResolvedValue([
      {
        recipe_path: "/x/persisted.json",
        display_name: "季报",
        last_modified_at: Date.now(),
        source_summary: { first_source_name: "people", source_count: 1, turn_count: 1 },
        format_version: 1,
        pinned: false,
        archived: false,
        workspace: null,
      },
    ]);
    vi.mocked(createSession).mockResolvedValue({ session_id: "sess-resume", recipe_path: "/sessions/sess-resume/recipe.json" });
    vi.mocked(openRecipe).mockResolvedValue(undefined);
    vi.mocked(getAuthorizationMode).mockResolvedValue("no_confirmation");

    render(<App />);
    await waitFor(() => expect(screen.getByText("季报")).toBeInTheDocument());
    fireEvent.click(screen.getByText("季报"));

    await waitFor(() =>
      expect(getAuthorizationMode).toHaveBeenCalledWith("sess-resume"),
    );
    // The chip renders the backend's actual answer for the NEW sid, not a
    // hardcoded per_call default.
    expect(
      await screen.findByRole("button", { name: "授权模式：完全访问权限" }),
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

  it("no trigger chips render with configured MCP servers (ADR-0106, #962)", async () => {
    // ADR-0106: the composer MCP mount chip is retired (config-level
    // enablement replaced per-session mounting). #962: the Skills trigger
    // chip retired with the mount popover. With servers configured neither
    // trigger chip exists anywhere in the bar.
    vi.mocked(getAppConfig).mockResolvedValue({
      ...baseAppConfig({ sidebar_collapsed: false }),
      cli_tools: { tools: [] },
      mcp_servers: { servers: [mcpServer("srv")] },
    });
    render(<App />);
    await openSession();

    expect(screen.queryByRole("button", { name: /技能/ })).not.toBeInTheDocument();
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
    const trigger = await screen.findByRole("combobox", { name: "运行时：Anthropic" });
    const bar = document.querySelector(".question-bar") as HTMLElement;
    expect(bar.contains(trigger)).toBe(true);
  });

  it("does not render the provider/model picker while app-config is pending", async () => {
    // beforeEach holds getAppConfig pending so appConfig stays at its
    // useState(null) initial -- App does not pass the picker bundle, so the
    // picker trigger is absent until app-config resolves.
    render(<App />);
    await openSession();
    expect(screen.queryByRole("combobox", { name: /运行时/ })).not.toBeInTheDocument();
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
        expect(screen.getByRole("combobox", { name: /运行时/ })).toBeInTheDocument(),
      );
      // Pick the external adapter option directly (the optgroup select).
      // One trigger query: once the dropdown is open Radix aria-hides the
      // outside tree, so a second getByRole would miss (the hidden-attr
      // query behavior).
      const runtimeTrigger = screen.getByRole("combobox", { name: /运行时/ });
      fireEvent.pointerDown(runtimeTrigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(runtimeTrigger);
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
    expect(screen.queryByRole("heading", { name: /问一个数据问题/ })).not.toBeInTheDocument();
    // The greeting renders as a visible <label> associated with the textarea.
    expect(screen.getByLabelText("提问")).toBeInTheDocument();
    expect(screen.getByText(/问一个数据问题/)).toBeInTheDocument();
  });
});
