//! The bounded single-line reader every untrusted-input surface shares
//! (issues #629/#639/#643/#647).
//!
//! Five faces read untrusted peer output through this one implementation:
//! the ACP adapter stdout readers (`spawn_line_reader` in the ACP process
//! module), the gateway's NDJSON frame reader (`read_message` in the
//! gateway framing module), the gateway's bridge-auth check, the
//! acp_bridge handshake, and the MCP client's SSE event reader
//! (`read_sse_event_bounded` in the MCP client module). The cap is a
//! security invariant against untrusted peer output, not a tunable -- it
//! stays a compile-time constant (see [`LINE_MAX_BYTES`]).
//!
//! This file is deliberately pure std. The bridge binary must not link the
//! lib crate (ADR-0085: a zero-dependency `[[bin]]` so release LTO
//! dead-strips Tauri/DuckDB out of the per-turn-spawned binary), so it
//! includes this module by `#[path]` instead of importing the crate --
//! anything non-std here breaks that constraint.
//!
//! An over-long line is drained and surfaced as [`LineRead::Overlong`]; the
//! disposition is the caller's -- the ACP readers drop it with a warning, the
//! gateway framing fails the connection (issue #646), both bridge-auth
//! handshakes refuse (the log target is domain-specific, and the bridge has
//! no logging surface at all), and the MCP SSE reader voids the whole
//! in-progress event and resyncs at the next event boundary, the stream
//! continuing (issue #647).
//!
//! There are two consumption shapes sharing one implementation (issue #649):
//! the stateless [`read_line_bounded`] (a fresh line per call -- every caller
//! whose reads cannot time out), and [`BoundedLineReader`] (the partial line
//! stays with the reader, so a caller that retries on a read timeout resumes
//! the same line instead of re-framing from the stream's mid-line position).
use std::io::{BufRead, Read};

/// The byte cap on a single incoming line (issue #629): an untrusted
/// child cannot grow the reader's buffer past this; an over-long line is
/// drained and surfaced as [`LineRead::Overlong`] (the drop / fail /
/// refuse policy is the caller's). A compile-time constant on purpose: it
/// is a security invariant against untrusted output, not a user tunable --
/// raising it is an evidence-driven default change, not a config knob.
pub(crate) const LINE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// One step of [`read_line_bounded`].
#[derive(Debug)]
pub(crate) enum LineRead {
    /// A complete line (including a final unterminated line at EOF).
    Line(String),
    /// The line exceeded the cap; its remainder was drained.
    Overlong,
    /// The stream reached EOF.
    Eof,
}

/// Read one line, buffering at most `max` bytes of it (issue #629). The
/// `max` parameter exists for the unit tests (small caps keep fixtures
/// tiny); every production caller passes [`LINE_MAX_BYTES`].
///
/// The line state is call-local: each invocation starts a fresh line, so a
/// partial line is discarded when an error (a read timeout included)
/// propagates. Callers that retry on read timeouts and must not lose that
/// progress read through [`BoundedLineReader`] instead (issue #649).
pub(crate) fn read_line_bounded(
    reader: &mut impl BufRead,
    max: usize,
) -> std::io::Result<LineRead> {
    BoundedLineReader::new(reader).read_line_bounded(max)
}

/// The resumable form of [`read_line_bounded`] (issue #649): the partial
/// line stays with the reader across calls, so a caller that retries after
/// a read timeout (`TimedOut` / `WouldBlock`) resumes the same line at the
/// stream's current position instead of re-framing the tail as a new line.
pub(crate) struct BoundedLineReader<R> {
    reader: R,
    partial: Vec<u8>,
}

