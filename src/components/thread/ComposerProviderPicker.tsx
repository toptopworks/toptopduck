import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cpu, RefreshCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import {
  getSessionRuntime,
  listAdapters,
  listProviderProfiles,
  rescanAdapters,
  setSessionRuntime,
} from "../../api";
import { adapterKeys, sessionKeys } from "../../session/queryKeys";
import type { ProfileKeyStatus, ProviderConfig } from "../../types/provider";
import type { AdapterEntry, SessionRuntimeChoice } from "../../types/runtime";
import { RUNTIME_CHOICE_DEFAULT } from "../../types/runtime";
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

// Composer runtime picker (issue #238 / #353, ADR-0071/0076/0081/0083). A
// dual-segment popover at the QuestionBar edge that selects which runtime
// drives the NEXT turn:
//   - built-in group (ADR-0081) -- the BYOK Rust agent loop on the active
//     profile + model. The profile RECORDS come from the parent's provider
//     prop; the model + key-status surfaces are ADR-0071's picker, kept as
//     the built-in group's body.
//   - external group (ADR-0085) -- the v1 ACP adapters (`list_adapters`,
//     dynamic, NOT hardcoded): detected rows are selectable, undetected rows
//     render disabled + "not installed", and the ↻ entry re-runs the PATH
//     scan (`rescan_adapters`). Adding a CLI upstream grows the list with
//     zero frontend change.
//
// Trigger: a lucide Cpu icon button (a unified entry glyph, NOT a provider
// logo; ADR-0071). Hover Tooltip: an honest "{provider} · {model}" preview for
// the built-in runtime (+ an honest "no key" mark when the active profile has
// no key, ADR-0019) or the external adapter name. Click Popover: the heavy
// dual-segment panel.
//
// Runtime state ownership: the per-session CHOICE is backend truth, read via
// `getSessionRuntime` under the session-prefix query (a close drops it with
// the rest; a resume lands the reset built-in value via the fresh SessionPane
// mount, mirroring authMode). Writes go through `setSessionRuntime` and take
// effect at the NEXT turn boundary -- the in-flight turn, if any, finishes on
// the runtime it started on. A rejected write (session dropped mid-flight,
// mid-resume swap) keeps the server posture -- the picker resyncs via
// refetch and never shows a runtime the backend did not grant.
//
// Profile + model + key-status ownership is unchanged from ADR-0071: profile
// records are single-sourced from the provider prop; the per-profile has_key
// overlay is fetched on mount AND on a profileKeyEpoch bump; writes route
// through onSwitchActive / onSwitchModel. The "Open settings" entry closes the
// popover BEFORE opening the overlay -- PopoverContent is portaled to
// document.body, so it would otherwise stay visible atop the settings view
// (ADR-0065 hides the session shell via CSS, not the portal host).

export type ComposerProviderPickerProps = {
  // The session whose runtime this picker reads / switches. Runtime selection
  // is per-session assembly posture (ADR-0083), like the auth-mode chip.
  sessionId: string;
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
  // Invalidation counter for the per-profile has_key overlay. Bumped by the
  // parent (App) on settings-close -- a Settings Save may have changed a
  // keychain slot, so the mount-time fetch effect re-runs on a bump and the
  // badge does not show a stale "No key" after the user just configured one
  // (ADR-0019 honest gate). Undefined = mount-only fetch (the mount-only
  // contract, retained for tests that exercise the picker in isolation).
  profileKeyEpoch?: number;
};

