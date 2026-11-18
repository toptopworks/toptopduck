// The live activity line (issue #1606, ADR-0151): the turn's ONE rotating
// activity face. Folded, it reads the current phase -- the thinking
// period ("Thinking (step n)…", the retired trailing status line's duty
// merged in) or the running call ("{verb} · N completed", the spinner
// riding the head); while the tail round's prose streams the line steps
// aside (the prose + caret ARE the activity evidence -- the output face
// doubled the signal and flipped against the thinking face, the device
// ruling). The tool face answers a call at once; its verb switches at
// most once per window (calls flashing a fresh verb each read as flicker
// -- the user ruling) and the face holds one window past the last call,
// so short calls stay readable and the line never blinks inside a burst.
// The line's fold holds the rounds after the last prose section (the
// reveal line, liveRoundRevealed): their completed calls ride the head's
// count, their thinking + calls sit in the expand face, the running call
// is absorbed by the head. Sealed rounds -- everything the last prose
// section covers -- land as fold lines in the exchange, NOT here. The
// face rotates between the thinking phase and the running call ONLY: the
// streaming tail steps the line aside (the prose + caret carry the
// liveness; an output face beside visibly streaming text doubled the
// signal and flipped against the thinking face -- the device ruling).
// With nothing behind the fold -- no thinking, no rows in the line's
// rounds -- the line is a plain status line: no hover, no click (the
// user ruling). The expand posture seeds the settled turn-level process
// fold across the swap.

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { FoldToggle } from "./FoldToggle";
import { ThinkingFold } from "./ThinkingFold";
import { LiveRow } from "./TraceView";
import { isRoundTripWait, isSettledRow } from "../../session/useTurnFlow";
import type { ApprovalResponse, FileAttachment, OperationKind } from "../../types/approval";
import type { LiveTurn } from "../../session/useTurnFlow";
import { liveRoundRevealed } from "./turn-visual";

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
   *  otherwise. */
  onExpandedChange: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  useEffect(() => {
    onExpandedChange(expanded);
  }, [expanded, onExpandedChange]);
  const allRows = liveTurn.rounds.flatMap((round) => round.rows);
  // The line's rounds: everything after the last prose section (the
  // reveal line). The head's count reads THESE rows only -- the revealed
  // rounds' calls live as visible rows at their sections and are never
  // re-reported by the line; the expand face renders these rounds.
  const lineRounds = liveTurn.rounds.filter(
    (_, i) => !liveRoundRevealed(liveTurn.rounds, i),
  );
  const lineRows = lineRounds.flatMap((round) => round.rows);
  const completedCount = lineRows.filter(isSettledRow).length;
  const running = allRows.find((row) => row.running);
  // The gate hold (a pending approval card holds the turn): the activity
  // line KEEPS the tool face -- the call is about to run, and the card (the
  // answer surface) renders beside it; the line vanishing entirely read as
  // the process dying on the device. The verb keeps the last activity kind
  // (the pending call's own kind when nothing completed yet).
  const gateHold = !running && allRows.some((row) => row.approval !== null && row.approval.response === null);
  const toolKind: OperationKind | undefined =
    running?.operationKind ??
    (gateHold
      ? // The pending call IS the imminent activity -- its kind names the
        // face; with none (never possible in practice), the last completed.
        (allRows.find((row) => row.approval !== null && row.approval.response === null)
          ?.operationKind ??
          [...allRows].reverse().find(isSettledRow)?.operationKind)
      : undefined);
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
  // liveness themselves, so the line steps aside (an output face beside
  // visibly streaming text doubled the signal and flipped against the
  // thinking face as the stream paused -- the device ruling).
  if (!waiting && toolKind === undefined && faceKind === undefined) return null;
  // Expandable only when something sits behind the fold (the user ruling:
  // a line with nothing to show on expand is a plain status line -- no
  // hover, no click): any round's thinking, or any settled/running row.
  const canExpand = lineRounds.some(
    (round) =>
      round.thinking !== undefined ||
      round.rows.some((row) => isSettledRow(row) || row.running),
  );
  // The head's face content, shared by both postures (the fold toggle and
  // the plain status line): the spinner + the phase face. The verb reads
  // the damped faceKind; the count reads the live rows -- a brief call
  // ticks the count without repainting the verb.
  const face = (
    <>
      <Loader2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 animate-spin" />
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
      ) : liveTurn.step !== null && liveTurn.step > 1 ? (
        <FormattedMessage
          id="thread.live.thinkingStep"
          defaultMessage="Thinking (step {step})…"
          values={{ step: liveTurn.step }}
        />
      ) : (
        <FormattedMessage id="common.thinking" defaultMessage="Thinking…" />
      )}
    </>
  );
  return (
    <>
      {canExpand ? (
        <FoldToggle hookClass="process-toggle" expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
          {face}
        </FoldToggle>
      ) : (
        // The plain status face: the same layout minus the fold chrome --
        // no chevron, no hover, no click, nothing to expand (the user
        // ruling). The hook class stays as the test anchor.
        <div className="process-toggle mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          {face}
        </div>
      )}
      {expanded && (
        // The fold's face: the line's rounds (after the last prose
        // section) -- per round, the thinking fold then its call rows
        // laid flat; the running call unfurls in its round. Revealed
        // rounds never render here -- they live at their sections.
        lineRounds.map((round, i) => (
          <div key={i + 1} className="trace-round max-w-full">
            {round.thinking !== undefined && <ThinkingFold thinking={round.thinking} />}
            {round.rows
              .filter((row) => isSettledRow(row) || row.running)
              .map((row) => (
                // LiveRow for every row: the settled face renders the
                // ordinary TraceRow with the resolved-approval badge riding
                // afterName (a deny's answer marker survives the fold), and
                // a running row renders its spinner face.
                <LiveRow
                  key={row.key}
                  row={row}
                  onRespond={onRespond}
                  onLoadAttachments={onLoadAttachments}
                />
              ))}
          </div>
        ))
      )}
    </>
  );
}
