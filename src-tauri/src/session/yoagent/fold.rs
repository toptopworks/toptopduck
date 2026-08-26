//! The event fold (issue #668 item 5): maps yoagent's `AgentEvent` stream
//! onto the app's trace vocabulary -- round grouping (ADR-0103, one round per
//! assistant tool-call batch), thinking (raw model reasoning, duration pinned
//! to 0 like the built-in non-streaming adapters -- no fabricated
//! approximation, the #612 precedent), connective prose, tool batches
//! (parameters via the gateway-classified summary, result excerpts, success)
//! -- plus the live ADR-0059 phase rail.
//!
//! One producer, deterministic order: the fold runs in the runner's event
//! consumer; the call-level phases (`ToolCallStarted` post-gate /
//! `ToolCallCompleted`) come from the dispatch server through the same shared
//! sink, so the fold itself only emits the round-level phases
//! (`Thinking`, `ThinkingCompleted`, `RoundText`).

use std::sync::Arc;

use yoagent::types::{AgentEvent, AgentMessage, Content, Message};

use crate::model::{ThinkingTrace, TurnPhase};
use crate::session::agent_loop::{push_call, LoopRound};

use super::adapter::{emit_phase, PhaseSink, SharedTurnState};

/// What the fold accumulated off the event stream: the round-grouped trace,
/// the loop-detection annotations' honest abort reason (if any), and the
/// final message list (the termination is derived from it by the runner,
/// which also holds the cancel / abort state).
pub(crate) struct EventFold {
    pub(crate) rounds: Vec<LoopRound>,
    /// The honest failure reason when loop detection ABORTED the run
    /// (steer-only detections land as annotation rounds instead).
    pub(crate) loop_abort: Option<String>,
    /// Count of streamed assistant replies -- the upstream `round_trips`
    /// analogue (one per `generate_tool_turn` in the built-in loop), with
    /// one documented divergence: an upstream retry after a mid-stream
    /// failure starts a fresh stream and emits another `MessageStart`, so a
    /// turn that retried N times counts N round-trips where the built-in
    /// loop counts one -- `round_trips` is a loop diagnostic, not a
    /// wire-equivalence claim. A turn that dies before the stream starts
    /// (no `MessageStart`) is not counted.
    pub(crate) round_trips: u32,
    /// The run's full produced message list (from `AgentEnd`): the raw
    /// material the runner's termination derivation reads.
    pub(crate) final_messages: Vec<AgentMessage>,
}

impl EventFold {
    pub(crate) fn new() -> Self {
        Self {
            rounds: Vec::new(),
            loop_abort: None,
            round_trips: 0,
            final_messages: Vec::new(),
        }
    }

    /// Fold one event. `state` supplies the adapter-recorded trace entries
    /// (removed as consumed, so the map drains over the run).
    pub(crate) fn event(
        &mut self,
        event: &AgentEvent,
        state: &Arc<SharedTurnState>,
        phases: &PhaseSink,
    ) {
        match event {
            AgentEvent::TurnStart => {}
            AgentEvent::MessageStart {
                message: AgentMessage::Llm(Message::Assistant { .. }),
            } => {
                // The thinking wait marker rides the assistant stream start
                // (not `TurnStart`, which the upstream fires even for a turn
                // the limits check then refuses -- a phantom step would
                // diverge from the built-in loop's step semantics).
                self.round_trips += 1;
                emit_phase(
                    phases,
                    TurnPhase::Thinking {
                        attempt: self.round_trips,
                    },
                );
            }
            AgentEvent::MessageEnd {
                message: AgentMessage::Llm(Message::Assistant { content, .. }),
            } => self.assistant_reply(content, phases),
            AgentEvent::ToolExecutionEnd { tool_call_id, .. } => {
                // The adapter recorded the entry before the upstream sent
                // this event (happens-before via the event channel), so the
                // remove cannot miss a dispatched call.
                if let Some(entry) = state
                    .entries
                    .lock()
                    .expect("entries lock poisoned")
                    .remove(tool_call_id)
                {
                    push_call(&mut self.rounds, entry);
                }
            }
            AgentEvent::LoopDetected {
                tool_name,
                repetitions,
                aborted,
                ..
            } => {
                // Trace annotation (issue #668 item 5): a prose-only round --
                // the same vehicle a mid-batch cancel's prose round uses --
                // recording the detection and its escalation level.
                let annotation = format!(
                    "loop detection: `{tool_name}` called {repetitions} times with identical arguments{}",
                    if *aborted {
                        " — run stopped after steering was ignored"
                    } else {
                        " — steering the model to change approach"
                    }
                );
                if *aborted {
                    self.loop_abort = Some(format!(
                        "loop detection aborted the run: `{tool_name}` repeated {repetitions} \
                         times with identical arguments after being asked to change approach"
                    ));
                }
                self.rounds.push(LoopRound {
                    thinking: None,
                    text: Some(annotation),
                    calls: Vec::new(),
                });
            }
            AgentEvent::AgentEnd { messages, .. } => {
                // The runner derives the termination from this list (it
                // owns the cancel / abort state too).
                self.final_messages = messages.clone();
            }
            // Streaming deltas, the started half of the call pair (the
            // dispatch server owns the post-gate started event), updates,
            // progress, and prompt/tool-result message wrappers carry no
            // trace payload.
            _ => {}
        }
    }

    /// One assistant reply landed: open the round it belongs to. A
    /// tool-call batch opens a round carrying its thinking + connective
    /// prose (entries land on it as the `ToolExecutionEnd` events arrive);
    /// a terminal reply's thinking opens the thinking-only trailing round
    /// (the reply text itself rides the termination, never a round).
    fn assistant_reply(&mut self, content: &[Content], phases: &PhaseSink) {
        let thinking = thinking_trace(content);
        if let Some(trace) = thinking.as_ref() {
            emit_phase(
                phases,
                TurnPhase::ThinkingCompleted {
                    duration_ms: trace.duration_ms,
                    text: trace.text.clone(),
                },
            );
        }
        let has_calls = content
            .iter()
            .any(|c| matches!(c, Content::ToolCall { .. }));
        if has_calls {
            let prose = text_of(content);
            if let Some(t) = prose.as_ref() {
                emit_phase(phases, TurnPhase::RoundText { text: t.clone() });
            }
            self.rounds.push(LoopRound {
                thinking,
                text: prose,
                calls: Vec::new(),
            });
        } else if thinking.is_some() {
            self.rounds.push(LoopRound {
                thinking,
                text: None,
                calls: Vec::new(),
            });
        }
    }
}

/// Fold one round's thinking blocks into its trace (issue #614 semantics):
/// readable text joined in received order; redacted blocks contribute
/// nothing (honest degrade). `duration_ms` is pinned to 0 -- the built-in
/// loop's own contract for a non-fabricated thinking window, which the
/// trace equivalence (issue #668 AC) inherits field-for-field.
fn thinking_trace(blocks: &[Content]) -> Option<ThinkingTrace> {
    let text = blocks
        .iter()
        .filter_map(|c| match c {
            Content::Thinking { thinking, .. } => Some(thinking.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(ThinkingTrace {
        duration_ms: 0,
        text,
    })
}

/// The reply's connective prose: text blocks joined in order; `None` when
/// the reply carried none (a bare tool-call batch).
fn text_of(content: &[Content]) -> Option<String> {
    let text = content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}
