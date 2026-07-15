//! The materialize step, abstracted behind a trait (ADR-0053).
//!
//! "Execute provider SQL on a locked-down sandbox + install result_N onto
//! admin + derive its shape + register the working set" is the half of a turn
//! the orchestrator (TurnRunner) decides *whether to retry*. Splitting it
//! behind [`Materializer`] lets a unit test inject a scripted
//! [`ExecErrorKind`] without touching DuckDB -- the retry / cancel / error-
//! routing logic in [`crate::session::turn_runner::TurnRunner`] becomes
//! precisely testable (Resource / StaleReference / budget exhaustion / cancel-
//! over-textual / NotWired), where the live path could only reach those
//! branches indirectly via real SQL.
//!
//! The trait is object-safe (no generics, no `Self` return) so [`TurnRunner`]
//! holds `Box<dyn Materializer>` -- dyn, not generic, so `Session` does not
//! parameterize `commands.rs` / `lib.rs` (ADR-0053 Decision 4). Live state
//! (admin connection, source paths, working set, caps) is aggregated in the
//! Session root and borrowed per turn via [`TurnDeps`]; the materializer owns
//! none of it (ADR-0053 Decision 4 -- stateless, owned by none).
//!
//! [`TurnRunner`]: crate::session::turn_runner::TurnRunner

use std::collections::HashMap;
use std::path::Path;

use duckdb::Connection;

use crate::cancel::CancelToken;
use crate::guardrail::{classify_duckdb_error, ExecError, ExecErrorKind};
use crate::ingest::schema::quote_ident;
use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
use crate::provenance;
use crate::session::{sandbox, snapshot::derive_table};
use crate::workingset::WorkingSet;

/// The shared session state a materialize step borrows (ADR-0053 Decision 4):
/// the admin connection, the source snapshot paths, the mutable working set,
/// and the two resource caps. Aggregated in the Session root and borrowed per
/// turn -- the materializer is stateless and owns none of this.
///
/// Disjoint borrows via a struct let one call site hand a materializer
/// `&mut working_set` alongside `&conn` / `&source_files` / `&temp_path`
/// without widening to `&mut Session`.
pub(crate) struct TurnDeps<'a> {
    pub conn: &'a Connection,
    pub source_files: &'a HashMap<String, std::path::PathBuf>,
    pub working_set: &'a mut WorkingSet,
    pub result_row_cap: u64,
    pub result_count_cap: usize,
    pub temp_path: &'a Path,
}

/// Execute provider SQL + materialize `result_N` + register the working set
/// (ADR-0053). The trait is object-safe: no generic methods, no `Self` return,
/// so a `Box<dyn Materializer>` lands cleanly on [`TurnRunner`] (and the
/// future Resumer) without type-parameterizing the Session.
///
/// Stateless by contract -- all live state rides `deps`. `RealMaterializer`
/// is a zero-sized struct; a test injects `FakeMaterializer` to script an
/// `ExecErrorKind` per call without touching DuckDB.
///
/// [`TurnRunner`]: crate::session::turn_runner::TurnRunner
pub(crate) trait Materializer: Send {
    /// Run the provider SQL on a locked-down sandbox, install `result_name`
    /// onto admin, derive its shape, register it in the working set, and run
    /// stale-result GC. The caller computes `result_name` (a failed attempt
    /// registers nothing, so `next_result_number` is stable across retries --
    /// ADR-0022); resume passes the recipe's recorded name verbatim so a
    /// stale gap does not renumber the live chain.
    fn try_materialize(
        &self,
        sql: &str,
        cancel: &CancelToken,
        result_name: String,
        deps: &mut TurnDeps,
    ) -> Result<DatasetDescriptor, ExecError>;
}

/// The production materializer: runs provider SQL on a locked-down sandbox,
/// installs the result on admin, derives its shape, registers it, and reclaims
/// the oldest stale results past the cap. Behavior is byte-for-byte the
/// pre-refactor `Session::try_materialize` (ADR-0053) -- this is a structural
/// move, not a semantic change. Stateless; the `RealMaterializer` value
/// carries no data and exists only to anchor the `impl`.
pub(crate) struct RealMaterializer;

