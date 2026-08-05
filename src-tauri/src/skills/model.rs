//! The skill wire model + Agent Skills spec validation (issue #362, ADR-0086).
//!
//! A skill is an [Agent Skills](https://agentskills.io/specification) directory:
//! `<root>/<name>/SKILL.md` (YAML frontmatter + Markdown body). Identity IS the
//! spec `name` -- kebab-case, at most 64 chars, equal to the directory name
//! (ADR-0086 Decision 2); the app never mints a separate id. `acquired` is
//! DERIVED by the loader from the directory's filesystem nature (symlink /
//! junction -> `linked`, real directory -> `local`); it is never stored in
//! frontmatter.

use std::path::PathBuf;

/// The skills registry root, managed as Tauri state (issue #362). Resolved once
/// at setup to `<app_data_dir>/skills` (with the same temp-dir fallback the
/// app-config path uses, ADR-0038 style); every skills command addresses the
/// registry through it. The directory is minted lazily on first create -- a
/// never-created registry lists empty.
pub struct SkillsRoot(pub PathBuf);

/// How a skill entered the registry (loader-derived, never frontmatter -- issue
/// #303 spec). Drives the settings page's edit contract: `local` is fully
/// editable; `linked` is read-only + "open source location".
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Acquired {
    /// The skill directory is a symlink / junction to an external source. The
    /// app never writes through it (that would mutate the external library);
    /// delete removes the LINK only, never the target.
    Linked,
    /// A real directory -- authored in-app (`create_skill`) or copied in by a
    /// future import slice. Fully editable.
    Local,
}

/// One registry skill as it crosses IPC (issue #362). The full declaration face
/// (ADR-0086 Decision 1): the prompt fragment (`body`) + the optional MCP
/// server references (`mcp_servers`, from the frontmatter extension key
/// `metadata.toptopduck_mcp_servers`). `link_target` is the resolved symlink /
/// junction target for `linked` skills (the "open source location" anchor);
/// `null` for `local`. Option fields mirror the Rust `Option<String>` + bare
/// serde convention (None serializes as JSON null, same shape as
/// `AppConfig.last_dir`), so they are `| null` on the wire, not optional.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SkillEntry {
    /// The spec `name` -- identity, kebab-case, equal to the directory name.
    pub name: String,
    /// The spec `description` (required by the spec, <= 1024 chars).
    pub description: String,
    /// Loader-derived link/real-directory posture.
    pub acquired: Acquired,
    /// The spec `license` field, when present.
    pub license: Option<String>,
    /// The spec `compatibility` field, when present.
    pub compatibility: Option<String>,
    /// The ids under the `metadata.toptopduck_mcp_servers` extension key (comma-
    /// separated in frontmatter, a list on the wire). Empty when absent.
    pub mcp_servers: Vec<String>,
    /// The Markdown body after the frontmatter -- the prompt fragment injected
    /// on mount (a later #303 slice; carried here so the settings drawer edits
    /// it verbatim).
    pub body: String,
    /// The resolved link target for `linked` skills; `null` for `local`.
    pub link_target: Option<String>,
}

/// The editable payload of `update_skill` (issue #362). Addressed by the command's
/// separate `name` parameter (the CURRENT directory name); `name` here is the
/// identity to WRITE -- equal to the current one for a plain edit, different for
/// a rename (the backend renames the directory + rewrites the frontmatter).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SkillUpdate {
    /// The identity to write (kebab-case, <= 64, becomes the directory name).
    pub name: String,
    /// The spec `description` (required, <= 1024 chars).
    pub description: String,
    /// The spec `license` field; blank / null removes the key from frontmatter.
    pub license: Option<String>,
    /// The spec `compatibility` field; blank / null removes the key.
    pub compatibility: Option<String>,
    /// The MCP server ids to store under `metadata.toptopduck_mcp_servers`
    /// (empty removes the extension key).
    pub mcp_servers: Vec<String>,
    /// The Markdown body (required non-blank -- a skill without a prompt
    /// fragment has nothing to inject).
    pub body: String,
}

/// Typed reject for the skills commands (issue #362). Adjacently tagged
/// (`#[serde(tag = "kind", content = "data")]`) like every other typed IPC
/// error; the kind set is DISJOINT from SessionError / SaveError /
/// StoreCommandError so the frontend's fmtError dispatch stays unambiguous
/// (ADR-0069 invariant). The data strings carry the English technical detail
/// for the fold; user-facing wording lives in the locale catalog (ADR-0052).
/// `Display` is Rust-log-only -- NOT the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum SkillError {
    /// The given name violates the Agent Skills name rule (kebab-case, <= 64
    /// chars). Carries the reason detail.
    #[error("invalid skill name: {0}")]
    InvalidName(String),
    /// A SKILL.md failed spec validation (missing/blank description, blank
    /// body, malformed frontmatter) or the target is not a skill directory.
    /// Carries the reason detail.
    #[error("invalid skill: {0}")]
    InvalidSkill(String),
    /// No registry skill exists under the given name. Carries the name.
    #[error("no such skill: {0}")]
    NoSuchSkill(String),
    /// A create / rename targeted a name an existing directory already occupies.
    /// Carries the name.
    #[error("skill name already taken: {0}")]
    NameTaken(String),
    /// A mutating call targeted a `linked` skill (the app never writes through
    /// an external link). Carries the name.
    #[error("skill is linked (read-only): {0}")]
    ReadOnly(String),
    /// An underlying filesystem failure (create / read / write / rename /
    /// remove). Carries the English technical detail for the fold.
    #[error("{0}")]
    FsFailure(String),
}

