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
//! (`Thinking`), its
//! thinking finalizes at its `CompletionCall` record (`ThinkingCompleted`;
//! the usage record arrives exactly once
//! per turn, text-bearing or not, which the gated `Final` item does not),
//! and the round boundary is the FIRST committed `ToolCall` after it --
//! the moment the batch is known. A terminal reply (no calls) never opens
//! a round; its thinking and unconfirmed prose wait as a trailing round
//! (issue #1165), flushed when the next turn opens or when the stream
//! ends -- at the run's `FinalResponse` the prose is stripped (it rides
//! the outcome body instead, mirroring the external settle's #628).
//! Completed calls land on the open round from the shared state's
//! completion queue, one per executed-tool-result event, in the sequential
//! strategy's stable call order -- and, for the entries a cancellation
//! leaves queued when it abandons the stream mid-call, through the
//! finish-time residual drain (#921), so an executed call accounts
//! whichever way the run ended.

use rig_agent::agent::MultiTurnStreamItem;
use rig_core::message::ReasoningContent;
use rig_core::streaming::StreamedAssistantContent;

use crate::model::{ThinkingTrace, TurnPhase};
use crate::session::loop_contract::{push_call, LoopRound};

use super::adapter::{emit_phase, CompletionChannel, PhaseSink};
use std::sync::Arc;

/// What the fold accumulated off the event stream: the round-grouped trace,
/// the completed model-call count, and the terminal reply's text (the
/// termination derivation -- which the runner owns, along with the cancel /
/// abort state -- reads it when no cancel intervened).
pub(crate) struct EventFold {
    pub(crate) rounds: Vec<LoopRound>,
    /// Count of model turns opened -- the `Thinking` phase's attempt
    /// number, keyed on turns opened: a hook-rejected turn retried by the
    /// runtime opens a fresh turn and counts again.
    pub(crate) round_trips: u32,
    /// The terminal reply's text, set by the run's `FinalResponse`.
    pub(crate) final_output: Option<String>,
    /// Count of dispatch-recorded trace entries landed on the trace (by
    /// result event below, or by the finish-time residual drain). The
    /// landed side of the exactly-once pairing the runner's finish
    /// asserts against the shared state's record count (#921).
    pub(crate) landed_calls: usize,
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
    /// A finished turn's unconfirmed round awaiting its landing: flushed
    /// onto the trace when the next turn opens, at the run's
    /// `FinalResponse`, or when the stream ends, or superseded when the
    /// SAME turn's batch confirms (the thinking then rides the batch round
    /// instead; the parked prose is dropped there too -- the batch seal
    /// rebuilds the round's text off `text_deltas`).
    trailing_round: Option<LoopRound>,
}

impl EventFold {
    pub(crate) fn new() -> Self {
        Self {
            rounds: Vec::new(),
            round_trips: 0,
            final_output: None,
            landed_calls: 0,
            call_open: false,
            reasoning_committed: Vec::new(),
            reasoning_deltas: Vec::new(),
            text_deltas: Vec::new(),
            thinking_trace: None,
            batch_open: false,
            trailing_round: None,
        }
    }

