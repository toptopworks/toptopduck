import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ProfileKeyStatus, ProviderConfig } from "../../types/provider";
import type { AdapterEntry } from "../../types/runtime";
import { SelectContent, SelectGroup, SelectLabel, SelectSeparator } from "../ui/select";

// The runtime selector's option content (ADR-0099 Decision 2, split out of
// ComposerProviderPicker, issue #592; select-shaped): one SelectContent with
// two SelectGroups mirroring the Settings runtime sub-tab names -- the
// profiles under API Access, the detected CLIs under Local CLI -- so every
// target is one click from the open dropdown (native optgroup semantics:
// the group labels are headings, not selectable targets). The selected row's
// check rides the root Select's controlled value. Pure content -- the picker
// owns the queries, the value mapping, and the write paths, and this module
// renders the options from the resolved data. Configuration lives in
// Settings (ADR-0099 Decision 1); the only navigation out is the Manage
// runtimes trailing item.

// Sentinel option values the picker branches on in onValueChange (never
// colliding with the `profile:`/`adapter:` namespaced real choices).
export const MANAGE_RUNTIMES_VALUE = "__manage_runtimes__";
const NOT_CONFIGURED_VALUE = "__not_configured__";
const NONE_DETECTED_VALUE = "__none_detected__";

export type ComposerRuntimeMenuProps = {
  // The non-secret provider config (profiles list + active id), read-only.
  provider: ProviderConfig;
  // Per-profile has_key overlay (the option-row marks, ADR-0019/0099) + the
  // overlay read's failure line.
  profileKeys: Record<string, ProfileKeyStatus>;
  keysError: string | null;
  // Only the DETECTED adapter rows render (issue #490).
  adapters: AdapterEntry[];
  // The held adapter id (null when built-in).
  activeAdapterId: string | null;
  // The held adapter is no longer detected (issue #490): the warning line
  // + the disabled synthetic option.
  activeAdapterStale: boolean;
};

