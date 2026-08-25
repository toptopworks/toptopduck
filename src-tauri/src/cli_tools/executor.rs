//! The CLI tool spawn engine (ADR-0108 Decision 3/5).
//!
//! Executes one registered tool call by spawning the executable with a
//! direct `argv` array -- never a shell. The working directory is the
//! session's work temp dir (the `fs_acl` read-write region, so anything the
//! tool writes lands where the agent can read it), the child env is the
//! inherited environment overlaid with the registration's literal values,
//! and both output streams are byte-capped with an explicit truncation
//! marker (over-cap is non-fatal). A non-zero exit is a structured tool
//! error the model self-corrects from (ADR-0077); a zero exit's result is
//! stdout, with a non-empty stderr appended under a marker.
//!
//! Cancellation: there is no per-call timeout (the call eats the turn's
//! wall-clock budget); round-level cancel maps to process-tree termination
//! -- a Windows job object (kill-on-close) or a Unix process group kill --
//! so grandchildren the tool spawned die with it.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::config::{render_call, CliToolConfig, RenderedFileValue};
use crate::cancel::CancelToken;
use crate::provider::tool_calling::{ToolResult, ToolUse};
use crate::tools::ToolOutcome;

/// Byte cap on each of the child's output streams (stdout and stderr each),
/// aligned with the existing tool-result content cap family (the ACP
/// accumulation cap, `ACCUM_MAX_BYTES`). Over the cap the stream truncates
/// with an explicit marker and the call still resolves (ADR-0108 Decision 5).
const OUTPUT_CAP_BYTES: usize = 8 * 1024 * 1024;

/// How often the wait loop polls the cancel token between child exits (the
/// approval gate's poll precedent -- a safety interval, not the mechanism).
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Grace period the reader threads get to hit EOF on their own after the
/// child exits, before the tree is terminated to force it (a grandchild
/// holding the pipe write-ends -- the resident-child class ADR-0108
/// anticipates -- would otherwise block them forever).
const READER_GRACE: Duration = Duration::from_secs(2);

/// Bound after the forced tree termination before an unfinished reader is
/// detached: a kill-resistant straggler must not hang the turn.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// Execute one CLI tool call (the `execute_call` dispatch arm's entry).
/// `session_temp_dir` is the cwd; `cancel` is the turn's shared token.
pub fn execute(
    tool: &CliToolConfig,
    call: &ToolUse,
    session_temp_dir: &Path,
    cancel: &CancelToken,
) -> ToolOutcome {
    execute_capped(tool, call, session_temp_dir, cancel, OUTPUT_CAP_BYTES)
}

