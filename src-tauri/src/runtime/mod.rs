//! External runtime (ADR-0076 / ADR-0081, issue #299).
//!
//! The external runtime is the second of the two并存 runtimes (the built-in is
//! [`crate::session::agent_loop::AgentLoop`]). The app spawns a third-party CLI
//! agent process (claude-code v1; gemini-cli / codex in #300) and drives it over
//! ACP v1 (stdio JSON-RPC). The engine here is the **generic, data-driven**
//! half of ADR-0081 Decision: every CLI is a pure data definition
//! ([`acp::adapter::AdapterSpec`]); the engine does detection / launch / parse
//! with zero per-CLI code branches.
//!
//! This first slice (9a) lands the adapter engine + the ACP wire subset + a
//! fake-CLI fixture (test seam C) + engine integration tests. The thin bridge
//! process that the CLI launches to reach the app-side MCP gateway, the gateway
//! stdio server, and the live `Session::ask` wiring are subsequent slices
//! (9b / 9c) -- they depend on the still-open transport decision
//! (ADR-0076/0081 未决: bridge distribution shape, gateway process boundary).
//!
//! Statelessness (ADR-0076): each turn is `session/new` + `session/prompt` with
//! the full windowed context. `session/load` (upstream-persistent sessions) is
//! deliberately NOT used -- the app owns all authoritative state.

pub mod acp;
