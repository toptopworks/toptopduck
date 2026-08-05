//! Domain types crossing the Rust<->frontend IPC boundary and the black-box test
//! seam. Vocabulary follows CONTEXT.md (Dataset / Working Set / Active Dataset)
//! and ADR-0037 (reference name vs display label).

use serde::{Deserialize, Serialize};

use crate::approval::OperationKind;

/// One column's canonical schema (ADR-0032): the DuckDB physical type verbatim,
/// under a single canonical name (no alias mixing). Nested STRUCT/LIST/MAP
/// expansion arrives with JSON in slice 2; slice 1 (CSV) is flat types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnSchema {
    pub name: String,
    pub canonical_type: String,
}

/// One Excel sheet's user-chosen rectify decisions (ADR-0042): only the user's
/// explicit choices enter the recipe; the deterministic auto-tidy algorithm
/// itself never does -- resume re-runs the current version. Recorded on the
/// descriptor so a future recipe (ADR-0034) can persist it. CSV / Parquet /
/// JSON and Excel sheets that auto-tidied without a user override carry `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SheetRectify {
    /// 1-based index of the row whose cells become the column header. Rows
    /// above it (titles, blanks) are skipped. `1` = the first row is the header,
    /// which is also the [`Default`] (a plain single-header rectify).
    pub header_row: u32,
    /// 1-based absolute row indices *below* the header row to drop when
    /// materializing (separator / sub-header / footer rows). Data rows are
    /// every non-header, non-skipped row from the header down to the last
    /// non-empty row. Empty by default (skip nothing).
    pub skip_rows: Vec<u32>,
}

impl Default for SheetRectify {
    /// A plain single-header rectify: row 1 is the header, nothing skipped.
    /// Used when a guided ingest receives no entry for a sheet, so the default
    /// matches the documented `1` instead of the raw `u32::default()` of `0`.
    fn default() -> Self {
        Self {
            header_row: 1,
            skip_rows: Vec::new(),
        }
    }
}

/// Provenance of a dataset's rectify state (ADR-0042): turns the rule "only the
/// user's explicit choices are recorded; the deterministic auto-tidy algorithm
/// is never persisted" into a type-level invariant instead of a convention. A
/// future recipe re-derives the materialized table from this provenance.
///
/// - [`RectifyProvenance::NotApplicable`]: the format has no rectify step
///   (CSV / Parquet / JSON).
/// - [`RectifyProvenance::Auto`]: an Excel sheet auto-tidied confidently; the
///   algorithm's choices aren't carried, so resume re-runs the current version.
/// - [`RectifyProvenance::User`]: the user supplied explicit header/skip choices
///   via the guided path; the params ride the descriptor so a future recipe can
///   persist them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum RectifyProvenance {
    NotApplicable,
    Auto,
    User(SheetRectify),
}

impl Default for RectifyProvenance {
    /// `NotApplicable` -- the common case for the non-Excel formats, and the
    /// safe fallback when a deserialized descriptor omits the field.
    fn default() -> Self {
        Self::NotApplicable
    }
}

/// Per-dataset privacy controls (ADR-0011, issue #9 slice 5): govern what of a
/// source Dataset may leave the local trust boundary in the LLM payload. The
/// config rides the descriptor (the single source of truth shared with the UI),
/// so it persists in the working-set metadata across UI resize, active-dataset
/// switch, and source replace. The actual payload **pruning** happens in the
/// query-loop window assembler (PRD #1) -- this slice only stores + reads the
/// config, keeping a clear cross-PRD contract: #1 reads `privacy` off the same
/// descriptor it already reads schema/sample from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetPrivacy {
    /// Whether any sample rows of this dataset may be sent off-machine
    /// (ADR-0011). Defaults to true: real samples measurably improve SQL
    /// quality on dirty data, which is the product's lifeblood. When false,
    /// PRD #1 will ensure no cell values of this dataset enter the LLM payload.
    #[serde(default = "default_send_samples")]
    pub send_samples: bool,
    /// Column names marked "type only" (ADR-0011). Stored by column name (a
    /// column has no separate display name in v1). Treated as a set at read
    /// time, so stale entries after a schema-changing replace are simply
    /// ignored. PRD #1 will use this to exclude the column's values and name
    /// from the LLM payload, sending only the DuckDB type.
    #[serde(default)]
    pub type_only_columns: Vec<String>,
}

/// Serde default for [`DatasetPrivacy::send_samples`]: true (ADR-0011 default --
/// real samples sent, user-controlled, honestly disclosed).
fn default_send_samples() -> bool {
    true
}

impl Default for DatasetPrivacy {
    /// Samples on, no type-only columns -- the ADR-0011 default. Used when a
    /// deserialized descriptor omits `privacy` (backward compat with older
    /// recipes), and as the initial state of every freshly loaded Dataset.
    fn default() -> Self {
        Self {
            send_samples: true,
            type_only_columns: Vec::new(),
        }
    }
}

