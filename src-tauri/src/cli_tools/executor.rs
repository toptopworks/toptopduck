//! The CLI tool spawn engine (ADR-0108 Decision 3/5).
//!
//! Executes one registered tool call by spawning the executable with a
//! direct `argv` array -- never a shell. The working directory is the
//! session's work temp dir (the `fs_acl` read-write region, so anything the
//! tool writes lands where the agent can read it), the child env is the
//! inherited environment overlaid with the registration's literal values,
//! and both output streams are byte-capped with an explicit truncation
//! marker (over-cap is non-fatal). An over-cap stdout additionally spills
//! its FULL byte range to a deterministic file under the session temp's
//! `tool_output/` directory (issue #1215) -- truncation stops losing data;
//! stderr keeps plain in-cap truncation. A non-zero exit is a structured tool
//! error the model self-corrects from (ADR-0077); a zero exit's result is
//! stdout, with a non-empty stderr appended under a marker.
//!
//! Cancellation: there is no per-call timeout (the call eats the turn's
//! wall-clock budget); round-level cancel maps to process-tree termination
//! -- a Windows job object (kill-on-close) or a Unix process group kill --
//! so grandchildren the tool spawned die with it.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
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
    // The stdout tee plan (issue #1215): resolved into a real file only at
    // the cap crossing, inside the reader. stderr takes none -- the
    // diagnostic stream keeps its in-cap truncation semantics.
    let spill = SpillPlan::new(session_temp_dir, &tool.name, &call.id);
    let stdout_thread = thread::spawn(move || read_capped(stdout_handle, cap, Some(&spill)));
    let stderr_thread = thread::spawn(move || read_capped(stderr_handle, cap, None));
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
    let (stdout_read, stderr_read) =
        reap_readers(stdout_thread, stderr_thread, guard.as_ref(), cancel);
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
    let stdout = decorate("stdout", &stdout_read, cap);
    let stderr = decorate("stderr", &stderr_read, cap);
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
        // The stdout markers ride the error too (issue #1215): a failing
        // tool's spilled stdout is as much the data egress as a succeeding
        // one's, so the truncation + spill path land in the error content
        // -- the capped head does not (stderr is the error's payload).
        let stdout_note = markers("stdout", &stdout_read, cap);
        error(format!(
            "`{}` exited with a non-zero status ({status})\n[stderr]\n{stderr}{stdin_note}{stdout_note}",
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
    /// The over-cap stdout spill that landed (issue #1215): the full-byte
    /// range file under `tool_output/`. `None` for stderr (the diagnostic
    /// stream never spills), under-cap streams, and any stream that fell
    /// short of a complete byte range -- a failed spill or a read error
    /// past the crossing withdraws the path and removes the partial file
    /// (a half-trusted reference is worse than none; the error field
    /// carries the failure).
    spilled: Option<PathBuf>,
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
            spilled: None,
        }
    }
}

