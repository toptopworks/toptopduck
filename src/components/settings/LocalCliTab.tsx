import { useRef, useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { getAdapterCatalogs, listAdapters, probeAdapter, rescanAdapters } from "../../api";
import { adapterKeys } from "../../session/queryKeys";
import type {
  AdapterCatalogEntry,
  AdapterCatalogs,
  AdapterEntry,
  ModelCatalogOutcome,
  DiscoveredRuntime,
  ProbeError,
  ProbeOk,
} from "../../types/runtime";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  SETTINGS_TOOLTIP_CLASS,
  SettingsCard,
  SettingsRow,
} from "./settings-chrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Local CLI tab (issue #489, ADR-0091): the adapter management panel inside
// the Settings runtime section. Lists every v1 adapter from `listAdapters`
// (dynamic -- never hardcoded), each row showing the display name + detection
// state (detected shows the resolved binary path; not detected shows "Not
// installed"). A rescan button re-runs the PATH scan via `rescanAdapters` and
// refreshes the shared adapter cache (the same `adapterKeys.all()` the composer
// runtime picker reads).
//
// This panel is the management surface moved OUT of the composer popover
// (ADR-0091): the composer is purely selection, this tab is purely management.
// The composer's adapter list + rescan still work independently -- both read
// the same cache key.
//
// The per-adapter Test button (ADR-0096, issues #534/#535) runs the
// diagnostic probe: one-shot spawn + per-format query (ACP handshake / codex
// app-server `model/list`) + terminate. Every detected adapter gets the
// button; the busy state mirrors up via onIpcBusy("probe", ...) so the
// settings close guard blocks while the IPC is in flight (ADR-0075 pattern).
//
// Probe results render inside a per-row fold (issue #552, closing ADR-0096's
// open "parallel vs folded" display question): a chevron toggles the
// directory, a probe success auto-expands the row, and the collapsed row
// carries a summary badge (`N models` / `Test failed`). The fold mirrors the
// MCP panel's McpServerRow interaction (chevron + summary badge + render on
// demand); expansion state is component-local and unpersisted.

// One adapter's probe lifecycle: idle -> probing -> ok | failed. Local state
// by design (the result is an ephemeral diagnostic snapshot, not persisted
// config -- ADR-0096 D5 keeps the cache a separate slice).
type ProbeState =
  | { status: "idle" }
  | { status: "probing" }
  | { status: "ok"; result: ProbeOk }
  | { status: "failed"; error: ProbeError };

/** The kinds the backend can reject with -- the runtime kind allowlist for
 *  the reject-shape check in `handleProbe` (a `kind` field alone proves
 *  nothing: an unknown value would otherwise flow into `ProbeErrorText`
 *  and surface as a render-time contract-break throw instead of a
 *  degraded error row). */
const PROBE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "NotDetected",
  "SpawnFailure",
  "HandshakeFailure",
  "Timeout",
]);

/** Narrow an IPC reject to a `ProbeError`: a reject shaped like one (a known
 *  kind) passes through; anything else -- a non-shaped reject or an unknown
 *  kind (frontend/backend skew) -- degrades to the frontend-only
 *  `ProbeUnreachable`, never a false handshake failure or a render throw. */
function toProbeError(e: unknown): ProbeError {
  if (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    PROBE_ERROR_KINDS.has(e.kind as string)
  ) {
    return e as ProbeError;
  }
  return { kind: "ProbeUnreachable", data: String(e) };
}

/** The probe success block: dispatch on the per-format `kind` -- the ACP flat
 *  catalog or the JsonEventStream per-model catalog (ADR-0096 D2/D3). The
 *  switch is exhaustive with a `never` guard, mirroring `ProbeErrorText`: a
 *  new backend variant must fail at compile time here, not surface as a
 *  wrong-render throw at runtime. */
