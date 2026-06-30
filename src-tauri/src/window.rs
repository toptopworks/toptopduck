//! Window assembler (issue #24, ADR-0023/0026/0039/0011): builds the LLM payload
//! handed to the provider each turn -- the windowed conversation history plus
//! every working-set dataset, pruned by the privacy controls. Pure over the
//! working set + conversation thread; the session calls it once per turn and the
//! retry loop re-feeds the result, so every attempt sees an identical payload.
//!
//! This is the one place that turns the session's raw state (the working set +
//! the always-visible thread) into the provider-facing payload. The provider
//! contract types live in [`crate::provider`]; the assembly rules -- which turns
//! are full vs. summarized, which datasets ship samples, how privacy prunes --
//! live here.

use std::collections::HashSet;

use crate::model::{ColumnSchema, DatasetDescriptor, TurnOutcome, TurnRecord};
use crate::provider::{ColumnRef, DatasetRef, ProviderRequest, ResponsePayload, TurnPayload};
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
        active: working_set.active().map(|d| d.reference_name.clone()),
    }
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
                    result: result_name(&turn.outcome),
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
        .filter_map(|t| result_name(&t.outcome))
        .collect()
}

/// A turn's `result_N` name when it materialized one, else `None`.
fn result_name(outcome: &TurnOutcome) -> Option<String> {
    match outcome {
        TurnOutcome::Materialized { dataset, .. } => Some(dataset.reference_name.clone()),
        _ => None,
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
    use crate::model::{DatasetPrivacy, RectifyProvenance, TurnOutcome};

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
        }
    }

    /// A turn that materialized `result`, asked with `question`.
    fn materialized_turn(question: &str, result: &str) -> TurnRecord {
        TurnRecord {
            question: question.to_string(),
            outcome: TurnOutcome::Materialized {
                dataset: Box::new(result_desc(result)),
                sql: Some(format!("SELECT * FROM {}", result)),
                viz: None,
                assumption: None,
            },
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
}
