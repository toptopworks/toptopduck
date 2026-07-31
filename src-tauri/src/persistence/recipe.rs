//! Recipe model (ADR-0034/0036/0042): the durable, portable description of a
//! Session's current working set. A `.duck` file is this recipe serialized as
//! text (JSON). The recipe holds only what resume needs to rebuild the working
//! set -- never the materialized result data (re-derived by eager replay),
//! never the LLM viz state (regenerated on demand, ADR-0033/0036), never any
//! execution metadata (token / row-count / timing, ADR-0036), and never any
//! secret (ADR-0036 secrets-never -- the BYOK key rides the OS keychain).
//!
//! The conversation timeline mirrors [`crate::model::ThreadEntry`] but trims
//! every field resume re-derives: a Materialized turn carries the result
//! reference name, the display label, the verbatim SQL, and the assumption
//! note -- but NOT the columns / sample / row-count / fingerprint / viz (all
//! rebuilt by replay). Source lifecycle events pass through verbatim
//! (ADR-0040). The productive replay chain is derived from this history at
//! resume time, so the recipe has one source of truth, not two.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::approval::OperationKind;
use crate::model::{
    RectifyProvenance, SourceLifecycleEvent, SourceLifecycleKind, StaleAnchor, TextKind,
    TurnFailure,
};

/// Recipe format version (ADR-0036). Opening routes on this value: equal
/// -> normal; lower -> forward-migrate; higher -> honest refuse. v1's
/// `RecipeOutcome::Failed` carries the typed [`TurnFailure`] (issue #125) so
/// the failure kind survives save/resume and renders via the frontend locale.
/// The app is unreleased, so widening the Failed shape in place under v1 needed
/// no migration transform.
///
/// v2 (ADR-0082, issue #296) adds the persisted execution trace + turn
/// provenance to the display part ([`RecipeTurn::trace`] /
/// [`RecipeTurn::provenance`]), and reframes the reconstructable part as the
/// materialized promotion chain (each productive SQL is one promotion entry --
/// the chain is still derived from `history` at resume time, replay semantics
/// unchanged, ADR-0035). The v1->v2 mapping is lossless and trivial: a v1
/// Materialized turn becomes one promotion entry and gains a synthetic
/// single-call trace; older clients reading a v2 file hit the existing
/// higher-version honest-refuse path (ADR-0036).
pub const RECIPE_FORMAT_VERSION: u32 = 2;

/// One source Dataset's portable reference (ADR-0034/0036/0042). Paths use
/// the **hybrid representation** ADR-0036 §4 mandates: `source_path` is always
/// absolute (the fallback resolver); `relative_path` is set when the source
/// lives inside the `.duck` file's directory subtree (the primary resolver --
/// it survives "move the folder" portability). Cross-volume / outside-subtree
/// sources carry `relative_path = None`, and resume falls back to
/// `source_path`. Both forms undergo fingerprint verification (ADR-0035).
///
/// The rectify choices are the user's explicit decisions (CSV/JSON/Parquet =
/// N/A; Excel carries the user header/skip decisions, never the auto-tidy
/// algorithm), and the fingerprint is the content hash of the post-rectify
/// snapshot (resumed read-only, fixed by re-upload). The display label rides
/// along so a user rename survives resume (ADR-0037 display-layer only -- the
/// reference name is the stable identity SQL / the chain / the active pointer
/// use).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub reference_name: String,
    pub display_name: String,
    /// Absolute filesystem path -- the always-present fallback resolver
    /// (ADR-0036 §4). Older v1 recipes written before hybrid paths land here
    /// and resume treats them as absolute-only.
    pub source_path: String,
    /// Path relative to the `.duck` file's directory, when the source lives in
    /// that subtree (ADR-0036 §4). `None` when the source is outside the
    /// subtree or on a different volume (where a relative path is not
    /// expressible). Resume tries this first, then `source_path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub rectify: RectifyProvenance,
    pub fingerprint: String,
}

/// One productive turn in the replayable chain (ADR-0034): the `result_N`
/// reference name (stable identity), the user-facing display label (so a
/// rename survives resume, ADR-0037), the verbatim SQL (re-executed on resume
/// to re-materialize `result_N`, ADR-0009), and the optional assumption note
/// (ADR-0009). The viz spec is deliberately absent -- viz is not persisted
/// (ADR-0036), so a reopened chart renders as a table until the user
/// re-requests one (ADR-0033).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductiveTurn {
    pub reference_name: String,
    pub display_name: String,
    pub sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assumption: Option<String>,
}

/// The recipe's conversation timeline (ADR-0028/0039/0040): every turn AND
/// every source lifecycle event, always visible, in order. A trimmed mirror
/// of [`crate::model::ThreadEntry`] -- a Turn entry drops materialized
/// descriptor fields resume re-derives; a Source entry passes through
/// verbatim (ADR-0040 first-class timeline slot, never enters the LLM
/// window). Adjacently-tagged so a future reader narrows on `entry`
/// uniformly, mirroring the IPC `ThreadEntry` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "entry", content = "data")]
pub enum RecipeEntry {
    Turn(RecipeTurn),
    Source(SourceLifecycleEvent),
}