function ProbeResult({ result }: { result: ProbeOk }) {
  switch (result.kind) {
    case "acp":
      return <AcpProbeResult catalog={result.data.discovered} />;
    case "json_event_stream":
      return <JsonEventStreamProbeResult outcome={result.data.outcome} />;
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown probe ok kind: ${String(_exhaustive)}`);
    }
  }
}

/** One reasoning-effort thought level as a read-only small badge. The marked
 *  level (the CLI default or the current value) renders with the shared
 *  "default" annotation -- one marker shape across both catalogs. */
function EffortBadge({ level, marked }: { level: string; marked: boolean }) {
  const intl = useIntl();
  const defaultLabel = intl.formatMessage({
    id: "settings.runtime.localCli.probe.defaultMark",
    defaultMessage: "default",
  });
  return (
    <Badge
      variant="secondary"
      title={marked ? defaultLabel : undefined}
      className="text-muted-foreground font-mono font-normal"
    >
      {level}
      {marked ? ` (${defaultLabel})` : ""}
    </Badge>
  );
}

/** A row of read-only effort badges, one per supported level, in the CLI's
 *  declared order (never a union across models, ADR-0096 D3). Callers skip
 *  the whole group when the catalog carried no levels -- an absent list has
 *  nothing to show, no placeholder. */
function EffortBadgeGroup({
  levels,
  marked,
}: {
  levels: string[];
  marked: string | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {levels.map((level) => (
        <EffortBadge key={level} level={level} marked={level === marked} />
      ))}
    </span>
  );
}

/** The ACP success block: one model per line (the flat catalog carries no
 *  per-model efforts, so a line is just the id with the current one marked),
 *  plus the global thought-level badge row when the catalog reported any
 *  levels -- the same per-line shape as the JsonEventStream catalog so both
 *  folds read alike. An empty level list renders no row at all. */
function AcpProbeResult({ catalog }: { catalog: DiscoveredRuntime }) {
  const intl = useIntl();
  const defaultLabel = intl.formatMessage({
    id: "settings.runtime.localCli.probe.defaultMark",
    defaultMessage: "default",
  });
  return (
    <div className="space-y-1 text-xs">
      {catalog.models.length === 0 ? (
        <span className="font-mono">—</span>
      ) : (
        catalog.models.map((model) => (
          <div key={model} className="flex flex-wrap items-center gap-1">
            <span className="font-mono">
              {model}
              {model === catalog.current_model ? ` (${defaultLabel})` : ""}
            </span>
          </div>
        ))
      )}
      {catalog.thought_levels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">
            <FormattedMessage
              id="settings.runtime.localCli.probe.thoughtLevels"
              defaultMessage="Thought levels"
            />
            {": "}
          </span>
          <EffortBadgeGroup levels={catalog.thought_levels} marked={catalog.current_thought_level} />
        </div>
      )}
    </div>
  );
}

/** The JsonEventStream success block (ADR-0096 D3): the per-model list,
 *  each model's reasoning-effort options as a read-only badge group (the
 *  CLI's declared
 *  order, never a union across models). The degraded `unavailable` state
 *  (process alive, catalog not) renders an honest line -- the process being
 *  alive is itself the signal. The status dispatch is exhaustive with a
 *  `never` guard (mirrors `ProbeResult` / `ProbeErrorText`); an empty catalog
 *  renders the honest "none" line (the probe succeeded -- that fact must not
 *  vanish). */
function JsonEventStreamProbeResult({ outcome }: { outcome: ModelCatalogOutcome }) {
  const intl = useIntl();
  const defaultLabel = intl.formatMessage({
    id: "settings.runtime.localCli.probe.defaultMark",
    defaultMessage: "default",
  });
  if (outcome.status === "unavailable") {
    return (
      <p className="text-muted-foreground text-xs">
        <FormattedMessage
          id="settings.runtime.localCli.probe.codex.unavailable"
          defaultMessage="Started, but the model catalog is unavailable."
        />
        {outcome.detail ? ` (${outcome.detail})` : null}
      </p>
    );
  }
  if (outcome.status !== "available") {
    const _exhaustive: never = outcome;
    throw new Error(`Unknown catalog status: ${String(_exhaustive)}`);
  }
  if (outcome.models.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        <FormattedMessage
          id="settings.runtime.localCli.probe.codex.noModels"
          defaultMessage="Started, but no models were reported."
        />
      </p>
    );
  }
  return (
    <div className="space-y-1 text-xs">
      {outcome.models.map((model) => (
        <div key={model.id} className="flex flex-wrap items-center gap-1">
          <span className="font-mono">
            {model.display_name}
            {model.is_default ? ` (${defaultLabel})` : ""}
            {model.supported_reasoning_efforts.length > 0 ? ":" : ""}
          </span>
          {model.supported_reasoning_efforts.length > 0 && (
            <EffortBadgeGroup
              levels={model.supported_reasoning_efforts}
              marked={model.default_reasoning_effort}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** The probe-failure wording for one kind. Each case is a STATIC
 *  <FormattedMessage id="..." defaultMessage="..." /> literal so @formatjs/cli
 *  extract resolves every probe.error.* id (ADR-0052); the kind dispatch
 *  mirrors the backend's typed refusal set. An unknown kind never reaches
 *  here (the reject-shape check in `toProbeError` degrades it to
 *  `ProbeUnreachable`); the default branch is the compile-time
 *  exhaustiveness guard, and a runtime breach of that contract throws
 *  rather than guessing a wrong kind. */
function ProbeErrorText({ kind }: { kind: ProbeError["kind"] }) {
  switch (kind) {
    case "NotDetected":
      return (
        <FormattedMessage
          id="settings.runtime.localCli.probe.error.notDetected"
          defaultMessage="Adapter is not detected."
        />
      );
    case "ProbeUnreachable":
      return (
        <FormattedMessage
          id="settings.runtime.localCli.probe.error.unreachable"
          defaultMessage="The probe request could not reach the CLI (internal error)."
        />
      );
    case "SpawnFailure":
      return (
        <FormattedMessage
          id="settings.runtime.localCli.probe.error.spawn"
          defaultMessage="Failed to start the CLI."
        />
      );
    case "HandshakeFailure":
      return (
        <FormattedMessage
          id="settings.runtime.localCli.probe.error.handshake"
          defaultMessage="Handshake with the CLI failed."
        />
      );
    case "Timeout":
      return (
        <FormattedMessage
          id="settings.runtime.localCli.probe.error.timeout"
          defaultMessage="The probe timed out."
        />
      );
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown probe error kind: ${String(_exhaustive)}`);
    }
  }
}

