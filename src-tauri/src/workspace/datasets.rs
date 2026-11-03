//! Workspace shared dataset store (ADR-0141): content-addressed snapshots and
//! a text manifest, both under the workspace's `.toptopduck/` state directory.
//! The store is the workspace domain's own face -- sessions consume it through
//! hard links + READ_ONLY attach and never write here outside these functions.
//!
//! Integrity posture is honest errors (ADR-0141 Decision 8): a missing
//! manifest reads as empty (fresh workspace); a corrupt manifest is copied
//! aside (`.corrupt`) and refused, never silently rebuilt; store files no
//! manifest entry references are orphans and are swept at startup.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use duckdb::{AccessMode, Config, Connection};
use sha2::{Digest, Sha256};

use crate::ingest::{self, loader};
use crate::model::{ColumnSchema, DatasetPrivacy, LoadError};
use crate::persistence::io::save_atomic;
use crate::session::snapshot::Snapshot;

/// The workspace state directory name (sibling of the manifest + snapshots).
const STATE_DIR_NAME: &str = ".toptopduck";
/// The snapshot store subdirectory inside the state directory.
const SNAPSHOTS_DIR_NAME: &str = "snapshots";
/// The text manifest file name inside the state directory.
const MANIFEST_FILE_NAME: &str = "datasets.json";
/// Prefix for in-flight materialization temp names inside the store dir (the
/// crash-orphan face the sweep also removes).
const TEMP_PREFIX: &str = ".tmp_";

/// One manifest entry (ADR-0141 Decision 2): the dataset's stable
/// workspace-level identity plus the shape facts the cards and resume checks
/// read. `fingerprint` is the SHA256 of the ORIGINAL source bytes -- the store
/// key -- not the derived table fingerprint on the descriptor.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DatasetEntry {
    pub reference_name: String,
    pub fingerprint: String,
    pub columns: Vec<ColumnSchema>,
    pub row_count: u64,
    pub sample: Vec<Vec<String>>,
    #[serde(default)]
    pub privacy: DatasetPrivacy,
    pub source_path: String,
}

/// The list face crossing IPC: an entry plus its store-file presence (ADR-0141
/// Decision 8 -- an entry whose store file is missing stays visible, flagged,
/// and errors honestly when referenced).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ListedDataset {
    #[serde(flatten)]
    pub entry: DatasetEntry,
    pub file_missing: bool,
}

/// Why a store operation failed. Typed so the IPC layer can render the xlsx
/// hint and the corrupt-manifest posture distinctly (ADR-0141 D8/D11).
#[derive(Debug, Clone, PartialEq)]
pub enum StoreError {
    /// xlsx is out of the shared face's first cut (ADR-0141 D11): the error
    /// carries the actionable redirect, not a bare format refusal.
    XlsxRejected,
    /// Legacy .xls -- same refusal as the private ingest face (ADR-0015).
    LegacyExcel,
    UnsupportedFormat {
        requested: String,
    },
    /// The manifest exists but does not parse: preserved as `.corrupt` and
    /// refused; mutations are blocked so the user can inspect the copy.
    ManifestCorrupt {
        detail: String,
    },
    NotFound,
    Io {
        detail: String,
    },
}

impl StoreError {
    fn io(e: impl std::fmt::Display) -> Self {
        StoreError::Io {
            detail: e.to_string(),
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::XlsxRejected => write!(
                f,
                "xlsx is not supported on the shared face; convert to CSV/Parquet or use a session-private source"
            ),
            StoreError::LegacyExcel => {
                write!(f, "legacy .xls is not supported; save as .xlsx or CSV")
            }
            StoreError::UnsupportedFormat { requested } => {
                write!(f, "unsupported format: {requested}")
            }
            StoreError::ManifestCorrupt { detail } => {
                write!(f, "workspace dataset manifest is corrupt (copy preserved): {detail}")
            }
            StoreError::NotFound => write!(f, "no shared dataset with that reference name"),
            StoreError::Io { detail } => write!(f, "{detail}"),
        }
    }
}

impl From<LoadError> for StoreError {
    fn from(e: LoadError) -> Self {
        match e {
            LoadError::UnsupportedFormat { requested } => {
                StoreError::UnsupportedFormat { requested }
            }
            other => StoreError::Io {
                detail: other.to_string(),
            },
        }
    }
}

