import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerProviderPicker } from "../ComposerProviderPicker";
import {
  clearLastModelPosture,
  getAdapterCatalogs,
  getLastModelPosture,
  getSessionModelConfig,
  getSessionRuntime,
  listAdapters,
  listProviderProfiles,
  setSessionModel,
  setSessionRuntime,
  setSessionThoughtLevel,
  type SetModelPersistOutcome,
} from "../../../api";
import { TooltipProvider } from "../../ui/tooltip";
import { adapterKeys } from "../../../session/queryKeys";
import type { ProviderConfig, ProfileKeyStatus } from "../../../types/provider";
import type { AdapterEntry, AdapterCatalogs } from "../../../types/runtime";

// ComposerProviderPicker tests (ADR-0099, issue #574): the two-level
// runtime popover + the brain-icon trigger + the posture text button's
// integration (four-state label, set-IPC writes, cold-start pending
// channel). Rendered inside an empty-catalog English IntlProvider so
// assertions anchor on stable English strings. The IPC surface is mocked so
// the view never hits Tauri.
//
// The dropdown-menu module is mocked as always-open controlled components
// (cf. SessionHeaderMenu.test.tsx -- Radix menu pointer handling recurses
// under jsdom), so the posture cascade's second-level rows are directly
// clickable without opening animations.

vi.mock("@/components/ui/dropdown-menu", async () =>
  (await import("./dropdownMenuMock")).dropdownMenuMockModule,
);

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listProviderProfiles: vi.fn(),
    getSessionRuntime: vi.fn(),
    setSessionRuntime: vi.fn(async () => {}),
    listAdapters: vi.fn(),
    getSessionModelConfig: vi.fn(),
    setSessionModel: vi.fn(async () => PERSIST_OK),
    setSessionThoughtLevel: vi.fn(async () => PERSIST_OK),
    getAdapterCatalogs: vi.fn(async () => ({})),
    getLastModelPosture: vi.fn(async () => EMPTY_POSTURE),
    clearLastModelPosture: vi.fn(async () => ({})),
  };
});

// The set commands' clean persist verdict (issue #529): the write landed.
const PERSIST_OK: SetModelPersistOutcome = {
  persist_error: null,
  persist_suspended: false,
};

const EMPTY_POSTURE = { model: null, thought_level: null };

// The shared ACP handshake catalog fixture (issue #527).
const CATALOG = {
  models: ["fake-opus", "fake-sonnet"],
  current_model: "fake-opus",
  thought_levels: ["low", "medium", "high"],
  current_thought_level: "medium",
};

function wrap(ui: ReactElement, queryClient: QueryClient): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
      </IntlProvider>
    </QueryClientProvider>
  );
}

function renderPicker(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return { queryClient, ...render(wrap(ui, queryClient)) };
}

function pickerProvider(activeId: string = "anthropic"): ProviderConfig {
  return {
    profiles: [
      {
        id: "anthropic",
        display_name: "Anthropic",
        protocol: "anthropic",
        base_url: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
      },
      {
        id: "glm",
        display_name: "GLM",
        protocol: "openai",
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        model: "",
      },
    ],
    active_profile: activeId,
  };
}

function keyStatus(rows: Array<[string, boolean, string?]>): ProfileKeyStatus[] {
  return rows.map(([profile_id, has_key, fault]) => ({
    profile_id,
    has_key,
    keychain_fault: fault ?? null,
  }));
}

function adapter(
  id: string,
  display_name: string = id,
  detected: boolean = true,
): AdapterEntry {
  return {
    id,
    display_name,
    detected,
    binary_path: detected ? `/usr/local/bin/${id}` : null,
    stream_format: "acp",
  };
}

function codexAdapter(id: string): AdapterEntry {
  return { ...adapter(id), stream_format: "codex_event_stream" };
}

// The probe-cache entry fixture for an ACP adapter (issue #537).
function acpProbeEntry(catalog: typeof CATALOG): AdapterCatalogs {
  return {
    "qwen-code": {
      probe_kind: "acp",
      outcome: { acp: { discovered: { ...catalog, adapter_id: "qwen-code" } } },
      probed_at_millis: 0,
    },
  };
}

// The built-in runtime is the default; the trigger's accessible name carries
// the active provider (ADR-0071 readout).
const BUILTIN_TRIGGER = "Runtime: Anthropic";

type PickerOverrides = Partial<Parameters<typeof ComposerProviderPicker>[0]>;

