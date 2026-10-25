//! The session workspace axis (ADR-0137, issue #1381).
//!
//! A session's workspace is the directory agent-authored processes work in:
//! the external runtime's `session/new` cwd and the built-in CLI tools'
//! spawn cwd. The binding lives in the recipe header (`workspace`, canonical
//! path), is fixed at creation (user-selected) or lazily minted at the first
//! disk-need moment, and never changes afterwards. Files are user assets --
//! closing or deleting a session never removes a non-empty workspace; only an
//! App-minted still-empty one is reclaimed at close.

use std::io;
use std::path::{Path, PathBuf};

/// The directory name holding App-minted default workspaces, placed BESIDE
/// the DEFAULT sessions root in the product's Documents domain (see
/// [`resolve_workspaces_root`]).
pub(crate) const WORKSPACES_DIR_NAME: &str = "workspaces";

/// Resolve the App-minted workspaces root: the SIBLING
/// `<parent>/workspaces/` of the path passed in (ADR-0137, issue #1381).
/// Workspace files are user assets -- the peer placement keeps them out of
/// the session-tree domain the user never browses (a pile of UUID
/// directories), matching the fully-separated precedent of the surveyed
/// harnesses. The caller passes `default_sessions_root` -- NOT the
/// user-overridden `set_sessions_dir` root: workspaces are fixed in the
/// product's Documents domain and do NOT follow a sessions-dir relocation
/// (assets keep their home when storage configuration moves; a bound
/// workspace's absolute recipe path is unaffected either way). A sessions
/// root with no parent (a volume root, e.g. `C:\`) falls back to
/// `<root>/workspaces` -- the same location there (a volume root has no
/// sibling).
pub(crate) fn resolve_workspaces_root(default_sessions_root: &Path) -> PathBuf {
    default_sessions_root
        .parent()
        .unwrap_or(default_sessions_root)
        .join(WORKSPACES_DIR_NAME)
}

/// The workspace directory-name format (ADR-0137): local time, six dash-
/// separated zero-padded numbers, e.g. `2026-09-30-10-30-28`.
const NAME_FORMAT: &str = "%Y-%m-%d-%H-%M-%S";

/// Mint a fresh default workspace (ADR-0137, issue #1381):
/// `{root}/YYYY-MM-DD-HH-MM-SS/` taken from LOCAL time. A same-second
/// collision with an existing directory bumps the timestamp by one second and
/// retries until a free name lands -- parallel sessions in one process (and
/// one timestamp second) therefore never share a directory by accident.
/// `create_dir` (not `_all`) is the collision check: its `AlreadyExists`
/// error is exactly the signal to advance.
pub(crate) fn mint_workspace(
    root: &Path,
    now: chrono::DateTime<chrono::Local>,
) -> io::Result<PathBuf> {
    // The root itself may not exist yet (first-ever mint); creating it is
    // idempotent and races safely across threads.
    std::fs::create_dir_all(root)?;
    let mut stamp = now;
    loop {
        let dir = root.join(stamp.format(NAME_FORMAT).to_string());
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            // Same-second collision (AC #1381): advance one second and retry.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                stamp += chrono::Duration::seconds(1);
            }
            Err(e) => return Err(e),
        }
    }
}

/// The directory-name cap for a named workspace (issue #1393): the UI guard
/// and the backend check share this bound.
pub(crate) const NAMED_WORKSPACE_MAX_CHARS: usize = 64;

/// Validate a NAMED workspace's directory name (issue #1393): non-empty after
/// trimming, at most [`NAMED_WORKSPACE_MAX_CHARS`] characters, and free of the
/// path-illegal set (separators plus the Windows-reserved punctuation) and
/// control characters. The caller validates the TRIMMED spelling; the input is
/// rejected, never silently rewritten -- a rewritten directory name would not
/// match what the user expects to find later.
pub(crate) fn validate_workspace_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("workspace name is empty".to_string());
    }
    if name.chars().count() > NAMED_WORKSPACE_MAX_CHARS {
        return Err(format!(
            "workspace name exceeds {NAMED_WORKSPACE_MAX_CHARS} characters"
        ));
    }
    if name.chars().any(|c| {
        matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
    }) {
        return Err("workspace name contains a path-illegal or control character".to_string());
    }
    Ok(())
}

