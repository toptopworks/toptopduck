//! The `explore` tool executor (ADR-0077 scratch semantics, issue #292).
//!
//! Explore runs a read-only SQL query on a fresh scratch sandbox and returns
//! the result's shape (columns + row count + a bounded sample) WITHOUT
//! persisting anything. The scratch table lives on the sandbox connection only
//! and is dropped at end of call -- no `result_N`, no admin write, no
//! working-set mutation. This is the "free exploration" half of ADR-0077: the
//! agent can probe the data without polluting the working set.
//!
//! Namespace isolation (AC #3): because explore runs on a separate sandbox
//! connection that is dropped per call, a scratch object can never leak into
//! the working set. The only path to a working-set object is the `materialize`
//! tool. Stale `result_N` references are refused up front (ADR-0013 invariant
//! 2), matching the legacy materialize path.
//!
//! The sandbox setup mirrors [`crate::session::materializer::RealMaterializer`]
//! (open / attach sources / mirror results / lockdown / interrupt handle) so
//! the SQL resolves identically to the admin instance. The divergence is after
//! the query: explore derives the shape FROM THE SANDBOX and drops it, while
//! materialize installs onto admin + registers + GCs.

use duckdb::Connection;
use serde_json::{json, Value};

use crate::cancel::CancelToken;
use crate::ingest::schema::{canonical_type, quote_ident};
use crate::model::ColumnSchema;
use crate::provenance;
use crate::session::materializer::TurnDeps;
use crate::session::sandbox;
use crate::tools::definitions::{self, EXPLORE_DEFAULT_SAMPLE_ROWS, EXPLORE_MAX_SAMPLE_ROWS};

/// The scratch table name on the explore sandbox. The sandbox is single-use
/// (LocalFileSystem lockdown is irreversible, so the connection is dropped per
/// call), so a fixed name cannot collide across calls.
const SCRATCH_TABLE: &str = "_explore_scratch";

/// Parse the tool input + run the explore query on a scratch sandbox.
///
/// Returns the shape payload (columns + row count + sample) on success, or a
/// tool-level error string on failure. Every error is one the agent can
/// self-correct from (ADR-0077): a bad SQL, a stale reference, a resource cap,
/// a cancel -- each surfaces a descriptive reason, never a silent failure.
pub(crate) fn dispatch(
    input: &Value,
    deps: &mut TurnDeps,
    cancel: &CancelToken,
) -> Result<Value, String> {
    let sql = definitions::get_str(input, "sql")?;
    let sample_rows = sample_rows_param(input)?;
    let shape = run_explore(&sql, sample_rows, deps, cancel)?;
    Ok(json!({
        "columns": shape.columns.iter().map(definitions::column_json).collect::<Vec<_>>(),
        "row_count": shape.row_count,
        "sample": shape.sample,
    }))
}

/// Parsed `sample_rows`, defaulted and clamped to the schema-declared bounds.
/// The model may omit it (use the default), or ask for more up to the cap; an
/// out-of-range value is clamped rather than rejected so a slightly-over request
/// still returns data -- the schema already declares the bounds, so a clamp is
/// a honest nudge, not a silent truncation of the result set.
fn sample_rows_param(input: &Value) -> Result<i64, String> {
    Ok(input
        .get("sample_rows")
        .and_then(Value::as_i64)
        .unwrap_or(EXPLORE_DEFAULT_SAMPLE_ROWS)
        .clamp(0, EXPLORE_MAX_SAMPLE_ROWS))
}

/// The derived shape of an explore result -- the scratch-table view the tool
/// returns to the agent. Intentionally has no fingerprint (explore never
/// persists, so the content hash that source snapshots and materialized
/// results carry would be wasted work here).
struct ExploreShape {
    columns: Vec<ColumnSchema>,
    row_count: u64,
    sample: Vec<Vec<String>>,
}

