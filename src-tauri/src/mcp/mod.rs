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
//! - [`aggregator`]: the merged tool-surface view + `tools/call` router over
//!   connected external servers (slice C-gw, issue #301).
//! - [`meta_tools`]: the fixed discovery trio (`mcp_list_servers` /
//!   `mcp_search_tools` / `mcp_invoke`) that replaces the flattened
//!   per-tool advertisement (ADR-0105, issue #657).

/// The MCP protocol version the gateway speaks on both ends (ADR-0076). The
/// client ([`client`]) advertises it at `initialize`; the server-side initialize
/// response ([`crate::runtime::gateway`]) echoes it. Pinned in one place so the
/// gateway's two ends never diverge; the server may negotiate via its
/// initialize result, which the gateway logs but does not otherwise act on in
/// slice C1. The `mcp-fake-server` test fixture mirrors this literal (see
/// `tests/fixtures/mcp_fake_server.rs`) -- it is a separate `[[bin]]` with no
/// lib import, so it cannot reference this constant and must be bumped in
/// lock-step when this value changes.
pub(crate) const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

pub mod aggregator;
pub mod client;
pub mod config;
pub mod import;
pub mod meta_tools;
pub mod secrets;

pub use client::McpClient;
