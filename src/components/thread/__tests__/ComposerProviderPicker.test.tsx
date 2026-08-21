import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
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
  setSessionPosture,
  setSessionRuntime,
  type SetPosturePersistOutcome,
} from "../../../api";
import { TooltipProvider } from "../../ui/tooltip";
import { adapterKeys } from "../../../session/queryKeys";
import type { ModelPosture } from "../../../types/app-config";
import type { ProviderConfig, ProfileKeyStatus } from "../../../types/provider";
import type {
  AdapterEntry,
  AdapterCatalogs,
  CatalogModel,
  DiscoveredRuntime,
  SessionRuntimeChoice,
} from "../../../types/runtime";

// ComposerProviderPicker tests (ADR-0099, issue #574): the two-level
// runtime popover + the brain-icon trigger + the posture text button's
// integration (posture label, set-IPC writes, cold-start pending
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
    setSessionPosture: vi.fn(async () => PERSIST_OK),
    getAdapterCatalogs: vi.fn(async () => ({})),
    getLastModelPosture: vi.fn(async () => EMPTY_POSTURE),
    clearLastModelPosture: vi.fn(async () => ({})),
  };
});

// The set command's clean persist verdict (issue #529): the write landed.
const PERSIST_OK: SetPosturePersistOutcome = {
  persist_error: null,
  persist_suspended: false,
};

const EMPTY_POSTURE = { model: null, thought_level: null };

