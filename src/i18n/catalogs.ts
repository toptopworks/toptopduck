// Static catalog import (ADR-0052, issue #78). Vite bundles the JSON at build
// time -- no CDN, no lazy fetch (local-first hard constraint, ADR-0001/0014).
// The two catalogs are the single source of truth for UI chrome text (layer 1);
// their key sets must align (CI enforces via @formatjs/cli extract + the
// catalog-alignment vitest test).

import zhCN from "../locales/zh-CN.json";
import enUS from "../locales/en-US.json";

import type { EffectiveLocale } from "./useLocale";

/** The message catalog per effective locale. react-intl compiles each ICU
 * MessageFormat string on first use; for a desktop app with a small catalog
 * there is no need to pre-compile at build time. */
export const CATALOGS: Readonly<Record<EffectiveLocale, Record<string, string>>> = {
  "zh-CN": zhCN as Record<string, string>,
  "en-US": enUS as Record<string, string>,
};

/** The catalog for a given locale, falling back to en-US when missing
 * (ADR-0052: never crash over an unrecognized locale). */
export function catalogFor(locale: EffectiveLocale): Record<string, string> {
  return CATALOGS[locale] ?? CATALOGS["en-US"];
}

/** The set of catalog keys (same for every locale -- enforced by CI). Useful
 * for the alignment guard and for asserting source coverage. */
export function catalogKeys(): string[] {
  return Object.keys(CATALOGS["en-US"]).sort();
}
