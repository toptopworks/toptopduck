//! The adapter diagnostic probe kernel (ADR-0096, issues #534/#535).
//!
//! A session-agnostic, read-only verification channel, deliberately decoupled
//! from the turn path ([`super::engine`]): one-shot spawn of the detected
//! CLI binary in protocol mode -> ACP `initialize` + `session/new`
//! handshake -> [`DiscoveredRuntime`] extract from the response's
//! `config_options` (the SAME ADR-0095 extraction the turn handshake uses)
//! -> terminate the process. The probe never drives a turn, holds no session
//! lock, and produces no upstream session state.
//!
//! This module owns the blocking handshake and the probe's spawn surface
//! (argv selection + error wording; the stdio spawn shape itself lives in
//! [`super::process::spawn_piped`]): [`spawn_child`]
//! hands the spawned child + its stdio to the caller (the Child handle must
//! stay OUT of any `spawn_blocking` closure -- blocking tasks are not
//! cancellable, so this is the only way to guarantee a hung CLI is reaped
//! after the timeout), while [`handshake_with`] runs the deadline-bounded
//! blocking handshake (the `probe_mcp_server` layering, issue #392). Every
//! caller -- the IPC shell and the tests alike -- composes the same three
//! steps: spawn -> handshake -> kill.
//!
//! Every stream format is probeable (ADR-0096 D2, ADR-0097 Decision 5): ACP
//! adapters run the initialize + `session/new` handshake here;
//! `CodexEventStream` adapters (codex) dispatch to [`super::app_server`]'s
//! `model/list` query; `ClaudeStreamJson` adapters (claude-code) dispatch to
//! [`super::claude_control`]'s `control_request{initialize}` catalog read --
//! the same spawn -> query -> kill lifecycle each, a different wire surface.

use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::runtime::acp::adapter::{AdapterSpec, DiscoveredRuntime, StreamFormat};
use crate::runtime::acp::wire::{
    self, InitializeParams, NewSessionParams, NewSessionResult, Request, RequestId, Response,
};

/// The probe's wall-clock ceiling (ADR-0096, implementation-time calibration):
/// generous for the slowest real cold start (node CLIs take seconds to tens
/// of seconds) while still bounding a hung CLI. Tests inject a short
/// deadline instead -- this constant is the production default only.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// A successful probe (ADR-0096 D2/D3, ADR-0097). Per-format tagged: the ACP
/// handshake produces the flat [`DiscoveredRuntime`] (issue #534); the
/// per-model catalog formats produce a [`ModelCatalogOutcome`] (issue #535)
/// -- the latter never flattened into `DiscoveredRuntime` (a union of
/// per-model efforts would let the user select an effort the current model
/// does not support, ADR-0096 D3). The session id is not carried: the probe
/// mints no usable session (the process is killed right after the query).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ProbeOk {
    /// The ACP handshake catalog, stamped with the producing adapter (issue
    /// #529 semantics -- the config_options wire carries no adapter identity).
    Acp { discovered: DiscoveredRuntime },
    /// The CodexEventStream per-model catalog, or the honest degraded
    /// "started but catalog unavailable" state (ADR-0096 D2 -- an old CLI /
    /// not logged in / RPC error degrades; only a spawn failure, a timeout,
    /// or the process dying mid-query fails outright). The catalog's supplier
    /// is the codex app-server wire ([`super::app_server`]) -- a PRIVATE
    /// protocol, not a reusable stream-format surface: every format brings
    /// its own wire definition, never inherits another's (issue #544).
    CodexEventStream { outcome: ModelCatalogOutcome },
    /// The ClaudeStreamJson per-model catalog, read off the stream-json
    /// control plane's `initialize` response (ADR-0097 Decision 5). Same
    /// degrade footing as the codex variant: an error control response
    /// degrades to `Unavailable`; a silent / EOF-ing child degrades to an
    /// EMPTY catalog (`Available` with no models -- the no-response shape,
    /// ADR-0097 Decision 5 "无响应降级空目录"); only a spawn failure, a
    /// timeout, or a write fault fails outright.
    ClaudeStreamJson { outcome: ModelCatalogOutcome },
}

/// The per-model catalog outcome of a non-ACP probe (ADR-0096 D2/D3: the
/// codex app-server `model/list` query; ADR-0097 Decision 5: the claude-code
/// control-plane `initialize` read). `Available` carries the ordered
/// per-model catalog; `Unavailable` is the degraded state (the process
/// started but the catalog was not obtainable -- RPC / control error /
/// unparseable result; the process being alive is itself diagnostic signal,
/// so this is a success variant, not an error).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ModelCatalogOutcome {
    Available { models: Vec<CatalogModel> },
    Unavailable { detail: String },
}

