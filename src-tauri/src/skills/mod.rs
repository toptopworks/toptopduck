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
//! real directory). v1 declares only two things per skill: the prompt fragment
//! (the SKILL.md body) + optional MCP server references (the frontmatter
//! extension key `metadata.toptopduck_mcp_servers`); `scripts/` execution is
//! out of scope for v1 (ADR-0086 Decision 1).
//!
//! Submodules:
//! - [`model`]: the wire types (`SkillEntry` / `SkillUpdate` / `Acquired`),
//!   the typed `SkillError` reject, and the spec validation rules.
//! - [`frontmatter`]: `SKILL.md` frontmatter split / parse / render -- unknown
//!   spec fields survive an edit verbatim.
//! - [`registry`]: the root-parameterized scan + create / update / delete
//!   (Tauri-state-free, so the whole surface tests against a tempdir).

pub mod frontmatter;
pub mod model;
pub mod registry;

pub use model::{Acquired, SkillEntry, SkillError, SkillUpdate, SkillsRoot};
