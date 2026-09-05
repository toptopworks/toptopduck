//! The round-execution contract vocabulary (ADR-0081 / ADR-0103 / ADR-0107).
//!
//! [`LoopOutcome`] and its trace shapes are the shared contract every turn
//! runtime produces -- the yoagent loop, the integration layer's dispatch
//! server, the ACP engine, and the claude / codex stream adapters all emit
//! this vocabulary, and the wiring seam (`Session::ask_with_phase`) consumes
//! exactly one shape regardless of runtime (the five-producer contract,
//! ADR-0107's replaceability review). The module is deliberately dependency-
//! light: pure data shapes, their persisted / display projections, and the
//! shared trace-container operations -- the execution machinery lives in
//! [`crate::session::turn_dispatch`].
//!
//! Migrated out of the retired built-in loop by the retirement slice
//! (ADR-0107 Decision 1, issue #670); the loop itself is gone, the contract
//! it defined stays.

use std::time::Duration;

use crate::approval::OperationKind;
use crate::model::{Promotion, ThinkingTrace, TraceEntryView, TraceRound};
use crate::persistence::recipe::{RecipeTraceEntry, RecipeTraceRound};

/// Default step cap (ADR-0081): a turn may make up to this many tool-call
/// round-trips before the loop aborts as [`Termination::StepCap`]. The agent is
/// expected to converge well within this; the cap is the last-line safety net
/// for a non-converging trajectory, not a target.
pub(crate) const DEFAULT_STEP_CAP: u32 = 24;

/// Default wall-clock ceiling (ADR-0081, aligned with ADR-0021
/// `REQUEST_TIMEOUT`). The watchdog fires cancel on expiry; the loop lands as
/// [`Termination::Cancelled`] (ADR-0021 timeout -> cancel mapping).
pub(crate) const DEFAULT_WALL_CLOCK: Duration = Duration::from_secs(120);

/// Maximum length of a trace entry's result excerpt (ADR-0078). The full result
/// rides the trace; the far window carries only a summary, so an excerpt is all
/// the loop needs to keep for the collapsible trace. Shared across runtimes --
/// the ACP gateway reuses it so a trace row renders identically regardless of
/// which runtime produced it (ADR-0085 cross-runtime trace contract).
/// Deliberately NOT aligned with the 512 recovery caps (issue #826): the ACP
/// stream arms also cap their live summaries here, so an external-runtime
/// trace row's fold recovers a 240-char head while a built-in row recovers
/// 512 -- an arm asymmetry, recorded rather than converged.
pub(crate) const TRACE_EXCERPT_MAX: usize = 240;

/// Why the loop terminated (ADR-0081). Maps onto the four-way `TurnOutcome`
/// (ADR-0028) at the wiring seam; kept as a distinct enum here so the loop is
/// unit-testable without committing to `TurnOutcome`'s single-promotion shape
/// (ADR-0084 carries the full promotion chain; ADR-0078 carries the trace).
#[derive(Debug, Clone, PartialEq)]
pub enum Termination {
    /// The model emitted a terminal text reply. Carries the verbatim text.
    /// Maps to `TurnOutcome::Textual` when the turn had no promotion, or
    /// `TurnOutcome::Materialized` when it also promoted >=1 result (the text
    /// rides as the assumption / side note).
    Text(String),
    /// The step cap was reached without a terminal reply (the agent did not
    /// converge). Carries the cap value so the wiring seam can render an honest
    /// "did not converge in N steps" detail. Maps to `TurnOutcome::Failed`
    /// (ADR-0081 execution-level cap).
    StepCap(u32),
    /// A cancel (user / close / wall-clock watchdog) aborted the turn
    /// (ADR-0021). Maps to `TurnOutcome::Cancelled`. The watchdog is one cause
    /// among several; it shares the cancel path (ADR-0021 timeout -> cancel).
    Cancelled,
    /// No LLM provider is wired / the key was refused (ADR-0044 permanent).
    /// Maps to `TurnOutcome::Failed(NotWired)`.
    NotWired,
    /// The provider configuration is permanently invalid (ADR-0044, e.g. a bad
    /// base_url scheme). Maps to `TurnOutcome::Failed(InvalidConfig)`.
    InvalidConfig(String),
    /// A transient provider fault surfaced after the adapter's own HTTP retry
    /// exhausted (ADR-0077/0081). Maps to `TurnOutcome::Failed(Execute)`.
    Transient(String),
}

