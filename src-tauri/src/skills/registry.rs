//! Skills registry scan + CRUD over the skills root (issue #362, ADR-0086).
//!
//! The registry is the directory itself: every `<root>/<name>/` holding a
//! spec-valid `SKILL.md` IS one skill (directory scan = registry, no sidecar,
//! no app-config entry), PLUS the reserved `.system/` subtree's children --
//! the builtin rows, merged with the shadowing rule (ADR-0121 Decision 5):
//! a local directory owning a builtin's name suppresses the builtin row, so
//! the name resolves to ONE row everywhere. The loader derives `acquired`
//! from location (`linked` = symlink / junction onto an external source,
//! `local` = real directory, `builtin` = under the reserved subtree). Every
//! function takes the root as a parameter -- pure of Tauri state, so the
//! whole surface is black-box testable against a tempdir.
//!
//! Read-back downgrade wiring: the write site (`create_skill_from_markdown`)
//! threads `read_back_or_derive` over the fresh load parts, and that wiring
//! is an ACCEPTED unguarded face (issue #940): the pure half (the structural
//! judgement both ways, the derived-entry equivalence) is pinned by direct
//! tests, but a call-site revert to the bare pre-#936 `load_skill`, or an
//! argument-threading slip, is observable only when the real read-back IO
//! fails -- which never happens in tests. Closing the gap needs a
//! fault-injection seam at the call site, which the repo's no-fabricated-seams
//! precedent counsels against; land one when a second consumer of the wiring
//! justifies it.

use std::fs;
use std::path::Path;

use super::builtin::{is_reserved_skill_name, is_shadowed_by_local, SYSTEM_SUBTREE};
use super::frontmatter;
use super::model::{
    validate_body, validate_description, validate_skill_name, Acquired, SkillEntry, SkillError,
    SkillListing, SkippedSkill,
};
use crate::util::sha256_hex;

/// The one file the registry reads / writes per skill directory.
const SKILL_MD: &str = "SKILL.md";
/// Temp-file suffix for the atomic rewrite. Same directory as the target so
/// the rename is intra-volume (mirrors `crate::persistence::io`).
const TMP_SUFFIX: &str = ".tmp";

