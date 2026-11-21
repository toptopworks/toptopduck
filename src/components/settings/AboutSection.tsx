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
import { TechnicalDetailsFold } from "../common/TechnicalDetailsFold";
import { Button } from "../ui/button";
import { NameBadge, PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";
import { ReleaseNotes } from "./ReleaseNotes";

/** The About pane (ADR-0143, issue #1509): the app-identity surface --
 *  today the version + in-app update block, later the official-links home
 *  (site, repo, license) the pane exists to hold. The manual check is local;
 *  the install leg (gate -> download -> restart) is the shared
 *  `useUpdateInstall` chain -- the same one the sidebar indicator runs, so
 *  both faces drive one state machine. A manual check that finds nothing
 *  writes the shared cache slice too, so the indicator and this block always
 *  mirror one truth. */

type Phase = "idle" | "checking";

// The inline failure face: a friendly catalog line + the raw reject riding the
// technical-details fold (issue #119's fold, the shared detail seam).
type UpdateError = { message: string; detail: string | null };

export function AboutSection() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const update = useUpdateAvailable();
  const [error, setError] = useState<UpdateError | null>(null);
  const { installing, percent, confirmOpen, setConfirmOpen, requestInstall, startInstall } =
    useUpdateInstall((detail) => {
      setError({
        message: intl.formatMessage({
          id: "settings.update.installFailedToast",
          defaultMessage: "Update failed",
        }),
        detail,
      });
    });

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [checkPhase, setCheckPhase] = useState<Phase>("idle");
  const [upToDate, setUpToDate] = useState(false);

  // The identity pill's version (display only). getVersion never rejects on
  // desktop; a non-resolving import (tests) leaves the pill hidden. Bare
  // semver is the display contract -- no `v` prefix anywhere.
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
      setError({
        message: intl.formatMessage({
          id: "settings.update.checkFailed",
          defaultMessage: "Couldn't check for updates",
        }),
        detail: fmtError(e, intl),
      });
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
        {/* The identity row (issue #1577): the brand + the current-version
         *  pill sit together on the left -- the same `sidebar.brand` copy
         *  the session sidebar header carries -- and the update button's
         *  whole state machine rides the right slot. */}
        <SettingsRow
          title={(
            <span className="inline-flex items-center gap-2">
              <FormattedMessage id="sidebar.brand" defaultMessage="TOPTOPDuck" />
              {appVersion !== null && <NameBadge>{appVersion}</NameBadge>}
            </span>
          )}
          action={button}
        />
        {/* The update status rides a bare padded block under the identity
         *  row -- its lines are self-explanatory, so no row title sits
         *  between the brand and the content (issue #1577). */}
        <div className="px-4 py-4">
          {update !== null ? (
            <div className="grid gap-2">
              <p className="text-foreground text-sm">
                <FormattedMessage
                  id="settings.update.available"
                  defaultMessage="Version {version} is available."
                  values={{ version: update.version }}
                />
              </p>
              {update.notes !== null && (
                <ReleaseNotes notes={update.notes} />
              )}
            </div>
          ) : upToDate ? (
            <p className="text-muted-foreground text-sm">
              <FormattedMessage
                id="settings.update.upToDateShort"
                defaultMessage="You're up to date."
              />
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              <FormattedMessage
                id="settings.update.hint"
                defaultMessage="Checks run automatically at startup; failures stay silent until you check manually."
              />
            </p>
          )}
        </div>
      </SettingsCard>

      {/* The settings-family error face: a sibling line BELOW the card (the
          Engine/General/Agents posture) -- inside the card it would pick up
          the divide-y hairlines and lose the row padding. The raw reject
          rides the technical-details fold. */}
      {error && (
        <>
          <p className="settings-error text-destructive mt-3 text-sm">{error.message}</p>
          <TechnicalDetailsFold detail={error.detail} />
        </>
      )}

      <UpdateConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void startInstall()}
      />
    </div>
  );
}
