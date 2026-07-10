import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppConfig, Theme } from "../types";

// Black-box theme tests (ADR-0050, issue #77 AC6). Drives the rendered shell
// like a user and asserts the VISIBLE DOM signal -- the .dark class on <html> --
// never useTheme internals. Mirrors the App black-box pattern (mock api + stub
// the Tauri bridge) so the shell renders offline.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

// appConfigWith lives in the hoisted block so the hoisted api mock factory can
// call it (factories run above imports; only vi.hoisted values are in scope).
const { appConfigWith } = vi.hoisted(() => {
  function appConfigWith(theme: "system" | "light" | "dark") {
    return {
      format_version: 1,
      theme,
      window: { width: 800, height: 600, x: null, y: null, maximized: false },
      engine: { memory_limit: "512MB", threads: 1, row_cap: 100, statement_timeout_ms: 30000 },
      privacy: { send_samples: true },
      provider: { base_url: "https://api.anthropic.com", model: "claude-sonnet-4-6" },
      export: { last_dir: null, default_format: "csv" },
      tunables: { retry_budget: 3, window_turns: 6, far_window: 12 },
      recent_files: [] as string[],
    };
  }
  return { appConfigWith };
});

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
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
    })),
    // Default theme is system; per-test overrides via vi.mocked(...).mockResolvedValue.
    getAppConfig: vi.fn(async () => appConfigWith("system")),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
    recordRecentFile: vi.fn(async () => {}),
  };
});

import App from "../App";
import { getAppConfig, setAppConfig } from "../api";

// jsdom has no matchMedia; install a stub that reports a fixed OS preference so
// the "system" mode test can script the OS dark case.
function installMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", () => ({
    matches,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

describe("App theme (ADR-0050 black-box)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores a persisted dark preference as the .dark class on <html>", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("dark"));
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
  });

  it("restores a persisted light preference with no .dark class", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("light"));
    render(<App />);
    // The app-config load is async; assert the class STAYS absent once settled
    // (the mount default is also light, so wait for the settings button to land
    // before asserting -- a dark flash would have shown by then).
    await waitFor(() => expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument());
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the OS dark preference when the stored preference is system", async () => {
    installMatchMedia(true); // OS prefers dark
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("system"));
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
  });

  it("toggles to dark via Settings and persists the override (three-state)", async () => {
    // Start from a persisted light preference (no .dark).
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("light"));
    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    // Wait for the dialog fields to mount (loading finishes).
    await waitFor(() => expect(screen.getByText("主题")).toBeInTheDocument());

    // Select the dark option (radio accessible name = the label text).
    fireEvent.click(screen.getByRole("radio", { name: "深色" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    // The override persists into app-config (ADR-0038) and applies live.
    await waitFor(() =>
      expect(setAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "dark" }),
      ),
    );
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
  });

  it("toggles to system via Settings and clears .dark when the OS is light", async () => {
    // Start from a persisted dark preference (.dark applied), OS light.
    installMatchMedia(false);
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("dark"));
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );

    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => expect(screen.getByText("主题")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "跟随系统" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(setAppConfig).toHaveBeenCalledWith(
        expect.objectContaining({ theme: "system" as Theme }),
      ),
    );
    // System + OS light resolves to light, so .dark clears.
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(false),
    );
  });
});
