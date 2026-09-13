//! The cancel-watcher hook (ADR-0116 Decision 3, issue #917): maps the app's
//! poll-based [`CancelToken`] onto the rig loop's termination channel. rig
//! has no external cancellation token to fire, so the hook checks the app
//! token at every loop-reachable checkpoint -- before each model call
//! (`on_completion_call`) and at each streamed delta (`on_text_delta` /
//! `on_reasoning_delta` / `on_tool_call_delta`) -- and stops the run with a
//! reason the terminal classification decodes.
//!
//! Checkpoint coverage is complemented by the driver's select race: while
//! the model call is silent (no deltas -- the whole-message bridge never
//! emits any mid-call), no checkpoint fires, so the driver's stream
//! consumer races the same token and abandons the wait directly.
//!
//! The stop reason is this module's private fork vocabulary: a user / close
//! cancel versus the no-progress watchdog's kill (ADR-0115 -- the watchdog
//! requests the same token, and the armed clock is the only thing that
//! distinguishes its kill). Both words are pinned as constants; the
//! terminal classification matches exactly these, so a foreign stop reason
//! (a future hook of ours) cannot silently degrade into a cancel landing.

use std::sync::Arc;

use rig_agent::agent::{
    AgentHook, CompletionCallAction, HookContext, ObservationAction, ReasoningDelta, TextDelta,
    ToolCallDelta,
};
// The hook-event completion call: re-exported under a suffixed name because
// the bare `CompletionCall` belongs to the usage record of the same family.
use rig_agent::agent::CompletionCallEvent as CompletionCall;

use crate::cancel::CancelToken;
use crate::session::progress::ProgressClock;

use super::adapter::SharedTurnState;

/// The stop reason for a user / close cancel (ADR-0021).
pub(crate) const CANCEL_REASON_USER: &str = "cancelled";

/// The stop reason for the no-progress watchdog's kill (ADR-0115): the
/// generation segment went silent past the cap with no freeze open.
pub(crate) const CANCEL_REASON_NO_PROGRESS: &str = "no-progress";

/// The checkpoint hook: stops the run the moment the app token is requested
/// (user cancel, close, watchdog kill, or a latched dispatch abort), with
/// the reason word naming which. Holds only shared state -- it crosses into
/// the driver's runtime with the agent.
pub(crate) struct CancelWatcher {
    token: Arc<CancelToken>,
    clock: Option<Arc<ProgressClock>>,
    state: Arc<SharedTurnState>,
}

impl CancelWatcher {
    pub(crate) fn new(
        token: Arc<CancelToken>,
        clock: Option<Arc<ProgressClock>>,
        state: Arc<SharedTurnState>,
    ) -> Self {
        Self {
            token,
            clock,
            state,
        }
    }

    /// The shared checkpoint verdict: the stop reason when the turn is over,
    /// `None` to continue. The reason fork: a clock that latched its timeout
    /// is the watchdog's kill; any other requested token is a user / close
    /// cancel. A latched dispatch abort or gate cancel lands as a
    /// user-flavored stop -- its honest termination rides the shared state's
    /// `aborted` / `gate_cancelled` slots, which the terminal derivation
    /// reads FIRST, so the stop reason only ends the loop, never the
    /// classification.
    fn stop_reason(&self) -> Option<&'static str> {
        if !self.state.turn_over(&self.token) {
            return None;
        }
        let timed_out = self
            .clock
            .as_ref()
            .is_some_and(|clock| clock.is_timed_out());
        Some(if timed_out {
            CANCEL_REASON_NO_PROGRESS
        } else {
            CANCEL_REASON_USER
        })
    }

    fn checkpoint(&self) -> CompletionCallAction {
        match self.stop_reason() {
            Some(reason) => CompletionCallAction::stop(reason),
            None => CompletionCallAction::continue_run(),
        }
    }

    /// The delta-level checkpoints: same fork, the observation flavor of the
    /// stop action (delta hooks return `ObservationAction`).
    fn observation_checkpoint(&self) -> ObservationAction {
        match self.stop_reason() {
            Some(reason) => ObservationAction::stop(reason),
            None => ObservationAction::continue_run(),
        }
    }
}

impl AgentHook for CancelWatcher {
    fn on_completion_call(
        &self,
        _ctx: &HookContext,
        _event: CompletionCall<'_>,
    ) -> impl std::future::Future<Output = CompletionCallAction> + Send {
        std::future::ready(self.checkpoint())
    }

    fn on_text_delta(
        &self,
        _ctx: &HookContext,
        _event: TextDelta<'_>,
    ) -> impl std::future::Future<Output = ObservationAction> + Send {
        std::future::ready(self.observation_checkpoint())
    }

    fn on_reasoning_delta(
        &self,
        _ctx: &HookContext,
        _event: ReasoningDelta<'_>,
    ) -> impl std::future::Future<Output = ObservationAction> + Send {
        std::future::ready(self.observation_checkpoint())
    }

    fn on_tool_call_delta(
        &self,
        _ctx: &HookContext,
        _event: ToolCallDelta<'_>,
    ) -> impl std::future::Future<Output = ObservationAction> + Send {
        std::future::ready(self.observation_checkpoint())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::progress::ProgressClock;
    use std::time::Duration;

    /// The stop-reason fork (ADR-0116 Decision 3, ADR-0115): a requested
    /// token stops the run with the user-cancel word; once the armed clock
    /// latches its timeout, the same token stops it with the no-progress
    /// word. Both words are the terminal mapping's exact-match vocabulary,
    /// so the fork is pinned at the source.
    #[test]
    fn stop_reason_forks_user_cancel_vs_watchdog_kill() {
        let state = Arc::new(SharedTurnState::new());
        let token = Arc::new(CancelToken::new());
        let guard = token.begin_turn();
        let clock =
            ProgressClock::arm_and_publish(guard.generation(), &token, Duration::from_millis(30));
        let watcher = |clock: Option<Arc<ProgressClock>>| {
            CancelWatcher::new(Arc::clone(&token), clock, Arc::clone(&state))
        };

        // The watchdog's own kill: its cap lapses un-touched, it fires the
        // token and latches the reason slot.
        std::thread::sleep(Duration::from_millis(80));
        assert!(token.is_requested(), "the watchdog fired the token");
        assert!(clock.is_timed_out(), "the armed clock latched");

        // The fork: the same requested token words itself by the latch --
        // a watcher with no clock reads a user cancel, the one holding the
        // latched clock reads the watchdog's kill.
        assert_eq!(watcher(None).stop_reason(), Some(CANCEL_REASON_USER));
        assert_eq!(
            watcher(Some(clock)).stop_reason(),
            Some(CANCEL_REASON_NO_PROGRESS)
        );
    }
}
