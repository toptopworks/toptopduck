//! Builtin skills (ADR-0121): the app-authored skills that ride the app
//! version. Most are CLI companions, one per builtin CLI registration entry
//! (same name, 1:1); a knowledge-only skill (first: `vega-chart`) ships
//! without a CLI counterpart and anchors on the app version alone.
//!
//! The definition body is a compile-time-embedded FILE TREE
//! (`src/skills/assets/builtin/<name>/`, `include_dir!`): `SKILL.md` plus any
//! `scripts/` / `references/` assets, English-only (the body's consumer is
//! the model; ADR-0121 Decision 2). The code side keeps only the MANIFEST --
//! names, CLI companion wiring -- and the alignment engine.
//!
//! Materialization is a READ-ONLY CACHE in the registry's reserved subtree
//! `<skills-root>/.system/` (ADR-0121 Decision 3): the alignment window
//! (still riding the CLI scan, issue #677) writes the whole embedded tree per
//! anchored skill and records a fingerprint marker (sorted paths + content
//! hashes + a version salt) inside the subtree. A matching fingerprint skips
//! with zero writes; any mismatch (missing, external edit, retired file,
//! app-version bump) deletes the subtree and rewrites it -- the files are app
//! deployment assets, not user content, so there is no edit detection, no
//! edit preservation, and no restore action. A same-named LOCAL skill at the
//! registry root shadows the builtin (Decision 5): the merge-side deference
//! lives in the registry scan ([`super::registry`]), never here --
//! materialization always runs.
//!
//! A skill body enters the system prompt, so the shipped set is a trust
//! boundary: a third-party `SKILL.md` is never auto-absorbed (the manual
//! import flow stays the only path for those; ADR-0109 Decision 5).

use std::path::{Path, PathBuf};

use include_dir::{include_dir, Dir};

use super::model::SkillError;

/// The registry's reserved subtree (ADR-0121 Decision 3): where the builtin
/// skills' read-only cache lives. Dot-prefixed, so the generic registry scan
/// skips it (the codex `.system` convention) and merges it explicitly
/// instead; the app-side create / import / rename refuse the subtree's skill
/// names, while the filesystem stays free (the fork channel: copy
/// `.system/<name>/` to the registry root for an editable variant).
pub(crate) const SYSTEM_SUBTREE: &str = ".system";

/// The alignment marker's file name inside each skill's subtree: holds the
/// embedded-tree fingerprint the last alignment wrote. Bookkeeping, not skill
/// content -- excluded from the fingerprint input and from the attachment
/// read surface.
pub(crate) const FINGERPRINT_FILE: &str = ".fingerprint";

/// The tree fingerprint's version salt (ADR-0121 Decision 3): folded into
/// every fingerprint, so an app-version bump can never compare equal to a
/// marker an older build wrote -- each release re-aligns the subtree once,
/// cleanly, even when the embedded bytes did not change.
const VERSION_SALT: &str = env!("CARGO_PKG_VERSION");

/// The embedded builtin-skill asset tree (ADR-0121 Decision 1): one
/// directory per skill, `SKILL.md` + any attachment assets. The build script
/// declares the recursive rerun-if-changed so an edited or newly added asset
/// rebuilds the binary.
static BUILTIN_SKILL_ASSETS: Dir = include_dir!("src/skills/assets/builtin");

/// One manifest entry: the code-side residue of a shipped skill (ADR-0121
/// Decision 1). A companioned skill's `name` equals its companion CLI
/// registration's name (the two namespaces are disjoint by construction);
/// a knowledge-only skill has no CLI counterpart.
pub(crate) struct BuiltinSkillManifest {
    pub name: &'static str,
    /// The builtin CLI entry this skill rides, if any (ADR-0120 Decision 7).
    /// `Some` -- the CLI companions: alignment and auto-include gate on the
    /// entry. `None` -- a knowledge-only skill (first: `vega-chart`): the
    /// app version is the anchor, so alignment takes no CLI condition and
    /// auto-include drops the CLI conjunct.
    pub companion_cli: Option<&'static str>,
}

/// The shipped set: the v1 CLI-companion trio (pandoc, python, office-cli)
/// plus the knowledge-only pair (`vega-chart`, and the distillation
/// curriculum `skill-creator`). Additive evolution mirrors the CLI set:
/// new entries pass the same curation screen.
pub(crate) static BUILTIN_SKILL_MANIFEST: &[BuiltinSkillManifest] = &[
    BuiltinSkillManifest {
        name: "pandoc",
        companion_cli: Some("pandoc"),
    },
    BuiltinSkillManifest {
        name: "python",
        companion_cli: Some("python"),
    },
    BuiltinSkillManifest {
        name: "office-cli",
        companion_cli: Some("office-cli"),
    },
    BuiltinSkillManifest {
        name: "vega-chart",
        companion_cli: None,
    },
    BuiltinSkillManifest {
        name: "skill-creator",
        companion_cli: None,
    },
];

/// The reserved-name class for the SKILLS namespace (ADR-0109 Decision 7
/// mirrored on the skill side; ADR-0121 keeps it reading the manifest):
/// static full-set membership, independent of detection or alignment.
/// Create / import / rename refuse these names with the dedicated typed
/// error so the refusal reads as "reserved for a builtin", not "already
/// taken" -- while the filesystem stays free (the fork channel).
pub(crate) fn is_reserved_skill_name(name: &str) -> bool {
    find_manifest_entry(name).is_some()
}

/// Find the shipped manifest entry a name belongs to. `None` = not in the
/// curated set.
pub(crate) fn find_manifest_entry(name: &str) -> Option<&'static BuiltinSkillManifest> {
    BUILTIN_SKILL_MANIFEST.iter().find(|m| m.name == name)
}

/// Whether a directory at the registry root owns the name -- the
/// shadowing arm of [`resolve_skill_dir`]'s order (ADR-0121 Decision 5).
/// Shared by the resolver and the registry scan's merge-side suppression,
/// so the rule lives in one place.
pub(crate) fn is_shadowed_by_local(root: &Path, name: &str) -> bool {
    std::fs::metadata(root.join(name))
        .map(|m| m.is_dir())
        .unwrap_or(false)
}