function pickerJsx(overrides: PickerOverrides = {}) {
  return (
    <ComposerProviderPicker
      sessionId="sess-1"
      provider={pickerProvider()}
      onSwitchActive={vi.fn()}
      onOpenSettings={vi.fn()}
      {...overrides}
    />
  );
}

async function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
  await screen.findByText("API Access");
}

// The level-2 selects' aria labels (stable anchors for the combobox queries).
const PROFILE_SELECT = "API profile";
const CLI_SELECT = "Local CLI";

/** Opens a Radix Select (pointerDown + click, the jsdom-verified sequence). */
async function openSelect(trigger: Element) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.click(trigger);
  // A wildcard findByRole("option") throws on multiple matches; wait on the
  // count instead.
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
}

/** Opens a Radix Select and clicks the option matching the given text. */
async function selectOption(trigger: Element, optionText: RegExp): Promise<void> {
  await openSelect(trigger);
  const option = screen.getByRole("option", { name: optionText });
  fireEvent.pointerUp(option, { button: 0, pointerType: "mouse" });
  fireEvent.click(option);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listProviderProfiles).mockResolvedValue([]);
  // The built-in runtime is the honest default (ADR-0081).
  vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
  vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
  vi.mocked(listAdapters).mockResolvedValue([]);
  // ADR-0095: the honest model-config default (no selection, no cache).
  vi.mocked(getSessionModelConfig).mockResolvedValue({
    model: null,
    thought_level: null,
    cached_discovered: null,
  });
  vi.mocked(getAdapterCatalogs).mockResolvedValue({});
  vi.mocked(getLastModelPosture).mockResolvedValue(EMPTY_POSTURE);
});

// ---------------------------------------------------------------------------
// Trigger + two-level popover (ADR-0099 Decisions 1/2)
// ---------------------------------------------------------------------------

