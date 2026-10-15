// The swap-stable turn-exchange head (ADR-0103 live isomorphism, issues
// #610/#620): the settled TurnCard and the streaming LiveTurnExchange mount
// the SAME frame -- card wrapper, user bubble, assistant-stream opening --
// so the settle swap re-hosts the head from one code path; every altitude
// difference rides the optional props below. The runtime attribution marker
// (issue #818) is the stream's FIRST child -- who answers precedes everything
// the actor does inside the turn (annotations, rounds); a marker the live
// side has is re-hosted in place at the swap, and a read landing only after
// the settle lets the settled card add it. The StreamHeader annotations
// (ADR-0103: the app's read of the question -- which dataset it named,
// ADR-0047; which mounted skills drifted since the answer, issue #381) open
// ahead of the rounds, so the reading order is question -> annotation ->
// execution -> reply; the chip must already ride the live side so the swap
// adds no element, while the drift badges -- or the whole header, when the
// live question named no chip -- join the late-read marker as the additions
// data can only make after the swap. The sides differ only through
// orthogonal optional props -- no variant enum, because anything legal after
// the swap must not be encoded as a second mode; the prop type arms `live`
// against the settled-only flags so the never-legal combinations fail to
// compile.

import type { ReactNode } from "react";
import { FormattedMessage } from "react-intl";
import { PencilLine } from "lucide-react";
import { cn } from "@/lib/utils";
import { RuntimeAttributionMarker } from "./RuntimeAttributionMarker";
import { StreamHeader } from "./StreamHeader";
import { TurnActiveChip } from "./TurnActiveChip";
import { UserBubble } from "./UserBubble";
import { runtimeMarkerName, type DatasetLabel } from "./turn-visual";
import type { TurnRuntime } from "../../types/thread";

export function TurnExchangeFrame({
  question,
  askedAt,
  invokedSkills,
  isStale = false,
  runtime,
  mentionedDataset,
  drifted = [],
  weakened = false,
  live = false,
  children,
}: {
  question: string;
  /** When the user submitted, Unix epoch ms (UserBubble's contract; undefined
   *  for turns recorded before v5 renders without a timestamp). */
  askedAt?: number;
  /** The user-invocation badge names (ADR-0119 Decision 5): the live
   *  side passes the client-known staging, the settled side the User-actor
   *  derivation. Empty renders no badge list. */
  invokedSkills?: string[];
  /** The turn's runtime attribution (issue #818). Only a runtime that can
   *  name its adapter renders the marker -- built-in / unrecorded stay
   *  silent, so an unmarked stretch reads as the default runtime. */
  runtime?: TurnRuntime;
  mentionedDataset: DatasetLabel | null;
  /** Everything after the head: the rounds, the outcome body, the artifacts
   *  card, the closing meta row (settled) or the running status (live). */
  children: ReactNode;
} & (
  | {
    /** The streaming side: flips the data-live hook and drops the
       *  settled-only hover-reveal group. */
    live?: true;
    weakened?: never;
    drifted?: never;
    isStale?: never;
  }
  | {
    live?: false;
    /** Dims the assistant side for Failed/Cancelled (the question never
       *  dims, ADR-0028 Why 2). */
    weakened?: boolean;
    /** The skills that drifted since the answer (issue #381) -- the
       *  settled side's StreamHeader badges. The live side passes none: the
       *  swap may add a badge, never the chip (issue #620). */
    drifted?: string[];
    /** Ghosts the whole exchange for a stale Materialized turn. */
    isStale?: boolean;
  }
)) {
  const runtimeName = runtimeMarkerName(runtime);
  return (
    <div
      className={cn(
        live && "live-turn-exchange",
        "turn-card rounded-md py-1.5",
        isStale && "stale-ghost opacity-50",
      )}
      data-stale={isStale ? "true" : undefined}
      data-live={live ? "true" : undefined}
    >
      <UserBubble
        question={question}
        askedAt={askedAt}
        isStale={isStale}
        invokedSkills={invokedSkills}
      />
      <div
        className={cn(
          "assistant-stream",
          !live && "group",
          "mt-1 flex flex-col items-start",
          weakened && "opacity-60",
        )}
      >
        {runtimeName !== null && <RuntimeAttributionMarker adapterId={runtimeName} />}
        {(mentionedDataset || drifted.length > 0) && (
          <StreamHeader>
            {mentionedDataset && <TurnActiveChip dataset={mentionedDataset} />}
            {drifted.map((name) => (
              <span
                key={name}
                className="skill-drift-name inline-flex items-center gap-0.5 rounded-sm bg-muted px-1 py-0.5"
              >
                <PencilLine aria-hidden="true" className="w-3 h-3 shrink-0" />
                <span className="truncate">{name}</span>
                <FormattedMessage
                  id="thread.skill.modifiedSuffix"
                  defaultMessage=" · modified since this answer"
                />
              </span>
            ))}
          </StreamHeader>
        )}
        {children}
      </div>
    </div>
  );
}
