//! Turn / result materialization / execution-trace types (issue #22/#23, query
//! loop). The ask -> outcome loop (PRD #1): a question goes in, the agent loop
//! runs tool calls (explore / materialize) on the session DuckDB, and promoted
//! rows land as a materialized result_N physical table (ADR-0003/0024/0077). The
//! ADR-0028 four-way outcome classification + the always-visible thread are the
//! stable contract.

use serde::{Deserialize, Serialize};

use super::dataset::DatasetDescriptor;
use crate::approval::OperationKind;
use crate::SessionId;

/// Which kind of textual response a turn produced (ADR-0009 textual branch,
/// evolved by ADR-0077/0081): a plain agent answer, a disambiguation question
/// (ADR-0018), or an out-of-scope refusal (ADR-0017). The frontend renders the
/// kinds distinctly so a user can tell an answer from "answer me this" from
/// "I won't do that".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextKind {
    /// A plain agent answer (ADR-0077/0081): the runtime's terminal text reply
    /// on a turn that promoted no result. The native tool-calling contract
    /// carries no structural clarify/refuse marker -- an honest answer, a
    /// clarification question, and a default-skillset boundary refusal
    /// (ADR-0079) all ride this kind; the body text itself carries which.
    Agent,
    /// A disambiguation / clarification question (ADR-0018): the provider could
    /// not confidently infer the intent and asks back rather than guess.
    /// Emitted only by the legacy single-SQL contract (ADR-0009), whose JSON
    /// reply names the kind explicitly; the tool-calling path maps every
    /// terminal text to [`Self::Agent`].
    Clarify,
    /// An out-of-scope refusal (ADR-0017): the request is outside v1's SQL-only
    /// capability boundary; the provider refuses honestly instead of faking.
    /// Legacy single-SQL contract only, like [`Self::Clarify`].
    Refuse,
}

/// One chart kind in the v1 whitelist (ADR-0016): the closed set a provider viz
/// may target -- table / bar / line / scatter / area / pie. A kind the LLM
/// returns outside this set fails to deserialize at the contract boundary and
/// is retried like any malformed reply (ADR-0028); a Vega-Lite `mark` outside
/// this set (a whitelisted kind whose spec nonetheless draws a non-whitelisted
/// chart) degrades to a table in the frontend (ADR-0033).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartKind {
    Table,
    Bar,
    Line,
    Scatter,
    Area,
    Pie,
}

/// A provider-emitted viz spec (ADR-0016/0033): one chart kind from the v1
/// whitelist plus the Vega-Lite JSON that renders it. The frontend renders
/// `spec` via Vega-Embed; a malformed spec, a non-whitelisted mark, or a
/// rendering failure degrades to the underlying table with a disclosure
/// (ADR-0033 -- silent degradation is a silent lie). `kind` is the provider's
/// structured intent; `spec` is the opaque Vega-Lite JSON carried verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VizSpec {
    pub kind: ChartKind,
    /// Vega-Lite JSON spec, rendered by Vega-Embed in the frontend (ADR-0016).
    pub spec: String,
}