/// The testable core: `cap` is the per-stream byte cap (tests shrink it).
fn execute_capped(
    tool: &CliToolConfig,
    call: &ToolUse,
    session_temp_dir: &Path,
    cancel: &CancelToken,
    cap: usize,
) -> ToolOutcome {
    let error = |content: String| ToolOutcome {
        result: ToolResult {
            tool_use_id: call.id.clone(),
            content,
            is_error: true,
        },
        promotion: None,
    };
    // Render the call first (ADR-0108 Decision 4): a missing parameter, a
    // mistyped value, or a delivery/template shape a hand-edited config broke
    // is the call's own structured error -- the model self-corrects
    // (ADR-0077).
    let rendered = match render_call(tool, &call.input, session_temp_dir, &call.id) {
        Ok(rendered) => rendered,
        Err(detail) => {
            return error(format!("invalid call to `{}`: {detail}", tool.name));
        }
    };
    // Write the file-channel values (issue #672): each planned temp file is
    // on disk BEFORE the spawn, so the child reads exactly what the approval
    // card's path promised. The guard deletes them on every exit path --
    // success, non-zero, cancel -- a temp file that outlived its call would
    // pile up in the session's work dir.
    let _temp_files = match TempFileGuard::write_all(&rendered.files) {
        Ok(guard) => guard,
        Err(e) => {
            return error(format!(
                "failed to write a file-delivery temp file for `{}`: {e}",
                tool.name
            ));
        }
    };
    let mut command = Command::new(&tool.executable);
    command
        .args(&rendered.argv)
        .current_dir(session_temp_dir)
        .envs(&tool.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    tree::prepare_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        // Probe semantics (ADR-0108 Decision 2): a missing/unresolvable
        // executable is a call-time structured error. The registration
        // stays; once the executable resolves again the tool re-arms.
        Err(e) => {
            return error(format!(
                "failed to spawn `{}`: {e}. The registration is kept; fix the \
                 executable and the tool re-arms.",
                tool.executable
            ));
        }
    };
    // The stdin channel (issue #672, ADR-0108 Decision 4): the single
    // declared value is written to the child's stdin, then the pipe closes
    // (EOF) -- the close v1 gave every child, now preceded by the bytes. The
    // write rides its own thread: a child that never reads would block a
    // pipe-sized write forever, and the wait loop must keep polling cancel.
    // A write FAILURE is surfaced, not swallowed: a child that read part of
    // the value and exited (possibly exit 0) leaves the rest undelivered,
    // and the outcome carries an explicit marker -- the write-side twin of
    // the read side's decorate doctrine. A child that never reads at all and
    // succeeds is still a clean success: the bytes fit the pipe buffer, the
    // write completed.
    let stdin_writer = match (child.stdin.take(), rendered.stdin) {
        (Some(mut stdin), Some(value)) => Some(thread::spawn(move || {
            stdin
                .write_all(value.as_bytes())
                .err()
                .map(|e| e.to_string())
        })),
        (maybe_stdin, _) => {
            drop(maybe_stdin);
            None
        }
    };
    // Tree-kill guard: assigns the child to a kill-on-close job (Windows)
    // or records its process group (Unix). `None` degrades to killing the
    // direct child only -- the guarantee weakens, the call still resolves.
    let guard = tree::guard(&child);
    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();
    let stdout_thread = thread::spawn(move || read_capped(stdout_handle, cap));
    let stderr_thread = thread::spawn(move || read_capped(stderr_handle, cap));
    // Wait for the child while polling cancel. On cancel: terminate the
    // whole tree, reap the child, and surface a tool error -- the loop-top
    // check then lands the turn itself as Cancelled (ADR-0021), the same
    // shape a cancelled SQL dispatch produces.
    let status = loop {
        if cancel.is_requested() {
            if let Some(guard) = guard.as_ref() {
                guard.kill_tree();
            }
            let _ = child.kill();
            let status = child.wait();
            // Reap the reader threads so nothing leaks past the call (the
            // bounded reap: the tree is already down, stragglers detach).
            let _ = reap_readers(stdout_thread, stderr_thread, guard.as_ref(), cancel);
            // The stdin writer breaks with EPIPE as the tree dies; whatever
            // is still blocked past the bounds detaches (the outcome is
            // already the cancellation error).
            if let Some(writer) = stdin_writer {
                let _ = wait_bounded(writer, guard.as_ref(), cancel);
            }
            return error(format!(
                "cli tool `{}` killed by round cancellation (status: {status:?})",
                tool.name
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(CANCEL_POLL_INTERVAL),
            Err(e) => {
                let _ = child.kill();
                let _ = reap_readers(stdout_thread, stderr_thread, guard.as_ref(), cancel);
                if let Some(writer) = stdin_writer {
                    let _ = wait_bounded(writer, guard.as_ref(), cancel);
                }
                return error(format!("wait on `{}` failed: {e}", tool.executable));
            }
        }
    };
    let (stdout, stderr) = reap_readers(stdout_thread, stderr_thread, guard.as_ref(), cancel);
    // Once the child has exited, the writer resolves almost immediately
    // (the pipe is either fully written or broken); the bounded ladder
    // covers the pathological dup-only-stdin holder.
    let stdin_error = stdin_writer
        .and_then(|writer| wait_bounded(writer, guard.as_ref(), cancel))
        .flatten();
    let stdin_note = match &stdin_error {
        Some(detail) => format!("\n[stdin delivery incomplete: {detail}]"),
        None => String::new(),
    };
    let stdout = decorate("stdout", &stdout, cap);
    let stderr = decorate("stderr", &stderr, cap);
    if status.success() {
        // ADR-0108 Decision 5: exit 0 = success, result = stdout; a
        // non-empty stderr rides along under a marker (some tools log to
        // stderr while succeeding).
        let mut content = stdout;
        if !stderr.is_empty() {
            content.push_str("\n[stderr]\n");
            content.push_str(&stderr);
        }
        content.push_str(&stdin_note);
        ToolOutcome {
            result: ToolResult {
                tool_use_id: call.id.clone(),
                content,
                is_error: false,
            },
            promotion: None,
        }
    } else {
        error(format!(
            "`{}` exited with a non-zero status ({status})\n[stderr]\n{stderr}{stdin_note}",
            tool.executable
        ))
    }
}

/// RAII cleaner for the file-channel temp files (issue #672): writes them
/// before the spawn, deletes them on drop -- which every return path of
/// [`execute_capped`] passes through (success, non-zero exit, cancel,
/// post-spawn errors). ADR-0108 Decision 4: the temp file is deleted when
/// the call ends, succeeded or not.
struct TempFileGuard(Vec<std::path::PathBuf>);

impl TempFileGuard {
    /// Write every planned value to its temp path. On a mid-batch failure
    /// the files that already landed are cleaned first (their own guard
    /// drop), then the refusal names the parameter that failed.
    fn write_all(files: &[RenderedFileValue]) -> Result<Self, String> {
        let mut written = Vec::with_capacity(files.len());
        for file in files {
            if let Err(e) = std::fs::write(&file.path, &file.content) {
                drop(Self(written));
                return Err(format!("parameter `{}`: {e}", file.param));
            }
            written.push(file.path.clone());
        }
        Ok(Self(written))
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        // Best-effort: a removal failure (an AV lock, a concurrent delete)
        // must not mask the call's real outcome, and the session temp dir is
        // discarded with the session anyway -- the guard bounds the common
        // case, not the pathological one.
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// One output stream's read result: the stored bytes (UTF-8 lossy), the
/// over-cap flag (Decision 5's explicit truncation marker), and a
/// failure/detach note -- a partial stream always carries a marker, never
/// a silent gap.
#[derive(Default)]
struct StreamRead {
    content: String,
    truncated: bool,
    error: Option<String>,
}

impl StreamRead {
    /// The detached-reader result: the stream never reached EOF even after
    /// tree termination, so its bytes are lost -- say so instead of hanging
    /// the turn on them.
    fn detached(stream: &str) -> Self {
        Self {
            content: String::new(),
            truncated: false,
            error: Some(format!(
                "{stream} never reached EOF after tree termination; output lost"
            )),
        }
    }
}

/// Read one stream to EOF, storing at most `cap` bytes. A mid-pipe read
/// failure is NOT EOF: what arrived is kept and the failure rides along
/// (the caller marks it) -- a partial stream never masquerades as a
/// complete one (ADR-0108 Decision 5's visible-never-silent, extended from
/// over-cap to read errors).
fn read_capped<R: Read>(mut reader: Option<R>, cap: usize) -> StreamRead {
    let Some(reader) = reader.as_mut() else {
        return StreamRead::default();
    };
    let mut stored = Vec::new();
    let mut total = 0usize;
    let mut error = None;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Err(e) => {
                error = Some(format!("read error: {e}"));
                break;
            }
            Ok(n) => {
                total += n;
                if stored.len() < cap {
                    let room = cap - stored.len();
                    stored.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
    }
    StreamRead {
        content: String::from_utf8_lossy(&stored).into_owned(),
        truncated: total > cap,
        error,
    }
}

/// Append the explicit visibility markers (ADR-0108 Decision 5: over-cap
/// and read failures are visible, never silent).
fn decorate(stream: &str, read: &StreamRead, cap: usize) -> String {
    let mut content = read.content.clone();
    if read.truncated {
        content.push_str(&format!(
            "\n[{stream} truncated: exceeded the {cap}-byte cap]"
        ));
    }
    if let Some(detail) = &read.error {
        content.push_str(&format!("\n[{stream} {detail}]"));
    }
    content
}

/// Wait for one spawned helper thread with the bounded ladder: its own time
/// within [`READER_GRACE`], then terminate the tree to force it (idempotent
/// beside the cancel path's kill), then [`KILL_GRACE`], then detach --
/// dropping the handle; the buffers the thread still owns are bounded (a
/// reader by the cap it enforces, the stdin writer by the value String). A
/// bounded wait replaces an unbounded one, never a hung turn.
fn wait_bounded<T: Default>(
    handle: thread::JoinHandle<T>,
    guard: Option<&tree::TreeGuard>,
    cancel: &CancelToken,
) -> Option<T> {
    // The cancel path already terminated the tree: no grace, straight to
    // the post-kill bound.
    let mut deadline = Instant::now() + READER_GRACE;
    if cancel.is_requested() {
        deadline = Instant::now();
    }
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(CANCEL_POLL_INTERVAL);
    }
    if !handle.is_finished() {
        if let Some(guard) = guard {
            guard.kill_tree();
        }
        let bound = Instant::now() + KILL_GRACE;
        while !handle.is_finished() && Instant::now() < bound {
            thread::sleep(CANCEL_POLL_INTERVAL);
        }
    }
    if handle.is_finished() {
        Some(handle.join().unwrap_or_default())
    } else {
        None
    }
}

/// Reap the reader threads once the child is gone. A grandchild holding
/// the pipe write-ends (the resident-child class ADR-0108 anticipates)
/// would block a plain `join()` forever -- including on the cancel path,
/// where the polling loop has already exited. Each reader waits out the
/// bounded ladder above; a detached one resolves with an explicit marker
/// instead of its bytes.
fn reap_readers(
    stdout_thread: thread::JoinHandle<StreamRead>,
    stderr_thread: thread::JoinHandle<StreamRead>,
    guard: Option<&tree::TreeGuard>,
    cancel: &CancelToken,
) -> (StreamRead, StreamRead) {
    (
        wait_bounded(stdout_thread, guard, cancel)
            .unwrap_or_else(|| StreamRead::detached("stdout")),
        wait_bounded(stderr_thread, guard, cancel)
            .unwrap_or_else(|| StreamRead::detached("stderr")),
    )
}

/// Platform process-tree termination (ADR-0108 Decision 5). Windows:
/// assign the child to a job object with kill-on-close, so closing the job
/// handle (or terminating it) kills the whole tree. Unix: put the child in
/// its own process group at spawn, then `killpg` on cancel.
mod tree {
    use std::process::{Child, Command};

    /// Pre-spawn platform hook: Unix starts the child as its own process
    /// group leader (pgid = child pid); Windows defers to [`guard`].
    pub(super) fn prepare_command(_command: &mut Command) {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            _command.process_group(0);
        }
    }

    /// Post-spawn tree guard. `None` on a platform failure (degrades to
    /// killing the direct child only -- logged by the caller's environment;
    /// the call still resolves honestly).
    pub(super) fn guard(child: &Child) -> Option<TreeGuard> {
        #[cfg(windows)]
        {
            TreeGuard::assign(child)
        }
        #[cfg(unix)]
        {
            Some(TreeGuard {
                pgid: child.id() as i32,
            })
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = child;
            None
        }
    }

    pub(super) struct TreeGuard {
        #[cfg(windows)]
        job: windows_sys::Win32::Foundation::HANDLE,
        #[cfg(unix)]
        pgid: i32,
    }

    impl TreeGuard {
        /// Terminate the whole tree NOW (cancel path). Belt-and-braces: the
        /// caller still kills + reaps the direct child afterwards.
        pub(super) fn kill_tree(&self) {
            #[cfg(windows)]
            // SAFETY: `self.job` is a live job handle created by `assign`
            // (non-null, never closed before this Drop) and TerminateJobObject
            // on a valid handle only affects processes in that job.
            unsafe {
                windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1);
            }
            #[cfg(unix)]
            // SAFETY: `self.pgid` is the child's own process group id set by
            // `prepare_command` (process_group(0) makes the child the leader,
            // so pgid = child pid); killpg targets only that group.
            unsafe {
                libc::killpg(self.pgid, libc::SIGKILL);
            }
            #[cfg(not(any(windows, unix)))]
            {}
        }

        #[cfg(windows)]
        fn assign(child: &Child) -> Option<Self> {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };
            // SAFETY: null pointers are the documented "no security
            // attributes / auto-generated name" arguments; the returned
            // handle is checked before any use.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    windows_sys::Win32::Foundation::CloseHandle(job);
                    return None;
                }
                // std's child handle carries the full access a job assignment
                // needs; a failure here degrades to direct-child kill only
                // (the caller's child.kill() backstop still applies).
                // SAFETY: both handles are valid (job checked non-null, the
                // child handle is std's still-live owned handle) and this is
                // a single assign of a live process to a live job.
                let ok = AssignProcessToJobObject(job, child.as_raw_handle() as _);
                if ok == 0 {
                    windows_sys::Win32::Foundation::CloseHandle(job);
                    return None;
                }
                Some(Self { job })
            }
        }
    }

    impl Drop for TreeGuard {
        fn drop(&mut self) {
            // kill-on-close backstop: even without an explicit kill_tree,
            // dropping the job handle takes the tree down if the child is
            // somehow still alive (Unix needs no analog -- killpg is explicit).
            #[cfg(windows)]
            // SAFETY: `self.job` is valid (created in `assign`, never closed
            // elsewhere) and closing it exactly once here is the RAII
            // contract; KILL_ON_JOB_CLOSE takes the tree down with it.
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reader that yields "abc" once, then fails: the mid-pipe failure
    /// class a broken pipe produces.
    struct FailingReader {
        emitted: bool,
    }

    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if !self.emitted {
                self.emitted = true;
                buf[..3].copy_from_slice(b"abc");
                return Ok(3);
            }
            Err(std::io::Error::other("broken pipe"))
        }
    }

    #[test]
    fn read_capped_marks_a_mid_stream_read_error_instead_of_eof() {
        let read = read_capped(Some(FailingReader { emitted: false }), 1024);
        assert_eq!(
            read.content, "abc",
            "what arrived before the failure is kept"
        );
        assert!(!read.truncated);
        assert!(
            read.error
                .as_deref()
                .is_some_and(|e| e.contains("broken pipe")),
            "the failure is carried, not swallowed: {:?}",
            read.error
        );
        let decorated = decorate("stdout", &read, 1024);
        assert!(
            decorated.contains("[stdout read error:"),
            "the marker names the stream and the failure: {decorated}"
        );
    }

    #[test]
    fn a_clean_eof_stream_decorates_to_itself() {
        let read = read_capped(Some(std::io::empty()), 1024);
        assert_eq!(decorate("stdout", &read, 1024), "");
    }
}
