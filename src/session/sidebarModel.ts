// Pure sidebar model (ADR-0060/0061, issue #81): merges the persisted-session
// list (list_sessions) with the open in-memory sessions, Chat-style time-groups
// the entries, and sorts last-modified descending. Kept out of the component so
// the merge + grouping + ordering is unit-testable without React, and so the
// sidebar component stays a thin caller of these functions.
//
// Identity split (ADR-0060/0061): a PERSISTED session's stable identity is its
// `.duck` file path (SessionMetadata.session_id); an OPEN session's runtime
// identity is its ephemeral UUID (createSession). An open session that has bound
// a .duck carries that path; a never-saved new session has path = null and only
// exists in the open set.
//
// Grouping mode (ADR-0072, issue #251): the user toggles between `flat` (a
// single Recent group sorted by mtime descending, the default) and `time` (the
// ADR-0060 Chat-style Today/Yesterday/Previous 7 days/Older buckets). The mode
// rides the shell-chrome prefs; buildSidebarGroups takes it as a parameter so
// the component is a thin caller.

import type { SessionMetadata } from "../types/session";
import type { SidebarGrouping } from "../types/app-config";

/** A runtime-open session tracked by the shell (ADR-0060/0051 keep-alive). */
export interface OpenSession {
  /** Runtime UUID from createSession (ephemeral; not persisted). */
  sid: string;
  /** Display name. Held in memory for an unsaved session; from the recipe once
   *  bound (and updated by rename). */
  name: string;
  /** Bound `.duck` path (SessionMetadata.session_id shape), or null for a
   *  never-saved new session. */
  path: string | null;
  /** A pending data-file drop routed to this session's ingest but not yet
   *  kicked off (ADR-0061, #81 A1; issue #205). Two routes set it: a cold-start
   *  drop mints a new session carrying the path, and a drop onto an
   *  ALREADY-active session (new or resumed / .duck-bound) routes the file
   *  there via the shell's single webview-level drop router -- so a non-null
   *  pendingIngestPath can coexist with a non-null `path` (the resumed + drop
   *  combination is legal). The SessionPane consumes it via handleIngest --
   *  the only path that can surface an xlsx NeedsGuidance result into the
   *  guidance dialog -- then clears it through onIngestConsumed. null once
   *  consumed or when the session was opened by a non-drop action. */
  pendingIngestPath: string | null;
}

/** The four ADR-0060 Chat-style time buckets (Today / Yesterday / Previous 7
 *  days / Older). */
export type TimeGroupKind = "today" | "yesterday" | "last7" | "older";

/** Every renderable sidebar group heading: the four time buckets plus
 *  `recent` for ADR-0072's flat mode (single group sorted by mtime descending).
 *  The per-mode correspondence (flat -> `recent`, time -> `TimeGroupKind`) is a
 *  type-level invariant on SidebarGroup's discriminated union, not this union. */
export type SidebarGroupKind = TimeGroupKind | "recent";

/** A single merged sidebar entry (persisted, open, or both). */
export interface SidebarEntry {
  /** Stable key for React: the bound path when one exists, else the runtime sid
   *  (a never-saved session has no path). */
  key: string;
  /** Display name (user rename > recipe default). */
  name: string;
  /** The runtime sid when the session is OPEN in this shell, else null (the
   *  entry is a cold persisted row; clicking it resumes / mints a sid). */
  sid: string | null;
  /** Bound `.duck` path, or null for a never-saved new session. */
  path: string | null;
  /** Whether this entry is the currently active session. */
  active: boolean;
  /** First source display name for the sub-line (null = no sources yet). */
  firstSourceName: string | null;
  /** Productive turn count for the sub-line. */
  turnCount: number;
  /** last_modified_at, ms since epoch. A never-saved session has no mtime, so
   *  the caller stamps it at creation to land under "Today" at the top. */
  lastModifiedAt: number;
}

/** A search-result row (ADR-0072, issue #252). Narrower than SidebarEntry:
 *  every persisted search row carries a non-null path (m.session_id), so the
 *  modal's choose() can branch on sid-vs-path without the defensive else-throw
 *  the wider SidebarEntry state space (which admits the unsaved-open row with
 *  path=null) would demand. */
export type SearchEntry = Omit<SidebarEntry, "path"> & { path: string };

/** A rendered sidebar group: heading kind + its entries (already sorted). The
 *  `mode` discriminant makes the kind/mode correspondence a type-level
 *  invariant -- a flat-mode group only ever carries kind="recent"; a time-mode
 *  group only carries a TimeGroupKind. buildSidebarGroups is the sole
 *  constructor; consumers narrow on `mode` when they need the guarantee. */
