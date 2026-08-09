//! Derived source persistence (issue #433, ADR-0087 Decision 4).
//!
//! When materialize SQL references a file under the `tool_output` sandbox
//! directory via `read_csv_auto` / `read_parquet` / `read_json_auto`, the file
//! is an ephemeral MCP-tool output that will not survive session close. This
//! module detects such references, copies the file into the session's
//! persistent staging area, creates a read-only snapshot (same copy-in path as
//! uploaded sources), and rewrites the SQL to use a catalog reference
//! (`"ref".data`) so that:
//!
//! 1. `provenance::analyze` tracks the derived source (it only follows
//!    `TableFactor::Table`, not `TableFactor::Function` — ADR-0025/0041 stale
//!    cascade would miss a `read_csv_auto('path')` reference).
//! 2. The snapshot survives resume: the persistent file's path lands in
//!    `SourceRef.source_path` via the working set projection, and phase 1
//!    re-ingests it via the standard `resume_ingest_at` path (zero special
//!    code).
//!
//! The rewrite happens BEFORE preflight (provenance analysis + FsAcl) so the
//! rewritten SQL flows through the normal materialize pipeline unchanged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sqlparser::ast::{
    Expr, FunctionArg, FunctionArgExpr, FunctionArguments, Ident, ObjectName, Query, SetExpr,
    Statement, TableAlias, TableFactor, TableWithJoins,
};
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;

use crate::guardrail::{ExecError, ExecErrorKind};
use crate::ingest::schema::quote_ident;
use crate::ingest::{self, loader};
use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
use crate::session::materializer::TurnDeps;
use crate::session::TOOL_OUTPUT_DIR_NAME;
use crate::tools::read_paths::{extract_read_paths, is_file_function};

/// Subdirectory under `temp_path` for staging derived source files when no
/// `.duck` is bound (ADR-0087 D4). Files here are migrated to `<duck_stem>.assets/`
/// on `bind_duck`. Lifecycle follows the TempDir RAII (cleaned on session drop).
pub(crate) const DERIVED_STAGING_DIR: &str = "derived";

/// Detect `read_*` calls referencing `tool_output` files, copy each file into
/// a persistent snapshot, register it as a source (same path as uploaded
/// sources), and rewrite the SQL to use catalog references. Returns the
/// rewritten SQL (or the original verbatim if no derived sources were found).
///
/// Called from `RealMaterializer::try_materialize` BEFORE preflight, so the
/// rewritten SQL's catalog references flow through provenance analysis
/// naturally. A non-`tool_output` `read_*` path is left untouched — it still
/// hits the FsAcl check in preflight.
pub(crate) fn process(sql: &str, deps: &mut TurnDeps) -> Result<String, ExecError> {
    let tool_output_dir = deps.temp_path.join(TOOL_OUTPUT_DIR_NAME);

    // Reuse the same extractor preflight uses. A parse failure here is
    // handled by preflight's own Unparseable refusal — this function is
    // best-effort: if the SQL can't be parsed, return it unchanged and let
    // preflight produce the structured error.
    let extraction = match extract_read_paths(sql) {
        Ok(e) => e,
        Err(()) => return Ok(sql.to_string()),
    };

    // Filter to paths inside tool_output/. Canonicalized comparison prevents
    // `..` traversal and symlink escapes (ADR-0080 threat model).
    let tool_output_paths: Vec<&String> = extraction
        .paths
        .iter()
        .filter(|p| is_in_tool_output(p, &tool_output_dir))
        .collect();

    if tool_output_paths.is_empty() {
        return Ok(sql.to_string());
    }

    let staging_dir = deps.temp_path.join(DERIVED_STAGING_DIR);
    let mut path_to_ref: HashMap<String, String> = HashMap::new();

    // Track successfully registered ref names so we can roll back on a later
    // path's failure (issue #433 review I4). Without this, a multi-file SQL
    // whose second file fails would leave ghost registrations in the working
    // set + admin conn.
    let mut registered: Vec<String> = Vec::new();

    for path_str in &tool_output_paths {
        // Dedup within this call (same path referenced twice in one SQL).
        if path_to_ref.contains_key(*path_str) {
            continue;
        }

        let src_path = Path::new(path_str);
        let ref_name = match ingest::derive_reference_name(src_path) {
            Some(base) => deps.working_set.deconflict(&base),
            None => deps.working_set.deconflict("derived"),
        };

        match process_one_derived(src_path, &ref_name, &staging_dir, deps) {
            Ok(()) => {
                path_to_ref.insert(path_str.to_string(), ref_name.clone());
                registered.push(ref_name);
            }
            Err(e) => {
                // Rollback previously registered sources from this call.
                for prev in &registered {
                    let _ = deps
                        .conn
                        .execute_batch(&format!("DETACH {}", quote_ident(prev)));
                    deps.source_files.remove(prev);
                    deps.working_set.remove(prev);
                }
                return Err(e);
            }
        }
    }

    if path_to_ref.is_empty() {
        return Ok(sql.to_string());
    }

    // Rewrite the SQL: replace each tool_output read_* call with a catalog
    // reference. The rewritten SQL flows into preflight (provenance now
    // tracks the catalog refs) and sandbox exec (sources are ATTACHed).
    rewrite_sql(sql, &path_to_ref)
}

