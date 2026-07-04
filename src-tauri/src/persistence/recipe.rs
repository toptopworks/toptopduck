//! Recipe model (ADR-0034/0036/0042): the durable, portable description of a
//! Session's current working set. A `.duck` file is this recipe serialized as
//! text (JSON). The recipe holds only what resume needs to rebuild the working
//! set -- never the materialized result data (re-derived by eager replay),
//! never the LLM viz state (regenerated on demand, ADR-0033/0036), never any
//! execution metadata (token / row-count / timing, ADR-0036), and never any
//! secret (ADR-0036 secrets-never -- the BYOK key rides the OS keychain).
//!
//! The conversation timeline mirrors [`crate::model::ThreadEntry`] but trims
//! every field resume re-derives: a Materialized turn carries the result
//! reference name, the display label, the verbatim SQL, and the assumption
//! note -- but NOT the columns / sample / row-count / fingerprint / viz (all
//! rebuilt by replay). Source lifecycle events pass through verbatim
//! (ADR-0040). The productive replay chain is derived from this history at
//! resume time, so the recipe has one source of truth, not two.

use serde::{Deserialize, Serialize};

use crate::model::{RectifyProvenance, SourceLifecycleEvent, TextKind};

/// v1 recipe format version (ADR-0036). Opening routes on this value: equal
/// -> normal; lower -> forward-migrate; higher -> honest refuse. v1 is the
/// only version today, so the open path pins it exactly. Future versions bump
/// this and add a migration transform.
pub const RECIPE_FORMAT_VERSION: u32 = 1;

/// One source Dataset's portable reference (ADR-0034/0036/0042). Paths use
/// the **hybrid representation** ADR-0036 §4 mandates: `source_path` is always
/// absolute (the fallback resolver); `relative_path` is set when the source
/// lives inside the `.duck` file's directory subtree (the primary resolver --
/// it survives "move the folder" portability). Cross-volume / outside-subtree
/// sources carry `relative_path = None`, and resume falls back to
/// `source_path`. Both forms undergo fingerprint verification (ADR-0035).
///
/// The rectify choices are the user's explicit decisions (CSV/JSON/Parquet =
/// N/A; Excel carries the user header/skip decisions, never the auto-tidy
/// algorithm), and the fingerprint is the content hash of the post-rectify
/// snapshot (resumed read-only, fixed by re-upload). The display label rides
/// along so a user rename survives resume (ADR-0037 display-layer only -- the
/// reference name is the stable identity SQL / the chain / the active pointer
/// use).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub reference_name: String,
    pub display_name: String,
    /// Absolute filesystem path -- the always-present fallback resolver
    /// (ADR-0036 §4). Older v1 recipes written before hybrid paths land here
    /// and resume treats them as absolute-only.
    pub source_path: String,
    /// Path relative to the `.duck` file's directory, when the source lives in
    /// that subtree (ADR-0036 §4). `None` when the source is outside the
    /// subtree or on a different volume (where a relative path is not
    /// expressible). Resume tries this first, then `source_path`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub rectify: RectifyProvenance,
    pub fingerprint: String,
}

/// One productive turn in the replayable chain (ADR-0034): the `result_N`
/// reference name (stable identity), the user-facing display label (so a
/// rename survives resume, ADR-0037), the verbatim SQL (re-executed on resume
/// to re-materialize `result_N`, ADR-0009), and the optional assumption note
/// (ADR-0009). The viz spec is deliberately absent -- viz is not persisted
/// (ADR-0036), so a reopened chart renders as a table until the user
/// re-requests one (ADR-0033).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProductiveTurn {
    pub reference_name: String,
    pub display_name: String,
    pub sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assumption: Option<String>,
}

/// The recipe's conversation timeline (ADR-0028/0039/0040): every turn AND
/// every source lifecycle event, always visible, in order. A trimmed mirror
/// of [`crate::model::ThreadEntry`] -- a Turn entry drops materialized
/// descriptor fields resume re-derives; a Source entry passes through
/// verbatim (ADR-0040 first-class timeline slot, never enters the LLM
/// window). Adjacently-tagged so a future reader narrows on `entry`
/// uniformly, mirroring the IPC `ThreadEntry` shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "entry", content = "data")]
pub enum RecipeEntry {
    Turn(RecipeTurn),
    Source(SourceLifecycleEvent),
}

/// One turn in the recipe timeline (ADR-0028): the verbatim question paired
/// with a trimmed outcome. Every turn is recorded regardless of outcome --
/// "no result" is itself a typed outcome, never a silent gap (ADR-0028
/// always-visible).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecipeTurn {
    pub question: String,
    pub outcome: RecipeOutcome,
}

