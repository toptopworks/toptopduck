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
    Expr, FunctionArg, FunctionArgExpr, FunctionArguments, GroupByExpr, Ident, ObjectName, Query,
    Select, SelectItem, SetExpr, Statement, TableAlias, TableFactor, TableWithJoins,
};
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;

use crate::guardrail::{ExecError, ExecErrorKind};
use crate::ingest::schema::quote_ident;
use crate::ingest::{self, loader};
use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
use crate::session::materializer::{CachedDerivedRef, TurnDeps};
use crate::session::TOOL_OUTPUT_DIR_NAME;
use crate::tools::read_paths::{extract_read_paths, is_file_function};

/// Subdirectory under `temp_path` for staging derived source files when no
/// `.duck` is bound (ADR-0087 D4). Files here are migrated to the per-session
/// directory's `assets/` subdirectory on `bind_duck` (ADR-0089). Lifecycle
/// follows the TempDir RAII (cleaned on session drop).
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

        // Session-level dedup (issue #440): if this tool_output file was
        // already staged + registered in a prior materialize call, reuse the
        // existing catalog ref. Skip stage + copy_in + ATTACH + register.
        // Two invalidation checks keep the cache honest:
        //   1. The ref still exists in the working set (user delete between
        //      calls drops it; release_snapshot also proactively invalidates).
        //   2. The file fingerprint matches (mtime + size) — a tool that
        //      overwrites the same path with new content invalidates the
        //      snapshot (review H1).
        if let Some(cached) = deps.tool_output_refs.get(*path_str).cloned() {
            let ref_live = deps.working_set.get(&cached.ref_name).is_some();
            let content_fresh = ref_live && cached.file_matches(Path::new(path_str));

            if ref_live && content_fresh {
                path_to_ref.insert(path_str.to_string(), cached.ref_name);
                continue;
            }

            // Drop stale entry — either the ref was removed (user delete) or
            // the file was overwritten since first registration (content
            // drift). Re-register below.
            log::warn!(
                target: "toptopduck::session",
                "derived-source cache stale for {path_str}: {}",
                if ref_live { "file content changed since registration" }
                else { "ref no longer in working set" }
            );
            deps.tool_output_refs.remove(*path_str);
        }

        let src_path = Path::new(path_str);
        let ref_name = match ingest::derive_reference_name(src_path) {
            Some(base) => deps.working_set.deconflict(&base),
            None => deps.working_set.deconflict("derived"),
        };

        match process_one_derived(src_path, &ref_name, &staging_dir, deps) {
            Ok(()) => {
                deps.tool_output_refs.insert(
                    path_str.to_string(),
                    CachedDerivedRef::new(ref_name.clone(), src_path),
                );
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
                    // Remove from session cache — the ref was just rolled back.
                    deps.tool_output_refs.retain(|_, v| v.ref_name != *prev);
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

/// Rewrite `sql` by replacing each `read_*('path')` call whose path is in
/// `path_to_ref` with the corresponding catalog reference (`"ref".data`).
/// FROM-clause table factors are rewritten to `"ref".data`; scalar `read_*`
/// calls in projection / WHERE / GROUP BY / HAVING / QUALIFY / ORDER BY
/// expressions are rewritten to `(SELECT t FROM "ref".data t LIMIT 1)`
/// (issue #441). A `read_*` whose path is NOT in `path_to_ref` is left
/// untouched.
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

/// Walk a `Query` recursively, rewriting `read_*` calls in its body + each
/// CTE + ORDER BY expressions. Mirrors `read_paths::walk_query` so every
/// position the extractor visits is also rewritten.
fn rewrite_query(query: &mut Query, path_to_ref: &HashMap<String, String>) {
    if let Some(with) = &mut query.with {
        for cte in &mut with.cte_tables {
            rewrite_query(cte.query.as_mut(), path_to_ref);
        }
    }
    rewrite_set_expr(query.body.as_mut(), path_to_ref);
    if let Some(order_by) = &mut query.order_by {
        for ord in &mut order_by.exprs {
            rewrite_expr(&mut ord.expr, path_to_ref);
        }
    }
}

/// Walk a set-expression: a SELECT (rewrite its FROM + scalar `read_*` in
/// projection / WHERE / GROUP BY / HAVING / QUALIFY), a set-op (recurse
/// both branches), a nested query (recurse), or a values list (rewrite row
/// expressions).
///
/// The scalar-expression rewrite (issue #441) complements the FROM-clause
/// rewrite: `SELECT read_csv_auto('path')` or `WHERE id IN (SELECT id FROM
/// read_csv_auto('path'))` are detected by `extract_read_paths` and staged by
/// `process()`, but the FROM walker never touches them. Without the scalar
/// rewrite, provenance misses the reference and resume breaks when
/// `tool_output` is cleared.
fn rewrite_set_expr(expr: &mut SetExpr, path_to_ref: &HashMap<String, String>) {
    match expr {
        SetExpr::Select(select) => {
            for twj in &mut select.from {
                rewrite_table_with_joins(twj, path_to_ref);
            }
            // Scalar read_* in projection / selection / group_by / having.
            for item in &mut select.projection {
                if let SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } = item
                {
                    rewrite_expr(e, path_to_ref);
                }
            }
            if let Some(sel) = &mut select.selection {
                rewrite_expr(sel, path_to_ref);
            }
            if let GroupByExpr::Expressions(exprs, _) = &mut select.group_by {
                for g in exprs {
                    rewrite_expr(g, path_to_ref);
                }
            }
            if let Some(having) = &mut select.having {
                rewrite_expr(having, path_to_ref);
            }
            if let Some(qualify) = &mut select.qualify {
                rewrite_expr(qualify, path_to_ref);
            }
        }
        SetExpr::SetOperation { left, right, .. } => {
            rewrite_set_expr(left.as_mut(), path_to_ref);
            rewrite_set_expr(right.as_mut(), path_to_ref);
        }
        SetExpr::Query(query) => rewrite_query(query.as_mut(), path_to_ref),
        SetExpr::Values(values) => {
            for row in &mut values.rows {
                for e in row {
                    rewrite_expr(e, path_to_ref);
                }
            }
        }
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

/// Recursively walk an `Expr` tree, replacing scalar `read_*('path')` calls
/// whose path is in `path_to_ref` with an equivalent catalog-reference
/// subquery (issue #441). A table-function call like `read_csv_auto('path')`
/// used in scalar position returns the first row as a struct; the rewrite
/// replaces it with `(SELECT t FROM "ref".data t LIMIT 1)` which returns the
/// same first-row struct from the catalog reference.
///
/// This walker mirrors `read_paths::walk_expr` in coverage but mutates
/// in-place instead of collecting. Subqueries are recursed via `rewrite_query`
/// so a `read_*` in a nested FROM is caught by the FROM walker, not here.
fn rewrite_expr(expr: &mut Expr, path_to_ref: &HashMap<String, String>) {
    // Check if this node itself is a matching scalar read_* call.
    if let Expr::Function(func) = expr {
        let args: &[FunctionArg] = match &func.args {
            FunctionArguments::List(list) => &list.args,
            _ => &[],
        };
        if let Some(ref_name) = try_match_read_function(&func.name, args, path_to_ref) {
            *expr = scalar_subquery_for_ref(&ref_name);
            return;
        }
    }

    // Recurse into child expressions.
    rewrite_expr_children(expr, path_to_ref);
}

/// Descend into every child `Expr` of `expr`, applying [`rewrite_expr`].
/// Covers the same variant set as `read_paths::walk_expr` so a `read_*`
/// nested at any depth in the expression tree is found and replaced.
fn rewrite_expr_children(expr: &mut Expr, path_to_ref: &HashMap<String, String>) {
    match expr {
        Expr::Function(func) => {
            if let FunctionArguments::List(list) = &mut func.args {
                for arg in &mut list.args {
                    if let FunctionArg::Unnamed(FunctionArgExpr::Expr(e))
                    | FunctionArg::Named {
                        arg: FunctionArgExpr::Expr(e),
                        ..
                    } = arg
                    {
                        rewrite_expr(e, path_to_ref);
                    }
                }
            }
            if let Some(f) = &mut func.filter {
                rewrite_expr(f, path_to_ref);
            }
        }

        Expr::UnaryOp { expr, .. } | Expr::Cast { expr, .. } => {
            rewrite_expr(expr, path_to_ref);
        }
        Expr::Extract { expr, .. } | Expr::Ceil { expr, .. } | Expr::Floor { expr, .. } => {
            rewrite_expr(expr, path_to_ref);
        }
        Expr::Collate { expr, .. } => {
            rewrite_expr(expr, path_to_ref);
        }

        Expr::IsFalse(e)
        | Expr::IsNotFalse(e)
        | Expr::IsTrue(e)
        | Expr::IsNotTrue(e)
        | Expr::IsNull(e)
        | Expr::IsNotNull(e)
        | Expr::IsUnknown(e)
        | Expr::IsNotUnknown(e)
        | Expr::Nested(e)
        | Expr::OuterJoin(e)
        | Expr::Prior(e) => rewrite_expr(e, path_to_ref),

        Expr::BinaryOp { left, right, .. } => {
            rewrite_expr(left, path_to_ref);
            rewrite_expr(right, path_to_ref);
        }
        Expr::IsDistinctFrom(a, b) | Expr::IsNotDistinctFrom(a, b) => {
            rewrite_expr(a, path_to_ref);
            rewrite_expr(b, path_to_ref);
        }
        Expr::Position { expr, r#in, .. } => {
            rewrite_expr(expr, path_to_ref);
            rewrite_expr(r#in, path_to_ref);
        }

        Expr::InList { expr, list, .. } => {
            rewrite_expr(expr, path_to_ref);
            for e in list {
                rewrite_expr(e, path_to_ref);
            }
        }
        Expr::Between {
            expr, low, high, ..
        } => {
            rewrite_expr(expr, path_to_ref);
            rewrite_expr(low, path_to_ref);
            rewrite_expr(high, path_to_ref);
        }
        Expr::Like { expr, pattern, .. }
        | Expr::ILike { expr, pattern, .. }
        | Expr::SimilarTo { expr, pattern, .. }
        | Expr::RLike { expr, pattern, .. } => {
            rewrite_expr(expr, path_to_ref);
            rewrite_expr(pattern, path_to_ref);
        }
        Expr::Substring {
            expr,
            substring_from,
            substring_for,
            ..
        } => {
            rewrite_expr(expr, path_to_ref);
            if let Some(e) = substring_from {
                rewrite_expr(e, path_to_ref);
            }
            if let Some(e) = substring_for {
                rewrite_expr(e, path_to_ref);
            }
        }
        Expr::Trim {
            expr,
            trim_what,
            trim_characters,
            ..
        } => {
            rewrite_expr(expr, path_to_ref);
            if let Some(e) = trim_what {
                rewrite_expr(e, path_to_ref);
            }
            if let Some(chars) = trim_characters {
                for e in chars {
                    rewrite_expr(e, path_to_ref);
                }
            }
        }
        Expr::Tuple(exprs) => {
            for e in exprs {
                rewrite_expr(e, path_to_ref);
            }
        }
        Expr::Case {
            operand,
            conditions,
            results,
            else_result,
        } => {
            if let Some(e) = operand {
                rewrite_expr(e, path_to_ref);
            }
            for e in conditions {
                rewrite_expr(e, path_to_ref);
            }
            for e in results {
                rewrite_expr(e, path_to_ref);
            }
            if let Some(e) = else_result {
                rewrite_expr(e, path_to_ref);
            }
        }

        // Subqueries — recurse via rewrite_query so the FROM walker catches
        // any read_* inside the nested query body.
        Expr::Subquery(query) => rewrite_query(query.as_mut(), path_to_ref),
        Expr::Exists { subquery, .. } | Expr::InSubquery { subquery, .. } => {
            rewrite_query(subquery.as_mut(), path_to_ref);
        }
        Expr::InUnnest { expr, .. } => rewrite_expr(expr, path_to_ref),

        Expr::CompositeAccess { expr, .. }
        | Expr::Subscript { expr, .. }
        | Expr::Named { expr, .. }
        | Expr::Convert { expr, .. } => rewrite_expr(expr, path_to_ref),
        Expr::JsonAccess { value, .. } => rewrite_expr(value, path_to_ref),
        Expr::MapAccess { column, .. } => rewrite_expr(column, path_to_ref),

        Expr::AtTimeZone {
            timestamp,
            time_zone,
        } => {
            rewrite_expr(timestamp, path_to_ref);
            rewrite_expr(time_zone, path_to_ref);
        }
        Expr::Overlay {
            expr,
            overlay_what,
            overlay_from,
            overlay_for,
        } => {
            rewrite_expr(expr, path_to_ref);
            rewrite_expr(overlay_what, path_to_ref);
            rewrite_expr(overlay_from, path_to_ref);
            if let Some(e) = overlay_for {
                rewrite_expr(e, path_to_ref);
            }
        }

        Expr::Struct { values, .. } => {
            for e in values {
                rewrite_expr(e, path_to_ref);
            }
        }
        Expr::Dictionary(fields) => {
            for f in fields {
                rewrite_expr(&mut f.value, path_to_ref);
            }
        }
        Expr::Map(map) => {
            for entry in &mut map.entries {
                rewrite_expr(&mut entry.key, path_to_ref);
                rewrite_expr(&mut entry.value, path_to_ref);
            }
        }
        Expr::Array(arr) => {
            for e in &mut arr.elem {
                rewrite_expr(e, path_to_ref);
            }
        }
        Expr::Lambda(lambda) => rewrite_expr(&mut lambda.body, path_to_ref),

        // Leaves and rare/dialect-specific variants: no children to walk.
        _ => {}
    }
}

/// Build an `Expr::Subquery` equivalent to a scalar `read_*('path')` call:
/// `(SELECT t FROM "ref".data t LIMIT 1)`. Returns the first row as a
/// struct via the table alias `t`, matching DuckDB's scalar-position
/// semantics for table functions (issue #441).
fn scalar_subquery_for_ref(ref_name: &str) -> Expr {
    let select = Select {
        distinct: None,
        top: None,
        top_before_distinct: false,
        projection: vec![SelectItem::UnnamedExpr(Expr::Identifier(Ident::new("t")))],
        into: None,
        from: vec![TableWithJoins {
            relation: catalog_table_factor(
                ref_name,
                Some(TableAlias {
                    name: Ident::new("t"),
                    columns: vec![],
                }),
            ),
            joins: vec![],
        }],
        lateral_views: vec![],
        prewhere: None,
        selection: None,
        group_by: GroupByExpr::Expressions(vec![], vec![]),
        cluster_by: vec![],
        distribute_by: vec![],
        sort_by: vec![],
        having: None,
        named_window: vec![],
        qualify: None,
        window_before_qualify: false,
        value_table_mode: None,
        connect_by: None,
    };

    Expr::Subquery(Box::new(Query {
        with: None,
        body: Box::new(SetExpr::Select(Box::new(select))),
        order_by: None,
        limit: Some(Expr::Value(sqlparser::ast::Value::Number(
            "1".to_string(),
            false,
        ))),
        limit_by: vec![],
        offset: None,
        fetch: None,
        locks: vec![],
        for_clause: None,
        settings: None,
        format_clause: None,
    }))
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

    // --- Scalar read_* rewrite (issue #441) -----------------------------

    #[test]
    fn rewrite_replaces_scalar_read_in_projection() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT read_csv_auto('{path}')");
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
    fn rewrite_replaces_scalar_read_in_where() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT 1 FROM t WHERE length(read_csv_auto('{path}')) > 0");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present in WHERE: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_group_by() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!(
            "SELECT count(*) FROM read_csv_auto('{path}') GROUP BY read_csv_auto('{path}')"
        );
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        // FROM clause rewrite + scalar GROUP BY rewrite — both present.
        let ref_count = rewritten.matches(r#""data".data"#).count();
        assert!(
            ref_count >= 2,
            "catalog ref appears in both FROM and GROUP BY: {rewritten} (found {ref_count})"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto fully removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_having() {
        let path = "/tmp/tool_output/data.csv";
        let sql = format!(
            "SELECT count(*) FROM read_csv_auto('{path}') GROUP BY id HAVING count(read_csv_auto('{path}')) > 0"
        );
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto fully removed from HAVING: {rewritten}"
        );
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_subquery_expression() {
        // A read_* inside a scalar subquery in the projection.
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT (SELECT count(*) FROM read_csv_auto('{path}'))");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present in subquery: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_preserves_non_matching_scalar_read() {
        // A read_* whose path is NOT in path_to_ref is left untouched.
        let sql = "SELECT read_csv_auto('/other/path.csv')";
        let rewritten = rewrite_sql(sql, &map(&[])).unwrap();
        assert!(
            rewritten.contains("read_csv_auto"),
            "non-derived read_* preserved: {rewritten}"
        );
    }

    #[test]
    fn rewrite_scalar_strips_read_options() {
        // read_csv_auto with options after the path — the scalar call is
        // replaced wholesale (options stripped, same as FROM rewrite).
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT read_csv_auto('{path}', header=true)");
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
    fn rewrite_scalar_in_mixed_from_and_projection() {
        // Same file referenced in both FROM (table factor) and SELECT
        // (scalar) — both positions are rewritten.
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT read_csv_auto('{path}') FROM read_csv_auto('{path}')");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            !rewritten.contains("read_csv_auto"),
            "all read_csv_auto removed: {rewritten}"
        );
        let ref_count = rewritten.matches(r#""data".data"#).count();
        assert!(
            ref_count >= 2,
            "catalog ref in both projection and FROM: {rewritten} (found {ref_count})"
        );
    }

    #[test]
    fn rewrite_scalar_in_union_branches() {
        // Scalar read_* in one UNION branch, table-factor read_* in the other.
        let path = "/tmp/tool_output/data.csv";
        let sql = format!(
            "SELECT read_csv_auto('{path}') UNION ALL SELECT * FROM read_csv_auto('{path}')"
        );
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            !rewritten.contains("read_csv_auto"),
            "all read_csv_auto removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_order_by() {
        // ORDER BY expressions are walked by rewrite_query, mirroring
        // walk_query in read_paths.rs (review I2).
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT 1 ORDER BY length(read_csv_auto('{path}'))");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present in ORDER BY: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_qualify() {
        // QUALIFY clause is walked by rewrite_set_expr, mirroring
        // walk_set_expr in read_paths.rs (review I3).
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT * FROM read_csv_auto('{path}') QUALIFY row_number() OVER () = 1");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed from QUALIFY: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_values() {
        // VALUES row expressions are walked by rewrite_set_expr, mirroring
        // walk_set_expr in read_paths.rs (review I4).
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT * FROM (VALUES (read_csv_auto('{path}')))");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present from VALUES: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed from VALUES: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_exists() {
        // EXISTS subquery — exercises Expr::Exists branch.
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT 1 WHERE EXISTS (SELECT count(*) FROM read_csv_auto('{path}'))");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present in EXISTS: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_in_subquery() {
        // IN-subquery — exercises Expr::InSubquery branch.
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT 1 WHERE 1 IN (SELECT count(*) FROM read_csv_auto('{path}'))");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present in IN-subquery: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
    }

    #[test]
    fn rewrite_replaces_scalar_read_in_nested_wrappers() {
        // Multi-level wrapper recursion: read_* nested three levels deep.
        let path = "/tmp/tool_output/data.csv";
        let sql = format!("SELECT length(coalesce(read_csv_auto('{path}'), NULL))");
        let rewritten = rewrite_sql(&sql, &map(&[(path, "data")])).unwrap();
        assert!(
            rewritten.contains(r#""data".data"#),
            "catalog ref present through nested wrappers: {rewritten}"
        );
        assert!(
            !rewritten.contains("read_csv_auto"),
            "read_csv_auto removed: {rewritten}"
        );
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
        let mut refs = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy()
        );

        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
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
        let mut refs = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            outside_csv.to_string_lossy()
        );

        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
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
        let mut refs = HashMap::new();

        let sql = "SELECT 1 AS x";
        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
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
        let mut refs = HashMap::new();

        let sql = format!("SELECT * FROM read_csv_auto('{traversal}')");
        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
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
        let mut refs = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}') UNION ALL SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy(),
            foo_path.to_string_lossy()
        );

        let mut deps = TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
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
        assert!(
            refs.is_empty(),
            "session cache invalidated on rollback, got: {:?}",
            refs
        );
    }

    // --- Cross-call dedup (issue #440) ---------------------------------------

    /// The same tool_output file referenced in two process() calls reuses the
    /// existing catalog ref — no `data_2` suffix variant is created (AC #1).
    #[test]
    fn process_reuses_catalog_ref_across_calls() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();

        let csv_path = tool_output_dir.join("data.csv");
        std::fs::write(&csv_path, "id,name\n1,alice\n2,bob\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy()
        );

        // First call: registers "data", populates session cache.
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("first process succeeds");
            assert!(
                rewritten.contains(r#""data".data"#),
                "first call: catalog ref present: {rewritten}"
            );
        }

        // Second call: must reuse "data", NOT create "data_2".
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("second process succeeds");
            assert!(
                rewritten.contains(r#""data".data"#),
                "second call: reuses same catalog ref: {rewritten}"
            );
            assert!(
                !rewritten.contains(r#""data_2""#),
                "second call: no deconflict suffix: {rewritten}"
            );
        }

        // Only one source registered (no "data_2").
        assert_eq!(
            ws.list().len(),
            1,
            "exactly one derived source, got: {:?}",
            ws.list()
        );
        assert!(sources.contains_key("data"), "snapshot in source_files");
        assert!(
            !sources.contains_key("data_2"),
            "no duplicate snapshot: {:?}",
            sources.keys().collect::<Vec<_>>()
        );
        // Session cache has the mapping.
        let cached = refs
            .get(&csv_path.to_string_lossy().to_string())
            .expect("session cache has entry");
        assert_eq!(cached.ref_name, "data", "session cache maps path to ref");
    }

    /// Different tool_output files in separate calls each get their own ref —
    /// the cache only deduplicates the same path (AC #3).
    #[test]
    fn process_does_not_dedup_different_files() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();

        let csv_a = tool_output_dir.join("a.csv");
        std::fs::write(&csv_a, "id\n1\n").unwrap();
        let csv_b = tool_output_dir.join("b.csv");
        std::fs::write(&csv_b, "id\n2\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();

        // First call: file a → ref "a".
        {
            let sql = format!("SELECT * FROM read_csv_auto('{}')", csv_a.to_string_lossy());
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("first process succeeds");
            assert!(rewritten.contains(r#""a".data"#), "first: {rewritten}");
        }

        // Second call: file b → ref "b" (different path, no reuse).
        {
            let sql = format!("SELECT * FROM read_csv_auto('{}')", csv_b.to_string_lossy());
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("second process succeeds");
            assert!(rewritten.contains(r#""b".data"#), "second: {rewritten}");
        }

        assert_eq!(ws.list().len(), 2, "two distinct sources registered");
        assert!(sources.contains_key("a"), "ref a in source_files");
        assert!(sources.contains_key("b"), "ref b in source_files");
    }

    /// No duplicate ATTACH on the admin connection when the same file is
    /// referenced in a second call (AC #2). DuckDB refuses a duplicate ATTACH
    /// alias with an error, so if process() re-ATTACHed, the rewritten SQL
    /// execution would fail.
    #[test]
    fn no_duplicate_attach_across_calls() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();

        let csv_path = tool_output_dir.join("data.csv");
        std::fs::write(&csv_path, "id,name\n1,alice\n2,bob\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy()
        );

        // First call stages + ATTACHes "data".
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("first process succeeds");
            // Execute the rewritten SQL to confirm ATTACH landed.
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM ({rewritten}) AS _c"),
                    [],
                    |r| r.get(0),
                )
                .expect("first rewritten SQL executes");
            assert_eq!(count, 2);
        }

        // Second call: must NOT re-ATTACH. The rewritten SQL still executes
        // because the existing ATTACH is reused.
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("second process succeeds");
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM ({rewritten}) AS _c"),
                    [],
                    |r| r.get(0),
                )
                .expect("second rewritten SQL executes — no duplicate ATTACH");
            assert_eq!(count, 2);
        }
    }

    /// If the source registered by a first call is removed (simulating a user
    /// delete) before a second call references the same file, the stale cache
    /// entry is dropped and the file is re-registered under a fresh ref — not
    /// silently reused as a dangling catalog name (HIGH-1 regression guard).
    #[test]
    fn process_re_registers_after_source_removal() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();

        let csv_path = tool_output_dir.join("data.csv");
        std::fs::write(&csv_path, "id,name\n1,alice\n2,bob\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy()
        );

        // First call registers "data".
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            process(&sql, &mut deps).expect("first process succeeds");
        }
        assert_eq!(refs.len(), 1, "cache populated");

        // Simulate user delete: remove from working set + DETACH + source_files.
        // The cache entry is left in place so the second process() call
        // exercises the defensive stale-entry removal (derived_source.rs
        // lines 104-105) — the ref is gone from the working set, so the cache
        // must detect this and re-register rather than trusting a dangling name.
        let _ = conn.execute_batch("DETACH \"data\"");
        sources.remove("data");
        ws.remove("data");

        // Second call: re-registers "data" (not a dangling reuse).
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("second process succeeds");
            assert!(
                rewritten.contains(r#""data".data"#),
                "re-registered under same base name: {rewritten}"
            );
            // The rewritten SQL must execute (the new ATTACH is live).
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM ({rewritten}) AS _c"),
                    [],
                    |r| r.get(0),
                )
                .expect("re-registered SQL executes");
            assert_eq!(count, 2);
        }
        assert!(
            sources.contains_key("data"),
            "re-registered in source_files"
        );
        assert_eq!(refs.len(), 1, "cache repopulated");
    }

    /// If the underlying tool_output file is overwritten between materialize
    /// calls, the cache must detect the content drift (mtime + size mismatch)
    /// and re-stage the new content — not silently reuse the stale snapshot
    /// (review H1 regression guard).
    #[test]
    fn process_re_registers_after_content_drift() {
        let temp = TempDir::new().unwrap();
        let tool_output_dir = temp.path().join(TOOL_OUTPUT_DIR_NAME);
        std::fs::create_dir_all(&tool_output_dir).unwrap();

        let csv_path = tool_output_dir.join("data.csv");
        std::fs::write(&csv_path, "id,name\n1,alice\n2,bob\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();

        let sql = format!(
            "SELECT * FROM read_csv_auto('{}')",
            csv_path.to_string_lossy()
        );

        // First call: registers "data" with 2 rows.
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("first process succeeds");
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM ({rewritten}) AS _c"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 2);
        }
        assert_eq!(refs.len(), 1, "cache populated");

        // Overwrite the file with different content + different row count.
        std::fs::write(&csv_path, "id,name\n3,carol\n4,dave\n5,eve\n").unwrap();

        // Second call: must detect content drift and re-stage, NOT reuse the
        // stale snapshot. The rewritten SQL must return the NEW row count.
        {
            let mut deps =
                TurnDeps::test_deps(&conn, &mut ws, &mut sources, temp.path(), &mut refs);
            let rewritten = process(&sql, &mut deps).expect("second process succeeds");
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM ({rewritten}) AS _c"),
                    [],
                    |r| r.get(0),
                )
                .expect("re-staged SQL executes");
            assert_eq!(count, 3, "re-staged with new content, not stale snapshot");
        }
    }
}
