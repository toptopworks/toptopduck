//! ACP fake CLI fixture (ADR-0081 test seam C, issue #299).
//!
//! A minimal binary that speaks the ACP v1 stdio JSON-RPC subset so the adapter
//! engine ([`toptopduck_lib::runtime::acp::engine`]) can be exercised end-to-end
//! in CI without the real gemini-cli install + login. Declared as a `[[bin]]`
//! in `Cargo.toml`; integration tests resolve its path via
//! `env!("CARGO_BIN_EXE_acp-fake-cli")` and pick the scripted behavior via the
//! `ACP_FAKE_SCENARIO` env var.
//!
//! Scenarios cover the engine's observable branches: a clean text reply, a
//! prompt echo (the received blocks made observable to the test), a
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
use std::thread;

use toptopduck_lib::runtime::acp::wire::{
    self, ContentBlock, InitializeResult, NewSessionResult, Notification, PermissionOption,
    PermissionOptionKind, PermissionToolCall, PromptResult, RequestId, RequestPermissionParams,
    Response, RpcError, SessionUpdate, SessionUpdateParams, StopReason, ToolCallContent,
    ToolCallStatus, ToolKind,
};

/// Tool-call starts emitted by the `step_cap_overflow` scenario. Must exceed
/// any caller's step cap (the integration tests pass `cap=5`) so the engine's
/// `tool_call_count` crosses the cap and fires `session/cancel`; any fewer and
/// the scenario would block on `drain_once` waiting for a cancel that never
/// arrives.
const OVERFLOW_COUNT: u32 = 50;

