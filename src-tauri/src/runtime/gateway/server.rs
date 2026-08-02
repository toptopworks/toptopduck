//! The MCP gateway server the external runtime's bridge connects back to
//! (ADR-0085).
//!
//! [`bind_gateway`] binds a per-bridge listener on a random localhost port +
//! mints a 256-bit token; [`serve_connection`] then accepts one bridge,
//! verifies the token, and drives the MCP `initialize` / `tools/list` /
//! `tools/call` subset against the session's live resources. The split keeps
//! [`bind_gateway`] non-blocking (the caller needs the port to inject into the
//! bridge descriptor before the bridge connects) while [`serve_connection`]
//! blocks for the bridge connection's lifetime.
//!
//! `tools/list` advertises the built-in DuckDB tool table; external MCP /
//! skill tools join the table in later slices (ADR-0085 Consequences).
//! `tools/call` routes through the approval gate + [`crate::tools::dispatch`],
//! mirroring the built-in agent loop's `execute_call` -- built-in tools
//! classify `Allow` (zero approval, ADR-0080 Decision 1), unknown names fall
//! through to the external arm and surface the gate's pending card.

use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpListener;

use serde_json::{json, Value};

use crate::approval::{ApprovalRequest, ApprovalSink, ApprovalState, GateCancelled, GateOutcome};
use crate::cancel::CancelToken;
use crate::model::Promotion;
use crate::provider::tool_calling::{ToolDefinition, ToolUse};
use crate::session::agent_loop::{classify_call, truncate_trace_excerpt, TraceEntry};
use crate::session::materializer::{Materializer, TurnDeps};
use crate::tools::{builtin_table, dispatch};

use super::framing;

/// Trace-excerpt bound for a gateway tool call's result content. Mirrors the
/// built-in loop's `TRACE_EXCERPT_MAX` so a trace row from the external runtime
/// renders identically to one from the built-in loop (ADR-0078 cross-runtime
/// trace contract). Kept local (the built-in loop's const is private) to mirror
/// the ACP wire module's stance -- the value pins a contract, not a shared
/// constant.
const TRACE_EXCERPT_MAX: usize = 240;

/// A per-bridge-connection gateway endpoint: a bound listener, the OS-assigned
/// port, and the 256-bit token a bridge must present on connect.
///
/// Built by [`bind_gateway`] and consumed by [`serve_connection`]. The listener
/// accepts exactly one bridge connection (ADR-0085 per-bridge lifecycle) --
/// [`serve_connection`] consumes it on the first accept, so a second connect
/// attempt finds no listener.
pub struct GatewayHandle {
    /// The OS-assigned localhost port. Inject into the bridge descriptor
    /// (`McpServer::stdio_bridge` env `PORT`) before the bridge is spawned.
    pub port: u16,
    /// The 256-bit hex token. Inject into the bridge descriptor env `TOKEN`;
    /// the bridge presents it as its first TCP line for [`serve_connection`]
    /// to verify.
    pub token: String,
    listener: TcpListener,
}

/// Bind a per-bridge gateway on a random localhost port + mint the auth token.
///
/// Non-blocking: returns once the listener is bound so the caller can inject
/// `port` + `token` into the bridge descriptor before the bridge is spawned.
/// The actual accept + serve is [`serve_connection`].
pub fn bind_gateway() -> io::Result<GatewayHandle> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    Ok(GatewayHandle {
        port,
        token: generate_token(),
        listener,
    })
}

/// The session resources a gateway handler borrows to drive `tools/call`.
/// Bundled so [`serve_connection`] stays under clippy's argument-count threshold
/// and the always-coupled borrows move together into the scoped serve thread.
pub struct GatewayCtx<'a> {
    /// The per-turn DuckDB + working-set borrows `tools::dispatch` reads +
    /// mutates.
    pub deps: TurnDeps<'a>,
    /// The materializer `tools::dispatch` delegates `materialize` to (the same
    /// trait the built-in loop drives, so numbering + caps inherit verbatim).
    pub materializer: &'a mut dyn Materializer,
    /// The session's approval state -- the gate's classify + pending machinery.
    pub approval: &'a ApprovalState,
    /// The session's approval event sink (the card UI's pending/resolved channel).
    pub sink: &'a dyn ApprovalSink,
    /// The turn's shared cancel token; the gate suspends on it, dispatch checks it.
    pub cancel: &'a CancelToken,
}

