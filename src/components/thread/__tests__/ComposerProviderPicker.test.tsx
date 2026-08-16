import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ComposerProviderPicker } from "../ComposerProviderPicker";
import {
  getAdapterCatalogs,
  getSessionModelConfig,
  getSessionRuntime,
  listAdapters,
  listProviderProfiles,
  setSessionModel,
  setSessionRuntime,
  setSessionThoughtLevel,
  type SetModelPersistOutcome,
} from "../../../api";
import { sessionKeys } from "../../../session/queryKeys";
import { TooltipProvider } from "../../ui/tooltip";
import type { ProviderConfig, ProfileKeyStatus } from "../../../types/provider";
import type {
  AdapterEntry,
  AdapterCatalogs,
  CodexModel,
  DiscoveredRuntime,
  SessionRuntimeChoice,
} from "../../../types/runtime";

// ComposerProviderPicker routes its chrome through react-intl (ADR-0052) +
// needs a Radix TooltipProvider ancestor for the hover Tooltip + a
// QueryClientProvider for its runtime + adapter reads (issue #353). Rendered
// inside an empty-catalog English IntlProvider so FormattedMessage / useIntl
// fall back to the defaultMessage -- the canonical English source (ADR-0052)
// -- and assertions anchor on stable English strings. onError silences the
// expected missing-message warnings. The IPC pair is mocked so the view never
// hits Tauri (ADR-0029 one-shot keychain surface).
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
  };
});

// The set commands' clean persist verdict (issue #529): the write landed.
const PERSIST_OK: SetModelPersistOutcome = {
  persist_error: null,
  persist_suspended: false,
};

// Build the provider tree around `ui` with a fresh QueryClient (retry off so
// a rejected query does not retry under waitFor). Exposed so a rerender
// reuses the SAME client -- the picker's runtime query must survive a
// profileKeyEpoch rerender without remounting its cache.
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

// A two-profile provider config: Anthropic (a named preset, has a default_model
// in the catalog) active by default, GLM as the alternate. Parameterized so the
// active-profile / has_key tests can seed any state.
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
        model: "glm-4",
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

// One v1 adapter row for the external-section fixture (issue #353).
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

// The built-in runtime is the default; the trigger's accessible name carries
// the active provider (ADR-0071 readout) so the chip reads which runtime the
// next turn uses without opening the popover.
const BUILTIN_TRIGGER = "Runtime: Anthropic";

