import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { listAdapters, rescanAdapters } from "../../api";
import { adapterKeys } from "../../session/queryKeys";
import type { AdapterEntry } from "../../types/runtime";
import { cn } from "../../lib/utils";
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

export function LocalCliTab() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  // Session-agnostic adapter table (same key the composer picker uses). The
  // cache may already be warm from the composer; this read is near-instant in
  // that case. Detection is uncached server-side, so list + rescan share one
  // key and rescan is the explicit user-driven refresh.
  const { data: adapterData } = useQuery({
    queryKey: adapterKeys.all(),
    queryFn: listAdapters,
  });
  const adapters: AdapterEntry[] = adapterData ?? [];

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

      <SettingsCard>
        {adapters.map((a) => (
          <SettingsRow
            key={a.id}
            title={a.display_name}
            description={
              a.detected ? (
                a.binary_path ? (
                  <code className="text-xs">{a.binary_path}</code>
                ) : null
              ) : (
                <FormattedMessage
                  id="settings.runtime.localCli.notInstalled"
                  defaultMessage="Not installed"
                />
              )
            }
            action={(
              <span
                className={cn(
                  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
                  a.detected
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {a.detected ? (
                  <FormattedMessage
                    id="settings.runtime.localCli.detected"
                    defaultMessage="Detected"
                  />
                ) : (
                  <FormattedMessage
                    id="settings.runtime.localCli.notDetected"
                    defaultMessage="Not found"
                  />
                )}
              </span>
            )}
          />
        ))}
      </SettingsCard>

      {rescanError && <p className="text-destructive text-sm">{rescanError}</p>}
    </div>
  );
}
