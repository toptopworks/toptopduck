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
    RectifyProvenance, SkillLifecycleEvent, SkillLifecycleKind, SkillProvenance,
    SourceLifecycleEvent, SourceLifecycleKind, StaleAnchor, TextKind, TurnFailure,
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
///
/// v3 (ADR-0084) makes the result turn's promotion chain explicit in the
/// reconstructable part: `RecipeOutcome::Materialized` carries an ordered
/// `promotions` list (each a [`RecipePromotion`] with its own stale anchor)
/// instead of a single flattened reference, so a multi-promotion turn persists
/// EVERY result_N and resume replays the full chain. The v2->v3 mapping is
/// lossless: a v2 Materialized turn (single reference) wraps into a
/// one-element promotions list; older clients reading a v3 file hit the
/// existing higher-version honest-refuse path (ADR-0036).
///
/// v4 (ADR-0086, issue #363) adds skill lifecycle to the timeline + sharpens
/// turn provenance: a new [`RecipeEntry::Skill`] variant (isomorphic to
/// [`RecipeEntry::Source`]) records each Mount / Unmount, and
/// [`TurnProvenance::skills`] changes from `Vec<String>` to
/// `Vec<`[`SkillProvenance`]`>` (each carrying its `content_hash` at assembly
/// time). The active skill set is NOT a stored snapshot -- it is folded from
/// the timeline's Mount/Unmount sequence ([`Recipe::mounted_skills`]). The
/// v3->v4 mapping is lossless for every real recipe: a v3 turn's `skills`
/// array of bare names rewrites to `{name, content_hash: ""}` objects (empty
/// hash = no baseline, never trips the stale-degrade check); older clients
/// reading a v4 file hit the existing higher-version honest-refuse path
/// (ADR-0036).
pub const RECIPE_FORMAT_VERSION: u32 = 4;

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

/// The recipe's conversation timeline (ADR-0028/0039/0040/0086): every turn,
/// every source lifecycle event, and every skill lifecycle event -- always
/// visible, in order. A trimmed mirror of [`crate::model::ThreadEntry`]: a
/// Turn entry drops materialized descriptor fields resume re-derives; a Source
/// entry passes through verbatim (ADR-0040 first-class timeline slot, never
/// enters the LLM window); a Skill entry passes through verbatim too
/// (ADR-0086, isomorphic to Source -- the active skill set is FOLDED from the
/// event sequence by [`Recipe::mounted_skills`], never snapshotted).
/// Adjacently-tagged so a future reader narrows on `entry` uniformly, mirroring
/// the IPC `ThreadEntry` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "entry", content = "data")]
pub enum RecipeEntry {
    Turn(RecipeTurn),
    Source(SourceLifecycleEvent),
    /// A skill lifecycle event (ADR-0086, issue #363). Isomorphic to
    /// [`Self::Source`]: first-class timeline slot (always visible), never a
    /// turn (never enters the LLM window, never advances `result_N`). The
    /// active skill set at any point is the fold of the Mount/Unmount
    /// sequence up to that point -- see [`Recipe::mounted_skills`].
    Skill(SkillLifecycleEvent),
}

/// One entry in a turn's persisted execution trace (ADR-0078). The trace is a
/// persisted, collapsible substructure of the turn; the far window carries only
/// a summary (call count + failure summary), never the full trace verbatim. This
/// is the recipe form of the agent loop's in-memory trace entry minus the
/// ephemeral `tool_use_id` (a per-provider-call id that does not survive the
/// turn, let alone a save/resume).
///
/// A live agent-loop turn persists the loop's recorded multi-call trace
/// (issue #319): every call the turn made, in call order, each mapped from
/// the in-memory entry. v1-era turns predate the agent loop and carry no
/// recorded trajectory; the v1->v2 migration synthesizes a single-call trace
/// for each Materialized turn (one `materialize` entry from the verbatim SQL,
/// see [`synthetic_materialize_trace`]), so a reopened v1 session shows the
/// same one-step trajectory the single-SQL contract produced live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeTraceEntry {
    /// Tool name -- a built-in (`explore` / `materialize` / `describe` /
    /// `sample`) or an external MCP server's tool name.
    pub name: String,
    /// Operation badge (ADR-0083 read/write/execute/network) -- presentation
    /// only. Reuses the approval-gateway classification so a reopened turn
    /// renders the same badge the live approval card did.
    pub operation_kind: OperationKind,
    /// Short argument summary (the SQL or reference_name), NOT the full args.
    pub summary: String,
    /// Whether the call succeeded. A tool-level error routes back to the agent
    /// (ADR-0077); the trace records the failure for audit + cross-turn
    /// debugging.
    pub success: bool,
    /// Bounded excerpt of a FAILED call's result (the error / denial message)
    /// -- the cross-turn failure retrospection anchor (ADR-0078): the trace
    /// exists so a reopened session can answer "which call failed, and why".
    /// Both construction sites guard the inverse invariant (issue #316): a
    /// failed entry never persists an empty excerpt (`debug_assert!` in the
    /// migration's synthetic trace helper + the live trace mapping).
    /// Empty for a successful call: its dispatch content is a data-bearing
    /// descriptor / shape JSON the .duck should not carry (ADR-0036 contents
    /// boundary -- though the excerpt is already bounded at capture, the
    /// success payload is rebuilt on resume anyway), so persisting it would
    /// add noise without value.
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

