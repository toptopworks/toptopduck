//! Skills registry (issue #362, ADR-0086): the Agent Skills spec library.
//!
//! A skill is an [Agent Skills](https://agentskills.io/specification)
//! directory -- `<root>/<name>/SKILL.md` (YAML frontmatter + Markdown body) --
//! under the single registry root `<app_data_dir>/skills`. The DIRECTORY SCAN
//! is the registry (no sidecar, no app-config entry): whatever spec-valid
//! directory lives there shows up in `list_skills`, plus the reserved
//! `.system/` subtree's children (the builtin rows; ADR-0121). Identity is
//! the spec `name` (kebab-case, <= 64 chars, equal to the directory name --
//! ADR-0086 Decision 2); the loader derives `acquired` from location and the
//! directory's filesystem nature (`linked` = symlink / junction onto an
//! external source, `local` = real directory, `builtin` = under the reserved
//! subtree). v1 declares one thing per skill: the prompt fragment (the
//! SKILL.md body); attachment files across the whole tree (no privileged
//! subdirectory) read through the `read_skill_file` restricted surface, and
//! script execution rides registered CLI tools as text relay (ADR-0086
//! Decision 1, calibrated by ADR-0111).
//!
//! Submodules:
//! - [`model`]: the wire types (`SkillEntry` / `SkillUpdate` / `Acquired`),
//!   the typed `SkillError` reject, and the spec validation rules.
//! - [`frontmatter`]: `SKILL.md` frontmatter split / parse / render -- unknown
//!   spec fields survive an edit verbatim.
//! - [`registry`]: the root-parameterized scan + create / update / delete
//!   (Tauri-state-free, so the whole surface tests against a tempdir).
//! - [`import`]: external-agent-library discovery + link / copy import
//!   (issue #367) -- projects candidate source dirs onto importable skill
//!   lists + commits each selected skill as `linked` (symlink / junction) or
//!   `local` (recursive copy).
//! - [`builtin`]: the builtin skills (ADR-0121) -- the embedded asset tree,
//!   the manifest, the reserved-subtree alignment window, and the shadowing
//!   resolver: a CLI companion rides its companion CLI registration, a
//!   knowledge-only skill rides the app version (ADR-0120 Decision 7).
//! - [`invocation`]: the `invoke_skill` gateway meta-tool (ADR-0119
//!   Decision 4) -- the mid-turn agent invocation channel + the turn's
//!   accumulating invocation records.
//! - [`prompt`]: per-turn skill resolution for prompt injection + provenance
//!   (issue #364) -- resolves each discovery-snapshot / invoked name into
//!   its verbatim body + the SHA-256 of the whole `SKILL.md`.
//! - [`read`]: the `read_skill_file` restricted attachment-read surface
//!   (issue #714, ADR-0111) -- the gate trilogy + the gateway meta-tool
//!   resolver over an INVOKED skill's tree.

pub mod builtin;
pub mod frontmatter;
pub mod import;
pub mod invocation;
pub mod model;
pub mod prompt;
pub mod read;
pub mod registry;

pub use import::{discover_skill_sources, import_skill, import_skills};
pub use model::{
    Acquired, DiscoveredSkill, DiscoveredSkillStatus, ImportItem, ImportMode, ImportOutcome,
    SkillEntry, SkillError, SkillListing, SkillSource, SkillSourceCandidate, SkillUpdate,
    SkillsRoot, SkippedSkill,
};
pub use prompt::{resolve_prompt_fragments, SkillPromptFragment};

