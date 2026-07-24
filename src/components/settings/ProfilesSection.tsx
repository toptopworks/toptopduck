import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { listProviderProfiles } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import type { ProviderConfig, ProviderProfile } from "../../types/provider";
import { cn } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ProviderEndpointFields } from "./ProviderEndpointFields";
import { ProviderKeyField } from "./ProviderKeyField";
import { ProviderPresetField } from "./ProviderPresetField";
import { PRESET_CUSTOM, derivePresetId, findPreset } from "./provider-presets";

// Profiles pane (issue #153, ADR-0064/0065). Master-detail: the left column
// lists every profile (display name + active badge + has_key badge), the right
// column is the selected profile's edit form. The form is composed of three DRY
// field atoms (issue #235, ADR-0071 Consequences): ProviderPresetField (the
// endpoint template picker) + ProviderEndpointFields (protocol/base_url/model)
// + ProviderKeyField (key input + set/clear + badge). CRUD mutates the
// `provider` config held by the parent (SettingsView) -- those changes land on
// Save as one atomic app-config write. Key set/clear is IMMEDIATE (a one-shot
// IPC into the OS keychain, ADR-0029) -- it never rides the app-config write,
// since the key must never enter app-config. The frontend learns only booleans.
//
// ProfileId stability (ADR-0064): the id is minted client-side (UUID, in the
// parent's createProfile) and never edited here -- only display_name + the
// endpoint fields are editable. A profile minted but not yet saved is a valid
// key target: set_profile_key lands in its `key-<id>` slot before Save, and the
// profile's later Save references it. If the user cancels after setting a key
// on an unsaved profile, the keychain entry is an orphan -- ADR-0064 sanctions
// this (harmless; the id is never referenced again).

/** The prop slice the Profiles pane receives from SettingsView. The provider
 *  config + its mutators come from the parent (one atomic Save commits them);
 *  the key overlay + key IPC live inside the key field atom (key never enters the
 *  shared form state, ADR-0029/0038). */
export interface ProfilesSectionProps {
  provider: ProviderConfig;
  /** Immutable update of one profile's fields by id (coding-style: never mutate). */
  updateProfile: (id: string, patch: Partial<ProviderProfile>) => void;
  /** Mint a new profile (stable UUID id), append it, return the new id so this
   *  component can auto-select it for editing. */
  createProfile: () => string;
  /** Remove a profile from the list by id (local state; committed on Save). */
  deleteProfile: (id: string) => void;
  /** Set the active profile id (which profile drives new turns). */
  setActiveProfile: (id: string) => void;
  /** Disable field edits while the parent is mid-Save. */
  saving: boolean;
  /** Notifies the parent when a per-profile key IPC is in flight so ESC / Back
   *  / Cancel cannot unmount this pane mid-flight -- otherwise the returned
   *  has_key would land on an unmounted component and a failure would never
   *  reach the user (ADR-0029 trust root). Optional: the pane renders without
   *  it but loses the close guard. */
  onBusyChange?: (busy: boolean) => void;
}

