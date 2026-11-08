// Pure sidebar model (ADR-0060/0061/0089, issue #81): merges the persisted-
// session list (list_sessions) with the open in-memory sessions and sorts
// last-modified descending (#1401 retired the ADR-0060 Chat-style time
// grouping -- the body is always the single "Recent" section). Kept out of the
// component so the merge + ordering is unit-testable without React,
// and so the sidebar component stays a thin caller of these functions.
//
// Identity split (ADR-0060/0061/0089): a PERSISTED session's stable identity is
// its `recipe.json` file path (SessionMetadata.recipe_path); an OPEN session's runtime
// identity is its ephemeral UUID (createSession). Since ADR-0089 every session
// is persisted from creation, so every OpenSession carries a non-null path —
// the "unsaved" state no longer exists.

import type { RecentWorkspace } from "../api";
import type { SessionMetadata } from "../types/session";
import { searchMatcher } from "../lib/searchMatcher";

/** A runtime-open session tracked by the shell (ADR-0060/0051 keep-alive).
 *  Since ADR-0089 every session is persisted from creation, so `path` is always
 *  non-null. */
export interface OpenSession {
  /** Runtime UUID from createSession (ephemeral; not persisted). */
  sid: string;
  /** Display name. Starts empty (placeholder); updated by rename or the first
   *  turn's auto-naming. */
  name: string;
  /** Bound `recipe.json` path (SessionMetadata.recipe_path shape). Always non-null
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
  /** The skill names staged on the shell-level cold-start bar (ADR-0112
   *  trigger-then-stage, calibrated by ADR-0119: the picks are the minted
   *  session's FIRST turn's user invocations -- submit-time materialization,
   *  no per-session state). Carried next to pendingQuestion; SessionPane
   *  consumes both in the same first ask, then clears them through
   *  onQuestionConsumed. Empty for sessions opened by any other action. */
  pendingSkillInvocations: string[];
}

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
  /** Bound `recipe.json` path. Always non-null since ADR-0089. */
  path: string;
  /** Whether this entry is the currently active session. */
  active: boolean;
  /** Shell-layer pinned flag (ADR-0127): the row floats to the pinned
   *  section. False for open-not-yet-persisted and archived rows. */
  pinned: boolean;
  /** First source display name for the hover card (null = no sources yet). */
  firstSourceName: string | null;
  /** Total loaded source count (ADR-0093, issue #513: hover-card metadata). */
  sourceCount: number;
  /** Productive turn count, surfaced in the sidebar row's HoverCard. */
  turnCount: number;
  /** last_modified_at, ms since epoch. A never-saved session has no mtime, so
   *  the caller stamps it at creation to land at the top of the Recent list. */
  lastModifiedAt: number;
}

/** A search-result row (ADR-0072, issue #252). Since ADR-0089 every session is
 *  persisted, so SearchEntry is structurally identical to SidebarEntry — the
 *  type alias stays for intent documentation and future divergence. */
export type SearchEntry = SidebarEntry;

/** The two-partition search result (issue #1403): `main` carries the
 *  unarchived matches, `archived` the archived matches — the dialog renders
 *  `archived` as a bottom, grayed-out section under its own header. Both
 *  partitions share the match predicate, the mtime-desc sort, and the cap;
 *  the archived rows are metadata-only (open-is-unarchive, ADR-0127 Decision
 *  4, means an archived row never carries a runtime sid). */
export interface SearchPartition {
  main: SearchEntry[];
  archived: SearchEntry[];
}

const MS_PER_DAY = 86_400_000;

/** The jump dialog's result cap: the viewport holds roughly this many
 *  single-line rows, so the list truncates to the freshest matches instead of
 *  growing unbounded. */
export const MAX_SEARCH_RESULTS = 9;

/** The section preview cap (issue #1392, the WorkBuddy precedent): the recent
 *  body and a workspace subtree show their freshest 5 rows by default; a
 *  "Show more (N)" tail expands the rest. */
export const SIDEBAR_PREVIEW_CAP = 5;

function startOfCalendarDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A dynamic-format classification of an mtime for the search row's time
 *  label (ADR-0072 search slice). Pure in (lastModifiedAt, now): returns
 *  `today` / `yesterday` for the past two local calendar days (the caller
 *  localizes via intl), else a `date` arm carrying the Date so the caller can
 *  format with Intl.DateTimeFormat -- year-included when the mtime predates the
 *  current year, month/day otherwise. Day boundaries are local calendar days
 *  (midnight rollover), matching `startOfCalendarDay`. */
export type LastModifiedLabel =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; readonly date: Date };

/** Classify an mtime for the search row's time label (ADR-0072, issue #251). See
 *  {@link LastModifiedLabel}. */
export function formatLastModified(lastModifiedAt: number, now: number): LastModifiedLabel {
  const today = startOfCalendarDay(now);
  const entry = startOfCalendarDay(lastModifiedAt);
  if (entry >= today) return { kind: "today" };
  if (entry >= today - MS_PER_DAY) return { kind: "yesterday" };
  return { kind: "date", date: new Date(lastModifiedAt) };
}

