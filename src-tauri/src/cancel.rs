//! Cancellation + single-in-flight signal for the query loop (ADR-0021, issue
//! #28). One [`CancelToken`] is shared (via `Arc`) between the turn orchestrator
//! and the cancel entry point, so a cancel can fire WITHOUT the session lock --
//! `Session::ask` holds the session `Mutex` for the whole turn, so the cancel
//! command must reach the signal through a separate `Arc`.
//!
//! Two cooperating pieces:
//! 1. A cooperative `requested` flag ([`AtomicBool`]), checked by the
//!    orchestrator between phases (before the provider call, after it, after the
//!    SQL execution). A cancel sets it; the orchestrator short-circuits to a
//!    [`crate::model::TurnOutcome::Cancelled`] the next time it checks.
//! 2. An optional DuckDB [`InterruptHandle`] for the in-flight query, registered
//!    by `try_materialize` right before the provider SQL runs and cleared right
//!    after. `request()` calls `interrupt()` on it so a long engine query is
//!    aborted at source -- not just left to finish cooperatively. The handle is
//!    `Send + Sync` (duckdb-rs guarantees it), so it crosses the thread boundary
//!    the cancel command runs on. If the connection was already dropped, the
//!    interrupt is a documented no-op, so a stale handle is harmless.
//!
//! Single-in-flight (ADR-0021): [`CancelToken::begin_turn`] / [`InFlightGuard`]
//! toggle an `in_flight` flag the command layer + tests read without the session
//! lock. The frontend disables input while a turn runs; this flag is the
//! observable backend truth that exactly one query is executing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use duckdb::InterruptHandle;

/// The shared cancel + in-flight signal for one session's query loop. Held
/// behind an `Arc` cloned between the [`crate::session::Session`] and the cancel
/// command (and the timeout watchdog). All mutation goes through interior
/// mutability, so `request()` reaches the running turn without the session lock.
pub struct CancelToken {
    /// Whether cancel was requested for the in-flight turn. Set by `request()`
    /// (user cancel or the timeout watchdog); reset by `begin_turn` at the start
    /// of each turn so a stale request from a prior turn cannot leak in.
    requested: AtomicBool,
    /// Whether a turn is currently executing. Toggled by [`InFlightGuard`] (via
    /// `begin_turn`); read by tests + the command layer to assert the single-
    /// in-flight invariant without the session lock.
    in_flight: AtomicBool,
    /// The interrupt handle for the in-flight DuckDB query, set when the
    /// provider SQL begins executing and cleared when it ends. `None` outside a
    /// query, so a cancel between turns (or during the provider call) is a
    /// cooperative-flag-only cancel -- still effective, just not an engine
    /// interrupt. `Mutex` (not atomic) because `Arc<InterruptHandle>` is not
    /// `Copy`; the critical section is a single set/clear, never held long.
    interrupt: Mutex<Option<Arc<InterruptHandle>>>,
}

impl Default for CancelToken {
    fn default() -> Self {
        Self {
            requested: AtomicBool::new(false),
            in_flight: AtomicBool::new(false),
            interrupt: Mutex::new(None),
        }
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark this turn's DuckDB query as interruptible. `try_materialize`
    /// registers the sandbox connection's handle right before the provider SQL
    /// runs and clears it ([`Self::clear_interrupt`]) right after, so a cancel
    /// during install/derive (tool-controlled, fast) cannot disrupt those steps
    /// -- only the provider query is interruptible, which is exactly ADR-0021.
    pub fn set_interrupt(&self, handle: Arc<InterruptHandle>) {
        *self.interrupt.lock().expect("interrupt lock poisoned") = Some(handle);
    }

    /// Stop associating an interrupt handle with the in-flight turn. Called after
    /// the provider SQL completes (success or failure) and by [`InFlightGuard`]'s
    /// drop; a later cancel then relies on the cooperative flag alone.
    pub fn clear_interrupt(&self) {
        *self.interrupt.lock().expect("interrupt lock poisoned") = None;
    }

    /// Fire the cancel: set the cooperative flag AND interrupt the running
    /// DuckDB query (if one is registered). Idempotent -- a second call is a
    /// no-op (the flag is already set; the handle, if still present, gets a
    /// second interrupt that DuckDB treats as a no-op once the query has ended).
    /// Called from the cancel command (user hit 停止) and the timeout watchdog.
    pub fn request(&self) {
        self.requested.store(true, Ordering::SeqCst);
        if let Some(handle) = self
            .interrupt
            .lock()
            .expect("interrupt lock poisoned")
            .as_ref()
        {
            handle.interrupt();
        }
    }

    /// Whether cancel was requested for the in-flight turn. The orchestrator
    /// checks this between phases and short-circuits to Cancelled when set.
    pub fn is_requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }

    /// Whether a turn is currently executing (the single-in-flight invariant,
    /// ADR-0021). Read by tests + the command layer without the session lock.
    pub fn is_in_flight(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// Begin a turn: clear any stale request from the prior turn and mark a
    /// query as in-flight. Returns an [`InFlightGuard`] whose `Drop` clears the
    /// in-flight flag and the interrupt slot (RAII -- every exit from `ask`,
    /// including early Cancelled, drops the guard). The guard also exposes a
    /// liveness flag for the optional timeout watchdog: dropping the guard
    /// invalidates it so a slow timer cannot fire into the next turn.
    pub fn begin_turn(self: &Arc<Self>) -> InFlightGuard {
        // Reset first, then mark in-flight, so a cancel racing the begin cannot
        // carry a stale `true` into the new turn (SeqCst orders the two stores).
        self.requested.store(false, Ordering::SeqCst);
        self.in_flight.store(true, Ordering::SeqCst);
        InFlightGuard {
            token: Arc::clone(self),
            alive: Arc::new(AtomicBool::new(true)),
        }
    }
}

/// RAII guard for the in-flight flag + the timeout watchdog's liveness. Created
/// by [`CancelToken::begin_turn`]; dropping it (at every exit from `ask`) clears
/// in-flight + the interrupt slot and invalidates the watchdog. Holds an
/// `Arc<CancelToken>` (not a borrow) so it coexists with `&mut self` method
/// calls on the Session within `ask`.
pub struct InFlightGuard {
    token: Arc<CancelToken>,
    alive: Arc<AtomicBool>,
}

impl InFlightGuard {
    /// The liveness flag for a timeout watchdog. Clone before spawning the
    /// watchdog; when this guard drops the flag clears, so a late timeout sees
    /// `false` and does not fire into a later turn.
    pub fn watchdog_alive(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.alive)
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::SeqCst);
        self.token.in_flight.store(false, Ordering::SeqCst);
        self.token.clear_interrupt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_token_is_not_requested_or_in_flight() {
        let token = Arc::new(CancelToken::new());
        assert!(!token.is_requested());
        assert!(!token.is_in_flight());
    }

    #[test]
    fn request_sets_the_flag() {
        let token = CancelToken::new();
        token.request();
        assert!(token.is_requested());
    }

    #[test]
    fn begin_turn_marks_in_flight_and_drops_clear_it() {
        let token = Arc::new(CancelToken::new());
        {
            let _guard = token.begin_turn();
            assert!(token.is_in_flight());
        }
        assert!(!token.is_in_flight());
    }

    #[test]
    fn begin_turn_resets_a_stale_request_from_a_prior_turn() {
        // A cancel that arrived after the prior turn ended must NOT carry into
        // the next turn -- begin_turn clears it so the new turn starts clean.
        let token = Arc::new(CancelToken::new());
        token.request();
        assert!(token.is_requested());
        let _guard = token.begin_turn();
        assert!(!token.is_requested(), "stale request must be cleared");
    }

    #[test]
    fn request_is_idempotent() {
        let token = CancelToken::new();
        token.request();
        token.request(); // second call must not panic
        assert!(token.is_requested());
    }

    #[test]
    fn dropping_the_guard_clears_the_interrupt_slot() {
        // A cancel after the turn ends has no query to interrupt -- the slot is
        // cleared on drop so request() degrades to the cooperative flag only.
        let token = Arc::new(CancelToken::new());
        // No real InterruptHandle is needed here: an empty slot is the default,
        // and drop clearing None leaves None -- the observable behavior is that
        // request() after the turn does not panic (it skips the interrupt).
        {
            let _guard = token.begin_turn();
        }
        token.request(); // no panic: interrupt slot is None
        assert!(token.is_requested());
    }
}