/// Which runtime the session's last executed turn ran on (ADR-0102 Decision
/// 1): the recipe-header fact resume restores the runtime choice from (segment
/// continuation -- the execution-plane selections survive a resume, unlike the
/// approval / MCP posture). Adjacently tagged with the same `kind` / `data`
/// shape as the IPC `SessionRuntimeChoice`, so the persisted fact and the wire
/// fact are the same disjunction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
#[serde(rename_all = "snake_case")]
pub enum LastRuntime {
    /// The app's own Rust-native agent loop (ADR-0081).
    BuiltIn,
    /// The named external CLI adapter (its stable `AdapterId` string).
    External(String),
}

/// Provenance of a turn's execution context (ADR-0078): which runtime produced
/// it and which skills were active at assembly time. The persisted audit anchor
/// for "how was this answer produced".
///
/// A live turn driven by the built-in agent loop records
/// [`RuntimeKind::BuiltIn`] (issue #319); skills stay empty until skill
/// tracking lands (the skill surface itself is defined by ADR-0079).
/// v1-era migrated turns carry no runtime or skill provenance and round-trip
/// the default (omitted from the .duck).
/// `#[serde(default)]` keeps older v2 recipes (and the migration output)
/// deserializing cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TurnProvenance {
    /// The runtime that drove this turn (ADR-0081), or `None` for turns created
    /// before runtime tracking (v1 migrated, or live turns predating #319).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimeKind>,
    /// Which external CLI adapter drove this turn (ADR-0101): the stable
    /// `AdapterId` string, carried ONLY on `RuntimeKind::External` turns (a
    /// BuiltIn turn never sets it). `None` on External turns persisted before
    /// the field existed (`#[serde(default)]`, no migration -- the thread
    /// renders the honest "External (unrecorded)" degradation for them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
    /// The active skills at this turn's assembly time (ADR-0079/0086, issue
    /// #363), each carrying its `content_hash` so the frontend can drift-compare
    /// against the registry's current hash and surface a "modified" badge when
    /// a skill changed after this turn. Empty when no skills were mounted or
    /// skill tracking is not yet wired (the live path fills this once #364
    /// wires skill prompt injection).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillProvenance>,
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
/// source for the trace-summary truncation cap: both the migration's synthetic
/// single-call trace ([`synthetic_materialize_trace`]) and the agent loop's
/// live call summary (`summarize_field`) reuse it, so a reopened v1 turn and a
/// fresh live turn persist the same truncation shape.
pub(crate) const TRACE_SUMMARY_MAX: usize = 120;

/// Synthesize the single-call execution trace for a Materialized turn's SQL
/// (ADR-0078). v1-era turns ran exactly one productive SQL under the single-SQL
/// contract, so their trajectory is one `materialize` call -- the v1->v2
/// migration uses this helper so a reopened v1 session shows the same one-step
/// trajectory it produced live. Live agent-loop turns persist the loop's
/// recorded multi-call trace instead (issue #319), so this helper's sole
/// remaining caller is the migration path. The summary is the verbatim SQL
/// truncated to [`TRACE_SUMMARY_MAX`].
pub(crate) fn synthetic_materialize_trace(sql: &str) -> Vec<RecipeTraceEntry> {
    let entry = RecipeTraceEntry {
        name: crate::tools::definitions::TOOL_MATERIALIZE.to_string(),
        operation_kind: OperationKind::Write,
        summary: truncate_trace_summary(sql),
        success: true,
        result_excerpt: String::new(),
    };
    // Failure-message guard (issue #316): shared with the live trace mapping
    // (`RecipeTraceEntry::from_live_trace`) -- a failed entry must carry
    // its result message (ADR-0078 failure anchor). Trivially satisfied here
    // (the synthesized entry is always a success); kept so both construction
    // sites pin the same invariant.
    debug_assert!(
        entry.success || !entry.result_excerpt.is_empty(),
        "a failed trace entry persists its result message (ADR-0078 failure anchor)"
    );
    vec![entry]
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
    /// in the thread rail; never enters the far window verbatim. A live
    /// agent-loop turn carries the loop's recorded multi-call trace (issue
    /// #319); a v1-era migrated turn carries the migration's synthetic
    /// single-call trace (see [`synthetic_materialize_trace`]); empty for
    /// no-tool turns (a textual answer with no exploration).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trace: Vec<RecipeTraceEntry>,
    /// The turn's runtime + skill provenance (ADR-0078). A live built-in loop
    /// turn records [`RuntimeKind::BuiltIn`] (issue #319); default (no runtime,
    /// no skills) for v1-era migrated turns.
    #[serde(default, skip_serializing_if = "TurnProvenance::is_empty")]
    pub provenance: TurnProvenance,
}

