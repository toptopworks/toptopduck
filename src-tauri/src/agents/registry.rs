//! Agent-definitions registry scan + CRUD (issue #932, ADR-0117).
//!
//! The registry is a single-file store: one markdown file per definition
//! under the registry root (`<name>.md`), and the DIRECTORY SCAN IS the
//! registry (no sidecar table, the skills-root posture -- a definition is a
//! distributable asset, so a future import / plugin / cloud source degenerates
//! to a filesystem action). All functions take the root as a parameter and
//! touch no Tauri state, so the whole surface tests against a tempdir.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use super::builtin::{self, BuiltinAgentMark};
use super::frontmatter;
use super::model::{
    extract_skill_marks, partition_skill_marks, validate_agent_name, validate_description,
    validate_preamble, AgentEntry, AgentError, AgentListing, AgentSource, AgentUpdate,
    AgentWarning, SkippedAgent,
};

/// List the registry: the spec-valid definitions + the skipped files + the
/// builtin-set degradation warnings + a root-level error when the root itself
/// could not be read (the `SkillListing` contract).
pub fn list_agents(
    root: &Path,
    mark: &BuiltinAgentMark,
    enabled: &BTreeSet<String>,
    skill_names: &BTreeSet<String>,
) -> AgentListing {
    let mut agents = Vec::new();
    let mut ignored = Vec::new();
    let mut root_error = None;

    match std::fs::read_dir(root) {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => {
                        let path = entry.path();
                        // Follow the link for the file check: a symlink onto
                        // a definition file IS a definition (the linked
                        // posture); a dangling link or a link to a directory
                        // is not. Directories never load. A metadata fault
                        // other than NotFound (ACL / lock) is an entry the
                        // OS could not inspect -- it lands in ignored
                        // instead of vanishing (issue #937 posture D).
                        match is_loadable_file(std::fs::metadata(&path)) {
                            Ok(true) => {}
                            Ok(false) => continue,
                            Err(e) => {
                                log::warn!(
                                    target: "agents",
                                    "error reading entry metadata for `{}`: {e}",
                                    path.display()
                                );
                                ignored.push(SkippedAgent {
                                    file: file_name_of(&path).unwrap_or_default(),
                                    reason: format!("read entry metadata failed: {e}"),
                                });
                                continue;
                            }
                        }
                        if path.extension().and_then(|e| e.to_str()) != Some("md") {
                            continue;
                        }
                        match load_agent(&path, mark, enabled, skill_names) {
                            Ok(agent) => agents.push(agent),
                            Err(e) => {
                                log::warn!(
                                    target: "agents",
                                    "skipping non-spec definition file `{}`: {e}",
                                    path.display()
                                );
                                let file = file_name_of(&path).unwrap_or_else(|| {
                                    format!("<unnamed-entry-{}>", ignored.len())
                                });
                                ignored.push(SkippedAgent {
                                    file,
                                    reason: e.to_string(),
                                });
                            }
                        }
                    }
                    Err(e) => {
                        // The OS could not read one directory entry: surface
                        // it in `ignored` so the entry does not vanish
                        // silently (the skills-read precedent, issue #375).
                        log::warn!(
                            target: "agents",
                            "error reading an agents directory entry: {e}"
                        );
                        ignored.push(SkippedAgent {
                            file: format!("<unreadable-entry-{}>", ignored.len()),
                            reason: e.to_string(),
                        });
                    }
                }
            }
        }
        // NotFound is the legitimate never-created-registry state.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            log::warn!(
                target: "agents",
                "failed to read agents root `{}`: {e}",
                root.display()
            );
            root_error = Some(format!("read agents root `{}` failed: {e}", root.display()));
        }
    }

    agents.sort_by(|a, b| a.name.cmp(&b.name));
    ignored.sort_by(|a, b| a.file.cmp(&b.file));
    let warnings: Vec<AgentWarning> = super::builtin::audit_builtin_postures(root, mark);
    AgentListing {
        agents,
        ignored,
        warnings,
        root_error,
    }
}