/// The descriptor of a loaded source Dataset: the artifact registered in the
/// working set and surfaced to the UI (and, later, the LLM payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetDescriptor {
    /// Reference name (ADR-0037): machine name, fixed at creation. Used by SQL,
    /// the recipe chain, and the active-dataset pointer.
    pub reference_name: String,
    /// Display label (ADR-0037): user-renamable; defaults to the original
    /// filename/sheet stem, falling back to the reference name when no stem can
    /// be extracted.
    pub display_name: String,
    /// Absolute source path (the original file -- never modified, ADR-0004).
    pub source_path: String,
    /// Per-column canonical DuckDB types (ADR-0032).
    pub columns: Vec<ColumnSchema>,
    /// Total row count of the frozen snapshot.
    pub row_count: u64,
    /// First 3 rows frozen at copy-in (ADR-0026), each a vector of rendered cells.
    pub sample: Vec<Vec<String>>,
    /// SHA256 (hex) of the post-copy-in snapshot (ADR-0042); the content hash of
    /// the *post-rectify* table, so different rectify choices yield different
    /// fingerprints when they change the materialized rows.
    pub fingerprint: String,
    /// Rectify provenance (ADR-0042): how the dataset's header/skip state was
    /// determined -- format N/A, Excel auto-tidy (not recorded), or the user's
    /// explicit guided choices (carried so a future recipe can persist them).
    #[serde(default)]
    pub rectify: RectifyProvenance,
    /// Privacy controls (ADR-0011, issue #9 slice 5): what of this dataset may
    /// leave the local trust boundary in the LLM payload. Defaults to "samples
    /// on, no type-only columns"; `#[serde(default)]` keeps older descriptors
    /// (and recipes) deserializing to that default.
    #[serde(default)]
    pub privacy: DatasetPrivacy,
    /// Stale-state anchor (issue #40/#41, ADR-0013): `None` for an active
    /// dataset; `Some` for a stale result_N whose upstream source was removed
    /// or replaced, naming the source lifecycle event that invalidated it
    /// (traceability, ADR-0040). A
    /// stale result stays visible (read_rows / thread) but is excluded from the
    /// LLM working set and refused as a new SQL reference. `#[serde(default)]`
    /// keeps older descriptors (and recipes) deserializing to active -- a result
    /// is fresh unless explicitly marked stale by the cascade. Omitted on the
    /// wire when active (`skip_serializing_if`), so a fresh descriptor's JSON is
    /// byte-identical to pre-#40 (an active result never carried the field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<StaleAnchor>,
}

/// Why a result_N went stale and which kind of source event invalidated it
/// (issue #40/#41, ADR-0013/0040/0041). The UI renders each variant distinctly
/// in the stale badge (issue #41 AC4): `Deleted` -> "因源已删除而失效";
/// `Replaced` -> "因源已更新而失效". Crosses IPC as a bare variant string (like
/// [`SourceLifecycleKind`]).
// `Default` -> `Deleted` is intentional: a StaleAnchor deserialized from a
// pre-#41 recipe carries no `reason` field, and Deleted was the only stale
// cause that existed before #41's replace-cascade, so defaulting to Deleted
// preserves the prior semantics byte-for-byte (an older session's stale
// results were all delete-cascaded).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum StaleReason {
    /// The source was removed (issue #38/#40): the reference name is gone from
    /// the shared namespace and its data is truly unreachable.
    #[default]
    Deleted,
    /// The source was re-uploaded under the same reference name (ADR-0025,
    /// issue #41): the name still resolves (now to a new snapshot), but v1
    /// treats the cascade as a dead turn (ADR-0041) -- the old derivation is
    /// never revived, the user re-asks against the new data.
    Replaced,
}

/// Why a result_N is stale and which source lifecycle event invalidated it
/// (issue #40/#41, ADR-0013/0040): a snapshot of the invalidating source
/// event's identity, captured on the dependent when the cascade marks it. The
/// reference name is the stable identity (the same key SQL / the recipe chain
/// used); the display label is carried verbatim so the UI can render "因
/// 「Orders」已删除而失效" / "因「Orders」已更新而失效" after the source itself
/// is gone or swapped. Each stale result traces back to exactly one
/// invalidating source event (ADR-0040 traceability anchor); [`StaleReason`]
/// says which kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaleAnchor {
    /// Reference name of the source whose removal/replacement invalidated this
    /// result -- the stable key that named the source in SQL / the recipe chain.
    pub reference_name: String,
    /// Display label of that source at event time, so the thread still names
    /// what was removed/replaced after the descriptor is gone.
    pub display_name: String,
    /// Which kind of source event invalidated this result (issue #41).
    /// `#[serde(default)]` -> [`StaleReason::Deleted`] keeps pre-#41 recipes
    /// loading (reason was the only stale cause before the replace-cascade).
    #[serde(default)]
    pub reason: StaleReason,
}

