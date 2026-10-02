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
//! ends -- a stream cut mid-turn (a cancel before the turn's usage
//! record) parks the same way at the end -- at the run's `FinalResponse`
//! the prose is stripped (it rides the outcome body instead, mirroring
//! the external settle's #628).
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
use crate::util::{is_latched, push_capped, push_capped_emit};

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
    reasoning_committed: String,
    reasoning_deltas: String,
    text_deltas: String,
    /// The turn's finalized thinking (set at the turn's `CompletionCall`
    /// close).
    thinking_trace: Option<ThinkingTrace>,
    /// Whether this turn's batch confirmed (a committed `ToolCall` seen).
    batch_open: bool,
    /// A turn's unconfirmed round awaiting its landing -- call-less by
    /// construction (parked only when the batch never confirmed): flushed
    /// onto the trace when the next turn opens or when the stream ends
    /// (which parks a stream cut mid-turn the same way, its usage record
    /// never having arrived); at the run's `FinalResponse` the prose is
    /// stripped instead (it rides the outcome body) and a round the strip
    /// empties drops; superseded when the SAME turn's batch confirms (the
    /// thinking then rides the batch round instead; the parked prose is
    /// dropped there too -- the batch seal rebuilds the round's text off
    /// `text_deltas`).
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
            reasoning_committed: String::new(),
            reasoning_deltas: String::new(),
            text_deltas: String::new(),
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
                // The terminal text rides the outcome body under the same
                // cap the live rail rode: uncapped it is the provider's
                // verbatim output (the convergence below), capped it is
                // the parked accumulation's truncated form -- the exact
                // bytes the live rail already showed, so the outcome never
                // reveals text the live stream truncated (four-path parity
                // with the external settles' capped terminal text, issue
                // #1171).
                let capped_park = self
                    .trailing_round
                    .as_ref()
                    .and_then(|round| round.text.as_deref())
                    .filter(|text| is_latched(text))
                    .map(str::to_string);
                let was_capped = capped_park.is_some();
                self.final_output = Some(capped_park.unwrap_or_else(|| response.output.clone()));
                // The terminal reply's turn is done: land its waiting
                // trailing round, if any -- but its prose rides the
                // `final_output` (the outcome body), mirroring the external
                // settle's Text-termination clear of a trailing call-less
                // round (#628); a round the strip empties drops with it
                // (the external settle's empty-tail pop).
                if let Some(mut round) = self.trailing_round.take() {
                    // The parked prose and the terminal output accumulate
                    // the same provider text -- ADR-0126 keeps the
                    // structural side of that as a convergence obligation,
                    // and a divergence is contract drift, caught here in
                    // debug/test the way the #921 exactly-once pairing is.
                    // A capped park diverges BY DESIGN (the accumulation
                    // latched its truncation while the provider's terminal
                    // text ran past it), so the obligation holds for
                    // uncapped turns only (issue #1171).
                    if !was_capped {
                        debug_assert_eq!(round.text.as_deref(), Some(response.output.as_str()));
                    }
                    round.text = None;
                    if round.thinking.is_some() {
                        self.rounds.push(round);
                    }
                }
            }
        }
    }

    /// The stream is over: land whatever the last turn left waiting. A
    /// stream cut mid-turn (issue #1165: a cancel while the answer
    /// streamed, before the turn's usage record) never ran `close_call`,
    /// so nothing parked -- salvage the open turn's unconfirmed thinking
    /// and prose with the same finalize-and-park the close applies. The
    /// success path always arrives here closed (its terminal reply's
    /// `FinalResponse` took the park), so this arm is the cancel and
    /// abort shapes alone.
    pub(crate) fn finish(&mut self) {
        if self.call_open && !self.batch_open {
            self.finalize_thinking();
            self.park_unconfirmed();
        }
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
                // batch-confirmed round. The emission rides the track's
                // byte-cap boundary -- the rig-fold calibration (issue
                // #1171) -- through the same shared gate the external
                // paths' `push_prose` uses.
                self.open_call(phases);
                push_capped_emit(&mut self.text_deltas, &text.text, &mut |delta| {
                    emit_phase(
                        phases,
                        TurnPhase::TextDelta {
                            delta: delta.to_string(),
                        },
                    );
                });
            }
            StreamedAssistantContent::Reasoning { reasoning, .. } => {
                // A committed block supersedes its deltas (the stream
                // contract): collect the readable text; redacted /
                // encrypted payloads contribute nothing (honest degrade).
                self.open_call(phases);
                for part in &reasoning.content {
                    match part {
                        // Settle-only accumulation (no live reasoning
                        // text): the same byte cap as the prose track
                        // (issue #1171) -- a crossing block latches the
                        // marker into the finalized thinking.
                        ReasoningContent::Text { text, .. } => {
                            push_capped(&mut self.reasoning_committed, text);
                        }
                        ReasoningContent::Summary(summary) => {
                            push_capped(&mut self.reasoning_committed, summary);
                        }
                        ReasoningContent::Encrypted(_) | ReasoningContent::Redacted { .. } => {}
                    }
                }
            }
            StreamedAssistantContent::ReasoningDelta { reasoning, .. } => {
                self.open_call(phases);
                push_capped(&mut self.reasoning_deltas, reasoning);
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
                // in at the close (the batch supersedes the parked landing,
                // taking back only the thinking -- the parked prose drops
                // in favor of the rebuild below; only an EARLIER turn's
                // parked round flushes, and there cannot be one: its batch
                // or terminal reply closed it first).
                if !self.batch_open {
                    self.batch_open = true;
                    // The batch seal builds the round off `text_deltas`; the
                    // prose already streamed as `TextDelta`s (ADR-0126) --
                    // there is no batch-confirmation text event. The parked
                    // round's prose is dropped here (superseded by the same
                    // rebuild); only its thinking is taken back.
                    let thinking = self.trailing_round.take().and_then(|round| round.thinking);
                    let prose = self.text_deltas.clone();
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
    /// trailing round, open the turn with FRESH per-turn accumulators
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
        self.finalize_thinking();
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
            self.park_unconfirmed();
        }
        self.call_open = false;
    }

    /// Finalize the turn's thinking off its accumulators: committed
    /// blocks supersede their deltas. `None` when the turn streamed no
    /// readable reasoning.
    fn finalize_thinking(&mut self) {
        let thinking_text = if !self.reasoning_committed.is_empty() {
            self.reasoning_committed.clone()
        } else {
            self.reasoning_deltas.clone()
        };
        if !thinking_text.is_empty() {
            self.thinking_trace = Some(ThinkingTrace {
                duration_ms: 0,
                text: thinking_text,
            });
        }
    }

    /// Park the turn's unconfirmed thinking and prose together as the
    /// trailing round -- both or neither, the #628 symmetry the external
    /// settles apply: a cancel or hook-retry landing keeps the
    /// unconfirmed prose on the authoritative trace instead of it
    /// vanishing at the turn boundary. Call-less by construction (the
    /// batch never confirmed).
    fn park_unconfirmed(&mut self) {
        let thinking = self.thinking_trace.clone();
        let prose = self.text_deltas.clone();
        let text = (!prose.is_empty()).then_some(prose);
        self.trailing_round = (thinking.is_some() || text.is_some()).then(|| LoopRound {
            thinking,
            text,
            calls: Vec::new(),
        });
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
    use crate::util::{ACCUM_MAX_BYTES, TRUNCATION_MARKER};
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

    fn retry_item(turn: usize) -> MultiTurnStreamItem {
        MultiTurnStreamItem::ModelTurnRetried { turn }
    }

    fn committed_reasoning_item(text: &str) -> MultiTurnStreamItem {
        use rig_core::message::Reasoning;
        MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::Reasoning {
            reasoning: Reasoning {
                id: None,
                content: vec![ReasoningContent::Text {
                    text: text.into(),
                    signature: None,
                }],
            },
            id: "reasoning-0".into(),
        })
    }

    fn noop_sink() -> PhaseSink {
        Arc::new(Mutex::new(|_p: TurnPhase| {}))
    }

    fn recording_sink() -> (Arc<Mutex<Vec<TurnPhase>>>, PhaseSink) {
        let seen: Arc<Mutex<Vec<TurnPhase>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: PhaseSink = {
            let seen = Arc::clone(&seen);
            Arc::new(Mutex::new(move |p: TurnPhase| seen.lock().unwrap().push(p)))
        };
        (seen, sink)
    }

    /// `round_trips` counts model turns opened -- the driver of the
    /// `Thinking` phase's attempt number. A hook-retried turn discards its
    /// provisional content and the retry opens a fresh turn with the next
    /// attempt number. Pinned through the phase rail: two `Thinking`
    /// markers, the second at attempt 2. The event script mirrors the real
    /// streamed-driver order -- content items, then the turn's
    /// `CompletionCall` close (the gated `Final` item carries no fold
    /// weight for the attempt count and is omitted).
    #[test]
    fn round_trips_counts_streamed_turns_including_retries() {
        let channel = Arc::new(CompletionChannel::new());
        let (seen, sink) = recording_sink();
        let mut fold = EventFold::new();
        fold.event(&text_item("a"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(&retry_item(1), &channel, &sink);
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
    /// unconfirmed prose on the trace -- prose-only here (the turn
    /// streamed no reasoning); the park keeps thinking and prose
    /// together, both or neither, the #628 symmetry the external
    /// settles already apply.
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
        fold.event(&retry_item(1), &channel, &sink);
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

    /// Issue #1165: the both arm of the both-or-neither park -- a
    /// cancelled turn that streamed reasoning AND prose lands both in the
    /// same round; a thinking-only turn keeps landing its thinking (the
    /// pre-widening shape's regression guard).
    #[test]
    fn cancelled_turn_lands_thinking_with_its_prose() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(&reasoning_delta_item("half a plan"), &channel, &sink);
        fold.event(&text_item("half an answer"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let round = &fold.rounds[0];
        assert_eq!(
            round
                .thinking
                .as_ref()
                .expect("thinking parks with the prose")
                .text,
            "half a plan"
        );
        assert_eq!(round.text.as_deref(), Some("half an answer"));

        // Thinking-only (the pre-widening shape): the thinking still
        // lands, and no prose appears.
        let mut fold = EventFold::new();
        fold.event(&reasoning_delta_item("only thinking"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        assert_eq!(
            fold.rounds[0]
                .thinking
                .as_ref()
                .expect("the thinking lands")
                .text,
            "only thinking"
        );
        assert!(
            fold.rounds[0].text.is_none(),
            "nothing streamed but thinking"
        );
    }

    /// Issue #1165: a stream cut mid-turn (the cancel lands before the
    /// turn's usage record, so `close_call` never ran) still lands its
    /// unconfirmed thinking and prose -- `finish` salvages the open turn
    /// with the same finalize-and-park the close applies. A prose-only
    /// cut lands the prose alone.
    #[test]
    fn mid_stream_cancel_salvages_the_open_turn() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(&reasoning_delta_item("cut mid-thought"), &channel, &sink);
        fold.event(&text_item("cut mid-ans"), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let round = &fold.rounds[0];
        assert_eq!(
            round
                .thinking
                .as_ref()
                .expect("the cut turn's thinking is salvaged")
                .text,
            "cut mid-thought"
        );
        assert_eq!(round.text.as_deref(), Some("cut mid-ans"));
        assert!(round.calls.is_empty(), "nothing executed, nothing landed");

        // A prose-only cut: the prose lands alone.
        let mut fold = EventFold::new();
        fold.event(&text_item("cut mid-sentence"), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        assert_eq!(fold.rounds[0].text.as_deref(), Some("cut mid-sentence"));
        assert!(
            fold.rounds[0].thinking.is_none(),
            "no reasoning streamed, none salvaged"
        );
    }

    /// The next-turn-open flush: two consecutive call-less turns each
    /// land their own round -- the second turn's open flushes the first
    /// turn's park before a second park could overwrite it (no
    /// collision), and the stream-end flush lands the last one.
    #[test]
    fn next_open_flushes_the_waiting_round() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(&text_item("first"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(&text_item("second"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 2, "{:?}", fold.rounds);
        assert_eq!(fold.rounds[0].text.as_deref(), Some("first"));
        assert_eq!(fold.rounds[1].text.as_deref(), Some("second"));
    }

    /// ADR-0126's rig-fold calibration (issue #1171): the prose
    /// accumulation rides the 8MB cap on both tracks at once -- the
    /// crossing chunk's delta is followed by one final marker delta and
    /// later chunks emit nothing (live), while the settle round latches
    /// the marker and drops later fragments. The live rail and the
    /// settle round stay byte-identical, the same boundary the external
    /// paths' `push_prose` rides.
    #[test]
    fn prose_cap_latches_marker_and_stops_both_tracks() {
        let channel = Arc::new(CompletionChannel::new());
        let (seen, sink) = recording_sink();
        let mut fold = EventFold::new();
        fold.event(
            &text_item(&"x".repeat(ACCUM_MAX_BYTES - 4)),
            &channel,
            &sink,
        );
        fold.event(&text_item("cross"), &channel, &sink);
        fold.event(&text_item("tail"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        let expected = format!(
            "{}cross{}",
            "x".repeat(ACCUM_MAX_BYTES - 4),
            TRUNCATION_MARKER
        );
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let settle = fold.rounds[0]
            .text
            .as_deref()
            .expect("the capped prose parks");
        assert_eq!(
            settle.len(),
            expected.len(),
            "the settle round latches the marker and drops the tail"
        );
        assert!(settle.ends_with(TRUNCATION_MARKER));
        let deltas = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|p| match p {
                TurnPhase::TextDelta { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            deltas.len(),
            3,
            "the crossing chunk delta + one marker delta; the tail emits nothing"
        );
        assert_eq!(deltas[0].len(), ACCUM_MAX_BYTES - 4);
        assert_eq!(deltas[1], "cross");
        assert_eq!(deltas[2], TRUNCATION_MARKER);
        assert!(
            deltas.concat() == settle,
            "live and settle share the same bytes"
        );
    }

    /// The thinking track rides the same cap (issue #1171): a committed
    /// block crossing 8MB latches the marker into the finalized thinking --
    /// settle-only, no live prose to diverge.
    #[test]
    fn committed_reasoning_cap_latches_marker_into_thinking() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(
            &committed_reasoning_item(&"r".repeat(ACCUM_MAX_BYTES)),
            &channel,
            &sink,
        );
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let thinking = fold.rounds[0]
            .thinking
            .as_ref()
            .expect("the capped thinking lands");
        assert_eq!(
            thinking.text.len(),
            ACCUM_MAX_BYTES + TRUNCATION_MARKER.len()
        );
        assert!(thinking.text.ends_with(TRUNCATION_MARKER));
    }

    /// The reasoning-delta track caps independently of the committed one
    /// (issue #1171): post-cap deltas drop, the finalized thinking carries
    /// the marker.
    #[test]
    fn reasoning_delta_cap_latches_marker_into_thinking() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(
            &reasoning_delta_item(&"d".repeat(ACCUM_MAX_BYTES)),
            &channel,
            &sink,
        );
        fold.event(&reasoning_delta_item("more"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let thinking = fold.rounds[0]
            .thinking
            .as_ref()
            .expect("the capped thinking lands");
        assert_eq!(
            thinking.text.len(),
            ACCUM_MAX_BYTES + TRUNCATION_MARKER.len(),
            "the post-cap delta drops"
        );
        assert!(thinking.text.ends_with(TRUNCATION_MARKER));
    }

    /// The `FinalResponse` convergence obligation holds for uncapped turns
    /// only (issue #1171): a capped park diverges from the provider's own
    /// terminal text BY DESIGN, so the debug assert stands down -- and the
    /// outcome body rides the capped form, the exact bytes the live rail
    /// showed (four-path parity with the external settles' capped
    /// terminal text).
    #[test]
    fn final_response_keeps_the_capped_terminal_body() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new();
        fold.event(&text_item(&"x".repeat(ACCUM_MAX_BYTES)), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(
            &final_response_item("the full uncapped answer"),
            &channel,
            &sink,
        );
        assert!(
            fold.rounds.is_empty(),
            "a prose-only park drops after the strip"
        );
        let body = fold
            .final_output
            .as_deref()
            .expect("the outcome body lands");
        assert_eq!(
            body.len(),
            ACCUM_MAX_BYTES + TRUNCATION_MARKER.len(),
            "the outcome body rides the capped form, not the raw terminal text"
        );
        assert!(body.ends_with(TRUNCATION_MARKER));
    }
}
