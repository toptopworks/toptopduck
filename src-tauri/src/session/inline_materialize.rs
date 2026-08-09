//! Inline MCP tool output materialization (ADR-0087 Decision 3, issue #442).
//!
//! External MCP tools that return structured inline text (CSV/TSV/JSON) have
//! their output written to the session's `tool_output/` directory so the agent
//! can reference it via `read_csv_auto`/`read_json` in a subsequent
//! `materialize` call, flowing through the standard derived-source pipeline
//! (ADR-0087 Decision 4, issue #433). Non-structured inline text (natural
//! language, error messages) is left untouched -- the agent consumes it inline
//! as before.

use std::path::{Path, PathBuf};

/// The structured format detected in inline text. Determines the file
/// extension and thus the DuckDB reader function that will consume the file.
#[derive(Debug, PartialEq, Eq)]
enum InlineFormat {
    Json,
    Csv,
    Tsv,
}

impl InlineFormat {
    fn extension(&self) -> &'static str {
        match self {
            InlineFormat::Json => "json",
            InlineFormat::Csv => "csv",
            InlineFormat::Tsv => "tsv",
        }
    }
}

/// Sniff inline text for a structured format (issue #442 locked design
/// decisions).
///
/// Detection order (JSON before CSV/TSV — pretty-printed JSON contains commas
/// and newlines):
/// - **JSON**: `serde_json::from_str` yields an array or object. Scalars
///   (`"text"`, `42`, `true`, `null`) are valid JSON but not tabular — not
///   detected.
/// - **CSV**: first line has ≥1 comma and there are ≥2 lines.
/// - **TSV**: first line has ≥1 tab and there are ≥2 lines.
/// - **None**: anything else (natural language, error messages, single-line
///   values).
///
/// No length threshold and no column-count consistency check — ragged CSV is
/// left to DuckDB's `read_csv_auto` tolerance.
fn detect_format(text: &str) -> Option<InlineFormat> {
    // JSON first: a valid array/object is unambiguously structured, and
    // pretty-printed JSON would false-positive the CSV check below.
    if let Ok(serde_json::Value::Array(_) | serde_json::Value::Object(_)) =
        serde_json::from_str::<serde_json::Value>(text)
    {
        return Some(InlineFormat::Json);
    }
    // CSV/TSV: the first line carries a delimiter (≥1 occurrence — two
    // columns) and at least one data line follows. A single line is not
    // tabular. A one-column file has no delimiter and is not CSV.
    let mut lines = text.lines();
    let first = lines.next()?;
    lines.next()?;
    // Tabs checked before commas: a tab-separated line is a stronger tabular
    // signal than commas (CSV values may contain commas inside quotes; tabs in
    // prose are rare).
    let tabs = first.matches('\t').count();
    let commas = first.matches(',').count();
    if tabs >= 1 {
        Some(InlineFormat::Tsv)
    } else if commas >= 1 {
        Some(InlineFormat::Csv)
    } else {
        None
    }
}

