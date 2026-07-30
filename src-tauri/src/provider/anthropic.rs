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
use serde_json::{json, Value};

use crate::provider::keychain::ProviderConfigSource;
use crate::provider::prompt::{
    build_system_prompt, render_response, render_summary_turn_note, Message,
};
use crate::provider::reply::parse_reply;
use crate::provider::tool_calling::{ToolTurnMessage, ToolTurnReply, ToolTurnRequest, ToolUse};
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
        // at the boundary before any request is built. Maps to InvalidConfig
        // (issue #277) -- a permanent fault the orchestrator does not retry --
        // so the policy reason rides the detail to the UI fold (NotWired would
        // drop it). See ProviderError::InvalidConfig for the rationale and
        // provider::http for the gate.
        super::http::validate_http_base_url(&base_url)
            .map_err(|e| ProviderError::InvalidConfig(e.to_string()))?;
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

        // AC #244: the shared egress agent disables redirect-following so a
        // 3xx Location cannot carry x-api-key off-host (see provider::http).
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

        // AC #244: under redirects(0) a 3xx surfaces as `Ok` (only >= 400 is
        // `Err::Status`). Without this guard the 3xx body (usually empty/HTML)
        // would reach `into_json` and surface as a misleading "response read
        // failed" parse error. Map any non-2xx to the same transient
        // Unavailable so the diagnosis names the status, not a parse fault.
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

    /// One native Anthropic tool-calling round-trip (ADR-0081 expand phase,
    /// issue #291). Sends the active tool table plus the in-progress
    /// conversation using Anthropic's native tool-calling -- the `tools`
    /// request field plus `tool_use` / `tool_result` content blocks -- and
    /// returns either the model's tool invocations to execute or its
    /// terminal text answer.
    ///
    /// Same invariants as [`Self::generate`]: the key is read in the Rust
    /// core per call (ADR-0029 invariant 3); HTTP 401/403 -> [`ProviderError::NotWired`],
    /// transient failures -> [`ProviderError::Unavailable`] (ADR-0044, via
    /// [`http::classify_send_result`](super::http::classify_send_result));
    /// blocking ureq on the `spawn_blocking` thread (ADR-0021). The legacy
    /// single-shot [`Self::generate`] path is untouched.
    pub fn generate_tool_turn(
        config: &dyn ProviderConfigSource,
        request: &ToolTurnRequest,
    ) -> Result<ToolTurnReply, ProviderError> {
        // ADR-0029 invariant 3: key fetched in the Rust core, per turn. No
        // key -> NotWired (permanent, surfaces as a configure-key prompt).
        let key = config.api_key().ok_or(ProviderError::NotWired)?;
        let base_url = config.base_url();
        // AC #244 / #277: reject a non-http/https base_url at the boundary
        // before any request is built. Maps to InvalidConfig -- a permanent
        // config fault retrying cannot fix -- so the policy reason rides the
        // detail (mirrors the single-shot path).
        super::http::validate_http_base_url(&base_url)
            .map_err(|e| ProviderError::InvalidConfig(e.to_string()))?;
        let model = config.model();
        let url = format!("{base}/v1/messages", base = base_url.trim_end_matches('/'));

        let body = build_tool_turn_body(&model, request);
        // AC #244: shared egress agent disables redirect-following so a 3xx
        // Location cannot carry x-api-key off-host.
        let response = super::http::egress_agent()
            .post(&url)
            .set("x-api-key", &key)
            .set("anthropic-version", ANTHROPIC_VERSION)
            .timeout(REQUEST_TIMEOUT)
            .send_json(body);
        let response = super::http::classify_send_result(response)?;
        let raw: RawToolTurnResponse = response
            .into_json()
            .map_err(|e| ProviderError::Unavailable(format!("response read failed: {e}")))?;
        parse_tool_turn_response(raw)
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

/// Minimal Anthropic tool-calling response shape -- the `content` array,
/// whose blocks may be `text` or `tool_use`. Extra fields (id, model, usage,
/// stop_reason) are ignored by serde; the `tool_use` block's `id` / `name` /
/// `input` are read by [`parse_tool_turn_response`] only when the block type
/// matches.
#[derive(Deserialize)]
struct RawToolTurnResponse {
    content: Vec<RawToolTurnBlock>,
}

#[derive(Deserialize)]
struct RawToolTurnBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    /// The tool-call id / name (present on `tool_use` blocks only).
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// The tool-call input (present on `tool_use` blocks); parsed verbatim.
    #[serde(default)]
    input: Option<Value>,
}

