//! IPC wire-format contract tests: pin the JSON shape of the three enums that
//! cross the Rust<->frontend boundary (`RectifyProvenance`, `LoadError`,
//! `LoadOutcome`) so a serde attribute change fails the build before the
//! frontend's hand-mirrored `src/types.ts` can drift.
//!
//! The contract is adjacently-tagged (`#[serde(tag = "kind", content = "data")]`):
//! every variant carries `kind`; unit variants omit `data`, struct/newtype
//! variants carry it. `src/types.ts` mirrors the shapes asserted here -- if one
//! side changes, the other must follow, and these tests make that coupling loud.

use toptopduck_lib::{
    DatasetDescriptor, DatasetPrivacy, GuidanceRequest, LoadError, LoadOutcome, RectifyProvenance,
    SheetRectify,
};

/// Serialize `value`, assert the JSON equals `expected` (the pinned wire
/// contract), then deserialize and assert the round-trip is lossless. The
/// literal is the source of truth the frontend's `types.ts` mirrors.
fn assert_wire<T>(value: &T, expected: &str)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    // Act: serialize to the wire format and back.
    let json = serde_json::to_string(value).expect("serialize");
    let back: T = serde_json::from_str(&json).expect("deserialize");

    // Assert: exact shape matches the contract, and round-trip is lossless.
    assert_eq!(json, expected, "wire format drifted from pinned contract");
    assert_eq!(&back, value, "round-trip is not lossless");
}

