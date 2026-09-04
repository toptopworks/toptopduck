//! Codex event stream engine for codex native `exec --json` (ADR-0094, #523;
//! renamed from `json_event_stream` by ADR-0097 Decision 2).
//!
//! Invoked by [`super::engine::AcpEngine::run`] when the adapter's
//! [`StreamFormat`] is [`CodexEventStream`]. Spawns `codex exec --json` with
//! the gateway bridge injected via `-c` config overrides, writes the flattened
//! window text to stdin, then reads NDJSON events from stdout and maps them to
//! [`TurnPhase`] / [`TraceEntry`] / [`Termination`] — the SAME [`LoopOutcome`]
//! shape the ACP path and the built-in loop return.
//!
//! Approval: unlike the ACP path (inline `session/request_permission`), the
//! codex event stream has no protocol-level pre-check. Gateway tool calls
//! carry the approval gate at the gateway (ADR-0085/0094). `--sandbox
//! read-only` does not prevent native command execution — a native
//! command still runs and lands here as a `command_execution` trace row
//! (ADR-0094's trace second source; measured on codex 0.147.0 on Windows,
//! issue #804). Gateway-served tool calls arrive as `mcp_tool_call` items
//! and render live the same way (issue #816).
//!
//! [`StreamFormat`]: super::adapter::StreamFormat
//! [`CodexEventStream`]: super::adapter::StreamFormat::CodexEventStream

use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use super::engine::RoundTracker;
use crate::approval::OperationKind;
use crate::cancel::CancelToken;
use crate::model::{TraceEntryView, TurnPhase};
use crate::runtime::acp::adapter::AdapterSpec;
use crate::runtime::acp::turn_io::{build_model_flags, flatten_prompt};
use crate::runtime::acp::wire::McpServer;
use crate::session::loop_contract::{
    truncate_trace_excerpt, LoopOutcome, LoopRound, Termination, TraceEntry, TRACE_EXCERPT_MAX,
};
use crate::session::turn_dispatch::spawn_wall_clock_watchdog;

// ---------------------------------------------------------------------------
// Event parser (pure)
// ---------------------------------------------------------------------------

/// One parsed codex `exec --json` event (ADR-0094). The variant set covers the
/// event types that drive the turn; unknown types map to [`Self::Other`] and
/// are ignored by the engine.
#[derive(Debug, PartialEq)]
pub(crate) enum CodexEvent {
    /// The agent started its turn (`turn.started`).
    TurnStarted,
    /// The agent finished normally (`turn.completed`).
    TurnCompleted,
    /// The turn failed with an error message (`turn.failed` + `error`).
    TurnFailed { error: String },
    /// Agent text fragment — accumulated across the turn (the `text` of an
    /// `agent_message` item).
    AgentMessage { text: String },
    /// A completed reasoning item (the `text` of a `reasoning` item,
    /// issue #807) — the turn's thinking text. Never empty: an empty or
    /// missing text stays [`Self::Other`] at the parse boundary.
    Reasoning { text: String },
    /// A completed command execution (`command_execution` item). `exit_code`
    /// maps the trace outcome: zero succeeds, non-zero fails; an absent /
    /// null code is an unknown outcome that stays success.
    CommandExecution {
        /// Call id or command identifier (for trace row pairing).
        call_id: String,
        /// Human-readable command / tool name.
        command: String,
        /// The item's `exit_code`, when the wire carried one.
        exit_code: Option<i64>,
    },
    /// A completed gateway-served MCP tool call (`mcp_tool_call` item,
    /// issue #816). `failed` carries the wire's failure signal
    /// (`status == "failed"`; any other status — absent included — stays
    /// success, the exit-code-absent posture of issue #804), and
    /// `error_message` the wire's failure anchor when it carried one.
    /// `arguments` is the item's argument object serialized compact at the
    /// parse boundary (empty when the wire carried none).
    McpToolCall {
        /// Call id (for trace row pairing).
        call_id: String,
        /// The invoked tool's name, verbatim from the wire — the identity
        /// the gateway's own dispatch row carries. The settle-time dedup
        /// (`merge_outcomes`) pairs the two for builtin and
        /// CLI-registration names; a namespaced external name's echo
        /// survives the merge today — a cross-path gap shared with the
        /// ACP / claude paths (issue #820).
        name: String,
        /// The wire's `arguments`, compact-serialized.
        arguments: String,
        /// Whether the wire reported the call failed.
        failed: bool,
        /// The wire's `error.message`, when the call failed with one.
        error_message: Option<String>,
    },
    /// Any other event type (ignored by the engine).
    Other,
}

/// Parse one NDJSON line (already deserialized to [`Value`]) into a
/// [`CodexEvent`]. Defensive: unknown shapes, missing fields, or type
/// mismatches produce [`CodexEvent::Other`], never panic.
///
/// The accepted shapes are the ones `codex exec --json` actually emits
/// (measured on codex 0.147.0, issue #804): dot-typed turn events and
/// `item.completed` envelopes whose nested `item.type` discriminates the
/// payload. `item.started` is the streaming variant of the same items —
/// its output is not yet aggregated and folding it would double every
/// row, so it stays [`CodexEvent::Other`] like every other unmeasured
/// type (`thread.started`, ...); the reasoning item folds only its
/// completed envelope (issue #807).
pub(crate) fn parse_event(value: &Value) -> CodexEvent {
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    match event_type {
        "turn.started" => CodexEvent::TurnStarted,
        "turn.completed" => CodexEvent::TurnCompleted,
        "turn.failed" => CodexEvent::TurnFailed {
            error: extract_error(value),
        },
        "turn.aborted" => CodexEvent::TurnFailed {
            // The abort vocabulary stays visible: an aborted turn is a
            // distinct wire event, not a failed one with a lost detail.
            error: extract_error_detail(value)
                .unwrap_or_else(|| "turn aborted (no error detail)".to_string()),
        },
        "item.completed" => {
            // None = an item type the parser does not recognize, or a
            // recognized one with a degenerate payload (an empty
            // reasoning text, a missing agent_message text). Wire drift
            // lands here, so the drop stays observable at debug level;
            // the known-legitimate ignored kinds (thread.started,
            // item.started) never reach this arm.
            let event = parse_item(value.get("item"));
            if event.is_none() {
                log::debug!(
                    target: "toptopduck::acp",
                    "unrecognized or degenerate item.completed (item type: {}), staying Other",
                    value
                        .get("item")
                        .and_then(|item| item.get("type"))
                        .and_then(|t| t.as_str())
                        .unwrap_or("<missing>")
                );
            }
            event.unwrap_or(CodexEvent::Other)
        }
        _ => CodexEvent::Other,
    }
}

/// Parse the nested `item` of an `item.completed` envelope. Only the item
/// types that drive the turn are recognized: `agent_message` (the text
/// rides `item.text`), `reasoning` (non-empty `item.text`, issue #807),
/// `command_execution` (issue #804), and `mcp_tool_call` — the
/// gateway-served tool call, whose shape is pinned from the codex 0.153.1
/// protocol definition, not a capture (issue #816).
fn parse_item(item: Option<&Value>) -> Option<CodexEvent> {
    let item = item?;
    match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "agent_message" => {
            item.get("text")
                .and_then(|v| v.as_str())
                .map(|text| CodexEvent::AgentMessage {
                    text: text.to_string(),
                })
        }
        "reasoning" => item
            .get("text")
            .and_then(|v| v.as_str())
            .filter(|text| !text.is_empty())
            .map(|text| CodexEvent::Reasoning {
                text: text.to_string(),
            }),
        "command_execution" => extract_command(item),
        "mcp_tool_call" => extract_mcp_tool_call(item),
        _ => None,
    }
}

