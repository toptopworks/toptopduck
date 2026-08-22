//! ACP v1 wire types (ADR-0081, issue #299).
//!
//! The JSON-RPC 2.0 + Agent Client Protocol v1 subset the adapter engine drives.
//! Field names + variant tags are frozen by the ACP v1 schema
//! (<https://agentclientprotocol.com/protocol/v1/schema>); renaming any
//! `#[serde(rename = ...)]` / variant breaks on-the-wire compatibility with
//! real CLI agents (gemini-cli / codex).
//!
//! Only the methods + shapes the engine sends or receives are modeled. The
//! schema's full surface (terminal/*, fs/*, session modes, plan entries, image
//! / audio / resource-link content) is out of scope for the v1 engine: an
//! unknown `session/update` kind degrades to [`SessionUpdate::Other`] and is
//! ignored, so a newer agent emitting a new update kind does not break the
//! engine. ACP's reserved `_meta` map is skipped everywhere (the spec forbids
//! assuming anything about its values).
//!
//! Framing: ACP over stdio uses newline-delimited JSON (one JSON-RPC message
//! per line). The engine reads stdout line-by-line and writes stdin + flush
//! per message; the fake-CLI fixture uses the same framing (test seam C).
//!
//! Roles: the **app is the ACP client**, the **CLI agent is the ACP server**
//! (it also serves JSON-RPC requests like `session/request_permission` back to
//! the client). Per ADR-0076, the CLI's tools are reached through a separate
//! thin bridge process (the CLI's MCP stdio server, launched BY the CLI per the
//! MCP transport contract) -- that bridge lands in slice 9b.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/// ACP protocol version (uint16, bumped only for breaking changes). The engine
/// negotiates v1 with the agent at [`InitializeParams::protocol_version`].
pub const PROTOCOL_VERSION: u16 = 1;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelopes
// ---------------------------------------------------------------------------

/// A JSON-RPC request id. ACP allows string / number / null; the engine mints
/// monotonic numeric ids (simplest, and the agent echoes them verbatim in its
/// response so the engine can correlate).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RequestId {
    /// A numeric id (the engine's only minted form).
    Num(u64),
    /// A string id (an agent-initiated request may carry one).
    Str(String),
    /// JSON `null` (allowed by the spec but never minted by this engine).
    Null,
}

/// A JSON-RPC 2.0 request (app → agent). Carries method-tagged params.
/// `jsonrpc` / `method` are owned `String`s so the type round-trips through
/// serde (`&'static str` does not impl `Deserialize<'de>` -- borrowed input
/// cannot yield a `'static` reference); constructors still take `&'static str`
/// for compile-time-known method names.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request<P> {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    pub params: P,
}

impl<P> Request<P> {
    /// Build a request with the fixed `"2.0"` jsonrpc marker.
    pub fn new(id: RequestId, method: &'static str, params: P) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        }
    }
}

/// A JSON-RPC 2.0 notification (either direction; no id, no response).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification<P> {
    pub jsonrpc: String,
    pub method: String,
    pub params: P,
}

impl<P> Notification<P> {
    /// Build a notification with the fixed `"2.0"` jsonrpc marker.
    pub fn new(method: &'static str, params: P) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        }
    }
}

/// A JSON-RPC 2.0 error object (spec section 5.1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A JSON-RPC 2.0 response. Exactly one of `result` / `error` is set; the id
/// echoes the request's. Modeled with both optional so a malformed peer message
/// deserializes rather than rejects -- the engine treats a response carrying
/// neither as an error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response<R> {
    pub jsonrpc: String,
    pub id: RequestId,
    // No `#[serde(default)]` here: serde's derive on a generic Option<R> field
    // would add a spurious `R: Default` bound; an absent field already defaults
    // to None for Option (serde's built-in behavior), so the attribute is both
    // redundant and harmful on a generic payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<R>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

// ---------------------------------------------------------------------------
// initialize (app → agent, request)
// ---------------------------------------------------------------------------