/// One model from a per-model catalog probe (ADR-0096 D3; ADR-0097 Decision
/// 5 reuses the shape for claude-code). The reasoning efforts are the
/// per-model list (`supportedReasoningEfforts` on the codex wire,
/// `supportedEffortLevels` on the claude wire) in the CLI's declared order
/// (never a union across models); `default_reasoning_effort` marks the
/// model's own default (empty when the wire names none); `is_default` marks
/// the catalog's default model. Deserialize rides along (not a wire-in
/// shape, but the catalog cache sidecar round-trips the same type, ADR-0096
/// D5 / issue #536).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CatalogModel {
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<String>,
}

/// A probe refusal or failure (issue #534). Adjacently-tagged
/// (`#[serde(tag = "kind", content = "data")]`) like [`SessionError`] and
/// `StoreCommandError`, with a top-level `kind` set disjoint from every other
/// typed IPC error, so the frontend's kind dispatch is unambiguous. The two
/// failure variants carry the English technical detail for the fold;
/// user-facing wording lives in the locale catalog, not these strings.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum ProbeError {
    /// The adapter is not currently detected (fresh PATH scan) or the id is
    /// unknown. Carries the adapter id.
    #[error("adapter not detected: {0}")]
    NotDetected(String),
    /// Spawning the CLI binary failed (vanished binary, permission, ...).
    /// Carries the English technical detail.
    #[error("{0}")]
    SpawnFailure(String),
    /// The probe's protocol exchange failed -- an ACP handshake error, an
    /// app-server query error (the CLI crashed mid-query / spoke a foreign
    /// protocol), or the probe task itself failed (write error / task
    /// panic). Carries the English technical detail.
    #[error("{0}")]
    HandshakeFailure(String),
    /// The wall-clock deadline elapsed before the handshake completed.
    #[error("probe timed out")]
    Timeout,
}

/// The single spawn point every probe lifecycle goes through: spawns `binary`
/// with the adapter's probe argv prefix (ADR-0096 D2 -- the turn argv on ACP,
/// the `app-server` subcommand on codex, the turn argv + `--input-format
/// stream-json` on claude-code, all carried as data on the spec so the
/// kernel names no CLI) and piped stdio. A fresh PATH scan returning `None`
/// refuses with [`ProbeError::NotDetected`] before any spawn is attempted.
/// The caller dispatches the per-format query on the returned child's stdio.
/// Contract (issue #542): stderr is spawned PIPED and is drained ONLY by
/// [`ChildHandle::take_pipes`]'s stderr tail reader thread -- every caller
/// must take the pipes (all three streams, one call) for every child it
/// spawned, including early-failure paths after a successful spawn; an
/// untaken piped stderr is never read, so a chatty child can block on a
/// full OS pipe buffer and wedge until killed.
pub fn spawn_child(spec: &AdapterSpec, binary: Option<&Path>) -> Result<ChildHandle, ProbeError> {
    let binary = binary.ok_or_else(|| ProbeError::NotDetected(spec.id.to_string()))?;
    // probe_argv/stream_format invariant (issue #544, extended by ADR-0097):
    // every NON-ACP adapter MUST carry a dedicated probe argv (its probe
    // surface differs from the turn's protocol mode), an ACP adapter MUST
    // NOT (the probe reuses the turn argv). Enforced at this single
    // consumption point so a future spec that breaks the pairing fails fast
    // under test instead of spawning the turn's argv and speaking the wrong
    // protocol.
    debug_assert_eq!(
        spec.stream_format != StreamFormat::Acp,
        spec.probe_argv.is_some()
    );
    // Piped stderr (issue #542): the CLI's diagnostics (auth failure, startup
    // panic, version skew) land in the probe's failure detail instead of
    // vanishing into the packaged app's absent console. The turn engine's
    // spawn keeps stderr inherited.
    super::process::spawn_piped(
        binary,
        spec.probe_argv.unwrap_or(spec.argv),
        std::process::Stdio::piped(),
    )
    .map(|inner| ChildHandle { inner })
    .map_err(|e| ProbeError::SpawnFailure(format!("failed to spawn CLI `{}`: {e}", spec.id)))
}

