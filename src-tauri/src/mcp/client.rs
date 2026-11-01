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
//!   (legacy MCP SSE transport, issue #389).
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
//! cross-turn state, no session-level handle. Per-call timeouts are NOT
//! enforced per-read here: the transports carry no per-call deadline of
//! their own (a stdio read ends only at the child's stdout EOF, an SSE
//! response read is raced against the stop signal's wake, the SSE
//! connect-phase parks ride their own time bounds -- the GET header wait,
//! the `endpoint` event, every POST ack -- and an HTTP body read ends at
//! its [`HTTP_READ_TIMEOUT`] per-read bound), so the deadline lives one
//! layer up -- the aggregator parks the blocking call on a worker thread
//! and enforces
//! [`McpServerConfig::timeout_ms`](crate::mcp::config::McpServerConfig::timeout_ms)
//! / the gateway default via `recv_timeout`, terminating the transport
//! through [`TransportKill`] on expiry (issue #889).
//!
//! Async I/O, sync face (ADR-0139, #1455): the two remote transports ride
//! `reqwest` futures on the module's bridge runtime while the [`McpClient`]
//! trait stays synchronous -- the aggregator's deadline workers and the
//! probe's `spawn_blocking` closures call it from plain threads, bridged
//! one call at a time through [`block_on`]. The stdio transport joins them
//! on the same bridge since #1456: its child rides `tokio::process` (the
//! pipe reads are async-native), and its kill path terminates the whole
//! process tree (a Windows kill-on-close job object / a Unix process
//! group, the ADR-0108 executor precedent) instead of the bare
//! direct-child kill that orphaned a wrapper's grandchildren. The retired
//! sync design's compensation layers are gone with it: the SSE reader
//! thread's two-second stop-flag tick is now a `select!` race with an
//! immediate wake, and the HTTP per-read cap rides `tokio::time::timeout`.
//! When the aggregator's deadline face goes async (the chain's next
//! slices), the transports become natively async and the bridge runtime
//! retires.

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::io::{BufRead, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncWrite};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::bounded_line::{LineRead, LINE_MAX_BYTES};
use crate::mcp::config::{McpServerConfig, McpTransport};
use crate::mcp::MCP_PROTOCOL_VERSION;
use crate::process_tree::{self, TreeGuard};
use crate::runtime::gateway::framing;

/// HTTP per-read timeout (issue #392; async carry, #1455): every body-chunk
/// read on a streamable-HTTP response must progress within this bound, so a
/// hung server's blocking worker eventually terminates after the probe
/// deadline fires — `spawn_blocking` tasks are not cancelled, so without
/// this the thread + TCP connection would linger indefinitely.
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Bounded channel capacity for the body-chunk pumps (chunks, not messages:
/// one chunk carries whatever the transport layer yielded). Backpressures a
/// flooding server so the pump blocks on send rather than accumulating
/// unbounded body bytes in memory.
const BODY_CHANNEL_BOUND: usize = 64;

/// SSE ack window (the retired sync design's two-second read timeout, kept
/// as its honest core, #1455): the connect-phase `endpoint` event and every
/// POST acknowledgment must arrive within this window or the call fails.
/// The old agent's `timeout_read` carried this bound on every SSE read; the
/// stream's LATER reads are legitimately silent for long stretches (the
/// response to a POST may trail it indefinitely), so those ride the
/// stop-wake `select!` instead. The bound self-resolves the parks it covers
/// for a probe that fires no kill signal (issue #392); the response-wait
/// park carries no bound -- a server that acks POSTs but never streams
/// responses leaves that read parked until process exit (by then the
/// probe's outer deadline has already answered the user).
const SSE_ACK_TIMEOUT: Duration = Duration::from_secs(2);

/// The transport-side tokio runtime (ADR-0139, #1455): the remote transports
/// are async-native while their consumer face is still synchronous (it goes
/// async in the chain's aggregator slice). Each wire call bridges through
/// `block_on` here; the SSE stream pump tasks ride this runtime's workers.
/// Two parked threads when idle; retires with the sync face.
static TRANSPORT_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// Drive one transport future on the bridge runtime from a plain thread (an
/// aggregator deadline worker or a probe `spawn_blocking` closure). Never
/// called from an async context — the transports own every call site.
fn block_on<T>(fut: impl Future<Output = T>) -> T {
    transport_runtime().block_on(fut)
}

fn transport_runtime() -> &'static tokio::runtime::Runtime {
    TRANSPORT_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("the transport bridge runtime builds")
    })
}

/// The `tools/list` pagination guardrails (issue #900). A server may split
/// its tool list across pages joined by `nextCursor`; a server that never
/// stops paging (or keeps producing tools) would burn the entire connect
/// budget and surface as a generic timeout, or accumulate an unbounded
/// catalog, so the traversal is bounded: at most [`TOOLS_LIST_PAGE_CAP`]
/// pages, and no further page is fetched once the folded count reaches
/// [`TOOLS_LIST_TOOL_CAP`] while a cursor remains. Same order of magnitude
/// as other gateways' caps.
const TOOLS_LIST_PAGE_CAP: usize = 32;
const TOOLS_LIST_TOOL_CAP: usize = 2048;

/// One keychain-backed env value the gateway injects at spawn. The gateway
/// resolves these from the OS keychain via
/// [`crate::mcp::secrets::get_mcp_secret`] (ADR-0029) BEFORE constructing the
/// client, then passes the resolved `(env_key, value)` pairs in. The client
/// never touches the keychain -- it is pure transport, testable without one.
pub type SecretEnv = (String, String);

/// The SSE transport's stop signal: the flag half is what the sync
/// [`TransportKill::kill`] face writes from any thread; the `Notify` half
/// wakes a request parked in the async `select!` immediately. The retired
/// sync design polled the flag on a two-second read-timeout tick — the
/// whole point of the async carry (#1455) is that stop needs no tick.
pub struct SseStopSignal {
    stopped: AtomicBool,
    wake: tokio::sync::Notify,
}

impl SseStopSignal {
    fn new() -> Self {
        Self {
            stopped: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
        }
    }

    /// Set the flag and wake the parked reader now (one waiter per client;
    /// requests serialize through `&mut self`, and a request parked in the
    /// connect handshake is the same single waiter). Idempotent;
    /// `notify_one` leaves a stored permit for a caller that has not
    /// parked yet, so a stop racing the next request's `select!` arm still
    /// lands.
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

/// A cross-thread kill handle for one transport (issue #889). Cloned from
/// the owning client; [`TransportKill::kill`] makes that transport's
/// blocking read return so a parked caller unblocks:
/// - stdio: terminate the child's whole process tree (a `npx`/`uvx` wrapper
///   and its grandchildren die with it, #1456) -> the child's stdout EOFs
///   -> `read_message` reports `ServerClosed`;
/// - SSE: fire the stop signal -> a request parked in the stream-read
///   `select!` wakes immediately and reports `ServerClosed`;
/// - HTTP: no-op -- that transport is already bounded per-read
///   ([`HTTP_READ_TIMEOUT`], issue #392).
#[derive(Clone)]
pub enum TransportKill {
    /// Terminate the spawned stdio child's tree. Shared with the client's
    /// `Drop` (kill + reap stay single-owner through the mutex).
    StdioChild(Arc<Mutex<StdioChildHandle>>),
    /// Fire the SSE transport's stop signal (see [`SseStopSignal`]).
    SseStop(Arc<SseStopSignal>),
    /// Nothing to terminate (HTTP is per-read bounded).
    Http,
}

/// A spawned stdio server child plus its process-tree guard (#1456): the
/// direct child (reap, belt-and-braces kill) and the tree termination face
/// (a Windows kill-on-close job object / a Unix process group) travel as
/// one unit, so every kill path -- deadline expiry, cancel teardown, the
/// client's `Drop`, the probe's timeout -- takes the whole tree down
/// instead of orphaning a wrapper's grandchildren.
pub struct StdioChildHandle {
    child: Child,
    tree: Option<TreeGuard>,
}

impl std::fmt::Debug for StdioChildHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The child and the guard carry no Debug of their own; the pid is
        // the useful diagnostic.
        f.debug_struct("StdioChildHandle")
            .field("pid", &self.child.id())
            .field("tree", &self.tree.is_some())
            .finish()
    }
}

impl StdioChildHandle {
    /// Terminate the whole tree NOW, from any thread, without waiting: the
    /// tree guard fires (job terminate / killpg), then the direct child
    /// gets an explicit kill as the belt-and-braces backstop the guard's
    /// `None` degradation path relies on (ADR-0108 Decision 5). Idempotent
    /// -- killing an already-dead tree is a no-op, so deadline expiry and
    /// cancel teardown may both fire it. The pipes EOF immediately, which
    /// is what unblocks a parked read on the bridge runtime.
    pub fn kill(&mut self) {
        // Log the failures (issue #889 review): this kill is what the
        // deadline/cancel unwind rides on, so a failed kill must be
        // diagnosable in the field, not silent.
        if let Some(tree) = &self.tree {
            tree.kill_tree();
        }
        if let Err(e) = self.child.start_kill() {
            log::warn!(target: "toptopduck::mcp", "stdio transport kill failed: {e}");
        }
    }

    /// Kill the tree, then reap the child (`wait`): the probe path's
    /// orderly teardown, called from an async context where awaiting the
    /// reap is fine.
    pub async fn kill_and_reap(&mut self) {
        self.kill();
        if let Err(e) = self.reap().await {
            log::warn!(target: "toptopduck::mcp", "probe child reap failed: {e}");
        }
    }

    /// Reap the direct child (`wait`). A test seam over the same `wait` the
    /// reap inside [`Self::kill_and_reap`] rides -- the probe tests assert
    /// the reap (no zombie) rather than only log it.
    pub async fn reap(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }
}

impl Drop for StdioChildHandle {
    fn drop(&mut self) {
        // Belt-and-braces: an owner that drops without an explicit kill (a
        // probe abandoned mid-await, an unwinding worker) still takes the
        // tree down. The Unix zombie is reaped by tokio's orphan reaper
        // (the bridge runtime outlives every handle); the Windows job
        // handle closes inside TreeGuard's own Drop with kill-on-close.
        self.kill();
    }
}

impl TransportKill {
    /// Make the transport's blocking read return. Idempotent: killing an
    /// already-dead child or re-firing a stop signal is a harmless no-op, so
    /// deadline expiry and cancel teardown may both fire it.
    pub fn kill(&self) {
        match self {
            Self::StdioChild(child) => match child.lock() {
                Ok(mut handle) => handle.kill(),
                Err(_) => {
                    log::warn!(
                        target: "toptopduck::mcp",
                        "stdio transport kill skipped: the child lock is poisoned"
                    );
                }
            },
            Self::SseStop(signal) => signal.stop(),
            Self::Http => {}
        }
    }
}

/// The shared deadline-vs-spawn rendezvous for one connect (issue #889).
/// The transport `publish`es its [`TransportKill`] the moment the killable
/// resource exists; the deadline side `expire`s on
/// timeout. The two directions race:
/// expiry may land before spawn finishes (the handle is not published yet),
/// so publish re-checks the expired flag and self-terminates -- otherwise
/// the worker would park on the handshake read after the deadline with
/// nobody left to kill it, and the caller's scope join would never return.
#[derive(Default)]
pub struct ConnectKill {
    handle: Mutex<Option<TransportKill>>,
    expired: AtomicBool,
}

impl ConnectKill {
    /// The transport side: publish the kill handle; if the deadline already
    /// expired during the spawn, kill immediately. Single-shot per connect
    /// in practice -- a second publish would silently overwrite the slot,
    /// dropping the first handle without killing it (no current caller
    /// publishes twice).
    pub(crate) fn publish(&self, kill: TransportKill) {
        *self.handle.lock().expect("kill slot poisoned") = Some(kill.clone());
        if self.expired.load(Ordering::SeqCst) {
            kill.kill();
        }
    }

