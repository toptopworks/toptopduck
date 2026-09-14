//! Builtin agent definitions + the materialization window (issue #932,
//! ADR-0117 Decision 3).
//!
//! The shipped set holds the zero-curation fallback `general-purpose`: a
//! builtin-sourced, skill-free, undeletable definition so the main turn
//! retains a delegation target with no custom entries. The startup window
//! materializes the shipped set into the registry (a real file per
//! definition) and records the materialization mark in app-config -- the
//! mark, not the static set, is the builtin-identity anchor, so a user's
//! pre-existing same-named file keeps its own source (the
//! `builtin_skill_baselines` posture of the skills loader). Unlike skills,
//! agent definitions carry no version-following in v1: a recorded builtin
//! stays builtin across edits, with no baseline hash and no upgrade pass
//! (the shipped prose is stable; a follow-up slice adds the axis if it
//! ever moves).

use std::collections::BTreeSet;
use std::path::Path;

use crate::app_config::AppConfig;

use super::frontmatter;

/// One shipped builtin definition. Monolingual English in v1 (the
/// description + preamble are MODEL-facing assets the built-in runtime
/// consumes, not UI copy -- the settings-page chrome wording lives in the
/// locale catalog).
pub(crate) struct BuiltinAgentDefinition {
    name: &'static str,
    description: &'static str,
    preamble: &'static str,
}

/// The v1 shipped set. Additive evolution mirrors the builtin skills: new
/// entries pass the same curation screen.
static BUILTIN_AGENT_DEFINITIONS: &[BuiltinAgentDefinition] = &[BuiltinAgentDefinition {
    name: "general-purpose",
    description: "General-purpose delegate: open-ended exploration, data \
                  wrangling, and multi-step analysis on the working set when \
                  no specialized definition fits.",
    // Skill-free by decision (ADR-0117 Decision 3): no backtick-wrapped
    // kebab-case words, so the preamble extracts zero skill marks.
    preamble: "You are a focused sub-agent delegated one specific task inside \
               a data-analysis session. Work the task end to end with the \
               tools available to you: explore the working set, run the \
               analysis, and materialize any result the main agent should \
               keep. Prefer decisive, verifiable steps over open-ended \
               deliberation. When you finish, report a concise summary: what \
               you did, what you found, and any result tables you promoted. \
               If you cannot complete the task, say so plainly with the \
               reason -- an honest failure the main agent can act on beats a \
               confident guess.\n",
}];

impl BuiltinAgentDefinition {
    /// The deterministic on-disk form: frontmatter `name` / `description` +
    /// the preamble body.
    fn render(&self) -> String {
        let mut fm = serde_yaml::Mapping::new();
        fm.insert(
            serde_yaml::Value::String("name".into()),
            serde_yaml::Value::String(self.name.into()),
        );
        fm.insert(
            serde_yaml::Value::String("description".into()),
            serde_yaml::Value::String(self.description.into()),
        );
        frontmatter::render_agent_md(&fm, self.preamble).expect("the shipped definition renders")
    }
}

/// Find the shipped definition a name belongs to. `None` = not in the
/// curated set.
pub(crate) fn find_definition(name: &str) -> Option<&'static BuiltinAgentDefinition> {
    BUILTIN_AGENT_DEFINITIONS.iter().find(|d| d.name == name)
}

/// The reserved-name check (the CLI-registration precedent, ADR-0117
/// Decision 1): a definition name is also the delegation TOOL name, so a
/// create / rename may take neither a shipped builtin definition's name nor
/// any reserved tool name (a built-in DuckDB tool, the `mcp__` prefix, a
/// meta-tool, a builtin CLI entry -- the live tables, so a future tool
/// extends the reservation for free). Static full-set membership,
/// independent of materialization.
pub(crate) fn is_reserved_agent_name(name: &str) -> bool {
    find_definition(name).is_some() || crate::cli_tools::config::is_reserved_name(name)
}

/// The runtime face of the app-config materialization mark: WHICH names are
/// materialized builtin definitions. Loader-side `AgentSource::Builtin`
/// marking keys on this, so a stale or hand-edited record outside the
/// shipped set must not promote a user definition to the builtin posture.
#[derive(Debug, Default)]
pub struct BuiltinAgentMark {
    names: BTreeSet<String>,
}