    /// Fold one event. `channel` supplies the dispatch-recorded trace
    /// entries for THIS fold's consumer family (drained in order, one per
    /// executed-tool-result event) -- the main fold passes the main
    /// channel, a sub-agent's fold its private one (#944).
    pub(crate) fn event(
        &mut self,
        item: &MultiTurnStreamItem,
        channel: &Arc<CompletionChannel>,
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
                if let Some(entry) = channel
                    .completed
                    .lock()
                    .expect("completed lock poisoned")
                    .pop_front()
                {
                    push_call(&mut self.rounds, entry);
                    self.landed_calls += 1;
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
                // The turn's provisional deltas are discarded; the round the
                // failed attempt parked at its close (its thinking and its
                // unconfirmed prose, issue #1165) still lands here -- the
                // attempted content is recorded honesty, not rolled back.
                // The retry opens a fresh turn (counted on its first item).
                self.reset_call();
            }
            MultiTurnStreamItem::FinalResponse(response) => {
                self.final_output = Some(response.output.clone());
                // The terminal reply's turn is done: land its waiting
                // trailing round, if any -- but its prose rides the
                // `final_output` (the outcome body), mirroring the external
                // settle's Text-termination clear of a trailing call-less
                // round (#628); a round the strip empties drops with it
                // (the external settle's empty-tail pop).
                if let Some(mut round) = self.trailing_round.take() {
                    round.text = None;
                    if round.thinking.is_some() {
                        self.rounds.push(round);
                    }
                }
            }
        }
    }

    /// The stream is over: land whatever the last turn left waiting.
    pub(crate) fn finish(&mut self) {
        self.flush_trailing();
    }

    /// Drain residual completed entries onto the open round (#921): a
    /// cancellation that abandoned the event stream mid-call leaves
    /// executed calls' entries queued with no result event ever coming for
    /// them -- the record-before-send site already accounted them, so the
    /// runner's finish lands them here instead. Returns how many entries
    /// it landed (the pairing accounting).
    pub(crate) fn drain_residual(&mut self, channel: &Arc<CompletionChannel>) -> usize {
        let mut queue = channel.completed.lock().expect("completed lock poisoned");
        let drained = queue.len();
        for entry in queue.drain(..) {
            push_call(&mut self.rounds, entry);
        }
        self.landed_calls += drained;
        drained
    }

    /// One streamed assistant item.
    fn assistant_item(&mut self, content: &StreamedAssistantContent, phases: &PhaseSink) {
        match content {
            StreamedAssistantContent::Text(text) => {
                // ADR-0126: the fragment streams live the moment it arrives
                // (after the turn-opening `Thinking`, so `live.step` is
                // known), while `text_deltas` keeps accumulating toward the
                // batch-confirmed round. An empty fragment emits nothing.
                self.open_call(phases);
                if !text.text.is_empty() {
                    emit_phase(
                        phases,
                        TurnPhase::TextDelta {
                            delta: text.text.clone(),
                        },
                    );
                }
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
                    // The batch seal builds the round off `text_deltas`; the
                    // prose already streamed as `TextDelta`s (ADR-0126) --
                    // there is no batch-confirmation text event. The parked
                    // round's prose is dropped here (superseded by the same
                    // rebuild); only its thinking is taken back.
                    let thinking = self.trailing_round.take().and_then(|round| round.thinking);
                    let prose = self.text_deltas.join("");
                    let text = (!prose.is_empty()).then_some(prose);
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
    /// `ThinkingCompleted`, park a call-less turn's thinking and prose as
    /// the trailing round until its batch confirms or the run ends, and end
    /// the turn. The accumulators themselves are cleared at the next open
    /// (the committed-ToolCall batch confirmation reads this turn's text
    /// after the close).
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
            // Park the unconfirmed turn's thinking AND prose together
            // (issue #1165): a cancel or hook retry landing keeps both or
            // neither -- the #628 symmetry the external settles apply -- so
            // the unconfirmed prose reaches the authoritative trace instead
            // of vanishing at the turn boundary.
            let thinking = self.thinking_trace.clone();
            let prose = self.text_deltas.join("");
            let text = (!prose.is_empty()).then_some(prose);
            self.trailing_round = (thinking.is_some() || text.is_some()).then(|| LoopRound {
                thinking,
                text,
                calls: Vec::new(),
            });
        }
        self.call_open = false;
    }

    /// Land the waiting trailing round, if one waits.
    fn flush_trailing(&mut self) {
        if let Some(round) = self.trailing_round.take() {
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

    fn text_item(t: &str) -> MultiTurnStreamItem {
        MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::text(t))
    }

    fn reasoning_delta_item(t: &str) -> MultiTurnStreamItem {
        MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ReasoningDelta {
            id: "reasoning-0".into(),
            provider_id: None,
            reasoning: t.into(),
        })
    }

    fn close_item() -> MultiTurnStreamItem {
        MultiTurnStreamItem::CompletionCall(rig_agent::agent::CompletionCall::new(
            0,
            rig_core::completion::Usage::new(),
        ))
    }

    fn final_response_item(output: &str) -> MultiTurnStreamItem {
        MultiTurnStreamItem::FinalResponse(rig_agent::agent::PromptResponse::new(
            output,
            rig_core::completion::Usage::new(),
        ))
    }

    fn noop_sink() -> PhaseSink {
        Arc::new(std::sync::Mutex::new(|_p: TurnPhase| {}))
    }

    /// `round_trips` counts model turns opened -- the driver of the
    /// `Thinking` phase's attempt number. A hook-retried turn discards its
    /// provisional content and the retry opens a fresh turn with the next
    /// attempt number. Pinned through the phase rail: two `Thinking`
    /// markers, the second at attempt 2. The event script mirrors the real
    /// streamed-driver order -- content items, then the turn's
    /// `CompletionCall` close (the gated `Final` item is deliberately absent,
    /// as it is for any turn that streamed no text).
    #[test]
    fn round_trips_counts_streamed_turns_including_retries() {
        let channel = Arc::new(CompletionChannel::new());
        let seen: Arc<Mutex<Vec<TurnPhase>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: PhaseSink = {
            let seen = Arc::clone(&seen);
            Arc::new(std::sync::Mutex::new(move |p: TurnPhase| {
                seen.lock().unwrap().push(p)
            }))
        };
        let mut fold = EventFold::new();
        fold.event(&text_item("a"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(
            &MultiTurnStreamItem::ModelTurnRetried { turn: 1 },
            &channel,
            &sink,
        );
        fold.event(&text_item("b"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
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

    /// Issue #1165: a cancelled turn (the stream ends after the turn's
    /// closing usage record, before any batch confirms) lands its
    /// unconfirmed prose on the trace with its trailing thinking -- both
    /// or neither, the #628 symmetry the external settles already apply.
    #[test]
    fn cancelled_turn_lands_its_unconfirmed_prose() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(&text_item("partial answer"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        assert_eq!(
            fold.rounds[0].text.as_deref(),
            Some("partial answer"),
            "the unconfirmed prose lands on the trace"
        );
        assert!(
            fold.rounds[0].thinking.is_none(),
            "a prose-only turn parks no thinking"
        );
    }

    /// Issue #1165: a hook-rejected turn's unconfirmed prose lands with
    /// its parked round (the attempted honesty the retry landing already
    /// records for thinking); the fresh attempt starts clean.
    #[test]
    fn retried_turn_lands_its_unconfirmed_prose() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(&text_item("rejected attempt"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(
            &MultiTurnStreamItem::ModelTurnRetried { turn: 1 },
            &channel,
            &sink,
        );
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        assert_eq!(
            fold.rounds[0].text.as_deref(),
            Some("rejected attempt"),
            "the rejected attempt's prose lands as attempted honesty"
        );
        assert!(
            fold.rounds[0].calls.is_empty(),
            "nothing executed, nothing landed"
        );
    }

    /// Issue #1165: the terminal reply's prose rides the `final_output`
    /// (the outcome body), never the trace -- the parked round lands
    /// thinking-only when it has thinking, mirroring the external
    /// settle's Text-termination clear (#628), and a prose-only parked
    /// round drops entirely.
    #[test]
    fn final_response_strips_the_terminal_prose() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(&reasoning_delta_item("thinking hard"), &channel, &sink);
        fold.event(&text_item("the answer"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(&final_response_item("the answer"), &channel, &sink);
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        assert_eq!(
            fold.rounds[0]
                .thinking
                .as_ref()
                .expect("the parked thinking lands")
                .text,
            "thinking hard"
        );
        assert!(
            fold.rounds[0].text.is_none(),
            "the terminal prose rides the final_output, not the trace"
        );
        assert_eq!(fold.final_output.as_deref(), Some("the answer"));

        // A prose-only terminal turn parks nothing that survives the
        // strip: no round lands.
        let mut fold = EventFold::new();
        fold.event(&text_item("plain answer"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(&final_response_item("plain answer"), &channel, &sink);
        assert!(fold.rounds.is_empty(), "{:?}", fold.rounds);
        assert_eq!(fold.final_output.as_deref(), Some("plain answer"));
    }
}
