// The shared fold chrome: a compact chevron + label button, the chevron
// rotating on expand; aria-expanded conveys the fold state. Used by the
// turn-level process fold, the settled per-round thinking + steps folds
// (TurnCard), the live thinking fold (issue #610), and the delegation
// sub-trace fold (issue #1355) -- one chrome so the settle swap does not
// move the fold the user is looking at. The hook class
// is the fold's selector / test anchor, the label rides children.

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// The hook class is the fold's selector / test anchor. A literal union of the
// folds that exist (the turn-level process fold, the per-round thinking fold,
// the per-round steps fold, the delegation sub-trace fold) so a typo'd class
// fails at the call site, not as a selector miss.
export type FoldHookClass =
  | "thinking-toggle"
  | "trace-toggle"
  | "process-toggle"
  | "subtrace-toggle";

export function FoldToggle({
  hookClass,
  expanded,
  onToggle,
  children,
  className,
}: {
  hookClass: FoldHookClass;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Extra utilities appended last (twMerge, last wins) -- the summary-line
   *  callers pass "mt-0": the block-flow mt-0.5 breathing gap is what knocks
   *  the toggle off the text inside a flex items-center summary line. */
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        hookClass,
        "mt-0.5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground",
        className,
      )}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn("w-3.5 h-3.5 transition-transform", expanded && "rotate-90")}
      />
      {children}
    </button>
  );
}
