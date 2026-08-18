import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MutableRefObject,
} from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

import { listProviderProfiles } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import type { AppConfig } from "../../types/app-config";
import type {
  ProfileKeyStatus,
  ProviderConfig,
  ProviderProfile,
} from "../../types/provider";
import { bareButtonReset } from "../../lib/buttonReset";
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
import { PaneHeader } from "./settings-chrome";
import { ProviderEndpointFields } from "./ProviderEndpointFields";
import { ProviderKeyField } from "./ProviderKeyField";
import { ProviderPresetField } from "./ProviderPresetField";
import { PRESET_CUSTOM, derivePresetId, findPreset } from "./provider-presets";

// Profiles pane (ADR-0075, issue #281; ADR-0064/0065). Master-detail: the left
// column lists every profile (status dot + name + active badge); the right
// column is the selected profile's edit form.
//
// PERSISTENCE MODEL (ADR-0075 governing principle, case b): the endpoint fields
// (protocol / base_url / model + the derived preset) form ONE commit unit and
// auto-persist on BLUR (commit-on-blur) -- edit mode has NO Save button. Edits
// are buffered in a local `draft`, validated, and written via the parent's
// onCommit (read-modify-write over the latest app-config, revert-on-fail +
// inline error). Closing the view flushes the still-focused field (the parent
// calls the `flush` this pane registers on controlsRef). Structural operations
// are immediate: create commits on its bottom button (a freshly-minted profile
// is held in memory -- `addingProfile` -- and never listed until committed; its
// key can still be set first via the ADR-0064 orphan slot), delete commits on
// confirm (deleting the last profile lands the legal zero-profile state,
// ADR-0098), and set-active commits at once (mirroring the
// top-bar quick-switcher). The API-key field keeps its OWN
// immediate Set/Clear IPC (ADR-0029 -- the key never enters app-config) and does
// NOT participate in the blur / create commit.

/** The control surface this pane exposes to SettingsView so the close / ESC
 *  contract (ADR-0075) can flush a focused field, detect a dirty add-mode form
 *  (to confirm "abandon new profile"), and block close while an IPC is in
 *  flight. SettingsView reads it through a ref this pane keeps populated. */
export type ProfilesControls = {
  /** Commit the in-flight edit-mode draft (a no-op when clean or in add mode).
   *  Awaited by the parent before closing; resolves TRUE when the close may
   *  proceed, FALSE when a dirty draft failed to commit (validation or IPC
   *  error) -- the parent then stays open so the inline error stays visible. */
  flush: () => Promise<boolean>;
  /** True while in add mode with unsaved edits (parent confirms discard). */
  addDirty: boolean;
  /** Drop the in-memory new profile without committing (the confirmed discard). */
  discardAdd: () => void;
  /** True while any IPC this pane owns is in flight (blur commit / create /
   *  key / test). The parent blocks close while set. */
  busy: boolean;
  /** True while this pane's delete-confirm AlertDialog is open; the parent's
   *  window ESC handler yields to the dialog while set (ADR-0075: a confirm
   *  dialog owns window ESC). */
  dialogOpen: boolean;
};

export type ProfilesSectionProps = {
  provider: ProviderConfig;
  /** Commit a patch (optimistic); on IPC failure the parent reverts + returns
   *  the formatted error (null on success). */
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
  /** Mirror key / test IPC in-flight transitions to the parent's close guard,
   *  which outlives this pane: the field reports from its IPC finally block,
   *  which runs even after a section switch unmounts the pane, so close stays
   *  blocked until that IPC settles (ADR-0075: close blocked while ANY in-flight
   *  IPC). */
  onIpcBusy: (channel: "key" | "test", busy: boolean) => void;
  /** One-shot entry hint (issue #239): pre-select this profile for editing on
   *  mount (ColdStartHero "no key" CTA). Ignored if it no longer matches. */
  initialEditProfileId?: string;
  /** Ref this pane keeps populated with its control surface (flush / addDirty /
   *  discardAdd / busy) for the parent's close contract. */
  controlsRef: MutableRefObject<ProfilesControls | null>;
  /** When true, skip the PaneHeader -- the parent RuntimeSection owns the
   *  section-level hero (issue #489). The key-status refresh button relocates
   *  into the profile-list toolbar so the functionality stays available. */
  hideHeader?: boolean;
};