/// One entry in a turn's persisted execution trace (ADR-0078). The trace is a
/// persisted, collapsible substructure of the turn; the far window carries only
/// a summary (call count + failure summary), never the full trace verbatim. This
/// is the recipe form of the agent loop's in-memory trace entry minus the
/// ephemeral `tool_use_id` (a per-provider-call id that does not survive the
/// turn, let alone a save/resume).
///
/// v1-era turns predate the agent loop and carry no recorded trajectory; the
/// v1->v2 migration and [`Recipe::build_recipe`] synthesize a single-call trace
/// for each Materialized turn (one `materialize` entry from the verbatim SQL),
/// so a reopened v1 session shows the same one-step trajectory the single-SQL
/// contract produced live. Real multi-call traces arrive once the agent-loop
/// wiring slice drives live turns (ADR-0081); that slice populates this field
/// with the loop's recorded calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeTraceEntry {
    /// Tool name -- a built-in (`explore` / `materialize` / `describe` /
    /// `sample`) or an external MCP server's tool name.
    pub name: String,
    /// Operation badge (ADR-0080 read/write/execute/network) -- presentation
    /// only. Reuses the approval-gateway classification so a reopened turn
    /// renders the same badge the live approval card did.
    pub operation_kind: OperationKind,
    /// Short argument summary (the SQL or reference_name), NOT the full args.
    pub summary: String,
    /// Whether the call succeeded. A tool-level error routes back to the agent
    /// (ADR-0077); the trace records the failure for audit + cross-turn
    /// debugging.
    pub success: bool,
    /// Bounded excerpt of the tool result (or the denial / error message).
    pub result_excerpt: String,
}

/// Which runtime drove a turn (ADR-0078/0081). Recorded on each turn's
/// [`TurnProvenance`] so the thread can surface "this answer came from the
/// built-in loop / an external CLI agent" -- the audit anchor for how a result
/// was produced.
///
/// The legacy single-SQL `TurnRunner` predates runtime tracking and writes
/// `None` (see [`TurnProvenance`]); only the agent-loop runtimes get a typed
/// value here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeKind {
    /// The app's own Rust-native agent loop (ADR-0081), driven by the active
    /// BYOK profile. Key never leaves the process.
    BuiltIn,
    /// A third-party CLI agent process the app launched (ADR-0081), using its
    /// own auth -- the app's BYOK key is never injected.
    External,
}

/// Provenance of a turn's execution context (ADR-0078): which runtime produced
/// it and which skills were active at assembly time. The persisted audit anchor
/// for "how was this answer produced".
///
/// Both fields are optional / empty by default. v1-era turns (migrated or
/// TurnRunner-live) carry no runtime or skill provenance, and
/// [`Recipe::build_recipe`] writes the default until the agent-loop wiring slice
/// populates real values. `#[serde(default)]` keeps older v2 recipes (and the
/// migration output) deserializing cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TurnProvenance {
    /// The runtime that drove this turn (ADR-0081), or `None` for turns created
    /// before runtime tracking (v1 migrated, or TurnRunner-era live turns).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeKind>,
    /// The active skill ids at this turn's assembly time (ADR-0079/0040).
    /// Empty when no skills were mounted or skill tracking is not yet wired.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
}

impl TurnProvenance {
    /// Whether this provenance carries no information (no runtime, no skills).
    /// Used by `skip_serializing_if` so a v2 recipe omits the field for turns
    /// with no recorded provenance, keeping the `.duck` file lean.
    fn is_empty(&self) -> bool {
        self.runtime.is_none() && self.skills.is_empty()
    }
}

/// Maximum length of a trace entry's argument summary (ADR-0078). The single
/// source for the trace-summary truncation cap: both the synthetic single-call
/// trace (this module's [`synthetic_materialize_trace`]) and the agent loop's
/// live `materialize` summary (`summarize_field`) reuse it, so a reopened v1
/// turn and a fresh live turn persist the same truncation shape.
pub(crate) const TRACE_SUMMARY_MAX: usize = 120;

/// Synthesize the single-call execution trace for a Materialized turn's SQL
/// (ADR-0078). v1-era turns ran exactly one productive SQL under the single-SQL
/// contract, so their trajectory is one `materialize` call -- both the v1->v2
/// migration and [`Recipe::build_recipe`] use this helper so a reopened v1
/// session shows the same one-step trajectory it produced live, and a fresh
/// TurnRunner-era turn persists the same shape. The summary is the verbatim SQL
/// truncated to [`TRACE_SUMMARY_MAX`].
pub(crate) fn synthetic_materialize_trace(sql: &str) -> Vec<RecipeTraceEntry> {
    vec![RecipeTraceEntry {
        name: crate::tools::definitions::TOOL_MATERIALIZE.to_string(),
        operation_kind: OperationKind::Write,
        summary: truncate_trace_summary(sql),
        success: true,
        result_excerpt: String::new(),
    }]
}

/// Truncate a trace-entry summary string to [`TRACE_SUMMARY_MAX`] chars,
/// appending an ellipsis when cut. Shared by [`synthetic_materialize_trace`]
/// and the agent loop's live `materialize` summary (`summarize_field`) so a
/// persisted trace never bloats the `.duck` file while staying recognizable.
pub(crate) fn truncate_trace_summary(s: &str) -> String {
    if s.chars().count() <= TRACE_SUMMARY_MAX {
        s.to_string()
    } else {
        let head: String = s
            .chars()
            .take(TRACE_SUMMARY_MAX.saturating_sub(1))
            .collect();
        format!("{head}…")
    }
}

