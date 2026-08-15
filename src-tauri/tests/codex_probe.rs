//! Codex app-server diagnostic query integration tests (ADR-0096, issue #535).
//!
//! Drives the app-server `model/list` query against the codex-app-server fake
//! fixture across every observable branch: the success path (single-page
//! catalog + ordered per-model efforts), the pagination cursor traversal, the
//! RPC-error degradation (process alive, catalog unavailable -- NOT a failure),
//! the timeout path (a silent server), the mid-query crash (stdout EOF), the
//! spawn failure (a vanished binary), and process cleanup. The fixture speaks
//! the real app-server wire (no `jsonrpc` field), so the round-trip is faithful
//! to what a real `codex app-server` drive will take.

use std::path::PathBuf;
use std::time::Duration;

use toptopduck_lib::runtime::acp::adapter::codex;
use toptopduck_lib::runtime::acp::app_server;
use toptopduck_lib::runtime::acp::probe::{self, CodexCatalogOutcome, ProbeError};

/// Resolve the fake app-server binary path (cargo sets
/// `CARGO_BIN_EXE_codex-app-server-fake` for integration tests).
fn fake_cli() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_codex-app-server-fake"))
}

/// A temp heartbeat trace file the fixture appends to while alive.
fn heartbeat_file(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!(
        "codex-probe-heartbeat-{tag}-{}.log",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&p);
    p
}

/// Process-wide lock so the global `CODEX_APP_SERVER_SCENARIO` env var is not
/// raced by concurrent tests (the acp_probe.rs convention).
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Spawn the fixture under `scenario`, then run the query lifecycle (spawn ->
/// query -> kill, the same three steps the IPC shell composes) with a short
/// timeout (the fixture answers in milliseconds). Holds ENV_LOCK.
fn query_fixture(scenario: &str, timeout: Duration) -> Result<CodexCatalogOutcome, ProbeError> {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CODEX_APP_SERVER_SCENARIO", scenario);
    let spec = codex();
    let mut child = probe::spawn_child(&spec, Some(&fake_cli()))?;
    let (stdin, stdout) = child.take_stdio();
    let stderr_tail = child.take_stderr_tail();
    let result = app_server::query_catalog(stdin, stdout, stderr_tail, timeout);
    child.kill_and_wait();
    result
}

/// Unwrap the `Available` outcome (panics with the full value otherwise).
fn expect_available(
    outcome: CodexCatalogOutcome,
) -> Vec<toptopduck_lib::runtime::acp::probe::CodexModel> {
    match outcome {
        CodexCatalogOutcome::Available { models } => models,
        other => panic!("expected Available, got {other:?}"),
    }
}

// --- Success ---------------------------------------------------------------

/// The happy path: `model/list` returns both models in one page; the catalog
/// preserves the CLI's declared effort order and the default markers.
#[test]
fn query_success_returns_ordered_catalog() {
    let models =
        expect_available(query_fixture("catalog_success", Duration::from_secs(30)).unwrap());
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "gpt-5.2-codex");
    assert_eq!(models[0].display_name, "GPT-5.2 Codex");
    assert!(models[0].is_default);
    assert_eq!(models[0].default_reasoning_effort, "medium");
    assert_eq!(
        models[0].supported_reasoning_efforts,
        vec!["low", "medium", "high"],
        "the declared effort order is preserved (ADR-0096 D3)"
    );
    assert_eq!(models[1].id, "gpt-5.1-codex-mini");
    assert!(!models[1].is_default);
    assert_eq!(models[1].supported_reasoning_efforts, vec!["low"]);
}

/// A paginated catalog: page 1 carries `nextCursor`, page 2 ends the list. The
/// query must follow the cursor and fold both pages into one catalog.
#[test]
fn query_follows_pagination_cursor() {
    let models =
        expect_available(query_fixture("catalog_paginated", Duration::from_secs(30)).unwrap());
    assert_eq!(models.len(), 2, "both pages fold into one catalog");
    assert_eq!(models[0].id, "gpt-5.2-codex");
    assert_eq!(models[1].id, "gpt-5.1-codex-mini");
}

// --- Degradation ------------------------------------------------------------

