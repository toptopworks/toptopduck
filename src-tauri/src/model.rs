//! Domain types crossing the Rust<->frontend IPC boundary and the black-box test
//! seam. Vocabulary follows CONTEXT.md (Dataset / Working Set / Active Dataset)
//! and ADR-0037 (reference name vs display label).

use serde::{Deserialize, Serialize};

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
/// set unchanged (a bad file never pollutes the session -- PRD AC7).
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
    Other {
        detail: String,
    },
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::UnsupportedFormat { requested } => {
                write!(
                    f,
                    "不支持的格式：{requested}（支持 .csv / .parquet / .json / .xlsx）"
                )
            }
            Self::LegacyExcel => {
                write!(
                    f,
                    "不支持 .xls 格式（仅支持 .xlsx），请在 Excel 中另存为 .xlsx 后重试"
                )
            }
            Self::Parse { detail } => write!(f, "无法解析文件：{detail}"),
            Self::Io { detail } => write!(f, "读取文件失败：{detail}"),
            Self::Other { detail } => write!(f, "加载失败：{detail}"),
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
/// pointer) unchanged. Does NOT cross the IPC boundary as a typed value: the
/// rename command surfaces it to the UI as a plain error string, so (unlike
/// [`LoadError`]) it carries no serde wire contract and no `types.ts` mirror.
#[derive(Debug, Clone, PartialEq, Eq)]
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
        match self {
            Self::NotFound(name) => write!(f, "找不到引用名为「{name}」的数据集"),
            Self::DisplayTaken(label) => {
                write!(f, "显示名「{label}」已被其他数据集使用，请换一个")
            }
            Self::InvalidLabel => write!(f, "显示名不能为空或仅含空白"),
        }
    }
}
impl std::error::Error for RenameError {}

// --- Turn / result materialization (issue #22/#23, query loop) --------------
//
// The ask -> outcome loop (PRD #1): a question goes in, the orchestrator runs
// provider-supplied SQL on the session DuckDB, and the rows land as a
// materialized result_N physical table (ADR-0003/0024). Slice #22 shipped the
// narrowest result-only loop; #23 widens it to the full ADR-0028 four-way
// outcome classification (result / textual / failed / cancelled), the always-
// visible thread, and the single retry budget.

/// Which kind of non-SQL textual response the provider returned (ADR-0009
/// textual branch): a disambiguation question (ADR-0018) or an out-of-scope
/// refusal (ADR-0017). The frontend renders the two distinctly so a user can
/// tell "answer me this" from "I won't do that".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextKind {
    /// A disambiguation / clarification question (ADR-0018): the provider could
    /// not confidently infer the intent and asks back rather than guess.
    Clarify,
    /// An out-of-scope refusal (ADR-0017): the request is outside v1's SQL-only
    /// capability boundary; the provider refuses honestly instead of faking.
    Refuse,
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
    /// Outcome A -- a result turn: produced one SQL, executed it, and
    /// materialized result_N. Carries the result descriptor (a Dataset like any
    /// source, ADR-0003) plus the provider's optional assumption note
    /// (ADR-0009), surfaced as a correctable side note. This is the only
    /// outcome that advances result_N numbering.
    Materialized {
        dataset: Box<DatasetDescriptor>,
        /// The verbatim SQL the provider returned this turn (ADR-0009/0023):
        /// the recent-turn window ships it so the provider sees its own prior
        /// SQL (ADR-0023 point 1: "LLM 响应（SQL + assumption 文本）"). `None`
        /// only on legacy data that predates the field -- a fresh result turn
        /// always produced a SQL, so the live path sets `Some`. The serde
        /// default lets older recipes / IPC peers deserialize without it.
        #[serde(default)]
        sql: Option<String>,
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
    /// Outcome C -- a failed turn: the single retry budget (malformed contract
    /// violation + schema/runtime error, ADR-0028) is exhausted. Carries an
    /// honest, user-facing reason. Occupies a thread slot but does NOT advance
    /// result_N.
    Failed { reason: String },
    /// Outcome D -- a cancelled turn (placeholder): abort via user cancel /
    /// resource cap / statement timeout (ADR-0021). The cancel mechanism lands
    /// in #28; this variant exists now so the four-way classification is
    /// complete and the frontend can render it, but no code path produces it
    /// yet.
    Cancelled,
}

/// One entry in the conversation thread (ADR-0028/0039): the verbatim user
/// question paired with its outcome. Every turn appends exactly one -- always
/// visible, occupying a timeline slot -- regardless of whether the outcome
/// produced a result_N. Only [`TurnOutcome::Materialized`] advances result_N
/// numbering; the others occupy a slot but consume no number. The question is
/// the entry's label in the user's own words (ADR-0039: the step label is the
/// verbatim question, never an LLM-generated title).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnRecord {
    pub question: String,
    pub outcome: TurnOutcome,
}

/// Prefix for every DuckDB execution-failure message that crosses IPC as a
/// Display string -- a turn's materialize failure (`session::ask`) and a row
/// read's [`TurnError::Execute`] surface the same engine error, so the literal
/// lives once here. String-matched by the frontend; pinned by tests/ipc_contract.
pub(crate) const EXECUTE_FAIL_PREFIX: &str = "执行查询失败：";

/// Prefix for a turn aborted by an engine-level resource cap (ADR-0005 L3):
/// memory ceiling, result-row ceiling, or a blocked filesystem function.
/// Distinct from [`EXECUTE_FAIL_PREFIX`] (a retried schema/runtime error that
/// exhausted the budget) so a cap-hit reads clearly as a limit, not a bug, and
/// so the frontend can render it separately. String-matched by the frontend.
pub(crate) const RESOURCE_FAIL_PREFIX: &str = "资源上限：";

/// Why a row read failed. A turn no longer fails across this type -- turn
/// failures are [`TurnOutcome::Failed`] (ADR-0028), so a turn always produces an
/// outcome. This type remains only for [`crate::session::Session::read_rows`]: a
/// row read is not a turn, and its failures cross IPC as the Display strings
/// below.
#[derive(Debug, Clone, PartialEq)]
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
        match self {
            Self::UnknownDataset(name) => write!(f, "找不到引用名为「{name}」的数据集"),
            Self::Execute(detail) => write!(f, "{EXECUTE_FAIL_PREFIX}{detail}"),
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
