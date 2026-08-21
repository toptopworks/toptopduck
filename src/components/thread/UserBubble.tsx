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
import { cn } from "@/lib/utils";
import { CopyButton } from "./CopyButton";
import { HOVER_REVEAL_CLASS } from "./turn-visual";

export function UserBubble({
  question,
  askedAt,
  isStale,
}: {
  question: string;
  /** When the user submitted, Unix epoch ms (ADR-0103). undefined for turns
   *  recorded before v5 -- rendered without a timestamp, never a synthetic
   *  one (honest degrade). */
  askedAt: number | undefined;
  isStale: boolean;
}) {
  const intl = useIntl();
  return (
    <div className="user-bubble group flex flex-col items-end">
      {/* The bubble box rides the question element itself (the .turn-question
          hook stays for selector / test stability): secondary surface + lg
          radius per the conversation-surface tokens, the top-right corner
          stepped down to sm so the bubble reads as pointing at the user's
          side. Full text wraps -- the identity handle (ADR-0039) is never
          clipped. A stale turn strikes the question through dotted
          (ADR-0041/0047). */}
      <p
        className={cn(
          "turn-question m-0 max-w-[85%] rounded-lg rounded-tr-sm bg-secondary px-3 py-2",
          "text-sm text-secondary-foreground whitespace-pre-wrap break-words",
          isStale && "stale line-through decoration-dotted",
        )}
      >
        {question}
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
