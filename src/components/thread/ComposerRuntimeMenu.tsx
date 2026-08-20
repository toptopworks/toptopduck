import type { ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ProfileKeyStatus, ProviderConfig } from "../../types/provider";
import type { AdapterEntry, SessionRuntimeChoice } from "../../types/runtime";
import { Select, SelectContent, SelectTrigger, SelectValue } from "../ui/select";

// The two-level runtime selector menu body (ADR-0099 Decision 2, split out of
// ComposerProviderPicker, issue #592): level 1 mirrors the Settings runtime
// sub-tab names as radio-style group rows; level 2 is one Select per group --
// the profiles under API Access, the detected CLIs under Local CLI. Pure
// selector -- all configuration actions live in Settings (ADR-0099 Decision 1);
// the only navigation out is the Manage runtimes footer affordance. The picker
// owns the queries and write paths; this module renders the popover content
// from the resolved data and forwards gestures through its callbacks.

// The two level-2 selects' shared trigger classes: indented under the level-1
// group row and inset to the remaining width (the dot column).
const LEVEL2_SELECT_TRIGGER_CLASS =
  "ml-6 w-[calc(100%-1.5rem)] border-border bg-card hover:bg-muted";

export type ComposerRuntimeMenuProps = {
  // Whether the session runs an external adapter (the Local CLI group is the
  // selected side; a profile pick under API Access reverts the runtime).
  isExternal: boolean;
  // The runtime-write window guard: the level-1 rows and both Selects
  // disable while a set IPC is in flight.
  switching: boolean;
  // The non-secret provider config (profiles list + active id), read-only
  // here like in the picker.
  provider: ProviderConfig;
  // Per-profile has_key overlay (the option-row marks, ADR-0019/0099) + the
  // overlay read's failure line.
  profileKeys: Record<string, ProfileKeyStatus>;
  keysError: string | null;
  // Only the DETECTED adapter rows render (issue #490).
  adapters: AdapterEntry[];
  activeAdapterId: string | null;
  // The session's external adapter is no longer detected (issue #490): the
  // warning line + the disabled synthetic option.
  activeAdapterStale: boolean;
  // Commit a new active_profile id (the picker's onSwitchActive pass-through).
  onSwitchActive: (id: string) => void;
  // Write a runtime choice (in-session IPC or the cold-start pending channel,
  // whichever the picker owns for this render). The in-session form is an
  // async IPC write; call sites fire-and-forget it (the picker's own
  // implementation never rejects).
  onSelectRuntime: (next: SessionRuntimeChoice) => void | Promise<void>;
  // Level-1 "Local CLI" click with no external runtime held: select the first
  // detected CLI so the group header is itself an operable radio target.
  onSelectLocalCliGroup: () => void;
  // The popover-footer affordance: close the popover, then open Settings →
  // Runtime (ADR-0091, issue #490).
  onManageRuntimes: () => void;
};

