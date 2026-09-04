//! Codex fake CLI fixture (ADR-0094 test seam, issue #523).
//!
//! A minimal binary that emulates `codex exec --json` NDJSON output so the JSON
//! event stream engine (`toptopduck_lib::runtime::acp::codex_event_stream`) can
//! be exercised end-to-end in CI without the real codex install. Declared as a
//! `[[bin]]` in `Cargo.toml`; integration tests resolve its path via
//! `env!("CARGO_BIN_EXE_codex-fake-cli")` and pick the scripted behavior via the
//! `CODEX_FAKE_SCENARIO` env var.
//!
//! The engine spawns `codex exec --json …`, writes the flattened prompt to stdin,
//! then reads NDJSON events from stdout. This fixture mirrors that contract:
//! read stdin until EOF, then emit the scripted NDJSON event stream. Pure
//! serde_json — no lib import — so the fixture stays self-contained.
//!
//! The emitted shapes are the measured codex 0.147.0 wire format (issue #804):
//! dot-typed turn events plus `item.started` / `item.completed` envelopes.

use std::io::{Read, Write};

/// An `item.completed` envelope wrapping an `agent_message` item.
fn agent_message(id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "item.completed",
        "item": {"id": id, "type": "agent_message", "text": text}
    })
}

/// An `item.completed` envelope wrapping a successful (exit 0)
/// `command_execution` item.
fn command_execution(id: &str, command: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "item.completed",
        "item": {
            "id": id,
            "type": "command_execution",
            "command": command,
            "aggregated_output": "",
            "exit_code": 0,
            "status": "completed"
        }
    })
}

/// An `item.completed` envelope wrapping an `mcp_tool_call` item: a
/// gateway-served tool call on the codex line (issue #816). The field shape
/// is the codex 0.153.1 protocol definition (`McpToolCallItem` in
/// codex-rs/protocol + the TS SDK items): `id` / `server` / `tool` /
/// `arguments` / `status` (`completed` | `failed`) / optional
/// `error.message`. Pinned from the protocol source, not a capture — the
/// real-CLI capture is pending.
fn mcp_tool_call(
    id: &str,
    tool: &str,
    arguments: serde_json::Value,
    status: &str,
    error: Option<&str>,
) -> serde_json::Value {
    let mut item = serde_json::json!({
        "id": id,
        "type": "mcp_tool_call",
        "server": "toptopduck-gateway",
        "tool": tool,
        "arguments": arguments,
        "status": status,
    });
    if let Some(error) = error {
        item["error"] = serde_json::json!({"message": error});
    }
    item
}

/// Append the spawn-argv trace line to the file named by
/// `CODEX_FAKE_TRACE_FILE` (when set). The integration test passes a temp
/// file so it can assert on the engine's argv injection (stdout carries the
/// event stream the engine owns; stderr inherits to the CI console where no
/// test can read it). A no-op when the var is absent, so ad-hoc manual runs
/// keep working.
fn trace_argv(argv: &[String]) {
    use std::io::Write;
    let Some(path) = std::env::var_os("CODEX_FAKE_TRACE_FILE") else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "CODEX_FAKE_ARGV={}", argv.join(" "));
    }
}

