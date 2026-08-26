//! MCP transport clients -- the gateway's per-turn JSON-RPC clients for ONE
//! user-configured external MCP server (ADR-0076, issue #301 slice C1 +
//! issue #389 SSE/HTTP transports).
//!
//! The gateway aggregates an enabled server's tools into its advertised table
//! (slice C-gw) and routes `tools/call` to the matching server. This module
//! owns the connection: establish the transport (stdio / SSE / HTTP), perform
//! the MCP initialize handshake, and drive `tools/list` + `tools/call`.
//!
//! Three transport clients share the same MCP JSON-RPC conversation shape but
//! differ in how request/response bytes are carried:
//! - [`StdioClient`]: newline-delimited JSON-RPC over a spawned child's
//!   stdin/stdout (the MCP stdio transport).
//! - [`HttpClient`]: each JSON-RPC request is POSTed to a URL; the response
//!   body is either a single JSON value or an SSE stream (MCP streamable HTTP
//!   transport, issue #389).
//! - [`SseClient`]: a long-lived GET opens an SSE stream (responses arrive
//!   here); JSON-RPC requests are POSTed to a server-advertised endpoint URL
//!   (legacy MCP SSE transport, issue #389). A background reader thread
//!   forwards SSE events via an mpsc channel.
//!
//! The shared MCP protocol logic (`initialize` / `list_tools` / `call`) lives
//! in the [`McpClient`] trait as default methods; each transport implements
//! only the 3 transport-specific wire methods (`request` /
//! `send_notification` / `next_id`). [`FramedClient`] is the newline-framed
//! implementation used by the stdio transport + the `Cursor`-mocked unit
//! tests (issue #413).
//!
//! [`connect_transport`] dispatches by transport type; the gateway /
//! aggregator holds a [`TransportClient`] enum per connected server.
//!
//! Turn-local (issue #301 Q2): the gateway constructs one client per
//! configured server at turn start and drops it at turn end -- no
//! cross-turn state, no session-level handle. Per-call timeout is NOT
//! enforced per-read here: blocking reads have no native deadline, so the
//! turn-level watchdog (ADR-0021) bounds a hung server. `timeout_ms` stays
//! on [`crate::mcp::config::McpServerConfig`] as a forward-compat contract.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::bounded_line::{read_line_bounded, LineRead, LINE_MAX_BYTES};
use crate::mcp::config::{McpServerConfig, McpTransport};
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::runtime::gateway::framing;

/// SSE reader-thread read timeout. Bounds the join latency in `SseClient::drop`
/// (the reader wakes at most every this interval to re-check the stop flag).
const SSE_READ_TIMEOUT: Duration = Duration::from_secs(2);

/// HTTP per-read timeout (issue #392). Ensures a hung HTTP server's
/// `spawn_blocking` task eventually terminates after the probe deadline
/// fires — `spawn_blocking` tasks are not cancelled, so without this the
/// thread + TCP connection would linger indefinitely.
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Bounded channel capacity for SSE reader → consumer message forwarding.
/// Backpressures a flooding server so the reader blocks on send rather than
/// accumulating unbounded messages in memory.
const SSE_CHANNEL_BOUND: usize = 64;

/// One keychain-backed env value the gateway injects at spawn. The gateway
/// resolves these from the OS keychain via
/// [`crate::mcp::secrets::get_mcp_secret`] (ADR-0029) BEFORE constructing the
/// client, then passes the resolved `(env_key, value)` pairs in. The client
/// never touches the keychain -- it is pure transport, testable without one.
pub type SecretEnv = (String, String);

// ---------------------------------------------------------------------------
// McpClient trait (issue #413)
// ---------------------------------------------------------------------------

/// The MCP JSON-RPC conversation contract shared by all three transports
/// (issue #413). The 3 required methods carry the transport-specific wire
/// logic; the 3 default methods implement the shared MCP protocol
/// (`initialize` / `list_tools` / `call`) purely in terms of the required
/// methods, so adding a new transport needs no protocol-level duplication.
///
/// Required methods:
/// - [`request`](McpClient::request): send one JSON-RPC request and await its
///   matched response (by `id`).
/// - [`send_notification`](McpClient::send_notification): send a JSON-RPC
///   notification (no `id`, no response expected). Each transport carries the
///   bytes differently (stdio frame / HTTP POST / SSE POST).
/// - [`next_id`](McpClient::next_id): allocate a monotonic JSON-RPC request
///   id. Transport-local so each client owns its counter.
pub trait McpClient {
    /// Send one JSON-RPC request and await its response (matched by `id`).
    /// Server-emitted notifications (no `id`) and responses for other ids are
    /// skipped -- an MCP server may emit progress / log notifications between
    /// requests, and they are not paired with any client request.
    fn request(&mut self, req: Value) -> Result<Value, ClientError>;

    /// Send a JSON-RPC notification (no `id`, no response awaited). The
    /// `initialize` handshake uses this for the `notifications/initialized`
    /// ack; each transport sends it over its own wire.
    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError>;

    /// Allocate the next monotonic JSON-RPC request id.
    fn next_id(&mut self) -> i64;

    /// Perform the MCP initialize handshake: send `initialize`, await its
    /// response, then send the `notifications/initialized` ack. Returns the
    /// server's `InitializeResult` so the caller can log the negotiated
    /// `protocolVersion` / `serverInfo`.
    fn initialize(&mut self) -> Result<Value, ClientError> {
        let id = self.next_id();
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
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
        self.send_notification(notif)?;
        Ok(result)
    }

    /// List the server's tools. Returns the raw `tools` array entries (each is
    /// the server's own `{name, description, inputSchema}` shape); the gateway
    /// namespaces them (`mcp__<server_slug>__<tool>`) at aggregation time.
    fn list_tools(&mut self) -> Result<Vec<Value>, ClientError> {
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
    fn call(&mut self, name: &str, arguments: &Value) -> Result<Value, ClientError> {
        let id = self.next_id();
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments}
        });
        self.request(req)
    }
}

/// A newline-framed JSON-RPC client over generic read/write halves
/// (ADR-0076, issue #301 C1). Generic over R/W so the core handshake +
/// request/response pairing is testable with `Cursor` mocks (no subprocess);
/// the production [`StdioClient`] wraps a spawned child's stdin/stdout.
///
/// Implements [`McpClient`] — the 3 required methods drive the newline
/// framing, and the shared protocol methods (`initialize` / `list_tools` /
/// `call`) are inherited from the trait (issue #413).
pub struct FramedClient<R, W> {
    reader: R,
    writer: W,
    next_id: i64,
}

impl<R, W> FramedClient<R, W> {
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
}

impl<R: BufRead, W: Write> McpClient for FramedClient<R, W> {
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        let id = req.get("id").cloned();
        framing::write_message(&mut self.writer, &req).map_err(ClientError::Framing)?;
        loop {
            let msg = framing::read_message(&mut self.reader)
                .map_err(ClientError::Framing)?
                .ok_or(ClientError::ServerClosed)?;
            // Match only id-bearing responses; a notification (no id) or a
            // response for another id is skipped (issue #413).
            if msg.get("id") != id.as_ref() || id.is_none() {
                continue;
            }
            return check_rpc_response(&msg);
        }
    }

    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError> {
        framing::write_message(&mut self.writer, &notif).map_err(ClientError::Framing)
    }

    fn next_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

