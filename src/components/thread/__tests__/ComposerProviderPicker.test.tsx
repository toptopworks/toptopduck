import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactElement } from "react";
import { IntlProvider } from "react-intl";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";

import { ComposerProviderPicker } from "../ComposerProviderPicker";
import {
  useColdStartSelection,
  type ColdStartSelectionChannel,
} from "../composer-selection-write";
import {
  clearLastModelPosture,
  getAdapterCatalogs,
  getBuiltinPostureCatalog,
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
import { openChangeCapture } from "./dropdownMenuMock";
import type { ModelPosture } from "../../../types/app-config";
import type { ProviderConfig, ProfileKeyStatus } from "../../../types/provider";
import type {
  AdapterEntry,
  AdapterCatalogs,
  BuiltinCatalogModel,
  CatalogModel,
  DiscoveredRuntime,
  SessionModelConfig,
  SessionRuntimeChoice,
} from "../../../types/runtime";
import { MENU_REENTRY_GRACE_MS } from "../../../session/sidebarHoverCard";

// ComposerProviderPicker tests (ADR-0099, issue #574): the flattened
// runtime select (direct option rows in one dropdown, no nested Select)
// + the icon trigger + the posture text button's
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
    // Resolves the empty pair by default: the model-config read feeds the
    // built-in trigger too since #1639 (its read fault renders inline), so
    // a bare undefined-returning mock would error the query and surface a
    // fault line in every built-in test that does not override this.
    getSessionModelConfig: vi.fn(async () => ({
      model: null,
      thought_level: null,
      cached_discovered: null,
    })),
    setSessionPosture: vi.fn(async () => PERSIST_OK),
    getAdapterCatalogs: vi.fn(async () => ({})),
    getBuiltinPostureCatalog: vi.fn(async () => BUILTIN_FALLBACK),
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

// The built-in catalog's fallback answer (issue #1639): no first-hand list
// (probe pending or failed -- silent either way). The default mock return so
// every pre-existing test renders the honest fallback shape (the effective
// current is the profile's model, read live from app-config).
const BUILTIN_FALLBACK: BuiltinCatalogModel[] = [];

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
      coldStart={null}
      {...overrides}
    />
  );
}

// A static cold-start channel for display-face tests: fixed pending facets,
// a recording port (writes assert the picker routed them, not their effects
// -- those live in composer-selection-write.test.tsx).
function staticColdStartChannel(
  posture: ModelPosture | null = null,
  runtime: SessionRuntimeChoice = { kind: "external", data: "qwen-code" },
): ColdStartSelectionChannel {
  return {
    effectiveRuntime: runtime,
    pendingModelPosture: posture,
    port: {
      writePosture: vi.fn(async () => ({
        status: "written" as const,
        persistError: null,
        persistSuspended: false,
      })),
      writeRuntime: vi.fn(async () => {}),
    },
  };
}

/** Opens the runtime Select (pointerDown + click, the jsdom-verified Radix sequence). */
async function openRuntimeSelect(triggerName: string | RegExp = BUILTIN_TRIGGER) {
  const trigger = screen.getByRole("combobox", { name: triggerName });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.click(trigger);
  // A wildcard findByRole("option") throws on multiple matches; wait on the
  // count instead.
  await waitFor(() =>
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0),
  );
}

/** Picks the option matching the name (pointerUp + click, the jsdom sequence). */
function pickOption(name: string | RegExp) {
  const option = screen.getByRole("option", { name });
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
  vi.mocked(getBuiltinPostureCatalog).mockResolvedValue(BUILTIN_FALLBACK);
  vi.mocked(getLastModelPosture).mockResolvedValue(EMPTY_POSTURE);
});

// ---------------------------------------------------------------------------
// Trigger + flattened runtime select (issue #1595)
// ---------------------------------------------------------------------------

