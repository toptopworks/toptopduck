import type { ChangeEvent } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { cn } from "../../lib/utils";
import { Label } from "../ui/label";
import type { ProviderPreset } from "./provider-presets";
import { PRESET_CUSTOM, PROVIDER_PRESETS, findPreset } from "./provider-presets";

// Provider preset picker (issue #235, ADR-0071 Consequences). A native select of
// ready-made endpoint templates. Selecting a named preset writes its
// protocol/base_url/default_model onto the profile (the parent does the write);
// the select's value is DERIVED from the profile's current endpoint, so it
// tracks later field edits for free -- a hand-edited base_url flips the readout
// to "Custom" without any stored preset_id (ADR-0038: presets never enter
// app-config).
//
// The "Custom" option is rendered ONLY while the endpoint already reads as
// custom: it is an indicator of the current state, not an action. The user
// reaches Custom by editing a field (the fields are always editable in
// ProviderEndpointFields), which avoids the controlled-select trap where
// clicking a no-op option leaves the DOM stuck on it.

type ProviderPresetFieldProps = {
  // The derived preset id (one of PROVIDER_PRESETS[*].id, or PRESET_CUSTOM).
  presetId: string;
  // Apply a named preset's endpoint onto the profile. NOT called for Custom
  // (Custom is derived, not selected).
  onSelectPreset: (preset: ProviderPreset) => void;
  disabled: boolean;
};

export function ProviderPresetField({
  presetId,
  onSelectPreset,
  disabled,
}: ProviderPresetFieldProps) {
  const intl = useIntl();

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    // Custom is indicator-only (see component doc); ignore a stray select.
    if (id === PRESET_CUSTOM) return;
    const preset = findPreset(id);
    if (preset) onSelectPreset(preset);
  }

  return (
    <Label className="grid gap-1">
      <FormattedMessage
        id="settings.profiles.preset.legend"
        defaultMessage="Provider preset"
      />
      {/* Native <select> (precedent: GuidedLoadDialog) styled to match Input so
          the dropdown reads as a form field alongside base URL / model. No new
          Select primitive or @radix-ui/react-select dependency is warranted for
          a single 8-option picker (KISS / YAGNI); #3's composer popover will
          revisit if it needs richer chrome. */}
      <select
        value={presetId}
        onChange={onChange}
        disabled={disabled}
        className={cn(
          "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {PROVIDER_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name}
          </option>
        ))}
        {presetId === PRESET_CUSTOM && (
          <option value={PRESET_CUSTOM}>
            {intl.formatMessage({
              id: "settings.profiles.preset.custom",
              defaultMessage: "Custom",
            })}
          </option>
        )}
      </select>
    </Label>
  );
}
