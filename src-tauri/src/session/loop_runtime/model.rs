//! The completion-model bridge (ADR-0116, issue #917 -- the borrow-the-
//! kernel shape of Decision 2): adapts an
//! app [`Provider`] (the scripted fake / `UnwiredProvider`) onto rig's
//! [`CompletionModel`] trait -- whole messages, no deltas, the same shape the
//! yoagent layer's `ProviderBridge` gave its upstream loop. Each `completion`
//! call is one `generate_tool_turn` round-trip translated in both
//! directions; `stream` synthesizes the same reply as a committed-block
//! event sequence (one event per content block + the terminal record), the
//! minimum the streaming driver needs to assemble a turn.
//!
//! Threading: the app provider contract is synchronous and blocking, so the
//! call rides `spawn_blocking` -- the driver's single-threaded runtime never
//! carries the gateway's synchronous work (the same hop the yoagent adapter
//! makes for dispatches).

use futures::Stream;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use rig_core::completion::{
    CompletionError, CompletionModel, CompletionRequest, CompletionResponse, Message, Usage,
};
use rig_core::message::{AssistantContent, Reasoning, ReasoningContent, ToolCall, ToolFunction};
use rig_core::streaming::{
    RawStreamingChoice, StreamFinal, StreamingCompletionResponse, StreamingResult,
};
use rig_core::ProviderResponseError;

use crate::provider::tool_calling::{
    ThinkingBlock, ToolDefinition as AppToolDefinition, ToolTurnMessage, ToolTurnReply,
    ToolTurnRequest,
};
use crate::provider::{Provider, ProviderError};

/// Stable provider descriptor stamped onto every response this bridge emits
/// (diagnostic identity only -- no client of it exists yet, but the response
/// surface requires one).
const BRIDGE_PROVIDER: &str = "app-provider";

/// The provider-response error body prefix encoding an app `InvalidConfig`
/// fault: the bridge writes it, the terminal classification strips it back
/// into `Termination::InvalidConfig` -- both sides live in this module tree,
/// so the contract cannot drift (the same write/read pairing the yoagent
/// layer's `INVALID_CONFIG_PREFIX` has). `NotWired` needs no encoding: the
/// bridge raises it as an honest HTTP 401 provider-response error, which the
/// status-based classification (ADR-0116 Decision 5) already maps to
/// `NotWired` -- the same rule that covers live rig providers.
pub(crate) const INVALID_CONFIG_PREFIX: &str = "invalid config: ";

/// The reply-length floor when the request carried no cap (rig leaves
/// `max_tokens` optional; the app's own adapters always sent one).
const DEFAULT_MAX_TOKENS: u32 = 4096;

/// The bridge: an app provider object seen as a rig completion model.
pub(crate) struct ProviderCompletionModel {
    inner: Arc<dyn Provider>,
}

impl ProviderCompletionModel {
    pub(crate) fn new(inner: Arc<dyn Provider>) -> Self {
        Self { inner }
    }

    /// One round-trip: rig request in, app provider called, rig response out.
    async fn round_trip(
        &self,
        request: CompletionRequest,
    ) -> Result<CompletionResponse, CompletionError> {
        let app_request = to_app_request(&request);
        let inner = Arc::clone(&self.inner);
        let outcome = tokio::task::spawn_blocking(move || inner.generate_tool_turn(&app_request))
            .await
            .expect("provider bridge task cannot panic: the provider surface returns Result");
        match outcome {
            Ok(reply) => Ok(from_app_outcome(reply)),
            Err(err) => Err(to_completion_error(err)),
        }
    }
}

impl CompletionModel for ProviderCompletionModel {
    fn completion(
        &self,
        request: CompletionRequest,
    ) -> impl std::future::Future<Output = Result<CompletionResponse, CompletionError>> + Send {
        self.round_trip(request)
    }

