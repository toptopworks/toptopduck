//! Source/skill lifecycle events and the unified conversation timeline (issue
//! #38, ADR-0040). A source or skill lifecycle event is a user-driven mutation
//! of the working set's membership -- first-class in the thread, never a turn: it
//! never enters the LLM turn window, never occupies an N=20 slot, and never
//! advances result_N.

use serde::{Deserialize, Serialize};

use super::turn::TurnRecord;

/// Which kind of source lifecycle mutation produced an event (ADR-0040/0025).
/// Mirrors the Rust enum as a bare variant string across IPC (like
/// [`TextKind`]). `Added` lands on every ingest; `Deleted` on a remove (issue
/// #38); `Replaced` on a re-upload under an existing reference name (issue
/// #41, ADR-0025 -- the name stays but the snapshot is swapped).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceLifecycleKind {
    /// A source Dataset entered the working set (ADR-0022). Appended by every
    /// ingest path after the snapshot is attached and registered.
    Added,
    /// A source Dataset left the working set (issue #38 remove path). The
    /// reference name is gone from the shared namespace; its snapshot is
    /// detached + file deleted.
    Deleted,
    /// A source Dataset's backing snapshot was swapped under the same reference
    /// name (ADR-0025, issue #41): a fresh re-upload takes over the name, the
    /// old snapshot is discarded, dependent result_N cascade stale, and this
    /// event lands in the timeline. Unlike `Deleted` the reference name stays
    /// (still queryable, now resolving to new data).
    Replaced,
}

/// A source lifecycle event (ADR-0040): first-class in the thread, never a turn.
/// Carries the reference name (stable identity, the same key SQL / the recipe
/// chain uses) and the display label (readable, captured at event time so the
/// thread can still render "删除了「Orders」" after the descriptor is gone).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLifecycleEvent {
    pub kind: SourceLifecycleKind,
    pub reference_name: String,
    pub display_name: String,
}

/// Which kind of skill lifecycle mutation produced an event (ADR-0086, issue
/// #363). The lifecycle is intentionally two-state: a skill is either Mounted
/// into the session's active set or Unmounted from it. A skill CONTENT change
/// is NOT a lifecycle event -- it is captured per-turn by each
/// [`crate::model::SkillProvenance`]'s `content_hash`, so the
/// timeline stays free of content churn (only membership changes are events).
/// Mirrors the spec's two-state identity (Mount/Unmount); the frontend narrows
/// on the bare variant string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SkillLifecycleKind {
    /// A skill entered the session's active set. Subsequent turns assemble with
    /// this skill's prompt fragment + MCP server references until it is
    /// Unmounted or the session ends.
    Mount,
    /// A skill left the session's active set. Subsequent turns no longer
    /// assemble with it; the Unmount event itself stays in the timeline for
    /// audit (the active set is folded from the full event sequence).
    Unmount,
}

/// A skill lifecycle event (ADR-0086, issue #363): first-class in the thread,
/// never a turn. Carries only the spec `name` (the skill's stable identity,
/// equal to its directory name) -- the prompt fragment / MCP references live in
/// the registry and are looked up at assembly time, never snapshotted into the
/// timeline (a skill's content evolution is captured per-turn by
/// [`crate::model::SkillProvenance::content_hash`], not by
/// lifecycle events). Isomorphic to [`SourceLifecycleEvent`]: always visible,
/// occupies a timeline slot, but never enters the LLM window or advances
/// `result_N`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillLifecycleEvent {
    pub kind: SkillLifecycleKind,
    /// The skill's spec `name` (kebab-case identity, ADR-0086 Decision 2).
    pub name: String,
}

/// One entry of the unified conversation timeline (ADR-0040 / ADR-0086): either
/// a Turn (question + outcome, ADR-0028/0039), a source lifecycle event, or a
/// skill lifecycle event. All three occupy a timeline slot and are always
/// visible; only the Turn variant enters the LLM turn window. Adjacently-tagged
/// (`#[serde(tag = "entry", content = "data")]`) so the frontend narrows on
/// `entry` uniformly. The conversation() command returns `Vec<ThreadEntry>`; the
/// window assembler receives only the turns (filtered by the session before
/// assembly), so source and skill events never reach the provider payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "entry", content = "data")]
pub enum ThreadEntry {
    Turn(TurnRecord),
    Source(SourceLifecycleEvent),
    Skill(SkillLifecycleEvent),
}

/// Why a source removal was rejected (issues #38/#39/#40). Two honest refusals
/// remain after #40 landed the stale-cascade engine: `NotFound` (no such
/// reference name) and `IsActive` (silent-jump ban, ADR-0035; explicit re-
/// selection lands in #39). Dependent results no longer block removal -- #40
/// transitively marks them stale (ADR-0013/0040), so a delete always cascades
/// instead of refusing.
/// Crosses IPC as this serde struct, wrapped in
/// [`SessionError::RemoveSource`](crate::session_store::SessionError) (issue
/// #121); the frontend narrows on `kind` and renders a locale message, so the
/// hand-written `Display` below is Rust-log-only -- NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum RemoveSourceError {
    /// No dataset carries the given reference name.
    NotFound(String),
    /// The dataset is the current focus (active source) AND other sources
    /// remain. Removing the active source would silently change the user's
    /// analysis focus -- ADR-0035 forbids a silent jump, so the caller must go
    /// through `remove_active_source` (issue #39) to name an explicit
    /// continuation. When this is the LAST source the remove path falls through
    /// to an empty working set instead (AC4, issue #39).
    IsActive {
        reference_name: String,
        display_name: String,
    },
    /// `remove_active_source` only: the named reference is not the current
    /// active source. The frontend's confirm-dialog path only fires for the
    /// active source, so reaching this branch means a stale view raced a
    /// concurrent mutation (or a direct IPC); the working set is untouched.
    NotActive(String),
    /// `remove_active_source` only: the chosen continuation reference is not a
    /// remaining source -- it is missing, equals the source being removed, or
    /// is a materialized result. The frontend's candidate list excludes all
    /// three, so this signals a stale view / direct IPC; the working set is
    /// untouched.
    InvalidContinueWith(String),
}

impl std::fmt::Display for RemoveSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        // Rust-log-only (issue #121): the IPC contract is the serde struct above
        // and the user wording lives in the frontend locale catalog, so these
        // English identifiers never reach the UI.
        match self {
            Self::NotFound(name) => write!(f, "dataset not found: {name}"),
            Self::IsActive { display_name, .. } => {
                write!(
                    f,
                    "source is the active focus: {display_name}; pick a continuation first"
                )
            }
            Self::NotActive(name) => write!(f, "source not the active focus: {name}"),
            Self::InvalidContinueWith(name) => {
                write!(f, "invalid continuation: {name} is not a remaining source")
            }
        }
    }
}
impl std::error::Error for RemoveSourceError {}
