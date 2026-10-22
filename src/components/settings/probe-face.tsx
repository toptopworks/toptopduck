import { type ReactNode } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Zap } from "lucide-react";

import { cn } from "../../lib/utils";
import type {
  AdapterCatalogEntry,
  CatalogModel,
  DiscoveredRuntime,
  ModelCatalogOutcome,
  ProbeError,
  ProbeOk,
} from "../../types/runtime";
import { Badge } from "../ui/badge";
import { NameBadge, RowActionButton, RowFoldChevron } from "./settings-chrome";
import type { ProbeState } from "./useAdapterProbes";

// The adapter probe face (ADR-0096, issues #534/#535/#552/#554, #1346):
// everything a probed adapter row shows beyond its management identity,
// shared by the built-in rows and the registry rows -- the summary badges,
// the row-end Test button, the fold chevron, and the per-format fold
// content. The probe lifecycle lives in ./useAdapterProbes.ts, instantiated
// ONCE per settings tab; this module is the rendering side.

/** The probe success block: dispatch on the per-format `kind` -- the ACP flat
 *  catalog or the per-model catalog (codex / claude-code, ADR-0096 D2/D3 +
 *  ADR-0097). Both per-model kinds render the same shape (the shared
 *  `ModelCatalogOutcome`). The switch is exhaustive with a `never` guard,
 *  mirroring `ProbeErrorText`: a new backend variant must fail at compile
 *  time here, not surface as a wrong-render throw at runtime. */