export function ComposerRuntimeMenu({
  isExternal,
  switching,
  provider,
  profileKeys,
  keysError,
  adapters,
  activeAdapterId,
  activeAdapterStale,
  onSwitchActive,
  onSelectRuntime,
  onSelectLocalCliGroup,
  onManageRuntimes,
}: ComposerRuntimeMenuProps) {
  const intl = useIntl();

  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  const noProfiles = provider.profiles.length === 0;
  const notConfigured = intl.formatMessage({
    id: "composer.providerPicker.notConfigured",
    defaultMessage: "Not configured",
  });

  // Level-2 select aria labels (each Select announces its dimension) + the
  // honest empty-CLI placeholder.
  const profileSelectAria = intl.formatMessage({
    id: "composer.runtimePicker.profileSelectAria",
    defaultMessage: "API profile",
  });
  const cliSelectAria = intl.formatMessage({
    id: "composer.runtimePicker.cliSelectAria",
    defaultMessage: "Local CLI",
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
    id: "settings.profiles.keychainUnavailable",
    defaultMessage: "Keychain unavailable",
  });

  // The synthetic option for a held adapter the detected table no longer
  // offers (issue #490): keeps the closed CLI select's echo honest (a value
  // with no matching item would echo blank) while staying unselectable.
  const staleAdapterOption =
    activeAdapterStale && activeAdapterId != null
      ? {
          value: activeAdapterId,
          label: intl.formatMessage(
            {
              id: "composer.runtimePicker.unrepresentedAdapter",
              defaultMessage: "{id} (no longer detected)",
            },
            { id: activeAdapterId },
          ),
        }
      : null;

  return (
    <div className="grid gap-1.5">
      {/* --- Level 1 + 2: API Access (= the built-in runtime) --------- */}
      <section className="grid gap-1">
        <RuntimeGroupRow
          selected={!isExternal}
          disabled={switching}
          onClick={() => void onSelectRuntime({ kind: "built_in" })}
        >
          <FormattedMessage
            id="settings.runtime.tab.apiAccess"
            defaultMessage="API Access"
          />
        </RuntimeGroupRow>
        {/* Level 2: the profile Select. A pick switches active_profile
            (global semantics unchanged) AND reverts the runtime to
            built-in when an external adapter was active -- picking a
            profile IS picking the built-in runtime. The keyless /
            keychain-fault marks ride the option rows (dropdown-only,
            never echoed in the trigger; ADR-0019/0099). Zero profiles:
            the honest "Not configured" placeholder, nothing to switch
            (ADR-0098 D1). */}
        {noProfiles ? (
          <p className="text-muted-foreground ml-6 px-2 py-1.5 text-sm">
            {notConfigured}
          </p>
        ) : (
          // Permanently controlled ("" = the placeholder state):
          // toggling between a value and undefined would flip Radix
          // between controlled and uncontrolled, and a switch back
          // would re-echo the stale internal value.
          <Select
            value={provider.active_profile ?? ""}
            onValueChange={(id) => {
              onSwitchActive(id);
              if (isExternal) void onSelectRuntime({ kind: "built_in" });
            }}
            disabled={switching}
          >
            <SelectTrigger
              aria-label={profileSelectAria}
              className={LEVEL2_SELECT_TRIGGER_CLASS}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider.profiles.map((p) => {
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
                    value={p.id}
                    label={p.display_name.trim() || unnamed}
                    mark={mark ?? undefined}
                    title={status?.keychain_fault ?? undefined}
                  />
                );
              })}
            </SelectContent>
          </Select>
        )}
        {keysError && <p className="text-destructive px-2 text-xs">{keysError}</p>}
      </section>

      <div className="border-t border-border" />

      {/* --- Level 1 + 2: Local CLI (= the external runtime) ---------- */}
      <section className="grid gap-1">
        <RuntimeGroupRow
          selected={isExternal}
          disabled={switching}
          onClick={onSelectLocalCliGroup}
        >
          <FormattedMessage
            id="settings.runtime.tab.localCli"
            defaultMessage="Local CLI"
          />
        </RuntimeGroupRow>
        {activeAdapterStale && (
          <p className="text-destructive px-2 pb-1 text-xs">
            <FormattedMessage
              id="composer.runtimePicker.staleAdapter"
              defaultMessage="Selected adapter is no longer detected — pick another or manage in settings."
            />
          </p>
        )}
        {/* Level 2: the CLI Select. Only detected adapters are offered;
            a held adapter the detected table no longer offers surfaces
            as a disabled synthetic option so the closed trigger's echo
            stays honest (issue #490). No detected CLI: the honest
            "None detected" placeholder. */}
        {/* Permanently controlled ("" = the placeholder state): an
            undefined value would make Radix fall back to its internal
            (uncontrolled) state, so switching back to built-in within
            one popover visit would keep echoing the previous adapter
            while level 1 already shows API Access selected. */}
        <Select
          value={activeAdapterId ?? ""}
          onValueChange={(id) =>
            void onSelectRuntime({ kind: "external", data: id })}
          disabled={switching}
        >
          <SelectTrigger
            aria-label={cliSelectAria}
            className={LEVEL2_SELECT_TRIGGER_CLASS}
          >
            <SelectValue
              placeholder={adapters.length === 0 ? noCliDetected : "—"}
            />
          </SelectTrigger>
          <SelectContent>
            {staleAdapterOption != null && (
              <RuntimeSelectItem
                value={staleAdapterOption.value}
                label={staleAdapterOption.label}
                disabled
                muted
              />
            )}
            {adapters.map((a) => (
              <RuntimeSelectItem
                key={a.id}
                value={a.id}
                label={a.display_name}
              />
            ))}
          </SelectContent>
        </Select>
      </section>

      {/* Manage runtimes -- opens Settings → Runtime (its default
          sub-tab; ADR-0091, issue #490). A popover-footer affordance
          independent of either runtime group, seated at the right
          edge. */}
      <div className="border-t border-border" />
      <button
        type="button"
        onClick={onManageRuntimes}
        className="inline-flex items-center gap-0.5 justify-self-end text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <FormattedMessage
          id="composer.runtimePicker.manageRuntimes"
          defaultMessage="Manage runtimes"
        />
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

// One level-1 runtime group row (ADR-0099 Decision 2): the radio-style dot +
// the group label as a full-row button. aria-pressed carries the selection
// state for assistive tech (the dot itself is aria-hidden).
function RuntimeGroupRow({
  selected,
  disabled,
  onClick,
  children,
}: {
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium cursor-pointer hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      <RuntimeDot selected={selected} />
      {children}
    </button>
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

// A SelectPrimitive.Item variant for the two level-2 selects: the label
// alone rides ItemText (the closed trigger's echo source); the optional
// key-status mark sits as a sibling -- dropdown-only, never echoed in the
// trigger. Uses SelectPrimitive.Item directly instead of the shared
// SelectItem wrapper, which places ALL children inside ItemText and cannot
// express the mark slot (the AuthModeItem pattern).
type RuntimeSelectItemProps = {
  value: string;
  label: string;
  /** Dropdown-only trailing mark (the keyless / keychain-fault note). */
  mark?: string;
  /** Hover text for the mark (the keychain fault detail). */
  title?: string;
  disabled?: boolean;
  /** Renders the label in the muted tone (the stale synthetic option). */
  muted?: boolean;
};

function RuntimeSelectItem({
  value,
  label,
  mark,
  title,
  disabled = false,
  muted = false,
}: RuntimeSelectItemProps) {
  return (
    <SelectPrimitive.Item
      value={value}
      disabled={disabled}
      className={cn(
        "focus:bg-accent hover:bg-accent relative flex items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none",
        "focus:text-accent-foreground",
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
    </SelectPrimitive.Item>
  );
}