    /// The deadline side: mark the connect expired and kill whatever is
    /// published (a later [`Self::publish`] honors the flag).
    pub(crate) fn expire(&self) {
        self.expired.store(true, Ordering::SeqCst);
        if let Some(kill) = self.handle.lock().expect("kill slot poisoned").as_ref() {
            kill.kill();
        }
    }
}

/// The shared handle form passed into a `_with_kill` connect.
pub type KillSlot = Arc<ConnectKill>;

/// An unfilled [`KillSlot`] -- the no-kill default for the plain `connect`
/// signatures (the probe path runs under its own deadline, issue #392).
fn empty_kill_slot() -> KillSlot {
    Arc::new(ConnectKill::default())
}

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

    /// List the server's tools, following `nextCursor` pagination (issue
    /// #900). `server` is the configured display name, carried for log /
    /// error attribution the same way the #889 `Timeout` variant carries it.
    /// Returns the raw `tools` array entries (each is the server's own
    /// `{name, description, inputSchema}` shape); the gateway namespaces them
    /// (`mcp__<server_slug>__<tool>`) at aggregation time.
    ///
    /// The traversal folds every page into one list, deduplicating by tool
    /// name (first sight wins -- `query_catalog`'s catalog-fold precedent,
    /// issue #543) and bounded by the pagination guardrails: a server still
    /// paging at the page cap, or at the tool cap with a cursor outstanding,
    /// fails with [`ClientError::PageCap`] / [`ClientError::ToolCap`] so the
    /// connect paths record an explicit failure -- naming the tripped
    /// dimension -- instead of mounting a silently partial catalog.
    /// The whole traversal runs inside the caller's one connect-phase
    /// deadline (the #892 shared budget).
    fn list_tools(&mut self, server: &str) -> Result<Vec<Value>, ClientError> {
        let mut tools: Vec<Value> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut cursor: Option<String> = None;
        for page in 1..=TOOLS_LIST_PAGE_CAP {
            let params = match &cursor {
                Some(c) => json!({"cursor": c}),
                None => json!({}),
            };
            let id = self.next_id();
            let req = json!({"jsonrpc": "2.0", "id": id, "method": "tools/list", "params": params});
            let result = self.request(req)?;
            for tool in result
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                match tool.get("name").and_then(Value::as_str) {
                    Some(name) if seen.insert(name.to_string()) => tools.push(tool),
                    Some(name) => log::debug!(
                        target: "toptopduck::mcp",
                        "MCP server `{server}` re-listed tool `{name}` on tools/list \
                         page {page}; keeping the first-seen entry"
                    ),
                    // A nameless entry cannot be dedup-keyed; it rides
                    // through and is filtered by `extract_tool_info`
                    // downstream (issue #663).
                    None => tools.push(tool),
                }
            }
            let next = match result.get("nextCursor") {
                // Absent or null: the traversal is complete.
                None | Some(Value::Null) => return Ok(tools),
                Some(Value::String(c)) => c.clone(),
                // A non-string cursor is a protocol violation and a
                // silent-truncation hazard if read as absent (issue #900) --
                // fail the traversal instead.
                Some(_) => {
                    return Err(ClientError::Framing(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "tools/list nextCursor must be a string",
                    )))
                }
            };
            // The tool cap: an endless-page server that also floods tools
            // trips here without paying for the next request. The check is
            // post-fold, so the count routinely crosses the cap; the error
            // carries the true folded count. Exactly at the cap with NO
            // cursor is a complete catalog (accepted -- the cap guards
            // unbounded traversal, not a complete response).
            if tools.len() >= TOOLS_LIST_TOOL_CAP {
                return Err(ClientError::ToolCap {
                    server: server.to_string(),
                    pages: page,
                    tools: tools.len(),
                });
            }
            log::debug!(
                target: "toptopduck::mcp",
                "MCP server `{server}` tools/list page {page}: {} tools so far, cursor \
                 present -- continuing",
                tools.len()
            );
            cursor = Some(next);
        }
        // The loop spent its page budget with a cursor still outstanding --
        // the page cap: fail the connect, mount no partial catalog.
        Err(ClientError::PageCap {
            server: server.to_string(),
            tools: tools.len(),
        })
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

/// The async twin of [`FramedClient`] (ADR-0139, #1456): the same
/// newline-framed MCP JSON-RPC conversation over `tokio::process` pipe
/// halves. The [`McpClient`] implementation bridges each wire call through
/// [`block_on`] -- the sync consumer face (the aggregator's deadline
/// workers, the probe's `spawn_blocking` closures) is unchanged, which is
/// what lets the stdio transport go async one slice ahead of the
/// aggregator (the chain's #1457). The request loop mirrors
/// `FramedClient::request` statement for statement; the framing faces'
/// equivalence tests pin the read/write halves in lockstep.
struct AsyncFramedClient<R, W> {
    reader: R,
    writer: W,
    next_id: i64,
}

impl<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin> AsyncFramedClient<R, W> {
    fn new(reader: R, writer: W) -> Self {
        Self {
            reader,
            writer,
            next_id: 1,
        }
    }
}

