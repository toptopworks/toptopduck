//! Shared process-management helpers for the adapter engines + probe.
//!
//! Two spawn shapes live here: [`spawn_piped`] serves [`super::engine`] (the
//! ACP turn path), [`super::probe`], and [`super::app_server`];
//! [`spawn_turn`] serves the cwd-aware non-ACP TURN drivers
//! ([`super::codex_event_stream`] + [`super::claude_stream_json`], the
//! ADR-0097 Decision 1 aligned-feed surface). Both families then kill +
//! reap the child under the same bounded deadline: extracting the spawn
//! shapes, the constants, and the kill-reap logic here prevents drift -- a
//! change to either lands in one place, not several.
//!
//! The stdout reader thread is shared here too (issues #629/#639/#640): every
//! adapter surface's reader -- the NDJSON channel and both native stream
//! drivers -- is the same line-capped, bounded-channel loop, so it lives once.

use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Pump poll interval: how long the pump blocks on the stdout-reader channel
/// between cancel / step-cap checks. Short enough that a cancel surfaces in
/// well under a second; long enough that an idle turn costs near-zero CPU.
pub(super) const PUMP_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Upper bound on reaping the CLI child after `Child::kill`. `Child::wait`
/// blocks until the child is reaped; on Linux the stdio bridge (spawned by the
/// agent as its MCP server) inherits the agent's stdout write-end, so the
/// engine's reader pipe does not EOF and the inherited-stderr chain can keep
/// the process tree alive long enough to wedge `wait` past the wall-clock
/// watchdog. Poll `try_wait` under this grace instead: on POSIX the kill is
/// delivered immediately (SIGKILL) so the agent is normally reaped on the first
/// poll, and a wedged reap cannot hang the turn — on POSIX the resulting
/// transient zombie is reaped by init at parent exit; on Windows there is no
/// zombie concept and the handle is closed on `Child` drop. Either way the
/// bounded poll keeps the turn moving.
pub(super) const KILL_REAP_DEADLINE: Duration = Duration::from_secs(2);

/// Poll interval for the bounded reap. Short enough that the turn reclaims the
/// agent promptly when SIGKILL lands; [`KILL_REAP_DEADLINE`] is the real cap.
const KILL_REAP_POLL: Duration = Duration::from_millis(10);

/// The single spawn shape every ACP-family CLI lifecycle goes through:
/// `binary` with `argv`, piped stdin/stdout, and the caller-chosen stderr
/// wiring (issue #542): the turn engine keeps stderr inherited (the CLI's own
/// chatter goes to the parent's terminal), while the probe paths pipe it so
/// the diagnostic tail can be captured into the failure detail. The turn
/// engine and both probe paths spawn through here (issue #540) -- a change to
/// the spawn shape (env, cwd, stdio wiring) lands in one place, not three.
/// The non-ACP turn drivers use [`spawn_turn`] instead: their surface
/// differs (selection + injection argv flags + `current_dir`). The caller
/// keeps the error wording (the turn path and the probe path name the
/// failing adapter / CLI differently).
pub(super) fn spawn_piped(binary: &Path, argv: &[&str], stderr: Stdio) -> std::io::Result<Child> {
    Command::new(binary)
        .args(argv)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .spawn()
}

/// The cwd-aware spawn shape the non-ACP TURN drivers share (codex native
/// exec + claude-code headless -- ADR-0097 Decision 1's aligned feed made
/// this a two-caller surface): the spec argv first, then the selection
/// flags (the ADR-0095/0097 model/effort argv injection), then the format's
/// injection flags (codex `-c` config overrides / claude `--mcp-config` +
/// `--strict-mcp-config`), piped stdin/stdout, inherited stderr (the CLI's
/// chatter goes to the parent's terminal, the turn-engine precedent), and
/// the working directory set to `cwd` when non-empty so any CLI file
/// context stays within the session's temp. The caller keeps the error
/// wording (each driver names its own CLI).
pub(super) fn spawn_turn(
    binary: &Path,
    spec_argv: &[&str],
    selection_flags: &[String],
    injection_flags: &[String],
    cwd: &str,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(binary);
    cmd.args(spec_argv);
    cmd.args(selection_flags);
    cmd.args(injection_flags);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());
    if !cwd.is_empty() {
        cmd.current_dir(cwd);
    }
    cmd.spawn()
}