    async fn stream(
        &self,
        request: CompletionRequest,
    ) -> Result<StreamingCompletionResponse, CompletionError> {
        let response = self.round_trip(request).await?;
        // Synthesize the non-streaming reply as a raw-choice event
        // sequence: one event per content block, then the terminal record
        // the accumulator requires. Block-level ids are synthetic (the app
        // provider carries none) but stable within the reply -- reasoning
        // parts of one block share a key, and a tool call's wire id doubles
        // as its accumulation key, exactly the identity contract real wires
        // honor.
        let mut events: Vec<RawStreamingChoice> = Vec::with_capacity(response.choice.len() + 1);
        for (index, block) in response.choice.iter().enumerate() {
            match block {
                AssistantContent::Text(text) => {
                    events.push(RawStreamingChoice::Message(text.text.clone()));
                }
                AssistantContent::Reasoning(reasoning) => {
                    let key = format!("bridge-reasoning-{index}");
                    for part in &reasoning.content {
                        events.push(RawStreamingChoice::Reasoning {
                            id: key.clone().into(),
                            provider_id: None,
                            content: part.clone(),
                        });
                    }
                }
                AssistantContent::ToolCall(call) => {
                    events.push(RawStreamingChoice::ToolCall(
                        rig_core::streaming::RawStreamingToolCall::new(
                            call.wire_call_id().to_string(),
                            call.function.name.clone(),
                            call.function.arguments.clone(),
                        ),
                    ));
                }
                // The app provider never emits images; a future block kind
                // degrades to a dropped event rather than a broken stream
                // (the turn still assembles off the Final record).
                AssistantContent::Image(_) => {}
            }
        }
        events.push(RawStreamingChoice::FinalResponse(StreamFinal::new(
            BRIDGE_PROVIDER,
            response.usage,
        )));
        Ok(StreamingCompletionResponse::stream(
            BRIDGE_PROVIDER,
            SingleShotStream { events }.boxed(),
        ))
    }
}

/// A pre-computed event queue as a stream: yields each item once, then ends.
/// The whole reply is already materialized (whole-message bridging), so
/// polling only drains.
struct SingleShotStream {
    events: Vec<RawStreamingChoice>,
}

impl Stream for SingleShotStream {
    type Item = Result<RawStreamingChoice, CompletionError>;

    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.events.first() {
            Some(_) => Poll::Ready(Some(Ok(self.events.remove(0)))),
            None => Poll::Ready(None),
        }
    }
}

/// The single-shot stream pinned into the provider-stream type box.
trait StreamBoxExt:
    Stream<Item = Result<RawStreamingChoice, CompletionError>> + Sized + Send + 'static
{
    fn boxed(self) -> StreamingResult {
        Box::pin(self)
    }
}

impl<S> StreamBoxExt for S where
    S: Stream<Item = Result<RawStreamingChoice, CompletionError>> + Send + 'static
{
}

/// Translate a rig completion request onto the app's protocol-neutral turn
/// request. The system prompt rides rig's `preamble` slot (the loop runtime
/// sets it from `ToolTurnRequest::system`); `thought_level` stays `None` --
/// the app provider behind the bridge reads its own configuration.
fn to_app_request(request: &CompletionRequest) -> ToolTurnRequest {
    ToolTurnRequest {
        system: request.preamble.clone().unwrap_or_default(),
        messages: to_app_messages(&request.chat_history),
        tools: request
            .tools
            .iter()
            .map(|def| AppToolDefinition {
                name: def.name.clone(),
                description: def.description.clone(),
                input_schema: def.parameters.clone(),
            })
            .collect(),
        max_tokens: request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS as u64) as u32,
        thought_level: None,
    }
}