fn main() {
    let scenario = std::env::var("CODEX_FAKE_SCENARIO").unwrap_or_else(|_| "text_reply".into());

    // ADR-0095: trace the spawn argv so the integration test can assert the
    // engine's model / thought-level injection.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    trace_argv(&argv);

    // Issue #808: a CLI that stalls BEFORE draining stdin (e.g. wedged in
    // its own MCP init): never read, never emit -- the engine's oversized
    // prompt write blocks in the OS pipe, so the turn can only resolve via
    // cancel. The 30s hold fails loudly if the cancel cannot break the
    // blocked write.
    if scenario == "no_stdin_hold" {
        std::thread::sleep(std::time::Duration::from_secs(30));
        return;
    }

    // The mid-write death leg of the #808 write: a CLI that exits before
    // draining stdin (e.g. a startup config rejection) breaks the oversized
    // prompt write on the pipe, which settles the turn as a Transient stdin
    // write failure.
    if scenario == "die_before_stdin" {
        std::process::exit(1);
    }

    // Drain stdin (the flattened prompt) to EOF — codex reads the prompt from
    // stdin when no positional arg is given.
    let mut stdin = std::io::stdin();
    let mut buf = Vec::new();
    let _ = stdin.read_to_end(&mut buf);

    let mut out = std::io::stdout();
    match scenario.as_str() {
        // The faithful measured sequence (issue #804's capture, minus the
        // command): thread.started stays an ignored shape, the reasoning
        // item folds into the round's thinking (issue #807), the
        // agent_message text rides the terminal.
        "text_reply" => {
            emit(
                &mut out,
                &serde_json::json!({"type": "thread.started", "thread_id": "<uuid>"}),
            );
            emit(&mut out, &serde_json::json!({"type": "turn.started"}));
            emit(
                &mut out,
                &serde_json::json!({
                    "type": "item.completed",
                    "item": {"id": "item_0", "type": "reasoning", "text": "thinking..."}
                }),
            );
            emit(&mut out, &agent_message("item_1", "the answer is 42"));
            emit(
                &mut out,
                &serde_json::json!({"type": "turn.completed", "usage": {"input_tokens": 0, "output_tokens": 0}}),
            );
        }
        // The command arrives as the measured item.started / item.completed
        // pair: the streaming variant must not double the trace row.
        "tool_call" => {
            emit(
                &mut out,
                &serde_json::json!({
                    "type": "item.started",
                    "item": {
                        "id": "item_1",
                        "type": "command_execution",
                        "command": "explore SELECT 1",
                        "aggregated_output": "",
                        "exit_code": null,
                        "status": "in_progress"
                    }
                }),
            );
            emit(&mut out, &command_execution("item_1", "explore SELECT 1"));
            emit(&mut out, &agent_message("item_2", "found 3 rows"));
            emit(&mut out, &serde_json::json!({"type": "turn.completed"}));
        }
        "turn_failed" => {
            emit(
                &mut out,
                &serde_json::json!({"type": "turn.failed", "error": "rate limited"}),
            );
        }
        // Gateway-served MCP tool calls (issue #816): two completed
        // `mcp_tool_call` items — a registered-CLI-shaped bare name and a
        // namespaced external name — then the answer. Each must render live
        // (a phase pair per call) and land one trace row on the round.
        "mcp_tool_call" => {
            emit(
                &mut out,
                &serde_json::json!({
                    "type": "item.completed",
                    "item": mcp_tool_call(
                        "item_1",
                        "convert",
                        serde_json::json!({"input": "a.csv"}),
                        "completed",
                        None
                    )
                }),
            );
            emit(
                &mut out,
                &serde_json::json!({
                    "type": "item.completed",
                    "item": mcp_tool_call(
                        "item_2",
                        "mcp__duckdb__query_snapshot",
                        serde_json::json!({"sql": "SELECT 1"}),
                        "completed",
                        None
                    )
                }),
            );
            emit(&mut out, &agent_message("item_3", "converted 2 rows"));
            emit(&mut out, &serde_json::json!({"type": "turn.completed"}));
        }
        // A failed gateway call (status "failed" + error.message): the row
        // lands failed with the wire's error message as the anchor (issue
        // #816).
        "mcp_tool_call_failed" => {
            emit(
                &mut out,
                &serde_json::json!({
                    "type": "item.completed",
                    "item": mcp_tool_call(
                        "item_1",
                        "convert",
                        serde_json::json!({"input": "b.csv"}),
                        "failed",
                        Some("converter crashed")
                    )
                }),
            );
            emit(&mut out, &agent_message("item_2", "the call failed"));
            emit(&mut out, &serde_json::json!({"type": "turn.completed"}));
        }
        // A failed command (non-zero exit) plus the answer text: the row
        // lands failed with the exit code as the failure anchor (issue #804).
        "tool_call_failure" => {
            emit(
                &mut out,
                &serde_json::json!({
                    "type": "item.completed",
                    "item": {
                        "id": "item_1",
                        "type": "command_execution",
                        "command": "false",
                        "aggregated_output": "",
                        "exit_code": 1,
                        "status": "completed"
                    }
                }),
            );
            emit(&mut out, &agent_message("item_2", "the command failed"));
            emit(&mut out, &serde_json::json!({"type": "turn.completed"}));
        }
        "round_prose" => {
            // Two batch rounds, each with its own prose, then the trailing
            // answer stretch (issue #613's per-round grouping scenario).
            emit(&mut out, &agent_message("item_1", "checking the table"));
            emit(&mut out, &command_execution("item_2", "explore SELECT 1"));
            emit(&mut out, &agent_message("item_3", "verifying the count"));
            emit(
                &mut out,
                &command_execution("item_4", "explore SELECT COUNT(*)"),
            );
            emit(&mut out, &agent_message("item_5", "the answer is 42"));
            emit(&mut out, &serde_json::json!({"type": "turn.completed"}));
        }
        "step_cap_overflow" => {
            // Emit more command_execution items than the step cap (tests pass
            // cap=3); the engine kills the child once tool_call_count exceeds
            // the cap, so we emit up front. The engine's recv_timeout loop will
            // break and kill before consuming all of these.
            for i in 1..=50u32 {
                let _ = writeln!(
                    out,
                    r#"{{"type":"item.completed","item":{{"id":"item_{i}","type":"command_execution","command":"call {i}","aggregated_output":"","exit_code":0,"status":"completed"}}}}"#
                );
            }
            let _ = out.flush();
            // Block so the engine has time to notice the step-cap trip and kill
            // us. Without this, the process exits immediately and the pump sees
            // Disconnected instead of the step-cap path.
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        "line_cap_overlong" => {
            // A single line past the 4-MiB line cap (issue #639's cap
            // reaching the stream path): the shared reader drops it and
            // the connection stays up -- the events after it still
            // arrive. The over-long line is raw non-JSON garbage (dropped
            // before any parse, so no envelope is needed).
            let _ = writeln!(out, "{}", "g".repeat(5 * 1024 * 1024));
            emit(&mut out, &agent_message("item_1", "still alive"));
            emit(&mut out, &serde_json::json!({"type": "turn.completed"}));
        }
        "crash" => {
            emit(&mut out, &agent_message("item_1", "about to crash"));
            let _ = out.flush();
            std::process::exit(0);
        }
        "disconnected_with_text" => {
            // Emit agent text then close stdout without a terminal event.
            emit(&mut out, &agent_message("item_1", "partial reply"));
            let _ = out.flush();
            // Exit normally — stdout closes, the pump sees Disconnected with
            // accumulated text -> treats as success.
        }
        "empty_stdout" => {
            // Close stdout immediately — no events, no text. The pump sees
            // Disconnected with no text -> Transient.
        }
        "cancel_with_prose" => {
            // A command execution, then agent text, then hold stdout open
            // (no terminal event) so the pump's loop-top cancel check ends
            // the turn mid-answer (issue #628's cancel-mid-prose shape).
            // The call's ToolCallStarted phase is the cancel test's latch:
            // once it fires, the text event (emitted in the same flush,
            // behind the call) is already in the pipe, so a cancel that
            // waits out one recv cycle lands strictly after the prose
            // folds.
            emit(&mut out, &command_execution("item_1", "explore SELECT 1"));
            emit(&mut out, &agent_message("item_2", "partial answer"));
            let _ = out.flush();
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        other => {
            emit(
                &mut out,
                &agent_message("item_1", &format!("unknown scenario: {other}")),
            );
            emit(&mut out, &serde_json::json!({"type": "turn.completed"}));
        }
    }
    let _ = out.flush();
}

/// Write one NDJSON line + flush.
fn emit(out: &mut std::io::Stdout, value: &serde_json::Value) {
    if let Ok(s) = serde_json::to_string(value) {
        let _ = writeln!(out, "{s}");
        let _ = out.flush();
    }
}
