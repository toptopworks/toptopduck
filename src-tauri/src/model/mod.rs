//! Domain types crossing the Rust<->frontend IPC boundary and the black-box test
//! seam. Vocabulary follows CONTEXT.md (Dataset / Working Set / Active Dataset)
//! and ADR-0037 (reference name vs display label).

mod dataset;
mod provider;
mod thread;
mod turn;

pub use dataset::*;
pub use provider::*;
pub use thread::*;
pub use turn::*;
