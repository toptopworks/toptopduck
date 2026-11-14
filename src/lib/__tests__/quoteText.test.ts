import { describe, expect, it } from "vitest";
import {
  materializeQuotes,
  quoteExcerpt,
  splitQuotedQuestion,
} from "../quoteText";

// The quote channel's text shaping (#1573): selections materialize as
// blockquotes prepended to the draft at the submit boundary; chips carry a
// capped excerpt for display and the accessible name. The bubble side parses
// the materialization back out so the sent message renders the same chips
// the composer staged.

describe("materializeQuotes", () => {
  it("returns an empty string for an empty staging", () => {
    expect(materializeQuotes([])).toBe("");
  });

  it("prefixes every line of one quote with '> ' (blockquote)", () => {
    expect(materializeQuotes(["first line"])).toBe("> first line");
    expect(materializeQuotes(["first\nsecond"])).toBe("> first\n> second");
  });

  it("normalizes CRLF and lone CR before prefixing", () => {
    expect(materializeQuotes(["a\r\nb\rc"])).toBe("> a\n> b\n> c");
  });

  it("joins multiple quotes with a blank line between blockquotes", () => {
    expect(materializeQuotes(["one", "two\nlines"])).toBe(
      "> one\n\n> two\n> lines",
    );
  });

  it("keeps an interior blank line inside one quote as an empty blockquote line", () => {
    // A blank line inside the selection keeps its own '> ' prefix so the
    // blockquote never breaks apart at submit.
    expect(materializeQuotes(["a\n\nb"])).toBe("> a\n>\n> b");
  });
});

describe("splitQuotedQuestion", () => {
  it("round-trips a materialized quote ahead of the draft", () => {
    const question = `${materializeQuotes(["宁德时代300750-估值报"])}\n\n加一张同业 PB-ROE 散点图`;
    expect(splitQuotedQuestion(question)).toEqual({
      quotes: ["宁德时代300750-估值报"],
      draft: "加一张同业 PB-ROE 散点图",
    });
  });

  it("returns the question untouched when it has no leading blockquote", () => {
    expect(splitQuotedQuestion("plain question")).toEqual({
      quotes: [],
      draft: "plain question",
    });
  });

  it("splits multiple blank-line-separated quotes from the draft", () => {
    expect(splitQuotedQuestion("> one\n\n> two\n> lines\n\ndraft")).toEqual({
      quotes: ["one", "two\nlines"],
      draft: "draft",
    });
  });

  it("keeps an interior blank line inside one quote", () => {
    expect(splitQuotedQuestion("> a\n>\n> b\n\ndraft")).toEqual({
      quotes: ["a\n\nb"],
      draft: "draft",
    });
  });

  it("yields an empty draft for a quotes-only question", () => {
    expect(splitQuotedQuestion("> only quoted")).toEqual({
      quotes: ["only quoted"],
      draft: "",
    });
  });

  it("normalizes CRLF before splitting", () => {
    expect(splitQuotedQuestion("> a\r\n\r\ndraft")).toEqual({
      quotes: ["a"],
      draft: "draft",
    });
  });

  it("reads a draft opening with '>' after the quote block as one more chip", () => {
    // The documented display-only stance: the parser cannot tell a
    // materialized quote from a hand-typed '>' line, so the draft's
    // leading '>' line rides along as chip text (de-prefixed by one '>').
    expect(splitQuotedQuestion("> 甲\n\n>= 100")).toEqual({
      quotes: ["甲", "= 100"],
      draft: "",
    });
  });
});

describe("quoteExcerpt", () => {
  it("returns short text verbatim", () => {
    expect(quoteExcerpt("short")).toBe("short");
  });

  it("caps long text at 8 chars with an ellipsis", () => {
    const long = "x".repeat(40);
    expect(quoteExcerpt(long)).toBe(`${"x".repeat(8)}…`);
  });

  it("does not split a surrogate pair at the cap", () => {
    // 7 ASCII units + one 2-unit glyph = 9 units: the 8-unit cap would
    // cut between the pair's halves, leaving an orphan high surrogate.
    const text = `${"x".repeat(7)}𠮷`;
    expect(quoteExcerpt(text)).toBe(`${"x".repeat(7)}…`);
  });
});