/// A trimmed turn outcome (ADR-0028 four-way classification). The live
/// [`crate::model::TurnOutcome::Materialized`] carries the full dataset
/// descriptor (columns / sample / row-count / fingerprint) plus the viz spec;
/// the recipe form carries only the stable identity (reference name), the
/// display label, the verbatim SQL, and the assumption -- everything else is
/// rebuilt by eager replay (ADR-0034) or dropped because not persisted
/// (ADR-0036 viz / execution metadata).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum RecipeOutcome {
    /// Outcome A -- a result turn. Replayed on resume to re-materialize
    /// `result_N` (reusing the same number, ADR-0022).
    Materialized {
        reference_name: String,
        display_name: String,
        sql: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assumption: Option<String>,
    },
    /// Outcome B -- a textual turn (ADR-0017 refuse / ADR-0018 clarify).
    /// Statically rendered on resume; the disambiguation choice is already
    /// in the body, so the user is never re-asked (ADR-0034).
    Textual {
        text_kind: TextKind,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assumption: Option<String>,
    },
    /// Outcome C -- a failed turn (ADR-0028). Statically rendered; the reason
    /// is shown verbatim, the turn is NOT re-executed.
    Failed { reason: String },
    /// Outcome D -- a cancelled turn (ADR-0021/0028). Statically rendered.
    Cancelled,
}

/// The recipe (ADR-0034): the current working set as a portable text
/// document. Organized by current state, not as a historical ledger -- stale
/// results (cascade-failed after a source replace/remove) are NOT here; the
/// history holds only the still-valid turns plus every no-result turn and
/// source event (ADR-0040 always-visible display).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Recipe {
    /// Format version (ADR-0036). v1 today; opening refuses a higher version
    /// honestly so a newer-made file is never silently mis-parsed.
    pub format_version: u32,
    pub session_name: String,
    /// The currently-loaded source Datasets (ADR-0034 current source set):
    /// each is re-read on resume and its post-rectify fingerprint verified
    /// (ADR-0035/0042). A removed source is absent; a replaced one keeps the
    /// name with the new fingerprint.
    pub sources: Vec<SourceRef>,
    /// The full conversation timeline (ADR-0028/0039/0040): every turn +
    /// every source lifecycle event, always visible, pure-append. The
    /// productive replay chain is derived from this at resume time
    /// ([`Self::productive_chain`]).
    pub history: Vec<RecipeEntry>,
    /// The active-SOURCE pointer as a reference name (ADR-0035/0037): the
    /// source the user last focused on at the source layer, stable across
    /// renames. This is distinct from `Session::active()` -- the user's
    /// current focus, derived by `window::resolve_active` as the latest result
    /// if any, else the active source. Resume rebuilds the working set + turn
    /// timeline deterministically, so `resolve_active` reproduces the same
    /// focus without persisting it. The source pointer is persisted because it
    /// can diverge from "most-recently-registered source" once the user
    /// explicitly picks a continuation source after deleting the active one
    /// (issue #39, ADR-0035 no-silent-fallback); that choice must survive
    /// resume. `None` when the working set is empty (the last source was
    /// removed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
}

impl Recipe {
    /// The still-valid productive chain (ADR-0034): the Materialized turns in
    /// timeline order. This is what resume re-executes -- one SQL per entry,
    /// reusing the `result_N` numbering (ADR-0022). Stale results are already
    /// absent from the recipe history (filtered at write time), so every
    /// Materialized entry here is replayable.
    pub fn productive_chain(&self) -> Vec<ProductiveTurn> {
        self.history
            .iter()
            .filter_map(|entry| match entry {
                RecipeEntry::Turn(turn) => match &turn.outcome {
                    RecipeOutcome::Materialized {
                        reference_name,
                        display_name,
                        sql,
                        assumption,
                    } => Some(ProductiveTurn {
                        reference_name: reference_name.clone(),
                        display_name: display_name.clone(),
                        sql: sql.clone(),
                        assumption: assumption.clone(),
                    }),
                    _ => None,
                },
                RecipeEntry::Source(_) => None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SourceLifecycleEvent, SourceLifecycleKind};

    fn csv_source(name: &str, fp: &str) -> SourceRef {
        SourceRef {
            reference_name: name.to_string(),
            display_name: name.to_string(),
            source_path: format!("/data/{name}.csv"),
            relative_path: None,
            rectify: RectifyProvenance::NotApplicable,
            fingerprint: fp.to_string(),
        }
    }

    fn build_recipe() -> Recipe {
        // Two sources, one productive result turn, one textual no-result
        // turn, and an Added source event -- the minimal shape the tracer
        // bullet's black-box test drives.
        Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "分析 A".to_string(),
            sources: vec![csv_source("people", "fp-people")],
            history: vec![
                RecipeEntry::Source(SourceLifecycleEvent {
                    kind: SourceLifecycleKind::Added,
                    reference_name: "people".into(),
                    display_name: "people".into(),
                }),
                RecipeEntry::Turn(RecipeTurn {
                    question: "多少人".into(),
                    outcome: RecipeOutcome::Materialized {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: "SELECT COUNT(*) AS n FROM \"people\".data".into(),
                        assumption: None,
                    },
                }),
                RecipeEntry::Turn(RecipeTurn {
                    question: "哪种名字".into(),
                    outcome: RecipeOutcome::Textual {
                        text_kind: TextKind::Clarify,
                        body: "按姓还是名？".into(),
                        assumption: None,
                    },
                }),
            ],
            active: Some("result_1".into()),
        }
    }

    #[test]
    fn recipe_round_trips_through_json() {
        // The recipe survives a serialize -> deserialize cycle byte-for-byte
        // (equality), so the .duck file written on save reads back identically
        // on resume -- the foundation of the persistence contract.
        let recipe = build_recipe();
        let json = serde_json::to_string(&recipe).expect("serialize");
        let back: Recipe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, recipe);
    }