impl RecipeTurn {
    /// Construct a turn with an empty trace and default provenance -- the shape
    /// a no-tool turn persists with and the shape the v1->v2 migration emits
    /// (v1 turns carry no recorded trajectory or runtime). The live path
    /// (`Session::build_recipe`) routes through [`Self::with_audit`] instead,
    /// pairing each turn with its recorded audit (the loop's real trace +
    /// runtime provenance, ADR-0078).
    pub fn without_audit(question: impl Into<String>, outcome: RecipeOutcome) -> Self {
        Self {
            question: question.into(),
            outcome,
            trace: Vec::new(),
            provenance: TurnProvenance::default(),
        }
    }

    /// Construct a turn paired with its recorded execution audit (ADR-0078,
    /// issue #316) -- the live path's shape. `Session::build_recipe` routes
    /// every persisted turn through here, pairing each turn with the trace
    /// and runtime/skill provenance recorded as it ran (the loop's real
    /// multi-call trajectory for a live turn; the recipe's values harvested
    /// on resume). [`Self::without_audit`] stays the empty-trace / default-provenance
    /// shape (a no-tool turn, or a v1-era migrated turn).
    pub fn with_audit(
        question: impl Into<String>,
        outcome: RecipeOutcome,
        trace: Vec<RecipeTraceEntry>,
        provenance: TurnProvenance,
    ) -> Self {
        Self {
            question: question.into(),
            outcome,
            trace,
            provenance,
        }
    }
}

/// One persisted promotion within a result turn (ADR-0084): the trimmed form of
/// a live [`crate::model::Promotion`]. The recipe carries only the stable
/// identity (reference name), the display label, the verbatim SQL, and the
/// per-promotion stale anchor -- everything else (columns / sample / row-count)
/// is rebuilt by eager replay (ADR-0034). Replayed on resume to re-materialize
/// its `result_N` (reusing the same number, ADR-0022) UNLESS its own `stale` is
/// set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipePromotion {
    pub reference_name: String,
    pub display_name: String,
    pub sql: String,
    /// ADR-0041 stale marker (issue #52), per promotion. `None` = live,
    /// replayed on resume. `Some(anchor)` = the result_N was cascade-
    /// invalidated by a source replace/remove -- a dead result: kept in the
    /// timeline for display and the LLM window (ADR-0041 point 2 -- the
    /// verbatim SQL stays visible so the user / model can reference the prior
    /// logic), but excluded from [`Recipe::productive_chain`] so resume never
    /// re-executes it. The anchor carries the invalidating source event's
    /// identity + reason (ADR-0040 traceability), so the stale badge renders
    /// the same way after resume as it did live. `#[serde(default)]` so a
    /// pre-#52 recipe (whose stale turns were dropped at write time under the
    /// old contract) deserializes as live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<StaleAnchor>,
}

