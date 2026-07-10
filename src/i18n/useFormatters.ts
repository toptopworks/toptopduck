import { useMemo } from "react";

import type { EffectiveLocale } from "./useLocale";

// Layer-2 system formatters (ADR-0052, issue #78): Intl.NumberFormat /
// DateTimeFormat bound to the effective locale. DISPLAY-ONLY -- the underlying
// data is never reshaped; data-table cell content stays verbatim (ADR-0057
// "content bytes unchanged"). Only chrome metadata ("uploaded on…", row counts,
// dates) passes through these. Re-created when the locale changes so the
// displayed format follows the preference live.
//
// Distinct from the layer-1 string catalog (FormattedMessage): this owns the
// Intl.* format side, the catalog owns the ICU message text. Cohabiting the i18n
// module but with separated responsibilities (ADR-0052 Q6).

export interface LocaleFormatters {
  /** Format a number for display using the current locale's conventions
   * (thousands separator, decimal mark). */
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** Format a date / timestamp for display using the current locale's date
   * conventions. */
  formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
}

/** Build a memoized set of Intl formatters bound to `locale`. The formatters are
 * re-created only when the locale changes, so a render that keeps the locale
 * reuses the cached NumberFormat / DateTimeFormat instances. */
export function useFormatters(locale: EffectiveLocale): LocaleFormatters {
  return useMemo(() => {
    const numberFmt = new Intl.NumberFormat(locale);
    const dateFmt = new Intl.DateTimeFormat(locale);
    return {
      // The common path (no options) reuses the cached instance; a call with
      // bespoke options builds a one-off formatter rather than caching every
      // option combo (YAGNI -- the chrome formatting surface is small).
      formatNumber: (value, options) =>
        options ? new Intl.NumberFormat(locale, options).format(value) : numberFmt.format(value),
      formatDate: (value, options) =>
        options ? new Intl.DateTimeFormat(locale, options).format(value) : dateFmt.format(value),
    };
  }, [locale]);
}
