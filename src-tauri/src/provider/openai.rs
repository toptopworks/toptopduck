//! Real LLM provider: OpenAI Chat Completions API over the OpenAI-compatible
//! wire protocol (ADR-0064, issue #152). The second [`Provider`] adapter,
//! alongside [`super::anthropic::AnthropicProvider`]. A pure HTTP translation
//! layer -- it constructs the Chat Completions request shape, attaches Bearer
//! auth, reads `choices[0].message.content`, and reuses the shared
//! [`super::reply::parse_reply`] for the ADR-0009 bare-JSON contract. The
//! anthropic adapter is untouched; the two share only the protocol-agnostic
//! text contract ([`super::reply`] + [`super::prompt::render_response`]).
//!
//! Covers OpenAI direct / DeepSeek / GLM / Qwen / Ollama compatible endpoints:
//! the user points the profile's `base_url` at the endpoint (including its
//! version path segment, e.g. `https://api.openai.com/v1`), and this adapter
//! appends `/chat/completions` -- the path documented by OpenAI's Chat
//! Completions API -- so all five providers work with no per-provider special
//! case.
//!
//! The bare-prompt contract (ADR-0009) is unchanged from anthropic: no
//! tool-calling / function calling. The model emits one JSON object in its
//! text content; this adapter extracts that text and hands it to the shared
//! parser. (ADR-0064 known risk: weak models on the bare-JSON contract may
//! raise ADR-0028 retry rates; a per-model local tool-calling introduction is
//! deferred until a model's retry rate actually exceeds the threshold.)
//!
//! Cancellation contract (blocking ureq + `spawn_blocking` + post-call flag
//! check, ADR-0021) mirrors the anthropic adapter; see
//! [`super::anthropic::AnthropicProvider::generate`] for the rationale.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::provider::keychain::ProviderConfigSource;
use crate::provider::prompt::{
    build_system_prompt, render_response, render_summary_turn_note, Message,
};
use crate::provider::reply::parse_reply;
use crate::provider::{ProviderError, ProviderReply, ProviderRequest, TurnPayload};

/// Cap on the model's reply length (mirrors the anthropic adapter). Sized for a
/// SQL + a Vega-Lite spec + an assumption note; bounded so a runaway reply
/// never balloons. Not a user-facing cap (the engine result-row cap,
/// ADR-0005 L3, governs materialized size).
const MAX_TOKENS: u32 = 4096;

/// Wall-clock ceiling on one LLM HTTP call (mirrors the anthropic adapter).
/// Bounds a hung call so the cancel path eventually lands: a cancel during the
/// (blocking) call is only seen after the call returns, so this timeout is the
/// backstop. Maps to a retried [`ProviderError::Unavailable`] on expiry.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// The OpenAI Chat Completions translation layer (ADR-0064). Stateless (issue
/// #159): each [`Self::generate`] call borrows a [`ProviderConfigSource`] for
/// per-turn key + endpoint + model + locale reads (live, no caching); tests
/// inject [`StaticConfig`], production wires [`LiveProvider`](super::LiveProvider)
/// holding a [`KeychainStore`](super::keychain::KeychainStore). Same shape as
/// [`super::anthropic::AnthropicProvider`] -- never instantiated, the unit
/// struct is a namespace for the [`Self::generate`] associated function; the
/// difference from the anthropic adapter is purely the wire shape constructed
/// in [`Self::generate`].
pub struct OpenaiProvider;

