// The live activity line (issue #1606, ADR-0151; clock re-host #1612): the
// turn's ONE rotating activity face. Folded, it reads the current phase --
// the thinking period ("Thinking (step n)…", the retired trailing status
// line's duty merged in), the running call ("{verb} · N completed", the
// breathing dot riding the head), or the prose-streaming window ("Running…" --
// the #1612 narrowing of ADR-0151's step-aside ruling: what let the line
// yield was the THINKING face doubling the prose signal; the running face
// beside the caret does not reproduce it, and the turn clock must never
// leave the exchange). The elapsed figure ("· 12s") rides the face tail in
// every posture -- the turn clock's only host since the composer wait slot
// retired (#1264's ruling re-hosted). The tool face answers a call at
// once; its verb switches at
// most once per window (calls flashing a fresh verb each read as flicker
// -- the user ruling) and the face holds one window past the last call,
// so short calls stay readable and the line never blinks inside a burst.
// The line's fold holds the CURRENT round only (#1656's narrowing of the
// #1606 domain): the turn tail -- its completed calls ride the head's
// count, its thinking + calls sit in the expand face, the running call
// is absorbed by the head. Every earlier round seals as its own
// settle-isomorphic block in the exchange, NOT here; prose no longer
// partitions the two.
// With nothing behind the fold -- no thinking, no settled or running row
// in the line's rounds (a lone pending card does not count: the card
// renders at the tail, outside the fold) -- the line is a plain status
// line: no hover, no click (the user ruling). The expand posture seeds
// the settled turn-level process fold across the swap.

import { useEffect, useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { FoldToggle } from "./FoldToggle";
import { ThinkingFold } from "./ThinkingFold";
import { LiveRow } from "./TraceView";
import { TraceList } from "./TraceList";
import { WaitElapsedSuffix } from "./WaitElapsedSuffix";
import { isRoundTripWait, isSettledRow } from "../../session/useTurnFlow";
import type { ApprovalResponse, FileAttachment, OperationKind } from "../../types/approval";
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

export function LiveActivityLine({
  liveTurn,
  onRespond,
  onLoadAttachments,
  onExpandedChange,
}: {
  liveTurn: LiveTurn;
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  /** Passed through to the expand face's running rows (issue #1009). */
  onLoadAttachments?: (requestId: string) => Promise<FileAttachment[]>;
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
  // The line's rounds: the CURRENT round only -- the turn tail (#1656's
  // narrowing of the #1606 domain). Every earlier round seals as its own
  // settle-isomorphic block in the exchange, so the head's count reads
  // the tail round's rows and the expand face renders it alone. The tail
  // stays the line's through the round-trip wait -- the settle swap is
  // what retires the line, so the domain needs no other boundary.
  const lineRounds = liveTurn.rounds.slice(-1);
  const lineRows = lineRounds.flatMap((round) => round.rows);
  const completedCount = lineRows.filter(isSettledRow).length;
  const running = allRows.find((row) => row.running);
  // The gate hold (an approval-channel row the gateway has not completed):
  // the activity line KEEPS the tool face while a pending card waits (the
  // call is about to run, the card -- the answer surface -- beside it; the
  // line vanishing entirely read as the process dying on the device) and,
  // by the same mechanism, while a resolved row awaits its completion
  // event (a deny between its optimistic resolve and the gateway's
  // completed broadcast) or an abandoned call rides the turn forever
  // (#1267) -- those rows are not settled, so the fold faces admit none
  // of them and the held face plus the tail badge row are their surfaces.
  // The verb names the held row's own kind -- the imminent activity for a
  // pending card; a denial's completion is a network window away.
  const heldRow = allRows.find(
    (row) => row.approval !== null && !isSettledRow(row) && !row.running,
  );
  const gateHold = !running && heldRow !== undefined;
  const toolKind: OperationKind | undefined =
    running?.operationKind ?? (gateHold ? heldRow?.operationKind : undefined);
  const waiting = isRoundTripWait(liveTurn);
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
  // Expandable only when something sits behind the fold (the user ruling:
  // a line with nothing to show on expand is a plain status line -- no
  // hover, no click): any round's thinking, or any settled/running row.
  const canExpand = lineRounds.some(
    (round) =>
      round.thinking !== undefined ||
      round.rows.some((row) => isSettledRow(row) || row.running),
  );
  // The head's face content, shared by both postures (the fold toggle and
  // the plain status line): the breathing dot + the shimmer sweeping the
  // phase face and the elapsed figure together (the running visual lives
  // in styles.css's .activity-live-dot / .activity-shimmer, one shared
  // 2.4s period). The verb reads
  // the damped faceKind; the count reads the live rows -- a brief call
  // ticks the count without repainting the verb. The figure sits at ONE
  // tail position in every posture and phase: the ask stamp derives the
  // elapsed seconds, so the clock never resets across a face rotation or
  // a posture flip (the #1612 re-host of the #1264 turn clock).
  const face = (
    <>
      <span aria-hidden="true" className="activity-live-dot shrink-0" />
      <span className="activity-shimmer">
        {faceKind !== undefined ? (
          <>
            {liveVerbLabel(intl, faceKind)}
            {" · "}
            {intl.formatMessage(
              {
                id: "thread.trace.liveCount",
                defaultMessage:
                  "{count, plural, one {# call completed} other {# calls completed}}",
              },
              { count: completedCount },
            )}
          </>
        ) : streaming ? (
          <FormattedMessage id="thread.live.running" defaultMessage="Running…" />
        ) : liveTurn.step !== null && liveTurn.step > 1 ? (
          <FormattedMessage
            id="thread.live.thinkingStep"
            defaultMessage="Thinking (step {step})…"
            values={{ step: liveTurn.step }}
          />
        ) : (
          <FormattedMessage id="common.thinking" defaultMessage="Thinking…" />
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
          className="mt-2"
          chevronSide="right"
        >
          {face}
        </FoldToggle>
      ) : (
        // The plain status face: the same layout minus the fold chrome --
        // no chevron, no hover, no click, nothing to expand (the user
        // ruling). The hook class stays as the test anchor.
        <div className="process-toggle mt-2 flex items-center gap-1 text-sm text-muted-foreground">
          {face}
        </div>
      )}
      {expanded &&
        // The fold's face: the line's rounds (after the last prose
        // section) -- per round, the thinking fold then its call rows on
        // the shared left-rail list (the settled face's chrome); the
        // running call unfurls in its round. Revealed rounds never render
        // here -- they live at their sections.
        lineRounds.map((round, i) => {
          const rows = round.rows.filter((row) => isSettledRow(row) || row.running);
          return (
            <div key={i + 1} className="trace-round max-w-full">
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
            </div>
          );
        })}
    </>
  );
}
