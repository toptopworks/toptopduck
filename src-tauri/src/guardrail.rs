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
//! / read_json_auto) in a SELECT -- is constrained by the gateway FsAcl
//! whitelist (ADR-0080 + ADR-0088): read_* literal paths are classified against
//! the session source set (read-only) + working temp dir (read-write) before
//! execution, and non-literal read_* paths are refused outright. An out-of-
//! bounds path becomes a structured, path-naming tool error the agent self-
//! corrects from (ADR-0077). See [`crate::fs_acl`] +
//! [`crate::tools::read_paths`].

use duckdb::Connection;

/// Why a materialize step's SQL execution failed (ADR-0028 heritage). On the
/// live path every kind routes back to the model as a `materialize` tool
/// error for self-correction (ADR-0077); the kind still matters for
/// type-honest diagnostics, the fs-acl structuring, and resume replay (which
/// folds the failure into the broken turn's detail, ADR-0035).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExecErrorKind {
    /// A schema mismatch (table/column does not exist). The model may correct
    /// the reference on its next call.
    Schema,
    /// A runtime/logic error (type conversion, divide-by-zero, etc.). The
    /// model may rephrase the SQL on its next call.
    Runtime,
    /// A resource cap was hit (memory ceiling, result-row ceiling). The same
    /// SQL would hit the same wall, so a
    /// model that keeps re-issuing it exhausts the step cap rather than
    /// converging (ADR-0005/0081).
    Resource,
    /// The turn was cancelled mid-execution (ADR-0021). NOT an execution
    /// failure at all -- the agent loop's cancel-flag check fires before the
    /// error is fed back, landing the whole turn as Cancelled. The variant
    /// exists for type-honest logging/diagnostics instead of borrowing
    /// `Resource` (a cap hit), which would conflate outcome C with outcome D.
    Cancelled,
    /// A provider SQL referenced a stale result_N (issue #40, ADR-0013
    /// invariant 2): a stale result may not anchor a new derivation. Routed
    /// back to the model like any tool error on the live path; resume replay
    /// breaks the chain at the referencing turn. Emitted by the provenance
    /// pre-check in `try_materialize`, never by `classify_duckdb_error` (it
    /// is not a DuckDB error -- the SQL is rejected before the engine runs
    /// it).
    StaleReference,
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
    // Resource caps: memory ceiling. These never recover on a re-run with the
    // same SQL. (The "disabled by configuration" phrases matched the removed
    // engine lockdown; kept as harmless defense-in-depth in case DuckDB emits
    // them from another context.)
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

/// Default memory ceiling per session (ADR-0005 L3). Engine-enforced: DuckDB
/// aborts a query whose intermediate state exceeds it. The DEFAULT, not a
/// hardwired ceiling: a user-tuned value arrives per session from the
/// app-config engine defaults (session-level snapshot, issue #741), with this
/// constant as the fresh-install / no-config source.
pub(crate) const MEMORY_LIMIT: &str = "512MB";

/// Default max worker threads a query may use (ADR-0005 L3). Caps CPU use so
/// a heavy query leaves the rest of the app responsive. The DEFAULT of the
/// user-adjustable app-config engine default (see [`MEMORY_LIMIT`]).
pub(crate) const MAX_THREADS: u32 = 4;

/// Default ceiling on a materialized result's row count (ADR-0005 L3). A
/// runaway cross-join that would balloon memory is aborted at this size rather
/// than OOM the machine. The DEFAULT of the user-adjustable app-config engine
/// default (see [`MEMORY_LIMIT`]); the engine-enforced memory ceiling is what
/// bounds the risk of a user-raised cap. Distinct from the 10k DISPLAY window
/// (`session::MAX_READ_ROWS`): results up to this cap are materialized in full
/// (full export preserved, ADR-0030); only beyond it does the turn abort with a
/// resource error -- silent truncation is forbidden (ADR-0030).
pub(crate) const DEFAULT_MAX_RESULT_ROWS: u64 = 1_000_000;

/// True iff `s` is a well-formed memory-limit value this crate threads into
/// the engine: `<number><unit>` over the explicit byte-multiple units
/// (case-insensitive, matching the UI's `"512MB"` idiom). The gate exists
/// because the value reaches `execute_batch` as interpolated text, so
/// anything else would loosen or break the cap instead of bounding it:
/// DuckDB parses `none` (and a leading `-`) as UNLIMITED, an embedded quote
/// or semicolon would execute as extra statements, a zero quantity is a
/// degenerate 0-byte ceiling, and bare garbage just gets the PRAGMA refused
/// -- leaving the engine on DuckDB's own default, which is looser than the
/// constants here.
pub(crate) fn is_well_formed_memory_limit(s: &str) -> bool {
    let s = s.trim();
    let split = s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len());
    let (number, unit) = s.split_at(split);
    let number = number.trim_end();
    let well_formed_number = !number.is_empty()
        && number.chars().all(|c| c.is_ascii_digit() || c == '.')
        && number.matches('.').count() <= 1
        && number.parse::<f64>().is_ok_and(|n| n > 0.0);
    let well_formed_unit = matches!(
        unit.to_ascii_lowercase().as_str(),
        "b" | "kb" | "kib" | "mb" | "mib" | "gb" | "gib" | "tb" | "tib"
    );
    well_formed_number && well_formed_unit
}

