//! Skill import from external agent libraries (issue #367, ADR-0086).
//!
//! The import surface has two halves:
//! - [`discover_skill_sources`] projects the candidate source directories
//!   (Claude Code `~/.claude/skills`, Codex CLI `~/.codex/skills`, + user-
//!   added custom paths -- resolved by the command layer off
//!   `app.path().home_dir()`) into a wire list, classifying each resident
//!   skill directory as importable / already-exists / invalid. Pure of Tauri
//!   state, so the whole surface tests against a tempdir.
//! - [`import_skill`] commits one skill into the registry (link or copy),
//!   re-validating the source + re-checking the registry at commit time so a
//!   source that changed between discovery and commit never overwrites a name
//!   that landed in the interim.
//!
//! Link = symlink (Unix) / directory junction (Windows) -> `acquired: linked`
//! (read-only); copy = recursive directory copy -> `acquired: local`
//! (editable). The directory-scan loader already derives `acquired` from the
//! filesystem nature of the imported directory, so the import path only needs
//! to place the directory -- reading it back is delegated to [`load_skill`].

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use super::model::{
    DiscoveredSkill, DiscoveredSkillStatus, ImportMode, ImportOutcome, SkillEntry, SkillError,
    SkillSource, SkillSourceCandidate,
};
use super::registry::{fs_err, load_skill};

/// Project the candidate sources into the wire list (issue #367). A candidate
/// whose `path` does not exist (or is not a directory) is DROPPED -- the
/// "show only if it exists" rule (issue #367). Each surviving source lists
/// its resident skill directories with an import-readiness classification;
/// `already_exists` mirrors membership in `existing_names` (the registry's
/// current name set, supplied by the command layer so this function stays
/// Tauri-state-free). Sources are sorted by id; skills within each source are
/// sorted by name, for a deterministic listing (parallel to
/// [`super::registry::list_skills`]).
pub fn discover_skill_sources(
    candidates: &[SkillSourceCandidate],
    existing_names: &HashSet<String>,
) -> Vec<SkillSource> {
    let mut sources = Vec::new();
    for candidate in candidates {
        // Follow links: a source lib that is itself a symlink / junction onto
        // a real directory still counts. A missing candidate is the common
        // case (no `~/.claude/skills` on this machine) -- silently dropped.
        if !candidate.path.is_dir() {
            continue;
        }
        let skills = scan_source_children(&candidate.path, existing_names);
        sources.push(SkillSource {
            id: candidate.id.clone(),
            label: candidate.label.clone(),
            path: candidate.path.to_string_lossy().into_owned(),
            skills,
        });
    }
    // Stable ordering by the candidate id -- standard sources keep their fixed
    // ids, custom paths sort after, and repeated discoveries render the same.
    sources.sort_by(|a, b| a.id.cmp(&b.id));
    sources
}

/// Import one skill into the registry in the given `mode` (issue #367). The
/// source is re-validated + the name re-checked at commit time (no cached
/// discovery status crosses the wire), so a source that changed between
/// discovery and commit surfaces a typed reject rather than overwriting. The
/// registry root is minted lazily on first import (parallel to
/// [`super::registry::create_skill`]).
///
/// Link mode creates a symlink (Unix) / directory junction (Windows) onto the
/// external source -> `acquired: linked` (read-only). A link failure folds a
/// copy-mode hint into the error detail. Copy mode recursively copies the
/// source directory -> `acquired: local` (editable); a mid-copy failure
/// removes the partial copy so a retry does not strand a name (parallel to
/// `create_skill`'s rollback).
pub fn import_skill(
    root: &Path,
    source_dir: &Path,
    mode: ImportMode,
) -> Result<SkillEntry, SkillError> {
    let entry = load_skill(source_dir)?;
    let target = root.join(&entry.name);
    if target.exists() {
        return Err(SkillError::NameTaken(entry.name.clone()));
    }
    fs::create_dir_all(root).map_err(|e| fs_err("create skills root", root, e))?;
    match mode {
        ImportMode::Link => {
            link_dir(source_dir, &target).map_err(|e| {
                SkillError::FsFailure(format!(
                    "link skill `{}` from `{}` failed: {e}; try Copy mode instead",
                    entry.name,
                    source_dir.display()
                ))
            })?;
        }
        ImportMode::Copy => {
            if let Err(e) = copy_dir_recursive(source_dir, &target, 0) {
                let _ = fs::remove_dir_all(&target);
                return Err(fs_err("copy skill directory", &target, e));
            }
        }
    }
    // Read back through the link / copy so the entry carries the correct
    // `acquired` variant + the link target the drawer's "open source location"
    // reveals.
    load_skill(&target)
}

