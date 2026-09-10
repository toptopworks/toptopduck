//! The no-progress watchdog clock (ADR-0115).
//!
//! ADR-0081's execution-level wall clock timed the WHOLE turn from its start
//! -- one sleep, no reset -- which billed two legal waits to the same cap:
//! an approval pending on the user (ADR-0080/0083) and a gateway tool
//! execution (CLI tools have no timeout of their own). ADR-0115 redefines
//! the cap as NO-PROGRESS: only the agent's free-activity segment (stream
//! generation) is timed; segments waiting on an external principal freeze
//! the clock, and any inbound stream activity re-arms it.
//!
//! Shape: a re-armable deadline plus a nested freeze depth, polled by one
//! watchdog thread at [`PROGRESS_POLL_INTERVAL`]. [`ProgressClock::touch`]
//! re-arms the deadline (inbound stream activity); [`ProgressClock::freeze`]
//! returns an RAII guard raising the freeze depth (the watchdog defers the
//! deadline while frozen); expiry fires the shared token generation-guarded
//! (the ADR-0021 timeout -> cancel mapping) and latches `timed_out` so the
//! termination derivation can land the turn as
//! [`Termination::NoProgress`](crate::session::loop_contract::Termination::NoProgress)
//! instead of a bare `Cancelled`.
//!
//! Lifetime: the clock lives in a slot on the session's [`CancelToken`] (so
//! the gateway can freeze across a bridge-served tool call it serves) while
//! the watchdog thread holds only a [`Weak`] -- when the turn ends, the
//! guard's drop clears the slot, the last strong reference dies, and the
//! poll loop exits on its next upgrade failure. No explicit disarm signal,
//! and the thread cannot outlive its turn by more than one poll interval.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::cancel::{CancelToken, TurnGeneration};
use crate::session::loop_contract::Termination;

/// The watchdog's poll granularity. Same order as the cancel watcher's
/// 25 ms loop (the UI cancel round-trip); kill latency past the cap is one
/// interval, which a 120 s cap makes invisible.
const PROGRESS_POLL_INTERVAL: Duration = Duration::from_millis(25);

pub(crate) struct ProgressClock {
    /// The cap the clock arms with (the ADR-0021-aligned 120 s in
    /// production; short values ride the `with_caps` test seam). Read back
    /// by the termination derivation (`cancel_landing`) as the expired-cap
    /// payload.
    timeout: Duration,
    /// The monotonic origin the deadline is measured against: captured at
    /// arm, never read as a wall-clock. Deadline and `now` both live as
    /// millis since it, so NTP corrections, VM snapshot resumes, and
    /// hibernate cannot move the cap (the retired whole-turn helper slept
    /// on the OS timer, which is monotonic -- this keeps that immunity).
    origin: Instant,
    /// The next killable instant, in millis since [`Self::origin`].
    /// Re-armed by `touch`, deferred by the watchdog while frozen.
    deadline_ms: AtomicU64,
    /// Nested freeze depth: a segment waiting on an external principal
    /// (gateway dispatch, approval condvar, an open tool-call window)
    /// holds a [`FreezeGuard`]; the watchdog defers the deadline while
    /// this is > 0.
    frozen: AtomicU32,
    /// Latched by the watchdog on expiry: the kill-reason slot the
    /// termination derivation reads to land NoProgress instead of
    /// Cancelled (the cancelled-vs-timed-out presentation split, issue
    /// #883, reads the same fact).
    timed_out: AtomicBool,
}

