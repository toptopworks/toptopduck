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

/** The chip's excerpt cap: the reference chip's head-glance width. */
const EXCERPT_CAP = 8;

/** The chip's display + accessible-name excerpt: the selection's head,
 *  capped at 8 characters with an ellipsis (the reference chip's head
 *  glance; the full text lives in the chip's hover tooltip). A surrogate
 *  pair straddling the cap leaves the HIGH surrogate as the cap's last
 *  unit (its low half got cut); stepping back one keeps the glyph whole. */
export function quoteExcerpt(text: string): string {
  if (text.length <= EXCERPT_CAP) return text;
  const capped = text.slice(0, EXCERPT_CAP);
  const tail = capped.charCodeAt(EXCERPT_CAP - 1);
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

/** One quote parsed back out of a submitted question. */
export interface SplitQuestion {
  /** The leading blockquote block's quotes, de-prefixed, in order. */
  quotes: string[];
  /** Everything after the quote block -- the draft as submitted. Empty
   *  when the question was the quotes alone. */
  draft: string;
}

/** The submit materialization's inverse, display-side: a question opening
 *  with '>'-prefixed lines parses back into its quotes and the draft that
 *  followed. The question text itself is untouched -- the agent received
 *  the blockquote verbatim; this only drives the bubble's chip rendering.
 *  A question with no leading '>' round-trips untouched. A hand-typed
 *  leading blockquote renders as chips too (the bubble's one quote face),
 *  and a draft that itself opens with '>' right after a quote block reads
 *  as one more chip -- both display-only; the chip tooltip keeps the full
 *  text. */
export function splitQuotedQuestion(question: string): SplitQuestion {
  const lines = normalizeNewlines(question).split("\n");
  const quotes: string[][] = [];
  let current: string[] | null = null;
  let head = 0;
  while (head < lines.length) {
    const line = lines[head];
    if (line.startsWith(">")) {
      if (current === null) {
        current = [];
        quotes.push(current);
      }
      current.push(line.startsWith("> ") ? line.slice(2) : line.slice(1));
      head += 1;
    } else if (
      line === "" &&
      current !== null &&
      head + 1 < lines.length &&
      lines[head + 1].startsWith(">")
    ) {
      current = null; // the blank line between two blockquotes
      head += 1;
    } else {
      break;
    }
  }
  if (quotes.length === 0) return { quotes: [], draft: question };
  const rest = lines.slice(head);
  if (rest[0] === "") rest.shift(); // the submit-side join's one blank line
  return { quotes: quotes.map((block) => block.join("\n")), draft: rest.join("\n") };
}
