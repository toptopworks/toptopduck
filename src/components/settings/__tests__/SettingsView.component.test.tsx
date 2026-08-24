import { useState } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as dialogPlugin from "@tauri-apps/plugin-dialog";
import { SettingsView } from "../SettingsView";
import {
  listProviderProfiles,
  setProfileKey,
  setSessionsDir,
  getSessionsDir,
  getAppConfig,
  setDefaultRuntime,
  listAdapters,
  rescanAdapters,
} from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import type { AdapterEntry } from "../../../types/runtime";
import type { SettingsSection } from "../sections";
import { chooseOption, openSelect, renderSettings } from "./helpers";

// SettingsView reaches the per-profile keychain surface (issue #153); mock the
// IPC functions so the view never hits Tauri. listProviderProfiles feeds the
// Profiles pane key-status overlay; setProfileKey feeds the immediate key IPC
// (ADR-0029 one-shot). listAdapters / rescanAdapters feed the Runtime section's
// Local CLI tab (issue #489) -- always mounted, so must resolve in every test.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listProviderProfiles: vi.fn(),
    setProfileKey: vi.fn(),
    clearProfileKey: vi.fn(),
    setSessionsDir: vi.fn(),
    getSessionsDir: vi.fn(),
    getAppConfig: vi.fn(),
    setDefaultRuntime: vi.fn(),
    listAdapters: vi.fn(),
    rescanAdapters: vi.fn(),
  };
});

// The sessions-dir row uses the directory picker + opener plugins (issue #452).
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: vi.fn(),
}));

// The single write path the view awaits; typed so a commit mock is assignable to
// the onCommitAppConfig prop and its .mock.calls stay typed.
type CommitFn = (cfg: AppConfig) => Promise<void>;