describe("ComposerProviderPicker runtime popover (ADR-0099)", () => {
  it("renders the select trigger with an accessible name carrying the active provider", () => {
    renderPicker(pickerJsx());
    // Icon-only face: the runtime name rides the aria-label alone (the bar
    // never echoes it visually; the tooltip is the read surface).
    expect(screen.getByRole("combobox", { name: BUILTIN_TRIGGER })).toBeTruthy();
  });

  it("opens the dropdown with the two optgroup labels mirroring the settings tab names", async () => {
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    expect(screen.getByText("API Access")).toBeTruthy();
    expect(screen.getByText("Local CLI")).toBeTruthy();
  });

  it("retires the configuration surfaces from the dropdown (model input, key block, open-settings)", async () => {
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    // ADR-0099 Decision 1: the dropdown is a pure selector -- configuration
    // lives in Settings.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Key set")).toBeNull();
    expect(screen.queryByText("No key")).toBeNull();
    expect(screen.queryByText("Open settings")).toBeNull();
  });

  // Keyboard close (Radix Select's own contract): ESC closes and returns
  // focus to the trigger (the a11y return path). The pointer-close focus
  // behavior is Radix-internal (no seam) -- the #1438 tooltip gate covers
  // the strand risk instead of a focus pin.
  it("a keyboard close (ESC) keeps the trigger refocus", async () => {
    renderPicker(pickerJsx());
    const trigger = screen.getByRole("combobox", { name: BUILTIN_TRIGGER });
    await openRuntimeSelect();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(
      () => expect(screen.queryByRole("option")).toBeNull(),
      { timeout: 3000 },
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("lists every profile as an option with the active one checked", async () => {
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    // The active choice's check rides the controlled value (the ItemText
    // echo source stays the label alone; the mark never joins it).
    expect(
      screen.getByRole("option", { name: "Anthropic" }).getAttribute("data-state"),
    ).toBe("checked");
    expect(
      screen.getByRole("option", { name: "GLM" }).getAttribute("data-state"),
    ).toBe("unchecked");
  });

  it("switches active_profile when a profile option is picked", async () => {
    const onSwitchActive = vi.fn();
    renderPicker(pickerJsx({ onSwitchActive }));
    await openRuntimeSelect();
    pickOption("GLM");
    expect(onSwitchActive).toHaveBeenCalledWith("glm");
    // Already on the built-in runtime: no runtime write fires.
    expect(setSessionRuntime).not.toHaveBeenCalled();
  });

  it("names an undetected-but-registered adapter on the trigger (issue #1351)", async () => {
    // The session's active adapter is registered but not detected (binary
    // missing / PATH changed): the full wire table still carries its row, so
    // the trigger shows the name, not the raw id. Only a deleted or
    // disabled row falls to the id.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "user:ba3b2de2",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("user:ba3b2de2", "My local CLI", false),
    ]);
    renderPicker(pickerJsx());
    await screen.findByRole("combobox", { name: "Runtime: My local CLI" });
  });

  it("falls to the raw id on the trigger when the adapter row is gone", async () => {
    // The deleted-row floor of the display-name resolve (issue #1351):
    // the session still points at the id, but no row carries it -- the
    // trigger shows the id, the honest floor.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "user:ba3b2de2",
    });
    vi.mocked(listAdapters).mockResolvedValue([]);
    renderPicker(pickerJsx());
    await screen.findByRole("combobox", { name: "Runtime: user:ba3b2de2" });
  });

  it("reverts the runtime to built-in when a profile option is picked while external", async () => {
    const onSwitchActive = vi.fn();
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "qwen-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx({ onSwitchActive }));
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
    await openRuntimeSelect(/Runtime: qwen-code/);
    pickOption(/GLM/);
    // Both halves of the coupling: the profile switch AND the revert.
    expect(onSwitchActive).toHaveBeenCalledWith("glm");
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", { kind: "built_in" }),
    );
  });

  it("renders the not-configured placeholder when the profile set is empty (issue #570)", async () => {
    renderPicker(
      pickerJsx({ provider: { profiles: [], active_profile: null } }),
    );
    // Zero profiles: the trigger's readout is itself "Not configured".
    await openRuntimeSelect("Runtime: Not configured");
    // The posture label and the dropdown's disabled placeholder read
    // "Not configured"; the assertion pins that no real profile option
    // renders.
    expect(screen.getAllByText("Not configured").length).toBe(2);
    const placeholder = screen.getByRole("option", { name: "Not configured" });
    expect(placeholder.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("option", { name: "Anthropic" })).toBeNull();
  });

  it("marks keyless profiles at the option level (ADR-0019/0099)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([
        ["anthropic", false],
        ["glm", true],
      ]),
    );
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    // The mark lands on the Anthropic option (await: the key overlay fetch
    // is a mount-time effect), never on the keyed GLM option.
    const mark = await screen.findByText("no key");
    expect(mark.closest("[role=\"option\"]")?.textContent).toContain("Anthropic");
    const glmOption = screen.getByRole("option", { name: "GLM" });
    expect(glmOption.textContent).not.toContain("no key");
  });

  it("marks a profile whose keychain read failed", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false, "keychain locked"]]),
    );
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    const mark = await screen.findByText("Credential store unavailable");
    expect(mark.closest("[role=\"option\"]")?.textContent).toContain("Anthropic");
  });

  it("keeps the keyless mark off the trigger's accessible name (row-level mark surface)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false]]),
    );
    renderPicker(pickerJsx());
    // Query the trigger BEFORE opening: once the dropdown is open Radix
    // aria-hides the outside tree, so getByRole would miss it.
    const trigger = screen.getByRole("combobox", { name: BUILTIN_TRIGGER });
    await openRuntimeSelect();
    // The mark lives on the dropdown option; the icon trigger's accessible
    // name carries the runtime readout alone.
    expect(await screen.findByText("no key")).toBeTruthy();
    expect(trigger.getAttribute("aria-label")).not.toContain("no key");
  });

  it("shows the None detected placeholder when no adapter is detected", async () => {
    // beforeEach seeds an empty adapter table: the honest empty-list
    // placeholder option, not a blank group.
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    const placeholder = screen.getByRole("option", { name: "None detected" });
    expect(placeholder.getAttribute("aria-disabled")).toBe("true");
  });

  it("offers only detected external adapters as CLI options", async () => {
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("qwen-code", "qwen-code", true),
      adapter("gemini-cli", "gemini-cli", false),
    ]);
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    expect(screen.getByRole("option", { name: "qwen-code" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "gemini-cli" })).toBeNull();
  });

  it("writes the external choice when a detected CLI option is picked", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    pickOption("qwen-code");
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
    await openRuntimeSelect();
    pickOption("qwen-code");
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

  it("shows a stale-adapter warning with the held adapter as a disabled synthetic option", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "gemini-cli",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await screen.findByRole("combobox", { name: /Runtime: gemini-cli/ });
    await openRuntimeSelect(/Runtime: gemini-cli/);
    expect(
      await screen.findByText(/Selected adapter is no longer detected/),
    ).toBeTruthy();
    // The held (undetected) adapter stays visible as the DISABLED synthetic
    // option carrying the check -- a value with no matching item would
    // leave the dropdown with no visible selection (issue #490).
    const staleOption = screen.getByRole("option", {
      name: "gemini-cli (no longer detected)",
    });
    expect(staleOption.getAttribute("aria-disabled")).toBe("true");
    expect(staleOption.getAttribute("data-state")).toBe("checked");
    // The detected table renders alongside.
    expect(screen.getByRole("option", { name: "qwen-code" })).toBeTruthy();
  });

  it("drops a click on the stale synthetic option (disabled rows never write)", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "gemini-cli",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await screen.findByRole("combobox", { name: /Runtime: gemini-cli/ });
    await openRuntimeSelect(/Runtime: gemini-cli/);
    const staleOption = screen.getByRole("option", {
      name: "gemini-cli (no longer detected)",
    });
    fireEvent.pointerUp(staleOption, { button: 0, pointerType: "mouse" });
    fireEvent.click(staleOption);
    // The disabled synthetic row sits in the REAL writable namespace --
    // a click that slipped through would write the undetected id.
    expect(setSessionRuntime).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "qwen-code" })).toBeTruthy();
  });

  it("retires the settings-test guidance from the dropdown when the active CLI has no catalog", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "qwen-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
    await openRuntimeSelect(/Runtime: qwen-code/);
    expect(
      screen.queryByText(/Test the runtime in settings/),
    ).toBeNull();
  });

  it("opens settings from the Manage runtimes option and closes the dropdown", async () => {
    const onOpenSettings = vi.fn();
    const onSwitchActive = vi.fn();
    renderPicker(pickerJsx({ onOpenSettings, onSwitchActive }));
    await openRuntimeSelect();
    pickOption("Manage runtimes");
    expect(onOpenSettings).toHaveBeenCalledWith();
    // The sentinel is navigation only: no runtime write, no profile
    // switch (falling through the value parse would corrupt
    // active_profile).
    expect(setSessionRuntime).not.toHaveBeenCalled();
    expect(onSwitchActive).not.toHaveBeenCalled();
    // The dropdown ACTUALLY closes (the content unmounts), not just the
    // callback firing -- the portaled content would otherwise stay visible
    // atop the settings overlay.
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
  });

  it("disables the select while a runtime write is in flight", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    // A write that never settles pins switching=true.
    vi.mocked(setSessionRuntime).mockImplementation(
      () => new Promise<void>(() => {}),
    );
    renderPicker(pickerJsx());
    await openRuntimeSelect();
    pickOption("qwen-code");
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull(), {
      timeout: 3000,
    });
    // The write window's visible half: the whole select disables for the
    // in-flight IPC.
    const trigger = screen.getByRole("combobox", {
      name: BUILTIN_TRIGGER,
    }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
  });

  it("does not call getSessionRuntime when sessionId is null", () => {
    renderPicker(
      pickerJsx({
        sessionId: null,
        coldStart: staticColdStartChannel(null, { kind: "built_in" }),
      }),
    );
    expect(getSessionRuntime).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: BUILTIN_TRIGGER }),
    ).toBeTruthy();
  });

  it("renders the channel's pendingRuntime in the trigger name when sessionId is null (issue #572)", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(
      pickerJsx({
        sessionId: null,
        coldStart: staticColdStartChannel(),
      }),
    );
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
  });

  it("renders the runtime read failure as the chip's fault line instead of the control (issue #600)", async () => {
    // The #529 convention's runtime-side twin: a rejected runtime read must
    // not masquerade as the built-in default -- the destructive status line
    // replaces the Select control entirely (the modelConfig configFault
    // treatment on its sibling query).
    vi.mocked(getSessionRuntime).mockRejectedValue(new Error("ipc down"));
    renderPicker(pickerJsx());
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: BUILTIN_TRIGGER })).toBeNull();
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
  await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
}

