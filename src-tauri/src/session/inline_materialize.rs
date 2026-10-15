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

/// Sniff inline text for a structured format (ADR-0087 Decision 3).
///
/// Detection order (JSON before TSV/CSV — pretty-printed JSON contains commas
/// and newlines):
/// - **JSON**: `serde_json::from_str` yields an array or object. Scalars
///   (`"text"`, `42`, `true`, `null`) are valid JSON but not tabular — not
///   detected.
/// - **TSV**: first two lines each have ≥1 tab.
/// - **CSV**: first two lines each have ≥1 comma.
/// - **None**: anything else (natural language, error messages, single-line
///   values, prose whose second line lacks the delimiter).
///
/// No length threshold and no column-count consistency check — ragged CSV is
/// left to DuckDB's `read_csv_auto` tolerance. Requiring the delimiter on
/// both the header and the first data line rejects multi-line prose whose
/// header happens to contain a comma (e.g. `"3 rows, including alice.\nSee
/// attached."`).
fn detect_format(text: &str) -> Option<InlineFormat> {
    // JSON first: a valid array/object is unambiguously structured, and
    // pretty-printed JSON would false-positive the CSV check below.
    if let Ok(serde_json::Value::Array(_) | serde_json::Value::Object(_)) =
        serde_json::from_str::<serde_json::Value>(text)
    {
        return Some(InlineFormat::Json);
    }
    // CSV/TSV: both the header and the first data line carry the delimiter.
    // Requiring it on both lines rejects multi-line prose whose header
    // happens to contain a comma but whose body does not. A single line is
    // not tabular. A one-column file has no delimiter and is not CSV/TSV.
    let mut lines = text.lines();
    let first = lines.next()?;
    let second = lines.next()?;
    // Tabs checked before commas: a tab-separated line is a stronger tabular
    // signal (tabs in prose are rare; quoted CSV values may contain commas).
    if first.contains('\t') && second.contains('\t') {
        Some(InlineFormat::Tsv)
    } else if first.contains(',') && second.contains(',') {
        Some(InlineFormat::Csv)
    } else {
        None
    }
}

/// Try to materialize inline text to a file under `tool_output/`.
///
/// Returns the written file path when the text is structured (CSV/TSV/JSON),
/// or `None` when: (a) the text is non-structured (no file written), (b) the
/// `tool_call_id` contains unsafe characters — anything outside
/// `[A-Za-z0-9_-]` — rejected as a path-traversal defense (ADR-0080), or
/// (c) the write fails (best-effort: the caller falls back to the inline
/// text, the pre-#442 behavior). The file is named `{tool_call_id}.{ext}` —
/// the per-call unique ID ensures deterministic filenames matching the
/// provider's tool-use ID.
pub(crate) fn try_materialize(
    text: &str,
    tool_call_id: &str,
    tool_output_dir: &Path,
) -> Option<PathBuf> {
    let format = detect_format(text)?;
    // Defensive: the tool_call_id comes from the provider's tool_use ID and is
    // expected to contain only alphanumeric characters, underscores, and
    // hyphens (e.g. "toolu_xxx", "tu_1"). The allowlist rejects everything
    // else — path separators, dots, spaces, and all non-ASCII characters — so
    // the join cannot escape tool_output_dir (ADR-0080 threat model).
    if tool_call_id.is_empty()
        || !tool_call_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        log::warn!(
            target: "toptopduck::inline_materialize",
            "skipping inline materialization for `{tool_call_id}`: empty or unsafe characters in id"
        );
        return None;
    }
    let dest = tool_output_dir.join(format!("{}.{}", tool_call_id, format.extension()));
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

/// Return the inline text, augmented with a file-path hint when it was
/// successfully materialized. Non-structured, unsafe-id, or write-failed
/// text is returned unchanged (pre-#442 behavior). Call this only on a
/// success envelope (`!is_error`) — an error's text is a message, not data.
pub(crate) fn augment_with_hint(
    text: String,
    tool_call_id: &str,
    tool_output_dir: &Path,
) -> String {
    match try_materialize(&text, tool_call_id, tool_output_dir) {
        Some(path) => format!(
            concat!(
                "{text}\n\n[Structured output saved to '{path}'. ",
                "Use read_csv_auto or read_json to load it ",
                "into DuckDB for analysis.]"
            ),
            text = text,
            path = path.display()
        ),
        None => text,
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
    fn rejects_prose_with_commas_on_first_line_only() {
        // Multi-line prose whose first line happens to contain a comma but
        // whose second line does not — must not be detected as CSV.
        assert_eq!(
            detect_format("The query returned 3 rows, including alice.\nSee attached for details."),
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

    #[test]
    fn rejects_empty_tool_call_id() {
        // An empty tool_call_id passes chars().all() vacuously but would
        // produce a dotfile — reject explicitly.
        let dir = TempDir::new().unwrap();
        assert_eq!(try_materialize("a,b\nc,d\n", "", dir.path()), None);
        assert!(dir.path().read_dir().unwrap().next().is_none());
    }

    #[test]
    fn returns_none_on_write_failure() {
        // Pointing at a non-existent directory forces an IO error — the
        // best-effort contract returns None (caller falls back to inline).
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("nonexistent_subdir");
        assert_eq!(try_materialize("a,b\nc,d\n", "tu_1", &missing), None);
    }
}
