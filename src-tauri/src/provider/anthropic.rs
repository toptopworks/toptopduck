//! Real LLM provider: Anthropic Messages API over the native protocol
//! (ADR-0007/0019, issue #29). Replaces the offline fake as the production
//! provider; the fake stays for deterministic offline tests (ADR-0007 shared
//! test base -- never deleted).
//!
//! What this module owns:
//! - the ONLY network egress surface in the app (ADR-0029 invariant 1): the
//!   Rust core places the HTTP call, attaches the key from the keychain, and
//!   returns only the parsed reply -- the webview has no HTTP path and no key;
//! - the capability-boundary system prompt + per-turn schema context
//!   (ADR-0017/0011), assembled from [`crate::provider::prompt`];
//! - the strict-JSON output contract (ADR-0009): the model returns one JSON
//!   object; this module parses it into [`ProviderReply`] or yields a retried
//!   [`ProviderError::Unavailable`] on any malformed/transport outcome.
//!
//! Cancellation contract (blocking ureq + `spawn_blocking` + post-call flag
//! check, ADR-0021) is documented on [`AnthropicProvider::generate`].

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::provider::keychain::ProviderConfigSource;
use crate::provider::prompt::{
    build_system_prompt, render_response, render_summary_turn_note, Message,
};
use crate::provider::reply::parse_reply;
use crate::provider::{ProviderError, ProviderReply, ProviderRequest, TurnPayload};

/// Anthropic Messages API protocol version header value (ADR-0019: native
/// Anthropic protocol). Pinned; bumped only when Anthropic ships a breaking
/// revision the v1 contract relies on.
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Cap on the model's reply length. Sized for a SQL + a Vega-Lite spec + an
/// assumption note (a viz spec can run long); bounded so a runaway reply never
/// balloons. Not a user-facing cap (the engine result-row cap, ADR-0005 L3,
/// governs materialized size -- this bounds only the model's text).
const MAX_TOKENS: u32 = 4096;

/// Wall-clock ceiling on one LLM HTTP call. Bounds a hung call so the cancel
/// path eventually lands: a cancel during the (blocking) call is only seen
/// after the call returns, so this timeout is the backstop. Maps to a retried
/// [`ProviderError::Unavailable`] on expiry (transient), not a hard failure.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// The Anthropic Messages API translation layer (ADR-0007). Stateless (issue
/// #159): each [`Self::generate`] call borrows a [`ProviderConfigSource`] for
/// per-turn key + endpoint + model + locale reads (live, no caching); tests
/// inject [`StaticConfig`], production wires [`LiveProvider`](super::LiveProvider)
/// holding a [`KeychainStore`](super::keychain::KeychainStore). Never
/// instantiated -- the unit struct is a namespace for the [`Self::generate`]
/// associated function invoked by the router per dispatch.
pub struct AnthropicProvider;