/// rig chat history onto the app message vocabulary. User messages split
/// back apart: a user turn's content list re-expands into the app's
/// per-message shapes (one `User` per text, one `ToolResult` per result
/// block) -- the inverse of the batch merge [`to_rig_history`] performs, so
/// the app provider sees the same conversation the yoagent bridge fed it.
fn to_app_messages(history: &[Message]) -> Vec<ToolTurnMessage> {
    let mut converted = Vec::with_capacity(history.len());
    for message in history {
        match message {
            Message::System { content } => {
                // The preamble is the system-prompt carrier; a System
                // message in history (not one this runtime writes) degrades
                // to a user turn so no instruction silently vanishes.
                converted.push(ToolTurnMessage::User {
                    content: content.clone(),
                });
            }
            Message::User { content } => {
                for block in content {
                    match block {
                        rig_core::message::UserContent::Text(text) => {
                            converted.push(ToolTurnMessage::User {
                                content: text.text.clone(),
                            });
                        }
                        rig_core::message::UserContent::ToolResult(result) => {
                            converted.push(ToolTurnMessage::ToolResult {
                                tool_use_id: result.call.as_str().to_string(),
                                content: text_of_result(result),
                                // rig's result shape has no error flag: an
                                // error IS its content text (the stance our
                                // tool callbacks take), so the flag stays
                                // false and the text carries the semantics.
                                is_error: false,
                            });
                        }
                        // The app vocabulary carries no image/audio/video/
                        // document user content; the bridge never produces
                        // any, and one arriving here degrades quietly.
                        _ => {}
                    }
                }
            }
            Message::Assistant { content, .. } => {
                let mut text: Option<String> = None;
                let mut tool_calls = Vec::new();
                let mut thinking = Vec::new();
                for block in content {
                    match block {
                        AssistantContent::Text(t) => {
                            text = Some(match text {
                                None => t.text.clone(),
                                Some(mut joined) => {
                                    joined.push_str(&t.text);
                                    joined
                                }
                            });
                        }
                        AssistantContent::ToolCall(call) => {
                            tool_calls.push(crate::provider::tool_calling::ToolUse {
                                id: call.wire_call_id().to_string(),
                                name: call.function.name.clone(),
                                input: call.function.arguments.clone(),
                            });
                        }
                        AssistantContent::Reasoning(reasoning) => {
                            for part in &reasoning.content {
                                match part {
                                    ReasoningContent::Text { text, signature } => {
                                        thinking.push(ThinkingBlock::Thinking {
                                            thinking: text.clone(),
                                            signature: signature.clone().unwrap_or_default(),
                                        });
                                    }
                                    ReasoningContent::Encrypted(data)
                                    | ReasoningContent::Redacted { data } => {
                                        thinking
                                            .push(ThinkingBlock::Redacted { data: data.clone() });
                                    }
                                    ReasoningContent::Summary(summary) => {
                                        thinking.push(ThinkingBlock::Thinking {
                                            thinking: summary.clone(),
                                            signature: String::new(),
                                        });
                                    }
                                }
                            }
                        }
                        AssistantContent::Image(_) => {}
                    }
                }
                converted.push(ToolTurnMessage::Assistant {
                    text,
                    tool_calls,
                    thinking,
                });
            }
        }
    }
    converted
}

