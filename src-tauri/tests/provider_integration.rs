//! Real-provider integration (issue #29, ADR-0007/0029): wires a LiveProvider
//! (routing to the Anthropic adapter) into a Session and drives one ask ->
//! materialize turn against a mockito server standing in for Anthropic.
//! Verifies the full chain the unit tests cannot -- window assembly -> real
//! HTTP provider -> SQL execution -> result_N materialization -- without a
//! network or a real key. The orchestrator's behavior is provider-agnostic
//! (FakeProvider covers the contract offline); this test pins that the real
//! provider plugs in correctly.

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use toptopduck_lib::{
    CancelToken, LiveProvider, LoadOutcome, Protocol, ResponseLocale, Session, StaticConfig,
    TurnFailure, TurnOutcome,
};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

/// The Anthropic response envelope carrying one model JSON reply.
fn anthropic_body(model_json: &str) -> String {
    serde_json::json!({
        "content": [{"type": "text", "text": model_json}]
    })
    .to_string()
}

/// Wire a LiveProvider with an Anthropic-protocol StaticConfig pointing at
/// `url`. Only `key` varies across the three integration tests; collapsing
/// the block here keeps the test bodies focused on the behavior under test.
fn anthropic_live_provider(url: String, key: Option<&str>) -> LiveProvider<StaticConfig> {
    LiveProvider::new(StaticConfig {
        key: key.map(str::to_string),
        base_url: url,
        model: "claude-sonnet-4-6".into(),
        locale: ResponseLocale::EnUS,
        protocol: Protocol::Anthropic,
    })
}

/// Wire a LiveProvider with an OpenAI-protocol StaticConfig pointing at `url`.
/// Mirrors [`anthropic_live_provider`]; only the protocol field (and a realistic
/// openai-shaped model id) differ. Drives both openai end-to-end tests so their
/// bodies stay focused on the behavior under test.
fn openai_live_provider(url: String, key: Option<&str>) -> LiveProvider<StaticConfig> {
    LiveProvider::new(StaticConfig {
        key: key.map(str::to_string),
        base_url: url,
        model: "gpt-4o".into(),
        locale: ResponseLocale::EnUS,
        protocol: Protocol::Openai,
    })
}

/// The OpenAI Chat Completions response envelope carrying one model JSON reply.
/// Mirrors `anthropic_body`; the openai adapter reads `choices[0].message.content`.
fn openai_body(model_json: &str) -> String {
    serde_json::json!({
        "choices": [{"message": {"role": "assistant", "content": model_json}}]
    })
    .to_string()
}

