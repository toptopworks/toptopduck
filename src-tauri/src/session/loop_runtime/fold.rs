//! The event fold (ADR-0116, issue #917): maps rig's `MultiTurnStreamItem`
//! stream onto the app's trace vocabulary -- round grouping (ADR-0103, one
//! round per assistant tool-call batch), thinking (raw model reasoning,
//! duration pinned to 0 like every non-fabricated thinking window, the #612
//! precedent), connective prose, tool batches -- plus the live ADR-0059
//! phase rail. The ADR-0107 Decision 4 equivalence surface, restated for
//! the rig event shapes.
//!
//! Event order this state machine is written against (the streamed-driver
//! contract): the provider's content deltas, then its `CompletionCall`
//! usage record, then the stream's terminal `Final` record -- which rig
//! forwards ONLY for turns that streamed text (`emit_final = saw_text`,
//! upstream streamed.rs), so a reasoning-plus-calls turn with no prose
//! never sees one -- and only THEN the committed `ToolCall` items for the
//! batch rig routed (they follow the turn assembly), with
//! `ToolExecutionCommitted` / `StreamUserItem` pairs settling afterwards,
//! in call order. So: a model turn opens at its first streamed item
//! (`Thinking` -- the yoagent layer's `MessageStart` equivalent), its
//! thinking finalizes at its `CompletionCall` record (`ThinkingCompleted`
//! -- the `MessageEnd` equivalent; the usage record arrives exactly once
//! per turn, text-bearing or not, which the gated `Final` item does not),
//! and the round boundary is the FIRST committed `ToolCall` after it --
//! the moment the batch is known. A terminal reply (no calls) never opens
//! a round; its thinking waits as a trailing round, flushed when the next
//! turn opens, at the run's `FinalResponse`, or when the stream ends.
//! Completed calls land on the open round from the shared state's
//! completion queue, one per executed-tool-result event, in the sequential
//! strategy's stable call order.

use rig_agent::agent::MultiTurnStreamItem;
use rig_core::message::ReasoningContent;
use rig_core::streaming::StreamedAssistantContent;

use crate::model::{ThinkingTrace, TurnPhase};
use crate::session::loop_contract::{push_call, LoopRound};

use super::adapter::{emit_phase, PhaseSink, SharedTurnState};
use std::sync::Arc;

/// What the fold accumulated off the event stream: the round-grouped trace,
/// the completed model-call count, and the terminal reply's text (the
/// termination derivation -- which the runner owns, along with the cancel /
/// abort state -- reads it when no cancel intervened).
pub(crate) struct EventFold {
    pub(crate) rounds: Vec<LoopRound>,
    /// Count of model turns opened -- the yoagent layer's `round_trips`
    /// analogue (the `Thinking` phase's attempt number, keyed on turns
    /// opened the way `MessageStart` counted streams). Same documented
    /// divergence: a hook-rejected turn retried by the runtime opens a fresh
    /// turn and counts again.
    pub(crate) round_trips: u32,
    /// The terminal reply's text, set by the run's `FinalResponse`.
    pub(crate) final_output: Option<String>,
    /// --- Per-model-call accumulation (replaced at each turn open) ---
    call_open: bool,
    reasoning_committed: Vec<String>,
    reasoning_deltas: Vec<String>,
    text_deltas: Vec<String>,
    /// The turn's finalized thinking (set at the turn's `CompletionCall`
    /// close).
    thinking_trace: Option<ThinkingTrace>,
    /// Whether this turn's batch confirmed (a committed `ToolCall` seen).
    batch_open: bool,
    /// A finished thinking-only turn awaiting its landing: flushed onto the
    /// trace when the next turn opens, at the run's `FinalResponse`, or
    /// when the stream ends, or superseded when the SAME turn's batch
    /// confirms (the thinking then rides the batch round instead).
    trailing_thinking: Option<LoopRound>,
}

impl EventFold {
    pub(crate) fn new() -> Self {
        Self {
            rounds: Vec::new(),
            round_trips: 0,
            final_output: None,
            call_open: false,
            reasoning_committed: Vec::new(),
            reasoning_deltas: Vec::new(),
            text_deltas: Vec::new(),
            thinking_trace: None,
            batch_open: false,
            trailing_thinking: None,
        }
    }