export function ComposerProviderPicker({
  sessionId,
  provider,
  onSwitchActive,
  onSwitchModel,
  onOpenSettings,
  profileKeyEpoch,
}: ComposerProviderPickerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  // Per-profile has_key overlay (issue #154 / ADR-0029). Fetched on mount AND
  // on a profileKeyEpoch bump -- App bumps the epoch on settings-close so a
  // Settings Save that changed a keychain slot is reflected without a remount
  // (ADR-0019 honest gate: the popover must not keep showing "No key" after the
  // user just configured one). A profile switch never refetches -- it moves the
  // active pointer, not the keys.
  const [profileKeys, setProfileKeys] = useState<Record<string, ProfileKeyStatus>>({});
  const [keysError, setKeysError] = useState<string | null>(null);

  // Stable intl ref so the mount-time fetch effect runs once ([] deps) instead
  // of re-firing on an intl identity change.
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);

  useEffect(() => {
    let cancelled = false;
    listProviderProfiles()
      .then((status) => {
        if (cancelled) return;
        const map: Record<string, ProfileKeyStatus> = {};
        for (const s of status) map[s.profile_id] = s;
        setProfileKeys(map);
      })
      .catch((e) => {
        if (!cancelled) setKeysError(fmtError(e, intlRef.current));
      });
    return () => {
      cancelled = true;
    };
  }, [profileKeyEpoch]);

  // Per-session runtime choice (issue #353). Backend truth, read under the
  // session-prefix query so a close drops it with the rest and a resume lands
  // the reset built-in value via the fresh SessionPane mount (mirrors authMode).
  const queryClient = useQueryClient();
  const { data: runtimeData } = useQuery({
    queryKey: sessionKeys.runtime(sessionId),
    queryFn: () => getSessionRuntime(sessionId),
  });
  const runtime: SessionRuntimeChoice = runtimeData ?? RUNTIME_CHOICE_DEFAULT;
  const isExternal = runtime.kind === "external";
  const activeAdapterId = isExternal ? runtime.data : null;

  // The v1 adapter table (session-agnostic, ADR-0081/0083). Detected rows are
  // selectable; undetected render disabled + "not installed". The ↻ entry
  // re-runs the PATH scan via rescanAdapters and seeds the cache. Detection is
  // uncached server-side, so list + rescan share one key and the ↻ is the
  // explicit user-driven refresh.
  const { data: adapterData } = useQuery({
    queryKey: adapterKeys.all(),
    queryFn: listAdapters,
  });
  const adapters: AdapterEntry[] = adapterData ?? [];
  const activeAdapter = isExternal
    ? (adapters.find((a) => a.id === activeAdapterId) ?? null)
    : null;

  // Guards the write window: a click that lands while the set IPC is in flight
  // is dropped instead of re-firing (the disabled attr is the visual half of
  // the same gate). Rescan has its own guard so the two IPCs never share a flag.
  const [switching, setSwitching] = useState(false);
  const [rescanning, setRescanning] = useState(false);

  async function selectRuntime(next: SessionRuntimeChoice) {
    if (switching) return;
    setSwitching(true);
    try {
      await setSessionRuntime(sessionId, next);
      // The write is the truth source: seed the cache directly (no extra IPC
      // round-trip; a later remount refetches the same value).
      queryClient.setQueryData(sessionKeys.runtime(sessionId), next);
    } catch (e) {
      // Keep the server posture: refetch so the picker re-reads the backend
      // truth instead of showing a selection the write never granted.
      log.warn(
        "ComposerProviderPicker",
        "set session runtime failed; resyncing from the session",
        fmtError(e, intl),
      );
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.runtime(sessionId),
      });
    } finally {
      setSwitching(false);
    }
  }

  async function rescan() {
    if (rescanning) return;
    setRescanning(true);
    try {
      const fresh = await rescanAdapters();
      queryClient.setQueryData(adapterKeys.all(), fresh);
    } catch (e) {
      log.warn("ComposerProviderPicker", "adapter rescan failed", fmtError(e, intl));
    } finally {
      setRescanning(false);
    }
  }

  const activeProfile = provider.profiles.find(
    (p) => p.id === provider.active_profile,
  );
  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  const model = activeProfile?.model ?? "";
  const activeStatus = activeProfile ? profileKeys[activeProfile.id] : undefined;
  const hasKey = activeStatus?.has_key ?? false;
  const keychainFault = activeStatus?.keychain_fault ?? null;

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
  const keychainUnavailableMark = intl.formatMessage({
    id: "settings.profiles.keychainUnavailable",
    defaultMessage: "Keychain unavailable",
  });
  // The external-runtime tooltip names the selected adapter (the closed chip
  // shows the Cpu glyph alone; the tooltip is where the user reads WHICH
  // runtime the next turn will use). Falls back to the raw id if the adapter
  // row has not loaded yet.
  const externalTooltip = intl.formatMessage(
    {
      id: "composer.runtimePicker.tooltip.external",
      defaultMessage: "External runtime: {adapter}",
    },
    { adapter: activeAdapter?.display_name ?? activeAdapterId ?? "" },
  );
  const builtInTooltip = keychainFault
    ? `${summary} · ${keychainUnavailableMark}`
    : hasKey
      ? summary
      : `${summary} · ${noKeyMark}`;
  const tooltipText = isExternal ? externalTooltip : builtInTooltip;

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
              // ride the ADR-0050 token.
              className="composer-picker-trigger inline-flex items-center justify-center size-9 rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors cursor-pointer"
              aria-label={intl.formatMessage(
                {
                  id: "composer.providerPicker.triggerAria",
                  defaultMessage: "Runtime: {label}",
                },
                {
                  label: isExternal
                    ? (activeAdapter?.display_name ?? activeAdapterId ?? "")
                    : providerName,
                },
              )}
            >
              <Cpu className="size-4" aria-hidden />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-80">
        <div className="grid gap-3">
          {/* --- Built-in runtime group (ADR-0081, issue #353) -----------------
              The BYOK Rust agent loop on the active profile + model. The
              header is a select affordance (click reverts to built-in); the
              profile + model + key-status body is ADR-0071's picker, kept
              intact so the user configures the built-in profile here. */}
          <section className="grid gap-2">
            <button
              type="button"
              disabled={switching}
              onClick={() => void selectRuntime({ kind: "built_in" })}
              aria-pressed={!isExternal}
              className="flex items-center gap-2 text-sm font-medium cursor-pointer disabled:pointer-events-none disabled:opacity-50"
            >
              <RuntimeDot selected={!isExternal} />
              <FormattedMessage
                id="composer.runtimePicker.builtinTitle"
                defaultMessage="Built-in"
              />
            </button>
            {/* Profile dropdown -- switches active_profile. */}
            <Label className="grid gap-1">
              <FormattedMessage
                id="composer.providerPicker.profileLabel"
                defaultMessage="Profile"
              />
              {/* Native <select> (precedent: ProviderPresetField) styled to
                  match Input. No Radix Select primitive for a single picker
                  (KISS). */}
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

            {/* Model field. Hand-typed input + a <datalist> offering the
                active preset's default_model. NO network request (no
                list-models probe) -- opening the popover never blocks on the
                network; model accuracy is the Settings preflight's job
                (#236, ADR-0070). */}
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
                    // The portaled input is not inside the QuestionBar form,
                    // but Enter should commit rather than do anything
                    // unexpected.
                    e.preventDefault();
                    commitModel();
                  }
                }}
              />
              <datalist id={datalistId}>
                {/* Offer the preset's default model only when the active
                    profile is on a named preset (Custom has no canonical
                    default). */}
                {preset && <option value={preset.default_model} />}
              </datalist>
              <span className="text-muted-foreground text-xs">
                <FormattedMessage
                  id="composer.providerPicker.modelHint"
                  defaultMessage="Type a model id, or pick the preset default."
                />
              </span>
            </Label>

            {/* Key status. Honest mark when the active profile has no key
                (ADR-0019) -- the badge + the explicit "asking will fail"
                line, the built-in group's "unconfigured + guidance" surface. */}
            <div className="flex items-center gap-2 text-sm">
              {keychainFault ? (
                <Badge variant="outline" title={keychainFault}>
                  <FormattedMessage
                    id="settings.profiles.keychainUnavailable"
                    defaultMessage="Keychain unavailable"
                  />
                </Badge>
              ) : (
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
              )}
              {keychainFault ? (
                <span className="text-muted-foreground">
                  <FormattedMessage
                    id="settings.profiles.keychainUnavailableHint"
                    defaultMessage="The OS keychain could not be read (it may be locked, or the service is down). Check the OS keychain, then retry."
                  />
                </span>
              ) : !hasKey ? (
                <span className="text-muted-foreground">
                  <FormattedMessage
                    id="settings.profiles.key.hintUnset"
                    defaultMessage="No key saved for this profile — asking with this profile active will return a “not configured” failure."
                  />
                </span>
              ) : null}
            </div>
            {keysError && <p className="text-destructive text-sm">{keysError}</p>}

            {/* Open settings entry (ADR-0065 overlay). */}
            <Button type="button" variant="outline" size="sm" onClick={handleOpenSettings}>
              <FormattedMessage
                id="common.openSettings"
                defaultMessage="Open settings"
              />
            </Button>
          </section>

          {/* --- External runtime group (ADR-0085, issue #353) ----------------
              The v1 ACP adapters, read dynamically from list_adapters (never
              hardcoded). Detected rows are selectable; undetected rows render
              disabled + "not installed". The ↻ entry re-runs the PATH scan. */}
          <div className="border-t border-border" />
          <section className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                <FormattedMessage
                  id="composer.runtimePicker.externalTitle"
                  defaultMessage="External"
                />
              </span>
              <button
                type="button"
                onClick={() => void rescan()}
                disabled={rescanning}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted cursor-pointer disabled:pointer-events-none disabled:opacity-50"
                aria-label={intl.formatMessage({
                  id: "composer.runtimePicker.rescanAria",
                  defaultMessage: "Rescan adapters",
                })}
              >
                <RefreshCw
                  className={cn("size-3.5", rescanning && "animate-spin")}
                  aria-hidden
                />
              </button>
            </div>
            {adapters.map((a) => {
              const selected = isExternal && activeAdapterId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={!a.detected || switching}
                  onClick={() => void selectRuntime({ kind: "external", data: a.id })}
                  aria-pressed={selected}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer disabled:pointer-events-none disabled:opacity-50",
                    selected ? "bg-muted" : "hover:bg-muted",
                  )}
                >
                  <RuntimeDot selected={selected} />
                  <span className="flex-1 text-left text-foreground">
                    {a.display_name}
                  </span>
                  {!a.detected && (
                    <span className="text-xs text-muted-foreground">
                      <FormattedMessage
                        id="composer.runtimePicker.notInstalled"
                        defaultMessage="Not installed"
                      />
                    </span>
                  )}
                </button>
              );
            })}
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// A radio-style selection dot for the runtime groups: a filled ring with a
// check when selected, a hollow ring otherwise. aria-hidden -- the selecting
// button carries aria-pressed, so the dot is purely visual (announcing it
// would duplicate the pressed state).
function RuntimeDot({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
        selected
          ? "border-primary text-primary"
          : "border-muted-foreground/50 text-transparent",
      )}
      aria-hidden
    >
      <Check className="size-3" />
    </span>
  );
}