/// The trace + promotions a serve collected from the bridge's tool calls
/// (ADR-0078 cross-runtime trace contract). The turn assembler (slice 9c)
/// merges this with the built-in loop's output shape verbatim.
pub struct GatewayOutcome {
    pub trace: Vec<TraceEntry>,
    pub promotions: Vec<Promotion>,
}

/// Accept one bridge connection, verify its token, and drive the MCP subset
/// (`initialize` / `tools/list` / `tools/call`) until the bridge disconnects
/// or the cancel token fires.
///
/// Blocks for the connection's lifetime. The caller spawns it on a scoped
/// thread and drives the ACP engine in parallel; the bridge's tool calls land
/// their trace + promotions in the returned [`GatewayOutcome`] for the turn
/// assembler to merge.
pub fn serve_connection(handle: GatewayHandle, mut ctx: GatewayCtx) -> io::Result<GatewayOutcome> {
    let GatewayHandle {
        token, listener, ..
    } = handle;
    let (stream, _peer) = listener.accept()?;
    let writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut writer = writer;

    verify_bridge(&mut reader, &mut writer, &token)?;

    let mut outcome = GatewayOutcome {
        trace: Vec::new(),
        promotions: Vec::new(),
    };
    loop {
        if ctx.cancel.is_requested() {
            return Ok(outcome);
        }
        let msg = match framing::read_message(&mut reader)? {
            Some(m) => m,
            None => return Ok(outcome), // bridge closed
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let response = handle_method(method, &msg, &mut ctx, &mut outcome);
        if let Some(id) = id {
            if let Some(envelope) = response.into_envelope(id) {
                framing::write_message(&mut writer, &envelope)?;
            }
        }
    }
}

/// Verify the bridge's auth line (`BRIDGE_AUTH <token>`). A mismatch is the
/// only error path -- the stream is dropped without a response so a probing
/// client learns nothing beyond "refused" (ADR-0085 security model).
fn verify_bridge(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    expected: &str,
) -> io::Result<()> {
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let got = line.trim_end_matches(['\r', '\n']);
    if got == format!("BRIDGE_AUTH {expected}") {
        writer.write_all(b"BRIDGE_OK\n")?;
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "bridge auth token mismatch",
        ))
    }
}

/// One MCP method's outcome: a result, an error envelope, or no response (a
/// notification the gateway acknowledges by silence).
enum Response {
    Result(Value),
    Error(i64, String),
    None,
}

impl Response {
    /// Wrap as a JSON-RPC 2.0 response envelope for the given id. Returns
    /// `None` for [`Response::None`] (a notification -- no id, no response).
    fn into_envelope(self, id: Value) -> Option<Value> {
        match self {
            Response::Result(result) => Some(json!({"jsonrpc": "2.0", "id": id, "result": result})),
            Response::Error(code, message) => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {"code": code, "message": message}
            })),
            Response::None => None,
        }
    }
}

/// Dispatch one MCP method.
fn handle_method(
    method: &str,
    msg: &Value,
    ctx: &mut GatewayCtx,
    outcome: &mut GatewayOutcome,
) -> Response {
    match method {
        "initialize" => Response::Result(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {
                "name": "toptopduck-gateway",
                "version": env!("CARGO_PKG_VERSION"),
            }
        })),
        "tools/list" => Response::Result(json!({
            "tools": builtin_table().iter().map(tool_to_mcp).collect::<Vec<_>>()
        })),
        "tools/call" => handle_tools_call(msg, ctx, outcome),
        // A notification (no id) -- no response. The caller's id-check
        // suppresses the envelope; this arm keeps the match exhaustive.
        _ if msg.get("id").is_none() => Response::None,
        _ => Response::Error(-32601, format!("method not found: {method}")),
    }
}

