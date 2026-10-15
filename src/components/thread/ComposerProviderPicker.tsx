import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Box } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import { findActiveProfile } from "../../lib/findActiveProfile";
import {
  getAdapterCatalogs,
  getLastModelPosture,
  getSessionModelConfig,
  getSessionRuntime,
  listAdapters,
  listProviderProfiles,
} from "../../api";
import { adapterKeys, sessionKeys } from "../../session/queryKeys";
import type { ModelPosture } from "../../types/app-config";
import type { ProfileKeyStatus, ProviderConfig } from "../../types/provider";
import type { SaveError } from "../../types/session";
import type {
  AdapterEntry,
  SessionModelConfig,
  SessionRuntimeChoice,
} from "../../types/runtime";
import { RUNTIME_CHOICE_DEFAULT } from "../../types/runtime";
import { ComposerPostureTrigger } from "./ComposerPostureTrigger";
import {
  createSessionSelectionPort,
  type ColdStartSelectionChannel,
} from "./composer-selection-write";
import {
  derivePostureCatalog,
  EMPTY_POSTURE,
  heldPostureParts,
  MODEL_CONFIG_DEFAULT,
} from "./posture-catalog";
import { ComposerRuntimeMenu } from "./ComposerRuntimeMenu";
import {
  PRESET_CUSTOM,
  derivePresetId,
  findPreset,
} from "../settings/provider-presets";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Composer runtime entry (ADR-0099, issues #353/#574; ADR-0071/0081/0085/
// 0091 lineage). TWO resident controls at the QuestionBar edge, each with one
// job:
//   - the POSTURE text button (ComposerPostureTrigger, seated first) is the
//     readout + cascade menu for the next turn's model / thought level --
//     the posture label of ADR-0099 Decision 3 / #573 (the held pair,
//     either dimension alone, or the default);
//   - the ICON trigger's popover is the ONLY runtime-switching entry:
//     two-level (level 1 "API Access" / "Local CLI" radio rows mirroring
//     the Settings runtime sub-tab names; level 2 one Select per group --
//     the profiles under API Access, the detected CLIs under Local CLI).
// Configuration actions (profile CRUD, profile.model editing, key
// management, CLI management + probing) live in Settings -- this popover is
// a pure selector (ADR-0099 Decision 1, calibrating ADR-0071's in-popover
// configuration duties into retirement).
//
// Trigger glyph: a lucide Box, the Settings runtime section's icon -- the
// unified entry glyph (NOT a provider logo; ADR-0071). Hover Tooltip: an
// honest "{provider} · {model}" preview for the built-in runtime (+ an
// honest "no key" mark when the active profile has no key, ADR-0019) or the
// external adapter name. The runtime NAME rides the tooltip; the posture
// button carries the model/level readout.
//
// Runtime state ownership: the per-session CHOICE is backend truth, read via
// `getSessionRuntime` under the session-prefix query (a close drops it with
// the rest; a resume lands the RESTORED session runtime via the fresh
// SessionPane mount -- ADR-0102 segment continuation, unlike authMode the
// runtime survives the resume; an undetected recorded adapter degrades that
// resume to built-in and a pre-#589 recipe falls back to the default
// runtime). Writes go through `setSessionRuntime` and take
// effect at the NEXT turn boundary. A rejected write keeps the server
// posture -- the picker resyncs via refetch and never shows a runtime the
// backend did not grant.
//
// Posture ownership (ADR-0095/0099/0100): in-session the model / thought
// level read via `getSessionModelConfig` and write through the set IPC
// (next-turn effective; the successful set also lands the pair on the
// adapter's app-config backfill entry server-side -- the single write
// point). On the cold-start bar (null sessionId) the displayed posture is
// the caller-held pendingModelPosture seeded from the adapter's backfill
// entry (`getLastModelPosture`); an explicit pick replaces the pending pair
// and the first submit applies it to the minted session, the same
// pending-runtime wiring as #572. The clear row additionally wipes the
// backfill entry via `clearLastModelPosture` (ADR-0100 Decision 3: without
// it, an unsubmitted clear would be re-seeded from the entry on the next
// cold-start visit).

export type ComposerProviderPickerProps = {
  // The session whose runtime this picker reads / switches. Runtime selection
  // is per-session assembly posture (ADR-0083), like the auth-mode chip.
  // null on the cold-start shell-level bar (ADR-0092): the picker displays
  // the caller-held pending values and writes runtime switches + posture
  // picks to them instead of per-session IPCs.
  sessionId: string | null;
  // The non-secret provider config (profiles list + active id), single-sourced
  // by the parent from app-config. This component never mutates it.
  provider: ProviderConfig;
  // Commit a new active_profile id (one-shot app-config write; live_config
  // reads it fresh on the next turn, ADR-0064). Routes through switchActiveProfile.
  onSwitchActive: (id: string) => void;
  // Open the Settings overlay on the Runtime section (its default sub-tab,
  // ADR-0065). The popover closes first.
  onOpenSettings: () => void;
  // Invalidation counter for the per-profile has_key overlay. Bumped by the
  // parent (App) on settings-close -- a Settings Save may have changed a
  // keychain slot, so the mount-time fetch effect re-runs on a bump and the
  // row-level marks do not show a stale "no key" after the user just
  // configured one (ADR-0019 honest gate).
  profileKeyEpoch?: number;
  // The cold-start selection channel (ADR-0092 bar, ADR-0098/0100, issues
  // #572/#574): the App-owned pending facets (the displayed runtime value
  // + the pending posture pair) and the selection write port -- the picker
  // reads the display face and routes every write through the port, the
  // same interface the session adapter implements in-session. null while a
  // session is active.
  coldStart: ColdStartSelectionChannel | null;
};

export function ComposerProviderPicker({
  sessionId,
  provider,
  onSwitchActive,
  onOpenSettings,
  profileKeyEpoch,
  coldStart,
}: ComposerProviderPickerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  // Per-profile has_key overlay (issue #154 / ADR-0029). Fetched on mount AND
  // on a profileKeyEpoch bump -- App bumps the epoch on settings-close so a
  // Settings Save that changed a keychain slot is reflected without a remount
  // (ADR-0019 honest gate). A profile switch never refetches -- it moves the
  // active pointer, not the keys. Feeds the profile rows' keyless /
  // keychain-fault marks (ADR-0099: the key surface is a row-level mark, the
  // retired status block lived in Settings' domain).
  const [profileKeys, setProfileKeys] = useState<Record<string, ProfileKeyStatus>>({});
  const [keysError, setKeysError] = useState<string | null>(null);

  // Stable intl ref so the mount-time fetch effect runs once ([] deps) instead
  // of re-firing on an intl identity change.
  const intlRef = useRef(intl);
  useEffect(() => {
    intlRef.current = intl;
  }, [intl]);

  useEffect(() => {
    let cancelled = false;
    listProviderProfiles()
      .then((status) => {
        if (cancelled) return;
        const map: Record<string, ProfileKeyStatus> = {};
        for (const s of status) map[s.profile_id] = s;
        setProfileKeys(map);
        // A successful (re)fetch clears the error line from the previous
        // failure -- otherwise it persists until unmount.
        setKeysError(null);
      })
      .catch((e) => {
        if (!cancelled) setKeysError(fmtError(e, intlRef.current));
      });
    return () => {
      cancelled = true;
    };
  }, [profileKeyEpoch]);

  // Per-session runtime choice (issue #353). Backend truth, read under the
  // session-prefix query so a close drops it with the rest and a resume lands
  // the restored session runtime via the fresh SessionPane mount (ADR-0102
  // segment continuation; an undetected recorded adapter degrades the resume
  // to built-in, a pre-#589 recipe falls back to the default runtime). Null
  // sessionId (cold-start bar, ADR-0092): the query is disabled and the
  // caller-held pendingRuntime drives the picker -- no IPC round-trip.
  const queryClient = useQueryClient();
  // The cold-start read face: the App-owned channel's displayed pending
  // facets (inert while a session is active).
  const effectiveRuntime = coldStart?.effectiveRuntime ?? null;
  const pendingModelPosture = coldStart?.pendingModelPosture ?? null;
  const { data: runtimeData, error: runtimeError } = useQuery({
    queryKey: sessionKeys.runtime(sessionId ?? ""),
    queryFn: () => getSessionRuntime(sessionId as string),
    enabled: sessionId !== null,
  });
  const runtime: SessionRuntimeChoice =
    runtimeData ?? effectiveRuntime ?? RUNTIME_CHOICE_DEFAULT;
  const isExternal = runtime.kind === "external";
  const activeAdapterId = isExternal ? runtime.data : null;

  // Per-session external-runtime model config (ADR-0095, issue #527): the
  // model + thought-level selections + the cached discovery catalog. Same
  // session-prefix ownership as the runtime choice; null sessionId disables
  // the query (the cold-start posture comes from the pending pair + the
  // backfill entry below).
  const {
    data: modelConfigData,
    error: modelConfigError,
    isFetching: modelConfigFetching,
  } = useQuery({
    queryKey: sessionKeys.modelConfig(sessionId ?? ""),
    queryFn: () => getSessionModelConfig(sessionId as string),
    enabled: sessionId !== null,
  });
  const modelConfig: SessionModelConfig = modelConfigData ?? MODEL_CONFIG_DEFAULT;
  const discovered = modelConfig.cached_discovered;

  // The v1 adapter table (session-agnostic, ADR-0081/0083). Only detected
  // rows render (issue #490); the list reads the shared adapterKeys.all()
  // cache (the same key LocalCliTab uses); App.tsx invalidates it on Settings
  // close so the next popover open reflects any rescan.
  const { data: adapterData } = useQuery({
    queryKey: adapterKeys.all(),
    queryFn: listAdapters,
  });
  const adapters: AdapterEntry[] = (adapterData ?? []).filter((a) => a.detected);
  const activeAdapter = isExternal
    ? (adapters.find((a) => a.id === activeAdapterId) ?? null)
    : null;
  // Stale-runtime flag (issue #490): if the session's active external adapter
  // is no longer detected (CLI uninstalled, PATH changed), it is filtered out
  // of the selector list. Surfaced at the top of the Local CLI group so the
  // user knows their current pick is broken before the next turn fails.
  const activeAdapterStale = isExternal && activeAdapterId !== null && activeAdapter === null;
  // The startup backfill entry (ADR-0100, issue #581): what a NEW session on
  // this adapter starts with. Read only on the cold-start bar (in-session
  // truth is the model-config query above). Enabled flips true whenever the
  // bar returns to cold start / the adapter changes, so the entry refetches
  // after any in-session set updated it server-side.
  const { data: backfillData, error: backfillError } = useQuery({
    // Disabled-state key placeholder: with no external adapter active the
    // query never runs (enabled below), so the inert "" segment carries the
    // key -- the same always-disabled convention as the __cold_start__
    // sentinel in sessionKeys, fixed by comment rather than a second
    // sentinel constant.
    queryKey: adapterKeys.posture(activeAdapterId ?? ""),
    queryFn: () => getLastModelPosture(activeAdapterId as string),
    enabled: sessionId === null && activeAdapterId !== null,
  });

  // Catalog priority chain (ADR-0096 D6, issue #537, ADR-0097): where the
  // posture catalog comes from, per the active runtime's stream format.
  //   ACP:                  session cached_discovered -> the global probe
  //                         cache entry for THIS adapter -> none (static
  //                         label + the settings-test guidance).
  //   codex / claude-code:  the probe cache's per-model entry for THIS
  //                         adapter only; without it the surface stays the
  //                         static CLI-default label -- honest rendering, no
  //                         invented directory.
  const { data: cachedCatalogsData } = useQuery({
    queryKey: adapterKeys.catalogs(),
    queryFn: getAdapterCatalogs,
  });
  const cachedCatalogs = cachedCatalogsData ?? {};
  const probeEntry =
    isExternal && activeAdapterId !== null
      ? (cachedCatalogs[activeAdapterId] ?? null)
      : null;

  // Guards the posture set IPC (the menu is disabled while a write is in
  // flight). In-session only -- the cold-start channel is a synchronous
  // pending write.
  const [postureSwitching, setPostureSwitching] = useState(false);
  // Inline failure line for posture writes (issue #529): the in-session set
  // IPC reject and the cold-start backfill-clear reject. Holds the raw
  // reject and formats at render so a locale switch re-renders the wording.
  // Cleared on the next attempt.
  const [postureSetError, setPostureSetError] = useState<unknown>(null);
  // A set that resolved but whose persist-now leg did not land (issue #529):
  // the verdict rides the set command's return (in-process, read in the same
  // critical section), so "set means persisted" (ADR-0095 Decision 6) cannot
  // break silently nor be swallowed by the shared banner error channel.
  const [posturePersistFault, setPosturePersistFault] = useState<SaveError | null>(null);
  // True when the persist was withheld on a pending ADR-0035 conflict (the
  // .duck changed externally; the auto-write refuses to clobber it).
  const [posturePersistSuspended, setPosturePersistSuspended] = useState(false);

  // The posture the bar displays: the session's model config in-session, or
  // the cold-start pending pair seeded from the backfill entry (pending
  // first -- an explicit pick overrides the backfill, ADR-0100 Decision 1).
  const posture: ModelPosture =
    sessionId !== null
      ? { model: modelConfig.model, thought_level: modelConfig.thought_level }
      : (pendingModelPosture ?? backfillData ?? EMPTY_POSTURE);

  // The posture-catalog projection (ADR-0096 D6 priority chain, issues
  // #529/#586, in posture-catalog.ts): the cascade menu's catalog, its one
  // provenance note, and the tooltip's live payload -- derived pure from
  // the query reads assembled above.
  const {
    catalog: postureCatalog,
    note: catalogNote,
    liveValue,
  } = derivePostureCatalog({
    isExternal,
    activeAdapterId,
    activeAdapter,
    discovered,
    probeEntry,
    posture,
  });

  // The posture read's settle gate (issue #603 review): the full-pair wire
  // makes this cache the authority for the UNTOUCHED field of every submit,
  // so an unsettled read must never feed one. Two windows: the first fetch
  // (data undefined -> the DEFAULT fallback would coerce the server-held
  // value into an explicit clear) and any refetch in flight (selectRuntime
  // invalidates this key -> the stale pair would overwrite the freshly
  // seeded slot). The error state is excluded: configFault replaces the
  // control outright. Gates the trigger (the menu cannot open) AND the
  // handlers -- a menu already open when a refetch starts still drops the
  // gesture, since Radix items ignore the trigger's disabled.
  const postureReadUnsettled =
    isExternal && sessionId !== null && modelConfigFetching;

  // The write face (composer-selection-write.ts): the session adapter over
  // the set IPCs, or the App-owned cold-start channel on the bar -- one
  // interface, so the selectors below carry no session/cold-start write
  // branch. Stateless orchestration, rebuilt per render (identity is never
  // compared).
  const sessionPort =
    sessionId !== null
      ? createSessionSelectionPort({
          sessionId,
          queryClient,
          activeAdapterId,
        })
      : null;
  const writePort = sessionPort ?? coldStart?.port ?? null;

  // The selectors' shared write sequence: delegates to the port (the
  // session adapter seeds the caches and lands the persist verdict, the
  // cold-start adapter writes the pending state and clears the backfill
  // entry with its rollback) and projects the outcome onto the fault
  // slots. Never rejects -- every failure lands on the slots instead.
  async function submitPosture(
    next: ModelPosture,
    clearsBackfill: boolean,
  ): Promise<void> {
    if (writePort == null) return;
    // Session-only write gates (issue #603 review): an in-flight set or an
    // unsettled read drops the gesture -- Radix items ignore the trigger's
    // disabled, so the handlers gate too. The cold-start writes are
    // synchronous pending updates with nothing to guard.
    if (sessionId !== null && (postureSwitching || postureReadUnsettled)) {
      return;
    }
    if (sessionId !== null) setPostureSwitching(true);
    setPostureSetError(null);
    setPosturePersistFault(null);
    setPosturePersistSuspended(false);
    try {
      const outcome = await writePort.writePosture(next, {
        clearsBackfill,
        // The displayed pair at submit time -- the cold-start rollback
        // target when the backfill-clear IPC rejects (ADR-0100 D3).
        rollbackTo: posture,
      });
      if (outcome.status === "written") {
        setPosturePersistFault(outcome.persistError);
        setPosturePersistSuspended(outcome.persistSuspended);
      } else {
        setPostureSetError(outcome.error);
      }
    } finally {
      if (sessionId !== null) setPostureSwitching(false);
    }
  }

  const selectModel = (model: string | null) => {
    // Per-model linkage (issue #537, shared by codex + claude-code): the
    // thought level must sit in the newly selected model's supported set. A
    // held level outside that set (including every held level once the
    // model pick is cleared -- no model means no supported set at all) is
    // cleared in the SAME user gesture -- since issue #603 the same wire
    // submit, so a rejected write leaves the held level against the
    // still-held model untouched.
    const perModelModels =
      postureCatalog?.kind === "perModel" ? postureCatalog.models : null;
    const mustClearLevel =
      perModelModels &&
      posture.thought_level != null &&
      !supportedEffortsFor(perModelModels, model).includes(
        posture.thought_level,
      );
    const thoughtLevel = mustClearLevel ? null : posture.thought_level;
    // Both channels submit the same full pair through the one write port:
    // the cold-start pending write (no set IPCs) and the in-session set.
    const next: ModelPosture = { model, thought_level: thoughtLevel };
    return submitPosture(next, model === null);
  };

  const selectThoughtLevel = (thoughtLevel: string | null) => {
    // The full pair rides one submit (issue #603): the held model is sent
    // as its current value -- an untouched field is never derived
    // server-side (the pending write on the cold-start bar included).
    const next: ModelPosture = { model: posture.model, thought_level: thoughtLevel };
    return submitPosture(next, thoughtLevel === null);
  };

  // Per-model helper (issue #537, codex + claude-code): the thought-level
  // list for the given model id -- that model's supported efforts in the
  // CLI's declared order (never a union across models). Null / unknown
  // model: no entries (the level row disables with a "pick a model first"
  // hint).
  function supportedEffortsFor(
    models: { id: string; supported_reasoning_efforts: string[] }[],
    modelId: string | null,
  ): string[] {
    if (modelId == null) return [];
    return models.find((m) => m.id === modelId)?.supported_reasoning_efforts ?? [];
  }

  // Guards the runtime write window: a click that lands while the set IPC is
  // in flight is dropped instead of re-firing (the disabled attr is the
  // visual half of the same gate).
  const [switching, setSwitching] = useState(false);

  async function selectRuntime(next: SessionRuntimeChoice) {
    if (writePort == null || switching) return;
    // Both channels through the one write port: the session set IPC, or the
    // cold-start pending write (which also resets the pending posture,
    // ADR-0100 D2 namespacing -- the port's single reset point).
    setSwitching(true);
    try {
      await writePort.writeRuntime(next);
    } finally {
      setSwitching(false);
    }
  }

  // Level-1 "Local CLI" click with no external runtime held: select the
  // first detected CLI so the group header is itself an operable radio
  // target. No detected CLI (or already external): a no-op -- the group
  // stays honest about having nothing to switch to.
  function selectLocalCliGroup() {
    if (isExternal || switching) return;
    const first = adapters[0];
    if (first) void selectRuntime({ kind: "external", data: first.id });
  }

  const activeProfile = findActiveProfile(provider);
  const unnamed = intl.formatMessage({
    id: "common.profileUnnamed",
    defaultMessage: "Unnamed profile",
  });
  const builtInModel = activeProfile?.model ?? "";
  const noProfiles = provider.profiles.length === 0;
  const notConfigured = intl.formatMessage({
    id: "composer.providerPicker.notConfigured",
    defaultMessage: "Not configured",
  });
  const defaultRecommended = intl.formatMessage({
    id: "composer.postureTrigger.default",
    defaultMessage: "Default (recommended)",
  });

  // The posture label (ADR-0099 Decision 3 / #573): built-in shows the
  // active profile's model (empty -> em dash; zero profiles -> "Not
  // configured", never a fake default); external shows the held pair
  // (either side omitted when unset -- the two dimensions are
  // independently reachable on ACP adapters, so a lone thought level has
  // its own held form) or "Default (recommended)" when nothing is held --
  // anchored to never-selected-or-cleared per dimension (ADR-0100
  // Decision 1). The turn-end live currents never touch the label (issue
  // #586, user-supplied form): they ride the trigger's tooltip instead,
  // so the unselected label keeps its default copy verbatim. An
  // empty-string field counts as unset, matching the menu guards'
  // convention, so a hand-edited blank cannot blank the button.
  const heldParts = heldPostureParts(posture);
  const postureLabel = !isExternal
    ? noProfiles
      ? notConfigured
      : builtInModel || "—"
    : heldParts.length > 0
      ? heldParts.join(" · ")
      : defaultRecommended;

  // The provider readout = the preset the active profile sits on (e.g.
  // "Anthropic"); falls back to the profile's own display name when the
  // endpoint is Custom. A unified, non-trademark provider label (ADR-0071).
  const presetId = activeProfile
    ? derivePresetId({
        protocol: activeProfile.protocol,
        base_url: activeProfile.base_url,
      })
    : PRESET_CUSTOM;
  const preset = presetId === PRESET_CUSTOM ? undefined : findPreset(presetId);
  const providerName = noProfiles
    ? notConfigured
    : (preset?.display_name ?? activeProfile?.display_name.trim() ?? unnamed);

  // Tooltip preview text (also Radix Tooltip's aria-describedby content, so SR
  // users hear the live context on trigger focus). The honest "no key" mark is
  // appended when the active profile has no key (ADR-0019).
  const summary = intl.formatMessage(
    {
      id: "composer.providerPicker.tooltip",
      defaultMessage: "{provider} · {model}",
    },
    { provider: providerName, model: builtInModel || "—" },
  );
  const noKeyMark = intl.formatMessage({
    id: "composer.providerPicker.noKeyMark",
    defaultMessage: "no key",
  });
  const keychainUnavailableMark = intl.formatMessage({
    id: "composer.providerPicker.keychainUnavailable",
    defaultMessage: "Keychain unavailable",
  });
  // The external-runtime tooltip names the selected adapter (the closed chip
  // shows the glyph alone; the tooltip is where the user reads WHICH
  // runtime the next turn will use). Falls back to the raw id if the adapter
  // row has not loaded yet.
  const externalTooltip = intl.formatMessage(
    {
      id: "composer.runtimePicker.tooltip.external",
      defaultMessage: "External runtime: {adapter}",
    },
    { adapter: activeAdapter?.display_name ?? activeAdapterId ?? "" },
  );
  const activeStatus = activeProfile ? profileKeys[activeProfile.id] : undefined;
  const hasKey = activeStatus?.has_key ?? false;
  const keychainFault = activeStatus?.keychain_fault ?? null;
  // A failed overlay read must not state "no key" as fact: while the error
  // line is up the mark is suppressed rather than guessed (the profile may
  // well have a key -- the popover carries the read failure itself).
  const builtInTooltip = noProfiles
    ? notConfigured
    : keychainFault
      ? `${summary} · ${keychainUnavailableMark}`
      : hasKey || keysError != null
        ? summary
        : `${summary} · ${noKeyMark}`;
  const tooltipText = isExternal ? externalTooltip : builtInTooltip;

  function handleOpenSettings() {
    // Close BEFORE opening: the portaled PopoverContent would otherwise remain
    // visible atop the settings overlay (ADR-0065 hides the shell via CSS, not
    // the portal host in document.body).
    setOpen(false);
    onOpenSettings();
  }

  // Honest read failure (issue #529): a rejected posture read must NOT
  // masquerade as an unselected default -- the posture trigger renders the
  // fault inline instead of the control. Scoped to external runtimes: the
  // built-in posture reads app-config, not these queries. In-session the
  // source is the model-config query; on the cold-start bar it is the
  // backfill read (the model-config query is disabled there) -- the two
  // are mutually exclusive by their enabled guards.
  const modelConfigFault = isExternal
    ? sessionId === null
      ? backfillError
      : modelConfigError
    : null;

  return (
    <>
      {/* The posture text button, seated BEFORE the runtime trigger
          (ADR-0099 Decision 1): the resident posture readout + cascade
          menu for the next turn's model / thought level. */}
      <ComposerPostureTrigger
        label={postureLabel}
        catalog={postureCatalog}
        liveValue={liveValue}
        model={isExternal ? posture.model : null}
        thoughtLevel={isExternal ? posture.thought_level : null}
        onSelectModel={(m) => void selectModel(m)}
        onSelectThoughtLevel={(l) => void selectThoughtLevel(l)}
        configFault={modelConfigFault}
        setFault={postureSetError}
        persistFault={posturePersistFault}
        persistSuspended={posturePersistSuspended}
        catalogNote={catalogNote}
        disabled={postureSwitching || postureReadUnsettled}
      />
      {runtimeError != null ? (
        // Honest read failure (issue #600): a rejected runtime read must not
        // masquerade as the built-in default -- the chip renders the fault
        // inline instead of the control (the configFault treatment on the
        // model-config side, #529 convention). With staleTime: Infinity and
        // no focus refetch, the error state persists until a refetch, so the
        // line stays up rather than flashing. Cold start never lands here
        // (the query is disabled without a session id).
        <span role="status" className="text-destructive max-w-40 truncate text-xs">
          {fmtError(runtimeError, intl)}
        </span>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  // ADR-0067 (#171): visual rules -> inline utilities. The trigger
                  // is an icon button sized to the QuestionBar row; bg-card + border
                  // ride the ADR-0050 token.
                  className="composer-picker-trigger inline-flex items-center justify-center size-9 rounded-md border border-border bg-card text-foreground hover:bg-muted transition-colors cursor-pointer"
                  aria-label={intl.formatMessage(
                    {
                      id: "composer.providerPicker.triggerAria",
                      defaultMessage: "Runtime: {label}",
                    },
                    {
                      label: isExternal
                        ? (activeAdapter?.display_name ?? activeAdapterId ?? "")
                        : providerName,
                    },
                  )}
                >
                  {/* The unified entry glyph is the Settings runtime section's
                    Box icon. Still NOT a provider logo (ADR-0071); the
                    aria-label + tooltip are unchanged. */}
                  <Box className="size-4 shrink-0" aria-hidden />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
          </Tooltip>

          <PopoverContent align="start" className="w-80">
            <ComposerRuntimeMenu
              isExternal={isExternal}
              switching={switching}
              provider={provider}
              profileKeys={profileKeys}
              keysError={keysError}
              adapters={adapters}
              activeAdapterId={activeAdapterId}
              activeAdapterStale={activeAdapterStale}
              onSwitchActive={onSwitchActive}
              onSelectRuntime={selectRuntime}
              onSelectLocalCliGroup={selectLocalCliGroup}
              onManageRuntimes={handleOpenSettings}
            />
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
