//! Session-level admin engine, materialized on demand (ADR-0104).
//!
//! The admin engine is the in-memory DuckDB connection a session uses for
//! source ATTACH snapshots and `result_N` history (ADR-0012 / ADR-0005) -- the
//! storage body of the working set, as opposed to the per-turn sandbox
//! instances that `try_materialize` opens and discards each turn. ADR-0104
//! Decision 1 makes it an on-demand unit: a session is constructed with NO
//! DuckDB instance, open + resource caps happen together at the first SQL
//! need through the one acquisition point ([`AdminEngine::acquire`]), and the
//! connection then lives until session close (Decision 3: one-way transition,
//! no idle reclaim).

use std::sync::OnceLock;

use duckdb::Connection;

use crate::guardrail::apply_resource_caps;

/// The single acquisition point for a session's admin engine connection.
///
/// `duckdb::Connection` is `Send` but not `Sync`, so the unit keeps the same
/// sharing envelope as the bare field it replaces: it sits on the `Session`
/// behind its mutex, and the resolved reference never crosses threads. The
/// `OnceLock` makes the first materialization itself race-free, so resolving
/// needs no lock beyond whatever the caller already holds.
pub(crate) struct AdminEngine {
    conn: OnceLock<Connection>,
}

impl AdminEngine {
    /// An unmaterialized engine: no DuckDB instance exists yet (ADR-0104
    /// Decision 1: a session that never executes SQL stays at zero
    /// instances, zero thread pools, from creation to close).
    pub(crate) fn new() -> Self {
        Self {
            conn: OnceLock::new(),
        }
    }

    /// Materialize the engine: open the in-memory connection and apply the
    /// engine-level resource caps (ADR-0005 L3), one step (ADR-0104 Decision 1).
    /// A no-op once materialized (Decision 3: held until session close, no idle
    /// reclaim). Cap application is best-effort as before -- a rejected setting
    /// logs and the session continues with the engine's default limits.
    fn materialize(&self) -> anyhow::Result<()> {
        if self.conn.get().is_some() {
            return Ok(());
        }
        let conn = Connection::open_in_memory()?;
        apply_resource_caps(&conn);
        // First-materialization observability (PR #654 deferred note): a
        // materialization nobody expected shows up in the log instead of
        // silently re-eagering the engine at some assembly point.
        log::info!(
            target: "toptopduck::session",
            "admin engine materialized (first SQL need)"
        );
        // Losing a concurrent first materialization drops (closes) the loser's
        // connection and keeps the winner's. No current caller can race here:
        // every production resolution holds the session lock.
        let _ = self.conn.set(conn);
        Ok(())
    }

    /// Acquire the session connection, materializing the engine if this is
    /// the first SQL need (ADR-0104 Decision 2: the one rule, the one entry).
    /// Materialization failure propagates to the caller's existing error
    /// surface; once materialized this is a plain borrow of the held
    /// connection (Decision 3).
    pub(crate) fn acquire(&self) -> anyhow::Result<&Connection> {
        self.materialize()?;
        // materialize() guarantees a set connection on Ok (ours or a racing
        // winner's), so this expect is unreachable.
        Ok(self
            .conn
            .get()
            .expect("admin engine connection after materialize"))
    }

    /// Materialize + run a batch statement on the session connection. A
    /// convenience over [`Self::acquire`] for the best-effort / error-graded
    /// ATTACH / DETACH / DROP sites so they don't repeat the acquire-and-map
    /// dance; callers that reuse a live borrow (prepare / query_row / sandbox
    /// admin connection) call [`Self::acquire`] directly and bind once.
    pub(crate) fn execute_batch(&self, sql: &str) -> anyhow::Result<()> {
        self.acquire()?.execute_batch(sql)?;
        Ok(())
    }

    /// Test convenience: construct + materialize in one step -- the eager
    /// shape unit fixtures want without a Session. Session-level tests go
    /// through a real first need instead (ADR-0104 Decision 2).
    #[cfg(test)]
    pub(crate) fn materialized() -> Self {
        let engine = Self::new();
        engine.materialize().expect("test engine materializes");
        engine
    }

    /// Test-only: whether the engine has materialized. The zero-instance
    /// assertions (a session that never executes SQL stays unmaterialized)
    /// read this; production resolves through [`Self::acquire`].
    #[cfg(test)]
    pub(crate) fn is_materialized(&self) -> bool {
        self.conn.get().is_some()
    }

    /// Test-only borrow of the materialized connection. Panics when the
    /// engine was never materialized -- reaching an unmaterialized engine at
    /// a probe is a test bug (production resolves through [`Self::acquire`],
    /// which materializes instead of panicking).
    #[cfg(test)]
    pub(crate) fn conn(&self) -> &Connection {
        self.conn
            .get()
            .expect("admin engine materialized before this test borrow")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ptr;

    /// ADR-0104 Decision 1 / ADR-0005 L3: materialization opens the connection
    /// and applies the resource caps in the same step.
    #[test]
    fn materialize_opens_a_capped_connection() {
        let engine = AdminEngine::new();
        engine.materialize().expect("materialize");
        let threads: String = engine
            .conn()
            .query_row(
                "SELECT value FROM duckdb_settings() WHERE name='threads'",
                [],
                |r| r.get(0),
            )
            .expect("threads setting");
        assert_eq!(threads, crate::guardrail::MAX_THREADS.to_string());
    }

    /// ADR-0104 Decision 3: one-way transition. A second materialize must not
    /// produce a second connection -- the borrowed reference is the same one
    /// for the unit's whole life.
    #[test]
    fn rematerialize_reuses_the_same_connection() {
        let engine = AdminEngine::new();
        engine.materialize().expect("first materialize");
        let first = engine.conn();
        engine.materialize().expect("second materialize");
        assert!(ptr::eq(first, engine.conn()));
    }

    /// ADR-0104 Decision 2: acquire is the one entry -- it materializes an
    /// unmaterialized engine (the zero-instance session's first SQL need) and
    /// then borrows; a second acquire reuses the same connection.
    #[test]
    fn acquire_materializes_on_first_need_and_reuses() {
        let engine = AdminEngine::new();
        assert!(!engine.is_materialized(), "starts unmaterialized");
        let first = engine.acquire().expect("first acquire materializes");
        assert!(engine.is_materialized());
        let second = engine.acquire().expect("second acquire borrows");
        assert!(ptr::eq(first, second));
    }

    /// The test-only borrow panics on an unmaterialized engine (a probe
    /// reaching zero instances is a test bug, not an input condition).
    #[test]
    #[should_panic(expected = "admin engine materialized")]
    fn conn_before_materialize_panics() {
        let _ = AdminEngine::new().conn();
    }
}
