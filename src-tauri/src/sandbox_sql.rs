//! Shared read-only sandbox SQL execution for the explore + materialize tools
//! (issue #334, ADR-0053 / ADR-0077 / ADR-0080).
//!
//! Two read-SQL paths share the same spine: an `explore` scratch query (turn-
//! local, no promotion) and a `materialize` promotion (installs `result_N`).
//! Both (1) refuse a stale reference + a non-literal or out-of-bounds
//! `read_*` path at the gateway door, then (2) run the provider SQL once on
//! a sandboxed instance under the row-count cap with the same cancel
//! checkpoints. Before this module the two paths mirrored ~60 lines verbatim
//! ("mirrors the materialize path"), so any change to a cancel checkpoint or
//! the cap logic drifted silently in the other, and the gateway door was
//! asymmetric -- explore ran the `FsAcl` whitelist, materialize did not, so
//! an out-of-bounds `read_*` surfaced as an opaque engine error instead of a
//! structured, path-naming error.
//!
//! Two deep modules collapse the duplication (ADR-0053):
//! - [`preflight_read_sql`] -- the gateway door: `provenance` stale-ref
//!   refusal + `FsAcl` `read_*` path whitelist. Pure (no DuckDB).
//! - [`run_sandboxed_read`] -- the sandbox lifecycle + row-count cap + cancel
//!   checkpoints.
//!
//! Each caller keeps its own tail (explore derives a shape from the sandbox;
//! materialize installs onto admin + derives + registers + records provenance
//! + GCs), so the shared spine is exactly the part that was mirrored.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use duckdb::Connection;

use crate::cancel::CancelToken;
use crate::fs_acl::{AccessMode, FsAcl};
use crate::guardrail::{classify_duckdb_error, ExecError, ExecErrorKind};
use crate::ingest::schema::quote_ident;
use crate::provenance;
use crate::session::sandbox;
use crate::tools::read_paths::extract_read_paths;
use crate::workingset::WorkingSet;

// ============================== preflight ==============================

/// The gateway analysis for a read-SQL call. The dependency set a successful
/// materialize records for the stale-cascade (issue #40); explore ignores it
/// (it never promotes, so it records nothing).
#[derive(Debug)]
pub(crate) struct PreflightAnalysis {
    /// The working-set reference names this SQL read from (FROM/JOIN targets
    /// intersected with the live working set). Recorded on a successful
    /// materialize via `WorkingSet::record_provenance`; unused by explore.
    pub refs: HashSet<String>,
}

/// Why a read-SQL call was refused at the gateway door. A narrow enum -- only
/// the two checks the door runs. Sandbox-execution failures are a separate
/// concern ([`SandboxExecError`]); each caller handles the two enums by name
/// so a stale reference or an out-of-bounds path never reads as a runtime
/// error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PreflightError {
    /// The SQL anchored on a stale `result_N` (ADR-0013 invariant 2). Carries
    /// the bare dead reference name so each caller renders it into its own
    /// agent-facing wording.
    StaleReference(String),
    /// The SQL embedded a `read_*` path outside the session source set +
    /// working temp dir (ADR-0080). Carries the structured, path-naming
    /// message the agent self-corrects from (ADR-0077).
    FsAcl(String),
    /// The SQL embedded a `read_*` call whose path is not a literal string
    /// (ADR-0088 Decision 3). FsAcl cannot validate a runtime-computed path,
    /// so the call is refused before execution.
    NonLiteralPath(String),
    /// The SQL could not be parsed for path analysis (ADR-0088 Why 4). Rather
    /// than letting it reach the engine with zero file-reachability checks, the
    /// preflight refuses it; the agent rewrites as a standard SELECT.
    Unparseable(String),
}

