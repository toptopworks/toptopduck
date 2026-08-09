//! Stale-cascade provenance (issue #40, ADR-0013/0025/0040).
//!
//! Parses provider SQL to extract the FROM/JOIN reference-name set a
//! materialized `result_N` depends on, and detects when that set references a
//! stale result (refused before execution, ADR-0013 invariant 2). The session
//! records the dependency set on a successful materialization so a later source
//! delete can transitively mark dependents stale; it turns a stale-reference
//! hit into an immediate Failed turn (a stale result may not anchor a new
//! derivation).
//!
//! A failed parse falls back to "depends on every current working-set member"
//! so the cascade never under-invalidates ("宁可多失效不漏失效", issue #40).
//! v1 walks the structured FROM/JOIN surface (relations, derived subqueries,
//! set-op branches, CTEs) plus scalar subqueries nested in projection / WHERE
//! / GROUP BY / HAVING expressions (issue #441). Provider SQL (ADR-0009
//! one-SQL-per-turn) overwhelmingly names its dependencies in FROM/JOIN, and
//! the conservative parse-failure fallback covers any statement this walker
//! cannot fully resolve.

use std::collections::HashSet;

use sqlparser::ast::{
    Expr, GroupByExpr, Query, SelectItem, SetExpr, Statement, TableFactor, TableWithJoins,
};
use sqlparser::dialect::DuckDbDialect;
use sqlparser::parser::Parser;

use crate::workingset::WorkingSet;

/// The analyzed outcome of a provider SQL (issue #40): the dependency set to
/// record on a successful materialization, plus any stale-reference hit the
/// session must refuse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependencies {
    /// The working-set reference names this SQL read from (FROM/JOIN targets
    /// intersected with the live working set). Conservative fallback (parse
    /// failure) yields every current member.
    pub refs: HashSet<String>,
    /// The first stale result_N this SQL referenced, if any. The session turns
    /// this into a refused turn -- stale results may not anchor new
    /// derivations (ADR-0013 invariant 2). `None` on conservative fallback: a
    /// parse failure cannot name a stale ref, and the sandbox mirror excludes
    /// stale tables so such a FROM fails at execution instead (double guard).
    pub stale_ref: Option<String>,
}

/// Analyze a provider SQL for provenance + stale-reference refusal (issue
/// #40). Pure: reads the SQL + working set, returns the dependency set + any
/// stale reference hit. The session records `refs` on a successful
/// materialization and turns `stale_ref` into an immediate Failed turn.
pub fn analyze(sql: &str, ws: &WorkingSet) -> Dependencies {
    match extract_references(sql) {
        Some(referenced) => {
            let members = ws.member_names();
            let refs: HashSet<String> = referenced.intersection(&members).cloned().collect();
            // A stale reference is refused (ADR-0013 invariant 2). Only names
            // the parse resolved AND that are registered stale results.
            let stale_ref = referenced.into_iter().find(|r| ws.is_stale(r));
            Dependencies { refs, stale_ref }
        }
        // Conservative fallback (issue #40): parse failed -> depend on every
        // current member so a delete never under-cascades. No stale check -- a
        // ref we could not parse cannot be named; the sandbox mirror excludes
        // stale tables so a FROM of one fails at execution instead.
        None => Dependencies {
            refs: ws.member_names(),
            stale_ref: None,
        },
    }
}

/// Parse `sql` and collect every table reference name (the first identifier of
/// each FROM/JOIN target, derived subquery, set-op branch, or CTE body).
/// Returns `None` on any parse error or non-SELECT top-level statement -- the
/// caller falls back to "depends on everything". The first identifier of a
/// compound name (`"people".data` -> `people`) matches the working set's
/// reference-name key; the `.data` suffix is the source-snapshot catalog tag
/// (ADR-0012), not part of the reference identity.
fn extract_references(sql: &str) -> Option<HashSet<String>> {
    let statements = Parser::parse_sql(&DuckDbDialect {}, sql).ok()?;
    let mut out = HashSet::new();
    for stmt in &statements {
        match stmt {
            Statement::Query(query) => collect_query(query, &mut out),
            // A non-SELECT provider statement the wrapping did not already bar
            // -> treat as unparseable so the conservative fallback applies.
            _ => return None,
        }
    }
    Some(out)
}

/// Collect table names from a Query: its WITH/CTE bodies (each a query) and
/// its body set-expression.
fn collect_query(query: &Query, out: &mut HashSet<String>) {
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            collect_query(cte.query.as_ref(), out);
        }
    }
    collect_set_expr(query.body.as_ref(), out);
}

