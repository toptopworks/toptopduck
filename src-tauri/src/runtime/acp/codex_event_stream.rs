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
//! codex event stream has no protocol-level pre-check. All tool calls route
//! through the gateway bridge MCP server, where the gateway enforces the
//! approval gate (ADR-0085/0094). Native codex tools (shell / file write) are
//! blocked by `--sandbox read-only` — no native tool event is expected.
//!
//! [`StreamFormat`]: super::adapter::StreamFormat
//! [`CodexEventStream`]: super::adapter::StreamFormat::CodexEventStream

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::approval::OperationKind;
use crate::cancel::CancelToken;
use crate::model::{TraceEntryView, TurnPhase};
use crate::runtime::acp::adapter::AdapterSpec;
use crate::runtime::acp::turn_io::{build_model_flags, flatten_prompt};
use crate::runtime::acp::wire::McpServer;
use crate::session::agent_loop::{
    truncate_trace_excerpt, LoopOutcome, Termination, TraceEntry, TRACE_EXCERPT_MAX,
};

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
    /// Agent text fragment — accumulated across the turn (`agent_message`
    /// or `item` with `subtype: agent_message`).
    AgentMessage { text: String },
    /// A tool / command was executed (`command_execution`).
    CommandExecution {
        /// Call id or command identifier (for trace row pairing).
        call_id: String,
        /// Human-readable command / tool name.
        command: String,
    },
    /// Any other event type (ignored by the engine).
    Other,
}

