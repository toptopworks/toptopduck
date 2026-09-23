//! Output-cap truncation surfacing (issue #1003): the length signal's two
//! presentations, both downstream of the #1001 cap formula.
//!
//! The signal lives in rig's stream-terminal `finish_reason`, but it never
//! crosses onto the `MultiTurnStreamItem` face the driver's fold consumes
//! (`FinalResponse`'s `PromptResponse` carries no reason) -- the public
//! observation point is the per-turn hook event, which hands over the
//! assembled turn's normalized `FinishReason`. [`FinishReasonWatcher`]
//! records the last turn's reason off that seam; [`terminal_reply`] turns a
//! Length-stopped final answer from a silent `Termination::Text` into one
//! carrying an explicit truncation marker (the partial answer stays
//! visible).
//!
//! A tool-call turn truncated mid-arguments never reaches the hook: rig's
//! tool-input accumulator surfaces the pending parse error at the stream
//! terminal, pre-empting the completion event that carried the reason --
//! on the rig 0.42 public surface the Length bit for that shape is gone.
//! [`reattribute_tool_input_truncation`] closes that shape at the
//! termination mapping instead: the accumulator's EOF-family parse detail
//! (the input ended mid-parse -- truncation-shaped, distinct from a
//! model's own malformed JSON) on a cap-stamped run is re-attributed as an
//! output-truncation failure. Genuine upstream error text keeps its
//! verbatim passthrough (#669): only the EOF family inside the
//! accumulator's own tool-input wording is rewritten, and only on runs
//! whose request carried the #1001 cap stamp.

use std::sync::{Arc, Mutex};

use rig_agent::agent::{AgentHook, HookContext, ModelTurnAction, ModelTurnFinished};
use rig_core::completion::FinishReason;

use crate::session::loop_contract::Termination;

/// Marker appended to a terminal reply whose turn stopped at the output
/// cap (issue #1003).
pub(crate) const TRUNCATED_REPLY_MARKER: &str = "\n\n[output truncated at the token cap]";

/// The per-turn finish-reason observer: records the last turn's
/// `finish_reason` off the hook seam so the driver can read it once the
/// stream ends. Last-wins is the terminal-turn semantics the reply mapping
/// needs: the final model turn is the one whose reason the reply carries.
/// Constructed as a pair with [`FinishReasonRecord`] -- the watcher moves
/// into the agent's hook stack, the record stays with the driver.
pub(crate) struct FinishReasonWatcher {
    last: Arc<Mutex<Option<FinishReason>>>,
}

/// The driver's reader half: the last recorded reason, read once after
/// the stream ends. The lock discipline stays inside the pair.
pub(crate) struct FinishReasonRecord {
    last: Arc<Mutex<Option<FinishReason>>>,
}

impl FinishReasonWatcher {
    pub(crate) fn new() -> (Self, FinishReasonRecord) {
        let last = Arc::new(Mutex::new(None));
        (
            Self {
                last: Arc::clone(&last),
            },
            FinishReasonRecord { last },
        )
    }

    /// Record one turn's reason (the hook body's whole job).
    fn record(&self, reason: Option<&FinishReason>) {
        *self.last.lock().expect("finish-reason lock poisoned") = reason.cloned();
    }
}

impl FinishReasonRecord {
    /// The last turn's reason (`None` until the first turn completes).
    pub(crate) fn last(&self) -> Option<FinishReason> {
        self.last
            .lock()
            .expect("finish-reason lock poisoned")
            .clone()
    }
}

impl AgentHook for FinishReasonWatcher {
    fn on_model_turn_finished(
        &self,
        _ctx: &HookContext,
        event: ModelTurnFinished<'_>,
    ) -> impl std::future::Future<Output = ModelTurnAction> + Send {
        self.record(event.finish_reason);
        std::future::ready(ModelTurnAction::Continue)
    }
}

/// The terminal reply's termination: a turn that stopped at the output cap
/// (`FinishReason::Length`) gets the truncation marker appended -- the
/// answer was cut, not finished -- while every other reason (or none)
/// keeps the verbatim text.
pub(crate) fn terminal_reply(text: String, finish_reason: Option<&FinishReason>) -> Termination {
    match finish_reason {
        Some(FinishReason::Length) => Termination::Text(format!("{text}{TRUNCATED_REPLY_MARKER}")),
        _ => Termination::Text(text),
    }
}

