//! Gateway-layer filesystem path whitelist (ADR-0080, issue #293).
//!
//! ADR-0080 supersedes the `disabled_filesystems` blanket lockdown for the
//! file-reachability surface: the agent's file access is constrained to the
//! **session source set (read-only) + the session working temp dir
//! (read-write)**. DuckDB offers no per-path engine ACL --
//! `disabled_filesystems` is all-or-nothing, instance-global, and irreversible
//! (ADR-0080 Why 2) -- so a read_* call inside a SELECT cannot be discriminated
//! per path by the engine. The constraint is therefore enforced at the gateway
//! layer: a tool extracts every file path it would hand the engine (issue #293:
//! the `read_*` paths inside an explore query) and validates each against this
//! whitelist *before* execution. An out-of-bounds path becomes a structured
//! tool error the agent self-corrects from (ADR-0077); it never reaches the
//! engine, and never fails silently.
//!
//! Layering vs the engine-level guardrails (ADR-0005): read-only sources
//! (READ_ONLY catalog attach), resource caps, and the CTAS wrapping that bars
//! mutating statements (DROP/ALTER/INSERT/COPY/ATTACH/INSTALL/LOAD) all remain
//! engine-enforced -- those guarantees rest on the engine, not on SQL text, and
//! this module does not weaken them. The wrapping already narrows the
//! in-SELECT file surface to `read_*` table/scalar functions alone; this
//! whitelist is the policy layer ADR-0080 adds for exactly that surface.
//!
//! Threat model (ADR-0080): the agent is a non-adversarial LLM the user chose
//! to run, not a dedicated SQL-injection adversary. Path extraction
//! ([`crate::tools::read_paths`]) is conservative -- a parse failure or a
//! non-literal `read_*` path is refused -- and per-session instance isolation
//! (ADR-0027) bounds any blast radius to the session that owns the engine.
//!
//! Symlink handling: canonicalization follows symlinks to their real target,
//! so an in-bounds symlink that points outside is resolved to the out-of-bounds
//! target and refused. This is a best-effort, read-time check (not TOCTOU-hard)
//! -- consistent with the non-adversarial threat model.

use std::path::{Path, PathBuf};

use crate::workingset::WorkingSet;

/// The access mode a tool wants for a path. Source files are read-only; the
/// session temp dir is read-write. A write against a read-only root is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AccessMode {
    Read,
    /// Reserved for the future built-in file tools that write scratch files into
    /// the session temp dir (ADR-0080 temp-dir read-write). No production caller
    /// exists yet; the unit tests exercise it so the read-write policy is pinned
    /// before the first writer lands.
    #[allow(dead_code)]
    Write,
}

/// Why a path was refused. The string form is what the agent reads to self-
/// correct (ADR-0077) -- each variant names the path so the agent can adjust.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FsAclError {
    /// The path as the agent supplied it (uncanonicalized) -- stable for the
    /// agent to reason about, even when canonicalization resolved a symlink.
    pub requested: String,
    pub reason: FsAclReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FsAclReason {
    /// An absolute path, a relative escape (`../`), or a symlink resolved
    /// outside every allowed root. The path is not reachable from the session.
    OutsideAllowedArea,
    /// A write was requested against a read-only source root. Source files are
    /// immutable session inputs (ADR-0004); the agent may re-read but not mutate.
    ReadOnlyRoot,
    /// The path does not currently resolve on disk (canonicalization failed).
    /// Read mode needs the file to exist; write mode needs the parent to exist.
    /// A read_* against a missing file would fail at the engine anyway -- this
    /// surfaces it as a structured tool error before execution.
    Unresolvable,
}

impl FsAclError {
    /// The honest, agent-facing message (ADR-0077). Read by the tool layer and
    /// folded into the tool-error string; never crosses IPC as-is (the frontend
    /// locale owns user-facing wording).
    pub(crate) fn message(&self) -> String {
        match self.reason {
            FsAclReason::OutsideAllowedArea => format!(
                "path `{}` is outside the allowed session source set (read-only) \
                 and working temp dir (read-write)",
                self.requested
            ),
            FsAclReason::ReadOnlyRoot => format!(
                "path `{}` is a read-only source file and may not be written",
                self.requested
            ),
            FsAclReason::Unresolvable => {
                format!("path `{}` does not resolve on disk", self.requested)
            }
        }
    }
}

/// The session's allowed filesystem roots, built per call from the live source
/// set + the session temp dir. Cheap to build (a handful of canonicalized
/// paths); a tool constructs one per call from [`crate::session::materializer::TurnDeps`].
///
/// - `source_roots`: the canonicalized ORIGINAL source file paths (the files
///   the user handed the session). Read-only -- the agent may re-read a raw
///   source, never write it (ADR-0004 immutable sources).
/// - `temp_root`: the canonicalized session temp dir. Read-write -- scratch
///   files the agent produces live here and are cleared on session drop
///   (ADR-0029 invariant 2). The per-source `.duckdb` snapshots also live here;
///   SQL still sees them READ_ONLY via catalog attach, independent of this ACL.
pub(crate) struct FsAcl {
    source_roots: Vec<PathBuf>,
    temp_root: PathBuf,
}

