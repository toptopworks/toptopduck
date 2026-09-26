// TanStack Query key factory (ADR-0051). Every session-scoped query keys off
// `['session', sessionId, ...]` so a session close can `removeQueries({ prefix
// })` to drop the whole cache at once (ADR-0055 close tab -> removeQueries),
// and so refetch/ invalidate targets a precise slice. Session-AGNOSTIC queries
// (provider config / app config) use a different prefix and are NOT here.

/** The per-session row tuple (ADR-0051 row pages), read through the
 * useRowPage seam (issue #1079) -- a SNAPSHOT read that never joins an
 * invalidation cascade (narrative: the useRowPage module header). The
 * offset is part of the key so each page caches independently and
 * `placeholderData: keepPreviousData` can show the prior page while the
 * next loads; the limit is keyed too -- the page size is caller-variable,
 * and a differently-sized fetch must never be served from the same
 * window's cache. */
export const sessionKeys = {
  all: (sessionId: string) => ["session", sessionId] as const,
  workingSet: (sessionId: string) => ["session", sessionId, "workingSet"] as const,
  /** The detail pane's live sample preview (issue #1061): one fixed first
   *  window of the picked dataset, read through the paged channel. Nested
   *  under the workingSet prefix so the working-set mutations' invalidation
   *  refreshes it alongside the descriptor (staleTime is Infinity, ADR-0051)
   *  -- the cascade's authoritative narrative lives in the useWorkingSet
   *  module header (ADR-0123). Keyed by reference name only: the window is a
   *  fixed first-rows cap (the limit constant lives with the query owner in
   *  useWorkingSet), so there is no offset axis to distinguish. */
  previewRows: (sessionId: string, referenceName: string) =>
    ["session", sessionId, "workingSet", "previewRows", referenceName] as const,
  /** The delete-confirm dialogs' cascade-impact preview (issue #1063): the
   *  live results a source removal would mark stale, resolved to display
   *  labels. Nested under the workingSet prefix like `previewRows` so the
   *  working-set mutations' invalidation refreshes it (staleTime is
   *  Infinity, ADR-0051). Keyed by reference name; the dialog's conditional
   *  mount gates the query, so with no dialog open it simply never
   *  fetches. */
  deleteImpact: (sessionId: string, referenceName: string) =>
    ["session", sessionId, "workingSet", "deleteImpact", referenceName] as const,
  active: (sessionId: string) => ["session", sessionId, "active"] as const,
  thread: (sessionId: string) => ["session", sessionId, "thread"] as const,
  rows: (
    sessionId: string,
    referenceName: string,
    offset: number,
    limit: number,
  ) => ["session", sessionId, "rows", referenceName, offset, limit] as const,
  /** Per-session authorization posture (ADR-0080, issue #352) -- the composer
   *  auth-mode chip's read. Lives under the session prefix so a close's
   *  removeQueries drops it with the rest; a resume lands the reset value via
   *  the fresh SessionPane mount (the resume-path invalidateQueries fires
   *  against a not-yet-mounted key and is a no-op). */
  authMode: (sessionId: string) => ["session", sessionId, "authMode"] as const,
  /** Per-session runtime choice (issue #353) -- the composer runtime picker's
   *  read. Lives under the session prefix so a close's removeQueries drops it
   *  with the rest; a resume lands the RESTORED last runtime via the fresh
   *  SessionPane mount (ADR-0102 segment continuation -- unlike authMode,
   *  the runtime survives the resume; an undetected recorded adapter or a
   *  pre-#589 recipe lands built-in / the default runtime instead). */
  runtime: (sessionId: string) => ["session", sessionId, "runtime"] as const,
  /** Per-session external-runtime model config (ADR-0095, issue #527) -- the
   *  model / thought-level selectors' read (selections + the cached discovery
   *  catalog). Session-prefixed like `runtime`; a resume restores the persisted
   *  trio so the fresh mount's refetch lands the recipe values, and a runtime
   *  switch re-seeds the pair from the target adapter's backfill entry
   *  (ADR-0102 Decision 3) so the switch's invalidate lands the seeded pair. */
  modelConfig: (sessionId: string) =>
    ["session", sessionId, "modelConfig"] as const,
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
  /** Probe-catalog cache (ADR-0096 D5, issue #536): the app-data sidecar
   *  read powering the settings tab's "last tested" display. Under the
   *  adapters prefix so it groups with the adapter surface; a successful
   *  probe writes the entry back via setQueryData (the backend cache write
   *  and this key update are the same event). */
  catalogs: () => ["adapters", "catalogs"] as const,
  /** One adapter's startup model-posture backfill entry (ADR-0100, issue
   *  #581): the model + thought-level a NEW session on that adapter starts
   *  with. Keyed per adapter id (postures are adapter-namespaced, Decision
   *  2); read by the cold-start composer bar, wiped by the posture
   *  cascade's clearing row via the #581 clear IPC. Not under the session
   *  prefix: the entry is process-global, like the adapter table. */
  posture: (adapterId: string) => ["adapters", "posture", adapterId] as const,
} as const;

/** Session-AGNOSTIC skills registry (issue #362, ADR-0086) -- the keys the
 *  registry seam (src/skills/registry.ts, issue #1077) reads and invalidates.
 *  NOT under the session prefix: the registry is process-global (one root
 *  shared by every session). A close's removeQueries does not touch it. */
export const skillKeys = {
  all: () => ["skills"] as const,
  /** Import-dialog source discovery (issue #367) -- the two-stage drill-down's
   *  source-list read. Keyed by the custom-paths tuple so adding a custom path
   *  re-fetches; the standard sources (Claude Code / Codex CLI) are resolved
   *  server-side off the home dir, so the key only needs the user-controlled
   *  tail. Lives under the "skills" prefix so the registry seam's one
   *  invalidation cascades here too -- the contract's authoritative narrative
   *  lives in the registry module header. */
  sources: (customPaths: readonly string[]) =>
    ["skills", "sources", customPaths] as const,
} as const;

/** Session-AGNOSTIC agent-definitions registry (issue #932, ADR-0117) -- the
 *  settings AgentsSection list read + the create / update / delete /
 *  enablement invalidation target. Same posture as skillKeys: process-global,
 *  not under the session prefix. */
export const agentKeys = {
  all: () => ["agents"] as const,
} as const;

/** Artifact render-time facts (ADR-0124 Decision 2/4, issue #1088), keyed by
 *  ABSOLUTE PATH -- a filesystem fact, not a session slice, so two views of
 *  the same delivered file share one cache entry. NOT under the session
 *  prefix: the facts outlive any single pane mount, and a close's
 *  removeQueries dropping them is harmless (the next check re-runs). */
export const artifactKeys = {
  exists: (path: string) => ["artifact", "exists", path] as const,
  text: (path: string) => ["artifact", "text", path] as const,
} as const;