/// Mint a NAMED workspace (issue #1393): `{root}/<trimmed name>/`. Unlike the
/// timestamp mint this is an EXPLICIT user asset -- the name is the user's,
/// taken verbatim (validated, never rewritten), and the directory is exempt
/// from the close-time empty reclaim by construction: [`is_app_minted`]
/// requires the timestamp name shape, which a named directory never carries.
/// A same-name directory that already EXISTS is not an error -- the caller's
/// "select the existing one" semantics: the path returns with
/// `created == false` so the caller records the LRU bump without touching the
/// existing record's title. The returned path is canonicalized like the other
/// mints (one spelling per directory, ADR-0137 Decision 1), degrading to the
/// joined spelling if canonicalize fails.
pub(crate) fn mint_named_workspace(root: &Path, name: &str) -> Result<(PathBuf, bool), String> {
    let trimmed = name.trim();
    validate_workspace_name(trimmed)?;
    std::fs::create_dir_all(root).map_err(|e| format!("workspaces root unavailable: {e}"))?;
    let dir = root.join(trimmed);
    if dir.is_dir() {
        let canonical = std::fs::canonicalize(&dir).unwrap_or(dir);
        return Ok((canonical, false));
    }
    std::fs::create_dir(&dir).map_err(|e| format!("failed to mint the workspace: {e}"))?;
    let canonical = std::fs::canonicalize(&dir).unwrap_or(dir);
    Ok((canonical, true))
}

/// Whether a bound workspace path is App-minted (ADR-0137, issue #1381):
/// directly under the managed `workspaces/` root AND carrying the timestamp
/// name shape. The shape check keeps a user-created directory inside the
/// managed root from being mistaken for a reclaimable one; a workspace the
/// App minted always satisfies both by construction. The parent check
/// accepts either spelling: the seated root verbatim, or the canonicalized
/// pair -- a lazily-minted binding canonicalizes at mint time and the
/// command layer canonicalizes user-selected bindings, so the bound
/// spelling can differ from the seated root's.
pub(crate) fn is_app_minted(workspace: &Path, root: &Path) -> bool {
    is_timestamp_name(workspace)
        && (workspace.parent() == Some(root)
            || match (
                std::fs::canonicalize(workspace),
                std::fs::canonicalize(root),
            ) {
                (Ok(w), Ok(r)) => w.parent() == Some(&r),
                _ => false,
            })
}

/// Whether the final path component parses as the minted timestamp shape.
/// Parsed with the SAME [`NAME_FORMAT`] the mint writes, so the two faces of
/// the format (write + reclaim check) cannot drift apart.
fn is_timestamp_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|name| chrono::NaiveDateTime::parse_from_str(name, NAME_FORMAT).is_ok())
        .unwrap_or(false)
}

/// Reclaim a still-empty App-minted workspace at session close (ADR-0137,
/// issue #1381). `remove_dir` (non-recursive) fails on a non-empty directory,
/// so a workspace holding anything -- agent scratch, a file another session
/// sharing the workspace wrote -- is left untouched by construction. Best
/// effort: a failure (locked, permissions) is logged, never surfaced.
/// Returns `true` only when THIS call removed the directory -- the caller's
/// signal to drop the registry record with it (ADR-0138, issue #1384: a
/// record never outlives its directory through the App's own hand; a
/// user-deleted directory keeps its dangling record, read-time filtered).
pub(crate) fn reclaim_if_empty(workspace: &Path, root: &Path) -> bool {
    if !is_app_minted(workspace, root) {
        return false;
    }
    match std::fs::remove_dir(workspace) {
        Ok(()) => true,
        // A non-empty directory is the normal "keep" case -- not worth a log.
        Err(e) if e.kind() == io::ErrorKind::DirectoryNotEmpty => false,
        // NotFound: already reclaimed or removed by the user; fine.
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => {
            log::warn!(
                target: "toptopduck::session",
                "workspace reclaim skipped for {}: {e}",
                workspace.display()
            );
            false
        }
    }
}

