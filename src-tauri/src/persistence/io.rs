//! Atomic `.duck` file IO (ADR-0034/0035): every per-turn persistence write
//! is a temp-file + rename whole-file rewrite, so a crash mid-write never
//! leaves a corrupt recipe (it leaves either the prior complete recipe or
//! the next complete one -- never a half-written file). The temp file lands
//! in the SAME directory as the target so the rename is intra-volume (atomic
//! on NTFS / POSIX local filesystems).
//!
//! The recipe is small text, so a whole-file rewrite per terminal turn is
//! the KISS choice (ADR-0034 explicitly defers journaling). Resume reads
//! the file back and verifies `format_version` before touching any source
//! (ADR-0036 honest-refuse on a higher version).

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::persistence::migration::migrate_to_current;
use crate::persistence::recipe::{Recipe, RECIPE_FORMAT_VERSION};

use serde_json::Value;

/// Suffix appended to the target file name for the temp file. Same directory
/// as the target so the `rename` is intra-volume (atomic). The temp file is
/// created fresh each save (`File::create` truncates), so a stale temp from
/// a prior crashed write is overwritten, not appended to.
const TMP_SUFFIX: &str = ".tmp";

/// Why a save failed. Every failure leaves the prior recipe file (if any)
/// untouched: a serialize error happens before any IO; an IO or rename
/// failure leaves the temp file behind but the target unchanged. The temp
/// is best-effort cleaned up on a rename failure. `AlreadyOpen` is the
/// ADR-0035 Decision 3 single-writer refusal -- the canonical path is already held
/// by another Session in this process, so the save never touches the file.
#[derive(Debug)]
pub enum SaveError {
    Serialize(String),
    Io(String),
    Rename(String),
    /// ADR-0035 Decision 3 / issue #50: the canonical `.duck` path is already held
    /// open by another Session in this process. The save is refused BEFORE
    /// any IO so the existing file is never clobbered. Carries the canonical
    /// path so the UI can name exactly which file is double-open.
    AlreadyOpen(PathBuf),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Serialize(d) => write!(f, "序列化 .duck 失败：{d}"),
            Self::Io(d) => write!(f, "写 .duck 临时文件失败：{d}"),
            Self::Rename(d) => write!(f, "替换 .duck 失败：{d}"),
            Self::AlreadyOpen(p) => {
                write!(f, "该 .duck 已在本进程打开，不能重复保存：{}", p.display())
            }
        }
    }
}
impl std::error::Error for SaveError {}

/// Why a read failed. `VersionMismatch` is the ADR-0036 honest-refuse case:
/// a file made by a newer app must not be silently mis-parsed.
#[derive(Debug)]
pub enum LoadError {
    Io(String),
    Parse(String),
    /// ADR-0036: a higher format_version means a newer app made the file. The
    /// honest answer is "please upgrade" (ADR-0017 capability boundary at the
    /// format layer) -- never a heuristic guess at the new layout.
    VersionMismatch {
        found: u32,
        supported: u32,
    },
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Self::Io(d) => write!(f, "读取 .duck 失败：{d}"),
            Self::Parse(d) => write!(f, "解析 .duck 失败：{d}"),
            Self::VersionMismatch { found, supported } => write!(
                f,
                "此 .duck 由更高版本（format_version={found}）制作，\
                 当前 app 仅支持 {supported}，请升级 app 后再打开"
            ),
        }
    }
}
impl std::error::Error for LoadError {}

/// The temp-file path for a target (same directory, name + TMP_SUFFIX).
/// Public so a caller / test can locate a stale temp after a simulated
/// mid-write crash.
pub fn temp_path_for(target: &Path) -> Option<PathBuf> {
    let file_name = target.file_name()?.to_str()?;
    Some(target.with_file_name(format!("{file_name}{TMP_SUFFIX}")))
}

