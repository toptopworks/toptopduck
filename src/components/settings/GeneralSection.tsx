import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { getSessionsDir, setSessionsDir } from "../../api";
import type { AppConfig, LocalePreference, Theme } from "../../types/app-config";
import { fmtError } from "../../lib/error-presentation";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";

// General pane (ADR-0075, issue #281): theme + language as compact Select
// dropdowns that commit IMMEDIATELY (governing principle case a). Both prefs
// already apply live -- useTheme + the IntlProvider read app-config directly --
// so the control reflects appConfig with no local draft; a set_app_config IPC
// failure triggers one compensating write that reverts the UI + a surfaced
// inline error (the parent's onCommitImmediate handles revert + formatting).
// No Save button: "what you see is what is stored".
//
// Issue #452: the sessions directory row uses a DIFFERENT model — draft +
// Save. The "Change…" button opens a directory picker; the picked path lands
// in local draft state; Save calls the dedicated set_sessions_dir IPC (not
// set_app_config), which validates + persists + updates the live SessionsRoot.
// The mixed model is acceptable: theme/locale are low-stakes immediate prefs,
// while sessions_dir is a structural directory change that benefits from an
// explicit commit step.

export type GeneralSectionProps = {
  appConfig: AppConfig;
  /** Commit a single-field patch immediately (optimistic). On IPC failure the
   *  parent rolls back with a compensating write and returns the formatted
   *  error message (null on success). */
  onCommitImmediate: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
  /** Replace local appConfig state + refresh sessions after the dedicated
   *  setSessionsDir IPC succeeds (issue #452). The IPC already persisted, so
   *  this is a state-only sync — no redundant set_app_config write. */
  onSessionsDirChanged: (cfg: AppConfig) => void;
};

