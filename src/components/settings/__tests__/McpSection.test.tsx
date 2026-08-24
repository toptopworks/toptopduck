import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";

import { McpSection } from "../McpSection";
import { upsertMirror } from "../mcp-mirror";
import { clearMcpServerSecret, discoverMcpServers, probeMcpServer, upsertMcpServer } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import type {
  DiscoveredServer,
  McpServerConfig,
  McpProbeResult,
} from "../../../types/mcp";

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
    enabled: true,
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

describe("upsertMirror (#659)", () => {
  it("replaces an existing id in place", () => {
    const a = makeServer({ id: "srv-a" });
    const b = makeServer({ id: "srv-b" });
    const c = makeServer({ id: "srv-c" });
    const edited = makeServer({ id: "srv-b", display_name: "B edited" });

    expect(upsertMirror([a, b, c], edited).map((s) => s.id)).toEqual([
      "srv-a",
      "srv-b",
      "srv-c",
    ]);
    expect(upsertMirror([a, b, c], edited)[1].display_name).toBe("B edited");
  });

  it("appends a new id at the end", () => {
    const a = makeServer({ id: "srv-a" });
    const fresh = makeServer({ id: "srv-new" });

    expect(upsertMirror([a], fresh).map((s) => s.id)).toEqual([
      "srv-a",
      "srv-new",
    ]);
  });

  it("batch upsert keeps existing ids in place and appends new ids", () => {
    // The import path folds a batch through upsertMirror: an imported id
    // matching a configured row replaces it in place, unseen ids append —
    // mirroring the backend registry's per-entry upsert semantics.
    const a = makeServer({ id: "srv-a" });
    const b = makeServer({ id: "srv-b" });
    const c = makeServer({ id: "srv-c" });
    const bEdited = makeServer({ id: "srv-b", display_name: "B imported" });
    const fresh = makeServer({ id: "srv-new" });

    const batch = [bEdited, fresh].reduce(
      (acc, next) => upsertMirror(acc, next),
      [a, b, c],
    );
    expect(batch.map((s) => s.id)).toEqual(["srv-a", "srv-b", "srv-c", "srv-new"]);
    expect(batch[1].display_name).toBe("B imported");
  });
});

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
      screen.getByText("Delete MCP server My Server?"),
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
    expect(screen.getByText("Delete MCP server My Server?")).toBeInTheDocument();
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

  it("row enable switch writes via upsert and syncs the mirror (ADR-0106)", async () => {
    const server = makeServer();
    const onCommit = vi.fn().mockResolvedValue(null);
    vi.mocked(upsertMcpServer).mockResolvedValue({ ...server, enabled: false });
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={onCommit} />,
    );

    // The row renders an on switch; flipping it issues an upsert carrying the
    // flipped flag -- the toggle IS an upsert, no dedicated IPC exists.
    const toggle = screen.getByRole("switch", { name: "Toggle server My Server" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(upsertMcpServer).toHaveBeenCalledWith({ ...server, enabled: false }),
    );
    // The mirror mutate replaces the entry with the finalized (disabled) server.
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutateFn = onCommit.mock.calls[0][0];
    const mutated = mutateFn(makeAppConfig([server]));
    expect(mutated.mcp_servers.servers[0].enabled).toBe(false);
  });

  it("row enable switch surfaces the error when the upsert rejects (ADR-0106)", async () => {
    const server = makeServer();
    vi.mocked(upsertMcpServer).mockRejectedValue(new Error("disk full"));
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Toggle server My Server" }));
    expect(await screen.findByText("disk full")).toBeInTheDocument();
  });

  it("quiets the display name of a disabled row (ADR-0106)", () => {
    renderWithProviders(
      <McpSection
        appConfig={makeAppConfig([
          makeServer({ id: "off-1", display_name: "Dormant", enabled: false }),
          makeServer({ id: "on-2", display_name: "Live", enabled: true }),
        ])}
        onCommit={vi.fn()}
      />,
    );

    // A disabled server is dormant: the quieted name keeps the row's state
    // legible at a glance; an enabled row keeps the normal weight.
    expect(screen.getByText("Dormant").className).toContain(
      "text-muted-foreground",
    );
    expect(screen.getByText("Live").className).not.toContain(
      "text-muted-foreground",
    );
  });

  it("gates the row's action buttons while the enable toggle is in flight (ADR-0106)", async () => {
    // The edit form bakes the mount-time `enabled` into every save, so an
    // Edit opening inside the toggle's in-flight window could write the
    // stale value back over it -- Test/Edit/Delete gate alongside the switch.
    const server = makeServer();
    let resolveUpsert: (value: McpServerConfig) => void = () => {};
    vi.mocked(upsertMcpServer).mockImplementation(
      () =>
        new Promise<McpServerConfig>((resolve) => {
          resolveUpsert = resolve;
        }),
    );
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([server])} onCommit={vi.fn()} />,
    );

    fireEvent.click(
      screen.getByRole("switch", { name: "Toggle server My Server" }),
    );
    expect(
      screen.getByRole("button", { name: "Test server My Server" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Edit server My Server" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete server My Server" }),
    ).toBeDisabled();

    resolveUpsert({ ...server, enabled: false });
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

  it("keeps row order when editing an existing server (#659)", async () => {
    // The registry's upsert replaces in place (order preserved on disk), so
    // the React mirror must not shuffle the edited row to the end -- a
    // restart would otherwise snap the row back to its disk position.
    const a = makeServer({ id: "srv-a", display_name: "A" });
    const b = makeServer({ id: "srv-b", display_name: "B" });
    const c = makeServer({ id: "srv-c", display_name: "C" });
    const finalized = makeServer({ id: "srv-b", display_name: "B edited" });
    vi.mocked(upsertMcpServer).mockResolvedValue(finalized);
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    const onCommit = vi.fn().mockResolvedValue(null);
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([a, b, c])} onCommit={onCommit} />,
    );

    // Edit B, rename it, save.
    fireEvent.click(screen.getByRole("button", { name: "Edit server B" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "B edited" },
    });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutateFn = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    const mutated = mutateFn(makeAppConfig([a, b, c]));
    expect(mutated.mcp_servers.servers.map((s) => s.id)).toEqual([
      "srv-a",
      "srv-b",
      "srv-c",
    ]);
    expect(mutated.mcp_servers.servers[1].display_name).toBe("B edited");
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

  it("keeps row order when importing — existing ids replace in place, new ids append (#659)", async () => {
    // The import path folds every finalized config through upsertMirror:
    // a finalized id matching a configured row replaces it in place
    // (mirroring the backend registry), an unseen id appends — the old
    // filter+append would shuffle the replaced row to the end while disk
    // kept its position, snapping back on restart.
    const a = makeServer({ id: "srv-a", display_name: "A" });
    const b = makeServer({ id: "srv-b", display_name: "B" });
    const c = makeServer({ id: "srv-c", display_name: "C" });
    const discoveredB: DiscoveredServer = {
      display_name: "Imported B",
      transport: { type: "stdio", command: "/bin/imported-b", args: [] },
      env: {},
      keychain_env_keys: [],
    };
    const discoveredNew: DiscoveredServer = {
      display_name: "Brand New",
      transport: { type: "stdio", command: "/bin/imported-new", args: [] },
      env: {},
      keychain_env_keys: [],
    };
    // Discovery only reports Claude Desktop (the dialog dedupes nothing
    // here — these display names are not yet configured).
    vi.mocked(discoverMcpServers).mockImplementation(async (src) =>
      src === "claude_desktop"
        ? { servers: [discoveredB, discoveredNew], config_path: "/home/u/.claude.json" }
        : { servers: [], config_path: null },
    );
    // The IPC boundary's finalized configs: the first lands on the EXISTING
    // srv-b id (replace in place), the second on a fresh id (append).
    vi.mocked(upsertMcpServer)
      .mockResolvedValueOnce(makeServer({ id: "srv-b", display_name: "Imported B" }))
      .mockResolvedValueOnce(makeServer({ id: "srv-new", display_name: "Brand New" }));
    vi.mocked(probeMcpServer).mockResolvedValue(makeProbeResult());

    const onCommit = vi.fn().mockResolvedValue(null);
    renderWithProviders(
      <McpSection appConfig={makeAppConfig([a, b, c])} onCommit={onCommit} />,
    );

    // Open the dialog, wait for discovery, select the source's servers,
    // import.
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Claude Desktop" }),
    );
    fireEvent.click(screen.getByTestId("import-action"));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    const mutateFn = onCommit.mock.calls[0][0] as (cfg: AppConfig) => AppConfig;
    const mutated = mutateFn(makeAppConfig([a, b, c]));
    expect(mutated.mcp_servers.servers.map((s) => s.id)).toEqual([
      "srv-a",
      "srv-b",
      "srv-c",
      "srv-new",
    ]);
    expect(mutated.mcp_servers.servers[1].display_name).toBe("Imported B");
  });
});
