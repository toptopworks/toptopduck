//! The `materialize` tool executor (ADR-0077 explicit promotion, issue #292).
//!
//! Materialize is the ONLY built-in tool that creates a working-set object. It
//! computes the next `result_N` (ADR-0022: max+1, monotonic, never reused) and
//! delegates to the existing [`Materializer`] trait -- the same path the legacy
//! single-SQL turn drives -- so numbering, the row-count + result-count caps
//! (ADR-0005/0030), stale-reference refusal (ADR-0013), provenance recording
//! (issue #40), and stale-result GC (ADR-0013 M=100) are inherited verbatim.
//! This is the explicit "reuse existing Materializer / WorkingSet mechanisms"
//! called for by the issue.
//!
//! AC #2: promotion gets `result_N`, numbering is monotonic by promotion order
//! and never reused. The number is computed from the working set BEFORE the
//! call (a failed materialize registers nothing, so N is stable across retries
//! -- ADR-0022), and the same number is fed to the materializer.
//!
//! AC #3 (namespace isolation): materialize is the sole promotion path. A
//! scratch object from `explore` can never become a working-set entry because
//! explore does not touch admin -- only this tool does, through the materializer.

use serde_json::{json, Value};

use crate::cancel::CancelToken;
use crate::guardrail::{ExecError, ExecErrorKind};
use crate::model::DatasetDescriptor;
use crate::session::materializer::{Materializer, TurnDeps};
use crate::tools::definitions;

/// Parse the tool input + drive the materializer to promote the SQL's result.
///
/// Returns the promoted dataset's identity (reference_name + display_name +
/// columns + row_count) on success, or a tool-level error string. Errors mirror
/// the materializer's -- the agent can self-correct a bad SQL, a stale
/// reference, or a cap hit (ADR-0077: tool errors route back, never into blind
/// retry).
pub(crate) fn dispatch(
    input: &Value,
    deps: &mut TurnDeps,
    cancel: &CancelToken,
    materializer: &mut dyn Materializer,
) -> Result<Value, String> {
    let sql = definitions::get_str(input, "sql")?;
    // Optional display label. The reference name (result_N) is stable and never
    // changes; the display name is a presentation alias. When omitted, the
    // materializer sets display_name = reference_name (the existing default).
    let display_name = input
        .get("display_name")
        .and_then(Value::as_str)
        .map(str::to_string);

    // ADR-0022: result_N = max(existing)+1. Computed BEFORE the call -- a
    // failed materialize registers nothing, so the same N is fed on a retry,
    // keeping numbering stable across attempts. The live turn path in
    // Session::ask computes it the same way; resume replays use the recipe's
    // recorded name verbatim.
    let n = deps.working_set.next_result_number();
    let result_name = format!("result_{n}");

    let mut descriptor = materializer
        .try_materialize(&sql, cancel, result_name.clone(), deps)
        .map_err(|e| err_message(&result_name, e))?;

    // Apply the optional display label AFTER a successful materialize. The
    // materializer set display_name = reference_name; if the caller supplied a
    // label, swap it in on BOTH the working-set slot and the returned descriptor
    // (display-only -- ADR-0037, presentation layer only, no reference-name
    // impact). Done here rather than inside the materializer so the materializer
    // stays display-name-agnostic (its contract is to install under result_name;
    // the label is a tool-layer concern).
    if let Some(label) = display_name {
        if !label.trim().is_empty() {
            apply_display_label(deps, &result_name, &label);
            descriptor.display_name = label;
        }
    }

    Ok(descriptor_json(&descriptor))
}

/// Set the display label on the just-materialized working-set descriptor. Looks
/// up the descriptor by its stable reference name and swaps the display_name
/// field in place. Best-effort display-layer update -- the working set is the
/// source of truth, and a missing entry (concurrent removal) is silently
/// skipped since the materialize itself already succeeded. The caller also
/// mirrors the label onto the returned descriptor so the tool payload matches.
fn apply_display_label(deps: &mut TurnDeps, reference_name: &str, label: &str) {
    if let Some(slot) = deps
        .working_set
        .list_mut()
        .iter_mut()
        .find(|d| d.reference_name == reference_name)
    {
        slot.display_name = label.to_string();
    }
}

/// Build the success payload JSON for a promoted descriptor. Carries the stable
/// reference name (the SQL-identity the agent uses in later FROM clauses), the
/// display label, the column schema, and the row count -- enough for the agent
/// to reference + reason about the new result without a follow-up `describe`.
fn descriptor_json(d: &DatasetDescriptor) -> Value {
    json!({
        "reference_name": d.reference_name,
        "display_name": d.display_name,
        "columns": d.columns.iter().map(|c| json!({
            "name": c.name,
            "type": c.canonical_type,
        })).collect::<Vec<_>>(),
        "row_count": d.row_count,
    })
}

