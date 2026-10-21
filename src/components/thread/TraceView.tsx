import { Loader2 } from "lucide-react";
import { useState } from "react";
import { FormattedMessage } from "react-intl";
import { ApprovalAbandonedBadge, ApprovalCard, ApprovalResolvedBadge } from "./ApprovalCard";
import { DelegationSubTraceBody } from "./DelegationSubTraceBody";
import { FoldToggle } from "./FoldToggle";
import { ThinkingFold } from "./ThinkingFold";
import { TraceList } from "./TraceList";
import { OperationBadge, TraceRow } from "./TraceRow";
import { TraceSummaryFold } from "./TraceSummaryFold";
import {
  isSettledRow,
  traceEntryFromRow,
  type DelegationLiveView,
  type LiveRoundRow,
} from "../../session/useTurnFlow";
import type { ApprovalResponse, FileAttachment } from "../../types/approval";
import type { ReactNode } from "react";

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

// The delegation row's status chip (ADR-0135 Consequences): purely derived
// from the forwarded events -- a lone delegation shows its running fold's
// step, a batch shows the aggregate counts. Rendered only while the row
// runs; a completed row's sub-trace panel is the affordance from then on.
function DelegationChip({ view }: { view: DelegationLiveView }) {
  return (
    <span className="delegation-chip shrink-0 text-xs text-muted-foreground">
      {view.batch.total > 1 ? (
        <FormattedMessage
          id="thread.trace.delegationBatch"
          defaultMessage="{done} of {total} done, {running} running"
          values={view.batch}
        />
      ) : (
        <FormattedMessage
          id="thread.trace.delegationStep"
          defaultMessage="step {n}"
          values={{ n: view.step ?? 1 }}
        />
      )}
    </span>
  );
}

// The running call row (spinner + name + badge), carrying the delegation's
// live affordances when the row is one (ADR-0135): the status chip and the
// inline sub-trace fold -- the same panel the settled row renders, fed from
// the delegation buffer while the run streams, swapped for the landed
// sub_rounds at completion (the settle isomorphism issue #934's Advisory G
// anchors).
function RunningRow({
  row,
  resolvedBadge,
  onRespond,
  onLoadAttachments,
}: {
  row: LiveRoundRow;
  resolvedBadge: ReactNode;
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  onLoadAttachments?: (requestId: string) => Promise<FileAttachment[]>;
}) {
  const [subOpen, setSubOpen] = useState(false);
  const view = row.delegation;
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
            {view !== undefined && <DelegationChip view={view} />}
            {view !== undefined && (
              // stopPropagation: the toggle sits inside the row head's
              // summary-fold line (the whole line toggles the summary's
              // expand block); folding the sub-trace is a different action
              // and must not also fold the summary (the settled row's
              // convention).
              <span onClick={(e) => e.stopPropagation()}>
                <FoldToggle
                  hookClass="subtrace-toggle"
                  expanded={subOpen}
                  onToggle={() => setSubOpen((v) => !v)}
                >
                  <FormattedMessage
                    id="thread.trace.viewSubtrace"
                    defaultMessage="Sub-agent trace"
                  />
                </FoldToggle>
              </span>
            )}
          </>
        )}
      />
      {view !== undefined && subOpen && (
        <DelegationSubTraceBody name={row.name} task={view.task} report={view.report}>
          {/* The running fold's rounds: the same block shape the settle's
              sub_rounds render -- thinking fold, then the call rows; no
              prose, ADR-0135 filters the deltas -- with live rows (spinner
              / completed) in place of settled entries. */}
          {view.rounds.map((round, i) => (
            <div key={i} className="trace-round">
              {round.thinking !== undefined && <ThinkingFold thinking={round.thinking} />}
              {round.rows.length > 0 && (
                <TraceList>
                  {round.rows.map((sub) => (
                    <LiveRow
                      key={sub.key}
                      row={sub}
                      onRespond={onRespond}
                      onLoadAttachments={onLoadAttachments}
                    />
                  ))}
                </TraceList>
              )}
            </div>
          ))}
        </DelegationSubTraceBody>
      )}
    </li>
  );
}

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
  // A terminal approval merges its badge onto the call row (one row per call,
  // ADR-0083): the user's answer marker, or the abandoned marker when the
  // external caller dropped the call (issue #1267), rides beside the name;
  // the row otherwise renders its running / completed state like any call.
  const terminalResponse = row.approval !== null ? row.approval.response : null;
  const resolvedBadge =
    terminalResponse === "abandoned" ? (
      <ApprovalAbandonedBadge />
    ) : terminalResponse !== null ? (
      <ApprovalResolvedBadge response={terminalResponse} />
    ) : null;
  if (row.running || !isSettledRow(row)) {
    return (
      <RunningRow
        row={row}
        resolvedBadge={resolvedBadge}
        onRespond={onRespond}
        onLoadAttachments={onLoadAttachments}
      />
    );
  }
  // The delegation row's sub-trace rides the optimistic turn flow (issue
  // #934): the entry the settled row renders carries what the live
  // ToolCallCompleted delivered, sub-trace included, so the fold is present
  // before any refetch could ever widen it. The projection is the one
  // `traceEntryFromRow` mapping (PR #946 review: a second hand-written
  // literal here is how the field list drifted). The usage subtotal only
  // exists once the turn settles (#1270), so the live panel carries none.
  // ADR-0135: while the turn is live the panel takes the task's full text
  // (the started phase carried it) and the report's full text once the
  // completion landed -- both drop at settle, where the bounded summary and
  // excerpt take over (Decision 3's honest degrade).
  const entry = traceEntryFromRow(row);
  const view = row.delegation;
  return (
    <TraceRow
      entry={entry}
      afterName={resolvedBadge}
      subTrace={(
        <DelegationSubTraceBody
          name={row.name}
          task={view?.task ?? row.summary}
          report={view?.report}
          subRounds={row.subRounds}
        />
      )}
    />
  );
}
