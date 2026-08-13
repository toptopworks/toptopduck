import { describe, expect, it } from "vitest";
import {
  buildSearchEntries,
  buildSidebarGroups,
  formatLastModified,
  timeGroupKind,
  type OpenSession,
} from "../sidebarModel";
import type { SessionMetadata } from "../../types/session";

// Pure sidebar-model tests (ADR-0060/0061, issue #81): the merge + Chat-style
// time grouping + last-modified-descending order, with a fixed `now` so the
// calendar-day buckets are deterministic. No React.

const NOW = new Date("2026-07-10T12:00:00").getTime();
const MS_PER_DAY = 86_400_000;

function meta(
  path: string,
  name: string,
  ageDays: number,
  opts: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    duck_path: path,
    display_name: name,
    last_modified_at: NOW - ageDays * MS_PER_DAY,
    source_summary: {
      first_source_name: opts.source_summary?.first_source_name ?? `${name}_src`,
      source_count: opts.source_summary?.source_count ?? 1,
      turn_count: opts.source_summary?.turn_count ?? 1,
    },
    format_version: opts.format_version ?? 2,
  };
}

describe("timeGroupKind", () => {
  it("buckets by local calendar day, not a rolling 24h window", () => {
    // 11:59pm "today" and 12:01am "today" are both Today; just-before-midnight
    // yesterday is Yesterday.
    expect(timeGroupKind(NOW, NOW)).toBe("today");
    expect(timeGroupKind(NOW - 2 * 3600_000, NOW)).toBe("today");
    expect(timeGroupKind(NOW - 26 * 3600_000, NOW)).toBe("yesterday");
    expect(timeGroupKind(NOW - 3 * MS_PER_DAY, NOW)).toBe("last7");
    expect(timeGroupKind(NOW - 30 * MS_PER_DAY, NOW)).toBe("older");
  });
});

