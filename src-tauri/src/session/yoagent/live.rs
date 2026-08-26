//! Production provider construction + the app-provider bridge (issue #669,
//! ADR-0107 Decision 2): the wiring seam's single entry. Live facts (a
//! profile-backed provider, [`crate::provider::LiveProvider`]) construct the
//! REAL upstream provider -- sealed here, so the wiring point names no
//! upstream type (the #669 encapsulation AC). Anything else (the scripted
//! test fake, [`crate::provider::UnwiredProvider`]) bridges onto the loop's
//! stream surface verbatim, so the offline test corpus keeps driving turn
//! execution through the SAME loop the production path runs -- one runtime,
//! no second execution path (ADR-0107's single-track rule).
//!
//! Error encoding: the bridge has no upstream error variant for the app's
//! `InvalidConfig`, so it writes [`super::INVALID_CONFIG_PREFIX`] into the
//! upstream error channel and `derive_reply_termination` strips it back --
//! both sides in this module tree, one contract. `NotWired` rides the
//! upstream `Auth` variant (its Display carries the "Auth error" prefix the
//! classification already matches), `Unavailable` the verbatim `Other`
//! variant. None of the three are upstream-retryable (`is_retryable` covers
//! only RateLimited/Network), so the loop surfaces each on its first
//! round-trip exactly as the built-in adapters did (ADR-0044: no blind
//! retry).

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use yoagent::provider::{
    AnthropicProvider as UpstreamAnthropic, ModelConfig, OpenAiCompatProvider as UpstreamOpenAi,
    ProviderError as UpstreamError, StreamConfig, StreamEvent, StreamProvider,
};
use yoagent::types::{AgentMessage, Content, Message};

use crate::model::Protocol;
use crate::provider::tool_calling::{
    ThinkingBlock, ToolDefinition, ToolTurnMessage, ToolTurnOutcome, ToolTurnReply,
    ToolTurnRequest, ToolUse,
};
use crate::provider::{Provider, ProviderError, TurnModelFacts};
use crate::session::agent_loop::Termination;

use super::model_config::{resolve_yoagent_model, thought_level_id, ResolvedYoagentModel};
use super::{YoagentLoop, INVALID_CONFIG_PREFIX};

/// Build the per-turn runner from an app provider object (the wiring seam's
/// single entry, issue #669). `Err` carries the turn's terminal outcome for
/// a facts resolution that refused before any round-trip -- a keyless
/// profile (`NotWired`) or a non-http base (`InvalidConfig`) -- with the
/// same vocabulary the adapters surfaced pre-swap; the caller lands it as a
/// zero-round-trip `LoopOutcome`.
pub(crate) fn turn_loop_for(provider: Arc<dyn Provider>) -> Result<YoagentLoop, Termination> {
    match provider.turn_model_facts() {
        Some(facts) => live_loop(facts),
        None => Ok(bridged_loop(provider)),
    }
}

/// Construct the real upstream provider + resolved model from live facts.
/// The resolution (`resolve_yoagent_model`) applies the same base-url scheme
/// gate and key-presence check the built-in adapters ran per turn, so a
/// refused configuration surfaces identically (ADR-0044 classification,
/// ADR-0029 key handling).
fn live_loop(facts: TurnModelFacts) -> Result<YoagentLoop, Termination> {
    let resolved =
        resolve_yoagent_model(facts.protocol, &facts.base_url, &facts.model, facts.api_key)
            .map_err(termination_for)?;
    Ok(YoagentLoop::new(live_streamer(facts.protocol), resolved))
}

/// The upstream provider for a protocol -- both are zero-sized stream
/// clients (the endpoint, model, and key ride the per-call `StreamConfig`,
/// built from the resolved `ModelConfig`), so the only protocol-dependent
/// state is the type itself.
fn live_streamer(protocol: Protocol) -> Arc<dyn StreamProvider> {
    match protocol {
        Protocol::Anthropic => Arc::new(UpstreamAnthropic),
        Protocol::Openai => Arc::new(UpstreamOpenAi),
    }
}

