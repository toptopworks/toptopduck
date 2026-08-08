import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";

import { McpSection } from "../McpSection";
import { clearMcpServerSecret, discoverMcpServers, probeMcpServer, upsertMcpServer } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import type { McpServerConfig, McpProbeResult } from "../../../types/mcp";

// The pane drives everything through IPC; mock the API so the test never
// touches Tauri.
vi.mock("../../../api", () => ({
  clearMcpServerSecret: vi.fn(),
  discoverMcpServers: vi.fn(),
  probeMcpServer: vi.fn(),
  upsertMcpServer: vi.fn(),
  setMcpServerSecret: vi.fn(),
}));

function makeServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "srv-1",
    display_name: "My Server",
    transport: { type: "stdio", command: "/bin/mcp-server", args: [] },
    env: {},
    keychain_env_keys: [],
    timeout_ms: null,
    ...overrides,
  };
}

function makeProbeResult(overrides: Partial<McpProbeResult> = {}): McpProbeResult {
  return { connected: true, tools: [], error: null, ...overrides };
}

function makeAppConfig(servers: McpServerConfig[]): AppConfig {
  return {
    provider: {
      profiles: [],
      active_profile_id: "",
    },
    mcp_servers: { servers },
    // The section only reads mcp_servers, but AppConfig requires all fields.
    // Using a minimal spread so any additional fields don't break.
  } as unknown as AppConfig;
}

