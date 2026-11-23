// The in-flight turn's chat exchange (ADR-0103 live isomorphism, issue #610):
// rendered at the thread's tail while a turn runs -- the user bubble mounts
// the moment the user submits (asked_at is the client's submit stamp; the
// question is final at submit, so the copy affordance is honest), over a
// streaming assistant side: the runtime attribution marker (issue #818),
// then the header's dataset chip (issue #620), then the live process face
// (ADR-0151, calibrated by #1656 to the per-round seal): every round before
// the turn tail seals as its own settle-isomorphic block (the LiveRoundBlock
// below -- the thinking fold, the connective prose and a per-tool step-fold
// head, the settled trace round's exact form), and the CURRENT round (the
// tail) alone rides ONE activity line whose face rotates with the phase
// (thinking / running call / the streaming window's running face): its
// calls ride the head's count, its thinking and calls sit in the expand
// face, the running call is absorbed by the head. Prose no longer
// partitions anything -- a turn whose agent never talks still seals each
// finished round as it goes (#1656's motivating window: the old
// prose-keyed boundary let a call-only stretch accumulate unbounded).
//
// The rounds arrive pre-grouped from the state layer's single derivation
// (issue #620) -- this component renders them directly and never regroups.
// The head and the prose skeleton ride the swap-stable TurnExchangeFrame /
// RoundBody -- the modules the settled TurnCard mounts too, so the settle
// swap cannot move a member. Settle swaps this block for the settled
// TurnCard: the activity line yields to the outcome body + closing meta row,
// every sealed round's block keeps verbatim (the swap moves only the line's
// retirement and the turn head), and the expand posture seeds the settled
// turn-level process fold (the landing spot matches -- issue #1606).

import { useState } from "react";
import { useIntl } from "react-intl";
import { FoldToggle } from "./FoldToggle";
import { LiveRow } from "./TraceView";
import { LiveActivityLine } from "./LiveActivityLine";
import { TraceList } from "./TraceList";
import { RoundBody } from "./RoundBody";
import { foldLabel, type DatasetLabel } from "./turn-visual";
import { isSettledRow } from "../../session/useTurnFlow";
import { TurnExchangeFrame } from "./TurnExchangeFrame";
import type { LiveRound, LiveTurn } from "../../session/useTurnFlow";
import type { ApprovalResponse, FileAttachment } from "../../types/approval";

// One live round's block, both postures in one component type (#1656): the
// thinking fold + connective prose ride the SAME RoundBody the settled
// TraceRoundBlock mounts, so the prose never remounts across a round's
// tail->sealed transition (props swap, element type does not). SEALED --
// every round before the turn tail -- its completed calls land behind a
// fold whose head speaks the shared per-tool counts (the settle step
// fold's own foldLabel), the settled trace round's exact form: at the
// swap the block keeps verbatim. The expanded rows keep the live LiveRow
// chrome (the resolved-approval answer badge rides the row until the swap
// retires the approval channel; ADR-0151's always-visible edge), and the
// row's position does not move. Default collapsed (the height governance:
// at most two fold lines per round, no windowing); fold state is
// session-ephemeral and does not seed the settled process fold. The TAIL
// round mounts prose-only -- its calls and thinking are the activity
// line's domain -- and its prose arms the streaming caret while it has no
// rows (the #1236 seal: prose after a call opens the next round).
function LiveRoundBlock({
  round,
  sealed,
  streaming,
  onRespond,
  onLoadAttachments,
}: {
  round: LiveRound;
  sealed: boolean;
  streaming: boolean;
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  /** Pulls the full (uncapped) file values for a pending approval card
   * (issue #1009); optional -- absent loaders keep the capped broadcast
   * snapshot. */
  onLoadAttachments?: (requestId: string) => Promise<FileAttachment[]>;
}) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  const settled = round.rows.filter(isSettledRow);
  return (
    <RoundBody
      thinking={sealed ? round.thinking : undefined}
      text={round.text}
      proseMode={streaming ? "streaming" : "static"}
    >
      {sealed && settled.length > 0 && (
        <>
          <FoldToggle
            hookClass="trace-toggle"
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          >
            {foldLabel(intl, settled)}
          </FoldToggle>
          {expanded && (
            <TraceList>
              {settled.map((row) => (
                <LiveRow
                  key={row.key}
                  row={row}
                  onRespond={onRespond}
                  onLoadAttachments={onLoadAttachments}
                />
              ))}
            </TraceList>
          )}
        </>
      )}
    </RoundBody>
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
  // The seal discriminant (#1656): round index, not prose. A round seals
  // when the turn opens its successor (the tail is the current round, the
  // line's domain); a pending or deny-held card keeps its own round the
  // tail -- the gate hold cannot outlive the round it gates (the provider
  // cannot dispatch past an unresolved approval) -- the index half
  // already excludes every such round, so the settled-rows guard at the
  // call site below is the regression backstop, not a second custody
  // rule. The activity line's faces stay gated by the
  // shared wait predicate (see isRoundTripWait for the honest-liveness
  // reasoning: which arms carry the motion, and why the prose arm
  // requires the tail to BE the current round) -- the thinking phase
  // rides the line's folded face, so the retired trailing status line's
  // duty merged into it.
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
        // The index is a stable key (the rounds array is append-only within
        // a turn and never reordered -- the same YAGNI call the settled
        // trace's round adapter makes). Sealed needs BOTH conjuncts of the
        // #1656 criterion: before the tail (the index half -- sequential
        // rounds make this the normal case) AND fully settled rows (the
        // guard half -- a round that somehow still carries an unsettled
        // row stays unsealed rather than sealing around it: for the tail
        // that keeps the rows in the line's custody, for an earlier round
        // the block goes dark until the settle swap reclaims them.
        // Unreachable today -- a deny completion lands inside its round's
        // lifetime by channel ordering, an abandoned call ends the turn
        // (#1267) -- but the seal never claims a round it cannot show in
        // full).
        <LiveRoundBlock
          key={i}
          round={round}
          sealed={i < tailIndex && round.rows.every(isSettledRow)}
          streaming={i === tailIndex && round.rows.length === 0}
          onRespond={onRespondApproval}
          onLoadAttachments={onLoadApprovalAttachments}
        />
      ))}
      {/* ONE activity line for the whole turn, pinned after the rounds (a
          fresh turn with no rounds yet still mounts it -- the thinking
          face is the turn's first activity): the thinking phase, the
          running call and the streaming window rotate its face; the line
          never leaves the exchange (the turn clock rides it, #1612); its
          fold holds the CURRENT round (#1656's narrowing -- earlier
          rounds sealed above it), carrying the count and the expand face,
          and its expand posture seeds the settled turn-level process fold
          across the settle swap (issue #1606). */}
      <LiveActivityLine
        liveTurn={liveTurn}
        onRespond={onRespondApproval}
        onLoadAttachments={onLoadApprovalAttachments}
        onExpandedChange={onActivityExpandedChange}
      />
      {tailRows.length > 0 && (
        // w-full (not the trace family's max-w-full cap): the stream's
        // items-start makes a bare fit-content item size by its widest
        // row's max-content -- a short pending card shrinks narrower than
        // the rows above it, and a long summary / expanded file value
        // overruns the rail into the overflow-x crop. The card is a
        // bordered decision surface: pinned full width restores the row
        // family's truncate posture (issues #826/#872) for both ends.
        <div className="trace-round w-full">
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
        </div>
      )}
    </TurnExchangeFrame>
  );
}
