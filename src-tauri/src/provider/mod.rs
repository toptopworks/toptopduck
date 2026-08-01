//! LLM provider abstraction (ADR-0007): a thin trait behind which the real
//! Claude client ships (issue #29: `anthropic::AnthropicProvider`). The turn
//! orchestrator depends on this trait, never on a concrete client, so every
//! turn is testable offline against a scripted fake (the v1 shared test base).
//! v1 ships one real implementation behind the trait; multi-provider is a
//! future config point, not pre-built.
//!
//! The [`ProviderRequest`] handed to a provider each turn is the *assembled LLM
//! payload* -- the windowed conversation history plus every working-set dataset
//! pruned by the privacy controls (issue #24, ADR-0023/0026/0039/0011). The
//! window assembler (`crate::window`) is the single place that builds it; the
//! types below are just its shape.

pub mod anthropic;
pub mod fake;
pub mod http;
pub mod keychain;
pub mod live_config;
pub mod openai;
pub mod preflight;
pub mod prompt;
pub mod reply;
pub mod tool_calling;

use crate::model::{Protocol, TextKind};
use crate::provider::keychain::ProviderConfigSource;
use crate::provider::prompt::ResponseLocale;

/// Cap on the model's reply length, shared by both single-shot adapters and
/// the tool-calling window assembler (ADR-0081): the tool contract terminates
/// in a plain text answer whose length profile matches the legacy one-SQL
/// reply, so every path shares one ceiling. Sized for a SQL + a Vega-Lite
/// spec + an assumption note (a viz spec can run long); bounded so a runaway
/// reply never balloons. Not a user-facing cap (the engine result-row cap,
/// ADR-0005 L3, governs materialized size -- this bounds only the model's
/// text).
pub(crate) const MAX_REPLY_TOKENS: u32 = 4096;

/// One column of a dataset as it appears in the LLM payload. The name is hidden
/// when the user marked the column "type only" (ADR-0011): the provider learns
/// the canonical DuckDB type but neither the column name nor any of its sample
/// values, so a sensitive column's shape stays visible for SQL correctness
/// without leaking its identity or contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnRef {
    /// The column name, or `None` when privacy hides it (ADR-0011 type-only).
    pub name: Option<String>,
    pub canonical_type: String,
}

/// One Dataset the provider may reference in its SQL, as it appears in the
/// assembled payload (ADR-0023/0026/0011). Sources are read-only attached
/// catalogs referenced as `"<ref>".data` (ADR-0012); materialized turn results
/// are main-DB physical tables referenced as `"<ref>"` (ADR-0024). Carried as a
/// ready `sql_ref` fragment so the provider emits the correct form without
/// knowing the storage layer -- the window assembler is the one place that
/// knows storage vs. reference.
///
/// `sample` is `None` when sample rows are withheld: the dataset sits outside
/// the recent-turn window (a `result_N` whose producing turn is older than
/// N=20, ADR-0026), or the user turned samples off for this dataset
/// (ADR-0011). Sources always carry samples (always in-window, ADR-0023). When
/// present, each row aligns positionally to `columns`; a cell is `None` where
/// its column is type-only (ADR-0011 -- the value is withheld along with the
/// name).
#[derive(Debug, Clone, PartialEq)]
pub struct DatasetRef {
    pub reference_name: String,
    /// Verbatim SQL fragment for this dataset's FROM clause, e.g.
    /// `"people".data` (source) or `"result_1"` (derived result).
    pub sql_ref: String,
    pub columns: Vec<ColumnRef>,
    pub row_count: u64,
    pub sample: Option<Vec<Vec<Option<String>>>>,
}

/// One prior turn's contribution to the assembled prompt (ADR-0023 window).
/// Recent turns (within N=20) carry full detail; older turns carry only a
/// verbatim-question summary (ADR-0039) so the provider can still map "that
/// earlier table" to a reference (ADR-0010) without paying the full token cost.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnPayload {
    /// A recent turn (within the N=20 window): the verbatim question and the
    /// provider's own prior response. A result turn names its `result_N` (the
    /// full schema + sample ride the dataset list, ADR-0023); a textual turn
    /// carries its body; failed/cancelled carry their outcome tag.
    Full {
        question: String,
        response: ResponsePayload,
    },
    /// A turn beyond the N=20 window: only the verbatim question, bounded-
    /// truncated (ADR-0039 -- never an LLM-generated summary), plus the
    /// `result_N` name if it produced one (so the provider can still retarget
    /// it, ADR-0010/0023). No SQL, no schema, no sample.
    Summary {
        question_excerpt: String,
        result: Option<String>,
    },
}

