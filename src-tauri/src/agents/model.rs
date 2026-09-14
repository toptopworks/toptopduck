//! Agent-definitions wire types + validation (issue #932, ADR-0117).
//!
//! An agent definition is the ASSEMBLY DESCRIPTION of a sub-agent: a single
//! community-format markdown file whose frontmatter carries `name` /
//! `description` and whose body is the preamble (the sub-agent's system
//! prompt). This module owns the IPC wire shape ([`AgentEntry`] /
//! [`AgentUpdate`] / [`AgentListing`]), the typed [`AgentError`] reject, the
//! name / description / preamble validation rules, and the backtick
//! skill-reference extraction (the skill-binding rule of ADR-0117 Decision 2:
//! a backtick-wrapped kebab-case word in the preamble is a skill-name mark;
//! assembly intersects the marks with the skills registry, a mark naming no
//! registered skill is a dangling reference surfaced as a warning).

use std::collections::BTreeSet;
use std::path::PathBuf;

/// The agent-definitions registry root (issue #932): `<app_data_dir>/agents`,
/// resolved once at setup and threaded to every agents command as Tauri
/// managed state (the `SkillsRoot` pattern). The directory is minted lazily
/// on first create -- a never-created registry lists empty.
pub struct AgentsRoot(pub PathBuf);

/// How an agent definition entered the registry (loader-derived from the
/// file's filesystem nature + the materialization mark, never frontmatter).
/// Drives the settings page's edit contract, mirroring the skills `Acquired`
/// triad: `user` is fully editable; `linked` is read-only; `builtin` keeps
/// its name locked and cannot be deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentSource {
    /// The definition file is a symlink to an external source. The app never
    /// writes through it; delete removes the LINK only, never the target.
    Linked,
    /// A real file -- authored in-app or placed by hand. Fully editable.
    User,
    /// A materialized builtin definition (ADR-0117 Decision 3): app-authored,
    /// written by the startup window, keyed on the app-config materialization
    /// mark. Undeletable; every field except `name` is editable.
    Builtin,
}

/// One registry agent definition as it crosses IPC (issue #932). The
/// declaration face: `name` + `description` (the delegation-routing handle
/// the main agent reads) + `preamble` (the sub-agent's system prompt), plus
/// the loader-derived posture and the two warning surfaces.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentEntry {
    /// The identity -- kebab-case, <= 64 chars, equals the file stem. It is
    /// also the delegation TOOL name in the turn assembly (#933).
    pub name: String,
    /// The routing description (required, <= 1024 chars) -- embedded in the
    /// delegation tool's description for the main agent.
    pub description: String,
    /// The Markdown body after the frontmatter -- the sub-agent's system
    /// prompt (preamble).
    pub preamble: String,
    /// Loader-derived source posture.
    pub source: AgentSource,
    /// The machine-level single axis (ADR-0117 Decision 2): enabled = listed
    /// into the built-in runtime's every-turn tool face; disabled = hidden.
    /// Lives in the app-config name set, not the entity.
    pub enabled: bool,
    /// The resolved link target for `linked` definitions (the "open source
    /// location" anchor); null otherwise.
    pub link_target: Option<String>,
    /// Backtick-marked skill names in the preamble that ARE registered (the
    /// assembly-time binding set -- intersection with the skills registry).
    pub skill_refs: Vec<String>,
    /// Backtick-marked kebab-case words naming NO registered skill: a
    /// warning row, not a save blocker (ADR-0117 Decision 2).
    pub dangling_skill_refs: Vec<String>,
    /// Community-format axes this app rejects and drops at parse time
    /// (`tools` / `model`, ADR-0117 Decision 2): parsed-then-discarded, never
    /// a hard refusal and never silent -- a warning row.
    pub dropped_axes: Vec<String>,
}

/// The rewrite payload for `update_agent`: the full declaration face. `name`
/// is the identity to write -- a different value renames the file.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentUpdate {
    pub name: String,
    pub description: String,
    pub preamble: String,
}

/// One non-spec definition file the registry scan skipped (the `SkillListing`
/// ignored-fold pattern): the file name + the English technical reason,
/// rendered verbatim by the settings page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SkippedAgent {
    /// The file name under the agents root (its file_name, not the full path).
    pub file: String,
    /// The English technical reason (the `AgentError` Display string).
    pub reason: String,
}

/// The `list_agents` return: the spec-valid definitions + the skipped files +
/// a root-level read error when the registry root itself could not be read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AgentListing {
    pub agents: Vec<AgentEntry>,
    pub ignored: Vec<SkippedAgent>,
    pub root_error: Option<String>,
}

