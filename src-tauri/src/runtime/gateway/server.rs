//! The MCP gateway server the external runtime's bridge connects back to
//! (ADR-0085).
//!
//! [`bind_gateway`] binds a per-bridge listener on a random localhost port +
//! mints a 64-hex token (244-bit entropy); [`serve_connection`] then accepts one bridge,
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
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::approval::{ApprovalRequest, ApprovalSink, ApprovalState, GateCancelled, GateOutcome};
use crate::cancel::CancelToken;
use crate::mcp::aggregator::{self, McpAggregator};
use crate::model::Promotion;
use crate::provider::tool_calling::{ToolDefinition, ToolUse};
use crate::session::agent_loop::{
    classify_call, truncate_trace_excerpt, TraceEntry, TRACE_EXCERPT_MAX,
};
use crate::session::materializer::{Materializer, TurnDeps};
use crate::tools::{builtin_table, dispatch};

use super::framing;

/// A per-bridge-connection gateway endpoint: a bound listener, the OS-assigned
/// port, and the 64-hex token (244-bit entropy) a bridge must present on connect.
///
/// Built by [`bind_gateway`] and consumed by [`serve_connection`]. The listener
/// accepts exactly one bridge connection (ADR-0085 per-bridge lifecycle) --
/// [`serve_connection`] consumes it on the first accept, so a second connect
/// attempt finds no listener.
pub struct GatewayHandle {
    /// The OS-assigned localhost port. Inject into the bridge descriptor
    /// (`McpServer::stdio_bridge` env `TOPTOPDUCK_GATEWAY_PORT`) before the
    /// bridge is spawned.
    pub port: u16,
    /// The 64-hex token (244-bit entropy, two uuid v4). Inject into the bridge descriptor env
    /// `TOPTOPDUCK_GATEWAY_TOKEN`; the bridge presents it as its first TCP line
    /// for [`serve_connection`] to verify.
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
    /// The connected external MCP servers (slice C-gw). Owned (turn-local
    /// spawn), unlike the borrowed fields above; the caller constructs +
    /// drops it per turn. Empty when no servers are configured or the session
    /// wiring has not connected any yet.
    pub mcp: McpAggregator,
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
/// Max wall-clock wait for a bridge to connect after [`serve_connection`] starts
/// (ADR-0085 robustness). A blocking `accept` would hang the turn forever if the
/// bridge never connects -- the engine returns, but the gateway never sees EOF
/// -- so the accept is a non-blocking poll bounded by this deadline. The bridge
/// connects in well under a second in the happy path; 30s absorbs a slow CI
/// runner + process-spawn jitter without leaking a hung turn.
const CONNECT_DEADLINE: Duration = Duration::from_secs(30);

/// How long the non-blocking accept poll sleeps between cancel/deadline checks.
/// Short enough that a cancel surfaces in well under a second; long enough that
/// an idle wait costs near-zero CPU.
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// The accepted stream's read timeout. The serve loop checks cancel after each
/// read returns, so a blocking `read_line` would not notice cancel mid-message;
/// this bounds the cancel latency in the read loop to the same order as the
/// accept poll. A `TimedOut` / `WouldBlock` from `read_line` is retried -- the
/// partial line stays in the `BufReader`, so a slow multi-fragment frame still
/// completes.
const READ_TIMEOUT: Duration = Duration::from_millis(100);

pub fn serve_connection(handle: GatewayHandle, mut ctx: GatewayCtx) -> io::Result<GatewayOutcome> {
    let GatewayHandle {
        token, listener, ..
    } = handle;
    let (stream, _peer) = match accept_bridge(&listener, ctx.cancel, CONNECT_DEADLINE)? {
        // Cancel fired before any bridge connected: return the empty outcome so
        // the turn assembler's termination (single-source ACP) decides the
        // TurnOutcome (Cancelled), not a gateway serve error.
        None => {
            return Ok(GatewayOutcome {
                trace: Vec::new(),
                promotions: Vec::new(),
            });
        }
        Some(pair) => pair,
    };
    // The listener accepted exactly one bridge (ADR-0085 per-bridge lifecycle);
    // drop it to release the port + clear the kernel backlog.
    drop(listener);
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
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
        let msg = match framing::read_message(&mut reader) {
            Ok(Some(m)) => m,
            Ok(None) => return Ok(outcome), // bridge closed
            // Read timeout (READ_TIMEOUT): retry so the loop-top cancel check
            // fires. BufReader preserves any partial line across the timeout.
            Err(e)
                if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(e),
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

/// Poll the listener non-blocking until a bridge connects, cancel fires, or
/// `deadline` elapses. Returns `Ok(None)` on cancel (the serve returns an empty
/// outcome + the ACP termination decides the TurnOutcome), `Ok(Some)` on a
/// connection, and `Err(TimedOut)` on the deadline (a missing bridge is a real
/// failure -- the engine would otherwise wait on a serve that never progresses).
fn accept_bridge(
    listener: &TcpListener,
    cancel: &CancelToken,
    deadline: Duration,
) -> io::Result<Option<(std::net::TcpStream, std::net::SocketAddr)>> {
    listener.set_nonblocking(true)?;
    let stop = Instant::now() + deadline;
    loop {
        if cancel.is_requested() {
            return Ok(None);
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                // Restore blocking semantics on the accepted stream; the
                // listener itself is dropped after accept (one bridge only).
                stream.set_nonblocking(false)?;
                return Ok(Some((stream, peer)));
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                if Instant::now() >= stop {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "bridge did not connect within deadline",
                    ));
                }
                std::thread::sleep(ACCEPT_POLL_INTERVAL);
            }
            Err(e) => return Err(e),
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
            "protocolVersion": crate::mcp::MCP_PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {
                "name": "toptopduck-gateway",
                "version": env!("CARGO_PKG_VERSION"),
            }
        })),
        "tools/list" => {
            // Built-in DuckDB tools + namespaced external MCP tools (slice
            // C-gw): the bridge / LLM sees one merged table.
            let mut tools: Vec<Value> = builtin_table().iter().map(tool_to_mcp).collect();
            tools.extend(ctx.mcp.aggregated_tools());
            Response::Result(json!({ "tools": tools }))
        }
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
    // The gateway echoes the JSON-RPC id as the tool_use id so a debug trace
    // can correlate the two. Normalize to a stable string -- JSON-RPC 2.0 id
    // is string|number|null, and `Value::to_string()` would quote a string id
    // (`"abc"` -> `"\"abc\""`), corrupting the trace's tool_use_id. null /
    // missing / non-string-number map to "" (response-envelope correlation
    // uses the raw `Value` at the caller, so function is unaffected).
    let id = match msg.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };
    let call = ToolUse {
        id,
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
            // Route by name shape (slice C-gw): a namespaced
            // `mcp__<slug>__<tool>` name goes to the matching external server
            // (envelope relayed verbatim via [`external_call_outcome`]); a bare
            // name goes to the built-in executor (flat text wrapped into one
            // text block). The two paths build DIFFERENT response envelopes --
            // see [`external_call_outcome`] for why the external envelope is
            // relayed verbatim rather than re-wrapped.
            if aggregator::parse_namespaced(&call.name).is_some() {
                let route_result = ctx.mcp.route(&call.name, &call.input);
                let (envelope, is_error, excerpt) = external_call_outcome(&call.name, route_result);
                outcome.trace.push(TraceEntry {
                    tool_use_id: call.id.clone(),
                    name: call.name.clone(),
                    operation_kind,
                    summary,
                    success: !is_error,
                    result_excerpt: truncate_trace_excerpt(&excerpt, TRACE_EXCERPT_MAX),
                });
                return Response::Result(envelope);
            }
            let dispatched = dispatch(&call, &mut ctx.deps, ctx.cancel, ctx.materializer);
            if let Some(promotion) = dispatched.promotion {
                outcome.promotions.push(promotion);
            }
            let is_error = dispatched.result.is_error;
            outcome.trace.push(TraceEntry {
                tool_use_id: call.id.clone(),
                name: call.name.clone(),
                operation_kind,
                summary,
                success: !is_error,
                result_excerpt: truncate_trace_excerpt(
                    &dispatched.result.content,
                    TRACE_EXCERPT_MAX,
                ),
            });
            Response::Result(json!({
                "content": [{"type": "text", "text": dispatched.result.content}],
                "isError": is_error,
            }))
        }
    }
}

