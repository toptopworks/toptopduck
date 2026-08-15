//! Adapter diagnostic probe integration tests (ADR-0096, issue #534).
//!
//! Drives the probe kernel against the fake-CLI fixture across every
//! observable branch: the success path (handshake + config_options extract),
//! the handshake-failure family (an initialize RPC error + a CLI that exits
//! mid-handshake), the timeout path (a CLI that never answers the
//! handshake), the spawn failure path (a vanished binary), and process
//! cleanup (the heartbeat in the fixture's trace file stops appending after
//! the probe kills the child). The probe shares the wire types with the
//! engine's fixture, so the round-trip is faithful to what the real
//! claude-code drive will take.

use std::path::PathBuf;
use std::time::Duration;

use toptopduck_lib::runtime::acp::adapter::{claude_code, codex};
use toptopduck_lib::runtime::acp::probe::{self, ProbeError};

/// Resolve the fake-CLI binary path (cargo sets `CARGO_BIN_EXE_acp-fake-cli`
/// for integration tests of the same package).
fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_acp-fake-cli"))
}

/// A temp heartbeat trace file the fixture appends to while alive.
fn heartbeat_file(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "acp-probe-heartbeat-{tag}-{}.log",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

/// Process-wide lock so the global `ACP_FAKE_SCENARIO` env var is not raced
/// by concurrent tests (the acp_engine.rs convention).
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Spawn the fixture under `scenario` with the heartbeat trace wired, then
/// run the probe lifecycle (spawn -> handshake -> kill, the same three
/// steps the IPC shell composes) with a short timeout (the fixture answers
/// in milliseconds; the timeout only needs to outlast it, not the 45s
/// production default). Holds ENV_LOCK so the global `ACP_FAKE_SCENARIO`
/// is not raced by concurrent tests.
fn probe_fixture(scenario: &str, timeout: Duration) -> Result<probe::ProbeOk, ProbeError> {
    probe_with(&fake_cli(), scenario, timeout)
}

/// The blocking probe lifetime on a pre-resolved binary: the three-step
/// composition every probe caller uses (spawn -> handshake -> kill on every
/// exit path). Caller must NOT hold `ENV_LOCK` (taken here -- the same
/// non-reentrant mutex).
fn probe_with(
    binary: &std::path::Path,
    scenario: &str,
    timeout: Duration,
) -> Result<probe::ProbeOk, ProbeError> {
    let _g = ENV_LOCK.lock().unwrap();
    probe_with_locked(binary, scenario, timeout)
}

/// [`probe_with`] without the lock -- for callers already holding
/// `ENV_LOCK` (e.g. to also set `ACP_FAKE_TRACE_FILE` under it).
fn probe_with_locked(
    binary: &std::path::Path,
    scenario: &str,
    timeout: Duration,
) -> Result<probe::ProbeOk, ProbeError> {
    std::env::set_var("ACP_FAKE_SCENARIO", scenario);
    let spec = claude_code();
    let mut child = probe::spawn_child(&spec, Some(binary))?;
    let (stdin, stdout) = child.take_stdio();
    let result = probe::handshake_with(stdin, stdout, &spec, timeout);
    child.kill_and_wait();
    result
}

// --- Success --------------------------------------------------------------

/// The happy path: initialize + session/new complete, the config_options
/// catalog extracts into the DiscoveredRuntime shape, and the producing
/// adapter is stamped (issue #529 semantics).
#[test]
fn probe_success_extracts_catalog() {
    let ok = probe_fixture("text_reply", Duration::from_secs(30)).expect("probe must succeed");
    assert_eq!(ok.discovered.models, vec!["fake-opus", "fake-sonnet"]);
    assert_eq!(ok.discovered.current_model.as_deref(), Some("fake-opus"));
    assert_eq!(ok.discovered.thought_levels, vec!["low", "medium", "high"]);
    assert_eq!(
        ok.discovered.current_thought_level.as_deref(),
        Some("medium")
    );
    assert_eq!(ok.discovered.adapter_id.as_deref(), Some("claude-code"));
}

// --- Timeout ---------------------------------------------------------------

/// A CLI that never answers the handshake trips the wall-clock timeout: the
/// kernel returns the structured Timeout failure (never hangs), and the
/// child is killed + reaped (no orphan).
#[test]
fn probe_timeout_returns_structured_failure() {
    let err = probe_fixture("handshake_silent", Duration::from_secs(2))
        .expect_err("a silent CLI must fail the probe");
    assert_eq!(err, ProbeError::Timeout);
}

// --- Handshake failure -----------------------------------------------------

/// A CLI that answers initialize with a JSON-RPC error surfaces a
/// HandshakeFailure naming the failing step and the CLI's message, not a
/// timeout: this is the most probable real-world failure (a CLI that is
/// installed but not logged in / misconfigured).
#[test]
fn probe_rpc_error_is_handshake_failure() {
    let err = probe_fixture("handshake_error", Duration::from_secs(5))
        .expect_err("an erroring CLI must fail the probe");
    match &err {
        ProbeError::HandshakeFailure(detail) => {
            assert!(
                detail.contains("initialize"),
                "the failure names the failing step: {detail}"
            );
            assert!(
                detail.contains("not logged in"),
                "the failure carries the CLI's message: {detail}"
            );
        }
        other => panic!("expected HandshakeFailure, got {other:?}"),
    }
}

/// A CLI that exits right after initialize (crash / insta-quit) hits stdout
/// EOF on session/new: a structured HandshakeFailure, never a hang.
#[test]
fn probe_stdout_eof_is_handshake_failure() {
    let err = probe_fixture("handshake_crash", Duration::from_secs(5))
        .expect_err("a crashing CLI must fail the probe");
    match &err {
        ProbeError::HandshakeFailure(detail) => {
            assert!(
                detail.contains("closed stdout"),
                "the EOF names the disconnection: {detail}"
            );
        }
        other => panic!("expected HandshakeFailure, got {other:?}"),
    }
}

// --- Spawn failure ---------------------------------------------------------

/// A binary path that does not exist is a structured SpawnFailure naming the
/// adapter, not a panic.
#[test]
fn probe_spawn_failure_is_structured() {
    let mut missing = std::env::temp_dir();
    missing.push("definitely-not-a-real-acp-binary-xyz");
    let err = probe::spawn_child(&claude_code(), Some(&missing))
        .expect_err("a vanished binary must fail the probe");
    match &err {
        ProbeError::SpawnFailure(detail) => {
            assert!(
                detail.contains("claude-code"),
                "spawn failure names the adapter: {detail}"
            );
        }
        other => panic!("expected SpawnFailure, got {other:?}"),
    }
}

// --- Process cleanup -------------------------------------------------------

/// The fixture's heartbeat (append every 100ms while alive) stops after the
/// probe returns: the child was killed and reaped, not left running.
#[test]
fn probe_kills_the_child_no_orphan() {
    let heartbeat = heartbeat_file("cleanup");
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("ACP_FAKE_TRACE_FILE", &heartbeat);
    // `probe_with_locked`: this test already holds ENV_LOCK (the trace-file
    // var must be set/cleared under it), and the mutex is not reentrant.
    let result = probe_with_locked(&fake_cli(), "handshake_silent", Duration::from_secs(2));
    std::env::remove_var("ACP_FAKE_TRACE_FILE");
    // The probe itself may fail (timeout) -- cleanup is asserted regardless.
    assert!(result.is_err());

    let size_after_probe = std::fs::metadata(&heartbeat).map(|m| m.len()).unwrap_or(0);
    assert!(
        size_after_probe > 0,
        "fixture must have heartbeated at least once"
    );
    // A killed process may still have one in-flight beat in flight (the
    // heartbeat thread races the kill). Poll until the file goes quiet: it
    // must stabilize well within a second (alive = +10 bytes / 100ms); a
    // still-growing file after that window is an orphan.
    let mut stable = 0;
    let mut last_size = size_after_probe;
    for _ in 0..20 {
        std::thread::sleep(Duration::from_millis(100));
        let size = std::fs::metadata(&heartbeat).map(|m| m.len()).unwrap_or(0);
        if size == last_size {
            stable += 1;
            if stable >= 3 {
                break;
            }
        } else {
            stable = 0;
            last_size = size;
        }
    }
    assert!(
        stable >= 3,
        "the heartbeat must stop after the probe returns (no orphan process); still growing: {last_size} bytes"
    );
    let _ = std::fs::remove_file(&heartbeat);
}

// --- Per-format dispatch ---------------------------------------------------

/// JsonEventStream adapters (codex) reject with Unsupported: this slice
/// delivers the ACP probe loop only (ADR-0096 D2; the app-server path is a
/// later slice).
#[test]
fn probe_rejects_json_event_stream_adapters() {
    let err = probe::spawn_child(&codex(), Some(&fake_cli()))
        .expect_err("a JsonEventStream adapter must be refused");
    assert_eq!(err, ProbeError::Unsupported("codex".to_string()));
}

/// An undetected adapter (binary path None) rejects with NotDetected before
/// any spawn is attempted.
#[test]
fn probe_rejects_undetected_adapters() {
    let err = probe::spawn_child(&claude_code(), None)
        .expect_err("an undetected adapter must be refused");
    assert_eq!(err, ProbeError::NotDetected("claude-code".to_string()));
}
