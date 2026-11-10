// The extraction-model picker (issue #1530, ADR-0147 Decision 7): which
// provider profile runs the after-turn memory extraction. A plain native
// select over the EXISTING profile pool -- the picker adds no second
// config shape, just a pointer (null = follow the active profile, the
// zero-config posture). Deliberately NOT the Radix ui/select: its items
// forbid the empty-string value the follow-active option needs as its
// null-pointer encoding. The cost note rides the workspace memory panel's
// extraction toggle instead (the "cost follows the switch" ruling), so
// this control stays label + select only.

import { useId } from "react";
import { FormattedMessage } from "react-intl";

import type { AppConfig } from "../../types/app-config";
import type { ProviderConfig } from "../../types/provider";

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
  const selectId = useId();
  const options = provider.profiles;
  const selected =
    memoryExtractionProfile !== null &&
    options.some((p) => p.id === memoryExtractionProfile)
      ? memoryExtractionProfile
      : "";

  return (
    <div className="mb-6">
      <label
        htmlFor={selectId}
        className="mb-1 block text-sm font-medium"
      >
        <FormattedMessage
          id="settings.runtime.extractionModel"
          defaultMessage="Memory extraction model"
        />
      </label>
      <p className="text-muted-foreground mb-2 text-xs">
        <FormattedMessage
          id="settings.runtime.extractionModelHint"
          defaultMessage="Which profile extracts memories. Cheap is fine here — follow-active bills your chat model."
        />
      </p>
      <select
        id={selectId}
        className="border-input bg-background h-9 w-full max-w-sm rounded-md border px-3 text-sm"
        value={selected}
        disabled={options.length === 0}
        onChange={(e) => {
          const next = e.target.value === "" ? null : e.target.value;
          void onCommit((cfg) => ({
            ...cfg,
            memory_extraction_profile: next,
          }));
        }}
      >
        {/* The follow-active option: value "" is the null pointer. A
            dangling stored pointer also renders here (the backend nulls it
            on the next normalize; the UI must not show a dead id). */}
        <option value="">
          <FormattedMessage
            id="settings.runtime.extractionFollowActive"
            defaultMessage="Follow active profile"
          />
        </option>
        {options.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.display_name || profile.id}
            {profile.id === provider.active_profile ? " *" : ""}
          </option>
        ))}
      </select>
      {options.length === 0 && (
        <p className="text-muted-foreground mt-2 text-xs">
          <FormattedMessage
            id="settings.runtime.extractionNoProfiles"
            defaultMessage="Add a profile above to enable extraction."
          />
        </p>
      )}
    </div>
  );
}