impl AnthropicProvider {
    /// Place one Anthropic Messages API call (ADR-0019 native protocol). Reads
    /// the key + endpoint + model + locale from `config` per call (live, no
    /// caching); blocking HTTP (ureq) fits the sync caller contract -- the
    /// orchestrator runs `ask` on a `spawn_blocking` thread (ADR-0021), so no
    /// async runtime is pulled in and the turn stays cancellable at the
    /// flag-check between attempts.
    pub fn generate(
        config: &dyn ProviderConfigSource,
        request: &ProviderRequest,
    ) -> Result<ProviderReply, ProviderError> {
        // ADR-0029 invariant 3: the key is fetched here, in the Rust core, per
        // turn. Absent key -> NotWired (permanent for this turn, not retried) --
        // the orchestrator surfaces it as a failed turn prompting configuration.
        let key = config.api_key().ok_or(ProviderError::NotWired)?;
        let base_url = config.base_url();
        // AC #244: reject a non-http/https base_url (file:, data:, scheme-less)
        // at the boundary before any request is built. Surfaced as Unavailable
        // (the reason carries the http/https policy) so the diagnosis is
        // readable; NotWired would drop the detail.
        super::http::parse_http_base_url(&base_url)
            .map_err(|e| ProviderError::Unavailable(e.to_string()))?;
        let model = config.model();
        let url = format!("{base}/v1/messages", base = base_url.trim_end_matches('/'));

        // ADR-0052 (issue #78): assemble the system prompt via the shared
        // build_system_prompt so the locale directive is always inserted between
        // the canonical boundary prompt and the schema context. The locale is
        // read from the config source (resolved in Rust, never in ProviderRequest
        // / never pushed by the frontend).
        let system = build_system_prompt(request, config.locale());
        let body = AnthropicRequest {
            model: &model,
            max_tokens: MAX_TOKENS,
            system,
            messages: build_messages(request),
        };
        // serde_json::to_value only fails on non-finite floats / depth limits;
        // our body is plain strings, so this is defensive.
        let body_value = serde_json::to_value(&body).map_err(|e| {
            ProviderError::Unavailable(format!("request serialization failed: {e}"))
        })?;

        // AC #244: the shared egress agent disables redirect-following, so a
        // 3xx Location pointing at a second host can never carry x-api-key
        // off-host. ureq's default agent follows up to 5 redirects and strips
        // only `authorization`/`cookie` on each hop -- `x-api-key` would
        // survive and land on the redirect target.
        let response = super::http::egress_agent()
            .post(&url)
            .set("x-api-key", &key)
            .set("anthropic-version", ANTHROPIC_VERSION)
            .timeout(REQUEST_TIMEOUT)
            .send_json(body_value);

        let response = match response {
            Ok(r) => r,
            Err(ureq::Error::Status(status, resp)) => {
                // Auth rejected (bad/missing key seen by the server, or
                // forbidden): permanent for this turn -- map to NotWired so it
                // is NOT retried (three 401s would only burn time). The user
                // sees a configure-key prompt via the NotWired message.
                if status == 401 || status == 403 {
                    return Err(ProviderError::NotWired);
                }
                // Any other HTTP status (5xx overloaded, or a 4xx payload
                // rejection): surface the upstream body so the user sees WHY
                // (e.g. Anthropic's overloaded_error, model_not_found) instead
                // of a bare status code. Transient/retryable -- the orchestrator
                // consumes the single retry budget, then fails. reply::truncate
                // bounds the server-controlled string and its CJK-safe floor
                // keeps this panic-free.
                let body = resp.into_string().unwrap_or_default();
                return Err(ProviderError::Unavailable(format!(
                    "LLM call failed (HTTP {status}): {}",
                    crate::provider::reply::truncate(&body)
                )));
            }
            // Transport error (DNS / TCP / TLS / timeout): transient/retryable.
            Err(e) => {
                return Err(ProviderError::Unavailable(format!("LLM call failed: {e}")));
            }
        };

        let raw: RawResponse = response
            .into_json()
            .map_err(|e| ProviderError::Unavailable(format!("response read failed: {e}")))?;
        // The model's JSON contract rides the first text block. We send no
        // `tools` field (ADR-0064 bare-prompt contract), so Anthropic should
        // not emit tool-use blocks; a missing text block is a contract
        // violation -> retried Unavailable.
        let text = raw
            .content
            .iter()
            .find_map(|b| (b.kind == "text").then(|| b.text.clone()).flatten())
            .ok_or_else(|| ProviderError::Unavailable("LLM response has no text content".into()))?;
        parse_reply(&text)
    }
}

/// The Anthropic Messages API request body (ADR-0019 native protocol). `system`
/// carries the capability-boundary prompt + schema context; `messages` carries
/// the windowed conversation as alternating user/assistant turns ending on the
/// asking question.
#[derive(Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: String,
    messages: Vec<Message>,
}

/// Minimal Anthropic response shape -- only the `content` array is read. Extra
/// fields (id, model, usage, stop_reason) are ignored by serde.
#[derive(Deserialize)]
struct RawResponse {
    content: Vec<RawBlock>,
}

#[derive(Deserialize)]
struct RawBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
}

