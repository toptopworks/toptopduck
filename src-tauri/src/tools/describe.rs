//! The `describe` tool executor (ADR-0076 built-in tool, issue #292).
//!
//! Describe returns a registered working-set dataset's column schema and row
//! count. The working set already caches this shape (computed at ingest for
//! sources, at materialize for results), so describe runs NO SQL -- it reads
//! the descriptor directly. This makes it the cheapest introspection tool: the
//! agent recalls columns before writing SQL without paying for a query.
//!
//! Only registered working-set members resolve; an unknown name is a tool error
//! the agent can self-correct from (ADR-0077). A stale `result_N` (ADR-0013) is
//! also refused -- a stale result may not anchor a new derivation, so describing
//! one as if it were usable would mislead the agent.

use serde_json::{json, Value};

use crate::session::materializer::TurnDeps;
use crate::tools::definitions;
use crate::tools::ToolPayload;

/// Parse the tool input + return the dataset's cached shape.
///
/// Returns `{ reference_name, columns, row_count }` on success, or a tool-level
/// error string for an unknown or stale reference. No DuckDB query runs.
pub(crate) fn dispatch(input: &Value, deps: &mut TurnDeps) -> Result<ToolPayload, String> {
    let reference_name = definitions::get_str(input, "reference_name")?;
    let descriptor = deps
        .working_set
        .resolve_readable(&reference_name, "referenced")?;
    // describe is a schema read off the working-set cache (no SQL), so it has
    // no side effect to report.
    Ok(ToolPayload {
        content: json!({
            "reference_name": descriptor.reference_name,
            "columns": descriptor.columns.iter().map(definitions::column_json).collect::<Vec<_>>(),
            "row_count": descriptor.row_count,
        }),
        promotion: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        ColumnSchema, DatasetDescriptor, DatasetPrivacy, RectifyProvenance, StaleAnchor,
        StaleReason,
    };
    use crate::tools::test_support::inert_deps;
    use crate::workingset::WorkingSet;
    use duckdb::Connection;
    use std::collections::HashMap;

    fn register_dataset(ws: &mut WorkingSet, name: &str, columns: Vec<ColumnSchema>) {
        ws.register(DatasetDescriptor {
            reference_name: name.into(),
            display_name: name.into(),
            source_path: String::new(),
            columns,
            row_count: 42,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
    }

    /// A registered, active dataset resolves to its cached columns + row count.
    /// No SQL runs -- the descriptor is the source of truth.
    #[test]
    fn returns_cached_columns_and_row_count() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        register_dataset(
            &mut ws,
            "people",
            vec![
                ColumnSchema {
                    name: "id".into(),
                    canonical_type: "INTEGER".into(),
                },
                ColumnSchema {
                    name: "name".into(),
                    canonical_type: "VARCHAR".into(),
                },
            ],
        );
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let payload = dispatch(&json!({"reference_name": "people"}), &mut deps).unwrap();
        // describe is a schema read; no side effect to report.
        assert!(payload.promotion.is_none());
        let v = &payload.content;
        assert_eq!(v["reference_name"], "people");
        assert_eq!(v["row_count"], 42);
        assert_eq!(v["columns"][0]["name"], "id");
        assert_eq!(v["columns"][0]["type"], "INTEGER");
        assert_eq!(v["columns"][1]["name"], "name");
        assert_eq!(v["columns"][1]["type"], "VARCHAR");
    }

    /// An unknown reference name returns a tool error naming the dataset -- the
    /// agent can self-correct (re-call with a registered name, or list the
    /// working set).
    #[test]
    fn unknown_dataset_returns_tool_error() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let err = dispatch(&json!({"reference_name": "ghost"}), &mut deps).unwrap_err();
        assert!(err.contains("unknown dataset"), "{err}");
        assert!(err.contains("ghost"), "{err}");
    }

    /// A stale result_N is refused -- describing one as usable would mislead
    /// the agent into referencing it. The error carries the stale anchor so the
    /// agent can reason about why the dataset is unusable.
    #[test]
    fn stale_dataset_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        ws.register(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 0,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: Some(StaleAnchor {
                reference_name: "people".into(),
                display_name: "people".into(),
                reason: StaleReason::Deleted,
            }),
        });
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let err = dispatch(&json!({"reference_name": "result_1"}), &mut deps).unwrap_err();
        assert!(err.contains("stale"), "{err}");
        assert!(err.contains("result_1"), "{err}");
        assert!(err.contains("people"), "{err}");
    }

    /// Missing `reference_name` parameter surfaces as a field-naming tool error
    /// before any lookup runs.
    #[test]
    fn missing_parameter_errors_with_field_name() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let err = dispatch(&json!({}), &mut deps).unwrap_err();
        assert!(err.contains("`reference_name`"), "{err}");
    }
}