/// One visible Excel sheet's raw preview for the guided-load dialog: enough rows
/// (rendered as strings) for the user to locate the header row and mark skips.
/// Pre-rectify, so merged cells appear as their top-left value with blanks below
/// -- exactly what the user sees in Excel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuidanceSheet {
    pub name: String,
    /// Raw top-of-sheet cell rows as rendered strings (ADR-0026 rendering).
    pub preview: Vec<Vec<String>>,
}

/// A workbook the auto-tidy could not confidently rectify (ADR-0015 guided
/// fallback). No sheet is loaded -- the working set is untouched (AC6/AC7) --
/// and the user's guided choices re-enter via [`LoadOutcome`] -> guided ingest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuidanceRequest {
    pub source_path: String,
    /// Readable workbook stem (display label, ADR-0037).
    pub workbook_name: String,
    /// One preview per visible, non-blank sheet, in workbook order.
    pub sheets: Vec<GuidanceSheet>,
}

/// One sheet's guided-load answer: the sheet name plus the user's rectify
/// choices. A guided ingest takes one per sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SheetGuidance {
    pub name: String,
    pub rectify: SheetRectify,
}

/// Why an ingest failed. Surfaced to the UI; a failed load leaves the working
/// set unchanged (a bad file never pollutes the session -- PRD AC7). Crosses IPC
/// inside `LoadOutcome::Error` as this serde struct; the frontend renders each
/// kind through the locale catalog (issue #121), so the hand-written `Display`
/// below is Rust-log-only -- it is NOT the IPC contract and carries no user
/// wording (the Chinese lives once, in the locale files).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum LoadError {
    UnsupportedFormat {
        requested: String,
    },
    /// Legacy `.xls` (BIFF8) is rejected in v1 -- the excel toolchain only
    /// handles `.xlsx`, and bundling a converter is out of scope (YAGNI). The
    /// user must re-save as `.xlsx` (ADR-0015). Surfaced distinctly from a
    /// generic unsupported format so the UI can show the actionable hint.
    LegacyExcel,
    Parse {
        detail: String,
    },
    Io {
        detail: String,
    },
    /// A replace targeted a reference name no dataset carries (issue #131).
    /// Surfaced distinctly from `Other` so the frontend renders the shared
    /// `error.dataset.notFound` catalog id instead of flattening a backend
    /// free-text detail into the primary message.
    UnknownDataset {
        reference_name: String,
    },
    Other {
        detail: String,
    },
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        // Rust-log-only (issue #121): the IPC contract is the serde struct above
        // and the user wording lives in the frontend locale catalog, so these
        // English identifiers never reach the UI.
        match self {
            Self::UnsupportedFormat { requested } => {
                write!(f, "unsupported format: {requested}")
            }
            Self::LegacyExcel => write!(f, "legacy .xls not supported (re-save as .xlsx)"),
            Self::Parse { detail } => write!(f, "parse failed: {detail}"),
            Self::Io { detail } => write!(f, "read failed: {detail}"),
            Self::UnknownDataset { reference_name } => {
                write!(f, "dataset not found: {reference_name}")
            }
            Self::Other { detail } => write!(f, "load failed: {detail}"),
        }
    }
}
impl std::error::Error for LoadError {}

/// Outcome of an ingest attempt at the command boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum LoadOutcome {
    Loaded(DatasetDescriptor),
    /// Auto-tidy couldn't confidently rectify an Excel sheet (ADR-0015): the
    /// load is *not* an error -- the UI must gather explicit header/skip choices
    /// (ADR-0042 user decisions) and re-ingest via the guided path. The working
    /// set is unchanged.
    NeedsGuidance(GuidanceRequest),
    Error(LoadError),
}

/// Why a display-label rename was rejected (ADR-0037). A rename only ever touches
/// the display name -- never the reference name -- so a rejection leaves the
/// working set and every existing reference (SQL FROM, recipe chain, active
/// pointer) unchanged. Crosses IPC as this serde struct, wrapped in
/// [`SessionError::RenameDataset`](crate::session_store::SessionError) (issue
/// #121); the frontend narrows on `kind` and renders a locale message, so the
/// hand-written `Display` below is Rust-log-only -- NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum RenameError {
    /// No dataset carries the given reference name.
    NotFound(String),
    /// The requested display label is already shown by another dataset (display-
    /// layer uniqueness, ADR-0037). The user must pick a different label; a
    /// rename is an explicit user action, so silent de-conflict would surprise.
    DisplayTaken(String),
    /// The requested display label is empty or whitespace-only (ADR-0037). A
    /// display label must be visible, so blanks are rejected; the user must
    /// supply a non-blank label.
    InvalidLabel,
}

