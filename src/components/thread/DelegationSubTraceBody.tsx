import { FormattedMessage } from "react-intl";
import { RoundProse } from "./RoundProse";
import { ThinkingFold } from "./ThinkingFold";
import { TraceStepFold } from "./TraceRow";
import { UsageFooter } from "./UsageFooter";
import type { SubagentUsage, TraceEntry } from "../../types/thread";

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
// swap collapses it -- the known limitation recorded on the issue; there is
// no dialog left to close out from under the reader.

/** The expanded panel body: the head section (identity, task, subtotal)
 *  over one section per sub-round. Never empty here: TraceRow gates the
 *  fold on the entry's sub-rounds, so this renders only behind an open
 *  fold (the round convention is none-never-empty -- an empty-note branch
 *  at this layer was unreachable dead code, removed per the #946 review). */
export function DelegationSubTraceBody({
  entry,
  subtotal,
}: {
  entry: TraceEntry;
  subtotal?: SubagentUsage;
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
            values={{ name: entry.name }}
          />
        </div>
        <div className="subtrace-task text-xs text-muted-foreground">
          {entry.summary}
        </div>
        {/* ADR-0129 Decision 6 (issue #1270): the sub-agent's usage
            subtotal, when the turn's table carried one -- the row-level
            attribution the built-in runtime's private folds make possible. */}
        {subtotal !== undefined && (
          <div className="subtrace-usage text-xs text-muted-foreground">
            <UsageFooter usage={subtotal.usage} />
          </div>
        )}
      </div>
      {(entry.sub_rounds ?? []).map((round, i) => (
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
    </div>
  );
}
