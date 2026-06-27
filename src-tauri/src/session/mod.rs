//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012). The
//! per-session temp dir holds the snapshot files and is cleared on drop (ADR-0029).

pub mod snapshot;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use calamine::Data;
use duckdb::Connection;
use tempfile::TempDir;

use crate::ingest;
use crate::ingest::tidy::{auto_tidy, forward_fill_merges, TidyOutcome};
use crate::model::{
    DatasetDescriptor, GuidanceRequest, GuidanceSheet, LoadError, LoadOutcome, SheetGuidance,
    SheetRectify,
};
use crate::workingset::WorkingSet;

/// Raw rows surfaced per sheet in the guided-load preview -- enough to spot the
/// header row and any separator/sub-header/footer rows to skip (ADR-0015).
const GUIDANCE_PREVIEW_ROWS: usize = 12;

pub struct Session {
    conn: Connection,
    working_set: WorkingSet,
    _temp_dir: TempDir, // held to keep its dir alive; cleared on drop (ADR-0029)
    temp_path: PathBuf,
}

impl Session {
    pub fn new() -> anyhow::Result<Self> {
        let temp_dir = tempfile::Builder::new()
            .prefix("toptopduck-session-")
            .tempdir()?;
        let temp_path = temp_dir.path().to_path_buf();
        let conn = Connection::open_in_memory()?;
        Ok(Self {
            conn,
            working_set: WorkingSet::default(),
            _temp_dir: temp_dir,
            temp_path,
        })
    }

    /// Ingest a file. Transactional: on any failure the working set is unchanged
    /// (bad files never pollute the session -- PRD AC7). CSV/Parquet/JSON share
    /// one copy-in path -- only the DuckDB reader differs (ADR-0032 shared
    /// contract, no format-specific branches). Excel (.xlsx) goes through
    /// [`Self::ingest_excel`]: each sheet becomes its own Dataset.
    pub fn ingest(&mut self, path: &Path) -> LoadOutcome {
        let dispatched = ingest::dispatch(path);
        match dispatched {
            // Legacy .xls is rejected up front with an actionable hint (ADR-0015)
            // -- never reaches copy-in, leaves the working set untouched.
            ingest::Dispatched::Xls => LoadOutcome::Error(LoadError::LegacyExcel),
            ingest::Dispatched::Xlsx => self.ingest_excel(path),
            _ => {
                let Some(reader) = ingest::reader_for(&dispatched) else {
                    let requested = match dispatched {
                        ingest::Dispatched::Unsupported(ext) => ext,
                        // Unreachable today (Xls/Xlsx are handled above); kept
                        // total so a future variant can't silently fall through.
                        _ => String::new(),
                    };
                    return LoadOutcome::Error(LoadError::UnsupportedFormat { requested });
                };
                self.ingest_structured(path, reader)
            }
        }
    }

    fn ingest_structured(&mut self, path: &Path, reader: &str) -> LoadOutcome {
        let reference_name = match ingest::derive_reference_name(path) {
            Some(n) => self.working_set.deconflict(&n),
            None => {
                return LoadOutcome::Error(LoadError::Io {
                    detail: "无法从路径推导数据集名".into(),
                })
            }
        };

        // copy-in must succeed before the working set is touched.
        let snap = match ingest::loader::copy_in(path, &self.temp_path, &reference_name, reader) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Attach the snapshot read-only (ADR-0005 engine-level enforcement).
        // `attach_path` is tool-controlled (temp dir + sanitized alias), not user
        // input, so interpolation is safe; the user-supplied source path is bound
        // as a parameter during copy-in (see ingest::loader).
        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_alias(&reference_name),
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            let _ = std::fs::remove_file(&snap.file_path);
            return LoadOutcome::Error(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }

        // ADR-0037: the display label is the readable original filename stem (the
        // SQL-safe reference name is sanitized above). Display-layer de-conflict
        // (identical stems) arrives in slice 4a; slice 1 keeps it simple.
        let display_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(reference_name.as_str())
            .to_string();

        let descriptor = DatasetDescriptor {
            reference_name: reference_name.clone(),
            display_name,
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify: None,
        };
        self.working_set.register(descriptor.clone());
        LoadOutcome::Loaded(descriptor)
    }