/// The model-facing text of one rig tool result (text blocks joined; a
/// structured-only result renders as its JSON -- the same stringify-everything
/// stance the app gateway takes).
fn text_of_result(result: &rig_core::message::ToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|block| match block {
            rig_core::message::ToolResultContent::Text(text) => Some(text.text.clone()),
            rig_core::message::ToolResultContent::Json { value } => Some(value.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// The app windowed conversation onto rig's chat history. Consecutive
/// `ToolResult` messages from one assistant batch merge into a single rig
/// user message (one `ToolResult` content block each) -- the wire shape
/// every provider builds off this history renders as ONE user turn per
/// batch, the merge the yoagent path never performed and ADR-0116 pins as
/// the diagnostic-probe contract (splitting the blocks across user turns is
/// the >=2-tool-calls 400 fault the replacement exists to root out).
pub(crate) fn to_rig_history(messages: &[ToolTurnMessage]) -> Vec<Message> {
    let mut converted: Vec<Message> = Vec::with_capacity(messages.len());
    let mut pending_results: Vec<rig_core::message::UserContent> = Vec::new();
    for message in messages {
        // Flush any accumulated tool results before a non-result message:
        // they always follow their assistant batch directly, so the flush
        // lands them as one user turn.
        if !matches!(message, ToolTurnMessage::ToolResult { .. }) {
            flush_results(&mut converted, &mut pending_results);
        }
        match message {
            ToolTurnMessage::ToolResult {
                tool_use_id,
                content,
                is_error: _,
            } => {
                // The rig result shape has no error flag: an error IS its
                // content text (the stance the tool callbacks take), so the
                // flag is dropped on the way in.
                pending_results.push(rig_core::message::UserContent::ToolResult(
                    rig_core::message::ToolResult {
                        call: rig_core::message::ToolCallId::new(tool_use_id.clone())
                            .expect("the app vocabulary never carries an empty tool id"),
                        provider: rig_core::message::ProviderCallId::new(tool_use_id.clone()),
                        name: String::new(),
                        content: vec![rig_core::message::ToolResultContent::text(content.clone())],
                    },
                ));
            }
            ToolTurnMessage::User { content } => {
                converted.push(Message::User {
                    content: vec![rig_core::message::UserContent::text(content.clone())],
                });
            }
            ToolTurnMessage::Assistant {
                text,
                tool_calls,
                thinking,
            } => {
                let mut content = Vec::new();
                for block in thinking {
                    match block {
                        ThinkingBlock::Thinking {
                            thinking,
                            signature,
                        } => content.push(AssistantContent::Reasoning(
                            Reasoning::new_with_signature(
                                thinking,
                                if signature.is_empty() {
                                    None
                                } else {
                                    Some(signature.clone())
                                },
                            ),
                        )),
                        ThinkingBlock::Redacted { data } => {
                            content.push(AssistantContent::Reasoning(Reasoning {
                                id: None,
                                content: vec![ReasoningContent::Redacted { data: data.clone() }],
                            }))
                        }
                    }
                }
                if let Some(t) = text {
                    content.push(AssistantContent::text(t.clone()));
                }
                for call in tool_calls {
                    content.push(AssistantContent::ToolCall(ToolCall::from_wire(
                        call.id.clone(),
                        ToolFunction::new(call.name.clone(), call.input.clone()),
                    )));
                }
                converted.push(Message::Assistant { id: None, content });
            }
        }
    }
    flush_results(&mut converted, &mut pending_results);
    converted
}

/// Land the accumulated tool results as one rig user message.
fn flush_results(converted: &mut Vec<Message>, pending: &mut Vec<rig_core::message::UserContent>) {
    if !pending.is_empty() {
        converted.push(Message::User {
            content: std::mem::take(pending),
        });
    }
}

/// The app provider's outcome onto a rig completion response: reasoning
/// blocks, then prose, then tool calls (rig's canonical replay order).
fn from_app_outcome(outcome: crate::provider::tool_calling::ToolTurnOutcome) -> CompletionResponse {
    let mut choice = Vec::new();
    for block in &outcome.thinking {
        match block {
            ThinkingBlock::Thinking {
                thinking,
                signature,
            } => choice.push(AssistantContent::Reasoning(Reasoning::new_with_signature(
                thinking.as_str(),
                if signature.is_empty() {
                    None
                } else {
                    Some(signature.clone())
                },
            ))),
            ThinkingBlock::Redacted { data } => {
                choice.push(AssistantContent::Reasoning(Reasoning {
                    id: None,
                    content: vec![ReasoningContent::Redacted { data: data.clone() }],
                }))
            }
        }
    }
    match outcome.reply {
        ToolTurnReply::Text(text) => choice.push(AssistantContent::text(text)),
        ToolTurnReply::ToolCalls { text, calls } => {
            if let Some(t) = text {
                choice.push(AssistantContent::text(t));
            }
            for call in calls {
                choice.push(AssistantContent::ToolCall(ToolCall::from_wire(
                    call.id,
                    ToolFunction::new(call.name, call.input),
                )));
            }
        }
    }
    CompletionResponse::new(choice, Usage::new(), BRIDGE_PROVIDER)
}

/// The app provider's fault onto a rig completion error. `NotWired` rides an
/// honest HTTP 401 provider-response error (the status the classification
/// maps to `NotWired` for every rig provider); `InvalidConfig` rides HTTP
/// 400 with the prefix the classification strips; everything else is a
/// plain provider error (transient).
fn to_completion_error(err: ProviderError) -> CompletionError {
    match err {
        ProviderError::NotWired => CompletionError::ProviderResponse(ProviderResponseError::new(
            http::StatusCode::UNAUTHORIZED,
            "no LLM provider wired",
        )),
        ProviderError::InvalidConfig(detail) => {
            CompletionError::ProviderResponse(ProviderResponseError::new(
                http::StatusCode::BAD_REQUEST,
                format!("{INVALID_CONFIG_PREFIX}{detail}"),
            ))
        }
        ProviderError::Unavailable(detail) => CompletionError::ProviderError(detail),
    }
}