impl Materializer for RealMaterializer {
    fn try_materialize(
        &self,
        sql: &str,
        cancel: &CancelToken,
        result_name: String,
        deps: &mut TurnDeps,
    ) -> Result<DatasetDescriptor, ExecError> {
        // result_N is max+1, never reused (ADR-0022). The caller computes the
        // name: the live turn path derives next_result_number per attempt (a
        // failed attempt registers nothing, so N is stable across retries);
        // resume_replay passes the recipe's recorded name verbatim so a stale
        // gap (e.g. result_1 dead, result_2 live) does not renumber the live
        // turn -- the chain recreates each result_N under its stable identity.

        // Stale-reference refusal (ADR-0013 invariant 2) + provenance record
        // (issue #40): parse the SQL once before touching the sandbox so a
        // stale reference is rejected without burning setup or retry budget.
        // The same analysis yields the dependency set recorded after a
        // successful materialize -- the cascade reads it on a later source
        // delete. Conservative parse failure (deps = all members) is recorded
        // as-is so a delete never under-cascades ("宁可多失效不漏失效").
        let deps_analysis = provenance::analyze(sql, deps.working_set);
        if let Some(stale_ref) = deps_analysis.stale_ref.as_ref() {
            // The detail carries the bare dead reference name; the "stale"
            // wording lives in the frontend locale (TurnFailure::StaleReference,
            // issue #125), interpolated from this name -- no Chinese crosses IPC.
            return Err(ExecError::new(
                ExecErrorKind::StaleReference,
                stale_ref.clone(),
            ));
        }

        // Provider SQL runs on a locked-down sandbox (ADR-0005 read_* closure):
        // a separate instance with LocalFileSystem disabled, so a read_* table
        // function is refused by the engine ("... disabled by configuration").
        // Sources are re-attached READ_ONLY (zero-copy; concurrent read-only
        // attach is allowed) and prior results are mirrored in, so the SQL
        // resolves identically to admin. Only the sandbox runs provider SQL;
        // admin runs tool-controlled DML. The sandbox is dropped at end of scope
        // (lockdown is irreversible, so it is single-use).
        let sandbox_conn = sandbox::open()?;
        sandbox::attach_sources(&sandbox_conn, deps.working_set, deps.source_files)?;
        sandbox::mirror_results(&sandbox_conn, deps.conn, deps.working_set)?;
        sandbox::lockdown(&sandbox_conn)?;

        // Register the sandbox interrupt handle so a cancel can abort THIS query
        // at source (ADR-0021 DuckDB interrupt). Scoped to the provider SQL only:
        // cleared right after the CREATE+count, so the tool-controlled
        // install/derive steps below (fast, on admin) are never disrupted by a
        // cancel -- the orchestrator's post-call flag check lands those as
        // Cancelled without touching the working set.
        cancel.set_interrupt(sandbox_conn.interrupt_handle());

        // Resource cap (ADR-0005 L3): bracket the query and LIMIT to cap+1 so a
        // runaway cross-join cannot balloon memory (DuckDB pushes LIMIT into the
        // scan, so only cap+1 rows ever materialize). The brackets make LIMIT
        // bind to the whole query output; a trailing ';' is stripped so the
        // subquery parses. Below, a count of cap+1 means the true result
        // exceeded the cap -> abort (silent truncation is forbidden, ADR-0030).
        let inner = sql.trim().trim_end_matches(';').trim_end();
        let cap_plus_one = deps.result_row_cap.saturating_add(1);
        let create_sql = format!(
            "CREATE TABLE {} AS SELECT * FROM ({inner}) AS _src LIMIT {cap_plus_one}",
            quote_ident(&result_name),
        );
        let create_outcome = sandbox_conn.execute_batch(&create_sql);
        // The provider SQL is done (success or failure) -- stop associating the
        // interrupt handle so a later cancel cannot reach this connection.
        cancel.clear_interrupt();
        if let Err(e) = create_outcome {
            // The engine rejected the CREATE on the sandbox -- a parser error
            // from a mutating statement / COPY / ATTACH the wrapping bars, a
            // read_* refusal ("disabled by configuration"), a schema error, a
            // runtime error, OR the interrupt from a cancel (surfaces as a
            // generic DuckDB failure -> Runtime here). The caller re-checks the
            // cancel flag and routes a cancel to Cancelled before any retry, so
            // the kind only chooses the non-cancel routing.
            return Err(ExecError::new(
                classify_duckdb_error(&e.to_string()),
                e.to_string(),
            ));
        }
        // Row-count governor on the sandbox: count == cap+1 -> the true result
        // exceeded the cap. Aborts as Resource; the sandbox is dropped (admin
        // untouched), so -- unlike the install/derive steps below -- no rollback
        // of result_N is needed here.
        let rows: i64 = match sandbox_conn.query_row(
            &format!("SELECT COUNT(*) FROM {}", quote_ident(&result_name)),
            [],
            |r| r.get(0),
        ) {
            Ok(rows) => rows,
            Err(e) => return Err(ExecError::new(ExecErrorKind::Runtime, e.to_string())),
        };
        if rows as u64 > deps.result_row_cap {
            return Err(ExecError::new(
                ExecErrorKind::Resource,
                format!("结果行数（{rows}）超过上限 {}", deps.result_row_cap),
            ));
        }
        // Cancel landed between the query's success and the install: the partial
        // result_N exists on the sandbox only (admin untouched), so no rollback
        // is needed -- drop the sandbox and let the caller record Cancelled. The
        // check goes after the resource governor so a genuine over-cap result is
        // not misread as a cancel. The kind is Cancelled (not Resource) so the
        // signal stays type-honest -- outcome D, not a cap hit (ADR-0028).
        if cancel.is_requested() {
            return Err(ExecError::new(
                ExecErrorKind::Cancelled,
                "查询已取消".to_string(),
            ));
        }

        // Install the new result onto admin (Value mirror). A failure can leave
        // a partial result_N on admin, so roll it back (ADR-0022 never-reused).
        if let Err(e) =
            sandbox::install_result(deps.conn, &sandbox_conn, &result_name, &result_name)
        {
            let detail = rollback_result(deps.conn, &result_name, e.detail);
            return Err(ExecError::new(ExecErrorKind::Runtime, detail));
        }

        // Derive the result's shape from admin's installed table -- the same
        // derivation a source snapshot uses (DRY). A derive failure also rolls
        // back result_N (orphan table would wedge later turns, ADR-0022).
        let shape = match derive_table(deps.conn, &result_name, deps.temp_path, &result_name) {
            Ok(shape) => shape,
            Err(e) => {
                let detail = rollback_result(deps.conn, &result_name, e.to_string());
                return Err(ExecError::new(ExecErrorKind::Runtime, detail));
            }
        };
        let descriptor = DatasetDescriptor {
            reference_name: result_name.clone(),
            display_name: result_name.clone(),
            source_path: String::new(), // derived -- no source file (ADR-0004)
            columns: shape.columns,
            row_count: shape.row_count,
            sample: shape.sample,
            fingerprint: shape.fingerprint,
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        };
        // Record the just-materialized result's provenance (issue #40,
        // ADR-0025): the dependency set the pre-check computed. The cascade
        // reads this on a later source delete to find dependents. Recorded
        // under `result_name` (stable identity) AFTER register_result, so the
        // member_names snapshot at analyze time already excluded this new
        // result -- no self-dependency. `deps_analysis.refs` was pre-intersected
        // with the then-live working set (members present at the parse moment).
        deps.working_set.register_result(descriptor.clone());
        deps.working_set
            .record_provenance(&result_name, deps_analysis.refs);

        // GC cap (ADR-0013 M=100, issue #42): if the result_N total now
        // exceeds the cap, auto-reclaim the oldest stale results. The fresh
        // result is active (stale is None), so it is never a candidate; active
        // results survive even when older than every stale result. Reclaimed
        // results keep their producing turn in the thread (visible history) --
        // only their data becomes unreferenceable.
        let reclaimed = gc_stale_results(deps);
        if !reclaimed.is_empty() {
            log::info!(
                target: "toptopduck::session",
                "GC 回收最老 stale：{}",
                reclaimed.join(", ")
            );
        }
        Ok(descriptor)
    }
}