// ---------------------------------------------------------------------------
// SSE event parsing (shared by HttpClient + SseClient, issue #389)
// ---------------------------------------------------------------------------

/// One parsed SSE event from a `text/event-stream` response (issue #389).
/// `event` is the `event:` field value (e.g., `"endpoint"`, `"message"` or
/// `None` when omitted — the SSE default is `"message"`). `data` is the
/// concatenation of all `data:` lines (joined with `\n` per the SSE spec).
struct SseEvent {
    event: Option<String>,
    data: String,
}

/// Read one SSE event from a buffered reader, with both caps from
/// [`LINE_MAX_BYTES`] (issue #647):
/// - line level: lines longer than the cap are dropped by
///   [`read_line_bounded`];
/// - event level: the summed bytes of one event's `data:` parts -- the "\n"
///   join byte included, so zero-length parts cannot slip past -- are
///   bounded (a stream that never sends the terminating blank line cannot
///   grow the accumulation past one capped line's worth).
///
/// A cap breach voids the WHOLE in-progress event: the accumulated fields are
/// cleared, the surviving lines are skipped until the blank line that
/// terminates the broken event (event-boundary resync), and a warn is logged
/// -- dropping only the offending line would stitch the remaining fields into
/// a partial franken-event the consumer cannot parse. The stream then
/// continues with the next event.
///
/// An event is terminated by a blank line; lines starting with `:` are
/// comments (skipped). `event:` and `data:` fields are accumulated; other
/// fields (`id:`, `retry:`) are ignored. Returns `Ok(None)` at clean EOF
/// (stream closed). Multiple `data:` lines within one event are joined with
/// `\n` per the SSE spec.
fn read_sse_event<R: BufRead>(reader: &mut R) -> std::io::Result<Option<SseEvent>> {
    read_sse_event_bounded(reader, LINE_MAX_BYTES)
}

