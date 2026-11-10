//! The workspace domain (ADR-0137/0138/0141): workspaces as logical units over
//! directories. This module owns the ORGANIZATION layer -- the record
//! registry that carries identity, display name, and the bound canonical
//! path -- plus the shared-dataset store (content-addressed snapshots + text
//! manifest, ADR-0141). The EXECUTION axis (cwd resolution, lazy minting,
//! empty reclaim) lives in [`crate::session::workspace`]; the two share the
//! canonical spelling but never each other's state.

pub mod datasets;
pub mod extract;
pub mod extract_runtime;
pub mod memory;
pub mod registry;

pub use datasets::{DatasetEntry, ListedDataset, StoreError};
pub use memory::{
    ListedMemory, ListedMemorySection, MemoryEntry, MemoryError, MemoryIndexRow, MemoryType,
};
pub use registry::{WorkspaceRecord, WorkspaceRegistry, WORKSPACES_FILE_NAME};