/** Index open sessions by their bound recipe.json path so a persisted row can look up
 *  its runtime binding in one read. Every session has a path since ADR-0089.
 *  Shared by buildSearchEntries + buildSidebarModel. */
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
 *  m.recipe_path is always a string. */
function persistedEntry(
  m: SessionMetadata,
  bound: OpenSession | null,
  activeSessionId: string | null,
): SearchEntry {
  return {
    key: m.recipe_path,
    name: bound?.name ?? m.display_name,
    sid: bound?.sid ?? null,
    path: m.recipe_path,
    active: bound !== null && bound.sid === activeSessionId,
    pinned: m.pinned,
    firstSourceName: m.source_summary.first_source_name,
    sourceCount: m.source_summary.source_count,
    turnCount: m.source_summary.turn_count,
    lastModifiedAt: m.last_modified_at,
  };
}

/** Build the archived section's rows (ADR-0127 Decision 7, issue #1175).
 *  Metadata-only: open-is-unarchive (Decision 4) means an archived row never
 *  carries a runtime sid, so the open-set merge is statically null and the
 *  row is never active. Server order (the includeArchived response's mtime
 *  desc tail) is preserved verbatim. */
export function buildArchivedEntries(archived: SessionMetadata[]): SidebarEntry[] {
  return archived.map((m) => persistedEntry(m, null, null));
}

/** Sort comparator: last-modified descending, name ascending as a deterministic
 *  tiebreaker. Shared by both constructors so the ordering contract is in one
 *  place. */
const BY_MTIME_DESC = (a: SidebarEntry, b: SidebarEntry): number =>
  b.lastModifiedAt - a.lastModifiedAt || a.name.localeCompare(b.name);

/** Build one search partition: filter + sort + cap over one metadata list.
 *  Shared verbatim by both partitions (issue #1403) so the match predicate,
 *  the mtime-desc order, and the cap cannot drift between the unarchived and
 *  the archived side. `openByPath` is null for the archived partition — an
 *  archived row never carries a runtime sid (ADR-0127 Decision 4), so the
 *  open-set merge is statically null there. */
function searchPartition(
  list: SessionMetadata[],
  openByPath: Map<string, OpenSession> | null,
  activeSessionId: string | null,
  matches: (hay: string) => boolean,
): SearchEntry[] {
  const entries: SearchEntry[] = [];
  for (const m of list) {
    // Compose a single haystack so the substring test runs once per row; the
    // space keeps a name that ends with the source's prefix from bridging into
    // a false positive at the boundary.
    const hay = `${m.display_name} ${m.source_summary.first_source_name ?? ""}`;
    if (!matches(hay)) continue;
    entries.push(persistedEntry(m, openByPath?.get(m.recipe_path) ?? null, activeSessionId));
  }
  entries.sort(BY_MTIME_DESC);
  return entries.slice(0, MAX_SEARCH_RESULTS);
}

/** Build the two-partition search result for the Ctrl/⌘+K search modal
 *  (ADR-0072, issue #252; archived partition issue #1403). Pure in (persisted,
 *  archived, open, activeSessionId, query): the caller supplies the raw
 *  `list_sessions` partition (unarchived + archived — the includeArchived
 *  scan, partitioned client-side by `usePersistedSessions`) + the open set +
 *  the active id + the query string; this function does the rest. Kept
 *  alongside `buildSidebarModel` because the per-row shape + the
 *  persisted/open merge contract are shared with the sidebar (a row that is
 *  open in this shell carries its runtime sid, so the modal can
 *  activate-by-sid instead of re-resuming).
 *
 *  Scope (ADR-0072): only PERSISTED sessions are searchable -- the
 *  `list_sessions` result. An unsaved new session (no recipe.json) is NOT in
 *  list_sessions and never appears here, even when it is the active session
 *  (the sidebar still lists it; the modal is a persisted-session jump surface).
 *  Every emitted row therefore has a non-null path.
 *
 *  Partitions (#1403): the unarchived matches land in `main`, the archived
 *  matches in `archived` — the dialog renders the latter as a bottom grayed
 *  section. Both sides run the same filter: case-insensitive substring over
 *  `display_name` + the first source's name (via searchMatcher). An empty /
 *  whitespace-only query matches everything IN `main`, but the archived
 *  partition stays EMPTY on it — the empty-query face is the browse/jump
 *  surface over recent activity, and archived rows enter only once the user
 *  is actually searching (a non-empty query), the recall face. Each
 *  partition is truncated INDEPENDENTLY to the newest MAX_SEARCH_RESULTS
 *  (the bottom section can neither crowd the main window out nor borrow its
 *  budget) and sorted mtime desc with a name tiebreaker for deterministic
 *  rendering.
 *
 *  Unlike `buildSidebarModel`, no `now` parameter: the modal is a single flat
 *  list (no time buckets) and each row's dynamic time label is resolved in
 *  the component via `formatLastModified` (a React-layer concern -- it needs
 *  the localized heading text). */
