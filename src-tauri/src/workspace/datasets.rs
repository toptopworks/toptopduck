//! Workspace shared dataset store (ADR-0141): content-addressed snapshots and
//! a text manifest, both under the workspace's `.toptopduck/` state directory.
//! The store is the workspace domain's own face -- sessions consume it through
//! hard links + READ_ONLY attach and never write here outside these functions.
//!
//! Integrity posture is honest errors (ADR-0141 Decision 8): a missing
//! manifest reads as empty (fresh workspace); a corrupt manifest is copied
//! aside (`.corrupt`) and refused, never silently rebuilt; store files no
//! manifest entry references are orphans and are swept at startup.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use calamine::Data;
use duckdb::{AccessMode, Config, Connection};

use crate::ingest::{self, loader};
use crate::model::{ColumnSchema, DatasetPrivacy, GuidanceRequest, LoadError, SheetGuidance};
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
/// read. `fingerprint` is the content key -- the store file's identity: the
/// source bytes' SHA256 for the direct formats (CSV/Parquet/JSON), the
/// rectified sheet CSV's SHA256 for the guided Excel import (issue #1552) --
/// never the derived table fingerprint on the descriptor.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DatasetEntry {
    pub reference_name: String,
    /// Display label (ADR-0037's dual-name scheme on the shared face): the
    /// user-renamable label the panel shows. Defaults to the reference name
    /// on add; rename touches only this field, so the reference name stays
    /// the SQL / attach / injection anchor. Old manifests without the field
    /// deserialize empty and fall back to the reference name in
    /// [`load_entries`].
    #[serde(default)]
    pub display_name: String,
    pub fingerprint: String,
    /// The store file's byte size (issue #1485): the data body's on-disk size,
    /// stat'ed at landing (the source file may have moved; the store file IS
    /// the data). `#[serde(default)]` keeps older manifests deserializing to 0
    /// -- the detail pane renders no size line for 0.
    #[serde(default)]
    pub size_bytes: u64,
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
    /// xlsx refused on the one channel that cannot take it (ADR-0141 D11 as
    /// revised by the guided import, issue #1552): adding goes through the
    /// guided confirm dialog, and replace stays out of scope -- content swaps
    /// remove the entry and import the workbook again.
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
    /// A rename arrived with a blank display label (the private
    /// rename_display scheme: trimmed, then refused).
    InvalidLabel,
    /// The rename's label is already shown by another entry (display-layer
    /// uniqueness).
    DisplayTaken(String),
    /// The engine could not parse the source file (CSV delimiter sniffing
    /// failed, malformed JSON, ...): the panel renders its own sentence and
    /// appends this detail, instead of the Io echo that would bare the raw
    /// engine string. One kind on purpose -- LoadError::Parse is shared by
    /// every reader, so the wording stays format-neutral.
    DataUnreadable {
        detail: String,
    },
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
                "xlsx workbooks import through the guided confirm dialog; replacing a dataset with a workbook is not supported -- remove the dataset and import the workbook again"
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
            StoreError::NotFound => write!(f, "no dataset with that reference name"),
            StoreError::InvalidLabel => write!(f, "a display name may not be blank"),
            StoreError::DisplayTaken(label) => {
                write!(f, "display name `{label}` is already taken")
            }
            StoreError::DataUnreadable { detail } => {
                write!(f, "the data file could not be parsed: {detail}")
            }
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
            // A file the engine could not parse (sniffer-blind delimiter,
            // broken quote, malformed JSON) is the panel's everyday reject,
            // not an infrastructure fault: it gets its own kind so the
            // catalog owns the wording and the engine string rides as detail.
            LoadError::Parse { detail } => StoreError::DataUnreadable { detail },
            other => StoreError::Io {
                detail: other.to_string(),
            },
        }
    }
}

/// Serializes manifest mutations process-wide (issue #1473: in-process
/// serialized manifest writes). Held across each mutator's whole
/// load-materialize-write cycle -- not just the write -- so concurrent
/// panel operations (the multi-file picker fans every add out at once)
/// cannot interleave their read-modify-write passes and lose entries.
// One global lock; per-workspace locks if contention ever matters.
static MANIFEST_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The process-wide manifest mutation guard (see MANIFEST_WRITE_LOCK).
fn manifest_lock() -> std::sync::MutexGuard<'static, ()> {
    MANIFEST_WRITE_LOCK
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// The state directory for a workspace root.
fn state_dir(workspace: &Path) -> PathBuf {
    workspace.join(STATE_DIR_NAME)
}

/// The snapshot store directory for a workspace root.
fn store_dir(workspace: &Path) -> PathBuf {
    state_dir(workspace).join(SNAPSHOTS_DIR_NAME)
}

/// The store file for a content fingerprint (the session-side lazy attach
/// resolves through this, ADR-0141 D3).
fn store_file(workspace: &Path, fingerprint: &str) -> PathBuf {
    store_dir(workspace).join(format!("{fingerprint}.duckdb"))
}

/// The landed store file behind a manifest entry, if it still exists: the
/// single resolution point for the missing-file question -- the panel's
/// list flag and the session attach's missing-entry error both read this
/// (one answer, two consumer postures).
pub(crate) fn entry_file(workspace: &Path, entry: &DatasetEntry) -> Option<PathBuf> {
    let path = store_file(workspace, &entry.fingerprint);
    path.exists().then_some(path)
}

/// The manifest path for a workspace root.
fn manifest_path(workspace: &Path) -> PathBuf {
    state_dir(workspace).join(MANIFEST_FILE_NAME)
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
    let refuse = |detail: String| -> Result<Vec<DatasetEntry>, StoreError> {
        let corrupt = path.with_extension("json.corrupt");
        if let Err(e) = fs::copy(&path, &corrupt) {
            log::warn!(
                target: "toptopduck::workspace_datasets",
                "corrupt manifest copy-aside failed for {}: {e}",
                path.display()
            );
        }
        Err(StoreError::ManifestCorrupt { detail })
    };
    let mut entries = match serde_json::from_slice::<Vec<DatasetEntry>>(&bytes) {
        Ok(entries) => entries,
        Err(detail) => return refuse(detail.to_string()),
    };
    // Old manifests predate the display label: an absent field deserializes
    // empty and falls back to the reference name here, so every read sees a
    // real label and the next manifest write lands the field.
    for entry in &mut entries {
        if entry.display_name.is_empty() {
            entry.display_name = entry.reference_name.clone();
        }
    }
    // Semantic integrity, the same honest-refusal posture as a syntax
    // failure: a fingerprint is a content key (never empty) and reference
    // names are the workspace vocabulary (unique). The producer never
    // writes either bad state; a hand-edited manifest gets the copy-aside
    // refusal instead of silent first-wins reads downstream.
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for entry in &entries {
        if entry.fingerprint.is_empty() {
            return refuse(format!(
                "entry `{}` has an empty fingerprint",
                entry.reference_name
            ));
        }
        if !seen.insert(entry.reference_name.as_str()) {
            return refuse(format!(
                "duplicate reference name `{}`",
                entry.reference_name
            ));
        }
    }
    Ok(entries)
}