/// Extract a completed `mcp_tool_call` item into its
/// [`CodexEvent::McpToolCall`] variant (issue #816). The tool name anchors
/// the row — a missing one is degenerate and stays unparsed; `id` falls
/// back empty like the command path. A missing `status` stays success (the
/// exit-code-absent posture); `"failed"` is the only failure vocabulary.
fn extract_mcp_tool_call(item: &Value) -> Option<CodexEvent> {
    let name = item.get("tool").and_then(|v| v.as_str())?;
    let call_id = item
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let arguments = item
        .get("arguments")
        .filter(|v| !v.is_null())
        .map(|v| v.to_string())
        .unwrap_or_default();
    let failed = item.get("status").and_then(|v| v.as_str()) == Some("failed");
    let error_message = item
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some(CodexEvent::McpToolCall {
        call_id,
        name: name.to_string(),
        arguments,
        failed,
        error_message,
    })
}

/// The badge + argument digest a gateway call's live row carries
/// (issue #816), replaying the gateway's dispatch classification where the
/// stream layer can: a builtin name keeps its spec badge; a namespaced
/// external name keeps `Network`; anything else approximates the gateway's
/// CLI arm (`Execute`) — a registered CLI tool's name is the common case,
/// though the registration table itself is not reachable from the stream
/// layer (a bare unknown name, which the gateway classifies `Network`,
/// takes the same approximation). The digest is the wire's compact
/// argument JSON under the trace-excerpt truncation (the
/// `command_execution` discipline); an empty digest (no arguments, or an
/// empty argument object) degrades to the tool name so the row never
/// renders bare.
fn mcp_tool_call_display(name: &str, arguments: &str) -> (OperationKind, String) {
    let kind = if let Some(spec) = crate::tools::definitions::builtin_metadata(name) {
        spec.operation_kind
    } else if crate::mcp::aggregator::is_namespaced(name) {
        OperationKind::Network
    } else {
        OperationKind::Execute
    };
    let digest = if arguments.is_empty() || arguments == "{}" {
        name.to_string()
    } else {
        truncate_trace_excerpt(arguments, TRACE_EXCERPT_MAX)
    };
    (kind, digest)
}

