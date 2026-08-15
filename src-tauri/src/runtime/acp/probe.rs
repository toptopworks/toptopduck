//! The adapter diagnostic probe kernel (ADR-0096, issue #534).
//!
//! A session-agnostic, read-only verification channel, deliberately decoupled
//! from the turn path ([`super::engine`]): one-shot spawn of the detected
//! CLI binary in protocol mode -> ACP `initialize` + `session/new`
//! handshake -> [`DiscoveredRuntime`] extract from the response's
//! `config_options` (the SAME ADR-0095 extraction the turn handshake uses)
//! -> terminate the process. The probe never drives a turn, holds no session
//! lock, and produces no upstream session state.
//!
//! This module is the pure blocking kernel: the caller owns the wall-clock
//! deadline and the child's lifetime. The IPC shell (`commands::
//! probe_adapter`) spawns the child in the async scope, runs this kernel
//! under `spawn_blocking` bounded by `tokio::time::timeout`, and kills +
//! reaps the child on every exit (the `probe_mcp_server` pattern, issue
//! #392 -- a blocking task cannot be cancelled, so the Child handle must
//! stay outside it).
//!
//! Only [`StreamFormat::Acp`] adapters are probeable in this slice; the
//! app-server (`model/list`) path for `JsonEventStream` adapters is a later
//! slice (ADR-0096 D2).

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::thread;
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

/// A successful probe: the extracted catalog, stamped with the producing
/// adapter (issue #529 semantics -- the config_options wire carries no
/// adapter identity). The session id is not carried: the probe mints no
/// usable session (the process is killed right after the handshake).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProbeOk {
    pub discovered: DiscoveredRuntime,
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
    /// The adapter's stream format has no probe path in this slice (the
    /// JsonEventStream / app-server probe is a later slice, ADR-0096 D2).
    /// Carries the adapter id.
    #[error("probe not supported for adapter: {0}")]
    Unsupported(String),
    /// Spawning the CLI binary failed (vanished binary, permission, ...).
    /// Carries the English technical detail.
    #[error("{0}")]
    SpawnFailure(String),
    /// The ACP handshake failed (the CLI is not an ACP agent / crashed /
    /// spoke a foreign protocol). Carries the English technical detail.
    #[error("{0}")]
    HandshakeFailure(String),
    /// The wall-clock deadline elapsed before the handshake completed.
    #[error("probe timed out")]
    Timeout,
}

/// The blocking probe kernel (self-contained lifetime): spawn `binary` with
/// the adapter's argv prefix, run the initialize + `session/new` handshake
/// bounded by `timeout`, extract the catalog, kill + reap the child, and
/// return. The caller may pass a pre-resolved `binary` (tests: the
/// fake-CLI fixture); production resolves it via
/// [`crate::runtime::acp::adapter::detect_adapter`] first.
pub fn probe(spec: &AdapterSpec, binary: &Path, timeout: Duration) -> Result<ProbeOk, ProbeError> {
    match spec.stream_format {
        StreamFormat::Acp => {}
        // Acp is the only probeable format in this slice (ADR-0096 D2). The
        // UI does not offer the button for other formats; this is the
        // backend half of that double guard.
        StreamFormat::JsonEventStream => return Err(ProbeError::Unsupported(spec.id.to_string())),
    }
    let mut child = spawn(binary, spec)?;
    let stdout = child.inner.stdout.take().expect("piped stdout");
    let stdin = child.inner.stdin.take().expect("piped stdin");
    let mut io = ProbeIo::new(stdin, stdout);
    let deadline = Instant::now() + timeout;
    let result = handshake(&mut io, spec, deadline);
    // Every exit path kills + reaps: a probe child never outlives the probe
    // (ADR-0096 watchdog alignment).
    child.kill_and_wait();
    result.map(|discovered| ProbeOk { discovered })
}

/// The split-lifecycle probe handshake for the IPC shell (the
/// `spawn_stdio_child` + `stdio_handshake` layering of `probe_mcp_server`,
/// issue #392): the caller spawns the child in the async scope -- keeping
/// the `Child` handle OUTSIDE any `spawn_blocking` closure, the only way to
/// guarantee a hung CLI is reaped after `tokio::time::timeout` fires --
/// then hands the taken stdio here for the blocking handshake. This
/// function performs only the blocking I/O; process management stays with
/// the caller.
pub fn handshake_on(
    io: (ChildStdin, ChildStdout),
    spec: &AdapterSpec,
    timeout: Duration,
) -> Result<ProbeOk, ProbeError> {
    let mut io = ProbeIo::new(io.0, io.1);
    let deadline = Instant::now() + timeout;
    handshake(&mut io, spec, deadline).map(|discovered| ProbeOk { discovered })
}

