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

use crate::bounded_line::{BoundedLineReader, LineRead, LINE_MAX_BYTES};

/// Read one newline-delimited JSON-RPC message. Returns `None` at clean EOF
/// (peer closed); returns `Err` on an invalid line.
///
/// A blank line (some peers emit keepalive CRLFs between frames) is skipped --
/// the reader loops internally to the next real frame rather than treating the
/// gap as a synthetic empty message, so a peer flooding blank lines cannot
/// overflow the stack.
///
/// Each line is read through the shared byte cap (issues #643/#646): an
/// over-long line is drained and fails the read with `InvalidData` -- the
/// connection drops. This is an id-correlated request/response stream, not an
/// event stream: a silently dropped frame would leave its pending id
/// unresolved (the reader parks until the wall-clock watchdog cancels the
/// turn with the wrong attribution), so over-long input must fail fast and
/// visibly. (The ACP readers keep drop-and-warn on a different safety net:
/// their event streams carry no pending id, and a dropped terminator frame
/// still settles at EOF through the fallback outcome -- a degraded but
/// visible turn end, not a parked read.) The cap is the same
/// [`LINE_MAX_BYTES`] the ACP readers enforce: one untrusted-input invariant
/// across every face.
///
/// Line state is call-local (issue #649): a partial line is discarded when a
/// read error propagates. That is correct for callers whose reads cannot
/// time out (the MCP client); the gateway serve loop, which retries on read
/// timeouts, reads through [`FrameReader`] so the partial frame survives the
/// retry.
pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    FrameReader::new(reader).read_message()
}

/// The stateful [`read_message`] (issue #649): the partial frame stays with
/// the reader, so a caller that retries after a read timeout (`TimedOut` /
/// `WouldBlock`) resumes the same frame instead of re-framing the tail as a
/// new line -- a peer pausing mid-frame longer than the read timeout still
/// completes the frame.
pub struct FrameReader<R: BufRead> {
    lines: BoundedLineReader<R>,
}

impl<R: BufRead> FrameReader<R> {
    /// Wrap an already-connected reader.
    pub fn new(reader: R) -> Self {
        Self {
            lines: BoundedLineReader::new(reader),
        }
    }

    /// Same contract as [`read_message`]; a read timeout propagates as `Err`
    /// with the partial frame retained -- call again to resume it.
    pub fn read_message(&mut self) -> io::Result<Option<Value>> {
        loop {
            match self.lines.read_line_bounded(LINE_MAX_BYTES)? {
                LineRead::Eof => return Ok(None),
                LineRead::Overlong => {
                    log::warn!(
                        target: "toptopduck::gateway",
                        "frame line exceeded {LINE_MAX_BYTES} bytes, failing the connection"
                    );
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("frame line exceeded {LINE_MAX_BYTES} bytes"),
                    ));
                }
                LineRead::Line(line) => {
                    let trimmed = line.trim_end_matches(['\r', '\n']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    return serde_json::from_str(trimmed)
                        .map(Some)
                        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
                }
            }
        }
    }
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

    /// Issue #646: a frame whose single line exceeds the byte cap fails the
    /// read with `InvalidData` (the same kind a malformed-JSON line yields)
    /// and names the cap. This stream is id-correlated, so a silently dropped
    /// frame would leave its pending id unresolved until the wall-clock
    /// watchdog; an explicit failure is the observable contract on both
    /// faces. Bytes after the over-long line are unreachable -- the caller
    /// tears the connection down on the error, never reads past it.
    #[test]
    fn read_fails_overlong_line_as_invalid_data() {
        // One over-long line (newline-terminated), then a normal frame that
        // must never be reached.
        let mut wire = "x".repeat(LINE_MAX_BYTES + 1).into_bytes();
        wire.push(b'\n');
        wire.extend_from_slice(b"{\"jsonrpc\":\"2.0\",\"id\":7}\n");
        let mut reader = std::io::Cursor::new(wire);
        let err = read_message(&mut reader).expect_err("over-long frame");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains(&LINE_MAX_BYTES.to_string()),
            "the error names the cap: {err}"
        );
    }

    /// A final frame without a trailing newline still parses -- the tail line
    /// before EOF is a normal frame, not an error (pins the read_line-shaped
    /// semantics the bounded reader must preserve).
    #[test]
    fn read_parses_a_final_unterminated_frame() {
        let mut reader = std::io::Cursor::new(b"{\"jsonrpc\":\"2.0\",\"id\":9}".to_vec());
        let msg = read_message(&mut reader)
            .expect("read the tail line")
            .expect("a message");
        assert_eq!(msg["id"], 9);
    }

    /// A reader whose playback is split by a read timeout: it yields
    /// `first`, then one `TimedOut` error, then `second`, then EOF (issue
    /// #649 fixture).
    struct SplitByTimeout {
        first: Vec<u8>,
        second: Vec<u8>,
        phase: u8, // 0: first chunk, 1: fail next, 2: second chunk, 3: EOF
    }

    impl SplitByTimeout {
        fn new(first: &str, second: &str) -> Self {
            Self {
                first: first.into(),
                second: second.into(),
                phase: 0,
            }
        }
    }

    impl std::io::Read for SplitByTimeout {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let available = self.fill_buf()?;
            let n = available.len().min(buf.len());
            buf[..n].copy_from_slice(&available[..n]);
            self.consume(n);
            Ok(n)
        }
    }

    impl std::io::BufRead for SplitByTimeout {
        fn fill_buf(&mut self) -> io::Result<&[u8]> {
            match self.phase {
                0 => Ok(&self.first),
                1 => {
                    self.phase = 2;
                    Err(io::Error::new(io::ErrorKind::TimedOut, "scripted timeout"))
                }
                2 => Ok(&self.second),
                _ => Ok(&[]),
            }
        }

        fn consume(&mut self, n: usize) {
            let (chunk, next) = match self.phase {
                0 => (&mut self.first, 1),
                2 => (&mut self.second, 3),
                _ => return,
            };
            let n = n.min(chunk.len());
            chunk.drain(..n);
            if chunk.is_empty() {
                self.phase = next;
            }
        }
    }

    /// Issue #649: a read timeout splitting a frame does not re-frame -- the
    /// FrameReader keeps the partial line, and the retried `read_message`
    /// completes the same frame. (The stateless entry starts a fresh line
    /// and would have parsed the tail as a new -- malformed -- frame.)
    #[test]
    fn frame_reader_resumes_frame_across_read_timeout() {
        let mut r = FrameReader::new(SplitByTimeout::new(
            "{\"jsonrpc\":\"2.0\",\"id\":",
            "5,\"method\":\"tools/list\"}\n",
        ));
        let err = r.read_message().unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        let msg = r.read_message().expect("resume").expect("a message");
        assert_eq!(msg["id"], 5);
        assert_eq!(msg["method"], "tools/list");
        // State resets after the completed line: EOF reads as EOF.
        assert!(r.read_message().expect("eof").is_none());
    }
}