impl BuiltinAgentMark {
    /// A mark carrying exactly the given names (tests pin the materialized
    /// posture without an app-config fixture).
    #[cfg(test)]
    pub(crate) fn of(names: &[&str]) -> Self {
        Self {
            names: names.iter().map(|n| n.to_string()).collect(),
        }
    }

    /// Read the mark off the app-config set, keeping only shipped names (a
    /// record outside the static set must not promote a user definition).
    pub fn from_config(cfg: &AppConfig) -> Self {
        Self {
            names: cfg
                .materialized_builtin_agents
                .iter()
                .filter(|n| find_definition(n).is_some())
                .cloned()
                .collect(),
        }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.names.contains(name)
    }
}

/// Materialize / adopt / clean the builtin definitions against the registry,
/// mutating the mark set in place. Returns whether the set changed (the
/// caller folds that into its persist decision).
///
/// Per definition (the skills `reconcile` semantics, minus the baseline
/// hash): a missing file materializes + records; a recorded name keeps its
/// identity whatever the content (an edit is preserved, and a hand-deleted
/// file re-materializes); an unrecorded existing file is adopted only when
/// its content is the shipped render (the interrupted-persist self-heal),
/// otherwise the user owns the name (defer, warn). Records whose name left
/// the shipped set drop. Filesystem failures degrade per-definition with a
/// warn; the startup window must not fail the whole read-modify-write.
pub(crate) fn reconcile(root: &Path, materialized: &mut BTreeSet<String>) -> bool {
    // Mint the root first (the skills materializer posture): a fresh install
    // has no agents directory, and the temp-file write below fails NotFound
    // without it -- the startup retry could never succeed. A mint failure
    // degrades like every other window fault: warn, nothing recorded, the
    // next startup retries.
    if let Err(e) = std::fs::create_dir_all(root) {
        log::warn!(
            target: "agents",
            "failed to create the agents registry root `{}` (the next startup \
             retries): {e}",
            root.display()
        );
        return false;
    }
    let mut dirty = false;
    for def in BUILTIN_AGENT_DEFINITIONS {
        let path = root.join(format!("{}.md", def.name));
        if !path.exists() {
            match super::registry::write_agent_file(&path, &def.render()) {
                Ok(()) => {
                    materialized.insert(def.name.to_string());
                    dirty = true;
                    log::info!(
                        target: "agents",
                        "builtin agent definition `{}` materialized into the registry",
                        def.name
                    );
                }
                Err(e) => {
                    log::warn!(
                        target: "agents",
                        "builtin agent definition `{}` failed to materialize (the next \
                         startup retries): {e}",
                        def.name
                    );
                }
            }
            continue;
        }
        if materialized.contains(def.name) {
            continue; // Recorded identity stands (an edit is preserved).
        }
        // No record: shipped content adopts (the self-heal), anything else
        // is the user's file owning the name (defer).
        let adopted = fs_read_best_effort(&path).is_some_and(|current| current == def.render());
        if adopted {
            materialized.insert(def.name.to_string());
            dirty = true;
            log::info!(
                target: "agents",
                "builtin agent definition `{}` adopted a shipped-render file with no \
                 record (self-heal after an interrupted persist)",
                def.name
            );
        } else {
            log::warn!(
                target: "agents",
                "builtin agent definition `{}` deferred: a user file owns the name; it \
                 materializes once the user renames or removes it",
                def.name
            );
        }
    }
    // Mark cleanup: a record whose name left the shipped set is stale. No
    // file-anchor check is needed -- a recorded name with a missing file was
    // re-materialized in the loop above.
    let before = materialized.len();
    materialized.retain(|name| find_definition(name).is_some());
    dirty || materialized.len() != before
}

