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
//! This file's sync faces are deliberately pure std. The bridge binary
//! must not link the app crate (ADR-0085: no app-crate linkage, so release
//! LTO dead-strips Tauri/DuckDB out of the per-turn-spawned process), so
//! this module lives in its own crate that both sides depend on -- the
//! async read face (issue #1454) is the one gated exception: it sits
//! behind the `async` feature, default-off, so a build that does not
//! enable it keeps the pure-std property.
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
//! the stateless [`read_line_bounded`] (a fresh line per call -- for callers
//! whose reads cannot time out), and [`BoundedLineReader`] (the partial line
//! stays with the reader, so a caller that retries on a read timeout resumes
//! the same line instead of re-framing from the stream's mid-line position).
//! Every face that reads under a timeout now goes through
//! [`BoundedLineReader`]: the serve loop past auth (issue #649) and the
//! gateway's pre-auth handshake (issue #909 -- a read timeout retries with
//! the termination flags re-checked at the loop top, resuming the partial
//! line); the stateless form serves only callers whose reads cannot time
//! out.
use std::io::{BufRead, Read};
#[cfg(feature = "async")]
use tokio::io::{AsyncBufReadExt, AsyncReadExt};

/// The byte cap on a single incoming line (issue #629): an untrusted
/// child cannot grow the reader's buffer past this; an over-long line is
/// drained and surfaced as [`LineRead::Overlong`] (the drop / fail /
/// refuse policy is the caller's). A compile-time constant on purpose: it
/// is a security invariant against untrusted output, not a user tunable --
/// raising it is an evidence-driven default change, not a config knob.
pub const LINE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// One step of [`read_line_bounded`].
#[derive(Debug)]
pub enum LineRead {
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
pub fn read_line_bounded(reader: &mut impl BufRead, max: usize) -> std::io::Result<LineRead> {
    BoundedLineReader::new(reader).read_line_bounded(max)
}

/// The resumable form of [`read_line_bounded`] (issue #649): the partial
/// line stays with the reader across calls, so a caller that retries after
/// a read timeout (`TimedOut` / `WouldBlock`) resumes the same line at the
/// stream's current position instead of re-framing the tail as a new line.
pub struct BoundedLineReader<R> {
    reader: R,
    partial: Vec<u8>,
}

impl<R> BoundedLineReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            partial: Vec::new(),
        }
    }
}

