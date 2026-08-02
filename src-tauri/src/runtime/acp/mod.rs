//! The ACP (Agent Client Protocol) v1 subset this engine drives (ADR-0081).
//!
//! Three submodules, each one ADR-0081 concern:
//! - [`wire`]: the JSON-RPC 2.0 + ACP method/notification shapes (serde). The
//!   ONLY place the on-the-wire field names live.
//! - [`adapter`]: the per-CLI pure-data definition ([`AdapterSpec`]) +
//!   [`detect_adapter`] PATH scan. Adding a CLI = adding one [`AdapterSpec`].
//! - [`engine`]: the generic driver. Spawns the CLI, speaks the [`wire`] subset,
//!   maps `session/update` to the execution trace (ADR-0078), enforces the
//!   execution-level caps (ADR-0081 step + wall-clock), and cancels via
//!   `session/cancel` + SIGTERM fallback.

pub mod adapter;
pub mod engine;
pub mod wire;