describe("ComposerProviderPicker (issue #238 / #353, ADR-0071/0081/0083)", () => {
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
  });

  it("renders the icon trigger with an accessible name carrying the active provider", () => {
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    // The trigger is a real <button> so its implicit role + aria-label are
    // stable for black-box queries (Radix asChild forwards both).
    expect(
      screen.getByRole("button", { name: BUILTIN_TRIGGER }),
    ).toBeInTheDocument();
  });

  it("opens the popover with the built-in + external sections on click", async () => {
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    // Built-in section: header + profile label + model field + hint.
    expect(await screen.findByText("Built-in")).toBeInTheDocument();
    expect(screen.getByText("Profile")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(
      screen.getByText("Type a model id, or pick the preset default."),
    ).toBeInTheDocument();
    // External section: header + the "Manage external runtimes" link.
    expect(screen.getByText("External")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Manage external runtimes/ }),
    ).toBeInTheDocument();
    // Open-settings entry (built-in section).
    expect(
      screen.getByRole("button", { name: "Open settings" }),
    ).toBeInTheDocument();
  });

  it("lists every profile in the provider dropdown", async () => {
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    await screen.findByDisplayValue("Anthropic");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      "anthropic",
      "glm",
    ]);
  });

  it("commits active_profile when the provider dropdown changes", async () => {
    const onSwitchActive = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={onSwitchActive}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    const select = await screen.findByDisplayValue("Anthropic");
    fireEvent.change(select, { target: { value: "glm" } });
    expect(onSwitchActive).toHaveBeenCalledWith("glm");
  });

  it("commits the model on blur (not per keystroke)", async () => {
    const onSwitchModel = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={onSwitchModel}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    // The model <input> holds the active profile's current model.
    const input = await screen.findByDisplayValue("claude-sonnet-4-6");
    fireEvent.change(input, { target: { value: "claude-haiku-4-5" } });
    // No commit yet -- per-keystroke writes would spam commitAppConfig.
    expect(onSwitchModel).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onSwitchModel).toHaveBeenCalledWith("claude-haiku-4-5");
  });

  it("commits the model on Enter", async () => {
    const onSwitchModel = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={onSwitchModel}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    const input = await screen.findByDisplayValue("claude-sonnet-4-6");
    fireEvent.change(input, { target: { value: "claude-opus" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSwitchModel).toHaveBeenCalledWith("claude-opus");
  });

  it("does not commit a no-op model (unchanged value)", async () => {
    const onSwitchModel = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={onSwitchModel}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    const input = await screen.findByDisplayValue("claude-sonnet-4-6");
    // Blur without changing -> no pointless app-config write.
    fireEvent.blur(input);
    expect(onSwitchModel).not.toHaveBeenCalled();
  });

  it("re-syncs the model draft when the active profile's model changes externally", async () => {
    // A Settings Save (or any external commitAppConfig) rewrites the active
    // profile's model; the popover must not show a stale draft on the next open.
    // The parent feeds a new provider prop with the updated model; the draft
    // re-syncs because the (active_profile, model) seed changed.
    function View({ model }: { model: string }) {
      return (
        <ComposerProviderPicker
          sessionId="sess-1"
          provider={{
            ...pickerProvider(),
            profiles: [
              { ...pickerProvider().profiles[0], model },
              pickerProvider().profiles[1],
            ],
          }}
          onSwitchActive={() => {}}
          onSwitchModel={() => {}}
          onOpenSettings={vi.fn()}
        />
      );
    }
    const { queryClient, rerender } = renderPicker(<View model="claude-sonnet-4-6" />);
    // Mount + initial draft = the seeded model.
    expect(() => screen.getAllByRole("button")).not.toThrow();

    // External change: the active profile's model is now "claude-opus".
    rerender(wrap(<View model="claude-opus" />, queryClient));
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    // The input reflects the new model, not a stale draft.
    expect(await screen.findByDisplayValue("claude-opus")).toBeInTheDocument();
  });

  it("refetches the key overlay when profileKeyEpoch bumps (settings-close)", async () => {
    // App bumps profileKeyEpoch on settings-close so a Save that changed a
    // keychain slot is reflected without a remount (ADR-0019 honest gate, #238).
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
    const { queryClient, rerender } = renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
        profileKeyEpoch={0}
      />,
    );
    // Mount-time fetch.
    await waitFor(() => expect(listProviderProfiles).toHaveBeenCalledTimes(1));

    // A settings-close bumps the epoch -> the overlay refetches.
    rerender(
      wrap(
        <ComposerProviderPicker
          sessionId="sess-1"
          provider={pickerProvider()}
          onSwitchActive={() => {}}
          onSwitchModel={() => {}}
          onOpenSettings={vi.fn()}
          profileKeyEpoch={1}
        />,
        queryClient,
      ),
    );
    await waitFor(() => expect(listProviderProfiles).toHaveBeenCalledTimes(2));
  });

  it("shows the honest no-key badge + warning when the active profile has no key", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([
        ["anthropic", false],
        ["glm", true],
      ]),
    );
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    // Wait for the mount-time key overlay fetch to land before asserting.
    await screen.findByText("No key");
    expect(screen.getByText("No key")).toBeInTheDocument();
    // ADR-0019 honest gate: the explicit "asking will fail" line.
    expect(screen.getByText(/No key saved for this profile/)).toBeInTheDocument();
  });

  it("shows Key set and no warning when the active profile has a key", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(keyStatus([["anthropic", true]]));
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    await screen.findByText("Key set");
    expect(screen.getByText("Key set")).toBeInTheDocument();
    expect(
      screen.queryByText(/No key saved for this profile/),
    ).not.toBeInTheDocument();
  });

  it("opens settings and closes the popover on the Open settings entry", async () => {
    const onOpenSettings = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    const openBtn = await screen.findByRole("button", { name: "Open settings" });
    fireEvent.click(openBtn);
    expect(onOpenSettings).toHaveBeenCalledWith("api-access");
    // The popover must close (its portaled content would otherwise linger
    // atop the settings overlay, ADR-0065 hides the shell via CSS not the host).
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Open settings" }),
      ).not.toBeInTheDocument();
    });
  });

  it("surfaces the provider . model preview in the hover tooltip (+ no-key mark)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(keyStatus([["anthropic", false]]));
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: BUILTIN_TRIGGER });
    // Radix Tooltip opens on pointer hover with pointerType mouse (jsdom needs
    // the pointerType set explicitly; bare mouseEnter does not trigger it).
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    // The tooltip carries "{provider} . {model} . no key" (ADR-0019 mark).
    expect(tooltip.textContent).toContain("Anthropic");
    expect(tooltip.textContent).toContain("claude-sonnet-4-6");
    expect(tooltip.textContent).toContain("no key");
  });

  it("omits the no-key mark from the tooltip when the active profile has a key", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(keyStatus([["anthropic", true]]));
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: BUILTIN_TRIGGER });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("claude-sonnet-4-6");
    // The tooltip text never carries the "no key" suffix when a key is set.
    expect(tooltip.textContent).not.toContain("no key");
  });

  it("shows the keychain-unavailable badge when the active profile's keychain read failed (issue #275)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false, "keychain access failed: locked"]]),
    );
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    await screen.findByText("Keychain unavailable");
    expect(screen.getByText("Keychain unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No key")).not.toBeInTheDocument();
  });

  // --- Runtime selection (issue #353) ---------------------------------------

  it("renders only detected external adapters from listAdapters", async () => {
    // Issue #490: undetected adapters are filtered out (the group is a pure
    // selector; management moved to Settings → Runtime → Local CLI).
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("claude-code", "claude-code", true),
      adapter("gemini-cli", "gemini-cli", false),
    ]);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    // Only the detected adapter renders.
    expect(await screen.findByText("claude-code")).toBeInTheDocument();
    expect(screen.queryByText("gemini-cli")).not.toBeInTheDocument();
    // No "Not installed" mark -- the group is a pure selector.
    expect(screen.queryByText("Not installed")).not.toBeInTheDocument();
  });

  it("selecting an external adapter writes the external choice via setSessionRuntime", async () => {
    vi.mocked(listAdapters).mockResolvedValue([adapter("claude-code", "claude-code", true)]);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    const row = await screen.findByRole("button", { name: /claude-code/ });
    fireEvent.click(row);
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
        kind: "external",
        data: "claude-code",
      }),
    );
  });

  // --- Null sessionId (ADR-0092 cold-start bar) ----------------------------

  it("does not call getSessionRuntime when sessionId is null", () => {
    renderPicker(
      <ComposerProviderPicker
        sessionId={null}
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
        onPendingRuntimeChange={vi.fn()}
      />,
    );
    // The query is disabled — no IPC fires for a null session.
    expect(getSessionRuntime).not.toHaveBeenCalled();
    // The trigger renders with the built-in default (RUNTIME_CHOICE_DEFAULT).
    expect(
      screen.getByRole("button", { name: BUILTIN_TRIGGER }),
    ).toBeInTheDocument();
  });

  it("routes runtime selection to onPendingRuntimeChange when sessionId is null", async () => {
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("claude-code", "claude-code", true),
    ]);
    const onPendingRuntimeChange = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        sessionId={null}
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
        onPendingRuntimeChange={onPendingRuntimeChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    const row = await screen.findByRole("button", { name: /claude-code/ });
    fireEvent.click(row);
    // Selection routes to the pending callback, not the per-session IPC.
    expect(onPendingRuntimeChange).toHaveBeenCalledWith({
      kind: "external",
      data: "claude-code",
    });
    expect(setSessionRuntime).not.toHaveBeenCalled();
  });

  it("selecting the built-in header writes the built-in choice via setSessionRuntime", async () => {
    // Start on the external runtime so reverting to built-in is a real switch.
    const external: SessionRuntimeChoice = { kind: "external", data: "claude-code" };
    vi.mocked(getSessionRuntime).mockResolvedValue(external);
    vi.mocked(listAdapters).mockResolvedValue([adapter("claude-code", "claude-code", true)]);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    // The trigger name carries the external adapter while external is active.
    const trigger = await screen.findByRole("button", { name: "Runtime: claude-code" });
    fireEvent.click(trigger);
    // The built-in header reverts to the built-in runtime.
    const builtinHeader = screen.getByRole("button", { name: /^Built-in$/ });
    fireEvent.click(builtinHeader);
    await waitFor(() =>
      expect(setSessionRuntime).toHaveBeenCalledWith("sess-1", {
        kind: "built_in",
      }),
    );
  });

  it("renders the external runtime in the trigger name + tooltip when external is active", async () => {
    const external: SessionRuntimeChoice = { kind: "external", data: "claude-code" };
    vi.mocked(getSessionRuntime).mockResolvedValue(external);
    vi.mocked(listAdapters).mockResolvedValue([adapter("claude-code", "claude-code", true)]);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    const trigger = await screen.findByRole("button", { name: "Runtime: claude-code" });
    // The hover tooltip names the external runtime (the closed chip's Cpu
    // glyph is unified; the tooltip is where the user reads WHICH runtime).
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("External runtime: claude-code");
  });

  // --- Issue #490: external group slimmed to a pure selector ---------------

  it("the Manage external runtimes link opens settings on the local-cli tab", async () => {
    const onOpenSettings = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    const link = await screen.findByRole("button", { name: /Manage external runtimes/ });
    fireEvent.click(link);
    expect(onOpenSettings).toHaveBeenCalledWith("local-cli");
    // The popover closes (same close-before-open contract as the built-in
    // entry, ADR-0065).
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Manage external runtimes/ }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows a stale-adapter warning when the active external adapter is undetected", async () => {
    // The session's runtime is an external adapter whose detected flag is false
    // (CLI was uninstalled after selection). The filtered list drops it, and the
    // picker surfaces a destructive warning so the user knows their pick is
    // broken before the next turn fails in the backend.
    const external: SessionRuntimeChoice = { kind: "external", data: "gemini-cli" };
    vi.mocked(getSessionRuntime).mockResolvedValue(external);
    vi.mocked(listAdapters).mockResolvedValue([
      adapter("claude-code", "claude-code", true),
      adapter("gemini-cli", "gemini-cli", false),
    ]);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    expect(
      await screen.findByText("Selected adapter is no longer detected — pick another or manage in settings."),
    ).toBeInTheDocument();
    // The undetected adapter does NOT appear as a selectable row.
    expect(screen.queryByText("gemini-cli")).not.toBeInTheDocument();
  });
});

