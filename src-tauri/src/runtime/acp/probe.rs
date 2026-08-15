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
//! Both stream formats are probeable (ADR-0096 D2): ACP adapters run the
//! initialize + `session/new` handshake here, while `JsonEventStream`
//! adapters (codex) dispatch to [`super::app_server`]'s `model/list` query
//! -- the same spawn -> query -> kill lifecycle, a different wire surface.

use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::runtime::acp::adapter::{AdapterSpec, DiscoveredRuntime};
use crate::runtime::acp::wire::{
    self, InitializeParams, NewSessionParams, NewSessionResult, Request, RequestId, Response,
};

/// The probe's wall-clock ceiling (ADR-0096, implementation-time calibration):
/// generous for the slowest real cold start (node CLIs take seconds to tens
/// of seconds) while still bounding a hung CLI. Tests inject a short
/// deadline instead -- this constant is the production default only.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// A successful probe (ADR-0096 D2/D3). Per-format tagged: the ACP handshake
/// produces the flat [`DiscoveredRuntime`] (issue #534); the codex app-server
/// `model/list` produces a per-model [`CodexCatalogOutcome`] (issue #535) --
/// the latter never flattened into `DiscoveredRuntime` (a union of per-model
/// efforts would let the user select an effort the current model does not
/// support, ADR-0096 D3). The session id is not carried: the probe mints no
/// usable session (the process is killed right after the handshake).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ProbeOk {
    /// The ACP handshake catalog, stamped with the producing adapter (issue
    /// #529 semantics -- the config_options wire carries no adapter identity).
    Acp { discovered: DiscoveredRuntime },
    /// The codex app-server model catalog, or the honest degraded "started
    /// but catalog unavailable" state (ADR-0096 D2 -- an old codex / not
    /// logged in / RPC error degrades; only a spawn failure, a timeout, or
    /// the process dying mid-query fails outright).
    Codex { outcome: CodexCatalogOutcome },
}

/// The codex app-server `model/list` outcome (ADR-0096 D2/D3). `Available`
/// carries the ordered per-model catalog; `Unavailable` is the degraded state
/// (the process started but the catalog was not obtainable -- RPC error /
/// empty response / unparseable result; the process being alive is itself
/// diagnostic signal, so this is a success variant, not an error).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CodexCatalogOutcome {
    Available { models: Vec<CodexModel> },
    Unavailable { detail: String },
}

/// One codex model from the `model/list` catalog (ADR-0096 D3). The reasoning
/// efforts are the per-model `supportedReasoningEfforts` in the CLI's declared
/// order (never a union across models); `default_reasoning_effort` marks the
/// model's own default; `is_default` marks the catalog's default model.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CodexModel {
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
/// the `app-server` subcommand on JsonEventStream, both carried as data on the
/// spec so the kernel names no CLI) and piped stdio. A fresh PATH scan
/// returning `None` refuses with [`ProbeError::NotDetected`] before any spawn
/// is attempted. The caller dispatches the per-format query on the returned
/// child's stdio. Contract (issue #542): stderr is spawned PIPED and is
/// drained ONLY by [`ChildHandle::take_stderr_tail`]'s reader thread -- every
/// caller must take the tail (alongside [`ChildHandle::take_stdio`]) for every
/// child it spawned, including early-failure paths after a successful spawn;
/// an untaken piped stderr is never read, so a chatty child can block on a
/// full OS pipe buffer and wedge until killed.
pub fn spawn_child(spec: &AdapterSpec, binary: Option<&Path>) -> Result<ChildHandle, ProbeError> {
    let binary = binary.ok_or_else(|| ProbeError::NotDetected(spec.id.to_string()))?;
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
    /// Take the piped stdio for the handshake. The spawn pipes both ends,
    /// so a single take is the only valid lifetime.
    pub fn take_stdio(&mut self) -> (ChildStdin, ChildStdout) {
        let stdout = self.inner.stdout.take().expect("piped stdout");
        let stdin = self.inner.stdin.take().expect("piped stdin");
        (stdin, stdout)
    }

    /// Take the piped stderr and start the tail capture (issue #542). The
    /// returned [`StderrTail`] drains the pipe on its own thread into a
    /// bounded ring, so a chatty CLI cannot fill the OS pipe buffer (which
    /// would block the child) or grow unbounded memory.
    pub fn take_stderr_tail(&mut self) -> StderrTail {
        let stderr = self.inner.stderr.take().expect("piped stderr");
        StderrTail::spawn(stderr)
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
    /// [`super::ndjson::NdjsonIo::request_roundtrip`]).
    fn request_roundtrip<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &mut self,
        req: Request<P>,
        deadline: Instant,
    ) -> Result<Response<R>, ProbeError> {
        let target = serde_json::to_value(&req.id).unwrap_or(serde_json::Value::Null);
        self.inner
            .request_roundtrip(&req, &target, super::ndjson::Abort::Deadline(deadline))
            .map_err(|e| map_roundtrip_error(e, "ACP agent"))
    }
}

