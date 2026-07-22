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

import type { SessionMetadata } from "../types";

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

/** A sidebar time-group (ADR-0060 Chat-style: Today / Yesterday / Previous 7 days / Older). */
export type SidebarGroupKind = "today" | "yesterday" | "last7" | "older";

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

/** A rendered time group: heading kind + its entries (already sorted). */
export interface SidebarGroup {
  kind: SidebarGroupKind;
  entries: SidebarEntry[];
}

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
export function timeGroupKind(lastModifiedAt: number, now: number): SidebarGroupKind {
  const today = startOfCalendarDay(now);
  const entry = startOfCalendarDay(lastModifiedAt);
  if (entry >= today) return "today";
  if (entry >= today - MS_PER_DAY) return "yesterday";
  if (entry >= today - 7 * MS_PER_DAY) return "last7";
  return "older";
}

/** Build the merged, time-grouped, last-modified-descending sidebar model. Pure
 *  in (persisted, open, activeSessionId, now) -- the component supplies the raw
 *  list_sessions result + the open set, this function does the rest. A persisted
 *  session that is also open merges into one entry (open = true, sid set); an
 *  open never-saved session becomes its own entry; every entry carries the
 *  display fields the row renders. */
export function buildSidebarGroups(
  persisted: SessionMetadata[],
  open: OpenSession[],
  activeSessionId: string | null,
  now: number,
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

  // Sort last-modified descending, then group. Ties (same mtime) fall back to
  // name so the render is deterministic across renders.
  entries.sort(
    (a, b) => b.lastModifiedAt - a.lastModifiedAt || a.name.localeCompare(b.name),
  );

  const groups: SidebarGroup[] = [];
  for (const kind of ["today", "yesterday", "last7", "older"] as const) {
    const groupEntries = entries.filter(
      (e) => timeGroupKind(e.lastModifiedAt, now) === kind,
    );
    if (groupEntries.length > 0) {
      groups.push({ kind, entries: groupEntries });
    }
  }
  return groups;
}