/// Why a turn failed (ADR-0028 outcome C). Replaces the former free-text
/// `reason: String`: the failure kind crosses IPC as this serde struct, nested
/// under [`TurnOutcome::Failed`], and the frontend narrows on `kind` to render a
/// locale message -- so the hand-written `Display` below is Rust-log-only and
/// feeds the LLM window payload (a text consumer), NOT the frontend IPC
/// contract (issue #125, ADR-0052 locale switching). Mirrored by `TurnFailure`
/// in src/types.ts and reused by [`crate::persistence::recipe::RecipeOutcome::Failed`]
/// so the kind survives save/resume -- a resumed failure renders with the same
/// locale message it had live, not a flattened string.
///
/// `detail` (Execute / Resource) is a technical, engine-level explanation that
/// rides the frontend's collapsed "Technical details" fold, never the primary
/// message (ADR-0029: the detail is a DuckDB / engine string, audited to carry
/// no API key). `StaleReference` carries the dead reference name so the locale
/// template can name it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum TurnFailure {
    /// An execution-level failure (ADR-0028, calibrated by ADR-0077/0081):
    /// the agent loop's step cap exhausted without the model converging
    /// (`detail` says so), or a transient provider fault surfaced after the
    /// adapter's own HTTP retry (the transport detail rides `detail`; blind
    /// retry is abolished). Rides the technical fold.
    Execute { detail: String },
    /// An engine-level resource cap aborted the turn (ADR-0005 L3): memory
    /// ceiling, result-row ceiling, or a blocked filesystem function. NOT
    /// retried -- the same SQL hits the same wall. `detail` is the engine's cap
    /// explanation (technical); rides the fold.
    Resource { detail: String },
    /// No LLM provider is wired (ADR-0029 invariant 3): no API key is stored,
    /// the stored key was rejected (HTTP 401/403, ADR-0044), or -- in test/dev
    /// -- no provider at all. Permanent for the turn; the user must configure a
    /// key. Carries no data -- the locale message is self-contained.
    NotWired,
    /// The provider's configuration is permanently invalid (issue #277): a
    /// non-http/https base_url (file:, data:, scheme-less) or another
    /// configuration fault retrying cannot fix. NOT retried -- the same config
    /// would fail identically. `detail` is the configuration diagnosis (e.g.
    /// "scheme `file` is not http/https"); rides the technical fold, like
    /// Execute / Resource.
    InvalidConfig { detail: String },
    /// The provider SQL referenced a stale result_N (ADR-0013 invariant 2,
    /// issue #40). NOT retried -- the same SQL would reference the same stale
    /// result. `reference_name` is the dead reference, interpolated into the
    /// locale template ("result_1 is stale").
    StaleReference { reference_name: String },
}

impl std::fmt::Display for TurnFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        // Rust-log-only (issue #125): the IPC contract is the serde struct
        // above and the authoritative user wording lives in the frontend locale
        // catalog. These English identifiers feed the Rust log and the LLM
        // window payload (provider::ResponsePayload::Failed, a text consumer),
        // never the frontend render path -- so they never cross the Tauri IPC
        // to the webview.
        match self {
            Self::Execute { detail } => write!(f, "turn failed (budget exhausted): {detail}"),
            Self::Resource { detail } => write!(f, "turn aborted by resource cap: {detail}"),
            Self::NotWired => write!(f, "turn failed: no LLM provider wired"),
            Self::InvalidConfig { detail } => {
                write!(f, "turn failed: invalid provider configuration: {detail}")
            }
            Self::StaleReference { reference_name } => {
                write!(f, "turn failed: stale reference {reference_name}")
            }
        }
    }
}
impl std::error::Error for TurnFailure {}

/// One working-set promotion (ADR-0022/0077, representation ADR-0084): the
/// dataset descriptor a `materialize` call registered, paired with the verbatim
/// SQL that produced it. The descriptor alone does not carry its SQL, and the
/// recipe's replayable chain reads the SQL here, so the two always travel
/// together. A result turn's outcome carries these in promotion order (one or
/// more); the chain tail is the turn's primary result -- a derived property,
/// never a stored field (see [`TurnOutcome::primary_promotion`]). Crosses IPC
/// nested under [`TurnOutcome::Materialized`] and is mirrored by
/// src/types/thread.ts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Promotion {
    /// The materialized result's descriptor (a Dataset like any source,
    /// ADR-0003): reference name, display name, columns, sample, row count.
    pub dataset: DatasetDescriptor,
    /// The verbatim SQL that produced this promotion (ADR-0009/0023): the
    /// recent-turn window ships it so the provider sees its own prior SQL, and
    /// the recipe's productive chain re-executes it on resume.
    pub sql: String,
}

