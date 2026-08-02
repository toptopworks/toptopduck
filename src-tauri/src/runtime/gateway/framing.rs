//! Newline-delimited JSON-RPC framing (ADR-0085).
//!
//! The MCP stdio transport carries one JSON-RPC message per line. The bridge
//! is a byte-stream proxy because it forwards the same framing on both sides
//! (stdio + TCP), so it never parses JSON. The gateway, however, must parse +
//! emit these frames to drive MCP `initialize` / `tools/list` / `tools/call`
//! -- this module is its read/write pair.
//!
//! Read returns `None` at clean EOF (the peer closed the stream), letting the
//! caller distinguish "stream ended" from "malformed line".

use std::io::{self, BufRead, Write};

use serde_json::Value;

/// Read one newline-delimited JSON-RPC message. Returns `None` at clean EOF
/// (peer closed); returns `Err` on an invalid line.
///
/// A blank line (some peers emit keepalive CRLFs between frames) is skipped --
/// the caller loops to read the next real frame rather than treating the gap
/// as a synthetic empty message.
pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut line = String::new();
    let n = reader.read_line(&mut line)?;
    if n == 0 {
        return Ok(None);
    }
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() {
        return read_message(reader);
    }
    serde_json::from_str(trimmed)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Write one newline-delimited JSON-RPC message. Serializes `msg` as compact
/// JSON + a trailing `\n`; serde_json's compact emitter produces no embedded
/// newlines, so the whole message stays on one line.
pub fn write_message(writer: &mut impl Write, msg: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, msg)?;
    writer.write_all(b"\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A round-trip through write + read preserves the message and appends the
    /// trailing newline that separates frames on the wire.
    #[test]
    fn write_then_read_round_trips_one_message() {
        let mut buf = Vec::new();
        let msg = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"});
        write_message(&mut buf, &msg).expect("write");
        assert_eq!(buf.last(), Some(&b'\n'), "frame ends with a newline");

        let mut reader = std::io::Cursor::new(buf);
        let back = read_message(&mut reader).expect("read").expect("a message");
        assert_eq!(back, msg);
    }

    /// A clean EOF (peer closed) returns `None`, not an error -- the gateway's
    /// serve loop treats this as "bridge disconnected, turn over".
    #[test]
    fn read_returns_none_at_clean_eof() {
        let mut reader = std::io::Cursor::new(Vec::new());
        let msg = read_message(&mut reader).expect("read on empty");
        assert!(msg.is_none(), "EOF -> None, not an error");
    }

    /// A blank line between frames is skipped -- the next real frame is read.
    #[test]
    fn read_skips_blank_lines_between_frames() {
        let wire = b"\n{\"jsonrpc\":\"2.0\",\"id\":2}\n";
        let mut reader = std::io::Cursor::new(wire.to_vec());
        let msg = read_message(&mut reader)
            .expect("read")
            .expect("a message after the blank line");
        assert_eq!(msg["id"], 2);
    }

    /// An invalid JSON line surfaces as an `InvalidData` error -- the gateway
    /// must not silently drop a malformed frame (it signals a protocol break).
    #[test]
    fn read_surfaces_invalid_json_as_invalid_data() {
        let wire = b"not json\n";
        let mut reader = std::io::Cursor::new(wire.to_vec());
        let err = read_message(&mut reader).expect_err("invalid json");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
