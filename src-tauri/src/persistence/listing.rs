//! Session-listing metadata (ADR-0060/0061/0089, issue #76): derive the
//! left-sidebar / cold-start session list from the persisted `.duck` recipes.
//! ADR-0089 moved the data source from the app-config `recent_files` list to a
//! managed sessions directory scan (`scan_sessions_dir`), but every metadata
//! field still comes from either the recipe (ADR-0034) or the file itself.
//!
//! ## session_id = the `.duck` file path
//!
//! A runtime [`crate::SessionId`] is a UUID minted when a session enters the
//! in-memory [`crate::SessionStore`] and dies with it; it is NOT persisted. The
//! recipe (ADR-0034) carries no id field either. So the only stable, portable
//! identity of a persisted session is its **file path**. `session_id` here is
//! that path string. The frontend uses it as the stable sidebar key; clicking a
//! session mints a FRESH runtime id via `create_session` and resumes the path
//! into it (`open_duck(new_id, path)`), so the list-sessions id and the runtime
//! id are deliberately different things.

use crate::persistence::recipe::RecipeEntry;
use crate::persistence::{read_duck, LoadError, Recipe};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

/// The root directory of all managed sessions (ADR-0089). Each session lives
/// in a per-session subdirectory `{uuid}/session.duck`. Resolved once at setup
/// from `<Documents>/toptopduck/sessions/` and managed as Tauri state so
/// every session-scoped command shares one path source.
pub struct SessionsRoot(pub PathBuf);

/// One persisted session's sidebar metadata (ADR-0060/0061). Every field is
/// derived -- nothing here is authored to disk separately. The frontend renders
/// the left-sidebar entry from this (name + first source + turn count + mtime,
/// grouped by relative time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMetadata {
    /// The stable identity of a persisted session: the `.duck` file path (see
    /// the module doc for why this is not a UUID). The frontend passes it back
    /// to `open_duck` to resume.
    pub session_id: String,
    /// User-facing name: the recipe's `session_name` when the user named the
    /// session, otherwise the first source's display label (ADR-0060: the
    /// default name is the first source's name). Empty only when the session
    /// has no name AND no sources.
    pub display_name: String,
    /// File modification time, milliseconds since the Unix epoch. The recipe
    /// deliberately stores no timestamps (ADR-0036), so the mtime comes from the
    /// filesystem -- the `.duck` is rewritten atomically on every terminal
    /// turn / source event, so it tracks the last real change.
    pub last_modified_at: i64,
    /// The working-set summary rendered as the sidebar entry's sub-line
    /// (ADR-0060: first source name + source count + turn count).
    pub source_summary: SourceSummary,
    /// The recipe format version (ADR-0036). Always the current version for a
    /// readable v1 file; surfaced so a future newer-made file can be honestly
    /// distinguished rather than silently mis-listed.
    pub format_version: u32,
}

/// A sidebar entry's working-set summary (ADR-0060): the first source's display
/// name (the recognition anchor), how many sources are loaded, and how many
/// turns the conversation has. All derived from the recipe -- no new fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSummary {
    /// The first source's display label, or `None` when the working set is empty
    /// (the last source was removed, ADR-0035). ADR-0060 names this the default
    /// session name and the sub-line anchor.
    pub first_source_name: Option<String>,
    /// Number of loaded sources (`recipe.sources.len()`).
    pub source_count: usize,
    /// Number of turns in the timeline (`recipe.history` Turn entries only --
    /// source lifecycle events are not turns, ADR-0040).
    pub turn_count: usize,
}

/// Build the session list from a set of `.duck` file paths (ADR-0060/0061).
/// A path that cannot be read (file moved/deleted, foreign format, corrupt) is
/// SKIPPED -- it is no longer a persisted session, and listing it with
/// fabricated metadata would be a silent lie (ADR-0017).
///
/// Test-only helper: the production sidebar data source is `scan_sessions_dir`
/// (ADR-0089). This function remains so the per-recipe derivation logic stays
/// black-box testable without a Tauri runtime or a real directory structure.
pub fn list_session_metadata(paths: &[String]) -> Vec<SessionMetadata> {
    paths
        .iter()
        .filter_map(|p| build_session_metadata(Path::new(p)))
        .collect()
}