    /// Read a workbook's visible sheets and drop blank ones -- the shared
    /// preamble for both Excel ingest paths (auto-tidy and guided). Returns
    /// `Err` with a single shared message when no sheet carries data, so the
    /// "工作簿不含任何含数据的 sheet" wording lives in one place.
    fn read_non_empty_sheets(path: &Path) -> Result<Vec<ingest::excel::SheetRows>, LoadError> {
        let mut sheets = ingest::excel::read_sheets(path)?;
        sheets.retain(|s| !s.rows.is_empty());
        if sheets.is_empty() {
            return Err(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        }
        Ok(sheets)
    }

    /// Ingest a .xlsx workbook (slice 3b, issue #10): best-effort auto-tidy each
    /// sheet (ADR-0015) -- forward-fill merged cells + single-header detection.
    /// If every sheet tidies confidently, each becomes a Dataset (`rectify =
    /// None`: the auto algorithm's choices aren't recorded, ADR-0042). If *any*
    /// sheet can't be confidently tidied, NO sheet is loaded -- the working set
    /// stays untouched and a [`LoadOutcome::NeedsGuidance`] carries each sheet's
    /// raw preview so the UI can gather explicit header/skip choices. Formula
    /// cells use their cached value (ADR-0015). Transactional: on any failure
    /// already-attached snapshots roll back (AC6/AC7).
    fn ingest_excel(&mut self, path: &Path) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Auto-tidy each sheet; the first that can't be confidently tidied sends
        // the whole workbook to guided loading (no partial load -- transactional).
        let mut entries: Vec<(String, Vec<Vec<Data>>, Option<SheetRectify>)> =
            Vec::with_capacity(sheets.len());
        for sheet in &sheets {
            match auto_tidy(sheet) {
                TidyOutcome::Tidied(t) => entries.push((sheet.name.clone(), t.rows, None)),
                TidyOutcome::NeedsGuidance => {
                    return LoadOutcome::NeedsGuidance(Self::build_guidance(path, &sheets));
                }
            }
        }

        match self.commit_excel(path, entries) {
            Ok(active) => LoadOutcome::Loaded(active),
            Err(e) => LoadOutcome::Error(e),
        }
    }

    /// Re-ingest an Excel workbook with the user's explicit rectify choices
    /// (ADR-0015 guided fallback / ADR-0042 user decisions). Each sheet is
    /// rectified by its [`SheetRectify`] (header row + skipped rows) and
    /// forward-filled over merged cells, then loaded with `rectify = Some(...)`
    /// recorded on the descriptor. Transactional like [`Self::ingest`].
    pub fn ingest_guided(&mut self, path: &Path, guidance: &[SheetGuidance]) -> LoadOutcome {
        let sheets = match Self::read_non_empty_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };

        // Apply each sheet's user rectify. A sheet with no guidance entry
        // defaults to a plain single-header rectify (header_row 1, no skips) --
        // the dialog sends one entry per visible sheet, this just stays safe.
        // Any out-of-range header_row aborts before copy-in so no partial load
        // escapes (transactional -- ADR-0042).
        let entries: Vec<(String, Vec<Vec<Data>>, Option<SheetRectify>)> = match sheets
            .iter()
            .map(|sheet| {
                let rectify = guidance
                    .iter()
                    .find(|g| g.name == sheet.name)
                    .map(|g| g.rectify.clone())
                    .unwrap_or_default();
                let rows = Self::apply_rectify(sheet, &rectify)?;
                Ok::<_, LoadError>((sheet.name.clone(), rows, Some(rectify)))
            })
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(e) => e,
            Err(e) => return LoadOutcome::Error(e),
        };

        match self.commit_excel(path, entries) {
            Ok(active) => LoadOutcome::Loaded(active),
            Err(e) => LoadOutcome::Error(e),
        }
    }

    /// Attach every `(display name, tidied rows, rectify)` entry as a read-only
    /// snapshot and register them atomically. De-conflicts reference names up
    /// front (against the working set + each other) so duplicate sanitized names
    /// never collide at ATTACH time. Rolls back on any failure (AC6/AC7).
    /// Returns the active (last) descriptor.
    fn commit_excel(
        &mut self,
        path: &Path,
        entries: Vec<(String, Vec<Vec<Data>>, Option<SheetRectify>)>,
    ) -> Result<DatasetDescriptor, LoadError> {
        let mut reserved: HashSet<String> = HashSet::new();
        let names: Vec<String> = entries
            .iter()
            .map(|(display, _, _)| {
                let name = self
                    .working_set
                    .deconflict_with(&ingest::sanitize_sheet_name(display), &reserved);
                reserved.insert(name.clone());
                name
            })
            .collect();

        // Copy-in + attach each entry; roll back on any failure. Panic-safety
        // invariant (carried from slice 3a): `attach_sheet` does only infallible
        // ops after ATTACH succeeds, so a just-attached snapshot never escapes
        // rollback -- keep it so when editing.
        let mut attached: Vec<String> = Vec::with_capacity(entries.len());
        let mut descriptors: Vec<DatasetDescriptor> = Vec::with_capacity(entries.len());
        for ((display, rows, rectify), reference_name) in entries.into_iter().zip(&names) {
            match self.attach_sheet(
                path,
                &display,
                reference_name,
                &rows,
                rectify,
                &mut attached,
            ) {
                Ok(d) => descriptors.push(d),
                Err(e) => {
                    self.rollback_excel(&attached);
                    return Err(e);
                }
            }
        }

        // All attached: commit atomically. entries is non-empty (guarded above),
        // but prefer a returned error over a reachable panic regardless.
        let Some(active) = descriptors.last().cloned() else {
            return Err(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        };
        for d in descriptors {
            self.working_set.register(d);
        }
        Ok(active)
    }

    /// Copy-in one tidied sheet's rows to a read-only snapshot and attach it.
    /// On failure the snapshot file is removed; the caller records successful
    /// attaches (`attached`) for transactional rollback.
    fn attach_sheet(
        &mut self,
        path: &Path,
        display_name: &str,
        reference_name: &str,
        rows: &[Vec<Data>],
        rectify: Option<SheetRectify>,
        attached: &mut Vec<String>,
    ) -> Result<DatasetDescriptor, LoadError> {
        // tidied rows -> temp CSV -> read_csv_auto copy-in. DuckDB infers types
        // from the CSV, keeping the single-source-of-truth contract (ADR-0032).
        let csv_path =
            ingest::excel::write_sheet_csv(rows, display_name, &self.temp_path, reference_name)?;
        // If copy-in fails the temp CSV must still be cleaned up -- the snapshot
        // file is copy_in's own responsibility, but the CSV is ours to remove.
        let snap = match ingest::loader::copy_in(
            &csv_path,
            &self.temp_path,
            reference_name,
            "read_csv_auto",
        ) {
            Ok(s) => s,
            Err(e) => {
                let _ = fs::remove_file(&csv_path);
                return Err(e);
            }
        };
        // The temp CSV is only needed during copy-in; the snapshot holds the data.
        let _ = fs::remove_file(&csv_path);

        let attach_path = snap.file_path.to_string_lossy();
        let attach_sql = format!(
            "ATTACH '{attach_path}' AS {} (READ_ONLY);",
            quote_alias(reference_name)
        );
        if let Err(e) = self.conn.execute_batch(&attach_sql) {
            let _ = fs::remove_file(&snap.file_path);
            return Err(LoadError::Other {
                detail: format!("挂载快照失败：{e}"),
            });
        }
        attached.push(reference_name.to_string());

        Ok(DatasetDescriptor {
            reference_name: reference_name.to_string(),
            display_name: display_name.to_string(),
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
            rectify,
        })
    }

    /// Build a [`GuidanceRequest`] from a workbook's sheets: each visible
    /// non-blank sheet's raw top rows rendered as strings (pre-rectify preview).
    fn build_guidance(path: &Path, sheets: &[ingest::excel::SheetRows]) -> GuidanceRequest {
        let workbook_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("workbook")
            .to_string();
        let sheets_preview = sheets
            .iter()
            .map(|s| GuidanceSheet {
                name: s.name.clone(),
                preview: ingest::excel::render_preview(s, GUIDANCE_PREVIEW_ROWS),
            })
            .collect();
        GuidanceRequest {
            source_path: path.to_string_lossy().to_string(),
            workbook_name,
            sheets: sheets_preview,
        }
    }

    /// Apply a user's rectify choices to a sheet's raw grid: forward-fill merged
    /// cells, then take the header from `header_row` (1-based) and the data rows
    /// below it minus `skip_rows` (1-based absolute). Deterministic for the same
    /// input + params (ADR-0042).
    ///
    /// `header_row` is validated to be in `1..=rows.len()`: a guided ingest is a
    /// `#[tauri::command]`, so the value crosses the IPC boundary, and an
    /// out-of-range header_row would otherwise silently yield a header-less table
    /// (range miss) or a header-duplicated table (`0` -- the first row serves as
    /// both header and data). Rejecting it keeps the user's explicit decision
    /// producing exactly the table they asked for (ADR-0042).
    fn apply_rectify(
        sheet: &ingest::excel::SheetRows,
        rectify: &SheetRectify,
    ) -> Result<Vec<Vec<Data>>, LoadError> {
        let mut rows = sheet.rows.clone();
        forward_fill_merges(&mut rows, &sheet.merges);
        if rectify.header_row == 0 || rectify.header_row as usize > rows.len() {
            return Err(LoadError::Parse {
                detail: format!(
                    "表头行号 {} 越界（sheet \"{}\" 共 {} 行，需在 1..={} 内）",
                    rectify.header_row,
                    sheet.name,
                    rows.len(),
                    rows.len()
                ),
            });
        }
        let header_idx = rectify.header_row as usize - 1;
        let mut out = Vec::with_capacity(rows.len());
        out.push(rows[header_idx].clone());
        let skip: HashSet<u32> = rectify.skip_rows.iter().copied().collect();
        for (i, row) in rows.iter().enumerate() {
            let abs = (i + 1) as u32; // 1-based absolute row
            if abs > rectify.header_row && !skip.contains(&abs) {
                out.push(row.clone());
            }
        }
        Ok(out)
    }

    /// Detach already-attached excel snapshots and delete their files (rollback).
    /// Best-effort: a DETACH or remove_file failure is logged, not swallowed
    /// silently. A failed DETACH can leave a ghost attachment on the connection
    /// (breaking a later same-name re-ATTACH), and on Windows a held handle can
    /// make remove_file fail too -- logging keeps either failure diagnosable.
    fn rollback_excel(&mut self, attached: &[String]) {
        for reference_name in attached.iter().rev() {
            if let Err(e) = self
                .conn
                .execute_batch(&format!("DETACH {};", quote_alias(reference_name)))
            {
                log::warn!(
                    target: "toptopduck::session",
                    "DETACH failed during excel rollback for {reference_name}: {e}"
                );
            }
            if let Err(e) = fs::remove_file(self.temp_path.join(format!("{reference_name}.duckdb")))
            {
                log::warn!(
                    target: "toptopduck::session",
                    "snapshot file removal failed during excel rollback for {reference_name}: {e}"
                );
            }
        }
    }

    pub fn list(&self) -> Vec<DatasetDescriptor> {
        self.working_set.list().to_vec()
    }

    pub fn active(&self) -> Option<DatasetDescriptor> {
        self.working_set.active().cloned()
    }

    pub fn get(&self, reference_name: &str) -> Option<DatasetDescriptor> {
        self.working_set.get(reference_name).cloned()
    }

    /// Run arbitrary SQL on the session connection. Exposed for the read-only
    /// enforcement tests (AC5): writes against a source snapshot are rejected by
    /// the engine. Not part of the public ingest contract.
    pub fn execute_batch(&self, sql: &str) -> Result<(), duckdb::Error> {
        self.conn.execute_batch(sql)
    }
}

fn quote_alias(name: &str) -> String {
    let escaped = name.replace('"', "\"\"");
    format!("\"{escaped}\"")
}