/// The provider's prior response, mirrored in a recent turn's payload. A trimmed
/// view of [`crate::model::TurnOutcome`] -- the result's full schema + sample
/// ride the dataset list, so this carries only what is per-turn: the SQL, the
/// result name, the textual body, the assumption note, the failure tag.
#[derive(Debug, Clone, PartialEq)]
pub enum ResponsePayload {
    Materialized {
        result: String,
        /// The verbatim SQL the provider returned (ADR-0023 point 1) -- present
        /// on a recent materialized turn so the provider sees its own prior SQL.
        /// `None` only when the source turn predates the field.
        sql: Option<String>,
        assumption: Option<String>,
    },
    Textual {
        kind: TextKind,
        body: String,
        assumption: Option<String>,
    },
    Failed {
        reason: String,
    },
    Cancelled,
}

impl From<&crate::model::TurnOutcome> for ResponsePayload {
    fn from(outcome: &crate::model::TurnOutcome) -> Self {
        use crate::model::TurnOutcome;
        match outcome {
            TurnOutcome::Materialized {
                promotions,
                assumption,
                // viz intentionally dropped: a prior turn's chart intent is
                // irrelevant to SQL generation (the ADR-0023 window carries the
                // prior SQL, not the presentation spec).
                ..
            } => {
                // The one-line window summary represents the turn's primary
                // result (ADR-0084 chain tail); antecedent promotions ride the
                // dataset blocks the assembler enumerates from the working set.
                let primary = promotions
                    .last()
                    .expect("a Materialized outcome carries at least one promotion (ADR-0084)");
                ResponsePayload::Materialized {
                    result: primary.dataset.reference_name.clone(),
                    sql: Some(primary.sql.clone()),
                    assumption: assumption.clone(),
                }
            }
            TurnOutcome::Textual {
                text_kind,
                body,
                assumption,
            } => ResponsePayload::Textual {
                kind: *text_kind,
                body: body.clone(),
                assumption: assumption.clone(),
            },
            // The LLM window is a text consumer: it wants a readable failure
            // reason, not a locale key. TurnFailure's English-log Display feeds
            // it (issue #125); the authoritative user wording still lives in the
            // frontend catalog, never crossing the Tauri IPC.
            TurnOutcome::Failed(failure) => ResponsePayload::Failed {
                reason: failure.to_string(),
            },
            TurnOutcome::Cancelled => ResponsePayload::Cancelled,
        }
    }
}

/// The request the orchestrator hands a provider each turn (issue #24): the
/// asking question, the windowed conversation history, and every working-set
/// dataset pruned by the privacy controls. Built once per turn by the window
/// assembler (`crate::window`); the retry loop re-feeds the same request, so a
/// provider sees an identical payload across attempts.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderRequest {
    pub question: String,
    /// Prior turns, oldest first (ADR-0023). Excludes the current turn -- the
    /// asking `question` stands alone above. The last N=20 are full; anything
    /// older is a verbatim-question summary (ADR-0039).
    pub history: Vec<TurnPayload>,
    pub datasets: Vec<DatasetRef>,
    pub active: Option<String>,
}

