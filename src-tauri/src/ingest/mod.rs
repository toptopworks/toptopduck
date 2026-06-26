//! Ingest dispatcher (PRD #2 module boundary): routes a file by format to a
//! format-specific loader. Slice 1 supports CSV only; other formats are rejected
//! with a clear error (Parquet/JSON/Excel arrive in slices 2-3).

pub mod csv;
pub mod schema;

use std::path::Path;

pub enum Dispatched {
    Csv,
    Unsupported(String),
}

/// Route a file by extension. `.csv` only in slice 1.
pub fn dispatch(path: &Path) -> Dispatched {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .as_deref()
    {
        Some("csv") => Dispatched::Csv,
        Some(ext) => Dispatched::Unsupported(format!(".{ext}")),
        None => Dispatched::Unsupported(String::new()),
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
    fn dispatches_csv_case_insensitively() {
        assert!(matches!(dispatch(Path::new("a.csv")), Dispatched::Csv));
        assert!(matches!(dispatch(Path::new("A.CSV")), Dispatched::Csv));
    }

    #[test]
    fn rejects_other_formats() {
        assert!(matches!(dispatch(Path::new("a.xlsx")), Dispatched::Unsupported(_)));
        assert!(matches!(dispatch(Path::new("a.parquet")), Dispatched::Unsupported(_)));
        assert!(matches!(dispatch(Path::new("noext")), Dispatched::Unsupported(_)));
    }

    #[test]
    fn sanitizes_reference_name() {
        assert_eq!(derive_reference_name(Path::new("people.csv")).as_deref(), Some("people"));
        assert_eq!(derive_reference_name(Path::new("my file (1).csv")).as_deref(), Some("my_file_1"));
        assert_eq!(derive_reference_name(Path::new("2024_sales.csv")).as_deref(), Some("t2024_sales"));
        assert_eq!(derive_reference_name(Path::new("__.csv")).as_deref(), Some("dataset"));
    }
}
