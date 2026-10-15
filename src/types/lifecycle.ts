// Source lifecycle shared kernel (issue #200): consumed across domains --
// thread (SourceLifecycleEvent in the timeline), dataset (StaleReason derives
// from SourceLifecycleKind), and the UI (Thread.tsx render dispatch) -- so it
// lives as a shared leaf that neither dataset nor thread owns. Mirrors the
// Rust SourceLifecycleKind / SourceLifecycleEvent.

// Which kind of source lifecycle mutation produced an event (ADR-0040/0025).
// Mirrors the Rust SourceLifecycleKind as a bare variant string (like TextKind).
// Added = every ingest; Deleted = remove (issue #38); Replaced = re-upload
// under an existing reference name (issue #41, ADR-0025).
export type SourceLifecycleKind = "Added" | "Deleted" | "Replaced";

// A source lifecycle event (ADR-0040): a user-driven mutation of the working
// set's source membership. Mirrors the Rust SourceLifecycleEvent. It is a
// first-class timeline slot but NOT a turn -- never enters the LLM window or
// advances result_N; the stale-cascade (ADR-0013) reads its kind to invalidate
// result_N entries.
export interface SourceLifecycleEvent {
  kind: SourceLifecycleKind;
  // Stable reference name (the identity SQL / recipe / active pointer use).
  reference_name: string;
  // Readable label captured at event time, so a dataset can still be named
  // after it's removed (a Deleted event shows what was deleted).
  display_name: string;
}
