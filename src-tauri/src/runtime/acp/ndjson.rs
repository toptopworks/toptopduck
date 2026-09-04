//! The shared NDJSON stdio round-trip (issue #540).
//!
//! One implementation of the line-delimited JSON request/response loop every
//! ACP-family driver speaks: the shared line-capped stdout reader thread
//! ([`super::process::spawn_line_reader`]), a `recv_timeout` pump, the
//! request write, and response matching by id. The three call sites --
//! [`super::engine`]'s cancel-driven turn handshake, [`super::probe`]'s
//! deadline-driven handshake, and [`super::app_server`]'s deadline-driven
//! catalog query -- differ only in their abort condition and their error
//! type; both live at the thin per-site wrapper (a per-driver entry point
//! here plus a per-site mapping, issue #543).

use std::io::Write;
use std::process::{Child, ChildStdin, ChildStdout};
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
    /// `None` once a cancelled or panicked write detached its writer (the
    /// child was killed, so the channel is dead); every later write fails
    /// fast instead of blocking on a gone pipe.
    stdin: Option<ChildStdin>,
    rx: mpsc::Receiver<String>,
}

impl NdjsonIo {
    pub(super) fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        // Shared line-capped reader (see `spawn_line_reader`); EOF drops
        // the sender.
        let rx = super::process::spawn_line_reader(stdout);
        Self {
            stdin: Some(stdin),
            rx,
        }
    }

    /// Serialize + write one JSON message as a single NDJSON line. Flushes so
    /// the child receives it immediately (NDJSON is line-buffered).
    ///
    /// The bare write, for the structurally small payloads whose channel
    /// has no cancel-driven abort (the probe paths): a few hundred bytes
    /// can never fill the ~64-KiB OS pipe buffer, so the write cannot block
    /// on a fresh channel and the caller's own deadline guards the read.
    /// The turn path -- whose `session/prompt` carries the whole windowed
    /// context -- goes through [`Self::write_json_with_cancel`] instead.
    pub(super) fn write_json<T: serde::Serialize>(
        &mut self,
        msg: &T,
    ) -> Result<(), std::io::Error> {
        let mut s = serde_json::to_string(msg)?;
        s.push('\n');
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(std::io::Error::other("stdin writer detached after cancel"));
        };
        stdin.write_all(s.as_bytes())?;
        stdin.flush()
    }

    /// Serialize `msg` to one NDJSON line and take the stdin handle for the
    /// bounded writer -- the prelude both cancel-aware entry points below
    /// share. `Err` carries the technical detail (a serialization failure,
    /// or the detached-writer fail-fast) for the caller's own error
    /// mapping; the channel state is unchanged on this path.
    fn line_and_stdin<T: serde::Serialize>(
        &mut self,
        msg: &T,
    ) -> Result<(String, ChildStdin), String> {
        let mut s = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        s.push('\n');
        let stdin = self
            .stdin
            .take()
            .ok_or_else(|| "stdin writer detached after cancel".to_string())?;
        Ok((s, stdin))
    }

    /// Serialize + write one JSON message as a single NDJSON line through the
    /// cancel-aware bounded writer (issue #813): a child that stalls before
    /// draining stdin cannot wedge the turn's oversized `session/prompt` or
    /// the pump's mid-turn responses, and the handed-back stdin keeps the
    /// channel alive for the later writes the round-trip protocol needs.
    /// Settle shapes are the #808 `StdinWriteOutcome` set; precedence
    /// differs -- completion outranks a pending cancel, and `Cancelled`
    /// detaches the writer so every later write fails fast.
    pub(super) fn write_json_with_cancel<T: serde::Serialize>(
        &mut self,
        msg: &T,
        cancel: &CancelToken,
        child: &mut Child,
    ) -> super::process::StdinWriteOutcome {
        let (line, stdin) = match self.line_and_stdin(msg) {
            Ok(pair) => pair,
            Err(detail) => {
                return super::process::StdinWriteOutcome::Failed(std::io::Error::other(detail))
            }
        };
        let (outcome, stdin) = super::process::write_line_with_cancel(stdin, line, cancel, child);
        self.stdin = stdin;
        outcome
    }

    /// One receive step for multiplexing loops (the turn pump), which own
    /// their own line loop and share the reader channel (+ reader thread)
    /// via this and the writer via the cancel-aware bounded writes.
    pub(super) fn recv_timeout(&self, timeout: Duration) -> Result<String, mpsc::RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }

    /// Serialize + write the request, then pump incoming lines until its
    /// response arrives or the cancel token fires (the cancel-driven
    /// round-trip). `target` is the request id the response must carry (and
    /// no `method` field); a stray notification / unrelated message is
    /// dropped (not an error) so a chatty child cannot break the exchange.
    /// The write rides the cancel-aware bounded writer (issue #813), so a
    /// stalled child cannot wedge the turn before this loop's cancel check
    /// becomes reachable; a cancel during the write aborts exactly like the
    /// loop's own check would.
    pub(super) fn request_roundtrip_cancel<R: serde::de::DeserializeOwned>(
        &mut self,
        req: &impl serde::Serialize,
        target: &Value,
        cancel: &CancelToken,
        child: &mut Child,
    ) -> Result<R, RoundtripError<Cancelled>> {
        self.write_request_with_cancel(req, cancel, child)?;
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

    /// Serialize + write one request as a single NDJSON line + flush. The
    /// bare write, for the deadline-driven probe round-trips: their payloads
    /// are structurally small (a few hundred bytes, far under the pipe
    /// buffer), so the write cannot block on a fresh channel and the
    /// caller's deadline guards the read. Generic over the abort marker so
    /// the driver lifts the write failure into its own error type.
    fn write_request<A>(&mut self, req: &impl serde::Serialize) -> Result<(), RoundtripError<A>> {
        let mut msg =
            serde_json::to_string(req).map_err(|e| RoundtripError::Serialize(e.to_string()))?;
        msg.push('\n');
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(RoundtripError::Write(
                "stdin writer detached after cancel".into(),
            ));
        };
        stdin
            .write_all(msg.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|e| RoundtripError::Write(e.to_string()))
    }

    /// The cancel-driven round-trip's prelude write (issue #813): serialize,
    /// then ride the bounded writer with the child in hand so a stalled
    /// child cannot wedge the pre-loop write. The handed-back stdin keeps
    /// the channel alive for the response pump and later round-trips.
    fn write_request_with_cancel(
        &mut self,
        req: &impl serde::Serialize,
        cancel: &CancelToken,
        child: &mut Child,
    ) -> Result<(), RoundtripError<Cancelled>> {
        // Both prelude failures map to Write: `map_roundtrip_termination`
        // folds Serialize and Write onto the same Transient anyway.
        let (line, stdin) = self.line_and_stdin(req).map_err(RoundtripError::Write)?;
        let (outcome, stdin) = super::process::write_line_with_cancel(stdin, line, cancel, child);
        self.stdin = stdin;
        match outcome {
            super::process::StdinWriteOutcome::Done => Ok(()),
            super::process::StdinWriteOutcome::Failed(e) => {
                Err(RoundtripError::Write(e.to_string()))
            }
            // Same abort the loop below would have reported.
            super::process::StdinWriteOutcome::Cancelled => Err(RoundtripError::Abort(Cancelled)),
        }
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
