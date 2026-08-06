//! Skills registry scan + CRUD over the skills root (issue #362, ADR-0086).
//!
//! The registry is the directory itself: every `<root>/<name>/` holding a
//! spec-valid `SKILL.md` IS one skill (directory scan = registry, no sidecar,
//! no app-config entry). The loader derives `acquired` from the filesystem
//! nature of the directory (symlink / junction -> `linked`, real directory ->
//! `local`). Every function takes the root as a parameter -- pure of Tauri
//! state, so the whole surface is black-box testable against a tempdir.

use std::fs;
use std::path::{Path, PathBuf};

use serde_yaml::Value;

use super::frontmatter;
use super::model::{
    validate_body, validate_description, validate_skill_name, Acquired, SkillEntry, SkillError,
    SkillListing, SkillUpdate, SkippedSkill,
};
use crate::util::sha256_hex;

/// The markdown body a freshly minted skill starts with. The spec requires a
/// non-blank body (it is the prompt fragment); the drawer invites the real
/// text on first edit.
pub const SKELETON_BODY: &str = "Describe when and how to use this skill.\n";

/// The one file the registry reads / writes per skill directory.
const SKILL_MD: &str = "SKILL.md";
/// Temp-file suffix for the atomic rewrite. Same directory as the target so
/// the rename is intra-volume (mirrors `crate::persistence::io`).
const TMP_SUFFIX: &str = ".tmp";

