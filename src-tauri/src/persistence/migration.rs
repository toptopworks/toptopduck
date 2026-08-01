//! Forward migration pipeline (ADR-0036 Decision 1): a `.duck` whose
//! `format_version` is BELOW the current app version steps through per-version
//! JSON transforms, each producing the next version's shape, until it reaches
//! the current version. The pipeline composes -- adding a transform extends it
//! without changes to the open path.
//!
//! (As of v2, ADR-0082 / issue #296.) The registry carries two transforms:
//! - `v0_to_v1` -- the synthetic demonstrator exercising BOTH migration kinds
//!   ADR-0036 names (v0 was never released): **add field with default** (a v0
//!   `SourceRef` missing `display_name` is filled from its `reference_name`)
//!   and **semantic remap** (a v0 `RecipeOutcome` discriminator `"outcome_kind"`
//!   is renamed to v1's `"kind"`).
//! - `v1_to_v2` -- the first real migration: adds the persisted execution trace
//!   (ADR-0078) to each Materialized turn's display part as a synthetic
//!   single-call `materialize` entry. The reconstructable part is unchanged
//!   (each productive SQL IS one promotion entry, ADR-0082), so resume replay
//!   semantics are identical before and after migration.
//!
//! The open path's honest refuse on a HIGHER version (ADR-0036) lives in
//! [`crate::persistence::io`]; this module owns the LOWER-version path.
//!
//! Transforms operate on [`serde_json::Value`] -- before typed deserialize --
//! because an older shape may not satisfy the current `Recipe` struct's
//! required fields and must be reshaped first.

use serde_json::Value;

use crate::persistence::recipe::RECIPE_FORMAT_VERSION;

/// Why a migration failed. `NoTransform` is an honest parse error: a version
/// sits between the file's and the current app's with no registered step, so
/// the chain is broken -- the file is externally owned input (ADR-0034), so
/// the engine never best-effort guesses a shape. `Field` names the missing or
/// ill-typed field a transform required.
///
/// (As of v2.) `NoTransform` is unreachable in production: v0 and v1 both have
/// registered steps to current. It exists as the contract guard for when v3
/// ships -- a forgotten `v2_to_v3` registration must surface as an honest
/// error, not a silent mis-migrate.
///
/// Crosses IPC serde-structured (issue #120): `#[serde(tag = "kind", content =
/// "data")]`, the adjacently-tagged shape the rest of the wire contract uses
/// (the same as [`crate::session_store::SessionError`]). `Field(String)` needs
/// the adjacent `content = "data"` slot -- an internally-tagged `#[serde(tag =
/// "kind")]` cannot carry a bare-string newtype variant. The hand-written
/// `Display` below stays Rust-log-only; it is NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum MigrationError {
    /// The migration chain has a gap at `from` (no transform registered for
    /// that source version). `supported` is the current app version.
    NoTransform { from: u32, supported: u32 },
    /// A transform expected a field that is missing or has the wrong type.
    Field(String),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::NoTransform { from, supported } => write!(
                f,
                "cannot migrate format_version={from} to current {supported}: \
                 migration chain has no step for that version"
            ),
            Self::Field(d) => write!(f, "migration failed: {d}"),
        }
    }
}
impl std::error::Error for MigrationError {}

/// Step `value` from `from_version` up to [`RECIPE_FORMAT_VERSION`], applying
/// each per-version transform in order and stamping `format_version` after
/// each step. Returns the v-current JSON shape, ready to deserialize into
/// `Recipe`. A `from_version >= RECIPE_FORMAT_VERSION` is a no-op (the caller
/// routes higher versions to honest-refuse before reaching here, but the
/// guard keeps the function self-contained).
pub fn migrate_to_current(value: Value, from_version: u32) -> Result<Value, MigrationError> {
    let mut current = value;
    let mut v = from_version;
    while v < RECIPE_FORMAT_VERSION {
        current = match v {
            0 => transforms::v0_to_v1(current)?,
            1 => transforms::v1_to_v2(current)?,
            2 => transforms::v2_to_v3(current)?,
            other => {
                return Err(MigrationError::NoTransform {
                    from: other,
                    supported: RECIPE_FORMAT_VERSION,
                });
            }
        };
        v += 1;
        // Stamp the stepped-to version. A non-object root cannot carry
        // `format_version` and is a structural error, not a panic -- the
        // `format_version` honest-parse guard in `read_duck` keeps the
        // production path on an object root, but this is a pub API so it
        // defends its own contract (ADR-0034 honest parse).
        let obj = current.as_object_mut().ok_or_else(|| {
            MigrationError::Field(
                "recipe root is not an object; cannot stamp format_version".into(),
            )
        })?;
        obj.insert("format_version".to_string(), Value::from(v));
    }
    Ok(current)
}

mod transforms {
    use super::*;