#[test]
fn rectify_provenance_unit_variants_omit_data() {
    // Adjacent tagging serializes unit variants as `{"kind":"X"}` with no
    // `data` key -- the shape `types.ts` mirrors for NotApplicable/Auto.
    assert_wire(
        &RectifyProvenance::NotApplicable,
        r#"{"kind":"NotApplicable"}"#,
    );
    assert_wire(&RectifyProvenance::Auto, r#"{"kind":"Auto"}"#);
}

#[test]
fn rectify_provenance_user_carries_sheet_rectify_in_data() {
    // The user's explicit choices ride `data` -- the only variant that carries
    // payload, encoding ADR-0042's "only user decisions are persisted".
    let provenance = RectifyProvenance::User(SheetRectify {
        header_row: 2,
        skip_rows: vec![3, 5],
    });
    assert_wire(
        &provenance,
        r#"{"kind":"User","data":{"header_row":2,"skip_rows":[3,5]}}"#,
    );
}

#[test]
fn load_error_legacy_excel_unit_variant_omits_data() {
    // LegacyExcel is the one unit variant on LoadError; it must NOT regress to
    // the pre-PR bare string `"LegacyExcel"` the frontend used to match on.
    assert_wire(&LoadError::LegacyExcel, r#"{"kind":"LegacyExcel"}"#);
}

#[test]
fn load_error_struct_variants_carry_payload_in_data() {
    // Struct variants nest their fields under `data`.
    assert_wire(
        &LoadError::UnsupportedFormat {
            requested: "pdf".into(),
        },
        r#"{"kind":"UnsupportedFormat","data":{"requested":"pdf"}}"#,
    );
    assert_wire(
        &LoadError::Parse {
            detail: "bad-cell".into(),
        },
        r#"{"kind":"Parse","data":{"detail":"bad-cell"}}"#,
    );
    assert_wire(
        &LoadError::Io {
            detail: "io-fail".into(),
        },
        r#"{"kind":"Io","data":{"detail":"io-fail"}}"#,
    );
    assert_wire(
        &LoadError::Other {
            detail: "other".into(),
        },
        r#"{"kind":"Other","data":{"detail":"other"}}"#,
    );
    assert_wire(
        &LoadError::UnknownDataset {
            reference_name: "people".into(),
        },
        r#"{"kind":"UnknownDataset","data":{"reference_name":"people"}}"#,
    );
}

/// Minimal descriptor fixture: the wire-format test pins the *envelope* shape
/// (`kind`/`data` tagging), not the descriptor's own field set, so empty
/// collections keep the pinned literal short and stable.
fn sample_descriptor() -> DatasetDescriptor {
    DatasetDescriptor {
        reference_name: "people".into(),
        display_name: "people".into(),
        source_path: "/x/m.csv".into(),
        columns: vec![],
        row_count: 0,
        sample: vec![],
        fingerprint: "abcd".into(),
        rectify: RectifyProvenance::NotApplicable,
        privacy: DatasetPrivacy::default(),
        stale: None,
    }
}

#[test]
fn load_outcome_loaded_carries_descriptor_in_data() {
    // Loaded nests the full descriptor; the descriptor's own `rectify` field
    // serializes with the same adjacent tag, proving nested tagging is uniform.
    // `privacy` rides the descriptor as the default (samples on, no type-only),
    // so the cross-PRD contract (issue #9) is pinned here for the frontend mirror.
    assert_wire(
        &LoadOutcome::Loaded(sample_descriptor()),
        r#"{"kind":"Loaded","data":{"reference_name":"people","display_name":"people","source_path":"/x/m.csv","columns":[],"row_count":0,"sample":[],"fingerprint":"abcd","rectify":{"kind":"NotApplicable"},"privacy":{"send_samples":true,"type_only_columns":[]}}}"#,
    );
}

#[test]
fn dataset_privacy_default_serializes_to_samples_on_empty_type_only() {
    // The privacy wire shape the frontend mirrors: two flat fields, no tagging.
    // Default = ADR-0011 (samples on, no type-only columns).
    assert_wire(
        &DatasetPrivacy::default(),
        r#"{"send_samples":true,"type_only_columns":[]}"#,
    );
}

#[test]
fn dataset_privacy_carries_type_only_columns() {
    // A user-marked type-only config round-trips with the column names in order.
    let privacy = DatasetPrivacy {
        send_samples: false,
        type_only_columns: vec!["ssn".into(), "phone".into()],
    };
    assert_wire(
        &privacy,
        r#"{"send_samples":false,"type_only_columns":["ssn","phone"]}"#,
    );
}

#[test]
fn descriptor_without_privacy_field_deserializes_to_default() {
    // Backward compat: an older descriptor (or recipe) that omits `privacy` must
    // deserialize to the ADR-0011 default rather than failing -- `#[serde(default)]`
    // on the field. A newer consumer (PRD #1 window assembler) then reads a sane
    // config instead of a missing-field error.
    let json = r#"{"reference_name":"people","display_name":"people","source_path":"/x/m.csv","columns":[],"row_count":0,"sample":[],"fingerprint":"abcd","rectify":{"kind":"NotApplicable"}}"#;
    let d: DatasetDescriptor = serde_json::from_str(json).expect("deserialize");
    assert_eq!(d.privacy, DatasetPrivacy::default());
    assert!(d.privacy.send_samples);
    assert!(d.privacy.type_only_columns.is_empty());
}

#[test]
fn load_outcome_needs_guidance_carries_request_in_data() {
    let request = GuidanceRequest {
        source_path: "/x/m.xlsx".into(),
        workbook_name: "m".into(),
        sheets: vec![],
    };
    assert_wire(
        &LoadOutcome::NeedsGuidance(request),
        r#"{"kind":"NeedsGuidance","data":{"source_path":"/x/m.xlsx","workbook_name":"m","sheets":[]}}"#,
    );
}

#[test]
fn load_outcome_error_nests_load_error_tag() {
    // Error wraps a LoadError; the inner enum keeps its own `kind`/`data` shape,
    // so the frontend narrows `outcome.data.kind` uniformly at every depth.
    assert_wire(
        &LoadOutcome::Error(LoadError::LegacyExcel),
        r#"{"kind":"Error","data":{"kind":"LegacyExcel"}}"#,
    );
    assert_wire(
        &LoadOutcome::Error(LoadError::Parse {
            detail: "parse-fail".into(),
        }),
        r#"{"kind":"Error","data":{"kind":"Parse","data":{"detail":"parse-fail"}}}"#,
    );
}

#[test]
fn turn_outcome_materialized_carries_the_promotion_chain_and_assumption() {
    // Pin the wire shape the frontend mirrors (src/types/thread.ts, ADR-0084):
    // adjacently-tagged, the Materialized variant nests the promotion chain --
    // each a full dataset descriptor + the verbatim SQL that produced it --
    // plus viz + assumption under data. assumption is always present -- null
    // when the provider offered none; viz is null when the provider offered no
    // chart (ADR-0016/0033, default table).
    use toptopduck_lib::model::Promotion;
    use toptopduck_lib::TurnOutcome;
    assert_wire(
        &TurnOutcome::Materialized {
            promotions: vec![Promotion {
                dataset: sample_descriptor(),
                sql: "SELECT 1".into(),
            }],
            viz: None,
            assumption: None,
        },
        r#"{"kind":"Materialized","data":{"promotions":[{"dataset":{"reference_name":"people","display_name":"people","source_path":"/x/m.csv","columns":[],"row_count":0,"sample":[],"fingerprint":"abcd","rectify":{"kind":"NotApplicable"},"privacy":{"send_samples":true,"type_only_columns":[]}},"sql":"SELECT 1"}],"viz":null,"assumption":null}}"#,
    );
}

#[test]
fn turn_outcome_materialized_carries_a_viz_spec() {
    // #26 (ADR-0016/0033): a Materialized outcome may carry a viz spec -- a
    // chart kind (whitelist bare variant, serde rename_all="lowercase") plus the
    // Vega-Lite JSON spec string. Pin the wire shape src/types.ts mirrors so a
    // frontend regression is caught here, not silently. The spec string is
    // carried verbatim (escaped as a JSON string); the frontend parses + renders
    // it, degrading to the table on a malformed spec or render failure.
    use toptopduck_lib::model::Promotion;
    use toptopduck_lib::{ChartKind, TurnOutcome, VizSpec};
    assert_wire(
        &TurnOutcome::Materialized {
            promotions: vec![Promotion {
                dataset: sample_descriptor(),
                sql: "SELECT 1".into(),
            }],
            viz: Some(VizSpec {
                kind: ChartKind::Bar,
                spec: "{\"mark\":\"bar\"}".into(),
            }),
            assumption: None,
        },
        r#"{"kind":"Materialized","data":{"promotions":[{"dataset":{"reference_name":"people","display_name":"people","source_path":"/x/m.csv","columns":[],"row_count":0,"sample":[],"fingerprint":"abcd","rectify":{"kind":"NotApplicable"},"privacy":{"send_samples":true,"type_only_columns":[]}},"sql":"SELECT 1"}],"viz":{"kind":"bar","spec":"{\"mark\":\"bar\"}"},"assumption":null}}"#,
    );
}

#[test]
fn chart_kind_serializes_as_a_lowercase_variant_string() {
    // ChartKind crosses IPC as its bare lowercase variant name (serde
    // rename_all="lowercase") -- the whitelist the frontend mirrors as a string
    // union in src/types.ts. Anything outside this set is not a ChartKind.
    use toptopduck_lib::ChartKind;
    assert_wire(&ChartKind::Table, r#""table""#);
    assert_wire(&ChartKind::Bar, r#""bar""#);
    assert_wire(&ChartKind::Line, r#""line""#);
    assert_wire(&ChartKind::Scatter, r#""scatter""#);
    assert_wire(&ChartKind::Area, r#""area""#);
    assert_wire(&ChartKind::Pie, r#""pie""#);
}

#[test]
fn turn_error_serializes_adjacently_tagged() {
    // TurnError crosses IPC as a serde struct wrapped in SessionError::Turn
    // (issue #121), no longer as its Display string. The hand-written Display is
    // Rust-log-only. Turn failures are TurnOutcome::Failed (ADR-0028); this type
    // now carries only the read_rows errors (UnknownDataset, Execute).
    use toptopduck_lib::TurnError;
    assert_wire(
        &TurnError::Execute("detail".into()),
        r#"{"kind":"Execute","data":"detail"}"#,
    );
    assert_wire(
        &TurnError::UnknownDataset("result_1".into()),
        r#"{"kind":"UnknownDataset","data":"result_1"}"#,
    );
}

#[test]
fn remove_source_error_serializes_adjacently_tagged() {
    // RemoveSourceError crosses IPC wrapped in SessionError::RemoveSource (issue
    // #121). NotFound / NotActive / InvalidContinueWith are newtype variants
    // (string under data); IsActive is a struct variant.
    use toptopduck_lib::RemoveSourceError;
    assert_wire(
        &RemoveSourceError::NotFound("people".into()),
        r#"{"kind":"NotFound","data":"people"}"#,
    );
    assert_wire(
        &RemoveSourceError::IsActive {
            reference_name: "people".into(),
            display_name: "员工表".into(),
        },
        r#"{"kind":"IsActive","data":{"reference_name":"people","display_name":"员工表"}}"#,
    );
    assert_wire(
        &RemoveSourceError::NotActive("people".into()),
        r#"{"kind":"NotActive","data":"people"}"#,
    );
    assert_wire(
        &RemoveSourceError::InvalidContinueWith("ghost".into()),
        r#"{"kind":"InvalidContinueWith","data":"ghost"}"#,
    );
}

#[test]
fn rename_error_serializes_adjacently_tagged() {
    // RenameError (dataset display-label rename, ADR-0037) crosses IPC wrapped
    // in SessionError::RenameDataset (issue #121). NotFound / DisplayTaken are
    // newtype variants; InvalidLabel is a unit variant (no data).
    use toptopduck_lib::RenameError;
    assert_wire(
        &RenameError::NotFound("people".into()),
        r#"{"kind":"NotFound","data":"people"}"#,
    );
    assert_wire(
        &RenameError::DisplayTaken("员工表".into()),
        r#"{"kind":"DisplayTaken","data":"员工表"}"#,
    );
    assert_wire(&RenameError::InvalidLabel, r#"{"kind":"InvalidLabel"}"#);
}

#[test]
fn rename_session_error_serializes_adjacently_tagged() {
    // RenameSessionError (session rename, ADR-0060) crosses IPC wrapped in
    // SessionError::RenameSession (issue #121). EmptyName is a unit variant.
    use toptopduck_lib::RenameSessionError;
    assert_wire(&RenameSessionError::EmptyName, r#"{"kind":"EmptyName"}"#);
}

#[test]
fn store_command_error_serializes_adjacently_tagged() {
    // StoreCommandError (cold-store commands, issue #130) crosses IPC as the
    // reject of delete_session / rename_persisted_session / keychain / provider
    // + app config. OpenConflict is a unit variant; BlankName nests
    // RenameSessionError (the blank-name refusal matches rename_session's
    // shape); the three failure variants carry the English detail under data.
    use toptopduck_lib::{RenameSessionError, StoreCommandError};
    assert_wire(
        &StoreCommandError::OpenConflict,
        r#"{"kind":"OpenConflict"}"#,
    );
    assert_wire(
        &StoreCommandError::BlankName(RenameSessionError::EmptyName),
        r#"{"kind":"BlankName","data":{"kind":"EmptyName"}}"#,
    );
    assert_wire(
        &StoreCommandError::IoFailure("disk full".into()),
        r#"{"kind":"IoFailure","data":"disk full"}"#,
    );
    assert_wire(
        &StoreCommandError::KeychainFailure("locked".into()),
        r#"{"kind":"KeychainFailure","data":"locked"}"#,
    );
    assert_wire(
        &StoreCommandError::ConfigWriteFailure("rename busy".into()),
        r#"{"kind":"ConfigWriteFailure","data":"rename busy"}"#,
    );
}

#[test]
fn text_kind_serializes_as_a_bare_variant_string() {
    // TextKind is a plain (untagged) enum, so each variant crosses IPC as its
    // bare name string -- the shape src/types.ts mirrors for the textual
    // outcome's text_kind field.
    use toptopduck_lib::TextKind;
    assert_wire(&TextKind::Clarify, r#""Clarify""#);
    assert_wire(&TextKind::Refuse, r#""Refuse""#);
    // Agent -- the tool-calling contract's terminal text (ADR-0077) -- is the
    // only textual kind the production loop emits, so it rides the same lock.
    assert_wire(&TextKind::Agent, r#""Agent""#);
}

#[test]
fn turn_outcome_textual_carries_kind_body_and_assumption() {
    // Outcome B (ADR-0017/0018): the textual variant nests text_kind (a bare
    // string), body, and assumption under data. assumption is always present --
    // null when the provider offered none.
    use toptopduck_lib::{TextKind, TurnOutcome};
    assert_wire(
        &TurnOutcome::Textual {
            text_kind: TextKind::Refuse,
            body: "out of scope".into(),
            assumption: None,
        },
        r#"{"kind":"Textual","data":{"text_kind":"Refuse","body":"out of scope","assumption":null}}"#,
    );
}

#[test]
fn turn_outcome_failed_nests_typed_failure_under_data() {
    // Outcome C (ADR-0028, issue #125): a failed turn nests the typed
    // TurnFailure under data -- itself adjacently-tagged (kind/data), so the
    // frontend narrows on the failure kind to render a locale message, never a
    // backend Display string.
    use toptopduck_lib::{TurnFailure, TurnOutcome};
    assert_wire(
        &TurnOutcome::Failed(TurnFailure::Execute {
            detail: "bad column".into(),
        }),
        r#"{"kind":"Failed","data":{"kind":"Execute","data":{"detail":"bad column"}}}"#,
    );
}

#[test]
fn turn_outcome_failed_invalid_config_carries_detail_under_data() {
    // Outcome C (ADR-0028, issue #277): a permanent configuration fault nests
    // the typed TurnFailure::InvalidConfig under data, adjacently-tagged like
    // Execute / Resource so the frontend narrows on kind and folds the detail.
    // Pinned here -- alongside Execute / NotWired / StaleReference -- so a serde
    // attribute change (e.g. renaming `detail` or retagging) fails the build
    // before the frontend's hand-mirrored `types/thread.ts` can drift. The
    // golden `error_variant_kinds` only pins the `kind` label, not this shape.
    use toptopduck_lib::{TurnFailure, TurnOutcome};
    assert_wire(
        &TurnOutcome::Failed(TurnFailure::InvalidConfig {
            detail: "scheme `file` is not http/https".into(),
        }),
        r#"{"kind":"Failed","data":{"kind":"InvalidConfig","data":{"detail":"scheme `file` is not http/https"}}}"#,
    );
}

#[test]
fn turn_outcome_cancelled_is_a_unit_variant_with_no_data() {
    // Outcome D (ADR-0028, placeholder until #28): a unit variant -- `kind`
    // only, no `data` key -- like the other unit variants in the contract.
    use toptopduck_lib::TurnOutcome;
    assert_wire(&TurnOutcome::Cancelled, r#"{"kind":"Cancelled"}"#);
}

#[test]
fn turn_record_pairs_question_and_outcome() {
    // A thread entry (ADR-0028/0039): a flat { question, outcome } object where
    // outcome keeps its own adjacent tag. This is the Turn shape a ThreadEntry
    // wraps (see thread_entry_* below for the conversation() wire shape).
    use toptopduck_lib::{TurnFailure, TurnOutcome, TurnRecord};
    assert_wire(
        &TurnRecord {
            question: "总行数？".into(),
            outcome: TurnOutcome::Failed(TurnFailure::NotWired),
        },
        r#"{"question":"总行数？","outcome":{"kind":"Failed","data":{"kind":"NotWired"}}}"#,
    );
}

#[test]
fn source_lifecycle_kind_serializes_as_a_bare_variant_string() {
    // ADR-0040: SourceLifecycleKind is a plain (untagged) enum, so each variant
    // crosses IPC as its bare name string -- the shape src/types.ts mirrors.
    // Replaced lands with #41 (ADR-0025): a source re-upload under the same
    // reference name, distinct from Added (new name) and Deleted (name gone).
    use toptopduck_lib::SourceLifecycleKind;
    assert_wire(&SourceLifecycleKind::Added, r#""Added""#);
    assert_wire(&SourceLifecycleKind::Deleted, r#""Deleted""#);
    assert_wire(&SourceLifecycleKind::Replaced, r#""Replaced""#);
}

#[test]
fn stale_anchor_carries_reference_display_and_reason() {
    // ADR-0013/0040/0041: a StaleAnchor is a flat { reference_name, display_name,
    // reason } object. `reason` distinguishes a Deleted-cascade anchor (source
    // removed) from a Replaced-cascade anchor (source re-uploaded), so the UI
    // can render "因源已删除而失效" vs "因源已更新而失效" (issue #41 AC4). It
    // defaults to Deleted on deserialize (#[serde(default)]), so recipes
    // written before #41 (no reason field) still load.
    use toptopduck_lib::{StaleAnchor, StaleReason};
    assert_wire(
        &StaleAnchor {
            reference_name: "orders".into(),
            display_name: "Q3 订单".into(),
            reason: StaleReason::Replaced,
        },
        r#"{"reference_name":"orders","display_name":"Q3 订单","reason":"Replaced"}"#,
    );
    assert_wire(
        &StaleAnchor {
            reference_name: "orders".into(),
            display_name: "Q3 订单".into(),
            reason: StaleReason::Deleted,
        },
        r#"{"reference_name":"orders","display_name":"Q3 订单","reason":"Deleted"}"#,
    );
    // Backward compat: a pre-#41 StaleAnchor JSON (no `reason`) deserializes
    // with reason = Deleted (the only stale cause that existed before #41).
    let legacy: StaleAnchor =
        serde_json::from_str(r#"{"reference_name":"orders","display_name":"Q3 订单"}"#)
            .expect("legacy StaleAnchor without reason deserializes");
    assert_eq!(legacy.reason, StaleReason::Deleted);
}

#[test]
fn source_lifecycle_event_carries_kind_name_and_display() {
    // ADR-0040: a source lifecycle event is a flat { kind, reference_name,
    // display_name } object. kind serializes as its bare variant string. The
    // display_name is captured at event time so the thread can render it after
    // the descriptor is gone (a Deleted event still names what was removed).
    use toptopduck_lib::{SourceLifecycleEvent, SourceLifecycleKind};
    assert_wire(
        &SourceLifecycleEvent {
            kind: SourceLifecycleKind::Deleted,
            reference_name: "orders".into(),
            display_name: "Q3 订单".into(),
        },
        r#"{"kind":"Deleted","reference_name":"orders","display_name":"Q3 订单"}"#,
    );
}

#[test]
fn thread_entry_turn_wraps_a_turn_record_under_data() {
    // ADR-0040: the unified timeline entry. Adjacently-tagged on `entry`:
    // a Turn wraps the full TurnRecord (which keeps its own {question,outcome}
    // shape) under `data`. This is what conversation() returns for turns.
    use toptopduck_lib::{ThreadEntry, TurnFailure, TurnOutcome, TurnRecord};
    assert_wire(
        &ThreadEntry::Turn(TurnRecord {
            question: "总行数？".into(),
            outcome: TurnOutcome::Failed(TurnFailure::StaleReference {
                reference_name: "result_1".into(),
            }),
        }),
        r#"{"entry":"Turn","data":{"question":"总行数？","outcome":{"kind":"Failed","data":{"kind":"StaleReference","data":{"reference_name":"result_1"}}}}}"#,
    );
}

#[test]
fn thread_entry_source_wraps_a_source_event_under_data() {
    // ADR-0040: the non-turn entry. A Source wraps the lifecycle event under
    // `data`; the frontend narrows on `entry` to render it distinctly from a
    // turn (no question, no outcome -- never enters the LLM window).
    use toptopduck_lib::{SourceLifecycleEvent, SourceLifecycleKind, ThreadEntry};
    assert_wire(
        &ThreadEntry::Source(SourceLifecycleEvent {
            kind: SourceLifecycleKind::Added,
            reference_name: "people".into(),
            display_name: "people".into(),
        }),
        r#"{"entry":"Source","data":{"kind":"Added","reference_name":"people","display_name":"people"}}"#,
    );
}

#[test]
fn session_error_serializes_as_adjacently_tagged_kind_data() {
    // SessionError crosses IPC as a serde-structured value (issue #119):
    // `#[serde(tag = "kind", content = "data")]`, the same adjacently-tagged
    // shape the rest of the wire contract uses, so the frontend narrows on
    // `kind` and renders a locale message. The four guard variants are unit --
    // `{"kind":"X"}` with no `data`; Engine carries its detail string under
    // `data`. The thiserror `#[error(...)]` Display strings are Rust-log-only,
    // NOT the IPC contract (commands no longer map through Display; the Display
    // wording is pinned separately in the session_store unit tests).
    use toptopduck_lib::SessionError;
    assert_wire(&SessionError::InvalidId, r#"{"kind":"InvalidId"}"#);
    assert_wire(&SessionError::NotFound, r#"{"kind":"NotFound"}"#);
    assert_wire(&SessionError::Resuming, r#"{"kind":"Resuming"}"#);
    assert_wire(&SessionError::InFlight, r#"{"kind":"InFlight"}"#);
    assert_wire(
        &SessionError::Engine("boom".into()),
        r#"{"kind":"Engine","data":"boom"}"#,
    );
    // Resume wraps the typed ResumeError (issue #120 Option B): the inner enum
    // keeps its own kind/data shape, so the frontend recurses uniformly. The
    // resume failure no longer flattens to Engine(string).
    use std::path::PathBuf;
    use toptopduck_lib::ResumeError;
    assert_wire(
        &SessionError::Resume(ResumeError::AlreadyOpen(PathBuf::from("/x/a.duck"))),
        r#"{"kind":"Resume","data":{"kind":"AlreadyOpen","data":"/x/a.duck"}}"#,
    );
    // Issue #121: source-management domain errors wrap their typed sub-enums the
    // same way Resume wraps ResumeError -- the frontend recurses `<variant>.
    // data.kind` uniformly. Each inner enum keeps its own kind/data shape.
    use toptopduck_lib::{RemoveSourceError, RenameError, RenameSessionError, TurnError};
    assert_wire(
        &SessionError::RemoveSource(RemoveSourceError::NotFound("people".into())),
        r#"{"kind":"RemoveSource","data":{"kind":"NotFound","data":"people"}}"#,
    );
    assert_wire(
        &SessionError::RenameDataset(RenameError::DisplayTaken("员工表".into())),
        r#"{"kind":"RenameDataset","data":{"kind":"DisplayTaken","data":"员工表"}}"#,
    );
    assert_wire(
        &SessionError::RenameSession(RenameSessionError::EmptyName),
        r#"{"kind":"RenameSession","data":{"kind":"EmptyName"}}"#,
    );
    assert_wire(
        &SessionError::Turn(TurnError::Execute("detail".into())),
        r#"{"kind":"Turn","data":{"kind":"Execute","data":"detail"}}"#,
    );
}

// --- issue #120 resume / persistence error wire contracts -------------------
//
// Pin the JSON shape of the four typed error enums that cross the Rust<->
// frontend boundary as command rejects / return values: ResumeError (the
// `open_duck` reject), SaveError (the `take_persist_error` returned value),
// and the nested DuckLoadError + MigrationError (which ride inside
// ResumeError::Load). All adjacently-tagged (`#[serde(tag="kind", content =
// "data")]`), the same shape the rest of the wire contract uses, so the
// frontend narrows on `kind` at every depth. src/types.ts mirrors the shapes
// asserted here -- if one side changes, the other must follow.

#[test]
fn migration_error_serializes_adjacently_tagged() {
    // MigrationError rides LoadError::Migration inside ResumeError::Load. The
    // Field newtype needs the adjacent `content = "data"` slot (an internally-
    // tagged enum cannot carry a bare-string newtype variant).
    use toptopduck_lib::MigrationError;
    assert_wire(
        &MigrationError::NoTransform {
            from: 1,
            supported: 2,
        },
        r#"{"kind":"NoTransform","data":{"from":1,"supported":2}}"#,
    );
    assert_wire(
        &MigrationError::Field("missing x".into()),
        r#"{"kind":"Field","data":"missing x"}"#,
    );
}

#[test]
fn duck_load_error_serializes_adjacently_tagged() {
    // The .duck load error (persistence::io::LoadError) -- distinct from the
    // ingest model::LoadError. Nests MigrationError under data; the inner enum
    // keeps its own kind/data shape so the frontend recurses uniformly.
    use toptopduck_lib::{DuckLoadError, MigrationError};
    assert_wire(
        &DuckLoadError::Io("io-fail".into()),
        r#"{"kind":"Io","data":"io-fail"}"#,
    );
    assert_wire(
        &DuckLoadError::Parse("parse-fail".into()),
        r#"{"kind":"Parse","data":"parse-fail"}"#,
    );
    assert_wire(
        &DuckLoadError::VersionMismatch {
            found: 3,
            supported: 1,
        },
        r#"{"kind":"VersionMismatch","data":{"found":3,"supported":1}}"#,
    );
    assert_wire(
        &DuckLoadError::Migration(MigrationError::Field("bad".into())),
        r#"{"kind":"Migration","data":{"kind":"Field","data":"bad"}}"#,
    );
}

#[test]
fn save_error_serializes_adjacently_tagged() {
    // SaveError is the take_persist_error returned value (Option<SaveError>).
    // AlreadyOpen carries the canonical .duck path (PathBuf -> a JSON string)
    // so the UI can name exactly which file is double-open.
    use std::path::PathBuf;
    use toptopduck_lib::SaveError;
    assert_wire(
        &SaveError::Serialize("ser-fail".into()),
        r#"{"kind":"Serialize","data":"ser-fail"}"#,
    );
    assert_wire(
        &SaveError::Io("io-fail".into()),
        r#"{"kind":"Io","data":"io-fail"}"#,
    );
    assert_wire(
        &SaveError::Rename("rename-fail".into()),
        r#"{"kind":"Rename","data":"rename-fail"}"#,
    );
    assert_wire(
        &SaveError::AlreadyOpen(PathBuf::from("/x/a.duck")),
        r#"{"kind":"AlreadyOpen","data":"/x/a.duck"}"#,
    );
}

#[test]
fn resume_error_serializes_adjacently_tagged() {
    // ResumeError is the open_duck command's typed reject (no longer flattened
    // to SessionError::Engine(string)). Load recurses into DuckLoadError.
    use std::path::PathBuf;
    use toptopduck_lib::{DuckLoadError, ResumeError};
    assert_wire(
        &ResumeError::Load(DuckLoadError::VersionMismatch {
            found: 3,
            supported: 1,
        }),
        r#"{"kind":"Load","data":{"kind":"VersionMismatch","data":{"found":3,"supported":1}}}"#,
    );
    assert_wire(
        &ResumeError::SourceMissing {
            reference_name: "people".into(),
            path: "/x".into(),
            detail: "d".into(),
        },
        r#"{"kind":"SourceMissing","data":{"reference_name":"people","path":"/x","detail":"d"}}"#,
    );
    assert_wire(
        &ResumeError::Replay {
            reference_name: "result_1".into(),
            detail: "d".into(),
        },
        r#"{"kind":"Replay","data":{"reference_name":"result_1","detail":"d"}}"#,
    );
    assert_wire(
        &ResumeError::ActiveMissing("ghost".into()),
        r#"{"kind":"ActiveMissing","data":"ghost"}"#,
    );
    // Unit variants omit data.
    assert_wire(&ResumeError::Cancelled, r#"{"kind":"Cancelled"}"#);
    assert_wire(&ResumeError::Aborted, r#"{"kind":"Aborted"}"#);
    // AlreadyOpen carries the canonical path (PathBuf -> JSON string).
    assert_wire(
        &ResumeError::AlreadyOpen(PathBuf::from("/x/a.duck")),
        r#"{"kind":"AlreadyOpen","data":"/x/a.duck"}"#,
    );
}

// --- issue #76 progress + listing wire contracts (ADR-0056/0059/0060) -------
//
// Pin the JSON shape of the turn-progress / resume-progress side-channel
// events and the list_sessions metadata so a serde attribute change fails
// the build before src/types.ts can drift. Externally-tagged enums + flat
// snake_case structs; the literals are the source of truth the frontend mirrors.

#[test]
fn turn_phase_serializes_externally_tagged_with_attempt() {
    // ADR-0059 (issue #76): TurnPhase crosses IPC externally-tagged
    // (`{"Thinking":{"attempt":1}}`), mirroring the sibling ResumeEvent shape.
    // The frontend narrows on the variant discriminator; pin the tag + the
    // 1-based attempt so a serde rename / tag-style change fails here.
    use toptopduck_lib::TurnPhase;
    assert_wire(
        &TurnPhase::Thinking { attempt: 1 },
        r#"{"Thinking":{"attempt":1}}"#,
    );
    assert_wire(
        &TurnPhase::Querying { attempt: 2 },
        r#"{"Querying":{"attempt":2}}"#,
    );
}

#[test]
fn turn_progress_wraps_phase_with_session_id() {
    // ADR-0056/0059 (issue #76): a turn-progress event is { session_id, phase }
    // -- the addressing id lets a multi-session frontend filter the global
    // broadcast; phase keeps its own externally-tagged shape. Pin the wrapper
    // so a field rename on either side is caught before types.ts drifts.
    use toptopduck_lib::{TurnPhase, TurnProgress};
    assert_wire(
        &TurnProgress {
            session_id: "s1".into(),
            phase: TurnPhase::Thinking { attempt: 1 },
        },
        r#"{"session_id":"s1","phase":{"Thinking":{"attempt":1}}}"#,
    );
}

#[test]
fn resume_event_serializes_externally_tagged() {
    // ADR-0034: ResumeEvent crosses IPC externally-tagged, one variant per
    // source-verification / replay step. Pin both variants so the frontend's
    // `in` narrowing on Source / Replay survives any serde attribute change.
    use toptopduck_lib::ResumeEvent;
    assert_wire(
        &ResumeEvent::Source {
            index: 1,
            total: 2,
            reference_name: "orders".into(),
        },
        r#"{"Source":{"index":1,"total":2,"reference_name":"orders"}}"#,
    );
    assert_wire(
        &ResumeEvent::Replay {
            index: 2,
            total: 3,
            reference_name: "result_1".into(),
        },
        r#"{"Replay":{"index":2,"total":3,"reference_name":"result_1"}}"#,
    );
}

#[test]
fn resume_progress_wraps_event_with_session_id() {
    // ADR-0056/0059 (issue #76): a resume-progress event is { session_id, event
    // } -- v1 emitted a bare ResumeEvent; multi-session lands the id. Pin the
    // wrapper so the frontend's `{ event }` unwrap (src/App.tsx) stays in sync.
    use toptopduck_lib::{ResumeEvent, ResumeProgress};
    assert_wire(
        &ResumeProgress {
            session_id: "r1".into(),
            event: ResumeEvent::Replay {
                index: 1,
                total: 2,
                reference_name: "result_1".into(),
            },
        },
        r#"{"session_id":"r1","event":{"Replay":{"index":1,"total":2,"reference_name":"result_1"}}}"#,
    );
}

#[test]
fn source_summary_serializes_flat_snake_case() {
    // ADR-0060 (issue #76): SourceSummary is a flat snake_case object -- the
    // sidebar sub-line. first_source_name is null when the working set is empty
    // (ADR-0035), present otherwise. Pin the shape + the null branch.
    use toptopduck_lib::SourceSummary;
    assert_wire(
        &SourceSummary {
            first_source_name: Some("orders".into()),
            source_count: 3,
            turn_count: 5,
        },
        r#"{"first_source_name":"orders","source_count":3,"turn_count":5}"#,
    );
    assert_wire(
        &SourceSummary {
            first_source_name: None,
            source_count: 0,
            turn_count: 0,
        },
        r#"{"first_source_name":null,"source_count":0,"turn_count":0}"#,
    );
}

#[test]
fn session_metadata_serializes_flat_snake_case() {
    // ADR-0060/0061 (issue #76): SessionMetadata is the flat snake_case sidebar
    // entry. session_id is the .duck path (the stable identity). Pin the full
    // field order so a rename / reorder is caught before types.ts drifts.
    use toptopduck_lib::{SessionMetadata, SourceSummary};
    assert_wire(
        &SessionMetadata {
            session_id: "/x/analysis.duck".into(),
            display_name: "analysis".into(),
            last_modified_at: 1_700_000_000_000,
            source_summary: SourceSummary {
                first_source_name: Some("orders".into()),
                source_count: 1,
                turn_count: 2,
            },
            format_version: 1,
        },
        r#"{"session_id":"/x/analysis.duck","display_name":"analysis","last_modified_at":1700000000000,"source_summary":{"first_source_name":"orders","source_count":1,"turn_count":2},"format_version":1}"#,
    );
}

#[test]
fn profile_key_status_serializes_as_a_flat_object() {
    // ProfileKeyStatus (issue #153) crosses IPC as a flat object -- one entry
    // per profile in the list_provider_profiles return. Issue #275 adds the
    // `keychain_fault` field: null on a successful read (has_key authoritative),
    // a string detail when the OS keychain read itself failed. The shape
    // src/types/provider.ts mirrors: profile_id (opaque id), has_key (boolean),
    // keychain_fault (string | null). ADR-0029 -- never the key itself.
    use toptopduck_lib::ProfileKeyStatus;
    assert_wire(
        &ProfileKeyStatus {
            profile_id: "default".into(),
            has_key: true,
            keychain_fault: None,
        },
        r#"{"profile_id":"default","has_key":true,"keychain_fault":null}"#,
    );
    assert_wire(
        &ProfileKeyStatus {
            profile_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890".into(),
            has_key: false,
            keychain_fault: None,
        },
        r#"{"profile_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","has_key":false,"keychain_fault":null}"#,
    );
    // Issue #275: a keychain read fault rides keychain_fault (technical English
    // detail), with has_key as a placeholder false -- the status is unknown, not
    // empty, so the frontend renders "keychain unavailable" instead of "no key".
    assert_wire(
        &ProfileKeyStatus {
            profile_id: "default".into(),
            has_key: false,
            keychain_fault: Some("keychain access failed: The user canceled".into()),
        },
        r#"{"profile_id":"default","has_key":false,"keychain_fault":"keychain access failed: The user canceled"}"#,
    );
}

#[test]
fn provider_config_view_serializes_with_keychain_fault() {
    // ProviderConfigView (ADR-0029) crosses IPC as the get_provider_config +
    // set_provider_config return -- the active profile's effective base URL +
    // model plus its key status. Issue #275 adds `keychain_fault`: null on a
    // successful read (has_key authoritative), a string detail when the OS
    // keychain read itself failed. The shape src/types/provider.ts mirrors:
    // base_url, model, has_key (boolean), keychain_fault (string | null).
    // ADR-0029 -- never the key itself.
    use toptopduck_lib::ProviderConfigView;
    assert_wire(
        &ProviderConfigView {
            base_url: "https://api.anthropic.example".into(),
            model: "claude-sonnet-4".into(),
            has_key: true,
            keychain_fault: None,
        },
        r#"{"base_url":"https://api.anthropic.example","model":"claude-sonnet-4","has_key":true,"keychain_fault":null}"#,
    );
    assert_wire(
        &ProviderConfigView {
            base_url: "https://api.anthropic.example".into(),
            model: "claude-sonnet-4".into(),
            has_key: false,
            keychain_fault: None,
        },
        r#"{"base_url":"https://api.anthropic.example","model":"claude-sonnet-4","has_key":false,"keychain_fault":null}"#,
    );
    // Issue #275: a keychain read fault rides keychain_fault (technical English
    // detail), with has_key as a placeholder false -- the status is unknown, not
    // empty, so the header indicator renders "keychain unavailable" instead of
    // "no key configured".
    assert_wire(
        &ProviderConfigView {
            base_url: "https://api.anthropic.example".into(),
            model: "claude-sonnet-4".into(),
            has_key: false,
            keychain_fault: Some("keychain access failed: locked".into()),
        },
        r#"{"base_url":"https://api.anthropic.example","model":"claude-sonnet-4","has_key":false,"keychain_fault":"keychain access failed: locked"}"#,
    );
}

#[test]
fn profile_test_outcome_serializes_adjacently_tagged() {
    // ProfileTestOutcome (issue #236, ADR-0070) crosses IPC as the test_profile
    // return value. Adjacently-tagged like the other IPC enums: Ok nests the
    // models array under data (empty when only the ping fallback succeeded);
    // KeyRejected / EndpointUnreachable are unit variants (no data);
    // KeychainUnavailable (issue #243) / Incompatible carry the technical
    // detail string under data. Pin the wire shape src/types/provider.ts
    // mirrors so a serde drift fails here before the frontend narrows on
    // `kind`.
    use toptopduck_lib::ProfileTestOutcome;
    assert_wire(
        &ProfileTestOutcome::Ok {
            models: vec!["claude-sonnet-4-6".into(), "claude-haiku-4-5".into()],
        },
        r#"{"kind":"Ok","data":{"models":["claude-sonnet-4-6","claude-haiku-4-5"]}}"#,
    );
    assert_wire(
        &ProfileTestOutcome::Ok { models: vec![] },
        r#"{"kind":"Ok","data":{"models":[]}}"#,
    );
    assert_wire(
        &ProfileTestOutcome::KeyRejected,
        r#"{"kind":"KeyRejected"}"#,
    );
    assert_wire(
        &ProfileTestOutcome::KeychainUnavailable {
            detail: "keychain access failed: The user canceled".into(),
        },
        r#"{"kind":"KeychainUnavailable","data":{"detail":"keychain access failed: The user canceled"}}"#,
    );
    assert_wire(
        &ProfileTestOutcome::EndpointUnreachable,
        r#"{"kind":"EndpointUnreachable"}"#,
    );
    assert_wire(
        &ProfileTestOutcome::Incompatible {
            detail: "HTTP 502: bad gateway".into(),
        },
        r#"{"kind":"Incompatible","data":{"detail":"HTTP 502: bad gateway"}}"#,
    );
}