/// Resolve the cwd for one agent-authored process launch (ADR-0137, issue
/// #1381): the bound workspace when one exists -- re-materialized on demand,
/// because an EMPTY workspace a session close reclaimed while another session
/// shared it, or a resume of a reclaimed-empty session, must self-heal at the
/// next launch rather than spawn into a deleted directory. With no binding,
/// this is the first disk-need moment: the default workspace is minted from
/// `workspaces_root` and bound (the caller's `workspace` slot IS the session's
/// single storage, so the mint reaches the next recipe persist). No root
/// available (test constructors) keeps the temp-dir cwd -- the pure-memory
/// fallback.
///
/// A FRESH mint also records into the seated registry (ADR-0138, issue
/// #1384) -- the "session started using this workspace" moment, the one
/// turn-side mount point shared by both launch surfaces (the external
/// runtime's spawn cwd and the built-in CLI tool dispatch). `None` keeps the
/// ledger axis disconnected; a bound-reuse launch never re-records.
pub(crate) fn launch_cwd(
    workspace: Option<&mut Option<PathBuf>>,
    workspaces_root: Option<&Path>,
    temp: &Path,
    registry: Option<&crate::workspace::WorkspaceRegistry>,
) -> Result<PathBuf, String> {
    let Some(workspace) = workspace else {
        // The axis is disconnected (test deps): keep the temp cwd.
        return Ok(temp.to_path_buf());
    };
    if let Some(bound) = workspace.as_ref() {
        std::fs::create_dir_all(bound)
            .map_err(|e| format!("workspace directory unavailable: {e}"))?;
        return Ok(bound.clone());
    }
    let Some(root) = workspaces_root else {
        return Ok(temp.to_path_buf());
    };
    let minted = mint_workspace(root, chrono::Local::now())
        .map_err(|e| format!("failed to mint the default workspace: {e}"))?;
    // Canonicalize at the bind (ADR-0137 Decision 1: one spelling per
    // directory): the command layer canonicalizes user-selected bindings
    // the same way, so the two producers cannot spell one directory
    // differently. The directory exists (just created); a canonicalize
    // failure degrades to the minted spelling rather than failing the
    // launch.
    let minted = std::fs::canonicalize(&minted).unwrap_or(minted);
    if let Some(registry) = registry {
        registry.record(&minted);
    }
    *workspace = Some(minted.clone());
    Ok(minted)
}

impl super::Session {
    /// Seat the lazy-mint source -- the fixed product-domain workspaces
    /// root, the DEFAULT sessions root's sibling (ADR-0137, issue #1381).
    /// Command-layer wiring at creation and resume; `None` (the constructor
    /// default) disables minting.
    pub fn set_workspaces_root(&mut self, root: Option<PathBuf>) {
        self.workspaces_root = root;
    }

    /// Seat the workspace registry (ADR-0138, issue #1384): the ledger the
    /// bind + mint mount points record into and the close-time reclaim
    /// deletes from. Command-layer wiring at creation and resume; `None`
    /// (test constructors) disconnects recording, mirroring
    /// [`Self::set_workspaces_root`].
    pub fn set_workspace_registry(
        &mut self,
        registry: Option<std::sync::Arc<crate::workspace::WorkspaceRegistry>>,
    ) {
        self.workspace_registry = registry;
    }

    /// The seated registry, if the ledger axis is connected (ADR-0138). Read
    /// by close-time record removal.
    pub fn workspace_registry(
        &self,
    ) -> Option<&std::sync::Arc<crate::workspace::WorkspaceRegistry>> {
        self.workspace_registry.as_ref()
    }

    /// Bind an explicit user-selected workspace at creation (ADR-0137, issue
    /// #1381). The caller canonicalizes first (Windows 8.3 short paths would
    /// let one directory appear under two spellings); the binding is
    /// immutable afterwards -- the guard fires if a second bind sneaks past
    /// the creation-time call site.
    pub fn set_workspace(&mut self, canonical: PathBuf) {
        debug_assert!(
            self.runtime_facts.workspace.is_none(),
            "workspace binding is immutable (ADR-0137)"
        );
        // ADR-0138 (issue #1384): binding a session to a workspace is the
        // "session started using it" moment -- the registry write for the
        // create_session mount point (the only production caller; resume
        // restores the binding through the facts literal, so a reopen never
        // re-records). Best-effort inside the ledger: a failed record never
        // fails the bind.
        if let Some(registry) = &self.workspace_registry {
            registry.record(&canonical);
        }
        self.runtime_facts.workspace = Some(canonical);
    }

