// The shared trace-list chrome (ADR-0078/0103): the left-bordered <ul> that
// hosts a round's call rows. Shared by the settled step fold's row list
// (TraceView) and the live round block (LiveTurnExchange, issue #610) so the
// settle swap does not restyle the list -- both sides render the identical
// class string, with no surface-specific tail.

import type { ReactNode } from "react";

export function TraceList({ children }: { children: ReactNode }) {
  return (
    <ul className="trace-list mt-1 ml-6 list-none m-0 p-0 border-l border-border pl-2">
      {children}
    </ul>
  );
}