// The shared ACP handshake catalog fixture (issue #527), typed against the
// wire shape so a new required field breaks the fixture at compile time.
const CATALOG: DiscoveredRuntime = {
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
function acpProbeEntry(catalog: DiscoveredRuntime): AdapterCatalogs {
  return {
    "qwen-code": {
      probe_kind: "acp",
      outcome: { acp: { discovered: { ...catalog, adapter_id: "qwen-code" } } },
      probed_at_millis: 0,
    },
  };
}

// The codex per-model catalog pair (issue #537): gpt-5 supports the held
// "medium" effort, gpt-5-codex does not -- the linkage's two outcomes.
const CODEX_MODELS: CatalogModel[] = [
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
];

// The probe-cache entry fixture for a codex adapter (issue #537), the
// per-model twin of acpProbeEntry.
function codexProbeEntry(models: CatalogModel[]): AdapterCatalogs {
  return {
    codex: {
      probe_kind: "codex_event_stream",
      outcome: { codex_event_stream: { models } },
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

  it("never echoes the keyless mark in the closed profile select (dropdown-only, ADR-0099)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false]]),
    );
    renderPicker(pickerJsx());
    await openPopover();
    const trigger = screen.getByRole("combobox", { name: PROFILE_SELECT });
    // The mark exists in the dropdown (contrast anchor) but the CLOSED
    // trigger echoes the profile name alone.
    await openSelect(trigger);
    expect(await screen.findByText("no key")).toBeTruthy();
    expect(trigger.textContent).toContain("Anthropic");
    expect(trigger.textContent).not.toContain("no key");
  });

  it("shows the None detected placeholder in the closed CLI select when no adapter is detected", async () => {
    // beforeEach seeds an empty adapter table: the honest empty-list
    // placeholder, not a blank echo.
    renderPicker(pickerJsx());
    await openPopover();
    expect(screen.getByLabelText(CLI_SELECT).textContent).toBe("None detected");
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

  it("refetches the model config after a runtime switch so the button shows the seeded pair (#590)", async () => {
    // ADR-0102 Decision 3: the switch re-seeds the posture slot server-side
    // from the target adapter's backfill entry. The picker cannot project
    // the seeded pair locally (the entry read happens in the backend write),
    // so it invalidates the model-config query -- the refetch lands the
    // seeded pair and the posture button re-renders off it, never lingering
    // on the old adapter's stale pair.
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    // First load (pre-switch): the pair held under the old namespace. Later
    // loads (post-invalidation): the pair the switch seeded.
    vi.mocked(getSessionModelConfig)
      .mockResolvedValueOnce({
        model: "old-namespace-model",
        thought_level: "high",
        cached_discovered: null,
      })
      .mockResolvedValue({
        model: "qwen-seeded-model",
        thought_level: null,
        cached_discovered: null,
      });
    renderPicker(pickerJsx());
    // Let the first model-config load settle before switching (a switch
    // racing the first load would invalidate mid-flight and blur the
    // two-call count the test pins).
    await waitFor(() => expect(getSessionModelConfig).toHaveBeenCalledTimes(1));
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
    // The invalidation refetched the model config; the button now shows the
    // seeded pair, not the stale one.
    await screen.findByText("qwen-seeded-model");
    expect(getSessionModelConfig).toHaveBeenCalledTimes(2);
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

  it("carries the level-1 selection state on the rows' aria-pressed", async () => {
    // ADR-0099 Decision 2: the group rows are radio-style targets, so the
    // selection state rides aria-pressed (the dot itself is aria-hidden).
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await openPopover();
    expect(
      screen.getByRole("button", { name: "API Access" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Local CLI" }).getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Local CLI" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Local CLI" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(
      screen.getByRole("button", { name: "API Access" }).getAttribute("aria-pressed"),
    ).toBe("false");
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
    // The synthetic option itself is labeled and DISABLED -- visible as the
    // held value, but not a pickable row.
    await openSelect(cliTrigger);
    const staleOption = screen.getByRole("option", {
      name: /gemini-cli \(no longer detected\)/,
    });
    expect(staleOption.getAttribute("aria-disabled")).toBe("true");
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
    // The popover ACTUALLY closes (the content unmounts), not just the
    // callback firing -- the portaled content would otherwise stay visible
    // atop the settings overlay.
    await waitFor(() => expect(screen.queryByText("API Access")).toBeNull());
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

  it("renders the runtime read failure as the chip's fault line instead of the control (issue #600)", async () => {
    // The #529 convention's runtime-side twin: a rejected runtime read must
    // not masquerade as the built-in default -- the destructive status line
    // replaces the Popover control entirely (the modelConfig configFault
    // treatment on its sibling query).
    vi.mocked(getSessionRuntime).mockRejectedValue(new Error("ipc down"));
    renderPicker(pickerJsx());
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("button", { name: BUILTIN_TRIGGER })).toBeNull();
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
    cached_discovered?: DiscoveredRuntime | null;
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

describe("ComposerProviderPicker posture button label (ADR-0099 D3, issue #573)", () => {
  it("shows the active profile's model as a static label on the built-in runtime", () => {
    renderPicker(pickerJsx());
    // Static: the posture label renders, but NOT as a button (no arrow,
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

  it("shows Default (recommended) when the discovery cache predates the provenance stamp (unattributable currents)", async () => {
    // The live rendering asserts what THIS runtime's last turn ran (issue
    // #586); a cache persisted before the adapter_id field existed cannot
    // back that claim, so the unselected label stays anchored to the CLI
    // default and the directory stays a pick-list, not an auto-selection.
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    expect(
      screen.getByRole("button", { name: "Model: Default (recommended)" }),
    ).toBeTruthy();
    // And no live tooltip: focus opens the tooltip synchronously (a
    // pointerMove would defer it to a macrotask and this absence query
    // would pass vacuously).
    fireEvent.focus(
      screen.getByRole("button", { name: "Model: Default (recommended)" }),
    );
    expect(screen.queryByText(/\(last turn\)/)).toBeNull();
  });

  it("places no check on any catalog item while nothing is selected", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    // Neither dimension auto-selects its CLI-reported current: no radio row
    // carries aria-checked (the clearing rows are plain menuitems with no
    // checked state at all).
    const items = screen.getAllByRole("menuitemradio");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.getAttribute("aria-checked")).not.toBe("true");
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

  it("shows the held thought level alone when no model is held (fifth state, issue #584)", async () => {
    // The two dimensions are independently reachable on ACP adapters: a
    // lone held level must NOT collapse to "Default (recommended)" -- the
    // label and the Thinking submenu's checked row agree.
    await renderExternalPicker(
      {},
      { thought_level: "medium", cached_discovered: CATALOG },
    );
    expect(screen.getByRole("button", { name: "Model: medium" })).toBeTruthy();
    const level = screen.getByRole("menuitemradio", { name: /^medium$/ });
    expect(level.getAttribute("aria-checked")).toBe("true");
  });

  it("checks the held model's radio row in the menu", async () => {
    // The model dimension's integration-level positive: the held pair's
    // model side agrees with the Model submenu's checked row (the trigger
    // file pins the level side's twin).
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    const opus = screen.getByRole("menuitemradio", { name: /^fake-opus$/ });
    expect(opus.getAttribute("aria-checked")).toBe("true");
    const sonnet = screen.getByRole("menuitemradio", { name: /^fake-sonnet$/ });
    expect(sonnet.getAttribute("aria-checked")).toBe("false");
  });

  it("updates the label in place when a model is picked from the catalog", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
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

// ---------------------------------------------------------------------------
// Posture label turn-end live rendering (issue #586, ADR-0095 Decision 5)
// ---------------------------------------------------------------------------

describe("ComposerProviderPicker posture label live rendering (issue #586)", () => {
  // The session discovery cache stamped by the ACTIVE adapter: the
  // turn-end live currents (the ACP handshake currents / the claude
  // system{init} model) the unselected state's tooltip carries.
  const STAMPED_CATALOG = { ...CATALOG, adapter_id: "qwen-code" };
  const LIVE_TOOLTIP = /\(last turn\)/;

  it("keeps the Default (recommended) label and carries the turn's actual pair in the tooltip (ACP)", async () => {
    await renderExternalPicker({}, { cached_discovered: STAMPED_CATALOG });
    // The live currents never touch the label (the user-supplied form):
    // the unselected label keeps its default copy verbatim, and the
    // tooltip is the live readout's only surface.
    const trigger = screen.getByRole("button", {
      name: "Model: Default (recommended)",
    });
    expect(trigger).toBeTruthy();
    fireEvent.pointerMove(trigger);
    expect(
      await screen.findByText("fake-opus · medium (last turn)"),
    ).toBeTruthy();
    // Display-layer only (ADR-0100 constraint): the live rendering never
    // writes the posture -- the single write point stays the set IPC.
    expect(setSessionPosture).not.toHaveBeenCalled();
    expect(clearLastModelPosture).not.toHaveBeenCalled();
  });

  it("shows the turn's actual model alone when the live cache carries no level (claude shape)", async () => {
    // claude-code's turns report only the system{init} model (no thought
    // levels); the per-model catalog rides the probe entry as usual.
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
            ],
          },
        },
        probed_at_millis: 0,
      },
    });
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: {
        models: [],
        current_model: "opus",
        thought_levels: [],
        current_thought_level: null,
        adapter_id: "claude-code",
      },
    });
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: claude-code/ });
    const trigger = screen.getByRole("button", {
      name: "Model: Default (recommended)",
    });
    fireEvent.pointerMove(trigger);
    expect(await screen.findByText("opus (last turn)")).toBeTruthy();
  });

  it("shows the turn's actual level alone when the live cache carries no model", async () => {
    // The two current fields are independent Options on the wire (a
    // handshake may report only a thought level); a lone level has its own
    // live form, mirroring the held side's lone-level form.
    await renderExternalPicker(
      {},
      {
        cached_discovered: {
          models: CATALOG.models,
          current_model: null,
          thought_levels: CATALOG.thought_levels,
          current_thought_level: "medium",
          adapter_id: "qwen-code",
        },
      },
    );
    const trigger = screen.getByRole("button", {
      name: "Model: Default (recommended)",
    });
    fireEvent.focus(trigger);
    expect(await screen.findByText("medium (last turn)")).toBeTruthy();
  });

  it("holds the live read back when a stamped claude cache has no probe entry to seat the menu", async () => {
    // claude stamps the session cache on its turns, but its per-model
    // catalog exists only after a settings probe; without one the trigger
    // is the static no-arrow label, and the picker emits no live value
    // rather than one the static form would drop.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "claude-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { ...adapter("claude-code"), stream_format: "claude_stream_json" },
    ]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: {
        models: [],
        current_model: "opus",
        thought_levels: [],
        current_thought_level: null,
        adapter_id: "claude-code",
      },
    });
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: claude-code/ });
    // Static label: no arrow, no menu -- and structurally no tooltip.
    expect(screen.getByText("Default (recommended)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Model:/ })).toBeNull();
  });

  it("an explicit selection outranks the live currents and drops the tooltip", async () => {
    await renderExternalPicker(
      {},
      { model: "fake-sonnet", cached_discovered: STAMPED_CATALOG },
    );
    const trigger = screen.getByRole("button", { name: "Model: fake-sonnet" });
    expect(trigger).toBeTruthy();
    // The selected state carries no live tooltip. The absence assertions
    // open via focus -- Radix opens the tooltip synchronously on focus,
    // while a pointerMove defers the open to a macrotask and a synchronous
    // absence query right after it would pass vacuously.
    fireEvent.focus(trigger);
    expect(screen.queryByText(LIVE_TOOLTIP)).toBeNull();
  });

  it("the live tooltip disappears the moment a model is picked from the live state", async () => {
    await renderExternalPicker({}, { cached_discovered: STAMPED_CATALOG });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    // The optimistic cache seed flips the label to the selected state in
    // the same gesture -- the live tooltip goes with it.
    const trigger = await screen.findByRole("button", {
      name: "Model: fake-sonnet",
    });
    fireEvent.focus(trigger);
    expect(screen.queryByText(LIVE_TOOLTIP)).toBeNull();
  });

  it("keeps the menu unselected in the live state (no auto-check)", async () => {
    // The live rendering is a label-only fact: the cascade menu's check
    // positions stay untouched (nothing is selected), same as the
    // Default (recommended) state.
    await renderExternalPicker({}, { cached_discovered: STAMPED_CATALOG });
    const items = screen.getAllByRole("menuitemradio");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.getAttribute("aria-checked")).not.toBe("true");
    }
  });

  it("keeps Default (recommended) on a codex session (probe cache carries no live currents)", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([codexAdapter("codex")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue(
      codexProbeEntry([CODEX_MODELS[0]]),
    );
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: codex/ });
    const trigger = screen.getByRole("button", {
      name: "Model: Default (recommended)",
    });
    expect(trigger).toBeTruthy();
    fireEvent.focus(trigger);
    expect(screen.queryByText(LIVE_TOOLTIP)).toBeNull();
  });

  it("does not attribute another adapter's live currents to the active runtime", async () => {
    // The cache holds live values, but its stamp names a different adapter
    // (the stale-provenance window after a runtime switch): asserting them
    // as THIS runtime's last turn would be a lie, so no live tooltip.
    await renderExternalPicker(
      {},
      { cached_discovered: { ...CATALOG, adapter_id: "other-cli" } },
    );
    const trigger = screen.getByRole("button", {
      name: "Model: Default (recommended)",
    });
    fireEvent.focus(trigger);
    expect(screen.queryByText(LIVE_TOOLTIP)).toBeNull();
  });

  it("cold start keeps Default (recommended) even when the probe cache carries currents", async () => {
    // The probe entry's handshake currents are probe facts, not turn
    // facts -- and the cold-start bar has no session discovery cache to
    // read (the model-config query is disabled), so the live rendering
    // has no source here.
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
    renderPicker(
      pickerJsx({
        sessionId: null,
        onPendingRuntimeChange: vi.fn(),
        pendingRuntime: { kind: "external", data: "qwen-code" },
      }),
    );
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
    const trigger = screen.getByRole("button", {
      name: "Model: Default (recommended)",
    });
    fireEvent.focus(trigger);
    expect(screen.queryByText(LIVE_TOOLTIP)).toBeNull();
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
    fireEvent.click(screen.getByRole("menuitemradio", { name: "sonnet" }));
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "sonnet", thought_level: null }),
    );
  });

  it("writes a model selection through setSessionPosture", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "fake-sonnet" }),
    );
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "fake-sonnet", thought_level: null }),
    );
  });

  it("writes a thought-level selection through setSessionPosture", async () => {
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^low$/ }));
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "fake-opus", thought_level: "low" }),
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
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: null, thought_level: null }),
    );
    expect(clearLastModelPosture).not.toHaveBeenCalled();
  });

  it("clears a held effort the newly picked model does not support in the same wire submit (codex linkage, issue #537)", async () => {
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
    vi.mocked(getAdapterCatalogs).mockResolvedValue(codexProbeEntry(CODEX_MODELS));
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: codex/ });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5-codex" }));
    // The linkage clear rides the SAME wire submit (issues #537 + #603):
    // one call carries the model pick AND the level null.
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "gpt-5-codex", thought_level: null }),
    );
  });

  it("keeps the held effort when the write itself rejects (codex linkage)", async () => {
    // The same codex fixture, but the single posture write rejects:
    // nothing of the pair lands, so the held level stays against the
    // still-held model instead of being cleared for nothing.
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
    vi.mocked(getAdapterCatalogs).mockResolvedValue(codexProbeEntry(CODEX_MODELS));
    vi.mocked(setSessionPosture).mockRejectedValueOnce(new Error("write refused"));
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: codex/ });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5-codex" }));
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "gpt-5-codex", thought_level: null }),
    );
    // One submit carried the whole pair -- there is no second write.
    expect(setSessionPosture).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerProviderPicker posture set-IPC fault lines (issue #529)", () => {
  it("renders an inline fault and resyncs when the set-posture IPC rejects", async () => {
    vi.mocked(setSessionPosture).mockRejectedValue(new Error("write refused"));
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeTruthy();
    // The refetch-on-reject bounces the display back to the backend posture.
    await waitFor(() => expect(getSessionModelConfig).toHaveBeenCalledTimes(2));
  });

  it("renders an inline fault when the set-posture IPC rejects from the thought-level row", async () => {
    vi.mocked(setSessionPosture).mockRejectedValue(
      new Error("write refused"),
    );
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: /^low$/ }));
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeTruthy();
  });

  it("surfaces a persistence failure returned by a successful set", async () => {
    // The set IPC resolves, but the returned persist verdict carries a typed
    // write failure -- the menu says the selection was NOT saved to disk.
    vi.mocked(setSessionPosture).mockResolvedValue({
      persist_error: { kind: "Io", data: "disk full" },
      persist_suspended: false,
    });
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    expect(
      await screen.findByText(/Selection not saved: Failed to write/),
    ).toBeTruthy();
  });

  it("surfaces a persist suspension (ADR-0035 conflict) returned by a successful set", async () => {
    vi.mocked(setSessionPosture).mockResolvedValue({
      persist_error: null,
      persist_suspended: true,
    });
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    expect(await screen.findByText(/changed outside the app/)).toBeTruthy();
  });

  it("clears the failure lines on the next successful selection", async () => {
    vi.mocked(setSessionPosture)
      .mockResolvedValueOnce({
        persist_error: { kind: "Io", data: "disk full" },
        persist_suspended: false,
      })
      .mockResolvedValue(PERSIST_OK);
    await renderExternalPicker(
      {},
      { model: "fake-opus", cached_discovered: CATALOG },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    expect(await screen.findByText(/Selection not saved/)).toBeTruthy();
    // The next attempt succeeds -- the fault line must clear.
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    await waitFor(() =>
      expect(screen.queryByText(/Selection not saved/)).toBeNull(),
    );
  });
});