/// One turn LLM output contract (ADR-0009, calibrated by ADR-0028/0033): either
/// one SQL to execute (+ optional viz spec + optional assumption note), or a
/// textual response with no SQL -- a disambiguation question (ADR-0018) or an
/// out-of-scope refusal (ADR-0017). Slice #23 widens #22's SQL-only reply to
/// the full contract; #26 structures the viz as a typed [`VizSpec`] (chart kind
/// from the v1 whitelist + Vega-Lite JSON, ADR-0016/0033). `assumption` carries
/// the natural-language side note for both branches (the method name behind a
/// refusal, the interpretation behind a clarify, or the assumption behind a SQL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderReply {
    /// One SQL to execute, with an optional viz spec and assumption note.
    Sql {
        sql: String,
        /// Optional viz spec (ADR-0016/0033): the LLM-decided chart for this
        /// result, or `None` for a plain table turn (the default). Carried
        /// verbatim to the frontend, which renders it or degrades to a table
        /// with a disclosure when the spec is malformed or fails to render.
        viz: Option<crate::model::VizSpec>,
        assumption: Option<String>,
    },
    /// A textual response (no SQL): a clarify question or an out-of-scope
    /// refusal. `body` is the text shown to the user; `assumption` is the
    /// optional side note (e.g. which method the refusal is steering away
    /// from).
    Text {
        kind: crate::model::TextKind,
        body: String,
        assumption: Option<String>,
    },
}

/// Why a provider call did not yield a reply. All three variants fail the
/// turn at the wiring seam (ADR-0044/0077/0081): transport-level faults never
/// reach the model for self-correction (that channel is tool-level errors
/// only). `Unavailable` (a transient fault surfaced after the adapter's own
/// HTTP retry) maps to a failed turn honestly -- blind retry is abolished;
/// `NotWired` and `InvalidConfig` are permanent (no key configured / key
/// rejected, or a non-recoverable configuration fault). `InvalidConfig`
/// carries its diagnosis so the policy reason (e.g. "scheme `file` is not
/// http/https") reaches the UI fold (issue #277).
///
/// `Display` is derived via `thiserror` (issue #277) -- matching the
/// `commands.rs` / `session_store.rs` style -- and is Rust-log-only, not the
/// IPC contract (the orchestrator maps each variant to a typed
/// [`crate::model::TurnFailure`] that the frontend renders via its locale
/// catalog).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProviderError {
    /// The provider cannot serve this turn for a non-transient reason: no API
    /// key is stored (ADR-0029 invariant 3), the stored key was rejected by the
    /// endpoint (HTTP 401/403), or -- in test/dev -- no provider is wired at
    /// all ([`UnwiredProvider`]). Permanent for the turn: not retried.
    #[error("no LLM provider wired (configure an Anthropic API key, then retry)")]
    NotWired,
    /// The provider's configuration is permanently invalid for this turn
    /// (issue #277): a non-http/https base_url (file:, data:, scheme-less) or
    /// another configuration fault retrying cannot fix. NOT retried -- the same
    /// config would fail identically, so retrying would only burn the budget.
    /// Carries the diagnosis verbatim so the policy reason surfaces to the UI
    /// fold; the orchestrator maps it to
    /// [`crate::model::TurnFailure::InvalidConfig`].
    #[error("LLM provider configuration is invalid: {0}")]
    InvalidConfig(String),
    /// The provider call failed or its output violated the contract (network /
    /// quota / malformed output). Transient/recoverable: the retry loop
    /// re-feeds it up to the budget, then yields a failed turn (ADR-0028).
    /// Auth failures (HTTP 401/403) are permanent, not transient -- they map
    /// to [`NotWired`] and skip the retry loop (ADR-0044).
    #[error("LLM provider call failed: {0}")]
    Unavailable(String),
}

/// The provider abstraction (ADR-0007). Two methods: the single-shot
/// [`Self::generate`] (turn a schema-aware request into the one-SQL reply
/// contract, ADR-0009) and the native tool-calling [`Self::generate_tool_turn`]
/// (ADR-0081, issue #291). Concrete implementations: the real
/// Anthropic client (anthropic::AnthropicProvider, #29), the OpenAI-compatible
/// client (openai::OpenaiProvider), the scripted test fake
/// (fake::FakeProvider), and the default UnwiredProvider. Send so the session
/// can hold it behind an Arc<Mutex> and run turns on a blocking thread.
pub trait Provider: Send {
    fn generate(&self, request: &ProviderRequest) -> Result<ProviderReply, ProviderError>;

