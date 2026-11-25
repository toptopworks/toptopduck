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
// The block posture (variant="block"): the summary is the body surface,
// not a line tail -- the approval card's decision face. Rest: the bounded
// summary two-line clamped on the code-block surface ({colors.muted}).
// Expanded: the SAME block unclamps -- the #1636 detail swaps in when the
// row carries one -- never a second copy of what rest already shows; the
// height cap and the keyboard scroll region (#1363) ride the unclamped
// face. The chevron rides the line variant's hover-reveal: no rest-state
// affordance claims hidden content -- a short summary expands to itself,
// a clamped one keeps its tail for the same hover / focus recovery. The
// trace sites keep the line: their
// summaries are scan payload, the card's is the decision's subject
// matter.

import { useState, type ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { SUMMARY_ROW_REVEAL_CLASS } from "./turn-visual";

/** The hook class anchoring the truncated summary span (test / selector
 * anchor) -- a literal union so a typo'd class fails at the call site,
 * not as a selector miss (FoldToggle's FoldHookClass precedent). */
type SummaryHookClass = "trace-summary" | "approval-summary";

// The fold's chevron control, shared by both postures: the keyboard path
// (a real button, aria-expanded naming the posture) and the reveal class
// ride here once. Color is the caller's -- the line site owns its muted +
// hover pair, the block site inherits its host's.
function SummaryFoldChevron({
  expanded,
  className,
}: {
  expanded: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "summary-fold-toggle inline-flex h-4 w-4 shrink-0 items-center justify-center",
        SUMMARY_ROW_REVEAL_CLASS,
        expanded && "opacity-100",
        className,
      )}
      aria-expanded={expanded}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
      />
    </button>
  );
}

export function TraceSummaryFold({
  summary,
  summaryDetail,
  summaryClassName,
  head = null,
  resultExcerpt,
  replacements,
  variant = "line",
  onExpandedChange,
}: {
  summary: string;
  /** The full text behind a cut summary (issue #1636): the expand face
   * upgrades from the bounded head to this when present; absent (an uncut
   * argument, a pre-#1636 record) keeps the head -- which then unclamps
   * in place instead of duplicating itself. */
  summaryDetail?: string;
  /** The hook class for the truncated summary span -- the visual
   * utilities live here, shared. */
  summaryClassName: SummaryHookClass;
  /** The site-specific line head (spinner / shield, tool name, badges)
   * rendered before the summary. In the block posture it rides above the
   * block as a plain row (never part of the click target -- the head's
   * chrome is not the fold). */
  head?: ReactNode;
  /** The call's result excerpt, folded into the expand block beside the
   * argument summary as a second column (issue #1604). Absent keeps the
   * single-column block -- the trace row passes it only for the one
   * success whose excerpt survives the projection (the capped
   * delegation's truncation notice, issue #1047). */
  resultExcerpt?: string;
  /** The edit's replacement count (issue #1621), rendered as one lead
   * line of the expand block (a count beyond 1 implies replace_all).
   * Absent keeps the block without the line -- only a successful edit
   * entry carries one; a write has no replacements to name. */
  replacements?: number;
  /** The presentation posture: the line (default) keeps the trace
   * family's single-line scan row -- head + truncated summary + the
   * hover-revealed chevron, the whole line the click target. The block
   * turns the summary into the body surface: the head rides above as a
   * plain row and the summary itself unclamps on expand. */
  variant?: "line" | "block";
  /** The posture change, out to the host: the approval card fires its
   * one-shot full-file-values pull on the first expand (issue #1009). */
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const intl = useIntl();
  // Issue #1636: the expand face recovers the full argument when the
  // backend persisted one; every fallback keeps the single-string
  // behavior (the block posture unclamps it in place).
  const expandText = summaryDetail ?? summary;
  const regionLabel = intl.formatMessage({
    id: "thread.trace.summaryBlockAria",
    defaultMessage: "Full summary",
  });
  // One toggle, both variants: the state flip plus the host callback --
  // fired from the handler, never an effect (no StrictMode double-fire).
  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    onExpandedChange?.(next);
  };
  if (variant === "block") {
    return (
      <>
        {head !== null && (
          <span className="flex min-w-0 items-center gap-1.5">{head}</span>
        )}
        {/* The block is the body AND the click target (the line variant's
            whole-line anatomy, one posture over); the chevron button is
            the keyboard path. Expanded, the bounded head swaps for the
            full text in place -- the scroll region (#1363) rides it. */}
        <div
          className="group/summary-row mt-2 flex w-full cursor-pointer items-start gap-1.5 rounded-md bg-muted px-2 py-2 text-left font-mono text-[13px] leading-5 text-muted-foreground hover:text-foreground"
          onClick={toggleExpanded}
        >
          <p
            className={cn(
              "approval-summary m-0 min-w-0 flex-1 whitespace-pre-wrap break-words",
              expanded
                ? "summary-fold-block max-h-48 overflow-y-auto"
                : "line-clamp-2",
            )}
            tabIndex={expanded ? 0 : undefined}
            role={expanded ? "region" : undefined}
            aria-label={expanded ? regionLabel : undefined}
          >
            {expanded ? expandText : summary}
          </p>
          <SummaryFoldChevron expanded={expanded} className="mt-0.5" />
        </div>
      </>
    );
  }
  return (
    <>
      <span
        className="group/summary-row flex min-w-0 cursor-pointer items-center gap-1.5"
        onClick={toggleExpanded}
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
        <SummaryFoldChevron
          expanded={expanded}
          className="text-muted-foreground hover:text-foreground"
        />
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
          aria-label={regionLabel}
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
