// A trace row's summary line with the inline fold recovery (issue #826):
// the line stays single-line truncated (the rail scan posture, ADR-0078);
// the WHOLE line is the click target -- one click grows an expand block
// under the line with the full summary string (the ThinkingFold block
// visual plus font-mono; the summary IS the SQL / argv digest), the next
// click collapses it. A trailing icon-only chevron (no text label) keys
// its reveal on the row's own named group: hidden at rest, revealed while
// the row is hovered or focused (keyboard parity), pinned visible while
// expanded. Shared by the three summary sites (the settled trace row, the
// live running row, and the approval card) so the recovery interaction
// has one shape everywhere; the per-site line head (spinner / shield,
// tool name, badges) rides the `head` slot -- the settled site keeps its
// success glyph OUTSIDE the fold as the sibling column anchoring the
// two-line row, so that glyph column sits outside the click target while
// the live spinner / shield sit inside it.
//
// The chevron is a real button (the keyboard path; aria-expanded names
// the posture) whose click bubbles to the line's onClick -- one handler,
// one toggle. Its 16px box is intentionally tight: the whole line is the
// pointer path, the button is the keyboard / focus path. The affordance
// rides every row unconditionally -- no
// render-time truncation gate (jsdom cannot measure, and a short summary
// expanding is harmless); the expanded state is session-ephemeral, the
// stepsExpanded tier: the settle swap collapses it and a reload loses it
// (an approval-to-running branch switch reconciles this same component
// in place and KEEPS the fold open -- the one unlocked in-between).

import { useState, type ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { SUMMARY_ROW_REVEAL_CLASS } from "./turn-visual";

/** The hook class anchoring the truncated summary span (test / selector
 *  anchor) -- a literal union so a typo'd class fails at the call site,
 *  not as a selector miss (FoldToggle's FoldHookClass precedent). */
type SummaryHookClass = "trace-summary" | "approval-summary";

export function TraceSummaryFold({
  summary,
  summaryDetail,
  summaryClassName,
  head = null,
  resultExcerpt,
  replacements,
}: {
  summary: string;
  /** The full text behind a cut summary (issue #1636): the expand block's
   *  argument column upgrades from the bounded head to this when present;
   *  absent (an uncut argument, a pre-#1636 record, the approval card)
   *  keeps the head. The line itself always stays the bounded head. */
  summaryDetail?: string;
  /** The hook class for the truncated summary span -- the visual
   *  utilities live here, shared. */
  summaryClassName: SummaryHookClass;
  /** The site-specific line head (spinner / shield, tool name, badges)
   *  rendered inside the line before the summary. */
  head?: ReactNode;
  /** The call's result excerpt, folded into the expand block beside the
   *  argument summary as a second column (issue #1604). Absent keeps the
   *  single-column block -- the trace row passes it only for the one
   *  success whose excerpt survives the projection (the capped
   *  delegation's truncation notice, issue #1047). */
  resultExcerpt?: string;
  /** The edit's replacement count (issue #1621), rendered as one lead
   *  line of the expand block (a count beyond 1 implies replace_all).
   *  Absent keeps the block without the line -- only a successful edit
   *  entry carries one; a write has no replacements to name. */
  replacements?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  // Issue #1636: the expand block recovers the full argument when the
  // backend persisted one; every fallback keeps the old single-string
  // behavior.
  const expandText = summaryDetail ?? summary;
  return (
    <>
      <span
        className="group/summary-row flex min-w-0 cursor-pointer items-center gap-1.5"
        onClick={() => setExpanded((v) => !v)}
      >
        {head}
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground",
            summaryClassName,
          )}
        >
          {summary}
        </span>
        <button
          type="button"
          className={cn(
            "summary-fold-toggle inline-flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground",
            SUMMARY_ROW_REVEAL_CLASS,
            expanded && "opacity-100",
          )}
          aria-expanded={expanded}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
          />
        </button>
      </span>
      {/* Keyboard-reachable scroll region (#1363): the tabindex puts the
          height-capped block in the Tab order so arrow keys scroll it
          instead of the page; the region label names it for assistive
          tech. */}
      {expanded && (
        <p
          className="summary-fold-block m-0 mt-0.5 rounded-md bg-muted p-2 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label={intl.formatMessage({
            id: "thread.trace.summaryBlockAria",
            defaultMessage: "Full summary",
          })}
        >
          {replacements !== undefined && (
            // The edit's replacement count as the block's lead line (issue
            // #1621): readable next to the strings it names, without
            // competing with the row-head badge.
            <span className="mb-1 block border-b border-border pb-1">
              {intl.formatMessage(
                {
                  id: "thread.trace.replacementsCount",
                  defaultMessage:
                    "Replaced {count, plural, one {# occurrence} other {# occurrences}}",
                },
                { count: replacements },
              )}
            </span>
          )}
          {resultExcerpt === undefined ? (
            expandText
          ) : (
            // Both faces of the call in one capped block (issue #1604):
            // the argument summary left, the result excerpt right of the
            // divider -- each column free to wrap, the cap bounds the pair.
            <span className="flex gap-2">
              <span className="min-w-0 flex-1">{expandText}</span>
              <span className="min-w-0 flex-1 border-l border-border pl-2">
                {resultExcerpt}
              </span>
            </span>
          )}
        </p>
      )}
    </>
  );
}
