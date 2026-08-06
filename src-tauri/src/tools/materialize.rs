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
use crate::model::{DatasetDescriptor, Promotion, RenameError};
use crate::session::materializer::{Materializer, TurnDeps};
use crate::tools::definitions;
use crate::tools::ToolPayload;

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
) -> Result<ToolPayload, String> {
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

    // Apply the optional display label AFTER a successful materialize, through
    // the working set's display-rename path so the ADR-0037 trim + uniqueness
    // invariants hold. The materializer set display_name = reference_name; a
    // caller-supplied label that trims + does not collide is swapped in on BOTH
    // the working-set slot and the returned descriptor. When the label CANNOT be
    // applied (collision, blank, or concurrent removal) the promotion already
    // succeeded so it is NOT rolled back -- instead the rejection is surfaced as
    // a `label_warning` field on the success payload (issue #308) so the agent
    // can distinguish "label rejected" from "no label supplied" and self-correct
    // (re-call with a unique label). Done here rather than inside the
    // materializer so the materializer stays display-name-agnostic (its contract
    // is to install under result_name; the label is a tool-layer concern).
    let mut label_warning: Option<String> = None;
    if let Some(label) = &display_name {
        match apply_display_label(deps, &result_name, label) {
            Ok(applied) => {
                descriptor.display_name = applied;
            }
            Err(e) => {
                label_warning = Some(label_warning_message(&e));
            }
        }
    }

    // Side-effect channel (issue #336): the promotion is built from the typed
    // `sql` (parsed above) + the typed `descriptor` (the materializer returned
    // and the working set just registered) -- no JSON serialize/deserialize
    // round trip. The content JSON is cloned out of the descriptor for the
    // model-facing payload, then the descriptor itself moves into the
    // Promotion the orchestration layer consumes, so the two stay in sync.
    let content = descriptor_json(&descriptor, label_warning.as_deref());
    Ok(ToolPayload {
        content,
        promotion: Some(Promotion {
            dataset: descriptor,
            sql,
        }),
    })
}

/// Apply the display label to the just-materialized working-set descriptor via
/// the working set's display-rename path (WorkingSet::rename_display), so the
/// ADR-0037 trim + uniqueness invariants are enforced rather than bypassed.
/// Returns the trimmed label on success (the caller mirrors it onto the returned
/// descriptor). On failure the typed `RenameError` is propagated so the caller
/// can surface it to the agent -- the promotion already succeeded, so the error
/// is NOT fatal; the caller turns it into a `label_warning` field (issue #308).
fn apply_display_label(
    deps: &mut TurnDeps,
    reference_name: &str,
    label: &str,
) -> Result<String, RenameError> {
    deps.working_set
        .rename_display(reference_name, label)
        .map(|updated| updated.display_name)
}

/// Turn a [`RenameError`] from `apply_display_label` into an agent-facing warning
/// string (issue #308). The promotion already succeeded -- the warning tells the
/// agent WHY its label was rejected so it can self-correct (re-call materialize
/// with a unique label). The three variants share a consistent structure: the
/// rejection reason + a note that the reference name was used instead.
fn label_warning_message(e: &RenameError) -> String {
    match e {
        RenameError::DisplayTaken(label) => format!(
            "display name `{label}` is already in use by another dataset; \
             the reference name was used instead — supply a unique display_name to rename it"
        ),
        RenameError::InvalidLabel => {
            "display name is blank (whitespace-only); the reference name was \
             used instead — supply a non-blank display_name to rename it"
                .to_string()
        }
        RenameError::NotFound(name) => format!(
            "dataset `{name}` was removed before the display name could be applied; \
             the promotion succeeded but the label was not set"
        ),
    }
}

