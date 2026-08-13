// Pure sidebar model (ADR-0060/0061/0089, issue #81): merges the persisted-
// session list (list_sessions) with the open in-memory sessions, Chat-style
// time-groups the entries, and sorts last-modified descending. Kept out of the
// component so the merge + grouping + ordering is unit-testable without React,
// and so the sidebar component stays a thin caller of these functions.
//
// Identity split (ADR-0060/0061/0089): a PERSISTED session's stable identity is
// its `.duck` file path (SessionMetadata.duck_path); an OPEN session's runtime
// identity is its ephemeral UUID (createSession). Since ADR-0089 every session
// is persisted from creation, so every OpenSession carries a non-null path —
// the "unsaved" state no longer exists.
//
// Grouping mode (ADR-0072, issue #251): the user toggles between `flat` (a
// single Recent group sorted by mtime descending, the default) and `time` (the
// ADR-0060 Chat-style Today/Yesterday/Previous 7 days/Older buckets). The mode
// rides the shell-chrome prefs; buildSidebarGroups takes it as a parameter so
// the component is a thin caller.

import type { SessionMetadata } from "../types/session";
import type { SidebarGrouping } from "../types/app-config";

/** A runtime-open session tracked by the shell (ADR-0060/0051 keep-alive).
 *  Since ADR-0089 every session is persisted from creation, so `path` is always
 *  non-null. */
export interface OpenSession {
  /** Runtime UUID from createSession (ephemeral; not persisted). */
  sid: string;
  /** Display name. Starts empty (placeholder); updated by rename or the first
   *  turn's auto-naming. */
  name: string;
  /** Bound `.duck` path (SessionMetadata.duck_path shape). Always non-null
   *  since ADR-0089: createSession binds immediately. */
  path: string;
  /** Pending data-file paths routed to this session's ingest but not yet
   *  kicked off (ADR-0061, #81 A1; issue #205; #500 draft-mode file list).
   *  Three routes set it: a cold-start drop mints a new session carrying the
   *  dropped path, a drop onto an ALREADY-active session (new or resumed)
   *  routes the file there via the shell's single webview-level drop router,
   *  and a cold-start composer "+" pick accumulates the shell-level pending
   *  file list which the first submit carries onto the minted session (#500).
   *  The SessionPane consumes it via handleIngestMany, then clears it through
   *  onIngestConsumed. Empty once consumed or when the session was opened by
   *  a non-drop / non-cold-start action. */
  pendingIngestPaths: string[];
  /** A pending question from the shell-level cold-start bar (ADR-0092). When
   *  the user submits from the centered bar with no active session, the shell
   *  creates a session carrying the question here; SessionPane consumes it via
   *  handleAsk on mount, then clears it through onQuestionConsumed. null for
   *  sessions opened by any other action. */
  pendingQuestion: string | null;
}

/** The four ADR-0060 Chat-style time buckets (Today / Yesterday / Previous 7
 *  days / Older). */
export type TimeGroupKind = "today" | "yesterday" | "last7" | "older";

/** Every renderable sidebar group heading: the four time buckets plus
 *  `recent` for ADR-0072's flat mode (single group sorted by mtime descending).
 *  The per-mode correspondence (flat -> `recent`, time -> `TimeGroupKind`) is a
 *  type-level invariant on SidebarGroup's discriminated union, not this union. */
export type SidebarGroupKind = TimeGroupKind | "recent";

/** A single merged sidebar entry (persisted + optionally open). Since ADR-0089
 *  every session is persisted from creation, so `path` is always non-null. */
export interface SidebarEntry {
  /** Stable key for React: the bound path (always present since ADR-0089). */
  key: string;
  /** Display name (user rename > recipe default). */
  name: string;
  /** The runtime sid when the session is OPEN in this shell, else null (the
   *  entry is a cold persisted row; clicking it resumes / mints a sid). */
  sid: string | null;
  /** Bound `.duck` path. Always non-null since ADR-0089. */
  path: string;
  /** Whether this entry is the currently active session. */
  active: boolean;
  /** First source display name for the sub-line (null = no sources yet). */
  firstSourceName: string | null;
  /** Total loaded source count (ADR-0093, issue #513: hover-card metadata). */
  sourceCount: number;
  /** Productive turn count for the sub-line. */
  turnCount: number;
  /** last_modified_at, ms since epoch. A never-saved session has no mtime, so
   *  the caller stamps it at creation to land under "Today" at the top. */
  lastModifiedAt: number;
}

/** A search-result row (ADR-0072, issue #252). Since ADR-0089 every session is
 *  persisted, so SearchEntry is structurally identical to SidebarEntry — the
 *  type alias stays for intent documentation and future divergence. */