/// Apply the engine-level resource caps to a connection (ADR-0005 L3): the
/// session-level snapshot's values, threaded from the app-config engine
/// defaults at session creation (issue #741). Idempotent; safe on the
/// session's main connection -- caps only bound, they never enable new
/// capability. An ill-formed `memory_limit` never reaches DuckDB: the config
/// layer sanitizes before the value gets here, and this apply-point gate is
/// the defense-in-depth both faces share -- the value reverts to
/// [`MEMORY_LIMIT`] (the tightened default) rather than letting the engine
/// widen the cap. Best-effort beyond that: a setting DuckDB still rejects
/// (e.g. a value this build refuses) is logged and the session continues
/// with the engine's default limits (the read-only / wrapping guarantees
/// still hold; only the ceiling is loose).
pub(crate) fn apply_resource_caps(conn: &Connection, memory_limit: &str, threads: u32) {
    let memory_limit = if is_well_formed_memory_limit(memory_limit) {
        memory_limit
    } else {
        log::warn!(
            "malformed memory_limit {memory_limit:?} rejected; \
             falling back to {MEMORY_LIMIT}"
        );
        MEMORY_LIMIT
    };
    if let Err(e) = conn.execute_batch(&format!("PRAGMA memory_limit='{memory_limit}';")) {
        log::warn!("failed to set memory_limit guardrail: {e}");
    }
    if let Err(e) = conn.execute_batch(&format!("PRAGMA threads={threads};")) {
        log::warn!("failed to set threads guardrail: {e}");
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Test-only: parse DuckDB's normalized `memory_limit` display value
    /// (e.g. `"244.1 MiB"`) back into bytes. DuckDB stores `'256MB'` as
    /// 256×10⁶ bytes and REPORTS it in its own display unit, so a landed
    /// PRAGMA can only be asserted after this conversion, independent of the
    /// unit a DuckDB version happens to choose.
    pub(crate) fn parse_memory_display(s: &str) -> f64 {
        let (num, unit) = s.split_once(' ').unwrap_or((s, ""));
        let num: f64 = num.parse().unwrap_or(0.0);
        let factor = match unit.trim() {
            "GiB" => 1024.0 * 1024.0 * 1024.0,
            "GB" => 1e9,
            "MiB" => 1024.0 * 1024.0,
            "MB" => 1e6,
            "KiB" => 1024.0,
            "KB" => 1e3,
            _ => 1.0,
        };
        num * factor
    }

    /// Test-only: read the live `(memory_limit, threads)` pair off a capped
    /// connection's settings -- the shared readback both faces' cap pins use.
    pub(crate) fn read_caps(conn: &Connection) -> (String, String) {
        conn.query_row(
            "SELECT max(value) FILTER (WHERE name='memory_limit'), \
             max(value) FILTER (WHERE name='threads') \
             FROM duckdb_settings()",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("settings readback")
    }

    /// Test-only: assert a memory cap landed, at the byte level -- DuckDB
    /// reports the setting in its own display unit (see
    /// [`parse_memory_display`]), and a PRAGMA that never landed reads back
    /// as the default percentage-of-RAM instead.
    pub(crate) fn assert_memory_cap_lands(conn: &Connection, expected_bytes: f64) {
        let (memory_limit, _) = read_caps(conn);
        assert!(
            (parse_memory_display(&memory_limit) - expected_bytes).abs() < 1e5,
            "memory_limit PRAGMA lands (got {memory_limit})"
        );
    }

    #[test]
    fn memory_limit_whitelist_accepts_and_rejects() {
        for good in [
            "512MB", "244.1MiB", "1GB", "0.5TB", "1.5 GiB", "2kb", "300B", "512 MB",
        ] {
            assert!(is_well_formed_memory_limit(good), "should accept {good:?}");
        }
        // `none` / a leading `-` parse as UNLIMITED inside DuckDB; an
        // embedded quote or semicolon would execute as extra statements; a
        // zero quantity, a missing half, and units outside the explicit set
        // are out of domain.
        for bad in [
            "none",
            "null",
            "-1MB",
            "512MB'; ATTACH 'x' AS leak; --",
            "abc",
            "",
            "0MB",
            "0.0GB",
            "512",
            "MB",
            "1EB",
        ] {
            assert!(!is_well_formed_memory_limit(bad), "should reject {bad:?}");
        }
    }

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
