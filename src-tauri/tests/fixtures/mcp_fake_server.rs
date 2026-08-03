//! MCP fake server fixture (issue #301 slice C-gw).
//!
//! Minimal stdio MCP server for the gateway aggregation / routing integration
//! tests. Declared as a `[[bin]]` in Cargo.toml; integration tests resolve its
//! path via `env!("CARGO_BIN_EXE_mcp-fake-server")` and spawn it as a configured
//! `McpServerConfig`. Speaks the MCP stdio newline-delimited JSON-RPC subset
//! the gateway's [`StdioClient`](toptopduck_lib::mcp::client::StdioClient)
//! drives:
//! - `initialize` -> an `InitializeResult` advertising protocolVersion
//!   `2024-11-05` (the version the gateway pins).
//! - `tools/list` -> a fixed three-tool table (`echo`, `add`, `echo_env`).
//! - `tools/call` -> the result content; `add` sums `a + b`, `echo` echoes the
//!   `message` argument, `echo_env` reflects a child-process env var's value
//!   (so the secret-injection integration test can verify a `keychain_env_keys`
//!   value reached the spawn, ADR-0029). The gateway strips the `mcp__<slug>__`
//!   prefix before routing, so this server only ever sees its native tool name
//!   -- a leaked namespaced name in the call would surface as the `_` fallback.
//!
//! Pure `serde_json` (no `toptopduck_lib` import) so the fixture stays
//! self-contained; the MCP wire shape is plain JSON-RPC over newline-delimited
//! frames, no shared types needed (mirrors the ACP bridge's transport-only
//! stance). A blank or malformed line is skipped -- the gateway's framing
//! already rejects malformed frames upstream, this just keeps the fixture
//! tolerant of stray whitespace.

use std::io::{self, BufRead, BufReader, Write};

use serde_json::{json, Value};

fn main() {
    let mut out = io::stdout();
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // stdin closed (gateway dropped the client)
            Ok(_) => {}
            Err(_) => break,
        }
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed.is_empty() {
            continue;
        }
        let v: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = v.get("id").cloned();
        let method = v.get("method").and_then(Value::as_str);
        let resp = match method {
            Some("initialize") => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "serverInfo": {"name": "mcp-fake-server", "version": "0.0.0"}
                }
            })),
            Some("tools/list") => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "tools": [
                        {"name": "echo", "description": "echo the message field",
                         "inputSchema": {"type": "object"}},
                        {"name": "add", "description": "sum a and b",
                         "inputSchema": {"type": "object"}},
                        {"name": "echo_env", "description": "reflect a child env var",
                         "inputSchema": {"type": "object"}}
                    ]
                }
            })),
            Some("tools/call") => Some(call_response(id, &v)),
            _ => None,
        };
        if let Some(r) = resp {
            write_msg(&mut out, &r);
        }
    }
}

/// Build the `tools/call` result. `add` sums the integer `a` + `b` args;
/// `echo_env` reflects the child process's env var named by the `key` arg
/// (returns `<unset>` when absent, so the secret-injection test can distinguish
/// "not injected" from an empty value); any other tool name (including the
/// `echo` fixture + the `_` fallback if a namespaced name ever leaked through)
/// echoes the `message` string arg.
fn call_response(id: Option<Value>, req: &Value) -> Value {
    let params = req.get("params");
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let args = params
        .and_then(|p| p.get("arguments"))
        .cloned()
        .unwrap_or(Value::Null);
    let text = match name {
        "add" => {
            let a = args.get("a").and_then(Value::as_i64).unwrap_or(0);
            let b = args.get("b").and_then(Value::as_i64).unwrap_or(0);
            format!("{}", a + b)
        }
        "echo_env" => {
            let key = args.get("key").and_then(Value::as_str).unwrap_or("");
            std::env::var(key).unwrap_or_else(|_| "<unset>".into())
        }
        _ => {
            let msg = args.get("message").and_then(Value::as_str).unwrap_or("");
            format!("Echo: {msg}")
        }
    };
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{"type": "text", "text": text}],
            "isError": false
        }
    })
}

/// Write one newline-delimited JSON-RPC frame (the MCP stdio wire form).
fn write_msg(out: &mut impl Write, msg: &Value) {
    let _ = serde_json::to_writer(&mut *out, msg);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
