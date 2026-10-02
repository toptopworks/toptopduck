//! Session-listing metadata (ADR-0060/0061/0089, issue #76): derive the
//! left-sidebar / cold-start session list from the persisted `.duck` recipes.
//! ADR-0089 moved the data source from the app-config `recent_files` list to a
//! managed sessions directory scan (`scan_sessions_dir`), but every metadata
//! field still comes from either the recipe (ADR-0034) or the file itself.
//!
//! ## duck_path = the `.duck` file path
//!
//! A runtime [`crate::SessionId`] is a UUID minted when a session enters the
//! in-memory [`crate::SessionStore`] and dies with it; it is NOT persisted. The
//! recipe (ADR-0034) carries no id field either. So the only stable, portable
//! identity of a persisted session is its **file path**. `duck_path` here is
//! that path string (renamed from `session_id` in issue #462 to disambiguate
//! from the runtime UUID). The frontend uses it as the stable sidebar key;
//! clicking a session mints a FRESH runtime id via `create_session` and resumes
//! the path into it (`open_duck(new_id, path)`), so the list-sessions path and
//! the runtime id are deliberately different things.

use crate::persistence::organization;
use crate::persistence::recipe::RecipeEntry;
use crate::persistence::{read_duck, LoadError, Recipe};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use tauri::Manager; // for AppHandle::path()

/// The root directory of all managed sessions (ADR-0089, issue #452). Each
/// session lives in a per-session subdirectory `{uuid}/session.duck`. Resolved
/// at setup from `<Documents>/toptopduck/sessions/` (or the app-config
/// `sessions_dir` override) and managed as Tauri state so every session-scoped
/// command shares one path source. The inner [`RwLock`] lets
/// `set_sessions_dir` swap the root at runtime without a restart — readers
/// clone under the read lock, the setter writes under the write lock.
pub struct SessionsRoot(RwLock<PathBuf>);

impl SessionsRoot {
    /// Wrap a resolved sessions root path.
    pub fn new(path: PathBuf) -> Self {
        Self(RwLock::new(path))
    }

    /// Read the current root path (cloned under the read lock). Every
    /// session-scoped command calls this to resolve its target directory.
    pub fn path(&self) -> PathBuf {
        self.0.read().expect("SessionsRoot lock poisoned").clone()
    }

    /// Replace the root path (issue #452). Called by `set_sessions_dir` after
    /// validation + persistence succeeds so new sessions land in the new
    /// directory immediately.
    pub fn set(&self, path: PathBuf) {
        *self.0.write().expect("SessionsRoot lock poisoned") = path;
    }
}

/// Validate a sessions directory candidate: must exist, be a directory, and be
/// writable (temp-file round-trip). Returns `Ok(())` on success or a
/// user-facing error message on failure (issue #452 decision #10).
pub(crate) fn validate_sessions_dir(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!(
            "sessions directory does not exist or is not a directory: {}",
            path.display()
        ));
    }
    let test = path.join(format!(".toptopduck-write-test-{}", std::process::id()));
    std::fs::write(&test, "").map_err(|e| format!("sessions directory is not writable: {e}"))?;
    if let Err(e) = std::fs::remove_file(&test) {
        log::warn!("failed to clean up sessions-dir write-test file: {e}");
    }
    Ok(())
}

/// Compute the default sessions root from the OS Documents directory, with a
/// temp-dir fallback mirroring setup's honest-degrade. Shared by `lib.rs`
/// setup and `set_sessions_dir` (when the override is cleared, None).
pub(crate) fn default_sessions_root(app: &tauri::AppHandle) -> PathBuf {
    match app.path().document_dir() {
        Ok(dir) => dir.join("toptopduck").join("sessions"),
        Err(e) => {
            log::warn!("failed to resolve documents dir; sessions fall back to a temp path: {e}");
            std::env::temp_dir().join("toptopduck-sessions")
        }
    }
}

