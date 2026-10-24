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

/// The directory under `sessions_root` holding App-minted default workspaces.
pub(crate) const WORKSPACES_DIR_NAME: &str = "workspaces";

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

/// Whether a bound workspace path is App-minted (ADR-0137, issue #1381):
/// directly under the managed `workspaces/` root AND carrying the timestamp
/// name shape. The shape check keeps a user-created directory inside the
/// managed root from being mistaken for a reclaimable one; a workspace the
/// App minted always satisfies both by construction.
pub(crate) fn is_app_minted(workspace: &Path, root: &Path) -> bool {
    workspace.parent() == Some(root) && is_timestamp_name(workspace)
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
pub(crate) fn reclaim_if_empty(workspace: &Path, root: &Path) {
    if !is_app_minted(workspace, root) {
        return;
    }
    match std::fs::remove_dir(workspace) {
        Ok(()) => {}
        // A non-empty directory is the normal "keep" case -- not worth a log.
        Err(e) if e.kind() == io::ErrorKind::DirectoryNotEmpty => {}
        // NotFound: already reclaimed or removed by the user; fine.
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            log::debug!(
                target: "toptopduck::session",
                "workspace reclaim skipped for {}: {e}",
                workspace.display()
            );
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
pub(crate) fn launch_cwd(
    workspace: Option<&mut Option<PathBuf>>,
    workspaces_root: Option<&Path>,
    temp: &Path,
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
    *workspace = Some(minted.clone());
    Ok(minted)
}

impl super::Session {
    /// Seat the lazy-mint source `{sessions_root}/workspaces/` (ADR-0137,
    /// issue #1381). Command-layer wiring at creation and resume; `None`
    /// (the constructor default) disables minting.
    pub fn set_workspaces_root(&mut self, root: Option<PathBuf>) {
        self.workspaces_root = root;
    }

    /// Bind an explicit user-selected workspace at creation (ADR-0137, issue
    /// #1381). The caller canonicalizes first (Windows 8.3 short paths would
    /// let one directory appear under two spellings); the binding is
    /// immutable afterwards.
    pub fn set_workspace(&mut self, canonical: PathBuf) {
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
        let dir = launch_cwd(Some(&mut workspace), Some(root.path()), temp.path()).expect("launch");
        assert!(
            dir.starts_with(root.path()),
            "the mint lands under the root"
        );
        assert!(dir.is_dir());
        assert_eq!(workspace.as_deref(), Some(dir.as_path()), "the mint binds");

        // The second launch reuses the binding -- no second directory.
        let again =
            launch_cwd(Some(&mut workspace), Some(root.path()), temp.path()).expect("launch");
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
        let dir = launch_cwd(Some(&mut workspace), Some(root.path()), temp.path()).expect("mint");
        std::fs::remove_dir(&dir).expect("reclaim seed"); // a close reclaimed it empty
        let again =
            launch_cwd(Some(&mut workspace), Some(root.path()), temp.path()).expect("launch");
        assert_eq!(again, dir, "the immutable binding is reused, not re-minted");
        assert!(dir.is_dir(), "the directory is re-created on demand");
    }

    #[test]
    fn launch_cwd_keeps_the_temp_cwd_without_a_mint_source() {
        let mut workspace = None;
        let temp = tempfile::tempdir().expect("temp");
        let dir = launch_cwd(Some(&mut workspace), None, temp.path()).expect("launch");
        assert_eq!(dir, temp.path(), "no root -> the temp cwd stays");
        assert!(workspace.is_none(), "nothing is bound");
    }

    #[test]
    fn ensure_external_cwd_mints_under_the_seated_root() {
        let mut session = super::super::Session::new().expect("session");
        let root = tempfile::tempdir().expect("tempdir");
        session.set_workspaces_root(Some(root.path().to_path_buf()));
        let cwd = session.ensure_external_cwd().expect("cwd");
        assert!(cwd.starts_with(root.path().to_string_lossy().as_ref()));
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
}