describe("ComposerProviderPicker cold-start posture channel (ADR-0100, issue #574)", () => {
  // The shared cold-start catalog seed: the external ACP runtime + its probe
  // entry, so the posture cascade is interactive on the bar.
  function seedColdStartCatalog() {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
  }

  // The posture surface settles a second async hop after the runtime
  // trigger (adapters -> external runtime -> catalogs + backfill read):
  // awaiting the trigger alone leaves the catalog-gated menu racing the
  // test's first sync query. Either settled form unlocks the wait -- the
  // Model trigger (catalog present) or the inline status line (backfill
  // read failed).
  async function settlePostureSurface() {
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /^Model: / }) ??
        screen.queryByRole("status"),
      ).not.toBeNull();
    });
  }

  async function renderColdStartPicker(overrides: PickerOverrides = {}) {
    seedColdStartCatalog();
    renderPicker(
      pickerJsx({
        sessionId: null,
        onPendingRuntimeChange: vi.fn(),
        pendingRuntime: { kind: "external", data: "qwen-code" },
        ...overrides,
      }),
    );
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
    await settlePostureSurface();
  }

  // The shell-shaped cold-start host: the pending pair lives in the parent
  // and feeds back through pendingModelPosture, mirroring the QuestionBar
  // wiring the rollback guard reads (issue #592). An inert vi.fn() callback
  // never updates the prop, so the guard would always see a stale pair. The
  // runtime handler mirrors App's handlePendingRuntimeChange -- the switch
  // resets the pending posture to null (ADR-0100 D2) -- so the guard's
  // caller-reset branch is reachable from tests.
  function ColdStartHost({
    onPendingChange,
  }: {
    onPendingChange: (posture: ModelPosture) => void;
  }) {
    const [pending, setPending] = useState<ModelPosture | null>(null);
    const [pendingRuntime, setPendingRuntime] =
      useState<SessionRuntimeChoice | null>({
        kind: "external",
        data: "qwen-code",
      });
    return (
      <ComposerProviderPicker
        sessionId={null}
        provider={pickerProvider()}
        onSwitchActive={vi.fn()}
        onOpenSettings={vi.fn()}
        onPendingRuntimeChange={(runtime) => {
          setPendingRuntime(runtime);
          setPending(null);
        }}
        pendingRuntime={pendingRuntime}
        onPendingModelPostureChange={(p) => {
          setPending(p);
          onPendingChange(p);
        }}
        pendingModelPosture={pending}
      />
    );
  }

  async function renderColdStartHost(onPendingChange: (p: ModelPosture) => void) {
    seedColdStartCatalog();
    renderPicker(<ColdStartHost onPendingChange={onPendingChange} />);
    await screen.findByRole("button", { name: /Runtime: qwen-code/ });
    await settlePostureSurface();
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

  it("renders the backfill read failure as an inline status line instead of a default label (issue #584)", async () => {
    // The cold-start twin of the in-session #529 contract: a rejected
    // startup-posture read must not masquerade as "Default (recommended)"
    // while the backend entry still takes effect on the first turn.
    vi.mocked(getLastModelPosture).mockRejectedValue(new Error("ipc down"));
    await renderColdStartPicker();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByText("Default (recommended)")).toBeNull();
  });

  it("prefers an explicit pendingModelPosture over the backfill entry (ADR-0100 D1)", async () => {
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    await renderColdStartPicker({
      pendingModelPosture: { model: "fake-sonnet", thought_level: null },
    });
    // The explicit pending pair wins over the seeded entry.
    expect(
      screen.getByRole("button", { name: "Model: fake-sonnet" }),
    ).toBeTruthy();
    expect(screen.queryByText("fake-opus · medium")).toBeNull();
  });

  it("routes a pick to onPendingModelPostureChange seeded from the backfill (no set IPCs)", async () => {
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartPicker({ onPendingModelPostureChange });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    expect(onPendingModelPostureChange).toHaveBeenCalledWith({
      model: "fake-sonnet",
      thought_level: "medium",
    });
    expect(setSessionPosture).not.toHaveBeenCalled();
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
    expect(setSessionPosture).not.toHaveBeenCalled();
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
    vi.mocked(getAdapterCatalogs).mockResolvedValue(codexProbeEntry(CODEX_MODELS));
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
    // This render is inline (its own codex seed, not the helpers), so await
    // the catalog-gated row directly -- the same second-hop settle the
    // cold-start helpers perform.
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "gpt-5-codex" }),
    );
    expect(onPendingModelPostureChange).toHaveBeenCalledWith({
      model: "gpt-5-codex",
      thought_level: null,
    });
    expect(setSessionPosture).not.toHaveBeenCalled();
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
    // Hosted (not an inert vi.fn()) so the rollback guard reads the pair the
    // user actually sees (issue #592).
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    vi.mocked(clearLastModelPosture).mockRejectedValueOnce(
      new Error("config write failed"),
    );
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartHost(onPendingModelPostureChange);
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
    // The hosted pair follows the rollback: the label shows the restored
    // posture, not the cleared one.
    expect(await screen.findByText("fake-opus · medium")).toBeTruthy();
    // The failed clear also surfaces on the shared set-fault line (the
    // cold-start twin of the in-session #529 contract), not only the log
    // sink -- the restored label alone would otherwise carry no
    // explanation.
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeTruthy();
  });

  it("does not roll the pending clear back when a later gesture rewrote the pair (issue #592)", async () => {
    // The clear IPC fails only AFTER the user picked a model in the IPC
    // window: the rollback compares the pending pair against this clear's
    // patch, finds a newer intent, and leaves it alone -- restoring the
    // pre-clear snapshot would silently drop the pick.
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    let rejectClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject;
        }),
    );
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartHost(onPendingModelPostureChange);
    fireEvent.click(
      screen.getAllByRole("menuitem", { name: "Default (recommended)" })[0],
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    // Self-check the IPC fired before rejecting it, so the optional-chain
    // reject below cannot pass vacuously on a dropped gesture.
    expect(clearLastModelPosture).toHaveBeenCalledTimes(1);
    // Settle the rejection inside act so the catch handler runs before the
    // assertions below.
    await act(async () => {
      rejectClear?.(new Error("config write failed"));
    });
    // The pick survives the rejected clear: exactly the two gesture calls
    // (no third, rollback, call) and the label keeps the picked model.
    expect(onPendingModelPostureChange).toHaveBeenCalledTimes(2);
    expect(screen.getByText("fake-sonnet · medium")).toBeTruthy();
    expect(screen.queryByText("fake-opus · medium")).toBeNull();
  });

  it("does not roll the pending clear back when the same clear gesture repeats in the IPC window (issue #592)", async () => {
    // Double-clicking the clearing row rewrites an EQUAL pair -- the value
    // check alone cannot tell it from "no later gesture" -- so the guard
    // also carries a monotonic gesture counter: the repeat bumps it and the
    // first reject's rollback is skipped, keeping the twice-expressed clear
    // intent.
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    let rejectFirstClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirstClear = reject;
        }),
    );
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartHost(onPendingModelPostureChange);
    // After the first clear the Model row's clearing label gains its
    // current-annotation suffix, so match on the prefix both times.
    const modelClearRow = () =>
      screen.getAllByRole("menuitem", {
        name: /^Default \(recommended\)/,
      })[0];
    fireEvent.click(modelClearRow());
    fireEvent.click(modelClearRow());
    expect(clearLastModelPosture).toHaveBeenCalledTimes(2);
    await act(async () => {
      rejectFirstClear?.(new Error("config write failed"));
    });
    // No rollback: both gestures' cleared pair stands.
    expect(onPendingModelPostureChange).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("button", { name: "Model: medium" }),
    ).toBeTruthy();
    expect(screen.queryByText("fake-opus · medium")).toBeNull();
  });

  it("does not roll the pending clear back when the caller resets the pair on a runtime switch (issue #592)", async () => {
    // The clear IPC fails only AFTER the user switched runtimes on the bar:
    // the host mirrors App's handlePendingRuntimeChange, resetting the
    // pending pair to null (ADR-0100 D2 namespacing) -- a reset that
    // bypasses the picker's gesture path, so it bumps no gesture counter.
    // The guard must still skip the rollback (the null check, plus the
    // counter the runtime write itself bumps): restoring the pre-clear
    // posture would resurrect it under the NEW runtime.
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    let rejectClear: ((reason: unknown) => void) | undefined;
    vi.mocked(clearLastModelPosture).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectClear = reject;
        }),
    );
    const onPendingModelPostureChange = vi.fn();
    await renderColdStartHost(onPendingModelPostureChange);
    // The posture menu's clearing row issues the clear...
    fireEvent.click(
      screen.getAllByRole("menuitem", {
        name: /^Default \(recommended\)/,
      })[0],
    );
    // ...then the user switches to the built-in runtime inside the IPC
    // window (the popover's level-1 API Access row).
    fireEvent.click(screen.getByRole("button", { name: /Runtime: qwen-code/ }));
    await screen.findByText("API Access");
    fireEvent.click(screen.getByRole("button", { name: "API Access" }));
    // Self-check the clear IPC fired before rejecting it, so the
    // optional-chain reject below cannot pass vacuously.
    expect(clearLastModelPosture).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectClear?.(new Error("config write failed"));
    });
    // No rollback: exactly the one gesture call (the caller's reset is its
    // own setState, not a picker write), and the pre-clear posture is not
    // resurrected under the new runtime. (The set-fault line is pinned by
    // the rolled-back test above -- the built-in runtime renders the
    // static no-menu label, so no fault surface exists to query here.)
    expect(onPendingModelPostureChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("fake-opus · medium")).toBeNull();
  });
});

