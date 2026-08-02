//! ACP fake CLI fixture (ADR-0081 test seam C, issue #299).
//!
//! A minimal binary that speaks the ACP v1 stdio JSON-RPC subset so the adapter
//! engine ([`toptopduck_lib::runtime::acp::engine`]) can be exercised end-to-end
//! in CI without the real claude-code install + login. Declared as a `[[bin]]`
//! in `Cargo.toml`; integration tests resolve its path via
//! `env!("CARGO_BIN_EXE_acp-fake-cli")` and pick the scripted behavior via the
//! `ACP_FAKE_SCENARIO` env var.
//!
//! Scenarios cover the engine's observable branches: a clean text reply, a
//! multi-step tool-call trajectory, a failed tool call, a stop_reason ceiling,
//! a cooperative cancel, a permission handshake, a runaway (step-cap trip), and
//! a mid-turn crash (EOF). Each plays out as a scripted stream of
//! `session/update` notifications + a final `session/prompt` response.
//!
//! Framing: newline-delimited JSON (NDJSON), one JSON-RPC message per line --
//! the same framing the engine + the real CLI agents use over stdio.

use std::io::{BufRead, BufReader, Write};

use toptopduck_lib::runtime::acp::wire::{
    self, ContentBlock, InitializeResult, NewSessionResult, Notification, PermissionOption,
    PermissionOptionKind, PermissionToolCall, PromptResult, RequestId, RequestPermissionOutcome,
    RequestPermissionParams, RequestPermissionResult, Response, RpcError, SessionUpdate,
    SessionUpdateParams, StopReason, ToolCallContent, ToolCallStatus, ToolKind,
};

fn main() {
    let scenario = std::env::var("ACP_FAKE_SCENARIO").unwrap_or_else(|_| "text_reply".into());
    let mut out = std::io::stdout();
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    // Tracks whether session/cancel was received (the cooperative-cancel
    // scenario waits on it before responding Cancelled).
    let mut cancel_seen = false;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let method = v.get("method").and_then(serde_json::Value::as_str);
        let id = v.get("id").cloned();
        match method {
            Some("initialize") => {
                respond(
                    &mut out,
                    &Response::<InitializeResult> {
                        jsonrpc: "2.0".into(),
                        id: parse_id(&id),
                        result: Some(InitializeResult {
                            protocol_version: wire::PROTOCOL_VERSION,
                            agent_info: Some(wire::Implementation {
                                name: "acp-fake-cli".into(),
                                version: "0.0.0".into(),
                                title: None,
                            }),
                        }),
                        error: None,
                    },
                );
            }
            Some("session/new") => {
                respond(
                    &mut out,
                    &Response::<NewSessionResult> {
                        jsonrpc: "2.0".into(),
                        id: parse_id(&id),
                        result: Some(NewSessionResult {
                            session_id: "fake-session".into(),
                        }),
                        error: None,
                    },
                );
            }
            Some("session/prompt") => {
                play_scenario(&scenario, &mut out, &id, &mut reader, &mut cancel_seen);
            }
            Some("session/cancel") => {
                // Notification (no id) -- record + acknowledge cooperatively.
                cancel_seen = true;
            }
            _ => {
                if id.is_some() {
                    respond(
                        &mut out,
                        &Response::<serde_json::Value> {
                            jsonrpc: "2.0".into(),
                            id: parse_id(&id),
                            result: None,
                            error: Some(RpcError {
                                code: -32601,
                                message: "method not found".into(),
                                data: None,
                            }),
                        },
                    );
                }
            }
        }
        let _ = out.flush();
    }
}

