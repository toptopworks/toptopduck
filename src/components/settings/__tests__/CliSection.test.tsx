import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import type { ReactElement } from "react";

import { CliSection } from "../CliSection";
import { removeCliTool, upsertCliTool } from "../../../api";
import { blankCliTool } from "../../../types/cli-tool";
import type { AppConfig } from "../../../types/app-config";

// The section drives everything through IPC; mock the API so the test never
// touches Tauri (the McpServerForm.test harness pattern).
vi.mock("../../../api", () => ({
  upsertCliTool: vi.fn(),
  removeCliTool: vi.fn(),
}));

function makeTool(overrides: Partial<Parameters<typeof upsertCliTool>[0]> = {}) {
  return {
    ...blankCliTool(),
    name: "pandoc",
    description: "Convert documents",
    executable: "pandoc",
    argv_template: ["{input}"],
    params: [
      {
        name: "input",
        description: "source file",
        delivery: "argv" as const,
        varargs: false,
      },
    ],
    ...overrides,
  };
}

function makeAppConfig(tools: ReturnType<typeof makeTool>[]): AppConfig {
  return {
    format_version: 2,
    theme: "system",
    locale: "system",
    engine: {
      memory_limit: "1GB",
      threads: 1,
      row_cap: 1000,
      statement_timeout_ms: 30000,
    },
    privacy: { send_samples: true },
    provider: {
      profiles: [],
      active_profile: null,
    },
    export: { include_samples: true },
    tunables: { window_turns: 6 },
    shell: { sidebar_collapsed: false, sidebar_grouping: "flat" },
    mcp_servers: { servers: [] },
    cli_tools: { tools },
    sessions_dir: null,
    default_runtime: "built_in",
    last_model_postures: {},
  } as unknown as AppConfig;
}

// Empty-catalog English IntlProvider: FormattedMessage falls back to
// defaultMessage, so assertions anchor on stable English strings.
function renderWithProviders(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <TooltipProvider>{ui}</TooltipProvider>
    </IntlProvider>,
  );
}

describe("CliSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the empty state when nothing is registered", () => {
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    expect(
      screen.getByText("No CLI tools registered yet. Click New to register one."),
    ).toBeInTheDocument();
    expect(onCliToolsChanged).not.toHaveBeenCalled();
  });

  it("renders one row per registered tool with its executable", () => {
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([makeTool()])}
        onCliToolsChanged={vi.fn()}
      />,
    );
    expect(screen.getByTestId("cli-tool-row-pandoc")).toBeInTheDocument();
    expect(screen.getByText("pandoc")).toBeInTheDocument();
    expect(screen.getByText(/1 parameters/)).toBeInTheDocument();
  });

  it("offers the three delivery channels per parameter row (issue #672)", () => {
    // The form declares delivery per parameter (argv / file / stdin,
    // ADR-0108 Decision 4): the select rides every parameter row, defaulting
    // to argv. Static-render only -- the option semantics are the backend
    // validation's tests; here we pin the form surface exists per row.
    renderWithProviders(
      <CliSection appConfig={makeAppConfig([])} onCliToolsChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.click(screen.getByRole("button", { name: "Add parameter" }));
    fireEvent.click(screen.getByRole("button", { name: "Add parameter" }));
    const deliveries = screen.getAllByRole("combobox", {
      name: /Value delivery \(row \d\)/,
    });
    expect(deliveries).toHaveLength(2);
  });

  it("syncs the returned full config after the enable toggle's upsert", async () => {
    const next = makeAppConfig([makeTool({ enabled: false })]);
    vi.mocked(upsertCliTool).mockResolvedValue(next);
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([makeTool()])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => {
      expect(upsertCliTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "pandoc", enabled: false }),
      );
    });
    // The ADR-0109 Decision 9 contract: the command already persisted and
    // returned the full config -- the sync is a whole-snapshot state
    // replace (reference equality), with no second disk write.
    expect(onCliToolsChanged).toHaveBeenCalledWith(next);
    expect(onCliToolsChanged.mock.calls[0][0]).toBe(next);
  });

  it("routes through remove after the delete confirmation", async () => {
    const next = makeAppConfig([]);
    vi.mocked(removeCliTool).mockResolvedValue(next);
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([makeTool()])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete tool pandoc" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(removeCliTool).toHaveBeenCalledWith("pandoc");
      // The removal's returned full config syncs state the same way.
      expect(onCliToolsChanged).toHaveBeenCalledWith(next);
    });
  });
});