/// Build the Anthropic Messages request body for one tool-calling turn. The
/// `tools` field is omitted when the table is empty (the model then replies
/// with text only); `messages` carries the translated conversation as
/// anthropic content blocks (see [`build_anthropic_messages`]).
fn build_tool_turn_body(model: &str, request: &ToolTurnRequest) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": request.max_tokens,
        "system": request.system,
    });
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                })
            })
            .collect();
        body["tools"] = Value::Array(tools);
    }
    body["messages"] = Value::Array(build_anthropic_messages(&request.messages));
    body
}

/// Translate the protocol-neutral [`ToolTurnMessage`] sequence into the
/// Anthropic messages array. Anthropic requires strict user/assistant role
/// alternation and carries tool i/o as content blocks:
/// - [`ToolTurnMessage::User`] -> a `user` turn whose content is the text;
/// - [`ToolTurnMessage::Assistant`] -> an `assistant` turn whose content is a
///   block array (optional `text` + one `tool_use` per call);
/// - [`ToolTurnMessage::ToolResult`] -> bundled into the next flushed `user`
///   turn as `tool_result` blocks (anthropic requires consecutive tool
///   results to share one user turn). Trailing results flush at the end.
fn build_anthropic_messages(messages: &[ToolTurnMessage]) -> Vec<Value> {
    fn flush(out: &mut Vec<Value>, pending: &mut Vec<Value>) {
        if !pending.is_empty() {
            let blocks = std::mem::take(pending);
            out.push(json!({ "role": "user", "content": blocks }));
        }
    }
    let mut out = Vec::with_capacity(messages.len() + 1);
    let mut pending_tool_results: Vec<Value> = Vec::new();
    for msg in messages {
        match msg {
            ToolTurnMessage::User { content } => {
                flush(&mut out, &mut pending_tool_results);
                out.push(json!({ "role": "user", "content": content }));
            }
            ToolTurnMessage::Assistant { text, tool_calls } => {
                flush(&mut out, &mut pending_tool_results);
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(t) = text {
                    blocks.push(json!({ "type": "text", "text": t }));
                }
                for tc in tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.input,
                    }));
                }
                if blocks.is_empty() {
                    // An assistant turn with no text and no tool calls is
                    // degenerate; emit an empty text block so Anthropic
                    // accepts the message shape (content cannot be empty).
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            ToolTurnMessage::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                pending_tool_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                    "is_error": is_error,
                }));
            }
        }
    }
    flush(&mut out, &mut pending_tool_results);
    out
}