/// Agent Skills spec ceiling for `name` (<= 64 chars).
pub const SKILL_NAME_MAX: usize = 64;
/// Agent Skills spec ceiling for `description` (<= 1024 chars).
pub const SKILL_DESCRIPTION_MAX: usize = 1024;

/// The Agent Skills name rule: non-empty, kebab-case (lowercase ASCII
/// alphanumerics separated by single hyphens -- no leading / trailing / double
/// hyphen), at most [`SKILL_NAME_MAX`] chars. Identity equals directory name
/// (ADR-0086 Decision 2), so this doubles as the directory-name rule.
pub fn is_valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= SKILL_NAME_MAX
        && name.split('-').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
}

/// Validate a skill name, refusing with the reason detail on failure.
pub fn validate_skill_name(name: &str) -> Result<(), SkillError> {
    if is_valid_skill_name(name) {
        return Ok(());
    }
    Err(SkillError::InvalidName(format!(
        "`{name}` must be kebab-case (lowercase a-z / 0-9 separated by single \
         hyphens) and at most {SKILL_NAME_MAX} chars"
    )))
}

/// Validate a description: required, non-blank, at most
/// [`SKILL_DESCRIPTION_MAX`] chars (Agent Skills spec).
pub fn validate_description(description: &str) -> Result<(), SkillError> {
    if description.trim().is_empty() {
        return Err(SkillError::InvalidSkill(
            "description is required and must not be blank".into(),
        ));
    }
    if description.chars().count() > SKILL_DESCRIPTION_MAX {
        return Err(SkillError::InvalidSkill(format!(
            "description exceeds the spec ceiling of {SKILL_DESCRIPTION_MAX} chars"
        )));
    }
    Ok(())
}

/// Validate a Markdown body: required non-blank (a skill without a prompt
/// fragment has nothing to inject on mount).
pub fn validate_body(body: &str) -> Result<(), SkillError> {
    if body.trim().is_empty() {
        return Err(SkillError::InvalidSkill(
            "the Markdown body must not be blank".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_rule_accepts_spec_shapes() {
        assert!(is_valid_skill_name("a"));
        assert!(is_valid_skill_name("pdf-tools"));
        assert!(is_valid_skill_name("data-analysis-2"));
        assert!(is_valid_skill_name("0num-first"));
        // Exactly at the 64-char ceiling.
        let max = "a".repeat(SKILL_NAME_MAX);
        assert!(is_valid_skill_name(&max));
    }

    #[test]
    fn name_rule_rejects_non_kebab_or_oversized() {
        for bad in [
            "",           // empty
            " ",          // blank
            "PDF",        // uppercase
            "pdf_tools",  // underscore
            "pdf tools",  // space
            "-pdf",       // leading hyphen
            "pdf-",       // trailing hyphen
            "pdf--tools", // double hyphen
            "pdf.tools",  // dot
            "技能",       // non-ASCII
        ] {
            assert!(!is_valid_skill_name(bad), "`{bad}` should be rejected");
        }
        let too_long = "a".repeat(SKILL_NAME_MAX + 1);
        assert!(!is_valid_skill_name(&too_long));
    }

    #[test]
    fn validate_skill_names_the_reason() {
        let err = validate_skill_name("Bad Name").unwrap_err();
        assert_eq!(
            err,
            SkillError::InvalidName(
                "`Bad Name` must be kebab-case (lowercase a-z / 0-9 separated \
                 by single hyphens) and at most 64 chars"
                    .into()
            )
        );
        assert!(validate_skill_name("good-name").is_ok());
    }

    #[test]
    fn description_validation_enforces_spec() {
        assert!(matches!(
            validate_description("   "),
            Err(SkillError::InvalidSkill(_))
        ));
        let too_long = "d".repeat(SKILL_DESCRIPTION_MAX + 1);
        assert!(matches!(
            validate_description(&too_long),
            Err(SkillError::InvalidSkill(_))
        ));
        assert!(validate_description("Analyzes PDF files.").is_ok());
    }

    #[test]
    fn body_validation_rejects_blank() {
        assert!(matches!(
            validate_body("  \n\t "),
            Err(SkillError::InvalidSkill(_))
        ));
        assert!(validate_body("Use this skill when …").is_ok());
    }

    #[test]
    fn error_kinds_serialize_adjacently_tagged() {
        // The IPC shape the frontend guards on: { kind, data } -- the same
        // adjacent tagging as every other typed error.
        let json = serde_json::to_value(SkillError::NoSuchSkill("pdf-tools".into())).unwrap();
        assert_eq!(json["kind"], "NoSuchSkill");
        assert_eq!(json["data"], "pdf-tools");
    }

    #[test]
    fn entry_wire_shape_round_trips() {
        let entry = SkillEntry {
            name: "pdf-tools".into(),
            description: "Work with PDF files.".into(),
            acquired: Acquired::Linked,
            license: Some("MIT".into()),
            compatibility: None,
            mcp_servers: vec!["github-mcp".into()],
            body: "Body text.\n".into(),
            link_target: Some("/home/u/.claude/skills/pdf-tools".into()),
        };
        let json = serde_json::to_string(&entry).unwrap();
        let back: SkillEntry = serde_json::from_str(&json).unwrap();
        assert_eq!(back, entry);
        // Option None rides as JSON null, Vec as [] (the project convention --
        // no skip_serializing_if anywhere in the wire model).
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value["compatibility"].is_null());
        assert!(value["license"].is_string());
    }
}
