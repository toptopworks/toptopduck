// The sidebar's cross-session turn-failure view (issue #1005): which OPEN
// sessions' latest settled turn is Failed. Derived, never stored -- the
// thread query cache is the single source of truth (ADR-0051: the ask tail
// optimistically appends the settled TurnRecord and the turn flow never
// invalidates the thread, so the cache mirrors the latest settled turn on
// the normal channel; the known gaps are the append's own failure paths --
// a runtime-stamp throw on an unmapped choice or an ask dispatch reject
// skips the append, leaving the pane rail and this dot dark together). The
// pure predicate is shared with Thread's failed-card default-open fold: one
// "latest settled turn is Failed" semantic, two surfaces.
import { useQueries } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { conversation } from "../api";
import { sessionKeys } from "./queryKeys";
import type { ThreadEntry } from "../types/thread";

// The "latest settled turn is Failed" predicate (issue #1005): scan the
// timeline from the tail and read the FIRST turn entry -- non-Turn entries
// never settle (only the Turn variant carries an outcome), so any of them,
// source / skill lifecycle or a future kind, never displaces the verdict.
// An empty timeline (or one with no turns at all) reads as not-failed:
// nothing has settled, so nothing is wrong.
export function isLatestTurnFailed(entries: readonly ThreadEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.entry === "Turn") return entry.data.outcome.kind === "Failed";
  }
  return false;
}

export function useTurnFailureSids(
  // Explicit dep, not context: the shell calls this hook from its outer body,
  // ABOVE the QueryClientProvider -- the same posture as useShellSessions.
  queryClient: QueryClient,
  sids: readonly string[],
): ReadonlySet<string> {
  // Read-only cache subscribers: enabled: false keeps every observer off the
  // wire (each pane's own useQuery owns the fetch; a thread never taken stays
  // dark instead of being fetched into view). The observers still re-render
  // this hook when a thread cache entry lands / updates -- the optimistic
  // append, a resume's fresh read -- and a close drops the row outright:
  // removeQueries rides the same synchronous close as the open-set removal,
  // so the derive loses the sid together with the pane. The derive below
  // stays live against exactly what the panes see.
  const threadQueries = useQueries(
    {
      queries: sids.map((sid) => ({
        queryKey: sessionKeys.thread(sid),
        // Satisfies the observer's queryFn contract only; enabled: false
        // above means it can never run (the coldStartAuthMode precedent).
        queryFn: () => conversation(sid),
        enabled: false,
      })),
    },
    queryClient,
  );
  const failed = new Set<string>();
  sids.forEach((sid, i) => {
    const thread = threadQueries[i]?.data;
    if (thread !== undefined && isLatestTurnFailed(thread)) failed.add(sid);
  });
  return failed;
}
