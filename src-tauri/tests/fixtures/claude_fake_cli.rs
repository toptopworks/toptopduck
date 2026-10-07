//! Claude-code fake CLI fixture (ADR-0097 test seam, issue #561).
//!
//! A minimal binary that emulates the ONE claude-code surface the product
//! drives, in one binary exactly like the real CLI: the stream-json control
//! plane (`--print --output-format stream-json --input-format stream-json`,
//! ADR-0128) -- stdin carries NDJSON frames (`user` messages for the turn,
//! `control_request{initialize}` for the probe), stdout a scripted NDJSON
//! frame stream (`system` / `assistant` / `user` / `result` frames). Mode is
//! detected BY FRAME, never from the scenario name or argv, so the
//! integration tests pin the frame dispatch the production argv drives on
//! every spawn. The turn surface additionally carries the windowed
//! continuation shape (ADR-0128): a scenario may answer an `error_max_turns`
//! result and keep serving the engine's next `user` frame -- the same
//! process, like the real CLI.
//!
//! Declared as a `[[bin]]` in `Cargo.toml`; integration tests resolve its
//! path via `env!("CARGO_BIN_EXE_claude-fake-cli")` and pick the scripted
//! behavior via the `CLAUDE_FAKE_SCENARIO` env var.
//!
//! The spawn argv is traced to `CLAUDE_FAKE_TRACE_FILE` (when set) so the
//! integration tests can assert the engine's argv injection (stdout carries
//! the frame stream the engine owns; stderr inherits to the CI console
//! where no test can read it). The probe's silent scenario appends
//! `heartbeat` lines to the same file so the cleanup test can observe the
//! kill. Pure serde_json -- no lib import -- so the fixture stays
//! self-contained.

use std::io::{BufRead, BufReader, Write};

