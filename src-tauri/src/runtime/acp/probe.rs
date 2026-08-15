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
use std::process::{Child, ChildStdin, ChildStdout};
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
/// child's stdio.
pub fn spawn_child(spec: &AdapterSpec, binary: Option<&Path>) -> Result<ChildHandle, ProbeError> {
    let binary = binary.ok_or_else(|| ProbeError::NotDetected(spec.id.to_string()))?;
    super::process::spawn_piped(binary, spec.probe_argv.unwrap_or(spec.argv))
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
) -> Result<DiscoveredRuntime, ProbeError> {
    let mut io = ProbeIo::new(stdin, stdout);
    let deadline = Instant::now() + timeout;
    handshake(&mut io, spec, deadline)
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
