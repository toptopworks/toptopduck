// The K/M scale's boundary pins (ADR-0130 Decision 5): the fixed algorithm
// replaces Intl's locale-shaped compact notation, so the boundaries are
// exact literals -- a reading never crosses a unit boundary it did not
// reach (floor, never round).

import { describe, expect, it } from "vitest";
import { createIntl } from "react-intl";

import { formatTokens } from "../tokenFormat";

// The intl argument is dead weight by decision (signature stability); a
// real instance keeps the call sites' shape honest.
const intl = createIntl({ locale: "en" });

describe("formatTokens K/M boundaries (ADR-0130, issue #1272)", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [1001, "1K"],
    [1500, "1.5K"],
    [1234, "1.2K"],
    [999_999, "999.9K"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
    [12_345_678, "12.3M"],
  ])("formats %d as %s", (n, expected) => {
    expect(formatTokens(n, intl)).toBe(expected);
  });
});
