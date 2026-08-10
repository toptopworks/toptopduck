import { useState } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import * as dialogPlugin from "@tauri-apps/plugin-dialog";
import { SettingsView } from "../SettingsView";
import { listProviderProfiles, setProfileKey, setSessionsDir, getSessionsDir } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import type { SettingsSection } from "../sections";
import { renderSettings } from "./helpers";

// SettingsView reaches the per-profile keychain surface (issue #153); mock the
// IPC functions so the view never hits Tauri. listProviderProfiles feeds the
// Profiles pane key-status overlay; setProfileKey feeds the immediate key IPC
// (ADR-0029 one-shot).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listProviderProfiles: vi.fn(),
    setProfileKey: vi.fn(),
    clearProfileKey: vi.fn(),
    setSessionsDir: vi.fn(),
    getSessionsDir: vi.fn(),
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
  onSessionsDirChanged,
  onClose,
  onRefreshKeyStatus,
  keyStatus,
  initialSection,
}: {
  appConfig: AppConfig;
  onCommitAppConfig: Mock<CommitFn>;
  onSessionsDirChanged: (cfg: AppConfig) => void;
  onClose: () => void;
  onRefreshKeyStatus: () => void;
  keyStatus: { has_key: boolean; keychain_fault: string | null };
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
      onSessionsDirChanged={onSessionsDirChanged}
      onClose={onClose}
      onRefreshKeyStatus={onRefreshKeyStatus}
      keyStatus={keyStatus}
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
    recent_files: [],
    shell: { sidebar_collapsed: false, rail_collapsed: false, sidebar_grouping: "flat" },
    mcp_servers: { servers: [] },
    sessions_dir: null,
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue(profileKeysDefault);
    vi.mocked(getSessionsDir).mockResolvedValue("/home/user/Documents/toptopduck/sessions");
  });

  // Shared render harness: SettingsView now requires the key-status seam
  // (keyStatus for the rail connection row) + onRefreshKeyStatus (set-active
  // refresh) + a controlled section (issue #288: the section is shell-owned so
  // the back/forward history can restore it; SettingsViewHarness owns it with
  // useState the way the shell does). Returns the RTL result + the seam mocks.
  function renderView({
    appConfig = baseConfig,
    onCommitAppConfig = vi.fn<CommitFn>().mockResolvedValue(undefined),
    onSessionsDirChanged = vi.fn(),
    onClose = vi.fn(),
    onRefreshKeyStatus = vi.fn(),
    keyStatus = { has_key: true, keychain_fault: null },
    initialSection = "general",
  }: {
    appConfig?: AppConfig;
    onCommitAppConfig?: Mock<CommitFn>;
    onSessionsDirChanged?: (cfg: AppConfig) => void;
    onClose?: () => void;
    onRefreshKeyStatus?: () => void;
    keyStatus?: { has_key: boolean; keychain_fault: string | null };
    initialSection?: SettingsSection;
  } = {}) {
    const result = renderSettings(
      <SettingsViewHarness
        appConfig={appConfig}
        onCommitAppConfig={onCommitAppConfig}
        onSessionsDirChanged={onSessionsDirChanged ?? (() => undefined)}
        onClose={onClose}
        onRefreshKeyStatus={onRefreshKeyStatus}
        keyStatus={keyStatus}
        initialSection={initialSection}
      />,
    );
    return { ...result, onCommitAppConfig, onClose, onRefreshKeyStatus };
  }

  // Radix Select in jsdom: the trigger opens on a primary pointer-down + click;
  // an option selects on pointer-up + click (the test-setup polyfills stub the
  // pointer APIs jsdom lacks).
  function openSelect(combobox: HTMLElement) {
    fireEvent.pointerDown(combobox, { button: 0, pointerType: "mouse" });
    fireEvent.click(combobox);
  }
  function chooseOption(name: string) {
    const option = screen.getByRole("option", { name });
    fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option);
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
    const onCommitAppConfig = vi.fn<CommitFn>().mockRejectedValue(new Error("disk full"));
    renderView({ onCommitAppConfig });
    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Dark");
    expect(await screen.findByText("disk full")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ESC yields to the open delete-confirm dialog (view stays open)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { onClose } = renderView({ appConfig: twoProfileConfig });
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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

  // --- Rail chrome: nav, connection row, dual-state gear -------------------

  it("switches panes via the icon rail nav", async () => {
    renderView();
    await screen.findByRole("combobox", { name: "Theme" });
    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
    expect(screen.getAllByRole("button", { name: "Save" }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    expect(await screen.findByRole("button", { name: "New profile" })).toBeInTheDocument();
  });

  it("connection row shows the active profile + key status and jumps to Profiles", async () => {
    const { container } = renderView();
    const row = container.querySelector(".connection-row") as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText("Anthropic")).toBeInTheDocument();
    expect(within(row).getByText("Connected")).toBeInTheDocument();
    fireEvent.click(row);
    expect(await screen.findByRole("button", { name: "New profile" })).toBeInTheDocument();
  });

  it("connection row reads Keychain unavailable on a keychain fault", () => {
    const { container } = renderView({
      keyStatus: { has_key: false, keychain_fault: "locked" },
    });
    expect(
      within(container.querySelector(".connection-row") as HTMLElement).getByText(
        "Keychain unavailable",
      ),
    ).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // "Anthropic" appears in both the connection row and the list; the Active
    // badge is the list-level signal under test.
    await screen.findAllByText("Anthropic");
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("commit-on-blur persists an edited endpoint (no Save button)", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    const baseUrl = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrl, { target: { value: "https://my-gw.example/v1" } });
    // Blur to a target outside the edit form fires the commit.
    fireEvent.blur(baseUrl, { relatedTarget: document.body });
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles[0].base_url).toBe("https://my-gw.example/v1");
    // Edit mode has no Save button.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("an invalid base URL blocks the blur commit with a validation error", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    const baseUrl = await screen.findByLabelText("Base URL");
    fireEvent.change(baseUrl, { target: { value: "ftp://nope" } });
    fireEvent.blur(baseUrl, { relatedTarget: document.body });
    expect(await screen.findByText("Base URL must use http or https.")).toBeInTheDocument();
    expect(onCommitAppConfig).not.toHaveBeenCalled();
  });

  it("add mode holds the profile in memory until the Create button commits it", async () => {
    const { onCommitAppConfig } = renderView();
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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

  it("delete confirms then commits immediately; last profile is guarded", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { onCommitAppConfig } = renderView({ appConfig: twoProfileConfig });
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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

  it("the last profile's delete button is disabled", async () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findAllByText("Anthropic");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("set-active commits immediately and refreshes key status", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { onCommitAppConfig, onRefreshKeyStatus } = renderView({
      appConfig: twoProfileConfig,
    });
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    fireEvent.click(await screen.findByRole("button", { name: "GLM" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set as active" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    expect(onCommitAppConfig.mock.calls[0][0].provider.active_profile).toBe("second");
    expect(onRefreshKeyStatus).toHaveBeenCalled();
  });

  it("set key is immediate IPC and reports upward (ADR-0029 one-shot)", async () => {
    vi.mocked(setProfileKey).mockResolvedValue(true);
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
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
