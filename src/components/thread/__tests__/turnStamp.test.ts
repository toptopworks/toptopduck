import { createIntl } from "react-intl";
import { describe, expect, it } from "vitest";
import { formatTurnStamp } from "../turnStamp";

// Pure tests for the conversation stamp formatter (ADR-0052 chrome, Chat-style
// dynamic label). Pins branch selection rather than exact ICU output -- short
// month/time rendering varies across Node/ICU versions.

const intl = createIntl({ locale: "en-US" });
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
});
