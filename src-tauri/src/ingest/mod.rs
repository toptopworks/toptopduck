//! Ingest dispatcher (PRD #2 module boundary): routes a file by format to its
//! loader. CSV / Parquet / JSON share a single DuckDB-native copy-in path (only
//! the reader function differs); Excel (.xlsx) is handled by [`excel`] (calamine
//! -> per-sheet copy-in). Unsupported formats are rejected with a clear error.

pub mod excel;
pub mod loader;
pub mod schema;
pub mod tidy;

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatched {
    Csv,
    Parquet,
    Json,
    Xlsx,
    /// Legacy .xls (BIFF8) workbook -- rejected distinctly (ADR-0015) so the UI
    /// can show the actionable "另存为 .xlsx" hint; bundling a converter is out
    /// of scope for v1. Routed separately from `Unsupported` rather than
    /// special-cased inside a generic error message.
    Xls,
    Unsupported(String),
}

/// Route a file by extension.
pub fn dispatch(path: &Path) -> Dispatched {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("csv") => Dispatched::Csv,
        Some("parquet") => Dispatched::Parquet,
        Some("json") | Some("jsonl") | Some("ndjson") => Dispatched::Json,
        Some("xlsx") => Dispatched::Xlsx,
        Some("xls") => Dispatched::Xls,
        Some(ext) => Dispatched::Unsupported(format!(".{ext}")),
        None => Dispatched::Unsupported(String::new()),
    }
}

/// The DuckDB native reader function for a dispatched format, or `None` if the
/// format is unsupported or handled outside the shared copy-in path. The reader
/// is interpolated into the copy-in SQL as a trusted static literal chosen here,
/// never user input (see `loader::copy_in`). `Xlsx` returns `None` -- it goes
/// through [`excel`] which materializes each sheet to a temp CSV first. `Xls`
/// returns `None` -- it is rejected upstream and never reaches copy-in.
pub fn reader_for(format: &Dispatched) -> Option<&'static str> {
    match format {
        Dispatched::Csv => Some("read_csv_auto"),
        Dispatched::Parquet => Some("read_parquet"),
        Dispatched::Json => Some("read_json_auto"),
        Dispatched::Xlsx => None,
        Dispatched::Xls => None,
        Dispatched::Unsupported(_) => None,
    }
}

/// Derive a SQL-safe reference name (ADR-0022 machine name) from the file stem.
pub fn derive_reference_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    Some(sanitize_identifier(stem))
}

/// Derive a SQL-safe reference name from an Excel sheet name (ADR-0037: machine
/// name fixed at creation; the original sheet name is kept as the display label).
pub fn sanitize_sheet_name(name: &str) -> String {
    sanitize_identifier(name)
}

/// Sanitize a raw name to a SQL-safe reference name (ADR-0022 machine name):
/// keep [A-Za-z0-9_], collapse runs, trim edges, prefix `t` if it would start
/// with a digit, fall back to `dataset` when empty.
fn sanitize_identifier(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        out.push(if c.is_ascii_alphanumeric() { c } else { '_' });
    }
    while out.contains("__") {
        out = out.replace("__", "_");
    }
    let trimmed = out.trim_matches('_').to_string();
    let mut name = if trimmed.is_empty() {
        "dataset".to_string()
    } else {
        trimmed
    };
    if name.as_bytes()[0].is_ascii_digit() {
        name.insert(0, 't');
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatches_each_supported_format_case_insensitively() {
        assert!(matches!(dispatch(Path::new("a.csv")), Dispatched::Csv));
        assert!(matches!(dispatch(Path::new("A.CSV")), Dispatched::Csv));
        assert!(matches!(
            dispatch(Path::new("a.parquet")),
            Dispatched::Parquet
        ));
        assert!(matches!(
            dispatch(Path::new("a.PARQUET")),
            Dispatched::Parquet
        ));
        assert!(matches!(dispatch(Path::new("a.json")), Dispatched::Json));
        assert!(matches!(dispatch(Path::new("a.jsonl")), Dispatched::Json));
        assert!(matches!(dispatch(Path::new("a.ndjson")), Dispatched::Json));
        assert!(matches!(dispatch(Path::new("A.JSON")), Dispatched::Json));
        assert!(matches!(dispatch(Path::new("a.xlsx")), Dispatched::Xlsx));
        assert!(matches!(dispatch(Path::new("A.XLSX")), Dispatched::Xlsx));
        // .xls routes to its own variant (rejected upstream with a "另存为
        // .xlsx" hint -- ADR-0015), distinct from a generic unsupported format.
        assert!(matches!(dispatch(Path::new("a.xls")), Dispatched::Xls));
        assert!(matches!(dispatch(Path::new("A.XLS")), Dispatched::Xls));
    }

    #[test]
    fn rejects_other_formats() {
        // .xls has its own variant (see dispatches_each_supported...); .txt and
        // other unknown extensions fall through to Unsupported. .xlsx is
        // supported as of issue #7.
        assert!(matches!(
            dispatch(Path::new("a.txt")),
            Dispatched::Unsupported(_)
        ));
        assert!(matches!(
            dispatch(Path::new("noext")),
            Dispatched::Unsupported(_)
        ));
    }

    #[test]
    fn reader_for_maps_each_format_to_a_duckdb_reader() {
        assert_eq!(reader_for(&Dispatched::Csv), Some("read_csv_auto"));
        assert_eq!(reader_for(&Dispatched::Parquet), Some("read_parquet"));
        assert_eq!(reader_for(&Dispatched::Json), Some("read_json_auto"));
        // Xlsx has no single reader -- handled by the excel path (calamine).
        assert_eq!(reader_for(&Dispatched::Xlsx), None);
        // Xls is rejected upstream -- it never reaches copy-in.
        assert_eq!(reader_for(&Dispatched::Xls), None);
        assert_eq!(reader_for(&Dispatched::Unsupported(".x".into())), None);
    }

    #[test]
    fn sanitizes_reference_name() {
        assert_eq!(
            derive_reference_name(Path::new("people.csv")).as_deref(),
            Some("people")
        );
        assert_eq!(
            derive_reference_name(Path::new("my file (1).csv")).as_deref(),
            Some("my_file_1")
        );
        assert_eq!(
            derive_reference_name(Path::new("2024_sales.csv")).as_deref(),
            Some("t2024_sales")
        );
        assert_eq!(
            derive_reference_name(Path::new("__.csv")).as_deref(),
            Some("dataset")
        );
    }
}
