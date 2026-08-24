import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { McpImportDialog } from "../McpImportDialog";
import { discoverMcpServers, probeMcpServer, upsertMcpServer } from "../../../api";
import type { DiscoveredServer, DiscoveryResult, McpServerConfig, McpProbeResult } from "../../../types/mcp";

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

function makeFinalized(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "id-a",
    display_name: "filesystem",
    transport: { type: "stdio", command: "npx", args: ["-y", "server"] },
    env: {},
    keychain_env_keys: [],
    timeout_ms: null,
    enabled: true,
    ...overrides,
  };
}

const okProbe: McpProbeResult = { connected: true, tools: [], error: null };

// Empty-catalog English IntlProvider + QueryClient (retry: false) to keep
// reject-driven assertions off the retry path (mirrors ImportSkillsDialog tests).
function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        {ui}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const defaultProps = {
  open: true,
  existingNames: new Set<string>(),
  onClose: vi.fn(),
  onImported: vi.fn(),
};

// Helper: mock both sources to return the given servers / errors.
// Servers are wrapped in DiscoveryResult { servers, config_path }.
function mockDiscover(
  claudeDesktop: DiscoveredServer[] | Error = [],
  codex: DiscoveredServer[] | Error = [],
) {
  vi.mocked(discoverMcpServers).mockImplementation((source) => {
    if (source === "claude_desktop") {
      return claudeDesktop instanceof Error
        ? Promise.reject(claudeDesktop)
        : Promise.resolve({
            servers: claudeDesktop,
            config_path: "/home/user/.config/Claude/claude_desktop_config.json",
          });
    }
    return codex instanceof Error
      ? Promise.reject(codex)
      : Promise.resolve({
          servers: codex,
          config_path: "/home/user/.codex/config.toml",
        });
  });
}

// Expand a source section by clicking its collapsed header toggle.
function expandSource(label: string) {
  const btn = screen.getByRole("button", { name: `Expand ${label}` });
  fireEvent.click(btn);
}

// Click the source-level select-all checkbox (always visible in the header,
// even when the section is collapsed).
function selectAllInSource(label: string) {
  const cb = screen
    .getAllByRole("checkbox")
    .find((c) => c.getAttribute("aria-label") === label)!;
  fireEvent.click(cb);
}