/// Every spec-valid skill under `root`, sorted by name for a stable listing,
/// plus the directories the scan SKIPPED with their English technical reason
/// (issue #373), plus a root-level error when the skills root itself could not
/// be read (issue #375). A missing root (`NotFound`) lists empty with no error
/// (a never-created registry is a valid state); any other `read_dir` failure
/// (permission denied, lock contention, etc.) surfaces the English technical
/// reason in `root_error` so the settings UI can distinguish a locked-out root
/// from a clean registry. Directories that fail the spec (no `SKILL.md`,
/// malformed frontmatter, name / directory mismatch, blank body) are skipped
/// -- the listing never fabricates an entry and one broken skill never hides
/// the rest. Each skip is logged server-side AND surfaced in `ignored` so the
/// settings UI can show WHY a directory disappeared instead of debugging from
/// silence; `ignored` is sorted by directory name for a deterministic listing.
/// A directory entry the OS itself could not read (concurrent modification,
/// entry-level permission) is also pushed to `ignored` rather than silently
/// dropped by `flatten()`.
///
/// Hidden directories (dot-prefixed) are skipped by the root scan -- the
/// reserved `.system/` subtree is merged explicitly below (the codex hidden
/// convention, ADR-0121 Decision 3), and other hidden directories are not
/// spec-shaped skill names anyway.
pub fn list_skills(root: &Path) -> SkillListing {
    let mut skills = Vec::new();
    let mut ignored = Vec::new();
    let mut root_error = None;

    match fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => {
                        let path = entry.path();
                        // Follow the link for the directory check: a symlink /
                        // junction ONTO a directory is a skill directory (the
                        // linked posture); a dangling link or a link to a file
                        // is not.
                        let is_dir = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
                        if !is_dir {
                            continue;
                        }
                        // Hidden directories are not skill candidates: the
                        // reserved `.system/` subtree merges explicitly below,
                        // any other dot-directory is internal layout noise
                        // (the import-side convention, issue #418).
                        if path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with('.'))
                        {
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
                                // The directory name is the user-facing handle
                                // (parallel to SkillEntry::name).
                                // `to_string_lossy` keeps each non-UTF-8 name
                                // distinct (different byte sequences map to
                                // different lossy strings) so two non-UTF-8
                                // directories never collapse into one row +
                                // React key; a path with no file_name component
                                // falls back to a positional sentinel.
                                let dir = path
                                    .file_name()
                                    .map(|n| n.to_string_lossy().into_owned())
                                    .unwrap_or_else(|| {
                                        format!("<unnamed-entry-{}>", ignored.len())
                                    });
                                ignored.push(SkippedSkill {
                                    dir,
                                    reason: e.to_string(),
                                });
                            }
                        }
                    }
                    Err(e) => {
                        // The OS could not read one directory entry (concurrent
                        // modification, entry-level permission, transient IO).
                        // Surface it in `ignored` so the entry does not
                        // disappear silently -- parallel to the spec-invalid
                        // skip above. `file_name` is unavailable on an Err, so
                        // use a positional sentinel (issue #375).
                        log::warn!(
                            target: "skills",
                            "error reading a skills directory entry: {e}"
                        );
                        let dir = format!("<unreadable-entry-{}>", ignored.len());
                        ignored.push(SkippedSkill {
                            dir,
                            reason: e.to_string(),
                        });
                    }
                }
            }
        }
        // NotFound is the legitimate "never-created registry" state -- not an
        // error (issue #375).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::warn!(
                target: "skills",
                "failed to read skills root `{}`: {e}",
                root.display()
            );
            root_error = Some(format!("read skills root `{}` failed: {e}", root.display()));
        }
    }

    // The reserved-subtree merge (ADR-0121 Decisions 3/5): the `.system/`
    // children are the builtin rows -- `acquired` by location, whatever
    // spec-valid directory lives there. A same-named local directory
    // SHADOWS the builtin (the row resolves to the fork; the builtin
    // returns on the next scan after the fork is deleted). A missing
    // subtree is the fresh-install state and reads as empty; an unreadable
    // one degrades to a warn plus an ignored entry -- never a listing
    // failure (the root scan's shape, issue #375).
    match fs::read_dir(root.join(SYSTEM_SUBTREE)) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    // The OS could not read one directory entry -- surface
                    // it in `ignored` so the row does not disappear
                    // silently (the root scan's #375 shape).
                    Err(e) => {
                        log::warn!(
                            target: "skills",
                            "error reading a reserved-subtree entry: {e}"
                        );
                        ignored.push(SkippedSkill {
                            dir: format!("{SYSTEM_SUBTREE}/<unreadable-entry-{}>", ignored.len()),
                            reason: e.to_string(),
                        });
                        continue;
                    }
                };
                let path = entry.path();
                // Follow the link for the directory check, same as the root scan.
                let is_dir = fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
                if !is_dir {
                    continue;
                }
                let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                // Hidden children of the reserved subtree stay internal (the
                // alignment marker and any future bookkeeping).
                if dir_name.starts_with('.') {
                    continue;
                }
                // Shadowing: a local directory owning the name suppresses the
                // builtin row entirely -- the name resolves to the fork (the
                // shared shadowing rule, ADR-0121 Decision 5).
                if is_shadowed_by_local(root, dir_name) {
                    continue;
                }
                match load_builtin_skill(&path) {
                    Ok(skill) => skills.push(skill),
                    Err(e) => {
                        log::warn!(
                            target: "skills",
                            "skipping non-spec reserved-subtree directory `{}`: {e}",
                            path.display()
                        );
                        ignored.push(SkippedSkill {
                            dir: format!("{SYSTEM_SUBTREE}/{dir_name}"),
                            reason: e.to_string(),
                        });
                    }
                }
            }
        }
        // Nothing materialized yet is the fresh-install state -- not an
        // error (mirroring the root scan's NotFound arm, issue #375).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            // The root scan's own failure (root_error) already carries the
            // diagnosis -- a subtree read failing the same way is the echo
            // of that fault, not a second one, so it stays silent and one
            // fault reads as one signal.
            if root_error.is_none() {
                log::warn!(
                    target: "skills",
                    "failed to read the reserved subtree `{}`: {e}",
                    root.join(SYSTEM_SUBTREE).display()
                );
                ignored.push(SkippedSkill {
                    dir: SYSTEM_SUBTREE.to_string(),
                    reason: format!("read reserved subtree failed: {e}"),
                });
            }
        }
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    ignored.sort_by(|a, b| a.dir.cmp(&b.dir));
    SkillListing {
        skills,
        ignored,
        root_error,
    }
}

