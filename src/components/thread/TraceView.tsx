import { Loader2 } from "lucide-react";
import { ApprovalCard, ApprovalResolvedBadge } from "./ApprovalCard";
import { DelegationTraceDialog } from "./DelegationTraceDialog";
import { OperationBadge, TraceRow } from "./TraceRow";
import { TraceSummaryFold } from "./TraceSummaryFold";
import { isSettledRow, traceEntryFromRow, type LiveRoundRow } from "../../session/useTurnFlow";
import type { ApprovalResponse, FileAttachment } from "../../types/approval";

// The execution-trace renderers (ADR-0078, issue #297): the expanded tool-call
// chain of a settled turn (TraceRowList) and the live stream's per-row
// renderer (LiveRow, consumed by the live chat exchange, issue #610) -- one
// rendering path for both the recorded trace and the live event stream, per
// ADR-0083 ("the decision moment and the trace record share one rendering
// path"). Rows render the operation badge + argument summary +
// success/failure; a gated call's approval presentation (pending card, file
// values, resolved badge) is the approval-card species in ApprovalCard,
// which the live arms below dispatch to (ADR-0080/0083). The chrome strings
// each species renders follow ADR-0052 (react-intl, static literal ids) in
// their own files.

// Type guard for the pending arm: a plain `response === null` check narrows
// only the leaf property, so the arm routes through this predicate to hand
// ApprovalCard its `response: null` props contract.
const isPendingApproval = (
  approval: NonNullable<LiveRoundRow["approval"]>,
): approval is NonNullable<LiveRoundRow["approval"]> & { response: null } =>
  approval.response === null;

// One live trace row: a pending approval renders the three-button card
// (ADR-0083); a resolved approval merges its badge with the call's state;
// plain built-in calls render as a running spinner or a completed trace row.
// Exported for the live chat exchange (issue #610), which streams the rows
// unfurled inside the current round's block.
export function LiveRow({
  row,
  onRespond,
  onLoadAttachments,
}: {
  row: LiveRoundRow;
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  /** Passed through to ApprovalCard (issue #1009). */
  onLoadAttachments?: (requestId: string) => Promise<FileAttachment[]>;
}) {
  if (row.approval !== null && isPendingApproval(row.approval)) {
    return (
      <ApprovalCard
        approval={row.approval}
        name={row.name}
        summary={row.summary}
        operationKind={row.operationKind}
        onRespond={onRespond}
        onLoadAttachments={onLoadAttachments}
      />
    );
  }
  // A resolved approval merges its badge onto the call row (one row per call,
  // ADR-0083): the answer marker rides beside the name; the row otherwise
  // renders its running / completed state like any call.
  const resolvedResponse = row.approval !== null ? row.approval.response : null;
  const resolvedBadge =
    resolvedResponse !== null ? <ApprovalResolvedBadge response={resolvedResponse} /> : null;
  if (row.running || !isSettledRow(row)) {
    return (
      <li className="trace-row live-running py-0.5 text-xs">
        <TraceSummaryFold
          summary={row.summary}
          summaryClassName="trace-summary"
          head={(
            <>
              <Loader2
                aria-hidden="true"
                className="w-3.5 h-3.5 shrink-0 animate-spin text-muted-foreground"
              />
              {/* Same truncate family as the settled row's tool name
                  (#874): shrink-0 used to shove the summary and badges out
                  when an external tool name outruns the narrow column. */}
              <span className="trace-name font-medium min-w-0 truncate">{row.name}</span>
              <OperationBadge kind={row.operationKind} />
              {resolvedBadge}
            </>
          )}
        />
      </li>
    );
  }
  // The delegation row's sub-trace rides the optimistic turn flow (issue
  // #934): the entry the settled row renders carries what the live
  // ToolCallCompleted delivered, sub-trace included, so the view affordance
  // is present before any refetch could ever widen it. The projection is
  // the one `traceEntryFromRow` mapping (PR #946 review: a second
  // hand-written literal here is how the field list drifted).
  const entry = traceEntryFromRow(row);
  return (
    <TraceRow
      entry={entry}
      afterName={resolvedBadge}
      subTraceView={<DelegationTraceDialog entry={entry} />}
    />
  );
}