// --- ADR-0095 model + thought-level selectors (issue #527) ------------------

describe("ComposerProviderPicker model config selectors (ADR-0095)", () => {
  beforeEach(() => {
    // Self-contained seeding: this describe must not rely on implementations
    // leaking from the sibling describe (vi.clearAllMocks clears calls, not
    // implementations -- the PR #507 leakage class).
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
    vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
    vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
    vi.mocked(listAdapters).mockResolvedValue([]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
  });

  const CATALOG = {
    models: ["fake-opus", "fake-sonnet"],
    current_model: "fake-opus",
    thought_levels: ["low", "medium", "high"],
    current_thought_level: "medium",
  };

  async function openExternalPopover() {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "claude-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("claude-code")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: CATALOG,
    });
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    // Wait for the external runtime query to land (the trigger label flips
    // from the built-in readout to the adapter name), then open the popover.
    const trigger = await screen.findByRole("button", {
      name: /Runtime: claude-code/,
    });
    fireEvent.click(trigger);
  }

  it("renders dropdowns from the discovered catalog on an ACP runtime", async () => {
    await openExternalPopover();
    const modelSelect = await screen.findByLabelText("Model");
    expect(modelSelect).toBeInTheDocument();
    // The discovered ids + the CLI-default row are offered.
    const options = modelSelect.querySelectorAll("option");
    expect(Array.from(options).map((o) => o.textContent)).toEqual([
      "CLI default (fake-opus)",
      // The CLI's reported current value is annotated as the effective
      // default while no explicit selection is set.
      "fake-opus (CLI default)",
      "fake-sonnet",
    ]);
    // The thought-level selector offers its own catalog.
    const thinkSelect = screen.getByLabelText("Thinking");
    expect(
      Array.from(thinkSelect.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["", "low", "medium", "high"]);
  });

  it("writes the selection through setSessionModel", async () => {
    await openExternalPopover();
    const modelSelect = await screen.findByLabelText("Model");
    fireEvent.change(modelSelect, { target: { value: "fake-sonnet" } });
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "fake-sonnet"),
    );
    expect(setSessionThoughtLevel).not.toHaveBeenCalled();
  });

  it("writes a thought-level selection through setSessionThoughtLevel", async () => {
    await openExternalPopover();
    const thinkSelect = await screen.findByLabelText("Thinking");
    fireEvent.change(thinkSelect, { target: { value: "high" } });
    await waitFor(() =>
      expect(setSessionThoughtLevel).toHaveBeenCalledWith("sess-1", "high"),
    );
  });

  it("shows the pending hint when the external runtime has no discovery cache yet", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "claude-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("claude-code")]);
    // No cached_discovered (before the first ACP turn).
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: claude-code/ }),
    );
    expect(
      await screen.findByText(/Model options appear after the first turn/),
    ).toBeInTheDocument();
    // No dropdowns render in this state.
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("renders read-only CLI-default labels on the codex (JsonEventStream) runtime", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { ...adapter("codex"), stream_format: "json_event_stream" },
    ]);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: codex/ }),
    );
    // Two CLI-default labels render (model + thinking), no dropdowns.
    expect(await screen.findAllByText("CLI default")).toHaveLength(2);
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("renders no selectors on the built-in runtime", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: BUILTIN_TRIGGER }));
    // Give the queries a beat to settle, then assert absence.
    await screen.findByText("Built-in");
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Model options appear after the first turn/),
    ).not.toBeInTheDocument();
  });
});