/// Parse + per-field validate a whole `SKILL.md` string (ADR-0122 Decision
/// 1): returns the frontmatter's `name` / `description`. The shared
/// typed-reject face for the whole-string create entry and the model-facing
/// resolver -- validation lives in one place.
pub(crate) fn parse_skill_markdown(markdown: &str) -> Result<(String, String), SkillError> {
    let parsed = frontmatter::parse_skill_md(markdown).map_err(SkillError::InvalidSkill)?;
    let name = frontmatter::get_string(&parsed.frontmatter, "name")
        .ok_or_else(|| SkillError::InvalidSkill("frontmatter is missing a `name` string".into()))?;
    let description =
        frontmatter::get_string(&parsed.frontmatter, "description").ok_or_else(|| {
            SkillError::InvalidSkill("frontmatter is missing a `description` string".into())
        })?;
    validate_skill_name(&name)?;
    if is_reserved_skill_name(&name) {
        return Err(SkillError::ReservedSkillName(name));
    }
    validate_description(&description)?;
    validate_body(&parsed.body)?;
    Ok((name, description))
}

/// Mint one local skill from a whole `SKILL.md` string (ADR-0122 Decision
/// 1): the server-side parse extracts `name` / `description` for per-field
/// validation (the typed-reject face the model self-corrects from), and the
/// bytes written are the INPUT VERBATIM -- unknown frontmatter keys survive
/// (the ecosystem interop interface; consumption reads only the known keys,
/// unknown keys ride as spec-ignore). The validation, reserved-set refusal,
/// NameTaken check, and failed-mint cleanup contract all live in this one
/// entry.
pub fn create_skill_from_markdown(root: &Path, markdown: &str) -> Result<SkillEntry, SkillError> {
    let (name, _description) = parse_skill_markdown(markdown)?;
    fs::create_dir_all(root).map_err(|e| fs_err("create skills root", root, e))?;
    let dir = root.join(&name);
    if dir.exists() {
        return Err(SkillError::NameTaken(name));
    }
    fs::create_dir(&dir).map_err(|e| fs_err("create skill directory", &dir, e))?;
    if let Err(e) = write_skill_md(&dir, markdown) {
        // Do not leave an empty directory behind a failed mint (it would
        // surface as NameTaken on the user's retry).
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    // The reserved-set refusal above keeps a freshly minted name out of the
    // builtin namespace, so the read-back cannot be a builtin skill. A
    // failed transient read-back derives from the written payload (issue
    // #936) -- reporting `Err` there would strand the minted directory and
    // deadlock a retry on NameTaken. A semantic read-back failure
    // (render/parse drift) stays `Err`, and the mint is removed below so
    // the retry succeeds anyway.
    let result = read_back_or_derive(load_skill_parts(&dir), markdown, &name);
    // Same cleanup contract as the write branch above: a failed mint leaves
    // no directory behind (it would surface as NameTaken on the user's
    // retry).
    if result.is_err() {
        let _ = fs::remove_dir_all(&dir);
    }
    result
}

/// Delete one skill from the registry. For a `local` skill this removes the
/// directory and everything in it; for a `linked` skill it removes the LINK
/// ONLY (the external source directory is never touched). A builtin skill
/// (the reserved-subtree copy) is refused (issue #677: builtins are
/// undeletable -- the subtree re-aligns on the next scan; the shutdown axis
/// is the enablement axis). Shadowing note (ADR-0121 Decision 5): a local
/// fork owning a builtin's name deletes normally -- disposing of the fork is
/// how the builtin's row returns. A name outside the spec, or one with
/// no directory anywhere, is `NoSuchSkill`.
pub fn delete_skill(root: &Path, name: &str) -> Result<(), SkillError> {
    // A non-spec name cannot address a registry skill -- and validating keeps
    // the path join traversal-safe (the name is IPC-supplied).
    if !super::model::is_valid_skill_name(name) {
        return Err(SkillError::NoSuchSkill(name.to_string()));
    }
    // The local directory first: present, it owns the name (a fork deletes
    // normally even while the reserved subtree holds the builtin copy).
    let local = root.join(name);
    if let Ok(meta) = fs::symlink_metadata(&local) {
        if is_linked(&meta) {
            // Remove the reparse point / link itself. Windows: RemoveDirectoryW
            // deletes a junction / directory-symlink without following it. Unix:
            // unlink removes the symlink itself (remove_dir_all would follow it
            // into the external source -- never).
            #[cfg(target_os = "windows")]
            let result = fs::remove_dir(&local);
            #[cfg(not(target_os = "windows"))]
            let result = fs::remove_file(&local);
            return result.map_err(|e| fs_err("remove skill link", &local, e));
        }
        if !meta.is_dir() {
            return Err(SkillError::NoSuchSkill(name.to_string()));
        }
        return fs::remove_dir_all(&local).map_err(|e| fs_err("delete skill directory", &local, e));
    }
    // The reserved-subtree copy: the builtin posture.
    let system = root.join(SYSTEM_SUBTREE).join(name);
    if fs::symlink_metadata(&system)
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return Err(SkillError::BuiltinUndeletable(name.to_string()));
    }
    Err(SkillError::NoSuchSkill(name.to_string()))
}

