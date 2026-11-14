// The chat projection's user side (ADR-0103, issue #609): one turn's question
// rendered as a right-aligned bubble. The bubble carries ONLY user output and
// conversation facts -- the invocation chips (ADR-0119 Decision 5), the
// verbatim question in full (pre-wrap; the ADR-0054 single-line + tooltip
// posture is retired), the asked_at stamp, the copy affordance, and the stale
// strike-through when the turn's result died. Every app annotation (active
// chip, skill drift, outcome, failures) lives on the assistant side
// (TurnCard's stream) -- reading order is the quote chips (#1573, the
// submit materialization parsed back out of the question), then the
// invocation chips, then the question, then the assistant-side
// annotations, then reply.
//
// The verbatim question is layer-4 content (ADR-0039) and passes through
// untranslated; asked_at renders as the Chat-style conversation stamp
// (formatTurnStamp, ADR-0052 chrome).

import { useIntl } from "react-intl";
import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import { splitQuotedQuestion } from "../../lib/quoteText";
import { CopyButton } from "./CopyButton";
import { CHIP_FACE } from "./chip-face";
import { ComposerQuoteChips } from "./ComposerQuoteChips";
import { HOVER_REVEAL_CLASS } from "./turn-visual";
import { formatTurnStamp } from "./turnStamp";

// The stale strike rides dotted (ADR-0041/0047), shared by both shapes: the
// bare bubble carries it on the bubble element itself, the chips shape on the
// question span.
const STALE_STRIKE = "stale line-through decoration-dotted";

// A quotes-only stale turn has no draft text to strike and text-decoration
// does not propagate into the atomic inline-flex chips, so the strike rides
// the chips' inner text through a container variant -- the same dotted
// decoration, aimed at the one strikable node each chip owns.
const STALE_CHIP_STRIKE =
  "stale [&_[role=listitem]_.truncate]:line-through [&_[role=listitem]_.truncate]:decoration-dotted";

export function UserBubble({
  question,
  askedAt,
  isStale,
  invokedSkills = [],
}: {
  question: string;
  /** When the user submitted, Unix epoch ms (ADR-0103). undefined for turns
   *  recorded before v5 -- rendered without a timestamp, never a synthetic
   *  one (honest degrade). */
  askedAt: number | undefined;
  isStale: boolean;
  /** ADR-0119 Decision 5: the skills the user invoked this turn -- the badge
   *  face of "what shaped this question". The settled card derives the names
   *  from the turn's own invocation records (actor User); the live exchange
   *  passes the client-known staging. Empty renders nothing (no records, no
   *  badge). Decorative badges: the names are layer-4 content, the list
   *  carries an accessible group label. */
  invokedSkills?: string[];
}) {
  const intl = useIntl();
  const hasSkills = invokedSkills.length > 0;
  // The submit materialization parses back out of the verbatim question:
  // the leading blockquote block renders as the composer's quote chips
  // (pure display -- no withdrawal from a sent message), the draft tail is
  // the question text proper. Copy still carries the full verbatim text.
  const { quotes, draft } = splitQuotedQuestion(question);
  const hasQuotes = quotes.length > 0;
  const quoteEntries = quotes.map((text, index) => ({ id: index, text }));
  return (
    <div className="user-bubble group flex flex-col items-end">
      {/* ADR-0119 Decision 5: the invocation chips share the bubble's inline
          flow (issue #993) -- they read ahead of the question inside the
          bubble box and the question text wraps naturally after them. The
          #993 bare-accent face was recalibrated (2026-11-14, the reference
          alignment) onto the quiet pill the composer chips now wear: the
          ground-relative chip-surface step (the same face on both the
          bubble's secondary box and the composer's card), ink text,
          13px/500 text (the code-inline size)
          -- the chip reads as metadata, not as a highlighted fragment. A
          <ul> is flow content
          and may not nest in the <p>, so the list rides phrasing content
          with list roles; decorative (no interaction), names untranslated.
          Chip spacing rides the item margin; the literal space after the
          list is the question's word gap and its wrap point. */}
      {/* The bubble box rides the question element itself (the .turn-question
          hook stays for selector / test stability): secondary surface + lg
          radius per the conversation-surface tokens, the top-right corner
          stepped down to sm so the bubble reads as pointing at the user's
          side. Full text wraps -- the identity handle (ADR-0039) is never
          clipped. A stale turn strikes the question through dotted
          (ADR-0041/0047); in the chips shape the strike rides a dedicated
          question span, scoping the decoration to the question text -- the
          chips are atomic inline boxes (inline-flex) that text-decoration
          does not propagate into, and the span pins that isolation even if
          the chips' display ever changes. A quotes-only stale turn has no
          question span to carry the strike, so its variant aims the same
          decoration at the chips' inner text. The bare (no-invocation)
          bubble keeps the strike on the bubble element itself, exactly as
          before the chips moved in. */}
      <p
        className={cn(
          "turn-question m-0 max-w-[85%] rounded-lg rounded-tr-sm bg-secondary px-3 py-2",
          "text-sm text-secondary-foreground whitespace-pre-wrap break-words",
          // The bubble's inline flow has no flex gap: chips separate by the
          // literal spaces below (the wrap points), which alone read ~4px --
          // narrower than the composer row's 8px gap. One arbitrary-variant
          // rule tops every chip up to the composer's spacing and pins its
          // vertical alignment; the skills' own mr-1/align-middle retire
          // into it. The alignment is align-top, not middle: at the chips'
          // leading-5 (20px) box == the text-sm line box, top alignment
          // makes the two boxes coincide -- each centers its own content,
          // and middle's x-height baseline math skews against CJK faces.
          "[&_[role=listitem]]:mr-1 [&_[role=listitem]]:align-top",
          isStale && !hasSkills && !hasQuotes && STALE_STRIKE,
          isStale && hasQuotes && draft === "" && STALE_CHIP_STRIKE,
        )}
      >
        {hasQuotes && <ComposerQuoteChips quotes={quoteEntries} />}
        {/* The space is the quote list's only boundary carrier when the
            draft is empty and skills follow -- mr-1 alone reads 4px against
            the ~8px rhythm at every other chip boundary. */}
        {hasQuotes && (draft !== "" || hasSkills) && " "}
        {hasSkills && (
          <span
            role="list"
            className="invoked-skills"
            aria-label={intl.formatMessage({
              id: "thread.userBubble.invokedSkillsAria",
              defaultMessage: "Skills invoked with this message",
            })}
          >
            {invokedSkills.map((name) => (
              <span
                key={name}
                role="listitem"
                className={cn("invoked-skill", CHIP_FACE)}
              >
                <Puzzle className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{name}</span>
              </span>
            ))}
          </span>
        )}
        {hasSkills && " "}
        {hasSkills || hasQuotes ? (
          <span className={cn(isStale && STALE_STRIKE)}>{draft}</span>
        ) : (
          question
        )}
      </p>
      {/* The conversation-fact meta row: the ask stamp + the copy affordance,
          hover-revealed (HOVER_REVEAL_CLASS rides the user-bubble group) so
          the bubble reads as pure conversation at rest. */}
      <span
        className={cn(
          "meta-reveal mt-0.5 flex items-center gap-0.5 text-xs text-muted-foreground",
          HOVER_REVEAL_CLASS,
        )}
      >
        {askedAt !== undefined && (
          <time dateTime={new Date(askedAt).toISOString()}>{formatTurnStamp(askedAt, intl)}</time>
        )}
        <CopyButton
          text={question}
          label={intl.formatMessage({
            id: "thread.copy.question",
            defaultMessage: "Copy message",
          })}
        />
      </span>
    </div>
  );
}
