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

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use super::config::{render_argv, CliToolConfig};
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
    // Render the argv first (ADR-0108 Decision 4): a missing parameter, a
    // mistyped value, or an unimplemented delivery mode is the call's own
    // structured error -- the model self-corrects (ADR-0077).
    let argv = match render_argv(tool, &call.input) {
        Ok(argv) => argv,
        Err(detail) => {
            return error(format!("invalid call to `{}`: {detail}", tool.name));
        }
    };
    let mut command = Command::new(&tool.executable);
    command
        .args(&argv)
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
    // v1 passes every value through argv (ADR-0108 Decision 4), so the
    // child's stdin carries nothing: closing it immediately signals EOF to
    // a well-behaved tool. (#672 opens the stdin delivery channel here.)
    drop(child.stdin.take());
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
            // Reap the reader threads so nothing leaks past the call.
            let _ = stdout_thread.join();
            let _ = stderr_thread.join();
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
                let _ = stdout_thread.join();
                let _ = stderr_thread.join();
                return error(format!("wait on `{}` failed: {e}", tool.executable));
            }
        }
    };
    let (stdout, stdout_truncated) = stdout_thread.join().unwrap_or_default();
    let (stderr, stderr_truncated) = stderr_thread.join().unwrap_or_default();
    let stdout = decorate("stdout", &stdout, stdout_truncated, cap);
    let stderr = decorate("stderr", &stderr, stderr_truncated, cap);
    if status.success() {
        // ADR-0108 Decision 5: exit 0 = success, result = stdout; a
        // non-empty stderr rides along under a marker (some tools log to
        // stderr while succeeding).
        let mut content = stdout;
        if !stderr.is_empty() {
            content.push_str("\n[stderr]\n");
            content.push_str(&stderr);
        }
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
            "`{}` exited with a non-zero status ({status})\n[stderr]\n{stderr}",
            tool.executable
        ))
    }
}

/// Read one stream to EOF, storing at most `cap` bytes. Returns the stored
/// bytes (UTF-8 lossy) and whether MORE than `cap` bytes arrived (the
/// explicit truncation marker's trigger).
fn read_capped<R: Read>(mut reader: Option<R>, cap: usize) -> (String, bool) {
    let Some(reader) = reader.as_mut() else {
        return (String::new(), false);
    };
    let mut stored = Vec::new();
    let mut total = 0usize;
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                total += n;
                if stored.len() < cap {
                    let room = cap - stored.len();
                    stored.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
    }
    (String::from_utf8_lossy(&stored).into_owned(), total > cap)
}

/// Append the explicit truncation marker when a stream overran the cap
/// (ADR-0108 Decision 5: over-cap is visible, never silent).
fn decorate(stream: &str, content: &str, truncated: bool, cap: usize) -> String {
    if truncated {
        format!("{content}\n[{stream} truncated: exceeded the {cap}-byte cap]")
    } else {
        content.to_string()
    }
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