/// One turn in the recipe timeline (ADR-0028): the verbatim question paired
/// with a trimmed outcome. Every turn is recorded regardless of outcome --
/// "no result" is itself a typed outcome, never a silent gap (ADR-0028
/// always-visible).
///
/// v2 (ADR-0078/0082) adds two persisted substructures: the execution
/// [`trace`](Self::trace) (collapsible; the far window carries only its summary)
/// and the [`provenance`](Self::provenance) (runtime + active skills). Both
/// default empty for v1-era turns; see their own docs for the v1->v2 mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeTurn {
    pub question: String,
    pub outcome: RecipeOutcome,
    /// The persisted execution trace (ADR-0078): every tool call the turn made
    /// (explore / materialize / external), each with its operation badge,
    /// argument summary, success flag, and a bounded result excerpt. Collapsible
    /// in the thread rail; never enters the far window verbatim. Empty for
    /// no-tool turns (a textual refuse with no exploration); a Materialized
    /// turn carries a synthetic single-call trace (see
    /// [`synthetic_materialize_trace`]) until real multi-call traces arrive
    /// with the agent-loop wiring.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trace: Vec<RecipeTraceEntry>,
    /// The turn's runtime + skill provenance (ADR-0078). Default (no runtime,
    /// no skills) for v1-era turns until the agent-loop wiring slice populates
    /// real values.
    #[serde(default, skip_serializing_if = "TurnProvenance::is_empty")]
    pub provenance: TurnProvenance,
}

impl RecipeTurn {
    /// Construct a turn with an empty trace and default provenance. The shape
    /// every no-tool / pre-agent-loop turn persists with: a Textual / Failed /
    /// Cancelled outcome has no trace, and runtime / skill tracking is not yet
    /// wired on the live path. [`Recipe::build_recipe`] is today the only site
    /// that sets a non-default trace (a Materialized turn's synthetic
    /// single-call trace) and constructs `RecipeTurn` via a struct literal.
    pub fn new(question: impl Into<String>, outcome: RecipeOutcome) -> Self {
        Self {
            question: question.into(),
            outcome,
            trace: Vec::new(),
            provenance: TurnProvenance::default(),
        }
    }
}

/// A trimmed turn outcome (ADR-0028 four-way classification). The live
/// [`crate::model::TurnOutcome::Materialized`] carries the full dataset
/// descriptor (columns / sample / row-count / fingerprint) plus the viz spec;
/// the recipe form carries only the stable identity (reference name), the
/// display label, the verbatim SQL, and the assumption -- everything else is
/// rebuilt by eager replay (ADR-0034) or dropped because not persisted
/// (ADR-0036 viz / execution metadata).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum RecipeOutcome {
    /// Outcome A -- a result turn. Replayed on resume to re-materialize
    /// `result_N` (reusing the same number, ADR-0022) UNLESS `stale` is set.
    Materialized {
        reference_name: String,
        display_name: String,
        sql: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assumption: Option<String>,
        /// ADR-0041 stale marker (issue #52). `None` = live turn, replayed on
        /// resume. `Some(anchor)` = the result_N was cascade-invalidated by a
        /// source replace/remove -- a dead turn: kept in the timeline for
        /// display and the LLM window (ADR-0041 point 2 -- the verbatim SQL
        /// stays visible so the user / model can reference the prior logic),
        /// but excluded from [`Recipe::productive_chain`] so resume never
        /// re-executes it. The anchor carries the invalidating source event's
        /// identity + reason (ADR-0040 traceability), so the stale badge
        /// renders the same way after resume as it did live.
        /// `#[serde(default)]` so a pre-#52 v1 recipe (whose stale turns were
        /// dropped at write time under the old contract) deserializes as live.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stale: Option<StaleAnchor>,
    },
    /// Outcome B -- a textual turn (ADR-0017 refuse / ADR-0018 clarify).
    /// Statically rendered on resume; the disambiguation choice is already
    /// in the body, so the user is never re-asked (ADR-0034).
    Textual {
        text_kind: TextKind,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assumption: Option<String>,
    },
    /// Outcome C -- a failed turn (ADR-0028). Statically rendered via the typed
    /// [`TurnFailure`] kind (issue #125); the turn is NOT re-executed. The kind
    /// round-trips so a resumed failure renders with the same locale message it
    /// had live, not a flattened backend string.
    Failed(TurnFailure),
    /// Outcome D -- a cancelled turn (ADR-0021/0028). Statically rendered.
    Cancelled,
}

/// The recipe (ADR-0034): the current working set as a portable text
/// document. Organized by current state, not as a historical ledger -- a
/// removed source is absent from `sources`, and a stale (cascade-invalidated)
/// result_N's turn stays in `history` marked stale (ADR-0041 point 2: kept
/// for display + the LLM window, never replayed) rather than being silently
/// dropped. Every no-result turn and every source lifecycle event is always
/// visible (ADR-0040).
///
/// **Construction invariant:** a `Recipe` is built
/// only through [`Recipe::build`] on the write path ([`Session::build_recipe`])
/// or deserialized via [`crate::persistence::io::read_duck`] (which routes on
/// `format_version` and deduplicates source names). `format_version` is the
/// one PRIVATE field: it is always [`RECIPE_FORMAT_VERSION`] (pinned by
/// `build`, never caller-settable), so a struct-literal construction from
/// outside this module is impossible (Rust requires every field reachable for
/// a literal) -- external code MUST go through `build` (validated) or serde
/// (reader-checked). The other fields stay `pub` for read access (mirroring
/// `SourceRef` / `RecipeEntry`, whose fields are `pub`); the strong guarantee
/// -- "no illegal state reaches disk" -- is carried by the private
/// `format_version` + `build`'s validation, not by field-level encapsulation.
/// Serde still (de)serializes `format_version` because the derive lives in
/// this module -- the field rides the `.duck` file for version routing
/// (ADR-0036), even though the Rust value is the constant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Recipe {
    /// Format version (ADR-0036). v1 today; opening refuses a higher version
    /// honestly so a newer-made file is never silently mis-parsed. Private --
    /// always [`RECIPE_FORMAT_VERSION`], pinned by [`Recipe::build`].
    format_version: u32,
    pub session_name: String,
    /// The currently-loaded source Datasets (ADR-0034 current source set):
    /// each is re-read on resume and its post-rectify fingerprint verified
    /// (ADR-0035/0042). A removed source is absent; a replaced one keeps the
    /// name with the new fingerprint.
    pub sources: Vec<SourceRef>,
    /// The full conversation timeline (ADR-0028/0039/0040): every turn +
    /// every source lifecycle event, always visible, pure-append. The
    /// productive replay chain is derived from this at resume time
    /// ([`Self::productive_chain`]).
    pub history: Vec<RecipeEntry>,
    /// The active-SOURCE pointer as a reference name (ADR-0035/0037): the
    /// source the user last focused on at the source layer, stable across
    /// renames. This is distinct from `Session::active()` -- the user's
    /// current focus, derived by `window::resolve_active` as the latest result
    /// if any, else the active source. Resume rebuilds the working set + turn
    /// timeline deterministically, so `resolve_active` reproduces the same
    /// focus without persisting it. The source pointer is persisted because it
    /// can diverge from "most-recently-registered source" once the user
    /// explicitly picks a continuation source after deleting the active one
    /// (issue #39, ADR-0035 no-silent-fallback); that choice must survive
    /// resume. `None` when the working set is empty (the last source was
    /// removed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
}

