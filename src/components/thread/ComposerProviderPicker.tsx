import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import { findActiveProfile } from "../../lib/findActiveProfile";
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
import { ComposerRuntimeMenu } from "./ComposerRuntimeMenu";
import {
  PRESET_CUSTOM,
  derivePresetId,
  findPreset,
} from "../settings/provider-presets";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

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
// Trigger glyph: a lucide Brain, the Settings runtime section's icon -- the
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
  // means untouched -- the picker's OWN fallback then renders the built-in
  // default; showing the startup resolution is the caller's pre-seeding,
  // not a picker-side read.
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
  const { data: runtimeData, error: runtimeError } = useQuery({
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

  // The turn-end live currents (issue #586, ADR-0095 Decision 5): the
  // session discovery cache records what the last turn ACTUALLY ran -- the
  // ACP handshake currents, the claude system{init} model (codex turns
  // report no discovery, so its cache never exists). The provenance gate is
  // strict: only a cache stamped by the ACTIVE adapter may be asserted as
  // this runtime's last turn -- another adapter's cache is a stale fact
  // (the #529 note covers it) and a pre-stamp cache is an unattributable
  // one. Display-layer only (ADR-0100 constraint): the live currents render
  // the unselected label; they never write the posture.
  const liveDiscovered =
    isExternal &&
    discovered != null &&
    discovered.adapter_id != null &&
    discovered.adapter_id === activeAdapterId
      ? discovered
      : null;

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

  // Latest caller-held pending posture, mirrored in an effect for the async
  // rollback guard below: the IPC reject handler must compare against the
  // CURRENT pair, not the render snapshot its closure captured (issue #592).
  const pendingPostureRef = useRef(pendingModelPosture);
  useEffect(() => {
    pendingPostureRef.current = pendingModelPosture;
  }, [pendingModelPosture]);

  // Monotonic posture-gesture counter (issue #592): every pending write
  // bumps it, so a reject handler can tell whether ANY later gesture fired
  // after its own -- a repeat of the SAME clear re-writes an equal pair the
  // value check alone cannot distinguish from "no later gesture".
  const postureGestureSeqRef = useRef(0);

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
    const clearedPosture: ModelPosture = { ...posture, ...patch };
    const gestureSeq = ++postureGestureSeqRef.current;
    // A new gesture is a fresh write attempt: clear any fault a previous
    // rejected one left on the set-fault slot (the applyModelConfig
    // symmetry on the in-session side).
    setModelSetError(null);
    onPendingModelPostureChange(clearedPosture);
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
          //
          // Lost-update guard (issue #592): the rollback restores
          // prevPosture only while the pending pair still equals THIS
          // clear's patch AND no later posture gesture has fired (the
          // counter; a same-value repeat would slip past the value check
          // alone). A later gesture (or the caller's runtime-switch reset
          // to null) means a newer intent -- restoring the pre-clear
          // snapshot then would silently clobber it.
          const current = pendingPostureRef.current;
          const stillThisClear =
            gestureSeq === postureGestureSeqRef.current &&
            current != null &&
            current.model === clearedPosture.model &&
            current.thought_level === clearedPosture.thought_level;
          if (stillThisClear) {
            onPendingModelPostureChange(prevPosture);
          }
          // The failed clear surfaces on the shared set-fault line in BOTH
          // outcomes: rolled back, the bar would otherwise show the restored
          // entry with no explanation; skipped, the optimistic clear stays
          // displayed while the backfill entry survived -- the failure would
          // surface only at the NEXT cold start as the posture "coming back".
          setModelSetError(e);
          log.warn(
            "ComposerProviderPicker",
            stillThisClear
              ? "clear startup posture failed; rolled the pending clear back"
              : "clear startup posture failed; pending posture moved on, rollback skipped",
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
        // The caller resets the pending posture to null on a runtime switch
        // (App's handlePendingRuntimeChange; ADR-0100 D2 namespacing) -- a
        // reset that bypasses pendingPostureWrite and so bumps no gesture
        // counter. Bump it in the same task so a still-in-flight clear
        // reject from the previous runtime cannot roll its pre-clear
        // posture over the reset even if it lands before the ref mirror
        // flushes.
        ++postureGestureSeqRef.current;
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
      // The switch also re-seeded the posture slot server-side from the
      // target adapter's backfill entry (ADR-0102 Decision 3, issue #590)
      // -- invalidate so the model button refetches the seeded pair
      // instead of lingering on the old adapter's stale one. The seeded
      // value lives server-side (the backfill map read), so an invalidate +
      // refetch is the honest path -- no local projection of the entry.
      void queryClient.invalidateQueries({
        queryKey: sessionKeys.modelConfig(sessionId),
      });
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

  const activeProfile = findActiveProfile(provider);
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
  const heldParts = [posture.model, posture.thought_level].filter(
    (part): part is string => part != null && part !== "",
  );
  const liveParts = [
    liveDiscovered?.current_model,
    liveDiscovered?.current_thought_level,
  ].filter((part): part is string => part != null && part !== "");
  // The tooltip's live payload: the turn-end currents, read as facts only
  // while nothing is held (a selection always outranks the live read) and
  // only alongside a catalog -- the trigger drops the tooltip on its
  // static-label early return, so a claude session whose per-model catalog
  // still awaits its first settings probe keeps the live read unsurfaced
  // instead of half-rendered.
  const liveValue =
    postureCatalog != null &&
    heldParts.length === 0 &&
    liveParts.length > 0
      ? liveParts.join(" · ")
      : null;
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
        setFault={modelSetError}
        persistFault={modelPersistFault}
        persistSuspended={modelPersistSuspended}
        catalogNote={catalogNote}
        disabled={modelSwitching}
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
                    Brain icon. Still NOT a provider logo (ADR-0071); the
                    aria-label + tooltip are unchanged. */}
                  <Brain className="size-4 shrink-0" aria-hidden />
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