    /// v0 -> v1 demonstrator (ADR-0036). Two migration kinds in one transform:
    ///
    /// 1. **add field with default** -- fill any `sources[i]` missing
    ///    `display_name` with its `reference_name`. v1 requires `display_name`
    ///    on every source; a synthetic v0 source omits it (mimicking an old
    ///    recording whose label matched the reference name).
    /// 2. **semantic remap** -- rename each Turn entry's outcome
    ///    discriminator key from v0's `"outcome_kind"` to v1's `"kind"`.
    ///    Source-lifecycle entries have no `outcome` field and pass through.
    ///
    /// Stamps no version itself -- [`migrate_to_current`] stamps after each
    /// step so the version always reflects the shape.
    pub fn v0_to_v1(mut value: Value) -> Result<Value, MigrationError> {
        // (1) add-field-with-default on sources.
        if let Some(sources) = value.get_mut("sources").and_then(|s| s.as_array_mut()) {
            for src in sources.iter_mut() {
                let obj = src
                    .as_object_mut()
                    .ok_or_else(|| MigrationError::Field("source entry is not an object".into()))?;
                if !obj.contains_key("display_name") {
                    let reference_name = obj
                        .get("reference_name")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| {
                            MigrationError::Field(
                                "source missing reference_name; cannot fill default display_name"
                                    .into(),
                            )
                        })?;
                    obj.insert("display_name".to_string(), Value::from(reference_name));
                }
            }
        }

        // (2) semantic-remap on the outcome discriminator across history. The
        // per-entry remap lives in its own helper so this loop stays a flat map
        // (early-return inside the helper beats a 5-deep if-let chain -- the
        // >4-level nesting guideline from coding-style.md).
        if let Some(history) = value.get_mut("history").and_then(|h| h.as_array_mut()) {
            for entry in history.iter_mut() {
                rename_outcome_kind_in_place(entry);
            }
        }

