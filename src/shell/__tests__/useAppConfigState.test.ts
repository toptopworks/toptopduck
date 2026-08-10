import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../types/app-config";

// Issue #196: useAppConfigState owns the AppConfig advisory state + every
// mutating action (commitAppConfig, switchActiveProfile, commitShellPrefs via
// the two collapse toggles) + the load / collapse-restore effects + the
// locale / intl derived from appConfig.locale. These tests pin the contracts
// hardest to assert through the App black-box (Shell.test.tsx): optimistic
// commitAppConfig, the switchActiveProfile no-op guards + refreshKeyStatus
// kick, the two independent collapse toggles writing through commitShellPrefs,
// and the one-shot collapse restore from persisted prefs. The api mock stubs
// getAppConfig / setAppConfig; the switchActiveProfile reject path runs the
// real toAppError (imported from lib/error-presentation, outside the api
// mock). Window geometry persistence moved to tauri_plugin_window_state
// (issue #268), so this hook no longer touches the window -- no jsdom
// window-bridge caveats apply.

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    // Hold pending by default so appConfig stays at its null initial (the null
    // is the React useState initial, NOT an IPC return -- getAppConfig's real
    // signature is Promise<AppConfig>). Tests that need a resolved config
    // override with mockResolvedValue(cfg).
    getAppConfig: vi.fn(() => new Promise<AppConfig>(() => {})),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
  };
});

import { getAppConfig, setAppConfig } from "../../api";
import { useAppConfigState } from "../useAppConfigState";

function baseAppConfig(shell: Pick<AppConfig["shell"], "sidebar_collapsed">): AppConfig {
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
    // The helper fills `sidebar_grouping: "flat"` (the serde default) so callers
    // stay focused on the collapse prefs they actually exercise. Grouping-specific
    // tests build their own AppConfig literal with the mode under test.
    shell: { ...shell, sidebar_grouping: "flat" },
    mcp_servers: { servers: [] },
    sessions_dir: null,
  };
}

function renderAppConfigState() {
  const refreshKeyStatus = vi.fn(async () => {});
  const setShellError = vi.fn();
  const helpers = renderHook(() =>
    useAppConfigState({ setShellError, refreshKeyStatus }),
  );
  return { ...helpers, refreshKeyStatus, setShellError };
}

