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
    let (stdin, stdout, stderr_tail) = child.take_pipes();
    let result = app_server::query_catalog(stdin, stdout, stderr_tail, timeout);
    child.kill_and_wait();
    result
}

/// A mistyped scenario must fail fast: the fixture exits non-zero before
/// answering anything, so the query surfaces the child's early stdout EOF,
/// never a confusing green run of the default success path (issue #543 AC).
/// The fixture is spawned directly (not via `query_fixture`) because the
/// dead child has no query answer -- the test asserts the exit, not a catalog.
#[test]
fn fixture_unknown_scenario_exits_nonzero() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::set_var("CODEX_APP_SERVER_SCENARIO", "catalog_tpyo");
    let out = std::process::Command::new(fake_cli())
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

// --- Handshake ---------------------------------------------------------------

/// An `initialize` refusal (the not-logged-in shape) degrades to `Unavailable`
/// -- same ADR-0096 D2 semantics as a `model/list` error: the process being
/// alive is diagnostic signal, so a refused handshake is a degraded success,
/// not a failure. Without the handshake round-trip this path cannot exist at
/// all (the server would refuse every request).
#[test]
fn query_init_error_degrades_to_unavailable() {
    let ok = query_fixture("catalog_init_error", Duration::from_secs(5))
        .expect("a refused handshake degrades, it does not fail");
    match ok {
        CodexCatalogOutcome::Unavailable { detail } => {
            assert!(
                detail.contains("auth required"),
                "the degraded detail names the handshake error: {detail}"
            );
        }
        other => panic!("expected Unavailable, got {other:?}"),
    }
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
            // A silent stderr must not append the marker: the empty-tail
            // branch of the same-shape append is pinned here (issue #543 --
            // a degraded detail growing a bare `stderr tail: ` artifact would
            // stay green otherwise).
            assert!(
                !detail.contains("stderr tail"),
                "a silent stderr appends nothing: {detail}"
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
/// site too). The fixture also stays chatty on stderr while answering -- a
/// healthy success never appends a tail, and the drained pipe proves the
/// reader keeps up under load.
#[test]
fn query_stray_lines_are_dropped_not_fatal() {
    let models = expect_available(query_fixture("catalog_chatty", Duration::from_secs(5)).unwrap());
    assert!(
        models.is_empty(),
        "the chatty page folds an empty catalog: {models:?}"
    );
}

/// A raw non-JSON line ahead of the catalog response (a CLI log banner) is
/// skipped by the shared loop, not an error: the catalog still arrives
/// (issue #543 -- the parse-failure branch on the skip path, distinct from
/// `catalog_chatty`'s legal-JSON strays). The fixture is also stderr-chatty
/// while answering, pinning the pipe-drain side: a healthy success appends
/// no tail and an undrained stderr would block the child.
#[test]
fn query_garbage_line_is_skipped_not_fatal() {
    let models =
        expect_available(query_fixture("catalog_garbage", Duration::from_secs(5)).unwrap());
    assert_eq!(
        models.len(),
        1,
        "the catalog after the garbage line: {models:?}"
    );
    assert_eq!(models[0].id, "gpt-5.1-codex-mini");
}

/// A cursor that always repeats itself wedges the traversal: the wall clock
/// ends it as a structured Timeout, never a hang or an infinite fold
/// (issue #543 pins the loop-cursor safety property).
#[test]
fn query_cursor_loop_surfaces_timeout() {
    let err = query_fixture("catalog_cursor_loop", Duration::from_secs(2))
        .expect_err("a looping cursor must fail the query");
    assert_eq!(err, ProbeError::Timeout);
}

/// Cross-page duplicate ids dedupe by id, first sight winning (issue #543):
/// page 1's entry survives with its own fields; page 2's divergent repeat is
/// dropped while its new model folds in.
#[test]
fn query_duplicate_ids_across_pages_dedupe_first_sight() {
    let models =
        expect_available(query_fixture("catalog_dup_ids", Duration::from_secs(30)).unwrap());
    assert_eq!(
        models.len(),
        2,
        "the repeated id appears once plus the new model: {models:?}"
    );
    let codex = models
        .iter()
        .find(|m| m.id == "gpt-5.2-codex")
        .expect("the first-sight entry survives");
    assert_eq!(
        codex.display_name, "GPT-5.2 Codex",
        "first sight wins: the divergent second-sight fields are dropped"
    );
    assert!(models.iter().any(|m| m.id == "gpt-5.1-codex-mini"));
}

/// An RPC error from a chatty-but-alive CLI (the not-logged-in shape)
/// degrades to `Unavailable` whose detail ALSO carries the stderr diagnosis
/// (issue #543 -- the degraded success variant appends the tail at its
/// construction site, same shape as the failure path's `attach_stderr_tail`).
#[test]
fn query_rpc_error_unavailable_carries_stderr_tail() {
    let ok = query_fixture("catalog_error_chatty", Duration::from_secs(5))
        .expect("an RPC error degrades, it does not fail");
    match ok {
        CodexCatalogOutcome::Unavailable { detail } => {
            assert!(
                detail.contains("auth required"),
                "the degraded detail names the RPC error: {detail}"
            );
            assert!(
                detail.contains("stderr tail: codex-fake: please run `codex login`"),
                "the degraded detail carries the stderr diagnosis: {detail}"
            );
        }
        other => panic!("expected Unavailable, got {other:?}"),
    }
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
    let (stdin, stdout, stderr_tail) = child.take_pipes();
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
