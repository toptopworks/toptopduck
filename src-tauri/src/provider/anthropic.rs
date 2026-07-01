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
//! Blocking HTTP (ureq) fits the sync [`Provider::generate`] contract: the
//! orchestrator runs `ask` on a `spawn_blocking` thread, so no async runtime is
//! pulled in and the turn stays cancellable at the flag-check between attempts.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::model::{ChartKind, TextKind, VizSpec};
use crate::provider::keychain::ProviderConfigSource;
use crate::provider::prompt::{render_schema_context, CAPABILITY_BOUNDARY_PROMPT};
use crate::provider::{
    Provider, ProviderError, ProviderReply, ProviderRequest, ResponsePayload, TurnPayload,
};

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

/// The real Claude client behind the [`Provider`] trait (ADR-0007). Holds a
/// [`ProviderConfigSource`] for per-turn key + endpoint + model reads (live, no
/// caching); tests inject [`StaticConfig`], production wires
/// [`KeychainStore`](super::keychain::KeychainStore).
pub struct AnthropicProvider {
    config: Box<dyn ProviderConfigSource>,
}

impl AnthropicProvider {
    /// Wire the provider with a key/config source. Production passes the shared
    /// keychain store; tests pass a fixed [`StaticConfig`].
    pub fn new(config: Box<dyn ProviderConfigSource>) -> Self {
        Self { config }
    }
}