// --- internals ---------------------------------------------------------------

/// The directory's own-metadata posture (never following the link):
/// `Linked` for a symlink / junction onto a directory, `Local` otherwise.
/// Called by the loader's fs half ([`load_skill_parts`]).
fn fs_posture(dir: &Path) -> Acquired {
    if fs::symlink_metadata(dir)
        .map(|m| is_linked(&m))
        .unwrap_or(false)
    {
        Acquired::Linked
    } else {
        Acquired::Local
    }
}

/// The IO half of [`load_skill`] (see there for the full contract): raw
/// SKILL.md bytes + the directory's fs-derived posture.
type SkillParts = (Vec<u8>, String, Acquired, Option<String>);

/// Load + validate one skill directory into its wire entry, with the
/// loader-derived posture (symlink / junction -> `linked`, real directory ->
/// `local`).
pub(crate) fn load_skill(dir: &Path) -> Result<SkillEntry, SkillError> {
    let (bytes, dir_name, acquired, link_target) = load_skill_parts(dir)?;
    assemble_skill_parts(&bytes, &dir_name, acquired, link_target)
}

/// Load + validate one RESERVED-SUBTREE directory into its wire entry: the
/// builtin posture by location (ADR-0121 -- whatever spec-valid directory
/// lives under `.system/` is a builtin row), with the subtree directory as
/// the open anchor (the detail dialog's path bar points there -- the fork
/// channel's starting point).
fn load_builtin_skill(dir: &Path) -> Result<SkillEntry, SkillError> {
    let (bytes, dir_name, _, _) = load_skill_parts(dir)?;
    let reveal = Some(dir.to_string_lossy().into_owned());
    assemble_skill_parts(&bytes, &dir_name, Acquired::Builtin, reveal)
}

/// The IO half of the loaders: read the SKILL.md bytes and derive the
/// directory's posture. Split out so [`read_back_or_derive`] can tell a
/// transient read failure apart from a parse/validation failure BY STRUCTURE,
/// not by matching the error payload (issue #936) -- a read failure maps to
/// `InvalidSkill` here, and that mapping is the scan surface's documented
/// contract (`SkippedSkill::reason`), so it stays untouched.
fn load_skill_parts(dir: &Path) -> Result<SkillParts, SkillError> {
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
    // Derive acquired off the directory's own metadata (never following the
    // link), and resolve the target for the detail dialog's open anchor.
    let fs_acquired = fs_posture(dir);
    let link_target = if matches!(fs_acquired, Acquired::Linked) {
        link_target_of(dir)
    } else {
        None
    };
    Ok((bytes, dir_name, fs_acquired, link_target))
}

/// The assembly half of the loaders: raw bytes -> wire entry.
fn assemble_skill_parts(
    bytes: &[u8],
    dir_name: &str,
    acquired: Acquired,
    link_target: Option<String>,
) -> Result<SkillEntry, SkillError> {
    // The decode rides the shared non-UTF-8 observability warn (issue
    // #1025): this face feeds BOTH the listing body and the delegation
    // channel's injections, so the divergence surfaces once per scan --
    // the parity signal for the resolve face's warn.
    let raw = super::decode_skill_md_lossy(bytes, dir_name);
    skill_from_str(&raw, dir_name, acquired, link_target, sha256_hex(bytes))
}

/// Parse + assemble one skill's wire entry from raw text (the loader's
/// pipeline minus its IO, so a write path can reuse the exact parse +
/// validate + assemble pass on the payload it just wrote). `content_hash` is
/// caller-computed -- the loader hashes the exact on-disk bytes; a write path
/// hashes the payload it wrote (`write_skill_md` writes the string verbatim,
/// so the two agree).
fn skill_from_str(
    raw: &str,
    dir_name: &str,
    acquired: Acquired,
    link_target: Option<String>,
    content_hash: String,
) -> Result<SkillEntry, SkillError> {
    let parsed = frontmatter::parse_skill_md(raw).map_err(SkillError::InvalidSkill)?;

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

    Ok(SkillEntry {
        name,
        description,
        acquired,
        license: frontmatter::get_string(fm, "license"),
        compatibility: frontmatter::get_string(fm, "compatibility"),
        body: parsed.body,
        link_target,
        // Config-blind default-on (issue #961): the listing command
        // overlays the disabled-name set before the rows cross IPC.
        enabled: true,
        content_hash,
        // The shadowing badge derivation (ADR-0121 Decision 5): a non-builtin
        // row whose name sits in the builtin manifest covers the builtin.
        covers_builtin: acquired != Acquired::Builtin && is_reserved_skill_name(dir_name),
    })
}