/// One entry in the execution trace (ADR-0078). The trace is the persisted,
/// collapsible substructure of a turn; the far window carries only a summary
/// (call count + failure summary), never the full trace verbatim. Mapped to
/// its persisted recipe form ([`RecipeTraceEntry`]) when the turn is recorded
/// (issue #319) -- the mapping drops the ephemeral [`tool_use_id`](Self::tool_use_id).
/// Construction convention: every production producer builds the entry
/// through the [`TraceEntry::succeeded`] / [`TraceEntry::failed`] pair, which
/// owns the failure-anchor invariant at the construction point (fields stay
/// `pub` -- the integration test suites read them directly).
#[derive(Debug, Clone, PartialEq)]
pub struct TraceEntry {
    pub tool_use_id: String,
    pub name: String,
    pub operation_kind: OperationKind,
    /// Short argument summary (the SQL or reference_name), NOT the full args.
    pub summary: String,
    pub success: bool,
    /// Bounded excerpt of the tool result content (or the denial / error
    /// message), captured for BOTH success and failure at dispatch time. Only
    /// the FAILED-call excerpt survives the persisted mapping (a success is
    /// emptied -- see [`RecipeTraceEntry::result_excerpt`]); the in-memory
    /// form keeps the success payload for the loop's own next-turn context.
    pub result_excerpt: String,
}

/// Placeholder a failed call degrades to when its dispatch site produced no
/// message: the excerpt is the cross-turn failure anchor, so it is never
/// empty -- [`reduced_trace`]'s debug guard (issue #316) is compiled out of
/// release builds, so the constructor enforces the floor itself.
const FAILURE_ANCHOR_FALLBACK: &str = "<no failure message>";

/// The trace-excerpt anchor of an approval-gateway denial (the ADR-0078
/// failure anchor, denial flavor): the single source both denial sites -- the
/// dispatch core and the gateway's `tools/call` arm -- construct their rows
/// from, so the wording cannot drift between the two callers.
pub(crate) const DENIED_BY_GATEWAY_EXCERPT: &str = "denied by approval gateway";

/// The model-facing content of a denial (ADR-0077: a tool-level error the
/// agent self-corrects from), shared by the same two denial sites.
pub(crate) const DENIED_BY_GATEWAY_CONTENT: &str = "tool call denied by the approval gateway";

impl TraceEntry {
    /// A completed call's entry: `result_excerpt` carries the bounded success
    /// payload (the loop's own next-turn context; the projections empty it).
    pub fn succeeded(
        tool_use_id: impl Into<String>,
        name: impl Into<String>,
        operation_kind: OperationKind,
        summary: impl Into<String>,
        result_excerpt: impl Into<String>,
    ) -> Self {
        Self {
            tool_use_id: tool_use_id.into(),
            name: name.into(),
            operation_kind,
            summary: summary.into(),
            success: true,
            result_excerpt: result_excerpt.into(),
        }
    }

    /// A failed call's entry: `message` is the bounded failure anchor the
    /// cross-turn retrospection surface renders (ADR-0078); an empty message
    /// degrades to [`FAILURE_ANCHOR_FALLBACK`] so the anchor is never empty
    /// (the constructor-form of the issue #316 guard).
    pub fn failed(
        tool_use_id: impl Into<String>,
        name: impl Into<String>,
        operation_kind: OperationKind,
        summary: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        let message = message.into();
        Self {
            tool_use_id: tool_use_id.into(),
            name: name.into(),
            operation_kind,
            summary: summary.into(),
            success: false,
            result_excerpt: if message.is_empty() {
                FAILURE_ANCHOR_FALLBACK.to_string()
            } else {
                message
            },
        }
    }

