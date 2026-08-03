//! User-configured external MCP servers (ADR-0076, issue #301).
//!
//! This module is the domain layer for the app's MCP concerns. The gateway
//! (`crate::runtime::gateway`) is the single enforcement point for tool-call
//! trust (ADR-0076/0080); this module owns the connection descriptors + the
//! secrets contract that gateway consumes to aggregate an enabled server's
//! tools into the advertised table.
//!
//! Submodules, one per concern, landed slice by slice:
//! - [`config`]: the app-config model for a user-configured server (slice A,
//!   issue #301 AC#1) + the upsert/remove CRUD helpers (slice B).
//! - [`secrets`]: the OS keychain secret store for a server's secret env values
//!   (slice B, issue #301).
//! - [`client`]: the stdio JSON-RPC client the gateway drives per turn (slice
//!   C1, issue #301).
//! - [`aggregator`]: the merged tool-table view + `tools/call` router over
//!   connected external servers (slice C-gw, issue #301).

pub mod aggregator;
pub mod client;
pub mod config;
pub mod secrets;
