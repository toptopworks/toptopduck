//! Gateway-layer filesystem path whitelist (ADR-0080, ADR-0088; read face
//! relaxed by ADR-0137 Decision 4).
//!
//! The agent's file access via `read_*` functions is constrained on the read
//! face to the **session source set (read-only) + the session working temp
//! dir (read-write) + any ABSOLUTE path on disk** (ADR-0137 D4: a referenced
//! file is either snapshotted through the same copy-in pipeline as manual
//! ingest on the materialize face, or read in place by explore; relative
//! spellings stay confined to the roots only when they reach this gateway
//! as relative -- i.e. sessions with no bound workspace, since ADR-0137 D3
//! absolutizes relative spellings against the workspace BEFORE the gateway,
//! surfacing them as absolute full-path reads). DuckDB offers no per-path
//! engine ACL, so the constraint is enforced at the gateway layer: a tool
//! extracts every literal file path it would hand the engine (the `read_*`
//! paths inside an explore/materialize query) and validates each against
//! this whitelist *before* execution. A refused path becomes a structured
//! tool error the agent self-corrects from (ADR-0077); it never reaches the
//! engine, and never fails silently.
//!
//! This whitelist is the **sole** file-reachability constraint for `read_*`
//! (ADR-0088): the engine-level `disabled_filesystems` lockdown was removed so
//! DuckDB can read in-bounds files. Non-literal `read_*` paths (dynamic
//! expressions) are refused by the preflight before reaching this module --
//! FsAcl only validates paths it can see as literal strings.
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
//! ([`crate::tools::read_paths`]) is conservative -- a non-literal `read_*`
//! path is refused by the preflight, and a `read_*` in an unhandled AST
//! variant is an accepted residual risk (ADR-0088 Why 4). Per-session
//! instance isolation (ADR-0027) bounds any blast radius to the session that
//! owns the engine.
//!
//! Symlink handling: canonicalization follows symlinks to their real target
//! (an unresolvable link is an `Unresolvable` refusal, and the write face
//! checks the resolved path). The READ face no longer refuses an in-bounds
//! link pointing outside: an absolute spelling carries ADR-0137 D4's
//! full-path allowance through the link, exactly as the engine would read
//! the outside target by its own absolute path -- the ADR-0080 read-side
//! symlink containment is superseded by the relax.

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
                 and working temp dir (read-write); a relative spelling that reached \
                 this check resolves against the process working directory -- \
                 reference the file by an absolute path",
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
/// - `assets_root`: the canonicalized per-session `assets/` dir (ADR-0089),
///   a READ-ONLY subtree. Unlike `source_roots` (exact per-file entries) this
///   is a directory-tree rule: SQL-reference dead files land there under
///   settle-time disambiguated names nobody enumerates in advance, so the
///   allowance covers whatever the subtree holds.
pub(crate) struct FsAcl {
    source_roots: Vec<PathBuf>,
    temp_root: PathBuf,
    assets_root: Option<PathBuf>,
}

impl FsAcl {
    /// Build the whitelist from the working set's source paths + the session
    /// temp dir + the per-session assets/ dir (ADR-0089: SQL-reference dead
    /// files live there so replay -- and a live follow-up referencing a
    /// materialized copy -- can read_* them; read-only, the same immutable
    /// rule as sources). A root whose original file no longer exists on disk
    /// (canonicalization fails) is dropped from `source_roots` -- it cannot be
    /// read_* anyway, and carrying a phantom root would be dead policy.
    pub(crate) fn new(
        working_set: &WorkingSet,
        temp_path: &Path,
        assets_dir: Option<&Path>,
    ) -> Self {
        let temp_root = canonicalize(temp_path).unwrap_or_else(|| temp_path.to_path_buf());
        let source_roots = working_set
            .source_paths()
            .into_iter()
            .filter_map(canonicalize)
            .collect();
        Self {
            source_roots,
            temp_root,
            assets_root: assets_dir.and_then(canonicalize),
        }
    }

