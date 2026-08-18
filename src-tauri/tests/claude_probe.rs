//! Claude-code control-plane diagnostic query integration tests (ADR-0097
//! Decision 5, issue #561).
//!
//! Drives the stream-json control-plane `initialize` query against the
//! claude fake-CLI fixture across every observable branch: the success path
//! (per-model catalog with ordered efforts + default markers), hook frames
//! preceding the control response (the sniff drops them), the error-response
//! degradation (process alive, catalog unavailable -- NOT a failure), the
//! no-response degradation (stdout EOF -> the EMPTY catalog, ADR-0097
//! Decision 5), the timeout path (a silent server), the spawn failure (a
//! vanished binary), and process cleanup. The fixture speaks the measured
//! control wire (`control_request` / `control_response` keyed by
//! `request_id`), so the round-trip is faithful to what a real claude-code
//! drive will take.

use std::path::PathBuf;
use std::time::Duration;

use toptopduck_lib::runtime::acp::adapter::claude_code;
use toptopduck_lib::runtime::acp::claude_control;
use toptopduck_lib::runtime::acp::probe::{self, ModelCatalogOutcome, ProbeError};

/// Resolve the fake CLI binary path (cargo sets
/// `CARGO_BIN_EXE_claude-fake-cli` for integration tests).
fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_claude-fake-cli"))
}

/// A temp heartbeat trace file the fixture appends to while alive.
fn heartbeat_file(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "claude-probe-heartbeat-{tag}-{}.log",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

/// Process-wide lock so the global `CLAUDE_FAKE_SCENARIO` env var is not
/// raced by concurrent tests (the codex_probe.rs convention).
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Spawn the fixture under `scenario`, then run the query lifecycle (spawn
/// -> query -> kill, the same three steps the IPC shell composes) with a
/// short timeout (the fixture answers in milliseconds). Holds ENV_LOCK.
fn query_fixture(scenario: &str, timeout: Duration) -> Result<ModelCatalogOutcome, ProbeError> {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_FAKE_SCENARIO", scenario);
    let spec = claude_code();
    // The spawn kernel dispatches the adapter's `probe_argv` (the turn argv
    // + `--input-format stream-json`), which is exactly the argv the fake
    // CLI switches to probe mode on -- so this also pins the production
    // probe surface end-to-end.
    let mut child = probe::spawn_child(&spec, Some(&fake_cli()))?;
    let (stdin, stdout, stderr_tail) = child.take_pipes();
    let result = claude_control::query_catalog(stdin, stdout, stderr_tail, timeout);
    child.kill_and_wait();
    result
}

/// A mistyped scenario must fail fast: the fixture exits non-zero before
/// answering anything (the codex fixture's issue #543 convention).
#[test]
fn fixture_unknown_scenario_exits_nonzero() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_FAKE_SCENARIO", "catalog_tpyo");
    let out = std::process::Command::new(fake_cli())
        .arg("--input-format")
        .arg("stream-json")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .expect("fixture must be spawnable");
    assert!(
        !out.status.success(),
        "unknown scenario must exit non-zero (exit code: {:?})",
        out.status.code()
    );
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("unknown scenario"),
        "stderr must name the unknown scenario"
    );
}

/// Unwrap the `Available` outcome (panics with the full value otherwise).
fn expect_available(
    outcome: ModelCatalogOutcome,
) -> Vec<toptopduck_lib::runtime::acp::probe::CatalogModel> {
    match outcome {
        ModelCatalogOutcome::Available { models } => models,
        other => panic!("expected Available, got {other:?}"),
    }
}

// --- Success ---------------------------------------------------------------

/// The happy path: the initialize response carries both models; the catalog
/// preserves the declared effort order, the default markers, and the
/// `displayName` / `resolvedModel` display fallback.
#[test]
fn query_success_returns_ordered_catalog() {
    let models =
        expect_available(query_fixture("catalog_success", Duration::from_secs(30)).unwrap());
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "claude-sonnet-4");
    assert_eq!(models[0].display_name, "Claude Sonnet 4");
    assert!(models[0].is_default);
    assert_eq!(models[0].default_reasoning_effort, "medium");
    assert_eq!(
        models[0].supported_reasoning_efforts,
        vec!["low", "medium", "high"],
        "the declared effort order is preserved (ADR-0096 D3 precedent)"
    );
    assert_eq!(models[1].id, "claude-opus-4");
    assert_eq!(
        models[1].display_name, "claude-opus-4-20250514",
        "without a displayName, the resolved model name is the display"
    );
    assert!(!models[1].is_default);
    assert_eq!(models[1].supported_reasoning_efforts, vec!["high"]);
}

/// Hook frames preceding the control response on the same stdout are
/// dropped by the sniff, not errors (measured wire property).
#[test]
fn query_sniffs_past_hook_frames() {
    let models =
        expect_available(query_fixture("catalog_hook_noise", Duration::from_secs(30)).unwrap());
    assert_eq!(models.len(), 2, "the catalog arrives past the noise");
    assert_eq!(models[0].id, "claude-sonnet-4");
}

