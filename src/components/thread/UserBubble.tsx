// The chat projection's user side (ADR-0103, issue #609): one turn's question
// rendered as a right-aligned bubble. The bubble carries ONLY user output and
// conversation facts -- the verbatim question in full (pre-wrap; the ADR-0054
// single-line + tooltip posture is retired), the asked_at stamp, the copy
// affordance, and the stale strike-through when the turn's result died. Every
// app annotation (active chip, skill drift, outcome, failures) lives on the
// assistant side (TurnCard's stream) -- reading order is question, then
// annotations, then reply.
//
// The verbatim question is layer-4 content (ADR-0039) and passes through
// untranslated; asked_at renders as the locale time (ADR-0052 chrome).

import { useIntl } from "react-intl";
import { Puzzle } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";
import { HOVER_REVEAL_CLASS } from "./turn-visual";

// The stale strike rides dotted (ADR-0041/0047), shared by both shapes: the
// bare bubble carries it on the bubble element itself, the chips shape on the
// question span.
const STALE_STRIKE = "stale line-through decoration-dotted";

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
  return (
    <div className="user-bubble group flex flex-col items-end">
      {/* ADR-0119 Decision 5: the invocation chips share the bubble's inline
          flow (issue #993) -- they read ahead of the question inside the
          bubble box and the question text wraps naturally after them, with no
          pill surface: each chip keeps the composer chips' face -- accent
          color riding the chip container (the glyph tints through
          currentColor) over medium-weight text -- behind the same Puzzle
          glyph, DESIGN.md's sole accent system. A <ul> is flow content and
          may not nest in the <p>, so the list rides phrasing content with
          list roles; decorative (no interaction), names untranslated. Chip
          spacing rides the item margin; the literal space after the list is
          the question's word gap and its wrap point. */}
      {/* The bubble box rides the question element itself (the .turn-question
          hook stays for selector / test stability): secondary surface + lg
          radius per the conversation-surface tokens, the top-right corner
          stepped down to sm so the bubble reads as pointing at the user's
          side. Full text wraps -- the identity handle (ADR-0039) is never
          clipped. A stale turn strikes the question through dotted
          (ADR-0041/0047); in the chips shape the strike rides a dedicated
          question span -- text-decoration propagates through inline
          descendants, so leaving it on the bubble would strike the chips
          too. The bare (no-invocation) bubble keeps the strike on the
          bubble element itself, exactly as before the chips moved in. */}
      <p
        className={cn(
          "turn-question m-0 max-w-[85%] rounded-lg rounded-tr-sm bg-secondary px-3 py-2",
          "text-sm text-secondary-foreground whitespace-pre-wrap break-words",
          isStale && !hasSkills && STALE_STRIKE,
        )}
      >
        {hasSkills && (
          <>
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
                  className="invoked-skill mr-1 inline-flex max-w-full items-center gap-1 align-baseline font-medium text-accent-foreground"
                >
                  <Puzzle className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
            </span>{" "}
          </>
        )}
        {hasSkills ? (
          <span className={cn(isStale && STALE_STRIKE)}>{question}</span>
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
          <time dateTime={new Date(askedAt).toISOString()}>{intl.formatTime(askedAt)}</time>
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
