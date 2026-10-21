import type { ReactNode } from "react";
import { RoundProse } from "./RoundProse";
import { ThinkingFold } from "./ThinkingFold";
import { TraceStepFold } from "./TraceRow";
import { UsageFooter } from "./UsageFooter";
import type { TokenUsage, TraceRound } from "../../types/thread";

// The delegation row's inline sub-trace panel (ADR-0117 Decision 6 as
// settled by issue #1355, replacing the #934 modal): the row head carries
// the fold toggle (TraceRow owns it), and the panel renders full width
// beneath the row -- the sub-agent's rounds in the main trace's folding
// posture (each round's thinking fold + connective prose + its "Trace ·
// N calls" step fold, stacked flush exactly as the main trace stacks its
// rounds), the running face's task head above them, the usage subtotal as
// the closing receipt -- so a sub-round reads exactly like a main round.
// The rows reuse the main trace's row list, whose nesting is physically
// depth 1 (the sub-face excludes every delegation tool), so no recursion
// guard is needed. The panel mounts only while the row's fold is open, so
// the settle swap collapses it -- the known limitation recorded on the
// issue; there is no dialog left to close out from under the reader.
//
// ADR-0135: the panel is also the RUNNING delegation's live face. The
// running face's caller (TraceView's RunningRow) passes the task's full
// text, the report's full text once landed (live-only, Decision 3), and
// the running fold's rounds as children; the completion swaps the children
// for the row's landed sub_rounds (the settle isomorphism #934's Advisory
// G anchors). The task head rides the running face only -- its contract
// lives on the `task` prop's doc.

/** The expanded panel body: the rounds stacked flush; the running face
 *  opens with the live task's full text as the rounds' head, the settled
 *  face closes with the usage subtotal as the receipt line, and the
 *  report's full text trails while the turn is live. Never empty on the
 *  settled path:
 *  TraceRow gates the fold on the entry's sub-rounds, so this renders only
 *  behind an open fold (the round convention is none-never-empty -- an
 *  empty-note branch at this layer was unreachable dead code, removed per
 *  the #946 review). The live path may open with an empty rounds section
 *  (the fold's first event has not landed) -- the task head is the
 *  content. */
export function DelegationSubTraceBody({
  task,
  report,
  subRounds,
  usage,
  children,
}: {
  /** The task head's text, RUNNING-FACE-ONLY (ADR-0135 Decision 3): the
   *  full text while the delegation runs -- a just-started delegation's
   *  panel opens on it before any event lands. Non-running callers pass
   *  none: the row line above already previews the task, so the reopened
   *  panel rides as pure trace. */
  task?: string;
  /** The report's FULL text (ADR-0135 Decision 3), present only while the
   *  turn is live: the completion event carried it; the settled entry
   *  keeps its bounded excerpt, so the reopened panel honestly degrades to
   *  pure trace with no tail. */
  report?: string;
  /** The settled sub-rounds (the entry's `sub_rounds` projection); ignored
   *  when children mount. */
  subRounds?: TraceRound[];
  /** The sub-agent's usage subtotal (ADR-0129 Decision 6, issue #1270),
   *  already paired to THIS row by TurnCard's name+ordinal cursor -- the
   *  bare TokenUsage, not SubagentUsage, so the panel cannot mispair a
   *  same-name sibling's subtotal. Live panels carry none (the table
   *  settles with the turn). */
  usage?: TokenUsage;
  /** The live rounds section (the running fold's forwarded events,
   *  ADR-0135): mounts in place of the settled rounds -- TraceView builds
   *  it from the delegation buffer, running rows and all. */
  children?: ReactNode;
}) {
  return (
    <div className="subtrace-panel mt-1 border-l border-border pl-3">
      {/* The delegation's task head, live-only: agent-written layer-4
          content, passing through. The block rides the thinking-fold
          block's posture (muted surface, pre-wrap, height-capped) so the
          task's own line structure survives instead of collapsing into a
          wall of text. */}
      {task !== undefined && (
        <div className="subtrace-task mb-3 rounded-md bg-muted p-2 text-xs text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
          {task}
        </div>
      )}
      {/* The rounds stack flush as direct panel children, exactly as the
          main trace stacks its rounds; the section gaps are explicit
          margins on the task / report / usage blocks -- heterogeneous
          beats a space-y container cannot carry (its sibling margin
          collapses with a next block's tighter top margin, and max wins --
          the receipt's mt-1 would never render). */}
      {children ??
        (subRounds ?? []).map((round, i) => (
          // The sub-rounds are append-only within the entry and never
          // reordered, so the index is a stable key (the same YAGNI call
          // the main trace's row lists make).
          <div key={i} className="trace-round">
            {/* The round's thinking: the same honest fold the main trace
                renders, collapsed by default. */}
            {round.thinking && <ThinkingFold thinking={round.thinking} />}
            {/* The round's connective prose, the same markdown face the
                main rounds use. */}
            {round.text && <RoundProse text={round.text} />}
            {/* The round's tool string behind the same step fold the main
                rounds use (a sub-agent's calls never carry their own
                sub-trace). */}
            <TraceStepFold calls={round.calls} />
          </div>
        ))}
      {report !== undefined && (
        // ADR-0135 Decision 3: the report's full text, the terminal answer
        // the trace's bounded excerpt stands in for -- the panel's tail
        // while the turn is live. No tail once settled: the excerpt under
        // the row is the honest degrade.
        <div className="subtrace-report mt-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {report}
        </div>
      )}
      {/* ADR-0129 Decision 6 (issue #1270): the sub-agent's usage subtotal,
          when the turn's table carried one -- the row-level attribution the
          built-in runtime's private folds make possible. It closes the
          panel as the run's receipt (the turn card's closing-meta
          precedent). */}
      {usage !== undefined && (
        // The receipt's top gap matches the panel's own top beat (mt-1).
        <div className="subtrace-usage mt-1 text-xs text-muted-foreground">
          <UsageFooter usage={usage} />
        </div>
      )}
    </div>
  );
}