// Empty-catalog English IntlProvider + QueryClient (retry: false) +
// TooltipProvider (mirrors App ancestor — McpServerRow now uses Tooltip).
function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <IntlProvider locale="en" messages={{}} onError={() => {}}>
          {ui}
        </IntlProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("McpSection (issue #387)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the empty state when no servers are configured", () => {
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={vi.fn()} />,
    );

    expect(
      screen.getByText("No MCP servers configured yet. Click Add to set one up."),
    ).toBeInTheDocument();
  });

  it("lists configured servers with display name", () => {
    const server = makeServer({ id: "srv-1", display_name: "GitHub MCP" });
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
    // Transport type + command on the second line, separated by "·".
    expect(screen.getByText(/stdio.*\/bin\/mcp-server/)).toBeInTheDocument();
  });

  it("shows the untested hint in expanded row before testing", () => {
    const server = makeServer({ id: "srv-1", display_name: "My Server" });
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    // Click the expand chevron.
    fireEvent.click(screen.getByRole("button", { name: "My Server" }));

    expect(
      screen.getByText("Not tested yet. Click Test to check connectivity."),
    ).toBeInTheDocument();
  });

  it("shows tool list after a successful probe", async () => {
    const server = makeServer({ id: "srv-1", display_name: "My Server" });
    const probeResult: McpProbeResult = {
      connected: true,
      tools: [
        { name: "search", description: "Search the web" },
        { name: "fetch", description: "Fetch a URL" },
      ],
      error: null,
    };
    vi.mocked(probeMcpServer).mockResolvedValue(probeResult);

    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    // Click the Test button.
    fireEvent.click(screen.getByRole("button", { name: /Test/ }));

    await waitFor(() => {
      expect(screen.getByText("search")).toBeInTheDocument();
      expect(screen.getByText("Search the web")).toBeInTheDocument();
      expect(screen.getByText("fetch")).toBeInTheDocument();
    });
  });

  it("shows error message after a failed probe", async () => {
    const server = makeServer({ id: "srv-1", display_name: "My Server" });
    const probeResult: McpProbeResult = {
      connected: false,
      tools: [],
      error: "spawn failed: ENOENT",
    };
    vi.mocked(probeMcpServer).mockResolvedValue(probeResult);

    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    // Click the expand chevron first to see the expanded content.
    fireEvent.click(screen.getByRole("button", { name: "My Server" }));
    // Click the Test button.
    fireEvent.click(screen.getByRole("button", { name: /Test/ }));

    await waitFor(() => {
      expect(
        screen.getByText("Connection failed: spawn failed: ENOENT"),
      ).toBeInTheDocument();
    });
  });

  it("opens delete confirmation dialog on delete button click", () => {
    const server = makeServer({ id: "srv-1", display_name: "My Server" });
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    // The delete button has aria-label "Delete server My Server".
    fireEvent.click(screen.getByRole("button", { name: "Delete server My Server" }));

    expect(
      screen.getByText("Delete MCP server?"),
    ).toBeInTheDocument();
  });

  it("removes server config then clears keychain secrets on delete confirm", async () => {
    const server = makeServer({
      id: "srv-1",
      display_name: "My Server",
      keychain_env_keys: ["API_KEY", "WEBHOOK_SECRET"],
    });
    vi.mocked(clearMcpServerSecret).mockResolvedValue(undefined);

    const onCommit = vi.fn().mockResolvedValue(null);
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={onCommit} />,
    );

    // Open the delete dialog.
    fireEvent.click(screen.getByRole("button", { name: "Delete server My Server" }));

    // Confirm deletion.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // onCommit should be called with a mutation that removes the server.
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
      const mutateFn = onCommit.mock.calls[0][0];
      const mutated = mutateFn(makeAppConfig([server]));
      expect(mutated.mcp_servers.servers).toHaveLength(0);
    });

    // Keychain secrets are cleared after the config removal succeeds.
    await waitFor(() => {
      expect(clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "API_KEY");
      expect(clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "WEBHOOK_SECRET");
    });
  });

  it("keeps dialog open and shows error when onCommit fails", async () => {
    const server = makeServer({
      id: "srv-1",
      display_name: "My Server",
      keychain_env_keys: ["API_KEY"],
    });

    const onCommit = vi.fn().mockResolvedValue("disk write failed");
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={onCommit} />,
    );

    // Open + confirm delete.
    fireEvent.click(screen.getByRole("button", { name: "Delete server My Server" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByText("disk write failed")).toBeInTheDocument();
    });

    // Dialog should still be visible (deleteTarget not cleared).
    expect(screen.getByText("Delete MCP server?")).toBeInTheDocument();
    // Keychain secret should NOT have been cleared (config removal failed).
    expect(clearMcpServerSecret).not.toHaveBeenCalled();
  });

  it("proceeds with config removal when keychain clear fails (best effort)", async () => {
    const server = makeServer({
      id: "srv-1",
      display_name: "My Server",
      keychain_env_keys: ["API_KEY"],
    });
    vi.mocked(clearMcpServerSecret).mockRejectedValue(new Error("keychain locked"));

    const onCommit = vi.fn().mockResolvedValue(null);
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={onCommit} />,
    );

    // Open + confirm delete.
    fireEvent.click(screen.getByRole("button", { name: "Delete server My Server" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // Config removal should succeed and clear should have been attempted.
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "API_KEY");
    });

    // No error surfaced — the keychain failure is swallowed (best effort).
    expect(screen.queryByText("keychain locked")).not.toBeInTheDocument();
  });

  it("clicking Add switches to the form view (issue #388)", () => {
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /New/ }));

    expect(screen.getByTestId("mcp-server-form")).toBeInTheDocument();
    expect(screen.getByText("New MCP server")).toBeInTheDocument();
  });

  it("clicking Edit on a server row switches to a pre-filled form (issue #388)", () => {
    const server = makeServer({ id: "srv-1", display_name: "My Server" });
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit server My Server" }));

    expect(screen.getByTestId("mcp-server-form")).toBeInTheDocument();
    expect(screen.getByText("Edit MCP server")).toBeInTheDocument();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "My Server",
    );
  });

  it("back link in the form returns to the list view (issue #388)", () => {
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={vi.fn()} />,
    );

    // Enter the form.
    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    expect(screen.getByTestId("mcp-server-form")).toBeInTheDocument();

    // Go back.
    fireEvent.click(screen.getByText("Back to MCP list"));

    expect(screen.queryByTestId("mcp-server-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-server-list")).toBeInTheDocument();
  });

  it("Add button is now enabled (no longer a placeholder)", () => {
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={vi.fn()} />,
    );

    const addButton = screen.getByRole("button", { name: /New/ });
    expect(addButton).not.toBeDisabled();
  });

  // --- Review fix tests (PR #393 review) ------------------------------------

  it("syncs saved server into list and seeds probe state on save (H4)", async () => {
    const finalized = makeServer({ id: "srv-new", display_name: "Brand New" });
    const probeResult = makeProbeResult({
      connected: true,
      tools: [{ name: "search", description: "Search" }],
    });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    vi.mocked(probeMcpServer).mockResolvedValue(probeResult);

    const onCommit = vi.fn().mockResolvedValue(null);
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={onCommit} />,
    );

    // Enter the form.
    fireEvent.click(screen.getByRole("button", { name: /New/ }));

    // Fill required fields so the Add button is enabled.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Brand New" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "/bin/mcp" } });

    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => {
      // Form closed — back to the list view.
      expect(screen.getByTestId("mcp-server-list")).toBeInTheDocument();
    });

    // onCommit was called with a mutation that adds the finalized server.
    expect(onCommit).toHaveBeenCalledTimes(1);
    const mutateFn = onCommit.mock.calls[0][0];
    const mutated = mutateFn(makeAppConfig([]));
    expect(mutated.mcp_servers.servers).toHaveLength(1);
    expect(mutated.mcp_servers.servers[0].id).toBe("srv-new");
  });

  it("shows error on the list when onCommit fails after form save (H4)", async () => {
    const finalized = makeServer({ id: "srv-new", display_name: "Brand New" });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    const onCommit = vi.fn().mockResolvedValue("disk write error");
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={onCommit} />,
    );

    // Enter the form.
    fireEvent.click(screen.getByRole("button", { name: /New/ }));

    // Fill required fields so the Add button is enabled.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Brand New" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "/bin/mcp" } });

    fireEvent.click(screen.getByText("Add"));

    await waitFor(() => {
      expect(screen.getByText("disk write error")).toBeInTheDocument();
    });

    // Form is closed — error shows on the list view (C3: setFormTarget(null)
    // runs at the end regardless of onCommit outcome).
    expect(screen.getByTestId("mcp-server-list")).toBeInTheDocument();
  });

  // --- Import button (issue #390) -----------------------------------------

  it("shows an Import button in the header", () => {
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /Import/ })).toBeInTheDocument();
  });

  it("opens the import dialog on Import button click", async () => {
    vi.mocked(discoverMcpServers).mockResolvedValue({ servers: [], config_path: null });

    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Import/ }));

    // The import dialog is open (title is always rendered).
    await waitFor(() => {
      expect(screen.getByText("Import MCP servers")).toBeInTheDocument();
    });
  });
});
