import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SettingsView } from "../SettingsView";
import { clearProfileKey, listProviderProfiles, setProfileKey } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import { renderSettings } from "./helpers";

// SettingsView reaches the per-profile keychain surface (issue #153); mock the
// three IPC functions so the view never hits Tauri. listProviderProfiles feeds
// the Profiles pane key-status overlay; setProfileKey/clearProfileKey feed the
// immediate key IPC (ADR-0029 one-shot).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listProviderProfiles: vi.fn(),
    setProfileKey: vi.fn(),
    clearProfileKey: vi.fn(),
  };
});

describe("SettingsView (issue #151, ADR-0065)", () => {
  // A complete app-config fixture; only theme/locale are exercised, the rest
  // round-trips verbatim (the view commits the whole document atomically).
  const baseConfig: AppConfig = {
    format_version: 2,
    theme: "system",
    locale: "system",
    window: { width: 800, height: 600, x: null, y: null, maximized: false },
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
    shell: { sidebar_collapsed: false, rail_collapsed: false },
  };
  const profileKeysDefault = [{ profile_id: "default", has_key: false }];

  // Two-profile config + key overlay: default (Anthropic, active/selected) +
  // second (GLM/openai). Shared by the #153 delete test and the #170
  // selected-state + focus-contract tests so each has a selected vs unselected
  // contrast. active_profile stays "default" so the first row is selected.
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
    { profile_id: "default", has_key: false },
    { profile_id: "second", has_key: false },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue(profileKeysDefault);
  });

  // Issue #153: the General pane renders synchronously (the global loading gate
  // is gone -- the key-status overlay fetch lives inside ProfilesSection, which
  // only mounts when the user switches to Profiles). Tests that stay on General
  // wait on the Theme legend as a render-ready signal.

  it("commits the chosen theme + locale RadioGroup values on save", async () => {
    // The General pane is the default section; its theme + locale radios wire
    // to local state. A save commits them in one atomic app-config write. The
    // rest of the config round-trips unchanged.
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    await screen.findByText("Theme");
    // Switch theme to dark + locale to English via the RadioGroups.
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalledTimes(1));
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.theme).toBe("dark");
    expect(committed.locale).toBe("en-US");
    expect(committed.engine).toEqual(baseConfig.engine);
    expect(committed.provider).toEqual(baseConfig.provider);
  });

  it("Save commits app-config and closes (no key IPC from the view, issue #153)", async () => {
    // Issue #153: key set/clear moved INTO ProfilesSection (immediate per-profile
    // IPC). SettingsView.save() is now a pure app-config write -- it never calls
    // any key IPC. The leave-as-is contract now lives in the Profiles key input
    // (an empty field disables Set), not in the Save path.
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={onClose}
      />,
    );
    await screen.findByText("Theme");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it("prevents ESC exit while saving (atomic-write guard, ADR-0065)", async () => {
    // busy = saving (issue #153 dropped the loading gate). A never-resolving
    // onCommitAppConfig keeps saving true; the window-level ESC listener bails
    // so a mid-save ESC cannot close the view (the atomic write would be torn).
    const onCommitAppConfig = vi
      .fn()
      .mockImplementation(() => new Promise<void>(() => {}));
    const onClose = vi.fn();
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={onClose}
      />,
    );
    await screen.findByText("Theme");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // Confirm the saving state is active before asserting the guard.
    await screen.findByText(/Saving/);
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("ESC exits when not busy (ADR-0065 keyboard exit)", async () => {
    // Without a mask, ESC is the keyboard exit. When not saving, ESC closes the
    // view via the window-level listener.
    const onClose = vi.fn();
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn().mockResolvedValue(undefined)}
        onClose={onClose}
      />,
    );
    await screen.findByText("Theme");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("switches panes via the left nav (ADR-0065)", async () => {
    // The left nav's four buttons swap the right pane; switching does NOT save
    // (no commit until Save). Engine shows the engine fieldset, Privacy shows
    // the disclosure banner, Profiles shows the profile list (issue #153: no
    // longer a placeholder).
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    await screen.findByText("Theme");
    // Default pane is General; switch to Engine.
    fireEvent.click(screen.getByRole("button", { name: "Engine" }));
    expect(screen.getByText("Engine defaults (ADR-0005)")).toBeInTheDocument();
    // Switch to Privacy: the disclosure banner (ADR-0011/0019) mounts.
    fireEvent.click(screen.getByRole("button", { name: "Privacy" }));
    expect(screen.getByRole("note")).toBeInTheDocument();
    // Switch to Profiles: the profile list renders (New profile button present).
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    expect(screen.getByRole("button", { name: "New profile" })).toBeInTheDocument();
    // No save happened during the tour.
    expect(onCommitAppConfig).not.toHaveBeenCalled();
  });

  // --- Profiles pane: master-detail + CRUD + key status (issue #153 ACs) -----

  it("Profiles pane lists profiles with key-status badges (issue #153)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: true },
    ]);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // The single profile shows its display name + the "Key set" badge; the
    // active badge is also present (default is the active profile).
    await screen.findByText("Anthropic");
    expect(screen.getByText("Key set")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("No key")).not.toBeInTheDocument();
  });

  it("creates a new profile via New profile and commits it on save (issue #153)", async () => {
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByRole("button", { name: "New profile" });
    fireEvent.click(screen.getByRole("button", { name: "New profile" }));
    // A second list item appears with the "Unnamed profile" placeholder (the
    // new profile's display_name starts empty).
    expect(screen.getByText("Unnamed profile")).toBeInTheDocument();
    // Save commits the new profile list (2 profiles now).
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    expect(committed.provider.profiles.length).toBe(2);
    // The new profile's id is stable + non-empty (ProfileId minted client-side).
    const created = committed.provider.profiles[1];
    expect(created.id).toBeTruthy();
    expect(created.protocol).toBe("anthropic");
  });

  it("delete opens an AlertDialog and confirming removes the profile (issue #153)", async () => {
    // Start with two profiles so deletion leaves one (the AlertDialog confirm
    // is the AC's accidental-delete guard).
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    renderSettings(
      <SettingsView
        appConfig={twoProfileConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // Scope GLM to the list: the preset dropdown also exposes a "GLM" option, so
    // a global text query is ambiguous once the edit form mounts. findByRole
    // waits for the list to mount (the pane shows "Reading…" until the
    // key-status overlay IPC resolves).
    const profilesList = await screen.findByRole("list", {
      name: "Active profile",
    });
    await within(profilesList).findByText("GLM");
    // Open the delete confirm for the second profile.
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[1]);
    // AlertDialog mounts (destructive confirm: no accidental delete).
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toBeInTheDocument();
    // Confirming scopes to the dialog (the list also has Delete buttons).
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
    );
    // The profile is gone from the list (the preset dropdown still carries a
    // GLM option, so the assertion must scope to the list).
    expect(within(profilesList).queryByText("GLM")).not.toBeInTheDocument();
  });

  it("set key calls setProfileKey and flips the badge to Key set (issue #153)", async () => {
    // Key set is immediate IPC (ADR-0029 one-shot); the returned bool flips the
    // has_key overlay so the badge updates without a re-fetch.
    vi.mocked(setProfileKey).mockResolvedValue(true);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByText("No key");
    // Type a key + click Set key (the default profile is the selected one).
    fireEvent.change(screen.getByPlaceholderText("sk-ant-api03-…"), {
      target: { value: "sk-test-153" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await waitFor(() =>
      expect(vi.mocked(setProfileKey)).toHaveBeenCalledWith("default", "sk-test-153"),
    );
    // The badge flips to "Key set" (the IPC's returned bool updates the overlay).
    await screen.findByText("Key set");
    expect(screen.queryByText("No key")).not.toBeInTheDocument();
  });

  it("edits a profile's display name and commits it on save (issue #153)", async () => {
    // AC#3: display_name is the renamable half of the ADR-0037/0064 split
    // (ProfileId stays immutable). The edit form's Display name field patches
    // the selected profile via updateProfile; Save commits the renamed list in
    // one atomic app-config write.
    const onCommitAppConfig = vi.fn().mockResolvedValue(undefined);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={onCommitAppConfig}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // The default profile is selected by default; its current name shows first.
    await screen.findByText("Anthropic");
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "My Claude" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCommitAppConfig).toHaveBeenCalled());
    const committed = onCommitAppConfig.mock.calls[0][0];
    // display_name updated; the stable id is unchanged (ADR-0037/0064).
    expect(committed.provider.profiles[0].display_name).toBe("My Claude");
    expect(committed.provider.profiles[0].id).toBe("default");
  });

  it("clear key calls clearProfileKey and flips the badge to No key (issue #153)", async () => {
    // AC#4: clear is the symmetric immediate per-profile IPC (ADR-0029 one-shot);
    // the returned bool (false on success) flips the has_key overlay so the badge
    // updates without a re-fetch. Pins the clear path the set-key test does not.
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: true },
    ]);
    vi.mocked(clearProfileKey).mockResolvedValue(false);
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // The default profile starts with a key stored; Clear key is available.
    await screen.findByText("Key set");
    fireEvent.click(screen.getByRole("button", { name: "Clear key" }));
    await waitFor(() => expect(vi.mocked(clearProfileKey)).toHaveBeenCalledWith("default"));
    // The badge flips to "No key" (the IPC's returned bool updates the overlay).
    await screen.findByText("No key");
    expect(screen.queryByText("Key set")).not.toBeInTheDocument();
  });

  it("a failed set-key leaves the badge unchanged and surfaces the error (issue #153, ADR-0029)", async () => {
    // Trust-root guard: if setProfileKey rejects, the has_key overlay MUST NOT
    // flip -- setProfileKeys runs only on the success branch, so the badge stays
    // at "No key", and the failure message reaches the user. A regression that
    // flips the badge optimistically (or drops the try/catch) would let the user
    // believe a key is stored when it is not (ADR-0029 violation).
    vi.mocked(setProfileKey).mockRejectedValue(new Error("keychain locked"));
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByText("No key");
    fireEvent.change(screen.getByPlaceholderText("sk-ant-api03-…"), {
      target: { value: "sk-test-153" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    // The badge stays "No key" (failure must not read as set); the error lands.
    await screen.findByText("keychain locked");
    expect(screen.getByText("No key")).toBeInTheDocument();
    expect(screen.queryByText("Key set")).not.toBeInTheDocument();
  });

  it("Profiles pane surfaces a key-status fetch failure without blocking CRUD (issue #153)", async () => {
    // If list_provider_profiles rejects (a keychain read outage), the pane must
    // render the error rather than silently showing an empty list. The rest of
    // the pane stays usable -- New profile is still enabled (the error is
    // informational, not a hard block on CRUD).
    vi.mocked(listProviderProfiles).mockRejectedValue(
      new Error("keychain unavailable"),
    );
    renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    await screen.findByText("keychain unavailable");
    expect(screen.getByRole("button", { name: "New profile" })).toBeEnabled();
  });

  // --- ADR-0067 (issue #170): visual expression migrated to Tailwind utility
  // + ADR-0050 token on the component. The nav active / list selected / chrome
  // SEMANTICS are unchanged; these pin the className contract so a regression
  // that drops a utility silently reverts to the retired styles.css rules.
  // jsdom has no layout engine, so these are className assertions on the real
  // rendered elements (cf. the Thread rail + Table primitive tests), split
  // (/\s+/) + toContain so `bg-primary` does not match `bg-primary-foreground`
  // etc. The profiles-master-detail <=640px stacking is a CSS @media rule that
  // stays in styles.css (issue #170 AC) and cannot be exercised in jsdom.

  it("settings-nav-button aria-current lifts bg-primary + text-primary-foreground + font-semibold (issue #170)", () => {
    // The active section's nav button carries its aria-current="page" styling
    // as inline utilities over the ADR-0050 token, replacing the retired
    // .settings-nav-button[aria-current="page"] CSS rule. General is the
    // default section so its nav button is the active one on mount.
    const { container } = renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    const active = container.querySelector(`.settings-nav-button[aria-current="page"]`);
    expect(active).not.toBeNull();
    const activeClasses = active?.className.split(/\s+/);
    expect(activeClasses).toContain("bg-primary");
    expect(activeClasses).toContain("text-primary-foreground");
    expect(activeClasses).toContain("font-semibold");
    // An inactive nav button does NOT carry the active utilities.
    const inactive = container.querySelector(
      `.settings-nav-button:not([aria-current="page"])`,
    );
    expect(inactive).not.toBeNull();
    expect(inactive?.className.split(/\s+/)).not.toContain("bg-primary");
  });

  it("profiles-list-item.selected lifts border-border + bg-muted (issue #170)", async () => {
    // The selected profile's list item carries the selected tint as inline
    // utilities, replacing the retired .profiles-list-item.selected CSS rule.
    // The default profile is selected by default; a second profile (when
    // present) is not. Both must render with the base border-transparent so
    // the unselected item reads as a flat row (not an empty bordered slot).
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { container } = renderSettings(
      <SettingsView
        appConfig={twoProfileConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // Wait for the key-status overlay fetch to resolve so the profile rows
    // render (the list is gated on listProviderProfiles resolving).
    await screen.findByText("GLM");
    const selected = container.querySelector(".profiles-list-item.selected");
    expect(selected).not.toBeNull();
    const selectedClasses = selected?.className.split(/\s+/);
    expect(selectedClasses).toContain("border-border");
    expect(selectedClasses).toContain("bg-muted");
    // An unselected item keeps the transparent base border (no bg tint).
    const unselected = container.querySelector(
      `.profiles-list-item:not(.selected)`,
    );
    expect(unselected).not.toBeNull();
    const unselectedClasses = unselected?.className.split(/\s+/);
    expect(unselectedClasses).toContain("border-transparent");
    expect(unselectedClasses).not.toContain("bg-muted");
  });

  it("settings-nav-button keeps [all:unset] + focus-visible outline contract (issue #170)", () => {
    // [all:unset] strips native button chrome so the entry reads as a flat row;
    // the focus-visible outline restores the keyboard ring (WCAG 2.4.7) the
    // reset removed. Pinning both guards against a regression that drops the
    // reset (button regains UA chrome) or the outline (keyboard users lose the
    // focus indicator).
    const { container } = renderSettings(
      <SettingsView
        appConfig={baseConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    const button = container.querySelector(".settings-nav-button");
    expect(button).not.toBeNull();
    const classes = button?.className.split(/\s+/);
    expect(classes).toContain("[all:unset]");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-ring");
    expect(classes).toContain("focus-visible:outline-offset-2");
  });

  it("profiles-list-item-select keeps [all:unset] + focus-visible outline contract (issue #170)", async () => {
    // Mirror of the settings-nav-button contract above: the select button is
    // also [all:unset], so it also needs the explicit focus-visible ring
    // (WCAG 2.4.7). Pinning both guards against a regression that drops the
    // reset or the outline on this twin element.
    vi.mocked(listProviderProfiles).mockResolvedValue(twoProfileKeys);
    const { container } = renderSettings(
      <SettingsView
        appConfig={twoProfileConfig}
        onCommitAppConfig={vi.fn()}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Profiles" }));
    // Wait for the key-status overlay fetch to resolve so the select buttons
    // render (the list is gated on listProviderProfiles resolving).
    await screen.findByText("GLM");
    const select = container.querySelector(".profiles-list-item-select");
    expect(select).not.toBeNull();
    const classes = select?.className.split(/\s+/);
    expect(classes).toContain("[all:unset]");
    expect(classes).toContain("focus-visible:outline-2");
    expect(classes).toContain("focus-visible:outline-ring");
    expect(classes).toContain("focus-visible:outline-offset-2");
  });
});