// --- Degradation ------------------------------------------------------------

/// AC: an error control response degrades to `Unavailable` -- the process
/// being alive is diagnostic signal, so this is a success variant, not a
/// failure (the ADR-0096 D2 precedent).
#[test]
fn query_error_response_degrades_to_unavailable() {
    let ok = query_fixture("catalog_error", Duration::from_secs(5))
        .expect("an error control response degrades, it does not fail");
    match ok {
        ModelCatalogOutcome::Unavailable { detail } => {
            assert!(
                detail.contains("auth required"),
                "the degraded detail names the control error: {detail}"
            );
            // A silent CLI leaves no bare `stderr tail: ` artifact behind
            // (the codex_probe.rs peer assertion, issue #542).
            assert!(
                !detail.contains("stderr tail"),
                "no stderr output means no tail marker: {detail}"
            );
        }
        other => panic!("expected Unavailable, got {other:?}"),
    }
}

/// An error control response from a chatty-but-alive CLI degrades to
/// `Unavailable` whose detail ALSO carries the stderr diagnosis (issue #543
/// precedent -- the degraded success variant appends the tail at its
/// construction site, same shape as the failure path's `attach_stderr_tail`;
/// the codex_probe.rs peer test).
#[test]
fn query_error_response_chatty_degrades_carries_stderr_tail() {
    let ok = query_fixture("catalog_error_chatty", Duration::from_secs(5))
        .expect("an error control response degrades, it does not fail");
    match ok {
        ModelCatalogOutcome::Unavailable { detail } => {
            assert!(
                detail.contains("auth required"),
                "the degraded detail names the control error: {detail}"
            );
            assert!(
                detail.contains("stderr tail: claude-fake: please run `claude login`"),
                "the degraded detail carries the stderr diagnosis: {detail}"
            );
        }
        other => panic!("expected Unavailable, got {other:?}"),
    }
}

/// AC: a child that reads the request but exits without answering degrades
/// to the EMPTY catalog (the no-response empty-catalog degrade, ADR-0097
/// Decision 5) -- an `Available` with no models, never a failure.
#[test]
fn query_no_response_degrades_to_empty_catalog() {
    let models = expect_available(
        query_fixture("catalog_no_response", Duration::from_secs(5))
            .expect("no response degrades, it does not fail"),
    );
    assert!(models.is_empty(), "the honest empty catalog: {models:?}");
}

// --- Timeout ----------------------------------------------------------------

/// A server that never answers trips the wall-clock timeout: a structured
/// Timeout, never a hang (and the child is reaped by the caller).
#[test]
fn query_timeout_returns_structured_failure() {
    let err = query_fixture("catalog_silent", Duration::from_secs(2))
        .expect_err("a silent server must fail the query");
    assert_eq!(err, ProbeError::Timeout);
}

// --- Spawn failure ----------------------------------------------------------

/// A binary path that does not exist is a structured SpawnFailure naming the
/// adapter, not a panic.
#[test]
fn query_spawn_failure_is_structured() {
    let mut missing = std::env::temp_dir();
    missing.push("definitely-not-a-real-claude-binary-xyz");
    let err = probe::spawn_child(&claude_code(), Some(&missing))
        .expect_err("a vanished binary must fail the probe");
    match err {
        ProbeError::SpawnFailure(detail) => {
            assert!(
                detail.contains("claude-code"),
                "spawn failure names the adapter: {detail}"
            );
        }
        other => panic!("expected SpawnFailure, got {other:?}"),
    }
}

// --- Process cleanup --------------------------------------------------------

/// The fixture's heartbeat stops after the query returns: the child was
/// killed and reaped, not left running (the codex_probe.rs precedent).
#[test]
fn query_kills_the_child_no_orphan() {
    let heartbeat = heartbeat_file("cleanup");
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CLAUDE_FAKE_TRACE_FILE", &heartbeat);
    std::env::set_var("CLAUDE_FAKE_SCENARIO", "catalog_silent");
    let spec = claude_code();
    let mut child = probe::spawn_child(&spec, Some(&fake_cli())).expect("spawn must succeed");
    let (stdin, stdout, stderr_tail) = child.take_pipes();
    let result = claude_control::query_catalog(stdin, stdout, stderr_tail, Duration::from_secs(2));
    child.kill_and_wait();
    std::env::remove_var("CLAUDE_FAKE_TRACE_FILE");
    // The query itself fails (timeout) -- cleanup is asserted regardless.
    assert!(result.is_err());

    let size_after_probe = std::fs::metadata(&heartbeat).map(|m| m.len()).unwrap_or(0);
    assert!(
        size_after_probe > 0,
        "fixture must have heartbeated at least once"
    );
    // Poll until the file goes quiet: it must stabilize well within a second
    // (a killed process may have one beat in flight).
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
        "the heartbeat must stop after the query returns (no orphan process); still growing: {last_size} bytes"
    );
    let _ = std::fs::remove_file(&heartbeat);
}