/// Read a file to a string, mapping any failure to None (the reconcile
/// adoption check degrades to "not ours" on a read fault).
fn fs_read_best_effort(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .map_err(|e| {
            log::warn!(
                target: "agents",
                "builtin agent definition read failed for `{}`: {e}",
                path.display()
            );
            e
        })
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `render` output parses back and carries no skill marks (Decision 3:
    /// the fallback binds no skills) and no dropped axes.
    #[test]
    fn shipped_definition_renders_clean() {
        for def in BUILTIN_AGENT_DEFINITIONS {
            let rendered = def.render();
            let parsed = frontmatter::parse_agent_md(&rendered)
                .unwrap_or_else(|e| panic!("{}: {e}", def.name));
            assert_eq!(
                crate::skills::frontmatter::get_string(&parsed.frontmatter, "name").as_deref(),
                Some(def.name)
            );
            assert!(parsed.dropped_axes.is_empty());
            assert!(
                super::super::model::extract_skill_marks(&parsed.preamble).is_empty(),
                "`{}` preamble must carry no skill marks",
                def.name
            );
        }
    }

    #[test]
    fn reserved_names_cover_the_shipped_set_and_tool_names() {
        assert!(is_reserved_agent_name("general-purpose"));
        // A built-in DuckDB tool name, a meta-tool name, the mcp__ prefix.
        assert!(is_reserved_agent_name("explore"));
        assert!(is_reserved_agent_name("mcp_list_servers"));
        assert!(is_reserved_agent_name("mcp__anything"));
        assert!(!is_reserved_agent_name("data-cleaner"));
    }

    #[test]
    fn reconcile_materializes_into_an_empty_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let mut mark = BTreeSet::new();
        assert!(reconcile(tmp.path(), &mut mark));
        assert!(mark.contains("general-purpose"));
        let content = std::fs::read_to_string(tmp.path().join("general-purpose.md")).unwrap();
        assert_eq!(
            content,
            find_definition("general-purpose").unwrap().render()
        );
    }

    #[test]
    fn reconcile_mints_a_missing_registry_root() {
        // The fresh-install shape: the agents root does not exist yet. Every
        // existing install upgrades into it too -- this directory is new.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("agents");
        let mut mark = BTreeSet::new();
        assert!(reconcile(&root, &mut mark));
        assert!(mark.contains("general-purpose"));
        assert!(root.join("general-purpose.md").exists());
    }

    #[test]
    fn reconcile_is_idempotent_once_materialized() {
        let tmp = tempfile::tempdir().unwrap();
        let mut mark = BTreeSet::new();
        reconcile(tmp.path(), &mut mark);
        // Second pass: file present + recorded -> nothing moves.
        assert!(!reconcile(tmp.path(), &mut mark));
    }

    #[test]
    fn reconcile_defers_to_a_user_file_owning_the_name() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path()).unwrap();
        std::fs::write(
            tmp.path().join("general-purpose.md"),
            "---\nname: general-purpose\ndescription: Mine.\n---\nMy own preamble.\n",
        )
        .unwrap();
        let mut mark = BTreeSet::new();
        assert!(!reconcile(tmp.path(), &mut mark));
        assert!(!mark.contains("general-purpose"));
        // The user's bytes stand.
        let content = std::fs::read_to_string(tmp.path().join("general-purpose.md")).unwrap();
        assert!(content.contains("My own preamble."));
    }

    #[test]
    fn reconcile_adopts_a_shipped_render_with_no_record() {
        let tmp = tempfile::tempdir().unwrap();
        let shipped = find_definition("general-purpose").unwrap().render();
        std::fs::write(tmp.path().join("general-purpose.md"), &shipped).unwrap();
        let mut mark = BTreeSet::new();
        assert!(reconcile(tmp.path(), &mut mark));
        assert!(mark.contains("general-purpose"));
    }

    #[test]
    fn reconcile_preserves_an_edited_recorded_builtin() {
        let tmp = tempfile::tempdir().unwrap();
        let mut mark = BTreeSet::new();
        reconcile(tmp.path(), &mut mark);
        // The user edits the preamble in-app (allowed: only the name locks).
        let path = tmp.path().join("general-purpose.md");
        let edited = "---\nname: general-purpose\ndescription: Edited.\n---\nEdited body.\n";
        std::fs::write(&path, edited).unwrap();
        assert!(!reconcile(tmp.path(), &mut mark));
        assert!(mark.contains("general-purpose"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), edited);
    }

    #[test]
    fn reconcile_rematerializes_a_hand_deleted_builtin() {
        let tmp = tempfile::tempdir().unwrap();
        let mut mark = BTreeSet::new();
        reconcile(tmp.path(), &mut mark);
        std::fs::remove_file(tmp.path().join("general-purpose.md")).unwrap();
        assert!(reconcile(tmp.path(), &mut mark));
        assert!(tmp.path().join("general-purpose.md").exists());
    }

    #[test]
    fn reconcile_drops_records_outside_the_shipped_set() {
        let tmp = tempfile::tempdir().unwrap();
        let mut mark = BTreeSet::from(["ghost".to_string()]);
        assert!(reconcile(tmp.path(), &mut mark));
        assert!(!mark.contains("ghost"));
    }
}
