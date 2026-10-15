import { useId, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { clearProfileKey, setProfileKey } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { SETTINGS_TOOLTIP_CLASS, SettingsRow } from "./settings-chrome";
import type { ProviderPresetGetKeyLink } from "./provider-presets";

// Per-profile API key field (issue #235, ADR-0071 Consequences). Lifts the key
// input + set/clear IPC + has_key badge OUT of ProfilesSection so the same atom
// serves the cold-start guide (#5) and any future surface that edits a profile
// key. Rendered as one settings-card row (the shared SettingsRow chrome every
// settings form rides). The key crosses IPC exactly once (ADR-0029 one-shot):
// setProfileKey takes it into the Rust core, returns the NEW has_key, and the
// field never holds the persisted key -- it shows a has_key badge + drives
// Set/Update/Clear off the parent's overlay, reporting each result upward via
// onKeyStatusChange so the parent's list-level badge stays in sync without a
// re-fetch.
//
// The component does NOT remount on profile switch (the parent does not key it):
// a render-time reset clears the typed-but-unset input when profileId changes,
// while a mid-flight IPC still completes against the mounted instance (the
// returned has_key must not land on an unmounted node, ADR-0029 trust root).

type ProviderKeyFieldProps = {
  // The profile this key field edits. The id is the keychain account suffix
  // (`key-<id>`); it need not match a saved profile yet (a freshly-minted id
  // before Save is a valid target).
  profileId: string;
  // Current has_key (from the parent's key-status overlay). Drives the badge +
  // the Set/Update/Clear button labels.
  hasKey: boolean;
  // Lift the new has_key up so the parent's list-level badge stays in sync
  // without a re-fetch (the IPC returns the bool; the parent does not re-read).
  onKeyStatusChange: (hasKey: boolean) => void;
  // "Get key" link for the active preset (null when the provider needs no key
  // acquisition, e.g. the Ollama loopback). Rendered as an external link,
  // aligning with mainstream BYOK settings panels.
  getKeyLink: ProviderPresetGetKeyLink | null;
  // Preset specific example token for the unset placeholder; empty falls back to
  // the generic "Paste key" message.
  keyPlaceholder: string;
  disabled: boolean;
  // Whether to render the has_key badge inside the row title. Default true --
  // the atom conveys key status on its own for surfaces without a list
  // (cold-start guide #5). ProfilesSection passes false: its master list
  // already shows the per-profile status badge, so a second one in the edit
  // form duplicates the same fact on one screen.
  showBadge?: boolean;
  // Deferred posture (add mode): no immediate Set/Clear IPC. The input is
  // CONTROLLED by the parent -- the typed key stays in the parent's draft state
  // and is written to the keychain as part of the parent's create flow, so a
  // discarded add can never leave a keychain entry for a profile that was
  // never created. Absent = the immediate Set/Update/Clear posture.
  draftMode?: {
    value: string;
    onChange: (value: string) => void;
  };
  // Notified imperatively at key IPC boundaries (true on start, false in the
  // finally) so the parent's close guard blocks ESC / Back / Cancel while the
  // IPC is in flight. Imperative -- NOT state -> effect -- because the finally
  // runs even after this node unmounts (a section switch mid-IPC), where the
  // setKeyBusy mirror would no-op and never report "settled" upward.
  onBusyChange?: (busy: boolean) => void;
};

export function ProviderKeyField({
  profileId,
  hasKey,
  onKeyStatusChange,
  getKeyLink,
  keyPlaceholder,
  disabled,
  showBadge = true,
  onBusyChange,
  draftMode,
}: ProviderKeyFieldProps) {
  const intl = useIntl();
  const inputId = useId();
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Reset the typed-but-unset input + its error when the edited profile changes
  // (each profile owns its own key). Same render-time "adjust state when a value
  // changes" pattern as ProfilesSection's selection reset -- avoids the
  // set-state-in-effect lint and never shows a stale value. See
  // https://react.dev/learn/you-might-not-need-an-effect
  const [inputForId, setInputForId] = useState(profileId);
  if (profileId !== inputForId) {
    setInputForId(profileId);
    setKeyInput("");
    setKeyError(null);
  }

  async function handleSetKey() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setKeyBusy(true);
    onBusyChange?.(true);
    setKeyError(null);
    try {
      const next = await setProfileKey(profileId, trimmed);
      onKeyStatusChange(next);
      setKeyInput("");
    } catch (e) {
      setKeyError(fmtError(e, intl));
    } finally {
      setKeyBusy(false);
      onBusyChange?.(false);
    }
  }

  async function handleClearKey() {
    setKeyBusy(true);
    onBusyChange?.(true);
    setKeyError(null);
    try {
      const next = await clearProfileKey(profileId);
      onKeyStatusChange(next);
    } catch (e) {
      setKeyError(fmtError(e, intl));
    } finally {
      setKeyBusy(false);
      onBusyChange?.(false);
    }
  }

  const keyDisabled = disabled || keyBusy;

  // Tauri's WebView has no navigation handler for target=_blank -- a plain
  // anchor click does nothing (issue surfaced in the settings redesign). The
  // OS opener IPC is the sanctioned path; the anchor keeps its href/aria-label
  // semantics, with the default navigation prevented in favor of openUrl.
  async function handleOpenGetKeyLink() {
    if (!getKeyLink) return;
    try {
      await openUrl(getKeyLink.url);
    } catch (e) {
      setKeyError(fmtError(e, intl));
    }
  }

  // Unset placeholder: prefer the preset's example token; fall back to the
  // generic "Paste key" when the preset offers none (Custom / GLM / Ollama). Set
  // placeholder is the leave-as-is hint. Both are literal message ids at the
  // call site so @formatjs/cli extract resolves them (ADR-0052 CI gate).
  const placeholder = hasKey
    ? intl.formatMessage({
        id: "settings.profiles.key.placeholderSet",
        defaultMessage: "Saved (leave blank to keep as-is)",
      })
    : keyPlaceholder ||
      intl.formatMessage({
        id: "settings.profiles.key.placeholderUnset",
        defaultMessage: "Paste key",
      });

  return (
    <SettingsRow
      dense
      title={(
        <span className="flex items-center gap-2">
          <Label htmlFor={inputId} className="text-muted-foreground">
            <FormattedMessage
              id="settings.profiles.key.title"
              defaultMessage="API key"
            />
          </Label>
          {getKeyLink && (
            // The "Get key" affordance rides the row title as a bare external
            // link icon -- the destination copy lives in its tooltip (the
            // shared settings tooltip skin, issue #554). The accessible name
            // keeps the full "Get key at <host>" wording so the link announces
            // its target without the visual text.
            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  // text-primary reuses the brand accent (ADR-0050 teal) as the
                  // link color -- ADR-0067 Decision 2 denies a custom link
                  // token, so no new --color-link is introduced for this one
                  // external link. Anchors have no disabled attribute; the
                  // keyDisabled posture (a key IPC in flight / pane busy)
                  // matches the sibling Input + Set/Clear buttons via
                  // aria-disabled + a click guard instead of staying clickable
                  // mid-IPC.
                  href={getKeyLink.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    if (keyDisabled) return;
                    void handleOpenGetKeyLink();
                  }}
                  aria-label={intl.formatMessage(
                    {
                      id: "settings.profiles.preset.getKey",
                      defaultMessage: "Get key at {host}",
                    },
                    { host: getKeyLink.host },
                  )}
                  aria-disabled={keyDisabled}
                  className={cn(
                    "text-primary hover:text-primary/80 focus-visible:outline-ring rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2",
                    keyDisabled && "pointer-events-none opacity-50",
                  )}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </TooltipTrigger>
              <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
                <FormattedMessage
                  id="settings.profiles.key.getKeyShort"
                  defaultMessage="Get key"
                />
              </TooltipContent>
            </Tooltip>
          )}
          {showBadge && (
            <Badge variant={hasKey ? "secondary" : "outline"}>
              {hasKey ? (
                <FormattedMessage id="settings.profiles.keySet" defaultMessage="Key set" />
              ) : (
                <FormattedMessage
                  id="settings.profiles.keyMissing"
                  defaultMessage="No key"
                />
              )}
            </Badge>
          )}
        </span>
      )}
    >
      <div className="grid gap-2">
        <Input
          id={inputId}
          type="password"
          value={draftMode ? draftMode.value : keyInput}
          onChange={(e) =>
            draftMode
              ? draftMode.onChange(e.target.value)
              : setKeyInput(e.target.value)}
          placeholder={placeholder}
          disabled={keyDisabled}
          autoComplete="off"
        />
        {!draftMode && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={handleSetKey}
              disabled={keyDisabled || !keyInput.trim()}
            >
              {hasKey ? (
                <FormattedMessage
                  id="settings.profiles.key.update"
                  defaultMessage="Update key"
                />
              ) : (
                <FormattedMessage id="settings.profiles.key.set" defaultMessage="Set key" />
              )}
            </Button>
            {hasKey && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleClearKey}
                disabled={keyDisabled}
              >
                <FormattedMessage
                  id="settings.profiles.key.clear"
                  defaultMessage="Clear key"
                />
              </Button>
            )}
          </div>
        )}
        <p className="text-muted-foreground text-xs leading-relaxed">
          {draftMode ? (
            <FormattedMessage
              id="settings.profiles.key.hintDraft"
              defaultMessage="The key is saved to this machine's OS keychain together with the profile when you create it."
            />
          ) : hasKey ? (
            <FormattedMessage
              id="settings.profiles.key.hintSet"
              defaultMessage="A key is saved for this profile. Use “Clear key” to remove it; the key never leaves the OS keychain."
            />
          ) : (
            <FormattedMessage
              id="settings.profiles.key.hintUnset"
              defaultMessage="No key saved for this profile — asking with this profile active will return a “not configured” failure."
            />
          )}
        </p>
        {keyError && <p className="text-destructive text-sm">{keyError}</p>}
      </div>
    </SettingsRow>
  );
}