/// Append one trace line to the file named by `CLAUDE_FAKE_TRACE_FILE`
/// (when set). A no-op when absent.
fn trace_line(line: &str) {
    let Some(path) = std::env::var_os("CLAUDE_FAKE_TRACE_FILE") else {
        return;
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Heartbeat interval for the silent probe scenario: the cleanup test polls
/// the trace file and asserts the beats stop after the probe kills this
/// process (the codex fixture's convention).
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Every known scenario name: an unknown `CLAUDE_FAKE_SCENARIO` fails fast
/// with a non-zero exit instead of silently falling into the success path
/// (the codex fixture's issue #543 convention).
const SCENARIOS: &[&str] = &[
    // Turn surface.
    "text_reply",
    "tool_call",
    "thinking_rounds",
    "native_tool_denied",
    "hook_frames",
    "result_error",
    "max_turns",
    "max_turns_continue",
    "crash_with_text",
    "empty_stdout",
    "turn_silent",
    "slow_drip",
    "cancel_with_prose",
    "no_stdin_hold",
    "die_before_stdin",
    "garbage_lines",
    "line_cap_overlong",
    // Probe surface.
    "catalog_success",
    "catalog_hook_noise",
    "catalog_error",
    "catalog_error_chatty",
    "catalog_no_response",
    "catalog_silent",
];

fn main() {
    let scenario = std::env::var("CLAUDE_FAKE_SCENARIO").unwrap_or_else(|_| "text_reply".into());
    if !SCENARIOS.contains(&scenario.as_str()) {
        eprintln!(
            "claude-fake: unknown scenario `{scenario}` (known: {})",
            SCENARIOS.join(", ")
        );
        std::process::exit(1);
    }

    let argv: Vec<String> = std::env::args().skip(1).collect();
    trace_line(&format!("CLAUDE_FAKE_ARGV={}", argv.join(" ")));

    // Issue #808: a CLI that stalls BEFORE draining stdin: never read, never
    // emit -- the engine's prompt frame write blocks in the OS pipe, so the
    // turn can only resolve via cancel. The 30s hold fails loudly if the
    // cancel cannot break the blocked write.
    if scenario == "no_stdin_hold" {
        std::thread::sleep(std::time::Duration::from_secs(30));
        return;
    }
    // The mid-write death leg of the #808 write: a CLI that exits before
    // draining stdin breaks the prompt frame write on the pipe, which
    // settles the turn as a Runtime stdin write failure.
    if scenario == "die_before_stdin" {
        std::process::exit(1);
    }

    // Both surfaces speak the stream-json control plane off one stdin
    // (ADR-0128 folded the turn's input face onto the probe's): mode is
    // detected BY FRAME (`control_request` vs `user`), never from the argv,
    // so the integration tests pin the frame dispatch the production argv
    // now drives on every turn.
    if scenario == "catalog_silent" {
        // The silent scenario must stay observably alive past the probe's
        // wall-clock timeout (the heartbeat is the cleanup test's signal).
        std::thread::spawn(|| loop {
            trace_line("heartbeat");
            std::thread::sleep(HEARTBEAT_INTERVAL);
        });
    }

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut out = std::io::stdout();
    let mut line = String::new();
    // Which turn window the next `user` frame opens (1 = the turn's prompt;
    // the later ones are the continuation nudge, ADR-0128).
    let mut window: u32 = 0;
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => return, // stdin closed
            Ok(_) => {}
            Err(_) => return,
        }
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match v
            .get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
        {
            "control_request" => {
                if answer_control_request(&scenario, &v, &mut out) {
                    return;
                }
            }
            "user" => {
                window += 1;
                // PR #1227 review (Important 2): trace the text this user
                // frame carries -- the continuation frame must be the
                // engine's nudge alone, and the trace file is the only
                // assertable face (stdout is the engine's frame stream).
                trace_line(&format!(
                    "CLAUDE_FAKE_PROMPT[{window}]={}",
                    v.pointer("/message/content/0/text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                ));
                if run_turn_window(&scenario, window, &mut out) {
                    return;
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Turn surface
// ---------------------------------------------------------------------------

/// Play one turn window's scripted frames (ADR-0128). Returns whether the
/// turn's stream is over (`true` = the process answers no more frames; the
/// engine's kill reaps it) or the window boundary left the process waiting
/// for the next `user` frame (`false`, the continuation scenarios' shape).
fn run_turn_window(scenario: &str, window: u32, out: &mut std::io::Stdout) -> bool {
    match scenario {
        "max_turns" => {
            // The CLI's self-reported budget tops out EVERY window: the
            // engine exhausts its resume budget (1 + 3 windows) and lands
            // the derived ceiling. Staying alive lets the engine drive the
            // next nudge frame; its kill ends us.
            if window == 1 {
                emit(out, &system_init());
            }
            emit(out, &result_max_turns());
            false
        }
        "max_turns_continue" => {
            // Window one tops out mid-work (a gateway-routed call batch in
            // flight); window two -- opened by the engine's nudge frame --
            // answers. The rounds must carry across the boundary (the same
            // tracker, one settle).
            if window == 1 {
                emit(out, &system_init());
                emit(
                    out,
                    &serde_json::json!({
                        "type": "assistant",
                        "message": {"content": [
                            {"type": "text", "text": "checking the table"},
                            {"type": "tool_use", "id": "toolu_1",
                             "name": "mcp__toptopduck-gateway__explore",
                             "input": {"sql": "SELECT 1"}}
                        ]}
                    }),
                );
                emit(
                    out,
                    &serde_json::json!({
                        "type": "user",
                        "message": {"content": [
                            {"type": "tool_result", "tool_use_id": "toolu_1",
                             "content": "1"}
                        ]}
                    }),
                );
                emit(out, &result_max_turns());
                false
            } else {
                emit(
                    out,
                    &serde_json::json!({
                        "type": "assistant",
                        "message": {"content": [{"type": "text", "text": "window two answer"}]}
                    }),
                );
                emit(out, &result_success("window two answer"));
                true
            }
        }
        // Every other scenario's stream ends with its first (and only)
        // window.
        _ => {
            run_single_window(scenario, out);
            true
        }
    }
}

fn run_single_window(scenario: &str, out: &mut std::io::Stdout) {
    match scenario {
        "text_reply" => {
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [
                        {"type": "text", "text": "the answer is 42"}
                    ]}
                }),
            );
            emit(out, &result_success("the answer is 42"));
        }
        "tool_call" => {
            // A gateway-routed MCP call: the engine emits phases and lands
            // the anchor row the settle merge replaces with the gateway's
            // authoritative record in place (issue #817).
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [
                        {"type": "text", "text": "querying"},
                        {"type": "tool_use", "id": "toolu_1",
                         "name": "mcp__toptopduck-gateway__explore",
                         "input": {"sql": "SELECT 1"}}
                    ]}
                }),
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "user",
                    "message": {"content": [
                        {"type": "tool_result", "tool_use_id": "toolu_1",
                         "content": "1"}
                    ]}
                }),
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [
                        {"type": "text", "text": "found 3 rows"}
                    ]}
                }),
            );
            emit(out, &result_success("found 3 rows"));
        }
        "thinking_rounds" => {
            // Headless thinking blocks riding the assistant frames (issue
            // #612, ADR-0103): round 1 opens with thinking + prose + a
            // gateway-routed call batch, then the trailing round carries
            // thinking + prose with no call -- the end-to-end pin for the
            // pump's trailing-thinking freeze and round settle.
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [
                        {"type": "thinking", "thinking": "plan the query"},
                        {"type": "text", "text": "querying"},
                        {"type": "tool_use", "id": "toolu_1",
                         "name": "mcp__toptopduck-gateway__explore",
                         "input": {"sql": "SELECT 1"}}
                    ]}
                }),
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "user",
                    "message": {"content": [
                        {"type": "tool_result", "tool_use_id": "toolu_1",
                         "content": "1"}
                    ]}
                }),
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [
                        {"type": "thinking", "thinking": "verify the rows"},
                        {"type": "text", "text": "the answer is 42"}
                    ]}
                }),
            );
            emit(out, &result_success("the answer is 42"));
        }
        "native_tool_denied" => {
            // A native tool that slipped past the deny list upstream: the
            // engine records it on its own trace; headless auto-refusal
            // reports is_error on the tool_result.
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [
                        {"type": "tool_use", "id": "toolu_9", "name": "Bash",
                         "input": {"command": "ls"}}
                    ]}
                }),
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "user",
                    "message": {"content": [
                        {"type": "tool_result", "tool_use_id": "toolu_9",
                         "is_error": true, "content": "permission denied"}
                    ]}
                }),
            );
            emit(out, &result_success("done without native tools"));
        }
        "hook_frames" => {
            // Session-hook frames mixing with business frames on the same
            // stream (measured on 2.1.222) -- the engine must tolerate them.
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({"type": "system", "subtype": "SessionStart",
                                    "hook_event_name": "SessionStart", "output": "banner"}),
            );
            emit(
                out,
                &serde_json::json!({"type": "system", "subtype": "unknown_future_hook",
                                    "payload": {"anything": [1, 2, 3]}}),
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "hooked but fine"}]}
                }),
            );
            emit(out, &result_success("hooked but fine"));
        }
        "result_error" => {
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "result",
                    "subtype": "error_during_execution",
                    "is_error": true,
                    "result": "rate limited"
                }),
            );
        }
        "max_turns" => {
            // Handled by run_turn_window (the every-window shape).
            unreachable!("max_turns is a continuation scenario")
        }
        "max_turns_continue" => {
            unreachable!("max_turns_continue is a continuation scenario")
        }
        "crash_with_text" => {
            // Assistant text then a hard exit with no result frame: the
            // pump's EOF fallback treats the accumulated text as the answer.
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "about to crash"}]}
                }),
            );
            let _ = out.flush();
            std::process::exit(0);
        }
        "empty_stdout" => {
            // Close stdout immediately -- no frames, no text.
        }
        "turn_silent" => {
            // system{init}, then silence with stdout HELD OPEN: the pump
            // keeps polling until the watchdog (or a user cancel) ends the
            // turn -- the stuck-agent shape the interrupt tests drive.
            emit(out, &system_init());
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        "slow_drip" => {
            // The survival half of ADR-0115: a generation segment that keeps
            // producing past the cap. Frames land every 100ms for ~600ms
            // while the test runs a 400ms cap -- each inbound frame must
            // re-arm the clock, or the watchdog kills the turn mid-stream.
            emit(out, &system_init());
            for i in 0..6u32 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                emit(
                    out,
                    &serde_json::json!({
                        "type": "assistant",
                        "message": {"content": [
                            {"type": "text", "text": format!("drip {i}")}
                        ]}
                    }),
                );
            }
            emit(out, &result_success("dripped to the end"));
        }
        "cancel_with_prose" => {
            // A native tool call, then assistant text, then hold stdout
            // open (no result frame) so the pump's loop-top cancel check
            // ends the turn mid-answer (issue #628's cancel-mid-prose
            // shape). The call's ToolCallStarted phase is the cancel
            // test's latch: once it fires, the prose frame (emitted in
            // the same flush, behind the call) is already in the pipe, so
            // a cancel that waits out one recv cycle lands strictly after
            // the prose folds.
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {}}]}
                }),
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "partial answer"}]}
                }),
            );
            let _ = out.flush();
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        "garbage_lines" => {
            // Non-JSON lines (a startup banner, an update warning, a usage
            // note) interleaved between valid frames -- the pump's line-level
            // skip branch, not a parse failure.
            let _ = writeln!(out, "claude-code v2.1.222 (headless mode)");
            emit(out, &system_init());
            let _ = writeln!(
                out,
                "update available: run npm i -g @anthropic-ai/claude-code"
            );
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "the answer is 42"}]}
                }),
            );
            let _ = writeln!(out, "usage: 10 input tokens, 5 output tokens");
            emit(out, &result_success("the answer is 42"));
        }
        "line_cap_overlong" => {
            // A single line past the 4-MiB line cap (issue #639's cap
            // reaching the stream path): the shared reader drops it and
            // the connection stays up -- the frames on the lines after it
            // still arrive. The over-long line is raw non-JSON garbage
            // (dropped before any parse, so no envelope is needed).
            let _ = writeln!(out, "{}", "g".repeat(5 * 1024 * 1024));
            emit(out, &system_init());
            emit(
                out,
                &serde_json::json!({
                    "type": "assistant",
                    "message": {"content": [{"type": "text", "text": "still alive"}]}
                }),
            );
            emit(out, &result_success("still alive"));
        }
        _ => unreachable!("scenario validated above"),
    }
    let _ = out.flush();
}

