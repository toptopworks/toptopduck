//! Window assembler (issue #24, ADR-0023/0026/0039/0011): builds the LLM payload
//! handed to the provider each turn -- the windowed conversation history plus
//! every working-set dataset, pruned by the privacy controls. Pure over the
//! working set + conversation thread; the session calls it once per turn and
//! the agent loop re-sends the assembled system prompt + tool table on every
//! round-trip, so the model sees an identical context across the whole turn.
//!
//! This is the one place that turns the session's raw state (the working set +
//! the always-visible thread) into the provider-facing payload. The provider
//! contract types live in [`crate::provider`]; the assembly rules -- which turns
//! are full vs. summarized, which datasets ship samples, how privacy prunes --
//! live here.

use std::collections::HashSet;

use crate::model::{ColumnSchema, DatasetDescriptor, TurnOutcome, TurnRecord};
use crate::provider::prompt::{
    build_acp_context_block, build_tool_system_prompt, render_history_messages, render_response,
    render_skill_block, render_summary_turn_note, ResponseLocale,
};
use crate::provider::tool_calling::{ToolTurnMessage, ToolTurnRequest};
use crate::provider::{
    ColumnRef, DatasetRef, ProviderRequest, ResponsePayload, TurnPayload, MAX_REPLY_TOKENS,
};
use crate::runtime::acp::wire::ContentBlock;
use crate::skills::SkillPromptFragment;
use crate::workingset::WorkingSet;

/// Recent-turn window size (ADR-0023): the most recent N turns ship the full
/// payload; older turns ship only a verbatim-question summary (ADR-0039).
pub const WINDOW_TURNS: usize = 20;

/// Bound on a far-turn summary excerpt, in chars (ADR-0039 "bounded truncation";
/// the ADR leaves the truncation boundary as an impl parameter). The excerpt is
/// the verbatim question cut at this many chars -- never an LLM-regenerated
/// summary.
const FAR_QUESTION_EXCERPT_CHARS: usize = 80;

/// Assemble the provider request for one turn (ADR-0023/0026/0039/0011): the
/// asking question, the windowed conversation history, and every working-set
/// dataset pruned by window + privacy. Pure: reads the working set and thread,
/// returns the payload the orchestrator hands the provider.
pub fn assemble(
    question: &str,
    working_set: &WorkingSet,
    history: &[TurnRecord],
) -> ProviderRequest {
    ProviderRequest {
        question: question.to_string(),
        history: assemble_history(history),
        datasets: assemble_datasets(working_set, history),
        active: resolve_active(working_set, history),
    }
}

/// Assemble the tool-calling request for one agent turn (ADR-0081, issue #318;
/// ADR-0086, issue #364): the tool-use system prompt (capability boundary +
/// mounted-skill fragments + locale directive + the windowed schema context),
/// the windowed conversation as user/assistant message turns closed by the
/// asking question, and the built-in tool table. Pure over the same state as
/// [`assemble`] -- the single-SQL payload is built first and reused as the
/// schema-context source, so the two paths can never disagree on which
/// datasets / samples / privacy pruning the model sees.
///
/// `skills` is the session's resolved mounted-skill fragments (issue #364);
/// an empty slice adds nothing, preserving the pre-skill prompt shape.
///
/// The agent loop owns the request for the whole turn: each round-trip re-sends
/// this system + tool table with the conversation extended by the prior tool
/// batch (the mid-turn tool results never re-window the schema context).
pub fn assemble_tool_turn(
    question: &str,
    working_set: &WorkingSet,
    history: &[TurnRecord],
    locale: ResponseLocale,
    skills: &[SkillPromptFragment],
) -> ToolTurnRequest {
    let request = assemble(question, working_set, history);
    ToolTurnRequest {
        system: build_tool_system_prompt(&request, locale, skills),
        messages: tool_turn_messages(&request),
        tools: crate::tools::builtin_table(),
        max_tokens: MAX_REPLY_TOKENS,
    }
}

/// Assemble the ACP turn's prompt blocks (ADR-0081/0086, issues #299 and #368):
/// the windowed context as text [`ContentBlock`]s for an external CLI runtime.
///
/// Mirrors [`assemble_tool_turn`]'s windowing -- the SAME history rendering --
/// but emits ACP content blocks instead of a [`ToolTurnRequest`], and the
/// leading block carries ONLY locale directive + schema context (no capability
/// boundary prompt: ADR-0086 Consequence -- the external CLI brings its own
/// persona and our boundary is enforced at the tool / gateway surface). The
/// M-contract (`result_N` naming) rides the gateway tool descriptions, not
/// this assembly.
///
/// Mounted-skill fragments (issue #368) land as a SEPARATE text block right
/// before the user's question, reusing the internal path's framing +
/// verbatim-body renderer ([`render_skill_block`]). An empty mount set adds no
/// block, so the pre-skill block order is preserved.
pub fn assemble_acp_turn(
    question: &str,
    working_set: &WorkingSet,
    history: &[TurnRecord],
    locale: ResponseLocale,
    skills: &[SkillPromptFragment],
) -> Vec<ContentBlock> {
    let request = assemble(question, working_set, history);
    let mut blocks = Vec::with_capacity(request.history.len() * 2 + 3);
    // Leading context block (locale + schema only, ADR-0086).
    blocks.push(ContentBlock::text(build_acp_context_block(
        &request, locale,
    )));
    // Windowed history as alternating user/assistant text blocks. Mirrors
    // `tool_turn_messages` turn-for-turn but as flat text -- the external CLI
    // does not see our tool-use message shape, only the rendered prose.
    for turn in &request.history {
        match turn {
            TurnPayload::Full { question, response } => {
                blocks.push(ContentBlock::text(question.clone()));
                blocks.push(ContentBlock::text(render_response(response)));
            }
            TurnPayload::Summary {
                question_excerpt,
                result,
            } => {
                blocks.push(ContentBlock::text(question_excerpt.clone()));
                blocks.push(ContentBlock::text(render_summary_turn_note(result)));
            }
        }
    }
    // Mounted-skill fragments as a separate block before the question (#368).
    if !skills.is_empty() {
        blocks.push(ContentBlock::text(render_skill_block(skills)));
    }
    blocks.push(ContentBlock::text(request.question));
    blocks
}