/// The typed reject of the agents registry commands (the `SkillError`
/// pattern): adjacently tagged `{kind, data}` so the frontend narrows on
/// `kind` and renders through the shared `error.agent.*` catalog lane.
/// `data` is always a String -- the reason detail or the offending name.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum AgentError {
    /// The given name violates the name rule (kebab-case, <= 64 chars).
    /// Carries the reason detail.
    #[error("invalid agent name: {0}")]
    #[serde(rename = "InvalidAgentName")]
    InvalidName(String),
    /// A definition file failed validation (missing/blank name or
    /// description, blank preamble, malformed frontmatter, file-name
    /// mismatch) or the target is not a definition file. Carries the reason.
    #[error("invalid agent definition: {0}")]
    InvalidAgent(String),
    /// No registry definition exists under the given name. Carries the name.
    #[error("no such agent definition: {0}")]
    NoSuchAgent(String),
    /// A create / rename targeted a name an existing file already occupies.
    /// Carries the name.
    #[error("agent definition name already taken: {0}")]
    #[serde(rename = "AgentNameTaken")]
    NameTaken(String),
    /// A create / rename targeted a name in the reserved set (a builtin
    /// definition name, or a reserved TOOL name the delegation tool would
    /// collide with -- the CLI-registration precedent, ADR-0117 Decision 1).
    /// Carries the name.
    #[error("agent definition name is reserved: {0}")]
    ReservedAgentName(String),
    /// A rename targeted a materialized builtin definition: the name is the
    /// locked identity. Carries the name.
    #[error("built-in agent definition name is locked: {0}")]
    BuiltinNameLocked(String),
    /// A delete targeted a materialized builtin definition: builtin
    /// definitions are undeletable (they re-materialize on the next startup
    /// anyway); disabling is the single shutdown axis. Carries the name.
    #[error("built-in agent definition cannot be deleted: {0}")]
    BuiltinUndeletable(String),
    /// A mutating call targeted a `linked` definition (the app never writes
    /// through an external link). Carries the name.
    #[error("agent definition is linked (read-only): {0}")]
    #[serde(rename = "AgentReadOnly")]
    ReadOnly(String),
    /// An underlying filesystem failure (create / read / write / rename /
    /// remove). Carries the English technical detail for the fold.
    #[error("{0}")]
    #[serde(rename = "AgentFsFailure")]
    FsFailure(String),
}

/// Name ceiling for an agent definition (mirrors the Agent Skills `name`
/// rule the CLI registrations share).
pub const AGENT_NAME_MAX: usize = 64;
/// Description ceiling (mirrors the Agent Skills `description` rule).
pub const AGENT_DESCRIPTION_MAX: usize = 1024;

/// The name rule: non-empty, kebab-case (lowercase ASCII alphanumerics
/// separated by single hyphens -- no leading / trailing / double hyphen), at
/// most [`AGENT_NAME_MAX`] chars. Identity equals the file stem, so this
/// doubles as the file-name rule.
pub fn is_valid_agent_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= AGENT_NAME_MAX
        && name.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// Validate an agent-definition name, refusing with the reason detail.
pub fn validate_agent_name(name: &str) -> Result<(), AgentError> {
    if is_valid_agent_name(name) {
        return Ok(());
    }
    Err(AgentError::InvalidName(format!(
        "`{name}` must be kebab-case (lowercase a-z / 0-9 separated by single \
         hyphens) and at most {AGENT_NAME_MAX} chars"
    )))
}

/// Validate a description: required, non-blank, at most
/// [`AGENT_DESCRIPTION_MAX`] chars.
pub fn validate_description(description: &str) -> Result<(), AgentError> {
    if description.trim().is_empty() {
        return Err(AgentError::InvalidAgent(
            "description is required and must not be blank".into(),
        ));
    }
    if description.chars().count() > AGENT_DESCRIPTION_MAX {
        return Err(AgentError::InvalidAgent(format!(
            "description exceeds the ceiling of {AGENT_DESCRIPTION_MAX} chars"
        )));
    }
    Ok(())
}

/// Validate a preamble: required non-blank (a definition without a system
/// prompt has nothing to assemble).
pub fn validate_preamble(preamble: &str) -> Result<(), AgentError> {
    if preamble.trim().is_empty() {
        return Err(AgentError::InvalidAgent(
            "the preamble (Markdown body) must not be blank".into(),
        ));
    }
    Ok(())
}