    /// The approval-gateway denial row: the failed entry whose bounded anchor
    /// is `DENIED_BY_GATEWAY_EXCERPT` -- the why the resolved-deny row (the
    /// flipped approval card) and the recorded trace both render, single-
    /// sourced across the dispatch core and the gateway's `tools/call` arm.
    pub fn denied(
        tool_use_id: impl Into<String>,
        name: impl Into<String>,
        operation_kind: OperationKind,
        summary: impl Into<String>,
    ) -> Self {
        Self::failed(
            tool_use_id,
            name,
            operation_kind,
            summary,
            DENIED_BY_GATEWAY_EXCERPT,
        )
    }
}

/// Project an in-memory [`TraceEntry`] to its reduced form (ADR-0078): the
/// per-provider `tool_use_id` is gone and a successful call's data-bearing
/// excerpt is emptied; a failed call keeps its bounded message. ONE mapping
/// feeds the persisted [`RecipeTraceEntry`], the display [`TraceEntryView`],
/// and the live `turn-progress` event -- a live row, the recorded trace, and
/// the resumed trace all render the same. The failure-message guard (issue
/// #316) fires once here for both projections: the excerpt is the cross-turn
/// retrospection anchor, so a silent failure panics in debug builds rather
/// than persisting an empty anchor.
fn reduced_trace(entry: &TraceEntry) -> TraceEntryView {
    debug_assert!(
        entry.success || !entry.result_excerpt.is_empty(),
        "a failed trace entry keeps its result message (ADR-0078 failure anchor)"
    );
    TraceEntryView {
        name: entry.name.clone(),
        operation_kind: entry.operation_kind,
        summary: entry.summary.clone(),
        success: entry.success,
        result_excerpt: if entry.success {
            String::new()
        } else {
            entry.result_excerpt.clone()
        },
    }
}

impl RecipeTraceRound {
    /// Map a live in-memory [`LoopRound`] to its persisted recipe form
    /// (ADR-0103, issue #608): the thinking block + connective prose carry
    /// verbatim (no lossy projection -- neither has a `tool_use_id` to drop
    /// or a success payload to empty), and each call maps through
    /// [`RecipeTraceEntry::from_live_trace`]. Named (not `From`) to match
    /// `from_live_trace`'s explicit-lossy-projection convention. Takes the
    /// round by value: the audit is the rounds' last consumer, so the
    /// unbounded thinking/prose texts move instead of cloning (issue #617).
    pub(crate) fn from_live_round(round: LoopRound) -> Self {
        Self {
            thinking: round.thinking,
            text: round.text,
            calls: round
                .calls
                .into_iter()
                .map(|entry| RecipeTraceEntry::from_live_trace(&entry))
                .collect(),
        }
    }
}

impl RecipeTraceEntry {
    /// Map a live in-memory [`TraceEntry`] to its persisted recipe form
    /// (ADR-0078, issue #319): the reduced projection (drop the in-memory
    /// `tool_use_id`, empty a success call's excerpt, keep a failure's message)
    /// is the persisted shape verbatim -- the surviving strings stay bounded at
    /// capture time (`summarize_field` / `TRACE_EXCERPT_MAX`), so no
    /// re-truncation. Named (not `From`) to make the lossy + conditional
    /// projection explicit at the call site (issue #325).
    pub(crate) fn from_live_trace(entry: &TraceEntry) -> Self {
        let v = reduced_trace(entry);
        Self {
            name: v.name,
            operation_kind: v.operation_kind,
            summary: v.summary,
            success: v.success,
            result_excerpt: v.result_excerpt,
        }
    }
}

impl From<&TraceEntry> for TraceEntryView {
    /// The display-trace mapping (ADR-0078, issue #297): the reduced projection
    /// feeds both the live `turn-progress` event and the `TurnRecord::trace`
    /// wire form, so a live row and the resumed trace render identically.
    fn from(entry: &TraceEntry) -> Self {
        reduced_trace(entry)
    }
}

