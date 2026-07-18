// Section navigation model for the in-app settings overlay (ADR-0065, issue
// #151). Kept out of the component so the id set + i18n keys live in one place
// and stay stable across renders. Each entry pairs a `labelId` + defaultMessage
// so the call-site <FormattedMessage> stays a direct literal -- formatjs extract
// resolves ids statically, and a helper returning {id} would break the
// i18n:check CI gate (ADR-0052).

import type {
  EngineDefaults,
  LocalePreference,
  ProviderProfile,
  Theme,
} from "../../types";

/** The four settings panes (ADR-0065): General / Profiles / Engine / Privacy. */
export type SettingsSection = "general" | "profiles" | "engine" | "privacy";

/** The ordered set of settings sections rendered into the left nav. Drives
 *  ORDER + state only; the visible label for each id is rendered by SectionLabel
 *  in SettingsView (a static <FormattedMessage id="..."> per case so formatjs
 *  extract resolves every settings.nav.* id statically -- ADR-0052: a variable
 *  id, or a helper returning {id}, would let the i18n:check CI gate fail). */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  "general",
  "profiles",
  "engine",
  "privacy",
];

/** The mutable settings form state shared between SettingsView and its section
 *  children. Held by the parent (one atomic save commits the whole document);
 *  each pane is a pure editor over a slice of it. */
export interface SettingsForm {
  theme: Theme;
  setTheme: (t: Theme) => void;
  locale: LocalePreference;
  setLocale: (l: LocalePreference) => void;
  engine: EngineDefaults;
  setEngine: (e: EngineDefaults) => void;
  apiKey: string;
  setApiKey: (k: string) => void;
  hasKey: boolean;
  activeProfile: ProviderProfile;
  updateActiveProfile: (patch: Partial<ProviderProfile>) => void;
  saving: boolean;
}