/// Every spec-valid skill under `root`, sorted by name for a stable listing,
/// plus the directories the scan SKIPPED with their English technical reason
/// (issue #373). A missing root lists empty (a never-created registry is a
/// valid state). Directories that fail the spec (no `SKILL.md`, malformed
/// frontmatter, name / directory mismatch, blank body) are skipped -- the
/// listing never fabricates an entry and one broken skill never hides the
/// rest. Each skip is logged server-side AND surfaced in `ignored` so the
/// settings UI can show WHY a directory disappeared instead of debugging from
/// silence; `ignored` is sorted by directory name for a deterministic listing.
pub fn list_skills(root: &Path) -> SkillListing {
    let Ok(entries) = fs::read_dir(root) else {
        return SkillListing {
            skills: Vec::new(),
            ignored: Vec::new(),
        };
    };
    let mut skills = Vec::new();
    let mut ignored = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // Follow the link for the directory check: a symlink / junction ONTO a
        // directory is a skill directory (the linked posture); a dangling link
        // or a link to a file is not.
        let is_dir = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        match load_skill(&path) {
            Ok(skill) => skills.push(skill),
            Err(e) => {
                log::warn!(
                    target: "skills",
                    "skipping non-spec skill directory `{}`: {e}",
                    path.display()
                );
                // The directory name is the user-facing handle (parallel to
                // SkillEntry::name). `to_string_lossy` keeps each non-UTF-8
                // name distinct (different byte sequences map to different
                // lossy strings) so two non-UTF-8 directories never collapse
                // into one row + React key; a path with no file_name
                // component falls back to a positional sentinel.
                let dir = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| format!("<unnamed-entry-{}>", ignored.len()));
                ignored.push(SkippedSkill {
                    dir,
                    reason: e.to_string(),
                });
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    ignored.sort_by(|a, b| a.dir.cmp(&b.dir));
    SkillListing { skills, ignored }
}

/// Mint a new `local` skill: `<root>/<name>/SKILL.md` with the given
/// description + the skeleton body. The registry root is created lazily on
/// first mint. Returns the entry read back from disk.
pub fn create_skill(root: &Path, name: &str, description: &str) -> Result<SkillEntry, SkillError> {
    validate_skill_name(name)?;
    validate_description(description)?;
    fs::create_dir_all(root).map_err(|e| fs_err("create skills root", root, e))?;
    let dir = root.join(name);
    if dir.exists() {
        return Err(SkillError::NameTaken(name.to_string()));
    }
    fs::create_dir(&dir).map_err(|e| fs_err("create skill directory", &dir, e))?;
    let mut fm = serde_yaml::Mapping::new();
    fm.insert(Value::String("name".into()), Value::String(name.into()));
    fm.insert(
        Value::String("description".into()),
        Value::String(description.into()),
    );
    let content = frontmatter::render_skill_md(&fm, SKELETON_BODY)?;
    if let Err(e) = write_skill_md(&dir, &content) {
        // Do not leave an empty directory behind a failed mint (it would
        // surface as NameTaken on the user's retry).
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    load_skill(&dir)
}

/// RAII guard for an in-flight rename in [`update_skill`]: if still armed on
/// drop, restore the original name (panic-safe best effort -- a rollback
/// failure is logged because Drop cannot surface it). The normal Err path
/// disarms and rolls back manually so the rollback failure can be folded
/// into the returned error.
struct RenameGuard {
    from: PathBuf,
    to: PathBuf,
    armed: bool,
}

impl Drop for RenameGuard {
    fn drop(&mut self) {
        if self.armed {
            if let Err(re) = fs::rename(&self.to, &self.from) {
                log::warn!(
                    target: "skills",
                    "panic rollback of `{}` -> `{}` failed: {re}",
                    self.to.display(),
                    self.from.display()
                );
            }
        }
    }
}

/// Rewrite one `local` skill's `SKILL.md` (frontmatter + body) atomically.
/// `name` addresses the CURRENT directory; `update.name` is the identity to
/// WRITE -- a different value renames the directory first (refusing a taken
/// target), with a compensating rename-back when the subsequent write fails,
/// so a partial failure never strands a name / directory mismatch. Refuses a
/// `linked` skill (the app never writes through an external link). Unknown
/// frontmatter keys survive the edit verbatim (the write mutates the PARSED
/// mapping, see `frontmatter::set_*`).
pub fn update_skill(
    root: &Path,
    name: &str,
    update: SkillUpdate,
) -> Result<SkillEntry, SkillError> {
    let dir = existing_skill_dir(root, name)?;
    let current = load_skill(&dir)?;
    if current.acquired == Acquired::Linked {
        return Err(SkillError::ReadOnly(name.to_string()));
    }
    validate_skill_name(&update.name)?;
    validate_description(&update.description)?;
    validate_body(&update.body)?;

    // Rename first when the identity changes, then rewrite in the new home.
    // The guard keeps the registry self-consistent if the rewrite path errors
    // or unwinds: armed through the closure, disarmed on the Ok path; on the
    // Err path the manual rollback folds its own failure into the returned
    // error, and an armed drop (e.g. a panic mid-closure) is the last-ditch
    // best-effort rollback with a log warn.
    let mut guard = if update.name != name {
        let target = root.join(&update.name);
        if target.exists() {
            return Err(SkillError::NameTaken(update.name.clone()));
        }
        fs::rename(&dir, &target).map_err(|e| fs_err("rename skill directory", &target, e))?;
        Some(RenameGuard {
            from: dir.clone(),
            to: target,
            armed: true,
        })
    } else {
        None
    };
    let work_dir = guard
        .as_ref()
        .map(|g| g.to.clone())
        .unwrap_or_else(|| dir.clone());

    let result = (|| -> Result<SkillEntry, SkillError> {
        let md_path = work_dir.join(SKILL_MD);
        let raw = fs::read_to_string(&md_path).map_err(|e| fs_err("read SKILL.md", &md_path, e))?;
        let parsed = frontmatter::parse_skill_md(&raw).map_err(SkillError::InvalidSkill)?;
        let mut fm = parsed.frontmatter;
        frontmatter::set_string_or_remove(&mut fm, "name", Some(&update.name));
        frontmatter::set_string_or_remove(&mut fm, "description", Some(&update.description));
        frontmatter::set_string_or_remove(&mut fm, "license", update.license.as_deref());
        frontmatter::set_string_or_remove(
            &mut fm,
            "compatibility",
            update.compatibility.as_deref(),
        );
        frontmatter::set_mcp_servers(&mut fm, &update.mcp_servers);
        let content = frontmatter::render_skill_md(&fm, &update.body)?;
        write_skill_md(&work_dir, &content)?;
        load_skill(&work_dir)
    })();
    match result {
        Ok(entry) => {
            if let Some(g) = guard.as_mut() {
                g.armed = false;
            }
            Ok(entry)
        }
        Err(e) => {
            if let Some(g) = guard.as_mut() {
                g.armed = false;
                if let Err(re) = fs::rename(&g.to, &g.from) {
                    return Err(SkillError::FsFailure(format!(
                        "{e}; ALSO failed to roll back rename `{}` -> `{}`: {re}",
                        g.to.display(),
                        g.from.display()
                    )));
                }
            }
            Err(e)
        }
    }
}

/// Delete one skill from the registry. For a `local` skill this removes the
/// directory and everything in it; for a `linked` skill it removes the LINK
/// ONLY (the external source directory is never touched). A name outside the
/// spec, or one with no directory, is `NoSuchSkill`.
pub fn delete_skill(root: &Path, name: &str) -> Result<(), SkillError> {
    // A non-spec name cannot address a registry skill -- and validating keeps
    // the path join traversal-safe (the name is IPC-supplied).
    if !super::model::is_valid_skill_name(name) {
        return Err(SkillError::NoSuchSkill(name.to_string()));
    }
    let dir = root.join(name);
    let meta = match fs::symlink_metadata(&dir) {
        Ok(m) => m,
        Err(_) => return Err(SkillError::NoSuchSkill(name.to_string())),
    };
    if is_linked(&meta) {
        // Remove the reparse point / link itself. Windows: RemoveDirectoryW
        // deletes a junction / directory-symlink without following it. Unix:
        // unlink removes the symlink itself (remove_dir_all would follow it
        // into the external source -- never).
        #[cfg(target_os = "windows")]
        let result = fs::remove_dir(&dir);
        #[cfg(not(target_os = "windows"))]
        let result = fs::remove_file(&dir);
        return result.map_err(|e| fs_err("remove skill link", &dir, e));
    }
    if !meta.is_dir() {
        return Err(SkillError::NoSuchSkill(name.to_string()));
    }
    fs::remove_dir_all(&dir).map_err(|e| fs_err("delete skill directory", &dir, e))
}

// --- internals ---------------------------------------------------------------

/// Resolve an IPC-supplied name to an existing skill directory: the name must
/// be spec-shaped (kebab-case keeps the join traversal-safe) AND the directory
/// must exist.
fn existing_skill_dir(root: &Path, name: &str) -> Result<PathBuf, SkillError> {
    if !super::model::is_valid_skill_name(name) {
        return Err(SkillError::NoSuchSkill(name.to_string()));
    }
    let dir = root.join(name);
    // Follow the link: a junction onto a directory is a skill directory.
    let is_dir = fs::metadata(&dir).map(|m| m.is_dir()).unwrap_or(false);
    if !is_dir {
        return Err(SkillError::NoSuchSkill(name.to_string()));
    }
    Ok(dir)
}

/// Load + validate one skill directory into its wire entry.
pub(crate) fn load_skill(dir: &Path) -> Result<SkillEntry, SkillError> {
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| {
            SkillError::InvalidSkill(format!("`{}` is not a UTF-8 name", dir.display()))
        })?
        .to_string();
    let md_path = dir.join(SKILL_MD);
    // Read raw bytes so the content_hash covers the exact bytes the assembly
    // path (skills/prompt.rs) hashes -- a SKILL.md whose body holds non-UTF-8
    // bytes stays loaded (lossy-decoded) rather than failing the whole read,
    // keeping the drift signal truthful. Matches the prompt.rs read + lossy
    // pattern; the frontmatter parser takes the lossy-decoded text.
    let bytes = fs::read(&md_path).map_err(|e| {
        SkillError::InvalidSkill(format!("cannot read `{}`: {e}", md_path.display()))
    })?;
    let raw = String::from_utf8_lossy(&bytes);
    let parsed = frontmatter::parse_skill_md(&raw).map_err(SkillError::InvalidSkill)?;

    let fm = &parsed.frontmatter;
    let name = frontmatter::get_string(fm, "name").ok_or_else(|| {
        SkillError::InvalidSkill(format!("`{dir_name}/SKILL.md` has no string `name` field"))
    })?;
    validate_skill_name(&name)?;
    if name != dir_name {
        return Err(SkillError::InvalidSkill(format!(
            "frontmatter name `{name}` does not match its directory name `{dir_name}`"
        )));
    }
    let description = frontmatter::get_string(fm, "description").ok_or_else(|| {
        SkillError::InvalidSkill(format!(
            "`{dir_name}/SKILL.md` has no string `description` field"
        ))
    })?;
    validate_description(&description)?;
    validate_body(&parsed.body)?;

    // Derive acquired off the directory's own metadata (never following the
    // link), and resolve the target for the "open source location" anchor.
    let is_link = fs::symlink_metadata(dir)
        .map(|m| is_linked(&m))
        .unwrap_or(false);
    let acquired = if is_link {
        Acquired::Linked
    } else {
        Acquired::Local
    };
    let link_target = if is_link { link_target_of(dir) } else { None };

    Ok(SkillEntry {
        name,
        description,
        acquired,
        license: frontmatter::get_string(fm, "license"),
        compatibility: frontmatter::get_string(fm, "compatibility"),
        mcp_servers: frontmatter::mcp_servers(fm),
        body: parsed.body,
        link_target,
        content_hash: sha256_hex(&bytes),
    })
}

/// Resolve a link's target to an absolute path for the frontend's reveal
/// (relative targets resolve against the link's parent). Best effort: an
/// unreadable link degrades to None, never a listing failure.
fn link_target_of(dir: &Path) -> Option<String> {
    let target = fs::read_link(dir).ok()?;
    let absolute = if target.is_absolute() {
        target
    } else {
        dir.parent()?.join(target)
    };
    Some(absolute.to_string_lossy().into_owned())
}

/// Atomic SKILL.md write: temp file in the same directory + rename, so a
/// crash mid-write leaves either the old complete file or the new one.
fn write_skill_md(dir: &Path, content: &str) -> Result<(), SkillError> {
    let target = dir.join(SKILL_MD);
    let tmp = dir.join(format!("{SKILL_MD}{TMP_SUFFIX}"));
    fs::write(&tmp, content).map_err(|e| fs_err("write SKILL.md temp file", &tmp, e))?;
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(fs_err("replace SKILL.md", &target, e));
    }
    Ok(())
}