/// One turn outcome (ADR-0028): one exhaustive four-way classification. A turn
/// always produces exactly one, regardless of whether it materialized a result
/// -- "no result" is itself a typed outcome, never a silent gap. The four kinds
/// share three invariants (always visible, always occupy a thread slot, never
/// advance result_N except Materialized); they differ only in recoverability.
///
/// Slice #23 widens #22's single Materialized variant to the full set. The
/// adjacently-tagged wire shape (`kind`/`data`) is pinned by tests/ipc_contract
/// and mirrored by src/types.ts -- adding a variant here requires the frontend
/// match to follow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum TurnOutcome {
    /// Outcome A -- a result turn (ADR-0077 "one or more promotions";
    /// representation ADR-0084): the agent loop materialized one or more
    /// result_N this turn. Carries the full promotion chain in promotion order
    /// (each a dataset descriptor + the verbatim SQL that produced it); the
    /// chain tail is the turn's primary result -- derived via
    /// [`TurnOutcome::primary_promotion`], never a stored field. Plus the
    /// provider's optional assumption note (ADR-0009), surfaced as a
    /// correctable side note. This is the only outcome that advances result_N
    /// numbering (one number per promotion, in promotion order, ADR-0022).
    Materialized {
        /// The turn's promotions in promotion order (ADR-0022 monotonic
        /// numbering: result_1, result_2, ...). Non-empty for a result turn;
        /// the chain tail is the primary result the terminal answer references.
        promotions: Vec<Promotion>,
        /// The provider's optional viz spec (ADR-0016/0033): the LLM-decided
        /// chart to render over the primary result, or `None` for a plain table
        /// turn (the default -- a visual intent is required to emit one,
        /// ADR-0033). Carried verbatim to the frontend, which renders it or
        /// degrades to the table with a disclosure. `#[serde(default)]` keeps
        /// older IPC peers (from before #26) deserializing to `None`.
        #[serde(default)]
        viz: Option<VizSpec>,
        assumption: Option<String>,
    },
    /// Outcome B -- a textual turn: the provider answered with text, not SQL --
    /// a disambiguation question (ADR-0018) or an out-of-scope refusal
    /// (ADR-0017). Carries which kind, the body text, and an optional
    /// assumption note (e.g. the method name behind a refusal). Occupies a
    /// thread slot but does NOT advance result_N.
    Textual {
        text_kind: TextKind,
        body: String,
        assumption: Option<String>,
    },
    /// Outcome C -- a failed turn: the agent loop's execution cap exhausted
    /// without convergence, a provider fault (not-wired / invalid-config /
    /// transient), or a replayed-chain failure on resume (ADR-0028, calibrated
    /// by ADR-0077/0081). Tool-level errors (SQL failure / stale reference)
    /// do NOT fail the turn on the live path -- they route back to the model
    /// for self-correction (ADR-0077). Carries the typed [`TurnFailure`] kind
    /// so the frontend renders a locale message by kind, never a backend
    /// Display string (issue #125). Occupies a thread slot but does NOT
    /// advance result_N.
    Failed(TurnFailure),
    /// Outcome D -- a cancelled turn (placeholder): abort via user cancel /
    /// resource cap / statement timeout (ADR-0021). The cancel mechanism lands
    /// in #28; this variant exists now so the four-way classification is
    /// complete and the frontend can render it, but no code path produces it
    /// yet.
    Cancelled,
}

impl TurnOutcome {
    /// The turn's primary promotion (ADR-0084): the chain tail -- the result
    /// the terminal answer references, by the loop's termination shape (the
    /// model materializes, then writes its terminal text about the last
    /// product). Derived, never stored: routing every "which result is THE
    /// answer" read through this single call site keeps "primary == last"
    /// consistent by construction, with no stored index that could disagree
    /// with the chain. `None` for a non-Materialized outcome.
    pub fn primary_promotion(&self) -> Option<&Promotion> {
        match self {
            TurnOutcome::Materialized { promotions, .. } => promotions.last(),
            _ => None,
        }
    }
}