describe("ComposerProviderPicker built-in posture menu (issue #1639)", () => {
  it("renders the fallback menu before any probe: the held model's synthetic row + the annotated clearing row, no error", () => {
    renderPicker(pickerJsx());
    // The probe never ran (only the menu-open event arms it): the fallback
    // shape is the honest catalog -- the profile model's synthetic row and
    // the clearing row annotated with it. Silent by contract: no fault
    // line anywhere, and zero catalog IPC.
    expect(
      screen.getByRole("menuitemradio", {
        name: "claude-sonnet-4-6 (not offered by this runtime)",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", {
        name: "Default (recommended) (claude-sonnet-4-6)",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(getBuiltinPostureCatalog).not.toHaveBeenCalled();
  });

  it("probes lazily: zero calls before the menu opens, one on the first open, none on a re-open while the answer is non-empty", async () => {
    vi.mocked(getBuiltinPostureCatalog).mockResolvedValue([
      {
        id: "claude-sonnet-4-5",
        display_name: "Claude Sonnet 4.5",
        supported_reasoning_efforts: [],
      },
    ]);
    renderPicker(pickerJsx());
    expect(getBuiltinPostureCatalog).not.toHaveBeenCalled();
    // The menu-open event (the mock's captured handler) is the one arm.
    act(() => openChangeCapture.handler?.(true));
    await screen.findByRole("menuitemradio", { name: "Claude Sonnet 4.5" });
    // A re-open arms nothing new: the arm already matches this endpoint and
    // the query's staleTime is Infinity -- one fetch per endpoint.
    act(() => openChangeCapture.handler?.(true));
    expect(getBuiltinPostureCatalog).toHaveBeenCalledTimes(1);
  });

  it("re-asks on every open that follows an empty answer: a failed probe stays retryable (ADR-0153)", async () => {
    const { queryClient } = renderPicker(pickerJsx());
    act(() => openChangeCapture.handler?.(true));
    // The default mock answers the empty list -- a failed probe's shape on
    // the wire, indistinguishable from an honest empty. Only the backend
    // knows whether a failure is over (it caches successes, never
    // failures), so the next open must reach it again.
    // find() is exact by default; the prefix form needs the flag.
    const catalogQuery = () =>
      queryClient
        .getQueryCache()
        .find({ queryKey: ["adapters", "builtinPostureCatalog"], exact: false });
    await waitFor(() =>
      expect(getBuiltinPostureCatalog).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(catalogQuery()?.state.status).toBe("success"));
    // The second answer hangs: a re-open while a probe is in flight must
    // not start another one.
    vi.mocked(getBuiltinPostureCatalog).mockImplementationOnce(
      () => new Promise<BuiltinCatalogModel[]>(() => {}),
    );
    act(() => openChangeCapture.handler?.(true));
    await waitFor(() =>
      expect(getBuiltinPostureCatalog).toHaveBeenCalledTimes(2),
    );
    act(() => openChangeCapture.handler?.(true));
    expect(getBuiltinPostureCatalog).toHaveBeenCalledTimes(2);
  });

  it("stays zero-egress after a profile endpoint edit until the menu opens again", async () => {
    const { rerender, queryClient } = renderPicker(pickerJsx());
    act(() => openChangeCapture.handler?.(true));
    await waitFor(() =>
      expect(getBuiltinPostureCatalog).toHaveBeenCalledTimes(1),
    );
    // A settings edit lands as a new provider prop with a different
    // endpoint: the stale arm (scoped to the OLD endpoint) no longer
    // matches, so the new key must NOT fetch on a mere re-render -- same
    // QueryClient, the new key simply has no entry and enabled stays
    // false.
    const edited = pickerProvider();
    edited.profiles[0].base_url = "https://proxy.example.com";
    rerender(
      wrap(
        <ComposerProviderPicker
          sessionId="sess-1"
          provider={edited}
          onSwitchActive={vi.fn()}
          onOpenSettings={vi.fn()}
          coldStart={null}
        />,
        queryClient,
      ),
    );
    expect(getBuiltinPostureCatalog).toHaveBeenCalledTimes(1);
    // The next open on the NEW endpoint arms and fetches it.
    act(() => openChangeCapture.handler?.(true));
    await waitFor(() =>
      expect(getBuiltinPostureCatalog).toHaveBeenCalledTimes(2),
    );
  });

  it("lists the probe's models with display names and writes the selection through the set IPC", async () => {
    vi.mocked(getBuiltinPostureCatalog).mockResolvedValue([
      {
        id: "claude-sonnet-4-5",
        display_name: "Claude Sonnet 4.5",
        supported_reasoning_efforts: ["low", "high"],
      },
      {
        id: "custom-deploy-7",
        display_name: "custom-deploy-7",
        supported_reasoning_efforts: [],
      },
    ]);
    renderPicker(pickerJsx());
    act(() => openChangeCapture.handler?.(true));
    // The probed rows render once the query lands: the display name for
    // the cataloged id, the id verbatim for the uncataloged one.
    const row = await screen.findByRole("menuitemradio", {
      name: "Claude Sonnet 4.5",
    });
    fireEvent.click(row);
    // The full pair lands through the one write port (issue #603): the
    // picked model with the untouched (null) level.
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", {
        model: "claude-sonnet-4-5",
        thought_level: null,
      }),
    );
    // The selected-state readout: the write's cache seed flips the button
    // to the held pair's model (the external runtime's readout form).
    expect(
      await screen.findByRole("button", { name: /^Model: claude-sonnet-4-5/ }),
    ).toBeTruthy();
  });

  it("resets a held built-in posture when the endpoint identity changes (issue #1639 namespace reset)", async () => {
    // A model picked under one endpoint is that endpoint's fact. When the
    // active profile moves to another endpoint -- a prop change here, the
    // same way the top-bar switcher and a Settings save land it -- the held
    // pair must not ride into the new endpoint: the reset is the runtime
    // write a runtime switch already makes (the server re-seeds the empty
    // pair).
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: "claude-sonnet-4-5",
      thought_level: "high",
      cached_discovered: null,
    });
    const { rerender, queryClient } = renderPicker(pickerJsx());
    await screen.findByRole("button", { name: /^Model: claude-sonnet-4-5/ });
    expect(setSessionRuntime).not.toHaveBeenCalled();
    rerender(wrap(pickerJsx({ provider: pickerProvider("glm") }), queryClient));
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
        kind: "built_in",
      }),
    );
  });

  it("drops a pending cold-start posture when the endpoint identity changes (issue #1639)", () => {
    // The cold-start bar's half of the same reset: the channel's runtime
    // write is the pending pair's single reset point (ADR-0100 D2).
    const channel = staticColdStartChannel(
      { model: "claude-sonnet-4-5", thought_level: null },
      { kind: "built_in" },
    );
    const { rerender, queryClient } = renderPicker(
      pickerJsx({ sessionId: null, coldStart: channel }),
    );
    expect(channel.port.writeRuntime).not.toHaveBeenCalled();
    rerender(
      wrap(
        pickerJsx({
          sessionId: null,
          coldStart: channel,
          provider: pickerProvider("glm"),
        }),
        queryClient,
      ),
    );
    expect(channel.port.writeRuntime).toHaveBeenCalledWith({
      kind: "built_in",
    });
  });

  it("clears a held level the newly picked built-in model does not support in the same submit (issue #537 linkage)", async () => {
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: "claude-sonnet-4-6",
      thought_level: "high",
      cached_discovered: null,
    });
    vi.mocked(getBuiltinPostureCatalog).mockResolvedValue([
      {
        id: "claude-sonnet-4-5",
        display_name: "Claude Sonnet 4.5",
        supported_reasoning_efforts: ["low"],
      },
    ]);
    renderPicker(pickerJsx());
    act(() => openChangeCapture.handler?.(true));
    const row = await screen.findByRole("menuitemradio", {
      name: "Claude Sonnet 4.5",
    });
    fireEvent.click(row);
    // The held "high" is outside the picked model's set, so the linkage
    // clear rides the SAME wire submit: one call carries the pick and the
    // level null.
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", {
        model: "claude-sonnet-4-5",
        thought_level: null,
      }),
    );
  });

  it("renders the built-in read failure as an inline status line instead of the menu (issue #529)", async () => {
    // The read guards are runtime-agnostic since #1639: on a built-in
    // session too, a rejected read must not masquerade as the unselected
    // default -- the fault replaces the control, so no fallback row can be
    // clicked into an explicit clear of the server-held pair.
    vi.mocked(getSessionModelConfig).mockRejectedValue(new Error("ipc down"));
    renderPicker(pickerJsx());
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("never submits a built-in selection while the model-config read is unsettled (issue #603)", async () => {
    vi.mocked(getSessionModelConfig).mockImplementation(
      () => new Promise<SessionModelConfig>(() => {}),
    );
    renderPicker(pickerJsx());
    const trigger = await screen.findByRole("button", { name: /^Model: / });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    // Radix items ignore the trigger's disabled state, so the handler drops
    // the gesture too.
    fireEvent.click(
      screen.getByRole("menuitemradio", {
        name: "claude-sonnet-4-6 (not offered by this runtime)",
      }),
    );
    expect(setSessionPosture).not.toHaveBeenCalled();
  });
});

