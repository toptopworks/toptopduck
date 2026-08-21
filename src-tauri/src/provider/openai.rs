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
use serde_json::{json, Value};

use crate::provider::keychain::ProviderConfigSource;
use crate::provider::prompt::{build_system_prompt, render_history_messages, Message};
use crate::provider::reply::parse_reply;
use crate::provider::tool_calling::{ToolTurnMessage, ToolTurnReply, ToolTurnRequest, ToolUse};
use crate::provider::{ProviderError, ProviderReply, ProviderRequest, MAX_REPLY_TOKENS};

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
        // AC #244: reject a non-http/https base_url (file:, data:, scheme-less)
        // at the boundary before any request is built. Maps to InvalidConfig
        // (issue #277), mirroring the anthropic adapter so the two paths cannot
        // drift. See ProviderError::InvalidConfig for the rationale and
        // provider::http for the gate.
        super::http::validate_http_base_url(&base_url)
            .map_err(|e| ProviderError::InvalidConfig(e.to_string()))?;
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
            max_tokens: MAX_REPLY_TOKENS,
            messages: build_messages(request, system),
        };
        // serde_json::to_value only fails on non-finite floats / depth limits;
        // our body is plain strings, so this is defensive.
        let body_value = serde_json::to_value(&body).map_err(|e| {
            ProviderError::Unavailable(format!("request serialization failed: {e}"))
        })?;

        // AC #244: shared egress agent disables redirect-following so neither
        // Bearer nor any future header can travel past the first hop (see
        // provider::http).
        let response = super::http::egress_agent()
            .post(&url)
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

        // AC #244: under redirects(0) a 3xx surfaces as `Ok` (only >= 400 is
        // `Err::Status`). Without this guard the 3xx body would reach
        // `into_json` and surface as a misleading "response read failed"
        // parse error. Map any non-2xx to the same transient Unavailable so
        // the diagnosis names the status.
        if !(200..300).contains(&response.status()) {
            let status = response.status();
            let body = response.into_string().unwrap_or_default();
            return Err(ProviderError::Unavailable(format!(
                "LLM call failed (HTTP {status}): {}",
                crate::provider::reply::truncate(&body)
            )));
        }

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

    /// One native OpenAI tool-calling round-trip (ADR-0081,
    /// issue #291). Sends the active tool table plus the in-progress
    /// conversation using OpenAI's native function-calling -- the `tools`
    /// request field plus `tool_calls` / `tool` role messages -- and returns
    /// either the model's tool invocations to execute or its terminal text
    /// answer.
    ///
    /// Same invariants as [`Self::generate`]: the key is read in the Rust
    /// core per call (ADR-0029 invariant 3); HTTP 401/403 ->
    /// [`ProviderError::NotWired`], transient failures ->
    /// [`ProviderError::Unavailable`] (ADR-0044, via
    /// [`http::classify_send_result`](super::http::classify_send_result));
    /// blocking ureq on the `spawn_blocking` thread (ADR-0021). The legacy
    /// single-shot [`Self::generate`] path is untouched.
    pub fn generate_tool_turn(
        config: &dyn ProviderConfigSource,
        request: &ToolTurnRequest,
    ) -> Result<ToolTurnReply, ProviderError> {
        // ADR-0029 invariant 3: key fetched in the Rust core, per turn.
        let key = config.api_key().ok_or(ProviderError::NotWired)?;
        let base_url = config.base_url();
        // AC #244 / #277: reject a non-http/https base_url at the boundary
        // before any request is built. Maps to InvalidConfig -- a permanent
        // config fault retrying cannot fix -- so the policy reason rides the
        // detail (mirrors the single-shot path).
        super::http::validate_http_base_url(&base_url)
            .map_err(|e| ProviderError::InvalidConfig(e.to_string()))?;
        let model = config.model();
        let url = format!(
            "{base}/chat/completions",
            base = base_url.trim_end_matches('/')
        );

        let body = build_tool_turn_body(&model, request);
        // AC #244: shared egress agent disables redirect-following so the
        // Bearer token cannot travel past the first hop.
        let response = super::http::egress_agent()
            .post(&url)
            .set("Authorization", &format!("Bearer {key}"))
            .timeout(REQUEST_TIMEOUT)
            .send_json(body);
        let response = super::http::classify_send_result(response)?;
        let raw: RawToolTurnResponse = response
            .into_json()
            .map_err(|e| ProviderError::Unavailable(format!("response read failed: {e}")))?;
        parse_tool_turn_response(raw)
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

/// Minimal OpenAI tool-calling response shape -- `choices` plus an optional
/// `error` envelope (some gateways return HTTP 200 with `error` instead of
/// `choices`). The tool-calling path reads `choices[0].message.tool_calls`
/// (and falls back to `content`); extra fields are ignored by serde.
#[derive(Deserialize)]
struct RawToolTurnResponse {
    #[serde(default)]
    choices: Vec<RawToolTurnChoice>,
    #[serde(default)]
    error: Option<RawError>,
}

#[derive(Deserialize)]
struct RawToolTurnChoice {
    message: RawToolTurnMessage,
}

#[derive(Deserialize)]
struct RawToolTurnMessage {
    /// The model's terminal text (absent on a tool-call-only step).
    #[serde(default)]
    content: Option<String>,
    /// The model's tool invocations (absent on a terminal text step).
    #[serde(default)]
    tool_calls: Option<Vec<RawToolCall>>,
}

#[derive(Deserialize)]
struct RawToolCall {
    id: String,
    function: RawToolFunction,
}

#[derive(Deserialize)]
struct RawToolFunction {
    name: String,
    /// OpenAI encodes tool-call arguments as a JSON-encoded STRING (not an
    /// object); parsed back into a [`Value`] by the adapter. A malformed
    /// string surfaces as [`ProviderError::Unavailable`]; an absent or empty
    /// string means "no arguments" and becomes `Value::Null`.
    #[serde(default)]
    arguments: Option<String>,
}

/// Build the OpenAI Chat Completions request body for one tool-calling turn.
/// The `tools` field is omitted when the table is empty; `messages` carries
/// the system prompt as a leading role="system" message plus the translated
/// conversation (see [`build_openai_messages`]).
fn build_tool_turn_body(model: &str, request: &ToolTurnRequest) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": request.max_tokens,
    });
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect();
        body["tools"] = Value::Array(tools);
    }
    body["messages"] = Value::Array(build_openai_messages(&request.messages, &request.system));
    body
}