/// Auto-reclaim the oldest stale results when the `result_N` count exceeds the
/// cap (ADR-0013, issue #42). GC runs only against stale results -- active
/// results are never auto-deleted. For each candidate: drop the physical table
/// (best-effort; an orphan from a failed DROP is harmless -- the working-set
/// removal below is the authority on "gone", and the session temp dir is wiped
/// on drop either way), then remove the registry entry (reference name +
/// result membership + provenance edge). The producing turn stays in the
/// thread. The new result's number is unaffected -- `next_result_number`
/// scans only registered results, so a GC'd number becomes a permanent hole
/// (ADR-0022). Returns the reclaimed names so the caller can log the
/// reclaim's reach.
fn gc_stale_results(deps: &mut TurnDeps) -> Vec<String> {
    let candidates = deps.working_set.gc_stale_candidates(deps.result_count_cap);
    for name in &candidates {
        let drop_sql = format!("DROP TABLE {}", quote_ident(name));
        if let Err(e) = deps.conn.execute_batch(&drop_sql) {
            // Best-effort, and deliberately warn (not error). The asymmetry
            // vs `rollback_result`'s error-grade DROP is grounded in ADR-0022:
            // rollback drops an UN-registered result_N, so an orphan makes the
            // next `next_result_number` (max over registered names) reuse N and
            // clash on CREATE -> wedge. GC drops an already-registered older
            // result_K, and the `remove` below drops it from the registry, so
            // the next number is max(remaining)+1 > K -- the orphan never
            // collides with a future CREATE. warn keeps a recurring engine
            // failure observable without overstating a non-wedging cleanup miss.
            log::warn!(
                target: "toptopduck::session",
                "GC DROP of stale {name} failed: {e}"
            );
        }
        deps.working_set.remove(name);
    }
    candidates
}