/// Walk a set-expression: a SELECT (collect its FROM/JOIN targets + any
/// scalar subqueries in projection / WHERE / GROUP BY / HAVING), a set-op
/// (recurse both branches), a nested query, or a values list (no tables).
fn collect_set_expr(expr: &SetExpr, out: &mut HashSet<String>) {
    match expr {
        SetExpr::Select(select) => {
            for twj in &select.from {
                collect_table_with_joins(twj, out);
            }
            // Scalar subqueries in projection / selection / group_by / having
            // may reference catalog tables (e.g. after the derived-source
            // scalar rewrite in issue #441). Walk each expression for embedded
            // subqueries and collect their FROM-clause references.
            for item in &select.projection {
                if let SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } = item
                {
                    collect_expr_subqueries(e, out);
                }
            }
            if let Some(sel) = &select.selection {
                collect_expr_subqueries(sel, out);
            }
            if let GroupByExpr::Expressions(exprs, _) = &select.group_by {
                for g in exprs {
                    collect_expr_subqueries(g, out);
                }
            }
            if let Some(having) = &select.having {
                collect_expr_subqueries(having, out);
            }
        }
        SetExpr::SetOperation { left, right, .. } => {
            collect_set_expr(left.as_ref(), out);
            collect_set_expr(right.as_ref(), out);
        }
        SetExpr::Query(query) => collect_query(query.as_ref(), out),
        // Values + any future variant carry no table references.
        _ => {}
    }
}

/// Collect from a relation + each of its joins.
fn collect_table_with_joins(twj: &TableWithJoins, out: &mut HashSet<String>) {
    collect_table_factor(&twj.relation, out);
    for join in &twj.joins {
        collect_table_factor(&join.relation, out);
    }
}

/// Walk an expression tree looking for embedded subqueries (scalar subquery,
/// EXISTS, IN-subquery). For each subquery found, collect its FROM-clause table
/// references via [`collect_query`]. Other expression forms are not walked —
/// a direct table reference cannot appear in an expression position, so only
/// subqueries can carry one (issue #441).
fn collect_expr_subqueries(expr: &Expr, out: &mut HashSet<String>) {
    match expr {
        Expr::Subquery(query) => collect_query(query.as_ref(), out),
        Expr::Exists { subquery, .. } | Expr::InSubquery { subquery, .. } => {
            collect_query(subquery.as_ref(), out);
        }

        // Recurse into wrapper expressions that could contain a subquery at
        // any depth. Coverage mirrors derived_source::rewrite_expr_children
        // so provenance never misses a catalog ref the rewrite installed.
        Expr::Function(func) => {
            if let sqlparser::ast::FunctionArguments::List(list) = &func.args {
                for arg in &list.args {
                    if let sqlparser::ast::FunctionArg::Unnamed(
                        sqlparser::ast::FunctionArgExpr::Expr(e),
                    )
                    | sqlparser::ast::FunctionArg::Named {
                        arg: sqlparser::ast::FunctionArgExpr::Expr(e),
                        ..
                    } = arg
                    {
                        collect_expr_subqueries(e, out);
                    }
                }
            }
            if let Some(f) = &func.filter {
                collect_expr_subqueries(f, out);
            }
        }
        Expr::BinaryOp { left, right, .. } => {
            collect_expr_subqueries(left, out);
            collect_expr_subqueries(right, out);
        }
        Expr::UnaryOp { expr, .. } | Expr::Cast { expr, .. } => {
            collect_expr_subqueries(expr, out);
        }
        Expr::Nested(e) => collect_expr_subqueries(e, out),
        Expr::Case {
            operand,
            conditions,
            results,
            else_result,
        } => {
            if let Some(e) = operand {
                collect_expr_subqueries(e, out);
            }
            for e in conditions {
                collect_expr_subqueries(e, out);
            }
            for e in results {
                collect_expr_subqueries(e, out);
            }
            if let Some(e) = else_result {
                collect_expr_subqueries(e, out);
            }
        }
        Expr::InList { expr, list, .. } => {
            collect_expr_subqueries(expr, out);
            for e in list {
                collect_expr_subqueries(e, out);
            }
        }
        Expr::Between {
            expr, low, high, ..
        } => {
            collect_expr_subqueries(expr, out);
            collect_expr_subqueries(low, out);
            collect_expr_subqueries(high, out);
        }
        Expr::Like { expr, pattern, .. }
        | Expr::ILike { expr, pattern, .. }
        | Expr::SimilarTo { expr, pattern, .. }
        | Expr::RLike { expr, pattern, .. } => {
            collect_expr_subqueries(expr, out);
            collect_expr_subqueries(pattern, out);
        }
        Expr::Tuple(exprs) => {
            for e in exprs {
                collect_expr_subqueries(e, out);
            }
        }
        Expr::CompositeAccess { expr, .. }
        | Expr::Subscript { expr, .. }
        | Expr::Named { expr, .. }
        | Expr::Convert { expr, .. } => collect_expr_subqueries(expr, out),
        Expr::JsonAccess { value, .. } => collect_expr_subqueries(value, out),
        Expr::MapAccess { column, .. } => collect_expr_subqueries(column, out),
        Expr::Struct { values, .. } => {
            for e in values {
                collect_expr_subqueries(e, out);
            }
        }
        Expr::Dictionary(fields) => {
            for f in fields {
                collect_expr_subqueries(&f.value, out);
            }
        }
        Expr::Map(map) => {
            for entry in &map.entries {
                collect_expr_subqueries(&entry.key, out);
                collect_expr_subqueries(&entry.value, out);
            }
        }
        Expr::Array(arr) => {
            for e in &arr.elem {
                collect_expr_subqueries(e, out);
            }
        }
        Expr::Lambda(lambda) => collect_expr_subqueries(&lambda.body, out),

        // Leaves and rare variants: no subqueries to find.
        _ => {}
    }
}

