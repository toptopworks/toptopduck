// The shared fold chrome: a compact chevron + label button, the chevron
// rotating on expand; aria-expanded conveys the fold state. Used by the
// settled per-round thinking + steps folds (TurnCard) and by the live
// thinking fold (issue #610) -- one chrome so the settle swap does not move
// the fold the user is looking at. The hook class is the fold's selector /
// test anchor, the label rides children.

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// The hook class is the fold's selector / test anchor. A literal union of the
// two folds that exist (the per-round thinking fold + the per-round steps
// fold) so a typo'd class fails at the call site, not as a selector miss.
export type FoldHookClass = "thinking-toggle" | "trace-toggle";

export function FoldToggle({
  hookClass,
  expanded,
  onToggle,
  children,
}: {
  hookClass: FoldHookClass;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        hookClass,
        "mt-0.5 flex items-center gap-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground",
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