    /// Fold one event. `state` supplies the dispatch-recorded trace entries
    /// (drained in order, one per executed-tool-result event).
    pub(crate) fn event(
        &mut self,
        item: &MultiTurnStreamItem,
        state: &Arc<SharedTurnState>,
        phases: &PhaseSink,
    ) {
        match item {
            MultiTurnStreamItem::StreamAssistantItem(content) => {
                self.assistant_item(content, phases);
            }
            MultiTurnStreamItem::ToolExecutionCommitted { .. } => {
                // Execution confirmation, surfaced only after the batch
                // settles; the trace entry rides the result event below.
            }
            MultiTurnStreamItem::StreamUserItem(_) => {
                // One executed (or framework-skipped) call's result, in call
                // order: land its dispatch-recorded entry on the open round.
                // A result with no queued entry is a framework-side result
                // (a skipped call -- none of ours) and lands nothing.
                if let Some(entry) = state
                    .completed
                    .lock()
                    .expect("completed lock poisoned")
                    .pop_front()
                {
                    push_call(&mut self.rounds, entry);
                }
            }
            MultiTurnStreamItem::CompletionCall(_) => {
                // The model call's usage record -- emitted exactly once per
                // turn, after every content item, whether or not the turn
                // streamed text. That makes it the turn's closing boundary
                // (the `Final` item below is gated on text-bearing turns by
                // rig's emit_final, so a reasoning-plus-calls turn with no
                // prose would otherwise never close): finalize the thinking,
                // park a call-less turn's trailing round, end the turn.
                self.close_call(phases);
            }
            MultiTurnStreamItem::ModelTurnRetried { .. } => {
                // The turn's provisional deltas are discarded; a
                // thinking-only round the failed attempt parked at its close
                // still lands here (the attempted thinking is recorded
                // honesty, not rolled back -- the one deliberate divergence
                // from the yoagent twin, which discards the whole attempt).
                // The retry opens a fresh turn (counted on its first item,
                // the documented retry divergence).
                self.reset_call();
            }
            MultiTurnStreamItem::FinalResponse(response) => {
                self.final_output = Some(response.output.clone());
                // The terminal reply's turn is done: land its waiting
                // thinking-only round, if any.
                self.flush_trailing();
            }
        }
    }

    /// The stream is over: land whatever the last turn left waiting.
    pub(crate) fn finish(&mut self) {
        self.flush_trailing();
    }

    /// One streamed assistant item.
    fn assistant_item(&mut self, content: &StreamedAssistantContent, phases: &PhaseSink) {
        match content {
            StreamedAssistantContent::Text(text) => {
                self.open_call(phases);
                self.text_deltas.push(text.text.clone());
            }
            StreamedAssistantContent::Reasoning { reasoning, .. } => {
                // A committed block supersedes its deltas (the stream
                // contract): collect the readable text; redacted /
                // encrypted payloads contribute nothing (honest degrade).
                self.open_call(phases);
                for part in &reasoning.content {
                    match part {
                        ReasoningContent::Text { text, .. } => {
                            self.reasoning_committed.push(text.clone())
                        }
                        ReasoningContent::Summary(summary) => {
                            self.reasoning_committed.push(summary.clone())
                        }
                        ReasoningContent::Encrypted(_) | ReasoningContent::Redacted { .. } => {}
                    }
                }
            }
            StreamedAssistantContent::ReasoningDelta { reasoning, .. } => {
                self.open_call(phases);
                self.reasoning_deltas.push(reasoning.clone());
            }
            StreamedAssistantContent::ToolCallDelta { .. } => {
                // Argument fragments carry no trace payload; a delta-level
                // cancel checkpoint rides the watcher hook, not the fold.
                self.open_call(phases);
            }
            StreamedAssistantContent::ToolCall { .. } => {
                // The first committed call confirms the batch: the round
                // boundary. Committed calls always follow their own turn's
                // `CompletionCall` close (the turn assembles before the
                // batch routes), so the turn is already closed and this is
                // never a turn's first item. The turn's thinking rides the
                // batch round -- taken back from the trailing slot it parked
                // in at the close (the batch supersedes the thinking-only
                // landing; only an EARLIER turn's parked round flushes, and
                // there cannot be one: its batch or terminal reply closed it
                // first).
                if !self.batch_open {
                    self.batch_open = true;
                    let thinking = self
                        .trailing_thinking
                        .take()
                        .and_then(|round| round.thinking);
                    let prose = self.text_deltas.join("");
                    let text = (!prose.is_empty()).then_some(prose);
                    if let Some(t) = text.as_ref() {
                        emit_phase(phases, TurnPhase::RoundText { text: t.clone() });
                    }
                    self.rounds.push(LoopRound {
                        thinking,
                        text,
                        calls: Vec::new(),
                    });
                }
            }
            StreamedAssistantContent::Final(_) => {
                // The provider stream's terminal record for a text-bearing
                // turn (rig forwards it only when the turn streamed text --
                // emit_final gating, upstream streamed.rs -- so a
                // reasoning-plus-calls turn with no prose never sees one).
                // Nothing to fold: the turn's actual closing (thinking
                // finalize, trailing park, turn end) rides the CompletionCall
                // usage record, which arrives for every turn.
            }
            StreamedAssistantContent::Unknown(_) => {
                // Provider-native unmodeled item; nothing to fold.
            }
        }
    }

