import { useState } from "react";
import { FormattedMessage, useIntl, type IntlShape } from "react-intl";
import { Paperclip, ShieldQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OperationBadge } from "./TraceRow";
import { TraceSummaryFold } from "./TraceSummaryFold";
import type { LiveRoundRow } from "../../session/useTurnFlow";
import { log } from "../../lib/log";
import type { ApprovalResponse, ParamValue } from "../../types/approval";

// The approval-card species (ADR-0083): the presentation vocabulary a gated
// call contributes to the live trace, split from the trace renderer
// (TraceView) so each species reads as one file. Three pieces: the in-flow
// pending card (the decision moment -- the gateway suspends the turn until
// the user answers, ADR-0080/0083), its param-value expand-on-demand view
// (issues #672 / #1009), and the resolved marker that flips the card in
// place once answered. LiveRow (TraceView) stays the three-arm dispatcher;
// the pending precondition (`response === null`) is pinned in the card's
// props type.
//
// i18n (ADR-0052): every chrome string (button copy, resolved markers)
// routes through react-intl with a static literal id; the layer-4 content
// (tool names, summaries, excerpts) passes through untranslated.

// The in-flow approval card (ADR-0083): the decision surface a gated call
// mounts on the stream tail while the gateway suspends the turn -- tool
// name + operation badge as the head row, the parameter summary as the
// card's body block (the approver reads the call here, not beside it),
// then the three answers. Answering wakes the turn (respond_tool_approval).
export function ApprovalCard({
  approval,
  name,
  summary,
  summaryDetail,
  operationKind,
  onRespond,
  onLoadParamValues,
}: {
  /** The pending request's snapshot -- the card renders the three answers,
   *  never a resolved state; the `response: null` intersection pins that
   *  in the type. */
  approval: NonNullable<LiveRoundRow["approval"]> & { response: null };
  name: LiveRoundRow["name"];
  summary: LiveRoundRow["summary"];
  /** The full text behind a cut summary (issue #1636), threaded from the
   *  merged row: the body block's expand recovers it. Optional -- the
   *  same absent arms as the wire entry. */
  summaryDetail?: LiveRoundRow["summaryDetail"];
  operationKind: LiveRoundRow["operationKind"];
  onRespond: (requestId: string, response: ApprovalResponse) => void;
  /** Pulls the FULL pre-truncation param values for a pending request
   *  (issue #1009): the snapshot the row already holds is the capped
   *  broadcast copy; this fetches the uncut originals while the turn is
   *  suspended on the gate. Optional -- absent loaders keep the #672
   *  capped-snapshot behavior. */
  onLoadParamValues?: (requestId: string) => Promise<ParamValue[]>;
}) {
  const { requestId } = approval;
  const paramValues = approval.paramValues ?? [];
  // The full-param-values pull (issue #1009), fired from the summary
  // expand (the handler, never an effect -- one shot, no StrictMode
  // double-fetch): the value delivery rides the same disclosure as the
  // call's full text, so the first expand is when the uncut originals
  // are worth pulling. One fetch per card -- the pending-window snapshot
  // is immutable while the card is up, so re-expanding reuses the
  // settled state; the load gap and a rejected pull both show the capped
  // preview (the broadcast snapshot), only a landed fetch replaces it.
  const [fullView, setFullView] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "full"; values: ParamValue[] }
    | { kind: "failed" }
  >({ kind: "idle" });
  // The delivery renders only while the summary expand is open -- the
  // posture lives inside TraceSummaryFold, so the mirror rides the same
  // callback that fires the pull.
  const [detailOpen, setDetailOpen] = useState(false);
  const handleDetailExpand = (expanded: boolean) => {
    setDetailOpen(expanded);
    if (
      !expanded ||
      fullView.kind !== "idle" ||
      paramValues.length === 0 ||
      !onLoadParamValues
    ) {
      return;
    }
    setFullView({ kind: "loading" });
    void onLoadParamValues(requestId).then(
      (values) => setFullView({ kind: "full", values }),
      (err) => {
        // The durable trace the respond-command catch keeps too (ADR-0029):
        // an expected lifecycle rejection and a real IPC failure are
        // indistinguishable in the UI, so the log carries the difference.
        log.warn(
          "approval",
          "full-param-values pull rejected; falling back to the capped preview",
          { requestId, err },
        );
        setFullView({ kind: "failed" });
      },
    );
  };
  // The originator annotation (issue #934): a sub-agent's call names its
  // delegator above the card head, so the approver knows WHO is asking
  // before reading what. Absent (no row) for a main-loop call.
  const originNote = approval.originAgent ? (
    <p className="approval-origin m-0 mb-2 text-xs text-muted-foreground">
      <FormattedMessage
        id="thread.approval.originAgent"
        defaultMessage="Sub-agent {name} wants to call:"
        values={{ name: approval.originAgent }}
      />
    </p>
  ) : null;
  return (
    // The shell rides the in-content card tier (hairline border + the
    // shadow-sm lift, DESIGN.md's card posture) -- the decision moment is
    // a card, not a tinted trace wrapper; the brightness step + shadow
    // give it the gravity the tint-foil wrap read as unfinished.
    <li className="approval-card mt-2 mb-1 rounded-lg border border-border bg-card p-3 shadow-sm">
      {originNote}
      {/* The summary is the card's body (TraceSummaryFold's block
          posture): head row above, the call's text in a rest-state
          clamped mono block that unclamps in place on expand (#1636's
          detail when the row carries it). The param-value view (#672,
          #1009) rides the same disclosure -- one expand = the call's
          full inputs, argument text and delivered values together. */}
      <TraceSummaryFold
        variant="block"
        summary={summary}
        summaryDetail={summaryDetail}
        summaryClassName="approval-summary"
        onExpandedChange={handleDetailExpand}
        head={(
          <>
            <ShieldQuestion
              aria-hidden="true"
              className="w-3.5 h-3.5 shrink-0 text-muted-foreground"
            />
            {/* min-w-0 + truncate: an external tool rides a server prefix
                + tool name that can outrun the narrow column; shrink-0
                refused to shrink and pushed the badge out of the card,
                whose border carries no overflow strategy (issue #872) --
                single line, tail ellipsis. */}
            <span className="approval-tool text-[13px] font-medium min-w-0 truncate">
              {name}
            </span>
            <OperationBadge kind={operationKind} />
            {/* The at-rest param-value count (#672's Vec -- the old toggle's
                "(1)" lived here): the delivery now rides the summary
                expand, so this is the only rest-state signal that values
                exist and how many; the visible figure is decorative, the
                sr-only sentence carries it to assistive tech. */}
            {paramValues.length > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
                >
                  <Paperclip className="h-3 w-3" />
                  {paramValues.length}
                </span>
                <span className="sr-only">
                  <FormattedMessage
                    id="thread.approval.paramValuesAttached"
                    defaultMessage="{count, plural, one {# attached file} other {# attached files}}"
                    values={{ count: paramValues.length }}
                  />
                </span>
              </>
            )}
            {/* role="status": while the gate suspends the turn the
                round-trip wait line is gone (isRoundTripWait judges false
                on the undecided row), so this hint is the only
                announcement to assistive technology that a decision is
                being asked for -- polite, the SessionPane alert convention
                (issue #1368). The head row is the card's status slot: the
                tool name is min-w-0 truncate, so the hint can never be
                pushed out of the row. The "only" rides two facts outside
                this card's tree -- the isRoundTripWait predicate and the
                wait line it gates away; if the gate ever keeps a live
                region up during suspension, this comment and the LiveRow
                pin move together. */}
            <span
              role="status"
              className="approval-pending-hint ml-auto shrink-0 text-xs text-warning"
            >
              <FormattedMessage
                id="thread.approval.pending"
                defaultMessage="Awaiting approval"
              />
            </span>
          </>
        )}
      />
      {detailOpen && paramValues.length > 0 && (
        <ApprovalParamValues
          shown={fullView.kind === "full" ? fullView.values : paramValues}
          failed={fullView.kind === "failed"}
        />
      )}
      {/* flex-wrap: the Button base class carries whitespace-nowrap, so
          each button's min-content is its full label; if the three labels
          alone outrun the narrow rail's content box the overflow-x crop
          eats the tail -- the pairs wrap instead (issue #862; the
          awaiting hint moved to the head row's status slot, off this
          row's width budget). */}
      <span className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          className="approval-allow-once h-7 px-3 text-[13px]"
          onClick={() => onRespond(requestId, "allow_once")}
        >
          <FormattedMessage id="thread.approval.allowOnce" defaultMessage="Allow once" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="approval-always-allow h-7 px-3 text-[13px]"
          onClick={() => onRespond(requestId, "always_allow")}
        >
          <FormattedMessage id="thread.approval.alwaysAllow" defaultMessage="Always allow" />
        </Button>
        {/* ml-3: deny is the safety-side action, not part of the allow
            pair -- the wider interval groups it visually apart from the
            release path (issue #1368). The outline variant stays: deny is
            harmless to press, destructive marks a destructive consequence.
            A deny that wraps alone keeps its ml-3 as a line-start indent
            (the #862 wrap stays reachable, never cropped) -- a known
            artifact, cheaper than a spacer element. */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="approval-deny ml-3 h-7 px-3 text-[13px]"
          onClick={() => onRespond(requestId, "deny")}
        >
          <FormattedMessage id="thread.approval.deny" defaultMessage="Deny" />
        </Button>
      </span>
      {/* The always-allow trust-scope disclosure (issue #1368): a resident
          line under the answers, not a hover disclosure -- "Always allow"
          lifts this one tool to session-wide trust (ADR-0080 Decision 3),
          and that consequence must be readable at the decision moment with
          zero interaction. Same caption family as the originator note. */}
      <p className="approval-scope-note m-0 mt-2 text-xs text-muted-foreground">
        <FormattedMessage
          id="thread.approval.alwaysAllowScope"
          defaultMessage="After Always allow, calls to this tool no longer ask for the rest of the session."
        />
      </p>
    </li>
  );
}

