import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import type { ReactElement } from "react";

import { CliSection } from "../CliSection";
import { removeCliTool, rescanBuiltinCliTools, upsertCliTool } from "../../../api";
import { blankCliTool } from "../../../types/cli-tool";
import type { BuiltinScanEntry } from "../../../types/cli-tool";
import type { AppConfig } from "../../../types/app-config";

// The section drives everything through IPC; mock the API so the test never
// touches Tauri (the McpServerForm.test harness pattern).
vi.mock("../../../api", () => ({
  upsertCliTool: vi.fn(),
  removeCliTool: vi.fn(),
  rescanBuiltinCliTools: vi.fn(),
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

function makeScanEntry(
  overrides: Partial<BuiltinScanEntry> = {},
): BuiltinScanEntry {
  return {
    name: "pandoc",
    description: "Convert documents between formats.",
    state: "dormant",
    ...overrides,
  };
}

describe("CliSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The mount effect rescan resolves quietly in every test: no builtin
    // rows render and the sync callback fires with an empty registry (the
    // per-test rescan expectations override this with mockResolvedValueOnce).
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue({
      config: makeAppConfig([]),
      scan: [],
    });
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
    // The mount rescan also syncs `next` so the reference-equality assertion
    // below holds whichever call landed first (mount vs toggle).
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue({
      config: next,
      scan: [],
    });
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

describe("CliSection builtin panel (issue #675)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rescanBuiltinCliTools).mockResolvedValue({
      config: makeAppConfig([]),
      scan: [],
    });
  });

  it("renders the three detection states on mount", async () => {
    const scan = [
      makeScanEntry({
        name: "pandoc",
        state: "detected",
        executable: "pandoc",
      }),
      makeScanEntry({ name: "python", state: "dormant" }),
      makeScanEntry({ name: "office-cli", state: "conflict" }),
    ];
    vi.mocked(rescanBuiltinCliTools).mockResolvedValueOnce({
      config: makeAppConfig([]),
      scan,
    });
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    expect(
      await screen.findByTestId("builtin-cli-row-pandoc"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("builtin-cli-row-python")).toBeInTheDocument();
    expect(screen.getByTestId("builtin-cli-row-office-cli")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Not detected")).toBeInTheDocument();
    expect(screen.getByText("Name conflict")).toBeInTheDocument();
    // The conflict row swaps the description for the disposition hint.
    expect(
      screen.getByText(
        "Your registration owns this name. Rename or remove it, then rescan.",
      ),
    ).toBeInTheDocument();
    // The mount rescan syncs the returned config (no re-fetch).
    expect(onCliToolsChanged).toHaveBeenCalledWith(makeAppConfig([]));
  });

  it("keeps the pane usable when the mount rescan fails silently", async () => {
    vi.mocked(rescanBuiltinCliTools).mockRejectedValueOnce(new Error("ipc down"));
    renderWithProviders(
      <CliSection appConfig={makeAppConfig([])} onCliToolsChanged={vi.fn()} />,
    );
    // No builtin panel renders and no error lane fires from the mount scan;
    // only the explicit Rescan button surfaces errors.
    await waitFor(() => {
      expect(rescanBuiltinCliTools).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("builtin-cli-panel")).not.toBeInTheDocument();
    expect(screen.queryByText(/ipc down/)).not.toBeInTheDocument();
  });

  it("refreshes the snapshot and syncs the config on the Rescan button", async () => {
    vi.mocked(rescanBuiltinCliTools).mockResolvedValueOnce({
      config: makeAppConfig([]),
      scan: [makeScanEntry({ name: "python", state: "dormant" })],
    });
    const next = {
      config: makeAppConfig([]),
      scan: [
        makeScanEntry({
          name: "python",
          state: "detected",
          executable: "python3",
        }),
      ],
    };
    vi.mocked(rescanBuiltinCliTools).mockResolvedValueOnce(next);
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    // Wait for the mount scan to land, then click the manual rescan.
    await screen.findByTestId("builtin-cli-row-python");
    expect(screen.getByText("Not detected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(await screen.findByText("Installed")).toBeInTheDocument();
    expect(onCliToolsChanged).toHaveBeenLastCalledWith(next.config);
  });

  it("badges builtin rows and disabled rows on the registration list", () => {
    const builtin = makeTool({
      name: "pandoc",
      source: "builtin",
      baseline: "following",
    });
    const disabledUser = makeTool({ name: "my-tool", enabled: false });
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([builtin, disabledUser])}
        onCliToolsChanged={vi.fn()}
      />,
    );
    const builtinRow = screen.getByTestId("cli-tool-row-pandoc");
    expect(builtinRow).toHaveTextContent("Built-in");
    expect(builtinRow).not.toHaveTextContent("Disabled");
    const disabledRow = screen.getByTestId("cli-tool-row-my-tool");
    expect(disabledRow).toHaveTextContent("Disabled");
    expect(disabledRow).not.toHaveTextContent("Built-in");
  });
});