    /// Validate `requested` against the whitelist.
    ///
    /// `requested` is the path string exactly as the agent supplied it to a
    /// `read_*` call: it may be absolute, or relative (resolved against the
    /// process CWD, mirroring how DuckDB resolves a relative `read_*` path).
    /// Symlinks are followed by canonicalization; for READS an absolute
    /// spelling through an outside-pointing link rides ADR-0137 D4's
    /// full-path allowance (see the module doc), while writes validate
    /// against the resolved path.
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
        // The read-only assets subtree (ADR-0089): read OK, write refused --
        // dead files are replay inputs, not scratch space.
        if let Some(root) = &self.assets_root {
            if resolved.starts_with(root) {
                return match mode {
                    AccessMode::Read => Ok(()),
                    AccessMode::Write => Err(FsAclError {
                        requested: requested.to_string(),
                        reason: FsAclReason::ReadOnlyRoot,
                    }),
                };
            }
        }
        // The read-write temp root: anything underneath is allowed either mode.
        if resolved.starts_with(&self.temp_root) {
            return Ok(());
        }
        // ADR-0137 Decision 4: the read face opens to full-path references --
        // an ABSOLUTE spelling anywhere on disk is readable. The materialize
        // face copy-ins such references into session-tree snapshots before
        // execution; the explore face reads them in place. Relative spellings
        // keep resolving against the process CWD (mirroring DuckDB), so the
        // reads still refused are relative paths landing outside every root.
        // Write stays closed outside the roots above: an absolute write falls
        // through to the refusal below (the same OutsideAllowedArea as a
        // relative escape).
        if mode == AccessMode::Read && Path::new(requested).is_absolute() {
            return Ok(());
        }
        Err(FsAclError {
            requested: requested.to_string(),
            reason: FsAclReason::OutsideAllowedArea,
        })
    }
}