/// Map a built-in [`ToolDefinition`] to its MCP `tools/list` entry. The
/// app-side gateway owns the canonical schema (ADR-0076), so this is a field
/// rename (`input_schema` -> `inputSchema`); no schema transformation.
fn tool_to_mcp(def: &ToolDefinition) -> Value {
    json!({
        "name": def.name,
        "description": def.description,
        "inputSchema": def.input_schema,
    })
}

/// Drive one `tools/call` through the approval gate + dispatch, mirroring the
/// built-in loop's `execute_call`. A gate denial is a tool-level error the
/// agent self-corrects from (ADR-0077); a gate cancel ends the serve loop
/// (surfaced as a JSON-RPC error so the bridge does not hang on a reply).
fn handle_tools_call(msg: &Value, ctx: &mut GatewayCtx, outcome: &mut GatewayOutcome) -> Response {
    let params = msg.get("params").unwrap_or(&Value::Null);
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => return Response::Error(-32602, "tools/call missing 'name'".into()),
    };
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
    let call = ToolUse {
        // The model-facing id pairs a result with its request; the gateway
        // echoes the JSON-RPC id as the tool_use id so a debug trace can
        // correlate the two.
        id: msg.get("id").map(|v| v.to_string()).unwrap_or_default(),
        name,
        input: arguments,
    };
    let (key, operation_kind, summary) = classify_call(&call);
    let gate_req = ApprovalRequest {
        key,
        operation_kind,
        summary: summary.clone(),
    };
    match ctx.approval.gate(gate_req, ctx.sink, ctx.cancel) {
        Err(GateCancelled) => Response::Error(-32000, "turn cancelled".into()),
        Ok(GateOutcome::Denied) => {
            outcome.trace.push(TraceEntry {
                tool_use_id: call.id.clone(),
                name: call.name.clone(),
                operation_kind,
                summary,
                success: false,
                result_excerpt: "denied by approval gateway".to_string(),
            });
            Response::Result(json!({
                "content": [{"type": "text", "text": "tool call denied by the approval gateway"}],
                "isError": true,
            }))
        }
        Ok(GateOutcome::Allow) => {
            let result = dispatch(&call, &mut ctx.deps, ctx.cancel, ctx.materializer);
            if let Some(promotion) = result.promotion {
                outcome.promotions.push(promotion);
            }
            let success = !result.result.is_error;
            outcome.trace.push(TraceEntry {
                tool_use_id: call.id.clone(),
                name: call.name.clone(),
                operation_kind,
                summary,
                success,
                result_excerpt: truncate_trace_excerpt(&result.result.content, TRACE_EXCERPT_MAX),
            });
            Response::Result(json!({
                "content": [{"type": "text", "text": result.result.content}],
                "isError": result.result.is_error,
            }))
        }
    }
}