export type SidebarGroup =
  | { mode: "flat"; kind: "recent"; entries: SidebarEntry[] }
  | { mode: "time"; kind: TimeGroupKind; entries: SidebarEntry[] };

const MS_PER_DAY = 86_400_000;

function startOfCalendarDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The Calendar-day bucket an mtime falls into, relative to "now". Pure: the
 *  caller passes `now` so tests are deterministic. The buckets match the
 *  Chat-style grouping in ADR-0060 (Today / Yesterday / Previous 7 days / Older). Day boundaries
 *  are local calendar days (midnight rollover), not 24h windows. */
export function timeGroupKind(lastModifiedAt: number, now: number): TimeGroupKind {
  const today = startOfCalendarDay(now);
  const entry = startOfCalendarDay(lastModifiedAt);
  if (entry >= today) return "today";
  if (entry >= today - MS_PER_DAY) return "yesterday";
  if (entry >= today - 7 * MS_PER_DAY) return "last7";
  return "older";
}

/** A dynamic-format classification of an mtime for sub-line display (ADR-0072
 *  search slice). Pure in (lastModifiedAt, now): returns
 *  `today` / `yesterday` for the past two local calendar days (the caller
 *  localizes via intl), else a `date` arm carrying the Date so the caller can
 *  format with Intl.DateTimeFormat -- year-included when the mtime predates the
 *  current year, month/day otherwise. Day boundaries are local calendar days
 *  (midnight rollover), matching `timeGroupKind`. */
export type LastModifiedLabel =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; date: Date };

/** Classify an mtime for sub-line display (ADR-0072, issue #251). See
 *  {@link LastModifiedLabel}. */
export function formatLastModified(lastModifiedAt: number, now: number): LastModifiedLabel {
  const today = startOfCalendarDay(now);
  const entry = startOfCalendarDay(lastModifiedAt);
  if (entry >= today) return { kind: "today" };
  if (entry >= today - MS_PER_DAY) return { kind: "yesterday" };
  return { kind: "date", date: new Date(lastModifiedAt) };
}

/** Build the flat, filtered, mtime-descending entry list for the Ctrl/⌘+K search
 *  modal (ADR-0072, issue #252). Pure in
 *  (persisted, open, activeSessionId, query): the caller supplies the raw
 *  `list_sessions` result + the open set + the active id + the query string;
 *  this function does the rest. Kept alongside `buildSidebarGroups` because the
 *  per-row shape + the persisted/open merge contract are shared with the sidebar
 *  (a row that is open in this shell carries its runtime sid, so the modal can
 *  activate-by-sid instead of re-resuming).
 *
 *  Scope (ADR-0072): only PERSISTED sessions are searchable -- the
 *  `list_sessions` result. An unsaved new session (no .duck) is NOT in
 *  list_sessions and never appears here, even when it is the active session
 *  (the sidebar still lists it; the modal is a persisted-session jump surface).
 *  Every emitted row therefore has a non-null path, so the return type is
 *  `SearchEntry[]` (a path-non-null narrowing of SidebarEntry).
 *
 *  Filter: case-insensitive substring over `display_name` + the first source's
 *  name. An empty / whitespace-only query returns every session (Ctrl/⌘+K is
 *  also a browse/jump entry point). Sorted mtime desc with a name tiebreaker
 *  for deterministic rendering, matching `buildSidebarGroups`.
 *
 *  Unlike `buildSidebarGroups`, no `now` parameter: the modal is a single flat
 *  list (no time buckets) and the sub-line's relative-day label is resolved in
 *  the component via `formatLastModified` (a React-layer concern -- it needs
 *  the localized heading text). */