    #[test]
    fn recipe_format_version_is_one() {
        // ADR-0036: v1 carries format_version = 1. Pin the constant so the
        // open-path version check stays in sync with what save writes.
        assert_eq!(RECIPE_FORMAT_VERSION, 1);
        assert_eq!(build_recipe().format_version, 1);
    }

    #[test]
    fn productive_chain_lists_materialized_turns_in_order() {
        // ADR-0034: the replayable chain is the Materialized turns, in
        // timeline order. Source events and no-result turns are absent --
        // they are display-only, never re-executed (ADR-0034).
        let recipe = build_recipe();
        let chain = recipe.productive_chain();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].reference_name, "result_1");
        assert_eq!(
            chain[0].sql,
            "SELECT COUNT(*) AS n FROM \"people\".data"
        );
    }

    #[test]
    fn productive_chain_preserves_order_across_multiple_results() {
        // Two productive turns replay in timeline order so the second can
        // FROM the first's result_N (chained derivation, ADR-0003).
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "s".into(),
            sources: vec![csv_source("people", "fp")],
            history: vec![
                RecipeEntry::Turn(RecipeTurn {
                    question: "q1".into(),
                    outcome: RecipeOutcome::Materialized {
                        reference_name: "result_1".into(),
                        display_name: "result_1".into(),
                        sql: "SELECT 1".into(),
                        assumption: None,
                    },
                }),
                RecipeEntry::Turn(RecipeTurn {
                    question: "q2".into(),
                    outcome: RecipeOutcome::Materialized {
                        reference_name: "result_2".into(),
                        display_name: "result_2".into(),
                        sql: "SELECT * FROM \"result_1\"".into(),
                        assumption: None,
                    },
                }),
            ],
            active: Some("result_2".into()),
        };
        let chain = recipe.productive_chain();
        assert_eq!(
            chain
                .iter()
                .map(|t| t.reference_name.clone())
                .collect::<Vec<_>>(),
            vec!["result_1".to_string(), "result_2".to_string()]
        );
    }

    #[test]
    fn serialized_recipe_carries_no_secrets_or_materialized_data() {
        // ADR-0036 secrets-never + contents boundary: the .duck text must
        // never carry an API key, a materialized result's columns / sample /
        // row-count / fingerprint, or a viz spec. The recipe type prevents
        // these structurally (no such fields exist), but this test pins that
        // invariant at the serialization boundary -- a future field added to
        // ProductiveTurn / RecipeOutcome::Materialized must not leak these.
        let recipe = build_recipe();
        let json = serde_json::to_string(&recipe).expect("serialize");
        // Secret-like tokens that must never appear.
        assert!(!json.contains("api_key"), "no api_key field");
        assert!(!json.contains("sk-"), "no key-like token");
        // Materialized-data fields of a result_N descriptor -- resume re-
        // derives these, so they must not persist.
        assert!(!json.contains("columns"), "no columns field");
        assert!(!json.contains("sample"), "no sample field");
        assert!(!json.contains("row_count"), "no row_count field");
        // viz is not persisted (ADR-0036); only the assumption note is.
        assert!(!json.contains("viz"), "no viz field");
    }

    #[test]
    fn recipe_accepts_empty_working_set() {
        // ADR-0035: the last source can be removed to an empty working set,
        // and that state must persist + resume. Empty sources + None active +
        // empty history is a valid recipe.
        let recipe = Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: "空".into(),
            sources: Vec::new(),
            history: Vec::new(),
            active: None,
        };
        let json = serde_json::to_string(&recipe).expect("serialize");
        let back: Recipe = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, recipe);
    }
}