impl From<&LoopRound> for TraceRound {
    /// The round-level display mapping (ADR-0103, issue #608): the live
    /// round projects onto the IPC view beside the entry-level mapping
    /// above, so `record_turn`'s trace view and the loop's recorded rounds
    /// stay field-identical.
    fn from(round: &LoopRound) -> Self {
        Self {
            thinking: round.thinking.clone(),
            text: round.text.clone(),
            calls: round.calls.iter().map(TraceEntryView::from).collect(),
        }
    }
}

/// One round's in-memory trace accumulation (ADR-0103, issue #608): the
/// optional thinking + connective prose of one provider round-trip plus that
/// round's tool calls, in the in-memory [`TraceEntry`] form (still carrying
/// `tool_use_id` + the success payload -- the loop's own context; the
/// persisted / IPC projections drop both via `reduced_trace`). The
/// round-grouped counterpart of [`TraceEntry`]: `outcome` bundles these into
/// [`LoopOutcome::trace`], and the wiring seam maps them onto the
/// `TraceRound` view + the persisted recipe round.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopRound {
    /// The round's thinking block (ADR-0103, issue #614): the readable text
    /// the runtime's provider round produced, `None` when the turn ran
    /// thinking-disabled (no posture level) or every block was redacted.
    pub thinking: Option<ThinkingTrace>,
    /// The round's connective prose (text the model emitted alongside its
    /// tool-call batch), `None` when the reply carried tool calls and no
    /// text.
    pub text: Option<String>,
    /// The round's tool calls, dispatch order.
    pub calls: Vec<TraceEntry>,
}

impl LoopRound {
    /// A round carrying only calls -- the flat-trajectory wrap the
    /// stream-format adapters (claude / codex) and the wiring merge emit
    /// (ADR-0103, issue #608): no prose, no thinking, ONE round for the
    /// whole call list. The ACP-native engine groups its own rounds at the
    /// tool-call batch boundary (issue #611); the remaining flat paths
    /// funnel through here, so the wrap shape (and its rationale) lives
    /// once.
    pub fn flat(calls: Vec<TraceEntry>) -> Self {
        Self {
            thinking: None,
            text: None,
            calls,
        }
    }

    /// Wrap a flat call trajectory into the round-grouped trace form: ONE
    /// [`LoopRound::flat`] round when the trajectory is non-empty, an EMPTY
    /// round list when it is empty (ADR-0103, issue #608). The
    /// empty-stays-empty rule matches the v4->v5 migration (`[]` never
    /// becomes a round with no calls) and the zero-call turn (a zero-call
    /// turn records no round), so a zero-call turn's trace is `[]` on every
    /// runtime path -- no ghost round persisted as `[{}]`.
    pub fn flat_wrap(calls: Vec<TraceEntry>) -> Vec<Self> {
        if calls.is_empty() {
            Vec::new()
        } else {
            vec![Self::flat(calls)]
        }
    }
}

/// Append one completed call's entry to the open round. Shared by the
/// runtimes' outcome assembly (the yoagent fold): the runtime opens a round
/// before dispatching its batch, so the last round is the current one; the
/// fallback folds a call that arrives with no open round (structurally
/// unreachable -- every dispatch site runs after the round push) into a
/// fresh flat round so no trace entry is dropped. One implementation so the
/// fallback semantics cannot drift.
pub(crate) fn push_call(rounds: &mut Vec<LoopRound>, entry: TraceEntry) {
    match rounds.last_mut() {
        Some(round) => round.calls.push(entry),
        None => rounds.push(LoopRound::flat(vec![entry])),
    }
}

/// Drop a round nothing landed on -- no thinking, no prose, no completed
/// call (a cancel between the reply and the first dispatch, a gate-cancelled
/// first call). ADR-0103 (issue #608). Shared by the runtimes' outcome
/// assembly so the recorded trace matches the frontend fold, which cannot
/// see such a round (none of its events ever fired); a prose-bearing round
/// survives (the prose-only round of a mid-batch cancel).
pub(crate) fn retain_landed_rounds(rounds: &mut Vec<LoopRound>) {
    rounds.retain(|round| {
        round.thinking.is_some() || round.text.is_some() || !round.calls.is_empty()
    });
}