/// Read one stream to EOF, storing at most `cap` bytes. A mid-pipe read
/// failure is NOT EOF: what arrived is kept and the failure rides along
/// (the caller marks it) -- a partial stream never masquerades as a
/// complete one (ADR-0108 Decision 5's visible-never-silent, extended from
/// over-cap to read errors). A spill opened before a read error is
/// withdrawn and cleaned up: the prefix of an unknown-length stream is
/// never advertised as complete.
fn read_capped<R: Read>(
    mut reader: Option<R>,
    cap: usize,
    spill: Option<&SpillPlan>,
) -> StreamRead {
    let Some(reader) = reader.as_mut() else {
        return StreamRead::default();
    };
    let mut stored = Vec::new();
    let mut total = 0usize;
    let mut error = None;
    let mut spill_file: Option<File> = None;
    let mut spilled: Option<PathBuf> = None;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Err(e) => {
                error = Some(format!("read error: {e}"));
                // The stream died before EOF: whatever spilled is a prefix
                // of an unknown-length stream, not a complete byte range.
                // Withdraw the path and remove the partial bytes -- the
                // same half-trusted-file doctrine as the mid-write failure
                // below (the handle drops first; Windows refuses to delete
                // an open file).
                drop(spill_file.take());
                if let Some(path) = spilled.take() {
                    let _ = std::fs::remove_file(&path);
                }
                break;
            }
            Ok(n) => {
                total += n;
                // The cap crossing opens the tee (issue #1215): flush the
                // head, then write this and every later chunk whole. The
                // `error.is_none()` arm is the no-retry latch -- one failed
                // spill surfaces its marker, it does not become a per-chunk
                // retry loop. The sniff head spans stored + this chunk: a
                // single over-cap chunk arrives before anything is stored.
                if total > cap && spilled.is_none() && error.is_none() {
                    if let Some(plan) = spill {
                        let extension =
                            spill_extension(stored.iter().chain(chunk[..n].iter()).copied());
                        match plan.open(extension) {
                            Ok((mut file, path)) => {
                                // The flushed head precedes this chunk in the
                                // byte range, so writing the chunk whole after
                                // it has no overlap.
                                if let Err(e) = file.write_all(&stored) {
                                    error = Some(format!("spill write error: {e}"));
                                    // The half-written file cannot be a data
                                    // reference: drop the handle (Windows
                                    // refuses to delete an open file), then
                                    // remove the partial bytes -- a
                                    // deterministic path the model can
                                    // reconstruct must not hold silent
                                    // leftovers.
                                    drop(file);
                                    let _ = std::fs::remove_file(&path);
                                } else {
                                    spill_file = Some(file);
                                    spilled = Some(path);
                                }
                            }
                            Err(e) => error = Some(format!("spill write error: {e}")),
                        }
                    }
                }
                if stored.len() < cap {
                    let room = cap - stored.len();
                    stored.extend_from_slice(&chunk[..n.min(room)]);
                }
                if let Some(file) = spill_file.as_mut() {
                    if let Err(e) = file.write_all(&chunk[..n]) {
                        // Mid-write failure: the partial file cannot be
                        // trusted as a data reference -- drop the path, keep
                        // the visible error, and remove the partial bytes
                        // (spill_file's None-assign drops the handle first;
                        // Windows refuses to delete an open file).
                        error = Some(format!("spill write error: {e}"));
                        spill_file = None;
                        if let Some(path) = spilled.take() {
                            let _ = std::fs::remove_file(&path);
                        }
                    }
                }
            }
        }
    }
    StreamRead {
        content: String::from_utf8_lossy(&stored).into_owned(),
        truncated: total > cap,
        error,
        spilled,
    }
}

/// The over-cap stdout tee target (issue #1215): the ingredients of the
/// deterministic `tool_output/<tool>-<call-id>.<ext>` file, resolved into a
/// real file only at the cap-crossing moment (the extension is sniffed from
/// the head then -- before that the format is unknown). One plan per
/// stdout stream; stderr takes none.
struct SpillPlan {
    dir: PathBuf,
    stem: String,
}

impl SpillPlan {
    fn new(session_temp_dir: &Path, tool: &str, call_id: &str) -> Self {
        Self {
            dir: session_temp_dir.join(crate::session::TOOL_OUTPUT_DIR_NAME),
            stem: format!(
                "{}-{}",
                sanitize_file_component(tool),
                sanitize_file_component(call_id)
            ),
        }
    }

    /// Create the spill file with the sniffed extension. The extension is
    /// the derived-source pipeline's routing signal (its dispatcher has no
    /// other one), so it must land in its table.
    fn open(&self, extension: &str) -> std::io::Result<(File, PathBuf)> {
        std::fs::create_dir_all(&self.dir)?;
        let path = self.dir.join(format!("{}.{}", self.stem, extension));
        let file = File::create(&path)?;
        Ok((file, path))
    }
}

/// Bound each spill name component so a hostile call id cannot push the
/// path past platform limits. Wide enough that provider-shaped ids never
/// collide -- the reason this does not reuse `sanitize_segment`: its
/// 40-char truncation is non-injective, and unlike the file channel's
/// die-with-the-call temps, a spill file persists for the session and is
/// referenced by path, so a truncated-name collision would silently swap
/// data.
const SPILL_COMPONENT_MAX_CHARS: usize = 80;

/// Keep one filename component filesystem-safe: an allowlist of
/// alphanumerics plus `-`, `_`, `.`, with everything else -- path
/// separators, Windows-reserved characters, control characters, and the
/// format class (`is_control` alone misses the bidi-override and
/// zero-width characters) -- folding to `_`. Both halves of the spill
/// name sit outside the executor's trust boundary in different ways --
/// `tool.name` comes from config, `call.id` from the model (ADR-0080
/// posture: model input may be injection-influenced) -- so both pass the
/// same map and bound.
fn sanitize_file_component(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            let safe = c.is_alphanumeric() || matches!(c, '-' | '_' | '.');
            if safe {
                c
            } else {
                '_'
            }
        })
        .take(SPILL_COMPONENT_MAX_CHARS)
        .collect()
}

