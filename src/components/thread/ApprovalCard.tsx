import { useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OperationBadge } from "./TraceRow";
import { TraceSummaryFold } from "./TraceSummaryFold";
import type { LiveRoundRow } from "../../session/useTurnFlow";
import { log } from "../../lib/log";
import type { ApprovalResponse, FileAttachment } from "../../types/approval";

// The approval-card species (ADR-0083): the presentation vocabulary a gated
// call contributes to the live trace, split from the trace renderer
// (TraceView) so each species reads as one file. Three pieces: the in-flow
// pending card (the decision moment -- the gateway suspends the turn until
// the user answers, ADR-0080/0083), its file-delivery expand-on-demand view
// (issues #672 / #1009), and the resolved marker that flips the card in
// place once answered. LiveRow (TraceView) stays the three-arm dispatcher;
// the pending precondition (`response === null`) is pinned in the card's
// props type.
//
// i18n (ADR-0052): every chrome string (button copy, resolved markers)
// routes through react-intl with a static literal id; the layer-4 content
// (tool names, summaries, excerpts) passes through untranslated.

// The in-flow approval card (ADR-0083): tool name + operation badge +
// parameter summary + the three answers. The gateway suspends the turn on
// this request; answering wakes it (respond_tool_approval).
export function ApprovalCard({
  approval,
  name,
  summary,
  operationKind,
  onRespond,
  onLoadAttachments,
}: {
  /** The pending request's snapshot -- the card renders the three answers,
   *  never a resolved state; the `response: null` intersection pins that
   *  in the type. */
  approval: NonNullable<LiveRoundRow["approval"]> & { response: null };
  name: LiveRoundRow["name"];
  summary: LiveRoundRow["summary"];
  operationKind: LiveRoundRow["operationKind"];
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  /** Pulls the FULL pre-truncation file values for a pending request
   *  (issue #1009): the snapshot the row already holds is the capped
   *  broadcast copy; this fetches the uncut originals while the turn is
   *  suspended on the gate. Optional -- absent loaders keep the #672
   *  capped-snapshot behavior. */
  onLoadAttachments?: (requestId: string) => Promise<FileAttachment[]>;
}) {
  const { requestId } = approval;
  const fileValues = approval.fileAttachments ?? [];
  // The originator annotation (issue #934): a sub-agent's call names its
  // delegator above the card head, so the approver knows WHO is asking
  // before reading what. Absent (no row) for a main-loop call.
  const originNote = approval.originAgent ? (
    <p className="approval-origin m-0 mb-1 text-xs text-muted-foreground">
      <FormattedMessage
        id="thread.approval.originAgent"
        defaultMessage="Sub-agent {name} wants to call:"
        values={{ name: approval.originAgent }}
      />
    </p>
  ) : null;
  return (
    <li className="approval-card rounded-md border border-border bg-accent/40 p-1.5 my-0.5 text-xs">
      {originNote}
      <TraceSummaryFold
        summary={summary}
        summaryClassName="approval-summary"
        head={(
          <>
            <ShieldQuestion
              aria-hidden="true"
              className="w-3.5 h-3.5 shrink-0 text-muted-foreground"
            />
            {/* min-w-0 + truncate: an external tool rides a server prefix
                + tool name that can outrun the narrow column; shrink-0
                refused to shrink and pushed the summary and badge out of
                the card, whose border carries no overflow strategy
                (issue #872) -- this joins the same row's summary family
                (#826): single line, tail ellipsis. */}
            <span className="approval-tool font-medium min-w-0 truncate">{name}</span>
            <OperationBadge kind={operationKind} />
          </>
        )}
      />
      {/* flex-wrap: the Button base class carries whitespace-nowrap, so
          each button's min-content is its full label; three buttons plus
          the ml-auto awaiting hint outrun the narrow rail's content box
          and the overflow-x crop eats the tail -- the hint drops to a
          second line, button pairs wrap if the labels alone still
          outrun the column (issue #862). */}
      <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
        <span className="approval-pending-hint ml-auto text-xs text-muted-foreground">
          <FormattedMessage
            id="thread.approval.pending"
            defaultMessage="Awaiting approval"
          />
        </span>
      </span>
      {fileValues.length > 0 && (
        <ApprovalFileValues
          preview={fileValues}
          requestId={requestId}
          onLoad={onLoadAttachments}
        />
      )}
    </li>
  );
}