// Controlled-section harness (issue #288): owns the section the way the shell
// does (useState + onSectionChange), so the controlled section prop is exercised
// exactly as in production. initialSection seeds the first render.
function SettingsViewHarness({
  appConfig,
  onCommitAppConfig,
  onReplaceAppConfig,
  onSessionsDirChanged,
  onDefaultRuntimeChanged,
  onClose,
  initialSection,
}: {
  appConfig: AppConfig;
  onCommitAppConfig: Mock<CommitFn>;
  onReplaceAppConfig: (cfg: AppConfig) => void;
  onSessionsDirChanged: (cfg: AppConfig) => void;
  onDefaultRuntimeChanged: (cfg: AppConfig) => void;
  onClose: () => void;
  initialSection: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  return (
    <SettingsView
      collapsed={false}
      appConfig={appConfig}
      section={section}
      onSectionChange={setSection}
      onCommitAppConfig={onCommitAppConfig}
      onReplaceAppConfig={onReplaceAppConfig}
      onSessionsDirChanged={onSessionsDirChanged}
      onDefaultRuntimeChanged={onDefaultRuntimeChanged}
      onClose={onClose}
    />
  );
}

describe("SettingsView (ADR-0075 per-control persistence + rail chrome)", () => {
  const baseConfig: AppConfig = {
    format_version: 2,
    theme: "system",
    locale: "system",
    engine: { memory_limit: "512MB", threads: 2, row_cap: 1000, statement_timeout_ms: 30000 },
    privacy: { send_samples: true },
    provider: {
      profiles: [
        {
          id: "default",
          display_name: "Anthropic",
          protocol: "anthropic",
          base_url: "https://api.anthropic.com",
          model: "claude-sonnet",
        },
      ],
      active_profile: "default",
    },
    export: { last_dir: null, default_format: "csv" },
    tunables: { window_turns: 10, far_window: 30 },
    shell: { sidebar_collapsed: false, sidebar_grouping: "flat" },
    mcp_servers: { servers: [] },
    sessions_dir: null,
    default_runtime: { kind: "built_in" },
    last_model_postures: {},
  };
  const profileKeysDefault = [{ profile_id: "default", has_key: false, keychain_fault: null }];

  const twoProfileConfig: AppConfig = {
    ...baseConfig,
    provider: {
      profiles: [
        baseConfig.provider.profiles[0],
        {
          id: "second",
          display_name: "GLM",
          protocol: "openai",
          base_url: "https://open.bigmodel.cn/api/paas/v4",
          model: "glm-4",
        },
      ],
      active_profile: "default",
    },
  };
  const twoProfileKeys = [
    { profile_id: "default", has_key: false, keychain_fault: null },
    { profile_id: "second", has_key: false, keychain_fault: null },
  ];

  // ADR-0098 Decision 1: the zero-profile state is a legal persisted posture.
  const zeroProfileConfig: AppConfig = {
    ...baseConfig,
    provider: { profiles: [], active_profile: null },
  };

  // Fixture adapters for the Local CLI tab (issue #489). Always mounted, so
  // every test must have the mock resolve.
  const mockAdapters: AdapterEntry[] = [
    { id: "qwen-code", display_name: "qwen-code", detected: true, binary_path: "/usr/local/bin/qwen", stream_format: "acp" },
    { id: "gemini-cli", display_name: "gemini-cli", detected: false, binary_path: null, stream_format: "acp" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue(profileKeysDefault);
    vi.mocked(getSessionsDir).mockResolvedValue("/home/user/Documents/toptopduck/sessions");
    vi.mocked(listAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(rescanAdapters).mockResolvedValue(mockAdapters);
  });

  // Shared render harness: SettingsView requires a controlled section (issue
  // #288: the section is shell-owned so the back/forward history can restore
  // it; SettingsViewHarness owns it with useState the way the shell does).
  // Returns the RTL result + the seam mocks.
  function renderView({
    appConfig = baseConfig,
    onCommitAppConfig = vi.fn<CommitFn>().mockResolvedValue(undefined),
    onReplaceAppConfig = vi.fn(),
    onSessionsDirChanged = vi.fn(),
    onDefaultRuntimeChanged = vi.fn(),
    onClose = vi.fn(),
    initialSection = "general",
  }: {
    appConfig?: AppConfig;
    onCommitAppConfig?: Mock<CommitFn>;
    onReplaceAppConfig?: (cfg: AppConfig) => void;
    onSessionsDirChanged?: (cfg: AppConfig) => void;
    onDefaultRuntimeChanged?: (cfg: AppConfig) => void;
    onClose?: () => void;
    initialSection?: SettingsSection;
  } = {}) {
    const result = renderSettings(
      <SettingsViewHarness
        appConfig={appConfig}
        onCommitAppConfig={onCommitAppConfig}
        onReplaceAppConfig={onReplaceAppConfig}
        onSessionsDirChanged={onSessionsDirChanged ?? (() => undefined)}
        onDefaultRuntimeChanged={onDefaultRuntimeChanged}
        onClose={onClose}
        initialSection={initialSection}
      />,
    );
    return { ...result, onCommitAppConfig, onClose };
  }

  // openSelect / chooseOption (Radix jsdom interaction) live in ./helpers,
  // shared with the DefaultRuntimeControl + RuntimeSection suites.

  // The runtime pane may carry more than one Save row (profiles + default
  // runtime); the enabled one is the row under test.
  function enabledSave(): HTMLButtonElement {
    return screen.getAllByRole("button", { name: "Save" }).find(
      (b) => !(b as HTMLButtonElement).disabled,
    ) as HTMLButtonElement;
  }

  // --- General pane: immediate-commit selects (no Save) --------------------

  it("renders theme + language selects on the General pane", async () => {
    renderView();
    expect(await screen.findByRole("combobox", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeInTheDocument();
  });

  it("selecting a theme commits immediately (no Save button, ADR-0075 case a)", async () => {
    const { onCommitAppConfig } = renderView();
    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Dark");
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(1));
    expect(onCommitAppConfig.mock.calls[0][0].theme).toBe("dark");
    // The rest of the config round-trips unchanged.
    expect(onCommitAppConfig.mock.calls[0][0].engine).toEqual(baseConfig.engine);
    // The only Save button is the sessions-dir row's draft commit; it is
    // disabled because no directory has been picked, confirming the theme
    // row itself has no Save button (ADR-0075 case a).
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("a failed immediate commit surfaces an inline error (revert-on-fail)", async () => {
    // The commit rejects once; the compensating revert write then succeeds,
    // keeping this test on the single-failure path (the double-failure
    // branch is pinned separately below).
    const onCommitAppConfig = vi
      .fn<CommitFn>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    renderView({ onCommitAppConfig });
    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Dark");
    expect(await screen.findByText("disk full")).toBeInTheDocument();
    // Single failure: the compensating write landed, so the disk re-read
    // must not fire.
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(2));
    expect(vi.mocked(getAppConfig)).not.toHaveBeenCalled();
  });

  it("a double-failed commit re-reads the disk truth instead of diverging (#659)", async () => {
    // Both the commit and its compensating write reject: the disk value is
    // then unknown (the first write may have landed despite rejecting), so
    // the view re-reads it and feeds the disk config through
    // onReplaceAppConfig -- the control shows what is stored, not a
    // silently divergent pre-commit snapshot.
    const diskConfig = {
      ...baseConfig,
      theme: "dark" as const,
      // A field the pre-commit snapshot does NOT carry, so the third
      // commit's payload can prove which config it derived from.
      engine: { ...baseConfig.engine, threads: 8 },
    };
    let calls = 0;
    const onCommitAppConfig = vi.fn<CommitFn>().mockImplementation(() => {
      calls += 1;
      return calls <= 2
        ? Promise.reject(new Error("write broken"))
        : Promise.resolve();
    });
    vi.mocked(getAppConfig).mockResolvedValue(diskConfig);
    const onReplaceAppConfig = vi.fn();

    renderView({ onCommitAppConfig, onReplaceAppConfig });

    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Dark");

    // The commit + its compensating revert both fired (and both rejected).
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(onReplaceAppConfig).toHaveBeenCalledWith(diskConfig),
    );
    // The surfaced error stays the user-facing signal.
    expect(await screen.findByText("write broken")).toBeInTheDocument();

    // The re-read re-syncs the commit chain's mirror too: the NEXT commit
    // derives from the disk config (threads 8), not the stale pre-commit
    // snapshot (threads 2) -- deleting the latestRef sync would pass every
    // assertion above while reintroducing the divergence.
    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Light");
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(3));
    expect(onCommitAppConfig.mock.calls[2][0].theme).toBe("light");
    expect(onCommitAppConfig.mock.calls[2][0].engine.threads).toBe(8);
  });

  // --- Sessions directory row (issue #452) ---------------------------------

  it("displays the backend-resolved sessions directory on mount", async () => {
    renderView();
    expect(
      await screen.findByText("/home/user/Documents/toptopduck/sessions"),
    ).toBeInTheDocument();
  });

  it("Save is disabled until Browse picks a directory", async () => {
    renderView();
    await screen.findByText("/home/user/Documents/toptopduck/sessions");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("Browse + Save calls setSessionsDir and syncs state", async () => {
    const onSessionsDirChanged = vi.fn();
    const updatedConfig: AppConfig = { ...baseConfig, sessions_dir: "/new/sessions" };
    vi.mocked(dialogPlugin.open).mockResolvedValue("/new/sessions");
    vi.mocked(setSessionsDir).mockResolvedValue(updatedConfig);

    renderView({ onSessionsDirChanged });
    await screen.findByText("/home/user/Documents/toptopduck/sessions");

    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(vi.mocked(dialogPlugin.open)).toHaveBeenCalled());
    // Save becomes enabled after picking a directory.
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(vi.mocked(setSessionsDir)).toHaveBeenCalledWith("/new/sessions"));
    await waitFor(() => expect(onSessionsDirChanged).toHaveBeenCalledWith(updatedConfig));
  });

  it("a failed Save surfaces an inline error and keeps the draft for retry", async () => {
    vi.mocked(dialogPlugin.open).mockResolvedValue("/bad/path");
    vi.mocked(setSessionsDir).mockRejectedValue(new Error("not writable"));

    renderView();
    await screen.findByText("/home/user/Documents/toptopduck/sessions");

    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(vi.mocked(dialogPlugin.open)).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("not writable")).toBeInTheDocument();
    // Draft is retained so the user can retry.
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  it("ESC is blocked while a sessions-dir Save IPC is in flight", async () => {
    const updatedConfig: AppConfig = { ...baseConfig, sessions_dir: "/new/sessions" };
    vi.mocked(dialogPlugin.open).mockResolvedValue("/new/sessions");

    let resolveSave!: (cfg: AppConfig) => void;
    vi.mocked(setSessionsDir).mockImplementation(
      () => new Promise<AppConfig>((resolve) => { resolveSave = resolve; }),
    );

    const { onClose } = renderView();
    await screen.findByText("/home/user/Documents/toptopduck/sessions");
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(vi.mocked(dialogPlugin.open)).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(vi.mocked(setSessionsDir)).toHaveBeenCalled());

    // ESC must be blocked while the sessions-dir IPC is in flight (I-2).
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();

    // Once the IPC settles, ESC closes.
    resolveSave(updatedConfig);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // --- Default runtime row (issue #571) -------------------------------------

  it("a default-runtime Save calls setDefaultRuntime and feeds the returned config through onDefaultRuntimeChanged", async () => {
    // Pins the SettingsView wiring: the shell callback receives the config
    // the write IPC returned, through the latestRef-syncing wrapper (same
    // seam the sessions-dir Browse + Save test pins for its callback).
    const onDefaultRuntimeChanged = vi.fn();
    const updatedConfig: AppConfig = {
      ...baseConfig,
      default_runtime: { kind: "external", data: "qwen-code" },
    };
    vi.mocked(setDefaultRuntime).mockResolvedValue(updatedConfig);

    renderView({ initialSection: "runtime", onDefaultRuntimeChanged });
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("Built-in"));

    openSelect(combobox);
    chooseOption("qwen-code");
    fireEvent.click(enabledSave());

    await waitFor(() =>
      expect(vi.mocked(setDefaultRuntime)).toHaveBeenCalledWith({
        kind: "external",
        data: "qwen-code",
      }),
    );
    await waitFor(() => expect(onDefaultRuntimeChanged).toHaveBeenCalledWith(updatedConfig));
  });

  it("ESC is blocked while a default-runtime Save IPC is in flight", async () => {
    // Pins the defaultRuntime busy-channel registration in the close guard
    // (ADR-0075): while the write IPC is in flight, ESC must not close.
    let resolveSave!: (cfg: AppConfig) => void;
    vi.mocked(setDefaultRuntime).mockImplementation(
      () => new Promise<AppConfig>((resolve) => { resolveSave = resolve; }),
    );

    const { onClose } = renderView({ initialSection: "runtime" });
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("Built-in"));
    openSelect(combobox);
    chooseOption("qwen-code");
    fireEvent.click(enabledSave());
    await waitFor(() => expect(vi.mocked(setDefaultRuntime)).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();

    // Once the IPC settles, ESC closes.
    resolveSave({ ...baseConfig, default_runtime: { kind: "external", data: "qwen-code" } });
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("overlapping commits serialize: a failed commit's revert lands before the next commit", async () => {
    // The first commit hangs until the test rejects it; the second change is
    // issued while the first is still in flight. The single-flight chain makes
    // the FIRST commit's compensating revert land as the second write and the
    // queued light commit as the third (concurrent commits could otherwise
    // diverge UI from disk when one fails mid-overlap).
    let rejectFirst!: (e: Error) => void;
    let first = true;
    const onCommitAppConfig = vi.fn<CommitFn>().mockImplementation(() => {
      if (first) {
        first = false;
        return new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return Promise.resolve();
    });
    renderView({ onCommitAppConfig });
    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Dark");
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(1));
    // A second change while the first commit is still pending.
    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Light");
    rejectFirst(new Error("disk full"));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(3));
    expect(onCommitAppConfig.mock.calls[0][0].theme).toBe("dark");
    // The compensating revert of the failed commit comes BEFORE the queued
    // light commit, which then reads the reverted (original) config.
    expect(onCommitAppConfig.mock.calls[1][0].theme).toBe("system");
    expect(onCommitAppConfig.mock.calls[2][0].theme).toBe("light");
    // The queued light commit succeeds, so the pane settles error-free on the
    // last successful value -- UI and disk converge (no split state).
    await waitFor(() => expect(screen.queryByText("disk full")).not.toBeInTheDocument());
  });

  // --- Engine pane: per-field explicit Save (ADR-0075 case c) --------------

  it("each engine field has its own Save that commits only that field", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Database Engine" }));
    // Four independent Save buttons (memory limit / threads / row cap / timeout).
    expect(screen.getAllByRole("button", { name: "Save" })).toHaveLength(4);
    // Edit the threads input (the first spinbutton) and save just that field.
    fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "8" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(1));
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.engine.threads).toBe(8);
    // The sibling fields are carried over from the latest config, untouched.
    expect(committed.engine.memory_limit).toBe("512MB");
    expect(committed.engine.row_cap).toBe(1000);
  });

  it("a failed engine save shows an inline error without closing", async () => {
    const onCommitAppConfig = vi.fn<CommitFn>().mockRejectedValue(new Error("read-only"));
    const { onClose } = renderView({ onCommitAppConfig });
    fireEvent.click(screen.getByRole("button", { name: "Database Engine" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    expect(await screen.findByText("read-only")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  // --- Close / ESC contract (ADR-0075) -------------------------------------

  it("ESC closes when not busy", async () => {
    const { onClose } = renderView();
    await screen.findByRole("combobox", { name: "Theme" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("ESC is blocked while a commit is in flight", async () => {
    const onCommitAppConfig = vi
      .fn<CommitFn>()
      .mockImplementation(() => new Promise<void>(() => {}));
    const { onClose } = renderView({ onCommitAppConfig });
    fireEvent.click(screen.getByRole("button", { name: "Database Engine" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ESC yields to the open delete-confirm dialog (view stays open)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { onClose } = renderView({ appConfig: twoProfileConfig });
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(await screen.findByRole("button", { name: "GLM" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByRole("alertdialog");
    // ESC through the document so BOTH the dialog's dismiss handler and the
    // view's window listener receive it (bubbling, like a real keydown): the
    // dialog cancels the delete, the view must NOT also close (ADR-0075: a
    // confirm dialog owns window ESC).
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    // A second ESC -- no dialog open any more -- closes the view.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("ESC with a dirty invalid edit stays open on the flush error", async () => {
    const { onClose } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    const baseUrl = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrl, { target: { value: "ftp://nope" } });
    // ESC flushes the still-dirty draft; validation fails, so the view must
    // stay open on the surfaced error instead of unmounting it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("Base URL must use http or https.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a key IPC started before a section switch still blocks ESC until it settles", async () => {
    // A deferred key IPC the test resolves, so a pane switch can happen
    // mid-flight: the Profiles pane -- and its local busy state -- unmounts,
    // but the close guard must keep blocking until the orphaned IPC settles
    // (ADR-0075: close blocked while ANY in-flight IPC).
    let resolveKey!: (value: boolean) => void;
    vi.mocked(setProfileKey).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveKey = resolve;
        }),
    );
    const { onClose } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    await screen.findAllByText("Anthropic");
    fireEvent.change(screen.getByPlaceholderText("sk-ant-api03-…"), {
      target: { value: "sk-test-281" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await waitFor(() => expect(vi.mocked(setProfileKey)).toHaveBeenCalled());
    // Switch panes mid-IPC: the pane's controlsRef is cleared on unmount.
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
    // Once the IPC settles (its finally reports upward from the unmounted
    // pane), ESC closes.
    resolveKey(true);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // --- Rail chrome: nav, footer gear ---------------------------------------

  it("switches panes via the icon rail nav", async () => {
    renderView();
    await screen.findByRole("combobox", { name: "Theme" });
    fireEvent.click(screen.getByRole("button", { name: "Database Engine" }));
    expect(screen.getAllByRole("button", { name: "Save" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    expect(await screen.findByRole("button", { name: "New profile" })).toBeInTheDocument();
  });

  it("the rail-top back button closes the view", async () => {
    const { onClose, container } = renderView();
    await screen.findByRole("combobox", { name: "Theme" });
    // The rail-top back button carries the settings-back hook class (distinct
    // from the gear, which shares its accessible name).
    fireEvent.click(container.querySelector(".settings-back") as HTMLElement);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  // --- Profiles pane: auto-persist + structural ops (ADR-0075) -------------

  it("lists profiles with the Active badge", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    // "Anthropic" appears in both the connection row and the list; the Active
    // badge is the list-level signal under test.
    await screen.findAllByText("Anthropic");
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("commit-on-blur persists an edited endpoint (no Save button)", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    const baseUrl = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrl, { target: { value: "https://my-gw.example/v1" } });
    // Blur to a target outside the edit form fires the commit.
    fireEvent.blur(baseUrl, { relatedTarget: document.body });
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles[0].base_url).toBe("https://my-gw.example/v1");
    // Endpoint edit mode has no Save button of its own (commit-on-blur). The
    // only Save on this pane is the default-runtime row's (issue #571), which
    // stays disabled while it has no draft -- so no enabled Save is present.
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    expect(saveButtons.length).toBeGreaterThan(0);
    for (const b of saveButtons) expect(b).toBeDisabled();
  });

  it("an invalid base URL blocks the blur commit with a validation error", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    const baseUrl = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrl, { target: { value: "ftp://nope" } });
    fireEvent.blur(baseUrl, { relatedTarget: document.body });
    expect(await screen.findByText("Base URL must use http or https.")).toBeInTheDocument();
    expect(onCommitAppConfig).not.toHaveBeenCalled();
  });

  it("add mode holds the profile in memory until the Create button commits it", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(await screen.findByRole("button", { name: "New profile" }));
    // Add mode: the create button appears and nothing is committed yet.
    const create = screen.getByRole("button", { name: "Create profile" });
    expect(onCommitAppConfig).not.toHaveBeenCalled();
    fireEvent.click(create);
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles).toHaveLength(2);
    expect(committed.provider.profiles[1].id).toBeTruthy();
    expect(committed.provider.profiles[1].protocol).toBe("anthropic");
  });

  it("zero profiles: empty state shows, New profile prefills defaults, Create commits 0 → 1 (issue #570)", async () => {
    const { onCommitAppConfig } = renderView({ appConfig: zeroProfileConfig });
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    // Empty state (not an empty list), and no misleading "select a profile on
    // the left" prompt while there is nothing to select.
    expect(
      await screen.findByText("No profiles yet. Click “New profile” to add one."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Select a profile on the left to edit it, or create a new one."),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    // The add form prefills the interaction-layer defaults (anthropic + the
    // direct endpoint + the default model, ADR-0098 Decision 1 -- prefill is
    // UI-layer only; the store never seeds a skeleton).
    expect(
      ((await screen.findByLabelText("Base URL")) as HTMLInputElement).value,
    ).toBe("https://api.anthropic.com");
    expect(
      ((screen.getByLabelText("Model")) as HTMLInputElement).value,
    ).toBe("claude-sonnet-4-6");
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles).toHaveLength(1);
    expect(committed.provider.profiles[0].protocol).toBe("anthropic");
    expect(committed.provider.profiles[0].base_url).toBe("https://api.anthropic.com");
    expect(committed.provider.profiles[0].model).toBe("claude-sonnet-4-6");
    // Create appends without repointing the pointer (creation is not
    // activation): the commit lands "1 profile + null active" -- the legal
    // nullable-active posture, left to Set as active to move.
    expect(committed.provider.active_profile).toBeNull();
  });

  it("delete confirms then commits immediately", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { onCommitAppConfig } = renderView({ appConfig: twoProfileConfig });
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    // Select the second profile (GLM) for editing. Scope to the list row button:
    // "GLM" also appears as a preset <option> (getByText matches option text).
    fireEvent.click(await screen.findByRole("button", { name: "GLM" }));
    // Trash lives at the edit-form header; confirm then delete.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles).toHaveLength(1);
    expect(committed.provider.profiles[0].id).toBe("default");
  });

  it("deleting the ACTIVE profile repoints the pointer at the first survivor", async () => {
    // ADR-0098: normalize nulls a dangling pointer (no first-profile fallback),
    // so the delete write itself must stay self-consistent -- deleting the
    // active profile must repoint the pointer, not leave it dangling.
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { onCommitAppConfig } = renderView({ appConfig: twoProfileConfig });
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    // Select the active profile (Anthropic) for editing. Regex name match:
    // the row button's accessible name is the display name with the "Active"
    // badge text concatenated whitespace-free ("AnthropicActive"), and the
    // display name also appears as a preset <option> text (not a button).
    fireEvent.click(await screen.findByRole("button", { name: /^Anthropic/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles).toHaveLength(1);
    expect(committed.provider.profiles[0].id).toBe("second");
    expect(committed.provider.active_profile).toBe("second");
  });

  it("the last profile's delete is enabled; deleting to zero commits an empty set (ADR-0098)", async () => {
    // Zero profiles is a legal persisted state, so the last-profile delete
    // guard is gone (ADR-0098 Decision 1): the write lands profiles: [] with
    // a null active pointer -- self-consistent, no dangling id.
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    await screen.findAllByText("Anthropic");
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    // The body copy states the zero-profile landing (no active profile after
    // the last delete), matching the self-consistent commit below.
    expect(
      within(dialog).getByText(/switches to the next remaining one, or none if this was the last/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles).toHaveLength(0);
    expect(committed.provider.active_profile).toBeNull();
  });

  it("set-active commits immediately and refreshes key status", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { onCommitAppConfig } = renderView({
      appConfig: twoProfileConfig,
    });
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(await screen.findByRole("button", { name: "GLM" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set as active" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    expect(onCommitAppConfig.mock.calls[0][0].provider.active_profile).toBe("second");
  });

  it("set key is immediate IPC and reports upward (ADR-0029 one-shot)", async () => {
    vi.mocked(setProfileKey).mockResolvedValue(true);
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    await screen.findAllByText("Anthropic");
    fireEvent.change(screen.getByPlaceholderText("sk-ant-api03-…"), {
      target: { value: "sk-test-281" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await waitFor(() =>
      expect(vi.mocked(setProfileKey)).toHaveBeenCalledWith("default", "sk-test-281"),
    );
  });

  it("closing with a dirty new profile confirms discard", async () => {
    const { onClose, container } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(await screen.findByRole("button", { name: "New profile" }));
    // Make the add-mode form dirty.
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Half typed" },
    });
    // Attempt to close via the rail-top back button.
    fireEvent.click(container.querySelector(".settings-back") as HTMLElement);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("selecting another profile stashes the add draft; New profile restores it", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    renderView({ appConfig: twoProfileConfig });
    fireEvent.click(screen.getByRole("button", { name: "Runtime" }));
    fireEvent.click(await screen.findByRole("button", { name: "New profile" }));
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Half typed" },
    });
    // Selecting an existing profile leaves add mode WITHOUT a confirm or loss:
    // the draft is stashed (retained on addingProfile) and the form switches.
    fireEvent.click(screen.getByRole("button", { name: "GLM" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Base URL")).toHaveValue(
        twoProfileConfig.provider.profiles[1].base_url,
      ),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // Re-entering add mode restores the stashed draft verbatim.
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    expect(await screen.findByLabelText("Display name")).toHaveValue("Half typed");
  });

  it("a numeric engine field can be cleared; an empty save clamps to the minimum", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Database Engine" }));
    const threads = screen.getAllByRole("spinbutton")[0];
    fireEvent.change(threads, { target: { value: "" } });
    // The field stays clearable (no snap back to 1). RTL's toHaveValue reads an
    // empty number input as null, so assert on the DOM value directly.
    expect((threads as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]);
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    // An explicit save is not a correctness gate: an empty value clamps to 1.
    expect(onCommitAppConfig.mock.calls[0][0].engine.threads).toBe(1);
  });
});