/// The detected-adapter entry the IPC shell uses: `None` (the fresh PATH
/// scan found nothing) refuses with [`ProbeError::NotDetected`] before any
/// spawn is attempted.
pub fn probe_detected(
    spec: &AdapterSpec,
    binary: Option<std::path::PathBuf>,
    timeout: Duration,
) -> Result<ProbeOk, ProbeError> {
    let binary = binary.ok_or_else(|| ProbeError::NotDetected(spec.id.to_string()))?;
    probe(spec, &binary, timeout)
}

/// The spawned CLI child + its stdio. [`Self::kill_and_wait`] delegates to
/// [`super::process::kill_and_reap`] -- the same shared kill-reap logic the
/// turn engines use (prevents drift).
struct ChildHandle {
    inner: Child,
}

impl ChildHandle {
    fn kill_and_wait(&mut self) {
        super::process::kill_and_reap(&mut self.inner);
    }
}

fn spawn(binary: &Path, adapter: &AdapterSpec) -> Result<ChildHandle, ProbeError> {
    Command::new(binary)
        .args(adapter.argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map(|inner| ChildHandle { inner })
        .map_err(|e| {
            ProbeError::SpawnFailure(format!("failed to spawn ACP agent `{}`: {e}", adapter.id))
        })
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
    match (init.result, init.error) {
        (Some(_), _) => {}
        (None, Some(e)) => {
            return Err(ProbeError::HandshakeFailure(format!(
                "initialize error: {}",
                e.message
            )))
        }
        (None, None) => {
            return Err(ProbeError::HandshakeFailure(
                "initialize: empty response".into(),
            ))
        }
    }
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
    match (new_resp.result, new_resp.error) {
        (Some(r), _) => {
            // Issue #529 semantics: stamp the producing adapter onto the
            // catalog (the config_options wire carries no adapter identity).
            let mut discovered =
                crate::runtime::acp::adapter::extract_discovered_runtime(r.config_options.as_ref());
            discovered.adapter_id = Some(adapter.id.to_string());
            Ok(discovered)
        }
        (None, Some(e)) => Err(ProbeError::HandshakeFailure(format!(
            "session/new error: {}",
            e.message
        ))),
        (None, None) => Err(ProbeError::HandshakeFailure(
            "session/new: empty response".into(),
        )),
    }
}

// ---------------------------------------------------------------------------
// NDJSON stdio I/O
// ---------------------------------------------------------------------------

/// A line-delimited JSON-RPC channel over the child's stdio, deadline-driven
/// (the kernel's minimal counterpart of the engine's cancel-driven pump:
/// here the only abort condition is the wall clock).
struct ProbeIo {
    stdin: ChildStdin,
    rx: mpsc::Receiver<String>,
}

impl ProbeIo {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        let (tx, rx) = mpsc::channel::<String>();
        // The reader thread owns stdout; EOF drops tx, which the round-trip
        // treats as the CLI dying mid-handshake.
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        if tx.send(trimmed.to_string()).is_err() {
                            break; // round-trip gone
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Self { stdin, rx }
    }

    /// Send a request and pump incoming lines until its response arrives or
    /// the deadline passes. A stray notification / unrelated message is
    /// dropped (not an error) so a chatty agent cannot break the handshake.
    fn request_roundtrip<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &mut self,
        req: Request<P>,
        deadline: Instant,
    ) -> Result<Response<R>, ProbeError> {
        let target = serde_json::to_value(&req.id).unwrap_or(serde_json::Value::Null);
        let mut msg = serde_json::to_string(&req)
            .map_err(|e| ProbeError::HandshakeFailure(format!("serialize: {e}")))?;
        msg.push('\n');
        self.stdin
            .write_all(msg.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| ProbeError::HandshakeFailure(format!("write: {e}")))?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ProbeError::Timeout);
            }
            match self.rx.recv_timeout(remaining) {
                Ok(line) => {
                    let v: serde_json::Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if v.get("id") == Some(&target) && v.get("method").is_none() {
                        return serde_json::from_value(v).map_err(|e| {
                            ProbeError::HandshakeFailure(format!("response parse: {e}"))
                        });
                    }
                }
                // The next loop iteration re-derives the remaining time; a
                // partial-wait Timeout only ends the probe when the deadline
                // has actually passed.
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(ProbeError::HandshakeFailure(
                        "ACP agent closed stdout".into(),
                    ))
                }
            }
        }
    }
}
