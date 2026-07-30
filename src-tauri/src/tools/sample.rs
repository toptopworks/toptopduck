//! The `sample` tool executor (ADR-0076 built-in tool, issue #292).
//!
//! Sample returns a bounded page of rows from a registered working-set dataset
//! so the agent can inspect actual values (distinct values, ranges, edge cases
//! the dataset descriptor's frozen 3-row sample does not cover). It is the
//! tool-layer counterpart of the IPC `read_rows` command -- same SELECT-CAST
//! primitive, different consumer (the LLM agent, not the frontend) and so a
//! different payload shape.
//!
//! Reads from the session's authoritative connection. Sources resolve as
//! `"<ref>".data` (ADR-0012) and results as `"<ref>"` (ADR-0024) via
//! [`WorkingSet::sql_from`], so the FROM fragment is correct without the tool
//! knowing storage. Unknown names and stale result_N are refused (ADR-0013
//! invariant 2).

use serde_json::{json, Value};

use crate::ingest::schema::quote_ident;
use crate::model::ColumnSchema;
use crate::session::materializer::TurnDeps;
use crate::tools::definitions::{self, SAMPLE_DEFAULT_LIMIT, SAMPLE_MAX_LIMIT};

/// Parse the tool input + read a bounded page of rows from the dataset.
///
/// Returns `{ reference_name, columns, rows, total, offset, limit }` on
/// success, or a tool-level error string. The `limit` is clamped to the
/// schema-declared cap so a hostile or over-eager caller cannot pull an
/// unbounded payload into the LLM context.
pub(crate) fn dispatch(input: &Value, deps: &mut TurnDeps) -> Result<Value, String> {
    let reference_name = definitions::get_str(input, "reference_name")?;
    let offset = offset_param(input)?;
    let limit = limit_param(input)?;

    // Capture the cached fields the payload echoes before the mutable borrow
    // for read_page: the descriptor borrows deps.working_set immutably, and
    // read_page borrows deps mutably (to reach the connection), so the
    // immutable borrow must end first. The fields are small owned copies
    // (reference name + column clones + the row-count u64).
    let (reference_name, columns, total) = {
        let descriptor = deps.working_set.resolve_readable(&reference_name, "read")?;
        (
            descriptor.reference_name.clone(),
            descriptor.columns.clone(),
            descriptor.row_count,
        )
    };
    let from = deps.working_set.sql_from(&reference_name).ok_or_else(|| {
        // A registered dataset without a sql_from form is a working-set logic
        // bug -- surface it honestly rather than fabricate a FROM fragment.
        format!("dataset `{reference_name}` has no resolvable FROM form")
    })?;
    let rows = read_page(deps, &columns, &from, limit, offset)?;
    Ok(json!({
        "reference_name": reference_name,
        "columns": columns.iter().map(definitions::column_json).collect::<Vec<_>>(),
        "rows": rows,
        "total": total,
        "offset": offset,
        "limit": limit,
    }))
}

/// Parsed `limit`, defaulted and clamped to [`SAMPLE_MAX_LIMIT`]. A non-positive
/// or out-of-range value is clamped rather than rejected so a slightly-over
/// request still returns data; the schema already declares the bounds.
fn limit_param(input: &Value) -> Result<i64, String> {
    Ok(input
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(SAMPLE_DEFAULT_LIMIT)
        .clamp(1, SAMPLE_MAX_LIMIT))
}

/// Parsed `offset`, defaulted to 0 and clamped at 0 (negative offsets make no
/// sense and would produce a malformed LIMIT/OFFSET).
fn offset_param(input: &Value) -> Result<i64, String> {
    Ok(input
        .get("offset")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0))
}