/// Shared trace-excerpt truncation (ADR-0078). Exposed `pub(crate)` so the ACP
/// adapter engine ([`crate::runtime::acp`], ADR-0081) bounds a tool-call's
/// result excerpt with the SAME rule every runtime uses -- a trace row from
/// any runtime renders identically (the badge + the failure anchor are the
/// cross-runtime trace contract). The implementation is the one char-level
/// truncator in [`crate::util::truncate_chars_with_ellipsis`], shared with
/// the persisted-summary cap so a cut renders identically everywhere.
pub(crate) fn truncate_trace_excerpt(s: &str, max: usize) -> String {
    crate::util::truncate_chars_with_ellipsis(s, max)
}

/// The model + thought-level catalog extracted from an ACP handshake's
/// `config_options` (ADR-0095 Discovery Decision). Produced by the engine at
/// the handshake boundary (per format: ACP extracts, CodexEventStream has
/// none, ClaudeStreamJson reports the `system{init}` current model),
/// returned to the frontend via `LoopOutcome.discovered_runtime`, and cached
/// on the session for resume cold-start rendering. Pure serde data with its
/// home HERE -- the loop-contract module -- so the contract names no runtime
/// module type; the runtime adapter layer consumes it, not the other way
/// round (issue #696: the contract must not reverse-depend on the runtime).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DiscoveredRuntime {
    /// The model ids the CLI offered (empty when the CLI reports none).
    pub models: Vec<String>,
    /// The model the CLI reported as current / default, if any.
    pub current_model: Option<String>,
    /// The thought-level ids the CLI offered (empty when none).
    pub thought_levels: Vec<String>,
    /// The thought level the CLI reported as current / default, if any.
    pub current_thought_level: Option<String>,
    /// The config id of the catalog entry the CLI used for the model setting,
    /// when a model entry was seen (ADR-0095 D4). The ACP schema makes the
    /// option `id` agent-chosen -- only `category` is the semi-standardized
    /// tag -- so the engine keys injection on this id, falling back to the
    /// category constant when the entry carried no usable id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_config_id: Option<String>,
    /// Same as [`Self::model_config_id`] for the thought-level entry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_level_config_id: Option<String>,
    /// The adapter that produced this catalog (issue #529): stamped by the
    /// engine after the handshake extract, NOT read from the CLI wire (the
    /// config_options shape carries no adapter identity). The frontend
    /// compares it against the active runtime to detect a catalog cached
    /// under a different adapter (stale across a runtime switch). Absent on
    /// recipes persisted before the field existed (old-recipe compatibility).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter_id: Option<String>,
}

impl DiscoveredRuntime {
    /// Nothing discovered (the honest empty shape for a config_options value
    /// that carried no model / thought_level entries).
    pub fn empty() -> Self {
        Self {
            models: Vec::new(),
            current_model: None,
            thought_levels: Vec::new(),
            current_thought_level: None,
            model_config_id: None,
            thought_level_config_id: None,
            adapter_id: None,
        }
    }

    /// True when no selector-facing field carries data (issue #531): the
    /// picker can render nothing from this catalog. The injection-facing
    /// `*_config_id`s and the engine-stamped `adapter_id` are deliberately
    /// excluded -- an id alone can only re-key an already-persisted
    /// selection, it offers the selector nothing.
    pub(crate) fn selector_fields_empty(&self) -> bool {
        self.models.is_empty()
            && self.current_model.is_none()
            && self.thought_levels.is_empty()
            && self.current_thought_level.is_none()
    }
}

