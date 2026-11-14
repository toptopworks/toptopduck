import { describe, expect, it } from "vitest";
import {
  materializeQuotes,
  quoteExcerpt,
} from "../quoteText";

// The quote channel's text shaping (#1573): selections materialize as
// blockquotes prepended to the draft at the submit boundary; chips carry a
// capped excerpt for display and the accessible name.

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