describe("ComposerProviderPicker two-level popover (ADR-0099)", () => {
  it("renders the icon trigger with an accessible name carrying the active provider", () => {
    renderPicker(pickerJsx());
    expect(screen.getByRole("button", { name: BUILTIN_TRIGGER })).toBeTruthy();
  });

  it("opens the popover with the two level-1 radio groups mirroring the settings tab names", async () => {
    renderPicker(pickerJsx());
    await openPopover();
    expect(screen.getByText("API Access")).toBeTruthy();
    expect(screen.getByText("Local CLI")).toBeTruthy();
  });

  it("retires the configuration surfaces from the popover (model input, key block, open-settings)", async () => {
    renderPicker(pickerJsx());
    await openPopover();
    // ADR-0099 Decision 1: the popover is a pure selector -- configuration
    // lives in Settings.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Key set")).toBeNull();
    expect(screen.queryByText("No key")).toBeNull();
    expect(screen.queryByText("Open settings")).toBeNull();
  });

  it("echoes the active profile in the level-2 profile select and lists every profile", async () => {
    renderPicker(pickerJsx());
    await openPopover();
    const trigger = screen.getByRole("combobox", { name: PROFILE_SELECT });
    expect(trigger.textContent).toContain("Anthropic");
    await openSelect(trigger);
    expect(screen.getByRole("option", { name: "Anthropic" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "GLM" })).toBeTruthy();
  });

  it("switches active_profile when a profile option is picked", async () => {
    const onSwitchActive = vi.fn();
    renderPicker(pickerJsx({ onSwitchActive }));
    await openPopover();
    await selectOption(
      screen.getByRole("combobox", { name: PROFILE_SELECT }),
      /GLM/,
    );
    expect(onSwitchActive).toHaveBeenCalledWith("glm");
    // Already on the built-in runtime: no runtime write fires.
    expect(setSessionRuntime).not.toHaveBeenCalled();
  });

  it("reverts the runtime to built-in when a profile option is picked while external", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "qwen-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
    fireEvent.click(screen.getByRole("button", { name: /Runtime: qwen-code/ }));
    await screen.findByText("Local CLI");
    await selectOption(
      screen.getByRole("combobox", { name: PROFILE_SELECT }),
      /GLM/,
    );
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", { kind: "built_in" }),
    );
  });

  it("renders the not-configured placeholder when the profile set is empty (issue #570)", async () => {
    renderPicker(
      pickerJsx({ provider: { profiles: [], active_profile: null } }),
    );
    // Zero profiles: the trigger's readout is itself "Not configured".
    fireEvent.click(screen.getByRole("button", { name: "Runtime: Not configured" }));
    await screen.findByText("API Access");
    // The popover's level-2 placeholder + the posture label both read
    // "Not configured"; the assertion pins that no profile select renders.
    expect(screen.getAllByText("Not configured").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole("combobox", { name: PROFILE_SELECT })).toBeNull();
  });

  it("marks keyless profiles at the option level (ADR-0019/0099)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([
        ["anthropic", false],
        ["glm", true],
      ]),
    );
    renderPicker(pickerJsx());
    await openPopover();
    // The mark lands on the Anthropic option (await: the key overlay fetch
    // is a mount-time effect), never on the keyed GLM option.
    const trigger = screen.getByRole("combobox", { name: PROFILE_SELECT });
    await openSelect(trigger);
    const mark = await screen.findByText("no key");
    expect(mark.closest("[role=\"option\"]")?.textContent).toContain("Anthropic");
    const glmOption = screen.getByRole("option", { name: /GLM/ });
    expect(glmOption.textContent).not.toContain("no key");
  });

  it("marks a profile whose keychain read failed", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false, "keychain locked"]]),
    );
    renderPicker(pickerJsx());
    await openPopover();
    const trigger = screen.getByRole("combobox", { name: PROFILE_SELECT });
    await openSelect(trigger);
    const mark = await screen.findByText("Keychain unavailable");
    expect(mark.closest("[role=\"option\"]")?.textContent).toContain("Anthropic");
  });

  it("offers only detected external adapters as level-2 CLI options", async () => {
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("qwen-code", "qwen-code", true),
      adapter("gemini-cli", "gemini-cli", false),
    ]);
    renderPicker(pickerJsx());
    await openPopover();
    await openSelect(screen.getByRole("combobox", { name: CLI_SELECT }));
    expect(screen.getByRole("option", { name: /qwen-code/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /gemini-cli/ })).toBeNull();
  });

  it("writes the external choice when a detected CLI option is picked", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await openPopover();
    await selectOption(
      screen.getByRole("combobox", { name: CLI_SELECT }),
      /qwen-code/,
    );
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
        kind: "external",
        data: "qwen-code",
      }),
    );
  });

  it("selects the first detected CLI when the Local CLI level-1 row is picked from built-in", async () => {
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("qwen-code"),
      adapter("codex"),
    ]);
    renderPicker(pickerJsx());
    await openPopover();
    fireEvent.click(screen.getByRole("button", { name: "Local CLI" }));
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
        kind: "external",
        data: "qwen-code",
      }),
    );
  });

  it("keeps the CLI select echo honest when switching back to built-in within one popover visit", async () => {
    // The CLI Select must stay controlled across the runtime switch: an
    // uncontrolled fallback would re-echo the previously picked adapter
    // while level 1 already shows API Access selected.
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await openPopover();
    await selectOption(screen.getByLabelText(CLI_SELECT), /qwen-code/);
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
        kind: "external",
        data: "qwen-code",
      }),
    );
    // Switch back via the API Access level-1 row.
    fireEvent.click(screen.getByRole("button", { name: "API Access" }));
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
        kind: "built_in",
      }),
    );
    // The CLI trigger falls back to the placeholder, not the stale echo.
    expect(screen.getByLabelText(CLI_SELECT).textContent).toBe("—");
  });

  it("shows a stale-adapter warning when the held CLI is no longer detected", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "gemini-cli",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: gemini-cli/ });
    fireEvent.click(screen.getByRole("button", { name: /Runtime: gemini-cli/ }));
    expect(
      await screen.findByText(/Selected adapter is no longer detected/),
    ).toBeTruthy();
    // The closed CLI select still echoes the held (undetected) adapter via
    // the disabled synthetic option -- a blank echo would hide the breakage.
    const cliTrigger = screen.getByRole("combobox", { name: CLI_SELECT });
    expect(cliTrigger.textContent).toContain("gemini-cli");
  });

  it("retires the settings-test guidance from the popover when the active CLI has no catalog", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "qwen-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
    fireEvent.click(screen.getByRole("button", { name: /Runtime: qwen-code/ }));
    await screen.findByText("Manage runtimes");
    expect(
      screen.queryByText(/Test the runtime in settings/),
    ).toBeNull();
  });

  it("opens settings from the Manage link and closes the popover", async () => {
    const onOpenSettings = vi.fn();
    renderPicker(pickerJsx({ onOpenSettings }));
    await openPopover();
    fireEvent.click(screen.getByText("Manage runtimes"));
    expect(onOpenSettings).toHaveBeenCalledWith();
  });

  it("does not call getSessionRuntime when sessionId is null", () => {
    renderPicker(
      pickerJsx({ sessionId: null, onPendingRuntimeChange: vi.fn() }),
    );
    expect(getSessionRuntime).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: BUILTIN_TRIGGER }),
    ).toBeTruthy();
  });

  it("routes a runtime selection to onPendingRuntimeChange when sessionId is null", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    const onPendingRuntimeChange = vi.fn();
    renderPicker(
      pickerJsx({ sessionId: null, onPendingRuntimeChange }),
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    await screen.findByText("Local CLI");
    await selectOption(
      screen.getByRole("combobox", { name: CLI_SELECT }),
      /qwen-code/,
    );
    expect(onPendingRuntimeChange).toHaveBeenCalledWith({
      kind: "external",
      data: "qwen-code",
    });
    expect(setSessionRuntime).not.toHaveBeenCalled();
  });

  it("renders the pendingRuntime prop in the trigger name when sessionId is null (issue #572)", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(
      pickerJsx({
        sessionId: null,
        onPendingRuntimeChange: vi.fn(),
        pendingRuntime: { kind: "external", data: "qwen-code" },
      }),
    );
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
  });
});

