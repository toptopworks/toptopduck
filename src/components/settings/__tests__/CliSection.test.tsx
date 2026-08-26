import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";
import { TooltipProvider } from "../../ui/tooltip";
import type { ReactElement } from "react";

import { CliSection } from "../CliSection";
import {
  removeCliTool,
  rescanBuiltinCliTools,
  restoreBuiltinCliTool,
  upsertCliTool,
} from "../../../api";
import { log } from "../../../lib/log";
import { blankCliTool } from "../../../types/cli-tool";
import type { BuiltinScanEntry, BuiltinScanResult } from "../../../types/cli-tool";
import type { AppConfig } from "../../../types/app-config";

// The section drives everything through IPC; mock the API so the test never
// touches Tauri (the McpServerForm.test harness pattern).
vi.mock("../../../api", () => ({
  upsertCliTool: vi.fn(),
  removeCliTool: vi.fn(),
  restoreBuiltinCliTool: vi.fn(),
  rescanBuiltinCliTools: vi.fn(),
}));

// The mount rescan's failure lane logs through the shared sink (issue #683):
// mock it so the assertion pins the log call without a plugin-log IPC.
vi.mock("../../../lib/log", () => ({
  log: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
    builtin_skill_baselines: {},
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
  overrides:
    | {
      name?: string;
      description?: string;
      state: "detected";
      executable: string;
    }
    | {
      name?: string;
      description?: string;
      state?: "dormant" | "conflict";
    },
): BuiltinScanEntry {
  const { name = "pandoc", description = "Convert documents between formats." } =
    overrides;
  if (overrides.state === "detected") {
    return {
      state: "detected",
      name,
      description,
      executable: overrides.executable,
    };
  }
  return { state: overrides.state ?? "dormant", name, description };
}

// One shared default for every describe in this file (issue #683): the
// mount effect rescan resolves quietly -- no builtin rows render and the
// sync callback fires with an empty registry. Per-test expectations
// override this with mockResolvedValueOnce / mockImplementationOnce.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(rescanBuiltinCliTools).mockResolvedValue({
    config: makeAppConfig([]),
    scan: [],
  });
});

describe("CliSection", () => {
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

  it("edits a multi-line tool description in the textarea (issue #683 rider)", async () => {
    // The description is the LLM-facing copy and legitimately runs long;
    // the field is an auto-growing Textarea, not a single-line Input. Pin
    // the multi-line round-trip through save (the value survives the
    // controlled wiring intact).
    vi.mocked(upsertCliTool).mockResolvedValue(makeAppConfig([]));
    renderWithProviders(
      <CliSection appConfig={makeAppConfig([])} onCliToolsChanged={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    fireEvent.change(screen.getByLabelText(/Name \(locked after save\)/), {
      target: { value: "my-pandoc" },
    });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: {
        value: "Converts documents.\nAlso reads markdown and writes docx.",
      },
    });
    fireEvent.change(screen.getByLabelText(/Executable/), {
      target: { value: "pandoc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(upsertCliTool).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "my-pandoc",
          description: "Converts documents.\nAlso reads markdown and writes docx.",
        }),
      );
    });
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
        "Your registration owns this name. Remove it, then rescan.",
      ),
    ).toBeInTheDocument();
    // The mount rescan syncs the returned config (no re-fetch).
    expect(onCliToolsChanged).toHaveBeenCalledWith(makeAppConfig([]));
  });

  it("keeps the pane usable and logs a warning when the mount rescan fails", async () => {
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
    // The silent-in-the-UI failure still lands one log.warn (issue #683):
    // a persistently failing scan stays diagnosable.
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "CliSection",
      "builtin CLI mount rescan failed",
      expect.any(Error),
    );
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

  it("badges a user row that occupies a builtin name (issue #683)", async () => {
    // The registration-list mirror of the builtin panel's conflict row: the
    // user entry owning a shipped name gets the annotation, derived from the
    // same snapshot; other user rows stay unbadged.
    vi.mocked(rescanBuiltinCliTools).mockResolvedValueOnce({
      config: makeAppConfig([]),
      scan: [
        makeScanEntry({ name: "pandoc", state: "conflict" }),
        makeScanEntry({ name: "python", state: "dormant" }),
      ],
    });
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([
          makeTool({ name: "pandoc" }),
          makeTool({ name: "my-tool" }),
        ])}
        onCliToolsChanged={vi.fn()}
      />,
    );
    await screen.findByTestId("builtin-cli-panel");
    const ownerRow = screen.getByTestId("cli-tool-row-pandoc");
    expect(ownerRow).toHaveTextContent("Holds built-in name");
    const otherRow = screen.getByTestId("cli-tool-row-my-tool");
    expect(otherRow).not.toHaveTextContent("Holds built-in name");
  });
});