#[test]
fn real_provider_end_to_end_materializes_result() {
    let mut server = mockito::Server::new();
    // The mock returns a SQL that counts people rows. The reply uses the
    // source's sql_ref fragment verbatim, exactly as the system prompt asks.
    let _mock = server
        .mock("POST", "/v1/messages")
        .with_status(200)
        .with_body(anthropic_body(
            r#"{"type":"sql","sql":"SELECT COUNT(*) AS n FROM \"people\".data","viz":null,"assumption":null}"#,
        ))
        .create();

    let provider = anthropic_live_provider(server.url(), Some("sk-test"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    // Ingest the people fixture so the working set has a dataset to query.
    let people = fixtures_dir().join("people.csv");
    match session.ingest(&people) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected people.csv to load, got {other:?}"),
    }

    let outcome = session.ask("多少人");
    match outcome {
        TurnOutcome::Materialized { dataset, sql, .. } => {
            // The provider's SQL was executed and materialized as result_1.
            assert_eq!(dataset.reference_name, "result_1");
            assert_eq!(dataset.row_count, 1, "COUNT(*) yields one row");
            assert!(
                sql.as_deref().unwrap_or("").contains("COUNT(*)"),
                "executed SQL carried: {sql:?}"
            );
            // The count cell is the people.csv row count (5 data rows).
            assert_eq!(
                dataset.sample.first().and_then(|r| r.first()),
                Some(&"5".to_string())
            );
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
}

#[test]
fn real_provider_missing_key_yields_failed_turn() {
    // ADR-0029: with no key, the provider returns NotWired each attempt. The
    // single retry budget does not help (NotWired is not retried), so the turn
    // lands as Failed immediately -- the user is prompted to configure a key.
    let server = mockito::Server::new();
    let provider = anthropic_live_provider(server.url(), None);
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    let outcome = session.ask("anything");
    match outcome {
        TurnOutcome::Failed(TurnFailure::NotWired) => {}
        other => panic!("expected NotWired Failed, got {other:?}"),
    }
}

#[test]
fn real_provider_cancel_during_http_block_lands_cancelled() {
    // AC7 (ADR-0021/0028): a cancel during the real provider's blocking HTTP
    // call lands the turn as Cancelled. The real path uses a blocking ureq
    // client, so this is a *soft* cancel -- the HTTP call runs to completion
    // (<= REQUEST_TIMEOUT), then the post-call flag check discards the result
    // (the synchronous-client constraint recorded in ADR-0021). This exercises
    // the real HTTP path, which the non-blocking FakeProvider cannot represent.
    let mut server = mockito::Server::new();
    let body = Arc::new(anthropic_body(
        r#"{"type":"sql","sql":"SELECT COUNT(*) AS n FROM \"people\".data","viz":null,"assumption":null}"#,
    ));
    let body_for_mock = Arc::clone(&body);
    // Slow response: generate() blocks ~1s on the HTTP read, giving cancel a
    // wide window to land mid-call even on a slow CI.
    let _mock = server
        .mock("POST", "/v1/messages")
        .with_status(200)
        .with_chunked_body(move |w| {
            thread::sleep(Duration::from_millis(1000));
            w.write_all(body_for_mock.as_bytes())
        })
        .create();

    let cancel = Arc::new(CancelToken::new());
    let provider = anthropic_live_provider(server.url(), Some("sk-test"));
    let mut session = Session::with_provider_and_cancel(Box::new(provider), Arc::clone(&cancel))
        .expect("session");

    let people = fixtures_dir().join("people.csv");
    match session.ingest(&people) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected people.csv to load, got {other:?}"),
    }

    let handle = thread::spawn(move || session.ask("多少人"));
    // Let ask enter the blocking provider call, then fire cancel mid-call.
    thread::sleep(Duration::from_millis(300));
    cancel.request();

    let outcome = handle.join().expect("ask thread panicked");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "soft cancel during HTTP block should land Cancelled: got {outcome:?}"
    );
}

#[test]
fn real_openai_provider_end_to_end_materializes_result() {
    // Mirrors real_provider_end_to_end_materializes_result on the OpenAI
    // protocol (issue #160): LiveProvider routes to OpenaiProvider, the openai
    // adapter's SQL is executed by the engine, and result_1 materializes. Pins
    // the full chain (window -> LiveProvider dispatch -> OpenaiProvider HTTP ->
    // SQL execution -> materialization) the unit tests cannot reach end-to-end.
    let mut server = mockito::Server::new();
    let _mock = server
        .mock("POST", "/chat/completions")
        .with_status(200)
        .with_body(openai_body(
            r#"{"type":"sql","sql":"SELECT COUNT(*) AS n FROM \"people\".data","viz":null,"assumption":null}"#,
        ))
        .create();

    let provider = openai_live_provider(server.url(), Some("sk-test"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    let people = fixtures_dir().join("people.csv");
    match session.ingest(&people) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected people.csv to load, got {other:?}"),
    }

    let outcome = session.ask("多少人");
    match outcome {
        TurnOutcome::Materialized { dataset, sql, .. } => {
            assert_eq!(dataset.reference_name, "result_1");
            assert_eq!(dataset.row_count, 1, "COUNT(*) yields one row");
            assert!(
                sql.as_deref().unwrap_or("").contains("COUNT(*)"),
                "executed SQL carried: {sql:?}"
            );
            // The count cell is the people.csv row count (5 data rows).
            assert_eq!(
                dataset.sample.first().and_then(|r| r.first()),
                Some(&"5".to_string())
            );
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
}

#[test]
fn live_provider_routes_openai_profile_end_to_end() {
    // The production wiring point (LiveProvider::new at commands.rs) dispatches
    // by protocol() each turn. A StaticConfig with protocol:Openai must route
    // the turn to OpenaiProvider -- the HTTP call lands at
    // {base}/chat/completions with Bearer auth, NOT {base}/v1/messages with
    // x-api-key. Only the openai path is mocked and matched on the Bearer
    // header; an anthropic dispatch would miss the mock (404) and fail the
    // turn. _mock.assert() is the routing proof.
    let mut server = mockito::Server::new();
    let _mock = server
        .mock("POST", "/chat/completions")
        .match_header("authorization", "Bearer sk-test")
        .with_status(200)
        .with_body(openai_body(
            r#"{"type":"sql","sql":"SELECT COUNT(*) AS n FROM \"people\".data","viz":null,"assumption":null}"#,
        ))
        .create();

    let provider = openai_live_provider(server.url(), Some("sk-test"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    let people = fixtures_dir().join("people.csv");
    match session.ingest(&people) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected people.csv to load, got {other:?}"),
    }

    let outcome = session.ask("多少人");
    match outcome {
        TurnOutcome::Materialized { .. } => {}
        other => panic!("expected Materialized, got {other:?}"),
    }
    // The openai endpoint was hit (Bearer auth + /chat/completions); an
    // anthropic dispatch would have missed this mock and 404'd.
    _mock.assert();
}
