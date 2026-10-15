import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../lastModifiedText";

// Pure tests for the sidebar row inline relative-time formatter (ADR-0093,
// issue #513). Pins branch selection + clamp behavior rather than exact ICU
// output — narrow unit display ("8h" vs "8 hr") varies across Node/ICU versions.

const NOW = new Date("2026-07-10T12:00:00").getTime();
const MIN = 60;
const HR = 3600;
const DAY = 86400;
const WEEK = 604800;
const MONTH = 2629800;
const YEAR = 31557600;

describe("formatRelativeTime (ADR-0093, issue #513)", () => {
  it("clamps to zero when lastModifiedAt > now (clock skew / just-saved)", () => {
    const result = formatRelativeTime(NOW + 60_000, NOW, "en");
    expect(result).toMatch(/^0/);
    expect(result).not.toMatch(/-/);
  });

  it("clamps to zero for lastModifiedAt === now", () => {
    expect(formatRelativeTime(NOW, NOW, "en")).toMatch(/^0/);
  });

  it("selects seconds for < 60s", () => {
    expect(formatRelativeTime(NOW - 30 * 1000, NOW, "en")).toMatch(/^30/);
  });

  it("selects minutes for >= 60s", () => {
    expect(formatRelativeTime(NOW - 5 * MIN * 1000, NOW, "en")).toMatch(/^5/);
  });

  it("selects hours for >= 60min", () => {
    expect(formatRelativeTime(NOW - 3 * HR * 1000, NOW, "en")).toMatch(/^3/);
  });

  it("selects days for >= 24h", () => {
    expect(formatRelativeTime(NOW - 3 * DAY * 1000, NOW, "en")).toMatch(/^3/);
  });

  it("selects weeks for >= 7d", () => {
    expect(formatRelativeTime(NOW - 3 * WEEK * 1000, NOW, "en")).toMatch(/^3/);
  });

  it("selects months for >= 5 weeks", () => {
    expect(formatRelativeTime(NOW - 3 * MONTH * 1000, NOW, "en")).toMatch(/^3/);
  });

  it("selects years for >= 12 months", () => {
    expect(formatRelativeTime(NOW - 2 * YEAR * 1000, NOW, "en")).toMatch(/^2/);
  });

  it("boundary: 59s is seconds, 60s crosses to minutes", () => {
    const s59 = formatRelativeTime(NOW - 59 * 1000, NOW, "en");
    const s60 = formatRelativeTime(NOW - 60 * 1000, NOW, "en");
    expect(s59).not.toEqual(s60);
  });

  it("strips all whitespace for compact inline display", () => {
    // en-US narrow unit style may insert a space ("8 hr"); the function
    // strips it so the result fits compactly on the sidebar row.
    expect(formatRelativeTime(NOW - 8 * HR * 1000, NOW, "en")).not.toMatch(/\s/);
  });

  it("produces different output for different locales", () => {
    // zh-CN uses CJK unit characters; en uses Latin abbreviations.
    const zh = formatRelativeTime(NOW - 8 * HR * 1000, NOW, "zh-CN");
    const en = formatRelativeTime(NOW - 8 * HR * 1000, NOW, "en");
    expect(zh).not.toEqual(en);
  });
});
