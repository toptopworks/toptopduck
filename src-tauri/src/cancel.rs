//! Cancellation + single-in-flight signal for the query loop (ADR-0021, issue
//! #28). One [`CancelToken`] is shared (via `Arc`) between the turn orchestrator
//! and the cancel entry point, so a cancel can fire WITHOUT the session lock --
//! `Session::ask` holds the session `Mutex` for the whole turn, so the cancel
//! command must reach the signal through a separate `Arc`.
//!
//! Two cooperating pieces:
//! 1. A cooperative `requested` flag (bit 0 of the packed `AtomicU64` state,
//!    shared with the turn generation), checked by the
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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use duckdb::InterruptHandle;

/// A turn's identity for the wall-clock watchdog: minted per
/// [`CancelToken::begin_turn`], retired when the next turn begins. Opaque --
/// compared only through [`CancelToken::request_if`] -- so a raw counter
/// cannot stand in for it (the same pairing-as-type posture as the dispatch
/// core's `GhostSnapshot`, issue #696).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnGeneration(u64);

/// The shared cancel + in-flight signal for one session's query loop. Held
/// behind an `Arc` cloned between the [`crate::session::Session`] and the cancel
/// command (and the timeout watchdog). All mutation goes through interior
/// mutability, so `request()` reaches the running turn without the session lock.
pub struct CancelToken {
    /// Packed turn state: the high bits carry the turn GENERATION (one per
    /// `begin_turn`), bit 0 the cancel-request flag. Packing both into ONE
    /// word makes "request a cancel for generation N" a single atomic RMW
    /// ([`Self::request_if`]) -- a watchdog that slept through a turn
    /// boundary sees the generation changed and stands down, with no
    /// check-then-act window between a liveness read and the request (the
    /// KNOWN RACE the retired bare `alive` flag left open, closed by
    /// issue #696). The flag half behaves exactly as the old bare
    /// `requested`: set by `request()` (user cancel or watchdog), cleared by
    /// `begin_turn` at the start of each turn.
    state: AtomicU64,
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
            state: AtomicU64::new(0),
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
        self.state.fetch_or(1, Ordering::SeqCst);
        self.fire_interrupt();
    }

    /// Fire the cancel only when `generation` is still the current turn's:
    /// the wall-clock watchdog's turn identity (issue #696). The generation
    /// and the request flag share one atomic word, so a turn boundary
    /// (`begin_turn` swaps in the next generation) and a late watchdog
    /// decision cannot interleave -- the watchdog either fires inside its own
    /// turn or observes the changed generation and stands down. Returns
    /// whether the cancel fired.
    pub fn request_if(&self, generation: TurnGeneration) -> bool {
        loop {
            let current = self.state.load(Ordering::SeqCst);
            if current >> 1 != generation.0 {
                return false;
            }
            match self.state.compare_exchange(
                current,
                current | 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => {
                    self.fire_interrupt();
                    return true;
                }
                // The word moved under us (a racing begin_turn / request);
                // re-read and re-judge.
                Err(_) => continue,
            }
        }
    }

    /// The best-effort engine abort on top of the already-set flag.
    fn fire_interrupt(&self) {
        // The interrupt is a best-effort engine-abort enhancement on top of the
        // cooperative flag (already set above). On lock poison -- the ask thread
        // panicked mid set/clear -- degrade to flag-only instead of panicking:
        // cancel is a best-effort signal, and a poisoned cancel path must not
        // turn the 停止 button into a hard failure that wedges the session. The
        // cooperative flag alone still lands the in-flight turn as Cancelled at
        // its next check, so cancel stays effective sans the engine interrupt.
        // (set_interrupt/clear_interrupt keep their `.expect`: they run on the
        // ask thread, where poison means the session is already unrecoverable.)
        match self.interrupt.lock() {
            Ok(slot) => {
                if let Some(handle) = slot.as_ref() {
                    handle.interrupt();
                }
            }
            Err(_) => log::error!(
                target: "toptopduck::cancel",
                "interrupt lock poisoned; cancel degrades to cooperative flag only"
            ),
        }
    }

    /// Whether cancel was requested for the in-flight turn. The orchestrator
    /// checks this between phases and short-circuits to Cancelled when set.
    pub fn is_requested(&self) -> bool {
        self.state.load(Ordering::SeqCst) & 1 == 1
    }

    /// Whether a turn is currently executing (the single-in-flight invariant,
    /// ADR-0021). Read by tests + the command layer without the session lock.
    pub fn is_in_flight(&self) -> bool {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// Begin a turn: clear any stale request from the prior turn and mark a
    /// query as in-flight. Returns an [`InFlightGuard`] whose `Drop` clears the
    /// in-flight flag and the interrupt slot (RAII -- every exit from `ask`,
    /// including early Cancelled, drops the guard). The guard also carries the
    /// turn's generation for the optional timeout watchdog: a slow timer's
    /// cancel is generation-guarded (`request_if`) so it cannot fire into the
    /// next turn.
    pub fn begin_turn(self: &Arc<Self>) -> InFlightGuard {
        // Advance to the next generation with the flag cleared in ONE swap so
        // the new turn starts unrequested: a stale `requested=1` from a prior
        // turn cannot leak in, and a racing `request_if(old)` either lands
        // before the swap (cleared with it) or observes the new generation
        // and stands down. A user `request()` racing the swap is either
        // wiped (it landed before) or honored by the new turn (after) -- the
        // same nondeterminism the old bare flag had, unchanged.
        let generation = TurnGeneration((self.state.load(Ordering::SeqCst) >> 1) + 1);
        self.state.swap(generation.0 << 1, Ordering::SeqCst);
        self.in_flight.store(true, Ordering::SeqCst);
        InFlightGuard {
            token: Arc::clone(self),
            generation,
        }
    }

    /// Advance the turn generation and clear the request flag in one swap --
    /// [`Self::begin_turn`]'s word update without the in-flight half, for the
    /// full-pull paths' start (issue #779). A pull is not a turn, so this
    /// both consumes a leftover request (a stop that landed after the last
    /// turn or pull must not kill this pull on its first row) and retires any
    /// still-sleeping wall-clock watchdog from the last turn: the watchdog
    /// fires `request_if(old_generation)` into a generation that no longer
    /// exists and stands down, instead of cancelling a pull the user never
    /// stopped. A racing `request()` has the same nondeterminism `begin_turn`
    /// documents above: it either lands before the swap (wiped with it) or
    /// after (honored by the pull's row loop).
    pub fn retire_generation(&self) {
        let generation = TurnGeneration((self.state.load(Ordering::SeqCst) >> 1) + 1);
        self.state.swap(generation.0 << 1, Ordering::SeqCst);
    }
}

