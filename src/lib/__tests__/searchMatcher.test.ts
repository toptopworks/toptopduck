import { describe, expect, it } from "vitest";

import {
  findQueryMatches,
  normalizeSearchQuery,
  searchMatcher,
} from "../searchMatcher";

// The shared search-match core (issue #978): one trimmed, case-insensitive
// substring matcher behind the settings search boxes, the composer skill
// picker, and the sidebar's jump-to-session search, so the surfaces cannot
// drift apart (ADR-0112 Decision 5). The picker-side agreement is pinned in
// skillPickerLogic.test.ts, the sidebar-side in sidebarModel.test.ts.

describe("searchMatcher", () => {
  it("matches everything for an empty query", () => {
    expect(searchMatcher("")("Draw charts")).toBe(true);
  });

  it("matches everything for a whitespace-only query", () => {
    expect(searchMatcher("   ")("Draw charts")).toBe(true);
  });

  it("trims the query before matching", () => {
    expect(searchMatcher("  chart  ")("Draw charts")).toBe(true);
  });

  it("matches case-insensitively in both directions", () => {
    expect(searchMatcher("CHART")("Draw charts")).toBe(true);
    expect(searchMatcher("DRAW")("draw charts")).toBe(true);
  });

  it("matches partial text (substring semantics)", () => {
    expect(searchMatcher("art")("Draw charts")).toBe(true);
  });

  it("returns false on a miss", () => {
    expect(searchMatcher("zzz")("Draw charts")).toBe(false);
  });
});

// The position face of the core (issue #978): the picker's hit highlighting
// rides the same needle and the same haystack-side case folding as the
// boolean matcher, so a future core change lands for matching and
// highlighting together.

describe("normalizeSearchQuery", () => {
  it("returns null for an empty query", () => {
    expect(normalizeSearchQuery("")).toBeNull();
  });

  it("returns null for a whitespace-only query", () => {
    expect(normalizeSearchQuery("   ")).toBeNull();
  });

  it("trims and lower-cases the raw query", () => {
    expect(normalizeSearchQuery("  CHART  ")).toBe("chart");
  });
});

describe("findQueryMatches", () => {
  it("finds every occurrence in order", () => {
    expect(findQueryMatches("Draw charts", "a")).toEqual([2, 7]);
  });

  it("returns an empty array on a miss", () => {
    expect(findQueryMatches("Draw charts", "zzz")).toEqual([]);
  });

  it("returns no hits for a null needle (the match-all query)", () => {
    expect(findQueryMatches("Draw charts", null)).toEqual([]);
  });

  it("returns no hits for an empty needle rather than hanging", () => {
    expect(findQueryMatches("Draw charts", "")).toEqual([]);
  });

  it("advances past the whole hit, so overlapping occurrences do not double-render", () => {
    expect(findQueryMatches("aaa", "aa")).toEqual([0]);
  });

  it("degrades to no hits when lower-casing changes the haystack's length", () => {
    // U+0130 (the Turkish dotted capital I) lower-cases to two code units,
    // shifting every hit index after the fold point -- those indices would
    // point into the wrong characters, so the hit face yields none.
    expect(findQueryMatches("İ charts", "charts")).toEqual([]);
    // The boolean face is unaffected: the match itself is still found.
    expect(searchMatcher("charts")("İ charts")).toBe(true);
  });
});
