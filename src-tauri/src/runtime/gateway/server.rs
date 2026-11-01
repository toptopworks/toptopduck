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
//! [`crate::analysis_tools::dispatch`] or the shared CLI spawn engine, mirroring the
//! built-in agent loop's `execute_call` -- built-in tools classify `Allow`
//! (zero approval, ADR-0080 Decision 1), unknown names fall through to the
//! external arm and surface the gate's pending card.

use std::io;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::tcp::OwnedWriteHalf;

use serde_json::{json, Value};

use crate::analysis_tools::builtin_table;
use crate::approval::{ApprovalSink, ApprovalState};
use crate::bounded_line::{BoundedLineReader, LineRead, LINE_MAX_BYTES};
use crate::cancel::CancelToken;
use crate::mcp::aggregator::McpAggregator;
use crate::model::{Promotion, TraceEntryView, TurnPhase, TurnPhaseSink};
use crate::provider::tool_calling::{ToolDefinition, ToolResult, ToolUse};
use crate::session::loop_contract::{
    truncate_trace_excerpt, Termination, TraceEntry, TRACE_EXCERPT_MAX,
};
use crate::session::materializer::{DispatchDeps, Materializer};
use crate::session::turn_dispatch::{
    classify_with_cli_tool, dispatch_gated_call, CallFace, DispatchAbort, GateCtx,
    ResolvedClassification,
};

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
    /// The per-turn DuckDB + working-set borrows `analysis_tools::dispatch` reads +
    /// mutates.
    pub deps: DispatchDeps<'a>,
    /// The mid-turn skill-invocation channel (ADR-0119 Decision 4, issue
    /// #983): serves the `invoke_skill` meta-tool's interception below --
    /// the bridge face lands invocations on the SAME turn record by
    /// construction.
    pub invocations: crate::skills::invocation::SkillInvocationCtx<'a>,
    /// The attachment read gate (ADR-0111, issue #714; calibrated by
    /// ADR-0119): serves the `read_skill_file` meta-tool's interception
    /// below -- the same immutable bundle (turn-start invoked snapshot +
    /// registry root) the built-in loop's dispatch server gets, so both
    /// runtime surfaces read with one semantics by construction.
    pub read: crate::skills::read::SkillReadGate<'a>,
    /// The creation channel (ADR-0122 Decision 1): serves the
    /// `create_skill` meta-tool's gated interception below -- the registry
    /// root + live-config handle the approved mint needs, the same pairing
    /// the built-in loop's dispatch core gets (#987's one-contract
    /// posture).
    pub create: crate::skills::create::SkillCreateGate<'a>,
    /// The materializer `analysis_tools::dispatch` delegates `materialize` to (the same
    /// trait the built-in loop drives, so numbering + caps inherit verbatim).
    pub materializer: &'a mut dyn Materializer,
    /// The session's approval state -- the gate's classify + pending machinery.
    pub approval: &'a ApprovalState,
    /// The session's approval event sink (the card UI's pending/resolved channel).
    pub sink: &'a dyn ApprovalSink,
    /// The turn's live-phase emitter (issue #1242): the serve emits the
    /// authoritative `ToolCallStarted` / `ToolCallCompleted` pair around each
    /// served `tools/call` -- the same phases the built-in loop's dispatch
    /// core emits, over the same channel the ACP engine's fold layer feeds
    /// (one live rail, one channel; the external lines' echoes stay silent,
    /// so the gateway's row is the call's only live source).
    pub events: &'a dyn TurnPhaseSink,
    /// The turn's shared cancel token; the gate suspends on it, dispatch
    /// checks it. Owned as an `Arc` (not a borrow) since #1457: the serve's
    /// I/O task needs a `'static` handle to observe termination, and the
    /// production caller already holds the token behind its own `Arc`.
    pub cancel: Arc<CancelToken>,
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
/// (ADR-0085 robustness). A blocking accept with no bridge would hang the
/// turn forever -- the engine returns, but the gateway never sees EOF -- so
/// the accept races this deadline against its beat arms. The bridge
/// connects in well under a second in the happy path; 30s absorbs a slow CI
/// runner + process-spawn jitter without leaking a hung turn.
const CONNECT_DEADLINE: Duration = Duration::from_secs(30);

/// The serve beat: how often the spine's event wait re-checks the
/// termination flags (and the keep-alive companion polls its slot) --
/// the retired per-read timeout cadence's bound, kept on as the
/// flag-visibility bound. The reads themselves are event-driven since
/// #1457 -- EOF or a hard bridge death wakes them, so no read is timed
/// out and retried, and a sender pausing mid-frame for any duration
/// completes the frame when its bytes arrive (issue #649 made structural
/// -- see `serve_reader`'s doc for why reads never share a select with
/// the beat). Also the keep-alive companion's poll quantum (issue #1267).
const SERVE_BEAT: Duration = Duration::from_millis(100);

/// The accept-beat quantum: the flag-visibility bound while no bridge has
/// connected yet. Finer than [`SERVE_BEAT`] -- the retired non-blocking
/// accept polled at this interval, and the connect window is the one
/// place the rewrite must not regress cancellation latency.
const ACCEPT_BEAT: Duration = Duration::from_millis(10);

/// Whether an io error kind means the bridge connection died hard (issue
/// #801, ADR-0085 disconnect immunity): a reset, a broken pipe (POSIX
/// surfaces a dead-peer write as EPIPE), or the Windows local-stack abort
/// variant (os error 10053; the routine hard death maps to os error 10054 --
/// ConnectionReset -- on both sides). Shared by the serve loop's read and
/// write tolerance arms so the twin sets cannot drift from the one decision
/// the ADR records; kinds the read path cannot produce are harmless
/// superset members there.
fn is_bridge_gone(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::ConnectionReset
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
    )
}

/// The keep-alive cadence for a gated `tools/call` (issue #1267): the
/// bridge client's request timeout (opencode's SDK defaults to ~60s absent
/// configuration) resets on every progress notification, so an interval
/// well under it keeps the request alive for an unbounded human wait.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);

/// One `notifications/progress` keep-alive frame (issue #1267). Pure so
/// tests pin the wire shape without a clock.
fn progress_notification(token: &Value, progress: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/progress",
        "params": {
            "progressToken": token,
            "progress": progress,
            "message": "awaiting approval",
        }
    })
}

/// Serve one turn's bridge connection to completion on the calling thread
/// (the spine), with the socket's read side parked on a dedicated reader
/// task (see [`serve_reader`]'s doc for the measured Windows wake law that
/// forces this split): the spine accepts through the transport bridge,
/// dispatches frames synchronously through `handle_method` (the `!Sync`
/// DuckDB borrows stay on this thread, same constraint as the production
/// scope body), writes responses through the shared write funnel, and
/// observes the termination flags on a std `recv_timeout` beat -- the
/// reader can never be woken but by the socket, so every flag check, reply
/// write, and keep-alive frame lives on this thread or its companion
/// (issue #1267). Returns the collected trace + promotions for the turn
/// assembler; `Err` only for genuine serve faults (a missing bridge, a
/// refused handshake, an intolerable I/O error).
pub fn serve_connection(
    handle: GatewayHandle,
    mut ctx: GatewayCtx,
    engine_done: &Arc<AtomicBool>,
) -> io::Result<GatewayOutcome> {
    let GatewayHandle {
        token, listener, ..
    } = handle;
    let cancel = Arc::clone(&ctx.cancel);
    // The accept runs on this thread through the transport bridge: one
    // `block_on` for the whole wait parks the calling thread on the
    // runtime's driver (a plain thread outside any async context may do
    // exactly this -- the same shape the mcp client uses per call), with
    // the termination flags observed on the accept's own beat arms.
    let stream = match crate::mcp::client::block_on(async {
        accept_bridge(listener, &cancel, engine_done, CONNECT_DEADLINE).await
    }) {
        Err(e) => return Err(e),
        // Cancel or engine completion fired before any bridge connected:
        // the empty outcome so the ACP termination decides the TurnOutcome.
        Ok(None) => return Ok(GatewayOutcome::default()),
        Ok(Some((stream, _peer))) => stream,
    };
    // The reader task owns the connection's read side for its whole life
    // (verify, then frames) and hands the write half to the spine through
    // the first event. See `serve_reader`'s doc for why its reads are
    // never selected against anything (the measured Windows wake law).
    let (event_tx, event_rx) = std::sync::mpsc::channel::<ServeEvent>();
    crate::mcp::client::spawn_transport_task(serve_reader(
        stream,
        token,
        Arc::clone(&cancel),
        Arc::clone(engine_done),
        event_tx,
    ));

    let mut outcome = GatewayOutcome::default();
    let mut write: Option<Arc<tokio::sync::Mutex<OwnedWriteHalf>>> = None;
    let mut keepalive: Option<KeepaliveGuard> = None;
    let result = loop {
        use std::sync::mpsc::RecvTimeoutError;
        match event_rx.recv_timeout(SERVE_BEAT) {
            Ok(ServeEvent::Authed(writer)) => {
                // The write half arrives with the completed handshake: the
                // keep-alive companion starts before the first frame so the
                // whole serve lifetime has exactly two writers (the spine
                // and the companion), serialized by the funnel.
                keepalive = Some(KeepaliveGuard::start(Arc::clone(&writer)));
                write = Some(writer);
            }
            Ok(ServeEvent::Frame(msg)) => {
                let method = msg.get("method").and_then(|v| v.as_str()).unwrap_or("");
                let id = msg.get("id").cloned();
                // The keep-alive window (issue #1267): a `tools/call`
                // carrying a progress token arms the companion BEFORE the
                // dispatch below -- the dispatch may park this thread in
                // the approval gate for an unbounded human wait, during
                // which only the companion writes.
                let token = keepalive_token(&msg, method);
                if let (Some(k), Some(t)) = (&keepalive, token) {
                    k.arm(t);
                }
                let response = handle_method(method, &msg, &mut ctx, &mut outcome);
                if let Some(k) = &keepalive {
                    k.disarm();
                }
                let Some(id) = id else { continue };
                let Some(envelope) = response.into_envelope(id) else {
                    continue;
                };
                let Some(writer) = &write else { continue };
                // The write twin of the reader's reset arm (issue #801): a
                // bridge that dies mid-response aborts the write with a
                // reset / broken pipe. The request was served; the turn's
                // fate belongs to the ACP engine.
                if let Err(e) = write_response(writer, &envelope) {
                    if is_bridge_gone(e.kind()) {
                        log::debug!(
                            target: "toptopduck::gateway",
                            "serve spine exiting: the bridge died writing a response"
                        );
                        break Ok(outcome);
                    }
                    break Err(e);
                }
            }
            Ok(ServeEvent::Done(Exit::Ok)) => break Ok(outcome),
            Ok(ServeEvent::Done(Exit::Err(e))) => break Err(e),
            // The spine's beat (the flag-visibility bound): a flag firing
            // while the reader parks on the socket is observed HERE, within
            // one SERVE_BEAT -- the reader task itself can never be woken
            // by anything but the socket (see `serve_reader`'s doc).
            Err(RecvTimeoutError::Timeout) => {
                if termination_fired(&cancel, engine_done) {
                    log::debug!(
                        target: "toptopduck::gateway",
                        "serve spine exiting on {} during a read park",
                        termination_source(&cancel)
                    );
                    break Ok(outcome);
                }
            }
            Err(RecvTimeoutError::Disconnected) => break Ok(outcome),
        }
    };
    if let Some(k) = keepalive {
        k.stop();
    }
    result
}

/// The keep-alive token of a `tools/call` (issue #1267): the call's
/// `_meta.progressToken`. Token-less calls and other methods keep nothing.
fn keepalive_token(msg: &Value, method: &str) -> Option<Value> {
    if method == "tools/call" {
        msg.get("params")?
            .get("_meta")?
            .get("progressToken")
            .cloned()
    } else {
        None
    }
}

/// Write one response envelope through the shared write half -- the
/// spine's only socket write, a bounded `block_on` on the transport
/// runtime from a plain thread (the same shape the mcp client uses per
/// call).
fn write_response(writer: &tokio::sync::Mutex<OwnedWriteHalf>, envelope: &Value) -> io::Result<()> {
    crate::mcp::client::block_on(async {
        let mut half = writer.lock().await;
        framing::write_message_async(&mut *half, envelope).await
    })
}

/// What the reader task hands the spine: the completed handshake (carrying
/// the connection's write half), one fully-read frame to dispatch, or the
/// connection's end (collected-outcome stands vs a serve error to
/// propagate).
enum ServeEvent {
    Authed(Arc<tokio::sync::Mutex<OwnedWriteHalf>>),
    Frame(Value),
    Done(Exit),
}

/// The connection-end shape the reader reports through
/// [`ServeEvent::Done`].
enum Exit {
    /// The bridge disconnected / a termination handoff returned early / a
    /// tolerated bridge death: the spine returns the collected outcome.
    Ok,
    /// A genuine serve fault (deadline expiry, an intolerable I/O error).
    Err(io::Error),
}

/// The connection's reader (the async half of the two-part serve since
/// #1457): verify the auth handshake, then read frames until the bridge
/// disconnects, a tolerated bridge death surfaces, or a serve fault --
/// handing each frame to the spine's event channel.
///
/// Measured Windows constraint (tokio 1.52.3, this repository's test
/// binary, 2026-11-01 probes -- shapes pinned in #1457's review trail):
/// once a socket read on a tokio runtime is parked, NOTHING but socket I/O
/// wakes that task -- not a `tokio::time` sleep co-parked in the same
/// `select!`, not a `timeout()` wrapper, not a `Notify` fired from a plain
/// std thread, biased or not, fresh runtime or shared. Timers and channel
/// parks WITHOUT a parked socket read wake fine, and sibling tasks on a
/// multi-thread runtime wake fine while one task parks on a read. So this
/// task parks on exactly one thing -- the socket read -- and everything
/// that must remain wake-able (the termination flags, the reply writes,
/// the keep-alive cadence) lives on other threads: the spine's
/// `recv_timeout` beat and the keep-alive companion. A termination flag
/// firing while this read parks is observed by the spine, which returns;
/// this task then ends when the socket dies -- guaranteed by the turn
/// teardown's process-tree kill, even on the Linux stdio-fd-leak shape
/// (the detached task is the bounded cost of the wake law, one parked
/// reader per turn).
async fn serve_reader(
    stream: tokio::net::TcpStream,
    token: String,
    cancel: Arc<CancelToken>,
    engine_done: Arc<AtomicBool>,
    event_tx: std::sync::mpsc::Sender<ServeEvent>,
) {
    let exit = match serve_reader_inner(stream, &token, &cancel, &engine_done, &event_tx).await {
        Ok(()) => Exit::Ok,
        Err(e) => Exit::Err(e),
    };
    // The spine's exit conditions travel as events; a send failure means
    // the spine already returned (its receiver dropped) -- nothing to
    // report.
    let _ = event_tx.send(ServeEvent::Done(exit));
}