/// The spawned CLI child. [`Self::kill_and_wait`] delegates to
/// [`super::process::kill_and_reap`] -- the same shared kill-reap logic the
/// turn engines use (prevents drift).
#[derive(Debug)]
pub struct ChildHandle {
    inner: Child,
}

impl ChildHandle {
    /// Take ALL piped streams in one call: the stdio pair for the handshake
    /// plus the stderr tail capture (issue #542). The spawn pipes all three
    /// ends, so a single take is the only valid lifetime. A single tuple
    /// return makes a missing tail compiler-visible (issue #543): an untaken
    /// element is an unused binding / dead code, not the silent doc-contract
    /// it was when stdio and stderr were taken by separate methods.
    pub fn take_pipes(&mut self) -> (ChildStdin, ChildStdout, StderrTail) {
        // Infallible by construction (issue #543): the handle is created only
        // by [`spawn_child`], whose `spawn_piped` pipes stdin/stdout/stderr,
        // and no other site can take them -- stderr is spawned piped solely
        // for the tail reader, the only consumer of this method.
        let stdout = self.inner.stdout.take().expect("spawn_piped pipes stdout");
        let stdin = self.inner.stdin.take().expect("spawn_piped pipes stdin");
        let stderr = self.inner.stderr.take().expect("spawn_piped pipes stderr");
        (stdin, stdout, StderrTail::spawn(stderr))
    }

    pub fn kill_and_wait(&mut self) {
        super::process::kill_and_reap(&mut self.inner);
    }
}

/// The deadline-bounded blocking handshake (initialize + `session/new`) on
/// an already-spawned child's stdio: run it, extract the catalog, return
/// (the `stdio_handshake` half of the `probe_mcp_server` layering, issue
/// #392). This function performs only the blocking I/O; process management
/// stays with the caller, who must [`ChildHandle::kill_and_wait`] on every
/// exit path (a probe child never outlives the probe, ADR-0096 watchdog
/// alignment).
pub fn handshake_with(
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr_tail: StderrTail,
    spec: &AdapterSpec,
    timeout: Duration,
) -> Result<DiscoveredRuntime, ProbeError> {
    let mut io = ProbeIo::new(stdin, stdout);
    let deadline = Instant::now() + timeout;
    handshake(&mut io, spec, deadline).map_err(|e| attach_stderr_tail(e, &stderr_tail))
}

/// Unwrap a round-trip response: Some(result) passes through; a JSON-RPC
/// error or an empty response names the failing step in the handshake
/// failure detail.
fn require_result<T>(step: &str, resp: Response<T>) -> Result<T, ProbeError> {
    match (resp.result, resp.error) {
        (Some(r), _) => Ok(r),
        (None, Some(e)) => Err(ProbeError::HandshakeFailure(format!(
            "{step} error: {}",
            e.message
        ))),
        (None, None) => Err(ProbeError::HandshakeFailure(format!(
            "{step}: empty response"
        ))),
    }
}

/// The handshake: initialize -> session/new, deadline-bounded at the line
/// level (each read waits only until the wall-clock deadline; a silent CLI
/// surfaces as [`ProbeError::Timeout`], never a hang). The minimal shape of
/// the engine's handshake: no bridge descriptor, no selection injection --
/// the probe reads, it never configures.
fn handshake(
    io: &mut ProbeIo,
    adapter: &AdapterSpec,
    deadline: Instant,
) -> Result<DiscoveredRuntime, ProbeError> {
    let init = io.request_roundtrip::<InitializeParams, wire::InitializeResult>(
        Request::new(
            RequestId::Num(1),
            "initialize",
            InitializeParams {
                protocol_version: wire::PROTOCOL_VERSION,
                client_info: wire::Implementation::client(),
            },
        ),
        deadline,
    )?;
    require_result("initialize", init)?;
    let new_resp = io.request_roundtrip::<NewSessionParams, NewSessionResult>(
        Request::new(
            RequestId::Num(2),
            "session/new",
            NewSessionParams {
                // The probe has no session context; the CLI only requires a
                // usable cwd, and the temp dir is one on every platform.
                cwd: std::env::temp_dir().to_string_lossy().to_string(),
                mcp_servers: Vec::new(),
            },
        ),
        deadline,
    )?;
    let r = require_result("session/new", new_resp)?;
    // Issue #529 semantics: stamp the producing adapter onto the catalog
    // (the config_options wire carries no adapter identity).
    let mut discovered =
        crate::runtime::acp::adapter::extract_discovered_runtime(r.config_options.as_ref());
    discovered.adapter_id = Some(adapter.id.to_string());
    Ok(discovered)
}