/// Write a recipe atomically: serialize to JSON (pretty, for human-readable
/// .duck and git-friendly diffs), write to `<target>.tmp` in the same
/// directory, `fsync`, then rename over the target. The rename is atomic on
/// the same volume; a crash before rename leaves the prior target intact and
/// a stale temp behind (overwritten on the next save).
pub fn save_atomic(target: &Path, recipe: &Recipe) -> Result<(), SaveError> {
    // pretty + sorted keys is unnecessary (serde_json::to_string_pretty keeps
    // struct order, which is stable), so plain pretty suffices and reads
    // cleanly in a text editor / git diff.
    let json =
        serde_json::to_string_pretty(recipe).map_err(|e| SaveError::Serialize(e.to_string()))?;
    let tmp = temp_path_for(target).ok_or_else(|| SaveError::Io("无法推导临时文件路径".into()))?;

    {
        let mut file = fs::File::create(&tmp).map_err(|e| SaveError::Io(e.to_string()))?;
        file.write_all(json.as_bytes())
            .map_err(|e| SaveError::Io(e.to_string()))?;
        // fsync the data before the rename so a crash right after the rename
        // never leaves a 0-byte / partially-flushed target. Best-effort on
        // platforms where fsync is a no-op for some FS.
        file.sync_all().map_err(|e| SaveError::Io(e.to_string()))?;
    }

    if let Err(e) = fs::rename(&tmp, target) {
        // Clean up the temp so it doesn't pile up across saves; the target is
        // untouched (the rename never happened). A failed remove here is
        // swallowed -- it would mask the real (rename) failure.
        let _ = fs::remove_file(&tmp);
        return Err(SaveError::Rename(e.to_string()));
    }
    Ok(())
}

