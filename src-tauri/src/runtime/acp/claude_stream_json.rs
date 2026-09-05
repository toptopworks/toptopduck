//! Claude-code native headless stream engine (ADR-0097, issue #561).
//!
//! Invoked by [`super::engine::AcpEngine::run`] when the adapter's
//! [`StreamFormat`] is [`ClaudeStreamJson`]. Spawns
//! `claude --print --output-format stream-json` (the stateless headless
//! surface -- new process every turn, no `--resume` / `--session-id`,
//! `--no-session-persistence` keeps upstream from writing a session file),
//! injects the gateway bridge via `--mcp-config` + `--strict-mcp-config`,
//! writes the flattened window text to stdin, then reads NDJSON frames from
//! stdout and maps them to [`TurnPhase`] / [`TraceEntry`] / [`Termination`]
//! -- the SAME [`LoopOutcome`] shape the ACP path, the codex path, and the
//! built-in loop return.
//!
//! Frame vocabulary (claude stream-json): `system` (subtyped; `init` carries
//! the current model -- unknown subtypes are session-hook frames and MUST be
//! tolerated mid-stream, a measured property, not defensiveness), `assistant`
//! (message content blocks: `text` + `tool_use`), `user` (`tool_result`
//! blocks), `stream_event` (partial-message deltas -- the pinned minimal argv
//! does not request them; the parser maps the vocabulary anyway), `result`
//! (terminal). Control-plane frames (`control_request` / `control_response`)
//! belong to the probe surface but are tolerated here too.
//!
//! Tools: the native tool plane is blocked wholesale by the adapter's
//! `--disallowedTools` deny list + headless auto-refusal (ADR-0097 Decision
//! 3); the ONLY tool plane is the gateway bridge. A `tool_use` whose name
//! carries an injected server's `mcp__<server>__` prefix is therefore
//! gateway-routed: the driver emits the live phases but NO engine-side trace
//! row -- the gateway is authoritative for its own calls (ADR-0085 single
//! enforcement point; [`crate::session::merge_outcomes`] keeps the gateway
//! row and drops an engine echo it can account for, whether builtin,
//! per-name quota, or the `mcp_invoke` pool (issue #820), so the driver
//! never emits one). An unprefixed `tool_use` (a native tool that
//! slipped past the deny list upstream) rides the engine trace like the
//! codex path's native events.
//!
//! [`StreamFormat`]: super::adapter::StreamFormat
//! [`ClaudeStreamJson`]: super::adapter::StreamFormat::ClaudeStreamJson

use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::approval::OperationKind;
use crate::cancel::CancelToken;
use crate::model::{TraceEntryView, TurnPhase};
use crate::provider::tool_calling::ToolUse;
use crate::runtime::acp::adapter::AdapterSpec;
use crate::runtime::acp::turn_io::{build_model_flags, flatten_prompt};
use crate::runtime::acp::wire::McpServer;
use crate::session::loop_contract::{
    truncate_trace_excerpt, LoopOutcome, LoopRound, Termination, TraceEntry, TRACE_EXCERPT_MAX,
};
use crate::session::turn_dispatch::{classify_call, spawn_wall_clock_watchdog};

use super::engine::{RoundTracker, RowEnd, UNOBSERVED_EXCERPT};

// ---------------------------------------------------------------------------
// Frame parser (pure)
// ---------------------------------------------------------------------------

/// One parsed claude stream-json frame (ADR-0097 Decision 3). A raw NDJSON
/// line can carry SEVERAL meaningful events (an `assistant` message with a
/// text block + tool_use blocks), so the parser returns a list; frames the
/// engine ignores (unknown `system` subtypes, `user` echoes, control-plane
/// frames, anything unshaped) parse to the empty list -- tolerance, not
/// failure.
#[derive(Debug, PartialEq)]
pub(crate) enum ClaudeEvent {
    /// The turn's opening `system{init}` frame; carries the model the CLI
    /// actually runs (honest rendering, ADR-0097 Decision 5).
    SystemInit { model: Option<String> },
    /// Assistant thinking-block content (issue #612): one merged event per
    /// frame -- headless emits whole blocks, not deltas. Accumulates into
    /// the current round's thinking stream, frozen at the batch boundary or
    /// turn end.
    ThinkingBlock { text: String },
    /// Assistant text content -- accumulated across the turn.
    AssistantText { text: String },
    /// A tool invocation opened (`assistant` `tool_use` block).
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// A tool invocation settled (`user` `tool_result` block).
    ToolResult { id: String, success: bool },
    /// A partial-message text delta (`stream_event`
    /// `content_block_delta`/`text_delta`). The pinned minimal argv does not
    /// request partial messages, so these never co-occur with the complete
    /// `assistant` text for the same content; the parser maps the vocabulary
    /// regardless (issue #561 spec).
    StreamDelta { text: String },
    /// The terminal frame. `subtype` is the CLI's own stop classification;
    /// `is_error` marks a failed turn; `text` is the final message (empty
    /// when the CLI gave none).
    Result {
        subtype: String,
        is_error: bool,
        text: String,
    },
}

/// Parse one NDJSON line (already deserialized to [`Value`]) into zero or
/// more [`ClaudeEvent`]s. Defensive: unknown shapes, missing fields, or type
/// mismatches contribute nothing, never panic.
pub(crate) fn parse_events(value: &Value) -> Vec<ClaudeEvent> {
    let frame_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match frame_type {
        "system" => {
            // Only `init` carries turn data; every other subtype is a
            // session-hook frame mixing with business frames on the same
            // stream (measured on 2.1.222) -- tolerated by design.
            if value.get("subtype").and_then(|v| v.as_str()) == Some("init") {
                vec![ClaudeEvent::SystemInit {
                    model: value
                        .get("model")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                }]
            } else {
                Vec::new()
            }
        }
        "assistant" => parse_message_blocks(value, true),
        "user" => parse_message_blocks(value, false),
        "stream_event" => parse_stream_event(value),
        "result" => {
            let subtype = value
                .get("subtype")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let is_error = value
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let text = value
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            vec![ClaudeEvent::Result {
                subtype,
                is_error,
                text,
            }]
        }
        // control_request / control_response / anything else: not turn data.
        _ => Vec::new(),
    }
}