    /// The bound workspace, if any (ADR-0137, issue #1381). Read by
    /// close-time reclaim.
    pub fn workspace(&self) -> Option<&Path> {
        self.runtime_facts.workspace.as_deref()
    }

    /// The lazy-mint source, if seated (ADR-0137, issue #1381). Read by
    /// close-time reclaim.
    pub fn workspaces_root(&self) -> Option<&Path> {
        self.workspaces_root.as_deref()
    }

    /// The external runtime's `session/new` cwd (ADR-0137, issue #1381): the
    /// bound workspace, lazily minted at this first spawn moment when the
    /// session was created without a directory. The temp-dir fallback survives
    /// only for sessions with no minting source (test constructors).
    pub(super) fn ensure_external_cwd(&mut self) -> Result<String, String> {
        launch_cwd(
            Some(&mut self.runtime_facts.workspace),
            self.workspaces_root.as_deref(),
            &self.temp_path,
            self.workspace_registry.as_deref(),
        )
        .map(|p| p.to_string_lossy().into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(y: i32, m: u32, d: u32, h: u32, min: u32, s: u32) -> chrono::DateTime<chrono::Local> {
        use chrono::TimeZone;
        chrono::Local
            .with_ymd_and_hms(y, m, d, h, min, s)
            .single()
            .expect("valid timestamp")
    }

    #[test]
    fn mint_names_the_directory_with_the_local_timestamp_format() {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = mint_workspace(root.path(), local(2026, 9, 30, 10, 30, 28)).expect("mint");
        assert_eq!(
            dir,
            root.path().join("2026-09-30-10-30-28"),
            "the minted name is YYYY-MM-DD-HH-MM-SS"
        );
        assert!(dir.is_dir(), "the directory exists");
    }

    #[test]
    fn workspaces_root_is_the_default_sessions_roots_sibling() {
        // The fixed placement: beside the DEFAULT sessions root in the
        // product's Documents domain -- not inside the UUID session-tree
        // domain, and not derived from a user-overridden sessions dir.
        assert_eq!(
            resolve_workspaces_root(Path::new("/home/u/Documents/TOPTOPDuck/sessions")),
            Path::new("/home/u/Documents/TOPTOPDuck/workspaces")
        );
    }

    // A volume-root sessions root has no sibling -- the same volume root
    // hosts the workspaces directory directly. The root shape is per-OS:
    // `C:\` on Windows, `/` on Unix (a backslash is not a separator there,
    // so the Windows spelling is a one-component RELATIVE path on Unix and
    // never exercises the no-parent fallback).
    #[test]
    #[cfg(windows)]
    fn volume_root_sessions_root_hosts_workspaces_directly() {
        assert_eq!(
            resolve_workspaces_root(Path::new("C:\\")),
            Path::new("C:\\workspaces")
        );
    }

    #[test]
    #[cfg(unix)]
    fn volume_root_sessions_root_hosts_workspaces_directly() {
        assert_eq!(
            resolve_workspaces_root(Path::new("/")),
            Path::new("/workspaces")
        );
    }

    #[test]
    fn mint_advances_one_second_on_a_same_second_collision() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(root.path().join("2026-09-30-10-30-28")).expect("seed collision");
        let dir = mint_workspace(root.path(), local(2026, 9, 30, 10, 30, 28)).expect("mint");
        assert_eq!(
            dir,
            root.path().join("2026-09-30-10-30-29"),
            "the later minter takes the next second"
        );
    }

    #[test]
    fn mint_retries_until_a_free_second_lands() {
        let root = tempfile::tempdir().expect("tempdir");
        for s in [28, 29, 30] {
            std::fs::create_dir(root.path().join(format!("2026-09-30-10-30-{s:02}")))
                .expect("seed collision");
        }
        let dir = mint_workspace(root.path(), local(2026, 9, 30, 10, 30, 28)).expect("mint");
        assert_eq!(
            dir,
            root.path().join("2026-09-30-10-30-31"),
            "the mint walks +1s until the directory is free"
        );
    }

    #[test]
    fn mint_named_takes_the_trimmed_name_verbatim_and_marks_it_created() {
        let root = tempfile::tempdir().expect("tempdir");
        let (dir, created) = mint_named_workspace(root.path(), "  my analysis ").expect("mint");
        assert!(created, "a fresh name mints");
        assert_eq!(
            dir.canonicalize().expect("canonicalize"),
            root.path()
                .join("my analysis")
                .canonicalize()
                .expect("canonicalize joined"),
            "the trimmed name is the directory name, verbatim (spaces included)"
        );
    }

    #[test]
    fn mint_named_returns_an_existing_directory_uncreated() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(root.path().join("alpha")).expect("seed");
        let (dir, created) = mint_named_workspace(root.path(), "alpha").expect("mint");
        assert!(
            !created,
            "an existing same-name directory selects, no error"
        );
        assert!(dir.ends_with("alpha"));
    }