// ---------------------------------------------------------------------------
// Posture text button integration (ADR-0099 D3 / ADR-0100, issues #573/#574)
// ---------------------------------------------------------------------------

// Seed an external ACP runtime with the given model config + adapter table,
// render, and wait for the posture surface to settle.
async function renderExternalPicker(
  overrides: PickerOverrides = {},
  modelConfig: {
    model?: string | null;
    thought_level?: string | null;
    cached_discovered?: typeof CATALOG | null;
  } = {},
) {
  vi.mocked(getSessionRuntime).mockResolvedValue({
    kind: "external",
    data: "qwen-code",
  });
  vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
  vi.mocked(getSessionModelConfig).mockResolvedValue({
    model: modelConfig.model ?? null,
    thought_level: modelConfig.thought_level ?? null,
    cached_discovered: modelConfig.cached_discovered ?? null,
  });
  renderPicker(pickerJsx(overrides));
  // The posture trigger renders once the runtime query lands.
  await screen.findByRole("button", { name: /Runtime: qwen-code/ });
}

describe("ComposerProviderPicker posture button four-state label (ADR-0099 D3, issue #573)", () => {
  it("shows the active profile's model as a static label on the built-in runtime", () => {
    renderPicker(pickerJsx());
    // Static: the four-state label renders, but NOT as a button (no arrow,
    // no menu -- profile.model is configured in Settings, ADR-0099).
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Model:/ })).toBeNull();
  });

  it("switches the label with the runtime within one popover visit", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    // Built-in: the label is the active profile's model.
    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy();
    await openPopover();
    await selectOption(
      screen.getByRole("combobox", { name: CLI_SELECT }),
      /qwen-code/,
    );
    // External with no catalog: the label switches to the CLI default and
    // the profile model readout is gone.
    expect(await screen.findByText("Default (recommended)")).toBeTruthy();
    expect(screen.queryByText("claude-sonnet-4-6")).toBeNull();
    // Back to built-in via the level-1 row: the label returns to the
    // profile model and the CLI default readout is gone.
    fireEvent.click(screen.getByRole("button", { name: "API Access" }));
    expect(await screen.findByText("claude-sonnet-4-6")).toBeTruthy();
    expect(screen.queryByText("Default (recommended)")).toBeNull();
  });

  it("shows an em dash when the active profile has no model", () => {
    renderPicker(pickerJsx({ provider: pickerProvider("glm") }));
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("shows Not configured on the built-in runtime with zero profiles (issue #570)", () => {
    renderPicker(
      pickerJsx({ provider: { profiles: [], active_profile: null } }),
    );
    expect(screen.getByText("Not configured")).toBeTruthy();
    // "Default (recommended)" is the CLI unselected state's copy: the
    // built-in zero-profile state must never borrow it (ADR-0100 anchor).
    expect(screen.queryByText("Default (recommended)")).toBeNull();
  });

  it("shows Default (recommended) as a static label on a catalog-less external runtime", async () => {
    await renderExternalPicker();
    expect(screen.getByText("Default (recommended)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Model:/ })).toBeNull();
  });

  it("shows Default (recommended), not the CLI current, when a catalog exists but nothing is selected", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    // The label must not adopt the CLI-reported current (fake-opus): with
    // nothing held, the unselected state reads as the CLI default and the
    // directory stays a pick-list, not an auto-selection.
    expect(
      screen.getByRole("button", { name: "Model: Default (recommended)" }),
    ).toBeTruthy();
  });

  it("places no check on any catalog item while nothing is selected", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    // Neither dimension auto-selects its CLI-reported current: no
    // data-selected lands on any menu row (clearing rows carry none).
    const items = screen.getAllByRole("menuitem");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.getAttribute("data-selected")).not.toBe("true");
    }
  });

  it("shows the held pair when a posture is selected", async () => {
    await renderExternalPicker(
      {},
      {
        model: "fake-opus",
        thought_level: "medium",
        cached_discovered: CATALOG,
      },
    );
    expect(screen.getByText("fake-opus · medium")).toBeTruthy();
  });

  it("shows the model alone when the strength is unset", async () => {
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    expect(
      screen.getByRole("button", { name: "Model: fake-opus" }),
    ).toBeTruthy();
  });

  it("updates the label in place when a model is picked from the catalog", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    // The optimistic cache seed flips the label in the same gesture -- the
    // "this pick" source of the selected state (ADR-0100 Decision 1), with
    // no refetch round-trip.
    expect(
      await screen.findByRole("button", { name: "Model: fake-sonnet" }),
    ).toBeTruthy();
  });

  it("renders the read failure as an inline status line instead of a default label (issue #529)", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "qwen-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    vi.mocked(getSessionModelConfig).mockRejectedValue(new Error("ipc down"));
    renderPicker(pickerJsx());
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByText("Default (recommended)")).toBeNull();
  });
});

