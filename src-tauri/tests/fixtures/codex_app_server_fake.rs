//! Codex app-server fake fixture (ADR-0096 D2, issue #535).
//!
//! A minimal binary that speaks the codex `app-server` JSON-RPC-over-stdio
//! subset (newline-delimited, WITHOUT the `jsonrpc` field -- the app-server
//! neither sends nor expects it) so the diagnostic probe's `model/list`
//! catalog read can be exercised end-to-end in CI without the real codex
//! install. Declared as a `[[bin]]` in `Cargo.toml`; integration tests resolve
//! its path via `env!("CARGO_BIN_EXE_codex-app-server-fake")` and pick the
//! scripted behavior via the `CODEX_APP_SERVER_SCENARIO` env var.
//!
//! Pure serde_json -- no lib import -- so the fixture stays self-contained.

use std::io::{BufRead, BufReader, Write};
use std::thread;

/// Heartbeat interval for the `catalog_silent` scenario: the probe cleanup
/// test polls the trace file and asserts the beats stop after the probe kills
/// this process.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

/// Append one trace line to the file named by `CODEX_APP_SERVER_TRACE_FILE`
/// (when set). A no-op when absent.
fn trace_line(line: &str) {
    let Some(path) = std::env::var_os("CODEX_APP_SERVER_TRACE_FILE") else {
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

/// Append a heartbeat line every [`HEARTBEAT_INTERVAL`] until the process
/// dies -- the same liveness signal as the ACP fixture's `handshake_silent`.
fn spawn_heartbeat() {
    thread::spawn(|| loop {
        trace_line("heartbeat");
        thread::sleep(HEARTBEAT_INTERVAL);
    });
}

/// One model entry on the wire (camelCase, the subset the probe reads).
fn model(
    id: &str,
    display_name: &str,
    is_default: bool,
    default_effort: &str,
    efforts: &[(&str, &str)],
) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "model": id,
        "displayName": display_name,
        "description": "fake",
        "hidden": false,
        "isDefault": is_default,
        "defaultReasoningEffort": default_effort,
        "supportedReasoningEfforts": efforts
            .iter()
            .map(|(effort, desc)| serde_json::json!({ "reasoningEffort": effort, "description": desc }))
            .collect::<Vec<_>>(),
    })
}

/// The default model (ordered efforts: low -> medium -> high).
fn model_codex() -> serde_json::Value {
    model(
        "gpt-5.2-codex",
        "GPT-5.2 Codex",
        true,
        "medium",
        &[
            ("low", "fast"),
            ("medium", "balanced"),
            ("high", "thorough"),
        ],
    )
}

/// A second model with a single effort (never the default).
fn model_mini() -> serde_json::Value {
    model(
        "gpt-5.1-codex-mini",
        "GPT-5.1 Codex Mini",
        false,
        "low",
        &[("low", "fast")],
    )
}

fn main() {
    let scenario =
        std::env::var("CODEX_APP_SERVER_SCENARIO").unwrap_or_else(|_| "catalog_success".into());
    // The silent scenario must still be observably alive (its whole point is
    // to hang past the probe's wall-clock timeout).
    if scenario == "catalog_silent" {
        spawn_heartbeat();
    }

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut out = std::io::stdout();
    let mut line = String::new();
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
        let id = v.get("id").cloned().unwrap_or(serde_json::Value::Null);

        match (scenario.as_str(), method) {
            // A CLI that answers model/list with a JSON-RPC error (old codex
            // without the RPC / not logged in) -> the probe degrades.
            ("catalog_error", Some("model/list")) => {
                respond(
                    &mut out,
                    &serde_json::json!({
                        "id": id,
                        "error": { "code": -32601, "message": "method not found: model/list" }
                    }),
                );
            }
            // A CLI that starts but never answers -> the probe's wall clock.
            ("catalog_silent", Some("model/list")) => {}
            // A CLI that exits immediately on model/list -> stdout EOF.
            ("catalog_crash", Some("model/list")) => {
                let _ = out.flush();
                std::process::exit(0);
            }
            // Paginated: page 1 carries nextCursor, page 2 ends the list. The
            // probe must follow the cursor and fold both pages.
            ("catalog_paginated", Some("model/list")) => {
                let has_cursor = v
                    .get("params")
                    .and_then(|p| p.get("cursor"))
                    .and_then(serde_json::Value::as_str)
                    .is_some();
                if has_cursor {
                    respond(
                        &mut out,
                        &json_result(
                            id,
                            serde_json::json!({ "data": [model_mini()], "nextCursor": null }),
                        ),
                    );
                } else {
                    respond(
                        &mut out,
                        &json_result(
                            id,
                            serde_json::json!({ "data": [model_codex()], "nextCursor": "page2" }),
                        ),
                    );
                }
            }
            // Single-page success (the default): both models in one page.
            (_, Some("model/list")) => {
                respond(
                    &mut out,
                    &json_result(
                        id,
                        serde_json::json!({
                            "data": [model_codex(), model_mini()],
                            "nextCursor": null
                        }),
                    ),
                );
            }
            _ => {}
        }
        let _ = out.flush();
    }
}

/// Wrap a result payload in a success response envelope (no `jsonrpc` field).
fn json_result(id: serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "id": id, "result": result })
}

/// Write one NDJSON line + flush.
fn respond(out: &mut std::io::Stdout, value: &serde_json::Value) {
    if let Ok(s) = serde_json::to_string(value) {
        let _ = writeln!(out, "{s}");
        let _ = out.flush();
    }
}
