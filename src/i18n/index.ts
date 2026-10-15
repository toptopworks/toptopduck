// i18n barrel (ADR-0052, issue #78). The four-layer translation boundary's
// frontend entry point:
// - layer 1 (UI chrome text): `catalogFor` + react-intl `<FormattedMessage>` /
//   `useIntl` -- the catalog is the single source of truth for chrome strings.
// - layer 2 (system format): Intl.NumberFormat / DateTimeFormat display
//   formatting (data content never passes through here). No consumer yet --
//   add a hook here when chrome needs number/date formatting.
// - layer 3 (LLM content): the Rust side appends the locale directive; the
//   frontend only resolves the same preference for the IntlProvider locale.
// - layer 4 (never translated): user questions, SQL, `result_N`, data content,
//   Recipe -- these never enter this module.

export { catalogFor } from "./catalogs";
export type { Catalog, CatalogKey } from "./catalogs";
export {
  coerceLocalePreference,
  DEFAULT_LOCALE_PREFERENCE,
  FALLBACK_LOCALE,
  isLocalePreference,
  resolveEffectiveLocale,
  resolveLocaleTag,
  useLocale,
} from "./useLocale";
export type { EffectiveLocale } from "./useLocale";
