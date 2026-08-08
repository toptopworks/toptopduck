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
use crate::sandbox_sql::{
    preflight_read_sql, run_sandboxed_read, PreflightError, SandboxDeps, SandboxExecError,
};
use crate::session::materializer::TurnDeps;
use crate::tools::definitions::{self, EXPLORE_DEFAULT_SAMPLE_ROWS, EXPLORE_MAX_SAMPLE_ROWS};
use crate::tools::ToolPayload;

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
) -> Result<ToolPayload, String> {
    let sql = definitions::get_str(input, "sql")?;
    let sample_rows = sample_rows_param(input)?;
    let shape = run_explore(&sql, sample_rows, deps, cancel)?;
    // explore never promotes (it runs on a scratch sandbox that is dropped per
    // call -- ADR-0077 namespace isolation), so the side-effect channel is None.
    Ok(ToolPayload {
        content: json!({
            "columns": shape.columns.iter().map(definitions::column_json).collect::<Vec<_>>(),
            "row_count": shape.row_count,
            "sample": shape.sample,
        }),
        promotion: None,
    })
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

/// Run the explore query end to end. The gateway door (stale-ref + read_*
/// whitelist) and the sandbox lifecycle + cap + cancel checkpoints are the
/// shared spine with the materialize path ([`crate::sandbox_sql`]); explore's
/// own work is the tail -- deriving a shape from the sandbox table without
/// persisting anything.
fn run_explore(
    sql: &str,
    sample_rows: i64,
    deps: &mut TurnDeps,
    cancel: &CancelToken,
) -> Result<ExploreShape, String> {
    // Gateway door (ADR-0013 stale-ref + ADR-0080 read_* whitelist), shared
    // with the materialize path. Explore ignores the dependency set -- it
    // never promotes, so it records no provenance.
    preflight_read_sql(sql, deps.working_set, deps.temp_path).map_err(|e| match e {
        PreflightError::StaleReference(s) => {
            format!("stale reference: `{s}` has been invalidated and may not anchor a new query")
        }
        PreflightError::FsAcl(s) => s,
    })?;

    // Sandbox lifecycle + cap + cancel checkpoints, shared with the materialize
    // path. The scratch table lives on the sandbox connection only (turn-local,
    // no naming, no working-set entry -- AC #1).
    let table = run_sandboxed_read(
        sql,
        SCRATCH_TABLE,
        &SandboxDeps {
            admin_conn: deps.conn,
            source_files: deps.source_files,
            working_set: deps.working_set,
            result_row_cap: deps.result_row_cap,
        },
        cancel,
    )
    .map_err(|e| match e {
        SandboxExecError::Cancelled => "explore cancelled".to_string(),
        SandboxExecError::Resource { rows, cap } => format!(
            "result row count ({rows}) exceeds the cap {cap}; add a LIMIT or narrow the query"
        ),
        SandboxExecError::Runtime { detail, .. } => format!("SQL failed: {detail}"),
    })?;

    // Tail: derive the shape FROM THE SANDBOX (explore never persists). No
    // fingerprint, so this is the describe + sample primitives inline rather
    // than snapshot::derive_table (which additionally dumps + hashes).
    let columns = describe_scratch(&table.conn, &table.name)?;
    let sample = read_sample(&table.conn, &columns, sample_rows, &table.name)?;
    Ok(ExploreShape {
        columns,
        row_count: table.rows,
        sample,
    })
}

/// Read the column schema (name + canonical type) of the scratch table. Mirrors
/// snapshot::describe_table but is kept local because explore derives from a
/// sandbox-local temp table under a tool-generated name (never a source or
/// result the snapshot path handles).
fn describe_scratch(conn: &Connection, table: &str) -> Result<Vec<ColumnSchema>, String> {
    let mut stmt = conn
        .prepare(&format!("DESCRIBE {}", quote_ident(table)))
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
    table: &str,
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
        quote_ident(table)
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
        let payload = dispatch(
            &json!({"sql": "SELECT * FROM result_1 WHERE id > 1 ORDER BY id"}),
            &mut deps,
            &cancel,
        )
        .unwrap();
        // explore never promotes (scratch sandbox, dropped per call) -- the
        // side-effect channel carries None even on a successful read.
        assert!(payload.promotion.is_none());
        let v = &payload.content;

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

    /// A cancel requested before the call surfaces as "explore cancelled"
    /// without driving a real query. The shared runner has no pre-check (the
    /// agent loop's per-call check short-circuits a turn the user stopped
    /// before dispatch), so sandbox setup runs -- cheaply, on an empty working
    /// set -- and the mid-check after setup is what reports the cancel. This is
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
        // The mid-check aborted before the CREATE -> no scratch table, no
        // working-set entry.
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

    /// AC #2 / AC #4 (issue #293): a `read_*` call whose path resolves OUTSIDE
    /// the session source set + working temp dir is refused by the gateway
    /// whitelist BEFORE execution -- never reaching the engine, never failing
    /// silently. The structured error names the path and the allowed area, so
    /// the agent can self-correct (ADR-0077). The out-of-bounds file is real on
    /// disk (so canonicalization resolves it), just outside the temp dir.
    #[test]
    fn explore_refuses_out_of_bounds_read_path_at_gateway() {
        use crate::tools::test_support::inert_deps_with_temp;
        use std::fs;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        // A file that exists on disk but lives outside the session temp dir --
        // an absolute out-of-bounds target the canonicalizer can resolve.
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.csv");
        fs::write(&outside_file, "x").unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": format!("SELECT * FROM read_csv_auto('{}')", outside_file.to_string_lossy())}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        assert!(
            err.contains("outside the allowed"),
            "gateway names the out-of-bounds refusal: {err}"
        );
        assert!(
            err.contains("secret.csv"),
            "error names the offending path: {err}"
        );
        // No sandbox setup ran for a gateway refusal -> no working-set entry.
        assert_eq!(deps.working_set.len(), 0);
    }

    /// AC #4 (issue #293): a relative `../` escape lands outside the session
    /// source set + temp dir and is refused at the gateway, same as an
    /// absolute out-of-bounds path. The SQL carries the literal `../` so
    /// resolve()'s CWD branch is exercised end to end through the gateway.
    #[test]
    fn explore_refuses_relative_dotdot_read_escape_at_gateway() {
        use crate::tools::test_support::inert_deps_with_temp;
        use std::fs;
        use tempfile::{NamedTempFile, TempDir};

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        // A sibling file in the CWD's parent -- the literal `../<name>` in the
        // SQL resolves against the process CWD to this file, which is outside
        // temp_root, so the gateway refuses it. NamedTempFile gives panic-safe
        // RAII cleanup (the fixture lives outside any TempDir, so a manual
        // remove_file at scope end would leak on panic between create and
        // remove). Hard-panics if CWD parent is not writable -- a silent skip
        // would make this test a vacuous pass on CI with no signal.
        let cwd = std::env::current_dir().unwrap();
        let escape_file = NamedTempFile::new_in(cwd.parent().unwrap())
            .expect("escape-target fixture: CWD parent must be writable");
        fs::write(escape_file.path(), "x").unwrap();
        let target_name = escape_file
            .path()
            .file_name()
            .and_then(|n| n.to_str())
            .expect("escape-target filename is valid UTF-8");
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": format!("SELECT * FROM read_csv_auto('../{target_name}')")}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        assert!(
            err.contains("outside the allowed"),
            "relative `../` escape refused: {err}"
        );
        assert!(
            err.contains(&format!("../{target_name}")),
            "error names the literal relative path: {err}"
        );
        // escape_file cleans up via Drop on scope exit (incl. panic).
    }

    /// AC#2 symlink vector (issue #310 / #402): a symlink placed INSIDE the
    /// session temp dir but pointing at a file OUTSIDE is canonicalized to its
    /// real out-of-bounds target and refused at the gateway door -- the ACL
    /// never authorizes a path by its in-bounds alias. Symmetric with the
    /// `fs_acl::symlink_escape_is_refused` unit test, but exercised end to end
    /// through `dispatch` (the SQL parse + `preflight_read_sql` + `FsAcl::check`
    /// pipeline the agent actually drives).
    #[test]
    #[cfg(unix)]
    fn explore_refuses_symlink_escape_at_gateway() {
        use crate::tools::test_support::inert_deps_with_temp;
        use std::fs;
        use std::os::unix::fs::symlink;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        // A file outside the session temp dir -- the symlink target.
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.csv");
        fs::write(&outside_file, "x").unwrap();
        // A symlink INSIDE temp pointing at the outside file. Canonicalization
        // follows the link, so the resolved path is outside temp_root.
        let link = temp.path().join("alias.csv");
        symlink(&outside_file, &link).expect("symlink creation failed");
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": format!(
                "SELECT * FROM read_csv_auto('{}')", link.to_string_lossy()
            )}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        assert!(
            err.contains("outside the allowed"),
            "symlink escape refused: {err}"
        );
        assert!(
            err.contains("alias.csv"),
            "error names the symlink path: {err}"
        );
        assert_eq!(deps.working_set.len(), 0);
    }

    // TODO: re-enable after enabling Windows Developer Mode or CI with admin
    // /// Windows variant of `explore_refuses_symlink_escape_at_gateway`. Uses
    // /// `symlink_dir` (mirrors `fs_acl::symlink_escape_is_refused_windows`).
    // /// Hard-panics if symlink creation fails (no Developer Mode) -- a silent
    // /// skip would make this test a vacuous pass on local Windows environments
    // /// without Developer Mode, with no signal (issue #402, consistent with
    // /// #401's NamedTempFile + .expect pattern).
    // #[test]
    // #[cfg(windows)]
    // fn explore_refuses_symlink_escape_at_gateway_windows() {
    //     use crate::tools::test_support::inert_deps_with_temp;
    //     use std::os::windows::fs::symlink_dir;
    //     use tempfile::TempDir;
    //
    //     let conn = Connection::open_in_memory().unwrap();
    //     let mut ws = crate::workingset::WorkingSet::default();
    //     let sources = std::collections::HashMap::new();
    //     let temp = TempDir::new().unwrap();
    //     let outside = TempDir::new().unwrap();
    //     // A directory symlink INSIDE temp pointing at the outside dir.
    //     let link = temp.path().join("alias");
    //     symlink_dir(outside.path(), &link)
    //         .expect("Windows symlink creation needs Developer Mode / admin");
    //     let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
    //     let cancel = CancelToken::new();
    //     let err = dispatch(
    //         &json!({"sql": format!(
    //             "SELECT * FROM read_csv_auto('{}')", link.to_string_lossy()
    //         )}),
    //         &mut deps,
    //         &cancel,
    //     )
    //     .unwrap_err();
    //     assert!(
    //         err.contains("outside the allowed"),
    //         "symlink escape refused: {err}"
    //     );
    //     assert!(
    //         err.contains("\\alias") || err.contains("/alias"),
    //         "error names the symlink path: {err}"
    //     );
    //     assert_eq!(deps.working_set.len(), 0);
    // }

    /// Design-B lockdown backstop (issue #293): a `read_*` call whose path the
    /// gateway whitelist ALLOWS (a file inside the session temp dir) still does
    /// not execute -- the engine-level `disabled_filesystems` lockdown remains
    /// the file-reachability GUARANTEE for SQL-embedded read_*, so the agent
    /// cannot read files through explore; it reaches sources via the
    /// `"<ref>".data` catalog. The gateway adds structured out-of-bounds
    /// guidance (ADR-0080); the lockdown guarantees the rest (ADR-0005).
    #[test]
    fn explore_lockdown_still_refuses_in_bounds_read_path() {
        use crate::tools::test_support::inert_deps_with_temp;
        use std::fs;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        // A file INSIDE the temp dir: the gateway whitelist allows it (in-
        // bounds), so the call proceeds to the sandbox, where the engine
        // lockdown refuses read_* with its "... disabled" message.
        let inside = temp.path().join("scratch.csv");
        fs::write(&inside, "x").unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let err = dispatch(
            &json!({"sql": format!("SELECT * FROM read_csv_auto('{}')", inside.to_string_lossy())}),
            &mut deps,
            &cancel,
        )
        .unwrap_err();
        let lower = err.to_ascii_lowercase();
        assert!(
            lower.contains("disabled"),
            "lockdown backstop refuses an in-bounds read_*: {err}"
        );
        assert!(
            lower.contains("sql failed"),
            "refusal reads as a SQL failure: {err}"
        );
        // The gateway let the in-bounds path through (it is inside temp_root);
        // the refusal is from the engine lockdown, not the FsAcl door.
        assert!(
            !lower.contains("outside the allowed"),
            "gateway must have let the in-bounds path through: {err}"
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