/// Extract the first text block from a standard MCP tools/call envelope for
/// the turn trace. The gateway relays the full envelope verbatim (structured
/// content blocks preserved for the model); the trace excerpt is a flat
/// summary, so a non-text or empty result falls back to a placeholder rather
/// than serializing the whole envelope (which would re-introduce the
/// double-encoding the verbatim relay avoids).
fn mcp_text_excerpt(envelope: &Value) -> String {
    envelope
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|b| {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    b.get("text").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| "<non-text MCP result>".to_string())
}

/// Resolve a routed external MCP call into the response envelope + the trace
/// inputs (slice C-gw). Pure over the aggregator: takes the route result so
/// the verbatim-relay + excerpt shape is unit-testable without a live server.
///
/// On success the server's envelope is returned VERBATIM -- the server's own
/// `{content, isError}` shape, so structured content blocks (multi-block /
/// non-text) survive. Re-wrapping it into a single text block would
/// double-encode the content array and drop every non-text block the server
/// emitted. On a route error the gateway builds an `isError` envelope naming
/// the tool so the agent can self-correct (ADR-0077). Returns
/// `(envelope, is_error, excerpt)` so the caller pushes one trace row and
/// returns the envelope.
fn external_call_outcome(
    name: &str,
    route_result: Result<Value, aggregator::RouteError>,
) -> (Value, bool, String) {
    let envelope = route_result.unwrap_or_else(|e| {
        json!({
            "content": [{
                "type": "text",
                "text": format!("external tool `{name}` failed: {e}"),
            }],
            "isError": true,
        })
    });
    let is_error = envelope
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let excerpt = mcp_text_excerpt(&envelope);
    (envelope, is_error, excerpt)
}

