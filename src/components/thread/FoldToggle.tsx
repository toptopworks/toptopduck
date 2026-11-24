// The shared fold chrome: a compact chevron + label button, the chevron
// rotating on expand; aria-expanded conveys the fold state. Used by the
// turn-level process fold, the settled per-round thinking + steps folds
// (TurnCard), the live thinking fold (issue #610), the delegation
// sub-trace fold (issue #1355), and the antecedents lineage fold
// (issue #1627) -- one chrome so the settle swap does not
// move the fold the user is looking at (the head's size excepted
// by ruling: the live activity line's head rides the 13px chrome
// tier while the settled process fold keeps body-md). The hook class
// is the fold's selector / test anchor, the label rides children.

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// The hook class is the fold's selector / test anchor. A literal union of the
// folds that exist (the turn-level process fold, the per-round thinking fold,
// the per-round steps fold, the delegation sub-trace fold, the antecedents
// lineage fold) so a typo'd class fails at the call site, not as a selector
// miss.
export type FoldHookClass =
  | "thinking-toggle"
  | "trace-toggle"
  | "process-toggle"
  | "subtrace-toggle"
  | "antecedents-toggle";

export function FoldToggle({
  hookClass,
  expanded,
  onToggle,
  children,
  className,
  chevronSide = "left",
  above,
}: {
  hookClass: FoldHookClass;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Extra utilities appended last (twMerge, last wins) -- the summary-line
   *  callers pass "mt-0": the block-flow mt-0.5 breathing gap is what knocks
   *  the toggle off the text inside a flex items-center summary line. */
  className?: string;
  /** Which end the chevron rides. "right" trails the label (ml-auto), the
   *  affordance-right posture -- the turn-level fold heads (the settled
   *  process fold and the live activity line, one chrome so the settle swap
   *  moves nothing structurally; the sanctioned tier split does step the
   *  head's size 13px to body-md across the swap) read status left,
   *  affordance right. */
  chevronSide?: "left" | "right";
  /** An activity row rendered ABOVE the fold row, inside the button (the
   *  live activity line's preview row, issue #1661): a full-width flex row
   *  the row keeps single-line flex beneath. The slot's content must stay
   *  a flex row (as the fold row itself is): a button carries the user
   *  agent's text-align: center into plain-block inline content (the
   *  preflight resets margin, padding, and font but not the alignment), so
   *  a short label there reads as an indent that grows as the content
   *  shrinks -- flex items are immune, plain blocks are not. Absent keeps
   *  every existing caller laying out identically -- the row wrapper
   *  replaces the button's own flex, so a single-child button renders
   *  exactly as before. */
  above?: ReactNode;
}) {
  const chevron = (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        "w-3.5 h-3.5 transition-transform",
        expanded && "rotate-90",
        chevronSide === "right" && "ml-auto",
      )}
    />
  );
  // The row hugs its content (self-start against the button's
  // items-stretch column): fit-content callers render identically, and a
  // button stretched wider by the `above` slot cannot hand the slack to
  // the chevron's ml-auto -- the affordance stays beside the label
  // (issue #1669).
  const row = (
    <div className="flex items-center gap-1 self-start">
      {chevronSide === "left" && chevron}
      {children}
      {chevronSide === "right" && chevron}
    </div>
  );
  return (
    <button
      type="button"
      className={cn(
        hookClass,
        "mt-0.5 flex flex-col items-stretch gap-0.5 text-sm text-muted-foreground hover:text-foreground",
        className,
      )}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {above}
      {row}
    </button>
  );
}
