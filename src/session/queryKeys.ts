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
  /** Per-session MCP server status (issue #301 slice D) -- the composer "+"
   *  panel's enablement read + badge count (ADR-0083, issue #351). Lives under
   *  the session prefix so a close's removeQueries drops it with the rest. */
  mcpStatus: (sessionId: string) => ["session", sessionId, "mcpStatus"] as const,
  /** Per-session authorization posture (ADR-0080, issue #352) -- the composer
   *  auth-mode chip's read. Lives under the session prefix so a close's
   *  removeQueries drops it with the rest; a resume lands the reset value via
   *  the fresh SessionPane mount (the resume-path invalidateQueries fires
   *  against a not-yet-mounted key and is a no-op). */
  authMode: (sessionId: string) => ["session", sessionId, "authMode"] as const,
  /** Per-session runtime choice (issue #353) -- the composer runtime picker's
   *  read. Lives under the session prefix so a close's removeQueries drops it
   *  with the rest; a resume lands the reset (built-in) value via the fresh
   *  SessionPane mount, mirroring authMode. */
  runtime: (sessionId: string) => ["session", sessionId, "runtime"] as const,
  /** Per-session mounted-skill names (issue #365, ADR-0086) -- the composer "+"
   *  panel's mount-set read + the trigger badge count source. Folded from the
   *  SkillLifecycleEvent timeline (Mount in / Unmount out); mount / unmount
   *  invalidate this key so the badge re-reads without a remount. Lives under
   *  the session prefix so a close's removeQueries drops it with the rest. */
  mountedSkills: (sessionId: string) => ["session", sessionId, "mountedSkills"] as const,
  /** Cold-start placeholder (ADR-0092): the shell-level bar has no session id
   *  before the first submit. The query is always enabled:false so the queryFn
   *  never runs -- the key exists only to satisfy useQuery's queryKey
   *  requirement. The sentinel segment cannot collide with a real UUID session
   *  id and is inert (never fetched, never cleaned up). */
  coldStartAuthMode: () => ["session", "__cold_start__", "authMode"] as const,
} as const;

/** Session-AGNOSTIC adapter table (issue #353) -- the composer runtime picker's
 *  list / rescan read. NOT under the session prefix: the v1 adapter table +
 *  the PATH scan are process-global, shared by every mounted picker. Kept
 *  here for discoverability alongside the session keys. */
export const adapterKeys = {
  all: () => ["adapters"] as const,
} as const;

/** Session-AGNOSTIC skills registry (issue #362, ADR-0086) -- the settings
 *  SkillsSection list read + the create / update / delete invalidation target.
 *  NOT under the session prefix: the registry is process-global (one root
 *  shared by every session). A close's removeQueries does not touch it. */
export const skillKeys = {
  all: () => ["skills"] as const,
  /** Import-dialog source discovery (issue #367) -- the two-stage drill-down's
   *  source-list read. Keyed by the custom-paths tuple so adding a custom path
   *  re-fetches; the standard sources (Claude Code / Codex CLI) are resolved
   *  server-side off the home dir, so the key only needs the user-controlled
   *  tail. Lives under the "skills" prefix so a successful import (which
   *  invalidates `skillKeys.all()`) also evicts the stale discovery read -- a
   *  previously `already_exists` skill becomes importable-shaped once its name
   *  leaves the registry, and the dialog re-reads on next open. */
  sources: (customPaths: readonly string[]) =>
    ["skills", "sources", customPaths] as const,
} as const;
