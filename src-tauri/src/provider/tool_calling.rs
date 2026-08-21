//! Protocol-neutral tool-calling types (ADR-0081, issue #291).
//!
//! These types carry one round of a native tool-calling conversation between
//! the app and the LLM, independent of the wire protocol. The agent loop
//! (issue #295) assembles a [`ToolTurnRequest`] from the windowed context plus
//! the active tool table; [`crate::provider::LiveProvider`] routes it to the
//! matching adapter ([`super::anthropic::AnthropicProvider`] /
//! [`super::openai::OpenaiProvider`]), which translates it into its own
//! native tool-calling wire shape (anthropic `tools` + `tool_use` /
//! `tool_result` blocks; openai `tools` + `tool_calls` / `tool` role). The
//! reply is either a batch of tool invocations to execute or the model's
//! final text answer.
//!
//! Coexists with the single-shot SQL contract (ADR-0009): the legacy
//! [`super::Provider::generate`] path and its [`super::ProviderRequest`] /
//! [`super::ProviderReply`] types are unchanged. ADR-0077 retires the
//! single-SQL contract in favor of tool-calling turns; this module is the
//! tool-calling foundation the agent loop (issue #295) will drive.
//!
//! ADR-0029 invariant 3 holds: the request never carries the API key -- the
//! adapter reads it from the config source in the Rust core, same as the
//! single-shot path. ADR-0044 error classification is unchanged: HTTP 401/403
//! still maps to [`super::ProviderError::NotWired`], transient failures to
//! [`super::ProviderError::Unavailable`].

use serde_json::Value;

/// One tool the agent may invoke (ADR-0076 aggregated gateway surface).
/// `input_schema` is a JSON Schema object describing the tool's parameters;
/// both wire protocols carry it verbatim (anthropic `input_schema`, openai
/// `parameters`), so the app-side gateway owns the canonical schema and each
/// adapter only renames the field.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    /// A JSON Schema object describing the tool's input. Held as
    /// [`serde_json::Value`] (not a typed schema struct) because tools come
    /// from heterogeneous sources (built-in DuckDB tools, user MCP servers,
    /// skill-declared tools) whose schemas are already JSON -- a typed
    /// wrapper would only re-validate what the source already guarantees.
    pub input_schema: Value,
}

/// A tool invocation the model requested on one round. `input` is the JSON
/// value the model supplied; both protocols carry it as JSON (anthropic
/// `tool_use.input` object, openai `tool_calls.function.arguments` string
/// that the adapter parses back into a value), so it is held protocol-neutral
/// here and each adapter serializes it for its wire shape.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolUse {
    /// The id the model assigned; the matching [`ToolResult`] cites it so the
    /// model can pair each result with its request across wire protocols.
    pub id: String,
    pub name: String,
    pub input: Value,
}

/// One tool execution result fed back to the model. `is_error` flags a
/// tool-level failure (SQL error, approval denial, MCP fault) so the model
/// can self-correct (ADR-0077: tool errors route back to the agent, not into
/// blind retry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolResult {
    pub tool_use_id: String,
    /// The tool's output, serialized as a string. Both wire protocols carry
    /// tool results as text content (anthropic `tool_result.content`, openai
    /// `tool` message `content`); structured payloads are JSON-encoded by the
    /// gateway before they reach here.
    pub content: String,
    pub is_error: bool,
}

/// One message in a tool-calling conversation (ADR-0081). Protocol-neutral:
/// each adapter translates the sequence into its own wire shape. Roles
/// follow the model's own turn structure -- `User` is an app/model input,
/// `Assistant` is the model's prior output (text and/or tool calls),
/// `ToolResult` is a tool outcome routed back.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolTurnMessage {
    /// A user / app input turn (the asking question, or a follow-up).
    User { content: String },
    /// The model's prior output: optional prose plus zero or more tool calls.
    /// A terminal assistant turn carries text and no tool calls; an
    /// intermediate turn carries tool calls (and optional reasoning prose the
    /// model emitted alongside).
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolUse>,
    },
    /// One tool execution result routed back to the model. The agent loop
    /// emits one `ToolResult` per executed call; consecutive `ToolResult`s
    /// for the same assistant tool-call batch are grouped by the per-adapter
    /// builder (anthropic bundles them into one user turn; openai emits one
    /// `tool` message each).
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
}

impl ToolTurnMessage {
    /// Convenience constructor for a plain user turn.
    pub fn user(content: impl Into<String>) -> Self {
        Self::User {
            content: content.into(),
        }
    }

    /// Convenience constructor for a single tool result fed back.
    pub fn tool_result(result: ToolResult) -> Self {
        Self::ToolResult {
            tool_use_id: result.tool_use_id,
            content: result.content,
            is_error: result.is_error,
        }
    }
}

/// The request for one tool-calling turn (ADR-0081, issue #291). Assembled by
/// the agent loop from the windowed context plus the active tool table; sent
/// to [`super::Provider::generate_tool_turn`] once per round-trip (the loop
/// re-feeds an extended conversation after each tool batch returns).
#[derive(Debug, Clone, PartialEq)]
pub struct ToolTurnRequest {
    /// The system prompt (capability boundary + locale directive + tool-use
    /// policy). Owned by the agent loop, not the provider -- the adapter only
    /// carries it verbatim onto the wire.
    pub system: String,
    /// The in-progress conversation, oldest first. Begins with a [`ToolTurnMessage::User`]
    /// turn (the question); each assistant tool-call batch is followed by the
    /// matching `ToolResult`(s); the final round ends with the model's text
    /// reply, which is returned as [`ToolTurnReply::Text`] (not appended
    /// here).
    pub messages: Vec<ToolTurnMessage>,
    /// The tool table to advertise this turn. Empty means "no tools" -- the
    /// model replies with text only.
    pub tools: Vec<ToolDefinition>,
    /// Reply length cap; mirrors the single-shot adapters' `MAX_TOKENS`.
    pub max_tokens: u32,
}

