import { useId } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import type { Protocol, ProviderProfile } from "../../types/provider";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { ProviderModelField } from "./ProviderModelField";
import { SettingsRow } from "./settings-chrome";

// Endpoint fields for a profile (issue #235, ADR-0071 Consequences): the
// protocol RadioGroup (shown only when the endpoint is Custom -- a named preset
// implies its protocol) + base URL + the model field, each rendered as one
// settings-card row (the shared SettingsRow chrome every settings form rides).
// Extracted from ProfilesSection so the composer popover (#3) and cold-start
// guide (#5) can reuse the same endpoint form. The model field is the
// ProviderModelField atom (issue #236, ADR-0070): a hand-typed input that
// upgrades to a list-models dropdown after a "Test connection" probe, with the
// six-state classification rendered inline. This component boundary IS the swap
// point #235 reserved.

type ProviderEndpointFieldsProps = {
  profile: ProviderProfile;
  onUpdate: (patch: Partial<ProviderProfile>) => void;
  // True when the endpoint does not match any preset (Custom): the protocol
  // RadioGroup shows so the user picks the wire protocol by hand. Named presets
  // carry their own protocol, so the group is hidden otherwise (the preset
  // select communicates it instead).
  showProtocolRadio: boolean;
  disabled: boolean;
  // Mirrored down to ProviderModelField so ESC / Back / Cancel are blocked
  // while a Test connection IPC is in flight (the returned classification must
  // not land on an unmounted node). Optional: the field renders without it but
  // loses the close guard.
  onBusyChange?: (busy: boolean) => void;
  // Mirrors the model Select's open state upward (the preset select reports its
  // own); see ProviderPresetField.onOpenChange for the commit-on-blur rationale.
  onModelSelectOpenChange?: (open: boolean) => void;
};

export function ProviderEndpointFields({
  profile,
  onUpdate,
  showProtocolRadio,
  disabled,
  onBusyChange,
  onModelSelectOpenChange,
}: ProviderEndpointFieldsProps) {
  const intl = useIntl();
  const baseUrlId = useId();

  return (
    <>
      {showProtocolRadio && (
        <SettingsRow
          dense
          title={(
            <Label className="text-muted-foreground">
              <FormattedMessage
                id="settings.profiles.protocol.legend"
                defaultMessage="Protocol"
              />
            </Label>
          )}
        >
          <RadioGroup
            value={profile.protocol}
            onValueChange={(v) => onUpdate({ protocol: v as Protocol })}
            disabled={disabled}
            className="gap-2"
            aria-label={intl.formatMessage({
              id: "settings.profiles.protocol.legend",
              defaultMessage: "Protocol",
            })}
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`proto-anthropic-${profile.id}`} value="anthropic" />
              <Label htmlFor={`proto-anthropic-${profile.id}`} className="font-normal">
                {/* The provider name is a locale-independent proper noun -- it
                    matches provider-presets.ts's display_name but is an
                    independent literal, so it stays in JSX; the parenthetical
                    wire detail is translatable chrome copy (ADR-0052 layer 1)
                    and rides muted beneath it. */}
                <span>
                  Anthropic{" "}
                  <span className="text-muted-foreground">
                    <FormattedMessage
                      id="settings.profiles.protocol.anthropic"
                      defaultMessage="(Messages API, x-api-key)"
                    />
                  </span>
                </span>
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`proto-openai-${profile.id}`} value="openai" />
              <Label htmlFor={`proto-openai-${profile.id}`} className="font-normal">
                <span>
                  OpenAI{" "}
                  <span className="text-muted-foreground">
                    <FormattedMessage
                      id="settings.profiles.protocol.openai"
                      defaultMessage="(Chat Completions, Bearer)"
                    />
                  </span>
                </span>
              </Label>
            </div>
          </RadioGroup>
        </SettingsRow>
      )}

      <SettingsRow
        dense
        title={(
          <Label htmlFor={baseUrlId} className="text-muted-foreground">
            <FormattedMessage id="settings.profiles.baseUrl" defaultMessage="Base URL" />
          </Label>
        )}
      >
        <Input
          id={baseUrlId}
          type="text"
          value={profile.base_url}
          onChange={(e) => onUpdate({ base_url: e.target.value })}
          disabled={disabled}
          spellCheck={false}
          // An example URL -- a technical string with no language form, so it
          // stays out of the catalog (ADR-0052 layer 1 covers text).
          placeholder="https://api.example.com/v1"
        />
      </SettingsRow>

      <ProviderModelField
        profile={profile}
        onUpdate={onUpdate}
        disabled={disabled}
        onBusyChange={onBusyChange}
        onSelectOpenChange={onModelSelectOpenChange}
      />
    </>
  );
}