/// Decode SKILL.md bytes lossy with the shared non-UTF-8 observability
/// warn (issue #1025): a corrupt file stays loadable (U+FFFD stand-ins
/// keep it prompt-usable), but the replacement is silent by default while
/// the caller's `content_hash` still anchors the ORIGINAL bytes -- an
/// invisible divergence between what rides the prompts and the drift
/// anchor. One ladder-shaped warn makes the divergence observable; shared
/// by the resolve face (`prompt::resolve_one`) and the assemble face
/// (`registry::assemble_skill_parts`) so the signal cannot drift between
/// channels -- while the serve face (`read::serve_file`) deliberately
/// keeps its own unshared warn, matching its anchor-less payloads.
fn decode_skill_md_lossy(bytes: &[u8], name: &str) -> String {
    if std::str::from_utf8(bytes).is_err() {
        log::warn!(
            target: "skills",
            "skill `{name}` SKILL.md holds non-UTF-8 bytes -- the body rides \
             lossy U+FFFD replacements while the content hash anchors the \
             original bytes; re-save the file as UTF-8 in an external \
             editor to reconcile them",
        );
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// The new-session discovery-snapshot seed (issue #961, ADR-0118 Decision
/// 1; carried as the discovery snapshot by ADR-0119 Decision 3): the
/// registry scan intersected with the enablement axis -- every spec-valid
/// skill except the disabled names, with a BUILTIN row additionally gated by
/// the companion axis (ADR-0120 Decision 7: a CLI companion needs its
/// companion CLI entry detected + enabled -- the #677 two-axis conjunction,
/// an undetected CLI registration keeps its skill out of the seed; a
/// knowledge-only skill rides the app version and takes no CLI conjunct).
/// Under shadowing (ADR-0121 Decision 5) the row resolves to the local
/// fork, which seeds through the user arm like any local skill. The seed is
/// computed at session creation and MATERIALIZES as the session's discovery
/// snapshot -- persisted explicitly in the recipe header, immutable for the
/// session's life; resume adopts it from the header, no re-seed. A registry
/// root that fails to read seeds an EMPTY set: the listing degrades with
/// `root_error` (surfaced by the settings pane's root banner), and the
/// session is created silently skill-less rather than refused -- the
/// degradation is visible in settings, not in the session.
pub fn seed_skill_names(
    cli: &[crate::cli_tools::config::CliToolConfig],
    disabled: &std::collections::BTreeSet<String>,
    skills_root: &std::path::Path,
) -> Vec<String> {
    // The builtin's companion-axis gate (issue #677, ADR-0120 Decision 7):
    // the builtins whose companion CLI entries are detected + enabled, plus
    // the knowledge-only ones (a Vec: the shipped builtin set is a handful
    // of members, a set adds ceremony).
    let auto_builtin = builtin::auto_included_names(cli, skills_root);
    registry::list_skills(skills_root)
        .skills
        .into_iter()
        .filter(|s| !disabled.contains(&s.name))
        .filter(|s| s.acquired != Acquired::Builtin || auto_builtin.contains(&s.name))
        .map(|s| s.name)
        .collect()
}

/// Overlay the enablement axis onto a listing (issue #961): each row's
/// `enabled` = NOT in the disabled-name set. The registry scan itself is
/// config-blind (a pure directory read), so the axis lands here at the
/// command boundary -- the one place the two sources meet.
pub fn apply_enablement(
    mut listing: SkillListing,
    disabled: &std::collections::BTreeSet<String>,
) -> SkillListing {
    for skill in &mut listing.skills {
        skill.enabled = !disabled.contains(&skill.name);
    }
    listing
}

/// Config-bound seed assembly (issue #961): the enablement axis reads off
/// ONE config snapshot, so a torn read cannot mix two eras and the
/// command's glue is a single argument -- testable end to end.
pub fn seed_from_config(
    cfg: &crate::app_config::AppConfig,
    cli: &[crate::cli_tools::config::CliToolConfig],
    skills_root: &std::path::Path,
) -> Vec<String> {
    seed_skill_names(cli, &cfg.disabled_skills, skills_root)
}

/// Config-bound listing assembly (issue #961): the enablement overlay reads
/// off ONE config snapshot -- the command-boundary form of the registry
/// scan + overlay, testable end to end. The builtin posture needs no config
/// input since ADR-0121 (it is location-derived in the scan itself).
pub fn list_with_enablement(
    cfg: &crate::app_config::AppConfig,
    skills_root: &std::path::Path,
) -> SkillListing {
    apply_enablement(registry::list_skills(skills_root), &cfg.disabled_skills)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_skill(root: &std::path::Path, name: &str) {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Does things.\n---\nBody.\n"),
        )
        .expect("SKILL.md");
    }

    /// A skill directory in the reserved subtree (the builtin posture by
    /// location, ADR-0121).
    fn put_system_skill(root: &std::path::Path, name: &str) {
        let dir = root.join(".system").join(name);
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: Shipped.\n---\nShipped.\n"),
        )
        .expect("SKILL.md");
    }

    fn disabled(names: &[&str]) -> std::collections::BTreeSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// A builtin-sourced companion CLI entry (the #677 pair shape); only the
    /// name / source / enabled triple is load-bearing for the seed.
    fn builtin_cli(name: &str, enabled: bool) -> crate::cli_tools::config::CliToolConfig {
        crate::cli_tools::config::CliToolConfig {
            name: name.to_string(),
            description: "convert documents".to_string(),
            executable: name.to_string(),
            argv_template: vec![],
            params: vec![],
            env: Default::default(),
            enabled,
            source: crate::cli_tools::config::CliToolSource::Builtin,
            baseline: None,
        }
    }

    #[test]
    fn seed_seeds_the_enabled_registry_minus_disabled_names() {
        // ADR-0118 Decision 1: the seed is the registry INTERSECT the
        // enablement axis -- user skills join with zero bookkeeping, a
        // disabled name stays out (dormant, directory kept).
        let root = tempfile::tempdir().expect("root");
        put_skill(root.path(), "pdf-tools");
        put_skill(root.path(), "sql-coach");
        let cli = vec![builtin_cli("pandoc", true)];
        put_system_skill(root.path(), "pandoc");
        let names = seed_skill_names(&cli, &disabled(&["sql-coach"]), root.path());
        assert_eq!(names, vec!["pandoc".to_string(), "pdf-tools".to_string()]);
    }

    #[test]
    fn seed_drops_a_builtin_when_either_axis_is_off() {
        // The two-axis conjunction (AC): a disabled skill axis keeps the
        // builtin out even with its CLI entry enabled, and a disabled /
        // missing companion CLI entry keeps it out even with the skill axis
        // on -- the #677 semantics, now the builtin half of the general rule.
        let root = tempfile::tempdir().expect("root");
        put_system_skill(root.path(), "pandoc");
        // Skill axis off.
        let cli = vec![builtin_cli("pandoc", true)];
        assert!(seed_skill_names(&cli, &disabled(&["pandoc"]), root.path()).is_empty());
        // CLI axis off.
        let cli = vec![builtin_cli("pandoc", false)];
        assert!(seed_skill_names(&cli, &disabled(&[]), root.path()).is_empty());
        // CLI entry absent entirely (undetected).
        assert!(seed_skill_names(&[], &disabled(&[]), root.path()).is_empty());
        // Both axes on: in.
        let cli = vec![builtin_cli("pandoc", true)];
        assert_eq!(
            seed_skill_names(&cli, &disabled(&[]), root.path()),
            vec!["pandoc".to_string()]
        );
    }

    #[test]
    fn seed_admits_a_knowledge_only_builtin_with_no_cli_entry() {
        // ADR-0120 Decision 7: a knowledge-only skill takes no CLI conjunct
        // -- an EMPTY CLI registry still seeds it -- while the enablement
        // axis stays its shutdown axis (a disabled knowledge-only name
        // drops like any other; it has no CLI entry to disable).
        let root = tempfile::tempdir().expect("root");
        put_system_skill(root.path(), "vega-chart");
        assert_eq!(
            seed_skill_names(&[], &disabled(&[]), root.path()),
            vec!["vega-chart".to_string()]
        );
        assert!(
            seed_skill_names(&[], &disabled(&["vega-chart"]), root.path()).is_empty(),
            "the enablement axis drops the knowledge-only skill"
        );
    }

    #[test]
    fn seed_on_an_empty_registry_is_empty() {
        let root = tempfile::tempdir().expect("root");
        assert!(seed_skill_names(&[], &disabled(&[]), root.path()).is_empty());
    }

    #[test]
    fn apply_enablement_overlays_the_disabled_axis_on_the_listing() {
        // The listing-side half of the axis (issue #961): the registry scan
        // is config-blind, so the disabled-name set overlays onto each row
        // at the command boundary -- absent names read enabled (the
        // default-on polarity), a disabled name reads grayed-out material.
        let entry = |name: &str| SkillEntry {
            name: name.to_string(),
            description: "Does things.".to_string(),
            acquired: Acquired::Local,
            license: None,
            compatibility: None,
            body: "Body.\n".to_string(),
            link_target: None,
            content_hash: "h".to_string(),
            enabled: true,
            covers_builtin: false,
        };
        let listing = SkillListing {
            skills: vec![entry("pdf-tools"), entry("sql-coach")],
            ignored: vec![],
            root_error: None,
        };
        let overlaid = apply_enablement(listing, &disabled(&["sql-coach"]));
        assert!(overlaid.skills[0].enabled, "absent name: enabled");
        assert!(!overlaid.skills[1].enabled, "disabled name: dormant");
    }

    /// Shadowing (ADR-0121 Decision 5) at the seed level: a local fork
    /// owning a builtin's name seeds through the USER arm (ADR-0118
    /// Decision 1: user skills join with zero bookkeeping) even with the
    /// companion CLI gate closed -- the row is local, the builtin gate
    /// excludes only builtin rows.
    #[test]
    fn seed_rides_the_user_arm_for_a_shadowing_fork() {
        let root = tempfile::tempdir().expect("root");
        put_skill(root.path(), "pandoc");
        let cli = vec![builtin_cli("pandoc", false)];
        let names = seed_skill_names(&cli, &disabled(&[]), root.path());
        assert_eq!(names, vec!["pandoc".to_string()]);
    }

    #[test]
    fn seed_from_config_reads_the_axis_off_one_snapshot() {
        // The config-bound wiring pin (issue #961): the disabled-name axis
        // reads off the ONE config -- a dropped-axis revert at the command
        // boundary dies here.
        let root = tempfile::tempdir().expect("root");
        put_system_skill(root.path(), "pandoc");
        put_skill(root.path(), "pdf-tools");
        put_skill(root.path(), "sql-coach");
        let mut cfg = crate::app_config::AppConfig::defaults();
        cfg.disabled_skills.insert("sql-coach".to_string());
        let cli = vec![builtin_cli("pandoc", true)];
        let names = seed_from_config(&cfg, &cli, root.path());
        assert_eq!(names, vec!["pandoc".to_string(), "pdf-tools".to_string()]);
    }

    #[test]
    fn list_with_enablement_overlays_the_axis_at_the_boundary() {
        // The config-bound listing pin (issue #961): the disabled-name axis
        // reaches the wire rows through the single-snapshot assembly -- a
        // dropped overlay at the command boundary dies here.
        let root = tempfile::tempdir().expect("root");
        put_skill(root.path(), "pdf-tools");
        put_skill(root.path(), "sql-coach");
        let mut cfg = crate::app_config::AppConfig::defaults();
        cfg.disabled_skills.insert("sql-coach".to_string());
        let listing = list_with_enablement(&cfg, root.path());
        let by_name = |n: &str| {
            listing
                .skills
                .iter()
                .find(|s| s.name == n)
                .unwrap_or_else(|| panic!("missing {n}"))
        };
        assert!(by_name("pdf-tools").enabled);
        assert!(!by_name("sql-coach").enabled);
    }
}