describe("McpImportDialog (issue #390)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state while reading config", () => {
    vi.mocked(discoverMcpServers).mockImplementation(
      () => new Promise<DiscoveryResult>(() => { /* never resolves */ }),
    );

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    expect(screen.getByText("Reading config…")).toBeInTheDocument();
  });

  it("renders source rows collapsed; hides sources with no servers", async () => {
    mockDiscover([makeDiscovered()], []);

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    // Claude Desktop has servers — its source row is visible (collapsed).
    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    // Codex has no servers — its source row is hidden.
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();

    // Collapsed: server name is not visible until expanded.
    expect(screen.queryByText("filesystem")).not.toBeInTheDocument();
  });

  it("does not render when closed", () => {
    mockDiscover();
    renderWithProviders(<McpImportDialog {...defaultProps} open={false} />);

    expect(screen.queryByText("Claude Desktop")).not.toBeInTheDocument();
  });

  it("discovers both sources in parallel on open", async () => {
    mockDiscover(
      [makeDiscovered({ display_name: "fs" })],
      [makeDiscovered({ display_name: "git" })],
    );

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    // Both source rows are visible (both have servers).
    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
      expect(screen.getByText("Codex")).toBeInTheDocument();
    });

    // discoverMcpServers was called for both sources.
    expect(discoverMcpServers).toHaveBeenCalledWith("claude_desktop");
    expect(discoverMcpServers).toHaveBeenCalledWith("codex");
  });

  it("pre-selects nothing by default; user selects via checkbox", async () => {
    mockDiscover([makeDiscovered({ display_name: "srv-a" })], []);

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    // No servers are selected initially — Import button is disabled.
    const importBtn = screen.getByTestId("import-action");
    expect(importBtn).toBeDisabled();
  });

  it("select-all checkbox selects all servers in a source", async () => {
    mockDiscover(
      [
        makeDiscovered({ display_name: "srv-a" }),
        makeDiscovered({ display_name: "srv-b" }),
      ],
      [],
    );

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    // Source-level checkbox is visible in the collapsed header.
    selectAllInSource("Claude Desktop");

    expect(
      screen.getByRole("button", { name: /Import 2/ }),
    ).toBeInTheDocument();
  });

  it("shows empty state when no sources have servers", async () => {
    mockDiscover([], []);

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("No MCP server sources found.")).toBeInTheDocument();
    });

    // Neither source row is shown.
    expect(screen.queryByText("Claude Desktop")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
  });

  it("hides source with discovery error when it has no servers", async () => {
    mockDiscover(
      [makeDiscovered({ display_name: "srv-a" })],
      new Error("malformed JSON"),
    );

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    // Claude Desktop (has servers) is visible.
    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    // Codex (error, 0 servers) is hidden.
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    expect(screen.queryByText(/malformed JSON/)).not.toBeInTheDocument();
  });

  it("shows secrets badge for servers with keychain env keys", async () => {
    mockDiscover(
      [
        makeDiscovered({
          display_name: "secret-server",
          keychain_env_keys: ["API_KEY", "DB_PASSWORD"],
        }),
      ],
      [],
    );

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    // Expand to see server details.
    expandSource("Claude Desktop");

    expect(screen.getByText("2 secret(s)")).toBeInTheDocument();
  });

  it("imports selected servers via upsert + probe on confirm", async () => {
    mockDiscover(
      [
        makeDiscovered({ display_name: "srv-a" }),
        makeDiscovered({ display_name: "srv-b" }),
      ],
      [],
    );

    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(makeFinalized({ id: "id-a", display_name: "srv-a" }))
      .mockResolvedValueOnce(makeFinalized({ id: "id-b", display_name: "srv-b" }));
    vi.mocked(probeMcpServer).mockResolvedValue(okProbe);

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });
    selectAllInSource("Claude Desktop");

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
    mockDiscover(
      [
        makeDiscovered({ display_name: "srv-a" }),
        makeDiscovered({ display_name: "srv-b" }),
      ],
      [],
    );
    vi.mocked(upsertMcpServer).mockResolvedValue(
      makeFinalized({ display_name: "srv-a" }),
    );
    vi.mocked(probeMcpServer).mockResolvedValue(okProbe);

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });
    selectAllInSource("Claude Desktop");

    // Expand to access individual server checkboxes.
    expandSource("Claude Desktop");

    // Uncheck srv-b.
    const srvBCb = screen
      .getAllByRole("checkbox")
      .find((cb) => cb.getAttribute("aria-label") === "srv-b")!;
    fireEvent.click(srvBCb);

    expect(
      screen.getByRole("button", { name: /Import 1/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Import 1/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported.mock.calls[0][0]).toHaveLength(1);
    expect(upsertMcpServer).toHaveBeenCalledTimes(1);
  });

  it("calls onClose after successful import", async () => {
    mockDiscover([makeDiscovered({ display_name: "filesystem" })], []);
    vi.mocked(upsertMcpServer).mockResolvedValue(makeFinalized());
    vi.mocked(probeMcpServer).mockResolvedValue(okProbe);

    const onClose = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onClose={onClose} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });
    selectAllInSource("Claude Desktop");
    fireEvent.click(screen.getByRole("button", { name: /Import 1/ }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("syncs successfully imported servers even when a later server fails (H1)", async () => {
    mockDiscover(
      [
        makeDiscovered({ display_name: "srv-a" }),
        makeDiscovered({ display_name: "srv-b" }),
      ],
      [],
    );

    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(makeFinalized({ id: "id-a", display_name: "srv-a" }))
      .mockRejectedValueOnce(new Error("disk full"));
    vi.mocked(probeMcpServer).mockResolvedValue(okProbe);

    const onImported = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <McpImportDialog
        {...defaultProps}
        onImported={onImported}
        onClose={onClose}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });
    selectAllInSource("Claude Desktop");
    fireEvent.click(screen.getByRole("button", { name: /Import 2/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported.mock.calls[0][0]).toHaveLength(1);
    expect(onImported.mock.calls[0][0][0].config.id).toBe("id-a");

    // Dialog stays open — srv-b failed.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/disk full/)).toBeInTheDocument();
  });

  it("continues import when probe fails but upsert succeeds (non-fatal probe)", async () => {
    mockDiscover([makeDiscovered({ display_name: "filesystem" })], []);
    vi.mocked(upsertMcpServer).mockResolvedValue(makeFinalized());
    vi.mocked(probeMcpServer).mockRejectedValue(new Error("spawn timeout"));

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });
    selectAllInSource("Claude Desktop");
    fireEvent.click(screen.getByRole("button", { name: /Import 1/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    const results = onImported.mock.calls[0][0];
    expect(results).toHaveLength(1);
    expect(results[0].probeResult.connected).toBe(false);
    expect(results[0].probeResult.error).toBe("spawn timeout");
  });

  it("does not re-import succeeded servers on retry after partial failure (H1)", async () => {
    mockDiscover(
      [
        makeDiscovered({ display_name: "srv-a" }),
        makeDiscovered({ display_name: "srv-b" }),
      ],
      [],
    );

    // First attempt: srv-a succeeds, srv-b fails.
    // Retry: srv-b succeeds.
    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(makeFinalized({ id: "id-a", display_name: "srv-a" }))
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(makeFinalized({ id: "id-b", display_name: "srv-b" }));
    vi.mocked(probeMcpServer).mockResolvedValue(okProbe);

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });
    selectAllInSource("Claude Desktop");
    fireEvent.click(screen.getByRole("button", { name: /Import 2/ }));

    // First attempt: srv-a imported, srv-b failed.
    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported.mock.calls[0][0]).toHaveLength(1);

    // srv-a pruned from selection; only srv-b remains for retry.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Import 1/ }),
      ).toBeInTheDocument();
    });
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

  it("imports servers from multiple sources simultaneously", async () => {
    mockDiscover(
      [makeDiscovered({ display_name: "claude-server" })],
      [makeDiscovered({ display_name: "codex-server" })],
    );

    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(makeFinalized({ id: "id-c", display_name: "claude-server" }))
      .mockResolvedValueOnce(makeFinalized({ id: "id-d", display_name: "codex-server" }));
    vi.mocked(probeMcpServer).mockResolvedValue(okProbe);

    const onImported = vi.fn();
    renderWithProviders(
      <McpImportDialog {...defaultProps} onImported={onImported} />,
    );

    // Wait for both source rows.
    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
      expect(screen.getByText("Codex")).toBeInTheDocument();
    });

    // Select all in both sources (checkboxes in collapsed headers).
    selectAllInSource("Claude Desktop");
    selectAllInSource("Codex");

    fireEvent.click(screen.getByRole("button", { name: /Import 2/ }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported.mock.calls[0][0]).toHaveLength(2);
  });

  it("shows discovered count in footer", async () => {
    mockDiscover(
      [
        makeDiscovered({ display_name: "srv-a" }),
        makeDiscovered({ display_name: "srv-b" }),
      ],
      [makeDiscovered({ display_name: "srv-c" })],
    );

    renderWithProviders(<McpImportDialog {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/Discovered 3 importable servers/)).toBeInTheDocument();
    });
  });

  it("hides servers already in the config via existingNames", async () => {
    mockDiscover(
      [
        makeDiscovered({ display_name: "existing-srv" }),
        makeDiscovered({ display_name: "new-srv" }),
      ],
      [],
    );

    renderWithProviders(
      <McpImportDialog
        {...defaultProps}
        existingNames={new Set(["existing-srv"])}
      />,
    );

    // Wait for the source row to render.
    await waitFor(() => {
      expect(screen.getByText("Claude Desktop")).toBeInTheDocument();
    });

    // Discovered count reflects only importable (non-duplicate) servers.
    expect(screen.getByText(/Discovered 1 importable server/)).toBeInTheDocument();

    // Expand to see the server list and verify existing-srv is absent.
    fireEvent.click(screen.getByRole("button", { name: /Expand Claude Desktop/ }));
    await waitFor(() => {
      expect(screen.getByText("new-srv")).toBeInTheDocument();
      expect(screen.queryByText("existing-srv")).not.toBeInTheDocument();
    });
  });

  it("hides an entire source when all its servers are already imported", async () => {
    mockDiscover(
      [makeDiscovered({ display_name: "already-here" })],
      [makeDiscovered({ display_name: "new-one" })],
    );

    renderWithProviders(
      <McpImportDialog
        {...defaultProps}
        existingNames={new Set(["already-here"])}
      />,
    );

    await waitFor(() => {
      // Codex source visible, Claude Desktop fully filtered out.
      expect(screen.getByText("Codex")).toBeInTheDocument();
      expect(screen.queryByText("Claude Desktop")).not.toBeInTheDocument();
    });
  });
});