async fn serve_reader_inner(
    stream: tokio::net::TcpStream,
    token: &str,
    cancel: &CancelToken,
    engine_done: &AtomicBool,
    event_tx: &std::sync::mpsc::Sender<ServeEvent>,
) -> io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = tokio::io::BufReader::new(read_half);
    // The pre-auth window's termination handoff (issue #909): flags firing
    // before or DURING the handshake return through `verify_bridge`'s own
    // checks or the spine's beat (see the task doc above) as `Ok`, handing
    // the turn to the ACP termination.
    if !verify_bridge(&mut reader, &mut write_half, token, cancel, engine_done).await? {
        return Ok(());
    }
    // The write half crosses to the spine (and the keep-alive companion)
    // through the funnel; the handshake's BRIDGE_OK was already written.
    let writer = Arc::new(tokio::sync::Mutex::new(write_half));
    if event_tx
        .send(ServeEvent::Authed(Arc::clone(&writer)))
        .is_err()
    {
        return Ok(());
    }
    // The frame reader keeps the stream for the reader's lifetime; with no
    // beat-cancellation the #649 partial-frame resume is structural: a
    // sender pausing mid-frame for any duration completes the frame when
    // its bytes arrive -- the read is never timed out or re-framed.
    let mut frames = framing::FrameReader::new(reader);
    loop {
        match frames.read_message_async().await {
            Ok(Some(msg)) => {
                if event_tx.send(ServeEvent::Frame(msg)).is_err() {
                    // The spine is gone (it returned on its beat or a
                    // handler panic); end with what was collected.
                    return Ok(());
                }
            }
            // The post-auth companions (issue #915): the bridge-death exits
            // leave a trace too, so no reader exit is silent.
            Ok(None) => {
                log::debug!(
                    target: "toptopduck::gateway",
                    "serve reader exiting on the bridge's close"
                );
                return Ok(());
            }
            // A bridge that dies hard (the turn's CLI exits or is killed)
            // closes with a reset, not a FIN -- Windows surfaces it as os
            // error 10054 (issue #801). Same disposition as the EOF arm:
            // return what was collected and let the ACP engine's
            // termination decide the turn.
            Err(e) if is_bridge_gone(e.kind()) => {
                log::debug!(
                    target: "toptopduck::gateway",
                    "serve reader exiting on the bridge's read-side reset"
                );
                return Ok(());
            }
            Err(e) => return Err(e),
        }
    }
}

/// Await one bridge connection until it arrives, cancel fires, engine
/// completion fires, or `deadline` elapses (issue #1457's retirement of
/// the non-blocking poll loop: the async accept is event-driven, the
/// termination flags ride the beat arm, the deadline an `Instant`). Returns
/// `Ok(None)` on cancel or engine completion (the serve returns an empty
/// outcome + the ACP termination decides the TurnOutcome), `Ok(Some)` on a
/// connection, and `Err(TimedOut)` on the deadline (a missing bridge is a
/// real failure -- the engine would otherwise wait on a serve that never
/// progresses).
///
/// The `engine_done` arm (issue #899): the engine pump returned while no
/// bridge ever connected, so there is nothing left to serve -- waiting out
/// the deadline would burn `CONNECT_DEADLINE` and surface as a serve
/// error, failing a turn whose engine already finished. The same
/// single-source principle as the cancel arm: the ACP termination (already
/// set by the pump's return) decides the TurnOutcome, not the gateway.
///
/// Takes the std listener by value and registers it with the current
/// runtime (`from_std`): exactly one bridge is accepted (ADR-0085
/// per-bridge lifecycle) and the listener drops at this function's return,
/// releasing the port + clearing the kernel backlog.
async fn accept_bridge(
    listener: TcpListener,
    cancel: &CancelToken,
    engine_done: &AtomicBool,
    deadline: Duration,
) -> io::Result<Option<(tokio::net::TcpStream, std::net::SocketAddr)>> {
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let deadline_at = Instant::now() + deadline;
    loop {
        if cancel.is_requested() {
            // Companion to the spine's beat arm: exiting here drops the
            // listener before the bridge connects (issue #849's symptom
            // surface); with no user cancel in the window this line is the
            // red flag.
            log::debug!(
                target: "toptopduck::gateway",
                "accept_bridge exiting on the cancel flag before a bridge connected"
            );
            return Ok(None);
        }
        // Same disposition for engine completion (issue #899): the pump
        // returned while no bridge connected, so the accept has nothing
        // left to wait for. Companion to the spine's beat arm.
        if engine_done.load(Ordering::SeqCst) {
            log::debug!(
                target: "toptopduck::gateway",
                "accept_bridge exiting on engine completion before a bridge connected"
            );
            return Ok(None);
        }
        let remaining = deadline_at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            // The deadline: a missing bridge is a real failure, not a
            // termination handoff.
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "bridge did not connect within deadline",
            ));
        }
        tokio::select! {
            r = listener.accept() => {
                return match r {
                    Ok((stream, peer)) => Ok(Some((stream, peer))),
                    Err(e) => Err(e),
                };
            }
            // The beat arm (unlike a parked established-socket read, a
            // parked accept co-exists with the timer -- measured, see
            // `serve_reader`'s doc): loops back to the flag checks; a
            // connection made during the beat re-wakes the accept
            // immediately.
            _ = tokio::time::sleep(remaining.min(ACCEPT_BEAT)) => {
                if Instant::now() >= deadline_at {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "bridge did not connect within deadline",
                    ));
                }
            }
        }
    }
}

/// The termination predicate shared by the gateway's flag-driven exits --
/// verify_bridge's three pre-auth arms (the loop-top check, the EOF arm
/// (issue #913), the error arm's re-check (issue #911)) and the serve
/// loop's read-park beat -- so the twin flag sets cannot drift apart (the
/// is_read_timeout rationale).
fn termination_fired(cancel: &CancelToken, engine_done: &AtomicBool) -> bool {
    cancel.is_requested() || engine_done.load(Ordering::SeqCst)
}

/// The log label naming which termination flag fired, shared by the arms
/// that log a flag-driven exit (the pre-auth loop-top check, the EOF arm,
/// the error arm's re-check, and the serve loop's read-park beat) so the
/// twin labels cannot drift -- the [`termination_fired`] rationale.
/// Precondition: call only where `termination_fired` has already returned
/// true -- the else branch asserts engine completion by elimination, not by
/// observation.
fn termination_source(cancel: &CancelToken) -> &'static str {
    if cancel.is_requested() {
        "the cancel flag"
    } else {
        "engine completion"
    }
}

/// The auth line is read through the shared byte cap (issue #643): this read
/// happens BEFORE the token check, so the peer is an unauthenticated prober
/// that grabbed the connection -- the pre-auth surface. An over-long line,
/// like a clean EOF under no termination flag, falls into the mismatch arm
/// (empty vs expected), so it fails with the same `PermissionDenied` and no
/// observable difference -- a contract that governs the prober's wire view
/// (zero response bytes), not the operator's: a warn log at the refusal
/// distinguishes the four arrival shapes (issue #915).
///
/// The pre-auth window (issue #909): the auth read is event-driven (async
/// since #1457) with the termination flags observed on the serve-beat arm
/// of the same `select!` -- a bridge that connects but stalls before
/// writing its auth line while the engine completes (or cancel fires)
/// returns `Ok(false)`, handing the turn to the ACP termination instead of
/// surfacing the serve error that mislabels the completed turn as Failed
/// (the same single-source disposition as the accept and serve-loop arms).
/// A hard read error takes the same re-check in the error arm itself
/// (issue #911): the teardown's reset landing on the parked read after a
/// flag already fired returns `Ok(false)` too, while a reset with no flag
/// stays a truthful error. A clean EOF takes the same flag re-check in its
/// own arm (issue #913): the POSIX teardown FINs where the Windows kill
/// resets, so a graceful close racing a set flag hands the turn to the ACP
/// termination the same way. And the mismatch arm never re-checks -- a
/// wrong token is a genuine bridge-side defect. `Ok(true)`: auth verified.
async fn verify_bridge<R, W>(
    reader: &mut R,
    writer: &mut W,
    expected: &str,
    cancel: &CancelToken,
    engine_done: &AtomicBool,
) -> io::Result<bool>
where
    R: tokio::io::AsyncBufRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    // The resumable reader keeps a partial auth line across reads -- a
    // resumed handshake must not lose the head of a split line (issue
    // #649).
    let mut lines = BoundedLineReader::new(reader);
    let expected_line = format!("BRIDGE_AUTH {expected}");
    // The pre-auth window's entry check (issue #909): the same
    // single-source disposition as the accept arms -- the ACP termination
    // decides the TurnOutcome, never the gateway. A flag firing WHILE the
    // auth read parks is observed by the spine's beat instead (this read
    // is never co-parked with anything -- see `serve_reader`'s doc): the
    // spine returns, and this task ends when the socket dies.
    if termination_fired(cancel, engine_done) {
        // Companion to the accept arms' logs (issue #849's
        // invisible-exit lesson): without this line a bridge that
        // connected and was terminated pre-auth is indistinguishable
        // from one that never connected.
        log::debug!(
            target: "toptopduck::gateway",
            "verify_bridge exiting on {} in the pre-auth window",
            termination_source(cancel)
        );
        return Ok(false);
    }
    let read = lines.read_line_bounded_async(LINE_MAX_BYTES).await;
    let (line, refusal) = match read {
        // The raw line keeps its newline, so a Line without one is a
        // bridge that died mid-write: the bounded reader hands a
        // pending non-empty partial out as the final unterminated line
        // (issue #915's truncated shape) -- the token never completed
        // rather than mismatched.
        Ok(LineRead::Line(line)) => {
            if line.ends_with('\n') {
                (line, "a token mismatch")
            } else {
                (line, "a truncated auth line")
            }
        }
        // The POSIX teardown's graceful close (issue #913): killpg
        // SIGKILL FINs the bridge's socket where the Windows job-object
        // kill resets it (#911's error arm), so the parked auth read
        // wakes as a clean EOF. With a termination flag already set the
        // turn is decided and the EOF takes the same single-source
        // disposition (the error arm's class rule: the flag, not the
        // close's shape, owns the turn); with no flag a bridge that
        // died pre-auth without sending its line stays the truthful
        // refusal below.
        Ok(LineRead::Eof) => {
            if termination_fired(cancel, engine_done) {
                log::debug!(
                    target: "toptopduck::gateway",
                    "verify_bridge exiting on {} in the pre-auth window after a clean EOF",
                    termination_source(cancel)
                );
                return Ok(false);
            }
            (String::new(), "a clean EOF with no auth line")
        }
        // An over-long "line" can never match the expected auth line --
        // refuse it exactly like a token mismatch in any flag state (a
        // genuinely over-long line from the peer is a real signal, not
        // a teardown artifact).
        Ok(LineRead::Overlong) => (String::new(), "an over-long line"),
        // A hard read error racing a termination flag (issue #911): the
        // teardown's kill lands on the parked auth read as a reset
        // (typically `is_bridge_gone`) AFTER engine completion or cancel
        // already decided the turn -- the arm re-check gives it the same
        // single-source disposition as the loop top instead of surfacing
        // a serve error that mislabels the completed turn as Failed. The
        // mismatch / over-long arms below deliberately do NOT re-check
        // (a wrong token is a genuine bridge-side defect and must
        // surface), and with no flag set this is a pre-auth hard
        // death that stays a truthful error. The class rule is
        // kind-agnostic: a non-UTF-8 auth line surfaces as InvalidData
        // from the bounded reader and rides this arm's re-check too -- a
        // set flag means the termination already decided the turn
        // regardless of error kind.
        Err(e) => {
            if termination_fired(cancel, engine_done) {
                log::debug!(
                    target: "toptopduck::gateway",
                    "verify_bridge exiting on {} in the pre-auth window after a read error ({})",
                    termination_source(cancel),
                    e.kind()
                );
                return Ok(false);
            }
            return Err(e);
        }
    };
    let got = line.trim_end_matches(['\r', '\n']);
    if got == expected_line {
        use tokio::io::AsyncWriteExt as _;
        writer.write_all(b"BRIDGE_OK\n").await?;
        return Ok(true);
    }
    // The four arrival shapes share one error and one zero-byte wire
    // view (the prober's, issue #643); the label is the operator's
    // only attribution (issue #915) -- without it a bridge that died
    // alone in the pre-auth window reads as a token mismatch when no
    // line ever arrived. Logged at warn, not debug: release builds
    // filter debug, and a refusal is an abnormal actionable event --
    // unlike the lifecycle exits, which stay debug.
    log::warn!(
        target: "toptopduck::gateway",
        "verify_bridge refused the pre-auth handshake: {refusal}"
    );
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        "bridge auth token mismatch",
    ))
}

/// The keep-alive companion (issue #1267): a plain std thread writing
/// `notifications/progress` on the [`KEEPALIVE_INTERVAL`] cadence while a
/// dispatched `tools/call` is armed -- the only writer that runs while the
/// spine is parked inside the approval gate's unbounded human wait (the
/// bridge client's request timeout resets on every progress notification,
/// so an interval well under its ~60s default keeps the request alive).
/// The spine arms before dispatch and disarms once the dispatched call
/// returns -- BEFORE the response envelope takes the funnel; that order
/// plus the companion's under-lock re-check keeps every progress frame
/// ahead of the envelope (the lock, not the timing, carries the safety).
/// Writes share the write-half funnel so they serialize with the
/// spine's own writes. A thread (not a runtime task) by the same measured
/// law that shapes `serve_reader`: a runtime task could only be woken by
/// the socket, while this writer must wake on its own cadence. `stop` ends
/// the thread within one [`SERVE_BEAT`].
struct KeepaliveGuard {
    slot: Arc<std::sync::Mutex<Option<Value>>>,
    stop: Arc<AtomicBool>,
}

impl KeepaliveGuard {
    /// Start the companion on the production cadence.
    fn start(writer: Arc<tokio::sync::Mutex<OwnedWriteHalf>>) -> Self {
        Self::start_with_interval(writer, KEEPALIVE_INTERVAL)
    }

    /// Test seam: the companion on an injected cadence.
    fn start_with_interval<W>(writer: Arc<tokio::sync::Mutex<W>>, interval: Duration) -> Self
    where
        W: tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let slot = Arc::new(std::sync::Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));
        let armed = Arc::clone(&slot);
        let flag = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("gateway-keepalive".into())
            .spawn(move || {
                let mut progress: u64 = 0;
                let mut last = Instant::now();
                loop {
                    std::thread::sleep(SERVE_BEAT);
                    if flag.load(Ordering::SeqCst) {
                        return;
                    }
                    // Fast path only: the authoritative slot check lives
                    // under the write lock below -- this one just keeps an
                    // unarmed gap from taking the funnel at all.
                    if armed.lock().unwrap().is_none() {
                        continue;
                    }
                    if last.elapsed() < interval {
                        continue;
                    }
                    crate::mcp::client::block_on(async {
                        let mut half = writer.lock().await;
                        // The lock, not the timing, carries the safety
                        // (issue #1267): the spine disarms BEFORE writing
                        // the response through this same funnel, so a slot
                        // that emptied while this lock was awaited means
                        // the response envelope owns the write -- a frame
                        // written now would land behind it.
                        let armed_now = armed.lock().unwrap().clone();
                        if let Some(token) = armed_now {
                            // The cadence re-arms from THIS write, not the
                            // epoch: the interval is a floor spacing, not
                            // a phase. Advanced only on a real write, so
                            // an unarmed gap does not eat the cadence.
                            last = Instant::now();
                            progress += 1;
                            let frame = progress_notification(&token, progress);
                            // A failed write means the bridge died
                            // mid-park; the spine's own response write
                            // surfaces the death.
                            let _ = framing::write_message_async(&mut *half, &frame).await;
                        }
                    });
                }
            })
            .expect("the keep-alive thread spawns");
        Self { slot, stop }
    }

    /// Arm the cadence for a dispatched call carrying this token.
    fn arm(&self, token: Value) {
        *self.slot.lock().unwrap() = Some(token);
    }

    /// Disarm: the response was written, no further frames.
    fn disarm(&self) {
        *self.slot.lock().unwrap() = None;
    }

    /// End the companion thread (within one SERVE_BEAT).
    fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// One MCP method's outcome: a result, an error envelope, or no response (a