/// `initialize` request params. The client (app) advertises its protocol
/// version + a minimal client-info block; the agent responds with its own.
/// The engine advertises no client capabilities (fs / terminal) -- the agent
/// must not ask the app to run filesystem or terminal operations; the only
/// tool surface is the MCP bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u16,
    pub client_info: Implementation,
}

/// `initialize` response result. The engine only reads `protocol_version` --
/// the agent's capabilities (loadSession, image, etc.) do not change the v1
/// driving shape (the engine never calls the optional methods).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_info: Option<Implementation>,
}

/// A client/agent implementation descriptor (name + version + optional title).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Implementation {
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl Implementation {
    /// The engine's own client_info name (advertised at initialize).
    pub const CLIENT_NAME: &'static str = "toptopduck";

    /// Build the engine's client_info block.
    pub fn client() -> Self {
        Self {
            name: Self::CLIENT_NAME.to_string(),
            // Crate version, baked at compile time. Mirrors the Cargo manifest.
            version: env!("CARGO_PKG_VERSION").to_string(),
            title: None,
        }
    }
}

// ---------------------------------------------------------------------------
// session/new (app → agent, request)
// ---------------------------------------------------------------------------

/// `session/new` params. Per ADR-0076/0081 each turn mints a fresh session: the
/// engine injects the bridge as the single stdio MCP server (`mcp_servers`) and
/// the working directory (`cwd`). The full windowed context is carried by the
/// subsequent `session/prompt`, NOT here (ACP keeps session setup separate from
/// the user message). The model / thought-level selections do NOT ride here
/// either (ADR-0095: `NewSessionRequest` carries no model field, schema 0.13.8)
/// -- the engine injects them via `session/set_config_option` after the
/// handshake.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionParams {
    pub cwd: String,
    pub mcp_servers: Vec<McpServer>,
}

/// `session/new` result. `session_id` drives the turn; `config_options` is
/// the raw ACP config catalog (ADR-0095: transparent `Value` passthrough --
/// the engine extracts model / thought_level entries at the handshake
/// boundary, the full ConfigOption type hierarchy stays unmodeled). Mode
/// state is ignored (the engine does not drive session modes).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResult {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Value>,
}

// ---------------------------------------------------------------------------
// session/prompt (app → agent, request) -- the turn driver
// ---------------------------------------------------------------------------

/// `session/prompt` params. `blocks` carries the full windowed context for this
/// turn (the question + the assembled history), as text content blocks. ADR-0076
/// statelessness: the engine sends the WHOLE context every turn -- it never
/// relies on an upstream session handle (`session/load` is deliberately unused).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptParams {
    pub session_id: String,
    pub blocks: Vec<ContentBlock>,
}

/// `session/prompt` result. `stop_reason` is the agent's terminal verdict on
/// this turn; the engine maps it onto [`crate::session::agent_loop::Termination`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResult {
    pub stop_reason: StopReason,
}

/// Why the agent stopped the turn (ACP `StopReason`). Serialized as a bare
/// lowercase string by the `rename_all` so it matches the schema's enum form.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// The turn ended successfully (terminal agent message emitted).
    Success,
    /// The agent hit its own max-tokens ceiling.
    MaxTokens,
    /// The agent hit its own max-turns ceiling.
    MaxTurns,
    /// The agent refused to continue.
    Refusal,
    /// The client cancelled via `session/cancel`.
    Cancelled,
}

// ---------------------------------------------------------------------------
// session/cancel (app → agent, notification)
// ---------------------------------------------------------------------------

/// `session/cancel` notification params. The agent SHOULD abort in-flight work
/// and respond to the original `session/prompt` with
/// [`StopReason::Cancelled`]. The engine sends this on user cancel, the
/// wall-clock watchdog, or its own step-cap trip, then SIGTERMs the agent if it
/// does not return promptly (ADR-0081 cancel = 整轮中止).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub session_id: String,
}

// ---------------------------------------------------------------------------
// session/update (agent → app, notification) -- the streaming surface
// ---------------------------------------------------------------------------