    /// One native tool-calling round-trip (ADR-0081, issue #291):
    /// send the active tool table plus the in-progress conversation, get back
    /// either the model's tool invocations to execute or its terminal text
    /// answer. The two adapters translate the protocol-neutral
    /// [`tool_calling::ToolTurnRequest`] onto their native wire shapes
    /// (anthropic `tools` / `tool_use` / `tool_result`; openai `tools` /
    /// `tool_calls` / `tool` role). ADR-0029 invariant 3 holds: the request
    /// never carries the key; the adapter reads it from the config source.
    /// ADR-0044 classification is unchanged.
    ///
    /// Coexists with [`Self::generate`] (zero behavior change to the
    /// single-shot path; ADR-0077 retires the single-SQL contract for
    /// tool-calling turns). Default [`ProviderError::NotWired`] so a provider that
    /// does not implement native tool-calling (e.g. [`UnwiredProvider`],
    /// [`fake::FakeProvider`] until #295 extends it) refuses the turn
    /// permanently -- the same surface as an unwired single-shot turn.
    fn generate_tool_turn(
        &self,
        _request: &tool_calling::ToolTurnRequest,
    ) -> Result<tool_calling::ToolTurnReply, ProviderError> {
        Err(ProviderError::NotWired)
    }

    /// The resolved response locale for prompt assembly (ADR-0052). The
    /// tool-calling wiring seam (`Session::ask_with_phase`) owns the system
    /// prompt -- unlike the single-shot path, where each adapter builds it
    /// internally -- so it reads the locale off the provider per turn. Read
    /// per turn (not cached) so a locale-preference change takes effect the
    /// next turn, mirroring [`LiveProvider`]'s per-turn protocol re-read. The
    /// default is the ADR-0052 fallback locale: providers without a config
    /// source ([`UnwiredProvider`], the scripted fake) never build a real
    /// prompt, so the default is inert for them.
    fn response_locale(&self) -> ResponseLocale {
        ResponseLocale::EnUS
    }
}

/// Default provider before the real LLM is wired (#29): refuses every turn
/// honestly with NotWired. The orchestrator thus never runs without an explicit
/// provider, and the production app surfaces "not configured" instead of
/// silently doing nothing or inventing SQL.
pub struct UnwiredProvider;

impl Provider for UnwiredProvider {
    fn generate(&self, _request: &ProviderRequest) -> Result<ProviderReply, ProviderError> {
        Err(ProviderError::NotWired)
    }
}

/// Per-turn protocol router (ADR-0064, issue #152). Holds a
/// [`ProviderConfigSource`] and, on each [`Provider::generate`] call, reads the
/// active profile's [`Protocol`] fresh and dispatches to the matching adapter
/// ([`anthropic::AnthropicProvider`] or [`openai::OpenaiProvider`]). Reading
/// per-turn (not caching at construction) honors the protocol-switch-takes-
/// effect-next-turn AC: a profile switch / protocol edit lands the next turn
/// on the new adapter.
///
/// Generic over `C` so production wires [`crate::LiveProviderConfig`] (reads
/// app-config + keychain fresh each turn) while tests inject
/// [`crate::StaticConfig`] (or a flipping double for the per-turn assertion).
/// `C` is NOT required to be `Clone` (issue #159): each dispatch borrows
/// `&self.config` for the duration of the adapter call -- the adapter is a
/// stateless translator that reads the source per turn and never stores it,
/// so no ownership transfer (and no clone) is needed.
pub struct LiveProvider<C: ProviderConfigSource + 'static> {
    config: C,
}

impl<C: ProviderConfigSource + 'static> LiveProvider<C> {
    /// Wire the router with the live config source. The source's `protocol()`
    /// is read on each `generate`, so a protocol change in the underlying store
    /// takes effect the next turn without re-booting the session.
    pub fn new(config: C) -> Self {
        Self { config }
    }
}

