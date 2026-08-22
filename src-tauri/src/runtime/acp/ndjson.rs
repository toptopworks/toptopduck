//! The shared NDJSON stdio round-trip (issue #540).
//!
//! One implementation of the line-delimited JSON request/response loop every
//! ACP-family driver speaks: a stdout reader thread (a blocking `read_line`
//! would not notice abort conditions), a `recv_timeout` pump, the request
//! write, and response matching by id. The three call sites --
//! [`super::engine`]'s cancel-driven turn handshake, [`super::probe`]'s
//! deadline-driven handshake, and [`super::app_server`]'s deadline-driven
//! catalog query -- differ only in their abort condition and their error
//! type; both live at the thin per-site wrapper (a per-driver entry point
//! here plus a per-site mapping, issue #543).

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::cancel::CancelToken;

/// The abort marker a cancel-driven round-trip reports (the cancel-driven
/// entry point below). The type parameter of [`RoundtripError`] makes the
/// illegal abort-kind combinations unrepresentable, so the per-site mappings
/// match exhaustively with no `unreachable!` placeholders (issue #543).
pub(super) struct Cancelled;

/// The abort marker a deadline-driven round-trip reports (the deadline-driven
/// entry point below). See [`Cancelled`] for why it exists.
pub(super) struct TimedOut;

/// A round-trip failure, before the per-site wrapper maps it onto its own
/// error type. Each variant carries the technical detail verbatim; the
/// wrapper owns the message wording (the strings are frozen by the tests'
/// locale-free diagnostic fold). The `A` parameter is the driver's abort
/// marker ([`Cancelled`] or [`TimedOut`]) -- fixed by which round-trip entry
/// point was used, never both.
pub(super) enum RoundtripError<A> {
    /// The driver's abort condition fired (which kind is fixed by `A`).
    Abort(A),
    /// Serializing the request failed. Carries the serde detail.
    Serialize(String),
    /// Writing / flushing the request failed. Carries the io detail.
    Write(String),
    /// The child closed stdout before the response arrived.
    Eof,
    /// The matched response failed to deserialize. Carries the serde detail.
    Parse(String),
}

/// A line-delimited JSON channel over a child's piped stdio. The stdout
/// reader runs on its own thread and forwards each non-empty trimmed line;
/// EOF closes the channel (tx dropped) so the pump's recv returns
/// Disconnected -- every caller treats that as the child dying.
pub(super) struct NdjsonIo {
    stdin: ChildStdin,
    rx: mpsc::Receiver<String>,
}

/// The byte cap on a single incoming NDJSON line (issue #629): an untrusted
/// child cannot grow the reader's buffer past this; an over-long line is
/// drained and dropped with a warning (the connection stays up -- the next
/// line still arrives).
const LINE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// One step of [`read_line_bounded`].
#[derive(Debug)]
enum LineRead {
    /// A complete line (including a final unterminated line at EOF).
    Line(String),
    /// The line exceeded the cap; its remainder was drained.
    Overlong,
    /// The stream reached EOF.
    Eof,
}

/// Read one NDJSON line, buffering at most `max` bytes of it (issue #629).
/// Within one call the over-long drain pass reuses `raw`; the accepted line
/// is moved out of it for the UTF-8 conversion.
fn read_line_bounded(
    reader: &mut impl BufRead,
    max: usize,
    raw: &mut Vec<u8>,
) -> std::io::Result<LineRead> {
    raw.clear();
    // `take(max)` bounds the read: the buffer never holds more than `max`
    // bytes, so a hostile single line cannot grow it without limit.
    let n = Read::take(&mut *reader, max as u64).read_until(b'\n', raw)?;
    if n == 0 {
        return Ok(LineRead::Eof);
    }
    // The budget was exhausted without a newline: the line is over-long.
    // (A short line without a newline is the final line before EOF -- a
    // normal line.) Drain the remainder in bounded chunks, then drop.
    if n == max && !raw.ends_with(b"\n") {
        loop {
            raw.clear();
            match Read::take(&mut *reader, max as u64).read_until(b'\n', raw) {
                Ok(0) => return Ok(LineRead::Overlong), // EOF mid-line
                Ok(_) if raw.ends_with(b"\n") => return Ok(LineRead::Overlong),
                Ok(_) => continue,
                Err(e) => return Err(e),
            }
        }
    }
    let line = String::from_utf8(std::mem::take(raw)).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "stream did not contain valid UTF-8",
        )
    })?;
    Ok(LineRead::Line(line))
}

