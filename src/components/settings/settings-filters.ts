// The shared list-filter vocabulary for settings panes (issue #976): the
// enabled-axis Select trio consumed verbatim by the MCP and agents panes, plus
// the case-insensitive substring core the MCP / agents / skills search boxes
// share. Functions, types, and one option-list constant only -- the Select's
// option-label JSX stays in each pane as literal FormattedMessage children,
// because formatjs extract only matches a direct literal descriptor and would
// drop ids hoisted here.

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
 *  the query is trimmed, the haystack is not -- both sides lower-case here,
 *  so call sites pass raw text. */
export function matchesSearch(haystack: string, query: string): boolean {
  if (query.trim() === "") return true;
  return haystack.toLowerCase().includes(query.trim().toLowerCase());
}