/// Read a recipe, routing on `format_version` (ADR-0036 Decision 1). The file
/// is parsed to [`Value`] BEFORE the typed deserialize so an older shape can be
/// reshaped first: equal -> deserialize directly; lower -> forward-migrate via
/// [`migrate_to_current`] (each per-version transform fills defaults / remaps
/// semantics), then deserialize; higher -> honest refuse (a newer-made file is
/// never silently mis-parsed). A missing or non-numeric `format_version` is an
/// honest Parse error -- the field is mandatory on every v1+ .duck (ADR-0036).
///
/// The forward-migrate path returns the recipe in memory; ADR-0036 KISS lands
/// persistence of the migrated shape on the next normal auto-write (the
/// caller's `open_duck` persists post-resume), so this function itself stays
/// side-effect free and never backs up the original file (YAGNI).
pub fn read_duck(path: &Path) -> Result<Recipe, LoadError> {
    let text = fs::read_to_string(path).map_err(|e| LoadError::Io(e.to_string()))?;
    let value: Value = serde_json::from_str(&text).map_err(|e| LoadError::Parse(e.to_string()))?;
    let version = value
        .get("format_version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| LoadError::Parse("format_version 缺失或非数值".into()))?
        as u32;
    let value = if version > RECIPE_FORMAT_VERSION {
        return Err(LoadError::VersionMismatch {
            found: version,
            supported: RECIPE_FORMAT_VERSION,
        });
    } else if version < RECIPE_FORMAT_VERSION {
        migrate_to_current(value, version).map_err(|e| LoadError::Parse(e.to_string()))?
    } else {
        value
    };
    let recipe: Recipe =
        serde_json::from_value(value).map_err(|e| LoadError::Parse(e.to_string()))?;
    // Parse, don't validate (rust/security.md §input-validation): a hand-edited
    // or corrupted .duck is external input (ADR-0034 user-owned document), so a
    // structural invariant like unique source reference names must surface here
    // as an honest parse error -- not later as a confusing mid-resume ambiguity
    // over which duplicate source to re-read.
    let mut seen = HashSet::new();
    for src in &recipe.sources {
        if !seen.insert(&src.reference_name) {
            return Err(LoadError::Parse(format!(
                "源引用名重复：{}",
                src.reference_name
            )));
        }
    }
    Ok(recipe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::RectifyProvenance;
    use crate::persistence::recipe::{RecipeEntry, RecipeOutcome, RecipeTurn, SourceRef};

    fn sample_recipe(name: &str) -> Recipe {
        Recipe {
            format_version: RECIPE_FORMAT_VERSION,
            session_name: name.into(),
            sources: vec![SourceRef {
                reference_name: "people".into(),
                display_name: "people".into(),
                source_path: "/data/people.csv".into(),
                relative_path: None,
                rectify: RectifyProvenance::NotApplicable,
                fingerprint: "fp".into(),
            }],
            history: vec![RecipeEntry::Turn(RecipeTurn {
                question: "q".into(),
                outcome: RecipeOutcome::Materialized {
                    reference_name: "result_1".into(),
                    display_name: "result_1".into(),
                    sql: "SELECT 1".into(),
                    assumption: None,
                },
            })],
            active: Some("result_1".into()),
        }
    }

    #[test]
    fn save_then_read_round_trips() {
        // ADR-0034: write a recipe, read it back, get the same recipe -- the
        // .duck is a faithful portable document of the working set.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.duck");
        let recipe = sample_recipe("round-trip");
        save_atomic(&path, &recipe).expect("save");
        let back = read_duck(&path).expect("read");
        assert_eq!(back, recipe);
    }

    #[test]
    fn save_leaves_no_temp_file_behind() {
        // ADR-0034 atomic write: a successful save renames the temp over the
        // target, so no `.tmp` litters the directory (a stale temp would pile
        // up across saves without this).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.duck");
        save_atomic(&path, &sample_recipe("clean")).expect("save");
        let tmp = temp_path_for(&path).expect("temp path");
        assert!(!tmp.exists(), "temp file must not linger after save");
        assert!(path.exists(), "target file exists");
    }

    #[test]
    fn save_overwrites_an_existing_file_atomically() {
        // ADR-0034 per-turn rewrite: each terminal turn rewrites the whole
        // file. A second save on the same path replaces the first recipe
        // entirely (not appended, not merged).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("session.duck");
        save_atomic(&path, &sample_recipe("first")).expect("save 1");
        save_atomic(&path, &sample_recipe("second")).expect("save 2");
        let back = read_duck(&path).expect("read");
        assert_eq!(back.session_name, "second");
    }

    #[test]
    fn read_refuses_a_higher_format_version() {
        // ADR-0036 honest-refuse: a file made by a newer app (higher
        // format_version) must NOT be silently mis-parsed. The error names
        // both versions so the user understands they must upgrade.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("future.duck");
        // Hand-write a recipe whose format_version is ahead of v1.
        let future = format!(
            "{{\"format_version\":{future},\"session_name\":\"x\",\"sources\":[],\"history\":[]}}",
            future = RECIPE_FORMAT_VERSION + 1
        );
        fs::write(&path, &future).expect("write");
        match read_duck(&path) {
            Err(LoadError::VersionMismatch { found, supported }) => {
                assert_eq!(found, RECIPE_FORMAT_VERSION + 1);
                assert_eq!(supported, RECIPE_FORMAT_VERSION);
            }
            other => panic!("expected VersionMismatch, got {other:?}"),
        }
    }

    #[test]
    fn read_surfaces_a_corrupt_file_as_parse_error() {
        // ADR-0036 / ADR-0017 honest-degrade: a file that is not a valid recipe
        // surfaces as a parse error, not a silent empty recipe.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("broken.duck");
        fs::write(&path, b"not json {").expect("write");
        assert!(matches!(read_duck(&path), Err(LoadError::Parse(_))));
    }

    #[test]
    fn read_duck_migrates_a_lower_version_to_current() {
        // ADR-0036 forward migration: a file whose format_version is BELOW the
        // current app version is reshaped through the migration pipeline and
        // returned as a current-version Recipe -- not refused. Uses the
        // synthetic v0 shape (sources missing display_name; outcome carries
        // the legacy outcome_kind discriminator) so both migration kinds are
        // exercised at the read boundary.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("v0.duck");
        let v0 = serde_json::json!({
            "format_version": 0,
            "session_name": "v0 分析",
            "sources": [{
                "reference_name": "people",
                "source_path": "/data/people.csv",
                "fingerprint": "fp",
            }],
            "history": [{
                "entry": "Turn",
                "data": {
                    "question": "多少人",
                    "outcome": {
                        "outcome_kind": "Materialized",
                        "data": {
                            "reference_name": "result_1",
                            "display_name": "result_1",
                            "sql": "SELECT COUNT(*) AS n FROM \"people\".data",
                        },
                    },
                },
            }],
            "active": "result_1",
        });
        fs::write(&path, serde_json::to_string(&v0).unwrap()).expect("write");

        let recipe = read_duck(&path).expect("migrated read");
        assert_eq!(recipe.format_version, RECIPE_FORMAT_VERSION);
        assert_eq!(
            recipe.sources[0].display_name, "people",
            "default display_name filled by the v0->v1 transform",
        );
        // The outcome discriminator was renamed so the Materialized variant
        // deserialized -- a failed remap would have surfaced as a Parse error.
        match &recipe.history[0] {
            RecipeEntry::Turn(t) => match &t.outcome {
                RecipeOutcome::Materialized { reference_name, .. } => {
                    assert_eq!(reference_name, "result_1");
                }
                other => panic!("expected Materialized after migration, got {other:?}"),
            },
            other => panic!("expected Turn after migration, got {other:?}"),
        }
    }
}
