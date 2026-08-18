import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import {
  getAdapterCatalogs,
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
import type { ProfileKeyStatus, ProviderConfig } from "../../types/provider";
import type { SaveError } from "../../types/session";
import type {
  AdapterEntry,
  CatalogModel,
  SessionModelConfig,
  SessionRuntimeChoice,
} from "../../types/runtime";
import { RUNTIME_CHOICE_DEFAULT } from "../../types/runtime";

// The honest default while the model-config read settles (and on the
// cold-start bar, where there is no session to read): no selection, no
// discovery cache. The CLI's own defaults rule the next turn.
const MODEL_CONFIG_DEFAULT: SessionModelConfig = {
  model: null,
  thought_level: null,
  cached_discovered: null,
};
import {
  PRESET_CUSTOM,
  derivePresetId,
  findPreset,
} from "../settings/provider-presets";
import type { RuntimeTab } from "../settings/RuntimeSection";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Composer runtime picker (issue #238 / #353, ADR-0071/0081/0085/0091). A
// dual-segment popover at the QuestionBar edge that selects which runtime
// drives the NEXT turn:
//   - built-in group (ADR-0081) -- the BYOK Rust agent loop on the active
//     profile + model. The profile RECORDS come from the parent's provider
//     prop; the model + key-status surfaces are ADR-0071's picker, kept as
//     the built-in group's body.
//   - external group (ADR-0085) -- the v1 ACP adapters (`list_adapters`,
//     dynamic, NOT hardcoded): only detected rows render (issue #490 slimmed
//     this group to a pure selector -- adapter management moved to the
//     Settings Runtime "Local CLI" tab, ADR-0091). A "Manage external
//     runtimes" link at the bottom opens that tab.
//
// Trigger: a lucide Zap icon button (a unified entry glyph, NOT a provider
// logo; ADR-0071). Hover Tooltip: an honest "{provider} · {model}" preview for
// the built-in runtime (+ an honest "no key" mark when the active profile has
// no key, ADR-0019) or the external adapter name. Click Popover: the heavy
// dual-segment panel.
//
// Runtime state ownership: the per-session CHOICE is backend truth, read via
// `getSessionRuntime` under the session-prefix query (a close drops it with
// the rest; a resume lands the reset built-in value via the fresh SessionPane
// mount, mirroring authMode). Writes go through `setSessionRuntime` and take
// effect at the NEXT turn boundary -- the in-flight turn, if any, finishes on
// the runtime it started on. A rejected write (session dropped mid-flight,
// mid-resume swap) keeps the server posture -- the picker resyncs via
// refetch and never shows a runtime the backend did not grant.
//
// Profile + model + key-status ownership is unchanged from ADR-0071: profile
// records are single-sourced from the provider prop; the per-profile has_key
// overlay is fetched on mount AND on a profileKeyEpoch bump; writes route
// through onSwitchActive / onSwitchModel. The two "open settings" entries
// (built-in "Open settings" → API Access tab; external "Manage external
// runtimes" → Local CLI tab) close the popover BEFORE opening the overlay --
// PopoverContent is portaled to document.body, so it would otherwise stay
// visible atop the settings view (ADR-0065 hides the session shell via CSS,
// not the portal host).

export type ComposerProviderPickerProps = {
  // The session whose runtime this picker reads / switches. Runtime selection
  // is per-session assembly posture (ADR-0083), like the auth-mode chip.
  // null on the cold-start shell-level bar (ADR-0092): the picker displays
  // the caller-held pending value (pendingRuntime below) and writes runtime
  // switches to it via onPendingRuntimeChange instead of per-session IPC.
  sessionId: string | null;
  // The non-secret provider config (profiles list + active id), single-sourced
  // by the parent from app-config. This component never mutates it.
  provider: ProviderConfig;
  // Commit a new active_profile id (one-shot app-config write; live_config
  // reads it fresh on the next turn, ADR-0064). Routes through switchActiveProfile.
  onSwitchActive: (id: string) => void;
  // Commit a new model onto the ACTIVE profile (writes profile.model via
  // commitAppConfig, ADR-0071). Fired on blur / Enter, NOT per keystroke.
  onSwitchModel: (model: string) => void;
  // Open the Settings overlay on the Runtime section, landing on the named
  // sub-tab (ADR-0065, issue #490). The popover closes first.
  onOpenSettings: (runtimeTab: RuntimeTab) => void;
  // Invalidation counter for the per-profile has_key overlay. Bumped by the
  // parent (App) on settings-close -- a Settings Save may have changed a
  // keychain slot, so the mount-time fetch effect re-runs on a bump and the
  // badge does not show a stale "No key" after the user just configured one
  // (ADR-0019 honest gate). Undefined = mount-only fetch (the mount-only
  // contract, retained for tests that exercise the picker in isolation).
  profileKeyEpoch?: number;
  // When sessionId is null (cold-start bar, ADR-0092), a runtime selection
  // writes to the shell-level pending state via this callback instead of the
  // per-session IPC. The caller holds the pending value and applies it when a
  // session is created. Undefined when sessionId is non-null (the picker writes
  // through setSessionRuntime as before).
  onPendingRuntimeChange?: (runtime: SessionRuntimeChoice) => void;
  // The shell-level pending runtime value to DISPLAY while sessionId is null
  // (issue #572, ADR-0098 Decision 4): the caller seeds it with the resolved
  // default_runtime and replaces it on each onPendingRuntimeChange, so the
  // trigger reflects the startup resolution before the first pick and the
  // pick after it (the auth-mode chip's pendingMode pattern). Meaningful only
  // when sessionId is null; the session query is the truth otherwise.
  pendingRuntime?: SessionRuntimeChoice;
};

export function ComposerProviderPicker({
  sessionId,
  provider,
  onSwitchActive,
  onSwitchModel,
  onOpenSettings,
  profileKeyEpoch,
  onPendingRuntimeChange,
  pendingRuntime,
}: ComposerProviderPickerProps) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  // Per-profile has_key overlay (issue #154 / ADR-0029). Fetched on mount AND
  // on a profileKeyEpoch bump -- App bumps the epoch on settings-close so a
  // Settings Save that changed a keychain slot is reflected without a remount
  // (ADR-0019 honest gate: the popover must not keep showing "No key" after the
  // user just configured one). A profile switch never refetches -- it moves the
  // active pointer, not the keys.
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
  // caller-held pendingRuntime drives the picker -- no IPC round-trip. The
  // constant is the last resort (tests rendering the picker in isolation), so
  // an unseeded cold start renders the built-in default rather than nothing.
  const queryClient = useQueryClient();
  const { data: runtimeData } = useQuery({
    // The queryKey uses a stable placeholder when sessionId is null — the key
    // is inert (enabled:false prevents the queryFn from running, so no IPC).
    queryKey: sessionKeys.runtime(sessionId ?? ""),
    // `as string` is safe: enabled:false guarantees sessionId is non-null
    // when the queryFn executes, so no fake empty-string session ID reaches
    // the backend.
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
  // the query (the cold-start bar has no session to configure). A turn's
  // completion refetches this via the useTurnFlow invalidation of the session
  // prefix, landing the fresh catalog (dedupe is inherent: the backend cache
  // is single-slot).
  const { data: modelConfigData, error: modelConfigError } = useQuery({
    queryKey: sessionKeys.modelConfig(sessionId ?? ""),
    queryFn: () => getSessionModelConfig(sessionId as string),
    enabled: sessionId !== null,
  });
  const modelConfig: SessionModelConfig = modelConfigData ?? MODEL_CONFIG_DEFAULT;
  const discovered = modelConfig.cached_discovered;
  // Honest read failure (issue #529): a rejected get must NOT fall through to
  // the pending-discovery hint (that would masquerade an IPC failure as "no
  // catalog yet"). Rendered as an inline error line instead of the selectors.
  const modelConfigFault = modelConfigError
    ? fmtError(modelConfigError, intl)
    : null;
  // The v1 adapter table (session-agnostic, ADR-0081/0083). Issue #490 slimmed
  // the external group to a pure selector: only detected rows render (adapter
  // management moved to Settings → Runtime → Local CLI, ADR-0091). The list
  // reads the shared adapterKeys.all() cache (the same key LocalCliTab uses);
  // App.tsx invalidates it on Settings close so the next popover open reflects
  // any rescan the user ran in the Local CLI tab.
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
  // of the selector list. Surface this so the user knows their current pick is
  // broken before the next turn fails in the backend.
  // The active adapter's stream format decides the selector surface
  // (ADR-0095/0097): ACP adapters render dropdowns fed by handshake
  // discovery; the per-model catalog formats (codex_event_stream /
  // claude_stream_json) render probe-cache-fed per-model dropdowns once
  // tested, read-only CLI Default labels before. The format rides the
  // adapter table row -- never a hardcoded CLI id (adding an adapter
  // upstream needs zero frontend change). The dispatch enumerates the
  // per-model kinds explicitly (not `!== "acp"`): a future fourth format
  // must be classified here deliberately, never default into a surface.
  const isPerModelCatalogAdapter =
    isExternal &&
    activeAdapter != null &&
    (activeAdapter.stream_format === "codex_event_stream" ||
      activeAdapter.stream_format === "claude_stream_json");

  const activeAdapterStale = isExternal && activeAdapterId !== null && activeAdapter === null;

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
  // selector directory comes from, per the active runtime's stream format.
  //   ACP:                  session cached_discovered (this CLI's live
  //                         handshake truth) -> the global probe cache entry
  //                         for THIS adapter (an explicit user test in
  //                         Settings; keyed by adapter id so it can never
  //                         hold another runtime's catalog) -> empty +
  //                         guidance.
  //   codex / claude-code:  the probe cache's per-model entry for THIS
  //                         adapter only (these runtimes report no session
  //                         selector catalog; without a cache the surface
  //                         stays the read-only CLI Default labels -- honest
  //                         rendering, no invented directory). claude-code
  //                         annotates the labels with the last turn's
  //                         system{init} current model when known.
  const { data: cachedCatalogsData } = useQuery({
    queryKey: adapterKeys.catalogs(),
    queryFn: getAdapterCatalogs,
  });
  const cachedCatalogs = cachedCatalogsData ?? {};
  const probeEntry =
    isExternal && activeAdapterId !== null
      ? (cachedCatalogs[activeAdapterId] ?? null)
      : null;

  // The catalog feeding the ACP selectors after the fallback resolves.
  // (The cache entry is a tagged union on `probe_kind` -- the check narrows
  // `outcome` directly.)
  const acpCatalog =
    isExternal && !isPerModelCatalogAdapter
      ? (discovered ??
        (probeEntry && probeEntry.probe_kind === "acp"
          ? probeEntry.outcome.acp.discovered
          : null))
      : null;
  // True when the ACP selectors are fed by the probe cache rather than the
  // session's own discovery (drives the provenance note: the session cache
  // replaces it after this runtime's next turn).
  const acpCatalogFromProbe =
    acpCatalog != null && discovered == null && probeEntry != null;

  // The per-model catalog when the probe cache holds one for this format
  // (null keeps the read-only CLI Default labels). The tagged union's
  // `probe_kind` narrows the outcome variant; a kind that does not match
  // the active format cannot occur (entries are keyed by adapter id) but
  // degrades to null instead of guessing.
  const perModelCatalog =
    isPerModelCatalogAdapter && probeEntry
      ? probeEntry.probe_kind === "codex_event_stream"
        ? probeEntry.outcome.codex_event_stream.models
        : probeEntry.probe_kind === "claude_stream_json"
          ? probeEntry.outcome.claude_stream_json.models
          : null
      : null;

  // Guards the two set IPCs (one at a time; the second picker is disabled
  // while the first write is in flight).
  const [modelSwitching, setModelSwitching] = useState(false);
  // Inline failure line for the two set IPCs (issue #529), same slot /
  // styling as the keysError precedent. Holds the raw reject and formats at
  // render so a locale switch re-renders the wording. Cleared on the next
  // attempt.
  const [modelSetError, setModelSetError] = useState<unknown>(null);
  // A set that resolved but whose persist-now leg did not land (issue #529):
  // the verdict rides the set command's return (in-process, read in the same
  // critical section), so "set means persisted" (ADR-0095 Decision 6) cannot
  // break silently nor be swallowed by the shared banner error channel.
  const [modelPersistFault, setModelPersistFault] = useState<SaveError | null>(null);
  // True when the persist was withheld on a pending ADR-0035 conflict (the
  // .duck changed externally; the auto-write refuses to clobber it).
  const [modelPersistSuspended, setModelPersistSuspended] = useState(false);

  // Shared write sequence for both selectors (the two bodies differ only in
  // the IPC, the patched key, and the log verb). On resolve: seed the cache
  // with the granted posture and project the returned persist verdict onto
  // the two fault slots. On reject: keep the server posture (refetch off the
  // reject) + show the failure. Returns whether the write was GRANTED (a
  // dropped click or a reject yields false) -- the codex model->effort
  // linkage gates its clearing write on it.
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
      // Functional update: a later selection in the same popover session
      // must patch the CURRENT cache, not the snapshot this closure captured
      // at render -- two rapid selections (e.g. a model pick that auto-clears
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
    const granted = await applyModelConfig(
      () => setSessionModel(sessionId as string, model),
      { model },
      "model",
    );
    if (!granted) return;
    // Per-model linkage (issue #537, shared by codex + claude-code): the
    // thought level must sit in the newly selected model's supported set. A
    // held level outside that set (including every held level once the
    // model pick is cleared -- no model means no supported set at all) is
    // cleared via the existing set IPC, in the SAME user gesture --
    // awaiting the model write first means applyModelConfig's switching
    // gate has re-opened and the clear cannot be swallowed. A rejected
    // model write returns early: the held level stays against the
    // still-held model.
    if (perModelCatalog) {
      const supported = supportedEffortsFor(perModelCatalog, model);
      if (
        modelConfig.thought_level != null &&
        !supported.includes(modelConfig.thought_level)
      ) {
        await selectThoughtLevel(null);
      }
    }
  };

  const selectThoughtLevel = (thoughtLevel: string | null) =>
    applyModelConfig(
      () => setSessionThoughtLevel(sessionId as string, thoughtLevel),
      { thought_level: thoughtLevel },
      "thought level",
    );

  // Per-model helper (issue #537, codex + claude-code): the thought-level
  // list for the given model id -- that model's supported efforts in the
  // CLI's declared order (never a union across models). Null / unknown
  // model: no entries (the level selector disables with a "pick a model
  // first" hint).
  function supportedEffortsFor(
    models: CatalogModel[],
    modelId: string | null,
  ): string[] {
    if (modelId == null) return [];
    return models.find((m) => m.id === modelId)?.supported_reasoning_efforts ?? [];
  }

  // Guards the write window: a click that lands while the set IPC is in flight
  // is dropped instead of re-firing (the disabled attr is the visual half of
  // the same gate).
  const [switching, setSwitching] = useState(false);

  async function selectRuntime(next: SessionRuntimeChoice) {
    if (switching) return;
    // Null sessionId (cold-start bar, ADR-0092): write to the caller-held
    // pending state. No IPC, no switching gate -- the write is synchronous.
    // When the callback is absent the selection is logged and discarded so
    // an unwired cold-start bar is observable instead of silently swallowed.
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

  const activeProfile = provider.profiles.find(
    (p) => p.id === provider.active_profile,
  );
  const unnamed = intl.formatMessage({
    id: "settings.profiles.unnamed",
    defaultMessage: "Unnamed profile",
  });
  const model = activeProfile?.model ?? "";
  const activeStatus = activeProfile ? profileKeys[activeProfile.id] : undefined;
  const hasKey = activeStatus?.has_key ?? false;
  const keychainFault = activeStatus?.keychain_fault ?? null;

  // The provider readout = the preset the active profile sits on (e.g.
  // "Anthropic"); falls back to the profile's own display name when the endpoint
  // is Custom. A unified, non-trademark provider label (ADR-0071).
  const presetId = activeProfile
    ? derivePresetId({
        protocol: activeProfile.protocol,
        base_url: activeProfile.base_url,
      })
    : PRESET_CUSTOM;
  const preset = presetId === PRESET_CUSTOM ? undefined : findPreset(presetId);
  // Zero-profile built-in posture (ADR-0098 D1, issue #570): with an empty
  // profile set the readout says "Not configured" -- never "Unnamed profile"
  // (nothing is mislabeled) and never a "default" label (the four-state model
  // display is issue #573's surface).
  const noProfiles = provider.profiles.length === 0;
  const notConfigured = intl.formatMessage({
    id: "composer.providerPicker.notConfigured",
    defaultMessage: "Not configured",
  });
  const providerName = noProfiles
    ? notConfigured
    : (preset?.display_name ?? activeProfile?.display_name.trim() ?? unnamed);

  // Tooltip preview text (also Radix Tooltip's aria-describedby content, so SR
  // users hear the live context on trigger focus). The honest "no key" mark is
  // appended when the active profile has no key (ADR-0019). Each formatMessage
  // id is a static literal at the call site so @formatjs/cli extract resolves
  // them (ADR-0052 CI gate).
  const summary = intl.formatMessage(
    {
      id: "composer.providerPicker.tooltip",
      defaultMessage: "{provider} · {model}",
    },
    { provider: providerName, model: model || "—" },
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
  // shows the Zap glyph alone; the tooltip is where the user reads WHICH
  // runtime the next turn will use). Falls back to the raw id if the adapter
  // row has not loaded yet.
  const externalTooltip = intl.formatMessage(
    {
      id: "composer.runtimePicker.tooltip.external",
      defaultMessage: "External runtime: {adapter}",
    },
    { adapter: activeAdapter?.display_name ?? activeAdapterId ?? "" },
  );
  const builtInTooltip = noProfiles
    ? notConfigured
    : keychainFault
      ? `${summary} · ${keychainUnavailableMark}`
      : hasKey
        ? summary
        : `${summary} · ${noKeyMark}`;
  const tooltipText = isExternal ? externalTooltip : builtInTooltip;

  // Model field draft. The popover's model input commits on blur / Enter, NOT
  // per keystroke -- a model id is multi-character and per-keystroke writes
  // would spam commitAppConfig (one IPC per character). The draft re-syncs to
  // the prop when the (active profile, model) pair it was seeded from changes:
  // a profile switch loads the new profile's model, AND an external model change
  // (e.g. a Settings Save that rewrites profile.model via commitAppConfig, or
  // this picker's own committed write landing back via the optimistic state)
  // refreshes the field so it never shows a stale value. Typing does NOT trip
  // it -- modelDraft moves on each keystroke but the `model` prop is constant
  // between commits. Same render-time "adjust state when a value changes"
  // pattern as ProviderKeyField's profile-id reset -- avoids the
  // set-state-in-effect lint. See https://react.dev/learn/you-might-not-need-an-effect
  const [modelDraft, setModelDraft] = useState(model);
  const [draftSeed, setDraftSeed] = useState({
    id: provider.active_profile,
    model,
  });
  if (provider.active_profile !== draftSeed.id || model !== draftSeed.model) {
    setDraftSeed({ id: provider.active_profile, model });
    setModelDraft(model);
  }

  function commitModel() {
    const trimmed = modelDraft.trim();
    // No-op on an empty draft or when the value did not change.
    if (trimmed && trimmed !== model) onSwitchModel(trimmed);
  }

  function handleOpenSettings(tab: RuntimeTab) {
    // Close BEFORE opening: the portaled PopoverContent would otherwise remain
    // visible atop the settings overlay (ADR-0065 hides the shell via CSS, not
    // the portal host in document.body).
    setOpen(false);
    onOpenSettings(tab);
  }

  // Unique per-instance id for the model <datalist> (multiple keep-alive
  // SessionPanes each render a picker -- a profile-derived id would collide
  // across instances since all share the same active profile).
  const datalistId = useId();

  return (
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
              <Zap className="size-4" aria-hidden />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>

      <PopoverContent align="start" className="w-80">
        <div className="grid gap-3">
          {/* --- Built-in runtime group (ADR-0081, issue #353) -----------------
              The BYOK Rust agent loop on the active profile + model. The
              header is a select affordance (click reverts to built-in); the
              profile + model + key-status body is ADR-0071's picker, kept
              intact so the user configures the built-in profile here. */}
          <section className="grid gap-2">
            <button
              type="button"
              disabled={switching}
              onClick={() => void selectRuntime({ kind: "built_in" })}
              aria-pressed={!isExternal}
              className="flex items-center gap-2 text-sm font-medium cursor-pointer disabled:pointer-events-none disabled:opacity-50"
            >
              <RuntimeDot selected={!isExternal} />
              <FormattedMessage
                id="composer.runtimePicker.builtinTitle"
                defaultMessage="Built-in"
              />
            </button>
            {/* Profile dropdown -- switches active_profile. */}
            <Label className="grid gap-1">
              <FormattedMessage
                id="composer.providerPicker.profileLabel"
                defaultMessage="Profile"
              />
              {/* Native <select> (precedent: ProviderPresetField) styled to
                  match Input. No Radix Select primitive for a single picker
                  (KISS). Zero profiles: disabled with a single placeholder
                  option -- nothing to switch (ADR-0098 D1). */}
              <select
                value={provider.active_profile ?? ""}
                onChange={(e) => onSwitchActive(e.target.value)}
                disabled={noProfiles}
                className={cn(
                  "border-input flex h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none",
                  "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {noProfiles && <option value="">{notConfigured}</option>}
                {provider.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name.trim() || unnamed}
                  </option>
                ))}
              </select>
            </Label>

            {/* Model field. Hand-typed input + a <datalist> offering the
                active preset's default_model. NO network request (no
                list-models probe) -- opening the popover never blocks on the
                network; model accuracy is the Settings preflight's job
                (#236, ADR-0070). */}
            <Label className="grid gap-1">
              <FormattedMessage id="settings.profiles.model" defaultMessage="Model" />
              <Input
                type="text"
                list={datalistId}
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                disabled={activeProfile == null}
                onBlur={commitModel}
                onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                  if (e.key === "Enter") {
                    // The portaled input is not inside the QuestionBar form,
                    // but Enter should commit rather than do anything
                    // unexpected.
                    e.preventDefault();
                    commitModel();
                  }
                }}
              />
              <datalist id={datalistId}>
                {/* Offer the preset's default model only when the active
                    profile is on a named preset (Custom has no canonical
                    default). */}
                {preset && <option value={preset.default_model} />}
              </datalist>
              <span className="text-muted-foreground text-xs">
                <FormattedMessage
                  id="composer.providerPicker.modelHint"
                  defaultMessage="Type a model id, or pick the preset default."
                />
              </span>
            </Label>

            {/* Key status. Honest mark when the active profile has no key
                (ADR-0019) -- the badge + the explicit "asking will fail"
                line, the built-in group's "unconfigured + guidance" surface. */}
            <div className="flex items-center gap-2 text-sm">
              {keychainFault ? (
                <Badge variant="outline" title={keychainFault}>
                  <FormattedMessage
                    id="settings.profiles.keychainUnavailable"
                    defaultMessage="Keychain unavailable"
                  />
                </Badge>
              ) : (
                <Badge variant={hasKey ? "secondary" : "outline"}>
                  {hasKey ? (
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
              )}
              {keychainFault ? (
                <span className="text-muted-foreground">
                  <FormattedMessage
                    id="settings.profiles.keychainUnavailableHint"
                    defaultMessage="The OS keychain could not be read (it may be locked, or the service is down). Check the OS keychain, then retry."
                  />
                </span>
              ) : !hasKey ? (
                <span className="text-muted-foreground">
                  {noProfiles ? (
                    <FormattedMessage
                      id="composer.providerPicker.notConfiguredHint"
                      defaultMessage="No access profile yet. Create one in Settings."
                    />
                  ) : (
                    <FormattedMessage
                      id="settings.profiles.key.hintUnset"
                      defaultMessage="No key saved for this profile — asking with this profile active will return a “not configured” failure."
                    />
                  )}
                </span>
              ) : null}
            </div>
            {keysError && <p className="text-destructive text-sm">{keysError}</p>}

            {/* Open settings entry (ADR-0065 overlay) -- lands on the API
                Access sub-tab (issue #490). */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => handleOpenSettings("api-access")}
            >
              <FormattedMessage
                id="common.openSettings"
                defaultMessage="Open settings"
              />
            </Button>
          </section>

          {/* --- External runtime group (ADR-0085, issue #353/#490) -----------
              The v1 ACP adapters, read dynamically from list_adapters (never
              hardcoded). Issue #490 slimmed this group to a pure selector:
              only detected rows render (the list is pre-filtered), and adapter
              management moved to Settings → Runtime → Local CLI (ADR-0091). */}
          <div className="border-t border-border" />
          <section className="grid gap-1.5">
            <span className="text-sm font-medium">
              <FormattedMessage
                id="composer.runtimePicker.externalTitle"
                defaultMessage="External"
              />
            </span>
            {activeAdapterStale && (
              <p className="text-xs text-destructive">
                <FormattedMessage
                  id="composer.runtimePicker.staleAdapter"
                  defaultMessage="Selected adapter is no longer detected — pick another or manage in settings."
                />
              </p>
            )}
            {adapters.map((a) => {
              const selected = isExternal && activeAdapterId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={switching}
                  onClick={() => void selectRuntime({ kind: "external", data: a.id })}
                  aria-pressed={selected}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer disabled:pointer-events-none disabled:opacity-50",
                    selected ? "bg-muted" : "hover:bg-muted",
                  )}
                >
                  <RuntimeDot selected={selected} />
                  <span className="flex-1 text-left text-foreground">
                    {a.display_name}
                  </span>
                </button>
              );
            })}
            {/* --- Model + thought-level selectors (ADR-0095/0096/0097,
                #527/#537/#561) - Rendered only when an external adapter is
                the ACTIVE runtime (a selection is meaningless on the
                built-in profile picker). The directory follows the priority
                chain (ADR-0096 D6): an ACP adapter takes the session's
                cached discovery, else the probe-cache entry for this
                adapter (dropdowns either way; no source at all renders the
                pending-discovery hint plus the settings-test entry). The
                per-model formats (codex / claude-code) have no turn-path
                selector discovery: the probe-cache entry feeds real
                per-model dropdowns, and without it the surface stays the
                read-only CLI Default labels. */}
            {isExternal && modelConfigFault != null && (
              <p className="text-destructive px-2 pb-1 text-xs">
                <FormattedMessage
                  id="composer.runtimePicker.loadError"
                  defaultMessage="Could not load model options: {reason}"
                  values={{ reason: modelConfigFault }}
                />
              </p>
            )}
            {isExternal &&
              catalogProvenanceStale &&
              modelConfigFault == null && (
              <p className="text-warning px-2 pb-1 text-xs">
                <FormattedMessage
                  id="composer.runtimePicker.staleCatalog"
                  defaultMessage="These options were discovered on a different runtime — they will refresh after this runtime's next turn."
                />
              </p>
            )}
            {isExternal &&
              modelConfigFault == null &&
              (isPerModelCatalogAdapter ? (
                perModelCatalog ? (
                  <ModelCatalogSelectors
                    models={perModelCatalog}
                    model={modelConfig.model}
                    thoughtLevel={modelConfig.thought_level}
                    switching={modelSwitching}
                    onSelectModel={selectModel}
                    onSelectThoughtLevel={selectThoughtLevel}
                    setError={modelSetError}
                    persistFault={modelPersistFault}
                    persistSuspended={modelPersistSuspended}
                    intl={intl}
                  />
                ) : (
                  <div className="grid gap-1.5 px-2 pb-1">
                    <span className="text-muted-foreground text-xs font-medium">
                      <FormattedMessage
                        id="composer.runtimePicker.modelLabel"
                        defaultMessage="Model"
                      />
                    </span>
                    {/* Honest rendering (ADR-0097 Decision 5): before any
                        probe there is no directory to offer -- the label
                        stays the CLI default, annotated with the last
                        turn's system{init} current model when one is known
                        (claude-code reports it; codex never does). Scoped
                        to THIS adapter's own provenance: a residual catalog
                        from another runtime must not annotate this one. */}
                    <p className="text-muted-foreground text-xs">
                      {discovered?.current_model &&
                        discovered?.adapter_id === activeAdapterId ? (
                            <FormattedMessage
                              id="composer.runtimePicker.cliDefaultWithModel"
                              defaultMessage="CLI default ({model})"
                              values={{ model: discovered.current_model }}
                            />
                          ) : (
                            <FormattedMessage
                              id="composer.runtimePicker.cliDefault"
                              defaultMessage="CLI default"
                            />
                          )}
                    </p>
                    <span className="text-muted-foreground text-xs font-medium">
                      <FormattedMessage
                        id="composer.runtimePicker.thoughtLevelLabel"
                        defaultMessage="Thinking"
                      />
                    </span>
                    <p className="text-muted-foreground text-xs">
                      <FormattedMessage
                        id="composer.runtimePicker.cliDefault"
                        defaultMessage="CLI default"
                      />
                    </p>
                    <TestInSettingsHint onOpenSettings={handleOpenSettings} />
                  </div>
                )
              ) : acpCatalog ? (
                <div className="grid gap-1.5 px-2 pb-1">
                  {acpCatalogFromProbe && (
                    <p className="text-muted-foreground text-xs">
                      <FormattedMessage
                        id="composer.runtimePicker.catalogFromProbe"
                        defaultMessage="Options from your last settings test — this runtime's live list appears after its next turn."
                      />
                    </p>
                  )}
                  <span className="text-muted-foreground text-xs font-medium">
                    <FormattedMessage
                      id="composer.runtimePicker.modelLabel"
                      defaultMessage="Model"
                    />
                  </span>
                  <select
                    aria-label={intl.formatMessage({
                      id: "composer.runtimePicker.modelLabel",
                      defaultMessage: "Model",
                    })}
                    value={modelConfig.model ?? acpCatalog.current_model ?? ""}
                    disabled={modelSwitching}
                    onChange={(e) => void selectModel(e.target.value || null)}
                    className={cn(
                      "border-input flex h-8 w-full min-w-0 rounded-md border bg-transparent px-2 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none cursor-pointer",
                      "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50",
                    )}
                  >
                    <SelectorOptions
                      discoveredValues={acpCatalog.models}
                      currentValue={acpCatalog.current_model}
                      selected={modelConfig.model}
                      defaultLabel={intl.formatMessage({
                        id: "composer.runtimePicker.cliDefault",
                        defaultMessage: "CLI default",
                      })}
                      unrepresentedLabel={intl.formatMessage(
                        {
                          id: "composer.runtimePicker.unrepresentedModel",
                          defaultMessage: "{id} (not offered by this runtime)",
                        },
                        { id: modelConfig.model ?? acpCatalog.current_model ?? "" },
                      )}
                    />
                  </select>
                  <span className="text-muted-foreground text-xs font-medium">
                    <FormattedMessage
                      id="composer.runtimePicker.thoughtLevelLabel"
                      defaultMessage="Thinking"
                    />
                  </span>
                  <select
                    aria-label={intl.formatMessage({
                      id: "composer.runtimePicker.thoughtLevelLabel",
                      defaultMessage: "Thinking",
                    })}
                    value={
                      modelConfig.thought_level ??
                      acpCatalog.current_thought_level ??
                      ""
                    }
                    disabled={modelSwitching}
                    onChange={(e) =>
                      void selectThoughtLevel(e.target.value || null)}
                    className={cn(
                      "border-input flex h-8 w-full min-w-0 rounded-md border bg-transparent px-2 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none cursor-pointer",
                      "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50",
                    )}
                  >
                    <SelectorOptions
                      discoveredValues={acpCatalog.thought_levels}
                      currentValue={acpCatalog.current_thought_level}
                      selected={modelConfig.thought_level}
                      defaultLabel={intl.formatMessage({
                        id: "composer.runtimePicker.cliDefault",
                        defaultMessage: "CLI default",
                      })}
                      unrepresentedLabel={intl.formatMessage(
                        {
                          id: "composer.runtimePicker.unrepresentedThoughtLevel",
                          defaultMessage: "{id} (not offered by this runtime)",
                        },
                        {
                          id:
                            modelConfig.thought_level ??
                            acpCatalog.current_thought_level ??
                            "",
                        },
                      )}
                    />
                  </select>
                  <SelectorFaultLines
                    setError={modelSetError}
                    persistFault={modelPersistFault}
                    persistSuspended={modelPersistSuspended}
                    intl={intl}
                  />
                </div>
              ) : (
                <div className="grid gap-1.5 px-2 pb-1">
                  <p className="text-muted-foreground text-xs">
                    <FormattedMessage
                      id="composer.runtimePicker.discoveryPending"
                      defaultMessage="Model options appear after the first turn on this runtime."
                    />
                  </p>
                  <TestInSettingsHint onOpenSettings={handleOpenSettings} />
                </div>
              ))}
            {/* Manage external runtimes -- opens Settings → Runtime → Local CLI
                (ADR-0091, issue #490). A button styled as a text link, to read
                as a secondary navigation affordance beneath the selector list. */}
            <button
              type="button"
              onClick={() => handleOpenSettings("local-cli")}
              className="mt-1 justify-self-start text-left text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <FormattedMessage
                id="composer.runtimePicker.manageExternal"
                defaultMessage="Manage external runtimes →"
              />
            </button>
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// The empty-directory guidance entry (ADR-0096 D6, issue #537): when neither
// the session catalog nor the probe cache offers options, a link-style
// button routes to Settings → Runtime → Local CLI where the explicit test
// populates the cache. Closes the popover first (same contract as the other
// open-settings entries).
function TestInSettingsHint({
  onOpenSettings,
}: {
  onOpenSettings: (tab: RuntimeTab) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenSettings("local-cli")}
      className="justify-self-start text-left text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      <FormattedMessage
        id="composer.runtimePicker.testInSettings"
        defaultMessage="Test the runtime in settings to get its model list →"
      />
    </button>
  );
}

// The per-model catalog selector surface (ADR-0096 D6, issue #537,
// ADR-0097): real dropdowns fed by the probe cache's per-model catalog,
// shared by the codex and claude-code formats (both carry the same
// CatalogModel shape). The model list comes from the cache; the
// thought-level list is the SELECTED model's supported efforts in the CLI's
// declared order (a union across models would offer "model A + an effort
// model A does not support"). With no model picked the level selector
// disables with a "pick a model first" hint -- there is no honest level
// list to offer. Selecting the "CLI default" row (value "") clears the
// selection via the existing set IPCs.
function ModelCatalogSelectors({
  models,
  model,
  thoughtLevel,
  switching,
  onSelectModel,
  onSelectThoughtLevel,
  setError,
  persistFault,
  persistSuspended,
  intl,
}: {
  models: CatalogModel[];
  model: string | null;
  thoughtLevel: string | null;
  switching: boolean;
  onSelectModel: (model: string | null) => void;
  onSelectThoughtLevel: (thoughtLevel: string | null) => void;
  setError: unknown;
  persistFault: SaveError | null;
  persistSuspended: boolean;
  intl: IntlShape;
}) {
  const selectedModel = model != null ? (models.find((m) => m.id === model) ?? null) : null;
  // The effective model the CLI would use: the explicit pick, else the
  // catalog's flagged default. Annotates the clearing row so the user can
  // tell "what the CLI would use" apart from "what I picked".
  const effectiveModel = selectedModel ?? (models.find((m) => m.is_default) ?? null);
  const supportedEfforts = selectedModel?.supported_reasoning_efforts ?? [];

  return (
    <div className="grid gap-1.5 px-2 pb-1">
      <span className="text-muted-foreground text-xs font-medium">
        <FormattedMessage
          id="composer.runtimePicker.modelLabel"
          defaultMessage="Model"
        />
      </span>
      <select
        aria-label={intl.formatMessage({
          id: "composer.runtimePicker.modelLabel",
          defaultMessage: "Model",
        })}
        value={model ?? ""}
        disabled={switching}
        onChange={(e) => onSelectModel(e.target.value || null)}
        className={cn(
          "border-input flex h-8 w-full min-w-0 rounded-md border bg-transparent px-2 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none cursor-pointer",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        <SelectorOptions
          discoveredValues={models.map((m) => m.id)}
          currentValue={effectiveModel?.id ?? null}
          selected={model}
          defaultLabel={intl.formatMessage({
            id: "composer.runtimePicker.cliDefault",
            defaultMessage: "CLI default",
          })}
          unrepresentedLabel={intl.formatMessage(
            {
              id: "composer.runtimePicker.unrepresentedModel",
              defaultMessage: "{id} (not offered by this runtime)",
            },
            { id: model ?? "" },
          )}
        />
      </select>
      <span className="text-muted-foreground text-xs font-medium">
        <FormattedMessage
          id="composer.runtimePicker.thoughtLevelLabel"
          defaultMessage="Thinking"
        />
      </span>
      {model == null ? (
        <p className="text-muted-foreground text-xs">
          <FormattedMessage
            id="composer.runtimePicker.pickModelFirst"
            defaultMessage="Pick a model to choose a thinking level."
          />
        </p>
      ) : (
        <select
          aria-label={intl.formatMessage({
            id: "composer.runtimePicker.thoughtLevelLabel",
            defaultMessage: "Thinking",
          })}
          value={thoughtLevel ?? ""}
          disabled={switching}
          onChange={(e) => onSelectThoughtLevel(e.target.value || null)}
          className={cn(
            "border-input flex h-8 w-full min-w-0 rounded-md border bg-transparent px-2 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none cursor-pointer",
            "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <SelectorOptions
            discoveredValues={supportedEfforts}
            currentValue={selectedModel?.default_reasoning_effort ?? null}
            selected={thoughtLevel}
            defaultLabel={intl.formatMessage({
              id: "composer.runtimePicker.cliDefault",
              defaultMessage: "CLI default",
            })}
            unrepresentedLabel={intl.formatMessage(
              {
                id: "composer.runtimePicker.unrepresentedThoughtLevel",
                defaultMessage: "{id} (not offered by this runtime)",
              },
              { id: thoughtLevel ?? "" },
            )}
          />
        </select>
      )}
      <SelectorFaultLines
        setError={setError}
        persistFault={persistFault}
        persistSuspended={persistSuspended}
        intl={intl}
      />
    </div>
  );
}

// The set-IPC fault lines (issue #529), shared by every selector surface
// that can write (the ACP dropdowns and the codex dropdowns): one surface
// for both set IPCs, same slot / styling as the keysError precedent.
function SelectorFaultLines({
  setError,
  persistFault,
  persistSuspended,
  intl,
}: {
  setError: unknown;
  persistFault: SaveError | null;
  persistSuspended: boolean;
  intl: IntlShape;
}) {
  return (
    <>
      {setError != null && (
        <p className="text-destructive text-xs">
          <FormattedMessage
            id="composer.runtimePicker.applyError"
            defaultMessage="Could not apply the selection: {reason}"
            values={{ reason: fmtError(setError, intl) }}
          />
        </p>
      )}
      {persistFault && (
        <p className="text-warning text-xs">
          <FormattedMessage
            id="composer.runtimePicker.persistFault"
            defaultMessage="Selection not saved: {reason}"
            values={{ reason: fmtError(persistFault, intl) }}
          />
        </p>
      )}
      {persistSuspended && (
        <p className="text-warning text-xs">
          <FormattedMessage
            id="composer.runtimePicker.persistSuspended"
            defaultMessage="Selection not saved: the session file was changed outside the app, so autosave is paused until you resolve the conflict."
          />
        </p>
      )}
    </>
  );
}

// The <option> rows for a discovered selector (ADR-0095): the discovered ids
// in order, plus a leading "CLI default" row meaning "no selection" (the
// CLI's own default rules the next turn). The discovery's reported current
// value is annotated when it is not already the selected id, so the user can
// tell "what the CLI would use" apart from "what I picked".
// Issue #529: when the value the backend actually holds (the session
// selection, or the CLI's reported current when nothing is selected) is NOT
// in the catalog, a synthetic fallback row keeps the <select> honest -- a
// controlled value with no matching option renders blank, hiding an active
// posture the user cannot see or clear. Selecting the fallback row is just
// selecting that id; the "CLI default" row still clears the selection.
function SelectorOptions({
  discoveredValues,
  currentValue,
  selected,
  defaultLabel,
  unrepresentedLabel,
}: {
  discoveredValues: string[];
  currentValue: string | null;
  selected: string | null;
  defaultLabel: string;
  unrepresentedLabel: string;
}) {
  // The value the <select> will resolve to (mirrors the callers' controlled
  // value chains: selection first, CLI current as the effective default).
  // An empty-string held value is NOT unrepresented -- it would collide
  // with the clearing row's value="" (the select resolves to the first
  // match, hiding the posture behind "CLI default").
  const held = selected ?? currentValue;
  const unrepresented =
    held != null && held !== "" && !discoveredValues.includes(held);
  return (
    <>
      <option value="">
        {currentValue && !selected
          ? `${defaultLabel} (${currentValue})`
          : defaultLabel}
      </option>
      {unrepresented && (
        <option value={held ?? undefined}>{unrepresentedLabel}</option>
      )}
      {discoveredValues.map((v) => (
        <option key={v} value={v}>
          {v}
          {currentValue === v && !selected ? ` (${defaultLabel})` : ""}
        </option>
      ))}
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
