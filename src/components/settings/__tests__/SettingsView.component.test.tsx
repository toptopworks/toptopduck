import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SettingsView } from "../SettingsView";
import { listProviderProfiles, setProfileKey } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
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
  };
});

// The single write path the view awaits; typed so a commit mock is assignable to
// the onCommitAppConfig prop and its .mock.calls stay typed.
type CommitFn = (cfg: AppConfig) => Promise<void>;

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
    tunables: { retry_budget: 3, window_turns: 10, far_window: 30 },
    recent_files: [],
    shell: { sidebar_collapsed: false, rail_collapsed: false, sidebar_grouping: "flat" },
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
  });

  // Shared render harness: SettingsView now requires the key-status seam
  // (keyStatus for the rail connection row) + onRefreshKeyStatus (set-active
  // refresh). Returns the RTL result (container etc.) + the seam mocks.
  function renderView({
    appConfig = baseConfig,
    onCommitAppConfig = vi.fn<CommitFn>().mockResolvedValue(undefined),
    onClose = vi.fn(),
    onRefreshKeyStatus = vi.fn(),
    keyStatus = { has_key: true, keychain_fault: null },
  }: {
    appConfig?: AppConfig;
    onCommitAppConfig?: Mock<CommitFn>;
    onClose?: () => void;
    onRefreshKeyStatus?: () => void;
    keyStatus?: { has_key: boolean; keychain_fault: string | null };
  } = {}) {
    const result = renderSettings(
      <SettingsView
        appConfig={appConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={onClose}
        onRefreshKeyStatus={onRefreshKeyStatus}
        keyStatus={keyStatus}
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
    // No global Save button exists on the General pane.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("a failed immediate commit surfaces an inline error (revert-on-fail)", async () => {
    const onCommitAppConfig = vi.fn<CommitFn>().mockRejectedValue(new Error("disk full"));
    renderView({ onCommitAppConfig });
    openSelect(screen.getByRole("combobox", { name: "Theme" }));
    chooseOption("Dark");
    expect(await screen.findByText("disk full")).toBeInTheDocument();
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
});