describe("ComposerProviderPicker posture menu writes (ADR-0095 in-session)", () => {
  it("seeds the catalog from the probe cache when the session has none (ADR-0096 D6)", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
    await renderExternalPicker();
    expect(
      screen.getByRole("button", { name: "Model: Default (recommended)" }),
    ).toBeTruthy();
  });

  it("renders the per-model catalog from a claude_stream_json probe entry (issue #561 parity)", async () => {
    // The per-model dispatch enumerates claude_stream_json explicitly next
    // to codex_event_stream; a field typo here would collapse claude-code
    // users' posture menu into the static label with no test failing.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "claude-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { ...adapter("claude-code"), stream_format: "claude_stream_json" },
    ]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "claude-code": {
        probe_kind: "claude_stream_json",
        outcome: {
          claude_stream_json: {
            models: [
              {
                id: "opus",
                display_name: "Opus",
                is_default: true,
                default_reasoning_effort: "medium",
                supported_reasoning_efforts: ["low", "medium", "high"],
              },
              {
                id: "sonnet",
                display_name: "Sonnet",
                is_default: false,
                default_reasoning_effort: "low",
                supported_reasoning_efforts: ["low"],
              },
            ],
          },
        },
        probed_at_millis: 0,
      },
    });
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: claude-code/ });
    fireEvent.click(screen.getByRole("menuitem", { name: "sonnet" }));
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "sonnet"),
    );
  });

  it("writes a model selection through setSessionModel", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "fake-sonnet" }),
    );
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "fake-sonnet"),
    );
  });

  it("writes a thought-level selection through setSessionThoughtLevel", async () => {
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /^low$/ }));
    await waitFor(() =>
      expect(setSessionThoughtLevel).toHaveBeenCalledWith("sess-1", "low"),
    );
  });

  it("clears via the Default (recommended) row with a null write, without the backfill-clear IPC (single write point)", async () => {
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[0]);
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", null),
    );
    expect(clearLastModelPosture).not.toHaveBeenCalled();
  });

  it("clears a held effort the newly picked model does not support (codex linkage, issue #537)", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([codexAdapter("codex")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      // Held level "medium" is not in gpt-5-codex's supported set.
      model: "gpt-5",
      thought_level: "medium",
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      codex: {
        probe_kind: "codex_event_stream",
        outcome: {
          codex_event_stream: {
            models: [
              {
                id: "gpt-5",
                display_name: "GPT-5",
                is_default: true,
                default_reasoning_effort: "medium",
                supported_reasoning_efforts: ["low", "medium", "high"],
              },
              {
                id: "gpt-5-codex",
                display_name: "GPT-5 Codex",
                is_default: false,
                default_reasoning_effort: "low",
                supported_reasoning_efforts: ["low"],
              },
            ],
          },
        },
        probed_at_millis: 0,
      },
    });
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: codex/ });
    fireEvent.click(screen.getByRole("menuitem", { name: "gpt-5-codex" }));
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "gpt-5-codex"),
    );
    // The chained clear lands through the SAME gesture (issue #537).
    await waitFor(() =>
      expect(setSessionThoughtLevel).toHaveBeenCalledWith("sess-1", null),
    );
  });

  it("keeps the held effort when the model write itself rejects (codex linkage granted gate)", async () => {
    // The same codex fixture, but the model write rejects: the chained
    // effort clear gates on the granted verdict, so the held level stays
    // against the still-held model instead of being cleared for nothing.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([codexAdapter("codex")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: "gpt-5",
      thought_level: "medium",
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      codex: {
        probe_kind: "codex_event_stream",
        outcome: {
          codex_event_stream: {
            models: [
              {
                id: "gpt-5",
                display_name: "GPT-5",
                is_default: true,
                default_reasoning_effort: "medium",
                supported_reasoning_efforts: ["low", "medium", "high"],
              },
              {
                id: "gpt-5-codex",
                display_name: "GPT-5 Codex",
                is_default: false,
                default_reasoning_effort: "low",
                supported_reasoning_efforts: ["low"],
              },
            ],
          },
        },
        probed_at_millis: 0,
      },
    });
    vi.mocked(setSessionModel).mockRejectedValueOnce(new Error("write refused"));
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: codex/ });
    fireEvent.click(screen.getByRole("menuitem", { name: "gpt-5-codex" }));
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "gpt-5-codex"),
    );
    expect(setSessionThoughtLevel).not.toHaveBeenCalled();
  });
});