/// `session/update` notification params. The agent streams its progress as a
/// sequence of these; the engine folds them into the execution trace
/// (ADR-0078) + the terminal agent text. The `session_id` echoes the turn's.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdateParams {
    pub session_id: String,
    pub update: SessionUpdate,
}

/// One `session/update` payload. Modeled as an internally-tagged union on
/// `sessionUpdate` -- the discriminator of the ACP schema crate 0.13.8 v1
/// (verified against its own serialization fixtures, issue #611). Only the
/// variants the engine consumes are named; an unknown kind deserializes to
/// [`SessionUpdate::Other`] (forward compatibility with newer agents).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "sessionUpdate",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionUpdate {
    /// A chunk of the agent's streamed response text. Grouped per round into
    /// the trace prose + accumulated for the terminal text (ADR-0103,
    /// issue #611).
    AgentMessageChunk {
        /// ACP carries `messageId`; the engine ignores it (one terminal message
        /// per turn is the v1 contract).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        /// The schema's `ContentChunk` carries ONE content block, not an
        /// array. A non-text block folds nothing (the engine's only consumed
        /// form is text).
        content: ContentBlock,
    },
    /// A chunk of the agent's internal reasoning (issue #611). Accumulated per
    /// round and folded into a thinking-complete block at the round boundary;
    /// an agent that never emits thoughts degrades honestly (no fold, no
    /// error).
    AgentThoughtChunk {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        /// ONE content block, same `ContentChunk` shape as the message chunk.
        content: ContentBlock,
    },
    /// A new tool call started. Maps to a `ToolCallStarted` phase event + opens
    /// a trace row.
    ToolCall {
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default)]
        status: ToolCallStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kind: Option<ToolKind>,
        #[serde(default)]
        content: Vec<ToolCallContent>,
    },
    /// An update on an existing tool call (status transition, content, title).
    /// The engine matches it by `tool_call_id` and folds the final
    /// [`ToolCallStatus::Completed`] / [`ToolCallStatus::Failed`] into the
    /// trace row opened by [`SessionUpdate::ToolCall`].
    ToolCallUpdate {
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<ToolCallStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default)]
        content: Vec<ToolCallContent>,
    },
    /// Any other update kind (user_message_chunk, plan,
    /// available_commands_update, current_mode_update, config_option_update,
    /// session_info_update, usage_update). Ignored by the engine.
    #[serde(other)]
    Other,
}

/// Tool-call lifecycle status (ACP `ToolCallStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    /// Awaiting input streaming or approval.
    #[default]
    Pending,
    /// Currently running.
    InProgress,
    /// Completed successfully.
    Completed,
    /// Failed with an error.
    Failed,
}

/// Tool category (ACP `ToolKind`). Presentation-only -- maps to an
/// [`crate::approval::OperationKind`] badge for the trace. The variant set
/// mirrors the schema crate 0.13.8 v1 (its own `ToolKind` carries ten
/// variants with `Read`/`Delete` included), and an unknown kind degrades to
/// `Other` rather than failing the whole update's parse -- the schema's own
/// forward-compatibility default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    /// Any kind a newer agent sends that this enum does not model yet.
    #[serde(other)]
    Other,
}

impl ToolKind {
    /// Map an ACP tool kind to the approval-card operation badge
    /// (ADR-0083 read/write/execute/network). Coarse by design -- the badge is
    /// presentation-only; the gateway does not branch on it.
    pub fn to_operation_kind(self) -> crate::approval::OperationKind {
        use crate::approval::OperationKind as Op;
        match self {
            Self::Read | Self::Search | Self::Think | Self::SwitchMode | Self::Other => Op::Read,
            Self::Edit | Self::Move | Self::Delete => Op::Write,
            Self::Execute => Op::Execute,
            Self::Fetch => Op::Network,
        }
    }
}

// ---------------------------------------------------------------------------
// session/request_permission (agent → app, request)
// ---------------------------------------------------------------------------

