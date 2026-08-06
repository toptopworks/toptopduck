import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { McpImportDialog } from "../McpImportDialog";
import { discoverMcpServers, probeMcpServer, upsertMcpServer } from "../../../api";
import type { DiscoveredServer, McpServerConfig, McpProbeResult } from "../../../types/mcp";

// Mock the API so the test never touches Tauri.
vi.mock("../../../api", () => ({
  discoverMcpServers: vi.fn(),
  probeMcpServer: vi.fn(),
  upsertMcpServer: vi.fn(),
}));

function makeDiscovered(overrides: Partial<DiscoveredServer> = {}): DiscoveredServer {
  return {
    display_name: "filesystem",
    transport: { type: "stdio", command: "npx", args: ["-y", "server"] },
    env: {},
    keychain_env_keys: [],
    ...overrides,
  };
}

// Empty-catalog English IntlProvider: FormattedMessage falls back to
// defaultMessage (ADR-0052).
function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
  );
}

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  onImported: vi.fn(),
};

describe("McpImportDialog (issue #390)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows source selection buttons when open", () => {
    renderWithProviders(<McpImportDialog {...defaultProps} />);

    expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderWithProviders(<McpImportDialog {...defaultProps} open={false} />);

    expect(screen.queryByText("Claude Desktop")).not.toBeInTheDocument();
  });

  it("shows loading state while reading config", async () => {
    vi.mocked(discoverMcpServers).mockImplementation(
      () => new Promise<DiscoveredServer[]>(() => { /* never resolves */ }),
    );

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));

    await waitFor(() => {
      expect(screen.getByText("Reading config…")).toBeInTheDocument();
    });
  });

  it("shows checklist with discovered servers", async () => {
    const servers = [
      makeDiscovered({ display_name: "filesystem", transport: { type: "stdio", command: "npx", args: [] } }),
      makeDiscovered({ display_name: "github", transport: { type: "stdio", command: "node", args: ["gh.js"] } }),
    ];
    vi.mocked(discoverMcpServers).mockResolvedValue(servers);

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));

    await waitFor(() => {
      expect(screen.getByText("filesystem")).toBeInTheDocument();
      expect(screen.getByText("github")).toBeInTheDocument();
    });
    // Transport summaries.
    expect(screen.getByText("npx")).toBeInTheDocument();
    expect(screen.getByText("node")).toBeInTheDocument();
  });

  it("pre-selects all discovered servers by default", async () => {
    const servers = [
      makeDiscovered({ display_name: "srv-a" }),
      makeDiscovered({ display_name: "srv-b" }),
    ];
    vi.mocked(discoverMcpServers).mockResolvedValue(servers);

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));

    const checkboxes = await screen.findAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
  });

  it("shows not-found message when no servers discovered", async () => {
    vi.mocked(discoverMcpServers).mockResolvedValue([]);

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mcp-import-source-codex"));

    await waitFor(() => {
      expect(screen.getByTestId("mcp-import-not-found")).toBeInTheDocument();
    });
  });

  it("shows error message when discovery fails", async () => {
    vi.mocked(discoverMcpServers).mockRejectedValue(new Error("malformed JSON"));

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));

    await waitFor(() => {
      expect(screen.getByTestId("mcp-import-error")).toBeInTheDocument();
      expect(screen.getByText(/malformed JSON/)).toBeInTheDocument();
    });
  });

  it("shows secrets badge for servers with keychain env keys", async () => {
    const servers = [
      makeDiscovered({
        display_name: "secret-server",
        keychain_env_keys: ["API_KEY", "DB_PASSWORD"],
      }),
    ];
    vi.mocked(discoverMcpServers).mockResolvedValue(servers);

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));

    await waitFor(() => {
      expect(screen.getByText("2 secret(s)")).toBeInTheDocument();
    });
  });

  it("imports selected servers via upsert + probe on confirm", async () => {
    const servers = [
      makeDiscovered({ display_name: "srv-a" }),
      makeDiscovered({ display_name: "srv-b" }),
    ];
    vi.mocked(discoverMcpServers).mockResolvedValue(servers);

    const finalizedA: McpServerConfig = {
      id: "id-a",
      display_name: "srv-a",
      transport: { type: "stdio", command: "npx", args: ["-y", "server"] },
      env: {},
      keychain_env_keys: [],
      timeout_ms: null,
    };
    const finalizedB: McpServerConfig = {
      ...finalizedA,
      id: "id-b",
      display_name: "srv-b",
    };
    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(finalizedA)
      .mockResolvedValueOnce(finalizedB);

    const probeResult: McpProbeResult = { connected: true, tools: [], error: null };
    vi.mocked(probeMcpServer).mockResolvedValue(probeResult);

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));

    // Wait for checklist, then click Import.
    await screen.findByText("srv-a");
    fireEvent.click(screen.getByRole("button", { name: /Import 2/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });

    const results = onImported.mock.calls[0][0];
    expect(results).toHaveLength(2);
    expect(results[0].config.id).toBe("id-a");
    expect(results[0].probeResult.connected).toBe(true);
    expect(results[1].config.id).toBe("id-b");

    // upsert was called with empty id (Rust mints uuid).
    expect(upsertMcpServer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(upsertMcpServer).mock.calls[0][0].id).toBe("");
  });

  it("unchecking a server excludes it from import", async () => {
    const servers = [
      makeDiscovered({ display_name: "srv-a" }),
      makeDiscovered({ display_name: "srv-b" }),
    ];
    vi.mocked(discoverMcpServers).mockResolvedValue(servers);
    vi.mocked(upsertMcpServer).mockResolvedValue({
      id: "id-a",
      display_name: "srv-a",
      transport: { type: "stdio", command: "npx", args: [] },
      env: {},
      keychain_env_keys: [],
      timeout_ms: null,
    });
    vi.mocked(probeMcpServer).mockResolvedValue({ connected: true, tools: [], error: null });

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));

    // Wait for checklist.
    await screen.findByText("srv-a");

    // Uncheck srv-b.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[1]);

    // Import button should show count 1.
    expect(screen.getByRole("button", { name: /Import 1/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import 1/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported.mock.calls[0][0]).toHaveLength(1);
    expect(upsertMcpServer).toHaveBeenCalledTimes(1);
  });

  it("calls onClose after successful import", async () => {
    vi.mocked(discoverMcpServers).mockResolvedValue([makeDiscovered()]);
    vi.mocked(upsertMcpServer).mockResolvedValue({
      id: "id-a",
      display_name: "filesystem",
      transport: { type: "stdio", command: "npx", args: [] },
      env: {},
      keychain_env_keys: [],
      timeout_ms: null,
    });
    vi.mocked(probeMcpServer).mockResolvedValue({ connected: true, tools: [], error: null });

    const onClose = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onClose={onClose} />,
    );

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));
    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: /Import 1/ }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("syncs successfully imported servers even when a later server fails (H1)", async () => {
    const servers = [
      makeDiscovered({ display_name: "srv-a" }),
      makeDiscovered({ display_name: "srv-b" }),
    ];
    vi.mocked(discoverMcpServers).mockResolvedValue(servers);

    const finalizedA: McpServerConfig = {
      id: "id-a",
      display_name: "srv-a",
      transport: { type: "stdio", command: "npx", args: ["-y", "server"] },
      env: {},
      keychain_env_keys: [],
      timeout_ms: null,
    };
    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(finalizedA)
      .mockRejectedValueOnce(new Error("disk full"));
    vi.mocked(probeMcpServer).mockResolvedValue({ connected: true, tools: [], error: null });

    const onImported = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} onClose={onClose} />,
    );

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));
    await screen.findByText("srv-a");
    fireEvent.click(screen.getByRole("button", { name: /Import 2/ }));

    // onImported should be called with the one server that succeeded — the
    // failure of srv-b does not orphan srv-a from React state (H1 fix).
    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported.mock.calls[0][0]).toHaveLength(1);
    expect(onImported.mock.calls[0][0][0].config.id).toBe("id-a");

    // The dialog stays open showing the error — srv-b failed.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/disk full/)).toBeInTheDocument();
  });

  it("continues import when probe fails but upsert succeeds (non-fatal probe)", async () => {
    vi.mocked(discoverMcpServers).mockResolvedValue([makeDiscovered()]);
    vi.mocked(upsertMcpServer).mockResolvedValue({
      id: "id-a",
      display_name: "filesystem",
      transport: { type: "stdio", command: "npx", args: [] },
      env: {},
      keychain_env_keys: [],
      timeout_ms: null,
    });
    vi.mocked(probeMcpServer).mockRejectedValue(new Error("spawn timeout"));

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));
    await screen.findByText("filesystem");
    fireEvent.click(screen.getByRole("button", { name: /Import 1/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    const results = onImported.mock.calls[0][0];
    expect(results).toHaveLength(1);
    // Probe failure is non-fatal — the server is saved with a disconnected
    // probe result.
    expect(results[0].probeResult.connected).toBe(false);
    expect(results[0].probeResult.error).toBe("spawn timeout");
  });

  it("does not re-import succeeded servers on retry after partial failure (H1)", async () => {
    const servers = [
      makeDiscovered({ display_name: "srv-a" }),
      makeDiscovered({ display_name: "srv-b" }),
    ];
    vi.mocked(discoverMcpServers).mockResolvedValue(servers);

    const finalizedA: McpServerConfig = {
      id: "id-a",
      display_name: "srv-a",
      transport: { type: "stdio", command: "npx", args: ["-y", "server"] },
      env: {},
      keychain_env_keys: [],
      timeout_ms: null,
    };
    const finalizedB: McpServerConfig = {
      ...finalizedA,
      id: "id-b",
      display_name: "srv-b",
    };
    // First attempt: srv-a succeeds, srv-b fails.
    // Retry: srv-b succeeds (should NOT re-import srv-a).
    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(finalizedA)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(finalizedB);
    vi.mocked(probeMcpServer).mockResolvedValue({ connected: true, tools: [], error: null });

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    fireEvent.click(screen.getByTestId("mcp-import-source-claude_desktop"));
    await screen.findByText("srv-a");
    fireEvent.click(screen.getByRole("button", { name: /Import 2/ }));

    // First attempt: srv-a imported, srv-b failed.
    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported.mock.calls[0][0]).toHaveLength(1);

    // srv-a removed from checklist; only srv-b remains for retry.
    await waitFor(() => {
      expect(screen.queryByText("srv-a")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Import 1/ })).toBeInTheDocument();
    expect(screen.getByText(/disk full/)).toBeInTheDocument();

    // Retry: click Import again — only srv-b should be imported.
    fireEvent.click(screen.getByRole("button", { name: /Import 1/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(2);
    });
    expect(onImported.mock.calls[1][0]).toHaveLength(1);
    expect(onImported.mock.calls[1][0][0].config.id).toBe("id-b");

    // Total upsert calls: 2 (first attempt) + 1 (retry) = 3, NOT 4.
    expect(upsertMcpServer).toHaveBeenCalledTimes(3);
  });
});