/// Read up to `limit` rows starting at `offset`, every cell CAST to VARCHAR
/// (NULL renders as the empty string, matching `read_rows` display semantics).
/// The identifiers and numeric LIMIT/OFFSET are all tool-generated (sanitized
/// reference name / quoted columns / clamped integers), so the interpolation is
/// safe -- no provider SQL flows through here.
fn read_page(
    deps: &mut TurnDeps,
    columns: &[ColumnSchema],
    from: &str,
    limit: i64,
    offset: i64,
) -> Result<Vec<Vec<String>>, String> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    let selects: Vec<String> = columns
        .iter()
        .map(|c| format!("CAST({} AS VARCHAR)", quote_ident(&c.name)))
        .collect();
    let sql = format!(
        "SELECT {} FROM {} LIMIT {limit} OFFSET {offset}",
        selects.join(", "),
        from,
    );
    let mut stmt = deps
        .conn
        .prepare(&sql)
        .map_err(|e| format!("sample failed: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("sample failed: {e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("sample failed: {e}"))? {
        let mut cells = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            let v: Option<String> = row.get(i).map_err(|e| format!("sample failed: {e}"))?;
            cells.push(v.unwrap_or_default());
        }
        out.push(cells);
    }
    Ok(out)
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

    /// `limit` defaults to 10, clamps to [1, 50]; `offset` defaults to 0 and is
    /// floored at 0. Pinning the clamp keeps the payload bounded without
    /// rejecting slightly-over requests.
    #[test]
    fn limit_and_offset_default_and_clamp() {
        assert_eq!(limit_param(&json!({})).unwrap(), SAMPLE_DEFAULT_LIMIT);
        assert_eq!(limit_param(&json!({"limit": 5})).unwrap(), 5);
        assert_eq!(
            limit_param(&json!({"limit": 9999})).unwrap(),
            SAMPLE_MAX_LIMIT
        );
        assert_eq!(limit_param(&json!({"limit": -3})).unwrap(), 1);

        assert_eq!(offset_param(&json!({})).unwrap(), 0);
        assert_eq!(offset_param(&json!({"offset": 100})).unwrap(), 100);
        assert_eq!(offset_param(&json!({"offset": -1})).unwrap(), 0);
    }

    /// Unknown dataset name returns a tool error naming the dataset. The agent
    /// can self-correct to a registered name.
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

    /// A stale result_N is refused for reads -- the agent would act on stale
    /// rows, so the tool surfaces the staleness rather than returning data.
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
    }

    /// Missing `reference_name` surfaces as a field-naming error before any
    /// lookup or query runs.
    #[test]
    fn missing_parameter_errors_with_field_name() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let err = dispatch(&json!({}), &mut deps).unwrap_err();
        assert!(err.contains("`reference_name`"), "{err}");
    }

    /// A registered result_N with a backing table reads actual rows. The
    /// payload carries the columns, the row values, the total, and the
    /// offset/limit echo.
    #[test]
    fn reads_rows_from_a_backed_result() {
        let conn = Connection::open_in_memory().unwrap();
        // Backing table on the session (admin) connection: result_1 with two
        // rows. The tool resolves FROM "result_1" (a result, not a source) and
        // CASTs each cell to VARCHAR.
        conn.execute_batch("CREATE TABLE result_1 (id INTEGER, label VARCHAR)")
            .unwrap();
        conn.execute_batch("INSERT INTO result_1 VALUES (1, 'a'), (2, 'b')")
            .unwrap();
        let mut ws = WorkingSet::default();
        // register_result (not register) so the working set treats result_1 as
        // a main-DB base table (FROM "result_1") rather than a source (FROM
        // "result_1".data) -- matching the CREATE TABLE that backs it on admin.
        ws.register_result(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![
                ColumnSchema {
                    name: "id".into(),
                    canonical_type: "INTEGER".into(),
                },
                ColumnSchema {
                    name: "label".into(),
                    canonical_type: "VARCHAR".into(),
                },
            ],
            row_count: 2,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let v = dispatch(
            &json!({"reference_name": "result_1", "limit": 10}),
            &mut deps,
        )
        .unwrap();
        assert_eq!(v["reference_name"], "result_1");
        assert_eq!(v["total"], 2);
        assert_eq!(v["offset"], 0);
        assert_eq!(v["limit"], 10);
        assert_eq!(v["rows"][0][0], "1");
        assert_eq!(v["rows"][0][1], "a");
        assert_eq!(v["rows"][1][0], "2");
        assert_eq!(v["rows"][1][1], "b");
        assert_eq!(v["columns"][0]["name"], "id");
        assert_eq!(v["columns"][0]["type"], "INTEGER");
    }
}
