//! Agent definitions registry (issue #932, ADR-0117): the assembly
//! descriptions the built-in runtime's named delegation tool family (#933)
//! constructs sub-agents from.
//!
//! An agent definition is a single community-format markdown file --
//! `<root>/<name>.md` (YAML frontmatter + Markdown preamble) -- under the
//! single registry root `<app_data_dir>/agents`. The DIRECTORY SCAN is the
//! registry (no sidecar table): whatever spec-valid file lives there shows
//! up in `list_agents`. Identity is the `name` (kebab-case, <= 64 chars,
//! equal to the file stem -- the skills loader's consistency rule) and it
//! doubles as the delegation TOOL name in the turn assembly, so create /
//! rename refuse every reserved tool name (the CLI-registration precedent).
//! The frontmatter carries `name` / `description`; the body is the preamble
//! (the sub-agent's system prompt). The community `tools` / `model` axes
//! are parsed then discarded with a recorded warning (ADR-0117 Decision 2).
//! The skill-binding rule is backtick marks in the preamble: a
//! backtick-wrapped kebab-case word naming a registered skill binds that
//! skill's body into the sub-agent at assembly time; a well-shaped mark
//! naming no skill warns and never blocks.
//!
//! The registry is pure configuration in this slice: the turn assembly does
//! NOT consume it yet (#933 wires the family); this module lands the entity,
//! persistence, validation, CRUD IPC, and the settings surface.
//!
//! Submodules:
//! - [`model`]: the wire types (`AgentEntry` / `AgentUpdate` /
//!   `AgentSource`), the typed `AgentError` reject, the validation rules,
//!   and the backtick skill-mark extraction.
//! - [`frontmatter`]: the community-format split / parse / render -- the
//!   dropped `tools` / `model` axes are recorded, unknown keys survive an
//!   edit verbatim.
//! - [`registry`]: the root-parameterized scan + create / update / delete
//!   (Tauri-state-free, so the whole surface tests against a tempdir).
//! - [`builtin`]: the shipped `general-purpose` definition + the
//!   startup materialization window (real file + the app-config mark = the
//!   builtin posture).

pub mod builtin;
pub mod frontmatter;
pub mod model;
pub mod registry;

pub use builtin::BuiltinAgentMark;
pub use model::{
    AgentEntry, AgentError, AgentListing, AgentSource, AgentUpdate, AgentWarning, AgentsRoot,
    SkippedAgent,
};