/// A `model/list` JSON-RPC error (old codex without the RPC / not logged in)
/// degrades to `Unavailable` -- the process being alive is diagnostic signal,
/// so this is a success variant, not a failure (ADR-0096 D2).
#[test]
fn query_rpc_error_degrades_to_unavailable() {
    let ok = query_fixture("catalog_error", Duration::from_secs(5))
        .expect("an RPC error degrades, it does not fail");
    match ok {
        CodexCatalogOutcome::Unavailable { detail } => {
            assert!(
                detail.contains("method not found"),
                "the degraded detail names the RPC error: {detail}"
            );
        }
        other => panic!("expected Unavailable, got {other:?}"),
    }
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

// --- Mid-query crash --------------------------------------------------------

/// A server that exits right after receiving `model/list` hits stdout EOF: a
/// structured HandshakeFailure naming the disconnection, never a hang. The
/// `who` prefix distinguishes this site from the ACP probe's identical
/// mapping (issue #540).
#[test]
fn query_crash_is_handshake_failure() {
    let err = query_fixture("catalog_crash", Duration::from_secs(5))
        .expect_err("a crashing server must fail the query");
    match err {
        ProbeError::HandshakeFailure(detail) => {
            assert!(
                detail.contains("closed stdout"),
                "the EOF names the disconnection: {detail}"
            );
            assert!(
                detail.contains("codex app-server"),
                "the who prefix names the app-server (not the ACP agent): {detail}"
            );
            // The crash's stderr diagnosis rides in the detail (issue #542).
            assert!(
                detail.contains("stderr tail: codex-fake: auth flow failed"),
                "the EOF failure carries the server's stderr tail: {detail}"
            );
        }
        other => panic!("expected HandshakeFailure, got {other:?}"),
    }
}

/// A server that prints NO stderr fails without any tail marker: no empty
/// `stderr tail:` noise (issue #542).
#[test]
fn query_empty_stderr_appends_nothing() {
    let err = query_fixture("catalog_malformed", Duration::from_secs(5))
        .expect_err("a malformed response must fail the query");
    match err {
        ProbeError::HandshakeFailure(detail) => {
            assert!(
                !detail.contains("stderr tail"),
                "an empty stderr must not append a tail marker: {detail}"
            );
        }
        other => panic!("expected HandshakeFailure, got {other:?}"),
    }
}

/// A `model/list` response with the right id but a result of the wrong type
/// fails the round-trip's response parse (the frozen "response parse:"
/// prefix), never a hang (issue #540).
#[test]
fn query_malformed_response_is_parse_failure() {
    let err = query_fixture("catalog_malformed", Duration::from_secs(5))
        .expect_err("a malformed response must fail the query");
    match err {
        ProbeError::HandshakeFailure(detail) => {
            assert!(
                detail.contains("response parse:"),
                "carries the parse prefix: {detail}"
            );
            assert!(
                !detail.contains("closed stdout"),
                "must not misreport as EOF: {detail}"
            );
        }
        other => panic!("expected HandshakeFailure, got {other:?}"),
    }
}

/// Stray lines ahead of the catalog response (a notification + a response
/// with an unrelated id) are dropped, not errors: the query still completes
/// (issue #540 pins the shared loop's stray-drop policy on the bare-envelope
/// site too).
#[test]
fn query_stray_lines_are_dropped_not_fatal() {
    let models = expect_available(query_fixture("catalog_chatty", Duration::from_secs(5)).unwrap());
    assert!(
        models.is_empty(),
        "the chatty page folds an empty catalog: {models:?}"
    );
}

// --- Spawn failure ----------------------------------------------------------

/// A binary path that does not exist is a structured SpawnFailure naming the
/// adapter, not a panic.
#[test]
fn query_spawn_failure_is_structured() {
    let mut missing = std::env::temp_dir();
    missing.push("definitely-not-a-real-codex-binary-xyz");
    let err = probe::spawn_child(&codex(), Some(&missing))
        .expect_err("a vanished binary must fail the probe");
    match err {
        ProbeError::SpawnFailure(detail) => {
            assert!(
                detail.contains("codex"),
                "spawn failure names the adapter: {detail}"
            );
        }
        other => panic!("expected SpawnFailure, got {other:?}"),
    }
}

// --- Process cleanup --------------------------------------------------------

/// The fixture's heartbeat stops after the query returns: the child was killed
/// and reaped, not left running.
#[test]
fn query_kills_the_child_no_orphan() {
    let heartbeat = heartbeat_file("cleanup");
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CODEX_APP_SERVER_TRACE_FILE", &heartbeat);
    std::env::set_var("CODEX_APP_SERVER_SCENARIO", "catalog_silent");
    let spec = codex();
    let mut child = probe::spawn_child(&spec, Some(&fake_cli())).expect("spawn must succeed");
    let (stdin, stdout) = child.take_stdio();
    let stderr_tail = child.take_stderr_tail();
    let result = app_server::query_catalog(stdin, stdout, stderr_tail, Duration::from_secs(2));
    child.kill_and_wait();
    std::env::remove_var("CODEX_APP_SERVER_TRACE_FILE");
    // The query itself fails (timeout) -- cleanup is asserted regardless.
    assert!(result.is_err());

    let size_after_probe = std::fs::metadata(&heartbeat).map(|m| m.len()).unwrap_or(0);
    assert!(
        size_after_probe > 0,
        "fixture must have heartbeated at least once"
    );
    // A killed process may still have one in-flight beat in flight. Poll until
    // the file goes quiet: it must stabilize well within a second.
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