/// Render the windowed history as tool-calling messages (ADR-0023/0039),
/// closed by the asking question. Delegates the role/content sequence to
/// [`render_history_messages`] so the per-turn rendering stays in one place;
/// each pair is mapped to the tool-calling wire shape. The prior assistant
/// turns carry empty tool-call lists -- the history predates the tool
/// contract (or is rendered text either way), so no `tool_use` pairing rides
/// it; the model reads its own prior turns as prose, exactly as on the
/// single-shot path.
fn tool_turn_messages(request: &ProviderRequest) -> Vec<ToolTurnMessage> {
    render_history_messages(request)
        .into_iter()
        .map(|(role, content)| match role {
            "user" => ToolTurnMessage::user(content),
            "assistant" => ToolTurnMessage::Assistant {
                text: Some(content),
                tool_calls: Vec::new(),
            },
            // render_history_messages only emits user/assistant.
            _ => unreachable!("unknown role from render_history_messages: {role}"),
        })
        .collect()
}

/// Resolve the dataset a question targets by default when the user names none
/// (ADR-0010/0022, issue #27): the most recent **prior** materialized result
/// ("上一步的中间结果"), or -- when no result exists yet -- the most-recently-
/// uploaded source ("会话开始 = 最近上传源"). `history` is the thread *before*
/// the asking turn, so this is the previous step's result. Textual/failed turns
/// produce no result, so a trailing clarify block does not move the default off
/// the last result.
///
/// The resolved name rides the payload's `active` as a **default hint**, not a
/// lock: the provider may still redirect by natural language ("在原始数据上").
/// Resolution is deterministic here; the LLM's implicit reading of the question
/// is the #8 wiring slice. [`Session::active`](crate::session::Session::active)
/// calls this too, so the UI's "当前表" indicator agrees with the payload.
///
/// This reads the **full** thread, not the [`WINDOW_TURNS`]-windowed slice
/// [`assemble_history`] ships: the default must track the truly most-recent
/// result even after its producing turn has collapsed to a far-window summary
/// (ADR-0023), so a long thread's default never silently drifts back to the
/// source. `active` is a top-level payload pointer, independent of which turns
/// the window happened to keep -- do not "fix" this to read the windowed slice.
pub fn resolve_active(working_set: &WorkingSet, history: &[TurnRecord]) -> Option<String> {
    let last_result = history.iter().rev().find_map(|t| {
        // The active default is the turn's primary result (ADR-0084): the
        // chain tail of a multi-promotion turn -- the final answer the user's
        // question produced. Skip stale results (issue #40, ADR-0013): the
        // focus must never land on a soft-invalidated result. The stale flag
        // lives on the working-set descriptor (the TurnRecord snapshot is the
        // at-materialization state), so check the live working set by name --
        // a stale result keeps producing turns visible in the thread, this
        // only stops it from being the next question's default target.
        let primary = t.outcome.primary_promotion()?;
        if working_set.is_stale(&primary.dataset.reference_name) {
            None
        } else {
            Some(primary.dataset.reference_name.clone())
        }
    });
    last_result.or_else(|| working_set.active().map(|d| d.reference_name.clone()))
}

/// Build the windowed conversation payload (ADR-0023/0039). The last
/// [`WINDOW_TURNS`] turns are full; any older turns collapse to a verbatim-
/// question excerpt plus the produced `result_N` name. Oldest turn first.
fn assemble_history(history: &[TurnRecord]) -> Vec<TurnPayload> {
    // Turns older than the recent N=20 window. saturating_sub keeps an empty /
    // short history entirely in-window (no summaries).
    let far_count = history.len().saturating_sub(WINDOW_TURNS);
    history
        .iter()
        .enumerate()
        .map(|(i, turn)| {
            if i < far_count {
                TurnPayload::Summary {
                    question_excerpt: truncate_question(&turn.question),
                    // The far-window one-line summary names the turn's primary
                    // result (ADR-0084 chain tail); antecedent promotions ride
                    // the dataset blocks, not the per-turn summary line.
                    result: turn
                        .outcome
                        .primary_promotion()
                        .map(|p| p.dataset.reference_name.clone()),
                }
            } else {
                TurnPayload::Full {
                    question: turn.question.clone(),
                    response: ResponsePayload::from(&turn.outcome),
                }
            }
        })
        .collect()
}