// --- #529: honest rendering of unrepresentable values + failure feedback ----

describe("ComposerProviderPicker honest selector states (issue #529)", () => {
  beforeEach(() => {
    // Self-contained seeding (same isolation contract as the ADR-0095
    // describe above).
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
    vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
    vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
    vi.mocked(listAdapters).mockResolvedValue([]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
    vi.mocked(setSessionModel).mockResolvedValue(PERSIST_OK);
    vi.mocked(setSessionThoughtLevel).mockResolvedValue(PERSIST_OK);
  });

  const CATALOG = {
    models: ["fake-opus", "fake-sonnet"],
    current_model: "fake-opus",
    thought_levels: ["low", "medium", "high"],
    current_thought_level: "medium",
    adapter_id: "claude-code",
  } satisfies DiscoveredRuntime;

  // Seed an external ACP runtime + open the popover. `config` overrides the
  // model-config read; `adapterId` defaults to the catalog's adapter so the
  // cache reads as fresh.
  async function openExternal(
    config: Awaited<ReturnType<typeof getSessionModelConfig>>,
    adapterId = "claude-code",
  ) {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: adapterId,
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter(adapterId)]);
    vi.mocked(getSessionModelConfig).mockResolvedValue(config);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    const trigger = await screen.findByRole("button", {
      name: new RegExp(`Runtime: ${adapterId}`),
    });
    fireEvent.click(trigger);
  }

  it("renders a fallback option for a selected model not in the catalog", async () => {
    // Catalog drift: the session holds "fake-o3" but the refreshed catalog no
    // longer offers it. The select must still SHOW it (never blank).
    await openExternal({
      model: "fake-o3",
      thought_level: null,
      cached_discovered: CATALOG,
    });
    const modelSelect = await screen.findByLabelText("Model");
    const fallback = modelSelect.querySelector(
      "option[value=\"fake-o3\"]",
    ) as HTMLOptionElement;
    expect(fallback).toBeInTheDocument();
    expect(fallback.textContent).toContain("fake-o3");
    expect(fallback.textContent).toContain("not offered");
    // The controlled value resolves -- the select shows the backend posture.
    expect((modelSelect as HTMLSelectElement).value).toBe("fake-o3");
  });

  it("renders a fallback option for a CLI current value not in the catalog", async () => {
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: {
        ...CATALOG,
        current_model: "ghost-model",
      },
    });
    const modelSelect = await screen.findByLabelText("Model");
    expect(
      modelSelect.querySelector("option[value=\"ghost-model\"]"),
    ).toBeInTheDocument();
    expect((modelSelect as HTMLSelectElement).value).toBe("ghost-model");
  });

  it("renders a fallback option for a selected thought level not in the catalog", async () => {
    // Thought-level mirror of the model fallback: the session holds "ultra"
    // but the catalog does not offer it -- the select must still SHOW it.
    await openExternal({
      model: null,
      thought_level: "ultra",
      cached_discovered: CATALOG,
    });
    const thinkSelect = await screen.findByLabelText("Thinking");
    const fallback = thinkSelect.querySelector(
      "option[value=\"ultra\"]",
    ) as HTMLOptionElement;
    expect(fallback).toBeInTheDocument();
    expect(fallback.textContent).toContain("ultra");
    expect(fallback.textContent).toContain("not offered");
    expect((thinkSelect as HTMLSelectElement).value).toBe("ultra");
  });

  it("renders a fallback option for a CLI current thought level not in the catalog", async () => {
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: {
        ...CATALOG,
        current_thought_level: "ghost-level",
      },
    });
    const thinkSelect = await screen.findByLabelText("Thinking");
    expect(
      thinkSelect.querySelector("option[value=\"ghost-level\"]"),
    ).toBeInTheDocument();
    expect((thinkSelect as HTMLSelectElement).value).toBe("ghost-level");
  });

  it("flags a catalog cached under a different adapter and lets the user clear the model", async () => {
    // The runtime switched to gemini-cli but the cache still holds the
    // claude-code catalog (replace-on-Some only updates after gemini's first
    // turn). A stale marker renders + the residual selection stays visible.
    await openExternal(
      {
        model: "fake-opus",
        thought_level: null,
        cached_discovered: CATALOG,
      },
      "gemini-cli",
    );
    expect(
      await screen.findByText(/discovered on a different runtime/),
    ).toBeInTheDocument();
    // The residual selection renders (via the catalog options) and clearing
    // it writes null (the "" -> null boundary).
    const modelSelect = await screen.findByLabelText("Model");
    expect((modelSelect as HTMLSelectElement).value).toBe("fake-opus");
    fireEvent.change(modelSelect, { target: { value: "" } });
    await waitFor(() => expect(setSessionModel).toHaveBeenCalledWith("sess-1", null));
  });

  it("treats a pre-stamp catalog (no adapter_id) as usable without a stale flag", async () => {
    // Old recipes carry no adapter_id -- the catalog still renders, no stale
    // marker (no provenance is not a mismatch).
    const preStamp = { ...CATALOG, adapter_id: undefined };
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: preStamp,
    });
    const modelSelect = await screen.findByLabelText("Model");
    expect(modelSelect).toBeInTheDocument();
    expect(
      screen.queryByText(/discovered on a different runtime/),
    ).not.toBeInTheDocument();
  });

  it("does not flag the stale catalog on a JsonEventStream runtime (never refreshed)", async () => {
    // A JES runtime (codex) never reports a catalog, so its turns would
    // never replace an ACP-produced cache -- the "refreshes after the next
    // turn" promise would be a permanent lie. The read-only CLI-default
    // surface renders with no stale marker.
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { ...adapter("codex"), stream_format: "json_event_stream" },
    ]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: CATALOG,
    });
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: codex/ }),
    );
    expect(await screen.findAllByText("CLI default")).toHaveLength(2);
    expect(
      screen.queryByText(/discovered on a different runtime/),
    ).not.toBeInTheDocument();
  });

  it("renders an inline error when the model-config read fails (not the pending hint)", async () => {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "claude-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("claude-code")]);
    vi.mocked(getSessionModelConfig).mockRejectedValue(new Error("ipc down"));
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: claude-code/ }),
    );
    // The honest error line, NOT the discovery-pending hint masquerading as
    // "no catalog yet".
    expect(
      await screen.findByText(/Could not load model options/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Model options appear after the first turn/),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("renders an inline error and resyncs when the set-model IPC rejects", async () => {
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: CATALOG,
    });
    vi.mocked(setSessionModel).mockRejectedValue(new Error("write refused"));
    const modelSelect = await screen.findByLabelText("Model");
    fireEvent.change(modelSelect, { target: { value: "fake-sonnet" } });
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeInTheDocument();
    // The refetch-on-reject bounces the select back to the backend posture:
    // no selection held -> the CLI's current default (not the rejected
    // "fake-sonnet" the optimistic write never granted).
    await waitFor(() =>
      expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe(
        "fake-opus",
      ),
    );
  });

  it("renders an inline error when the set-thought-level IPC rejects", async () => {
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: CATALOG,
    });
    vi.mocked(setSessionThoughtLevel).mockRejectedValue(
      new Error("write refused"),
    );
    const thinkSelect = await screen.findByLabelText("Thinking");
    fireEvent.change(thinkSelect, { target: { value: "high" } });
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeInTheDocument();
    // The refetch-on-reject bounces the select back to the backend posture:
    // no selection held -> the CLI's current default (not the rejected
    // "high" the optimistic write never granted).
    await waitFor(() =>
      expect((screen.getByLabelText("Thinking") as HTMLSelectElement).value).toBe(
        "medium",
      ),
    );
  });

  it("surfaces a persistence failure returned by a successful set", async () => {
    // The set IPC resolves, but the returned persist verdict carries a typed
    // write failure -- the selector says the selection was NOT saved to disk.
    vi.mocked(setSessionModel).mockResolvedValue({
      persist_error: { kind: "Io", data: "disk full" },
      persist_suspended: false,
    });
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: CATALOG,
    });
    const modelSelect = await screen.findByLabelText("Model");
    fireEvent.change(modelSelect, { target: { value: "fake-sonnet" } });
    expect(
      await screen.findByText(/Selection not saved: Failed to write/),
    ).toBeInTheDocument();
  });

  it("surfaces a persist suspension (ADR-0035 conflict) returned by a successful set", async () => {
    // The set IPC resolves, but the persist was WITHHELD: the .duck changed
    // externally, so the auto-write is suspended. The old shared-slot read
    // could not see this path at all (no persist_error is set on it).
    vi.mocked(setSessionModel).mockResolvedValue({
      persist_error: null,
      persist_suspended: true,
    });
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: CATALOG,
    });
    const modelSelect = await screen.findByLabelText("Model");
    fireEvent.change(modelSelect, { target: { value: "fake-sonnet" } });
    expect(
      await screen.findByText(/changed outside the app/),
    ).toBeInTheDocument();
  });

  it("clears the failure lines on the next successful selection", async () => {
    vi.mocked(setSessionModel)
      .mockResolvedValueOnce({
        persist_error: { kind: "Io", data: "disk full" },
        persist_suspended: false,
      })
      .mockResolvedValue(PERSIST_OK);
    await openExternal({
      model: null,
      thought_level: null,
      cached_discovered: CATALOG,
    });
    const modelSelect = await screen.findByLabelText("Model");
    fireEvent.change(modelSelect, { target: { value: "fake-sonnet" } });
    expect(
      await screen.findByText(/Selection not saved/),
    ).toBeInTheDocument();
    // The next attempt succeeds -- both fault lines must clear.
    fireEvent.change(modelSelect, { target: { value: "fake-opus" } });
    await waitFor(() =>
      expect(
        screen.queryByText(/Selection not saved/),
      ).not.toBeInTheDocument(),
    );
  });
});
// --- #537: selector directory priority chain + codex per-model linkage ----