/// Run the explore query end to end. Holds the same sandbox-lifecycle invariants
/// as the materialize path (stale check, sandbox setup, interrupt, cap+1 LIMIT,
/// cancel checkpoints) so the two SQL-executing tools enforce uniformly.
fn run_explore(
    sql: &str,
    sample_rows: i64,
    deps: &mut TurnDeps,
    cancel: &CancelToken,
) -> Result<ExploreShape, String> {
    // A cancel that arrived before the call aborts immediately -- do not burn
    // sandbox setup on a turn the user already stopped.
    if cancel.is_requested() {
        return Err("explore cancelled".to_string());
    }

    // Stale-reference refusal (ADR-0013 invariant 2): parse the SQL once before
    // touching the sandbox so a stale result_N is rejected without setup cost.
    // Explore never records provenance (no promotion), so only the stale-ref
    // half of the analysis matters here.
    let analyzed = provenance::analyze(sql, deps.working_set);
    if let Some(stale_ref) = analyzed.stale_ref.as_ref() {
        return Err(format!(
            "stale reference: `{stale_ref}` has been invalidated and may not anchor a new query"
        ));
    }

    // Scratch sandbox (same lifecycle as the materialize path): fresh instance,
    // sources re-attached READ_ONLY, prior results mirrored in, then locked
    // down so a read_* table function is refused. The sandbox is dropped at
    // end of scope -- the scratch table dies with it, leaving no trace on admin
    // (AC #1: turn-local, no naming, no working-set entry).
    let sandbox_conn = sandbox::open().map_err(exec_err)?;
    sandbox::attach_sources(&sandbox_conn, deps.working_set, deps.source_files)
        .map_err(exec_err)?;
    sandbox::mirror_results(&sandbox_conn, deps.conn, deps.working_set).map_err(exec_err)?;
    sandbox::lockdown(&sandbox_conn).map_err(exec_err)?;

    // A cancel that arrived during sandbox setup (before the query's interrupt
    // handle is registered below) is reported honestly as a cancel. Without
    // this check the only signal would be a later setup step's generic engine
    // error; the user stopped the turn, so the agent loop (and the user)
    // should see "cancelled", not a failure that never was (ADR-0077 honesty).
    if cancel.is_requested() {
        return Err("explore cancelled".to_string());
    }

    // Register the sandbox interrupt handle so a cancel can abort THIS query at
    // source (ADR-0021 DuckDB interrupt). Scoped to the explore SQL only;
    // cleared right after the CREATE so the post-query shape derivation (fast,
    // on the sandbox) is never disrupted by a cancel.
    cancel.set_interrupt(sandbox_conn.interrupt_handle());

    // Resource cap (ADR-0005 L3, mirroring the materialize path): wrap the query
    // and LIMIT to cap+1 so a runaway cross-join cannot balloon memory. A count
    // of cap+1 after the CREATE means the true result exceeded the cap -> the
    // tool refuses (silent truncation is forbidden, ADR-0030); the agent can
    // re-explore with a tighter query.
    let inner = sql.trim().trim_end_matches(';').trim_end();
    let cap_plus_one = deps.result_row_cap.saturating_add(1);
    let create_sql = format!(
        "CREATE TABLE {} AS SELECT * FROM ({inner}) AS _src LIMIT {cap_plus_one}",
        quote_ident(SCRATCH_TABLE),
    );
    let create_outcome = sandbox_conn.execute_batch(&create_sql);
    cancel.clear_interrupt();

    if let Err(e) = create_outcome {
        // A cancel during the query surfaces as a generic DuckDB failure. If the
        // flag is set, report a cancel rather than the engine's opaque message
        // so the agent loop (and the user) sees an honest "cancelled".
        if cancel.is_requested() {
            return Err("explore cancelled".to_string());
        }
        return Err(format!("SQL failed: {}", e));
    }

    // Row-count governor on the sandbox: count == cap+1 -> the true result
    // exceeded the cap. Refuse with a resource-cap message naming the cap so the
    // agent can add its own LIMIT and re-explore.
    let rows: i64 = sandbox_conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", quote_ident(SCRATCH_TABLE)),
            [],
            |r| r.get(0),
        )
        .map_err(tool_err)?;
    if rows as u64 > deps.result_row_cap {
        return Err(format!(
            "result row count ({rows}) exceeds the cap {}; add a LIMIT or narrow the query",
            deps.result_row_cap
        ));
    }

    // Cancel landed between the query's success and the shape derivation: report
    // it honestly. The scratch table exists on the sandbox only -- dropping the
    // sandbox cleans up, no admin rollback needed.
    if cancel.is_requested() {
        return Err("explore cancelled".to_string());
    }

    // Derive the shape from the sandbox table. No fingerprint (explore never
    // persists), so this is the describe + sample primitives inline rather than
    // snapshot::derive_table (which additionally dumps + hashes the table).
    let columns = describe_scratch(&sandbox_conn)?;
    let sample = read_sample(&sandbox_conn, &columns, sample_rows)?;
    Ok(ExploreShape {
        columns,
        row_count: rows.max(0) as u64,
        sample,
    })
}