/// Map the shared round-trip failure onto the probe's error type. `who` names
/// the child in the EOF detail (the ACP handshake and the app-server query
/// word it differently). Shared with [`super::app_server`]'s deadline-driven
/// query.
pub(super) fn map_roundtrip_error(e: super::ndjson::RoundtripError, who: &str) -> ProbeError {
    match e {
        super::ndjson::RoundtripError::Cancelled => {
            unreachable!("deadline-driven round-trips never report Cancelled")
        }
        super::ndjson::RoundtripError::Timeout => ProbeError::Timeout,
        super::ndjson::RoundtripError::Serialize(detail) => {
            ProbeError::HandshakeFailure(format!("serialize: {detail}"))
        }
        super::ndjson::RoundtripError::Write(detail) => {
            ProbeError::HandshakeFailure(format!("write: {detail}"))
        }
        super::ndjson::RoundtripError::Eof => {
            ProbeError::HandshakeFailure(format!("{who} closed stdout"))
        }
        super::ndjson::RoundtripError::Parse(detail) => {
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
    /// Fires (tx dropped or a unit sent) when the reader thread exits; the
    /// snapshot waits on it under [`STDERR_TAIL_JOIN_TIMEOUT`].
    done_rx: Arc<Mutex<Option<mpsc::Receiver<()>>>>,
}

impl StderrTail {
    /// Start the reader thread on the child's piped stderr.
    fn spawn(stderr: ChildStderr) -> Self {
        let tail = Arc::new(Mutex::new(TailBuf::default()));
        let sink = Arc::clone(&tail);
        let (done_tx, done_rx) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let mut reader = BufReader::new(stderr);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        if let Ok(mut t) = sink.lock() {
                            t.push_bytes(&line);
                        }
                    }
                    Err(_) => break,
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
}

/// Attach the captured stderr tail to a probe failure (issue #542): a
/// `HandshakeFailure` gains the CLI's own diagnosis in its detail (when the
/// CLI printed one); a `Timeout` cannot change shape (its IPC form is pinned)
/// so its tail goes to the log instead. `SpawnFailure` / `NotDetected` precede
/// any child existing -- nothing to attach.
pub(super) fn attach_stderr_tail(err: ProbeError, stderr: &StderrTail) -> ProbeError {
    let tail = stderr.snapshot();
    if tail.is_empty() {
        return err;
    }
    match err {
        ProbeError::HandshakeFailure(detail) => {
            ProbeError::HandshakeFailure(format!("{detail}; stderr tail: {tail}"))
        }
        ProbeError::Timeout => {
            log::warn!(target: "toptopduck::probe", "probe timed out; stderr tail: {tail}");
            ProbeError::Timeout
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ring keeps the TAIL under churn: an over-capacity stream retains
    /// only its final bytes, dropped at a line boundary (issue #542 AC).
    #[test]
    fn tail_buf_keeps_bounded_tail_not_head() {
        let mut t = TailBuf::default();
        // Two lines of 3 KiB each + one final line -- total exceeds the 4 KiB
        // cap, so the first line's head bytes are dropped.
        let long_line = "x".repeat(STDERR_TAIL_CAP - STDERR_TAIL_CAP / 2);
        t.push_bytes(format!("{long_line}\n").as_bytes());
        t.push_bytes(format!("{long_line}\n").as_bytes());
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
        assert!(snap.len() <= STDERR_TAIL_CAP);
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