describe("ComposerProviderPicker posture set-IPC fault lines (issue #529)", () => {
  it("renders an inline fault and resyncs when the set-model IPC rejects", async () => {
    vi.mocked(setSessionModel).mockRejectedValue(new Error("write refused"));
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeTruthy();
    // The refetch-on-reject bounces the display back to the backend posture.
    await waitFor(() => expect(getSessionModelConfig).toHaveBeenCalledTimes(2));
  });

  it("renders an inline fault when the set-thought-level IPC rejects", async () => {
    vi.mocked(setSessionThoughtLevel).mockRejectedValue(
      new Error("write refused"),
    );
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /^low$/ }));
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeTruthy();
  });

  it("surfaces a persistence failure returned by a successful set", async () => {
    // The set IPC resolves, but the returned persist verdict carries a typed
    // write failure -- the menu says the selection was NOT saved to disk.
    vi.mocked(setSessionModel).mockResolvedValue({
      persist_error: { kind: "Io", data: "disk full" },
      persist_suspended: false,
    });
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    expect(
      await screen.findByText(/Selection not saved: Failed to write/),
    ).toBeTruthy();
  });

  it("surfaces a persist suspension (ADR-0035 conflict) returned by a successful set", async () => {
    vi.mocked(setSessionModel).mockResolvedValue({
      persist_error: null,
      persist_suspended: true,
    });
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    expect(await screen.findByText(/changed outside the app/)).toBeTruthy();
  });

  it("clears the failure lines on the next successful selection", async () => {
    vi.mocked(setSessionModel)
      .mockResolvedValueOnce({
        persist_error: { kind: "Io", data: "disk full" },
        persist_suspended: false,
      })
      .mockResolvedValue(PERSIST_OK);
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    expect(await screen.findByText(/Selection not saved/)).toBeTruthy();
    // The next attempt succeeds -- the fault line must clear.
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    await waitFor(() =>
      expect(screen.queryByText(/Selection not saved/)).toBeNull(),
    );
  });
});

