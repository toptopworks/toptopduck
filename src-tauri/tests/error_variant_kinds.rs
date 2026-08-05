//! Cross-boundary variant-kind snapshot for the typed IPC error enums
//! (issue #128).
//!
//! Every error enum here crosses the Rust<->frontend IPC boundary
//! adjacently-tagged (`#[serde(tag = "kind", content = "data")]`) with no
//! `rename_all` -- a future rename would surface in tests/ipc_contract.rs's
//! per-variant wire-shape pin -- and the frontend renders each variant's
//! `kind` through a locale-catalog id. This test serializes one instance of
//! EVERY variant of EVERY error enum to recover the wire `kind` from the
//! compiler truth (zero parse drift -- no ast-grep / tree-sitter guesswork),
//! and pins the resulting `{enum: [kinds]}` map to a golden JSON file the
//! frontend vitest guard consumes (see the cross-section comment in that test).
//!
//! Adding a Rust variant forces this test to construct it (compile error until
//! you do) and regenerates the golden file; the frontend test then demands a
//! matching contract entry + catalog id. This closes the gap where a new
//! backend variant shipped without its frontend catalog id -- the existing TS
//! `never` exhaustiveness guards only fire once the hand-mirrored
//! `src/types.ts` is updated, and the catalog-id naming convention had no CI
//! enforcement. Complements tests/ipc_contract.rs (which pins each variant's
//! full wire shape one literal at a time) by pinning the COMPLETE variant set
//! across all error enums at once.
//!
//! Regenerate the golden file:
//!   `UPDATE_ERROR_VARIANT_KINDS=1 cargo test --test error_variant_kinds`

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use toptopduck_lib::{
    DuckLoadError, MigrationError, RemoveSourceError, RenameError, RenameSessionError, ResumeError,
    SaveError, SessionError, SkillError, StoreCommandError, TurnError, TurnFailure,
};

/// Read the serde wire `kind` tag off one instance. Every enum here is
/// `#[serde(tag = "kind", content = "data")]`, so `kind` is always a string.
fn kind_of<T: serde::Serialize>(value: &T) -> String {
    let v = serde_json::to_value(value).expect("variant serializes");
    v.get("kind")
        .and_then(|k| k.as_str())
        .expect("tagged enum carries a string `kind`")
        .to_string()
}

/// Map a list of variant instances to their wire `kind` strings.
fn to_kinds<T: serde::Serialize>(values: &[T]) -> Vec<String> {
    values.iter().map(kind_of).collect()
}

// One instance of every variant, grouped by enum. Only the `kind` tag is read,
// so the carried data is a minimal placeholder; each line still exercises that
// variant's serializer (a shape change to a variant surfaces here too).

fn turn_failure() -> Vec<TurnFailure> {
    vec![
        TurnFailure::Execute {
            detail: String::new(),
        },
        TurnFailure::Resource {
            detail: String::new(),
        },
        TurnFailure::NotWired,
        TurnFailure::InvalidConfig {
            detail: String::new(),
        },
        TurnFailure::StaleReference {
            reference_name: String::new(),
        },
    ]
}

fn session_error() -> Vec<SessionError> {
    vec![
        SessionError::InvalidId,
        SessionError::NotFound,
        SessionError::Resuming,
        SessionError::InFlight,
        SessionError::Resume(ResumeError::Cancelled),
        SessionError::RemoveSource(RemoveSourceError::NotFound(String::new())),
        SessionError::RenameDataset(RenameError::InvalidLabel),
        SessionError::RenameSession(RenameSessionError::EmptyName),
        SessionError::Turn(TurnError::UnknownDataset(String::new())),
        SessionError::Engine(String::new()),
    ]
}

fn remove_source_error() -> Vec<RemoveSourceError> {
    vec![
        RemoveSourceError::NotFound(String::new()),
        RemoveSourceError::IsActive {
            reference_name: String::new(),
            display_name: String::new(),
        },
        RemoveSourceError::NotActive(String::new()),
        RemoveSourceError::InvalidContinueWith(String::new()),
    ]
}

fn rename_error() -> Vec<RenameError> {
    vec![
        RenameError::NotFound(String::new()),
        RenameError::DisplayTaken(String::new()),
        RenameError::InvalidLabel,
    ]
}

fn turn_error() -> Vec<TurnError> {
    vec![
        TurnError::UnknownDataset(String::new()),
        TurnError::Execute(String::new()),
    ]
}

fn resume_error() -> Vec<ResumeError> {
    vec![
        ResumeError::Load(DuckLoadError::Io(String::new())),
        ResumeError::SourceMissing {
            reference_name: String::new(),
            path: String::new(),
            detail: String::new(),
        },
        ResumeError::Replay {
            reference_name: String::new(),
            detail: String::new(),
        },
        ResumeError::ActiveMissing(String::new()),
        ResumeError::Cancelled,
        ResumeError::Aborted,
        ResumeError::AlreadyOpen(PathBuf::new()),
    ]
}

fn duck_load_error() -> Vec<DuckLoadError> {
    vec![
        DuckLoadError::Io(String::new()),
        DuckLoadError::Parse(String::new()),
        DuckLoadError::VersionMismatch {
            found: 0,
            supported: 0,
        },
        DuckLoadError::Migration(MigrationError::Field(String::new())),
    ]
}