/// Walk a `message.content` block array. On `assistant` frames, `thinking`
/// blocks concatenate into one [`ClaudeEvent::ThinkingBlock`] and `text`
/// blocks into one [`ClaudeEvent::AssistantText`], both ahead of the
/// per-`tool_use` events (issue #612); on `user` frames, each `tool_result`
/// block is its own event. Other block types (tool-result content echoes,
/// ...) contribute nothing.
fn parse_message_blocks(value: &Value, assistant: bool) -> Vec<ClaudeEvent> {
    let Some(blocks) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let mut thinking = String::new();
    let mut text = String::new();
    for block in blocks {
        let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match block_type {
            "thinking" if assistant => {
                if let Some(t) = block.get("thinking").and_then(|v| v.as_str()) {
                    thinking.push_str(t);
                }
            }
            "text" if assistant => {
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    text.push_str(t);
                }
            }
            "tool_use" if assistant => {
                let id = block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                events.push(ClaudeEvent::ToolUse { id, name, input });
            }
            "tool_result" if !assistant => {
                let id = block
                    .get("tool_use_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_error = block
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                events.push(ClaudeEvent::ToolResult {
                    id,
                    success: !is_error,
                });
            }
            _ => {}
        }
    }
    let mut prelude = Vec::new();
    if !thinking.is_empty() {
        prelude.push(ClaudeEvent::ThinkingBlock { text: thinking });
    }
    if !text.is_empty() {
        prelude.push(ClaudeEvent::AssistantText { text });
    }
    prelude.extend(events);
    prelude
}

/// Extract a `stream_event` partial-message delta: only
/// `content_block_delta` events with a `text_delta` payload carry text;
/// every other stream-event shape (content_block_start/stop, message
/// deltas, ...) contributes nothing.
fn parse_stream_event(value: &Value) -> Vec<ClaudeEvent> {
    let event = value.get("event").and_then(|v| v.as_object());
    let Some(event) = event else {
        return Vec::new();
    };
    let is_text_delta = event.get("type").and_then(|v| v.as_str()) == Some("content_block_delta")
        && event
            .get("delta")
            .and_then(|d| d.get("type"))
            .and_then(|v| v.as_str())
            == Some("text_delta");
    if !is_text_delta {
        return Vec::new();
    }
    let text = event
        .get("delta")
        .and_then(|d| d.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        Vec::new()
    } else {
        vec![ClaudeEvent::StreamDelta { text }]
    }
}

// ---------------------------------------------------------------------------
// MCP config builder (pure)
// ---------------------------------------------------------------------------

