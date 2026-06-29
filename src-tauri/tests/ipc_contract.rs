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