impl<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin> McpClient for AsyncFramedClient<R, W> {
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        let id = req.get("id").cloned();
        block_on(framing::write_message_async(&mut self.writer, &req))
            .map_err(ClientError::Framing)?;
        loop {
            let msg = block_on(framing::read_message_async(&mut self.reader))
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
        block_on(framing::write_message_async(&mut self.writer, &notif))
            .map_err(ClientError::Framing)
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
/// - line level: lines longer than the cap are dropped by the bounded
///   line reader;
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
///
/// Async since #1455: the remote transports read bodies through the chunk
/// pump, so the line source is `AsyncBufRead` -- the parsing statements and
/// the [`EventAccumulator`] state machine are the sync design's verbatim,
/// only the line-read call is awaited.
async fn read_sse_event(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
) -> std::io::Result<Option<SseEvent>> {
    read_sse_event_bounded(reader, LINE_MAX_BYTES).await
}

/// The per-event parsing state of [`read_sse_event_bounded`]: the fields
/// accumulated for the event being built, or `Voided` after a cap breach (an
/// over-long line or an over-budget `data:` accumulation) drops the whole
/// in-progress event. Voiding is a single whole-value assignment -- the
/// "resyncing implies an empty accumulator" invariant is carried by the
/// type's representation, not by each breach site remembering a
/// four-statement clearing sequence; the field methods are only reachable
/// while `Building` (the resync pre-block guards that, and each method
/// asserts it) (issue #666).
enum EventAccumulator {
    Building {
        event_type: Option<String>,
        data_parts: Vec<String>,
        data_bytes: usize,
    },
    Voided,
}

impl EventAccumulator {
    fn building() -> Self {
        EventAccumulator::Building {
            event_type: None,
            data_parts: Vec::new(),
            data_bytes: 0,
        }
    }

    /// Set the `event:` field type (the last `event:` line wins, per the SSE
    /// spec). A voided event's lines never reach field parsing -- the resync
    /// pre-block in [`read_sse_event_bounded`] skips them -- so the `Voided`
    /// arm is unreachable and a no-op.
    fn set_event_type(&mut self, event_type: String) {
        debug_assert!(matches!(self, EventAccumulator::Building { .. }));
        let EventAccumulator::Building {
            event_type: slot, ..
        } = self
        else {
            return; // Unreachable behind the resync pre-block.
        };
        *slot = Some(event_type);
    }

    /// Accumulate one `data:` field line under the per-event budget (`max`,
    /// the same cap source as the line level): `true` while the event still
    /// fits, `false` once the accumulated cost breaches the budget (the event
    /// must be voided). Like [`Self::set_event_type`], only called while
    /// `Building`; a `false` return leaves the accumulator untouched.
    fn push_data(&mut self, data: &str, max: usize) -> bool {
        debug_assert!(matches!(self, EventAccumulator::Building { .. }));
        let EventAccumulator::Building {
            data_parts,
            data_bytes,
            ..
        } = self
        else {
            return false; // Unreachable behind the resync pre-block.
        };
        // The +1 is the "\n" the join in `finish` inserts between parts:
        // counting it keeps zero-length parts (each costing one budget
        // byte) from growing `data_parts` without bound, and bounds the
        // joined string's length.
        if *data_bytes + data.len() + 1 > max {
            return false;
        }
        *data_bytes += data.len() + 1;
        data_parts.push(data.to_string());
        true
    }

    /// Extract the completed event -- the single construction point shared by
    /// the blank-line boundary and the EOF arm. `None` when nothing was
    /// accumulated (a leading blank line, or a clean close) or when a voided
    /// event never reached its boundary; the accumulator is left building a
    /// fresh event either way.
    fn finish(&mut self) -> Option<SseEvent> {
        match std::mem::replace(self, EventAccumulator::building()) {
            EventAccumulator::Building {
                event_type,
                data_parts,
                ..
            } => {
                if data_parts.is_empty() && event_type.is_none() {
                    None
                } else {
                    Some(SseEvent {
                        event: event_type,
                        data: data_parts.join("\n"),
                    })
                }
            }
            EventAccumulator::Voided => None,
        }
    }
}

/// The cap-parameterized core of [`read_sse_event`]. The `max` parameter
/// exists for the unit tests (small caps keep fixtures tiny -- the same
/// convention as [`read_line_bounded`]); every production caller passes
/// [`LINE_MAX_BYTES`].
async fn read_sse_event_bounded<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<SseEvent>> {
    let mut acc = EventAccumulator::building();

    loop {
        let line = match crate::bounded_line::read_line_bounded_async(&mut *reader, max).await? {
            LineRead::Eof => {
                // EOF: return any buffered event, else None (clean close).
                // A voided event that never reached its boundary is dropped.
                return Ok(acc.finish());
            }
            LineRead::Overlong => {
                log::warn!(
                    target: "toptopduck::mcp",
                    "SSE event dropped: line exceeds {max} bytes; resyncing at the next event boundary"
                );
                acc = EventAccumulator::Voided;
                continue;
            }
            LineRead::Line(line) => line,
        };

        let trimmed = line.trim_end_matches(['\r', '\n']);

        // Resync pre-block -- the single skip point for a voided event's
        // surviving lines: every line up to and including the blank-line
        // boundary is dropped, and the field parser below never sees any of
        // them. The boundary switches back to building the next event.
        if matches!(acc, EventAccumulator::Voided) {
            if trimmed.is_empty() {
                acc = EventAccumulator::building();
            }
            continue;
        }

        if trimmed.is_empty() {
            // Blank line = event boundary. Leading blank lines (before any
            // field) are skipped so a keepalive gap does not produce an empty
            // event.
            if let Some(event) = acc.finish() {
                return Ok(Some(event));
            }
            continue;
        }

        if trimmed.starts_with(':') {
            continue; // SSE comment (keepalive)
        } else if let Some(rest) = trimmed.strip_prefix("event:") {
            acc.set_event_type(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("data:") {
            // Per the SSE spec, a single leading space after the colon is
            // stripped; everything else (including additional spaces) is
            // retained as data.
            let data = rest.strip_prefix(' ').unwrap_or(rest);
            if !acc.push_data(data, max) {
                log::warn!(
                    target: "toptopduck::mcp",
                    "SSE event dropped: accumulated data exceeds {max} bytes; resyncing at the next event boundary"
                );
                acc = EventAccumulator::Voided;
                continue;
            }
        }
        // id:, retry:, and unknown fields are silently ignored.
    }
}

/// The failure attribution for malformed JSON in an SSE event's data,
/// shared by the two payload consumers (the streamable-HTTP response path
/// and the legacy-SSE request loop's stream read): `Framing(InvalidData)`
/// carrying the payload length and the serde error, matching the stdio
/// path's framing::read_message contract. One source keeps the two
/// attributions from drifting (issue #666; previously a verbatim copy at
/// each site).
fn malformed_sse_event(data_len: usize, e: serde_json::Error) -> ClientError {
    ClientError::Framing(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        format!("malformed JSON in SSE event ({data_len} bytes): {e}"),
    ))
}

/// Production wrapper: an [`AsyncFramedClient`] backed by a spawned stdio
/// MCP server's stdin/stdout (tokio pipes since #1456). Owns the child and
/// its tree guard; `Drop` terminates the whole tree (per-turn lifecycle,
/// issue #301 Q2; wrapper grandchildren die with it, #1456).
///
/// Only the stdio transport is constructed here; SSE / HTTP transports have
/// their own client types ([`SseClient`], [`HttpClient`]). The dispatcher
/// [`connect_transport`] routes by transport variant; a non-stdio config
/// handed straight to `connect_with_kill` still fails loudly in
/// `stdio_command`'s `UnsupportedTransport` guard rather than silently
/// spawning a bogus child.
pub struct StdioClient {
    inner: AsyncFramedClient<tokio::io::BufReader<ChildStdout>, ChildStdin>,
    /// Shared so the deadline / cancel-kill paths can terminate the tree
    /// while a blocking read holds the rest of the client (issue #889).
    child: Arc<Mutex<StdioChildHandle>>,
}

impl StdioClient {
    /// Spawn the configured stdio server, perform the MCP initialize
    /// handshake, and return the connected client. `secrets` are the
    /// keychain-resolved `(env_key, value)` pairs (from
    /// [`McpServerConfig::keychain_env_keys`]); they are injected into the
    /// child env alongside [`McpServerConfig::env`] (the non-secret values).
    /// The child handle is published to the [`KillSlot`] the moment it is
    /// spawned, so a deadline hit during the initialize handshake (whose
    /// blocking read has no native timeout) can terminate it (issue #889).
    pub fn connect_with_kill(
        config: &McpServerConfig,
        secrets: &[SecretEnv],
        tool_output_dir: Option<&str>,
        kill_slot: &KillSlot,
    ) -> Result<Self, ClientError> {
        let mut child = stdio_command(config, secrets, tool_output_dir)?.spawn()?;
        let stdin = child.stdin.take().ok_or(ClientError::NoChildStdin)?;
        let stdout = child.stdout.take().ok_or(ClientError::NoChildStdout)?;
        let tree = process_tree::guard(&child);
        let child = Arc::new(Mutex::new(StdioChildHandle { child, tree }));
        kill_slot.publish(TransportKill::StdioChild(Arc::clone(&child)));
        let mut client = StdioClient {
            inner: AsyncFramedClient::new(tokio::io::BufReader::new(stdout), stdin),
            child,
        };
        client.initialize()?;
        Ok(client)
    }

    /// The cross-thread kill handle (issue #889).
    pub fn kill_handle(&self) -> TransportKill {
        TransportKill::StdioChild(Arc::clone(&self.child))
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
        // The turn is over; terminate the tree rather than wait for a
        // graceful exit. The retired sync design flushed stdin first -- a
        // no-op on the bare pipe (no user-space buffer) -- then killed and
        // reaped under the lock; the async carry cannot `block_on` the reap
        // here (this Drop may land on any thread, including a runtime
        // worker where block_on would panic), so the Unix zombie rides
        // tokio's orphan reaper on the evergreen bridge runtime and the
        // Windows job handle closes kill-on-close in TreeGuard's own Drop.
        // The lock only contends while a deadline / cancel kill is
        // mid-flight (kill returns without holding it, issue #889).
        match self.child.lock() {
            Ok(mut handle) => handle.kill(),
            Err(_) => {
                log::warn!(
                    target: "toptopduck::mcp",
                    "stdio child kill at drop skipped: the child lock is poisoned"
                );
            }
        }
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
/// [`StdioClient::connect_with_kill`] and [`spawn_stdio_child`]). Extracts the command +
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
    // The std-command face carries both platform hooks (the Unix process
    // group and the no-window flag live on std's builder API).
    {
        let std_cmd = cmd.as_std_mut();
        process_tree::prepare_command(std_cmd);
        crate::util::no_window(std_cmd);
    }
    Ok(cmd)
}

/// Spawn the configured stdio server child process WITHOUT driving the MCP
/// handshake (issue #392). Returns the [`StdioChildHandle`] (the child plus
/// its tree guard) so the caller owns the lifecycle — specifically, the
/// async `probe_mcp_server` command retains the handle outside its
/// `spawn_blocking` closure so a timeout can kill the tree. The caller
/// takes the child's stdin/stdout and drives [`stdio_handshake`] inside a
/// blocking task.
///
/// This is split from [`StdioClient::connect_with_kill`] (which couples
/// spawn + initialize in one call) because `spawn_blocking` tasks are NOT
/// cancellable — if the handshake hangs inside the task, the only way to
/// guarantee the child is killed is to keep the handle outside.
pub fn spawn_stdio_child(
    config: &McpServerConfig,
    secrets: &[SecretEnv],
) -> Result<StdioChildHandle, ClientError> {
    let child = stdio_command(config, secrets, None)?.spawn()?;
    let tree = process_tree::guard(&child);
    Ok(StdioChildHandle { child, tree })
}

/// Drive the MCP initialize + tools/list handshake on already-spawned stdio
/// pipe halves (issue #392). Returns the raw tool list on success. Used by
/// the probe command which owns the child handle externally (for timeout
/// kill); this function performs only the wire I/O (bridged one call at a
/// time onto the transport runtime), not process management.
pub fn stdio_handshake(
    stdin: ChildStdin,
    stdout: ChildStdout,
    server: &str,
) -> Result<Vec<Value>, ClientError> {
    let mut client = AsyncFramedClient::new(tokio::io::BufReader::new(stdout), stdin);
    client.initialize()?;
    client.list_tools(server)
}

// ---------------------------------------------------------------------------
// Body pump + chunk reader (the async I/O shell, #1455)
// ---------------------------------------------------------------------------

/// Spawn a task on the transport runtime that drains `response`'s body into
/// a bounded chunk channel, and return the channel's reader side. This is
/// what lets [`read_sse_event`] keep its buffered-reader contract on the
/// async face: reqwest yields the body as chunk futures, and the
/// bounded channel carries the flooding-server backpressure the retired
/// design's `SSE_CHANNEL_BOUND` had.
///
/// `read_timeout` (the HTTP face's per-read bound, issue #392) wraps every
/// chunk read: elapsed sends the timeout error downstream and ends the pump
/// -- each socket read must progress within the bound, exactly the retired
/// ureq `timeout_read` semantics. `None` (the SSE GET stream) means no
/// bound: the stream is legitimately silent for long stretches, and the
/// consumer's stop-wake `select!` is the only break.
///
/// The pump ends at EOF (the receiver sees EOF), on a body error (forwarded
/// as an error chunk), or when the receiver drops (send fails). No stop
/// signal needed: the pump never outlives its reader.
///
/// A PANICKING pump would drop the sender without an error chunk, and the
/// reader would read the closed channel as a clean EOF -- an internal
/// transport bug aliased to "server closed" with no diagnostic anywhere
/// (the spawned task's JoinHandle is discarded, so tokio swallows the
/// payload). [`PumpPanicGuard`] forwards a fault chunk on unwind instead.
fn spawn_body_pump(mut response: reqwest::Response, read_timeout: Option<Duration>) -> ChunkReader {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(BODY_CHANNEL_BOUND);
    transport_runtime().spawn(async move {
        let _panic_guard = PumpPanicGuard(&tx);
        loop {
            // Race the read against the receiver's demise: a consumer
            // dropped mid-park cannot cancel a parked chunk read, and
            // without this race the pump (and the connection it holds)
            // would linger until the server deigns to send a byte.
            let chunk: Result<Option<Bytes>, std::io::Error> = tokio::select! {
                chunk = async {
                    match read_timeout {
                        Some(bound) => match tokio::time::timeout(bound, response.chunk()).await {
                            Ok(chunk) => chunk.map_err(|e| std::io::Error::other(e.to_string())),
                            Err(_elapsed) => Err(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                format!("no body bytes within {bound:?} (per-read bound)"),
                            )),
                        },
                        None => response
                            .chunk()
                            .await
                            .map_err(|e| std::io::Error::other(e.to_string())),
                    }
                } => chunk,
                _ = tx.closed() => return, // Receiver dropped (client gone).
            };
            match chunk {
                Ok(Some(bytes)) => {
                    if tx.send(Ok(bytes)).await.is_err() {
                        break; // Receiver dropped between the race and the send.
                    }
                }
                Ok(None) => break, // EOF: the dropped sender closes the channel.
                Err(e) => {
                    // Surface the fault (per-read timeout or transport
                    // error) to the waiting read instead of a clean EOF --
                    // the pump cannot log-and-exit without stranding the
                    // consumer.
                    let _ = tx.send(Err(e)).await;
                    break;
                }
            }
        }
    });
    ChunkReader {
        rx,
        buf: Bytes::new(),
    }
}

/// Unwind guard carried by the pump task: on a panic, forward a fault chunk
/// to the reader so the failure surfaces as an error read, not a clean EOF
/// (see [`spawn_body_pump`]). `try_send` because `Drop` cannot await; if the
/// channel is full the reader still ends at EOF once the sender drops --
/// degraded, but only when the guard fires, which is already a bug path.
struct PumpPanicGuard<'a>(&'a tokio::sync::mpsc::Sender<Result<Bytes, std::io::Error>>);

impl Drop for PumpPanicGuard<'_> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            let _ = self
                .0
                .try_send(Err(std::io::Error::other("body pump task failed (panic)")));
        }
    }
}

/// `AsyncBufRead` over the pump's channel: `poll_fill_buf` polls the
/// receiver, an error chunk (a per-read timeout, a transport fault)
/// surfaces verbatim, and the channel closing reads as EOF. `Unpin` by
/// construction -- both halves of the transport are driven from plain
/// threads through [`block_on`].
struct ChunkReader {
    rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
    buf: Bytes,
}

impl tokio::io::AsyncRead for ChunkReader {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        out: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        match tokio::io::AsyncBufRead::poll_fill_buf(std::pin::Pin::new(&mut *this), cx) {
            std::task::Poll::Ready(Ok(bytes)) => {
                let n = bytes.len().min(out.remaining());
                out.put_slice(&bytes[..n]);
                tokio::io::AsyncBufRead::consume(std::pin::Pin::new(this), n);
                std::task::Poll::Ready(Ok(()))
            }
            std::task::Poll::Ready(Err(e)) => std::task::Poll::Ready(Err(e)),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

impl tokio::io::AsyncBufRead for ChunkReader {
    fn poll_fill_buf(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<&[u8]>> {
        let this = self.get_mut();
        while this.buf.is_empty() {
            match this.rx.poll_recv(cx) {
                std::task::Poll::Ready(Some(Ok(bytes))) => {
                    this.buf = bytes;
                    // A zero-length chunk carries nothing; poll the next one.
                    if this.buf.is_empty() {
                        continue;
                    }
                }
                std::task::Poll::Ready(Some(Err(e))) => return std::task::Poll::Ready(Err(e)),
                std::task::Poll::Ready(None) => return std::task::Poll::Ready(Ok(&[])), // EOF
                std::task::Poll::Pending => return std::task::Poll::Pending,
            }
        }
        std::task::Poll::Ready(Ok(&this.buf))
    }

    fn consume(self: std::pin::Pin<&mut Self>, amt: usize) {
        let this = self.get_mut();
        this.buf = this.buf.slice(amt..);
    }
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
    /// Request headers attached to every POST (issue #901) -- the transport's
    /// configured non-secret values merged with the keychain-resolved secret
    /// values at dispatch time.
    headers: BTreeMap<String, String>,
    /// The shared async egress client (ADR-0139's construction seam): a
    /// clone of the process singleton, same pool as the live turns.
    client: reqwest::Client,
    /// The per-call bound (issue #392's async carry): the POST send, both
    /// body flavors, and notification acks each ride it. A field so the
    /// timeout pin can inject a small bound instead of waiting out the
    /// 30 s production constant.
    read_timeout: Duration,
    next_id: i64,
}

impl HttpClient {
    /// Connect to the HTTP endpoint and perform the MCP initialize handshake.
    pub fn connect(url: &str, headers: &BTreeMap<String, String>) -> Result<Self, ClientError> {
        Self::connect_with_kill(url, headers, &empty_kill_slot())
    }