impl OpenaiProvider {
    /// Place one OpenAI Chat Completions API call. Reads the key + endpoint +
    /// model + locale from `config` per call (live, no caching); blocking HTTP
    /// (ureq) fits the sync caller contract -- the orchestrator runs `ask` on a
    /// `spawn_blocking` thread (ADR-0021), so no async runtime is pulled in and
    /// the turn stays cancellable at the flag-check between attempts.
    pub fn generate(
        config: &dyn ProviderConfigSource,
        request: &ProviderRequest,
    ) -> Result<ProviderReply, ProviderError> {
        // ADR-0029 invariant 3: the key is fetched here, in the Rust core, per
        // turn. Absent key -> NotWired (permanent for this turn, not retried) --
        // the orchestrator surfaces it as a failed turn prompting configuration.
        let key = config.api_key().ok_or(ProviderError::NotWired)?;
        let base_url = config.base_url();
        let model = config.model();
        // The user's base_url carries any version path segment (e.g. `/v1`);
        // only `/chat/completions` (the path documented by OpenAI's Chat
        // Completions API) is appended, so GLM's `/api/paas/v4` and Qwen's
        // `/compatible-mode/v1` work with no special case.
        let url = format!(
            "{base}/chat/completions",
            base = base_url.trim_end_matches('/')
        );

        // ADR-0052 (issue #78): assemble the system prompt via the shared
        // build_system_prompt so the locale directive + canonical boundary +
        // schema context are identical to the anthropic adapter. The system
        // prompt rides the first message (role "system") per OpenAI convention.
        let system = build_system_prompt(request, config.locale());
        let body = OpenaiRequest {
            model: &model,
            max_tokens: MAX_TOKENS,
            messages: build_messages(request, system),
        };
        // serde_json::to_value only fails on non-finite floats / depth limits;
        // our body is plain strings, so this is defensive.
        let body_value = serde_json::to_value(&body).map_err(|e| {
            ProviderError::Unavailable(format!("request serialization failed: {e}"))
        })?;

        let response = ureq::post(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .timeout(REQUEST_TIMEOUT)
            .send_json(body_value);

        let response = match response {
            Ok(r) => r,
            Err(ureq::Error::Status(status, resp)) => {
                // Auth rejected (bad/missing key seen by the server, or
                // forbidden): permanent for this turn -- map to NotWired so it
                // is NOT retried (three 401s would only burn time). The user
                // sees a configure-key prompt via the NotWired message. Mirrors
                // the anthropic path (ADR-0044).
                if status == 401 || status == 403 {
                    return Err(ProviderError::NotWired);
                }
                // Any other HTTP status (5xx, or a 4xx payload/param rejection
                // such as model_not_found / context_length_exceeded): surface
                // the upstream body so the user sees WHY instead of a bare
                // status code. Transient/retryable -- the orchestrator consumes
                // the single retry budget, then fails. The body is a server-
                // controlled string; reply::truncate bounds it and its CJK-safe
                // floor keeps this panic-free.
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
        // The model's JSON contract rides the first choice's text content. Some
        // OpenAI-compatible gateways return HTTP 200 with an `error` envelope
        // (content_filter, quota, upstream fault) instead of `choices`; surface
        // that envelope first so the cause is diagnosable. A missing/empty
        // choices array with no error envelope is a contract violation ->
        // retried Unavailable.
        let text = raw
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content);
        let text = match text {
            Some(t) => t,
            None => match raw.error {
                Some(err) => {
                    return Err(ProviderError::Unavailable(format!(
                        "LLM returned error envelope: {}",
                        err.message.unwrap_or_else(|| "unknown error".into())
                    )));
                }
                None => {
                    return Err(ProviderError::Unavailable(
                        "LLM response has no text content".into(),
                    ));
                }
            },
        };
        parse_reply(&text)
    }
}

/// The OpenAI Chat Completions request body (ADR-0064 openai protocol). The
/// system prompt + schema context ride the first message (role "system");
/// `messages` carries the windowed conversation as the system message followed
/// by alternating user/assistant turns ending on the asking question.
#[derive(Serialize)]
struct OpenaiRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    messages: Vec<Message>,
}

/// Minimal OpenAI response shape -- `choices` plus an optional `error`
/// envelope. Extra fields (id, model, usage, finish_reason) are ignored by serde.
#[derive(Deserialize)]
struct RawResponse {
    #[serde(default)]
    choices: Vec<RawChoice>,
    /// Some OpenAI-compatible gateways return HTTP 200 with an error envelope
    /// (`{"error":{"message":...}}`) instead of `choices` -- content_filter,
    /// quota exhaustion, upstream model fault. Surfaced by the caller when
    /// choices is empty so the cause is diagnosable rather than a bare "no
    /// text content". Absent on a normal reply (ignored by serde).
    #[serde(default)]
    error: Option<RawError>,
}

/// The `error` object inside a 200-body error envelope (gateway-injected).
/// Only `message` is read; other fields (code, type) are ignored by serde.
#[derive(Deserialize)]
struct RawError {
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct RawChoice {
    message: RawMessage,
}

#[derive(Deserialize)]
struct RawMessage {
    /// The model's text reply. `None` when the server returned null (a
    /// tool-call-only / content-filtered response, which we never request) --
    /// treated as a contract violation by the caller.
    #[serde(default)]
    content: Option<String>,
}

/// Build the OpenAI messages array from the windowed payload: the system
/// prompt (capability boundary + locale directive + schema context) is the
/// FIRST message (role "system"), then each prior turn becomes a user (its
/// question) + assistant (its rendered response) pair, oldest first; the
/// asking question is the final user turn. After the system message, roles
/// strictly alternate user/assistant and the conversation ends on a user
/// turn. Unlike the anthropic adapter -- which carries the system prompt in
/// the request body's `system` field and starts `messages` with a user turn
/// -- OpenAI Chat Completions has no separate system field, so the system
/// prompt rides a leading role="system" message.
fn build_messages(request: &ProviderRequest, system: String) -> Vec<Message> {
    let mut msgs = Vec::with_capacity(request.history.len() * 2 + 2);
    msgs.push(Message {
        role: "system",
        content: system,
    });
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
    /// no real network), speaking the OpenAI protocol. Locale defaults to EnUS.
    fn config_at(url: &str, key: Option<&str>) -> StaticConfig {
        config_at_locale(url, key, ResponseLocale::EnUS)
    }

    /// Build a config with an explicit resolved locale (for the i18n directive
    /// assertions -- ADR-0052).
    fn config_at_locale(url: &str, key: Option<&str>, locale: ResponseLocale) -> StaticConfig {
        StaticConfig {
            key: key.map(str::to_string),
            base_url: url.to_string(),
            model: "gpt-4o".to_string(),
            locale,
            protocol: Protocol::Openai,
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

    /// Wrap a model JSON reply in the OpenAI Chat Completions response envelope.
    fn openai_body(model_json: &str) -> String {
        serde_json::json!({
            "choices": [{"message": {"role": "assistant", "content": model_json}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        })
        .to_string()
    }

    #[test]
    fn parses_sql_reply_round_trip() {
        // AC: the openai adapter turns a Chat Completions envelope carrying the
        // SQL contract into ProviderReply::Sql verbatim (parse_reply reused).
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .match_header("authorization", "Bearer sk-test")
            .with_status(200)
            .with_body(openai_body(
                r#"{"type":"sql","sql":"SELECT COUNT(*) AS n FROM \"people\".data","viz":null,"assumption":null}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        let reply = OpenaiProvider::generate(&cfg, &sample_request("多少行")).expect("sql reply");
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
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(openai_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":{"kind":"bar","spec":"{\"mark\":\"bar\"}"},"assumption":"regr_slope 斜率"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("画图")).unwrap() {
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
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(openai_body(
                r#"{"type":"text","kind":"clarify","body":"按哪个 name？","assumption":null}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("汇总")).unwrap() {
            ProviderReply::Text { kind, body, .. } => {
                assert_eq!(kind, TextKind::Clarify);
                assert_eq!(body, "按哪个 name？");
            }
            other => panic!("expected clarify Text, got {other:?}"),
        }

        let mut server = mockito::Server::new();
        let _m2 = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(openai_body(
                r#"{"type":"text","kind":"refuse","body":"不做预测，可改为按季度汇总销量","assumption":"避开预测建模"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("预测下季度")).unwrap() {
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
        // refuse a connection: if the code path tried the network it would
        // surface an Unavailable (connect error), not NotWired.
        let cfg = config_at("http://127.0.0.1:1", None);
        assert_eq!(
            OpenaiProvider::generate(&cfg, &sample_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn auth_rejected_is_not_retried_not_wired() {
        // A 401 is permanent for this turn: map to NotWired so the orchestrator
        // does not burn the retry budget on three identical auth failures
        // (ADR-0044).
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(401)
            .with_body(r#"{"error":{"message":"Invalid API key","type":"invalid_api_key"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-bad"));
        assert_eq!(
            OpenaiProvider::generate(&cfg, &sample_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn server_error_is_unavailable_for_retry() {
        // A 5xx (or transport error) is transient -> Unavailable, consumed by
        // the orchestrator's retry budget.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(503)
            .with_body(r#"{"error":{"message":"Service unavailable"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(_)) => {}
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn malformed_reply_is_unavailable() {
        // Contract violations (not JSON) -> Unavailable (retried then failed
        // honestly). parse_reply reused -- identical contract to anthropic.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(openai_body("这不是 JSON"))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            OpenaiProvider::generate(&cfg, &sample_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn json_in_markdown_fence_still_parses() {
        // Defensive extraction (shared parse_reply) tolerates a model that
        // wrapped the JSON in a ``` fence despite the instruction not to.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(openai_body(
                "```json\n{\"type\":\"sql\",\"sql\":\"SELECT 1\",\"viz\":null,\"assumption\":null}\n```",
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")).unwrap() {
            ProviderReply::Sql { sql, .. } => assert_eq!(sql, "SELECT 1"),
            other => panic!("expected Sql, got {other:?}"),
        }
    }

    #[test]
    fn null_content_is_unavailable() {
        // OpenAI returns content=null for a tool-call-only response (which we
        // never request). A null/missing content is a contract violation ->
        // retried Unavailable, never an empty-string SQL.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(
                serde_json::json!({
                    "choices": [{"message": {"role": "assistant", "content": null}}]
                })
                .to_string(),
            )
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            OpenaiProvider::generate(&cfg, &sample_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn empty_choices_is_unavailable() {
        // An empty choices array (server returned no completion) is a contract
        // violation -> retried Unavailable.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(serde_json::json!({"choices": []}).to_string())
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            OpenaiProvider::generate(&cfg, &sample_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn error_envelope_at_http_200_surfaces_message() {
        // Some OpenAI-compatible gateways (Azure content_filter, proxy quota)
        // return HTTP 200 with an `error` envelope instead of `choices`. The
        // envelope's message must surface so the cause is diagnosable -- not a
        // bare "no text content" that hides the upstream reason.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(
                serde_json::json!({
                    "error": {"message": "content filter triggered", "code": "content_filter"}
                })
                .to_string(),
            )
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(msg)) => assert!(
                msg.contains("content filter triggered"),
                "error envelope message should surface, got: {msg}"
            ),
            other => panic!("expected Unavailable carrying envelope, got {other:?}"),
        }
    }

    #[test]
    fn http_400_surfaces_upstream_body_message() {
        // A 4xx payload/param rejection (model_not_found, context_length) is
        // transient/retryable (Unavailable), but the upstream body must surface
        // so the user sees WHY the model rejected the request -- not a bare
        // status code.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(400)
            .with_body(
                serde_json::json!({
                    "error": {"message": "The model `gpt4o` does not exist", "code": "model_not_found"}
                })
                .to_string(),
            )
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(msg)) => assert!(
                msg.contains("gpt4o") && msg.contains("400"),
                "400 body + status should surface, got: {msg}"
            ),
            other => panic!("expected Unavailable carrying 400 body, got {other:?}"),
        }
    }

    #[test]
    fn sends_bearer_auth_model_and_chat_completions_path() {
        // AC: the request carries Bearer auth (not x-api-key), the configured
        // model, and lands at {base}/chat/completions (the version path is the
        // user's to include in base_url).
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .match_header("authorization", "Bearer sk-test")
            .match_body(mockito::Matcher::Regex(r#""model":"gpt-4o""#.to_string()))
            .match_body(mockito::Matcher::Regex(r#""role":"system""#.to_string()))
            .match_body(mockito::Matcher::Regex(r#""role":"user""#.to_string()))
            .match_body(mockito::Matcher::Regex(r#""max_tokens":4096"#.to_string()))
            .with_status(200)
            .with_body(openai_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        OpenaiProvider::generate(&cfg, &sample_request("多少行")).expect("reply");
        _mock.assert(); // matched Bearer auth + model + roles + path
    }

    #[test]
    fn appends_chat_completions_to_base_url_with_version_segment() {
        // The user's base_url includes the version path (openai SDK convention);
        // the adapter appends only `/chat/completions`. A base_url ending in a
        // trailing slash must not produce `//chat/completions`, and the user's
        // `/v1` segment must be preserved verbatim.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/chat/completions")
            .with_status(200)
            .with_body(openai_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#,
            ))
            .create();
        // base_url ends in `/v1/` (trailing slash); the adapter trims it and
        // appends `/chat/completions` -> `{server}/v1/chat/completions`.
        let cfg = config_at(&format!("{}/v1/", server.url()), Some("sk-test"));
        OpenaiProvider::generate(&cfg, &sample_request("q")).expect("reply");
        _mock.assert();
    }

    #[test]
    fn system_message_carries_locale_directive_and_canonical_boundary() {
        // ADR-0052: the system message (role "system", first in the array)
        // carries BOTH the canonical boundary (layer 4) AND the locale
        // directive (layer 3) -- identical content to the anthropic adapter's
        // system field, just placed in a message. End-to-end proof the locale
        // threads through build_system_prompt into the openai body.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::Regex("简体中文".to_string()))
            .match_body(mockito::Matcher::Regex("IN-SCOPE".to_string()))
            .with_status(200)
            .with_body(openai_body(
                r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#,
            ))
            .create();
        let cfg = config_at_locale(&server.url(), Some("sk-test"), ResponseLocale::ZhCN);
        OpenaiProvider::generate(&cfg, &sample_request("画图")).expect("reply");
        _mock.assert();
    }

    #[test]
    fn history_renders_as_system_then_alternating_user_assistant() {
        // The OpenAI message array: system first, then a recent materialized
        // prior turn as user(question) + assistant(rendered response), then the
        // asking question as the final user turn.
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
        let msgs = build_messages(&request, "SYS".into());
        let roles: Vec<&str> = msgs.iter().map(|m| m.role).collect();
        assert_eq!(
            roles,
            vec!["system", "user", "assistant", "user"],
            "system leads, then alternating user/assistant, ending on user"
        );
        assert_eq!(msgs[0].content, "SYS");
        assert_eq!(msgs.last().unwrap().content, "现在呢");
        // The prior response is rendered human-readable, naming its result.
        let assistant = &msgs[2].content;
        assert!(assistant.contains("result_1") && assistant.contains("SELECT 1"));
    }
}
