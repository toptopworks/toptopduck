// The in-flight turn's chat exchange (ADR-0103 live isomorphism, issue #610):
// rendered at the thread's tail while a turn runs -- the user bubble mounts
// the moment the user submits (asked_at is the client's submit stamp; the
// question is final at submit, so the copy affordance is honest), over a
// streaming assistant side: the runtime attribution marker (issue #818),
// then the header's dataset chip (issue #620), then per-round thinking
// folds + connective prose + tool rows (approval cards in
// flow, ADR-0083 -- the card chrome lives in LiveRow, semantics unchanged
// from the retired progressive card).
//
// The rounds arrive pre-grouped from the state layer's single derivation
// (issue #620) -- this component renders them directly and never regroups.
// The prose / trace-list chrome / thinking fold / active chip ride the shared
// components the settled form uses, so the settle swap cannot move them.
// Settle swaps this block for the settled TurnCard: liveRoundsToTrace folds
// the same rounds into the optimistic TurnRecord.trace; the running status
// row yields to the outcome body + closing meta row, and the streamed rows
// fold behind the per-round step fold (the settled default posture,
// ADR-0078). A thinking fold the user opened while live mounts already open
// on the settled side via the onThinkingExpandedChange report (issue #620).

import { FormattedMessage } from "react-intl";
import { useCallback, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { UserBubble } from "./UserBubble";
import { LiveRow } from "./TraceView";
import { RoundProse } from "./RoundProse";
import { TraceList } from "./TraceList";
import { ThinkingFold } from "./ThinkingFold";
import { StreamHeader } from "./StreamHeader";
import { TurnActiveChip } from "./TurnActiveChip";
import { RuntimeAttributionMarker } from "./RuntimeAttributionMarker";
import type { LiveRound, LiveTurn } from "../../session/useTurnFlow";
import type { ApprovalResponse } from "../../types/approval";
import type { ThinkingTrace } from "../../types/thread";
import { runtimeMarkerName, type DatasetLabel } from "./turn-visual";

// One live round: the thinking fold + connective prose render exactly as the
// settled TraceRoundBlock renders them (isomorphism -- the settle swap must
// not move them); the round's rows stream UNFOLDED -- the step fold is the
// settled posture, but streaming calls must be visible as they land.
function LiveRoundBlock({
  round,
  onRespondApproval,
  onThinkingExpandedChange,
}: {
  round: LiveRound;
  onRespondApproval: (requestId: string, response: ApprovalResponse) => void;
  onThinkingExpandedChange: (thinking: ThinkingTrace, expanded: boolean) => void;
}) {
  // Destructured const so the aliased guard narrows the binding itself; the
  // fold's posture report passes the reference (the settle seed's key).
  const { thinking, text, rows } = round;
  // useCallback so the fold's report effect does not re-fire on an unrelated
  // parent re-render (the identity must only change with the thinking block).
  const reportThinkingExpanded = useCallback(
    (expanded: boolean) => thinking !== undefined && onThinkingExpandedChange(thinking, expanded),
    [thinking, onThinkingExpandedChange],
  );
  const hasThinking = thinking !== undefined;
  if (!hasThinking && text === undefined && rows.length === 0) {
    return null;
  }
  return (
    <div className="trace-round">
      {hasThinking && (
        <ThinkingFold thinking={thinking} onExpandedChange={reportThinkingExpanded} />
      )}
      {text !== undefined && <RoundProse text={text} />}
      {rows.length > 0 && (
        <TraceList>
          {rows.map((row) => (
            <LiveRow key={row.key} row={row} onRespond={onRespondApproval} />
          ))}
        </TraceList>
      )}
    </div>
  );
}

export function LiveTurnExchange({
  liveTurn,
  mentionedDataset,
  onRespondApproval,
  onThinkingExpandedChange,
  agentHead,
}: {
  liveTurn: LiveTurn;
  /** The dataset the question explicitly names (the same findMentionedDataset
   *  read the settled header performs, computed by the thread) -- rendered
   *  here so the settle swap does not insert the chip (issue #620). null
   *  when the question names none. */
  mentionedDataset: DatasetLabel | null;
  onRespondApproval: (requestId: string, response: ApprovalResponse) => void;
  /** Reports each thinking-fold toggle with the block's reference (the key
   *  the settle seed matches on -- the projection carries the same
   *  reference onto the settled round). */
  onThinkingExpandedChange: (thinking: ThinkingTrace, expanded: boolean) => void;
  /** D5 / issue #722: the agent activations that happened inside this
   *  (still-running) turn, rendered at the head of the assistant stream --
   *  the same slot the settled TurnCard's agentHead occupies, so the settle
   *  swap re-hosts them without moving them. undefined when the turn owns
   *  none. */
  agentHead?: ReactNode;
}) {
  // The running status reads honestly per phase: while a call dispatches (or
  // waits at the gate) its row carries the motion, so the trailing status
  // steps aside; otherwise the turn is back on an LLM round-trip and the
  // status names it, with the step surfaced past the first round-trip
  // ("step N", ADR-0081).
  const rowInProgress = liveTurn.rounds.some((round) =>
    round.rows.some((row) => row.running || row.success === null),
  );
  // Issue #818: the per-turn runtime attribution, from the ask-time choice
  // riding the live state (absent until the read lands / on failure -- no
  // marker, the same silent degrade as the append's omitted runtime).
  const runtimeName = runtimeMarkerName(liveTurn.runtime);
  return (
    <div className="live-turn-exchange turn-card rounded-md py-1.5" data-live="true">
      <UserBubble question={liveTurn.question} askedAt={liveTurn.askedAt} isStale={false} />
      <div className="assistant-stream mt-1 flex flex-col items-start">
        {/* Issue #818: the runtime attribution opens the stream in the same
            first-child slot the settled TurnCard renders -- a marker the
            live side has is re-hosted in place at the settle swap (#620);
            a read landing only after the settle lets the settled card add
            it. */}
        {runtimeName !== null && <RuntimeAttributionMarker adapterId={runtimeName} />}
        {/* D5 / issue #722: agent activations open the stream, the same
            slot (and order) the settled TurnCard's agentHead occupies, so
            the settle swap does not move them. */}
        {agentHead}
        {mentionedDataset !== null && (
          // The stream header opens with the dataset chip only -- the settled
          // header may add skill-drift badges at settle, but the chip itself
          // must already be here so the swap adds no element (issue #620).
          <StreamHeader>
            <TurnActiveChip dataset={mentionedDataset} />
          </StreamHeader>
        )}
        {liveTurn.rounds.map((round, i) => (
          // The rounds array is append-only within a turn (round i is round
          // i+1), so the index is a stable key.
          <LiveRoundBlock
            key={i + 1}
            round={round}
            onRespondApproval={onRespondApproval}
            onThinkingExpandedChange={onThinkingExpandedChange}
          />
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
