import type { IntlShape } from "react-intl";

/** The fixed K/M token form (12,345 -> "12.3K"): the ONE formatter every
 * usage surface routes through (ADR-0129 Decision 5; the scale calibrated
 * by ADR-0130 Decision 5), so all token numbers read in the same shape
 * wherever they land. The scale is locale-independent BY DECISION: Intl's
 * compact notation renders locale-shaped figures (zh "万", de-style
 * separators), so the fixed K/M algorithm replaces it. `intl` stays in the
 * signature (call-site stability, ADR-0130: the formatting single-throat
 * keeps its surface) but is no longer consulted.
 *
 * Boundaries: under 1K verbatim ("999"); under 1M one floored decimal
 * stripped of a trailing zero ("1K", "1.5K", "999.9K"); 1M+ the same
 * shape in M ("1M"). Floored, never rounded -- a reading never crosses a
 * unit boundary it did not reach. */
export function formatTokens(
  n: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intl stays in the signature (ADR-0130: the formatting single-throat keeps its call surface) even though the fixed scale never consults it.
  _intl: IntlShape,
): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${scaled(n, 100, 10)}K`;
  return `${scaled(n, 100_000, 10)}M`;
}

/** One floored decimal at the given scale: `floor(n / divisor) / tenths`,
 * the trailing ".0" stripped. */
function scaled(n: number, divisor: number, tenths: number): string {
  const v = Math.floor(n / divisor) / tenths;
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