/// Build the per-dataset payload (ADR-0022/0026/0011). Sources always carry
/// full schema + samples; a `result_N` carries samples only when the turn that
/// produced it sits within the recent window. Privacy prunes samples (the
/// per-dataset switch) and column names + values (type-only columns) across
/// every dataset, source or result alike.
fn assemble_datasets(working_set: &WorkingSet, history: &[TurnRecord]) -> Vec<DatasetRef> {
    let in_window_results = recent_result_names(history);
    working_set
        .list()
        .iter()
        // Exclude stale results (issue #40, ADR-0013 invariant 3): a stale
        // result_N must not enter the LLM-visible working set. Sources are
        // never stale (removed outright, not soft-invalidated).
        .filter(|d| d.stale.is_none())
        .map(|d| dataset_ref(d, working_set, &in_window_results))
        .collect()
}

/// Assemble one dataset's payload. A source is always in-window (ADR-0023 --
/// sources always sent full); a result is in-window iff its producing turn is
/// among the recent N=20.
fn dataset_ref(
    d: &DatasetDescriptor,
    working_set: &WorkingSet,
    in_window_results: &HashSet<String>,
) -> DatasetRef {
    let is_source = !working_set.is_result(&d.reference_name);
    let in_window = is_source || in_window_results.contains(&d.reference_name);
    let type_only = type_only_set(&d.privacy.type_only_columns);
    DatasetRef {
        reference_name: d.reference_name.clone(),
        sql_ref: working_set
            .sql_from(&d.reference_name)
            .expect("working set list() entries are always registered"),
        columns: pruned_columns(&d.columns, &type_only),
        row_count: d.row_count,
        sample: sample_for(d, in_window, &type_only),
    }
}

/// Reference names of the results produced by the recent (in-window) turns --
/// the turns within the last [`WINDOW_TURNS`]. A result is in-window iff its
/// producing turn is; sources are always in-window (handled by the caller).
fn recent_result_names(history: &[TurnRecord]) -> HashSet<String> {
    let far_count = history.len().saturating_sub(WINDOW_TURNS);
    history
        .iter()
        .skip(far_count)
        .flat_map(|t| result_names(&t.outcome))
        .collect()
}

/// A turn's `result_N` names (ADR-0084): every promotion's reference name, in
/// promotion order; empty for a non-result turn. "In-window" is a turn-level
/// property, so a recent multi-promotion turn contributes ALL its promotions
/// (antecedents included) -- they ship with samples, not schema-only.
fn result_names(outcome: &TurnOutcome) -> Vec<String> {
    match outcome {
        TurnOutcome::Materialized { promotions, .. } => promotions
            .iter()
            .map(|p| p.dataset.reference_name.clone())
            .collect(),
        _ => Vec::new(),
    }
}

/// The frozen first-3 sample for a dataset when samples may ship: the dataset is
/// in-window AND the user has not turned samples off (ADR-0011). Type-only
/// columns withhold their cells (`None`) so a sample row stays positionally
/// aligned to the pruned column list. `None` when samples are withheld entirely.
fn sample_for(
    d: &DatasetDescriptor,
    in_window: bool,
    type_only: &HashSet<String>,
) -> Option<Vec<Vec<Option<String>>>> {
    if !in_window || !d.privacy.send_samples {
        return None;
    }
    Some(
        d.sample
            .iter()
            .map(|row| pruned_row(row, &d.columns, type_only))
            .collect(),
    )
}

/// Map a descriptor's columns to payload columns, hiding the name of any
/// type-only column (ADR-0011): the canonical type ships, the name does not.
fn pruned_columns(columns: &[ColumnSchema], type_only: &HashSet<String>) -> Vec<ColumnRef> {
    columns
        .iter()
        .map(|c| ColumnRef {
            name: if type_only.contains(&c.name) {
                None
            } else {
                Some(c.name.clone())
            },
            canonical_type: c.canonical_type.clone(),
        })
        .collect()
}

/// One sample row with type-only cells withheld (`None`). Cells stay aligned to
/// `columns` by position so the provider can pair each value with its column; a
/// short row (fewer cells than columns) leaves the trailing columns unsampled.
fn pruned_row(
    row: &[String],
    columns: &[ColumnSchema],
    type_only: &HashSet<String>,
) -> Vec<Option<String>> {
    row.iter()
        .enumerate()
        .map(|(i, cell)| {
            let hidden = columns
                .get(i)
                .map(|c| type_only.contains(&c.name))
                .unwrap_or(false);
            if hidden {
                None
            } else {
                Some(cell.clone())
            }
        })
        .collect()
}