/// Parse the Anthropic tool-calling response into a [`ToolTurnReply`]. A
/// `tool_use` block yields a [`ToolUse`]; a `text` block accumulates prose.
/// If any `tool_use` blocks are present -> [`ToolTurnReply::ToolCalls`]
/// (intermediate step; the agent loop executes them). Otherwise the joined
/// text is the terminal [`ToolTurnReply::Text`]; empty text is a contract
/// violation -> retried [`ProviderError::Unavailable`]. Unknown block kinds
/// are ignored (forward-compat with server-added block types).
fn parse_tool_turn_response(raw: RawToolTurnResponse) -> Result<ToolTurnReply, ProviderError> {
    let mut tool_calls = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();
    for block in raw.content {
        match block.kind.as_str() {
            "tool_use" => {
                let id = block.id.ok_or_else(|| {
                    ProviderError::Unavailable("tool_use block missing id field".into())
                })?;
                let name = block.name.ok_or_else(|| {
                    ProviderError::Unavailable("tool_use block missing name field".into())
                })?;
                let input = block.input.unwrap_or(Value::Null);
                tool_calls.push(ToolUse { id, name, input });
            }
            "text" => {
                if let Some(t) = block.text {
                    text_parts.push(t);
                }
            }
            _ => {}
        }
    }
    if !tool_calls.is_empty() {
        Ok(ToolTurnReply::ToolCalls(tool_calls))
    } else {
        let text = text_parts.join("");
        if text.is_empty() {
            Err(ProviderError::Unavailable(
                "LLM response has no text content".into(),
            ))
        } else {
            Ok(ToolTurnReply::Text(text))
        }
    }
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
    use crate::provider::tool_calling::{ToolDefinition, ToolResult};
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
        // http/https policy so the diagnosis is readable. It routes to
        // InvalidConfig (issue #277): a permanent configuration fault carried
        // with detail -- distinct from Unavailable (transient/retried) and from
        // NotWired (which drops the reason).
        let cfg = config_at("file:///etc/passwd", Some("sk-test"));
        match AnthropicProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::InvalidConfig(msg)) => assert!(
                msg.contains("http/https"),
                "scheme rejection surfaces the http/https policy: {msg}"
            ),
            other => panic!("expected InvalidConfig for bad scheme, got {other:?}"),
        }
    }

    #[test]
    fn does_not_forward_x_api_key_across_host_redirect() {
        // AC #244: a 3xx redirect to a SECOND host must NOT carry x-api-key.
        // The shared egress agent disables redirect-following, so the
        // credential never travels past the first hop; the second host's
        // x-api-key-matching mock must record zero hits.
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
        // The turn fails (the 3xx surfaces raw under redirects(0); the M2
        // status guard then maps it to Unavailable). The assertion is the
        // absence of a cross-host x-api-key leak, not the call's success.
        let _ = AnthropicProvider::generate(&cfg, &sample_request("q"));
        second_leak.assert();
    }

    #[test]
    fn redirect_surfaces_as_unavailable_with_status_not_parse_error() {
        // AC #244 (M2): under redirects(0) a 3xx surfaces as Ok and must be
        // mapped to an Unavailable that names the status (e.g. "HTTP 302"), NOT
        // a misleading "response read failed" from a body-parse fault on the
        // 3xx body. Pins the status guard added with the redirect fix.
        let mut first = mockito::Server::new();
        first
            .mock("POST", "/v1/messages")
            .with_status(302)
            .with_header("Location", "https://evil.test/v1/messages")
            .with_body("<html>302 here</html>")
            .create();
        let cfg = config_at(&first.url(), Some("sk-secret"));
        match AnthropicProvider::generate(&cfg, &sample_request("q")) {
            Err(ProviderError::Unavailable(msg)) => assert!(
                msg.contains("HTTP 302"),
                "3xx surfaces with its status, got: {msg}"
            ),
            other => panic!("expected Unavailable for 3xx, got {other:?}"),
        }
    }

    // ----- tool-calling fixtures (issue #291, ADR-0081 expand phase) -----

    /// A tool-calling request with one tool + a single user question (the
    /// minimal round-trip shape). The system prompt + tool schema are stable
    /// literals so body-matching assertions are deterministic.
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

    /// Wrap an Anthropic content-array response (tool-calling shape) in the
    /// response envelope. `content_json` is the raw JSON for the `content`
    /// array.
    fn tool_response_body(content_json: &str) -> String {
        format!("{{\"content\":{content_json}}}")
    }

    #[test]
    fn tool_turn_advertises_tools_field_in_request_body() {
        // AC #291: the request body carries the tool table under the native
        // anthropic `tools` field, each entry with name + description +
        // input_schema. Mockito body-regex pins the wire shape.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-test")
            .match_body(mockito::Matcher::Regex(r#""name":"run_sql""#.into()))
            .match_body(mockito::Matcher::Regex(r#""input_schema""#.into()))
            .with_status(200)
            .with_body(tool_response_body(r#"[{"type":"text","text":"done"}]"#))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        AnthropicProvider::generate_tool_turn(&cfg, &tool_turn_request("count rows"))
            .expect("tool turn");
        _mock.assert();
    }

    #[test]
    fn tool_turn_parses_tool_use_blocks_into_calls() {
        // AC #291: a response with `tool_use` blocks yields
        // ToolTurnReply::ToolCalls carrying each block's id + name + input
        // (input parsed to a JSON value). Two calls pin multi-call batches.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(tool_response_body(
                r#"[
                    {"type":"tool_use","id":"tu_1","name":"run_sql","input":{"sql":"SELECT 1"}},
                    {"type":"tool_use","id":"tu_2","name":"run_sql","input":{"sql":"SELECT 2"}}
                ]"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        let reply = AnthropicProvider::generate_tool_turn(&cfg, &tool_turn_request("multi"))
            .expect("tool calls");
        match reply {
            ToolTurnReply::ToolCalls(calls) => {
                assert_eq!(calls.len(), 2);
                assert_eq!(calls[0].id, "tu_1");
                assert_eq!(calls[0].name, "run_sql");
                assert_eq!(calls[0].input, serde_json::json!({"sql":"SELECT 1"}));
                assert_eq!(calls[1].id, "tu_2");
            }
            other => panic!("expected ToolCalls, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_round_trips_tool_result_into_user_role() {
        // AC #291: a fed-back ToolResult is serialized as an anthropic
        // tool_result block inside a user turn, paired with its tool_use id;
        // the assistant's prior tool_use is re-sent so the model sees the
        // call/result pairing. Body-regex pins both block types + the id.
        let request = ToolTurnRequest {
            system: "agent".into(),
            messages: vec![
                ToolTurnMessage::user("count rows"),
                ToolTurnMessage::Assistant {
                    text: None,
                    tool_calls: vec![ToolUse {
                        id: "tu_1".into(),
                        name: "run_sql".into(),
                        input: serde_json::json!({"sql":"SELECT 1"}),
                    }],
                },
                ToolTurnMessage::tool_result(ToolResult {
                    tool_use_id: "tu_1".into(),
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
            .mock("POST", "/v1/messages")
            .match_body(mockito::Matcher::Regex(r#""type":"tool_use""#.into()))
            .match_body(mockito::Matcher::Regex(r#""type":"tool_result""#.into()))
            .match_body(mockito::Matcher::Regex(r#""tool_use_id":"tu_1""#.into()))
            .with_status(200)
            .with_body(tool_response_body(r#"[{"type":"text","text":"1 row"}]"#))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match AnthropicProvider::generate_tool_turn(&cfg, &request).expect("text") {
            ToolTurnReply::Text(t) => assert_eq!(t, "1 row"),
            other => panic!("expected Text, got {other:?}"),
        }
        _mock.assert();
    }

    #[test]
    fn tool_turn_bundles_consecutive_tool_results_into_one_user_turn() {
        // Anthropic requires consecutive tool results for one assistant
        // tool-call batch to share a single user turn. Two ToolResults for
        // tu_1/tu_2 must both land in the SAME user message -- pinned by
        // asserting the assistant tool_use block appears exactly once before
        // the tool_result pair (roles strictly alternate user/assistant/user).
        let request = ToolTurnRequest {
            system: "agent".into(),
            messages: vec![
                ToolTurnMessage::user("two queries"),
                ToolTurnMessage::Assistant {
                    text: None,
                    tool_calls: vec![
                        ToolUse {
                            id: "tu_1".into(),
                            name: "run_sql".into(),
                            input: serde_json::json!({"sql":"SELECT 1"}),
                        },
                        ToolUse {
                            id: "tu_2".into(),
                            name: "run_sql".into(),
                            input: serde_json::json!({"sql":"SELECT 2"}),
                        },
                    ],
                },
                ToolTurnMessage::tool_result(ToolResult {
                    tool_use_id: "tu_1".into(),
                    content: "1".into(),
                    is_error: false,
                }),
                ToolTurnMessage::tool_result(ToolResult {
                    tool_use_id: "tu_2".into(),
                    content: "2".into(),
                    is_error: false,
                }),
            ],
            tools: Vec::new(),
            max_tokens: 1024,
        };
        // Reuse the builder directly (no HTTP) to assert the message shape.
        let body = build_tool_turn_body("claude-sonnet-4-6", &request);
        let messages = body.get("messages").unwrap();
        // user(question), assistant(tool_use x2), user(tool_result x2).
        assert_eq!(messages.as_array().unwrap().len(), 3);
        let results_turn = &messages.as_array().unwrap()[2];
        assert_eq!(results_turn["role"], "user");
        let blocks = results_turn["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2, "two tool_results bundled together");
        assert_eq!(blocks[0]["tool_use_id"], "tu_1");
        assert_eq!(blocks[1]["tool_use_id"], "tu_2");
    }

    #[test]
    fn tool_turn_returns_terminal_text_when_no_tool_use() {
        // AC #291: a text-only response (no tool_use) yields the terminal
        // ToolTurnReply::Text -- the model ended the round.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(tool_response_body(
                r#"[{"type":"text","text":"the answer is 42"}]"#,
            ))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        match AnthropicProvider::generate_tool_turn(&cfg, &tool_turn_request("final"))
            .expect("text")
        {
            ToolTurnReply::Text(t) => assert_eq!(t, "the answer is 42"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn tool_turn_empty_response_is_unavailable() {
        // A content array with neither text nor tool_use is a contract
        // violation -> retried Unavailable (mirrors the single-shot path's
        // "no text content" handling).
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(tool_response_body("[]"))
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            AnthropicProvider::generate_tool_turn(&cfg, &tool_turn_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn tool_turn_auth_rejected_is_not_wired() {
        // ADR-0044: 401 -> NotWired (permanent, not retried). Routed via the
        // shared http::classify_send_result helper -- pins that the
        // tool-calling path inherits the same auth classification as the
        // single-shot path.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(401)
            .with_body(r#"{"type":"error","error":{"type":"authentication_error"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-bad"));
        assert_eq!(
            AnthropicProvider::generate_tool_turn(&cfg, &tool_turn_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn tool_turn_server_error_is_unavailable() {
        // A 5xx is transient -> Unavailable (retried by the caller). Pins
        // that the shared classify helper routes 5xx to Unavailable, not
        // NotWired.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .with_status(503)
            .with_body(r#"{"type":"error","error":{"type":"overloaded_error"}}"#)
            .create();
        let cfg = config_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            AnthropicProvider::generate_tool_turn(&cfg, &tool_turn_request("q")),
            Err(ProviderError::Unavailable(_))
        ));
    }

    #[test]
    fn tool_turn_rejects_non_http_base_url_as_invalid_config() {
        // AC #244 / #277 (mirrors the single-shot path): a file:// base_url is
        // rejected before any HTTP call as InvalidConfig -- a permanent config
        // fault, not retried. Pointed at a host that would refuse connection
        // if the gate were bypassed.
        let cfg = config_at("file:///etc/passwd", Some("sk-test"));
        match AnthropicProvider::generate_tool_turn(&cfg, &tool_turn_request("q")) {
            Err(ProviderError::InvalidConfig(msg)) => assert!(
                msg.contains("http/https"),
                "scheme rejection surfaces the http/https policy: {msg}"
            ),
            other => panic!("expected InvalidConfig for bad scheme, got {other:?}"),
        }
    }
}