/// `session/request_permission` params. The agent asks the client to authorize a
/// tool call. ADR-0081 maps this to the gateway policy via
/// [`crate::approval::classify`]: the engine selects an auto-permitted
/// option, or fail-fasts (rejects / cancels) when none is selectable -- ACP
/// carries no interactive confirmation channel (that path is the MCP-side
/// approval card, ADR-0080).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPermissionParams {
    pub session_id: String,
    pub tool_call: PermissionToolCall,
    pub options: Vec<PermissionOption>,
}

/// `session/request_permission` response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestPermissionResult {
    pub outcome: RequestPermissionOutcome,
}

/// The tool-call descriptor a permission request carries. A subset of the full
/// [`SessionUpdate::ToolCall`] shape -- only the fields the engine reads
/// (title + kind + id) to derive a [`crate::approval::ToolKey`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolCall {
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ToolKind>,
}

/// One selectable permission option.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PermissionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<PermissionOptionKind>,
}

/// The kind of a permission option (allow / reject, once / always).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
}

impl PermissionOptionKind {
    /// Whether this option permits the call (vs rejecting it).
    pub fn is_allow(self) -> bool {
        matches!(self, Self::AllowOnce | Self::AllowAlways)
    }
}

/// The client's answer to a permission request. Either the user (here: the
/// gateway policy) selected an option, or the turn was cancelled.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RequestPermissionOutcome {
    /// The turn was cancelled before an answer (the engine sends this on
    /// cancel / close).
    Cancelled,
    /// An option was selected (the engine picks an auto-allowed option, or a
    /// reject option on fail-fast).
    Selected { option_id: String },
}

// ---------------------------------------------------------------------------
// Content blocks + MCP server descriptor
// ---------------------------------------------------------------------------

/// A content block (ACP `ContentBlock`). The engine sends only text blocks (the
/// windowed context); it RECEIVES text blocks inside `agent_message_chunk`. The
/// image / audio / resource_link / resource variants are not produced by the v1
/// engine and deserialize to [`ContentBlock::Other`] if an agent emits them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// A text block. The payload is the prompt chunk / answer chunk text.
    Text { text: String },
    /// Any other content variant (image, audio, resource_link, resource).
    /// Ignored by the v1 engine when received; never sent.
    #[serde(other)]
    Other,
}

impl ContentBlock {
    /// Build a text content block (the engine's only minted form).
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text { text: text.into() }
    }

    /// If this is a text block, return its text; else None.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text { text } => Some(text),
            Self::Other => None,
        }
    }
}

/// An MCP server descriptor injected at `session/new`. The engine injects the
/// bridge as a stdio server (the CLI launches it per the MCP transport
/// contract). The http / sse variants are not produced by the v1 engine and
/// deserialize to [`McpServer::Other`] if a future caller emits one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpServer {
    /// A stdio MCP server. `command` is the absolute path of the bridge
    /// executable; `args` / `env` carry the session-addressing parameter
    /// (slice 9b).
    Stdio {
        name: String,
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    /// Any other transport (http / sse). Not produced by the v1 engine.
    #[serde(other)]
    Other,
}

impl McpServer {
    /// Build a stdio MCP server descriptor for the bridge.
    pub fn stdio_bridge(
        name: impl Into<String>,
        command: impl Into<String>,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    ) -> Self {
        Self::Stdio {
            name: name.into(),
            command: command.into(),
            args,
            env,
        }
    }
}

/// One item of a tool call's `content` collection (ACP `ToolCallContent`). The
/// engine reads only the text inside `Content` for the trace excerpt; diffs and
/// terminals are folded into [`ToolCallContent::Other`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolCallContent {
    /// A standard content block (text / image / resource).
    Content { content: ContentBlock },
    /// A diff or terminal reference. Ignored by the v1 trace mapping.
    #[serde(other)]
    Other,
}

