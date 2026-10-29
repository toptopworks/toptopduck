//! The workspace registry (ADR-0138, issue #1384): the domain ledger of
//! workspaces as logical units over directories, persisted as
//! `workspaces.json` under the OS app-data dir. Deliberately OUTSIDE
//! app-config: machine bookkeeping vs user preference differ in semantics,
//! write frequency, and lifecycle. See [`super`] for the domain split
//! against the execution axis.
//!
//! Failure stance -- honest-degrade on both faces: a missing or corrupt file
//! reads as an EMPTY registry (the selector lists nothing; a rebuild from
//! actual usage costs nothing but LRU ordering), and a write onto a corrupt
//! file refuses rather than persisting "defaults + this one record" (the
//! app-config read-for-write rule, issue #602). Every entry point
//! log-and-continues on failure: bookkeeping never fails a session creation,
//! a turn, or a close.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use uuid::Uuid;

use crate::persistence::io::{write_str_atomic, WritePerms};

/// The registry file name (resolved against the OS app-data dir by the setup
/// hook, the same anchoring the adapter registry uses).
pub const WORKSPACES_FILE_NAME: &str = "workspaces.json";
/// The one document version this build reads and writes. A NEWER file reads
/// as empty (honest-degrade); an older one does not exist yet.
const WORKSPACES_FORMAT_VERSION: u32 = 1;

/// One workspace record (ADR-0138 Decision 3): the logical unit over a
/// directory. `path` is the CANONICAL spelling (the uniqueness key and the
/// membership-check basis, never rewritten -- canonical equality means the
/// same record), produced by the same canonicalize the session binding uses.
/// `title` is absent until the rename surface lands (the display pipeline
/// derives the directory tail as the default). `created_at` is recorded at
/// creation because a directory's stat is unreliable under copy/move -- an
/// observation that cannot be rebuilt later. `last_used_at` is pinned to
/// "a session STARTED using this workspace" (the LRU sort key) so a future
/// rename mutation cannot pollute the ordering.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WorkspaceRecord {
    pub id: Uuid,
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Whether the user explicitly chose this workspace (issue #1392): a
    /// create-session binding, a named mint, or an existing-directory
    /// selection rides here as `true`; the lazy mint and a resume restore
    /// leave it untouched. Only explicit records surface in the sidebar's
    /// workspace section. Additive (serde default false, `false` never
    /// serializes); the upgrade is one-way -- leaving the section is the
    /// remove action's job, never an implicit demotion.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub explicit: bool,
    /// Epoch milliseconds.
    pub created_at: u64,
    /// Epoch milliseconds.
    pub last_used_at: u64,
}

impl WorkspaceRecord {
    /// The display name (ADR-0138 Decision 5): the explicit title when set,
    /// otherwise the directory tail. The full path is never the display
    /// face; duplicates are told apart by LRU order.
    pub fn label(&self) -> String {
        match &self.title {
            Some(title) => title.clone(),
            None => directory_tail(&self.path),
        }
    }
}

/// The untitled display fallback: the directory tail, or the whole path
/// when it has no final component. Shared by the record face, the
/// registry's label lookup, and the tray's no-registry fallback (issue
/// #1430) so the faces cannot drift.
pub(crate) fn directory_tail(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// The persisted document. `version` self-managed (no app-config
/// `format_version` involvement); unknown future FIELDS on a record read
/// through serde-default tolerance where additive (the `title` precedent).
#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct WorkspacesDoc {
    version: u32,
    #[serde(default)]
    workspaces: Vec<WorkspaceRecord>,
}

/// The registry store: one file + the in-process write lock serializing the
/// read-modify-write entries (the `LiveProviderConfig` write-lock family --
/// without coordination two writers interleave and lose an entire record).
/// Shared as `Arc<WorkspaceRegistry>` between the Tauri state and every
/// `Session` the command layer seats it on.
pub struct WorkspaceRegistry {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl WorkspaceRegistry {
    /// Wrap the resolved app-data path (created by the setup hook with the
    /// same honest temp-dir fallback the other app-data roots use).
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    /// The single write point for both mount points (ADR-0138 Decision 4):
    /// `create_session`'s explicit binding and the turn-time default mint.
    /// A canonical-equal path is the SAME record (bump `last_used_at` only);
    /// an absent path inserts a new record (fresh id, no title, both stamps
    /// now). Best-effort: a failure logs and continues -- the ledger never
    /// fails the caller's session event.
    pub fn record(&self, canonical: &Path) {
        if let Err(detail) = self.record_at(canonical, None, false, now_millis()) {
            log::warn!(
                target: "toptopduck::workspace_registry",
                "workspace record for {} not written: {detail}",
                canonical.display()
            );
        }
    }