/// RAII guard for the in-flight flag. Created by
/// [`CancelToken::begin_turn`]; dropping it (at every exit from `ask`) clears
/// in-flight + the interrupt slot. Holds an `Arc<CancelToken>` (not a borrow)
/// so it coexists with `&mut self` method calls on the Session within `ask`.
pub struct InFlightGuard {
    token: Arc<CancelToken>,
    generation: TurnGeneration,
}

impl InFlightGuard {
    /// The turn's generation -- the wall-clock watchdog's turn identity.
    /// Pass to [`CancelToken::request_if`]; the token retires the
    /// generation at the next `begin_turn`, so a watchdog firing after its
    /// turn ended stands down instead of cancelling the successor turn (the
    /// race the retired `alive` flag left open, closed by issue #696).
    pub fn generation(&self) -> TurnGeneration {
        self.generation
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
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
    fn retire_generation_consumes_a_stale_request_and_stands_down_its_watchdog() {
        // Issue #779: a full pull starts by retiring the token's generation
        // (the begin_turn word update minus in-flight). Two contracts: the
        // leftover request flag is consumed, and a watchdog still holding the
        // retired generation stands down -- request_if(old) must NOT fire,
        // which is exactly the wall-clock leftover that would otherwise kill
        // a pull the user never stopped.
        let token = Arc::new(CancelToken::new());
        let guard = token.begin_turn();
        let generation = guard.generation();
        drop(guard);
        token.request();
        assert!(token.is_requested());
        token.retire_generation();
        assert!(!token.is_requested(), "stale request must be consumed");
        assert!(
            !token.request_if(generation),
            "a watchdog on the retired generation must stand down"
        );
        assert!(!token.is_requested(), "the stood-down watchdog set no flag");
    }

    #[test]
    fn request_is_idempotent() {
        let token = CancelToken::new();
        token.request();
        token.request(); // second call must not panic
        assert!(token.is_requested());
    }

    /// `request_if` fires for the generation it captured -- the watchdog's
    /// normal path: its turn is still current when the timeout lands.
    #[test]
    fn request_if_fires_for_the_current_generation() {
        let token = Arc::new(CancelToken::new());
        let guard = token.begin_turn();
        assert!(
            token.request_if(guard.generation()),
            "the current generation's cancel fires"
        );
        assert!(token.is_requested());
    }

    /// The generation guard (issue #696): a watchdog whose timeout lands
    /// AFTER its turn ended and a successor began must stand down -- the
    /// cancel does not leak into the successor turn. This is the race the
    /// retired `alive` flag left open (its check-then-act window between the
    /// load and `request()`); packing generation + flag into one atomic word
    /// closes it.
    #[test]
    fn request_if_stands_down_after_a_successor_turn_began() {
        let token = Arc::new(CancelToken::new());
        let gen1 = token.begin_turn().generation();
        drop(token.begin_turn()); // turn 1 ended, turn 2 began
        assert!(
            !token.request_if(gen1),
            "a stale generation's cancel stands down"
        );
        assert!(!token.is_requested(), "the successor turn is untouched");
    }

    /// The guard exposes a fresh generation per turn: two `begin_turn` calls
    /// never share a watchdog identity.
    #[test]
    fn generations_advance_per_turn() {
        let token = Arc::new(CancelToken::new());
        let g1 = token.begin_turn().generation();
        let g2 = token.begin_turn().generation();
        assert_ne!(g1, g2, "each turn gets its own generation");
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
