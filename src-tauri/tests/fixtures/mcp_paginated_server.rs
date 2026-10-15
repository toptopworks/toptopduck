//! MCP paginated fake server fixture (issue #900).
//!
//! Minimal stdio MCP server whose `tools/list` answer is split across two
//! pages: the first request returns `echo` + `add` with
//! `nextCursor: "page-2"`; the request echoing that cursor returns
//! `fetch_page2` with no cursor (traversal complete). The gateway integration
//! tests pin that `McpClient::list_tools` folds every page into the
//! aggregated catalog (pre-#900 the second page was silently dropped); the
//! probe integration test lists through `stdio_handshake` the same way, the
//! exact building blocks `probe_mcp_server` composes.
//!
//! Pure `serde_json` (no `toptopduck_lib` import), mirroring the
//! `mcp-fake-server` fixture's transport-only stance. A blank or malformed
//! line is skipped -- the gateway's framing rejects malformed frames
//! upstream; this just keeps the fixture tolerant of stray whitespace.

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
                    "serverInfo": {"name": "mcp-paginated-server", "version": "0.0.0"}
                }
            })),
            Some("tools/list") => {
                // The page is selected by the cursor the request echoes; an
                // absent cursor is page 1, "page-2" is the final page.
                let cursor = v
                    .get("params")
                    .and_then(|p| p.get("cursor"))
                    .and_then(Value::as_str);
                if cursor == Some("page-2") {
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "tools": [
                                {"name": "fetch_page2",
                                 "description": "only reachable via the cursor",
                                 "inputSchema": {"type": "object"}}
                            ]
                        }
                    }))
                } else {
                    Some(json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "tools": [
                                {"name": "echo", "description": "echo the message field",
                                 "inputSchema": {"type": "object"}},
                                {"name": "add", "description": "sum a and b",
                                 "inputSchema": {"type": "object"}}
                            ],
                            "nextCursor": "page-2"
                        }
                    }))
                }
            }
            // Not driven by the pagination tests; answer visibly rather than
            // parking the client on a swallowed request.
            Some("tools/call") => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "content": [{"type": "text", "text": "unexpected tools/call"}],
                    "isError": true
                }
            })),
            _ => None,
        };
        if let Some(r) = resp {
            write_msg(&mut out, &r);
        }
    }
}

/// Write one newline-delimited JSON-RPC frame (the MCP stdio wire form).
fn write_msg(out: &mut impl Write, msg: &Value) {
    let _ = serde_json::to_writer(&mut *out, msg);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}
