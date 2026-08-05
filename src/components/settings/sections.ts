// Section navigation model for the in-app settings overlay (ADR-0065, issue
// #151; ADR-0075, issue #281). Kept out of the component so the id set lives in
// one place and stays stable across renders.
//
// ADR-0075 retired the shared mutable SettingsForm bag (the global draft): every
// pane now self-persists through the parent's commit helper, so this module only
// carries the section id set + order.

/** The settings panes (ADR-0065 + #362 skills): General / Skills / Profiles /
 *  Engine / Privacy. */
export type SettingsSection = "general" | "skills" | "profiles" | "engine" | "privacy";

/** The ordered set of settings sections rendered into the left rail. Drives
 *  ORDER + state only; the visible label for each id is rendered by SectionLabel
 *  in SettingsView (a static <FormattedMessage id="..."> per case so formatjs
 *  extract resolves every settings.nav.* id statically -- ADR-0052: a variable
 *  id, or a helper returning {id}, would let the i18n:check CI gate fail). */
export const SETTINGS_SECTIONS: ReadonlyArray<SettingsSection> = [
  "general",
  "skills",
  "profiles",
  "engine",
  "privacy",
];
