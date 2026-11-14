import { useIntl } from "react-intl";
import { SquareLetterT, X } from "lucide-react";
import { bareButtonReset } from "../../lib/buttonReset";
import { quoteExcerpt } from "../../lib/quoteText";
import type { QuoteEntry } from "../../session/useComposerState";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { CHIP_FACE } from "./chip-face";

// Quote chips (#1573): the composer's display of the selection surface's
// staged passages for THIS session, isomorphic with ComposerSkillChips
// (inline in the input area, the caret seats right after the last chip) and
// always seated BEFORE the skill chips -- the quote is the question's
// leading material. The chip is the quiet ground-relative pill (the
// chip-surface token as its face, ink text, badge typography) wearing the boxed
// glyph: a hairline box, an
// 8-character excerpt, and the full text on hover (the inverted-tier
// tooltip). Withdrawal rides the per-chip button and the Backspace
// at the draft start chain (the shell routes it: the last skill chip first,
// then the last quote). Duplicated stagings render as separate chips; the
// key rides the staging id, never the text.
//
// The list is phrasing content (span + roles, the #993 invocation-chip
// precedent) rather than ul/li: the sent bubble hosts the same face inside
// its question <p>, where flow content may not nest.

export type ComposerQuoteChipsProps = {
  /** The session's staged quotes, in staging order. Empty renders nothing. */
  quotes: readonly QuoteEntry[];
  /** Per-chip removal dispatch by staging id. Absent = pure display. */
  onRemove?: (id: number) => void;
};

export function ComposerQuoteChips({ quotes, onRemove }: ComposerQuoteChipsProps) {
  const intl = useIntl();
  if (quotes.length === 0) return null;
  return (
    <span
      className="contents"
      role="list"
      aria-label={intl.formatMessage({
        id: "composer.quoteChips.listAria",
        defaultMessage: "Quoted passages",
      })}
    >
      {quotes.map((quote) => (
        <Tooltip key={quote.id}>
          <TooltipTrigger asChild>
            {/* The face rides the shared CHIP_FACE constant (chip-face.ts
                carries the rationale: ground-relative tint over an opaque
                fill -- one opaque value cannot serve both grounds -- and
                the leading-5 line box that makes top alignment read as
                center alignment). The glyph rides the reference's boxed
                face: a hairline 4px box one step down from the pill. */}
            <span role="listitem" className={CHIP_FACE}>
              <span className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border">
                <SquareLetterT className="size-3.5" aria-hidden />
              </span>
              <span className="truncate">{quoteExcerpt(quote.text)}</span>
              {onRemove && (
                <button
                  type="button"
                  className={`${bareButtonReset} hover:bg-transit -m-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
                  aria-label={intl.formatMessage(
                    {
                      id: "composer.quoteChips.removeLabel",
                      defaultMessage: "Remove quote: {excerpt}",
                    },
                    { excerpt: quoteExcerpt(quote.text) },
                  )}
                  onClick={() => onRemove(quote.id)}
                >
                  <X className="size-3 shrink-0" aria-hidden />
                </button>
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 whitespace-pre-wrap">
            {quote.text}
          </TooltipContent>
        </Tooltip>
      ))}
    </span>
  );
}