/// Generate a 64-hex auth token (244-bit entropy). Two uuid v4 values (122
/// random bits each -- v4 carries 6 fixed version/variant bits) concatenated;
/// uuid is already a dependency (session ids), so this adds none.
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
            mcp: McpAggregator::default(),
        }
    }

    // --- pure helpers ------------------------------------------------------

    #[test]
    fn bind_gateway_mints_port_and_64_hex_token() {
        let h = bind_gateway().expect("bind");
        assert!(h.port > 0, "OS assigns a real localhost port");
        assert_eq!(h.token.len(), 64, "244-bit entropy in 64 hex chars");
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

    // --- accept_bridge (connect deadline + cancel) -----------------------

    /// With no bridge connecting, accept_bridge returns `Err(TimedOut)` within
    /// ~deadline (not an infinite hang). Uses a short deadline so the test is
    /// fast; production uses [`CONNECT_DEADLINE`].
    #[test]
    fn accept_bridge_times_out_when_no_bridge_connects() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let cancel = CancelToken::new();
        let start = Instant::now();
        let err = accept_bridge(&listener, &cancel, Duration::from_millis(200))
            .expect_err("deadline -> Err");
        let elapsed = start.elapsed();
        assert!(
            elapsed >= Duration::from_millis(180),
            "waited near the deadline: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "did not hang past the deadline: {elapsed:?}"
        );
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
    }

    /// A pre-fired cancel returns `Ok(None)` promptly (no wait), so the serve
    /// returns an empty outcome + the ACP termination decides the TurnOutcome.
    #[test]
    fn accept_bridge_returns_none_when_cancelled() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let cancel = CancelToken::new();
        cancel.request();
        let start = Instant::now();
        let result = accept_bridge(&listener, &cancel, Duration::from_secs(30))
            .expect("cancel is Ok(None), not Err");
        assert!(result.is_none(), "cancel before connect -> None");
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "cancel returns promptly: {:?}",
            start.elapsed()
        );
    }

    // --- handle_tools_call ---------------------------------------------

    /// The allow-path: a builtin tool (`explore`) classifies Allow (ADR-0080
    /// Decision 1), the gate never emits, dispatch runs `SELECT 1`, and the
    /// outcome carries one trace row + no promotion. Asserts the
    /// classify -> gate -> dispatch -> trace mirror of `execute_call`
    /// end-to-end -- the gap called out in the PR #339 review (I2).
    #[test]
    fn handle_tools_call_allow_path_runs_builtin_through_dispatch() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome {
            trace: Vec::new(),
            promotions: Vec::new(),
        };
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "explore", "arguments": {"sql": "SELECT 1 AS x"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false, "explore SELECT 1 succeeds");
                assert!(v["content"].is_array(), "explore returns a content array");
            }
            Response::Error(code, m) => {
                panic!("allow-path must return Result, got error {code}: {m}")
            }
            Response::None => panic!("allow-path must return Result, got None"),
        }
        assert_eq!(outcome.trace.len(), 1, "one tool call -> one trace row");
        let row = &outcome.trace[0];
        assert_eq!(row.name, "explore");
        assert!(row.success, "dispatch succeeded");
        assert_eq!(
            row.tool_use_id, "1",
            "numeric JSON-RPC id normalizes to \"1\""
        );
        assert_eq!(row.summary, "SELECT 1 AS x", "summary is the sql field");
        assert!(
            outcome.promotions.is_empty(),
            "explore produces no promotion"
        );
    }

    /// Missing `params.name` is a JSON-RPC params error (-32602), not a dispatch.
    #[test]
    fn handle_tools_call_missing_name_returns_params_error() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome {
            trace: Vec::new(),
            promotions: Vec::new(),
        };
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"arguments": {}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Error(code, m) => {
                assert_eq!(code, -32602);
                assert!(m.contains("name"), "error names the missing field");
            }
            _ => panic!("missing name must return Error"),
        }
        assert!(outcome.trace.is_empty(), "no dispatch -> no trace");
    }

    /// A string JSON-RPC id round-trips into the trace without serde quoting
    /// (PR #339 review A1: `Value::to_string()` would have wrapped it in
    /// literal quotes).
    #[test]
    fn handle_tools_call_string_id_not_double_quoted() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome {
            trace: Vec::new(),
            promotions: Vec::new(),
        };
        let msg = json!({
            "jsonrpc": "2.0",
            "id": "req-abc",
            "method": "tools/call",
            "params": {"name": "explore", "arguments": {"sql": "SELECT 1"}}
        });
        handle_tools_call(&msg, &mut ctx, &mut outcome);
        assert_eq!(
            outcome.trace[0].tool_use_id, "req-abc",
            "string id must not carry stray quotes"
        );
    }

    /// The trace excerpt reads the first text block from a relayed MCP
    /// envelope; a non-text or empty result falls back to a placeholder so
    /// the trace never re-serializes the whole envelope (the double-encoding
    /// the verbatim relay avoids). Pins the helper the external-route path
    /// in `handle_tools_call` relies on for its trace entry.
    #[test]
    fn mcp_text_excerpt_reads_first_text_block() {
        // Single text block -> that text.
        let single = json!({
            "content": [{"type": "text", "text": "5"}],
            "isError": false,
        });
        assert_eq!(mcp_text_excerpt(&single), "5");

        // Multiple blocks -> first text block wins (a leading image is
        // skipped).
        let multi = json!({
            "content": [
                {"type": "image", "data": "..."},
                {"type": "text", "text": "first text"},
                {"type": "text", "text": "second text"},
            ],
            "isError": false,
        });
        assert_eq!(mcp_text_excerpt(&multi), "first text");

        // No text block -> placeholder, NOT a JSON dump of the envelope.
        let nontext = json!({
            "content": [{"type": "image", "data": "..."}],
            "isError": false,
        });
        assert_eq!(mcp_text_excerpt(&nontext), "<non-text MCP result>");

        // Empty content array -> placeholder.
        let empty = json!({"content": [], "isError": false});
        assert_eq!(mcp_text_excerpt(&empty), "<non-text MCP result>");
    }

    // --- external_call_outcome (I1: verbatim-relay + excerpt contract) -----

    /// A successful route relays the server's envelope VERBATIM -- the content
    /// array + isError flag survive untouched, not re-wrapped into a text
    /// block (which would double-encode). The excerpt is the first text block.
    /// Pins the contract `handle_tools_call`'s external arm relies on.
    #[test]
    fn external_call_outcome_relays_envelope_verbatim_on_success() {
        let envelope = json!({
            "content": [{"type": "text", "text": "5"}],
            "isError": false,
        });
        let (out, is_error, excerpt) =
            external_call_outcome("mcp__fakemcp__add", Ok(envelope.clone()));
        assert_eq!(out, envelope, "envelope relayed verbatim, not re-wrapped");
        assert!(!is_error);
        assert_eq!(excerpt, "5");
    }

    /// A multi-block envelope (image + text) is relayed verbatim; the excerpt
    /// is the first TEXT block -- the leading image is skipped, not serialized
    /// into the excerpt.
    #[test]
    fn external_call_outcome_preserves_non_text_blocks_and_excerpts_first_text() {
        let envelope = json!({
            "content": [
                {"type": "image", "data": "..."},
                {"type": "text", "text": "first text"},
                {"type": "text", "text": "second text"},
            ],
            "isError": false,
        });
        let (out, is_error, excerpt) =
            external_call_outcome("mcp__fakemcp__tool", Ok(envelope.clone()));
        assert_eq!(out, envelope, "multi-block envelope relayed verbatim");
        assert!(!is_error);
        assert_eq!(excerpt, "first text");
    }

    /// A server-reported `isError` envelope is relayed verbatim (the gateway
    /// does not mask the server's error); `is_error` tracks the flag so the
    /// trace row records the failure.
    #[test]
    fn external_call_outcome_propagates_the_is_error_flag() {
        let envelope = json!({
            "content": [{"type": "text", "text": "tool blew up"}],
            "isError": true,
        });
        let (out, is_error, excerpt) =
            external_call_outcome("mcp__fakemcp__tool", Ok(envelope.clone()));
        assert_eq!(out, envelope);
        assert!(is_error);
        assert_eq!(excerpt, "tool blew up");
    }

    /// A route error (unknown slug / client fault) builds an `isError` envelope
    /// naming the tool so the agent can self-correct (ADR-0077); `is_error` is
    /// true and the excerpt carries the failure text.
    #[test]
    fn external_call_outcome_builds_an_error_envelope_on_route_failure() {
        let (out, is_error, excerpt) = external_call_outcome(
            "mcp__ghost__echo",
            Err(aggregator::RouteError::UnknownServer("ghost".into())),
        );
        assert!(is_error);
        assert_eq!(out["isError"], true);
        let text = out["content"][0]["text"]
            .as_str()
            .expect("error envelope has a text block");
        assert!(
            text.contains("mcp__ghost__echo"),
            "error names the tool: {text}"
        );
        assert!(
            text.contains("ghost"),
            "error carries the route failure: {text}"
        );
        assert_eq!(excerpt, text, "excerpt is the error text");
    }
}