/// Parse one NDJSON line (already deserialized to [`Value`]) into a
/// [`CodexEvent`]. Defensive: unknown shapes, missing fields, or type
/// mismatches produce [`CodexEvent::Other`], never panic.
///
/// The parser handles both the combined-type pattern (`"type":
/// "turn_started"`) and the nested type+status pattern (`"type": "turn",
/// "status": "started"`) — the exact wire format is implementation-period
/// unresolved (ADR-0094 Consequences) and verified against a real CLI in E2E.
pub(crate) fn parse_event(value: &Value) -> CodexEvent {
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let status = value.get("status").and_then(|v| v.as_str()).unwrap_or("");

    // Combined type pattern: turn_started, turn_completed, etc.
    match event_type {
        "turn_started" => return CodexEvent::TurnStarted,
        "turn_completed" => return CodexEvent::TurnCompleted,
        "turn_failed" | "turn_aborted" => {
            return CodexEvent::TurnFailed {
                error: extract_error(value),
            }
        }
        "agent_message" => {
            return CodexEvent::AgentMessage {
                text: extract_message_text(value),
            }
        }
        "command_execution" => {
            return extract_command(value).unwrap_or(CodexEvent::Other);
        }
        _ => {}
    }

    // Nested type+status pattern: { "type": "turn", "status": "started" }
    if event_type == "turn" {
        return match status {
            "started" => CodexEvent::TurnStarted,
            "completed" => CodexEvent::TurnCompleted,
            "failed" | "aborted" => CodexEvent::TurnFailed {
                error: extract_error(value),
            },
            _ => CodexEvent::Other,
        };
    }

    // Item with subtype pattern: { "type": "item", "subtype": "agent_message",
    // "status": "completed" }
    if event_type == "item" {
        let subtype = value
            .get("subtype")
            .or_else(|| value.get("item_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return match (subtype, status) {
            ("agent_message", "completed") => CodexEvent::AgentMessage {
                text: extract_message_text(value),
            },
            ("command_execution", _) => extract_command(value).unwrap_or(CodexEvent::Other),
            _ => CodexEvent::Other,
        };
    }

    CodexEvent::Other
}

/// Extract the error message from a failed-turn event. Falls back through
/// common field names, then to a generic string.
fn extract_error(value: &Value) -> String {
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
        .unwrap_or_else(|| "turn failed (no error detail)".to_string())
}

/// Extract the assistant message text from an `agent_message` event. The codex
/// wire form carries content as an array of `{ "type": "output_text", "text":
/// "..." }` blocks (mirrors the OpenAI Responses API) or as a bare `message`
/// string; both are handled.
fn extract_message_text(value: &Value) -> String {
    // Bare `message` string form.
    if let Some(msg) = value.get("message").and_then(|v| v.as_str()) {
        return msg.to_string();
    }
    // Content-array form: collect all output_text blocks.
    if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
        let text: String = content
            .iter()
            .filter_map(|block| {
                block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .or_else(|| block.get("output_text").and_then(|t| t.as_str()))
            })
            .collect();
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

/// Extract a command execution event into its [`CodexEvent::CommandExecution`]
/// variant. The `command` field may be a string or an array of strings (argv
/// form); the call id may be under `call_id` or `id`.
fn extract_command(value: &Value) -> Option<CodexEvent> {
    let call_id = value
        .get("call_id")
        .or_else(|| value.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let command = value
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            value
                .get("command")
                .and_then(|v| v.as_array())
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
        })
        .or_else(|| {
            value
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })?;

    Some(CodexEvent::CommandExecution { call_id, command })
}

// ---------------------------------------------------------------------------
// Config override builder (pure)
// ---------------------------------------------------------------------------

/// Build the `-c key=value` argv segments that inject the gateway bridge MCP
/// server entry into codex's runtime config (ADR-0094 Decision 4). Each
/// `McpServer::Stdio` in `mcp_servers` becomes a set of `-c` overrides under
/// `mcp_servers.<name>`.
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
            flags.push(format!("mcp_servers.{name}.command={command}"));
            if !args.is_empty() {
                let joined = args
                    .iter()
                    .map(|a| format!("\"{a}\""))
                    .collect::<Vec<_>>()
                    .join(", ");
                flags.push("-c".to_string());
                flags.push(format!("mcp_servers.{name}.args=[{joined}]"));
            }
            for (k, v) in env {
                flags.push("-c".to_string());
                flags.push(format!("mcp_servers.{name}.env.{k}={v}"));
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
        let alive = guard.watchdog_alive();
        let token = Arc::clone(&cancel);
        thread::spawn(move || {
            thread::sleep(timeout);
            if alive.load(std::sync::atomic::Ordering::SeqCst) {
                token.request();
            }
        });
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
                0,
            )
        }
    };

    // Write the flattened prompt to stdin, then close stdin so codex begins
    // processing (exec reads the prompt from stdin when no positional arg is
    // given).
    {
        let mut stdin = child.stdin.take().expect("piped stdin");
        let prompt = flatten_prompt(&input.prompt_blocks);
        if let Err(e) = stdin.write_all(prompt.as_bytes()) {
            let result = outcome(
                Termination::Transient(format!("stdin write failed: {e}")),
                Vec::new(),
                0,
            );
            super::process::kill_and_reap(&mut child);
            return result;
        }
        if let Err(e) = stdin.write_all(b"\n") {
            let result = outcome(
                Termination::Transient(format!("stdin flush failed: {e}")),
                Vec::new(),
                0,
            );
            super::process::kill_and_reap(&mut child);
            return result;
        }
        // Drop stdin explicitly to signal EOF.
        drop(stdin);
    }

    let stdout = child.stdout.take().expect("piped stdout");

    // Reader thread: blocking read_line on its own thread so the pump can
    // check cancel / step-cap between reads (mirrors the ACP pattern).
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\n', '\r']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    if tx.send(trimmed.to_string()).is_err() {
                        break; // pump gone
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Signal Thinking once before the event pump (one exec invocation = one
    // turn = one thinking wait).
    on_phase(TurnPhase::Thinking { attempt: 1 });

    let mut pump = JsonPump {
        trace: Vec::new(),
        text: String::new(),
        tool_call_count: 0,
        step_cap,
    };

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
                match parse_event(&value) {
                    CodexEvent::TurnStarted => {
                        // Already signaled Thinking above; a redundant signal
                        // would confuse the UI. No-op.
                    }
                    CodexEvent::TurnCompleted => {
                        termination = Some(if pump.text.is_empty() {
                            Termination::Text(String::new())
                        } else {
                            Termination::Text(std::mem::take(&mut pump.text))
                        });
                        break;
                    }
                    CodexEvent::TurnFailed { error } => {
                        termination = Some(Termination::Transient(error));
                        break;
                    }
                    CodexEvent::AgentMessage { text } => {
                        pump.text.push_str(&text);
                    }
                    CodexEvent::CommandExecution { call_id, command } => {
                        pump.tool_call_count += 1;
                        // codex command_execution events carry no success/failure
                        // status (unlike ACP ToolCall); success defaults to true.
                        let entry = TraceEntry {
                            tool_use_id: call_id,
                            name: command.clone(),
                            operation_kind: OperationKind::Execute,
                            summary: truncate_trace_excerpt(&command, TRACE_EXCERPT_MAX),
                            success: true,
                            result_excerpt: String::new(),
                        };
                        on_phase(TurnPhase::ToolCallStarted {
                            name: entry.name.clone(),
                            operation_kind: entry.operation_kind,
                            summary: entry.summary.clone(),
                        });
                        on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
                        pump.trace.push(entry);
                    }
                    CodexEvent::Other => {}
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // stdout closed before a terminal event. If we already have
                // agent text, treat it as success (codex may close stdout
                // after the final message without an explicit turn.completed);
                // otherwise it is a transient failure.
                termination = Some(if !pump.text.is_empty() {
                    Termination::Text(std::mem::take(&mut pump.text))
                } else {
                    Termination::Transient("codex closed stdout without a terminal event".into())
                });
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
        // Treat accumulated text as the answer if any; otherwise transient.
        if !pump.text.is_empty() {
            Termination::Text(std::mem::take(&mut pump.text))
        } else {
            Termination::Transient("codex turn ended without a terminal event".into())
        }
    });

    outcome(term, pump.trace, 1)
}