    /// The named-workspace creation mount point (issue #1393): a fresh mint
    /// records with the user's name as the `title`. On an existing record the
    /// call degrades to [`Self::record`] -- the bump only, the title never
    /// rewrites (identity is immutable, ADR-0138 Decision 3). Unlike
    /// [`Self::record`] this mount FAILS the caller: it serves the explicit
    /// create command, whose essence is the record itself -- not bookkeeping
    /// riding a session event, which is the reach of ADR-0138's best-effort
    /// stance. A record that never lands must not report a successful create.
    pub fn record_titled(&self, canonical: &Path, title: &str) -> Result<(), String> {
        self.record_at(canonical, Some(title), true, now_millis())
    }

    /// The create-session explicit-binding mount (issue #1392): the user
    /// chose this directory for the session, so the record carries
    /// `explicit` and joins the sidebar's workspace section. Best-effort
    /// like [`Self::record`] -- bookkeeping never fails the bind.
    pub fn record_selected(&self, canonical: &Path) {
        if let Err(detail) = self.record_at(canonical, None, true, now_millis()) {
            log::warn!(
                target: "toptopduck::workspace_registry",
                "workspace record for {} not written: {detail}",
                canonical.display()
            );
        }
    }

    /// The display label for one canonical path (issue #1393): the record's
    /// face when a record carries it, otherwise the directory-tail
    /// derivation -- the SAME projection the recent list shows, for the
    /// selector's existing-directory branch (a same-name mint that found a
    /// never-recorded directory still needs a label).
    pub fn label_of(&self, canonical: &Path) -> String {
        self.load()
            .into_iter()
            .find(|r| r.path == canonical)
            .map(|r| r.label())
            .unwrap_or_else(|| directory_tail(canonical))
    }

    /// The rename surface (issue #1392): overwrites the record's `title` in
    /// place -- path, id, and stamps are identity and never rewrite, and
    /// `last_used_at` stays put (a rename is not a use). Duplicate titles
    /// are allowed; the LRU order tells duplicates apart. Strict (unlike
    /// the best-effort bookkeeping): the caller serves an explicit user
    /// action, so a missing record or a refused write surfaces.
    pub fn rename(&self, canonical: &Path, title: &str) -> Result<(), String> {
        let Ok(_guard) = self.write_lock.lock() else {
            return Err("workspace registry write lock poisoned".to_string());
        };
        let mut records = self.load_for_write()?;
        match records.iter_mut().find(|r| r.path == canonical) {
            Some(record) => record.title = Some(title.to_string()),
            None => return Err(format!("no workspace record for {}", canonical.display())),
        }
        self.save(&records)
    }

    /// The reclaim-time counterpart (ADR-0138 Decision 4): a reclaimed empty
    /// App-minted workspace deletes its record -- a record never outlives
    /// its directory through the App's own hand. Best-effort like `record`.
    pub fn remove(&self, canonical: &Path) {
        if let Err(detail) = self.remove_inner(canonical) {
            log::warn!(
                target: "toptopduck::workspace_registry",
                "workspace record for {} not removed: {detail}",
                canonical.display()
            );
        }
    }

    /// The user-facing remove (issue #1392): deletes the record, keeps the
    /// directory -- the sidebar's "remove from list" is a ledger edit, not
    /// a filesystem delete, and the section's sessions fall back to the
    /// recent list. Strict like [`Self::rename`]: an explicit user action
    /// reports a refused write. Returns whether a record was deleted; an
    /// unknown path is a miss (false), never a refusal -- the command
    /// layer retries the echoed spelling on that miss.
    pub fn remove_record(&self, canonical: &Path) -> Result<bool, String> {
        self.remove_inner(canonical)
    }

    /// The existence-filtered LRU view: records whose directory still
    /// exists, sorted `last_used_at` descending (path ascending breaks ties
    /// so the order is deterministic). The selector filters the full
    /// listing client-side (issue #1392), so this view now serves as the
    /// tests' oracle for the filter -- dangling records are KEPT in the
    /// store and merely skipped here; a user-deleted directory may come
    /// back (a bound session's next launch re-creates it on demand), so
    /// hiding beats deleting.
    pub fn recent(&self) -> Vec<WorkspaceRecord> {
        let mut records = self.load();
        records.retain(|r| r.path.exists());
        sort_lru(&mut records);
        records
    }

