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
/// tiny); every production caller passes [`LINE_MAX_BYTES`]. The scratch
/// buffer is function-local: the over-long drain pass reuses it within
/// one call, and the accepted line is moved out of it for the UTF-8
/// conversion.
pub(crate) fn read_line_bounded(
    reader: &mut impl BufRead,
    max: usize,
) -> std::io::Result<LineRead> {
    let mut raw: Vec<u8> = Vec::new();
    // `take(max)` bounds the read: the buffer never holds more than `max`
    // bytes, so a hostile single line cannot grow it without limit.
    let n = Read::take(&mut *reader, max as u64).read_until(b'\n', &mut raw)?;
    if n == 0 {
        return Ok(LineRead::Eof);
    }
    // The budget was exhausted without a newline: the line is over-long.
    // (A short line without a newline is the final line before EOF -- a
    // normal line. A line whose payload reaches `max` bytes drops as
    // over-long either way: mid-stream its newline lands one byte past
    // the budget, and an exactly-`max` final line is not distinguishable
    // from an over-long one before the drain -- the safe side of both.)
    // Drain the remainder in bounded chunks, then drop.
    if n == max && !raw.ends_with(b"\n") {
        loop {
            raw.clear();
            let n = Read::take(&mut *reader, max as u64).read_until(b'\n', &mut raw)?;
            // EOF mid-line, or the over-long line's own newline: done.
            if n == 0 || raw.ends_with(b"\n") {
                return Ok(LineRead::Overlong);
            }
        }
    }
    let line = String::from_utf8(std::mem::take(&mut raw)).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        )
    })?;
    Ok(LineRead::Line(line))
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
}