/// Scan a managed sessions directory (ADR-0089) for per-session subdirectories
/// `{uuid}/session.duck`. Returns one `SessionMetadata` per readable recipe,
/// sorted by mtime descending (most-recent first) so the sidebar's default
/// ordering is immediately useful. A missing / unreadable directory yields an
/// empty vec -- the app boots cleanly on a first launch with no sessions.
///
/// Each subdirectory that does not contain a readable `session.duck` is
/// silently skipped (ADR-0017 honest-skip) -- it may be a partial / stale
/// directory, not a session the sidebar should fabricate metadata for.
pub fn scan_sessions_dir(dir: &Path) -> Vec<SessionMetadata> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::warn!("failed to scan sessions dir {}: {e}", dir.display());
            return Vec::new();
        }
    };
    let mut metas: Vec<SessionMetadata> = entries
        .flatten()
        .filter_map(|e| {
            let session_dir = e.path();
            if !session_dir.is_dir() {
                return None;
            }
            let duck = session_dir.join("session.duck");
            build_session_metadata(&duck)
        })
        .collect();
    metas.sort_by_key(|m| std::cmp::Reverse(m.last_modified_at));
    metas
}

/// Derive one session's metadata from its `.duck` path. Returns `None` on any
/// read / stat failure (the file is absent or not a readable v1 recipe) so the
/// caller can skip it without a panic or a fabricated entry. An `Io` failure
/// (file moved or deleted) is dropped silently -- ADR-0017 honest-skip, the
/// path is simply no longer a session. Any other [`LoadError`] (corrupt JSON,
/// a newer app's `VersionMismatch`, a failed `Migration`) is a surprise: the
/// entry was a session but no longer reads, so it is logged at WARN before
/// being dropped -- the missing sidebar entry stays diagnosable instead of
/// vanishing without a trace. The list never fabricates metadata either way.
fn build_session_metadata(path: &Path) -> Option<SessionMetadata> {
    let path_str = path.to_string_lossy();
    let recipe = match read_duck(path) {
        Ok(r) => r,
        // ADR-0017 honest-skip: a plain missing / moved file is no longer a
        // session, so it is dropped quietly (the cold-start sidebar only lists
        // what still exists on disk).
        Err(LoadError::Io(_)) => return None,
        // A readable-but-unexpected file (corrupt JSON, a newer app's format,
        // a failed migration) is worth surfacing: the user just lost a sidebar
        // entry they expected, and the typed error names why. The list still
        // drops it (no fabricated metadata), but a WARN leaves a trail.
        Err(e) => {
            log::warn!("skipped session entry {path_str}: {e}");
            return None;
        }
    };
    let mtime = file_mtime_millis(&path_str).unwrap_or(0);
    Some(SessionMetadata {
        session_id: path_str.into_owned(),
        display_name: display_name(&recipe),
        last_modified_at: mtime,
        source_summary: source_summary(&recipe),
        format_version: recipe.format_version(),
    })
}

/// The user-facing name: the recipe's `session_name` when non-empty, otherwise
/// the first source's display label (ADR-0060 default-name fallback). Empty when
/// neither is available (no name + no sources).
fn display_name(recipe: &Recipe) -> String {
    if !recipe.session_name.is_empty() {
        recipe.session_name.clone()
    } else {
        recipe
            .sources
            .first()
            .map(|s| s.display_name.clone())
            .unwrap_or_default()
    }
}

/// The working-set summary: first source's display name + source count + turn
/// count (ADR-0060). Turn count excludes source lifecycle events (ADR-0040).
fn source_summary(recipe: &Recipe) -> SourceSummary {
    let turn_count = recipe
        .history
        .iter()
        .filter(|e| matches!(e, RecipeEntry::Turn(_)))
        .count();
    SourceSummary {
        first_source_name: recipe.sources.first().map(|s| s.display_name.clone()),
        source_count: recipe.sources.len(),
        turn_count,
    }
}