/// Try to materialize inline text to a file under `tool_output/`.
///
/// Returns the written file path when the text is structured (CSV/TSV/JSON),
/// or `None` when it is non-structured (no file written). The file is named
/// `{tool_call_id}.{ext}` to avoid collisions between concurrent tool calls.
///
/// Write failures are best-effort: the caller falls back to the inline text
/// (no materialization, the pre-#442 behavior).
pub(crate) fn try_materialize(
    text: &str,
    tool_call_id: &str,
    tool_output_dir: &Path,
) -> Option<PathBuf> {
    let format = detect_format(text)?;
    // Defensive: the tool_call_id comes from the provider's tool_use ID and is
    // expected to be alphanumeric (e.g. "toolu_xxx", "tu_1"). Reject anything
    // with path separators or traversal characters so the join cannot escape
    // tool_output_dir (ADR-0080 threat model).
    if !tool_call_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        log::warn!(
            target: "toptopduck::inline_materialize",
            "skipping inline materialization for `{tool_call_id}`: unsafe characters in id"
        );
        return None;
    }
    let dest = tool_output_dir.join(format!("{tool_call_id}.{}", format.extension()));
    match std::fs::write(&dest, text) {
        Ok(()) => {
            log::info!(
                target: "toptopduck::inline_materialize",
                "materialized inline tool output `{tool_call_id}` to {}",
                dest.display()
            );
            Some(dest)
        }
        Err(e) => {
            log::warn!(
                target: "toptopduck::inline_materialize",
                "failed to write inline tool output `{tool_call_id}` to {}: {e}",
                dest.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // --- detect_format ---

    #[test]
    fn detects_json_array() {
        assert!(matches!(
            detect_format(r#"[{"id":1,"name":"alice"},{"id":2,"name":"bob"}]"#),
            Some(InlineFormat::Json)
        ));
    }

    #[test]
    fn detects_json_object() {
        assert!(matches!(
            detect_format(r#"{"count":3,"items":["a","b","c"]}"#),
            Some(InlineFormat::Json)
        ));
    }

    #[test]
    fn detects_pretty_printed_json() {
        // Pretty-printed JSON has commas + newlines — must be detected as
        // JSON, not CSV.
        assert!(matches!(
            detect_format("[\n  1,\n  2,\n  3\n]"),
            Some(InlineFormat::Json)
        ));
    }

    #[test]
    fn rejects_json_scalar() {
        // A bare JSON string/number/bool/null is valid JSON but not tabular.
        assert_eq!(detect_format(r#""hello""#), None);
        assert_eq!(detect_format("42"), None);
        assert_eq!(detect_format("true"), None);
        assert_eq!(detect_format("null"), None);
    }

    #[test]
    fn detects_csv() {
        let csv = "id,name,score\n1,alice,95\n2,bob,87\n";
        assert!(matches!(detect_format(csv), Some(InlineFormat::Csv)));
    }

    #[test]
    fn detects_tsv() {
        let tsv = "id\tname\tscore\n1\talice\t95\n2\tbob\t87\n";
        assert!(matches!(detect_format(tsv), Some(InlineFormat::Tsv)));
    }

    #[test]
    fn rejects_single_line_csv() {
        // A single line with commas but no data row is not tabular.
        assert_eq!(detect_format("id,name,score"), None);
    }

    #[test]
    fn rejects_natural_language() {
        assert_eq!(
            detect_format("The query returned 3 rows.\nAll look good."),
            None
        );
        assert_eq!(
            detect_format("Error: connection refused.\nPlease check the server."),
            None
        );
    }

    #[test]
    fn rejects_empty_string() {
        assert_eq!(detect_format(""), None);
    }

    #[test]
    fn detects_two_column_csv() {
        // A two-column CSV (single comma per line) is valid tabular data.
        assert!(matches!(
            detect_format("a,b\nc,d\n"),
            Some(InlineFormat::Csv)
        ));
    }

    // --- try_materialize ---

    #[test]
    fn materializes_csv_to_file() {
        let dir = TempDir::new().unwrap();
        let csv = "id,name\n1,alice\n2,bob\n";
        let path = try_materialize(csv, "tu_1", dir.path()).expect("CSV materialized");
        assert_eq!(path.extension().unwrap(), "csv");
        assert_eq!(path.file_name().unwrap(), "tu_1.csv");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), csv);
    }

    #[test]
    fn materializes_tsv_to_file() {
        let dir = TempDir::new().unwrap();
        let tsv = "id\tname\n1\talice\n2\tbob\n";
        let path = try_materialize(tsv, "tu_9", dir.path()).expect("TSV materialized");
        assert_eq!(path.extension().unwrap(), "tsv");
        assert_eq!(path.file_name().unwrap(), "tu_9.tsv");
    }

    #[test]
    fn materializes_json_to_file() {
        let dir = TempDir::new().unwrap();
        let json = r#"[{"x":1},{"x":2}]"#;
        let path = try_materialize(json, "tu_2", dir.path()).expect("JSON materialized");
        assert_eq!(path.extension().unwrap(), "json");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), json);
    }

    #[test]
    fn returns_none_for_unstructured() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            try_materialize("just some text\nno structure here", "tu_3", dir.path()),
            None
        );
        // No file was written.
        assert!(dir.path().read_dir().unwrap().next().is_none());
    }

    #[test]
    fn file_name_uses_tool_call_id() {
        let dir = TempDir::new().unwrap();
        let path = try_materialize("a,b,c\n1,2,3\n", "call_abc", dir.path()).unwrap();
        assert!(path.to_string_lossy().contains("call_abc.csv"));
    }

    #[test]
    fn rejects_unsafe_tool_call_id() {
        // A tool_call_id with path separators must not be written — prevents
        // path traversal (ADR-0080 threat model).
        let dir = TempDir::new().unwrap();
        assert_eq!(
            try_materialize("a,b,c\n1,2,3\n", "../evil", dir.path()),
            None
        );
        assert_eq!(try_materialize("a,b,c\n1,2,3\n", "tu/1", dir.path()), None);
        // No file was written.
        assert!(dir.path().read_dir().unwrap().next().is_none());
    }
}