/// Write the manifest atomically. Callers hold the process-wide serial
/// lock across their whole load-mutate-write cycle (see
/// MANIFEST_WRITE_LOCK); this writes only.
fn write_entries(workspace: &Path, entries: &[DatasetEntry]) -> Result<(), StoreError> {
    fs::create_dir_all(state_dir(workspace)).map_err(StoreError::io)?;
    save_atomic(&manifest_path(workspace), &entries).map_err(StoreError::io)
}

/// Re-open a landed store file READ_ONLY and re-derive its shape (the
/// zero-conversion hit path, ADR-0141 D2). Shape only -- the identity is
/// the content key recovered from the file name, not a table-content
/// fingerprint (issue #1506).
fn reopen_read_only(dest: PathBuf) -> Result<Snapshot, StoreError> {
    let config = Config::default()
        .access_mode(AccessMode::ReadOnly)
        .map_err(StoreError::io)?;
    let conn = Connection::open_with_flags(&dest, config).map_err(StoreError::io)?;
    let snap = Snapshot::from_connection(&conn, dest).map_err(StoreError::from)?;
    Ok(Snapshot {
        fingerprint: store_fingerprint(&snap.file_path),
        ..snap
    })
}

/// Materialize `src` into the store under its content key (the streaming
/// SHA-256 of the file's bytes, ADR-0141 D2): a hit opens the existing
/// snapshot READ_ONLY and re-derives its shape (zero conversion); a miss
/// copies in through the shared loader under a temp name and atomically
/// renames (single physical file, no parallel writers). Both paths derive
/// shape only -- no table-content fingerprint pass; the identity is the
/// store key itself (issue #1506).
fn materialize(workspace: &Path, src: &Path, reader: &str) -> Result<Snapshot, StoreError> {
    let key = crate::util::sha256_file(src).map_err(StoreError::io)?;
    let dest = store_file(workspace, &key);
    if dest.exists() {
        return reopen_read_only(dest);
    }

    fs::create_dir_all(store_dir(workspace)).map_err(StoreError::io)?;
    let temp_stem = format!("{TEMP_PREFIX}{}-{}", key, std::process::id());
    // copy_in owns its own failure cleanup (partial files are removed); on
    // success the built file is renamed into its content-keyed name. The
    // shape-only face skips the fingerprint pass -- the key IS the identity.
    let snap = loader::copy_in_shape(src, &store_dir(workspace), &temp_stem, reader)?;
    match fs::rename(&snap.file_path, &dest) {
        Ok(()) => Ok(Snapshot {
            file_path: dest,
            fingerprint: key,
            ..snap
        }),
        Err(_) if dest.exists() => {
            // Another writer landed the same key first (cross-process); the
            // store's file wins and the redundant temp is dropped.
            let _ = fs::remove_file(&snap.file_path);
            reopen_read_only(dest)
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
    crate::workingset::deconflict_loop(base, |n| taken.contains(n), |c, n| format!("{c}_{n}"))
}

/// De-conflict a candidate DISPLAY name against the manifest's taken display
/// names: the display-layer uniqueness rename enforces (DisplayTaken) must
/// hold for entries the add path creates too, so a fresh default label never
/// lands on a label a rename already took. Same ` (2)` suffix as the
/// session's display layer (ADR-0037 display-layer de-conflict) -- one
/// human-readable format.
fn deconflict_display(base: &str, entries: &[DatasetEntry]) -> String {
    let taken: std::collections::HashSet<&str> =
        entries.iter().map(|e| e.display_name.as_str()).collect();
    crate::workingset::deconflict_loop(base, |n| taken.contains(n), |c, n| format!("{c} ({n})"))
}

/// Add a source file as a new shared dataset (dispatch + materialize +
/// manifest append). The store file lands BEFORE the manifest write
/// (ADR-0141 D2's ordering).
pub fn add(workspace: &Path, src: &Path) -> Result<DatasetEntry, StoreError> {
    // The guided import owns xlsx (ADR-0141 D11 as revised, issue #1552);
    // the direct face refuses it before any work (the frontend routes the
    // picker's xlsx picks to preview + guided add, so this is the bypass
    // floor for any channel that slips one through).
    if is_xlsx(src) {
        return Err(StoreError::XlsxRejected);
    }
    let _guard = manifest_lock();
    let reader = dispatch_reader(src)?;
    let mut entries = load_entries(workspace)?;
    let materialized = materialize(workspace, src, reader)?;
    let name = deconflict(
        &ingest::derive_reference_name(src).unwrap_or_else(|| "dataset".to_string()),
        &entries,
    );
    // The default label is the reference name, de-conflicted at the display
    // layer: two rows must never share a label.
    let display = deconflict_display(&name, &entries);
    let entry = entry_from_materialized(
        name.clone(),
        display,
        materialized,
        DatasetPrivacy::default(),
        src,
    );
    entries.push(entry.clone());
    write_entries(workspace, &entries)?;
    Ok(entry)
}

/// One parked preview: the (workspace root, source path) key + the full
/// parse behind it.
type ParkedPreview = ((String, String), Vec<ingest::excel::SheetRows>);

/// The parked workbook parses behind [`preview`] (the guided import's
/// zero-reparse paging, issue #1552): keyed by (workspace root, source
/// path), so a superseding preview replaces in place (no unbounded growth)
/// and a landed or cancelled import drops its entry. Process-lifetime like
/// the session face's guidance retention -- never persisted. A Vec, not a
/// map: parks number in the ones (one per open confirm dialog) and the
/// MSRV forbids the const-map statics.
static PREVIEW_PARK: Mutex<Vec<ParkedPreview>> = Mutex::new(Vec::new());

/// Unique temp-CSV token for the guided import's sheet materialization
/// (content key comes FROM the CSV bytes, so the name only needs
/// uniqueness, never determinism).
static SHEET_CSV_SEQ: AtomicU64 = AtomicU64::new(0);

/// The park's lookup key: the lossy string spellings of the workspace root
/// and the source path, shared by the park's three faces.
fn park_key(workspace: &Path, src: &Path) -> (String, String) {
    (
        workspace.to_string_lossy().to_string(),
        src.to_string_lossy().to_string(),
    )
}

/// Read a workbook and build its guided-import confirmation payload
/// (ADR-0148's dialog on the shared face, issue #1552): every visible
/// non-blank sheet auto-tidied to its two-state, previews inlined. The full
/// parse parks in-process keyed by (workspace, path) so the dialog's paging
/// never re-reads the file; a superseding preview replaces the entry.
/// Read-only: the working set and the manifest are untouched.
pub fn preview(workspace: &Path, src: &Path) -> Result<GuidanceRequest, StoreError> {
    excel_source(src)?;
    let sheets = ingest::excel::read_non_empty_sheets(src).map_err(StoreError::from)?;
    let states = ingest::excel::guidance_states(&sheets);
    let request = ingest::excel::build_guidance(src, &sheets, &states);
    let key = park_key(workspace, src);
    let mut park = PREVIEW_PARK.lock().unwrap_or_else(|p| p.into_inner());
    // Replace in place on a repeated preview of the same key: the stale
    // parse must not linger behind the fresh one (the lifecycle pin).
    if let Some(slot) = park.iter_mut().find(|(k, _)| *k == key) {
        slot.1 = sheets;
    } else {
        park.push((key, sheets));
    }
    Ok(request)
}

/// Serve one preview window for a sheet parked by [`preview`], from the
/// retained parse -- no workbook re-read. `limit` clamps to the shared
/// window size (IPC input is untrusted); `None` when nothing is retained
/// for the (workspace, path, sheet) triple -- committed, discarded, or
/// superseded. The park is PEEKED, not taken: the dialog pages repeatedly.
pub fn parked_window(
    workspace: &Path,
    src: &Path,
    sheet_name: &str,
    offset: usize,
    limit: usize,
) -> Option<Vec<Vec<String>>> {
    let key = park_key(workspace, src);
    let park = PREVIEW_PARK.lock().unwrap_or_else(|p| p.into_inner());
    let sheets = &park.iter().find(|(k, _)| *k == key)?.1;
    let sheet = sheets.iter().find(|s| s.name == sheet_name)?;
    Some(ingest::excel::render_preview_window(
        sheet,
        offset,
        limit.min(ingest::excel::GUIDANCE_PREVIEW_ROWS),
    ))
}

/// Drop a parked parse (the dialog-cancel path, issue #1552). Idempotent --
/// a second discard finds nothing.
pub fn discard_parked(workspace: &Path, src: &Path) {
    let key = park_key(workspace, src);
    let mut park = PREVIEW_PARK.lock().unwrap_or_else(|p| p.into_inner());
    park.retain(|(k, _)| *k != key);
}

/// Materialize one rectified sheet through its canonical CSV (the session
/// face's `attach_sheet` pipeline, re-keyed for the store): the CSV bytes
/// ARE the content key -- `write_sheet_csv` renders deterministically, so
/// the same sheet content lands on the same store file whatever the
/// workbook or sheet is named (cross-workbook dedup comes free). The CSV is
/// transient: written to the OS temp dir, hashed + copied in, removed.
fn materialize_sheet(
    workspace: &Path,
    sheet_name: &str,
    rows: &[Vec<Data>],
) -> Result<Snapshot, StoreError> {
    let token = format!(
        "ws-guided-{}-{}",
        std::process::id(),
        SHEET_CSV_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let csv_path = ingest::excel::write_sheet_csv(rows, sheet_name, &std::env::temp_dir(), &token)
        .map_err(StoreError::from)?;
    // materialize hashes the CSV (the content key), reuses the store file
    // on a hit, and copies in + renames on a miss -- the store discipline,
    // unchanged for the new key source. A failed materialization logs a
    // failed temp-CSV removal (the session face's attach_sheet posture);
    // the success path stays silent best-effort.
    let landed = match materialize(workspace, &csv_path, "read_csv_auto") {
        Ok(s) => s,
        Err(e) => {
            if let Err(io_err) = fs::remove_file(&csv_path) {
                log::warn!(
                    target: "toptopduck::workspace_datasets",
                    "temp CSV removal failed for sheet {sheet_name}: {io_err}"
                );
            }
            return Err(e);
        }
    };
    let _ = fs::remove_file(&csv_path);
    Ok(landed)
}

/// Add a workbook's CHECKED sheets as shared datasets (the guided import,
/// ADR-0141 D11 as revised by issue #1552): one [`DatasetEntry`] per
/// guidance entry whose sheet exists, skipped sheets land nothing, and an
/// empty selection is the defensive floor (the dialog disables its submit;
/// this catches any client that bypasses it -- ADR-0148's wording). Each
/// sheet rectifies by its user choices, materializes through its canonical
/// CSV (content-addressed, see [`materialize_sheet`]), and de-conflicts
/// BOTH names against the manifest and the batch. Transactional on the
/// manifest: all sheets rectify and materialize before one manifest write,
/// so a failure leaves the manifest untouched (partially-landed store files
/// are unreferenced orphans the sweep removes). Re-parses the workbook --
/// the parked parse is only the dialog's paging cache.
pub fn add_guided(
    workspace: &Path,
    src: &Path,
    guidance: &[SheetGuidance],
) -> Result<Vec<DatasetEntry>, StoreError> {
    excel_source(src)?;
    let _guard = manifest_lock();
    let mut entries = load_entries(workspace)?;
    let sheets = ingest::excel::read_non_empty_sheets(src).map_err(StoreError::from)?;
    if guidance.is_empty() {
        return Err(StoreError::DataUnreadable {
            detail: ingest::excel::NO_SHEET_SELECTED.into(),
        });
    }

    // Rectify every checked sheet up front (transactional: an out-of-range
    // header aborts before any materialization). Guidance entries naming a
    // sheet the workbook doesn't have are ignored, exactly like the session
    // face's guided commit.
    let rectified: Vec<(&ingest::excel::SheetRows, Vec<Vec<Data>>)> = sheets
        .iter()
        .filter_map(|sheet| {
            guidance
                .iter()
                .find(|g| g.name == sheet.name)
                .map(|g| (sheet, g.rectify.clone()))
        })
        .map(|(sheet, rectify)| {
            let rows = ingest::excel::apply_rectify(sheet, &rectify)?;
            Ok::<_, StoreError>((sheet, rows))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if rectified.is_empty() {
        return Err(StoreError::DataUnreadable {
            detail: ingest::excel::NO_SHEET_SELECTED.into(),
        });
    }
    // A checked entry that missed every workbook sheet means the file
    // changed under the open dialog: the survivors still commit, the
    // dropped picks get a trace instead of vanishing silently.
    let missed: Vec<&str> = guidance
        .iter()
        .map(|g| g.name.as_str())
        .filter(|name| !rectified.iter().any(|(sheet, _)| sheet.name == *name))
        .collect();
    if !missed.is_empty() {
        log::warn!(
            target: "toptopduck::workspace_datasets",
            "guided import ignored checked sheets absent from the workbook: {missed:?}"
        );
    }

    // Materialize every sheet before any naming (a materialization failure
    // leaves the manifest untouched; the landed files are orphans).
    let materialized: Vec<(String, Snapshot)> = rectified
        .iter()
        .map(|(sheet, rows)| {
            materialize_sheet(workspace, &sheet.name, rows).map(|snap| (sheet.name.clone(), snap))
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Name + append: reference = sanitized sheet name, display = raw sheet
    // name (ADR-0037's dual-name scheme, the session face's commit_excel
    // shape), each de-conflicted against the manifest AND the batch so two
    // sheets that sanitize alike never collide.
    let mut out = Vec::with_capacity(materialized.len());
    let mut reserved_ref: HashSet<String> = HashSet::new();
    let mut reserved_disp: HashSet<String> = HashSet::new();
    for (sheet_name, snapshot) in materialized {
        let taken_ref =
            |n: &str| entries.iter().any(|e| e.reference_name == n) || reserved_ref.contains(n);
        let reference = crate::workingset::deconflict_loop(
            &ingest::sanitize_sheet_name(&sheet_name),
            taken_ref,
            |c, n| format!("{c}_{n}"),
        );
        reserved_ref.insert(reference.clone());
        let taken_disp =
            |n: &str| entries.iter().any(|e| e.display_name == n) || reserved_disp.contains(n);
        let display = crate::workingset::deconflict_loop(&sheet_name, taken_disp, |c, n| {
            format!("{c} ({n})")
        });
        reserved_disp.insert(display.clone());
        let entry =
            entry_from_materialized(reference, display, snapshot, DatasetPrivacy::default(), src);
        entries.push(entry.clone());
        out.push(entry);
    }
    write_entries(workspace, &entries)?;
    // The dialog resolved on a successful commit: drop THIS key's parked
    // parse (a failed commit keeps it -- the dialog stays open for retry
    // and its paging must keep working).
    discard_parked(workspace, src);
    Ok(out)
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
    display_name: String,
    snapshot: Snapshot,
    privacy: DatasetPrivacy,
    src: &Path,
) -> DatasetEntry {
    let fingerprint = store_fingerprint(&snapshot.file_path);
    // Stat the store file (the data body) -- copy_in / reopen_read_only both
    // drop their connection before returning, so the on-disk size is final
    // (issue #1485).
    let size_bytes = crate::session::snapshot::snapshot_len(&snapshot.file_path);
    DatasetEntry {
        reference_name,
        display_name,
        fingerprint,
        size_bytes,
        columns: snapshot.columns,
        row_count: snapshot.row_count,
        sample: snapshot.sample,
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
    // Out of scope by the D11 revision: content swaps through a workbook go
    // remove-then-reimport (the actionable copy rides the error).
    if is_xlsx(src) {
        return Err(StoreError::XlsxRejected);
    }
    let _guard = manifest_lock();
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
        // The display label survives a content swap (the rename outlives
        // replace, same as the private face).
        entries[idx].display_name.clone(),
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
    let _guard = manifest_lock();
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
    let _guard = manifest_lock();
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

/// Rename an entry's display label (ADR-0037's dual-name scheme on the
/// shared face): changes only the display name, never the reference name --
/// SQL references, the resume triple and the injection card are untouched.
/// The label is trimmed; a blank result refuses. Uniqueness is enforced
/// against OTHER entries' labels only -- a no-op rename to the entry's own
/// current label is allowed.
pub fn rename(
    workspace: &Path,
    reference_name: &str,
    new_display: &str,
) -> Result<DatasetEntry, StoreError> {
    let _guard = manifest_lock();
    let mut entries = load_entries(workspace)?;
    let idx = entries
        .iter()
        .position(|e| e.reference_name == reference_name)
        .ok_or(StoreError::NotFound)?;
    // Trim before any check: surrounding whitespace must not perturb
    // display-layer uniqueness, and a blank label is rejected.
    let label = new_display.trim();
    if label.is_empty() {
        return Err(StoreError::InvalidLabel);
    }
    let taken_by_other = entries
        .iter()
        .enumerate()
        .any(|(i, e)| i != idx && e.display_name == label);
    if taken_by_other {
        return Err(StoreError::DisplayTaken(label.to_string()));
    }
    entries[idx].display_name = label.to_string();
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
            let file_missing = entry_file(workspace, &entry).is_none();
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

/// Dispatch a source for the shared face's direct add/replace: CSV / Parquet /
/// JSON+JSONL share the copy-in path; legacy .xls and unknown formats refuse
/// like the private face. xlsx never reaches here -- the add and replace
/// faces guard it off first (the guided import owns that format, ADR-0141
/// D11 as revised by issue #1552), so the reader has no xlsx arm to remove.
fn dispatch_reader(src: &Path) -> Result<&'static str, StoreError> {
    match ingest::dispatch(src) {
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

/// Whether the source is an .xlsx workbook -- the guided import's format,
/// refused on the direct add/replace channels (ADR-0141 D11 as revised).
fn is_xlsx(src: &Path) -> bool {
    matches!(ingest::dispatch(src), ingest::Dispatched::Xlsx)
}

/// Validate a guided-import source IS an .xlsx workbook (the face's only
/// multi-sheet format; every other dispatch is a misrouted channel).
fn excel_source(src: &Path) -> Result<(), StoreError> {
    match ingest::dispatch(src) {
        ingest::Dispatched::Xlsx => Ok(()),
        ingest::Dispatched::Xls => Err(StoreError::LegacyExcel),
        dispatched => Err(StoreError::UnsupportedFormat {
            requested: match dispatched {
                ingest::Dispatched::Unsupported(ext) => ext,
                _ => String::new(),
            },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn csv(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, contents).expect("write csv");
        p
    }

    /// UTF-16 LE bytes with the BOM, the Excel "Unicode Text" save shape.
    fn write_utf16_le(path: &Path, text: &str) {
        let mut bytes: Vec<u8> = vec![0xFF, 0xFE];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        fs::write(path, bytes).expect("write utf-16");
    }

    const PEOPLE: &str = "name,score\nAda,9\nGrace,7\n";

    fn ws() -> tempfile::TempDir {
        tempfile::tempdir().expect("workspace dir")
    }

    fn src_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("source dir")
    }

    /// One fixture cell: text or integer (enough for the guided-import pins
    /// -- the type mix is the CSV renderer's contract, already pinned on the
    /// session face).
    enum CV {
        S(&'static str),
        I(i32),
    }

    /// Generate an .xlsx fixture (rust_xlsxwriter, no binaries committed --
    /// the ingest blackbox suite's posture) with one worksheet per entry.
    fn xlsx(dir: &Path, name: &str, sheets: &[(&str, &[&[CV]])]) -> PathBuf {
        let mut book = rust_xlsxwriter::Workbook::new();
        for (sheet_name, rows) in sheets {
            let sheet = book.add_worksheet();
            sheet.set_name(*sheet_name).expect("sheet name");
            for (r, row) in rows.iter().enumerate() {
                for (c, cell) in row.iter().enumerate() {
                    match cell {
                        CV::S(v) => {
                            sheet.write(r as u32, c as u16, *v).expect("write text");
                        }
                        CV::I(v) => {
                            sheet.write(r as u32, c as u16, *v).expect("write int");
                        }
                    }
                }
            }
        }
        let p = dir.join(name);
        book.save(&p).expect("save xlsx");
        p
    }

    fn pick(sheet: &str, header_row: u32) -> SheetGuidance {
        SheetGuidance {
            name: sheet.to_string(),
            rectify: crate::model::SheetRectify {
                header_row,
                skip_rows: Vec::new(),
            },
        }
    }

    fn store_file_count(workspace: &Path) -> usize {
        match fs::read_dir(store_dir(workspace)) {
            Ok(dir) => dir.count(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => panic!("store dir: {e}"),
        }
    }

    fn park_len() -> usize {
        PREVIEW_PARK.lock().unwrap_or_else(|p| p.into_inner()).len()
    }

    const PEOPLE_ROWS: &[&[CV]] = &[
        &[CV::S("name"), CV::S("score")],
        &[CV::S("Ada"), CV::I(9)],
        &[CV::S("Grace"), CV::I(7)],
    ];

    /// The guided add lands one entry per CHECKED sheet; the skipped sheet
    /// lands nothing (ADR-0148's per-sheet acceptance on the shared face).
    #[test]
    fn guided_add_lands_checked_sheets_only() {
        let workspace = ws();
        let sources = src_dir();
        let book = xlsx(
            sources.path(),
            "book.xlsx",
            &[("People", PEOPLE_ROWS), ("Extra", PEOPLE_ROWS)],
        );
        let landed = add_guided(workspace.path(), &book, &[pick("People", 1)]).expect("guided add");
        assert_eq!(landed.len(), 1, "only the checked sheet");
        // The sanitizer keeps case (the private face's sheet-name contract).
        assert_eq!(landed[0].reference_name, "People");
        assert_eq!(landed[0].display_name, "People");
        let entries = load_entries(workspace.path()).expect("reload");
        assert_eq!(entries.len(), 1);
        assert!(entries.iter().all(|e| e.reference_name != "Extra"));
    }

    /// The defensive floor: an empty selection and an all-unknown-names
    /// selection both refuse with the shared ADR-0148 wording, nothing lands
    /// (the dialog disables its submit; this catches any bypassing client).
    #[test]
    fn empty_or_unknown_guidance_refuses() {
        let workspace = ws();
        let sources = src_dir();
        let book = xlsx(sources.path(), "book.xlsx", &[("People", PEOPLE_ROWS)]);
        for guidance in [&[][..], &[pick("Ghost", 1)][..]] {
            let err = add_guided(workspace.path(), &book, guidance).expect_err("the floor refuses");
            match err {
                StoreError::DataUnreadable { detail } => {
                    assert_eq!(detail, ingest::excel::NO_SHEET_SELECTED);
                }
                other => panic!("expected the selection floor, got {other:?}"),
            }
        }
        assert!(
            load_entries(workspace.path()).expect("reload").is_empty(),
            "the refused commits landed nothing"
        );
        assert_eq!(store_file_count(workspace.path()), 0);
    }

    /// Content addressing (the D11 revision's core pin): the store key is
    /// the RECTIFIED SHEET's canonical CSV hash -- the same sheet content
    /// reuses one store file across imports and workbooks, an edited sheet
    /// splits into a new key, and editing an UNRELATED sheet never disturbs
    /// the reused one.
    #[test]
    fn content_addressing_reuses_and_splits() {
        let workspace = ws();
        let sources = src_dir();
        let book1 = xlsx(
            sources.path(),
            "one.xlsx",
            &[("People", PEOPLE_ROWS), ("Noise", PEOPLE_ROWS)],
        );
        let first =
            add_guided(workspace.path(), &book1, &[pick("People", 1)]).expect("import people");
        let key = first[0].fingerprint.clone();
        assert_eq!(store_file_count(workspace.path()), 1);

        // Same book, same sheet again: a second entry shares the file.
        let again = add_guided(workspace.path(), &book1, &[pick("People", 1)]).expect("re-import");
        assert_eq!(again[0].reference_name, "People_2", "batch de-conflict");
        assert_eq!(again[0].fingerprint, key, "same content, same key");
        assert_eq!(store_file_count(workspace.path()), 1);

        // A DIFFERENT workbook whose People sheet is byte-identical: the
        // key follows the content, not the container.
        let book2 = xlsx(
            sources.path(),
            "two.xlsx",
            &[("People", PEOPLE_ROWS), ("Noise", &[&[CV::S("x")]])],
        );
        let cross =
            add_guided(workspace.path(), &book2, &[pick("People", 1)]).expect("cross-book import");
        assert_eq!(cross[0].fingerprint, key, "cross-workbook reuse");
        assert_eq!(store_file_count(workspace.path()), 1);

        // Edited sheet content: a new key, a new store file.
        let edited: &[&[CV]] = &[
            &[CV::S("name"), CV::S("score")],
            &[CV::S("Ada"), CV::I(10)],
            &[CV::S("Grace"), CV::I(7)],
        ];
        let book3 = xlsx(
            sources.path(),
            "three.xlsx",
            &[("People", edited), ("Noise", PEOPLE_ROWS)],
        );
        let split =
            add_guided(workspace.path(), &book3, &[pick("People", 1)]).expect("edited import");
        assert_ne!(split[0].fingerprint, key, "edited content, new key");
        assert_eq!(store_file_count(workspace.path()), 2);
    }

    /// Naming (ADR-0037's dual-name scheme + ADR-0141 D6 on the guided
    /// face): sheets that SANITIZE alike never collide with each other or
    /// the manifest's reference vocabulary (the sanitizer keeps case, so a
    /// collision needs crafted names), and a raw sheet name colliding with
    /// a taken display label de-conflicts at the display layer.
    #[test]
    fn names_deconflict_within_batch_and_manifest() {
        let workspace = ws();
        let sources = src_dir();
        // Pre-seed the reference vocabulary AND a taken display label.
        add(workspace.path(), &csv(sources.path(), "east.csv", PEOPLE)).expect("seed east");
        rename(workspace.path(), "east", "Orders").expect("seed label");

        // "East 1" and "East_1!" are distinct sheet names that sanitize to
        // the same reference ("East_1"); "Orders" hits the seeded label.
        let book = xlsx(
            sources.path(),
            "book.xlsx",
            &[
                ("East 1", PEOPLE_ROWS),
                ("East_1!", PEOPLE_ROWS),
                ("Orders", PEOPLE_ROWS),
            ],
        );
        let landed = add_guided(
            workspace.path(),
            &book,
            &[pick("East 1", 1), pick("East_1!", 1), pick("Orders", 1)],
        )
        .expect("guided add");
        let refs: Vec<&str> = landed.iter().map(|e| e.reference_name.as_str()).collect();
        assert_eq!(refs, ["East_1", "East_1_2", "Orders"], "reference layer");
        let displays: Vec<&str> = landed.iter().map(|e| e.display_name.as_str()).collect();
        assert_eq!(
            displays,
            ["East 1", "East_1!", "Orders (2)"],
            "display layer de-conflicts against the manifest's taken label"
        );
    }

    /// Transactionality: an out-of-range header aborts the whole commit
    /// before any materialization -- the manifest and the store stay empty.
    #[test]
    fn out_of_range_header_aborts_without_landing() {
        let workspace = ws();
        let sources = src_dir();
        let book = xlsx(sources.path(), "book.xlsx", &[("People", PEOPLE_ROWS)]);
        let err = add_guided(workspace.path(), &book, &[pick("People", 99)])
            .expect_err("the range guard refuses");
        assert!(matches!(err, StoreError::DataUnreadable { .. }), "{err:?}");
        assert!(load_entries(workspace.path()).expect("reload").is_empty());
        assert_eq!(store_file_count(workspace.path()), 0);
    }

    /// The D11 guard faces: the direct add channel refuses xlsx (the guided
    /// import owns the format), and replace refuses it with the actionable
    /// remove-and-reimport posture.
    #[test]
    fn add_and_replace_refuse_xlsx() {
        let workspace = ws();
        let sources = src_dir();
        let book = xlsx(sources.path(), "book.xlsx", &[("People", PEOPLE_ROWS)]);
        assert_eq!(
            add(workspace.path(), &book),
            Err(StoreError::XlsxRejected),
            "the bypass floor on the direct add face"
        );
        add(workspace.path(), &csv(sources.path(), "people.csv", PEOPLE)).expect("seed");
        assert_eq!(
            replace(workspace.path(), "people", &book),
            Err(StoreError::XlsxRejected),
            "replace stays out of scope"
        );
    }

    /// The preview park: the payload carries every visible sheet's two-state
    /// (auto-detected header guess / the failure reason), the parked parse
    /// serves the pager's windows without a re-read, a repeated preview of
    /// the same key replaces instead of accumulating, discard drops it, and
    /// a successful guided commit drops it too (a failed one keeps it --
    /// the dialog stays open for retry).
    #[test]
    fn preview_park_lifecycle() {
        let workspace = ws();
        let sources = src_dir();
        let messy: &[&[CV]] = &[
            &[CV::S("base"), CV::S("base"), CV::S("contact")],
            &[CV::S("id"), CV::S("name"), CV::S("email")],
            &[CV::I(1), CV::S("Alice"), CV::S("a@x")],
        ];
        let book = xlsx(
            sources.path(),
            "book.xlsx",
            &[("People", PEOPLE_ROWS), ("Messy", messy)],
        );

        let request = preview(workspace.path(), &book).expect("preview");
        assert_eq!(request.sheets.len(), 2);
        match &request.sheets[0].state {
            crate::model::GuidanceSheetState::AutoTidied { header_row } => {
                assert_eq!(*header_row, 1);
            }
            other => panic!("expected AutoTidied, got {other:?}"),
        }
        match &request.sheets[1].state {
            crate::model::GuidanceSheetState::NeedsGuidance { .. } => {}
            other => panic!("expected NeedsGuidance, got {other:?}"),
        }
        assert_eq!(park_len(), 1, "the parse parks keyed by (ws, path)");

        // The pager reads from the park; a clamp and an overshoot stay honest.
        let window = parked_window(workspace.path(), &book, "People", 0, 12).expect("window");
        assert_eq!(window.len(), 3);
        assert_eq!(window[0], vec!["name", "score"]);
        assert!(parked_window(workspace.path(), &book, "People", 99, 12)
            .expect("overshoot is an empty window, not a miss")
            .is_empty());
        assert!(parked_window(workspace.path(), &book, "Ghost", 0, 12).is_none());

        // A repeated preview of the same key replaces the entry.
        preview(workspace.path(), &book).expect("re-preview");
        assert_eq!(park_len(), 1, "no accumulation on the same key");

        // A failed guided commit keeps the park (retry paging still works);
        // a successful one drops it.
        add_guided(workspace.path(), &book, &[pick("Ghost", 1)]).expect_err("the floor refuses");
        assert_eq!(park_len(), 1, "failure keeps the park");
        add_guided(workspace.path(), &book, &[pick("People", 1)]).expect("commit");
        assert_eq!(park_len(), 0, "a landed commit drops the park");

        // The dialog-cancel path: preview then discard leaves nothing.
        preview(workspace.path(), &book).expect("re-preview");
        discard_parked(workspace.path(), &book);
        assert_eq!(park_len(), 0);
        assert!(parked_window(workspace.path(), &book, "People", 0, 12).is_none());
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

    /// The add path's default label de-conflicts at the display layer: an
    /// add never lands on a label a rename already took (two management
    /// rows must never share a label).
    #[test]
    fn add_deconflicts_the_default_label_against_renames() {
        let workspace = ws();
        let sources = src_dir();
        let people = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &people).expect("add");
        rename(workspace.path(), "people", "Folks").expect("rename");
        // "Folks" is free as a reference name but taken as a display label.
        let folks = csv(sources.path(), "Folks.csv", "name,score\nAda,9\n");
        let entry = add(workspace.path(), &folks).expect("add");
        assert_eq!(entry.reference_name, "Folks");
        assert_eq!(entry.display_name, "Folks (2)");
    }

    /// The store file lands at <sha256>.duckdb and a second materialization
    /// of the same content is a hit (zero conversion, ADR-0141 D2).
    #[test]
    fn materialize_hits_the_store_and_skips_conversion() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let first = materialize(workspace.path(), &src, "read_csv_auto").expect("first");
        let second = materialize(workspace.path(), &src, "read_csv_auto").expect("second");
        // Shape derives identically on the hit path.
        assert_eq!(second.row_count, first.row_count);
        assert_eq!(second.columns, first.columns);
        let files = fs::read_dir(store_dir(workspace.path()))
            .expect("store dir")
            .count();
        assert_eq!(files, 1, "one physical file for one content key");
    }

    /// The snapshot's identity on the shared face is the store key (the
    /// source bytes' SHA256) -- NOT a table-content fingerprint: both the
    /// miss and hit paths skip the full-table CSV dump + hash pass
    /// (issue #1506), so a GB-scale import pays neither the export cost nor
    /// its transient disk spike, and a content hit is hash + metadata only.
    /// The price fixture guarantees the two hashes differ as text: the
    /// source keeps `1.50` while a table dump would render the DOUBLE as
    /// `1.5`.
    #[test]
    fn shared_snapshot_identity_is_the_store_key_on_both_paths() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "prices.csv", "item,price\nwidget,1.50\n");
        let key = format!("{:x}", Sha256::digest(fs::read(&src).expect("src bytes")));
        let miss = materialize(workspace.path(), &src, "read_csv_auto").expect("miss");
        assert_eq!(
            miss.fingerprint, key,
            "the miss path does not derive a table-content hash"
        );
        let hit = materialize(workspace.path(), &src, "read_csv_auto").expect("hit");
        assert_eq!(
            hit.fingerprint, key,
            "the hit path does not derive a table-content hash"
        );
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
        assert_ne!(first.file_path, second.file_path, "content keys differ");
    }

    /// Semantic corruption refuses like a syntax failure: a duplicate
    /// reference name or an empty fingerprint copy-asides the manifest and
    /// blocks every mutation (the hand-edited-manifest honesty posture).
    #[test]
    fn duplicate_names_and_empty_fingerprints_refuse_as_corrupt() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add");
        // Hand-edit a duplicate of the entry into the manifest.
        let mut entries: Vec<DatasetEntry> = serde_json::from_str(
            &fs::read_to_string(manifest_path(workspace.path())).expect("manifest"),
        )
        .expect("entries");
        entries.push(entries[0].clone());
        fs::write(
            manifest_path(workspace.path()),
            serde_json::to_string(&entries).expect("serialize"),
        )
        .expect("write");
        assert!(matches!(
            load_entries(workspace.path()).expect_err("duplicate refuses"),
            StoreError::ManifestCorrupt { .. }
        ));
        assert!(
            manifest_path(workspace.path())
                .with_extension("json.corrupt")
                .exists(),
            "the corrupt copy-aside lands"
        );
        // An empty fingerprint refuses the same way (the reservation
        // sentinel must stay a session-side encoding, never a manifest one).
        entries[1].fingerprint = String::new();
        fs::write(
            manifest_path(workspace.path()),
            serde_json::to_string(&entries).expect("serialize"),
        )
        .expect("write");
        assert!(matches!(
            load_entries(workspace.path()).expect_err("empty fingerprint refuses"),
            StoreError::ManifestCorrupt { .. }
        ));
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

    /// entry_file is the single missing-file resolution: the landed store
    /// path for a live entry, None for a gone one (the list flag above and
    /// the session attach's missing-entry error both read this).
    #[test]
    fn entry_file_resolves_the_landed_store_and_none_for_a_gone_one() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let entry = add(workspace.path(), &src).expect("add");
        assert_eq!(
            entry_file(workspace.path(), &entry),
            Some(store_file(workspace.path(), &entry.fingerprint))
        );
        let mut gone = entry.clone();
        gone.fingerprint = "deadbeef".to_string();
        assert_eq!(entry_file(workspace.path(), &gone), None);
    }

    /// add pins the fresh entry's display label to the reference name
    /// (the dual-name default), and the label lands on disk.
    #[test]
    fn add_defaults_display_name_to_reference_name() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let entry = add(workspace.path(), &src).expect("add");
        assert_eq!(entry.display_name, "people");
        let manifest = fs::read_to_string(manifest_path(workspace.path())).expect("manifest");
        assert!(manifest.contains("\"display_name\": \"people\""));
    }

    /// rename changes only the display label (ADR-0037's dual-name scheme on
    /// the shared face): the reference name, fingerprint and privacy stay
    /// untouched, and the new label lands on disk.
    #[test]
    fn rename_changes_only_label_not_reference() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let original = add(workspace.path(), &src).expect("add");
        let renamed = rename(workspace.path(), "people", "Folks").expect("rename");
        assert_eq!(renamed.display_name, "Folks");
        assert_eq!(renamed.reference_name, "people");
        assert_eq!(renamed.fingerprint, original.fingerprint);
        assert_eq!(renamed.privacy, original.privacy);
        let reloaded = load_entries(workspace.path()).expect("reload");
        assert_eq!(reloaded[0].display_name, "Folks", "label persisted");
    }

    /// rename rejects a blank label, trims surrounding whitespace, and a
    /// rename to the entry's own current label is a no-op (the private
    /// rename_display scheme).
    #[test]
    fn rename_rejects_blank_trims_and_allows_own_label() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add");
        assert_eq!(
            rename(workspace.path(), "people", "   "),
            Err(StoreError::InvalidLabel)
        );
        let trimmed = rename(workspace.path(), "people", "  Folks  ").expect("trimmed");
        assert_eq!(trimmed.display_name, "Folks");
        let own = rename(workspace.path(), "people", "Folks").expect("own label");
        assert_eq!(own.display_name, "Folks");
    }

    /// Display-layer uniqueness: a label taken by ANOTHER entry refuses and
    /// nothing lands; an unknown reference name is an honest NotFound.
    #[test]
    fn rename_refuses_taken_label_and_unknown_name() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add a");
        add(workspace.path(), &src).expect("add b");
        assert_eq!(
            rename(workspace.path(), "people", "people_2"),
            Err(StoreError::DisplayTaken("people_2".into()))
        );
        let reloaded = load_entries(workspace.path()).expect("reload");
        assert!(
            reloaded.iter().all(|e| e.display_name == e.reference_name),
            "the refused rename landed nothing"
        );
        assert_eq!(
            rename(workspace.path(), "ghost", "Any"),
            Err(StoreError::NotFound)
        );
    }

    /// replace preserves the display label -- a rename survives a content
    /// swap (the private face's replace semantics).
    #[test]
    fn replace_preserves_display_name() {
        let workspace = ws();
        let sources = src_dir();
        add(workspace.path(), &csv(sources.path(), "people.csv", PEOPLE)).expect("add");
        rename(workspace.path(), "people", "Folks").expect("rename");
        let next = csv(
            sources.path(),
            "people_v2.csv",
            "name,score\nAda,9\nLin,8\n",
        );
        let replaced = replace(workspace.path(), "people", &next).expect("replace");
        assert_eq!(replaced.display_name, "Folks", "label survives the swap");
        assert_eq!(replaced.reference_name, "people");
    }

    /// A manifest written before the display label existed loads with the
    /// label falling back to the reference name, and the next manifest write
    /// lands the field (the old-manifest upgrade posture).
    #[test]
    fn old_manifest_without_display_name_falls_back_to_reference_name() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        add(workspace.path(), &src).expect("add");
        let fingerprint = load_entries(workspace.path()).expect("load")[0]
            .fingerprint
            .clone();
        // Hand-write a pre-field manifest: no display_name anywhere.
        let raw = format!(
            "[{{\"reference_name\":\"people\",\"fingerprint\":\"{fingerprint}\",\"columns\":[],\"row_count\":2,\"sample\":[],\"source_path\":\"x\"}}]"
        );
        fs::write(manifest_path(workspace.path()), raw).expect("write old manifest");
        let loaded = load_entries(workspace.path()).expect("load old");
        assert_eq!(loaded[0].display_name, "people", "label falls back");
        // The next write persists the recovered label.
        set_privacy(workspace.path(), "people", DatasetPrivacy::default()).expect("write");
        let manifest = fs::read_to_string(manifest_path(workspace.path())).expect("manifest");
        assert!(
            manifest.contains("\"display_name\": \"people\""),
            "{manifest}"
        );
    }

    /// The landed entry carries the store file's byte size (issue #1485) --
    /// stat'ed off the store file itself (the data body), not the source.
    #[test]
    fn add_stats_the_store_file_size() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let entry = add(workspace.path(), &src).expect("add");
        let store_len = fs::metadata(store_file(workspace.path(), &entry.fingerprint))
            .expect("store file")
            .len();
        assert_eq!(entry.size_bytes, store_len, "size mirrors the store file");
        assert!(entry.size_bytes > 0);
        // The field rides the manifest (the next read sees it without a stat).
        let reloaded = load_entries(workspace.path()).expect("reload");
        assert_eq!(reloaded[0].size_bytes, store_len);
    }

    /// A manifest written before size_bytes existed loads with 0 (the old-
    /// manifest upgrade posture); the UI renders no size line for 0, never a
    /// fake figure. The field itself always serializes.
    #[test]
    fn old_manifest_without_size_bytes_loads_zero() {
        let workspace = ws();
        let sources = src_dir();
        let src = csv(sources.path(), "people.csv", PEOPLE);
        let entry = add(workspace.path(), &src).expect("add");
        let fingerprint = entry.fingerprint.clone();
        // Hand-write a pre-field manifest: no size_bytes anywhere.
        let raw = format!(
            "[{{\"reference_name\":\"people\",\"fingerprint\":\"{fingerprint}\",\"columns\":[],\"row_count\":2,\"sample\":[],\"source_path\":\"x\"}}]"
        );
        fs::write(manifest_path(workspace.path()), raw).expect("write old manifest");
        let loaded = load_entries(workspace.path()).expect("load old");
        assert_eq!(loaded[0].size_bytes, 0, "missing field defaults to 0");
        // Serialization always carries the key (the wire contract).
        let json = serde_json::to_value(&loaded[0]).expect("serialize");
        assert_eq!(json["size_bytes"], serde_json::json!(0));
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

    /// A UTF-16 LE CSV with a BOM (the Excel "Unicode Text" save) imports
    /// intact: the sniffer only tries utf-8, so the loader must retry with
    /// the encoding pinned -- columns and rows must survive the round trip.
    #[test]
    fn utf16_bom_csv_imports_after_retry() {
        let workspace = ws();
        let sources = src_dir();
        let src = sources.path().join("bulk.csv");
        write_utf16_le(&src, "Dataset\tName\tValue\nA\tB\t1\nC\tD\t2\n");
        let entry = add(workspace.path(), &src).expect("a BOM-carrying UTF-16 CSV imports");
        assert_eq!(entry.columns.len(), 3, "tab-delimited columns survive");
        assert_eq!(entry.columns[0].name, "Dataset");
        assert_eq!(entry.row_count, 2);
    }

    /// Without the BOM the loader cannot tell encoding from bytes: the
    /// sniffer fails outright and the refusal lands as the typed
    /// DataUnreadable variant -- never as the Io echo that would surface the
    /// raw engine string on the panel.
    #[test]
    fn bomless_utf16_csv_refuses_as_csv_unreadable() {
        let workspace = ws();
        let sources = src_dir();
        let src = sources.path().join("bomless.csv");
        write_utf16_le(&src, "name\tscore\nada\t9\n");
        // Strip the BOM the helper just wrote (the first two bytes).
        let bytes = fs::read(&src).expect("read back");
        fs::write(&src, &bytes[2..]).expect("strip BOM");
        let err = add(workspace.path(), &src).expect_err("a sniffer-blind CSV refuses");
        match err {
            StoreError::DataUnreadable { detail } => {
                assert!(!detail.is_empty(), "the engine detail rides for triage");
            }
            other => panic!("expected DataUnreadable, got {other:?}"),
        }
        assert!(load_entries(workspace.path()).expect("load").is_empty());
    }

    /// A BOM-carrying file with an odd total length can never be valid
    /// UTF-16 (a BOM plus code units is always 2+2n bytes), so the retry
    /// must not fire: the engine's decoder is permissive enough that the
    /// garbage would land as a mojibake table instead of a refusal.
    #[test]
    fn odd_length_bom_csv_refuses_as_csv_unreadable() {
        let workspace = ws();
        let sources = src_dir();
        let src = sources.path().join("odd.csv");
        // Five bytes: LE BOM plus three garbage bytes -- odd, undecodable.
        fs::write(&src, [0xFF, 0xFE, 0x80, 0x81, 0xC0]).expect("write odd");
        let err = add(workspace.path(), &src).expect_err("an odd-length BOM file refuses");
        assert!(
            matches!(err, StoreError::DataUnreadable { .. }),
            "expected DataUnreadable, got {err:?}"
        );
        assert!(load_entries(workspace.path()).expect("load").is_empty());
    }

    /// A UTF-16 BE BOM must also refuse: the engine's utf-16 decoding is
    /// little-endian only, so a BE file would transcode to mojibake and
    /// import as garbage rather than fail -- the retry is LE-only on
    /// purpose.
    #[test]
    fn utf16_be_bom_csv_refuses_as_csv_unreadable() {
        let workspace = ws();
        let sources = src_dir();
        let src = sources.path().join("be.csv");
        let text = "Dataset\tName\nA\tB\n";
        let mut bytes: Vec<u8> = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        fs::write(&src, bytes).expect("write utf-16 be");
        let err = add(workspace.path(), &src).expect_err("a BE BOM file refuses");
        assert!(
            matches!(err, StoreError::DataUnreadable { .. }),
            "expected DataUnreadable, got {err:?}"
        );
        assert!(load_entries(workspace.path()).expect("load").is_empty());
    }

    /// The LoadError::Parse -> DataUnreadable mapping keeps the engine detail
    /// (the panel appends it after the catalog sentence).
    #[test]
    fn parse_load_errors_map_to_csv_unreadable_with_detail() {
        let e: StoreError = crate::model::LoadError::Parse {
            detail: "sniff failed".into(),
        }
        .into();
        assert_eq!(
            e,
            StoreError::DataUnreadable {
                detail: "sniff failed".into()
            }
        );
    }
}