/// Run a batch of imports, collecting each outcome so a per-item failure never
/// aborts the rest (issue #367). The result parallels the input; the frontend
/// folds each `Failed` through `fmtError` and invalidates the skills query once
/// for the whole batch. Item order is preserved.
pub fn import_skills(
    root: &Path,
    items: &[super::model::ImportItem],
    mode: ImportMode,
) -> Vec<ImportOutcome> {
    items
        .iter()
        .map(
            |item| match import_skill(root, Path::new(&item.source_dir), mode) {
                Ok(entry) => ImportOutcome::Imported(entry),
                Err(e) => ImportOutcome::Failed(e),
            },
        )
        .collect()
}

// --- internals ---------------------------------------------------------------

/// Scan one source directory's children into classified discovered skills
/// (issue #367). Only directories are candidates (a symlink / junction onto a
/// directory counts -- `fs::metadata` follows the link for the dir check,
/// parallel to `list_skills`). Each child is classified via [`load_skill`]:
/// Ok + name free -> `Importable`; Ok + name in the registry -> `AlreadyExists`
/// (excluded, never overwritten); Err -> `Invalid` with the English reason.
fn scan_source_children(source: &Path, existing_names: &HashSet<String>) -> Vec<DiscoveredSkill> {
    let Ok(entries) = fs::read_dir(source) else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false) {
            continue;
        }
        match load_skill(&path) {
            Ok(loaded) => {
                let status = if existing_names.contains(&loaded.name) {
                    DiscoveredSkillStatus::AlreadyExists
                } else {
                    DiscoveredSkillStatus::Importable
                };
                skills.push(DiscoveredSkill {
                    name: loaded.name.clone(),
                    description: Some(loaded.description.clone()),
                    source_dir: path.to_string_lossy().into_owned(),
                    status,
                    reason: None,
                });
            }
            Err(e) => {
                // The directory name is the user-facing handle (parallel to
                // SkippedSkill.dir); a non-UTF-8 name keeps its lossy form so
                // two distinct byte sequences never collapse into one row.
                let dir_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                skills.push(DiscoveredSkill {
                    name: dir_name,
                    description: None,
                    source_dir: path.to_string_lossy().into_owned(),
                    status: DiscoveredSkillStatus::Invalid,
                    reason: Some(e.to_string()),
                });
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// Create a directory link at `link_path` pointing to `source` (issue #367).
/// Unix uses a symlink; Windows tries a directory symlink first (Developer Mode
/// / admin), then falls back to a directory junction (`mklink /J`) which needs
/// no elevation -- the no-elevation linked posture, parallel to the test helper
/// in `registry::tests`. Both forms are classified as `linked` by
/// [`super::registry::is_linked`] and removed link-only by
/// [`super::registry::delete_skill`].
fn link_dir(source: &Path, link_path: &Path) -> std::io::Result<()> {
    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::fs::symlink(source, link_path)
    }
    #[cfg(target_os = "windows")]
    {
        if std::os::windows::fs::symlink_dir(source, link_path).is_ok() {
            return Ok(());
        }
        junction_via_mklink(source, link_path)
    }
}

/// Windows-only junction fallback: `cmd /C mklink /J link_path source`.
/// `mklink /J` creates a directory junction without the symlink privilege, so
/// it is the reliable linked posture on a stock Windows account. Junctions lack
/// the symlink flag, but [`super::registry::is_linked`] also checks the
/// reparse-point attribute, so the junction reads back as `acquired: linked`.
#[cfg(target_os = "windows")]
fn junction_via_mklink(source: &Path, link_path: &Path) -> std::io::Result<()> {
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link_path)
        .arg(source)
        .output()?;
    if output.status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(
            String::from_utf8_lossy(&output.stderr).into_owned(),
        ))
    }
}