/// Resolve a skill name to its on-disk directory in the shadowing order
/// (ADR-0121 Decision 5): a directory at `<root>/<name>` -- local, linked,
/// or a filesystem fork -- wins; the reserved-subtree copy
/// `<root>/.system/<name>` is the fallback. Listing, invocation, and
/// auto-include all resolve through this one order, so a local skill owning
/// the name shadows the builtin everywhere and the builtin returns when the
/// local copy is deleted. `None` when neither exists.
pub(crate) fn resolve_skill_dir(root: &Path, name: &str) -> Option<PathBuf> {
    if is_shadowed_by_local(root, name) {
        return Some(root.join(name));
    }
    let system = root.join(SYSTEM_SUBTREE).join(name);
    if std::fs::metadata(&system)
        .map(|m| m.is_dir())
        .unwrap_or(false)
    {
        return Some(system);
    }
    None
}

/// The registered `Builtin`-sourced CLI entry a manifest entry rides
/// (ADR-0120 Decision 7, kept by ADR-0121): the shared lookup under the
/// alignment anchor and the auto-include gate (the gate additionally
/// requires the entry ENABLED). `None` for a knowledge-only skill (no
/// companion) or an unregistered / user-sourced companion.
fn companion_entry<'a>(
    entry: &BuiltinSkillManifest,
    cli: &'a [crate::cli_tools::config::CliToolConfig],
) -> Option<&'a crate::cli_tools::config::CliToolConfig> {
    let companion = entry.companion_cli?;
    cli.iter().find(|t| {
        t.name == companion && t.source == crate::cli_tools::config::CliToolSource::Builtin
    })
}

/// The alignment anchor: whether a CLI registry anchors this entry (ADR-0120
/// Decision 7, kept by ADR-0121). A companioned skill anchors on its
/// `Builtin`-sourced entry being registered (a dormant or user-sourced entry
/// anchors nothing); a knowledge-only skill is anchored by the app version
/// itself.
fn cli_anchor(
    entry: &BuiltinSkillManifest,
    cli: &[crate::cli_tools::config::CliToolConfig],
) -> bool {
    match entry.companion_cli {
        None => true,
        Some(_) => companion_entry(entry, cli).is_some(),
    }
}

/// The auto-include gate: a companioned skill rides the enabled state of its
/// `Builtin`-sourced entry; a knowledge-only skill has nothing to ride, so
/// the gate is unconditionally open.
fn auto_include_gate(
    entry: &BuiltinSkillManifest,
    cli: &[crate::cli_tools::config::CliToolConfig],
) -> bool {
    match entry.companion_cli {
        None => true,
        Some(_) => companion_entry(entry, cli).is_some_and(|t| t.enabled),
    }
}

// ---------------------------------------------------------------------------
// Alignment (rides the CLI scan window, issue #677; ADR-0121 Decision 3)

/// The align outcome: the names of the builtin skills whose reserved-subtree
/// write the window could not complete (issue #1016 semantics, now riding
/// the whole-tree write). A failure keeps the degraded posture -- warn, no
/// marker, nothing persisted -- but surfaces by name so the scan payload can
/// render the missing row's warning in the Skills panel; the next scan
/// retries. The retirement sweep's own failures (a blocked delete) are
/// warn-only -- the leftover is app-owned cache, the next window retries,
/// and no row rides the lane for it. Alignment writes NOTHING to app-config
/// (the side table is retired), so there is no dirty bit.
pub(crate) struct AlignOutcome {
    pub(crate) materialize_failures: Vec<String>,
}

/// Align the reserved subtree against the embedded tree and the CURRENT CLI
/// registry: per anchored manifest entry, the on-disk `.system/<name>/` tree
/// is brought to byte-agreement with the embedded one (skip when the
/// fingerprint already agrees; delete + rewrite otherwise), then the
/// retirement sweep reclaims leftovers of names that left the manifest.
/// Per-skill write failures degrade with a warn and the name rides the
/// lane (issue #1016); a blocked retirement delete or a failure reading
/// the reserved subtree itself is warn-only, no name (the next window
/// retries). Shadowing is NOT consulted here (ADR-0121 Decision 5):
/// materialization always runs; the deference happens only at the
/// registry-scan merge.
pub(crate) fn align(root: &Path, cli: &crate::cli_tools::config::CliToolRegistry) -> AlignOutcome {
    let mut materialize_failures = Vec::new();
    for entry in BUILTIN_SKILL_MANIFEST {
        if !cli_anchor(entry, &cli.tools) {
            continue;
        }
        if let Err(e) = align_one(root, entry) {
            materialize_failures.push(entry.name.to_string());
            log::warn!(
                target: "skills",
                "builtin skill `{}` failed to align (the next scan retries): {e}",
                entry.name
            );
        }
    }
    retire_orphaned_subtrees(root);
    AlignOutcome {
        materialize_failures,
    }
}

/// The retirement sweep (issue #1022): a first-level `.system/` directory
/// whose name is not in the manifest is a retired skill's leftover cache --
/// `.system` is an app-owned cache, not user files (ADR-0121 Decision 3),
/// so it is deleted wholesale instead of merging as an undeletable orphan
/// builtin row. A blocked delete is warn-only: the leftover is app-owned
/// cache, the next window retries, and no name rides the materialize lane
/// for it. A missing `.system/` is the quiet nothing-to-clean.
/// Non-directories (loose files, hand-placed links) are left alone: only
/// the shapes the write path itself creates are the sweep's business.
fn retire_orphaned_subtrees(root: &Path) {
    let entries = match std::fs::read_dir(root.join(SYSTEM_SUBTREE)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!(
                target: "skills",
                "builtin retirement sweep could not read `{}` (the next scan retries): {e}",
                root.join(SYSTEM_SUBTREE).display()
            );
            return;
        }
    };
    for entry in entries {
        // A failed enumeration warns and skips rather than being silently
        // dropped by flatten() (the registry scan's own rule).
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!(
                    target: "skills",
                    "builtin retirement sweep could not read an entry (skipped; the next scan retries): {e}"
                );
                continue;
            }
        };
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if find_manifest_entry(&name).is_some() {
            continue;
        }
        if let Err(e) = std::fs::remove_dir_all(entry.path()) {
            log::warn!(
                target: "skills",
                "retired builtin skill `{name}` failed to clean up (the next scan retries): {e}"
            );
        }
    }
}