/** Render the probe failure as a locale line + the technical detail (the
 *  fold): the kind selects the catalog wording, `data` carries the English
 *  technical detail (ADR-0052 layer 2 -- the wording lives in the catalog,
 *  not the backend string). */
function ProbeErrorLine({ error }: { error: ProbeError }) {
  return (
    <p className="text-destructive text-xs">
      <ProbeErrorText kind={error.kind} />
      {"data" in error && error.data ? ` (${error.data})` : null}
    </p>
  );
}

/** Format a cached probe's timestamp for display: one medium-date +
 *  short-time formatter behind the Test button's hover tooltip (issue
 *  #554). The timestamp renders in the local timezone. */
function formatProbedAt(intl: IntlShape, probedAtMillis: number): string {
  return new Intl.DateTimeFormat(intl.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(probedAtMillis);
}

/** The cached-catalog block (ADR-0096 D5, issue #536): renders the sidecar
 *  entry through the SAME per-format components as a fresh probe result
 *  (one rendering path -- no drift between "just tested" and "restored
 *  from cache"). No timestamp line here -- the probe time lives on the Test
 *  button's hover tooltip. */
function CachedCatalog({ entry }: { entry: AdapterCatalogEntry }) {
  // The cache entry's dispatch: the tagged union's `probe_kind` narrows the
  // outcome variant for TS; the never guard makes a future backend shape
  // change fail at compile time here, mirroring the probe-side switches.
  if (entry.probe_kind === "acp") {
    return <AcpProbeResult catalog={entry.outcome.acp.discovered} />;
  }
  if (entry.probe_kind === "json_event_stream") {
    return (
      <JsonEventStreamProbeResult
        outcome={{ status: "available", models: entry.outcome.json_event_stream.models }}
      />
    );
  }
  const _exhaustive: never = entry;
  throw new Error(`Unknown probe kind: ${String(_exhaustive)}`);
}

/** The probe's model count for one row, from whichever source is live: the
 *  fresh ok result, else (idle only) the cached entry. Only a count > 0 is a
 *  badge point -- empty catalogs, the unavailable outcome, probing, and
 *  failure carry no summary badge (issue #552 AC). The cache dispatch
 *  narrows the tagged union by `probe_kind` (never guard mirrors
 *  CachedCatalog), so a future backend shape change fails at compile time,
 *  not as a silently missing badge. */
function directoryModelCount(probe: ProbeState, cached?: AdapterCatalogEntry): number | null {
  let count: number;
  if (probe.status === "ok") {
    const { result } = probe;
    if (result.kind === "acp") {
      count = result.data.discovered.models.length;
    } else if (result.data.outcome.status === "available") {
      count = result.data.outcome.models.length;
    } else {
      return null;
    }
  } else if (probe.status === "idle" && cached) {
    if (cached.probe_kind === "acp") {
      count = cached.outcome.acp.discovered.models.length;
    } else if (cached.probe_kind === "json_event_stream") {
      count = cached.outcome.json_event_stream.models.length;
    } else {
      const _exhaustive: never = cached;
      throw new Error(`Unknown probe kind: ${String(_exhaustive)}`);
    }
  } else {
    return null;
  }
  return count > 0 ? count : null;
}

export function LocalCliTab({
  onIpcBusy,
}: {
  /** Narrowed pass-through: the local CLI tab fires only the probe channel. */
  onIpcBusy: (channel: "probe", busy: boolean) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  // Per-adapter probe state; one entry per probed row, keyed by adapter id.
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});
  // Expanded adapter ids (issue #552): component-local, never persisted -- the
  // fold resets on unmount, mirroring the MCP panel's expandedRows.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  // In-flight probe count (probe is the only multi-instance IPC channel --
  // multiple rows can probe concurrently). The busy report mirrors the
  // count, not any single row's status: the first probe to settle must not
  // clear the channel while another is still in flight (the close guard
  // would open early, ADR-0075 "any in-flight IPC blocks close").
  const activeProbesRef = useRef(0);

  // Session-agnostic adapter table (same key the composer picker uses). The
  // cache may already be warm from the composer; this read is near-instant in
  // that case. Detection is uncached server-side, so list + rescan share one
  // key and rescan is the explicit user-driven refresh.
  const { data: adapterData, isPending, isError, error } = useQuery({
    queryKey: adapterKeys.all(),
    queryFn: listAdapters,
  });
  const adapters: AdapterEntry[] = adapterData ?? [];
  const loadError = isError ? fmtError(error, intl) : null;

  // Probe-catalog cache (ADR-0096 D5, issue #536): the last explicitly
  // tested catalog per adapter, from the app-data sidecar. Reads settle
  // near-instantly (a small file read); a corrupt file honest-degrades to
  // empty server-side, so this query never rejects over data issues.
  const { data: cachedCatalogs } = useQuery({
    queryKey: adapterKeys.catalogs(),
    queryFn: getAdapterCatalogs,
  });

  async function handleRescan() {
    if (rescanning) return;
    setRescanning(true);
    setRescanError(null);
    try {
      const fresh = await rescanAdapters();
      queryClient.setQueryData(adapterKeys.all(), fresh);
    } catch (e) {
      log.warn("LocalCliTab", "adapter rescan failed", fmtError(e, intl));
      setRescanError(fmtError(e, intl));
    } finally {
      setRescanning(false);
    }
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleProbe(id: string) {
    if (probeStates[id]?.status === "probing") return;
    setProbeStates((prev) => ({ ...prev, [id]: { status: "probing" } }));
    activeProbesRef.current += 1;
    onIpcBusy("probe", true);
    try {
      const result = await probeAdapter(id);
      setProbeStates((prev) => ({ ...prev, [id]: { status: "ok", result } }));
      // The probe result is what the click bought -- auto-expand the row so
      // the directory is visible without a second click (issue #552). The
      // degenerate outcomes (unavailable / empty) expand too: the honest
      // line IS the result. Failure paths never touch the fold.
      setExpandedRows((prev) => new Set(prev).add(id));
      // The backend wrote this probe's entry to the sidecar cache; mirror
      // it into the query cache so the timestamped display is immediately
      // consistent (issue #536 AC: post-probe display matches the cache).
      // The degraded JsonEventStream outcome was not cached server-side -- reflect
      // that here too (the entry stays whatever it was, absent included).
      if (result.kind === "acp") {
        queryClient.setQueryData(adapterKeys.catalogs(), (prev: AdapterCatalogs | undefined) => ({
          ...(prev ?? {}),
          [id]: {
            probe_kind: "acp",
            outcome: { acp: { discovered: result.data.discovered } },
            probed_at_millis: Date.now(),
          },
        }));
      } else if (result.data.outcome.status === "available") {
        const { models } = result.data.outcome;
        queryClient.setQueryData(adapterKeys.catalogs(), (prev: AdapterCatalogs | undefined) => ({
          ...(prev ?? {}),
          [id]: {
            probe_kind: "json_event_stream",
            outcome: { json_event_stream: { models } },
            probed_at_millis: Date.now(),
          },
        }));
      }
    } catch (e) {
      log.warn("LocalCliTab", "adapter probe failed", e);
      // The IPC rejects with the structured ProbeError; a non-shaped reject
      // or an unknown kind (harness / transport fault / skew) keeps its own
      // kind -- it never reached the CLI, so it must not display as a
      // handshake failure.
      setProbeStates((prev) => ({
        ...prev,
        [id]: { status: "failed", error: toProbeError(e) },
      }));
    } finally {
      activeProbesRef.current -= 1;
      if (activeProbesRef.current === 0) {
        onIpcBusy("probe", false);
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">
          <FormattedMessage
            id="settings.runtime.localCli.title"
            defaultMessage="Detected CLI adapters"
          />
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleRescan()}
          disabled={rescanning}
          aria-label={intl.formatMessage({
            id: "settings.runtime.localCli.rescanAria",
            defaultMessage: "Rescan adapters",
          })}
        >
          <RefreshCw
            className={cn("size-3.5", rescanning && "animate-spin")}
            aria-hidden
          />
          <FormattedMessage
            id="settings.runtime.localCli.rescan"
            defaultMessage="Rescan"
          />
        </Button>
      </div>

      {isPending && (
        <p className="text-muted-foreground text-sm">
          <FormattedMessage id="settings.reading" defaultMessage="Reading current config…" />
        </p>
      )}

      {loadError && !adapterData && (
        <p className="text-destructive text-sm">{loadError}</p>
      )}

      {!isPending && !loadError && (
        <SettingsCard>
          {adapters.map((a) => {
            const probe = probeStates[a.id] ?? { status: "idle" as const };
            const probeable = a.detected;
            const cached = cachedCatalogs?.[a.id];
            const expanded = expandedRows.has(a.id);
            const modelCount = directoryModelCount(probe, cached);
            // The fold content for the current state: a fresh probe result
            // (ok or failed -- both are the result the click bought), else
            // the cached idle entry. Probing has no fresh content: the fold
            // renders either the stale cache or nothing (mid-flight empty).
            const foldContent =
              probe.status === "ok" ? (
                <ProbeResult result={probe.result} />
              ) : probe.status === "failed" ? (
                <ProbeErrorLine error={probe.error} />
              ) : cached ? (
                <CachedCatalog entry={cached} />
              ) : null;
            // The fold only exists when there is content to show (issue
            // #552 follow-up): an idle row without cache and a never-probed
            // row render no chevron -- an empty fold would be a dead toggle.
            // Exception (issue #554): an already-EXPANDED row keeps its
            // chevron mid-flight (a re-probe transiently empties the fold);
            // the toggle must not flicker away while a probe runs.
            const hasFoldContent = foldContent !== null;
            return (
              <SettingsRow
                key={a.id}
                title={a.display_name}
                description={
                  a.binary_path ? (
                    <code className="font-mono text-xs">{a.binary_path}</code>
                  ) : undefined
                }
                action={(
                  <div className="flex items-center gap-2">
                    {probe.status === "failed" ? (
                      <Badge variant="destructive">
                        <FormattedMessage
                          id="settings.runtime.localCli.probe.testFailed"
                          defaultMessage="Test failed"
                        />
                      </Badge>
                    ) : modelCount !== null ? (
                      <Badge variant="secondary">
                        <FormattedMessage
                          id="settings.runtime.localCli.probe.modelCount"
                          defaultMessage="{count} models"
                          values={{ count: modelCount }}
                        />
                      </Badge>
                    ) : null}
                    {probeable && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void handleProbe(a.id)}
                            disabled={probe.status === "probing"}
                          >
                            {probe.status === "probing" && (
                              <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            )}
                            <FormattedMessage
                              id="settings.runtime.localCli.probe.test"
                              defaultMessage="Test"
                            />
                          </Button>
                        </TooltipTrigger>
                        {cached && (
                          <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
                            <FormattedMessage
                              id="settings.runtime.localCli.probe.cachedAt"
                              defaultMessage="Last tested"
                            />
                            {": "}
                            <span className="font-mono">
                              {formatProbedAt(intl, cached.probed_at_millis)}
                            </span>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    )}
                    {a.detected ? (
                      <Badge variant="default">
                        <FormattedMessage
                          id="settings.runtime.localCli.detected"
                          defaultMessage="Available"
                        />
                      </Badge>
                    ) : (
                      // Muted text: an absent adapter is inert information,
                      // lower visual weight than an installed one.
                      <Badge
                        variant="secondary"
                        className="text-muted-foreground font-normal"
                      >
                        <FormattedMessage
                          id="settings.runtime.localCli.notInstalled"
                          defaultMessage="Not installed"
                        />
                      </Badge>
                    )}
                    {(hasFoldContent || expanded) && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
                        onClick={() => toggleRow(a.id)}
                        aria-label={a.display_name}
                        aria-expanded={expanded}
                      >
                        {expanded ? (
                          <ChevronDown className="size-4" aria-hidden />
                        ) : (
                          <ChevronRight className="size-4" aria-hidden />
                        )}
                      </button>
                    )}
                  </div>
                )}
              >
                {expanded && foldContent !== null && (
                  // Fold indent aligned with the MCP expanded content's
                  // ml-7 visual hierarchy (issue #552 item 6). Skipped when
                  // the fold is empty (mid-flight no-cache re-probe): an
                  // indent-only block would paint stray vertical spacing
                  // under the row.
                  <div className="ml-7">{foldContent}</div>
                )}
              </SettingsRow>
            );
          })}
        </SettingsCard>
      )}

      {rescanError && <p className="text-destructive text-sm">{rescanError}</p>}
    </div>
  );
}
