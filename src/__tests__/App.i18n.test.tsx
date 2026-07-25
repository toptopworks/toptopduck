import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// appConfigWith lives in the hoisted block so the hoisted api mock factory can
// call it (factories run above imports; only vi.hoisted values are in scope).
const { appConfigWith } = vi.hoisted(() => {
  function appConfigWith(locale: "system" | "zh-CN" | "en-US"): AppConfig {
    return {
      format_version: 2,
      theme: "system" as const,
      locale,
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
  });

  it("renders chrome in English when the persisted locale is en-US", async () => {
    vi.mocked(getAppConfig).mockResolvedValue(appConfigWith("en-US"));
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument(),
    );
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

    // Scope to the locale fieldset: the theme fieldset ALSO has a "Follow system"
    // radio, so an unscoped name query is ambiguous.
    const localeGroup = screen.getByRole("group", { name: "Language" });
    fireEvent.click(within(localeGroup).getByRole("radio", { name: "简体中文" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

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
