import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerMcpTrigger } from "../ComposerMcpTrigger";
import { listMcpServerStatus, toggleMcpServer } from "../../../api";
import { TooltipProvider } from "../../ui/tooltip";
import type { McpServerConfig, McpServerRegistry } from "../../../types/mcp";

// The MCP trigger chip + its popover section (issue #369). The session mode
// pins live in the pane-level black box (Shell.test.tsx); these tests cover
// the ADR-0092 / #500 draft mode: a null sessionId reads the session-agnostic
// app-config REGISTRY (never the per-session status query, which needs a live
// session) and routes toggles to onPendingMcpServersChange instead of the
// enable IPC. Rendered inside an empty-catalog English IntlProvider
// (defaultMessage is the canonical source, ADR-0052) with the IPC mocked.
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listMcpServerStatus: vi.fn(),
    toggleMcpServer: vi.fn(async () => {}),
  };
});

function server(id: string): McpServerConfig {
  return {
    id,
    display_name: id,
    transport: { type: "stdio", command: "/bin/srv", args: [] },
    env: {},
    keychain_env_keys: [],
    timeout_ms: null,
  };
}

function registryOf(ids: string[]): McpServerRegistry {
  return { servers: ids.map(server) };
}

function renderTrigger(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const DRAFT_PROPS = {
  loading: false,
  onOpenSettingsMcp: vi.fn(),
};

describe("ComposerMcpTrigger draft mode (ADR-0092 / #500)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listMcpServerStatus).mockResolvedValue([]);
  });

  it("does not call listMcpServerStatus when sessionId is null", () => {
    renderTrigger(
      <ComposerMcpTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        registry={registryOf(["srv"])}
        pendingMcpServers={[]}
        onPendingMcpServersChange={vi.fn()}
      />,
    );
    expect(listMcpServerStatus).not.toHaveBeenCalled();
  });

  it("shows the pending enable count over the registry total (empty set initial)", () => {
    renderTrigger(
      <ComposerMcpTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        registry={registryOf(["srv-a", "srv-b"])}
        pendingMcpServers={[]}
        onPendingMcpServersChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "MCP (0/2)" })).toBeInTheDocument();
  });

  it("shows a non-empty pending list in the chip count", () => {
    renderTrigger(
      <ComposerMcpTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        registry={registryOf(["srv-a", "srv-b"])}
        pendingMcpServers={["srv-b"]}
        onPendingMcpServersChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "MCP (1/2)" })).toBeInTheDocument();
  });

  it("lists the registry servers in the popover and routes a pick to onPendingMcpServersChange (no enable IPC)", async () => {
    const onPendingMcpServersChange = vi.fn();
    renderTrigger(
      <ComposerMcpTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        registry={registryOf(["srv-a"])}
        pendingMcpServers={[]}
        onPendingMcpServersChange={onPendingMcpServersChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /MCP/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Toggle MCP server srv-a" });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(onPendingMcpServersChange).toHaveBeenCalledWith(["srv-a"]);
    expect(toggleMcpServer).not.toHaveBeenCalled();
  });

  it("renders pending picks checked and routes an unpick to the callback with the id removed", async () => {
    const onPendingMcpServersChange = vi.fn();
    renderTrigger(
      <ComposerMcpTrigger
        sessionId={null}
        {...DRAFT_PROPS}
        registry={registryOf(["srv-a", "srv-b"])}
        pendingMcpServers={["srv-a"]}
        onPendingMcpServersChange={onPendingMcpServersChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /MCP/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Toggle MCP server srv-a" });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onPendingMcpServersChange).toHaveBeenCalledWith([]);
    expect(toggleMcpServer).not.toHaveBeenCalled();
  });

  it("renders the empty registry state with the add-server footer", async () => {
    const onOpenSettingsMcp = vi.fn();
    renderTrigger(
      <ComposerMcpTrigger
        sessionId={null}
        loading={false}
        onOpenSettingsMcp={onOpenSettingsMcp}
        registry={{ servers: [] }}
        pendingMcpServers={[]}
        onPendingMcpServersChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /MCP/ }));
    expect(await screen.findByText("No MCP servers")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add MCP server" }));
    expect(onOpenSettingsMcp).toHaveBeenCalledTimes(1);
  });

  it("keeps the session-mode status IPC when sessionId is non-null", async () => {
    renderTrigger(
      <ComposerMcpTrigger sessionId="sess-1" {...DRAFT_PROPS} />,
    );
    await waitFor(() => expect(listMcpServerStatus).toHaveBeenCalledWith("sess-1"));
  });
});