    #[test]
    fn mint_named_rejects_empty_overlong_and_illegal_names() {
        let root = tempfile::tempdir().expect("tempdir");
        assert!(
            mint_named_workspace(root.path(), "   ").is_err(),
            "whitespace-only trims to empty"
        );
        assert!(
            mint_named_workspace(root.path(), "a/b").is_err(),
            "a separator is rejected"
        );
        assert!(
            mint_named_workspace(root.path(), "a:b").is_err(),
            "the Windows-reserved colon is rejected"
        );
        assert!(
            mint_named_workspace(root.path(), &"x".repeat(NAMED_WORKSPACE_MAX_CHARS + 1)).is_err(),
            "over the cap"
        );
        assert!(
            mint_named_workspace(root.path(), &"x".repeat(NAMED_WORKSPACE_MAX_CHARS)).is_ok(),
            "at the cap mints"
        );
        assert!(
            mint_named_workspace(root.path(), "ok name").is_ok(),
            "spaces are legal"
        );
    }

    #[test]
    fn reclaim_never_takes_a_named_workspace_even_empty() {
        // The shape check IS the exemption: a named directory inside the
        // managed root is a user asset, never a reclaimable App-minted one.
        let root = tempfile::tempdir().expect("tempdir");
        let (dir, _) = mint_named_workspace(root.path(), "keep-me").expect("mint");
        assert!(!reclaim_if_empty(&dir, root.path()));
        assert!(dir.exists(), "an empty named workspace is kept");
    }

    #[test]
    fn is_app_minted_requires_managed_parent_and_timestamp_shape() {
        let root = Path::new("/sessions/workspaces");
        assert!(is_app_minted(&root.join("2026-09-30-10-30-28"), root));
        assert!(
            !is_app_minted(&root.join("my-analysis"), root),
            "a non-timestamp name inside the root is not App-minted"
        );
        assert!(
            !is_app_minted(Path::new("/home/user/project"), root),
            "a directory outside the root is never App-minted"
        );
        assert!(
            !is_app_minted(Path::new("/home/user/2026-09-30-10-30-28"), root),
            "a timestamp-named directory outside the root is not App-minted"
        );
    }

    #[test]
    fn is_app_minted_accepts_the_canonical_spelling_of_a_minted_directory() {
        // A lazily-minted binding canonicalizes at mint time while the
        // seated root keeps its raw spelling (an 8.3 temp root on Windows)
        // -- reclaim must still recognize the directory.
        let root = tempfile::tempdir().expect("tempdir");
        let dir = mint_workspace(root.path(), chrono::Local::now()).expect("mint");
        let canonical = std::fs::canonicalize(&dir).expect("canonicalize");
        assert!(
            is_app_minted(&canonical, root.path()),
            "the canonical spelling of a minted directory stays reclaimable"
        );
    }

    #[test]
    fn reclaim_removes_an_empty_app_minted_workspace() {
        let root = tempfile::tempdir().expect("tempdir");
        let now = chrono::Local::now();
        let dir = mint_workspace(root.path(), now).expect("mint");
        reclaim_if_empty(&dir, root.path());
        assert!(!dir.exists(), "the empty workspace is reclaimed");
    }