impl std::fmt::Display for RenameError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        // Rust-log-only (issue #121): the IPC contract is the serde struct above
        // and the user wording lives in the frontend locale catalog, so these
        // English identifiers never reach the UI.
        match self {
            Self::NotFound(name) => write!(f, "dataset not found: {name}"),
            Self::DisplayTaken(label) => write!(f, "display label already taken: {label}"),
            Self::InvalidLabel => write!(f, "invalid display label (empty or whitespace)"),
        }
    }
}
impl std::error::Error for RenameError {}

// --- Turn / result materialization (issue #22/#23, query loop) --------------
//
// The ask -> outcome loop (PRD #1): a question goes in, the agent loop runs
// tool calls (explore / materialize) on the session DuckDB, and promoted rows
// land as a materialized result_N physical table (ADR-0003/0024/0077). The
// ADR-0028 four-way outcome classification (result / textual / failed /
// cancelled) + the always-visible thread are the stable contract; the single
// retry budget that once lived here was retired with the single-SQL contract
// (ADR-0077 -- tool errors route back to the model for self-correction).

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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnRecord {
    pub question: String,
    pub outcome: TurnOutcome,
    pub trace: Vec<TraceEntryView>,
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
/// received (a UUID string), NOT the persisted-session id [`crate::SessionMetadata`]
/// exposes. The field is required -- a phase without a session it belongs to is
/// not addressable, so the type makes the missing-id state unrepresentable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnProgress {
    pub session_id: String,
    pub phase: TurnPhase,
}

// --- Source lifecycle events (issue #38, ADR-0040) -------------------------
//
// A source lifecycle event is a user-driven mutation of the working set's
// source membership (add / delete -- replace lands in #41). It is a first-class
// thread entry that occupies a timeline slot and is always visible, but it is
// NOT a turn (no question, no outcome): it never enters the LLM turn window,
// never occupies an N=20 slot, and never advances result_N (ADR-0040). The
// window assembler (crate::window) consumes turns only, so source events are
// naturally excluded from the provider payload.

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
/// [`crate::persistence::recipe::SkillProvenance`]'s `content_hash`, so the
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
/// [`crate::persistence::recipe::SkillProvenance::content_hash`], not by
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

/// Why a row read failed. A turn no longer fails across this type -- turn
/// failures are [`TurnOutcome::Failed`] (ADR-0028), so a turn always produces an
/// outcome. This type remains only for [`crate::session::Session::read_rows`]: a
/// row read is not a turn, and its failures cross IPC as this serde struct,
/// wrapped in [`SessionError::Turn`](crate::session_store::SessionError) (issue
/// #121); the frontend narrows on `kind` and renders a locale message. The
/// hand-written `Display` below is Rust-log-only -- NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum TurnError {
    /// A row read targeted a reference name that is not in the working set.
    UnknownDataset(String),
    /// The row-page query failed in the engine (a read-side DuckDB error while
    /// counting or paging rows). Distinct from a turn's SQL failing, which is
    /// now a [`TurnOutcome::Failed`].
    Execute(String),
}

impl std::fmt::Display for TurnError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        // Rust-log-only (issue #121/#125): the IPC contract is the serde struct
        // above and the authoritative user wording lives in the frontend locale
        // catalog. Both variants are English log identifiers; Execute no longer
        // shares a Chinese prefix with TurnOutcome::Failed -- that outcome now
        // carries a typed TurnFailure whose wording also lives in the catalog.
        match self {
            Self::UnknownDataset(name) => write!(f, "unknown dataset: {name}"),
            Self::Execute(detail) => write!(f, "row read failed: {detail}"),
        }
    }
}
impl std::error::Error for TurnError {}

/// One page of a dataset rows (ADR-0024 windowed display). Cells are CAST to
/// VARCHAR (NULL renders as the empty string) so the frontend renders uniform
/// strings. `total` is the full row count -- the frontend shows it alongside
/// the page so a truncated view never masquerades as complete (ADR-0030).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RowPage {
    pub columns: Vec<ColumnSchema>,
    pub rows: Vec<Vec<String>>,
    pub total: u64,
    pub offset: u64,
    pub limit: u64,
}

// --- LLM provider config (issue #29/#150, ADR-0007/0019/0029/0064) ------------
//
// Multi-profile provider config (ADR-0064): a list of named access profiles
// (protocol + endpoint + model) plus the id of the active one. The active
// profile drives the live provider; its id is the keychain account suffix
// (`key-<id>`). The API key is NOT here (ADR-0029/0038: key only in the OS
// keychain, never in app-config). This slice ships a single default anthropic
// profile -- the multi-profile / openai-protocol surface is a follow-up.