/// One entry in the conversation thread (ADR-0028/0039): the verbatim user
/// question paired with its outcome. Every turn appends exactly one -- always
/// visible, occupying a timeline slot -- regardless of whether the outcome
/// produced a result_N. Only [`TurnOutcome::Materialized`] advances result_N
/// numbering; the others occupy a slot but consume no number. The question is
/// the entry's label in the user's own words (ADR-0039: the step label is the
/// verbatim question, never an LLM-generated title).
///
/// The [`trace`](Self::trace) is the turn's collapsible execution substructure
/// (ADR-0078, issue #297): the display view of every tool call the turn made.
/// The rail shows the question + outcome always and expands the trace on
/// demand. This is the DISPLAY view -- bounded summaries + a failed-call
/// excerpt only, the same shape the recipe persists ([`crate::persistence::
/// recipe::RecipeTraceEntry`]); the full in-memory call payloads never cross
/// IPC, and the far window still carries only the trace's summary (call
/// count + failure summary), never the entries verbatim. The window assembler
/// reads [`Self::question`] + [`Self::outcome`] alone, so the trace adds no
/// LLM tokens. Empty for v1-era migrated turns and zero-call turns.
/// One skill recorded on a turn's provenance (ADR-0086, issue #363/#381): the
/// spec `name` (stable identity, equal to the directory name) + the SHA-256 of
/// the skill's `SKILL.md` bytes at the turn's assembly time. The hash is the
/// stale-degrade anchor -- the frontend drift-compares it against the
/// registry's current
/// [`SkillEntry::content_hash`](crate::skills::model::SkillEntry::content_hash)
/// and surfaces a "modified" drift badge on a mismatch (issue #381); an empty hash means no
/// baseline (a v3->v4 migration product, or the skill's `SKILL.md` was
/// unreadable at turn time), so the check never trips and a migrated recipe
/// never false-positives.
///
/// This is the IPC + persistence shared type --
/// [`crate::persistence::recipe`] re-uses it for its own (wider) provenance
/// struct, so the wire shape and the `.duck` shape stay byte-identical
/// (issue #381 lifts it from recipe to model so the IPC [`TurnRecord`] carries
/// it without forking a parallel type).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillProvenance {
    /// The skill's spec `name` (kebab-case identity, ADR-0086 Decision 2).
    pub name: String,
    /// SHA-256 hex of the `SKILL.md` bytes at the turn's assembly time, or the
    /// empty string when no baseline exists (v3->v4 migration output, or the
    /// file was unreadable at turn time -- never trips the drift check).
    pub content_hash: String,
}

/// Per-turn skill provenance crossing IPC (issue #381): the active skills at
/// the turn's assembly time, each with its [`SkillProvenance::content_hash`] so
/// the frontend drift-compares against the registry and surfaces a "modified" badge for
/// a skill whose content changed after this turn. Mirrors the skills half of
/// the persisted [`crate::persistence::recipe::TurnProvenance`] (which also
/// carries the runtime kind); the IPC wire is intentionally narrower -- the
/// runtime is backend audit only, never crosses to the webview. Empty `skills`
/// for turns that mounted no skill and for v3->v4 migrated turns (no baseline).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TurnProvenance {
    pub skills: Vec<SkillProvenance>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnRecord {
    pub question: String,
    pub outcome: TurnOutcome,
    pub trace: Vec<TraceEntryView>,
    /// The turn's skill provenance (issue #381): each mounted skill at assembly
    /// time, with its `content_hash` for drift comparison against the registry.
    /// Empty for turns that mounted no skill and for v3->v4 migrated turns.
    pub provenance: TurnProvenance,
}