/// Align one skill's subtree (see [`align`]). The registry root is minted
/// lazily (a never-created registry materializes on the first anchored
/// window).
fn align_one(root: &Path, entry: &BuiltinSkillManifest) -> Result<(), SkillError> {
    let files = embedded_files(entry.name);
    let expected = tree_fingerprint(&files);
    let dir = root.join(SYSTEM_SUBTREE).join(entry.name);
    // A plain FILE squatting the subtree path is a blocker, not app content:
    // fail per-skill (the #1016 degrade posture -- the name rides the
    // failure lane, the next scan retries) rather than delete anything.
    if dir.symlink_metadata().map(|m| !m.is_dir()).unwrap_or(false) {
        return Err(SkillError::FsFailure(format!(
            "builtin skill path `{}` is occupied by a non-directory",
            dir.display()
        )));
    }
    // Quiet path: the on-disk tree already fingerprint-matches the embedded
    // one -- zero writes (the fingerprint covers every file plus the version
    // salt, so an external edit, a stale file, or an app bump all read as a
    // mismatch below).
    if let Ok(found) = disk_files(&dir) {
        if tree_fingerprint(&found) == expected {
            return Ok(());
        }
    }
    // Mismatch: the subtree is an app cache, so it is deleted wholesale and
    // rewritten from the embedded tree, marker last (a crash mid-rewrite
    // leaves a fingerprint-less subtree that the next window rebuilds).
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| {
            SkillError::FsFailure(format!(
                "remove stale builtin subtree `{}` failed: {e}",
                dir.display()
            ))
        })?;
    }
    for (path, bytes) in &files {
        // '/'-separated relatives join correctly on both platform families.
        let target = dir.join(path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                SkillError::FsFailure(format!(
                    "create builtin asset directory `{}` failed: {e}",
                    parent.display()
                ))
            })?;
        }
        std::fs::write(&target, bytes).map_err(|e| {
            SkillError::FsFailure(format!(
                "write builtin asset `{}` failed: {e}",
                target.display()
            ))
        })?;
    }
    std::fs::write(dir.join(FINGERPRINT_FILE), &expected).map_err(|e| {
        SkillError::FsFailure(format!(
            "write builtin fingerprint `{}` failed: {e}",
            dir.join(FINGERPRINT_FILE).display()
        ))
    })?;
    log::info!(
        target: "skills",
        "builtin skill `{}` aligned to the embedded tree", entry.name
    );
    Ok(())
}

/// Compute a tree fingerprint (ADR-0121 Decision 3): the version salt folded
/// with every file's '/'-relative path + content hash, iterated in sorted
/// path order. Deterministic by construction, so equal trees hash equal and
/// the marker comparison is exact.
fn tree_fingerprint(files: &[(String, Vec<u8>)]) -> String {
    let mut acc = String::from(VERSION_SALT);
    for (path, bytes) in files {
        acc.push_str(path);
        acc.push('\0');
        acc.push_str(&crate::util::sha256_hex(bytes));
        acc.push('\n');
    }
    crate::util::sha256_hex(acc.as_bytes())
}