/// Why [`Recipe::build`] rejected a proposed recipe.
/// Each variant names the offending field so the caller (today only
/// [`crate::session::Session::build_recipe`], the single write point) surfaces
/// a precise invariant violation rather than a generic "invalid recipe" --
/// the violations are unreachable on the live write path (the working set's
/// own invariants already guarantee these), so reaching a variant signals a
/// logic bug or a hand-edited recipe fed back through the constructor.
#[derive(Debug)]
pub enum RecipeError {
    /// `active` names a reference that is not in `sources` (and is not
    /// `None`). A live [`Session::build_recipe`] cannot produce this -- the
    /// active pointer always tracks a registered source -- so it signals a
    /// bug or external tampering.
    ActiveNotInSources { active: String },
    /// Two `Materialized` turns in `history` share a `reference_name`.
    /// `result_N` numbering is never-reused (ADR-0022), so a duplicate is
    /// always corrupt and must not silently reach the replay chain (one turn
    /// would shadow the other on resume).
    DuplicateResultReference { reference_name: String },
    /// A source-lifecycle event in `history` carries an empty `reference_name`
    /// -- minimal reference-name validation. Full lifecycle consistency
    /// (Added-before-Deleted ordering, etc.) is enforced by the live write
    /// path and deferred here; an empty name is the unambiguous corruption
    /// signal. Carries the offending event's history `index` and `kind` so a
    /// hand-edited recipe's corruption can be pinpointed without re-scanning
    /// the timeline.
    EmptySourceEventReference {
        index: usize,
        kind: SourceLifecycleKind,
    },
}

impl std::fmt::Display for RecipeError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::ActiveNotInSources { active } => write!(
                f,
                "活跃指针指向未注册的源「{active}」（active 必须为 None 或 sources 内的名字）"
            ),
            Self::DuplicateResultReference { reference_name } => write!(
                f,
                "history 中存在重复的 Materialized 引用名「{reference_name}」（result_N 不可复用）"
            ),
            Self::EmptySourceEventReference { index, kind } => write!(
                f,
                "history 第 {index} 个条目是引用名为空的源生命周期事件（{kind:?}）"
            ),
        }
    }
}
impl std::error::Error for RecipeError {}

