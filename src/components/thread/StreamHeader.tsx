// The assistant stream's opening header chrome (ADR-0103, issue #620): the
// shared row both the live exchange and the settled card render -- the
// dataset chip on the live side, the chip + skill-drift badges on the
// settled side. One markup for both surfaces, so the settle swap keeps the
// row byte-identical. The swap still REMOUNTS the subtree (the two sides
// sit in different parent chains -- markup parity, not node reuse), but
// every member is stateless, so nothing is lost.

import type { ReactNode } from "react";

export function StreamHeader({ children }: { children: ReactNode }) {
  return (
    <div className="stream-header flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