/// The opening `system{init}` frame (every turn scenario emits one -- the
/// driver's honest-rendering catalog read).
fn system_init() -> serde_json::Value {
    serde_json::json!({
        "type": "system",
        "subtype": "init",
        "model": "claude-fake-4",
        "cwd": "/tmp",
        "tools": ["mcp__toptopduck-gateway__explore"]
    })
}

/// A success `result` frame carrying the final text.
fn result_success(text: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "result": text,
        "total_cost_usd": 0.0,
        "usage": {"input_tokens": 1, "output_tokens": 1}
    })
}

/// The CLI's self-reported turn-budget ceiling (the ADR-0128 window
/// boundary): an error `result` frame the engine resumes off under the
/// windowed continuation budget.
fn result_max_turns() -> serde_json::Value {
    serde_json::json!({
        "type": "result",
        "subtype": "error_max_turns",
        "is_error": true,
        "result": ""
    })
}

// ---------------------------------------------------------------------------
// Probe surface (the stream-json control plane)
// ---------------------------------------------------------------------------

/// Answer one `control_request` frame with the scenario's scripted
/// `control_response`. Returns whether the process is done serving (every
/// probe behavior answers at most once -- the caller reaps); `false` keeps
/// the frame loop sniffing past a non-initialize request. The wire contract
/// is the one the real CLI measured: the request carries `request.subtype`
/// `initialize` (a wrong shape is a fixture bug, not a scenario).
fn answer_control_request(
    scenario: &str,
    v: &serde_json::Value,
    out: &mut std::io::Stdout,
) -> bool {
    let is_initialize = v
        .get("request")
        .and_then(|r| r.get("subtype"))
        .and_then(serde_json::Value::as_str)
        == Some("initialize");
    if !is_initialize {
        return false;
    }
    let request_id = v
        .get("request_id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    match scenario {
        "catalog_success" => {
            emit(
                out,
                &control_response(request_id, catalog_success_payload()),
            );
        }
        "catalog_hook_noise" => {
            // Hook frames precede the control response on the same
            // stdout -- the probe must sniff past them.
            emit(
                out,
                &serde_json::json!({"type": "system", "subtype": "SessionStart",
                                    "output": "probe banner"}),
            );
            emit(
                out,
                &serde_json::json!({"type": "system", "subtype": "unknown_hook",
                                    "payload": [1, 2]}),
            );
            emit(
                out,
                &control_response(request_id, catalog_success_payload()),
            );
        }
        "catalog_error" => {
            emit(out, &control_error(request_id, "auth required"));
        }
        // An error response with a chatty-but-alive process (issue #543
        // precedent, codex fixture's `catalog_error_chatty` peer): the
        // degraded `Unavailable` detail must carry the stderr diagnosis
        // too (the not-logged-in shape: the CLI keeps running and prints
        // its auth guidance on stderr).
        "catalog_error_chatty" => {
            eprintln!("claude-fake: please run `claude login` before listing models");
            emit(out, &control_error(request_id, "auth required"));
        }
        "catalog_no_response" => {
            // Read the request, then serve nothing: the probe degrades to
            // the empty catalog (ADR-0097 Decision 5).
        }
        "catalog_silent" => {
            // Never answer; the heartbeat thread keeps the process
            // observably alive until the probe's deadline kills it.
            std::thread::sleep(std::time::Duration::from_secs(300));
        }
        _ => unreachable!("probe scenario validated above"),
    }
    true
}

