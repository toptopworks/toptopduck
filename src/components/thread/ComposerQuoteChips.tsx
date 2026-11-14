import { useIntl } from "react-intl";
import { SquareLetterT, X } from "lucide-react";
import { bareButtonReset } from "../../lib/buttonReset";
import { quoteExcerpt } from "../../lib/quoteText";
import type { QuoteEntry } from "../../session/useComposerState";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

// Quote chips (#1573): the composer's display of the selection surface's
// staged passages for THIS session, isomorphic with ComposerSkillChips
// (inline in the input area, the caret seats right after the last chip) and
// always seated BEFORE the skill chips -- the quote is the question's
// leading material. The chip is the three-piece reference: icon, an
// 8-character excerpt, and the full text on hover (the inverted-tier
// tooltip). Withdrawal rides the per-chip button and the Backspace
// at the draft start chain (the shell routes it: the last skill chip first,
// then the last quote). Duplicated stagings render as separate chips; the
// key rides the staging id, never the text.

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
    <ul
      className="contents"
      aria-label={intl.formatMessage({
        id: "composer.quoteChips.listAria",
        defaultMessage: "Quoted passages",
      })}
    >
      {quotes.map((quote) => (
        <Tooltip key={quote.id}>
          <TooltipTrigger asChild>
            <li className="inline-flex min-w-0 max-w-full items-center gap-1 text-sm font-medium text-accent-foreground">
              <SquareLetterT className="size-4 shrink-0" aria-hidden />
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
            </li>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 whitespace-pre-wrap">
            {quote.text}
          </TooltipContent>
        </Tooltip>
      ))}
    </ul>
  );
}