/// Verbatim-question excerpt for a far-turn summary (ADR-0039): the question cut
/// at [`FAR_QUESTION_EXCERPT_CHARS`] chars, with an ellipsis when truncated.
/// Never LLM-generated -- the excerpt is always a prefix of the user's exact
/// words, which is the whole point of ADR-0039 (faithful + zero extra calls).
fn truncate_question(question: &str) -> String {
    let chars: Vec<char> = question.chars().collect();
    if chars.len() <= FAR_QUESTION_EXCERPT_CHARS {
        return question.to_string();
    }
    let head: String = chars.iter().take(FAR_QUESTION_EXCERPT_CHARS).collect();
    format!("{head}…")
}

/// Build the type-only column set, trimmed of blanks (mirrors the working-set
/// normalization: blank entries are ignored at read time, ADR-0011).
fn type_only_set(cols: &[String]) -> HashSet<String> {
    cols.iter()
        .filter(|c| !c.trim().is_empty())
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::OperationKind;
    use crate::model::{
        DatasetPrivacy, Promotion, RectifyProvenance, TextKind, TraceEntryView, TraceRound,
        TurnFailure, TurnOutcome, TurnProvenance,
    };

    /// Build column schemas from (name, type) pairs.
    fn cols(specs: &[(&str, &str)]) -> Vec<ColumnSchema> {
        specs
            .iter()
            .map(|(n, t)| ColumnSchema {
                name: (*n).to_string(),
                canonical_type: (*t).to_string(),
            })
            .collect()
    }

    /// A source descriptor with the given columns + frozen sample rows.
    fn source(name: &str, columns: &[(&str, &str)], sample: Vec<Vec<String>>) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: name.to_string(),
            display_name: name.to_string(),
            source_path: String::new(),
            columns: cols(columns),
            row_count: sample.len() as u64,
            sample,
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    /// A one-row result descriptor (the shape a `SELECT ... AS n` turn yields).
    fn result_desc(name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: name.to_string(),
            display_name: name.to_string(),
            source_path: String::new(),
            columns: cols(&[("n", "BIGINT")]),
            row_count: 1,
            sample: vec![vec!["1".to_string()]],
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    /// A turn that materialized `result`, asked with `question`.
    fn materialized_turn(question: &str, result: &str) -> TurnRecord {
        TurnRecord {
            question: question.to_string(),
            outcome: TurnOutcome::Materialized {
                promotions: vec![Promotion {
                    dataset: result_desc(result),
                    sql: format!("SELECT * FROM {}", result),
                }],
                viz: None,
                assumption: None,
            },
            // The window assembler reads question + outcome only (ADR-0078
            // summary-only far window), so test turns carry an empty trace.
            trace: vec![],
            provenance: TurnProvenance::default(),
            asked_at: None,
            settled_at: None,
        }
    }

    /// Register a source + N results, and build N matching materialized turns.
    /// Returns the history; the working set is mutated in place.
    fn source_plus_turns(n: usize) -> (WorkingSet, Vec<TurnRecord>) {
        let mut ws = WorkingSet::default();
        ws.register(source(
            "people",
            &[("id", "BIGINT"), ("name", "VARCHAR")],
            vec![
                vec!["1".to_string(), "Al".to_string()],
                vec!["2".to_string(), "Bo".to_string()],
                vec!["3".to_string(), "Cy".to_string()],
            ],
        ));
        let mut history = Vec::with_capacity(n);
        for k in 1..=n {
            let name = format!("result_{k}");
            ws.register_result(result_desc(&name));
            history.push(materialized_turn(&format!("turn {k}"), &name));
        }
        (ws, history)
    }

    #[test]
    fn under_window_every_turn_is_full() {
        // <= N=20 turns: no summaries -- the whole thread ships full.
        let (ws, history) = source_plus_turns(5);
        let payload = assemble("probe", &ws, &history);
        assert_eq!(payload.history.len(), 5);
        assert!(payload
            .history
            .iter()
            .all(|t| matches!(t, TurnPayload::Full { .. })));
        // Every result is in-window, so every result ships its sample.
        assert!(payload
            .datasets
            .iter()
            .filter(|d| d.reference_name.starts_with("result_"))
            .all(|d| d.sample.is_some()));
    }

    #[test]
    fn turns_beyond_window_collapse_to_summary() {
        // 21 turns: the oldest (turn 1 -> result_1) falls out of the N=20 window
        // and becomes a summary; the recent 20 stay full (ADR-0023).
        let (ws, history) = source_plus_turns(21);
        let payload = assemble("probe", &ws, &history);
        assert_eq!(payload.history.len(), 21);
        let summaries = payload
            .history
            .iter()
            .filter(|t| matches!(t, TurnPayload::Summary { .. }))
            .count();
        assert_eq!(summaries, 1);
        assert_eq!(
            payload
                .history
                .iter()
                .filter(|t| matches!(t, TurnPayload::Full { .. }))
                .count(),
            20
        );
        // The oldest turn is the one summarized, and it still names its result so
        // the provider can retarget it (ADR-0010/0023).
        match &payload.history[0] {
            TurnPayload::Summary {
                question_excerpt,
                result,
            } => {
                assert_eq!(question_excerpt, "turn 1"); // short -> verbatim, no truncation
                assert_eq!(result.as_deref(), Some("result_1"));
            }
            other => panic!("oldest turn should be Summary, got {other:?}"),
        }
        assert!(matches!(
            payload.history.last().unwrap(),
            TurnPayload::Full { .. }
        ));
    }

    /// ADR-0078 summary-only far window (issue #297): the trace (the rail's
    /// tool-call chain) never reaches the LLM window -- `assemble_history` reads
    /// `question` + `outcome` only, never `trace`. The failure excerpt persists
    /// cross-turn as the rail's retrospection anchor, so a regression that let
    /// trace text leak into a TurnPayload would silently inflate the LLM context
    /// and cross the ADR-0036 contents boundary. Asserted with sentinel strings
    /// so any field that picks up trace data trips.
    #[test]
    fn window_history_carries_no_trace_data_adr_0078() {
        let trace_failure_excerpt = "SENTINEL_TRACE_FAILURE";
        let trace_summary = "SENTINEL_TRACE_SUMMARY";
        let poisoned_trace = vec![TraceRound {
            thinking: None,
            text: None,
            calls: vec![
                TraceEntryView {
                    name: "explore".into(),
                    operation_kind: OperationKind::Read,
                    summary: trace_summary.into(),
                    success: false,
                    result_excerpt: trace_failure_excerpt.into(),
                },
                TraceEntryView {
                    name: "materialize".into(),
                    operation_kind: OperationKind::Write,
                    summary: trace_summary.into(),
                    success: true,
                    result_excerpt: String::new(),
                },
            ],
        }];

        // In-window (Full payload): a single trace-bearing turn.
        let mut ws = WorkingSet::default();
        ws.register(source(
            "people",
            &[("id", "BIGINT")],
            vec![vec!["1".to_string()]],
        ));
        ws.register_result(result_desc("result_1"));
        let history = vec![TurnRecord {
            question: "turn 1".to_string(),
            outcome: TurnOutcome::Materialized {
                promotions: vec![Promotion {
                    dataset: result_desc("result_1"),
                    sql: "SELECT 1".to_string(),
                }],
                viz: None,
                assumption: None,
            },
            trace: poisoned_trace.clone(),
            provenance: TurnProvenance::default(),
            asked_at: None,
            settled_at: None,
        }];
        let payload = assemble("probe", &ws, &history);
        let full = format!("{:?}", payload.history);
        assert!(
            !full.contains(trace_failure_excerpt),
            "ADR-0078: a failure trace excerpt leaked into an in-window Full TurnPayload:\n{full}"
        );
        assert!(
            !full.contains(trace_summary),
            "ADR-0078: a trace summary leaked into an in-window Full TurnPayload:\n{full}"
        );

        // Far-window (Summary payload): 21 turns, turn 1 carries the poisoned
        // trace and falls out of the N=20 window into a Summary.
        let (ws2, mut history2) = source_plus_turns(21);
        history2[0].trace = poisoned_trace;
        let payload2 = assemble("probe", &ws2, &history2);
        let summary = format!("{:?}", payload2.history);
        assert!(
            !summary.contains(trace_failure_excerpt),
            "ADR-0078: a failure trace excerpt leaked into a far-window Summary TurnPayload:\n{summary}"
        );
        assert!(
            !summary.contains(trace_summary),
            "ADR-0078: a trace summary leaked into a far-window Summary TurnPayload:\n{summary}"
        );
    }

    #[test]
    fn out_of_window_result_withholds_sample_in_window_sends_it() {
        // ADR-0026: a result_N whose turn is beyond the window ships no sample;
        // in-window results and every source do.
        let (ws, history) = source_plus_turns(21);
        let payload = assemble("probe", &ws, &history);
        let find = |name: &str| {
            payload
                .datasets
                .iter()
                .find(|d| d.reference_name == name)
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        assert_eq!(find("result_1").sample, None); // turn 1 is far -> no sample
        assert!(find("result_2").sample.is_some()); // in-window
        assert!(find("result_21").sample.is_some()); // most recent, in-window
        assert!(find("people").sample.is_some()); // source always samples
    }

    #[test]
    fn a_recent_multi_promotion_turn_ships_samples_for_its_antecedents_too() {
        // ADR-0084: "in-window" is a turn-level property, so a recent
        // multi-promotion turn ships samples for EVERY promotion -- antecedents
        // included, not just the primary. result_1 (the chain head) and result_2
        // (the primary tail) ride the same in-window turn, so both carry
        // samples; neither is demoted to schema-only.
        let mut ws = WorkingSet::default();
        ws.register(source(
            "people",
            &[("id", "BIGINT")],
            vec![vec!["1".to_string()]],
        ));
        ws.register_result(result_desc("result_1"));
        ws.register_result(result_desc("result_2"));
        let history = vec![TurnRecord {
            question: "两步晋升".to_string(),
            outcome: TurnOutcome::Materialized {
                promotions: vec![
                    Promotion {
                        dataset: result_desc("result_1"),
                        sql: "SELECT 1".to_string(),
                    },
                    Promotion {
                        dataset: result_desc("result_2"),
                        sql: "SELECT 2".to_string(),
                    },
                ],
                viz: None,
                assumption: None,
            },
            trace: vec![],
            provenance: TurnProvenance::default(),
            asked_at: None,
            settled_at: None,
        }];
        let payload = assemble("probe", &ws, &history);
        let find = |name: &str| {
            payload
                .datasets
                .iter()
                .find(|d| d.reference_name == name)
                .unwrap_or_else(|| panic!("missing {name}"))
        };
        assert!(
            find("result_1").sample.is_some(),
            "the antecedent promotion ships a sample (its turn is in-window)"
        );
        assert!(
            find("result_2").sample.is_some(),
            "the primary promotion ships a sample"
        );
    }

    #[test]
    fn source_schema_is_always_full() {
        // ADR-0023: every source ships its full schema regardless of window.
        let (ws, history) = source_plus_turns(21);
        let payload = assemble("probe", &ws, &history);
        let people = payload
            .datasets
            .iter()
            .find(|d| d.reference_name == "people")
            .unwrap();
        assert_eq!(people.columns.len(), 2);
        assert_eq!(people.columns[0].name.as_deref(), Some("id"));
        assert_eq!(people.columns[0].canonical_type, "BIGINT");
        assert_eq!(people.columns[1].name.as_deref(), Some("name"));
        assert_eq!(people.columns[1].canonical_type, "VARCHAR");
        assert_eq!(people.sql_ref, r#""people".data"#);
    }

    #[test]
    fn privacy_samples_off_withholds_a_sources_samples() {
        // ADR-0011: a dataset with send_samples=false ships schema but no cells.
        let (mut ws, _) = source_plus_turns(0);
        ws.set_privacy(
            "people",
            DatasetPrivacy {
                send_samples: false,
                type_only_columns: vec![],
            },
        );
        let payload = assemble("any", &ws, &[]);
        let people = payload
            .datasets
            .iter()
            .find(|d| d.reference_name == "people")
            .unwrap();
        assert_eq!(people.sample, None);
        // schema still full -- only the values are withheld.
        assert_eq!(people.columns.len(), 2);
        assert_eq!(people.columns[0].name.as_deref(), Some("id"));
    }

    #[test]
    fn privacy_type_only_column_hides_name_and_values() {
        // ADR-0011: a type-only column ships its type but neither its name nor
        // any sample value (positional alignment preserved via None).
        let (mut ws, _) = source_plus_turns(0);
        ws.set_privacy(
            "people",
            DatasetPrivacy {
                send_samples: true,
                type_only_columns: vec!["name".into()],
            },
        );
        let payload = assemble("any", &ws, &[]);
        let people = payload
            .datasets
            .iter()
            .find(|d| d.reference_name == "people")
            .unwrap();
        let name_col = people
            .columns
            .iter()
            .find(|c| c.canonical_type == "VARCHAR")
            .unwrap();
        assert_eq!(name_col.name, None); // name hidden, type present
                                         // sample: id cells ship, name cells withheld (None) at the same position.
        let row = people.sample.as_ref().unwrap().first().unwrap();
        assert_eq!(row[0], Some("1".to_string())); // id
        assert_eq!(row[1], None); // name (type-only) withheld
    }

    #[test]
    fn far_summary_is_verbatim_truncation_never_generated() {
        // ADR-0039: a far-turn excerpt is a verbatim prefix of the user's exact
        // question (+ ellipsis), never an LLM-regenerated summary.
        let long = "问题".repeat(60); // 120 chars -- multibyte, well past the bound
        assert!(long.chars().count() > FAR_QUESTION_EXCERPT_CHARS);
        let mut ws = WorkingSet::default();
        ws.register(source(
            "people",
            &[("id", "BIGINT")],
            vec![vec!["1".to_string()]],
        ));
        // 21 turns: the first is far and carries the long question.
        let mut history = Vec::with_capacity(21);
        history.push(materialized_turn(&long, "result_1"));
        for k in 2..=21 {
            let name = format!("result_{k}");
            ws.register_result(result_desc(&name));
            history.push(materialized_turn(&format!("turn {k}"), &name));
        }
        let payload = assemble("probe", &ws, &history);
        match &payload.history[0] {
            TurnPayload::Summary {
                question_excerpt, ..
            } => {
                let prefix: String = long.chars().take(FAR_QUESTION_EXCERPT_CHARS).collect();
                assert_eq!(question_excerpt, &format!("{prefix}…"));
                assert!(long.starts_with(prefix.as_str())); // verbatim, not generated
            }
            other => panic!("expected Summary, got {other:?}"),
        }
    }

    // --- Active dataset resolution (issue #27) -- ADR-0010/0022 -------------
    //
    // The resolved active is the dataset a question targets by default -- the
    // most recent prior result ("上一步的中间结果"), falling back to the most-
    // recently-uploaded source at session start. The real LLM may still redirect
    // by natural language (ADR-0010); `active` is the default hint carried in the
    // payload, not a lock.

    /// A textual turn that produces no result -- used to prove the resolved
    /// active skips non-materialized turns.
    fn textual_turn(question: &str) -> TurnRecord {
        TurnRecord {
            question: question.to_string(),
            outcome: TurnOutcome::Textual {
                text_kind: TextKind::Clarify,
                body: "哪个维度？".into(),
                assumption: None,
            },
            trace: vec![],
            provenance: TurnProvenance::default(),
            asked_at: None,
            settled_at: None,
        }
    }

    /// A failed turn (ADR-0028: retry budget exhausted) that produces no result
    /// -- the failed half of "skip non-materialized turns", paired with
    /// [`textual_turn`] above.
    fn failed_turn(question: &str) -> TurnRecord {
        TurnRecord {
            question: question.to_string(),
            outcome: TurnOutcome::Failed(TurnFailure::Execute {
                detail: "budget exhausted".into(),
            }),
            trace: vec![],
            provenance: TurnProvenance::default(),
            asked_at: None,
            settled_at: None,
        }
    }

    #[test]
    fn resolve_active_is_the_most_recent_source_when_no_result_exists() {
        // AC1 (issue #27): before any turn, the resolved active is the most-
        // recently-uploaded source (ADR-0022 active default). A second upload
        // moves the source-level active pointer to it.
        let (mut ws, _) = source_plus_turns(0);
        ws.register(source(
            "orders",
            &[("order_id", "BIGINT")],
            vec![vec!["1".to_string()]],
        ));
        assert_eq!(resolve_active(&ws, &[]).as_deref(), Some("orders"));
    }

    #[test]
    fn resolve_active_is_the_most_recent_prior_result_after_turns() {
        // AC2 (issue #27): once results exist, the resolved active is the most
        // recent prior result ("上一步的中间结果"), not the source.
        let (ws, history) = source_plus_turns(3);
        assert_eq!(resolve_active(&ws, &history).as_deref(), Some("result_3"));
    }

    #[test]
    fn resolve_active_skips_non_materialized_turns() {
        // A textual / failed turn produces no intermediate result, so the
        // resolved active stays at the most recent RESULT, not the most recent
        // turn. The default "上一步的中间结果" is the last result that actually
        // materialized.
        let (ws, history) = source_plus_turns(2);
        let mut history = history;
        history.push(textual_turn("哪个名字"));
        assert_eq!(resolve_active(&ws, &history).as_deref(), Some("result_2"));
    }

    #[test]
    fn resolve_active_falls_back_to_source_when_no_turn_materialized() {
        // Every prior turn is textual/failed (no result) -> fall back to the
        // source-level active (most recent upload). people is the only source.
        let (ws, _) = source_plus_turns(0);
        let history = vec![textual_turn("哪个名字")];
        assert_eq!(resolve_active(&ws, &history).as_deref(), Some("people"));
    }

    #[test]
    fn resolve_active_is_none_for_an_empty_working_set() {
        // Nothing loaded, nothing asked -> no active. The provider is told there
        // is no default (the ask path guards against this earlier, but the
        // resolver stays total: empty in, None out).
        let ws = WorkingSet::default();
        assert_eq!(resolve_active(&ws, &[]), None);
    }

    #[test]
    fn assemble_carries_the_resolved_active_into_the_payload() {
        // The resolved active rides the payload's `active` field -- the contract
        // the provider sees. After result_3, active = result_3, not the source.
        let (ws, history) = source_plus_turns(3);
        let payload = assemble("probe", &ws, &history);
        assert_eq!(payload.active.as_deref(), Some("result_3"));
    }

    #[test]
    fn assemble_active_is_the_source_before_any_result() {
        // AC1 wiring: with no results, the payload's `active` is the source-level
        // active (most recent upload), so the provider's default points at it.
        let (mut ws, _) = source_plus_turns(0);
        ws.register(source(
            "orders",
            &[("order_id", "BIGINT")],
            vec![vec!["1".to_string()]],
        ));
        let payload = assemble("probe", &ws, &[]);
        assert_eq!(payload.active.as_deref(), Some("orders"));
    }

    #[test]
    fn resolve_active_skips_failed_turns_too() {
        // A failed turn (ADR-0028) produces no result, so the resolved active
        // stays at the most recent RESULT -- the failed half of AC2's "skip
        // non-materialized turns", paired with
        // `resolve_active_skips_non_materialized_turns` (the textual half).
        let (ws, history) = source_plus_turns(2);
        let mut history = history;
        history.push(failed_turn("坏查询"));
        assert_eq!(resolve_active(&ws, &history).as_deref(), Some("result_2"));
    }

    #[test]
    fn resolve_active_reads_full_history_not_the_window() {
        // ADR-0023 / issue #27: resolve_active reads the FULL thread, not the
        // WINDOW_TURNS window `assemble_history` ships. When the most recent
        // result's producing turn has collapsed to a far-window summary (and
        // its sample is withheld), the resolved default is STILL that result --
        // a long thread's default never silently drifts back to the source.
        //
        // Layout: 1 materialized turn (result_1) + 20 textual turns = 21 turns.
        // The oldest (result_1's turn) falls out of the N=20 window: it becomes
        // a summary and result_1's sample is withheld. Yet active stays result_1.
        let (ws, history) = source_plus_turns(1);
        let mut history = history;
        for i in 0..WINDOW_TURNS {
            history.push(textual_turn(&format!("追问 {i}")));
        }
        assert_eq!(history.len(), WINDOW_TURNS + 1);

        let payload = assemble("probe", &ws, &history);
        // Guards: the window really did fold result_1's turn and withhold its
        // sample -- without these, this test stops proving the out-of-window case.
        assert!(matches!(payload.history[0], TurnPayload::Summary { .. }));
        let result_1 = payload
            .datasets
            .iter()
            .find(|d| d.reference_name == "result_1")
            .expect("result_1 registered");
        assert!(
            result_1.sample.is_none(),
            "out-of-window result drops its sample"
        );
        // The contract under test: active still names the out-of-window result.
        assert_eq!(payload.active.as_deref(), Some("result_1"));
    }

    // --- assemble_acp_turn (ADR-0086, issue #368) ---------------------------
    //
    // The external-runtime ACP assembly differs from the built-in path in two
    // ways per ADR-0086: (1) NO capability boundary prompt -- the external CLI
    // brings its own persona and our boundary is enforced at the tool / gateway
    // surface; (2) mounted-skill fragments land as a SEPARATE text block before
    // the user's question, not embedded in a system prompt. These tests pin
    // both invariants + the block ordering.

    fn acp_fragment(name: &str, body: &str) -> SkillPromptFragment {
        SkillPromptFragment {
            name: name.into(),
            body: body.into(),
            content_hash: "deadbeef".into(),
            mcp_servers: Vec::new(),
        }
    }

    #[test]
    fn assemble_acp_turn_leading_block_has_no_capability_boundary() {
        // ADR-0086: the leading context block carries locale + schema ONLY.
        // The capability boundary landmarks (IN-SCOPE / OUT-SCOPE / refuse)
        // must be absent so they do not compete with the CLI's own persona.
        let (ws, history) = source_plus_turns(1);
        let blocks = assemble_acp_turn("查询", &ws, &history, ResponseLocale::ZhCN, &[]);
        let leading = blocks.first().expect("at least one block");
        let text = leading.as_text().expect("leading block is text");
        assert!(text.contains("【数据上下文】"), "schema context present");
        assert!(text.contains("【回复语言】"), "locale directive present");
        assert!(!text.contains("IN-SCOPE"), "no capability boundary");
        assert!(!text.contains("OUT-OF-SCOPE"), "no capability boundary");
        assert!(!text.contains("绝不冒充"), "no capability boundary");
    }

    #[test]
    fn assemble_acp_turn_with_skills_places_skill_block_before_question() {
        // Issue #368 AC#1: mounted-skill fragments land as a separate text
        // block right before the user's question (after the history blocks).
        let (ws, history) = source_plus_turns(1);
        let skills = vec![acp_fragment("sql-coach", "Name the method.\n")];
        let blocks = assemble_acp_turn("查询", &ws, &history, ResponseLocale::ZhCN, &skills);
        // Last block = the user's question.
        let last = blocks.last().expect("at least one block");
        assert_eq!(last.as_text().unwrap(), "查询");
        // Second-to-last = the skill block (skills are non-empty).
        let skill_block = &blocks[blocks.len() - 2];
        let skill_text = skill_block.as_text().unwrap();
        assert!(
            skill_text.contains("【挂载技能】技能 `sql-coach`："),
            "skill frame in separate block"
        );
        assert!(
            skill_text.contains("Name the method."),
            "skill body verbatim in separate block"
        );
        // The skill block is NOT the leading block (which holds schema + locale).
        let leading = blocks.first().unwrap().as_text().unwrap();
        assert!(
            !leading.contains("【挂载技能】"),
            "skill fragments must not be in the leading block"
        );
    }

    #[test]
    fn assemble_acp_turn_empty_skills_omits_skill_block() {
        // An empty mount set adds no skill block -- the question is the last
        // block and the block count matches the pre-skill shape.
        let (ws, history) = source_plus_turns(1);
        let blocks_empty = assemble_acp_turn("查询", &ws, &history, ResponseLocale::ZhCN, &[]);
        // Last block is the question, second-to-last is a history block (not a
        // skill block).
        assert_eq!(blocks_empty.last().unwrap().as_text().unwrap(), "查询");
        // With skills added, the block count grows by exactly 1 (the skill
        // block); the question stays last.
        let skills = vec![acp_fragment("a", "Body A.\n")];
        let blocks_with = assemble_acp_turn("查询", &ws, &history, ResponseLocale::ZhCN, &skills);
        assert_eq!(
            blocks_with.len(),
            blocks_empty.len() + 1,
            "exactly one skill block added"
        );
        assert_eq!(blocks_with.last().unwrap().as_text().unwrap(), "查询");
    }

    #[test]
    fn assemble_acp_turn_skill_block_preserves_mount_order() {
        // Mount order is preserved in the skill block (not sorted).
        let (ws, history) = source_plus_turns(0);
        let skills = vec![
            acp_fragment("beta", "Body B.\n"),
            acp_fragment("alpha", "Body A.\n"),
        ];
        let blocks = assemble_acp_turn("查询", &ws, &history, ResponseLocale::ZhCN, &skills);
        let skill_block = &blocks[blocks.len() - 2];
        let text = skill_block.as_text().unwrap();
        let b = text.find("beta").unwrap();
        let a = text.find("alpha").unwrap();
        assert!(b < a, "mount order preserved, not sorted");
    }
}
