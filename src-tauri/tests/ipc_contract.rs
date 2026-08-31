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
    DatasetDescriptor, DatasetPrivacy, GuidanceReason, GuidanceRequest, GuidanceSheet,
    GuidanceSheetState, LoadError, LoadOutcome, RectifyProvenance, SheetRectify,
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
fn guidance_sheet_carries_total_rows_and_state_wire_shape() {
    // Issues #750/#751: the pager drives off total_rows, and the per-sheet
    // two-state crosses adjacently tagged -- the failure reason (a plain
    // string, unit variants) for a deferred sheet, the detected header row
    // for a sheet the auto-tidy resolved (mirrored in src/types/dataset.ts).
    let failing = GuidanceSheet {
        name: "report".into(),
        preview: vec![vec!["a".into()]],
        total_rows: 1024,
        state: GuidanceSheetState::NeedsGuidance {
            reason: GuidanceReason::MultipleHeaderRows,
        },
    };
    assert_wire(
        &failing,
        r#"{"name":"report","preview":[["a"]],"total_rows":1024,"state":{"kind":"NeedsGuidance","data":{"reason":"MultipleHeaderRows"}}}"#,
    );
    let tidied = GuidanceSheet {
        name: "clean".into(),
        preview: vec![],
        total_rows: 3,
        state: GuidanceSheetState::AutoTidied { header_row: 2 },
    };
    assert_wire(
        &tidied,
        r#"{"name":"clean","preview":[],"total_rows":3,"state":{"kind":"AutoTidied","data":{"header_row":2}}}"#,
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
fn row_read_error_serializes_adjacently_tagged() {
    // RowReadError crosses IPC as a serde struct wrapped in SessionError::RowRead
    // (issue #121), no longer as its Display string. The hand-written Display is
    // Rust-log-only. Turn failures are TurnOutcome::Failed (ADR-0028); this type
    // now carries only the read_rows errors (UnknownDataset, Execute).
    use toptopduck_lib::RowReadError;
    assert_wire(
        &RowReadError::Execute("detail".into()),
        r#"{"kind":"Execute","data":"detail"}"#,
    );
    assert_wire(
        &RowReadError::UnknownDataset("result_1".into()),
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
fn skill_mount_error_serializes_adjacently_tagged() {
    // SkillMountError (issue #363, ADR-0086; issue #698, ADR-0110) crosses IPC
    // wrapped in SessionError::SkillMount. All variants are struct variants
    // carrying the offending skill name under data, so the frontend narrows on
    // `kind` and renders the shared `error.skillMount.*` locale message. Pin
    // the wire shape src/types/skills.ts mirrors so a serde drift fails here
    // before the frontend's isSkillMountError narrows on a stale contract.
    use toptopduck_lib::session::skills::SkillMountError;
    assert_wire(
        &SkillMountError::AlreadyMounted {
            name: "sql-coach".into(),
        },
        r#"{"kind":"AlreadyMounted","data":{"name":"sql-coach"}}"#,
    );
    assert_wire(
        &SkillMountError::NotMounted {
            name: "sql-coach".into(),
        },
        r#"{"kind":"NotMounted","data":{"name":"sql-coach"}}"#,
    );
    assert_wire(
        &SkillMountError::NotMountedForActivation {
            name: "sql-coach".into(),
        },
        r#"{"kind":"NotMountedForActivation","data":{"name":"sql-coach"}}"#,
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
    // + app config. OpenConflict / NoActiveProfile are unit variants (self-
    // contained user-correctable refusals); BlankName nests RenameSessionError
    // (the blank-name refusal matches rename_session's shape); the three
    // failure variants carry the English detail under data.
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
    assert_wire(
        &StoreCommandError::NoActiveProfile,
        r#"{"kind":"NoActiveProfile"}"#,
    );
    assert_wire(
        &StoreCommandError::UnknownAdapter("no-such-cli".into()),
        r#"{"kind":"UnknownAdapter","data":"no-such-cli"}"#,
    );
}

#[test]
fn skill_error_serializes_adjacently_tagged() {
    // SkillError (skills registry commands, issue #362) crosses IPC as the
    // reject of create_skill / update_skill / delete_skill. Every variant
    // carries the English detail under data; the kind set is disjoint from
    // every other typed error enum so the frontend dispatch stays unambiguous.
    use toptopduck_lib::SkillError;
    assert_wire(
        &SkillError::InvalidName("bad reason".into()),
        r#"{"kind":"InvalidName","data":"bad reason"}"#,
    );
    assert_wire(
        &SkillError::InvalidSkill("blank body".into()),
        r#"{"kind":"InvalidSkill","data":"blank body"}"#,
    );
    assert_wire(
        &SkillError::NoSuchSkill("ghost".into()),
        r#"{"kind":"NoSuchSkill","data":"ghost"}"#,
    );
    assert_wire(
        &SkillError::NameTaken("taken".into()),
        r#"{"kind":"NameTaken","data":"taken"}"#,
    );
    assert_wire(
        &SkillError::ReadOnly("external".into()),
        r#"{"kind":"ReadOnly","data":"external"}"#,
    );
    assert_wire(
        &SkillError::FsFailure("disk full".into()),
        r#"{"kind":"FsFailure","data":"disk full"}"#,
    );
}

#[test]
fn skill_entry_serializes_with_snake_case_acquired() {
    // SkillEntry (list_skills / the mutating commands' return, issue #362):
    // `acquired` is the only enum on the wire -- snake_case like every other
    // bare-variant field the frontend reads. Option fields ride JSON null,
    // Vec fields [] (the project's no-skip_serializing_if convention).
    use toptopduck_lib::{Acquired, SkillEntry};
    assert_wire(
        &SkillEntry {
            name: "pdf-tools".into(),
            description: "Work with PDF files.".into(),
            acquired: Acquired::Linked,
            license: None,
            compatibility: None,
            mcp_servers: vec!["github-mcp".into()],
            cli_tools: vec!["pandoc".into()],
            body: "Body.\n".into(),
            link_target: Some("/src/pdf-tools".into()),
            content_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        },
        r#"{"name":"pdf-tools","description":"Work with PDF files.","acquired":"linked","license":null,"compatibility":null,"mcp_servers":["github-mcp"],"cli_tools":["pandoc"],"body":"Body.\n","link_target":"/src/pdf-tools","content_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#,
    );
    assert_wire(
        &SkillEntry {
            name: "mine".into(),
            description: "Authored in-app.".into(),
            acquired: Acquired::Local,
            license: Some("MIT".into()),
            compatibility: Some("requires network".into()),
            mcp_servers: Vec::new(),
            cli_tools: Vec::new(),
            body: "Body.\n".into(),
            link_target: None,
            content_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        },
        r#"{"name":"mine","description":"Authored in-app.","acquired":"local","license":"MIT","compatibility":"requires network","mcp_servers":[],"cli_tools":[],"body":"Body.\n","link_target":null,"content_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}"#,
    );
}

#[test]
fn skipped_skill_serializes_as_a_flat_snake_case_object() {
    // SkippedSkill (issue #373): one row of the list_skills `ignored` fold.
    // Flat snake_case fields like every other wire struct -- `dir` (the
    // directory name, parallel to SkillEntry::name) + `reason` (the English
    // technical detail rendered verbatim). No tagging, no Option, no nesting;
    // the value strings are opaque to the wire layer.
    use toptopduck_lib::SkippedSkill;
    assert_wire(
        &SkippedSkill {
            dir: "mismatch-dir".into(),
            reason: "frontmatter name `other` does not match its directory name `mismatch-dir`"
                .into(),
        },
        r#"{"dir":"mismatch-dir","reason":"frontmatter name `other` does not match its directory name `mismatch-dir`"}"#,
    );
}

#[test]
fn skill_listing_wraps_skills_and_ignored() {
    // SkillListing (issue #373 / #375): the list_skills return is a flat
    // { skills, ignored, root_error } object -- `skills` keeps the SkillEntry
    // shape pinned above (sorted, the existing semantics), `ignored` carries
    // the spec-invalid directories, `root_error` carries the English technical
    // reason when the skills root itself could not be read (permission denied,
    // lock contention, etc.) -- `null` for the common case (root readable or
    // never created). Pin all three branches so a serde drift fails here before
    // the hand-mirrored types/skills.ts can drift.
    use toptopduck_lib::{Acquired, SkillEntry, SkillListing, SkippedSkill};
    assert_wire(
        &SkillListing {
            skills: Vec::new(),
            ignored: Vec::new(),
            root_error: None,
        },
        r#"{"skills":[],"ignored":[],"root_error":null}"#,
    );
    assert_wire(
        &SkillListing {
            skills: vec![SkillEntry {
                name: "pdf-tools".into(),
                description: "Work with PDF files.".into(),
                acquired: Acquired::Local,
                license: None,
                compatibility: None,
                mcp_servers: Vec::new(),
                cli_tools: Vec::new(),
                body: "Body.\n".into(),
                link_target: None,
                content_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .into(),
            }],
            ignored: vec![SkippedSkill {
                dir: "mismatch-dir".into(),
                reason: "frontmatter name `other` does not match its directory name `mismatch-dir`"
                    .into(),
            }],
            root_error: None,
        },
        r#"{"skills":[{"name":"pdf-tools","description":"Work with PDF files.","acquired":"local","license":null,"compatibility":null,"mcp_servers":[],"cli_tools":[],"body":"Body.\n","link_target":null,"content_hash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}],"ignored":[{"dir":"mismatch-dir","reason":"frontmatter name `other` does not match its directory name `mismatch-dir`"}],"root_error":null}"#,
    );
    assert_wire(
        &SkillListing {
            skills: Vec::new(),
            ignored: Vec::new(),
            root_error: Some(
                "read skills root `/locked` failed: Permission denied (os error 13)".into(),
            ),
        },
        r#"{"skills":[],"ignored":[],"root_error":"read skills root `/locked` failed: Permission denied (os error 13)"}"#,
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
    // A thread entry (ADR-0028/0039): a flat { question, outcome, trace }
    // object where outcome keeps its own adjacent tag. This is the Turn shape
    // a ThreadEntry wraps (see thread_entry_* below for the conversation()
    // wire shape). The trace is the collapsible execution substructure
    // (ADR-0078, issue #297) -- empty here; trace_entry_view_* pins the
    // entry shape.
    use toptopduck_lib::{TurnFailure, TurnOutcome, TurnProvenance, TurnRecord};
    assert_wire(
        &TurnRecord {
            question: "总行数？".into(),
            outcome: TurnOutcome::Failed(TurnFailure::NotWired),
            trace: vec![],
            provenance: TurnProvenance::default(),
            asked_at: None,
            settled_at: None,
        },
        r#"{"question":"总行数？","outcome":{"kind":"Failed","data":{"kind":"NotWired"}},"trace":[],"provenance":{"skills":[]}}"#,
    );
}

#[test]
fn turn_provenance_runtime_attribution_shapes() {
    // ADR-0101: the turn's executing runtime rides the provenance across
    // IPC -- adjacently-tagged (kind + data, snake_case) like every other
    // runtime choice on the wire. An external turn names its adapter id
    // under data; a pre-attribution external recording carries null (the
    // thread's honest "not recorded" degradation); a built-in turn is a
    // bare unit kind with no data key. Absent runtime (pre-extension peer /
    // optimistic append) serializes to the pre-#588 shape -- nothing breaks
    // either way across the boundary.
    use toptopduck_lib::{TurnProvenance, TurnRuntime};

    // External with the adapter id.
    assert_wire(
        &TurnProvenance {
            skills: vec![],
            runtime: Some(TurnRuntime::External {
                adapter_id: Some("gemini-cli".into()),
            }),
        },
        r#"{"skills":[],"runtime":{"kind":"external","data":{"adapter_id":"gemini-cli"}}}"#,
    );

    // External recorded before the adapter id existed: null, never omitted
    // -- the distinction between "external, unknown which" and "not recorded
    // at all" is the degradation the thread renders.
    assert_wire(
        &TurnProvenance {
            skills: vec![],
            runtime: Some(TurnRuntime::External { adapter_id: None }),
        },
        r#"{"skills":[],"runtime":{"kind":"external","data":{"adapter_id":null}}}"#,
    );

    // Built-in: a unit kind, no data key (mirrors SessionRuntimeChoice).
    assert_wire(
        &TurnProvenance {
            skills: vec![],
            runtime: Some(TurnRuntime::BuiltIn),
        },
        r#"{"skills":[],"runtime":{"kind":"built_in"}}"#,
    );

    // No attribution: byte-identical to the pre-#588 wire shape.
    assert_wire(
        &TurnProvenance {
            skills: vec![],
            runtime: None,
        },
        r#"{"skills":[]}"#,
    );

    // And the pre-#588 JSON (no runtime key) still deserializes -- an older
    // recorded payload reads back as no attribution.
    let back: TurnProvenance = serde_json::from_str(r#"{"skills":[]}"#).expect("deserialize");
    assert_eq!(back.runtime, None);
}

#[test]
fn trace_entry_view_is_a_flat_snake_case_object() {
    // ADR-0078 (issue #297): the display trace entry -- flat snake_case fields
    // like every other wire struct, operation_kind reusing the approval
    // gateway's snake_case enum (read / write / execute / network). The same
    // shape rides TurnRecord.trace AND the ToolCallCompleted progress event,
    // so pin it once here.
    use toptopduck_lib::{OperationKind, TraceEntryView};
    assert_wire(
        &TraceEntryView {
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT count(*) FROM orders".into(),
            success: false,
            result_excerpt: "no such table".into(),
        },
        r#"{"name":"explore","operation_kind":"read","summary":"SELECT count(*) FROM orders","success":false,"result_excerpt":"no such table"}"#,
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
    use toptopduck_lib::{ThreadEntry, TurnFailure, TurnOutcome, TurnProvenance, TurnRecord};
    assert_wire(
        &ThreadEntry::Turn(TurnRecord {
            question: "总行数？".into(),
            outcome: TurnOutcome::Failed(TurnFailure::StaleReference {
                reference_name: "result_1".into(),
            }),
            trace: vec![],
            provenance: TurnProvenance::default(),
            asked_at: None,
            settled_at: None,
        }),
        r#"{"entry":"Turn","data":{"question":"总行数？","outcome":{"kind":"Failed","data":{"kind":"StaleReference","data":{"reference_name":"result_1"}}},"trace":[],"provenance":{"skills":[]}}}"#,
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
fn thread_entry_skill_wraps_a_lifecycle_event_with_the_actor_mark() {
    // ADR-0086 (issue #363) / ADR-0110 (issue #698): the Skill entry wraps
    // the lifecycle event under `data`; `actor` rides inline in declaration
    // order -- explicit null on Mount / Unmount (the no-skip convention) and
    // the bare variant string on an Activate. Pin the exact shape
    // src/types/skills.ts mirrors as a REQUIRED `actor` field: a future
    // skip_serializing_if would silently make it optional on the wire and
    // break the TS mirror's non-optional contract. Both actor variants are
    // pinned: the Agent half has no construction site until #701, so only
    // this pin holds its serde spelling to the TS union.
    use toptopduck_lib::model::{
        SkillLifecycleActor, SkillLifecycleEvent, SkillLifecycleKind, ThreadEntry,
    };
    assert_wire(
        &ThreadEntry::Skill(SkillLifecycleEvent {
            kind: SkillLifecycleKind::Mount,
            name: "sql-coach".into(),
            actor: None,
        }),
        r#"{"entry":"Skill","data":{"kind":"Mount","name":"sql-coach","actor":null}}"#,
    );
    assert_wire(
        &ThreadEntry::Skill(SkillLifecycleEvent {
            kind: SkillLifecycleKind::Unmount,
            name: "sql-coach".into(),
            actor: None,
        }),
        r#"{"entry":"Skill","data":{"kind":"Unmount","name":"sql-coach","actor":null}}"#,
    );
    assert_wire(
        &ThreadEntry::Skill(SkillLifecycleEvent {
            kind: SkillLifecycleKind::Activate,
            name: "sql-coach".into(),
            actor: Some(SkillLifecycleActor::User),
        }),
        r#"{"entry":"Skill","data":{"kind":"Activate","name":"sql-coach","actor":"User"}}"#,
    );
    assert_wire(
        &ThreadEntry::Skill(SkillLifecycleEvent {
            kind: SkillLifecycleKind::Activate,
            name: "sql-coach".into(),
            actor: Some(SkillLifecycleActor::Agent),
        }),
        r#"{"entry":"Skill","data":{"kind":"Activate","name":"sql-coach","actor":"Agent"}}"#,
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
    use toptopduck_lib::{RemoveSourceError, RenameError, RenameSessionError, RowReadError};
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
        &SessionError::RowRead(RowReadError::Execute("detail".into())),
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
fn turn_phase_serializes_externally_tagged() {
    // ADR-0059 (issue #76), calibrated by ADR-0078 (issue #297): TurnPhase
    // crosses IPC externally-tagged (`{"Thinking":{"attempt":1}}`), mirroring
    // the sibling ResumeEvent shape. The Thinking/Querying phase pair evolved
    // into the tool-call event stream -- Thinking survives (the LLM wait),
    // ToolCallStarted / ToolCallCompleted replace Querying, and the completed
    // payload wraps the TraceEntryView verbatim. The frontend narrows on the
    // variant discriminator; pin every tag so a serde rename / tag-style
    // change fails here.
    use toptopduck_lib::{OperationKind, TraceEntryView, TurnPhase};
    assert_wire(
        &TurnPhase::Thinking { attempt: 1 },
        r#"{"Thinking":{"attempt":1}}"#,
    );
    assert_wire(
        &TurnPhase::ToolCallStarted {
            name: "materialize".into(),
            operation_kind: OperationKind::Write,
            summary: "SELECT 1".into(),
        },
        r#"{"ToolCallStarted":{"name":"materialize","operation_kind":"write","summary":"SELECT 1"}}"#,
    );
    assert_wire(
        &TurnPhase::ToolCallCompleted(TraceEntryView {
            name: "materialize".into(),
            operation_kind: OperationKind::Write,
            summary: "SELECT 1".into(),
            success: true,
            result_excerpt: String::new(),
        }),
        r#"{"ToolCallCompleted":{"name":"materialize","operation_kind":"write","summary":"SELECT 1","success":true,"result_excerpt":""}}"#,
    );
    // ADR-0103 (issue #608): the round-content variants. RoundText carries
    // the round's connective prose; ThinkingCompleted carries the thinking
    // block's duration + raw text. Same externally-tagged shape as the rest.
    assert_wire(
        &TurnPhase::RoundText {
            text: "先看一眼数据。".into(),
        },
        r#"{"RoundText":{"text":"先看一眼数据。"}}"#,
    );
    assert_wire(
        &TurnPhase::ThinkingCompleted {
            duration_ms: 1200,
            text: "thinking through the schema".into(),
        },
        r#"{"ThinkingCompleted":{"duration_ms":1200,"text":"thinking through the schema"}}"#,
    );
}

#[test]
fn turn_record_carries_round_grouped_trace_and_timestamps() {
    // ADR-0103 (issue #608): TurnRecord.trace is round-grouped -- each round
    // an optional thinking block + optional prose + its calls -- and the
    // record carries optional asked_at / settled_at (omitted when absent, so
    // a pre-v5 turn honest-degrades on the wire with no synthetic values).
    use toptopduck_lib::{
        OperationKind, ThinkingTrace, TraceEntryView, TraceRound, TurnFailure, TurnOutcome,
        TurnProvenance, TurnRecord,
    };
    let round = TraceRound {
        thinking: Some(ThinkingTrace {
            duration_ms: 900,
            text: "reasoning".into(),
        }),
        text: Some("先看一眼数据。".into()),
        calls: vec![TraceEntryView {
            name: "explore".into(),
            operation_kind: OperationKind::Read,
            summary: "SELECT 1".into(),
            success: true,
            result_excerpt: String::new(),
        }],
    };
    let record = TurnRecord {
        question: "多少人".into(),
        outcome: TurnOutcome::Failed(TurnFailure::NotWired),
        trace: vec![round],
        provenance: TurnProvenance::default(),
        asked_at: Some(1_700_000_000_000),
        settled_at: Some(1_700_000_002_400),
    };
    assert_wire(
        &record,
        r#"{"question":"多少人","outcome":{"kind":"Failed","data":{"kind":"NotWired"}},"trace":[{"thinking":{"duration_ms":900,"text":"reasoning"},"text":"先看一眼数据。","calls":[{"name":"explore","operation_kind":"read","summary":"SELECT 1","success":true,"result_excerpt":""}]}],"provenance":{"skills":[]},"asked_at":1700000000000,"settled_at":1700000002400}"#,
    );
    // The absent-timestamp form: no asked_at / settled_at keys on the wire.
    let mut old = record.clone();
    old.asked_at = None;
    old.settled_at = None;
    let json = serde_json::to_string(&old).expect("serialize");
    assert!(
        !json.contains("asked_at"),
        "absent asked_at is omitted: {json}"
    );
    assert!(
        !json.contains("settled_at"),
        "absent settled_at is omitted: {json}"
    );
}

#[test]
fn turn_progress_wraps_phase_with_session_id() {
    // ADR-0056/0059 (issue #76): a turn-progress event is { session_id, phase }
    // -- the addressing id lets a multi-session frontend filter the global
    // broadcast; phase keeps its own externally-tagged shape. Pin the wrapper
    // so a field rename on either side is caught before types.ts drifts.
    // Issue #462: session_id is a typed SessionId (transparent serde over a
    // UUID v4 string -- the wire format stays a bare string).
    use toptopduck_lib::{SessionId, TurnPhase, TurnProgress};
    const SID: &str = "550e8400-e29b-41d4-a716-446655440000";
    assert_wire(
        &TurnProgress {
            session_id: SessionId::parse(SID).expect("valid v4 UUID"),
            phase: TurnPhase::Thinking { attempt: 1 },
        },
        r#"{"session_id":"550e8400-e29b-41d4-a716-446655440000","phase":{"Thinking":{"attempt":1}}}"#,
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
    // Issue #462: session_id is a typed SessionId (transparent serde).
    use toptopduck_lib::{ResumeEvent, ResumeProgress, SessionId};
    const SID: &str = "550e8400-e29b-41d4-a716-446655440000";
    assert_wire(
        &ResumeProgress {
            session_id: SessionId::parse(SID).expect("valid v4 UUID"),
            event: ResumeEvent::Replay {
                index: 1,
                total: 2,
                reference_name: "result_1".into(),
            },
        },
        r#"{"session_id":"550e8400-e29b-41d4-a716-446655440000","event":{"Replay":{"index":1,"total":2,"reference_name":"result_1"}}}"#,
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
    // entry. duck_path is the .duck path (the stable identity, renamed from
    // session_id in issue #462 to disambiguate from the runtime UUID). Pin the
    // full field order so a rename / reorder is caught before types.ts drifts.
    use toptopduck_lib::{DuckPath, SessionMetadata, SourceSummary};
    assert_wire(
        &SessionMetadata {
            duck_path: DuckPath::new("/x/analysis.duck"),
            display_name: "analysis".into(),
            last_modified_at: 1_700_000_000_000,
            source_summary: SourceSummary {
                first_source_name: Some("orders".into()),
                source_count: 1,
                turn_count: 2,
            },
            format_version: 1,
        },
        r#"{"duck_path":"/x/analysis.duck","display_name":"analysis","last_modified_at":1700000000000,"source_summary":{"first_source_name":"orders","source_count":1,"turn_count":2},"format_version":1}"#,
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
    // set_provider_config return -- the active profile's base URL + model plus
    // its key status. Issue #275 adds `keychain_fault`: null on a successful
    // read (has_key authoritative), a string detail when the OS keychain read
    // itself failed. ADR-0098 (issue #568) makes base_url / model nullable:
    // null when no profile is active (the zero-profile state) -- the honest
    // empty state, not canonical defaults masquerading as a value. The shape
    // src/types/provider.ts mirrors: base_url (string | null), model
    // (string | null), has_key (boolean), keychain_fault (string | null).
    // ADR-0029 -- never the key itself.
    use toptopduck_lib::ProviderConfigView;
    assert_wire(
        &ProviderConfigView {
            base_url: Some("https://api.anthropic.example".into()),
            model: Some("claude-sonnet-4".into()),
            has_key: true,
            keychain_fault: None,
        },
        r#"{"base_url":"https://api.anthropic.example","model":"claude-sonnet-4","has_key":true,"keychain_fault":null}"#,
    );
    assert_wire(
        &ProviderConfigView {
            base_url: Some("https://api.anthropic.example".into()),
            model: Some("claude-sonnet-4".into()),
            has_key: false,
            keychain_fault: None,
        },
        r#"{"base_url":"https://api.anthropic.example","model":"claude-sonnet-4","has_key":false,"keychain_fault":null}"#,
    );
    // ADR-0098: the zero-profile state -- null endpoints, no key (no slot to
    // read), no fault. The frontend reads this as "not configured", never as
    // a configured default endpoint.
    assert_wire(
        &ProviderConfigView {
            base_url: None,
            model: None,
            has_key: false,
            keychain_fault: None,
        },
        r#"{"base_url":null,"model":null,"has_key":false,"keychain_fault":null}"#,
    );
    // Issue #275: a keychain read fault rides keychain_fault (technical English
    // detail), with has_key as a placeholder false -- the status is unknown, not
    // empty, so the header indicator renders "keychain unavailable" instead of
    // "no key configured".
    assert_wire(
        &ProviderConfigView {
            base_url: Some("https://api.anthropic.example".into()),
            model: Some("claude-sonnet-4".into()),
            has_key: false,
            keychain_fault: Some("keychain access failed: locked".into()),
        },
        r#"{"base_url":"https://api.anthropic.example","model":"claude-sonnet-4","has_key":false,"keychain_fault":"keychain access failed: locked"}"#,
    );
}

#[test]
fn provider_config_serializes_the_nullable_active_pointer() {
    // ProviderConfig crosses IPC as the set_provider_config INPUT and rides
    // inside get_app_config's return. ADR-0098 (issue #568): active_profile is
    // nullable -- the zero-profile state (empty list + null pointer) is a
    // legal payload, and a stored id string parses back into Some (pre-0098
    // files keep their skeleton verbatim). src/types/provider.ts mirrors the
    // `string | null` union.
    use toptopduck_lib::{ProfileId, ProviderConfig, ProviderProfile};
    let zero = ProviderConfig {
        profiles: Vec::new(),
        active_profile: None,
    };
    assert_wire(&zero, r#"{"profiles":[],"active_profile":null}"#);
    let seeded = ProviderConfig {
        profiles: vec![ProviderProfile::default_anthropic()],
        active_profile: Some(ProfileId("default".into())),
    };
    assert_wire(
        &seeded,
        r#"{"profiles":[{"id":"default","display_name":"Anthropic","protocol":"anthropic","base_url":"https://api.anthropic.com","model":"claude-sonnet-4-6"}],"active_profile":"default"}"#,
    );
}

#[test]
fn profile_test_outcome_serializes_adjacently_tagged() {
    // ProfileTestOutcome (issue #236, ADR-0070) crosses IPC as the test_profile
    // return value. Adjacently-tagged like the other IPC enums: Ok nests the
    // models array under data (empty when only the ping fallback succeeded);
    // KeyRejected / EndpointUnreachable are unit variants (no data);
    // KeychainUnavailable (issue #243) / InvalidEndpoint (issue #279) /
    // Incompatible carry the technical detail string under data. Pin the wire
    // shape src/types/provider.ts mirrors so a serde drift fails here before
    // the frontend narrows on `kind`.
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
        &ProfileTestOutcome::InvalidEndpoint {
            detail: "invalid base_url: scheme `file` is not http/https".into(),
        },
        r#"{"kind":"InvalidEndpoint","data":{"detail":"invalid base_url: scheme `file` is not http/https"}}"#,
    );
    assert_wire(
        &ProfileTestOutcome::Incompatible {
            detail: "HTTP 502: bad gateway".into(),
        },
        r#"{"kind":"Incompatible","data":{"detail":"HTTP 502: bad gateway"}}"#,
    );
}

/// The session runtime choice (issue #353) is `tag="kind", content="data"`
/// with `rename_all="snake_case"`: the built-in default serializes as a bare
/// `{"kind":"built_in"}` (no content key for a unit variant), and an external
/// adapter carries its id under `data` (the repo's generic content key, shared
/// with every other tagged enum). `src/types/runtime.ts` mirrors these
/// literals; pin them so a serde attribute change fails before the hand-mirror
/// can drift.
#[test]
fn session_runtime_choice_wire_shape() {
    use toptopduck_lib::commands::SessionRuntimeChoice;
    assert_wire(&SessionRuntimeChoice::BuiltIn, r#"{"kind":"built_in"}"#);
    assert_wire(
        &SessionRuntimeChoice::External("gemini-cli".into()),
        r#"{"kind":"external","data":"gemini-cli"}"#,
    );
}

/// The app-config default runtime (issue #569, ADR-0098 Decision 2) crosses
/// IPC / persists with the SAME adjacently-tagged shape as
/// `SessionRuntimeChoice` -- one frontend type shape serves both the
/// per-session choice and the machine-level preference. Pin the literals so
/// a serde attribute change on either type fails before the hand-mirror in
/// `src/types/app-config.ts` can drift.
#[test]
fn default_runtime_wire_shape() {
    use toptopduck_lib::app_config::DefaultRuntime;
    assert_wire(&DefaultRuntime::BuiltIn, r#"{"kind":"built_in"}"#);
    assert_wire(
        &DefaultRuntime::External("gemini-cli".into()),
        r#"{"kind":"external","data":"gemini-cli"}"#,
    );
}

/// ModelPosture (ADR-0100, issue #581) crosses IPC as the return of
/// `get_last_model_posture` and nested inside `AppConfig.last_model_postures`
/// (returned by `clear_last_model_posture` / `get_app_config` /
/// `set_app_config`) -- flat snake_case, both fields Option, the shape
/// `src/types/app-config.ts` mirrors. Pin the set form and the cleared /
/// absent form (all-null: the "default (recommended)" unselected start) so a
/// serde attribute change fails before the hand-mirror drifts.
#[test]
fn model_posture_wire_shape() {
    use toptopduck_lib::app_config::ModelPosture;
    assert_wire(
        &ModelPosture {
            model: Some("gemini-2.5-pro".into()),
            thought_level: Some("high".into()),
        },
        r#"{"model":"gemini-2.5-pro","thought_level":"high"}"#,
    );
    assert_wire(
        &ModelPosture::default(),
        r#"{"model":null,"thought_level":null}"#,
    );
}

/// `AppConfig.last_model_postures` serializes ALWAYS (no
/// `skip_serializing_if`): the frontend mirror declares the field required,
/// and an absent key would read as `undefined` through the hand-mirror. Pin
/// the empty-map form on defaults.
#[test]
fn app_config_always_serializes_last_model_postures() {
    use toptopduck_lib::app_config::AppConfig;
    let value = serde_json::to_value(AppConfig::defaults()).expect("serialize");
    assert_eq!(
        value["last_model_postures"],
        serde_json::json!({}),
        "the map key is always present, empty by default"
    );
}

/// AdapterEntry (issue #353/#489, ADR-0083) crosses IPC as a flat snake_case
/// struct -- the shape `src/types/runtime.ts` mirrors. `binary_path` rides
/// `Option<PathBuf>` (a JSON string when Some, null when None) with
/// `#[serde(default)]` so an older payload omitting the field deserializes to
/// None. Pin both forms (detected + undetected) so a serde attribute change
/// fails here before the hand-mirror can drift.
#[test]
fn adapter_entry_wire_shape() {
    use std::path::PathBuf;
    use toptopduck_lib::commands::AdapterEntry;
    use toptopduck_lib::runtime::acp::adapter::StreamFormat;
    assert_wire(
        &AdapterEntry {
            id: "gemini-cli".into(),
            display_name: "gemini-cli".into(),
            detected: true,
            binary_path: Some(PathBuf::from("/usr/local/bin/gemini")),
            stream_format: StreamFormat::Acp,
        },
        r#"{"id":"gemini-cli","display_name":"gemini-cli","detected":true,"binary_path":"/usr/local/bin/gemini","stream_format":"acp"}"#,
    );
    assert_wire(
        &AdapterEntry {
            id: "codex".into(),
            display_name: "codex".into(),
            detected: false,
            binary_path: None,
            stream_format: StreamFormat::CodexEventStream,
        },
        r#"{"id":"codex","display_name":"codex","detected":false,"binary_path":null,"stream_format":"codex_event_stream"}"#,
    );
    // ADR-0097: the third format tag the frontend's per-format dispatch
    // narrows on (the rename retired the `json_event_stream` tag -- old
    // payloads carrying it degrade per entry, never to this value).
    assert_wire(
        &AdapterEntry {
            id: "claude-code".into(),
            display_name: "claude-code".into(),
            detected: true,
            binary_path: Some(PathBuf::from("/usr/local/bin/claude")),
            stream_format: StreamFormat::ClaudeStreamJson,
        },
        r#"{"id":"claude-code","display_name":"claude-code","detected":true,"binary_path":"/usr/local/bin/claude","stream_format":"claude_stream_json"}"#,
    );
}

/// SessionModelConfig (ADR-0095, issue #527) crosses IPC as a flat snake_case
/// struct -- the shape `src/types/runtime.ts` mirrors. The None forms pin the
/// "no selection / no discovery yet" honest defaults; the Some form pins the
/// nested DiscoveredRuntime shape (snake_case fields, also the persisted
/// recipe header shape).
#[test]
fn session_model_config_wire_shape() {
    use toptopduck_lib::commands::SessionModelConfig;
    use toptopduck_lib::session::loop_contract::DiscoveredRuntime;
    assert_wire(
        &SessionModelConfig {
            model: None,
            thought_level: None,
            cached_discovered: None,
        },
        r#"{"model":null,"thought_level":null,"cached_discovered":null}"#,
    );
    assert_wire(
        &SessionModelConfig {
            model: Some("fake-opus".into()),
            thought_level: Some("high".into()),
            cached_discovered: Some(DiscoveredRuntime {
                models: vec!["fake-opus".into(), "fake-sonnet".into()],
                current_model: Some("fake-opus".into()),
                thought_levels: vec!["low".into()],
                current_thought_level: None,
                model_config_id: Some("model".into()),
                thought_level_config_id: Some("reasoning_effort".into()),
                adapter_id: Some("gemini-cli".into()),
            }),
        },
        r#"{"model":"fake-opus","thought_level":"high","cached_discovered":{"models":["fake-opus","fake-sonnet"],"current_model":"fake-opus","thought_levels":["low"],"current_thought_level":null,"model_config_id":"model","thought_level_config_id":"reasoning_effort","adapter_id":"gemini-cli"}}"#,
    );
}

/// Issue #606: the set command's posture pair crosses IPC as ONE struct
/// argument (`PosturePair`) -- flat snake_case, the exact object the
/// frontend `ModelPosture` mirror hands to `invoke` verbatim (the wrapper
/// does no key translation). Pin the input wire shape so serde attribute
/// or key-set drift fails here, not at the boundary.
#[test]
fn set_session_posture_input_wire_shape() {
    use toptopduck_lib::session::PosturePair;
    assert_wire(
        &PosturePair {
            model: Some("gemini-2.5-pro".into()),
            thought_level: Some("high".into()),
        },
        r#"{"model":"gemini-2.5-pro","thought_level":"high"}"#,
    );
    // The cleared / unselected form (both null) is the same explicit-wire
    // value the picker sends for "default (recommended)".
    assert_wire(
        &PosturePair::default(),
        r#"{"model":null,"thought_level":null}"#,
    );
    // The wire keys ARE the field names: a camelCase payload (the pre-#606
    // flattened-arg shape) must not deserialize -- the snake_case
    // hand-mirror in `src/types/app-config.ts` is the required form.
    assert!(
        serde_json::from_str::<PosturePair>(r#"{"model":"x","thoughtLevel":"y"}"#).is_err(),
        "camelCase keys must not cross the boundary"
    );
}

/// Issue #529: the set command's persist-now verdict rides the command
/// RETURN (in-process, read before the session lock drops) instead of a
/// post-hoc shared-slot read -- pin the wire shape.
#[test]
fn set_posture_persist_outcome_wire_shape() {
    use toptopduck_lib::commands::SetPosturePersistOutcome;
    use toptopduck_lib::persistence::SaveError;
    assert_wire(
        &SetPosturePersistOutcome {
            persist_error: None,
            persist_suspended: false,
        },
        r#"{"persist_error":null,"persist_suspended":false}"#,
    );
    assert_wire(
        &SetPosturePersistOutcome {
            persist_error: Some(SaveError::Io("disk full".into())),
            persist_suspended: false,
        },
        r#"{"persist_error":{"kind":"Io","data":"disk full"},"persist_suspended":false}"#,
    );
    assert_wire(
        &SetPosturePersistOutcome {
            persist_error: None,
            persist_suspended: true,
        },
        r#"{"persist_error":null,"persist_suspended":true}"#,
    );
}

/// Serialize-only counterpart of [`assert_wire`]: pin the outbound IPC shape
/// of a type that never deserializes back (the probe success payload flows
/// Rust -> frontend only, so `ProbeOk` derives Serialize alone).
fn assert_wire_out<T>(value: &T, expected: &str)
where
    T: serde::Serialize + std::fmt::Debug,
{
    let json = serde_json::to_string(value).expect("serialize");
    assert_eq!(json, expected, "wire format drifted from pinned contract");
}

/// ProbeOk (ADR-0096, issues #534/#535; ADR-0097) crosses IPC
/// adjacently-tagged (`tag="kind", content="data"`,
/// `rename_all="snake_case"`): the ACP variant carries the flat
/// `DiscoveredRuntime` under `data.discovered`, the two per-model variants
/// (codex / claude) carry the `ModelCatalogOutcome` under `data.outcome`
/// (whose own inner tag is `status`). `src/types/runtime.ts` hand-mirrors
/// these shapes; pin them so a serde attribute change fails here before the
/// hand-mirror can drift (the ProbeError side is pinned by the frontend's
/// kind allowlist, but the success shape has no other guard).
#[test]
fn probe_ok_wire_shape() {
    use toptopduck_lib::runtime::acp::probe::{CatalogModel, ModelCatalogOutcome, ProbeOk};
    use toptopduck_lib::session::loop_contract::DiscoveredRuntime;
    assert_wire_out(
        &ProbeOk::Acp {
            discovered: DiscoveredRuntime {
                models: vec!["fake-opus".into()],
                current_model: Some("fake-opus".into()),
                thought_levels: vec!["low".into(), "high".into()],
                current_thought_level: None,
                model_config_id: Some("model".into()),
                thought_level_config_id: None,
                adapter_id: Some("gemini-cli".into()),
            },
        },
        r#"{"kind":"acp","data":{"discovered":{"models":["fake-opus"],"current_model":"fake-opus","thought_levels":["low","high"],"current_thought_level":null,"model_config_id":"model","adapter_id":"gemini-cli"}}}"#,
    );
    assert_wire_out(
        &ProbeOk::CodexEventStream {
            outcome: ModelCatalogOutcome::Available {
                models: vec![CatalogModel {
                    id: "gpt-5.2-codex".into(),
                    display_name: "GPT-5.2 Codex".into(),
                    is_default: true,
                    default_reasoning_effort: "medium".into(),
                    supported_reasoning_efforts: vec!["low".into(), "medium".into()],
                }],
            },
        },
        r#"{"kind":"codex_event_stream","data":{"outcome":{"status":"available","models":[{"id":"gpt-5.2-codex","display_name":"GPT-5.2 Codex","is_default":true,"default_reasoning_effort":"medium","supported_reasoning_efforts":["low","medium"]}]}}}"#,
    );
    assert_wire_out(
        &ProbeOk::CodexEventStream {
            outcome: ModelCatalogOutcome::Unavailable {
                detail: "model/list error: not logged in".into(),
            },
        },
        r#"{"kind":"codex_event_stream","data":{"outcome":{"status":"unavailable","detail":"model/list error: not logged in"}}}"#,
    );
    // ADR-0097: the claude-code control-plane catalog rides the SAME
    // per-model outcome shape under its own kind tag.
    assert_wire_out(
        &ProbeOk::ClaudeStreamJson {
            outcome: ModelCatalogOutcome::Available {
                models: vec![CatalogModel {
                    id: "claude-sonnet-4".into(),
                    display_name: "Claude Sonnet 4".into(),
                    is_default: true,
                    default_reasoning_effort: "medium".into(),
                    supported_reasoning_efforts: vec!["low".into(), "medium".into(), "high".into()],
                }],
            },
        },
        r#"{"kind":"claude_stream_json","data":{"outcome":{"status":"available","models":[{"id":"claude-sonnet-4","display_name":"Claude Sonnet 4","is_default":true,"default_reasoning_effort":"medium","supported_reasoning_efforts":["low","medium","high"]}]}}}"#,
    );
}

/// `ProbeError` crosses IPC adjacently-tagged like `ProbeOk` (issue #543):
/// the three detail-carrying kinds ride `data` as a bare string, `Timeout` is
/// a unit variant with no `data` key. `src/types/runtime.ts` dispatches on
/// these kinds -- pin all four so a serde attribute change fails here before
/// the frontend's kind allowlist can drift. The kinds are PascalCase (no rename_all attribute), matching the four-kind union in the frontend mirror.
#[test]
fn probe_error_wire_shape() {
    use toptopduck_lib::runtime::acp::probe::ProbeError;
    assert_wire(
        &ProbeError::NotDetected("codex".into()),
        r#"{"kind":"NotDetected","data":"codex"}"#,
    );
    assert_wire(
        &ProbeError::SpawnFailure("failed to spawn CLI `codex`".into()),
        r#"{"kind":"SpawnFailure","data":"failed to spawn CLI `codex`"}"#,
    );
    assert_wire(
        &ProbeError::HandshakeFailure("codex app-server closed stdout".into()),
        r#"{"kind":"HandshakeFailure","data":"codex app-server closed stdout"}"#,
    );
    assert_wire(&ProbeError::Timeout, r#"{"kind":"Timeout"}"#);
}

/// The builtin scan snapshot rows (issue #683, ADR-0109 Decision 3) cross
/// IPC as an INTERNALLY-tagged enum (`tag = "state"`, snake_case variants)
/// -- unlike every other shape pinned in this file there is no `data`
/// content key: the tag rides beside the row's own fields, so `Detected`
/// carries `executable` by construction and the dormant/conflict literals
/// pin that the other variants cannot. The type is Serialize-only (a
/// computed snapshot, never read back), so the round-trip half of
/// `assert_wire` does not apply -- the literal is the pin.
/// `src/types/cli-tool.ts` mirrors the union; pin it so a serde attribute
/// change fails before the hand-mirror can drift.
#[test]
fn builtin_scan_entry_wire_shape() {
    use toptopduck_lib::cli_tools::builtin::BuiltinScanEntry;
    let assert_shape = |value: &BuiltinScanEntry, expected: &str| {
        assert_eq!(
            serde_json::to_string(value).expect("serialize"),
            expected,
            "wire format drifted from pinned contract"
        );
    };
    assert_shape(
        &BuiltinScanEntry::Detected {
            name: "pandoc".into(),
            description: "Converts documents".into(),
            executable: "pandoc".into(),
        },
        r#"{"state":"detected","name":"pandoc","description":"Converts documents","executable":"pandoc"}"#,
    );
    assert_shape(
        &BuiltinScanEntry::Dormant {
            name: "pandoc".into(),
            description: "Converts documents".into(),
        },
        r#"{"state":"dormant","name":"pandoc","description":"Converts documents"}"#,
    );
    assert_shape(
        &BuiltinScanEntry::Conflict {
            name: "pandoc".into(),
            description: "Converts documents".into(),
        },
        r#"{"state":"conflict","name":"pandoc","description":"Converts documents"}"#,
    );
}
