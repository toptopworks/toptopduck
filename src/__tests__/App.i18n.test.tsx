import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppConfig } from "../types/app-config";

// Black-box i18n tests (ADR-0052, issue #78 AC). Drives the rendered shell like
// a user and asserts the VISIBLE DOM signal -- translated chrome text -- never
// useLocale internals. Mirrors App.theme.test.tsx's mock-api + stubbed-Tauri
// pattern so the shell renders offline. Covers the three AC pillars: chrome
// translation takes effect, locale toggle persists, corrupt-locale fallback.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

// Platform mock (ADR-0074). Default is "windows" (set in each describe's
// beforeEach); the macOS placement describe overrides to "macos". The Windows
// default keeps the Windows-path suite (Restore glyph flip + onResized
// subscription) valid; the macOS path's own click + dispatch coverage lives in
// src/shell/__tests__/WindowControls.test.tsx.
const { platformMock } = vi.hoisted(() => ({ platformMock: vi.fn<() => string>() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }));

// WindowControls (custom titlebar, ADR-0074) is the sole remaining
// consumer of getCurrentWindow. The shared stub captures the bridge
// handle so the WindowControls behavior tests below can fire clicks,
// emit onResized, and assert on the IPC spies.
import { buildTauriWindowMock, type WindowBridge } from "./setup/tauriWindowMock";

const windowBridge = vi.hoisted<{ current: WindowBridge | null }>(() => ({ current: null }));

vi.mock("@tauri-apps/api/window", () => {
  const { module, bridge } = buildTauriWindowMock();
  windowBridge.current = bridge;
  return module;
});

// appConfigWith lives in the hoisted block so the hoisted api mock factory can
// call it (factories run above imports; only vi.hoisted values are in scope).
const { appConfigWith } = vi.hoisted(() => {
  function appConfigWith(locale: "system" | "zh-CN" | "en-US"): AppConfig {
    return {
      format_version: 2,
      theme: "system" as const,
      locale,
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
      recent_files: [] as string[],
      shell: { sidebar_collapsed: false, rail_collapsed: false, sidebar_grouping: "flat" },
      mcp_servers: { servers: [] },
    };
  }
  return { appConfigWith };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    // The app-level approval channel (issue #297) mounts on App render;
    // inert no-op listeners keep the real Tauri event listen (absent in
    // jsdom) from rejecting unhandled.
    onApprovalRequest: vi.fn(async () => () => {}),
    onApprovalResolved: vi.fn(async () => () => {}),
    respondToolApproval: vi.fn(async () => {}),
    closeSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => "sess-1"),
    listWorkingSet: vi.fn(async () => []),
    activeDataset: vi.fn(async () => null),
    conversation: vi.fn(async () => []),
    readRows: vi.fn(),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: false,
      keychain_fault: null,
    })),
    // Default locale is system; per-test overrides via vi.mocked(...).mockResolvedValue.
    getAppConfig: vi.fn(async () => appConfigWith("system")),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
    recordRecentFile: vi.fn(async () => {}),
  };
});

import App from "../App";
import { getAppConfig, setAppConfig } from "../api";

describe("App i18n (ADR-0052 black-box)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.mockReturnValue("windows");
    // Pin navigator.language to en-US so the "system" preference deterministically
    // resolves to en-US (the host's navigator.language must not sway the tests).
    vi.stubGlobal("navigator", { language: "en-US" });
  });

  it("renders chrome in Chinese when the persisted locale is zh-CN", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("zh-CN"));
    render(<App />);
    // The Settings button label is the visible chrome signal.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    // Window-control aria-labels localize too (ADR-0052 layer-1 chrome).
    expect(screen.getByRole("button", { name: "最小化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("renders chrome in English when the persisted locale is en-US", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("en-US"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument(),
    );
    // Window-control aria-labels localize too (ADR-0052 layer-1 chrome).
    expect(screen.getByRole("button", { name: "Minimize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("resolves system to the OS language (en-US when navigator is en)", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("system"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument(),
    );
  });

  it("persists a locale toggle via Settings (three-state)", async () => {
    // Start from en-US chrome.
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("en-US"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByText("Language")).toBeInTheDocument());

    // Language is now a Select that commits IMMEDIATELY (ADR-0075 case a): open
    // it and pick 简体中文 -- no Save button; the override persists on selection.
    const localeSelect = screen.getByRole("combobox", { name: "Language" });
    fireEvent.pointerDown(localeSelect, { button: 0, pointerType: "mouse" });
    fireEvent.click(localeSelect);
    const zhOption = await screen.findByRole("option", { name: "简体中文" });
    fireEvent.pointerUp(zhOption, { button: 0, pointerType: "mouse" });
    fireEvent.click(zhOption);

    // The locale override persists into app-config (ADR-0038).
    await waitFor(() =>
      expect(setAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({ locale: "zh-CN" }),
      ),
    );
  });

  it("degrades a corrupt persisted locale to system without crashing", async () => {
    // A hand-edited / foreign app-config value must never crash the render --
    // coerceLocalePreference falls back to "system" (then OS -> en-US).
    vi.mocked(getAppConfig).mockResolvedValue({
      ...appConfigWith("system"),
      // @ts-expect-error -- deliberately corrupt wire value
      locale: "zh",
    });
    render(<App />);
    // The app still boots; the Settings button renders in the fallback locale.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument(),
    );
  });

  it("sets <html lang> to match the effective locale for a11y", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("zh-CN"));
    render(<App />);
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
  });
});

