// The thinking head's excerpt pure function (issue #1658): paragraph-level
// progression -- the latest COMPLETE line, never the still-growing stretch,
// never per-delta.

import { describe, expect, it } from "vitest";
import { thinkingHeadExcerpt } from "../../../session/useTurnFlow";

describe("thinkingHeadExcerpt", () => {
  it("reads the latest complete line of a multi-paragraph stream", () => {
    expect(thinkingHeadExcerpt("first\nsecond\nthird-in-progress")).toBe("second");
  });

  it("skips empty lines", () => {
    expect(thinkingHeadExcerpt("a\n\nb\nc")).toBe("b");
    expect(thinkingHeadExcerpt("a\n \nb\nc")).toBe("b");
  });

  it("returns empty when no line has closed (no newline)", () => {
    expect(thinkingHeadExcerpt("only-one-stretch")).toBe("");
  });

  it("returns empty for empty text", () => {
    expect(thinkingHeadExcerpt("")).toBe("");
  });

  it("treats a trailing newline as a closed final line", () => {
    expect(thinkingHeadExcerpt("a\nb\n")).toBe("b");
  });

  it("keeps a very long line intact (the fade is the view's, not the text's)", () => {
    const long = "x".repeat(5000);
    expect(thinkingHeadExcerpt(`${long}\ngrowing`)).toBe(long);
  });
});