/// A materialization result: the derived snapshot plus whether the store
/// already held this content (a hit performs zero conversion, ADR-0141 D2).
#[derive(Debug)]
pub struct Materialized {
    pub snapshot: Snapshot,
    pub hit: bool,
}

/// Serialize all manifest writes process-wide (ADR-0141 D2 "进程内串行写").
// One global lock; per-workspace locks if contention ever matters.
static MANIFEST_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The state directory for a workspace root.
fn state_dir(workspace: &Path) -> PathBuf {
    workspace.join(STATE_DIR_NAME)
}

/// The snapshot store directory for a workspace root.
pub fn store_dir(workspace: &Path) -> PathBuf {
    state_dir(workspace).join(SNAPSHOTS_DIR_NAME)
}

/// The store file for a content fingerprint (the session-side lazy attach
/// resolves through this, ADR-0141 D3).
pub fn store_file(workspace: &Path, fingerprint: &str) -> PathBuf {
    store_dir(workspace).join(format!("{fingerprint}.duckdb"))
}

/// The manifest path for a workspace root.
fn manifest_path(workspace: &Path) -> PathBuf {
    state_dir(workspace).join(MANIFEST_FILE_NAME)
}

/// Stream-hash a file's bytes (the store key, ADR-0141 D2).
fn sha256_file(path: &Path) -> Result<String, StoreError> {
    let mut file = fs::File::open(path).map_err(StoreError::io)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(StoreError::io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Read the manifest (ADR-0141 D8): missing = empty (fresh workspace); a
/// parse failure copies the file aside as `datasets.json.corrupt` and refuses
/// -- mutations load first, so a corrupt manifest can never be overwritten.
pub fn load_entries(workspace: &Path) -> Result<Vec<DatasetEntry>, StoreError> {
    let path = manifest_path(workspace);
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(StoreError::io(e)),
    };
    match serde_json::from_slice::<Vec<DatasetEntry>>(&bytes) {
        Ok(entries) => Ok(entries),
        Err(detail) => {
            let corrupt = path.with_extension("json.corrupt");
            if let Err(e) = fs::copy(&path, &corrupt) {
                log::warn!(
                    target: "toptopduck::workspace_datasets",
                    "corrupt manifest copy-aside failed for {}: {e}",
                    path.display()
                );
            }
            Err(StoreError::ManifestCorrupt {
                detail: detail.to_string(),
            })
        }
    }
}

/// Write the manifest atomically under the process-wide serial lock.
fn write_entries(workspace: &Path, entries: &[DatasetEntry]) -> Result<(), StoreError> {
    let _guard = MANIFEST_WRITE_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    fs::create_dir_all(state_dir(workspace)).map_err(StoreError::io)?;
    save_atomic(&manifest_path(workspace), &entries).map_err(StoreError::io)
}

/// Re-open a landed store file READ_ONLY and re-derive its shape (the
/// zero-conversion hit path, ADR-0141 D2).
fn reopen_read_only(workspace: &Path, dest: PathBuf) -> Result<Snapshot, StoreError> {
    let config = Config::default()
        .access_mode(AccessMode::ReadOnly)
        .map_err(StoreError::io)?;
    let conn = Connection::open_with_flags(&dest, config).map_err(StoreError::io)?;
    Snapshot::from_connection(&conn, dest, &store_dir(workspace)).map_err(StoreError::from)
}

/// Materialize `src` into the store under its content key: a hit opens the
/// existing snapshot READ_ONLY and re-derives its shape (zero conversion); a
/// miss copies in through the shared loader under a temp name and atomically
/// renames (single physical file, no parallel writers -- ADR-0141 D2).
pub fn materialize(workspace: &Path, src: &Path, reader: &str) -> Result<Materialized, StoreError> {
    let key = sha256_file(src)?;
    let dest = store_file(workspace, &key);
    if dest.exists() {
        let snapshot = reopen_read_only(workspace, dest)?;
        return Ok(Materialized {
            snapshot,
            hit: true,
        });
    }

    fs::create_dir_all(store_dir(workspace)).map_err(StoreError::io)?;
    let temp_stem = format!("{TEMP_PREFIX}{}-{}", key, std::process::id());
    // copy_in owns its own failure cleanup (partial files are removed); on
    // success the built file is renamed into its content-keyed name.
    let snap = loader::copy_in(src, &store_dir(workspace), &temp_stem, reader)?;
    match fs::rename(&snap.file_path, &dest) {
        Ok(()) => Ok(Materialized {
            snapshot: Snapshot {
                file_path: dest,
                ..snap
            },
            hit: false,
        }),
        Err(_) if dest.exists() => {
            // Another writer landed the same key first (cross-process); the
            // store's file wins and the redundant temp is dropped.
            let _ = fs::remove_file(&snap.file_path);
            let snapshot = reopen_read_only(workspace, dest)?;
            Ok(Materialized {
                snapshot,
                hit: true,
            })
        }
        Err(e) => {
            let _ = fs::remove_file(&snap.file_path);
            Err(StoreError::io(e))
        }
    }
}

/// De-conflict a candidate name against the manifest's taken names: name,
/// name_2, name_3, ... (the private ingest's scheme, applied to the shared
/// vocabulary -- ADR-0141 D6).
fn deconflict(base: &str, entries: &[DatasetEntry]) -> String {
    let taken: std::collections::HashSet<&str> =
        entries.iter().map(|e| e.reference_name.as_str()).collect();
    if !taken.contains(base) {
        return base.to_string();
    }
    for n in 2.. {
        let candidate = format!("{base}_{n}");
        if !taken.contains(&candidate.as_str()) {
            return candidate;
        }
    }
    unreachable!("the loop saturates the usize range before exhausting names")
}

/// Add a source file as a new shared dataset (dispatch + materialize +
/// manifest append). The store file lands BEFORE the manifest write
/// (ADR-0141 D2's ordering).
pub fn add(workspace: &Path, src: &Path) -> Result<DatasetEntry, StoreError> {
    let reader = dispatch_reader(src)?;
    let mut entries = load_entries(workspace)?;
    let materialized = materialize(workspace, src, reader)?;
    let name = deconflict(
        &ingest::derive_reference_name(src).unwrap_or_else(|| "dataset".to_string()),
        &entries,
    );
    let entry = entry_from_materialized(name, materialized, DatasetPrivacy::default(), src);
    entries.push(entry.clone());
    write_entries(workspace, &entries)?;
    Ok(entry)
}

/// The fingerprint (content key) for a store file, recovered from its file
/// name -- the derived table fingerprint on the snapshot is a different hash.
fn store_fingerprint(store_path: &Path) -> String {
    store_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

/// An entry from a fresh materialization: shape facts from the snapshot, the
/// content key recovered from the store file name (the add and replace faces
/// share the derivation).
fn entry_from_materialized(
    reference_name: String,
    materialized: Materialized,
    privacy: DatasetPrivacy,
    src: &Path,
) -> DatasetEntry {
    let fingerprint = store_fingerprint(&materialized.snapshot.file_path);
    DatasetEntry {
        reference_name,
        fingerprint,
        columns: materialized.snapshot.columns,
        row_count: materialized.snapshot.row_count,
        sample: materialized.snapshot.sample,
        privacy,
        source_path: src.to_string_lossy().into_owned(),
    }
}

/// Replace an entry's content under the same reference name (ADR-0141 D7):
/// the new content lands in the store, the entry's shape facts update, and
/// the old physical file is reclaimed when no other entry shares it. Privacy
/// is an asset attribute and survives a content swap.
pub fn replace(
    workspace: &Path,
    reference_name: &str,
    src: &Path,
) -> Result<DatasetEntry, StoreError> {
    let reader = dispatch_reader(src)?;
    let mut entries = load_entries(workspace)?;
    let idx = entries
        .iter()
        .position(|e| e.reference_name == reference_name)
        .ok_or(StoreError::NotFound)?;
    let materialized = materialize(workspace, src, reader)?;
    let old_fingerprint = entries[idx].fingerprint.clone();
    let entry = entry_from_materialized(
        reference_name.to_string(),
        materialized,
        entries[idx].privacy.clone(),
        src,
    );
    entries[idx] = entry.clone();
    write_entries(workspace, &entries)?;
    reclaim_if_unreferenced(workspace, &old_fingerprint, &entries);
    Ok(entry)
}

/// Remove an entry (ADR-0141 D7): the manifest drops the name immediately;
/// the physical file is reclaimed only when no surviving entry shares it (a
/// session mid-turn still holds its hard link, so an unlink is always safe).
pub fn remove(workspace: &Path, reference_name: &str) -> Result<(), StoreError> {
    let mut entries = load_entries(workspace)?;
    let idx = entries
        .iter()
        .position(|e| e.reference_name == reference_name)
        .ok_or(StoreError::NotFound)?;
    let fingerprint = entries[idx].fingerprint.clone();
    entries.remove(idx);
    write_entries(workspace, &entries)?;
    reclaim_if_unreferenced(workspace, &fingerprint, &entries);
    Ok(())
}

/// Update an entry's privacy (ADR-0141 D10) -- a workspace-level asset
/// attribute, effective for every bound session on its next turn.
pub fn set_privacy(
    workspace: &Path,
    reference_name: &str,
    privacy: DatasetPrivacy,
) -> Result<DatasetEntry, StoreError> {
    let mut entries = load_entries(workspace)?;
    let idx = entries
        .iter()
        .position(|e| e.reference_name == reference_name)
        .ok_or(StoreError::NotFound)?;
    // Normalize like the working-set face: dedup + sort for deterministic
    // storage (set semantics at the type-usage level).
    let mut cols = privacy.type_only_columns;
    cols.retain(|c| !c.trim().is_empty());
    cols.sort();
    cols.dedup();
    entries[idx].privacy = DatasetPrivacy {
        type_only_columns: cols,
        ..privacy
    };
    let entry = entries[idx].clone();
    write_entries(workspace, &entries)?;
    Ok(entry)
}

/// The panel's list face (ADR-0141 D8): every entry stays listed; an entry
/// whose store file is gone is flagged, not hidden.
pub fn list(workspace: &Path) -> Result<Vec<ListedDataset>, StoreError> {
    Ok(load_entries(workspace)?
        .into_iter()
        .map(|entry| {
            let file_missing = !store_file(workspace, &entry.fingerprint).exists();
            ListedDataset {
                entry,
                file_missing,
            }
        })
        .collect())
}

/// Delete a store file whose fingerprint no surviving entry references.
/// Best-effort + logged: a held hard link makes the unlink safe everywhere,
/// and a failure leaves an orphan for the next sweep rather than failing the
/// user's mutation.
fn reclaim_if_unreferenced(workspace: &Path, fingerprint: &str, entries: &[DatasetEntry]) {
    if entries.iter().any(|e| e.fingerprint == fingerprint) {
        return;
    }
    if let Err(e) = fs::remove_file(store_file(workspace, fingerprint)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                target: "toptopduck::workspace_datasets",
                "store file reclaim failed for {fingerprint}: {e}"
            );
        }
    }
}