/// Stage, copy_in, ATTACH, and register a single derived source file.
/// Called once per unique tool_output path. Cleans up its own staging +
/// snapshot files on failure (A5: symmetric cleanup). The caller is
/// responsible for rolling back previously registered sources if this
/// returns `Err`.
fn process_one_derived(
    src_path: &Path,
    ref_name: &str,
    staging_dir: &Path,
    deps: &mut TurnDeps,
) -> Result<(), ExecError> {
    let persistent_path = stage_derived_file(src_path, ref_name, staging_dir)?;

    // Determine the DuckDB reader function from the file extension.
    let dispatched = ingest::dispatch(&persistent_path);
    let reader_fn = match ingest::reader_for(&dispatched) {
        Some(r) => r,
        None => {
            let _ = std::fs::remove_file(&persistent_path);
            return Err(ExecError::new(
                ExecErrorKind::Runtime,
                format!(
                    "derived source `{}` has an unsupported format for DuckDB import",
                    src_path.display()
                ),
            ));
        }
    };

    // copy_in: create a read-only snapshot (same path as uploaded sources).
    let snap =
        loader::copy_in(&persistent_path, deps.temp_path, ref_name, reader_fn).map_err(|e| {
            let _ = std::fs::remove_file(&persistent_path);
            ExecError::new(ExecErrorKind::Runtime, e.to_string())
        })?;

    // ATTACH the snapshot to admin as a read-only catalog (same as
    // uploaded sources — `"ref".data` resolves identically).
    let attach_path = snap.file_path.to_string_lossy();
    let attach_sql = format!(
        "ATTACH '{attach_path}' AS {} (READ_ONLY);",
        quote_ident(ref_name)
    );
    if let Err(e) = deps.conn.execute_batch(&attach_sql) {
        let _ = std::fs::remove_file(&snap.file_path);
        let _ = std::fs::remove_file(&persistent_path);
        return Err(ExecError::new(
            ExecErrorKind::Runtime,
            format!("failed to attach derived source snapshot: {e}"),
        ));
    }

    // Register in source_files (the snapshot path, same as uploaded
    // sources). The sandbox path in run_sandboxed_read attaches from here.
    deps.source_files
        .insert(ref_name.to_string(), snap.file_path);

    // Register in the working set as a source (not a result). Silent —
    // no SourceLifecycleEvent::Added (ADR-0087 D4: derived source
    // registration is a materialize side effect, not a user action).
    // The source_path points to the persistent (staged) copy so resume
    // can re-ingest it.
    let descriptor = DatasetDescriptor {
        reference_name: ref_name.to_string(),
        display_name: ref_name.to_string(),
        source_path: persistent_path.to_string_lossy().to_string(),
        columns: snap.columns,
        row_count: snap.row_count,
        sample: snap.sample,
        fingerprint: snap.fingerprint,
        rectify: RectifyProvenance::NotApplicable,
        privacy: DatasetPrivacy::default(),
        stale: None,
    };
    deps.working_set.register(descriptor);

    Ok(())
}

/// Copy a tool_output file into the persistent staging directory under a
/// deterministic name. The staging directory is created if needed.
fn stage_derived_file(
    src: &Path,
    ref_name: &str,
    staging_dir: &Path,
) -> Result<PathBuf, ExecError> {
    std::fs::create_dir_all(staging_dir).map_err(|e| {
        ExecError::new(
            ExecErrorKind::Runtime,
            format!("failed to create derived staging dir: {e}"),
        )
    })?;
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("dat");
    let dest = staging_dir.join(format!("{ref_name}.{ext}"));
    std::fs::copy(src, &dest).map_err(|e| {
        ExecError::new(
            ExecErrorKind::Runtime,
            format!("failed to copy derived source `{}`: {e}", src.display()),
        )
    })?;
    Ok(dest)
}

