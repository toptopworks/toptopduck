//! Dataset, ingest, and row-read domain types. The descriptor is the central
//! artifact: the source-of-truth shared with the UI and the LLM payload window.

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