/// Re-attribute the tool-input parse-error family as an output truncation
/// (issue #1003): the EOF-family detail is truncation-shaped (the input
/// ended mid-parse), and on a run whose request carried the cap stamp the
/// honest attribution is the cap, not a JSON fault. Every other
/// termination -- other details, other variants -- passes through
/// untouched, preserving the #669 verbatim contract for genuine upstream
/// errors.
pub(crate) fn reattribute_tool_input_truncation(
    termination: Termination,
    cap_stamped: bool,
) -> Termination {
    match termination {
        Termination::Transient(detail) if cap_stamped && is_truncated_tool_input(&detail) => {
            Termination::Transient(format!("output truncated at the token cap: {detail}"))
        }
        other => other,
    }
}

/// rig's tool-input accumulator wording for a wire-promised block whose
/// JSON never completed, narrowed to the EOF family: the input ended
/// mid-parse (truncation-shaped). A model's own malformed JSON surfaces in
/// the same wording with a different parser fault and stays verbatim.
fn is_truncated_tool_input(detail: &str) -> bool {
    detail.contains("arrived with malformed JSON input") && detail.contains("EOF while parsing")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The #1001 incident's verbatim upstream detail (rig's accumulator on
    /// a cap-truncated tool call) -- the fixture the whole module hangs
    /// off.
    const INCIDENT_DETAIL: &str = "tool call `python` arrived with malformed JSON input: EOF while parsing a string at line 1 column 5232";

    #[test]
    fn length_stop_appends_the_marker_other_reasons_stay_verbatim() {
        assert_eq!(
            terminal_reply("partial answer".to_string(), Some(&FinishReason::Length)),
            Termination::Text(format!("partial answer{TRUNCATED_REPLY_MARKER}"))
        );
        assert_eq!(
            terminal_reply("done".to_string(), Some(&FinishReason::Stop)),
            Termination::Text("done".to_string())
        );
        assert_eq!(
            terminal_reply("done".to_string(), None),
            Termination::Text("done".to_string())
        );
        // ContentFilter also reads as truncated output on rig's own
        // predicate -- the marker states the cap's fact, so it stays
        // Length-only here.
        assert_eq!(
            terminal_reply("done".to_string(), Some(&FinishReason::ContentFilter)),
            Termination::Text("done".to_string())
        );
    }

    #[test]
    fn eof_family_reattributes_only_on_a_cap_stamped_run() {
        assert_eq!(
            reattribute_tool_input_truncation(
                Termination::Transient(INCIDENT_DETAIL.to_string()),
                true
            ),
            Termination::Transient(format!(
                "output truncated at the token cap: {INCIDENT_DETAIL}"
            ))
        );
        // No cap stamp (the bridged production face keeps `None`) -- the
        // detail passes through verbatim.
        assert_eq!(
            reattribute_tool_input_truncation(
                Termination::Transient(INCIDENT_DETAIL.to_string()),
                false
            ),
            Termination::Transient(INCIDENT_DETAIL.to_string())
        );
    }

    #[test]
    fn non_eof_faults_and_other_terminations_pass_through_verbatim() {
        // The same accumulator wording with a non-EOF parser fault is a
        // model's own malformed JSON, not a cap cut (#669 verbatim).
        let own_fault = "tool call `python` arrived with malformed JSON input: expected `,` or `}` at line 1 column 12";
        assert_eq!(
            reattribute_tool_input_truncation(Termination::Transient(own_fault.to_string()), true),
            Termination::Transient(own_fault.to_string())
        );
        // Other transient details and other variants never rewrite.
        assert_eq!(
            reattribute_tool_input_truncation(
                Termination::Transient("connection reset".to_string()),
                true
            ),
            Termination::Transient("connection reset".to_string())
        );
        assert_eq!(
            reattribute_tool_input_truncation(Termination::NotWired, true),
            Termination::NotWired
        );
    }

    #[test]
    fn watcher_records_the_last_turns_reason() {
        let (watcher, record) = FinishReasonWatcher::new();
        assert_eq!(record.last(), None, "no turn observed yet");

        watcher.record(Some(&FinishReason::Length));
        assert_eq!(record.last(), Some(FinishReason::Length));

        // Last-wins: the terminal turn's reason is the one that stays.
        watcher.record(Some(&FinishReason::Stop));
        assert_eq!(record.last(), Some(FinishReason::Stop));
    }
}