/// Mutable state accumulated while pumping codex events.
struct JsonPump {
    trace: Vec<TraceEntry>,
    text: String,
    /// Count of command/tool executions observed (step-cap counter).
    tool_call_count: u32,
    step_cap: u32,
}

/// Build the [`LoopOutcome`] (same shape as the ACP engine's `outcome`).
fn outcome(termination: Termination, trace: Vec<TraceEntry>, round_trips: u32) -> LoopOutcome {
    LoopOutcome {
        termination,
        // Promotions are gateway-side (ADR-0085: the bridge -> gateway ->
        // tools::dispatch path); the JSON event stream engine owns only the
        // event-driving half.
        promotions: Vec::new(),
        trace,
        round_trips,
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

    #[test]
    fn parse_combined_turn_started() {
        let v: Value = serde_json::json!({"type": "turn_started"});
        assert_eq!(parse_event(&v), CodexEvent::TurnStarted);
    }

    #[test]
    fn parse_combined_turn_completed() {
        let v: Value = serde_json::json!({"type": "turn_completed"});
        assert_eq!(parse_event(&v), CodexEvent::TurnCompleted);
    }

    #[test]
    fn parse_combined_turn_failed_with_error_string() {
        let v: Value = serde_json::json!({"type": "turn_failed", "error": "rate limited"});
        assert_eq!(
            parse_event(&v),
            CodexEvent::TurnFailed {
                error: "rate limited".into()
            }
        );
    }

    #[test]
    fn parse_combined_turn_failed_with_error_object() {
        let v: Value =
            serde_json::json!({"type": "turn_failed", "error": {"message": "bad config"}});
        assert_eq!(
            parse_event(&v),
            CodexEvent::TurnFailed {
                error: "bad config".into()
            }
        );
    }

    #[test]
    fn parse_nested_turn_started() {
        let v: Value = serde_json::json!({"type": "turn", "status": "started"});
        assert_eq!(parse_event(&v), CodexEvent::TurnStarted);
    }

    #[test]
    fn parse_nested_turn_completed() {
        let v: Value = serde_json::json!({"type": "turn", "status": "completed"});
        assert_eq!(parse_event(&v), CodexEvent::TurnCompleted);
    }

    #[test]
    fn parse_nested_turn_failed() {
        let v: Value = serde_json::json!({"type": "turn", "status": "failed", "error": "oops"});
        assert_eq!(
            parse_event(&v),
            CodexEvent::TurnFailed {
                error: "oops".into()
            }
        );
    }

    #[test]
    fn parse_agent_message_bare_string() {
        let v: Value = serde_json::json!({"type": "agent_message", "message": "hello world"});
        assert_eq!(
            parse_event(&v),
            CodexEvent::AgentMessage {
                text: "hello world".into()
            }
        );
    }

    #[test]
    fn parse_agent_message_content_array() {
        let v: Value = serde_json::json!({
            "type": "agent_message",
            "content": [
                {"type": "output_text", "text": "part 1"},
                {"type": "output_text", "text": "part 2"}
            ]
        });
        assert_eq!(
            parse_event(&v),
            CodexEvent::AgentMessage {
                text: "part 1part 2".into()
            }
        );
    }

    #[test]
    fn parse_item_agent_message_completed() {
        let v: Value = serde_json::json!({
            "type": "item",
            "subtype": "agent_message",
            "status": "completed",
            "content": [{"type": "output_text", "text": "final answer"}]
        });
        assert_eq!(
            parse_event(&v),
            CodexEvent::AgentMessage {
                text: "final answer".into()
            }
        );
    }

    #[test]
    fn parse_command_execution_string_command() {
        let v: Value = serde_json::json!({
            "type": "command_execution",
            "call_id": "call_1",
            "command": "ls -la"
        });
        assert_eq!(
            parse_event(&v),
            CodexEvent::CommandExecution {
                call_id: "call_1".into(),
                command: "ls -la".into()
            }
        );
    }

    #[test]
    fn parse_command_execution_array_command() {
        let v: Value = serde_json::json!({
            "type": "command_execution",
            "call_id": "call_2",
            "command": ["grep", "-r", "pattern"]
        });
        assert_eq!(
            parse_event(&v),
            CodexEvent::CommandExecution {
                call_id: "call_2".into(),
                command: "grep -r pattern".into()
            }
        );
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
        assert!(flags
            .iter()
            .any(|f| f == "mcp_servers.toptopduck-gateway.command=/abs/path/to/bridge"));
        assert!(flags
            .iter()
            .any(|f| f == "mcp_servers.toptopduck-gateway.env.TOPTOPDUCK_GATEWAY_PORT=12345"));
        assert!(flags
            .iter()
            .any(|f| f == "mcp_servers.toptopduck-gateway.env.TOPTOPDUCK_GATEWAY_TOKEN=abc"));
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
    }

    #[test]
    fn config_overrides_empty_for_no_servers() {
        assert!(build_config_overrides(&[]).is_empty());
    }
}