fn save_error() -> Vec<SaveError> {
    vec![
        SaveError::Serialize(String::new()),
        SaveError::Io(String::new()),
        SaveError::Rename(String::new()),
        SaveError::AlreadyOpen(PathBuf::new()),
    ]
}

fn store_command_error() -> Vec<StoreCommandError> {
    vec![
        StoreCommandError::OpenConflict,
        StoreCommandError::BlankName(RenameSessionError::EmptyName),
        StoreCommandError::IoFailure(String::new()),
        StoreCommandError::KeychainFailure(String::new()),
        StoreCommandError::ConfigWriteFailure(String::new()),
    ]
}

fn skill_error() -> Vec<SkillError> {
    vec![
        SkillError::InvalidName(String::new()),
        SkillError::InvalidSkill(String::new()),
        SkillError::NoSuchSkill(String::new()),
        SkillError::NameTaken(String::new()),
        SkillError::ReadOnly(String::new()),
        SkillError::FsFailure(String::new()),
    ]
}

fn rename_session_error() -> Vec<RenameSessionError> {
    vec![RenameSessionError::EmptyName]
}

fn migration_error() -> Vec<MigrationError> {
    vec![
        MigrationError::NoTransform {
            from: 0,
            supported: 0,
        },
        MigrationError::Field(String::new()),
    ]
}

/// Build the `{enum: [sorted kinds]}` map from the per-enum instance lists.
/// Sorted for a stable, reviewable snapshot (declaration order is irrelevant to
/// the cross-boundary contract -- the SET of kinds is what the catalog covers).
fn variant_kind_map() -> BTreeMap<&'static str, Vec<String>> {
    let mut map: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    for (name, mut kinds) in [
        ("DuckLoadError", to_kinds(&duck_load_error())),
        ("MigrationError", to_kinds(&migration_error())),
        ("RemoveSourceError", to_kinds(&remove_source_error())),
        ("RenameError", to_kinds(&rename_error())),
        ("RenameSessionError", to_kinds(&rename_session_error())),
        ("ResumeError", to_kinds(&resume_error())),
        ("SaveError", to_kinds(&save_error())),
        ("SessionError", to_kinds(&session_error())),
        ("SkillError", to_kinds(&skill_error())),
        ("StoreCommandError", to_kinds(&store_command_error())),
        ("TurnError", to_kinds(&turn_error())),
        ("TurnFailure", to_kinds(&turn_failure())),
    ] {
        kinds.sort();
        map.insert(name, kinds);
    }
    map
}

#[test]
fn error_variant_kinds_match_golden() {
    let map = variant_kind_map();
    let actual = format!(
        "{}\n",
        serde_json::to_string_pretty(&map).expect("kind map serializes")
    );

    let golden_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("error_variant_kinds.json");

    // Require the literal value "1" rather than mere presence, so an empty or
    // `=0` value can't trip the regen branch and silently overwrite a real
    // drift -- the early return below would otherwise mark the test as passing.
    if std::env::var("UPDATE_ERROR_VARIANT_KINDS")
        .map(|v| v == "1")
        .unwrap_or(false)
    {
        fs::write(&golden_path, &actual).expect("write golden file");
        eprintln!("wrote {}", golden_path.display());
        return;
    }

    let expected = fs::read_to_string(&golden_path).unwrap_or_else(|e| {
        panic!(
            "read golden {}: {e}\nRegenerate with \
             `UPDATE_ERROR_VARIANT_KINDS=1 cargo test --test error_variant_kinds`",
            golden_path.display()
        )
    });

    assert_eq!(
        actual,
        expected,
        "error variant-kind snapshot drifted from {}.\n\
         If you added/removed/renamed a typed error variant, regenerate with\n\
         `UPDATE_ERROR_VARIANT_KINDS=1 cargo test --test error_variant_kinds`,\n\
         then add the matching catalog id + frontend format* switch case.",
        golden_path.display(),
    );
}

/// The frontend `fmtError` (src/api.ts) narrows a typed reject on its top-level
/// `kind` via structural guards in a fixed order -- `isSessionError`, then
/// `isSaveError`, then `isStoreCommandError`. A shared top-level `kind` between
/// any two of these enums would let the SECOND guard silently never fire and
/// mis-route the reject to the wrong formatter. This pins the disjointness the
/// dispatch relies on (the rustdoc claim on each enum), promoting it from a
/// comment to a CI gate.
///
/// Scoped to the TOP-LEVEL reject enums only. Nested sub-errors legitimately
/// reuse names (DuckLoadError::Io and SaveError::Io both exist) and never
/// compete at the fmtError top level, so a full-enum disjoint check would
/// false-positive on intentional reuse.
#[test]
fn top_level_reject_kind_sets_are_disjoint() {
    let map = variant_kind_map();
    let top_level = [
        "SessionError",
        "SaveError",
        "SkillError",
        "StoreCommandError",
    ];
    // kind -> first enum that owns it; a second owner is a dispatch collision.
    let mut first_owner: BTreeMap<String, &str> = BTreeMap::new();
    for name in top_level {
        for kind in map
            .get(name)
            .unwrap_or_else(|| panic!("top-level reject enum {name} missing from variant_kind_map"))
        {
            if let Some(prev) = first_owner.insert(kind.clone(), name) {
                panic!(
                    "top-level reject kind `{kind}` is shared by {prev} and {name}; \
                     fmtError's kind dispatch would silently mis-route it"
                );
            }
        }
    }
}