describe("buildSidebarGroups", () => {
  it("groups persisted sessions Chat-style and sorts last-modified descending", () => {
    const today = meta("/a.duck", "alpha", 0);
    const yesterday = meta("/b.duck", "beta", 1);
    const last7 = meta("/c.duck", "gamma", 5);
    const older = meta("/d.duck", "delta", 30);

    const groups = buildSidebarGroups([today, yesterday, last7, older], [], null, NOW, "time");

    expect(groups.map((g) => g.kind)).toEqual(["today", "yesterday", "last7", "older"]);
    // Within a group the freshest is first; cross-group order is the bucket order.
    expect(groups[0].entries[0].name).toBe("alpha");
    expect(groups[1].entries[0].name).toBe("beta");
    expect(groups[3].entries[0].name).toBe("delta");
  });

  it("merges an open binding into its persisted row (sid set) and marks active", () => {
    const persisted = [meta("/a.duck", "alpha", 0)];
    const open: OpenSession[] = [
      { sid: "uuid-a", name: "alpha", path: "/a.duck", pendingIngestPaths: [], pendingQuestion: null },
    ];

    const groups = buildSidebarGroups(persisted, open, "uuid-a", NOW, "time");

    const entry = groups[0].entries[0];
    expect(entry.sid).toBe("uuid-a");
    expect(entry.active).toBe(true);
    expect(entry.path).toBe("/a.duck");
  });

  it("renders an open session not yet in the persisted list as its own row under Today (ADR-0089)", () => {
    // A just-created session (ADR-0089) carries a real path but may not yet be
    // in the list_sessions result (async refetch). It becomes a standalone
    // entry stamped to `now` until the persisted list catches up.
    const open: OpenSession[] = [
      { sid: "uuid-new", name: "", path: "/sessions/uuid-new/session.duck", pendingIngestPaths: [], pendingQuestion: null },
    ];

    const groups = buildSidebarGroups([], open, "uuid-new", NOW, "time");

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("today");
    const entry = groups[0].entries[0];
    expect(entry.sid).toBe("uuid-new");
    expect(entry.path).toBe("/sessions/uuid-new/session.duck");
    expect(entry.active).toBe(true);
    expect(entry.firstSourceName).toBeNull();
    expect(entry.turnCount).toBe(0);
  });

  it("marks only the active open row, leaving closed persisted rows inactive", () => {
    const persisted = [
      meta("/a.duck", "alpha", 0),
      meta("/b.duck", "beta", 0),
    ];
    const open: OpenSession[] = [
      { sid: "uuid-b", name: "beta", path: "/b.duck", pendingIngestPaths: [], pendingQuestion: null },
    ];

    const groups = buildSidebarGroups(persisted, open, "uuid-b", NOW, "time");
    const active = groups[0].entries.find((e) => e.active);
    expect(active?.name).toBe("beta");
    // alpha is closed (sid null), not active.
    const alpha = groups[0].entries.find((e) => e.name === "alpha");
    expect(alpha?.sid).toBeNull();
    expect(alpha?.active).toBe(false);
  });

  // --- ADR-0072 (issue #251): flat mode -------------------------------------

  it("flat mode collapses every entry into a single Recent group, mtime-desc", () => {
    // The same input as the time-mode "groups Chat-style" test, but flat
    // yields ONE group whose kind is "recent" and whose entries preserve the
    // sorted-desc order across what would otherwise be the time buckets.
    const today = meta("/a.duck", "alpha", 0);
    const yesterday = meta("/b.duck", "beta", 1);
    const last7 = meta("/c.duck", "gamma", 5);
    const older = meta("/d.duck", "delta", 30);

    const groups = buildSidebarGroups(
      [today, yesterday, last7, older],
      [],
      null,
      NOW,
      "flat",
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("recent");
    expect(groups[0].entries.map((e) => e.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
  });

  it("flat mode still flags the active open row and merges the open binding", () => {
    // Flat mode is purely a presentation toggle over the same merge + sort: the
    // active/open semantics are identical to time mode.
    const persisted = [meta("/a.duck", "alpha", 0), meta("/b.duck", "beta", 5)];
    const open: OpenSession[] = [
      { sid: "uuid-b", name: "beta", path: "/b.duck", pendingIngestPaths: [], pendingQuestion: null },
    ];

    const groups = buildSidebarGroups(persisted, open, "uuid-b", NOW, "flat");

    expect(groups).toHaveLength(1);
    const active = groups[0].entries.find((e) => e.active);
    expect(active?.name).toBe("beta");
    expect(active?.sid).toBe("uuid-b");
  });

  it("flat and time modes both render zero groups for an empty sidebar", () => {
    // ADR-0072: an empty sidebar renders no group title -- so the grouping
    // toggle's hover affordance has no anchor (the empty-state row renders
    // instead). Both modes return [] here.
    expect(buildSidebarGroups([], [], null, NOW, "flat")).toEqual([]);
    expect(buildSidebarGroups([], [], null, NOW, "time")).toEqual([]);
  });

  it("flat/time groups carry their mode discriminant (SidebarGroup invariant pin)", () => {
    // SidebarGroup is a discriminated union on `mode`; this pins the runtime
    // side so a future constructor drift (e.g. flat branch returning a time
    // kind) fails here too, not just at the type level.
    const flatGroups = buildSidebarGroups([meta("/a.duck", "a", 0)], [], null, NOW, "flat");
    expect(flatGroups[0].mode).toBe("flat");
    expect(flatGroups[0].kind).toBe("recent");

    const timeGroups = buildSidebarGroups([meta("/a.duck", "a", 0)], [], null, NOW, "time");
    expect(timeGroups[0].mode).toBe("time");
    expect(timeGroups[0].kind).toBe("today");
  });
});

describe("formatLastModified (ADR-0072, issue #251)", () => {
  it("classifies today / yesterday by local calendar day, else returns the date", () => {
    // Same calendar-day bucketing as timeGroupKind for the past two days; older
    // timestamps fall through to the date arm carrying the Date for the caller
    // to format with Intl.DateTimeFormat.
    expect(formatLastModified(NOW, NOW)).toEqual({ kind: "today" });
    expect(formatLastModified(NOW - 2 * 3600_000, NOW)).toEqual({ kind: "today" });
    expect(formatLastModified(NOW - 26 * 3600_000, NOW)).toEqual({ kind: "yesterday" });

    const older = formatLastModified(NOW - 3 * MS_PER_DAY, NOW);
    expect(older.kind).toBe("date");
    if (older.kind === "date") {
      expect(older.date.getTime()).toBe(NOW - 3 * MS_PER_DAY);
    }
  });

  it("uses local-midnight boundaries, not a rolling 24h window", () => {
    // 11:59pm "today" and 12:01am "today" are both today; just-before-midnight
    // yesterday is yesterday. The bucket matches timeGroupKind so the sub-line
    // and the (optional) time-mode group heading agree on the day boundary.
    const lateToday = new Date("2026-07-10T23:59:00").getTime();
    expect(formatLastModified(lateToday, NOW)).toEqual({ kind: "today" });
    const earlyYesterday = new Date("2026-07-09T00:01:00").getTime();
    const yLabel = formatLastModified(earlyYesterday, NOW);
    expect(yLabel.kind).toBe("yesterday");
  });
});

describe("buildSearchEntries (ADR-0072, issue #252)", () => {
  // Two persisted sessions: alpha (today, src "alpha_src") and beta (3 days old,
  // src "beta_src").NOW = 2026-07-10; beta's mtime = 2026-07-07.
  function twoPersisted(): SessionMetadata[] {
    return [
      meta("/a.duck", "alpha", 0, { source_summary: { first_source_name: "alpha_src", source_count: 1, turn_count: 4 } }),
      meta("/b.duck", "beta", 3, { source_summary: { first_source_name: "beta_src", source_count: 2, turn_count: 12 } }),
    ];
  }

  it("returns every persisted session (mtime desc) when the query is empty", () => {
    // ⌘K is also a browse/jump entry point: an empty query lists everything,
    // freshest first.
    const entries = buildSearchEntries(twoPersisted(), [], null, "");
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  });

  it("treats a whitespace-only query as empty", () => {
    // The query is trimmed before matching, so "   " behaves like "".
    const entries = buildSearchEntries(twoPersisted(), [], null, "   ");
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  });

  it("matches display_name as a case-insensitive substring", () => {
    // "ALP" hits alpha only; beta is dropped.
    const entries = buildSearchEntries(twoPersisted(), [], null, "ALP");
    expect(entries.map((e) => e.name)).toEqual(["alpha"]);
  });

  it("matches first_source_name as a case-insensitive substring", () => {
    // The first source's name is in scope: "BETA_SRC" hits beta only.
    const entries = buildSearchEntries(twoPersisted(), [], null, "BETA_SRC");
    expect(entries.map((e) => e.name)).toEqual(["beta"]);
  });

  it("drops entries that match neither display_name nor first_source_name", () => {
    expect(buildSearchEntries(twoPersisted(), [], null, "gamma")).toEqual([]);
  });

  it("merges an open binding into the persisted row (sid set) and flags active", () => {
    // The search list mirrors the sidebar's merge contract: a persisted row
    // that is open in this shell carries its runtime sid (so the modal can
    // activate-by-sid instead of re-resuming) and reflects the in-memory name
    // (a rename mid-flight lands without waiting for list_sessions to refresh).
    const open: OpenSession[] = [
      { sid: "uuid-b", name: "beta renamed", path: "/b.duck", pendingIngestPaths: [], pendingQuestion: null },
    ];
    const entries = buildSearchEntries(twoPersisted(), open, "uuid-b", "");
    const beta = entries.find((e) => e.path === "/b.duck");
    expect(beta?.sid).toBe("uuid-b");
    expect(beta?.name).toBe("beta renamed");
    expect(beta?.active).toBe(true);
    // alpha stays a cold row (sid null, not active).
    const alpha = entries.find((e) => e.path === "/a.duck");
    expect(alpha?.sid).toBeNull();
    expect(alpha?.active).toBe(false);
  });

  it("excludes never-saved open sessions (search scope = list_sessions only)", () => {
    // ADR-0072: the ⌘K modal filters the list_sessions result -- an
    // unsaved new session (no .duck) is not in list_sessions, so it never
    // appears here even when it is the active session. The sidebar still lists
    // it; the modal is a persisted-session jump surface.
    const open: OpenSession[] = [
      { sid: "uuid-new", name: "unsaved", path: "/sessions/uuid-new/session.duck", pendingIngestPaths: [], pendingQuestion: null },
    ];
    const entries = buildSearchEntries(twoPersisted(), open, "uuid-new", "");
    expect(entries.map((e) => e.name)).toEqual(["alpha", "beta"]);
  });

  it("sorts mtime desc with a name tiebreaker for deterministic render", () => {
    // Same mtime -> alphabetical; matches buildSidebarGroups' tiebreaker.
    const sameMtime: SessionMetadata[] = [
      { ...meta("/z.duck", "zulu", 1), last_modified_at: 1000 },
      { ...meta("/m.duck", "mike", 1), last_modified_at: 1000 },
      { ...meta("/a.duck", "alpha", 1), last_modified_at: 1000 },
    ];
    const entries = buildSearchEntries(sameMtime, [], null, "");
    expect(entries.map((e) => e.name)).toEqual(["alpha", "mike", "zulu"]);
  });
});
