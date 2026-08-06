//! MCP hang server fixture (issue #392).
//!
//! A stdio process that spawns successfully but NEVER responds to any
//! JSON-RPC request. The probe timeout integration test spawns it,
//! verifies the deadline fires, and confirms the child is killed + reaped.
//!
//! The process reads stdin (to keep the pipe open so the parent sees a
//! live process, not a crash) but writes nothing to stdout. The gateway's
//! [`McpClient`](toptopduck_lib::mcp::client::McpClient) blocks forever on
//! `read_line` waiting for the `initialize` response, simulating a broken
//! MCP server that accepts the connection but never sends a reply.
//!
//! The process exits when stdin closes (the probe kills the child) or on
//! any read error. Pure std — no serde, no lib import — self-contained like
//! the sibling `mcp_fake_server` fixture.

use std::io::{self, BufRead, BufReader};

fn main() {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break, // stdin closed (probe killed the child)
            Ok(_) => {}              // discard — never respond
        }
    }
}