/// Classify a scanned entry's follow-the-link metadata result (issue #937
/// posture D): `Ok(is_file)` decides load vs skip, with `NotFound` as the
/// legitimate dangling-link shape (a non-file, skipped silently) -- any other
/// fault (ACL / lock) must surface as an ignored row so the entry does not
/// vanish from the pane.
fn is_loadable_file(metadata: std::io::Result<std::fs::Metadata>) -> std::io::Result<bool> {
    match metadata {
        Ok(m) => Ok(m.is_file()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// The display file name of a scanned path (its file_name, not the full
/// path -- the `SkillListing` ignored-fold convention).
fn file_name_of(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().into_owned())
}

/// Load one definition file into its wire entry. `stem` is the file name
/// without `.md` -- the identity the frontmatter `name` must equal (the
/// skills loader's file-name consistency rule).
fn load_agent(
    path: &Path,
    mark: &BuiltinAgentMark,
    enabled: &BTreeSet<String>,
    skill_names: &BTreeSet<String>,
) -> Result<AgentEntry, AgentError> {
    let raw = std::fs::read_to_string(path).map_err(|e| fs_err("read definition file", path, e))?;
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Source derivation (ADR-0117 Decision 2): a file-level symlink is the
    // linked posture; a mark hit outranks the real-file default otherwise.
    let is_linked = std::fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false);
    let (source, link_target) = if is_linked {
        (
            AgentSource::Linked,
            std::fs::read_link(path)
                .map(|p| p.to_string_lossy().into_owned())
                .ok(),
        )
    } else if mark.contains(&stem) {
        (AgentSource::Builtin, None)
    } else {
        (AgentSource::User, None)
    };
    agent_from_str(&raw, &stem, source, link_target, enabled, skill_names)
}

/// Parse + assemble one definition's wire entry from raw text (the loader's
/// pipeline minus its IO, so a write path can reuse the exact parse +
/// validate + assemble pass on the payload it just wrote). `stem` is the
/// identity the frontmatter `name` must equal; `source` / `link_target` are
/// caller-derived (the loader consults the file's metadata; a write path
/// knows a freshly written definition is never a link).
fn agent_from_str(
    raw: &str,
    stem: &str,
    source: AgentSource,
    link_target: Option<String>,
    enabled: &BTreeSet<String>,
    skill_names: &BTreeSet<String>,
) -> Result<AgentEntry, AgentError> {
    let parsed = frontmatter::parse_agent_md(raw).map_err(AgentError::InvalidAgent)?;
    let name =
        crate::skills::frontmatter::get_string(&parsed.frontmatter, "name").unwrap_or_default();
    // The identity rule holds at load time too (the skills loader's
    // in-scan shape validation): a hand-placed file whose name is not
    // kebab-case cannot enter the registry -- its row would later deadlock
    // its own edit (update refuses the written name). The refusal lands in
    // the listing's ignored pane with the reason.
    validate_agent_name(&name)?;
    if name != stem {
        return Err(AgentError::InvalidAgent(format!(
            "frontmatter name `{name}` does not match its file stem `{stem}`"
        )));
    }
    let description = crate::skills::frontmatter::get_string(&parsed.frontmatter, "description")
        .unwrap_or_default();
    let (skill_refs, dangling_skill_refs) =
        partition_skill_marks(extract_skill_marks(&parsed.preamble), skill_names);
    let is_enabled = enabled.contains(&name);
    Ok(AgentEntry {
        name,
        description,
        preamble: parsed.preamble,
        source,
        enabled: is_enabled,
        link_target,
        skill_refs,
        dangling_skill_refs,
        dropped_axes: parsed.dropped_axes,
    })
}

/// Reconcile a post-write read-back (issue #936): the atomic write has
/// already landed, so a read-back failure cannot un-write it. An IO failure
/// of the read (`FsFailure` -- e.g. an antivirus / indexer lock on the
/// fresh file) degrades to deriving the entry from the written payload with
/// zero extra IO; reporting `Err` there would claim an edit failed that is
/// on disk. A semantic failure (parse / validation, i.e. render/parse
/// drift) stays `Err` and walks the existing rollback: the file on disk is
/// genuinely bad, and the next scan's ignored pane surfaces it.
fn read_back_or_derive(
    readback: Result<AgentEntry, AgentError>,
    content: &str,
    name: &str,
    mark: &BuiltinAgentMark,
    enabled: &BTreeSet<String>,
    skill_names: &BTreeSet<String>,
) -> Result<AgentEntry, AgentError> {
    match readback {
        Ok(entry) => Ok(entry),
        Err(AgentError::FsFailure(e)) => {
            // A definition the app just wrote is never a link (update and
            // create refuse the linked posture up front), so the source
            // derives from the mark alone.
            let source = if mark.contains(name) {
                AgentSource::Builtin
            } else {
                AgentSource::User
            };
            // Log after the derivation so the line states the outcome; the
            // underlying error carries the OS detail (the scan warns fold
            // their error in the same way).
            match agent_from_str(content, name, source, None, enabled, skill_names) {
                Ok(entry) => {
                    log::warn!(
                        target: "agents",
                        "read-back of definition `{name}` failed ({e}); derived the entry from the written payload"
                    );
                    Ok(entry)
                }
                Err(err) => {
                    log::warn!(
                        target: "agents",
                        "read-back of definition `{name}` failed ({e}); deriving from the written payload also failed"
                    );
                    Err(err)
                }
            }
        }
        Err(e) => Err(e),
    }
}

/// The resolved definition-file path for a name (the name is validated
/// kebab-case before this, so no traversal risk).
fn agent_path(root: &Path, name: &str) -> PathBuf {
    root.join(format!("{name}.md"))
}

/// Mint a new user definition: `<root>/<name>.md` with the given
/// declaration (description + preamble). The root is minted lazily on first
/// create. Refuses a reserved name statically (the CLI-registration
/// precedent). Returns the entry for the written definition (read back, or
/// derived from the written payload on a transient read-back failure).
pub fn create_agent(
    root: &Path,
    name: &str,
    description: &str,
    preamble: &str,
    enabled: &BTreeSet<String>,
    skill_names: &BTreeSet<String>,
) -> Result<AgentEntry, AgentError> {
    validate_agent_name(name)?;
    if builtin::is_reserved_agent_name(name) {
        return Err(AgentError::ReservedAgentName(name.to_string()));
    }
    validate_description(description)?;
    validate_preamble(preamble)?;
    std::fs::create_dir_all(root).map_err(|e| fs_err("create agents root", root, e))?;
    let path = agent_path(root, name);
    if path.exists() {
        return Err(AgentError::NameTaken(name.to_string()));
    }
    let mut fm = serde_yaml::Mapping::new();
    fm.insert(
        serde_yaml::Value::String("name".into()),
        serde_yaml::Value::String(name.into()),
    );
    fm.insert(
        serde_yaml::Value::String("description".into()),
        serde_yaml::Value::String(description.into()),
    );
    let content = frontmatter::render_agent_md(&fm, preamble)?;
    write_agent_file(&path, &content)?;
    // The reserved-set refusal keeps a fresh mint out of the builtin
    // namespace, so the read-back cannot be a builtin definition. A failed
    // transient read-back derives from the written payload (issue #936) --
    // reporting `Err` there would strand the minted file and deadlock a
    // retry on NameTaken. A semantic read-back failure (render/parse
    // drift) stays `Err`, and the mint is removed below so the retry
    // succeeds anyway.
    let mark = BuiltinAgentMark::default();
    let result = read_back_or_derive(
        load_agent(&path, &mark, enabled, skill_names),
        &content,
        name,
        &mark,
        enabled,
        skill_names,
    );
    // A failed mint has no prior asset to preserve (unlike update's rename
    // rollback): remove the file so a retry does not hit NameTaken.
    if result.is_err() {
        let _ = std::fs::remove_file(&path);
    }
    result
}

/// RAII guard for an in-flight rename (the `RenameGuard` posture of the
/// skills registry): if still armed on drop, restore the original name.
struct RenameGuard {
    from: PathBuf,
    to: PathBuf,
    armed: bool,
}

impl Drop for RenameGuard {
    fn drop(&mut self) {
        if self.armed && std::fs::rename(&self.to, &self.from).is_err() {
            log::warn!(
                target: "agents",
                "failed to roll back rename `{}` -> `{}`",
                self.to.display(),
                self.from.display()
            );
        }
    }
}

/// Rewrite one user/builtin definition's file (frontmatter + preamble).
/// `name` addresses the current file; `update.name` is the identity to
/// write -- a different value renames the file. Refuses a non-kebab
/// addressed name (the name joins the path directly -- the delete_skill
/// posture, the name is IPC-provided), a `linked` definition (read-only),
/// an unknown name, a taken rename target, and a rename of a builtin
/// definition (the name is the locked identity). Unknown frontmatter keys
/// -- including a present `tools` / `model` -- survive the edit verbatim
/// (community files stay community-shaped).
pub fn update_agent(
    root: &Path,
    mark: &BuiltinAgentMark,
    name: &str,
    update: AgentUpdate,
    enabled: &BTreeSet<String>,
    skill_names: &BTreeSet<String>,
) -> Result<AgentEntry, AgentError> {
    validate_agent_name(name)?;
    let path = agent_path(root, name);
    if !path.exists() {
        return Err(AgentError::NoSuchAgent(name.to_string()));
    }
    let current = load_agent(&path, mark, &BTreeSet::new(), &BTreeSet::new())?;
    if current.source == AgentSource::Linked {
        return Err(AgentError::ReadOnly(name.to_string()));
    }
    // A materialized builtin definition keeps its name: the name is the
    // locked identity the delegation tool and future consumers anchor on.
    if current.source == AgentSource::Builtin && update.name != name {
        return Err(AgentError::BuiltinNameLocked(name.to_string()));
    }
    validate_agent_name(&update.name)?;
    if update.name != name && builtin::is_reserved_agent_name(&update.name) {
        return Err(AgentError::ReservedAgentName(update.name.clone()));
    }
    validate_description(&update.description)?;
    validate_preamble(&update.preamble)?;

    // Rename first when the identity changes, then rewrite in the new home
    // (the guard keeps the registry self-consistent on an error path).
    let mut guard = if update.name != name {
        let target = agent_path(root, &update.name);
        if target.exists() {
            return Err(AgentError::NameTaken(update.name.clone()));
        }
        std::fs::rename(&path, &target)
            .map_err(|e| fs_err("rename definition file", &target, e))?;
        Some(RenameGuard {
            from: path.clone(),
            to: target,
            armed: true,
        })
    } else {
        None
    };
    let work_path = guard
        .as_ref()
        .map(|g| g.to.clone())
        .unwrap_or_else(|| path.clone());

    let result = (|| -> Result<AgentEntry, AgentError> {
        let raw = std::fs::read_to_string(&work_path)
            .map_err(|e| fs_err("read definition file", &work_path, e))?;
        let parsed = frontmatter::parse_agent_md(&raw).map_err(AgentError::InvalidAgent)?;
        let mut fm = parsed.frontmatter;
        frontmatter::set_string(&mut fm, "name", &update.name);
        frontmatter::set_string(&mut fm, "description", &update.description);
        let content = frontmatter::render_agent_md(&fm, &update.preamble)?;
        write_agent_file(&work_path, &content)?;
        // The write has landed; reconcile a failed read-back against it
        // (issue #936) instead of reporting an edit failure that is on disk.
        read_back_or_derive(
            load_agent(&work_path, mark, enabled, skill_names),
            &content,
            &update.name,
            mark,
            enabled,
            skill_names,
        )
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
                if let Err(re) = std::fs::rename(&g.to, &g.from) {
                    return Err(AgentError::FsFailure(format!(
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

/// Delete one definition file. A non-kebab addressed name is refused first
/// (the delete_skill posture: the name joins the path directly, and it is
/// IPC-provided -- validation keeps the join root-bound). A `linked`
/// definition's LINK is removed without touching the external source. A
/// materialized builtin definition is refused (it re-materializes on the
/// next startup anyway; disabling is the single shutdown axis).
pub fn delete_agent(root: &Path, mark: &BuiltinAgentMark, name: &str) -> Result<(), AgentError> {
    validate_agent_name(name)?;
    if mark.contains(name) {
        return Err(AgentError::BuiltinUndeletable(name.to_string()));
    }
    let path = agent_path(root, name);
    if !path.exists() {
        return Err(AgentError::NoSuchAgent(name.to_string()));
    }
    // `remove_file` on a symlink removes the link itself, never the target.
    std::fs::remove_file(&path).map_err(|e| fs_err("remove definition file", &path, e))
}

/// Atomic definition write: temp file in the same directory + rename, so a
/// crash mid-write leaves either the old complete file or the new one (the
/// `write_skill_md` pattern). Shared by the CRUD paths and the builtin
/// materializer.
pub(crate) fn write_agent_file(path: &Path, content: &str) -> Result<(), AgentError> {
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, content).map_err(|e| fs_err("write definition temp file", &tmp, e))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(fs_err("replace definition file", path, e));
    }
    Ok(())
}

/// The FsFailure constructor (the skills `fs_err` pattern): the operation +
/// path + OS detail, English (the technical-detail fold; user-facing wording
/// lives in the locale catalog).
fn fs_err(op: &str, path: &Path, e: std::io::Error) -> AgentError {
    AgentError::FsFailure(format!("{op} failed for `{}`: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registered(skills: &[&str]) -> BTreeSet<String> {
        skills.iter().map(|s| s.to_string()).collect()
    }

    /// Write one definition fixture; `extra` rides the frontmatter verbatim.
    fn put_agent(root: &Path, name: &str, description: &str, preamble: &str, extra: &str) {
        std::fs::create_dir_all(root).unwrap();
        let content =
            format!("---\nname: {name}\ndescription: {description}\n{extra}---\n{preamble}");
        std::fs::write(agent_path(root, name), content).unwrap();
    }

    // --- scan ----------------------------------------------------------------

    #[test]
    fn list_on_a_missing_root_lists_empty_but_warns_materialization() {
        let listing = list_agents(
            Path::new("Z:/no-such-root"),
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        assert!(listing.agents.is_empty());
        assert!(listing.ignored.is_empty());
        assert!(listing.root_error.is_none());
        // The shipped set cannot have materialized against a missing root:
        // the pane must not read the empty list as "never created" (issue #937).
        assert_eq!(
            listing.warnings,
            vec![AgentWarning::NotMaterialized {
                name: "general-purpose".into()
            }]
        );
    }

    #[test]
    fn list_loads_files_and_partitions_marks() {
        let tmp = tempfile::tempdir().unwrap();
        put_agent(
            tmp.path(),
            "data-cleaner",
            "Cleans data.",
            "Use `pdf-tools` when parsing; `ghost-skill` too.\n",
            "",
        );
        let listing = list_agents(
            tmp.path(),
            &Default::default(),
            &registered(&["data-cleaner-enabled"]),
            &registered(&["pdf-tools"]),
        );
        assert_eq!(listing.agents.len(), 1);
        let agent = &listing.agents[0];
        assert_eq!(agent.name, "data-cleaner");
        assert_eq!(agent.source, AgentSource::User);
        assert!(!agent.enabled);
        assert_eq!(agent.skill_refs, vec!["pdf-tools"]);
        assert_eq!(agent.dangling_skill_refs, vec!["ghost-skill"]);
        assert!(agent.dropped_axes.is_empty());
    }

    #[test]
    fn list_fills_enabled_from_the_name_set() {
        let tmp = tempfile::tempdir().unwrap();
        put_agent(tmp.path(), "sql", "Runs SQL.", "You run SQL.\n", "");
        let listing = list_agents(
            tmp.path(),
            &Default::default(),
            &registered(&["sql"]),
            &Default::default(),
        );
        assert!(listing.agents[0].enabled);
    }

    #[test]
    fn list_records_dropped_community_axes() {
        let tmp = tempfile::tempdir().unwrap();
        put_agent(
            tmp.path(),
            "reviewer",
            "Reviews.",
            "You review.\n",
            "tools: Read\nmodel: opus\n",
        );
        let listing = list_agents(
            tmp.path(),
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        assert_eq!(listing.agents[0].dropped_axes, vec!["tools", "model"]);
    }

    #[test]
    fn list_ignores_a_name_mismatch_and_non_md_entries() {
        let tmp = tempfile::tempdir().unwrap();
        // The FILE is mismatch.md but the frontmatter name is `other`.
        std::fs::create_dir_all(tmp.path()).unwrap();
        std::fs::write(
            tmp.path().join("mismatch.md"),
            "---\nname: other\ndescription: Mismatched.\n---\nBody.\n",
        )
        .unwrap();
        std::fs::write(tmp.path().join("notes.txt"), "not a definition\n").unwrap();
        std::fs::create_dir_all(tmp.path().join("subdir.md")).unwrap();
        let listing = list_agents(
            tmp.path(),
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        assert!(listing.agents.is_empty());
        // Only the mismatched file lands in ignored (txt + directory skip
        // silently -- they are not definition files at all).
        assert_eq!(listing.ignored.len(), 1);
        assert!(listing.ignored[0].reason.contains("does not match"));
    }

    #[test]
    fn list_ignores_a_non_kebab_named_file() {
        let tmp = tempfile::tempdir().unwrap();
        // A community-shaped name (uppercase) matching its stem: the scan
        // refuses the shape -- loading it would later deadlock its own edit
        // (update refuses the written name).
        std::fs::create_dir_all(tmp.path()).unwrap();
        std::fs::write(
            tmp.path().join("CodeReviewer.md"),
            "---\nname: CodeReviewer\ndescription: Reviews.\n---\nYou review.\n",
        )
        .unwrap();
        let listing = list_agents(
            tmp.path(),
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        assert!(listing.agents.is_empty());
        assert_eq!(listing.ignored.len(), 1);
        assert!(listing.ignored[0].reason.contains("invalid agent name"));
    }

    #[test]
    fn list_derives_builtin_off_the_mark() {
        let tmp = tempfile::tempdir().unwrap();
        put_agent(tmp.path(), "general-purpose", "Fallback.", "Body.\n", "");
        let mark = BuiltinAgentMark::of(&["general-purpose"]);
        let listing = list_agents(tmp.path(), &mark, &Default::default(), &Default::default());
        assert_eq!(listing.agents[0].source, AgentSource::Builtin);
        // The same file without the record reads as the user's own.
        let unmarked = list_agents(
            tmp.path(),
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        assert_eq!(unmarked.agents[0].source, AgentSource::User);
    }

    // --- create --------------------------------------------------------------

    #[test]
    fn create_mints_a_file_and_reads_it_back() {
        let tmp = tempfile::tempdir().unwrap();
        let entry = create_agent(
            tmp.path(),
            "explorer",
            "Explores datasets.",
            "You explore.\n",
            &Default::default(),
            &Default::default(),
        )
        .unwrap();
        assert_eq!(entry.name, "explorer");
        assert_eq!(entry.preamble, "You explore.\n");
        assert_eq!(entry.source, AgentSource::User);
        let on_disk = std::fs::read_to_string(tmp.path().join("explorer.md")).unwrap();
        assert!(on_disk.contains("name: explorer"));
    }

    #[test]
    fn create_refuses_invalid_reserved_and_taken_names() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(
            create_agent(
                tmp.path(),
                "Bad_Name",
                "d",
                "p\n",
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::InvalidName(_))
        ));
        assert!(matches!(
            create_agent(
                tmp.path(),
                "general-purpose",
                "d",
                "p\n",
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::ReservedAgentName(_))
        ));
        assert!(matches!(
            create_agent(
                tmp.path(),
                "explore",
                "d",
                "p\n",
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::ReservedAgentName(_))
        ));
        put_agent(tmp.path(), "taken", "d", "p\n", "");
        assert!(matches!(
            create_agent(
                tmp.path(),
                "taken",
                "d",
                "p\n",
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::NameTaken(_))
        ));
    }

    #[test]
    fn create_refuses_blank_fields() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(
            create_agent(
                tmp.path(),
                "ok-name",
                "  ",
                "p\n",
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::InvalidAgent(_))
        ));
        assert!(matches!(
            create_agent(
                tmp.path(),
                "ok-name",
                "d",
                "\n",
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::InvalidAgent(_))
        ));
    }

    // --- update --------------------------------------------------------------

    #[test]
    fn update_rewrites_fields_and_survives_unknown_keys() {
        let tmp = tempfile::tempdir().unwrap();
        put_agent(
            tmp.path(),
            "cleaner",
            "Old.",
            "Old body.\n",
            "tools: Read\n",
        );
        let entry = update_agent(
            tmp.path(),
            &Default::default(),
            "cleaner",
            AgentUpdate {
                name: "cleaner".into(),
                description: "New.".into(),
                preamble: "New body.\n".into(),
            },
            &Default::default(),
            &Default::default(),
        )
        .unwrap();
        assert_eq!(entry.description, "New.");
        assert_eq!(entry.preamble, "New body.\n");
        // The community axis survives the edit verbatim.
        let on_disk = std::fs::read_to_string(tmp.path().join("cleaner.md")).unwrap();
        assert!(on_disk.contains("tools: Read"));
        assert_eq!(entry.dropped_axes, vec!["tools"]);
    }

    #[test]
    fn update_renames_the_file_atomically() {
        let tmp = tempfile::tempdir().unwrap();
        put_agent(tmp.path(), "old-name", "d", "p\n", "");
        update_agent(
            tmp.path(),
            &Default::default(),
            "old-name",
            AgentUpdate {
                name: "new-name".into(),
                description: "d".into(),
                preamble: "p\n".into(),
            },
            &Default::default(),
            &Default::default(),
        )
        .unwrap();
        assert!(!tmp.path().join("old-name.md").exists());
        assert!(tmp.path().join("new-name.md").exists());
    }

    // --- post-write reconciliation (issue #936) ------------------------------

    /// The payload a write path just produced: exactly what write_agent_file
    /// puts on disk (the temp-file write is verbatim).
    fn written_payload() -> String {
        "---\nname: cleaner\ndescription: New.\n---\nNew body. Uses `polisher`.\n".to_string()
    }

    #[test]
    fn reconcile_degrades_a_transient_readback_failure_to_the_written_payload() {
        let entry = read_back_or_derive(
            Err(AgentError::FsFailure("injected read failure".into())),
            &written_payload(),
            "cleaner",
            &Default::default(),
            &Default::default(),
            &Default::default(),
        )
        .unwrap();
        assert_eq!(entry.name, "cleaner");
        assert_eq!(entry.description, "New.");
        assert_eq!(entry.preamble, "New body. Uses `polisher`.\n");
        assert_eq!(entry.source, AgentSource::User);
        // The un-registered mark lands in the dangling lane: the downgrade
        // arm threads the real skill-names set.
        assert_eq!(entry.dangling_skill_refs, vec!["polisher".to_string()]);
    }

    #[test]
    fn reconcile_degrade_honors_a_builtin_mark_hit() {
        // A materialized builtin edited under its own name must degrade to
        // the Builtin source, not the User default (ADR-0117 Decision 2).
        let mark = BuiltinAgentMark::of(&["cleaner"]);
        let entry = read_back_or_derive(
            Err(AgentError::FsFailure("injected read failure".into())),
            &written_payload(),
            "cleaner",
            &mark,
            &Default::default(),
            &Default::default(),
        )
        .unwrap();
        assert_eq!(entry.source, AgentSource::Builtin);
    }

    #[test]
    fn reconcile_degraded_entry_matches_a_fresh_disk_load() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path()).unwrap();
        let path = agent_path(tmp.path(), "cleaner");
        std::fs::write(&path, written_payload()).unwrap();
        // Non-empty sets on both sides: the guard must catch a downgrade
        // arm that drops the enabled / skill-names threading (an enabled
        // definition would read disabled; a bound mark would mispartition).
        let enabled: BTreeSet<String> = ["cleaner".to_string()].into_iter().collect();
        let skill_names: BTreeSet<String> = ["polisher".to_string()].into_iter().collect();
        let degraded = read_back_or_derive(
            Err(AgentError::FsFailure("injected read failure".into())),
            &written_payload(),
            "cleaner",
            &Default::default(),
            &enabled,
            &skill_names,
        )
        .unwrap();
        let loaded = load_agent(&path, &Default::default(), &enabled, &skill_names).unwrap();
        assert_eq!(degraded, loaded);
    }

    #[test]
    fn reconcile_passes_a_semantic_readback_failure_through() {
        let err = read_back_or_derive(
            Err(AgentError::InvalidAgent("render/parse drift".into())),
            &written_payload(),
            "cleaner",
            &Default::default(),
            &Default::default(),
            &Default::default(),
        )
        .unwrap_err();
        assert!(matches!(err, AgentError::InvalidAgent(_)));
    }

    #[test]
    fn update_rejects_unknown_linked_builtin_and_bad_targets() {
        let tmp = tempfile::tempdir().unwrap();
        let upd = |name: &str| AgentUpdate {
            name: name.to_string(),
            description: "d".into(),
            preamble: "p\n".into(),
        };
        assert!(matches!(
            update_agent(
                tmp.path(),
                &Default::default(),
                "ghost",
                upd("ghost"),
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::NoSuchAgent(_))
        ));
        put_agent(tmp.path(), "locked", "d", "p\n", "");
        let mark = BuiltinAgentMark::of(&["locked"]);
        assert!(matches!(
            update_agent(
                tmp.path(),
                &mark,
                "locked",
                upd("renamed"),
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::BuiltinNameLocked(_))
        ));
        // A builtin keeps every field editable under its own name.
        assert!(update_agent(
            tmp.path(),
            &mark,
            "locked",
            AgentUpdate {
                name: "locked".into(),
                description: "edited".into(),
                preamble: "edited\n".into(),
            },
            &Default::default(),
            &Default::default()
        )
        .is_ok());
        put_agent(tmp.path(), "taken", "d", "p\n", "");
        assert!(matches!(
            update_agent(
                tmp.path(),
                &Default::default(),
                "locked",
                upd("taken"),
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::NameTaken(_))
        ));
        assert!(matches!(
            update_agent(
                tmp.path(),
                &Default::default(),
                "locked",
                upd("explore"),
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::ReservedAgentName(_))
        ));
    }

    #[test]
    fn update_and_delete_refuse_a_non_kebab_addressed_name() {
        // The addressed name joins the path directly (IPC-provided); the
        // shape refusal keeps the join root-bound (the delete_skill posture).
        let tmp = tempfile::tempdir().unwrap();
        put_agent(tmp.path(), "mine", "d", "p\n", "");
        assert!(matches!(
            update_agent(
                tmp.path(),
                &Default::default(),
                "../escape",
                AgentUpdate {
                    name: "mine".into(),
                    description: "d".into(),
                    preamble: "p\n".into(),
                },
                &Default::default(),
                &Default::default(),
            ),
            Err(AgentError::InvalidName(_))
        ));
        assert!(matches!(
            delete_agent(tmp.path(), &Default::default(), "../escape"),
            Err(AgentError::InvalidName(_))
        ));
    }

    // --- delete --------------------------------------------------------------

    #[test]
    fn delete_removes_a_user_file_and_refuses_builtin_and_unknown() {
        let tmp = tempfile::tempdir().unwrap();
        put_agent(tmp.path(), "mine", "d", "p\n", "");
        delete_agent(tmp.path(), &Default::default(), "mine").unwrap();
        assert!(!tmp.path().join("mine.md").exists());

        put_agent(tmp.path(), "general-purpose", "d", "p\n", "");
        let mark = BuiltinAgentMark::of(&["general-purpose"]);
        assert!(matches!(
            delete_agent(tmp.path(), &mark, "general-purpose"),
            Err(AgentError::BuiltinUndeletable(_))
        ));
        assert!(matches!(
            delete_agent(tmp.path(), &Default::default(), "ghost"),
            Err(AgentError::NoSuchAgent(_))
        ));
    }

    /// Create a file symlink `link -> target`, returning false when the
    /// platform refuses (Windows without the symlink privilege) so the
    /// caller skips the linked-path assertions (CI runs on Linux, where the
    /// symlink always lands). Unlike directories, a file link has no
    /// no-elevation junction fallback.
    fn try_file_link(target: &Path, link: &Path) -> bool {
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(target_os = "windows")]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }

    #[test]
    fn linked_definitions_are_read_only_and_delete_removes_the_link_only() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(
            outside.join("external.md"),
            "---\nname: external\ndescription: External.\n---\nExternal body.\n",
        )
        .unwrap();
        let root = tmp.path().join("agents");
        std::fs::create_dir_all(&root).unwrap();
        if !try_file_link(&outside.join("external.md"), &root.join("external.md")) {
            eprintln!("skipping: platform refused symlink creation");
            return;
        }
        let listing = list_agents(
            &root,
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        let linked = &listing.agents[0];
        assert_eq!(linked.source, AgentSource::Linked);
        assert!(linked.link_target.is_some());
        assert!(matches!(
            update_agent(
                &root,
                &Default::default(),
                "external",
                AgentUpdate {
                    name: "external".into(),
                    description: "d".into(),
                    preamble: "p\n".into(),
                },
                &Default::default(),
                &Default::default()
            ),
            Err(AgentError::ReadOnly(_))
        ));
        delete_agent(&root, &Default::default(), "external").unwrap();
        assert!(!root.join("external.md").exists());
        // The external source file stands (the sentinel).
        assert!(outside.join("external.md").exists());
    }

    // --- scan degradation (issue #937) ---------------------------------------

    #[test]
    fn a_metadata_not_found_reads_as_a_non_file() {
        // A dangling link's follow-the-link metadata faults NotFound -- that
        // is the legitimate "not a file" shape, not an entry vanishing.
        let is_file =
            is_loadable_file(Err(std::io::Error::from(std::io::ErrorKind::NotFound))).unwrap();
        assert!(!is_file);
    }

    #[test]
    fn a_metadata_fault_is_not_a_non_file() {
        // ACL / lock faults must reach the caller as Err so the entry lands
        // in ignored instead of vanishing (issue #937 posture D).
        let err = is_loadable_file(Err(std::io::Error::from(
            std::io::ErrorKind::PermissionDenied,
        )))
        .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn list_skips_a_dangling_link_without_ignoring_it() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("agents");
        std::fs::create_dir_all(&root).unwrap();
        if !try_file_link(&root.join("no-such-target.md"), &root.join("dangling.md")) {
            eprintln!("skipping: platform refused symlink creation");
            return;
        }
        let listing = list_agents(
            &root,
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        // A dangling link is not a definition file: skipped, and NotFound is
        // not a fault -- no ignored row.
        assert!(listing.agents.is_empty());
        assert!(listing.ignored.is_empty());
    }

    #[test]
    fn list_ignores_a_symlink_loop_and_reports_the_builtin_read_fault() {
        // A symlink loop faults the follow-the-link metadata with a
        // non-NotFound error on both platforms (ELOOP /
        // CANT_RESOLVE_SYMLINK): the entries must land in ignored instead of
        // vanishing (posture D), and the builtin whose name the loop squats
        // on reads as a read fault -- not a materialization failure (the
        // exists()-collapse fix).
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("agents");
        std::fs::create_dir_all(&root).unwrap();
        if !try_file_link(&root.join("twin.md"), &root.join("general-purpose.md"))
            || !try_file_link(&root.join("general-purpose.md"), &root.join("twin.md"))
        {
            eprintln!("skipping: platform refused symlink creation");
            return;
        }
        let listing = list_agents(
            &root,
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        assert!(listing.agents.is_empty());
        assert_eq!(listing.ignored.len(), 2);
        assert!(listing
            .ignored
            .iter()
            .all(|s| s.reason.contains("metadata")));
        let files: Vec<&str> = listing.ignored.iter().map(|s| s.file.as_str()).collect();
        assert_eq!(files, vec!["general-purpose.md", "twin.md"]);
        assert_eq!(
            listing.warnings,
            vec![AgentWarning::ReadFault {
                name: "general-purpose".into()
            }]
        );
    }

    #[test]
    fn list_carries_the_builtin_degradation_warnings() {
        // The read-side audit rides the listing (issue #937 posture C): a
        // user file squatting on a shipped name surfaces as a deferred
        // warning next to the ordinary row.
        let tmp = tempfile::tempdir().unwrap();
        put_agent(
            tmp.path(),
            "general-purpose",
            "Mine.",
            "My own preamble.\n",
            "",
        );
        let listing = list_agents(
            tmp.path(),
            &Default::default(),
            &Default::default(),
            &Default::default(),
        );
        assert_eq!(listing.agents.len(), 1); // the user's row stands
        assert_eq!(
            listing.warnings,
            vec![AgentWarning::Deferred {
                name: "general-purpose".into()
            }]
        );
    }
}