describe("CliSection rescan write guard and failure lanes (issue #683)", () => {
  it("skips the stale config sync when the mount rescan lands after a user write", async () => {
    // The write-generation guard: the mount rescan read the config BEFORE
    // the toggle's write, so its late response would roll the user's change
    // back. The sync is skipped; the snapshot still applies.
    const staleConfig = makeAppConfig([makeTool()]);
    const next = makeAppConfig([makeTool({ enabled: false })]);
    let resolveMount: (result: BuiltinScanResult) => void = () => {};
    vi.mocked(rescanBuiltinCliTools).mockImplementationOnce(
      () =>
        new Promise<BuiltinScanResult>((resolve) => {
          resolveMount = resolve;
        }),
    );
    vi.mocked(upsertCliTool).mockResolvedValue(next);
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([makeTool()])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    // The user write lands while the mount rescan is still in flight.
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => {
      expect(onCliToolsChanged).toHaveBeenCalledWith(next);
    });
    resolveMount({
      config: staleConfig,
      scan: [makeScanEntry({ name: "python", state: "dormant" })],
    });
    // The snapshot applies (the panel fills), the stale sync does not.
    expect(
      await screen.findByTestId("builtin-cli-row-python"),
    ).toBeInTheDocument();
    expect(onCliToolsChanged).toHaveBeenCalledTimes(1);
    expect(onCliToolsChanged).not.toHaveBeenCalledWith(staleConfig);
  });

  it("skips the stale config sync when the manual rescan lands after a user write", async () => {
    // The same guard covers the manual path: a toggle landing mid-scan
    // blocks the scan's config sync; the refreshed snapshot still applies.
    const staleConfig = makeAppConfig([makeTool()]);
    const next = makeAppConfig([makeTool({ enabled: false })]);
    vi.mocked(upsertCliTool).mockResolvedValue(next);
    let resolveRescan: (result: BuiltinScanResult) => void = () => {};
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([makeTool()])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    // Let the mount rescan settle on the shared default first.
    await waitFor(() => {
      expect(rescanBuiltinCliTools).toHaveBeenCalledTimes(1);
    });
    vi.mocked(rescanBuiltinCliTools).mockImplementationOnce(
      () =>
        new Promise<BuiltinScanResult>((resolve) => {
          resolveRescan = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => {
      expect(onCliToolsChanged).toHaveBeenCalledWith(next);
    });
    resolveRescan({
      config: staleConfig,
      scan: [
        makeScanEntry({
          name: "python",
          state: "detected",
          executable: "python3",
        }),
      ],
    });
    // The refreshed snapshot renders; the stale sync never fires.
    expect(
      await screen.findByTestId("builtin-cli-row-python"),
    ).toBeInTheDocument();
    expect(screen.getByText("python3")).toBeInTheDocument();
    expect(onCliToolsChanged).toHaveBeenCalledTimes(2); // mount + toggle
    expect(onCliToolsChanged).toHaveBeenLastCalledWith(next);
  });

  it("syncs the rescan's config when the user write completed before the rescan started", async () => {
    // The guard's negative control: it skips only responses that predate
    // an applied user write. A rescan launched after a write has fully
    // landed captures the post-write generation and syncs normally --
    // proving the guard is a per-response check, not "any write ever
    // happened, skip forever" (that regression would leave the
    // registration list stale after every write and pass every other
    // test in this file).
    const postWrite = makeAppConfig([makeTool({ enabled: false })]);
    const rescanned = makeAppConfig([
      makeTool({ enabled: false }),
      makeTool({ name: "python", executable: "python3" }),
    ]);
    vi.mocked(upsertCliTool).mockResolvedValue(postWrite);
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([makeTool()])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    // Let the mount rescan settle on the shared default, then complete a
    // user write (the toggle) BEFORE issuing the manual rescan.
    await waitFor(() => {
      expect(rescanBuiltinCliTools).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => {
      expect(onCliToolsChanged).toHaveBeenCalledWith(postWrite);
    });
    vi.mocked(rescanBuiltinCliTools).mockResolvedValueOnce({
      config: rescanned,
      scan: [
        makeScanEntry({ name: "python", state: "detected", executable: "python3" }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(
      await screen.findByTestId("builtin-cli-row-python"),
    ).toBeInTheDocument();
    // The fresh response syncs its config: the guard did not trip.
    await waitFor(() => {
      expect(onCliToolsChanged).toHaveBeenLastCalledWith(rescanned);
    });
  });

  it("pins the in-flight scanning state (disabled button + Scanning label)", async () => {
    let resolveRescan: (result: BuiltinScanResult) => void = () => {};
    renderWithProviders(
      <CliSection appConfig={makeAppConfig([])} onCliToolsChanged={vi.fn()} />,
    );
    await waitFor(() => {
      expect(rescanBuiltinCliTools).toHaveBeenCalledTimes(1);
    });
    vi.mocked(rescanBuiltinCliTools).mockImplementationOnce(
      () =>
        new Promise<BuiltinScanResult>((resolve) => {
          resolveRescan = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    // In flight: the button is disabled and swaps its label.
    expect(screen.getByRole("button", { name: "Scanning…" })).toBeDisabled();
    resolveRescan({ config: makeAppConfig([]), scan: [] });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Rescan" })).toBeEnabled();
    });
  });

  it("surfaces a rejected manual rescan and resets the scanning state", async () => {
    // The manual path's error half: the rejection renders through the
    // shared error lane, and the scanning state resets (the button
    // re-enables, the label returns) so a retry is possible.
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    // Queue the rejection for the MANUAL call (the mount call settles on
    // the shared default first).
    await waitFor(() => {
      expect(rescanBuiltinCliTools).toHaveBeenCalledTimes(1);
    });
    vi.mocked(rescanBuiltinCliTools).mockRejectedValueOnce(
      new Error("scan down"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    expect(await screen.findByText("scan down")).toBeInTheDocument();
    expect(screen.queryByText("Scanning…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rescan" })).toBeEnabled();
    // A failed manual rescan syncs nothing: only the mount call's sync.
    expect(onCliToolsChanged).toHaveBeenCalledTimes(1);
  });
});

describe("CliSection baseline lifecycle (issue #676)", () => {
  it("gates the row actions by source and baseline", () => {
    // A builtin row has no delete entry point (undeletable -- disabling is
    // the single shutdown axis) and no restore while it still follows the
    // baseline; a user row keeps the delete.
    const builtin = makeTool({
      name: "pandoc",
      source: "builtin",
      baseline: "following",
    });
    const user = makeTool({ name: "my-pandoc" });
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([builtin, user])}
        onCliToolsChanged={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Delete tool pandoc" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "Restore built-in definition for tool pandoc",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete tool my-pandoc" }),
    ).toBeInTheDocument();
  });

  it("routes through restore after the confirmation on an edited builtin row", async () => {
    const edited = makeTool({
      name: "pandoc",
      source: "builtin",
      baseline: "edited",
    });
    const next = makeAppConfig([
      makeTool({ name: "pandoc", source: "builtin", baseline: "following" }),
    ]);
    // A deferred restore: the busy state is pinned while the IPC is in
    // flight (not just after it resolves).
    let resolveRestore: (value: AppConfig) => void = () => {};
    vi.mocked(restoreBuiltinCliTool).mockImplementation(
      () =>
        new Promise<AppConfig>((resolve) => {
          resolveRestore = resolve;
        }),
    );
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([edited])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    // An EDITED builtin row is still undeletable: the restore is its only
    // row action (the gating matrix's fourth cell).
    expect(
      screen.queryByRole("button", { name: "Delete tool pandoc" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Restore built-in definition for tool pandoc",
      }),
    );
    // The confirmation gate (the overwrite is irreversible): the restore
    // button exists only because the dialog opened.
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    // In flight: Radix auto-close is prevented, the busy label renders,
    // and both dialog buttons stay disabled until the IPC settles.
    expect(screen.getByText("Restoring…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    resolveRestore(next);
    await waitFor(() => {
      expect(restoreBuiltinCliTool).toHaveBeenCalledWith("pandoc");
      // The ADR-0109 Decision 9 contract: the command already persisted and
      // returned the full config -- the sync is a whole-snapshot replace.
      expect(onCliToolsChanged).toHaveBeenCalledWith(next);
    });
    // Settled: the confirmation dialog closes.
    expect(
      screen.queryByText("Restore built-in definition for pandoc?"),
    ).not.toBeInTheDocument();
  });

  it("surfaces a rejected restore and keeps the edited row", async () => {
    // The confirm lane's error half: the IPC rejection renders through the
    // pane error lane (runCommit's catch), the dialog closes, and the row
    // keeps its edited state -- no partial sync.
    const edited = makeTool({
      name: "pandoc",
      source: "builtin",
      baseline: "edited",
    });
    vi.mocked(restoreBuiltinCliTool).mockRejectedValue(new Error("ipc down"));
    const onCliToolsChanged = vi.fn();
    renderWithProviders(
      <CliSection
        appConfig={makeAppConfig([edited])}
        onCliToolsChanged={onCliToolsChanged}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Restore built-in definition for tool pandoc",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByText("ipc down")).toBeInTheDocument();
    // No partial sync: the only onCliToolsChanged call is the mount
    // rescan's sync (the empty registry), never a snapshot after a restore
    // that did not land -- and the row still offers the restore (the
    // edited body is intact for a retry).
    expect(restoreBuiltinCliTool).toHaveBeenCalledTimes(1);
    expect(onCliToolsChanged).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", {
        name: "Restore built-in definition for tool pandoc",
      }),
    ).toBeInTheDocument();
  });
});