/// The FsFailure constructor: the operation + path + OS detail, English (the
/// technical-detail fold; user-facing wording lives in the locale catalog).
pub(crate) fn fs_err(op: &str, path: &Path, e: std::io::Error) -> SkillError {
    SkillError::FsFailure(format!("{op} failed for `{}`: {e}", path.display()))
}

/// Classify a directory's own metadata as a linked posture (symlink or Windows
/// junction) without following it. `FileType::is_symlink()` does NOT cover
/// Windows directory junctions (`IO_REPARSE_TAG_MOUNT_POINT` created by
/// `mklink /J` -- the no-elevation fallback `try_link` uses); junctions still
/// carry `FILE_ATTRIBUTE_REPARSE_POINT`, so we re-check the attribute flags.
/// Without this, the loader would misclassify a junction as `Local` and
/// `delete_skill`'s `remove_dir_all` would follow it into the external source
/// (ADR-0086 Decision 1 violation).
fn is_linked(md: &fs::Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        md.file_type().is_symlink() || (md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    }
    #[cfg(not(target_os = "windows"))]
    {
        md.file_type().is_symlink()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write one skill directory with the given frontmatter fields + body.
    fn put_skill(root: &Path, name: &str, extra_fields: &str, body: &str) -> PathBuf {
        let dir = root.join(name);
        fs::create_dir_all(&dir).expect("create skill dir");
        let content = format!(
            "---\nname: {name}\ndescription: Test skill {name}.{extra_fields}\n---\n{body}"
        );
        fs::write(dir.join(SKILL_MD), content).expect("write SKILL.md");
        dir
    }

    fn update_payload(name: &str) -> SkillUpdate {
        SkillUpdate {
            name: name.into(),
            description: "Updated description.".into(),
            license: None,
            compatibility: None,
            mcp_servers: Vec::new(),
            body: "Updated body.\n".into(),
        }
    }

    /// Create a symlink `link -> target`, returning false when the platform
    /// refuses (e.g. Windows without the symlink privilege) so the caller can
    /// skip the linked-path assertions instead of failing. CI runs on Linux,
    /// where the symlink always lands.
    fn try_link(target: &Path, link: &Path) -> bool {
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(target_os = "windows")]
        {
            if std::os::windows::fs::symlink_dir(target, link).is_ok() {
                return true;
            }
            // No symlink privilege: fall back to a directory junction
            // (`mklink /J` needs no elevation). `is_linked` treats both forms
            // as `linked` via the reparse tag (a junction is NOT reported as a
            // symlink by `FileType::is_symlink`), and `delete_skill` removes
            // the junction itself without following it into the source.
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        }
    }

    /// A skill directory living OUTSIDE the registry + a symlink inside the
    /// registry pointing at it (the imported-linked shape). Returns the
    /// registry root; None when the platform refused the symlink.
    fn linked_fixture(root: &Path, name: &str) -> Option<PathBuf> {
        let outside = root.join("outside");
        put_skill(&outside, name, "", "External body.\n");
        let registry = root.join("skills");
        fs::create_dir(&registry).unwrap();
        if !try_link(&outside.join(name), &registry.join(name)) {
            return None;
        }
        Some(registry)
    }

    #[test]
    fn list_empty_when_root_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("skills");
        let listing = list_skills(&missing);
        assert!(listing.skills.is_empty());
        assert!(listing.ignored.is_empty());
    }

    #[test]
    fn list_returns_spec_valid_skills_sorted_and_skips_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "beta", "", "Body.\n");
        put_skill(root, "alpha", "", "Body.\n");
        // Non-spec residents: no SKILL.md / plain file / name mismatch.
        fs::create_dir(root.join("no-skill-md")).unwrap();
        fs::write(root.join("plain-file.txt"), "x").unwrap();
        let mismatch = root.join("mismatch");
        fs::create_dir(&mismatch).unwrap();
        fs::write(
            mismatch.join(SKILL_MD),
            "---\nname: other\ndescription: d\n---\nbody\n",
        )
        .unwrap();

        let listing = list_skills(root);
        let names: Vec<_> = listing.skills.iter().map(|s| s.name.clone()).collect();
        assert_eq!(names, vec!["alpha".to_string(), "beta".to_string()]);
        // Plain files never enter the directory scan, so only the two real
        // directories do -- sorted by name for a stable ignored listing.
        let ignored: Vec<_> = listing.ignored.iter().map(|s| s.dir.clone()).collect();
        assert_eq!(
            ignored,
            vec!["mismatch".to_string(), "no-skill-md".to_string()]
        );
    }

    /// A skipped directory surfaces its English technical reason (issue #373).
    /// The reason is the SkillError Display string -- the frontend renders it
    /// verbatim as the diagnostic fold, so the user sees WHY the directory
    /// disappeared (here: the frontmatter name does not match the directory).
    #[test]
    fn list_surfaces_skipped_directories_with_their_reason() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "good", "", "Body.\n");
        // Two distinct failure modes: name mismatch + missing SKILL.md.
        let mismatch = root.join("mismatch-dir");
        fs::create_dir(&mismatch).unwrap();
        fs::write(
            mismatch.join(SKILL_MD),
            "---\nname: other\ndescription: d\n---\nbody\n",
        )
        .unwrap();
        fs::create_dir(root.join("no-skill-md")).unwrap();

        let listing = list_skills(root);
        let by_dir: std::collections::HashMap<&str, &str> = listing
            .ignored
            .iter()
            .map(|s| (s.dir.as_str(), s.reason.as_str()))
            .collect();
        assert_eq!(listing.ignored.len(), 2);
        let mismatch_reason = by_dir["mismatch-dir"];
        assert!(
            mismatch_reason.contains("mismatch-dir"),
            "reason should name the directory, got: {mismatch_reason}"
        );
        assert!(
            mismatch_reason.contains("other"),
            "reason should name the conflicting frontmatter name, got: {mismatch_reason}"
        );
        let noskill_reason = by_dir["no-skill-md"];
        assert!(
            noskill_reason.contains("SKILL.md"),
            "missing-SKILL.md reason should reference the file, got: {noskill_reason}"
        );
    }

    #[test]
    fn list_derives_local_for_real_directories() {
        let tmp = tempfile::tempdir().unwrap();
        put_skill(tmp.path(), "mine", "", "Body.\n");
        let entry = &list_skills(tmp.path()).skills[0];
        assert_eq!(entry.acquired, Acquired::Local);
        assert_eq!(entry.link_target, None);
        assert_eq!(entry.description, "Test skill mine.");
        assert_eq!(entry.body, "Body.\n");
    }

    #[test]
    fn list_derives_linked_for_symlinked_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(registry) = linked_fixture(tmp.path(), "external-skill") else {
            eprintln!("skipping: platform refused symlink creation");
            return;
        };
        let skills = list_skills(&registry).skills;
        let linked = skills.iter().find(|s| s.name == "external-skill").unwrap();
        assert_eq!(linked.acquired, Acquired::Linked);
        assert!(linked.link_target.is_some());
        assert_eq!(linked.body, "External body.\n");
    }

    /// Windows-only regression: a directory junction (`mklink /J`) is the
    /// no-elevation linked path on Windows. `FileType::is_symlink()` returns
    /// false for one, so the reparse-tag branch of `is_linked` is what keeps
    /// the linked-local contract (ADR-0086 Decision 1) and the link-only delete
    /// honest. Not compiled on non-Windows platforms.
    #[cfg(target_os = "windows")]
    #[test]
    fn junction_classified_as_linked_and_delete_preserves_source() {
        let tmp = tempfile::tempdir().unwrap();
        let source_dir = tmp.path().join("outside").join("external-skill");
        let body = "External body.\n";
        let content = format!(
            "---\nname: external-skill\ndescription: Test skill external-skill.\n---\n{body}"
        );
        fs::create_dir_all(&source_dir).unwrap();
        fs::write(source_dir.join(SKILL_MD), content).unwrap();
        // Sentinel: if delete follows the junction, this disappears and the
        // assertion fails.
        fs::write(source_dir.join("marker"), "preserved").unwrap();

        let registry = tmp.path().join("skills");
        fs::create_dir(&registry).unwrap();
        let link = registry.join("external-skill");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&source_dir)
            .status()
            .expect("spawn mklink");
        if !status.success() {
            eprintln!("skipping: junction creation refused");
            return;
        }

        let skills = list_skills(&registry).skills;
        let linked = skills
            .iter()
            .find(|s| s.name == "external-skill")
            .expect("junction must list as a skill");
        assert_eq!(
            linked.acquired,
            Acquired::Linked,
            "junction misclassified as Local"
        );

        delete_skill(&registry, "external-skill").expect("delete linked skill");
        assert!(
            source_dir.join("marker").exists(),
            "junction delete followed into the external source"
        );
        assert!(!link.exists(), "junction itself must be removed");
    }

    #[test]
    fn create_mints_directory_with_skeleton_skill_md() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("skills"); // minted lazily
        let entry = create_skill(&root, "pdf-tools", "Work with PDF files.").unwrap();
        assert_eq!(entry.name, "pdf-tools");
        assert_eq!(entry.description, "Work with PDF files.");
        assert_eq!(entry.acquired, Acquired::Local);
        assert_eq!(entry.body, SKELETON_BODY);
        // The minted file is on disk + spec-valid (list reads it back).
        let raw = fs::read_to_string(root.join("pdf-tools").join(SKILL_MD)).unwrap();
        assert!(raw.starts_with("---\nname: pdf-tools\n"));
        let listed = list_skills(&root).skills;
        assert_eq!(listed.len(), 1);
        assert!(listed[0].mcp_servers.is_empty());
    }

    #[test]
    fn load_skill_content_hash_hashes_the_raw_file_bytes() {
        // Regression for the registry/assembly hash symmetry (issue #381,
        // ADR-0086): load_skill must hash the exact file bytes -- the same
        // input the assembly path (skills/prompt.rs resolve_one) hashes via
        // the shared crate::util::sha256_hex, so an unedited skill yields
        // identical hashes both places and the drift signal stays exact.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = put_skill(root, "sql-coach", "", "Body text.\n");
        let entry = load_skill(&dir).expect("load_skill succeeds");
        let bytes = fs::read(dir.join(SKILL_MD)).expect("read SKILL.md bytes");
        assert_eq!(entry.content_hash, sha256_hex(&bytes));
        assert_eq!(entry.content_hash.len(), 64);
    }

    #[test]
    fn create_refuses_invalid_name_blank_description_and_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(matches!(
            create_skill(root, "Bad_Name", "d"),
            Err(SkillError::InvalidName(_))
        ));
        assert!(matches!(
            create_skill(root, "ok-name", "   "),
            Err(SkillError::InvalidSkill(_))
        ));
        create_skill(root, "taken", "d").unwrap();
        assert!(matches!(
            create_skill(root, "taken", "d"),
            Err(SkillError::NameTaken(_))
        ));
    }

    #[test]
    fn update_rewrites_frontmatter_and_body_preserving_unknown_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join("keeper");
        fs::create_dir(&dir).unwrap();
        fs::write(
            dir.join(SKILL_MD),
            "---\nname: keeper\ndescription: d\nlicense: MIT\nallowed-tools:\n  - Bash\n---\nold body\n",
        )
        .unwrap();

        let mut payload = update_payload("keeper");
        payload.license = Some("Apache-2.0".into());
        payload.compatibility = Some("requires network".into());
        payload.mcp_servers = vec!["github-mcp".into(), "fs-server".into()];
        let entry = update_skill(root, "keeper", payload).unwrap();

        assert_eq!(entry.description, "Updated description.");
        assert_eq!(entry.license.as_deref(), Some("Apache-2.0"));
        assert_eq!(entry.compatibility.as_deref(), Some("requires network"));
        assert_eq!(
            entry.mcp_servers,
            vec!["github-mcp".to_string(), "fs-server".to_string()]
        );
        assert_eq!(entry.body, "Updated body.\n");
        // The field this app does not surface survives verbatim.
        let raw = fs::read_to_string(dir.join(SKILL_MD)).unwrap();
        assert!(raw.contains("allowed-tools"), "foreign field lost: {raw}");
        // No temp file lingers behind the atomic write.
        assert!(!dir.join(format!("{SKILL_MD}{TMP_SUFFIX}")).exists());
    }

    #[test]
    fn update_clears_optional_fields_when_blank() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "clearer", "\nlicense: MIT", "Body.\n");
        // None license -> the key disappears from the frontmatter.
        let entry = update_skill(root, "clearer", update_payload("clearer")).unwrap();
        assert_eq!(entry.license, None);
        let raw = fs::read_to_string(root.join("clearer").join(SKILL_MD)).unwrap();
        assert!(!raw.contains("license:"), "cleared key must be gone: {raw}");
    }

    #[test]
    fn update_renames_directory_with_frontmatter() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "old-name", "", "Body.\n");
        let mut payload = update_payload("new-name");
        payload.body = "Renamed body.\n".into();
        let entry = update_skill(root, "old-name", payload).unwrap();
        assert_eq!(entry.name, "new-name");
        assert!(!root.join("old-name").exists());
        let raw = fs::read_to_string(root.join("new-name").join(SKILL_MD)).unwrap();
        assert!(raw.contains("name: new-name"));
        assert!(raw.contains("Renamed body."));
    }

    #[test]
    fn update_rename_refuses_a_taken_target_and_keeps_original() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "source-skill", "", "Body.\n");
        put_skill(root, "occupied", "", "Body.\n");
        let payload = update_payload("occupied");
        let err = update_skill(root, "source-skill", payload).unwrap_err();
        assert_eq!(err, SkillError::NameTaken("occupied".into()));
        assert!(root.join("source-skill").exists(), "original must survive");
    }

    #[test]
    fn rename_guard_rolls_back_on_drop_when_armed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let from = root.join("from");
        let to = root.join("to");
        fs::create_dir(&from).unwrap();
        fs::rename(&from, &to).unwrap();
        // Armed on drop (panic analog): the original name is restored.
        drop(RenameGuard {
            from: from.clone(),
            to: to.clone(),
            armed: true,
        });
        assert!(from.is_dir(), "armed guard must roll back");
        assert!(!to.exists(), "armed guard must remove the renamed target");
    }

    #[test]
    fn rename_guard_leaves_rename_in_place_when_disarmed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let from = root.join("from");
        let to = root.join("to");
        fs::create_dir(&from).unwrap();
        fs::rename(&from, &to).unwrap();
        let mut g = RenameGuard {
            from,
            to: to.clone(),
            armed: true,
        };
        g.armed = false;
        drop(g);
        assert!(to.is_dir(), "disarmed guard must leave the rename in place");
    }

    #[test]
    fn update_refuses_linked_and_missing_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(matches!(
            update_skill(root, "ghost", update_payload("ghost")),
            Err(SkillError::NoSuchSkill(_))
        ));
        // A non-spec addressing name cannot exist in the registry.
        assert!(matches!(
            update_skill(root, "../escape", update_payload("x")),
            Err(SkillError::NoSuchSkill(_))
        ));

        let Some(registry) = linked_fixture(root, "external-skill") else {
            eprintln!("skipping linked half: platform refused symlink creation");
            return;
        };
        let err = update_skill(
            &registry,
            "external-skill",
            update_payload("external-skill"),
        )
        .unwrap_err();
        assert_eq!(err, SkillError::ReadOnly("external-skill".into()));
        // The external source file was never touched.
        let raw = fs::read_to_string(registry.join("external-skill").join(SKILL_MD)).unwrap();
        assert!(raw.contains("External body."));
    }

    #[test]
    fn update_validates_the_new_payload() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "valid-target", "", "Body.\n");
        let bad_name = update_payload("Bad_Name");
        assert!(matches!(
            update_skill(root, "valid-target", bad_name),
            Err(SkillError::InvalidName(_))
        ));
        let blank_body = SkillUpdate {
            body: "  ".into(),
            ..update_payload("valid-target")
        };
        assert!(matches!(
            update_skill(root, "valid-target", blank_body),
            Err(SkillError::InvalidSkill(_))
        ));
    }

    #[test]
    fn delete_removes_a_local_skill_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = put_skill(root, "doomed", "", "Body.\n");
        fs::write(dir.join("extra-asset.txt"), "x").unwrap();
        delete_skill(root, "doomed").unwrap();
        assert!(!dir.exists());
        assert!(matches!(
            delete_skill(root, "doomed"),
            Err(SkillError::NoSuchSkill(_))
        ));
        // A non-spec name is NoSuchSkill (and keeps the join traversal-safe).
        assert!(matches!(
            delete_skill(root, "../escape"),
            Err(SkillError::NoSuchSkill(_))
        ));
    }

    #[test]
    fn delete_linked_removes_only_the_link_and_keeps_the_source() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let Some(registry) = linked_fixture(root, "external-skill") else {
            eprintln!("skipping: platform refused symlink creation");
            return;
        };
        let link = registry.join("external-skill");
        let source_dir = root.join("outside").join("external-skill");

        delete_skill(&registry, "external-skill").unwrap();
        assert!(!link.exists(), "the link must be gone");
        assert!(source_dir.exists(), "the external source must survive");
        assert!(source_dir.join(SKILL_MD).exists());
    }
}