export function GeneralSection({
  appConfig,
  onCommitImmediate,
  onSessionsDirChanged,
}: GeneralSectionProps) {
  const intl = useIntl();
  const [error, setError] = useState<string | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const [dirBusy, setDirBusy] = useState(false);
  // Draft sessions dir path from the directory picker; null = no pending
  // change. Save commits it via setSessionsDir; cancel / dialog-dismiss is a
  // natural rollback (the draft just stays unused).
  const [draftDir, setDraftDir] = useState<string | null>(null);
  // Backend-resolved path fetched on mount (issue #452 AC2). When
  // appConfig.sessions_dir is null (default), the real path lives only on the
  // backend — fetch it so the settings display shows the resolved directory
  // instead of a "(using default location)" placeholder.
  const [resolvedDir, setResolvedDir] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSessionsDir()
      .then((p) => {
        if (!cancelled) setResolvedDir(p);
      })
      .catch(() => { /* non-fatal: display falls back to placeholder */ });
    return () => {
      cancelled = true;
    };
  }, []);

  async function commitTheme(theme: Theme) {
    setError(await onCommitImmediate((cfg) => ({ ...cfg, theme })));
  }

  async function commitLocale(locale: LocalePreference) {
    setError(await onCommitImmediate((cfg) => ({ ...cfg, locale })));
  }

  async function pickSessionsDir() {
    try {
      const current = await getSessionsDir();
      const picked = await openDialog({ directory: true, multiple: false, defaultPath: current });
      const path = typeof picked === "string" ? picked : null;
      if (path) {
        setDraftDir(path);
        setDirError(null);
      }
    } catch (e) {
      setDirError(fmtError(e, intl));
    }
  }

  async function saveSessionsDir() {
    if (!draftDir) return;
    setDirBusy(true);
    try {
      const updated = await setSessionsDir(draftDir);
      setDraftDir(null);
      setDirError(null);
      onSessionsDirChanged(updated);
    } catch (e) {
      setDirError(fmtError(e, intl));
    } finally {
      setDirBusy(false);
    }
  }

  // The displayed path priority: draft (pending change) > app-config override
  // > backend-resolved default. The last source covers the common case where
  // sessions_dir is null and the real path is only known to the backend.
  const displayPath = draftDir ?? appConfig.sessions_dir ?? resolvedDir;
  const hasDraft = draftDir !== null && draftDir !== appConfig.sessions_dir;

  async function revealSessionsDir() {
    try {
      const target = displayPath ?? (await getSessionsDir());
      await revealItemInDir(target);
    } catch (e) {
      setDirError(fmtError(e, intl));
    }
  }

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.general" defaultMessage="General" />}
        description={(
          <FormattedMessage
            id="settings.general.description"
            defaultMessage="Appearance and language for the workspace."
          />
        )}
      />

      <SettingsCard>
        <SettingsRow
          title={<FormattedMessage id="settings.theme.legend" defaultMessage="Theme" />}
          description={(
            <FormattedMessage
              id="settings.theme.description"
              defaultMessage="Follow the system appearance, or force a light or dark palette."
            />
          )}
          action={(
            <Select
              value={appConfig.theme}
              onValueChange={(v) => void commitTheme(v as Theme)}
            >
              {/* The accessible name reuses the row-title key (ADR-0052: no
                  hardcoded chrome strings) instead of an English literal. */}
              <SelectTrigger
                className="w-48"
                aria-label={intl.formatMessage({
                  id: "settings.theme.legend",
                  defaultMessage: "Theme",
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">
                  <Monitor aria-hidden />
                  <FormattedMessage id="common.followSystem" defaultMessage="Follow system" />
                </SelectItem>
                <SelectItem value="light">
                  <Sun aria-hidden />
                  <FormattedMessage id="settings.theme.light" defaultMessage="Light" />
                </SelectItem>
                <SelectItem value="dark">
                  <Moon aria-hidden />
                  <FormattedMessage id="settings.theme.dark" defaultMessage="Dark" />
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        />

        <SettingsRow
          title={<FormattedMessage id="settings.locale.legend" defaultMessage="Language" />}
          description={(
            <FormattedMessage
              id="settings.locale.hint"
              defaultMessage="Switching the language only affects new turns going forward; past turns keep the language they were generated in (ADR-0039 verbatim principle)."
            />
          )}
          action={(
            <Select
              value={appConfig.locale}
              onValueChange={(v) => void commitLocale(v as LocalePreference)}
            >
              <SelectTrigger
                className="w-48"
                aria-label={intl.formatMessage({
                  id: "settings.locale.legend",
                  defaultMessage: "Language",
                })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">
                  <FormattedMessage id="common.followSystem" defaultMessage="Follow system" />
                </SelectItem>
                <SelectItem value="zh-CN">
                  <FormattedMessage id="settings.locale.zhCN" defaultMessage="简体中文" />
                </SelectItem>
                <SelectItem value="en-US">
                  <FormattedMessage id="settings.locale.enUS" defaultMessage="English" />
                </SelectItem>
              </SelectContent>
            </Select>
          )}
        />

        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.sessionsDir.legend"
              defaultMessage="Sessions directory"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.sessionsDir.description"
              defaultMessage="Where your session files are stored. Already-open sessions stay in their current location; new sessions use the new directory."
            />
          )}
          action={(
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void pickSessionsDir()}
              >
                <FormattedMessage
                  id="settings.sessionsDir.change"
                  defaultMessage="Browse…"
                />
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!hasDraft || dirBusy}
                onClick={() => void saveSessionsDir()}
              >
                <FormattedMessage id="common.save" defaultMessage="Save" />
              </Button>
            </div>
          )}
        >
          <div className="flex items-center gap-3">
            <p
              className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs"
              title={displayPath ?? undefined}
            >
              {displayPath ?? intl.formatMessage({
                id: "settings.sessionsDir.default",
                defaultMessage: "(using default location)",
              })}
            </p>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer text-xs underline-offset-2 hover:underline"
              onClick={() => void revealSessionsDir()}
            >
              <FormattedMessage
                id="settings.sessionsDir.reveal"
                defaultMessage="Show in folder"
              />
            </button>
          </div>
        </SettingsRow>
      </SettingsCard>

      {(dirError ?? error) && (
        <p className="settings-error mt-3 text-destructive text-sm">{dirError ?? error}</p>
      )}
    </div>
  );
}
