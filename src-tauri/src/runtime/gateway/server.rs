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
//! `tools/list` advertises the built-in DuckDB tool table, the enabled CLI
//! registrations direct-listed with the same names + schemas the built-in
//! runtime's table carries (issue #673, ADR-0108 Decision 6 single tool
//! plane), plus, when external servers connected this turn, the fixed
//! meta-tool discovery trio (`mcp_list_servers` / `mcp_search_tools` /
//! `mcp_invoke`, ADR-0105) -- external tools surface by handle through
//! discovery, not one-by-one. `tools/call` routes through the approval gate +
//! [`crate::tools::dispatch`] or the shared CLI spawn engine, mirroring the
//! built-in agent loop's `execute_call` -- built-in tools classify `Allow`
//! (zero approval, ADR-0080 Decision 1), unknown names fall through to the
//! external arm and surface the gate's pending card.

use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::approval::{
    ApprovalRequest, ApprovalSink, ApprovalState, GateCancelled, GateOutcome, OperationKind,
};
use crate::bounded_line::{read_line_bounded, LineRead, LINE_MAX_BYTES};
use crate::cancel::CancelToken;
use crate::mcp::aggregator::{self, McpAggregator};
use crate::mcp::meta_tools;
use crate::model::Promotion;
use crate::provider::tool_calling::{ToolDefinition, ToolResult, ToolUse};
use crate::session::agent_loop::{
    classify_with_cli_tool, truncate_trace_excerpt, ResolvedClassification, TraceEntry,
    TRACE_EXCERPT_MAX,
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
    /// The enabled CLI registrations (issue #673, ADR-0108 Decision 6):
    /// borrowed from the turn inputs -- the same slice the built-in loop
    /// reads, so the plane the bridge advertises, classifies, and the trace
    /// merge de-duplicates against is one object by construction. Turn-local
    /// like `mcp` (the serve runs on the session thread), and never a second
    /// read of the config store.
    pub cli: &'a [crate::cli_tools::config::CliToolConfig],
}

/// The trace + promotions a serve collected from the bridge's tool calls
/// (ADR-0078 cross-runtime trace contract). The turn assembler (slice 9c)
/// merges this with the built-in loop's output shape verbatim.
#[derive(Debug, Default)]
pub struct GatewayOutcome {
    pub trace: Vec<TraceEntry>,
    pub promotions: Vec<Promotion>,
}

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
/// read returns, so a blocking read would not notice cancel mid-message; this
/// bounds the cancel latency in the read loop to the same order as the accept
/// poll. A `TimedOut` / `WouldBlock` is retried. Since the bounded reader
/// replaced `read_line` (issue #643) a timeout mid-line is not a resumable
/// pause: bytes already pulled past the `BufReader` are lost, and the retry
/// resumes at the stream's current position -- a frame split by a pause longer
/// than this timeout is re-framed from that point. Both real senders (the
/// bridge proxy, streaming fixtures) write frames continuously, so the window
/// is theoretical; the byte cap itself still holds for any single unbroken
/// read.
const READ_TIMEOUT: Duration = Duration::from_millis(100);

