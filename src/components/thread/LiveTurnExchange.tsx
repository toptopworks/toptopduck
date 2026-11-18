// The in-flight turn's chat exchange (ADR-0103 live isomorphism, issue #610):
// rendered at the thread's tail while a turn runs -- the user bubble mounts
// the moment the user submits (asked_at is the client's submit stamp; the
// question is final at submit, so the copy affordance is honest), over a
// streaming assistant side: the runtime attribution marker (issue #818),
// then the header's dataset chip (issue #620), then the live process face
// (ADR-0151, the device-calibrated posture): the connective prose blocks +
// ONE activity line whose face rotates with the phase (thinking / running
// call; the streaming tail steps it aside). Rounds segment at prose boundaries; every
// segment sealed by a later prose lands as ONE aggregate fold line under
// its own prose ("Completed · N calls", clickable to the segment's
// thinking folds + call rows) -- one line per sealed stretch, never a
// block per round. The last prose-bearing segment is the line's domain:
// its calls ride the head's count, its thinking and calls sit in the
// line's expand face, the running call is absorbed by the head. A turn
// with no prose section keeps everything in the line (the pre-prose
// posture).
//
// The rounds arrive pre-grouped from the state layer's single derivation
// (issue #620) -- this component renders them directly and never regroups.
// The head and the prose skeleton ride the swap-stable TurnExchangeFrame /
// RoundBody -- the modules the settled TurnCard mounts too, so the settle
// swap cannot move a member. Settle swaps this block for the settled
// TurnCard: the activity line yields to the outcome body + closing meta row,
// the prose blocks keep, and the expand posture seeds the settled turn-level
// process fold (the landing spot matches -- issue #1606). The single
// rotating line is ADR-0151's narrowing of ADR-0078's live-unfolded.

import { Fragment, useState } from "react";
import { useIntl } from "react-intl";
import { FoldToggle } from "./FoldToggle";
import { ThinkingFold } from "./ThinkingFold";
import { LiveRow } from "./TraceView";
import { LiveActivityLine } from "./LiveActivityLine";
import { TraceList } from "./TraceList";
import { RoundBody } from "./RoundBody";
import { isSettledRow } from "../../session/useTurnFlow";
import { TurnExchangeFrame } from "./TurnExchangeFrame";
import type { LiveRound, LiveTurn } from "../../session/useTurnFlow";
import type { ApprovalResponse, FileAttachment } from "../../types/approval";
import { type DatasetLabel } from "./turn-visual";

