import { describe, expect, it } from "vitest";

import {
  FILTER_OPTIONS,
  matchesFilter,
  matchesSearch,
} from "../settings-filters";

// The shared settings-list filter predicates (issue #976): EnabledFilter /
// FILTER_OPTIONS / matchesFilter used verbatim by the MCP and agents panes,
// and the matchesSearch core shared by those plus the skills pane. These
// tests pin the behavioral contract the three panes converged FROM, so the
// convergence cannot drift it.

describe("matchesSearch", () => {
  it("returns true for an empty query", () => {
    expect(matchesSearch("postgres mcp", "")).toBe(true);
  });

  it("returns true for a whitespace-only query", () => {
    expect(matchesSearch("postgres mcp", "   ")).toBe(true);
  });

  it("matches case-insensitively in both directions", () => {
    expect(matchesSearch("Postgres MCP", "postgres")).toBe(true);
    expect(matchesSearch("postgres mcp", "MCP")).toBe(true);
  });

  it("trims the query before matching", () => {
    expect(matchesSearch("postgres mcp", "  postgres  ")).toBe(true);
  });

  it("returns false when the haystack does not contain the query", () => {
    expect(matchesSearch("postgres mcp", "mysql")).toBe(false);
  });
});

describe("matchesFilter", () => {
  const enabledEntry = { enabled: true };
  const disabledEntry = { enabled: false };

  it("matches every entry under the all filter", () => {
    expect(matchesFilter(enabledEntry, "all")).toBe(true);
    expect(matchesFilter(disabledEntry, "all")).toBe(true);
  });

  it("matches only enabled entries under the enabled filter", () => {
    expect(matchesFilter(enabledEntry, "enabled")).toBe(true);
    expect(matchesFilter(disabledEntry, "enabled")).toBe(false);
  });

  it("matches only disabled entries under the disabled filter", () => {
    expect(matchesFilter(enabledEntry, "disabled")).toBe(false);
    expect(matchesFilter(disabledEntry, "disabled")).toBe(true);
  });
});

describe("FILTER_OPTIONS", () => {
  it("lists every EnabledFilter value in Select order", () => {
    expect(FILTER_OPTIONS).toEqual(["all", "enabled", "disabled"]);
  });
});