/// The shared gateway door for both read-SQL paths: refuse a stale reference
/// (ADR-0013 invariant 2), then refuse an unparseable SQL (ADR-0088 Why 4),
/// then refuse a non-literal `read_*` path (ADR-0088 Decision 3), then refuse
/// an out-of-bounds `read_*` path (ADR-0080). Pure -- parses SQL text +
/// checks paths, never touches DuckDB.
///
/// A stale reference is checked first: it is cheaper (the one parse is shared
/// with the dependency extraction) and the earlier refusal is the more honest
/// one (a stale anchor taints the whole call regardless of any `read_*`
/// paths). The same parse yields [`PreflightAnalysis::refs`] for the
/// materialize caller's provenance record.
pub(crate) fn preflight_read_sql(
    sql: &str,
    working_set: &WorkingSet,
    temp_path: &Path,
) -> Result<PreflightAnalysis, PreflightError> {
    let analyzed = provenance::analyze(sql, working_set);
    if let Some(stale_ref) = analyzed.stale_ref {
        return Err(PreflightError::StaleReference(stale_ref));
    }
    let extraction = extract_read_paths(sql).map_err(|_| {
        PreflightError::Unparseable(
            "could not analyze SQL for file-path safety; rewrite as a standard SELECT".to_string(),
        )
    })?;
    if extraction.non_literal_read_found {
        return Err(PreflightError::NonLiteralPath(
            "read_* requires a literal path string; dynamic paths are not allowed".to_string(),
        ));
    }
    let acl = FsAcl::new(working_set, temp_path);
    for path in &extraction.paths {
        if let Err(e) = acl.check(path, AccessMode::Read) {
            return Err(PreflightError::FsAcl(e.message()));
        }
    }
    Ok(PreflightAnalysis {
        refs: analyzed.refs,
    })
}

// =========================== sandboxed runner ===========================

/// The read-only view of the sandbox-execution dependencies, projected from
/// [`crate::session::materializer::TurnDeps`]. The runner touches neither the
/// mutable working set nor the temp path -- promotion / shape derivation /
/// GC are the caller's tail -- so this carries only what the sandbox
/// lifecycle + cap need.
pub(crate) struct SandboxDeps<'a> {
    /// The admin connection (prior results are mirrored FROM here into the
    /// sandbox). Read-only inside the runner.
    pub admin_conn: &'a Connection,
    /// The source snapshot file map (sources are READ_ONLY-attached into the
    /// sandbox so `"<ref>".data` resolves identically to admin).
    pub source_files: &'a HashMap<String, PathBuf>,
    /// The live working set (drives which sources attach + which results
    /// mirror). Read-only inside the runner.
    pub working_set: &'a WorkingSet,
    /// The row-count ceiling (ADR-0005 L3). A result exceeding it is refused
    /// (silent truncation forbidden, ADR-0030).
    pub result_row_cap: u64,
    /// The session-level engine-defaults snapshot (issue #741), projected
    /// from the admin engine's own copy so both execution faces cap from one
    /// snapshot: the sandbox the provider SQL runs on is the object these
    /// caps constrain.
    pub engine_defaults: &'a crate::app_config::model::EngineDefaults,
}

/// A sandbox table the runner hands back to the caller for its tail. Owns the
/// sandbox connection, so dropping it cleans up the scratch/result table
/// (per-turn isolation, ADR-0027).
pub(crate) struct SandboxTable {
    /// The sandbox connection holding the table. The caller runs its
    /// tool-controlled tail against it (explore: DESCRIBE + sample;
    /// materialize: `install_result` copies it onto admin).
    pub conn: Connection,
    /// The table name (`_explore_scratch` for explore, `result_N` for
    /// materialize) -- the name the caller passed in.
    pub name: String,
    /// The row count (already under the cap, so the caller can use it
    /// directly without re-counting).
    pub rows: u64,
}