// The sealed segment's fold line (ADR-0151): everything between two prose
// sections lands as ONE line -- "Completed · N calls" -- clickable to the
// segment's thinking folds + call rows in settle order (the rows on the
// shared left-rail list, the settled face's chrome). One line per sealed
// segment is the progressive feel (a long call-only stretch between two
// prose sections never dumps a block per round); the fold keeps its own
// session-ephemeral state and does not seed the settled process fold.
function RoundSegmentFold({
  rounds,
  onRespond,
  onLoadAttachments,
}: {
  /** The segment's rounds, pre-sliced by the caller -- the fold never
   *  indexes back into the turn's array, so no cross-prop invariant
   *  exists to keep. */
  rounds: LiveRound[];
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  /** Pulls the full (uncapped) file values for a pending approval card
   * (issue #1009); optional -- absent loaders keep the capped broadcast
   * snapshot. */
  onLoadAttachments?: (requestId: string) => Promise<FileAttachment[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  const callCount = rounds.reduce(
    (n, round) => n + round.rows.filter(isSettledRow).length,
    0,
  );
  return (
    <div className="trace-round max-w-full">
      <FoldToggle hookClass="round-toggle" expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
        {intl.formatMessage(
          {
            id: "thread.trace.roundCompleted",
            defaultMessage: "Completed · {count, plural, one {# call} other {# calls}}",
          },
          { count: callCount },
        )}
      </FoldToggle>
      {expanded &&
        rounds.map((round, i) => {
          const rows = round.rows.filter(isSettledRow);
          return (
            <Fragment key={i + 1}>
              {round.thinking !== undefined && <ThinkingFold thinking={round.thinking} />}
              {rows.length > 0 && (
                <TraceList>
                  {rows.map((row) => (
                    <LiveRow
                      key={row.key}
                      row={row}
                      onRespond={onRespond}
                      onLoadAttachments={onLoadAttachments}
                    />
                  ))}
                </TraceList>
              )}
            </Fragment>
          );
        })}
    </div>
  );
}

export function LiveTurnExchange({
  liveTurn,
  mentionedDataset,
  onRespondApproval,
  onLoadApprovalAttachments,
  onActivityExpandedChange,
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
   * snapshot. Threaded to each row's LiveRow. */
  onLoadApprovalAttachments?: (requestId: string) => Promise<FileAttachment[]>;
  /** Reports the activity line's toggle posture (issue #1606): an expanded
   *  line seeds the settled turn-level process fold across the settle swap
   *  -- the process face the user was reading lands open at the same spot. */
  onActivityExpandedChange: (expanded: boolean) => void;
}) {
  // The activity line's faces are gated by the shared wait predicate (see
  // isRoundTripWait for the honest-liveness reasoning: which arms carry the
  // motion, and why the prose arm requires the tail to BE the current
  // round) -- the thinking phase rides the line's folded face, so the
  // retired trailing status line's duty merged into it.
  const tailIndex = liveTurn.rounds.length - 1;
  // The turn-tail rows that stay OUTSIDE every fold (ADR-0083's flow face):
  // the gate-pending approval cards, plus the terminal-approved rows whose
  // calls never completed -- a gate-denied call between its optimistic
  // resolve and the gateway's completion event, an abandoned call forever
  // (#1267). The fold faces admit only settled rows, so this tail is the
  // one surface keeping those answer markers visible; a running approved
  // call is the activity line's to absorb (the head or its expand face),
  // not a tail row.
  const tailRows = liveTurn.rounds
    .flatMap((round) => round.rows)
    .filter(
      (row) =>
        row.approval !== null &&
        !isSettledRow(row) &&
        (row.approval.response === null || !row.running),
    );
  // Segment the rounds at prose boundaries: a round with text opens a
  // segment; call-only rounds join the one before (leading call-only
  // rounds form a prose-less head segment). The last prose-bearing
  // segment is the activity line's domain; every segment BEFORE it is
  // sealed -- it lands as ONE aggregate fold line under its own prose
  // (the device ruling: one line per sealed stretch, never a block per
  // round). The segments carry their rounds pre-sliced.
  const segments: { proseRound: number; rounds: LiveRound[] }[] = [];
  liveTurn.rounds.forEach((round, i) => {
    const last = segments[segments.length - 1];
    if (round.text !== undefined || last === undefined) {
      segments.push({ proseRound: round.text !== undefined ? i : -1, rounds: [round] });
    } else {
      last.rounds.push(round);
    }
  });
  const lastProseSegment = segments.reduce(
    (last, segment, k) => (segment.proseRound >= 0 ? k : last),
    -1,
  );
  return (
    <TurnExchangeFrame
      question={liveTurn.question}
      askedAt={liveTurn.askedAt}
      invokedSkills={liveTurn.invocationNames}
      runtime={liveTurn.runtime}
      mentionedDataset={mentionedDataset}
      live
    >
      {segments.map((segment, k) => {
        const proseRound =
          segment.proseRound >= 0 ? liveTurn.rounds[segment.proseRound] : undefined;
        return (
          <Fragment key={k + 1}>
            {proseRound !== undefined && (
              // The caret rule rides the prose round: streaming only while
              // it is the tail with no rows (the same seal discriminant
              // the round-trip-wait predicate reads, issue #1236);
              // everything else is static.
              <RoundBody
                text={proseRound.text}
                proseMode={
                  segment.proseRound === tailIndex && proseRound.rows.length === 0
                    ? "streaming"
                    : "static"
                }
              />
            )}
            {k < lastProseSegment && (
              <RoundSegmentFold
                rounds={segment.rounds}
                onRespond={onRespondApproval}
                onLoadAttachments={onLoadApprovalAttachments}
              />
            )}
          </Fragment>
        );
      })}
      {/* ONE activity line for the whole turn, pinned after the rounds (a
          fresh turn with no rounds yet still mounts it -- the thinking
          face is the turn's first activity): the thinking phase, the
          running call rotate its face, the streaming tail steps it aside;
          its fold
          holds the rounds after the last prose section (the count, the
          expand face) and its expand posture seeds the settled turn-level
          process fold across the settle swap (issue #1606). */}
      <LiveActivityLine
        liveTurn={liveTurn}
        onRespond={onRespondApproval}
        onLoadAttachments={onLoadApprovalAttachments}
        onExpandedChange={onActivityExpandedChange}
      />
      {tailRows.length > 0 && (
        <TraceList>
          {tailRows.map((row) => (
            <LiveRow
              key={row.key}
              row={row}
              onRespond={onRespondApproval}
              onLoadAttachments={onLoadApprovalAttachments}
            />
          ))}
        </TraceList>
      )}
    </TurnExchangeFrame>
  );
}
