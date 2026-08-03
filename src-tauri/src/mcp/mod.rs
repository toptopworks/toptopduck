//! User-configured external MCP servers (ADR-0076, issue #301).
//!
//! This module is the domain layer for the app's MCP concerns. The gateway
//! (`crate::runtime::gateway`) is the single enforcement point for tool-call
//! trust (ADR-0076/0080); this module owns the connection descriptors + the
//! secrets contract that gateway consumes to aggregate an enabled server's
//! tools into the advertised table.
//!
//! Submodules, one per concern, landed slice by slice:
//! - [`config`]: the app-config model for a user-configured server (this slice,
//!   issue #301 AC#1). The keychain secret store + the MCP client the gateway
//!   drives land in later slices.

pub mod config;