/// A trimmed turn outcome (ADR-0028 four-way classification). The live
/// [`crate::model::TurnOutcome::Materialized`] carries the full dataset
/// descriptors (columns / sample / row-count / fingerprint) plus the viz spec;
/// the recipe form carries, per promotion, only the stable identity (reference
/// name), the display label, and the verbatim SQL -- everything else is rebuilt
/// by eager replay (ADR-0034) or dropped because not persisted (ADR-0036 viz /
/// execution metadata).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum RecipeOutcome {
    /// Outcome A -- a result turn (ADR-0077 "one or more promotions";
    /// representation ADR-0084). Carries the full promotion chain in promotion
    /// order; [`Recipe::productive_chain`] flattens every turn's chain into the
    /// flat replay list. The chain tail is the turn's primary result -- the
    /// answer the question produced (derived, never stored).
    Materialized {
        /// The turn's promotions in promotion order (ADR-0022 monotonic
        /// numbering: result_1, result_2, ...). Non-empty for a result turn.
        promotions: Vec<RecipePromotion>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assumption: Option<String>,
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
    /// The session-level external-runtime model choice (ADR-0095 Decision 6).
    /// NOT a replay input -- the model shapes HOW a turn is answered, not the
    /// deterministic data chain, so it lives in the header beside the other
    /// session-level assembly facts, never in a turn entry. Optional: an old
    /// recipe without the field deserializes as `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The session-level external-runtime thought-level choice (ADR-0095
    /// Decision 6). Same header-level + optional semantics as `model`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_level: Option<String>,
    /// The last ACP turn's discovered model / thought-level catalog
    /// (ADR-0095 Decision 6): a small snapshot so a resumed session renders
    /// the selector immediately instead of waiting for the next turn's
    /// handshake re-discovery. Optional for old-recipe compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_discovered: Option<crate::runtime::acp::adapter::DiscoveredRuntime>,
    /// The runtime the session's last executed turn ran on (ADR-0102
    /// Decision 1): stamped per turn by the session from the turn's
    /// attribution snapshot, layered onto the header in the same batch as the
    /// posture pair and `cached_discovered`, so a resume restores the
    /// session's own runtime instead of falling back to the machine-level
    /// default. NOT a replay input. Optional: a recipe persisted before the
    /// field deserializes as `None` (resume then applies the pre-ADR-0102
    /// default-runtime resolution). No format_version bump -- strictly
    /// additive with a serde default, the same precedent as `adapter_id` on
    /// the fields above.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_runtime: Option<LastRuntime>,
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
    /// A skill-lifecycle event in `history` carries an empty `name` (ADR-0086,
    /// issue #363). Mirrors [`Self::EmptySourceEventReference`]: an empty
    /// skill name is unambiguous corruption (the spec requires a non-empty
    /// kebab-case name equal to the directory), full Mount/Unmount ordering
    /// consistency stays the write path's job. Carries the offending event's
    /// history `index` and `kind` so a hand-edited recipe's corruption can be
    /// pinpointed.
    EmptySkillEventName {
        index: usize,
        kind: SkillLifecycleKind,
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
            Self::EmptySkillEventName { index, kind } => write!(
                f,
                "history 第 {index} 个条目是名字为空的技能生命周期事件（{kind:?}）"
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
    /// - Every skill-lifecycle event in `history` carries a non-empty `name`
    ///   (ADR-0086; full Mount/Unmount ordering is the write path's job).
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
                    if let RecipeOutcome::Materialized { promotions, .. } = &turn.outcome {
                        for promotion in promotions {
                            if !seen_results.insert(promotion.reference_name.clone()) {
                                return Err(RecipeError::DuplicateResultReference {
                                    reference_name: promotion.reference_name.clone(),
                                });
                            }
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
                RecipeEntry::Skill(ev) => {
                    if ev.name.is_empty() {
                        return Err(RecipeError::EmptySkillEventName {
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
            // ADR-0095/0102 header facts: Recipe::build constructs the replay
            // projection; the caller (RecipePersister::build_recipe) layers
            // the session-level facts on top via
            // [`Recipe::with_session_runtime_facts`].
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
        })
    }

    /// Layer the session-level runtime facts onto the recipe header
    /// (ADR-0095 Decision 6, extended by ADR-0102 Decision 1 with
    /// `last_runtime`). Builder-style: `Recipe::build` produces the replay
    /// projection, then the persister layers the session-level facts so the
    /// persisted file carries them.
    pub fn with_session_runtime_facts(
        mut self,
        model: Option<String>,
        thought_level: Option<String>,
        cached_discovered: Option<crate::runtime::acp::adapter::DiscoveredRuntime>,
        last_runtime: Option<LastRuntime>,
    ) -> Recipe {
        self.model = model;
        self.thought_level = thought_level;
        self.cached_discovered = cached_discovered;
        self.last_runtime = last_runtime;
        self
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
            .flat_map(|entry| match entry {
                RecipeEntry::Turn(turn) => match &turn.outcome {
                    // ADR-0084: flatten the turn's promotion chain into the flat
                    // replay list, in promotion order. Each live promotion
                    // (stale: None) re-materializes its result_N; stale ones
                    // (ADR-0041 dead results) are skipped. The turn-level
                    // assumption rides the PRIMARY (chain tail) only -- the
                    // answer the question produced; antecedents carry none.
                    RecipeOutcome::Materialized {
                        promotions,
                        assumption,
                    } => {
                        let primary_idx = promotions.len().saturating_sub(1);
                        promotions
                            .iter()
                            .enumerate()
                            .filter(|(_, p)| p.stale.is_none())
                            .map(|(i, p)| ProductiveTurn {
                                reference_name: p.reference_name.clone(),
                                display_name: p.display_name.clone(),
                                sql: p.sql.clone(),
                                assumption: if i == primary_idx {
                                    assumption.clone()
                                } else {
                                    None
                                },
                            })
                            .collect::<Vec<_>>()
                    }
                    _ => Vec::new(),
                },
                RecipeEntry::Source(_) | RecipeEntry::Skill(_) => Vec::new(),
            })
            .collect()
    }

    /// The active skill set, folded from the timeline's Mount/Unmount sequence
    /// (ADR-0086, issue #363). NOT a stored snapshot -- the timeline is the
    /// single source of truth, and the set is re-derived on every read:
    /// - `Mount(name)` inserts `name` (idempotent -- a re-mount of an already-
    ///   mounted name is a no-op; the live write path refuses it, but a hand-
    ///   edited recipe could carry one and the fold stays well-defined).
    /// - `Unmount(name)` removes `name` (idempotent -- an Unmount of a name
    ///   not in the set is a no-op; same hand-edit resilience).
    ///
    /// The result preserves first-Mount insertion order so a deterministic
    /// assembly sequence reads it. Used by resume to rebuild the live
    /// `Session.mounted_skills` cache and by the `list_mounted_skills` IPC to
    /// render the active-set chip list; per-turn assembly will consume it via
    /// `TurnProvenance::skills` once #364 wires real content hashes.
    ///
    /// A `mount -> unmount -> remount` sequence yields just `[name]` (the
    /// remount re-adds what the unmount removed) -- the AC pinned in tests.
    pub fn mounted_skills(&self) -> Vec<String> {
        let mut mounted: Vec<String> = Vec::new();
        for entry in &self.history {
            if let RecipeEntry::Skill(ev) = entry {
                match ev.kind {
                    SkillLifecycleKind::Mount => {
                        if !mounted.iter().any(|n| n == &ev.name) {
                            mounted.push(ev.name.clone());
                        }
                    }
                    SkillLifecycleKind::Unmount => mounted.retain(|n| n != &ev.name),
                }
            }
        }
        mounted
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
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "多少人",
                    RecipeOutcome::Materialized {
                        promotions: vec![RecipePromotion {
                            reference_name: "result_1".into(),
                            display_name: "result_1".into(),
                            sql: "SELECT COUNT(*) AS n FROM \"people\".data".into(),
                            stale: None,
                        }],
                        assumption: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::without_audit(
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
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
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
    fn recipe_format_version_is_four() {
        // ADR-0086 (issue #363): v4 carries format_version = 4 (skill lifecycle
        // entries on the timeline + per-skill content_hash on turn provenance).
        // Pin the constant so the open-path version check stays in sync with
        // what save writes.
        assert_eq!(RECIPE_FORMAT_VERSION, 4);
        assert_eq!(build_recipe().format_version, 4);
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
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "q1",
                    RecipeOutcome::Materialized {
                        promotions: vec![RecipePromotion {
                            reference_name: "result_1".into(),
                            display_name: "result_1".into(),
                            sql: "SELECT 1".into(),
                            stale: None,
                        }],
                        assumption: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "q2",
                    RecipeOutcome::Materialized {
                        promotions: vec![RecipePromotion {
                            reference_name: "result_2".into(),
                            display_name: "result_2".into(),
                            sql: "SELECT * FROM \"result_1\"".into(),
                            stale: None,
                        }],
                        assumption: None,
                    },
                )),
            ],
            active: Some("people".into()),
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
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
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
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
            promotions: vec![RecipePromotion {
                reference_name: reference_name.into(),
                display_name: reference_name.into(),
                sql: sql.into(),
                stale: Some(StaleAnchor {
                    reference_name: anchor_ref.into(),
                    display_name: anchor_ref.into(),
                    reason,
                }),
            }],
            assumption: None,
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
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "live",
                    RecipeOutcome::Materialized {
                        promotions: vec![RecipePromotion {
                            reference_name: "result_1".into(),
                            display_name: "result_1".into(),
                            sql: "SELECT 1".into(),
                            stale: None,
                        }],
                        assumption: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::without_audit(
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
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
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
        let turn = RecipeTurn::without_audit(
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
            RecipeOutcome::Materialized { promotions, .. } => {
                let anchor = promotions[0]
                    .stale
                    .as_ref()
                    .expect("stale anchor survives the round trip");
                assert_eq!(anchor.reason, StaleReason::Deleted);
                assert_eq!(anchor.reference_name, "orders");
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
        let json = r#"{"kind":"Materialized","data":{"promotions":[{"reference_name":"result_1","display_name":"result_1","sql":"SELECT 1"}]}}"#;
        let back: RecipeOutcome = serde_json::from_str(json).expect("deserialize pre-#52 form");
        match back {
            RecipeOutcome::Materialized { promotions, .. } => {
                assert_eq!(promotions.len(), 1);
                assert!(
                    promotions[0].stale.is_none(),
                    "a promotion without a stale field deserializes as live"
                );
            }
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
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "first live",
                    RecipeOutcome::Materialized {
                        promotions: vec![RecipePromotion {
                            reference_name: "result_1".into(),
                            display_name: "result_1".into(),
                            sql: "SELECT 1".into(),
                            stale: None,
                        }],
                        assumption: None,
                    },
                )),
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "stale middle",
                    stale_materialized(
                        "result_2",
                        "SELECT * FROM \"people\".data",
                        "people",
                        StaleReason::Replaced,
                    ),
                )),
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "live after gap",
                    RecipeOutcome::Materialized {
                        promotions: vec![RecipePromotion {
                            reference_name: "result_3".into(),
                            display_name: "result_3".into(),
                            sql: "SELECT 3".into(),
                            stale: None,
                        }],
                        assumption: None,
                    },
                )),
            ],
            active: Some("people".into()),
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
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
            vec![RecipeEntry::Turn(RecipeTurn::without_audit(
                "多少人",
                RecipeOutcome::Materialized {
                    promotions: vec![RecipePromotion {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: "SELECT 1".into(),
                        stale: None,
                    }],
                    assumption: None,
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
        let dup_turn = RecipeTurn::without_audit(
            "q",
            RecipeOutcome::Materialized {
                promotions: vec![RecipePromotion {
                    reference_name: "result_1".into(),
                    display_name: "result_1".into(),
                    sql: "SELECT 1".into(),
                    stale: None,
                }],
                assumption: None,
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
        let turn = RecipeTurn::without_audit(
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
    fn external_provenance_round_trips_adapter_id() {
        // ADR-0101: an External turn persists the adapter id alongside the
        // runtime kind, so a mixed thread's reader can tell WHICH external CLI
        // produced each turn. The pair survives the serialize -> deserialize
        // cycle -- the .duck written on save reads back identically on resume.
        let provenance = TurnProvenance {
            runtime: Some(RuntimeKind::External),
            adapter_id: Some("gemini-cli".into()),
            skills: Vec::new(),
        };
        let json = serde_json::to_string(&provenance).expect("serialize");
        assert_eq!(json, r#"{"runtime":"External","adapter_id":"gemini-cli"}"#);
        let back: TurnProvenance = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, provenance);
    }

    #[test]
    fn pre_attribution_external_turn_deserializes_without_adapter_id() {
        // serde default (ADR-0101): an External turn persisted before the
        // adapter-id extension carries only the runtime kind. It reads back
        // with `adapter_id: None` -- the thread then renders the honest
        // "External (unrecorded)" degradation, never a fabricated id.
        let legacy = r#"{"runtime":"External"}"#;
        let back: TurnProvenance = serde_json::from_str(legacy).expect("deserialize");
        assert_eq!(back.runtime, Some(RuntimeKind::External));
        assert_eq!(back.adapter_id, None, "missing adapter id degrades to None");
    }

    #[test]
    fn builtin_provenance_omits_adapter_id_from_json() {
        // ADR-0101: a BuiltIn turn never carries the adapter id -- the field
        // is the external identity, meaningless for the app's own loop. The
        // serialization stays byte-identical to the pre-extension form.
        let provenance = TurnProvenance {
            runtime: Some(RuntimeKind::BuiltIn),
            adapter_id: None,
            skills: Vec::new(),
        };
        let json = serde_json::to_string(&provenance).expect("serialize");
        assert_eq!(json, r#"{"runtime":"BuiltIn"}"#);
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
                promotions: vec![RecipePromotion {
                    reference_name: "result_1".into(),
                    display_name: "result_1".into(),
                    sql: "SELECT COUNT(*) AS n FROM \"people\".data".into(),
                    stale: None,
                }],
                assumption: None,
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
    fn with_audit_pairs_the_turn_with_its_recorded_trace_and_provenance() {
        // The live path's constructor (issue #316): `Session::build_recipe`
        // pairs each turn with its recorded audit (ADR-0078) -- the loop's
        // real multi-call trace + runtime/skill provenance -- through this
        // constructor instead of a bare struct literal.
        let trace = synthetic_materialize_trace("SELECT COUNT(*) AS n FROM \"people\".data");
        let provenance = TurnProvenance {
            runtime: Some(RuntimeKind::BuiltIn),
            adapter_id: None,
            skills: vec![SkillProvenance {
                name: "sql-coach".into(),
                content_hash: "abc123".into(),
            }],
        };
        let turn = RecipeTurn::with_audit(
            "多少人",
            RecipeOutcome::Materialized {
                promotions: vec![RecipePromotion {
                    reference_name: "result_1".into(),
                    display_name: "result_1".into(),
                    sql: "SELECT COUNT(*) AS n FROM \"people\".data".into(),
                    stale: None,
                }],
                assumption: None,
            },
            trace.clone(),
            provenance.clone(),
        );
        assert_eq!(turn.question, "多少人");
        assert_eq!(turn.trace, trace, "the recorded trace rides verbatim");
        assert_eq!(turn.provenance, provenance, "as does the provenance");
    }

    #[test]
    fn provenance_round_trips_with_runtime_and_skills() {
        // A live agent-loop turn's provenance (ADR-0078/0081, issue #319)
        // carries a typed runtime + the active skill provenance (each with its
        // content_hash, ADR-0086 issue #363). The shape round-trips so resume
        // reproduces the audit anchor "how was this produced" after reopen.
        let provenance = TurnProvenance {
            runtime: Some(RuntimeKind::BuiltIn),
            adapter_id: None,
            skills: vec![
                SkillProvenance {
                    name: "sql-coach".into(),
                    content_hash: "abc123".into(),
                },
                SkillProvenance {
                    name: "chart-helper".into(),
                    content_hash: String::new(),
                },
            ],
        };
        let json = serde_json::to_string(&provenance).expect("serialize");
        let back: TurnProvenance = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, provenance);
        assert_eq!(back.runtime, Some(RuntimeKind::BuiltIn));
        assert_eq!(back.skills.len(), 2);
        assert_eq!(back.skills[0].name, "sql-coach");
        assert_eq!(back.skills[0].content_hash, "abc123");
        // An empty content_hash (the v3->v4 migration output) round-trips
        // verbatim -- never silently dropped or replaced with a sentinel.
        assert_eq!(back.skills[1].content_hash, "");
    }

    #[test]
    fn provenance_is_empty_when_default() {
        // The skip_serializing_if predicate: a default provenance (no runtime,
        // no skills) reports empty so the field is omitted from the .duck.
        assert!(TurnProvenance::default().is_empty());
        assert!(
            !TurnProvenance {
                runtime: Some(RuntimeKind::External),
                adapter_id: None,
                skills: Vec::new(),
            }
            .is_empty(),
            "a typed runtime is non-empty",
        );
        assert!(
            !TurnProvenance {
                runtime: None,
                adapter_id: None,
                skills: vec![SkillProvenance {
                    name: "s".into(),
                    content_hash: String::new(),
                }],
            }
            .is_empty(),
            "a skill list is non-empty",
        );
    }

    // --- v4 skill lifecycle (ADR-0086, issue #363) --------------------------

    #[test]
    fn recipe_round_trips_with_a_skill_lifecycle_event() {
        // ADR-0086: a Skill entry rides the timeline isomorphic to a Source
        // entry (always visible, never a turn) and survives a serialize ->
        // deserialize cycle byte-for-byte so the active set folds identically
        // after reopen.
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "skills".into(),
            sources: Vec::new(),
            history: vec![
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Mount,
                    name: "sql-coach".into(),
                }),
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Unmount,
                    name: "sql-coach".into(),
                }),
            ],
            active: None,
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
        };
        let json = serde_json::to_string(&recipe).expect("serialize");
        let back: Recipe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, recipe);
    }

    #[test]
    fn mounted_skills_folds_mount_unmount_in_order() {
        // ADR-0086: the active set is folded from the timeline, NOT snapshotted.
        // A simple mount -> unmount sequence yields an empty set; the AC's
        // mount -> unmount -> remount sequence yields the remounted name only.
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "fold".into(),
            sources: Vec::new(),
            history: vec![
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Mount,
                    name: "sql-coach".into(),
                }),
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Unmount,
                    name: "sql-coach".into(),
                }),
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Mount,
                    name: "sql-coach".into(),
                }),
            ],
            active: None,
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
        };
        assert_eq!(
            recipe.mounted_skills(),
            vec!["sql-coach".to_string()],
            "remount re-adds what unmount removed",
        );
    }

    #[test]
    fn mounted_skills_preserves_first_mount_insertion_order() {
        // Two distinct mounts keep their first-mount order across a later
        // unmount of the first, so the assembly sequence reads deterministically.
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "order".into(),
            sources: Vec::new(),
            history: vec![
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Mount,
                    name: "a".into(),
                }),
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Mount,
                    name: "b".into(),
                }),
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Unmount,
                    name: "a".into(),
                }),
            ],
            active: None,
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
        };
        assert_eq!(recipe.mounted_skills(), vec!["b".to_string()]);
    }

    #[test]
    fn mounted_skills_is_empty_when_no_skill_events() {
        // A recipe with no skill events folds to the empty set (every session's
        // default posture -- no skills mounted).
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "none".into(),
            sources: Vec::new(),
            history: Vec::new(),
            active: None,
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
        };
        assert!(recipe.mounted_skills().is_empty());
    }

    #[test]
    fn build_rejects_an_empty_skill_event_name() {
        // ADR-0086: a skill lifecycle event with an empty name is unambiguous
        // corruption (the spec requires a non-empty kebab-case name); build
        // surfaces it rather than persisting a recipe the fold cannot resolve.
        // Mirrors the Source-name refusal.
        let err = Recipe::build(
            "empty-skill".into(),
            Vec::new(),
            vec![RecipeEntry::Skill(SkillLifecycleEvent {
                kind: SkillLifecycleKind::Mount,
                name: String::new(),
            })],
            None,
        )
        .unwrap_err();
        assert!(
            matches!(
                err,
                RecipeError::EmptySkillEventName {
                    index: 0,
                    kind: SkillLifecycleKind::Mount,
                }
            ),
            "expected EmptySkillEventName {{ index: 0, kind: Mount }}, got {err:?}",
        );
    }

    #[test]
    fn productive_chain_skips_skill_lifecycle_entries() {
        // ADR-0086: a Skill entry is never a productive turn -- the replay
        // chain ignores it (only Materialized turns re-materialize). A skill
        // event interleaved with a result turn does not pollute the chain.
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "skip-skill".into(),
            sources: vec![csv_source("people", "fp")],
            history: vec![
                RecipeEntry::Skill(SkillLifecycleEvent {
                    kind: SkillLifecycleKind::Mount,
                    name: "sql-coach".into(),
                }),
                RecipeEntry::Turn(RecipeTurn::without_audit(
                    "q",
                    RecipeOutcome::Materialized {
                        promotions: vec![RecipePromotion {
                            reference_name: "result_1".into(),
                            display_name: "result_1".into(),
                            sql: "SELECT 1".into(),
                            stale: None,
                        }],
                        assumption: None,
                    },
                )),
            ],
            active: Some("people".into()),
            model: None,
            thought_level: None,
            cached_discovered: None,
            last_runtime: None,
        };
        let chain = recipe.productive_chain();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].reference_name, "result_1");
    }

    /// ADR-0095 (AC): an old recipe file without the model / thought_level /
    /// cached_discovered header fields deserializes with all three as `None`
    /// (serde default), and the fields round-trip through serialization when
    /// set.
    #[test]
    fn recipe_model_config_defaults_none_and_round_trips() {
        let old = serde_json::json!({
            "format_version": 1,
            "session_name": "s",
            "sources": [],
            "history": [],
        });
        let recipe: Recipe = serde_json::from_value(old).expect("old recipe parses");
        assert_eq!(recipe.model, None);
        assert_eq!(recipe.thought_level, None);
        assert_eq!(recipe.cached_discovered, None);

        let layered = recipe.with_session_runtime_facts(
            Some("fake-opus".into()),
            Some("high".into()),
            Some(crate::runtime::acp::adapter::DiscoveredRuntime {
                models: vec!["fake-opus".into()],
                current_model: Some("fake-opus".into()),
                thought_levels: vec!["low".into(), "high".into()],
                current_thought_level: Some("high".into()),
                model_config_id: Some("model".into()),
                thought_level_config_id: Some("thought".into()),
                adapter_id: Some("gemini-cli".into()),
            }),
            Some(LastRuntime::External("gemini-cli".into())),
        );
        let v = serde_json::to_value(&layered).expect("serialize");
        assert_eq!(v["model"], "fake-opus");
        assert_eq!(v["thought_level"], "high");
        assert_eq!(
            v["cached_discovered"]["models"],
            serde_json::json!(["fake-opus"])
        );
        let back: Recipe = serde_json::from_value(v).expect("round-trip");
        assert_eq!(back.model.as_deref(), Some("fake-opus"));
        assert_eq!(back.cached_discovered, layered.cached_discovered);
        assert_eq!(
            back.cached_discovered.and_then(|d| d.adapter_id),
            Some("gemini-cli".to_string())
        );
    }

    /// ADR-0102 (issue #589): `last_runtime` rides the header like the posture
    /// pair -- absent on pre-#589 recipes (serde default `None`, so resume
    /// applies the old default-runtime semantics), and both variants
    /// round-trip through the layering builder with the same `kind` / `data`
    /// shape as the IPC `SessionRuntimeChoice`.
    #[test]
    fn recipe_last_runtime_defaults_none_and_round_trips() {
        let old = serde_json::json!({
            "format_version": 1,
            "session_name": "s",
            "sources": [],
            "history": [],
            "model": "fake-opus",
        });
        let recipe: Recipe = serde_json::from_value(old).expect("pre-#589 recipe parses");
        assert_eq!(recipe.last_runtime, None);

        let stamped = recipe.with_session_runtime_facts(
            None,
            None,
            None,
            Some(LastRuntime::External("gemini-cli".into())),
        );
        let v = serde_json::to_value(&stamped).expect("serialize");
        assert_eq!(
            v["last_runtime"],
            serde_json::json!({"kind": "external", "data": "gemini-cli"})
        );
        let back: Recipe = serde_json::from_value(v).expect("round-trip");
        assert_eq!(
            back.last_runtime,
            Some(LastRuntime::External("gemini-cli".into()))
        );

        // The built-in variant serializes contentless, same as the wire form.
        let v = serde_json::to_value(LastRuntime::BuiltIn).expect("serialize");
        assert_eq!(v, serde_json::json!({"kind": "built_in"}));
    }

    /// Issue #529: a recipe persisted before the adapter-id stamp carries no
    /// `adapter_id` inside `cached_discovered` -- it must deserialize as
    /// `None` (old-recipe compatibility), and the stamp round-trips when set.
    #[test]
    fn recipe_cached_discovered_adapter_id_defaults_none() {
        let old_catalog = serde_json::json!({
            "format_version": 1,
            "session_name": "s",
            "sources": [],
            "history": [],
            "model": "fake-opus",
            "cached_discovered": {
                "models": ["fake-opus"],
                "current_model": "fake-opus",
                "thought_levels": ["low"],
                "current_thought_level": null
            }
        });
        let recipe: Recipe = serde_json::from_value(old_catalog).expect("pre-stamp recipe parses");
        let cached = recipe.cached_discovered.expect("catalog present");
        assert_eq!(cached.models, vec!["fake-opus".to_string()]);
        assert_eq!(cached.adapter_id, None);
    }
}
