//! Detect `read_*` file-function calls in a tool's SQL and extract their
//! literal path arguments (ADR-0080, issue #293), so the gateway whitelist
//! ([`crate::fs_acl`]) can classify each path before execution and surface an
//! out-of-bounds path as a structured tool error (ADR-0077).
//!
//! The sole file-reachability constraint (ADR-0088): the FsAcl whitelist is
//! the only mechanism guarding `read_*` paths -- the engine-level
//! `disabled_filesystems` lockdown was removed so DuckDB can read in-bounds
//! files (external-tool output, session temp). The CTAS wrapping still bars
//! mutating statements (DROP/INSERT/COPY/ATTACH/INSTALL/LOAD), narrowing the
//! in-SELECT file surface to `read_*` functions. This extractor classifies
//! each call: a literal path is validated by FsAcl; a non-literal (dynamic)
//! path is flagged for preflight refusal, because FsAcl cannot validate a
//! runtime-computed path (ADR-0088 Decision 3).
//!
//! Residual risk (ADR-0088 Why 4): a `read_*` call this walk does not
//! reach -- a rare expression variant in an unhandled AST node -- is not
//! detected. Under the non-adversarial threat model (ADR-0080) and per-session
//! instance isolation (ADR-0027), this is accepted; the walker's coverage
//! improves incrementally with sqlparser upgrades.
//!
//! What counts as a file function: any function whose final name segment
//! starts with `read_` (case-insensitive) -- covers `read_csv` /
//! `read_csv_auto` / `read_parquet` / `read_json` / `read_json_auto` /
//! `read_blob` / `read_text` / `read_text_auto` -- plus `sniff_csv`, which
//! also opens a file. Statement-form file access (COPY/ATTACH/INSTALL/LOAD)
//! never reaches here; the CTAS wrapping bars it at the engine.

use sqlparser::ast::{
    Expr, FunctionArg, FunctionArgExpr, FunctionArguments, Query, SetExpr, Statement, TableFactor,
};
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;

/// The result of scanning SQL for `read_*` file-function calls.
///
/// `paths` holds every literal path argument found, in source order. Each
/// entry is the path string verbatim as the agent supplied it; the caller
/// ([`crate::fs_acl::FsAcl`]) resolves and classifies it.
///
/// `non_literal_read_found` is set when a `read_*` / `sniff_csv` call was
/// detected but its first positional argument was not a literal string -- a
/// dynamic path FsAcl cannot validate. The preflight refuses such calls
/// (ADR-0088 Decision 3) so a non-literal `read_*` never reaches the engine
/// unconstrained.
pub(crate) struct ReadPathAnalysis {
    pub paths: Vec<String>,
    pub non_literal_read_found: bool,
}

/// Scan SQL for `read_*` file-function calls. See [`ReadPathAnalysis`].
///
/// Returns `Err(())` when the SQL cannot be parsed -- the preflight refuses
/// such SQL rather than letting it reach the engine with zero path analysis
/// (ADR-0088 Why 4: sqlparser and DuckDB's own parser have different dialect
/// coverage, so a parse failure does not guarantee DuckDB will also reject).
pub(crate) fn extract_read_paths(sql: &str) -> Result<ReadPathAnalysis, ()> {
    let Ok(statements) = Parser::parse_sql(&DuckDbDialect {}, sql) else {
        return Err(());
    };
    let mut out = ReadPathAnalysis {
        paths: Vec::new(),
        non_literal_read_found: false,
    };
    for stmt in &statements {
        // Only a SELECT-shaped statement can run inside the explore/materialize
        // CTAS wrap; anything else is barred at the engine. Walk queries only.
        if let Statement::Query(query) = stmt {
            walk_query(query, &mut out);
        }
    }
    Ok(out)
}

/// Walk a Query: its WITH/CTE bodies, its body set-expression, and its
/// ORDER BY expressions (read_* in ORDER BY is exotic but cheap to cover).
fn walk_query(query: &Query, out: &mut ReadPathAnalysis) {
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            walk_query(cte.query.as_ref(), out);
        }
    }
    walk_set_expr(query.body.as_ref(), out);
    if let Some(order_by) = &query.order_by {
        for ord in &order_by.exprs {
            walk_expr(&ord.expr, out);
        }
    }
}