/// Collect from one table factor: a named table (record the reference name) or
/// a derived subquery (recurse). Table functions / pivots are skipped (v1).
fn collect_table_factor(factor: &TableFactor, out: &mut HashSet<String>) {
    match factor {
        TableFactor::Table { name, .. } => {
            // The name renders as `"ref"` (ADR-0024 result form) or
            // `"ref".data` (ADR-0012 source form); the first '.'-separated
            // segment, quotes stripped, is the working-set reference name.
            // Assumes the FROM shape is at most two segments -- a catalog-
            // qualified `schema."ref".data` (3+ segments) would mis-resolve to
            // `schema`, but ADR-0012/0024 never produce that shape, so this is
            // safe today. Using Display sidesteps the ObjectName / TableObject
            // shape differences across sqlparser versions.
            let displayed = name.to_string();
            // `split` always yields >= 1 segment (even on ""), so `next()` is
            // always `Some` -- `expect` over `unwrap` to name the invariant.
            let first = displayed
                .split('.')
                .next()
                .expect("split always yields at least one segment");
            out.insert(first.trim_matches('"').to_string());
        }
        TableFactor::Derived { subquery, .. } => collect_query(subquery.as_ref(), out),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A working set with two sources + a result, for intersection checks.
    /// Mirrors the member_names the analyzer intersects against.
    fn ws_with_members(names: &[&str]) -> WorkingSet {
        use crate::model::{ColumnSchema, DatasetDescriptor};
        let mut ws = WorkingSet::default();
        for n in names {
            ws.register(DatasetDescriptor {
                reference_name: (*n).to_string(),
                display_name: (*n).to_string(),
                source_path: String::new(),
                columns: vec![ColumnSchema {
                    name: "c".into(),
                    canonical_type: "INTEGER".into(),
                }],
                row_count: 0,
                sample: vec![],
                fingerprint: String::new(),
                rectify: crate::model::RectifyProvenance::NotApplicable,
                privacy: crate::model::DatasetPrivacy::default(),
                stale: None,
            });
        }
        ws
    }

    #[test]
    fn single_source_from_records_that_source() {
        let ws = ws_with_members(&["people", "orders"]);
        let deps = analyze(r#"SELECT COUNT(*) AS n FROM "people".data"#, &ws);
        assert_eq!(deps.refs, ["people".to_string()].into_iter().collect());
        assert!(deps.stale_ref.is_none());
    }

    #[test]
    fn join_records_both_sides() {
        let ws = ws_with_members(&["people", "orders"]);
        let deps = analyze(
            r#"SELECT * FROM "people".data p JOIN "orders".data o ON p.id = o.pid"#,
            &ws,
        );
        assert_eq!(
            deps.refs,
            ["people".to_string(), "orders".to_string()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn union_records_both_branches() {
        let ws = ws_with_members(&["people", "orders"]);
        let deps = analyze(
            r#"SELECT * FROM "people".data UNION ALL SELECT * FROM "orders".data"#,
            &ws,
        );
        assert_eq!(
            deps.refs,
            ["people".to_string(), "orders".to_string()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn derived_subquery_is_walked() {
        let ws = ws_with_members(&["people", "orders"]);
        // A derived table whose subquery reads orders -- orders must be picked
        // up via the subquery walk, not just the outer FROM people.
        let deps = analyze(
            r#"SELECT * FROM "people".data JOIN (SELECT id FROM "orders".data) x ON TRUE"#,
            &ws,
        );
        assert_eq!(
            deps.refs,
            ["people".to_string(), "orders".to_string()]
                .into_iter()
                .collect()
        );
    }

    #[test]
    fn non_member_reference_is_dropped_from_deps() {
        // A name the working set does not carry (e.g. a typo, or a CTE alias
        // used as a table) is dropped -- provenance records only live members.
        let ws = ws_with_members(&["people"]);
        let deps = analyze(r#"SELECT * FROM "ghost""#, &ws);
        assert!(deps.refs.is_empty(), "non-member dropped: {:?}", deps.refs);
    }

    #[test]
    fn parse_failure_falls_back_to_all_members() {
        let ws = ws_with_members(&["people", "orders"]);
        // Garbage SQL -> None -> conservative: every member is a dependency.
        let deps = analyze("this is not sql at all", &ws);
        assert_eq!(
            deps.refs,
            ["people".to_string(), "orders".to_string()]
                .into_iter()
                .collect()
        );
        assert!(deps.stale_ref.is_none());
    }
}