    /// [`Self::connect`] with a [`KillSlot`] (issue #889). HTTP is bounded
    /// per-read ([`HTTP_READ_TIMEOUT`]), so the slot holds the no-op handle
    /// purely for kill-shape uniformity across transports.
    ///
    /// The egress client never follows redirects (issue #901 guardrail):
    /// `Policy::none` hands a 3xx back as an Ok response, and
    /// [`check_no_redirect`] refuses it on the status -- reqwest's redirect
    /// hops only strip `authorization`/`cookie`, so following one would
    /// forward any custom credential header to an arbitrary origin (the
    /// #244 egress-agent precedent).
    pub fn connect_with_kill(
        url: &str,
        headers: &BTreeMap<String, String>,
        kill_slot: &KillSlot,
    ) -> Result<Self, ClientError> {
        let mut client = Self::with_parts(url, headers, HTTP_READ_TIMEOUT)?;
        kill_slot.publish(TransportKill::Http);
        client.initialize()?;
        Ok(client)
    }

    /// Construct the client around the shared egress singleton without any
    /// handshake. The named construction point both public entries share.
    fn with_parts(
        url: &str,
        headers: &BTreeMap<String, String>,
        read_timeout: Duration,
    ) -> Result<Self, ClientError> {
        Ok(Self {
            url: url.to_string(),
            headers: headers.clone(),
            client: crate::egress::async_client().map_err(|e| {
                ClientError::Http(format!("egress client construction failed: {e}"))
            })?,
            read_timeout,
            next_id: 1,
        })
    }

    /// The cross-thread kill handle (issue #889) -- the no-op variant.
    pub fn kill_handle(&self) -> TransportKill {
        TransportKill::Http
    }

    /// Build the POST request with [`Self::headers`] attached (issue #901).
    fn post(&self) -> reqwest::RequestBuilder {
        apply_headers(self.client.post(&self.url), &self.headers)
    }

    /// Test-only: a client at a URL nothing listens on. The aggregator's
    /// catalog / resolve paths never touch the transport; routing against
    /// this client fails with a connection error -- exactly the failure
    /// shape the dispatch-composition pins exercise.
    #[cfg(test)]
    pub(crate) fn unreachable_for_test(url: &str) -> Self {
        Self::with_parts(url, &BTreeMap::new(), HTTP_READ_TIMEOUT)
            .expect("the egress singleton builds")
    }

    /// Test-only: an unconnected client with an injected per-read bound, so
    /// the timeout pin observes a silent SSE body in milliseconds instead
    /// of the 30 s production constant.
    #[cfg(test)]
    pub(crate) fn for_test_with_read_timeout(url: &str, read_timeout: Duration) -> Self {
        Self::with_parts(url, &BTreeMap::new(), read_timeout).expect("the egress singleton builds")
    }
}

impl McpClient for HttpClient {
    /// POST one JSON-RPC request and await its response. The server may
    /// respond with `application/json` (single JSON-RPC envelope) or
    /// `text/event-stream` (SSE carrying the envelope). Both are handled;
    /// the response is matched by JSON-RPC `id`.
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        let id = req.get("id").cloned();
        block_on(async {
            // The send (connect + headers) rides read_timeout as one TOTAL
            // budget -- like the retired ureq agent's read timeout it covers
            // the header wait, so a server that never answers fails here
            // instead of parking the caller (issue #392's wind-down
            // guarantee; the kill for this transport is a no-op by design).
            // Unlike the retired per-read bound it also stops a slow-drip
            // header phase, which per-read never expired in total.
            let send = tokio::time::timeout(self.read_timeout, self.post().json(&req).send()).await;
            let response = match send {
                Ok(send) => send.map_err(|e| ClientError::Http(e.to_string()))?,
                Err(_) => {
                    return Err(ClientError::Http(format!(
                        "no response within {:?} (per-read bound)",
                        self.read_timeout
                    )))
                }
            };
            check_no_redirect(&response)?;
            check_status(&response)?;
            let content_type = content_type(&response);
            if content_type.contains("text/event-stream") {
                // Streamable-HTTP SSE response: read events and find the
                // matching JSON-RPC response by id (notifications without id
                // are skipped). The pump bounds every chunk read by
                // [`Self::read_timeout`] -- a silent body surfaces as a
                // `Framing(TimedOut)` error, the #392 per-read cap.
                let mut reader = spawn_body_pump(response, Some(self.read_timeout));
                loop {
                    let event = read_sse_event(&mut reader)
                        .await
                        .map_err(ClientError::Framing)?;
                    match event {
                        Some(event) => match serde_json::from_str::<Value>(&event.data) {
                            Ok(msg) => {
                                if msg.get("id") == id.as_ref() && id.is_some() {
                                    return check_rpc_response(&msg);
                                }
                            }
                            Err(e) => {
                                return Err(malformed_sse_event(event.data.len(), e));
                            }
                        },
                        None => return Err(ClientError::ServerClosed),
                    }
                }
            } else {
                // Plain JSON response, read through the bounded pump so the
                // per-read bound covers the body too (the retired agent's
                // read timeout bounded every byte, not just the headers).
                use tokio::io::AsyncReadExt as _;
                let mut reader = spawn_body_pump(response, Some(self.read_timeout));
                let mut body = Vec::new();
                reader
                    .read_to_end(&mut body)
                    .await
                    .map_err(ClientError::Framing)?;
                let body: Value =
                    serde_json::from_slice(&body).map_err(|e| ClientError::Http(e.to_string()))?;
                check_rpc_response(&body)
            }
        })
    }

    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError> {
        block_on(post_notification(self.post(), notif, self.read_timeout))
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
/// The stream's body is pumped by a runtime task ([`spawn_body_pump`]) into
/// a bounded chunk channel whose receiver side ([`ChunkReader`]) reads
/// events on demand; a request parked on a silent stream is raced against
/// the stop signal's wake ([`SseStopSignal`]) so a kill lands immediately
/// — the retired sync design polled a stop flag on a two-second read
/// timeout instead. `Drop` has no side effects: dropping the receiver ends
/// the pump (its send fails), which tears the connection down with it.
pub struct SseClient {
    /// The GET stream's body reader (pump task → bounded channel → this
    /// receiver). Reading is on demand inside `request`; no reader task
    /// parses ahead.
    stream: ChunkReader,
    /// The POST endpoint URL (from the server's initial `endpoint` event).
    post_url: String,
    /// Request headers attached to the SSE GET stream and every POST
    /// (issue #901) -- the transport's configured non-secret values merged
    /// with the keychain-resolved secret values at dispatch time.
    headers: BTreeMap<String, String>,
    /// The shared async egress client (ADR-0139's construction seam): a
    /// clone of the process singleton, same pool as the live turns.
    client: reqwest::Client,
    /// The stop signal shared with the kill face (issue #889).
    stop: Arc<SseStopSignal>,
    /// Set once the stream is dead for good -- a malformed message event
    /// propagated to a waiting request (issue #647), the async carry of
    /// the retired reader-thread exit closing the channel. Later requests
    /// fail fast with `ServerClosed` instead of reading a poisoned stream.
    poisoned: bool,
    next_id: i64,
}

impl SseClient {
    /// Open the SSE stream, read the endpoint event, and perform the MCP
    /// initialize handshake. A caller handing a non-empty header map is by
    /// definition header-authenticated (the same-origin guardrail applies);
    /// the dispatch path derives the flag from the CONFIGURED face instead
    /// (see [`Self::connect_with_kill`]).
    pub fn connect(url: &str, headers: &BTreeMap<String, String>) -> Result<Self, ClientError> {
        Self::connect_with_kill(url, headers, !headers.is_empty(), &empty_kill_slot())
    }

    /// [`Self::connect`] with a [`KillSlot`] (issue #889). The stop signal
    /// is published the moment it exists -- BEFORE the GET -- so a deadline
    /// or cancel that lands during the handshake breaks the in-flight GET
    /// or the parked response read through the same wake (the retired sync
    /// design could not interrupt a blocking GET at all).
    ///
    /// The egress client never follows redirects (issue #901 guardrail; see
    /// [`HttpClient::connect_with_kill`]). When `auth_configured` is set --
    /// ANY header configured on the server, secret-named or not -- the
    /// endpoint event's POST URL must share the SSE URL's origin
    /// ([`enforce_same_origin`]): the POST target comes from the server's
    /// own event, so without the guard a compromised server could aim the
    /// authenticated POST (and its headers) at any host it chooses.
    ///
    /// `auth_configured` INVARIANT (issue #904): the caller derives it from
    /// the CONFIGURED faces via [`sse_auth_configured`] (the transport's
    /// `headers` map and `keychain_header_keys` list), never from the merged
    /// runtime map -- a declared secret whose keychain value is missing
    /// still trips the guard. A future caller hand-rolling the bool must
    /// route through the named derivation, not pass `false` alongside
    /// credentials.
    pub fn connect_with_kill(
        url: &str,
        headers: &BTreeMap<String, String>,
        auth_configured: bool,
        kill_slot: &KillSlot,
    ) -> Result<Self, ClientError> {
        let client = crate::egress::async_client()
            .map_err(|e| ClientError::Http(format!("egress client construction failed: {e}")))?;
        let stop = Arc::new(SseStopSignal::new());
        kill_slot.publish(TransportKill::SseStop(Arc::clone(&stop)));
        let stop_for_race = Arc::clone(&stop);

        let connect = block_on(async {
            // The GET is raced against the stop wake: a kill landing before
            // or during the open breaks the connect immediately.
            let get = apply_headers(
                client
                    .get(url)
                    .header(reqwest::header::ACCEPT, "text/event-stream"),
                headers,
            );
            // The GET open rides HTTP_READ_TIMEOUT as one total budget: a
            // server that never answers its headers fails here instead of
            // parking the caller. (The retired agent bounded this same wait
            // at its 2 s read timeout -- the carry loosens a fully silent
            // server to 30 s and tightens slow-drip headers, which a
            // per-read bound never expired in total.)
            let response = tokio::select! {
                r = tokio::time::timeout(HTTP_READ_TIMEOUT, get.send()) => match r {
                    Ok(send) => send.map_err(|e| ClientError::Http(e.to_string()))?,
                    Err(_) => return Err(ClientError::Http(format!(
                        "SSE GET not answered within {HTTP_READ_TIMEOUT:?}"
                    ))),
                },
                _ = stop_for_race.wake.notified() => return Err(ClientError::ServerClosed),
            };
            check_no_redirect(&response)?;
            check_status(&response)?;
            let face = content_type(&response);
            if !face.contains("text/event-stream") {
                return Err(ClientError::Http(format!(
                    "SSE endpoint returned non-event-stream content-type: {face}"
                )));
            }

            let mut stream = spawn_body_pump(response, None);

            // The first event MUST be `event: endpoint` carrying the POST URL
            // (the MCP legacy SSE transport contract). Rejecting anything
            // else prevents a misbehaving server's message payload from
            // being used as the POST target. Raced against the stop wake
            // (a kill in this window breaks the connect immediately, the
            // same select as the parked reads) and bounded by the ack
            // window (a stream that opens but never carries the endpoint
            // event fails here, the retired tick's self-resolving core).
            let first_event = tokio::select! {
                r = tokio::time::timeout(SSE_ACK_TIMEOUT, read_sse_event(&mut stream)) => {
                    match r {
                        Ok(read) => read
                            .map_err(ClientError::Framing)?
                            .ok_or(ClientError::ServerClosed)?,
                        Err(_) => return Err(ClientError::Http(format!(
                            "no endpoint event within {SSE_ACK_TIMEOUT:?}"
                        ))),
                    }
                }
                _ = stop_for_race.wake.notified() => return Err(ClientError::ServerClosed),
            };
            if first_event.event.as_deref() != Some("endpoint") {
                return Err(ClientError::Framing(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "expected `event: endpoint` first, got {:?}",
                        first_event.event
                    ),
                )));
            }
            // Resolve the POST URL relative to the SSE URL (the server may
            // send a relative path like `/message`). Reject non-http(s)
            // schemes to prevent SSRF via a compromised server's endpoint
            // event.
            let post_url = resolve_post_url(url, &first_event.data)?;
            // Header-authenticated servers additionally require the POST URL
            // to share the SSE stream's origin (issue #901 guardrail two).
            if auth_configured {
                enforce_same_origin(url, &post_url)?;
            }
            Ok::<_, ClientError>((stream, post_url))
        });
        // The pump (if one started) ends with the receiver's drop on an
        // early return here.
        let (stream, post_url) = connect?;

        let mut client = Self {
            stream,
            post_url,
            headers: headers.clone(),
            client,
            stop,
            poisoned: false,
            next_id: 1,
        };

        client.initialize()?;
        Ok(client)
    }

