import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { IntlProvider } from "react-intl";

import { ComposerProviderPicker } from "../ComposerProviderPicker";
import { listProviderProfiles } from "../../../api";
import { TooltipProvider } from "../../ui/tooltip";
import type { ProviderConfig, ProfileKeyStatus } from "../../../types/provider";

// ComposerProviderPicker routes its chrome through react-intl (ADR-0052) +
// needs a Radix TooltipProvider ancestor for the hover Tooltip. Rendered inside
// an empty-catalog English IntlProvider so FormattedMessage / useIntl fall back
// to the defaultMessage -- the canonical English source (ADR-0052) -- and
// assertions anchor on stable English strings. onError silences the expected
// missing-message warnings. listProviderProfiles is mocked so the view never
// hits Tauri (ADR-0029 one-shot keychain surface).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    listProviderProfiles: vi.fn(),
  };
});

function renderPicker(ui: ReactElement) {
  return render(
    <IntlProvider locale="en" messages={{}} onError={() => {}}>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </IntlProvider>,
  );
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

function keyStatus(
  rows: Array<[string, boolean, string?]>,
): ProfileKeyStatus[] {
  return rows.map(([profile_id, has_key, fault]) => ({
    profile_id,
    has_key,
    keychain_fault: fault ?? null,
  }));
}

describe("ComposerProviderPicker (issue #238, ADR-0071)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
  });

  it("renders the icon trigger with an accessible name", () => {
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    // The trigger is a real <button> so its implicit role + aria-label are
    // stable for black-box queries (Radix asChild forwards both).
    expect(
      screen.getByRole("button", { name: "Provider and model" }),
    ).toBeInTheDocument();
  });

  it("opens the popover with all four zones on click", async () => {
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
    // Zone 1: provider (active profile) label + a <select>.
    expect(await screen.findByText("Profile")).toBeInTheDocument();
    // Zone 2: model field label + hint.
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(
      screen.getByText("Type a model id, or pick the preset default."),
    ).toBeInTheDocument();
    // Zone 4: open-settings entry.
    expect(
      screen.getByRole("button", { name: "Open settings" }),
    ).toBeInTheDocument();
  });

  it("lists every profile in the provider dropdown", async () => {
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
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
        provider={pickerProvider()}
        onSwitchActive={onSwitchActive}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
    const select = await screen.findByDisplayValue("Anthropic");
    fireEvent.change(select, { target: { value: "glm" } });
    expect(onSwitchActive).toHaveBeenCalledWith("glm");
  });

  it("commits the model on blur (not per keystroke)", async () => {
    const onSwitchModel = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={onSwitchModel}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
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
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={onSwitchModel}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
    const input = await screen.findByDisplayValue("claude-sonnet-4-6");
    fireEvent.change(input, { target: { value: "claude-opus" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSwitchModel).toHaveBeenCalledWith("claude-opus");
  });

  it("does not commit a no-op model (unchanged value)", async () => {
    const onSwitchModel = vi.fn();
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={onSwitchModel}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
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
    function View({
      model,
    }: {
      model: string;
    }) {
      return (
        <ComposerProviderPicker
          provider={{ ...pickerProvider(), profiles: [{ ...pickerProvider().profiles[0], model }, pickerProvider().profiles[1]] }}
          onSwitchActive={() => {}}
          onSwitchModel={() => {}}
          onOpenSettings={() => {}}
        />
      );
    }
    const { rerender } = renderPicker(<View model="claude-sonnet-4-6" />);
    // Mount + initial draft = the seeded model.
    expect(() => screen.getAllByRole("button")).not.toThrow();

    // External change: the active profile's model is now "claude-opus".
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider delayDuration={0}>
          <View model="claude-opus" />
        </TooltipProvider>
      </IntlProvider>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
    // The input reflects the new model, not a stale draft.
    expect(await screen.findByDisplayValue("claude-opus")).toBeInTheDocument();
  });

  it("refetches the key overlay when profileKeyEpoch bumps (settings-close)", async () => {
    // App bumps profileKeyEpoch on settings-close so a Save that changed a
    // keychain slot is reflected without a remount (ADR-0019 honest gate, #238).
    vi.mocked(listProviderProfiles).mockResolvedValue([]);
    const { rerender } = renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
        profileKeyEpoch={0}
      />,
    );
    // Mount-time fetch.
    await waitFor(() => expect(listProviderProfiles).toHaveBeenCalledTimes(1));

    // A settings-close bumps the epoch -> the overlay refetches.
    rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <TooltipProvider delayDuration={0}>
          <ComposerProviderPicker
            provider={pickerProvider()}
            onSwitchActive={() => {}}
            onSwitchModel={() => {}}
            onOpenSettings={() => {}}
            profileKeyEpoch={1}
          />
        </TooltipProvider>
      </IntlProvider>,
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
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
    // Wait for the mount-time key overlay fetch to land before asserting.
    await screen.findByText("No key");
    expect(screen.getByText("No key")).toBeInTheDocument();
    // ADR-0019 honest gate: the explicit "asking will fail" line.
    expect(
      screen.getByText(/No key saved for this profile/),
    ).toBeInTheDocument();
  });

  it("shows Key set and no warning when the active profile has a key", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", true]]),
    );
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
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
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
    const openBtn = await screen.findByRole("button", {
      name: "Open settings",
    });
    fireEvent.click(openBtn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // The popover must close (its portaled content would otherwise linger
    // atop the settings overlay, ADR-0065 hides the shell via CSS not the host).
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Open settings" }),
      ).not.toBeInTheDocument();
    });
  });

  it("surfaces the provider . model preview in the hover tooltip (+ no-key mark)", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false]]),
    );
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Provider and model",
    });
    // Radix Tooltip opens on pointer hover with pointerType mouse (jsdom needs
    // the pointerType set explicitly; bare mouseEnter does not trigger it).
    // Assert via the tooltip role's textContent -- Radix wraps the content, so
    // getByText on the raw string is brittle but role+textContent is stable.
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    // The tooltip carries "{provider} . {model} . no key" (ADR-0019 mark).
    expect(tooltip.textContent).toContain("Anthropic");
    expect(tooltip.textContent).toContain("claude-sonnet-4-6");
    expect(tooltip.textContent).toContain("no key");
  });

  it("omits the no-key mark from the tooltip when the active profile has a key", async () => {
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", true]]),
    );
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Provider and model",
    });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("claude-sonnet-4-6");
    // The tooltip text never carries the "no key" suffix when a key is set.
    expect(tooltip.textContent).not.toContain("no key");
  });

  it("shows the keychain-unavailable badge when the active profile's keychain read failed (issue #275)", async () => {
    // AC #275: a keychain read fault (locked / service down / corrupt entry)
    // must NOT misread as "No key" -- the popover shows a distinct badge so the
    // user is not misled to re-enter a key when the trust root itself is
    // unavailable. keyStatus carries the fault detail as the third tuple element.
    vi.mocked(listProviderProfiles).mockResolvedValue(
      keyStatus([["anthropic", false, "keychain access failed: locked"]]),
    );
    renderPicker(
      <ComposerProviderPicker
        provider={pickerProvider()}
        onSwitchActive={() => {}}
        onSwitchModel={() => {}}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Provider and model" }),
    );
    await screen.findByText("Keychain unavailable");
    expect(screen.getByText("Keychain unavailable")).toBeInTheDocument();
    // The pre-#275 bool honest-degrade hid the fault behind "No key"; pin it
    // does not regress.
    expect(screen.queryByText("No key")).not.toBeInTheDocument();
  });
});