export function buildSearchEntries(
  persisted: SessionMetadata[],
  archived: SessionMetadata[],
  open: OpenSession[],
  activeSessionId: string | null,
  query: string,
): SearchPartition {
  const openByPath = indexOpenByPath(open);
  const matches = searchMatcher(query);
  // The archived partition enters only on a non-empty query (issue #1403,
  // browse-vs-recall ruling): the empty-query face lists recent unarchived
  // activity only, so a bare Ctrl/⌘+K never surfaces the grayed section.
  const archivedMatches =
    query.trim() === "" ? [] : searchPartition(archived, null, activeSessionId, matches);
  return {
    main: searchPartition(persisted, openByPath, activeSessionId, matches),
    archived: archivedMatches,
  };
}

/** The sidebar's renderable model (ADR-0127, issue #1175; #1401 retired the
 *  ADR-0072 flat/time modes -- the body is always the single mtime-descending
 *  "Recent" section). `pinned` holds the pinned rows in SERVER order (the
 *  includeArchived-less response's pinned block = sidecar array position, the
 *  MRU order -- NOT mtime), preserved verbatim; `recent` is the unpinned
 *  remainder. Either collection may be empty; an empty collection renders no
 *  section. */
export interface SidebarModel {
  pinned: SidebarEntry[];
  recent: SidebarEntry[];
}

/** Build the merged, last-modified-descending sidebar model. Pure in
 *  (persisted, open, activeSessionId, now) -- the component supplies the raw
 *  list_sessions result + the open set; this function does the rest. Since
 *  ADR-0089 every session is persisted from creation, so the persisted list
 *  and the open set share the same path keys -- there is no separate "unsaved
 *  open" entry set. */
export function buildSidebarModel(
  persisted: SessionMetadata[],
  open: OpenSession[],
  activeSessionId: string | null,
  now: number,
): SidebarModel {
  const openByPath = indexOpenByPath(open);
  const persistedPaths = new Set(persisted.map((m) => m.recipe_path));

  const entries: SidebarEntry[] = [];

  // Persisted rows (resume-on-click targets). An open binding upgrades the row
  // with its runtime sid + the (possibly renamed) in-memory name.
  for (const m of persisted) {
    entries.push(persistedEntry(m, openByPath.get(m.recipe_path) ?? null, activeSessionId));
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
      pinned: false,
      firstSourceName: null,
      sourceCount: 0,
      turnCount: 0,
      lastModifiedAt: now,
    });
  }

  // No entries -> no model (recalibrated by ADR-0127: the sidebar still
  // renders the chrome row on a bare title row, so the archived toggle stays
  // reachable on an empty sidebar).
  if (entries.length === 0) return { pinned: [], recent: [] };

  // Pinned rows leave the recent body BEFORE the mtime sort: their display
  // order is the server's pinned-block order (sidecar array position, the MRU
  // order, ADR-0127 Decision 5), which BY_MTIME_DESC would destroy.
  const pinned = entries.filter((e) => e.pinned);
  const rest = entries.filter((e) => !e.pinned);
  if (rest.length === 0) return { pinned, recent: [] };

  rest.sort(BY_MTIME_DESC);

  // The single "Recent" section, already sorted by mtime desc (#1401: the
  // ADR-0060 Chat-style time buckets are retired).
  return { pinned, recent: rest };
}

/** One workspace-section group (issue #1392): an explicit registry record
 *  plus the session rows bound to its directory. */
export interface WorkspaceGroup {
  /** The bound canonical directory path (the registry key). */
  path: string;
  /** The registry display face (the title, else the directory tail). */
  label: string;
  /** The directory is missing on disk; the group stays with a hint. */
  missing: boolean;
  /** The bound session rows -- the same row shape the recent body renders,
   *  freshest first. */
  entries: SidebarEntry[];
}

/** Build the workspace section's groups (issue #1392): the registry's
 *  `explicit` records in server (LRU) order, each carrying the persisted
 *  sessions whose header binds its directory -- membership derives from the
 *  session header's `workspace` field; the registry carries no session
 *  ledger. An explicit record with zero sessions still lists (the "New
 *  workspace" flow creates the group before any session binds it). Rows
 *  not bound to an explicit record stay the recent body's business. */
export function buildWorkspaceGroups(
  workspaces: RecentWorkspace[],
  persisted: SessionMetadata[],
  open: OpenSession[],
  activeSessionId: string | null,
): WorkspaceGroup[] {
  const explicit = workspaces.filter((w) => w.explicit);
  if (explicit.length === 0) return [];
  const openByPath = indexOpenByPath(open);
  const members = new Map<string, SidebarEntry[]>(explicit.map((w) => [w.path, []]));
  for (const m of persisted) {
    const bucket = m.workspace === null ? undefined : members.get(m.workspace);
    if (bucket === undefined) continue;
    bucket.push(persistedEntry(m, openByPath.get(m.recipe_path) ?? null, activeSessionId));
  }
  return explicit.map((w) => {
    const entries = members.get(w.path) ?? [];
    entries.sort(BY_MTIME_DESC);
    return { path: w.path, label: w.label, missing: !w.exists, entries };
  });
}
