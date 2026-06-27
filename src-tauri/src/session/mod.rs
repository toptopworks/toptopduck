//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012). The
//! per-session temp dir holds the snapshot files and is cleared on drop (ADR-0029).

pub mod snapshot;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use duckdb::Connection;
use tempfile::TempDir;

use crate::ingest;
use crate::model::{DatasetDescriptor, LoadError, LoadOutcome};
use crate::workingset::WorkingSet;

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
            ingest::Dispatched::Xlsx => self.ingest_excel(path),
            _ => {
                let Some(reader) = ingest::reader_for(&dispatched) else {
                    let requested = match dispatched {
                        ingest::Dispatched::Unsupported(ext) => ext,
                        // Unreachable today (every supported variant maps to a
                        // reader or to the excel path), but kept total so a
                        // future variant can't silently fall through.
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
        };
        self.working_set.register(descriptor.clone());
        LoadOutcome::Loaded(descriptor)
    }

    /// Ingest a .xlsx workbook (slice 3a, issue #7): each sheet maps to one
    /// Dataset named after the sheet. Formula cells use their cached value,
    /// never recomputed (ADR-0015). Transactional -- on any failure the working
    /// set is unchanged and already-attached snapshots are rolled back (AC6/AC7).
    /// Returns the active (last) sheet's descriptor; all sheets are queryable via
    /// [`Self::list`] / [`Self::get`].
    fn ingest_excel(&mut self, path: &Path) -> LoadOutcome {
        let mut sheets = match ingest::excel::read_sheets(path) {
            Ok(s) => s,
            Err(e) => return LoadOutcome::Error(e),
        };
        // Blank sheets contribute no Dataset (slice 3a basic loading).
        sheets.retain(|s| !s.rows.is_empty());
        if sheets.is_empty() {
            return LoadOutcome::Error(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        }

        // Pre-reserve de-conflicted reference names (after each sheet name)
        // against the working set AND each other, so duplicate sanitized names
        // never collide at ATTACH time. Registration is deferred until every
        // sheet has attached (a bad sheet never pollutes the session).
        let mut reserved: HashSet<String> = HashSet::new();
        let names: Vec<String> = sheets
            .iter()
            .map(|s| {
                let name = self
                    .working_set
                    .deconflict_with(&ingest::sanitize_sheet_name(&s.name), &reserved);
                reserved.insert(name.clone());
                name
            })
            .collect();

        // Copy-in + attach each sheet; roll back on any failure. Panic-safety
        // invariant: `attach_excel_sheet` must not panic between a successful
        // ATTACH and the `attached.push`, otherwise the just-attached snapshot
        // escapes rollback. It performs only infallible ops after ATTACH
        // succeeds today (push + struct construction; no unwrap/expect), so the
        // invariant holds -- keep it so when editing.
        let mut attached: Vec<String> = Vec::with_capacity(sheets.len());
        let mut descriptors: Vec<DatasetDescriptor> = Vec::with_capacity(sheets.len());
        for (sheet, reference_name) in sheets.iter().zip(names.iter()) {
            match self.attach_excel_sheet(path, sheet, reference_name, &mut attached) {
                Ok(d) => descriptors.push(d),
                Err(e) => {
                    self.rollback_excel(&attached);
                    return LoadOutcome::Error(e);
                }
            }
        }

        // All sheets attached: commit to the working set atomically. The empty
        // guard at the top of ingest_excel ensures descriptors is non-empty here;
        // prefer a returned error over a reachable panic regardless.
        let Some(active) = descriptors.last().cloned() else {
            return LoadOutcome::Error(LoadError::Parse {
                detail: "工作簿不含任何含数据的 sheet".into(),
            });
        };
        for d in descriptors {
            self.working_set.register(d);
        }
        LoadOutcome::Loaded(active)
    }

    /// Copy-in one sheet's cached values to a read-only snapshot and attach it.
    /// On failure the snapshot file is removed; the caller records successful
    /// attaches (`attached`) for transactional rollback.
    fn attach_excel_sheet(
        &mut self,
        path: &Path,
        sheet: &ingest::excel::SheetRows,
        reference_name: &str,
        attached: &mut Vec<String>,
    ) -> Result<DatasetDescriptor, LoadError> {
        // calamine cached values -> temp CSV -> read_csv_auto copy-in. DuckDB
        // infers types from the CSV, keeping the single-source-of-truth contract
        // (ADR-0032) shared with CSV/Parquet/JSON.
        let csv_path = ingest::excel::write_sheet_csv(sheet, &self.temp_path, reference_name)?;
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
            display_name: sheet.name.clone(),
            source_path: path.to_string_lossy().to_string(),
            columns: snap.columns,
            row_count: snap.row_count,
            sample: snap.sample,
            fingerprint: snap.fingerprint,
        })
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
