// The live activity line (issue #1606, ADR-0151; clock re-host #1612): the
// turn's activity face in TWO rows (issue #1661). The ACTIVITY row sits
// above -- the current activity on its own line: the running call's verb +
// its summary, the thinking stream's latest completed line (right-edge
// fade), or -- between calls -- the turn's most recent completed call (the
// linger, holding the row steady through gaps and round boundaries, yet
// yielding while prose streams -- the caret is the streaming's own
// liveness, and a present-tense verb over prose + caret claims a call that
// is not running, #1663); hidden while expanded (the expand face owns both
// signals at full width), absent when prose streams or nothing reports --
// no call, no excerpt, no completed call to linger on. The
// STATUS row sits below -- the phase verb ("Thinking (step n)" /
// "Running (step n)", rotating honestly with the phase) + the elapsed
// figure, whose only host this row has been since the composer wait slot
// retired (#1264's ruling re-hosted). The split is structural: the excerpt
// clips and fades itself (self-painted), and a descendant's overflow/mask
// cannot clip the ancestor shimmer's background-clip:text glyph painting --
// sharing the status row put the excerpt's tail under the elapsed figure
// (the overlap #1661 retires). The phase timing machinery (the tool verb's
// entry-immediate / switch-throttled / hold-past-last-call windows) paces
// the ACTIVITY row; the status row reads only the phase, so it can never
// blink inside a burst. The line's fold holds the CURRENT round only
// (#1656's narrowing of the #1606 domain): the turn tail -- its completed
// calls feed the activity row's linger, its thinking + calls sit in the
// expand face, the running call is absorbed by the activity row. Every
// earlier round seals as its own settle-isomorphic block in the exchange,
// NOT here; prose no longer partitions the two.
// With nothing behind the fold -- no thinking, no settled or running row
// in the line's rounds (a lone pending card does not count: the card
// renders at the tail, outside the fold) -- the line is a plain status
// line: no hover, no click (the user ruling). The expand posture seeds
// the settled turn-level process fold across the swap.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { FoldToggle } from "./FoldToggle";
import { ThinkingFold } from "./ThinkingFold";
import { THINKING_TEXT_CLASS } from "./thinkingTextStyles";
import { LiveRow } from "./TraceView";
import { TraceList } from "./TraceList";
import { WaitElapsedSuffix } from "./WaitElapsedSuffix";
import { isRoundTripWait, isSettledRow, thinkingHeadExcerpt } from "../../session/useTurnFlow";
import type { ApprovalResponse, ParamValue, OperationKind } from "../../types/approval";
import type { LiveTurn } from "../../session/useTurnFlow";

