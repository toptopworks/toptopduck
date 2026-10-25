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
            None => self
                .path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.path.display().to_string()),
        }
    }
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
        if let Err(detail) = self.record_at(canonical, now_millis()) {
            log::warn!(
                target: "toptopduck::workspace_registry",
                "workspace record for {} not written: {detail}",
                canonical.display()
            );
        }
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

    /// The selector's LRU view: records whose directory still exists, sorted
    /// `last_used_at` descending (path ascending breaks ties so the order is
    /// deterministic). Dangling records are KEPT in the store and merely
    /// hidden -- a user-deleted directory may come back (a bound session's
    /// next launch re-creates it on demand), so hiding beats deleting.
    pub fn recent(&self) -> Vec<WorkspaceRecord> {
        let mut records = self.load();
        records.retain(|r| r.path.exists());
        records.sort_by(|a, b| {
            b.last_used_at
                .cmp(&a.last_used_at)
                .then_with(|| a.path.cmp(&b.path))
        });
        records
    }

    /// [`Self::record`] with an injectable clock for tests.
    pub(crate) fn record_at(&self, canonical: &Path, now: u64) -> Result<(), String> {
        let Ok(_guard) = self.write_lock.lock() else {
            return Err("workspace registry write lock poisoned".to_string());
        };
        let mut records = self.load_for_write()?;
        match records.iter_mut().find(|r| r.path == canonical) {
            // Same canonical path: one record, LRU bump only (created_at and
            // id are identity and never rewrite).
            Some(existing) => existing.last_used_at = now,
            None => records.push(WorkspaceRecord {
                id: Uuid::new_v4(),
                path: canonical.to_path_buf(),
                title: None,
                created_at: now,
                last_used_at: now,
            }),
        }
        self.save(&records)
    }

    fn remove_inner(&self, canonical: &Path) -> Result<(), String> {
        let Ok(_guard) = self.write_lock.lock() else {
            return Err("workspace registry write lock poisoned".to_string());
        };
        let mut records = self.load_for_write()?;
        let before = records.len();
        records.retain(|r| r.path != canonical);
        if records.len() == before {
            return Ok(()); // nothing to remove (never recorded / already gone)
        }
        self.save(&records)
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
        reg.record_at(&a, 1_000).expect("record a");
        reg.record_at(&b, 2_000).expect("record b");
        // The SAME path again: no second record, only the LRU bump.
        reg.record_at(&a, 3_000).expect("record a again");

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
        reg.record_at(&old, 1_000).expect("record old");
        reg.record_at(&fresh, 9_000).expect("record fresh");
        reg.record_at(&gone, 5_000).expect("record gone");
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
        reg.record_at(&a, 1_000).expect("record a");
        reg.record_at(&b, 2_000).expect("record b");
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
            created_at: 1_000,
            last_used_at: 1_000,
        };
        let rec_b = WorkspaceRecord {
            id: Uuid::new_v4(),
            path: b.clone(),
            title: None,
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
        assert!(reg.record_at(&dir, 1_000).is_err());
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
    }

    #[test]
    fn the_label_derives_the_directory_tail_by_default() {
        let root = tempfile::tempdir().expect("tempdir");
        let reg = registry(&root);
        let dir = dir_under(root.path(), "my-project");
        reg.record_at(&dir, 1_000).expect("record");
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
}
