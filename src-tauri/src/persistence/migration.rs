//! Forward migration pipeline (ADR-0036 Decision 1): a `.duck` whose
//! `format_version` is BELOW the current app version steps through per-version
//! JSON transforms, each producing the next version's shape, until it reaches
//! the current version. The pipeline composes -- when v2 ships, adding a
//! `v1_to_v2` transform extends it without changes to the open path.
//!
//! v1 is the only released version, so the registry carries a single
//! demonstrator `v0_to_v1` transform exercising BOTH migration kinds
//! ADR-0036 names:
//! - **add field with default**: a v0 `SourceRef` missing `display_name` is
//!   filled from its `reference_name`;
//! - **semantic remap**: a v0 `RecipeOutcome` discriminator key
//!   `"outcome_kind"` is renamed to v1's `"kind"`.
//!
//! v0 was never released -- it is a synthetic fixture shape that exists only
//! so the migration machinery is built + tested today, not discovered missing
//! when a real future version needs it (ADR-0036 Why 1: buy out the
//! hard-to-reverse ambiguity early). The open path's honest refuse on a
//! HIGHER version (ADR-0036) lives in [`crate::persistence::io`]; this module
//! owns the LOWER-version path.
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
#[derive(Debug)]
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
                "无法迁移 format_version={from} 至当前 {supported}：迁移链缺失该版本步进"
            ),
            Self::Field(d) => write!(f, "迁移失败：{d}"),
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
            // Future: 1 => transforms::v1_to_v2(current)?,
            other => {
                return Err(MigrationError::NoTransform {
                    from: other,
                    supported: RECIPE_FORMAT_VERSION,
                });
            }
        };
        v += 1;
        current["format_version"] = Value::from(v);
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
                    .ok_or_else(|| MigrationError::Field("源条目不是对象".into()))?;
                if !obj.contains_key("display_name") {
                    let reference_name = obj
                        .get("reference_name")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| {
                            MigrationError::Field(
                                "源缺少 reference_name，无法填默认 display_name".into(),
                            )
                        })?;
                    obj.insert("display_name".to_string(), Value::from(reference_name));
                }
            }
        }

        // (2) semantic-remap on the outcome discriminator across history.
        if let Some(history) = value.get_mut("history").and_then(|h| h.as_array_mut()) {
            for entry in history.iter_mut() {
                if let Some(outcome) = entry.get_mut("data").and_then(|d| d.get_mut("outcome")) {
                    if let Some(obj) = outcome.as_object_mut() {
                        if let Some(tag) = obj.remove("outcome_kind") {
                            obj.entry("kind").or_insert(tag);
                        }
                    }
                }
            }
        }

        Ok(value)
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
        assert_eq!(recipe.format_version, RECIPE_FORMAT_VERSION);
        assert_eq!(recipe.sources[0].display_name, "people");
        assert_eq!(recipe.sources[0].reference_name, "people");
        assert!(matches!(
            recipe.history[0],
            crate::persistence::recipe::RecipeEntry::Turn(_)
        ));
    }
}
