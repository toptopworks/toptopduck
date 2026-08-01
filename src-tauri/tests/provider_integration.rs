//! Real-provider integration (issue #29, ADR-0007/0029): wires a LiveProvider
//! into a Session and drives one ask -> tool-call -> materialize turn against
//! a mockito server standing in for the configured provider. Both protocols
//! are covered -- Anthropic (issue #29) and OpenAI (issue #160), the latter
//! doubling as the LiveProvider protocol-routing proof. Verifies the full
//! chain the unit tests cannot -- window assembly -> native tool-calling HTTP
//! round-trips -> tool dispatch -> result_N materialization (ADR-0077/0081,
//! issue #318) -- without a network or a real key. The loop's behavior is
//! provider-agnostic (FakeProvider covers the contract offline); these tests
//! pin that the real adapters plug in correctly on the tool-calling path.

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

/// The materialize SQL the scripted model emits, verbatim -- the source's
/// sql_ref fragment, exactly as the system prompt asks.
const COUNT_SQL: &str = r#"SELECT COUNT(*) AS n FROM "people".data"#;

/// The Anthropic native tool-calling response asking the app to materialize
/// [`COUNT_SQL`] (first round-trip).
fn anthropic_tool_use_body() -> String {
    serde_json::json!({
        "content": [{
            "type": "tool_use",
            "id": "tu_1",
            "name": "materialize",
            "input": { "sql": COUNT_SQL },
        }]
    })
    .to_string()
}

/// The Anthropic terminal-text response ending the turn (second round-trip).
fn anthropic_text_body(text: &str) -> String {
    serde_json::json!({
        "content": [{"type": "text", "text": text}]
    })
    .to_string()
}

/// Wire a LiveProvider with an Anthropic-protocol StaticConfig pointing at
/// `url`. Only `key` varies across the integration tests; collapsing the
/// block here keeps the test bodies focused on the behavior under test.
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
/// Mirrors [`anthropic_live_provider`]; only the protocol field (and a
/// realistic openai-shaped model id) differ. Drives the openai end-to-end
/// test so its body stays focused on the behavior under test.
fn openai_live_provider(url: String, key: Option<&str>) -> LiveProvider<StaticConfig> {
    LiveProvider::new(StaticConfig {
        key: key.map(str::to_string),
        base_url: url,
        model: "gpt-4o".into(),
        locale: ResponseLocale::EnUS,
        protocol: Protocol::Openai,
    })
}

/// The OpenAI native function-calling response asking the app to materialize
/// [`COUNT_SQL`] (first round-trip). OpenAI encodes the tool input as a JSON
/// string under `function.arguments`.
fn openai_tool_calls_body() -> String {
    let arguments = serde_json::json!({ "sql": COUNT_SQL }).to_string();
    serde_json::json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "tool_calls": [{
                    "id": "tu_1",
                    "type": "function",
                    "function": { "name": "materialize", "arguments": arguments },
                }],
            }
        }]
    })
    .to_string()
}

/// The OpenAI terminal-text response ending the turn (second round-trip).
fn openai_text_body(text: &str) -> String {
    serde_json::json!({
        "choices": [{"message": {"role": "assistant", "content": text}}]
    })
    .to_string()
}