impl NdjsonIo {
    pub(super) fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        let (tx, rx) = mpsc::channel::<String>();
        // The reader thread owns stdout; EOF drops tx so the pump's recv
        // returns Disconnected.
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut raw: Vec<u8> = Vec::new();
            loop {
                match read_line_bounded(&mut reader, LINE_MAX_BYTES, &mut raw) {
                    Ok(LineRead::Line(line)) => {
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        if tx.send(trimmed.to_string()).is_err() {
                            break; // pump gone
                        }
                    }
                    // Over-long line: dropped, never silent (issue #629) --
                    // the same answerable-in-logs stance as the parse drops.
                    Ok(LineRead::Overlong) => {
                        log::warn!(
                            target: "toptopduck::ndjson",
                            "line exceeded {LINE_MAX_BYTES} bytes, dropped"
                        );
                    }
                    Ok(LineRead::Eof) => break, // EOF
                    // The error is unrecoverable (the channel closes either
                    // way); log it so "why is the snapshot empty / why EOF"
                    // has an answer (issue #543). Warn, not debug: release
                    // builds filter at Info, and the packaged app's absent
                    // console is exactly where this diagnosis matters.
                    Err(e) => {
                        log::warn!(target: "toptopduck::ndjson", "stdout reader failed: {e}");
                        break;
                    }
                }
            }
        });
        Self { stdin, rx }
    }

    /// Serialize + write one JSON message as a single NDJSON line. Flushes so
    /// the child receives it immediately (NDJSON is line-buffered).
    pub(super) fn write_json<T: serde::Serialize>(
        &mut self,
        msg: &T,
    ) -> Result<(), std::io::Error> {
        let mut s = serde_json::to_string(msg)?;
        s.push('\n');
        self.stdin.write_all(s.as_bytes())?;
        self.stdin.flush()
    }

    /// One receive step for multiplexing loops (the turn pump), which own
    /// their own line loop and share the reader channel (+ reader thread)
    /// via this and the writer via `write_json`.
    pub(super) fn recv_timeout(&self, timeout: Duration) -> Result<String, mpsc::RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }

    /// Serialize + write the request, then pump incoming lines until its
    /// response arrives or the cancel token fires (the cancel-driven
    /// round-trip). `target` is the request id the response must carry (and
    /// no `method` field); a stray notification / unrelated message is
    /// dropped (not an error) so a chatty child cannot break the exchange.
    pub(super) fn request_roundtrip_cancel<R: serde::de::DeserializeOwned>(
        &mut self,
        req: &impl serde::Serialize,
        target: &Value,
        cancel: &CancelToken,
    ) -> Result<R, RoundtripError<Cancelled>> {
        self.write_request(req)?;
        loop {
            if cancel.is_requested() {
                return Err(RoundtripError::Abort(Cancelled));
            }
            match self.rx.recv_timeout(super::process::PUMP_POLL_INTERVAL) {
                Ok(line) => {
                    if let Some(v) = self.match_response::<R>(line, target) {
                        return v.map_err(RoundtripError::Parse);
                    }
                }
                // A partial-wait Timeout re-derives the wait: the next
                // iteration re-checks the token.
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(RoundtripError::Eof),
            }
        }
    }

    /// Serialize + write the request, then pump incoming lines until its
    /// response arrives or the deadline passes (the deadline-driven
    /// round-trip). Stray lines are dropped like the cancel-driven pump.
    pub(super) fn request_roundtrip_deadline<R: serde::de::DeserializeOwned>(
        &mut self,
        req: &impl serde::Serialize,
        target: &Value,
        deadline: Instant,
    ) -> Result<R, RoundtripError<TimedOut>> {
        self.write_request(req)?;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RoundtripError::Abort(TimedOut));
            }
            match self.rx.recv_timeout(remaining) {
                Ok(line) => {
                    if let Some(v) = self.match_response::<R>(line, target) {
                        return v.map_err(RoundtripError::Parse);
                    }
                }
                // A partial-wait Timeout re-derives the wait: the next
                // iteration re-checks the remaining time.
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(RoundtripError::Eof),
            }
        }
    }

    /// Serialize + write one request as a single NDJSON line + flush. Generic
    /// over the abort marker so both drivers lift the write failure into
    /// their own error type.
    fn write_request<A>(&mut self, req: &impl serde::Serialize) -> Result<(), RoundtripError<A>> {
        let mut msg =
            serde_json::to_string(req).map_err(|e| RoundtripError::Serialize(e.to_string()))?;
        msg.push('\n');
        self.stdin
            .write_all(msg.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| RoundtripError::Write(e.to_string()))
    }

    /// One incoming line against the awaited response: `Some(deserialize)` when
    /// the line carries the target id (and no `method` field), `None` when it
    /// is a stray to drop.
    fn match_response<R: serde::de::DeserializeOwned>(
        &mut self,
        line: String,
        target: &Value,
    ) -> Option<Result<R, String>> {
        let v: Value = serde_json::from_str(&line).ok()?;
        if v.get("id") == Some(target) && v.get("method").is_none() {
            Some(serde_json::from_value(v).map_err(|e| e.to_string()))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Normal lines come through verbatim (newline included; the reader loop
    /// trims), and EOF reports as such.
    #[test]
    fn reads_normal_lines() {
        let mut cur = Cursor::new(b"one\ntwo\n".to_vec());
        let mut raw = Vec::new();
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Line(l)) if l == "one\n"
        ));
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Line(l)) if l == "two\n"
        ));
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Eof)
        ));
    }

    /// Issue #629: an over-long line is drained + dropped, and the reader
    /// keeps going -- the NEXT line still arrives (the connection survives).
    #[test]
    fn drops_overlong_line_and_keeps_reading() {
        let long = "x".repeat(100);
        let mut cur = Cursor::new(format!("{long}\nok\n").into_bytes());
        let mut raw = Vec::new();
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Overlong)
        ));
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Line(l)) if l == "ok\n"
        ));
    }

    /// A final line without a trailing newline is EOF-terminated, not
    /// over-long -- it comes through like any other line.
    #[test]
    fn keeps_final_unterminated_line() {
        let mut cur = Cursor::new(b"tail".to_vec());
        let mut raw = Vec::new();
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Line(l)) if l == "tail"
        ));
    }

    /// A line longer than the cap that never gets a newline (EOF mid-line)
    /// is still over-long, and the stream is then at EOF.
    #[test]
    fn overlong_to_eof_is_overlong_then_eof() {
        let long = "x".repeat(100);
        let mut cur = Cursor::new(long.into_bytes());
        let mut raw = Vec::new();
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Overlong)
        ));
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Eof)
        ));
    }

    /// A line exactly at the cap that IS newline-terminated is a normal
    /// line -- the cap excludes the boundary false positive.
    #[test]
    fn cap_sized_terminated_line_is_normal() {
        let exact = "x".repeat(63); // 63 x's + '\n' = 64 = the cap
        let mut cur = Cursor::new(format!("{exact}\n").into_bytes());
        let mut raw = Vec::new();
        assert!(matches!(
            read_line_bounded(&mut cur, 64, &mut raw),
            Ok(LineRead::Line(l)) if l == format!("{exact}\n")
        ));
    }

    /// Invalid UTF-8 keeps the old `read_line` failure shape: an io error,
    /// so the reader loop's break-on-error path is unchanged.
    #[test]
    fn invalid_utf8_is_an_io_error() {
        let mut cur = Cursor::new(vec![0xff, 0xfe, b'\n']);
        let mut raw = Vec::new();
        let err = read_line_bounded(&mut cur, 64, &mut raw).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
}