/// Build the `--mcp-config` / `--strict-mcp-config` argv segments that
/// inject the gateway bridge into claude-code's session (ADR-0097 Decision
/// 4). The config is an inline JSON document --
/// `{"mcpServers": {"<name>": {"command", "args", "env"}}}` -- describing
/// EXACTLY the bridge descriptors the turn input carries; `--strict-mcp-config`
/// makes the session ignore every machine-level MCP configuration, so the
/// gateway stays the only tool plane (user-configured MCP joins through the
/// product's MCP surface, routed via the gateway). `--strict-mcp-config`
/// rides UNCONDITIONALLY: with no bridge descriptor it still blocks the
/// machine's own servers (an honest zero-tool turn beats a side-channel).
pub(crate) fn build_mcp_config_flags(mcp_servers: &[McpServer]) -> Vec<String> {
    let mut flags = Vec::new();
    let mut servers = serde_json::Map::new();
    for server in mcp_servers {
        if let McpServer::Stdio {
            name,
            command,
            args,
            env,
        } = server
        {
            servers.insert(
                name.clone(),
                serde_json::json!({
                    "command": command,
                    "args": args,
                    "env": env,
                }),
            );
        }
    }
    if !servers.is_empty() {
        let doc = serde_json::json!({ "mcpServers": Value::Object(servers) });
        flags.push("--mcp-config".to_string());
        flags.push(doc.to_string());
    }
    flags.push("--strict-mcp-config".to_string());
    flags
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// Drive one claude-code headless turn (ADR-0097). Spawns the CLI with the
/// bridge injected via `--mcp-config` + `--strict-mcp-config`, writes the
/// flattened prompt to stdin, reads NDJSON frames from stdout, and returns
/// the SAME [`LoopOutcome`] shape as the ACP / codex paths. The caller owns
/// the cancel token + execution caps; `on_phase` mirrors the other paths'
/// phase emission.
///
/// `approval` + `sink` are accepted for signature parity with the ACP path
/// but unused -- the native tool plane is blocked (ADR-0097 Decision 3) and
/// gateway-routed calls pass the app's approval gate gateway-side.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_claude_stream_json(
    adapter: &AdapterSpec,
    cancel: Arc<CancelToken>,
    step_cap: u32,
    wall_clock: Option<Duration>,
    input: &super::engine::AcpTurnInput,
    binary: &Path,
    _approval: &crate::approval::ApprovalState,
    _sink: &dyn crate::approval::ApprovalSink,
    mut on_phase: impl FnMut(TurnPhase),
) -> LoopOutcome {
    let guard = cancel.begin_turn();

    // Wall-clock watchdog (same as the other paths): fire cancel on expiry.
    if let Some(timeout) = wall_clock {
        spawn_wall_clock_watchdog(
            guard.generation(),
            Arc::clone(&cancel),
            timeout,
            "toptopduck::acp",
        );
    }

    // Spawn claude --print with the bridge injected via --mcp-config +
    // --strict-mcp-config and the ADR-0095 selections on argv (`--model`
    // + `--effort`, ADR-0097 Decision 6).
    let mcp_flags = build_mcp_config_flags(&input.mcp_servers);
    let model_flags = build_model_flags(
        adapter,
        input.model.as_deref(),
        input.thought_level.as_deref(),
    );
    let mut child = match super::process::spawn_turn(
        binary,
        adapter.argv,
        &model_flags,
        &mcp_flags,
        &input.cwd,
    ) {
        Ok(c) => c,
        Err(e) => {
            return outcome(
                Termination::Transient(format!(
                    "failed to spawn claude-code headless `{}`: {e}",
                    adapter.id
                )),
                Vec::new(),
                None,
            )
        }
    };

    // Write the flattened prompt to stdin, then close stdin so claude begins
    // processing (headless mode reads the prompt from stdin). The write
    // rides the cancel-aware helper (issue #808): a CLI that stalls before
    // draining stdin cannot wedge the turn before the pump loop's cancel
    // check becomes reachable.
    let stdin = child.stdin.take().expect("piped stdin");
    let prompt = flatten_prompt(&input.prompt_blocks);
    match super::process::write_prompt_with_cancel(stdin, prompt, &cancel, &mut child) {
        super::process::StdinWriteOutcome::Done => {}
        super::process::StdinWriteOutcome::Failed(e) => {
            return outcome(
                Termination::Transient(format!("stdin write failed: {e}")),
                Vec::new(),
                None,
            )
        }
        super::process::StdinWriteOutcome::Cancelled => {
            return outcome(Termination::Cancelled, Vec::new(), None)
        }
    }

    let stdout = child.stdout.take().expect("piped stdout");

    // Reader thread (shared, line-capped -- issue #639).
    let rx = super::process::spawn_line_reader(stdout);

    // Signal Thinking once before the frame pump (one headless invocation =
    // one turn = one thinking wait).
    on_phase(TurnPhase::Thinking { attempt: 1 });

    let mut pump = ClaudePump {
        tracker: RoundTracker::new(),
        tool_call_count: 0,
        step_cap,
        current_model: None,
        pending: Vec::new(),
        gateway_prefixes: input
            .mcp_servers
            .iter()
            .filter_map(|s| match s {
                McpServer::Stdio { name, .. } => Some(format!("mcp__{name}__")),
                McpServer::Other => None,
            })
            .collect(),
    };

    let mut termination = None;
    let mut step_cap_tripped = false;

    loop {
        // Cancel check (mirrors the other paths' loop-top check).
        if cancel.is_requested() {
            termination = Some(Termination::Cancelled);
            break;
        }
        // Step-cap trip (execution-level cap, ADR-0081). No protocol-level
        // cancel message on this surface -- kill the child and terminate.
        if pump.tool_call_count > pump.step_cap {
            step_cap_tripped = true;
            break;
        }

        match rx.recv_timeout(super::process::PUMP_POLL_INTERVAL) {
            Ok(line) => {
                let value: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(_) => continue, // skip unparseable line
                };
                for event in parse_events(&value) {
                    if let Some(term) = pump.fold(event, &mut on_phase) {
                        termination = Some(term);
                        break;
                    }
                }
                if termination.is_some() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // stdout closed before a `result` frame. With accumulated
                // text, treat it as the answer (honest degrade); without, a
                // transient failure.
                termination = Some(
                    pump.tracker
                        .text_or_transient("claude closed stdout without a result frame"),
                );
                break;
            }
        }
    }

    // If the step cap tripped, override any pending termination.
    if step_cap_tripped {
        termination = Some(Termination::StepCap(step_cap));
    }

    // Finalize any tool rows still open at turn end (honestly unobserved,
    // each landing on the round it opened in), then close the trailing
    // round's thought stream -- its ThinkingCompleted renders live; whether
    // the settle keeps the trailing prose on the round depends on the
    // termination (issues #612/#628).
    pump.finalize_pending(&mut on_phase);
    pump.tracker.freeze_trailing_thinking(&mut on_phase);

    super::process::kill_and_reap(&mut child);

    let term = termination.unwrap_or_else(|| {
        pump.tracker
            .text_or_transient("claude turn ended without a result frame")
    });

    // ADR-0097 Decision 5: `system{init}` reports the model this turn
    // actually ran -- the honest-rendering catalog (the probe channel owns
    // the full directory; the turn never re-discovers).
    let discovered = pump.current_model.map(|model| {
        let mut d = crate::session::loop_contract::DiscoveredRuntime::empty();
        d.current_model = Some(model);
        // Issue #529 semantics: the wire carries no adapter identity.
        d.adapter_id = Some(adapter.id.to_string());
        d
    });

    let rounds = pump.tracker.settle_rounds(&term);
    outcome(term, rounds, discovered)
}

/// A `tool_use` awaiting its `tool_result` (live-phase bookkeeping). Carries
/// the round it opened in -- a late completion (or the turn-end drain) lands
/// the entry on that round, not whichever round is current.
struct PendingClaudeCall {
    round: usize,
    tool_use_id: String,
    /// The display name: the gateway prefix stripped when gateway-routed.
    name: String,
    operation_kind: OperationKind,
    summary: String,
}

