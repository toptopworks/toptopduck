//! LLM provider abstraction (ADR-0007, recalibrated by ADR-0107): the trait
//! the wiring seam reads per turn to drive the built-in runtime -- live
//! construction facts (`turn_model_facts`) for the upstream loop, or a
//! `generate_tool_turn` face for providers without live facts (the scripted
//! test fake, bridged onto the loop as-is). The self-written protocol adapters
//! retired with the built-in loop (ADR-0107 Decision 1, issue #670); the
//! windowed payload vocabulary below stays -- the window assembler
//! (`crate::window`) builds it for both the built-in and ACP turn paths.

pub mod fake;
pub mod http;
pub mod keychain;
pub mod live_config;
pub mod preflight;
pub mod prompt;
pub mod tool_calling;

use crate::model::TextKind;
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
    /// quota / malformed output). Transient/recoverable at the turn level:
    /// maps to a failed turn honestly (ADR-0077/0081) -- transport-level
    /// faults never reach the model for self-correction (that channel is
    /// tool-level errors only). Auth failures (HTTP 401/403) are permanent,
    /// not transient -- they map to [`NotWired`] (ADR-0044).
    #[error("LLM provider call failed: {0}")]
    Unavailable(String),
}

/// The per-turn upstream construction facts (ADR-0107, issue #669): the
/// active access profile's wire coordinates plus the keychain key, read
/// FRESH each turn so a profile switch lands the next turn. All app-owned
/// types on purpose -- the upstream provider construction these feed is
/// sealed inside `session::yoagent`, so no upstream type crosses this
/// boundary (the #669 encapsulation AC). `None` (the trait default) marks a
/// provider with no live profile behind it (the scripted test fake,
/// [`UnwiredProvider`]); the wiring seam bridges those onto the loop as-is
/// instead of constructing an upstream provider.
#[derive(Clone)]
pub struct TurnModelFacts {
    pub protocol: crate::model::Protocol,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

impl std::fmt::Debug for TurnModelFacts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key never rides a Debug render (ADR-0029): a present key
        // prints as the redaction marker, mirroring the upstream
        // `StreamConfig`'s masked Debug instead of a derived impl.
        f.debug_struct("TurnModelFacts")
            .field("protocol", &self.protocol)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| "[redacted]"))
            .finish()
    }
}

/// The provider abstraction (ADR-0007, recalibrated by ADR-0107). The face
/// the wiring seam drives the built-in turn through: one native tool-calling
/// round-trip (ADR-0081, issue #291) -- send the active tool table plus the
/// in-progress conversation, get back either the model's tool invocations to
/// execute or its terminal text answer, alongside any reasoning blocks the
/// runtime emitted (issue #614 -- empty for every thinking-disabled turn).
/// Concrete implementations: the scripted test fake
/// (fake::FakeProvider, bridged onto the yoagent loop) and the default
/// [`UnwiredProvider`]; [`LiveProvider`] carries live construction facts
/// instead and never answers a round-trip itself. Send so the session can
/// hold it behind an Arc<Mutex> and run turns on a blocking thread.
pub trait Provider: Send + Sync {
    /// Default [`ProviderError::NotWired`] so a provider that does not
    /// implement the face (e.g. [`UnwiredProvider`]) refuses the turn
    /// permanently -- the same surface as an unwired turn. DEAD CODE on the
    /// live track: the wiring seam routes a provider whose
    /// [`Self::turn_model_facts`] returns `Some` to the upstream streamer and
    /// never calls this face -- the two faces are mutually exclusive by
    /// convention (only the scripted fake + [`UnwiredProvider`] answer it).
    fn generate_tool_turn(
        &self,
        _request: &tool_calling::ToolTurnRequest,
    ) -> Result<tool_calling::ToolTurnOutcome, ProviderError> {
        Err(ProviderError::NotWired)
    }

