import { describe, expect, it } from "vitest";

import {
  findQueryMatches,
  normalizeSearchQuery,
  searchMatcher,
} from "../searchMatcher";

// The shared search-match core (issue #978): one trimmed, case-insensitive
// substring matcher behind the settings search boxes and the composer skill
// picker, so the two surfaces cannot drift apart (ADR-0112 Decision 5).
// The two-surface agreement itself is pinned on the picker side, in
// skillPickerLogic.test.ts.

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
});