export type SearchEntry = SidebarEntry;

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
  | { kind: "date"; readonly date: Date };

/** Classify an mtime for sub-line display (ADR-0072, issue #251). See
 *  {@link LastModifiedLabel}. */
export function formatLastModified(lastModifiedAt: number, now: number): LastModifiedLabel {
  const today = startOfCalendarDay(now);
  const entry = startOfCalendarDay(lastModifiedAt);
  if (entry >= today) return { kind: "today" };
  if (entry >= today - MS_PER_DAY) return { kind: "yesterday" };
  return { kind: "date", date: new Date(lastModifiedAt) };
}

/** Index open sessions by their bound .duck path so a persisted row can look up
 *  its runtime binding in one read. Every session has a path since ADR-0089.
 *  Shared by buildSearchEntries + buildSidebarGroups. */
function indexOpenByPath(open: OpenSession[]): Map<string, OpenSession> {
  const byPath = new Map<string, OpenSession>();
  for (const o of open) {
    byPath.set(o.path, o);
  }
  return byPath;
}

/** Compose a persisted row's entry from its recipe metadata + (optional) open
 *  binding. An open binding upgrades the row with its runtime sid + the
 *  (possibly renamed) in-memory name; both constructors emit the same
 *  persisted-row shape. Returns SearchEntry (path non-null) since
 *  m.duck_path is always a string. */
function persistedEntry(
  m: SessionMetadata,
  bound: OpenSession | null,
  activeSessionId: string | null,
): SearchEntry {
  return {
    key: m.duck_path,
    name: bound?.name ?? m.display_name,
    sid: bound?.sid ?? null,
    path: m.duck_path,
    active: bound !== null && bound.sid === activeSessionId,
    firstSourceName: m.source_summary.first_source_name,
    sourceCount: m.source_summary.source_count,
    turnCount: m.source_summary.turn_count,
    lastModifiedAt: m.last_modified_at,
  };
}

/** Sort comparator: last-modified descending, name ascending as a deterministic
 *  tiebreaker. Shared by both constructors so the ordering contract is in one
 *  place. */
const BY_MTIME_DESC = (a: SidebarEntry, b: SidebarEntry): number =>
  b.lastModifiedAt - a.lastModifiedAt || a.name.localeCompare(b.name);

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
  const openByPath = indexOpenByPath(open);
  const q = query.trim().toLowerCase();
  const entries: SearchEntry[] = [];
  for (const m of persisted) {
    // Compose a single haystack so the substring test runs once per row; the
    // space keeps a name that ends with the source's prefix from bridging into
    // a false positive at the boundary.
    const hay = `${m.display_name} ${m.source_summary.first_source_name ?? ""}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    entries.push(persistedEntry(m, openByPath.get(m.duck_path) ?? null, activeSessionId));
  }
  entries.sort(BY_MTIME_DESC);
  return entries;
}

/** Build the merged, grouped, last-modified-descending sidebar model. Pure in
 *  (persisted, open, activeSessionId, now, grouping) -- the component supplies
 *  the raw list_sessions result + the open set + the user's grouping choice;
 *  this function does the rest. Since ADR-0089 every session is persisted from
 *  creation, so the persisted list and the open set share the same path keys --
 *  there is no separate "unsaved open" entry set.
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
  const openByPath = indexOpenByPath(open);
  const persistedPaths = new Set(persisted.map((m) => m.duck_path));

  const entries: SidebarEntry[] = [];

  // Persisted rows (resume-on-click targets). An open binding upgrades the row
  // with its runtime sid + the (possibly renamed) in-memory name.
  for (const m of persisted) {
    entries.push(persistedEntry(m, openByPath.get(m.duck_path) ?? null, activeSessionId));
  }

  // Open sessions not yet in the persisted list: a just-created session (or one
  // whose list_sessions refetch hasn't landed yet) carries a real path but is
  // absent from the persisted scan. Render it as its own entry until the
  // persisted list catches up (ADR-0089: every session is persisted, but the
  // sidebar query is async).
  for (const o of open) {
    if (persistedPaths.has(o.path)) continue;
    entries.push({
      key: o.path,
      name: o.name,
      sid: o.sid,
      path: o.path,
      active: o.sid === activeSessionId,
      firstSourceName: null,
      sourceCount: 0,
      turnCount: 0,
      lastModifiedAt: now,
    });
  }

  // No entries -> no groups (ADR-0072: an empty sidebar renders no group title,
  // so the grouping toggle's hover affordance is hidden too).
  if (entries.length === 0) return [];

  entries.sort(BY_MTIME_DESC);

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
