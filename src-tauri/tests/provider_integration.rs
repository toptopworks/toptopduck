//! Real-provider integration (issue #29, ADR-0007/0029; rewired onto the
//! yoagent loop by ADR-0107 / issue #669): wires a LiveProvider into a
//! Session and drives one ask -> tool-call -> materialize turn against a
//! mockito server standing in for the configured provider. Both protocols
//! are covered -- Anthropic (issue #29) and OpenAI (issue #160), each
//! exercising its REAL upstream stream client (the provider construction
//! sealed inside session::yoagent, selected per protocol by the wiring
//! seam), so the wire format is the upstream one: SSE streams on both
//! protocols (`"stream": true`), which the fixtures below render. Verifies
//! the full chain the unit tests cannot -- window assembly -> the upstream
//! stateless loop -> native tool-calling HTTP round-trips -> tool dispatch
//! -> result_N materialization (ADR-0077/0081, issue #318) -- without a
//! network or a real key.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use toptopduck_lib::{
    CancelToken, LiveProvider, LoadOutcome, Protocol, ProviderConfigSource, ResponseLocale,
    Session, StaticConfig, TurnFailure, TurnOutcome,
};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

/// The materialize SQL the scripted model emits, verbatim -- the source's
/// sql_ref fragment, exactly as the system prompt asks.
const COUNT_SQL: &str = r#"SELECT COUNT(*) AS n FROM "people".data"#;

/// Render named SSE events: `event: <name>\ndata: <json>\n\n` per event --
/// the framing the upstream anthropic / openai-compat stream clients parse
/// (reqwest-eventsource). The `data` payloads are built with `json!` so the
/// nested SQL string is escaped once, correctly.
fn sse(events: &[(&str, serde_json::Value)]) -> String {
    events
        .iter()
        .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
        .collect()
}

/// The Anthropic SSE stream asking the app to materialize [`COUNT_SQL`]
/// (first round-trip): a tool_use block whose arguments arrive as one
/// `input_json_delta`, closed by `content_block_stop` (where the upstream
/// parser resolves the accumulated buffer into the call's arguments) and a
/// `tool_use` stop reason. `leading` block events (start/stop pairs) ride
/// ahead of the tool_use block, which then takes index `leading.len()` --
/// the redacted-thinking pin fronts the stream this way.
fn anthropic_tool_use_body_with_leading(leading: &[(&str, serde_json::Value)]) -> String {
    let partial = serde_json::json!({"sql": COUNT_SQL}).to_string();
    let tool_index = leading.len();
    let mut events: Vec<(&str, serde_json::Value)> = vec![(
        "message_start",
        serde_json::json!({"type": "message_start"}),
    )];
    events.extend_from_slice(leading);
    events.extend([
        (
            "content_block_start",
            serde_json::json!({
                "type": "content_block_start", "index": tool_index,
                "content_block": {"type": "tool_use", "id": "tu_1", "name": "materialize", "input": {}},
            }),
        ),
        (
            "content_block_delta",
            serde_json::json!({
                "type": "content_block_delta", "index": tool_index,
                "delta": {"type": "input_json_delta", "partial_json": partial},
            }),
        ),
        (
            "content_block_stop",
            serde_json::json!({"type": "content_block_stop", "index": tool_index}),
        ),
        (
            "message_delta",
            serde_json::json!({
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use"},
                "usage": {"output_tokens": 10},
            }),
        ),
        ("message_stop", serde_json::json!({"type": "message_stop"})),
    ]);
    sse(&events)
}

fn anthropic_tool_use_body() -> String {
    anthropic_tool_use_body_with_leading(&[])
}