/// Walk a set-expression: a SELECT (projection / FROM / WHERE / GROUP BY /
/// HAVING / QUALIFY), a set-op (recurse both branches), or a nested query.
fn walk_set_expr(expr: &SetExpr, out: &mut ReadPathAnalysis) {
    match expr {
        SetExpr::Select(select) => {
            use sqlparser::ast::{GroupByExpr, SelectItem};
            for item in &select.projection {
                if let SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } = item
                {
                    walk_expr(e, out);
                }
            }
            for twj in &select.from {
                walk_table_with_joins(twj, out);
            }
            if let Some(sel) = &select.selection {
                walk_expr(sel, out);
            }
            if let GroupByExpr::Expressions(exprs, _) = &select.group_by {
                for g in exprs {
                    walk_expr(g, out);
                }
            }
            if let Some(having) = &select.having {
                walk_expr(having, out);
            }
            if let Some(qualify) = &select.qualify {
                walk_expr(qualify, out);
            }
        }
        SetExpr::SetOperation { left, right, .. } => {
            walk_set_expr(left.as_ref(), out);
            walk_set_expr(right.as_ref(), out);
        }
        SetExpr::Query(query) => walk_query(query.as_ref(), out),
        SetExpr::Values(values) => {
            for row in &values.rows {
                for e in row {
                    walk_expr(e, out);
                }
            }
        }
        _ => {}
    }
}

/// Walk a relation + its joins' table factors. read_* most commonly appears
/// here as a table function (`FROM read_csv_auto('x')`).
fn walk_table_with_joins(twj: &sqlparser::ast::TableWithJoins, out: &mut ReadPathAnalysis) {
    walk_table_factor(&twj.relation, out);
    for join in &twj.joins {
        walk_table_factor(&join.relation, out);
    }
}

/// Walk one table factor. The three shapes a read_* call can take in FROM:
/// `TableFactor::Function` (`FROM read_csv_auto('x')`),
/// `TableFactor::Table { args: Some }` (Postgres-style TVF), and
/// `TableFactor::TableFunction` (`TABLE(read_csv_auto('x'))`). A derived
/// subquery is recursed.
fn walk_table_factor(factor: &TableFactor, out: &mut ReadPathAnalysis) {
    match factor {
        TableFactor::Function { name, args, .. } => {
            collect_if_read_function(&name.to_string(), args.iter(), out);
        }
        TableFactor::Table {
            name,
            args: Some(tvf),
            ..
        } => {
            collect_if_read_function(&name.to_string(), tvf.args.iter(), out);
        }
        TableFactor::TableFunction { expr, .. } => walk_expr(expr, out),
        TableFactor::Derived { subquery, .. } => walk_query(subquery.as_ref(), out),
        _ => {}
    }
}