impl<R: BufRead> BoundedLineReader<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader,
            partial: Vec::new(),
        }
    }

    /// Read one line under the same cap + disposition contract as
    /// [`read_line_bounded`]. An error return (a read timeout included)
    /// leaves the partial line buffered; call again to resume it.
    pub(crate) fn read_line_bounded(&mut self, max: usize) -> std::io::Result<LineRead> {
        // A zero budget can never read a byte, so it reports EOF -- the
        // stateless shape's answer to the same degenerate input (the
        // over-long check below would otherwise fire on `0 == 0`). Every
        // real caller passes a positive cap.
        if max == 0 {
            return Ok(LineRead::Eof);
        }
        // The take budget is what remains for THIS line: it only shrinks
        // while the line is pending, never resets to `max` on retry -- so
        // the accumulated line can never pass the cap, the same memory
        // invariant a single unbroken read carries (issue #649).
        let remaining = max.saturating_sub(self.partial.len());
        Read::take(&mut self.reader, remaining as u64).read_until(b'\n', &mut self.partial)?;

        // The budget was exhausted without a newline: the line is over-long,
        // whether it filled in this call or across retried ones (an
        // error-interrupted read can leave appended bytes at exactly the
        // limit). (A short line without a newline is the final line before
        // EOF -- a normal line. A line whose payload reaches `max` bytes
        // drops as over-long either way: mid-stream its newline lands one
        // byte past the budget, and an exactly-`max` final line is not
        // distinguishable from an over-long one before the drain -- the
        // safe side of both.)
        //
        // The drain runs through a local scratch: `partial` keeps holding
        // the over-long evidence, so a read timeout DURING the drain
        // re-enters this branch on retry rather than resuming a garbage
        // line from drained bytes.
        if self.partial.len() == max && !self.partial.ends_with(b"\n") {
            let mut scratch = Vec::new();
            loop {
                scratch.clear();
                Read::take(&mut self.reader, max as u64).read_until(b'\n', &mut scratch)?;
                // EOF mid-line, or the over-long line's own newline: done.
                if scratch.is_empty() || scratch.ends_with(b"\n") {
                    self.partial.clear();
                    return Ok(LineRead::Overlong);
                }
            }
        }

        if self.partial.ends_with(b"\n") {
            return Ok(LineRead::Line(take_utf8_line(&mut self.partial)?));
        }
        // read_until returned without the delimiter and the budget is not
        // exhausted (handled above): EOF. A pending partial is the final
        // unterminated line; nothing pending is a clean EOF.
        if self.partial.is_empty() {
            return Ok(LineRead::Eof);
        }
        Ok(LineRead::Line(take_utf8_line(&mut self.partial)?))
    }
}

