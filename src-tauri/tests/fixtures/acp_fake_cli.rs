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
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;

use toptopduck_lib::runtime::acp::wire::{
    self, ContentBlock, InitializeResult, NewSessionResult, Notification, PermissionOption,
    PermissionOptionKind, PermissionToolCall, PromptResult, RequestId, RequestPermissionOutcome,
    RequestPermissionParams, RequestPermissionResult, Response, RpcError, SessionUpdate,
    SessionUpdateParams, StopReason, ToolCallContent, ToolCallStatus, ToolKind,
};

/// Tool-call starts emitted by the `step_cap_overflow` scenario. Must exceed
/// any caller's step cap (the integration tests pass `cap=5`) so the engine's
/// `tool_call_count` crosses the cap and fires `session/cancel`; any fewer and
/// the scenario would block on `drain_once` waiting for a cancel that never
/// arrives.
const OVERFLOW_COUNT: u32 = 50;

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
                // When the descriptor names a real bridge binary (the
                // gateway_tool_call scenario), spawn it now so it connects
                // back to the gateway before session/prompt fires MCP at it.
                // A placeholder path (no descriptor / missing file) is skipped
                // so the no-bridge scenarios keep working unchanged.
                if let Some(server) = v
                    .get("params")
                    .and_then(|p| p.get("mcpServers"))
                    .and_then(|s| s.as_array())
                    .and_then(|a| a.first())
                {
                    try_spawn_bridge(server);
                }
                respond(
                    &mut out,
                    &Response::<NewSessionResult> {
                        jsonrpc: "2.0".into(),
                        id: parse_id(&id),
                        result: Some(NewSessionResult {
                            session_id: "fake-session".into(),
                            // ADR-0095 (AC: fake fixture returns
                            // config_options): the real SessionConfigOption
                            // wire shape (id / category / currentValue /
                            // options[], camelCase -- schema crate 0.13.8)
                            // with one model entry (two offered, one current)
                            // + one thought_level entry (three offered, one
                            // current) drives the engine's discovery path in
                            // CI.
                            config_options: Some(serde_json::json!([
                                {
                                    "id": "model",
                                    "name": "Model",
                                    "category": "model",
                                    "currentValue": "fake-opus",
                                    "options": [
                                        { "value": "fake-opus", "name": "Opus" },
                                        { "value": "fake-sonnet", "name": "Sonnet" },
                                    ],
                                },
                                {
                                    "id": "thought",
                                    "name": "Thinking",
                                    "category": "thought_level",
                                    "currentValue": "medium",
                                    "options": [
                                        { "value": "low", "name": "Low" },
                                        { "value": "medium", "name": "Medium" },
                                        { "value": "high", "name": "High" },
                                    ],
                                },
                            ])),
                        }),
                        error: None,
                    },
                );
            }
            Some("session/prompt") => {
                play_scenario(&scenario, &mut out, &id, &mut reader, &mut cancel_seen);
            }
            Some("session/set_config_option") => {
                // ADR-0095: acknowledge the model / thought-level injection.
                // The received (configId, value) traces to stderr for the
                // integration test's assertion (stdout is the engine's).
                let config_id = v
                    .get("params")
                    .and_then(|p| p.get("configId"))
                    .and_then(|o| o.as_str())
                    .unwrap_or("");
                let value = v
                    .get("params")
                    .and_then(|p| p.get("value"))
                    .and_then(|o| o.as_str())
                    .unwrap_or("");
                eprintln!("ACP_FAKE_RECEIVED_SETOPTION={config_id}={value}");
                respond(
                    &mut out,
                    &Response::<serde_json::Value> {
                        jsonrpc: "2.0".into(),
                        id: parse_id(&id),
                        result: Some(serde_json::json!({})),
                        error: None,
                    },
                );
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
            // Emit more tool-call starts than the step cap, THEN drain for
            // session/cancel. Emitting + draining interleaved deadlocks:
            // drain_once blocks on read_line before the engine has anything
            // to send (the cap is only tripped after enough starts cross the
            // wire), so the turn would only ever resolve via the wall-clock
            // watchdog, not the step-cap path this scenario exists to
            // exercise. Emitting all starts up front lets the engine's
            // tool_call_count cross the cap and fire cancel promptly; the
            // drain then finds it in milliseconds.
            for i in 1..=OVERFLOW_COUNT {
                notify(
                    out,
                    tool_call_start(&format!("tc_{i}"), &format!("call {i}"), ToolKind::Search),
                );
            }
            // Drain until session/cancel arrives (the engine sends it as soon
            // as tool_call_count exceeds the step cap), then cooperate.
            // Blocking is safe here -- the engine is guaranteed to send
            // cancel once the cap is exceeded; an EOF before cancel stops
            // producing so the scenario terminates deterministically.
            while !*cancel_seen {
                if !drain_once(reader, cancel_seen) {
                    break;
                }
            }
            if *cancel_seen {
                respond_prompt(out, &id, StopReason::Cancelled);
                return;
            }
            notify(out, agent_message("ran many calls"));
            respond_prompt(out, &id, StopReason::Success);
        }
        "stuck" => {
            // Never produce a prompt response; wait for the engine's wall-clock
            // watchdog to fire the shared token, the pump to send session/cancel,
            // then cooperate (respond Cancelled). Exercises the watchdog path no
            // other scenario reaches.
            loop {
                if *cancel_seen {
                    respond_prompt(out, &id, StopReason::Cancelled);
                    return;
                }
                if drain_once(reader, cancel_seen) {
                    continue;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        "prompt_error" => {
            // The agent returns a JSON-RPC error for session/prompt (no result).
            // The engine maps it to a Transient carrying this message, NOT
            // "closed stdout" (the diagnostic-misdirection regression fixed
            // alongside this fixture).
            respond(
                out,
                &Response::<serde_json::Value> {
                    jsonrpc: "2.0".into(),
                    id: id.clone(),
                    result: None,
                    error: Some(RpcError {
                        code: -32603,
                        message: "agent internal error".into(),
                        data: None,
                    }),
                },
            );
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
        "gateway_tool_call" => {
            // Drive one tools/call through the spawned bridge -> the app's
            // gateway -> tools::dispatch, then report it via session/update so
            // the engine pump folds the call into the ACP trace. Exercises the
            // full wiring: the bridge connects back, the gateway serves the
            // MCP subset, and the dispatch lands in the gateway's trace (the
            // turn assembler merges it -- de-duplicated against this pump's own
            // tool_call notification, which carries the same builtin name).
            bridge_write(&mcp_request(
                1,
                "initialize",
                serde_json::json!({"protocolVersion":"2024-11-05","clientInfo":{"name":"acp-fake-cli","version":"0.0.0"}}),
            ));
            let _ = bridge_read();
            bridge_write(&mcp_request(
                2,
                "tools/call",
                serde_json::json!({"name":"explore","arguments":{"sql":"SELECT 1 AS x"}}),
            ));
            let _ = bridge_read();
            notify(out, tool_call_start("gw_1", "explore", ToolKind::Search));
            notify(
                out,
                tool_call_finish("gw_1", "explore", ToolKind::Search, "rows: 1"),
            );
            notify(out, agent_message("done via gateway"));
            respond_prompt(out, &id, StopReason::Success);
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

// ---------------------------------------------------------------------------
// Bridge spawn + MCP client helpers (ADR-0085 wiring)
// ---------------------------------------------------------------------------

/// The spawned bridge child's stdio, stashed at `session/new` and read by the
/// `gateway_tool_call` scenario. The child handle is dropped after taking its
/// stdio: the bridge self-terminates on stdin EOF when this process exits, so
/// the handle is not needed for cleanup. The `Mutex` keeps the `static` `Sync`
/// without unsafe; the fake CLI is single-threaded, so there is never
/// contention.
struct BridgeProc {
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

static BRIDGE: Mutex<Option<BridgeProc>> = Mutex::new(None);

/// Spawn the bridge binary named in the `session/new` descriptor (when it is a
/// real path) and stash its stdio for the `gateway_tool_call` scenario. A
/// missing / empty / non-existent command is a no-op so the placeholder
/// descriptor and the no-bridge scenarios keep working unchanged.
fn try_spawn_bridge(server: &serde_json::Value) {
    let command = server
        .get("command")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if command.is_empty() || !std::path::Path::new(command).exists() {
        return;
    }
    let mut cmd = Command::new(command);
    if let Some(env) = server.get("env").and_then(serde_json::Value::as_object) {
        for (k, v) in env {
            if let Some(v) = v.as_str() {
                cmd.env(k, v);
            }
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let Ok(mut child) = cmd.spawn() else {
        return;
    };
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    *BRIDGE.lock().unwrap() = Some(BridgeProc {
        stdin,
        stdout: BufReader::new(stdout),
    });
}

/// Write one MCP request through the bridge as a single NDJSON line. A no-op
/// when no bridge was spawned (the scenario stays linear -- it does not branch
/// on every call).
fn bridge_write(msg: &serde_json::Value) {
    let mut guard = BRIDGE.lock().unwrap();
    let Some(b) = guard.as_mut() else {
        return;
    };
    if let Ok(s) = serde_json::to_string(msg) {
        let _ = writeln!(b.stdin, "{s}");
        let _ = b.stdin.flush();
    }
}

/// Read one NDJSON line back from the bridge. `None` on EOF, parse failure, or
/// no bridge -- the scenario treats a missing response as "the gateway did not
/// serve" and proceeds; the integration test asserts on the observable trace,
/// not on this helper's return.
fn bridge_read() -> Option<serde_json::Value> {
    let mut guard = BRIDGE.lock().unwrap();
    let b = guard.as_mut()?;
    let mut line = String::new();
    if b.stdout.read_line(&mut line).unwrap_or(0) == 0 {
        return None;
    }
    serde_json::from_str(line.trim_end()).ok()
}

/// Build a JSON-RPC 2.0 request envelope for the bridge MCP channel.
fn mcp_request(id: u64, method: &str, params: serde_json::Value) -> serde_json::Value {
    serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}