/// The cap-parameterized core of [`read_sse_event`]. The `max` parameter
/// exists for the unit tests (small caps keep fixtures tiny -- the same
/// convention as [`read_line_bounded`]); every production caller passes
/// [`LINE_MAX_BYTES`].
fn read_sse_event_bounded<R: BufRead>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<SseEvent>> {
    let mut event_type: Option<String> = None;
    let mut data_parts: Vec<String> = Vec::new();
    let mut data_bytes = 0;
    // Set while skipping the surviving lines of a voided event, until the
    // blank line that ends it.
    let mut resyncing = false;

    loop {
        let line = match read_line_bounded(reader, max)? {
            LineRead::Eof => {
                // EOF: return any buffered event, else None (clean close).
                // A voided event that never reached its boundary is dropped.
                if resyncing || (data_parts.is_empty() && event_type.is_none()) {
                    return Ok(None);
                }
                return Ok(Some(SseEvent {
                    event: event_type,
                    data: data_parts.join("\n"),
                }));
            }
            LineRead::Overlong => {
                log::warn!(
                    target: "toptopduck::mcp",
                    "SSE event dropped: line exceeds {max} bytes; resyncing at the next event boundary"
                );
                event_type = None;
                data_parts.clear();
                data_bytes = 0;
                resyncing = true;
                continue;
            }
            LineRead::Line(line) => line,
        };

        let trimmed = line.trim_end_matches(['\r', '\n']);

        if trimmed.is_empty() {
            // Blank line = event boundary. Leading blank lines (before any
            // field) are skipped so a keepalive gap does not produce an empty
            // event; one hit while resyncing just ends the voided event.
            if resyncing {
                resyncing = false;
                continue;
            }
            if data_parts.is_empty() && event_type.is_none() {
                continue;
            }
            return Ok(Some(SseEvent {
                event: event_type,
                data: data_parts.join("\n"),
            }));
        }

        if resyncing {
            continue; // Surviving field of the voided event.
        }

        if trimmed.starts_with(':') {
            continue; // SSE comment (keepalive)
        } else if let Some(rest) = trimmed.strip_prefix("event:") {
            event_type = Some(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("data:") {
            // Per the SSE spec, a single leading space after the colon is
            // stripped; everything else (including additional spaces) is
            // retained as data.
            let data = rest.strip_prefix(' ').unwrap_or(rest);
            // The +1 is the "\n" the join below inserts between parts:
            // counting it keeps zero-length parts (each costing one budget
            // byte) from growing `data_parts` without bound, and bounds the
            // joined string's length.
            data_bytes += data.len() + 1;
            if data_bytes > max {
                log::warn!(
                    target: "toptopduck::mcp",
                    "SSE event dropped: accumulated data exceeds {max} bytes; resyncing at the next event boundary"
                );
                event_type = None;
                data_parts.clear();
                data_bytes = 0;
                resyncing = true;
                continue;
            }
            data_parts.push(data.to_string());
        }
        // id:, retry:, and unknown fields are silently ignored.
    }
}

/// Production wrapper: a [`FramedClient`] backed by a spawned stdio MCP
/// server's stdin/stdout. Owns the child; `Drop` kills it (per-turn lifecycle,
/// issue #301 Q2).
///
/// Only the stdio transport is constructed here; SSE / HTTP transports have
/// their own client types ([`SseClient`], [`HttpClient`]). The dispatcher
/// [`connect_transport`] routes by transport variant. `StdioClient::connect`
/// retains its `UnsupportedTransport` guard so a direct call with a non-stdio
/// config fails loudly rather than silently spawning a bogus child.
pub struct StdioClient {
    inner: FramedClient<BufReader<ChildStdout>, ChildStdin>,
    child: Child,
}

impl StdioClient {
    /// Spawn the configured stdio server, perform the MCP initialize handshake,
    /// and return the connected client. `secrets` are the keychain-resolved
    /// `(env_key, value)` pairs (from
    /// [`McpServerConfig::keychain_env_keys`]); they are injected into the
    /// child env alongside [`McpServerConfig::env`] (the non-secret values).
    pub fn connect(
        config: &McpServerConfig,
        secrets: &[SecretEnv],
        tool_output_dir: Option<&str>,
    ) -> Result<Self, ClientError> {
        let mut child = stdio_command(config, secrets, tool_output_dir)?.spawn()?;
        let stdin = child.stdin.take().ok_or(ClientError::NoChildStdin)?;
        let stdout = child.stdout.take().ok_or(ClientError::NoChildStdout)?;
        let mut client = StdioClient {
            inner: FramedClient::new(BufReader::new(stdout), stdin),
            child,
        };
        client.initialize()?;
        Ok(client)
    }
}

impl McpClient for StdioClient {
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        self.inner.request(req)
    }

    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError> {
        self.inner.send_notification(notif)
    }

    fn next_id(&mut self) -> i64 {
        self.inner.next_id()
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

// ---------------------------------------------------------------------------
// Probe helpers (issue #392)
// ---------------------------------------------------------------------------

/// The env var name the gateway injects so an external MCP tool knows where to
/// write its output files (ADR-0087 Decision 3). The directory is a per-session
/// subdirectory under the session temp dir; its path is passed verbatim. Only
/// injected for stdio servers (local subprocesses); remote transports (SSE /
/// HTTP) cannot write to a local filesystem path.
pub const TOOL_OUTPUT_ENV: &str = "TOPTOPDUCK_TOOL_OUTPUT_DIR";

/// Build the [`Command`] for a stdio MCP server from the config (shared by
/// [`StdioClient::connect`] and [`spawn_stdio_child`]). Extracts the command +
/// args from the transport, injects env + keychain secrets, and configures
/// piped stdin/stdout. Keeping this in one place prevents the two spawn paths
/// (aggregator's per-turn connect vs the probe's timeout-bounded connect)
/// from diverging on env/secret handling.
///
/// `tool_output_dir` injects [`TOOL_OUTPUT_ENV`] into the child env when
/// `Some`. The per-turn aggregator passes the session's tool-output directory;
/// the probe path (`spawn_stdio_child`) passes `None` (connectivity test, no
/// file output expected).
fn stdio_command(
    config: &McpServerConfig,
    secrets: &[SecretEnv],
    tool_output_dir: Option<&str>,
) -> Result<Command, ClientError> {
    let (command, args) = match &config.transport {
        McpTransport::Stdio { command, args } => (command.clone(), args.clone()),
        McpTransport::Sse { .. } | McpTransport::Http { .. } => {
            return Err(ClientError::UnsupportedTransport(transport_label(
                &config.transport,
            )));
        }
    };
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .envs(config.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .envs(secrets.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if let Some(dir) = tool_output_dir {
        if config.env.contains_key(TOOL_OUTPUT_ENV)
            || secrets.iter().any(|(k, _)| k == TOOL_OUTPUT_ENV)
        {
            log::warn!(
                target: "toptopduck::mcp",
                "MCP server {}: user-configured {TOOL_OUTPUT_ENV} overridden by \
                 session tool-output dir (ADR-0087 gateway is path authority)",
                config.id
            );
        }
        cmd.env(TOOL_OUTPUT_ENV, dir);
    }
    Ok(cmd)
}

/// Spawn the configured stdio server child process WITHOUT driving the MCP
/// handshake (issue #392). Returns the raw [`Child`] so the caller owns the
/// lifecycle — specifically, the async `probe_mcp_server` command retains the
/// Child handle outside its `spawn_blocking` closure so a timeout can kill
/// the process. The caller passes the child's stdin/stdout to
/// [`stdio_handshake`] inside a blocking task.
///
/// This is split from [`StdioClient::connect`] (which couples spawn +
/// initialize in one call) because `spawn_blocking` tasks are NOT
/// cancellable — if the handshake hangs inside the task, the only way to
/// guarantee the child is killed is to keep the Child handle outside.
pub fn spawn_stdio_child(
    config: &McpServerConfig,
    secrets: &[SecretEnv],
) -> Result<std::process::Child, ClientError> {
    Ok(stdio_command(config, secrets, None)?.spawn()?)
}

/// Drive the MCP initialize + tools/list handshake on already-spawned stdio
/// handles (issue #392). Returns the raw tool list on success. Used by the
/// probe command which owns the Child externally (for timeout kill); this
/// function performs only the blocking I/O, not process management.
pub fn stdio_handshake(
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
) -> Result<Vec<Value>, ClientError> {
    let mut client = FramedClient::new(BufReader::new(stdout), stdin);
    client.initialize()?;
    client.list_tools()
}

// ---------------------------------------------------------------------------
// HTTP transport client (streamable HTTP, issue #389)
// ---------------------------------------------------------------------------

/// A streamable-HTTP MCP client: each JSON-RPC request is POSTed to `url`,
/// and the response body is either a single JSON value (`application/json`)
/// or an SSE stream (`text/event-stream`) carrying the response (issue #389).
///
/// Stateless per call — the server may respond with JSON or SSE; the client
/// handles both transparently. No persistent connection between calls (unlike
/// [`SseClient`]); `Drop` has no side effects.
pub struct HttpClient {
    url: String,
    agent: ureq::Agent,
    next_id: i64,
}

impl HttpClient {
    /// Connect to the HTTP endpoint and perform the MCP initialize handshake.
    pub fn connect(url: &str) -> Result<Self, ClientError> {
        let agent = ureq::AgentBuilder::new()
            .timeout_read(HTTP_READ_TIMEOUT)
            .build();
        let mut client = Self {
            url: url.to_string(),
            agent,
            next_id: 1,
        };
        client.initialize()?;
        Ok(client)
    }

    /// Test-only: a client at a URL nothing listens on. The aggregator's
    /// catalog / resolve paths never touch the transport; routing against
    /// this client fails with a connection error -- exactly the failure
    /// shape the dispatch-composition pins exercise.
    #[cfg(test)]
    pub(crate) fn unreachable_for_test(url: &str) -> Self {
        Self {
            url: url.to_string(),
            agent: ureq::AgentBuilder::new().build(),
            next_id: 1,
        }
    }
}

impl McpClient for HttpClient {
    /// POST one JSON-RPC request and await its response. The server may
    /// respond with `application/json` (single JSON-RPC envelope) or
    /// `text/event-stream` (SSE carrying the envelope). Both are handled;
    /// the response is matched by JSON-RPC `id`.
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        let id = req.get("id").cloned();
        let response = self
            .agent
            .post(&self.url)
            .send_json(req)
            .map_err(|e| ClientError::Http(e.to_string()))?;

        let content_type = response.header("Content-Type").unwrap_or("");
        if content_type.contains("text/event-stream") {
            // Streamable-HTTP SSE response: read events and find the matching
            // JSON-RPC response by id (notifications without id are skipped).
            let mut reader = BufReader::new(response.into_reader());
            loop {
                match read_sse_event(&mut reader).map_err(ClientError::Framing)? {
                    Some(event) => {
                        match serde_json::from_str::<Value>(&event.data) {
                            Ok(msg) => {
                                if msg.get("id") == id.as_ref() && id.is_some() {
                                    return check_rpc_response(&msg);
                                }
                            }
                            Err(e) => {
                                // Malformed JSON in an SSE event: return a
                                // framing error to match the stdio path's
                                // contract (framing::read_message →
                                // InvalidData).
                                return Err(ClientError::Framing(std::io::Error::new(
                                    std::io::ErrorKind::InvalidData,
                                    format!(
                                        "malformed JSON in SSE event ({} bytes): {e}",
                                        event.data.len()
                                    ),
                                )));
                            }
                        }
                    }
                    None => return Err(ClientError::ServerClosed),
                }
            }
        } else {
            // Plain JSON response.
            let body: Value = response
                .into_json()
                .map_err(|e| ClientError::Http(e.to_string()))?;
            check_rpc_response(&body)
        }
    }

    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError> {
        post_notification(&self.agent, &self.url, notif)
    }

    fn next_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

// ---------------------------------------------------------------------------
// SSE transport client (legacy SSE, issue #389)
// ---------------------------------------------------------------------------

/// A legacy-SSE MCP client (issue #389). The client opens a GET to the SSE
/// URL; the server responds with `text/event-stream` and sends an `endpoint`
/// event carrying the POST URL for JSON-RPC requests. Subsequent requests are
/// POSTed to that endpoint; responses arrive as `message` events on the SSE
/// stream.
///
/// A background thread ([`sse_reader_loop`]) continuously reads SSE events
/// and forwards JSON-RPC messages via an [`mpsc`] channel. The main thread
/// POSTs requests and receives responses from the channel, matching by id.
/// The agent's `timeout_read` (2 s) lets the reader periodically check the
/// stop flag so [`Drop`] can join the thread cleanly.
pub struct SseClient {
    /// Receives JSON-RPC messages forwarded by the reader thread. `Err`
    /// carries a reader-side failure (malformed message event, issue #647)
    /// propagated to the waiting request.
    response_rx: mpsc::Receiver<Result<Value, ClientError>>,
    /// The POST endpoint URL (from the server's initial `endpoint` event).
    post_url: String,
    /// HTTP agent for POST requests (the GET agent's stream is owned by the
    /// reader thread).
    agent: ureq::Agent,
    /// Stop flag shared with the reader thread.
    stop: Arc<AtomicBool>,
    /// The reader thread handle. `Drop` releases `response_rx` before
    /// joining this thread (issue #667): a reader blocked in `send` on a
    /// full channel only exits when the receiver's destruction fails that
    /// send.
    reader_thread: Option<thread::JoinHandle<()>>,
    next_id: i64,
}

impl SseClient {
    /// Open the SSE stream, read the endpoint event, spawn the reader thread,
    /// and perform the MCP initialize handshake.
    pub fn connect(url: &str) -> Result<Self, ClientError> {
        // The GET agent carries a read timeout so the reader thread can
        // periodically check the stop flag (the stream is otherwise blocking
        // forever between events).
        let agent = ureq::AgentBuilder::new()
            .timeout_read(SSE_READ_TIMEOUT)
            .build();

        let response = agent
            .get(url)
            .set("Accept", "text/event-stream")
            .call()
            .map_err(|e| ClientError::Http(e.to_string()))?;

        let content_type = response.header("Content-Type").unwrap_or("");
        if !content_type.contains("text/event-stream") {
            return Err(ClientError::Http(format!(
                "SSE endpoint returned non-event-stream content-type: {content_type}"
            )));
        }

        let mut reader = BufReader::new(response.into_reader());

        // The first event MUST be `event: endpoint` carrying the POST URL
        // (the MCP legacy SSE transport contract). Rejecting anything else
        // prevents a misbehaving server's message payload from being used as
        // the POST target.
        let first_event = read_sse_event(&mut reader)
            .map_err(ClientError::Framing)?
            .ok_or(ClientError::ServerClosed)?;
        if first_event.event.as_deref() != Some("endpoint") {
            return Err(ClientError::Framing(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "expected `event: endpoint` first, got {:?}",
                    first_event.event
                ),
            )));
        }
        // Resolve the POST URL relative to the SSE URL (the server may send
        // a relative path like `/message`). Reject non-http(s) schemes to
        // prevent SSRF via a compromised server's endpoint event.
        let post_url = resolve_post_url(url, &first_event.data)?;

        // Spawn the background reader for subsequent events. A bounded
        // sync_channel backpressures a flooding server.
        let (tx, rx) = mpsc::sync_channel(SSE_CHANNEL_BOUND);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let handle = thread::spawn(move || {
            sse_reader_loop(reader, tx, stop_clone);
        });

        let mut client = Self {
            response_rx: rx,
            post_url,
            agent,
            stop,
            reader_thread: Some(handle),
            next_id: 1,
        };

        client.initialize()?;
        Ok(client)
    }
}

impl McpClient for SseClient {
    /// POST one JSON-RPC request and await the matching response from the SSE
    /// stream (forwarded by the reader thread via the channel). Notifications
    /// (no `id`) and responses for other ids are skipped.
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        let id = req.get("id").cloned();
        self.agent
            .post(&self.post_url)
            .send_json(req)
            .map_err(|e| ClientError::Http(e.to_string()))?;
        // The POST response is typically 202 Accepted; the actual JSON-RPC
        // response arrives on the SSE stream.
        loop {
            let msg = match self.response_rx.recv() {
                Ok(Ok(msg)) => msg,
                // A reader-side failure (malformed message event, issue #647)
                // fails the waiting request fast instead of hanging until the
                // turn watchdog cancels it.
                Ok(Err(err)) => return Err(err),
                Err(_) => return Err(ClientError::ServerClosed),
            };
            if msg.get("id") != id.as_ref() || id.is_none() {
                continue;
            }
            return check_rpc_response(&msg);
        }
    }

    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError> {
        post_notification(&self.agent, &self.post_url, notif)
    }

    fn next_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

impl Drop for SseClient {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Release the receiver BEFORE joining. Two reader exit paths meet
        // here: a reader blocked in `send` on a full channel never re-checks
        // the stop flag, so only the receiver's destruction fails that send
        // with `SendError` (field destruction would happen only after
        // `drop()` returns -- i.e. after a join that never returns, issue
        // #667); a reader between reads sees the stop flag at its next
        // read-timeout wakeup (at most SSE_READ_TIMEOUT). The plain
        // assignment is the move-a-field-out idiom for Drop: it destroys
        // the old receiver immediately; the placeholder is a disconnected
        // channel nobody reads after this point.
        self.response_rx = mpsc::channel().1;
        if let Some(handle) = self.reader_thread.take() {
            // If the thread panicked, log the payload — panics cannot
            // propagate from Drop, but the diagnostic should not be
            // silently lost.
            if let Err(payload) = handle.join() {
                log::error!(
                    target: "toptopduck::mcp",
                    "SSE reader thread panicked during drop: {payload:?}"
                );
            }
        }
    }
}

/// The SSE reader thread loop: continuously reads SSE events and forwards
/// JSON-RPC messages ([`SseEvent`] with `event: message` or default) through
/// the channel. Exits when `stop` is set, the stream closes / errors, or a
/// malformed message event propagates its failure to the waiting request and
/// stops the reader (issue #647). Read timeouts (from the agent's
/// `timeout_read`) are treated as a wakeup to re-check the stop flag — the
/// TCP connection stays open between timeouts.
fn sse_reader_loop<R: BufRead + Send>(
    mut reader: R,
    tx: mpsc::SyncSender<Result<Value, ClientError>>,
    stop: Arc<AtomicBool>,
) {
    while !stop.load(Ordering::SeqCst) {
        match read_sse_event(&mut reader) {
            Ok(Some(event)) => {
                // Only forward `message` events (the default event type when
                // `event:` is omitted). The initial `endpoint` event was
                // consumed in `connect` before the thread started.
                let is_message = event
                    .event
                    .as_deref()
                    .map(|e| e == "message")
                    .unwrap_or(true);
                if is_message {
                    match serde_json::from_str::<Value>(&event.data) {
                        Ok(msg) => {
                            if msg.is_object() && tx.send(Ok(msg)).is_err() {
                                break; // Channel closed (client dropped).
                            }
                        }
                        Err(e) => {
                            // Malformed JSON in a message event: the waiting
                            // request's response is unrecoverable. Propagate
                            // the failure (the streamable-HTTP path's
                            // `Framing(InvalidData)` attribution) instead of
                            // warn-and-continue, which left the request
                            // hanging until the turn watchdog cancelled it.
                            // Best-effort send: a closed channel just means
                            // the client already dropped.
                            let err = ClientError::Framing(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                format!(
                                    "malformed JSON in SSE event ({} bytes): {e}",
                                    event.data.len()
                                ),
                            ));
                            log::warn!(
                                target: "toptopduck::mcp",
                                "SSE reader: {err}; stopping reader thread"
                            );
                            let _ = tx.send(Err(err));
                            break;
                        }
                    }
                }
            }
            Ok(None) => break, // EOF (stream closed).
            Err(ref e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue; // Read timeout → re-check stop flag.
            }
            Err(e) => {
                // Unrecoverable stream error (TCP RST, broken pipe, etc.):
                // log so the operator can distinguish this from a clean close.
                log::warn!(
                    target: "toptopduck::mcp",
                    "SSE reader: stream error, shutting down reader thread: {e}"
                );
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Transport dispatch (issue #389)
// ---------------------------------------------------------------------------

/// Check a JSON-RPC response envelope: return the `result` field on success,
/// [`ClientError::ServerError`] when the server returned an `error` field, or
/// [`ClientError::Framing`] when the envelope has neither (a protocol
/// violation). Shared by all [`McpClient`] implementations (issue #413).
fn check_rpc_response(msg: &Value) -> Result<Value, ClientError> {
    if let Some(err) = msg.get("error") {
        return Err(ClientError::ServerError(err.clone()));
    }
    match msg.get("result") {
        Some(v) => Ok(v.clone()),
        None => Err(ClientError::Framing(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "JSON-RPC response has neither `result` nor `error`",
        ))),
    }
}

/// POST a JSON-RPC notification (no `id`, no response awaited) over an HTTP
/// transport. The response body is intentionally discarded — MCP
/// notifications are fire-and-forget; the server typically returns 202.
/// Non-2xx status codes surface as `ClientError::Http` via `ureq`'s error
/// channel.
fn post_notification(agent: &ureq::Agent, url: &str, notif: Value) -> Result<(), ClientError> {
    agent
        .post(url)
        .send_json(notif)
        .map(drop)
        .map_err(|e| ClientError::Http(e.to_string()))
}

/// Resolve the SSE endpoint event's POST URL relative to the SSE stream URL,
/// rejecting non-http(s) schemes (SSRF guard). The
/// server may send an absolute URL or a relative path like `/message`.
fn resolve_post_url(sse_url: &str, raw: &str) -> Result<String, ClientError> {
    let base =
        url::Url::parse(sse_url).map_err(|e| ClientError::Http(format!("invalid SSE url: {e}")))?;
    let resolved = base
        .join(raw)
        .map_err(|e| ClientError::Http(format!("invalid endpoint url: {e}")))?;
    match resolved.scheme() {
        "http" | "https" => Ok(resolved.to_string()),
        other => Err(ClientError::Http(format!(
            "endpoint url must be http or https, got: {other}"
        ))),
    }
}

/// The connected MCP client for one server, specialized by transport. The
/// aggregator holds one [`TransportClient`] per connected server; the
/// [`McpClient`] trait methods (`list_tools` / `call` / ...) dispatch to the
/// concrete transport client.
pub enum TransportClient {
    Stdio(StdioClient),
    Sse(SseClient),
    Http(HttpClient),
}

impl McpClient for TransportClient {
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        match self {
            Self::Stdio(c) => c.request(req),
            Self::Sse(c) => c.request(req),
            Self::Http(c) => c.request(req),
        }
    }

    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError> {
        match self {
            Self::Stdio(c) => c.send_notification(notif),
            Self::Sse(c) => c.send_notification(notif),
            Self::Http(c) => c.send_notification(notif),
        }
    }

    fn next_id(&mut self) -> i64 {
        match self {
            Self::Stdio(c) => c.next_id(),
            Self::Sse(c) => c.next_id(),
            Self::Http(c) => c.next_id(),
        }
    }
}

/// Connect to a configured MCP server, dispatching to the transport-specific
/// client (issue #389). Each transport's `connect` performs the MCP initialize
/// handshake and returns a ready-to-use [`TransportClient`].
pub fn connect_transport(
    config: &McpServerConfig,
    secrets: &[SecretEnv],
    tool_output_dir: Option<&str>,
) -> Result<TransportClient, ClientError> {
    match &config.transport {
        McpTransport::Stdio { .. } => {
            StdioClient::connect(config, secrets, tool_output_dir).map(TransportClient::Stdio)
        }
        McpTransport::Sse { url } => SseClient::connect(url).map(TransportClient::Sse),
        McpTransport::Http { url } => HttpClient::connect(url).map(TransportClient::Http),
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
    #[error("unsupported transport: {0}")]
    UnsupportedTransport(String),
    #[error("failed to spawn MCP server: {0}")]
    Spawn(#[from] std::io::Error),
    // No `#[from]`: would conflict with `Spawn`'s `#[from] std::io::Error`.
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
    #[error("HTTP transport error: {0}")]
    Http(String),
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let result = client.initialize().expect("handshake ok");
        assert_eq!(result, init_result);
        // The writer collected the initialize request + the initialized
        // notification (in that order).
        let mut r = Cursor::new(client.writer.get_ref().clone());
        let m1 = framing::read_message(&mut r).unwrap().unwrap();
        let m2 = framing::read_message(&mut r).unwrap().unwrap();
        assert_eq!(m1["method"], "initialize");
        assert_eq!(m1["params"]["protocolVersion"], MCP_PROTOCOL_VERSION);
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools().expect("list ok");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0]["name"], "search");
        assert_eq!(listed[1]["name"], "fetch");
    }

    #[test]
    fn list_tools_empty_when_result_has_no_tools_key() {
        let server = wire(&[json!({"jsonrpc": "2.0", "id": 1, "result": {}})]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client.list_tools().expect_err("eof");
        assert!(
            matches!(err, ClientError::ServerClosed),
            "EOF -> ServerClosed, got {err:?}"
        );
    }

    /// Issue #646: a pending request whose response frame exceeds the byte
    /// cap surfaces as an explicit `Framing` error, not a hang until the
    /// wall-clock watchdog -- the over-long frame never yields the matched id,
    /// so the error return is the only observable outcome. The error display
    /// names the face (server transport) and the framing cause (the cap).
    #[test]
    fn overlong_response_frame_fails_request_as_framing_error() {
        // One over-long line: bigger than the cap, newline-terminated so the
        // bounded reader settles on `Overlong` (not a final unterminated
        // line).
        let mut server = "x".repeat(LINE_MAX_BYTES + 1).into_bytes();
        server.push(b'\n');
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client.list_tools().expect_err("over-long response");
        assert!(
            matches!(
                err,
                ClientError::Framing(ref e) if e.kind() == std::io::ErrorKind::InvalidData
            ),
            "over-long response -> Framing(InvalidData), got {err:?}"
        );
        let display = err.to_string();
        assert!(
            display.contains("framing error"),
            "the error names the transport face: {display}"
        );
        assert!(
            display.contains(&LINE_MAX_BYTES.to_string()),
            "the framing cause names the cap: {display}"
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
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
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        client.list_tools().expect("first call (id=1)");
        client.call("x", &json!({})).expect("second call (id=2)");
    }

    // --- SSE event parsing (issue #389) --------------------------------------

    /// `read_sse_event` parses one event terminated by a blank line. The
    /// `event:` and `data:` fields are captured; comments and unknown fields
    /// are skipped.
    #[test]
    fn read_sse_event_parses_event_and_data_fields() {
        let wire = b"event: endpoint\ndata: http://localhost:3001/message\n\n";
        let mut reader = Cursor::new(wire.to_vec());
        let event = read_sse_event(&mut reader)
            .expect("read")
            .expect("an event");
        assert_eq!(event.event.as_deref(), Some("endpoint"));
        assert_eq!(event.data, "http://localhost:3001/message");
    }

    /// Multiple `data:` lines within one event are joined with `\n` (the SSE
    /// spec contract). A single leading space after `data:` is stripped.
    #[test]
    fn read_sse_event_joins_multi_line_data() {
        let wire = b"data: line1\ndata: line2\ndata:  extra space\n\n";
        let mut reader = Cursor::new(wire.to_vec());
        let event = read_sse_event(&mut reader)
            .expect("read")
            .expect("an event");
        assert_eq!(event.data, "line1\nline2\n extra space");
    }

    /// An event with no `event:` field defaults to `None` (the SSE default
    /// event type is `"message"`, which the reader loop treats as a message).
    #[test]
    fn read_sse_event_defaults_event_to_none_when_absent() {
        let wire = b"data: {\"jsonrpc\":\"2.0\",\"id\":1}\n\n";
        let mut reader = Cursor::new(wire.to_vec());
        let event = read_sse_event(&mut reader)
            .expect("read")
            .expect("an event");
        assert!(event.event.is_none());
        assert_eq!(event.data, "{\"jsonrpc\":\"2.0\",\"id\":1}");
    }

    /// Comments (lines starting with `:`) and blank lines between events are
    /// skipped so keepalive gaps do not produce spurious empty events.
    #[test]
    fn read_sse_event_skips_comments_and_keepalive_blanks() {
        let wire = b": keepalive\n\nevent: message\ndata: hello\n\n";
        let mut reader = Cursor::new(wire.to_vec());
        let event = read_sse_event(&mut reader)
            .expect("read")
            .expect("an event");
        assert_eq!(event.event.as_deref(), Some("message"));
        assert_eq!(event.data, "hello");
    }

    /// A clean EOF (stream closed) at the start returns `Ok(None)` so the
    /// caller can distinguish "stream ended" from "partial event".
    #[test]
    fn read_sse_event_returns_none_at_clean_eof() {
        let mut reader = Cursor::new(Vec::new());
        let event = read_sse_event(&mut reader).expect("read on empty");
        assert!(event.is_none(), "EOF -> None, not error");
    }

    /// Two consecutive events: the first read returns event 1, the second
    /// returns event 2, and the third returns `None` (EOF).
    #[test]
    fn read_sse_event_reads_two_consecutive_events_then_eof() {
        let wire = b"event: endpoint\ndata: url1\n\nevent: message\ndata: msg1\n\n";
        let mut reader = Cursor::new(wire.to_vec());
        let e1 = read_sse_event(&mut reader)
            .expect("read 1")
            .expect("event 1");
        assert_eq!(e1.event.as_deref(), Some("endpoint"));
        assert_eq!(e1.data, "url1");
        let e2 = read_sse_event(&mut reader)
            .expect("read 2")
            .expect("event 2");
        assert_eq!(e2.event.as_deref(), Some("message"));
        assert_eq!(e2.data, "msg1");
        let e3 = read_sse_event(&mut reader).expect("read 3");
        assert!(e3.is_none(), "third read -> EOF");
    }

    /// Issue #647: a line longer than the cap voids the WHOLE in-progress
    /// event -- not just the offending line -- and the reader resyncs at the
    /// next blank-line boundary. Dropping only the line would stitch the
    /// surviving fields into a partial franken-event the consumer cannot
    /// parse; the next full event after the boundary parses normally.
    /// Issue #665: the survivor lines include an `event:` line and a comment
    /// -- the skip guard sits BEFORE field parsing, so a regression moving it
    /// below the `event:` arm still compiles and leaks the type into the next
    /// event, where the stitched data becomes malformed JSON and kills the
    /// whole transport (issue #647's escalation, one notch worse).
    #[test]
    fn read_sse_event_overlong_line_voids_event_and_resyncs_at_boundary() {
        // First `data:` line is 30 bytes (over the 16-byte cap); the short
        // survivors (`data: tail`, `event: leaked`, `: comment`) are skipped
        // during the resync, not stitched or leaked into the next event.
        let wire = format!(
            "data: {}\ndata: tail\nevent: leaked\n: comment\n\ndata: {{\"ok\":1}}\n\n",
            "a".repeat(24)
        );
        let mut reader = Cursor::new(wire.into_bytes());
        let event = read_sse_event_bounded(&mut reader, 16)
            .expect("read")
            .expect("the event after the voided one");
        assert!(
            event.event.is_none(),
            "the `event:` survivor must not leak into the next event"
        );
        assert_eq!(event.data, "{\"ok\":1}");
        // The stream continues past the drop: the next read is clean EOF.
        let next = read_sse_event_bounded(&mut reader, 16).expect("read 2");
        assert!(next.is_none(), "stream continues to clean EOF");
    }

    /// Issue #665: a second over-long line while STILL resyncing (two
    /// oversized lines in the same voided event -- the shape of an unbounded
    /// server) re-enters the void path idempotently: the accumulators are
    /// re-cleared (already empty) and the resync flag stays set. A regression
    /// that reset the flag or returned early on the second hit would stitch
    /// the survivors into the next event.
    #[test]
    fn read_sse_event_second_overlong_during_resync_stays_resyncing() {
        // Two 30-byte lines (over the 16-byte cap) inside one voided event,
        // each followed by a short survivor of a different field kind (12
        // and 10 bytes, well under the cap); the healthy event after the
        // boundary parses normally.
        let wire = format!(
            "data: {}\nevent: sv-a\ndata: {}\ndata: sv-b\n\ndata: ok\n\n",
            "a".repeat(24),
            "b".repeat(24)
        );
        let mut reader = Cursor::new(wire.into_bytes());
        let event = read_sse_event_bounded(&mut reader, 16)
            .expect("read")
            .expect("the healthy event after the double-voided one");
        assert!(
            event.event.is_none(),
            "the `event:` survivor must not leak after the re-void"
        );
        assert_eq!(
            event.data, "ok",
            "the `data:` survivors must not be stitched into the healthy event"
        );
    }

    /// The voided event's already-accumulated fields are cleared too: an
    /// `event:` line seen before the over-long line must not leak into the
    /// next event's type.
    #[test]
    fn read_sse_event_overlong_line_clears_accumulated_fields() {
        let wire = format!("event: ping\ndata: {}\n\ndata: x\n\n", "a".repeat(24));
        let mut reader = Cursor::new(wire.into_bytes());
        let event = read_sse_event_bounded(&mut reader, 16)
            .expect("read")
            .expect("event after the voided one");
        assert!(
            event.event.is_none(),
            "no field leaks from the voided event"
        );
        assert_eq!(event.data, "x");
    }

    /// Issue #647: the per-event `data:` accumulation budget (same source as
    /// the line cap) voids an event whose parts sum past it even when every
    /// individual line fits the line cap; the next event arrives normally.
    #[test]
    fn read_sse_event_data_budget_voids_oversized_event() {
        // Each line is 13 bytes (under the 16-byte line cap) but the three
        // parts, join bytes included, sum to 24 budget bytes (over the
        // budget; the breach lands on the third part).
        let wire = "data: 1234567\ndata: 1234567\ndata: 1234567\n\ndata: ok\n\n";
        let mut reader = Cursor::new(wire.as_bytes().to_vec());
        let event = read_sse_event_bounded(&mut reader, 16)
            .expect("read")
            .expect("the event after the voided one");
        assert_eq!(event.data, "ok");
    }

    /// EOF while still resyncing (the broken event never reached its blank
    /// boundary) drops the voided event: nothing half-parsed is returned.
    #[test]
    fn read_sse_event_eof_while_resyncing_returns_none() {
        let wire = format!("data: {}\ndata: tail", "a".repeat(24));
        let mut reader = Cursor::new(wire.into_bytes());
        let event = read_sse_event_bounded(&mut reader, 16).expect("read");
        assert!(
            event.is_none(),
            "EOF mid-resync -> None, not a partial event"
        );
    }

    /// Issue #665: the EOF arm's non-resync half -- fields already
    /// accumulated, no terminating blank line, then EOF -- returns the
    /// pending event rather than discarding it. A regression to an
    /// unconditional `None` would silently drop the stream's last
    /// unterminated event (every other fixture ends in a blank line, so this
    /// half had zero coverage).
    #[test]
    fn read_sse_event_returns_pending_event_at_eof_without_blank_line() {
        let wire = b"data: last";
        let mut reader = Cursor::new(wire.to_vec());
        let event = read_sse_event_bounded(&mut reader, 16)
            .expect("read")
            .expect("the unterminated final event is returned, not dropped");
        assert_eq!(event.data, "last");
    }

    /// Issue #647: a malformed `message` event propagates to the waiting
    /// consumer as a `Framing(InvalidData)` failure (the streamable-HTTP
    /// path's attribution) instead of warn-and-continue, which left the
    /// pending request hanging until the turn watchdog cancelled it. After
    /// propagating, the reader exits (drops the sender), so a later `recv()`
    /// reports the channel closed. Issue #665: the loop runs on a real
    /// thread and the test asserts its join result -- a reader that PANICKED
    /// on the malformed event would also drop the sender and pass the
    /// closed-channel assertion, so only the join distinguishes the clean
    /// `break` exit.
    #[test]
    fn sse_reader_loop_propagates_malformed_message_and_exits() {
        let (tx, rx) = mpsc::sync_channel(SSE_CHANNEL_BOUND);
        let wire = b"data: {\"id\":1,\"ok\":true}\n\ndata: not-json\n\n";
        // Finite input: the loop runs to its exit on its own thread (no stop
        // needed); the join result pins the exit as clean, not a panic.
        let reader_thread = thread::spawn(move || {
            sse_reader_loop(
                Cursor::new(wire.to_vec()),
                tx,
                Arc::new(AtomicBool::new(false)),
            );
        });
        let first = rx.recv().expect("healthy message forwarded");
        assert_eq!(first.expect("Ok"), json!({"id": 1, "ok": true}));
        let second = rx.recv().expect("malformed event forwarded as Err");
        match second {
            Err(ClientError::Framing(ref e)) => assert!(
                e.kind() == std::io::ErrorKind::InvalidData,
                "malformed -> Framing(InvalidData), got {e:?}"
            ),
            other => panic!("expected Err(Framing), got {other:?}"),
        }
        assert!(rx.recv().is_err(), "reader exits after propagating");
        reader_thread
            .join()
            .expect("reader exits via break after propagating, not a panic");
    }

    /// Issue #647, consumer side: a malformed `message` event fails the
    /// WAITING request in `SseClient::request` -- the full chain (reader
    /// loop → channel → the `Ok(Err(err))` arm), not just the send side
    /// pinned above. The POST endpoint is a one-shot `TcpListener` answering
    /// `202 Accepted` (the transport contract: the response arrives on the
    /// SSE stream, not in the POST's own body); the first forwarded message
    /// carries a foreign id, so the request is still waiting when the reader
    /// propagates the framing failure. A regression of the consumption arm
    /// to log-and-continue would leave this test hanging exactly like
    /// production hung pre-#647.
    #[test]
    fn sse_client_request_fails_fast_on_propagated_malformed_event() {
        use std::io::Read;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().expect("local addr").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept POST");
            // Read timeout: a stuck client fails this thread instead of
            // hanging the test (the ACP-chain e2e lesson).
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set read timeout");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            // Drain the full request (headers + Content-Length body) before
            // answering: closing with unread receive-buffer bytes makes
            // Windows send an RST that fails the client's status-line read
            // (os error 10053, a flake).
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break, // Client closed or stalled.
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf);
                        if let Some(headers_end) = text.find("\r\n\r\n") {
                            let content_length: usize = text[..headers_end]
                                .lines()
                                .filter_map(|l| l.split_once(':'))
                                .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, v)| v.trim().parse().ok())
                                .unwrap_or(0);
                            if buf.len() >= headers_end + 4 + content_length {
                                break;
                            }
                        }
                    }
                }
            }
            stream
                .write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n")
                .expect("write 202");
        });

        // The healthy message carries a foreign id (skipped by the waiting
        // request); the malformed event then reaches it as Err.
        let wire = b"data: {\"id\":99,\"ok\":true}\n\ndata: not-json\n\n";
        let (tx, rx) = mpsc::sync_channel(SSE_CHANNEL_BOUND);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_reader = stop.clone();
        let reader_thread = thread::spawn(move || {
            sse_reader_loop(Cursor::new(wire.to_vec()), tx, stop_for_reader);
        });

        let mut client = sse_client_with_parts(
            rx,
            format!("http://127.0.0.1:{port}/message"),
            stop,
            Some(reader_thread),
        );

        let err = client
            .request(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
            .expect_err("the malformed event fails the waiting request");
        match err {
            ClientError::Framing(ref e) => {
                assert_eq!(
                    e.kind(),
                    std::io::ErrorKind::InvalidData,
                    "malformed -> Framing(InvalidData), got {e:?}"
                );
                assert!(
                    e.to_string().contains("malformed JSON in SSE event"),
                    "the propagated wording, got {e}"
                );
            }
            other => panic!("expected Err(Framing), got {other:?}"),
        }
        server.join().expect("server thread");
    }

    /// Build an `SseClient` around hand-made reader plumbing (in-module
    /// construction, no HTTP handshake): shared by the tests that drive the
    /// channel / reader-thread lifecycle directly.
    fn sse_client_with_parts(
        response_rx: mpsc::Receiver<Result<Value, ClientError>>,
        post_url: String,
        stop: Arc<AtomicBool>,
        reader_thread: Option<thread::JoinHandle<()>>,
    ) -> SseClient {
        SseClient {
            response_rx,
            post_url,
            agent: ureq::AgentBuilder::new()
                .timeout_read(SSE_READ_TIMEOUT)
                .build(),
            stop,
            reader_thread,
            next_id: 1,
        }
    }

    /// Issue #667: `Drop` joins the reader thread, but a reader blocked in
    /// `send` on a full channel never re-checks the stop flag, and the
    /// receiver's destruction happens only after `drop()` returns -- after
    /// the join that never returns. The channel is filled to its bound
    /// BEFORE the reader starts, so the reader's first forward blocks
    /// deterministically; a pre-fix `Drop` hangs on the join and the 10 s
    /// timeout fails the test instead of hanging it. The post-fix order
    /// (release the receiver, then join) fails the blocked `send` with
    /// `SendError` and the reader exits via its channel-closed break.
    #[test]
    fn sse_client_drop_returns_when_reader_blocks_on_full_channel() {
        // An endless stream of one valid message event per read: the
        // flooding-server shape that keeps the reader trying to forward.
        // The read count lets the test WAIT for the reader to enter its
        // loop instead of sleeping a fixed interval (a sleep can pass
        // vacuously if the thread has not been scheduled yet).
        struct FloodReader {
            reads: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl std::io::Read for FloodReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.reads.fetch_add(1, Ordering::SeqCst);
                let event = b"data: {\"id\":1,\"ok\":true}\n\n";
                let n = event.len().min(buf.len());
                buf[..n].copy_from_slice(&event[..n]);
                Ok(n)
            }
        }

        let (tx, rx) = mpsc::sync_channel(SSE_CHANNEL_BOUND);
        // Fill the channel to its bound first: with no consumer, the
        // reader's very first forward blocks (deterministic hang shape).
        for _ in 0..SSE_CHANNEL_BOUND {
            tx.send(Ok(json!({"id": 1, "ok": true}))).expect("fill");
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_reader = stop.clone();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reads_for_reader = reads.clone();
        let reader_thread = thread::spawn(move || {
            sse_reader_loop(
                BufReader::new(FloodReader {
                    reads: reads_for_reader,
                }),
                tx,
                stop_for_reader,
            );
        });
        // Wait until the reader has actually entered its loop: one inner
        // read proves the stop check passed while stop was still false, and
        // from there the reader has no exit path before the blocked send.
        let mut started = false;
        for _ in 0..500 {
            if reads.load(Ordering::SeqCst) > 0 {
                started = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(started, "reader never reached its first read");

        let client = sse_client_with_parts(
            rx,
            "http://127.0.0.1:1/message".to_string(),
            stop,
            Some(reader_thread),
        );

        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            drop(client);
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("Drop returned within the timeout (no join hang)");
    }

    /// Issue #665: the reader's SECOND blocking send point -- the malformed
    /// event's error forward (`tx.send(Err(...))` in the reader loop) -- must
    /// also be released by `Drop`'s receiver release (the #667 fix). Same
    /// shape as the Ok-path pin above: the channel is filled to its bound
    /// BEFORE the reader starts, so the error forward blocks deterministically
    /// (no consumer ever drains); the counted first read proves the reader
    /// entered its loop while stop was still false -- from there it has no
    /// exit path before the blocked send.
    #[test]
    fn sse_client_drop_returns_when_malformed_error_forward_blocks_on_full_channel() {
        // One malformed message event on the first read, EOF after: the
        // reader parses it, serde fails, and the error forward blocks.
        struct MalformedReader {
            reads: Arc<std::sync::atomic::AtomicUsize>,
            first: bool,
        }
        impl std::io::Read for MalformedReader {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                self.reads.fetch_add(1, Ordering::SeqCst);
                if self.first {
                    self.first = false;
                    let event = b"data: not-json\n\n";
                    let n = event.len().min(buf.len());
                    buf[..n].copy_from_slice(&event[..n]);
                    Ok(n)
                } else {
                    Ok(0)
                }
            }
        }

        let (tx, rx) = mpsc::sync_channel(SSE_CHANNEL_BOUND);
        // Fill the channel to its bound first: with no consumer, the
        // malformed event's error forward blocks (deterministic hang shape).
        for _ in 0..SSE_CHANNEL_BOUND {
            tx.send(Ok(json!({"id": 1, "ok": true}))).expect("fill");
        }
        let stop = Arc::new(AtomicBool::new(false));
        let stop_for_reader = stop.clone();
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let reads_for_reader = reads.clone();
        let reader_thread = thread::spawn(move || {
            sse_reader_loop(
                BufReader::new(MalformedReader {
                    reads: reads_for_reader,
                    first: true,
                }),
                tx,
                stop_for_reader,
            );
        });
        // Wait until the reader has actually entered its loop: one inner
        // read proves the stop check passed while stop was still false, and
        // from there the reader has no exit path before the blocked send.
        let mut started = false;
        for _ in 0..500 {
            if reads.load(Ordering::SeqCst) > 0 {
                started = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(started, "reader never reached its first read");

        let client = sse_client_with_parts(
            rx,
            "http://127.0.0.1:1/message".to_string(),
            stop,
            Some(reader_thread),
        );

        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            drop(client);
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("Drop returned within the timeout (no join hang)");
    }

    /// `check_rpc_response` returns the `result` field on success and maps an
    /// `error` field to `ClientError::ServerError`.
    #[test]
    fn check_rpc_response_returns_result_on_success() {
        let msg = json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}});
        let result = check_rpc_response(&msg).expect("ok");
        assert_eq!(result, json!({"tools": []}));
    }

    #[test]
    fn check_rpc_response_maps_error_field_to_server_error() {
        let msg = json!({"jsonrpc": "2.0", "id": 1, "error": {"code": -1, "message": "bad"}});
        let err = check_rpc_response(&msg).expect_err("error field");
        assert!(
            matches!(err, ClientError::ServerError(_)),
            "error -> ServerError, got {err:?}"
        );
    }

    /// A response with neither `result` nor `error` (JSON-RPC protocol
    /// violation) is rejected as a framing error, not silently mapped to Null.
    #[test]
    fn check_rpc_response_rejects_envelope_without_result_or_error() {
        let msg = json!({"jsonrpc": "2.0", "id": 1});
        let err = check_rpc_response(&msg).expect_err("malformed response");
        assert!(
            matches!(err, ClientError::Framing(_)),
            "neither result nor error -> Framing, got {err:?}"
        );
    }

    // --- resolve_post_url SSRF guard (issue #389) -----------------------------

    /// A relative path like `/message` resolves against the SSE base URL.
    #[test]
    fn resolve_post_url_resolves_relative_path() {
        let url = resolve_post_url("http://localhost:3001/sse", "/message").expect("relative");
        assert_eq!(url, "http://localhost:3001/message");
    }

    /// An absolute http URL to a different host is accepted (the MCP SSE
    /// transport contract allows the server to advertise any http(s) endpoint).
    #[test]
    fn resolve_post_url_accepts_absolute_http_url() {
        let url = resolve_post_url("http://localhost:3001/sse", "http://other.host:8080/mcp")
            .expect("absolute");
        assert_eq!(url, "http://other.host:8080/mcp");
    }

    /// A `file://` scheme in the endpoint event is rejected (SSRF guard).
    #[test]
    fn resolve_post_url_rejects_file_scheme() {
        let err = resolve_post_url("http://localhost:3001/sse", "file:///etc/passwd")
            .expect_err("file:// rejected");
        let msg = err.to_string();
        assert!(
            msg.contains("must be http or https"),
            "file:// rejected with scheme error, got: {msg}"
        );
    }

    /// A `gopher://` scheme is rejected (SSRF guard — protocol smuggling).
    #[test]
    fn resolve_post_url_rejects_gopher_scheme() {
        let err = resolve_post_url("http://localhost:3001/sse", "gopher://attacker/x")
            .expect_err("gopher:// rejected");
        assert!(
            err.to_string().contains("must be http or https"),
            "gopher:// rejected with scheme error"
        );
    }

    /// A `data:` scheme is rejected (SSRF guard).
    #[test]
    fn resolve_post_url_rejects_data_scheme() {
        let err = resolve_post_url("http://localhost:3001/sse", "data:text/plain,evil")
            .expect_err("data: rejected");
        assert!(
            err.to_string().contains("must be http or https"),
            "data: rejected with scheme error"
        );
    }
}
