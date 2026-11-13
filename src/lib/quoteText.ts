// Quote text shaping for the selection surface (#1573): a staged selection
// materializes at the submit boundary as a blockquote prepended to the
// draft, joined with a blank line; the same shape dsh's formatQuoteText
// canonicalizes (CRLF normalized, every line prefixed, blank lines kept
// inside the blockquote), so a multi-line selection made in the thread
// reads back as one quotation at submit.

/** One CRLF / lone-CR sequence becomes a bare newline; the blockquote
 *  prefixing below then works per line. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The chip's display + accessible-name excerpt: the selection's head,
 *  capped at 30 characters with an ellipsis. A surrogate pair straddling
 *  the cap leaves the HIGH surrogate as the cap's last unit (its low half
 *  got cut); stepping back one keeps the glyph whole. */
export function quoteExcerpt(text: string, cap = 30): string {
  if (text.length <= cap) return text;
  const capped = text.slice(0, cap);
  const tail = capped.charCodeAt(cap - 1);
  if (tail >= 0xd800 && tail <= 0xdbff) return `${capped.slice(0, -1)}…`;
  return `${capped}…`;
}

/** Serialize the staging into the submit question's leading blockquote
 *  block: every quote's lines prefixed with '> ' (an interior blank line
 *  becomes '>' so the quotation never breaks apart), quotes joined by a
 *  blank line. Empty staging serializes to an empty string -- the submit
 *  question is then the draft alone. */
export function materializeQuotes(quotes: readonly string[]): string {
  if (quotes.length === 0) return "";
  return quotes
    .map((text) =>
      normalizeNewlines(text)
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n"),
    )
    .join("\n\n");
}