/// Generate a 256-bit auth token as 64 hex chars. Two uuid v4 values (each 128
/// bits of OS-CSPRNG randomness) concatenated; uuid is already a dependency
/// (session ids), so this adds none.
fn generate_token() -> String {
    let a = uuid::Uuid::new_v4().simple().to_string();
    let b = uuid::Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink};
    use crate::session::materializer::FakeMaterializer;
    use crate::workingset::WorkingSet;
    use duckdb::Connection;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::net::TcpStream;
    use std::path::PathBuf;
    use std::thread;
    use tempfile::TempDir;

    /// In-memory DuckDB + temp dir -- the same shape the agent-loop tests use.
    /// `handle_method`'s initialize / tools-list / unknown / notification paths
    /// do not touch DuckDB; the engine exists only to satisfy TurnDeps's borrows
    /// so the same scaffolding serves the serve-connection end-to-end case too.
    struct Engine {
        conn: Connection,
        temp: TempDir,
    }
    impl Engine {
        fn new() -> Self {
            Self {
                conn: Connection::open_in_memory().expect("in-memory db"),
                temp: TempDir::new().expect("temp dir"),
            }
        }
    }

    /// An ApprovalSink that records nothing -- the 9b test set never drives a
    /// tools/call through the gate, so the sink is never called. A recording
    /// sink joins when 9c wires the full Session::ask + approval-card path.
    struct NoopSink;
    impl ApprovalSink for NoopSink {
        fn emit_request(&self, _: &ApprovalRequestBody) {}
        fn emit_resolved(&self, _: &ApprovalRequestBody, _: ApprovalResponse) {}
    }

    /// Build a `GatewayCtx` over leak-boxed 'static resources so the handle_method
    /// cases (which ignore the engine anyway) stay terse. The end-to-end case
    /// reuses the same helper: its ctx moves into `serve_connection` and the
    /// process exits before the leak matters.
    fn fresh_ctx() -> GatewayCtx<'static> {
        let engine: &'static Engine = Box::leak(Box::new(Engine::new()));
        let ws: &'static mut WorkingSet = Box::leak(Box::new(WorkingSet::default()));
        let sources: &'static HashMap<String, PathBuf> = Box::leak(Box::new(HashMap::new()));
        let fake: &'static mut FakeMaterializer =
            Box::leak(Box::new(FakeMaterializer::new(vec![])));
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static NoopSink = Box::leak(Box::new(NoopSink));
        let cancel: &'static CancelToken = Box::leak(Box::new(CancelToken::new()));
        let deps = TurnDeps {
            conn: &engine.conn,
            source_files: sources,
            working_set: ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: engine.temp.path(),
        };
        GatewayCtx {
            deps,
            materializer: fake,
            approval,
            sink,
            cancel,
        }
    }

    // --- pure helpers ------------------------------------------------------

    #[test]
    fn bind_gateway_mints_port_and_64_hex_token() {
        let h = bind_gateway().expect("bind");
        assert!(h.port > 0, "OS assigns a real localhost port");
        assert_eq!(h.token.len(), 64, "256-bit token = 64 hex chars");
        assert!(
            h.token.chars().all(|c| c.is_ascii_hexdigit()),
            "token is lowercase hex"
        );
    }

    #[test]
    fn generate_token_is_64_lowercase_hex() {
        let t = generate_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn verify_bridge_accepts_correct_token_then_writes_ok() {
        let input = Cursor::new(b"BRIDGE_AUTH deadbeef\n".to_vec());
        let mut reader = std::io::BufReader::new(input);
        let mut writer = Vec::new();
        verify_bridge(&mut reader, &mut writer, "deadbeef").expect("accepted");
        assert_eq!(writer, b"BRIDGE_OK\n");
    }

    #[test]
    fn verify_bridge_rejects_wrong_token_with_permission_denied() {
        let input = Cursor::new(b"BRIDGE_AUTH wrong\n".to_vec());
        let mut reader = std::io::BufReader::new(input);
        let mut writer = Vec::new();
        let err = verify_bridge(&mut reader, &mut writer, "expected").expect_err("mismatch");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(writer.is_empty(), "no response on a refused handshake");
    }

    #[test]
    fn verify_bridge_treats_clean_eof_as_refused() {
        // A probing client that connects + closes without sending a token line
        // must not crash the gateway -- read_line returns Ok(0) and the empty
        // line falls through to the mismatch arm (PermissionDenied).
        let input = Cursor::new(Vec::new());
        let mut reader = std::io::BufReader::new(input);
        let mut writer = Vec::new();
        let err = verify_bridge(&mut reader, &mut writer, "x").expect_err("eof refused");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn response_into_envelope_wraps_result_error_and_skips_none() {
        let r = Response::Result(json!({"ok": true}));
        let env = r.into_envelope(json!(1)).expect("result envelope");
        assert_eq!(env["id"], 1);
        assert_eq!(env["result"]["ok"], true);

        let e = Response::Error(-32601, "nope".into());
        let env = e.into_envelope(json!(2)).expect("error envelope");
        assert_eq!(env["error"]["code"], -32601);
        assert_eq!(env["error"]["message"], "nope");

        let n = Response::None;
        assert!(
            n.into_envelope(Value::Null).is_none(),
            "a notification gets no envelope"
        );
    }

    #[test]
    fn tool_to_mcp_renames_input_schema_field() {
        let def = builtin_table().into_iter().next().expect("non-empty table");
        let mcp = tool_to_mcp(&def);
        assert_eq!(mcp["name"], Value::from(def.name.as_str()));
        assert!(mcp["description"].is_string());
        // MCP camelCase, not the Rust snake_case `input_schema` field name.
        assert!(mcp.get("inputSchema").is_some(), "renamed to inputSchema");
        assert!(
            mcp.get("input_schema").is_none(),
            "rust field name not leaked"
        );
    }

    // --- handle_method dispatch -------------------------------------------

    #[test]
    fn handle_method_initialize_advertises_gateway_server_info() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome {
            trace: Vec::new(),
            promotions: Vec::new(),
        };
        let msg = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"});
        match handle_method("initialize", &msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["serverInfo"]["name"], "toptopduck-gateway");
                assert!(v["protocolVersion"].is_string());
            }
            _ => panic!("initialize must return Result"),
        }
    }

    #[test]
    fn handle_method_tools_list_advertises_builtin_table() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome {
            trace: Vec::new(),
            promotions: Vec::new(),
        };
        let msg = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/list"});
        match handle_method("tools/list", &msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                let tools = v["tools"].as_array().expect("tools array");
                assert!(!tools.is_empty(), "built-in table is non-empty");
                assert!(tools.iter().all(|t| t["name"].is_string()));
            }
            _ => panic!("tools/list must return Result"),
        }
    }

    #[test]
    fn handle_method_unknown_returns_method_not_found() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome {
            trace: Vec::new(),
            promotions: Vec::new(),
        };
        let msg = json!({"jsonrpc": "2.0", "id": 3, "method": "frobnicate"});
        match handle_method("frobnicate", &msg, &mut ctx, &mut outcome) {
            Response::Error(code, m) => {
                assert_eq!(code, -32601);
                assert!(m.contains("frobnicate"));
            }
            _ => panic!("unknown method must return Error"),
        }
    }

    #[test]
    fn handle_method_notification_returns_none_no_envelope() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome {
            trace: Vec::new(),
            promotions: Vec::new(),
        };
        // No id -> a notification; the match arm returns Response::None, which
        // the caller's id-check drops without writing a response.
        let msg = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        let resp = handle_method("notifications/initialized", &msg, &mut ctx, &mut outcome);
        assert!(resp.into_envelope(Value::Null).is_none());
    }

    // --- serve_connection end-to-end -------------------------------------

    #[test]
    fn serve_connection_drives_initialize_and_tools_list_over_tcp() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let token = handle.token.clone();

        // A stand-in for the bridge: connect, handshake, fire initialize +
        // tools/list, then close. The gateway's serve loop returns on the close
        // (read_message -> None), so serve_connection rejoins without a cancel.
        let client = thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let mut r = std::io::BufReader::new(s.try_clone().expect("clone"));
            s.write_all(format!("BRIDGE_AUTH {token}\n").as_bytes())
                .expect("auth write");
            let mut line = String::new();
            r.read_line(&mut line).expect("ok line");
            assert_eq!(line, "BRIDGE_OK\n", "gateway accepts the minted token");

            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
            )
            .expect("send init");
            let init = framing::read_message(&mut r)
                .expect("read init")
                .expect("init resp");
            assert_eq!(init["id"], 1);
            assert_eq!(init["result"]["serverInfo"]["name"], "toptopduck-gateway");

            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            )
            .expect("send list");
            let list = framing::read_message(&mut r)
                .expect("read list")
                .expect("list resp");
            assert_eq!(list["id"], 2);
            assert!(!list["result"]["tools"]
                .as_array()
                .expect("tools")
                .is_empty());
            // `s` drops here -> gateway read EOF -> serve_connection returns.
        });

        let outcome = serve_connection(handle, ctx).expect("serve");

        client.join().expect("client thread panicked");
        assert!(
            outcome.trace.is_empty(),
            "no tools/call in this run -> empty trace"
        );
        assert!(
            outcome.promotions.is_empty(),
            "no materialize -> no promotion"
        );
    }
}
