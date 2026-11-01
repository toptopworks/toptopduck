//! Platform process-tree termination (ADR-0108 Decision 5).
//!
//! Shared by the two child-spawning faces — the CLI tool executor and the MCP
//! stdio transport (#1456) — so a wrapper process (`npx`, `uvx`, a shell) and
//! the grandchildren it spawns die with the kill, instead of the bare
//! direct-child kill orphaning them. Windows: assign the child to a job
//! object with kill-on-close, so closing the job handle (or terminating it)
//! kills the whole tree. Unix: put the child in its own process group at
//! spawn, then `killpg` on cancel.

use std::process::Command;

/// The spawn-side facts the [`guard`] needs, implemented for both child
/// types (`std::process::Child` and `tokio::process::Child`). The tokio child
/// answers `None` once it has been polled to completion — a `guard` built at
/// spawn time always sees the live answer.
pub(crate) trait TreeChild {
    /// The OS process id (the Unix process-group leader's pgid, via
    /// [`prepare_command`]).
    #[cfg(unix)]
    fn tree_id(&self) -> Option<u32>;

    /// The process's raw handle (Windows only, for the job assignment).
    #[cfg(windows)]
    fn tree_handle(&self) -> Option<std::os::windows::io::RawHandle>;
}

impl TreeChild for std::process::Child {
    #[cfg(unix)]
    fn tree_id(&self) -> Option<u32> {
        Some(self.id())
    }

    #[cfg(windows)]
    fn tree_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        use std::os::windows::io::AsRawHandle;
        Some(self.as_raw_handle())
    }
}

impl TreeChild for tokio::process::Child {
    #[cfg(unix)]
    fn tree_id(&self) -> Option<u32> {
        self.id()
    }

    #[cfg(windows)]
    fn tree_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        self.raw_handle()
    }
}

/// Pre-spawn platform hook: Unix starts the child as its own process group
/// leader (pgid = child pid); Windows defers to [`TreeGuard`]. Tokio callers
/// reach the same hook through `Command::as_std_mut()`.
pub(crate) fn prepare_command(_command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        _command.process_group(0);
    }
}

/// Post-spawn tree guard. `None` on a platform failure (degrades to killing
/// the direct child only -- logged by the caller's environment; the call
/// still resolves honestly).
pub(crate) fn guard(child: &impl TreeChild) -> Option<TreeGuard> {
    #[cfg(windows)]
    {
        TreeGuard::assign(child)
    }
    #[cfg(unix)]
    {
        child.tree_id().map(|pid| TreeGuard { pgid: pid as i32 })
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = child;
        None
    }
}

pub(crate) struct TreeGuard {
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
    #[cfg(unix)]
    pgid: i32,
}

// SAFETY: the job HANDLE is a kernel-object reference, not a memory
// pointer -- moving it between threads is safe (TerminateJobObject /
// CloseHandle are thread-safe), and Drop closes it exactly once on
// whichever thread drops the guard. The MCP transport's kill handle
// publishes the guard to deadline/cancel threads, so it must be Send.
unsafe impl Send for TreeGuard {}

impl TreeGuard {
    /// Terminate the whole tree NOW (cancel path). Belt-and-braces: the
    /// caller still kills + reaps the direct child afterwards.
    pub(crate) fn kill_tree(&self) {
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
    fn assign(child: &impl TreeChild) -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let process = child.tree_handle()?;
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
            // The child handle carries the full access a job assignment
            // needs; a failure here degrades to direct-child kill only
            // (the caller's own kill backstop still applies).
            // SAFETY: both handles are valid (job checked non-null, the
            // child handle is the still-live process handle the child type
            // handed us) and this is a single assign of a live process to
            // a live job.
            let ok = AssignProcessToJobObject(job, process as _);
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