const NEW_PROFILE_DEFAULT_BASE_URL = "https://api.anthropic.com";
const NEW_PROFILE_DEFAULT_MODEL = "claude-sonnet-4-6";

function newProfileId(): string {
  return crypto.randomUUID();
}

function freshProfileSkeleton(): ProviderProfile {
  return {
    id: newProfileId(),
    display_name: "",
    protocol: "anthropic",
    base_url: NEW_PROFILE_DEFAULT_BASE_URL,
    model: NEW_PROFILE_DEFAULT_MODEL,
  };
}

/** Field-level equality (ignores id). Used to detect a dirty draft against its
 *  committed source so a clean form does not write on every blur. */
function sameEndpoint(a: ProviderProfile, b: ProviderProfile): boolean {
  return (
    a.display_name === b.display_name &&
    a.protocol === b.protocol &&
    a.base_url === b.base_url &&
    a.model === b.model
  );
}

/** Validate a profile before commit. Returns a formatted error message or null.
 *  base_url must be an http/https URL (a bad scheme is a config error the
 *  preflight would otherwise misreport as a network fault, issue #279). */
function validateProfile(p: ProviderProfile, intl: IntlShape): string | null {
  const url = p.base_url.trim();
  if (!url) {
    return intl.formatMessage({
      id: "settings.profiles.validate.baseUrlRequired",
      defaultMessage: "Base URL is required.",
    });
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return intl.formatMessage({
        id: "settings.profiles.validate.httpOnly",
        defaultMessage: "Base URL must use http or https.",
      });
    }
  } catch {
    return intl.formatMessage({
      id: "settings.profiles.validate.invalidUrl",
      defaultMessage: "Base URL is not a valid URL.",
    });
  }
  return null;
}

/** Pick the profile id to show on mount (entry hint → active → first → null). */
function pickInitialSelectedId(
  provider: ProviderConfig,
  initialEditProfileId?: string,
): string | null {
  if (initialEditProfileId && provider.profiles.some((p) => p.id === initialEditProfileId)) {
    return initialEditProfileId;
  }
  return (
    provider.profiles.find((p) => p.id === provider.active_profile)?.id ??
    provider.profiles[0]?.id ??
    null
  );
}