describe("useAppConfigState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Hold pending so appConfig stays null (its useState initial) unless a test
    // overrides with a resolved config.
    vi.mocked(getAppConfig).mockImplementation(
      () => new Promise<AppConfig>(() => {}),
    );
    // clearAllMocks clears call history but NOT impl overrides, so re-pin the
    // factory default -- the optimistic test below swaps in a controlled
    // resolver that would otherwise leak as a never-resolving promise.
    vi.mocked(setAppConfig).mockImplementation(async (cfg: AppConfig) => cfg);
  });

  it("starts cold: null appConfig, sidebar expanded, grouping flat", () => {
    const { result } = renderAppConfigState();
    expect(result.current.appConfig).toBeNull();
    expect(result.current.sidebarCollapsed).toBe(false);
    // ADR-0072 (#251): grouping defaults to flat until the persisted pref
    // resolves (the restore effect's one-shot then applies the stored value).
    expect(result.current.sidebarGrouping).toBe("flat");
  });

  it("loads app-config once on mount and surfaces it (ADR-0038)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));
    expect(getAppConfig).toHaveBeenCalledTimes(1);
  });

  it("kicks refreshKeyStatus once on mount so the header key indicator lands", async () => {
    const { refreshKeyStatus } = renderAppConfigState();
    await waitFor(() => expect(refreshKeyStatus).toHaveBeenCalledTimes(1));
  });

  it("commitAppConfig writes optimistically: state flips before the IPC resolves (ADR-0068)", async () => {
    // Pin the optimistic contract: setAppConfigState fires BEFORE the IPC
    // await, so the state has already flipped while the IPC is still pending.
    // Hold setAppConfig pending on a controlled resolver so the pre-resolve
    // state is observable (result.current only updates on re-render, so a
    // synchronous read right after the call would miss the flip).
    const initial = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(initial);
    let resolveIpc!: (cfg: AppConfig) => void;
    vi.mocked(setAppConfig).mockImplementation(
      () => new Promise<AppConfig>((r) => {
        resolveIpc = r;
      }),
    );
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(initial));

    const next: AppConfig = { ...initial, theme: "dark" };
    let commitDone = false;
    act(() => {
      void result.current.commitAppConfig(next).then(() => {
        commitDone = true;
      });
    });
    // State has already flipped BEFORE the IPC resolved + the commit resolved.
    await waitFor(() => expect(result.current.appConfig).toEqual(next));
    expect(commitDone).toBe(false);
    expect(setAppConfig).toHaveBeenCalledWith(next);

    // Releasing the IPC lets the commit resolve.
    await act(async () => {
      resolveIpc(next);
    });
    expect(commitDone).toBe(true);
  });

  it("switchActiveProfile is a no-op before app-config resolves (null guard)", async () => {
    const { result, refreshKeyStatus } = renderAppConfigState();
    expect(result.current.appConfig).toBeNull();
    await act(async () => {
      await result.current.switchActiveProfile("any");
    });
    expect(setAppConfig).not.toHaveBeenCalled();
    expect(refreshKeyStatus).toHaveBeenCalledTimes(1); // mount-only
  });

  it("switchActiveProfile is a no-op when the id matches the active profile", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result, refreshKeyStatus } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));
    await act(async () => {
      await result.current.switchActiveProfile("default");
    });
    expect(setAppConfig).not.toHaveBeenCalled();
    expect(refreshKeyStatus).toHaveBeenCalledTimes(1); // mount-only
  });

  it("switchActiveProfile commits the new active_profile + kicks refreshKeyStatus (#154)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result, refreshKeyStatus } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    await act(async () => {
      await result.current.switchActiveProfile("other");
    });

    expect(setAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({ active_profile: "other" }),
      }),
    );
    // Mount kick + the post-switch kick.
    expect(refreshKeyStatus).toHaveBeenCalledTimes(2);
  });

  it("switchActiveProfile surfaces a setAppConfig reject via setShellError (no rollback)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    vi.mocked(setAppConfig).mockRejectedValueOnce(new Error("ipc down"));
    const { result, setShellError, refreshKeyStatus } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    await act(async () => {
      await result.current.switchActiveProfile("other");
    });

    expect(setShellError).toHaveBeenCalledTimes(1);
    // The post-switch refreshKeyStatus kick is inside the try block after the
    // await, so a reject skips it -- the count stays at the mount-only 1
    // (pins the ordering vs the happy-path 2-kick case).
    expect(refreshKeyStatus).toHaveBeenCalledTimes(1);
    // Optimistic write does NOT roll back: state keeps the new active_profile
    // even though the IPC failed (ADR-0068: live_config reads disk truth next).
    expect(result.current.appConfig?.provider.active_profile).toBe("other");
  });

  // --- switchActiveProfileModel (issue #238, ADR-0071) ---------------------
  // Sibling action to switchActiveProfile: writes profile.model onto the ACTIVE
  // profile via commitAppConfig (model is per-profile, not a global -- ADR-0064).
  // No refreshKeyStatus kick: the profile id is unchanged, so the keychain slot
  // the header indicator reads is unchanged (ADR-0029).

  it("switchActiveProfileModel is a no-op before app-config resolves (null guard)", async () => {
    const { result, refreshKeyStatus } = renderAppConfigState();
    expect(result.current.appConfig).toBeNull();
    await act(async () => {
      await result.current.switchActiveProfileModel("any-model");
    });
    expect(setAppConfig).not.toHaveBeenCalled();
    expect(refreshKeyStatus).toHaveBeenCalledTimes(1); // mount-only
  });

  it("switchActiveProfileModel is a no-op when the model matches", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result, refreshKeyStatus } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));
    // The active profile "default" already has model "claude-sonnet-4-6".
    await act(async () => {
      await result.current.switchActiveProfileModel("claude-sonnet-4-6");
    });
    expect(setAppConfig).not.toHaveBeenCalled();
    expect(refreshKeyStatus).toHaveBeenCalledTimes(1); // mount-only
  });

  it("switchActiveProfileModel patches only the active profile's model (ADR-0071)", async () => {
    // Two profiles so the immutability + active-only assertions are meaningful:
    // only "default" (active) gets the new model; "glm" is untouched, and the
    // active pointer does NOT move (ADR-0064: model is per-profile).
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    const twoProfileCfg: AppConfig = {
      ...cfg,
      provider: {
        active_profile: "default",
        profiles: [
          cfg.provider.profiles[0],
          {
            id: "glm",
            display_name: "GLM",
            protocol: "openai",
            base_url: "https://open.bigmodel.cn/api/paas/v4",
            model: "glm-4",
          },
        ],
      },
    };
    vi.mocked(getAppConfig).mockResolvedValue(twoProfileCfg);
    const { result, refreshKeyStatus } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(twoProfileCfg));

    await act(async () => {
      await result.current.switchActiveProfileModel("claude-haiku-4-5");
    });

    expect(setAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: expect.objectContaining({
          active_profile: "default", // unchanged
          profiles: [
            expect.objectContaining({ id: "default", model: "claude-haiku-4-5" }),
            expect.objectContaining({ id: "glm", model: "glm-4" }), // untouched
          ],
        }),
      }),
    );
    // The optimistic state flipped to the new model on the active profile.
    const written = vi.mocked(setAppConfig).mock.calls.at(-1)?.[0];
    expect(written?.provider.profiles).toHaveLength(2);
    // A model swap does NOT touch the keychain slot -> no refreshKeyStatus kick
    // beyond the mount-only one (contrast switchActiveProfile's 2-kick happy path).
    expect(refreshKeyStatus).toHaveBeenCalledTimes(1);
  });

  it("switchActiveProfileModel surfaces a reject via setShellError (no rollback)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    vi.mocked(setAppConfig).mockRejectedValueOnce(new Error("ipc down"));
    const { result, setShellError } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    await act(async () => {
      await result.current.switchActiveProfileModel("claude-haiku-4-5");
    });

    expect(setShellError).toHaveBeenCalledTimes(1);
    // Optimistic write does NOT roll back (ADR-0068): the active profile keeps
    // the new model even though the IPC failed.
    expect(result.current.appConfig?.provider.profiles[0].model).toBe(
      "claude-haiku-4-5",
    );
  });

  it("toggleSidebarCollapse flips sidebar state + persists both shell prefs (ADR-0054)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    act(() => {
      result.current.toggleSidebarCollapse();
    });

    expect(result.current.sidebarCollapsed).toBe(true);
    expect(setAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        // Nested objectContaining: the commit also carries the current
        // sidebar_grouping (#251), which these collapse-only tests stay
        // agnostic to.
        shell: expect.objectContaining({ sidebar_collapsed: true }),
      }),
    );
  });

  it("toggleSidebarCollapse is a no-op persist before app-config resolves (ref null)", async () => {
    // appConfigRef.current is null until the load effect resolves, so the toggle
    // flips the UI state but does not call setAppConfig (the ref guard short-
    // circuits). Mirrors the App invariants in Shell.test.tsx.
    const { result } = renderAppConfigState();
    expect(result.current.appConfig).toBeNull();

    act(() => {
      result.current.toggleSidebarCollapse();
    });

    expect(result.current.sidebarCollapsed).toBe(true);
    expect(setAppConfig).not.toHaveBeenCalled();
  });

  it("restores persisted collapse prefs once on the first app-config resolve (ADR-0038/0054)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: true });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => {
      expect(result.current.sidebarCollapsed).toBe(true);
    });
  });

  // --- sidebarGrouping (ADR-0072, issue #251) ------------------------------
  // Sibling surface to the two collapse prefs: the flat/time mode persists +
  // restores via the same one-shot effect, and switchSidebarGrouping commits
  // immediately through commitShellPrefs (single IPC write of all three shell
  // prefs). The optimistic + no-rollback contract is commitAppConfig's.

  it("switchSidebarGrouping is a no-op persist before app-config resolves (ref null)", async () => {
    const { result } = renderAppConfigState();
    expect(result.current.appConfig).toBeNull();

    act(() => {
      result.current.switchSidebarGrouping("time");
    });

    // UI state flips (the visible effect lands), but the ref guard short-
    // circuits the IPC write -- mirrors toggleSidebarCollapse's pre-resolve
    // contract.
    expect(result.current.sidebarGrouping).toBe("time");
    expect(setAppConfig).not.toHaveBeenCalled();
  });

  it("switchSidebarGrouping is a no-op when the mode matches", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));
    // The persisted default is flat; switching to flat is a no-op.
    expect(result.current.sidebarGrouping).toBe("flat");

    act(() => {
      result.current.switchSidebarGrouping("flat");
    });

    expect(setAppConfig).not.toHaveBeenCalled();
  });

  it("switchSidebarGrouping flips grouping + persists all three shell prefs (ADR-0072)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    act(() => {
      result.current.switchSidebarGrouping("time");
    });

    expect(result.current.sidebarGrouping).toBe("time");
    // Single IPC write of all three shell prefs: collapse prefs unchanged, the
    // new mode carried alongside (ADR-0072 Consequences).
    expect(setAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: expect.objectContaining({
          sidebar_collapsed: false,
          sidebar_grouping: "time",
        }),
      }),
    );
  });

  it("toggleSidebarCollapse carries the current grouping into the shell write (ADR-0072)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    act(() => {
      result.current.switchSidebarGrouping("time");
    });
    act(() => {
      result.current.toggleSidebarCollapse();
    });

    expect(result.current.sidebarCollapsed).toBe(true);
    // The collapse-toggle's commit must carry the grouping the user just
    // switched to (single IPC write of all three prefs -- the grouping does
    // not silently revert to flat on a collapse toggle).
    expect(setAppConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        shell: expect.objectContaining({
          sidebar_collapsed: true,
          sidebar_grouping: "time",
        }),
      }),
    );
  });

  it("restores persisted grouping once on the first app-config resolve (ADR-0038/0072)", async () => {
    const cfg: AppConfig = {
      ...baseAppConfig({ sidebar_collapsed: false }),
      shell: { sidebar_collapsed: false, sidebar_grouping: "time" },
    };
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.sidebarGrouping).toBe("time"));
  });
});