/// A sandbox-execution failure. A narrow enum -- only what the sandbox
/// lifecycle + cap + cancel can produce. Preflight (gateway) failures are
/// [`PreflightError`]; the caller handles the two enums separately so a
/// cancel or a cap hit is never conflated with a runtime error.
#[derive(Debug)]
pub(crate) enum SandboxExecError {
    /// Cancel was requested at one of the three checkpoints (mid-check after
    /// setup, create-failure cancel priority, post-check after the cap). The
    /// partial table lives on the sandbox only; dropping it cleans up.
    Cancelled,
    /// The true result exceeded the row-count cap (count == cap+1, ADR-0030).
    /// Silent truncation is forbidden, so the call aborts; the agent can add
    /// its own LIMIT and retry.
    Resource { rows: u64, cap: u64 },
    /// A sandbox primitive (open / attach / mirror / CREATE /
    /// COUNT) failed with an engine error. The kind is the retry-routing
    /// classification (inferred via `classify_duckdb_error` at construction
    /// time), so each caller uses it directly instead of re-inferring from
    /// the detail string; the detail is the honest engine message each
    /// caller folds into its own wording.
    Runtime { kind: ExecErrorKind, detail: String },
}

/// Run `sql` once on a sandboxed instance as `table_name`, handing back the
/// owned sandbox table. Owns the whole sandbox lifecycle + the row-count cap
/// + the cancel checkpoints, so both read-SQL paths enforce uniformly.
///
/// Cancel checkpoints (ADR-0021 / ADR-0077 honesty):
/// 1. **Mid-check** -- after sandbox setup, before the CREATE. A cancel that
///    arrived during setup is reported as Cancelled, not the later CREATE's
///    generic engine error.
/// 2. **Create-failure cancel priority** -- if the CREATE errors AND cancel is
///    requested, report Cancelled (the interrupt surfaced as a generic DuckDB
///    failure; the flag is the honest signal).
/// 3. **Post-check** -- after the cap check, before returning. A cancel that
///    landed between the query's success and the caller's tail is reported as
///    Cancelled.
///
/// There is deliberately NO pre-check (a cancel check before sandbox setup):
/// the agent loop's per-call check already short-circuits a turn the user
/// stopped before this runs, and the mid-check covers a cancel arriving
/// during setup.
pub(crate) fn run_sandboxed_read(
    sql: &str,
    table_name: &str,
    deps: &SandboxDeps,
    cancel: &CancelToken,
) -> Result<SandboxTable, SandboxExecError> {
    // Sandbox lifecycle: fresh instance -> attach sources READ_ONLY -> mirror
    // prior results. Dropped at end of scope (per-turn isolation, ADR-0027).
    // The engine-level disabled_filesystems lockdown was removed (ADR-0088):
    // FsAcl + non-literal refusal in preflight is the sole read_* constraint.
    let sandbox_conn = sandbox::open(deps.engine_defaults).map_err(lift_exec_error)?;
    sandbox::attach_sources(&sandbox_conn, deps.working_set, deps.source_files)
        .map_err(lift_exec_error)?;
    sandbox::mirror_results(&sandbox_conn, deps.admin_conn, deps.working_set)
        .map_err(lift_exec_error)?;

    // Mid-check: cancel arrived during setup -> honest Cancelled, not the
    // later CREATE's generic failure.
    if cancel.is_requested() {
        return Err(SandboxExecError::Cancelled);
    }

    // Register the sandbox interrupt handle so a cancel can abort THIS query
    // at source (ADR-0021), run CREATE ... LIMIT cap+1, then clear the handle
    // so the caller's tail (fast, tool-controlled) is never disrupted.
    cancel.set_interrupt(sandbox_conn.interrupt_handle());
    let inner = sql.trim().trim_end_matches(';').trim_end();
    let cap_plus_one = deps.result_row_cap.saturating_add(1);
    let create_sql = format!(
        "CREATE TABLE {} AS SELECT * FROM ({inner}) AS _src LIMIT {cap_plus_one}",
        quote_ident(table_name),
    );
    let create_outcome = sandbox_conn.execute_batch(&create_sql);
    cancel.clear_interrupt();

    let create_err = create_outcome.err();
    // Create-failure cancel priority: the CREATE errored; if cancel was also
    // requested, the interrupt is the honest cause (it surfaces as a generic
    // DuckDB failure), so report Cancelled over the engine's opaque message.
    if create_err.is_some() && cancel.is_requested() {
        return Err(SandboxExecError::Cancelled);
    }
    if let Some(e) = create_err {
        return Err(runtime_from_duckdb(e));
    }

    // Row-count governor: count == cap+1 -> the true result exceeded the cap
    // (DuckDB pushes LIMIT into the scan, so only cap+1 rows materialized).
    let rows: i64 = match sandbox_conn.query_row(
        &format!("SELECT COUNT(*) FROM {}", quote_ident(table_name)),
        [],
        |r| r.get(0),
    ) {
        Ok(rows) => rows,
        Err(e) => return Err(runtime_from_duckdb(e)),
    };
    if rows as u64 > deps.result_row_cap {
        return Err(SandboxExecError::Resource {
            rows: rows as u64,
            cap: deps.result_row_cap,
        });
    }

    // Post-check: cancel landed between the query's success and the caller's
    // tail -> honest Cancelled. The partial table is on the sandbox only, so
    // dropping it cleans up (no admin rollback needed).
    if cancel.is_requested() {
        return Err(SandboxExecError::Cancelled);
    }

    Ok(SandboxTable {
        conn: sandbox_conn,
        name: table_name.to_string(),
        rows: rows.max(0) as u64,
    })
}