/// The embedded subtree of one builtin skill: every file with its
/// '/'-relative path, sorted by path (the fingerprint's iteration order).
/// Empty when the asset tree carries no such directory (the manifest / asset
/// agreement test pins that this never happens for a shipped entry).
fn embedded_files(name: &str) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    if let Some(dir) = BUILTIN_SKILL_ASSETS.get_dir(name) {
        collect_embedded(dir, "", &mut files);
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

/// Join one component onto a '/'-separated relative prefix (the shared
/// spelling of the embedded and disk collectors).
fn join_rel(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

fn collect_embedded(dir: &Dir, prefix: &str, out: &mut Vec<(String, Vec<u8>)>) {
    for file in dir.files() {
        let name = file
            .path()
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        out.push((join_rel(prefix, &name), file.contents().to_vec()));
    }
    for sub in dir.dirs() {
        let name = sub
            .path()
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let prefix = join_rel(prefix, &name);
        collect_embedded(sub, &prefix, out);
    }
}

/// Collect the on-disk subtree as ('/'-path, bytes) pairs for the
/// fingerprint comparison, EXCLUDING the marker file itself (it is written
/// after the tree and re-derived every alignment). A missing subtree reads
/// empty (a mismatch against any non-empty embedded tree -> write). A read
/// error skips the quiet path -- the rewrite attempt that follows is what
/// surfaces it as a per-skill failure (the #1016 degrade posture).
fn disk_files(dir: &Path) -> Result<Vec<(String, Vec<u8>)>, SkillError> {
    let mut out = Vec::new();
    collect_disk(dir, "", &mut out)?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn collect_disk(
    dir: &Path,
    prefix: &str,
    out: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), SkillError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // A missing subtree is the empty fingerprint input, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(SkillError::FsFailure(format!(
                "read builtin subtree `{}` failed: {e}",
                dir.display()
            )))
        }
    };
    for entry in entries {
        let entry = entry.map_err(|e| {
            SkillError::FsFailure(format!(
                "read builtin subtree entry under `{}` failed: {e}",
                dir.display()
            ))
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let rel = join_rel(prefix, &name);
        // The alignment marker is bookkeeping, never fingerprint input.
        if prefix.is_empty() && name == FINGERPRINT_FILE {
            continue;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        // Real directories recurse (links never do -- the subtree is
        // app-owned and the write path only ever creates real directories).
        // A hand-placed DIRECTORY link never reaches this arm and so is
        // absent from the fingerprint input -- it rides until some mismatch
        // rewrites the subtree around it. A hand-placed FILE link is
        // followed below and enters the input as (link path, target bytes)
        // -- itself a mismatch against the embedded tree, so the next
        // window deletes and rewrites the subtree around it.
        if ft.is_dir() {
            collect_disk(&path, &rel, out)?;
        } else if std::fs::metadata(&path)
            .map(|m| m.is_file())
            .unwrap_or(false)
        {
            let bytes = std::fs::read(&path).map_err(|e| {
                SkillError::FsFailure(format!(
                    "read builtin asset `{}` failed: {e}",
                    path.display()
                ))
            })?;
            out.push((rel, bytes));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Auto-include (ADR-0109 Decision 6: the folded initial set)

/// The builtin skill names a NEW session auto-includes: a companioned skill
/// needs its companion CLI entry `Builtin`-sourced AND enabled; a
/// knowledge-only skill (ADR-0120 Decision 7) rides the app version and
/// skips the CLI conjunct. Presence resolves through the shadowing order
/// ([`resolve_skill_dir`]), so under a local fork the seeded name resolves
/// to the local copy (ADR-0121 Decision 5). Computed fresh at session
/// creation and at resume (never persisted, never an event); a disabled
/// tool drops out on the next recomputation.
pub(crate) fn auto_included_names(
    cli: &[crate::cli_tools::config::CliToolConfig],
    skills_root: &Path,
) -> Vec<String> {
    BUILTIN_SKILL_MANIFEST
        .iter()
        .filter(|entry| auto_include_gate(entry, cli))
        .filter(|entry| resolve_skill_dir(skills_root, entry.name).is_some())
        .map(|entry| entry.name.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_tools::config::{CliToolConfig, CliToolSource};

    /// A registry builder for the align scenarios.
    fn registry_with(tools: Vec<CliToolConfig>) -> crate::cli_tools::config::CliToolRegistry {
        crate::cli_tools::config::CliToolRegistry { tools }
    }

    /// A Builtin-sourced pandoc registration (enabled by default).
    fn builtin_pandoc(enabled: bool) -> CliToolConfig {
        CliToolConfig {
            name: "pandoc".to_string(),
            description: String::new(),
            executable: "pandoc".to_string(),
            argv_template: Vec::new(),
            params: Vec::new(),
            env: Default::default(),
            enabled,
            source: CliToolSource::Builtin,
            baseline: None,
        }
    }

    /// The parsed SKILL.md of one embedded skill (every content test reads
    /// through this single door, so the asset->parse pipeline itself is what
    /// the suite pins).
    fn parsed_asset(name: &str) -> super::super::frontmatter::ParsedSkillMd {
        let files = embedded_files(name);
        let content = String::from_utf8(
            files
                .iter()
                .find(|(p, _)| p == "SKILL.md")
                .unwrap_or_else(|| panic!("{name} has no embedded SKILL.md"))
                .1
                .clone(),
        )
        .expect("SKILL.md is UTF-8");
        super::super::frontmatter::parse_skill_md(&content).expect("SKILL.md parses")
    }

    fn description_of(name: &str) -> String {
        super::super::frontmatter::get_string(&parsed_asset(name).frontmatter, "description")
            .expect("description")
    }

    fn body_of(name: &str) -> String {
        parsed_asset(name).body
    }

    /// The knowledge-only names, sorted (the set an EMPTY CLI registry
    /// still aligns); self-scales as the knowledge-only set grows.
    fn knowledge_only_names_sorted() -> Vec<&'static str> {
        let mut names: Vec<&'static str> = BUILTIN_SKILL_MANIFEST
            .iter()
            .filter(|m| m.companion_cli.is_none())
            .map(|m| m.name)
            .collect();
        names.sort_unstable();
        names
    }

    // --- the shipped set ----------------------------------------------------

    /// The manifest and the embedded asset tree agree both ways (ADR-0121
    /// Decision 1): every asset directory has a manifest entry, every
    /// manifest entry has an asset directory carrying a `SKILL.md`. A
    /// renamed or deleted asset dir dies here instead of shipping a
    /// silently-empty skill.
    #[test]
    fn the_manifest_and_the_asset_tree_agree() {
        let mut asset_dirs: Vec<String> = BUILTIN_SKILL_ASSETS
            .dirs()
            .map(|d| {
                d.path()
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
            .collect();
        asset_dirs.sort();
        let mut manifest_names: Vec<&str> = BUILTIN_SKILL_MANIFEST.iter().map(|m| m.name).collect();
        manifest_names.sort_unstable();
        assert_eq!(asset_dirs, manifest_names, "asset dirs == manifest names");
        for name in &manifest_names {
            assert!(
                embedded_files(name).iter().any(|(p, _)| p == "SKILL.md"),
                "{name} must embed a SKILL.md"
            );
        }
        // The reserved-name set reads the manifest (ADR-0121): the four
        // shipped names refuse create/import/rename, anything else is free.
        for name in &manifest_names {
            assert!(is_reserved_skill_name(name), "{name} is reserved");
        }
        assert!(!is_reserved_skill_name("my-pandoc"));
    }

    /// Every embedded SKILL.md is spec-valid: parses, carries its manifest
    /// name, a description, a non-blank body, and no metadata mapping (the
    /// retired extension keys, issue #952 -- materialization leaves no
    /// toptopduck trace).
    #[test]
    fn every_embedded_skill_md_is_valid_and_name_matched() {
        for entry in BUILTIN_SKILL_MANIFEST {
            let parsed = parsed_asset(entry.name);
            assert_eq!(
                super::super::frontmatter::get_string(&parsed.frontmatter, "name").unwrap(),
                entry.name
            );
            assert!(
                parsed
                    .frontmatter
                    .get(serde_yaml::Value::String("metadata".into()))
                    .is_none(),
                "{} must be metadata-free",
                entry.name
            );
            assert!(!parsed.body.trim().is_empty(), "body must be non-blank");
        }
    }

    /// English-only (ADR-0121 Decision 2): the embedded prose carries no
    /// CJK -- a locale literal migrating into the asset tree undetected
    /// dies here.
    #[test]
    fn embedded_prose_is_english_only() {
        for entry in BUILTIN_SKILL_MANIFEST {
            let files = embedded_files(entry.name);
            let all = files
                .iter()
                .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
                .collect::<String>();
            assert!(
                all.chars().all(|c| !('\u{4e00}'..='\u{9fff}').contains(&c)),
                "{} carries CJK prose",
                entry.name
            );
        }
    }

    /// The declared companion wiring: the v1 trio rides its same-named CLI
    /// entry; `vega-chart` is the first knowledge-only skill. The pairing
    /// stays 1:1 with the CLI shipped set and same-name (the module-doc
    /// invariant -- a divergent pair would desync the anchor
    /// (companion-keyed) from the reserved-name set (name-keyed)).
    #[test]
    fn companioned_entries_declare_their_cli_and_vega_chart_rides_none() {
        let trio: &[(&str, &str)] = &[
            ("pandoc", "pandoc"),
            ("python", "python"),
            ("office-cli", "office-cli"),
        ];
        for (skill, cli) in trio {
            assert_eq!(
                find_manifest_entry(skill).expect("entry").companion_cli,
                Some(*cli),
                "{skill} keeps its CLI companion"
            );
        }
        assert_eq!(
            find_manifest_entry("vega-chart")
                .expect("entry")
                .companion_cli,
            None,
            "vega-chart is knowledge-only"
        );
        for entry in BUILTIN_SKILL_MANIFEST {
            if let Some(companion) = entry.companion_cli {
                assert_eq!(
                    companion, entry.name,
                    "a companioned skill shares its CLI entry's name"
                );
                assert!(
                    crate::cli_tools::builtin::BUILTIN_DEFINITIONS
                        .iter()
                        .any(|cli| cli.name == companion),
                    "{companion} must address a shipped CLI definition"
                );
            }
        }
    }

    // --- curated trigger copy ------------------------------------------------

    /// The locked trigger copy (curation brief, verbatim): sentence 1 is
    /// capability + trigger timing, sentence 2 the neighbor-tool boundary.
    /// With progressive disclosure the metadata index is the only discovery
    /// surface, so the wording itself is load-bearing -- pinned byte for
    /// byte. English-only since ADR-0121 Decision 2.
    #[test]
    fn descriptions_carry_the_locked_trigger_copy() {
        let expected: &[(&str, &str)] = &[
            (
                "pandoc",
                "Convert existing documents between formats with the local \
                 pandoc — render Markdown to DOCX/HTML/PDF for delivery, or \
                 read DOCX/EPUB into Markdown for analysis. Authoring or \
                 manipulating Office-file content (tables, templates, \
                 reports) belongs to office-cli.",
            ),
            (
                "office-cli",
                "Work directly on Office-file content with the local \
                 OfficeCLI (Word, Excel, PowerPoint): extract text and \
                 tables, edit, fill templates, or author a document from \
                 scratch. Converting a document that already exists between \
                 formats belongs to pandoc.",
            ),
            (
                "python",
                "Clean and transform data with a Python script on the local \
                 interpreter (stdlib always; user-installed packages usable) \
                 — reach for it when the logic is procedural: reshaping, \
                 regex massaging, unit fixing, multi-step row logic. Plain \
                 projection, filtering, and aggregation belong to SQL.",
            ),
            (
                "vega-chart",
                "Chart numeric shape — a trend over time, a distribution, a \
                 comparison across categories or groups — by emitting a \
                 vega-lite fence in the reply. Flowcharts, diagrams, and lone \
                 KPI figures are out of scope; they belong to plain prose or \
                 a table.",
            ),
            (
                "skill-creator",
                "Turn a repeated, reusable instruction pattern from this \
                 conversation into a skill — propose this whenever the user \
                 repeats a workflow, asks to remember how to do something, or \
                 wants a new skill; drafts the document and calls the \
                 create_skill tool.",
            ),
        ];
        for (name, en) in expected {
            assert_eq!(&description_of(name), en, "{name} description");
        }
    }

    /// The format/content split is cross-referenced symmetrically through
    /// the OWNERSHIP sentence ("belongs to X"), not a bare neighbor
    /// mention: the index shows all entries at once, so the boundary
    /// sentence is what disambiguates them.
    #[test]
    fn boundary_sentences_cross_reference_the_neighbor() {
        let pairs: &[(&str, &str)] = &[
            ("pandoc", "belongs to office-cli"),
            ("office-cli", "belongs to pandoc"),
            ("python", "belong to SQL"),
        ];
        for (name, phrase) in pairs {
            assert!(
                description_of(name).contains(*phrase),
                "{} description must keep the boundary phrase {phrase:?}",
                name
            );
        }
    }

    /// Python library semantics erratum: "nothing bundled with the app" is
    /// not "stdlib only" -- user-installed packages import normally, and the
    /// description and the body must agree on that.
    #[test]
    fn python_copy_states_library_semantics_accurately() {
        let description = description_of("python");
        let body = body_of("python");
        assert!(
            !description.contains("stdlib only") && !body.contains("stdlib only"),
            "the stale absolute claim must be gone from both"
        );
        assert!(body.contains("packages the user has installed themselves import normally"));
    }

    /// Length discipline (curation brief): every description fits two
    /// sentences and at most 45 words -- the index is re-read every turn.
    #[test]
    fn descriptions_stay_within_the_curated_length_budget() {
        const MAX_WORDS: usize = 45;
        for entry in BUILTIN_SKILL_MANIFEST {
            let en = description_of(entry.name);
            let words = en.split_whitespace().count();
            assert!(
                words <= MAX_WORDS,
                "{} description is {words} words (budget {MAX_WORDS})",
                entry.name
            );
            let sentences = en
                .char_indices()
                .filter(|(i, c)| {
                    matches!(c, '.' | '?' | '!') && en[i + c.len_utf8()..].starts_with(' ')
                })
                .count()
                + 1;
            assert!(
                sentences <= 2,
                "{} description has {sentences} sentences",
                entry.name
            );
        }
    }

    /// The vega-chart body must teach the whole render contract (ADR-0120
    /// Decisions 1/3/5/6): the fence language rule, the four syntax rules,
    /// the whitelisted mark set (matching the frontend
    /// `WHITELISTED_MARKS`), the SQL-first + row-cap data guardrail, and an
    /// imitable minimal fence. Phrase pins, not verbatim: the CONTRACT
    /// items are what must survive a re-curation.
    #[test]
    fn vega_chart_body_teaches_the_render_contract() {
        let body = body_of("vega-chart");
        assert!(body.contains("`vega-lite`"), "names the fence language");
        assert!(body.contains("$schema"), "requires $schema");
        assert!(body.contains("v5.json"), "pins the v5 schema URL");
        assert!(body.contains("case-sensitive"), "teaches case sensitivity");
        for t in ["quantitative", "nominal", "ordinal", "temporal"] {
            assert!(body.contains(t), "lists type {t}");
        }
        assert!(body.contains("SQL"), "teaches SQL-first aggregation");
        assert!(body.contains("150 rows"), "carries the row guardrail");
        for m in [
            "bar", "line", "area", "point", "circle", "square", "arc", "rect",
        ] {
            assert!(body.contains(&format!("`{m}`")), "whitelists {m}");
        }
        // An imitable minimal fence ships in the body, and it is valid
        // strict JSON with a whitelisted mark -- it is the direct template
        // the agent imitates, so a re-curation typo must fail here.
        let example = body
            .split("```vega-lite\n")
            .nth(1)
            .and_then(|rest| rest.split("```").next())
            .expect("an example fence");
        let spec: serde_json::Value =
            serde_json::from_str(example).expect("the example fence is strict JSON");
        assert!(spec.get("$schema").is_some());
        assert_eq!(spec["mark"], "bar");
    }

    /// The curation budget for the vega-chart body (issue #1012): the body
    /// enters the prompt on every `invoke_skill`, so 4096 bytes is the hard
    /// ceiling.
    #[test]
    fn vega_chart_body_stays_within_the_curation_budget() {
        assert!(
            body_of("vega-chart").len() <= 4096,
            "body is {} bytes (budget 4096)",
            body_of("vega-chart").len()
        );
    }

    /// The skill-creator body must teach the whole distillation curriculum
    /// (ADR-0122 Decision 8, issue #1032): the SKILL.md format, the four
    /// distillation questions, description engineering demonstrated by a
    /// weak/strong rewrite pair, and the post-create test loop riding the
    /// by-name invocation channel. Phrase pins, not verbatim -- the
    /// CONTRACT items are what must survive a re-curation.
    #[test]
    fn skill_creator_body_teaches_the_distillation_curriculum() {
        let body = body_of("skill-creator");
        // Element 1: the SKILL.md format -- frontmatter fields + body.
        assert!(body.contains("frontmatter"), "teaches the frontmatter");
        for field in ["`name`", "`description`"] {
            assert!(body.contains(field), "names the {field} field");
        }
        // Element 2: the four distillation questions.
        for question in [
            "what it does",
            "when it applies",
            "what output it produces",
            "which session passages",
        ] {
            assert!(body.contains(question), "covers the {question} question");
        }
        // Element 3: description engineering -- the anti-undertrigger push,
        // demonstrated on a weak/strong rewrite pair.
        assert!(body.contains("undertrigger"), "names undertriggering");
        assert!(body.contains("Weak:"), "shows a weak example");
        assert!(body.contains("Strong:"), "shows a strong rewrite");
        // Element 4: the create + test loop, pinned against the #1031
        // landed shape (whole-document parameter, by-name test channel).
        assert!(body.contains("`create_skill`"), "references the tool");
        assert!(body.contains("`skillMarkdown`"), "names the parameter");
        assert!(body.contains("`invoke_skill`"), "names the test channel");
        assert!(body.contains("test prompt"), "suggests test prompts");
    }

    /// The curation budget for the skill-creator body: the same 4096-byte
    /// hard ceiling as vega-chart (the body enters the prompt on every
    /// `invoke_skill`).
    #[test]
    fn skill_creator_body_stays_within_the_curation_budget() {
        assert!(
            body_of("skill-creator").len() <= 4096,
            "body is {} bytes (budget 4096)",
            body_of("skill-creator").len()
        );
    }

    /// Bootstrap (ADR-0122 Decision 8): the skill's own description must
    /// pass the bar its curriculum sets -- each cue is pinned on its own
    /// (no disjunctions), so removing any one fire-surface word dies here,
    /// not only removing them all.
    #[test]
    fn skill_creator_description_walks_its_own_talk() {
        let description = description_of("skill-creator").to_lowercase();
        assert!(description.contains("skill"), "names the domain");
        assert!(
            description.contains("create_skill"),
            "names the create channel"
        );
        assert!(description.contains("whenever"), "carries a fire scene");
        assert!(description.contains("repeat"), "carries the pattern cue");
    }

    // --- align ----------------------------------------------------------------

    #[test]
    fn align_materializes_anchored_skills_under_the_reserved_subtree() {
        let root = tempfile::tempdir().expect("root");
        let outcome = align(root.path(), &registry_with(vec![builtin_pandoc(true)]));
        assert!(outcome.materialize_failures.is_empty());
        // The companioned skill aligns behind its Builtin-sourced entry...
        let pandoc = embedded_files("pandoc");
        for (path, bytes) in &pandoc {
            assert_eq!(
                &std::fs::read(root.path().join(".system/pandoc").join(path)).unwrap(),
                bytes,
                "embedded `{path}` materialized verbatim"
            );
        }
        assert!(root.path().join(".system/pandoc/.fingerprint").exists());
        // ...the knowledge-only skill aligns with no CLI condition...
        assert!(root.path().join(".system/vega-chart/SKILL.md").exists());
        // ...and the un-anchored companions materialize nothing.
        assert!(!root.path().join(".system/python").exists());
        assert!(!root.path().join(".system/office-cli").exists());
    }

    /// The quiet path (ADR-0121 Decision 3): a matching fingerprint writes
    /// nothing -- pinned by the marker's mtime, which a rewrite would
    /// necessarily move.
    #[test]
    fn align_skips_with_zero_writes_when_the_fingerprint_agrees() {
        let root = tempfile::tempdir().expect("root");
        let cli = registry_with(vec![builtin_pandoc(true)]);
        align(root.path(), &cli);
        let marker = root.path().join(".system/pandoc/.fingerprint");
        let before = std::fs::metadata(&marker)
            .expect("marker")
            .modified()
            .unwrap();
        align(root.path(), &cli);
        let after = std::fs::metadata(&marker)
            .expect("marker")
            .modified()
            .unwrap();
        assert_eq!(before, after, "an agreeing fingerprint rewrites nothing");
    }

    /// The readonly-cache reset semantics: an externally edited file (or a
    /// hand-dropped extra file) is reset on the next alignment -- the
    /// subtree is app-deployed content, never preserved (mutation pin:
    /// dropping the mismatch rewrite leaves the edit in place and this
    /// fails).
    #[test]
    fn align_resets_an_external_edit_and_removes_a_stale_file() {
        let root = tempfile::tempdir().expect("root");
        let cli = registry_with(vec![builtin_pandoc(true)]);
        align(root.path(), &cli);
        let skill_md = root.path().join(".system/pandoc/SKILL.md");
        std::fs::write(
            &skill_md,
            "---\nname: pandoc\ndescription: edited\n---\nEdited.\n",
        )
        .expect("edit");
        let stale = root.path().join(".system/pandoc/scripts/old.py");
        std::fs::create_dir_all(stale.parent().unwrap()).expect("mkdir");
        std::fs::write(&stale, "# stale\n").expect("stale");
        let outcome = align(root.path(), &cli);
        assert!(outcome.materialize_failures.is_empty());
        let (_, bytes) = embedded_files("pandoc")
            .into_iter()
            .find(|(p, _)| p == "SKILL.md")
            .unwrap();
        assert_eq!(
            std::fs::read(&skill_md).unwrap(),
            bytes,
            "the external edit is reset"
        );
        assert!(
            !stale.exists(),
            "a stale file outside the embedded set is removed"
        );
    }

    /// The failure lane (issue #1016, now riding the whole-tree write): a
    /// blocked path degrades per-skill -- warn, name in the lane, next scan
    /// retries -- and a cleared blocker heals. A plain FILE occupying the
    /// subtree path is the deterministic stand-in for the real failure
    /// classes (read-only skills root, full disk, antivirus interference).
    #[test]
    fn align_reports_failures_by_name_and_heals_when_cleared() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir(root.path().join(".system")).expect("mkdir");
        std::fs::write(root.path().join(".system/pandoc"), b"not a directory").expect("blocker");
        let outcome = align(root.path(), &registry_with(vec![builtin_pandoc(true)]));
        assert_eq!(
            outcome.materialize_failures,
            vec!["pandoc".to_string()],
            "only the blocked skill fails; vega-chart still aligns"
        );
        assert!(root.path().join(".system/vega-chart/SKILL.md").exists());
        // The degraded posture leaves no half-written tree behind.
        assert!(!root.path().join(".system/pandoc").is_dir());
        // The condition clears: the next window heals the lane (the warning
        // must not outlive the failure it reported).
        std::fs::remove_file(root.path().join(".system/pandoc")).expect("unblock");
        let healed = align(root.path(), &registry_with(vec![builtin_pandoc(true)]));
        assert!(healed.materialize_failures.is_empty());
        assert!(root.path().join(".system/pandoc/SKILL.md").exists());
    }

    #[test]
    fn align_skips_dormant_and_user_sourced_entries() {
        let root = tempfile::tempdir().expect("root");
        let mut user = builtin_pandoc(true);
        user.source = CliToolSource::User;
        let outcome = align(root.path(), &registry_with(vec![user]));
        // The user-sourced entry anchors nothing: no pandoc subtree, no
        // failure -- only the knowledge-only skill aligned.
        assert!(outcome.materialize_failures.is_empty());
        assert!(!root.path().join(".system/pandoc").exists());
        let mut aligned: Vec<String> = std::fs::read_dir(root.path().join(".system"))
            .expect(".system")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| find_manifest_entry(n).is_some())
            .collect();
        aligned.sort();
        let expected: Vec<String> = knowledge_only_names_sorted()
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(aligned, expected);
    }

    /// A local skill owning the name does NOT stop alignment (ADR-0121
    /// Decision 5: materialization always runs; the deference happens only
    /// at the registry-scan merge). The mutation target for the shadowing
    /// family: consulting shadowing here would skip the write and the
    /// restore-on-delete semantics would die with it.
    #[test]
    fn align_still_writes_when_a_local_skill_shadows_the_name() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir_all(root.path().join("vega-chart")).expect("fork dir");
        std::fs::write(
            root.path().join("vega-chart/SKILL.md"),
            "---\nname: vega-chart\ndescription: mine\n---\nBody.\n",
        )
        .expect("write");
        let outcome = align(root.path(), &registry_with(vec![]));
        assert!(outcome.materialize_failures.is_empty());
        assert!(
            root.path().join(".system/vega-chart/SKILL.md").exists(),
            "the reserved subtree is written regardless of the shadow"
        );
    }

    /// The retirement sweep (issue #1022): a first-level `.system/`
    /// directory whose name is not in the manifest is a retired skill's
    /// leftover cache, deleted wholesale. This is the runtime companion of
    /// the manifest/asset agreement test's both-sides-shrunk shape -- that
    /// test pins the shipped set agrees, this one pins the residue a shrink
    /// leaves behind is reclaimed, so the panel shows no orphaned builtin
    /// row in the settled state (a blocked delete rides the retire-failure
    /// lane until the next window reclaims it). Manifest names are never
    /// the sweep's business -- membership, not anchored-ness, is the skip
    /// rule (a dormant skill's cache survives).
    #[test]
    fn align_retires_a_subtree_whose_name_left_the_manifest() {
        let root = tempfile::tempdir().expect("root");
        let leftover = root.path().join(".system/legacy-chart");
        std::fs::create_dir_all(&leftover).expect("mkdir");
        std::fs::write(
            leftover.join("SKILL.md"),
            "---\nname: legacy-chart\ndescription: d\n---\nBody.\n",
        )
        .expect("write");
        let outcome = align(root.path(), &registry_with(vec![]));
        assert!(outcome.materialize_failures.is_empty());
        assert!(!leftover.exists(), "the retired subtree is reclaimed");
        // The sweep never touches manifest names: the knowledge-only skill
        // still aligns alongside the cleanup.
        assert!(root.path().join(".system/vega-chart/SKILL.md").exists());
    }

    /// A blocked retirement delete is warn-only: the leftover is app-owned
    /// cache, so nothing rides the materialize lane for it -- the subtree
    /// simply stays until the next window reclaims it. The blockers are
    /// platform stand-ins for the real failure classes (read-only skills
    /// root, antivirus interference) -- Windows: a no-share handle on an
    /// in-tree file (the one open-time sharing-violation blocker std's
    /// POSIX-semantics subtree delete cannot open around; a read-only
    /// attribute is the other defeat class std never clears); Unix: a
    /// write-stripped directory blocking the unlinks inside it.
    #[test]
    fn a_blocked_retirement_delete_stays_off_the_failure_lane() {
        let root = tempfile::tempdir().expect("root");
        let leftover = root.path().join(".system/legacy-chart");
        std::fs::create_dir_all(&leftover).expect("mkdir");
        let held = leftover.join("SKILL.md");
        std::fs::write(&held, "body\n").expect("write");
        #[cfg(windows)]
        use std::os::windows::ffi::OsStrExt;
        #[cfg(windows)]
        let held_handle = {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::Foundation::GENERIC_READ;
            use windows_sys::Win32::Storage::FileSystem::{
                CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
            };
            let path_w: Vec<u16> = held.as_os_str().encode_wide().chain([0]).collect();
            let raw = unsafe {
                CreateFileW(
                    path_w.as_ptr(),
                    GENERIC_READ,
                    0, // share nothing
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            assert!(raw as isize != -1, "open the held file");
            // File's Drop closes the handle on scope exit.
            unsafe { std::fs::File::from_raw_handle(raw) }
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&leftover, std::fs::Permissions::from_mode(0o555))
                .expect("chmod");
        }
        let outcome = align(root.path(), &registry_with(vec![]));
        assert!(
            outcome.materialize_failures.is_empty(),
            "a blocked retirement stays off the materialize lane"
        );
        assert!(leftover.join("SKILL.md").exists(), "the subtree stays");
        // Unblock: the next window reclaims the subtree (the warning must
        // not outlive the failure it reported).
        #[cfg(windows)]
        drop(held_handle);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&leftover, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        let healed = align(root.path(), &registry_with(vec![]));
        assert!(healed.materialize_failures.is_empty());
        assert!(!leftover.exists(), "the healed sweep reclaims the subtree");
    }

    /// A loose file under `.system/` is not a retired skill's cache: the
    /// sweep leaves non-directories alone (hand-placed links ride the same
    /// arm -- file_type() does not follow them).
    #[test]
    fn sweep_leaves_loose_files_under_the_reserved_subtree_alone() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir(root.path().join(".system")).expect("mkdir");
        let loose = root.path().join(".system/notes.txt");
        std::fs::write(&loose, b"notes").expect("write");
        let outcome = align(root.path(), &registry_with(vec![]));
        assert!(outcome.materialize_failures.is_empty());
        assert!(loose.exists(), "the sweep never touches a non-directory");
    }

    /// The skip rule is manifest membership, not anchored-ness: a skill
    /// that left the anchored set while staying in the manifest keeps its
    /// cache (materialized in an earlier window, dormant now) -- the sweep
    /// must not eat a dormant builtin's subtree.
    #[test]
    fn sweep_preserves_a_dormant_manifest_subtree() {
        let root = tempfile::tempdir().expect("root");
        let dormant = root.path().join(".system/pandoc");
        std::fs::create_dir_all(&dormant).expect("mkdir");
        std::fs::write(
            dormant.join("SKILL.md"),
            "---\nname: pandoc\ndescription: d\n---\nBody.\n",
        )
        .expect("write");
        let mut user = builtin_pandoc(true);
        user.source = CliToolSource::User;
        let outcome = align(root.path(), &registry_with(vec![user]));
        assert!(outcome.materialize_failures.is_empty());
        assert!(
            dormant.join("SKILL.md").exists(),
            "the dormant manifest cache survives"
        );
        // The knowledge-only skill still aligns alongside the skip.
        assert!(root.path().join(".system/vega-chart/SKILL.md").exists());
    }

    // --- auto-include -------------------------------------------------------

    #[test]
    fn auto_included_names_gates_on_source_enabled_and_presence() {
        let root = tempfile::tempdir().expect("root");
        // Nothing on disk: an enabled entry admits nothing.
        assert!(auto_included_names(&[builtin_pandoc(true)], root.path()).is_empty());
        std::fs::create_dir_all(root.path().join(".system/pandoc")).expect("mkdir");
        std::fs::write(
            root.path().join(".system/pandoc/SKILL.md"),
            "---\nname: pandoc\ndescription: d\n---\nBody.\n",
        )
        .expect("write");
        assert_eq!(
            auto_included_names(&[builtin_pandoc(true)], root.path()),
            vec!["pandoc".to_string()]
        );
        // Disabled drops out; a user-sourced entry of the same name is not
        // an auto-include anchor.
        assert!(auto_included_names(&[builtin_pandoc(false)], root.path()).is_empty());
        let mut user = builtin_pandoc(true);
        user.source = CliToolSource::User;
        assert!(auto_included_names(&[user], root.path()).is_empty());
    }

    /// The no-companion auto-include path: admission without any CLI entry
    /// (the dispatch's open arm), with presence still gating (the closed
    /// arm).
    #[test]
    fn auto_included_names_admits_a_no_companion_skill_without_a_cli_entry() {
        let root = tempfile::tempdir().expect("root");
        assert!(auto_included_names(&[], root.path()).is_empty());
        std::fs::create_dir_all(root.path().join(".system/vega-chart")).expect("mkdir");
        std::fs::write(
            root.path().join(".system/vega-chart/SKILL.md"),
            "---\nname: vega-chart\ndescription: d\n---\nBody.\n",
        )
        .expect("write");
        assert_eq!(
            auto_included_names(&[], root.path()),
            vec!["vega-chart".to_string()]
        );
    }

    /// The teaching skill's admission (issue #1032): `skill-creator` rides
    /// the same no-companion arm as `vega-chart` -- aligned by the app
    /// version with an empty CLI registry, then in the auto-include index
    /// of every fresh session. Sorted comparison: the manifest's iteration
    /// order is curation order, not the admission contract.
    #[test]
    fn auto_included_names_admits_skill_creator_once_aligned() {
        let root = tempfile::tempdir().expect("root");
        align(root.path(), &registry_with(vec![]));
        let mut admitted = auto_included_names(&[], root.path());
        admitted.sort();
        // Name-level first: the self-scaling set below cannot fail on this
        // skill's own absence, so the admission the AC names is pinned
        // directly.
        assert!(admitted.contains(&"skill-creator".to_string()));
        assert_eq!(
            admitted,
            knowledge_only_names_sorted()
                .into_iter()
                .map(String::from)
                .collect::<Vec<String>>()
        );
    }

    /// Under shadowing, presence resolves to the LOCAL copy (ADR-0121
    /// Decision 5: auto-include resolves to the local skill) -- a fork at
    /// the registry root satisfies presence with no reserved-subtree copy
    /// at all.
    #[test]
    fn auto_included_names_resolves_a_shadowing_local_copy() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir_all(root.path().join("vega-chart")).expect("fork dir");
        std::fs::write(
            root.path().join("vega-chart/SKILL.md"),
            "---\nname: vega-chart\ndescription: mine\n---\nBody.\n",
        )
        .expect("write");
        assert_eq!(
            auto_included_names(&[], root.path()),
            vec!["vega-chart".to_string()]
        );
    }

    // --- the shadowing resolver ----------------------------------------------

    #[test]
    fn resolve_skill_dir_prefers_local_and_falls_back_to_the_reserved_subtree() {
        let root = tempfile::tempdir().expect("root");
        // Neither: None.
        assert!(resolve_skill_dir(root.path(), "pandoc").is_none());
        // Reserved-subtree only: the subtree copy.
        std::fs::create_dir_all(root.path().join(".system/pandoc")).expect("mkdir");
        let resolved = resolve_skill_dir(root.path(), "pandoc").expect("resolved");
        assert!(resolved.starts_with(root.path().join(".system")));
        // A local copy shadows (the fork channel / mutation pin for the
        // shadowing family: flipping the resolution order serves the
        // builtin and the fork stops being what everything resolves to).
        std::fs::create_dir_all(root.path().join("pandoc")).expect("fork");
        assert_eq!(
            resolve_skill_dir(root.path(), "pandoc").expect("resolved"),
            root.path().join("pandoc")
        );
    }
}
