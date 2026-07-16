//! Process-global registry of currently-open `.duck` paths (ADR-0035
//! Decision 3, issue #50): in-process single-writer enforcement. The same `.duck` opened
//! twice in the same process is the highest-frequency concurrency hazard (two
//! app windows on one file), and a process-local path set solves it with zero
//! OS locks and no stale-lock cleanup. Cross-process / external-edit detection
//! is a separate concern -- it lands via the pre-write hash check in
//! [`crate::session::Session::persist_if_bound`], not here.
//!
//! ADR-0035 explicitly defers OS advisory locking to v1 YAGNI: it is unreliable
//! on Windows (the app's primary platform) and needs a stale-lock cleanup
//! subsystem. A single-user desktop app with two *independent processes* on one
//! file is rare; the in-process registry covers the common case, and the
//! external-change hash check catches the rest honestly (never silently
//! clobbers).
//!
//! The registry keys on the canonical path so trivially-different spellings of
//! the same file (`a.duck` / `./a.duck` / absolute-vs-relative / `A.DUCK` on
//! case-insensitive volumes) collapse to one entry -- the single-writer
//! contract cannot be evaded by a path synonym.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The process-global set of canonical `.duck` paths currently held open by a
/// [`crate::session::Session`]. Acquired on bind / open, released on the
/// Session's Drop. A second acquire of an already-held canonical path is the
/// single-writer violation.
fn open_ducks() -> &'static Mutex<HashSet<PathBuf>> {
    static OPEN: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    OPEN.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Canonicalize a `.duck` path for registry keying. The file may not exist yet
/// (first `bind_duck` / Save As), so a direct `fs::canonicalize` is fallible;
/// in that case canonicalize the parent directory (which MUST exist -- a Save
/// As dialog guarantees it, and a tempdir's parent is real) and re-join the
/// file name. Every spelling of the same on-disk file collapses to one key, so
/// the registry cannot be evaded by a synonym.
///
/// Returns the canonical path on success. Fails only when neither the path nor
/// its parent resolves -- a path so broken the caller would have errored on the
/// IO anyway.
pub fn canonicalize_duck(path: &Path) -> Result<PathBuf, std::io::Error> {
    if let Ok(canonical) = path.canonicalize() {
        return Ok(canonical);
    }
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent directory")
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let parent_canonical = parent.canonicalize()?;
    Ok(parent_canonical.join(file_name))
}

/// Atomically acquire a canonical path for this process: returns `true` when
/// the path was newly added (acquired), `false` when another Session already
/// holds it (single-writer violation) OR when the registry lock is poisoned
/// (a prior panic left the registry inconsistent -- every acquire then refuses
/// until process restart, so the user must restart the app rather than close
/// another window). The check-and-add runs under one lock so two concurrent
/// acquires of the same path cannot both succeed.
pub fn try_acquire(canonical: &Path) -> bool {
    match open_ducks().lock() {
        Ok(mut set) => set.insert(canonical.to_path_buf()),
        Err(_) => {
            // Poisoned: a panic left the registry inconsistent. Surface as
            // `false` (fail-closed -- a false refusal is safer than a double
            // writer) and log at error level so the support symptom
            // ("suddenly no file opens") is diagnosable. The caller maps this
            // to AlreadyOpen; recovery requires process restart.
            log::error!(
                target: "toptopduck::persistence",
                "single-writer registry poisoned; all acquires will refuse until process restart"
            );
            false
        }
    }
}

/// Release a canonical path (idempotent). Called by a Session's Drop and by
/// the bind / save-as path when moving from one `.duck` to another. A poisoned
/// lock is logged at error level and swallowed -- Drop must not panic, and a
/// poisoned registry disables single-writer enforcement process-wide until
/// restart (every acquire refuses; every release no-ops), so the path may
/// appear falsely "already open" on the next open attempt.
pub fn release(canonical: &Path) {
    match open_ducks().lock() {
        Ok(mut set) => {
            set.remove(canonical);
        }
        Err(_) => {
            log::error!(
                target: "toptopduck::persistence",
                "single-writer registry poisoned during release of {}; \
                 the path may appear 'already open' until process restart",
                canonical.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_collapses_relative_and_dot_spellings() {
        // ADR-0035 Decision 3: the registry keys on the canonical path, so a trivially
        // different spelling of the same file does not evade single-writer.
        // `a.duck`, `./a.duck`, and the absolute path all canonicalize to one
        // key when the file exists.
        let dir = tempfile::tempdir().expect("tempdir");
        let abs = dir.path().join("a.duck");
        std::fs::write(&abs, b"{}").expect("write");
        let direct = canonicalize_duck(&abs).expect("abs");
        let relative = canonicalize_duck(&dir.path().join("./a.duck")).expect("rel");
        let dotted = canonicalize_duck(&dir.path().join(".").join("a.duck")).expect("dot");
        assert_eq!(direct, relative);
        assert_eq!(direct, dotted);
    }

    #[test]
    fn canonicalize_handles_a_not_yet_existing_file() {
        // First bind_duck / Save As targets a path that does not exist yet.
        // The parent must exist (Save As dialog guarantees it); canonicalize
        // the parent + re-join the file name so the not-yet-created file still
        // gets a stable canonical key.
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("brand-new.duck");
        assert!(!target.exists());
        let canonical = canonicalize_duck(&target).expect("canonicalize");
        assert!(canonical.ends_with("brand-new.duck"));
        // Creating the file after canonicalize must NOT change the key -- the
        // whole point of pre-acquire is that bind can lock the path before the
        // write.
        std::fs::write(&target, b"{}").expect("write");
        let post = canonicalize_duck(&target).expect("canonicalize after create");
        assert_eq!(canonical, post);
    }

    #[test]
    fn try_acquire_rejects_a_duplicate_and_releases_allow_reopen() {
        // ADR-0035 Decision 3 single-writer: a second acquire of the same canonical
        // path fails; after release, it can be re-acquired (e.g. drop + reopen).
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("once.duck");
        std::fs::write(&path, b"{}").expect("write");
        let key = canonicalize_duck(&path).expect("canonicalize");

        assert!(try_acquire(&key), "first acquire succeeds");
        assert!(
            !try_acquire(&key),
            "second acquire rejected (single-writer)"
        );
        release(&key);
        assert!(
            try_acquire(&key),
            "re-acquire after release succeeds (drop + reopen path)"
        );
        release(&key); // cleanup for test isolation
    }
}