/// Recursion depth cap for [`copy_dir_recursive`]. A symlink loop in an
/// untrusted external skill directory would otherwise recurse until stack
/// overflow; 32 levels is well beyond any real skill directory depth.
const COPY_DEPTH_CAP: usize = 32;

/// Recursively copy `src` onto `dst` (issue #367 copy mode). Follows symlinks
/// (`cp -rL` semantics): a symlink inside the skill dir resolves to its
/// target's content, so a copy never strands a broken link pointing outside
/// the tree. `dst` is created if missing. The `depth` parameter caps recursion
/// to guard against symlink loops in untrusted source directories.
fn copy_dir_recursive(src: &Path, dst: &Path, depth: usize) -> std::io::Result<()> {
    if depth >= COPY_DEPTH_CAP {
        return Err(std::io::Error::other(format!(
            "copy recursion depth cap ({COPY_DEPTH_CAP}) exceeded at `{}`; possible symlink loop",
            src.display()
        )));
    }
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        // Follow the link for classification: symlink-to-dir recurses,
        // symlink-to-file copies by content (fs::copy follows the link).
        if fs::metadata(&src_path)?.is_dir() {
            copy_dir_recursive(&src_path, &dst_path, depth + 1)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::model::{Acquired, ImportItem, SKILL_NAME_MAX};
    use super::*;
    use std::path::PathBuf;

    const SKILL_MD: &str = "SKILL.md";

    /// Write one spec-valid skill directory under `root/<name>/`.
    fn put_skill(root: &Path, name: &str, body: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        let content = format!("---\nname: {name}\ndescription: Test skill {name}.\n---\n{body}");
        fs::write(dir.join(SKILL_MD), content).unwrap();
        dir
    }

    /// A source candidate rooted at the given path.
    fn candidate_at(id: &str, label: &str, path: &Path) -> SkillSourceCandidate {
        SkillSourceCandidate {
            id: id.into(),
            label: label.into(),
            path: path.to_path_buf(),
        }
    }

    fn existing(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn discover_drops_missing_candidates_and_classifies_children() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("claude-skills");
        fs::create_dir_all(&lib).unwrap();
        put_skill(&lib, "alpha", "Body.\n");
        put_skill(&lib, "beta", "Body.\n");
        // A non-spec child: missing SKILL.md.
        fs::create_dir_all(lib.join("no-skill-md")).unwrap();

        let candidates = vec![
            candidate_at("claude-code", "Claude Code", &lib),
            // Missing -- dropped.
            candidate_at("codex-cli", "Codex CLI", &tmp.path().join("nope")),
        ];

        let sources = discover_skill_sources(&candidates, &existing(&[]));
        assert_eq!(sources.len(), 1, "missing candidate dropped");
        let src = &sources[0];
        assert_eq!(src.id, "claude-code");
        assert_eq!(src.label, "Claude Code");
        let by_name: std::collections::HashMap<&str, &DiscoveredSkill> =
            src.skills.iter().map(|s| (s.name.as_str(), s)).collect();
        // alpha + beta are importable; no-skill-md is invalid with a reason;
        // all sorted by name.
        assert_eq!(src.skills.len(), 3);
        assert_eq!(by_name["alpha"].status, DiscoveredSkillStatus::Importable);
        assert_eq!(by_name["beta"].status, DiscoveredSkillStatus::Importable);
        assert_eq!(
            by_name["no-skill-md"].status,
            DiscoveredSkillStatus::Invalid
        );
        assert!(by_name["no-skill-md"].reason.is_some());
        assert!(by_name["no-skill-md"]
            .reason
            .as_ref()
            .unwrap()
            .contains("SKILL.md"));
        // Names sorted.
        let names: Vec<&str> = src.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta", "no-skill-md"]);
    }

    #[test]
    fn discover_marks_registry_names_as_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("lib");
        fs::create_dir_all(&lib).unwrap();
        put_skill(&lib, "free", "Body.\n");
        put_skill(&lib, "taken", "Body.\n");

        let sources =
            discover_skill_sources(&[candidate_at("lib", "Lib", &lib)], &existing(&["taken"]));
        let by_name: std::collections::HashMap<&str, DiscoveredSkillStatus> = sources[0]
            .skills
            .iter()
            .map(|s| (s.name.as_str(), s.status))
            .collect();
        assert_eq!(by_name["free"], DiscoveredSkillStatus::Importable);
        assert_eq!(by_name["taken"], DiscoveredSkillStatus::AlreadyExists);
    }

    /// A symlinked source library (the whole `~/.claude/skills` is a link)
    /// still scans -- `is_dir()` follows the link.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn discover_follows_a_symlinked_source_library() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        fs::create_dir_all(&real).unwrap();
        put_skill(&real, "via-link", "Body.\n");
        let linked_lib = tmp.path().join("linked");
        std::os::unix::fs::symlink(&real, &linked_lib).unwrap();

        let sources = discover_skill_sources(
            &[candidate_at("linked", "Linked", &linked_lib)],
            &existing(&[]),
        );
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].skills[0].name, "via-link");
    }

    /// A source that exists but holds no skill directories lists empty (the
    /// row still renders so the user can add a custom path that is empty).
    #[test]
    fn discover_empty_source_lists_with_zero_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let empty = tmp.path().join("empty");
        fs::create_dir_all(&empty).unwrap();
        let sources =
            discover_skill_sources(&[candidate_at("empty", "Empty", &empty)], &existing(&[]));
        assert_eq!(sources.len(), 1);
        assert!(sources[0].skills.is_empty());
    }

    #[test]
    fn import_linked_creates_a_linked_registry_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("lib");
        let source_dir = put_skill(&lib, "external", "External body.\n");
        let root = tmp.path().join("skills"); // minted lazily

        let entry = import_skill(&root, &source_dir, ImportMode::Link).unwrap();
        assert_eq!(entry.name, "external");
        assert_eq!(entry.acquired, Acquired::Linked);
        assert_eq!(entry.body, "External body.\n");
        // entry.acquired == Linked already verifies the link was created
        // (load_skill detects it via is_linked). The raw metadata check is
        // Unix-only because Windows junctions are NOT reported as symlinks by
        // FileType::is_symlink().
        #[cfg(not(target_os = "windows"))]
        assert!(fs::symlink_metadata(root.join("external"))
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false));
        assert!(source_dir.join(SKILL_MD).exists(), "source untouched");
    }

    #[test]
    fn import_copied_creates_a_local_registry_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = tmp.path().join("lib");
        // A skill dir with a non-SKILL.md asset to exercise the recursive copy.
        let source_dir = put_skill(&lib, "bundled", "Body.\n");
        fs::write(source_dir.join("extra.txt"), "asset").unwrap();
        let root = tmp.path().join("skills");

        let entry = import_skill(&root, &source_dir, ImportMode::Copy).unwrap();
        assert_eq!(entry.name, "bundled");
        assert_eq!(entry.acquired, Acquired::Local);
        let copied = root.join("bundled");
        assert!(fs::read_to_string(copied.join(SKILL_MD))
            .unwrap()
            .contains("Body."));
        assert_eq!(
            fs::read_to_string(copied.join("extra.txt")).unwrap(),
            "asset"
        );
        // The copy is a real directory, not a link.
        assert!(!fs::symlink_metadata(&copied)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false));
    }

    #[test]
    fn import_refuses_a_taken_name_and_an_invalid_source() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        // Pre-populate the registry with a skill named "taken".
        super::super::registry::create_skill(&root, "taken", "Already here.").unwrap();
        // An external source that collides.
        let lib = tmp.path().join("lib");
        let collide = put_skill(&lib, "taken", "External body.\n");
        let err = import_skill(&root, &collide, ImportMode::Link).unwrap_err();
        assert_eq!(err, SkillError::NameTaken("taken".into()));

        // A non-spec source (no SKILL.md) is InvalidSkill at commit time.
        let bad = tmp.path().join("bad");
        fs::create_dir_all(&bad).unwrap();
        assert!(matches!(
            import_skill(&root, &bad, ImportMode::Link),
            Err(SkillError::InvalidSkill(_))
        ));
    }

    /// A second import of the same name refuses NameTaken without stranding a
    /// partial copy (the NameTaken check fires before `copy_dir_recursive`).
    #[test]
    fn import_copied_leaves_no_partial_on_retry_after_name_taken() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let lib = tmp.path().join("lib");
        let source = put_skill(&lib, "once", "Body.\n");

        import_skill(&root, &source, ImportMode::Copy).unwrap();
        // Second import of the same name refuses without stranding a partial.
        let err = import_skill(&root, &source, ImportMode::Copy).unwrap_err();
        assert_eq!(err, SkillError::NameTaken("once".into()));
        // The first copy is intact (still one real directory).
        assert!(root.join("once").is_dir());
    }

    #[test]
    fn import_batch_collects_per_item_outcomes_preserving_order() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let lib = tmp.path().join("lib");
        let ok_dir = put_skill(&lib, "good", "Body.\n");
        let bad_dir = tmp.path().join("no-skill-md");
        fs::create_dir_all(&bad_dir).unwrap();

        let items = vec![
            ImportItem {
                source_dir: ok_dir.to_string_lossy().into_owned(),
            },
            ImportItem {
                source_dir: bad_dir.to_string_lossy().into_owned(),
            },
        ];
        let outcomes = import_skills(&root, &items, ImportMode::Link);
        assert_eq!(outcomes.len(), 2);
        assert!(matches!(outcomes[0], ImportOutcome::Imported(_)));
        assert!(matches!(outcomes[1], ImportOutcome::Failed(_)));
    }

    /// A mid-copy failure rolls back the partial copy so the name is free for
    /// a retry. We simulate by placing an unreadable file inside the source
    /// skill directory (Unix-only -- `fs::copy` fails with EACCES on a
    /// 000-permission file when not running as root).
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn import_copied_rolls_back_partial_on_mid_copy_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let lib = tmp.path().join("lib");
        let source = put_skill(&lib, "has-bad-file", "Body.\n");
        // A subdirectory with an unreadable file -- fs::copy fails with EACCES.
        let subdir = source.join("assets");
        fs::create_dir_all(&subdir).unwrap();
        let bad_file = subdir.join("unreadable.txt");
        fs::write(&bad_file, "content").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bad_file, fs::Permissions::from_mode(0o000)).unwrap();

        let err = import_skill(&root, &source, ImportMode::Copy).unwrap_err();
        assert!(matches!(err, SkillError::FsFailure(_)));
        // Rollback: the partial copy was removed so the name is free.
        assert!(
            !root.join("has-bad-file").exists(),
            "partial copy rolled back"
        );
        // Restore permissions so the tempdir cleanup can remove the file.
        let _ = fs::set_permissions(&bad_file, fs::Permissions::from_mode(0o644));
    }

    /// A symlink loop inside a copy-mode source hits the depth cap instead of
    /// recursing until stack overflow (Unix-only -- symlinks are the vector).
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn import_copied_rejects_symlink_loop_via_depth_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills");
        let lib = tmp.path().join("lib");
        let source = put_skill(&lib, "looped", "Body.\n");
        // Create a symlink loop: source/loop -> source (self-reference).
        std::os::unix::fs::symlink(&source, source.join("loop")).unwrap();

        let err = import_skill(&root, &source, ImportMode::Copy).unwrap_err();
        assert!(matches!(err, SkillError::FsFailure(_)));
        let msg = err.to_string();
        assert!(
            msg.contains("depth cap") || msg.contains("symlink loop"),
            "error should mention depth cap or symlink loop: {msg}"
        );
        // Rollback: partial copy removed.
        assert!(
            !root.join("looped").exists(),
            "partial copy rolled back after depth cap"
        );
    }

    /// A name at the spec ceiling imports through both modes (the name rule
    /// accepts it, and the directory scan + link / copy treat it as any other).
    #[test]
    fn import_accepts_a_name_at_the_spec_ceiling() {
        let tmp = tempfile::tempdir().unwrap();
        let max = "a".repeat(SKILL_NAME_MAX);
        let lib = tmp.path().join("lib");
        let source = put_skill(&lib, &max, "Body.\n");
        let root = tmp.path().join("skills");
        let entry = import_skill(&root, &source, ImportMode::Link).unwrap();
        assert_eq!(entry.name.len(), SKILL_NAME_MAX);
    }
}