function ProbeResult({ result }: { result: ProbeOk }) {
  switch (result.kind) {
    case "acp":
      return <AcpProbeResult catalog={result.data.discovered} />;
    case "codex_event_stream":
    case "claude_stream_json":
      return <ModelCatalogProbeResult outcome={result.data.outcome} />;
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown probe ok kind: ${String(_exhaustive)}`);
    }
  }
}

/** The shared "(default)" marker label: one id + one wording for the effort
 *  badges and both catalogs' model lines (the literal descriptor lives in
 *  this one call so formatjs extraction sees a single source of truth --
 *  same shape as formatProbedAt below). */
function defaultMarkLabel(intl: IntlShape): string {
  return intl.formatMessage({
    id: "settings.runtime.localCli.probe.defaultMark",
    defaultMessage: "default",
  });
}

/** One reasoning-effort thought level as a read-only small badge. The marked
 *  level (the CLI default or the current value) renders with the shared
 *  "default" annotation -- one marker shape across both catalogs. */
function EffortBadge({ level, marked }: { level: string; marked: boolean }) {
  const defaultLabel = defaultMarkLabel(useIntl());
  return (
    <Badge variant="secondary" className="text-muted-foreground font-mono font-normal">
      {level}
      {marked ? ` (${defaultLabel})` : ""}
    </Badge>
  );
}

/** A row of read-only effort badges, one per supported level, in the CLI's
 *  declared order (never a union across models, ADR-0096 D3). Callers skip
 *  the whole group when the catalog carried no levels -- an absent list has
 *  nothing to show, no placeholder -- and the group itself renders nothing
 *  for an empty list, so a future unguarded call site cannot leak a stray
 *  empty container. */
function EffortBadgeGroup({
  levels,
  marked,
}: {
  levels: string[];
  marked: string | null;
}) {
  if (levels.length === 0) return null;
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
 *  levels -- the same per-line shape as the per-model catalog so both
 *  folds read alike. Empty lists stay honest: no models renders the shared
 *  "no models" line, no levels renders no row, and a current model the list
 *  did not include still renders on its own line. */
function AcpProbeResult({ catalog }: { catalog: DiscoveredRuntime }) {
  const defaultLabel = defaultMarkLabel(useIntl());
  // The backend flattens the CLI's config options without dedup, so the
  // same id can arrive twice -- collapse repeats before they become keys.
  const models = Array.from(new Set(catalog.models));
  return (
    <div className="space-y-1 text-xs">
      {models.length === 0 ? (
        <p className="text-muted-foreground">
          <FormattedMessage
            id="settings.runtime.localCli.probe.noModels"
            defaultMessage="Started, but no models were reported."
          />
        </p>
      ) : (
        models.map((model) => (
          // A line is just the id (the flat catalog carries no per-model
          // efforts), so no flex/badge wrapper is needed here -- one text
          // element per line.
          <div key={model} className="font-mono">
            {model}
            {model === catalog.current_model ? ` (${defaultLabel})` : ""}
          </div>
        ))
      )}
      {catalog.current_model && !catalog.models.includes(catalog.current_model) && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">
            <FormattedMessage
              id="settings.runtime.localCli.probe.currentModel"
              defaultMessage="Current model"
            />
            {": "}
          </span>
          <span className="font-mono">{catalog.current_model}</span>
        </div>
      )}
      {catalog.thought_levels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">
            <FormattedMessage
              id="settings.runtime.localCli.probe.thoughtLevels"
              defaultMessage="Thinking"
            />
            {": "}
          </span>
          <EffortBadgeGroup levels={catalog.thought_levels} marked={catalog.current_thought_level} />
        </div>
      )}
    </div>
  );
}

/** The per-model catalog success block (ADR-0096 D3, shared by the codex
 *  and claude-code probe kinds per ADR-0097): the per-model list, each
 *  model's reasoning-effort options as a read-only badge group (the CLI's
 *  declared order, never a union across models). The degraded `unavailable`
 *  state (process alive, catalog not) renders an honest line -- the process
 *  being alive is itself the signal. The status dispatch is exhaustive with
 *  a `never` guard (mirrors `ProbeResult` / `ProbeErrorText`); an empty
 *  catalog renders the honest "none" line (the probe succeeded -- that fact
 *  must not vanish). */
function ModelCatalogProbeResult({ outcome }: { outcome: ModelCatalogOutcome }) {
  const defaultLabel = defaultMarkLabel(useIntl());
  if (outcome.status === "unavailable") {
    return (
      <p className="text-muted-foreground text-xs">
        <FormattedMessage
          id="settings.runtime.localCli.probe.modelCatalog.unavailable"
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
          id="settings.runtime.localCli.probe.noModels"
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

/** The per-model catalog a NON-acp cache entry carries. The single
 *  dispatch point for every per-model read off a cache entry (the fold +
 *  the summary badge); the argument is the post-acp narrowing, so every
 *  kind here is per-model. Exhaustive with a `never` guard (the file's
 *  other dispatches' shape): a future backend kind fails at compile time,
 *  not as a silently missing render. */
function perModelModels(
  entry: Exclude<AdapterCatalogEntry, { probe_kind: "acp" }>,
): CatalogModel[] {
  switch (entry.probe_kind) {
    case "codex_event_stream":
      return entry.outcome.codex_event_stream.models;
    case "claude_stream_json":
      return entry.outcome.claude_stream_json.models;
    default: {
      const _exhaustive: never = entry;
      throw new Error(`Unknown probe kind: ${String(_exhaustive)}`);
    }
  }
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
  return (
    <ModelCatalogProbeResult
      outcome={{ status: "available", models: perModelModels(entry) }}
    />
  );
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
      // Both per-model kinds carry the same outcome shape.
      count = result.data.outcome.models.length;
    } else {
      return null;
    }
  } else if (probe.status === "idle" && cached) {
    count =
      cached.probe_kind === "acp"
        ? cached.outcome.acp.discovered.models.length
        : perModelModels(cached).length;
  } else {
    return null;
  }
  return count > 0 ? count : null;
}

/** The shared probe-face row (issue #1346): the title block's probe badges,
 *  the row-end Test button + fold chevron, and the expanded fold. The
 *  caller supplies the row's identity -- name, its own badges, the mono
 *  subtitle line, the management actions -- and this owns the fold-state
 *  semantics (issues #552/#554): the chevron only exists with content (or
 *  while expanded, so a mid-flight re-probe never flickers the toggle),
 *  the badge layer clears the stale count while probing, and a failure
 *  renders the red badge on the collapsed row with the error in the fold. */
export function ProbeFaceRow({
  name,
  nameMuted = false,
  rowBadges = null,
  subtitle = null,
  actions = null,
  probeable,
  probe,
  cached,
  expanded,
  onProbe,
  onToggleFold,
}: {
  /** The row title; also the Test button's and chevron's aria label. */
  name: string;
  /** A dormant registry row quiets the name (ADR-0106). */
  nameMuted?: boolean;
  /** The row's identity badges (Available / Not installed / Disabled). */
  rowBadges?: ReactNode;
  /** The mono line under the title (resolved binary path / command). */
  subtitle?: ReactNode;
  /** Management controls rendered ahead of the Test button. */
  actions?: ReactNode;
  /** Built-ins gate on detection; registry rows always offer the probe --
   *  the registry list carries no detection state, and a failed probe is
   *  the honest answer (the probe is a diagnostic, not a gate). */
  probeable: boolean;
  probe: ProbeState;
  cached?: AdapterCatalogEntry;
  expanded: boolean;
  onProbe: () => void;
  onToggleFold: () => void;
}) {
  const intl = useIntl();
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
    <div className="hover:bg-accent px-4 py-3">
      <div className="flex items-center gap-3">
        {/* The chevron rides the row END (after the actions):
         * collapsed rows without fold content render none, and
         * the shrink-0 action group keeps the title block
         * flush-left either way -- no placeholder, no dead
         * toggle (#552). An already-expanded row keeps its
         * chevron mid-flight (#554, per the fold comment above). */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-sm font-medium truncate",
                nameMuted && "text-muted-foreground",
              )}
            >
              {name}
            </span>
            {rowBadges}
            {probe.status === "failed" && (
              <NameBadge variant="destructive">
                <FormattedMessage
                  id="settings.runtime.localCli.probe.testFailed"
                  defaultMessage="Test failed"
                />
              </NameBadge>
            )}
            {modelCount !== null && (
              <NameBadge>
                <FormattedMessage
                  id="settings.runtime.localCli.probe.modelCount"
                  defaultMessage="{count} models"
                  values={{ count: modelCount }}
                />
              </NameBadge>
            )}
          </div>
          {subtitle}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {actions}
          {probeable && (
            <RowActionButton
              disabled={probe.status === "probing"}
              spinning={probe.status === "probing"}
              icon={Zap}
              label={intl.formatMessage(
                {
                  id: "settings.runtime.localCli.testLabel",
                  defaultMessage: "Test adapter {name}",
                },
                { name },
              )}
              tooltip={
                cached
                  ? `${intl.formatMessage({
                    id: "settings.runtime.localCli.probe.cachedAt",
                    defaultMessage: "Last tested",
                  })}: ${formatProbedAt(intl, cached.probed_at_millis)}`
                  : undefined
              }
              onClick={onProbe}
            />
          )}
          {(hasFoldContent || expanded) && (
            <RowFoldChevron
              label={name}
              expanded={expanded}
              onToggle={onToggleFold}
            />
          )}
        </div>
      </div>
      {expanded && foldContent !== null && (
        // Fold indent aligned with the MCP expanded content's
        // ml-7 visual hierarchy (issue #552 item 6). Skipped when
        // the fold is empty (mid-flight no-cache re-probe): an
        // indent-only block would paint stray vertical spacing
        // under the row.
        <div className="mt-3 ml-7">{foldContent}</div>
      )}
    </div>
  );
}