export function ProfilesSection({
  provider,
  updateProfile,
  createProfile,
  deleteProfile,
  setActiveProfile,
  saving,
  onBusyChange,
}: ProfilesSectionProps) {
  const intl = useIntl();

  // Per-profile has_key overlay (issue #153). Fetched once on mount via the
  // list_provider_profiles IPC; thereafter updated locally after each set/clear
  // inside ProviderKeyField (the IPC returns the new bool, reported upward via
  // onKeyStatusChange, so no re-fetch). Missing ids (a freshly-minted, unsaved
  // profile) default to false until set_profile_key returns true. This overlay
  // drives BOTH the list-level badges and the key field's has_key prop.
  const [profileKeys, setProfileKeys] = useState<Record<string, boolean>>({});
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);

  // The profile currently shown in the edit form (null when the list is empty).
  // Independent of `active_profile`: selecting for editing does not switch the
  // active profile (the user manages both explicitly).
  const [selectedId, setSelectedId] = useState<string | null>(
    provider.profiles.find((p) => p.id === provider.active_profile)?.id ??
    provider.profiles[0]?.id ??
    null,
  );
  // The profile id whose delete AlertDialog is open (null = none).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Stable ref to intl so the mount-time fetch effect can run once ([] deps)
  // instead of re-firing on an intl identity change. useIntl()'s intl is stable
  // per locale, but a locale flip while Settings is open would otherwise refetch
  // locale-independent booleans and flash keysLoading. The effect reads intl
  // through the ref for its error formatter only.
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);

  // Seed the key-status overlay once on mount. Profile RECORDS stay single-
  // sourced from the parent's provider config; this only carries the booleans.
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
      })
      .finally(() => {
        if (!cancelled) setKeysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep selectedId valid as the profiles list mutates (create/delete). If the
  // selected id was deleted (or is null once profiles exist), fall back to the
  // active profile then the first. Adjusting state during render (not in an
  // effect) is React's documented pattern for "reset state when a value changes"
  // -- it avoids the set-state-in-effect lint and never shows a stale selection.
  // The inner guard skips the setState entirely when the selection is still
  // valid, so a no-op render does not loop. https://react.dev/learn/you-might-not-need-an-effect
  const [validatedFor, setValidatedFor] = useState(provider);
  if (provider !== validatedFor) {
    setValidatedFor(provider);
    if (!selectedId || !provider.profiles.some((p) => p.id === selectedId)) {
      setSelectedId(
        provider.profiles.find((p) => p.id === provider.active_profile)?.id ??
        provider.profiles[0]?.id ??
        null,
      );
    }
  }

  const selected = provider.profiles.find((p) => p.id === selectedId) ?? null;

  // Derive the preset the selected profile's endpoint currently reflects, plus
  // its get-key link / key placeholder (Custom yields null / generic). The
  // preset id is a DERIVED view of the endpoint -- never stored (ADR-0038) -- so
  // the dropdown tracks field edits for free.
  const derivedPreset = selected ? derivePresetId(selected) : PRESET_CUSTOM;
  const activePreset = findPreset(derivedPreset);
  const selectedHasKey = selected ? profileKeys[selected.id] ?? false : false;

  function handleCreate() {
    // Auto-select the new profile so the user lands in its edit form.
    setSelectedId(createProfile());
  }

  function handleConfirmDelete() {
    if (!confirmDeleteId) return;
    deleteProfile(confirmDeleteId);
    setConfirmDeleteId(null);
  }

  const fieldsDisabled = saving;
  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  // The profile targeted by the open delete AlertDialog (undefined when no
  // confirm is open). Pre-computed so the confirm body reads a plain name
  // instead of a JSX IIFE at the render site.
  const deleteTarget = confirmDeleteId
    ? provider.profiles.find((p) => p.id === confirmDeleteId)
    : undefined;
  const deleteTargetName = deleteTarget?.display_name.trim() || unnamed;

  return (
    <div className="profiles-master-detail gap-6">
      {/* Left: profile list (master). */}
      <div className="profiles-list flex flex-col gap-2">
        <div className="profiles-list-actions flex">
          <Button type="button" onClick={handleCreate} disabled={fieldsDisabled}>
            <FormattedMessage id="settings.profiles.new" defaultMessage="New profile" />
          </Button>
        </div>
        {keysLoading ? (
          <p className="text-muted-foreground text-sm">
            <FormattedMessage id="settings.reading" defaultMessage="Reading current config…" />
          </p>
        ) : provider.profiles.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <FormattedMessage
              id="settings.profiles.empty"
              defaultMessage="No profiles yet. Click “New profile” to add one."
            />
          </p>
        ) : (
          <ul
            className="profiles-list-items list-none m-0 p-0 flex flex-col gap-1"
            aria-label={intl.formatMessage({
              id: "settings.profiles.listAria",
              defaultMessage: "Active profile",
            })}
          >
            {/* A plain list, NOT role="radiogroup": each row carries a radio
                (select active) + a button (select for edit) + a delete button,
                and ARIA's radiogroup model permits only radio descendants. The
                radios share name="profiles-active" so the browser groups them
                natively (mutually exclusive); each radio's aria-label already
                carries the profile name, so its accessible name is complete. */}
            {provider.profiles.map((p) => {
              const isActive = p.id === provider.active_profile;
              const pHasKey = profileKeys[p.id] ?? false;
              const isSelected = p.id === selectedId;
              const label = p.display_name.trim() || unnamed;
              return (
                <li
                  key={p.id}
                  // selected (issue #170 AC: rendering unchanged) lifts the
                  // border + bg tint as conditional utilities over the ADR-0050
                  // token, replacing the retired .profiles-list-item.selected
                  // CSS rule. The `selected` hook class is kept for selector /
                  // test stability alongside the utilities (Thread.tsx pattern).
                  className={cn(
                    "profiles-list-item flex items-center gap-1.5 py-1.5 px-1.5 rounded-md border border-transparent",
                    isSelected && "selected border-border bg-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="profiles-active"
                    className="profiles-active-radio m-0 shrink-0"
                    checked={isActive}
                    onChange={() => setActiveProfile(p.id)}
                    aria-label={intl.formatMessage(
                      {
                        id: "settings.profiles.setActiveAria",
                        defaultMessage: "Set “{name}” as the active profile",
                      },
                      { name: label },
                    )}
                  />
                  <button
                    type="button"
                    className={cn(
                      // Same [all:unset] + hover/focus-visible ring contract as
                      // settings-nav-button (WCAG 2.4.7 -- see there). flex-1 +
                      // min-w-0 are row-specific: share space with the radio +
                      // delete button + let the inner name truncate.
                      "profiles-list-item-select [all:unset] cursor-pointer flex-1 min-w-0",
                      "flex items-center gap-1.5 py-1 px-1.5 rounded-md text-sm text-foreground",
                      "hover:bg-accent",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    )}
                    onClick={() => setSelectedId(p.id)}
                    aria-current={isSelected ? "true" : undefined}
                  >
                    <span className="profiles-list-item-name truncate">{label}</span>
                    {isActive && (
                      <Badge variant="default">
                        <FormattedMessage
                          id="settings.profiles.activeBadge"
                          defaultMessage="Active"
                        />
                      </Badge>
                    )}
                    <Badge variant={pHasKey ? "secondary" : "outline"}>
                      {pHasKey ? (
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
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="profiles-delete"
                    onClick={() => setConfirmDeleteId(p.id)}
                    disabled={fieldsDisabled}
                  >
                    <FormattedMessage id="settings.profiles.delete" defaultMessage="Delete" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {keysError && <p className="text-destructive text-sm">{keysError}</p>}
      </div>

      {/* Right: edit form (detail). Composed of the three DRY field atoms
          (issue #235): preset picker → endpoint fields → key field. The
          display-name Input stays inline (it is identity, not endpoint). */}
      <div className="profiles-edit min-w-0">
        {selected ? (
          <div className="grid gap-4">
            <Label className="grid gap-1">
              <FormattedMessage id="settings.profiles.displayName" defaultMessage="Display name" />
              <Input
                type="text"
                value={selected.display_name}
                onChange={(e) => updateProfile(selected.id, { display_name: e.target.value })}
                disabled={fieldsDisabled}
              />
            </Label>

            <ProviderPresetField
              presetId={derivedPreset}
              onSelectPreset={(p) =>
                updateProfile(selected.id, {
                  protocol: p.protocol,
                  base_url: p.base_url,
                  model: p.default_model,
                })}
              disabled={fieldsDisabled}
            />

            <ProviderEndpointFields
              profile={selected}
              onUpdate={(patch) => updateProfile(selected.id, patch)}
              // The protocol RadioGroup shows only when the endpoint does not
              // match any preset (Custom): a named preset implies its protocol.
              showProtocolRadio={derivedPreset === PRESET_CUSTOM}
              disabled={fieldsDisabled}
            />

            <ProviderKeyField
              profileId={selected.id}
              hasKey={selectedHasKey}
              onKeyStatusChange={(hasKey) =>
                setProfileKeys((prev) => ({ ...prev, [selected.id]: hasKey }))}
              getKeyLink={activePreset?.get_key_link ?? null}
              keyPlaceholder={activePreset?.key_placeholder ?? ""}
              // The master list already shows the per-profile key badge; hide
              // the atom's inline badge here to avoid stating the same fact
              // twice on one screen.
              showBadge={false}
              disabled={saving}
              onBusyChange={onBusyChange}
            />

            {selected.id === provider.active_profile ? (
              <p className="text-muted-foreground text-sm">
                <FormattedMessage
                  id="settings.profiles.activeHint"
                  defaultMessage="This is the active profile used for new turns."
                />
              </p>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => setActiveProfile(selected.id)}
                disabled={fieldsDisabled}
              >
                <FormattedMessage id="settings.profiles.setActive" defaultMessage="Set as active" />
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            <FormattedMessage
              id="settings.profiles.selectPrompt"
              defaultMessage="Select a profile on the left to edit it, or create a new one."
            />
          </p>
        )}
      </div>

      {/* Delete confirmation (AlertDialog: destructive confirm does not dismiss
          on ESC/overlay, ADR-0065). The dialog is conditionally rendered -- the
          parent (this component) mounts/unmounts it via confirmDeleteId, so
          defaultOpen suffices (no controlled open/onOpenChange needed). Delete
          is a synchronous local-state mutation (committed on Save), so the
          action needs no preventDefault retry contract (unlike an async IPC). */}
      {confirmDeleteId && (
        <AlertDialog defaultOpen>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="settings.profiles.deleteConfirm.title"
                  defaultMessage="Delete profile?"
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.profiles.deleteConfirm.body"
                  defaultMessage="This removes “{name}” from the profile list. The change takes effect when you save settings."
                  values={{ name: deleteTargetName }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmDeleteId(null)}>
                <FormattedMessage
                  id="settings.profiles.deleteConfirm.cancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={handleConfirmDelete}
              >
                <FormattedMessage
                  id="settings.profiles.deleteConfirm.confirm"
                  defaultMessage="Delete"
                />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