/// Map a refused facts resolution onto its terminal vocabulary.
fn termination_for(err: ProviderError) -> Termination {
    match err {
        ProviderError::NotWired => Termination::NotWired,
        ProviderError::InvalidConfig(detail) => Termination::InvalidConfig(detail),
        // resolve_yoagent_model never yields Unavailable; the arm keeps the
        // mapping total rather than panicking on a future variant mix.
        ProviderError::Unavailable(detail) => Termination::Transient(detail),
    }
}

/// The bridge's inert model identity: the loop stamps it onto every
/// `StreamConfig` it builds, but the bridge ignores it -- the app provider
/// behind the bridge reads its own configuration. Named so the sentinel
/// cannot be mistaken for a real endpoint by a future reader.
const BRIDGE_MODEL_ID: &str = "app-provider";
const BRIDGE_API_KEY: &str = "unused";

/// Bridge a facts-less provider (the scripted fake, `UnwiredProvider`) onto
/// the loop with the inert placeholder model config above.
fn bridged_loop(provider: Arc<dyn Provider>) -> YoagentLoop {
    let placeholder = ResolvedYoagentModel {
        config: ModelConfig::anthropic(BRIDGE_MODEL_ID, BRIDGE_MODEL_ID),
        api_key: BRIDGE_API_KEY.into(),
    };
    YoagentLoop::new(Arc::new(ProviderBridge { inner: provider }), placeholder)
}

/// The stream-surface adapter over an app `Provider` object: each upstream
/// `stream` call is one `generate_tool_turn` round-trip, translated in both
/// directions. Whole-message per call (no deltas) -- the app provider
/// contract is one synchronous reply, so the bridge emits the pair of
/// lifecycle events the upstream loop expects and returns the translated
/// message, the same shape the offline `ScriptedProvider` takes.
struct ProviderBridge {
    inner: Arc<dyn Provider>,
}

#[async_trait]
impl StreamProvider for ProviderBridge {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        _cancel: tokio_util::sync::CancellationToken,
    ) -> Result<Message, UpstreamError> {
        let request = bridge_request(&config);
        // Synchronous on the driver thread: the bridged providers are
        // in-memory scripts (the live HTTP path goes through the upstream
        // streamers instead), so blocking here parks only the loop.
        match self.inner.generate_tool_turn(&request) {
            Ok(outcome) => {
                let message = outcome_to_upstream_message(outcome);
                // `.ok()`: the lifecycle events are advisory -- a receiver
                // already gone (the run was cancelled) just means nobody is
                // listening, and the return value still carries the reply.
                tx.send(StreamEvent::Start).ok();
                tx.send(StreamEvent::Done {
                    message: message.clone(),
                })
                .ok();
                Ok(message)
            }
            // No events on the fault path -- the loop's error handling (the
            // same branch a real upstream `Err` takes) builds the terminal
            // Error-stop message from the Display text.
            Err(err) => Err(bridge_error(err)),
        }
    }
}

/// Translate the upstream per-call config back onto the app request shape.
/// The upstream messages are exactly what [`super::convert_messages`]
/// produced plus what the loop itself appended (assistant replies, tool
/// results), so the inverse below is total for that vocabulary.
fn bridge_request(config: &StreamConfig) -> ToolTurnRequest {
    ToolTurnRequest {
        system: config.system_prompt.clone(),
        messages: upstream_messages_to_app(&config.messages),
        tools: config
            .tools
            .iter()
            .map(|t| ToolDefinition {
                name: t.name.clone(),
                description: t.description.clone(),
                input_schema: t.parameters.clone(),
            })
            .collect(),
        // The loop always sets the cap from the window assembly's value; the
        // default only covers a hand-built test config.
        max_tokens: config.max_tokens.unwrap_or_default(),
        thought_level: thought_level_id(config.thinking_level).map(str::to_string),
    }
}