/// Whether `path_str` points inside the session's `tool_output` directory.
/// Canonicalizes both paths so `..` traversal and symlinks cannot escape
/// (ADR-0080 threat model: agent SQL may be influenced by prompt injection).
/// Fail-closed: if the path doesn't exist or can't be resolved, reject it.
fn is_in_tool_output(path_str: &str, tool_output_dir: &Path) -> bool {
    let canon = match std::fs::canonicalize(path_str) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let canon_dir =
        std::fs::canonicalize(tool_output_dir).unwrap_or_else(|_| tool_output_dir.to_path_buf());
    canon.starts_with(&canon_dir)
}

// --- SQL rewrite -------------------------------------------------------

/// Rewrite `sql` by replacing each `read_*('path')` table-function call whose
/// path is in `path_to_ref` with the corresponding catalog reference
/// (`"ref".data`). Only FROM-clause table factors are rewritten — the common
/// pattern (`FROM read_csv_auto('path')`). Scalar `read_*` in projections /
/// WHERE are left as-is (the tool_output file still exists during the session;
/// provenance tracking for scalar reads is a v1 accepted gap).
///
/// The re-serialized SQL replaces the original for preflight + sandbox exec +
/// recipe storage. sqlparser's Display may reformat whitespace / quoting, but
/// the SQL semantics are preserved (validated by the subsequent DuckDB exec).
fn rewrite_sql(sql: &str, path_to_ref: &HashMap<String, String>) -> Result<String, ExecError> {
    let statements = Parser::parse_sql(&DuckDbDialect {}, sql).map_err(|e| {
        ExecError::new(
            ExecErrorKind::Runtime,
            format!("failed to parse SQL for derived-source rewrite: {e}"),
        )
    })?;

    let mut out = String::new();
    for (i, stmt) in statements.iter().enumerate() {
        if i > 0 {
            out.push(';');
            out.push('\n');
        }
        if let Statement::Query(query) = stmt {
            let mut q = query.clone();
            rewrite_query(&mut q, path_to_ref);
            out.push_str(&q.to_string());
        } else {
            out.push_str(&stmt.to_string());
        }
    }
    Ok(out)
}

/// Walk a `Query` recursively, rewriting FROM-clause `read_*` table-function
/// calls in its body + each CTE.
fn rewrite_query(query: &mut Query, path_to_ref: &HashMap<String, String>) {
    if let Some(with) = &mut query.with {
        for cte in &mut with.cte_tables {
            rewrite_query(cte.query.as_mut(), path_to_ref);
        }
    }
    rewrite_set_expr(query.body.as_mut(), path_to_ref);
}

/// Walk a set-expression: a SELECT (rewrite its FROM), a set-op (recurse
/// both branches), or a nested query (recurse).
fn rewrite_set_expr(expr: &mut SetExpr, path_to_ref: &HashMap<String, String>) {
    match expr {
        SetExpr::Select(select) => {
            for twj in &mut select.from {
                rewrite_table_with_joins(twj, path_to_ref);
            }
        }
        SetExpr::SetOperation { left, right, .. } => {
            rewrite_set_expr(left.as_mut(), path_to_ref);
            rewrite_set_expr(right.as_mut(), path_to_ref);
        }
        SetExpr::Query(query) => rewrite_query(query.as_mut(), path_to_ref),
        _ => {}
    }
}

/// Walk a relation + its joins' table factors, rewriting matching `read_*`
/// calls to catalog references.
fn rewrite_table_with_joins(twj: &mut TableWithJoins, path_to_ref: &HashMap<String, String>) {
    rewrite_table_factor(&mut twj.relation, path_to_ref);
    for join in &mut twj.joins {
        rewrite_table_factor(&mut join.relation, path_to_ref);
    }
}

