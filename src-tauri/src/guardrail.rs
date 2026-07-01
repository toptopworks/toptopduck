//! Engine-level guardrails for LLM-generated SQL (ADR-0005). The safety
//! properties here are enforced by the DuckDB engine / configuration, NEVER by
//! parsing SQL text -- a regex over the SQL would always be bypassable, so the
//! guarantees must rest on the engine itself.
//!
//! Three layers land in this module and its callers:
//! 1. **Read-only sources** -- source Datasets are attached READ_ONLY, and the
//!    turn's SQL is always embedded as `CREATE TABLE result_N AS <query>`, so a
//!    mutating statement (DROP/ALTER/INSERT/UPDATE/DELETE) is a parser error
//!    before it can touch a source. Enforced in `session`; verified by tests.
//! 2. **Resource caps** -- `memory_limit`, `threads`, and a materialized
//!    row-count ceiling, applied as PRAGMAs / a LIMIT wrap so the engine aborts
//!    a runaway query rather than OOMing the machine.
//! 3. **Error classification** -- an execution failure is sorted into
//!    Schema/Runtime (retried -- the provider may self-correct) vs Resource
//!    (not retried -- the same SQL hits the same wall, ADR-0028).
//!
//! The filesystem-function guard (read_*/COPY/ATTACH/INSTALL/LOAD) is enforced
//! two ways. COPY/ATTACH/INSTALL/LOAD are statements, not query expressions, so
//! the `CREATE TABLE ... AS <query>` wrapping rejects them as syntax errors.
//! The remaining surface -- read_* table functions (read_csv_auto / read_parquet
//! / read_json_auto) in a SELECT -- is blocked by running provider SQL on a
//! sandboxed connection whose LocalFileSystem is disabled (see
//! `session::sandbox`); the engine's "... disabled by configuration" refusal is
//! classified [`ExecErrorKind::Resource`] (no retry).

use duckdb::Connection;

/// Why a turn's SQL execution failed, for routing through the retry budget
/// (ADR-0028). The kind decides whether the orchestrator re-attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecErrorKind {
    /// A schema mismatch (table/column does not exist). Retried -- the provider
    /// may correct the reference on a fresh attempt.
    Schema,
    /// A runtime/logic error (type conversion, divide-by-zero, etc.). Retried --
    /// the provider may rephrase the SQL.
    Runtime,
    /// A resource cap was hit (memory ceiling, result-row ceiling, or a
    /// filesystem function blocked on the sandbox's disabled LocalFileSystem --
    /// ADR-0005, issue #25). NOT retried: the same SQL would hit the same wall,
    /// so it becomes an immediate failed outcome (ADR-0005/0028).
    Resource,
    /// The turn was cancelled mid-execution (ADR-0021). NOT an execution failure
    /// at all -- routing is done by the orchestrator's cancel-flag check (which
    /// fires before the retry-routing match on this kind), so this variant never
    /// reaches the `match exec_err.kind` arm in `ask`. It exists for type-honest
    /// logging/diagnostics instead of borrowing `Resource` (a cap hit), which
    /// would conflate outcome C with outcome D. `ask` asserts the invariant with
    /// an `unreachable!` arm, so a future second caller of `try_materialize` that
    /// forgets the pre-check fails loudly instead of silently retrying a cancel.
    Cancelled,
}

/// One classified execution failure. `detail` is the honest, user-facing
/// explanation; `kind` routes retry vs abort.
#[derive(Debug, Clone)]
pub(crate) struct ExecError {
    pub kind: ExecErrorKind,
    pub detail: String,
}