/// Append one trace line to the file named by `ACP_FAKE_TRACE_FILE` (when
/// set). The integration test passes a temp file so it can assert on what the
/// CLI received (stdout belongs to the engine's protocol channel; stderr
/// inherits to the CI console where no test can read it). A no-op when the
/// var is absent, so ad-hoc manual runs keep working.
fn trace_line(line: &str) {
    let Some(path) = std::env::var_os("ACP_FAKE_TRACE_FILE") else {
        return;
    };
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Heartbeat interval for the `handshake_silent` scenario (issue #534): the
/// diagnostic-probe cleanup test polls the trace file and asserts the beats
/// stop after the probe kills this process.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Append a heartbeat line to the `ACP_FAKE_TRACE_FILE` every
/// [`HEARTBEAT_INTERVAL`] until the process dies. The diagnostic probe (ADR
/// 0096) proves it reaps its child by asserting these beats stop; a plain
/// trace-on-write would not show liveness.
fn spawn_heartbeat() {
    thread::spawn(|| loop {
        trace_line("heartbeat");
        thread::sleep(HEARTBEAT_INTERVAL);
    });
}

fn main() {
    let scenario = std::env::var("ACP_FAKE_SCENARIO").unwrap_or_else(|_| "text_reply".into());
    // The silent-handshake scenario must still be observably alive (its
    // whole point is to hang past the probe's wall-clock timeout).
    if scenario == "handshake_silent" {
        spawn_heartbeat();
    }
    let mut out = std::io::stdout();
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    // Tracks whether session/cancel was received (the cooperative-cancel
    // scenario waits on it before responding Cancelled).
    let mut cancel_seen = false;
    // `handshake_crash` exits on the request AFTER initialize (see the
    // branch below).
    let mut crash_on_next = false;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => break,
        }
        // Exit WITHOUT answering the pending request: the caller's write has
        // landed (no EPIPE race with an early exit) and its read hits stdout
        // EOF deterministically -- what the crash tests pin.
        if crash_on_next {
            std::process::exit(0);
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
            // `handshake_silent` (issue #534): swallow initialize without
            // answering and keep the process alive -- the diagnostic probe's
            // wall-clock timeout is the only way out.
            Some("initialize") if scenario == "handshake_silent" => {}
            // `handshake_error` (issue #534): answer initialize with a
            // JSON-RPC error -- the diagnostic probe must surface a
            // HandshakeFailure naming the step, not a timeout. Also prints a
            // stderr diagnosis first (issue #542): the probe's failure detail
            // must carry the CLI's own words.
            Some("initialize") if scenario == "handshake_error" => {
                eprintln!("acp-fake-cli: auth required: complete the CLI's login flow");
                respond(
                    &mut out,
                    &Response::<InitializeResult> {
                        jsonrpc: "2.0".into(),
                        id: parse_id(&id),
                        result: None,
                        error: Some(RpcError {
                            code: -32000,
                            message: "not logged in".into(),
                            data: None,
                        }),
                    },
                );
            }
            // `handshake_crash` (issue #534): acknowledge initialize, then
            // exit on the NEXT request without answering it -- the caller's
            // next write lands and its read hits stdout EOF (never a hang),
            // deterministically (no write-EPIPE race with an early exit).
            // Prints a stderr panic first (issue #542): the EOF detail
            // carries the tail.
            Some("initialize") if scenario == "handshake_crash" => {
                eprintln!("acp-fake-cli: panicked at 'node runtime too old'");
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
                let _ = out.flush();
                crash_on_next = true;
            }
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
                // `chatty_handshake` (issue #540): two stray lines ahead of
                // the response -- a notification (carries a method field) and
                // a response with an unrelated id. The round-trip must drop
                // both (not an error) and still complete the handshake.
                if scenario == "chatty_handshake" {
                    write_line(
                        &mut out,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": "session/update",
                            "params": {},
                        }),
                    );
                    write_line(
                        &mut out,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 999,
                            "result": {},
                        }),
                    );
                }
                // `session_new_malformed` (issue #540): a response with the
                // right id but a result of the wrong type -- the round-trip
                // surfaces the parse failure, never a hang. Early-continue
                // so the normal response block below stays untouched.
                if scenario == "session_new_malformed" {
                    write_line(
                        &mut out,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": "not-a-session",
                        }),
                    );
                    continue;
                }
                // `session_new_raw` (issue #630): the session/new response as
                // a raw schema-shaped line -- `sessionId` + `modes` + `_meta`
                // alongside `configOptions`, the full NewSessionResponse field
                // set the crate named by `wire::MODELED_SCHEMA` defines. The
                // typed respond below serializes OUR NewSessionResult (self
                // consistency only); this line pins the handshake against the
                // real-agent shape (an unknown/extra field must parse).
                if scenario == "session_new_raw" {
                    write_line(
                        &mut out,
                        &serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "sessionId": "fake-session",
                                "modes": {
                                    "currentModeId": "default",
                                    "availableModes": [{"id": "default", "name": "Default"}],
                                },
                                "configOptions": fake_config_options(),
                                "_meta": {"source": "raw-schema-fixture"},
                            },
                        }),
                    );
                    continue;
                }
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
                            // config_options): the shape comes from
                            // `fake_config_options` (shared with the raw
                            // schema-shaped scenario).
                            config_options: Some(fake_config_options()),
                        }),
                        error: None,
                    },
                );
            }
            Some("session/prompt") => {
                play_scenario(&scenario, &mut out, &id, &v, &mut reader, &mut cancel_seen);
            }
            Some("session/set_config_option") => {
                // ADR-0095: acknowledge the model / thought-level injection.
                // The received (configId, value) traces to the file named by
                // `ACP_FAKE_TRACE_FILE` (set by the integration test; stdout
                // is the engine's, stderr goes to the CI console where a test
                // cannot assert on it). Only the ids the catalog above
                // declared are accepted -- a hardcoded id that does not match
                // the fixture's agent-chosen ids is an RPC error, not an ack
                // (the engine keys injection on the catalog entry's id, D4;
                // this makes the mapping a tested contract instead of a
                // masked mismatch).
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
                trace_line(&format!("ACP_FAKE_RECEIVED_SETOPTION={config_id}={value}"));
                let (ack, error) = if scenario == "set_config_option_reject" {
                    (
                        None,
                        Some(RpcError {
                            code: -32602,
                            message: format!("invalid params: unknown config id `{config_id}`"),
                            data: None,
                        }),
                    )
                } else {
                    match config_id {
                        "model" | "thought" => (Some(serde_json::json!({})), None),
                        other => (
                            None,
                            Some(RpcError {
                                code: -32602,
                                message: format!("invalid params: unknown config id `{other}`"),
                                data: None,
                            }),
                        ),
                    }
                };
                respond(
                    &mut out,
                    &Response::<serde_json::Value> {
                        jsonrpc: "2.0".into(),
                        id: parse_id(&id),
                        result: ack,
                        error,
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
/// `req` is the raw `session/prompt` request value -- only the echo scenario
/// reads it (the others are blind to the received prompt).
fn play_scenario(
    scenario: &str,
    out: &mut std::io::Stdout,
    prompt_id: &Option<serde_json::Value>,
    req: &serde_json::Value,
    reader: &mut BufReader<std::io::StdinLock<'_>>,
    cancel_seen: &mut bool,
) {
    let id = parse_id(prompt_id);
    match scenario {
        "text_reply" => {
            notify(out, agent_message("the answer is 42"));
            respond_prompt(out, &id, StopReason::Success);
        }
        // Issue #702 (PR #709 review): echo every text block the engine sent
        // in the `session/prompt` params back as one agent message,
        // block-separated. Stdout is the engine's protocol channel, so the
        // echo is the only way the received blocks become observable -- the
        // ACP counterpart of the built-in face's provider-side prompt capture.
        // The integration test asserts on the disclosure mix the CLI received
        // (index entries + activated bodies, not full-text mounts).
        "prompt_echo" => {
            let mut echoed = String::new();
            if let Some(blocks) = req
                .get("params")
                .and_then(|p| p.get("blocks"))
                .and_then(|b| b.as_array())
            {
                for block in blocks {
                    let text = block
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or_default();
                    if !echoed.is_empty() {
                        echoed.push_str("\n----\n");
                    }
                    echoed.push_str(text);
                }
            }
            notify(out, agent_message(&echoed));
            respond_prompt(out, &id, StopReason::Success);
        }
        "tool_calls" => {
            notify_tool_call_roundtrip(
                out,
                "tc_1",
                "explore SELECT 1",
                ToolKind::Search,
                "rows: 3",
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
        // Issue #611: thought + prose chunks ahead of each tool-call batch,
        // a terminal prose stretch after the last batch. Drives the per-round
        // grouping (round boundary = the tool-call batch split), the
        // ThinkingCompleted / RoundText live events, and the terminal-text
        // rule (the trailing stretch, not the concatenation of every chunk).
        "round_prose_thinking" => {
            notify(out, agent_thought("weighing schema options"));
            notify(out, agent_message("checking the data first"));
            notify_tool_call_roundtrip(
                out,
                "tc_1",
                "explore SELECT 1",
                ToolKind::Search,
                "rows: 3",
            );
            notify(out, agent_thought("narrowing the filter"));
            notify(out, agent_message("refining the query"));
            notify_tool_call_roundtrip(
                out,
                "tc_2",
                "explore SELECT 2",
                ToolKind::Search,
                "rows: 1",
            );
            notify(out, agent_message("both rounds folded"));
            respond_prompt(out, &id, StopReason::Success);
        }
        // Issue #611: raw JSON lines in the schema-crate wire shape named by
        // `wire::MODELED_SCHEMA` (the `sessionUpdate` discriminator + ONE
        // content block per chunk) --
        // pins the parse path against the real-agent form, independent of the
        // typed helpers above (which serialize our own types).
        "real_wire_chunks" => {
            raw_session_update(out, "agent_thought_chunk", "real thought");
            raw_session_update(out, "agent_message_chunk", "real prose");
            notify_tool_call_roundtrip(
                out,
                "rw_1",
                "explore SELECT 9",
                ToolKind::Search,
                "rows: 9",
            );
            raw_session_update(out, "agent_message_chunk", "real terminal");
            respond_prompt(out, &id, StopReason::Success);
        }
        // Issue #611: prose alongside the batch, then Success with no trailing
        // message stretch -- the terminal text falls back to the accumulated
        // prose (the fallback semantics this slice must preserve).
        "midturn_prose_no_terminal" => {
            notify(out, agent_message("checking alongside"));
            notify_tool_call_roundtrip(
                out,
                "tc_1",
                "explore SELECT 1",
                ToolKind::Search,
                "rows: 3",
            );
            respond_prompt(out, &id, StopReason::Success);
        }
        // A schema-legal `kind: "read"` tool_call on the raw wire (the typed
        // helpers never emit it) -- the line must parse and the call must
        // land in the trace instead of being dropped whole.
        "tool_kind_read" => {
            raw_tool_call_start(out, "tc_r", "read the schema", "read");
            notify(out, tool_call_finish("tc_r", "read the schema", "42 lines"));
            notify(out, agent_message("read it"));
            respond_prompt(out, &id, StopReason::Success);
        }
        // A pending call whose completion arrives AFTER the next round
        // opened -- the row must land on the round that opened it, not
        // whichever round is current when the finish arrives.
        "pending_across_round" => {
            notify(
                out,
                tool_call_start("tc_1", "explore SELECT 1", ToolKind::Search),
            );
            notify(out, agent_thought("the finish is still in flight"));
            notify(out, agent_message("round two prose"));
            notify(out, tool_call_finish("tc_1", "explore SELECT 1", "rows: 3"));
            respond_prompt(out, &id, StopReason::Success);
        }
        // A call left unresolved when the turn ends -- the drain lands it on
        // its opening round as a completed row.
        "pending_turn_end_drain" => {
            notify(out, agent_message("round one prose"));
            notify(
                out,
                tool_call_start("tc_1", "explore SELECT 1", ToolKind::Search),
            );
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
        // Issue #640: a runaway agent -- a flood of update lines the pump
        // cannot fold to completion before the engine's cancel arrives. The
        // bounded reader channel (capacity 8) backpressures the flood at the
        // source; the turn must still resolve through the cancel (cooperative
        // Cancelled) with the pre-cancel lines folded. The flood loop never
        // reads stdin, so an early session/cancel simply waits in the pipe
        // until the drain below finds it -- no write-side deadlock either way.
        "runaway" => {
            const RUNAWAY_LINES: u32 = 50_000;
            for i in 0..RUNAWAY_LINES {
                notify(out, agent_message(&format!("runaway line {i}")));
            }
            // This loop never produces a Success on its own: like the stuck
            // scenario, only the engine's cancel ends it.
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
        // Issue #629: after session/cancel, the pump stops folding content
        // updates. Stream prose until the cancel notification arrives, then
        // emit a post-cancel marker (which must NOT reach the trace) and
        // respond Cancelled (cooperative).
        "cancel_ignore_updates" => loop {
            if *cancel_seen {
                notify(out, agent_message("after-cancel"));
                respond_prompt(out, &id, StopReason::Cancelled);
                return;
            }
            notify(out, agent_message("before-cancel"));
            if drain_once(reader, cancel_seen) {
                continue;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        },
        // Issue #629: stream more prose than the engine's accumulation cap;
        // the turn still completes normally and the answer carries the
        // visible truncation marker. Three 3-MiB chunks clear the 8-MiB cap
        // while each line stays under the 4-MiB line cap (JSON envelope
        // included).
        "accum_cap" => {
            let chunk = "x".repeat(3 * 1024 * 1024);
            for _ in 0..3 {
                notify(out, agent_message(&chunk));
            }
            respond_prompt(out, &id, StopReason::Success);
        }
        // Issue #629 review: a line past the 4-MiB line cap is dropped and
        // the connection stays up -- the prose on the NEXT line still
        // arrives. The first line is raw non-JSON garbage (it is dropped
        // before any parse, so no envelope is needed).
        "line_cap_overlong" => {
            let _ = writeln!(out, "{}", "g".repeat(5 * 1024 * 1024));
            notify(out, agent_message("still alive"));
            respond_prompt(out, &id, StopReason::Success);
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
            notify(out, tool_call_finish("gw_1", "explore", "rows: 1"));
            notify(out, agent_message("done via gateway"));
            respond_prompt(out, &id, StopReason::Success);
        }
        // Issue #673 (ADR-0108 Decision 6): a registered CLI tool must be
        // advertised on the bridge's `tools/list` (single tool plane) and a
        // bridge-originated `tools/call` must route through the gateway into
        // the same spawn engine + approval gate a built-in-initiated call
        // uses. The registration name is fixed by the wiring test
        // ("cli-fixture-echo"); asserting the advertisement HERE makes a
        // split plane fail loudly at the source rather than as a confusing
        // downstream "unknown tool".
        "cli_gateway_tool_call" => {
            bridge_write(&mcp_request(
                1,
                "initialize",
                serde_json::json!({"protocolVersion":"2024-11-05","clientInfo":{"name":"acp-fake-cli","version":"0.0.0"}}),
            ));
            let _ = bridge_read();
            bridge_write(&mcp_request(2, "tools/list", serde_json::json!({})));
            let listed = bridge_read().expect("tools/list response");
            let names: Vec<&str> = listed["result"]["tools"]
                .as_array()
                .expect("tools array")
                .iter()
                .map(|t| t["name"].as_str().expect("named entry"))
                .collect();
            assert!(
                names.contains(&"cli-fixture-echo"),
                "the registered CLI tool must be advertised on the bridge surface: {names:?}"
            );
            bridge_write(&mcp_request(
                3,
                "tools/call",
                serde_json::json!({
                    "name": "cli-fixture-echo",
                    "arguments": {"args": ["hello", "from", "bridge"]}
                }),
            ));
            let called = bridge_read().expect("tools/call response");
            assert_eq!(
                called["result"]["isError"],
                serde_json::json!(false),
                "the CLI call succeeds through the gateway: {called}"
            );
            assert!(
                called["result"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("hello"),
                "the child's stdout rides the tool result: {called}"
            );
            notify(
                out,
                tool_call_start("gw_cli_1", "cli-fixture-echo", ToolKind::Execute),
            );
            notify(
                out,
                tool_call_finish("gw_cli_1", "cli-fixture-echo", "echoed"),
            );
            notify(out, agent_message("done via cli gateway"));
            respond_prompt(out, &id, StopReason::Success);
        }
        // Issue #646: same chain as gateway_tool_call, but the tools/call
        // frame exceeds the gateway's per-line byte cap. The gateway fails the
        // read and tears the connection down -- no id=2 response ever exists
        // -- so the session's turn lands on the serve-error path (a failed
        // outcome naming the framing cause), not a Cancelled hang.
        "gateway_overlong_call" => {
            bridge_write(&mcp_request(
                1,
                "initialize",
                serde_json::json!({"protocolVersion":"2024-11-05","clientInfo":{"name":"acp-fake-cli","version":"0.0.0"}}),
            ));
            let _ = bridge_read();
            // 5 MiB with margin over the 4 MiB cap: the cap is pub(crate),
            // invisible to this integration fixture, so the margin keeps the
            // scenario over-long even if the cap inches up.
            let big = "x".repeat(5 * 1024 * 1024);
            bridge_write(&mcp_request(
                2,
                "tools/call",
                serde_json::json!({"name":"explore","arguments":{"sql":big}}),
            ));
            // The gateway tears the connection down once the over-long frame
            // drained: EOF (or a reset) reads back as None -- never a
            // response for id=2. The no-response half is pinned at the serve
            // level (the serve_connection over-long e2e); this fixture only
            // proceeds -- the prompt response is what lets the turn settle on
            // the serve error, not a hang.
            let _ = bridge_read();
            respond_prompt(out, &id, StopReason::Success);
        }
        // Issue #630: one round, two calls in the same batch -- starts
        // interleaved (start, start) before the finishes. Pins the saw_call
        // prelude firing once for the round's FIRST call, not per call. The
        // starts/finishes interleave on purpose: the adjacent-pair shape has
        // its own `notify_tool_call_roundtrip`.
        "single_round_two_calls" => {
            notify(out, agent_message("batch prelude prose"));
            notify(
                out,
                tool_call_start("tc_1", "explore SELECT 1", ToolKind::Search),
            );
            notify(
                out,
                tool_call_start("tc_2", "explore SELECT 2", ToolKind::Search),
            );
            notify(out, tool_call_finish("tc_1", "explore SELECT 1", "rows: 3"));
            notify(out, tool_call_finish("tc_2", "explore SELECT 2", "rows: 1"));
            respond_prompt(out, &id, StopReason::Success);
        }
        // `session_new_raw` (issue #630) differs only in the handshake's
        // session/new line (raw schema shape); the prompt phase is the plain
        // text reply.
        "session_new_raw" => {
            notify(out, agent_message("the answer is 42"));
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

/// The ADR-0095 discovery catalog: the real SessionConfigOption wire shape
/// (id / category / currentValue / options[], camelCase) with one model entry
/// (two offered, one current) + one thought_level entry (three offered, one
/// current). Shared by the typed session/new respond and the raw
/// schema-shaped `session_new_raw` line so both pin the same catalog.
fn fake_config_options() -> serde_json::Value {
    serde_json::json!([
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
    ])
}

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

/// Emit one `session/update` as a hand-built JSON line in the schema-crate
/// wire shape named by `wire::MODELED_SCHEMA` (issue #611) --
/// `sessionUpdate` discriminator, one content block. Unlike [`notify`] this
/// never serializes our own types, so the engine's parse path is pinned to
/// the real-agent form.
fn raw_session_update(out: &mut std::io::Stdout, kind: &str, text: &str) {
    let line = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "fake-session",
            "update": {
                "sessionUpdate": kind,
                "messageId": "m1",
                "content": {"type": "text", "text": text},
            },
        },
    });
    write_line(out, &line);
}

/// Emit a `tool_call` start as a hand-built JSON line with a RAW kind string
/// (not our `ToolKind` enum) -- pins that a schema-legal kind the typed
/// helpers never emit still parses instead of dropping the whole line.
fn raw_tool_call_start(out: &mut std::io::Stdout, id: &str, title: &str, kind: &str) {
    let line = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "fake-session",
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": id,
                "title": title,
                "status": "in_progress",
                "kind": kind,
                "content": [],
            },
        },
    });
    write_line(out, &line);
}

fn agent_message(text: &str) -> SessionUpdate {
    SessionUpdate::AgentMessageChunk {
        message_id: Some("m1".into()),
        content: ContentBlock::text(text),
    }
}

/// An `agent_thought_chunk` carrying one text block (issue #611).
fn agent_thought(text: &str) -> SessionUpdate {
    SessionUpdate::AgentThoughtChunk {
        message_id: Some("mt1".into()),
        content: ContentBlock::text(text),
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

fn tool_call_finish(id: &str, title: &str, output: &str) -> SessionUpdate {
    SessionUpdate::ToolCallUpdate {
        tool_call_id: id.into(),
        status: Some(ToolCallStatus::Completed),
        title: Some(title.into()),
        content: vec![ToolCallContent::Content {
            content: ContentBlock::text(output),
        }],
    }
}

/// A complete tool-call round trip on the wire: the start notification
/// immediately followed by the completed finish, nothing interleaved -- the
/// common fixture shape. Scenarios that interleave chunks between the two
/// (`pending_across_round`) or drive the raw wire (`tool_kind_read`) keep
/// the separate paths (issue #630).
fn notify_tool_call_roundtrip(
    out: &mut std::io::Stdout,
    id: &str,
    title: &str,
    kind: ToolKind,
    output: &str,
) {
    notify(out, tool_call_start(id, title, kind));
    notify(out, tool_call_finish(id, title, output));
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