/// Play the scripted behavior for `session/prompt` and emit the final response.
fn play_scenario(
    scenario: &str,
    out: &mut std::io::Stdout,
    prompt_id: &Option<serde_json::Value>,
    reader: &mut BufReader<std::io::StdinLock<'_>>,
    cancel_seen: &mut bool,
) {
    let id = parse_id(prompt_id);
    match scenario {
        "text_reply" => {
            notify(out, agent_message("the answer is 42"));
            respond_prompt(out, &id, StopReason::Success);
        }
        "tool_calls" => {
            notify(
                out,
                tool_call_start("tc_1", "explore SELECT 1", ToolKind::Search),
            );
            notify(
                out,
                tool_call_finish("tc_1", "explore SELECT 1", ToolKind::Search, "rows: 3"),
            );
            notify(out, agent_message("found 3 rows"));
            respond_prompt(out, &id, StopReason::Success);
        }
        "tool_failure" => {
            notify(
                out,
                tool_call_start_failed("tc_1", "explore bad sql", ToolKind::Search, "syntax error"),
            );
            notify(out, agent_message("the query failed"));
            respond_prompt(out, &id, StopReason::Success);
        }
        "max_turns" => {
            respond_prompt(out, &id, StopReason::MaxTurns);
        }
        "refusal" => {
            notify(out, agent_message("I can't do that"));
            respond_prompt(out, &id, StopReason::Refusal);
        }
        "permission" => {
            // Ask the client for permission; the engine's policy decides.
            let req_id = RequestId::Num(100);
            request_permission(out, &req_id, "bash ls", ToolKind::Execute);
            // Read the client's response (drain until the matching id).
            drain_until_response(reader, &req_id, cancel_seen);
            notify(out, agent_message("done"));
            respond_prompt(out, &id, StopReason::Success);
        }
        "step_cap_overflow" => {
            // Emit more tool-call starts than the step cap; the engine trips
            // its own cap + cancels. 50 > the default 24.
            for i in 1..=50u32 {
                notify(
                    out,
                    tool_call_start(&format!("tc_{i}"), &format!("call {i}"), ToolKind::Search),
                );
            }
            notify(out, agent_message("ran many calls"));
            respond_prompt(out, &id, StopReason::Success);
        }
        "cancel" => {
            // Spin emitting progress until the client sends session/cancel,
            // then respond Cancelled (cooperative).
            loop {
                if *cancel_seen {
                    respond_prompt(out, &id, StopReason::Cancelled);
                    return;
                }
                notify(out, agent_message("working..."));
                // Drain any pending input (the session/cancel notification).
                if drain_once(reader, cancel_seen) {
                    continue;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        "crash" => {
            // Close stdout mid-turn (the engine sees reader EOF -> Eof path).
            notify(out, agent_message("about to crash"));
            let _ = out.flush();
            std::process::exit(0);
        }
        other => {
            // Unknown scenario: respond success with a marker so a mis-spelled
            // scenario name fails loudly rather than hanging.
            notify(out, agent_message(&format!("unknown scenario: {other}")));
            respond_prompt(out, &id, StopReason::Success);
        }
    }
}

// ---------------------------------------------------------------------------
// Notification builders
// ---------------------------------------------------------------------------

fn notify(out: &mut std::io::Stdout, update: SessionUpdate) {
    let n = Notification::new(
        "session/update",
        SessionUpdateParams {
            session_id: "fake-session".into(),
            update,
        },
    );
    write_line(out, &n);
}

fn agent_message(text: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk {
        message_id: Some("m1".into()),
        content: vec![ContentBlock::text(text)],
    }
}

fn tool_call_start(id: &str, title: &str, kind: ToolKind) -> SessionUpdate {
    SessionUpdate::ToolCall {
        tool_call_id: id.into(),
        title: Some(title.into()),
        status: ToolCallStatus::InProgress,
        kind: Some(kind),
        content: Vec::new(),
    }
}

fn tool_call_finish(id: &str, title: &str, _kind: ToolKind, output: &str) -> SessionUpdate {
    SessionUpdate::ToolCallUpdate {
        tool_call_id: id.into(),
        status: Some(ToolCallStatus::Completed),
        title: Some(title.into()),
        content: vec![ToolCallContent::Content {
            content: ContentBlock::text(output),
        }],
    }
}

fn tool_call_start_failed(id: &str, title: &str, kind: ToolKind, err: &str) -> SessionUpdate {
    // A tool call that arrives already Failed (the engine finalizes it).
    SessionUpdate::ToolCall {
        tool_call_id: id.into(),
        title: Some(title.into()),
        status: ToolCallStatus::Failed,
        kind: Some(kind),
        content: vec![ToolCallContent::Content {
            content: ContentBlock::text(err),
        }],
    }
}

fn request_permission(out: &mut std::io::Stdout, req_id: &RequestId, title: &str, kind: ToolKind) {
    let req = wire::Request::new(
        req_id.clone(),
        "session/request_permission",
        RequestPermissionParams {
            session_id: "fake-session".into(),
            tool_call: PermissionToolCall {
                tool_call_id: "perm_1".into(),
                title: Some(title.into()),
                kind: Some(kind),
            },
            options: vec![
                PermissionOption {
                    id: "allow_once".into(),
                    label: "Allow once".into(),
                    kind: Some(PermissionOptionKind::AllowOnce),
                },
                PermissionOption {
                    id: "reject_once".into(),
                    label: "Reject".into(),
                    kind: Some(PermissionOptionKind::RejectOnce),
                },
            ],
        },
    );
    write_line(out, &req);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

fn respond<W: Write>(out: &mut W, resp: &Response<impl serde::Serialize>) {
    write_line(out, resp);
}

fn respond_prompt(out: &mut std::io::Stdout, id: &RequestId, stop: StopReason) {
    respond(
        out,
        &Response::<PromptResult> {
            jsonrpc: "2.0".into(),
            id: id.clone(),
            result: Some(PromptResult { stop_reason: stop }),
            error: None,
        },
    );
}

fn write_line<W: Write, T: serde::Serialize>(out: &mut W, msg: &T) {
    if let Ok(s) = serde_json::to_string(msg) {
        let _ = writeln!(out, "{s}");
        let _ = out.flush();
    }
}

fn parse_id(v: &Option<serde_json::Value>) -> RequestId {
    match v {
        Some(serde_json::Value::Number(n)) => {
            n.as_u64().map(RequestId::Num).unwrap_or(RequestId::Null)
        }
        Some(serde_json::Value::String(s)) => RequestId::Str(s.clone()),
        _ => RequestId::Null,
    }
}

/// Block reading lines until a response matching `req_id` arrives (the
/// permission scenario's wait for the client's decision). Sets `cancel_seen`
/// if a session/cancel notification passes through.
fn drain_until_response(
    reader: &mut BufReader<std::io::StdinLock<'_>>,
    req_id: &RequestId,
    cancel_seen: &mut bool,
) {
    let target = serde_json::to_value(req_id).unwrap_or(serde_json::Value::Null);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let v: serde_json::Value = match serde_json::from_str(line.trim_end()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if v.get("method").and_then(|m| m.as_str()) == Some("session/cancel") {
            *cancel_seen = true;
        }
        if v.get("id") == Some(&target) && v.get("method").is_none() {
            return;
        }
    }
}

/// A single-line probe used by the cancel scenario to notice a `session/cancel`
/// notification between progress emissions. Returns true if a line was read.
/// Sets `cancel_seen` on the notification.
fn drain_once(reader: &mut BufReader<std::io::StdinLock<'_>>, cancel_seen: &mut bool) -> bool {
    let mut line = String::new();
    // Cooperative contract: the engine sends session/cancel promptly once the
    // pump decides to cancel; the 20ms sleep between probes (in the caller)
    // bounds CPU while waiting for that line.
    let n = reader.read_line(&mut line).unwrap_or(0);
    if n == 0 {
        return false;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim_end()) {
        if v.get("method").and_then(|m| m.as_str()) == Some("session/cancel") {
            *cancel_seen = true;
        }
    }
    // Touch the otherwise-unused permission-result type so the import stays
    // meaningful (a future scenario may echo the decision back).
    let _ = RequestPermissionResult {
        outcome: RequestPermissionOutcome::Cancelled,
    };
    true
}