/// Inverse of [`super::convert_messages`]: upstream messages onto the app
/// conversation. The loop presents the LLM message form here (the agent-
/// message wrapper never rides a `StreamConfig`), so every message maps --
/// except the loop's own injected User turns (the loop-detection steering
/// nudge, the stop marker), which have no app carrier and are dropped so the
/// bridged conversation stays identical to what the self-written loop fed a
/// bridged provider pre-swap. They are recognized structurally, not by
/// wording: in the app's window shape a user message only ever follows an
/// assistant turn (the history alternates user/assistant and the window
/// closes with the asking question), so a user message directly after a tool
/// result can only be an upstream injection.
fn upstream_messages_to_app(messages: &[Message]) -> Vec<ToolTurnMessage> {
    let mut converted = Vec::with_capacity(messages.len());
    for m in messages {
        match m {
            Message::User { content, .. } => {
                let follows_tool_result =
                    matches!(converted.last(), Some(ToolTurnMessage::ToolResult { .. }));
                if follows_tool_result {
                    continue;
                }
                converted.push(ToolTurnMessage::User {
                    content: join_text(content),
                });
            }
            Message::Assistant { content, .. } => {
                let mut text: Option<String> = None;
                let mut thinking = Vec::new();
                let mut tool_calls = Vec::new();
                for block in content {
                    match block {
                        Content::Thinking {
                            thinking: t,
                            signature,
                            ..
                        } => {
                            // The forward map sent a redacted block as an
                            // unsigned thinking block; an unsigned block
                            // reads back as redacted -- the only app
                            // carrier for signature-less reasoning.
                            thinking.push(match signature {
                                Some(sig) => ThinkingBlock::Thinking {
                                    thinking: t.clone(),
                                    signature: sig.clone(),
                                },
                                None => ThinkingBlock::Redacted { data: t.clone() },
                            });
                        }
                        Content::Text { text: t } => {
                            text = Some(match text.take() {
                                Some(prev) => prev + t,
                                None => t.clone(),
                            });
                        }
                        Content::ToolCall {
                            id,
                            name,
                            arguments,
                            ..
                        } => tool_calls.push(ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: arguments.clone(),
                        }),
                        // The app conversation carries no images; a future
                        // upstream block variant has no app carrier and is
                        // dropped rather than failing the translation (the
                        // text + tool-call surface is what the window rides).
                        _ => {}
                    }
                }
                converted.push(ToolTurnMessage::Assistant {
                    text,
                    tool_calls,
                    thinking,
                });
            }
            Message::ToolResult {
                tool_call_id,
                content,
                is_error,
                ..
            } => converted.push(ToolTurnMessage::ToolResult {
                tool_use_id: tool_call_id.clone(),
                content: join_text(content),
                is_error: *is_error,
            }),
        }
    }
    converted
}