/// One tool-calling turn reply (ADR-0081, issue #291). Either the model
/// requested one or more tool invocations (the agent loop executes them and
/// re-feeds the results), or it produced its final text answer (the loop
/// terminates and the text rides the turn's terminal outcome).
#[derive(Debug, Clone, PartialEq)]
pub enum ToolTurnReply {
    /// The model requested these tool invocations. The agent loop executes
    /// each (via the gateway), collects [`ToolResult`]s, appends this
    /// assistant turn plus the result turns to the conversation, and issues
    /// the next [`ToolTurnRequest`].
    ///
    /// `text` is the round's connective prose (ADR-0103, issue #608): text
    /// the model emitted alongside the batch. The loop re-feeds it on the
    /// assistant message (both wire protocols accept text + tool calls in
    /// one assistant turn) and records it as the trace round's prose.
    /// `None` when the reply carried tool calls and no text.
    ToolCalls {
        text: Option<String>,
        calls: Vec<ToolUse>,
    },
    /// The model's terminal text answer. No tool calls -- the conversation
    /// ends here. Carried verbatim to the turn outcome.
    Text(String),
}

impl ToolTurnReply {
    /// Convenience constructor for a tool-call batch with no connective
    /// prose -- the common scripted/test shape (a real adapter reply that
    /// carried text constructs the struct variant explicitly).
    pub fn tool_calls(calls: Vec<ToolUse>) -> Self {
        Self::ToolCalls { text: None, calls }
    }

    /// Construct a tool-call batch with its connective prose, normalizing an
    /// empty string to `None` (issue #617): the adapters' parse points route
    /// through here so the empty-text -> no-prose contract lives once -- a
    /// later construction site passing a parsed `Some("")` cannot emit an
    /// empty `RoundText` event and persist `"text": ""` in the recipe round.
    pub fn tool_calls_with(text: Option<String>, calls: Vec<ToolUse>) -> Self {
        debug_assert!(
            !calls.is_empty(),
            "a ToolCalls batch carries at least one call"
        );
        Self::ToolCalls {
            text: text.filter(|t| !t.is_empty()),
            calls,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The convenience constructors produce the same shape as the explicit
    /// struct literal -- a regression guard so a later refactor of `user` /
    /// `tool_result` cannot silently change the wire-relevant fields.
    #[test]
    fn user_constructor_matches_explicit_variant() {
        let m = ToolTurnMessage::user("count rows");
        assert_eq!(
            m,
            ToolTurnMessage::User {
                content: "count rows".into()
            }
        );
    }

    #[test]
    fn tool_result_constructor_matches_explicit_variant() {
        let m = ToolTurnMessage::tool_result(ToolResult {
            tool_use_id: "tu_1".into(),
            content: "42".into(),
            is_error: false,
        });
        assert_eq!(
            m,
            ToolTurnMessage::ToolResult {
                tool_use_id: "tu_1".into(),
                content: "42".into(),
                is_error: false,
            }
        );
    }

    /// Issue #617: the empty-string -> None prose normalization lives in the
    /// constructor (not at each parse point), so a later construction site
    /// passing a parsed `Some("")` cannot emit an empty `RoundText` event
    /// and persist `"text": ""` in the recipe round.
    #[test]
    fn tool_calls_with_normalizes_empty_text_to_none() {
        let calls = || {
            vec![ToolUse {
                id: "tu_1".into(),
                name: "explore".into(),
                input: Value::Null,
            }]
        };
        assert_eq!(
            ToolTurnReply::tool_calls_with(Some(String::new()), calls()),
            ToolTurnReply::ToolCalls {
                text: None,
                calls: calls(),
            }
        );
        assert_eq!(
            ToolTurnReply::tool_calls_with(None, calls()),
            ToolTurnReply::ToolCalls {
                text: None,
                calls: calls(),
            }
        );
        assert_eq!(
            ToolTurnReply::tool_calls_with(Some("先看一眼数据。".into()), calls()),
            ToolTurnReply::ToolCalls {
                text: Some("先看一眼数据。".into()),
                calls: calls(),
            }
        );
    }

    /// The protocol-neutral types are plain data: equality is field-wise, so
    /// a round-trip through clone preserves identity (matters because the
    /// agent loop will clone turns to extend the conversation).
    #[test]
    fn tool_use_and_definition_are_fieldwise_equal_after_clone() {
        let tool = ToolDefinition {
            name: "run_sql".into(),
            description: "run read-only SQL".into(),
            input_schema: serde_json::json!({"type": "object"}),
        };
        let call = ToolUse {
            id: "tu_1".into(),
            name: "run_sql".into(),
            input: serde_json::json!({"q": "SELECT 1"}),
        };
        assert_eq!(tool.clone(), tool);
        assert_eq!(call.clone(), call);
    }
}
