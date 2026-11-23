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
use rig_core::message::{ReasoningContent, ToolResult, ToolResultContent};
use rig_core::streaming::{StreamedAssistantContent, StreamedUserContent};

use crate::approval::OperationKind;
use crate::model::{Protocol, ThinkingTrace, TokenUsage, TurnPhase};
use crate::session::loop_contract::{push_call, LoopRound, TraceEntry};
use crate::util::{is_latched, push_capped, push_capped_emit};

use super::adapter::{emit_phase, CompletionChannel, PhaseSink};
use std::sync::Arc;

/// Normalize rig's crate-level `Usage` onto the app's five-field shape at
/// the collection point (ADR-0129 Decision 1 -- the ONE place the built-in
/// channel touches upstream usage fields). Rig keeps the two wire
/// families' input semantics distinct:
/// - Anthropic wires report cache read/write ALONGSIDE `input_tokens`
///   (rig's `anthropic_usage_totals` leaves the crate-level field
///   ordinary-only), so the total-side input is the three-way sum.
/// - The OpenAI family reports input with cache inside; `cached` is a
///   subset and the total-side input is taken verbatim.
///
/// Rig documents zero-valued `Usage` as "the provider reported no usage
/// metrics" -- the fail-closed sentinel (ADR-0129 Decision 3): a zero
/// report normalizes to `None`, never a zero bill.
pub(crate) fn normalize_rig_usage(
    usage: &rig_core::completion::Usage,
    protocol: Option<Protocol>,
) -> Option<TokenUsage> {
    let ordinary_input = usage.input_tokens;
    let read = usage.cached_input_tokens;
    let write = usage.cache_creation_input_tokens;
    if ordinary_input == 0 && usage.output_tokens == 0 && read == 0 && write == 0 {
        return None;
    }
    let input = match protocol {
        Some(Protocol::Anthropic) => ordinary_input.saturating_add(read).saturating_add(write),
        // The OpenAI family's input already contains its cache; adding the
        // subsets would double-count. The bridged test face rides the same
        // arm: its scripted replies either report nothing (zero sentinel)
        // or carry a total-side shape already.
        Some(Protocol::Openai) | None => ordinary_input,
    };
    Some(TokenUsage {
        input_tokens: input,
        cache_read_tokens: read,
        cache_write_tokens: write,
        output_tokens: usage.output_tokens,
        reasoning_tokens: (usage.reasoning_tokens > 0).then_some(usage.reasoning_tokens),
    })
}

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
    /// The round-trip usage sum (ADR-0129 Decision 2): each
    /// `CompletionCall` record normalizes onto the five-field shape and
    /// accumulates here. The protocol rides the fold because rig's
    /// crate-level `Usage` keeps the two wire families' input semantics
    /// distinct (Anthropic reports cache alongside input; the OpenAI
    /// family inside it) -- the collection point must split on it or
    /// double-count cache (ADR-0129 Decision 1).
    usage: TokenUsage,
    protocol: Option<Protocol>,
    /// The LAST round-trip's normalized usage (ADR-0130 Decision 2): the
    /// occupancy numerator's latch. Each usage record replaces it -- the
    /// last round-trip is the freshest context measurement, so a turn cut
    /// after a record (a cancel between rounds) keeps the reading it earned
    /// (the same already-reported rule the usage sum applies). `None` until
    /// the first round-trip reports (fail-closed, no zero reading).
    last_roundtrip_usage: Option<TokenUsage>,
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
    /// Count of `ToolExecutionCommitted` items whose paired result event
    /// has not arrived yet -- the reconciliation key between a result
    /// event and the dispatch-recorded entry queue (issue #1625). An
    /// executed call's result is always preceded by its execution
    /// confirmation; a framework-side synthetic result (an
    /// invalid-tool-call Skip's feedback) never is. The app's trace
    /// entries carry no rig call id to pair on (the gateway adapter mints
    /// its own ids -- rig's callback surface hands over no call id), so
    /// the confirmation count is the one discriminator the stream itself
    /// carries.
    ///
    /// A commit-less result has a second producer in rig's contract -- an
    /// `on_tool_call` hook that skips a VALID call lands its result with
    /// no confirmation (and would take the synthetic-row arm here). No
    /// hook of ours skips valid calls today; registering one must re-read
    /// this reconciliation.
    pending_results: usize,
}

