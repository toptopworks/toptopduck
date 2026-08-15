import { useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { listAdapters, probeAdapter, rescanAdapters } from "../../api";
import { adapterKeys } from "../../session/queryKeys";
import type {
  AdapterEntry,
  CodexCatalogOutcome,
  DiscoveredRuntime,
  ProbeError,
  ProbeOk,
} from "../../types/runtime";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SettingsCard, SettingsRow } from "./settings-chrome";

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
// Probe results are display-only in this slice -- component-local state, gone
// on unmount (the persistent catalog cache is a later slice).

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
 *  catalog or the codex per-model catalog (ADR-0096 D2/D3). The switch is
 *  exhaustive with a `never` guard, mirroring `ProbeErrorText`: a new backend
 *  variant must fail at compile time here, not surface as a wrong-render
 *  throw at runtime. */
function ProbeResult({ result }: { result: ProbeOk }) {
  switch (result.kind) {
    case "acp":
      return <AcpProbeResult catalog={result.data.discovered} />;
    case "codex":
      return <CodexProbeResult outcome={result.data.outcome} />;
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown probe ok kind: ${String(_exhaustive)}`);
    }
  }
}

/** The ACP success block: the catalog's model list, thought-level options,
 *  and current values, read straight off the DiscoveredRuntime fields. */
function AcpProbeResult({ catalog }: { catalog: DiscoveredRuntime }) {
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">
        <FormattedMessage
          id="settings.runtime.localCli.probe.models"
          defaultMessage="Models"
        />
        {": "}
        <span className="font-mono">{catalog.models.join(", ") || "—"}</span>
        {catalog.current_model ? ` (${catalog.current_model})` : null}
      </p>
      <p className="text-muted-foreground">
        <FormattedMessage
          id="settings.runtime.localCli.probe.thoughtLevels"
          defaultMessage="Thought levels"
        />
        {": "}
        <span className="font-mono">{catalog.thought_levels.join(", ") || "—"}</span>
        {catalog.current_thought_level ? ` (${catalog.current_thought_level})` : null}
      </p>
    </div>
  );
}

/** The codex success block (ADR-0096 D3): the per-model list, each model's
 *  reasoning-effort options in the CLI's declared order (never a union across
 *  models). The degraded `unavailable` state (process alive, catalog not)
 *  renders an honest line -- the process being alive is itself the signal.
 *  The status dispatch is exhaustive with a `never` guard (mirrors
 *  `ProbeResult` / `ProbeErrorText`); an empty catalog renders the honest
 *  "none" line (the probe succeeded -- that fact must not vanish). */
function CodexProbeResult({ outcome }: { outcome: CodexCatalogOutcome }) {
  const intl = useIntl();
  const defaultLabel = intl.formatMessage({
    id: "settings.runtime.localCli.probe.codex.default",
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
        <p key={model.id} className="text-muted-foreground">
          <span className="font-mono">
            {model.display_name}
            {model.is_default ? ` (${defaultLabel})` : ""}
          </span>
          {": "}
          <span className="font-mono">
            {model.supported_reasoning_efforts.join(", ") || "—"}
          </span>
        </p>
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

  async function handleProbe(id: string) {
    if (probeStates[id]?.status === "probing") return;
    setProbeStates((prev) => ({ ...prev, [id]: { status: "probing" } }));
    activeProbesRef.current += 1;
    onIpcBusy("probe", true);
    try {
      const result = await probeAdapter(id);
      setProbeStates((prev) => ({ ...prev, [id]: { status: "ok", result } }));
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
                    {probeable && (
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
                    )}
                    {a.detected ? (
                      <Badge variant="default">
                        <FormattedMessage
                          id="settings.runtime.localCli.detected"
                          defaultMessage="Detected"
                        />
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        <FormattedMessage
                          id="settings.runtime.localCli.notInstalled"
                          defaultMessage="Not installed"
                        />
                      </Badge>
                    )}
                  </div>
                )}
              >
                {probe.status === "ok" ? (
                  <ProbeResult result={probe.result} />
                ) : probe.status === "failed" ? (
                  <ProbeErrorLine error={probe.error} />
                ) : null}
              </SettingsRow>
            );
          })}
        </SettingsCard>
      )}

      {rescanError && <p className="text-destructive text-sm">{rescanError}</p>}
    </div>
  );
}