export function ProfilesSection({
  provider,
  onCommit,
  onIpcBusy,
  initialEditProfileId,
  controlsRef,
  hideHeader = false,
}: ProfilesSectionProps) {
  const intl = useIntl();

  // Per-profile has_key overlay (issue #153), fetched on mount + on demand.
  const [profileKeys, setProfileKeys] = useState<Record<string, ProfileKeyStatus>>({});
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);

  // Selection + mode. `selectedId` is the edit target; `addingProfile` (when
  // non-null) puts the pane in add mode (an in-memory profile not yet listed).
  const [selectedId, setSelectedId] = useState<string | null>(
    pickInitialSelectedId(provider, initialEditProfileId),
  );
  const [addingProfile, setAddingProfile] = useState<ProviderProfile | null>(null);
  // `addingProfile` is the RETAINED new-profile draft: it survives a view
  // switch (selecting a list item stashes the in-progress edits onto it and
  // leaves add mode WITHOUT dropping them; the next "New profile" restores it).
  // `addMode` is whether the add form is currently SHOWN -- the draft persists
  // even while the user browses existing profiles with addMode false.
  const [addMode, setAddMode] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  // Local editable draft for the editing target (a copy of the selected profile
  // in edit mode, or of the in-memory skeleton in add mode). Edits land here;
  // commit-on-blur / the create button write it through onCommit.
  const editingId = addMode ? (addingProfile?.id ?? null) : selectedId;
  const source = addMode ? addingProfile : (provider.profiles.find((p) => p.id === selectedId) ?? null);
  const [draft, setDraft] = useState<ProviderProfile | null>(source ? { ...source } : null);
  const [draftForId, setDraftForId] = useState<string | null>(editingId);
  const [formError, setFormError] = useState<string | null>(null);
  if (editingId !== draftForId) {
    // Reset state when the editing target changes (React's documented "adjust
    // state during render" pattern -- no set-state-in-effect). Clears a stale
    // draft + error + the rename affordance on profile switch.
    setDraftForId(editingId);
    setDraft(source ? { ...source } : null);
    setFormError(null);
    setRenaming(false);
  }

  // IPC in-flight state, lifted from the key + model atoms so a key IPC disables
  // Test and vice-versa (issue #236), and so the parent's close guard can block
  // unmount mid-flight (ADR-0029 trust root). `commitBusy` covers the pane's own
  // blur / create commits.
  const [keyBusy, setKeyBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const busy = keyBusy || testBusy || commitBusy;

  // Wrap the field busy mirrors so every transition also reaches the parent's
  // close guard, which outlives this pane (see the onIpcBusy prop). Stable so
  // the fields' reporting does not churn.
  const reportKeyBusy = useCallback(
    (isBusy: boolean) => {
      setKeyBusy(isBusy);
      onIpcBusy("key", isBusy);
    },
    [onIpcBusy],
  );
  const reportTestBusy = useCallback(
    (isBusy: boolean) => {
      setTestBusy(isBusy);
      onIpcBusy("test", isBusy);
    },
    [onIpcBusy],
  );

  // Key-overlay fetch. Mount: an effect with a cancelled guard whose state
  // updates land only in the IPC callbacks (never synchronously in the effect
  // body -- react-hooks/set-state-in-effect). Refresh (the pane header button):
  // an event handler, which MAY flip loading synchronously.
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);
  function toKeyMap(status: ProfileKeyStatus[]): Record<string, ProfileKeyStatus> {
    const map: Record<string, ProfileKeyStatus> = {};
    for (const s of status) map[s.profile_id] = s;
    return map;
  }
  useEffect(() => {
    let cancelled = false;
    listProviderProfiles()
      .then((status) => {
        if (!cancelled) setProfileKeys(toKeyMap(status));
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
  function handleRefreshKeys() {
    setKeysLoading(true);
    setKeysError(null);
    listProviderProfiles()
      .then((status) => setProfileKeys(toKeyMap(status)))
      .catch((e) => setKeysError(fmtError(e, intlRef.current)))
      .finally(() => setKeysLoading(false));
  }

  // Commit the edit-mode draft (validate → read-modify-write → revert-on-fail
  // via the parent). A no-op when clean, in add mode, or already committing.
  // Resolves TRUE when a close may proceed; FALSE when a dirty draft failed to
  // commit (validation or IPC error) so the parent's requestClose stays open on
  // the surfaced inline error instead of unmounting it.
  async function commitDraft(): Promise<boolean> {
    if (addMode || !draft || !selectedId || commitBusy) return true;
    const committed = provider.profiles.find((p) => p.id === selectedId);
    if (!committed || sameEndpoint(draft, committed)) return true;
    const validationError = validateProfile(draft, intl);
    if (validationError) {
      setFormError(validationError);
      return false;
    }
    const next = draft;
    setCommitBusy(true);
    const err = await onCommit((cfg) => ({
      ...cfg,
      provider: {
        ...cfg.provider,
        profiles: cfg.provider.profiles.map((p) => (p.id === next.id ? next : p)),
      },
    }));
    setCommitBusy(false);
    setFormError(err);
    return err === null;
  }

  // Form-level blur: commit when focus leaves the edit form (commit-on-blur).
  // `relatedTarget` inside the form = an internal focus move (no commit); null
  // (focus left the window) or outside = commit. Add mode never blur-commits
  // (its create button is the only commit path).
  function handleBlurCapture(e: FocusEvent<HTMLDivElement>) {
    if (addMode) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    void commitDraft();
  }

  async function handleCreate() {
    if (!addMode || !addingProfile || !draft || commitBusy) return;
    const validationError = validateProfile(draft, intl);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    const next = draft;
    setCommitBusy(true);
    const err = await onCommit((cfg) => ({
      ...cfg,
      provider: { ...cfg.provider, profiles: [...cfg.provider.profiles, next] },
    }));
    setCommitBusy(false);
    if (err) {
      setFormError(err);
      return;
    }
    // Committed: clear the retained draft + leave add mode, select the new
    // profile for editing.
    setAddingProfile(null);
    setAddMode(false);
    setSelectedId(next.id);
    setFormError(null);
  }

  async function handleConfirmDelete() {
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    if (!id || commitBusy) return;
    setCommitBusy(true);
    const err = await onCommit((cfg) => {
      const profiles = cfg.provider.profiles.filter((p) => p.id !== id);
      // Repoint a dangling active id at the first survivor; deleting the last
      // profile leaves null (the zero-profile state, ADR-0098 -- normalize
      // would null it on the next store, but keep the write self-consistent).
      const active =
        cfg.provider.active_profile === id
          ? (profiles[0]?.id ?? null)
          : cfg.provider.active_profile;
      return { ...cfg, provider: { profiles, active_profile: active } };
    });
    setCommitBusy(false);
    setFormError(err);
    // Deselect only on success -- a failed delete keeps the selection (and
    // the form it hosts) so the pane-bottom error has a surface to render on,
    // mirroring commitDraft's stay-put on failure.
    if (err === null && selectedId === id) setSelectedId(null);
  }

  async function handleSetActive(id: string) {
    if (id === provider.active_profile || commitBusy) return;
    setCommitBusy(true);
    const err = await onCommit((cfg) => ({
      ...cfg,
      provider: { ...cfg.provider, active_profile: id },
    }));
    setCommitBusy(false);
    setFormError(err);
  }

  // Selecting a list item. The in-progress new-profile edits are stashed onto
  // the retained draft (addingProfile) and add mode is left -- the draft is NOT
  // dropped, and the next "New profile" restores it verbatim. Plain edit mode
  // just switches. (Stash the live draft unconditionally: simpler than a
  // sameEndpoint check, and it also preserves "typed but unchanged" input.)
  function handleSelectProfile(id: string) {
    if (addMode && addingProfile && draft) setAddingProfile(draft);
    setAddMode(false);
    setSelectedId(id);
  }

  // Keep selectedId valid as the list mutates (create / delete elsewhere).
  const [validatedFor, setValidatedFor] = useState(provider);
  if (provider !== validatedFor) {
    setValidatedFor(provider);
    if (!addMode && (!selectedId || !provider.profiles.some((p) => p.id === selectedId))) {
      setSelectedId(pickInitialSelectedId(provider));
    }
  }

  // Publish the control surface to the parent's close contract. Re-published
  // every render (the closures capture fresh state); cleared on unmount so the
  // parent never reads a stale surface after the pane is left (a section switch
  // unmounts this pane -- its commit-on-blur already fired on the focus move).
  // In-flight key / test IPCs keep blocking close after unmount via the
  // transitions mirrored upward through onIpcBusy, which survive this pane.
  const addDirty = addMode && addingProfile !== null && draft !== null && !sameEndpoint(draft, addingProfile);
  useEffect(() => {
    controlsRef.current = {
      flush: commitDraft,
      addDirty,
      discardAdd: () => {
        setAddingProfile(null);
        setAddMode(false);
        setFormError(null);
      },
      busy,
      dialogOpen: confirmDeleteId !== null,
    };
    return () => {
      controlsRef.current = null;
    };
  });

  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  const derivedPreset = draft ? derivePresetId(draft) : PRESET_CUSTOM;
  const activePreset = findPreset(derivedPreset);
  const selectedStatus = draft ? profileKeys[draft.id] : undefined;
  const selectedHasKey = selectedStatus?.has_key ?? false;
  const fieldsDisabled = busy;

  const deleteTarget = confirmDeleteId
    ? provider.profiles.find((p) => p.id === confirmDeleteId)
    : undefined;
  const deleteTargetName = deleteTarget?.display_name.trim() || unnamed;

  // The key-status refresh button -- lives in the PaneHeader action slot when
  // ProfilesSection owns its header, or in the profile-list toolbar when the
  // header is hidden (issue #489: RuntimeSection owns the section-level hero).
  const refreshButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={handleRefreshKeys}
      disabled={keysLoading}
      aria-label={intl.formatMessage({
        id: "settings.profiles.refresh",
        defaultMessage: "Refresh key status",
      })}
    >
      <RefreshCw className={cn("size-4", keysLoading && "animate-spin")} aria-hidden />
    </Button>
  );

  return (
    <div>
      {!hideHeader && (
        <PaneHeader
          title={<FormattedMessage id="settings.nav.runtime" defaultMessage="Runtime" />}
          description={(
            <FormattedMessage
              id="settings.profiles.description"
              defaultMessage="Named connection endpoints. The active profile drives new turns; edits save as you move away from a field."
            />
          )}
          action={refreshButton}
        />
      )}

      <div className="profiles-master-detail gap-6">
        {/* Left: profile list (master). */}
        <div className="profiles-list flex flex-col gap-2">
          <div className="profiles-list-actions flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                // Restore a stashed draft if one survives; otherwise start a
                // fresh skeleton. Entering add mode shows it for editing.
                setAddingProfile(addingProfile ?? freshProfileSkeleton());
                setAddMode(true);
                setFormError(null);
              }}
              disabled={busy}
            >
              <Plus aria-hidden />
              <FormattedMessage id="settings.profiles.new" defaultMessage="New profile" />
            </Button>
            {hideHeader && refreshButton}
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
            <ul className="profiles-list-items m-0 flex list-none flex-col gap-1 p-0">
              {provider.profiles.map((p) => {
                const isActive = p.id === provider.active_profile;
                const pStatus = profileKeys[p.id];
                const pHasKey = pStatus?.has_key ?? false;
                const pFault = pStatus?.keychain_fault ?? null;
                const isSelected = !addMode && p.id === selectedId;
                const label = p.display_name.trim() || unnamed;
                // Status dot (ADR-0075): active+key = connected, active+no-key
                // = needs key, a keychain read fault = fault, otherwise idle.
                // Colors ride the ADR-0050 semantic tokens with the same
                // key-state pairing ADR-0067 anchored for the header badges
                // (primary teal = configured / active, warning amber = needs
                // key, destructive = fault) -- no raw palette. Conveys what the
                // old Active / Key-set badges did, compactly.
                const dotClass = pFault
                  ? "bg-destructive"
                  : isActive && pHasKey
                    ? "bg-primary"
                    : isActive
                      ? "bg-warning"
                      : "bg-muted-foreground/40";
                return (
                  <li
                    key={p.id}
                    className={cn(
                      "profiles-list-item flex items-center gap-2 rounded-md border border-transparent py-1.5 pr-1.5 pl-2",
                      isSelected && "selected border-border bg-muted",
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        bareButtonReset,
                        "profiles-list-item-select min-w-0 flex-1 cursor-pointer",
                        "flex items-center gap-2 rounded-md py-1 pr-1.5 text-sm text-foreground",
                        "hover:bg-accent",
                        "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
                      )}
                      onClick={() => handleSelectProfile(p.id)}
                      aria-current={isSelected ? "true" : undefined}
                    >
                      <span
                        className={cn("size-2 shrink-0 rounded-full", dotClass)}
                        aria-hidden
                      />
                      <span className="profiles-list-item-name truncate">{label}</span>
                      {isActive && (
                        <Badge variant="default">
                          <FormattedMessage
                            id="settings.profiles.activeBadge"
                            defaultMessage="Active"
                          />
                        </Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {keysError && <p className="text-destructive text-sm">{keysError}</p>}
        </div>

        {/* Right: edit form (detail). Wrapped for form-level commit-on-blur. */}
        <div className="profiles-edit min-w-0" onBlurCapture={handleBlurCapture}>
          {draft ? (
            <div className="grid gap-4">
              {/* Form header: name heading + pencil (edit mode) or a plain name
                  input (add mode); trash at the right (edit mode only). */}
              <div className="flex items-center justify-between gap-2">
                {addMode || renaming ? (
                  <Input
                    type="text"
                    value={draft.display_name}
                    onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                    onBlur={() => setRenaming(false)}
                    disabled={fieldsDisabled}
                    placeholder={unnamed}
                    aria-label={intl.formatMessage({
                      id: "common.displayName",
                      defaultMessage: "Display name",
                    })}
                    className="max-w-xs"
                  />
                ) : (
                  <div className="flex min-w-0 items-center gap-2">
                    <h4 className="truncate text-base font-semibold">
                      {draft.display_name.trim() || unnamed}
                    </h4>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRenaming(true)}
                      disabled={fieldsDisabled}
                      aria-label={intl.formatMessage({
                        id: "settings.profiles.rename",
                        defaultMessage: "Rename profile",
                      })}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                )}
                {!addMode && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="profiles-delete text-destructive hover:text-destructive"
                    onClick={() => setConfirmDeleteId(draft.id)}
                    disabled={fieldsDisabled}
                    aria-label={intl.formatMessage({
                      id: "common.delete",
                      defaultMessage: "Delete",
                    })}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </div>

              <ProviderPresetField
                presetId={derivedPreset}
                onSelectPreset={(p) =>
                  setDraft({
                    ...draft,
                    protocol: p.protocol,
                    base_url: p.base_url,
                    model: p.default_model,
                  })}
                disabled={fieldsDisabled}
              />

              <ProviderEndpointFields
                profile={draft}
                onUpdate={(patch) => setDraft({ ...draft, ...patch })}
                showProtocolRadio={derivedPreset === PRESET_CUSTOM}
                disabled={fieldsDisabled}
                onBusyChange={reportTestBusy}
              />

              <ProviderKeyField
                profileId={draft.id}
                hasKey={selectedHasKey}
                onKeyStatusChange={(hasKey) =>
                  setProfileKeys((prev) => ({
                    ...prev,
                    [draft.id]: {
                      profile_id: draft.id,
                      has_key: hasKey,
                      keychain_fault: null,
                    },
                  }))}
                getKeyLink={activePreset?.get_key_link ?? null}
                keyPlaceholder={activePreset?.key_placeholder ?? ""}
                showBadge={false}
                disabled={fieldsDisabled}
                onBusyChange={reportKeyBusy}
              />

              {addMode ? (
                <div className="flex justify-end">
                  <Button type="button" onClick={() => void handleCreate()} disabled={busy}>
                    <FormattedMessage
                      id="settings.profiles.create"
                      defaultMessage="Create profile"
                    />
                  </Button>
                </div>
              ) : draft.id === provider.active_profile ? (
                <p className="text-muted-foreground text-sm">
                  <FormattedMessage
                    id="settings.profiles.activeHint"
                    defaultMessage="This is the active profile used for new turns."
                  />
                </p>
              ) : (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleSetActive(draft.id)}
                    disabled={busy}
                  >
                    <FormattedMessage id="settings.profiles.setActive" defaultMessage="Set as active" />
                  </Button>
                </div>
              )}

            </div>
          ) : provider.profiles.length > 0 ? (
            <p className="text-muted-foreground text-sm">
              <FormattedMessage
                id="settings.profiles.selectPrompt"
                defaultMessage="Select a profile on the left to edit it, or create a new one."
              />
            </p>
          ) : null}
          {/* Commit failures render at the pane bottom regardless of the
              right pane's mode (draft form, select prompt, or zero-profile
              empty state) -- a failed delete keeps no draft of its own, so
              the error must not live inside the draft branch. */}
          {formError && <p className="text-destructive text-sm">{formError}</p>}
        </div>
      </div>

      {/* Delete confirmation (commit-on-confirm, ADR-0075). The copy no longer
          says "takes effect when you save" -- delete persists immediately.
          While open it owns window ESC (the parent's handler yields via
          dialogOpen on controlsRef); ESC / overlay dismissal = cancel. */}
      {confirmDeleteId && (
        <AlertDialog
          defaultOpen
          onOpenChange={(open) => {
            if (!open) setConfirmDeleteId(null);
          }}
        >
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
                  defaultMessage="This permanently removes “{name}”. The active profile switches to the next remaining one, or none if this was the last."
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
                onClick={() => void handleConfirmDelete()}
              >
                <FormattedMessage
                  id="common.delete"
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