/// File mtime in milliseconds since the Unix epoch, or `None` if unreadable.
fn file_mtime_millis(path: &str) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    //! list_session_metadata derivation (ADR-0060/0061, issue #76). Each test
    //! writes a real `.duck` via the invariant-validating `Recipe::build` +
    //! `save_atomic`, then asserts the derived metadata -- the same round-trip
    //! `read_duck` uses, so the listing reads exactly what resume reads.

    use super::*;
    use crate::model::{SourceLifecycleEvent, SourceLifecycleKind};
    use crate::persistence::recipe::{
        RecipeEntry, RecipeOutcome, RecipePromotion, RecipeTurn, SourceRef,
    };
    use crate::persistence::save_atomic;

    fn csv_source(name: &str) -> SourceRef {
        use crate::model::RectifyProvenance;
        SourceRef {
            reference_name: name.into(),
            display_name: name.into(),
            source_path: format!("/data/{name}.csv"),
            relative_path: None,
            rectify: RectifyProvenance::NotApplicable,
            fingerprint: format!("fp-{name}"),
        }
    }

    /// Write a recipe to `path` and return the path string.
    fn write_recipe(path: &std::path::Path, recipe: Recipe) -> String {
        save_atomic(path, &recipe).expect("save");
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn derives_all_fields_from_a_readable_recipe() {
        // AC: list_sessions returns session_id / display_name / last_modified_at
        // / source_summary / format_version, all derived from the recipe + file.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_recipe(
            &dir.path().join("analysis.duck"),
            Recipe::build(
                "我的分析".into(),
                vec![csv_source("orders")],
                vec![
                    RecipeEntry::Source(SourceLifecycleEvent {
                        kind: SourceLifecycleKind::Added,
                        reference_name: "orders".into(),
                        display_name: "orders".into(),
                    }),
                    RecipeEntry::Turn(RecipeTurn::without_audit(
                        "多少单",
                        RecipeOutcome::Materialized {
                            promotions: vec![RecipePromotion {
                                reference_name: "result_1".into(),
                                display_name: "result_1".into(),
                                sql: "SELECT 1".into(),
                                stale: None,
                            }],
                            assumption: None,
                        },
                    )),
                    RecipeEntry::Turn(RecipeTurn::without_audit(
                        "再问",
                        RecipeOutcome::Materialized {
                            promotions: vec![RecipePromotion {
                                reference_name: "result_2".into(),
                                display_name: "result_2".into(),
                                sql: "SELECT 2".into(),
                                stale: None,
                            }],
                            assumption: None,
                        },
                    )),
                ],
                Some("orders".into()),
            )
            .expect("build"),
        );

        let list = list_session_metadata(std::slice::from_ref(&path));
        assert_eq!(list.len(), 1);
        let m = &list[0];
        // session_id is the file path (the stable identity, see module doc).
        assert_eq!(m.session_id, path);
        // display_name = the user-given session_name.
        assert_eq!(m.display_name, "我的分析");
        // source_summary: first source name + 1 source + 2 turns (the source
        // lifecycle event is NOT a turn, ADR-0040).
        assert_eq!(
            m.source_summary.first_source_name.as_deref(),
            Some("orders")
        );
        assert_eq!(m.source_summary.source_count, 1);
        assert_eq!(m.source_summary.turn_count, 2);
        // format_version is the current recipe version.
        assert_eq!(m.format_version, crate::persistence::RECIPE_FORMAT_VERSION);
        // mtime is the file's actual modification time in epoch millis -- pin
        // both the unit (millis, not micros/nanos) and the source (this .duck
        // path) by comparing against an independent stat, so a unit or source
        // bug cannot slip through as merely "non-zero".
        let file_mtime = std::fs::metadata(&path)
            .expect("stat recipe")
            .modified()
            .expect("modified");
        let expected = file_mtime
            .duration_since(std::time::UNIX_EPOCH)
            .expect("after epoch")
            .as_millis() as i64;
        let drift = (m.last_modified_at - expected).abs();
        assert!(
            drift < 5000,
            "mtime {} drifted {}ms from the file's mtime {}",
            m.last_modified_at,
            drift,
            expected
        );
    }

    #[test]
    fn display_name_falls_back_to_first_source_when_session_name_is_empty() {
        // ADR-0060: default name = first source name. When the recipe's
        // session_name is empty, display_name falls back to the first source's
        // display label.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_recipe(
            &dir.path().join("noname.duck"),
            Recipe::build(
                String::new(),
                vec![csv_source("people")],
                Vec::new(),
                Some("people".into()),
            )
            .expect("build"),
        );
        let m = &list_session_metadata(&[path])[0];
        assert_eq!(
            m.display_name, "people",
            "empty name falls back to first source"
        );
        assert_eq!(
            m.source_summary.first_source_name.as_deref(),
            Some("people")
        );
    }

    #[test]
    fn empty_working_set_yields_none_first_source_and_zero_counts() {
        // ADR-0035: the last source can be removed to an empty working set. The
        // summary then has no first source name, zero sources, and (here) zero
        // turns. display_name falls back to the session_name "空" (non-empty).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_recipe(
            &dir.path().join("empty.duck"),
            Recipe::build("空".into(), Vec::new(), Vec::new(), None).expect("build"),
        );
        let m = &list_session_metadata(&[path])[0];
        assert!(m.source_summary.first_source_name.is_none());
        assert_eq!(m.source_summary.source_count, 0);
        assert_eq!(m.source_summary.turn_count, 0);
        assert_eq!(m.display_name, "空"); // session_name is non-empty -> used
    }

    #[test]
    fn skips_paths_that_are_not_readable_recipes() {
        // ADR-0017 honest: a path whose file is missing / not a
        // readable v1 recipe is dropped, never listed with fabricated metadata.
        let dir = tempfile::tempdir().expect("tempdir");
        let good = write_recipe(
            &dir.path().join("good.duck"),
            Recipe::build(
                "ok".into(),
                vec![csv_source("s")],
                Vec::new(),
                Some("s".into()),
            )
            .expect("build"),
        );
        let missing = dir.path().join("gone.duck").to_string_lossy().into_owned();
        let foreign = {
            // A real file that is NOT a recipe (read_duck rejects it).
            let p = dir.path().join("foreign.duck");
            std::fs::write(&p, "not json").expect("write");
            p.to_string_lossy().into_owned()
        };
        let list = list_session_metadata(&[missing, good.clone(), foreign]);
        assert_eq!(list.len(), 1, "only the readable recipe is listed");
        assert_eq!(list[0].session_id, good);
    }

    #[test]
    fn source_lifecycle_events_do_not_count_as_turns() {
        // ADR-0040: source lifecycle events are first-class timeline entries but
        // NOT turns -- turn_count counts RecipeEntry::Turn only.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_recipe(
            &dir.path().join("lifecycle.duck"),
            Recipe::build(
                "lc".into(),
                vec![csv_source("a"), csv_source("b")],
                vec![
                    RecipeEntry::Source(SourceLifecycleEvent {
                        kind: SourceLifecycleKind::Added,
                        reference_name: "a".into(),
                        display_name: "a".into(),
                    }),
                    RecipeEntry::Source(SourceLifecycleEvent {
                        kind: SourceLifecycleKind::Added,
                        reference_name: "b".into(),
                        display_name: "b".into(),
                    }),
                    RecipeEntry::Turn(RecipeTurn::without_audit(
                        "q",
                        RecipeOutcome::Materialized {
                            promotions: vec![RecipePromotion {
                                reference_name: "result_1".into(),
                                display_name: "result_1".into(),
                                sql: "SELECT 1".into(),
                                stale: None,
                            }],
                            assumption: None,
                        },
                    )),
                ],
                Some("a".into()),
            )
            .expect("build"),
        );
        let m = &list_session_metadata(&[path])[0];
        assert_eq!(m.source_summary.source_count, 2);
        assert_eq!(
            m.source_summary.turn_count, 1,
            "two Added events + one turn"
        );
        assert_eq!(m.source_summary.first_source_name.as_deref(), Some("a"));
    }

    // --- scan_sessions_dir (ADR-0089 production data source) ---------------

    /// Write a recipe into `{dir}/{uuid}/session.duck` so it matches the
    /// managed-directory layout. Returns the metadata path.
    fn write_session(root: &std::path::Path, uuid: &str, recipe: Recipe) -> std::path::PathBuf {
        let session_dir = root.join(uuid);
        std::fs::create_dir_all(&session_dir).expect("create session dir");
        let duck = session_dir.join("session.duck");
        save_atomic(&duck, &recipe).expect("save");
        duck
    }

    #[test]
    fn scan_returns_empty_for_missing_root() {
        // A non-existent sessions root yields an empty vec — the app boots
        // cleanly on first launch.
        let missing = std::env::temp_dir().join("toptopduck-test-nonexistent-scan");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(scan_sessions_dir(&missing).is_empty());
    }

    #[test]
    fn scan_lists_sessions_sorted_by_mtime_desc() {
        let root = tempfile::tempdir().expect("tempdir");
        // Write two sessions; the second is newer.
        write_session(
            root.path(),
            "uuid-a",
            Recipe::build(
                "first".into(),
                vec![csv_source("a")],
                Vec::new(),
                Some("a".into()),
            )
            .expect("build"),
        );
        // Small delay so the mtimes differ reliably on coarse-resolution filesystems.
        std::thread::sleep(std::time::Duration::from_millis(50));
        write_session(
            root.path(),
            "uuid-b",
            Recipe::build(
                "second".into(),
                vec![csv_source("b")],
                Vec::new(),
                Some("b".into()),
            )
            .expect("build"),
        );
        let list = scan_sessions_dir(root.path());
        assert_eq!(list.len(), 2);
        // Most-recent first (uuid-b written later).
        assert!(
            list[0].last_modified_at >= list[1].last_modified_at,
            "entries sorted by mtime descending"
        );
        assert_eq!(list[0].display_name, "second");
        assert_eq!(list[1].display_name, "first");
    }

    #[test]
    fn scan_skips_non_dir_entries_and_dirs_without_session_duck() {
        let root = tempfile::tempdir().expect("tempdir");
        // A valid session.
        write_session(
            root.path(),
            "uuid-ok",
            Recipe::build(
                "ok".into(),
                vec![csv_source("s")],
                Vec::new(),
                Some("s".into()),
            )
            .expect("build"),
        );
        // A loose file in the root (not a session directory).
        std::fs::write(root.path().join("loose.txt"), "not a session").expect("write");
        // A subdirectory with no session.duck (partial / stale).
        std::fs::create_dir_all(root.path().join("uuid-empty")).expect("mkdir");

        let list = scan_sessions_dir(root.path());
        assert_eq!(list.len(), 1, "only the valid session is listed");
        assert_eq!(list[0].display_name, "ok");
    }
}
