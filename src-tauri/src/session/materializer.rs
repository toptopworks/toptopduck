//! The materialize step, abstracted behind a trait (ADR-0053).
//!
//! "Execute provider SQL on a sandboxed instance + install result_N onto
//! admin + derive its shape + register the working set" is the promotion
//! mechanism behind the `materialize` built-in tool (ADR-0077): the agent
//! loop ([`crate::session::agent_loop::AgentLoop`]) dispatches the tool here,
//! and a tool-level [`ExecErrorKind`] routes back to the model for
//! self-correction rather than failing the turn. Splitting the step behind
//! [`Materializer`] lets a unit test inject a scripted [`ExecErrorKind`]
//! without touching DuckDB -- the resume replay + tool dispatch paths become
//! precisely testable (Resource / StaleReference / Runtime), where the live
//! path could only reach those branches indirectly via real SQL.
//!
//! The trait is object-safe (no generics, no `Self` return) so the `Session`
//! holds `Box<dyn Materializer>` -- dyn, not generic, so it does not
//! parameterize `commands.rs` / `lib.rs` (ADR-0053 Decision 4). Live state
//! (admin connection, source paths, working set, caps) is aggregated in the
//! Session root and borrowed per turn via [`TurnDeps`]; the materializer owns
//! none of it (ADR-0053 Decision 4 -- stateless, owned by none).

use std::collections::HashMap;
use std::path::Path;

use duckdb::Connection;

use crate::cancel::CancelToken;
use crate::guardrail::{ExecError, ExecErrorKind};
use crate::ingest::schema::quote_ident;
use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
use crate::sandbox_sql::{
    preflight_read_sql, run_sandboxed_read, PreflightError, SandboxDeps, SandboxExecError,
};
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
/// so a `Box<dyn Materializer>` lands cleanly on the Session -- shared by the
/// agent loop's `materialize` tool dispatch and the Resumer -- without
/// type-parameterizing it.
///
/// Stateless by contract -- all live state rides `deps`. `RealMaterializer`
/// is a zero-sized struct; a test injects `FakeMaterializer` to script an
/// `ExecErrorKind` per call without touching DuckDB.
pub(crate) trait Materializer: Send {
    /// Run the provider SQL on a sandboxed instance, install `result_name`
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

/// The production materializer: runs provider SQL on a sandboxed instance,
/// installs the result on admin, derives its shape, registers it, and reclaims
/// the oldest stale results past the cap. Structurally a move of the pre-
/// refactor `Session::try_materialize` (ADR-0053), with one behavior change in
/// #334: the path now also runs the FsAcl `read_*` whitelist (shared with
/// explore via `sandbox_sql::preflight_read_sql`), so an out-of-bounds
/// `read_*` surfaces as a structured error. Stateless; the `RealMaterializer`
/// value carries no data and exists only to anchor the `impl`.
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

        // Gateway door (ADR-0013 stale-ref + ADR-0080 read_* whitelist), shared
        // with the explore path. The materialize path also runs the FsAcl
        // whitelist (issue #334) so an out-of-bounds read_* becomes a
        // structured "outside the allowed area" error.
        // refs are held for the post-install provenance record (issue #40).
        let analysis =
            preflight_read_sql(sql, deps.working_set, deps.temp_path).map_err(|e| match e {
                PreflightError::StaleReference(s) => {
                    ExecError::new(ExecErrorKind::StaleReference, s)
                }
                PreflightError::FsAcl(s)
                | PreflightError::NonLiteralPath(s)
                | PreflightError::Unparseable(s) => ExecError::new(ExecErrorKind::Runtime, s),
            })?;

        // Sandbox lifecycle + cap + cancel checkpoints, shared with the explore
        // path. The new result_N lands on the sandbox first; the tail below
        // installs it onto admin.
        let table = run_sandboxed_read(
            sql,
            &result_name,
            &SandboxDeps {
                admin_conn: deps.conn,
                source_files: deps.source_files,
                working_set: deps.working_set,
                result_row_cap: deps.result_row_cap,
            },
            cancel,
        )
        .map_err(|e| match e {
            SandboxExecError::Cancelled => {
                ExecError::new(ExecErrorKind::Cancelled, "查询已取消".to_string())
            }
            SandboxExecError::Resource { rows, cap } => ExecError::new(
                ExecErrorKind::Resource,
                format!("结果行数（{rows}）超过上限 {cap}"),
            ),
            SandboxExecError::Runtime { kind, detail } => ExecError::new(kind, detail),
        })?;

        // Install the new result onto admin (Value mirror). A failure can leave
        // a partial result_N on admin, so roll it back (ADR-0022 never-reused).
        if let Err(e) = sandbox::install_result(deps.conn, &table.conn, &result_name, &result_name)
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
        // result -- no self-dependency. `analysis.refs` was pre-intersected
        // with the then-live working set (members present at the parse moment).
        deps.working_set.register_result(descriptor.clone());
        deps.working_set
            .record_provenance(&result_name, analysis.refs);

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

/// Re-export so the Resumer / tool-dispatch unit tests can name the fake
/// without reaching into the `fake` submodule. Forward-declared before the
/// mod (Rust resolves item references after collecting the whole file);
/// placed here rather than after `mod fake` so clippy does not flag it as a
/// post-test-module item.
#[cfg(test)]
pub(crate) use fake::FakeMaterializer;

#[cfg(test)]
mod fake {
    //! Scripted materializer stand-in (ADR-0053): mirrors
    //! `provider::fake::FakeProvider` so a Resumer / tool-dispatch unit test
    //! injects a precise `ExecErrorKind` (or a canned `DatasetDescriptor` on
    //! success) per call, with no DuckDB and no filesystem.

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
        /// Draw cursor (`Cell` for the `&self` trait signature).
        calls: std::cell::Cell<usize>,
    }

    impl FakeMaterializer {
        pub(crate) fn new(results: Vec<Result<DatasetDescriptor, ExecError>>) -> Self {
            Self {
                results,
                calls: std::cell::Cell::new(0),
            }
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
            let n = self.calls.get();
            self.calls.set(n + 1);
            let idx = n.min(self.results.len().saturating_sub(1));
            match self.results.get(idx).cloned() {
                // Mirror RealMaterializer's working-set side effect so a
                // Resumer unit test can assert "K-1 results preserved in the
                // working set" after a replay without touching DuckDB. Only
                // register_result is mirrored -- GC + provenance are not
                // observable from the tests that consume this fake, so they
                // stay out (KISS).
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