    /// The sidebar section's view (issue #1392): every record in the same
    /// LRU order as [`Self::recent`], dangling records INCLUDED -- the
    /// section keeps them with a missing-state hint instead of letting a
    /// group vanish silently.
    pub fn all(&self) -> Vec<WorkspaceRecord> {
        let mut records = self.load();
        sort_lru(&mut records);
        records
    }

    /// [`Self::record`] with an injectable clock and title for tests. The
    /// title lands only on a NEW record -- an existing one takes the LRU bump
    /// alone (a titled call on a known path degrades to the plain record).
    pub(crate) fn record_at(
        &self,
        canonical: &Path,
        title: Option<&str>,
        explicit: bool,
        now: u64,
    ) -> Result<(), String> {
        let Ok(_guard) = self.write_lock.lock() else {
            return Err("workspace registry write lock poisoned".to_string());
        };
        let mut records = self.load_for_write()?;
        match records.iter_mut().find(|r| r.path == canonical) {
            // Same canonical path: one record, LRU bump only (created_at, id,
            // and title are identity and never rewrite). The explicit mark is
            // the one-way upgrade: a lazily-minted record the user later
            // binds explicitly joins the sidebar section for good.
            Some(existing) => {
                existing.last_used_at = now;
                if explicit {
                    existing.explicit = true;
                }
            }
            None => records.push(WorkspaceRecord {
                id: Uuid::new_v4(),
                path: canonical.to_path_buf(),
                title: title.map(str::to_string),
                explicit,
                created_at: now,
                last_used_at: now,
            }),
        }
        self.save(&records)
    }

    /// Returns whether a record was deleted (false = never recorded /
    /// already gone -- the idempotent miss the callers branch on).
    fn remove_inner(&self, canonical: &Path) -> Result<bool, String> {
        let Ok(_guard) = self.write_lock.lock() else {
            return Err("workspace registry write lock poisoned".to_string());
        };
        let mut records = self.load_for_write()?;
        let before = records.len();
        records.retain(|r| r.path != canonical);
        if records.len() == before {
            return Ok(false); // nothing to remove (never recorded / already gone)
        }
        self.save(&records)?;
        Ok(true)
    }

    /// The tolerant read (both faces): a missing file is the first-run
    /// state; ANY other failure degrades to empty with a warn so a broken
    /// file stays diagnosable from the log dir.
    fn load(&self) -> Vec<WorkspaceRecord> {
        match self.load_for_write() {
            Ok(records) => records,
            Err(detail) => {
                log::warn!(
                    target: "toptopduck::workspace_registry",
                    "workspace registry {} unreadable, reading empty: {detail}",
                    self.path.display()
                );
                Vec::new()
            }
        }
    }

    /// The read half of a read-modify-write: a missing file is the correct
    /// empty start; a corrupt EXISTING file refuses (surfaced by the public
    /// entries) so a rewrite can never persist "empty + this one record".
    fn load_for_write(&self) -> Result<Vec<WorkspaceRecord>, String> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("read {}: {e}", self.path.display())),
        };
        let doc: WorkspacesDoc = serde_json::from_str(&raw)
            .map_err(|e| format!("parse {}: {e}", self.path.display()))?;
        if doc.version > WORKSPACES_FORMAT_VERSION {
            return Err(format!(
                "{} carries version {} (this build reads {})",
                self.path.display(),
                doc.version,
                WORKSPACES_FORMAT_VERSION
            ));
        }
        Ok(doc.workspaces)
    }

    /// Serialize + persist: pretty JSON (hand-editable, stable diffs), the
    /// records sorted by path so the file bytes depend only on the record
    /// SET, never on the write order. One ride on the shared atomic-write
    /// core (a crash before the rename leaves the prior file intact).
    fn save(&self, records: &[WorkspaceRecord]) -> Result<(), String> {
        let mut sorted = records.to_vec();
        sorted.sort_by(|a, b| a.path.cmp(&b.path));
        let doc = WorkspacesDoc {
            version: WORKSPACES_FORMAT_VERSION,
            workspaces: sorted,
        };
        let json = serde_json::to_string_pretty(&doc).map_err(|e| format!("serialize: {e}"))?;
        // The registry file's directory may not exist yet (first write on a
        // fresh install); the shared core deliberately does not create it.
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
        }
        write_str_atomic(&self.path, &json, WritePerms::Default).map_err(|e| e.to_string())
    }
}