/// notification the gateway acknowledges by silence).
#[derive(Debug, PartialEq)]
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
            // The skill-invocation meta-tool (ADR-0119 Decision 4, issue
            // #983): mounted iff the turn's discovery snapshot is non-empty
            // -- the trio's conditional posture (ADR-0105 Decision 6).
            if !ctx.invocations.snapshot.is_empty() {
                tools.push(tool_to_mcp(
                    &crate::skills::invocation::invoke_skill_definition(),
                ));
            }
            // The skill-attachment read surface (ADR-0111 Decision 1
            // calibrated by ADR-0119 Decision 4): mounted iff the turn's
            // discovery snapshot is non-empty -- the SAME gate as
            // `invoke_skill` above (one tool plane, two callers), so a
            // mid-turn invocation's references need no next-turn mount
            // (issue #1260).
            if !ctx.invocations.snapshot.is_empty() {
                tools.push(tool_to_mcp(
                    &crate::skills::read::read_skill_file_definition(),
                ));
            }
            // The skill-creation meta-tool (ADR-0122 Decision 1): mounted
            // iff the live-config handle rides the gate (the mint needs the
            // config write). Unconditional beyond that -- the bridge mirrors
            // the built-in table's condition verbatim (one tool plane, two
            // callers).
            if ctx.create.live.is_some() {
                tools.push(tool_to_mcp(
                    &crate::skills::create::create_skill_definition(),
                ));
            }
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

/// The bridge face's `tools/call` transport shell: parse the JSON-RPC
/// request, hand it to the shared dispatch core (`dispatch_gated_call`,
/// `CallFace::Bridge`), and map the returned product back onto the wire --
/// JSON-RPC parsing on the way in, response mapping on the way out. Every
/// dispatch decision (the interception family, the gate, the routing arms,
/// the freeze window, the trace assembly) lives in the core; this arm is a
/// pure transport, the same shape the built-in loop's mpsc dispatch server
/// takes around the same core (issue #696's mid-term item).
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
    // The core's interception family discriminates on the face; the bridge
    // face never reaches the `present_files` arm, so the presented-channel
    // placeholder is never written.
    let mut presented = Vec::new();
    let gate = GateCtx {
        approval: ctx.approval,
        sink: ctx.sink,
        cancel: &ctx.cancel,
    };
    // The live rail (issue #1242): the core emits the authoritative phase
    // pair through here; the authoritative trace entry rides the return
    // value onto the outcome below -- one entry, two rails, never two
    // constructions.
    let mut on_phase = |phase: TurnPhase| ctx.events.emit(phase);
    match dispatch_gated_call(
        &call,
        CallFace::Bridge,
        &mut ctx.deps,
        ctx.materializer,
        &mut ctx.mcp,
        ctx.cli,
        &mut ctx.invocations,
        &mut presented,
        &ctx.read,
        &ctx.create,
        &gate,
        &mut on_phase,
        // An external runtime's bridge-originated call carries no sub-agent
        // originator (delegation is built-in-only, ADR-0117's v1
        // calibration).
        None,
    ) {
        Err(DispatchAbort::Gate) => Response::Error(-32000, "turn cancelled".into()),
        Err(DispatchAbort::Panic(termination)) => {
            // The bridge face's panic mapping (the #321 guard surfaces as
            // the call's own error result, never an unwound serve): the
            // core returns the pre-derived detail; the classification is
            // pure, so recomputing it here reproduces the row fields the
            // pre-retirement arm carried when the dispatch panicked. One
            // known deviation: that arm classified the wire-RESOLVED
            // identity (an mcp_invoke passthrough already resolved), this
            // reclassifies the wire call -- a panicking passthrough names
            // the shell, not the backend tool.
            let detail = match termination {
                Termination::Transient(detail) => detail,
                _ => unreachable!("dispatch panics always surface as Transient"),
            };
            let ResolvedClassification {
                operation_kind,
                summary,
                ..
            } = classify_with_cli_tool(ctx.cli, &call, ctx.deps.temp_path);
            let excerpt = truncate_trace_excerpt(&detail, TRACE_EXCERPT_MAX);
            let entry = TraceEntry::failed(
                call.id.clone(),
                call.name.clone(),
                operation_kind,
                summary,
                excerpt,
            );
            ctx.events
                .emit(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
            outcome.trace.push(entry);
            Response::Result(json!({
                "content": [{"type": "text", "text": detail}],
                "isError": true,
            }))
        }
        Ok((result, entry, promotion, envelope)) => {
            if let Some(promotion) = promotion {
                outcome.promotions.push(promotion);
            }
            if let Some(entry) = entry {
                outcome.trace.push(entry);
            }
            // The external envelope rides the return value (one decision,
            // two renderings): present means relay verbatim -- the server's
            // own shape, cap-spilled by the core -- absent means map the
            // flattened result.
            if let Some(envelope) = envelope {
                Response::Result(envelope)
            } else {
                result_envelope(result)
            }
        }
    }
}

