import { vi, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AppConfig } from "../types/app-config";
import type { DatasetDescriptor } from "../types/dataset";
import type { ResumeProgress, TurnProgress } from "../types/session";
import type { DropCapture } from "./setup/shellFixtures";
import type { ThreadEntry } from "../types/thread";
import { askQuestion, conversation, createSession, getAppConfig, getAuthorizationMode, ingestFile, listAdapters, listProviderProfiles, listSkills, readRows, setAuthorizationMode, setSessionRuntime } from "../api";
import { open } from "@tauri-apps/plugin-dialog";
import { skillEntry } from "../test-fixtures";
import { buildTauriWindowMock } from "./setup/tauriWindowMock";
import { stubRenderedComposerBar } from "./setup/barRectStub";
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
    expect(screen.getByText(/问一个数据问题/)).toBeInTheDocument();
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
      expect(screen.getByText(/问一个数据问题/)).toBeInTheDocument();
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
      expect(screen.getByText(/问一个数据问题/)).toBeInTheDocument();
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
        expect(screen.getByRole("combobox", { name: /运行时/ })).toBeInTheDocument(),
      );
      // Open the picker select and pick the external adapter option
      // directly (the optgroup select). One trigger query: once the
      // dropdown is open Radix aria-hides the outside tree, so a second
      // getByRole would miss (the hidden-attr query behavior).
      const runtimeTrigger = screen.getByRole("combobox", { name: /运行时/ });
      fireEvent.pointerDown(runtimeTrigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(runtimeTrigger);
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
          screen.getByRole("combobox", { name: "运行时：gemini-cli" }),
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
          screen.getByRole("combobox", { name: "运行时：gemini-cli" }),
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
          screen.getByRole("combobox", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      // ...then the user explicitly reverts to built-in.
      const runtimeTrigger = screen.getByRole("combobox", { name: "运行时：gemini-cli" });
      fireEvent.pointerDown(runtimeTrigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(runtimeTrigger);
      // A profile pick IS the built-in pick in the optgroup select.
      const profileOption = await screen.findByRole("option", { name: "Anthropic" });
      fireEvent.pointerUp(profileOption, { button: 0, pointerType: "mouse" });
      fireEvent.click(profileOption);
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
          screen.getByRole("combobox", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      // Visit 1: explicitly pick built-in against the external default and
      // mint — the pick lands as one setSessionRuntime write.
      const runtimeTrigger = screen.getByRole("combobox", { name: "运行时：gemini-cli" });
      fireEvent.pointerDown(runtimeTrigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(runtimeTrigger);
      // A profile pick IS the built-in pick in the optgroup select.
      const profileOption = await screen.findByRole("option", { name: "Anthropic" });
      fireEvent.pointerUp(profileOption, { button: 0, pointerType: "mouse" });
      fireEvent.click(profileOption);
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
      await waitFor(() => expect(screen.getByText(/问一个数据问题/)).toBeInTheDocument());
      // The trigger re-seeds from the resolved default — the consumed
      // built-in pick is gone.
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "运行时：gemini-cli" }),
        ).toBeInTheDocument(),
      );
      expect(
        screen.queryByRole("combobox", { name: "运行时：Anthropic" }),
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
          screen.getByRole("combobox", { name: "运行时：Anthropic" }),
        ).toBeInTheDocument(),
      );
      // The degraded external default is NOT the trigger readout.
      expect(
        screen.queryByRole("combobox", { name: "运行时：gemini-cli" }),
      ).not.toBeInTheDocument();
    } finally {
      vi.mocked(getAppConfig).mockResolvedValue(null as unknown as AppConfig);
      vi.mocked(listAdapters).mockResolvedValue([]);
    }
  });

  it("cold-start bar renders the full composer control row — no degraded controls (ADR-0092 D6, #500)", async () => {
    // The centered bar carries the same control row as the session bar:
    // the "+" file button, the auth-mode chip, and the runtime picker. None
    // of them disappear or degrade on cold start, and none of them mints a
    // session by rendering. (The MCP trigger chip is retired, ADR-0106, and
    // the Skills trigger chip retired with the mount popover, #962 -- both
    // assertions flipped to absence.)
    vi.mocked(getAppConfig).mockResolvedValue(
      baseAppConfig({ sidebar_collapsed: false }),
    );
    try {
      render(<App />);
      await waitFor(() => expect(screen.getByLabelText("提问")).toBeInTheDocument());
      const bar = document.querySelector(".question-bar") as HTMLElement;
      expect(bar).not.toBeNull();
      // Skills trigger chip (retired with the mount popover, #962); no MCP
      // chip.
      expect(
        screen.queryByRole("button", { name: /技能/ }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /MCP/ }),
      ).not.toBeInTheDocument();
      // The "+" file button + the auth-mode chip.
      expect(bar.contains(screen.getByRole("button", { name: "添加文件" }))).toBe(true);
      expect(
        bar.contains(await screen.findByRole("button", { name: /授权模式/ })),
      ).toBe(true);
      // The runtime picker trailing slot.
      expect(
        bar.contains(await screen.findByRole("combobox", { name: /运行时/ })),
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
    // the first submit mints — the staged skill rides the first ask as its
    // user invocation (ADR-0119), the auth-mode write lands via
    // mintAndRegister, and the file goes through the ingest pipeline BEFORE
    // the first turn fires. (The MCP draft pick retired with the per-session
    // mount chain, ADR-0106; config enablement replaced it.)
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

      // Skills draft: pick charting through the "/" picker (the "/" and "$"
      // pickers are the only explicit activation channels; nothing fires
      // before the mint).
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "/", selectionStart: 1 } });
      await screen.findByRole("option");
      fireEvent.keyDown(screen.getByLabelText("提问"), { key: "Enter" });
      await screen.findByText("charting");

      // Files draft: the "+" pick queues into the pending list — the chip
      // shows the queue; nothing ingests yet.
      fireEvent.click(screen.getByRole("button", { name: "添加文件" }));
      await waitFor(() =>
        expect(screen.getByLabelText(/1 个文件已排队/)).toBeInTheDocument(),
      );
      expect(ingestFile).not.toHaveBeenCalled();

      // Auth-mode draft: switch to no-confirmation (no IPC yet).
      const authTrigger = screen.getByRole("button", { name: "授权模式：请求批准" });
      fireEvent.click(authTrigger);
      const radio = await screen.findByRole("radio", { name: /完全访问权限/ });
      fireEvent.click(radio);
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "授权模式：完全访问权限" }),
        ).toBeInTheDocument(),
      );
      expect(setAuthorizationMode).not.toHaveBeenCalled();

      // First submit mints the session and applies everything.
      fireEvent.change(screen.getByLabelText("提问"), { target: { value: "q" } });
      fireEvent.click(screen.getByRole("button", { name: "提问" }));
      await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(setAuthorizationMode).toHaveBeenCalledWith("sess-1", "no_confirmation"),
      );
      await waitFor(() => expect(ingestFile).toHaveBeenCalledWith("sess-1", "/x/a.csv"));
      // The staged skill rides the first ask as its user invocation
      // (ADR-0119: submit-time materialization).
      await waitFor(() =>
        expect(askQuestion).toHaveBeenCalledWith("sess-1", "q", ["charting"]),
      );
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
      .mockResolvedValueOnce({ session_id: "sess-1", recipe_path: "/sessions/sess-1/recipe.json" })
      .mockResolvedValueOnce({ session_id: "sess-2", recipe_path: "/sessions/sess-2/recipe.json" });
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
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-drop", recipe_path: "/sessions/sess-drop/recipe.json" });
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
    vi.mocked(createSession).mockResolvedValueOnce({ session_id: "sess-drop", recipe_path: "/sessions/sess-drop/recipe.json" });
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
    vi.mocked(createSession).mockImplementation(async () => ({ session_id: `sess-${++n}`, recipe_path: `/sessions/sess-${n}/recipe.json` }));
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
