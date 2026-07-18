import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";

import { clearProfileKey, fmtError, listProviderProfiles, setProfileKey } from "../../api";
import type { Protocol, ProviderConfig, ProviderProfile } from "../../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
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

// Profiles pane (issue #153, ADR-0064/0065). Master-detail: the left column
// lists every profile (display name + active badge + has_key badge), the right
// column is the selected profile's edit form (protocol / display_name /
// base_url / model + per-profile key set/clear). CRUD mutates the `provider`
// config held by the parent (SettingsView) -- those changes land on Save as one
// atomic app-config write. Key set/clear is IMMEDIATE (a one-shot IPC into the
// OS keychain, ADR-0029) -- it never rides the app-config write, since the key
// must never enter app-config. The frontend learns only booleans.
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
 *  the key overlay + key IPC live inside this component (key never enters the
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
}

export function ProfilesSection({
  provider,
  updateProfile,
  createProfile,
  deleteProfile,
  setActiveProfile,
  saving,
}: ProfilesSectionProps) {
  const intl = useIntl();

  // Per-profile has_key overlay (issue #153). Fetched once on mount via the
  // list_provider_profiles IPC; thereafter updated locally after each set/clear
  // (the IPC returns the new bool, so no re-fetch). Missing ids (a freshly-
  // minted, unsaved profile) default to false until set_profile_key returns true.
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
  // The key input is per-selected-profile ephemeral state; switching the
  // selection resets it (each profile has its own key).
  const [keyInput, setKeyInput] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // The profile id whose delete AlertDialog is open (null = none).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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
        if (!cancelled) setKeysError(fmtError(e, intl));
      })
      .finally(() => {
        if (!cancelled) setKeysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [intl]);

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

  // Reset the key input + its error when the edited profile changes. Each
  // profile owns its own key, so a typed-but-unset value must not leak across.
  // Same render-time "adjust state when a value changes" pattern as above.
  const [keyInputForId, setKeyInputForId] = useState(selectedId);
  if (selectedId !== keyInputForId) {
    setKeyInputForId(selectedId);
    setKeyInput("");
    setKeyError(null);
  }

  const selected = provider.profiles.find((p) => p.id === selectedId) ?? null;

  function handleCreate() {
    // Auto-select the new profile so the user lands in its edit form.
    setSelectedId(createProfile());
  }

  function handleConfirmDelete() {
    if (!confirmDeleteId) return;
    deleteProfile(confirmDeleteId);
    setConfirmDeleteId(null);
  }

  async function handleSetKey() {
    if (!selected) return;
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const hasKey = await setProfileKey(selected.id, trimmed);
      setProfileKeys((prev) => ({ ...prev, [selected.id]: hasKey }));
      setKeyInput("");
    } catch (e) {
      setKeyError(fmtError(e, intl));
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleClearKey() {
    if (!selected) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const hasKey = await clearProfileKey(selected.id);
      setProfileKeys((prev) => ({ ...prev, [selected.id]: hasKey }));
    } catch (e) {
      setKeyError(fmtError(e, intl));
    } finally {
      setKeyBusy(false);
    }
  }

  const selectedHasKey = selected ? (profileKeys[selected.id] ?? false) : false;
  const fieldsDisabled = saving;
  const keyDisabled = saving || keyBusy;
  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });

  return (
    <div className="profiles-master-detail">
      {/* Left: profile list (master). */}
      <div className="profiles-list">
        <div className="profiles-list-actions">
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
            className="profiles-list-items"
            role="radiogroup"
            aria-label={intl.formatMessage({
              id: "settings.profiles.listAria",
              defaultMessage: "Active profile",
            })}
          >
            {provider.profiles.map((p) => {
              const isActive = p.id === provider.active_profile;
              const pHasKey = profileKeys[p.id] ?? false;
              const isSelected = p.id === selectedId;
              const label = p.display_name.trim() || unnamed;
              return (
                <li
                  key={p.id}
                  className={`profiles-list-item${isSelected ? " selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="profiles-active"
                    className="profiles-active-radio"
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
                    className="profiles-list-item-select"
                    onClick={() => setSelectedId(p.id)}
                    aria-current={isSelected ? "true" : undefined}
                  >
                    <span className="profiles-list-item-name">{label}</span>
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

      {/* Right: edit form (detail). */}
      <div className="profiles-edit">
        {selected ? (
          <div className="grid gap-4">
            <fieldset className="grid gap-2 border-0 p-0 m-0">
              <legend className="text-sm font-medium">
                <FormattedMessage
                  id="settings.profiles.protocol.legend"
                  defaultMessage="Protocol"
                />
              </legend>
              <RadioGroup
                value={selected.protocol}
                onValueChange={(v) => updateProfile(selected.id, { protocol: v as Protocol })}
                disabled={fieldsDisabled}
                className="gap-2"
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`proto-anthropic-${selected.id}`} value="anthropic" />
                  <Label htmlFor={`proto-anthropic-${selected.id}`} className="font-normal">
                    <FormattedMessage
                      id="settings.profiles.protocol.anthropic"
                      defaultMessage="Anthropic (Messages API, x-api-key auth)"
                    />
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id={`proto-openai-${selected.id}`} value="openai" />
                  <Label htmlFor={`proto-openai-${selected.id}`} className="font-normal">
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

            <Label className="grid gap-1">
              <FormattedMessage id="settings.profiles.displayName" defaultMessage="Display name" />
              <Input
                type="text"
                value={selected.display_name}
                onChange={(e) => updateProfile(selected.id, { display_name: e.target.value })}
                disabled={fieldsDisabled}
              />
            </Label>

            <Label className="grid gap-1">
              <FormattedMessage id="settings.profiles.baseUrl" defaultMessage="Base URL" />
              <Input
                type="text"
                value={selected.base_url}
                onChange={(e) => updateProfile(selected.id, { base_url: e.target.value })}
                disabled={fieldsDisabled}
              />
            </Label>

            <Label className="grid gap-1">
              <FormattedMessage id="settings.profiles.model" defaultMessage="Model" />
              <Input
                type="text"
                value={selected.model}
                onChange={(e) => updateProfile(selected.id, { model: e.target.value })}
                disabled={fieldsDisabled}
              />
            </Label>

            {/* Key management (ADR-0029 one-shot transfer). The field is blank
                after a set; an empty Update is a no-op (leave-as-is). Clear is
                available only when a key is stored. */}
            <fieldset className="grid gap-2 border-0 p-0 m-0">
              <legend className="text-sm font-medium">
                <FormattedMessage
                  id="settings.profiles.key.legend"
                  defaultMessage="API key (stored only in this machine's OS keychain)"
                />
              </legend>
              <Input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={
                  selectedHasKey
                    ? intl.formatMessage({
                        id: "settings.profiles.key.placeholderSet",
                        defaultMessage: "Saved (leave blank to keep as-is)",
                      })
                    : intl.formatMessage({
                        id: "settings.profiles.key.placeholderUnset",
                        defaultMessage: "Paste key",
                      })
                }
                disabled={keyDisabled}
                autoComplete="off"
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  onClick={handleSetKey}
                  disabled={keyDisabled || !keyInput.trim()}
                >
                  {selectedHasKey ? (
                    <FormattedMessage id="settings.profiles.key.update" defaultMessage="Update key" />
                  ) : (
                    <FormattedMessage id="settings.profiles.key.set" defaultMessage="Set key" />
                  )}
                </Button>
                {selectedHasKey && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleClearKey}
                    disabled={keyDisabled}
                  >
                    <FormattedMessage id="settings.profiles.key.clear" defaultMessage="Clear key" />
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground text-sm">
                {selectedHasKey ? (
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
                {(() => {
                  const target = provider.profiles.find((p) => p.id === confirmDeleteId);
                  const name = target?.display_name.trim() || unnamed;
                  return (
                    <FormattedMessage
                      id="settings.profiles.deleteConfirm.body"
                      defaultMessage="This removes “{name}” from the profile list. The change takes effect when you save settings."
                      values={{ name }}
                    />
                  );
                })()}
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