/// One dispatched call's [`ToolResult`] → the bridge's JSON-RPC result
/// envelope: the flattened fallback when the core returned no verbatim
/// external envelope to relay. The trace row rides the core's
/// `DispatchProduct` -- nothing here feeds the trace.
fn result_envelope(result: ToolResult) -> Response {
    Response::Result(json!({
        "content": [{"type": "text", "text": result.content}],
        "isError": result.is_error,
    }))
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

    use crate::approval::OperationKind;
    use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink, ToolKey};
    use crate::guardrail::ExecError;
    use crate::ingest::schema::quote_ident;
    use crate::mcp::meta_tools;
    use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
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
    use std::time::Instant;
    use tempfile::TempDir;
    use tokio::io::AsyncBufRead as _;

    /// In-memory DuckDB + temp dir -- the same shape the agent-loop tests use.
    /// `handle_method`'s initialize / tools-list / unknown / notification paths
    /// do not touch DuckDB; the engine exists only to satisfy DispatchDeps's borrows
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

    /// A phase sink that records nothing -- the ctx default every
    /// live-emission test overwrites with a recorder (issue #1242).
    struct NoopPhaseSink;
    impl TurnPhaseSink for NoopPhaseSink {
        fn emit(&self, _: TurnPhase) {}
    }

    /// A recording phase sink (issue #1242): the live-emission tests'
    /// assertions read the emitted phases back in arrival order. Leak-boxed
    /// by the tests that use it (the ctx is `GatewayCtx<'static>`).
    struct RecPhaseSink(std::sync::Mutex<Vec<TurnPhase>>);
    impl TurnPhaseSink for RecPhaseSink {
        fn emit(&self, phase: TurnPhase) {
            self.0.lock().unwrap().push(phase);
        }
    }

    /// A recording sink for the approval-free assertions (issue #701): the
    /// NoopSink default hides whether the gate was ever asked.
    struct RecSink {
        requests: std::sync::Mutex<Vec<String>>,
    }
    impl ApprovalSink for RecSink {
        fn emit_request(&self, body: &ApprovalRequestBody) {
            self.requests.lock().unwrap().push(body.summary.clone());
        }
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

    /// A ctx over a SEEDED discovery snapshot -- the skill-surface tests'
    /// variant of [`fresh_ctx`]: the all-leak defaults of `fresh_ctx`,
    /// differing only in the invocation channel's snapshot (the
    /// tools/list mount condition reads it).
    fn skill_ctx(snapshot: Vec<String>) -> GatewayCtx<'static> {
        let mut ctx = fresh_ctx();
        ctx.invocations = crate::skills::invocation::SkillInvocationCtx {
            pending: Box::leak(Box::new(Vec::new())),
            snapshot: Box::leak(snapshot.into_boxed_slice()),
            root: Box::leak(std::path::PathBuf::new().into_boxed_path()),
            disabled: &[],
        };
        ctx
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
        let fake: &'static mut FakeMaterializer =
            Box::leak(Box::new(FakeMaterializer::new(vec![])));
        gate_ctx_with_materializer(fake, cli, approval, sink)
    }

    /// [`gate_ctx`] with a caller-chosen materializer -- the #321 panic pin
    /// drives a register-then-panic fixture through the builtin arm.
    fn gate_ctx_with_materializer(
        materializer: &'static mut dyn Materializer,
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
        let cancel = Arc::new(CancelToken::new());
        let events: &'static NoopPhaseSink = Box::leak(Box::new(NoopPhaseSink));
        let deps =
            DispatchDeps::test_deps(&engine.admin_engine, ws, sources, engine.temp.path(), refs);
        GatewayCtx {
            deps,
            // Inert by default (the invocation-surface tests overwrite this
            // field with a seeded channel; the ctx is built `mut` for that
            // purpose).
            invocations: crate::skills::invocation::test_ctx(Box::leak(Box::new(Vec::new()))),
            // Inert by default; the read-surface tests overwrite this field
            // with a seeded gate (the ctx is built `mut` for that purpose).
            read: crate::skills::read::SkillReadGate::inert(),
            // Inert by default; the create-surface tests overwrite this
            // field with a seeded gate (same purpose).
            create: crate::skills::create::SkillCreateGate::inert(),
            materializer,
            approval,
            sink,
            // Inert by default; the live-emission tests (issue #1242)
            // overwrite this field with a recorder (same purpose).
            events,
            cancel,
            mcp: McpAggregator::default(),
            cli,
        }
    }

    /// A materializer that registers `result_N` then panics in the return
    /// window -- the gateway-side twin of turn_dispatch's fixture, driving
    /// the shared #321 ghost-rollback ritual through the builtin arm.
    struct GhostThenPanicMaterializer;
    impl Materializer for GhostThenPanicMaterializer {
        fn try_materialize(
            &self,
            _sql: &str,
            _cancel: &CancelToken,
            result_name: String,
            deps: &mut DispatchDeps,
        ) -> Result<DatasetDescriptor, ExecError> {
            // Create the physical table first (mirrors RealMaterializer's
            // install_result step) so the ghost rollback exercises the DROP
            // TABLE success path.
            let create_sql = format!(
                "CREATE TABLE {} AS SELECT 1 AS x",
                quote_ident(&result_name)
            );
            deps.engine
                .conn()
                .execute_batch(&create_sql)
                .expect("fixture CREATE TABLE");
            let descriptor = DatasetDescriptor {
                reference_name: result_name.clone(),
                display_name: result_name,
                source_path: String::new(),
                columns: Vec::new(),
                row_count: 0,
                sample: Vec::new(),
                fingerprint: String::new(),
                rectify: RectifyProvenance::NotApplicable,
                privacy: DatasetPrivacy::default(),
                stale: None,
            };
            deps.working_set.register_result(descriptor);
            panic!("simulated post-register panic in tool dispatch")
        }
    }

    /// A materializer that parks past a short no-progress cap, then lands a
    /// normal result -- the freeze-window fixture: the tools/call serving it
    /// must freeze the turn's clock for the whole gate + dispatch window
    /// (ADR-0115), so a watchdog fire mid-dispatch (the ADR-0081 mis-kill
    /// shape) is observable only by its absence.
    struct SleepyMaterializer {
        ms: u64,
    }
    impl Materializer for SleepyMaterializer {
        fn try_materialize(
            &self,
            _sql: &str,
            _cancel: &CancelToken,
            result_name: String,
            _deps: &mut DispatchDeps,
        ) -> Result<DatasetDescriptor, ExecError> {
            thread::sleep(Duration::from_millis(self.ms));
            Ok(DatasetDescriptor {
                reference_name: result_name.clone(),
                display_name: result_name,
                source_path: String::new(),
                columns: Vec::new(),
                row_count: 0,
                sample: Vec::new(),
                fingerprint: String::new(),
                rectify: RectifyProvenance::NotApplicable,
                privacy: DatasetPrivacy::default(),
                stale: None,
            })
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
                        Ok((stream, _)) => {
                            // The listener polls nonblocking, and a Windows
                            // accept inherits that mode: reset the stream so
                            // serve_one_rpc's blocking reads WAIT for the
                            // request instead of misreading a WouldBlock
                            // mid-body as a short read (issue #1332).
                            let _ = stream.set_nonblocking(false);
                            serve_one_rpc(stream)
                        }
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
        // Graceful close (issue #1332): `write_all` returning only means the
        // kernel took the bytes -- on loopback much of the body can still sit
        // in the receiver's buffer, and a bare drop can close abortively, so
        // the RST would discard what the client has not read yet (the failure
        // lands mid-body as os error 10053/10054 under parallel load). FIN
        // first -- the FIN is ordered after the pending data -- then hold the
        // socket until the peer closed, so the whole body always lands.
        let _ = stream.shutdown(std::net::Shutdown::Write);
        // The peer's close is the deterministic end signal; every client of
        // this fixture reads its response out and closes straight away. The
        // bound only guards a client that never closes: it parks the accept
        // loop (and Drop's join), so past this deadline the drain gives up
        // and the close is whatever a bare drop would have been.
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut sink = [0u8; 4096];
        loop {
            match stream.read(&mut sink) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
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
                {"name": "big", "description": "returns a cap-crossing text",
                 "inputSchema": {"type": "object"}},
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
                    "big" => json!({"content": [{"type": "text", "text": "x".repeat(
                                crate::cli_tools::executor::OUTPUT_CAP_BYTES + 1)}],
                               "isError": false}),
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
                headers: std::collections::BTreeMap::new(),
            },
            env: std::collections::BTreeMap::new(),
            keychain_env_keys: Vec::new(),
            keychain_header_keys: Vec::new(),
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

    /// Issue #1332: the fixture's accepted stream must WAIT for a request
    /// body that lands in a second write. The listener polls nonblocking,
    /// and a Windows accept inherits that mode -- without the explicit
    /// reset, `serve_one_rpc`'s blocking-read assumptions break and a
    /// WouldBlock mid-body reads as a short body, closing with no response
    /// (the client then dies at the status line with os error 10053).
    /// Under full-suite parallel load the POSTs split across writes
    /// regularly, which is what made the live_ctx family flake; splitting
    /// the write deliberately pins the tolerant shape.
    #[test]
    fn live_fixture_serves_a_request_whose_body_lands_in_a_second_write() {
        let server = LiveMcpServer::spawn();
        let mut stream = TcpStream::connect(("127.0.0.1", server.port)).expect("connect");
        let body = json!({"jsonrpc": "2.0", "id": 7, "method": "tools/list"}).to_string();
        let head = format!(
            "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n",
            body.len()
        );
        let split = body.len() / 2;
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(&body.as_bytes()[..split]).unwrap();
        stream.flush().unwrap();
        // Let the fixture accept and park inside the body read with only
        // half of it on the wire -- a blocking read waits for the rest
        // instead of treating the gap as a short body.
        thread::sleep(Duration::from_millis(150));
        stream.write_all(&body.as_bytes()[split..]).unwrap();
        stream.flush().unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(
            response.starts_with("HTTP/1.1 200 OK"),
            "the split write still gets the full response: {response}"
        );
        assert!(
            response.contains("\"id\":7"),
            "the answer matches the request id: {response}"
        );
    }

    // --- pure helpers ------------------------------------------------------

    /// An in-memory `AsyncWrite` sink for the `Cursor`-mocked verify pins
    /// (std's Vec implements no tokio trait, the orphan rule). Writes always
    /// succeed immediately; `contents()` reads the bytes back (the retired
    /// std-Vec writer's assert shape).
    #[derive(Default)]
    struct VecWriter(Vec<u8>);

    impl VecWriter {
        fn contents(&self) -> Vec<u8> {
            self.0.clone()
        }
    }

    impl tokio::io::AsyncWrite for VecWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            self.get_mut().0.extend_from_slice(buf);
            std::task::Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }

        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// The keep-alive frame's wire shape (issue #1267): a `notifications/progress`
    /// notification echoing the request's progress token, a monotonically
    /// increasing progress counter, and a message naming the approval wait --
    /// everything the bridge client's timeout reset needs.
    #[test]
    fn progress_notification_pins_the_wire_shape() {
        let token = json!("tok-7");
        let f1 = progress_notification(&token, 1);
        assert_eq!(f1["method"], "notifications/progress");
        assert_eq!(f1["params"]["progressToken"], "tok-7");
        assert_eq!(f1["params"]["progress"], 1);
        assert_eq!(f1["params"]["message"], "awaiting approval");
        assert!(f1.get("id").is_none(), "a notification carries no id");
        let f3 = progress_notification(&token, 3);
        assert_eq!(f3["params"]["progress"], 3, "the counter is monotonic");
    }

    /// The keep-alive companion's lifecycle (issue #1267): while a
    /// dispatched `tools/call` is armed, one progress notification per
    /// interval lands on the wire (the injected interval keeps the pin
    /// fast; production rides the 20 s constant), and disarming silences
    /// the cadence. The duplex pipe stands in for the socket (the
    /// companion only needs an `AsyncWrite` behind the shared funnel).
    #[test]
    fn keepalive_frames_ride_the_dispatch_wait_until_disarmed() {
        use tokio::io::AsyncReadExt as _;

        let (mut reader, writer_end) = tokio::io::duplex(4096);
        let writer = std::sync::Arc::new(tokio::sync::Mutex::new(writer_end));
        let guard = KeepaliveGuard::start_with_interval(
            std::sync::Arc::clone(&writer),
            Duration::from_millis(120),
        );

        guard.arm(json!("tok-1"));
        thread::sleep(Duration::from_millis(500));
        guard.disarm();
        guard.stop();
        // The last writer (the guard thread's funnel clone + this one)
        // drops, so the drain below sees EOF.
        drop(writer);
        let mut buf = Vec::new();
        let _ = crate::mcp::client::block_on(reader.read_to_end(&mut buf));
        let frames: Vec<Value> = buf
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice(line).expect("a json frame"))
            .collect();
        assert!(
            frames.len() >= 2 && frames.len() <= 6,
            "keep-alive cadence while armed, then silence: {:?}",
            frames
        );
        for frame in &frames {
            assert_eq!(frame["method"], "notifications/progress");
            assert_eq!(frame["params"]["progressToken"], "tok-1");
        }
    }

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

    #[tokio::test]
    async fn verify_bridge_accepts_correct_token_then_writes_ok() {
        let input = Cursor::new(b"BRIDGE_AUTH deadbeef\n".to_vec());
        let mut reader = tokio::io::BufReader::new(input);
        let mut writer = VecWriter::default();
        verify_bridge(
            &mut reader,
            &mut writer,
            "deadbeef",
            &CancelToken::new(),
            &AtomicBool::new(false),
        )
        .await
        .expect("accepted");
        assert_eq!(writer.contents(), b"BRIDGE_OK\n");
    }

    #[tokio::test]
    async fn verify_bridge_rejects_wrong_token_with_permission_denied() {
        let input = Cursor::new(b"BRIDGE_AUTH wrong\n".to_vec());
        let mut reader = tokio::io::BufReader::new(input);
        let mut writer = VecWriter::default();
        let err = verify_bridge(
            &mut reader,
            &mut writer,
            "expected",
            &CancelToken::new(),
            &AtomicBool::new(false),
        )
        .await
        .expect_err("mismatch");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            writer.contents().is_empty(),
            "no response on a refused handshake"
        );
    }

    #[tokio::test]
    async fn verify_bridge_treats_clean_eof_as_refused() {
        // A probing client that connects + closes without sending a token line
        // must not crash the gateway -- the bounded read reports EOF and the
        // empty line falls through to the mismatch arm (PermissionDenied).
        let input = Cursor::new(Vec::new());
        let mut reader = tokio::io::BufReader::new(input);
        let mut writer = VecWriter::default();
        let err = verify_bridge(
            &mut reader,
            &mut writer,
            "x",
            &CancelToken::new(),
            &AtomicBool::new(false),
        )
        .await
        .expect_err("eof refused");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    /// Issue #911 deterministic seam: a pre-auth reader whose parked read dies
    /// with a hard reset the instant the termination lands -- the fire closure
    /// runs (setting `engine_done` or requesting cancel) and the SAME fill_buf
    /// call surfaces the reset, so the error reaches the error arm with the
    /// flag already set (the #909 main scenario's shape: engine completes ->
    /// teardown kills the CLI -> on Windows the job-object kill aborts the
    /// bridge's sockets into the RST that wakes the parked read). A reverted
    /// arm re-check fails by surfacing the reset as a serve error that
    /// mislabels the completed turn as Failed.
    struct RacingResetReader<'a> {
        fire: Box<dyn Fn() + 'a>,
    }
    impl tokio::io::AsyncRead for RacingResetReader<'_> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            let available = std::task::ready!(self.as_mut().poll_fill_buf(cx))?;
            let n = available.len().min(buf.remaining());
            buf.put_slice(&available[..n]);
            self.consume(n);
            std::task::Poll::Ready(Ok(()))
        }
    }
    impl tokio::io::AsyncBufRead for RacingResetReader<'_> {
        fn poll_fill_buf(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<&[u8]>> {
            (self.fire)();
            std::task::Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                "simulated teardown reset",
            )))
        }
        fn consume(self: std::pin::Pin<&mut Self>, _amt: usize) {}
    }

    /// Issue #913 deterministic seam: the graceful twin of the #911 racing
    /// reset -- the fire closure runs (setting `engine_done` or requesting
    /// cancel) and the SAME fill_buf call returns a clean EOF (the POSIX
    /// teardown's killpg SIGKILL closes the bridge's socket gracefully: FIN,
    /// not RST), so the EOF reaches the pre-auth EOF arm with the flag
    /// already set. A reverted arm re-check fails by refusing the handshake
    /// as a token mismatch.
    struct RacingEofReader<'a> {
        fire: Box<dyn Fn() + 'a>,
    }
    impl tokio::io::AsyncRead for RacingEofReader<'_> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            let available = std::task::ready!(self.as_mut().poll_fill_buf(cx))?;
            let n = available.len().min(buf.remaining());
            buf.put_slice(&available[..n]);
            self.consume(n);
            std::task::Poll::Ready(Ok(()))
        }
    }
    impl tokio::io::AsyncBufRead for RacingEofReader<'_> {
        fn poll_fill_buf(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<&[u8]>> {
            (self.fire)();
            std::task::Poll::Ready(Ok(&[]))
        }
        fn consume(self: std::pin::Pin<&mut Self>, _amt: usize) {}
    }

    /// Issue #913 refusal-stance seam: the fire closure runs on the fill_buf
    /// that DELIVERS the wrong auth line -- the flag is set by the time the
    /// mismatch arm decides (past the loop top, which saw it clear), exactly
    /// the state a mutation adding a flag gate to the refusal would act on.
    /// Pre-firing the flag outside the read would never reach the arm (the
    /// loop top hands the turn to the termination first).
    struct RacingWrongLineReader<'a> {
        line: Vec<u8>,
        fire: Box<dyn Fn() + 'a>,
    }
    impl tokio::io::AsyncRead for RacingWrongLineReader<'_> {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            let available = std::task::ready!(self.as_mut().poll_fill_buf(cx))?;
            let n = available.len().min(buf.remaining());
            buf.put_slice(&available[..n]);
            self.consume(n);
            std::task::Poll::Ready(Ok(()))
        }
    }
    impl tokio::io::AsyncBufRead for RacingWrongLineReader<'_> {
        fn poll_fill_buf(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<&[u8]>> {
            let this = self.get_mut();
            if !this.line.is_empty() {
                (this.fire)();
            }
            std::task::Poll::Ready(Ok(&this.line))
        }
        fn consume(self: std::pin::Pin<&mut Self>, amt: usize) {
            self.get_mut().line.drain(..amt);
        }
    }

    /// Issue #909: a cancel that fired before the handshake begins terminates
    /// the pre-auth window without touching the stream -- the turn belongs to
    /// the ACP termination, never the gateway.
    #[tokio::test]
    async fn verify_bridge_pre_fired_cancel_returns_terminated() {
        let input = Cursor::new(Vec::new());
        let mut reader = tokio::io::BufReader::new(input);
        let mut writer = VecWriter::default();
        let cancel = CancelToken::new();
        cancel.request();
        let verified = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &cancel,
            &AtomicBool::new(false),
        )
        .await
        .expect("terminated, not a refused handshake");
        assert!(!verified, "the pre-auth window ended in termination");
        assert!(
            writer.contents().is_empty(),
            "no response on a terminated handshake"
        );
    }

    /// Issue #909 at the serve seam since #1457: a bridge that connects
    /// but stalls before its auth line while the engine completes -- the
    /// flag fires while the reader's auth read parks, and that read can
    /// never be woken by anything but the socket (see `serve_reader`'s
    /// doc), so the observation rides the spine's beat: serve returns the
    /// empty outcome within one SERVE_BEAT of the flag and the ACP
    /// termination decides the TurnOutcome.
    #[test]
    fn serve_connection_returns_on_engine_done_during_a_stalled_pre_auth_read() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let engine_done = Arc::new(AtomicBool::new(false));
        let done_for_engine = Arc::clone(&engine_done);

        // The stalling bridge: connect, then send NO auth line -- the
        // handshake read parks. Dropping the socket at the end is what
        // retires the leaked reader task in the test process.
        let client = thread::spawn(move || {
            let _s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            thread::sleep(Duration::from_millis(600));
        });

        // Engine stand-in: let the accept + the auth read park, then arm.
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            done_for_engine.store(true, Ordering::SeqCst);
        });

        let start = Instant::now();
        let outcome = serve_connection(handle, ctx, &engine_done).expect("serve");
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(2),
            "serve returned promptly on engine_done during the stalled pre-auth read: {elapsed:?}"
        );
        assert!(
            outcome.trace.is_empty(),
            "a turn terminated pre-auth collects no trace"
        );
        let _ = client.join();
    }

    /// Issue #911: engine completion racing the teardown reset OUT of the
    /// parked auth read -- the flag fires inside the read that then surfaces
    /// the reset, so the error arm's re-check (not the loop top, which has
    /// already passed) is what hands the turn to the ACP termination. A
    /// reverted re-check mislabels the completed turn as Failed(Runtime).
    #[tokio::test]
    async fn verify_bridge_engine_done_racing_reset_returns_terminated() {
        let engine_done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&engine_done);
        let mut reader = RacingResetReader {
            fire: Box::new(move || flag.store(true, Ordering::SeqCst)),
        };
        let mut writer = VecWriter::default();
        let verified = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &CancelToken::new(),
            &engine_done,
        )
        .await
        .expect("terminated, not the reset surfacing as a serve error");
        assert!(!verified, "the pre-auth window ended in termination");
        assert!(
            writer.contents().is_empty(),
            "no response on a terminated handshake"
        );
    }

    /// Issue #911 cancel twin: the same race with the cancel token firing
    /// inside the read that surfaces the reset.
    #[tokio::test]
    async fn verify_bridge_cancel_racing_reset_returns_terminated() {
        let cancel = CancelToken::new();
        let mut reader = RacingResetReader {
            fire: Box::new(|| cancel.request()),
        };
        let mut writer = VecWriter::default();
        let verified = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &cancel,
            &AtomicBool::new(false),
        )
        .await
        .expect("terminated, not the reset surfacing as a serve error");
        assert!(!verified, "the pre-auth window ended in termination");
        assert!(
            writer.contents().is_empty(),
            "no response on a terminated handshake"
        );
    }

    /// Issue #911 truthful-error half: a hard reset with NO termination flag
    /// is a genuine pre-auth bridge death -- the arm re-check must not
    /// swallow it.
    #[tokio::test]
    async fn verify_bridge_reset_without_flags_stays_a_serve_error() {
        let mut reader = RacingResetReader {
            fire: Box::new(|| {}),
        };
        let mut writer = VecWriter::default();
        let err = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &CancelToken::new(),
            &AtomicBool::new(false),
        )
        .await
        .expect_err("no flag set -> the reset surfaces");
        assert_eq!(err.kind(), io::ErrorKind::ConnectionReset);
        assert!(
            writer.contents().is_empty(),
            "no response on a refused handshake"
        );
    }

    /// Issue #913: engine completion racing the POSIX teardown's graceful
    /// close OUT of the parked auth read -- the flag fires inside the read
    /// that then returns a clean EOF (killpg SIGKILL FINs where the Windows
    /// job-object kill resets), so the EOF arm's flag check (not the loop
    /// top, which has already passed) hands the turn to the ACP
    /// termination. A reverted check mislabels the completed turn as
    /// Failed(Runtime) via the token-mismatch refusal.
    #[tokio::test]
    async fn verify_bridge_engine_done_racing_eof_returns_terminated() {
        let engine_done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&engine_done);
        let mut reader = RacingEofReader {
            fire: Box::new(move || flag.store(true, Ordering::SeqCst)),
        };
        let mut writer = VecWriter::default();
        let verified = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &CancelToken::new(),
            &engine_done,
        )
        .await
        .expect("terminated, not the EOF surfacing as a refused handshake");
        assert!(!verified, "the pre-auth window ended in termination");
        assert!(
            writer.contents().is_empty(),
            "no response on a terminated handshake"
        );
    }

    /// Issue #913 cancel twin: the same race with the cancel token firing
    /// inside the read that returns the clean EOF.
    #[tokio::test]
    async fn verify_bridge_cancel_racing_eof_returns_terminated() {
        let cancel = CancelToken::new();
        let mut reader = RacingEofReader {
            fire: Box::new(|| cancel.request()),
        };
        let mut writer = VecWriter::default();
        let verified = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &cancel,
            &AtomicBool::new(false),
        )
        .await
        .expect("terminated, not the EOF surfacing as a refused handshake");
        assert!(!verified, "the pre-auth window ended in termination");
        assert!(
            writer.contents().is_empty(),
            "no response on a terminated handshake"
        );
    }

    /// Issue #913 refusal-stance pin: a wrong token with the termination
    /// flags already set still refuses -- the mismatch arm never re-checks
    /// (a wrong token is a genuine bridge-side defect that must surface in
    /// any flag state), so a mutation giving the refusal a flag gate dies
    /// here.
    #[tokio::test]
    async fn verify_bridge_wrong_token_with_flags_set_stays_refused() {
        let engine_done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&engine_done);
        let mut reader = RacingWrongLineReader {
            line: b"BRIDGE_AUTH wrong\n".to_vec(),
            fire: Box::new(move || flag.store(true, Ordering::SeqCst)),
        };
        let mut writer = VecWriter::default();
        let err = verify_bridge(
            &mut reader,
            &mut writer,
            "expected",
            &CancelToken::new(),
            &engine_done,
        )
        .await
        .expect_err("a wrong token refuses in any flag state");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            writer.contents().is_empty(),
            "no response on a refused handshake"
        );
    }

    /// Issue #913 refusal-stance pin, over-long half: the same stance as
    /// the wrong-token pin one test up, for the sibling refusal clause -- an
    /// over-long line with the termination flag set still refuses, so a
    /// copy-paste mutation adding the EOF arm's flag gate to the over-long
    /// arm dies here.
    #[tokio::test]
    async fn verify_bridge_overlong_with_flags_set_stays_refused() {
        let engine_done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&engine_done);
        let wire = format!("{}\n", "x".repeat(LINE_MAX_BYTES));
        let mut reader = RacingWrongLineReader {
            line: wire.into_bytes(),
            fire: Box::new(move || flag.store(true, Ordering::SeqCst)),
        };
        let mut writer = VecWriter::default();
        let err = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &CancelToken::new(),
            &engine_done,
        )
        .await
        .expect_err("an over-long line refuses in any flag state");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            writer.contents().is_empty(),
            "no response on a refused handshake"
        );
    }

    /// Issue #643: the pre-auth surface. An over-long auth line is refused
    /// with the same `PermissionDenied` as a token mismatch (no observable
    /// difference for a prober) instead of growing the buffer with the line.
    #[tokio::test]
    async fn verify_bridge_refuses_an_overlong_auth_line() {
        let wire = format!("{}\n", "x".repeat(LINE_MAX_BYTES));
        let input = Cursor::new(wire.into_bytes());
        let mut reader = tokio::io::BufReader::new(input);
        let mut writer = VecWriter::default();
        let err = verify_bridge(
            &mut reader,
            &mut writer,
            "tok",
            &CancelToken::new(),
            &AtomicBool::new(false),
        )
        .await
        .expect_err("over-long refused");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            writer.contents().is_empty(),
            "no response on a refused handshake"
        );
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
            keychain_header_keys: Vec::new(),
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

        let outcome =
            serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false))).expect("serve");

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

    /// Issue #899: a pre-fired `engine_done` at the serve_connection layer
    /// returns `Ok` with an empty outcome promptly -- the accept-side arm
    /// hands the turn back to the ACP termination (single-source) instead
    /// of burning `CONNECT_DEADLINE` and surfacing a serve error for a
    /// turn whose engine already finished. Complements the per-arm unit
    /// pins (the accept `None`, the serve-loop exit) at the wiring layer
    /// the turn assembler actually calls.
    #[test]
    fn serve_connection_returns_empty_outcome_when_engine_done_prefires() {
        let handle = bind_gateway().expect("bind");
        let ctx = fresh_ctx();
        let engine_done = Arc::new(AtomicBool::new(true));
        let start = Instant::now();
        let outcome = serve_connection(handle, ctx, &engine_done).expect("serve");
        assert!(
            outcome.trace.is_empty(),
            "no bridge ever connected -> empty trace"
        );
        assert!(
            outcome.promotions.is_empty(),
            "no bridge ever connected -> no promotion"
        );
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "pre-fired engine_done returns promptly, not after CONNECT_DEADLINE: {:?}",
            start.elapsed()
        );
    }

    /// The deterministic terminator (issue #357): with the bridge socket held
    /// OPEN (no EOF), serve_connection still returns promptly when
    /// `engine_done` is set -- it does not wait for the bridge to disconnect.
    /// Without this flag the serve would block on `read_message` until the
    /// armed no-progress clock fired on generation silence and the serve's
    /// loop-top cancel check exited -- a ~cap-bounded exit, but a slow one
    /// that mislabels a finished turn as a watchdog kill. The flag makes
    /// serve's return prompt and independent of the watchdog. (This test
    /// arms no clock, so without the flag its park would be truly
    /// unbounded.) Drives initialize +
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

        // The loop-top check fires within one SERVE_BEAT (100ms) of the flag
        // store; the connect + exchange + 150ms park budget stays well under
        // 2s. The prior behavior parked until the whole-turn wall-clock
        // timeout (retired by ADR-0115) fired.
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

    /// Issue #801: the bridge process dies with the turn's CLI, and a hard
    /// death closes the TCP connection with a reset, not a FIN. The reset
    /// must land in the same disposition as the read EOF -- serve returns
    /// what it collected, the ACP engine owns the turn's fate -- instead of
    /// failing the whole turn (`gateway serve failed: ... os error 10054`).
    /// A `mcp_list_servers` call is served first so the collected trace is
    /// non-empty: its survival across the reset is the contract's payload.
    #[test]
    fn serve_connection_tolerates_bridge_reset_after_served_call() {
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
            // A served local meta call: one trace row, no gate, no DuckDB.
            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                        "params": {"name": "mcp_list_servers", "arguments": {}}}),
            )
            .expect("send call");
            let resp = framing::read_message(&mut r)
                .expect("read call")
                .expect("resp");
            assert_eq!(resp["id"], 1);
            // Then request the tool table and read NOTHING back: the unread
            // response parks in this socket's receive buffer, and closing a
            // socket with unread received data makes the OS send RST instead
            // of FIN (Windows + Linux alike) -- a real reset without the
            // unstable std SO_LINGER API. The sleep gives the response time
            // to land unread before the close (a race would fall back to FIN
            // + the EOF arm, same disposition); `s` + `r` drop at thread end.
            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            )
            .expect("send list");
            thread::sleep(Duration::from_millis(300));
        });

        let outcome =
            serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false))).expect("serve");

        client.join().expect("client thread panicked");
        assert_eq!(
            outcome.trace.len(),
            1,
            "the served call's trace row survives the reset"
        );
        assert_eq!(
            outcome.trace[0].name, "mcp_list_servers",
            "the survived row is the served call itself"
        );
        assert!(outcome.promotions.is_empty(), "no materialize");
    }

    /// Issue #801, write arm: a bridge that dies while serve is parked in a
    /// response write aborts the write with ConnectionReset / BrokenPipe.
    /// Same collected-Ok disposition -- the request was already served, the
    /// turn's fate belongs to the ACP engine. The client never reads the
    /// response: on a default-tuned stack (64 KiB-class buffers) the
    /// inflated tools/list table exceeds what the un-read socket absorbs, so
    /// serve parks in the response write and the client's reset aborts it; a
    /// stack with a larger autotuned window absorbs the write and the reset
    /// falls to the read arm instead -- the assertion holds under either
    /// path.
    #[test]
    fn serve_connection_tolerates_bridge_reset_during_response_write() {
        // 64 registrations x 4 KiB descriptions inflate the table to ~256 KiB,
        // past any receive window a shrunk buffer admits.
        let cli: Vec<crate::cli_tools::config::CliToolConfig> = (0..64)
            .map(|i| bulky_cli_tool(format!("bulk-{i:02}"), "x".repeat(4096)))
            .collect();
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static NoopSink = Box::leak(Box::new(NoopSink));
        let ctx = gate_ctx(cli, approval, sink);
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
            // Request the inflated table and read NOTHING back: on this
            // default-tuned stack the table exceeds what the un-read socket
            // absorbs, so serve parks in the response write; the sleep gives
            // the park time to settle (a window large enough to absorb the
            // write routes the reset to the read arm -- same disposition).
            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            )
            .expect("send list");
            thread::sleep(Duration::from_millis(300));
            // Closing with the partial response still unread sends RST,
            // aborting serve's parked write with ConnectionReset /
            // BrokenPipe. `s` + `r` drop at thread end.
        });

        let outcome =
            serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false))).expect("serve");

        client.join().expect("client thread panicked");
        assert!(
            outcome.trace.is_empty(),
            "tools/list touches no trace (no call landed)"
        );
        assert!(outcome.promotions.is_empty(), "no materialize");
    }

    /// The write-arm test's table inflator: a registration carrying nothing
    /// but a large LLM-visible description -- the `tools/list` table's size
    /// is the only property the test needs from it.
    fn bulky_cli_tool(
        name: String,
        description: String,
    ) -> crate::cli_tools::config::CliToolConfig {
        use crate::cli_tools::config::{CliToolConfig, CliToolSource};
        CliToolConfig {
            name,
            description,
            executable: "/no/such/cli-fixture-exe".into(),
            argv_template: Vec::new(),
            params: Vec::new(),
            env: Default::default(),
            enabled: true,
            source: CliToolSource::User,
            baseline: None,
        }
    }

    /// Issue #646: an over-long request frame from the bridge fails the serve
    /// with the framing error instead of being dropped -- a dropped frame
    /// would leave the bridge's request unreplied and the turn hung with no
    /// exit: the serving segment is frozen under ADR-0115, so the no-progress
    /// clock never fires mid-wait. The error surfaces through the serve's `Err` path,
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

        let err = serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false)))
            .expect_err("an over-long request frame must fail the serve");
        client.join().expect("client thread panicked");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains(&LINE_MAX_BYTES.to_string()),
            "the error names the cap: {err}"
        );
    }

    /// Issue #649: a sender that pauses mid-frame for longer than
    /// SERVE_BEAT still completes the frame. Before the resumable frame
    /// reader the retried read re-framed from the stream's mid-line
    /// position, so this exchange failed as a protocol error (the tail
    /// parsed as a malformed fresh line) instead of serving the request.
    /// The follow-up frame pins that the line state resets cleanly after a
    /// resumed line.
    #[test]
    fn serve_connection_completes_frame_split_by_read_timeouts() {
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
            // Regression guard on the response reads: a reverted serve would
            // leave this client parked -- the timeout turns that into a
            // diagnostic failure (same rationale as the over-long test).
            s.set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set read timeout");
            // Half an initialize frame, a pause longer than SERVE_BEAT
            // (100ms) so the serve's read times out mid-line -- typically
            // at least twice, though the count is timing-dependent and any
            // single timeout exercises the resume -- then the frame's tail
            // + terminator.
            let frame = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize"});
            let wire = serde_json::to_string(&frame).expect("serialize");
            let wire = wire.as_bytes();
            let split = wire.len() / 2;
            s.write_all(&wire[..split]).expect("send frame head");
            thread::sleep(Duration::from_millis(300));
            s.write_all(&wire[split..]).expect("send frame tail");
            s.write_all(b"\n").expect("send terminator");
            let init = framing::read_message(&mut r)
                .expect("read init")
                .expect("resp");
            assert_eq!(init["id"], 1);
            assert_eq!(init["result"]["serverInfo"]["name"], "toptopduck-gateway");
            // A normal follow-up frame: the line state reset after the
            // resumed line.
            framing::write_message(
                &mut s,
                &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
            )
            .expect("send list");
            let list = framing::read_message(&mut r)
                .expect("read list")
                .expect("resp");
            assert_eq!(list["id"], 2);
            // `s` drops here -> gateway read EOF -> serve_connection returns.
        });

        let outcome =
            serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false))).expect("serve");
        client.join().expect("client thread panicked");
        assert!(
            outcome.trace.is_empty(),
            "init + tools/list do not touch the trace"
        );
    }

    /// Issue #649: the over-long cause survives a mid-frame pause. The
    /// frame's head lands under the cap, the stall trips read timeouts
    /// mid-line, then the tail pushes the line past [`LINE_MAX_BYTES`] --
    /// the resumed accumulation must still fail with the cap-named
    /// `InvalidData`, never accept the tail as a fresh small line.
    #[test]
    fn serve_connection_fails_overlong_frame_split_across_timeouts() {
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
            // Head under the cap, a stall longer than SERVE_BEAT, then the
            // tail that pushes the line past the cap (newline-terminated so
            // the drain settles).
            let half = LINE_MAX_BYTES / 2;
            s.write_all(&vec![b'x'; half]).expect("send head half");
            thread::sleep(Duration::from_millis(300));
            let mut tail = vec![b'x'; half + 1];
            tail.push(b'\n');
            s.write_all(&tail).expect("send over-long tail");
            // The gateway tears the connection down (same shape as the
            // unsplit over-long test): EOF or reset, never a response.
            s.set_read_timeout(Some(Duration::from_secs(5)))
                .expect("set tail read timeout");
            let mut tail_line = String::new();
            match r.read_line(&mut tail_line) {
                // Clean EOF: the teardown arrived with zero response bytes.
                Ok(0) => {}
                Ok(n) => panic!("connection closed without a response, got {n} bytes"),
                // A reset teardown surfaces as an error -- still no response.
                Err(e) if e.kind() != io::ErrorKind::TimedOut => {}
                Err(e) => panic!("no teardown in 5s -- over-long cause lost to the stall: {e}"),
            }
        });

        let err = serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false)))
            .expect_err("an over-long frame split by a stall must still fail the serve");
        client.join().expect("client thread panicked");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains(&LINE_MAX_BYTES.to_string()),
            "the error names the cap: {err}"
        );
    }

    /// Issue #909: a bridge that connects but stalls before writing its auth
    /// line, racing an engine completion -- the pre-auth verify read must hand
    /// the turn to the ACP termination (empty outcome), not surface the serve
    /// error that mislabels the completed turn as Failed. The flag lands
    /// mid-window: after accept has returned (an earlier flag would exit at
    /// the accept_bridge engine_done arm instead), during the stalled auth
    /// read retry passes.
    #[test]
    fn serve_connection_preauth_stall_engine_done_returns_empty_outcome() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let engine_done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&engine_done);

        // Connect and stall -- never write the auth line. The flag fires
        // from this thread mid-window (well after accept, inside the auth
        // read retry cadence); the socket then stays open long enough for
        // the retry loop-top check to observe the flag before any EOF
        // could race in as a mismatch.
        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            thread::sleep(Duration::from_millis(200));
            flag.store(true, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(200));
            drop(s);
        });
        let outcome = serve_connection(handle, ctx, &engine_done)
            .expect("flags fired in the pre-auth window hand the turn to the ACP termination");
        assert!(
            outcome.trace.is_empty() && outcome.promotions.is_empty(),
            "the terminated pre-auth window collects nothing: {outcome:?}"
        );
        client.join().expect("client thread panicked");
    }

    /// Close a connected socket abortively so the peer's parked read surfaces
    /// a hard reset (RST, not FIN): SO_LINGER with a zero timeout makes close
    /// discard pending data with a reset. This is the shape the Windows
    /// production teardown produces when it kills the bridge's spawner -- a
    /// job-object terminate aborts the sockets into resets (issue #911's
    /// racing error); a plain drop would only FIN and read as EOF. The POSIX
    /// teardown (killpg SIGKILL) closes gracefully instead: its EOF takes the
    /// flag-checked disposition of its own arm (issue #913).
    fn abortive_close(s: TcpStream) {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawSocket;
            use windows_sys::Win32::Networking::WinSock::{
                setsockopt, LINGER, SOCKET, SOL_SOCKET, SO_LINGER,
            };
            let linger = LINGER {
                l_onoff: 1,
                l_linger: 0,
            };
            // SAFETY: the socket handle is owned by `s` and outlives the
            // call; the option buffer points at the stack linger struct for
            // exactly the call's length.
            let r = unsafe {
                setsockopt(
                    s.as_raw_socket() as SOCKET,
                    SOL_SOCKET,
                    SO_LINGER,
                    &linger as *const LINGER as *const u8,
                    std::mem::size_of::<LINGER>() as i32,
                )
            };
            // A failed option call degrades the close to a graceful FIN,
            // which the pins below would surface as a misleading token
            // mismatch -- fail here instead, at the fixture's seam.
            assert_eq!(r, 0, "SO_LINGER(0) failed: {}", io::Error::last_os_error());
            drop(s);
        }
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let linger = libc::linger {
                l_onoff: 1,
                l_linger: 0,
            };
            // SAFETY: same shape as the Windows arm -- an owned fd plus a
            // stack option buffer sized for exactly the call.
            let r = unsafe {
                libc::setsockopt(
                    s.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_LINGER,
                    &linger as *const libc::linger as *const libc::c_void,
                    std::mem::size_of::<libc::linger>() as libc::socklen_t,
                )
            };
            assert_eq!(r, 0, "SO_LINGER(0) failed: {}", io::Error::last_os_error());
            drop(s);
        }
    }

    /// Issue #911 serve-layer pin: the #909 main scenario's tail over a real
    /// socket -- the engine completes while serve is parked in the pre-auth
    /// auth read, and the teardown's kill lands on the bridge as an abortive
    /// close (RST, the Windows job-object kill's shape -- the POSIX killpg
    /// teardown FINs instead, pinned by the #913 EOF twin below) that
    /// wakes the parked read BEFORE its SERVE_BEAT fires.
    /// The error arm's re-check (not the loop top, which the parked read has
    /// already passed) hands the turn to the ACP termination; a reverted
    /// re-check surfaces the reset as a serve error that mislabels the
    /// completed turn as Failed. The #909 e2e kept the socket deliberately
    /// open past this window, so this is the race it could not cover.
    #[test]
    fn serve_connection_preauth_reset_racing_engine_done_returns_empty_outcome() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let engine_done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&engine_done);

        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            // Serve accepts within one poll interval (10ms) and parks in the
            // FIRST auth read, whose SERVE_BEAT fires at ~t=110ms -- firing
            // at 50ms keeps the flag store + the RST (20ms later, plus timer
            // grain) structurally inside that first park, so the reset is
            // what wakes the read and reaches the error arm; a later firing
            // would race the retry cadence's loop-top check instead.
            thread::sleep(Duration::from_millis(50));
            flag.store(true, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(20));
            abortive_close(s);
        });
        let outcome = serve_connection(handle, ctx, &engine_done)
            .expect("a reset racing a set flag hands the turn to the ACP termination");
        assert!(
            outcome.trace.is_empty() && outcome.promotions.is_empty(),
            "the terminated pre-auth window collects nothing: {outcome:?}"
        );
        client.join().expect("client thread panicked");
    }

    /// Issue #911 truthful-error half at the serve layer: an abortive close
    /// with NO termination flag is a genuine pre-auth bridge death -- the
    /// error arm's re-check must not swallow it into an empty outcome.
    #[test]
    fn serve_connection_preauth_reset_without_flags_surfaces_serve_error() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;

        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            // Park serve in the auth read first so the RST wakes the read
            // itself (an early close could land inside the accept window).
            thread::sleep(Duration::from_millis(150));
            abortive_close(s);
        });
        let err = serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false)))
            .expect_err("no flag set -> the pre-auth reset surfaces");
        assert_eq!(
            err.kind(),
            io::ErrorKind::ConnectionReset,
            "the raw bridge death reaches the turn assembler"
        );
        client.join().expect("client thread panicked");
    }

    /// Issue #913 serve-layer pin: the POSIX teardown shape over a real
    /// socket -- the engine completes while serve is parked in the pre-auth
    /// auth read, and the teardown's killpg SIGKILL closes the bridge's
    /// socket gracefully (FIN -- the plain-drop counterpart of
    /// `abortive_close`'s RST), waking the parked read as a clean EOF. The
    /// EOF arm's flag check (not the loop top, which the parked read has
    /// already passed) hands the turn to the ACP termination; a reverted
    /// check surfaces the EOF as a token mismatch that mislabels the
    /// completed turn as Failed.
    #[test]
    fn serve_connection_preauth_eof_racing_engine_done_returns_empty_outcome() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let engine_done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&engine_done);

        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            // Same first-park-window shape as the RST pin above (serve
            // accepts within one poll interval and parks in the FIRST auth
            // read, whose SERVE_BEAT fires at ~t=110ms): firing at 50ms
            // and closing 20ms later keeps the flag store + the FIN
            // structurally inside that park, so the EOF is what wakes the
            // read and reaches the EOF arm. The plain drop FINs because the
            // gateway has written nothing pre-auth for the client to leave
            // unread (unread data would turn the close into an RST).
            thread::sleep(Duration::from_millis(50));
            flag.store(true, Ordering::SeqCst);
            thread::sleep(Duration::from_millis(20));
            drop(s);
        });
        let outcome = serve_connection(handle, ctx, &engine_done)
            .expect("a graceful EOF racing a set flag hands the turn to the ACP termination");
        assert!(
            outcome.trace.is_empty() && outcome.promotions.is_empty(),
            "the terminated pre-auth window collects nothing: {outcome:?}"
        );
        client.join().expect("client thread panicked");
    }

    /// Issue #913 cancel twin of the #911 serve-layer RST pin: the token
    /// fires inside the first park window, then the abortive close wakes
    /// the parked read as a reset that reaches the error arm with the flag
    /// already set. Until now this disjunction of the error arm existed
    /// only at the unit seam.
    #[test]
    fn serve_connection_preauth_reset_racing_cancel_returns_empty_outcome() {
        let mut ctx = fresh_ctx();
        let cancel = Arc::new(CancelToken::new());
        ctx.cancel = Arc::clone(&cancel);
        let handle = bind_gateway().expect("bind");
        let port = handle.port;

        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            // First-park-window shape (see the engine_done twins above).
            thread::sleep(Duration::from_millis(50));
            cancel.request();
            thread::sleep(Duration::from_millis(20));
            abortive_close(s);
        });
        let outcome = serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false)))
            .expect("a reset racing a set cancel hands the turn to the ACP termination");
        assert!(
            outcome.trace.is_empty() && outcome.promotions.is_empty(),
            "the terminated pre-auth window collects nothing: {outcome:?}"
        );
        client.join().expect("client thread panicked");
    }

    /// Issue #911 cancel twin of the engine_done pin above: a bridge that
    /// connects but stalls before writing its auth line, with the cancel
    /// token firing mid-window -- the loop-top re-check returns the empty
    /// outcome so the ACP termination decides the TurnOutcome. The engine
    /// half was pinned at the serve layer by #909; the cancel half existed
    /// only as the unit seam until now.
    #[test]
    fn serve_connection_preauth_stall_cancel_returns_empty_outcome() {
        let mut ctx = fresh_ctx();
        let cancel = Arc::new(CancelToken::new());
        ctx.cancel = Arc::clone(&cancel);
        let handle = bind_gateway().expect("bind");
        let port = handle.port;

        // Connect and stall -- never write the auth line. The token fires
        // mid-window (well after accept, inside the auth read retry
        // cadence); the socket stays open long enough for the retry
        // loop-top check to observe the cancel before any EOF could race
        // in as a mismatch.
        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            thread::sleep(Duration::from_millis(200));
            cancel.request();
            thread::sleep(Duration::from_millis(200));
            drop(s);
        });
        let outcome = serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false)))
            .expect("cancel fired in the pre-auth window hands the turn to the ACP termination");
        assert!(
            outcome.trace.is_empty() && outcome.promotions.is_empty(),
            "the terminated pre-auth window collects nothing: {outcome:?}"
        );
        client.join().expect("client thread panicked");
    }

    /// Issue #915 FIN twin of the #913 cancel+RST pin: the cancel token
    /// fires inside the first park window, then the plain drop FINs -- the
    /// EOF arm's cancel disjunct over a real graceful close. Until now the
    /// disjunct existed only at the unit seam (the racing-EOF cancel twin)
    /// and the serve-level cancel close race only in its RST flavor (a
    /// reset rides the error arm's re-check, never the EOF arm); this pin
    /// composes the two.
    #[test]
    fn serve_connection_preauth_eof_racing_cancel_returns_empty_outcome() {
        let mut ctx = fresh_ctx();
        let cancel = Arc::new(CancelToken::new());
        ctx.cancel = Arc::clone(&cancel);
        let handle = bind_gateway().expect("bind");
        let port = handle.port;

        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            // First-park-window shape (see the engine_done FIN twin above
            // for the window arithmetic): the cancel store and the FIN
            // both land inside that park, so the EOF is what wakes the
            // read and reaches the EOF arm with the flag already set. The
            // plain drop FINs because the gateway has written nothing
            // pre-auth for the client to leave unread.
            thread::sleep(Duration::from_millis(50));
            cancel.request();
            thread::sleep(Duration::from_millis(20));
            drop(s);
        });
        let outcome = serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false)))
            .expect("a graceful EOF racing a set cancel hands the turn to the ACP termination");
        assert!(
            outcome.trace.is_empty() && outcome.promotions.is_empty(),
            "the terminated pre-auth window collects nothing: {outcome:?}"
        );
        client.join().expect("client thread panicked");
    }

    /// Issue #915 FIN counterpart of the #911 no-flag RST pin: a probing
    /// client that connects and closes gracefully under no termination flag
    /// stays the truthful refusal -- the EOF arm's else branch falls into
    /// the mismatch arm and the PermissionDenied propagates out of
    /// serve_connection. Until now the refusal face had no serve-level pin
    /// (the RST pin owns the truthful-error face), so the Err propagation
    /// here is the refusal's first.
    #[test]
    fn serve_connection_preauth_eof_without_flags_surfaces_serve_error() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;

        let client = thread::spawn(move || {
            let s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            // Park serve in the auth read first (the RST twin's shape), so
            // the FIN wakes the parked read itself.
            thread::sleep(Duration::from_millis(150));
            drop(s);
        });
        let err = serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false)))
            .expect_err("no flag set -> the flagless EOF stays the refusal");
        assert_eq!(
            err.kind(),
            io::ErrorKind::PermissionDenied,
            "the clean close without a line surfaces as the mismatch refusal"
        );
        client.join().expect("client thread panicked");
    }

    /// Issue #909 resumable pre-auth read: an auth line split across a
    /// SERVE_BEAT stall completes once the retry resumes the partial line
    /// (the stateless form discards the head, and the tail alone would be
    /// refused as a token mismatch).
    #[test]
    fn serve_connection_resumes_auth_line_split_across_timeout() {
        let ctx = fresh_ctx();
        let handle = bind_gateway().expect("bind");
        let port = handle.port;
        let token = handle.token.clone();

        let client = thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).expect("connect");
            let mut r = std::io::BufReader::new(s.try_clone().expect("clone"));
            let wire = format!("BRIDGE_AUTH {token}\n");
            let (head, tail) = wire.split_at(wire.len() / 2);
            s.write_all(head.as_bytes()).expect("auth head");
            thread::sleep(Duration::from_millis(300));
            s.write_all(tail.as_bytes()).expect("auth tail");
            let mut line = String::new();
            r.read_line(&mut line).expect("ok line");
            assert_eq!(line, "BRIDGE_OK\n", "the resumed line authenticated");
        });

        let outcome =
            serve_connection(handle, ctx, &Arc::new(AtomicBool::new(false))).expect("serve");
        client.join().expect("client thread panicked");
        assert!(
            outcome.trace.is_empty(),
            "auth-only exchange leaves no trace"
        );
    }

    // --- accept_bridge (connect deadline + cancel) -----------------------

    /// With no bridge connecting, accept_bridge returns `Err(TimedOut)` within
    /// ~deadline (not an infinite hang). Uses a short deadline so the test is
    /// fast; production uses [`CONNECT_DEADLINE`].
    #[tokio::test]
    async fn accept_bridge_times_out_when_no_bridge_connects() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let cancel = CancelToken::new();
        let start = Instant::now();
        let err = accept_bridge(
            listener,
            &cancel,
            &AtomicBool::new(false),
            Duration::from_millis(200),
        )
        .await
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
    #[tokio::test]
    async fn accept_bridge_returns_none_when_cancelled() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let cancel = CancelToken::new();
        cancel.request();
        let start = Instant::now();
        let result = accept_bridge(
            listener,
            &cancel,
            &AtomicBool::new(false),
            Duration::from_secs(30),
        )
        .await
        .expect("cancel is Ok(None), not Err");
        assert!(result.is_none(), "cancel before connect -> None");
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "cancel returns promptly: {:?}",
            start.elapsed()
        );
    }

    /// Issue #899: engine completion before any bridge connects returns
    /// `Ok(None)` promptly (no wait) instead of burning the connect deadline
    /// and surfacing a serve error -- the pump already returned, so the turn's
    /// outcome is decided by the ACP termination (single-source), never the
    /// gateway. Mirrors the pre-fired cancel arm one test up.
    #[tokio::test]
    async fn accept_bridge_returns_none_when_engine_done() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let cancel = CancelToken::new();
        let engine_done = AtomicBool::new(true);
        let start = Instant::now();
        let result = accept_bridge(listener, &cancel, &engine_done, Duration::from_secs(30))
            .await
            .expect("engine_done is Ok(None), not Err");
        assert!(result.is_none(), "engine_done before connect -> None");
        assert!(
            start.elapsed() < Duration::from_millis(100),
            "engine_done returns promptly: {:?}",
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

    // --- live emission (issue #1242) ----------------------------------------

    /// A leak-boxed recording phase sink: the live-emission pins overwrite
    /// `ctx.events` with one and read the phases back in arrival order.
    fn phase_recorder() -> &'static RecPhaseSink {
        Box::leak(Box::new(RecPhaseSink(std::sync::Mutex::new(Vec::new()))))
    }

    /// Issue #1242: the gateway emits the authoritative live pair itself --
    /// Started after the gate (with the real argument summary + badge), then
    /// the completed phase over the SAME trace entry the settle merge later
    /// pairs (one construction, two consumers).
    #[test]
    fn tools_call_emits_the_live_pair_on_the_allow_path() {
        let phases = phase_recorder();
        let mut ctx = fresh_ctx();
        ctx.events = phases;
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "explore", "arguments": {"sql": "SELECT 1 AS x"}}
        });
        handle_tools_call(&msg, &mut ctx, &mut outcome);
        let got = phases.0.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![
                TurnPhase::ToolCallStarted {
                    id: None,
                    name: "explore".into(),
                    operation_kind: OperationKind::Read,
                    summary: "SELECT 1 AS x".into(),
                    task: None,
                },
                TurnPhase::ToolCallCompleted(TraceEntryView::from(&outcome.trace[0])),
            ],
            "the pair is post-gate, carries the argument summary, and the \
             completed phase is the trace row itself"
        );
    }

    /// Issue #1242: a gate denial fires ONLY the completed phase (the
    /// built-in loop's dispatch-core contract): the pending card was the
    /// call's live face while it waited, and the resolved denial replaces
    /// it -- no started row ever exists.
    #[test]
    fn tools_call_denial_emits_only_the_completed_phase() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static AnsweringSink = Box::leak(Box::new(AnsweringSink::new(
            approval,
            ApprovalResponse::Deny,
        )));
        let phases = phase_recorder();
        let mut ctx = gate_ctx(vec![cli_fixture()], approval, sink);
        ctx.events = phases;
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
        handle_tools_call(&msg, &mut ctx, &mut outcome);
        let got = phases.0.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![TurnPhase::ToolCallCompleted(TraceEntryView::from(
                &outcome.trace[0]
            ))],
            "a denied call never started -- only its failed row surfaces live"
        );
        assert!(!outcome.trace[0].success);
    }

    /// Issue #1242: the gate-pending window is silent on the live rail --
    /// the approval card IS the call's pending face. The sink observes from
    /// inside the pending window: no phase may have fired when the card
    /// lands, and the pair only follows the allow.
    #[test]
    fn the_gate_pending_window_is_silent_on_the_live_rail() {
        struct PendingWindowSink<'a> {
            state: &'static ApprovalState,
            phases: &'a RecPhaseSink,
        }
        impl ApprovalSink for PendingWindowSink<'_> {
            fn emit_request(&self, body: &ApprovalRequestBody) {
                let fired = self.phases.0.lock().unwrap().len();
                assert_eq!(fired, 0, "the pending card is the call's only live face");
                let id: uuid::Uuid = body.request_id.parse().expect("request_id is a uuid");
                self.state
                    .respond(id, ApprovalResponse::AllowOnce)
                    .expect("respond");
            }
            fn emit_resolved(&self, _: &ApprovalRequestBody, _: ApprovalResponse) {}
        }
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let phases = phase_recorder();
        let sink: &'static PendingWindowSink<'static> = Box::leak(Box::new(PendingWindowSink {
            state: approval,
            phases,
        }));
        let mut ctx = gate_ctx(vec![cli_fixture()], approval, sink);
        ctx.events = phases;
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
        handle_tools_call(&msg, &mut ctx, &mut outcome);
        let got = phases.0.lock().unwrap().clone();
        assert_eq!(got.len(), 2, "the pair only follows the allow: {got:?}");
        assert_eq!(outcome.trace.len(), 1);
    }

    /// Issue #1242: the locally-served meta tools emit the standard pair too
    /// (mirroring the built-in path's `local_meta_call`), so a catalog call
    /// renders like any other call while it runs.
    #[test]
    fn tools_call_local_meta_emits_the_live_pair() {
        let phases = phase_recorder();
        let mut ctx = fresh_ctx();
        ctx.events = phases;
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "mcp_list_servers", "arguments": {}}
        });
        handle_tools_call(&msg, &mut ctx, &mut outcome);
        let got = phases.0.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![
                TurnPhase::ToolCallStarted {
                    id: None,
                    name: "mcp_list_servers".into(),
                    operation_kind: OperationKind::Read,
                    summary: meta_tools::LIST_SUMMARY.to_string(),
                    task: None,
                },
                TurnPhase::ToolCallCompleted(TraceEntryView::from(&outcome.trace[0])),
            ],
            "a locally-served call renders like any other call live"
        );
    }

    /// The bridge face's `invoke_skill` arm (ADR-0119 Decision 4, issue
    /// #983): the intercept maps the resolver's two variants exactly as
    /// the built-in arm does -- a served invocation is a success envelope
    /// carrying the body verbatim with one trace row under the tool name
    /// and the agent-actor record on the pending vec; a refused name is
    /// the bare isError envelope carrying the self-correcting snapshot
    /// listing, with NO trace row and nothing landed. The mapping is
    /// hand-duplicated from the built-in face, so this test is its only
    /// pin on the bridge.
    #[test]
    fn handle_tools_call_invoke_skill_serves_and_refuses_on_the_bridge_face() {
        let mut ctx = fresh_ctx();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("sql-coach");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: sql-coach\ndescription: Coach SQL.\n---\nCoach the SQL.\n",
        )
        .unwrap();
        let pending: &'static mut Vec<crate::model::SkillInvocation> =
            Box::leak(Box::new(Vec::new()));
        ctx.invocations = crate::skills::invocation::SkillInvocationCtx {
            pending,
            snapshot: Box::leak(vec!["sql-coach".to_string()].into_boxed_slice()),
            root: Box::leak(root.path().to_path_buf().into_boxed_path()),
            disabled: &[],
        };
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {"name": "invoke_skill", "arguments": {"name": "sql-coach"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false, "an invocation is a success");
                assert_eq!(
                    v["content"][0]["text"], "Coach the SQL.\n",
                    "the body rides the result verbatim"
                );
            }
            Response::Error(code, m) => {
                panic!("invoke_skill must return Result, got error {code}: {m}")
            }
            Response::None => panic!("invoke_skill must return Result, got None"),
        }
        assert_eq!(
            outcome.trace.len(),
            1,
            "one served invocation -> one trace row"
        );
        assert_eq!(outcome.trace[0].name, "invoke_skill");
        assert!(outcome.trace[0].success);
        assert_eq!(
            outcome.trace[0].summary, "sql-coach",
            "summary is the skill name"
        );
        assert_eq!(ctx.invocations.pending.len(), 1, "the agent record lands");
        assert_eq!(ctx.invocations.pending[0].name, "sql-coach");
        assert_eq!(
            ctx.invocations.pending[0].actor,
            crate::model::SkillLifecycleActor::Agent
        );

        let bad = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {"name": "invoke_skill", "arguments": {"name": "ghost"}}
        });
        match handle_tools_call(&bad, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true, "an unknown name is refused");
                let text = v["content"][0]["text"].as_str().unwrap_or_default();
                assert!(text.contains("ghost"), "{text}");
                assert!(
                    text.contains("sql-coach"),
                    "the refusal lists the snapshot names for self-correction: {text}"
                );
            }
            Response::Error(code, m) => {
                panic!("a refused invocation is still a Result, got error {code}: {m}")
            }
            Response::None => panic!("a refused invocation must return Result, got None"),
        }
        assert_eq!(
            outcome.trace.len(),
            1,
            "a refused invocation adds no trace row"
        );
        assert_eq!(
            ctx.invocations.pending.len(),
            1,
            "a refused invocation lands nothing"
        );
    }

    /// A spoofed bridge call for a built-in-only interception tool (ADR-0124:
    /// the bridge never lists `present_files`): the call falls through the
    /// face-gated interception, surfaces the unknown-external approval card,
    /// and once allowed dies at the executor's unknown-tool error -- the
    /// call's own failed trace row. The `CallFace` fall-through contract
    /// pinned on the wire (issue #1418).
    #[test]
    fn handle_tools_call_spoofed_present_files_dies_at_the_unknown_tool() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static AnsweringSink = Box::leak(Box::new(AnsweringSink::new(
            approval,
            ApprovalResponse::AllowOnce,
        )));
        let mut ctx = gate_ctx(Vec::new(), approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {"name": "present_files", "arguments": {"paths": ["a.txt"]}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true, "a spoofed call is an error result");
                let text = v["content"][0]["text"].as_str().unwrap_or_default();
                assert!(
                    text.contains("unknown tool"),
                    "the executor refuses it: {text}"
                );
                assert!(
                    text.contains("present_files"),
                    "the refusal names the tool: {text}"
                );
            }
            _ => panic!("the spoofed call must return a Result"),
        }
        assert_eq!(
            outcome.trace.len(),
            1,
            "the failed call keeps one honest row"
        );
        assert!(!outcome.trace[0].success, "the row records the failure");
        assert_eq!(
            sink.cards().len(),
            1,
            "the unknown-external card surfaced first"
        );
    }

    /// The workspace-tool twin of the spoof pin above (ADR-0137: the bridge
    /// never lists the gated write pair): the same fall-through death shape.
    #[test]
    fn handle_tools_call_spoofed_workspace_write_dies_at_the_unknown_tool() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static AnsweringSink = Box::leak(Box::new(AnsweringSink::new(
            approval,
            ApprovalResponse::AllowOnce,
        )));
        let mut ctx = gate_ctx(Vec::new(), approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {"name": "write", "arguments": {"path": "a.txt", "content": "x"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true, "a spoofed call is an error result");
                let text = v["content"][0]["text"].as_str().unwrap_or_default();
                assert!(
                    text.contains("unknown tool"),
                    "the executor refuses it: {text}"
                );
                assert!(text.contains("write"), "the refusal names the tool: {text}");
            }
            _ => panic!("the spoofed call must return a Result"),
        }
        assert_eq!(
            outcome.trace.len(),
            1,
            "the failed call keeps one honest row"
        );
        assert!(!outcome.trace[0].success, "the row records the failure");
    }

    /// A materialize call through the bridge lands its promotion on the
    /// outcome -- the rewritten Ok arm's push, pinned positively (every
    /// other `promotions` assertion in this file is an `is_empty`).
    #[test]
    fn handle_tools_call_lands_a_materialize_promotion_on_the_outcome() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static RecSink = Box::leak(Box::new(RecSink {
            requests: std::sync::Mutex::new(Vec::new()),
        }));
        let fake: &'static mut FakeMaterializer =
            Box::leak(Box::new(FakeMaterializer::new(vec![Ok(
                DatasetDescriptor {
                    reference_name: "result_1".into(),
                    display_name: "result_1".into(),
                    source_path: String::new(),
                    columns: Vec::new(),
                    row_count: 0,
                    sample: Vec::new(),
                    fingerprint: String::new(),
                    rectify: RectifyProvenance::NotApplicable,
                    privacy: DatasetPrivacy::default(),
                    stale: None,
                },
            )])));
        let mut ctx = gate_ctx_with_materializer(fake, Vec::new(), approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {"name": "materialize", "arguments": {"sql": "SELECT 1 AS x"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false, "the fake materialize succeeds: {v}");
            }
            _ => panic!("materialize must return a result"),
        }
        assert_eq!(
            outcome.promotions.len(),
            1,
            "the rewritten Ok arm lands the promotion on the outcome"
        );
    }

    /// The workspace write tools (issue #1406) and the read-only discovery
    /// trio (issue #1385) are built-in-runtime-only: external runtimes
    /// bring their own file tools with full authority, so the bridge face
    /// never advertises either channel however the conditionals mount, and
    /// a bare-name `tools/call` spoof has no landing (`analysis_tools::dispatch`
    /// answers with the unknown-tool error after the gate card, the
    /// present_files posture).
    #[test]
    fn tools_list_never_lists_the_workspace_tools() {
        for ctx in [fresh_ctx(), skill_ctx(vec!["sql-coach".to_string()])] {
            let mut ctx = ctx;
            match handle_method(
                "tools/list",
                &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
                &mut ctx,
                &mut GatewayOutcome::default(),
            ) {
                Response::Result(v) => {
                    let names: Vec<&str> = v["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|t| t["name"].as_str().unwrap())
                        .collect();
                    assert!(
                        !names.contains(&crate::session::workspace_tools::WRITE_TOOL)
                            && !names.contains(&crate::session::workspace_tools::EDIT_TOOL)
                            && !names
                                .contains(&crate::session::workspace_tools::discovery::GLOB_TOOL)
                            && !names
                                .contains(&crate::session::workspace_tools::discovery::GREP_TOOL)
                            && !names
                                .contains(&crate::session::workspace_tools::discovery::READ_TOOL),
                        "the bridge face never advertises the workspace tools"
                    );
                }
                _ => panic!("tools/list must return Result"),
            }
        }
    }

    /// ADR-0124 (issue #1087): `present_files` is the BUILT-IN runtime's
    /// injection (mounted in `ask_with_phase`'s table); the bridge face
    /// never lists it -- an external CLI has no injection point and no
    /// system-prompt clause, so its only channel is the reply-text scan.
    /// Structural pin: `tools/list` never carries the name however the
    /// conditionals mount, and a spoofed `tools/call` has no landing on
    /// the bridge face: the bare name classifies under the unknown-server
    /// external arm (the gate's pending card surfaces, as this module's
    /// routing doc notes), and only post-Allow routing reaches
    /// `analysis_tools::dispatch`, which answers with the unknown-tool error.
    #[test]
    fn tools_list_never_lists_present_files() {
        for ctx in [fresh_ctx(), skill_ctx(vec!["sql-coach".to_string()])] {
            let mut ctx = ctx;
            match handle_method(
                "tools/list",
                &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
                &mut ctx,
                &mut GatewayOutcome::default(),
            ) {
                Response::Result(v) => {
                    let names: Vec<&str> = v["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|t| t["name"].as_str().unwrap())
                        .collect();
                    assert!(
                        !names.contains(&"present_files"),
                        "the bridge face never advertises present_files"
                    );
                }
                _ => panic!("tools/list must return Result"),
            }
        }
    }

    /// The mount-conditional surface (ADR-0119 Decision 4, ADR-0105
    /// Decision 6): an EMPTY discovery snapshot lists no `invoke_skill`; a
    /// non-empty snapshot mounts it once, beside the trio's conditional
    /// attachment.
    #[test]
    fn tools_list_mounts_invoke_skill_only_with_a_nonempty_snapshot() {
        let mut ctx = fresh_ctx();
        match handle_method(
            "tools/list",
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            &mut ctx,
            &mut GatewayOutcome::default(),
        ) {
            Response::Result(v) => {
                let names: Vec<&str> = v["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["name"].as_str().unwrap())
                    .collect();
                assert!(
                    !names.contains(&"invoke_skill"),
                    "an empty discovery snapshot pays no standing tool cost"
                );
            }
            Response::Error(code, m) => {
                panic!("tools/list must return Result, got error {code}: {m}")
            }
            Response::None => panic!("tools/list must return Result, got None"),
        }

        let mut ctx = skill_ctx(vec!["sql-coach".to_string()]);
        match handle_method(
            "tools/list",
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            &mut ctx,
            &mut GatewayOutcome::default(),
        ) {
            Response::Result(v) => {
                let names: Vec<&str> = v["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["name"].as_str().unwrap())
                    .collect();
                assert!(
                    names.contains(&"invoke_skill"),
                    "a non-empty discovery snapshot mounts the invocation channel"
                );
            }
            Response::Error(code, m) => {
                panic!("tools/list must return Result, got error {code}: {m}")
            }
            Response::None => panic!("tools/list must return Result, got None"),
        }
    }

    /// A leaked read gate over a real temp registry: the shared fixture for
    /// the read-surface tests (issue #714). `tmp` must outlive the ctx.
    fn leaked_read_gate(tmp: &tempfile::TempDir) -> crate::skills::read::SkillReadGate<'static> {
        let dir = tmp.path().join("sql-coach");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(dir.join("references/notes.md"), b"Use CTEs.\n").unwrap();
        std::fs::write(dir.join("SKILL.md"), "---\nname: sql-coach\n---\nBody.\n").unwrap();
        crate::skills::read::SkillReadGate {
            invoked: Box::leak(vec!["sql-coach".to_string()].into_boxed_slice()),
            disabled: &[],
            root: Box::leak(tmp.path().to_path_buf().into_boxed_path()),
        }
    }

    /// The create surface's mount condition (ADR-0122 Decision 1): a
    /// live-config handle mounts the tool (the mint needs the config
    /// write); a config-less gate never advertises it.
    #[test]
    fn tools_list_mounts_create_skill_only_with_a_live_config() {
        let mut ctx = fresh_ctx();
        match handle_method(
            "tools/list",
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            &mut ctx,
            &mut GatewayOutcome::default(),
        ) {
            Response::Result(v) => {
                let names: Vec<&str> = v["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["name"].as_str().unwrap())
                    .collect();
                assert!(
                    !names.contains(&"create_skill"),
                    "an inert (config-less) gate never advertises the channel"
                );
            }
            Response::Error(code, m) => {
                panic!("tools/list must return Result, got error {code}: {m}")
            }
            Response::None => panic!("tools/list must return Result, got None"),
        }

        let tmp: &'static tempfile::TempDir = Box::leak(Box::new(tempfile::tempdir().unwrap()));
        let live: &'static crate::LiveProviderConfig =
            Box::leak(Box::new(crate::LiveProviderConfig::new(
                crate::provider::keychain::KeychainStore,
                tmp.path().join("config.json"),
            )));
        ctx.create = crate::skills::create::SkillCreateGate {
            root: tmp.path(),
            live: Some(live),
        };
        match handle_method(
            "tools/list",
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            &mut ctx,
            &mut GatewayOutcome::default(),
        ) {
            Response::Result(v) => {
                let names: Vec<&str> = v["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["name"].as_str().unwrap())
                    .collect();
                assert!(
                    names.contains(&"create_skill"),
                    "a live-config gate mounts the creation channel"
                );
            }
            Response::Error(code, m) => {
                panic!("tools/list must return Result, got error {code}: {m}")
            }
            Response::None => panic!("tools/list must return Result, got None"),
        }
    }

    /// The read surface's mount condition (issue #1260, ADR-0111 Decision 1
    /// calibrated by ADR-0119 Decision 4): mounted iff the turn's discovery
    /// snapshot is non-empty -- the SAME gate as `invoke_skill`, so a
    /// mid-turn invocation's references need no next-turn mount. A session
    /// with no skills pays no standing read cost; an empty turn-start
    /// INVOKED set still mounts -- the pre-#1260 invoked gate left the
    /// invoked body's reference channel a dead pointer in its own turn.
    #[test]
    fn tools_list_mounts_read_skill_file_only_with_a_nonempty_snapshot() {
        // An empty discovery snapshot pays no standing read cost.
        let mut ctx = fresh_ctx();
        match handle_method(
            "tools/list",
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            &mut ctx,
            &mut GatewayOutcome::default(),
        ) {
            Response::Result(v) => {
                let names: Vec<&str> = v["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["name"].as_str().unwrap())
                    .collect();
                assert!(
                    !names.contains(&"read_skill_file"),
                    "a session with no skills pays no standing read cost"
                );
            }
            Response::Error(code, m) => {
                panic!("tools/list must return Result, got error {code}: {m}")
            }
            Response::None => panic!("tools/list must return Result, got None"),
        }

        // A non-empty snapshot mounts the read surface with NOTHING invoked
        // yet (the snapshot gate, not the invoked gate).
        let mut ctx = skill_ctx(vec!["sql-coach".to_string()]);
        let tmp = tempfile::tempdir().unwrap();
        ctx.read = crate::skills::read::SkillReadGate {
            invoked: &[],
            disabled: &[],
            root: Box::leak(tmp.path().to_path_buf().into_boxed_path()),
        };
        match handle_method(
            "tools/list",
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            &mut ctx,
            &mut GatewayOutcome::default(),
        ) {
            Response::Result(v) => {
                let names: Vec<&str> = v["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|t| t["name"].as_str().unwrap())
                    .collect();
                assert!(
                    names.contains(&"read_skill_file"),
                    "a non-empty snapshot mounts the read surface with nothing invoked yet"
                );
            }
            Response::Error(code, m) => {
                panic!("tools/list must return Result, got error {code}: {m}")
            }
            Response::None => panic!("tools/list must return Result, got None"),
        }
    }

    /// The bridge face's same-turn closed loop (issue #1260): the mid-turn
    /// `invoke_skill` lands the agent record on the turn's pending
    /// invocations, and the read interception unions the pending names with
    /// the turn-start snapshot -- the invoked body's reference files are
    /// readable in the INVOKING turn. The turn-start set stays empty here;
    /// the pre-#1260 resolver refused this read as not-invoked.
    #[test]
    fn handle_tools_call_read_skill_file_serves_a_mid_turn_invocation() {
        let mut ctx = fresh_ctx();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("sql-coach");
        std::fs::create_dir_all(dir.join("references")).unwrap();
        std::fs::write(dir.join("references/template.html"), "Report scaffold.\n").unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            "---\nname: sql-coach\ndescription: Coach SQL.\n---\nCoach the SQL.\n",
        )
        .unwrap();
        let pending: &'static mut Vec<crate::model::SkillInvocation> =
            Box::leak(Box::new(Vec::new()));
        ctx.invocations = crate::skills::invocation::SkillInvocationCtx {
            pending,
            snapshot: Box::leak(vec!["sql-coach".to_string()].into_boxed_slice()),
            root: Box::leak(root.path().to_path_buf().into_boxed_path()),
            disabled: &[],
        };
        // The turn-start invoked set is EMPTY -- the only eligibility
        // source is the pending record the invoke below lands.
        ctx.read = crate::skills::read::SkillReadGate {
            invoked: &[],
            disabled: &[],
            root: Box::leak(root.path().to_path_buf().into_boxed_path()),
        };
        let mut outcome = GatewayOutcome::default();
        // 1) The agent invokes the skill mid-turn.
        let invoke = json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {"name": "invoke_skill", "arguments": {"name": "sql-coach"}}
        });
        match handle_tools_call(&invoke, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false, "an invocation is a success");
            }
            Response::Error(code, m) => {
                panic!("invoke_skill must return Result, got error {code}: {m}")
            }
            Response::None => panic!("invoke_skill must return Result, got None"),
        }
        // 2) The SAME turn's read serves the invoked body's reference.
        let read = json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "tools/call",
            "params": {"name": "read_skill_file", "arguments": {
                "name": "sql-coach", "path": "references/template.html"
            }}
        });
        match handle_tools_call(&read, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(
                    v["isError"], false,
                    "the mid-turn invocation reads in its own turn"
                );
                assert_eq!(
                    v["content"][0]["text"], "Report scaffold.\n",
                    "the file text rides the result verbatim"
                );
            }
            Response::Error(code, m) => {
                panic!("read_skill_file must return Result, got error {code}: {m}")
            }
            Response::None => panic!("read_skill_file must return Result, got None"),
        }
        // 3) A name never invoked is still refused, and the refusal lists
        //    the LIVE set -- the pending name rides the listing.
        let ghost = json!({
            "jsonrpc": "2.0",
            "id": 23,
            "method": "tools/call",
            "params": {"name": "read_skill_file", "arguments": {
                "name": "ghost", "path": "SKILL.md"
            }}
        });
        match handle_tools_call(&ghost, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true, "a never-invoked name stays refused");
                let text = v["content"][0]["text"].as_str().unwrap_or_default();
                assert!(text.contains("ghost"), "{text}");
                assert!(
                    text.contains("sql-coach"),
                    "the refusal lists the live invoked set (the pending name): {text}"
                );
            }
            Response::Error(code, m) => {
                panic!("a refused read is still a Result, got error {code}: {m}")
            }
            Response::None => panic!("a refused read must return Result, got None"),
        }
        // The invoke + the served read each left one trace row; the refused
        // read is traceless.
        assert_eq!(outcome.trace.len(), 2, "one invoke + one read -> two rows");
        assert_eq!(outcome.trace[0].name, "invoke_skill");
        assert_eq!(outcome.trace[1].name, "read_skill_file");
        assert!(outcome.trace[1].success);
    }

    /// The bridge face's `read_skill_file` Refused arm (issue #714): a bad
    /// path is the bare isError envelope carrying the listing, with NO trace
    /// row -- the resolution-failure posture, mirrored from the skill arm.
    #[test]
    fn handle_tools_call_read_skill_file_refused_is_traceless() {
        let mut ctx = fresh_ctx();
        let tmp = tempfile::tempdir().unwrap();
        ctx.read = leaked_read_gate(&tmp);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {"name": "read_skill_file", "arguments": {
                "name": "sql-coach", "path": "references/missing.md"
            }}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true, "a missing path is refused");
                let text = v["content"][0]["text"].as_str().unwrap_or_default();
                assert!(text.contains("Readable files"), "{text}");
                assert!(
                    text.contains("references/notes.md"),
                    "the refusal lists the real readable set: {text}"
                );
            }
            Response::Error(code, m) => {
                panic!("a refused read is still a Result, got error {code}: {m}")
            }
            Response::None => panic!("a refused read must return Result, got None"),
        }
        assert!(
            outcome.trace.is_empty(),
            "a refused read records no trace row"
        );
    }

    /// Issue #321 on the gateway face: a builtin dispatch that registers
    /// `result_N` then panics rolls the ghost back via the shared
    /// `guarded_dispatch` ritual this arm picked up (issue #696) and
    /// surfaces as the call's error result -- not an unwind into the server
    /// task -- with one failed trace row naming the site.
    #[test]
    fn handle_tools_call_panic_mid_dispatch_rolls_back_ghost_result() {
        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static NoopSink = Box::leak(Box::new(NoopSink));
        let ghost: &'static mut GhostThenPanicMaterializer =
            Box::leak(Box::new(GhostThenPanicMaterializer));
        let mut ctx = gate_ctx_with_materializer(ghost, Vec::new(), approval, sink);
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "materialize", "arguments": {"sql": "SELECT 1 AS x"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], true, "a panicked dispatch is an error result");
                let text = v["content"][0]["text"].as_str().unwrap_or_default();
                assert!(
                    text.contains("panicked in tool dispatch"),
                    "detail names the panic site: {text}"
                );
            }
            Response::Error(code, m) => {
                panic!("panic path returns Result, got error {code}: {m}")
            }
            Response::None => panic!("panic path returns Result, got None"),
        }
        assert_eq!(
            outcome.trace.len(),
            1,
            "one trace row for the panicked call"
        );
        assert!(
            !outcome.trace[0].success,
            "the trace row records the failure"
        );
        assert!(
            !ctx.deps.working_set.is_result("result_1"),
            "ghost result_1 unregistered from the working set"
        );
        assert_eq!(
            ctx.deps.working_set.next_result_number(),
            1,
            "next_result_number back to 1 after the rollback"
        );
    }

    /// The dispatch freeze (ADR-0115): a tools/call whose dispatch runs past
    /// the turn's no-progress cap must NOT fire the turn's clock -- the
    /// serve-side freeze covers the whole gate + dispatch window, so the
    /// watchdog stands down (the ADR-0081 mis-kill shape -- a >120s tool
    /// execution killing the ACP turn -- is observable only by its absence).
    /// Without the freeze the armed clock fires ~200ms into the 600ms
    /// dispatch and the token carries the request.
    #[test]
    fn tools_call_running_past_the_cap_does_not_fire_the_clock() {
        use crate::session::progress::ProgressClock;

        let approval: &'static ApprovalState = Box::leak(Box::new(ApprovalState::new()));
        let sink: &'static NoopSink = Box::leak(Box::new(NoopSink));
        let sleepy: &'static mut SleepyMaterializer =
            Box::leak(Box::new(SleepyMaterializer { ms: 600 }));
        let mut ctx = gate_ctx_with_materializer(sleepy, Vec::new(), approval, sink);
        // The serve must read the very token this test armed: alias the ctx's
        // cancel to the Arc twin the clock publishes on (the same slot the
        // production paths share, ADR-0115).
        let token = Arc::new(CancelToken::new());
        ctx.cancel = Arc::clone(&token);
        let guard = token.begin_turn();
        ProgressClock::arm_and_publish(guard.generation(), &token, Duration::from_millis(200));
        let _guard = guard; // hold the generation alive for the serve

        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": "materialize", "arguments": {"sql": "SELECT 1 AS x"}}
        });
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false, "the dispatch completes normally");
            }
            Response::Error(code, m) => {
                panic!("the frozen dispatch must complete, got error {code}: {m}")
            }
            Response::None => panic!("the frozen dispatch must complete, got None"),
        }
        assert!(
            !token.is_requested(),
            "the frozen dispatch must not fire the cap"
        );
        assert_eq!(outcome.trace.len(), 1, "the trace row lands");
        assert!(outcome.trace[0].success, "the row records success");
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

    /// The post-race seam: occupies the mint target when the card surfaces,
    /// then allows -- the approved write meets a taken name exactly as the
    /// gate-pending same-name race produces.
    struct OccupyingSink {
        state: &'static ApprovalState,
        occupy: std::path::PathBuf,
    }

    impl ApprovalSink for OccupyingSink {
        fn emit_request(&self, body: &ApprovalRequestBody) {
            std::fs::create_dir_all(&self.occupy).expect("occupy the name mid-window");
            let id: uuid::Uuid = body.request_id.parse().expect("request_id is a uuid");
            self.state
                .respond(id, ApprovalResponse::AllowOnce)
                .expect("respond");
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

    // --- wire-level pins over a live server (issue #661) -------------------

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

    /// The over-cap spill wiring pin (issue #1218): the unit family hands
    /// in pre-stripped stems, so nothing else guards the wiring layer.
    /// This drives the full invoke chain with a cap-crossing result and
    /// pins all three wiring facts at once -- the spill stem strips the
    /// `mcp__` prefix (`<slug>__<tool>-<call-id>`, the CLI channel's
    /// naming family), the file lands under the ctx's own temp root, and
    /// the preview the model sees carries the marker + path while the
    /// file holds the full bytes.
    #[test]
    fn handle_tools_call_invoke_over_cap_spills_with_the_stripped_stem() {
        let server = LiveMcpServer::spawn();
        let mut ctx = live_ctx(&server);
        ctx.approval
            .seed_trust(&ToolKey::external("livemcp", "mcp__livemcp__big"));
        let mut outcome = GatewayOutcome::default();
        let msg = json!({
            "jsonrpc": "2.0", "id": 43, "method": "tools/call",
            "params": {"name": "mcp_invoke",
                       "arguments": {"tool": "mcp__livemcp__big", "arguments": {}}}
        });
        let temp_root = ctx.deps.temp_path.to_path_buf();
        match handle_tools_call(&msg, &mut ctx, &mut outcome) {
            Response::Result(v) => {
                assert_eq!(v["isError"], false);
                let preview = v["content"][0]["text"].as_str().unwrap();
                assert!(
                    preview.contains("spilled to:"),
                    "the model gets the spill pointer: {}...",
                    &preview[..64]
                );
                assert!(
                    preview.starts_with('x'),
                    "the preview opens with the capped head"
                );
            }
            _ => panic!("over-cap invoke must still return Result"),
        }
        let dir = temp_root.join("tool_output");
        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("spill dir {dir:?}: {e}"))
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(entries.len(), 1, "one spill file for one over-cap call");
        let name = entries[0].file_name().into_string().unwrap();
        assert!(
            name.starts_with("livemcp__big-"),
            "stem strips the mcp__ prefix: {name}"
        );
        assert!(
            !name.starts_with("mcp__"),
            "the wire handle never reaches the filename: {name}"
        );
        assert!(
            name.ends_with(".csv"),
            "the sniff routes plain text: {name}"
        );
        let spilled = std::fs::read(dir.join(&name)).expect("the spill file is readable whole");
        assert_eq!(
            spilled.len(),
            crate::cli_tools::executor::OUTPUT_CAP_BYTES + 1,
            "the full bytes landed, not a truncation"
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
