import { FormattedMessage } from "react-intl";

import type { Protocol, ProviderProfile } from "../../types/provider";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ProviderModelField } from "./ProviderModelField";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";

// Endpoint fields for a profile (issue #235, ADR-0071 Consequences): the
// protocol RadioGroup (shown only when the endpoint is Custom -- a named preset
// implies its protocol) + base URL + the model field. Extracted from
// ProfilesSection so the composer popover (#3) and cold-start guide (#5) can
// reuse the same endpoint form. The model field is the ProviderModelField atom
// (issue #236, ADR-0070): a hand-typed input that upgrades to a list-models
// dropdown after a "Test connection" probe, with the four-state classification
// rendered inline. This component boundary IS the swap point #235 reserved.

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
};

export function ProviderEndpointFields({
  profile,
  onUpdate,
  showProtocolRadio,
  disabled,
  onBusyChange,
}: ProviderEndpointFieldsProps) {
  return (
    <>
      {showProtocolRadio && (
        <fieldset className="grid gap-2 border-0 p-0 m-0">
          <legend className="text-sm font-medium">
            <FormattedMessage
              id="settings.profiles.protocol.legend"
              defaultMessage="Protocol"
            />
          </legend>
          <RadioGroup
            value={profile.protocol}
            onValueChange={(v) => onUpdate({ protocol: v as Protocol })}
            disabled={disabled}
            className="gap-2"
          >
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`proto-anthropic-${profile.id}`} value="anthropic" />
              <Label htmlFor={`proto-anthropic-${profile.id}`} className="font-normal">
                <FormattedMessage
                  id="settings.profiles.protocol.anthropic"
                  defaultMessage="Anthropic (Messages API, x-api-key auth)"
                />
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id={`proto-openai-${profile.id}`} value="openai" />
              <Label htmlFor={`proto-openai-${profile.id}`} className="font-normal">
                <FormattedMessage
                  id="settings.profiles.protocol.openai"
                  defaultMessage="OpenAI (Chat Completions, Bearer auth)"
                />
              </Label>
            </div>
          </RadioGroup>
          <p className="text-muted-foreground text-sm">
            <FormattedMessage
              id="settings.profiles.protocol.hint"
              defaultMessage="OpenAI covers OpenAI direct / DeepSeek / GLM / Qwen / Ollama compatible endpoints. Put the endpoint (including its /v1 path) in base URL; the adapter appends /chat/completions."
            />
          </p>
        </fieldset>
      )}

      <Label className="grid gap-1">
        <FormattedMessage id="settings.profiles.baseUrl" defaultMessage="Base URL" />
        <Input
          type="text"
          value={profile.base_url}
          onChange={(e) => onUpdate({ base_url: e.target.value })}
          disabled={disabled}
        />
      </Label>

      <ProviderModelField
        profile={profile}
        onUpdate={onUpdate}
        disabled={disabled}
        onBusyChange={onBusyChange}
      />
    </>
  );
}
