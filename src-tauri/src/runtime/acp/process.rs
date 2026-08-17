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

use std::path::Path;
use std::process::{Child, Command, Stdio};
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
