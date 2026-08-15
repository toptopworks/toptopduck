import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { RuntimeSection } from "../RuntimeSection";
import {
  listAdapters,
  rescanAdapters,
  listProviderProfiles,
} from "../../../api";
import type { AdapterEntry } from "../../../types/runtime";
import type { ProviderConfig } from "../../../types/provider";
import type { ProfilesControls } from "../ProfilesSection";
import { renderSettings } from "./helpers";

// Runtime section tests (issue #489, ADR-0091): the two sub-tabs, the adapter
// list rendering, the rescan IPC flow, and WAI-ARIA APG keyboard navigation.
// The ProfilesSection's own behavior is covered by SettingsView.component.test;
// here we assert ONLY the new runtime-section surface.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listAdapters: vi.fn(),
    rescanAdapters: vi.fn(),
    listProviderProfiles: vi.fn(),
    probeAdapter: vi.fn(),
  };
});

const mockAdapters: AdapterEntry[] = [
  { id: "claude-code", display_name: "claude-code", detected: true, binary_path: "/usr/local/bin/claude", stream_format: "acp" },
  { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/bin/gemini", stream_format: "acp" },
  { id: "codex", display_name: "codex", detected: false, binary_path: null, stream_format: "json_event_stream" },
  { id: "qwen-code", display_name: "qwen-code", detected: false, binary_path: null, stream_format: "acp" },
  { id: "opencode", display_name: "opencode", detected: true, binary_path: "/opt/homebrew/bin/opencode", stream_format: "acp" },
];

const provider: ProviderConfig = {
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
};

function renderSection(overrides: Partial<React.ComponentProps<typeof RuntimeSection>> = {}) {
  const controlsRef = { current: null as ProfilesControls | null } as React.MutableRefObject<ProfilesControls | null>;
  const props: React.ComponentProps<typeof RuntimeSection> = {
    provider,
    onCommit: vi.fn(),
    onIpcBusy: vi.fn(),
    profilesControlsRef: controlsRef,
    ...overrides,
  };
  return renderSettings(<RuntimeSection {...props} />);
}

describe("RuntimeSection (issue #489, ADR-0091)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(rescanAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(listProviderProfiles).mockResolvedValue([
      { profile_id: "default", has_key: false, keychain_fault: null },
    ]);
  });

  // --- Tab infrastructure -------------------------------------------------

  it("renders both tab buttons with the default API Access tab active", () => {
    renderSection();
    const apiTab = screen.getByRole("tab", { name: "API Access" });
    const cliTab = screen.getByRole("tab", { name: "Local CLI" });
    expect(apiTab).toHaveAttribute("aria-selected", "true");
    expect(cliTab).toHaveAttribute("aria-selected", "false");
  });

  it("shows ProfilesSection content (New profile button) under the default tab", async () => {
    renderSection();
    expect(await screen.findByRole("button", { name: "New profile" })).toBeInTheDocument();
  });

  it("switches to Local CLI tab on click and shows the adapter list", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    // The adapter list is rendered from the mock data.
    expect(await screen.findByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("gemini-cli")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
  });

  it("tab state resets to API Access on remount (not persisted)", async () => {
    // RuntimeSection unmounts on a nav switch; remounting must land on the
    // default tab (issue #489 AC: tab state does not persist).
    const { unmount } = renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    expect(screen.getByRole("tab", { name: "Local CLI" })).toHaveAttribute("aria-selected", "true");
    unmount();

    renderSection();
    expect(screen.getByRole("tab", { name: "API Access" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Local CLI" })).toHaveAttribute("aria-selected", "false");
  });

  it("honors initialRuntimeTab as the landing tab when provided", () => {
    // Issue #490: the composer picker's entry hints thread through to this
    // one-shot prop. Passing "local-cli" must land on the Local CLI tab.
    renderSection({ initialRuntimeTab: "local-cli" });
    expect(screen.getByRole("tab", { name: "Local CLI" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "API Access" })).toHaveAttribute("aria-selected", "false");
  });

  it("falls back to API Access when initialRuntimeTab is undefined", () => {
    renderSection();
    expect(screen.getByRole("tab", { name: "API Access" })).toHaveAttribute("aria-selected", "true");
  });

  // --- WAI-ARIA APG keyboard navigation -----------------------------------

  it("active tab has tabIndex 0, inactive has -1 (roving tabindex)", () => {
    renderSection();
    expect(screen.getByRole("tab", { name: "API Access" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Local CLI" })).toHaveAttribute("tabindex", "-1");
  });

  it("tabs have aria-controls pointing to their panel ids", () => {
    renderSection();
    const apiTab = screen.getByRole("tab", { name: "API Access" });
    const cliTab = screen.getByRole("tab", { name: "Local CLI" });
    const apiPanelId = apiTab.getAttribute("aria-controls");
    const cliPanelId = cliTab.getAttribute("aria-controls");
    expect(apiPanelId).toBeTruthy();
    expect(cliPanelId).toBeTruthy();
    expect(apiPanelId).not.toBe(cliPanelId);
    // The referenced panels exist and have the matching id.
    expect(document.getElementById(apiPanelId!)).toHaveAttribute("role", "tabpanel");
    expect(document.getElementById(cliPanelId!)).toHaveAttribute("role", "tabpanel");
  });

  it("ArrowRight moves focus from API Access to Local CLI", async () => {
    renderSection();
    const apiTab = screen.getByRole("tab", { name: "API Access" });
    apiTab.focus();
    expect(apiTab).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Local CLI" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Local CLI" })).toHaveAttribute("aria-selected", "true");
  });

  it("ArrowLeft moves focus from Local CLI back to API Access", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    const cliTab = screen.getByRole("tab", { name: "Local CLI" });
    cliTab.focus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "API Access" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "API Access" })).toHaveAttribute("aria-selected", "true");
  });

  // --- Adapter list rendering ---------------------------------------------

  it("detected adapters show the binary path", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    expect(await screen.findByText("/usr/local/bin/claude")).toBeInTheDocument();
    expect(screen.getByText("/usr/bin/gemini")).toBeInTheDocument();
    expect(screen.getByText("/opt/homebrew/bin/opencode")).toBeInTheDocument();
  });

  it("detected adapters show a Detected badge, undetected show Not installed", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    await screen.findByText("claude-code");
    expect(screen.getAllByText("Detected")).toHaveLength(3);
    expect(screen.getAllByText("Not installed")).toHaveLength(2);
  });

  // --- Adapter list loading + error states --------------------------------

  it("shows a loading indicator while the adapter list is pending", async () => {
    let resolveList!: (v: AdapterEntry[]) => void;
    vi.mocked(listAdapters).mockImplementation(
      () => new Promise((resolve) => { resolveList = resolve; }),
    );

    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    expect(await screen.findByText("Reading current config…")).toBeInTheDocument();

    resolveList(mockAdapters);
    await waitFor(() => expect(screen.getByText("claude-code")).toBeInTheDocument());
  });

  it("surfaces an inline error when the initial adapter list fails to load", async () => {
    vi.mocked(listAdapters).mockRejectedValue(new Error("IPC connection lost"));

    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    expect(await screen.findByText("IPC connection lost")).toBeInTheDocument();
  });

  // --- Rescan IPC flow ----------------------------------------------------

  it("rescan button calls rescanAdapters and refreshes the list", async () => {
    const freshAdapters: AdapterEntry[] = [
      ...mockAdapters.slice(0, 2), // still detected
      { id: "codex", display_name: "codex", detected: true, binary_path: "/usr/bin/codex", stream_format: "json_event_stream" }, // now detected
      ...mockAdapters.slice(3),
    ];
    vi.mocked(rescanAdapters).mockResolvedValue(freshAdapters);

    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    await screen.findByText("claude-code");
    // codex is initially undetected.
    expect(screen.getAllByText("Not installed")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Rescan adapters" }));
    await waitFor(() => expect(vi.mocked(rescanAdapters)).toHaveBeenCalledTimes(1));
    // After rescan, codex is detected and its binary path appears.
    await waitFor(() => expect(screen.getByText("/usr/bin/codex")).toBeInTheDocument());
    // Only qwen-code remains undetected.
    expect(screen.getAllByText("Not installed")).toHaveLength(1);
  });

  it("rescan button is disabled and spins while in flight", async () => {
    let resolveRescan!: (v: AdapterEntry[]) => void;
    vi.mocked(rescanAdapters).mockImplementation(
      () => new Promise((resolve) => { resolveRescan = resolve; }),
    );

    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    await screen.findByText("claude-code");

    const rescanButton = screen.getByRole("button", { name: "Rescan adapters" });
    fireEvent.click(rescanButton);
    await waitFor(() => expect(vi.mocked(rescanAdapters)).toHaveBeenCalled());
    expect(rescanButton).toBeDisabled();

    // The spinning icon is present (animate-spin class).
    const spinIcon = rescanButton.querySelector(".animate-spin");
    expect(spinIcon).not.toBeNull();

    resolveRescan(mockAdapters);
    await waitFor(() => expect(rescanButton).not.toBeDisabled());
  });

  it("a failed rescan surfaces an inline error", async () => {
    vi.mocked(rescanAdapters).mockRejectedValue(new Error("scan timeout"));

    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));
    await screen.findByText("claude-code");

    fireEvent.click(screen.getByRole("button", { name: "Rescan adapters" }));
    expect(await screen.findByText("scan timeout")).toBeInTheDocument();
  });

  // --- PaneHeader ---------------------------------------------------------

  it("renders the section-level PaneHeader above the tabs", () => {
    renderSection();
    // The hero heading is above the tabs.
    const heading = screen.getByRole("heading", { level: 3, name: "Runtime" });
    expect(heading).toBeInTheDocument();
    // The tabs are below it (they exist alongside the heading).
    expect(screen.getByRole("tab", { name: "API Access" })).toBeInTheDocument();
  });

  // --- Edge cases (issue #493) --------------------------------------------

  it("renders an empty adapter list without crashing and keeps Rescan available", async () => {
    // listAdapters returns [] -- no adapter rows should appear, but the Rescan
    // button must stay present + enabled.
    vi.mocked(listAdapters).mockResolvedValue([]);

    renderSection();
    fireEvent.click(screen.getByRole("tab", { name: "Local CLI" }));

    // Wait for the loading state to clear (the title is always rendered).
    expect(await screen.findByText("Detected CLI adapters")).toBeInTheDocument();
    // No adapter display names or badges leak through.
    expect(screen.queryByText("Detected")).not.toBeInTheDocument();
    expect(screen.queryByText("Not installed")).not.toBeInTheDocument();
    // Rescan is present + not disabled.
    const rescanButton = screen.getByRole("button", { name: "Rescan adapters" });
    expect(rescanButton).toBeEnabled();
  });

  it("keeps the Refresh key status button in the profile-list toolbar when hideHeader is active", async () => {
    // RuntimeSection always passes hideHeader to ProfilesSection, so the refresh
    // button must relocate from the PaneHeader action slot to the profile-list
    // toolbar and remain findable + clickable (issue #489/#493). The button is
    // disabled while the initial key-status fetch is in flight (keysLoading);
    // findByRole waits for it to settle + become enabled.
    renderSection();
    const refreshButton = await screen.findByRole("button", { name: "Refresh key status" });
    await waitFor(() => expect(refreshButton).toBeEnabled());
  });
});