/// Extract the backtick skill-name marks from a preamble (ADR-0117 Decision
/// 2): every backtick-wrapped word that is SHAPED like a name (kebab-case,
/// <= 64 chars) is a candidate mark; anything else inside backticks (paths,
/// code snippets with spaces or underscores, uppercase words) is ordinary
/// prose and never warns. Deduplicated, first-occurrence order.
pub fn extract_skill_marks(preamble: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut marks = Vec::new();
    let mut rest = preamble;
    while let Some(open) = rest.find('`') {
        let after_open = &rest[open + 1..];
        match after_open.find('`') {
            Some(close) => {
                let word = &after_open[..close];
                // The mark shape is the SKILL-name rule (the marks name
                // skills), not the agent-name rule -- the two rules agree
                // today, but naming the right one keeps them from drifting
                // apart silently.
                if crate::skills::model::is_valid_skill_name(word) && seen.insert(word.to_string())
                {
                    marks.push(word.to_string());
                }
                rest = &after_open[close + 1..];
            }
            // An unmatched backtick is prose, not a mark -- stop scanning.
            None => break,
        }
    }
    marks
}

/// Split the extracted marks against the skills-registry name set: the hits
/// (the assembly-time binding set) and the dangles (a warning row, never a
/// blocker). Both keep the extraction order.
pub fn partition_skill_marks(
    marks: Vec<String>,
    registered: &BTreeSet<String>,
) -> (Vec<String>, Vec<String>) {
    let mut refs = Vec::new();
    let mut dangling = Vec::new();
    for mark in marks {
        if registered.contains(&mark) {
            refs.push(mark);
        } else {
            dangling.push(mark);
        }
    }
    (refs, dangling)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- name rule -----------------------------------------------------------

    #[test]
    fn name_rule_accepts_kebab_case_and_refuses_other_shapes() {
        assert!(is_valid_agent_name("general-purpose"));
        assert!(is_valid_agent_name("data-cleaner"));
        assert!(is_valid_agent_name("sql")); // single segment is legal
        assert!(!is_valid_agent_name(""));
        assert!(!is_valid_agent_name("Data-Cleaner")); // uppercase
        assert!(!is_valid_agent_name("data_cleaner")); // underscore
        assert!(!is_valid_agent_name("-leading"));
        assert!(!is_valid_agent_name("trailing-"));
        assert!(!is_valid_agent_name("double--hyphen"));
        assert!(!is_valid_agent_name(&"a".repeat(65)));
    }

    #[test]
    fn validate_description_refuses_blank_and_overlong() {
        assert!(validate_description("Delegates open-ended exploration.").is_ok());
        assert!(validate_description("   ").is_err());
        assert!(validate_description(&"x".repeat(AGENT_DESCRIPTION_MAX + 1)).is_err());
    }

    #[test]
    fn validate_preamble_refuses_blank() {
        assert!(validate_preamble("You are a focused analyst.\n").is_ok());
        assert!(validate_preamble("\n \t").is_err());
    }

    // --- backtick marks ------------------------------------------------------

    #[test]
    fn extract_keeps_only_name_shaped_backtick_words() {
        let preamble = "Use `pdf-tools` and `sql` when helpful. See `/etc/hosts` \
                        and `snake_case_word`; `UPPER` is prose too. Reuse of \
                        `pdf-tools` counts once.";
        assert_eq!(
            extract_skill_marks(preamble),
            vec!["pdf-tools".to_string(), "sql".to_string()]
        );
    }

    #[test]
    fn extract_stops_at_an_unmatched_backtick() {
        // No second backtick after the last one -- the remainder is prose.
        assert_eq!(
            extract_skill_marks("bind `sql` and then `dangling"),
            vec!["sql"]
        );
    }

    #[test]
    fn partition_splits_marks_against_the_registry() {
        let registered: BTreeSet<String> = ["pdf-tools".to_string(), "sql".to_string()]
            .into_iter()
            .collect();
        let (refs, dangling) = partition_skill_marks(
            vec![
                "pdf-tools".to_string(),
                "ghost-skill".to_string(),
                "sql".to_string(),
            ],
            &registered,
        );
        assert_eq!(refs, vec!["pdf-tools".to_string(), "sql".to_string()]);
        assert_eq!(dangling, vec!["ghost-skill".to_string()]);
    }

    // --- error wire ----------------------------------------------------------

    #[test]
    fn error_serializes_adjacently_tagged() {
        let json = serde_json::to_value(AgentError::ReservedAgentName("explore".into())).unwrap();
        assert_eq!(json["kind"], "ReservedAgentName");
        assert_eq!(json["data"], "explore");
    }
}
