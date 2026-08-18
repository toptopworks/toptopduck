import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";

import { listAdapters, setDefaultRuntime } from "../../api";
import type { AppConfig, DefaultRuntime } from "../../types/app-config";
import { fmtError } from "../../lib/error-presentation";
import { adapterKeys } from "../../session/queryKeys";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SettingsCard, SettingsRow } from "./settings-chrome";

// Default runtime control (issue #571, ADR-0098 Decision 2): the machine-level
// preference selecting the runtime new sessions + resumes start on. Rendered at
// the top of the Runtime pane (above the two sub-tabs, always mounted), so it
// reads as a section-level preamble preference rather than either tab's content.
//
// Persistence follows the sessions-dir draft + Save row (ADR-0075): a local
// draft gates Save; the DEDICATED setDefaultRuntime IPC persists it (it carries
// the unknown-adapter refusal the whole-document set_app_config write
// intentionally skips, issue #569) and returns the updated config, which rides
// onSaved back into shell state -- no compensating second write.
//
// The select is grouped by the runtime's two categories, reusing the runtime
// section's sub-tab vocabulary (ADR-0099 Decision 2 term alignment): "API
// Access" holds the single Built-in entry (the built-in runtime has no profile
// dimension -- the composer popover's second level there picks active_profile,
// a distinct preference), "Local CLI" lists only detected adapters. A persisted
// external value whose adapter is no longer detected keeps showing as the
// current value, annotated (ADR-0098 Decision 3: degrade per startup, never
// destroy the preference).

export type DefaultRuntimeControlProps = {
  /** The persisted preference (appConfig.default_runtime). */
  defaultRuntime: DefaultRuntime;
  /** Replace shell app-config state with the config the write IPC returned
   *  (state-only sync, mirroring the sessions-dir callback -- the dedicated
   *  IPC already persisted). */
  onSaved: (cfg: AppConfig) => void;
  /** Mirror the Save IPC's in-flight state to the settings close guard
   *  (ADR-0075: ESC / back is blocked while any IPC is in flight). */
  onIpcBusy: (channel: "defaultRuntime", busy: boolean) => void;
};

/** The stable select key for one runtime value: a unit literal for built-in,
 *  the adapter id namespaced for external (the two forms cannot collide). */
function runtimeKey(runtime: DefaultRuntime): string {
  return runtime.kind === "external" ? `external:${runtime.data}` : "built_in";
}

/** Parse a select key back into the wire value. */
function runtimeFromKey(key: string): DefaultRuntime {
  return key === "built_in"
    ? { kind: "built_in" }
    : { kind: "external", data: key.slice("external:".length) };
}

export function DefaultRuntimeControl({
  defaultRuntime,
  onSaved,
  onIpcBusy,
}: DefaultRuntimeControlProps) {
  const intl = useIntl();
  // The pending selection; null = display the persisted value. Never points at
  // an undetected adapter -- the user can only pick from detected rows.
  const [draft, setDraft] = useState<DefaultRuntime | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The shared adapter table (the same cache key the Local CLI tab + composer
  // picker read): a rescan there lands via setQueryData and this control's
  // option list refreshes inside the same Settings session. A failed read is
  // surfaced inline (the Local CLI tab pattern) -- never a silent blank list.
  const { data: adapterData, isError, error: adapterError } = useQuery({
    queryKey: adapterKeys.all(),
    queryFn: listAdapters,
  });
  const loadError = isError ? fmtError(adapterError, intl) : null;
  const detected = (adapterData ?? []).filter((a) => a.detected);

  const displayed = draft ?? defaultRuntime;

  // A persisted (or drafted) external value whose adapter is currently
  // undetected (CLI uninstalled). Rendered only once the table has loaded --
  // before that (pending or failed read) no external option exists and the
  // trigger falls back to the raw id via SelectValue children below. The
  // draft is picked from detected rows only, though a rescan can later leave
  // it undetected; that lands here too, and the backend accepts in-table
  // undetected ids by design (ADR-0098 Decision 3). An id absent from the
  // table entirely (retired upstream) falls back to the raw id as its
  // display name.
  const staleEntry =
    adapterData !== undefined &&
    displayed.kind === "external" &&
    !detected.some((a) => a.id === displayed.data)
      ? (adapterData.find((a) => a.id === displayed.data) ?? {
          id: displayed.data,
          display_name: displayed.data,
        })
      : null;

  const hasDraft = draft !== null && runtimeKey(draft) !== runtimeKey(defaultRuntime);

  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    onIpcBusy("defaultRuntime", true);
    try {
      const updated = await setDefaultRuntime(draft);
      setDraft(null);
      setError(null);
      onSaved(updated);
    } catch (e) {
      // The draft survives: the user retries or picks something else; the
      // persisted value was never touched.
      setError(fmtError(e, intl));
    } finally {
      setBusy(false);
      onIpcBusy("defaultRuntime", false);
    }
  }

  return (
    <div className="mb-6">
      <SettingsCard>
        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.runtime.defaultRuntime.legend"
              defaultMessage="Default runtime"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.runtime.defaultRuntime.description"
              defaultMessage="The runtime new sessions and resumed sessions start with."
            />
          )}
          action={(
            <div className="flex shrink-0 items-center gap-2">
              <Select
                value={runtimeKey(displayed)}
                onValueChange={(key) => {
                  setDraft(runtimeFromKey(key));
                  setError(null);
                }}
              >
                <SelectTrigger
                  className="w-48"
                  aria-label={intl.formatMessage({
                    id: "settings.runtime.defaultRuntime.legend",
                    defaultMessage: "Default runtime",
                  })}
                >
                  {/* Fallback text while the table has not loaded (pending or
                      failed read): the external value has no option to portal
                      its text from, and Radix suppresses the placeholder for a
                      non-empty value, so without children the trigger would
                      render blank. Children presence also suppresses the
                      selected-item portal (Radix gates it on the value node
                      having none), so this must stay conditional on exactly
                      the no-option state. */}
                  <SelectValue>
                    {adapterData === undefined && displayed.kind === "external"
                      ? displayed.data
                      : undefined}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>
                      <FormattedMessage
                        id="settings.runtime.tab.apiAccess"
                        defaultMessage="API Access"
                      />
                    </SelectLabel>
                    <SelectItem value="built_in">
                      <FormattedMessage
                        id="settings.runtime.defaultRuntime.builtIn"
                        defaultMessage="Built-in"
                      />
                    </SelectItem>
                  </SelectGroup>
                  <SelectGroup>
                    <SelectLabel>
                      <FormattedMessage
                        id="settings.runtime.tab.localCli"
                        defaultMessage="Local CLI"
                      />
                    </SelectLabel>
                    {detected.map((a) => (
                      <SelectItem key={a.id} value={`external:${a.id}`}>
                        {a.display_name}
                      </SelectItem>
                    ))}
                    {staleEntry && (
                      <SelectItem value={`external:${staleEntry.id}`}>
                        {intl.formatMessage(
                          {
                            id: "settings.runtime.defaultRuntime.notInstalled",
                            defaultMessage: "{name} (Not installed)",
                          },
                          { name: staleEntry.display_name },
                        )}
                      </SelectItem>
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                disabled={!hasDraft || busy}
                onClick={() => void save()}
              >
                <FormattedMessage id="common.save" defaultMessage="Save" />
              </Button>
            </div>
          )}
        />
      </SettingsCard>

      {loadError && !adapterData && (
        <p className="settings-error mt-3 text-destructive text-sm">{loadError}</p>
      )}
      {error && (
        <p className="settings-error mt-3 text-destructive text-sm">{error}</p>
      )}
    </div>
  );
}