/// Kill the child (`SIGKILL` on POSIX, `TerminateProcess` on Windows) and reap
/// it under a bounded poll. Best-effort: if the child is not reaped within
/// [`KILL_REAP_DEADLINE`] the function returns anyway — the child becomes a
/// transient zombie (POSIX, reaped by init at process exit) or an unclosed
/// handle (Windows, closed on `Child` drop). The turn always moves on.
pub(super) fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + KILL_REAP_DEADLINE;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => std::thread::sleep(KILL_REAP_POLL),
        }
    }
}

// ---------------------------------------------------------------------------
// Stdout reader thread (shared, line-capped)
// ---------------------------------------------------------------------------

/// The byte cap on a single incoming line (issue #629): an untrusted
/// child cannot grow the reader's buffer past this; an over-long line is
/// drained and dropped with a warning (the connection stays up -- the next
/// line still arrives).
const LINE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// The bounded reader-to-pump channel's capacity (issue #640). The reader
/// blocks on send once the queue is full, which stops its reads, which
/// fills the child's stdout pipe, which blocks the child's writes: runaway
/// output is throttled at the source instead of growing an unbounded queue
/// over the turn's lifetime. Worst-case residency: capacity times
/// [`LINE_MAX_BYTES`] = 32 MiB. No message is ever dropped.
const READER_CHANNEL_CAPACITY: usize = 8;

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

