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
    ///
    /// `thinking` carries the round's reasoning blocks for the in-turn
    /// re-feed only (issue #614): tool-use continuity requires the last
    /// assistant turn's complete unmodified thinking sequence on the next
    /// same-turn request. Cross-turn history never populates it -- prior
    /// turns re-render as prose (ADR-0023), and the API strips thinking
    /// blocks from earlier turns anyway.
    Assistant {
        text: Option<String>,
        tool_calls: Vec<ToolUse>,
        thinking: Vec<ThinkingBlock>,
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
    /// The session posture's thought-level id riding this turn (ADR-0103,
    /// issue #614), named after the same `AcpTurnInput` field it mirrors.
    /// `None` = no thinking enablement (the status quo). The anthropic
    /// adapter maps known ids onto an extended-thinking budget; unknown ids
    /// and the openai protocol honest-degrade to no thinking at all.
    pub thought_level: Option<String>,
}

/// One reasoning block the model emitted alongside its reply (ADR-0103,
/// issue #614). Protocol-neutral carrier whose field names mirror the
/// anthropic wire shape, so the adapter can echo each block back verbatim on
/// the in-turn assistant re-feed: tool-use continuity requires the last
/// assistant turn's complete unmodified thinking sequence (rearranging or
/// editing blocks breaks the model's own reasoning flow).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ThinkingBlock {
    /// Readable reasoning text plus the opaque pass-back signature. The
    /// signature exists solely for API verification and is never interpreted.
    Thinking { thinking: String, signature: String },
    /// Safety-redacted reasoning: encrypted, unreadable payload. Contributes
    /// no display text but still rides the re-feed (dropping it would break
    /// continuity for the turn it belongs to).
    Redacted { data: String },
}

impl ThinkingBlock {
    /// The readable reasoning text, `None` on a redacted block (which
    /// renders nothing -- honest degrade, the API docs' display guidance).
    pub fn readable_text(&self) -> Option<&str> {
        match self {
            Self::Thinking { thinking, .. } => Some(thinking),
            Self::Redacted { .. } => None,
        }
    }
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
    /// prose -- the common scripted/test shape. Delegates to
    /// [`tool_calls_with`], so the non-empty-calls assertion and the
    /// empty-text normalization cover both constructors.
    pub fn tool_calls(calls: Vec<ToolUse>) -> Self {
        Self::tool_calls_with(None, calls)
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

/// One provider round-trip's full outcome (issue #614, ADR-0103): the reply
/// body plus the reasoning blocks the model emitted alongside it. Thinking
/// rides beside the reply rather than inside it -- the loop consumes the
/// blocks up to three ways (live `ThinkingCompleted` phase + trace round on
/// any reply whose readable text is non-empty; the in-turn assistant
/// re-feed only on a tool-call batch, since a terminal reply ends the
/// conversation), so the blocks are round-level data, not part of either
/// outcome shape.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolTurnOutcome {
    /// The round's reasoning blocks in received order (the wire sequence must
    /// survive the re-feed verbatim). Empty when the runtime produced none.
    pub thinking: Vec<ThinkingBlock>,
    /// The reply proper: a tool-call batch or the terminal text.
    pub reply: ToolTurnReply,
}

impl From<ToolTurnReply> for ToolTurnOutcome {
    /// Wrap a no-thinking reply -- the shape every non-anthropic source and
    /// every thinking-disabled turn produces.
    fn from(reply: ToolTurnReply) -> Self {
        Self {
            thinking: Vec::new(),
            reply,
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

    /// A redacted block yields no readable text (it renders nothing); a
    /// normal thinking block yields its text regardless of the signature.
    #[test]
    fn readable_text_is_none_on_redacted_blocks() {
        assert_eq!(
            ThinkingBlock::Thinking {
                thinking: "plan".into(),
                signature: "sig".into(),
            }
            .readable_text(),
            Some("plan")
        );
        assert_eq!(
            ThinkingBlock::Redacted {
                data: "opaque".into(),
            }
            .readable_text(),
            None
        );
    }

    /// The reply-to-outcome conversion wraps with empty thinking -- the
    /// default shape for every thinking-disabled or non-anthropic turn.
    #[test]
    fn reply_converts_to_outcome_with_empty_thinking() {
        let outcome: ToolTurnOutcome = ToolTurnReply::Text("done".into()).into();
        assert_eq!(outcome.thinking, Vec::new());
        assert_eq!(outcome.reply, ToolTurnReply::Text("done".into()));
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
