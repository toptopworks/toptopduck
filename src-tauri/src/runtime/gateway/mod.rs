//! The external-runtime MCP gateway (ADR-0085).
//!
//! The gateway is the app-side aggregation point an external CLI's bridge
//! connects back to over localhost TCP. It advertises the built-in DuckDB tool
//! table plus the enabled CLI registrations (`tools/list`, one tool plane --
//! issue #673, ADR-0108 Decision 6) and routes every `tools/call` through the
//! approval gate into [`crate::tools::dispatch`] or the shared CLI spawn
//! engine -- the same path the built-in agent loop takes, so approval, audit,
//! and materialization are enforced identically for both runtimes
//! (ADR-0076 single enforcement point).
//!
//! Two submodules, each one ADR-0085 concern:
//! - [`framing`]: newline-delimited JSON-RPC read/write (MCP stdio framing).
//! - [`server`]: the per-bridge-connection listener + MCP handler
//!   ([`server::bind_gateway`] + [`server::serve_connection`]).

// Slice 9b: bind_gateway / serve_connection / framing have no in-crate caller
// until 9c Session::ask wires the bridge spawn + parallel gateway serve. The
// `#[cfg(test)]` block in server.rs exercises them, but normal lib builds do
// not compile test code, so the lint fires there. Allow dead_code for the slice
// to keep `cargo check --lib` + `cargo clippy -- -D warnings` green; remove
// this attribute once 9c lands the first real caller.
#![allow(dead_code)]

pub mod framing;
pub mod server;

// No re-exports yet (ADR-0085 slice 9b): 9c Session::ask is the first consumer
// of bind_gateway / serve_connection, at which point the call paths are pinned
// and a re-export -- if it reads cleaner then -- can land alongside it.
// Re-exporting now just to seed the path trips unused_imports under -D warnings
// (the items have no in-crate caller this slice).