describe("App window controls (Windows path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.mockReturnValue("windows");
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("fires the matching window IPC on each control click", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("zh-CN"));
    render(<App />);
    // Wait for the topbar (incl. WindowControls) to mount so the bridge is
    // populated and the buttons are queryable.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    const bridge = windowBridge.current!;
    expect(bridge).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "最小化" }));
    await waitFor(() => expect(bridge.minimize).toHaveBeenCalledTimes(1));
    expect(bridge.toggleMaximize).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "最大化" }));
    await waitFor(() => expect(bridge.toggleMaximize).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(bridge.close).toHaveBeenCalledTimes(1));
  });

  it("renders the Restore label when the window starts maximized", async () => {
    // The mount effect's isMaximized().then(setMaximized) resolves true on
    // the first paint -> the maximize button flips from 最大化 to 还原.
    windowBridge.current!.isMaximized.mockResolvedValueOnce(true);
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("zh-CN"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "还原" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "最大化" })).not.toBeInTheDocument();
  });

  it("flips the glyph in place when onResized reports a maximized state", async () => {
    // Capture the onResized callback the component registered, then emit a
    // resize whose isMaximized read returns true -> the label flips from
    // 最大化 to 还原 without a remount (covers the onResized callback path,
    // distinct from the mount-time isMaximized path above).
    let resized: (() => Promise<void>) | null = null;
    windowBridge.current!.onResized.mockImplementationOnce(async (cb) => {
      resized = cb as () => Promise<void>;
      return () => {};
    });
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("zh-CN"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument(),
    );
    windowBridge.current!.isMaximized.mockResolvedValueOnce(true);
    await act(async () => {
      await resized!();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "还原" })).toBeInTheDocument(),
    );
  });

  it("unsubscribes onResized when the shell unmounts (race-guard cleanup)", async () => {
    // The mount effect's onResized returns Promise<UnlistenFn> that resolves
    // post-mount; cleanup must invoke the resolved unsub. A regression that
    // drops resolvedUnsub?.() leaves an orphan listener after unmount.
    const unsub = vi.fn();
    windowBridge.current!.onResized.mockResolvedValueOnce(unsub);
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("zh-CN"));
    const { unmount } = render(<App />);
    await waitFor(() => expect(windowBridge.current!.onResized).toHaveBeenCalled());
    expect(unsub).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(unsub).toHaveBeenCalledTimes(1));
  });
});

describe("App window-controls platform placement (ADR-0074)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMock.mockReturnValue("macos");
    vi.stubGlobal("navigator", { language: "en-US" });
    // usePlatform() module-caches the platform on first read; the i18n +
    // Windows-path suites above have already latched "windows" by the time
    // this describe runs. resetModules + dynamic re-import of App/api makes
    // use-platform re-read the mocked "macos" value instead of serving the
    // stale cache (mirrors the per-scenario re-import in
    // WindowControls.test.tsx).
    vi.resetModules();
  });

  it("places macOS traffic lights at the topbar LEFT edge (not the right-side cluster)", async () => {
    // ADR-0074: macOS renders <WindowControls /> before SidebarToggle (left
    // edge); Windows/Linux renders it after NavButtons (right edge). This
    // pins the App.tsx positional invariant -- a regression that flips or
    // drops the left-edge branch would otherwise pass every other suite
    // (dispatcher unit tests render the component in isolation, and the
    // Windows-path suite above pins platform to "windows").
    const { default: App } = await import("../App");
    const { getAppConfig } = await import("../api");
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("en-US"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument(),
    );

    const macControls = document.querySelector(".macos-window-controls");
    expect(macControls).not.toBeNull();
    // The macOS container precedes the NavButtons (Back) in DOM order
    // (DOCUMENT_POSITION_FOLLOWING = Back comes after macControls). The
    // reference is a topbar action, not the settings gear: since issue #282
    // the gear rides the session sidebar, which precedes the topbar in DOM
    // order and would invert this positional assertion.
    const back = screen.getByRole("button", { name: "Back" });
    expect(
      (macControls as Element).compareDocumentPosition(back) &
      Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The Windows right-side cluster must NOT also render on macOS.
    expect(document.querySelector(".window-controls")).toBeNull();
  });
});