/// Translate the protocol-neutral [`ToolTurnMessage`] sequence into the
/// OpenAI messages array. OpenAI Chat Completions carries the system prompt
/// as a leading role="system" message (no separate `system` field); tool i/o
/// uses the native function-calling shape:
/// - [`ToolTurnMessage::User`] -> `role:"user"`;
/// - [`ToolTurnMessage::Assistant`] -> `role:"assistant"` with optional
///   `content` + a `tool_calls` array (one entry per call, `arguments` is the
///   JSON-encoded input string per OpenAI convention);
/// - [`ToolTurnMessage::ToolResult`] -> `role:"tool"` with `tool_call_id`
///   (one message per result; OpenAI does not bundle them).
fn build_openai_messages(messages: &[ToolTurnMessage], system: &str) -> Vec<Value> {
    let mut out = Vec::with_capacity(messages.len() + 1);
    out.push(json!({ "role": "system", "content": system }));
    for msg in messages {
        match msg {
            ToolTurnMessage::User { content } => {
                out.push(json!({ "role": "user", "content": content }));
            }
            ToolTurnMessage::Assistant { text, tool_calls } => {
                let mut entry = json!({ "role": "assistant" });
                if let Some(t) = text {
                    entry["content"] = Value::String(t.clone());
                }
                if !tool_calls.is_empty() {
                    let calls: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            // OpenAI encodes arguments as a JSON string.
                            let arguments = serde_json::to_string(&tc.input)
                                .unwrap_or_else(|_| "null".to_string());
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": arguments,
                                }
                            })
                        })
                        .collect();
                    entry["tool_calls"] = Value::Array(calls);
                }
                // Chat Completions requires at least one of `content` or
                // `tool_calls` on an assistant message; a degenerate empty
                // assistant turn (no text, no calls) would 400. Emit an empty
                // content string so the wire shape is accepted (mirrors the
                // anthropic adapter's empty-text-block guard).
                if text.is_none() && tool_calls.is_empty() {
                    entry["content"] = Value::String(String::new());
                }
                out.push(entry);
            }
            ToolTurnMessage::ToolResult {
                tool_use_id,
                content,
                ..
            } => {
                out.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": content,
                }));
            }
        }
    }
    out
}

