import { describe, expect, it } from "vitest";
import { catalogIntl } from "../../common/__tests__/helpers";
import { formatTurnStamp } from "../turnStamp";

// Pure tests for the conversation stamp formatter (ADR-0052 chrome, Chat-style
// dynamic label). Pins branch selection rather than exact ICU output -- short
// month/time rendering varies across Node/ICU versions.

const intl = catalogIntl("en-US");
const NOW = new Date("2026-10-04T18:00:00").getTime();

describe("formatTurnStamp", () => {
  it("today renders as time only (no date components)", () => {
    const text = formatTurnStamp(new Date("2026-10-04T09:05:00").getTime(), intl, NOW);
    expect(text).toMatch(/9:05/);
    expect(text).not.toMatch(/Oct/);
    expect(text).not.toMatch(/2026/);
  });

  it("an earlier day this year appends the short date without the year", () => {
    const text = formatTurnStamp(new Date("2026-10-01T09:05:00").getTime(), intl, NOW);
    expect(text).toMatch(/Oct/);
    expect(text).toMatch(/9:05/);
    expect(text).not.toMatch(/2026/);
  });

  it("a prior-year stamp includes the year", () => {
    const text = formatTurnStamp(new Date("2025-10-01T09:05:00").getTime(), intl, NOW);
    expect(text).toMatch(/Oct/);
    expect(text).toMatch(/2025/);
    expect(text).toMatch(/9:05/);
  });

  // 30 minutes old, but the local calendar day differs -- pins the midnight
  // rollover, not a rolling 24h window.
  it("a stamp minutes old but on the prior local day carries the date", () => {
    const now = new Date("2026-10-04T00:15:00").getTime();
    const text = formatTurnStamp(new Date("2026-10-03T23:45:00").getTime(), intl, now);
    expect(text).toMatch(/Oct/);
    expect(text).not.toMatch(/2026/);
  });

  it("a stamp hours before new-year midnight includes the year", () => {
    const now = new Date("2026-01-01T01:00:00").getTime();
    const text = formatTurnStamp(new Date("2025-12-31T23:00:00").getTime(), intl, now);
    expect(text).toMatch(/Dec/);
    expect(text).toMatch(/2025/);
  });
});
