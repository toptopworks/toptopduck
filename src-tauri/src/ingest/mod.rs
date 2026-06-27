//! Ingest dispatcher (PRD #2 module boundary): routes a file by format to the
//! matching DuckDB native reader. CSV / Parquet / JSON are all read via copy-in
//! into a frozen read-only snapshot; unsupported formats are rejected with a
//! clear error (Excel arrives in a later slice).

pub mod loader;
pub mod schema;

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Dispatched {
    Csv,
    Parquet,
    Json,
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
        Some(ext) => Dispatched::Unsupported(format!(".{ext}")),
        None => Dispatched::Unsupported(String::new()),
    }
}

/// The DuckDB native reader function for a dispatched format, or `None` if the
/// format is unsupported. The reader is interpolated into the copy-in SQL as a
/// trusted static literal chosen here, never user input (see `loader::copy_in`).
pub fn reader_for(format: &Dispatched) -> Option<&'static str> {
    match format {
        Dispatched::Csv => Some("read_csv_auto"),
        Dispatched::Parquet => Some("read_parquet"),
        Dispatched::Json => Some("read_json_auto"),
        Dispatched::Unsupported(_) => None,
    }
}

/// Derive a SQL-safe reference name (ADR-0022 machine name) from the file stem.
/// Sanitizes to [A-Za-z0-9_], collapses runs, trims edges, prefixes a `t` if it
/// would start with a digit.
pub fn derive_reference_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let mut out = String::with_capacity(stem.len());
    for c in stem.chars() {
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
    Some(name)
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
    }

    #[test]
    fn rejects_other_formats() {
        assert!(matches!(
            dispatch(Path::new("a.xlsx")),
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