/// Parse the OpenAI tool-calling response into a [`ToolTurnReply`]. If
/// `choices[0].message.tool_calls` is present and non-empty ->
/// [`ToolTurnReply::ToolCalls`] (each `arguments` JSON string parsed back to
/// a [`Value`]), with the message `content` riding alongside as the round's
/// connective text (ADR-0103, issue #608; `None` when absent or empty).
/// Otherwise the message `content` is the terminal [`ToolTurnReply::Text`];
/// empty choices surface an optional error envelope or a contract violation
/// -> retried [`ProviderError::Unavailable`].
fn parse_tool_turn_response(raw: RawToolTurnResponse) -> Result<ToolTurnReply, ProviderError> {
    let message = raw
        .choices
        .into_iter()
        .next()
        .map(|c| c.message)
        .ok_or_else(|| match raw.error {
            Some(err) => ProviderError::Unavailable(format!(
                "LLM returned error envelope: {}",
                err.message.unwrap_or_else(|| "unknown error".into())
            )),
            None => ProviderError::Unavailable("LLM response has no choices".into()),
        })?;
    if let Some(tool_calls) = message.tool_calls {
        if !tool_calls.is_empty() {
            let calls: Vec<ToolUse> = tool_calls
                .into_iter()
                .map(|c| {
                    let RawToolCall {
                        id,
                        function: RawToolFunction { name, arguments },
                    } = c;
                    // An absent or empty arguments string means "no arguments"
                    // (OpenAI allows this for nullary calls) -> Value::Null.
                    // A present-but-malformed string is a model contract
                    // violation, not "no arguments" -- surface it as a retried
                    // Unavailable so the cause is diagnosable instead of
                    // silently executing a tool with null input.
                    let input = match arguments {
                        None => Value::Null,
                        Some(s) if s.is_empty() => Value::Null,
                        Some(s) => serde_json::from_str(&s).map_err(|e| {
                            ProviderError::Unavailable(format!(
                                "tool_call {id} arguments parse failed: {e}"
                            ))
                        })?,
                    };
                    Ok(ToolUse { id, name, input })
                })
                .collect::<Result<Vec<_>, _>>()?;
            // The empty-text -> None normalization lives in the constructor
            // (issue #617), shared with the anthropic adapter's parse point.
            return Ok(ToolTurnReply::tool_calls_with(message.content, calls));
        }
    }
    match message.content {
        Some(t) if !t.is_empty() => Ok(ToolTurnReply::Text(t)),
        _ => Err(ProviderError::Unavailable(
            "LLM response has no text content".into(),
        )),
    }
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
/// prompt rides a leading role="system" message. The role/content sequence
/// is delegated to [`render_history_messages`]; this function only prepends
/// the system message and maps the neutral pairs into OpenAI's wire shape.
fn build_messages(request: &ProviderRequest, system: String) -> Vec<Message> {
    let mut msgs = Vec::with_capacity(request.history.len() * 2 + 2);
    msgs.push(Message {
        role: "system",
        content: system,
    });
    msgs.extend(
        render_history_messages(request)
            .into_iter()
            .map(|(role, content)| Message { role, content }),
    );
    msgs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ChartKind, Protocol, TextKind};
    use crate::provider::keychain::StaticConfig;
    use crate::provider::prompt::ResponseLocale;
    use crate::provider::tool_calling::{ToolDefinition, ToolResult};
    use crate::provider::{ColumnRef, DatasetRef, ResponsePayload, TurnPayload};

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
    fn forbidden_403_is_not_retried_not_wired() {
        // A 403 is permanent for this turn (forbidden scope / IP-style block):
        // the adapter maps it to NotWired, mirroring the 401 contract above, so
        // the orchestrator does not burn the retry budget on three identical
        // rejections (ADR-0044). `_mock.assert()` pins that the HTTP path was
        // actually taken (rules out the missing-key short-circuit), and the
        // NotWired result pins that a regression dropping 403 from the
        // auth-rejected set would fail here.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(403)
            .with_body(r#"{"error":{"message":"Forbidden","type":"forbidden"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert_eq!(
            OpenaiProvider::generate(&cfg, &sample_request("q")).unwrap_err(),
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
    fn rate_limited_429_is_unavailable_for_retry() {
        // A 429 from an OpenAI-compatible gateway falls through the
        // auth-rejected guard and becomes Unavailable -- transient/retryable,
        // same path as 5xx. Pins that 429 stays OUT of the auth-rejected set:
        // a regression that added `|| status == 429` to the NotWired guard
        // would silently make rate limits permanent, which is wrong.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(429)
            .with_body(r#"{"error":{"message":"rate limit","type":"rate_limit_exceeded"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(_)) => {}
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn payload_4xx_is_unavailable_with_upstream_body() {
        // A non-auth 4xx (model_not_found / context_length_exceeded) surfaces
        // the upstream body so the user sees WHY instead of a bare status --
        // pinned here, distinct from the 5xx transport path. Retried once by
        // the orchestrator, then fails honestly. The body-contains checks pin
        // that a regression to a bare status message (dropping the upstream
        // body) would fail here.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(400)
            .with_body(r#"{"error":{"message":"model not found","type":"model_not_found"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(msg)) => {
                assert!(msg.contains("HTTP 400"), "status surfaced: {msg}");
                assert!(
                    msg.contains("model not found"),
                    "upstream body surfaced: {msg}"
                );
            }
            other => panic!("expected Unavailable with body, got {other:?}"),
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

    #[test]
    fn base_url_non_http_scheme_is_rejected_before_any_request() {
        // AC #244 (mirrors the anthropic adapter): a file:// base_url is
        // rejected at the boundary before any HTTP call is placed. Surfaced as
        // InvalidConfig (issue #277) carrying the http/https policy so the
        // diagnosis reads -- permanent, distinct from the transient Unavailable
        // path.
        let cfg = config_at("file:///etc/passwd", Some("sk-test"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::InvalidConfig(msg)) => assert!(
                msg.contains("http/https"),
                "scheme rejection surfaces the http/https policy: {msg}"
            ),
            other => panic!("expected InvalidConfig for bad scheme, got {other:?}"),
        }
    }

    #[test]
    fn does_not_leak_bearer_token_across_host_redirect() {
        // AC #244 (three-path uniform handling, non-regression on Bearer): the
        // openai adapter wires the same shared egress agent as anthropic, so a
        // 3xx redirect is NOT followed and the Bearer token cannot reach a
        // second host. The second host's Authorization-matching mock must
        // record zero hits (see provider::http for the rationale).
        let mut first = mockito::Server::new();
        let mut second = mockito::Server::new();
        first
            .mock("POST", "/chat/completions")
            .with_status(302)
            .with_header("Location", &format!("{}/chat/completions", second.url()))
            .create();
        let second_hit = second
            .mock("GET", "/chat/completions")
            .match_header("authorization", "Bearer sk-secret")
            .expect(0)
            .with_status(200)
            .create();
        let cfg = config_at(&first.url(), Some("sk-secret"));
        let _ = OpenaiProvider::generate(&cfg, &sample_request("q"));
        second_hit.assert();
    }

    #[test]
    fn redirect_surfaces_as_unavailable_with_status_not_parse_error() {
        // AC #244 (M2): under redirects(0) a 3xx surfaces as Ok and must be
        // mapped to an Unavailable that names the status, NOT a misleading
        // "response read failed" from a body-parse fault on the 3xx body.
        // Mirrors the anthropic adapter's status guard.
        let mut first = mockito::Server::new();
        first
            .mock("POST", "/chat/completions")
            .with_status(302)
            .with_header("Location", "https://evil.test/chat/completions")
            .with_body("<html>302 here</html>")
            .create();
        let cfg = config_at(&first.url(), Some("sk-secret"));
        match OpenaiProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(msg)) => assert!(
                msg.contains("HTTP 302"),
                "3xx surfaces with its status, got: {msg}"
            ),
            other => panic!("expected Unavailable for 3xx, got {other:?}"),
        }
    }

    // ----- tool-calling fixtures (issue #291, ADR-0081) -----

    /// A tool-calling request with one tool + a single user question (the
    /// minimal round-trip shape). Stable literals so body-matching is
    /// deterministic.
    fn tool_turn_request(question: &str) -> ToolTurnRequest {
        ToolTurnRequest {
            system: "You are a SQL agent.".into(),
            messages: vec![ToolTurnMessage::user(question)],
            tools: vec![ToolDefinition {
                name: "run_sql".into(),
                description: "Run read-only SQL.".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "sql": { "type": "string" } },
                    "required": ["sql"],
                }),
            }],
            max_tokens: 1024,
        }
    }

    /// Wrap a Chat Completions message object in the choices envelope.
    /// `message_json` is the raw JSON for `choices[0].message`.
    fn tool_response_body(message_json: &str) -> String {
        format!("{{\"choices\":[{{\"message\":{message_json}}}]}}")
    }

    #[test]
    fn tool_turn_advertises_tools_field_in_request_body() {
        // AC #291: the request body carries the tool table under the native
        // openai `tools` field, each entry shaped as
        // `{type:"function", function:{name, description, parameters}}`.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .match_header("authorization", "Bearer sk-test")
            .match_body(mockito::Matcher::Regex(r#""type":"function""#.into()))
            .match_body(mockito::Matcher::Regex(r#""parameters""#.into()))
            .with_status(200)
            .with_body(tool_response_body(
                r#"{"role":"assistant","content":"done"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("count rows"))
            .expect("tool turn");
        _mock.assert();
    }

    #[test]
    fn tool_turn_parses_tool_calls_into_calls() {
        // AC #291: a response with `tool_calls` yields ToolTurnReply::ToolCalls;
        // each `arguments` JSON string is parsed back into a Value. Two calls
        // pin multi-call batches.
        let message = serde_json::json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [
                {"id":"call_1","type":"function","function":{"name":"run_sql","arguments":"{\"sql\":\"SELECT 1\"}"}},
                {"id":"call_2","type":"function","function":{"name":"run_sql","arguments":"{\"sql\":\"SELECT 2\"}"}}
            ]
        })
        .to_string();
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(tool_response_body(&message))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        let reply = OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("multi"))
            .expect("tool calls");
        match reply {
            ToolTurnReply::ToolCalls { calls, .. } => {
                assert_eq!(calls.len(), 2);
                assert_eq!(calls[0].id, "call_1");
                assert_eq!(calls[0].name, "run_sql");
                assert_eq!(calls[0].input, serde_json::json!({"sql":"SELECT 1"}));
                assert_eq!(calls[1].id, "call_2");
            }
            other => panic!("expected ToolCalls, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_carries_message_content_as_round_prose() {
        // ADR-0103 (issue #608): message content alongside tool_calls is the
        // round's connective prose -- parsed onto ToolCalls.text; null or
        // empty content yields None.
        let message = serde_json::json!({
            "role": "assistant",
            "content": "先看一眼数据。",
            "tool_calls": [
                {"id":"call_1","type":"function","function":{"name":"run_sql","arguments":"{\"sql\":\"SELECT 1\"}"}}
            ]
        })
        .to_string();
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(tool_response_body(&message))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        let reply = OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("narrated"))
            .expect("tool calls");
        match reply {
            ToolTurnReply::ToolCalls { text, calls } => {
                assert_eq!(text.as_deref(), Some("先看一眼数据。"));
                assert_eq!(calls.len(), 1);
            }
            other => panic!("expected ToolCalls, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_refeeds_prose_alongside_tool_calls_on_the_wire() {
        // ADR-0103 (issue #608): the round's connective prose re-feeds on
        // the assistant message -- one assistant turn carrying BOTH the
        // `content` string and the `tool_calls` array, so the next
        // round-trip's request shows the model its own narration.
        // Body-regex pins both fields coexisting on the assistant turn.
        let request = ToolTurnRequest {
            system: "agent".into(),
            messages: vec![
                ToolTurnMessage::user("count rows"),
                ToolTurnMessage::Assistant {
                    text: Some("先看一眼数据。".into()),
                    tool_calls: vec![ToolUse {
                        id: "call_1".into(),
                        name: "run_sql".into(),
                        input: serde_json::json!({"sql":"SELECT 1"}),
                    }],
                },
            ],
            tools: vec![ToolDefinition {
                name: "run_sql".into(),
                description: "run sql".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }],
            max_tokens: 1024,
        };
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::Regex(
                r#""role":"assistant","content":"先看一眼数据。""#.into(),
            ))
            .match_body(mockito::Matcher::Regex(r#""tool_calls":"#.into()))
            .with_status(200)
            .with_body(tool_response_body(
                r#"{"role":"assistant","content":"1 row"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        OpenaiProvider::generate_tool_turn(&cfg, &request).expect("request lands");
        _mock.assert();
    }

    #[test]
    fn tool_turn_round_trips_tool_result_as_tool_role_message() {
        // AC #291: a fed-back ToolResult is serialized as a role="tool"
        // message carrying tool_call_id + content; the assistant's prior
        // tool_calls is re-sent. Body-regex pins the tool role + the id.
        let request = ToolTurnRequest {
            system: "agent".into(),
            messages: vec![
                ToolTurnMessage::user("count rows"),
                ToolTurnMessage::Assistant {
                    text: None,
                    tool_calls: vec![ToolUse {
                        id: "call_1".into(),
                        name: "run_sql".into(),
                        input: serde_json::json!({"sql":"SELECT 1"}),
                    }],
                },
                ToolTurnMessage::tool_result(ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "[{\"n\":1}]".into(),
                    is_error: false,
                }),
            ],
            tools: vec![ToolDefinition {
                name: "run_sql".into(),
                description: "run sql".into(),
                input_schema: serde_json::json!({"type":"object"}),
            }],
            max_tokens: 1024,
        };
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .match_body(mockito::Matcher::Regex(r#""role":"tool""#.into()))
            .match_body(mockito::Matcher::Regex(r#""tool_call_id":"call_1""#.into()))
            .with_status(200)
            .with_body(tool_response_body(
                r#"{"role":"assistant","content":"1 row"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate_tool_turn(&cfg, &request).expect("text") {
            ToolTurnReply::Text(t) => assert_eq!(t, "1 row"),
            other => panic!("expected Text, got {other:?}"),
        }
        _mock.assert();
    }

    #[test]
    fn tool_turn_emits_one_tool_message_per_result() {
        // OpenAI does NOT bundle consecutive tool results -- each ToolResult
        // becomes its own role="tool" message (unlike anthropic's single
        // user turn). Two results for call_1/call_2 -> two distinct tool
        // messages. Asserted via the body builder directly (no HTTP).
        let request = ToolTurnRequest {
            system: "agent".into(),
            messages: vec![
                ToolTurnMessage::user("two queries"),
                ToolTurnMessage::Assistant {
                    text: None,
                    tool_calls: vec![
                        ToolUse {
                            id: "call_1".into(),
                            name: "run_sql".into(),
                            input: serde_json::json!({"sql":"SELECT 1"}),
                        },
                        ToolUse {
                            id: "call_2".into(),
                            name: "run_sql".into(),
                            input: serde_json::json!({"sql":"SELECT 2"}),
                        },
                    ],
                },
                ToolTurnMessage::tool_result(ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "1".into(),
                    is_error: false,
                }),
                ToolTurnMessage::tool_result(ToolResult {
                    tool_use_id: "call_2".into(),
                    content: "2".into(),
                    is_error: false,
                }),
            ],
            tools: Vec::new(),
            max_tokens: 1024,
        };
        let body = build_tool_turn_body("gpt-4o", &request);
        let messages = body.get("messages").unwrap().as_array().unwrap();
        // system, user, assistant, tool(call_1), tool(call_2).
        assert_eq!(messages.len(), 5);
        let tool_msgs: Vec<&Value> = messages.iter().filter(|m| m["role"] == "tool").collect();
        assert_eq!(tool_msgs.len(), 2, "one tool message per result");
        assert_eq!(tool_msgs[0]["tool_call_id"], "call_1");
        assert_eq!(tool_msgs[1]["tool_call_id"], "call_2");
    }

    #[test]
    fn tool_turn_returns_terminal_text_when_no_tool_calls() {
        // AC #291: a content-only response (no tool_calls) yields the
        // terminal ToolTurnReply::Text.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(tool_response_body(
                r#"{"role":"assistant","content":"the answer is 42"}"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("final")).expect("text") {
            ToolTurnReply::Text(t) => assert_eq!(t, "the answer is 42"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_empty_choices_is_unavailable() {
        // Empty choices (no completion) is a contract violation -> retried
        // Unavailable.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(serde_json::json!({"choices": []}).to_string())
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn tool_turn_auth_rejected_is_not_wired() {
        // ADR-0044: 401 -> NotWired (permanent, not retried). Routed via the
        // shared http::classify_send_result helper.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(401)
            .with_body(r#"{"error":{"message":"Invalid API key"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-bad"));
        assert_eq!(
            OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn tool_turn_server_error_is_unavailable() {
        // A 5xx is transient -> Unavailable. Pins that the shared classify
        // helper routes 5xx to Unavailable, not NotWired.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(503)
            .with_body(r#"{"error":{"message":"Service unavailable"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn tool_turn_rejects_non_http_base_url_as_invalid_config() {
        // AC #244 / #277 (mirrors the single-shot path): a file:// base_url is
        // rejected before any HTTP call as InvalidConfig -- a permanent config
        // fault, not retried.
        let cfg = config_at("file:///etc/passwd", Some("sk-test"));
        match OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("q")) {
            Err(ProviderError::InvalidConfig(msg)) => assert!(
                msg.contains("http/https"),
                "scheme rejection surfaces the http/https policy: {msg}"
            ),
            other => panic!("expected InvalidConfig for bad scheme, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_malformed_arguments_is_unavailable() {
        // A present-but-malformed arguments string (truncated / hallucinated
        // JSON -- common on weaker OpenAI-compatible endpoints) is a model
        // contract violation, NOT "no arguments": surface it as a retried
        // Unavailable naming the offending call id, instead of silently
        // executing a tool with null input.
        let message = serde_json::json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [
                {"id":"call_1","type":"function","function":{"name":"run_sql","arguments":"not-json{"}}
            ]
        })
        .to_string();
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(tool_response_body(&message))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("bad args")) {
            Err(ProviderError::Unavailable(msg)) => assert!(
                msg.contains("call_1") && msg.contains("arguments parse failed"),
                "malformed arguments surface the call id + cause, got: {msg}"
            ),
            other => panic!("expected Unavailable for malformed arguments, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_empty_arguments_falls_back_to_null() {
        // An empty arguments string means "no arguments" (OpenAI allows this
        // for nullary calls) -> input Value::Null, not an error. Pins the
        // None/empty branch distinct from the malformed branch above.
        let message = serde_json::json!({
            "role": "assistant",
            "content": null,
            "tool_calls": [
                {"id":"call_1","type":"function","function":{"name":"list_tables","arguments":""}}
            ]
        })
        .to_string();
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(tool_response_body(&message))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match OpenaiProvider::generate_tool_turn(&cfg, &tool_turn_request("nullary"))
            .expect("calls")
        {
            ToolTurnReply::ToolCalls { calls, .. } => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].input, Value::Null);
            }
            other => panic!("expected ToolCalls with null input, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_degenerate_assistant_turn_emits_empty_content() {
        // Chat Completions requires at least one of `content` / `tool_calls`
        // on an assistant message; a degenerate Assistant { None, vec![] }
        // would 400. The builder emits an empty content string so the shape
        // is accepted (mirrors anthropic's empty-text-block guard). Asserted
        // via the body builder directly (no HTTP).
        let request = ToolTurnRequest {
            system: "agent".into(),
            messages: vec![
                ToolTurnMessage::user("q"),
                ToolTurnMessage::Assistant {
                    text: None,
                    tool_calls: Vec::new(),
                },
                ToolTurnMessage::user("follow up"),
            ],
            tools: Vec::new(),
            max_tokens: 1024,
        };
        let body = build_tool_turn_body("gpt-4o", &request);
        let messages = body.get("messages").unwrap().as_array().unwrap();
        let assistant = messages
            .iter()
            .find(|m| m["role"] == "assistant")
            .expect("assistant turn present");
        assert_eq!(
            assistant["content"], "",
            "degenerate assistant gets empty content"
        );
        assert!(
            assistant.get("tool_calls").is_none(),
            "no tool_calls key on a degenerate assistant"
        );
    }
}