/// Turn a materializer [`ExecError`] into a tool-error string. The retry
/// routing the kind drives in the legacy single-SQL path does not apply here --
/// every tool error routes back to the agent uniformly (ADR-0077), so the kind
/// only seeds the wording; the detail rides the message verbatim.
fn err_message(result_name: &str, e: ExecError) -> String {
    let prefix = match e.kind {
        ExecErrorKind::Resource => "result exceeds a resource cap",
        ExecErrorKind::StaleReference => "stale reference",
        ExecErrorKind::Cancelled => "materialize cancelled",
        ExecErrorKind::Schema | ExecErrorKind::Runtime => "SQL failed",
    };
    // Naming result_name in the non-cancel branches gives the agent a stable
    // identity to reason about (the promotion that did NOT land). Skipped on
    // cancel -- the cancel is a user action, not a per-result fault.
    if matches!(e.kind, ExecErrorKind::Cancelled) {
        prefix.to_string()
    } else {
        format!("{prefix} (target {result_name}): {}", e.detail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnSchema, DatasetPrivacy, RectifyProvenance};
    use duckdb::Connection;

    /// A descriptor factory for the payload-shape test.
    fn descriptor(reference_name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: reference_name.into(),
            display_name: reference_name.into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 7,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    /// The success payload carries the stable reference name, the display name,
    /// the column schema, and the row count -- the fields the agent needs to
    /// reference + reason about the promoted result.
    #[test]
    fn descriptor_json_carries_identity_and_shape() {
        let d = descriptor("result_3");
        let v = descriptor_json(&d);
        assert_eq!(v["reference_name"], "result_3");
        assert_eq!(v["display_name"], "result_3");
        assert_eq!(v["row_count"], 7);
        assert_eq!(v["columns"][0]["name"], "c");
        assert_eq!(v["columns"][0]["type"], "INTEGER");
    }

    /// The retry-routing kind seeds the wording; the detail rides the message.
    /// Resource / StaleReference / Runtime each get their honest prefix so the
    /// agent can tell a cap hit from a schema error at a glance.
    #[test]
    fn err_message_seeds_prefix_from_kind() {
        let resource = err_message(
            "result_2",
            ExecError::new(ExecErrorKind::Resource, "row count over cap".to_string()),
        );
        assert!(resource.starts_with("result exceeds a resource cap"), "{resource}");
        assert!(resource.contains("row count over cap"), "{resource}");

        let stale = err_message(
            "result_1",
            ExecError::new(ExecErrorKind::StaleReference, "result_1".to_string()),
        );
        assert!(stale.starts_with("stale reference"), "{stale}");

        let runtime = err_message(
            "result_4",
            ExecError::new(ExecErrorKind::Runtime, "Binder Error".to_string()),
        );
        assert!(runtime.starts_with("SQL failed"), "{runtime}");
        assert!(runtime.contains("Binder Error"), "{runtime}");

        // Cancel carries no result identity -- it is a user action, not a
        // per-result fault.
        let cancelled = err_message(
            "result_5",
            ExecError::new(ExecErrorKind::Cancelled, "x".to_string()),
        );
        assert_eq!(cancelled, "materialize cancelled", "{cancelled}");
    }

    /// A materializer stand-in that panics on any call -- used to prove the
    /// missing-`sql` guard returns before the materializer is touched.
    struct ExplodingMaterializer;
    impl Materializer for ExplodingMaterializer {
        fn try_materialize(
            &self,
            _sql: &str,
            _cancel: &CancelToken,
            _result_name: String,
            _deps: &mut TurnDeps,
        ) -> Result<DatasetDescriptor, ExecError> {
            unreachable!("materializer must not be called when sql is missing")
        }
    }

    /// `dispatch` surfaces a missing `sql` parameter as a tool error BEFORE the
    /// materializer is touched -- no result_N is computed, no DuckDB call runs.
    #[test]
    fn dispatch_errors_when_sql_missing_without_touching_materializer() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let mut deps = TurnDeps {
            conn: &conn,
            source_files: &sources,
            working_set: &mut ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: std::path::Path::new("."),
        };
        let cancel = CancelToken::new();
        let mut materializer = ExplodingMaterializer;
        let err = dispatch(&json!({}), &mut deps, &cancel, &mut materializer).unwrap_err();
        assert!(err.contains("`sql`"), "error names the missing field: {err}");
    }

    /// End-to-end with the real materializer: two promotions land result_1 then
    /// result_2, numbering is monotonic by promotion order and never reuses,
    /// and each promoted result is registered in the working set (AC #2). The
    /// real materializer runs the full path (sandbox setup + install + derive +
    /// register + GC), proving the tool layer inherits the legacy semantics
    /// byte-for-byte via the shared Materializer trait.
    #[test]
    fn two_promotions_land_monotonic_result_n() {
        use crate::session::materializer::RealMaterializer;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        let mut deps = TurnDeps {
            conn: &conn,
            source_files: &sources,
            working_set: &mut ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: temp.path(),
        };
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;

        // First promotion -> result_1.
        let v1 = dispatch(
            &json!({"sql": "SELECT 1 AS x"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        assert_eq!(v1["reference_name"], "result_1");
        assert_eq!(v1["row_count"], 1);
        assert_eq!(v1["columns"][0]["name"], "x");
        assert_eq!(deps.working_set.next_result_number(), 2);

        // Second promotion -> result_2 (one past result_1, monotonic).
        let v2 = dispatch(
            &json!({"sql": "SELECT 2 AS y"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        assert_eq!(v2["reference_name"], "result_2");
        assert_eq!(deps.working_set.next_result_number(), 3);
        assert_eq!(deps.working_set.len(), 2, "both results registered");
    }

    /// An optional display_name is applied to the promoted descriptor after a
    /// successful materialize (ADR-0037 display-layer alias); the reference
    /// name stays result_N.
    #[test]
    fn display_name_is_applied_after_promotion() {
        use crate::session::materializer::RealMaterializer;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        let mut deps = TurnDeps {
            conn: &conn,
            source_files: &sources,
            working_set: &mut ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: temp.path(),
        };
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;
        let v = dispatch(
            &json!({"sql": "SELECT 1 AS x", "display_name": "my subset"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        assert_eq!(v["reference_name"], "result_1");
        assert_eq!(v["display_name"], "my subset");
        // The working-set descriptor carries the display label too.
        assert_eq!(
            deps.working_set.get("result_1").unwrap().display_name,
            "my subset"
        );
    }
}