describe("ComposerProviderPicker catalog priority chain (issue #537)", () => {
  beforeEach(() => {
    // Self-contained seeding (same isolation contract as the sibling
    // describes: vi.clearAllMocks clears calls, not implementations).
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
    vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
    vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
    vi.mocked(listAdapters).mockResolvedValue([]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
    vi.mocked(setSessionModel).mockResolvedValue(PERSIST_OK);
    vi.mocked(setSessionThoughtLevel).mockResolvedValue(PERSIST_OK);
  });

  const SESSION_CATALOG = {
    models: ["session-opus", "session-sonnet"],
    current_model: "session-opus",
    thought_levels: ["low", "high"],
    current_thought_level: "low",
    adapter_id: "claude-code",
  } satisfies DiscoveredRuntime;

  const PROBE_CATALOG = {
    models: ["probe-opus", "probe-haiku"],
    current_model: "probe-opus",
    thought_levels: ["minimal", "high"],
    current_thought_level: "high",
  } satisfies DiscoveredRuntime;

  // A probe-cache document holding an ACP entry for the named adapter.
  const probeCatalogs = (adapterId: string): AdapterCatalogs => ({
    [adapterId]: {
      probe_kind: "acp",
      outcome: { acp: { discovered: PROBE_CATALOG } },
      probed_at_millis: 1_700_000_000_000,
    },
  });

  async function openExternal(
    catalogs: AdapterCatalogs,
    cached_discovered: DiscoveredRuntime | null,
  ) {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "claude-code",
    });
    vi.mocked(listAdapters).mockResolvedValue([adapter("claude-code")]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue(catalogs);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: claude-code/ }),
    );
  }

  it("prefers the session catalog over the probe cache when both exist", async () => {
    await openExternal(probeCatalogs("claude-code"), SESSION_CATALOG);
    const modelSelect = await screen.findByLabelText("Model");
    expect(
      Array.from(modelSelect.querySelectorAll("option")).map(
        (o) => o.textContent,
      ),
    ).toEqual([
      "CLI default (session-opus)",
      "session-opus (CLI default)",
      "session-sonnet",
    ]);
    // The probe-fed provenance note must NOT render -- this is the
    // session's own live discovery.
    expect(screen.queryByText(/last settings test/)).not.toBeInTheDocument();
  });

  it("falls back to the probe cache when the session has no catalog", async () => {
    await openExternal(probeCatalogs("claude-code"), null);
    const modelSelect = await screen.findByLabelText("Model");
    expect(
      Array.from(modelSelect.querySelectorAll("option")).map(
        (o) => o.textContent,
      ),
    ).toEqual([
      "CLI default (probe-opus)",
      "probe-opus (CLI default)",
      "probe-haiku",
    ]);
    // Honest provenance: the options are the user's last settings test, and
    // the session's own list replaces them after the next turn.
    expect(await screen.findByText(/last settings test/)).toBeInTheDocument();
  });

  it("renders the empty state with a settings-test entry when no source has a catalog", async () => {
    await openExternal({}, null);
    expect(
      await screen.findByText(/Model options appear after the first turn/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Test the runtime in settings/ }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("does not fall back to another adapter's probe-cache entry", async () => {
    // The cache holds an entry keyed by a DIFFERENT adapter id -- the
    // fallback must not render that runtime's catalog.
    await openExternal(probeCatalogs("some-other-adapter"), null);
    expect(
      await screen.findByText(/Model options appear after the first turn/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });
});

describe("ComposerProviderPicker codex dropdowns (issue #537)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
    vi.mocked(getSessionRuntime).mockResolvedValue({ kind: "built_in" });
    vi.mocked(setSessionRuntime).mockResolvedValue(undefined);
    vi.mocked(listAdapters).mockResolvedValue([]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: null,
      thought_level: null,
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
    vi.mocked(setSessionModel).mockResolvedValue(PERSIST_OK);
    vi.mocked(setSessionThoughtLevel).mockResolvedValue(PERSIST_OK);
  });

  // Two codex models with different supported effort sets (overlapping:
  // "low" is shared) -- pins the per-model linkage (a union would offer
  // every effort on every model).
  const CODEX_MODELS: CodexModel[] = [
    {
      id: "gpt-5-codex",
      display_name: "GPT-5 Codex",
      is_default: true,
      default_reasoning_effort: "medium",
      supported_reasoning_efforts: ["low", "medium", "high"],
    },
    {
      id: "o3-mini",
      display_name: "o3-mini",
      is_default: false,
      default_reasoning_effort: "minimal",
      supported_reasoning_efforts: ["minimal", "low"],
    },
  ];

  const codexCatalogs = (): AdapterCatalogs => ({
    codex: {
      probe_kind: "codex",
      outcome: { codex: { models: CODEX_MODELS } },
      probed_at_millis: 1_700_000_000_000,
    },
  });

  async function openCodex(config?: {
    model?: string | null;
    thought_level?: string | null;
  }) {
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { ...adapter("codex"), stream_format: "json_event_stream" },
    ]);
    vi.mocked(getSessionModelConfig).mockResolvedValue({
      model: config?.model ?? null,
      thought_level: config?.thought_level ?? null,
      cached_discovered: null,
    });
    vi.mocked(getAdapterCatalogs).mockResolvedValue(codexCatalogs());
    const rendered = renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: codex/ }),
    );
    return rendered;
  }

  it("renders real dropdowns from the probe cache per-model catalog", async () => {
    await openCodex();
    const modelSelect = await screen.findByLabelText("Model");
    // The model rows come from the cached catalog; the CLI-default row is
    // annotated with the catalog flagged default.
    expect(
      Array.from(modelSelect.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["", "gpt-5-codex", "o3-mini"]);
    // With no model picked the level surface is a hint, not a dropdown
    // (there is no honest effort list to offer).
    expect(
      await screen.findByText(/Pick a model to choose a thinking level/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Thinking")).not.toBeInTheDocument();
  });

  it("shows the selected model efforts in the CLI declared order", async () => {
    await openCodex({ model: "gpt-5-codex" });
    const thinkSelect = await screen.findByLabelText("Thinking");
    expect(
      Array.from(thinkSelect.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["", "low", "medium", "high"]);
  });

  it("refreshes the effort list when the model changes", async () => {
    await openCodex({ model: "gpt-5-codex" });
    // Switch to o3-mini -- its supported set differs from gpt-5-codex's.
    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "o3-mini" },
    });
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "o3-mini"),
    );
    const thinkSelect = await screen.findByLabelText("Thinking");
    expect(
      Array.from(thinkSelect.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["", "minimal", "low"]);
  });

  it("clears a held effort that the newly picked model does not support", async () => {
    // The session holds "high" (supported by gpt-5-codex only); switching
    // to o3-mini must clear it via the existing set IPC in the same
    // gesture.
    await openCodex({ model: "gpt-5-codex", thought_level: "high" });
    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "o3-mini" },
    });
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "o3-mini"),
    );
    await waitFor(() =>
      expect(setSessionThoughtLevel).toHaveBeenCalledWith("sess-1", null),
    );
  });

  it("keeps the effort when the model write itself rejects", async () => {
    // A rejected model write must not clear the effort -- it stays against
    // the still-held model (the server posture wins).
    vi.mocked(setSessionModel).mockRejectedValueOnce(new Error("boom"));
    await openCodex({ model: "gpt-5-codex", thought_level: "high" });
    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "o3-mini" },
    });
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "o3-mini"),
    );
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeInTheDocument();
    expect(setSessionThoughtLevel).not.toHaveBeenCalled();
  });

  it("clears the effort when the model selection is cleared", async () => {
    await openCodex({ model: "gpt-5-codex", thought_level: "high" });
    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", null),
    );
    await waitFor(() =>
      expect(setSessionThoughtLevel).toHaveBeenCalledWith("sess-1", null),
    );
    // The level surface collapses back to the pick-a-model hint.
    expect(
      await screen.findByText(/Pick a model to choose a thinking level/),
    ).toBeInTheDocument();
  });

  it("shows the set failure when the chained effort clear itself rejects", async () => {
    // The distinct second-write failure mode: the model write is GRANTED
    // (the session now runs o3-mini) but the chained effort clear rejects.
    // The failure must surface (the held "high" is now unsupported) and the
    // refetch restores the server truth: new model, still-held effort.
    vi.mocked(setSessionThoughtLevel).mockRejectedValueOnce(
      new Error("clear boom"),
    );
    await openCodex({ model: "gpt-5-codex", thought_level: "high" });
    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "o3-mini" },
    });
    await waitFor(() =>
      expect(setSessionThoughtLevel).toHaveBeenCalledWith("sess-1", null),
    );
    expect(
      await screen.findByText(/Could not apply the selection/),
    ).toBeInTheDocument();
    // Server truth after the refetch: the new model landed, the effort
    // write never did.
    expect(getSessionModelConfig).toHaveBeenLastCalledWith("sess-1");
  });

  it("keeps the model patch when the chained clear patches the cache", async () => {
    // The functional setQueryData hardening: the chained effort clear runs
    // in the same gesture as the model write, and both patch the cache
    // functionally -- a snapshot form would have the clear's closure
    // restore the OLD model id. Pin the cache directly.
    const { queryClient } = await openCodex({
      model: "gpt-5-codex",
      thought_level: "high",
    });
    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "o3-mini" },
    });
    await waitFor(() =>
      expect(setSessionThoughtLevel).toHaveBeenCalledWith("sess-1", null),
    );
    // The model patch survives the chained clear's cache patch.
    expect(
      queryClient.getQueryData(sessionKeys.modelConfig("sess-1")),
    ).toMatchObject({ model: "o3-mini", thought_level: null });
  });

  it("keeps a supported effort when switching to a model that also supports it", async () => {
    // "low" sits in BOTH models sets -- switching models must NOT clear it.
    await openCodex({ model: "gpt-5-codex", thought_level: "low" });
    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "o3-mini" },
    });
    await waitFor(() =>
      expect(setSessionModel).toHaveBeenCalledWith("sess-1", "o3-mini"),
    );
    // The select re-renders on the o3-mini effort list still holding "low".
    await waitFor(() => {
      expect(screen.getByLabelText("Thinking")).toHaveValue("low");
    });
    expect(setSessionThoughtLevel).not.toHaveBeenCalled();
  });

  it("keeps the read-only CLI-default labels when no cache entry exists", async () => {
    // Inline seeding (openCodex would re-seed the catalogs mock with a
    // codex entry; this state needs it EMPTY).
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { ...adapter("codex"), stream_format: "json_event_stream" },
    ]);
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: codex/ }),
    );
    // Two CLI-default labels render (model + thinking), no dropdowns.
    expect(await screen.findAllByText("CLI default")).toHaveLength(2);
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
  });

  it("routes the codex empty-state entry to the settings local-cli tab", async () => {
    vi.mocked(getAdapterCatalogs).mockResolvedValue({});
    const onOpenSettings = vi.fn();
    vi.mocked(getSessionRuntime).mockResolvedValue({
      kind: "external",
      data: "codex",
    });
    vi.mocked(listAdapters).mockResolvedValue([
      { ...adapter("codex"), stream_format: "json_event_stream" },
    ]);
    renderPicker(
      <ComposerProviderPicker
        sessionId="sess-1"
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Runtime: codex/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Test the runtime in settings/,
      }),
    );
    expect(onOpenSettings).toHaveBeenCalledWith("local-cli");
  });
});
