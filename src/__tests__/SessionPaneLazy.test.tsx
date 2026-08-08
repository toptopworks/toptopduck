import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AppConfig } from "../types/app-config";
import { defaultAppConfig } from "./setup/appConfigFixture";

// Fallback contract tests for the lazy-loaded SessionPane (issue #424).
// The lazy import + Suspense fallback introduce a new observable surface:
// a `<div role="status" aria-busy="true" className="session-pane-lazy-fallback">`
// that renders while the chunk resolves. These tests lock the a11y
// attributes, CSS className hook, and that the fallback appears when a
// session is opened but the chunk has not resolved.

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { buildTauriWindowMock } from "./setup/tauriWindowMock";

vi.mock("@tauri-apps/api/window", () => buildTauriWindowMock().module);

// Keep the lazy promise permanently pending so the Suspense fallback is
// the only thing rendered inside the session pane host.
vi.mock("../session/SessionPane", () => new Promise(() => {}));

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

describe("SessionPane lazy fallback contract (issue #424)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("navigator", { language: "zh-CN" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does NOT render the lazy fallback on cold-start (no open session)", async () => {
    render(<App />);
    // App-config resolves but no session is open -- the Suspense boundary
    // never suspends because openSessions is empty.
    await waitFor(() => expect(screen.getByText(/TOPTOPDuck/i)).toBeInTheDocument());
    expect(document.querySelector(".session-pane-lazy-fallback")).toBeNull();
  });

  it("renders the fallback with role=status + aria-busy + className when a session opens", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/TOPTOPDuck/i)).toBeInTheDocument());

    // Open a session via the sidebar "+ New" button (scoped by class to
    // disambiguate from the cold-start hero's same-label CTA).
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);

    // The fallback div must carry role=status + aria-busy for screen readers
    // and the session-pane-lazy-fallback className for CSS positioning.
    const fallback = await screen.findByRole("status");
    expect(fallback).toHaveAttribute("aria-busy", "true");
    expect(fallback.className).toContain("session-pane-lazy-fallback");
  });

  it("exposes a screen-reader loading label inside the fallback", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/TOPTOPDuck/i)).toBeInTheDocument());
    fireEvent.click(document.querySelector(".sidebar-new-button") as HTMLButtonElement);

    // The sr-only span gives AT users a textual indication of what is loading.
    expect(await screen.findByText("正在加载会话…")).toBeInTheDocument();
  });
});