impl EventFold {
    /// `protocol` selects the normalization arm for rig's `Usage`
    /// (see [`Self::usage`]); `None` is the bridged test face.
    pub(crate) fn new(protocol: Option<Protocol>) -> Self {
        Self {
            rounds: Vec::new(),
            round_trips: 0,
            final_output: None,
            landed_calls: 0,
            usage: TokenUsage::default(),
            protocol,
            last_roundtrip_usage: None,
            call_open: false,
            reasoning_committed: String::new(),
            reasoning_deltas: String::new(),
            text_deltas: String::new(),
            thinking_trace: None,
            batch_open: false,
            trailing_round: None,
            pending_results: 0,
        }
    }

    /// The fold's accumulated usage (ADR-0129): the round-trip sum, or
    /// `None` when no round-trip ever reported (fail-closed, Decision 3) --
    /// which also covers a turn cancelled before its first usage record.
    pub(crate) fn usage(&self) -> Option<TokenUsage> {
        (!self.usage.is_zero()).then_some(self.usage)
    }

    /// The turn's occupancy numerator (ADR-0130 Decision 2): the LAST
    /// round-trip's context size, protocol-split. `None` when no round-trip
    /// reported usage (the same fail-closed posture as [`Self::usage`]) --
    /// a hollow ring, never a zero reading.
    pub(crate) fn occupancy(&self) -> Option<crate::model::OccupancySnapshot> {
        self.last_roundtrip_usage
            .map(|last| crate::model::OccupancySnapshot::from_last_roundtrip(last, self.protocol))
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
                // Counting the confirmation keys the result-event
                // reconciliation below (issue #1625): only a confirmed
                // execution's result may consume a queued dispatch entry.
                self.pending_results += 1;
            }
            MultiTurnStreamItem::StreamUserItem(StreamedUserContent::ToolResult {
                tool_result,
                ..
            }) => {
                // One call's result, in call order. A confirmed execution
                // (its `ToolExecutionCommitted` counted above) lands its
                // dispatch-recorded entry on the open round; a result with
                // NO confirmed execution is framework-side -- an
                // invalid-tool-call Skip's synthetic feedback (issue #1625)
                // -- and lands its own error row instead of stealing a
                // queued entry it never paired with.
                if self.pending_results > 0 {
                    self.pending_results -= 1;
                    if let Some(entry) = channel
                        .completed
                        .lock()
                        .expect("completed lock poisoned")
                        .pop_front()
                    {
                        push_call(&mut self.rounds, entry);
                        self.landed_calls += 1;
                    }
                } else {
                    self.land_synthetic_call(tool_result);
                }
            }
            MultiTurnStreamItem::CompletionCall(call) => {
                // The model call's usage record -- emitted exactly once per
                // turn, after every content item, whether or not the turn
                // streamed text. That makes it the turn's closing boundary
                // (the `Final` item below is gated on text-bearing turns by
                // rig's emit_final, so a reasoning-plus-calls turn with no
                // prose would otherwise never close): finalize the thinking,
                // park a call-less turn's trailing round, end the turn.
                // ADR-0129 (issue #1270): the same record is the round
                // trip's usage evidence -- normalize + accumulate ahead of
                // the close, so a turn cut after this point (a cancel
                // between rounds) keeps its already-reported round-trips
                // (Decision 3's cancelled-turn rule).
                if let Some(round_usage) = normalize_rig_usage(&call.usage, self.protocol) {
                    self.usage.add(&round_usage);
                    self.last_roundtrip_usage = Some(round_usage);
                }
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
                    // A round that landed calls (an invalid-call Skip's
                    // synthetic row, issue #1625) survives the prose strip:
                    // the calls are honesty the trace keeps.
                    if round.thinking.is_some() || !round.calls.is_empty() {
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
                // Issue #1658: the reasoning fragment streams live the
                // moment it arrives -- the thinking counterpart of the
                // `TextDelta` arm above -- while `reasoning_deltas` keeps
                // accumulating toward the freeze (committed blocks still
                // supersede their deltas). The emission rides the same
                // shared cap boundary (`push_capped_emit`, issue #1171):
                // once the track latches the marker, the crossing chunk's
                // delta is followed by one final marker delta and later
                // chunks emit nothing.
                self.open_call(phases);
                push_capped_emit(&mut self.reasoning_deltas, reasoning, &mut |delta| {
                    emit_phase(
                        phases,
                        TurnPhase::ThinkingDelta {
                            delta: delta.to_string(),
                        },
                    );
                });
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
        if !self.reasoning_committed.is_empty()
            && !self.reasoning_deltas.is_empty()
            && self.reasoning_committed != self.reasoning_deltas
        {
            // Upstream drift, the claude pump's twin tie-break doctrine
            // (#886: the choice stays answerable in logs): the committed
            // block wins and the divergent delta tail drops -- both texts
            // land in the log.
            log::warn!(
                target: "toptopduck::session",
                "committed reasoning differs from its streamed deltas; delta tail dropped: {:?}, committed: {:?}",
                self.reasoning_deltas,
                self.reasoning_committed
            );
        }
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

    /// Land a framework-side synthetic result (issue #1625): the error
    /// `tool_result` an invalid-tool-call Skip fed back to the model. The
    /// row reuses the ordinary failed-call shape (the hallucinated name,
    /// the reason text as both the bounded anchor and the model-visible
    /// detail) so the trace needs no new frontend vocabulary. It rides
    /// the invalid turn's parked trailing round -- the batch never
    /// confirmed (the turn was abandoned at the invalid call), so the
    /// turn's round is the parked one; a parkless turn (nothing streamed
    /// but the invalid call) parks a fresh round to carry the row.
    fn land_synthetic_call(&mut self, result: &ToolResult) {
        let reason = result
            .content
            .iter()
            .filter_map(ToolResultContent::as_text)
            .collect::<Vec<_>>()
            .join("\n");
        let entry = TraceEntry::failed(
            result.call.as_str(),
            result.name.clone(),
            // No dispatch ever classified the call -- the neutral default
            // is the honest kind for a name that resolved to nothing.
            OperationKind::Read,
            String::new(),
            reason.clone(),
        )
        .with_failure_detail(&reason);
        match &mut self.trailing_round {
            Some(round) => round.calls.push(entry),
            None => {
                self.trailing_round = Some(LoopRound {
                    thinking: None,
                    text: None,
                    calls: vec![entry],
                });
            }
        }
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
    use rig_core::completion::Usage;
    use rig_core::message::{ToolCall, ToolCallId, ToolFunction};
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
        close_item_with(Usage::new())
    }

    fn close_item_with(usage: Usage) -> MultiTurnStreamItem {
        MultiTurnStreamItem::CompletionCall(rig_agent::agent::CompletionCall::new(0, usage))
    }

    fn rig_usage(input: u64, cached: u64, write: u64, output: u64) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + cached + write + output,
            cached_input_tokens: cached,
            cache_creation_input_tokens: write,
            tool_use_prompt_tokens: 0,
            reasoning_tokens: 0,
        }
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

    /// A framework-side synthetic result event (issue #1625): the error
    /// `tool_result` an invalid-tool-call Skip surfaces -- identical in
    /// shape to an executed call's result; the reconciliation keys on the
    /// execution confirmation, not the payload.
    fn synthetic_result_item(name: &str, text: &str) -> MultiTurnStreamItem {
        MultiTurnStreamItem::StreamUserItem(StreamedUserContent::ToolResult {
            tool_result: ToolResult {
                call: ToolCallId::new_or_mint("tc_invalid"),
                provider: None,
                name: name.into(),
                content: vec![ToolResultContent::text(text)],
            },
            internal_call_id: "ic_invalid".into(),
        })
    }

    /// The confirmation half of an executed call's stream pair (issue
    /// #1625's reconciliation input): a committed `ToolCall` (the batch
    /// seal) followed by its execution confirmation.
    fn executed_call_items() -> Vec<MultiTurnStreamItem> {
        vec![
            MultiTurnStreamItem::StreamAssistantItem(StreamedAssistantContent::ToolCall {
                tool_call: ToolCall::new(
                    ToolCallId::new_or_mint("tc_ok"),
                    ToolFunction::new("explore".into(), serde_json::json!({})),
                ),
                internal_call_id: "ic_ok".into(),
            }),
            MultiTurnStreamItem::ToolExecutionCommitted {
                tool_call: ToolCall::new(
                    ToolCallId::new_or_mint("tc_ok"),
                    ToolFunction::new("explore".into(), serde_json::json!({})),
                ),
                internal_call_id: "ic_ok".into(),
            },
        ]
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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
        let mut fold = EventFold::new(None);
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

    /// Issue #1658: each reasoning delta forwards as a `ThinkingDelta` the
    /// moment it arrives (pure increment), between the turn-opening
    /// `Thinking` wait and the close's `ThinkingCompleted` freeze -- the
    /// freeze's full block supersedes the streamed fragments.
    #[test]
    fn reasoning_deltas_forward_as_thinking_deltas() {
        let channel = Arc::new(CompletionChannel::new());
        let (seen, sink) = recording_sink();
        let mut fold = EventFold::new(None);
        fold.event(&reasoning_delta_item("think "), &channel, &sink);
        fold.event(&reasoning_delta_item("hard"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        let seen = seen.lock().unwrap();
        let deltas = seen
            .iter()
            .filter_map(|p| match p {
                TurnPhase::ThinkingDelta { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            deltas,
            vec!["think ", "hard"],
            "each fragment fires: {seen:?}"
        );
        assert!(
            matches!(seen.first(), Some(TurnPhase::Thinking { attempt: 1 })),
            "the delta rides after the round-trip wait: {seen:?}"
        );
        assert!(
            matches!(
                seen.last(),
                Some(TurnPhase::ThinkingCompleted { text, .. }) if text == "think hard"
            ),
            "the freeze closes the stream with the full block: {seen:?}"
        );
    }

    /// Issue #1658's cap discipline on the live rail (the #1171 marker
    /// semantics the prose track already applies): the crossing chunk's
    /// delta is followed by ONE final marker delta, and post-cap chunks
    /// emit nothing -- the live thinking stays byte-identical to the
    /// freeze's capped block.
    #[test]
    fn reasoning_delta_emission_stops_past_the_cap() {
        let channel = Arc::new(CompletionChannel::new());
        let (seen, sink) = recording_sink();
        let mut fold = EventFold::new(None);
        fold.event(
            &reasoning_delta_item(&"d".repeat(ACCUM_MAX_BYTES)),
            &channel,
            &sink,
        );
        fold.event(&reasoning_delta_item("more"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        let seen = seen.lock().unwrap();
        let deltas = seen
            .iter()
            .filter_map(|p| match p {
                TurnPhase::ThinkingDelta { delta } => Some(delta.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            deltas,
            vec!["d".repeat(ACCUM_MAX_BYTES), TRUNCATION_MARKER.to_string()],
            "the crossing chunk emits, the marker follows, the post-cap chunk is silent: {seen:?}"
        );
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
        let mut fold = EventFold::new(None);
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

    // --- usage collection (ADR-0129, issue #1270) -------------------------------

    /// ADR-0129 Decision 1: Anthropic wires report cache alongside input,
    /// so the normalized total-side input is the three-way sum and the
    /// subsets land in their breakdown slots untouched.
    #[test]
    fn anthropic_normalization_sums_the_three_way_input() {
        let n = normalize_rig_usage(&rig_usage(100, 30, 20, 50), Some(Protocol::Anthropic))
            .expect("a non-zero report normalizes");
        assert_eq!(n.input_tokens, 150, "ordinary + cache read + cache write");
        assert_eq!(n.cache_read_tokens, 30);
        assert_eq!(n.cache_write_tokens, 20);
        assert_eq!(n.output_tokens, 50);
        assert_eq!(n.total_tokens(), 200, "derived: input + output");
    }

    /// ADR-0129 Decision 1: the OpenAI family's input already contains its
    /// cache -- the same counters normalize to a SMALLER input than the
    /// Anthropic arm, and adding the subsets again would double-count.
    #[test]
    fn openai_normalization_takes_input_verbatim() {
        let n = normalize_rig_usage(&rig_usage(100, 30, 20, 50), Some(Protocol::Openai))
            .expect("a non-zero report normalizes");
        assert_eq!(n.input_tokens, 100, "input taken verbatim (cache inside)");
        assert_eq!(
            n.cache_read_tokens, 30,
            "the subset rides its breakdown slot"
        );
    }

    /// ADR-0129 Decision 3: rig's zero `Usage` is the reported-nothing
    /// sentinel -- it normalizes to `None`, never a zero bill.
    #[test]
    fn zero_report_normalizes_to_none() {
        assert!(normalize_rig_usage(&Usage::new(), Some(Protocol::Anthropic)).is_none());
        let thinking_only = Usage {
            reasoning_tokens: 7,
            ..Usage::new()
        };
        assert!(
            normalize_rig_usage(&thinking_only, Some(Protocol::Openai)).is_none(),
            "a reasoning counter with zero input/output is a malformed report, not evidence"
        );
    }

    /// ADR-0129 Decision 2: each `CompletionCall` record accumulates onto
    /// the fold's round-trip sum -- and a turn cut AFTER its usage record
    /// (the cancelled-between-rounds shape) keeps what arrived: `finish`
    /// never clears the sum.
    #[test]
    fn usage_accumulates_per_round_trip_and_survives_a_cut() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new(Some(Protocol::Anthropic));
        fold.event(&text_item("querying"), &channel, &sink);
        fold.event(
            &close_item_with(rig_usage(100, 30, 20, 50)),
            &channel,
            &sink,
        );
        fold.event(&text_item("cut mid-answer"), &channel, &sink);
        fold.finish(); // the cancel shape: no second CompletionCall arrived
        let usage = fold.usage().expect("the reported round-trip survives");
        assert_eq!(usage.input_tokens, 150);
        assert_eq!(usage.output_tokens, 50);
        // A second reported round-trip would add on top.
        fold.event(&close_item_with(rig_usage(10, 0, 0, 5)), &channel, &sink);
        let usage = fold.usage().expect("still accumulating");
        assert_eq!(usage.input_tokens, 160);
        assert_eq!(usage.output_tokens, 55);
    }

    /// ADR-0129 Decision 3: a turn whose every record was the zero
    /// sentinel (the bridged test face's default) folds no usage at all --
    /// the fail-closed `None`.
    #[test]
    fn unreported_usage_folds_to_none() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new(None);
        fold.event(&text_item("answer"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert!(fold.usage().is_none());
        // ADR-0130: the occupancy latch shares the posture -- no round-trip
        // evidence, no reading (hollow, never zero).
        assert!(fold.occupancy().is_none());
    }

    /// ADR-0130 Decision 2: the occupancy numerator latches the LAST
    /// round-trip (the freshest context measurement), protocol-split --
    /// Anthropic reads the last input (total-side: ordinary + both cache
    /// buckets), the OpenAI family its derived total. A turn cut after a
    /// record (the cancelled-between-rounds shape) keeps the reading, the
    /// same already-reported rule the usage sum applies.
    #[test]
    fn occupancy_latches_the_last_round_trip_protocol_split() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new(Some(Protocol::Anthropic));
        fold.event(
            &close_item_with(rig_usage(100, 30, 20, 50)),
            &channel,
            &sink,
        );
        fold.event(&close_item_with(rig_usage(60, 10, 0, 20)), &channel, &sink);
        fold.finish(); // the cancel shape: no further record arrives
        let occupancy = fold.occupancy().expect("the last round-trip latched");
        // Anthropic: total-side input of the LAST record (60 + 10 + 0).
        assert_eq!(occupancy.tokens, 70);
        assert_eq!(
            occupancy.limit, None,
            "the built-in channel carries no window"
        );

        // OpenAI arm: the same last record reads its derived total
        // (input 60 -- cached rides inside it on that family -- + output 20).
        let mut fold = EventFold::new(Some(Protocol::Openai));
        fold.event(&close_item_with(rig_usage(60, 10, 0, 20)), &channel, &sink);
        let occupancy = fold.occupancy().expect("the record latched");
        assert_eq!(occupancy.tokens, 80);
    }

    /// #1290 (Decision 4 as calibrated): the built-in settle's denominator
    /// stamp -- the windowless reading takes the catalog's answer for the
    /// serving model at the same settle the numerator froze; a catalog miss
    /// or the bridged face's absent name stays hollow. Pinned at the
    /// finish seam (where the stamp lives), not the pump helpers.
    #[test]
    fn finish_stamps_the_denominator_off_the_serving_model() {
        use crate::session::loop_contract::Termination;
        use crate::session::loop_runtime::adapter::SharedTurnState;

        let stamped = |model: Option<&str>| {
            let channel = Arc::new(CompletionChannel::new());
            let sink = noop_sink();
            let state = Arc::new(SharedTurnState::new());
            let mut fold = EventFold::new(Some(Protocol::Anthropic));
            fold.event(&close_item_with(rig_usage(50, 0, 0, 10)), &channel, &sink);
            super::super::finish(fold, &state, Termination::Text("done".into()), false, model)
                .occupancy
        };
        assert_eq!(
            stamped(Some("claude-sonnet-4-5")),
            Some(crate::model::OccupancySnapshot {
                tokens: 50,
                limit: Some(200_000),
            })
        );
        // A catalog miss and the bridged face's absent name: hollow.
        assert_eq!(
            stamped(Some("doubao-1.5-pro")),
            Some(crate::model::OccupancySnapshot {
                tokens: 50,
                limit: None,
            })
        );
        assert_eq!(
            stamped(None),
            Some(crate::model::OccupancySnapshot {
                tokens: 50,
                limit: None,
            })
        );
    }

    // --- framework-side synthetic results (issue #1625) -------------------------

    /// Issue #1625: an invalid-tool-call Skip's synthetic result lands its
    /// own error row on the invalid turn's parked round -- the batch never
    /// confirmed (the turn was abandoned at the invalid call), so the row
    /// joins the turn's parked thinking/prose, wearing the hallucinated
    /// name and the reason text in the ordinary failed-row shape.
    #[test]
    fn synthetic_result_lands_an_error_row_on_the_invalid_turns_round() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new(None);
        // The invalid turn: reasoning streams, the invalid call's arguments
        // stream as deltas (nothing commits), the turn closes and parks.
        fold.event(&reasoning_delta_item("reach for a tool"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        // The Skip's synthetic result: after the close, no execution
        // confirmation ever seen.
        fold.event(
            &synthetic_result_item(
                "explode",
                "tool `explode` does not exist; available tools: [explore]",
            ),
            &channel,
            &sink,
        );
        // The next (self-corrected) turn opens, flushing the parked round.
        fold.event(&text_item("recovered"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 2, "{:?}", fold.rounds);
        let invalid = &fold.rounds[0];
        assert_eq!(
            invalid
                .thinking
                .as_ref()
                .expect("the invalid turn's thinking parks")
                .text,
            "reach for a tool"
        );
        assert_eq!(invalid.calls.len(), 1, "exactly the synthetic row");
        let row = &invalid.calls[0];
        assert_eq!(row.name, "explode", "the row wears the hallucinated name");
        assert!(!row.success);
        assert_eq!(
            row.result_excerpt,
            "tool `explode` does not exist; available tools: [explore]"
        );
        assert_eq!(
            row.failure_detail.as_deref(),
            Some("tool `explode` does not exist; available tools: [explore]"),
            "the reason is the model-visible failure text"
        );
        assert_eq!(fold.rounds[1].text.as_deref(), Some("recovered"));
        assert_eq!(
            fold.landed_calls, 0,
            "a synthetic row is not a dispatched call's landing"
        );
    }

    /// Issue #1625's regression pin: a synthetic result arriving while the
    /// completion queue still holds a dispatched entry (the misordering
    /// hazard the blind order-pairing posed) must NOT consume it -- the
    /// entry stays queued for the executed result (or the finish-time
    /// drain) that owns it, and the synthetic row still lands.
    #[test]
    fn synthetic_result_never_steals_a_queued_dispatch_entry() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        // A dispatched call's recorded entry sits queued -- a shape the
        // strict event order never produces with a synthetic result behind
        // it; the reconciliation must hold anyway (it keys on the
        // confirmation count, not the queue's emptiness).
        channel
            .completed
            .lock()
            .unwrap()
            .push_back(TraceEntry::succeeded(
                "gateway-1",
                "explore",
                OperationKind::Read,
                "",
                "rows",
            ));
        let mut fold = EventFold::new(None);
        fold.event(&text_item("plan"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(
            &synthetic_result_item("explode", "reason text"),
            &channel,
            &sink,
        );
        fold.finish();
        assert_eq!(
            channel.completed.lock().unwrap().len(),
            1,
            "the dispatched entry stays queued for its owner"
        );
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let round = &fold.rounds[0];
        assert_eq!(round.text.as_deref(), Some("plan"));
        assert_eq!(
            round.calls.len(),
            1,
            "the synthetic row landed without touching the queue"
        );
        assert_eq!(round.calls[0].name, "explode");
    }

    /// The executed path is unchanged by the reconciliation (#1625's
    /// no-regression arm): an execution confirmation counts, its paired
    /// result event consumes the count and pops the queued entry exactly
    /// as the blind order-pairing did.
    #[test]
    fn executed_results_pair_through_the_committed_count() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new(None);
        fold.event(&text_item("plan"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        for item in executed_call_items() {
            fold.event(&item, &channel, &sink);
        }
        channel
            .completed
            .lock()
            .unwrap()
            .push_back(TraceEntry::succeeded(
                "gateway-1",
                "explore",
                OperationKind::Read,
                "",
                "rows",
            ));
        fold.event(&synthetic_result_item("explore", "rows"), &channel, &sink);
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let batch = &fold.rounds[0];
        assert_eq!(
            batch.text.as_deref(),
            Some("plan"),
            "the batch seal rebuilt the round with the turn's prose"
        );
        assert_eq!(batch.calls.len(), 1);
        assert_eq!(batch.calls[0].name, "explore");
        assert_eq!(batch.calls[0].tool_use_id, "gateway-1");
        assert_eq!(fold.landed_calls, 1);
    }

    /// The FinalResponse prose strip keeps a parked round that landed
    /// calls (issue #1625's strip-survival arm): the strict event order
    /// never lands a synthetic row on the final text turn's own park (the
    /// next turn's open flushes the invalid turn's park first) -- the
    /// strip must hold anyway; it keys on the round's calls, not on the
    /// order that produces them.
    #[test]
    fn final_response_keeps_a_parked_round_that_landed_a_synthetic_call() {
        let channel = Arc::new(CompletionChannel::new());
        let sink = noop_sink();
        let mut fold = EventFold::new(None);
        // The final text turn parks its prose, and the synthetic row joins
        // the park after the close -- a shape the strict order never
        // produces, held here for the strip's own sake.
        fold.event(&text_item("done"), &channel, &sink);
        fold.event(&close_item(), &channel, &sink);
        fold.event(
            &synthetic_result_item("explode", "reason text"),
            &channel,
            &sink,
        );
        fold.event(&final_response_item("done"), &channel, &sink);
        fold.finish();
        assert_eq!(fold.rounds.len(), 1, "{:?}", fold.rounds);
        let round = &fold.rounds[0];
        assert_eq!(round.text, None, "the prose rode the final output");
        assert_eq!(round.calls.len(), 1, "the synthetic row survived the strip");
        assert_eq!(round.calls[0].name, "explode");
        assert_eq!(fold.final_output.as_deref(), Some("done"));
    }
}
