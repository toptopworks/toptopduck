import { useState, type ReactNode } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Check, Loader2, ShieldQuestion, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TraceList } from "./TraceList";
import type { LiveRoundRow } from "../../session/useTurnFlow";
import type { OperationKind, ApprovalResponse } from "../../types/approval";
import type { TraceEntry } from "../../types/thread";

// The execution-trace renderers (ADR-0078, issue #297): the expanded tool-call
// chain of a settled turn (TraceRowList) and the live stream's per-row
// renderer (LiveRow, consumed by the live chat exchange, issue #610) -- one
// rendering path for both the recorded trace and the live event stream, per
// ADR-0083 ("the decision moment and the trace record share one rendering
// path"). Rows render the operation badge + argument summary +
// success/failure; live rows additionally carry the approval card chrome
// (three buttons pending -> resolved badge) when the call went through the
// gateway gate (ADR-0080/0083).
//
// i18n (ADR-0052): every chrome string (badge labels, button copy, resolved
// markers) routes through react-intl with a static literal id; the layer-4
// content (tool names, summaries, excerpts) passes through untranslated.

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

function OperationBadge({ kind }: { kind: OperationKind }) {
  const intl = useIntl();
  // Neutral outline: the badge names the category, the row's success glyph
  // carries the good/bad signal (a colored badge per kind would compete with
  // the outcome encoding, ADR-0047).
  return (
    <Badge variant="outline" className="op-badge shrink-0 px-1 py-0 text-[0.68rem] font-normal">
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

// One completed trace entry (the expanded trace of a settled turn, or a
// settled live row). Tool name + operation badge + argument summary, with the
// failure excerpt beneath (the cross-turn retrospection anchor, ADR-0078).
// The summary is agent-generated layer-4 content and passes through in a
// monospace face (it IS the SQL / reference the call ran). `afterName` is the
// live card's resolved-approval badge slot (a settled TurnRecord trace has no
// approval chrome -- the persisted entries carry the call alone). Module-
// scoped: the settled row list + the live row below are its only callers.
function TraceRow({
  entry,
  afterName = null,
}: {
  entry: TraceEntry;
  afterName?: ReactNode;
}) {
  return (
    <li className="trace-row flex items-start gap-1.5 py-0.5 text-xs">
      <span className="mt-px">
        <SuccessGlyph success={entry.success} />
      </span>
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="trace-name font-medium shrink-0">{entry.name}</span>
          <OperationBadge kind={entry.operation_kind} />
          {afterName}
          <span className="trace-summary min-w-0 flex-1 truncate font-mono text-[0.72rem] text-muted-foreground">
            {entry.summary}
          </span>
        </span>
        {!entry.success && entry.result_excerpt !== "" && (
          <span className="trace-excerpt block whitespace-pre-wrap break-words text-[0.72rem] text-destructive">
            {entry.result_excerpt}
          </span>
        )}
      </div>
    </li>
  );
}

// The expanded tool-call chain of a settled turn (ADR-0078): rendered beneath
// the turn head when the card is expanded, hidden (not unmounted data -- the
// TurnRecord carries it) when collapsed. The chrome rides the shared
// TraceList so the live exchange's row list renders identically (issue #620).
export function TraceRowList({ entries }: { entries: ReadonlyArray<TraceEntry> }) {
  return (
    <TraceList>
      {entries.map((entry, i) => (
        // The trace is append-only within a turn and never reordered, so the
        // index is a stable key (the same YAGNI call the thread makes).
        <TraceRow key={i} entry={entry} />
      ))}
    </TraceList>
  );
}

// The resolved-approval marker (ADR-0083 in-place flip): names the user's
// answer once the pending card is answered. Exhaustive over ApprovalResponse.
function resolvedLabel(intl: IntlShape, response: ApprovalResponse): string {
  switch (response) {
    case "allow_once":
      return intl.formatMessage({
        id: "thread.approval.resolved.allowOnce",
        defaultMessage: "Allowed",
      });
    case "always_allow":
      return intl.formatMessage({
        id: "thread.approval.resolved.alwaysAllow",
        defaultMessage: "Always allowed",
      });
    case "deny":
      return intl.formatMessage({ id: "thread.approval.resolved.deny", defaultMessage: "Denied" });
    default: {
      const unhandled: never = response;
      throw new Error(`unhandled approval response: ${JSON.stringify(unhandled)}`);
    }
  }
}

// One live trace row: a pending approval renders the three-button card
// (ADR-0083); a resolved approval merges its badge with the call's state;
// plain built-in calls render as a running spinner or a completed trace row.
// Exported for the live chat exchange (issue #610), which streams the rows
// unfurled inside the current round's block.
export function LiveRow({
  row,
  onRespond,
}: {
  row: LiveRoundRow;
  onRespond: (requestId: string, response: ApprovalResponse) => void;
}) {
  const intl = useIntl();
  // The file-delivery expand (issue #672): collapsed by default, a
  // deliberate low-frequency action (ADR-0109 Decision 8). Declared before
  // the pending branch -- hooks cannot sit behind a conditional return.
  const [filesOpen, setFilesOpen] = useState(false);
  if (row.approval !== null && row.approval.response === null) {
    // The in-flow approval card (ADR-0083): tool name + operation badge +
    // parameter summary + the three answers. The gateway suspends the turn on
    // this request; answering wakes it (respond_tool_approval).
    const { requestId } = row.approval;
    const fileValues = row.approval.fileAttachments ?? [];
    return (
      <li className="approval-card rounded-md border border-border bg-accent/40 p-1.5 my-0.5 text-xs">
        <span className="flex items-center gap-1.5 min-w-0">
          <ShieldQuestion
            aria-hidden="true"
            className="w-3.5 h-3.5 shrink-0 text-muted-foreground"
          />
          <span className="approval-tool font-medium shrink-0">{row.name}</span>
          <OperationBadge kind={row.operationKind} />
          <span className="approval-summary min-w-0 flex-1 truncate font-mono text-[0.72rem] text-muted-foreground">
            {row.summary}
          </span>
        </span>
        <span className="mt-1.5 flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            className="approval-allow-once h-6 px-2 text-xs"
            onClick={() => onRespond(requestId, "allow_once")}
          >
            <FormattedMessage id="thread.approval.allowOnce" defaultMessage="Allow once" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="approval-always-allow h-6 px-2 text-xs"
            onClick={() => onRespond(requestId, "always_allow")}
          >
            <FormattedMessage id="thread.approval.alwaysAllow" defaultMessage="Always allow" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="approval-deny h-6 px-2 text-xs"
            onClick={() => onRespond(requestId, "deny")}
          >
            <FormattedMessage id="thread.approval.deny" defaultMessage="Deny" />
          </Button>
          <span className="approval-pending-hint ml-auto text-[0.68rem] text-muted-foreground">
            <FormattedMessage
              id="thread.approval.pending"
              defaultMessage="Awaiting approval"
            />
          </span>
        </span>
        {fileValues.length > 0 && (
          <>
            <button
              type="button"
              className="approval-files-toggle mt-1 text-[0.68rem] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen((open) => !open)}
            >
              {filesOpen ? (
                <FormattedMessage
                  id="thread.approval.hideFiles"
                  defaultMessage="Hide file values"
                />
              ) : (
                <FormattedMessage
                  id="thread.approval.viewFiles"
                  defaultMessage="View file values ({count})"
                  values={{ count: fileValues.length }}
                />
              )}
            </button>
            {filesOpen &&
              fileValues.map((file) => (
                <span key={file.param} className="approval-file mt-1 block">
                  <span className="approval-file-param font-mono text-[0.68rem] text-muted-foreground">
                    {file.param}
                  </span>
                  <pre className="approval-file-content mt-0.5 max-h-40 overflow-auto rounded-sm bg-background p-1.5 font-mono text-[0.68rem] whitespace-pre-wrap break-all">
                    {file.content}
                  </pre>
                </span>
              ))}
          </>
        )}
      </li>
    );
  }
  // A resolved approval merges its badge onto the call row (one row per call,
  // ADR-0083): the answer marker rides beside the name; the row otherwise
  // renders its running / completed state like any call.
  const resolvedResponse = row.approval !== null ? row.approval.response : null;
  const resolvedBadge =
    resolvedResponse !== null ? (
      <Badge
        variant={resolvedResponse === "deny" ? "destructive" : "secondary"}
        className="approval-resolved shrink-0 px-1 py-0 text-[0.68rem] font-normal"
      >
        {resolvedLabel(intl, resolvedResponse)}
      </Badge>
    ) : null;
  if (row.running || row.success === null) {
    return (
      <li className="trace-row live-running flex items-center gap-1.5 py-0.5 text-xs">
        <Loader2 aria-hidden="true" className="w-3.5 h-3.5 shrink-0 animate-spin text-muted-foreground" />
        <span className="trace-name font-medium shrink-0">{row.name}</span>
        <OperationBadge kind={row.operationKind} />
        {resolvedBadge}
        <span className="trace-summary min-w-0 flex-1 truncate font-mono text-[0.72rem] text-muted-foreground">
          {row.summary}
        </span>
      </li>
    );
  }
  return (
    <TraceRow
      entry={{
        name: row.name,
        operation_kind: row.operationKind,
        summary: row.summary,
        success: row.success,
        result_excerpt: row.resultExcerpt,
      }}
      afterName={resolvedBadge}
    />
  );
}
