// TanStack Query key factory (ADR-0051). Every session-scoped query keys off
// `['session', sessionId, ...]` so a session close can `removeQueries({ prefix
// })` to drop the whole cache at once (ADR-0055 close tab -> removeQueries),
// and so refetch/ invalidate targets a precise slice. Session-AGNOSTIC queries
// (provider config / app config) use a different prefix and are NOT here.

/** The per-session row tuple (ADR-0051 row pages). The offset is part of the
 * key so each page caches independently and `placeholderData: keepPreviousData`
 * can show the prior page while the next loads. */
export const sessionKeys = {
  all: (sessionId: string) => ["session", sessionId] as const,
  workingSet: (sessionId: string) => ["session", sessionId, "workingSet"] as const,
  active: (sessionId: string) => ["session", sessionId, "active"] as const,
  thread: (sessionId: string) => ["session", sessionId, "thread"] as const,
  rows: (
    sessionId: string,
    referenceName: string,
    offset: number,
  ) => ["session", sessionId, "rows", referenceName, offset] as const,
} as const;