/// v1 default endpoint (ADR-0019: Anthropic native protocol + configurable
/// `baseURL`; default is Anthropic direct).
pub const DEFAULT_PROVIDER_BASE_URL: &str = "https://api.anthropic.com";

/// v1 default model (ADR-0007: Sonnet-class, version-pinned). SQL + structured
/// JSON output at top tier with controllable cost; the user can switch to a
/// stronger (Fable/Opus) or cheaper (Haiku) model via the config.
pub const DEFAULT_PROVIDER_MODEL: &str = "claude-sonnet-4-6";

/// The wire protocol a profile speaks (ADR-0064). Two variants: anthropic
/// (Anthropic Messages native, `x-api-key` auth) and openai (OpenAI Chat
/// Completions, Bearer auth; covers OpenAI direct / DeepSeek / GLM / Qwen /
/// Ollama compatible endpoints). Crosses IPC as the bare lowercase variant
/// name (mirrors the ChartKind convention).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Anthropic,
    /// OpenAI Chat Completions wire protocol (ADR-0064). A pure HTTP
    /// translation layer: Chat Completions request shape, Bearer auth, reads
    /// `choices[0].message.content`, reuses the shared `parse_reply`. Covers
    /// OpenAI direct / DeepSeek / GLM / Qwen / Ollama compatible endpoints --
    /// the user points `base_url` at the endpoint (incl. its version path
    /// segment, e.g. `/v1`); the adapter appends `/chat/completions`.
    Openai,
}

/// Stable identity of a provider profile (ADR-0064, mirroring the ADR-0037
/// reference_name half of the stable-vs-display split). Created once when the
/// profile is minted and never mutated thereafter -- [`ProviderProfile::display_name`]
/// is the renamable half. Opaque: carried verbatim across IPC and used as the
/// keychain account suffix (`key-<id>`). Callers must not assume any structure.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(pub String);

impl ProfileId {
    /// The id as a string slice (for keychain account formatting, lookups, etc.).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ProfileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl AsRef<str> for ProfileId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl Default for ProfileId {
    fn default() -> Self {
        // Falls back to the default profile's id so a config missing the
        // active_profile field (serde default) points at the built-in default
        // profile rather than an empty / dangling id.
        Self(DEFAULT_PROFILE_ID.to_string())
    }
}

/// The id of the built-in default profile (ADR-0064/0038 honest-degrade +
/// first-launch skeleton). FIXED so repeated first-launches and degrades
/// converge on the same keychain account (`key-default`) rather than minting a
/// fresh id each time -- a user who sets a key once keeps it across a degrade.
/// User-created profiles (a follow-up slice) will mint their own ids.
pub const DEFAULT_PROFILE_ID: &str = "default";

/// Display name of the built-in default profile.
const DEFAULT_PROFILE_DISPLAY_NAME: &str = "Anthropic";

/// One named access profile (ADR-0064): protocol + endpoint + model. The key
/// lives separately in the OS keychain under `key-<id>` (ADR-0029/0038). `id`
/// is stable (created once); `display_name` is renamable (ADR-0037 split).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderProfile {
    /// Stable identity (ADR-0037 reference half); also the keychain account
    /// suffix (`key-<id>`).
    pub id: ProfileId,
    /// Renamable display label (ADR-0037 display half). Sans key, sans protocol
    /// semantics -- purely what the UI shows.
    #[serde(default)]
    pub display_name: String,
    /// Wire protocol (ADR-0064); defaults to Anthropic.
    #[serde(default)]
    pub protocol: Protocol,
    /// Anthropic Messages API base URL (ADR-0019: configurable `baseURL`,
    /// default Anthropic direct). A user's own Anthropic-compatible gateway goes
    /// here. `#[serde(default)]` keeps older stored blobs deserializing.
    #[serde(default = "default_provider_base_url")]
    pub base_url: String,
    /// Model id to request (ADR-0007: default Sonnet-class, pinned).
    #[serde(default = "default_provider_model")]
    pub model: String,
}

impl ProviderProfile {
    /// The built-in default anthropic profile (ADR-0064 skeleton): the
    /// honest-degrade target and the single profile this slice ships.
    pub fn default_anthropic() -> Self {
        Self {
            id: ProfileId(DEFAULT_PROFILE_ID.to_string()),
            display_name: DEFAULT_PROFILE_DISPLAY_NAME.to_string(),
            protocol: Protocol::Anthropic,
            base_url: DEFAULT_PROVIDER_BASE_URL.to_string(),
            model: DEFAULT_PROVIDER_MODEL.to_string(),
        }
    }
}

/// Serde default for a profile's [`ProviderProfile::base_url`] (used at
/// deserialize time for older blobs and by [`ProviderProfile::default_anthropic`]).
fn default_provider_base_url() -> String {
    DEFAULT_PROVIDER_BASE_URL.to_string()
}