// The param-value view (issue #672, ADR-0109 Decision 8; full view issue
// #1009): the VALUES only -- it renders while the summary expand is open
// and unmounts with it. The pull state machine lives in the card (the
// expand is the trigger there); the load gap and a rejected pull both show
// the capped broadcast snapshot, only a landed fetch replaces it, and the
// rejection carries a one-line live note.
function ApprovalParamValues({
  shown,
  failed,
}: {
  shown: ParamValue[];
  failed: boolean;
}) {
  return (
    <>
      {failed && (
        // role="status": the note appears asynchronously after the fetch
        // rejects -- the same live-note semantics the thread's other
        // async error notes carry.
        <p role="status" className="approval-param-error m-0 mt-1 text-xs text-destructive">
          <FormattedMessage
            id="thread.approval.paramValuesLoadFailed"
            defaultMessage="Full contents unavailable — showing the capped preview."
          />
        </p>
      )}
      {shown.map((value) => (
        <span key={value.param} className="approval-param mt-1 block">
          <span className="approval-param-name font-mono text-xs text-muted-foreground">
            {value.param}
          </span>
          <pre className="approval-param-content mt-0.5 max-h-40 overflow-auto rounded-sm bg-background p-1.5 font-mono text-xs whitespace-pre-wrap break-all">
            {value.content}
          </pre>
        </span>
      ))}
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

// The abandoned marker a gated call merges onto its row (issue #1267): the
// external caller dropped the call with no answer -- a neutral terminal
// state, never an answer. Same truncate family as the resolved badge.
export function ApprovalAbandonedBadge() {
  const intl = useIntl();
  return (
    <Badge
      variant="secondary"
      className="approval-abandoned min-w-0 shrink truncate px-1 py-0 text-xs font-normal"
    >
      {intl.formatMessage({
        id: "thread.approval.abandoned",
        defaultMessage: "Abandoned",
      })}
    </Badge>
  );
}