/// Reconcile a post-write read-back (issue #936): the atomic write has
/// already landed, so a read-back failure cannot un-write it. An IO failure
/// (the IO half failing -- e.g. an antivirus / indexer lock on the fresh
/// file) degrades to deriving the entry from the written payload with zero
/// extra IO; reporting `Err` there would claim an edit failed that is on
/// disk. A parse/validation failure of the freshly written content is
/// render/parse drift: it stays `Err` and walks the existing rollback -- the
/// file on disk is genuinely bad, and the next scan's ignored pane surfaces
/// it. The write paths never target a linked or builtin skill (both are
/// refused up front), so the degraded posture derives as `local`.
fn read_back_or_derive(
    parts: Result<SkillParts, SkillError>,
    content: &str,
    name: &str,
) -> Result<SkillEntry, SkillError> {
    match parts {
        Ok((bytes, dir_name, acquired, link_target)) => {
            assemble_skill_parts(&bytes, &dir_name, acquired, link_target)
        }
        Err(e) => {
            // Log after the derivation so the line states the outcome; the
            // underlying error carries the OS detail (the scan warns fold
            // their error in the same way).
            match skill_from_str(
                content,
                name,
                Acquired::Local,
                None,
                sha256_hex(content.as_bytes()),
            ) {
                Ok(entry) => {
                    log::warn!(
                        target: "skills",
                        "read-back of skill `{name}` failed ({e}); derived the entry from the written payload"
                    );
                    Ok(entry)
                }
                Err(err) => {
                    log::warn!(
                        target: "skills",
                        "read-back of skill `{name}` failed ({e}); deriving from the written payload also failed"
                    );
                    Err(err)
                }
            }
        }
    }
}

