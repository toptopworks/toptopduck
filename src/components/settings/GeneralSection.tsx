import { FormattedMessage } from "react-intl";
import { Monitor, Moon, Sun } from "lucide-react";

import type { LocalePreference, Theme } from "../../types/app-config";
import { Label } from "../ui/label";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import type { SettingsForm } from "./sections";

// General pane (ADR-0065, issue #151/#153): theme + locale. The API-key +
// endpoint fields that lived here as a transitional home (issue #151) moved
// INTO per-profile management on the Profiles pane (issue #153, ADR-0064) --
// this pane now carries only the app-level appearance + language preferences.
// The storage-model intro stays (it describes where prefs + the key live, which
// is still accurate and useful orientation for a user browsing General).
export function GeneralSection({ form }: { form: SettingsForm }) {
  const { theme, setTheme, locale, setLocale, saving } = form;

  return (
    <div className="grid gap-6">
      {/* Verbatim intro migrated from SettingsDialog's DialogDescription: where
          preferences live (system app-data) vs. where the key lives (OS
          keychain only). The key half is now managed per-profile on the
          Profiles pane; the storage split this describes is unchanged. */}
      <p className="text-muted-foreground text-sm">
        <FormattedMessage
          id="settings.intro"
          defaultMessage="Preferences and defaults live in the system app-data directory (orthogonal to the shareable .duck); the API key lives only in this machine's OS keychain, read by the Rust core — the frontend and page never hold it, and it is never written to app-config."
        />
      </p>

      <fieldset className="grid gap-2 border-0 p-0 m-0">
        <legend className="text-sm font-medium">
          <FormattedMessage id="settings.theme.legend" defaultMessage="Theme" />
        </legend>
        <RadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v as Theme)}
          disabled={saving}
          className="gap-2"
        >
          {(["system", "light", "dark"] as const).map((t) => {
            // Lucide glyphs: system=Monitor, light=Sun, dark=Moon (a theme-radio
            // UX choice; not in ADR-0050's glyph table). Decorative -- the
            // radio's accessible name is the text label.
            const Icon = t === "system" ? Monitor : t === "light" ? Sun : Moon;
            return (
              <div key={t} className="flex items-center gap-2">
                <RadioGroupItem id={`settings-theme-${t}`} value={t} />
                <Label htmlFor={`settings-theme-${t}`} className="font-normal">
                  <Icon size={16} aria-hidden />
                  {t === "system" ? (
                    <FormattedMessage id="settings.theme.system" defaultMessage="Follow system" />
                  ) : t === "light" ? (
                    <FormattedMessage id="settings.theme.light" defaultMessage="Light" />
                  ) : (
                    <FormattedMessage id="settings.theme.dark" defaultMessage="Dark" />
                  )}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      </fieldset>

      {/* Locale radio (ADR-0052, issue #78). Three-state, mirrors the theme
          toggle above -- system follows the OS language; zh-CN / en-US are
          explicit overrides persisted to app-config (ADR-0038). */}
      <fieldset className="grid gap-2 border-0 p-0 m-0">
        <legend className="text-sm font-medium">
          <FormattedMessage id="settings.locale.legend" defaultMessage="Language" />
        </legend>
        <RadioGroup
          value={locale}
          onValueChange={(v) => setLocale(v as LocalePreference)}
          disabled={saving}
          className="gap-2"
        >
          {(["system", "zh-CN", "en-US"] as const).map((l) => (
            <div key={l} className="flex items-center gap-2">
              <RadioGroupItem id={`settings-locale-${l}`} value={l} />
              <Label htmlFor={`settings-locale-${l}`} className="font-normal">
                {l === "system" ? (
                  <FormattedMessage id="settings.locale.system" defaultMessage="Follow system" />
                ) : l === "zh-CN" ? (
                  <FormattedMessage id="settings.locale.zhCN" defaultMessage="简体中文" />
                ) : (
                  <FormattedMessage id="settings.locale.enUS" defaultMessage="English" />
                )}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <p className="text-muted-foreground text-sm">
          <FormattedMessage
            id="settings.locale.hint"
            defaultMessage="Switching the language only affects new turns going forward; past turns keep the language they were generated in (ADR-0039 verbatim principle)."
          />
        </p>
      </fieldset>
    </div>
  );
}