/// Read the column schema (name + canonical type) of the scratch table. Mirrors
/// snapshot::describe_table but is kept local because explore derives from a
/// sandbox-local temp table under a tool-generated name (never a source or
/// result the snapshot path handles).
fn describe_scratch(conn: &Connection) -> Result<Vec<ColumnSchema>, String> {
    let mut stmt = conn
        .prepare(&format!("DESCRIBE {}", quote_ident(SCRATCH_TABLE)))
        .map_err(tool_err)?;
    let mut rows = stmt.query([]).map_err(tool_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(tool_err)? {
        let name: String = row.get(0).map_err(tool_err)?;
        let raw_type: String = row.get(1).map_err(tool_err)?;
        out.push(ColumnSchema {
            name,
            canonical_type: canonical_type(&raw_type),
        });
    }
    Ok(out)
}

/// Read up to `limit` leading rows from the scratch table, every cell CAST to
/// VARCHAR (NULL rendered as None so JSON serialization drops it rather than
/// coercing to "0" or ""). Mirrors snapshot::read_table_sample's CAST strategy
/// but is parameterized by the explore caller's `sample_rows`.
fn read_sample(
    conn: &Connection,
    columns: &[ColumnSchema],
    limit: i64,
) -> Result<Vec<Vec<String>>, String> {
    if columns.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let selects: Vec<String> = columns
        .iter()
        .map(|c| format!("CAST({} AS VARCHAR)", quote_ident(&c.name)))
        .collect();
    let sql = format!(
        "SELECT {} FROM {} LIMIT {limit}",
        selects.join(", "),
        quote_ident(SCRATCH_TABLE)
    );
    let mut stmt = conn.prepare(&sql).map_err(tool_err)?;
    let mut rows = stmt.query([]).map_err(tool_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(tool_err)? {
        let mut cells = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            let v: Option<String> = row.get(i).map_err(tool_err)?;
            cells.push(v.unwrap_or_default());
        }
        out.push(cells);
    }
    Ok(out)
}

/// Lift any failure into a tool-error string. Every explore failure routes
/// back to the agent uniformly (ADR-0077) -- the agent self-corrects, never
/// blind-retries -- so only the descriptive detail reaches the ToolResult
/// content. The retry-routing kind the legacy single-SQL path classifies is
/// not relevant here and is dropped.
fn tool_err(detail: impl std::fmt::Display) -> String {
    format!("explore failed: {detail}")
}

/// Lift a sandbox-primitive [`crate::guardrail::ExecError`] into a tool-error
/// string. `ExecError` carries a user-facing `detail` + a retry-routing `kind`
/// and does not implement `Display`; the detail is the honest explanation the
/// agent reads (ADR-0077), the kind is dropped (see [`tool_err`]).
fn exec_err(e: crate::guardrail::ExecError) -> String {
    tool_err(e.detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_support::inert_deps;

    /// `sample_rows` defaults to 10 when omitted, clamps to [0, 50] when
    /// out of range, and passes through in-range values. Pinning the default +
    /// clamp keeps the payload bounded without rejecting slightly-over requests.
    #[test]
    fn sample_rows_defaults_and_clamps() {
        assert_eq!(
            sample_rows_param(&json!({})).unwrap(),
            EXPLORE_DEFAULT_SAMPLE_ROWS
        );
        assert_eq!(sample_rows_param(&json!({"sample_rows": 5})).unwrap(), 5);
        assert_eq!(
            sample_rows_param(&json!({"sample_rows": 9999})).unwrap(),
            EXPLORE_MAX_SAMPLE_ROWS
        );
        assert_eq!(sample_rows_param(&json!({"sample_rows": -3})).unwrap(), 0);
    }

    /// `dispatch` surfaces a missing `sql` parameter as a tool error naming the
    /// field -- the agent gets actionable feedback, not an opaque failure.
    #[test]
    fn dispatch_errors_when_sql_missing() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let cancel = CancelToken::new();
        let err = dispatch(&json!({}), &mut deps, &cancel).unwrap_err();
        assert!(
            err.contains("`sql`"),
            "error names the missing field: {err}"
        );
    }

    /// End-to-end: explore runs a read-only SQL against a working-set result and
    /// returns the shape. result_1 is backed on admin; the sandbox mirrors it in
    /// (sandbox::mirror_results) so the explore SQL resolves. AC #1: explore is
    /// callable; AC #3: the working set is unchanged after the call (no result_N
    /// produced, no admin write).
    #[test]
    fn explore_runs_against_a_mirrored_result_and_leaves_no_trace() {
        use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE result_1 (id INTEGER, label VARCHAR)")
            .unwrap();
        conn.execute_batch("INSERT INTO result_1 VALUES (1, 'a'), (2, 'b'), (3, 'c')")
            .unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
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
            row_count: 3,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
        let sources = std::collections::HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let cancel = CancelToken::new();
        let v = dispatch(
            &json!({"sql": "SELECT * FROM result_1 WHERE id > 1 ORDER BY id"}),
            &mut deps,
            &cancel,
        )
        .unwrap();

        // Shape: two rows (id 2,3), both columns, sample carries both rows.
        assert_eq!(v["row_count"], 2);
        let cols = v["columns"].as_array().unwrap();
        assert_eq!(cols.len(), 2);
        assert_eq!(cols[0]["name"], "id");
        assert_eq!(cols[0]["type"], "INTEGER");
        assert_eq!(cols[1]["name"], "label");
        let sample = v["sample"].as_array().unwrap();
        assert_eq!(sample.len(), 2);
        assert_eq!(sample[0][0], "2");
        assert_eq!(sample[0][1], "b");

        // AC #3 namespace isolation: the working set still holds exactly
        // result_1 (the one we registered) -- explore produced no result_N and
        // wrote nothing to admin. The next promotion number is still 2 (one
        // past result_1), proving explore did not register anything.
        assert_eq!(
            deps.working_set.len(),
            1,
            "explore must not add working-set entries"
        );
        assert_eq!(deps.working_set.next_result_number(), 2);
        // And admin has no _explore_scratch and no new result_N table -- the
        // sandbox was dropped, so a scratch table cannot survive.
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_name = '_explore_scratch'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "no scratch table leaked onto admin");
    }

    /// A SQL error (bad column) reaches the agent as a tool error the agent can
    /// self-correct from (ADR-0077) -- the message carries the engine detail.
    #[test]
    fn explore_surfaces_sql_error_as_tool_error() {
        use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE result_1 (id INTEGER)")
            .unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        ws.register_result(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "id".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 0,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
        let sources = std::collections::HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": "SELECT nonexistent FROM result_1"}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        assert!(
            err.to_ascii_lowercase().contains("sql failed"),
            "error reads as a SQL failure: {err}"
        );
    }

    /// A cancel requested before the call aborts immediately as "explore
    /// cancelled" -- the pre-setup checkpoint fires before any sandbox setup
    /// runs, so a turn the user already stopped never burns setup cost. This is
    /// the one cancel checkpoint reachable without driving a real query.
    #[test]
    fn explore_returns_cancelled_when_cancel_already_requested() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let cancel = CancelToken::new();
        cancel.request();
        let err = dispatch(&json!({"sql": "SELECT 1"}), &mut deps, &cancel).unwrap_err();
        assert_eq!(err, "explore cancelled", "{err}");
        // No sandbox setup ran -> no working-set entry produced.
        assert_eq!(deps.working_set.len(), 0);
    }

    /// A result whose row count exceeds `result_row_cap` is refused with a
    /// resource-cap message naming the cap (ADR-0005/0030: silent truncation is
    /// forbidden). The scratch table dies with the sandbox, so no trace survives.
    #[test]
    fn explore_refuses_result_exceeding_row_cap() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        // cap = 2; the query yields 3 rows -> cap+1 rows land on the scratch
        // sandbox, COUNT (3) > cap (2) -> refused. The cap is below the helper's
        // default, so this test hand-builds TurnDeps for the one-off bound.
        let mut deps = crate::session::materializer::TurnDeps {
            conn: &conn,
            source_files: &sources,
            working_set: &mut ws,
            result_row_cap: 2,
            result_count_cap: 100,
            temp_path: std::path::Path::new("."),
        };
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": "SELECT 1 FROM range(3)"}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        assert!(
            err.contains("exceeds the cap"),
            "error names the cap refusal: {err}"
        );
        assert!(err.contains('2'), "error names the cap value: {err}");
        assert_eq!(deps.working_set.len(), 0);
    }

    /// After sandbox lockdown, a `read_*` table function is refused -- the only
    /// SQL-level ingress is closed (ADR-0005 L3). The refusal surfaces as a SQL
    /// failure carrying the engine's "disabled" message, so the agent cannot
    /// read arbitrary files through explore.
    #[test]
    fn explore_refuses_read_table_function_after_lockdown() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": "SELECT * FROM read_csv_auto('secret.csv')"}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        let lower = err.to_ascii_lowercase();
        assert!(
            lower.contains("disabled"),
            "lockdown refusal surfaces the disabled filesystem: {err}"
        );
        assert!(
            lower.contains("sql failed"),
            "refusal reads as a SQL failure: {err}"
        );
    }

    /// A SQL anchored on a stale result_N is refused up front (ADR-0013
    /// invariant 2) -- explore runs `provenance::analyze` before the sandbox, so
    /// a stale reference never reaches execution. The error names the stale ref.
    #[test]
    fn explore_refuses_stale_reference_anchor() {
        use crate::model::{
            DatasetDescriptor, DatasetPrivacy, RectifyProvenance, StaleAnchor, StaleReason,
        };
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        ws.register_result(DatasetDescriptor {
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
        let sources = std::collections::HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": "SELECT * FROM result_1"}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("stale reference"), "{err}");
        assert!(err.contains("result_1"), "{err}");
    }
}
