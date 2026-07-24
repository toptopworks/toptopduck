import { FormattedMessage } from "react-intl";

import type { Protocol, ProviderProfile } from "../../types/provider";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";

// Endpoint fields for a profile (issue #235, ADR-0071 Consequences): the
// protocol RadioGroup (shown only when the endpoint is Custom -- a named preset
// implies its protocol) + base URL + model inputs. Extracted from
// ProfilesSection so the composer popover (#3) and cold-start guide (#5) can
// reuse the same endpoint form. The model field is a plain Input in this slice;
// ADR-0070's list-models dropdown (#2) will swap in at this seam -- the
// component boundary IS the swap point, so no render-prop slot is added now
// (YAGNI).

type ProviderEndpointFieldsProps = {
  profile: ProviderProfile;
  onUpdate: (patch: Partial<ProviderProfile>) => void;
  // True when the endpoint does not match any preset (Custom): the protocol
  // RadioGroup shows so the user picks the wire protocol by hand. Named presets
  // carry their own protocol, so the group is hidden otherwise (the preset
  // select communicates it instead).
  showProtocolRadio: boolean;
  disabled: boolean;
};

export function ProviderEndpointFields({
  profile,
  onUpdate,
  showProtocolRadio,
  disabled,
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

      <Label className="grid gap-1">
        <FormattedMessage id="settings.profiles.model" defaultMessage="Model" />
        <Input
          type="text"
          value={profile.model}
          onChange={(e) => onUpdate({ model: e.target.value })}
          disabled={disabled}
        />
      </Label>
    </>
  );
}