/// Build the Anthropic messages array from the windowed payload: each prior
/// turn becomes a user (its question) + assistant (its rendered response) pair,
/// oldest first; the asking question is the final user turn. Roles strictly
/// alternate (Anthropic requires it), and the first message is always `user`.
fn build_messages(request: &ProviderRequest) -> Vec<Message> {
    let mut msgs = Vec::with_capacity(request.history.len() * 2 + 1);
    for turn in &request.history {
        match turn {
            TurnPayload::Full { question, response } => {
                msgs.push(Message {
                    role: "user",
                    content: question.clone(),
                });
                msgs.push(Message {
                    role: "assistant",
                    content: render_response(response),
                });
            }
            TurnPayload::Summary {
                question_excerpt,
                result,
            } => {
                // A far-window turn (ADR-0039): only the verbatim question
                // excerpt + whether it produced a result ride; no SQL/schema.
                msgs.push(Message {
                    role: "user",
                    content: question_excerpt.clone(),
                });
                let note = render_summary_turn_note(result);
                msgs.push(Message {
                    role: "assistant",
                    content: note,
                });
            }
        }
    }
    msgs.push(Message {
        role: "user",
        content: request.question.clone(),
    });
    msgs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ChartKind, Protocol, TextKind};
    use crate::provider::keychain::StaticConfig;
    use crate::provider::prompt::ResponseLocale;
    use crate::provider::{ColumnRef, DatasetRef, ResponsePayload};

    /// Build a fixed config pointing at a mockito server URL (no OS keychain,
    /// no real network). Locale defaults to EnUS (the least-surprise fallback);
    /// tests that assert the locale directive use `config_at_locale`.
    fn config_at(url: &str, key: Option<&str>) -> StaticConfig {
        config_at_locale(url, key, ResponseLocale::EnUS)
    }

    /// Build a config with an explicit resolved locale (for the i18n directive
    /// assertions -- ADR-0052).
    fn config_at_locale(url: &str, key: Option<&str>, locale: ResponseLocale) -> StaticConfig {
        StaticConfig {
            key: key.map(str::to_string),
            base_url: url.to_string(),
            model: "claude-sonnet-4-6".to_string(),
            locale,
            protocol: Protocol::Anthropic,
        }
    }

    /// One minimal request with a dataset + active pointer.
    fn sample_request(question: &str) -> ProviderRequest {
        ProviderRequest {
            question: question.to_string(),
            history: Vec::new(),
            datasets: vec![DatasetRef {
                reference_name: "people".into(),
                sql_ref: r#""people".data"#.into(),
                columns: vec![ColumnRef {
                    name: Some("id".into()),
                    canonical_type: "BIGINT".into(),
                }],
                row_count: 3,
                sample: Some(vec![vec![Some("1".into())]]),
            }],
            active: Some("people".into()),
        }
    }

    /// Wrap a model JSON reply in the Anthropic response envelope.
    fn anthropic_body(model_json: &str) -> String {
        serde_json::json!({
            "content": [{"type": "text", "text": model_json}],
            "usage": {"input_tokens": 10, "output_tokens": 5},
        })
        .to_string()
    }

    #[test]
    fn parses_sql_reply_round_trip() {
        // AC: a real provider turns an Anthropic text envelope carrying the SQL
        // contract into ProviderReply::Sql verbatim.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-test")
            .with_status(200)
            .with_body(anthropic_body(
                r#"{"type":"sql","sql":"SELECT COUNT(*) AS n FROM \"people\".data","viz":null,"assumption":null}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        let reply =
            AnthropicProvider::generate(&cfg, &sample_request("多少行")).expect("sql reply");
        match reply {
            ProviderReply::Sql {
                sql,
                viz,
                assumption,
            } => {
                assert!(sql.contains("SELECT COUNT(*)"), "sql carried: {sql}");
                assert!(viz.is_none());
                assert!(assumption.is_none());
            }
            other => panic!("expected Sql, got {other:?}"),
        }
    }

    #[test]
    fn parses_sql_with_viz_and_assumption() {
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(anthropic_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":{"kind":"bar","spec":"{\"mark\":\"bar\"}"},"assumption":"regr_slope 斜率"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match AnthropicProvider::generate(&cfg, &sample_request("画图")).unwrap() {
            ProviderReply::Sql {
                sql,
                viz,
                assumption,
            } => {
                assert_eq!(sql, "SELECT 1");
                let v = viz.unwrap();
                assert_eq!(v.kind, ChartKind::Bar);
                assert_eq!(v.spec, "{\"mark\":\"bar\"}");
                assert_eq!(assumption.as_deref(), Some("regr_slope 斜率"));
            }
            other => panic!("expected Sql, got {other:?}"),
        }
    }

    #[test]
    fn parses_clarify_and_refuse_text_replies() {
        let mut server = mockito::Server::new();
        let _m1 = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(anthropic_body(
                r#"{"type":"text","kind":"clarify","body":"按哪个 name？","assumption":null}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match AnthropicProvider::generate(&cfg, &sample_request("汇总")).unwrap() {
            ProviderReply::Text { kind, body, .. } => {
                assert_eq!(kind, TextKind::Clarify);
                assert_eq!(body, "按哪个 name？");
            }
            other => panic!("expected clarify Text, got {other:?}"),
        }

        let mut server = mockito::Server::new();
        let _m2 = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(anthropic_body(
                r#"{"type":"text","kind":"refuse","body":"不做预测，可改为按季度汇总销量","assumption":"避开预测建模"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match AnthropicProvider::generate(&cfg, &sample_request("预测下季度")).unwrap() {
            ProviderReply::Text {
                kind,
                body,
                assumption,
            } => {
                assert_eq!(kind, TextKind::Refuse);
                assert!(body.contains("改为按季度"));
                assert_eq!(assumption.as_deref(), Some("避开预测建模"));
            }
            other => panic!("expected refuse Text, got {other:?}"),
        }
    }

    #[test]
    fn missing_key_is_not_wired() {
        // ADR-0029: no key -> NotWired (permanent, not retried), returned
        // BEFORE any HTTP call. Pointed at a bogus URL that would actively
        // refuse a connection: if the code path ever tried the network it would
        // surface an Unavailable (connect error), not NotWired -- so the
        // NotWired assertion proves no call was placed.
        let cfg = config_at("http://127.0.0.1:1", None);
        assert_eq!(
            AnthropicProvider::generate(&cfg, &sample_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn auth_rejected_is_not_retried_not_wired() {
        // A 401 is permanent for this turn: map to NotWired so the orchestrator
        // does not burn the retry budget on three identical auth failures.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(401)
            .with_body(r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-bad"));
        assert_eq!(
            AnthropicProvider::generate(&cfg, &sample_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn forbidden_403_is_not_retried_not_wired() {
        // A 403 is permanent for this turn (forbidden scope / IP-style block):
        // the adapter maps it to NotWired, mirroring the 401 contract above, so
        // the orchestrator does not burn the retry budget on three identical
        // rejections. `_mock.assert()` pins that the HTTP path was actually
        // taken (rules out the missing-key short-circuit), and the NotWired
        // result pins that a regression dropping 403 from the auth-rejected
        // set would fail here.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(403)
            .with_body(r#"{"type":"error","error":{"type":"forbidden","message":"forbidden"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert_eq!(
            AnthropicProvider::generate(&cfg, &sample_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
        _mock.assert();
    }

    #[test]
    fn server_error_is_unavailable_for_retry() {
        // A 5xx (or transport error) is transient -> Unavailable, consumed by
        // the orchestrator's retry budget.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(503)
            .with_body(
                r#"{"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}"#,
            )
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match AnthropicProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(_)) => {}
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn malformed_reply_is_unavailable() {
        // Contract violations (missing type / not JSON) -> Unavailable (retried
        // then failed honestly). The orchestrator never silently invents SQL.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(anthropic_body("这不是 JSON"))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            AnthropicProvider::generate(&cfg, &sample_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn json_in_markdown_fence_still_parses() {
        // Defensive extraction tolerates a model that wrapped the JSON in a
        // ``` fence despite the instruction not to.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(anthropic_body(
                "```json\n{\"type\":\"sql\",\"sql\":\"SELECT 1\",\"viz\":null,\"assumption\":null}\n```",
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match AnthropicProvider::generate(&cfg, &sample_request("q")).unwrap() {
            ProviderReply::Sql { sql, .. } => assert_eq!(sql, "SELECT 1"),
            other => panic!("expected Sql, got {other:?}"),
        }
    }

    #[test]
    fn sends_model_system_and_question_in_body() {
        // The request carries the configured model, the capability-boundary
        // system prompt (incl. the data context), and the asking question.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-test")
            .match_header("anthropic-version", "2023-06-01")
            .match_body(mockito::Matcher::Regex(
                r#""model":"claude-sonnet-4-6""#.to_string(),
            ))
            .match_body(mockito::Matcher::Regex(r#""role":"user""#.to_string()))
            .with_status(200)
            .with_body(anthropic_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        AnthropicProvider::generate(&cfg, &sample_request("多少行")).expect("reply");
        _mock.assert(); // matched model + role + auth headers
    }

    #[test]
    fn system_prompt_carries_locale_directive_and_canonical_boundary() {
        // ADR-0052 (issue #78): the assembled system prompt must carry BOTH the
        // canonical boundary (layer 4, untouched) AND the locale directive
        // (layer 3). Match the body for the zh directive phrase + a canonical
        // landmark; the default EnUS provider is also asserted to carry its own
        // directive. This is the end-to-end proof the locale threads from the
        // config source through build_system_prompt into the HTTP body.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .match_body(mockito::Matcher::Regex("简体中文".to_string()))
            .match_body(mockito::Matcher::Regex("IN-SCOPE".to_string()))
            .with_status(200)
            .with_body(anthropic_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#,
            ))
            .create();
        let cfg = config_at_locale(&server.url(), Some("sk-test"), ResponseLocale::ZhCN);
        AnthropicProvider::generate(&cfg, &sample_request("画图")).expect("reply");
        _mock.assert();

        // The EnUS directive must also land when the resolved locale is EnUS.
        let mut server_en = mockito::Server::new();
        let _mock_en = server_en
            .mock("POST", "/v1/messages")
            .match_body(mockito::Matcher::Regex("U.S. English".to_string()))
            .with_status(200)
            .with_body(anthropic_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#,
            ))
            .create();
        let cfg_en = config_at_locale(&server_en.url(), Some("sk-test"), ResponseLocale::EnUS);
        AnthropicProvider::generate(&cfg_en, &sample_request("draw")).expect("reply");
        _mock_en.assert();
    }

    #[test]
    fn history_renders_as_alternating_user_assistant_messages() {
        // ADR-0023: a recent materialized prior turn ships as user(question) +
        // assistant(rendered response). Verify the rendered messages alternate.
        let request = ProviderRequest {
            question: "现在呢".into(),
            history: vec![TurnPayload::Full {
                question: "上一问".into(),
                response: ResponsePayload::Materialized {
                    result: "result_1".into(),
                    sql: Some("SELECT 1".into()),
                    assumption: None,
                },
            }],
            datasets: Vec::new(),
            active: None,
        };
        let msgs = build_messages(&request);
        let roles: Vec<&str> = msgs.iter().map(|m| m.role).collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
        assert_eq!(msgs.last().unwrap().content, "现在呢");
        // The prior response is rendered human-readable, naming its result.
        let assistant = &msgs[1].content;
        assert!(assistant.contains("result_1") && assistant.contains("SELECT 1"));
    }

    #[test]
    fn base_url_non_http_scheme_is_rejected_before_any_request() {
        // AC #244: a file:// (or other non-http/https) base_url is rejected at
        // the boundary -- no HTTP call is placed. A malicious or hand-edited
        // `file://` endpoint must never reach ureq. The error surfaces the
        // http/https policy so the diagnosis is readable; it routes to
        // Unavailable (a configuration fault surfaced with detail), not
        // NotWired (which drops the reason).
        let cfg = config_at("file:///etc/passwd", Some("sk-test"));
        match AnthropicProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(msg)) => assert!(
                msg.contains("http/https"),
                "scheme rejection surfaces the http/https policy: {msg}"
            ),
            other => panic!("expected Unavailable for bad scheme, got {other:?}"),
        }
    }

    #[test]
    fn does_not_forward_x_api_key_across_host_redirect() {
        // AC #244: a 3xx redirect to a SECOND host must NOT carry x-api-key.
        // ureq 2.12.1's built-in redirect cleanup strips only `authorization`
        // and `cookie` (unit.rs:221-225) -- x-api-key survives and would land
        // on the redirect target. A 302 downgrades POST -> GET (RFC 7231 /
        // ureq unit.rs:193-196), so the leaked request reaches the second host
        // as a GET to the same path carrying x-api-key -- this test asserts
        // that mock records zero hits (the shared egress agent disables
        // redirect-following, so the credential never travels past hop one).
        let mut first = mockito::Server::new();
        let mut second = mockito::Server::new();
        first
            .mock("POST", "/v1/messages")
            .with_status(302)
            .with_header("Location", &format!("{}/v1/messages", second.url()))
            .create();
        let second_leak = second
            .mock("GET", "/v1/messages")
            .match_header("x-api-key", "sk-secret")
            .expect(0)
            .with_status(200)
            .create();
        let cfg = config_at(&first.url(), Some("sk-secret"));
        // The turn fails (the 3xx surfaces raw under redirects(0); the body
        // parse then fails -> Unavailable). The assertion is the absence of a
        // cross-host x-api-key leak, not the call's success.
        let _ = AnthropicProvider::generate(&cfg, &sample_request("q"));
        second_leak.assert();
    }
}