impl ToolCallContent {
    /// Concatenate the text of all `Content { Text }` items in `items`,
    /// bounded to `max` chars (the trace excerpt cap). Returns an empty string
    /// when there is no text content (a non-text tool output is summarized by
    /// its absence).
    pub fn collect_text(items: &[Self], max: usize) -> String {
        let mut buf = String::new();
        // A CHAR budget, not a byte budget: `truncate_trace_excerpt` caps by
        // chars, so the early exit must too -- a byte check would cut
        // multi-byte content (CJK) at ~1/3 of the visible cap and diverge
        // from the full concatenate-then-truncate result (issue #629). The
        // budget is max + 1: the final truncate only emits its ellipsis when
        // the buffer EXCEEDS max, so the exit must land one char past.
        let mut remaining = max + 1;
        'outer: for item in items {
            if let Self::Content {
                content: ContentBlock::Text { text },
            } = item
            {
                if !buf.is_empty() && remaining > 0 {
                    buf.push('\n');
                    remaining -= 1;
                }
                for ch in text.chars() {
                    if remaining == 0 {
                        break 'outer;
                    }
                    buf.push(ch);
                    remaining -= 1;
                }
            }
        }
        crate::session::agent_loop::truncate_trace_excerpt(&buf, max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frozen wire form of the externally-tagged unions matches the ACP
    /// schema's `type`-discriminator + snake_case spelling. A regression here
    /// breaks on-the-wire compatibility with real agents.
    #[test]
    fn content_block_text_serializes_with_type_tag() {
        let block = ContentBlock::text("hello");
        let v: Value = serde_json::to_value(&block).unwrap();
        assert_eq!(v["type"], "text");
        assert_eq!(v["text"], "hello");
    }

    /// collect_text stops concatenating once the excerpt budget is surely
    /// exceeded (issue #629): blocks after the crossing cannot change the
    /// result, so the bounded form returns exactly what a full
    /// concatenate-then-truncate would produce.
    #[test]
    fn collect_text_exits_early_past_the_budget() {
        let items = vec![
            ToolCallContent::Content {
                content: ContentBlock::text("a".repeat(200)),
            },
            ToolCallContent::Content {
                content: ContentBlock::text("b".repeat(500)),
            },
            ToolCallContent::Content {
                content: ContentBlock::text("tail"),
            },
        ];
        let got = ToolCallContent::collect_text(&items, 240);
        // 200 a's + newline + 38 b's + ellipsis = the truncated head of the
        // full concatenation; the third block never reaches the result.
        let want = format!("{}\n{}…", "a".repeat(200), "b".repeat(38));
        assert_eq!(got, want);
        assert!(got.chars().count() <= 240);
    }

    /// The early exit counts CHARS, not bytes (issue #629 review): CJK
    /// blocks are 3 bytes per char, and a byte check would cut the excerpt
    /// at ~1/3 of the visible cap and diverge from the full
    /// concatenate-then-truncate result.
    #[test]
    fn collect_text_char_budget_not_bytes() {
        let items = vec![
            ToolCallContent::Content {
                content: ContentBlock::text("中".repeat(200)),
            },
            ToolCallContent::Content {
                content: ContentBlock::text("文".repeat(100)),
            },
        ];
        let got = ToolCallContent::collect_text(&items, 240);
        // 200 中 + newline + 38 文 + ellipsis = the char-truncated head of
        // the 301-char concatenation.
        let want = format!("{}\n{}…", "中".repeat(200), "文".repeat(38));
        assert_eq!(got, want);
        assert_eq!(got.chars().count(), 240);
    }

    /// The session/update payload discriminates on `sessionUpdate` (the
    /// schema crate 0.13.8 v1 shape, issue #611's schema verification) and a
    /// ContentChunk carries ONE content block, not an array. The JSON below is
    /// byte-for-byte the schema crate's own serialization test fixture -- the
    /// authoritative real-agent wire form. A regression here breaks every
    /// `session/update` against a real agent (the line fails to parse and the
    /// pump drops it silently).
    #[test]
    fn agent_message_chunk_matches_schema_wire_shape() {
        let raw = serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": "msg_agent_c42b9",
            "content": {"type": "text", "text": "Hello"},
        });
        let update: SessionUpdate =
            serde_json::from_value(raw.clone()).expect("schema shape must parse");
        match &update {
            SessionUpdate::AgentMessageChunk {
                message_id,
                content,
            } => {
                assert_eq!(message_id.as_deref(), Some("msg_agent_c42b9"));
                assert_eq!(content.as_text(), Some("Hello"));
            }
            other => panic!("expected AgentMessageChunk, got {other:?}"),
        }
        // Round-trip: our serialization is the same shape we parse.
        let v: Value = serde_json::to_value(&update).unwrap();
        assert_eq!(v, raw);
    }

    /// The agent_thought_chunk variant exists in the schema crate 0.13.8 v1
    /// (issue #611's verification conclusion) and shares the ContentChunk
    /// shape: optional `messageId` + ONE content block. `messageId` is
    /// optional on the wire -- a chunk without one must still parse.
    #[test]
    fn agent_thought_chunk_round_trips_schema_shape() {
        let raw = serde_json::json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "weighing options"},
        });
        let update: SessionUpdate =
            serde_json::from_value(raw.clone()).expect("thought chunk must parse");
        match &update {
            SessionUpdate::AgentThoughtChunk {
                message_id,
                content,
            } => {
                assert_eq!(message_id, &None, "messageId absent -> None");
                assert_eq!(content.as_text(), Some("weighing options"));
            }
            other => panic!("expected AgentThoughtChunk, got {other:?}"),
        }
        let v: Value = serde_json::to_value(&update).unwrap();
        assert_eq!(v, raw);
    }

    #[test]
    fn mcp_server_stdio_serializes_with_type_tag_and_fields() {
        let server = McpServer::stdio_bridge(
            "toptopduck-gateway",
            "/abs/path/to/bridge",
            vec!["--session".into()],
            BTreeMap::from([("SID".to_string(), "abc".to_string())]),
        );
        let v: Value = serde_json::to_value(&server).unwrap();
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["name"], "toptopduck-gateway");
        assert_eq!(v["command"], "/abs/path/to/bridge");
        assert_eq!(v["args"][0], "--session");
        assert_eq!(v["env"]["SID"], "abc");
    }

    /// stop_reason round-trips to the ACP lowercase wire form.
    #[test]
    fn stop_reason_round_trips_to_snake_case() {
        for (reason, spelling) in [
            (StopReason::Success, "success"),
            (StopReason::MaxTokens, "max_tokens"),
            (StopReason::MaxTurns, "max_turns"),
            (StopReason::Refusal, "refusal"),
            (StopReason::Cancelled, "cancelled"),
        ] {
            let s = serde_json::to_string(&reason).unwrap();
            assert_eq!(s, format!("\"{spelling}\""));
            let back: StopReason = serde_json::from_str(&s).unwrap();
            assert_eq!(back, reason);
        }
    }

    /// An unknown session/update kind degrades to `Other` instead of rejecting
    /// the whole message -- forward compatibility with newer agents. The kind
    /// rides the `sessionUpdate` discriminator (the schema crate 0.13.8 v1
    /// shape, issue #611).
    #[test]
    fn unknown_session_update_kind_degrades_to_other() {
        let raw = serde_json::json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "usage_update",
                "contextWindow": 200000,
                "tokensUsed": 42,
            },
        });
        let params: SessionUpdateParams =
            serde_json::from_value(raw).expect("unknown update kind must not reject");
        assert_eq!(params.update, SessionUpdate::Other);
    }

    /// A tool_call update deserializes with the discriminated shape.
    #[test]
    fn tool_call_update_deserializes_fields() {
        let raw = serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "tc_1",
            "status": "completed",
            "title": "explore SELECT 1",
            "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}],
        });
        let update: SessionUpdate = serde_json::from_value(raw).unwrap();
        match update {
            SessionUpdate::ToolCallUpdate {
                tool_call_id,
                status,
                title,
                content,
            } => {
                assert_eq!(tool_call_id, "tc_1");
                assert_eq!(status, Some(ToolCallStatus::Completed));
                assert_eq!(title.as_deref(), Some("explore SELECT 1"));
                assert_eq!(content.len(), 1);
            }
            other => panic!("expected ToolCallUpdate, got {other:?}"),
        }
    }

    /// ToolKind mirrors the schema crate 0.13.8 v1 variant set: `read` and
    /// `delete` parse (a schema-legal kind must never fail the whole
    /// update's parse), an unknown kind degrades to `Other`, and the badge
    /// mapping lands read-class and write-class respectively.
    #[test]
    fn tool_kind_read_delete_parse_and_degrade() {
        let parse = |s: &str| serde_json::from_str::<ToolKind>(s).expect("kind must parse");
        assert_eq!(parse("\"read\""), ToolKind::Read);
        assert_eq!(parse("\"delete\""), ToolKind::Delete);
        assert_eq!(
            parse("\"quantum\""),
            ToolKind::Other,
            "an unknown kind degrades, it does not reject the update"
        );
        assert_eq!(
            serde_json::to_string(&ToolKind::Read).unwrap(),
            "\"read\"",
            "serialization keeps the snake_case wire form"
        );
        assert_eq!(
            ToolKind::Read.to_operation_kind(),
            crate::approval::OperationKind::Read
        );
        assert_eq!(
            ToolKind::Delete.to_operation_kind(),
            crate::approval::OperationKind::Write
        );
    }

    /// A chunk whose content is an ARRAY of blocks (the shape this slice's
    /// calibration ruled out) must fail to parse -- the negative case pins
    /// the one-block ContentChunk contract alongside the positive fixtures.
    #[test]
    fn array_content_chunk_fails_to_parse() {
        let raw = serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": [{"type": "text", "text": "Hello"}],
        });
        let res: Result<SessionUpdate, _> = serde_json::from_value(raw);
        assert!(res.is_err(), "an array content chunk is not the wire shape");
    }

    /// collect_text concatenates text items + bounds the result.
    #[test]
    fn collect_text_concats_and_bounds() {
        let items = vec![
            ToolCallContent::Content {
                content: ContentBlock::text("first"),
            },
            ToolCallContent::Content {
                content: ContentBlock::text("second"),
            },
        ];
        assert_eq!(ToolCallContent::collect_text(&items, 100), "first\nsecond");
        // Bound kicks in: ellipsis at the cap.
        let bounded = ToolCallContent::collect_text(&items, 7);
        assert_eq!(bounded, "first\n…", "bounded = {bounded}");
    }

    /// A request_permission response serializes to the tagged union the agent
    /// expects.
    #[test]
    fn permission_outcome_selected_round_trips() {
        let outcome = RequestPermissionOutcome::Selected {
            option_id: "allow_once".into(),
        };
        let v: Value = serde_json::to_value(&outcome).unwrap();
        assert_eq!(v["type"], "selected");
        assert_eq!(v["optionId"], "allow_once");
        let back: RequestPermissionOutcome = serde_json::from_value(v).unwrap();
        assert_eq!(back, outcome);
    }

    /// ToolKind maps to the four OperationKind badges; the gateway does not
    /// branch on it (presentation-only), but the mapping is part of the trace
    /// contract.
    #[test]
    fn tool_kind_maps_to_operation_kind() {
        use crate::approval::OperationKind as Op;
        assert_eq!(ToolKind::Edit.to_operation_kind(), Op::Write);
        assert_eq!(ToolKind::Move.to_operation_kind(), Op::Write);
        assert_eq!(ToolKind::Search.to_operation_kind(), Op::Read);
        assert_eq!(ToolKind::Execute.to_operation_kind(), Op::Execute);
        assert_eq!(ToolKind::Fetch.to_operation_kind(), Op::Network);
    }

    /// A request envelope carries the fixed "2.0" marker + the method tag.
    #[test]
    fn request_envelope_carries_method_and_version() {
        let req = Request::new(
            RequestId::Num(1),
            "session/new",
            NewSessionParams {
                cwd: "/tmp".into(),
                mcp_servers: Vec::new(),
            },
        );
        let v: Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "session/new");
        assert_eq!(v["params"]["cwd"], "/tmp");
    }
}