impl Recipe {
    /// Construct a recipe with the cross-field invariants validated. This is
    /// the SINGLE write point -- [`Session::build_recipe`]
    /// calls it, and no other production path constructs a `Recipe` (the open
    /// path goes through serde deserialize, which `read_duck`'s version routing
    /// and duplicate-source check guards). The constructor is the Rust-side
    /// mirror of the parse-time checks in `read_duck`: it makes the illegal
    /// states unrepresentable from the write side too, so a future internal
    /// caller cannot persist a recipe the reader would reject.
    ///
    /// `format_version` is NOT a parameter -- it is always pinned to
    /// [`RECIPE_FORMAT_VERSION`] (ADR-0036); the caller has no business
    /// choosing it, and pinning it here removes the last field a struct
    /// literal could otherwise mis-set.
    ///
    /// Validated:
    /// - `active` is `None` or names an entry in `sources`.
    /// - Every `Materialized` turn's `reference_name` is unique in `history`
    ///   (ADR-0022 result_N never-reused).
    /// - Every source-lifecycle event in `history` carries a non-empty
    ///   `reference_name` (minimal reference-name check; full lifecycle ordering is
    ///   the write path's responsibility).
    pub fn build(
        session_name: String,
        sources: Vec<SourceRef>,
        history: Vec<RecipeEntry>,
        active: Option<String>,
    ) -> Result<Recipe, RecipeError> {
        if let Some(name) = active.as_deref() {
            if !sources.iter().any(|s| s.reference_name == name) {
                return Err(RecipeError::ActiveNotInSources {
                    active: name.to_string(),
                });
            }
        }
        let mut seen_results: HashSet<String> = HashSet::new();
        for (index, entry) in history.iter().enumerate() {
            match entry {
                RecipeEntry::Turn(turn) => {
                    if let RecipeOutcome::Materialized { reference_name, .. } = &turn.outcome {
                        if !seen_results.insert(reference_name.clone()) {
                            return Err(RecipeError::DuplicateResultReference {
                                reference_name: reference_name.clone(),
                            });
                        }
                    }
                }
                RecipeEntry::Source(ev) => {
                    if ev.reference_name.is_empty() {
                        return Err(RecipeError::EmptySourceEventReference {
                            index,
                            kind: ev.kind,
                        });
                    }
                }
            }
        }
        Ok(Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name,
            sources,
            history,
            active,
        })
    }

    /// The format version this recipe carries (ADR-0036). Always
    /// [`RECIPE_FORMAT_VERSION`] for a recipe built via [`Recipe::build`] or
    /// read through [`crate::persistence::io::read_duck`] (which routes on the
    /// file's version before deserializing). Exposed as an accessor because
    /// the field is private (caller-settable versions are illegal).
    pub fn format_version(&self) -> u32 {
        self.format_version
    }

    /// The still-valid productive chain (ADR-0034/0041): the LIVE Materialized
    /// turns in timeline order -- stale ones (`stale: Some`) are dead turns
    /// (ADR-0041 point 1) and never replayed. This is what resume re-executes:
    /// one SQL per entry, reusing the `result_N` numbering (ADR-0022). Stale
    /// turns remain in `history` for display + the LLM window (point 2) but are
    /// absent here, so the replay chain is exactly the live derivations.
    pub fn productive_chain(&self) -> Vec<ProductiveTurn> {
        self.history
            .iter()
            .filter_map(|entry| match entry {
                RecipeEntry::Turn(turn) => match &turn.outcome {
                    RecipeOutcome::Materialized {
                        reference_name,
                        display_name,
                        sql,
                        assumption,
                        stale: None,
                    } => Some(ProductiveTurn {
                        reference_name: reference_name.clone(),
                        display_name: display_name.clone(),
                        sql: sql.clone(),
                        assumption: assumption.clone(),
                    }),
                    // Stale dead turn (ADR-0041) -- display-only, not replayed.
                    RecipeOutcome::Materialized { stale: Some(_), .. } => None,
                    _ => None,
                },
                RecipeEntry::Source(_) => None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SourceLifecycleEvent, SourceLifecycleKind, StaleAnchor, StaleReason};

    fn csv_source(name: &str, fp: &str) -> SourceRef {
        SourceRef {
            reference_name: name.to_string(),
            display_name: name.to_string(),
            source_path: format!("/data/{name}.csv"),
            relative_path: None,
            rectify: RectifyProvenance::NotApplicable,
            fingerprint: fp.to_string(),
        }
    }

    fn build_recipe() -> Recipe {
        // Two sources, one productive result turn, one textual no-result
        // turn, and an Added source event -- the minimal shape the tracer
        // bullet's black-box test drives.
        Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "分析 A".to_string(),
            sources: vec![csv_source("people", "fp-people")],
            history: vec![
                RecipeEntry::Source(SourceLifecycleEvent {
                    kind: SourceLifecycleKind::Added,
                    reference_name: "people".into(),
                    display_name: "people".into(),
                }),
                RecipeEntry::Turn(RecipeTurn::new(
                    "多少人",
                    RecipeOutcome::Materialized {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: "SELECT COUNT(*) AS n FROM \"people\".data".into(),
                        assumption: None,
                        stale: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::new(
                    "哪种名字",
                    RecipeOutcome::Textual {
                        text_kind: TextKind::Clarify,
                        body: "按姓还是名？".into(),
                        assumption: None,
                    },
                )),
            ],
            // active points at a SOURCE name (ADR-0035), never a result_N.
            active: Some("people".into()),
        }
    }

    #[test]
    fn recipe_round_trips_through_json() {
        // The recipe survives a serialize -> deserialize cycle byte-for-byte
        // (equality), so the .duck file written on save reads back identically
        // on resume -- the foundation of the persistence contract.
        let recipe = build_recipe();
        let json = serde_json::to_string(&recipe).expect("serialize");
        let back: Recipe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, recipe);
    }

    #[test]
    fn recipe_format_version_is_two() {
        // ADR-0082 (issue #296): v2 carries format_version = 2. Pin the constant
        // so the open-path version check stays in sync with what save writes.
        assert_eq!(RECIPE_FORMAT_VERSION, 2);
        assert_eq!(build_recipe().format_version, 2);
    }

    #[test]
    fn productive_chain_lists_materialized_turns_in_order() {
        // ADR-0034: the replayable chain is the Materialized turns, in
        // timeline order. Source events and no-result turns are absent --
        // they are display-only, never re-executed (ADR-0034).
        let recipe = build_recipe();
        let chain = recipe.productive_chain();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].reference_name, "result_1");
        assert_eq!(chain[0].sql, "SELECT COUNT(*) AS n FROM \"people\".data");
    }

    #[test]
    fn productive_chain_preserves_order_across_multiple_results() {
        // Two productive turns replay in timeline order so the second can
        // FROM the first's result_N (chained derivation, ADR-0003).
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "s".into(),
            sources: vec![csv_source("people", "fp")],
            history: vec![
                RecipeEntry::Turn(RecipeTurn::new(
                    "q1",
                    RecipeOutcome::Materialized {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: "SELECT 1".into(),
                        assumption: None,
                        stale: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::new(
                    "q2",
                    RecipeOutcome::Materialized {
                        reference_name: "result_2".into(),
                        display_name: "result_2".into(),
                        sql: "SELECT * FROM \"result_1\"".into(),
                        assumption: None,
                        stale: None,
                    },
                )),
            ],
            active: Some("people".into()),
        };
        let chain = recipe.productive_chain();
        assert_eq!(
            chain
                .iter()
                .map(|t| t.reference_name.clone())
                .collect::<Vec<_>>(),
            vec!["result_1".to_string(), "result_2".to_string()]
        );
    }

    #[test]
    fn serialized_recipe_carries_no_secrets_or_materialized_data() {
        // ADR-0036 secrets-never + contents boundary: the .duck text must
        // never carry an API key, a materialized result's columns / sample /
        // row-count / fingerprint, or a viz spec. The recipe type prevents
        // these structurally (no such fields exist), but this test pins that
        // invariant at the serialization boundary -- a future field added to
        // ProductiveTurn / RecipeOutcome::Materialized must not leak these.
        let recipe = build_recipe();
        let json = serde_json::to_string(&recipe).expect("serialize");
        // Secret-like tokens that must never appear.
        assert!(!json.contains("api_key"), "no api_key field");
        assert!(!json.contains("sk-"), "no key-like token");
        // Materialized-data fields of a result_N descriptor -- resume re-
        // derives these, so they must not persist.
        assert!(!json.contains("columns"), "no columns field");
        assert!(!json.contains("sample"), "no sample field");
        assert!(!json.contains("row_count"), "no row_count field");
        // viz is not persisted (ADR-0036); only the assumption note is.
        assert!(!json.contains("viz"), "no viz field");
    }

    #[test]
    fn recipe_accepts_empty_working_set() {
        // ADR-0035: the last source can be removed to an empty working set,
        // and that state must persist + resume. Empty sources + None active +
        // empty history is a valid recipe.
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "空".into(),
            sources: Vec::new(),
            history: Vec::new(),
            active: None,
        };
        let json = serde_json::to_string(&recipe).expect("serialize");
        let back: Recipe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, recipe);
    }

    /// Helper: a Materialized outcome with an explicit stale anchor (the shape
    /// `build_recipe` writes for a cascade-invalidated result_N, issue #52).
    fn stale_materialized(
        reference_name: &str,
        sql: &str,
        anchor_ref: &str,
        reason: StaleReason,
    ) -> RecipeOutcome {
        RecipeOutcome::Materialized {
            reference_name: reference_name.into(),
            display_name: reference_name.into(),
            sql: sql.into(),
            assumption: None,
            stale: Some(StaleAnchor {
                reference_name: anchor_ref.into(),
                display_name: anchor_ref.into(),
                reason,
            }),
        }
    }

    #[test]
    fn productive_chain_excludes_stale_materialized_turns() {
        // ADR-0041 point 1 (issue #52): a stale result_N is a dead turn --
        // kept in history (point 2) but NEVER replayed. With one live and one
        // stale Materialized turn, productive_chain returns only the live one.
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "stale-chain".into(),
            sources: vec![csv_source("people", "fp")],
            history: vec![
                RecipeEntry::Turn(RecipeTurn::new(
                    "live",
                    RecipeOutcome::Materialized {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: "SELECT 1".into(),
                        assumption: None,
                        stale: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::new(
                    "stale",
                    stale_materialized(
                        "result_2",
                        "SELECT * FROM \"people\".data",
                        "people",
                        StaleReason::Replaced,
                    ),
                )),
            ],
            active: Some("people".into()),
        };
        let chain = recipe.productive_chain();
        assert_eq!(
            chain
                .iter()
                .map(|t| t.reference_name.clone())
                .collect::<Vec<_>>(),
            vec!["result_1".to_string()],
            "stale turn excluded from the replay chain"
        );
    }

    #[test]
    fn stale_materialized_turn_round_trips_with_anchor() {
        // ADR-0041 point 2 (issue #52): the stale turn (with its anchor) must
        // survive serialize -> deserialize so resume can rebuild the timeline
        // AND mark the result_N stale in the working set. A dropped or
        // truncated anchor would silently lose the stale badge after reopen.
        let turn = RecipeTurn::new(
            "stale",
            stale_materialized(
                "result_2",
                "SELECT COUNT(*) FROM \"orders\".data",
                "orders",
                StaleReason::Deleted,
            ),
        );
        let json = serde_json::to_string(&turn).expect("serialize");
        let back: RecipeTurn = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, turn);
        // The anchor's reason is preserved (not defaulted back to Deleted).
        match &back.outcome {
            RecipeOutcome::Materialized { stale: Some(a), .. } => {
                assert_eq!(a.reason, StaleReason::Deleted);
                assert_eq!(a.reference_name, "orders");
            }
            other => panic!("expected stale Materialized, got {other:?}"),
        }
    }

    /// Pre-#52 forward-compat (issue #52): a v1 recipe written before the
    /// `stale` field existed omits it on disk. `#[serde(default)]` must
    /// deserialize such a turn as live (`stale: None`) -- removing the default
    /// would break reopening every pre-#52 .duck file with a cryptic
    /// "missing field `stale`" error. Pins the load-bearing serde attribute.
    #[test]
    fn materialized_outcome_without_stale_field_deserializes_as_live() {
        let json = r#"{"kind":"Materialized","data":{"reference_name":"result_1","display_name":"result_1","sql":"SELECT 1"}}"#;
        let back: RecipeOutcome = serde_json::from_str(json).expect("deserialize pre-#52 form");
        match back {
            RecipeOutcome::Materialized { stale: None, .. } => {}
            other => panic!("expected live Materialized (stale: None), got {other:?}"),
        }
    }

    /// ADR-0041 ordering invariant (issue #52): an interleaved chain
    /// (live, stale, live) keeps both live turns in timeline order and drops
    /// only the stale middle one. Single-stale coverage above does not
    /// generalize to the interleaved case without this test.
    #[test]
    fn productive_chain_keeps_interleaved_live_stale_live_in_order() {
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "interleaved".into(),
            sources: vec![csv_source("people", "fp")],
            history: vec![
                RecipeEntry::Turn(RecipeTurn::new(
                    "first live",
                    RecipeOutcome::Materialized {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: "SELECT 1".into(),
                        assumption: None,
                        stale: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::new(
                    "stale middle",
                    stale_materialized(
                        "result_2",
                        "SELECT * FROM \"people\".data",
                        "people",
                        StaleReason::Replaced,
                    ),
                )),
                RecipeEntry::Turn(RecipeTurn::new(
                    "live after gap",
                    RecipeOutcome::Materialized {
                        reference_name: "result_3".into(),
                        display_name: "result_3".into(),
                        sql: "SELECT 3".into(),
                        assumption: None,
                        stale: None,
                    },
                )),
            ],
            active: Some("people".into()),
        };
        let chain = recipe.productive_chain();
        assert_eq!(
            chain
                .iter()
                .map(|t| t.reference_name.clone())
                .collect::<Vec<_>>(),
            vec!["result_1".to_string(), "result_3".to_string()],
            "interleaved chain keeps live turns in order, skips the stale middle",
        );
    }

    // --- Recipe::build invariant constructor ------------------------------------
    //
    // The constructor makes the cross-field illegal states unrepresentable from
    // the write side. The happy path is covered implicitly by every other test
    // above (they construct via struct literal in-module, but Session's live
    // write path goes through build); these tests pin the rejection branches so
    // a future loosening of build() fails loudly here rather than silently
    // persisting a recipe read_duck would later reject.

    #[test]
    fn build_accepts_a_valid_recipe_and_pins_format_version() {
        // The minimal valid shape: one source, the active pointer inside it,
        // one productive turn. format_version comes from the constant -- the
        // caller does not pass it.
        let recipe = Recipe::build(
            "valid".into(),
            vec![csv_source("people", "fp")],
            vec![RecipeEntry::Turn(RecipeTurn::new(
                "多少人",
                RecipeOutcome::Materialized {
                    reference_name: "result_1".into(),
                    display_name: "result_1".into(),
                    sql: "SELECT 1".into(),
                    assumption: None,
                    stale: None,
                },
            ))],
            Some("people".into()),
        )
        .expect("valid recipe builds");
        assert_eq!(recipe.format_version(), RECIPE_FORMAT_VERSION);
        assert_eq!(recipe.active.as_deref(), Some("people"));
    }

    #[test]
    fn build_accepts_none_active_for_an_empty_working_set() {
        // ADR-0035: empty sources + None active is a valid recipe (the last
        // source was removed). build must not reject it.
        let recipe = Recipe::build("空".into(), Vec::new(), Vec::new(), None)
            .expect("empty working set builds");
        assert!(recipe.sources.is_empty());
        assert!(recipe.active.is_none());
    }

    #[test]
    fn build_rejects_active_pointing_at_an_unregistered_source() {
        // active must be None or name a source in `sources`. A name that is
        // neither -- here a result_N mistaken for a source -- is the exact
        // corruption struct-literal construction used to allow (the in-module
        // helpers above were corrected for it). build closes the hole.
        let err = Recipe::build(
            "bad-active".into(),
            vec![csv_source("people", "fp")],
            Vec::new(),
            Some("result_1".into()),
        )
        .unwrap_err();
        match err {
            RecipeError::ActiveNotInSources { active } => {
                assert_eq!(active, "result_1");
            }
            other => panic!("expected ActiveNotInSources, got {other:?}"),
        }
    }

    #[test]
    fn build_rejects_a_duplicate_materialized_reference_name() {
        // ADR-0022 result_N is never reused. Two Materialized turns sharing a
        // name would shadow one another on the replay chain; build refuses.
        let dup_turn = RecipeTurn::new(
            "q",
            RecipeOutcome::Materialized {
                reference_name: "result_1".into(),
                display_name: "result_1".into(),
                sql: "SELECT 1".into(),
                assumption: None,
                stale: None,
            },
        );
        let err = Recipe::build(
            "dup".into(),
            vec![csv_source("people", "fp")],
            vec![
                RecipeEntry::Turn(dup_turn.clone()),
                RecipeEntry::Turn(dup_turn),
            ],
            Some("people".into()),
        )
        .unwrap_err();
        match err {
            RecipeError::DuplicateResultReference { reference_name } => {
                assert_eq!(reference_name, "result_1");
            }
            other => panic!("expected DuplicateResultReference, got {other:?}"),
        }
    }

    #[test]
    fn build_rejects_an_empty_source_event_reference_name() {
        // A source-lifecycle event with an empty reference_name is unambiguous
        // corruption (a hand edit or a logic bug); build surfaces it rather
        // than persisting a recipe whose timeline cannot name what it refers
        // to. Full lifecycle ordering (Added-before-Deleted) stays the write
        // path's job -- this is the minimal reference-name check.
        use crate::model::SourceLifecycleKind;
        let err = Recipe::build(
            "empty-ev".into(),
            vec![csv_source("people", "fp")],
            vec![RecipeEntry::Source(SourceLifecycleEvent {
                kind: SourceLifecycleKind::Added,
                reference_name: String::new(),
                display_name: "people".into(),
            })],
            Some("people".into()),
        )
        .unwrap_err();
        // The event is history[0]; its kind is the Added constructed above.
        // The payload pinpoints the corruption rather than just the variant.
        assert!(
            matches!(
                err,
                RecipeError::EmptySourceEventReference {
                    index: 0,
                    kind: SourceLifecycleKind::Added,
                }
            ),
            "expected EmptySourceEventReference {{ index: 0, kind: Added }}, got {err:?}",
        );
    }

    /// The accessor returns the same value the field holds -- pins that build
    /// routes through the constant (not, say, defaulting to 0). A regression
    /// that left format_version at its `u32::default()` would fail here.
    #[test]
    fn build_format_version_is_the_current_constant_not_default() {
        let recipe = Recipe::build("v".into(), Vec::new(), Vec::new(), None).expect("build");
        assert_eq!(recipe.format_version(), RECIPE_FORMAT_VERSION);
        assert_ne!(
            RECIPE_FORMAT_VERSION, 0,
            "test precondition: constant is non-zero"
        );
    }

    // --- v2 trace + provenance (ADR-0078/0082, issue #296) -------------------

    #[test]
    fn synthetic_materialize_trace_produces_one_successful_write_call() {
        // ADR-0082: a v1-era Materialized turn ran exactly one productive SQL,
        // so its synthetic trajectory is one `materialize` call classified as a
        // write, marked successful, with the verbatim SQL as the summary.
        let trace = synthetic_materialize_trace("SELECT COUNT(*) FROM \"people\".data");
        assert_eq!(trace.len(), 1);
        let entry = &trace[0];
        assert_eq!(entry.name, "materialize");
        assert_eq!(entry.operation_kind, OperationKind::Write);
        assert!(entry.success);
        assert_eq!(entry.summary, "SELECT COUNT(*) FROM \"people\".data");
        assert!(entry.result_excerpt.is_empty());
    }

    #[test]
    fn synthetic_materialize_trace_truncates_a_long_sql_summary() {
        // A trace summary is bounded (ADR-0078) so a huge SQL does not bloat
        // the persisted trace. A SQL over TRACE_SUMMARY_MAX is cut with an
        // ellipsis; the helper matches what the live agent loop records.
        let long_sql = "x".repeat(TRACE_SUMMARY_MAX + 40);
        let trace = synthetic_materialize_trace(&long_sql);
        assert!(trace[0].summary.chars().count() <= TRACE_SUMMARY_MAX);
        assert!(trace[0].summary.ends_with('…'), "cut with ellipsis");
    }

    #[test]
    fn recipe_turn_omits_empty_trace_and_default_provenance_from_json() {
        // ADR-0078: the trace + provenance are persisted substructures, but a
        // turn with no tool trajectory and untracked provenance omits BOTH
        // fields (skip_serializing_if), keeping the .duck lean. A v1-era
        // Textual turn serializes to the same shape v1 carried (no trace /
        // provenance keys) -- the round trip is byte-stable.
        let turn = RecipeTurn::new(
            "哪种名字",
            RecipeOutcome::Textual {
                text_kind: TextKind::Clarify,
                body: "按姓还是名？".into(),
                assumption: None,
            },
        );
        let json = serde_json::to_string(&turn).expect("serialize");
        assert!(!json.contains("trace"), "empty trace omitted");
        assert!(!json.contains("provenance"), "default provenance omitted");
        let back: RecipeTurn = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, turn);
    }

    #[test]
    fn recipe_turn_round_trips_a_synthetic_trace_through_json() {
        // A Materialized turn's synthesized single-call trace survives a
        // serialize -> deserialize cycle, so the .duck written on save reads
        // back identically on resume -- the foundation for the v2 display-part
        // contract (ADR-0078/0082).
        let turn = RecipeTurn {
            question: "多少人".into(),
            outcome: RecipeOutcome::Materialized {
                reference_name: "result_1".into(),
                display_name: "result_1".into(),
                sql: "SELECT COUNT(*) AS n FROM \"people\".data".into(),
                assumption: None,
                stale: None,
            },
            trace: synthetic_materialize_trace("SELECT COUNT(*) AS n FROM \"people\".data"),
            provenance: TurnProvenance::default(),
        };
        let json = serde_json::to_string(&turn).expect("serialize");
        assert!(json.contains("\"trace\""), "trace key present");
        let back: RecipeTurn = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, turn);
        assert_eq!(back.trace.len(), 1);
        assert_eq!(back.trace[0].name, "materialize");
    }

    #[test]
    fn provenance_round_trips_with_runtime_and_skills() {
        // Forward-looking (ADR-0078/0081): a turn the agent-loop wiring slice
        // populates carries a typed runtime + the active skill ids. The shape
        // round-trips so resume reproduces the audit anchor "how was this
        // produced" after reopen.
        let provenance = TurnProvenance {
            runtime: Some(RuntimeKind::BuiltIn),
            skills: vec!["sql-coach".into()],
        };
        let json = serde_json::to_string(&provenance).expect("serialize");
        let back: TurnProvenance = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, provenance);
        assert_eq!(back.runtime, Some(RuntimeKind::BuiltIn));
        assert_eq!(back.skills, vec!["sql-coach".to_string()]);
    }

    #[test]
    fn provenance_is_empty_when_default() {
        // The skip_serializing_if predicate: a default provenance (no runtime,
        // no skills) reports empty so the field is omitted from the .duck.
        assert!(TurnProvenance::default().is_empty());
        assert!(
            !TurnProvenance {
                runtime: Some(RuntimeKind::External),
                skills: Vec::new(),
            }
            .is_empty(),
            "a typed runtime is non-empty",
        );
        assert!(
            !TurnProvenance {
                runtime: None,
                skills: vec!["s".into()],
            }
            .is_empty(),
            "a skill list is non-empty",
        );
    }
}