/// The measured catalog payload (2.1.222 shape, re-measured locally): two
/// models, the first fully populated (ordered efforts + the measured
/// `description` / `supports*` capability bits the extraction ignores), the
/// second minimal (resolvedModel display fallback). `isDefault` /
/// `defaultEffort` were absent in the measured response (the CLI points at
/// its default via the `default` alias) but ride here as tolerated optional
/// markers so the integration tests can pin the default-marker render path.
fn catalog_success_payload() -> serde_json::Value {
    serde_json::json!({
        "models": [
            {
                "value": "claude-sonnet-4",
                "resolvedModel": "claude-sonnet-4-20250514",
                "displayName": "Claude Sonnet 4",
                "isDefault": true,
                "defaultEffort": "medium",
                "supportedEffortLevels": ["low", "medium", "high"],
                "description": "Recommended model",
                "supportsEffort": true,
                "supportsAdaptiveThinking": true,
                "supportsAutoMode": true
            },
            {
                "value": "claude-opus-4",
                "resolvedModel": "claude-opus-4-20250514",
                "supportedEffortLevels": ["high"]
            }
        ]
    })
}

/// Wrap a success payload in a control_response envelope echoing the
/// request id. The echo rides INSIDE the response payload
/// (`response.request_id`), not at the frame's top level -- the wire
/// measured on 2.1.222 against the CLI's own emit sites.
fn control_response(
    request_id: serde_json::Value,
    response: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request_id, "response": response}
    })
}

/// Wrap an error diagnostic in a control_response envelope echoing the
/// request id (the same nested placement). The CLI's error frames carry
/// the diagnostic under `error`, not `message`.
fn control_error(request_id: serde_json::Value, error: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "control_response",
        "response": {"subtype": "error", "request_id": request_id, "error": error}
    })
}

/// Write one NDJSON line + flush.
fn emit(out: &mut std::io::Stdout, value: &serde_json::Value) {
    if let Ok(s) = serde_json::to_string(value) {
        let _ = writeln!(out, "{s}");
        let _ = out.flush();
    }
}