/// Mutable state accumulated while pumping claude frames.
struct ClaudePump {
    /// The round bookkeeping: per-round thinking/prose/calls + the
    /// terminal-text fallback (ADR-0103, issue #612).
    tracker: RoundTracker,
    /// Count of tool invocations observed (step-cap counter) -- gateway-routed
    /// and native alike (the cap bounds the whole turn).
    tool_call_count: u32,
    step_cap: u32,
    /// The `system{init}` reported model (honest rendering).
    current_model: Option<String>,
    pending: Vec<PendingClaudeCall>,
    /// The injected MCP servers' claude-side name prefixes
    /// (`mcp__<server>__`), deciding gateway-routed vs native `tool_use`.
    gateway_prefixes: Vec<String>,
}

impl ClaudePump {
    /// Fold one parsed event. Returns `Some(termination)` when the event
    /// ends the turn (the `result` frame).
    fn fold(
        &mut self,
        event: ClaudeEvent,
        on_phase: &mut impl FnMut(TurnPhase),
    ) -> Option<Termination> {
        match event {
            ClaudeEvent::SystemInit { model } => {
                self.current_model = model;
                None
            }
            ClaudeEvent::ThinkingBlock { text } => {
                self.tracker.push_thought(&text, on_phase);
                None
            }
            // Complete prose and partial text deltas share the dual track
            // (round slot + terminal fallback); the pinned argv never emits
            // deltas, but the vocabulary maps them the same way (issue #561).
            ClaudeEvent::AssistantText { text } | ClaudeEvent::StreamDelta { text } => {
                self.tracker.push_prose(&text, on_phase);
                None
            }
            ClaudeEvent::ToolUse { id, name, input } => {
                self.tool_call_count += 1;
                // The batch boundary: the round's prelude (frozen thinking,
                // prose) fires once, before this call's Started event.
                let round = self.tracker.call_round(on_phase);
                // One prefix scan settles both facts (strip_prefix(p)
                // .is_some() <=> starts_with(p)): whether the call is
                // gateway-routed, and the bare display name (the merged
                // trace's gateway rows carry the bare name; the live phases
                // must read the same).
                let stripped = self
                    .gateway_prefixes
                    .iter()
                    .find_map(|prefix| name.strip_prefix(prefix));
                let bare = stripped.unwrap_or(name.as_str());
                let (_, operation_kind, summary) = classify_call(&ToolUse {
                    id: id.clone(),
                    name: bare.to_string(),
                    input,
                });
                let summary = truncate_trace_excerpt(&summary, TRACE_EXCERPT_MAX);
                on_phase(TurnPhase::ToolCallStarted {
                    name: bare.to_string(),
                    operation_kind,
                    summary: summary.clone(),
                });
                self.pending.push(PendingClaudeCall {
                    round,
                    tool_use_id: id,
                    name: bare.to_string(),
                    operation_kind,
                    summary,
                });
                None
            }
            ClaudeEvent::ToolResult { id, success } => {
                // A result with no matching open row (missed the start) is
                // dropped -- the trace stays consistent with the starts seen.
                if let Some(pos) = self.pending.iter().position(|p| p.tool_use_id == id) {
                    let row = self.pending.remove(pos);
                    let end = if success {
                        RowEnd::Completed
                    } else {
                        RowEnd::Failed
                    };
                    self.finalize_row(row, end, on_phase);
                }
                None
            }
            ClaudeEvent::Result {
                subtype,
                is_error,
                text,
            } => {
                if !is_error {
                    // Prefer the terminal frame's own text; fall back to the
                    // terminal-text dual track (trailing prose, else the
                    // accumulated stream text).
                    let final_text = if text.is_empty() {
                        self.tracker.terminal_text()
                    } else {
                        text
                    };
                    return Some(Termination::Text(final_text));
                }
                // The agent's own turn ceiling maps onto the execution-level
                // StepCap (the ACP path's MaxTurns precedent).
                if subtype.contains("max_turns") {
                    return Some(Termination::StepCap(self.step_cap));
                }
                let detail = if text.is_empty() { subtype } else { text };
                Some(Termination::Transient(format!(
                    "claude turn failed: {detail}"
                )))
            }
        }
    }

    /// Finalize one settled tool row: phases always land; trace rows only
    /// for non-gateway calls (the gateway owns its own).
    fn finalize_row(
        &mut self,
        row: PendingClaudeCall,
        end: RowEnd,
        on_phase: &mut impl FnMut(TurnPhase),
    ) {
        // The claude wire carries no per-call result text on the tool_result
        // frame; a failure still needs its bounded anchor (ADR-0078) -- the
        // ACP pump's honest "failed" marker. A row the agent never reported
        // on carries the unobserved marker instead (issue #630).
        let entry = match end {
            RowEnd::Completed => TraceEntry::succeeded(
                row.tool_use_id,
                row.name.clone(),
                row.operation_kind,
                row.summary.clone(),
                String::new(),
            ),
            RowEnd::Failed => TraceEntry::failed(
                row.tool_use_id,
                row.name.clone(),
                row.operation_kind,
                row.summary.clone(),
                "failed",
            ),
            RowEnd::Unobserved => TraceEntry::failed(
                row.tool_use_id,
                row.name.clone(),
                row.operation_kind,
                row.summary.clone(),
                UNOBSERVED_EXCERPT,
            ),
        };
        on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
        // Gateway-routed rows land too (issue #817): the engine row is the
        // in-place-replacement anchor the settle merge pairs the gateway's
        // authoritative record against -- the paired row keeps only its
        // position, every field comes from the gateway (ADR-0085).
        self.tracker.land_call(row.round, entry);
    }