/// Rewrite a single table factor. A `read_*` function call (or Postgres-style
/// TVF) whose first positional arg is a literal path in `path_to_ref` is
/// replaced with `TableFactor::Table { name: "ref".data }`. A derived
/// subquery is recursed. Other shapes are left as-is.
fn rewrite_table_factor(factor: &mut TableFactor, path_to_ref: &HashMap<String, String>) {
    match factor {
        TableFactor::Function {
            name, args, alias, ..
        } => {
            if let Some(ref_name) = try_match_read_function(name, args, path_to_ref) {
                *factor = catalog_table_factor(&ref_name, alias.clone());
            }
        }
        TableFactor::Table {
            name,
            args: Some(tvf),
            alias,
            ..
        } => {
            if let Some(ref_name) = try_match_read_function(name, &tvf.args, path_to_ref) {
                *factor = catalog_table_factor(&ref_name, alias.clone());
            }
        }
        // `TABLE(read_csv_auto('path'))` — the expr wraps the read_* call.
        // Without this arm the file is staged + ATTACHed + registered (path
        // extraction covers TableFunction), but the SQL retains the original
        // read_* — provenance misses it and resume breaks (issue #439 AC1).
        TableFactor::TableFunction {
            expr: Expr::Function(func),
            alias,
        } => {
            let args: &[FunctionArg] = match &func.args {
                FunctionArguments::List(list) => &list.args,
                _ => &[],
            };
            if let Some(ref_name) = try_match_read_function(&func.name, args, path_to_ref) {
                *factor = catalog_table_factor(&ref_name, alias.clone());
            }
        }
        TableFactor::Derived { subquery, .. } => {
            rewrite_query(subquery.as_mut(), path_to_ref);
        }
        _ => {}
    }
}

/// If the function/table name is a `read_*` file function and its first
/// positional arg is a literal path in `path_to_ref`, return the mapped
/// reference name. Otherwise return `None`.
fn try_match_read_function(
    name: &ObjectName,
    args: &[FunctionArg],
    path_to_ref: &HashMap<String, String>,
) -> Option<String> {
    if !is_file_function(&name.to_string()) {
        return None;
    }
    for arg in args {
        if let FunctionArg::Unnamed(arg_expr) = arg {
            if let FunctionArgExpr::Expr(sqlparser::ast::Expr::Value(
                sqlparser::ast::Value::SingleQuotedString(s),
            )) = arg_expr
            {
                return path_to_ref.get(s).cloned();
            }
            // Non-literal first positional — not a match.
            return None;
        }
        // Named arg before any positional — skip (the path is positional).
    }
    None
}