describe("ComposerProviderPicker posture button label (ADR-0099 D3, issue #573)", () => {
  it("shows the active profile's model on the built-in runtime's menu button", () => {
    renderPicker(pickerJsx());
    // Interactive since #1639: a profile row exists, so the posture
    // control seats the cascade menu (the fallback shape before any
    // probe -- the held model's synthetic row + the clearing row).
    expect(
      screen.getByRole("button", { name: "Model: claude-sonnet-4-6" }),
    ).toBeTruthy();
  });

  it("switches the label with the runtime within one dropdown visit", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    renderPicker(pickerJsx());
    // Built-in: the label is the active profile's model (the button-name
    // query -- the always-open menu's inline value repeats the same text).
    expect(
      screen.getByRole("button", { name: "Model: claude-sonnet-4-6" }),
    ).toBeTruthy();
    await openRuntimeSelect();
    pickOption("qwen-code");
    // External with no catalog: the label switches to the CLI default and
    // the profile model readout is gone.
    expect(await screen.findByText("Default (recommended)")).toBeTruthy();
    expect(screen.queryByText("claude-sonnet-4-6")).toBeNull();
    // Back to built-in via the profile option (a profile pick IS the
    // built-in pick): the label returns to the profile model and the CLI
    // default readout is gone (the button-name query -- the always-open
    // menu's inline value repeats the same text).
    await openRuntimeSelect(/Runtime: qwen-code/);
    pickOption(/Anthropic/);
    expect(
      await screen.findByRole("button", { name: "Model: claude-sonnet-4-6" }),
    ).toBeTruthy();
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
    // Icon-only face: the posture label is the only "Not configured" text
    // (the select trigger's accessible name is not a text node).
    expect(screen.getAllByText("Not configured").length).toBe(1);
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
        coldStart: staticColdStartChannel(),
      }),
    );
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
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
    await screen.findByRole("combobox", { name: /Runtime: claude-code/ });
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
    await screen.findByRole("combobox", { name: /Runtime: codex/ });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5-codex" }));
    // The linkage clear rides the SAME wire submit (issues #537 + #603):
    // one call carries the model pick AND the level null.
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "gpt-5-codex", thought_level: null }),
    );
  });

  it("keeps a held effort the picked model supports in the same submit (codex, issue #603)", async () => {
    // The untouched dimension arrives as its CURRENT value: the held
    // "medium" IS in gpt-5's supported set, so the model pick submits the
    // pair verbatim -- no linkage clear, no null coercion. Pins the
    // retained-field branch of the full-pair wire in the model direction
    // (a degenerate unconditional null would pass every other test).
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([codexAdapter("codex")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: "medium",
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue(codexProbeEntry(CODEX_MODELS));
    renderPicker(pickerJsx());
    await screen.findByRole("combobox", { name: /Runtime: codex/ });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5" }));
    await waitFor(() =>
      expect(setSessionPosture).toHaveBeenCalledWith("sess-1", { model: "gpt-5", thought_level: "medium" }),
    );
  });

  it("never submits while the model-config read is unsettled (issue #603 review)", async () => {
    // The full-pair wire makes the client cache the authority for the
    // UNTOUCHED field of every submit: while the first fetch is in flight
    // the DEFAULT fallback ({null, null}) must not become a submit -- a
    // click would coerce the server-held level into an explicit clear and
    // persist it. The catalog is independently live (the probe cache), so
    // the read is the only gate: the trigger disables AND the handler
    // drops the gesture (the menu mock renders rows regardless of the
    // trigger's disabled state).
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([codexAdapter("codex")]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue(codexProbeEntry(CODEX_MODELS));
    vi.mocked(getSessionModelConfig).mockImplementation(
      () => new Promise<SessionModelConfig>(() => {}),
    );
    renderPicker(pickerJsx());
    await screen.findByRole("combobox", { name: /Runtime: codex/ });
    const trigger = screen.getByRole("button", { name: /^Model: / });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5" }));
    expect(setSessionPosture).not.toHaveBeenCalled();
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
    await screen.findByRole("combobox", { name: /Runtime: codex/ });
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
      await screen.findByText(/Selection not saved: Couldn't save the data file/),
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
        coldStart: staticColdStartChannel(),
        ...overrides,
      }),
    );
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
    await settlePostureSurface();
  }

  // The shell-shaped cold-start host: the pending pair lives in the REAL
  // cold-start selection channel (the same hook App mounts), so picker
  // reads and writes round-trip through the production port (the #592
  // guard reads the pair the user actually sees).
  function ColdStartHost({
    onPostureChange,
  }: {
    onPostureChange: (posture: ModelPosture | null) => void;
  }) {
    const queryClient = useQueryClient();
    const selection = useColdStartSelection({
      startupRuntime: { kind: "external", data: "qwen-code" },
      queryClient,
    });
    useEffect(() => {
      onPostureChange(selection.pendingModelPosture);
    }, [selection.pendingModelPosture, onPostureChange]);
    return (
      <ComposerProviderPicker
        sessionId={null}
        provider={pickerProvider()}
        onSwitchActive={vi.fn()}
        onOpenSettings={vi.fn()}
        coldStart={selection.channel}
      />
    );
  }

  async function renderColdStartHost(
    onPostureChange: (p: ModelPosture | null) => void,
  ) {
    seedColdStartCatalog();
    renderPicker(<ColdStartHost onPostureChange={onPostureChange} />);
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
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
      coldStart: staticColdStartChannel({
        model: "fake-sonnet",
        thought_level: null,
      }),
    });
    // The explicit pending pair wins over the seeded entry.
    expect(
      screen.getByRole("button", { name: "Model: fake-sonnet" }),
    ).toBeTruthy();
    expect(screen.queryByText("fake-opus · medium")).toBeNull();
  });

  it("routes a pick through the cold-start port seeded from the backfill (no set IPCs)", async () => {
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    const onPostureChange = vi.fn();
    await renderColdStartHost(onPostureChange);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "fake-sonnet" }));
    expect(onPostureChange).toHaveBeenCalledWith({
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
    const onPostureChange = vi.fn();
    await renderColdStartHost(onPostureChange);
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[0]);
    expect(onPostureChange).toHaveBeenCalledWith({
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
    const channel = staticColdStartChannel(
      null,
      { kind: "external", data: "codex" },
    );
    renderPicker(pickerJsx({ sessionId: null, coldStart: channel }));
    await screen.findByRole("combobox", { name: /Runtime: codex/ });
    // This render is inline (its own codex seed, not the helpers), so await
    // the catalog-gated row directly -- the same second-hop settle the
    // cold-start helpers perform.
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "gpt-5-codex" }),
    );
    // The routed intent through the recording port: the unsupported level
    // cleared in the same patch.
    expect(channel.port.writePosture).toHaveBeenCalledWith(
      { model: "gpt-5-codex", thought_level: null },
      { clearsBackfill: false, rollbackTo: { model: "gpt-5", thought_level: "medium" } },
    );
    expect(setSessionPosture).not.toHaveBeenCalled();
  });

  it("routes a runtime switch through the cold-start port (no set IPCs)", async () => {
    // The cold-start twin of the in-session routing: the switch rides the
    // channel port (which also resets the pending posture, ADR-0100 D2),
    // never the runtime set IPC.
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("qwen-code"),
      adapter("codex"),
    ]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
    const channel = staticColdStartChannel();
    renderPicker(pickerJsx({ sessionId: null, coldStart: channel }));
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
    await settlePostureSurface();
    await openRuntimeSelect(/Runtime: qwen-code/);
    pickOption("codex");
    await waitFor(() =>
      expect(channel.port.writeRuntime).toHaveBeenCalledWith({
        kind: "external",
        data: "codex",
      }),
    );
    expect(setSessionRuntime).not.toHaveBeenCalled();
  });

  it("routes a thought-level pick with the held model through the port (one full-pair submit)", async () => {
    // #603: the held model rides the submit untouched -- an untouched
    // field is never derived -- and a level pick alone does not wipe the
    // backfill entry (only a whole-dimension clear does).
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    const channel = staticColdStartChannel();
    renderPicker(pickerJsx({ sessionId: null, coldStart: channel }));
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
    await settlePostureSurface();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "high" }));
    expect(channel.port.writePosture).toHaveBeenCalledWith(
      { model: "fake-opus", thought_level: "high" },
      {
        clearsBackfill: false,
        rollbackTo: { model: "fake-opus", thought_level: "medium" },
      },
    );
    expect(setSessionPosture).not.toHaveBeenCalled();
  });

  it("wipes the backfill entry on a level-dimension clear (clearsBackfill routes per gesture)", async () => {
    // Clearing the level dimension is a whole-dimension clear gesture:
    // the pending write carries the held model with a null level, and the
    // port receives clearsBackfill so the #581 entry is wiped with it.
    vi.mocked(listAdapters).mockResolvedValue([adapter("qwen-code")]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue(acpProbeEntry(CATALOG));
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    const channel = staticColdStartChannel();
    renderPicker(pickerJsx({ sessionId: null, coldStart: channel }));
    await screen.findByRole("combobox", { name: /Runtime: qwen-code/ });
    await settlePostureSurface();
    // The always-open menu holds two clear rows -- the level dimension's
    // is the second ("Default (recommended)" on both).
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[1]);
    expect(channel.port.writePosture).toHaveBeenCalledWith(
      { model: "fake-opus", thought_level: null },
      {
        clearsBackfill: true,
        rollbackTo: { model: "fake-opus", thought_level: "medium" },
      },
    );
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
    // Hosted on the real channel so the rollback guard reads the pair the
    // user actually sees (issue #592 -- the ledger's skip arms live port-
    // level in composer-selection-write.test.tsx).
    vi.mocked(getLastModelPosture).mockResolvedValue({
      model: "fake-opus",
      thought_level: "medium",
    });
    vi.mocked(clearLastModelPosture).mockRejectedValueOnce(
      new Error("config write failed"),
    );
    const onPostureChange = vi.fn();
    await renderColdStartHost(onPostureChange);
    const clearingRows = screen.getAllByRole("menuitem", {
      name: "Default (recommended)",
    });
    fireEvent.click(clearingRows[0]);
    // Call 1 is the spy's mount effect with the initial null pair; the
    // write sequence follows it.
    expect(onPostureChange).toHaveBeenNthCalledWith(2, {
      model: null,
      thought_level: "medium",
    });
    await waitFor(() =>
      expect(onPostureChange).toHaveBeenNthCalledWith(3, {
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
        coldStart: staticColdStartChannel(null, { kind: "built_in" }),
      }),
    );
    await screen.findByRole("combobox", { name: BUILTIN_TRIGGER });
    expect(getLastModelPosture).not.toHaveBeenCalled();
  });
});