/// The spill extension, sniffed from the head's first non-whitespace
/// byte -- the head being what has arrived by the crossing chunk (a
/// stream still blank that far takes the default): a JSON-shaped head
/// (`[` or `{`) spills as `.json`, everything else as `.csv`. A leading
/// UTF-8 BOM is skipped so a PowerShell-shaped JSON head still routes to
/// `.json`; a UTF-16 BOM is not trusted for inference and falls to
/// `.csv` -- the sniff only trusts a brace it can see. `read_csv_auto`
/// is lenient with plain text (a stray non-CSV spill still ingests),
/// while JSON under `.csv` would misroute -- the sniff only has to catch
/// the case that breaks.
fn spill_extension<I: IntoIterator<Item = u8>>(head: I) -> &'static str {
    const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
    let mut bom = 0usize;
    for b in head {
        if bom < UTF8_BOM.len() && b == UTF8_BOM[bom] {
            bom += 1;
            continue;
        }
        if !b.is_ascii_whitespace() {
            return match b {
                b'{' | b'[' => "json",
                _ => "csv",
            };
        }
    }
    "csv"
}

/// The visible marker lines for one stream (ADR-0108 Decision 5: over-cap
/// and read failures are visible, never silent; issue #1215 adds the spill
/// path). Markers only, no head -- the non-zero-exit error joins these
/// without the capped bytes.
fn markers(stream: &str, read: &StreamRead, cap: usize) -> String {
    let mut content = String::new();
    if read.truncated {
        match &read.spilled {
            Some(path) => content.push_str(&format!(
                "\n[{stream} truncated: exceeded the {cap}-byte cap; full output spilled to: {}]",
                path.display()
            )),
            None => content.push_str(&format!(
                "\n[{stream} truncated: exceeded the {cap}-byte cap]"
            )),
        }
    }
    if let Some(detail) = &read.error {
        content.push_str(&format!("\n[{stream} {detail}]"));
    }
    content
}

