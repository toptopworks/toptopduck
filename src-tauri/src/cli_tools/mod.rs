//! User-registered CLI tools: the second external tool source (ADR-0108).
//!
//! A registered CLI tool is a named, non-interactive command the gateway
//! executes by spawning the child process with a direct `argv` array -- never
//! a shell (ADR-0108 Decision 3). Tool-level semantics are isomorphic to
//! external MCP tools: named tool + parameter schema + tiered approval +
//! audit + execution trace; the difference is only the execution transport.
//!
//! - [`config`] -- the registry data model (lives in app-config next to the
//!   MCP registry, ADR-0109 Decision 9), name-collision validation against
//!   the reserved tool names, the argv template renderer, and the tool-table
//!   definitions builder for the direct-listed surface (ADR-0108 Decision 6).
//! - [`builtin`] -- the shipped definition set + install detection +
//!   auto-registration (issue #675, ADR-0109 Decisions 1/3/4): the version
//!   asset that registers `source = Builtin` entries on detected installs.
//! - [`executor`] -- the spawn engine: byte-capped stdout/stderr, exit-code
//!   mapping onto the model-facing tool result, and round-level cancellation
//!   mapped to process-tree termination (ADR-0108 Decision 5).

pub mod builtin;
pub mod config;
pub mod executor;
