//! LLM provider abstraction (ADR-0007): a thin trait behind which the real
//! Claude client arrives in #29. The turn orchestrator depends on this trait,
//! never on a concrete client, so every turn is testable offline against a
//! scripted fake (the v1 shared test base). v1 ships one real implementation
//! behind the trait; multi-provider is a future config point, not pre-built.

pub mod fake;

use crate::model::ColumnSchema;

/// One Dataset the provider may reference in its SQL, with the verbatim FROM
/// fragment it must use. Sources are read-only attached catalogs referenced as
/// "<ref>".data (ADR-0012); materialized turn results are main-DB physical
/// tables referenced as "<ref>" (ADR-0024). Carried as a ready fragment so the
/// provider emits the correct form without knowing the storage layer -- the
/// window assembler (#24) is the one place that knows storage vs. reference.
#[derive(Debug, Clone)]
pub struct DatasetRef {
    pub reference_name: String,
    /// Verbatim SQL fragment for this dataset FROM clause, e.g.
    /// "people".data (source) or "result_1" (derived result).
    pub sql_ref: String,
    pub columns: Vec<ColumnSchema>,
    pub row_count: u64,
}

/// The request the orchestrator hands a provider each turn: the user question
/// plus the current working set (every Dataset the SQL may reference) and the
/// active dataset (ADR-0022 -- the implicit target when the question names
/// none). Window assembly (privacy pruning, history, truncation) arrives in
/// #24; slice #22 sends the bare schema -- enough for a scripted fake to pick
/// SQL.
#[derive(Debug, Clone)]
pub struct ProviderRequest {
    pub question: String,
    pub datasets: Vec<DatasetRef>,
    pub active: Option<String>,
}

/// One turn LLM output contract (ADR-0009): exactly one SQL, an optional viz
/// spec, and an optional natural-language assumption note. Slice #22 consumes
/// only sql; viz and assumption are carried so later slices test offline
/// against the full contract shape instead of widening it underfoot. viz is an
/// opaque string here -- #26 replaces it with a structured vega-lite spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderReply {
    pub sql: String,
    pub viz: Option<String>,
    pub assumption: Option<String>,
}

/// Why a provider call did not yield a reply. Slice #22 surfaces either as a
/// failed turn (via crate::model::TurnError); the full failed-turn retry budget
/// is #23.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// No provider is wired -- the real LLM arrives in #29. The default
    /// UnwiredProvider returns this for every turn, so the orchestrator never
    /// silently runs without an explicit provider.
    NotWired,
    /// The provider call itself failed (network / auth / quota / malformed
    /// output). Carries the detail for diagnostics; the fake never hits it.
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
