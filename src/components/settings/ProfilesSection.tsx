import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type MutableRefObject,
} from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import { listProviderProfiles, setProfileKey } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { findActiveProfile } from "../../lib/findActiveProfile";
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
import { Label } from "../ui/label";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";
import { ProviderEndpointFields } from "./ProviderEndpointFields";
import { ProviderKeyField } from "./ProviderKeyField";
import { ProviderPresetField } from "./ProviderPresetField";
import { PRESET_CUSTOM, derivePresetId, findPreset } from "./provider-presets";

// Profiles pane (ADR-0075, issue #281; ADR-0064/0065). Master-detail: the left
// column lists every profile (status dot + name + active badge) inside a
// bordered card; the right column is the selected profile's edit form -- the
// same SettingsCard / SettingsRow chrome every other settings pane rides, so
// add + edit share ONE row shape (name, preset, protocol, base URL, model,
// API key) above a single action bar.
//
// PERSISTENCE MODEL (ADR-0075 governing principle, case b): the endpoint fields
// (protocol / base_url / model + the derived preset) form ONE commit unit and
// auto-persist on BLUR (commit-on-blur) -- edit mode has NO Save button. Edits
// are buffered in a local `draft`, validated, and written via the parent's
// onCommit (read-modify-write over the latest app-config, revert-on-fail +
// inline error). Closing the view flushes the still-focused field (the parent
// calls the `flush` this pane registers on controlsRef). Structural operations
// are immediate: create commits on its bottom button (a freshly-minted profile
// is held in memory -- `addingProfile` -- and never listed until committed; a
// key typed in add mode is BUFFERED (`draftKey`) and written to the keychain
// together with the create, so a discarded add never leaves a keychain entry
// for a profile that was never created), delete commits on
// confirm (deleting the last profile lands the legal zero-profile state,
// ADR-0098), and set-active commits at once (mirroring the
// top-bar quick-switcher). In EDIT mode the API-key field keeps its OWN
// immediate Set/Clear IPC (ADR-0029 -- the key never enters app-config) and does
// NOT participate in the blur / create commit; in ADD mode it rides the create
// flow (profile commit first, key write second -- a failed commit never
// touches the keychain, and a failed key write leaves the created profile
// selected with the error surfaced for an edit-mode retry).

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
  /** True while a modal layer this pane owns is open: the delete-confirm
   *  AlertDialog OR one of the form's portalized Select listboxes. The
   *  parent's window ESC handler yields while set (ADR-0075: an open layer
   *  owns window ESC -- Radix's Select consumes Escape with preventDefault
   *  only, never stopPropagation, so a dropdown's ESC must not close the
   *  whole view). */
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

/** A field-scoped validation error (issue #735): rendered at the offending
 *  field's row (driving its aria-invalid), unlike the pane-bottom formError
 *  which stays reserved for submit-level failures (IPC / delete / key write)
 *  that have no field to attach to. */
type FieldError = {
  field: "base_url" | "model";
  message: string;
};

/** Validate a profile before commit. Returns the first field error or null.
 *  base_url must be an http/https URL (a bad scheme is a config error the
 *  preflight would otherwise misreport as a network fault, issue #279).
 *  model must be non-blank after trim (issue #735: an empty model is a
 *  deterministic config error -- the turn path sends it verbatim and the
 *  endpoint answers 400 -- so the commit boundary refuses it up front). */