/// Typed `.duck` file path — the stable identity of a persisted session
/// (ADR-0060/0061, issue #462). Distinct from the runtime [`SessionId`] (a
/// UUID): this is the persisted path the frontend passes back to `open_duck`.
/// Transparent serde keeps the wire format a bare string so the frontend type
/// stays `string`. The inner field is private; construction goes through
/// [`DuckPath::new`] and access through [`DuckPath::as_str`] so future
/// validation (non-empty, `.duck` suffix) can be added without breaking call
/// sites.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DuckPath(String);

impl DuckPath {
    /// Construct from a path string. No validation yet — any string is
    /// accepted (the only producer is `build_session_metadata`, which feeds a
    /// verified disk path).
    pub fn new(path: impl Into<String>) -> Self {
        Self(path.into())
    }

    /// Read-only access to the inner path string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One persisted session's sidebar metadata (ADR-0060/0061). Every field is
/// derived -- nothing here is authored to disk separately. The frontend renders
/// the left-sidebar entry from this (name + first source + turn count + mtime,
/// grouped by relative time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionMetadata {
    /// The stable identity of a persisted session: the `.duck` file path (see
    /// the module doc for why this is not a UUID). The frontend passes it back
    /// to `open_duck` to resume.
    pub duck_path: DuckPath,
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
    /// Shell-layer organization flag joined from the sidecar (ADR-0127):
    /// this row sits in the pinned section, displayed in sidecar array
    /// order ahead of the mtime list. False when the sidecar has no entry.
    pub pinned: bool,
    /// Shell-layer organization flag joined from the sidecar (ADR-0127):
    /// archived rows are excluded from the default list (and from the tray /
    /// search, which consume the same server-trimmed response). False when
    /// the sidecar has no entry.
    pub archived: bool,
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
/// joined with the organization sidecar (ADR-0127): pinned rows first in
/// sidecar array order, then the rest by mtime descending (most-recent first)
/// so the sidebar's default ordering is immediately useful. Archived rows are
/// trimmed server-side -- the tray and search consume this same response and
/// never see them. A missing / unreadable directory yields an empty vec -- the
/// app boots cleanly on a first launch with no sessions.
///
/// Each subdirectory that does not contain a readable `session.duck` is
/// silently skipped (ADR-0017 honest-skip) -- it may be a partial / stale
/// directory, not a session the sidebar should fabricate metadata for.
pub fn scan_sessions_dir(dir: &Path) -> Vec<SessionMetadata> {
    scan_sessions_dir_scoped(dir, false)
}

/// The archive-view variant of [`scan_sessions_dir`] (ADR-0127 Decision 2):
/// the same join, but archived rows are returned too, appended after the
/// pinned section and the live list (each block still mtime-descending).
/// Only `list_sessions` with `includeArchived` reaches for this.
pub fn scan_sessions_dir_including_archived(dir: &Path) -> Vec<SessionMetadata> {
    scan_sessions_dir_scoped(dir, true)
}

fn scan_sessions_dir_scoped(dir: &Path, include_archived: bool) -> Vec<SessionMetadata> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::warn!("failed to scan sessions dir {}: {e}", dir.display());
            return Vec::new();
        }
    };
    let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut metas: Vec<SessionMetadata> = entries
        .flatten()
        .filter_map(|e| {
            let session_dir = e.path();
            if !session_dir.is_dir() {
                return None;
            }
            // Organization keys survive an unreadable recipe: the DIRECTORY
            // is the session identity (ADR-0089), so a corrupt .duck
            // (honest-skip below) must not sweep its pin/archive state --
            // only a missing directory makes a key orphaned.
            if let Some(name) = session_dir.file_name().and_then(|n| n.to_str()) {
                known.insert(name.to_owned());
            }
            let duck = session_dir.join("session.duck");
            build_session_metadata(&duck)
        })
        .collect();
    // Join the organization sidecar (ADR-0127): the scan set also drives the
    // orphan-key sweep, so the sidecar stays bounded and self-heals.
    let org = organization::load_and_sweep(dir, &known);
    for m in &mut metas {
        if let Some(uuid) = organization::session_dir_uuid(m.duck_path.as_str()) {
            m.pinned = org.pinned.contains(&uuid);
            m.archived = org.archived.contains(&uuid);
        }
    }
    if !include_archived {
        metas.retain(|m| !m.archived);
    }
    // Stable sort chain, last key wins the top block: mtime-desc base, then
    // archived rows sink to the tail (only reachable with include_archived --
    // pinned and archived are disjoint by construction), then pinned rows
    // float to the head in sidecar array order (position = MRU, Decision 5).
    let pinned_rank: std::collections::HashMap<&str, usize> = org
        .pinned
        .iter()
        .enumerate()
        .map(|(i, k)| (k.as_str(), i))
        .collect();
    metas.sort_by_key(|m| std::cmp::Reverse(m.last_modified_at));
    metas.sort_by_key(|m| m.archived);
    metas.sort_by_key(|m| {
        organization::session_dir_uuid(m.duck_path.as_str())
            .and_then(|uuid| pinned_rank.get(uuid.as_str()).copied())
            .unwrap_or(usize::MAX)
    });
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
        duck_path: DuckPath::new(path_str.into_owned()),
        display_name: display_name(&recipe),
        last_modified_at: mtime,
        source_summary: source_summary(&recipe),
        format_version: recipe.format_version(),
        // Organization flags are joined by the scan, not derived here --
        // list_session_metadata (test helper, no sessions root) leaves them
        // false (ADR-0127).
        pinned: false,
        archived: false,
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
        // AC: list_sessions returns duck_path / display_name / last_modified_at
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
                            body: None,
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
                            body: None,
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
        // duck_path is the file path (the stable identity, see module doc).
        assert_eq!(m.duck_path, DuckPath::new(path.clone()));
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
        assert_eq!(list[0].duck_path, DuckPath::new(good));
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
                            body: None,
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

    // --- organization sidecar join (ADR-0127, issue #1174) -------------------

    /// Write `{uuid}/session.duck` with a one-source recipe named `name`.
    fn write_named_session(root: &Path, uuid: &str, name: &str) {
        write_session(
            root,
            uuid,
            Recipe::build(
                name.into(),
                vec![csv_source(name)],
                Vec::new(),
                Some(name.into()),
            )
            .expect("build"),
        );
    }

    #[test]
    fn scan_puts_pinned_rows_first_in_sidecar_array_order() {
        // ADR-0127 Decision 2/5: pinned rows lead the list in sidecar array
        // order (MRU head-insert), the rest stay mtime-descending.
        let root = tempfile::tempdir().expect("tempdir");
        write_named_session(root.path(), "uuid-old", "old");
        std::thread::sleep(std::time::Duration::from_millis(50));
        write_named_session(root.path(), "uuid-mid", "mid");
        std::thread::sleep(std::time::Duration::from_millis(50));
        write_named_session(root.path(), "uuid-new", "new");
        // Pin the OLDEST first, then the middle: array order [mid, old].
        organization::set_pinned(root.path(), "uuid-old", true).expect("pin old");
        organization::set_pinned(root.path(), "uuid-mid", true).expect("pin mid");

        let list = scan_sessions_dir(root.path());
        let names: Vec<&str> = list.iter().map(|m| m.display_name.as_str()).collect();
        assert_eq!(names, vec!["mid", "old", "new"]);
        assert!(list[0].pinned && list[1].pinned && !list[2].pinned);
    }

    #[test]
    fn scan_trims_archived_rows_by_default_and_returns_them_when_included() {
        // ADR-0127 Decision 2: archived rows are trimmed server-side, so the
        // tray and search (which consume scan_sessions_dir / the list_sessions
        // response verbatim) exclude them with zero changes (issue #1174 AC:
        // the server-trim regression pin lives here). includeArchived gets
        // them back, appended after the live list.
        let root = tempfile::tempdir().expect("tempdir");
        write_named_session(root.path(), "uuid-old", "old");
        std::thread::sleep(std::time::Duration::from_millis(50));
        write_named_session(root.path(), "uuid-mid", "mid");
        std::thread::sleep(std::time::Duration::from_millis(50));
        write_named_session(root.path(), "uuid-new", "new");
        organization::set_archived(root.path(), "uuid-mid", true).expect("archive mid");

        let trimmed = scan_sessions_dir(root.path());
        let names: Vec<&str> = trimmed.iter().map(|m| m.display_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["new", "old"],
            "archived row is trimmed by default"
        );
        assert!(trimmed.iter().all(|m| !m.archived));

        let full = scan_sessions_dir_including_archived(root.path());
        let names: Vec<&str> = full.iter().map(|m| m.display_name.as_str()).collect();
        assert_eq!(
            names,
            vec!["new", "old", "mid"],
            "archived row tails the list"
        );
        assert!(full[2].archived && !full[2].pinned);
    }

    #[test]
    fn scan_sweeps_sidecar_keys_for_deleted_session_dirs() {
        // ADR-0127 Decision 2: an externally deleted session directory leaves
        // an orphan key; the scan prunes it so the sidecar stays bounded.
        let root = tempfile::tempdir().expect("tempdir");
        write_named_session(root.path(), "uuid-live", "live");
        organization::set_pinned(root.path(), "uuid-gone", true).expect("pin gone");
        organization::set_archived(root.path(), "uuid-gone-too", true).expect("archive gone-too");

        let list = scan_sessions_dir(root.path());
        assert_eq!(list.len(), 1, "only the live session is listed");
        let healed: organization::SessionOrganization = serde_json::from_str(
            &std::fs::read_to_string(root.path().join(organization::SIDECAR_NAME))
                .expect("read sidecar"),
        )
        .expect("parse sidecar");
        assert!(healed.pinned.is_empty() && healed.archived.is_empty());
    }

    #[test]
    fn scan_keeps_organization_keys_for_dirs_with_an_unreadable_duck() {
        // The directory is the identity (ADR-0089): a corrupt .duck is an
        // honest-skip for the ROW, but not an orphaned KEY -- a temporarily
        // unreadable recipe must not cost the session its pin/archive state.
        let root = tempfile::tempdir().expect("tempdir");
        write_named_session(root.path(), "uuid-a", "a");
        organization::set_pinned(root.path(), "uuid-a", true).expect("pin a");
        std::fs::write(
            root.path().join("uuid-a").join("session.duck"),
            "{ not json",
        )
        .expect("corrupt the duck");

        let list = scan_sessions_dir(root.path());
        assert!(list.is_empty(), "the corrupt recipe honest-skips the row");
        let org: organization::SessionOrganization = serde_json::from_str(
            &std::fs::read_to_string(root.path().join(organization::SIDECAR_NAME))
                .expect("read sidecar"),
        )
        .expect("parse sidecar");
        assert_eq!(
            org.pinned,
            vec!["uuid-a"],
            "the key survives the unreadable duck"
        );
    }

    // --- validate_sessions_dir (issue #452) ---------------------------------

    #[test]
    fn validate_accepts_a_writable_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(validate_sessions_dir(dir.path()).is_ok());
    }

    #[test]
    fn validate_rejects_a_nonexistent_path() {
        let missing = std::env::temp_dir().join("toptopduck-test-validate-nonexistent");
        let result = validate_sessions_dir(&missing);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[test]
    fn validate_rejects_a_file_instead_of_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("not-a-dir");
        std::fs::write(&file, "").expect("write");
        let result = validate_sessions_dir(&file);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not a directory"));
    }

    // --- SessionsRoot RwLock (issue #452) -----------------------------------

    #[test]
    fn sessions_root_new_path_set_round_trip() {
        let root = SessionsRoot::new(PathBuf::from("/original/path"));
        assert_eq!(root.path(), PathBuf::from("/original/path"));

        root.set(PathBuf::from("/new/path"));
        assert_eq!(root.path(), PathBuf::from("/new/path"));
    }

    #[test]
    fn sessions_root_path_returns_a_clone_not_a_reference() {
        // path() must return an owned PathBuf so callers never hold the read
        // lock across IO (the lock is released when path() returns).
        let root = SessionsRoot::new(PathBuf::from("/sessions"));
        let cloned = root.path();
        // Mutating the root after cloning must not affect the clone.
        root.set(PathBuf::from("/elsewhere"));
        assert_eq!(cloned, PathBuf::from("/sessions"));
        assert_eq!(root.path(), PathBuf::from("/elsewhere"));
    }
}