    /// Close every still-open row at turn end -- honestly: the turn ended
    //  before the agent reported a final status (the ACP pump's unobserved
    //  marker, issue #630).
    fn finalize_pending(&mut self, on_phase: &mut impl FnMut(TurnPhase)) {
        for row in std::mem::take(&mut self.pending) {
            self.finalize_row(row, RowEnd::Unobserved, on_phase);
        }
    }
}

/// Build the [`LoopOutcome`] (same shape as the other engines).
fn outcome(
    termination: Termination,
    rounds: Vec<LoopRound>,
    discovered: Option<crate::session::loop_contract::DiscoveredRuntime>,
) -> LoopOutcome {
    LoopOutcome {
        termination,
        // Promotions are gateway-side (ADR-0085); the stream engine owns
        // only the frame-driving half.
        promotions: Vec::new(),
        // ADR-0103 (issue #612): rounds grouped at the assistant-frame
        // tool-call batch. A turn with no events settles to an empty list
        // (no ghost round); a gateway-routed-only round keeps its call-less
        // shell here -- a bare shell (no prose, no thinking) drops at the
        // wiring merge's empty-round pass; one that carried prose survives.
        trace: rounds,
        discovered_runtime: discovered,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- parse_events: system ------------------------------------------------

    /// The opening `system{init}` frame carries the current model (ADR-0097
    /// Decision 5 honest rendering).
    #[test]
    fn parse_system_init_carries_model() {
        let v = json!({
            "type": "system",
            "subtype": "init",
            "model": "claude-sonnet-4-20250514",
            "cwd": "/tmp",
            "tools": ["mcp__toptopduck-gateway__explore"]
        });
        assert_eq!(
            parse_events(&v),
            vec![ClaudeEvent::SystemInit {
                model: Some("claude-sonnet-4-20250514".into())
            }]
        );
    }

    /// A `system{init}` without a model string still maps (the model is
    /// optional data, never a parse failure).
    #[test]
    fn parse_system_init_without_model_is_none() {
        let v = json!({"type": "system", "subtype": "init"});
        assert_eq!(
            parse_events(&v),
            vec![ClaudeEvent::SystemInit { model: None }]
        );
    }

    /// AC: unknown `system` subtypes are session-hook frames mixing with
    /// business frames on the same stream (measured, not defensive) -- the
    /// parser tolerates them by contributing nothing.
    #[test]
    fn parse_unknown_system_subtype_is_tolerated() {
        for subtype in ["session_start", "hook_output", "compact_boundary"] {
            let v = json!({"type": "system", "subtype": subtype, "payload": {"any": 1}});
            assert!(parse_events(&v).is_empty(), "subtype `{subtype}` ignored");
        }
        // A system frame without any subtype at all.
        assert!(parse_events(&json!({"type": "system"})).is_empty());
    }

    // --- parse_events: assistant ----------------------------------------------

    /// An assistant text frame accumulates its text blocks.
    #[test]
    fn parse_assistant_text_block() {
        let v = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "the answer is "},
                    {"type": "text", "text": "42"}
                ]
            }
        });
        assert_eq!(
            parse_events(&v),
            vec![ClaudeEvent::AssistantText {
                text: "the answer is 42".into()
            }]
        );
    }

    /// An assistant frame with a text block + tool_use blocks yields the
    /// text FIRST, then one event per tool_use.
    #[test]
    fn parse_assistant_text_plus_tool_use() {
        let v = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "text", "text": "let me query"},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "mcp__toptopduck-gateway__explore",
                        "input": {"sql": "SELECT 1"}
                    }
                ]
            }
        });
        assert_eq!(
            parse_events(&v),
            vec![
                ClaudeEvent::AssistantText {
                    text: "let me query".into()
                },
                ClaudeEvent::ToolUse {
                    id: "toolu_1".into(),
                    name: "mcp__toptopduck-gateway__explore".into(),
                    input: json!({"sql": "SELECT 1"}),
                },
            ]
        );
    }

    /// An assistant frame's thinking block is captured as a
    /// `ThinkingBlock` event (issue #612) -- the round's reasoning text,
    /// emitted whole (headless sends complete blocks, not deltas).
    #[test]
    fn parse_assistant_thinking_block_captured() {
        let v = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "thinking", "thinking": "pondering the schema"}
                ]
            }
        });
        assert_eq!(
            parse_events(&v),
            vec![ClaudeEvent::ThinkingBlock {
                text: "pondering the schema".into()
            }]
        );
    }

    /// A full assistant frame keeps its block order on the event list:
    /// thinking first, then text, then the tool_use batch -- the order the
    /// round prelude relies on (thinking frozen, prose fired, then the
    /// batch's Started events).
    #[test]
    fn parse_assistant_thinking_text_tool_use_order() {
        let v = json!({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "thinking", "thinking": "reasoning"},
                    {"type": "text", "text": "let me query"},
                    {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "mcp__toptopduck-gateway__explore",
                        "input": {"sql": "SELECT 1"}
                    }
                ]
            }
        });
        assert_eq!(
            parse_events(&v),
            vec![
                ClaudeEvent::ThinkingBlock {
                    text: "reasoning".into()
                },
                ClaudeEvent::AssistantText {
                    text: "let me query".into()
                },
                ClaudeEvent::ToolUse {
                    id: "toolu_1".into(),
                    name: "mcp__toptopduck-gateway__explore".into(),
                    input: json!({"sql": "SELECT 1"}),
                },
            ]
        );
    }

    /// Thinking blocks only parse on assistant frames; a user frame
    /// carrying one contributes nothing (defensive -- the wire never does).
    #[test]
    fn parse_user_frame_thinking_block_tolerated() {
        let v = json!({
            "type": "user",
            "message": {
                "content": [
                    {"type": "thinking", "thinking": "not the model's"}
                ]
            }
        });
        assert_eq!(parse_events(&v), Vec::new());
    }

    /// A user frame's `tool_result` blocks map to settled tool invocations
    /// (is_error inverts to success).
    #[test]
    fn parse_user_tool_result_blocks() {
        let v = json!({
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "1"},
                    {"type": "tool_result", "tool_use_id": "toolu_2", "is_error": true,
                     "content": "denied"}
                ]
            }
        });
        assert_eq!(
            parse_events(&v),
            vec![
                ClaudeEvent::ToolResult {
                    id: "toolu_1".into(),
                    success: true
                },
                ClaudeEvent::ToolResult {
                    id: "toolu_2".into(),
                    success: false
                },
            ]
        );
    }

    // --- parse_events: stream_event --------------------------------------------

    /// A partial-message text delta maps to a StreamDelta (vocabulary
    /// coverage; the pinned argv never requests them).
    #[test]
    fn parse_stream_event_text_delta() {
        let v = json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "partial"}
            }
        });
        assert_eq!(
            parse_events(&v),
            vec![ClaudeEvent::StreamDelta {
                text: "partial".into()
            }]
        );
    }

    /// Non-delta stream events contribute nothing.
    #[test]
    fn parse_stream_event_non_delta_is_tolerated() {
        for event in [
            json!({"type": "content_block_start", "index": 0}),
            json!({"type": "message_delta", "delta": {"stop_reason": null}}),
            json!({"type": "content_block_delta", "delta": {"type": "input_json_delta"}}),
        ] {
            let v = json!({"type": "stream_event", "event": event});
            assert!(parse_events(&v).is_empty(), "{v} ignored");
        }
    }

    // --- parse_events: result ---------------------------------------------------

    /// A successful result frame carries the terminal text.
    #[test]
    fn parse_result_success() {
        let v = json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": "the answer is 42",
            "total_cost_usd": 0.01,
            "usage": {"input_tokens": 10, "output_tokens": 5}
        });
        assert_eq!(
            parse_events(&v),
            vec![ClaudeEvent::Result {
                subtype: "success".into(),
                is_error: false,
                text: "the answer is 42".into()
            }]
        );
    }

    /// An error result frame maps the same shape (the driver decides the
    /// termination semantics).
    #[test]
    fn parse_result_error() {
        let v = json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "result": "rate limited"
        });
        assert_eq!(
            parse_events(&v),
            vec![ClaudeEvent::Result {
                subtype: "error_during_execution".into(),
                is_error: true,
                text: "rate limited".into()
            }]
        );
    }

    // --- parse_events: tolerance -------------------------------------------------

    /// Control-plane frames + unshaped lines contribute nothing (they belong
    /// to the probe surface / hook noise).
    #[test]
    fn parse_control_and_unknown_frames_are_tolerated() {
        for v in [
            json!({"type": "control_request", "request_id": "r1",
                   "request": {"subtype": "can_use_tool"}}),
            json!({"type": "control_response", "request_id": "r1",
                   "response": {"subtype": "success"}}),
            json!({"type": "session_meta", "id": "abc"}),
            json!({"foo": "bar"}),
            json!(null),
        ] {
            assert!(parse_events(&v).is_empty(), "{v} ignored");
        }
    }

    // --- build_mcp_config_flags ----------------------------------------------------

    fn bridge(name: &str) -> McpServer {
        McpServer::stdio_bridge(
            name,
            "/abs/path/to/bridge",
            Vec::new(),
            std::collections::BTreeMap::from([
                ("TOPTOPDUCK_GATEWAY_PORT".to_string(), "12345".to_string()),
                ("TOPTOPDUCK_GATEWAY_TOKEN".to_string(), "abc".to_string()),
            ]),
        )
    }

    /// One bridge descriptor becomes `--mcp-config <json>` + the
    /// unconditional `--strict-mcp-config`.
    #[test]
    fn mcp_config_flags_carry_inline_descriptor_and_strict() {
        let flags = build_mcp_config_flags(&[bridge("toptopduck-gateway")]);
        assert_eq!(flags.len(), 3);
        assert_eq!(flags[0], "--mcp-config");
        let doc: Value = serde_json::from_str(&flags[1]).expect("inline json");
        let server = &doc["mcpServers"]["toptopduck-gateway"];
        assert_eq!(server["command"], "/abs/path/to/bridge");
        assert_eq!(server["env"]["TOPTOPDUCK_GATEWAY_PORT"], "12345");
        assert_eq!(server["env"]["TOPTOPDUCK_GATEWAY_TOKEN"], "abc");
        assert_eq!(server["args"], json!([]));
        assert_eq!(flags[2], "--strict-mcp-config");
    }

    /// With no bridge descriptor, strict still rides (a zero-tool turn beats
    /// a machine-MCP side channel).
    #[test]
    fn mcp_config_flags_strict_without_servers() {
        assert_eq!(build_mcp_config_flags(&[]), vec!["--strict-mcp-config"]);
    }

    // --- pump fold ------------------------------------------------------------------

    fn pump_with_bridge() -> ClaudePump {
        ClaudePump {
            tracker: RoundTracker::new(),
            tool_call_count: 0,
            step_cap: 24,
            current_model: None,
            pending: Vec::new(),
            gateway_prefixes: vec!["mcp__toptopduck-gateway__".to_string()],
        }
    }

    // --- pump fold: rounds (issue #612) ---------------------------------------

    /// The end-of-turn pump sequence the run loop performs: drain open
    /// rows, freeze the trailing round's thought stream (its
    /// ThinkingCompleted renders live), settle the rounds under the turn's
    /// termination.
    fn settle(
        mut pump: ClaudePump,
        phases: &mut Vec<TurnPhase>,
        termination: &Termination,
    ) -> Vec<LoopRound> {
        pump.finalize_pending(&mut |p| phases.push(p));
        pump.tracker
            .freeze_trailing_thinking(&mut |p| phases.push(p));
        pump.tracker.settle_rounds(termination)
    }

    /// A full trajectory settles into per-round slots: the batch round
    /// carries its frozen thinking, its prose, and its calls; the trailing
    /// call-less prose rides the terminal text, not a round of its own.
    #[test]
    fn rounds_carry_prose_thinking_and_calls() {
        let mut pump = pump_with_bridge();
        let mut phases = Vec::new();
        // Round 1: thinking + prose + one native call, then its result.
        pump.fold(
            ClaudeEvent::ThinkingBlock {
                text: "reasoning".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "let me query".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::ToolUse {
                id: "toolu_1".into(),
                name: "Bash".into(),
                input: json!({}),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::ToolResult {
                id: "toolu_1".into(),
                success: true,
            },
            &mut |p| phases.push(p),
        );
        // Trailing round: prose only -- the terminal answer.
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "the answer is 42".into(),
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(pump.tracker.terminal_text(), "the answer is 42");
        let rounds = settle(
            pump,
            &mut phases,
            &Termination::Text("the answer is 42".into()),
        );
        assert_eq!(rounds.len(), 1, "the trailing prose-only round drops");
        assert_eq!(rounds[0].text.as_deref(), Some("let me query"));
        let thinking = rounds[0].thinking.as_ref().expect("frozen thinking");
        assert_eq!(thinking.text, "reasoning");
        assert_eq!(rounds[0].calls.len(), 1);
        assert_eq!(rounds[0].calls[0].name, "Bash");
    }

    /// The live channel's ADR-0103 order for one round: ThinkingCompleted,
    /// then RoundText, then the batch's ToolCallStarted -- the trailing
    /// call-less prose fires no content phase (it rides the terminal text);
    /// only the round-2 Thinking wait pointer fires.
    #[test]
    fn live_order_thinking_round_text_then_call() {
        let mut pump = pump_with_bridge();
        let mut phases = Vec::new();
        pump.fold(
            ClaudeEvent::ThinkingBlock {
                text: "first plan".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "let me query".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::ToolUse {
                id: "toolu_1".into(),
                name: "Bash".into(),
                input: json!({}),
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(phases.len(), 3);
        match &phases[0] {
            TurnPhase::ThinkingCompleted { text, .. } => assert_eq!(text, "first plan"),
            other => panic!("expected ThinkingCompleted, got {other:?}"),
        }
        match &phases[1] {
            TurnPhase::RoundText { text } => assert_eq!(text, "let me query"),
            other => panic!("expected RoundText, got {other:?}"),
        }
        assert!(matches!(phases[2], TurnPhase::ToolCallStarted { .. }));

        // The trailing prose opens round 2 -- the live round pointer fires
        // -- but the prose itself rides the terminal text: no RoundText.
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "the answer".into(),
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(phases.len(), 4);
        match &phases[3] {
            TurnPhase::Thinking { attempt } => assert_eq!(*attempt, 2),
            other => panic!("expected the round-2 Thinking wait, got {other:?}"),
        }
    }

    /// The trailing call-less prose stretch IS the terminal text -- the
    /// honest-degrade answer when no result frame ever arrives.
    #[test]
    fn trailing_prose_is_the_terminal_text() {
        let mut pump = pump_with_bridge();
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "partial answer".into(),
            },
            &mut |_| {},
        );
        assert_eq!(pump.tracker.terminal_text(), "partial answer");
    }

    /// Mid-batch prose + trailing prose without a result frame: the answer
    /// is the trailing stretch ONLY -- the earlier prose stays in its round
    /// slot (the dual-track semantics; the flat pump would have
    /// concatenated both).
    #[test]
    fn eof_after_batch_answers_with_trailing_stretch_only() {
        let mut pump = pump_with_bridge();
        let mut phases = Vec::new();
        // Round 1: prose + a call, then its result.
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "checking".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::ToolUse {
                id: "toolu_1".into(),
                name: "Bash".into(),
                input: json!({}),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::ToolResult {
                id: "toolu_1".into(),
                success: true,
            },
            &mut |p| phases.push(p),
        );
        // Trailing round: the answer, never followed by a result frame.
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "final answer".into(),
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(
            pump.tracker.text_or_transient("claude closed stdout"),
            Termination::Text("final answer".into())
        );
        // The mid-batch prose fired live as its round's RoundText.
        assert!(phases
            .iter()
            .any(|p| matches!(p, TurnPhase::RoundText { text } if text == "checking")));
    }

    /// A call left open at turn end lands on the round it opened in, not
    /// whichever round is current when the drain runs.
    #[test]
    fn pending_call_lands_on_its_opening_round() {
        let mut pump = pump_with_bridge();
        let mut phases = Vec::new();
        // Round 1: one call whose result frame never arrives.
        pump.fold(
            ClaudeEvent::ToolUse {
                id: "toolu_open".into(),
                name: "Bash".into(),
                input: json!({}),
            },
            &mut |p| phases.push(p),
        );
        // Round 2 opens (round 1 observed a call): trailing prose only.
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "never mind".into(),
            },
            &mut |p| phases.push(p),
        );
        let rounds = settle(pump, &mut phases, &Termination::Text("never mind".into()));
        assert_eq!(rounds.len(), 1);
        assert_eq!(
            rounds[0].calls.len(),
            1,
            "the open row drains into its round"
        );
        assert!(
            !rounds[0].calls[0].success,
            "a drained row must not present as success (issue #630)"
        );
    }

    /// A gateway-routed tool_use + tool_result emits phases AND lands an
    /// engine trace row (issue #817): the row is the in-place-replacement
    /// anchor the settle merge pairs the gateway's authoritative record
    /// against, so the gateway's values land inside the round the call ran
    /// in -- no leading all-gateway round.
    #[test]
    fn gateway_routed_tool_call_lands_row_and_emits_phases() {
        let mut pump = pump_with_bridge();
        let mut phases = Vec::new();
        let end = pump.fold(
            ClaudeEvent::ToolUse {
                id: "toolu_1".into(),
                name: "mcp__toptopduck-gateway__explore".into(),
                input: json!({"sql": "SELECT 1"}),
            },
            &mut |p| phases.push(p),
        );
        assert!(end.is_none());
        assert_eq!(pump.tool_call_count, 1);
        let end = pump.fold(
            ClaudeEvent::ToolResult {
                id: "toolu_1".into(),
                success: true,
            },
            &mut |p| phases.push(p),
        );
        assert!(end.is_none());
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1);
        // The engine row lands in the round (the merge's replacement
        // anchor), under the BARE name the gateway records.
        assert_eq!(rounds[0].calls.len(), 1, "the anchor row lands");
        assert_eq!(rounds[0].calls[0].name, "explore");
        // The phases name the BARE tool (the merged gateway row's name).
        match &phases[0] {
            TurnPhase::ToolCallStarted { name, .. } => assert_eq!(name, "explore"),
            other => panic!("expected ToolCallStarted, got {other:?}"),
        }
        assert!(matches!(phases[1], TurnPhase::ToolCallCompleted(_)));
    }

    /// A native (unprefixed) tool_use rides the engine trace (the codex
    /// path's native-event precedent).
    #[test]
    fn native_tool_call_rides_engine_trace() {
        let mut pump = pump_with_bridge();
        let mut phases = Vec::new();
        pump.fold(
            ClaudeEvent::ToolUse {
                id: "toolu_9".into(),
                name: "Bash".into(),
                input: json!({}),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            ClaudeEvent::ToolResult {
                id: "toolu_9".into(),
                success: false,
            },
            &mut |p| phases.push(p),
        );
        let rounds = settle(pump, &mut phases, &Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].calls.len(), 1);
        assert_eq!(rounds[0].calls[0].name, "Bash");
        assert!(!rounds[0].calls[0].success);
    }

    /// A success result frame ends the turn with the frame's own text.
    #[test]
    fn result_success_terminates_with_text() {
        let mut pump = pump_with_bridge();
        let end = pump.fold(
            ClaudeEvent::Result {
                subtype: "success".into(),
                is_error: false,
                text: "final".into(),
            },
            &mut |_| {},
        );
        assert_eq!(end, Some(Termination::Text("final".into())));
    }

    /// A success result with an empty `result` field falls back to the
    /// accumulated stream text.
    #[test]
    fn result_success_empty_text_falls_back_to_accumulated() {
        let mut pump = pump_with_bridge();
        pump.fold(
            ClaudeEvent::AssistantText {
                text: "streamed".into(),
            },
            &mut |_| {},
        );
        let end = pump.fold(
            ClaudeEvent::Result {
                subtype: "success".into(),
                is_error: false,
                text: String::new(),
            },
            &mut |_| {},
        );
        assert_eq!(end, Some(Termination::Text("streamed".into())));
    }

    /// An error result maps to a Transient carrying the CLI's detail; the
    /// max-turns subtype maps onto the execution-level StepCap (the ACP
    /// MaxTurns precedent).
    #[test]
    fn result_error_maps_transient_and_max_turns_step_cap() {
        let mut pump = pump_with_bridge();
        let end = pump.fold(
            ClaudeEvent::Result {
                subtype: "error_during_execution".into(),
                is_error: true,
                text: "rate limited".into(),
            },
            &mut |_| {},
        );
        match end {
            Some(Termination::Transient(msg)) => {
                assert!(msg.contains("rate limited"), "{msg}")
            }
            other => panic!("expected Transient, got {other:?}"),
        }
        let end = pump.fold(
            ClaudeEvent::Result {
                subtype: "error_max_turns".into(),
                is_error: true,
                text: String::new(),
            },
            &mut |_| {},
        );
        assert_eq!(end, Some(Termination::StepCap(24)));
    }

    /// system{init} records the current model for the honest-rendering
    /// catalog; later frames never overwrite the trace-facing state.
    #[test]
    fn system_init_records_current_model() {
        let mut pump = pump_with_bridge();
        pump.fold(
            ClaudeEvent::SystemInit {
                model: Some("claude-sonnet-4".into()),
            },
            &mut |_| {},
        );
        assert_eq!(pump.current_model.as_deref(), Some("claude-sonnet-4"));
    }

    /// Pending rows finalize honestly at turn end (issue #630): a row the
    /// agent never reported on must not present as a bare success.
    #[test]
    fn pending_rows_finalize_at_turn_end() {
        let mut pump = pump_with_bridge();
        let mut phases = Vec::new();
        pump.fold(
            ClaudeEvent::ToolUse {
                id: "toolu_open".into(),
                name: "Bash".into(),
                input: json!({}),
            },
            &mut |p| phases.push(p),
        );
        pump.finalize_pending(&mut |p| phases.push(p));
        assert!(pump.pending.is_empty());
        let rounds = settle(pump, &mut phases, &Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].calls.len(), 1);
        assert!(
            !rounds[0].calls[0].success,
            "a drained row must not present as success: {:?}",
            rounds[0].calls[0]
        );
        assert_eq!(
            rounds[0].calls[0].result_excerpt, UNOBSERVED_EXCERPT,
            "a drained row carries the unobserved marker"
        );
    }
}