describe("ComposerProviderPicker cold-start posture channel (ADR-0100, issue #574)", () => {
  async function renderColdStartPicker(overrides: PickerOverrides = {}) {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
    renderPicker(
      pickerJsx({
        sessionId: null,
        onPendingRuntimeChange: vi.fn(),
        pendingRuntime: { kind: "external", data: "qwen-code" },
        ...overrides,
      }),
    );
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
  }

  it("seeds the label from the backfill entry (initial pending = the entry)", async () => {
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    await renderColdStartPicker();
    expect(screen.getByText("fake-opus · medium")).toBeTruthy();
    expect(getLastModelPosture).toHaveBeenCalledWith("qwen-code");
  });

  it("routes a pick to onPendingModelPostureChange seeded from the backfill (no set IPCs)", async () => {
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartPicker({ onPendingModelPostureChange });
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    expect(onPendingModelPostureChange).toHaveBeenCalledWith({
      model: "fake-sonnet",
      thought_level: "medium",
    });
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("clears the dimension AND wipes the backfill entry via the #581 IPC (ADR-0100 D3)", async () => {
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartPicker({ onPendingModelPostureChange });
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[0]);
    expect(onPendingModelPostureChange).toHaveBeenCalledWith({
      model: null,
      thought_level: "medium",
    });
    expect(clearLastModelPosture).toHaveBeenCalledWith("qwen-code");
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("clears an unsupported held level in the same pending patch (cold-start #537 linkage)", async () => {
    // perModel catalog: the backfilled level "medium" is not in gpt-5-codex's
    // supported set, so picking that model patches the pair with level null
    // in one gesture -- no set IPCs on the cold-start bar.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([codexAdapter("codex")]);
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "gpt-5",
      thought_level: "medium",
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      codex: {
        probe_kind: "codex_event_stream",
        outcome: {
          codex_event_stream: {
            models: [
              {
                id: "gpt-5",
                display_name: "GPT-5",
                is_default: true,
                default_reasoning_effort: "medium",
                supported_reasoning_efforts: ["low", "medium", "high"],
              },
              {
                id: "gpt-5-codex",
                display_name: "GPT-5 Codex",
                is_default: false,
                default_reasoning_effort: "low",
                supported_reasoning_efforts: ["low"],
              },
            ],
          },
        },
        probed_at_millis: 0,
      },
    });
    const onPendingModelPostureChange = vi.fn();
    renderPicker(
      pickerJsx({
        sessionId: null,
        onPendingRuntimeChange: vi.fn(),
        pendingRuntime: { kind: "external", data: "codex" },
        onPendingModelPostureChange,
      }),
    );
    await screen.findByRole("button", { name: /Runtime: codex/ });
    fireEvent.click(screen.getByRole("menuitem", { name: "gpt-5-codex" }));
    expect(onPendingModelPostureChange).toHaveBeenCalledWith({
      model: "gpt-5-codex",
      thought_level: null,
    });
    expect(setSessionModel).not.toHaveBeenCalled();
    expect(setSessionThoughtLevel).not.toHaveBeenCalled();
  });

  it("renders Default (recommended) when the backfill entry is empty", async () => {
    await renderColdStartPicker();
    expect(
      screen.getByRole("button", { name: "Model: Default (recommended)" }),
    ).toBeTruthy();
  });

  it("rolls the pending clear back when the backfill-clear IPC rejects (ADR-0100 D3)", async () => {
    // The clear is optimistic; a rejected wipe must roll the pending pair back
    // to the displayed posture, otherwise the next cold start re-seeds from
    // the surviving entry and the "cleared" posture silently comes back.
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    vi.mocked(clearLastModelPosture).mockRejectedValueOnce(
      new Error("config write failed"),
    );
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartPicker({ onPendingModelPostureChange });
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[0]);
    expect(onPendingModelPostureChange).toHaveBeenNthCalledWith(1, {
      model: null,
      thought_level: "medium",
    });
    await waitFor(() =>
      expect(onPendingModelPostureChange).toHaveBeenNthCalledWith(2, {
        model: "fake-opus",
        thought_level: "medium",
      }),
    );
  });
});

describe("ComposerProviderPicker backfill cache coherence (ADR-0100 single write point)", () => {
  it("invalidates the backfill entry after a successful in-session set so the next cold start refetches", async () => {
    // staleTime: Infinity never auto-refetches; without the invalidation a
    // return to cold start would show the pre-set entry.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "qwen-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: "fake-opus",
      thought_level: null,
      cached_discovered: CATALOG,
    });
    render(wrap(pickerJsx(), queryClient));
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
    fireEvent.click(screen.getByRole("menuitem", { name: "fake-sonnet" }));
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "fake-sonnet"),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(adapterKeys.posture("qwen-code"))
          ?.isInvalidated,
      ).toBe(true),
    );
  });
});
