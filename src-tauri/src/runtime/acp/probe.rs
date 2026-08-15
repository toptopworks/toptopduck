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
//! This module owns the spawn shape and the blocking handshake: [`spawn_child`]
//! hands the spawned child + its stdio to the caller (the Child handle must
//! stay OUT of any `spawn_blocking` closure -- blocking tasks are not
//! cancellable, so this is the only way to guarantee a hung CLI is reaped
//! after the timeout), while [`handshake_with`] runs the deadline-bounded
//! blocking handshake (the `probe_mcp_server` layering, issue #392). Every
//! caller -- the IPC shell and the tests alike -- composes the same three
//! steps: spawn -> handshake -> kill.
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

/// The single spawn point every probe lifecycle goes through: guards the
/// format (ADR-0096 D2: Acp only in this slice -- the backend half of the
/// double guard; the UI simply does not offer the button), then spawns
/// `binary` with the adapter's argv prefix and piped stdio. A fresh PATH
/// scan returning `None` refuses with [`ProbeError::NotDetected`] before
/// any spawn is attempted.
pub fn spawn_child(spec: &AdapterSpec, binary: Option<&Path>) -> Result<ChildHandle, ProbeError> {
    match spec.stream_format {
        StreamFormat::Acp => {}
        StreamFormat::JsonEventStream => return Err(ProbeError::Unsupported(spec.id.to_string())),
    }
    let binary = binary.ok_or_else(|| ProbeError::NotDetected(spec.id.to_string()))?;
    Command::new(binary)
        .args(spec.argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map(|inner| ChildHandle { inner })
        .map_err(|e| {
            ProbeError::SpawnFailure(format!("failed to spawn ACP agent `{}`: {e}", spec.id))
        })
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
    spec: &AdapterSpec,
    timeout: Duration,
) -> Result<ProbeOk, ProbeError> {
    let mut io = ProbeIo::new(stdin, stdout);
    let deadline = Instant::now() + timeout;
    handshake(&mut io, spec, deadline).map(|discovered| ProbeOk { discovered })
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