// The provenance-staleness and priority-chain projection matrices live
// function-level in posture-catalog.test.tsx (the picker only assembles
// the reads); the note's rendering is pinned in
// ComposerPostureTrigger.test.tsx.

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
    await openRuntimeSelect();
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
    // The tooltip is permanently controlled with the #1438 gate: a genuine
    // hover is pointerEnter (the pointer-leg marker) + pointerMove (Radix's
    // open gesture keys on the move).
    fireEvent.pointerEnter(
      screen.getByRole("combobox", { name: BUILTIN_TRIGGER }),
    );
    fireEvent.pointerMove(
      screen.getByRole("combobox", { name: BUILTIN_TRIGGER }),
    );
    expect(await screen.findByText("Anthropic · claude-sonnet-4-6")).toBeTruthy();
  });

  it("appends the honest no-key mark when the active profile has no key (ADR-0019)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false]]),
    );
    renderPicker(pickerJsx());
    fireEvent.pointerEnter(
      screen.getByRole("combobox", { name: BUILTIN_TRIGGER }),
    );
    fireEvent.pointerMove(
      screen.getByRole("combobox", { name: BUILTIN_TRIGGER }),
    );
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
    const trigger = await screen.findByRole("combobox", { name: /Runtime: Qwen Code/ });
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    expect(await screen.findByText("External runtime: Qwen Code")).toBeTruthy();
  });

  // The #1438 gate's refusal legs: the select-open leg, the close-grace
  // leg, the pointer leg, and the native pointerleave backstop. The
  // ArtifactHeader tests (same ruling) demonstrate the harness.
  it("refuses a hover intent while the select is open and inside the close grace, then restores real hover (issue #1438)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", true]]),
    );
    renderPicker(pickerJsx());
    const trigger = screen.getByRole("combobox", { name: BUILTIN_TRIGGER });
    // A genuine hover opens (pointerEnter marks the pointer leg; Radix's
    // open gesture keys on the move).
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    await screen.findByText("Anthropic · claude-sonnet-4-6");
    // Open the select: the render face (tipOpen gated on !selectOpen)
    // retires the tooltip...
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    await screen.findByRole("option", { name: "Anthropic" });
    expect(screen.queryByText("Anthropic · claude-sonnet-4-6")).toBeNull();
    // ...and while the select is open a hover intent on the trigger is
    // refused outright.
    fireEvent.pointerMove(trigger);
    expect(screen.queryByText("Anthropic · claude-sonnet-4-6")).toBeNull();
    // Pick an option: the select closes and restores focus to the trigger
    // in the same gesture -- inside MENU_REENTRY_GRACE_MS the re-open
    // intent must be refused or the tooltip resurrects itself (the
    // phantom #1438 exists to kill).
    pickOption("GLM");
    fireEvent.pointerMove(trigger);
    expect(screen.queryByText("Anthropic · claude-sonnet-4-6")).toBeNull();
    // Past the grace a genuine hover (leave + re-enter) opens as usual.
    fireEvent.pointerLeave(trigger);
    await new Promise((r) => setTimeout(r, MENU_REENTRY_GRACE_MS + 50));
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    await screen.findByText("Anthropic · claude-sonnet-4-6");
  });

  it("refuses the late focus return via the pointer leg (issue #1438)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", true]]),
    );
    renderPicker(pickerJsx());
    const trigger = screen.getByRole("combobox", { name: BUILTIN_TRIGGER });
    // The pointer hovers, then departs BEFORE opening the select.
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    await screen.findByRole("option", { name: "Anthropic" });
    pickOption("GLM");
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull(), {
      timeout: 3000,
    });
    // Long after the close grace a focus event lands on the trigger with
    // the pointer still away -- the pointer leg, not the grace leg, must
    // refuse it.
    await new Promise((r) => setTimeout(r, MENU_REENTRY_GRACE_MS + 50));
    fireEvent.focus(trigger);
    await waitFor(() => {});
    expect(screen.queryByText("Anthropic · claude-sonnet-4-6")).toBeNull();
    // A genuine hover still opens.
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    await screen.findByText("Anthropic · claude-sonnet-4-6");
  });

  it("refuses the focus return when the synthetic leave cannot derive -- the native backstop clears the marker (issue #1438)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", true]]),
    );
    renderPicker(pickerJsx());
    const trigger = screen.getByRole("combobox", { name: BUILTIN_TRIGGER });
    // The pointer OPENS the select while on the trigger, then moves into
    // the dropdown portal. In the real app the open layer's pointer-events
    // suppression can keep React from deriving the synthetic
    // onPointerLeave there (the sidebar hover-card machine's CDP-measured
    // artifact), so NO synthetic leave is fired here -- the native
    // backstop must clear the marker.
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger);
    await screen.findByRole("option", { name: "Anthropic" });
    // A non-bubbling native pointerleave: the backstop's listener sees it,
    // React's synthetic derivation (root-level, bubble-fed) does not.
    trigger.dispatchEvent(new Event("pointerleave"));
    pickOption("GLM");
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull(), {
      timeout: 3000,
    });
    await new Promise((r) => setTimeout(r, MENU_REENTRY_GRACE_MS + 50));
    fireEvent.focus(trigger);
    await waitFor(() => {});
    // Without the backstop the marker strands "on" and this focus return
    // sails through the pointer leg -- the phantom again.
    expect(screen.queryByText("Anthropic · claude-sonnet-4-6")).toBeNull();
    // The pointer's proper exit restores the normal cycle (the synthetic
    // leave also resets Radix's one-shot pointermove edge lock).
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerEnter(trigger);
    fireEvent.pointerMove(trigger);
    await screen.findByText("Anthropic · claude-sonnet-4-6");
  });
});