/// Recursively walk an expression, collecting any `read_*` literal path and
/// descending into every sub-expression position a `read_*` could hide in.
/// Rare variants fall to the `_ => {}` arm -- accepted residual risk under the
/// non-adversarial threat model (ADR-0088 Why 4).
fn walk_expr(expr: &Expr, out: &mut ReadPathAnalysis) {
    match expr {
        // Leaves -- no sub-expressions, no function call.
        Expr::Identifier(_)
        | Expr::CompoundIdentifier(_)
        | Expr::Value(_)
        | Expr::Wildcard
        | Expr::QualifiedWildcard(_) => {}

        Expr::Function(func) => {
            let args = function_args(func);
            collect_if_read_function(&func.name.to_string(), args.iter(), out);
            // Recurse into the call's own arguments so a nested read_* (e.g.
            // read_csv_auto(read_text('x'))) is still caught.
            for arg in args {
                if let FunctionArgExpr::Expr(e) = arg_arg(arg) {
                    walk_expr(e, out);
                }
            }
            // DuckDB FILTER (WHERE ...) clause -- a scalar read_* (read_text /
            // read_blob) hiding in the predicate is caught.
            if let Some(f) = &func.filter {
                walk_expr(f, out);
            }
        }

        // Single-child expression wrappers.
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
        | Expr::Prior(e) => walk_expr(e, out),

        Expr::UnaryOp { expr, .. } | Expr::Cast { expr, .. } => walk_expr(expr, out),
        Expr::Extract { expr, .. } | Expr::Ceil { expr, .. } | Expr::Floor { expr, .. } => {
            walk_expr(expr, out)
        }
        Expr::Collate { expr, .. } => walk_expr(expr, out),

        // Two-child wrappers.
        Expr::IsDistinctFrom(a, b) | Expr::IsNotDistinctFrom(a, b) => {
            walk_expr(a, out);
            walk_expr(b, out);
        }
        Expr::BinaryOp { left, right, .. } => {
            walk_expr(left, out);
            walk_expr(right, out);
        }
        Expr::Position { expr, r#in, .. } => {
            walk_expr(expr, out);
            walk_expr(r#in, out);
        }

        // List-shaped wrappers.
        Expr::InList { expr, list, .. } => {
            walk_expr(expr, out);
            for e in list {
                walk_expr(e, out);
            }
        }
        Expr::Between {
            expr, low, high, ..
        } => {
            walk_expr(expr, out);
            walk_expr(low, out);
            walk_expr(high, out);
        }
        Expr::Like { expr, pattern, .. }
        | Expr::ILike { expr, pattern, .. }
        | Expr::SimilarTo { expr, pattern, .. }
        | Expr::RLike { expr, pattern, .. } => {
            walk_expr(expr, out);
            walk_expr(pattern, out);
        }
        Expr::Substring {
            expr,
            substring_from,
            substring_for,
            ..
        } => {
            walk_expr(expr, out);
            if let Some(e) = substring_from {
                walk_expr(e, out);
            }
            if let Some(e) = substring_for {
                walk_expr(e, out);
            }
        }
        Expr::Trim {
            expr,
            trim_what,
            trim_characters,
            ..
        } => {
            walk_expr(expr, out);
            if let Some(e) = trim_what {
                walk_expr(e, out);
            }
            if let Some(chars) = trim_characters {
                for e in chars {
                    walk_expr(e, out);
                }
            }
        }
        Expr::Tuple(exprs) => {
            for e in exprs {
                walk_expr(e, out);
            }
        }
        Expr::Case {
            operand,
            conditions,
            results,
            else_result,
        } => {
            if let Some(e) = operand {
                walk_expr(e, out);
            }
            for e in conditions {
                walk_expr(e, out);
            }
            for e in results {
                walk_expr(e, out);
            }
            if let Some(e) = else_result {
                walk_expr(e, out);
            }
        }

        // Subqueries -- recurse into the nested query (where a read_* could
        // appear in its own FROM/projection).
        Expr::Subquery(query) => walk_query(query.as_ref(), out),
        Expr::Exists { subquery, .. } | Expr::InSubquery { subquery, .. } => {
            walk_query(subquery.as_ref(), out)
        }
        Expr::InUnnest { expr, .. } => walk_expr(expr, out),

        // DuckDB-native + dialect access forms carrying one Expr child a
        // read_* could hide behind (composite field access, JSON/map lookup,
        // subscripted column, named/converted arg). The subscript's index
        // expression itself is left as an accepted residual risk
        // (ADR-0088 Why 4); the indexed object is still walked.
        Expr::CompositeAccess { expr, .. }
        | Expr::Subscript { expr, .. }
        | Expr::Named { expr, .. }
        | Expr::Convert { expr, .. } => walk_expr(expr, out),
        Expr::JsonAccess { value, .. } => walk_expr(value, out),
        Expr::MapAccess { column, .. } => walk_expr(column, out),

        // Multi-child wrappers.
        Expr::AtTimeZone {
            timestamp,
            time_zone,
        } => {
            walk_expr(timestamp, out);
            walk_expr(time_zone, out);
        }
        Expr::Overlay {
            expr,
            overlay_what,
            overlay_from,
            overlay_for,
        } => {
            walk_expr(expr, out);
            walk_expr(overlay_what, out);
            walk_expr(overlay_from, out);
            if let Some(e) = overlay_for {
                walk_expr(e, out);
            }
        }

        // DuckDB literal collections: a read_* nested in a struct / map /
        // array literal or a lambda body is caught by recursing each element.
        Expr::Struct { values, .. } => {
            for e in values {
                walk_expr(e, out);
            }
        }
        Expr::Dictionary(fields) => {
            for f in fields {
                walk_expr(&f.value, out);
            }
        }
        Expr::Map(map) => {
            for entry in &map.entries {
                walk_expr(&entry.key, out);
                walk_expr(&entry.value, out);
            }
        }
        Expr::Array(arr) => {
            for e in &arr.elem {
                walk_expr(e, out);
            }
        }
        Expr::Lambda(lambda) => walk_expr(&lambda.body, out),

        // Rare / dialect-specific variants: best-effort skip. A read_* in one of
        // these is an accepted residual risk (ADR-0088 Why 4); only the
        // structured guidance is lost.
        _ => {}
    }
}

/// The argument list of a [`sqlparser::ast::Function`] as a slice of
/// [`FunctionArg`], or an empty slice for the no-parenthesis / subquery forms.
fn function_args(func: &sqlparser::ast::Function) -> &[FunctionArg] {
    match &func.args {
        FunctionArguments::List(list) => &list.args,
        _ => &[],
    }
}

/// The inner [`FunctionArgExpr`] of a [`FunctionArg`] (Named or Unnamed).
fn arg_arg(arg: &FunctionArg) -> &FunctionArgExpr {
    match arg {
        FunctionArg::Unnamed(a) | FunctionArg::Named { arg: a, .. } => a,
    }
}

/// If `name` is a read_* / sniff_csv file function, extract the literal path
/// from its first POSITIONAL (`Unnamed`) argument and push it. DuckDB file
/// functions take the path positionally; named options that follow
/// (`compression='gzip'`, `delim='|'`, ...) are never paths. Scan to the
/// first positional: a literal string there is the path; anything else (a
/// dynamic `col` ref, a sub-expression, a list arg) is a non-literal path
/// that flags [`ReadPathAnalysis::non_literal_read_found`] for preflight
/// refusal -- FsAcl cannot validate a runtime-computed path (ADR-0088
/// Decision 1). Do NOT keep scanning past the first positional: later named
/// options' string values are not paths, and mis-reading one would feed the
/// ACL a fabricated path (ADR-0077).
fn collect_if_read_function<'a>(
    name: &str,
    args: impl Iterator<Item = &'a FunctionArg>,
    out: &mut ReadPathAnalysis,
) {
    if !is_file_function(name) {
        return;
    }
    for arg in args {
        // The first positional arg decides: literal-string -> the path;
        // anything else -> non-literal, flag for refusal. Stop scanning
        // regardless: later named options are never paths.
        if let FunctionArg::Unnamed(_) = arg {
            if let FunctionArgExpr::Expr(Expr::Value(sqlparser::ast::Value::SingleQuotedString(
                s,
            ))) = arg_arg(arg)
            {
                out.paths.push(s.clone());
            } else {
                out.non_literal_read_found = true;
            }
            return;
        }
    }
    // No positional arg found (all named, or no args at all): a file function
    // the extractor cannot confidently classify. Flag for refusal rather than
    // letting an unrecognized arg pattern reach the engine unconstrained.
    out.non_literal_read_found = true;
}

