import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Brain, Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import {
  clearLastModelPosture,
  getAdapterCatalogs,
  getLastModelPosture,
  getSessionModelConfig,
  getSessionRuntime,
  listAdapters,
  listProviderProfiles,
  setSessionModel,
  setSessionRuntime,
  setSessionThoughtLevel,
  type SetModelPersistOutcome,
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
import {
  ComposerPostureTrigger,
  type CatalogNote,
  type PostureCatalog,
} from "./ComposerPostureTrigger";

// The honest default while the model-config read settles (and on the
// cold-start bar, where there is no session to read): no selection, no
// discovery cache. The CLI's own defaults rule the next turn.
const MODEL_CONFIG_DEFAULT: SessionModelConfig = {
  model: null,
  thought_level: null,
  cached_discovered: null,
};

// The unselected posture pair (ADR-0100): never chosen, or explicitly
// cleared -- the "Default (recommended)" start.
const EMPTY_POSTURE: ModelPosture = { model: null, thought_level: null };

import {
  PRESET_CUSTOM,
  derivePresetId,
  findPreset,
} from "../settings/provider-presets";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Composer runtime entry (ADR-0099, issues #353/#574; ADR-0071/0081/0085/
// 0091 lineage). TWO resident controls at the QuestionBar edge, each with one
// job:
//   - the POSTURE text button (ComposerPostureTrigger, seated first) is the
//     readout + cascade menu for the next turn's model / thought level --
//     the four-state label of ADR-0099 Decision 3 / #573;
//   - the ICON trigger's popover is the ONLY runtime-switching entry:
//     two-level (level 1 "API Access" / "Local CLI" radio rows mirroring
//     the Settings runtime sub-tab names; level 2 one Select per group --
//     the profiles under API Access, the detected CLIs under Local CLI).
// Configuration actions (profile CRUD, profile.model editing, key
// management, CLI management + probing) live in Settings -- this popover is
// a pure selector (ADR-0099 Decision 1, calibrating ADR-0071's in-popover
// configuration duties into retirement).
//
// Trigger glyph: a lucide Brain, the Settings runtime section's icon -- the
// unified entry glyph (NOT a provider logo; ADR-0071). Hover Tooltip: an
// honest "{provider} · {model}" preview for the built-in runtime (+ an
// honest "no key" mark when the active profile has no key, ADR-0019) or the
// external adapter name. The runtime NAME rides the tooltip; the posture
// button carries the model/level readout.
//
// Runtime state ownership: the per-session CHOICE is backend truth, read via
// `getSessionRuntime` under the session-prefix query (a close drops it with
// the rest; a resume lands the reset built-in value via the fresh SessionPane
// mount, mirroring authMode). Writes go through `setSessionRuntime` and take
// effect at the NEXT turn boundary. A rejected write keeps the server
// posture -- the picker resyncs via refetch and never shows a runtime the
// backend did not grant.
//
// Posture ownership (ADR-0095/0099/0100): in-session the model / thought
// level read via `getSessionModelConfig` and write through the two set IPCs
// (next-turn effective; the successful set also lands the pair on the
// adapter's app-config backfill entry server-side -- the single write
// point). On the cold-start bar (null sessionId) the displayed posture is
// the caller-held pendingModelPosture seeded from the adapter's backfill
// entry (`getLastModelPosture`); an explicit pick patches the pending pair
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
  // When sessionId is null (cold-start bar, ADR-0092), a runtime selection
  // writes to the shell-level pending state via this callback instead of the
  // per-session IPC. The caller resets the pending model posture whenever
  // this fires (postures are adapter-namespaced, ADR-0100 Decision 2).
  onPendingRuntimeChange?: (runtime: SessionRuntimeChoice) => void;
  // The shell-level pending runtime value to DISPLAY while sessionId is null
  // (issue #572, ADR-0098 Decision 4): the caller seeds it with the resolved
  // default_runtime and replaces it on each onPendingRuntimeChange. null
  // means untouched -- the picker then displays the startup resolution.
  pendingRuntime?: SessionRuntimeChoice | null;
  // Cold-start posture channel (ADR-0099/0100, issue #574): a cascade-menu
  // pick on the cold-start bar patches the shell-held pending pair via this
  // callback. null means untouched -- the picker displays the adapter's
  // backfill entry, and the first submit lets the backend's create_session
  // startup posture apply (no set IPC). A non-null pair is EXPLICIT --
  // null fields are real clears -- and lands on the minted session via the
  // two set IPCs.
  onPendingModelPostureChange?: (posture: ModelPosture) => void;
  pendingModelPosture?: ModelPosture | null;
};

export function ComposerProviderPicker({
  sessionId,
  provider,
  onSwitchActive,
  onOpenSettings,
  profileKeyEpoch,
  onPendingRuntimeChange,
  pendingRuntime,
  onPendingModelPostureChange,
  pendingModelPosture = null,
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
  // the reset built-in value via the fresh SessionPane mount (mirrors authMode).
  // Null sessionId (cold-start bar, ADR-0092): the query is disabled and the
  // caller-held pendingRuntime drives the picker -- no IPC round-trip.
  const queryClient = useQueryClient();
  const { data: runtimeData } = useQuery({
    queryKey: sessionKeys.runtime(sessionId ?? ""),
    queryFn: () => getSessionRuntime(sessionId as string),
    enabled: sessionId !== null,
  });
  const runtime: SessionRuntimeChoice =
    runtimeData ?? pendingRuntime ?? RUNTIME_CHOICE_DEFAULT;
  const isExternal = runtime.kind === "external";
  const activeAdapterId = isExternal ? runtime.data : null;

  // Per-session external-runtime model config (ADR-0095, issue #527): the
  // model + thought-level selections + the cached discovery catalog. Same
  // session-prefix ownership as the runtime choice; null sessionId disables
  // the query (the cold-start posture comes from the pending pair + the
  // backfill entry below).
  const { data: modelConfigData, error: modelConfigError } = useQuery({
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
  // The active adapter's stream format decides the posture catalog surface
  // (ADR-0095/0097): ACP adapters get the flat handshake catalog; the
  // per-model catalog formats (codex_event_stream / claude_stream_json) get
  // the probe-cache-fed per-model catalog. The dispatch enumerates the
  // per-model kinds explicitly (not `!== "acp"`): a future fourth format
  // must be classified here deliberately, never default into a surface.
  const isPerModelCatalogAdapter =
    isExternal &&
    activeAdapter != null &&
    (activeAdapter.stream_format === "codex_event_stream" ||
      activeAdapter.stream_format === "claude_stream_json");

  // The startup backfill entry (ADR-0100, issue #581): what a NEW session on
  // this adapter starts with. Read only on the cold-start bar (in-session
  // truth is the model-config query above). Enabled flips true whenever the
  // bar returns to cold start / the adapter changes, so the entry refetches
  // after any in-session set updated it server-side.
  const { data: backfillData } = useQuery({
    queryKey: adapterKeys.posture(activeAdapterId ?? ""),
    queryFn: () => getLastModelPosture(activeAdapterId as string),
    enabled: sessionId === null && activeAdapterId !== null,
  });

  // Discovery-cache provenance (issue #529): the cached catalog records the
  // adapter that produced it (stamped by the engine at the handshake). After
  // a runtime switch the cache still holds the OLD adapter's catalog until
  // the new runtime's first turn replaces it (replace-on-Some) -- flag that
  // window so the user can judge which residual selection to clear. A cache
  // with NO provenance (persisted before the field existed) is not a
  // mismatch -- it renders without the flag. Scoped to discovery-fed (ACP)
  // adapters: a per-model runtime's selector feeds off the probe cache, so
  // its turns would never replace the discovery cache -- the "refreshes
  // after the next turn" promise would be a permanent lie there.
  const catalogProvenanceStale =
    isExternal &&
    !isPerModelCatalogAdapter &&
    discovered != null &&
    discovered.adapter_id != null &&
    discovered.adapter_id !== activeAdapterId;

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

  const acpCatalog =
    isExternal && !isPerModelCatalogAdapter
      ? (discovered ??
        (probeEntry && probeEntry.probe_kind === "acp"
          ? probeEntry.outcome.acp.discovered
          : null))
      : null;
  // True when the ACP catalog is fed by the probe cache rather than the
  // session's own discovery (drives the provenance note: the session cache
  // replaces it after this runtime's next turn).
  const acpCatalogFromProbe =
    acpCatalog != null && discovered == null && probeEntry != null;

  // The one provenance note the posture trigger renders: the two predicates
  // are complementary over `discovered` (stale requires a session-owned
  // discovery, probe-fed requires none), so at most one ever fires.
  const catalogNote: CatalogNote = catalogProvenanceStale
    ? "stale-runtime"
    : acpCatalogFromProbe
      ? "from-probe"
      : null;

  const perModelCatalog =
    isPerModelCatalogAdapter && probeEntry
      ? probeEntry.probe_kind === "codex_event_stream"
        ? probeEntry.outcome.codex_event_stream.models
        : probeEntry.probe_kind === "claude_stream_json"
          ? probeEntry.outcome.claude_stream_json.models
          : null
      : null;

  // The catalog handed to the posture trigger: null renders the static
  // no-arrow label (built-in, or an external runtime with no directory yet).
  const postureCatalog: PostureCatalog | null = !isExternal
    ? null
    : isPerModelCatalogAdapter
      ? (perModelCatalog ? { kind: "perModel", models: perModelCatalog } : null)
      : acpCatalog
        ? {
            kind: "acp",
            models: acpCatalog.models,
            thoughtLevels: acpCatalog.thought_levels,
            currentModel: acpCatalog.current_model,
            currentThoughtLevel: acpCatalog.current_thought_level,
          }
        : null;

  // Guards the two set IPCs (one at a time; the menu is disabled while a
  // write is in flight). In-session only -- the cold-start channel is a
  // synchronous pending patch.
  const [modelSwitching, setModelSwitching] = useState(false);
  // Inline failure line for the two set IPCs (issue #529). Holds the raw
  // reject and formats at render so a locale switch re-renders the wording.
  // Cleared on the next attempt.
  const [modelSetError, setModelSetError] = useState<unknown>(null);
  // A set that resolved but whose persist-now leg did not land (issue #529):
  // the verdict rides the set command's return (in-process, read in the same
  // critical section), so "set means persisted" (ADR-0095 Decision 6) cannot
  // break silently nor be swallowed by the shared banner error channel.
  const [modelPersistFault, setModelPersistFault] = useState<SaveError | null>(null);
  // True when the persist was withheld on a pending ADR-0035 conflict (the
  // .duck changed externally; the auto-write refuses to clobber it).
  const [modelPersistSuspended, setModelPersistSuspended] = useState(false);

  // The posture the bar displays: the session's model config in-session, or
  // the cold-start pending pair seeded from the backfill entry (pending
  // first -- an explicit pick overrides the backfill, ADR-0100 Decision 1).
  const posture: ModelPosture =
    sessionId !== null
      ? { model: modelConfig.model, thought_level: modelConfig.thought_level }
      : (pendingModelPosture ?? backfillData ?? EMPTY_POSTURE);

  // Cold-start posture writes (ADR-0099/0100, issue #574): a pick patches the
  // shell-held pending pair, seeded from the DISPLAYED posture so the first
  // edit starts from what the bar shows (backfill or a prior pick). The
  // clear row additionally wipes the backfill entry via the #581 IPC so the
  // clear survives even when the user never submits (otherwise the next
  // cold-start visit re-seeds the cleared posture -- the backfill defeating
  // an explicit clear, ADR-0100 Decision 3). In-session clears do NOT wipe
  // the entry separately: the set IPC's server-side record already lands the
  // post-set pair there (the single write point).
  function pendingPostureWrite(
    patch: Partial<ModelPosture>,
    clearsBackfill: boolean,
  ): void {
    if (!onPendingModelPostureChange) {
      log.warn(
        "ComposerProviderPicker",
        "cold-start posture selection discarded — no onPendingModelPostureChange handler",
      );
      return;
    }
    const prevPosture = posture;
    onPendingModelPostureChange({ ...posture, ...patch });
    if (clearsBackfill && activeAdapterId !== null) {
      const adapterId = activeAdapterId;
      clearLastModelPosture(adapterId)
        .then(() => {
          queryClient.setQueryData(adapterKeys.posture(adapterId), EMPTY_POSTURE);
        })
        .catch((e) => {
          // The entry survived -- roll the optimistic clear back so the bar
          // keeps showing it. Otherwise the next cold start (the pending
          // pair resets to null on a runtime switch / restart) re-seeds from
          // the un-cleared entry and the posture silently "comes back" --
          // precisely the backfill-defeats-clear outcome this IPC exists to
          // prevent (ADR-0100 Decision 3).
          onPendingModelPostureChange(prevPosture);
          log.warn(
            "ComposerProviderPicker",
            "clear startup posture failed; rolled the pending clear back",
            fmtError(e, intl),
          );
        });
    }
  }

  // Shared write sequence for both selectors in-session (the two bodies
  // differ only in the IPC, the patched key, and the log verb). On resolve:
  // seed the cache with the granted posture and project the returned persist
  // verdict onto the two fault slots. On reject: keep the server posture
  // (refetch off the reject) + show the failure. Returns whether the write
  // was GRANTED (a dropped click or a reject yields false) -- the codex
  // model->effort linkage gates its clearing write on it.
  async function applyModelConfig(
    write: () => Promise<SetModelPersistOutcome>,
    patch: Partial<Pick<SessionModelConfig, "model" | "thought_level">>,
    logVerb: string,
  ): Promise<boolean> {
    if (sessionId === null || modelSwitching) return false;
    setModelSwitching(true);
    setModelSetError(null);
    setModelPersistFault(null);
    setModelPersistSuspended(false);
    try {
      const outcome = await write();
      // Functional update: a later selection in the same menu session must
      // patch the CURRENT cache, not the snapshot this closure captured at
      // render -- two rapid selections (e.g. a model pick that auto-clears
      // an unsupported thought level) would otherwise clobber each other.
      queryClient.setQueryData(
        sessionKeys.modelConfig(sessionId),
        (prev: SessionModelConfig | undefined): SessionModelConfig => ({
          ...(prev ?? modelConfig),
          ...patch,
        }),
      );
      setModelPersistFault(outcome.persist_error);
      setModelPersistSuspended(outcome.persist_suspended);
      // The set lands the post-set pair in the startup backfill entry
      // server-side (record_last_model_posture, the single write point).
      // Invalidate so the NEXT return to cold start refetches the post-set
      // entry instead of showing the pre-set one (staleTime: Infinity never
      // auto-refetches, ADR-0051).
      if (activeAdapterId !== null) {
        void queryClient.invalidateQueries({
          queryKey: adapterKeys.posture(activeAdapterId),
        });
      }
      return true;
    } catch (e) {
      setModelSetError(e);
      log.warn(
        "ComposerProviderPicker",
        `set session ${logVerb} failed; resyncing from the session`,
        fmtError(e, intl),
      );
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.modelConfig(sessionId),
      });
      return false;
    } finally {
      setModelSwitching(false);
    }
  }

  const selectModel = async (model: string | null) => {
    // Per-model linkage (issue #537, shared by codex + claude-code): the
    // thought level must sit in the newly selected model's supported set. A
    // held level outside that set (including every held level once the
    // model pick is cleared -- no model means no supported set at all) is
    // cleared in the SAME user gesture. A rejected model write (in-session)
    // returns early: the held level stays against the still-held model.
    const mustClearLevel =
      perModelCatalog &&
      posture.thought_level != null &&
      !supportedEffortsFor(perModelCatalog, model).includes(
        posture.thought_level,
      );
    if (sessionId === null) {
      // Cold start: the linkage is part of the pending patch (no IPCs).
      pendingPostureWrite(
        mustClearLevel ? { model, thought_level: null } : { model },
        model === null,
      );
      return;
    }
    const granted = await applyModelConfig(
      () => setSessionModel(sessionId, model),
      { model },
      "model",
    );
    if (!granted) return;
    // The clear lands via the existing set IPC -- awaiting the model write
    // first means applyModelConfig's switching gate has re-opened and the
    // clear cannot be swallowed.
    if (mustClearLevel) {
      await selectThoughtLevel(null);
    }
  };

  const selectThoughtLevel = (thoughtLevel: string | null) => {
    if (sessionId === null) {
      pendingPostureWrite({ thought_level: thoughtLevel }, thoughtLevel === null);
      return;
    }
    return applyModelConfig(
      () => setSessionThoughtLevel(sessionId, thoughtLevel),
      { thought_level: thoughtLevel },
      "thought level",
    );
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
    if (switching) return;
    // Null sessionId (cold-start bar, ADR-0092): write to the caller-held
    // pending state. No IPC, no switching gate -- the write is synchronous.
    if (sessionId === null) {
      if (onPendingRuntimeChange) {
        onPendingRuntimeChange(next);
      } else {
        log.warn(
          "ComposerProviderPicker",
          "selectRuntime called with null sessionId but no onPendingRuntimeChange handler — selection discarded",
        );
      }
      return;
    }
    setSwitching(true);
    try {
      await setSessionRuntime(sessionId, next);
      // The write is the truth source: seed the cache directly (no extra IPC
      // round-trip; a later remount refetches the same value).
      queryClient.setQueryData(sessionKeys.runtime(sessionId), next);
    } catch (e) {
      // Keep the server posture: refetch so the picker re-reads the backend
      // truth instead of showing a selection the write never granted.
      log.warn(
        "ComposerProviderPicker",
        "set session runtime failed; resyncing from the session",
        fmtError(e, intl),
      );
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.runtime(sessionId),
      });
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

  const activeProfile = provider.profiles.find(
    (p) => p.id === provider.active_profile,
  );
  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
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

  // The four-state posture label (ADR-0099 Decision 3 / #573): built-in
  // shows the active profile's model (empty -> em dash; zero profiles ->
  // "Not configured", never a fake default); external shows the held pair
  // (strength omitted when unset) or "Default (recommended)" when nothing
  // is held -- anchored to never-selected-or-cleared (ADR-0100 Decision 1).
  const postureLabel = !isExternal
    ? noProfiles
      ? notConfigured
      : builtInModel || "—"
    : posture.model != null
      ? posture.thought_level != null
        ? `${posture.model} · ${posture.thought_level}`
        : posture.model
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
    id: "settings.profiles.keychainUnavailable",
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
  const builtInTooltip = noProfiles
    ? notConfigured
    : keychainFault
      ? `${summary} · ${keychainUnavailableMark}`
      : hasKey
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

  // Honest read failure (issue #529): a rejected model-config get must NOT
  // masquerade as an unselected default -- the posture trigger renders the
  // fault inline instead of the control. Scoped to external runtimes: the
  // built-in posture reads app-config, not this query.
  const modelConfigFault = isExternal ? modelConfigError : null;

  return (
    <>
      {/* The posture text button, seated BEFORE the runtime trigger
          (ADR-0099 Decision 1): the resident four-state readout + cascade
          menu for the next turn's model / thought level. */}
      <ComposerPostureTrigger
        label={postureLabel}
        catalog={postureCatalog}
        model={isExternal ? posture.model : null}
        thoughtLevel={isExternal ? posture.thought_level : null}
        onSelectModel={(m) => void selectModel(m)}
        onSelectThoughtLevel={(l) => void selectThoughtLevel(l)}
        configFault={modelConfigFault}
        setFault={modelSetError}
        persistFault={modelPersistFault}
        persistSuspended={modelPersistSuspended}
        catalogNote={catalogNote}
        disabled={modelSwitching}
      />
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
                    Brain icon. Still NOT a provider logo (ADR-0071); the
                    aria-label + tooltip are unchanged. */}
                <Brain className="size-4 shrink-0" aria-hidden />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>

        <PopoverContent align="start" className="w-80">
          {/* The two-level runtime selector (ADR-0099 Decision 2): level 1
              mirrors the Settings runtime sub-tab names; level 2 is one
              Select per group -- the profiles under API Access, the detected
              CLIs under Local CLI. Pure selector -- all configuration
              actions live in Settings (Decision 1). */}
          <div className="grid gap-1.5">
            {/* --- Level 1 + 2: API Access (= the built-in runtime) --------- */}
            <section className="grid gap-1">
              <button
                type="button"
                disabled={switching}
                onClick={() => void selectRuntime({ kind: "built_in" })}
                aria-pressed={!isExternal}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium cursor-pointer hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                <RuntimeDot selected={!isExternal} />
                <FormattedMessage
                  id="settings.runtime.tab.apiAccess"
                  defaultMessage="API Access"
                />
              </button>
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
                    if (isExternal) void selectRuntime({ kind: "built_in" });
                  }}
                  disabled={switching}
                >
                  <SelectTrigger
                    aria-label={profileSelectAria}
                    className="ml-6 w-[calc(100%-1.5rem)] border-border bg-card hover:bg-muted"
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
              <button
                type="button"
                disabled={switching}
                onClick={selectLocalCliGroup}
                aria-pressed={isExternal}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium cursor-pointer hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
              >
                <RuntimeDot selected={isExternal} />
                <FormattedMessage
                  id="settings.runtime.tab.localCli"
                  defaultMessage="Local CLI"
                />
              </button>
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
                  void selectRuntime({ kind: "external", data: id })}
                disabled={switching}
              >
                <SelectTrigger
                  aria-label={cliSelectAria}
                  className="ml-6 w-[calc(100%-1.5rem)] border-border bg-card hover:bg-muted"
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
              onClick={handleOpenSettings}
              className="inline-flex items-center gap-0.5 justify-self-end text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <FormattedMessage
                id="composer.runtimePicker.manageRuntimes"
                defaultMessage="Manage runtimes"
              />
              <ChevronRight className="size-3.5" aria-hidden />
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </>
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