// The file-delivery expand-on-demand view (issue #672, ADR-0109 Decision 8;
// full view issue #1009): collapsed by default, a deliberate low-frequency
// action. Expanding pulls the FULL pre-truncation contents through the
// `get_approval_attachments` command (the broadcast snapshot is capped at
// the 4 KiB budget, not the content boundary); the capped preview renders
// during the load gap and stays as the fallback when the pull rejects (slot
// released, IPC failure) with a one-line error note. Without a loader the
// expand keeps the capped snapshot (the #672 behavior -- tests without the
// session id).
function ApprovalFileValues({
  preview,
  requestId,
  onLoad,
}: {
  preview: FileAttachment[];
  requestId: string;
  onLoad?: (requestId: string) => Promise<FileAttachment[]>;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  // One fetch per card: idle until the first expand, then the uncut contents
  // or the fallback posture. The pending-window snapshot is immutable while
  // the card is up, so re-expanding reuses the settled state.
  const [fullView, setFullView] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "full"; files: FileAttachment[] }
    | { kind: "failed" }
  >({ kind: "idle" });

  const toggleFiles = () => {
    const next = !filesOpen;
    setFilesOpen(next);
    // Fired from the handler (not an effect): one shot, no StrictMode
    // double-fetch, no refetch on re-expand.
    if (next && fullView.kind === "idle" && onLoad) {
      setFullView({ kind: "loading" });
      void onLoad(requestId).then(
        (files) => setFullView({ kind: "full", files }),
        (err) => {
          // The durable trace the respond-command catch keeps too (ADR-0029):
          // an expected lifecycle rejection and a real IPC failure are
          // indistinguishable in the UI, so the log carries the difference.
          log.warn(
            "approval",
            "full-attachments pull rejected; falling back to the capped preview",
            { requestId, err },
          );
          setFullView({ kind: "failed" });
        },
      );
    }
  };

  // The load gap and the failure both show the capped preview; only a landed
  // full fetch replaces it.
  const shown = fullView.kind === "full" ? fullView.files : preview;
  return (
    <>
      <button
        type="button"
        className="approval-files-toggle mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        aria-expanded={filesOpen}
        onClick={toggleFiles}
      >
        {filesOpen ? (
          <FormattedMessage id="thread.approval.hideFiles" defaultMessage="Hide file values" />
        ) : (
          <FormattedMessage
            id="thread.approval.viewFiles"
            defaultMessage="View file values ({count})"
            values={{ count: preview.length }}
          />
        )}
      </button>
      {filesOpen && (
        <>
          {fullView.kind === "failed" && (
            // role="status": the note appears asynchronously after the fetch
            // rejects -- the same live-note semantics the thread's other
            // async error notes carry.
            <p role="status" className="approval-file-error m-0 mt-1 text-xs text-destructive">
              <FormattedMessage
                id="thread.approval.fileValuesLoadFailed"
                defaultMessage="Full contents unavailable — showing the capped preview."
              />
            </p>
          )}
          {shown.map((file) => (
            <span key={file.param} className="approval-file mt-1 block">
              <span className="approval-file-param font-mono text-xs text-muted-foreground">
                {file.param}
              </span>
              <pre className="approval-file-content mt-0.5 max-h-40 overflow-auto rounded-sm bg-background p-1.5 font-mono text-xs whitespace-pre-wrap break-all">
                {file.content}
              </pre>
            </span>
          ))}
        </>
      )}
    </>
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

// The resolved marker a gated call merges onto its row: the badge variant
// (deny is the destructive one) is this species's own concern.
export function ApprovalResolvedBadge({ response }: { response: ApprovalResponse }) {
  const intl = useIntl();
  // The badge's label joins the row's truncate family (#876): negative
  // space is absorbed by the shrinkable items in proportion to their base
  // size, so the far wider summary and tool name collapse first and the
  // badge truncates only near the narrowest columns (the unshrinkable
  // chrome -- spinner, op-badge, chevron -- sets the row's min-content
  // floor just past that column's line box). Those siblings render from
  // LiveRow / TraceSummaryFold in TraceView. `shrink` overrides the Badge
  // base class's own shrink-0 (twMerge keeps the later same-group class),
  // which would otherwise pin the badge wide and silently defeat min-w-0.
  return (
    <Badge
      variant={response === "deny" ? "destructive" : "secondary"}
      className="approval-resolved min-w-0 shrink truncate px-1 py-0 text-xs font-normal"
    >
      {resolvedLabel(intl, response)}
    </Badge>
  );
}