export function ComposerRuntimeMenu({
  provider,
  profileKeys,
  keysError,
  adapters,
  activeAdapterId,
  activeAdapterStale,
}: ComposerRuntimeMenuProps) {
  const intl = useIntl();

  const unnamed = intl.formatMessage({
    id: "common.profileUnnamed",
    defaultMessage: "Unnamed profile",
  });
  const noProfiles = provider.profiles.length === 0;
  const notConfigured = intl.formatMessage({
    id: "composer.providerPicker.notConfigured",
    defaultMessage: "Not configured",
  });
  const noCliDetected = intl.formatMessage({
    id: "composer.runtimePicker.noCliDetected",
    defaultMessage: "None detected",
  });
  const noKeyMark = intl.formatMessage({
    id: "composer.providerPicker.noKeyMark",
    defaultMessage: "no key",
  });
  const keychainUnavailableMark = intl.formatMessage({
    id: "composer.providerPicker.keychainUnavailable",
    defaultMessage: "Credential store unavailable",
  });
  // The synthetic option's label for a held adapter the detected table no
  // longer offers (issue #490).
  const staleAdapterLabel = intl.formatMessage(
    {
      id: "composer.runtimePicker.unrepresentedAdapter",
      defaultMessage: "{id} (no longer detected)",
    },
    { id: activeAdapterId ?? "" },
  );

  return (
    <SelectContent className="w-72">
      {/* --- API Access (= the built-in runtime) ---------------------- */}
      <SelectGroup>
        <SelectLabel>
          <FormattedMessage
            id="common.apiAccess"
            defaultMessage="API Access"
          />
        </SelectLabel>
        {noProfiles ? (
          // The honest "Not configured" placeholder, nothing to switch
          // (ADR-0098 D1).
          <RuntimeSelectItem
            value={NOT_CONFIGURED_VALUE}
            label={notConfigured}
            disabled
          />
        ) : (
          // The keyless / keychain-fault marks ride the option rows
          // (ADR-0019/0099). Picking a profile IS picking the built-in
          // runtime -- the picker's onValueChange couples the writes.
          provider.profiles.map((p) => {
            const status = profileKeys[p.id];
            const mark = status
              ? status.keychain_fault
                ? keychainUnavailableMark
                : status.has_key
                  ? null
                  : noKeyMark
              : null;
            return (
              <RuntimeSelectItem
                key={p.id}
                value={`profile:${p.id}`}
                label={p.display_name.trim() || unnamed}
                mark={mark ?? undefined}
                title={status?.keychain_fault ?? undefined}
              />
            );
          })
        )}
        {keysError && <p className="text-destructive px-2 text-xs">{keysError}</p>}
      </SelectGroup>

      <SelectSeparator />

      {/* --- Local CLI (= the external runtime) ----------------------- */}
      <SelectGroup>
        <SelectLabel>
          <FormattedMessage
            id="common.localCli"
            defaultMessage="Local CLI"
          />
        </SelectLabel>
        {activeAdapterStale && (
          <p className="text-destructive px-2 pb-1 text-xs">
            <FormattedMessage
              id="composer.runtimePicker.staleAdapter"
              defaultMessage="Selected adapter is no longer detected — pick another or manage in settings."
            />
          </p>
        )}
        {adapters.length === 0 && !activeAdapterStale && (
          // The honest "None detected" placeholder for an empty table.
          <RuntimeSelectItem
            value={NONE_DETECTED_VALUE}
            label={noCliDetected}
            disabled
          />
        )}
        {activeAdapterStale && activeAdapterId != null && (
          // The held (undetected) adapter renders as a disabled synthetic
          // row so the checked option exists -- a value with no matching
          // item would leave the dropdown with no visible selection
          // (issue #490).
          <RuntimeSelectItem
            value={`adapter:${activeAdapterId}`}
            label={staleAdapterLabel}
            disabled
            muted
          />
        )}
        {adapters.map((a) => (
          <RuntimeSelectItem
            key={a.id}
            value={`adapter:${a.id}`}
            label={a.display_name}
          />
        ))}
      </SelectGroup>

      <SelectSeparator />

      {/* Manage runtimes -- opens Settings → Runtime (its default sub-tab;
          ADR-0091, issue #490). A trailing item independent of either
          runtime group; the picker branches on the sentinel in
          onValueChange (the Select closes itself on item select). */}
      <RuntimeSelectItem
        value={MANAGE_RUNTIMES_VALUE}
        label={intl.formatMessage({
          id: "composer.runtimePicker.manageRuntimes",
          defaultMessage: "Manage runtimes",
        })}
        trailing={<ChevronRight className="size-3.5" aria-hidden />}
      />
    </SelectContent>
  );
}

// A SelectPrimitive.Item variant (the AuthModeItem pattern): the label alone
// rides ItemText (the typeahead text), the optional key-status mark and the
// trailing glyph sit as siblings -- dropdown-only, never in the typeahead
// text. Uses SelectPrimitive.Item directly instead of the shared SelectItem
// wrapper, which places ALL children inside ItemText and cannot express the
// mark slot.
type RuntimeSelectItemProps = {
  value: string;
  label: string;
  /** Trailing mark (the keyless / keychain-fault note). */
  mark?: string;
  /** Hover text for the mark (the keychain fault detail). */
  title?: string;
  disabled?: boolean;
  /** Renders the label in the muted tone (the stale synthetic option). */
  muted?: boolean;
  /** A trailing glyph (the Manage runtimes chevron). */
  trailing?: ReactNode;
};

function RuntimeSelectItem({
  value,
  label,
  mark,
  title,
  disabled = false,
  muted = false,
  trailing,
}: RuntimeSelectItemProps) {
  return (
    <SelectPrimitive.Item
      value={value}
      disabled={disabled}
      className={cn(
        // Grey = transit on every row -- same posture as the shared
        // SelectItem: the selected row is marked by the check glyph alone,
        // no committed face.
        "hover:bg-transit focus:bg-transit relative flex items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      )}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>
        <span className={cn("truncate", muted && "text-muted-foreground")}>
          {label}
        </span>
      </SelectPrimitive.ItemText>
      {mark && (
        <span
          className="text-muted-foreground ml-auto truncate text-xs"
          title={title}
        >
          {mark}
        </span>
      )}
      {trailing}
    </SelectPrimitive.Item>
  );
}