/// Accept one bridge connection, verify its token, and drive the MCP subset
/// (`initialize` / `tools/list` / `tools/call`) until the bridge disconnects
/// (read EOF), the cancel token fires, OR the engine-completion flag
/// (`engine_done`) is set.
///
/// `engine_done` is the deterministic terminator: the caller sets it when the
/// ACP engine's prompt pump returns. The pump returning means the CLI sent its
/// final `session/prompt` response, so every `tools/call` it sent was already
/// served synchronously (the CLI blocks on each tools/call reply before sending
/// the next message) -- serve has no in-flight request to drop, so returning on
/// the flag is safe. This removes the implicit dependency on the bridge closing
/// the TCP connection to terminate the serve loop (ADR-0085 serve-termination
/// consequence): the bridge is spawned by the external CLI, so whether its stdin
/// write-end closes promptly depends on the spawner, not on this process.
///
/// Rot-risk: this premise holds for ACP v1's request/response ordering. If a
/// future protocol revision allows pipelining (sending the next message before
/// the prior response) or adds cancellation notifications, this early return
/// could drop an in-flight tools/call -- re-evaluate then.
///
/// Blocks for the connection's lifetime. The caller spawns it on a scoped
/// thread and drives the ACP engine in parallel; the bridge's tool calls land
/// their trace + promotions in the returned [`GatewayOutcome`] for the turn
/// assembler to merge.
pub fn serve_connection(
    handle: GatewayHandle,
    mut ctx: GatewayCtx,
    engine_done: &AtomicBool,
) -> io::Result<GatewayOutcome> {
    let GatewayHandle {
        token, listener, ..
    } = handle;
    let (stream, _peer) = match accept_bridge(&listener, ctx.cancel, CONNECT_DEADLINE)? {
        // Cancel fired before any bridge connected: return the empty outcome so
        // the turn assembler's termination (single-source ACP) decides the
        // TurnOutcome (Cancelled), not a gateway serve error.
        None => return Ok(GatewayOutcome::default()),
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

    let mut outcome = GatewayOutcome::default();
    loop {
        if ctx.cancel.is_requested() {
            return Ok(outcome);
        }
        // Engine-completion signal (ADR-0085 serve-termination consequence):
        // the prompt pump returned -> the CLI sent its final session/prompt
        // response -> every tools/call it sent was already served
        // synchronously, so no in-flight request is dropped by returning now.
        // This is what unblocks the serve when the bridge keeps the TCP
        // connection open (e.g. a stdio-spawn fd leak on Linux); the loop-top
        // check fires within one READ_TIMEOUT of the flag being set.
        if engine_done.load(Ordering::SeqCst) {
            return Ok(outcome);
        }
        let msg = match framing::read_message(&mut reader) {
            Ok(Some(m)) => m,
            Ok(None) => {
                return Ok(outcome);
            } // bridge closed
            // Read timeout (READ_TIMEOUT): retry so the loop-top cancel check
            // fires. A partial line already pulled past the BufReader is lost
            // on this path (see READ_TIMEOUT's doc) -- the retried read
            // resumes at the stream's current position, mid-line.
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
///
/// The auth line is read through the shared byte cap (issue #643): this read
/// happens BEFORE the token check, so the peer is an unauthenticated prober
/// that grabbed the connection -- the pre-auth surface. An over-long line,
/// like a clean EOF, falls into the mismatch arm (empty vs expected), so it
/// fails with the same `PermissionDenied` and no observable difference.
fn verify_bridge(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    expected: &str,
) -> io::Result<()> {
    let line = match read_line_bounded(reader, LINE_MAX_BYTES)? {
        LineRead::Line(line) => line,
        // An over-long or EOF-terminated empty "line" can never match the
        // expected auth line -- refuse it exactly like a token mismatch.
        LineRead::Overlong | LineRead::Eof => String::new(),
    };
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
            // Built-in DuckDB tools stay direct-listed; the enabled CLI
            // registrations are direct-listed the same way (issue #673,
            // ADR-0108 Decision 6 -- the bridge surface mirrors the built-in
            // runtime's table, names + schemas verbatim); the external MCP
            // surface is the fixed meta-tool trio (ADR-0105), attached only
            // when a server connected this turn. The bridge / LLM never sees
            // a per-tool flattened advertisement.
            let mut tools: Vec<Value> = builtin_table().iter().map(tool_to_mcp).collect();
            tools.extend(
                crate::cli_tools::config::tool_definitions(ctx.cli)
                    .iter()
                    .map(tool_to_mcp),
            );
            tools.extend(ctx.mcp.meta_tool_definitions().iter().map(tool_to_mcp));
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
///
/// The meta-tool trio dispatches FIRST (ADR-0105): `mcp_list_servers` /
/// `mcp_search_tools` run locally against the aggregator's catalog (read-only,
/// short of the gate -- the same trust shape as the built-in read tools);
/// `mcp_invoke` resolves its handle BEFORE the enforcement points so the
/// gate / trace keep consuming the backend tool identity, and a resolution
/// failure is the call's own failure (no gate suspension, no trace entry --
/// the same semantics as a call that never reached a tool). A namespaced
/// handle emitted directly as a tool name is refused the same way: the trio
/// is the one addressing surface.
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
    // The shared dispatch classification (issue #663 review): the trio match,
    // the parse-first invoke resolution, and the direct-handle refusal all
    // live in `meta_tools::resolve_meta_call` -- this site maps each variant
    // onto the gateway envelope. `Resolved` is an owned replacement call that
    // outlives the match through `resolved`; `Fallthrough` borrows the
    // original; both take the shared classify -> gate -> dispatch path below.
    let resolved;
    let call: &ToolUse = match meta_tools::resolve_meta_call(&ctx.mcp, &call) {
        meta_tools::MetaDispatch::Local { summary, payload } => {
            return local_meta_result(&call, &summary, payload, outcome);
        }
        meta_tools::MetaDispatch::Refused(message) => return resolution_failure(message),
        meta_tools::MetaDispatch::Resolved(replacement) => {
            resolved = replacement;
            &resolved
        }
        meta_tools::MetaDispatch::Fallthrough(call) => call,
    };
    // The gate consumes the RESOLVED identity (ADR-0105 Decision 4), so an
    // approval card names the backend server + handle, never "mcp_invoke".
    // A registered CLI tool classifies under its own reserved server
    // (issue #673, ADR-0108 Decision 7) -- the trust key is the registration
    // name, the badge is Execute, and the summary renders the full argv +
    // file values the approval card shows, identically to a
    // built-in-loop-initiated call. The shared helper keeps the trust key
    // and card identical to `execute_call`'s (one trust axis, two callers).
    let ResolvedClassification {
        key,
        operation_kind,
        summary,
        file_attachments,
        cli_tool,
    } = classify_with_cli_tool(ctx.cli, call, ctx.deps.temp_path);
    let gate_req = ApprovalRequest {
        key,
        operation_kind,
        summary: summary.clone(),
        file_attachments,
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
            // Route by name shape (ADR-0076 gateway routing + ADR-0105
            // Decision 4 + ADR-0108 Decision 6): a namespaced name (an
            // `mcp_invoke` fall-through) routes to the external server and
            // the server's envelope is relayed VERBATIM via
            // [`external_call_outcome`]; a registered CLI tool's name routes
            // to the shared spawn engine; anything else is a built-in
            // dispatch whose promotion rides the side-effect channel. Either
            // way exactly one trace row lands, naming the call's final
            // identity.
            // NOTE: the namespaced check here re-reads `call.name` rather
            // than hoisting one `is_external` above the trio match -- the
            // `mcp_invoke` fall-through REPLACES the name with the resolved
            // handle between the two sites, so the guard above judges the
            // EMITTED name while this judges the final identity (a hoisted
            // bool would be stale for exactly the invoke path).
            let (response, is_error, excerpt) = if aggregator::is_namespaced(&call.name) {
                let route_result = ctx.mcp.route(&call.name, &call.input);
                let (envelope, is_error, excerpt) = external_call_outcome(&call.name, route_result);
                (Response::Result(envelope), is_error, excerpt)
            } else if let Some(tool) = cli_tool {
                // The registered-CLI dispatch arm (issue #673, ADR-0108
                // Decision 6): the same spawn engine, cwd, cancel, and
                // output-cap discipline a built-in-initiated call gets -- one
                // execution engine, two callers. CLI tools never promote, so
                // no side-effect channel rides here.
                let executed =
                    crate::cli_tools::executor::execute(tool, call, ctx.deps.temp_path, ctx.cancel);
                result_envelope(executed.result)
            } else {
                let dispatched = dispatch(call, &mut ctx.deps, ctx.cancel, ctx.materializer);
                if let Some(promotion) = dispatched.promotion {
                    outcome.promotions.push(promotion);
                }
                result_envelope(dispatched.result)
            };
            outcome.trace.push(TraceEntry {
                tool_use_id: call.id.clone(),
                name: call.name.clone(),
                operation_kind,
                summary,
                success: !is_error,
                result_excerpt: truncate_trace_excerpt(&excerpt, TRACE_EXCERPT_MAX),
            });
            response
        }
    }
}

/// Serve one locally-executed meta-tool (`mcp_list_servers` /
/// `mcp_search_tools`): wrap the catalog payload as a success tool result +
/// record a trace entry. These never touch a backend server, so there is no
/// gate suspension (catalog reads carry the built-in read tools' trust
/// shape) and no envelope relay -- the payload is the gateway's own JSON.
fn local_meta_result(
    call: &ToolUse,
    summary: &str,
    payload: Value,
    outcome: &mut GatewayOutcome,
) -> Response {
    let excerpt = payload.to_string();
    outcome.trace.push(TraceEntry {
        tool_use_id: call.id.clone(),
        name: call.name.clone(),
        operation_kind: OperationKind::Read,
        summary: summary.to_string(),
        success: true,
        result_excerpt: truncate_trace_excerpt(&excerpt, TRACE_EXCERPT_MAX),
    });
    Response::Result(json!({
        "content": [{"type": "text", "text": excerpt}],
        "isError": false,
    }))
}

/// An addressing failure on the discovery surface (a malformed meta-tool
/// input, an unresolvable `mcp_invoke` handle, or a handle emitted directly
/// as a tool name): the call's own error result, surfaced as a tool-level
/// failure the agent self-corrects from (ADR-0077/0105). No gate suspension
/// and NO trace entry -- the call never reached a tool.
fn resolution_failure(message: String) -> Response {
    Response::Result(json!({
        "content": [{"type": "text", "text": message}],
        "isError": true,
    }))
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
/// One dispatched call's [`ToolResult`] → (bridge envelope, is_error,
/// excerpt): the shared tail of the CLI-spawn and builtin-dispatch arms.
/// The excerpt truncates via borrow BEFORE the move into the envelope -- a
/// full-content clone would double peak memory per call (issue #663
/// review); the trace-side re-truncation in the caller's push is
/// idempotent on the truncated string.
fn result_envelope(result: ToolResult) -> (Response, bool, String) {
    let is_error = result.is_error;
    let excerpt = truncate_trace_excerpt(&result.content, TRACE_EXCERPT_MAX);
    (
        Response::Result(json!({
            "content": [{"type": "text", "text": result.content}],
            "isError": is_error,
        })),
        is_error,
        excerpt,
    )
}

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
    let excerpt = aggregator::first_text_block(&envelope);
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
    use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink, ToolKey};
    use crate::provider::keychain::KeychainStore;
    use crate::session::engine::AdminEngine;
    use crate::session::materializer::FakeMaterializer;
    use crate::workingset::WorkingSet;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Cursor, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;
    use tempfile::TempDir;

    /// In-memory DuckDB + temp dir -- the same shape the agent-loop tests use.
    /// `handle_method`'s initialize / tools-list / unknown / notification paths
    /// do not touch DuckDB; the engine exists only to satisfy TurnDeps's borrows
    /// so the same scaffolding serves the serve-connection end-to-end case too.
    struct Engine {
        admin_engine: AdminEngine,
        temp: TempDir,
    }
    impl Engine {
        fn new() -> Self {
            Self {
                admin_engine: AdminEngine::materialized(),
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
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static NoopSink = Box::leak(Box::new(NoopSink));
        gate_ctx(Vec::new(), approval, sink)
    }

    /// The CLI-registration test variant of [`fresh_ctx`]: a caller-chosen
    /// registry + gate. The gate-driven cases need a reachable `ApprovalState`
    /// (to seed trust) and a sink the assertions can read, which the all-leak
    /// defaults of `fresh_ctx` hide.
    fn gate_ctx(
        cli: Vec<crate::cli_tools::config::CliToolConfig>,
        approval: &'static ApprovalState,
        sink: &'static dyn ApprovalSink,
    ) -> GatewayCtx<'static> {
        let cli: &'static [crate::cli_tools::config::CliToolConfig] =
            Box::leak(cli.into_boxed_slice());
        let engine: &'static Engine = Box::leak(Box::new(Engine::new()));
        let ws: &'static mut WorkingSet = Box::leak(Box::new(WorkingSet::default()));
        let sources: &'static mut HashMap<String, PathBuf> = Box::leak(Box::new(HashMap::new()));
        let refs: &'static mut HashMap<String, crate::session::materializer::CachedDerivedRef> =
            Box::leak(Box::new(HashMap::new()));
        let fake: &'static mut FakeMaterializer =
            Box::leak(Box::new(FakeMaterializer::new(vec![])));
        let cancel: &'static CancelToken = Box::leak(Box::new(CancelToken::new()));
        let deps = TurnDeps::test_deps(&engine.admin_engine, ws, sources, engine.temp.path(), refs);
        GatewayCtx {
            deps,
            materializer: fake,
            approval,
            sink,
            cancel,
            mcp: McpAggregator::default(),
            cli,
        }
    }

    /// A minimal in-process HTTP MCP server for the wire-level pins (issue
    /// #661): binds a localhost port and answers `initialize` / `tools/list`
    /// / `tools/call` POSTs with plain JSON bodies. The stdio fake-server
    /// fixture is unreachable from lib unit tests (`CARGO_BIN_EXE_*` is set
    /// for integration tests only), so this stands in for the route target.
    /// One accept thread, one request per connection; `Drop` stops the loop.
    /// The `add` tool advertises a NON-TRIVIAL inputSchema (the
    /// verbatim-schema pins need one distinguishable from the degraded empty
    /// object) and answers `a + b`; `fail` answers an `isError: true`
    /// envelope (the wire-level error-relay fixture).
    struct LiveMcpServer {
        port: u16,
        shutdown: Arc<std::sync::atomic::AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl LiveMcpServer {
        fn spawn() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            let port = listener.local_addr().expect("addr").port();
            listener.set_nonblocking(true).expect("nonblocking");
            let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag = Arc::clone(&shutdown);
            let handle = thread::spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => serve_one_rpc(stream),
                        Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                port,
                shutdown,
                handle: Some(handle),
            }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
    }

    impl Drop for LiveMcpServer {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::SeqCst);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    /// Serve one HTTP request: read the request line + headers (for
    /// content-length), read the body, answer the JSON-RPC method, close.
    /// A notification (no id) gets a bare 202, the same contract the
    /// integration fake uses.
    fn serve_one_rpc(mut stream: TcpStream) {
        // Every early return below eprintln!s its failure (issue #663
        // review): the fixture answers transport faults with an empty 202,
        // which would otherwise surface later as an unrelated rmcp timeout
        // -- the exact "confusing failure" mode `live_ctx` avoids at connect.
        let read_half = match stream.try_clone() {
            Ok(s) => s,
            Err(e) => {
                eprintln!("serve_one_rpc: stream clone failed: {e}");
                return;
            }
        };
        let mut reader = BufReader::new(read_half);
        let mut request_line = String::new();
        if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
            eprintln!("serve_one_rpc: connection closed before a request line");
            return;
        }
        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 {
                eprintln!("serve_one_rpc: connection closed mid-headers");
                return;
            }
            if header.trim().is_empty() {
                break;
            }
            if let Some(rest) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                content_length = rest.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0u8; content_length];
        if content_length > 0 && reader.read_exact(&mut body).is_err() {
            eprintln!("serve_one_rpc: short body read ({content_length} declared)");
            return;
        }
        let resp = match serde_json::from_slice::<Value>(&body) {
            Ok(req) => rpc_answer(&req),
            Err(e) => {
                eprintln!("serve_one_rpc: body parse failed: {e}");
                Value::Null
            }
        };
        if resp.is_null() {
            let _ = stream.write_all(
                b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        let body = resp.to_string();
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body.as_bytes());
        let _ = stream.flush();
    }

    /// The JSON-RPC answer builder: `add` sums a+b, `fail` reports the
    /// intentional `isError: true` envelope, and `tools/list` carries the
    /// non-trivial schema.
    fn rpc_answer(req: &Value) -> Value {
        let id = req.get("id").cloned();
        if id.is_none() {
            return Value::Null;
        }
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "initialize" => json!({
                "protocolVersion": crate::mcp::MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "serverInfo": {"name": "live-test-mcp", "version": "0.0.0"}
            }),
            "tools/list" => json!({"tools": [
                {"name": "add", "description": "sum a and b",
                 "inputSchema": {"type": "object",
                                 "properties": {"a": {"type": "integer"}, "b": {"type": "integer"}},
                                 "required": ["a", "b"]}},
                {"name": "fail", "description": "always fails",
                 "inputSchema": {"type": "object"}},
            ]}),
            "tools/call" => {
                let params = req.get("params").cloned().unwrap_or(Value::Null);
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                match name {
                    "add" => {
                        let a = params["arguments"]["a"].as_i64().unwrap_or(0);
                        let b = params["arguments"]["b"].as_i64().unwrap_or(0);
                        json!({"content": [{"type": "text", "text": format!("{}", a + b)}],
                               "isError": false})
                    }
                    _ => json!({"content": [{"type": "text",
                                "text": "boom: intentional failure fixture"}],
                               "isError": true}),
                }
            }
            _ => return Value::Null,
        };
        json!({"jsonrpc": "2.0", "id": id, "result": result})
    }

    /// An HTTP `McpServerConfig` pointing at a [`LiveMcpServer`].
    fn live_config(url: &str) -> crate::mcp::config::McpServerConfig {
        crate::mcp::config::McpServerConfig {
            id: crate::mcp::config::McpServerId("live-srv".into()),
            display_name: "LiveMCP".into(),
            transport: crate::mcp::config::McpTransport::Http {
                url: url.to_string(),
            },
            env: std::collections::BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        }
    }

    /// A fresh ctx whose aggregator has CONNECTED to the live fixture, with
    /// the connect outcome asserted up front -- a loopback blip would
    /// otherwise surface later as a confusing "unknown slug" resolution
    /// failure instead of the transport error that caused it.
    fn live_ctx(server: &LiveMcpServer) -> GatewayCtx<'static> {
        let mut ctx = fresh_ctx();
        let results = ctx
            .mcp
            .connect_all(&[live_config(&server.url())], &KeychainStore::new());
        assert!(
            results.iter().all(|r| r.connected),
            "fixture server must connect (a transport failure here is a test-env \
             loopback issue, not a gateway defect): {results:?}"
        );
        ctx
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
        // must not crash the gateway -- the bounded read reports EOF and the
        // empty line falls through to the mismatch arm (PermissionDenied).
        let input = Cursor::new(Vec::new());
        let mut reader = std::io::BufReader::new(input);
        let mut writer = Vec::new();
        let err = verify_bridge(&mut reader, &mut writer, "x").expect_err("eof refused");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    /// Issue #643: the pre-auth surface. An over-long auth line is refused
    /// with the same `PermissionDenied` as a token mismatch (no observable
    /// difference for a prober) instead of growing the buffer with the line.
    #[test]
    fn verify_bridge_refuses_an_overlong_auth_line() {
        let wire = format!("{}\n", "x".repeat(LINE_MAX_BYTES));
        let input = Cursor::new(wire.into_bytes());
        let mut reader = std::io::BufReader::new(input);
        let mut writer = Vec::new();
        let err = verify_bridge(&mut reader, &mut writer, "tok").expect_err("over-long refused");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(writer.is_empty(), "no response on a refused handshake");
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
        let mut outcome = GatewayOutcome::default();
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
        let mut outcome = GatewayOutcome::default();
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

    /// ADR-0105 Decision 1: the trio mounts on the ATTEMPTED set, so a turn
    /// whose only enabled server FAILED to connect still advertises the trio
    /// on `tools/list` -- `mcp_list_servers` can then surface the failure
    /// reason. Pins the bridge surface's mount point (the `tools/list`
    /// extend): the trio appends after the built-ins, and no flattened
    /// external name ever appears.
    #[test]
    fn tools_list_appends_the_trio_when_a_connect_was_attempted() {
        let mut ctx = fresh_ctx();
        let config = crate::mcp::config::McpServerConfig {
            id: crate::mcp::config::McpServerId("srv-broken".into()),
            display_name: "BrokenMCP".into(),
            transport: crate::mcp::config::McpTransport::stdio(
                "/no/such/toptopduck-binary",
                Vec::new(),
            ),
            env: std::collections::BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            timeout_ms: None,
            enabled: true,
        };
        ctx.mcp
            .connect_all(&[config], &crate::provider::keychain::KeychainStore::new());
        let mut outcome = GatewayOutcome::default();
        let msg = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/list"});
        match handle_method("tools/list", &msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                let names: Vec<&str> = v["tools"]
                    .as_array()
                    .expect("tools array")
                    .iter()
                    .map(|t| t["name"].as_str().expect("tool name"))
                    .collect();
                let builtins = builtin_table().len();
                assert_eq!(names.len(), builtins + 3, "built-ins + the trio");
                assert_eq!(
                    names[builtins..],
                    ["mcp_list_servers", "mcp_search_tools", "mcp_invoke"],
                    "the trio extends the table in definition order"
                );
            }
            _ => panic!("tools/list must return Result"),
        }
    }

    #[test]
    fn handle_method_unknown_returns_method_not_found() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome::default();
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
        let mut outcome = GatewayOutcome::default();
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

        let outcome = serve_connection(handle, ctx, &AtomicBool::new(false)).expect("serve");

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

    /// The deterministic terminator (issue #357): with the bridge socket held
    /// OPEN (no EOF), serve_connection still returns promptly when
    /// `engine_done` is set -- it does not wait for the bridge to disconnect.
    /// Without this flag the serve would block on `read_message` until the
    /// 120s wall-clock watchdog cancelled it; the flag is what makes serve's
    /// return depend on the engine, not the bridge. Drives initialize +
    /// tools/list first so the outcome reflects requests served BEFORE the flag
    /// fired (the "no in-flight request dropped" invariant).
    ///
    /// serve runs on the test thread (its ctx borrows a `!Sync` DuckDB
    /// `Connection`, same constraint as the production scope-body serve); the
    /// bridge stand-in + the engine stand-in run on spawned threads.
    #[test]
    fn serve_connection_returns_on_engine_done_without_bridge_eof() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let token = handle.token.clone();
        let engine_done = Arc::new(AtomicBool::new(false));
        let done_for_engine = Arc::clone(&engine_done);
        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        let (close_tx, close_rx) = mpsc::channel::<()>();

        // The bridge stand-in: connect, handshake, drive initialize + tools/list
        // (both served synchronously), then HOLD the socket open. Without
        // engine_done this is exactly the stall the issue describes -- serve
        // parked on read_message with no EOF.
        let client = thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let mut r = std::io::BufReader::new(s.try_clone().expect("clone"));
            s.write_all(format!("BRIDGE_AUTH {token}\n").as_bytes())
                .expect("auth write");
            let mut line = String::new();
            r.read_line(&mut line).expect("ok line");
            assert_eq!(line, "BRIDGE_OK\n");
            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"}),
            )
            .expect("send init");
            let init = framing::read_message(&mut r)
                .expect("read init")
                .expect("resp");
            assert_eq!(init["id"], 1);
            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            )
            .expect("send list");
            let list = framing::read_message(&mut r)
                .expect("read list")
                .expect("resp");
            assert_eq!(list["id"], 2);
            // Both requests served; tell the engine stand-in to arm the flag,
            // then hold the socket open (park on close_rx) so serve cannot
            // EOF-return -- the flag must be what unblocks it.
            let _ = ready_tx.send(());
            let _ = close_rx.recv();
            // `s` drops -> stream closes, but serve has already returned.
        });

        // Engine stand-in: wait for the init + list exchanges, let serve park
        // on read_message, then arm the completion flag. Mirrors the engine
        // thread setting engine_done when its prompt pump returns.
        let engine = thread::spawn(move || {
            ready_rx.recv().expect("client ready");
            thread::sleep(Duration::from_millis(150));
            done_for_engine.store(true, Ordering::SeqCst);
        });

        // serve runs on THIS thread (ctx borrows the !Sync Connection, same
        // shape as the production scope-body serve). Time the full call so the
        // assertion covers connect + handshake + exchange + flag-driven return.
        let start = Instant::now();
        let outcome = serve_connection(handle, ctx, &engine_done).expect("serve");
        let elapsed = start.elapsed();
        // Release the client's held socket now that serve has returned.
        let _ = close_tx.send(());
        client.join().expect("client thread panicked");
        engine.join().expect("engine thread panicked");

        // The loop-top check fires within one READ_TIMEOUT (100ms) of the flag
        // store; the connect + exchange + 150ms park budget stays well under
        // 2s. The prior behavior parked until the 120s wall-clock watchdog.
        assert!(
            elapsed < Duration::from_secs(2),
            "serve returned promptly on engine_done, not the watchdog: {elapsed:?}"
        );
        assert!(
            outcome.trace.is_empty(),
            "no tools/call -> empty trace (init + list do not touch it)"
        );
        assert!(
            outcome.promotions.is_empty(),
            "no materialize -> no promotion"
        );
    }

    /// Issue #646: an over-long request frame from the bridge fails the serve
    /// with the framing error instead of being dropped -- a dropped frame
    /// would leave the bridge's request unreplied and the turn hung until the
    /// wall-clock watchdog. The error surfaces through the serve's `Err` path,
    /// which the turn assembler maps onto a failed (not cancelled) outcome;
    /// the bridge observes the teardown as EOF, never a response.
    #[test]
    fn serve_connection_fails_on_overlong_request_frame() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let token = handle.token.clone();

        let client = thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let mut r = std::io::BufReader::new(s.try_clone().expect("clone"));
            s.write_all(format!("BRIDGE_AUTH {token}\n").as_bytes())
                .expect("auth write");
            let mut line = String::new();
            r.read_line(&mut line).expect("ok line");
            assert_eq!(line, "BRIDGE_OK\n");
            // One over-long request frame (newline-terminated so the bounded
            // reader settles on Overlong, not a final unterminated line).
            let mut frame = vec![b'x'; LINE_MAX_BYTES + 1];
            frame.push(b'\n');
            s.write_all(&frame).expect("send over-long frame");
            // The gateway tears the connection down: the read side sees EOF
            // (or, on a reset teardown, an error) -- either way no response
            // bytes ever arrive for the over-long request. The 5s bound is a
            // regression guard: if the over-long arm ever reverts to
            // drop-and-warn, no teardown ever comes and this read parks
            // forever -- the timeout turns that into a diagnostic failure.
            s.set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set tail read timeout");
            let mut tail = String::new();
            match r.read_line(&mut tail) {
                // Clean EOF: the teardown arrived with zero response bytes.
                Ok(0) => {}
                Ok(n) => panic!("connection closed without a response, got {n} bytes: {tail:?}"),
                // A reset teardown surfaces as an error -- still no response.
                Err(e) if e.kind() != io::ErrorKind::TimedOut => {}
                Err(e) => panic!("no teardown in 5s -- dropped, not failed: {e}"),
            }
        });

        let err = serve_connection(handle, ctx, &AtomicBool::new(false))
            .expect_err("an over-long request frame must fail the serve");
        client.join().expect("client thread panicked");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains(&LINE_MAX_BYTES.to_string()),
            "the error names the cap: {err}"
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
        let mut outcome = GatewayOutcome::default();
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
        let mut outcome = GatewayOutcome::default();
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

    /// `mcp_list_servers` serves locally against the aggregator's manifest
    /// (ADR-0105): a success tool result + exactly one trace entry naming the
    /// meta-tool itself, with no gate suspension (the built-in read tools'
    /// trust shape). Works on an empty catalog too -- the manifest is the
    /// honest empty list.
    #[test]
    fn handle_tools_call_list_servers_serves_locally_with_one_trace_row() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "mcp_list_servers", "arguments": {}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false);
                assert!(v["content"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("\"servers\""));
            }
            _ => panic!("list_servers must return Result"),
        }
        assert_eq!(outcome.trace.len(), 1, "one meta call -> one trace row");
        assert_eq!(outcome.trace[0].name, "mcp_list_servers");
        // The trace summary is the shared constant, not a re-inlined literal
        // (issue #663 review: LIST_SUMMARY had no end-to-end pin at either
        // dispatch site).
        assert_eq!(outcome.trace[0].summary, meta_tools::LIST_SUMMARY);
        assert!(outcome.trace[0].success);
        assert_eq!(outcome.trace[0].operation_kind, OperationKind::Read);
    }

    /// `mcp_search_tools` carries the query into the trace summary and serves
    /// the catalog payload locally (empty catalog on this fixture -- the
    /// aggregator-level integration tests pin the match semantics).
    #[test]
    fn handle_tools_call_search_tools_carries_query_in_summary() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {"name": "mcp_search_tools", "arguments": {"query": "github issues"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false);
                let text = v["content"][0]["text"].as_str().unwrap();
                assert!(text.contains("\"total_matched\""));
            }
            _ => panic!("search_tools must return Result"),
        }
        assert_eq!(outcome.trace.len(), 1);
        assert_eq!(outcome.trace[0].name, "mcp_search_tools");
        assert_eq!(outcome.trace[0].summary, "query \"github issues\"");
    }

    /// A namespaced handle emitted DIRECTLY as a tool name is refused before
    /// the gate (ADR-0105 Consequences): the trio is the one addressing
    /// surface, so the hallucinated direct call gets a tool-level error
    /// pointing at `mcp_invoke` -- no approval card, no trace entry.
    #[test]
    fn handle_tools_call_direct_handle_emission_is_refused_pregate() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {"name": "mcp__fakemcp__add", "arguments": {"a": 1, "b": 2}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true);
                let text = v["content"][0]["text"].as_str().unwrap();
                assert!(
                    text.contains("mcp__fakemcp__add"),
                    "error names the handle: {text}"
                );
                assert!(
                    text.contains("mcp_invoke"),
                    "error points at the addressing path: {text}"
                );
            }
            _ => panic!("direct emission must return Result"),
        }
        assert!(
            outcome.trace.is_empty(),
            "direct emission produces no trace entry"
        );
    }

    /// An `mcp_invoke` whose handle does not resolve (not namespaced, unknown
    /// server, or a malformed input) is the call's own failure (ADR-0105
    /// Decision 4): a tool-level isError result that NAMES the handle, with
    /// NO trace entry and no `mcp_invoke` shell row -- the call never reached
    /// a tool.
    #[test]
    fn handle_tools_call_invoke_resolution_failure_is_traceless() {
        for (args, expect_named) in [
            (json!({"tool": "explore"}), "explore"),
            (json!({"tool": "mcp__ghost__echo"}), "mcp__ghost__echo"),
            (json!({}), "parameter `tool`"),
        ] {
            let mut ctx = fresh_ctx();
            let mut outcome = GatewayOutcome::default();
            let msg = json!({
                "jsonrpc": "2.0",
                "id": 9,
                "method": "tools/call",
                "params": {"name": "mcp_invoke", "arguments": args}
            });
            match handle_tools_call(&msg, &mut ctx, &mut outcome) {
                Response::Result(v) => {
                    assert_eq!(v["isError"], true, "resolution failure is isError");
                    let text = v["content"][0]["text"].as_str().unwrap();
                    assert!(
                        text.contains(expect_named),
                        "failure names the offending handle/param: {text}"
                    );
                }
                _ => panic!("resolution failure must return Result"),
            }
            assert!(
                outcome.trace.is_empty(),
                "resolution failure produces no trace entry"
            );
        }
    }

    /// A string JSON-RPC id round-trips into the trace without serde quoting
    /// (PR #339 review A1: `Value::to_string()` would have wrapped it in
    /// literal quotes).
    #[test]
    fn handle_tools_call_string_id_not_double_quoted() {
        let mut ctx = fresh_ctx();
        let mut outcome = GatewayOutcome::default();
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

    // --- registered CLI tools on the bridge surface (issue #673) ---------

    /// An approval sink that drives the gate from inside `emit_request`:
    /// records the emitted card body, then answers it immediately. The gate
    /// installs the pending slot BEFORE calling the sink and holds no locks
    /// across the call, so `respond` here is the same store-then-notify the
    /// `respond_tool_approval` command does -- no deadlock, no lost wake-up.
    struct AnsweringSink {
        state: &'static ApprovalState,
        answer: ApprovalResponse,
        seen: std::sync::Mutex<Vec<ApprovalRequestBody>>,
    }

    impl AnsweringSink {
        fn new(state: &'static ApprovalState, answer: ApprovalResponse) -> Self {
            Self {
                state,
                answer,
                seen: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn cards(&self) -> std::sync::MutexGuard<'_, Vec<ApprovalRequestBody>> {
            self.seen.lock().expect("cards lock")
        }
    }

    impl ApprovalSink for AnsweringSink {
        fn emit_request(&self, body: &ApprovalRequestBody) {
            self.cards().push(body.clone());
            let id: uuid::Uuid = body.request_id.parse().expect("request_id is a uuid");
            self.state.respond(id, self.answer).expect("respond");
        }

        fn emit_resolved(&self, _: &ApprovalRequestBody, _: ApprovalResponse) {}
    }

    /// A registered tool with one argv parameter + one file parameter, pointed
    /// at an executable that does not exist: the classify path never needs
    /// the binary (the card is rendered before any spawn), and the execute
    /// path's structured spawn failure is exactly what the routing pins
    /// assert -- the executor's own tests cover the running-binary contract.
    fn cli_fixture() -> crate::cli_tools::config::CliToolConfig {
        use crate::cli_tools::config::{
            CliParamDelivery, CliToolConfig, CliToolParam, CliToolSource,
        };
        CliToolConfig {
            name: "doc-convert".into(),
            description: "convert a document".into(),
            executable: "/no/such/cli-fixture-exe".into(),
            argv_template: vec![
                "--flag".into(),
                "{value}".into(),
                "--doc".into(),
                "{doc}".into(),
            ],
            params: vec![
                CliToolParam {
                    name: "value".into(),
                    description: "a flag value".into(),
                    delivery: CliParamDelivery::Argv,
                    varargs: false,
                },
                CliToolParam {
                    name: "doc".into(),
                    description: "the document body".into(),
                    delivery: CliParamDelivery::File,
                    varargs: false,
                },
            ],
            env: Default::default(),
            enabled: true,
            source: CliToolSource::User,
            baseline: None,
        }
    }

    /// `tools/list` direct-lists the enabled registrations after the built-in
    /// table, carrying the same name + schema the built-in runtime's table
    /// does (the single tool plane, ADR-0108 Decision 6). With no
    /// registrations the surface is unchanged -- a machine without any never
    /// misreports.
    #[test]
    fn tools_list_direct_lists_cli_tools_after_builtins() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static NoopSink = Box::leak(Box::new(NoopSink));
        let mut ctx = gate_ctx(vec![cli_fixture()], approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/list"});
        let tools = match handle_method("tools/list", &msg, &mut ctx, &mut outcome) {
            Response::Result(v) => v["tools"].as_array().expect("tools array").clone(),
            _ => panic!("tools/list must return Result"),
        };
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().expect("named entry"))
            .collect();
        let pos = names
            .iter()
            .position(|n| *n == "doc-convert")
            .expect("the registered CLI tool is advertised on the bridge surface");
        let last_builtin = builtin_table().len() - 1;
        assert!(
            pos > last_builtin,
            "CLI entries ride after the built-in table: {names:?}"
        );
        // Schema identity with the built-in runtime's table: the same
        // `tool_definitions` output, renamed to the MCP field.
        let defs = crate::cli_tools::config::tool_definitions(ctx.cli);
        assert_eq!(tools[pos]["description"], json!(defs[0].description));
        assert_eq!(tools[pos]["inputSchema"], defs[0].input_schema);
        // No registrations -> no CLI entries: the count is exactly the
        // built-in table (the trio is not mounted in this fixture).
        let mut bare = fresh_ctx();
        let bare_tools = match handle_method("tools/list", &msg, &mut bare, &mut outcome) {
            Response::Result(v) => v["tools"].as_array().expect("tools array").clone(),
            _ => panic!("tools/list must return Result"),
        };
        assert_eq!(
            bare_tools.len(),
            builtin_table().len(),
            "an empty registry leaves the surface unchanged"
        );
    }

    /// A bridge-originated call naming a registered CLI tool gates under the
    /// CLI trust key with the Execute badge, and the card carries the full
    /// argv + the file-delivered value -- the approver signs exactly what
    /// will run, identically to a built-in-initiated call (ADR-0108
    /// Decisions 7/8). The sink allows once; the executor's structured spawn
    /// failure (a nonexistent executable) comes back as the call's own
    /// `isError` envelope with one trace row.
    #[test]
    fn handle_tools_call_cli_tool_gates_then_dispatches_with_trace() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static AnsweringSink = Box::leak(Box::new(AnsweringSink::new(
            approval,
            ApprovalResponse::AllowOnce,
        )));
        let mut ctx = gate_ctx(vec![cli_fixture()], approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": "doc-convert",
                "arguments": {"value": "yes", "doc": "hello body"}
            }
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(
                    v["isError"], true,
                    "a nonexistent executable is a tool-level error, not a JSON-RPC error"
                );
                let text = v["content"][0]["text"].as_str().unwrap();
                assert!(
                    text.contains("cli-fixture-exe"),
                    "the spawn failure names the executable: {text}"
                );
            }
            Response::Error(code, m) => panic!("CLI call must be a tool result, got {code}: {m}"),
            Response::None => panic!("CLI call must return a result"),
        }
        assert_eq!(outcome.trace.len(), 1, "one call -> one trace row");
        let row = &outcome.trace[0];
        assert_eq!(row.name, "doc-convert");
        assert_eq!(row.tool_use_id, "9");
        assert_eq!(row.operation_kind, OperationKind::Execute);
        assert!(!row.success, "the spawn failure is recorded as failure");
        // The card the approver saw: CLI trust key, Execute badge, full argv,
        // and the file value expandable on the card.
        let cards = sink.cards();
        assert_eq!(cards.len(), 1, "exactly one approval card");
        let body = &cards[0];
        assert_eq!(body.server, ToolKey::CLI_SERVER);
        assert_eq!(body.tool, "doc-convert");
        assert_eq!(body.operation_kind, OperationKind::Execute);
        assert!(
            body.summary.contains("--flag")
                && body.summary.contains("yes")
                && body.summary.contains("--doc"),
            "summary renders the full argv: {}",
            body.summary
        );
        assert_eq!(body.file_attachments.len(), 1);
        assert_eq!(body.file_attachments[0].param, "doc");
        assert_eq!(body.file_attachments[0].content, "hello body");
    }

    /// A denial is the call's own `isError` envelope + one trace row naming
    /// the denial -- the same self-correctable tool-level failure the
    /// built-in loop feeds its model (ADR-0077), never a JSON-RPC error and
    /// never a spawn.
    #[test]
    fn handle_tools_call_cli_tool_denial_is_tool_level_error() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static AnsweringSink = Box::leak(Box::new(AnsweringSink::new(
            approval,
            ApprovalResponse::Deny,
        )));
        let mut ctx = gate_ctx(vec![cli_fixture()], approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "doc-convert",
                "arguments": {"value": "yes", "doc": "hello body"}
            }
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true);
                let text = v["content"][0]["text"].as_str().unwrap();
                assert!(
                    text.contains("denied by the approval gateway"),
                    "denial surfaces as the tool result: {text}"
                );
            }
            _ => panic!("denial must return a tool result, not an error"),
        }
        assert_eq!(outcome.trace.len(), 1);
        let row = &outcome.trace[0];
        assert!(!row.success);
        assert_eq!(row.name, "doc-convert");
        assert_eq!(row.result_excerpt, "denied by approval gateway");
    }

    /// Session trust is per `ToolKey`, not per caller: a key seeded by a
    /// prior always-allow bypasses the card for a bridge-originated call too
    /// -- the single plane's payoff (one trust axis, two callers).
    #[test]
    fn handle_tools_call_cli_tool_trust_key_bypasses_the_card() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        approval.seed_trust(&ToolKey::external(ToolKey::CLI_SERVER, "doc-convert"));
        let sink: &'static AnsweringSink = Box::leak(Box::new(AnsweringSink::new(
            approval,
            ApprovalResponse::Deny,
        )));
        let mut ctx = gate_ctx(vec![cli_fixture()], approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "doc-convert",
                "arguments": {"value": "yes", "doc": "hello body"}
            }
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                // Trusted, so the call DISPATCHED -- the failure is the
                // spawn's, not a denial.
                let text = v["content"][0]["text"].as_str().unwrap();
                assert!(
                    !text.contains("denied"),
                    "a trusted key dispatches without a card: {text}"
                );
            }
            _ => panic!("trusted CLI call must return a tool result"),
        }
        assert!(
            sink.cards().is_empty(),
            "a trusted key never surfaces a card"
        );
        assert_eq!(outcome.trace.len(), 1);
    }

    /// A cancel arriving while the gate is suspended on a CLI card ends the
    /// call as a JSON-RPC error (the bridge must never hang on a reply) and
    /// records no trace row -- the turn-level cancel path owns the outcome.
    /// The waker thread plays the role of `fire_cancel`'s
    /// `interrupt_pending`, the same wake the real cancel path uses.
    #[test]
    fn handle_tools_call_cli_tool_cancel_ends_as_jsonrpc_error() {
        struct ParkingSink(std::sync::Mutex<Vec<ApprovalRequestBody>>);
        impl ApprovalSink for ParkingSink {
            fn emit_request(&self, body: &ApprovalRequestBody) {
                self.0.lock().expect("cards lock").push(body.clone());
            }
            fn emit_resolved(&self, _: &ApprovalRequestBody, _: ApprovalResponse) {}
        }
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static ParkingSink = Box::leak(Box::new(ParkingSink(Default::default())));
        let mut ctx = gate_ctx(vec![cli_fixture()], approval, sink);
        let mut outcome = GatewayOutcome::default();
        let waker = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            approval.interrupt_pending();
        });
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "doc-convert",
                "arguments": {"value": "yes", "doc": "hello body"}
            }
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Error(code, m) => {
                assert_eq!(code, -32000);
                assert!(m.contains("cancelled"), "names the cancel: {m}");
            }
            _ => panic!("a cancelled gate must surface a JSON-RPC error"),
        }
        waker.join().expect("waker thread panicked");
        assert!(
            outcome.trace.is_empty(),
            "a cancelled call records no trace row"
        );
        assert_eq!(
            sink.0.lock().unwrap().len(),
            1,
            "the card did surface first"
        );
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

    // --- wire-level pins over a live server (issue #661) -------------------

    /// A `mcp_search_tools` call without a usable query fails with the SHARED
    /// message (the same `meta_tools` source the built-in loop consumes), as
    /// a tool-level error with no trace entry.
    #[test]
    fn handle_tools_call_search_tools_without_a_query_fails_with_the_shared_message() {
        for args in [json!({}), json!({"query": 7})] {
            let mut ctx = fresh_ctx();
            let mut outcome = GatewayOutcome::default();
            let msg = json!({
                "jsonrpc": "2.0", "id": 21, "method": "tools/call",
                "params": {"name": "mcp_search_tools", "arguments": args}
            });
            match handle_tools_call(&msg, &mut ctx, &mut outcome) {
                Response::Result(v) => {
                    assert_eq!(v["isError"], true, "malformed search is isError");
                    assert_eq!(
                        v["content"][0]["text"].as_str().unwrap(),
                        meta_tools::missing_query_failure(),
                        "the failure message comes from the shared source"
                    );
                }
                _ => panic!("malformed search must return Result"),
            }
            assert!(
                outcome.trace.is_empty(),
                "a malformed search never reached a tool -> no trace row"
            );
        }
    }

    /// The gateway-level `mcp_invoke` success chain (issue #661):
    /// invoke -> resolve -> gate -> route -> verbatim envelope, over a live
    /// in-process server. Asserts the three-part contract: the server's
    /// envelope relays verbatim, exactly ONE trace row lands naming the
    /// backend handle, and NO `mcp_invoke` shell row exists (the gate and
    /// trace consume the resolved identity, ADR-0105 Decision 4). The gate
    /// passes via seeded trust, keeping the pin off the interactive path.
    #[test]
    fn handle_tools_call_invoke_success_chain_relays_verbatim() {
        let server = LiveMcpServer::spawn();
        let mut ctx = live_ctx(&server);
        ctx.approval
            .seed_trust(&ToolKey::external("livemcp", "mcp__livemcp__add"));
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0", "id": 42, "method": "tools/call",
            "params": {"name": "mcp_invoke",
                       "arguments": {"tool": "mcp__livemcp__add", "arguments": {"a": 2, "b": 3}}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => assert_eq!(
                v,
                json!({"content": [{"type": "text", "text": "5"}], "isError": false}),
                "the server's envelope relays verbatim"
            ),
            _ => panic!("invoke success chain must return Result"),
        }
        assert_eq!(outcome.trace.len(), 1, "exactly one trace row");
        let row = &outcome.trace[0];
        assert_eq!(row.name, "mcp__livemcp__add", "the row names the handle");
        assert_eq!(row.tool_use_id, "42");
        assert!(row.success);
        assert!(
            !outcome
                .trace
                .iter()
                .any(|r| r.name == meta_tools::META_INVOKE),
            "no mcp_invoke shell row"
        );
    }

    /// The discovery loop's within-turn reuse contract (issue #661): a
    /// search over the SAME server's catalog returns handle cards whose
    /// `inputSchema` is the server's own schema verbatim (non-trivial here,
    /// distinguishable from the degraded empty object), and the card's
    /// handle then invokes successfully through the same aggregator.
    #[test]
    fn handle_tools_call_search_then_invoke_reuse_the_same_catalog() {
        let server = LiveMcpServer::spawn();
        let mut ctx = live_ctx(&server);
        ctx.approval
            .seed_trust(&ToolKey::external("livemcp", "mcp__livemcp__add"));
        let mut outcome = GatewayOutcome::default();
        // 1) search: the card carries the handle + the server's schema.
        let search = json!({
            "jsonrpc": "2.0", "id": 50, "method": "tools/call",
            "params": {"name": "mcp_search_tools", "arguments": {"query": "add"}}
        });
        match handle_tools_call(&search, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                let payload: Value =
                    serde_json::from_str(v["content"][0]["text"].as_str().expect("catalog json"))
                        .expect("parse catalog");
                let card = &payload["tools"][0];
                assert_eq!(card["tool"], "mcp__livemcp__add");
                assert_eq!(
                    card["inputSchema"]["properties"]["a"]["type"], "integer",
                    "the card carries the server's non-trivial schema verbatim"
                );
                assert_eq!(
                    card["inputSchema"]["required"],
                    json!(["a", "b"]),
                    "schema fields survive untouched"
                );
            }
            _ => panic!("search must return Result"),
        }
        // 2) invoke the handle the card handed out, same aggregator.
        let invoke = json!({
            "jsonrpc": "2.0", "id": 51, "method": "tools/call",
            "params": {"name": "mcp_invoke",
                       "arguments": {"tool": "mcp__livemcp__add", "arguments": {"a": 10, "b": 20}}}
        });
        match handle_tools_call(&invoke, &mut ctx, &mut outcome) {
            Response::Result(v) => assert_eq!(
                v,
                json!({"content": [{"type": "text", "text": "30"}], "isError": false}),
                "the card's handle invokes through the same catalog"
            ),
            _ => panic!("invoke must return Result"),
        }
        // Two rows: the meta search itself, then the backend handle.
        assert_eq!(outcome.trace.len(), 2);
        assert_eq!(outcome.trace[0].name, "mcp_search_tools");
        assert_eq!(outcome.trace[1].name, "mcp__livemcp__add");
    }

    /// A server-reported `isError: true` envelope relays verbatim through
    /// the invoke chain (issue #661 wire fixture): the gateway does not mask
    /// the server's error, and the trace row records the failure.
    #[test]
    fn handle_tools_call_invoke_relays_a_server_error_envelope_verbatim() {
        let server = LiveMcpServer::spawn();
        let mut ctx = live_ctx(&server);
        ctx.approval
            .seed_trust(&ToolKey::external("livemcp", "mcp__livemcp__fail"));
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0", "id": 60, "method": "tools/call",
            "params": {"name": "mcp_invoke", "arguments": {"tool": "mcp__livemcp__fail"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => assert_eq!(
                v,
                json!({"content": [{"type": "text", "text": "boom: intentional failure fixture"}],
                       "isError": true}),
                "the server's error envelope relays verbatim"
            ),
            _ => panic!("a server-side error is still a Result envelope"),
        }
        let row = &outcome.trace[0];
        assert_eq!(row.name, "mcp__livemcp__fail");
        assert!(!row.success, "the trace row records the failure");
    }
}
