import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { listAdapters, setDefaultRuntime } from "../../../api";
import type { AppConfig } from "../../../types/app-config";
import type { AdapterEntry } from "../../../types/runtime";
import { DefaultRuntimeControl } from "../DefaultRuntimeControl";
import { chooseOption, openSelect, renderSettings } from "./helpers";

// Default runtime control tests (issue #571, ADR-0098 Decision 2/3): the
// machine-level "default runtime" row at the top of the Runtime pane. Covers
// the option-set filtering (built-in + detected only), the stale persisted
// value surfacing (undetected adapter kept per ADR-0098 Decision 3), the
// draft + Save flow over the dedicated setDefaultRuntime IPC, the failure
// path (draft survives + inline error), and the close-guard busy reporting.

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listAdapters: vi.fn(),
    setDefaultRuntime: vi.fn(),
  };
});

const mockAdapters: AdapterEntry[] = [
  { id: "gemini-cli", display_name: "gemini-cli", detected: true, binary_path: "/usr/bin/gemini", stream_format: "acp" },
  { id: "codex", display_name: "codex", detected: false, binary_path: null, stream_format: "codex_event_stream" },
  { id: "opencode", display_name: "opencode", detected: true, binary_path: "/opt/homebrew/bin/opencode", stream_format: "acp" },
];

// The config the write IPC returns after persisting (mirrors the sessions-dir
// dedicated-IPC shape: persist + return the updated document for feed-back).
const updatedConfig: AppConfig = {
  format_version: 1,
  theme: "system",
  locale: "system",
  engine: { memory_limit: "512MB", threads: 4, row_cap: 10_000 },
  privacy: { send_samples: false },
  provider: {
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
  },
  export: { last_dir: null, default_format: "csv" },
  tunables: { window_turns: 5, far_window: 20 },
  shell: { sidebar_collapsed: false, sidebar_grouping: "time" },
  cli_tools: { tools: [] },
  mcp_servers: { servers: [] },
  sessions_dir: null,
  default_runtime: { kind: "built_in" },
  builtin_skill_baselines: {},
  last_model_postures: {},
};

function renderControl(
  overrides: Partial<React.ComponentProps<typeof DefaultRuntimeControl>> = {},
) {
  const props: React.ComponentProps<typeof DefaultRuntimeControl> = {
    defaultRuntime: { kind: "built_in" },
    onSaved: vi.fn(),
    onIpcBusy: vi.fn(),
    ...overrides,
  };
  return renderSettings(<DefaultRuntimeControl {...props} />);
}

// openSelect / chooseOption (Radix jsdom interaction) live in ./helpers,
// shared with the SettingsView + RuntimeSection suites.

