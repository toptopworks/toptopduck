//! Per-session state: an in-memory DuckDB parent (working-set metadata + future
//! result_N) plus READ_ONLY-attached source snapshots (ADR-0004/0005/0012). The
//! per-session temp dir holds the snapshot files and is cleared on drop (ADR-0029).

pub mod snapshot;

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
    /// contract, no format-specific branches).
    pub fn ingest(&mut self, path: &Path) -> LoadOutcome {
        let dispatched = ingest::dispatch(path);
        let Some(reader) = ingest::reader_for(&dispatched) else {
            let requested = match dispatched {
                ingest::Dispatched::Unsupported(ext) => ext,
                // Unreachable today (every supported variant maps to a reader),
                // but kept total so a future variant can't silently fall through.
                _ => String::new(),
            };
            return LoadOutcome::Error(LoadError::UnsupportedFormat { requested });
        };
        self.ingest_structured(path, reader)
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
