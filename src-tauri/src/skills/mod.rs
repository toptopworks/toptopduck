//! Skills registry (issue #362, ADR-0086): the Agent Skills spec library.
//!
//! A skill is an [Agent Skills](https://agentskills.io/specification)
//! directory -- `<root>/<name>/SKILL.md` (YAML frontmatter + Markdown body) --
//! under the single registry root `<app_data_dir>/skills`. The DIRECTORY SCAN
//! is the registry (no sidecar, no app-config entry): whatever spec-valid
//! directory lives there shows up in `list_skills`. Identity is the spec
//! `name` (kebab-case, <= 64 chars, equal to the directory name -- ADR-0086
//! Decision 2); the loader derives `acquired` from the directory's filesystem
//! nature (`linked` = symlink / junction onto an external source, `local` =
//! real directory). v1 declares three things per skill: the prompt fragment
//! (the SKILL.md body) + optional MCP server references (the frontmatter
//! extension key `metadata.toptopduck_mcp_servers`) + optional CLI tool
//! references (the frontmatter extension key `metadata.toptopduck_cli_tools`);
//! `scripts/` execution is out of scope for v1 (ADR-0086 Decision 1).
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
//! - [`prompt`]: per-turn skill resolution for prompt injection + provenance
//!   (issue #364) -- resolves each mounted skill into its verbatim body + the
//!   SHA-256 of the whole `SKILL.md`.

pub mod frontmatter;
pub mod import;
pub mod model;
pub mod prompt;
pub mod registry;

pub use import::{discover_skill_sources, import_skill, import_skills};
pub use model::{
    Acquired, DiscoveredSkill, DiscoveredSkillStatus, ImportItem, ImportMode, ImportOutcome,
    SkillEntry, SkillError, SkillListing, SkillSource, SkillSourceCandidate, SkillUpdate,
    SkillsRoot, SkippedSkill,
};
pub use prompt::{resolve_prompt_fragments, SkillPromptFragment};
