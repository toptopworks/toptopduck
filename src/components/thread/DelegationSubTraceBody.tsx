import { FormattedMessage } from "react-intl";
import type { ReactNode } from "react";
import { RoundProse } from "./RoundProse";
import { ThinkingFold } from "./ThinkingFold";
import { TraceStepFold } from "./TraceRow";
import { UsageFooter } from "./UsageFooter";
import type { TokenUsage, TraceRound } from "../../types/thread";

// The delegation row's inline sub-trace panel (ADR-0117 Decision 6 as
// settled by issue #1355, replacing the #934 modal): the row head carries
// the fold toggle (TraceRow owns it), and the panel renders full width
// beneath the row -- the delegation's identity + task head, the usage
// subtotal, and the sub-agent's rounds in the main trace's folding posture
// (each round's thinking fold + connective prose + its "Trace · N calls"
// step fold), so a sub-round reads exactly like a main round. The rows
// reuse the main trace's row list, whose nesting is physically depth 1 (the
// sub-face excludes every delegation tool), so no recursion guard is
// needed. The panel mounts only while the row's fold is open, so the settle
// swap collapses it -- the known limitation recorded on the issue; there
// is no dialog left to close out from under the reader.
//
// ADR-0135: the panel is also the RUNNING delegation's live face. The live
// caller (TraceView) passes the task's full text, the report's full text
// once landed (live-only, Decision 3), and the running fold's rounds as
// children; the completion swaps the children for the row's landed
// sub_rounds (the settle isomorphism #934's Advisory G anchors).

/** The expanded panel body: the head section (identity, task, subtotal)
 *  over the rounds section, with the report's full text as the tail when
 *  the live completion carried one. Never empty on the settled path:
 *  TraceRow gates the fold on the entry's sub-rounds, so this renders only
 *  behind an open fold (the round convention is none-never-empty -- an
 *  empty-note branch at this layer was unreachable dead code, removed per
 *  the #946 review). The live path may open with an empty rounds section
 *  (the fold's first event has not landed) -- the task head is the
 *  content. */
export function DelegationSubTraceBody({
  name,
  task,
  report,
  subRounds,
  usage,
  children,
}: {
  /** The delegation's registry name (the panel title's identity). */
  name: string;
  /** The task text the head renders: the FULL text while live (ADR-0135
   *  Decision 3), the bounded summary once settled -- one slot, the caller
   *  picks the posture. */
  task: string;
  /** The report's FULL text (ADR-0135 Decision 3), present only while the
   *  turn is live: the completion event carried it; the settled entry
   *  keeps its bounded excerpt, so the reopened panel honestly degrades to
   *  the summary head with no tail. */
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
    <div className="subtrace-panel mt-1 space-y-3 border-l border-border pl-3">
      <div className="space-y-0.5">
        {/* The delegation's identity + task head: layer-4 content (registry
            name, agent-written task), passing through. */}
        <div className="subtrace-title text-xs font-medium text-foreground">
          <FormattedMessage
            id="thread.trace.subtraceTitle"
            defaultMessage="Sub-agent trace · {name}"
            values={{ name }}
          />
        </div>
        <div className="subtrace-task text-xs text-muted-foreground">{task}</div>
        {/* ADR-0129 Decision 6 (issue #1270): the sub-agent's usage
            subtotal, when the turn's table carried one -- the row-level
            attribution the built-in runtime's private folds make possible. */}
        {usage !== undefined && (
          <div className="subtrace-usage text-xs text-muted-foreground">
            <UsageFooter usage={usage} />
          </div>
        )}
      </div>
      {children ??
        (subRounds ?? []).map((round, i) => (
          // The sub-rounds are append-only within the entry and never
          // reordered, so the index is a stable key (the same YAGNI call the
          // main trace's row lists make).
          <div key={i} className="trace-round">
            {/* The round's thinking: the same honest fold the main trace
                renders, collapsed by default. */}
            {round.thinking && <ThinkingFold thinking={round.thinking} />}
            {/* The round's connective prose, the same markdown face the main
                rounds use. */}
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
        <div className="subtrace-report whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {report}
        </div>
      )}
    </div>
  );
}