/// Extract the error detail from a terminal-turn event, falling back
/// through common field names; `None` when the wire carried no detail.
fn extract_error_detail(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|v| {
            v.as_str().map(|s| s.to_string()).or_else(|| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
        })
        .or_else(|| {
            value
                .get("message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

/// The failed-turn error message: the wire detail, or the generic failed
/// fallback.
fn extract_error(value: &Value) -> String {
    extract_error_detail(value).unwrap_or_else(|| "turn failed (no error detail)".to_string())
}

/// Extract a completed `command_execution` item into its
/// [`CodexEvent::CommandExecution`] variant. The call id is `item.id` (a
/// `call_id` spelling is tolerated); a missing command contributes nothing.
fn extract_command(item: &Value) -> Option<CodexEvent> {
    let command = item
        .get("command")
        .and_then(|v| v.as_str())
        .map(str::to_string)?;

    let call_id = item
        .get("id")
        .or_else(|| item.get("call_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // as_i64 is None for a missing or null code -- an unknown outcome.
    let exit_code = item.get("exit_code").and_then(|v| v.as_i64());

    Some(CodexEvent::CommandExecution {
        call_id,
        command,
        exit_code,
    })
}

// ---------------------------------------------------------------------------
// Config override builder (pure)
// ---------------------------------------------------------------------------

/// Encode `value` as a TOML string scalar. `-c key=value` override values
/// are parsed with TOML semantics on the codex side, so a bare numeric port
/// lands as an integer and codex rejects the whole config; Windows paths
/// fare likewise. The `toml` encoder owns the escaping (backslashes,
/// embedded quotes).
fn encode_toml_string(value: &str) -> String {
    toml::Value::String(value.to_string()).to_string()
}

/// Build the `-c key=value` argv segments that inject the gateway bridge MCP
/// server entry into codex's runtime config (ADR-0094 Decision 4). Each
/// `McpServer::Stdio` in `mcp_servers` becomes a set of `-c` overrides under
/// `mcp_servers.<name>`. Scalar values go through [`encode_toml_string`] so
/// overrides stay shape-safe regardless of value content.
pub(crate) fn build_config_overrides(mcp_servers: &[McpServer]) -> Vec<String> {
    let mut flags = Vec::new();
    for server in mcp_servers {
        if let McpServer::Stdio {
            name,
            command,
            args,
            env,
        } = server
        {
            flags.push("-c".to_string());
            flags.push(format!(
                "mcp_servers.{name}.command={}",
                encode_toml_string(command)
            ));
            if !args.is_empty() {
                let joined = args
                    .iter()
                    .map(|a| encode_toml_string(a))
                    .collect::<Vec<_>>()
                    .join(", ");
                flags.push("-c".to_string());
                flags.push(format!("mcp_servers.{name}.args=[{joined}]"));
            }
            for (k, v) in env {
                flags.push("-c".to_string());
                flags.push(format!(
                    "mcp_servers.{name}.env.{k}={}",
                    encode_toml_string(v)
                ));
            }
            // Server-level tool-approval posture (issue #800): codex exec's
            // approval gate auto-rejects annotation-less MCP tools (their
            // destructive / open-world hints default to needing approval) —
            // `user cancelled MCP tool call` before the call reaches the
            // gateway. Gated on the gateway server IDENTITY, not loop
            // membership: only the bridge ever earns `approve`, so a future
            // non-gateway Stdio entry in this slice cannot silently inherit
            // the exemption; the shell approval policy and the read-only
            // sandbox posture (ADR-0094) are untouched.
            if name.as_str() == crate::session::GATEWAY_SERVER_NAME {
                flags.push("-c".to_string());
                flags.push(format!(
                    "mcp_servers.{name}.default_tools_approval_mode={}",
                    encode_toml_string("approve")
                ));
            }
        }
    }
    flags
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/// Drive one codex `exec --json` turn (ADR-0094). Spawns the CLI with the
/// bridge MCP injected via config overrides, writes the flattened prompt to
/// stdin, reads NDJSON events from stdout, and returns the SAME [`LoopOutcome`]
/// shape as the ACP path. The caller owns the cancel token + execution caps;
/// `on_phase` mirrors the ACP path's phase emission.
///
/// `approval` + `sink` are accepted for signature parity with the ACP path but
/// unused — the gateway enforces approval (ADR-0094 Decision 5); the JSON event
/// stream has no protocol-level permission request.
#[allow(clippy::too_many_arguments)]
pub(super) fn run_codex_event_stream(
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

    // Wall-clock watchdog (same as ACP): fire cancel on expiry.
    if let Some(timeout) = wall_clock {
        spawn_wall_clock_watchdog(
            guard.generation(),
            Arc::clone(&cancel),
            timeout,
            "toptopduck::acp",
        );
    }

    // Spawn codex exec --json with the bridge injected via -c overrides +
    // the ADR-0095 model / thought-level selections: the model rides
    // `[model_arg, id]` right after the argv prefix, the thought level rides
    // a `-c {key}={value}` override (the same `-c` mechanism as the bridge).
    let config_flags = build_config_overrides(&input.mcp_servers);
    let model_flags = build_model_flags(
        adapter,
        input.model.as_deref(),
        input.thought_level.as_deref(),
    );
    let mut child = match super::process::spawn_turn(
        binary,
        adapter.argv,
        &model_flags,
        &config_flags,
        &input.cwd,
    ) {
        Ok(c) => c,
        Err(e) => {
            return outcome(
                Termination::Transient(format!("failed to spawn codex exec `{}`: {e}", adapter.id)),
                Vec::new(),
            )
        }
    };

    // Write the flattened prompt to stdin, then close stdin so codex begins
    // processing (exec reads the prompt from stdin when no positional arg is
    // given). The write rides the cancel-aware helper (issue #808): a CLI
    // that stalls before draining stdin cannot wedge the turn before the
    // pump loop's cancel check becomes reachable. The two former per-write
    // failure messages collapse into one (the flush leg only failed on an
    // already-broken pipe, which the single message now names).
    let stdin = child.stdin.take().expect("piped stdin");
    let prompt = flatten_prompt(&input.prompt_blocks);
    match super::process::write_prompt_with_cancel(stdin, prompt, &cancel, &mut child) {
        super::process::StdinWriteOutcome::Done => {}
        super::process::StdinWriteOutcome::Failed(e) => {
            return outcome(
                Termination::Transient(format!("stdin write failed: {e}")),
                Vec::new(),
            )
        }
        super::process::StdinWriteOutcome::Cancelled => {
            return outcome(Termination::Cancelled, Vec::new())
        }
    }

    let stdout = child.stdout.take().expect("piped stdout");

    // Reader thread (shared, line-capped -- issue #639).
    let rx = super::process::spawn_line_reader(stdout);

    // Signal Thinking once before the event pump (one exec invocation = one
    // turn = one thinking wait).
    on_phase(TurnPhase::Thinking { attempt: 1 });

    let mut pump = JsonPump::new(step_cap);

    let mut termination = None;
    let mut step_cap_tripped = false;

    loop {
        // Cancel check (mirrors the ACP loop-top check).
        if cancel.is_requested() {
            termination = Some(Termination::Cancelled);
            break;
        }
        // Step-cap trip (execution-level cap, ADR-0081). Unlike the ACP path
        // there is no protocol-level cancel message — kill the child and
        // terminate. Counting tool_call_count > step_cap means the cap was
        // exceeded, so the agent did not converge.
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
                if let Some(term) = pump.fold(parse_event(&value), &mut on_phase) {
                    termination = Some(term);
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // stdout closed before a terminal event. If the tracker holds
                // terminal text, treat it as success (codex may close stdout
                // after the final message without an explicit turn.completed);
                // otherwise it is a transient failure.
                termination = Some(
                    pump.tracker
                        .text_or_transient("codex closed stdout without a terminal event"),
                );
                break;
            }
        }
    }

    // If the step cap tripped, override any pending termination.
    if step_cap_tripped {
        termination = Some(Termination::StepCap(step_cap));
    }

    super::process::kill_and_reap(&mut child);

    let term = termination.unwrap_or_else(|| {
        // No terminal event and no error — the pump exited without resolution.
        // Treat the terminal text as the answer if any; otherwise transient.
        pump.tracker
            .text_or_transient("codex turn ended without a terminal event")
    });

    // Close the trailing round's thought stream before the settle (the
    // claude path's turn-end freeze, issue #807): `settle_rounds` reads
    // only frozen thinking, so an unfrozen buffer would silently drop, and
    // a call-less trailing round holding reasoning must survive the pop.
    // No pending-row drain here -- command events carry no result frame.
    pump.tracker.freeze_trailing_thinking(&mut on_phase);
    let rounds = pump.tracker.settle_rounds(&term);
    outcome(term, rounds)
}

/// Mutable state accumulated while pumping codex events. The round
/// bookkeeping + terminal-text fallback are shared with the other stream
/// paths (ADR-0103, issues #611/#612/#613); command events carry no result
/// frame, so no pending-row drain exists here.
struct JsonPump {
    tracker: RoundTracker,
    /// Count of command/tool executions observed (step-cap counter).
    tool_call_count: u32,
    step_cap: u32,
}

impl JsonPump {
    fn new(step_cap: u32) -> Self {
        Self {
            tracker: RoundTracker::new(),
            tool_call_count: 0,
            step_cap,
        }
    }

    /// Fold one parsed event: emit live phases, accumulate the round
    /// bookkeeping, and return the turn's termination when the event is a
    /// terminal one (issue #613 -- the claude path's pump fold seam).
    fn fold(
        &mut self,
        event: CodexEvent,
        on_phase: &mut impl FnMut(TurnPhase),
    ) -> Option<Termination> {
        match event {
            // Already signaled Thinking before the pump; a redundant signal
            // would confuse the UI. No-op.
            CodexEvent::TurnStarted => None,
            CodexEvent::TurnCompleted => Some(Termination::Text(self.tracker.terminal_text())),
            CodexEvent::TurnFailed { error } => Some(Termination::Transient(error)),
            CodexEvent::AgentMessage { text } => {
                // Empty text (an `agent_message` item carrying an empty
                // text string) would open a ghost round and fire a phantom
                // Thinking pointer; skip it (the claude path guards the
                // same case before push_prose).
                if !text.is_empty() {
                    self.tracker.push_prose(&text, on_phase);
                }
                None
            }
            CodexEvent::CommandExecution {
                call_id,
                command,
                exit_code,
            } => {
                self.tool_call_count += 1;
                // exit_code maps the row's success (issue #804): zero (or
                // absent -- an unknown outcome) succeeds, non-zero fails
                // with the code as the failure anchor.
                let summary = truncate_trace_excerpt(&command, TRACE_EXCERPT_MAX);
                let entry = match exit_code {
                    Some(code) if code != 0 => TraceEntry::failed(
                        call_id,
                        command.clone(),
                        OperationKind::Execute,
                        summary.clone(),
                        format!("command exited with code {code}"),
                    ),
                    _ => TraceEntry::succeeded(
                        call_id,
                        command.clone(),
                        OperationKind::Execute,
                        summary.clone(),
                        String::new(),
                    ),
                };
                // The round's first call fires its prose prelude BEFORE the
                // batch's ToolCallStarted (the ADR-0103 live order the
                // frontend's round grouping relies on).
                let round = self.tracker.call_round(on_phase);
                on_phase(TurnPhase::ToolCallStarted {
                    name: command,
                    operation_kind: OperationKind::Execute,
                    summary,
                });
                on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
                self.tracker.land_call(round, entry);
                None
            }
            CodexEvent::Reasoning { text } => {
                // The parse boundary guarantees a non-empty text, so the
                // fold needs no empty guard. Duration stays pinned to 0
                // (push_thought_pinned's no-clock contract, issue #807).
                self.tracker.push_thought_pinned(&text, on_phase);
                None
            }
            CodexEvent::McpToolCall {
                call_id,
                name,
                arguments,
                failed,
                error_message,
            } => {
                self.tool_call_count += 1;
                // The badge + digest replay the gateway's dispatch row
                // where the stream layer can (issue #816). The settle-time
                // dedup (`merge_outcomes`) drops this echo for builtin and
                // CLI-registration names; a namespaced external name's echo
                // survives today (issue #820, a cross-path gap).
                let (operation_kind, summary) = mcp_tool_call_display(&name, &arguments);
                let entry = if failed {
                    // An empty message degrades to the constructor's
                    // failure-anchor fallback — the anchor is never empty.
                    TraceEntry::failed(
                        call_id,
                        name.clone(),
                        operation_kind,
                        summary.clone(),
                        error_message.unwrap_or_default(),
                    )
                } else {
                    TraceEntry::succeeded(
                        call_id,
                        name.clone(),
                        operation_kind,
                        summary.clone(),
                        String::new(),
                    )
                };
                // Same-point phase pair + round landing as the
                // command_execution shape (issue #816): the round's first
                // call fires its prelude BEFORE the batch's
                // ToolCallStarted (the ADR-0103 live order).
                let round = self.tracker.call_round(on_phase);
                on_phase(TurnPhase::ToolCallStarted {
                    name,
                    operation_kind,
                    summary,
                });
                on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
                self.tracker.land_call(round, entry);
                None
            }
            CodexEvent::Other => None,
        }
    }
}

/// Build the [`LoopOutcome`] (same shape as the ACP engine's `outcome`).
fn outcome(termination: Termination, rounds: Vec<LoopRound>) -> LoopOutcome {
    LoopOutcome {
        termination,
        // Promotions are gateway-side (ADR-0085: the bridge -> gateway ->
        // tools::dispatch path); the JSON event stream engine owns only the
        // event-driving half.
        promotions: Vec::new(),
        // ADR-0103 (issue #613): the trajectory settles per round (each
        // batch round carries its prose); an empty trajectory stays an
        // empty round list (no ghost round).
        trace: rounds,
        // ADR-0095: `exec --json` exposes no config catalog -- no discovery.
        discovered_runtime: None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::acp::wire::McpServer;
    use std::collections::BTreeMap;

    // --- parse_event --------------------------------------------------------

    /// One full turn as the real CLI emits it (codex 0.147.0, captured in
    /// issue #804; values neutralized). Every turn/command/agent/reasoning
    /// wire-format pin below traces back to these lines; the
    /// `mcp_tool_call` shape is protocol-pinned instead (its own fixture,
    /// issue #816).
    const MEASURED_TURN_NDJSON: &[&str] = &[
        r#"{"type":"thread.started","thread_id":"<uuid>"}"#,
        r#"{"type":"turn.started"}"#,
        r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking..."}}"#,
        r#"{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"<command>","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"<command>","aggregated_output":"<output>","exit_code":0,"status":"completed"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"the answer"}}"#,
        r#"{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}"#,
    ];

    /// Parse one fixture line (the lines are literals; a deserialization
    /// failure is a fixture-authoring error, never a runtime one).
    fn fixture_event(line: &str) -> CodexEvent {
        let v: Value = serde_json::from_str(line).unwrap();
        parse_event(&v)
    }

    /// The end-of-turn freeze + settle the driver performs (the claude
    /// path's settle seam, issue #807): freeze the trailing round's thought
    /// stream (its ThinkingCompleted renders live), then settle the rounds
    /// under the turn's termination.
    fn settle(
        mut pump: JsonPump,
        phases: &mut Vec<TurnPhase>,
        termination: &Termination,
    ) -> Vec<LoopRound> {
        pump.tracker
            .freeze_trailing_thinking(&mut |p| phases.push(p));
        pump.tracker.settle_rounds(termination)
    }

    #[test]
    fn parse_turn_started() {
        assert_eq!(
            fixture_event(MEASURED_TURN_NDJSON[1]),
            CodexEvent::TurnStarted
        );
    }

    /// The terminal event carries a usage payload the parser ignores.
    #[test]
    fn parse_turn_completed_with_usage() {
        assert_eq!(
            fixture_event(MEASURED_TURN_NDJSON[6]),
            CodexEvent::TurnCompleted
        );
    }

    /// The `error` field never triggered in the captured turns; both field
    /// forms stay defensive fallbacks (issue #804).
    #[test]
    fn parse_turn_failed_error_string() {
        let v: Value = serde_json::json!({"type": "turn.failed", "error": "rate limited"});
        assert_eq!(
            parse_event(&v),
            CodexEvent::TurnFailed {
                error: "rate limited".into()
            }
        );
    }

    #[test]
    fn parse_turn_failed_error_object() {
        let v: Value =
            serde_json::json!({"type": "turn.failed", "error": {"message": "bad config"}});
        assert_eq!(
            parse_event(&v),
            CodexEvent::TurnFailed {
                error: "bad config".into()
            }
        );
    }

    /// An aborted turn keeps its abort vocabulary in the fallback — an
    /// abort is a distinct wire event, not a failure with a lost detail.
    #[test]
    fn parse_turn_aborted_without_error_detail() {
        let v: Value = serde_json::json!({"type": "turn.aborted"});
        assert_eq!(
            parse_event(&v),
            CodexEvent::TurnFailed {
                error: "turn aborted (no error detail)".into()
            }
        );
    }

    #[test]
    fn parse_item_completed_agent_message() {
        assert_eq!(
            fixture_event(MEASURED_TURN_NDJSON[5]),
            CodexEvent::AgentMessage {
                text: "the answer".into()
            }
        );
    }

    #[test]
    fn parse_item_completed_command_execution_zero_exit() {
        assert_eq!(
            fixture_event(MEASURED_TURN_NDJSON[4]),
            CodexEvent::CommandExecution {
                call_id: "item_1".into(),
                command: "<command>".into(),
                exit_code: Some(0),
            }
        );
    }

    #[test]
    fn parse_item_completed_command_execution_nonzero_exit() {
        let v: Value = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_7",
                "type": "command_execution",
                "command": "<command>",
                "exit_code": 2,
                "status": "completed"
            }
        });
        assert_eq!(
            parse_event(&v),
            CodexEvent::CommandExecution {
                call_id: "item_7".into(),
                command: "<command>".into(),
                exit_code: Some(2),
            }
        );
    }

    /// The `mcp_tool_call` item shape per the codex 0.153.1 protocol
    /// definition (`McpToolCallItem`: `id` / `server` / `tool` /
    /// `arguments` / `status` / optional `error`) — pinned from the
    /// protocol source, not a capture; the real-CLI capture is pending
    /// (issue #816).
    const MCP_TOOL_CALL_LINES: &[&str] = &[
        r#"{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"toptopduck-gateway","tool":"convert","arguments":{"input":"a.csv"},"status":"completed"}}"#,
        r#"{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"toptopduck-gateway","tool":"convert","arguments":{"input":"b.csv"},"status":"failed","error":{"message":"converter crashed"}}}"#,
    ];

    #[test]
    fn parse_item_completed_mcp_tool_call_success() {
        assert_eq!(
            fixture_event(MCP_TOOL_CALL_LINES[0]),
            CodexEvent::McpToolCall {
                call_id: "item_1".into(),
                name: "convert".into(),
                arguments: r#"{"input":"a.csv"}"#.into(),
                failed: false,
                error_message: None,
            }
        );
    }

    #[test]
    fn parse_item_completed_mcp_tool_call_failed_carries_error() {
        assert_eq!(
            fixture_event(MCP_TOOL_CALL_LINES[1]),
            CodexEvent::McpToolCall {
                call_id: "item_2".into(),
                name: "convert".into(),
                arguments: r#"{"input":"b.csv"}"#.into(),
                failed: true,
                error_message: Some("converter crashed".into()),
            }
        );
    }

    /// A missing `tool` is degenerate (no identity to anchor the row): the
    /// item stays Other rather than landing an anonymous trace row.
    #[test]
    fn parse_item_completed_mcp_tool_call_without_tool_stays_other() {
        let v: Value = serde_json::json!({
            "type": "item.completed",
            "item": {"id": "item_1", "type": "mcp_tool_call", "status": "completed"}
        });
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    /// An absent `status` stays success — the exit-code-absent posture
    /// (issue #804): a missing outcome signal is unknown, not failed.
    #[test]
    fn parse_item_completed_mcp_tool_call_without_status_stays_success() {
        let v: Value = serde_json::json!({
            "type": "item.completed",
            "item": {"id": "item_1", "type": "mcp_tool_call", "tool": "convert"}
        });
        assert_eq!(
            parse_event(&v),
            CodexEvent::McpToolCall {
                call_id: "item_1".into(),
                name: "convert".into(),
                arguments: String::new(),
                failed: false,
                error_message: None,
            }
        );
    }

    /// `arguments: null` carries no digest — the null filter at the parse
    /// boundary keeps the row's summary from rendering a bare `null`.
    #[test]
    fn parse_item_completed_mcp_tool_call_null_arguments_stay_empty() {
        let v: Value = serde_json::json!({
            "type": "item.completed",
            "item": {
                "id": "item_1",
                "type": "mcp_tool_call",
                "tool": "convert",
                "arguments": null,
                "status": "completed"
            }
        });
        assert_eq!(
            parse_event(&v),
            CodexEvent::McpToolCall {
                call_id: "item_1".into(),
                name: "convert".into(),
                arguments: String::new(),
                failed: false,
                error_message: None,
            }
        );
    }

    /// The row's badge/summary replay the gateway's dispatch
    /// classification where the stream layer can (issue #816): a builtin
    /// name keeps its spec badge, a namespaced external name keeps
    /// Network, anything else (a registered CLI tool's name — the
    /// registration table is not reachable from the stream layer) badges
    /// Execute. An empty argument digest degrades to the tool name.
    #[test]
    fn mcp_tool_call_badge_and_summary_replay_gateway_classification() {
        let (kind, summary) = mcp_tool_call_display("explore", r#"{"sql":"SELECT 1"}"#);
        assert_eq!(kind, OperationKind::Read);
        assert_eq!(summary, r#"{"sql":"SELECT 1"}"#);

        let (kind, _) = mcp_tool_call_display("mcp__duckdb__query_snapshot", "{}");
        assert_eq!(kind, OperationKind::Network);

        let (kind, summary) = mcp_tool_call_display("convert", "{}");
        assert_eq!(kind, OperationKind::Execute);
        assert_eq!(summary, "convert", "an empty digest degrades to the name");

        let (_, summary) = mcp_tool_call_display("convert", "");
        assert_eq!(summary, "convert");
    }

    /// The measured wire carries `id`; a `call_id` spelling is tolerated
    /// as the fallback, never the winner when both are present.
    #[test]
    fn parse_item_completed_command_execution_call_id_spelling() {
        for (item, want) in [
            (
                serde_json::json!({"id": "item_a", "call_id": "call_b", "type": "command_execution", "command": "ls"}),
                "item_a",
            ),
            (
                serde_json::json!({"call_id": "call_b", "type": "command_execution", "command": "ls"}),
                "call_b",
            ),
        ] {
            let v: Value = serde_json::json!({"type": "item.completed", "item": item});
            assert_eq!(
                parse_event(&v),
                CodexEvent::CommandExecution {
                    call_id: want.into(),
                    command: "ls".into(),
                    exit_code: None,
                }
            );
        }
    }

    /// The streaming variant never folds: its aggregated_output is empty and
    /// its exit_code is null — folding it would double every trace row.
    #[test]
    fn parse_item_started_command_execution_is_other() {
        assert_eq!(fixture_event(MEASURED_TURN_NDJSON[3]), CodexEvent::Other);
    }

    #[test]
    fn parse_thread_started_is_other() {
        assert_eq!(fixture_event(MEASURED_TURN_NDJSON[0]), CodexEvent::Other);
    }

    /// A completed reasoning item folds its text (issue #807): the
    /// per-round thinking fold's wire source.
    #[test]
    fn parse_reasoning_item() {
        assert_eq!(
            fixture_event(MEASURED_TURN_NDJSON[2]),
            CodexEvent::Reasoning {
                text: "thinking...".into()
            }
        );
    }

    /// An empty reasoning text is defensive Other -- the fold would
    /// otherwise open a ghost round and fire a phantom Thinking pointer
    /// (the AgentMessage guard's same case).
    #[test]
    fn parse_reasoning_empty_text_is_other() {
        let v: Value = serde_json::json!({
            "type": "item.completed",
            "item": {"id": "item_0", "type": "reasoning", "text": ""}
        });
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    /// A reasoning item carrying no text field (or a non-string one)
    /// contributes nothing.
    #[test]
    fn parse_reasoning_missing_or_non_string_text_is_other() {
        for item in [
            serde_json::json!({"id": "item_0", "type": "reasoning"}),
            serde_json::json!({"id": "item_0", "type": "reasoning", "text": 42}),
        ] {
            let v: Value = serde_json::json!({"type": "item.completed", "item": item});
            assert_eq!(parse_event(&v), CodexEvent::Other, "shape parsed: {v}");
        }
    }

    /// The `item.started` streaming variant of a reasoning item stays Other
    /// -- the completed envelope is the only folded half, so a wire that
    /// streams both never double-counts the block (the `command_execution`
    /// precedent, issue #807's measured-but-unconfirmed case).
    #[test]
    fn parse_item_started_reasoning_is_other() {
        let v: Value = serde_json::json!({
            "type": "item.started",
            "item": {"id": "item_0", "type": "reasoning", "text": "thinking..."}
        });
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    #[test]
    fn parse_item_completed_unknown_item_type_is_other() {
        let v: Value = serde_json::json!({
            "type": "item.completed",
            "item": {"id": "item_8", "type": "file_change", "path": "x.txt"}
        });
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    /// An `item.completed` envelope with no item object at all.
    #[test]
    fn parse_item_completed_missing_item_is_other() {
        let v: Value = serde_json::json!({"type": "item.completed"});
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    /// A command_execution item without a command string contributes
    /// nothing (no row to pair).
    #[test]
    fn parse_command_execution_without_command_is_other() {
        let v: Value = serde_json::json!({
            "type": "item.completed",
            "item": {"id": "item_9", "type": "command_execution", "exit_code": 0}
        });
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    /// The pre-measurement guessed shapes (underscore types, the nested
    /// `{"type":"turn",...}` / `{"type":"item",...}` envelopes) have no
    /// source on the wire — they stay unaccepted, no dual-format
    /// compatibility (issue #804).
    #[test]
    fn guessed_pre_measurement_shapes_stay_other() {
        for v in [
            serde_json::json!({"type": "turn_completed"}),
            serde_json::json!({"type": "turn", "status": "completed"}),
            serde_json::json!({"type": "item", "subtype": "agent_message", "status": "completed"}),
        ] {
            assert_eq!(
                parse_event(&v),
                CodexEvent::Other,
                "guessed shape parsed: {v}"
            );
        }
    }

    #[test]
    fn parse_unknown_event_is_other() {
        let v: Value = serde_json::json!({"type": "session_meta", "id": "abc"});
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    #[test]
    fn parse_missing_type_is_other() {
        let v: Value = serde_json::json!({"foo": "bar"});
        assert_eq!(parse_event(&v), CodexEvent::Other);
    }

    // --- build_config_overrides ---------------------------------------------

    #[test]
    fn config_overrides_for_stdio_server() {
        let server = McpServer::stdio_bridge(
            "toptopduck-gateway",
            "/abs/path/to/bridge",
            vec![],
            BTreeMap::from([
                ("TOPTOPDUCK_GATEWAY_PORT".to_string(), "12345".to_string()),
                ("TOPTOPDUCK_GATEWAY_TOKEN".to_string(), "abc".to_string()),
            ]),
        );
        let flags = build_config_overrides(&[server]);
        assert!(flags.contains(&"-c".to_string()));
        // Scalar values are TOML-encoded strings so `-c` overrides keep the
        // string type codex expects, whatever the value looks like.
        assert!(flags
            .iter()
            .any(|f| f == "mcp_servers.toptopduck-gateway.command=\"/abs/path/to/bridge\""));
        assert!(flags
            .iter()
            .any(|f| f == "mcp_servers.toptopduck-gateway.env.TOPTOPDUCK_GATEWAY_PORT=\"12345\""));
        assert!(flags
            .iter()
            .any(|f| f == "mcp_servers.toptopduck-gateway.env.TOPTOPDUCK_GATEWAY_TOKEN=\"abc\""));
        // Issue #800: the server-level tool-approval posture rides with the
        // descriptor so codex exec's approval gate cannot auto-reject the
        // gateway tools before the call reaches the gateway.
        assert!(
            flags
                .iter()
                .any(|f| f
                    == "mcp_servers.toptopduck-gateway.default_tools_approval_mode=\"approve\"")
        );
        // No args override when args is empty.
        assert!(!flags.iter().any(|f| f.contains(".args=")));
    }

    #[test]
    fn config_overrides_includes_args_array() {
        let server = McpServer::stdio_bridge(
            "srv",
            "/bin/srv",
            vec!["--flag".to_string(), "value".to_string()],
            BTreeMap::new(),
        );
        let flags = build_config_overrides(&[server]);
        let args_flag = flags
            .iter()
            .find(|f| f.starts_with("mcp_servers.srv.args="));
        assert!(args_flag.is_some());
        assert!(args_flag.unwrap().contains("\"--flag\""));
        assert!(args_flag.unwrap().contains("\"value\""));
        // Issue #800 (review follow-up): the approve override is gated on
        // the gateway server identity — a non-gateway Stdio entry never
        // inherits the exemption.
        assert!(!flags
            .iter()
            .any(|f| f.contains("default_tools_approval_mode")));
    }

    /// Parse the RHS of a `-c key=value` override with TOML value semantics,
    /// mirroring how codex consumes the override.
    fn override_value(flag: &str) -> toml::Value {
        flag.split_once('=')
            .and_then(|(_, v)| v.parse::<toml::Value>().ok())
            .unwrap_or_else(|| panic!("override value parses as TOML: {flag}"))
    }

    /// Regression pin for the codex config rejection: a bare numeric port
    /// parses as a TOML integer and codex rejects the whole config
    /// ("invalid type: integer, expected a string"). The override must carry
    /// a quoted string that still parses as a string.
    #[test]
    fn config_overrides_numeric_env_value_is_toml_string() {
        let server = McpServer::stdio_bridge(
            "gw",
            "/bin/gw",
            vec![],
            BTreeMap::from([("PORT".to_string(), "52787".to_string())]),
        );
        let flags = build_config_overrides(&[server]);
        assert!(flags
            .iter()
            .any(|f| f == "mcp_servers.gw.env.PORT=\"52787\""));
        let flag = flags
            .iter()
            .find(|f| f.starts_with("mcp_servers.gw.env.PORT="))
            .unwrap();
        let value = override_value(flag);
        assert_eq!(value.as_str(), Some("52787"));
        assert_eq!(value.as_integer(), None);
    }

    /// Windows paths and embedded quotes stay round-trip clean through the
    /// TOML encoding codex applies to `-c` values.
    #[test]
    fn config_overrides_escape_windows_paths_and_embedded_quotes() {
        let command = "C:\\dev\\toptopduck-bridge.exe";
        let token = "a\"b\\c";
        let server = McpServer::stdio_bridge(
            "gw",
            command,
            vec![],
            BTreeMap::from([("TOKEN".to_string(), token.to_string())]),
        );
        let flags = build_config_overrides(&[server]);
        let flag = flags
            .iter()
            .find(|f| f.starts_with("mcp_servers.gw.command="))
            .unwrap();
        assert_eq!(override_value(flag).as_str(), Some(command));
        let flag = flags
            .iter()
            .find(|f| f.starts_with("mcp_servers.gw.env.TOKEN="))
            .unwrap();
        assert_eq!(override_value(flag).as_str(), Some(token));
    }

    #[test]
    fn config_overrides_args_values_escape_embedded_quotes() {
        let server = McpServer::stdio_bridge(
            "srv",
            "/bin/srv",
            vec!["say \"hi\"".to_string(), "C:\\path".to_string()],
            BTreeMap::new(),
        );
        let flags = build_config_overrides(&[server]);
        let flag = flags
            .iter()
            .find(|f| f.starts_with("mcp_servers.srv.args="))
            .unwrap();
        assert_eq!(
            override_value(flag),
            toml::Value::Array(vec![
                toml::Value::String("say \"hi\"".into()),
                toml::Value::String("C:\\path".into()),
            ])
        );
    }

    #[test]
    fn config_overrides_empty_for_no_servers() {
        assert!(build_config_overrides(&[]).is_empty());
    }

    // --- pump fold: rounds (issue #613) --------------------------------------

    /// A full trajectory settles into per-round slots: each batch round
    /// carries its prose and its calls; the trailing call-less prose rides
    /// the terminal text, not a round of its own.
    #[test]
    fn rounds_carry_prose_and_calls() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        // Round 1: prose + one command (its result implicit -- success
        // defaults to true).
        pump.fold(
            CodexEvent::AgentMessage {
                text: "let me query".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "explore SELECT 1".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        // Trailing round: prose only -- the terminal answer.
        pump.fold(
            CodexEvent::AgentMessage {
                text: "the answer is 42".into(),
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(pump.tracker.terminal_text(), "the answer is 42");
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text("the answer is 42".into()));
        assert_eq!(rounds.len(), 1, "the trailing prose-only round drops");
        assert_eq!(rounds[0].text.as_deref(), Some("let me query"));
        assert_eq!(rounds[0].calls.len(), 1);
        assert_eq!(rounds[0].calls[0].name, "explore SELECT 1");
        assert!(rounds[0].thinking.is_none(), "no thinking data source");
    }

    /// Same-round agent_message fragments merge into one round prose; the
    /// live RoundText fires once, with the merged text, at the batch seal.
    #[test]
    fn same_round_fragments_merge_into_one_prose() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::AgentMessage {
                text: "checking ".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::AgentMessage {
                text: "the table".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].text.as_deref(), Some("checking the table"));
        let round_texts = phases
            .iter()
            .filter(|p| matches!(p, TurnPhase::RoundText { .. }))
            .count();
        assert_eq!(round_texts, 1, "one merged RoundText per round");
    }

    /// A batch round that offered no prose carries no text and fires no
    /// RoundText.
    #[test]
    fn call_without_prose_keeps_round_text_empty() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1);
        assert!(rounds[0].text.is_none());
        assert!(!phases
            .iter()
            .any(|p| matches!(p, TurnPhase::RoundText { .. })));
    }

    /// The live channel's ADR-0103 order for one round: RoundText, then the
    /// batch's ToolCallStarted / Completed pair. The trailing prose opens
    /// round 2 -- the round pointer fires -- but fires no RoundText: it rides
    /// the terminal text.
    #[test]
    fn live_order_round_text_then_call_then_round_pointer() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::AgentMessage {
                text: "let me query".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "explore SELECT 1".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(phases.len(), 3);
        match &phases[0] {
            TurnPhase::RoundText { text } => assert_eq!(text, "let me query"),
            other => panic!("expected RoundText, got {other:?}"),
        }
        assert!(matches!(
            &phases[1],
            TurnPhase::ToolCallStarted { name, .. } if name == "explore SELECT 1"
        ));
        assert!(matches!(phases[2], TurnPhase::ToolCallCompleted(_)));
        pump.fold(
            CodexEvent::AgentMessage {
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

    /// Prose stays in the round it was emitted in: cross-round fragments do
    /// not blend, and each round's seal fires its own prose prelude.
    #[test]
    fn cross_round_prose_stays_in_its_round() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        for (text, call) in [("checking", "call_1"), ("verifying", "call_2")] {
            pump.fold(CodexEvent::AgentMessage { text: text.into() }, &mut |p| {
                phases.push(p)
            });
            pump.fold(
                CodexEvent::CommandExecution {
                    call_id: call.into(),
                    command: "ls".into(),
                    exit_code: None,
                },
                &mut |p| phases.push(p),
            );
        }
        pump.fold(
            CodexEvent::AgentMessage {
                text: "done".into(),
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(pump.tracker.terminal_text(), "done");
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text("done".into()));
        assert_eq!(rounds.len(), 2);
        assert_eq!(rounds[0].text.as_deref(), Some("checking"));
        assert_eq!(rounds[1].text.as_deref(), Some("verifying"));
    }

    /// A call-less turn answers with all its prose (the single trailing
    /// stretch) and settles to an empty round list -- a zero-call turn
    /// records no round.
    #[test]
    fn call_less_turn_answers_with_all_prose() {
        let mut pump = JsonPump::new(24);
        pump.fold(
            CodexEvent::AgentMessage {
                text: "part one ".into(),
            },
            &mut |_| {},
        );
        pump.fold(
            CodexEvent::AgentMessage {
                text: "part two".into(),
            },
            &mut |_| {},
        );
        let end = pump.fold(CodexEvent::TurnCompleted, &mut |_| {});
        assert_eq!(end, Some(Termination::Text("part one part two".into())));
        assert!(pump
            .tracker
            .settle_rounds(&Termination::Text("part one part two".into()))
            .is_empty());
    }

    /// turn.completed with no prose yields the empty text -- the honest
    /// degrade shape the answer path already returns.
    #[test]
    fn turn_completed_without_prose_yields_empty_text() {
        let mut pump = JsonPump::new(24);
        let end = pump.fold(CodexEvent::TurnCompleted, &mut |_| {});
        assert_eq!(end, Some(Termination::Text(String::new())));
    }

    /// stdout closing after a batch answers with the trailing stretch ONLY
    /// -- the mid-batch prose stays in its round slot (the dual-track
    /// semantics, the claude path's EOF precedent).
    #[test]
    fn eof_after_batch_answers_with_trailing_stretch_only() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::AgentMessage {
                text: "checking".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::AgentMessage {
                text: "final answer".into(),
            },
            &mut |p| phases.push(p),
        );
        assert_eq!(pump.tracker.terminal_text(), "final answer");
        assert_eq!(
            pump.tracker.text_or_transient("eof"),
            Termination::Text("final answer".into())
        );
        // Settling under the promoted Text drops the tail (its prose rode
        // the terminal text) -- the EOF fallback and the round settle stay
        // consistent (issue #628).
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text("final answer".into()));
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].text.as_deref(), Some("checking"));
        assert!(phases
            .iter()
            .any(|p| matches!(p, TurnPhase::RoundText { text } if text == "checking")));
    }

    /// An empty agent_message (an item whose `text` is an empty string)
    /// opens no round and fires no phantom round pointer -- the pre-#613
    /// no-op shape (the claude path guards the same case before
    /// push_prose).
    #[test]
    fn empty_agent_message_opens_no_round() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::AgentMessage {
                text: String::new(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::AgentMessage {
                text: String::new(),
            },
            &mut |p| phases.push(p),
        );
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1, "the empty prose opens no extra round");
        assert!(rounds[0].text.is_none());
        assert!(
            !phases
                .iter()
                .any(|p| matches!(p, TurnPhase::Thinking { .. })),
            "no phantom round pointer"
        );
    }

    /// stdout closing right after a batch (no trailing stretch) falls back
    /// to the full accumulation -- the shared terminal-text semantics for
    /// models that put their answer alongside the final batch. The prose
    /// still sits in its round slot.
    #[test]
    fn eof_after_batch_without_trailing_falls_back_to_full_text() {
        let mut pump = JsonPump::new(24);
        pump.fold(
            CodexEvent::AgentMessage {
                text: "checking".into(),
            },
            &mut |_| {},
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |_| {},
        );
        assert_eq!(pump.tracker.terminal_text(), "checking");
        assert_eq!(
            pump.tracker.text_or_transient("eof"),
            Termination::Text("checking".into())
        );
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text("checking".into()));
        assert_eq!(rounds.len(), 1);
        assert_eq!(rounds[0].text.as_deref(), Some("checking"));
    }

    /// Consecutive commands with no prose between them form ONE batch: both
    /// calls land on the same round, one RoundText prelude fires, and no new
    /// round pointer appears mid-batch.
    #[test]
    fn consecutive_commands_share_one_round() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::AgentMessage {
                text: "let me query".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "explore SELECT 1".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_2".into(),
                command: "explore SELECT 2".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1, "one batch round");
        assert_eq!(rounds[0].calls.len(), 2, "both calls share the round");
        assert_eq!(rounds[0].text.as_deref(), Some("let me query"));
        assert_eq!(
            phases
                .iter()
                .filter(|p| matches!(p, TurnPhase::RoundText { .. }))
                .count(),
            1,
            "one prose prelude for the batch"
        );
        assert!(
            !phases
                .iter()
                .any(|p| matches!(p, TurnPhase::Thinking { attempt: 2 })),
            "no round pointer mid-batch"
        );
    }

    // --- pump fold: reasoning thinking fold (issue #807) ---------------------

    /// A reasoning item folds into the round's thinking via the existing
    /// prelude mechanism: the buffer holds it until the batch's first call
    /// freezes it as ThinkingCompleted, followed by the round's prose, then
    /// the batch's call events. Reasoning, prose, and the call batch share
    /// ONE round (issue #807's attribution ruling).
    #[test]
    fn reasoning_folds_into_round_thinking_pinned_zero() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::Reasoning {
                text: "planning the query".into(),
            },
            &mut |p| phases.push(p),
        );
        assert!(
            phases.is_empty(),
            "the reasoning buffers -- no phase fires until the prelude or turn end"
        );
        pump.fold(
            CodexEvent::AgentMessage {
                text: "let me query".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "explore SELECT 1".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        let rounds = settle(pump, &mut phases, &Termination::Text(String::new()));
        assert_eq!(
            rounds.len(),
            1,
            "reasoning, prose, and the call share one round"
        );
        let thinking = rounds[0].thinking.as_ref().expect("frozen thinking");
        assert_eq!(thinking.text, "planning the query");
        assert_eq!(thinking.duration_ms, 0, "no fabricated window");
        assert_eq!(rounds[0].text.as_deref(), Some("let me query"));
        assert_eq!(rounds[0].calls.len(), 1);
        // The prelude's ADR-0103 live order: ThinkingCompleted, then
        // RoundText, then the batch's ToolCallStarted.
        assert!(matches!(
            &phases[0],
            TurnPhase::ThinkingCompleted { duration_ms, text }
                if *duration_ms == 0 && text == "planning the query"
        ));
        assert!(matches!(
            &phases[1],
            TurnPhase::RoundText { text } if text == "let me query"
        ));
        assert!(matches!(&phases[2], TurnPhase::ToolCallStarted { .. }));
    }

    /// Reasoning landing AFTER the last call batch stays visible: the
    /// trailing round's thinking survives the turn-end freeze whether or
    /// not closing prose follows, and the freeze fires its live
    /// ThinkingCompleted (issue #807 acceptance criteria 2).
    #[test]
    fn reasoning_after_last_batch_survives_turn_end_freeze() {
        // Shape A: reasoning -> closing prose. The prose rides the terminal
        // text; the thinking stays on the round.
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::Reasoning {
                text: "wrapping up".into(),
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::AgentMessage {
                text: "the answer".into(),
            },
            &mut |p| phases.push(p),
        );
        let rounds = settle(pump, &mut phases, &Termination::Text("the answer".into()));
        assert_eq!(rounds.len(), 2);
        let thinking = rounds[1].thinking.as_ref().expect("trailing thinking");
        assert_eq!(thinking.text, "wrapping up");
        assert_eq!(thinking.duration_ms, 0);
        assert_eq!(
            rounds[1].text, None,
            "the closing prose rides the terminal text"
        );
        assert!(
            phases.iter().any(|p| matches!(p,
                TurnPhase::ThinkingCompleted { duration_ms: 0, text } if text == "wrapping up")),
            "the turn-end freeze fires its ThinkingCompleted"
        );

        // Shape B: reasoning-only trailing round -- no prose follows.
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |p| phases.push(p),
        );
        pump.fold(
            CodexEvent::Reasoning {
                text: "done thinking".into(),
            },
            &mut |p| phases.push(p),
        );
        let rounds = settle(pump, &mut phases, &Termination::Text(String::new()));
        assert_eq!(
            rounds.len(),
            2,
            "the reasoning-only trailing round is not popped"
        );
        let thinking = rounds[1].thinking.as_ref().expect("trailing thinking");
        assert_eq!(thinking.text, "done thinking");
        assert_eq!(rounds[1].text, None);
    }

    /// A wire that streams BOTH the item.started and item.completed
    /// reasoning envelopes folds the text once: the started variant parses
    /// to Other at the boundary (issue #807 acceptance criteria 6).
    #[test]
    fn reasoning_started_variant_never_doubles() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        pump.fold(
            fixture_event(
                r#"{"type":"item.started","item":{"id":"item_0","type":"reasoning","text":"thinking..."}}"#,
            ),
            &mut |p| phases.push(p),
        );
        pump.fold(fixture_event(MEASURED_TURN_NDJSON[2]), &mut |p| {
            phases.push(p)
        });
        let rounds = settle(pump, &mut phases, &Termination::Text(String::new()));
        let thinking = rounds[0].thinking.as_ref().expect("frozen thinking");
        assert_eq!(
            thinking.text, "thinking...",
            "the started variant contributes nothing"
        );
    }

    /// Two reasoning items landing in the same call-less stretch share
    /// the round and concatenate verbatim, separator-less -- the
    /// whole-block join convention the agent_message path and the
    /// yoagent fold also use. The wire's two-item-per-round shape is
    /// unmeasured (the capture carries one), so this pins today's
    /// behavior, not an observed shape.
    #[test]
    fn two_reasoning_items_in_one_round_concatenate_verbatim() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        for text in ["block one", "block two"] {
            pump.fold(CodexEvent::Reasoning { text: text.into() }, &mut |p| {
                phases.push(p)
            });
        }
        let rounds = settle(pump, &mut phases, &Termination::Text(String::new()));
        assert_eq!(rounds.len(), 1, "no call separates the two items");
        let thinking = rounds[0].thinking.as_ref().expect("frozen thinking");
        assert_eq!(thinking.text, "block oneblock two");
        assert_eq!(thinking.duration_ms, 0);
    }

    // --- pump fold: exit_code mapping (issue #804) ---------------------------

    /// A non-zero exit code lands a failed trace row whose failure anchor
    /// keeps the code (the cross-turn retrospection surface renders it).
    #[test]
    fn nonzero_exit_lands_failed_trace_row() {
        let mut pump = JsonPump::new(24);
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "item_7".into(),
                command: "false".into(),
                exit_code: Some(1),
            },
            &mut |_| {},
        );
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text(String::new()));
        let call = &rounds[0].calls[0];
        assert!(!call.success);
        assert_eq!(call.result_excerpt, "command exited with code 1");
    }

    /// An absent / null exit code is an unknown outcome -- it stays a
    /// succeeded row (the pre-#804 default-true behavior).
    #[test]
    fn unknown_exit_stays_succeeded() {
        let mut pump = JsonPump::new(24);
        pump.fold(
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls".into(),
                exit_code: None,
            },
            &mut |_| {},
        );
        let rounds = pump
            .tracker
            .settle_rounds(&Termination::Text(String::new()));
        assert!(rounds[0].calls[0].success);
    }

    // --- measured wire sequence, end to end (issue #804) ---------------------

    /// The measured turn drives the pump to a normal Text termination: the
    /// agent_message lands the terminal text, the command lands exactly one
    /// trace row (the streaming `item.started` variant never folds), the
    /// reasoning folds into the round's thinking (issue #807), and
    /// `turn.completed` settles the turn before any stdout-close fallback
    /// could fire (issue #804 acceptance criteria 1-4).
    #[test]
    fn measured_turn_sequence_settles_as_text() {
        let mut pump = JsonPump::new(24);
        let mut phases = Vec::new();
        let mut termination = None;
        for line in MEASURED_TURN_NDJSON {
            if let Some(term) = pump.fold(fixture_event(line), &mut |p| phases.push(p)) {
                termination = Some(term);
                break;
            }
        }
        assert_eq!(
            termination,
            Some(Termination::Text("the answer".into())),
            "turn.completed settles the turn; the stdout-close fallback never fires"
        );
        let rounds = settle(pump, &mut phases, &Termination::Text("the answer".into()));
        assert_eq!(rounds.len(), 1);
        assert_eq!(
            rounds[0].calls.len(),
            1,
            "the item.started streaming variant must not double the row"
        );
        let call = &rounds[0].calls[0];
        assert_eq!(call.tool_use_id, "item_1");
        assert_eq!(call.name, "<command>");
        assert!(call.success, "exit_code 0 lands a succeeded row");
        let thinking = rounds[0]
            .thinking
            .as_ref()
            .expect("measured reasoning folds");
        assert_eq!(thinking.text, "thinking...");
        assert_eq!(thinking.duration_ms, 0);
    }
}