/// Canonicalize a path, following symlinks to the real target. Returns `None`
/// when the path does not exist on disk -- this is the single canonicalization
/// entry point in the module, so every caller treats a miss consistently: a
/// missing source root is "not carried", a missing read target is an
/// `Unresolvable` refusal, and a missing write-parent is likewise.
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
    match mode {
        AccessMode::Read => canonicalize(&base).ok_or(FsAclReason::Unresolvable),
        // Write: the leaf need not exist yet -- canonicalize the parent (so a
        // symlinked ancestor still resolves) and rejoin the leaf name.
        AccessMode::Write => {
            let parent = base.parent().ok_or(FsAclReason::Unresolvable)?;
            let canon_parent = canonicalize(parent).ok_or(FsAclReason::Unresolvable)?;
            Ok(canon_parent.join(base.file_name().ok_or(FsAclReason::Unresolvable)?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ColumnSchema, DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
    use crate::workingset::WorkingSet;
    use std::fs;
    use tempfile::{NamedTempFile, TempDir};

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

    /// ADR-0089 assets face: a path inside the session's assets/ dir passes
    /// the READ check and is refused for WRITE -- the same immutable rule as
    /// a source root. This is the preflight half of SQL-reference dead-file
    /// replay: without the allowance, a materialized copy is just as dead as
    /// the temp original it replaced.
    #[test]
    fn assets_dir_is_readable_and_write_refused() {
        let temp = TempDir::new().unwrap();
        let session = TempDir::new().unwrap();
        let assets = session.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let dead_file = assets.join("kline.csv");
        std::fs::write(
            &dead_file, "x
y
",
        )
        .unwrap();
        // FsAcl canonicalizes the roots, so the file must exist on disk.
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), Some(&assets));
        assert!(
            acl.check(&dead_file.to_string_lossy(), AccessMode::Read)
                .is_ok(),
            "assets dead file passes the read check"
        );
        let err = acl
            .check(&dead_file.to_string_lossy(), AccessMode::Write)
            .unwrap_err();
        assert!(
            matches!(err.reason, FsAclReason::ReadOnlyRoot),
            "assets is read-only, got {err:?}"
        );
    }

    /// A nonexistent assets/ dir canonicalizes to nothing and is simply not
    /// carried -- no phantom root, no policy change for an unbound session.
    #[test]
    fn missing_assets_dir_is_not_carried() {
        let temp = TempDir::new().unwrap();
        let session = TempDir::new().unwrap();
        let ghost = session.path().join("assets").join("gone.csv");
        let acl = FsAcl::new(
            &WorkingSet::default(),
            temp.path(),
            Some(&session.path().join("assets")),
        );
        assert!(
            acl.check(&ghost.to_string_lossy(), AccessMode::Read)
                .is_err(),
            "a missing assets root carries no read allowance"
        );
    }

    /// ADR-0137 D4: an absolute path outside every allowed root is READABLE
    /// -- the full-path face. The materialize face copy-ins such references
    /// into session-tree snapshots; explore reads them in place. A WRITE
    /// against the same absolute path is still refused (write stays closed
    /// outside the roots).
    #[test]
    fn absolute_out_of_bounds_read_is_allowed_write_refused() {
        let temp = TempDir::new().unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), None);
        // A path that does exist on disk (so canonicalization succeeds) but is
        // outside the temp dir: the temp dir's own parent is a safe stand-in.
        let outside = temp
            .path()
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .unwrap_or_else(|| PathBuf::from("/etc/hosts"));
        acl.check(&outside.to_string_lossy(), AccessMode::Read)
            .expect("absolute read is allowed on the full-path face (ADR-0137 D4)");
        let err = acl
            .check(&outside.to_string_lossy(), AccessMode::Write)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::OutsideAllowedArea);
        assert!(err.message().contains("outside the allowed"));
    }

    /// A relative `../` escape is resolved against the process
    /// CWD (mirroring DuckDB) and, when it lands outside every allowed root,
    /// refused -- the relative face stays confined to the roots under ADR-0137
    /// D4 (only absolute spellings open to full-path). The sibling lives in
    /// the CWD's parent so the literal `../sib` resolves to a real on-disk
    /// file -- this exercises resolve()'s CWD branch (an absolute-path-only
    /// check would pass even if that branch were broken).
    #[test]
    fn relative_dotdot_escape_is_refused() {
        let temp = TempDir::new().unwrap();
        // A sibling file in the CWD's parent: the literal `../<name>` resolves
        // against the process CWD to this file, which is outside temp_root, so
        // the ACL refuses it. NamedTempFile gives panic-safe RAII cleanup (the
        // fixture lives outside any TempDir, so a manual remove_file at scope
        // end would leak on panic). Hard-panics if CWD parent is not writable
        // -- a silent skip would make this test a vacuous pass on CI.
        let cwd = std::env::current_dir().unwrap();
        let escape_file = NamedTempFile::new_in(cwd.parent().unwrap())
            .expect("escape-target fixture: CWD parent must be writable");
        fs::write(escape_file.path(), "x").unwrap();
        let target_name = escape_file
            .path()
            .file_name()
            .and_then(|n| n.to_str())
            .expect("escape-target filename is valid UTF-8");
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), None);
        // The literal relative path: resolve() joins it against the CWD and
        // canonicalizes to cwd.parent/target_name, which is outside temp_root.
        let err = acl
            .check(&format!("../{target_name}"), AccessMode::Read)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::OutsideAllowedArea);
        assert!(
            err.message().contains(&format!("../{target_name}")),
            "error names the literal relative path: {}",
            err.message()
        );
        // escape_file cleans up via Drop on scope exit (incl. panic).
    }

    /// An in-bounds symlink pointing outside: canonicalization resolves the
    /// link to its real target, but the requested spelling is ABSOLUTE, so
    /// ADR-0137 D4's full-path face carries the read -- the engine follows
    /// the link at exec, exactly as it would read the outside target by its
    /// own absolute path. The ADR-0080 symlink containment is superseded for
    /// the read face by the full-path relax; the relative face stays confined.
    /// The write face is NOT asserted here: resolve() canonicalizes the
    /// PARENT only in Write mode (pre-existing semantics -- a not-yet-created
    /// leaf must validate against its parent root), so the in-bounds link
    /// spelling validates against the temp root either way; write-through-
    /// link posture is out of this PR's scope.
    #[test]
    #[cfg(unix)]
    fn symlink_to_outside_is_readable_on_the_full_path_face() {
        use std::os::unix::fs::symlink;
        let temp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        // Place a symlink INSIDE the temp dir pointing at the outside file.
        let link = temp.path().join("alias.csv");
        symlink(&outside_file, &link).unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), None);
        acl.check(&link.to_string_lossy(), AccessMode::Read)
            .expect("absolute spelling reads through the link (ADR-0137 D4)");
    }

    /// An in-bounds temp dir path is allowed for both read and write. This is
    /// the positive capability the whitelist unlocks for scratch work.
    #[test]
    fn in_bounds_temp_path_is_allowed_read_and_write() {
        let temp = TempDir::new().unwrap();
        let file = temp.path().join("scratch.csv");
        fs::write(&file, "x").unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), None);
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
        let acl = FsAcl::new(&ws, temp.path(), None);
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
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), None);
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
        let acl = FsAcl::new(&ws, temp.path(), None);
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

    /// `Path::starts_with` matches component-by-component, so a path whose
    /// STRING prefix matches temp_root but is a distinct component (e.g.
    /// `/tmp/sess` vs `/tmp/sess_evil`) is NOT authorized. Guarded on the
    /// WRITE face -- the read face opens absolute spellings everywhere under
    /// ADR-0137 D4, so the component-wise property decides writes and the
    /// reads that still arrive here as relative spellings (a scratch write
    /// into `sess_evil` must stay outside the temp root).
    /// Regression guard against a future string-prefix refactor.
    #[test]
    fn temp_root_prefix_is_component_wise_not_string() {
        let parent = TempDir::new().unwrap();
        let temp_root = parent.path().join("sess");
        fs::create_dir(&temp_root).unwrap();
        // A sibling dir whose name starts with "sess" as a string but is a
        // different component -- `sess_evil` != `sess`.
        let evil_dir = parent.path().join("sess_evil");
        fs::create_dir(&evil_dir).unwrap();
        let evil_file = evil_dir.join("secret.csv");
        fs::write(&evil_file, "x").unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), &temp_root, None);
        let err = acl
            .check(&evil_file.to_string_lossy(), AccessMode::Write)
            .unwrap_err();
        assert_eq!(err.reason, FsAclReason::OutsideAllowedArea);
    }

    /// (Windows) A directory symlink inside temp pointing outside: the
    /// absolute spelling carries the read under ADR-0137 D4's full-path face,
    /// mirroring the unix symlink test on the CI target platform. Symlink
    /// creation needs Developer Mode or admin on Windows; skip on permission
    /// denial so CI is not flaky.
    #[test]
    #[cfg(windows)]
    fn symlink_to_outside_is_readable_on_the_full_path_face_windows() {
        use std::os::windows::fs::symlink_dir;
        let temp = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("secret.txt");
        fs::write(&outside_file, "secret").unwrap();
        // Place a directory symlink INSIDE temp pointing at the outside dir.
        let link = temp.path().join("alias");
        if symlink_dir(outside.path(), &link).is_err() {
            eprintln!("skipped: Windows symlink creation needs Developer Mode / admin");
            return;
        }
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), None);
        acl.check(&link.to_string_lossy(), AccessMode::Read)
            .expect("absolute spelling reads through the link (ADR-0137 D4)");
    }

    /// Issue #432 AC#2: a file inside the `tool_output/` subdirectory under the
    /// session temp dir is read-allowed at the gateway (fs_acl) layer. The subdir
    /// is covered by the existing `starts_with(temp_root)` check -- no separate
    /// whitelist entry is needed. This test documents and locks that behavior so
    /// a future refactor cannot accidentally narrow the temp-root match.
    ///
    /// With the engine lockdown removed (ADR-0088), fs_acl is the sole
    /// constraint -- an in-bounds `read_csv_auto` on this file now executes
    /// end-to-end (see `explore::tests::explore_executes_in_bounds_read_path`).
    #[test]
    fn tool_output_subdir_file_is_read_allowed() {
        let temp = TempDir::new().unwrap();
        let tool_output = temp.path().join("tool_output");
        fs::create_dir(&tool_output).unwrap();
        let file = tool_output.join("result.csv");
        fs::write(&file, "x").unwrap();
        let acl = FsAcl::new(&WorkingSet::default(), temp.path(), None);
        acl.check(&file.to_string_lossy(), AccessMode::Read)
            .expect("read inside tool_output/ allowed");
    }
}
