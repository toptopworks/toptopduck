import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import type { ReactElement } from "react";

import { McpSection } from "../McpSection";
import { clearMcpServerSecret, probeMcpServer } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import type { McpServerConfig, McpProbeResult } from "../../../types/mcp";

// The pane drives everything through IPC; mock the API so the test never
// touches Tauri.
vi.mock("../../../api", () => ({
  clearMcpServerSecret: vi.fn(),
  probeMcpServer: vi.fn(),
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

// Empty-catalog English IntlProvider: FormattedMessage falls back to
// defaultMessage (the canonical English source, ADR-0052), so assertions anchor
// on stable English strings.
function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      {ui}
    </IntlProvider>,
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
    expect(screen.getByText("/bin/mcp-server")).toBeInTheDocument();
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

  it("clears keychain secrets then removes server on delete confirm", async () => {
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

    await waitFor(() => {
      expect(clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "API_KEY");
      expect(clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "WEBHOOK_SECRET");
    });

    // onCommit should be called with a mutation that removes the server.
    await waitFor(() => {
      expect(onCommit).toHaveBeenCalledTimes(1);
      const mutateFn = onCommit.mock.calls[0][0];
      const mutated = mutateFn(makeAppConfig([server]));
      expect(mutated.mcp_servers.servers).toHaveLength(0);
    });
  });

  it("shows Add button as disabled (placeholder for follow-up ticket)", () => {
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([])} onCommit={vi.fn()} />,
    );

    const addButton = screen.getByRole("button", { name: /Add/ });
    expect(addButton).toBeDisabled();
  });
});
