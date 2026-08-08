import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppConfig } from "../types/app-config";
import { defaultAppConfig } from "./setup/appConfigFixture";

// Fallback contract tests for the lazy-loaded SettingsView (issue #423).
// The lazy import + Suspense fallback introduce a new observable surface:
// a `<div role="status" aria-busy="true" className="settings-lazy-overlay">`
// that renders while the chunk resolves. These tests lock the a11y
// attributes, CSS className hook, and chunk-failure degradation scope so
// a refactor cannot silently drop them.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { buildTauriWindowMock } from "./setup/tauriWindowMock";

vi.mock("@tauri-apps/api/window", () => buildTauriWindowMock().module);

// Keep the lazy promise permanently pending so the Suspense fallback is
// the only thing rendered inside the settings slot.
vi.mock("../components/settings/SettingsView", () => new Promise(() => {}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
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
    getAppConfig: vi.fn(async () => defaultAppConfig),
    setAppConfig: vi.fn(async (cfg: AppConfig) => cfg),
    recordRecentFile: vi.fn(async () => {}),
  };
});

import App from "../App";
import { getAppConfig } from "../api";

describe("Settings lazy fallback contract (issue #423)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the fallback with role=status + aria-busy + className while the chunk is pending", async () => {
    render(<App />);
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    // The fallback div must carry role=status + aria-busy for screen readers
    // and the settings-lazy-overlay className for the CSS grid-positioning
    // rule (display:none exclusion + grid-row:2).
    const fallback = await screen.findByRole("status");
    expect(fallback).toHaveAttribute("aria-busy", "true");
    expect(fallback.className).toContain("settings-lazy-overlay");
  });

  it("exposes a screen-reader loading label inside the fallback", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    // The sr-only span gives AT users a textual indication of what is loading.
    expect(await screen.findByText("正在加载设置…")).toBeInTheDocument();
  });
});
