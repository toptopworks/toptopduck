import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { getSessionsDir, setSessionsDir } from "../../api";
import type { AppConfig, LocalePreference, Theme, Tunables } from "../../types/app-config";
import { fmtError } from "../../lib/error-presentation";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";

/** Local string draft of the tunables (#1449). Numeric fields are held as the
 *  raw text the user typed (including "") so a field can be cleared and
 *  retyped instead of snapping back to 1; parsing + clamping happen at the
 *  save boundary (the Engine pane precedent: an explicit save is not a
 *  correctness gate). */
type TunablesDraft = {
  window_turns: string;
  result_count_cap: string;
};

function toTunablesDraft(t: Tunables): TunablesDraft {
  return {
    window_turns: String(t.window_turns),
    result_count_cap: String(t.result_count_cap),
  };
}

/** Apply one draft field onto the latest app-config's tunables
 *  (read-modify-write keeps the sibling field intact); an empty / invalid /
 *  below-one value clamps to the safe minimum of 1. */
function patchTunables(cfg: AppConfig, field: keyof TunablesDraft, raw: string): AppConfig {
  const parsed = Number(raw);
  const tunables = { ...cfg.tunables };
  tunables[field] = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
  return { ...cfg, tunables };
}

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
//
// Issue #1449: the Tunables card sits between the appearance prefs and the
// sessions directory (which stays last as the pane's structural change), and
// follows the Engine pane's model — string drafts, per-field Save, parse +
// clamp at the save boundary, each row's semantics as its description line —
// but commits through onCommitImmediate (plain set_app_config, no dedicated
// IPC). Both values are construction-point snapshots (ADR-0013/0023/0028):
// a change reaches sessions created or resumed afterwards only.

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
  /** Report IPC busy state to SettingsView's close guard (ADR-0075). The
   *  sessions-dir Save IPC is tracked here so ESC / close is blocked while
   *  it is in flight (I-2). */
  onIpcBusy: (channel: "sessionsDir", busy: boolean) => void;
};

export function GeneralSection({
  appConfig,
  onCommitImmediate,
  onSessionsDirChanged,
  onIpcBusy,
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

  // Tunables drafts (#1449), seeded per mount; each field commits
  // independently through onCommitImmediate and shares the pane's single
  // error surface with the immediate-commit rows.
  const [tunablesDraft, setTunablesDraft] = useState<TunablesDraft>(
    toTunablesDraft(appConfig.tunables),
  );
  const [savingTunable, setSavingTunable] = useState<keyof TunablesDraft | null>(null);

  async function saveTunable(field: keyof TunablesDraft) {
    setSavingTunable(field);
    setError(null);
    setError(await onCommitImmediate((cfg) => patchTunables(cfg, field, tunablesDraft[field])));
    setSavingTunable(null);
  }

  const tunablesSaving = savingTunable !== null;

  function tunablesSaveButton(field: keyof TunablesDraft) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void saveTunable(field)}
        disabled={tunablesSaving}
      >
        {savingTunable === field ? (
          <FormattedMessage id="common.saving" defaultMessage="Saving…" />
        ) : (
          <FormattedMessage id="common.save" defaultMessage="Save" />
        )}
      </Button>
    );
  }

  async function pickSessionsDir() {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: displayPath ?? undefined,
      });
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
    onIpcBusy("sessionsDir", true);
    try {
      const updated = await setSessionsDir(draftDir);
      setDraftDir(null);
      setDirError(null);
      onSessionsDirChanged(updated);
    } catch (e) {
      setDirError(fmtError(e, intl));
    } finally {
      setDirBusy(false);
      onIpcBusy("sessionsDir", false);
    }
  }

  // The displayed path priority: draft (pending change) > app-config override
  // > backend-resolved default. The last source covers the common case where
  // sessions_dir is null and the real path is only known to the backend.
  const displayPath = draftDir ?? appConfig.sessions_dir ?? resolvedDir;
  const hasDraft = draftDir !== null && draftDir !== appConfig.sessions_dir;

  async function revealSessionsDir() {
    if (!displayPath) return;
    try {
      await revealItemInDir(displayPath);
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
            defaultMessage="Appearance, language, and system settings."
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
              defaultMessage="Switching the language only affects new turns going forward; past turns keep the language they were generated in."
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

      </SettingsCard>

      {/* Tunables (#1449): the two session-engine construction-point
       *  snapshots (ADR-0013/0023/0028), in the Engine pane's posture —
       *  rows with their semantics as the description line. */}
      <SettingsCard className="mt-4">
        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.general.tunables.windowTurns"
              defaultMessage="Recent-turn window"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.general.tunables.windowTurns.description"
              defaultMessage="The most recent turns are carried into the model in full; earlier turns fold into a question summary. Applies to sessions created or reopened afterwards."
            />
          )}
          action={tunablesSaveButton("window_turns")}
        >
          {/* The accessible name reuses the row-title key (ADR-0052), so the
           *  input is addressable without a positional query. */}
          <Input
            type="number"
            min={1}
            aria-label={intl.formatMessage({
              id: "settings.general.tunables.windowTurns",
              defaultMessage: "Recent-turn window:",
            })}
            value={tunablesDraft.window_turns}
            onChange={(e) => setTunablesDraft({ ...tunablesDraft, window_turns: e.target.value })}
            disabled={tunablesSaving}
          />
        </SettingsRow>

        <SettingsRow
          title={(
            <FormattedMessage
              id="settings.general.tunables.resultCountCap"
              defaultMessage="Data result cap"
            />
          )}
          description={(
            <FormattedMessage
              id="settings.general.tunables.resultCountCap.description"
              defaultMessage="When a session holds more data results than the cap, the oldest unused ones are cleaned up automatically; results in use are never removed. Applies to sessions created or reopened afterwards."
            />
          )}
          action={tunablesSaveButton("result_count_cap")}
        >
          <Input
            type="number"
            min={1}
            aria-label={intl.formatMessage({
              id: "settings.general.tunables.resultCountCap",
              defaultMessage: "Result count cap:",
            })}
            value={tunablesDraft.result_count_cap}
            onChange={(e) =>
              setTunablesDraft({ ...tunablesDraft, result_count_cap: e.target.value })}
            disabled={tunablesSaving}
          />
        </SettingsRow>
      </SettingsCard>

      {/* The sessions directory is its own group at the pane's bottom (a
       * structural directory change, visually apart from the preference
       * cards above). */}
      <SettingsCard className="mt-4">
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
              className="text-muted-foreground hover:text-foreground focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 shrink-0 text-xs underline-offset-2 hover:underline"
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