/// The structured outcome a turn runtime returns. Pure data -- the wiring seam
/// ([`crate::session::Session::ask_with_phase`], issue #318) maps the four-way
/// termination + promotions onto `TurnOutcome`, and carries the trace
/// alongside to the turn's persisted audit (issue #319, ADR-0078).
#[derive(Debug, Clone)]
pub struct LoopOutcome {
    pub termination: Termination,
    /// Promotions this turn, in promotion order (each successful `materialize`
    /// call). ADR-0022 monotonic numbering applies (result_1, result_2, ...);
    /// a turn with several promotions records the LAST as the turn's primary
    /// result at the wiring seam.
    pub promotions: Vec<Promotion>,
    /// The full round-grouped execution trace (ADR-0078, grouped per
    /// ADR-0103, issue #608): one [`LoopRound`] per provider round-trip.
    /// Collapsible; never enters the far window verbatim -- only its summary
    /// (call count + failure summary) does. The wiring seam persists it on
    /// the turn's recipe entry (issue #319): the real multi-round trajectory,
    /// mapped to [`crate::persistence::recipe::RecipeTraceRound`].
    pub trace: Vec<LoopRound>,
    /// The external runtime's discovered model / thought-level catalog
    /// (ADR-0095). `Some` only on the ACP path (handshake config_options
    /// extraction); the built-in loop and the CodexEventStream path have no
    /// discovery and carry `None` (the ClaudeStreamJson path reports the
    /// `system{init}` current model, ADR-0097) -- the Option distinguishes
    /// "this runtime does not support discovery" from "discovery found
    /// nothing".
    pub discovered_runtime: Option<DiscoveredRuntime>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The persisted-trace mapping (ADR-0078, issue #319): the success
    /// payload is dropped (emptied excerpt), the failure message rides
    /// verbatim -- the excerpt is the cross-turn failure anchor.
    #[test]
    fn persisted_trace_mapping_empties_success_and_carries_failure_messages() {
        let base = |success: bool, excerpt: &str| TraceEntry {
            tool_use_id: "tu_1".into(),
            name: "materialize".into(),
            operation_kind: OperationKind::Write,
            summary: "SELECT 1".into(),
            success,
            result_excerpt: excerpt.into(),
        };
        let ok = RecipeTraceEntry::from_live_trace(&base(true, "42 rows"));
        assert!(ok.success);
        assert!(ok.result_excerpt.is_empty(), "success payload dropped");
        let failed = RecipeTraceEntry::from_live_trace(&base(false, "no such table"));
        assert!(!failed.success);
        assert_eq!(
            failed.result_excerpt, "no such table",
            "the failure message rides verbatim"
        );
    }

    /// The display-trace mapping (issue #297) mirrors the persisted one: the
    /// success payload is dropped, the failure message rides verbatim -- a
    /// live row and the resumed trace render identically.
    #[test]
    fn display_trace_mapping_empties_success_and_carries_failure_messages() {
        let base = |success: bool, excerpt: &str| TraceEntry {
            tool_use_id: "tu_1".into(),
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1".into(),
            success,
            result_excerpt: excerpt.into(),
        };
        let ok = TraceEntryView::from(&base(true, "42 rows"));
        assert!(ok.success);
        assert!(ok.result_excerpt.is_empty(), "success payload dropped");
        let failed = TraceEntryView::from(&base(false, "no such table"));
        assert!(!failed.success);
        assert_eq!(
            failed.result_excerpt, "no such table",
            "the failure message rides verbatim"
        );
    }

    /// The failure-message guard (issue #316): the persisted excerpt is the
    /// cross-turn failure retrospection anchor (ADR-0078), so a failed call
    /// with no message panics in debug builds rather than persisting an
    /// empty anchor.
    #[test]
    #[should_panic(expected = "a failed trace entry keeps its result message")]
    fn persisted_trace_mapping_rejects_a_silent_failure() {
        let entry = TraceEntry {
            tool_use_id: "tu_1".into(),
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1".into(),
            success: false,
            result_excerpt: String::new(),
        };
        let _ = RecipeTraceEntry::from_live_trace(&entry);
    }

    #[test]
    fn truncate_cuts_with_ellipsis() {
        assert_eq!(truncate_trace_excerpt("short", 10), "short");
        let long = "x".repeat(50);
        let cut = truncate_trace_excerpt(&long, 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'), "ends with ellipsis: {cut}");
    }
}
