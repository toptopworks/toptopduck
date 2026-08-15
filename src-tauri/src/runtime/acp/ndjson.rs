//! The shared NDJSON stdio round-trip (issue #540).
//!
//! One implementation of the line-delimited JSON request/response loop every
//! ACP-family driver speaks: a stdout reader thread (a blocking `read_line`
//! would not notice abort conditions), a `recv_timeout` pump, the request
//! write, and response matching by id. The three call sites --
//! [`super::engine`]'s cancel-driven turn handshake, [`super::probe`]'s
//! deadline-driven handshake, and [`super::app_server`]'s deadline-driven
//! catalog query -- differ only in their abort condition ([`Abort`]) and
//! their error type; both live at the thin per-site wrapper.

use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdin, ChildStdout};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::cancel::CancelToken;

/// Why a round-trip pump stops waiting between receives. The two abort
/// conditions the drivers need: the turn engine polls a shared cancel token
/// (responsive user cancel; the wall-clock watchdog fires the same token),
/// while the probes are bounded by a wall-clock deadline.
pub(super) enum Abort<'a> {
    /// Abort as soon as the token fires; checked every
    /// [`super::process::PUMP_POLL_INTERVAL`].
    Cancel(&'a CancelToken),
    /// Abort once the wall-clock deadline passes; each receive waits only the
    /// remaining time.
    Deadline(Instant),
}

/// A round-trip failure, before the per-site wrapper maps it onto its own
/// error type. Each variant carries the technical detail verbatim; the
/// wrapper owns the message wording (the strings are frozen by the tests'
/// locale-free diagnostic fold).
pub(super) enum RoundtripError {
    /// The cancel token fired (cancel-driven round-trips only).
    Cancelled,
    /// The wall-clock deadline passed (deadline-driven round-trips only).
    Timeout,
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
        let (tx, rx) = mpsc::channel::<String>();
        // The reader thread owns stdout, reads line-by-line, and sends each
        // raw line. EOF drops tx so the pump's recv returns Disconnected.
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\n', '\r']);
                        if trimmed.is_empty() {
                            continue;
                        }
                        if tx.send(trimmed.to_string()).is_err() {
                            break; // pump gone
                        }
                    }
                    Err(_) => break,
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
    /// their own line loop and only share the channel + reader thread.
    pub(super) fn recv_timeout(&self, timeout: Duration) -> Result<String, mpsc::RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }

    /// Send a serialized request and pump incoming lines until its response
    /// arrives or the abort condition fires. `target` is the request id the
    /// response must carry (and no `method` field); a stray notification /
    /// unrelated message is dropped (not an error) so a chatty child cannot
    /// break the exchange.
    pub(super) fn request_roundtrip<R: serde::de::DeserializeOwned>(
        &mut self,
        req: &impl serde::Serialize,
        target: &Value,
        abort: Abort<'_>,
    ) -> Result<R, RoundtripError> {
        let mut msg =
            serde_json::to_string(req).map_err(|e| RoundtripError::Serialize(e.to_string()))?;
        msg.push('\n');
        self.stdin
            .write_all(msg.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| RoundtripError::Write(e.to_string()))?;
        loop {
            let timeout = match abort {
                Abort::Cancel(cancel) => {
                    if cancel.is_requested() {
                        return Err(RoundtripError::Cancelled);
                    }
                    super::process::PUMP_POLL_INTERVAL
                }
                Abort::Deadline(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err(RoundtripError::Timeout);
                    }
                    remaining
                }
            };
            match self.rx.recv_timeout(timeout) {
                Ok(line) => {
                    let v: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if v.get("id") == Some(target) && v.get("method").is_none() {
                        return serde_json::from_value(v)
                            .map_err(|e| RoundtripError::Parse(e.to_string()));
                    }
                }
                // A partial-wait Timeout re-derives the wait on the next
                // iteration: a cancel-driven pump re-checks the token, a
                // deadline-driven one re-checks the remaining time.
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(RoundtripError::Eof),
            }
        }
    }
}