export function buildSearchEntries(
  persisted: SessionMetadata[],
  open: OpenSession[],
  activeSessionId: string | null,
  query: string,
): SearchEntry[] {
  // Index open sessions by their bound path so a persisted row can pick up its
  // runtime sid + latest name in one lookup. Unsaved open sessions are skipped
  // (no path -> not in list_sessions -> out of scope for the modal).
  const openByPath = new Map<string, OpenSession>();
  for (const o of open) {
    if (o.path) openByPath.set(o.path, o);
  }

  const q = query.trim().toLowerCase();
  const entries: SearchEntry[] = [];
  for (const m of persisted) {
    // Compose a single haystack so the substring test runs once per row; the
    // space keeps a name that ends with the source's prefix from bridging into
    // a false positive at the boundary.
    const hay = `${m.display_name} ${m.source_summary.first_source_name ?? ""}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const bound = openByPath.get(m.session_id) ?? null;
    entries.push({
      key: m.session_id,
      name: bound?.name ?? m.display_name,
      sid: bound?.sid ?? null,
      path: m.session_id,
      active: bound !== null && bound.sid === activeSessionId,
      firstSourceName: m.source_summary.first_source_name,
      turnCount: m.source_summary.turn_count,
      lastModifiedAt: m.last_modified_at,
    });
  }

  // Sort last-modified descending. Ties (same mtime) fall back to name so the
  // render is deterministic across renders -- matches `buildSidebarGroups`.
  entries.sort(
    (a, b) => b.lastModifiedAt - a.lastModifiedAt || a.name.localeCompare(b.name),
  );
  return entries;
}

/** Build the merged, grouped, last-modified-descending sidebar model. Pure in
 *  (persisted, open, activeSessionId, now, grouping) -- the component supplies
 *  the raw list_sessions result + the open set + the user's grouping choice;
 *  this function does the rest. A persisted session that is also open merges
 *  into one entry (open = true, sid set); an open never-saved session becomes
 *  its own entry; every entry carries the display fields the row renders.
 *
 *  Grouping (ADR-0072, issue #251): `flat` -> a single `recent` group sorted by
 *  mtime descending (the "Recent" title); `time` -> the ADR-0060 Chat-style
 *  Today / Yesterday / Previous 7 days / Older buckets. An empty sidebar yields
 *  an empty group list in either mode. */
export function buildSidebarGroups(
  persisted: SessionMetadata[],
  open: OpenSession[],
  activeSessionId: string | null,
  now: number,
  grouping: SidebarGrouping,
): SidebarGroup[] {
  // Index open sessions by their bound path so a persisted row can pick up its
  // runtime sid + latest name in one lookup.
  const openByPath = new Map<string, OpenSession>();
  const unsavedOpen: OpenSession[] = [];
  for (const o of open) {
    if (o.path) openByPath.set(o.path, o);
    else unsavedOpen.push(o);
  }

  const entries: SidebarEntry[] = [];

  // Persisted rows (resume-on-click targets). An open binding upgrades the row
  // with its runtime sid + the (possibly renamed) in-memory name.
  for (const m of persisted) {
    const bound = openByPath.get(m.session_id) ?? null;
    entries.push({
      key: m.session_id,
      name: bound?.name ?? m.display_name,
      sid: bound?.sid ?? null,
      path: m.session_id,
      active: bound !== null && bound.sid === activeSessionId,
      firstSourceName: m.source_summary.first_source_name,
      turnCount: m.source_summary.turn_count,
      lastModifiedAt: m.last_modified_at,
    });
  }

  // Open never-saved sessions: not in list_sessions, so render them as their own
  // rows. They have no recipe mtime, so stamp `now` to land them under Today at
  // the top until the first save-as binds a real path + mtime.
  for (const o of unsavedOpen) {
    entries.push({
      key: o.sid,
      name: o.name,
      sid: o.sid,
      path: null,
      active: o.sid === activeSessionId,
      firstSourceName: null,
      turnCount: 0,
      lastModifiedAt: now,
    });
  }

  // No entries -> no groups (ADR-0072: an empty sidebar renders no group title,
  // so the grouping toggle's hover affordance is hidden too).
  if (entries.length === 0) return [];

  // Sort last-modified descending. Ties (same mtime) fall back to name so the
  // render is deterministic across renders. Both grouping modes consume the
  // same sorted order.
  entries.sort(
    (a, b) => b.lastModifiedAt - a.lastModifiedAt || a.name.localeCompare(b.name),
  );

  if (grouping === "flat") {
    // ADR-0072 flat mode: a single Recent group, already sorted by mtime desc.
    return [{ mode: "flat", kind: "recent", entries }];
  }

  if (grouping === "time") {
    // ADR-0060 time mode: Chat-style Today / Yesterday / Previous 7 days /
    // Older, each omitted when empty.
    const groups: SidebarGroup[] = [];
    for (const kind of ["today", "yesterday", "last7", "older"] as const) {
      const groupEntries = entries.filter(
        (e) => timeGroupKind(e.lastModifiedAt, now) === kind,
      );
      if (groupEntries.length > 0) {
        groups.push({ mode: "time", kind, entries: groupEntries });
      }
    }
    return groups;
  }

  // Exhaustive guard: a future third SidebarGrouping variant must add a branch
  // above, not silently fall through to time buckets. tsconfig strict lacks
  // noImplicitReturns, so without this the implicit `return undefined` would
  // slip; the never assignment fails tsc if a variant is added without a
  // branch (mirrors the loadErrorDisplay/api.ts default:never+throw pattern).
  const _exhaustive: never = grouping;
  return _exhaustive;
}