/// True when `name` (the rendered function call name, possibly dotted) names a
/// DuckDB file-reading function. Matches the final segment case-insensitively
/// against the `read_*` family and `sniff_csv`.
fn is_file_function(name: &str) -> bool {
    // `name` renders as e.g. `read_csv_auto` or `catalog.read_csv_auto`; the
    // final segment is the function itself.
    let last = name
        .rsplit_once('.')
        .map(|(_, last)| last)
        .unwrap_or(name)
        .to_ascii_lowercase();
    last.starts_with("read_") || last == "sniff_csv"
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A read_* table function in FROM yields its literal path. This is the
    /// common form an agent would use and the form the AC #4 escape tests take.
    #[test]
    fn extracts_read_csv_auto_path_from_from() {
        let result = extract_read_paths("SELECT * FROM read_csv_auto('/etc/passwd')").unwrap();
        assert_eq!(result.paths, vec!["/etc/passwd".to_string()]);
        assert!(!result.non_literal_read_found);
    }

    /// A scalar read_* in the projection is also caught -- a read_text /
    /// read_blob call does not need a FROM to reach a file.
    #[test]
    fn extracts_scalar_read_text_path_from_projection() {
        let result = extract_read_paths("SELECT read_text('/etc/passwd')").unwrap();
        assert_eq!(result.paths, vec!["/etc/passwd".to_string()]);
    }

    /// A read_* nested in WHERE is caught -- the recursion covers the predicate.
    #[test]
    fn extracts_read_path_from_where() {
        let result =
            extract_read_paths("SELECT 1 FROM t WHERE length(read_blob('/secret')) > 0").unwrap();
        assert_eq!(result.paths, vec!["/secret".to_string()]);
    }

    /// A read_* inside a subquery in FROM is caught via the derived-subquery
    /// recursion -- the agent cannot hide a file read behind a subquery alias.
    #[test]
    fn extracts_read_path_from_subquery() {
        let result =
            extract_read_paths("SELECT * FROM (SELECT * FROM read_parquet('/secret.pq')) x")
                .unwrap();
        assert_eq!(result.paths, vec!["/secret.pq".to_string()]);
    }

    /// A read_* inside a CTE is caught via the WITH recursion.
    #[test]
    fn extracts_read_path_from_cte() {
        let result = extract_read_paths(
            "WITH t AS (SELECT * FROM read_csv_auto('/data.csv')) SELECT * FROM t",
        )
        .unwrap();
        assert_eq!(result.paths, vec!["/data.csv".to_string()]);
    }

    /// A UNION of two read_* branches yields both paths, in source order.
    #[test]
    fn extracts_both_branches_of_a_union() {
        let result = extract_read_paths(
            "SELECT * FROM read_csv_auto('/a.csv') UNION ALL SELECT * FROM read_csv_auto('/b.csv')",
        )
        .unwrap();
        assert_eq!(
            result.paths,
            vec!["/a.csv".to_string(), "/b.csv".to_string()]
        );
    }

    /// A function name that merely contains "read" but is not a read_* (e.g.
    /// `bread_crumbs`) is NOT matched -- only a final segment starting with
    /// `read_` is, so analytics helpers are not false-positive file functions.
    #[test]
    fn non_file_function_is_not_matched() {
        let result = extract_read_paths("SELECT bread_count('x') FROM t").unwrap();
        assert!(
            result.paths.is_empty(),
            "non-read_* function not matched: {:?}",
            result.paths
        );
        assert!(!result.non_literal_read_found);
    }

    /// A non-literal (dynamic) read_* path flags `non_literal_read_found`. The
    /// preflight refuses it with a structured error directing the agent to use
    /// a literal path string (ADR-0088 Why 4); no path is fabricated.
    #[test]
    fn dynamic_read_path_flags_non_literal() {
        let result = extract_read_paths("SELECT * FROM read_csv_auto(col)").unwrap();
        assert!(
            result.paths.is_empty(),
            "dynamic path not fabricated: {:?}",
            result.paths
        );
        assert!(
            result.non_literal_read_found,
            "non-literal read_* must be flagged"
        );
    }

    /// SQL the parser cannot understand is refused (fail-closed): the preflight
    /// rejects it rather than letting it reach the engine with zero path
    /// analysis (ADR-0088 Why 4 -- sqlparser and DuckDB diverge on dialects).
    #[test]
    fn unparseable_sql_is_refused() {
        assert!(extract_read_paths("this is not sql at all").is_err());
    }

    /// A read_* with a dotted/catalog-qualified name still matches on its final
    /// segment.
    #[test]
    fn dotted_function_name_matches_on_final_segment() {
        let result =
            extract_read_paths("SELECT * FROM catalog.read_csv_auto('/etc/hosts')").unwrap();
        assert_eq!(result.paths, vec!["/etc/hosts".to_string()]);
    }

    /// sniff_csv also opens a file, so it is matched like the read_* family.
    #[test]
    fn sniff_csv_is_a_file_function() {
        assert!(is_file_function("sniff_csv"));
        assert!(is_file_function("READ_CSV_AUTO"));
        assert!(is_file_function("catalog.read_parquet"));
        assert!(!is_file_function("generate_series"));
        assert!(!is_file_function("count"));
    }

    /// A SQL with no file functions yields no paths -- the common explore case
    /// (catalog references only) produces nothing for the ACL to classify.
    #[test]
    fn no_file_functions_yields_no_paths() {
        let result =
            extract_read_paths(r#"SELECT id, COUNT(*) FROM "people".data GROUP BY id"#).unwrap();
        assert!(result.paths.is_empty());
        assert!(!result.non_literal_read_found);
    }

    /// A read_* with named options after the path extracts ONLY the positional
    /// path arg, not a later option string. Pins ADR-0077's honest-error
    /// contract: the error must name the real path, not `compression='gzip'`.
    #[test]
    fn extracts_path_from_first_positional_ignoring_named_options() {
        let result = extract_read_paths(
            "SELECT * FROM read_csv_auto('/data.csv', header=true, compression='gzip')",
        )
        .unwrap();
        assert_eq!(result.paths, vec!["/data.csv".to_string()]);
        assert!(!result.non_literal_read_found);
    }

    /// A non-literal first positional (dynamic path) with a later named-option
    /// string does NOT mis-attribute the option value as the path. Flags
    /// non-literal for preflight refusal; no path is fabricated.
    #[test]
    fn dynamic_path_with_named_string_option_is_not_misread() {
        let result =
            extract_read_paths("SELECT * FROM read_csv_auto(col, compression='gzip')").unwrap();
        assert!(
            result.paths.is_empty(),
            "option value not misread as path: {:?}",
            result.paths
        );
        assert!(
            result.non_literal_read_found,
            "non-literal read_* must be flagged"
        );
    }

    /// A list-arg read_* (`read_csv(['/a','/b'])`) yields no paths and flags
    /// non-literal: the first positional is a list, not a literal string. The
    /// preflight refuses it (ADR-0088 Why 4); a future change to extract
    /// list elements would be intentional.
    #[test]
    fn list_arg_read_flags_non_literal() {
        let result = extract_read_paths("SELECT * FROM read_csv(['/a.csv','/b.csv'])").unwrap();
        assert!(
            result.paths.is_empty(),
            "list-arg behavior pinned: {:?}",
            result.paths
        );
        assert!(
            result.non_literal_read_found,
            "non-literal read_* must be flagged"
        );
    }

    /// A read_* nested in a DuckDB struct literal is caught via the Struct
    /// recursion -- the agent cannot hide a file read inside a struct value.
    #[test]
    fn extracts_read_path_from_struct_literal() {
        let result = extract_read_paths("SELECT {'a': read_blob('/secret')}").unwrap();
        assert_eq!(result.paths, vec!["/secret".to_string()]);
    }

    /// A read_* nested in a DuckDB array literal is caught via the Array
    /// recursion.
    #[test]
    fn extracts_read_path_from_array_literal() {
        let result = extract_read_paths("SELECT [read_text('/x'), read_text('/y')]").unwrap();
        assert_eq!(result.paths, vec!["/x".to_string(), "/y".to_string()]);
    }

    /// A scalar read_* (read_text / read_blob) inside a VALUES clause is caught
    /// via the SetExpr::Values recursion -- the walker enters every row's
    /// expression list.
    #[test]
    fn extracts_read_path_from_values_clause() {
        let result = extract_read_paths("SELECT * FROM (VALUES (read_text('/secret')))").unwrap();
        assert_eq!(result.paths, vec!["/secret".to_string()]);
    }

    /// A scalar read_* inside a FILTER (WHERE ...) clause is caught via the
    /// Function.filter recursion.
    #[test]
    fn extracts_read_path_from_filter_clause() {
        let result = extract_read_paths(
            "SELECT COUNT(*) FILTER (WHERE length(read_blob('/secret')) > 0) FROM t",
        )
        .unwrap();
        assert_eq!(result.paths, vec!["/secret".to_string()]);
    }

    /// Mixed literal + non-literal read_* in the same SQL: the non-literal
    /// flag is set (priority for preflight refusal) while the literal path is
    /// also collected. The preflight checks the flag before paths, so the whole
    /// SQL is refused.
    #[test]
    fn mixed_literal_and_non_literal_flags_non_literal() {
        let result = extract_read_paths(
            "SELECT * FROM read_csv_auto('/a.csv') UNION ALL SELECT * FROM read_csv_auto(col)",
        )
        .unwrap();
        assert!(
            result.non_literal_read_found,
            "non-literal read_* must be flagged even alongside literal paths"
        );
    }

    /// A file function with no positional arg (all named, or zero args) flags
    /// non-literal: the extractor cannot confidently classify it, so it
    /// fails closed.
    #[test]
    fn read_function_with_no_positional_arg_flags_non_literal() {
        let result = extract_read_paths("SELECT * FROM read_csv_auto(header=true)").unwrap();
        assert!(
            result.non_literal_read_found,
            "no-positional-arg must fail closed"
        );
    }
}
