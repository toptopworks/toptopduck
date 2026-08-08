import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Monitor, Moon, Sun } from "lucide-react";

import type { AppConfig, LocalePreference, Theme } from "../../types/app-config";
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
// No Save button: "what you see is what is stored". The API-key + endpoint
// fields that once lived here are managed per-profile on the Profiles pane
// (issue #153, ADR-0064).

export type GeneralSectionProps = {
  appConfig: AppConfig;
  /** Commit a single-field patch immediately (optimistic). On IPC failure the
   *  parent rolls back with a compensating write and returns the formatted
   *  error message (null on success). */
  onCommitImmediate: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
};

export function GeneralSection({ appConfig, onCommitImmediate }: GeneralSectionProps) {
  const intl = useIntl();
  const [error, setError] = useState<string | null>(null);

  async function commitTheme(theme: Theme) {
    setError(await onCommitImmediate((cfg) => ({ ...cfg, theme })));
  }

  async function commitLocale(locale: LocalePreference) {
    setError(await onCommitImmediate((cfg) => ({ ...cfg, locale })));
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
      </SettingsCard>

      {error && <p className="settings-error mt-3 text-destructive text-sm">{error}</p>}
    </div>
  );
}