/// Serde default for a profile's [`ProviderProfile::model`].
fn default_provider_model() -> String {
    DEFAULT_PROVIDER_MODEL.to_string()
}

/// Non-secret multi-profile provider config (ADR-0064): a list of named access
/// profiles plus the id of the active one. Never carries the API key
/// (ADR-0029/0038 -- the key lives only in the OS keychain under `key-<id>`).
/// This is BOTH the app-config storage shape ([`crate::app_config::AppConfig`].provider)
/// AND the `set_provider_config` IPC input -- one shape, no DRY split between a
/// "storage" and a "wire" variant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// The named access profiles (ADR-0064). At least one in any valid config;
    /// [`ProviderConfig::defaults`] seeds the single default anthropic profile.
    #[serde(default)]
    pub profiles: Vec<ProviderProfile>,
    /// The id of the active profile (ADR-0064: global single active). Its
    /// protocol + endpoint + model drive the live provider, and its id drives
    /// the keychain account the key is read from.
    #[serde(default)]
    pub active_profile: ProfileId,
}

impl ProviderConfig {
    /// The built-in defaults (ADR-0064): one anthropic profile, active.
    pub fn defaults() -> Self {
        let profile = ProviderProfile::default_anthropic();
        Self {
            active_profile: profile.id.clone(),
            profiles: vec![profile],
        }
    }

    /// The active profile, or `None` when no profile matches `active_profile`
    /// (a malformed config that [`crate::app_config::AppConfig::normalize`]
    /// repairs). Live readers fall back to the canonical defaults when this
    /// returns `None` so a hand-edited gap never hands the provider an empty
    /// endpoint.
    pub fn active(&self) -> Option<&ProviderProfile> {
        self.profiles.iter().find(|p| p.id == self.active_profile)
    }

    /// Mutable access to the active profile, or `None` when no profile matches
    /// `active_profile`. [`crate::app_config::AppConfig::normalize`] establishes
    /// the invariant (non-empty + active points at a real profile) before
    /// callers that `expect` a profile run.
    pub fn active_mut(&mut self) -> Option<&mut ProviderProfile> {
        self.profiles
            .iter_mut()
            .find(|p| p.id == self.active_profile)
    }

    /// The active profile's base URL, or the canonical default when no profile
    /// matches `active_profile` (a malformed config normalize repairs). Shared
    /// by the live provider read path and the IPC view so a dangling active
    /// always yields the same endpoint the provider itself uses, never "".
    pub fn effective_base_url(&self) -> &str {
        self.active()
            .map(|p| p.base_url.as_str())
            .unwrap_or(DEFAULT_PROVIDER_BASE_URL)
    }

    /// The active profile's model, or the canonical default (see
    /// [`Self::effective_base_url`]).
    pub fn effective_model(&self) -> &str {
        self.active()
            .map(|p| p.model.as_str())
            .unwrap_or(DEFAULT_PROVIDER_MODEL)
    }

    /// The active profile's wire protocol, or [`Protocol::Anthropic`] when no
    /// profile matches `active_profile` (a malformed config normalize repairs).
    /// Drives the live provider's per-turn adapter routing (issue #152,
    /// ADR-0064): `LiveProvider` reads this each turn so a protocol switch on
    /// the active profile lands the next turn on the new adapter, no caching.
    pub fn effective_protocol(&self) -> Protocol {
        match self.active() {
            Some(profile) => profile.protocol,
            None => {
                // A malformed config whose active_profile points nowhere: log
                // the silent fallback so the misconfiguration is observable.
                // normalize repairs it on the next store; a hand-edit gap
                // otherwise lands the turn on the Anthropic default with no
                // trace, and a wrong-protocol turn is hard to diagnose from
                // the bare NotWired/Unavailable it produces downstream.
                log::warn!(
                    "active_profile does not match any profile; falling back to \
                     Anthropic protocol for this turn"
                );
                Protocol::Anthropic
            }
        }
    }

    /// The IPC-shaped view of the active profile's endpoint + key status
    /// (ADR-0029: only a boolean + read-fault detail cross, never the key).
    /// Issue #275: the keychain read outcome rides in as a `Result` so a read
    /// fault surfaces on `keychain_fault` (with `has_key` a placeholder false)
    /// instead of being honest-degraded behind a bare `false`. One shape for
    /// both `get_provider_config` and `set_provider_config` so the
    /// active-missing fallback policy is single-sourced, not duplicated per
    /// call site.
    pub fn view(&self, key_read: Result<bool, String>) -> ProviderConfigView {
        let (has_key, keychain_fault) = match key_read {
            Ok(has_key) => (has_key, None),
            Err(detail) => (false, Some(detail)),
        };
        ProviderConfigView {
            base_url: self.effective_base_url().to_string(),
            model: self.effective_model().to_string(),
            has_key,
            keychain_fault,
        }
    }
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self::defaults()
    }
}

