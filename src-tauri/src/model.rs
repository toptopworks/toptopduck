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

/// The descriptor of a loaded source Dataset: the artifact registered in the
/// working set and surfaced to the UI (and, later, the LLM payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatasetDescriptor {
    /// Reference name (ADR-0037): machine name, fixed at creation. Used by SQL,
    /// the recipe chain, and the active-dataset pointer.
    pub reference_name: String,
    /// Display label (ADR-0037): user-renamable; defaults to the reference name.
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
    /// User's explicit rectify choices (ADR-0042) for an Excel sheet, carried so
    /// a future recipe can persist them. `None` for CSV/Parquet/JSON and Excel
    /// sheets that auto-tidied without a user override.
    #[serde(default)]
    pub rectify: Option<SheetRectify>,
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
pub enum LoadOutcome {
    Loaded(DatasetDescriptor),
    /// Auto-tidy couldn't confidently rectify an Excel sheet (ADR-0015): the
    /// load is *not* an error -- the UI must gather explicit header/skip choices
    /// (ADR-0042 user decisions) and re-ingest via the guided path. The working
    /// set is unchanged.
    NeedsGuidance(GuidanceRequest),
    Error(LoadError),
}