/// The Anthropic SSE terminal-text stream ending the turn (second
/// round-trip): one text block's `text_delta` and an `end_turn` stop reason.
fn anthropic_text_body(text: &str) -> String {
    sse(&[
        (
            "message_start",
            serde_json::json!({"type": "message_start"}),
        ),
        (
            "content_block_start",
            serde_json::json!({
                "type": "content_block_start", "index": 0,
                "content_block": {"type": "text", "text": ""},
            }),
        ),
        (
            "content_block_delta",
            serde_json::json!({
                "type": "content_block_delta", "index": 0,
                "delta": {"type": "text_delta", "text": text},
            }),
        ),
        (
            "content_block_stop",
            serde_json::json!({"type": "content_block_stop", "index": 0}),
        ),
        (
            "message_delta",
            serde_json::json!({
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn"},
                "usage": {"output_tokens": 10},
            }),
        ),
        ("message_stop", serde_json::json!({"type": "message_stop"})),
    ])
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

/// The OpenAI chat-completions SSE stream asking the app to materialize
/// [`COUNT_SQL`] (first round-trip): the function call arrives as a
/// `delta.tool_calls` entry (arguments as a JSON string), closed by
/// `finish_reason: "tool_calls"` and the `[DONE]` sentinel.
fn openai_tool_calls_body() -> String {
    let arguments = serde_json::json!({ "sql": COUNT_SQL }).to_string();
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        serde_json::json!({
            "id": "chatcmpl-1", "object": "chat.completion.chunk",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "tool_calls": [{
                    "index": 0, "id": "tu_1", "type": "function",
                    "function": {"name": "materialize", "arguments": arguments},
                }]},
                "finish_reason": null,
            }],
        }),
        serde_json::json!({
            "id": "chatcmpl-1", "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
        }),
    )
}

/// The OpenAI terminal-text SSE stream ending the turn (second round-trip).
fn openai_text_body(text: &str) -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        serde_json::json!({
            "id": "chatcmpl-1", "object": "chat.completion.chunk",
            "choices": [{
                "index": 0,
                "delta": {"role": "assistant", "content": text},
                "finish_reason": null,
            }],
        }),
        serde_json::json!({
            "id": "chatcmpl-1", "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        }),
    )
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
        .with_header("content-type", "text/event-stream")
        .with_body(anthropic_text_body("共 5 人"))
        .create();
    let tool_mock = server
        .mock("POST", "/v1/messages")
        .expect(1)
        .with_status(200)
        .with_header("content-type", "text/event-stream")
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
    // HTTP round-trip lands the turn as Cancelled. Under the yoagent loop
    // (ADR-0107, which calibrates ADR-0021 for the built-in path) the cancel
    // is immediate: the wiring seam's watcher maps the app token onto the
    // upstream task token, which aborts the in-flight SSE read mid-stream --
    // no soft-cancel wait for the HTTP call to run to completion. This
    // exercises the real HTTP path, which the non-blocking FakeProvider
    // cannot represent.
    let mut server = mockito::Server::new();
    let body = Arc::new(anthropic_tool_use_body());
    let body_for_mock = Arc::clone(&body);
    // Slow response: the first round-trip blocks ~1s on the HTTP read, giving
    // cancel a wide window to land mid-call even on a slow CI.
    let _mock = server
        .mock("POST", "/v1/messages")
        .with_status(200)
        .with_header("content-type", "text/event-stream")
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

    let started = Instant::now();
    let handle = thread::spawn(move || session.ask("多少人"));
    // Let ask enter the blocking provider call, then fire cancel mid-call.
    thread::sleep(Duration::from_millis(300));
    cancel.request();

    let outcome = handle.join().expect("ask thread panicked");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "soft cancel during HTTP block should land Cancelled: got {outcome:?}"
    );
    // Immediacy (ADR-0107): the watcher aborts the in-flight SSE read
    // instead of waiting the HTTP call out, so the turn lands well under
    // the 1s the blocked read takes. 900ms bounds the happy path (300ms
    // cancel + the 25ms watcher poll + overhead) with slack for a slow CI
    // runner; a dead watcher would read the stream out at ~1.3s.
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "cancel should land immediately mid-read, took {:?}",
        started.elapsed()
    );
}

