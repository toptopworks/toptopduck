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

// WindowControls (custom titlebar, ADR-0074) is the sole remaining
// consumer of getCurrentWindow. The shared stub keeps jsdom off the real
// runtime (which reads window.__TAURI metadata and crashes the shell-level
// ErrorBoundary).
import { buildTauriWindowMock } from "./setup/tauriWindowMock";

vi.mock("@tauri-apps/api/window", () => buildTauriWindowMock().module);

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
      keychain_fault: null,
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
    // CSS (.shell.settings-mode > :not(.settings-overlay):not(.topbar) {
    // display: none }) hides the session sidebar underneath. It stays mounted
    // -- keep-alive state survives the round trip. The topbar itself persists
    // as the window titlebar above the overlay (ADR-0074; its own test below).
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    // The overlay mounts and the shell carries the settings-mode class.
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    expect(document.querySelector(".shell")?.classList.contains("settings-mode")).toBe(true);
    // The session sidebar stays in the DOM (keep-alive) -- the .settings-mode
    // class is what hides it via CSS, not an unmount.
    expect(document.querySelector(".session-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".topbar")).toBeInTheDocument();
  });

  it("settings mode keeps the window titlebar but strips workspace actions (ADR-0074)", async () => {
    // decorations:false makes the topbar the window's ONLY chrome; its window
    // controls + drag region must stay reachable in the settings view too.
    // The workspace actions unmount while settings are open (the rail owns
    // settings chrome), leaving a clean titlebar strip above the overlay.
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    // jsdom's platform fallback is macOS (use-platform), so the traffic
    // lights render on the topbar -- window.* resolve via the zh catalog.
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    // Window controls persist across the view switch...
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最小化" })).toBeInTheDocument();
    // ...the workspace gear does not (the rail carries the dual-state one)...
    expect(screen.queryByRole("button", { name: "设置" })).not.toBeInTheDocument();
    // ...and the topbar keeps its drag region.
    expect(document.querySelector(".topbar [data-tauri-drag-region]")).not.toBeNull();
    // Returning to the workspace restores the workspace actions.
    fireEvent.click(document.querySelector(".settings-back") as HTMLElement);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
  });

  it("‹ Back closes the overlay and restores the session shell", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    // Rail-top "Back to workspace" (zh: 返回工作区); the .settings-back hook
    // class distinguishes it from the gear, which shares its accessible name.
    fireEvent.click(document.querySelector(".settings-back") as HTMLElement);
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
    // No commit is in flight on the General pane, so ESC closes (the close
    // contract blocks only while an IPC is in flight, ADR-0075).
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
    // Return from settings (rail-top back button).
    fireEvent.click(document.querySelector(".settings-back") as HTMLElement);
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).not.toBeInTheDocument(),
    );
    // createSession was NOT called a second time -- the session is the same
    // instance, not re-opened. The pane was hidden, not unmounted.
    expect(vi.mocked(createSession)).toHaveBeenCalledTimes(1);
  });

  it("engine field Save persists app-config without closing (per-field save, ADR-0075)", async () => {
    // The global footer Save is retired (ADR-0075): the engine pane carries four
    // independent per-field Save buttons. Saving one writes app-config and keeps
    // the overlay open (there is no Save-and-close any more).
    vi.mocked(getAppConfig).mockResolvedValue(baseAppConfig());
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() =>
      expect(document.querySelector(".settings-overlay")).toBeInTheDocument(),
    );
    // Navigate to the Engine pane (zh: 引擎) and save the first field.
    fireEvent.click(screen.getByRole("button", { name: "引擎" }));
    fireEvent.click(screen.getAllByRole("button", { name: "保存" })[0]);
    await waitFor(() => expect(setAppConfig).toHaveBeenCalledTimes(1));
    // Per-field save does NOT close the overlay.
    expect(document.querySelector(".settings-overlay")).toBeInTheDocument();
  });
});
