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

impl NdjsonIo {
    pub(super) fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        // The reader thread owns stdout; EOF drops tx so the pump's recv
        // returns Disconnected.
        let rx = super::process::spawn_line_reader(stdout);
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
