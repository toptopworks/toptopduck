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
    /// SHA256 (hex) of the post-copy-in snapshot (ADR-0042); CSV rectify params
    /// are empty in slice 1, so this is the snapshot content hash.
    pub fingerprint: String,
}

/// Why an ingest failed. Surfaced to the UI; a failed load leaves the working
/// set unchanged (a bad file never pollutes the session -- PRD AC7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoadError {
    UnsupportedFormat { requested: String },
    Parse { detail: String },
    Io { detail: String },
    Other { detail: String },
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::UnsupportedFormat { requested } => {
                write!(
                    f,
                    "不支持的格式：{requested}（支持 .csv / .parquet / .json）"
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
    Error(LoadError),
}
