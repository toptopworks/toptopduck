// The extraction-model picker (issue #1530, ADR-0147 Decision 7): which
// provider profile runs the after-turn memory extraction. A Radix Select
// over the EXISTING profile pool -- the picker adds no second config
// shape, just a pointer (follow-active = the null pointer, the
// zero-config posture). Radix SelectItem forbids an empty-string value
// (the old native select's null-pointer encoding), so the pointer rides
// namespaced keys instead -- `follow_active` / `profile:<id>`, parsed
// back on save -- the DefaultRuntimeControl encoding. The write is the
// draft + Save row (the same posture): a pending pick persists only on
// Save, and the commit channel's own in-flight counter already gates the
// settings close (ADR-0075), so the Save flight needs no separate busy
// mirror. The cost note rides the workspace memory panel's extraction
// toggle instead (the "cost follows the switch" ruling).

import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import type { AppConfig } from "../../types/app-config";
import type { ProviderConfig } from "../../types/provider";
import { fmtError } from "../../lib/error-presentation";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SettingsRow } from "./settings-chrome";

// The two select-key forms (they cannot collide: profile ids ride their
// own namespace).
const FOLLOW_ACTIVE_KEY = "follow_active";

/** Parse a select key back into the stored pointer. */
function profileFromKey(key: string): string | null {
  return key === FOLLOW_ACTIVE_KEY ? null : key.slice("profile:".length);
}

/** The select key for a stored pointer: namespaced for a real profile,
 *  the unit literal for follow-active. A dangling stored pointer ALSO
 *  renders as follow-active (the backend nulls it on the next normalize;
 *  the UI must not show a dead id). */
function keyForProfile(
  profile: string | null,
  options: ProviderConfig["profiles"],
): string {
  return profile !== null && options.some((p) => p.id === profile)
    ? `profile:${profile}`
    : FOLLOW_ACTIVE_KEY;
}

export type ExtractionModelSelectProps = {
  provider: ProviderConfig;
  memoryExtractionProfile: string | null;
  /** The settings shell's read-modify-write channel: mutate + persist in
   * one step; resolves with the refusal message or null on success. */
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
};

export function ExtractionModelSelect({
  provider,
  memoryExtractionProfile,
  onCommit,
}: ExtractionModelSelectProps) {
  const intl = useIntl();
  // The pending pick (a select key); null = display the persisted value.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = provider.profiles;
  const persistedKey = keyForProfile(memoryExtractionProfile, options);
  const displayedKey = draft ?? persistedKey;
  const hasDraft = draft !== null && draft !== persistedKey;

  async function save() {
    if (draft === null || busy) return;
    setBusy(true);
    try {
      const refusal = await onCommit((cfg) => ({
        ...cfg,
        memory_extraction_profile: profileFromKey(draft),
      }));
      if (refusal === null) {
        // Persisted: the prop now carries the value; drop the draft.
        setDraft(null);
        setError(null);
      } else {
        setError(refusal);
      }
    } catch (e) {
      // The channel's contract is resolve-with-refusal, but a reject must
      // not vanish (the default-runtime row's catch symmetry): the draft
      // survives and the failure renders inline.
      setError(fmtError(e, intl));
    } finally {
      setBusy(false);
    }
  }

  // The accessible name rides the row title (the DefaultRuntimeControl
  // posture: one message, two writes).
  const label = intl.formatMessage({
    id: "settings.runtime.extractionModel",
    defaultMessage: "Memory extraction model",
  });

  return (
    // A bare row: the wrapping card is the caller's group (the Runtime
    // pane's preferences card) -- this component renders its row and its
    // inline guidance/failure faces, no shell of its own.
    <SettingsRow
      title={(
        <FormattedMessage
          id="settings.runtime.extractionModel"
          defaultMessage="Memory extraction model"
        />
      )}
      description={(
        <FormattedMessage
          id="settings.runtime.extractionModelHint"
          defaultMessage="Which profile extracts memories. Cheap is fine here — follow-active bills your chat model."
        />
      )}
      action={(
        <div className="flex shrink-0 items-center gap-2">
          <Select
            value={displayedKey}
            onValueChange={(key) => {
              setDraft(key);
              setError(null);
            }}
          >
            <SelectTrigger
              className="w-48"
              aria-label={label}
              disabled={options.length === 0}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={FOLLOW_ACTIVE_KEY}>
                <FormattedMessage
                  id="settings.runtime.extractionFollowActive"
                  defaultMessage="Follow active profile"
                />
              </SelectItem>
              {options.map((profile) => (
                <SelectItem key={profile.id} value={`profile:${profile.id}`}>
                  {profile.display_name || profile.id}
                  {profile.id === provider.active_profile ? " *" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={!hasDraft || busy}
            onClick={() => void save()}
          >
            <FormattedMessage id="common.save" defaultMessage="Save" />
          </Button>
        </div>
      )}
    >
      {options.length === 0 && (
        <p className="text-muted-foreground text-xs">
          <FormattedMessage
            id="settings.runtime.extractionNoProfiles"
            defaultMessage="Add a profile above to enable extraction."
          />
        </p>
      )}
      {error && (
        <p className="settings-error text-destructive text-sm">{error}</p>
      )}
    </SettingsRow>
  );
}