/// Build a `TableFactor::Table` for the catalog reference `"ref".data`,
/// preserving the original table alias if present (e.g. `FROM read_csv_auto(
/// 'path') AS t` rewrites to `FROM "ref".data AS t`).
fn catalog_table_factor(ref_name: &str, alias: Option<TableAlias>) -> TableFactor {
    TableFactor::Table {
        name: ObjectName(vec![Ident::with_quote('"', ref_name), Ident::new("data")]),
        alias,
        args: None,
        with_hints: Vec::new(),
        version: None,
        with_ordinality: false,
        partitions: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(paths: &[(&str, &str)]) -> HashMap<String, String> {
        paths
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn rewrite_replaces_from_read_csv_with_catalog_ref() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT * FROM read_csv_auto('{path}')");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_preserves_non_tool_output_read_calls() {
        // A read_csv_auto whose path is NOT in path_to_ref is left untouched.
        let sql = "SELECT * FROM read_csv_auto('/other/path.csv')";
        let rewritten = rewrite_sql(sql, &map(&[])).unwrap();
        assert!(
            rewritten.contains("read_csv_auto"),
            "non-derived read_* preserved: {rewritten}"
        );
    }

    #[test]
    fn rewrite_handles_cte() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("WITH t AS (SELECT * FROM read_csv_auto('{path}')) SELECT * FROM t");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref in CTE: {rewritten}"
        );
    }

    #[test]
    fn rewrite_handles_subquery() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT * FROM (SELECT * FROM read_csv_auto('{path}')) x");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref in subquery: {rewritten}"
        );
    }

    #[test]
    fn rewrite_handles_union() {
        let p1 = "/tmp/tool_output/a.csv";
        let p2 = "/tmp/tool_output/b.csv";
        let sql = format!(
            "SELECT * FROM read_csv_auto('{p1}') UNION ALL SELECT * FROM read_csv_auto('{p2}')"
        );
        let rewritten = rewrite_sql(&sql, &map(&[(p1, "a"), (p2, "b")])).unwrap();
        assert!(
            rewritten.contains(r#""a".data"#),
            "first branch: {rewritten}"
        );
        assert!(
            rewritten.contains(r#""b".data"#),
            "second branch: {rewritten}"
        );
    }

    #[test]
    fn rewrite_strips_read_options() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT * FROM read_csv_auto('{path}', header=true, compression='gzip')");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref replaces entire call: {rewritten}"
        );
        assert!(
            !rewritten.contains("header"),
            "options stripped: {rewritten}"
        );
    }

    #[test]
    fn rewrite_preserves_join_with_catalog_ref() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!(r#"SELECT * FROM "people".data JOIN read_csv_auto('{path}') ON TRUE"#);
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""people".data"#),
            "existing catalog ref preserved: {rewritten}"
        );
        assert!(
            rewritten.contains(r#""data".data"#),
            "derived catalog ref present: {rewritten}"
        );
    }

    #[test]
    fn is_in_tool_output_matches_canonicalized_prefix() {
        let temp = TempDir::new().unwrap();
        let dir = temp.path().join("tool_output");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("x.csv"), "x").unwrap();
        std::fs::write(dir.join("sub").join("y.csv"), "y").unwrap();

        assert!(is_in_tool_output(
            &dir.join("x.csv").to_string_lossy(),
            &dir
        ));
        assert!(is_in_tool_output(
            &dir.join("sub").join("y.csv").to_string_lossy(),
            &dir
        ));
        // A sibling directory with a similar name is NOT a match.
        let other = temp.path().join("tool_output_evil");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("x.csv"), "x").unwrap();
        assert!(!is_in_tool_output(
            &other.join("x.csv").to_string_lossy(),
            &dir
        ));
    }

    #[test]
    fn is_in_tool_output_rejects_dotdot_traversal() {
        let temp = TempDir::new().unwrap();
        let dir = temp.path().join("tool_output");
        std::fs::create_dir_all(&dir).unwrap();
        // A file outside tool_output but reachable via ..
        let secret = temp.path().join("secret.csv");
        std::fs::write(&secret, "s").unwrap();
        let traversal = format!("{}/../secret.csv", dir.to_string_lossy());
        assert!(
            !is_in_tool_output(&traversal, &dir),
            "traversal path must be rejected"
        );
    }

    #[test]
    fn is_in_tool_output_rejects_nonexistent_path() {
        let temp = TempDir::new().unwrap();
        let dir = temp.path().join("tool_output");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!is_in_tool_output(
            &dir.join("nonexistent.csv").to_string_lossy(),
            &dir
        ));
    }

    #[test]
    fn catalog_table_factor_renders_correctly() {
        let f = catalog_table_factor("my_data", None);
        let rendered = match &f {
            TableFactor::Table { name, .. } => name.to_string(),
            _ => panic!("expected Table"),
        };
        assert_eq!(rendered, r#""my_data".data"#);
    }

    #[test]
    fn rewrite_preserves_table_alias() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT t.* FROM read_csv_auto('{path}') AS t WHERE t.id > 0");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present: {rewritten}"
        );
        assert!(rewritten.contains("AS t"), "alias preserved: {rewritten}");
    }

    #[test]
    fn rewrite_handles_table_function_form() {
        // `TABLE(read_csv_auto('path'))` parses as TableFactor::TableFunction,
        // distinct from the bare `read_csv_auto('path')` Function form. Without
        // the TableFunction arm in rewrite_table_factor, the catalog rewrite is
        // skipped — provenance misses the source and resume breaks (issue #439).
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT t.* FROM TABLE(read_csv_auto('{path}')) AS t");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
        assert!(rewritten.contains("AS t"), "alias preserved: {rewritten}");
    }

    // --- Integration: process() with real DuckDB + filesystem ----------

    use crate::session::materializer::TurnDeps;
    use crate::workingset::WorkingSet;
    use duckdb::Connection;
    use std::collections::HashMap;
    use tempfile::TempDir;

    /// Full process(): a CSV in tool_output/ is detected, copy_in'd, ATTACHed,
    /// registered, and the SQL rewritten to a catalog reference. The rewritten
    /// SQL can then be executed on the connection and returns the data.
    #[test]
    fn process_detects_and_persists_tool_output_csv() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();

        // Simulate an external MCP tool writing a CSV.
        let csv_path = tool_output_dir.join("data.csv");
        std::fs::write(&csv_path, "id,name\n1,alice\n2,bob\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy()
        );

        {
            let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path());
            let rewritten = process(&sql, &mut deps).expect("process succeeds");

            // SQL was rewritten to a catalog reference.
            assert!(
                rewritten.contains(r#""data".data"#),
                "catalog ref present: {rewritten}"
            );
            assert!(
                !rewritten.contains("read_csv_auto"),
                "read_csv_auto removed: {rewritten}"
            );

            // Source was registered in the working set.
            let d = ws.get("data").expect("derived source registered");
            assert_eq!(d.row_count, 2);
            assert!(!d.fingerprint.is_empty(), "fingerprint computed");
            // source_path points to the staging dir (not the tool_output path).
            assert!(
                d.source_path.contains("derived"),
                "staged in derived/: {}",
                d.source_path
            );

            // Source snapshot is in source_files.
            assert!(sources.contains_key("data"), "snapshot in source_files");

            // The rewritten SQL executes on the connection and returns data.
            let count: i64 = conn
                .query_row(&rewritten, [], |r| r.get::<_, i64>(0))
                .unwrap_or_else(|_| {
                    // If the simple SELECT fails (column index), try a COUNT.
                    let count_sql = format!("SELECT COUNT(*) FROM ({rewritten}) AS _check");
                    conn.query_row(&count_sql, [], |r| r.get(0))
                        .expect("rewritten SQL executes")
                });
            assert!(count > 0, "rewritten SQL returns data");
        }
    }

    /// A non-tool_output read_* path is left unchanged — process() returns
    /// the original SQL and registers nothing.
    #[test]
    fn process_leaves_non_tool_output_paths_untouched() {
        let temp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_csv = outside.path().join("external.csv");
        std::fs::write(&outside_csv, "x\n1\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            outside_csv.to_string_lossy()
        );

        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path());
        let rewritten = process(&sql, &mut deps).expect("process succeeds");

        // SQL unchanged — no tool_output paths detected.
        assert_eq!(rewritten, sql, "non-tool_output SQL unchanged");
        assert!(ws.list().is_empty(), "nothing registered");
        assert!(sources.is_empty(), "no snapshots");
    }

    /// SQL with no read_* at all passes through unchanged.
    #[test]
    fn process_passes_through_sql_with_no_reads() {
        let temp = TempDir::new().unwrap();
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();

        let sql = "SELECT 1 AS x";
        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path());
        let rewritten = process(sql, &mut deps).expect("process succeeds");
        assert_eq!(rewritten, "SELECT 1 AS x");
    }

    /// A path inside tool_output but escaping via `..` is rejected by
    /// canonicalization — process() leaves it unchanged for preflight's
    /// FsAcl to catch (C1 security fix).
    #[test]
    fn process_rejects_dotdot_traversal_in_tool_output() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();
        // A file outside tool_output but reachable via ..
        let secret = temp.path().join("secret.csv");
        std::fs::write(&secret, "id\n999\n").unwrap();
        let traversal = format!("{}/../secret.csv", tool_output_dir.to_string_lossy());

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();

        let sql = format!("SELECT * FROM read_csv_auto('{traversal}')");
        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path());
        let rewritten = process(&sql, &mut deps).expect("process succeeds");

        // SQL unchanged — traversal path rejected by is_in_tool_output.
        assert_eq!(rewritten, sql, "traversal path not rewritten");
        assert!(ws.list().is_empty(), "nothing registered");
    }

    /// Multi-file SQL where the second file has an unsupported format:
    /// process() returns Err and rolls back the first file's registration.
    #[test]
    fn process_rolls_back_on_partial_failure() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();

        // First file: valid CSV.
        let csv_path = tool_output_dir.join("data.csv");
        std::fs::write(&csv_path, "id,name\n1,alice\n2,bob\n").unwrap();
        // Second file: unsupported format (.foo).
        let foo_path = tool_output_dir.join("bad.foo");
        std::fs::write(&foo_path, "garbage").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}') UNION ALL SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy(),
            foo_path.to_string_lossy()
        );

        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path());
        let result = process(&sql, &mut deps);

        assert!(result.is_err(), "process fails on unsupported format");
        // Rollback: first file's registration was removed.
        assert!(
            ws.list().is_empty(),
            "working set rolled back, got: {:?}",
            ws.list()
        );
        assert!(
            sources.is_empty(),
            "source_files rolled back, got: {:?}",
            sources
        );
    }
}