    #[test]
    fn reclaim_keeps_a_workspace_with_content() {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = mint_workspace(root.path(), chrono::Local::now()).expect("mint");
        std::fs::write(dir.join("analysis.py"), "print(1)").expect("seed file");
        reclaim_if_empty(&dir, root.path());
        assert!(dir.exists(), "a non-empty workspace is never reclaimed");
    }

    #[test]
    fn reclaim_never_touches_a_user_directory() {
        let root = tempfile::tempdir().expect("tempdir");
        let user = tempfile::tempdir().expect("user dir"); // outside the root, empty
        reclaim_if_empty(user.path(), root.path());
        assert!(user.path().exists(), "an empty user directory is kept");
    }

    #[test]
    fn launch_cwd_mints_and_binds_on_the_first_need() {
        let mut workspace = None;
        let root = tempfile::tempdir().expect("tempdir");
        let temp = tempfile::tempdir().expect("temp");
        let dir =
            launch_cwd(Some(&mut workspace), Some(root.path()), temp.path(), None).expect("launch");
        // The mint binds canonicalized, which can differ from the seated
        // root's spelling -- assert the containment canonically.
        assert!(
            dir.canonicalize()
                .expect("canonicalize")
                .starts_with(root.path().canonicalize().expect("canonicalize root")),
            "the mint lands under the root"
        );
        assert!(dir.is_dir());
        assert_eq!(workspace.as_deref(), Some(dir.as_path()), "the mint binds");

        // The second launch reuses the binding -- no second directory.
        let again =
            launch_cwd(Some(&mut workspace), Some(root.path()), temp.path(), None).expect("launch");
        assert_eq!(again, dir);
        assert_eq!(
            std::fs::read_dir(root.path()).expect("read root").count(),
            1
        );
    }

    #[test]
    fn launch_cwd_rematerializes_a_reclaimed_bound_workspace() {
        let mut workspace = None;
        let root = tempfile::tempdir().expect("tempdir");
        let temp = tempfile::tempdir().expect("temp");
        let dir =
            launch_cwd(Some(&mut workspace), Some(root.path()), temp.path(), None).expect("mint");
        std::fs::remove_dir(&dir).expect("reclaim seed"); // a close reclaimed it empty
        let again =
            launch_cwd(Some(&mut workspace), Some(root.path()), temp.path(), None).expect("launch");
        assert_eq!(again, dir, "the immutable binding is reused, not re-minted");
        assert!(dir.is_dir(), "the directory is re-created on demand");
    }

    #[test]
    fn launch_cwd_keeps_the_temp_cwd_without_a_mint_source() {
        let mut workspace = None;
        let temp = tempfile::tempdir().expect("temp");
        let dir = launch_cwd(Some(&mut workspace), None, temp.path(), None).expect("launch");
        assert_eq!(dir, temp.path(), "no root -> the temp cwd stays");
        assert!(workspace.is_none(), "nothing is bound");
    }

    #[test]
    fn ensure_external_cwd_mints_under_the_seated_root() {
        let mut session = super::super::Session::new().expect("session");
        let root = tempfile::tempdir().expect("tempdir");
        session.set_workspaces_root(Some(root.path().to_path_buf()));
        let cwd = session.ensure_external_cwd().expect("cwd");
        // The mint binds canonicalized, which can differ from the seated
        // root's spelling -- assert the containment canonically, not by
        // string prefix (a sibling directory sharing the prefix would
        // satisfy a string check).
        assert_eq!(
            Path::new(&cwd)
                .canonicalize()
                .expect("canonicalize cwd")
                .parent(),
            Some(
                root.path()
                    .canonicalize()
                    .expect("canonicalize root")
                    .as_path()
            ),
            "the mint lands under the seated root"
        );
        assert_eq!(
            session.workspace(),
            Some(Path::new(&cwd)),
            "the mint lands on the session's single storage"
        );
    }

    #[test]
    fn an_explicit_workspace_is_bound_verbatim_and_projects_into_the_recipe() {
        let mut session = super::super::Session::new().expect("session");
        let user = tempfile::tempdir().expect("user dir");
        session.set_workspace(user.path().to_path_buf());
        assert_eq!(session.workspace(), Some(user.path()));
        let recipe = session.build_recipe();
        assert_eq!(recipe.workspace.as_deref(), Some(user.path()));
    }