impl<R: BufRead> BoundedLineReader<R> {
    /// Read one line under the same cap + disposition contract as
    /// [`read_line_bounded`]. An error return (a read timeout included)
    /// leaves the partial line buffered; call again to resume it. The cap
    /// bounds the accumulated line, not each call's read: a retry under a
    /// smaller cap than the bytes already buffered fails the line as
    /// over-long rather than emitting a line past the cap.
    pub fn read_line_bounded(&mut self, max: usize) -> std::io::Result<LineRead> {
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
        // limit). `>=` rather than `==` also routes a retry under a smaller
        // cap here -- unreachable under the fixed cap every real caller
        // passes, but the fall-through would otherwise emit an over-cap
        // line. (A short line without a newline is the final line before
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
        if self.partial.len() >= max && !self.partial.ends_with(b"\n") {
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

// The async read face (issue #1454, ADR-0139): the same line-boundary and
// cap contract as the sync faces above, driven by tokio's `AsyncBufRead`.
// Everything here lives behind the `async` feature so a build that does
// not enable it -- the ACP bridge's, per ADR-0085 -- stays pure std.
//
// The method bodies mirror the sync method's statement for statement --
// the same `take(..).read_until(..)` primitive, awaited; the equivalence
// tests pin the two in lockstep, so a semantic change must land on both
// or the pins break.

/// The async twin of [`read_line_bounded`]: a fresh line per call, for
/// callers whose reads cannot be cancelled mid-line (issue #1454).
#[cfg(feature = "async")]
pub async fn read_line_bounded_async(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    max: usize,
) -> std::io::Result<LineRead> {
    BoundedLineReader::new(&mut *reader)
        .read_line_bounded_async(max)
        .await
}

#[cfg(feature = "async")]
impl<R: tokio::io::AsyncBufRead + Unpin> BoundedLineReader<R> {
    /// The resumable async twin of [`BoundedLineReader::read_line_bounded`]
    /// (issue #1454): identical line-boundary, cap, drain, and error
    /// semantics. The partial line lives in the reader, not the future, so
    /// a dropped call (a `select!` deadline firing mid-line) resumes the
    /// same line on the next call -- the async carry of the #649 resume
    /// contract, which is what a deadline-driven transport slice needs.
    pub async fn read_line_bounded_async(&mut self, max: usize) -> std::io::Result<LineRead> {
        // This method mirrors the sync `read_line_bounded` above; the
        // comments there carry the reasoning, the equivalence tests carry
        // the proof.
        if max == 0 {
            return Ok(LineRead::Eof);
        }
        let remaining = max.saturating_sub(self.partial.len());
        AsyncReadExt::take(&mut self.reader, remaining as u64)
            .read_until(b'\n', &mut self.partial)
            .await?;

        if self.partial.len() >= max && !self.partial.ends_with(b"\n") {
            let mut scratch = Vec::new();
            loop {
                scratch.clear();
                AsyncReadExt::take(&mut self.reader, max as u64)
                    .read_until(b'\n', &mut scratch)
                    .await?;
                if scratch.is_empty() || scratch.ends_with(b"\n") {
                    self.partial.clear();
                    return Ok(LineRead::Overlong);
                }
            }
        }

        if self.partial.ends_with(b"\n") {
            return Ok(LineRead::Line(take_utf8_line(&mut self.partial)?));
        }
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

    /// A timeout before any byte of a line is pending still propagates as an
    /// error -- a shape the stateless reader shares, so this pin is the
    /// error-propagation contract, not the resume itself (an implementation
    /// swallowing it into `Ok(Eof)` would make the serve loop treat a live
    /// bridge as closed); the next call reads the line normally.
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

    /// A retry under a smaller cap than the bytes already buffered fails the
    /// line as over-long rather than emitting an over-cap `Line` -- the `>=`
    /// guard making the cap contract hold even for a caller that varies the
    /// cap (no real caller does; every entry point passes one fixed cap).
    #[test]
    fn resumable_reader_smaller_cap_on_retry_fails_overlong() {
        let mut r = BoundedLineReader::new(Scripted::new(vec![
            Step::Bytes(b"12345".to_vec()),
            Step::Fail(std::io::ErrorKind::TimedOut),
            Step::Bytes(b"678\n".to_vec()),
            Step::Bytes(b"next\n".to_vec()),
        ]));
        assert_eq!(
            r.read_line_bounded(8).unwrap_err().kind(),
            std::io::ErrorKind::TimedOut
        );
        // Retry under a smaller cap: the 5 buffered bytes already pass it,
        // so the line fails as over-long and the drain eats "678\n".
        assert!(matches!(r.read_line_bounded(4), Ok(LineRead::Overlong)));
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

    // --- The async read face (issue #1454) --------------------------------

    /// Same-input-same-output equivalence against the sync face: the async
    /// face's correctness contract is *identity* with the sync reader, so
    /// every script runs through BOTH readers and the outcome sequences
    /// must match exactly (the sync side's own pins above stay the
    /// semantic reference).
    #[cfg(feature = "async")]
    mod async_face {
        use super::*;
        use std::future::Future;
        use std::pin::Pin;
        use std::task::{Context, Poll};
        use tokio::io::AsyncBufRead;

        /// One call's outcome, errors flattened to their kind -- the
        /// comparison key of the equivalence pin.
        #[derive(Debug, PartialEq)]
        enum Outcome {
            Line(String),
            Overlong,
            Eof,
            Err(std::io::ErrorKind),
        }

        impl From<std::io::Result<LineRead>> for Outcome {
            fn from(res: std::io::Result<LineRead>) -> Self {
                match res {
                    Ok(LineRead::Line(l)) => Outcome::Line(l),
                    Ok(LineRead::Overlong) => Outcome::Overlong,
                    Ok(LineRead::Eof) => Outcome::Eof,
                    Err(e) => Outcome::Err(e.kind()),
                }
            }
        }

        /// The async mirror of [`Step`], plus the one shape sync cannot
        /// express: a park. [`AsyncStep::Pending`] reports Pending once
        /// (the waker is never fired -- the drop-resume test drives the
        /// poll manually), then the script advances.
        enum AsyncStep {
            Bytes(Vec<u8>),
            Fail(std::io::ErrorKind),
            Pending,
        }

        impl From<Step> for AsyncStep {
            fn from(step: Step) -> Self {
                match step {
                    Step::Bytes(b) => AsyncStep::Bytes(b),
                    Step::Fail(kind) => AsyncStep::Fail(kind),
                }
            }
        }

        /// The async mirror of [`Scripted`]: the same step script with no
        /// park, so equivalence runs stay deterministic.
        struct AsyncScripted {
            steps: Vec<AsyncStep>,
            pos: usize,
        }

        impl AsyncScripted {
            fn new(steps: Vec<AsyncStep>) -> Self {
                Self { steps, pos: 0 }
            }

            /// A script from shared sync-shape steps -- the equivalence
            /// harness feeds both readers the same script.
            fn from_steps(steps: Vec<Step>) -> Self {
                Self::new(steps.into_iter().map(AsyncStep::from).collect())
            }
        }

        impl tokio::io::AsyncRead for AsyncScripted {
            fn poll_read(
                self: Pin<&mut Self>,
                cx: &mut Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> Poll<std::io::Result<()>> {
                let mut this = self;
                match this.as_mut().poll_fill_buf(cx) {
                    Poll::Ready(Ok(bytes)) => {
                        let n = bytes.len().min(buf.remaining());
                        buf.put_slice(&bytes[..n]);
                        this.consume(n);
                        Poll::Ready(Ok(()))
                    }
                    Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
                    Poll::Pending => Poll::Pending,
                }
            }
        }

        impl AsyncBufRead for AsyncScripted {
            fn poll_fill_buf(
                self: Pin<&mut Self>,
                _cx: &mut Context<'_>,
            ) -> Poll<std::io::Result<&[u8]>> {
                let this = self.get_mut();
                loop {
                    match this.steps.get(this.pos) {
                        None => return Poll::Ready(Ok(&[])),
                        Some(AsyncStep::Fail(kind)) => {
                            let err = std::io::Error::new(*kind, "scripted failure");
                            this.pos += 1;
                            return Poll::Ready(Err(err));
                        }
                        Some(AsyncStep::Pending) => {
                            this.pos += 1;
                            return Poll::Pending;
                        }
                        Some(AsyncStep::Bytes(b)) if b.is_empty() => this.pos += 1,
                        Some(AsyncStep::Bytes(b)) => return Poll::Ready(Ok(b)),
                    }
                }
            }

            fn consume(self: Pin<&mut Self>, n: usize) {
                let this = self.get_mut();
                if let Some(AsyncStep::Bytes(b)) = this.steps.get_mut(this.pos) {
                    let n = n.min(b.len());
                    b.drain(..n);
                }
            }
        }

        /// One corpus entry: a name, a fresh-script factory, and the
        /// per-call caps (a script per call lets the retry-under-smaller-cap
        /// pin run through the same harness).
        type ScriptCase = (&'static str, fn() -> Vec<Step>, Vec<usize>);

        /// The corpus: one entry per semantic pin the sync suite carries,
        /// plus a byte-at-a-time delivery script (the async face's own
        /// accumulation path). The factories are non-capturing so both
        /// readers get an identical fresh script.
        fn corpus() -> Vec<ScriptCase> {
            vec![
                (
                    "normal lines",
                    || vec![Step::Bytes(b"one\ntwo\n".to_vec())],
                    vec![64, 64, 64],
                ),
                (
                    "overlong then next",
                    || {
                        vec![Step::Bytes(
                            format!("{}\nok\n", "x".repeat(100)).into_bytes(),
                        )]
                    },
                    vec![64, 64, 64],
                ),
                (
                    "exact-cap terminated line",
                    || vec![Step::Bytes(format!("{}\n", "x".repeat(63)).into_bytes())],
                    vec![64],
                ),
                (
                    "exact-max payload drops overlong",
                    || {
                        vec![Step::Bytes(
                            format!("{}\nok\n", "x".repeat(64)).into_bytes(),
                        )]
                    },
                    vec![64, 64],
                ),
                (
                    "overlong to EOF",
                    || vec![Step::Bytes("x".repeat(100).into_bytes())],
                    vec![64, 64],
                ),
                (
                    "final unterminated line",
                    || vec![Step::Bytes(b"tail".to_vec())],
                    vec![64],
                ),
                (
                    "invalid UTF-8",
                    || vec![Step::Bytes(vec![0xff, 0xfe, b'\n'])],
                    vec![64],
                ),
                (
                    "read error propagates",
                    || {
                        vec![
                            Step::Fail(std::io::ErrorKind::Other),
                            Step::Bytes(b"x\n".to_vec()),
                        ]
                    },
                    vec![64, 64, 64],
                ),
                (
                    "timeout mid line resumes (#649)",
                    || {
                        vec![
                            Step::Bytes(b"{\"json".to_vec()),
                            Step::Fail(std::io::ErrorKind::TimedOut),
                            Step::Bytes(b"rpc\":\"2.0\"}\n".to_vec()),
                        ]
                    },
                    vec![64, 64],
                ),
                (
                    "budget shrinks across retries (#649)",
                    || {
                        vec![
                            Step::Bytes(b"12345".to_vec()),
                            Step::Fail(std::io::ErrorKind::TimedOut),
                            Step::Bytes(b"67890\n".to_vec()),
                            Step::Bytes(b"next\n".to_vec()),
                        ]
                    },
                    vec![8, 8, 8],
                ),
                (
                    "smaller cap on retry fails overlong",
                    || {
                        vec![
                            Step::Bytes(b"12345".to_vec()),
                            Step::Fail(std::io::ErrorKind::TimedOut),
                            Step::Bytes(b"678\n".to_vec()),
                            Step::Bytes(b"next\n".to_vec()),
                        ]
                    },
                    vec![8, 4, 8],
                ),
                (
                    "drain reentry after timeout",
                    || {
                        vec![
                            Step::Bytes(b"12345678".to_vec()),
                            Step::Fail(std::io::ErrorKind::TimedOut),
                            Step::Bytes(b"tail\n".to_vec()),
                        ]
                    },
                    vec![8, 8, 8],
                ),
                (
                    "final unterminated after timeout",
                    || {
                        vec![
                            Step::Bytes(b"tail".to_vec()),
                            Step::Fail(std::io::ErrorKind::TimedOut),
                        ]
                    },
                    vec![64, 64],
                ),
                (
                    "byte-at-a-time delivery",
                    || {
                        b"hello\nxxx\n"
                            .iter()
                            .map(|&b| Step::Bytes(vec![b]))
                            .collect()
                    },
                    vec![64, 64, 64],
                ),
            ]
        }

        fn run_sync(script: fn() -> Vec<Step>, caps: &[usize]) -> Vec<Outcome> {
            let mut r = BoundedLineReader::new(Scripted::new(script()));
            caps.iter()
                .map(|&cap| r.read_line_bounded(cap).into())
                .collect()
        }

        async fn run_async(script: fn() -> Vec<Step>, caps: &[usize]) -> Vec<Outcome> {
            let mut r = BoundedLineReader::new(AsyncScripted::from_steps(script()));
            let mut out = Vec::new();
            for &cap in caps {
                out.push(r.read_line_bounded_async(cap).await.into());
            }
            out
        }

        #[tokio::test]
        async fn async_face_matches_sync_face_script_for_script() {
            for (name, script, caps) in corpus() {
                assert_eq!(
                    run_sync(script, &caps),
                    run_async(script, &caps).await,
                    "async face diverged from sync on: {name}"
                );
            }
        }

        /// The stateless form is a fresh-reader-per-call wrapper, exactly
        /// like its sync twin; one direct pin, the resumable corpus above
        /// carries the semantics.
        #[tokio::test]
        async fn stateless_form_reads_lines_and_caps() {
            let mut r = AsyncScripted::from_steps(vec![Step::Bytes(
                format!("{}\nok\n", "x".repeat(64)).into_bytes(),
            )]);
            assert!(matches!(
                read_line_bounded_async(&mut r, 64).await,
                Ok(LineRead::Overlong)
            ));
            assert!(matches!(
                read_line_bounded_async(&mut r, 64).await,
                Ok(LineRead::Line(l)) if l == "ok\n"
            ));
            assert!(matches!(
                read_line_bounded_async(&mut r, 64).await,
                Ok(LineRead::Eof)
            ));
        }

        /// The async-specific resume hazard (issue #1454, the #649
        /// contract's carry): a call dropped while parked mid-line -- what
        /// a `select!` deadline does to the read future -- must not lose
        /// the partial line. The next call resumes and completes the SAME
        /// line instead of re-framing from the stream's mid-line position.
        #[tokio::test]
        async fn dropped_call_mid_line_resumes_the_same_line() {
            let mut r = BoundedLineReader::new(AsyncScripted::new(vec![
                AsyncStep::Bytes(b"{\"json".to_vec()),
                AsyncStep::Pending,
                AsyncStep::Bytes(b"rpc\":\"2.0\"}\n".to_vec()),
            ]));
            // Drive the call to its park -- the first chunk lands in the
            // partial line, the second fill_buf parks on Pending -- then
            // cancel it: the inner block's end drops the future, the
            // stand-in for a `select!` deadline firing mid-line.
            {
                let mut fut = std::pin::pin!(r.read_line_bounded_async(64));
                let waker = std::task::Waker::noop();
                let mut cx = Context::from_waker(waker);
                match fut.as_mut().poll(&mut cx) {
                    Poll::Pending => {}
                    _ => panic!("expected the read to park on the Pending step mid-line"),
                }
            }
            assert!(matches!(
                r.read_line_bounded_async(64).await,
                Ok(LineRead::Line(l)) if l == "{\"jsonrpc\":\"2.0\"}\n"
            ));
        }
    }
}