        Ok(value)
    }

    /// Rename a Turn entry's legacy outcome discriminator `outcome_kind` ->
    /// `kind` in place (ADR-0036 semantic remap). No-ops on entries whose
    /// outcome is absent (Source-lifecycle entries carry no `outcome` field)
    /// or whose outcome is not an object -- per-entry defensive so the caller
    /// loop above stays a flat map instead of a 5-deep if-let chain.
    fn rename_outcome_kind_in_place(entry: &mut Value) {
        let Some(outcome) = entry.get_mut("data").and_then(|d| d.get_mut("outcome")) else {
            return;
        };
        let Some(obj) = outcome.as_object_mut() else {
            return;
        };
        if let Some(tag) = obj.remove("outcome_kind") {
            // Non-overwriting: if a v0 entry already carries a `kind` key (a
            // partial v1 write or a hand edit), keep the existing `kind` and
            // drop the legacy `outcome_kind` value. v0 was never released so
            // this is defensive only -- a later invalid `kind` surfaces as
            // an honest deserialize error, so the legacy tag never silently
            // wins.
            obj.entry("kind").or_insert(tag);
        }
    }

    /// v1 -> v2 (ADR-0082, issue #296): add the persisted execution trace
    /// (ADR-0078) to each Turn entry's display part. A v1 Materialized turn ran
    /// exactly one productive SQL under the single-SQL contract, so its
    /// trajectory is one `materialize` call -- synthesized from the verbatim
    /// SQL via the shared [`crate::persistence::recipe::synthetic_materialize_trace`] helper
    /// (the same helper [`crate::session::Session::build_recipe`] uses for a
    /// fresh TurnRunner-era turn), so a migrated v1 session shows the same
    /// one-step trajectory it produced live. Every other turn (Textual /
    /// Failed / Cancelled / Source event) carries no tool-call trajectory and
    /// gets no trace field -- `#[serde(default)]` on [`RecipeTurn::trace`]
    /// deserializes the absent field as empty.
    ///
    /// The reconstructable part (the Materialized outcome's SQL + result_N) is
    /// unchanged: each productive SQL IS one promotion entry (ADR-0082), so
    /// resume replay semantics are identical before and after migration. No
    /// field is renamed or removed -- the transform only ADDS `trace`.
    ///
    /// Stamps no version itself -- [`migrate_to_current`] stamps after each
    /// step so the version always reflects the shape.
    pub(super) fn v1_to_v2(mut value: Value) -> Result<Value, MigrationError> {
        if let Some(history) = value.get_mut("history").and_then(|h| h.as_array_mut()) {
            for entry in history.iter_mut() {
                add_synthetic_trace_in_place(entry);
            }
        }
        Ok(value)
    }

    /// Add the synthetic single-call trace to one Turn entry's `data`, in place
    /// (ADR-0082). No-op for Source entries (no `outcome`), for non-Materialized
    /// outcomes (no tool trajectory), and for a Materialized outcome missing its
    /// `sql` (a corrupt shape the typed deserialize will reject downstream --
    /// the transform stays side-effect-free rather than guessing). Per-entry
    /// defensive so the caller loop is a flat map.
    fn add_synthetic_trace_in_place(entry: &mut Value) {
        // A Turn entry's outcome lives at `data.outcome` (the adjacently-tagged
        // RecipeEntry shape `{entry, data}`). Source entries have no outcome and
        // a non-object `data` cannot carry one -- both skip.
        let Some(data_obj) = entry.get_mut("data").and_then(|d| d.as_object_mut()) else {
            return;
        };
        // Take the outcome node once; both the kind discriminator and the
        // Materialized payload's `sql` live under it. A missing outcome is a
        // Source entry (or a corrupt Turn) -- skip either way.
        let Some(outcome) = data_obj.get("outcome") else {
            return;
        };
        let Some(kind) = outcome.get("kind").and_then(Value::as_str) else {
            return;
        };
        // Only Materialized turns ran a productive SQL -> get a synthetic trace.
        if kind != "Materialized" {
            return;
        }
        let Some(sql) = outcome
            .get("data")
            .and_then(|d| d.get("sql"))
            .and_then(Value::as_str)
        else {
            // A Materialized outcome missing `sql` is corrupt; the typed
            // deserialize rejects it downstream. Stay side-effect-free (no
            // guess), but log the skip so a corrupt .duck is diagnosable
            // rather than a silent no-trace.
            log::warn!("v1->v2 migration: Materialized turn missing sql; no synthetic trace");
            return;
        };
        let trace = crate::persistence::recipe::synthetic_materialize_trace(sql);
        // Serialize the typed trace into the JSON the v2 RecipeTurn deserializes
        // back from. Plain serializable struct -- a failure is a logic bug, not
        // a parse fault; no-op rather than panic on external input. The
        // debug_assert surfaces a future non-serializable field under test
        // builds instead of silently dropping every migrated turn's trace.
        let Ok(trace_value) = serde_json::to_value(&trace) else {
            debug_assert!(false, "RecipeTraceEntry must serialize");
            return;
        };
        data_obj.insert("trace".to_string(), trace_value);
    }

    /// v2 -> v3 (ADR-0084): make the result turn's promotion chain explicit. A
    /// v2 Materialized turn carries a single flattened result (reference_name /
    /// display_name / sql / stale at the outcome-data top level); v3 wraps
    /// those into a one-element `promotions` list so a result turn carries an
    /// ordered chain (each promotion with its own stale anchor). The turn-level
    /// `assumption` stays at the outcome-data level. Every other turn (Textual
    /// / Failed / Cancelled / Source event) is untouched. Lossless: the single
    /// v2 result becomes the chain's sole (and primary) promotion, so resume
    /// replay re-materializes the same result_N.
    ///
    /// Stamps no version itself -- [`migrate_to_current`] stamps after each
    /// step so the version always reflects the shape.
    pub(super) fn v2_to_v3(mut value: Value) -> Result<Value, MigrationError> {
        if let Some(history) = value.get_mut("history").and_then(|h| h.as_array_mut()) {
            for entry in history.iter_mut() {
                wrap_materialized_promotions_in_place(entry);
            }
        }
        Ok(value)
    }

    /// Wrap one v2 Materialized turn's flat result fields into a one-element
    /// `promotions` list, in place (ADR-0084). No-op for Source entries (no
    /// `outcome`) and for non-Materialized outcomes (no promotion). Defensive
    /// on a malformed shape: a missing required field is left absent and
    /// surfaces as an honest typed-deserialize error downstream rather than a
    /// guess here. Per-entry so the caller loop is a flat map.
    fn wrap_materialized_promotions_in_place(entry: &mut Value) {
        // A Turn entry's outcome lives at `data.outcome` (the adjacently-tagged
        // RecipeEntry shape `{entry, data}`). Source entries have no outcome.
        let Some(outcome) = entry.get_mut("data").and_then(|d| d.get_mut("outcome")) else {
            return;
        };
        let Some(kind) = outcome.get("kind").and_then(Value::as_str) else {
            return;
        };
        if kind != "Materialized" {
            return;
        }
        let Some(data) = outcome.get_mut("data").and_then(|d| d.as_object_mut()) else {
            return;
        };
        // Lift the flat result fields out of the outcome data; whatever remains
        // (assumption) stays at the turn level. A v2 Materialized turn that ran
        // a productive result carries reference_name + display_name + sql;
        // `stale` is optional (live turns omit it). Each present field rides
        // into the single promotion; an absent required field deserializes to
        // an honest error downstream.
        let mut promotion = serde_json::Map::new();
        for key in ["reference_name", "display_name", "sql", "stale"] {
            if let Some(v) = data.remove(key) {
                promotion.insert(key.to_string(), v);
            }
        }
        data.insert(
            "promotions".to_string(),
            Value::Array(vec![Value::Object(promotion)]),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic v0 source missing `display_name`.
    fn v0_source(reference_name: &str, fingerprint: &str) -> Value {
        serde_json::json!({
            "reference_name": reference_name,
            "source_path": format!("/data/{reference_name}.csv"),
            "fingerprint": fingerprint,
        })
    }

    /// Build a synthetic v0 Turn entry whose outcome carries the legacy
    /// `outcome_kind` discriminator.
    fn v0_turn(question: &str, outcome_kind: &str, outcome_data: Value) -> Value {
        serde_json::json!({
            "entry": "Turn",
            "data": {
                "question": question,
                "outcome": {
                    "outcome_kind": outcome_kind,
                    "data": outcome_data,
                },
            },
        })
    }

    #[test]
    fn v0_to_v1_fills_default_display_name_when_missing() {
        // ADR-0036 "add field with default": a v0 source without display_name
        // gets filled from its reference_name, so the v1 struct (which
        // requires the field) deserializes cleanly afterward.
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "v0 分析",
            "sources": [v0_source("people", "fp-people")],
            "history": [],
            "active": null,
        });
        let v1 = transforms::v0_to_v1(v0).expect("migrate");
        let src = &v1["sources"][0];
        assert_eq!(
            src["display_name"], "people",
            "display_name filled from reference_name"
        );
        assert_eq!(src["reference_name"], "people", "reference_name preserved");
    }

    #[test]
    fn v0_to_v1_keeps_existing_display_name_unchanged() {
        // A real v0 source that already carried a display_name is left as-is
        // -- the transform is a default-fill, never an overwrite.
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "x",
            "sources": [{
                "reference_name": "people",
                "display_name": "员工表",
                "source_path": "/data/people.csv",
                "fingerprint": "fp",
            }],
            "history": [],
            "active": null,
        });
        let v1 = transforms::v0_to_v1(v0).expect("migrate");
        assert_eq!(
            v1["sources"][0]["display_name"], "员工表",
            "existing label preserved"
        );
    }

    #[test]
    fn v0_to_v1_renames_outcome_kind_to_kind() {
        // ADR-0036 "semantic remap": the v0 outcome discriminator key
        // "outcome_kind" becomes v1's "kind", so the v1 RecipeOutcome
        // (#[serde(tag = "kind")]) deserializes the same payload.
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "x",
            "sources": [],
            "history": [v0_turn(
                "多少人",
                "Materialized",
                serde_json::json!({
                    "reference_name": "result_1",
                    "display_name": "result_1",
                    "sql": "SELECT COUNT(*) AS n FROM \"people\".data",
                }),
            )],
            "active": "result_1",
        });
        let v1 = transforms::v0_to_v1(v0).expect("migrate");
        let outcome = &v1["history"][0]["data"]["outcome"];
        assert_eq!(
            outcome["kind"], "Materialized",
            "discriminator renamed to kind"
        );
        assert!(
            outcome.get("outcome_kind").is_none(),
            "legacy outcome_kind key removed"
        );
        assert_eq!(
            outcome["data"]["sql"], "SELECT COUNT(*) AS n FROM \"people\".data",
            "outcome payload preserved",
        );
    }

    #[test]
    fn v0_to_v1_passes_source_lifecycle_entries_through() {
        // A Source-lifecycle entry has no outcome field; the remap loop must
        // not choke on it (defensive: the data.outcome path is absent).
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "x",
            "sources": [],
            "history": [{
                "entry": "Source",
                "data": {
                    "kind": "Added",
                    "reference_name": "people",
                    "display_name": "people",
                },
            }],
            "active": null,
        });
        let v1 = transforms::v0_to_v1(v0).expect("migrate");
        assert_eq!(
            v1["history"][0]["entry"], "Source",
            "source entry preserved"
        );
    }

    #[test]
    fn migrate_to_current_stamps_version_after_stepping() {
        // The pipeline stamps format_version after each step, so a v0 input
        // comes out carrying v1's version -- whatever the source file had.
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "x",
            "sources": [v0_source("people", "fp")],
            "history": [],
            "active": null,
        });
        let v1 = migrate_to_current(v0, 0).expect("migrate");
        assert_eq!(
            v1["format_version"], RECIPE_FORMAT_VERSION,
            "stamped to current after migration",
        );
    }

    #[test]
    fn migrate_to_current_is_a_noop_when_already_at_current() {
        // from_version == current never enters the loop; the value returns
        // unchanged (including its original format_version).
        let v1 = serde_json::json!({
            "format_version": RECIPE_FORMAT_VERSION,
            "session_name": "x",
            "sources": [],
            "history": [],
            "active": null,
        });
        let back = migrate_to_current(v1.clone(), RECIPE_FORMAT_VERSION).expect("migrate");
        assert_eq!(back, v1, "no transform applied at current version");
    }

    #[test]
    fn migrate_to_current_round_trips_through_recipe_deserialize() {
        // End-to-end of the migration + typed deserialize: a synthetic v0
        // fixture migrates to a shape the current Recipe struct accepts.
        use crate::persistence::recipe::Recipe;
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "v0 分析",
            "sources": [v0_source("people", "fp-people")],
            "history": [v0_turn(
                "多少人",
                "Materialized",
                serde_json::json!({
                    "reference_name": "result_1",
                    "display_name": "result_1",
                    "sql": "SELECT COUNT(*) AS n FROM \"people\".data",
                }),
            )],
            "active": "result_1",
        });
        let v1 = migrate_to_current(v0, 0).expect("migrate");
        let recipe: Recipe =
            serde_json::from_value(v1).expect("migrated shape deserializes as v1 Recipe");
        assert_eq!(recipe.format_version(), RECIPE_FORMAT_VERSION);
        assert_eq!(recipe.sources[0].display_name, "people");
        assert_eq!(recipe.sources[0].reference_name, "people");
        assert!(matches!(
            recipe.history[0],
            crate::persistence::recipe::RecipeEntry::Turn(_)
        ));
    }

    #[test]
    fn v0_to_v1_rejects_a_source_that_is_not_an_object() {
        // ADR-0034 honest parse: a v0 source that is not an object (here a
        // bare string) surfaces as `MigrationError::Field`, never a panic or
        // silent pass-through. External input -- the engine never
        // best-effort guesses a shape.
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "x",
            "sources": ["not-an-object"],
            "history": [],
            "active": null,
        });
        let err = transforms::v0_to_v1(v0).unwrap_err();
        assert!(
            matches!(&err, MigrationError::Field(msg) if msg.contains("not an object")),
            "expected Field error naming the non-object source, got {err:?}",
        );
    }

    #[test]
    fn v0_to_v1_rejects_a_source_missing_reference_name() {
        // ADR-0036 "add field with default": a v0 source missing both
        // display_name AND reference_name cannot be filled -- the transform
        // refuses with `MigrationError::Field` rather than synthesizing an
        // empty label.
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "x",
            "sources": [{
                "source_path": "/data/anon.csv",
                "fingerprint": "fp",
            }],
            "history": [],
            "active": null,
        });
        let err = transforms::v0_to_v1(v0).unwrap_err();
        assert!(
            matches!(&err, MigrationError::Field(msg) if msg.contains("reference_name")),
            "expected Field error naming the missing reference_name, got {err:?}",
        );
    }

    #[test]
    fn migrate_to_current_refuses_a_non_object_root_instead_of_panicking() {
        // The pipeline stamps `format_version` after each step; a non-object
        // root (e.g. a bare array) cannot carry the field. The pub API
        // returns a typed `MigrationError::Field` instead of indexing into
        // the `Value` and panicking (ADR-0034 honest parse).
        let arr = serde_json::json!([1, 2, 3]);
        let err = migrate_to_current(arr, 0).unwrap_err();
        // Lock the typed variant (issue #120): the pub-API contract is
        // "returns Field". The Display wording is Rust-log-only; the
        // transform-internal tests above still assert it.
        assert!(
            matches!(&err, MigrationError::Field(_)),
            "expected Field error for the non-object root, got {err:?}",
        );
    }

    // --- v1 -> v2 (ADR-0082, issue #296) --------------------------------------

    /// Build a synthetic v1 Turn entry -- the post-v0->v1 shape: outcome uses
    /// v1's `kind` discriminator, and the Materialized payload carries the full
    /// reconstructable fields (reference_name + display_name + sql).
    fn v1_materialized_turn(question: &str, reference_name: &str, sql: &str) -> Value {
        serde_json::json!({
            "entry": "Turn",
            "data": {
                "question": question,
                "outcome": {
                    "kind": "Materialized",
                    "data": {
                        "reference_name": reference_name,
                        "display_name": reference_name,
                        "sql": sql,
                    },
                },
            },
        })
    }

    /// Build a synthetic v1 Textual turn (no tool trajectory -> no trace after
    /// migration).
    fn v1_textual_turn(question: &str) -> Value {
        serde_json::json!({
            "entry": "Turn",
            "data": {
                "question": question,
                "outcome": {
                    "kind": "Textual",
                    "data": {
                        "text_kind": "Clarify",
                        "body": "按姓还是名？",
                        "assumption": null,
                    },
                },
            },
        })
    }

    #[test]
    fn v1_to_v2_adds_a_synthetic_single_call_trace_to_materialized_turns() {
        // ADR-0082 (issue #296): a v1 Materialized turn ran one productive SQL,
        // so the migration synthesizes a single-call `materialize` trace whose
        // summary is the verbatim SQL. The trace lands at `data.trace` -- the
        // v2 display-part slot ADR-0078 adds.
        let v1 = serde_json::json!({
            "format_version": 1,
            "session_name": "v1 分析",
            "sources": [{
                "reference_name": "people",
                "display_name": "people",
                "source_path": "/data/people.csv",
                "fingerprint": "fp",
            }],
            "history": [v1_materialized_turn(
                "多少人",
                "result_1",
                "SELECT COUNT(*) AS n FROM \"people\".data",
            )],
            "active": "people",
        });
        let v2 = transforms::v1_to_v2(v1).expect("migrate");
        let trace = &v2["history"][0]["data"]["trace"];
        assert_eq!(trace.as_array().map(|a| a.len()), Some(1), "one call");
        let entry = &trace[0];
        assert_eq!(entry["name"], "materialize");
        assert_eq!(entry["operation_kind"], "write");
        assert_eq!(entry["success"], true);
        assert_eq!(
            entry["summary"], "SELECT COUNT(*) AS n FROM \"people\".data",
            "summary is the verbatim SQL",
        );
    }

    #[test]
    fn v1_to_v2_leaves_non_materialized_turns_without_a_trace() {
        // ADR-0082: only Materialized turns ran a productive SQL. A Textual
        // turn (and a Source event) carries no tool trajectory, so the
        // migration adds no `trace` field -- `#[serde(default)]` deserializes
        // the absent field as an empty trace.
        let v1 = serde_json::json!({
            "format_version": 1,
            "session_name": "x",
            "sources": [],
            "history": [
                v1_textual_turn("哪种名字"),
                {
                    "entry": "Source",
                    "data": {
                        "kind": "Added",
                        "reference_name": "people",
                        "display_name": "people",
                    },
                },
            ],
            "active": null,
        });
        let v2 = transforms::v1_to_v2(v1).expect("migrate");
        assert!(
            v2["history"][0]["data"].get("trace").is_none(),
            "textual turn gets no trace",
        );
        assert!(
            v2["history"][1]["data"].get("trace").is_none(),
            "source event gets no trace",
        );
    }

    #[test]
    fn v1_to_v2_preserves_the_reconstructable_part_unchanged() {
        // AC #2 (issue #296): the migration is lossless for the reconstructable
        // part -- reference_name / display_name / sql / outcome kind are
        // unchanged, so resume replay produces the same working set. Only the
        // display-part `trace` is added.
        let v1 = serde_json::json!({
            "format_version": 1,
            "session_name": "x",
            "sources": [{
                "reference_name": "people",
                "display_name": "people",
                "source_path": "/data/people.csv",
                "fingerprint": "fp",
            }],
            "history": [v1_materialized_turn("q", "result_1", "SELECT 1")],
            "active": "people",
        });
        let v2 = transforms::v1_to_v2(v1.clone()).expect("migrate");
        let outcome = &v2["history"][0]["data"]["outcome"];
        assert_eq!(outcome["kind"], "Materialized");
        assert_eq!(outcome["data"]["reference_name"], "result_1");
        assert_eq!(outcome["data"]["display_name"], "result_1");
        assert_eq!(outcome["data"]["sql"], "SELECT 1");
        // The reconstructable fields are byte-identical to the v1 input -- the
        // transform only ADDS `trace`, never mutates the outcome.
        assert_eq!(
            v2["history"][0]["data"]["outcome"],
            v1["history"][0]["data"]["outcome"],
        );
    }

    #[test]
    fn migrate_to_current_from_v1_round_trips_through_recipe_deserialize() {
        // End-to-end: a synthetic v1 fixture migrates to v2 and deserializes
        // as the current Recipe. The Materialized turn carries the synthesized
        // trace (one materialize call); resume replay semantics are unchanged
        // because the reconstructable fields are untouched.
        use crate::persistence::recipe::Recipe;
        let v1 = serde_json::json!({
            "format_version": 1,
            "session_name": "v1 分析",
            "sources": [{
                "reference_name": "people",
                "display_name": "people",
                "source_path": "/data/people.csv",
                "fingerprint": "fp",
            }],
            "history": [v1_materialized_turn("多少人", "result_1", "SELECT 1")],
            "active": "people",
        });
        let v2 = migrate_to_current(v1, 1).expect("migrate");
        let recipe: Recipe =
            serde_json::from_value(v2).expect("migrated shape deserializes as v2 Recipe");
        assert_eq!(recipe.format_version(), RECIPE_FORMAT_VERSION);
        use crate::persistence::recipe::RecipeEntry;
        let turn = match &recipe.history[0] {
            RecipeEntry::Turn(t) => t,
            other => panic!("expected Turn, got {other:?}"),
        };
        assert_eq!(
            turn.trace.len(),
            1,
            "synthesized trace survives deserialize"
        );
        assert_eq!(turn.trace[0].name, "materialize");
        // Replay chain is unchanged -- the promotion entry still carries the
        // same SQL + reference, so resume re-materializes identically.
        let chain = recipe.productive_chain();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].reference_name, "result_1");
        assert_eq!(chain[0].sql, "SELECT 1");
    }

    /// Build a synthetic v1 Failed turn (issue #125 TurnFailure shape: adjacently
    /// tagged, `Execute` variant carrying a technical detail). No tool trajectory
    /// -> no trace after migration.
    fn v1_failed_turn(question: &str, detail: &str) -> Value {
        serde_json::json!({
            "entry": "Turn",
            "data": {
                "question": question,
                "outcome": {
                    "kind": "Failed",
                    "data": {
                        "kind": "Execute",
                        "data": {"detail": detail},
                    },
                },
            },
        })
    }

    /// Build a synthetic v1 Cancelled turn (ADR-0021/0028). Adjacently-tagged
    /// unit variant carries no `data` slot; no tool trajectory -> no trace.
    fn v1_cancelled_turn(question: &str) -> Value {
        serde_json::json!({
            "entry": "Turn",
            "data": {
                "question": question,
                "outcome": {"kind": "Cancelled"},
            },
        })
    }

    #[test]
    fn v1_to_v2_leaves_failed_and_cancelled_turns_without_a_trace() {
        // ADR-0082: only Materialized turns ran a productive SQL. Failed and
        // Cancelled outcomes carry no tool trajectory, so the migration adds no
        // `trace` field -- the transform's `kind != "Materialized"` early-exit
        // covers them. Pin both branches so a future widening (e.g. giving
        // Failed an error trace) cannot silently change the migration's
        // lossless contract.
        let v1 = serde_json::json!({
            "format_version": 1,
            "session_name": "x",
            "sources": [],
            "history": [
                v1_failed_turn("坏 SQL", "relation not found"),
                v1_cancelled_turn("算了"),
            ],
            "active": null,
        });
        let v2 = transforms::v1_to_v2(v1).expect("migrate");
        assert!(
            v2["history"][0]["data"].get("trace").is_none(),
            "failed turn gets no trace",
        );
        assert!(
            v2["history"][1]["data"].get("trace").is_none(),
            "cancelled turn gets no trace",
        );
    }

    #[test]
    fn v1_to_v2_adds_a_trace_to_a_stale_materialized_turn_too() {
        // ADR-0082 + ADR-0041: a stale (cascade-invalidated, dead) Materialized
        // turn still RAN one productive SQL under the v1 single-SQL contract
        // before it was invalidated, and it remains in history for display
        // (ADR-0041 point 2). The migration keys only on `kind ==
        // "Materialized"` (not on `stale`), so a stale turn gains the same
        // synthetic single-call trace a live one does -- the UI shows the
        // trajectory the turn produced before invalidation. Pin this so the
        // product decision (stale turns keep their trace) survives a future
        // refactor that might gate on `stale`.
        let v1 = serde_json::json!({
            "format_version": 1,
            "session_name": "x",
            "sources": [{
                "reference_name": "people",
                "display_name": "people",
                "source_path": "/data/people.csv",
                "fingerprint": "fp",
            }],
            "history": [{
                "entry": "Turn",
                "data": {
                    "question": "旧问题",
                    "outcome": {
                        "kind": "Materialized",
                        "data": {
                            "reference_name": "result_1",
                            "display_name": "result_1",
                            "sql": "SELECT 1",
                            "stale": {
                                "reference_name": "people",
                                "display_name": "people",
                                "reason": "Replaced",
                            },
                        },
                    },
                },
            }],
            "active": "people",
        });
        let v2 = transforms::v1_to_v2(v1).expect("migrate");
        let trace = &v2["history"][0]["data"]["trace"];
        assert_eq!(
            trace.as_array().map(|a| a.len()),
            Some(1),
            "stale turn keeps its synthetic trace",
        );
        assert_eq!(trace[0]["name"], "materialize");
        assert_eq!(trace[0]["summary"], "SELECT 1");
        // The stale anchor survives untouched (lossless reconstructable part).
        assert_eq!(
            v2["history"][0]["data"]["outcome"]["data"]["stale"]["reason"],
            "Replaced",
        );
    }

    // --- v2 -> v3 (ADR-0084) --------------------------------------------------

    /// Build a synthetic v2 Materialized turn: the v1 adjacently-tagged outcome
    /// plus the v2 synthetic trace, with the reconstructable result fields
    /// still FLAT at the outcome-data level (the pre-chain shape v3 wraps).
    fn v2_materialized_turn(question: &str, reference_name: &str, sql: &str) -> Value {
        serde_json::json!({
            "entry": "Turn",
            "data": {
                "question": question,
                "outcome": {
                    "kind": "Materialized",
                    "data": {
                        "reference_name": reference_name,
                        "display_name": reference_name,
                        "sql": sql,
                        "assumption": "把 id 当作主键",
                    },
                },
                "trace": [{
                    "name": "materialize",
                    "operation_kind": "write",
                    "success": true,
                    "summary": sql,
                    "result_excerpt": "",
                }],
            },
        })
    }

    #[test]
    fn v2_to_v3_wraps_flat_result_fields_into_a_one_element_promotion_chain() {
        // ADR-0084: v2's flat result fields (reference_name / display_name /
        // sql) move INTO a one-element `promotions` chain. The turn-level
        // assumption stays at the outcome-data level and the v2 trace is
        // untouched. Lossless: the single v2 result becomes the chain's sole
        // (and primary) promotion.
        let v2 = serde_json::json!({
            "format_version": 2,
            "session_name": "v2 分析",
            "sources": [],
            "history": [
                v2_materialized_turn(
                    "多少人",
                    "result_1",
                    "SELECT COUNT(*) AS n FROM \"people\".data",
                ),
                v1_textual_turn("哪种名字"),
            ],
            "active": null,
        });
        let v3 = transforms::v2_to_v3(v2.clone()).expect("migrate");
        let data = &v3["history"][0]["data"]["outcome"]["data"];
        let promotions = data["promotions"]
            .as_array()
            .expect("promotions array present");
        assert_eq!(
            promotions.len(),
            1,
            "the single v2 result wraps into one promotion"
        );
        assert_eq!(promotions[0]["reference_name"], "result_1");
        assert_eq!(promotions[0]["display_name"], "result_1");
        assert_eq!(
            promotions[0]["sql"],
            "SELECT COUNT(*) AS n FROM \"people\".data"
        );
        // The flat fields are LIFTED out of the outcome data, not duplicated.
        assert!(data.get("reference_name").is_none());
        assert!(data.get("display_name").is_none());
        assert!(data.get("sql").is_none());
        // The turn-level assumption stays at the outcome-data level.
        assert_eq!(data["assumption"], "把 id 当作主键");
        // The v2 trace survives the re-wrap untouched.
        assert_eq!(v3["history"][0]["data"]["trace"][0]["name"], "materialize");
        // A non-Materialized turn carries no promotion and is untouched.
        assert_eq!(v3["history"][1], v2["history"][1], "textual turn unchanged");
    }

    #[test]
    fn v2_to_v3_moves_a_stale_anchor_into_the_promotion() {
        // ADR-0084 + ADR-0041: the stale anchor is per-result, so it rides
        // into the promotion alongside its reference / sql -- the dead turn
        // stays in history (point 2) and the v3 shape keeps the anchor where
        // productive_chain's per-promotion filter reads it.
        let v2 = serde_json::json!({
            "format_version": 2,
            "session_name": "x",
            "sources": [],
            "history": [{
                "entry": "Turn",
                "data": {
                    "question": "旧问题",
                    "outcome": {
                        "kind": "Materialized",
                        "data": {
                            "reference_name": "result_1",
                            "display_name": "result_1",
                            "sql": "SELECT 1",
                            "stale": {
                                "reference_name": "people",
                                "display_name": "people",
                                "reason": "Replaced",
                            },
                        },
                    },
                },
            }],
            "active": null,
        });
        let v3 = transforms::v2_to_v3(v2).expect("migrate");
        let data = &v3["history"][0]["data"]["outcome"]["data"];
        assert_eq!(data["promotions"][0]["stale"]["reason"], "Replaced");
        assert!(
            data.get("stale").is_none(),
            "the anchor is moved into the promotion, not duplicated",
        );
    }

    #[test]
    fn migrate_to_current_from_v2_round_trips_through_recipe_deserialize() {
        // End-to-end: a synthetic v2 fixture migrates to the current version
        // and deserializes as a v3 Recipe. The single v2 result becomes a
        // one-element promotion chain; the replayable chain re-materializes
        // the same result_N with the same SQL, and the turn-level assumption
        // rides the primary (chain tail) promotion.
        use crate::persistence::recipe::{Recipe, RecipeEntry};
        let v2 = serde_json::json!({
            "format_version": 2,
            "session_name": "v2 分析",
            "sources": [{
                "reference_name": "people",
                "display_name": "people",
                "source_path": "/data/people.csv",
                "fingerprint": "fp",
            }],
            "history": [v2_materialized_turn("多少人", "result_1", "SELECT 1")],
            "active": "people",
        });
        let v3 = migrate_to_current(v2, 2).expect("migrate");
        let recipe: Recipe =
            serde_json::from_value(v3).expect("migrated shape deserializes as the current Recipe");
        assert_eq!(recipe.format_version(), RECIPE_FORMAT_VERSION);
        match &recipe.history[0] {
            RecipeEntry::Turn(t) => assert_eq!(
                t.trace.len(),
                1,
                "the v2 synthetic trace survives the v2->v3 step"
            ),
            other => panic!("expected Turn, got {other:?}"),
        }
        let chain = recipe.productive_chain();
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].reference_name, "result_1");
        assert_eq!(chain[0].sql, "SELECT 1");
        assert_eq!(
            chain[0].assumption.as_deref(),
            Some("把 id 当作主键"),
            "the turn-level assumption rides the primary promotion on replay",
        );
    }
}
