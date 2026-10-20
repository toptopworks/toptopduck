import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { getAdapterCatalogs, listAdapters, rescanAdapters } from "../../api";
import { adapterKeys } from "../../session/queryKeys";
import { USER_ADAPTER_ID_PREFIX, type AdapterEntry, type UserAdapterRow } from "../../types/runtime";
import { HeaderActionButton, NameBadge, SettingsCard } from "./settings-chrome";
import { ProbeFaceRow } from "./probe-face";
import { useAdapterProbes } from "./useAdapterProbes";
import { EditorForm, UserRuntimesSection } from "./UserRuntimesSection";

// Local CLI tab (issue #489, ADR-0091): the adapter management panel inside
// the Settings runtime section. The detected card lists the BUILT-IN v1
// adapters from `listAdapters` (dynamic -- never hardcoded), each row showing
// the display name + detection state (detected shows the resolved binary
// path; not detected shows "Not installed"). A rescan button re-runs the
// PATH scan via `rescanAdapters` and refreshes the shared adapter cache (the
// same `adapterKeys.all()` the composer runtime picker reads).
//
// This panel is the management surface moved OUT of the composer popover
// (ADR-0091): the composer is purely selection, this tab is purely management.
// The composer's adapter list + rescan still work independently -- both read
// the same cache key.
//
// The per-adapter Test button (ADR-0096, issues #534/#535/#561) and the
// result fold (issue #552) are the shared probe face (see ./probe-face.tsx);
// the registry rows below render the same face. The detected card itself is
// built-ins only: the merged `list_adapters` projection also carries the
// enabled user rows for the picker, but their full face lives in the
// registry section -- the card would duplicate the row per enable toggle
// (issue #1346).
export function LocalCliTab({
  onIpcBusy,
}: {
  /** Narrowed pass-through: the probe channel + the user-registry CRUD
   *  channel fired by this tab and the custom-runtimes section below. */
  onIpcBusy: (channel: "probe" | "userAdapter", busy: boolean) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  // The custom-runtime editor (issue #1341): `undefined` = closed, `null` =
  // create, a row = edit. The form replaces the whole tab -- the Add button
  // rides the tab header beside Rescan (the CliSection list/form swap).
  const [editingRuntime, setEditingRuntime] = useState<
    UserAdapterRow | null | undefined
  >(undefined);
  // The shared probe lifecycle (./probe-face.tsx): one instance for the
  // whole tab -- the built-in rows, the registry rows, and the editor
  // form's Test all count against the same "probe" busy mirror.
  const probes = useAdapterProbes(onIpcBusy);

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

  if (editingRuntime !== undefined) {
    return (
      <EditorForm
        row={editingRuntime}
        onClose={() => setEditingRuntime(undefined)}
        onIpcBusy={onIpcBusy}
        onProbeOnce={probes.probeOnce}
      />
    );
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
        <div className="flex items-center gap-1">
          <HeaderActionButton
            label={intl.formatMessage({
              id: "common.add",
              defaultMessage: "Add",
            })}
            icon={Plus}
            onClick={() => setEditingRuntime(null)}
          />
          <HeaderActionButton
            label={intl.formatMessage({
              id: "common.rescan",
              defaultMessage: "Rescan",
            })}
            icon={RefreshCw}
            spinning={rescanning}
            disabled={rescanning}
            onClick={() => void handleRescan()}
          />
        </div>
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
          {adapters
            .filter((a) => !a.id.startsWith(USER_ADAPTER_ID_PREFIX))
            .map((a) => (
              <ProbeFaceRow
                key={a.id}
                name={a.display_name}
                probeable={a.detected}
                probe={probes.probeStates[a.id] ?? { status: "idle" }}
                cached={cachedCatalogs?.[a.id]}
                expanded={probes.expandedRows.has(a.id)}
                onProbe={() => void probes.probe(a.id)}
                onToggleFold={() => probes.toggleFold(a.id)}
                rowBadges={
                  a.detected ? (
                    <NameBadge variant="success">
                      <FormattedMessage
                        id="settings.runtime.localCli.detected"
                        defaultMessage="Available"
                      />
                    </NameBadge>
                  ) : (
                    <NameBadge>
                      <FormattedMessage
                        id="settings.runtime.localCli.notInstalled"
                        defaultMessage="Not installed"
                      />
                    </NameBadge>
                  )
                }
                subtitle={
                  a.binary_path ? (
                    <div className="text-muted-foreground mt-1 truncate font-mono text-xs">
                      {a.binary_path}
                    </div>
                  ) : null
                }
              />
            ))}
        </SettingsCard>
      )}

      {rescanError && <p className="text-destructive text-sm">{rescanError}</p>}

      {/* The user-defined registry (issue #1341): row cards under the
          detected built-ins, carrying the same probe face as the built-ins
          (issue #1346). Editing swaps the whole tab for the editor form. */}
      <UserRuntimesSection
        onEdit={setEditingRuntime}
        onIpcBusy={onIpcBusy}
        probes={probes}
      />
    </div>
  );
}
