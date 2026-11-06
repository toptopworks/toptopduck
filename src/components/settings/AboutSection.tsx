import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { Download, Loader2, RefreshCw } from "lucide-react";

import { checkForUpdates } from "../../api";
import { updateKeys } from "../../session/queryKeys";
import { useUpdateAvailable } from "../../shell/useUpdateCheck";
import { useUpdateInstall } from "../../shell/useUpdateInstall";
import { UpdateConfirmDialog } from "../../shell/UpdateConfirmDialog";
import { fmtError } from "../../lib/error-presentation";
import { Button } from "../ui/button";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";

/** The About pane (ADR-0143, issue #1509): the app-identity surface --
 *  today the version + in-app update block, later the official-links home
 *  (site, repo, license) the pane exists to hold. The manual check is local;
 *  the install leg (gate -> download -> restart) is the shared
 *  `useUpdateInstall` chain -- the same one the sidebar indicator runs, so
 *  both faces drive one state machine. A manual check that finds nothing
 *  writes the shared cache slice too, so the indicator and this block always
 *  mirror one truth. */

type Phase = "idle" | "checking";

export function AboutSection() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const update = useUpdateAvailable();
  const [error, setError] = useState<string | null>(null);
  const { installing, percent, confirmOpen, setConfirmOpen, requestInstall, startInstall } =
    useUpdateInstall(setError);

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkPhase, setCheckPhase] = useState<Phase>("idle");
  const [upToDate, setUpToDate] = useState(false);

  // The running version (display only). getVersion never rejects on desktop;
  // a non-resolving import (tests) leaves the version line hidden.
  useEffect(() => {
    let cancelled = false;
    void getVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCheck() {
    if (checkPhase !== "idle") return;
    setCheckPhase("checking");
    setError(null);
    setUpToDate(false);
    try {
      const result = await checkForUpdates();
      // Mirror the fresh result into the shared slice so the sidebar indicator
      // and this block stay one truth.
      queryClient.setQueryData(updateKeys.check(), result);
      if (result === null) setUpToDate(true);
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setCheckPhase("idle");
    }
  }

  const button = (() => {
    if (checkPhase === "checking") {
      return (
        <Button type="button" size="sm" disabled>
          <RefreshCw className="size-3.5 animate-spin" aria-hidden />
          <FormattedMessage id="settings.update.checking" defaultMessage="Checking…" />
        </Button>
      );
    }
    if (installing) {
      return (
        <Button type="button" size="sm" disabled>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {percent === null ? (
            <FormattedMessage id="settings.update.installing" defaultMessage="Updating…" />
          ) : (
            <FormattedMessage
              id="settings.update.installingPercent"
              defaultMessage="Updating… {percent}%"
              values={{ percent }}
            />
          )}
        </Button>
      );
    }
    if (update !== null) {
      return (
        <Button type="button" size="sm" onClick={() => void requestInstall()}>
          <Download className="size-3.5" aria-hidden />
          <FormattedMessage
            id="settings.update.install"
            defaultMessage="Update to {version}"
            values={{ version: update.version }}
          />
        </Button>
      );
    }
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => void handleCheck()}>
        <RefreshCw className="size-3.5" aria-hidden />
        <FormattedMessage id="settings.update.check" defaultMessage="Check for updates" />
      </Button>
    );
  })();

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.about" defaultMessage="About" />}
        description={(
          <FormattedMessage
            id="settings.about.description"
            defaultMessage="Version and application updates."
          />
        )}
      />
      <SettingsCard>
        <SettingsRow
          title={<FormattedMessage id="settings.update.title" defaultMessage="Updates" />}
          description={appVersion !== null ? (
            <FormattedMessage
              id="settings.update.currentVersion"
              defaultMessage="Current version: {version}"
              values={{ version: appVersion }}
            />
          ) : undefined}
          action={button}
        >
          {update !== null ? (
            <div className="grid gap-1">
              <p className="text-foreground text-sm">
                <FormattedMessage
                  id="settings.update.available"
                  defaultMessage="Version {version} is available."
                  values={{ version: update.version }}
                />
              </p>
              {update.notes !== null && update.notes.trim() !== "" && (
                <p className="text-muted-foreground whitespace-pre-line text-xs leading-relaxed">
                  {update.notes}
                </p>
              )}
            </div>
          ) : upToDate ? (
            <p className="text-muted-foreground text-sm">
              {appVersion !== null ? (
                <FormattedMessage
                  id="settings.update.upToDate"
                  defaultMessage="You're up to date ({version})."
                  values={{ version: appVersion }}
                />
              ) : (
                <FormattedMessage
                  id="settings.update.upToDateShort"
                  defaultMessage="You're up to date."
                />
              )}
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              <FormattedMessage
                id="settings.update.hint"
                defaultMessage="Checks run automatically at startup; failures stay silent until you check manually."
              />
            </p>
          )}
        </SettingsRow>

        {error && <p className="settings-error text-destructive mt-3 text-sm">{error}</p>}

        <UpdateConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={() => void startInstall()}
        />
      </SettingsCard>
    </div>
  );
}