/// Drop a just-created result_N table and fold any cleanup failure into the
/// reported detail. An orphan result_N would make the next attempt's
/// `next_result_number` reuse N and clash on CREATE, wedging every later turn
/// (ADR-0022 never-reused) -- the M1 regression. Surfacing the DROP failure
/// keeps a wedged session observable instead of silently masked.
fn rollback_result(conn: &Connection, result_name: &str, detail: String) -> String {
    let drop_sql = format!("DROP TABLE {}", quote_ident(result_name));
    match conn.execute_batch(&drop_sql) {
        Ok(()) => detail,
        Err(drop_err) => {
            // Session-wedge-grade failure: an orphan result_N makes the next
            // attempt reuse N and clash on CREATE, wedging every later turn
            // (ADR-0022). Log at error so it is observable server-side, not
            // just folded into the user-facing reason string.
            log::error!(
                target: "toptopduck::session",
                "rollback DROP of {result_name} failed: {drop_err}; session may wedge on next result_N reuse (ADR-0022)"
            );
            format!(
                "{detail}; cleanup DROP of {result_name} also failed: {drop_err} (orphan table may wedge later turns)"
            )
        }
    }
}

/// Re-export so the TurnRunner unit tests can name the fake without reaching
/// into the `fake` submodule. Forward-declared before the mod (Rust resolves
/// item references after collecting the whole file); placed here rather than
/// after `mod fake` so clippy does not flag it as a post-test-module item.
#[cfg(test)]
pub(crate) use fake::FakeMaterializer;

#[cfg(test)]
mod fake {
    //! Scripted materializer stand-in (ADR-0053): mirrors
    //! `provider::fake::FakeProvider` so a TurnRunner unit test injects a
    //! precise `ExecErrorKind` (or a canned `DatasetDescriptor` on success)
    //! per call, with no DuckDB and no filesystem. Held behind `Box<dyn
    //! Materializer>` on the runner; the test reads the call count through the
    //! shared `Arc` handle (the boxed value is consumed into the runner).

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::{Materializer, TurnDeps};
    use crate::cancel::CancelToken;
    use crate::guardrail::{ExecError, ExecErrorKind};
    use crate::model::DatasetDescriptor;

    /// A scripted materializer: returns the queued results in order, clamping
    /// to the last once the queue is exhausted (mirrors `FakeProvider`'s
    /// clamp, so `[Resource]` sticks on every call -- "always Resource"). An
    /// empty queue degrades to a synthetic Runtime error so a misconfigured
    /// test never invents a success.
    pub(crate) struct FakeMaterializer {
        results: Vec<Result<DatasetDescriptor, ExecError>>,
        calls: Arc<AtomicUsize>,
    }

    impl FakeMaterializer {
        pub(crate) fn new(results: Vec<Result<DatasetDescriptor, ExecError>>) -> Self {
            Self {
                results,
                calls: Arc::new(AtomicUsize::new(0)),
            }
        }

        /// A shared handle to the call counter. Clone before boxing the fake
        /// into a runner; after `run` returns, `load` reads how many
        /// materialize attempts the retry loop made -- the assertion that
        /// distinguishes "no retry" (Resource / StaleReference) from "budget
        /// exhausted" (Runtime / Unavailable).
        #[allow(dead_code)] // used by TurnRunner tests via the handle
        pub(crate) fn calls_handle(&self) -> Arc<AtomicUsize> {
            Arc::clone(&self.calls)
        }
    }

    impl Materializer for FakeMaterializer {
        fn try_materialize(
            &self,
            _sql: &str,
            _cancel: &CancelToken,
            _result_name: String,
            deps: &mut TurnDeps,
        ) -> Result<DatasetDescriptor, ExecError> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            let idx = n.min(self.results.len().saturating_sub(1));
            match self.results.get(idx).cloned() {
                // Mirror RealMaterializer's working-set side effect so a
                // Resumer / TurnRunner unit test can assert "K-1 results
                // preserved in the working set" after a replay / turn without
                // touching DuckDB. Only register_result is mirrored -- GC +
                // provenance are not observable from the orchestration tests
                // that consume this fake, so they stay out (KISS).
                Some(Ok(descriptor)) => {
                    deps.working_set.register_result(descriptor.clone());
                    Ok(descriptor)
                }
                Some(Err(e)) => Err(e),
                None => Err(ExecError::new(ExecErrorKind::Runtime, "fake".to_string())),
            }
        }
    }
}
