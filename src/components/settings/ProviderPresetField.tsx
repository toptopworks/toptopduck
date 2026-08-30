import { useId } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SettingsRow } from "./settings-chrome";
import type { ProviderPreset } from "./provider-presets";
import { PRESET_CUSTOM, PROVIDER_PRESETS, findPreset } from "./provider-presets";

// Provider preset picker (issue #235, ADR-0071 Consequences). A themed Select
// of ready-made endpoint templates, rendered as one settings-card row (the
// shared SettingsRow chrome every settings form rides). Selecting a named
// preset writes its protocol/base_url/default_model onto the profile (the
// parent does the write); the select's value is DERIVED from the profile's
// current endpoint, so it tracks later field edits for free -- a hand-edited
// base_url flips the readout to "Custom" without any stored preset_id
// (ADR-0038: presets never enter app-config).
//
// The "Custom" entry is ALWAYS listed, after a separator, in two postures:
// while the endpoint sits on a named preset it is an ACTION -- picking it
// fires onSelectCustom, which resets the endpoint into hand-fill mode; while
// the endpoint already reads as custom it is the SELECTED value and renders
// DISABLED (an indicator of the current state -- re-picking it must not wipe
// a base_url the user already typed; the derived-value model means there is
// no controlled-select trap to avoid, only a foot-gun to block).

type ProviderPresetFieldProps = {
  // The derived preset id (one of PROVIDER_PRESETS[*].id, or PRESET_CUSTOM).
  presetId: string;
  // Apply a named preset's endpoint onto the profile. NOT called for Custom
  // (Custom routes to onSelectCustom).
  onSelectPreset: (preset: ProviderPreset) => void;
  // Enter hand-fill mode from a named preset: the parent resets the endpoint
  // (openai protocol + an empty base_url the user must type). Never fired
  // while the endpoint already reads as custom (the entry is disabled there).
  onSelectCustom: () => void;
  disabled: boolean;
  // Mirrors the Select's open state upward so the parent's commit-on-blur can
  // hold back while the portalized option list owns focus (the listbox sits
  // OUTSIDE the edit form's DOM subtree, so the form-level blur capture cannot
  // tell a select-open from a genuine focus exit).
  onOpenChange?: (open: boolean) => void;
};

export function ProviderPresetField({
  presetId,
  onSelectPreset,
  onSelectCustom,
  disabled,
  onOpenChange,
}: ProviderPresetFieldProps) {
  const intl = useIntl();
  const triggerId = useId();

  function handleValueChange(id: string) {
    if (id === PRESET_CUSTOM) {
      // Custom while already custom is a disabled item (see component doc);
      // guard the value path too so a stray event cannot wipe a typed base_url.
      if (presetId !== PRESET_CUSTOM) onSelectCustom();
      return;
    }
    const preset = findPreset(id);
    if (preset) onSelectPreset(preset);
  }

  return (
    <SettingsRow
      dense
      title={(
        <Label htmlFor={triggerId} className="text-muted-foreground">
          <FormattedMessage
            id="settings.profiles.preset.legend"
            defaultMessage="Provider preset"
          />
        </Label>
      )}
    >
      <Select
        value={presetId}
        onValueChange={handleValueChange}
        onOpenChange={onOpenChange}
        disabled={disabled}
      >
        <SelectTrigger id={triggerId} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROVIDER_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.display_name}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={PRESET_CUSTOM} disabled={presetId === PRESET_CUSTOM}>
            {intl.formatMessage({
              id: "settings.profiles.preset.custom",
              defaultMessage: "Custom",
            })}
          </SelectItem>
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}
