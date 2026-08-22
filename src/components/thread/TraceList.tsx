// The shared trace-list chrome (ADR-0078/0103): the left-bordered <ul> that
// hosts a round's call rows. Shared by the settled step fold's row list
// (TraceView) and the live round block (LiveTurnExchange, issue #610) so the
// settle swap does not restyle the list. The optional hookClass rides
// alongside `trace-list` as the surface's selector / test anchor -- a
// literal union (one surface passes it today), the FoldToggle seam's
// convention so a typo'd class fails at the call site.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type TraceListHookClass = "live-trace";

export function TraceList({
  hookClass,
  children,
}: {
  hookClass?: TraceListHookClass;
  children: ReactNode;
}) {
  return (
    <ul className={cn("trace-list mt-1 ml-6 list-none m-0 p-0 border-l border-border pl-2", hookClass)}>
      {children}
    </ul>
  );
}