impl Provider for AnthropicProvider {
    fn generate(&self, request: &ProviderRequest) -> Result<ProviderReply, ProviderError> {
        // ADR-0029 invariant 3: the key is fetched here, in the Rust core, per
        // turn. Absent key -> NotWired (permanent for this turn, not retried) --
        // the orchestrator surfaces it as a failed turn prompting configuration.
        let key = self.config.api_key().ok_or(ProviderError::NotWired)?;
        let base_url = self.config.base_url();
        let model = self.config.model();
        let url = format!("{base}/v1/messages", base = base_url.trim_end_matches('/'));

        let system = String::from(CAPABILITY_BOUNDARY_PROMPT) + &render_schema_context(request);
        let body = AnthropicRequest {
            model: &model,
            max_tokens: MAX_TOKENS,
            system,
            messages: build_messages(request),
        };
        // serde_json::to_value only fails on non-finite floats / depth limits;
        // our body is plain strings, so this is defensive.
        let body_value = serde_json::to_value(&body)
            .map_err(|e| ProviderError::Unavailable(format!("请求序列化失败：{e}")))?;

        let response = ureq::post(&url)
            .set("x-api-key", &key)
            .set("anthropic-version", ANTHROPIC_VERSION)
            .timeout(REQUEST_TIMEOUT)
            .send_json(body_value);

        let response = match response {
            Ok(r) => r,
            // Auth rejected (bad/missing key seen by the server, or forbidden):
            // permanent for this turn -- map to NotWired so it is NOT retried
            // (three 401s would only burn time). The user sees a configure-key
            // prompt via the NotWired message.
            Err(ureq::Error::Status(status, _)) if status == 401 || status == 403 => {
                return Err(ProviderError::NotWired);
            }
            // Transport error, 5xx, or a 4xx other than auth: transient/retryable
            // -- the orchestrator consumes the single retry budget, then fails.
            Err(e) => {
                return Err(ProviderError::Unavailable(format!("LLM 调用失败：{e}")));
            }
        };

        let raw: RawResponse = response
            .into_json()
            .map_err(|e| ProviderError::Unavailable(format!("响应读取失败：{e}")))?;
        // The model's JSON contract rides the first text block. Anthropic may
        // also emit tool-use / other blocks; we asked for text-only JSON, so a
        // missing text block is a contract violation -> retried Unavailable.
        let text = raw
            .content
            .iter()
            .find_map(|b| (b.kind == "text").then(|| b.text.clone()).flatten())
            .ok_or_else(|| ProviderError::Unavailable("LLM 响应无文本内容".into()))?;
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

#[derive(Serialize)]
struct Message {
    role: &'static str,
    content: String,
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
                let note = match result {
                    Some(name) => format!("（该轮已生成结果 {name}）"),
                    None => "（该轮未生成结果）".to_string(),
                };
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

/// Render a prior turn's [`ResponsePayload`] as the assistant message text the
/// model sees in its own history (ADR-0023 point 1: recent turns ship the
/// provider's prior response). Human-readable, not the raw JSON the model
/// emitted -- the model reasons over summarized context, not its own wire form.
fn render_response(r: &ResponsePayload) -> String {
    match r {
        ResponsePayload::Materialized {
            result,
            sql,
            assumption,
        } => {
            let mut s = format!("（已生成结果 {result}）");
            if let Some(sql) = sql {
                s.push_str(" SQL：");
                s.push_str(sql);
            }
            if let Some(a) = assumption {
                s.push_str(" 方法/假设：");
                s.push_str(a);
            }
            s
        }
        ResponsePayload::Textual {
            kind,
            body,
            assumption,
        } => {
            let tag = match kind {
                TextKind::Clarify => "反问",
                TextKind::Refuse => "越界拒绝",
            };
            let mut s = format!("（上一步：{tag}）{body}");
            if let Some(a) = assumption {
                s.push_str(" 说明：");
                s.push_str(a);
            }
            s
        }
        ResponsePayload::Failed { reason } => {
            format!("（上一步失败：{reason}）")
        }
        ResponsePayload::Cancelled => "（上一步已取消）".to_string(),
    }
}

/// Parse the model's reply text into [`ProviderReply`] (ADR-0009 contract). The
/// model is instructed to emit exactly one JSON object; this defensively
/// tolerates surrounding prose / markdown fences by extracting the outermost
/// `{...}` span first. Any deviation -> [`ProviderError::Unavailable`] (the
/// orchestrator retries, then fails the turn honestly).
fn parse_reply(text: &str) -> Result<ProviderReply, ProviderError> {
    let json_str = extract_json_object(text).ok_or_else(|| {
        ProviderError::Unavailable(format!("LLM 响应不是 JSON 对象：{}", truncate(text)))
    })?;
    let val: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| ProviderError::Unavailable(format!("JSON 解析失败：{e}")))?;
    let kind = val
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ProviderError::Unavailable("LLM 响应缺少 type 字段".into()))?;
    match kind {
        "sql" => {
            let sql = val
                .get("sql")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ProviderError::Unavailable("sql 响应缺少 sql 字段".into()))?;
            let viz = parse_viz(val.get("viz"))?;
            let assumption = val
                .get("assumption")
                .and_then(|v| v.as_str())
                .map(String::from);
            Ok(ProviderReply::Sql {
                sql: sql.to_string(),
                viz,
                assumption,
            })
        }
        "text" => {
            let body = val
                .get("body")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ProviderError::Unavailable("text 响应缺少 body 字段".into()))?;
            let kind_str = val
                .get("kind")
                .and_then(|v| v.as_str())
                .ok_or_else(|| ProviderError::Unavailable("text 响应缺少 kind 字段".into()))?;
            let text_kind = match kind_str {
                "clarify" => TextKind::Clarify,
                "refuse" => TextKind::Refuse,
                other => {
                    return Err(ProviderError::Unavailable(format!("未知文本类型：{other}")));
                }
            };
            let assumption = val
                .get("assumption")
                .and_then(|v| v.as_str())
                .map(String::from);
            Ok(ProviderReply::Text {
                kind: text_kind,
                body: body.to_string(),
                assumption,
            })
        }
        other => Err(ProviderError::Unavailable(format!("未知响应类型：{other}"))),
    }
}