    /// The cross-thread kill handle (issue #889).
    pub fn kill_handle(&self) -> TransportKill {
        TransportKill::SseStop(Arc::clone(&self.stop))
    }

    /// Build the POST request with [`Self::headers`] attached (issue #901).
    fn post(&self) -> reqwest::RequestBuilder {
        apply_headers(self.client.post(&self.post_url), &self.headers)
    }
}

impl McpClient for SseClient {
    /// POST one JSON-RPC request and await the matching response from the
    /// SSE stream. Notifications (no `id`) and responses for other ids are
    /// skipped.
    fn request(&mut self, req: Value) -> Result<Value, ClientError> {
        if self.poisoned || self.stop.is_stopped() {
            return Err(ClientError::ServerClosed);
        }
        let id = req.get("id").cloned();
        block_on(async {
            // The POST response is typically 202 Accepted; the actual
            // JSON-RPC response arrives on the SSE stream. Both the POST
            // and every stream read are raced against the stop wake so a
            // kill lands immediately (issue #889).
            // The POST ack rides the SSE ack window (the retired agent's
            // read bound); the RESPONSE itself arrives on the stream below
            // and may legally trail by minutes.
            let response = tokio::select! {
                r = tokio::time::timeout(SSE_ACK_TIMEOUT, self.post().json(&req).send()) => {
                    match r {
                        Ok(send) => send.map_err(|e| ClientError::Http(e.to_string()))?,
                        Err(_) => return Err(ClientError::Http(format!(
                            "POST not acknowledged within {SSE_ACK_TIMEOUT:?}"
                        ))),
                    }
                }
                _ = self.stop.wake.notified() => return Err(ClientError::ServerClosed),
            };
            check_no_redirect(&response)?;
            check_status(&response)?;
            loop {
                // Re-check before parking: a stop that fired between
                // requests leaves a stored permit, but a select whose read
                // arm wins the race could have consumed it unheard.
                if self.stop.is_stopped() {
                    return Err(ClientError::ServerClosed);
                }
                let event = tokio::select! {
                    e = read_sse_event(&mut self.stream) => match e {
                        Ok(ev) => ev,
                        Err(err) => {
                            // A stream fault means the pump is dead for good
                            // (the SSE GET pump carries no read bound, so
                            // every error here is a transport fault, never a
                            // timeout) and the channel closes behind it.
                            // Poison like the malformed case so later calls
                            // refuse at the entry check without burning a
                            // POST round against the corpse.
                            self.poisoned = true;
                            return Err(ClientError::Framing(err));
                        }
                    },
                    _ = self.stop.wake.notified() => return Err(ClientError::ServerClosed),
                };
                // Only `message` events (the default type when `event:` is
                // omitted) carry JSON-RPC payloads; anything else is skipped.
                let event = match event {
                    Some(ev) if ev.event.as_deref().map(|e| e == "message").unwrap_or(true) => ev,
                    Some(_) => continue,
                    // EOF: the stream is dead for good -- poison so later
                    // calls refuse at the entry check instead of paying a
                    // POST round for the EOF to repeat itself.
                    None => {
                        self.poisoned = true;
                        return Err(ClientError::ServerClosed);
                    }
                };
                match serde_json::from_str::<Value>(&event.data) {
                    Ok(msg) => {
                        if !msg.is_object() {
                            continue; // Not a JSON-RPC message; skipped.
                        }
                        if msg.get("id") != id.as_ref() || id.is_none() {
                            continue;
                        }
                        return check_rpc_response(&msg);
                    }
                    Err(e) => {
                        // Malformed JSON in a message event (issue #647):
                        // the waiting request's response is unrecoverable --
                        // fail it fast with the streamable-HTTP path's
                        // attribution instead of hanging until the turn
                        // watchdog cancels -- and poison the stream so later
                        // requests fail fast too (the retired reader thread
                        // exited after forwarding, closing the channel).
                        self.poisoned = true;
                        return Err(malformed_sse_event(event.data.len(), e));
                    }
                }
            }
        })
    }

    fn send_notification(&mut self, notif: Value) -> Result<(), ClientError> {
        block_on(post_notification(self.post(), notif, SSE_ACK_TIMEOUT))
    }