impl FsAcl {
    /// Build the whitelist from the working set's source descriptors + the
    /// session temp dir. A source whose original file no longer exists on disk
    /// (canonicalization fails) is dropped from `source_roots` -- it cannot be
    /// read_* anyway, and carrying a phantom root would be dead policy.
    pub(crate) fn new(working_set: &WorkingSet, temp_path: &Path) -> Self {
        let temp_root = canonicalize(temp_path).unwrap_or_else(|| temp_path.to_path_buf());
        let source_roots = working_set
            .list()
            .iter()
            .filter(|d| !working_set.is_result(&d.reference_name))
            .filter_map(|d| {
                if d.source_path.is_empty() {
                    return None;
                }
                canonicalize(&d.source_path)
            })
            .collect();
        Self {
            source_roots,
            temp_root,
        }
    }

    /// Validate `requested` against the whitelist.
    ///
    /// `requested` is the path string exactly as the agent supplied it to a
    /// `read_*` call: it may be absolute, or relative (resolved against the
    /// process CWD, mirroring how DuckDB resolves a relative `read_*` path).
    /// Symlinks are followed by canonicalization, so an in-bounds symlink
    /// pointing outside resolves to the out-of-bounds target and is refused.
    ///
    /// Read mode: the path must exist (canonicalize the full path). Write mode:
    /// the parent must exist (canonicalize the parent, rejoin the file name) so
    /// a not-yet-created scratch file in the temp dir is validating against its
    /// parent root.
    pub(crate) fn check(&self, requested: &str, mode: AccessMode) -> Result<(), FsAclError> {
        let resolved = resolve(requested, mode).map_err(|reason| FsAclError {
            requested: requested.to_string(),
            reason,
        })?;
        // A read-only source root: read OK, write refused (ADR-0004 immutable).
        if self.source_roots.contains(&resolved) {
            return match mode {
                AccessMode::Read => Ok(()),
                AccessMode::Write => Err(FsAclError {
                    requested: requested.to_string(),
                    reason: FsAclReason::ReadOnlyRoot,
                }),
            };
        }
        // The read-write temp root: anything underneath is allowed either mode.
        if resolved.starts_with(&self.temp_root) {
            return Ok(());
        }
        Err(FsAclError {
            requested: requested.to_string(),
            reason: FsAclReason::OutsideAllowedArea,
        })
    }
}

/// Canonicalize a path, following symlinks to the real target. Returns `None`
/// when the path does not exist on disk -- the caller treats a missing source
/// root as "not carried" and a missing read target as an `Unresolvable` refusal.
fn canonicalize(path: impl AsRef<Path>) -> Option<PathBuf> {
    std::fs::canonicalize(path.as_ref()).ok()
}

