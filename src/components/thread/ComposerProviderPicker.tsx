import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Cpu } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtError } from "../../lib/error-presentation";
import { listProviderProfiles } from "../../api";
import type { ProviderConfig } from "../../types/provider";
import {
  PRESET_CUSTOM,
  derivePresetId,
  findPreset,
} from "../settings/provider-presets";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Composer provider/model picker (issue #238, ADR-0071). The three-tier
// provider/model switch surface at the QuestionBar edge:
//   - icon trigger (lucide Cpu -- a unified entry glyph, NOT a provider logo;
//     ADR-0071 avoids provider trademarks),
//   - hover Tooltip -- lightweight "{provider} . {model}" preview (+ an honest
//     "no key" mark when the active profile has no key, ADR-0019),
//   - click Popover -- the heavy panel: provider (active profile) dropdown +
//     model field + key status + "Open settings" entry.
// ProfileSwitcher (top bar) stays mounted this slice -- its retirement is a
// follow-up that depends on this one ("ProfileSwitcher 退役另行收尾").
//
// State ownership mirrors ProfileSwitcher: the profile RECORDS come from the
// parent's provider prop (single source of truth, app-config); the per-profile
// has_key overlay is fetched once on mount via listProviderProfiles (a switch
// moves the active pointer, not the keys, so it is never refetched). Writes
// route through the parent: onSwitchActive -> active_profile; onSwitchModel ->
// the active profile's model field (ADR-0064: model is per-profile; the
// composer commits via commitAppConfig, live_config reads it fresh next turn).
// The "Open settings" entry closes the popover BEFORE opening the overlay --
// PopoverContent is portaled to document.body, so it would otherwise stay
// visible atop the settings view (ADR-0065 hides the session shell via CSS,
// not the portal host).

export type ComposerProviderPickerProps = {
  // The non-secret provider config (profiles list + active id), single-sourced
  // by the parent from app-config. This component never mutates it.
  provider: ProviderConfig;
  // Commit a new active_profile id (one-shot app-config write; live_config
  // reads it fresh on the next turn, ADR-0064). Routes through switchActiveProfile.
  onSwitchActive: (id: string) => void;
  // Commit a new model onto the ACTIVE profile (writes profile.model via
  // commitAppConfig, ADR-0071). Fired on blur / Enter, NOT per keystroke.
  onSwitchModel: (model: string) => void;
  // Open the Settings overlay (ADR-0065). The popover closes first.
  onOpenSettings: () => void;
};

export function ComposerProviderPicker({
  provider,
  onSwitchActive,
  onSwitchModel,
  onOpenSettings,
}: ComposerProviderPickerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  // Per-profile has_key overlay (issue #154 / ADR-0029). Fetched once on mount;
  // never refetched -- a switch moves the active pointer, not the keys (mirrors
  // ProfileSwitcher). A settings Save that changes a slot is reflected on the
  // next mount; this slice does not refetch on settings-close.
  const [profileKeys, setProfileKeys] = useState<Record<string, boolean>>({});
  const [keysError, setKeysError] = useState<string | null>(null);

  // Stable intl ref so the mount-time fetch effect runs once ([] deps) instead
  // of re-firing on an intl identity change (mirrors ProfileSwitcher).
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);

  useEffect(() => {
    let cancelled = false;
    listProviderProfiles()
      .then((status) => {
        if (cancelled) return;
        const map: Record<string, boolean> = {};
        for (const s of status) map[s.profile_id] = s.has_key;
        setProfileKeys(map);
      })
      .catch((e) => {
        if (!cancelled) setKeysError(fmtError(e, intlRef.current));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeProfile = provider.profiles.find(
    (p) => p.id === provider.active_profile,
  );
  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  const model = activeProfile?.model ?? "";
  const hasKey = activeProfile
    ? (profileKeys[activeProfile.id] ?? false)
    : false;

  // The provider readout = the preset the active profile sits on (e.g.
  // "Anthropic"); falls back to the profile's own display name when the endpoint
  // is Custom. A unified, non-trademark provider label (ADR-0071).
  const presetId = activeProfile
    ? derivePresetId({
        protocol: activeProfile.protocol,
        base_url: activeProfile.base_url,
      })
    : PRESET_CUSTOM;
  const preset = presetId === PRESET_CUSTOM ? undefined : findPreset(presetId);
  const providerName =
    preset?.display_name ?? activeProfile?.display_name.trim() ?? unnamed;

  // Tooltip preview text (also Radix Tooltip's aria-describedby content, so SR
  // users hear the live context on trigger focus). The honest "no key" mark is
  // appended when the active profile has no key (ADR-0019). Each formatMessage
  // id is a static literal at the call site so @formatjs/cli extract resolves
  // them (ADR-0052 CI gate).
  const summary = intl.formatMessage(
    {
      id: "composer.providerPicker.tooltip",
      defaultMessage: "{provider} · {model}",
    },
    { provider: providerName, model: model || "—" },
  );
  const noKeyMark = intl.formatMessage({
    id: "composer.providerPicker.noKeyMark",
    defaultMessage: "no key",
  });
  const tooltipText = hasKey ? summary : `${summary} · ${noKeyMark}`;

  // Model field draft. The popover's model input commits on blur / Enter, NOT
  // per keystroke -- a model id is multi-character and per-keystroke writes
  // would spam commitAppConfig (one IPC per character). The draft re-syncs to
  // the prop when the (active profile, model) pair it was seeded from changes:
  // a profile switch loads the new profile's model, AND an external model change
  // (e.g. a Settings Save that rewrites profile.model via commitAppConfig, or
  // this picker's own committed write landing back via the optimistic state)
  // refreshes the field so it never shows a stale value. Typing does NOT trip
  // it -- modelDraft moves on each keystroke but the `model` prop is constant
  // between commits. Same render-time "adjust state when a value changes"
  // pattern as ProviderKeyField's profile-id reset -- avoids the
  // set-state-in-effect lint. See https://react.dev/learn/you-might-not-need-an-effect
  const [modelDraft, setModelDraft] = useState(model);
  const [draftSeed, setDraftSeed] = useState({
    id: provider.active_profile,
    model,
  });
  if (provider.active_profile !== draftSeed.id || model !== draftSeed.model) {
    setDraftSeed({ id: provider.active_profile, model });
    setModelDraft(model);
  }

  function commitModel() {
    const trimmed = modelDraft.trim();
    // No-op on an empty draft or when the value did not change.
    if (trimmed && trimmed !== model) onSwitchModel(trimmed);
  }

  function handleOpenSettings() {
    // Close BEFORE opening: the portaled PopoverContent would otherwise remain
    // visible atop the settings overlay (ADR-0065 hides the shell via CSS, not
    // the portal host in document.body).
    setOpen(false);
    onOpenSettings();
  }

  // Unique per-instance id for the model <datalist> (multiple keep-alive
  // SessionPanes each render a picker -- a profile-derived id would collide
  // across instances since all share the same active profile).
  const datalistId = useId();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              // ADR-0067 (#171): visual rules -> inline utilities. The trigger
              // is an icon button sized to the QuestionBar row; bg-card + border
              // mirror the retired ProfileSwitcher trigger affordance.
              className="composer-picker-trigger inline-flex items-center justify-center size-9 rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors cursor-pointer"
              aria-label={intl.formatMessage({
                id: "composer.providerPicker.triggerAria",
                defaultMessage: "Provider and model",
              })}
            >
              <Cpu className="size-4" aria-hidden />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-80">
        <div className="grid gap-3">
          {/* Zone 1: provider (active profile) dropdown -- switches active_profile. */}
          <Label className="grid gap-1">
            <FormattedMessage
              id="composer.providerPicker.profileLabel"
              defaultMessage="Profile"
            />
            {/* Native <select> (precedent: ProviderPresetField) styled to match
                Input. No Radix Select primitive for a single picker (KISS). */}
            <select
              value={provider.active_profile}
              onChange={(e) => onSwitchActive(e.target.value)}
              className={cn(
                "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none",
                "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
              )}
            >
              {provider.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name.trim() || unnamed}
                </option>
              ))}
            </select>
          </Label>

          {/* Zone 2: model field. Hand-typed input + a <datalist> offering the
              active preset's default_model. NO network request (no list-models
              probe) -- opening the popover never blocks on the network; model
              accuracy is the Settings preflight's job (#236, ADR-0070). */}
          <Label className="grid gap-1">
            <FormattedMessage id="settings.profiles.model" defaultMessage="Model" />
            <Input
              type="text"
              list={datalistId}
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value)}
              onBlur={commitModel}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") {
                  // The portaled input is not inside the QuestionBar form, but
                  // Enter should commit rather than do anything unexpected.
                  e.preventDefault();
                  commitModel();
                }
              }}
            />
            <datalist id={datalistId}>
              {/* Offer the preset's default model only when the active profile
                  is on a named preset (Custom has no canonical default). */}
              {preset && <option value={preset.default_model} />}
            </datalist>
            <span className="text-muted-foreground text-xs">
              <FormattedMessage
                id="composer.providerPicker.modelHint"
                defaultMessage="Type a model id, or pick the preset default."
              />
            </span>
          </Label>

          {/* Zone 3: key status. Honest mark when the active profile has no key
              (ADR-0019) -- the badge + the explicit "asking will fail" line. */}
          <div className="flex items-center gap-2 text-sm">
            <Badge variant={hasKey ? "secondary" : "outline"}>
              {hasKey ? (
                <FormattedMessage
                  id="settings.profiles.keySet"
                  defaultMessage="Key set"
                />
              ) : (
                <FormattedMessage
                  id="settings.profiles.keyMissing"
                  defaultMessage="No key"
                />
              )}
            </Badge>
            {!hasKey && (
              <span className="text-muted-foreground">
                <FormattedMessage
                  id="settings.profiles.key.hintUnset"
                  defaultMessage="No key saved for this profile — asking with this profile active will return a “not configured” failure."
                />
              </span>
            )}
          </div>
          {keysError && <p className="text-destructive text-sm">{keysError}</p>}

          {/* Zone 4: open settings entry (ADR-0065 overlay). */}
          <Button type="button" variant="outline" size="sm" onClick={handleOpenSettings}>
            <FormattedMessage
              id="composer.providerPicker.openSettings"
              defaultMessage="Open settings"
            />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
