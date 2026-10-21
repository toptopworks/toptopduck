import { useState, type ReactNode } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Check, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { FoldToggle } from "./FoldToggle";
import { TraceList } from "./TraceList";
import { TraceSummaryFold } from "./TraceSummaryFold";
import type { OperationKind } from "../../types/approval";
import type { TraceEntry } from "../../types/thread";

// The trace-row rendering family (ADR-0078, issue #297), extracted from
// TraceView so the delegation sub-trace panel can reuse the rows without a
// circular import: the panel composes rows, and the panel body is injected
// by the caller (TraceView / TurnCard), never imported here. The row owns
// the sub-trace fold itself (issue #1355): the toggle rides the summary
// line's tail, the injected body renders beneath the row while open. The
// operation badge + glyph helpers ride along -- LiveRow (still in
// TraceView) and the rows share them.

// The operation badge (ADR-0083): a compact i18n label per OperationKind.
// Presentation only -- the gateway does not branch on it. Exhaustiveness
// guard mirrors the Rust match: types/approval.ts is the hand-maintained
// mirror, so the never check stands in for the compiler.
function operationLabel(intl: IntlShape, kind: OperationKind): string {
  switch (kind) {
    case "read":
      return intl.formatMessage({ id: "thread.trace.op.read", defaultMessage: "read" });
    case "write":
      return intl.formatMessage({ id: "thread.trace.op.write", defaultMessage: "write" });
    case "execute":
      return intl.formatMessage({ id: "thread.trace.op.execute", defaultMessage: "execute" });
    case "network":
      return intl.formatMessage({ id: "thread.trace.op.network", defaultMessage: "network" });
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled operation kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function OperationBadge({ kind }: { kind: OperationKind }) {
  const intl = useIntl();
  // Neutral outline: the badge names the category, the row's success glyph
  // carries the good/bad signal (a colored badge per kind would compete with
  // the outcome encoding, ADR-0047).
  return (
    <Badge variant="outline" className="op-badge shrink-0 px-1 py-0 text-xs font-normal">
      {operationLabel(intl, kind)}
    </Badge>
  );
}

// The success/failure glyph at a row's head: Check (muted) on success,
// TriangleAlert (destructive) on failure. The aria-label names the outcome so
// the row is legible without color (ADR-0047 not-color-alone).
function SuccessGlyph({ success }: { success: boolean }) {
  const intl = useIntl();
  return success ? (
    <span
      className="trace-success inline-flex w-3.5 h-3.5 shrink-0 items-center justify-center text-muted-foreground"
      role="img"
      aria-label={intl.formatMessage({
        id: "thread.trace.successAria",
        defaultMessage: "Call succeeded",
      })}
    >
      <Check aria-hidden="true" className="w-3.5 h-3.5" />
    </span>
  ) : (
    <span
      className="trace-failure inline-flex w-3.5 h-3.5 shrink-0 items-center justify-center text-destructive"
      role="img"
      aria-label={intl.formatMessage({
        id: "thread.trace.failureAria",
        defaultMessage: "Call failed",
      })}
    >
      <TriangleAlert aria-hidden="true" className="w-3.5 h-3.5" />
    </span>
  );
}

// One round's step fold (the "Trace · N calls" tier, ADR-0078's folding
// discipline): the round's call count reads on the fold head so a rail scan
// shows which rounds made multiple calls without expanding; the rows mount
// only while expanded. Shared by the settled main trace's round adapter
// (TurnCard) and the delegation sub-trace's rounds (issue #1355) so the two
// faces cannot drift; `renderSubTrace` is the delegation panel injection
// (issue #934) -- the sub-face passes none.
export function TraceStepFold({
  calls,
  renderSubTrace,
}: {
  calls: ReadonlyArray<TraceEntry>;
  renderSubTrace?: (entry: TraceEntry) => ReactNode;
}) {
  const [stepsExpanded, setStepsExpanded] = useState(false);
  if (calls.length === 0) return null;
  return (
    <>
      <FoldToggle
        hookClass="trace-toggle"
        expanded={stepsExpanded}
        onToggle={() => setStepsExpanded((v) => !v)}
      >
        <FormattedMessage
          id="thread.trace.toggle"
          defaultMessage="Trace · {count} {count, plural, one {call} other {calls}}"
          values={{ count: calls.length }}
        />
      </FoldToggle>
      {stepsExpanded && (
        <TraceRowList entries={calls} renderSubTrace={renderSubTrace} />
      )}
    </>
  );
}

// One completed trace entry (the expanded trace of a settled turn, or a
// settled live row). Tool name + operation badge + argument summary, with the
// failure excerpt beneath (the cross-turn retrospection anchor, ADR-0078).
// The summary is agent-generated layer-4 content and passes through in a
// monospace face (it IS the SQL / reference the call ran). `afterName` is
// the live card's resolved-approval badge slot (a settled TurnRecord trace
// has no approval chrome -- the persisted entries carry the call alone);
// `subTrace` is the delegation row's inline panel body (issue #934, inlined
// by #1355) -- the row stays one line with the fold toggle at its tail, and
// the body renders full width beneath the row while open.
export function TraceRow({
  entry,
  afterName = null,
  subTrace = null,
}: {
  entry: TraceEntry;
  afterName?: ReactNode;
  subTrace?: ReactNode;
}) {
  const [subOpen, setSubOpen] = useState(false);
  // The gate lives here, once: a row whose entry carries no sub-rounds (or
  // whose caller supplied no body) renders neither the toggle nor the panel,
  // so the callers inject the body unconditionally over their row lists.
  const hasSubTrace = subTrace !== null && (entry.sub_rounds?.length ?? 0) > 0;
  return (
    <li className="trace-row flex items-start gap-1.5 py-0.5 text-xs">
      <span className="mt-px">
        <SuccessGlyph success={entry.success} />
      </span>
      <div className="min-w-0 flex-1">
        {/* Inline fold recovery (issue #826): the truncated line grows an
         * expand block under the row on chevron click; the failure excerpt
         * stays the cross-turn retrospection anchor below it. */}
        <TraceSummaryFold
          summary={entry.summary}
          summaryClassName="trace-summary"
          head={(
            <>
              {/* Tool name truncates with the row's summary family
                  (#826) and the approval card's cap (#872): an external
                  tool's server prefix + name can outrun the narrow column,
                  and shrink-0 used to shove the summary and badges out
                  (issue #874). */}
              <span className="trace-name font-medium min-w-0 truncate">{entry.name}</span>
              <OperationBadge kind={entry.operation_kind} />
              {afterName}
              {hasSubTrace && (
                // stopPropagation: the toggle sits inside the row head's
                // summary-fold line (the whole line toggles the summary's
                // expand block); folding the sub-trace is a different
                // action and must not also fold the summary.
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
        {/* The excerpt is the cross-turn retrospection anchor (ADR-0078).
         * The one SUCCESS that carries one is a capped delegation report's
         * truncation notice (issue #1047) -- the projections keep exactly
         * that success excerpt -- rendered muted under the check glyph: the
         * call completed, the answer was just cut. */}
        {entry.result_excerpt !== "" && (
          <span
            className={cn(
              "trace-excerpt block whitespace-pre-wrap break-words text-xs",
              entry.success ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {entry.result_excerpt}
          </span>
        )}
        {/* The expanded panel mounts full width beneath the row; unmounting
         * on fold -- and on the settle swap, which rebuilds the row -- is
         * the known limitation recorded on the issue (#1355). */}
        {hasSubTrace && subOpen && subTrace}
      </div>
    </li>
  );
}

// The expanded tool-call chain of a settled turn (ADR-0078): rendered beneath
// the turn head when the card is expanded, hidden (not unmounted data -- the
// TurnRecord carries it) when collapsed. The chrome rides the shared
// TraceList so the live exchange's row list renders identically (issue #620).
// `renderSubTrace` is the delegation view-affordance injection (issue #934):
// the settled trace's caller (TurnCard) supplies it for every row -- the
// dialog self-guards to the rows carrying a nested sub-trace -- and the
// sub-trace viewer itself passes none (a sub-agent's calls never carry
// their own sub-trace).
export function TraceRowList({
  entries,
  renderSubTrace,
}: {
  entries: ReadonlyArray<TraceEntry>;
  renderSubTrace?: (entry: TraceEntry) => ReactNode;
}) {
  return (
    <TraceList>
      {entries.map((entry, i) => (
        // The trace is append-only within a turn and never reordered, so the
        // index is a stable key (the same YAGNI call the thread makes).
        <TraceRow
          key={i}
          entry={entry}
          subTrace={renderSubTrace?.(entry) ?? null}
        />
      ))}
    </TraceList>
  );
}
