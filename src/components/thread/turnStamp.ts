import type { IntlShape } from "react-intl";

/** Chat-style conversation stamp (ADR-0052 chrome): today renders as the
 *  locale time only; an earlier day appends the short date -- the year only
 *  when it differs from the current one. The day boundary is the local
 *  calendar day (midnight rollover), matching the sidebar's time buckets.
 *  `now` is injectable so tests are deterministic. */
export function formatTurnStamp(
  ms: number,
  intl: IntlShape,
  now: number = Date.now(),
): string {
  const stamp = new Date(ms);
  const today = new Date(now);
  const sameDay =
    stamp.getFullYear() === today.getFullYear() &&
    stamp.getMonth() === today.getMonth() &&
    stamp.getDate() === today.getDate();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : {
        month: "short",
        day: "numeric",
        ...(stamp.getFullYear() !== today.getFullYear() && { year: "numeric" }),
        hour: "numeric",
        minute: "2-digit",
      };
  return intl.formatDate(ms, options);
}