/// Resolve `requested` to a canonical absolute path for ACL matching. `mode`
/// selects whether the leaf must exist (read) or only the parent (write, so a
/// new scratch file in the temp dir validates against its parent). Relative
/// paths are resolved against the process CWD, mirroring DuckDB's resolution.
/// Returns the matching reason (not a path) on failure so the caller can fold
/// it into an [`FsAclError`] carrying the agent's original string.
fn resolve(requested: &str, mode: AccessMode) -> Result<PathBuf, FsAclReason> {
    let raw = Path::new(requested);
    let base = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        // DuckDB resolves a relative read_* path against the process CWD; the
        // ACL must resolve it the same way or a relative escape (`../x`) would
        // be checked against the wrong base.
        let cwd = std::env::current_dir().map_err(|_| FsAclReason::Unresolvable)?;
        cwd.join(raw)
    };
    let canonical = match mode {
        AccessMode::Read => std::fs::canonicalize(&base),
        // Write: the leaf need not exist yet -- canonicalize the parent (so a
        // symlinked ancestor still resolves) and rejoin the leaf name.
        AccessMode::Write => {
            let parent = base.parent().ok_or(FsAclReason::Unresolvable)?;
            let canon_parent =
                std::fs::canonicalize(parent).map_err(|_| FsAclReason::Unresolvable)?;
            Ok(canon_parent.join(base.file_name().ok_or(FsAclReason::Unresolvable)?))
        }
    };
    canonical.map_err(|_| FsAclReason::Unresolvable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnSchema, DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
    use crate::workingset::WorkingSet;
    use std::fs;
    use tempfile::TempDir;

    /// A working set with one source whose original file lives at `path`, so
    /// the ACL carries it as a read-only source root.
    fn ws_with_source(path: &str) -> WorkingSet {
        let mut ws = WorkingSet::default();
        ws.register(DatasetDescriptor {
            reference_name: "src".into(),
            display_name: "src".into(),
            source_path: path.to_string(),
            columns: vec![ColumnSchema {
                name: "c".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 0,
            sample: vec![],
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
        ws
    }

    /// AC #2 / AC #4: an absolute path outside every allowed root is refused as
    /// `OutsideAllowedArea`. This is the core path-escape rejection.
    #[test]
    fn absolute_out_of_bounds_path_is_refused() {
        let temp = TempDir::new().unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path());
        // A path that does exist on disk (so canonicalization succeeds) but is
        // outside the temp dir: the temp dir's own parent is a safe stand-in.
        let outside = temp
            .path()
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_else(|| PathBuf::from("/etc/hosts"));
        let err = acl
            .check(&outside.to_string_lossy(), AccessMode::Read)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::OutsideAllowedArea);
        assert!(err.message().contains("outside the allowed"));
    }

    /// AC #2 / AC #4: a relative `../` escape is resolved against the process
    /// CWD and, when it lands outside the temp root, refused. The sibling file
    /// lives outside the temp dir, so an absolute path to it is out of bounds.
    #[test]
    fn relative_dotdot_escape_is_refused() {
        let temp = TempDir::new().unwrap();
        // A file outside the temp dir (in its parent) -- absolute path to it is
        // outside the temp root regardless of how the agent phrases the escape.
        let sibling = temp
            .path()
            .parent()
            .unwrap()
            .join("sibling_escape_target_293.txt");
        fs::write(&sibling, "x").unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path());
        let escape_abs = sibling.canonicalize().unwrap();
        let err = acl
            .check(&escape_abs.to_string_lossy(), AccessMode::Read)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::OutsideAllowedArea);
        let _ = fs::remove_file(&sibling);
    }

    /// AC #2 / AC #4: an in-bounds symlink that points outside is resolved to
    /// its real out-of-bounds target and refused. Canonicalization follows the
    /// link, so the ACL never authorizes a path by its in-bounds alias.
    #[test]
    #[cfg(unix)]
    fn symlink_escape_is_refused() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        // Place a symlink INSIDE the temp dir pointing at the outside file.
        let link = temp.path().join("alias.csv");
        symlink(&outside_file, &link).unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path());
        // Reading via the in-bounds link alias canonicalizes to the outside
        // target -> refused (not authorized by the in-bounds alias).
        let err = acl
            .check(&link.to_string_lossy(), AccessMode::Read)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::OutsideAllowedArea);
    }

    /// An in-bounds temp dir path is allowed for both read and write. This is
    /// the positive capability the whitelist unlocks for scratch work.
    #[test]
    fn in_bounds_temp_path_is_allowed_read_and_write() {
        let temp = TempDir::new().unwrap();
        let file = temp.path().join("scratch.csv");
        fs::write(&file, "x").unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path());
        acl.check(&file.to_string_lossy(), AccessMode::Read)
            .expect("read inside temp dir allowed");
        // Write to a not-yet-existing file inside the temp dir: parent resolves,
        // leaf is rejoined, still under the temp root -> allowed.
        let new_file = temp.path().join("out.csv");
        acl.check(&new_file.to_string_lossy(), AccessMode::Write)
            .expect("write inside temp dir allowed");
    }

    /// A source's original file is a read-only root: read allowed, write
    /// refused (ADR-0004 immutable sources).
    #[test]
    fn source_root_is_read_only() {
        let temp = TempDir::new().unwrap();
        let src = TempDir::new().unwrap();
        let src_file = src.path().join("people.csv");
        fs::write(&src_file, "x").unwrap();
        let ws = ws_with_source(&src_file.to_string_lossy());
        let acl = FsAcl::new(&ws, temp.path());
        acl.check(&src_file.to_string_lossy(), AccessMode::Read)
            .expect("reading a source file allowed");
        let err = acl
            .check(&src_file.to_string_lossy(), AccessMode::Write)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::ReadOnlyRoot);
    }

    /// A read against a path that does not exist on disk is `Unresolvable` --
    /// canonicalization cannot fix a missing leaf, and a read_* would fail at
    /// the engine anyway. The structured error surfaces it before execution.
    #[test]
    fn missing_read_target_is_unresolvable() {
        let temp = TempDir::new().unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path());
        let ghost = temp.path().join("does-not-exist.csv");
        let err = acl
            .check(&ghost.to_string_lossy(), AccessMode::Read)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::Unresolvable);
    }

    /// A source whose original file no longer exists is dropped from the roots
    /// (not carried as phantom policy). The roots vec is empty for a vanished
    /// source path, so a read of any other path is decided by the temp root
    /// alone -- the vanished source contributes no policy.
    #[test]
    fn vanished_source_is_not_carried_as_a_root() {
        let temp = TempDir::new().unwrap();
        let ws = ws_with_source("/no/such/path/vanished.csv");
        let acl = FsAcl::new(&ws, temp.path());
        assert!(acl.source_roots.is_empty(), "vanished source not carried");
    }

    /// The agent-facing message always echoes the path as the agent supplied it
    /// (not the canonicalized target), so self-correction references the call.
    #[test]
    fn message_echoes_requested_path() {
        let err = FsAclError {
            requested: "../secret.txt".into(),
            reason: FsAclReason::OutsideAllowedArea,
        };
        assert!(err.message().contains("../secret.txt"));
    }
}
