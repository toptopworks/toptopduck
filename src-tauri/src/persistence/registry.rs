//! Process-global registry of currently-open `.duck` paths (ADR-0035 §3,
//! issue #50): in-process single-writer enforcement. The same `.duck` opened
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
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "无父目录"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "无文件名"))?;
    let parent_canonical = parent.canonicalize()?;
    Ok(parent_canonical.join(file_name))
}

/// Atomically acquire a canonical path for this process: returns `true` when
/// the path was newly added (acquired), `false` when another Session already
/// holds it (single-writer violation). The check-and-add runs under one lock so
/// two concurrent acquires of the same path cannot both succeed.
pub fn try_acquire(canonical: &Path) -> bool {
    match open_ducks().lock() {
        Ok(mut set) => set.insert(canonical.to_path_buf()),
        Err(_) => false,
    }
}

/// Release a canonical path (idempotent). Called by a Session's Drop and by
/// the bind / save-as path when moving from one `.duck` to another. A poisoned
/// lock is swallowed -- the session is dropping anyway, and a stale entry's
/// worst case is a false "already open" on a path the user can retry.
pub fn release(canonical: &Path) {
    if let Ok(mut set) = open_ducks().lock() {
        set.remove(canonical);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_collapses_relative_and_dot_spellings() {
        // ADR-0035 §3: the registry keys on the canonical path, so a trivially
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
        // ADR-0035 §3 single-writer: a second acquire of the same canonical
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