// The head's activity verb: the progressive face of the operation kind (the
// `thread.trace.op.*` noun family). Exhaustiveness guard mirrors the Rust
// match (the settled operationLabel's convention).
function liveVerbLabel(intl: IntlShape, kind: OperationKind): string {
  switch (kind) {
    case "read":
      return intl.formatMessage({
        id: "thread.trace.liveVerb.read",
        defaultMessage: "Reading",
      });
    case "write":
      return intl.formatMessage({
        id: "thread.trace.liveVerb.write",
        defaultMessage: "Writing",
      });
    case "execute":
      return intl.formatMessage({
        id: "thread.trace.liveVerb.execute",
        defaultMessage: "Executing",
      });
    case "network":
      return intl.formatMessage({
        id: "thread.trace.liveVerb.network",
        defaultMessage: "Networking",
      });
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled operation kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

// The tool-face window: the verb-switch throttle AND the hold past the
// last call share one window. Calls shorter than the window still paint
// the face (entry is immediate) -- they just never churn the verb.
const FACE_WINDOW_MS = 600;

// How close (px) to a scroll region's bottom counts as "at the tail" for
// the streaming block's follower: inside the slack the pin stays armed,
// past it the reader has scrolled up to read and the stream keeps growing
// below the viewport without dragging it.
const FOLLOW_SLACK_PX = 4;

export function LiveActivityLine({
  liveTurn,
  onRespond,
  onLoadParamValues,
  onExpandedChange,
}: {
  liveTurn: LiveTurn;
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  /** Passed through to the expand face's running rows (issue #1009). */
  onLoadParamValues?: (requestId: string) => Promise<ParamValue[]>;
  /** Reports the line's posture whenever it changes (mount included) --
   *  the collector no-ops a report matching its current state. Pass a
   *  stable callback: the report effect re-fires on identity churn
   *  otherwise. The effect deliberately has no cleanup: unmounting must
   *  NOT re-report, or the settle seed would read the last posture wrong
   *  -- leave the report un-cleaned. */
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  useEffect(() => {
    onExpandedChange(expanded);
  }, [expanded, onExpandedChange]);
  const allRows = liveTurn.rounds.flatMap((round) => round.rows);
  // The line's round: the CURRENT round only -- the turn tail (#1656's
  // narrowing of the #1606 domain). Every earlier round seals as its own
  // settle-isomorphic block in the exchange, so the head's activity reads
  // the tail round's rows and the expand face renders it alone. The tail
  // stays the line's through the round-trip wait -- the settle swap is
  // what retires the line, so the domain needs no other boundary.
  const tailRound = liveTurn.rounds.at(-1);
  const lineRows = tailRound?.rows ?? [];
  // The streaming thinking block's scroll follower (issue #1669): deltas
  // append into a max-h-48 overflow-y-auto region, so once the stream
  // outgrows the cap the scrollbar sits at the top while the text grows
  // below the fold.
  // The follower re-pins the viewport to the tail after every append --
  // armed at the element's mount and whenever the region reads "at the
  // tail", released the moment the reader scrolls up (the pin never fights
  // a reader; scrolling back to the tail re-arms it). The pin itself lands
  // the region at its tail, so its own scroll event re-reads as armed.
  const streamRef = useRef<HTMLParagraphElement | null>(null);
  const followTailRef = useRef(true);
  // The mount arm (stable identity -- an inline callback would re-fire per
  // render and resurrect a released pin on every append): a fresh stream
  // face follows from its first paint, and a previous round's released pin
  // must not leak into the round-boundary remount.
  const mountStreamRef = useCallback((el: HTMLParagraphElement | null) => {
    streamRef.current = el;
    if (el !== null) followTailRef.current = true;
  }, []);
  useEffect(() => {
    const el = streamRef.current;
    if (el !== null && followTailRef.current) el.scrollTop = el.scrollHeight;
  }, [expanded, tailRound?.thinkingText]);
  // The stickiness read the region's scroll events run: past the slack the
  // reader has scrolled up and the follower releases; at the tail it
  // re-arms.
  const updateTailPin = () => {
    const el = streamRef.current;
    if (el === null) return;
    followTailRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
  };
  const running = allRows.find((row) => row.running);
  // The gate hold (an approval-channel row the gateway has not completed):
  // the activity line KEEPS the tool face while a resolved row awaits its
  // completion event (a deny between its optimistic resolve and the
  // gateway's completed broadcast) or an abandoned call rides the turn
  // forever (#1267) -- those rows are not settled, so the fold faces admit
  // none of them and the held face plus the tail badge row are their
  // surfaces. A pending card's window is the exception: pendingHold below
  // yields the row to the card, which speaks for the call verbatim. The
  // verb names the held row's own kind -- a denial's completion is a
  // network window away.
  const heldRow = allRows.find(
    (row) => row.approval !== null && !isSettledRow(row) && !row.running,
  );
  const gateHold = !running && heldRow !== undefined;
  // The pending-gate hold (a three-button card waits on the tail): the
  // tool row's verb · summary would paint the held call twice back to
  // back -- the card below names the same tool, badge, and summary
  // verbatim -- so the row yields and the status row alone carries the
  // line's liveness (the breathing dot and the frozen figure never leave,
  // which answers the keep-the-face ruling's process-dying concern). The
  // deny-held / abandoned windows keep the row: no card stands on the
  // tail there, and the row is the held call's only face. While this row
  // is away the decision ask is announced by the card's own role="status"
  // hint (issue #1368). The predicate reads the rows directly instead of
  // riding heldRow: the card renders for any unsettled response-null row,
  // and heldRow's !running term would let a pending row that also runs
  // (a started event landing while the ask is unresolved) skip the hold
  // and stack the verb row above the card.
  const pendingHold = allRows.some(
    (row) =>
      row.approval !== null &&
      row.approval.response === null &&
      !isSettledRow(row),
  );
  const toolKind: OperationKind | undefined =
    running?.operationKind ?? (gateHold ? heldRow?.operationKind : undefined);
  const waiting = isRoundTripWait(liveTurn);
  // The activity row's subject: the running call, a gate-held call, or --
  // between calls -- the turn's most recent completed call. While a call
  // runs or a gate holds, the subject stays on THAT row: an empty summary
  // renders the verb alone, never the previous call's summary under this
  // call's verb. The linger claims the row only between calls, keeping it
  // steady through the gaps AND across round boundaries (a round
  // completion seals the finished rounds above the line; the row holds
  // instead of blinking away, and a call's summary still shows through
  // the gap that follows it). The summary arrives whole with the call's
  // start event and shows from the moment the call runs -- no per-delta
  // churn, no completion-event wait.
  const lastSettled = [...allRows].reverse().find(isSettledRow);
  const activeRow = running ?? (gateHold ? heldRow : undefined);
  const subject = [activeRow, activeRow === undefined ? lastSettled : undefined].find(
    (row) => row !== undefined && row.summary !== "",
  );
  // The tool face's presence and verb, one piece of state: faceKind is the
  // verb while the face shows the tool side, undefined while the thinking
  // face or nothing owns the line. Three device-calibrated timings, one
  // window:
  //   ENTRY    -- the first call (or the gate hold's pending kind) paints
  //              the tool face at once: activity swallowed into the
  //              thinking face read as a dead line on the device.
  //   THROTTLE -- a kind switch repaints the verb at most once per window:
  //              calls flashing a fresh verb each read as flicker; a
  //              short call just moves the count.
  //   GRACE    -- the face holds one window past its last evidence: a
  //              call that just finished must not blink the line off,
  //              and the wait's thinking face reads seconds long anyway.
  // Commits fire from the timeout callback or render-adjust (the React
  // "adjust state on a prop change" pattern), never the effect body (the
  // set-state-in-effect rule).
  const [faceKind, setFaceKind] = useState<OperationKind | undefined>(undefined);
  if (
    !waiting &&
    toolKind !== undefined &&
    (faceKind === undefined || (gateHold && faceKind !== toolKind))
  ) {
    setFaceKind(toolKind);
  }
  useEffect(() => {
    if (faceKind === undefined) return;
    if (toolKind !== undefined && !gateHold && toolKind !== faceKind) {
      // Throttle: hold the current verb one window per kind switch.
      const timer = setTimeout(() => setFaceKind(toolKind), FACE_WINDOW_MS);
      return () => clearTimeout(timer);
    }
    if (toolKind === undefined) {
      // Grace: hold the tool face one window past the last call.
      const timer = setTimeout(() => setFaceKind(undefined), FACE_WINDOW_MS);
      return () => clearTimeout(timer);
    }
  }, [toolKind, faceKind, gateHold, waiting]);
  // The prose-streaming window: no call running, no gate hold, no held
  // face, not the wait -- the tail round's prose + caret carry the
  // streaming's own liveness, so the face does NOT claim thinking over
  // visibly growing text (an output face beside streaming prose doubled
  // the signal and flipped against the thinking face as the stream paused
  // -- the device ruling). The line itself no longer steps aside (#1612's
  // narrowing of ADR-0151): what let it yield was the thinking face's
  // duplicate signal; the running face + the turn clock do not reproduce
  // it, and the clock must stay continuous across the whole turn.
  const streaming = !waiting && toolKind === undefined && faceKind === undefined;
  // The thinking head's excerpt (issue #1658, re-housed #1661): only on the
  // activity row's thinking phase -- the tool phase keeps its own words, and
  // a round-trip wait without a source-bearing runtime keeps the status
  // words alone (thinkingText undefined, excerpt "" -- honest degrade). Read
  // off the tail round's live thinking stream; the frozen block (thinking)
  // takes the excerpt back at the seal (its excerpt would be stale-mid-round).
  const thinkingExcerpt =
    waiting && tailRound?.thinking === undefined
      ? thinkingHeadExcerpt(tailRound?.thinkingText ?? "")
      : "";
  // Expandable only when something sits behind the fold (the user ruling:
  // a line with nothing to show on expand is a plain status line -- no
  // hover, no click): the tail round's thinking (frozen or streaming,
  // issue #1658), or any settled/running row.
  const canExpand =
    tailRound !== undefined &&
    (tailRound.thinking !== undefined ||
      tailRound.thinkingText !== undefined ||
      tailRound.rows.some((row) => isSettledRow(row) || row.running));
  // The expand face's rows: the settled + running members of the tail
  // round (the running call unfurls in place; thinking rides its own
  // fold inside the face).
  const faceRows = lineRows.filter((row) => isSettledRow(row) || row.running);
  // The phase read: the damped faceKind names the running phase (its GRACE
  // window keeps the phase steady across burst gaps); the prose-streaming
  // window runs too; the round-trip wait thinks. Honest rotation -- the
  // status row never says "Thinking" while a call runs.
  const runningPhase = faceKind !== undefined || streaming;
  // The activity row (issue #1661): the current activity ABOVE the status
  // row, full-bleed on the line. Fixed anatomy -- a stable label, a
  // separator, then the content: while the kind holds, the label never
  // repaints; only the content after it moves. The tool phase labels with
  // the damped verb and shows the CURRENT call's summary -- gate hold
  // previews the held call the same way; a summary-less call shows the
  // verb alone (never the previous call's summary under this call's verb).
  // Between calls the row lingers on the turn's most recent completed
  // call, and a call's summary -- which lands whole with its start event,
  // showing from the moment the call runs -- still shows through the gaps
  // that follow it; the streaming window is not one of those gaps (the
  // row yields to the caret there, #1663). The thinking phase labels with
  // the settled thinking fold's own word so the live row and its settle
  // shape read as the same line, and streams the latest completed
  // paragraph. Everything rides ONE
  // self-painted span -- gradient, clip, and fade must own the element
  // they paint (a descendant's overflow/mask cannot clip the ancestor
  // shimmer's glyph painting), and one span keeps the label inside the
  // opaque zone with the fade at the row's true right edge. Hidden while
  // expanded (the expand face owns both signals at full width); absent
  // only when prose streams (the linger yields to the caret -- a
  // present-tense verb over streaming prose claims a call that is not
  // running, #1663) or when nothing reports (no face, no linger, no
  // excerpt), or when a pending card owns the held call's face
  // (pendingHold -- the card speaks for the call verbatim, so painting
  // both is the stacked face this retires; the status row keeps the
  // liveness). The tool-form row STAYS announced --
  // verb + summary is low-frequency state (what ran / is running), not
  // decoration; only the thinking row is aria-hidden: per-line churn is
  // decoration riding the status row's own announcement (the
  // WaitElapsedSuffix doctrine), never a stream of its own.
  let activityRow: ReactNode = null;
  if (!expanded && !pendingHold) {
    const subjectSummary = subject?.summary ?? "";
    if (faceKind !== undefined) {
      activityRow = (
        <div className="activity-preview-row flex items-center text-[13px] text-muted-foreground">
          <span
            className={
              subjectSummary !== ""
                ? "activity-shimmer thinking-head-excerpt"
                : "activity-shimmer"
            }
          >
            {liveVerbLabel(intl, faceKind)}
            {subjectSummary !== "" && <>{" · "}{subjectSummary}</>}
          </span>
        </div>
      );
    } else if (thinkingExcerpt !== "") {
      activityRow = (
        <div
          aria-hidden="true"
          className="activity-preview-row flex items-center text-[13px] text-muted-foreground"
        >
          <span className="activity-shimmer thinking-head-excerpt">
            <FormattedMessage id="thread.live.thinkingLabel" defaultMessage="Thinking" />
            {" · "}
            {thinkingExcerpt}
          </span>
        </div>
      );
    } else if (subject !== undefined && !streaming) {
      activityRow = (
        <div className="activity-preview-row flex items-center text-[13px] text-muted-foreground">
          <span className="activity-shimmer thinking-head-excerpt">
            {liveVerbLabel(intl, subject.operationKind)}
            {" · "}
            {subject.summary}
          </span>
        </div>
      );
    }
  }
  // The status row's face content, shared by both postures (the fold toggle
  // and the plain status line): the breathing dot + the shimmer sweeping the
  // phase verb and the elapsed figure together (the running visual lives in
  // styles.css's .activity-live-dot / .activity-shimmer, one shared 2.4s
  // period). The verb reads ONLY the phase -- the count lives on the
  // activity row, so a brief call ticks there without repainting this row.
  // The figure sits at ONE tail position in every posture and phase: the
  // ask stamp derives the elapsed seconds, so the clock never resets across
  // a face rotation or a posture flip (the #1612 re-host of the #1264 turn
  // clock).
  const face = (
    <>
      <span aria-hidden="true" className="activity-live-dot shrink-0" />
      <span className="activity-shimmer">
        {runningPhase ? (
          liveTurn.step !== null && liveTurn.step > 1 ? (
            <FormattedMessage
              id="thread.live.runningStepLead"
              defaultMessage="Running (step {step})"
              values={{ step: liveTurn.step }}
            />
          ) : (
            <FormattedMessage id="thread.live.runningLead" defaultMessage="Running" />
          )
        ) : liveTurn.step !== null && liveTurn.step > 1 ? (
          <FormattedMessage
            id="thread.live.thinkingStepLead"
            defaultMessage="Thinking (step {step})"
            values={{ step: liveTurn.step }}
          />
        ) : (
          <FormattedMessage id="thread.live.thinkingLead" defaultMessage="Thinking" />
        )}
        <WaitElapsedSuffix startedAt={liveTurn.askedAt} pausedSince={liveTurn.pausedSince} />
      </span>
    </>
  );
  return (
    <>
      {canExpand ? (
        <FoldToggle
          hookClass="process-toggle"
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          className="mt-2 max-w-full gap-1.5 text-[13px]"
          chevronSide="right"
          above={activityRow}
        >
          {face}
        </FoldToggle>
      ) : (
        // The plain status face: the same layout minus the fold chrome --
        // no chevron, no hover, no click, nothing to expand (the user
        // ruling). The hook class stays as the test anchor. Both postures
        // carry max-w-full: the exchange stream is items-start, so a
        // fit-content head sizes by the nowrap excerpt's max-content and
        // overruns the rail into the overflow-x crop (the tail-card pin's
        // same family, #826/#872) -- the clamp lets a long summary's
        // self-clip and fade engage at the rail's true right edge instead.
        // Both postures also widen the row gap past the fold chrome's
        // default and step the whole line down to the 13px tier: the head
        // hosts only the activity row and the status row, so the root's
        // text-[13px] retiers the status face, and the activity row's own
        // branches carry the same class -- the line reads as one 13px
        // chrome pair beside the 14px prose, never a second body line.
        <div className="process-toggle mt-2 max-w-full flex flex-col items-stretch gap-1.5 text-[13px] text-muted-foreground">
          {activityRow}
          <div className="flex items-center gap-1">{face}</div>
        </div>
      )}
      {expanded && tailRound !== undefined && (
        // The fold's face: the CURRENT round only (#1656's narrowing --
        // every earlier round seals as its own block in the exchange
        // above, never here). The thinking fold first, then the settled +
        // running rows on the shared left-rail list (the settled face's
        // chrome); the running call unfurls in place.
        <div className="trace-round max-w-full">
          {tailRound.thinking !== undefined ? (
            <ThinkingFold thinking={tailRound.thinking} />
          ) : (
            tailRound.thinkingText !== undefined && (
              // The round's streaming thinking (issue #1658): the same
              // muted, scroll-capped block the ThinkingFold's expanded
              // body renders -- unfolded by design (the user expanded the
              // face to watch the stream), replaced by the ThinkingFold at
              // the freeze (custody: the stream's home is the activity
              // line, the frozen block's the settle). Keyed by the round
              // count so the round boundary remounts the face even on a
              // seal-bypassing path -- the mount arm re-arms
              // unconditionally (issue #1669).
              <p
                key={liveTurn.rounds.length}
                ref={mountStreamRef}
                onScroll={updateTailPin}
                className={THINKING_TEXT_CLASS}
                tabIndex={0}
                role="region"
                aria-label={intl.formatMessage({
                  id: "thread.trace.thinkingAria",
                  defaultMessage: "Agent thinking",
                })}
              >
                {tailRound.thinkingText}
              </p>
            )
          )}
          {faceRows.length > 0 && (
            <TraceList>
              {faceRows.map((row) => (
                <LiveRow
                  key={row.key}
                  row={row}
                  onRespond={onRespond}
                  onLoadParamValues={onLoadParamValues}
                />
              ))}
            </TraceList>
          )}
        </div>
      )}
    </>
  );
}