/// Classify a raw DuckDB error and wrap it as a [`SandboxExecError::Runtime`].
/// The kind is derived from the detail via `classify_duckdb_error`, guaranteeing
/// `kind == classify_duckdb_error(&detail)` at every direct construction site.
fn runtime_from_duckdb(e: duckdb::Error) -> SandboxExecError {
    let detail = e.to_string();
    SandboxExecError::Runtime {
        kind: classify_duckdb_error(&detail),
        detail,
    }
}

/// Lift a sandbox-primitive [`ExecError`] (open / attach / mirror)
/// into the runner's narrow [`SandboxExecError::Runtime`], preserving both the
/// retry-routing kind and the honest detail. The kind was already classified at
/// the sandbox-primitive boundary (`duck_err` / `classify_duckdb_error`), so it
/// is carried verbatim without re-inferring.
fn lift_exec_error(e: ExecError) -> SandboxExecError {
    SandboxExecError::Runtime {
        kind: e.kind,
        detail: e.detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        ColumnSchema, DatasetDescriptor, DatasetPrivacy, RectifyProvenance, StaleAnchor,
        StaleReason,
    };
    use crate::workingset::WorkingSet;
    use std::fs;
    use tempfile::TempDir;

    /// A working set with one live source member named `people`.
    fn ws_with_people() -> WorkingSet {
        let mut ws = WorkingSet::default();
        ws.register(DatasetDescriptor {
            reference_name: "people".into(),
            display_name: "people".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 0,
            sample: vec![],
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
        ws
    }

    /// A working set where `result_1` is stale (anchored on a deleted source),
    /// so a `FROM result_1` is a stale-reference refusal.
    fn ws_with_stale_result() -> WorkingSet {
        let mut ws = WorkingSet::default();
        ws.register_result(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 0,
            sample: vec![],
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: Some(StaleAnchor {
                reference_name: "people".into(),
                display_name: "people".into(),
                reason: StaleReason::Deleted,
            }),
        });
        ws
    }

    /// A stale reference is refused BEFORE an out-of-bounds `read_*` path: the
    /// SQL carries BOTH (a `FROM result_1` that is stale AND a `read_csv` on a
    /// path outside the temp dir), and the door returns `StaleReference`.
    /// Ordering matters -- reporting FsAcl first would hide the stale anchor,
    /// the deeper taint (ADR-0013 invariant 2 takes priority).
    #[test]
    fn stale_reference_takes_priority_over_fs_acl() {
        let temp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.csv");
        fs::write(&outside_file, "x").unwrap();
        let ws = ws_with_stale_result();
        let sql = format!(
            "SELECT * FROM result_1 JOIN read_csv_auto('{}') ON TRUE",
            outside_file.to_string_lossy()
        );
        let err = preflight_read_sql(&sql, &ws, temp.path()).unwrap_err();
        assert_eq!(err, PreflightError::StaleReference("result_1".into()));
    }

    /// A `read_*` path outside the session source set + temp dir is refused as
    /// `FsAcl` when no stale reference is present. The message names the path
    /// and the allowed area so the agent can self-correct (ADR-0077 / ADR-
    /// 0080).
    #[test]
    fn out_of_bounds_read_path_is_refused_as_fs_acl() {
        let temp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.csv");
        fs::write(&outside_file, "x").unwrap();
        let ws = WorkingSet::default();
        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            outside_file.to_string_lossy()
        );
        let err = preflight_read_sql(&sql, &ws, temp.path()).unwrap_err();
        match err {
            PreflightError::FsAcl(msg) => {
                assert!(msg.contains("outside the allowed"), "{msg}");
                assert!(msg.contains("secret.csv"), "{msg}");
            }
            other => panic!("expected FsAcl, got {other:?}"),
        }
    }

    /// A clean SQL (no stale ref, no `read_*` path) returns the dependency set
    /// for the materialize caller's provenance record. The refs are the
    /// FROM/JOIN targets intersected with the live working set. No DuckDB.
    #[test]
    fn clean_sql_returns_refs_for_provenance() {
        let temp = TempDir::new().unwrap();
        let ws = ws_with_people();
        let analysis = preflight_read_sql(
            r#"SELECT COUNT(*) AS n FROM "people".data"#,
            &ws,
            temp.path(),
        )
        .expect("clean SQL passes preflight");
        assert_eq!(analysis.refs, ["people".to_string()].into_iter().collect(),);
    }

    /// A SQL that references neither a stale result nor a `read_*` path and
    /// reads no live member yields an empty ref set (no provenance edges).
    #[test]
    fn sql_reading_no_live_member_yields_empty_refs() {
        let temp = TempDir::new().unwrap();
        let ws = ws_with_people();
        let analysis = preflight_read_sql("SELECT 1 AS x", &ws, temp.path())
            .expect("SELECT 1 passes preflight");
        assert!(analysis.refs.is_empty(), "{:?}", analysis.refs);
    }

    /// A non-literal `read_*` path (a column reference, a dynamic expression)
    /// is refused by the preflight as `NonLiteralPath` -- FsAcl cannot validate
    /// a runtime-computed path, so the call is refused before execution with a
    /// message directing the agent to use a literal path string (ADR-0088
    /// Decision 3).
    #[test]
    fn non_literal_read_path_is_refused_by_preflight() {
        let temp = TempDir::new().unwrap();
        let ws = WorkingSet::default();
        let err = preflight_read_sql("SELECT * FROM read_csv_auto(some_column)", &ws, temp.path())
            .unwrap_err();
        match err {
            PreflightError::NonLiteralPath(msg) => {
                assert!(
                    msg.contains("literal"),
                    "non-literal refusal message directs agent to literal path: {msg}"
                );
            }
            other => panic!("expected NonLiteralPath, got {other:?}"),
        }
    }

    /// SQL the path-analysis parser cannot understand is refused as
    /// `Unparseable` rather than passing through unchecked (ADR-0088 Why 4 --
    /// sqlparser and DuckDB may diverge on dialect coverage).
    #[test]
    fn unparseable_sql_is_refused_by_preflight() {
        let temp = TempDir::new().unwrap();
        let ws = WorkingSet::default();
        let err = preflight_read_sql("this is not sql at all", &ws, temp.path()).unwrap_err();
        match err {
            PreflightError::Unparseable(msg) => {
                assert!(
                    msg.contains("analyze"),
                    "unparseable refusal mentions analysis: {msg}"
                );
            }
            other => panic!("expected Unparseable, got {other:?}"),
        }
    }
}
