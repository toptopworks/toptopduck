//! MCP stdio client -- the gateway's per-turn JSON-RPC client for ONE
//! user-configured external MCP server (ADR-0076, issue #301 slice C1).
//!
//! The gateway aggregates an enabled server's tools into its advertised table
//! (slice C-gw) and routes `tools/call` to the matching server. This module
//! owns the connection: spawn the stdio transport, perform the MCP initialize
//! handshake, and drive `tools/list` + `tools/call` over newline-delimited
//! JSON-RPC (reusing [`crate::runtime::gateway::framing`] -- same wire shape).
//!
//! Turn-local (issue #301 Q2): the gateway spawns one [`StdioClient`] per
//! configured server at turn start and drops it (killing the child) at turn
//! end -- no cross-turn state, no session-level handle. Per-call timeout is
//! NOT enforced per-read here: stdio reads block with no native deadline, so
//! the turn-level watchdog (ADR-0021) bounds a hung server. `timeout_ms` stays
//! on [`crate::mcp::config::McpServerConfig`] as a forward-compat contract; a
//! per-read deadline would need a read thread + timeout (deferred).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use crate::mcp::config::{McpServerConfig, McpTransport};
use crate::runtime::gateway::framing;

/// The MCP protocol version the client advertises at initialize. Pinned to the
/// gateway's server-side version (`server.rs` initialize response) so both ends
/// of the gateway speak the same revision; the server may negotiate via its
/// initialize result, which the gateway logs but does not otherwise act on in
/// slice C1.
const PROTOCOL_VERSION: &str = "2024-11-05";

/// One keychain-backed env value the gateway injects at spawn. The gateway
/// resolves these from the OS keychain via
/// [`crate::mcp::secrets::get_mcp_secret`] (ADR-0029) BEFORE constructing the
/// client, then passes the resolved `(env_key, value)` pairs in. The client
/// never touches the keychain -- it is pure transport, testable without one.
pub type SecretEnv = (String, String);

/// A JSON-RPC client over newline-delimited framing (ADR-0076, issue #301 C1).
///
/// Generic over the read/write halves so the core handshake + request/response
/// pairing is testable with `Cursor` mocks (no subprocess); the production
/// [`StdioClient`] wraps a spawned child's stdin/stdout.
pub struct McpClient<R, W> {
    reader: R,
    writer: W,
    next_id: i64,
}

