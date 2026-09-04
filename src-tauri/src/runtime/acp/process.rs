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
//! The stdin writers are shared here too (issues #808/#813): the native
//! stream drivers feed the flattened prompt through the one-shot cancel-aware
//! write (EOF on completion), and the ACP channel's NDJSON lines ride the
//! same doctrine with the stdin handle handed back (the channel lives for
//! the whole turn) -- so a CLI that stalls before draining stdin cannot
//! wedge the turn before the pump loop's cancel check becomes reachable.
//!
//! The stdout reader thread is shared here too (issues #629/#639/#640): every
//! adapter surface's reader -- the NDJSON channel and both native stream
//! drivers -- is the same line-capped, bounded-channel loop, so it lives once.
//! The bounded line reader itself lives in [`crate::bounded_line`] (issue
//! #643): the gateway framing and the bridge handshake read untrusted peer
//! output through the same cap, so the primitive is cross-domain.

use std::io::{BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Pump poll interval: how long the pump blocks on the stdout-reader channel
/// between cancel / step-cap checks (and, since issue #808, how long the
/// stdin prompt writer waits between cancel checks). Short enough that a
/// cancel surfaces in well under a second; long enough that an idle turn
/// costs near-zero CPU.
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
// Stdin writers (cancel-aware, issues #808/#813)
// ---------------------------------------------------------------------------

/// Outcome of feeding a line of stdin to a turn child. Whether the stdin
/// handle was consumed (the one-shot writer drops it for EOF) or handed back
/// to the caller (the NDJSON channel keeps it alive for later writes) is the
/// writer's contract, not the outcome's.
pub(super) enum StdinWriteOutcome {
    /// Fully written + flushed; the turn proceeds.
    Done,
    /// The write failed; the child is already killed and reaped (a bounded,
    /// best-effort reap per [`kill_and_reap`]), and the OS error rides
    /// along for the caller's `Transient` message.
    Failed(std::io::Error),
    /// Cancel landed mid-write; the child was killed (which breaks the pipe
    /// and unblocks the writer) and reaped (bounded, best-effort).
    Cancelled,
}

/// Join the stdin writer thread under [`KILL_REAP_DEADLINE`] after the child
/// was killed -- which normally unblocks its blocked write -- and detach with
/// a warning instead of hanging the turn when the write still does not return
/// (a grandchild inherited the pipe's read end, the resident-child class
/// ADR-0108 anticipates). A bounded wait replaces an unbounded one, never a
/// hung turn (`wait_bounded`'s doctrine, issue #808).
fn join_writer_bounded_or_detach<T>(writer: std::thread::JoinHandle<T>) {
    let deadline = Instant::now() + KILL_REAP_DEADLINE;
    while !writer.is_finished() && Instant::now() < deadline {
        std::thread::sleep(KILL_REAP_POLL);
    }
    if writer.is_finished() {
        // The joined value (a completed write's result, and the handed-back
        // stdin) drops here: every caller is on the cancel path, where the
        // child is already dead and the channel with it.
        let _ = writer.join();
    } else {
        // Detached, like the reader thread: the writer owns only the line
        // String and the stdin handle, both bounded (the handle drops with
        // the JoinHandle at return).
        log::warn!(
            target: "toptopduck::acp",
            "stdin writer unjoinable after cancel (a grandchild holds the pipe?); detaching"
        );
    }
}

/// Write `prompt` + a trailing newline to the child's stdin on a dedicated
/// writer thread while polling cancel at the pump's cadence.
///
/// The prompt is the schema + skills + history flattening and can exceed the
/// OS pipe buffer (~64 KiB on Windows); a CLI that stalls before draining
/// stdin (e.g. wedged in its own MCP init) then blocks the unbounded
/// `write_all` forever -- and both stream drivers used to run that write
/// BEFORE the pump loop's cancel check was reachable, so a cancel could not
/// settle the turn. Killing the child closes the pipe's read end, the
/// blocked write returns, and the writer joins: the turn settles as
/// Cancelled instead of hanging. The write itself keeps the drivers'
/// original shape (`write_all` + newline + explicit EOF drop), so a CLI that
/// does drain stdin sees no change on the wire (the cost of the watch is up
/// to one poll interval of added latency before `Done` is detected).
pub(super) fn write_prompt_with_cancel(
    stdin: ChildStdin,
    prompt: String,
    cancel: &crate::cancel::CancelToken,
    child: &mut Child,
) -> StdinWriteOutcome {
    let writer = std::thread::spawn(move || {
        let mut stdin = stdin;
        let result = stdin
            .write_all(prompt.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"));
        drop(stdin); // EOF signal (the drivers' original explicit drop)
        result
    });
    loop {
        if cancel.is_requested() {
            kill_and_reap(child);
            join_writer_bounded_or_detach(writer);
            return StdinWriteOutcome::Cancelled;
        }
        if writer.is_finished() {
            return match writer.join() {
                Ok(Ok(())) => StdinWriteOutcome::Done,
                // The CLI died mid-write: the drivers' original
                // reap-then-Transient shape.
                Ok(Err(e)) => {
                    log::warn!(target: "toptopduck::acp", "stdin prompt write failed: {e}");
                    kill_and_reap(child);
                    StdinWriteOutcome::Failed(e)
                }
                Err(_) => {
                    kill_and_reap(child);
                    StdinWriteOutcome::Failed(std::io::Error::other("stdin writer thread panicked"))
                }
            };
        }
        std::thread::sleep(PUMP_POLL_INTERVAL);
    }
}

/// Write one pre-serialized NDJSON line to the child's stdin on a dedicated
/// writer thread while polling cancel at the pump's cadence (issue #813).
///
/// The ACP-channel sibling of [`write_prompt_with_cancel`] for the
/// long-lived stdin the NDJSON round-trips keep using after this write: on
/// `Done`/`Failed` the stdin handle is handed back to the caller (the
/// handshake, `session/prompt`, and the pump's mid-turn writes all ride the
/// same pipe), where the one-shot writers close it for EOF. Only the cancel
/// path may lose the handle -- the child is dead there, so the channel is
/// dead by construction and the caller never writes again. Unlike the
/// one-shot writer, completion outranks a pending cancel (the completion
/// channel is checked first): the line may be exactly the `session/cancel`
/// notification whose cooperative response the pump means to drain, and a
/// completed write must not be killed out from under it. The completion
/// channel also means a fast write costs no poll-interval latency -- the
/// turn path writes several lines per turn, where the one-shot writer's
/// up-to-one-interval cost was once per turn.
pub(super) fn write_line_with_cancel(
    stdin: ChildStdin,
    line: String,
    cancel: &crate::cancel::CancelToken,
    child: &mut Child,
) -> (StdinWriteOutcome, Option<ChildStdin>) {
    // The write's completion signal: the watch loop wakes the moment the
    // write finishes instead of at the next poll tick.
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let writer = std::thread::spawn(move || {
        let mut stdin = stdin;
        let result = stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.flush());
        let _ = done_tx.send(());
        (result, stdin)
    });
    loop {
        match done_rx.recv_timeout(PUMP_POLL_INTERVAL) {
            // `Ok` is the send; `Disconnected` without one is a writer that
            // panicked before sending. Both mean the thread is finishing:
            // the join takes the result and the handed-back stdin.
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                return match writer.join() {
                    Ok((Ok(()), stdin)) => (StdinWriteOutcome::Done, Some(stdin)),
                    // The CLI died mid-write: the engine's
                    // kill-on-every-settle makes the internal reap
                    // idempotent there.
                    Ok((Err(e), stdin)) => {
                        log::warn!(target: "toptopduck::acp", "stdin line write failed: {e}");
                        kill_and_reap(child);
                        (StdinWriteOutcome::Failed(e), Some(stdin))
                    }
                    Err(_) => {
                        kill_and_reap(child);
                        (
                            StdinWriteOutcome::Failed(std::io::Error::other(
                                "stdin writer thread panicked",
                            )),
                            None,
                        )
                    }
                };
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if cancel.is_requested() {
                    kill_and_reap(child);
                    join_writer_bounded_or_detach(writer);
                    return (StdinWriteOutcome::Cancelled, None);
                }
                // Still writing, cancel not fired: keep watching.
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Stdout reader thread (shared, line-capped)
// ---------------------------------------------------------------------------

use crate::bounded_line::{read_line_bounded, LineRead, LINE_MAX_BYTES};

/// The bounded reader-to-pump channel's capacity (issue #640). The reader
/// blocks on send once the queue is full, which stops its reads, which
/// fills the child's stdout pipe, which blocks the child's writes: runaway
/// output is throttled at the source instead of growing an unbounded queue
/// over the turn's lifetime. Worst-case residency: capacity times
/// [`LINE_MAX_BYTES`] = 32 MiB. No message is ever dropped.
const READER_CHANNEL_CAPACITY: usize = 8;

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
