//! LLM provider abstraction (ADR-0007): a thin trait behind which the real
//! Claude client arrives in #29. The turn orchestrator depends on this trait,
//! never on a concrete client, so every turn is testable offline against a
//! scripted fake (the v1 shared test base). v1 ships one real implementation
//! behind the trait; multi-provider is a future config point, not pre-built.
//!
//! The [`ProviderRequest`] handed to a provider each turn is the *assembled LLM
//! payload* -- the windowed conversation history plus every working-set dataset
//! pruned by the privacy controls (issue #24, ADR-0023/0026/0039/0011). The
//! window assembler (`crate::window`) is the single place that builds it; the
//! types below are just its shape.

pub mod fake;

use crate::model::TextKind;

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
/// ride the dataset list, so this carries only what is per-turn: the result
/// name, the textual body, the assumption note, the failure tag.
#[derive(Debug, Clone, PartialEq)]
pub enum ResponsePayload {
    Materialized {
        result: String,
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
                dataset,
                assumption,
            } => ResponsePayload::Materialized {
                result: dataset.reference_name.clone(),
                assumption: assumption.clone(),
            },
            TurnOutcome::Textual {
                text_kind,
                body,
                assumption,
            } => ResponsePayload::Textual {
                kind: *text_kind,
                body: body.clone(),
                assumption: assumption.clone(),
            },
            TurnOutcome::Failed { reason } => ResponsePayload::Failed {
                reason: reason.clone(),
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

/// One turn LLM output contract (ADR-0009, calibrated by ADR-0028): either one
/// SQL to execute (+ optional viz spec + optional assumption note), or a
/// textual response with no SQL -- a disambiguation question (ADR-0018) or an
/// out-of-scope refusal (ADR-0017). Slice #23 widens #22's SQL-only reply to
/// the full contract; viz is an opaque string here (#26 replaces it with a
/// structured vega-lite spec), and `assumption` carries the natural-language
/// side note for both branches (the method name behind a refusal, the
/// interpretation behind a clarify, or the assumption behind a SQL).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderReply {
    /// One SQL to execute, with an optional viz spec and assumption note.
    Sql {
        sql: String,
        viz: Option<String>,
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

/// Why a provider call did not yield a reply. The orchestrator's single retry
/// budget (ADR-0028) consumes `Unavailable` (a contract violation / transient
/// call failure) and re-attempts; `NotWired` is permanent (no provider
/// configured) and is not retried -- it yields a failed turn immediately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// No provider is wired -- the real LLM arrives in #29. The default
    /// UnwiredProvider returns this for every turn, so the orchestrator never
    /// silently runs without an explicit provider. Permanent: not retried.
    NotWired,
    /// The provider call failed or its output violated the contract (network /
    /// auth / quota / malformed output). Transient/recoverable: the retry loop
    /// re-feeds it up to the budget, then yields a failed turn (ADR-0028).
    Unavailable(String),
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::NotWired => write!(f, "尚未接入 LLM 提供方（真实接线在后续切片），无法处理提问"),
            Self::Unavailable(detail) => write!(f, "LLM 提供方调用失败：{detail}"),
        }
    }
}
impl std::error::Error for ProviderError {}

/// The provider abstraction (ADR-0007). One method: turn a schema-aware request
/// into the one-SQL reply contract (ADR-0009). Concrete implementations: the
/// scripted test fake (fake::FakeProvider) and the default UnwiredProvider (the
/// real Claude client arrives in #29). Send so the session can hold it behind
/// an Arc<Mutex> and run turns on a blocking thread.
pub trait Provider: Send {
    fn generate(&self, request: &ProviderRequest) -> Result<ProviderReply, ProviderError>;
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
