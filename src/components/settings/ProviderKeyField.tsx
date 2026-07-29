import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { clearProfileKey, setProfileKey } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { ProviderPresetGetKeyLink } from "./provider-presets";

// Per-profile API key field (issue #235, ADR-0071 Consequences). Lifts the key
// input + set/clear IPC + has_key badge OUT of ProfilesSection so the same atom
// serves the cold-start guide (#5) and any future surface that edits a profile
// key. The key crosses IPC exactly once (ADR-0029 one-shot): setProfileKey takes
// it into the Rust core, returns the NEW has_key, and the field never holds the
// persisted key -- it shows a has_key badge + drives Set/Update/Clear off the
// parent's overlay, reporting each result upward via onKeyStatusChange so the
// parent's list-level badge stays in sync without a re-fetch.
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
  // Preset-specific example token for the unset placeholder; empty falls back to
  // the generic "Paste key" message.
  keyPlaceholder: string;
  disabled: boolean;
  // Whether to render the has_key badge inside the legend. Default true -- the
  // atom conveys key status on its own for surfaces without a list (cold-start
  // guide #5). ProfilesSection passes false: its master list already shows the
  // per-profile status badge, so a second one in the edit form duplicates the
  // same fact on one screen.
  showBadge?: boolean;
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
}: ProviderKeyFieldProps) {
  const intl = useIntl();
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
    <fieldset className="grid gap-2 border-0 p-0 m-0">
      <legend className="flex items-center gap-2 text-sm font-medium">
        <FormattedMessage
          id="settings.profiles.key.legend"
          defaultMessage="API key (stored only in this machine's OS keychain)"
        />
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
      </legend>

      {getKeyLink && (
        <a
          // text-primary reuses the brand accent (ADR-0050 teal) as the link
          // color -- ADR-0067 Decision 2 denies a custom link token, so no new
          // --color-link is introduced for this one external link.
          href={getKeyLink.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-primary hover:underline"
        >
          <FormattedMessage
            id="settings.profiles.preset.getKey"
            defaultMessage="Get key at {host}"
            values={{ host: getKeyLink.host }}
          />
        </a>
      )}

      <Input
        type="password"
        value={keyInput}
        onChange={(e) => setKeyInput(e.target.value)}
        placeholder={placeholder}
        disabled={keyDisabled}
        autoComplete="off"
      />
      <div className="flex gap-2">
        <Button
          type="button"
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
      <p className="text-muted-foreground text-sm">
        {hasKey ? (
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
    </fieldset>
  );
}