#[test]
fn real_openai_provider_end_to_end_materializes_result() {
    // End-to-end on the OpenAI protocol (issue #160): the facts feed the
    // upstream construction, which POSTs {base}/chat/completions with Bearer
    // auth (matched here -- an anthropic dispatch would hit /v1/messages with
    // x-api-key, miss the mock, 404), the model emits a
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
        .with_header("content-type", "text/event-stream")
        .with_body(openai_text_body("共 5 人"))
        .create();
    let tool_mock = server
        .mock("POST", "/chat/completions")
        .match_header("authorization", "Bearer sk-test")
        .expect(1)
        .with_status(200)
        .with_header("content-type", "text/event-stream")
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

/// Issue #668 tail item 1, verified on the wire (issue #669): a
/// `redacted_thinking` block in the model's reply. The upstream anthropic
/// stream client has NO redacted variant (its content-block enum carries
/// text / thinking / tool_use only), so the block is silently dropped at
/// parse time -- the turn survives, the tool batch executes, and nothing
/// rides the re-feed. That is a known equivalence gap against the retired
/// self-written adapter (which re-fed redacted blocks verbatim as
/// `redacted_thinking`), upstream-owned and tracked with the minor-gated
/// `yoagent = "0.18"` pin: this pin exists so a future upstream variant
/// surface CHANGES this test's observable (the block would start landing)
/// rather than silently half-working.
#[test]
fn anthropic_redacted_thinking_block_is_dropped_but_the_turn_survives() {
    let mut server = mockito::Server::new();
    let text_mock = server
        .mock("POST", "/v1/messages")
        .match_body(mockito::Matcher::Regex("tool_result".into()))
        .expect(1)
        .with_status(200)
        .with_header("content-type", "text/event-stream")
        .with_body(anthropic_text_body("done"))
        .create();
    // A redacted_thinking block (index 0) ahead of the tool_use block
    // (index 1): what the real API emits under a safety intervention.
    let tool_with_redacted = anthropic_tool_use_body_with_leading(&[
        (
            "content_block_start",
            serde_json::json!({
                "type": "content_block_start", "index": 0,
                "content_block": {"type": "redacted_thinking", "data": "opaque-payload"},
            }),
        ),
        (
            "content_block_stop",
            serde_json::json!({"type": "content_block_stop", "index": 0}),
        ),
    ]);
    let tool_mock = server
        .mock("POST", "/v1/messages")
        .expect(1)
        .with_status(200)
        .with_header("content-type", "text/event-stream")
        .with_body(tool_with_redacted)
        .create();

    let provider = anthropic_live_provider(server.url(), Some("sk-test"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    let people = fixtures_dir().join("people.csv");
    match session.ingest(&people) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected people.csv to load, got {other:?}"),
    }

    // The dropped block does not break the turn: the tool batch executes,
    // result_1 promotes, the terminal text lands.
    let outcome = session.ask("多少人");
    assert!(
        matches!(outcome, TurnOutcome::Materialized { .. }),
        "got {outcome:?}"
    );
    tool_mock.assert();
    text_mock.assert();
}

/// Spec axis gap (issue #669 AC2): the failure case on the OpenAI wire. A
/// 401 from the chat-completions endpoint classifies as an auth fault
/// upstream (`ProviderError::Auth`), which the loop's terminal derivation
/// reads back as NotWired -- the same configure-key signal the anthropic
/// protocol surfaces, proving the fault classification is protocol-shared.
#[test]
fn openai_auth_rejection_yields_not_wired() {
    let mut server = mockito::Server::new();
    let _mock = server
        .mock("POST", "/chat/completions")
        .match_header("authorization", "Bearer wrong-key")
        .with_status(401)
        .with_header("content-type", "application/json")
        .with_body(r#"{"error": {"message": "invalid api key", "type": "invalid_request_error"}}"#)
        .create();

    let provider = openai_live_provider(server.url(), Some("wrong-key"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    let outcome = session.ask("anything");
    assert!(
        matches!(outcome, TurnOutcome::Failed(TurnFailure::NotWired)),
        "a 401 lands as the configure-key signal, got {outcome:?}"
    );
    _mock.assert();
}

/// Spec axis gap (issue #669 AC2): the cancel case on the OpenAI wire --
/// mid-stream abort on the second protocol, mirroring the anthropic cancel
/// pin: the cancel watcher maps the app token onto the upstream task token,
/// which aborts the in-flight SSE read.
#[test]
fn openai_cancel_during_http_block_lands_cancelled() {
    let mut server = mockito::Server::new();
    let body = Arc::new(openai_tool_calls_body());
    let body_for_mock = Arc::clone(&body);
    let _mock = server
        .mock("POST", "/chat/completions")
        .with_status(200)
        .with_header("content-type", "text/event-stream")
        .with_chunked_body(move |w| {
            thread::sleep(Duration::from_millis(1000));
            w.write_all(body_for_mock.as_bytes())
        })
        .create();

    let cancel = Arc::new(CancelToken::new());
    let provider = openai_live_provider(server.url(), Some("sk-test"));
    let mut session = Session::with_provider_and_cancel(Box::new(provider), Arc::clone(&cancel))
        .expect("session");

    let people = fixtures_dir().join("people.csv");
    match session.ingest(&people) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected people.csv to load, got {other:?}"),
    }

    let started = Instant::now();
    let handle = thread::spawn(move || session.ask("多少人"));
    thread::sleep(Duration::from_millis(300));
    cancel.request();

    let outcome = handle.join().expect("ask thread panicked");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "mid-stream cancel on the openai wire lands Cancelled: got {outcome:?}"
    );
    // Immediacy, mirroring the anthropic pin: the watcher aborts the
    // in-flight SSE read, so the turn lands well under the 1s the blocked
    // read takes (900ms bounds the happy path with slack for a slow CI
    // runner).
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "cancel should land immediately mid-read, took {:?}",
        started.elapsed()
    );
}

/// A config source whose `protocol` can be flipped between turns (via the
/// shared `Arc<Mutex>`), so the per-turn freshness of the swapped loop can
/// be pinned on the wire. All other fields are fixed; derives `Clone`
/// sharing the protocol cell so the test can hand a copy to the
/// `LiveProvider` and still flip the protocol afterward.
#[derive(Clone)]
struct FlippableConfig {
    base_url: String,
    protocol: Arc<Mutex<Protocol>>,
}

impl ProviderConfigSource for FlippableConfig {
    fn api_key(&self) -> Option<String> {
        Some("sk-test".into())
    }
    fn base_url(&self) -> String {
        self.base_url.clone()
    }
    fn model(&self) -> String {
        "m".into()
    }
    fn locale(&self) -> ResponseLocale {
        ResponseLocale::EnUS
    }
    fn protocol(&self) -> Protocol {
        *self
            .protocol
            .lock()
            .expect("flippable protocol mutex poisoned")
    }
}

/// Per-turn profile freshness on the swapped loop (ADR-0107, issue #669):
/// a protocol switch between two turns of the SAME Session reroutes the
/// second turn to the other upstream streamer -- the wiring seam reads
/// `turn_model_facts` fresh each turn and rebuilds the streamer from it,
/// so a mid-session profile switch lands the very next turn. A layer that
/// cached the resolution (at Session construction or the first ask) would
/// send both turns to one endpoint and miss the other mock. The wire-level
/// mirror of `re_reads_protocol_per_turn_not_cached_at_construction` (the
/// single-shot generate path's pin, in the provider unit tests).
#[test]
fn a_protocol_switch_between_turns_reroutes_the_next_turn() {
    let mut server = mockito::Server::new();
    let anthropic_mock = server
        .mock("POST", "/v1/messages")
        .expect(1)
        .with_status(200)
        .with_header("content-type", "text/event-stream")
        .with_body(anthropic_text_body("第一回合完成"))
        .create();
    let openai_mock = server
        .mock("POST", "/chat/completions")
        .expect(1)
        .with_status(200)
        .with_header("content-type", "text/event-stream")
        .with_body(openai_text_body("第二回合完成"))
        .create();

    let config = FlippableConfig {
        base_url: server.url(),
        protocol: Arc::new(Mutex::new(Protocol::Anthropic)),
    };
    let provider = LiveProvider::new(config.clone());
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    // Turn 1: the anthropic facts construct the anthropic streamer; a
    // textual turn needs no fixture, only the one round-trip.
    match session.ask("第一回合") {
        TurnOutcome::Textual { .. } => {}
        other => panic!("expected Textual, got {other:?}"),
    }
    // The profile switch: flip the protocol between turns of one Session.
    *config
        .protocol
        .lock()
        .expect("flippable protocol mutex poisoned") = Protocol::Openai;
    // Turn 2 must resolve through the fresh facts and hit the openai wire.
    match session.ask("第二回合") {
        TurnOutcome::Textual { .. } => {}
        other => panic!("expected Textual, got {other:?}"),
    }
    anthropic_mock.assert();
    openai_mock.assert();
}

// --- cross-host redirect credential pins (issue #696) -----------------------
//
// The probe path has its own redirect pin (`egress_agent_does_not_follow_
// cross_host_redirect` in provider::http, the shared ureq agent with
// redirects disabled). The PRODUCTION turn path instead rides the upstream
// yoagent HTTP client (reqwest + tower-http), whose redirect behavior this
// repo cannot configure -- `Client::new()` is constructed inside yoagent and
// the versions are held by the 0.18 minor pin. What the locked stack
// actually does on a 301, verified against its sources and pinned here,
// splits by credential header: `authorization` is stripped on a cross-host
// hop (reqwest's `remove_sensitive_headers`), so the openai bearer face is
// safe and pinned as such; `x-api-key` is NOT on the strip list, and
// tower-http rewrites a 301'd POST into a GET (RFC 7231), so the
// anthropic face's key IS delivered to the redirect host as a GET. That
// exposure is inherent to the pinned upstream versions; the anthropic pin
// asserts the delivery so an upstream fix flips it red and the assertion
// can tighten back to zero. Both faces additionally pin the honest turn
// failure, and each redirect mock matches only when the first hop actually
// carried the credential -- a redirect served without the key on board pins
// nothing. `127.0.0.1` and `localhost` are distinct hosts for the client's
// cross-origin judgment, so two mockito servers + a rewritten Location give
// a true cross-host hop without a network.

/// Wire the two mockito hosts for one protocol's API path (`/v1/messages`
/// for anthropic, `/chat/completions` for openai-compat): `first` 301-
/// redirects that endpoint to `second` under the `localhost` host name.
/// The redirect mock matches only when the request carries the face's
/// credential header -- the falsifiable premise that the first hop had the
/// key on board, without which the sentinels below would pin nothing.
/// Returns `second` unmocked; each caller registers the sentinels its face
/// can genuinely violate.
fn redirect_hosts(
    api_path: &str,
    credential_header: &str,
) -> (mockito::ServerGuard, mockito::ServerGuard, mockito::Mock) {
    let mut first = mockito::Server::new();
    let second = mockito::Server::new();
    // Same port, different host name: a genuine cross-host redirect target.
    let cross_host = second.url().replacen("127.0.0.1", "localhost", 1);
    let redirect = first
        .mock("POST", api_path)
        .match_header(credential_header, mockito::Matcher::Any)
        .expect_at_least(1)
        .with_status(301)
        .with_header("Location", &format!("{cross_host}{api_path}"))
        .create();
    (first, second, redirect)
}

/// One leak sentinel on `second`: a mock that matches ONLY when a request
/// spelled with `method` carries the named credential header. tower-http
/// rewrites the 301'd POST into a GET, so both method spellings must be
/// watched separately -- mockito's method match is exact and takes no
/// wildcard. The caller sets `expect` (or `expect_at_least`) and `create`s.
fn leak_sentinel(
    second: &mut mockito::ServerGuard,
    method: &str,
    api_path: &str,
    header: &str,
) -> mockito::Mock {
    second
        .mock(method, api_path)
        .match_header(header, mockito::Matcher::Any)
        .with_status(200)
        .with_body("{}")
}

/// The anthropic face (the app's default protocol): the cross-host 301
/// delivery is pinned as the locked upstream stack actually behaves. The
/// key rides `x-api-key`, which reqwest does not strip cross-host, and
/// tower-http rewrites the POST into a GET -- so the GET sentinel asserts
/// the delivery (an accepted exposure inherent to the pinned versions; an
/// upstream fix flips this red and the assertion tightens back to zero),
/// while the POST sentinel asserts the delivery stays GET-shaped. The turn
/// fails honestly either way.
#[test]
fn anthropic_turn_path_cross_host_redirect_x_api_key_delivery_is_pinned() {
    let (first, mut second, redirect) = redirect_hosts("/v1/messages", "x-api-key");
    let api_key_get = leak_sentinel(&mut second, "GET", "/v1/messages", "x-api-key")
        .expect_at_least(1)
        .create();
    let api_key_post = leak_sentinel(&mut second, "POST", "/v1/messages", "x-api-key")
        .expect(0)
        .create();
    let provider = anthropic_live_provider(first.url(), Some("sk-secret-redirect"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    match session.ask("redirect probe") {
        TurnOutcome::Failed(_) => {}
        other => panic!("expected an honest Failed, got {other:?}"),
    }
    // The 301 was actually served with the key on board -- the pin is live.
    redirect.assert();
    api_key_get.assert();
    api_key_post.assert();
}

/// The openai face (Bearer auth): the bearer token rides `authorization`,
/// which reqwest strips on the cross-host hop -- neither method spelling of
/// the redirect target may ever see it, and the turn fails honestly.
#[test]
fn openai_turn_path_cross_host_redirect_does_not_leak_the_key() {
    let (first, mut second, redirect) = redirect_hosts("/chat/completions", "authorization");
    let bearer_get = leak_sentinel(&mut second, "GET", "/chat/completions", "authorization")
        .expect(0)
        .create();
    let bearer_post = leak_sentinel(&mut second, "POST", "/chat/completions", "authorization")
        .expect(0)
        .create();
    let provider = openai_live_provider(first.url(), Some("sk-secret-redirect"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    match session.ask("redirect probe") {
        TurnOutcome::Failed(_) => {}
        other => panic!("expected an honest Failed, got {other:?}"),
    }
    // The 301 was actually served with the token on board -- the pin is live.
    redirect.assert();
    bearer_get.assert();
    bearer_post.assert();
}