    /// The resolved response locale for prompt assembly (ADR-0052). The
    /// tool-calling wiring seam (`Session::ask_with_phase`) owns the system
    /// prompt, so it reads the locale off the provider per turn. Read
    /// per turn (not cached) so a locale-preference change takes effect the
    /// next turn, mirroring [`LiveProvider`]'s per-turn protocol re-read. The
    /// default is the ADR-0052 fallback locale: providers without a config
    /// source ([`UnwiredProvider`], the scripted fake) never build a real
    /// prompt, so the default is inert for them.
    fn response_locale(&self) -> ResponseLocale {
        ResponseLocale::EnUS
    }

    /// The live upstream construction facts (ADR-0107, issue #669), read
    /// per turn like [`Self::response_locale`] / the adapter routing: a
    /// profile switch (protocol, endpoint, model, key) lands the next turn.
    /// `None` for providers with no live profile behind them -- the default
    /// keeps [`UnwiredProvider`] and the scripted fake inert.
    fn turn_model_facts(&self) -> Option<TurnModelFacts> {
        None
    }
}

/// Default provider before the real LLM is wired (#29): refuses every turn
/// honestly with NotWired. The orchestrator thus never runs without an explicit
/// provider, and the production app surfaces "not configured" instead of
/// silently doing nothing or inventing SQL.
pub struct UnwiredProvider;

impl Provider for UnwiredProvider {}

/// The live per-turn facts carrier (ADR-0064 -> ADR-0107). Holds a
/// [`ProviderConfigSource`] and answers [`Provider::turn_model_facts`] /
/// [`Provider::response_locale`] from it, read fresh each turn: a profile
/// switch / protocol edit lands the next turn (the protocol-switch-takes-
/// effect-next-turn AC). The adapter dispatch this type used to perform
/// retired with the self-written adapters (ADR-0107 Decision 1); the facts
/// feed the upstream provider construction sealed inside `session::yoagent`.
///
/// Generic over `C` so production wires [`crate::LiveProviderConfig`] (reads
/// app-config + keychain fresh each turn) while tests inject
/// [`crate::StaticConfig`] (or a flipping double for the per-turn assertion).
/// `C` is NOT required to be `Clone` (issue #159): each read borrows
/// `&self.config`.
pub struct LiveProvider<C: ProviderConfigSource + 'static> {
    config: C,
}

impl<C: ProviderConfigSource + 'static> LiveProvider<C> {
    /// Wire the facts carrier with the live config source. The source is
    /// read on each turn, so a change in the underlying store takes effect
    /// the next turn without re-booting the session.
    pub fn new(config: C) -> Self {
        Self { config }
    }
}

impl<C: ProviderConfigSource + 'static> Provider for LiveProvider<C> {
    fn response_locale(&self) -> ResponseLocale {
        // Per-turn read off the config source (the same freshness
        // [`Self::turn_model_facts`] applies): a "system" preference
        // re-resolves the OS locale here, an explicit override maps directly
        // (ADR-0052).
        self.config.locale()
    }

    fn turn_model_facts(&self) -> Option<TurnModelFacts> {
        // Per-turn read off the config source (ADR-0107, issue #669): the
        // same freshness the adapter routing above applies -- a profile
        // switch lands the next turn on the new upstream construction. A
        // present-but-keyless profile rides through with `api_key: None` so
        // the wiring seam's resolution refuses the turn as NotWired exactly
        // where the adapters used to (ADR-0029).
        Some(TurnModelFacts {
            protocol: self.config.protocol(),
            base_url: self.config.base_url(),
            model: self.config.model(),
            api_key: self.config.api_key(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Protocol;

    /// The key never rides a Debug render: a present key prints as the
    /// redaction marker (ADR-0029, mirroring the upstream `StreamConfig`'s
    /// masked Debug) -- a derived Debug would print the keychain secret in
    /// the clear wherever a future log line or panic payload renders the
    /// facts.
    #[test]
    fn turn_model_facts_debug_masks_the_api_key() {
        let facts = TurnModelFacts {
            protocol: Protocol::Anthropic,
            base_url: "https://api.anthropic.com".into(),
            model: "m".into(),
            api_key: Some("sk-secret".into()),
        };
        let rendered = format!("{facts:?}");
        assert!(!rendered.contains("sk-secret"), "got {rendered}");
        assert!(rendered.contains("[redacted]"), "got {rendered}");
    }
}
