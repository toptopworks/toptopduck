//! The workspace domain (ADR-0137/0138): workspaces as logical units over
//! directories. This module owns the ORGANIZATION layer -- the record
//! registry that carries identity, display name, and the bound canonical
//! path. The EXECUTION axis (cwd resolution, lazy minting, empty reclaim)
//! lives in [`crate::session::workspace`]; the two share the canonical
//! spelling but never each other's state.

pub mod registry;

pub use registry::{WorkspaceRecord, WorkspaceRegistry, WORKSPACES_FILE_NAME};
