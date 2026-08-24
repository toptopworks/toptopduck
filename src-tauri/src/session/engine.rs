//! Session-level admin engine, materialized on demand (ADR-0104).
//!
//! The admin engine is the in-memory DuckDB connection a session uses for
//! source ATTACH snapshots and `result_N` history (ADR-0012 / ADR-0005) -- the
//! storage body of the working set, as opposed to the per-turn sandbox
//! instances that `try_materialize` opens and discards each turn. ADR-0104
//! Decision 1 makes it an on-demand unit: open + resource caps happen together
//! at first need, through this one acquisition point, and the connection then
//! lives until session close (Decision 3: one-way transition, no idle reclaim).
//!
//! Slice #650 keeps session construction eager: materialization fires once in
//! the constructor, so observable behavior is identical to the eager
//! `Connection::open_in_memory` it replaces. Deferring materialization to the
//! first SQL need is slice #652.

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
    /// Decision 1 targets zero instances at session creation).
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
    pub(crate) fn materialize(&self) -> anyhow::Result<()> {
        if self.conn.get().is_some() {
            return Ok(());
        }
        let conn = Connection::open_in_memory()?;
        apply_resource_caps(&conn);
        // Losing a concurrent first materialization drops (closes) the loser's
        // connection and keeps the winner's. No current caller can race here:
        // every production resolution holds the session lock.
        let _ = self.conn.set(conn);
        Ok(())
    }

    /// Test convenience: construct + materialize in one step -- the eager
    /// shape every `TurnDeps` fixture wants while session construction stays
    /// eager (slice #650; the deferred-construction flip is #652).
    #[cfg(test)]
    pub(crate) fn materialized() -> Self {
        let engine = Self::new();
        engine.materialize().expect("test engine materializes");
        engine
    }

    /// Borrow the materialized connection. Panics when the engine was never
    /// materialized: session construction materializes eagerly (slice #650),
    /// so an unmaterialized engine at a consumer is a logic error, not an
    /// input condition.
    pub(crate) fn conn(&self) -> &Connection {
        self.conn
            .get()
            .expect("admin engine materialized at session construction")
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

    /// Resolution assumes the engine is materialized; reaching an
    /// unmaterialized one is a logic error (session construction materializes
    /// eagerly).
    #[test]
    #[should_panic(expected = "admin engine materialized")]
    fn conn_before_materialize_panics() {
        let _ = AdminEngine::new().conn();
    }
}
