import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../types";

// Issue #196: useAppConfigState owns the AppConfig advisory state + every
// mutating action (commitAppConfig, switchActiveProfile, commitShellPrefs via
// the two collapse toggles) + the load / geometry-restore / collapse-restore /
// geometry-persist effects + the locale / intl derived from appConfig.locale.
// These tests pin the contracts hardest to assert through the App black-box
// (Shell.test.tsx): optimistic commitAppConfig, the switchActiveProfile no-op
// guards + refreshKeyStatus kick, the two independent collapse toggles writing
// through commitShellPrefs, and the one-shot collapse restore from persisted
// prefs. importOriginal keeps describeReject real while getAppConfig /
// setAppConfig are stubbed. safeMainWindow() returns null in jsdom
// (getCurrentWindow throws synchronously), so the geometry effects no-op.

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

function baseAppConfig(shell: AppConfig["shell"]): AppConfig {
  return {
    format_version: 1,
    theme: "system",
    locale: "system",
    window: { width: 800, height: 600, x: null, y: null, maximized: false },
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
    tunables: { retry_budget: 3, window_turns: 6, far_window: 12 },
    recent_files: [],
    shell,
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

  it("starts cold: null appConfig, both collapse levels expanded", () => {
    const { result } = renderAppConfigState();
    expect(result.current.appConfig).toBeNull();
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.railCollapsed).toBe(false);
  });

  it("loads app-config once on mount and surfaces it (ADR-0038)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false });
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
    const initial = baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false });
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
    const cfg = baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false });
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
    const cfg = baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false });
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
    const cfg = baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false });
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

  it("toggleSidebarCollapse flips sidebar state + persists both shell prefs (ADR-0054)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    act(() => {
      result.current.toggleSidebarCollapse();
    });

    expect(result.current.sidebarCollapsed).toBe(true);
    expect(result.current.railCollapsed).toBe(false); // rail untouched
    expect(setAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: { sidebar_collapsed: true, rail_collapsed: false },
      }),
    );
  });

  it("toggleRailCollapse flips rail state + persists both shell prefs independently (ADR-0054)", async () => {
    const cfg = baseAppConfig({ sidebar_collapsed: false, rail_collapsed: false });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => expect(result.current.appConfig).toBe(cfg));

    act(() => {
      result.current.toggleRailCollapse();
    });

    expect(result.current.railCollapsed).toBe(true);
    expect(result.current.sidebarCollapsed).toBe(false); // sidebar untouched
    expect(setAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        shell: { sidebar_collapsed: false, rail_collapsed: true },
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
    const cfg = baseAppConfig({ sidebar_collapsed: true, rail_collapsed: true });
    vi.mocked(getAppConfig).mockResolvedValue(cfg);
    const { result } = renderAppConfigState();
    await waitFor(() => {
      expect(result.current.sidebarCollapsed).toBe(true);
      expect(result.current.railCollapsed).toBe(true);
    });
  });
});
