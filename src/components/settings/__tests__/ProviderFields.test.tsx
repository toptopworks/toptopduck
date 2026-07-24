import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntlProvider } from "react-intl";

import { clearProfileKey, setProfileKey, testProfile } from "../../../api";
import type { ProfileTestOutcome, ProviderProfile } from "../../../types/provider";
import { ProviderEndpointFields } from "../ProviderEndpointFields";
import { ProviderKeyField } from "../ProviderKeyField";
import { ProviderModelField } from "../ProviderModelField";
import { ProviderPresetField } from "../ProviderPresetField";
import {
  PRESET_CUSTOM,
  PROVIDER_PRESETS,
  derivePresetId,
  findPreset,
} from "../provider-presets";
import { renderSettings } from "./helpers";

// The three DRY field atoms (issue #235) reach the per-profile keychain surface
// (set/clear); mock those two IPC functions so the atoms never hit Tauri. The
// rest of the api module passes through unchanged. Same mock path as the
// SettingsView test (../../../api resolves to src/api.ts, which the atoms import
// as ../../api).
vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    setProfileKey: vi.fn(),
    clearProfileKey: vi.fn(),
    testProfile: vi.fn(),
  };
});

const baseProfile: ProviderProfile = {
  id: "p1",
  display_name: "My Profile",
  protocol: "anthropic",
  base_url: "https://api.anthropic.com",
  model: "claude-sonnet-4-6",
};

// Harness that mirrors the parent's key-status overlay: onKeyStatusChange flips
// the hasKey state so the badge re-renders. Without this the badge (driven by
// the hasKey prop) cannot flip in a unit test where the prop is otherwise
// static -- the flip is the PARENT's job (ProfilesSection's overlay), exercised
// end-to-end by the SettingsView test. Used only for the set/clear badge-flip
// tests; the static-prop tests render ProviderKeyField directly.
function KeyFieldHarness({
  initialHasKey,
  onKeyStatusChangeSpy,
  ...rest
}: Omit<ComponentProps<typeof ProviderKeyField>, "hasKey" | "onKeyStatusChange"> & {
  initialHasKey: boolean;
  onKeyStatusChangeSpy?: (hasKey: boolean) => void;
}) {
  const [hasKey, setHasKey] = useState(initialHasKey);
  return (
    <ProviderKeyField
      {...rest}
      hasKey={hasKey}
      onKeyStatusChange={(next) => {
        onKeyStatusChangeSpy?.(next);
        setHasKey(next);
      }}
    />
  );
}

describe("provider-presets catalog (issue #235)", () => {
  it("has exactly 7 presets in the spec order", () => {
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
      "deepseek",
      "glm",
      "qwen",
      "moonshot",
      "ollama",
    ]);
  });

  it("every preset carries id/display_name/protocol/base_url/default_model/get_key_link/key_placeholder", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(p.display_name).toBeTruthy();
      expect(p.protocol === "anthropic" || p.protocol === "openai").toBe(true);
      expect(p.base_url).toMatch(/^https?:\/\//);
      expect(p.default_model).toBeTruthy();
      expect(typeof p.key_placeholder).toBe("string");
    }
  });

  it("Anthropic speaks anthropic; the six openai-compatible endpoints + Ollama speak openai (ADR-0064)", () => {
    const byId = Object.fromEntries(PROVIDER_PRESETS.map((p) => [p.id, p]));
    expect(byId.anthropic.protocol).toBe("anthropic");
    for (const id of ["openai", "deepseek", "glm", "qwen", "moonshot", "ollama"]) {
      expect(byId[id].protocol).toBe("openai");
    }
  });

  it("get_key_link is {host,url} for the six clouds, null for the Ollama loopback (no key acquisition)", () => {
    for (const p of PROVIDER_PRESETS) {
      if (p.id === "ollama") {
        expect(p.get_key_link).toBeNull();
      } else {
        expect(p.get_key_link).not.toBeNull();
        expect(p.get_key_link?.host).toBeTruthy();
        expect(p.get_key_link?.url).toMatch(/^https:\/\//);
      }
    }
  });

  it("derivePresetId returns the matching id when protocol + base_url match, else Custom (ADR-0038 derivation)", () => {
    const glm = findPreset("glm")!;
    expect(
      derivePresetId({ protocol: glm.protocol, base_url: glm.base_url }),
    ).toBe("glm");
    // Drift on either axis flips to Custom -- no stored preset_id.
    expect(
      derivePresetId({ protocol: "anthropic", base_url: glm.base_url }),
    ).toBe(PRESET_CUSTOM);
    expect(
      derivePresetId({ protocol: glm.protocol, base_url: "https://my-gw/v1" }),
    ).toBe(PRESET_CUSTOM);
  });

  it("findPreset returns the preset for a known id, undefined for Custom / unknown", () => {
    expect(findPreset("glm")?.display_name).toBe("GLM");
    expect(findPreset(PRESET_CUSTOM)).toBeUndefined();
    expect(findPreset("nope")).toBeUndefined();
  });
});