/// Build the success payload JSON for a promoted descriptor. Carries the stable
/// reference name (the SQL-identity the agent uses in later FROM clauses), the
/// display label, the column schema, and the row count -- enough for the agent
/// to reference + reason about the new result without a follow-up `describe`.
/// When `label_warning` is present, a `label_warning` field is included so the
/// agent can distinguish "label rejected" from "no label supplied" (issue #308).
fn descriptor_json(d: &DatasetDescriptor, label_warning: Option<&str>) -> Value {
    let mut payload = json!({
        "reference_name": d.reference_name,
        "display_name": d.display_name,
        "columns": d.columns.iter().map(definitions::column_json).collect::<Vec<_>>(),
        "row_count": d.row_count,
    });
    if let Some(warning) = label_warning {
        payload["label_warning"] = json!(warning);
    }
    payload
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
    use crate::tools::test_support::{inert_deps, inert_deps_with_temp};
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
        let v = descriptor_json(&d, None);
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
        assert!(
            resource.starts_with("result exceeds a resource cap"),
            "{resource}"
        );
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
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let cancel = CancelToken::new();
        let mut materializer = ExplodingMaterializer;
        let err = dispatch(&json!({}), &mut deps, &cancel, &mut materializer).unwrap_err();
        assert!(
            err.contains("`sql`"),
            "error names the missing field: {err}"
        );
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
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;

        // First promotion -> result_1.
        let p1 = dispatch(
            &json!({"sql": "SELECT 1 AS x"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        // The side-effect channel carries the typed promotion (issue #336): the
        // sql matches the call input verbatim, and the dataset matches what the
        // working set just registered -- no JSON serialize/deserialize round
        // trip to recover it.
        let promotion1 = p1.promotion.as_ref().expect("materialize promotes");
        assert_eq!(promotion1.sql, "SELECT 1 AS x");
        assert_eq!(promotion1.dataset.reference_name, "result_1");
        assert_eq!(
            promotion1.dataset.display_name,
            deps.working_set.get("result_1").unwrap().display_name
        );
        let v1 = &p1.content;
        assert_eq!(v1["reference_name"], "result_1");
        assert_eq!(v1["row_count"], 1);
        assert_eq!(v1["columns"][0]["name"], "x");
        assert_eq!(deps.working_set.next_result_number(), 2);

        // Second promotion -> result_2 (one past result_1, monotonic).
        let p2 = dispatch(
            &json!({"sql": "SELECT 2 AS y"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        let promotion2 = p2.promotion.as_ref().expect("materialize promotes");
        assert_eq!(promotion2.sql, "SELECT 2 AS y");
        assert_eq!(promotion2.dataset.reference_name, "result_2");
        let v2 = &p2.content;
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
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;
        let payload = dispatch(
            &json!({"sql": "SELECT 1 AS x", "display_name": "my subset"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        // The promotion carries the post-label descriptor: the side-effect
        // channel reflects the display name AFTER it was applied.
        let promotion = payload.promotion.as_ref().expect("materialize promotes");
        assert_eq!(promotion.dataset.reference_name, "result_1");
        assert_eq!(promotion.dataset.display_name, "my subset");
        assert_eq!(promotion.sql, "SELECT 1 AS x");
        let v = &payload.content;
        assert_eq!(v["reference_name"], "result_1");
        assert_eq!(v["display_name"], "my subset");
        // The working-set descriptor carries the display label too.
        assert_eq!(
            deps.working_set.get("result_1").unwrap().display_name,
            "my subset"
        );
    }

    /// A display_name that collides with another dataset's label is NOT applied
    /// -- the ADR-0037 uniqueness invariant holds. The second promotion still
    /// succeeds (its result_N is registered, display_name falls back to the
    /// reference name), and a `label_warning` field on the payload tells the
    /// agent WHY the label was rejected so it can self-correct by re-calling
    /// with a unique label (issue #308). The first promotion's label is left
    /// untouched.
    #[test]
    fn display_name_collision_signals_rejection_to_agent() {
        use crate::session::materializer::RealMaterializer;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;

        // First promotion claims the display label "my label".
        let p1 = dispatch(
            &json!({"sql": "SELECT 1 AS x", "display_name": "my label"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        assert_eq!(
            p1.promotion
                .as_ref()
                .expect("materialize promotes")
                .dataset
                .reference_name,
            "result_1"
        );
        let v1 = &p1.content;
        assert_eq!(v1["reference_name"], "result_1");
        assert_eq!(v1["display_name"], "my label");

        // Second promotion reuses the SAME label -- ADR-0037 uniqueness refuses
        // it. The promotion itself still lands (result_2 is registered); the
        // label falls back to result_2 AND a label_warning is surfaced so the
        // agent can distinguish "label rejected" from "no label supplied".
        let p2 = dispatch(
            &json!({"sql": "SELECT 2 AS y", "display_name": "my label"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        let promotion2 = p2.promotion.as_ref().expect("materialize promotes");
        // The fallback descriptor rides the side-effect channel too: the
        // colliding label did not stick, so the promotion carries result_2.
        assert_eq!(promotion2.dataset.reference_name, "result_2");
        assert_eq!(promotion2.dataset.display_name, "result_2");
        let v2 = &p2.content;
        assert_eq!(v2["reference_name"], "result_2");
        assert_eq!(
            v2["display_name"], "result_2",
            "colliding label must fall back to the reference name"
        );
        // The label_warning field is present and identifies the collision —
        // this is the agent-distinguishable signal (issue #308).
        let warning = v2["label_warning"]
            .as_str()
            .expect("label_warning is present on collision rejection");
        assert!(
            warning.contains("already in use"),
            "warning identifies a collision: {warning}"
        );
        assert_eq!(
            deps.working_set.get("result_2").unwrap().display_name,
            "result_2"
        );
        // The first promotion's label is untouched.
        assert_eq!(
            deps.working_set.get("result_1").unwrap().display_name,
            "my label"
        );
        // The first promotion had no warning (its label applied successfully).
        assert!(
            v1.get("label_warning").is_none(),
            "no label_warning when the label applied successfully"
        );
    }

    /// A blank or whitespace-only `display_name` is rejected by the ADR-0037
    /// trim invariant (`rename_display` refuses an empty label). The promotion
    /// still lands (result_N registered, display_name falls back to the
    /// reference name), and a `label_warning` field tells the agent the label
    /// was blank so it can self-correct (issue #308).
    #[test]
    fn display_name_blank_signals_rejection_to_agent() {
        use crate::session::materializer::RealMaterializer;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;
        let payload = dispatch(
            &json!({"sql": "SELECT 1 AS x", "display_name": "   "}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap();
        let promotion = payload.promotion.as_ref().expect("materialize promotes");
        assert_eq!(promotion.dataset.reference_name, "result_1");
        assert_eq!(promotion.dataset.display_name, "result_1");
        let v = &payload.content;
        assert_eq!(v["reference_name"], "result_1");
        assert_eq!(
            v["display_name"], "result_1",
            "blank label falls back to the reference name"
        );
        let warning = v["label_warning"]
            .as_str()
            .expect("label_warning is present on blank rejection");
        assert!(
            warning.contains("blank"),
            "warning identifies a blank label: {warning}"
        );
        assert_eq!(
            deps.working_set.get("result_1").unwrap().display_name,
            "result_1"
        );
    }

    /// `label_warning_message` produces a distinct, actionable message for each
    /// `RenameError` variant (issue #308). The NotFound variant (concurrent
    /// removal) is hard to trigger through the full dispatch path — the
    /// materializer just registered the descriptor — so it is covered here at
    /// the unit level alongside the other two variants for completeness.
    #[test]
    fn label_warning_message_covers_all_rejection_reasons() {
        let taken = label_warning_message(&RenameError::DisplayTaken("my label".into()));
        assert!(
            taken.contains("already in use"),
            "DisplayTaken identifies a collision: {taken}"
        );

        let blank = label_warning_message(&RenameError::InvalidLabel);
        assert!(
            blank.contains("blank"),
            "InvalidLabel identifies a blank label: {blank}"
        );

        let gone = label_warning_message(&RenameError::NotFound("result_3".into()));
        assert!(
            gone.contains("removed"),
            "NotFound identifies concurrent removal: {gone}"
        );
    }

    /// `descriptor_json` omits the `label_warning` field when no warning is
    /// given (the common path — label applied successfully or not supplied).
    #[test]
    fn descriptor_json_omits_label_warning_when_absent() {
        let d = descriptor("result_1");
        let v = descriptor_json(&d, None);
        assert!(
            v.get("label_warning").is_none(),
            "no label_warning field when label applied or not supplied"
        );
    }

    /// `descriptor_json` includes the `label_warning` field when a warning is
    /// given, so the agent sees the rejection reason in the payload.
    #[test]
    fn descriptor_json_includes_label_warning_when_present() {
        let d = descriptor("result_1");
        let v = descriptor_json(&d, Some("display name is blank"));
        assert_eq!(
            v["label_warning"], "display name is blank",
            "label_warning is surfaced in the payload"
        );
    }

    /// AC (issue #334): a `read_*` call whose path resolves OUTSIDE the session
    /// source set + working temp dir is refused by the gateway door BEFORE the
    /// sandbox runs -- symmetric with `explore_refuses_out_of_bounds_read_path_
    /// at_gateway`. Before #334 the materialize path skipped the FsAcl whitelist
    /// (only explore ran it), so an out-of-bounds read_* hit the engine's opaque
    /// "disabled by configuration"; now it returns the structured "outside the
    /// allowed area" the agent can self-correct from (ADR-0077 / ADR-0080).
    #[test]
    fn materialize_refuses_out_of_bounds_read_path_at_gateway() {
        use crate::session::materializer::RealMaterializer;
        use std::fs;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        // A file that exists on disk but lives outside the session temp dir.
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.csv");
        fs::write(&outside_file, "x").unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;
        let err = dispatch(
            &json!({"sql": format!("SELECT * FROM read_csv_auto('{}')", outside_file.to_string_lossy())}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap_err();
        assert!(
            err.contains("outside the allowed"),
            "gateway names the out-of-bounds refusal: {err}"
        );
        assert!(
            err.contains("secret.csv"),
            "error names the offending path: {err}"
        );
        // No promotion landed: result_1 was never registered.
        assert_eq!(deps.working_set.len(), 0);
        assert_eq!(deps.working_set.next_result_number(), 1);
    }

    /// A cancel requested before the call surfaces as "materialize cancelled"
    /// without driving a real promotion. Symmetric with explore's
    /// `explore_returns_cancelled_when_cancel_already_requested`; the shared
    /// runner's mid-check (after sandbox setup) is what reports it. Pins the
    /// `SandboxExecError::Cancelled => ExecErrorKind::Cancelled` mapping on the
    /// materialize dispatch path (ADR-0077 honest cancel).
    #[test]
    fn materialize_returns_cancelled_when_cancel_already_requested() {
        use crate::session::materializer::RealMaterializer;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        cancel.request();
        let mut materializer = RealMaterializer;
        let err = dispatch(
            &json!({"sql": "SELECT 1 AS x"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap_err();
        assert_eq!(err, "materialize cancelled", "{err}");
        // No promotion landed: result_1 was never registered.
        assert_eq!(deps.working_set.len(), 0);
        assert_eq!(deps.working_set.next_result_number(), 1);
    }

    /// A result whose row count exceeds `result_row_cap` is refused as a
    /// Resource error naming the cap (ADR-0005/0030). Symmetric with explore's
    /// `explore_refuses_result_exceeding_row_cap`; pins the
    /// `SandboxExecError::Resource => ExecErrorKind::Resource` mapping on the
    /// materialize dispatch path. Hand-builds TurnDeps for the one-off cap.
    #[test]
    fn materialize_refuses_result_exceeding_row_cap() {
        use crate::session::materializer::RealMaterializer;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        let sources = std::collections::HashMap::new();
        // cap = 2; range(3) yields 3 rows -> cap+1 land on the sandbox, COUNT
        // (3) > cap (2) -> refused. Hand-built for the one-off bound.
        let mut deps = crate::session::materializer::TurnDeps {
            conn: &conn,
            source_files: &sources,
            working_set: &mut ws,
            result_row_cap: 2,
            result_count_cap: 100,
            temp_path: std::path::Path::new("."),
        };
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;
        let err = dispatch(
            &json!({"sql": "SELECT 1 FROM range(3)"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap_err();
        assert!(
            err.contains("result exceeds a resource cap"),
            "error reads as a resource-cap refusal: {err}"
        );
        assert!(
            err.contains("result_1"),
            "error names the target result: {err}"
        );
        assert!(
            err.contains("超过上限"),
            "error carries the over-cap detail: {err}"
        );
        // No promotion landed.
        assert_eq!(deps.working_set.len(), 0);
        assert_eq!(deps.working_set.next_result_number(), 1);
    }

    /// A SQL anchored on a stale result_N is refused up front (ADR-0013
    /// invariant 2). Symmetric with explore's
    /// `explore_refuses_stale_reference_anchor`; pins the
    /// `PreflightError::StaleReference => ExecErrorKind::StaleReference` mapping
    /// on the materialize dispatch path. The pre-placed stale result_1 stays;
    /// no new promotion lands.
    #[test]
    fn materialize_refuses_stale_reference_anchor() {
        use crate::model::{
            ColumnSchema, DatasetDescriptor, DatasetPrivacy, RectifyProvenance, StaleAnchor,
            StaleReason,
        };
        use crate::session::materializer::RealMaterializer;
        use tempfile::TempDir;

        let conn = Connection::open_in_memory().unwrap();
        let mut ws = crate::workingset::WorkingSet::default();
        ws.register_result(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 0,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: Some(StaleAnchor {
                reference_name: "people".into(),
                display_name: "people".into(),
                reason: StaleReason::Deleted,
            }),
        });
        let sources = std::collections::HashMap::new();
        let temp = TempDir::new().unwrap();
        let mut deps = inert_deps_with_temp(&conn, &mut ws, &sources, temp.path());
        let cancel = CancelToken::new();
        let mut materializer = RealMaterializer;
        let err = dispatch(
            &json!({"sql": "SELECT * FROM result_1"}),
            &mut deps,
            &cancel,
            &mut materializer,
        )
        .unwrap_err();
        assert!(
            err.contains("stale reference"),
            "error reads as a stale-reference refusal: {err}"
        );
        assert!(
            err.contains("result_1"),
            "error names the stale anchor: {err}"
        );
        // The pre-placed stale result_1 is still the only member; no new
        // promotion (result_2) landed.
        assert_eq!(deps.working_set.len(), 1);
        assert!(deps.working_set.get("result_2").is_none());
    }
}