    fn test_registry(dir: &std::path::Path) -> std::sync::Arc<crate::workspace::WorkspaceRegistry> {
        std::sync::Arc::new(crate::workspace::WorkspaceRegistry::new(
            dir.join(crate::workspace::WORKSPACES_FILE_NAME),
        ))
    }

    #[test]
    fn binding_a_workspace_records_into_the_seated_registry() {
        // ADR-0138 (issue #1384): the create_session mount point. Two
        // sessions sharing one registry bind the same canonical path: ONE
        // record, the LRU stamp riding the second bind. An unseated registry
        // (the pre-#1384 constructor default) records nothing.
        let dir = tempfile::tempdir().expect("registry dir");
        let registry = test_registry(dir.path());
        let user = tempfile::tempdir().expect("user dir");
        let canonical = std::fs::canonicalize(user.path()).expect("canonicalize");

        let mut a = super::super::Session::new().expect("session a");
        a.set_workspace_registry(Some(std::sync::Arc::clone(&registry)));
        a.set_workspace(canonical.clone());

        let mut b = super::super::Session::new().expect("session b");
        b.set_workspace_registry(Some(std::sync::Arc::clone(&registry)));
        b.set_workspace(canonical.clone());

        let recent = registry.recent();
        assert_eq!(
            recent.len(),
            1,
            "canonical-equal binds collapse to one record"
        );
        assert_eq!(
            recent[0].path, canonical,
            "the record carries the canonical spelling"
        );

        let mut unseated = super::super::Session::new().expect("session");
        let other = tempfile::tempdir().expect("other dir");
        unseated.set_workspace(std::fs::canonicalize(other.path()).expect("canonicalize"));
        assert_eq!(
            registry.recent().len(),
            1,
            "an unseated registry records nothing"
        );
    }

    #[test]
    fn a_lazy_mint_records_into_the_seated_registry() {
        // ADR-0138 (issue #1384): the turn mount point (external spawn arm).
        // The first disk-need mint records; a later launch reuses the
        // binding without a second record.
        let dir = tempfile::tempdir().expect("registry dir");
        let registry = test_registry(dir.path());
        let mut session = super::super::Session::new().expect("session");
        let root = tempfile::tempdir().expect("workspaces root");
        session.set_workspaces_root(Some(root.path().to_path_buf()));
        session.set_workspace_registry(Some(std::sync::Arc::clone(&registry)));
        session.ensure_external_cwd().expect("cwd");
        let recent = registry.recent();
        assert_eq!(recent.len(), 1, "the fresh mint records");
        assert_eq!(
            Some(recent[0].path.as_path()),
            session.workspace(),
            "the record carries the canonical bound spelling"
        );
        session.ensure_external_cwd().expect("cwd again");
        assert_eq!(registry.recent().len(), 1, "the reuse adds no record");
    }

    #[test]
    fn a_cli_launch_mint_records_through_the_turn_deps() {
        // ADR-0138 (issue #1384): the turn mount point's other arm -- the
        // built-in CLI tool dispatch resolves its launch dir through
        // TurnDeps, and a fresh mint records there too (the None axis stays
        // disconnected for test deps).
        use crate::session::materializer::TurnDeps;

        let dir = tempfile::tempdir().expect("registry dir");
        let registry = test_registry(dir.path());
        let root = tempfile::tempdir().expect("workspaces root");
        let temp = tempfile::tempdir().expect("temp");
        let engine = crate::session::engine::AdminEngine::materialized();
        let mut working_set = crate::workingset::WorkingSet::default();
        let mut sources = std::collections::HashMap::new();
        let mut refs = std::collections::HashMap::new();
        let mut deps = TurnDeps::test_deps(
            &engine,
            &mut working_set,
            &mut sources,
            temp.path(),
            &mut refs,
        );
        let mut slot: Option<std::path::PathBuf> = None;
        deps.workspace = Some(&mut slot);
        deps.workspaces_root = Some(root.path().to_path_buf());
        deps.workspace_registry = Some(&registry);
        deps.launch_dir().expect("launch");
        let recent = registry.recent();
        assert_eq!(recent.len(), 1, "the fresh mint records");
        deps.launch_dir().expect("launch again");
        assert_eq!(registry.recent().len(), 1, "the reuse adds no record");
    }
}