/// Read one line, buffering at most `max` bytes of it (issue #629). The
/// scratch buffer is function-local: the over-long drain pass reuses it
/// within one call, and the accepted line is moved out of it for the
/// UTF-8 conversion.
fn read_line_bounded(reader: &mut impl BufRead, max: usize) -> std::io::Result<LineRead> {
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

/// One enqueue step of the reader loop (issue #640): `try_send` while the
/// queue has room (zero cost on the fast path); on `Full`, warn once per
/// reader lifetime (`warned` is that debounce) and block in `send` until
/// the pump drains -- the queue-full backpressure that throttles a runaway
/// child at the source. `false` means the receiver is gone: the caller
/// exits the loop (the existing EOF-style break).
fn enqueue_bounded(tx: &mpsc::SyncSender<String>, line: String, warned: &mut bool) -> bool {
    match tx.try_send(line) {
        Ok(()) => true,
        Err(mpsc::TrySendError::Full(line)) => {
            if !*warned {
                *warned = true;
                log::warn!(
                    target: "toptopduck::acp",
                    "stdout reader queue full (capacity {READER_CHANNEL_CAPACITY}); \
                     blocking until the pump drains -- the child is backpressured \
                     at the source"
                );
            }
            tx.send(line).is_ok()
        }
        Err(mpsc::TrySendError::Disconnected(_)) => false,
    }
}

/// Spawn the stdout reader thread every adapter surface shares (issues
/// #540/#639/#640): owns `stdout` and forwards each non-empty trimmed line
/// over the returned bounded channel ([`READER_CHANNEL_CAPACITY`] slots);
/// EOF or a read error drops the sender so the pump's recv returns
/// Disconnected -- every caller treats that as the child dying. Reading on
/// its own thread is what lets the pump check cancel / step-cap between
/// reads; each line is capped at [`LINE_MAX_BYTES`] (an over-long line is
/// drained and dropped with a warning, never silently), and the queue-full
/// backpressure ([`enqueue_bounded`]) throttles a runaway child at the
/// source without dropping a single line.
pub(super) fn spawn_line_reader(stdout: ChildStdout) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::sync_channel::<String>(READER_CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        // The debounce behind enqueue_bounded's one queue-full warning.
        let mut backlog_warned = false;
        loop {
            match read_line_bounded(&mut reader, LINE_MAX_BYTES) {
                Ok(LineRead::Line(line)) => {
                    let trimmed = line.trim_end_matches(['\n', '\r']);
                    if trimmed.is_empty() {
                        continue;
                    }
                    if !enqueue_bounded(&tx, trimmed.to_string(), &mut backlog_warned) {
                        break; // pump gone
                    }
                }
                Ok(LineRead::Overlong) => {
                    log::warn!(
                        target: "toptopduck::acp",
                        "line exceeded {LINE_MAX_BYTES} bytes, dropped"
                    );
                }
                Ok(LineRead::Eof) => break, // EOF
                // Unrecoverable (the channel closes either way); log it so
                // "why did the turn end / why EOF" has an answer (issue
                // #543's answerable-in-logs stance). Warn, not debug:
                // release builds filter at Info, and the packaged app's
                // absent console is exactly where this diagnosis matters.
                Err(e) => {
                    log::warn!(target: "toptopduck::acp", "stdout reader failed: {e}");
                    break;
                }
            }
        }
    });
    rx
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

    /// Invalid UTF-8 keeps the old `read_line` failure shape: an io error,
    /// so the reader loop's break-on-error path is unchanged.
    #[test]
    fn invalid_utf8_is_an_io_error() {
        let mut cur = Cursor::new(vec![0xff, 0xfe, b'\n']);
        let err = read_line_bounded(&mut cur, 64).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    /// Issue #640: once the queue is at capacity with no consumer, the next
    /// enqueue warns once and BLOCKS -- no drop, no spin. Draining releases
    /// it, and every line arrives in order (backpressure, not loss).
    #[test]
    fn enqueue_blocks_when_full_and_resumes_after_drain() {
        let (tx, rx) = mpsc::sync_channel::<String>(READER_CHANNEL_CAPACITY);
        let mut warned = false;
        // Fill every slot with no consumer: try_send keeps winning (no
        // warning) while the queue has room.
        for i in 0..READER_CHANNEL_CAPACITY {
            assert!(
                enqueue_bounded(&tx, format!("line-{i}"), &mut warned),
                "below capacity the fast path enqueues"
            );
            assert!(!warned, "below capacity no warning fires");
        }
        // The capacity+1 enqueue hits Full on its own thread (a broken
        // implementation would drop the line or return without blocking):
        // warn once, then block in send until the main thread drains.
        let writer = std::thread::spawn(move || {
            let mut warned = false;
            let delivered = enqueue_bounded(&tx, "blocked-line".to_string(), &mut warned);
            (delivered, warned)
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            !writer.is_finished(),
            "queue full + no consumer: the writer must be blocked, not done"
        );
        // Drain releases it; FIFO order survives (no loss, no reorder).
        for i in 0..READER_CHANNEL_CAPACITY {
            assert_eq!(rx.recv().unwrap(), format!("line-{i}"));
        }
        assert_eq!(rx.recv().unwrap(), "blocked-line");
        let (delivered, warned) = writer.join().unwrap();
        assert!(delivered, "after the drain the blocked send completes");
        assert!(
            warned,
            "the queue-full episode entered the Full arm (the debounce flag set)"
        );
    }

    /// Issue #640: a gone receiver exits the reader on both paths -- the
    /// fast path's `try_send` Disconnected, and (the drain-after-cancel
    /// shape) a Full queue whose blocking `send` then finds the receiver
    /// dropped: Err, never a hang or panic. std's `try_send` reports
    /// Disconnected ahead of Full, so the second half must put the writer
    /// inside the blocking `send` before the receiver drops -- a
    /// pre-arranged drop would silently take the fast path again.
    #[test]
    fn enqueue_exits_when_the_pump_is_gone() {
        let (tx, rx) = mpsc::sync_channel::<String>(READER_CHANNEL_CAPACITY);
        drop(rx);
        let mut warned = false;
        assert!(
            !enqueue_bounded(&tx, "gone".to_string(), &mut warned),
            "try_send on a disconnected receiver -> reader exit"
        );
        // The queue holds a line; the writer enters the Full arm and blocks
        // in `send`, and the pump then drops its end mid-backpressure.
        let (tx, rx) = mpsc::sync_channel::<String>(1);
        assert!(enqueue_bounded(&tx, "queued".to_string(), &mut warned));
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let writer = std::thread::spawn(move || {
            let mut warned = false;
            let _ = started_tx.send(());
            let delivered = enqueue_bounded(&tx, "next".to_string(), &mut warned);
            (delivered, warned)
        });
        // The signal only says the writer is about to enqueue; the grace
        // sleep lets the try_send -> Full -> warn -> blocking-send sequence
        // run before the receiver goes away.
        started_rx.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        drop(rx);
        let (delivered, warned) = writer.join().unwrap();
        assert!(
            !delivered,
            "blocking send on a gone receiver -> reader exit"
        );
        assert!(warned, "the Full arm fired before the disconnect");
    }

    /// Issue #640: the documented worst-case queue residency is a
    /// cross-constant invariant -- capacity x [`LINE_MAX_BYTES`] = 32 MiB.
    /// The pin trips CI when either constant drifts without the memory
    /// budget being revisited.
    #[test]
    fn reader_channel_residency_matches_the_documented_budget() {
        assert_eq!(
            READER_CHANNEL_CAPACITY * LINE_MAX_BYTES,
            32 * 1024 * 1024,
            "worst-case reader queue residency must match the documented budget"
        );
    }
}