describe("ProviderPresetField (issue #235)", () => {
  it("renders the 7 named presets as options; selecting one fires onSelectPreset with protocol/base_url/default_model", () => {
    const onSelectPreset = vi.fn();
    renderSettings(
      <ProviderPresetField
        presetId="anthropic"
        onSelectPreset={onSelectPreset}
        disabled={false}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Provider preset" });
    // All 7 display names appear as options.
    for (const p of PROVIDER_PRESETS) {
      expect(screen.getByText(p.display_name)).toBeInTheDocument();
    }
    // No Custom option while on a named preset (it is indicator-only).
    expect(screen.queryByText("Custom")).not.toBeInTheDocument();
    // Selecting GLM applies its endpoint onto the profile.
    fireEvent.change(select, { target: { value: "glm" } });
    const glm = findPreset("glm")!;
    expect(onSelectPreset).toHaveBeenCalledTimes(1);
    expect(onSelectPreset.mock.calls[0][0]).toMatchObject({
      id: "glm",
      protocol: glm.protocol,
      base_url: glm.base_url,
      default_model: glm.default_model,
    });
  });

  it("renders the Custom option only when presetId is Custom; re-selecting it is a no-op (indicator, not action)", () => {
    const onSelectPreset = vi.fn();
    renderSettings(
      <ProviderPresetField
        presetId={PRESET_CUSTOM}
        onSelectPreset={onSelectPreset}
        disabled={false}
      />,
    );
    expect(screen.getByText("Custom")).toBeInTheDocument();
    // Changing to Custom (the current value) does not fire onSelectPreset.
    fireEvent.change(screen.getByRole("combobox", { name: "Provider preset" }), {
      target: { value: PRESET_CUSTOM },
    });
    expect(onSelectPreset).not.toHaveBeenCalled();
  });
});

describe("ProviderEndpointFields (issue #235)", () => {
  it("shows the protocol RadioGroup (both protocols) when showProtocolRadio is true (Custom)", () => {
    renderSettings(
      <ProviderEndpointFields
        profile={baseProfile}
        onUpdate={vi.fn()}
        showProtocolRadio={true}
        disabled={false}
      />,
    );
    expect(
      screen.getByRole("radio", { name: /Anthropic \(Messages API/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /OpenAI \(Chat Completions/ }),
    ).toBeInTheDocument();
  });

  it("hides the protocol RadioGroup when a named preset is active (showProtocolRadio=false)", () => {
    renderSettings(
      <ProviderEndpointFields
        profile={baseProfile}
        onUpdate={vi.fn()}
        showProtocolRadio={false}
        disabled={false}
      />,
    );
    expect(
      screen.queryByRole("radio", { name: /Anthropic \(Messages API/ }),
    ).not.toBeInTheDocument();
    // base URL + model inputs stay present regardless.
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
  });

  it("edits to base URL / model / protocol call onUpdate with the matching patch", () => {
    const onUpdate = vi.fn();
    renderSettings(
      <ProviderEndpointFields
        profile={baseProfile}
        onUpdate={onUpdate}
        showProtocolRadio={true}
        disabled={false}
      />,
    );
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://gw.example/v1" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ base_url: "https://gw.example/v1" });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-4o" },
    });
    expect(onUpdate).toHaveBeenLastCalledWith({ model: "gpt-4o" });
    fireEvent.click(
      screen.getByRole("radio", { name: /OpenAI \(Chat Completions/ }),
    );
    expect(onUpdate).toHaveBeenLastCalledWith({ protocol: "openai" });
  });
});

describe("ProviderKeyField (issue #235, ADR-0029)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the No key badge + generic 'Paste key' placeholder when hasKey=false with no preset placeholder", () => {
    renderSettings(
      <ProviderKeyField
        profileId="p1"
        hasKey={false}
        onKeyStatusChange={vi.fn()}
        getKeyLink={null}
        keyPlaceholder=""
        disabled={false}
      />,
    );
    expect(screen.getByText("No key")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Paste key")).toBeInTheDocument();
    // No Get key link without a preset host.
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows the Key set badge + Update/Clear buttons + leave-as-is placeholder when hasKey=true", () => {
    renderSettings(
      <ProviderKeyField
        profileId="p1"
        hasKey={true}
        onKeyStatusChange={vi.fn()}
        getKeyLink={null}
        keyPlaceholder=""
        disabled={false}
      />,
    );
    expect(screen.getByText("Key set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update key" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear key" })).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Saved (leave blank to keep as-is)"),
    ).toBeInTheDocument();
  });

  it("uses the preset key_placeholder when set + renders the Get key link with host + href + target", () => {
    renderSettings(
      <ProviderKeyField
        profileId="p1"
        hasKey={false}
        onKeyStatusChange={vi.fn()}
        getKeyLink={{
          host: "console.anthropic.com",
          url: "https://console.anthropic.com/settings/keys",
        }}
        keyPlaceholder="sk-ant-api03-…"
        disabled={false}
      />,
    );
    expect(screen.getByPlaceholderText("sk-ant-api03-…")).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: "Get key at console.anthropic.com",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("Set key calls setProfileKey, flips the badge to Key set, lifts has_key=true up (issue #153/#235)", async () => {
    vi.mocked(setProfileKey).mockResolvedValue(true);
    const onKeyStatusChangeSpy = vi.fn();
    renderSettings(
      <KeyFieldHarness
        initialHasKey={false}
        onKeyStatusChangeSpy={onKeyStatusChangeSpy}
        profileId="p1"
        getKeyLink={null}
        keyPlaceholder=""
        disabled={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Paste key"), {
      target: { value: "sk-test-235" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await waitFor(() =>
      expect(vi.mocked(setProfileKey)).toHaveBeenCalledWith("p1", "sk-test-235"),
    );
    await waitFor(() => expect(onKeyStatusChangeSpy).toHaveBeenCalledWith(true));
    // The harness lifted the new has_key into the prop, so the badge flips.
    await screen.findByText("Key set");
    expect(screen.queryByText("No key")).not.toBeInTheDocument();
  });

  it("Clear key calls clearProfileKey, flips the badge to No key, lifts has_key=false up", async () => {
    vi.mocked(clearProfileKey).mockResolvedValue(false);
    const onKeyStatusChangeSpy = vi.fn();
    renderSettings(
      <KeyFieldHarness
        initialHasKey={true}
        onKeyStatusChangeSpy={onKeyStatusChangeSpy}
        profileId="p1"
        getKeyLink={null}
        keyPlaceholder=""
        disabled={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear key" }));
    await waitFor(() =>
      expect(vi.mocked(clearProfileKey)).toHaveBeenCalledWith("p1"),
    );
    await waitFor(() => expect(onKeyStatusChangeSpy).toHaveBeenCalledWith(false));
    await screen.findByText("No key");
  });

  it("a failed set leaves the badge at No key + surfaces the error (ADR-0029 trust root)", async () => {
    vi.mocked(setProfileKey).mockRejectedValue(new Error("keychain locked"));
    const onKeyStatusChange = vi.fn();
    renderSettings(
      <ProviderKeyField
        profileId="p1"
        hasKey={false}
        onKeyStatusChange={onKeyStatusChange}
        getKeyLink={null}
        keyPlaceholder=""
        disabled={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Paste key"), {
      target: { value: "sk-test-235" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await screen.findByText("keychain locked");
    expect(onKeyStatusChange).not.toHaveBeenCalled();
    expect(screen.getByText("No key")).toBeInTheDocument();
  });

  it("onBusyChange mirrors the in-flight IPC state (true during, false after)", async () => {
    let resolve!: (v: boolean) => void;
    vi.mocked(setProfileKey).mockImplementation(
      () => new Promise<boolean>((r) => void (resolve = r)),
    );
    const onBusyChange = vi.fn();
    renderSettings(
      <ProviderKeyField
        profileId="p1"
        hasKey={false}
        onKeyStatusChange={vi.fn()}
        getKeyLink={null}
        keyPlaceholder=""
        disabled={false}
        onBusyChange={onBusyChange}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("Paste key"), {
      target: { value: "sk-test-235" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    resolve(true);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("resets the typed input when profileId changes (each profile owns its own key)", () => {
    // renderSettings only wraps the initial tree; rerender must re-wrap the
    // IntlProvider so the atom keeps falling back to defaultMessage.
    const view = render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ProviderKeyField
          profileId="p1"
          hasKey={false}
          onKeyStatusChange={vi.fn()}
          getKeyLink={null}
          keyPlaceholder=""
          disabled={false}
        />
      </IntlProvider>,
    );
    fireEvent.change(view.getByPlaceholderText("Paste key"), {
      target: { value: "sk-typed" },
    });
    expect(view.getByPlaceholderText("Paste key")).toHaveValue("sk-typed");
    view.rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ProviderKeyField
          profileId="p2"
          hasKey={false}
          onKeyStatusChange={vi.fn()}
          getKeyLink={null}
          keyPlaceholder=""
          disabled={false}
        />
      </IntlProvider>,
    );
    expect(view.getByPlaceholderText("Paste key")).toHaveValue("");
  });
});

describe("ProviderModelField (issue #236, ADR-0070)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the hand-typed model input + Test connection before any probe", () => {
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />,
    );
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Test connection" }),
    ).toBeInTheDocument();
    // No dropdown before a successful probe that lists models.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("Test connection calls testProfile with the current endpoint + flips to dropdown on Ok", async () => {
    vi.mocked(testProfile).mockResolvedValue({
      kind: "Ok",
      data: { models: ["claude-sonnet-4-6", "claude-haiku-4-5"] },
    });
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(vi.mocked(testProfile)).toHaveBeenCalledWith(
        "p1",
        "anthropic",
        "https://api.anthropic.com",
        "claude-sonnet-4-6",
      ),
    );
    // The dropdown replaces the input after the probe lists models.
    await screen.findByRole("combobox", { name: "Model" });
    // The hand-typed textbox is gone; only the combobox carries "Model" now
    // (both ride the same <Label>, so distinguish by role, not by label text).
    expect(screen.queryByRole("textbox", { name: "Model" })).not.toBeInTheDocument();
    expect(screen.getByText(/2 models available/)).toBeInTheDocument();
  });

  it("Ok with empty models (ping fallback) keeps the hand-typed input + okPing message", async () => {
    vi.mocked(testProfile).mockResolvedValue({ kind: "Ok", data: { models: [] } });
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/endpoint responds/);
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("KeyRejected renders the key-rejected message (ADR-0044)", async () => {
    vi.mocked(testProfile).mockResolvedValue({ kind: "KeyRejected" });
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Key rejected/);
  });

  it("EndpointUnreachable renders the unreachable message", async () => {
    vi.mocked(testProfile).mockResolvedValue({ kind: "EndpointUnreachable" });
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Could not reach the endpoint/);
  });

  it("Incompatible renders the summary + the folded technical detail", async () => {
    vi.mocked(testProfile).mockResolvedValue({
      kind: "Incompatible",
      data: { detail: "HTTP 502: bad gateway" },
    });
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText(/Incompatible/);
    expect(screen.getByText("HTTP 502: bad gateway")).toBeInTheDocument();
  });

  it("onBusyChange mirrors the in-flight IPC state (true during, false after)", async () => {
    let resolve!: (v: ProfileTestOutcome) => void;
    vi.mocked(testProfile).mockImplementation(
      () => new Promise<ProfileTestOutcome>((r) => void (resolve = r)),
    );
    const onBusyChange = vi.fn();
    renderSettings(
      <ProviderModelField
        profile={baseProfile}
        onUpdate={vi.fn()}
        disabled={false}
        onBusyChange={onBusyChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    resolve({ kind: "Ok", data: { models: ["m"] } });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });

  it("editing base_url clears the probe result back to the hand-typed input", async () => {
    vi.mocked(testProfile).mockResolvedValue({
      kind: "Ok",
      data: { models: ["claude-sonnet-4-6"] },
    });
    const view = render(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />
      </IntlProvider>,
    );
    fireEvent.click(view.getByRole("button", { name: "Test connection" }));
    await view.findByRole("combobox", { name: "Model" });
    view.rerender(
      <IntlProvider locale="en" messages={{}} onError={() => {}}>
        <ProviderModelField
          profile={{ ...baseProfile, base_url: "https://gw.example/v1" }}
          onUpdate={vi.fn()}
          disabled={false}
        />
      </IntlProvider>,
    );
    expect(view.queryByRole("combobox")).not.toBeInTheDocument();
    expect(view.getByLabelText("Model")).toBeInTheDocument();
  });

  it("selecting from the probed dropdown fires onUpdate({ model })", async () => {
    vi.mocked(testProfile).mockResolvedValue({
      kind: "Ok",
      data: { models: ["claude-sonnet-4-6", "claude-haiku-4-5"] },
    });
    const onUpdate = vi.fn();
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={onUpdate} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const select = await screen.findByRole("combobox", { name: "Model" });
    fireEvent.change(select, { target: { value: "claude-haiku-4-5" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ model: "claude-haiku-4-5" });
  });

  it("disables + flips the button label to Testing while a probe is in flight", async () => {
    let resolve!: (v: ProfileTestOutcome) => void;
    vi.mocked(testProfile).mockImplementation(
      () => new Promise<ProfileTestOutcome>((r) => void (resolve = r)),
    );
    renderSettings(
      <ProviderModelField profile={baseProfile} onUpdate={vi.fn()} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByRole("button", { name: "Testing…" });
    resolve({ kind: "Ok", data: { models: [] } });
    await screen.findByRole("button", { name: "Test connection" });
  });
});