function validateProfile(p: ProviderProfile, intl: IntlShape): FieldError | null {
  const url = p.base_url.trim();
  if (!url) {
    return {
      field: "base_url",
      message: intl.formatMessage({
        id: "settings.profiles.validate.baseUrlRequired",
        defaultMessage: "Base URL is required.",
      }),
    };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        field: "base_url",
        message: intl.formatMessage({
          id: "settings.profiles.validate.httpOnly",
          defaultMessage: "Base URL must use http or https.",
        }),
      };
    }
  } catch {
    return {
      field: "base_url",
      message: intl.formatMessage({
        id: "settings.profiles.validate.invalidUrl",
        defaultMessage: "Base URL is not a valid URL.",
      }),
    };
  }
  if (!p.model.trim()) {
    return {
      field: "model",
      message: intl.formatMessage({
        id: "settings.profiles.validate.modelRequired",
        defaultMessage: "Model is required.",
      }),
    };
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
    findActiveProfile(provider)?.id ?? provider.profiles[0]?.id ?? null
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
  const nameInputId = useId();

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
  // The API key typed during add mode. Buffered (never IPC'd) until the create
  // commits the profile -- see the pane header comment. Stashed alongside the
  // retained `addingProfile` draft so a browse-away and back keeps it.
  const [draftKey, setDraftKey] = useState("");

  // Local editable draft for the editing target (a copy of the selected profile
  // in edit mode, or of the in-memory skeleton in add mode). Edits land here;
  // commit-on-blur / the create button write it through onCommit.
  const editingId = addMode ? (addingProfile?.id ?? null) : selectedId;
  const source = addMode ? addingProfile : (provider.profiles.find((p) => p.id === selectedId) ?? null);
  const [draft, setDraft] = useState<ProviderProfile | null>(source ? { ...source } : null);
  const [draftForId, setDraftForId] = useState<string | null>(editingId);
  const [formError, setFormError] = useState<string | null>(null);
  // Field-scoped validation error (issue #735) -- see FieldError. formError
  // stays reserved for submit-level failures.
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  // Whether one of the form's Radix Selects currently holds focus in its
  // portalized option list. The listbox renders OUTSIDE this pane's DOM subtree,
  // so a focus move into it trips the form-level blur capture; commit-on-blur
  // holds back while a select is open (the selection lands via onValueChange,
  // and the closing focus-return re-arms the capture). A boolean suffices --
  // opening one Select closes the other (Radix's focus model) -- and the
  // editing-target reset below clears a stale true left by a Select that
  // unmounted mid-open (onOpenChange(false) never fires on unmount).
  const [selectOpen, setSelectOpen] = useState(false);
  if (editingId !== draftForId) {
    // Reset state when the editing target changes (React's documented "adjust
    // state during render" pattern -- no set-state-in-effect). Clears a stale
    // draft + error on profile switch, and re-arms the select-open guard (a
    // Select unmounted mid-open never reports its close).
    setDraftForId(editingId);
    setDraft(source ? { ...source } : null);
    setFormError(null);
    setFieldError(null);
    setSelectOpen(false);
  }

  // IPC in-flight state, lifted from the key + model atoms so a key IPC disables
  // Test and vice versa (issue #236), and so the parent's close guard can block
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
    if (!committed || sameEndpoint(draft, committed)) {
      // A draft identical to its committed source makes any field error stale
      // -- the value the error described is gone. Clear it here: this early
      // return otherwise skips the clearing further down, so a bad edit that
      // reported a field error and was then reverted kept its red field after
      // the follow-up blur.
      setFieldError(null);
      return true;
    }
    const validationError = validateProfile(draft, intl);
    if (validationError) {
      setFieldError(validationError);
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
    // A validation-passing commit clears the field error even when the IPC
    // failed -- the remaining failure is submit-level (formError), and the
    // field itself is valid as typed.
    if (err === null) setFieldError(null);
    return err === null;
  }

  // Form-level blur: commit when focus leaves the edit form (commit-on-blur).
  // `relatedTarget` inside the form = an internal focus move (no commit); null
  // (focus left the window) or outside = commit. Add mode never blur-commits
  // (its create button is the only commit path). An open Select (focus parked in
  // its portalized listbox) and an open delete-confirm dialog are NOT focus
  // exits -- both hold back the commit (see selectOpen).
  function handleBlurCapture(e: FocusEvent<HTMLDivElement>) {
    if (addMode || selectOpen || confirmDeleteId !== null) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    void commitDraft();
  }

  function handleEnterAddMode() {
    // Restore a stashed draft if one survives; otherwise start a fresh
    // skeleton. Entering add mode shows it for editing; a fresh start clears
    // the drafted key (a stashed-draft restore keeps it -- the key belongs to
    // the same in-progress add as the stashed endpoint).
    if (!addingProfile) setDraftKey("");
    setAddingProfile(addingProfile ?? freshProfileSkeleton());
    setAddMode(true);
    setFormError(null);
    setFieldError(null);
  }

  // Drop the retained add draft entirely: the draft profile, the buffered
  // key, and any form error. Shared by the explicit Cancel and the parent's
  // close-time discard contract -- both mean "abandon this add".
  function dropAddDraft() {
    setAddingProfile(null);
    setAddMode(false);
    setDraftKey("");
    setFormError(null);
    setFieldError(null);
  }

  // Explicit Cancel in add mode: the click IS the discard intent, so the
  // retained draft drops without the close-time confirm (the parent's discard
  // contract covers the implicit paths -- close / nav-away).
  function handleCancelAdd() {
    dropAddDraft();
  }

  async function handleCreate() {
    if (!addMode || !addingProfile || !draft || commitBusy) return;
    const validationError = validateProfile(draft, intl);
    if (validationError) {
      setFieldError(validationError);
      return;
    }
    const next = draft;
    const keyToWrite = draftKey.trim();
    setCommitBusy(true);
    if (keyToWrite) reportKeyBusy(true);
    const err = await onCommit((cfg) => ({
      ...cfg,
      provider: { ...cfg.provider, profiles: [...cfg.provider.profiles, next] },
    }));
    if (err) {
      setCommitBusy(false);
      if (keyToWrite) reportKeyBusy(false);
      setFormError(err);
      return;
    }
    // Profile committed. NOW write the drafted key (ADR-0029 one-shot IPC),
    // deliberately AFTER the commit: reversed order would strand an orphaned
    // keychain entry when the commit fails -- the exact state the buffered
    // draft exists to avoid. A failed key write here keeps the (already
    // created) profile selected and surfaces the error; the user retries via
    // the edit-mode Update key.
    let keyErr: string | null = null;
    if (keyToWrite) {
      try {
        const hasKey = await setProfileKey(next.id, keyToWrite);
        setProfileKeys((prev) => ({
          ...prev,
          [next.id]: { profile_id: next.id, has_key: hasKey, keychain_fault: null },
        }));
      } catch (e) {
        keyErr = fmtError(e, intl);
      } finally {
        reportKeyBusy(false);
      }
    }
    setCommitBusy(false);
    // Committed: clear the retained draft + drafted key, leave add mode,
    // select the new profile for editing.
    setAddingProfile(null);
    setAddMode(false);
    setDraftKey("");
    setSelectedId(next.id);
    setFormError(keyErr);
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
  // The buffered key counts as an unsaved edit too: a fresh skeleton is fully
  // valid, so a key-only add would otherwise bypass the discard confirm and
  // silently drop the typed key on close.
  const addDirty =
    addMode && addingProfile !== null && draft !== null &&
    (!sameEndpoint(draft, addingProfile) || draftKey.trim() !== "");
  useEffect(() => {
    controlsRef.current = {
      flush: commitDraft,
      addDirty,
      discardAdd: dropAddDraft,
      busy,
      dialogOpen: confirmDeleteId !== null || selectOpen,
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
        <div className="profiles-list flex flex-col gap-3">
          <div className="profiles-list-actions flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleEnterAddMode}
              disabled={busy}
            >
              <Plus aria-hidden />
              <FormattedMessage id="settings.profiles.new" defaultMessage="New profile" />
            </Button>
            {hideHeader && refreshButton}
          </div>

          <SettingsCard className="profiles-list-card p-1">
            {keysLoading ? (
              <p className="text-muted-foreground px-2 py-3 text-sm">
                <FormattedMessage id="settings.reading" defaultMessage="Reading current config…" />
              </p>
            ) : provider.profiles.length === 0 ? (
              <p className="text-muted-foreground px-2 py-3 text-sm">
                <FormattedMessage
                  id="settings.profiles.empty"
                  defaultMessage="No profiles yet. Click “New profile” to add one."
                />
              </p>
            ) : (
              <ul className="profiles-list-items m-0 flex list-none flex-col gap-0.5 p-0">
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
                    <li key={p.id} className="profiles-list-item">
                      <button
                        type="button"
                        className={cn(
                          bareButtonReset,
                          "profiles-list-item-select w-full cursor-pointer",
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground",
                          "hover:bg-accent/50",
                          "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
                          isSelected && "selected bg-accent",
                        )}
                        onClick={() => handleSelectProfile(p.id)}
                        aria-current={isSelected ? "true" : undefined}
                      >
                        <span
                          className={cn("size-2 shrink-0 rounded-full", dotClass)}
                          aria-hidden
                        />
                        <span className="profiles-list-item-name min-w-0 flex-1 truncate text-left">
                          {label}
                        </span>
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
          </SettingsCard>
          {keysError && <p className="text-destructive text-sm">{keysError}</p>}
        </div>

        {/* Right: edit form (detail). Wrapped for form-level commit-on-blur. */}
        <div className="profiles-edit min-w-0" onBlurCapture={handleBlurCapture}>
          {draft ? (
            <SettingsCard>
              <SettingsRow
                dense
                title={(
                  <Label htmlFor={nameInputId} className="text-muted-foreground">
                    <FormattedMessage
                      id="common.displayName"
                      defaultMessage="Display name"
                    />
                  </Label>
                )}
              >
                <Input
                  id={nameInputId}
                  type="text"
                  value={draft.display_name}
                  onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                  disabled={fieldsDisabled}
                  placeholder={unnamed}
                />
              </SettingsRow>

              <ProviderPresetField
                presetId={derivedPreset}
                onSelectPreset={(p) =>
                  setDraft({
                    ...draft,
                    protocol: p.protocol,
                    base_url: p.base_url,
                    model: p.default_model,
                  })}
                onSelectCustom={() =>
                  // Enter hand-fill mode: the openai-compatible protocol with
                  // a cleared base_url the user must type (the commit-time
                  // validation enforces it). model survives -- a wrong model
                  // is cheaper to overwrite than a typed endpoint.
                  setDraft({ ...draft, protocol: "openai", base_url: "" })}
                disabled={fieldsDisabled}
                onOpenChange={setSelectOpen}
              />

              <ProviderEndpointFields
                profile={draft}
                onUpdate={(patch) => setDraft({ ...draft, ...patch })}
                showProtocolRadio={derivedPreset === PRESET_CUSTOM}
                disabled={fieldsDisabled}
                onBusyChange={reportTestBusy}
                onModelSelectOpenChange={setSelectOpen}
                // Add mode carries the buffered draft key into the probe
                // (issue #735): the profile has no keychain entry yet, so the
                // one-shot key is the only key a pre-create probe can reach.
                probeKey={addMode ? draftKey : undefined}
                baseUrlError={fieldError?.field === "base_url" ? fieldError.message : null}
                modelError={fieldError?.field === "model" ? fieldError.message : null}
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
                // Add mode buffers the key into draftKey (written by
                // handleCreate); edit mode keeps the immediate Set/Clear IPC.
                draftMode={
                  addMode ? { value: draftKey, onChange: setDraftKey } : undefined
                }
              />

              {/* Action bar: destructive left, contextual primary right. Add
                  mode commits via Create (never blur); edit mode commits on
                  blur and only structural ops live here. */}
              <div className="flex items-center gap-2 px-4 py-3">
                {!addMode && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDeleteId(draft.id)}
                    disabled={fieldsDisabled}
                    aria-label={intl.formatMessage({
                      id: "common.delete",
                      defaultMessage: "Delete",
                    })}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    <FormattedMessage id="common.delete" defaultMessage="Delete" />
                  </Button>
                )}
                <div className="flex-1" />
                {addMode ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={handleCancelAdd}
                      disabled={busy}
                    >
                      <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
                    </Button>
                    <Button type="button" onClick={() => void handleCreate()} disabled={busy}>
                      <FormattedMessage
                        id="settings.profiles.create"
                        defaultMessage="Create profile"
                      />
                    </Button>
                  </>
                ) : draft.id === provider.active_profile ? (
                  <p className="text-muted-foreground text-xs">
                    <FormattedMessage
                      id="settings.profiles.activeHint"
                      defaultMessage="This is the active profile used for new turns."
                    />
                  </p>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleSetActive(draft.id)}
                    disabled={busy}
                  >
                    <FormattedMessage id="settings.profiles.setActive" defaultMessage="Set as active" />
                  </Button>
                )}
              </div>
            </SettingsCard>
          ) : provider.profiles.length > 0 ? (
            <div className="bg-card text-muted-foreground rounded-lg border px-4 py-10 text-center text-sm">
              <FormattedMessage
                id="settings.profiles.selectPrompt"
                defaultMessage="Select a profile on the left to edit it, or create a new one."
              />
            </div>
          ) : null}
          {/* SUBMIT-level failures render at the pane bottom regardless of the
              right pane's mode (draft form, select prompt, or zero-profile
              empty state) -- a failed delete keeps no draft of its own, so
              the error must not live inside the draft branch. Field-level
              validation errors instead render at their field (issue #735,
              see fieldError) -- this surface no longer doubles for them. */}
          {formError && <p className="settings-error mt-3 text-destructive text-sm">{formError}</p>}
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