describe("ComposerProviderPicker backfill cache coherence (ADR-0100 single write point)", () => {
  it("does not read the backfill entry in-session (cold-start-only query)", async () => {
    // In-session truth is the model-config query; the backfill read must
    // stay disabled.
    await renderExternalPicker();
    expect(getLastModelPosture).not.toHaveBeenCalled();
  });

  it("does not read the backfill entry on a cold-start built-in runtime", async () => {
    // Postures are adapter-namespaced: with no external adapter active
    // there is no backfill entry to read.
    renderPicker(
      pickerJsx({
        sessionId: null,
        onPendingRuntimeChange: vi.fn(),
        pendingRuntime: { kind: "built_in" },
      }),
    );
    await screen.findByRole("button", { name: BUILTIN_TRIGGER });
    expect(getLastModelPosture).not.toHaveBeenCalled();
  });

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
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "fake-sonnet", thought_level: null }),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(adapterKeys.posture("qwen-code"))
          ?.isInvalidated,
      ).toBe(true),
    );
  });
});

// ---------------------------------------------------------------------------
// Catalog provenance staleness (issue #529, restored #584): the deleted
// popover-rewrite tests' liveness coverage.
// ---------------------------------------------------------------------------

describe("ComposerProviderPicker catalog provenance staleness (issue #529)", () => {
  it("flags a session discovery stamped by a different adapter", async () => {
    await renderExternalPicker(
      {},
      { cached_discovered: { ...CATALOG, adapter_id: "other-cli" } },
    );
    expect(
      screen.getByText(/discovered on a different runtime/),
    ).toBeTruthy();
  });

  it("does not flag a discovery stamped by the active adapter itself", async () => {
    // The steady state after a turn on this runtime: the stamp's presence
    // alone is not staleness -- only a mismatch is.
    await renderExternalPicker(
      {},
      { cached_discovered: { ...CATALOG, adapter_id: "qwen-code" } },
    );
    expect(
      screen.queryByText(/discovered on a different runtime/),
    ).toBeNull();
  });

  it("does not flag a pre-stamp discovery with no adapter_id", async () => {
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    // Persisted before the field existed: no provenance, no mismatch.
    expect(
      screen.queryByText(/discovered on a different runtime/),
    ).toBeNull();
  });

  it("never flags a per-model adapter (its turns never replace the discovery cache)", async () => {
    // The stale note's promise ("refreshes after this runtime's next turn")
    // would be a permanent lie for a per-model runtime -- the predicate is
    // scoped to discovery-fed (ACP) adapters only.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([codexAdapter("codex")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: "gpt-5",
      thought_level: null,
      cached_discovered: { ...CATALOG, adapter_id: "other-cli" },
    });
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: codex/ });
    expect(
      screen.queryByText(/discovered on a different runtime/),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Catalog priority chain (ADR-0096 D6, restored #584)
// ---------------------------------------------------------------------------

describe("ComposerProviderPicker catalog priority chain (ADR-0096 D6)", () => {
  it("prefers the session's cached discovery over a probe-cache entry", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({
      "qwen-code": {
        probe_kind: "acp",
        outcome: {
          acp: {
            discovered: {
              ...CATALOG,
              models: ["probe-only-model"],
              adapter_id: "qwen-code",
            },
          },
        },
        probed_at_millis: 0,
      },
    });
    await renderExternalPicker({}, { cached_discovered: CATALOG });
    // The menu lists the session cache's models, never the probe entry's.
    expect(screen.getByRole("menuitemradio", { name: "fake-opus" })).toBeTruthy();
    expect(
      screen.queryByRole("menuitemradio", { name: "probe-only-model" }),
    ).toBeNull();
  });

  it("renders the static label when the probe cache holds only another adapter's entry", async () => {
    // The entry is keyed under qwen-code while the session runs a different
    // ACP adapter with no session discovery: no catalog anywhere, so the
    // trigger is a static label (no menu to fake).
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "other-acp",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("other-acp")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: null,
    });
    renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /Runtime: other-acp/ });
    expect(screen.getByText("Default (recommended)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Model:/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-profile key overlay refetch (issue #154, restored #584)
// ---------------------------------------------------------------------------

describe("ComposerProviderPicker key overlay refetch (issue #154)", () => {
  it("refetches the key overlay on a profileKeyEpoch bump", async () => {
    // The mount-time fetch effect lists profileKeyEpoch in its deps; losing
    // the dep would leave stale "no key" marks after a Settings Save that
    // just configured a key.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(wrap(pickerJsx(), queryClient));
    await waitFor(() => expect(listProviderProfiles).toHaveBeenCalledTimes(1));
    rerender(wrap(pickerJsx({ profileKeyEpoch: 1 }), queryClient));
    await waitFor(() => expect(listProviderProfiles).toHaveBeenCalledTimes(2));
  });

  it("does not refetch the key overlay while the epoch is unchanged", async () => {
    // The deps cut both ways: an unrelated rerender must not re-run the
    // fetch effect (one IPC per epoch, not per render).
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(wrap(pickerJsx(), queryClient));
    await waitFor(() => expect(listProviderProfiles).toHaveBeenCalledTimes(1));
    rerender(wrap(pickerJsx(), queryClient));
    expect(listProviderProfiles).toHaveBeenCalledTimes(1);
  });

  it("clears the overlay error line when an epoch refetch succeeds (issue #584)", async () => {
    vi.mocked(listProviderProfiles)
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValue(keyStatus([["anthropic", true]]));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(wrap(pickerJsx(), queryClient));
    await openPopover();
    expect(await screen.findByText(/ipc down/)).toBeTruthy();
    rerender(wrap(pickerJsx({ profileKeyEpoch: 1 }), queryClient));
    await waitFor(() => expect(screen.queryByText(/ipc down/)).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// Trigger tooltip content (ADR-0099, restored #584)
// ---------------------------------------------------------------------------

describe("ComposerProviderPicker trigger tooltip (ADR-0099)", () => {
  it("previews {provider} · {model} on the built-in runtime", async () => {
    // A keyed active profile: no mark appended (the no-key variant is its
    // own test below).
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", true]]),
    );
    renderPicker(pickerJsx());
    fireEvent.pointerMove(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    expect(await screen.findByText("Anthropic · claude-sonnet-4-6")).toBeTruthy();
  });

  it("appends the honest no-key mark when the active profile has no key (ADR-0019)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false]]),
    );
    renderPicker(pickerJsx());
    fireEvent.pointerMove(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    expect(
      await screen.findByText("Anthropic · claude-sonnet-4-6 · no key"),
    ).toBeTruthy();
  });

  it("names the adapter on an external runtime", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "qwen-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code", "Qwen Code")]);
    renderPicker(pickerJsx());
    const trigger = await screen.findByRole("button", { name: /Runtime: Qwen Code/ });
    fireEvent.pointerMove(trigger);
    expect(await screen.findByText("External runtime: Qwen Code")).toBeTruthy();
  });
});
