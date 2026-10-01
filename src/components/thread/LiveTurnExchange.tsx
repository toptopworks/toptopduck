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
// The head and the round skeleton ride the swap-stable TurnExchangeFrame /
// RoundBody -- the modules the settled TurnCard mounts too, so the settle
// swap cannot move a member. Settle swaps this block for the settled
// TurnCard: liveRoundsToTrace folds the same rounds into the optimistic
// TurnRecord.trace; the running status row yields to the outcome body +
// closing meta row, and the streamed rows fold behind the per-round step fold
// (the settled default posture, ADR-0078). A thinking fold the user opened
// while live mounts already open on the settled side via the
// onThinkingExpandedChange report (issue #620).

import { FormattedMessage } from "react-intl";
import { useCallback } from "react";
import { Loader2 } from "lucide-react";
import { LiveRow } from "./TraceView";
import { TraceList } from "./TraceList";
import { RoundBody } from "./RoundBody";
import type { RoundProseMode } from "./RoundProse";
import { TurnExchangeFrame } from "./TurnExchangeFrame";
import type { LiveRound, LiveTurn } from "../../session/useTurnFlow";
import type { ApprovalResponse, FileAttachment } from "../../types/approval";
import type { ThinkingTrace } from "../../types/thread";
import type { DatasetLabel } from "./turn-visual";

// One live round: the skeleton rides RoundBody (see its header for the swap
// contract); this adapter owns the round's tool rows -- streaming UNFOLDED,
// where the settled posture folds them (ADR-0078): streaming calls must be
// visible as they land.
function LiveRoundBlock({
  round,
  proseMode,
  onRespondApproval,
  onLoadApprovalAttachments,
  onThinkingExpandedChange,
}: {
  round: LiveRound;
  /** The caret is the round-is-alive signal (RoundProse's streaming
   *  contract), and only the tail round is alive -- the rounds array is
   *  append-only, so every earlier round's text is final and renders
   *  static (caret off, cascade off, its fences decode). */
  proseMode: RoundProseMode;
  onRespondApproval: (requestId: string, response: ApprovalResponse) => void;
  onLoadApprovalAttachments?: (requestId: string) => Promise<FileAttachment[]>;
  onThinkingExpandedChange: (thinking: ThinkingTrace, expanded: boolean) => void;
}) {
  const { thinking, text, rows } = round;
  // useCallback so the fold's report effect does not re-fire on an unrelated
  // parent re-render (the identity must only change with the thinking block);
  // the report passes the reference (the settle seed's key).
  const reportThinkingExpanded = useCallback(
    (expanded: boolean) => thinking !== undefined && onThinkingExpandedChange(thinking, expanded),
    [thinking, onThinkingExpandedChange],
  );
  return (
    <RoundBody
      thinking={thinking}
      text={text}
      proseMode={proseMode}
      onThinkingExpandedChange={reportThinkingExpanded}
    >
      {rows.length > 0 && (
        <TraceList>
          {rows.map((row) => (
            <LiveRow
              key={row.key}
              row={row}
              onRespond={onRespondApproval}
              onLoadAttachments={onLoadApprovalAttachments}
            />
          ))}
        </TraceList>
      )}
    </RoundBody>
  );
}

export function LiveTurnExchange({
  liveTurn,
  mentionedDataset,
  onRespondApproval,
  onLoadApprovalAttachments,
  onThinkingExpandedChange,
}: {
  liveTurn: LiveTurn;
  /** The dataset the question explicitly names (the same findMentionedDataset
   *  read the settled header performs, computed by the thread) -- rendered
   *  here so the settle swap does not insert the chip (issue #620). null
   *  when the question names none. */
  mentionedDataset: DatasetLabel | null;
  onRespondApproval: (requestId: string, response: ApprovalResponse) => void;
  /** Pulls the full (uncapped) file values for a pending approval card
   * (issue #1009); optional -- absent loaders keep the capped broadcast
   * snapshot. Threaded to each round's LiveRow. */
  onLoadApprovalAttachments?: (requestId: string) => Promise<FileAttachment[]>;
  /** Reports each thinking-fold toggle with the block's reference (the key
   *  the settle seed matches on -- the projection carries the same
   *  reference onto the settled round). */
  onThinkingExpandedChange: (thinking: ThinkingTrace, expanded: boolean) => void;
}) {
  // The running status reads honestly only while NOTHING else on the tail
  // carries the turn's liveness: while a call dispatches (or waits at the
  // gate) its row carries the motion, and once #1163 streams the tail round's
  // prose the visible text + caret carry it by themselves -- a spinner still
  // claiming 思考中 over visibly streaming text is a doubled, misleading
  // signal. Only when both step aside (ask start, and each new round's
  // pre-prose thinking) is the turn back on an LLM round-trip the status
  // names, with the step surfaced past the first round-trip ("step N",
  // ADR-0081).
  const rowInProgress = liveTurn.rounds.some((round) =>
    round.rows.some((row) => row.running || row.success === null),
  );
  const tailIndex = liveTurn.rounds.length - 1;
  const tailProseVisible = liveTurn.rounds[tailIndex]?.text !== undefined;
  return (
    <TurnExchangeFrame
      question={liveTurn.question}
      askedAt={liveTurn.askedAt}
      invokedSkills={liveTurn.invocationNames}
      runtime={liveTurn.runtime}
      mentionedDataset={mentionedDataset}
      live
    >
      {liveTurn.rounds.map((round, i) => (
        // The rounds array is append-only within a turn (round i is round
        // i+1), so the index is a stable key.
        <LiveRoundBlock
          key={i + 1}
          round={round}
          proseMode={i === tailIndex ? "streaming" : "static"}
          onRespondApproval={onRespondApproval}
          onLoadApprovalAttachments={onLoadApprovalAttachments}
          onThinkingExpandedChange={onThinkingExpandedChange}
        />
      ))}
      {!rowInProgress && !tailProseVisible && (
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
    </TurnExchangeFrame>
  );
}