impl<C: ProviderConfigSource + 'static> Provider for LiveProvider<C> {
    fn generate(&self, request: &ProviderRequest) -> Result<ProviderReply, ProviderError> {
        match self.config.protocol() {
            Protocol::Anthropic => anthropic::AnthropicProvider::generate(&self.config, request),
            Protocol::Openai => openai::OpenaiProvider::generate(&self.config, request),
        }
    }

    fn generate_tool_turn(
        &self,
        request: &tool_calling::ToolTurnRequest,
    ) -> Result<tool_calling::ToolTurnReply, ProviderError> {
        match self.config.protocol() {
            Protocol::Anthropic => {
                anthropic::AnthropicProvider::generate_tool_turn(&self.config, request)
            }
            Protocol::Openai => openai::OpenaiProvider::generate_tool_turn(&self.config, request),
        }
    }

    fn response_locale(&self) -> ResponseLocale {
        // Per-turn read off the config source, same freshness as the adapters'
        // internal prompt assembly on the single-shot path: a "system"
        // preference re-resolves the OS locale here, an explicit override maps
        // directly (ADR-0052).
        self.config.locale()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Protocol;
    use crate::provider::prompt::ResponseLocale;
    use std::sync::{Arc, Mutex};

    /// A minimal request with no history / datasets -- the routing tests only
    /// care which HTTP endpoint the dispatch hit, not the body shape.
    fn bare_request() -> ProviderRequest {
        ProviderRequest {
            question: "q".into(),
            history: Vec::new(),
            datasets: Vec::new(),
            active: None,
        }
    }

    /// A config source whose `protocol` can be flipped between turns (via the
    /// shared `Arc<Mutex>`), to prove `LiveProvider` re-reads `protocol()` per
    /// turn rather than caching it at construction. All other fields are fixed.
    /// Derives `Clone` (shares the protocol cell) so the test can hand a copy
    /// to `LiveProvider` and still mutate the shared cell afterward -- a test
    /// convenience, not a router requirement (`LiveProvider<C>` does not
    /// require `Clone`, issue #159).
    #[derive(Clone)]
    struct FlippableConfig {
        key: String,
        base_url: String,
        model: String,
        locale: ResponseLocale,
        protocol: Arc<Mutex<Protocol>>,
    }

    impl ProviderConfigSource for FlippableConfig {
        fn api_key(&self) -> Option<String> {
            Some(self.key.clone())
        }
        fn base_url(&self) -> String {
            self.base_url.clone()
        }
        fn model(&self) -> String {
            self.model.clone()
        }
        fn locale(&self) -> ResponseLocale {
            self.locale
        }
        fn protocol(&self) -> Protocol {
            *self
                .protocol
                .lock()
                .expect("flippable protocol mutex poisoned")
        }
    }

    fn flippable(url: &str, protocol: Protocol) -> FlippableConfig {
        FlippableConfig {
            key: "sk-test".into(),
            base_url: url.into(),
            model: "m".into(),
            locale: ResponseLocale::EnUS,
            protocol: Arc::new(Mutex::new(protocol)),
        }
    }

    #[test]
    fn routes_anthropic_protocol_to_messages_endpoint() {
        // AC: protocol=Anthropic dispatches to the anthropic adapter -- the
        // request lands at /v1/messages with x-api-key auth.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/v1/messages")
            .match_header("x-api-key", "sk-test")
            .with_status(200)
            .with_body(
                serde_json::json!({
                    "content": [{"type":"text","text":
                        r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#}]
                })
                .to_string(),
            )
            .create();
        let p = LiveProvider::new(flippable(&server.url(), Protocol::Anthropic));
        p.generate(&bare_request()).expect("anthropic reply");
        _mock.assert();
    }

    #[test]
    fn routes_openai_protocol_to_chat_completions_endpoint() {
        // AC: protocol=Openai dispatches to the openai adapter -- the request
        // lands at /chat/completions with Bearer auth.
        let mut server = mockito::Server::new();
        let _mock = server
            .mock("POST", "/chat/completions")
            .match_header("authorization", "Bearer sk-test")
            .with_status(200)
            .with_body(
                serde_json::json!({
                    "choices": [{"message": {"role":"assistant","content":
                        r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#}}]
                })
                .to_string(),
            )
            .create();
        let p = LiveProvider::new(flippable(&server.url(), Protocol::Openai));
        p.generate(&bare_request()).expect("openai reply");
        _mock.assert();
    }

    #[test]
    fn re_reads_protocol_per_turn_not_cached_at_construction() {
        // AC "re-read active_profile each turn": a protocol switch between two
        // turns of the SAME LiveProvider routes the second turn to the new
        // adapter. The
        // flippable config's protocol (shared via Arc<Mutex> across the clone
        // the LiveProvider holds) is mutated AFTER construction; if the router
        // cached the protocol at construction, both turns would hit the same
        // endpoint. One server mocks BOTH protocol paths so base_url stays
        // constant -- the protocol flip alone reroutes.
        let mut server = mockito::Server::new();
        let openai_mock = server
            .mock("POST", "/chat/completions")
            .with_status(200)
            .with_body(
                serde_json::json!({
                    "choices": [{"message": {"role":"assistant","content":
                        r#"{"type":"sql","sql":"SELECT 1","viz":null,"assumption":null}"#}}]
                })
                .to_string(),
            )
            .create();
        let anthropic_mock = server
            .mock("POST", "/v1/messages")
            .with_status(200)
            .with_body(
                serde_json::json!({
                    "content": [{"type":"text","text":
                        r#"{"type":"sql","sql":"SELECT 2","viz":null,"assumption":null}"#}]
                })
                .to_string(),
            )
            .create();

        // Start in Openai mode. The test clones cfg (FlippableConfig derives
        // Clone -- the protocol Arc<Mutex> is shared across the clone) so it
        // can hand a copy to LiveProvider and keep cfg to flip its protocol
        // below. LiveProvider<C> itself does not require Clone (issue #159);
        // the clone here is a test convenience, not a router requirement.
        let cfg = flippable(&server.url(), Protocol::Openai);
        let p = LiveProvider::new(cfg.clone());

        // Turn 1: Openai -> /chat/completions.
        p.generate(&bare_request()).expect("turn 1 openai");
        openai_mock.assert(); // hit exactly once

        // Flip the shared protocol cell to Anthropic -- NO re-construction of
        // the LiveProvider. The next turn re-reads protocol() and reroutes.
        *cfg.protocol
            .lock()
            .expect("flippable protocol mutex poisoned") = Protocol::Anthropic;

        // Turn 2: SAME LiveProvider, now Anthropic -> /v1/messages.
        p.generate(&bare_request()).expect("turn 2 anthropic");
        anthropic_mock.assert(); // hit exactly once
    }

    #[test]
    fn accepts_a_non_clone_config_source() {
        // AC #159: LiveProvider must not require Clone on its config source.
        // The router borrows &self.config per turn (stateless adapter reads it
        // in-call and never stores it), so a source without Clone compiles and
        // routes. If the Clone bound were ever re-added, this test would fail
        // to compile -- a regression guard for the ownership-to-borrow refactor.
        #[derive(Default)]
        struct NonCloneSource;
        impl ProviderConfigSource for NonCloneSource {
            fn api_key(&self) -> Option<String> {
                None
            }
            fn base_url(&self) -> String {
                String::new()
            }
            fn model(&self) -> String {
                String::new()
            }
            fn locale(&self) -> ResponseLocale {
                ResponseLocale::EnUS
            }
            fn protocol(&self) -> Protocol {
                Protocol::Anthropic
            }
        }

        let provider = LiveProvider::new(NonCloneSource);
        // The compile-pass is the load-bearing guard: NonCloneSource has no
        // Clone impl, so re-adding `+ Clone` to LiveProvider<C>'s bound would
        // fail this test to compile. The runtime assert is a cheap sanity
        // check that dispatch still reaches the matching adapter branch
        // (redundant with the borrow-path coverage in
        // re_reads_protocol_per_turn_not_cached_at_construction).
        //
        // Scope: this guards the BOUND, not the production wiring. Production
        // (commands.rs) still clones LiveProviderConfig at LiveProvider::new;
        // the per-turn clone was removed only INSIDE LiveProvider::generate
        // (which now borrows &self.config). The bound removal keeps the router
        // source-agnostic -- it does not require any concrete source to
        // forgo Clone.
        assert_eq!(
            provider.generate(&bare_request()).unwrap_err(),
            ProviderError::NotWired
        );
    }
}