/// The text of a content block list, concatenated in order.
fn join_text(content: &[Content]) -> String {
    content
        .iter()
        .filter_map(|c| match c {
            Content::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// Translate the app reply onto the upstream assistant message -- by
/// construction the exact shape [`super::convert_messages`] produces for
/// the same turn (the forward map IS the translation), so the loop's
/// re-feed round-trips bit-for-bit through both directions.
fn outcome_to_upstream_message(outcome: ToolTurnOutcome) -> Message {
    let (text, tool_calls) = match outcome.reply {
        ToolTurnReply::Text(text) => (Some(text), Vec::new()),
        ToolTurnReply::ToolCalls { text, calls } => (text, calls),
    };
    let turn = ToolTurnMessage::Assistant {
        text,
        tool_calls,
        thinking: outcome.thinking,
    };
    match super::convert_messages(&[turn]).pop() {
        Some(AgentMessage::Llm(message)) => message,
        // One assistant message converts to exactly one LLM message.
        _ => unreachable!("the Assistant arm pushes exactly one Llm message"),
    }
}

/// Encode an app provider fault onto the upstream error channel. Each
/// variant lands non-retryable upstream, so the loop surfaces it on the
/// first round-trip; `derive_reply_termination` reads the Display text back
/// into the terminal vocabulary (see the module doc).
fn bridge_error(err: ProviderError) -> UpstreamError {
    match err {
        ProviderError::NotWired => UpstreamError::Auth("not wired: no api key configured".into()),
        ProviderError::InvalidConfig(detail) => {
            UpstreamError::Other(format!("{INVALID_CONFIG_PREFIX}: {detail}"))
        }
        // Verbatim: `Other`'s Display is the payload itself, so the surfaced
        // transient detail matches the built-in adapters' wording.
        ProviderError::Unavailable(detail) => UpstreamError::Other(detail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ProviderReply, ProviderRequest};
    use yoagent::provider::ApiProtocol;

    /// A profile-backed provider double: reports fixed facts (the factory
    /// path) and refuses any actual call -- nothing under test dials out.
    struct FactsProvider {
        facts: TurnModelFacts,
    }

    impl Provider for FactsProvider {
        fn generate(&self, _request: &ProviderRequest) -> Result<ProviderReply, ProviderError> {
            Err(ProviderError::NotWired)
        }
        fn turn_model_facts(&self) -> Option<TurnModelFacts> {
            Some(self.facts.clone())
        }
    }

    fn facts(protocol: Protocol, base_url: &str, key: Option<&str>) -> Arc<FactsProvider> {
        Arc::new(FactsProvider {
            facts: TurnModelFacts {
                protocol,
                base_url: base_url.into(),
                model: "m".into(),
                api_key: key.map(str::to_string),
            },
        })
    }

    /// The protocol selects the real upstream streamer -- the #669
    /// encapsulation AC's construction half, pinned at the seam's own table.
    #[test]
    fn anthropic_facts_select_the_anthropic_streamer() {
        let streamer = live_streamer(Protocol::Anthropic);
        assert_eq!(streamer.protocol(), Some(ApiProtocol::AnthropicMessages));
    }

    #[test]
    fn openai_facts_select_the_openai_streamer() {
        let streamer = live_streamer(Protocol::Openai);
        assert_eq!(streamer.protocol(), Some(ApiProtocol::OpenAiCompletions));
    }

    /// A keyless profile refuses as NotWired before any round-trip -- the
    /// configure-key signal, the same vocabulary the adapters surfaced
    /// pre-swap (ADR-0029).
    #[test]
    fn a_keyless_profile_refuses_as_not_wired() {
        let provider = facts(Protocol::Anthropic, "https://api.anthropic.com", None);
        match turn_loop_for(provider) {
            Err(Termination::NotWired) => {}
            Err(other) => panic!("expected NotWired, got {other:?}"),
            Ok(_) => panic!("expected NotWired, got a runner"),
        }
    }

    /// A non-http scheme refuses as InvalidConfig with the shared diagnosis
    /// vocabulary (issue #277), before any round-trip.
    #[test]
    fn a_non_http_base_refuses_as_invalid_config() {
        let provider = facts(Protocol::Openai, "file:///etc/passwd", Some("sk-test"));
        match turn_loop_for(provider) {
            Err(Termination::InvalidConfig(detail)) => {
                assert!(detail.contains("scheme"), "{detail}");
            }
            Err(other) => panic!("expected InvalidConfig, got {other:?}"),
            Ok(_) => panic!("expected InvalidConfig, got a runner"),
        }
    }

    /// The bridge rebuilds the app request from the upstream config: the
    /// round-trip through `convert_messages` and back lands the conversation
    /// bit-for-bit -- thinking (signed + redacted), connective prose, tool
    /// batch identity, tool result pairing.
    #[test]
    fn bridge_request_inverts_convert_messages() {
        let app = vec![
            ToolTurnMessage::user("count rows"),
            ToolTurnMessage::Assistant {
                text: Some("checking".into()),
                tool_calls: vec![ToolUse {
                    id: "tu_1".into(),
                    name: "materialize".into(),
                    input: serde_json::json!({"sql": "SELECT 1"}),
                }],
                thinking: vec![
                    ThinkingBlock::Thinking {
                        thinking: "reason".into(),
                        signature: "sig".into(),
                    },
                    ThinkingBlock::Redacted {
                        data: "opaque".into(),
                    },
                ],
            },
            ToolTurnMessage::ToolResult {
                tool_use_id: "tu_1".into(),
                content: "42".into(),
                is_error: false,
            },
        ];
        let mut config = StreamConfig::new("m", "k");
        config.messages = super::super::convert_messages(&app)
            .iter()
            .filter_map(|m| m.as_llm().cloned())
            .collect();
        assert_eq!(bridge_request(&config).messages, app);
    }

    /// The bridge's reply translation equals the forward conversion of the
    /// same assistant turn: the loop's re-feed (which runs the forward map)
    /// and the bridge's own emission agree, so a bridged multi-round turn
    /// never sees two shapes for one turn.
    #[test]
    fn bridge_message_matches_the_forward_conversion() {
        let thinking = vec![
            ThinkingBlock::Thinking {
                thinking: "reason".into(),
                signature: "sig".into(),
            },
            ThinkingBlock::Redacted {
                data: "opaque".into(),
            },
        ];
        let calls = vec![ToolUse {
            id: "tu_1".into(),
            name: "materialize".into(),
            input: serde_json::json!({"sql": "SELECT 1"}),
        }];
        let bridged = outcome_to_upstream_message(ToolTurnOutcome {
            thinking: thinking.clone(),
            reply: ToolTurnReply::tool_calls_with(Some("prose".into()), calls.clone()),
        });
        let forward = super::super::convert_messages(&[ToolTurnMessage::Assistant {
            text: Some("prose".into()),
            tool_calls: calls,
            thinking,
        }]);
        // Compare through serialization: the upstream Message carries fields
        // (timestamps, usage) with no PartialEq, and the invariant under
        // test is the on-the-wire shape, which is the serialized one. The
        // timestamp is stripped first -- `Message::assistant` stamps
        // wall-clock now, so two constructions a millisecond apart would
        // otherwise flake the comparison.
        let strip_timestamp = |mut v: serde_json::Value| {
            if let Some(map) = v.as_object_mut() {
                map.remove("timestamp");
            }
            v
        };
        let bridged_json =
            strip_timestamp(serde_json::to_value(&bridged).expect("bridged serializes"));
        let forward_json = strip_timestamp(
            serde_json::to_value(forward[0].as_llm().expect("llm form"))
                .expect("forward serializes"),
        );
        assert_eq!(bridged_json, forward_json);
    }

    /// The three fault encodings land non-retryable with exactly the
    /// prefixes the terminal classification reads back -- NotWired via the
    /// upstream Auth wording, InvalidConfig via the module prefix,
    /// Unavailable verbatim.
    #[test]
    fn bridge_error_encodes_all_three_faults_non_retryable() {
        let not_wired = bridge_error(ProviderError::NotWired);
        assert!(!not_wired.is_retryable());
        assert!(not_wired.to_string().starts_with("Auth error"));

        let invalid = bridge_error(ProviderError::InvalidConfig(
            "scheme `file` is not http/https".into(),
        ));
        assert!(!invalid.is_retryable());
        assert_eq!(
            invalid.to_string(),
            "Invalid config: scheme `file` is not http/https"
        );

        let unavailable = bridge_error(ProviderError::Unavailable("connection reset".into()));
        assert!(!unavailable.is_retryable());
        assert_eq!(unavailable.to_string(), "connection reset");
    }
}