impl<R: BufRead, W: Write> McpClient<R, W> {
    /// Wrap an already-connected read/write pair. The caller performs the
    /// transport-specific bring-up (spawn, TCP connect, ...); this type drives
    /// the MCP JSON-RPC conversation.
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader,
            writer,
            next_id: 1,
        }
    }

    /// Perform the MCP initialize handshake: send `initialize`, await its
    /// response, then send the `notifications/initialized` ack. Returns the
    /// server's `InitializeResult` so the caller can log the negotiated
    /// `protocolVersion` / `serverInfo`.
    pub fn initialize(&mut self) -> Result<Value, ClientError> {
        let id = self.next_id();
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "toptopduck-gateway",
                    "version": env!("CARGO_PKG_VERSION"),
                },
            }
        });
        let result = self.request(req)?;
        // The initialized notification completes the handshake; MCP
        // notifications are unacknowledged, so no response is awaited.
        let notif = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        framing::write_message(&mut self.writer, &notif).map_err(ClientError::Framing)?;
        Ok(result)
    }

    /// List the server's tools. Returns the raw `tools` array entries (each is
    /// the server's own `{name, description, inputSchema}` shape); the gateway
    /// namespaces them (`mcp__<server_slug>__<tool>`) at aggregation time.
    pub fn list_tools(&mut self) -> Result<Vec<Value>, ClientError> {
        let id = self.next_id();
        let req = json!({"jsonrpc": "2.0", "id": id, "method": "tools/list"});
        let result = self.request(req)?;
        Ok(result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// Call one tool. `name` is the server-native name (the gateway already
    /// stripped the `mcp__<server_slug>__` prefix before routing here).
    /// Returns the `tools/call` result for the gateway to relay to the bridge
    /// verbatim (content + isError).
    pub fn call(&mut self, name: &str, arguments: &Value) -> Result<Value, ClientError> {
        let id = self.next_id();
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments}
        });
        self.request(req)
    }

    /// Send a request and read frames until its response (matched by id)
    /// arrives. Server-emitted notifications (no id) and responses for other
    /// ids are skipped -- an MCP server may emit progress / log notifications
    /// between requests, and they are not paired with any client request.
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        let id = req.get("id").cloned();
        framing::write_message(&mut self.writer, &req).map_err(ClientError::Framing)?;
        loop {
            let msg = framing::read_message(&mut self.reader)
                .map_err(ClientError::Framing)?
                .ok_or(ClientError::ServerClosed)?;
            if msg.get("id") != id.as_ref() {
                continue;
            }
            if let Some(err) = msg.get("error") {
                return Err(ClientError::ServerError(err.clone()));
            }
            return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    fn next_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

/// Production wrapper: a [`McpClient`] backed by a spawned stdio MCP server's
/// stdin/stdout. Owns the child; `Drop` kills it (per-turn lifecycle, issue
/// #301 Q2).
///
/// Only the stdio transport is wired in slice C1 (issue #301 Q4); `sse` /
/// `http` configs surface [`ClientError::UnsupportedTransport`] so the gateway
/// can log + skip the server rather than silently dropping it.
pub struct StdioClient {
    inner: McpClient<BufReader<ChildStdout>, ChildStdin>,
    child: Child,
}

impl StdioClient {
    /// Spawn the configured stdio server, perform the MCP initialize handshake,
    /// and return the connected client. `secrets` are the keychain-resolved
    /// `(env_key, value)` pairs (from
    /// [`McpServerConfig::keychain_env_keys`]); they are injected into the
    /// child env alongside [`McpServerConfig::env`] (the non-secret values).
    pub fn connect(config: &McpServerConfig, secrets: &[SecretEnv]) -> Result<Self, ClientError> {
        let (command, args) = match &config.transport {
            McpTransport::Stdio { command, args } => (command.clone(), args.clone()),
            McpTransport::Sse { .. } | McpTransport::Http { .. } => {
                return Err(ClientError::UnsupportedTransport(transport_label(
                    &config.transport,
                )));
            }
        };
        let mut child = Command::new(&command)
            .args(&args)
            .envs(config.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .envs(secrets.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().ok_or(ClientError::NoChildStdin)?;
        let stdout = child.stdout.take().ok_or(ClientError::NoChildStdout)?;
        let mut client = StdioClient {
            inner: McpClient::new(BufReader::new(stdout), stdin),
            child,
        };
        client.inner.initialize()?;
        Ok(client)
    }

    pub fn list_tools(&mut self) -> Result<Vec<Value>, ClientError> {
        self.inner.list_tools()
    }

    pub fn call(&mut self, name: &str, arguments: &Value) -> Result<Value, ClientError> {
        self.inner.call(name, arguments)
    }
}

impl Drop for StdioClient {
    fn drop(&mut self) {
        // The turn is over; kill the server rather than wait for a graceful
        // exit. Flushing stdin first signals EOF to a well-behaved server; the
        // kill + wait that follow guarantee release even if it ignores EOF.
        let _ = self.inner.writer.flush();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The short label for an unsupported transport in an error message
/// (`"stdio"` / `"sse"` / `"http"`).
fn transport_label(t: &McpTransport) -> String {
    match t {
        McpTransport::Stdio { .. } => "stdio",
        McpTransport::Sse { .. } => "sse",
        McpTransport::Http { .. } => "http",
    }
    .to_string()
}

/// A client-side failure: a bad transport, a spawn fault, a wire error, or a
/// server-reported JSON-RPC error. The gateway maps these to a tool-level
/// error the agent self-corrects from (ADR-0077) plus a trace entry.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("unsupported transport (slice C1 supports stdio only): {0}")]
    UnsupportedTransport(String),
    #[error("failed to spawn MCP server: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("framing error on the server transport: {0}")]
    Framing(std::io::Error),
    #[error("spawned child has no stdin (piped was requested)")]
    NoChildStdin,
    #[error("spawned child has no stdout (piped was requested)")]
    NoChildStdout,
    #[error("server closed the connection before responding")]
    ServerClosed,
    #[error("server returned a JSON-RPC error: {0}")]
    ServerError(Value),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    /// Frame `msgs` as newline-delimited JSON (the wire form a server writes),
    /// returning bytes for a `Cursor` reader mock.
    fn wire(msgs: &[Value]) -> Vec<u8> {
        let mut buf = Vec::new();
        for m in msgs {
            framing::write_message(&mut buf, m).expect("write frame");
        }
        buf
    }

    /// `initialize` sends id=1, awaits the id=1 response, then emits the
    /// `notifications/initialized` ack. The negotiated InitializeResult is
    /// returned verbatim.
    #[test]
    fn initialize_pairs_response_by_id_and_emits_initialized_notification() {
        let init_result = json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "serverInfo": {"name": "fake-mcp", "version": "0.1"}
        });
        let server = wire(&[json!({"jsonrpc": "2.0", "id": 1, "result": init_result.clone()})]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let result = client.initialize().expect("handshake ok");
        assert_eq!(result, init_result);
        // The writer collected the initialize request + the initialized
        // notification (in that order).
        let mut r = Cursor::new(client.writer.get_ref().clone());
        let m1 = framing::read_message(&mut r).unwrap().unwrap();
        let m2 = framing::read_message(&mut r).unwrap().unwrap();
        assert_eq!(m1["method"], "initialize");
        assert_eq!(m1["params"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(m2["method"], "notifications/initialized");
    }

    /// `list_tools` returns the server's `tools` array, verbatim. Missing
    /// `tools` degrades to empty (a server advertising no tools is valid).
    #[test]
    fn list_tools_returns_the_tools_array() {
        let tools = json!([
            {"name": "search", "description": "search docs"},
            {"name": "fetch", "description": "fetch a url"}
        ]);
        let server = wire(&[json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": tools}})]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools().expect("list ok");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0]["name"], "search");
        assert_eq!(listed[1]["name"], "fetch");
    }

    #[test]
    fn list_tools_empty_when_result_has_no_tools_key() {
        let server = wire(&[json!({"jsonrpc": "2.0", "id": 1, "result": {}})]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools().expect("list ok");
        assert!(listed.is_empty(), "missing tools key -> empty, not error");
    }

    /// `call` relays the server's tools/call result (content + isError).
    #[test]
    fn call_returns_the_tools_call_result() {
        let result = json!({
            "content": [{"type": "text", "text": "42"}],
            "isError": false
        });
        let server = wire(&[json!({"jsonrpc": "2.0", "id": 1, "result": result.clone()})]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let back = client
            .call("search", &json!({"query": "duckdb"}))
            .expect("call ok");
        assert_eq!(back, result);
        // The request carried the server-native name + arguments verbatim.
        let mut r = Cursor::new(client.writer.get_ref().clone());
        let req = framing::read_message(&mut r).unwrap().unwrap();
        assert_eq!(req["method"], "tools/call");
        assert_eq!(req["params"]["name"], "search");
        assert_eq!(req["params"]["arguments"]["query"], "duckdb");
    }

    /// A JSON-RPC error response surfaces as `ServerError`; the gateway turns
    /// it into a tool-level error the agent self-corrects from (ADR-0077).
    #[test]
    fn error_response_surfaces_as_server_error() {
        let server = wire(&[json!({
            "jsonrpc": "2.0", "id": 1,
            "error": {"code": -32602, "message": "unknown tool"}
        })]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client
            .call("bogus", &json!({}))
            .expect_err("error response");
        assert!(
            matches!(err, ClientError::ServerError(_)),
            "error response -> ServerError, got {err:?}"
        );
    }

    /// A clean EOF (server closed) before the response surfaces as ServerClosed
    /// so the gateway can distinguish "server died" from a transient fault.
    #[test]
    fn eof_before_response_surfaces_as_server_closed() {
        let server = wire(&[]); // no frames at all
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client.list_tools().expect_err("eof");
        assert!(
            matches!(err, ClientError::ServerClosed),
            "EOF -> ServerClosed, got {err:?}"
        );
    }

    /// Server-emitted notifications (no id) between the request and its
    /// response are skipped -- the client keeps reading until the matched id.
    #[test]
    fn notifications_between_request_and_response_are_skipped() {
        let server = wire(&[
            json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": {"progress": 50}}),
            json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}),
        ]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools().expect("list ok past notification");
        assert!(listed.is_empty());
    }

    /// A response for a different id (an interleaved reply to a prior request)
    /// is skipped; the client waits for its own id.
    #[test]
    fn response_with_other_id_is_skipped_until_match() {
        let server = wire(&[
            json!({"jsonrpc": "2.0", "id": 999, "result": {"tools": [{"name": "wrong"}]}}),
            json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": [{"name": "right"}]}}),
        ]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools().expect("list ok");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "right");
    }

    /// Request ids are monotonic across calls -- the second request gets id=2,
    /// so its response must carry id=2 to match.
    #[test]
    fn ids_are_monotonic_across_requests() {
        let server = wire(&[
            json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}),
            json!({"jsonrpc": "2.0", "id": 2, "result": {"content": [], "isError": false}}),
        ]);
        let mut client = McpClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        client.list_tools().expect("first call (id=1)");
        client.call("x", &json!({})).expect("second call (id=2)");
    }
}