/// Resolve a link's target to an absolute path for the frontend's
/// open-file anchor (relative targets resolve against the link's
/// parent). Best effort: an unreadable link degrades to None, never a
/// listing failure.
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
pub(crate) fn write_skill_md(dir: &Path, content: &str) -> Result<(), SkillError> {
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
    use std::path::PathBuf;

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

    /// Write one skill directory into the RESERVED SUBTREE (the builtin
    /// posture by location, ADR-0121).
    fn put_system_skill(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(SYSTEM_SUBTREE).join(name);
        fs::create_dir_all(&dir).expect("create .system skill dir");
        fs::write(
            dir.join(SKILL_MD),
            format!("---\nname: {name}\ndescription: Shipped {name}.\n---\nShipped body.\n"),
        )
        .expect("write SKILL.md");
        dir
    }

    /// A skill directory whose SKILL.md body holds non-UTF-8 bytes -- the
    /// shared fixture of the lossy-load and lossy-edit pins. Returns the
    /// dir plus the ORIGINAL bytes (the load pin hashes them).
    fn put_mixed_encoding_skill(root: &Path) -> (PathBuf, Vec<u8>) {
        let dir = root.join("mixed-encoding");
        fs::create_dir_all(&dir).expect("create skill dir");
        let raw: &[u8] =
            b"---\nname: mixed-encoding\ndescription: Test skill.\n---\nBody with \xFF bytes.\n";
        fs::write(dir.join(SKILL_MD), raw).expect("write SKILL.md");
        (dir, raw.to_vec())
    }

    /// A SKILL.md whose body holds non-UTF-8 bytes loads lossy (U+FFFD
    /// stand-ins) with the hash anchoring the ORIGINAL bytes -- the
    /// divergence the assemble-time warn makes observable (issue #1025).
    /// Pins the lossy posture so the warn's arrival cannot regress the
    /// load itself (the listing body feeds the delegation channel's
    /// injections and the edit face, so it must stay marker-free).
    #[test]
    fn non_utf8_body_loads_lossy_with_whole_file_hash() {
        let tmp = tempfile::tempdir().expect("skills root");
        let (_dir, raw) = put_mixed_encoding_skill(tmp.path());
        let listing = list_skills(tmp.path());
        assert_eq!(listing.skills.len(), 1);
        let skill = &listing.skills[0];
        assert_eq!(skill.name, "mixed-encoding");
        assert!(
            skill.body.contains('\u{FFFD}'),
            "the invalid byte renders as the replacement char"
        );
        assert_eq!(skill.content_hash, sha256_hex(&raw));
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
            // as `linked` via the reparse tag (a junction is NOT reported as
            // a symlink by `FileType::is_symlink`), and `delete_skill` removes
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
        // NotFound is the legitimate "never-created registry" state -- no
        // root_error (issue #375).
        assert!(listing.root_error.is_none());
    }

    /// A non-`NotFound` `read_dir` failure surfaces the English technical
    /// reason in `root_error` so the settings UI can distinguish a locked-out
    /// root from a clean registry (issue #375). Passing a FILE path triggers
    /// `NotADirectory` (not `NotFound`) on every platform -- a reliable,
    /// cross-platform way to exercise the non-`NotFound` error arm without
    /// platform-specific permission gymnastics.
    #[test]
    fn list_surfaces_root_error_when_read_dir_fails_non_notfound() {
        let tmp = tempfile::tempdir().unwrap();
        let not_a_dir = tmp.path().join("not-a-dir.txt");
        fs::write(&not_a_dir, "x").unwrap();

        let listing = list_skills(&not_a_dir);
        assert!(listing.skills.is_empty());
        assert!(listing.ignored.is_empty());
        let root_error = listing
            .root_error
            .as_ref()
            .expect("root_error should be Some for a non-NotFound read_dir failure");
        assert!(
            root_error.contains("not-a-dir.txt"),
            "root_error should name the path, got: {root_error}"
        );
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

    /// Hidden directories are skipped by the root scan (ADR-0121 Decision 3):
    /// the reserved `.system/` subtree merges explicitly, and any other
    /// dot-directory stays internal noise -- never a row, never an ignored
    /// entry.
    #[test]
    fn list_skips_hidden_directories() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "alpha", "", "Body.\n");
        let hidden = root.join(".staging");
        fs::create_dir_all(&hidden).unwrap();
        fs::write(
            hidden.join(SKILL_MD),
            "---\nname: x\ndescription: d\n---\nb\n",
        )
        .unwrap();
        let listing = list_skills(root);
        assert_eq!(listing.skills.len(), 1);
        assert_eq!(listing.skills[0].name, "alpha");
        assert!(
            listing.ignored.is_empty(),
            "hidden dirs are not ignored rows"
        );
    }

    /// The reserved-subtree merge (ADR-0121 Decision 3): a `.system/<name>`
    /// directory lists as a BUILTIN row (acquired by location), with the
    /// subtree directory as the open anchor and no covers badge.
    #[test]
    fn list_merges_the_reserved_subtree_as_builtin_rows() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_skill(root, "my-tool", "", "Body.\n");
        let dir = put_system_skill(root, "pandoc");
        let listing = list_skills(root);
        let mine = listing.skills.iter().find(|s| s.name == "my-tool").unwrap();
        assert_eq!(mine.acquired, Acquired::Local);
        assert!(!mine.covers_builtin);
        let builtin = listing.skills.iter().find(|s| s.name == "pandoc").unwrap();
        assert_eq!(builtin.acquired, Acquired::Builtin);
        assert!(!builtin.covers_builtin);
        assert_eq!(
            builtin.link_target.as_deref(),
            Some(dir.to_string_lossy().as_ref()),
            "the builtin row's open anchor is its subtree directory"
        );
        assert_eq!(builtin.body, "Shipped body.\n");
    }

    /// Shadowing (ADR-0121 Decision 5) -- the mutation pin for the
    /// shadowing family: a local fork owning a builtin's name suppresses the
    /// builtin row (ONE local row, covers badge on), and deleting the fork
    /// restores the builtin row on the next scan. Dropping either half of
    /// the resolution order dies here.
    #[test]
    fn a_local_fork_shadows_the_builtin_and_deleting_it_restores_the_row() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_system_skill(root, "vega-chart");
        // The fork: a local copy at the registry root owns the name.
        put_skill(root, "vega-chart", "", "My fork.\n");
        let listing = list_skills(root);
        let rows: Vec<&SkillEntry> = listing
            .skills
            .iter()
            .filter(|s| s.name == "vega-chart")
            .collect();
        assert_eq!(rows.len(), 1, "exactly one row under shadowing");
        assert_eq!(rows[0].acquired, Acquired::Local);
        assert!(rows[0].covers_builtin, "the fork carries the covers badge");
        assert_eq!(rows[0].body, "My fork.\n");
        // The fork is disposed of: the builtin's row returns.
        fs::remove_dir_all(root.join("vega-chart")).unwrap();
        let restored = list_skills(root);
        let row = &restored.skills[0];
        assert_eq!(row.acquired, Acquired::Builtin);
        assert!(!row.covers_builtin);
        assert_eq!(row.body, "Shipped body.\n");
    }

    /// The teaching skill's shadowing (issue #1032): a local fork owning
    /// the `skill-creator` name carries the covers badge and suppresses
    /// the builtin row -- the filesystem fork channel stays open beside
    /// the app-boundary reserved refusal, name-pinned where the
    /// vega-chart pin above carries the mechanism, with the row's
    /// absence pinned here too.
    #[test]
    fn a_local_fork_shadows_skill_creator_with_the_covers_badge() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        put_system_skill(root, "skill-creator");
        put_skill(root, "skill-creator", "", "My curriculum fork.\n");
        let listing = list_skills(root);
        let rows: Vec<&SkillEntry> = listing
            .skills
            .iter()
            .filter(|s| s.name == "skill-creator")
            .collect();
        assert_eq!(rows.len(), 1, "exactly one row under shadowing");
        assert_eq!(rows[0].acquired, Acquired::Local);
        assert!(rows[0].covers_builtin, "the fork carries the covers badge");
        assert_eq!(rows[0].body, "My curriculum fork.\n");
        assert!(
            !listing
                .skills
                .iter()
                .any(|s| s.acquired == Acquired::Builtin),
            "no builtin row survives the fork"
        );
    }

    /// A broken reserved-subtree child surfaces in the ignored lane under
    /// its `.system/`-prefixed handle (the diagnostic fold, parallel to the
    /// root scan).
    #[test]
    fn a_non_spec_reserved_subtree_child_is_ignored_with_the_prefixed_handle() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(SYSTEM_SUBTREE).join("broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(SKILL_MD),
            "---\nname: other\ndescription: d\n---\nbody\n",
        )
        .unwrap();
        let listing = list_skills(root);
        assert!(listing.skills.is_empty());
        assert_eq!(listing.ignored.len(), 1);
        assert_eq!(listing.ignored[0].dir, ".system/broken");
        assert!(
            listing.ignored[0].reason.contains("broken"),
            "reason names the directory: {}",
            listing.ignored[0].reason
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

    /// The payload a write path just produced: exactly what `write_skill_md`
    /// writes (the temp-file write is verbatim).
    fn written_skill_payload() -> String {
        "---
name: cleaner
description: New.
---
New body.
"
        .to_string()
    }

    #[test]
    fn read_back_or_derive_degrades_a_transient_read_failure() {
        let entry = read_back_or_derive(
            Err(SkillError::InvalidSkill(
                "cannot read `.../cleaner/SKILL.md`: injected read failure".into(),
            )),
            &written_skill_payload(),
            "cleaner",
        )
        .unwrap();
        assert_eq!(entry.name, "cleaner");
        assert_eq!(entry.description, "New.");
        assert_eq!(entry.body, "New body.\n");
        assert_eq!(entry.acquired, Acquired::Local);
    }

    #[test]
    fn read_back_or_derive_degraded_entry_matches_a_fresh_disk_load() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("cleaner");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(SKILL_MD), written_skill_payload()).unwrap();
        let degraded = read_back_or_derive(
            Err(SkillError::InvalidSkill("injected read failure".into())),
            &written_skill_payload(),
            "cleaner",
        )
        .unwrap();
        let loaded = load_skill(&dir).unwrap();
        assert_eq!(degraded, loaded);
    }

    #[test]
    fn read_back_or_derive_passes_a_semantic_failure_through() {
        // Parts read fine, but the bytes on disk are not a skill: the
        // parse failure must surface, not be papered over by the payload.
        let err = read_back_or_derive(
            Ok((
                b"not a skill".to_vec(),
                "cleaner".to_string(),
                Acquired::Local,
                None,
            )),
            &written_skill_payload(),
            "cleaner",
        )
        .unwrap_err();
        assert!(matches!(err, SkillError::InvalidSkill(_)));
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

    // --- whole-string create entry (ADR-0122 Decision 1) ---------------------

    /// The whole-string entry writes the input VERBATIM: unknown frontmatter
    /// keys survive to disk byte-for-byte (the ecosystem interop interface),
    /// and the entry derives from the parsed `name` / `description`.
    #[test]
    fn create_skill_from_markdown_writes_the_input_verbatim() {
        let root = tempfile::tempdir().expect("root");
        let markdown = "---\nname: sql-coach\ndescription: Coach SQL writing.\nlicense: \
             MIT\ncompatibility: '>=1.0'\nmetadata-version: 3\n---\nCoach the body.\n";
        let entry = create_skill_from_markdown(root.path(), markdown).expect("create");
        assert_eq!(entry.name, "sql-coach");
        assert_eq!(entry.description, "Coach SQL writing.");
        // The bytes on disk are the input verbatim -- unknown keys included.
        let on_disk = fs::read_to_string(root.path().join("sql-coach/SKILL.md")).unwrap();
        assert_eq!(on_disk, markdown);
    }

    /// The whole-string entry reuses the three-field entry's typed-reject
    /// face: every malformed shape is refused with its own variant, and no
    /// half-built directory survives a refusal.
    #[test]
    fn create_skill_from_markdown_rejects_each_malformed_shape() {
        let root = tempfile::tempdir().expect("root");
        // Malformed YAML frontmatter.
        assert!(matches!(
            create_skill_from_markdown(root.path(), "---\nname: [unclosed\n---\nbody\n"),
            Err(SkillError::InvalidSkill(_))
        ));
        // No frontmatter block at all.
        assert!(matches!(
            create_skill_from_markdown(root.path(), "Just a body.\n"),
            Err(SkillError::InvalidSkill(_))
        ));
        // Frontmatter missing the `name` string.
        assert!(matches!(
            create_skill_from_markdown(root.path(), "---\ndescription: d.\n---\nbody\n"),
            Err(SkillError::InvalidSkill(_))
        ));
        // Frontmatter missing the `description` string.
        assert!(matches!(
            create_skill_from_markdown(root.path(), "---\nname: sql-coach\n---\nbody\n"),
            Err(SkillError::InvalidSkill(_))
        ));
        // A spec-violating name is its own variant.
        assert!(matches!(
            create_skill_from_markdown(
                root.path(),
                "---\nname: SQL Coach\n\
             description: d.\n---\nbody\n"
            ),
            Err(SkillError::InvalidName(_))
        ));
        // The reserved builtin set refuses before any disk work.
        assert_eq!(
            create_skill_from_markdown(
                root.path(),
                "---\nname: pandoc\n\
             description: d.\n---\nbody\n"
            )
            .unwrap_err(),
            SkillError::ReservedSkillName("pandoc".to_string())
        );
        // A blank body is refused.
        assert!(matches!(
            create_skill_from_markdown(
                root.path(),
                "---\nname: sql-coach\n\
             description: d.\n---\n\n"
            ),
            Err(SkillError::InvalidSkill(_))
        ));
        // Nothing landed on disk across all refusals.
        assert!(!root.path().join("sql-coach").exists());
        assert!(!root.path().join("pandoc").exists());
    }

    /// A taken name is refused without disturbing the incumbent, and no
    /// half-built retry directory survives to block the next attempt.
    #[test]
    fn create_skill_from_markdown_refuses_a_taken_name_cleanly() {
        let root = tempfile::tempdir().expect("root");
        put_skill(
            root.path(),
            "sql-coach",
            "",
            "First body.
",
        );
        assert_eq!(
            create_skill_from_markdown(
                root.path(),
                "---\nname: sql-coach\ndescription: Second.\n---\nSecond body.\n"
            )
            .unwrap_err(),
            SkillError::NameTaken("sql-coach".to_string())
        );
        // The incumbent is untouched.
        let raw = fs::read_to_string(root.path().join("sql-coach/SKILL.md")).unwrap();
        assert!(raw.contains("First body."));
    }

    // --- builtin guards (issue #677; readonly posture ADR-0121) -------------

    #[test]
    fn create_skill_from_markdown_refuses_a_reserved_builtin_name() {
        let root = tempfile::tempdir().expect("root");
        assert_eq!(
            create_skill_from_markdown(
                root.path(),
                "---
name: pandoc
description: mine.
---
b
"
            )
            .unwrap_err(),
            SkillError::ReservedSkillName("pandoc".to_string())
        );
        // The knowledge-only name refuses through the same face (issue
        // #1032): curation membership, not the companion wiring, is what
        // reserves a name.
        assert_eq!(
            create_skill_from_markdown(
                root.path(),
                "---
name: skill-creator
description: mine.
---
b
"
            )
            .unwrap_err(),
            SkillError::ReservedSkillName("skill-creator".to_string())
        );
        // Nothing landed on disk.
        assert!(!root.path().join("pandoc").exists());
        assert!(!root.path().join("skill-creator").exists());
    }

    /// The fork channel guards (ADR-0121 Decision 5): a local fork owning
    /// a builtin's name deletes normally -- disposing of the fork is how
    /// the builtin's row returns -- while the reserved-subtree copy itself
    /// is undeletable (the subtree re-aligns on the next scan).
    #[test]
    fn delete_allows_a_fork_but_refuses_the_reserved_subtree_copy() {
        let root = tempfile::tempdir().expect("root");
        put_system_skill(root.path(), "pandoc");
        put_skill(root.path(), "pandoc", "", "My fork.\n");
        // The fork (local, owns the name by shadowing) deletes normally.
        delete_skill(root.path(), "pandoc").expect("the fork deletes");
        assert!(!root.path().join("pandoc").exists());
        assert!(root.path().join(".system/pandoc").exists());
        // The builtin copy is refused.
        assert_eq!(
            delete_skill(root.path(), "pandoc").unwrap_err(),
            SkillError::BuiltinUndeletable("pandoc".to_string())
        );
    }
}
