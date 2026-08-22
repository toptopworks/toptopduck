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

use std::io::{Read, Write};

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

    // Drain stdin (the flattened prompt) to EOF — codex reads the prompt from
    // stdin when no positional arg is given.
    let mut stdin = std::io::stdin();
    let mut buf = Vec::new();
    let _ = stdin.read_to_end(&mut buf);

    let mut out = std::io::stdout();
    match scenario.as_str() {
        "text_reply" => {
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "the answer is 42"}),
            );
            emit(&mut out, &serde_json::json!({"type": "turn_completed"}));
        }
        "tool_call" => {
            emit(
                &mut out,
                &serde_json::json!({"type": "command_execution", "call_id": "call_1", "command": "explore SELECT 1"}),
            );
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "found 3 rows"}),
            );
            emit(&mut out, &serde_json::json!({"type": "turn_completed"}));
        }
        "turn_failed" => {
            emit(
                &mut out,
                &serde_json::json!({"type": "turn_failed", "error": "rate limited"}),
            );
        }
        "round_prose" => {
            // Two batch rounds, each with its own prose, then the trailing
            // answer stretch (issue #613's per-round grouping scenario).
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "checking the table"}),
            );
            emit(
                &mut out,
                &serde_json::json!({"type": "command_execution", "call_id": "call_1", "command": "explore SELECT 1"}),
            );
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "verifying the count"}),
            );
            emit(
                &mut out,
                &serde_json::json!({"type": "command_execution", "call_id": "call_2", "command": "explore SELECT COUNT(*)"}),
            );
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "the answer is 42"}),
            );
            emit(&mut out, &serde_json::json!({"type": "turn_completed"}));
        }
        "step_cap_overflow" => {
            // Emit more command_execution events than the step cap (tests pass
            // cap=3); the engine kills the child once tool_call_count exceeds
            // the cap, so we emit up front. The engine's recv_timeout loop will
            // break and kill before consuming all of these.
            for i in 1..=50u32 {
                let _ = writeln!(
                    out,
                    r#"{{"type":"command_execution","call_id":"call_{i}","command":"call {i}"}}"#
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
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "still alive"}),
            );
            emit(&mut out, &serde_json::json!({"type": "turn_completed"}));
        }
        "crash" => {
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "about to crash"}),
            );
            let _ = out.flush();
            std::process::exit(0);
        }
        "disconnected_with_text" => {
            // Emit agent text then close stdout without a terminal event.
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "partial reply"}),
            );
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
            emit(
                &mut out,
                &serde_json::json!({"type": "command_execution", "call_id": "call_1", "command": "explore SELECT 1"}),
            );
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": "partial answer"}),
            );
            let _ = out.flush();
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
        other => {
            emit(
                &mut out,
                &serde_json::json!({"type": "agent_message", "message": format!("unknown scenario: {other}")}),
            );
            emit(&mut out, &serde_json::json!({"type": "turn_completed"}));
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