    /// The turn's first streamed item: flush the previous turn's waiting
    /// thinking-only round, open the turn with FRESH per-turn accumulators
    /// (a turn's deltas and committed blocks never bleed into the next --
    /// the scoping is structural, not a convention the close has to
    /// remember), and fire the `Thinking` wait marker. The batch-confirmed
    /// flag resets with the turn -- a fresh model turn has no confirmed
    /// batch yet.
    fn open_call(&mut self, phases: &PhaseSink) {
        if !self.call_open {
            self.call_open = true;
            self.round_trips += 1;
            self.flush_trailing();
            self.batch_open = false;
            self.reasoning_committed.clear();
            self.reasoning_deltas.clear();
            self.text_deltas.clear();
            self.thinking_trace = None;
            emit_phase(
                phases,
                TurnPhase::Thinking {
                    attempt: self.round_trips,
                },
            );
        }
    }

    /// The turn's closing boundary (its `CompletionCall` usage record):
    /// finalize the thinking off this turn's accumulators, fire
    /// `ThinkingCompleted`, park a call-less turn's thinking as the trailing
    /// round until its batch confirms or the run ends, and end the turn.
    /// The accumulators themselves are cleared at the next open (the
    /// committed-ToolCall batch confirmation reads this turn's text after
    /// the close).
    fn close_call(&mut self, phases: &PhaseSink) {
        // Defensive open: a close before any content item (an empty turn)
        // still counts and still closes.
        self.open_call(phases);
        let thinking_text = if !self.reasoning_committed.is_empty() {
            self.reasoning_committed.join("")
        } else {
            self.reasoning_deltas.join("")
        };
        if !thinking_text.is_empty() {
            self.thinking_trace = Some(ThinkingTrace {
                duration_ms: 0,
                text: thinking_text,
            });
        }
        if let Some(trace) = self.thinking_trace.as_ref() {
            emit_phase(
                phases,
                TurnPhase::ThinkingCompleted {
                    duration_ms: trace.duration_ms,
                    text: trace.text.clone(),
                },
            );
        }
        if !self.batch_open {
            self.trailing_thinking = self.thinking_trace.clone().map(|thinking| LoopRound {
                thinking: Some(thinking),
                text: None,
                calls: Vec::new(),
            });
        }
        self.call_open = false;
    }

    /// Land the waiting thinking-only round, if one waits.
    fn flush_trailing(&mut self) {
        if let Some(round) = self.trailing_thinking.take() {
            self.rounds.push(round);
        }
    }

    /// Clear the per-call accumulation (turn boundary: a retry).
    fn reset_call(&mut self) {
        self.call_open = false;
        self.reasoning_committed.clear();
        self.reasoning_deltas.clear();
        self.text_deltas.clear();
        self.thinking_trace = None;
        self.batch_open = false;
        self.flush_trailing();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// `round_trips` counts completed model calls -- the driver of the
    /// `Thinking` phase's attempt number. A hook-retried turn discards its
    /// provisional content and the retry opens a fresh turn with the next
    /// attempt number (the documented divergence, matching the yoagent
    /// layer's count). Pinned through the phase rail: two `Thinking`
    /// markers, the second at attempt 2. The event script mirrors the real
    /// streamed-driver order -- content items, then the turn's
    /// `CompletionCall` close (the gated `Final` item is deliberately absent,
    /// as it is for any turn that streamed no text).
    #[test]
    fn round_trips_counts_streamed_turns_including_retries() {
        let state = Arc::new(SharedTurnState::new());
        let seen: Arc<Mutex<Vec<TurnPhase>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: PhaseSink = {
            let seen = Arc::clone(&seen);
            Arc::new(std::sync::Mutex::new(move |p: TurnPhase| {
                seen.lock().unwrap().push(p)
            }))
        };
        let mut fold = EventFold::new();
        let text =
            |t: &str| MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::text(t));
        let close = || {
            MultiTurnStreamItem::CompletionCall(rig_agent::agent::CompletionCall::new(
                0,
                rig_core::completion::Usage::new(),
            ))
        };
        fold.event(&text("a"), &state, &sink);
        fold.event(&close(), &state, &sink);
        fold.event(
            &MultiTurnStreamItem::ModelTurnRetried { turn: 1 },
            &state,
            &sink,
        );
        fold.event(&text("b"), &state, &sink);
        fold.event(&close(), &state, &sink);
        fold.finish();
        let attempts = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|p| match p {
                TurnPhase::Thinking { attempt } => Some(*attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(attempts, vec![1, 2], "one per turn open, retries included");
    }
}
