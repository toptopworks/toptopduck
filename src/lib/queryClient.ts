import { QueryClient } from "@tanstack/react-query";

// TanStack Query client factory (ADR-0051 state layering). Server state --
// working set / active / thread / row pages -- is the backend's truth; the
// frontend refetches ONLY via explicit invalidateQueries after a mutation, so
// the client is tuned to never auto-refetch on a desktop app's irrelevant
// signals (focus / reconnect) and to hold cached data fresh until we say so.

/** Build a fresh QueryClient. Each `<App />` mount calls this once (lazy
 * useState init) so test renders never share cache -- a leaked query from one
 * test would otherwise bleed stale data into the next. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // We invalidate explicitly after each mutation (ADR-0051); a timed
        // refetch would race the user's next action and is never wanted here.
        staleTime: Infinity,
        retry: 1,
        // A Tauri desktop shell has no meaningful "window gained focus" /
        // "network reconnected" signal -- both would trigger spurious refetches
        // of every mounted query. Disable them.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: {
        // IPC failures are usually meaningful (refused / not-configured / not-
        // found); a blind retry can double-write. Let the handler decide.
        retry: 0,
      },
    },
  });
}