    fn next_id(&mut self) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        id
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
/// A non-2xx (redirect included) is refused by the shared response checks
/// (issue #901).
async fn post_notification(
    request: reqwest::RequestBuilder,
    notif: Value,
    ack_timeout: Duration,
) -> Result<(), ClientError> {
    let send = tokio::time::timeout(ack_timeout, request.json(&notif).send()).await;
    let response = match send {
        Ok(send) => send.map_err(|e| ClientError::Http(e.to_string()))?,
        Err(_) => {
            return Err(ClientError::Http(format!(
                "POST not acknowledged within {ack_timeout:?}"
            )))
        }
    };
    // A notification's 3xx is still an explicit redirect refusal (issue
    // #901), not a silent drop -- the handshake ack must not quietly vanish.
    check_no_redirect(&response)?;
    check_status(&response)
}

/// Attach `headers` to a request (issue #901): the one injection loop shared
/// by both remote transports' POST builders and the SSE GET open.
fn apply_headers(
    builder: reqwest::RequestBuilder,
    headers: &BTreeMap<String, String>,
) -> reqwest::RequestBuilder {
    let mut builder = builder;
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    builder
}

/// Guard the no-redirect client's SUCCESS path (issue #901): reqwest under
/// `Policy::none` returns a 3xx as an Ok response (verified down the
/// vendored tower-http chain in the preflight migration's review), so the
/// redirect refusal is checked on the response status itself. Following
/// would forward custom credential headers to an arbitrary origin (the #244
/// egress-agent lesson), so the refusal must name the redirect explicitly.
fn check_no_redirect(response: &reqwest::Response) -> Result<(), ClientError> {
    let code = response.status().as_u16();
    if (300..400).contains(&code) {
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("<no Location header>");
        return Err(ClientError::Http(format!(
            "HTTP {code} redirect to {location} refused: redirects are not followed"
        )));
    }
    Ok(())
}

/// Refuse non-2xx statuses as transport-level HTTP errors: the retired ureq
/// face surfaced statuses >= 400 from its error channel (an `Err` from
/// send), while reqwest hands every status back as Ok — this check keeps
/// the old classification, so a 404 with a JSON body reads as an HTTP
/// fault, not as a bogus JSON-RPC envelope.
fn check_status(response: &reqwest::Response) -> Result<(), ClientError> {
    if !response.status().is_success() {
        return Err(ClientError::Http(format!(
            "HTTP error status {}",
            response.status().as_u16()
        )));
    }
    Ok(())
}

/// The response's Content-Type face, borrowed for the `text/event-stream`
/// contains-checks (absent header reads as empty).
fn content_type(response: &reqwest::Response) -> &str {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

/// Whether an SSE connect counts as header-authenticated for the same-origin
/// guardrail -- the one named derivation every caller must share (issue #904;
/// the guardrail itself is issue #901 guardrail two). Inputs are the CONFIGURED
/// faces (`transport.headers` + `keychain_header_keys`), NOT the merged
/// runtime map: a declared secret name whose keychain value is missing still
/// counts (the credential rides the POST the moment the value appears), so
/// deriving from the merged map would silently disarm the guard. The test
/// handshake entry [`SseClient::connect`] deliberately uses its own
/// merged-nonempty rule (self-contained + documented there); every production
/// caller goes through [`connect_transport_with_kill`], which routes here.
pub(crate) fn sse_auth_configured(
    configured_headers: &BTreeMap<String, String>,
    declared_keys: &[String],
) -> bool {
    !configured_headers.is_empty() || !declared_keys.is_empty()
}

/// The SSE same-origin guardrail (issue #901): when a server carries
/// authenticated headers, the endpoint event's POST URL must share the SSE
/// stream URL's origin (scheme + host + port). The POST target comes from
/// the server's own event, so a compromised server could otherwise aim the
/// authenticated POST at any host it chooses. The error names both origins.
fn enforce_same_origin(sse_url: &str, post_url: &str) -> Result<(), ClientError> {
    let parse = |raw: &str| {
        url::Url::parse(raw).map_err(|e| ClientError::Http(format!("invalid url: {e}")))
    };
    let sse = parse(sse_url)?;
    let post = parse(post_url)?;
    if sse.origin() == post.origin() {
        return Ok(());
    }
    Err(ClientError::Http(format!(
        "SSE endpoint event advertised a cross-origin POST url {}; refusing: this server \
         sends authenticated headers and the POST target must share the SSE origin {}",
        post.origin().ascii_serialization(),
        sse.origin().ascii_serialization(),
    )))
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

impl TransportClient {
    /// The cross-thread kill handle for the concrete transport (issue #889).
    pub fn kill_handle(&self) -> TransportKill {
        match self {
            Self::Stdio(c) => c.kill_handle(),
            Self::Sse(c) => c.kill_handle(),
            Self::Http(c) => c.kill_handle(),
        }
    }
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
/// handshake and returns a ready-to-use [`TransportClient`]. No kill slot --
/// the probe path that uses this runs under its own deadline (issue #392);
/// the aggregator deadline path uses [`connect_transport_with_kill`].
pub fn connect_transport(
    config: &McpServerConfig,
    secrets: &[SecretEnv],
    header_secrets: &[SecretEnv],
    tool_output_dir: Option<&str>,
) -> Result<TransportClient, ClientError> {
    connect_transport_with_kill(
        config,
        secrets,
        header_secrets,
        tool_output_dir,
        &empty_kill_slot(),
    )
}

/// [`connect_transport`] with a [`KillSlot`] the caller reads on deadline
/// expiry (issue #889): each transport publishes its [`TransportKill`] as
/// soon as the killable resource exists, covering the initialize-handshake
/// park (a stdio child that spawns but never responds).
///
/// `header_secrets` are the keychain-resolved `(header_name, value)` pairs
/// (issue #901), merged over the transport's configured non-secret `headers`
/// here -- the one composition point, so both remote transports receive the
/// complete header set and neither client type knows the keychain exists.
pub fn connect_transport_with_kill(
    config: &McpServerConfig,
    secrets: &[SecretEnv],
    header_secrets: &[SecretEnv],
    tool_output_dir: Option<&str>,
    kill_slot: &KillSlot,
) -> Result<TransportClient, ClientError> {
    match &config.transport {
        McpTransport::Stdio { .. } => {
            StdioClient::connect_with_kill(config, secrets, tool_output_dir, kill_slot)
                .map(TransportClient::Stdio)
        }
        McpTransport::Sse { url, headers } => {
            let auth_configured = sse_auth_configured(headers, &config.keychain_header_keys);
            SseClient::connect_with_kill(
                url,
                &merged_headers(headers, header_secrets),
                auth_configured,
                kill_slot,
            )
            .map(TransportClient::Sse)
        }
        McpTransport::Http { url, headers } => {
            HttpClient::connect_with_kill(url, &merged_headers(headers, header_secrets), kill_slot)
                .map(TransportClient::Http)
        }
    }
}

/// Merge a transport's configured non-secret headers with its keychain
/// resolved secret values (issue #901). A secret name cannot legally sit in
/// the configured map (the read-time scan refuses it), so the two sources
/// never collide in practice; `extend` is simply the order-insensitive
/// composition.
fn merged_headers(
    configured: &BTreeMap<String, String>,
    secrets: &[SecretEnv],
) -> BTreeMap<String, String> {
    let mut merged = configured.clone();
    merged.extend(secrets.iter().cloned());
    merged
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
    /// The per-call deadline expired (issue #889): `server` names the
    /// configured server, `call` the protocol step that hung
    /// (`connect (initialize/tools/list)` for the connect phase -- one
    /// shared budget, issue #892 -- or the `tools/call` tool name), and
    /// `timeout_ms` the effective budget (per-server override or gateway
    /// default). The transport was terminated -- subsequent calls to this
    /// server fail fast for the rest of the turn.
    #[error("MCP server `{server}` {call} timed out after {timeout_ms}ms; the server is unavailable for the rest of the turn")]
    Timeout {
        server: String,
        call: String,
        timeout_ms: u64,
    },
    /// The `tools/list` traversal tripped the page cap (issue #900): the
    /// server still returned a `nextCursor` after the page budget was spent.
    /// `tools` is what the traversal had folded when it tripped. The connect
    /// paths record the message as the server's failure reason -- the
    /// gateway mounts no silently-partial catalog.
    #[error("MCP server `{server}` tools/list still returned a cursor after {} pages (the page cap, {} tools folded); the server is not mounted -- no partial catalog", TOOLS_LIST_PAGE_CAP, tools)]
    PageCap { server: String, tools: usize },
    /// The `tools/list` traversal tripped the tool cap (issue #900): the
    /// traversal had folded `tools` entries -- at or past the cap -- with a
    /// cursor still outstanding, and refused to pay for the next page.
    /// `pages` is where the traversal stood. The connect paths record the
    /// message as the server's failure reason -- the gateway mounts no
    /// silently-partial catalog.
    #[error("MCP server `{server}` tools/list folded {tools} tools (the tool cap is {}), on page {pages}, still paging; the server is not mounted -- no partial catalog", TOOLS_LIST_TOOL_CAP)]
    ToolCap {
        server: String,
        pages: usize,
        tools: usize,
    },
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
        let listed = client.list_tools("fake-mcp").expect("list ok");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0]["name"], "search");
        assert_eq!(listed[1]["name"], "fetch");
    }

    #[test]
    fn list_tools_empty_when_result_has_no_tools_key() {
        let server = wire(&[json!({"jsonrpc": "2.0", "id": 1, "result": {}})]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools("fake-mcp").expect("list ok");
        assert!(listed.is_empty(), "missing tools key -> empty, not error");
    }

    // --- tools/list pagination (issue #900) -----------------------------------

    /// Issue #900: a `tools/list` response carrying `nextCursor` is followed
    /// -- the continuation request echoes the cursor in `params`, and the
    /// pages fold into one list in advertised order. A page with no cursor
    /// ends the traversal.
    #[test]
    fn list_tools_follows_next_cursor_pages() {
        let server = wire(&[
            json!({"jsonrpc": "2.0", "id": 1, "result": {
                "tools": [
                    {"name": "echo", "description": "page 1"},
                    {"name": "add", "description": "page 1"}
                ],
                "nextCursor": "page-2"
            }}),
            json!({"jsonrpc": "2.0", "id": 2, "result": {
                "tools": [{"name": "fetch_page2", "description": "page 2"}]
            }}),
        ]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools("fake-mcp").expect("list ok");
        let names: Vec<&str> = listed
            .iter()
            .map(|t| t["name"].as_str().expect("name"))
            .collect();
        assert_eq!(names, vec!["echo", "add", "fetch_page2"]);
        // The continuation request carried the cursor the previous page
        // handed back; the first request carried none.
        let mut r = Cursor::new(client.writer.get_ref().clone());
        let req1 = framing::read_message(&mut r).unwrap().unwrap();
        let req2 = framing::read_message(&mut r).unwrap().unwrap();
        assert!(
            req1["params"]["cursor"].is_null(),
            "first request carries no cursor: {req1}"
        );
        assert_eq!(req2["params"]["cursor"], "page-2");
    }

    /// Issue #900: a server that never stops paging (every page returns a
    /// fresh `nextCursor`) trips the page cap -- an explicit error naming
    /// the server, the tripped dimension, and where the traversal stood,
    /// never a silently partial catalog (the #889 attribution shape).
    #[test]
    fn list_tools_page_cap_trips_on_an_endingless_cursor() {
        let pages: Vec<Value> = (1..=TOOLS_LIST_PAGE_CAP)
            .map(|i| {
                json!({
                    "jsonrpc": "2.0", "id": i, "result": {
                        "tools": [{"name": format!("tool_{i}")}],
                        "nextCursor": format!("page-{i}")
                    }
                })
            })
            .collect();
        let server = wire(&pages);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client.list_tools("cap-fake").expect_err("page cap");
        let display = err.to_string();
        match err {
            ClientError::PageCap { server, tools } => {
                assert_eq!(server, "cap-fake");
                assert_eq!(tools, TOOLS_LIST_PAGE_CAP);
            }
            other => panic!("expected PageCap, got {other:?}"),
        }
        assert!(display.contains("cap-fake"), "names the server: {display}");
        assert!(
            display.contains("page cap"),
            "names the tripped dimension: {display}"
        );
    }

    /// Issue #900: the tool cap -- a server whose accumulated entries reach
    /// the cap while STILL paging trips its own dimension, without paying
    /// for the next request. The at-cap complete-catalog companion below
    /// pins the boundary's other half.
    #[test]
    fn list_tools_tool_cap_trips_when_still_paging() {
        let tools: Vec<Value> = (0..TOOLS_LIST_TOOL_CAP)
            .map(|i| json!({"name": format!("tool_{i}")}))
            .collect();
        let server = wire(&[json!({
            "jsonrpc": "2.0", "id": 1, "result": {
                "tools": tools,
                "nextCursor": "page-2"
            }
        })]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client.list_tools("cap-fake").expect_err("tool cap");
        let display = err.to_string();
        match err {
            ClientError::ToolCap {
                server,
                pages,
                tools,
            } => {
                assert_eq!(server, "cap-fake");
                assert_eq!(pages, 1, "trips on the page that reached the cap");
                assert_eq!(tools, TOOLS_LIST_TOOL_CAP, "carries the true folded count");
            }
            other => panic!("expected ToolCap, got {other:?}"),
        }
        assert!(
            display.contains("tool cap"),
            "names the tripped dimension: {display}"
        );
    }

    /// The overshoot half: the cap check is post-fold, so one page can push
    /// the count past the cap -- the error must carry the real total, not
    /// the constant (a constant-at-the-cap report would read 2048 here).
    #[test]
    fn list_tools_tool_cap_carries_the_overshot_count() {
        let tools: Vec<Value> = (0..TOOLS_LIST_TOOL_CAP + 100)
            .map(|i| json!({"name": format!("tool_{i}")}))
            .collect();
        let server = wire(&[json!({
            "jsonrpc": "2.0", "id": 1, "result": {
                "tools": tools,
                "nextCursor": "page-2"
            }
        })]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client.list_tools("cap-fake").expect_err("tool cap");
        match err {
            ClientError::ToolCap { tools, .. } => {
                assert_eq!(tools, TOOLS_LIST_TOOL_CAP + 100, "the overshot total");
            }
            other => panic!("expected ToolCap, got {other:?}"),
        }
    }

    /// The at-boundary half (the #666 at-budget pattern): exactly
    /// `TOOLS_LIST_TOOL_CAP` entries in a complete page -- no continuation
    /// -- is accepted, not tripped. The cap guards unbounded traversal; a
    /// complete single response is already bounded by the frame cap.
    #[test]
    fn list_tools_accepts_a_cap_sized_complete_catalog() {
        let tools: Vec<Value> = (0..TOOLS_LIST_TOOL_CAP)
            .map(|i| json!({"name": format!("tool_{i}")}))
            .collect();
        let server = wire(&[json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": tools}})]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client
            .list_tools("cap-fake")
            .expect("a complete at-cap catalog is accepted");
        assert_eq!(listed.len(), TOOLS_LIST_TOOL_CAP);
    }

    /// The page-budget at-boundary half (the #666 at-budget pattern,
    /// mirroring the tool-cap companion above): 32 pages each carrying one
    /// tool, with page 32 cursorless -- completing exactly ON the last
    /// allowed page returns the full catalog; only needing a 33rd page
    /// trips the cap.
    #[test]
    fn list_tools_accepts_a_cap_sized_page_run_completing_on_the_last_page() {
        let pages: Vec<Value> = (1..=TOOLS_LIST_PAGE_CAP)
            .map(|i| {
                let mut result = json!({"tools": [{"name": format!("tool_{i}")}]});
                if i < TOOLS_LIST_PAGE_CAP {
                    result["nextCursor"] = json!(format!("page-{i}"));
                }
                json!({"jsonrpc": "2.0", "id": i, "result": result})
            })
            .collect();
        let server = wire(&pages);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client
            .list_tools("cap-fake")
            .expect("completing on the page budget's last page is accepted");
        assert_eq!(listed.len(), TOOLS_LIST_PAGE_CAP);
    }

    /// Issue #900 AC: an empty first page that continues to an empty second
    /// page is a valid zero-tool catalog, not a failure.
    #[test]
    fn list_tools_empty_pages_are_a_valid_zero_tool_catalog() {
        let server = wire(&[
            json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": [], "nextCursor": "p2"}}),
            json!({"jsonrpc": "2.0", "id": 2, "result": {"tools": []}}),
        ]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools("fake-mcp").expect("zero-tool catalog ok");
        assert!(listed.is_empty());
    }

    /// Issue #900: a server re-listing a tool name on a later page must not
    /// shadow its first-seen entry -- cross-page dedup keeps the page-1
    /// entry (`query_catalog`'s catalog-fold precedent, issue #543).
    #[test]
    fn list_tools_cross_page_duplicate_keeps_first_sight() {
        let server = wire(&[
            json!({"jsonrpc": "2.0", "id": 1, "result": {
                "tools": [
                    {"name": "dup", "description": "first sight"},
                    {"name": "keep", "description": "page 1"}
                ],
                "nextCursor": "p2"
            }}),
            json!({"jsonrpc": "2.0", "id": 2, "result": {
                "tools": [{"name": "dup", "description": "later shadow"}]
            }}),
        ]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools("fake-mcp").expect("list ok");
        assert_eq!(listed.len(), 2, "the re-listed name folds to one entry");
        let dup = listed
            .iter()
            .find(|t| t["name"] == "dup")
            .expect("the dup entry");
        assert_eq!(dup["description"], "first sight");
    }

    /// Issue #900: `nextCursor` must be a string (or absent/null). A
    /// non-string cursor is a protocol violation AND a silent-truncation
    /// hazard -- treating it as absent would recreate the bug class this
    /// traversal exists to close -- so it surfaces as a framing error.
    #[test]
    fn list_tools_non_string_next_cursor_is_a_framing_error() {
        let server = wire(&[json!({
            "jsonrpc": "2.0", "id": 1,
            "result": {"tools": [], "nextCursor": 7}
        })]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client
            .list_tools("fake-mcp")
            .expect_err("non-string cursor");
        assert!(
            matches!(
                err,
                ClientError::Framing(ref e) if e.kind() == std::io::ErrorKind::InvalidData
            ),
            "non-string cursor -> Framing(InvalidData), got {err:?}"
        );
    }

    /// Nameless entries cannot be dedup-keyed; they ride through verbatim
    /// and are filtered downstream by `extract_tool_info` (issue #663 -- a
    /// malformed entry never reaches the catalog, so the usable count stays
    /// honest).
    #[test]
    fn list_tools_nameless_entries_ride_through_without_dedup() {
        let server = wire(&[
            json!({"jsonrpc": "2.0", "id": 1, "result": {
                "tools": [{"description": "no name"}, {"description": "no name either"}],
                "nextCursor": "p2"
            }}),
            json!({"jsonrpc": "2.0", "id": 2, "result": {"tools": []}}),
        ]);
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let listed = client.list_tools("fake-mcp").expect("list ok");
        assert_eq!(listed.len(), 2);
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
        let err = client.list_tools("fake-mcp").expect_err("eof");
        assert!(
            matches!(err, ClientError::ServerClosed),
            "EOF -> ServerClosed, got {err:?}"
        );
    }

    /// Issue #646: a pending request whose response frame exceeds the byte
    /// cap surfaces as an explicit `Framing` error, not a silent hang: the
    /// over-long frame never yields the matched id, and a gateway-served MCP
    /// call is a frozen segment under ADR-0115 -- the no-progress clock never
    /// fires mid-wait -- so the error return is the only exit. The error
    /// display names the face (server transport) and the framing cause (the
    /// cap).
    #[test]
    fn overlong_response_frame_fails_request_as_framing_error() {
        // One over-long line: bigger than the cap, newline-terminated so the
        // bounded reader settles on `Overlong` (not a final unterminated
        // line).
        let mut server = "x".repeat(LINE_MAX_BYTES + 1).into_bytes();
        server.push(b'\n');
        let mut client = FramedClient::new(Cursor::new(server), Cursor::new(Vec::new()));
        let err = client
            .list_tools("fake-mcp")
            .expect_err("over-long response");
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
        let listed = client
            .list_tools("fake-mcp")
            .expect("list ok past notification");
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
        let listed = client.list_tools("fake-mcp").expect("list ok");
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
        client.list_tools("fake-mcp").expect("first call (id=1)");
        client.call("x", &json!({})).expect("second call (id=2)");
    }

    // --- ConnectKill rendezvous (issue #889) ----------------------------------

    /// The publish-after-expire ordering: `expire` may land before the
    /// transport has published its kill handle (a spawn that outlasts the
    /// budget), and the re-check inside `publish` is what kills the LATE
    /// handle -- without it the worker parks on the handshake read after
    /// the deadline with nobody left to kill it. The stop-signal variant
    /// makes the kill observable without a process: a `publish` that
    /// merely stores the handle leaves the flag unset and fails this pin.
    #[test]
    fn connect_kill_publish_after_expire_self_terminates_the_handle() {
        let slot = ConnectKill::default();
        slot.expire();
        let stop = Arc::new(SseStopSignal::new());
        slot.publish(TransportKill::SseStop(Arc::clone(&stop)));
        assert!(
            stop.is_stopped(),
            "publish after expire must kill the late handle, not just store it"
        );
    }

    /// The forward ordering for contrast: publishing BEFORE expiry stores
    /// the handle without firing it (the transport is healthy); the later
    /// `expire` performs the kill itself.
    #[test]
    fn connect_kill_expire_after_publish_fires_the_stored_handle() {
        let slot = ConnectKill::default();
        let stop = Arc::new(SseStopSignal::new());
        slot.publish(TransportKill::SseStop(Arc::clone(&stop)));
        assert!(
            !stop.is_stopped(),
            "a healthy connect's publish does not fire its own kill"
        );
        slot.expire();
        assert!(stop.is_stopped(), "expire kills whatever is published");
    }

    // --- SSE event parsing (issue #389; async face since #1455) --------------------------------------

    /// `read_sse_event` parses one event terminated by a blank line. The
    /// `event:` and `data:` fields are captured; comments and unknown fields
    /// are skipped.
    #[tokio::test]
    async fn read_sse_event_parses_event_and_data_fields() {
        let wire = b"event: endpoint\ndata: http://localhost:3001/message\n\n";
        let mut reader: &[u8] = &wire[..];
        let event = read_sse_event(&mut reader)
            .await
            .expect("read")
            .expect("an event");
        assert_eq!(event.event.as_deref(), Some("endpoint"));
        assert_eq!(event.data, "http://localhost:3001/message");
    }

    /// Multiple `data:` lines within one event are joined with `\n` (the SSE
    /// spec contract). A single leading space after `data:` is stripped.
    #[tokio::test]
    async fn read_sse_event_joins_multi_line_data() {
        let wire = b"data: line1\ndata: line2\ndata:  extra space\n\n";
        let mut reader: &[u8] = &wire[..];
        let event = read_sse_event(&mut reader)
            .await
            .expect("read")
            .expect("an event");
        assert_eq!(event.data, "line1\nline2\n extra space");
    }

    /// An event with no `event:` field defaults to `None` (the SSE default
    /// event type is `"message"`, which the reader loop treats as a message).
    #[tokio::test]
    async fn read_sse_event_defaults_event_to_none_when_absent() {
        let wire = b"data: {\"jsonrpc\":\"2.0\",\"id\":1}\n\n";
        let mut reader: &[u8] = &wire[..];
        let event = read_sse_event(&mut reader)
            .await
            .expect("read")
            .expect("an event");
        assert!(event.event.is_none());
        assert_eq!(event.data, "{\"jsonrpc\":\"2.0\",\"id\":1}");
    }

    /// Comments (lines starting with `:`) and blank lines between events are
    /// skipped so keepalive gaps do not produce spurious empty events.
    #[tokio::test]
    async fn read_sse_event_skips_comments_and_keepalive_blanks() {
        let wire = b": keepalive\n\nevent: message\ndata: hello\n\n";
        let mut reader: &[u8] = &wire[..];
        let event = read_sse_event(&mut reader)
            .await
            .expect("read")
            .expect("an event");
        assert_eq!(event.event.as_deref(), Some("message"));
        assert_eq!(event.data, "hello");
    }

    /// A clean EOF (stream closed) at the start returns `Ok(None)` so the
    /// caller can distinguish "stream ended" from "partial event".
    #[tokio::test]
    async fn read_sse_event_returns_none_at_clean_eof() {
        let mut reader: &[u8] = b"";
        let event = read_sse_event(&mut reader).await.expect("read on empty");
        assert!(event.is_none(), "EOF -> None, not error");
    }

    /// Two consecutive events: the first read returns event 1, the second
    /// returns event 2, and the third returns `None` (EOF).
    #[tokio::test]
    async fn read_sse_event_reads_two_consecutive_events_then_eof() {
        let wire = b"event: endpoint\ndata: url1\n\nevent: message\ndata: msg1\n\n";
        let mut reader: &[u8] = &wire[..];
        let e1 = read_sse_event(&mut reader)
            .await
            .expect("read 1")
            .expect("event 1");
        assert_eq!(e1.event.as_deref(), Some("endpoint"));
        assert_eq!(e1.data, "url1");
        let e2 = read_sse_event(&mut reader)
            .await
            .expect("read 2")
            .expect("event 2");
        assert_eq!(e2.event.as_deref(), Some("message"));
        assert_eq!(e2.data, "msg1");
        let e3 = read_sse_event(&mut reader).await.expect("read 3");
        assert!(e3.is_none(), "third read -> EOF");
    }

    /// Issue #647: a line longer than the cap voids the WHOLE in-progress
    /// event -- not just the offending line -- and the reader resyncs at the
    /// next blank-line boundary. Dropping only the line would stitch the
    /// surviving fields into a partial franken-event the consumer cannot
    /// parse; the next full event after the boundary parses normally.
    /// Issue #665: the survivor lines include an `event: message` and a
    /// comment -- the skip guard sits BEFORE field parsing, so a regression
    /// moving it below the `event:` arm still compiles and leaks the type
    /// into the next event, where the stitched data becomes malformed JSON
    /// and kills the whole transport (issue #647's escalation, one notch
    /// worse). The survivor's type is `message` on purpose: only a leaked
    /// message-typed event is consumed, so its stitched data actually
    /// reaches the parser and fails.
    #[tokio::test]
    async fn read_sse_event_overlong_line_voids_event_and_resyncs_at_boundary() {
        // First `data:` line is 30 bytes (over the 16-byte cap); the short
        // survivors (`data: tail`, `event: message`, `: comment`) are skipped
        // during the resync, not stitched or leaked into the next event.
        let wire = format!(
            "data: {}\ndata: tail\nevent: message\n: comment\n\ndata: {{\"ok\":1}}\n\n",
            "a".repeat(24)
        );
        let mut reader: &[u8] = wire.as_bytes();
        let event = read_sse_event_bounded(&mut reader, 16)
            .await
            .expect("read")
            .expect("the event after the voided one");
        assert!(
            event.event.is_none(),
            "the `event:` survivor must not leak into the next event"
        );
        assert_eq!(event.data, "{\"ok\":1}");
        // The stream continues past the drop: the next read is clean EOF.
        let next = read_sse_event_bounded(&mut reader, 16)
            .await
            .expect("read 2");
        assert!(next.is_none(), "stream continues to clean EOF");
    }

    /// Issue #665: a second over-long line while STILL resyncing (two
    /// oversized lines in the same voided event -- the shape of an unbounded
    /// server) re-enters the void path idempotently: a second breach while
    /// `Voided` re-assigns the variant, dropping what was already being
    /// dropped. A regression that switched back to `Building` early (or
    /// returned the half-dropped event) would stitch the survivors into the
    /// next event.
    #[tokio::test]
    async fn read_sse_event_second_overlong_during_resync_stays_resyncing() {
        // Two 30-byte lines (over the 16-byte cap) inside one voided event,
        // each followed by a short survivor of a different field kind (11
        // and 10 bytes, well under the cap); the healthy event after the
        // boundary parses normally.
        let wire = format!(
            "data: {}\nevent: sv-a\ndata: {}\ndata: sv-b\n\ndata: ok\n\n",
            "a".repeat(24),
            "b".repeat(24)
        );
        let mut reader: &[u8] = wire.as_bytes();
        let event = read_sse_event_bounded(&mut reader, 16)
            .await
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
    #[tokio::test]
    async fn read_sse_event_overlong_line_clears_accumulated_fields() {
        let wire = format!("event: ping\ndata: {}\n\ndata: x\n\n", "a".repeat(24));
        let mut reader: &[u8] = wire.as_bytes();
        let event = read_sse_event_bounded(&mut reader, 16)
            .await
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
    #[tokio::test]
    async fn read_sse_event_data_budget_voids_oversized_event() {
        // Each line is 13 bytes (under the 16-byte line cap) but the three
        // parts, join bytes included, sum to 24 budget bytes (over the
        // budget; the breach lands on the third part).
        let wire = "data: 1234567\ndata: 1234567\ndata: 1234567\n\ndata: ok\n\n";
        let mut reader: &[u8] = wire.as_bytes();
        let event = read_sse_event_bounded(&mut reader, 16)
            .await
            .expect("read")
            .expect("the event after the voided one");
        assert_eq!(event.data, "ok");
    }

    /// Issue #666: the budget's at-boundary half -- an event whose `data:`
    /// parts cost EXACTLY the budget is accepted, not voided (the breach
    /// comparison is strict). Every other budget fixture breaches well past
    /// the cap, so a regression of `>` to `>=` leaves them green and only
    /// this pin goes red.
    #[tokio::test]
    async fn read_sse_event_accepts_data_at_exactly_the_budget() {
        // Two 13-byte lines (7-byte payloads + the 6-byte "data: " prefix),
        // under the 16-byte line cap; the parts' budget cost is
        // (7+1) + (7+1) = 16 = max exactly -- at the budget, not over it.
        let wire = "data: 1234567\ndata: 1234567\n\n";
        let mut reader: &[u8] = wire.as_bytes();
        let event = read_sse_event_bounded(&mut reader, 16)
            .await
            .expect("read")
            .expect("the at-budget event is accepted, not voided");
        assert_eq!(event.data, "1234567\n1234567");
    }

    /// Zero-length `data:` parts each cost one budget byte -- the `+1` in
    /// `push_data`'s accounting, which counts the "\n" the join inserts
    /// between parts. Dropping it would let a server spamming bare `data:`
    /// lines grow `data_parts` (and the joined string) without ever touching
    /// the budget -- the unbounded-memory shape the caps exist for; this
    /// fixture is the one that goes red if the `+1` is dropped.
    #[tokio::test]
    async fn read_sse_event_voids_zero_length_data_spam() {
        // Eight bare `data:` lines (5 bytes each, under the 6-byte line cap)
        // under a 6-byte budget: the parts cost (0+1) each, so the seventh
        // breaches (7 > 6) and the event is voided -- None at the boundary,
        // and None again at the EOF right after it.
        let wire = "data:\ndata:\ndata:\ndata:\ndata:\ndata:\ndata:\ndata:\n\n";
        let mut reader: &[u8] = wire.as_bytes();
        let event = read_sse_event_bounded(&mut reader, 6).await.expect("read");
        assert!(
            event.is_none(),
            "the zero-length-parts event is voided, not joined into newline spam"
        );
    }

    /// EOF while still resyncing (the broken event never reached its blank
    /// boundary) drops the voided event: nothing half-parsed is returned.
    #[tokio::test]
    async fn read_sse_event_eof_while_resyncing_returns_none() {
        let wire = format!("data: {}\ndata: tail", "a".repeat(24));
        let mut reader: &[u8] = wire.as_bytes();
        let event = read_sse_event_bounded(&mut reader, 16).await.expect("read");
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
    #[tokio::test]
    async fn read_sse_event_returns_pending_event_at_eof_without_blank_line() {
        let wire = b"data: last";
        let mut reader: &[u8] = &wire[..];
        let event = read_sse_event_bounded(&mut reader, 16)
            .await
            .expect("read")
            .expect("the unterminated final event is returned, not dropped");
        assert_eq!(event.data, "last");
    }

    /// #1455's kill half of the connect-phase silent window: a kill landing
    /// while the connect parks on the endpoint read breaks it through the
    /// stop wake immediately -- well inside the 2 s ack window -- where the
    /// retired sync design waited out its read tick (the immediacy AC's
    /// connect-window leg; the request-loop leg is pinned in the
    /// integration suite).
    #[test]
    fn sse_connect_stop_wake_breaks_the_endpoint_read_immediately() {
        use std::io::Write as _;
        use std::net::TcpListener;
        use std::time::Instant;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().expect("local addr").port();
        let server = std::thread::spawn(move || {
            use std::io::Read as _;
            let (mut stream, _) = listener.accept().expect("accept GET");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set read timeout");
            // Drain the request head, then answer SSE headers and never the
            // endpoint event: the connect parks on the endpoint read.
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK
Content-Type: text/event-stream

",
            );
            let mut sink = [0u8; 64];
            let _ = stream.read(&mut sink); // Park until the client hangs up.
        });

        // The real deadline path: the slot starts empty, the transport's
        // connect publishes ITS stop signal into it, and the deadline side
        // `expire`s the slot (never a hand-rolled second publish -- the
        // rendezvous is single-shot and a second publish would overwrite).
        let slot: KillSlot = Arc::new(ConnectKill::default());
        let slot_for_connect = Arc::clone(&slot);
        let url = format!("http://127.0.0.1:{port}/sse");
        let connect = std::thread::spawn(move || {
            SseClient::connect_with_kill(&url, &BTreeMap::new(), false, &slot_for_connect)
        });
        // The GET answers in milliseconds; fire the kill at 300 ms so the
        // stop arm must win the race against the 2 s ack window.
        std::thread::sleep(Duration::from_millis(300));
        let started = Instant::now();
        slot.expire();
        let outcome = connect.join().expect("the connect returns, not panics");
        assert!(
            matches!(outcome, Err(ClientError::ServerClosed)),
            "killed endpoint park -> ServerClosed, got {:?}",
            outcome.err()
        );
        assert!(
            started.elapsed() < Duration::from_millis(1_500),
            "the stop wake lands far inside the 2 s ack window, took {:?}",
            started.elapsed()
        );
        server
            .join()
            .expect("server thread exits after the hang-up");
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

    /// #1455: the HTTP per-read bound's async carry -- a streamable-HTTP
    /// response that opens an SSE body and then falls silent surfaces as
    /// `Framing(TimedOut)` within the bound. This is issue #392's guarantee
    /// (a hung server's blocking worker terminates after the probe deadline
    /// fires; `spawn_blocking` tasks are not cancelled) restated on the
    /// async face, pinned here with an injected bound instead of waiting
    /// out the 30 s production constant.
    #[test]
    fn http_client_sse_body_per_read_bound_times_out_a_silent_stream() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().expect("local addr").port();
        let server = thread_like_server(listener);

        let mut client = HttpClient::for_test_with_read_timeout(
            &format!("http://127.0.0.1:{port}/mcp"),
            Duration::from_millis(200),
        );
        let err = client
            .request(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))
            .expect_err("the silent SSE body trips the per-read bound");
        match err {
            ClientError::Framing(ref e) => assert_eq!(
                e.kind(),
                std::io::ErrorKind::TimedOut,
                "silent body -> Framing(TimedOut), got {e:?}"
            ),
            other => panic!("expected Framing(TimedOut), got {other:?}"),
        }
        server
            .join()
            .expect("server thread exits after the hang-up");
    }

    /// The silent-SSE fixture server for the per-read bound pin above: one
    /// POST drained fully (closing with unread receive-buffer bytes makes
    /// Windows send an RST that fails the client's status-line read -- the
    /// #647 fixture's lesson), then SSE headers and a declared body that
    /// never arrives. The final read parks until the client's timeout drops
    /// the connection.
    fn thread_like_server(listener: std::net::TcpListener) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            use std::io::{Read as _, Write as _};
            let (mut stream, _) = listener.accept().expect("accept POST");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set read timeout");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break, // Client closed or stalled.
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf);
                        if let Some(headers_end) = text.find("\x0d\x0a\x0d\x0a") {
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
                .write_all(
                    b"HTTP/1.1 200 OK\x0d\x0aContent-Type: text/event-stream\x0d\x0aContent-Length: 64\x0d\x0a\x0d\x0a",
                )
                .expect("write SSE headers");
            // Silence: hold the connection open until the client hangs up.
            let mut sink = [0u8; 64];
            let _ = stream.read(&mut sink);
        })
    }

    // --- same-origin + header merge (issue #901) -------------------------------

    /// Same origin (scheme + host + port) passes the guard.
    #[test]
    fn enforce_same_origin_accepts_matching_origin() {
        enforce_same_origin("http://localhost:3001/sse", "http://localhost:3001/message")
            .expect("same origin accepted");
        // The default-port elision shape: an https url with an explicit 443
        // is origin-identical to the bare host form.
        enforce_same_origin("https://example.test/sse", "https://example.test:443/m")
            .expect("explicit default port is the same origin");
    }

    /// A different host is refused and the error names BOTH origins.
    #[test]
    fn enforce_same_origin_refuses_a_different_host_naming_both() {
        let err = enforce_same_origin(
            "http://localhost:3001/sse",
            "http://attacker.test:8080/message",
        )
        .expect_err("cross-origin refused");
        let msg = err.to_string();
        assert!(msg.contains("cross-origin"), "names the refusal: {msg}");
        assert!(
            msg.contains("http://localhost:3001") && msg.contains("http://attacker.test:8080"),
            "names both origins: {msg}"
        );
    }

    /// A different PORT on the same host is a different origin.
    #[test]
    fn enforce_same_origin_refuses_a_different_port() {
        let err = enforce_same_origin("http://localhost:3001/sse", "http://localhost:8080/message")
            .expect_err("port difference refused");
        assert!(
            err.to_string().contains("cross-origin"),
            "port is part of the origin"
        );
    }

    /// A different SCHEME (https vs http) on the same host+port is a
    /// different origin.
    #[test]
    fn enforce_same_origin_refuses_a_scheme_change() {
        let err = enforce_same_origin("http://localhost:3001/sse", "https://localhost:3001/m")
            .expect_err("scheme difference refused");
        assert!(
            err.to_string().contains("cross-origin"),
            "scheme is part of the origin"
        );
    }

    /// The named derivation every SSE caller shares (issue #904): an empty
    /// configured map with a NON-empty declared keychain list still counts
    /// as authenticated -- a declared secret whose keychain value is missing
    /// would ride the POST the moment the value appears, so the guard must
    /// not wait for the merged map to fill.
    #[test]
    fn sse_auth_configured_counts_declared_keys_without_configured_headers() {
        let declared = vec!["X-Test-Token".to_string()];
        assert!(
            sse_auth_configured(&BTreeMap::new(), &declared),
            "declared keychain header keys count even with empty configured headers"
        );
        assert!(
            !sse_auth_configured(&BTreeMap::new(), &[]),
            "no configured headers + no declarations -> not authenticated"
        );
        let mut configured = BTreeMap::new();
        configured.insert("X-Plain".to_string(), "v".to_string());
        assert!(
            sse_auth_configured(&configured, &[]),
            "a configured non-secret header still counts (any header arms the guard)"
        );
    }

    /// The dispatch merge: configured non-secret headers + keychain-resolved
    /// secrets compose into one map (secret values win on a name collision,
    /// which the read-time scan makes impossible in practice -- the extend is
    /// just the order-insensitive composition).
    #[test]
    fn merged_headers_combines_configured_and_secret_values() {
        let mut configured = BTreeMap::new();
        configured.insert("X-Client".to_string(), "toptopduck".to_string());
        let secrets = vec![
            ("X-Test-Token".to_string(), "secret-value".to_string()),
            ("X-Other".to_string(), "other".to_string()),
        ];
        let merged = merged_headers(&configured, &secrets);
        assert_eq!(merged.len(), 3);
        assert_eq!(merged["X-Client"], "toptopduck");
        assert_eq!(merged["X-Test-Token"], "secret-value");
        assert_eq!(merged["X-Other"], "other");
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