/// Startup sweep (ADR-0141 D8): store files no manifest entry references (and
/// in-flight temp leftovers) are deleted -- an unreferenced file has zero
/// risk by definition. A corrupt manifest aborts the sweep for that
/// workspace (honest refusal; deleting against an unreadable manifest could
/// destroy the only copy). Returns the removed count (diagnostics / tests).
pub fn sweep_orphans(workspace: &Path) -> Result<usize, StoreError> {
    let entries = load_entries(workspace)?;
    let referenced: std::collections::HashSet<&str> =
        entries.iter().map(|e| e.fingerprint.as_str()).collect();
    let dir = store_dir(workspace);
    let Ok(read_dir) = fs::read_dir(&dir) else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in read_dir.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_orphan = if name.starts_with(TEMP_PREFIX) {
            true
        } else {
            let stem = name.strip_suffix(".duckdb").unwrap_or(name);
            !referenced.contains(stem)
        };
        if is_orphan {
            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => log::warn!(
                    target: "toptopduck::workspace_datasets",
                    "orphan sweep could not remove {}: {e}",
                    path.display()
                ),
            }
        }
    }
    Ok(removed)
}

/// Dispatch a source for the shared face: CSV / Parquet / JSON+JSONL share
/// the copy-in path; xlsx is refused with the redirect hint (ADR-0141 D11),
/// legacy .xls and unknown formats refuse like the private face.
fn dispatch_reader(src: &Path) -> Result<&'static str, StoreError> {
    match ingest::dispatch(src) {
        ingest::Dispatched::Xlsx => Err(StoreError::XlsxRejected),
        ingest::Dispatched::Xls => Err(StoreError::LegacyExcel),
        dispatched => {
            ingest::reader_for(&dispatched).ok_or_else(|| StoreError::UnsupportedFormat {
                requested: match dispatched {
                    ingest::Dispatched::Unsupported(ext) => ext,
                    _ => String::new(),
                },
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn csv(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, contents).expect("write csv");
        p
    }

    const PEOPLE: &str = "name,score\nAda,9\nGrace,7\n";

    fn ws() -> tempfile::TempDir {
        tempfile::tempdir().expect("workspace dir")
    }

    fn src_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("source dir")
    }

    /// add() pins the full entry shape: name from the file stem, fingerprint
    /// = store key, derived schema/rows/sample, default privacy, source path.
    #[test]
    fn add_writes_entry_and_manifest() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let entry = add(workspace.path(), &src).expect("add");
        assert_eq!(entry.reference_name, "people");
        assert_eq!(entry.row_count, 2);
        assert_eq!(entry.columns.len(), 2);
        assert_eq!(entry.columns[0].name, "name");
        assert!(entry.privacy.send_samples, "default privacy rides");
        assert_eq!(entry.source_path, src.to_string_lossy());
        let manifest = fs::read_to_string(manifest_path(workspace.path())).expect("manifest");
        assert!(manifest.contains("\"reference_name\": \"people\""));
    }

    /// The store file lands at <sha256>.duckdb and a second materialization
    /// of the same content is a hit (zero conversion, ADR-0141 D2).
    #[test]
    fn materialize_hits_the_store_and_skips_conversion() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let first = materialize(workspace.path(), &src, "read_csv_auto").expect("first");
        assert!(!first.hit);
        let second = materialize(workspace.path(), &src, "read_csv_auto").expect("second");
        assert!(second.hit, "identical content must hit the store");
        // Shape derives identically on the hit path.
        assert_eq!(second.snapshot.row_count, first.snapshot.row_count);
        assert_eq!(second.snapshot.columns, first.snapshot.columns);
        let files = fs::read_dir(store_dir(workspace.path()))
            .expect("store dir")
            .count();
        assert_eq!(files, 1, "one physical file for one content key");
    }

    /// Different content under the same stem materializes to a different
    /// store file (the key is content, not name).
    #[test]
    fn different_content_materializes_a_new_key() {
        let workspace = ws();
        let sources = src_dir();
        let a = csv(sources.path(), "people.csv", PEOPLE);
        let b = csv(sources.path(), "people_v2.csv", "name,score\nAda,9\n");
        let first = materialize(workspace.path(), &a, "read_csv_auto").expect("a");
        let second = materialize(workspace.path(), &b, "read_csv_auto").expect("b");
        assert!(!second.hit);
        assert_ne!(
            first.snapshot.file_path, second.snapshot.file_path,
            "content keys differ"
        );
    }

    /// Adding the same content twice shares one physical file and
    /// de-conflicts the second entry's name (the private scheme applied to
    /// the shared vocabulary).
    #[test]
    fn same_content_twice_shares_one_store_file_and_deconflicts() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let a = add(workspace.path(), &src).expect("add a");
        let b = add(workspace.path(), &src).expect("add b");
        assert_eq!(b.reference_name, "people_2");
        assert_eq!(a.fingerprint, b.fingerprint, "same content, same key");
        let files = fs::read_dir(store_dir(workspace.path()))
            .expect("store dir")
            .count();
        assert_eq!(files, 1, "one physical file serves both entries");
    }

    /// remove drops the entry and reclaims the physical file when nothing
    /// else references it.
    #[test]
    fn remove_drops_entry_and_reclaims_unreferenced_file() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add");
        remove(workspace.path(), "people").expect("remove");
        assert!(load_entries(workspace.path()).expect("entries").is_empty());
        let files = fs::read_dir(store_dir(workspace.path()))
            .expect("store dir")
            .count();
        assert_eq!(files, 0, "unreferenced store file reclaimed");
        assert_eq!(
            remove(workspace.path(), "people"),
            Err(StoreError::NotFound),
            "double remove is an honest NotFound"
        );
    }

    /// remove keeps the physical file when another entry shares the content
    /// (two names, one store key).
    #[test]
    fn remove_keeps_file_shared_by_another_entry() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add a");
        add(workspace.path(), &src).expect("add b");
        remove(workspace.path(), "people").expect("remove a");
        let files = fs::read_dir(store_dir(workspace.path()))
            .expect("store dir")
            .count();
        assert_eq!(files, 1, "people_2 still references the file");
    }

    /// replace swaps content under the stable name: new key, updated shape,
    /// old physical file reclaimed, privacy preserved.
    #[test]
    fn replace_swaps_content_and_reclaims_the_old_file() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let original = add(workspace.path(), &src).expect("add");
        let privacy = DatasetPrivacy {
            send_samples: false,
            type_only_columns: vec!["score".into()],
        };
        set_privacy(workspace.path(), "people", privacy.clone()).expect("privacy");
        let next = csv(
            sources.path(),
            "people.csv",
            "name,score\nAda,9\nLin,8\nIda,6\n",
        );
        let replaced = replace(workspace.path(), "people", &next).expect("replace");
        assert_eq!(replaced.reference_name, "people", "name is stable");
        assert_ne!(replaced.fingerprint, original.fingerprint);
        assert_eq!(replaced.row_count, 3, "shape follows the new content");
        assert_eq!(replaced.privacy, privacy, "privacy survives the swap");
        let files = fs::read_dir(store_dir(workspace.path()))
            .expect("store dir")
            .count();
        assert_eq!(files, 1, "only the new physical file remains");
    }

    /// A missing manifest reads as empty (fresh workspace, ADR-0141 D8).
    #[test]
    fn missing_manifest_reads_empty() {
        let workspace = ws();
        assert!(load_entries(workspace.path()).expect("load").is_empty());
    }

    /// A corrupt manifest is copied aside and refused; mutations stay
    /// blocked so the copy is never overwritten.
    #[test]
    fn corrupt_manifest_is_copied_aside_and_refused() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add");
        let path = manifest_path(workspace.path());
        fs::write(&path, "{ not json").expect("corrupt");
        let err = load_entries(workspace.path()).expect_err("refused");
        assert!(matches!(err, StoreError::ManifestCorrupt { .. }), "{err:?}");
        assert!(
            path.with_extension("json.corrupt").exists(),
            "corrupt copy preserved"
        );
        assert!(
            add(workspace.path(), &src).is_err(),
            "mutations blocked on a corrupt manifest"
        );
    }

    /// The sweep deletes unreferenced store files and temp leftovers, keeps
    /// referenced ones, and refuses to act on a corrupt manifest.
    #[test]
    fn sweep_removes_orphans_keeps_referenced_and_refuses_corrupt() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add");
        let store = store_dir(workspace.path());
        fs::write(store.join("deadbeef.duckdb"), b"x").expect("orphan");
        fs::write(store.join(".tmp_abc-1.duckdb"), b"x").expect("temp leftover");
        let removed = sweep_orphans(workspace.path()).expect("sweep");
        assert_eq!(removed, 2);
        // The referenced entry's file survives: reload and check presence.
        let entries = load_entries(workspace.path()).expect("entries");
        assert_eq!(entries.len(), 1);
        assert!(
            store_file(workspace.path(), &entries[0].fingerprint).exists(),
            "referenced file kept"
        );

        fs::write(manifest_path(workspace.path()), "nope").expect("corrupt");
        assert!(sweep_orphans(workspace.path()).is_err());
    }

    /// The list face flags a missing store file instead of hiding the entry.
    #[test]
    fn list_flags_missing_store_file() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add");
        let before = list(workspace.path()).expect("list");
        assert!(!before[0].file_missing);
        fs::remove_file(store_file(workspace.path(), &before[0].entry.fingerprint))
            .expect("delete store file");
        let after = list(workspace.path()).expect("list");
        assert_eq!(after.len(), 1, "entry stays visible");
        assert!(after[0].file_missing, "missing file is flagged");
    }

    /// xlsx is refused on the shared face (ADR-0141 D11); .xls and unknown
    /// formats refuse like the private face.
    #[test]
    fn xlsx_xls_and_unknown_formats_are_refused() {
        let workspace = ws();
        let sources = src_dir();
        let xlsx = csv(sources.path(), "book.xlsx", "x");
        assert_eq!(
            add(workspace.path(), &xlsx),
            Err(StoreError::XlsxRejected),
            "xlsx carries its own refusal"
        );
        let xls = csv(sources.path(), "book.xls", "x");
        assert_eq!(add(workspace.path(), &xls), Err(StoreError::LegacyExcel));
        let txt = csv(sources.path(), "notes.txt", "x");
        assert_eq!(
            add(workspace.path(), &txt),
            Err(StoreError::UnsupportedFormat {
                requested: ".txt".into()
            })
        );
        // Nothing landed: no manifest, no store dir.
        assert!(load_entries(workspace.path()).expect("load").is_empty());
    }
}
