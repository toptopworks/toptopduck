import type { IntlShape } from "react-intl";

/** The locale's compact token form (12,345 -> "12K"): the ONE formatter
 * every usage surface routes through (ADR-0129 Decision 5, issue #1270),
 * so all token numbers read in the same shape wherever they land. Lives in
 * its own module (the turnStamp.ts precedent) so the component file stays
 * component-only (react-refresh). */
export function formatTokens(n: number, intl: IntlShape): string {
  return intl.formatNumber(n, { notation: "compact" });
}
