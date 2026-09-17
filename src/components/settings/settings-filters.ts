// The shared list-filter vocabulary for settings panes (issue #976): the
// enabled-axis Select trio consumed verbatim by the MCP and agents panes, plus
// the search-box predicate the MCP / agents / skills panes share. Functions,
// types, and one option-list constant only -- the Select's option-label JSX
// stays in each pane as literal FormattedMessage children, because formatjs
// extract only matches a direct literal descriptor and would drop ids hoisted
// here.

import { searchMatcher } from "../../lib/searchMatcher";

/** The enabled-axis status filter: the value set of the per-pane Select. */
export type EnabledFilter = "all" | "enabled" | "disabled";

/** The Select's option values in display order. */
export const FILTER_OPTIONS: ReadonlyArray<EnabledFilter> = [
  "all",
  "enabled",
  "disabled",
];

/** Whether `entry` passes the enabled-axis filter. `entry` is structural --
 *  any row carrying an `enabled` boolean (an MCP server config, an agent
 *  definition) fits without adapters. */
export function matchesFilter(
  entry: { enabled: boolean },
  filter: EnabledFilter,
): boolean {
  return filter === "all" || (filter === "enabled") === entry.enabled;
}

/** Whether `haystack` (the pane's searchable text) contains the query,
 *  case-insensitively. An empty or whitespace-only query matches everything;
 *  the query is trimmed, the haystack is not -- call sites pass raw text.
 *  The behavior is the shared search matcher, so the composer skill picker
 *  filters through the same implementation and the surfaces cannot drift
 *  (ADR-0112 Decision 5). */
export function matchesSearch(haystack: string, query: string): boolean {
  return searchMatcher(query)(haystack);
}

/** The searchable text for a two-field row: the fields joined by a newline,
 *  so a name tail can never concatenate with a description head into a
 *  false match. One definition shared by the skills and agents panes and
 *  the Decision 5 contract battery -- the expression cannot drift between
 *  the surfaces that must agree. */
export function searchableText(name: string, description: string): string {
  return `${name}\n${description}`;
}