/// Append the explicit visibility markers to the stream's capped content.
fn decorate(stream: &str, read: &StreamRead, cap: usize) -> String {
    let mut content = read.content.clone();
    content.push_str(&markers(stream, read, cap));
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
        let read = read_capped(Some(FailingReader { emitted: false }), 1024, None);
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
        let read = read_capped(Some(std::io::empty()), 1024, None);
        assert_eq!(decorate("stdout", &read, 1024), "");
    }

    /// The tee core (issue #1215): an over-cap stream spills its FULL byte
    /// range to the deterministic `tool_output/` file -- the in-memory head
    /// flushed first, every post-crossing chunk whole -- while the returned
    /// content stays capped. Raw bytes, no lossy decode on the file side.
    #[test]
    fn over_cap_spills_the_full_stream_verbatim() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cap = 16;
        let payload: Vec<u8> = (0..cap + 10)
            .map(|i| (b'\xFF' as u16 + i as u16) as u8) // includes non-UTF-8 bytes
            .collect();
        let plan = SpillPlan::new(temp.path(), "fake", "tu_1");
        let read = read_capped(
            Some(std::io::Cursor::new(payload.clone())),
            cap,
            Some(&plan),
        );
        assert!(read.truncated);
        assert!(
            read.content.contains('\u{FFFD}'),
            "the head is the lossy text face; the FILE is the raw byte face"
        );
        let spilled = read.spilled.as_deref().expect("the spill path is returned");
        assert_eq!(
            spilled,
            temp.path().join("tool_output").join("fake-tu_1.csv"),
            "deterministic <tool>-<call-id> name, sniffed .csv for a non-JSON head"
        );
        assert_eq!(
            std::fs::read(spilled).expect("spill file readable"),
            payload,
            "the file carries the complete byte range, not the truncation"
        );
    }

    /// A stream of exactly `cap` bytes never crosses: no file, no spill
    /// note -- the under-cap contract is byte-for-byte unchanged.
    #[test]
    fn exactly_cap_does_not_spill() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cap = 16;
        let plan = SpillPlan::new(temp.path(), "fake", "tu_1");
        let read = read_capped(
            Some(std::io::Cursor::new(vec![b'x'; cap])),
            cap,
            Some(&plan),
        );
        assert!(!read.truncated);
        assert!(read.spilled.is_none(), "no crossing, no file");
        assert!(
            !temp.path().join("tool_output").exists(),
            "the tool_output dir is not even created"
        );
    }

    /// The extension sniff (issue #1215): a JSON-shaped head routes the
    /// spill to `.json` so the derived-source dispatcher can hand it to
    /// `read_json_auto`; leading whitespace does not defeat the sniff.
    #[test]
    fn a_json_head_spills_with_the_json_extension() {
        let temp = tempfile::tempdir().expect("tempdir");
        let cap = 8;
        let mut payload = b"  [1,2,3]padding-to-cross".to_vec();
        payload.truncate(cap + 2);
        let plan = SpillPlan::new(temp.path(), "jq", "tu_2");
        let read = read_capped(Some(std::io::Cursor::new(payload)), cap, Some(&plan));
        let spilled = read.spilled.as_deref().expect("spilled");
        assert!(
            spilled.extension().is_some_and(|e| e == "json"),
            "a JSON head gets the .json extension: {}",
            spilled.display()
        );
    }

    /// The spill name is built from model-controlled strings (`call.id`) and
    /// config strings (`tool.name`): path separators and Windows-illegal
    /// characters are neutralized, so the file cannot escape `tool_output/`
    /// (ADR-0080 posture -- model input may be injection-influenced).
    #[test]
    fn the_spill_name_is_sanitized() {
        let temp = tempfile::tempdir().expect("tempdir");
        let plan = SpillPlan::new(temp.path(), "fake", "tu_1/..\\evil:id");
        let read = read_capped(Some(std::io::Cursor::new(vec![b'x'; 20])), 8, Some(&plan));
        let spilled = read.spilled.as_deref().expect("spilled");
        let dir = temp.path().join("tool_output");
        let canonical = std::fs::canonicalize(spilled).expect("canonical");
        assert!(
            canonical.starts_with(std::fs::canonicalize(&dir).unwrap()),
            "the spill file stays inside tool_output/: {}",
            spilled.display()
        );
        assert_eq!(
            spilled.file_name().and_then(|n| n.to_str()),
            Some("fake-tu_1_.._evil_id.csv"),
            "separators and reserved characters map to underscores"
        );
    }

    /// A spill that cannot land (here: `tool_output` is occupied by a regular
    /// file, so the dir cannot be created) is visible, never silent: the
    /// truncation marker still rides, the failure is named, and the path is
    /// withheld -- a half-trusted file reference is worse than none.
    #[test]
    fn a_failed_spill_is_visible_and_the_path_withheld() {
        let temp = tempfile::tempdir().expect("tempdir");
        std::fs::write(temp.path().join("tool_output"), b"occupied").unwrap();
        let plan = SpillPlan::new(temp.path(), "fake", "tu_1");
        let read = read_capped(Some(std::io::Cursor::new(vec![b'x'; 20])), 8, Some(&plan));
        assert!(read.truncated);
        assert!(read.spilled.is_none(), "no path for a failed spill");
        let decorated = decorate("stdout", &read, 8);
        assert!(
            decorated.contains("truncated"),
            "the cap marker still rides: {decorated}"
        );
        assert!(
            read.error.as_deref().is_some_and(|e| e.contains("spill")),
            "the spill failure is named: {:?}",
            read.error
        );
    }

    /// The marker split (issue #1215): the non-zero-exit error content joins
    /// stdout's MARKER lines only -- the truncated/spilled notice rides the
    /// error, the capped 8 MiB head does not (the error's payload is stderr;
    /// the spill path is the data egress).
    #[test]
    fn markers_carry_the_spill_note_without_the_head() {
        let temp = tempfile::tempdir().expect("tempdir");
        let plan = SpillPlan::new(temp.path(), "fake", "tu_1");
        let read = read_capped(Some(std::io::Cursor::new(vec![b'x'; 20])), 8, Some(&plan));
        let markers = markers("stdout", &read, 8);
        assert!(
            markers.contains("truncated") && markers.contains("spilled to"),
            "the marker block names the spill: {markers}"
        );
        assert!(
            !markers.contains("xxxxxxxx"),
            "the capped head does not ride the marker block"
        );
        // The marker line is a prefix-free suffix: decorate = head + markers.
        let decorated = decorate("stdout", &read, 8);
        assert!(decorated.ends_with(&markers));
    }

    /// The planless contract: a stream read without a spill plan never
    /// creates `tool_output` nor reports a path, however far past the cap
    /// it runs -- wiring a plan into the stderr call would turn this red.
    #[test]
    fn a_planless_over_cap_stream_never_spills() {
        let temp = tempfile::tempdir().expect("tempdir");
        let read = read_capped(Some(std::io::Cursor::new(vec![b'x'; 20])), 8, None);
        assert!(read.truncated, "in-cap truncation semantics unchanged");
        assert!(read.spilled.is_none(), "no path without a plan");
        assert!(
            !temp.path().join("tool_output").exists(),
            "no side effect at all"
        );
    }

    /// A chunked crossing pins the byte order and the cap cross-section:
    /// small reads with a position-distinguishable payload -- the file
    /// must carry the full range in order, the content exactly the capped
    /// prefix. Write-order swaps and cross-section regressions both fail
    /// here (a Cursor's single read hides both: the head is empty at the
    /// crossing and every byte is identical).
    #[test]
    fn a_chunked_crossing_spills_in_order_and_caps_the_head() {
        let cap = 10;
        let payload = b"0123456789abcdefghijklmnopqrstuvwxyz".to_vec();
        // Yields at most `k` bytes per read, so the crossing lands
        // mid-stream with the head partially stored.
        struct Chunky {
            data: Vec<u8>,
            pos: usize,
            k: usize,
        }
        impl Read for Chunky {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.k.min(buf.len()).min(self.data.len() - self.pos);
                buf[..n].copy_from_slice(&self.data[self.pos..self.pos + n]);
                self.pos += n;
                Ok(n)
            }
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let plan = SpillPlan::new(temp.path(), "fake", "tu_1");
        let read = read_capped(
            Some(Chunky {
                data: payload.clone(),
                pos: 0,
                k: 3,
            }),
            cap,
            Some(&plan),
        );
        assert_eq!(read.content, "0123456789", "exactly the capped prefix");
        let spilled = read.spilled.as_deref().expect("spilled");
        assert_eq!(
            std::fs::read(spilled).expect("spill file readable"),
            payload,
            "the full byte range, head before chunk, in order"
        );
    }

    /// A read error past the crossing withdraws the spill: the file stops
    /// at the failure point -- a prefix of an unknown-length stream -- so
    /// no completeness claim, no leftover bytes, and the read error stays
    /// visible.
    #[test]
    fn a_read_error_past_the_crossing_withdraws_the_spill() {
        struct SpillThenFail {
            emitted: bool,
        }
        impl Read for SpillThenFail {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.emitted {
                    return Err(std::io::Error::other("broken pipe"));
                }
                self.emitted = true;
                buf[..20].fill(b'x');
                Ok(20)
            }
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let cap = 8;
        let plan = SpillPlan::new(temp.path(), "fake", "tu_1");
        let read = read_capped(Some(SpillThenFail { emitted: false }), cap, Some(&plan));
        assert!(read.truncated);
        assert!(
            read.error
                .as_deref()
                .is_some_and(|e| e.contains("read error")),
            "the read failure rides: {:?}",
            read.error
        );
        assert!(read.spilled.is_none(), "the path is withdrawn");
        assert!(
            !temp
                .path()
                .join("tool_output")
                .join("fake-tu_1.csv")
                .exists(),
            "the partial bytes are removed"
        );
        let markers = markers("stdout", &read, cap);
        assert!(!markers.contains("spilled to"), "no completeness claim");
    }

    /// The BOM blind spot: a UTF-8 BOM before a JSON head still routes to
    /// `.json` (a PowerShell-shaped output); a UTF-16 BOM is not trusted
    /// for inference and takes the `.csv` default.
    #[test]
    fn the_sniff_skips_a_utf8_bom_and_distrusts_a_utf16_one() {
        let utf8_bom_json = [0xEF, 0xBB, 0xBF, b' ', b'[', b'1', b']'];
        assert_eq!(spill_extension(utf8_bom_json), "json");
        let utf16_bom_json = [0xFF, 0xFE, b'[', b'1', b']'];
        assert_eq!(spill_extension(utf16_bom_json), "csv");
        // A BOM alone (a head that never shows content) keeps the default.
        assert_eq!(spill_extension([0xEF, 0xBB, 0xBF]), "csv");
    }

    /// The sanitizer's allowlist catches the format class the control-only
    /// map missed, and the bound keeps a hostile id off the path-length
    /// cliff.
    #[test]
    fn sanitize_folds_format_characters_and_bounds_length() {
        assert_eq!(
            sanitize_file_component("a\u{202E}b\u{200B}c"),
            "a_b_c",
            "the bidi-override and zero-width classes fold"
        );
        assert_eq!(
            sanitize_file_component(&"t".repeat(300)).chars().count(),
            SPILL_COMPONENT_MAX_CHARS,
            "a hostile id cannot push the path past platform limits"
        );
    }
}