/// The get_provider_config view (ADR-0029): the effective base URL + model the
/// provider uses, plus the active profile's key status -- `has_key` (a boolean,
/// never the key itself) and a keychain read-fault detail. The frontend's header
/// key indicator learns whether to prompt for a key without ever receiving it,
/// and distinguishes a read fault from a legitimate no-key state (issue #275).
/// One shape for both `get_provider_config` and `set_provider_config` so the
/// active-missing fallback policy is single-sourced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConfigView {
    pub base_url: String,
    pub model: String,
    /// Whether an API key is stored in the OS keychain. A boolean only (ADR-0029
    /// invariant 3: the key never crosses to the frontend). When
    /// [`Self::keychain_fault`] is `Some`, the read failed and this is a
    /// placeholder `false` (the status is unknown, not empty).
    pub has_key: bool,
    /// A keychain READ failure detail (issue #275): `None` when the read
    /// succeeded (has_key authoritative); `Some(detail)` when the OS keychain
    /// read failed (locked / service down / permission revoked / corrupt entry).
    /// Technical English only (ADR-0029 -- never the key). See
    /// [`ProfileKeyStatus::keychain_fault`].
    pub keychain_fault: Option<String>,
}

/// Per-profile key-status overlay (issue #153, ADR-0064/0029). The Profiles
/// management UI lists every profile with whether its keychain slot
/// (`key-<profile_id>`) holds a key -- a boolean only, never the key itself
/// (ADR-0029 invariant 3). The profile RECORDS come from app-config (the single
/// source of truth for the list); this view only carries the key status the
/// app-config deliberately does not store. `list_provider_profiles` returns one
/// entry per profile currently in app-config.
///
/// Issue #275 adds `keychain_fault`: a non-echoing read-failure detail distinct
/// from "no key stored". When the OS keychain read itself fails (locked /
/// service down / permission revoked / corrupt entry), `has_key` is `false`
/// (a placeholder -- the read could not confirm either way) and `keychain_fault`
/// carries the technical English detail for the frontend's details fold, so the
/// status surface renders "keychain unavailable" instead of misreading as "no
/// key configured" (the pre-#275 bool honest-degrade hid the fault). Mirrors
/// [`ProfileTestOutcome::KeychainUnavailable`] (issue #243); ADR-0029
/// invariant 3 holds (never the key itself).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileKeyStatus {
    /// The stable profile id (also the keychain account suffix `key-<id>`).
    pub profile_id: String,
    /// Whether a key is stored for this profile. A boolean only (ADR-0029).
    /// When [`Self::keychain_fault`] is `Some`, the read failed and this is a
    /// placeholder `false` (the status is unknown, not empty).
    pub has_key: bool,
    /// A keychain READ failure detail (issue #275): `None` when the read
    /// succeeded (has_key is authoritative); `Some(detail)` when the OS
    /// keychain read failed. Technical English (no key leaked, ADR-0029) for
    /// the frontend's details fold, matching
    /// [`StoreCommandError::KeychainFailure`](crate::commands::StoreCommandError).
    pub keychain_fault: Option<String>,
}

