// Static catalog import (ADR-0052, issue #78). Vite bundles the JSON at build
// time -- no CDN, no lazy fetch (local-first hard constraint, ADR-0001/0014).
// The two catalogs are the single source of truth for UI chrome text (layer 1);
// their key sets must align (CI enforces bidirectional parity via @formatjs/cli
// extract + the catalog-alignment vitest test). Importing en-US without an `as`
// cast lets TypeScript derive a literal key union, so `catalogFor(locale).<typo>`
// fails at compile time -- a structural guard ahead of the CI check.

import zhCN from "../locales/zh-CN.json";
import enUS from "../locales/en-US.json";

import type { EffectiveLocale } from "./useLocale";

/** The message catalog shape, derived from the en-US source-of-truth catalog.
 * Typing the registry against this shape makes a missing zh-CN key a compile
 * error; full bidirectional parity (no extra keys either) is still pinned by
 * the CI alignment check. */
export type Catalog = typeof enUS;

/** A catalog message id (literal union). Exposed so a future wrapper around
 * `<FormattedMessage>` can constrain its `id` prop and catch typos at compile
 * time, complementing the CI alignment check. */
export type CatalogKey = keyof Catalog;

// Not re-exported through the barrel: the catalog registry is an internal
// detail, and `catalogFor` is the only public accessor.
const CATALOGS: Readonly<Record<EffectiveLocale, Catalog>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** The catalog for a given locale. `EffectiveLocale` is a closed two-value
 * union and `CATALOGS` carries both keys, so the lookup cannot miss -- no
 * fallback is needed. ADR-0052's "never crash over an unrecognized locale" is
 * upheld structurally: a future locale added to `EffectiveLocale` without a
 * catalog entry becomes a compile error here, not a silent runtime fallback. */
export function catalogFor(locale: EffectiveLocale): Catalog {
  return CATALOGS[locale];
}
