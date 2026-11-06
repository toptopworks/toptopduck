import { useEffect, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { Download, Loader2, RefreshCw } from "lucide-react";

import {
  checkForUpdates,
  installUpdate,
  listLiveSessions,
  onUpdateDownloadProgress,
} from "../../api";
import { updateKeys } from "../../session/queryKeys";
import { useUpdateAvailable } from "../../shell/useUpdateCheck";
import { fmtError } from "../../lib/error-presentation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";

/** The About pane (ADR-0143, issue #1509): the app-identity surface --
 *  today the version + in-app update block, later the official-links home
 *  (site, repo, license) the pane exists to hold. The update button walks the
 *  state machine check -> update-to-X -> updating; the install leg is the
 *  Rust side's one-shot atomic chain (fresh check -> download -> cleanup ->
 *  install -> relaunch) and never resolves on success -- the process is
 *  replaced. A manual check that finds nothing writes the shared cache slice
 *  too, so the topbar indicator and this block always mirror one truth. */

type Phase = "idle" | "checking" | "downloading";

export function AboutSection() {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const update = useUpdateAvailable();

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [upToDate, setUpToDate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

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

  // Drop the progress listener if the block unmounts mid-download (the
  // download itself keeps running in Rust; only this UI face goes away).
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  async function handleCheck() {
    if (phase !== "idle") return;
    setPhase("checking");
    setError(null);
    setUpToDate(false);
    try {
      const result = await checkForUpdates();
      // Mirror the fresh result into the shared slice so the topbar indicator and
      // this block stay one truth.
      queryClient.setQueryData(updateKeys.check(), result);
      if (result === null) setUpToDate(true);
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setPhase("idle");
    }
  }

  async function handleInstallClick() {
    if (phase !== "idle" || update === null) return;
    setError(null);
    // Active-turn gate (ADR-0143 Decision 5): confirm before interrupting,
    // never hard-block. The backend's live table is the truth (the frontend's
    // per-session busy state only covers the active pane).
    let inFlight = false;
    try {
      inFlight = (await listLiveSessions()).some((row) => row.in_flight);
    } catch {
      // The gate is best-effort: an unreadable table must not bury the
      // update; proceed without the dialog.
    }
    if (inFlight) {
      setConfirmOpen(true);
      return;
    }
    void startInstall();
  }

  async function startInstall() {
    setPhase("downloading");
    setPercent(null);
    void onUpdateDownloadProgress((p) => {
      if (p.contentLength && p.contentLength > 0) {
        setPercent(Math.min(100, Math.floor((p.downloaded / p.contentLength) * 100)));
      } else {
        setPercent(null);
      }
    }).then((unlisten) => {
      unlistenRef.current = unlisten;
    });
    try {
      // Success never resolves (the process is replaced by the installer /
      // relaunch); only the error path lands here.
      await installUpdate();
    } catch (e) {
      setError(fmtError(e, intl));
      setPhase("idle");
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  }

  const button = (() => {
    if (phase === "checking") {
      return (
        <Button type="button" size="sm" disabled>
          <RefreshCw className="size-3.5 animate-spin" aria-hidden />
          <FormattedMessage id="settings.update.checking" defaultMessage="Checking…" />
        </Button>
      );
    }
    if (phase === "downloading") {
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
        <Button type="button" size="sm" onClick={() => void handleInstallClick()}>
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

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="settings.update.confirmTitle"
                  defaultMessage="Update now?"
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.update.confirmBody"
                  defaultMessage="In-progress tasks will be interrupted. The app restarts when the update finishes."
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => void startInstall()}>
                <FormattedMessage
                  id="settings.update.confirmOk"
                  defaultMessage="Update and restart"
                />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsCard>
    </div>
  );
}