// ---------------------------------------------------------------------------
// NDJSON stdio I/O
// ---------------------------------------------------------------------------

/// The probe's thin wrapper over the shared [`super::ndjson::NdjsonIo`]:
/// deadline-driven (the kernel's minimal counterpart of the engine's
/// cancel-driven pump -- here the only abort condition is the wall clock)
/// and mapped onto [`ProbeError`].
struct ProbeIo {
    inner: super::ndjson::NdjsonIo,
}

impl ProbeIo {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            inner: super::ndjson::NdjsonIo::new(stdin, stdout),
        }
    }

    /// Send a request and pump incoming lines until its response arrives or
    /// the deadline passes. Stray lines are dropped by the shared loop (see
    /// [`super::ndjson::NdjsonIo::request_roundtrip_deadline`]).
    fn request_roundtrip<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &mut self,
        req: Request<P>,
        deadline: Instant,
    ) -> Result<Response<R>, ProbeError> {
        let target = serde_json::to_value(&req.id).unwrap_or(serde_json::Value::Null);
        self.inner
            .request_roundtrip_deadline(&req, &target, deadline)
            .map_err(|e| map_roundtrip_error(e, "ACP agent"))
    }
}

/// Map the shared round-trip failure onto the probe's error type. `who` names
/// the child in the EOF detail (the ACP handshake and the app-server query
/// word it differently). Shared with [`super::app_server`]'s deadline-driven
/// query. Exhaustive over the deadline-driven error type -- the cancel-driven
/// abort kind is not representable here (issue #543).
pub(super) fn map_roundtrip_error(
    e: super::ndjson::RoundtripError<super::ndjson::TimedOut>,
    who: &str,
) -> ProbeError {
    use super::ndjson::RoundtripError;
    match e {
        RoundtripError::Abort(_) => ProbeError::Timeout,
        RoundtripError::Serialize(detail) => {
            ProbeError::HandshakeFailure(format!("serialize: {detail}"))
        }
        RoundtripError::Write(detail) => ProbeError::HandshakeFailure(format!("write: {detail}")),
        RoundtripError::Eof => ProbeError::HandshakeFailure(format!("{who} closed stdout")),
        RoundtripError::Parse(detail) => {
            ProbeError::HandshakeFailure(format!("response parse: {detail}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Stderr tail capture (issue #542)
// ---------------------------------------------------------------------------

/// Tail capacity: the last 4 KiB of stderr is ample for a CLI's final
/// diagnosis (auth failure, panic, version-skew error) while bounding both
/// the ring's memory and the failure detail's length.
const STDERR_TAIL_CAP: usize = 4 * 1024;

/// Upper bound on waiting for the reader thread to finish before a failure
/// snapshot. After the child's stderr EOF, draining the pipe is a scheduling
/// delay (microseconds to milliseconds), not a data-volume problem -- 250ms
/// covers a loaded CI machine. A still-alive child (the RPC-error-that-does-
/// not-exit case) burns the full window and the snapshot degrades to what has
/// landed so far; strictly no worse than not waiting.
const STDERR_TAIL_JOIN_TIMEOUT: Duration = Duration::from_millis(250);

/// A bounded ring holding the tail of a byte stream: pushes append, and once
/// [`STDERR_TAIL_CAP`] is exceeded the OLDEST bytes are dropped (a chatty CLI
/// keeps only its final words, never unbounded memory). The capture is
/// line-oriented on top: [`Self::snapshot`] trims trailing whitespace, and a
/// torn head (a ring drop splitting a line) is cut forward to the next line
/// boundary. One exception: when the retained window contains no line break
/// at all (a single line longer than the cap), the cut has nowhere to land
/// and the snapshot starts mid-line, possibly with a leading lossy-replacement
/// rune -- a degraded but non-empty diagnosis beats an empty one.
#[derive(Debug, Default)]
struct TailBuf {
    buf: Vec<u8>,
    /// Whether a ring drop has torn the buffer's head line (the snapshot then
    /// cuts to the next line boundary instead of starting mid-word).
    torn: bool,
}

impl TailBuf {
    /// Append raw bytes, dropping the oldest past [`STDERR_TAIL_CAP`]. The
    /// bytes need not be valid UTF-8: the ring is byte-oriented and only the
    /// [`Self::snapshot`] side applies lossy conversion -- a CLI emitting a
    /// legacy codepage (or binary noise) degrades per-rune, never truncating
    /// the whole capture.
    fn push_bytes(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
        let excess = self.buf.len().saturating_sub(STDERR_TAIL_CAP);
        if excess > 0 {
            self.buf.drain(..excess);
            // The drop makes the buffer's head a torn line remainder; the
            // snapshot must know to cut at the next line boundary.
            self.torn = true;
        }
    }

    /// The retained tail, trimmed to line boundaries. Empty when nothing was
    /// captured (the failure detail then appends nothing).
    fn snapshot(&self) -> String {
        let s = String::from_utf8_lossy(&self.buf);
        let s = s.trim_end();
        if !self.torn {
            return s.to_string();
        }
        // A torn head is a dropped-line remainder -- cut at the first line
        // break so the snapshot starts at a real line.
        match s.find('\n') {
            Some(i) => s[i + 1..].trim_start().to_string(),
            None => s.to_string(),
        }
    }
}

/// The probe's stderr capture: a reader thread continuously draining the
/// child's stderr pipe into a shared [`TailBuf`]. Draining is itself a
/// correctness requirement, not just capture: an unread piped stderr fills
/// the OS pipe buffer and blocks the child. The thread ends when the pipe
/// EOFs (the child exited / was killed) or errors; dropping the handle does
/// NOT stop it -- the process is killed on every probe exit path, whose EOF
/// reaps the thread.
#[derive(Debug, Clone)]
pub struct StderrTail {
    tail: Arc<Mutex<TailBuf>>,
    /// Fires (tx dropped) when the reader thread exits; the
    /// snapshot waits on it under [`STDERR_TAIL_JOIN_TIMEOUT`].
    done_rx: Arc<Mutex<Option<mpsc::Receiver<()>>>>,
}

impl StderrTail {
    /// Start the reader thread on the child's piped stderr. `pub(super)` so
    /// the sibling probe modules' unit tests can build a tail over a
    /// controlled pipe (the production callers all go through
    /// [`ChildHandle::take_pipes`]).
    pub(super) fn spawn(mut stderr: ChildStderr) -> Self {
        let tail = Arc::new(Mutex::new(TailBuf::default()));
        let sink = Arc::clone(&tail);
        let (done_tx, done_rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            use std::io::Read;
            // Fixed-size chunks bound the intermediate buffer as well: a
            // newline-free runaway stream cannot grow any single read past
            // the cap (the ring bounds memory only after a read returns).
            let mut chunk = [0u8; STDERR_TAIL_CAP];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        if let Ok(mut t) = sink.lock() {
                            t.push_bytes(&chunk[..n]);
                        }
                    }
                    // The error is unrecoverable (the capture ends either
                    // way); log it so "why is the tail empty" has an answer
                    // (issue #543). Warn, not debug: release builds filter
                    // at Info, and the packaged app's absent console is
                    // exactly where this diagnosis matters.
                    Err(e) => {
                        log::warn!(target: "toptopduck::probe", "stderr reader failed: {e}");
                        break;
                    }
                }
            }
            drop(done_tx);
        });
        Self {
            tail,
            done_rx: Arc::new(Mutex::new(Some(done_rx))),
        }
    }

    /// The captured tail (empty when the CLI printed nothing). Waits for the
    /// reader thread to finish (bounded by [`STDERR_TAIL_JOIN_TIMEOUT`]) so a
    /// dead child's final bytes have landed before the snapshot -- without
    /// the wait, the error and the last stderr write race, and a detail can
    /// miss the diagnosis it exists to carry. A second call (or a timeout)
    /// degrades to whatever has landed so far.
    fn snapshot(&self) -> String {
        if let Ok(mut slot) = self.done_rx.lock() {
            if let Some(rx) = slot.take() {
                let _ = rx.recv_timeout(STDERR_TAIL_JOIN_TIMEOUT);
            }
        }
        self.tail.lock().map(|t| t.snapshot()).unwrap_or_default()
    }

    /// Log the captured tail at warn level (empty tails log nothing),
    /// tagged with the exit path that would otherwise lose the diagnosis.
    /// A `Timeout` cannot change shape (its IPC form is pinned), so its
    /// tail goes to the log: the outer-timeout path calls this after the
    /// kill (the kill's EOF lets the reader thread drain the pipe's final
    /// bytes before the snapshot), and the blocking task calls it itself
    /// when its own inner-timeout or stdout-EOF race wins (the
    /// `commands.rs` contract: inner races are left to the blocking
    /// task's own log).
    pub(crate) fn log_tail(&self, context: &str) {
        let tail = self.snapshot();
        if !tail.is_empty() {
            log::warn!(target: "toptopduck::probe", "{context}; stderr tail: {tail}");
        }
    }
}

/// Append the captured stderr tail to a detail string: `"; stderr tail:
/// <tail>"` when the CLI printed one, the detail unchanged otherwise. The
/// single owner of the append shape -- every detail-carrying surface goes
/// through it: the failure path ([`attach_stderr_tail`]) and the codex
/// degraded outcome (issue #543 -- the `Unavailable` detail is the only
/// diagnostic surface a degraded outcome has), so the two paths cannot drift
/// apart.
pub(super) fn with_stderr_tail(detail: String, stderr_tail: &StderrTail) -> String {
    let tail = stderr_tail.snapshot();
    if tail.is_empty() {
        return detail;
    }
    format!("{detail}; stderr tail: {tail}")
}

/// Attach the captured stderr tail to a probe failure (issue #542): a
/// `HandshakeFailure` gains the CLI's own diagnosis in its detail (when the
/// CLI printed one); a `Timeout` cannot change shape (its IPC form is pinned)
/// so its tail goes to the log instead. `SpawnFailure` / `NotDetected` precede
/// any child existing -- nothing to attach.
pub(super) fn attach_stderr_tail(err: ProbeError, stderr: &StderrTail) -> ProbeError {
    match err {
        ProbeError::HandshakeFailure(detail) => {
            ProbeError::HandshakeFailure(with_stderr_tail(detail, stderr))
        }
        ProbeError::Timeout => {
            stderr.log_tail("probe timed out");
            ProbeError::Timeout
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ring keeps the TAIL under churn: an over-capacity stream retains
    /// only its final bytes, and a torn head is cut forward to the next line
    /// boundary -- the dropped line's fill must not survive the snapshot
    /// (issue #542 AC).
    #[test]
    fn tail_buf_keeps_bounded_tail_not_head() {
        let mut t = TailBuf::default();
        // Two lines of 2 KiB each + one final line -- total exceeds the 4 KiB
        // cap, so the first line's head bytes are dropped and its torn
        // remainder must be cut away. Distinct fills ('y' vs 'x') make the
        // cut observable.
        let dropped = "y".repeat(STDERR_TAIL_CAP / 2);
        let kept = "x".repeat(STDERR_TAIL_CAP / 2);
        t.push_bytes(format!("{dropped}\n").as_bytes());
        t.push_bytes(format!("{kept}\n").as_bytes());
        t.push_bytes(b"auth failed\n");
        let snap = t.snapshot();
        assert!(
            snap.ends_with("auth failed"),
            "the tail keeps the final line: {snap}"
        );
        assert!(
            snap.starts_with('x'),
            "the snapshot starts at a line boundary: {snap}"
        );
        assert!(
            !snap.contains('y'),
            "the torn head line's remainder is cut forward: {snap}"
        );
        assert!(snap.len() <= STDERR_TAIL_CAP);
    }

    /// A single line longer than the cap leaves the cut nowhere to land: the
    /// snapshot degrades to a mid-line start rather than an empty diagnosis.
    #[test]
    fn tail_buf_over_cap_single_line_starts_mid_line() {
        let mut t = TailBuf::default();
        t.push_bytes(b"HEAD ");
        t.push_bytes("z".repeat(STDERR_TAIL_CAP).as_bytes());
        let snap = t.snapshot();
        assert!(
            !snap.contains("HEAD"),
            "the oldest bytes are dropped: {snap}"
        );
        assert!(
            snap.starts_with('z'),
            "no line break survives, so the window starts mid-line: {snap}"
        );
        assert!(!snap.is_empty());
    }

    /// An empty capture snapshots to the empty string (the failure detail
    /// appends nothing).
    #[test]
    fn tail_buf_empty_snapshots_empty() {
        assert_eq!(TailBuf::default().snapshot(), "");
    }

    /// A within-capacity capture passes through whole.
    #[test]
    fn tail_buf_small_capture_passes_through() {
        let mut t = TailBuf::default();
        t.push_bytes(b"one\ntwo\n");
        assert_eq!(t.snapshot(), "one\ntwo");
    }
}