impl ProgressClock {
    /// Arm the watchdog for one turn: seed the deadline and spawn the poll
    /// thread holding ONLY a weak reference -- the caller (and the token
    /// slot) own the strong ones, so the loop exits once the turn's guards
    /// drop and the slot clears.
    fn arm(generation: TurnGeneration, token: Arc<CancelToken>, timeout: Duration) -> Arc<Self> {
        let clock = Arc::new(Self {
            timeout,
            origin: Instant::now(),
            deadline_ms: AtomicU64::new(timeout.as_millis() as u64),
            frozen: AtomicU32::new(0),
            timed_out: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&clock);
        // Builder::spawn (not the panicking thread::spawn): a spawn failure
        // is a returned error, logged below -- a silently absent poll thread
        // would leave the published clock freezing normally with nothing
        // behind it.
        let spawned = thread::Builder::new()
            .name("no-progress-watchdog".into())
            .spawn(move || {
                // catch_unwind keeps the detached thread self-sufficient (the
                // issue #321 posture the retired whole-turn helper carried): a
                // panicking watchdog is logged with its payload, never silently
                // eaten.
                let drove = catch_unwind(AssertUnwindSafe(|| {
                    while let Some(clock) = weak.upgrade() {
                        // A cancel already in flight means someone else fired
                        // first (the user, or a sibling path); stand down
                        // without latching. The check-then-store window vs a
                        // racing user cancel is one poll tick wide and both
                        // landings abort the turn, so the mislabeled reason is
                        // unobservable in practice.
                        if token.is_requested() {
                            return;
                        }
                        if clock.frozen.load(Ordering::SeqCst) > 0 {
                            // Frozen: the turn is waiting on an external
                            // principal; the deadline re-arms from NOW each
                            // tick, so the cap restarts when the segment ends.
                            clock.defer(timeout);
                        } else if clock.elapsed_ms() >= clock.deadline_ms.load(Ordering::SeqCst) {
                            clock.timed_out.store(true, Ordering::SeqCst);
                            // Generation-guarded (issue #696): a clock that
                            // slept through a turn boundary stands down instead
                            // of cancelling the successor.
                            token.request_if(generation);
                            return;
                        }
                        drop(clock);
                        thread::sleep(PROGRESS_POLL_INTERVAL);
                    }
                }));
                if let Err(payload) = drove {
                    log::error!(
                        target: "toptopduck::session",
                        "no-progress watchdog panicked: {}; the timeout path may be impaired",
                        crate::session::turn_dispatch::panic_detail(
                            "no-progress watchdog",
                            &*payload
                        ),
                    );
                }
            });
        if spawned.is_err() {
            log::error!(
                target: "toptopduck::session",
                "no-progress watchdog thread failed to spawn; the timeout path is impaired"
            );
        }
        clock
    }

    /// Arm the watchdog AND publish it on the token's slot -- the shape all
    /// four turn paths share: the armed clock must ride the token, or the
    /// gateway (which sees only the token) could not freeze across the tool
    /// calls it serves (ADR-0115).
    pub(crate) fn arm_and_publish(
        generation: TurnGeneration,
        token: &Arc<CancelToken>,
        timeout: Duration,
    ) -> Arc<Self> {
        let clock = Self::arm(generation, Arc::clone(token), timeout);
        token.set_progress_clock(Arc::clone(&clock));
        clock
    }

    /// The cancel landing's termination (ADR-0115): when the clock latched,
    /// the cancel is the watchdog's -- NoProgress carrying the expired cap
    /// (read from the clock's own armed timeout); otherwise a user / close
    /// cancel. `None` means no clock was armed for the turn (the
    /// `with_caps(None)` test seam), which lands a plain cancel.
    pub(crate) fn cancel_landing(clock: Option<&Arc<Self>>) -> Termination {
        match clock {
            Some(clock) if clock.is_timed_out() => Termination::NoProgress(clock.timeout),
            _ => Termination::Cancelled,
        }
    }

    /// Inbound stream activity: re-arm the deadline. Free segments only --
    /// freeze segments keep the clock deferred by the watchdog instead.
    pub(crate) fn touch(&self) {
        self.defer(self.timeout);
    }

    /// Open a freeze segment (a wait on an external principal): the
    /// watchdog defers the deadline until the returned guard drops. Nesting
    /// is safe (a gateway dispatch served inside an open tool-call window);
    /// the cap restarts when the LAST guard drops.
    pub(crate) fn freeze(self: &Arc<Self>) -> FreezeGuard {
        self.frozen.fetch_add(1, Ordering::SeqCst);
        FreezeGuard {
            clock: Arc::clone(self),
        }
    }

    /// Whether the watchdog fired for this turn (the kill reason the
    /// termination derivation reads).
    pub(crate) fn is_timed_out(&self) -> bool {
        self.timed_out.load(Ordering::SeqCst)
    }

    /// Millis since the monotonic [`Self::origin`] -- the clock's only
    /// notion of "now".
    fn elapsed_ms(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }

    fn defer(&self, timeout: Duration) {
        self.deadline_ms.store(
            self.elapsed_ms() + timeout.as_millis() as u64,
            Ordering::SeqCst,
        );
    }
}

/// RAII handle for one freeze segment: dropping it releases the depth this
/// segment contributed. Every guard comes from [`ProgressClock::freeze`] and
/// drops at most once, so the depth pairing holds by construction.
pub(crate) struct FreezeGuard {
    clock: Arc<ProgressClock>,
}

impl Drop for FreezeGuard {
    fn drop(&mut self) {
        // fetch_sub returns the PREVIOUS value; >= 1 unless a guard dropped
        // without a matching freeze, which the constructor rules out.
        let prev = self.clock.frozen.fetch_sub(1, Ordering::SeqCst);
        debug_assert!(prev >= 1, "unpaired FreezeGuard drop");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: Duration = Duration::from_millis(100);

    fn armed(timeout: Duration) -> (Arc<CancelToken>, Arc<ProgressClock>, TurnGeneration) {
        let token = Arc::new(CancelToken::new());
        let guard = token.begin_turn();
        let generation = guard.generation();
        std::mem::forget(guard); // keep the generation alive for the test
        let clock = ProgressClock::arm(generation, Arc::clone(&token), timeout);
        (token, clock, generation)
    }

    /// The core kill: a generation segment that never touches past the cap
    /// fires the token and latches the reason slot.
    #[test]
    fn expiry_fires_the_token_and_latches_timed_out() {
        let (token, clock, generation) = armed(CAP);
        thread::sleep(CAP + PROGRESS_POLL_INTERVAL * 4);
        assert!(clock.is_timed_out(), "the expiry must latch the slot");
        assert!(token.is_requested(), "the watchdog fired the token");
        let _ = generation;
    }

    /// Stream activity re-arms the deadline: touches every 30 ms keep a
    /// 100 ms cap alive indefinitely; stopping the touches lets it fire.
    #[test]
    fn touch_defers_expiry_while_activity_continues() {
        let (token, clock, _generation) = armed(CAP);
        for _ in 0..10 {
            thread::sleep(Duration::from_millis(30));
            clock.touch();
        }
        assert!(
            !token.is_requested(),
            "steady stream activity must never trip the cap"
        );
        // Activity stops; the cap fires within one deadline + poll tick.
        thread::sleep(CAP + PROGRESS_POLL_INTERVAL * 4);
        assert!(clock.is_timed_out());
        assert!(token.is_requested());
    }

    /// The freeze deferral (the ADR-0115 decision under test): a frozen
    /// segment outliving the cap several times over survives; the cap
    /// restarts when the guard drops.
    #[test]
    fn freeze_survives_a_segment_far_past_the_cap() {
        let (token, clock, _generation) = armed(CAP);
        let guard = clock.freeze();
        thread::sleep(CAP * 3); // 3x the cap, frozen: must not fire
        assert!(!token.is_requested(), "a frozen segment must not be killed");
        assert!(!clock.is_timed_out());
        drop(guard);
        thread::sleep(CAP + PROGRESS_POLL_INTERVAL * 4);
        assert!(clock.is_timed_out(), "the cap restarts after the freeze");
        assert!(token.is_requested());
    }

    /// Nesting: the depth counts guards, and only the LAST drop re-arms
    /// the clock (a permission decision inside an open tool window).
    #[test]
    fn nested_freezes_release_on_the_last_guard() {
        let (token, clock, _generation) = armed(CAP);
        let outer = clock.freeze();
        {
            let _inner = clock.freeze();
            thread::sleep(CAP * 2);
            assert!(!token.is_requested());
        } // inner drops: outer still holds the freeze
        thread::sleep(CAP);
        assert!(
            !token.is_requested(),
            "the outer freeze must still defer the deadline"
        );
        drop(outer);
        thread::sleep(CAP + PROGRESS_POLL_INTERVAL * 4);
        assert!(clock.is_timed_out());
        assert!(token.is_requested());
    }

    /// A clock that sleeps through a turn boundary stands down (the issue
    /// #696 posture): the successor turn's begin_turn retires the
    /// generation, and the expiry's request_if cannot fire. The expiry
    /// itself still runs and still latches the reason slot -- the test
    /// asserts both, so a watchdog that never ran cannot pass.
    #[test]
    fn expiry_after_a_turn_boundary_stands_down() {
        let (token, clock, generation) = armed(CAP);
        drop(token.begin_turn()); // the tested turn ended, a successor began
        thread::sleep(CAP + PROGRESS_POLL_INTERVAL * 4);
        assert!(
            clock.is_timed_out(),
            "the expiry must run and latch even when standing down"
        );
        assert!(
            !token.request_if(generation),
            "the retired generation's cancel must stand down"
        );
        assert!(
            !token.is_requested(),
            "the successor turn is untouched by the stale expiry"
        );
    }
}