/// Move `raw` out and decode it, keeping the `read_line` failure shape: an
/// io error, so a caller's break-on-error path is unchanged.
fn take_utf8_line(raw: &mut Vec<u8>) -> std::io::Result<String> {
    String::from_utf8(std::mem::take(raw)).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Normal lines come through verbatim (newline included; the caller's
    /// loop trims), and EOF reports as such.
    #[test]
    fn reads_normal_lines() {
        let mut cur = Cursor::new(b"one\ntwo\n".to_vec());
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Line(l)) if l == "one\n"
        ));
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Line(l)) if l == "two\n"
        ));
        assert!(matches!(read_line_bounded(&mut cur, 64), Ok(LineRead::Eof)));
    }

    /// Issue #629: an over-long line is drained + dropped, and the reader
    /// keeps going -- the NEXT line still arrives (the connection survives).
    #[test]
    fn drops_overlong_line_and_keeps_reading() {
        let long = "x".repeat(100);
        let mut cur = Cursor::new(format!("{long}\nok\n").into_bytes());
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Overlong)
        ));
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Line(l)) if l == "ok\n"
        ));
    }

    /// A final line without a trailing newline is EOF-terminated, not
    /// over-long -- it comes through like any other line.
    #[test]
    fn keeps_final_unterminated_line() {
        let mut cur = Cursor::new(b"tail".to_vec());
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Line(l)) if l == "tail"
        ));
    }

    /// A line longer than the cap that never gets a newline (EOF mid-line)
    /// is still over-long, and the stream is then at EOF.
    #[test]
    fn overlong_to_eof_is_overlong_then_eof() {
        let long = "x".repeat(100);
        let mut cur = Cursor::new(long.into_bytes());
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Overlong)
        ));
        assert!(matches!(read_line_bounded(&mut cur, 64), Ok(LineRead::Eof)));
    }

    /// A line exactly at the cap that IS newline-terminated is a normal
    /// line -- the cap excludes the boundary false positive.
    #[test]
    fn cap_sized_terminated_line_is_normal() {
        let exact = "x".repeat(63); // 63 x's + '\n' = 64 = the cap
        let mut cur = Cursor::new(format!("{exact}\n").into_bytes());
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Line(l)) if l == format!("{exact}\n")
        ));
    }

    /// The mirror half of the boundary above: a mid-stream line whose
    /// payload is exactly `max` bytes drops as over-long -- its newline
    /// lands one byte past the budget (the documented conservative side)
    /// -- and the reader keeps going with the next line.
    #[test]
    fn exact_max_payload_drops_as_overlong() {
        let exact = "x".repeat(64); // 64 x's: the newline is byte 65
        let mut cur = Cursor::new(format!("{exact}\nok\n").into_bytes());
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Overlong)
        ));
        assert!(matches!(
            read_line_bounded(&mut cur, 64),
            Ok(LineRead::Line(l)) if l == "ok\n"
        ));
    }

    /// Invalid UTF-8 keeps the old `read_line` failure shape: an io error,
    /// so a caller's break-on-error path is unchanged.
    #[test]
    fn invalid_utf8_is_an_io_error() {
        let mut cur = Cursor::new(vec![0xff, 0xfe, b'\n']);
        let err = read_line_bounded(&mut cur, 64).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    /// A failing reader propagates as an io error (a real read failure,
    /// unlike the constructed UTF-8 one above) -- every caller's Err arm
    /// rides on this shape.
    #[test]
    fn read_error_propagates() {
        struct FailRead;
        impl Read for FailRead {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("read failed"))
            }
        }
        impl BufRead for FailRead {
            fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
                Err(std::io::Error::other("fill failed"))
            }
            fn consume(&mut self, _: usize) {}
        }
        let err = read_line_bounded(&mut FailRead, 64).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::Other);
    }

    // --- BoundedLineReader resume semantics (issue #649) -----------------

    /// A reader that plays back a fixed script: byte chunks interleaved
    /// with failures carrying the socket read-timeout kinds. Each failure
    /// fires once, then playback continues; past the script's end it reads
    /// EOF. This is the fixture shape that pins the resume semantics -- a
    /// `TimedOut` mid-line must not discard the bytes already pulled.
    struct Scripted {
        steps: Vec<Step>,
        pos: usize,
    }

    enum Step {
        Bytes(Vec<u8>),
        Fail(std::io::ErrorKind),
    }

    impl Scripted {
        fn new(steps: Vec<Step>) -> Self {
            Self { steps, pos: 0 }
        }
    }

    impl Read for Scripted {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let available = self.fill_buf()?;
            let n = available.len().min(buf.len());
            buf[..n].copy_from_slice(&available[..n]);
            self.consume(n);
            Ok(n)
        }
    }

    impl BufRead for Scripted {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            loop {
                match self.steps.get(self.pos) {
                    None => return Ok(&[]),
                    Some(Step::Fail(kind)) => {
                        let err = std::io::Error::new(*kind, "scripted failure");
                        self.pos += 1;
                        return Err(err);
                    }
                    Some(Step::Bytes(b)) if b.is_empty() => self.pos += 1,
                    Some(Step::Bytes(b)) => return Ok(b),
                }
            }
        }

        fn consume(&mut self, n: usize) {
            if let Some(Step::Bytes(b)) = self.steps.get_mut(self.pos) {
                let n = n.min(b.len());
                b.drain(..n);
            }
        }
    }

    /// Issue #649: a read timeout mid-line keeps the partial line buffered
    /// -- the retried read resumes the SAME line (the prefix survives, the
    /// suffix lands after it) instead of re-framing from the stream's
    /// mid-line position.
    #[test]
    fn resumable_reader_survives_timeout_mid_line() {
        let mut r = BoundedLineReader::new(Scripted::new(vec![
            Step::Bytes(b"{\"json".to_vec()),
            Step::Fail(std::io::ErrorKind::TimedOut),
            Step::Bytes(b"rpc\":\"2.0\"}\n".to_vec()),
        ]));
        let err = r.read_line_bounded(64).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::TimedOut);
        assert!(matches!(
            r.read_line_bounded(64),
            Ok(LineRead::Line(l)) if l == "{\"jsonrpc\":\"2.0\"}\n"
        ));
    }

    /// A timeout before any byte of a line is pending is a plain retry:
    /// nothing was buffered, so the next call reads the line normally.
    #[test]
    fn resumable_reader_times_out_before_any_bytes() {
        let mut r = BoundedLineReader::new(Scripted::new(vec![
            Step::Fail(std::io::ErrorKind::WouldBlock),
            Step::Bytes(b"hello\n".to_vec()),
        ]));
        let err = r.read_line_bounded(64).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::WouldBlock);
        assert!(matches!(
            r.read_line_bounded(64),
            Ok(LineRead::Line(l)) if l == "hello\n"
        ));
    }

    /// Issue #649's budget invariant: the remaining budget never resets on
    /// retry. A line that reaches the cap across an error-interrupted read
    /// and its resumption is still over-long -- the accumulated line cannot
    /// pass `max`, and the over-long cause is not lost to the split.
    #[test]
    fn resumable_reader_budget_shrinks_across_retries() {
        let mut r = BoundedLineReader::new(Scripted::new(vec![
            Step::Bytes(b"12345".to_vec()), // 5 bytes, then the sender stalls
            Step::Fail(std::io::ErrorKind::TimedOut),
            Step::Bytes(b"67890\n".to_vec()), // pushes the line past the cap
            Step::Bytes(b"next\n".to_vec()),  // ... and the stream continues
        ]));
        assert_eq!(
            r.read_line_bounded(8).unwrap_err().kind(),
            std::io::ErrorKind::TimedOut
        );
        // Resume: only 3 bytes of budget remain, so the accumulation caps at
        // 8 without a newline -> over-long; the drain eats "0\n" and the
        // stream continues with the next line intact.
        assert!(matches!(r.read_line_bounded(8), Ok(LineRead::Overlong)));
        assert!(matches!(
            r.read_line_bounded(8),
            Ok(LineRead::Line(l)) if l == "next\n"
        ));
    }

    /// A timeout DURING the over-long drain: the evidence stays buffered, so
    /// the retry re-enters the drain and reports over-long -- never a
    /// garbage line resumed from drained bytes.
    #[test]
    fn resumable_reader_reenters_drain_after_timeout() {
        let mut r = BoundedLineReader::new(Scripted::new(vec![
            Step::Bytes(b"12345678".to_vec()), // exactly the cap, no newline
            Step::Fail(std::io::ErrorKind::TimedOut), // fires inside the drain
            Step::Bytes(b"tail\n".to_vec()),
        ]));
        assert_eq!(
            r.read_line_bounded(8).unwrap_err().kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(matches!(r.read_line_bounded(8), Ok(LineRead::Overlong)));
        assert!(matches!(r.read_line_bounded(8), Ok(LineRead::Eof)));
    }

    /// A sender that stalls and then closes without a newline: the resumed
    /// partial comes through as the final unterminated line, matching the
    /// stateless reader's EOF-line semantics.
    #[test]
    fn resumable_reader_final_unterminated_line_after_timeout() {
        let mut r = BoundedLineReader::new(Scripted::new(vec![
            Step::Bytes(b"tail".to_vec()),
            Step::Fail(std::io::ErrorKind::TimedOut),
        ]));
        assert!(r.read_line_bounded(64).is_err());
        assert!(matches!(
            r.read_line_bounded(64),
            Ok(LineRead::Line(l)) if l == "tail"
        ));
    }
}