/// One connection-preflight outcome (ADR-0070). Returned by the `test_profile`
/// IPC when the user clicks "Test connection" in the Profiles edit form, after
/// the Rust core reads the profile's stored key from the OS keychain and probes
/// the endpoint. Six states along the ADR-0044 axis:
///
/// - [`ProfileTestOutcome::Ok`]: the probe succeeded; `models` carries the
///   model ids listed by `GET /models` (fed to the model dropdown). Empty when
///   the endpoint answered a minimal turn (ping fallback) but does not implement
///   `/models` -- the dropdown then falls back to a hand-typed input.
/// - [`ProfileTestOutcome::KeyRejected`]: no key is stored for the profile, or
///   the endpoint rejected it (HTTP 401/403). Permanent for the profile -- the
///   user must configure a valid key (ADR-0044 NotWired).
/// - [`ProfileTestOutcome::KeychainUnavailable`]: the OS keychain read itself
///   failed (locked, service down, permission revoked, corrupt entry) -- the
///   probe never ran (issue #243). The trust root is unavailable (ADR-0029),
///   distinct from KeyRejected: the fix is repairing the OS keychain, not the
///   key.
/// - [`ProfileTestOutcome::EndpointUnreachable`]: a transport failure (DNS /
///   TCP / TLS / timeout) -- the endpoint could not be reached at all.
/// - [`ProfileTestOutcome::InvalidEndpoint`]: the endpoint URL is permanently
///   invalid (issue #279) -- a non-http/https scheme (`file:`, `data:`, or
///   scheme-less) rejected at the boundary before any probe fires. Distinct
///   from `EndpointUnreachable` (a transport fault on a VALID url): this is a
///   configuration error, not a network failure, so the fix is correcting the
///   protocol, not debugging DNS/TLS.
/// - [`ProfileTestOutcome::Incompatible`]: the endpoint responded (HTTP non-auth
///   status, or a 200 body that is not a model list) AND a minimal turn ping
///   also failed for a non-key, non-transport reason -- the endpoint is alive
///   but does not serve a usable chat/messages contract.
///
/// Adjacently-tagged (`#[serde(tag = "kind", content = "data")]`) like the other
/// IPC enums; the `detail` on `Incompatible` / `KeychainUnavailable` is a
/// technical English string for the frontend's details fold -- intentionally
/// NOT localized (it stays out of the ADR-0052 translation catalog; the
/// user-facing label is the locale id). Mirrored by `src/types/provider.ts` --
/// the wire shape is pinned by `tests/ipc_contract.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ProfileTestOutcome {
    /// The probe succeeded. `models` feeds the model dropdown (ADR-0070); empty
    /// when only the ping fallback succeeded (the endpoint runs turns but does
    /// not implement `/models`).
    Ok { models: Vec<String> },
    /// No key stored, or the endpoint rejected it (HTTP 401/403).
    KeyRejected,
    /// The OS keychain read failed (locked, service down, permission revoked,
    /// corrupt entry) -- the probe never ran (issue #243). Distinct from
    /// `KeyRejected`: the trust root itself is unavailable (ADR-0029), so the
    /// fix is repairing the OS keychain, not the key. `detail` is a technical
    /// English string for the details fold, mirroring `Incompatible`.
    KeychainUnavailable { detail: String },
    /// Transport failure (DNS / TCP / TLS / timeout) -- endpoint unreachable.
    EndpointUnreachable,
    /// The endpoint URL is permanently invalid (issue #279): a non-http/https
    /// scheme (`file:`, `data:`, or scheme-less) rejected at the boundary before
    /// any probe fires. Distinct from `EndpointUnreachable` (a transport fault
    /// on a VALID url) -- this is a configuration error, not a network failure,
    /// so the fix is correcting the protocol, not debugging DNS/TLS. `detail`
    /// is the technical English reason from the shared `validate_http_base_url`
    /// gate (e.g. "invalid base_url: scheme `file` is not http/https") -- the
    /// SAME string the turn adapters ride on [`TurnFailure::InvalidConfig`], so
    /// one root cause yields one diagnosis whether it surfaces at preflight or
    /// at turn time. Surfaced for the details fold, like `Incompatible`.
    InvalidEndpoint { detail: String },
    /// The endpoint responded but is not compatible (non-auth HTTP error whose
    /// body or a failed ping shows it cannot serve the chat/messages contract).
    /// `detail` is a technical English string for the details fold.
    Incompatible { detail: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_protocol_returns_active_protocol() {
        // ADR-0064 (issue #152): effective_protocol follows the active_profile
        // POINTER, not a fixed field -- switching active to a different profile
        // lands that profile's protocol on the next read. Seed a second profile
        // with the Openai protocol and flip active_profile between the two; the
        // read tracks each flip, never a cached value. The live source
        // (LiveProviderConfig::protocol) delegates here, so this is the
        // load-bearing leaf of the per-turn read path.
        let mut cfg = ProviderConfig::defaults();
        let anthropic_id = cfg.active_profile.clone();
        let openai_id = ProfileId("__test_openai_profile".into());
        cfg.profiles.push(ProviderProfile {
            id: openai_id.clone(),
            display_name: "OpenAI".into(),
            protocol: Protocol::Openai,
            base_url: "https://api.openai.example.test".into(),
            model: "gpt-4o".into(),
        });
        // Default active profile is the Anthropic one.
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);

        // Flip active_profile to the Openai profile -- effective_protocol follows.
        cfg.active_profile = openai_id;
        assert_eq!(cfg.effective_protocol(), Protocol::Openai);

        // Flip back -- the read tracks each pointer switch, never a cached value.
        cfg.active_profile = anthropic_id;
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);
    }

    #[test]
    fn effective_protocol_falls_back_to_anthropic_when_active_missing() {
        // A malformed config whose active_profile points nowhere falls back to
        // the Anthropic protocol default, never panics -- mirrors
        // effective_base_url / effective_model. normalize repairs it on the
        // next store; this pins the pre-normalize live-read behavior so a
        // hand-edited gap never dispatches a turn on a wrong/no protocol.
        let mut cfg = ProviderConfig::defaults();
        cfg.active_profile = ProfileId("no-such-profile".into());
        assert_eq!(cfg.effective_protocol(), Protocol::Anthropic);
    }
}
