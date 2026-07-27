import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppConfig } from "../types/app-config";

// Black-box App seam tests for the in-app settings overlay (ADR-0065, issue
// #151 ACs). Drives the rendered App like a user: topbar gear opens the view,
// the session shell carries a settings-mode class that hides it underneath
// (still mounted -- keep-alive), ‹ Back / ESC close it, and the open session
// survives the round trip. Mirrors the App black-box pattern (mock api + stub
// the Tauri bridge) so the shell renders offline. Assertions use the
// .settings-mode class + DOM presence rather than computed visibility: jsdom
// does not load styles.css, so .toBeVisible() cannot see the CSS rule that
// hides the session shell (Shell.test.tsx asserts collapse the same way).

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

// WindowControls (custom titlebar) + useAppConfigState (window-geometry
// persistence) both reach getCurrentWindow. Stub the Tauri window bridge so
// jsdom does not hit the real runtime (which reads window.__TAURI metadata and
// crashes the shell-level ErrorBoundary).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(async () => {}),
    maximize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    setPosition: vi.fn(async () => {}),
    setSize: vi.fn(async () => {}),
    innerSize: vi.fn(async () => ({ width: 1024, height: 768 })),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
    onMoved: vi.fn(async () => () => {}),
  }),
  LogicalPosition: class {
    constructor(public x: number, public y: number) {}
  },
  LogicalSize: class {
    constructor(public width: number, public height: number) {}
  },
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    closeSession: vi.fn(async () => {}),
    createSession: vi.fn(async () => "sess-1"),
    listSessions: vi.fn(async () => []),
    listWorkingSet: vi.fn(async () => []),
    activeDataset: vi.fn(async () => null),
    conversation: vi.fn(async () => []),
    readRows: vi.fn(),
    // useSessionState mounts a long-lived listener on SessionPane mount; mock
    // it so opening a session does not reach the real Tauri event bus.
    onTurnProgress: vi.fn(async () => () => {}),
    getProviderConfig: vi.fn(async () => ({
      base_url: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      has_key: true,
    })),
    getAppConfig: vi.fn(async () => null),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
  };
});

import App from "../App";
import { createSession, getAppConfig, setAppConfig } from "../api";

function baseAppConfig(): AppConfig {
  return {
    format_version: 2,
    theme: "system" as const,
    locale: "system" as const,
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
    recent_files: [] as string[],
    shell: { sidebar_collapsed: false, rail_collapsed: false, sidebar_grouping: "flat" },
  };
}

describe("App settings overlay (ADR-0065, issue #151 ACs)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  it("gear stays disabled until appConfig loads (C1 white-screen guard)", async () => {
    // C1 regression: opening settings while appConfig is null white-screens
    // the shell -- .settings-mode hides the session shell but SettingsView
    // does not render (appConfig gate) and its window ESC listener never
    // mounts, leaving no exit. The gear is disabled until appConfig resolves
    // (settingsDisabled = !appConfig), mirroring the SettingsView render
    // condition. getAppConfig never resolves here so appConfig stays null.
    vi.mocked(getAppConfig).mockImplementation(
      () => new Promise<AppConfig>(() => {}),
    );
    render(<App />);
    const gear = screen.getByRole("button", { name: "设置" });
    expect(gear).toBeDisabled();
  });

  it("gear opens the settings overlay and hides the session shell (settingsOpen ternary)", async () => {
    // Topbar gear sets settingsOpen=true; the shell carries .settings-mode so
    // CSS (.shell.settings-mode > :not(.settings-overlay) { display: none })
    // hides session sidebar + topbar underneath. They stay mounted -- keep-alive
    // state survives the round trip.
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    // The overlay mounts and the shell carries the settings-mode class.
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    expect(document.querySelector(".shell")?.classList.contains("settings-mode")).toBe(true);
    // session sidebar + topbar stay in the DOM (keep-alive) -- the .settings-mode
    // class is what hides them via CSS, not an unmount.
    expect(document.querySelector(".session-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".topbar")).toBeInTheDocument();
  });

  it("‹ Back closes the overlay and restores the session shell", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    // ‹ Back to app (zh: ‹ 返回应用).
    fireEvent.click(screen.getByRole("button", { name: /返回应用/ }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).not.toBeInTheDocument(),
    );
    // settings-mode dropped: CSS no longer hides the session shell.
    expect(document.querySelector(".shell")?.classList.contains("settings-mode")).toBe(false);
    expect(document.querySelector(".session-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".topbar")).toBeInTheDocument();
  });

  it("ESC closes the overlay when not busy (ADR-0065 keyboard exit)", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    // Wait for the form's loading state to clear (getProviderConfig resolved)
    // so busy is false and ESC is allowed to close (back button enabled = !busy).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /返回应用/ })).not.toBeDisabled(),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).not.toBeInTheDocument(),
    );
  });

  it("keep-alive session survives a settings round trip (App state untouched)", async () => {
    // Open a session, open settings, return: the session pane stays mounted
    // (its question bar persists in the DOM) and createSession was called once
    // (no re-mint, no resume replay) -- the overlay is a view switch, not a
    // session lifecycle event.
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    // Open a session via the sidebar "+ 新建会话".
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "提问" })).toBeInTheDocument(),
    );
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
    // Open settings.
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    // The session pane stays mounted underneath (keep-alive): its question bar
    // is still in the DOM (query hidden:true since .settings-mode hides it via
    // CSS, which jsdom does not compute but testing-library respects for
    // role queries).
    expect(
      screen.queryByRole("textbox", { name: "提问", hidden: true }),
    ).toBeInTheDocument();
    // Return from settings.
    fireEvent.click(screen.getByRole("button", { name: /返回应用/ }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).not.toBeInTheDocument(),
    );
    // createSession was NOT called a second time -- the session is the same
    // instance, not re-opened. The pane was hidden, not unmounted.
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
  });

  it("Save commits app-config and closes the overlay (atomic write, ADR-0038)", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    // Wait for the form to finish loading (Save enabled = loading done).
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(setAppConfig).toHaveBeenCalledTimes(1));
    // The overlay closed after the successful save.
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).not.toBeInTheDocument(),
    );
  });
});