fn now_millis() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// The one LRU order every listing view shows: `last_used_at` descending,
/// path ascending breaking ties so the order is deterministic.
fn sort_lru(records: &mut [WorkspaceRecord]) {
    records.sort_by(|a, b| {
        b.last_used_at
            .cmp(&a.last_used_at)
            .then_with(|| a.path.cmp(&b.path))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(dir: &tempfile::TempDir) -> WorkspaceRegistry {
        WorkspaceRegistry::new(dir.path().join(WORKSPACES_FILE_NAME))
    }

    fn dir_under(root: &Path, name: &str) -> PathBuf {
        let p = root.join(name);
        std::fs::create_dir_all(&p).expect("mkdir");
        p
    }

    #[test]
    fn record_creates_one_record_per_canonical_path_and_bumps_last_used() {
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let a = dir_under(root.path(), "alpha");
        let b = dir_under(root.path(), "beta");
        reg.record_at(&a, None, false, 1_000).expect("record a");
        reg.record_at(&b, None, false, 2_000).expect("record b");
        // The SAME path again: no second record, only the LRU bump.
        reg.record_at(&a, None, false, 3_000)
            .expect("record a again");

        let mut recent = reg.recent();
        assert_eq!(
            recent.len(),
            2,
            "canonical-equal paths collapse to one record"
        );
        recent.sort_by_key(|r| r.path.clone());
        let alpha = &recent[0];
        assert_eq!(alpha.last_used_at, 3_000, "the bump lands");
        assert_eq!(alpha.created_at, 1_000, "identity stamps never rewrite");
        assert_eq!(
            alpha.title, None,
            "title is absent until the rename surface"
        );
    }

    #[test]
    fn recent_orders_by_last_used_desc_and_filters_dangling_directories() {
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let old = dir_under(root.path(), "old");
        let fresh = dir_under(root.path(), "fresh");
        let gone = dir_under(root.path(), "gone");
        reg.record_at(&old, None, false, 1_000).expect("record old");
        reg.record_at(&fresh, None, false, 9_000)
            .expect("record fresh");
        reg.record_at(&gone, None, false, 5_000)
            .expect("record gone");
        std::fs::remove_dir(&gone).expect("the directory disappears");

        let recent = reg.recent();
        assert_eq!(
            recent.iter().map(|r| r.path.as_path()).collect::<Vec<_>>(),
            vec![fresh.as_path(), old.as_path()],
            "LRU order with the dangling record hidden but KEPT on disk"
        );
        // The store keeps the dangling record: a read after the directory
        // returns shows it again.
        std::fs::create_dir(&gone).expect("the directory returns");
        assert_eq!(reg.recent().len(), 3, "the kept record resurfaces");
    }

    #[test]
    fn remove_deletes_the_named_record_and_leaves_the_rest() {
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let a = dir_under(root.path(), "alpha");
        let b = dir_under(root.path(), "beta");
        reg.record_at(&a, None, false, 1_000).expect("record a");
        reg.record_at(&b, None, false, 2_000).expect("record b");
        reg.remove(&a);
        let recent = reg.recent();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].path, b, "only the named record is gone");
        // Removing an unknown path is a no-op, not an error.
        reg.remove(&a);
        assert_eq!(reg.recent().len(), 1);
    }

    #[test]
    fn the_file_bytes_depend_on_the_record_set_not_the_write_order() {
        // Same record SET (fixed ids), two registries, records handed to the
        // save path in opposite orders: the path sort on write makes the
        // bytes identical.
        let one = tempfile::tempdir().expect("tempdir");
        let two = tempfile::tempdir().expect("tempdir");
        let a = dir_under(one.path(), "alpha");
        let b = dir_under(one.path(), "beta");
        let rec_a = WorkspaceRecord {
            id: Uuid::new_v4(),
            path: a.clone(),
            title: None,
            explicit: false,
            created_at: 1_000,
            last_used_at: 1_000,
        };
        let rec_b = WorkspaceRecord {
            id: Uuid::new_v4(),
            path: b.clone(),
            title: None,
            explicit: false,
            created_at: 2_000,
            last_used_at: 2_000,
        };
        let reg_one = registry(&one);
        reg_one
            .save(&[rec_a.clone(), rec_b.clone()])
            .expect("save one");
        let reg_two = registry(&two);
        reg_two.save(&[rec_b, rec_a]).expect("save two");
        let bytes_one = std::fs::read(one.path().join(WORKSPACES_FILE_NAME)).expect("read one");
        let bytes_two = std::fs::read(two.path().join(WORKSPACES_FILE_NAME)).expect("read two");
        assert_eq!(
            bytes_one, bytes_two,
            "path-sorted records, order-free bytes"
        );
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_empty_and_a_write_refuses() {
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        assert!(reg.recent().is_empty(), "a missing file is the empty start");
        std::fs::write(root.path().join(WORKSPACES_FILE_NAME), "{ not json").expect("corrupt");
        assert!(
            reg.recent().is_empty(),
            "a corrupt file honest-degrades to empty"
        );
        let dir = dir_under(root.path(), "alpha");
        // The write onto a corrupt file refuses (the app-config
        // read-for-write rule): the file is left untouched.
        assert!(reg.record_at(&dir, None, false, 1_000).is_err());
        assert_eq!(
            std::fs::read_to_string(root.path().join(WORKSPACES_FILE_NAME)).expect("read"),
            "{ not json",
            "a refused write never rewrites the file"
        );
    }

    #[test]
    fn a_pre_title_file_opens_and_the_title_serializes_additively() {
        let root = tempfile::tempdir().expect("tempdir");
        let dir = dir_under(root.path(), "alpha");
        // The pre-#1384 shape: no `title` key on the record (serde default).
        std::fs::write(
            root.path().join(WORKSPACES_FILE_NAME),
            format!(
                "{{\"version\":1,\"workspaces\":[{{\"id\":\"{}\",\"path\":\"{}\",\"created_at\":1,\"last_used_at\":1}}]}}",
                Uuid::new_v4(),
                dir.display().to_string().replace('\\', "\\\\")
            ),
        )
        .expect("seed");
        let reg = registry(&root);
        let recent = reg.recent();
        assert_eq!(recent.len(), 1, "a record without `title` opens");
        assert_eq!(recent[0].title, None);
        assert!(
            !recent[0].explicit,
            "a record without `explicit` opens false"
        );
    }

    #[test]
    fn the_label_derives_the_directory_tail_by_default() {
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "my-project");
        reg.record_at(&dir, None, false, 1_000).expect("record");
        let recent = reg.recent();
        assert_eq!(recent[0].label(), "my-project", "no title -> the tail");
        let mut titled = recent[0].clone();
        titled.title = Some("Renamed".into());
        assert_eq!(titled.label(), "Renamed", "an explicit title wins");
    }

    #[test]
    fn a_newer_version_file_reads_empty() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            root.path().join(WORKSPACES_FILE_NAME),
            "{\"version\":2,\"workspaces\":[]}",
        )
        .expect("seed");
        let reg = registry(&root);
        assert!(reg.recent().is_empty(), "a future version honest-degrades");
    }

    #[test]
    fn label_of_projects_the_record_face_and_falls_back_to_the_tail() {
        // Issue #1393: the selector's existing-directory branch asks for one
        // path's label -- the same projection the recent list shows, with
        // the tail derivation for a never-recorded directory.
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "alpha");
        reg.record_at(&dir, None, false, 1_000).expect("record");
        assert_eq!(reg.label_of(&dir), "alpha", "no title -> the tail");
        let other = dir_under(root.path(), "never-recorded");
        assert_eq!(reg.label_of(&other), "never-recorded");
    }

    #[test]
    fn a_titled_record_carries_the_title_and_never_rewrites_on_an_existing_one() {
        // Issue #1393: the named-workspace mint records with the user's name
        // as the title; the same path again -- titled or not -- takes the LRU
        // bump alone (identity is immutable).
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "alpha");
        reg.record_at(&dir, Some("My Analysis"), true, 1_000)
            .expect("titled");
        let recent = reg.recent();
        assert_eq!(recent[0].title.as_deref(), Some("My Analysis"));
        assert_eq!(recent[0].label(), "My Analysis");

        // A titled call on the known path: bump only, no title rewrite.
        reg.record_at(&dir, Some("Sneaky Rename"), true, 2_000)
            .expect("again");
        let recent = reg.recent();
        assert_eq!(
            recent[0].title.as_deref(),
            Some("My Analysis"),
            "an existing record keeps its title"
        );
        assert_eq!(recent[0].last_used_at, 2_000, "the bump still lands");
        assert_eq!(
            recent.len(),
            1,
            "the titled call does not fork a second record"
        );
    }

    #[test]
    fn record_titled_seats_a_fresh_titled_record() {
        // The create command's mount: the user's name lands as the title on
        // a fresh record.
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "alpha");
        reg.record_titled(&dir, "Alpha").expect("record");
        let recent = reg.recent();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].title.as_deref(), Some("Alpha"));
    }

    #[test]
    fn record_titled_fails_the_caller_when_the_write_refuses() {
        // Unlike the session-event mounts, the explicit create must hear a
        // refused write: a record that never lands cannot report success.
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join(WORKSPACES_FILE_NAME), "{ not json").expect("corrupt");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "alpha");
        assert!(
            reg.record_titled(&dir, "Alpha").is_err(),
            "a refused write surfaces as Err, not a warn"
        );
    }

    #[test]
    fn explicit_rides_selected_records_and_old_files_read_false() {
        // Issue #1392: `explicit` marks the user-chosen workspaces the
        // sidebar section shows. The additive field reads `false` from a
        // pre-#1392 file (the a_pre_title test covers the file face), a
        // `false` record serializes without the key, and the explicit bind
        // upgrades in place.
        let root = tempfile::tempdir().expect("tempdir");
        let dir = dir_under(root.path(), "alpha");
        let reg = registry(&root);
        reg.record_at(&dir, None, false, 1_000).expect("record");
        assert!(!reg.all()[0].explicit, "the plain record stays implicit");
        let raw = std::fs::read_to_string(root.path().join(WORKSPACES_FILE_NAME)).expect("read");
        assert!(!raw.contains("explicit"), "false skips the key");
        reg.record_selected(&dir);
        assert!(
            reg.all()[0].explicit,
            "the explicit bind upgrades the same record"
        );
        let raw = std::fs::read_to_string(root.path().join(WORKSPACES_FILE_NAME)).expect("read");
        assert!(raw.contains("\"explicit\": true"), "true serializes");
    }

    #[test]
    fn rename_overwrites_the_title_and_keeps_identity_and_lru() {
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "alpha");
        reg.record_at(&dir, Some("Old"), true, 1_000)
            .expect("record");
        reg.rename(&dir, "New").expect("rename");
        let record = &reg.all()[0];
        assert_eq!(record.title.as_deref(), Some("New"));
        assert_eq!(record.path, dir, "the path never rewrites");
        assert_eq!(record.created_at, 1_000);
        assert_eq!(record.last_used_at, 1_000, "a rename is not a use");
        assert!(record.explicit, "rename touches the title only");
        // A duplicate title is allowed -- the LRU order tells duplicates
        // apart (ADR-0138).
        let twin = dir_under(root.path(), "beta");
        reg.record_at(&twin, Some("Other"), false, 2_000)
            .expect("record");
        reg.rename(&twin, "New").expect("rename twin");
        assert_eq!(
            reg.all()
                .iter()
                .filter(|r| r.title.as_deref() == Some("New"))
                .count(),
            2,
            "duplicate titles coexist"
        );
        // A path with no record refuses.
        let unknown = dir_under(root.path(), "never-recorded");
        assert!(reg.rename(&unknown, "X").is_err());
    }

    #[test]
    fn remove_record_deletes_the_record_but_never_the_directory() {
        // The sidebar's "remove from list" is a ledger edit: the sessions
        // under the workspace fall back to the recent list, the directory
        // stays.
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "alpha");
        reg.record_at(&dir, None, true, 1_000).expect("record");
        assert!(
            reg.remove_record(&dir).expect("remove"),
            "the recorded path deletes its record"
        );
        assert!(dir.exists(), "the directory stays");
        assert!(reg.all().is_empty());
        // Removing an unknown path is an idempotent Ok -- a miss, not a write.
        assert!(!reg.remove_record(&dir).expect("remove again"));
    }

    #[test]
    fn all_keeps_dangling_records_in_lru_order() {
        // The sidebar section keeps a missing-directory group with a state
        // hint; the selector's `recent` remains the existence-filtered view.
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let old = dir_under(root.path(), "old");
        let gone = dir_under(root.path(), "gone");
        reg.record_at(&old, None, true, 1_000).expect("old");
        reg.record_at(&gone, None, true, 5_000).expect("gone");
        std::fs::remove_dir(&gone).expect("the directory disappears");
        let all = reg.all();
        assert_eq!(
            all.iter().map(|r| r.path.as_path()).collect::<Vec<_>>(),
            vec![gone.as_path(), old.as_path()],
            "dangling records stay, newest first"
        );
        assert_eq!(reg.recent().len(), 1, "recent keeps filtering dangling");
    }
}