/// The display form of one execution-trace entry (ADR-0078, issue #297): what
/// the rail's expanded trace + the in-flight `turn-progress` tool-call events
/// carry. Field-for-field the persisted [`crate::persistence::recipe::
/// RecipeTraceEntry`] shape, so a live turn and its resumed reincarnation
/// render identically: a successful call's result payload is dropped at
/// capture (data-bearing; the `.duck` carries none of it, ADR-0036) while a
/// failed call carries its bounded error / denial message -- the cross-turn
/// failure retrospection anchor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraceEntryView {
    /// Tool name -- a built-in (`explore` / `materialize` / `describe` /
    /// `sample`) or an external MCP server's tool name.
    pub name: String,
    /// Operation badge (ADR-0083 read/write/execute/network) -- presentation
    /// only.
    pub operation_kind: OperationKind,
    /// Short argument summary (the SQL or reference_name), NOT the full args.
    pub summary: String,
    /// Whether the call succeeded. A tool-level error (incl. an approval
    /// denial) routes back to the agent (ADR-0077); the trace records it.
    pub success: bool,
    /// Bounded excerpt of a FAILED call's result (error / denial message);
    /// empty for a successful call.
    pub result_excerpt: String,
}

/// One discrete progress event of an in-flight turn. ADR-0059 introduced the
/// `turn-progress` side channel with `Thinking` / `Querying` phase markers;
/// ADR-0078 (issue #297) calibrates it into a TOOL-CALL EVENT STREAM -- the
/// trace is the stream's persisted form, so the rail renders the in-flight
/// turn's trace progressively from the same events that later land on
/// [`TurnRecord::trace`]. `Thinking` survives as the one wait that is not a
/// tool call (the LLM round-trip); the retired `Querying` marker is superseded
/// by the `ToolCallStarted` / `ToolCallCompleted` pair around each dispatch.
/// The attempt number is the 1-based agent STEP (round-trip, ADR-0081), so a
/// multi-step trajectory reads "step N" honestly. Rides the side-channel
/// `turn-progress` event; does NOT enter the [`TurnOutcome`] contract payload.
///
/// Externally-tagged on the wire (`{"Thinking":{"attempt":1}}`) to mirror the
/// sibling [`crate::ResumeEvent`] resume-progress event shape.
/// `ToolCallCompleted` wraps a [`TraceEntryView`] verbatim (a newtype variant
/// serializes to the same flat object the struct fields would), so the
/// frontend appends the payload as its live trace entry with zero mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnPhase {
    /// About to call the provider (the LLM "thinking" wait). Fired once per
    /// step, after the loop-top cancel pre-check, right before
    /// `generate_tool_turn`.
    Thinking { attempt: u32 },
    /// A tool call passed the approval gate (ADR-0080) and is about to
    /// dispatch. Fired right before `tools::dispatch` -- AFTER the gate, so a
    /// gated call surfaces as an `approval-request` event first and only
    /// starts once allowed. The frontend renders the in-flight row (spinner);
    /// `summary` matches the approval card's so the two merge into one row.
    ToolCallStarted {
        name: String,
        operation_kind: OperationKind,
        summary: String,
    },
    /// A tool call finished dispatch (or was denied at the gate): the trace
    /// entry exactly as it lands on [`TurnRecord::trace`]. Fired once per
    /// call, paired with its `ToolCallStarted` (a gate-denied call fires only
    /// this, with `success: false`). The excerpt follows the persisted shape
    /// -- empty on success, the bounded failure / denial message on failure.
    ToolCallCompleted(TraceEntryView),
}

/// One `turn-progress` side-channel event (ADR-0059, issue #76). Wraps a
/// [`TurnPhase`] with the addressing `session_id` so a multi-session frontend
/// filters the global Tauri event broadcast down to the one SessionPane that
/// owns the turn (ADR-0056). `session_id` is the runtime id the `ask` command
/// received (a typed UUID), NOT the `duck_path` [`crate::SessionMetadata`]
/// exposes. The field is required -- a phase without a session it belongs to is
/// not addressable, so the type makes the missing-id state unrepresentable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnProgress {
    pub session_id: SessionId,
    pub phase: TurnPhase,
}
