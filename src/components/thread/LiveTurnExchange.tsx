// The in-flight turn's chat exchange (ADR-0103 live isomorphism, issue #610):
// rendered at the thread's tail while a turn runs -- the user bubble mounts
// the moment the user submits (asked_at is the client's submit stamp; the
// question is final at submit, so the copy affordance is honest), over a
// streaming assistant side: per-round thinking folds + connective prose +
// tool rows (approval cards in flow, ADR-0083 -- the card chrome lives in
// LiveRow, semantics unchanged from the retired progressive card).
//
// Settle swaps this block for the settled TurnCard: rowsToRounds folds the
// same rounds into the optimistic TurnRecord.trace, so the bubble, prose and
// thinking folds carry over unchanged (no reflow); the running status row
// yields to the outcome body + closing meta row, and the streamed rows fold
// behind the per-round step fold (the settled default posture, ADR-0078).

import { FormattedMessage } from "react-intl";
import { Loader2 } from "lucide-react";
import { UserBubble } from "./UserBubble";
import { LiveRow } from "./TraceView";
import { ThinkingFold } from "./ThinkingFold";
import type { LiveTraceRow, LiveTurn } from "../../session/useTurnFlow";
import type { ApprovalResponse } from "../../types/approval";
import type { ThinkingTrace } from "../../types/thread";

// One live round: the thinking fold + connective prose render exactly as the
// settled TraceRoundBlock renders them (isomorphism -- the settle swap must
// not move them); the round's rows stream UNFOLDED -- the step fold is the
// settled posture, but streaming calls must be visible as they land.
function LiveRoundBlock({
  thinking,
  text,
  rows,
  onRespondApproval,
}: {
  thinking: ThinkingTrace | undefined;
  text: string | undefined;
  rows: LiveTraceRow[];
  onRespondApproval: (requestId: string, response: ApprovalResponse) => void;
}) {
  if (thinking === undefined && text === undefined && rows.length === 0) return null;
  return (
    <div className="trace-round">
      {thinking !== undefined && <ThinkingFold thinking={thinking} />}
      {text !== undefined && (
        // The same prose paragraph the settled round renders (ADR-0103 --
        // prose is the conversational discourse, always expanded).
        <p className="round-text m-0 mt-0.5 text-sm leading-snug text-foreground whitespace-pre-wrap break-words">
          {text}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="trace-list live-trace mt-1 ml-6 list-none m-0 p-0 border-l border-border pl-2">
          {rows.map((row) => (
            <LiveRow key={row.key} row={row} onRespond={onRespondApproval} />
          ))}
        </ul>
      )}
    </div>
  );
}

export function LiveTurnExchange({
  liveTurn,
  onRespondApproval,
}: {
  liveTurn: LiveTurn;
  onRespondApproval: (requestId: string, response: ApprovalResponse) => void;
}) {
  // Group the streamed rows into their rounds (each row carries the Thinking
  // attempt it arrived under, issue #608); a round that has emitted prose or
  // thinking but no calls yet still renders (roundTexts / roundThinkings are
  // slot-indexed by round, null-padded).
  const lastStep = Math.max(
    liveTurn.rows.reduce((m, r) => Math.max(m, r.step), 0),
    liveTurn.roundTexts.length,
    liveTurn.roundThinkings.length,
  );
  const rounds = Array.from({ length: lastStep }, (_, i) => ({
    thinking: liveTurn.roundThinkings[i] ?? undefined,
    text: liveTurn.roundTexts[i] ?? undefined,
    rows: liveTurn.rows.filter((r) => r.step === i + 1),
    onRespondApproval,
  }));
  // The running status reads honestly per phase: while a call dispatches (or
  // waits at the gate) its row carries the motion, so the trailing status
  // steps aside; otherwise the turn is back on an LLM round-trip and the
  // status names it, with the step surfaced past the first round-trip
  // ("step N", ADR-0081).
  const rowInProgress = liveTurn.rows.some((r) => r.running || r.success === null);
  return (
    <div className="live-turn-exchange turn-card rounded-md py-1.5" data-live="true">
      <UserBubble question={liveTurn.question} askedAt={liveTurn.askedAt} isStale={false} />
      <div className="assistant-stream mt-1 flex flex-col items-start">
        {rounds.map((round, i) => (
          <LiveRoundBlock key={i + 1} {...round} />
        ))}
        {!rowInProgress && (
          <p
            className="live-thinking m-0 mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"
            role="status"
          >
            <Loader2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 animate-spin" />
            {liveTurn.step !== null && liveTurn.step > 1 ? (
              <FormattedMessage
                id="thread.live.thinkingStep"
                defaultMessage="Thinking (step {step})…"
                values={{ step: liveTurn.step }}
              />
            ) : (
              <FormattedMessage id="common.thinking" defaultMessage="Thinking…" />
            )}
          </p>
        )}
      </div>
    </div>
  );
}
