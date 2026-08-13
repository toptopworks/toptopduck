import type { IntlShape } from "react-intl";
import type { LastModifiedLabel } from "./sidebarModel";

// This file holds two independent time-formatting helpers:
//   • formatLastModifiedText — calendar-day label for the search dialog sub-line
//     (Today / Yesterday / date). The pure classification stays in
//     sidebarModel.ts (`formatLastModified`); this helper is the React-layer
//     string resolution (needs `intl.formatMessage`).
//   • formatRelativeTime — compact duration for the sidebar row inline display
//     (e.g. "8h", "3w"). Issue #513: shown after the status dot.

/** Format a {@link LastModifiedLabel} into a localized display string. */
export function formatLastModifiedText(
  label: LastModifiedLabel,
  now: number,
  intl: IntlShape,
): string {
  switch (label.kind) {
    case "today":
      return intl.formatMessage({ id: "sidebar.group.today", defaultMessage: "Today" });
    case "yesterday":
      return intl.formatMessage({
        id: "sidebar.group.yesterday",
        defaultMessage: "Yesterday",
      });
    case "date": {
      const sameYear = new Date(now).getFullYear() === label.date.getFullYear();
      return new Intl.DateTimeFormat(intl.locale, {
        ...(sameYear ? {} : { year: "numeric" }),
        month: "short",
        day: "numeric",
      }).format(label.date);
    }
    default: {
      // Exhaustive guard: a new LastModifiedLabel variant must add a case
      // above. tsconfig strict lacks noImplicitReturns, so without this the
      // implicit return undefined would slip (mirrors sidebarModel.ts
      // buildSidebarGroups + loadErrorDisplay/api.ts).
      const _exhaustive: never = label;
      return _exhaustive;
    }
  }
}

/** Format a compact relative duration between lastModifiedAt and now (e.g.
 *  "8小时", "3周", "2m"). Uses Intl.NumberFormat with unit style for
 *  locale-aware output; spaces are stripped for a compact inline display.
 *  The value is clamped to non-negative so a session modified after the
 *  captured `now` (clock skew / just-saved) shows as "0秒" instead of a
 *  negative duration. issue #513: the sidebar row shows this after the status
 *  dot. */
export function formatRelativeTime(
  lastModifiedAt: number,
  now: number,
  locale: string,
): string {
  // Clamp to 0 — `now` is captured at sidebar mount, so a session modified
  // after that moment would otherwise produce a negative duration.
  const diffSec = Math.max(0, Math.round((now - lastModifiedAt) / 1000));
  type RelativeUnit = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";
  const nf = (unit: RelativeUnit, value: number) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "narrow",
    })
      .format(value)
      .replace(/\s/g, "");

  if (diffSec < 60) return nf("second", diffSec);
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return nf("minute", diffMin);
  const diffHr = Math.round(diffSec / 3600);
  if (diffHr < 24) return nf("hour", diffHr);
  const diffDay = Math.round(diffSec / 86400);
  if (diffDay < 7) return nf("day", diffDay);
  const diffWk = Math.round(diffSec / 604800);
  if (diffWk < 5) return nf("week", diffWk);
  const diffMo = Math.round(diffSec / 2629800);
  if (diffMo < 12) return nf("month", diffMo);
  return nf("year", Math.round(diffSec / 31557600));
}