/// Parse the optional viz field (`{"kind":..., "spec":...}`) into [`VizSpec`].
/// A non-whitelisted kind is a contract violation (retried), matching the
/// engine-side whitelist enforcement (ADR-0016/0033).
fn parse_viz(v: Option<&serde_json::Value>) -> Result<Option<VizSpec>, ProviderError> {
    let Some(v) = v else {
        return Ok(None);
    };
    if v.is_null() {
        return Ok(None);
    }
    let kind_str = v
        .get("kind")
        .and_then(|x| x.as_str())
        .ok_or_else(|| ProviderError::Unavailable("viz 缺少 kind 字段".into()))?;
    let kind = match kind_str {
        "bar" => ChartKind::Bar,
        "line" => ChartKind::Line,
        "scatter" => ChartKind::Scatter,
        "area" => ChartKind::Area,
        "pie" => ChartKind::Pie,
        "table" => ChartKind::Table,
        other => {
            return Err(ProviderError::Unavailable(format!("未知图表类型：{other}")));
        }
    };
    let spec = v
        .get("spec")
        .and_then(|x| x.as_str())
        .ok_or_else(|| ProviderError::Unavailable("viz 缺少 spec 字段".into()))?;
    Ok(Some(VizSpec {
        kind,
        spec: spec.to_string(),
    }))
}

/// Extract the outermost `{...}` span from `text`, tolerating markdown fences
/// or surrounding prose. Returns the inclusive substring, or `None` when no
/// brace pair is present.
fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end >= start {
        Some(&text[start..=end])
    } else {
        None
    }
}

/// Truncate a string for an error message (avoid flooding the user / log with a
/// long malformed model reply).
fn truncate(s: &str) -> String {
    const LIMIT: usize = 200;
    if s.len() <= LIMIT {
        s.to_string()
    } else {
        format!("{}…", &s[..LIMIT])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::keychain::StaticConfig;
    use crate::provider::{ColumnRef, DatasetRef};

    /// Build a provider whose key/endpoint/model are fixed and point at a
    /// mockito server URL (no OS keychain, no real network).
    fn provider_at(url: &str, key: Option<&str>) -> AnthropicProvider {
        AnthropicProvider::new(Box::new(StaticConfig {
            key: key.map(str::to_string),
            base_url: url.to_string(),
            model: "claude-sonnet-4-6".to_string(),
        }))
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
        let p = provider_at(&server.url(), Some("sk-test"));
        let reply = p.generate(&sample_request("多少行")).expect("sql reply");
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
        let p = provider_at(&server.url(), Some("sk-test"));
        match p.generate(&sample_request("画图")).unwrap() {
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
        let p = provider_at(&server.url(), Some("sk-test"));
        match p.generate(&sample_request("汇总")).unwrap() {
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
        let p = provider_at(&server.url(), Some("sk-test"));
        match p.generate(&sample_request("预测下季度")).unwrap() {
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
        let p = provider_at("http://127.0.0.1:1", None);
        assert_eq!(
            p.generate(&sample_request("q")).unwrap_err(),
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
        let p = provider_at(&server.url(), Some("sk-bad"));
        assert_eq!(
            p.generate(&sample_request("q")).unwrap_err(),
            ProviderError::NotWired
        );
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
        let p = provider_at(&server.url(), Some("sk-test"));
        match p.generate(&sample_request("q")) {
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
        let p = provider_at(&server.url(), Some("sk-test"));
        assert!(matches!(
            p.generate(&sample_request("q")),
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
        let p = provider_at(&server.url(), Some("sk-test"));
        match p.generate(&sample_request("q")).unwrap() {
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
        let p = provider_at(&server.url(), Some("sk-test"));
        p.generate(&sample_request("多少行")).expect("reply");
        _mock.assert(); // matched model + role + auth headers
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
    fn extract_json_object_handles_prose_and_fences() {
        assert_eq!(extract_json_object(r#"{"a":1}"#), Some(r#"{"a":1}"#));
        assert_eq!(
            extract_json_object("prefix ```json\n{\"a\":1}\n``` suffix"),
            Some(r#"{"a":1}"#)
        );
        assert_eq!(extract_json_object("no braces here"), None);
    }
}