#[test]
fn real_provider_end_to_end_materializes_result() {
    let mut server = mockito::Server::new();
    // Two round-trips (ADR-0081): the model first emits a materialize
    // tool_use; the loop dispatches it against the engine, feeds the result
    // back, and the model ends the turn with a text answer. Each mock expects
    // exactly one hit so the sequence is deterministic; the text mock
    // additionally body-matches the fed-back tool_result so the pairing is
    // pinned both ways.
    let text_mock = server
        .mock("POST", "/v1/messages")
        .match_body(mockito::Matcher::Regex("tool_result".into()))
        .expect(1)
        .with_status(200)
        .with_body(anthropic_text_body("共 5 人"))
        .create();
    let tool_mock = server
        .mock("POST", "/v1/messages")
        .expect(1)
        .with_status(200)
        .with_body(anthropic_tool_use_body())
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
        TurnOutcome::Materialized {
            promotions,
            assumption,
            ..
        } => {
            assert_eq!(
                promotions.len(),
                1,
                "a single materialize call promotes exactly once"
            );
            let primary = &promotions[0];
            // The model's materialize call was dispatched and promoted result_1.
            assert_eq!(primary.dataset.reference_name, "result_1");
            assert_eq!(primary.dataset.row_count, 1, "COUNT(*) yields one row");
            assert!(
                primary.sql.contains("COUNT(*)"),
                "the promotion carries the model's SQL: {}",
                primary.sql
            );
            // The count cell is the people.csv row count (5 data rows).
            assert_eq!(
                primary.dataset.sample.first().and_then(|r| r.first()),
                Some(&"5".to_string())
            );
            // The terminal text answer rides the assumption side note.
            assert_eq!(assumption.as_deref(), Some("共 5 人"));
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
    tool_mock.assert();
    text_mock.assert();
}

#[test]
fn real_provider_missing_key_yields_failed_turn() {
    // ADR-0029/0044: with no key, the adapter returns NotWired on the first
    // round-trip. NotWired is permanent (no retry, no agent self-correction --
    // transport-level faults never reach the model, ADR-0077/0081), so the
    // turn lands as Failed immediately -- the user is prompted to configure a
    // key.
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
    // AC7 (ADR-0021/0028/0081): a cancel during the real provider's blocking
    // HTTP round-trip lands the turn as Cancelled -- the loop's post-call flag
    // check aborts the whole turn. The real path uses a blocking ureq client,
    // so this is a *soft* cancel -- the HTTP call runs to completion
    // (<= REQUEST_TIMEOUT), then the flag check discards the result (the
    // synchronous-client constraint recorded in ADR-0021). This exercises the
    // real HTTP path, which the non-blocking FakeProvider cannot represent.
    let mut server = mockito::Server::new();
    let body = Arc::new(anthropic_tool_use_body());
    let body_for_mock = Arc::clone(&body);
    // Slow response: the first round-trip blocks ~1s on the HTTP read, giving
    // cancel a wide window to land mid-call even on a slow CI.
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
    // End-to-end on the OpenAI protocol (issue #160): LiveProvider routes to
    // OpenaiProvider via protocol(), the adapter POSTs {base}/chat/completions
    // with Bearer auth (matched here -- an anthropic dispatch would hit
    // /v1/messages with x-api-key, miss the mock, 404), the model emits a
    // materialize function call, the loop dispatches it, and result_1
    // materializes on the terminal text round-trip. `match_header` +
    // `assert()` are the routing proof; the row_count / sample assertions are
    // the materialization proof.
    let mut server = mockito::Server::new();
    let text_mock = server
        .mock("POST", "/chat/completions")
        .match_header("authorization", "Bearer sk-test")
        .match_body(mockito::Matcher::Regex("tool_call_id".into()))
        .expect(1)
        .with_status(200)
        .with_body(openai_text_body("共 5 人"))
        .create();
    let tool_mock = server
        .mock("POST", "/chat/completions")
        .match_header("authorization", "Bearer sk-test")
        .expect(1)
        .with_status(200)
        .with_body(openai_tool_calls_body())
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
        TurnOutcome::Materialized {
            promotions,
            assumption,
            ..
        } => {
            assert_eq!(
                promotions.len(),
                1,
                "a single materialize call promotes exactly once"
            );
            let primary = &promotions[0];
            assert_eq!(primary.dataset.reference_name, "result_1");
            assert_eq!(primary.dataset.row_count, 1, "COUNT(*) yields one row");
            assert!(
                primary.sql.contains("COUNT(*)"),
                "the promotion carries the model's SQL: {}",
                primary.sql
            );
            // The count cell is the people.csv row count (5 data rows).
            assert_eq!(
                primary.dataset.sample.first().and_then(|r| r.first()),
                Some(&"5".to_string())
            );
            assert_eq!(assumption.as_deref(), Some("共 5 人"));
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
    // Routing proof: the openai endpoint was hit with Bearer auth on both
    // round-trips; an anthropic dispatch would have missed these mocks and
    // 404'd.
    tool_mock.assert();
    text_mock.assert();
}