describe("DefaultRuntimeControl (issue #571, ADR-0098)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdapters).mockResolvedValue(mockAdapters);
    vi.mocked(setDefaultRuntime).mockResolvedValue(updatedConfig);
  });

  // --- Option set -----------------------------------------------------------

  it("lists Built-in and only detected adapters under the two group labels", async () => {
    renderControl();
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    // The SelectValue text lands only once the adapter query has resolved and
    // the options exist -- a deterministic open gate.
    await waitFor(() => expect(combobox).toHaveTextContent("Built-in"));
    openSelect(combobox);

    // The group labels reuse the runtime section's sub-tab vocabulary.
    expect(screen.getByText("API Access")).toBeInTheDocument();
    expect(screen.getByText("Local CLI")).toBeInTheDocument();

    expect(screen.getByRole("option", { name: "Built-in" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "gemini-cli" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "opencode" })).toBeInTheDocument();
    // The undetected adapter is not selectable.
    expect(screen.queryByRole("option", { name: "codex" })).not.toBeInTheDocument();
  });

  it("renders only the Built-in option when no adapter is detected", async () => {
    vi.mocked(listAdapters).mockResolvedValue([
      { id: "codex", display_name: "codex", detected: false, binary_path: null, stream_format: "codex_event_stream" },
    ]);
    renderControl();
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    openSelect(combobox);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Built-in");
  });

  // --- Stale persisted value (ADR-0098 Decision 3) --------------------------

  it("surfaces an undetected persisted adapter as an annotated current value", async () => {
    renderControl({ defaultRuntime: { kind: "external", data: "codex" } });

    // The trigger shows the stale value annotated, not a silent Built-in.
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("codex (Not installed)"));

    openSelect(combobox);
    expect(
      screen.getByRole("option", { name: "codex (Not installed)" }),
    ).toBeInTheDocument();
  });

  it("drops the stale option once the user picks a different runtime", async () => {
    renderControl({ defaultRuntime: { kind: "external", data: "codex" } });
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("codex (Not installed)"));

    openSelect(combobox);
    chooseOption("gemini-cli");
    await waitFor(() => expect(combobox).toHaveTextContent("gemini-cli"));

    openSelect(combobox);
    expect(
      screen.queryByRole("option", { name: "codex (Not installed)" }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the raw id and surfaces the error when the adapter table fails to load", async () => {
    // The read rejects; the query never resolves to a table (retry off in the
    // test client), so the persisted external value has no option to portal
    // its trigger text from. The trigger must fall back to the raw id and the
    // failed read must be visible -- never a silent blank row.
    vi.mocked(listAdapters).mockRejectedValue(new Error("adapter IPC lost"));
    renderControl({ defaultRuntime: { kind: "external", data: "codex" } });

    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("codex"));
    expect(await screen.findByText("adapter IPC lost")).toBeInTheDocument();
  });

  // --- Draft + Save success path ---------------------------------------------

  it("Save is disabled until the selection diverges, then persists the external payload", async () => {
    const onSaved = vi.fn();
    renderControl({ onSaved });
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("Built-in"));
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    openSelect(combobox);
    chooseOption("gemini-cli");
    await waitFor(() => expect(save).toBeEnabled());

    fireEvent.click(save);
    await waitFor(() =>
      expect(vi.mocked(setDefaultRuntime)).toHaveBeenCalledWith({
        kind: "external",
        data: "gemini-cli",
      }),
    );
    // The returned config feeds back through onSaved and the draft clears.
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updatedConfig));
    await waitFor(() => expect(save).toBeDisabled());
  });

  it("persists the built_in payload when switching back from an external default", async () => {
    renderControl({ defaultRuntime: { kind: "external", data: "gemini-cli" } });
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("gemini-cli"));

    openSelect(combobox);
    chooseOption("Built-in");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(vi.mocked(setDefaultRuntime)).toHaveBeenCalledWith({ kind: "built_in" }),
    );
  });

  // --- Failure path -----------------------------------------------------------

  it("keeps the draft and shows an inline error when the write IPC fails", async () => {
    vi.mocked(setDefaultRuntime).mockRejectedValue(new Error("disk full"));
    renderControl();
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("Built-in"));

    openSelect(combobox);
    chooseOption("gemini-cli");
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);

    expect(await screen.findByText("disk full")).toBeInTheDocument();
    // The draft survives the failure (no revert to the persisted value) and
    // Save stays enabled for a retry.
    expect(combobox).toHaveTextContent("gemini-cli");
    expect(save).toBeEnabled();
  });

  // --- Close-guard busy reporting ---------------------------------------------

  it("reports the defaultRuntime busy channel in flight around the Save IPC", async () => {
    const onIpcBusy = vi.fn();
    renderControl({ onIpcBusy });
    const combobox = await screen.findByRole("combobox", { name: "Default runtime" });
    await waitFor(() => expect(combobox).toHaveTextContent("Built-in"));

    openSelect(combobox);
    chooseOption("opencode");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onIpcBusy).toHaveBeenCalledWith("defaultRuntime", true);
      expect(onIpcBusy).toHaveBeenCalledWith("defaultRuntime", false);
    });
    // The busy transition is paired and ordered.
    expect(onIpcBusy.mock.calls).toEqual([
      ["defaultRuntime", true],
      ["defaultRuntime", false],
    ]);
  });
});