impl ExecError {
    pub(crate) fn new(kind: ExecErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

/// Classify a DuckDB error message into a retry-routing kind. The duckdb crate
/// surfaces errors as unstructured `Display` strings (a single
/// `DuckDBFailure` with no typed code), so the kind is inferred from the
/// engine's stable message phrases. The classification only chooses retry vs
/// no-retry -- a misclassification still ends in a failed turn, just via the
/// other path, so the heuristic need only be good enough to spot the
/// resource-cap phrases that must NOT burn the budget.
pub(crate) fn classify_duckdb_error(detail: &str) -> ExecErrorKind {
    let lower = detail.to_ascii_lowercase();
    // Resource caps: memory ceiling / a filesystem function blocked by engine
    // configuration. These never recover on a re-run with the same SQL.
    if lower.contains("out of memory")
        || lower.contains("memory limit")
        || lower.contains("disabled by configuration")
        || lower.contains("file system operations are disabled")
    {
        return ExecErrorKind::Resource;
    }
    // Schema errors: a missing table or column. The provider can fix these.
    if lower.contains("does not exist")
        || lower.contains("not found in from clause")
        || lower.contains("referenced column")
        || lower.contains("referenced table")
    {
        return ExecErrorKind::Schema;
    }
    // Everything else (conversion errors, binder type mismatches, parser
    // errors from a statement the wrapping rejects) is treated as a runtime
    // error and retried.
    ExecErrorKind::Runtime
}

/// Hard memory ceiling per session (ADR-0005 L3). Engine-enforced: DuckDB
/// aborts a query whose intermediate state exceeds it. Conservative for a
/// desktop tool and deliberately below typical RAM so the app cannot
/// monopolize the user's memory.
pub(crate) const MEMORY_LIMIT: &str = "512MB";

/// Max worker threads a query may use (ADR-0005 L3). Caps CPU use so a heavy
/// query leaves the rest of the app responsive.
pub(crate) const MAX_THREADS: u32 = 4;

/// Default ceiling on a materialized result's row count (ADR-0005 L3). A
/// runaway cross-join that would balloon memory is aborted at this size rather
/// than OOM the machine. Distinct from the 10k DISPLAY window
/// (`session::MAX_READ_ROWS`): results up to this cap are materialized in full
/// (full export preserved, ADR-0030); only beyond it does the turn abort with a
/// resource error -- silent truncation is forbidden (ADR-0030).
pub(crate) const DEFAULT_MAX_RESULT_ROWS: u64 = 1_000_000;

/// Apply the engine-level resource caps to a connection (ADR-0005 L3).
/// Idempotent; safe on the session's main connection -- caps only bound, they
/// never enable new capability. Best-effort: if DuckDB rejects a setting the
/// warning is logged and the session continues with the engine's default
/// limits (the read-only / wrapping guarantees still hold; only the ceiling is
/// loose).
pub(crate) fn apply_resource_caps(conn: &Connection) {
    if let Err(e) = conn.execute_batch(&format!("PRAGMA memory_limit='{MEMORY_LIMIT}';")) {
        log::warn!("failed to set memory_limit guardrail: {e}");
    }
    if let Err(e) = conn.execute_batch(&format!("PRAGMA threads={MAX_THREADS};")) {
        log::warn!("failed to set threads guardrail: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_table_is_schema() {
        assert_eq!(
            classify_duckdb_error(r#"Catalog Error: Table with name ghost does not exist!"#),
            ExecErrorKind::Schema
        );
    }

    #[test]
    fn missing_column_is_schema() {
        assert_eq!(
            classify_duckdb_error(
                r#"Binder Error: Referenced column "nope" not found in FROM clause!"#
            ),
            ExecErrorKind::Schema
        );
    }

    #[test]
    fn type_conversion_is_runtime() {
        assert_eq!(
            classify_duckdb_error("Conversion Error: Could not convert string 'abc' to INT32"),
            ExecErrorKind::Runtime
        );
    }

    #[test]
    fn memory_phrases_are_resource() {
        for msg in [
            "out of memory",
            "Memory limit of 512MB exceeded",
            "file system operations are disabled by configuration",
        ] {
            assert_eq!(
                classify_duckdb_error(msg),
                ExecErrorKind::Resource,
                "msg={msg}"
            );
        }
    }

    #[test]
    fn unknown_phrases_default_to_runtime() {
        // An unrecognized engine error still routes through the retry loop.
        assert_eq!(
            classify_duckdb_error("Parser Error: syntax error at or near DROP"),
            ExecErrorKind::Runtime
        );
    }
}
