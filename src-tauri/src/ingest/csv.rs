//! CSV loader (PRD #2 structured loader): copy-in a CSV into a frozen DuckDB
//! snapshot file (ADR-0004/0012) via DuckDB's native reader (no extension --
//! ADR-0014 N/A for CSV), then derive its descriptor pieces.

use std::fs;
use std::path::{Path, PathBuf};

use duckdb::{params, Connection};

use crate::model::LoadError;
use crate::session::snapshot::Snapshot;

/// Copy-in `src` into a per-session temp DuckDB file `<alias>.duckdb` and derive
/// the snapshot descriptor. The file is later attached READ_ONLY by the session.
pub fn load(src: &Path, temp_dir: &Path, alias: &str) -> Result<Snapshot, LoadError> {
    let file_path: PathBuf = temp_dir.join(format!("{alias}.duckdb"));
    // Clear any stale file from a previous failed attempt.
    if file_path.exists() {
        let _ = fs::remove_file(&file_path);
    }

    // DuckDB accepts native paths in bind parameters on Windows (backslashes are
    // literal in bind values).
    let path_str = src.to_string_lossy().into_owned();

    let snapshot = {
        let conn = Connection::open(&file_path).map_err(io_err)?;
        conn.execute(
            "CREATE TABLE data AS SELECT * FROM read_csv_auto(?)",
            params![path_str],
        )
        .map_err(parse_err)?;
        Snapshot::from_connection(&conn, file_path.clone(), temp_dir)?
    }; // conn dropped -> file closed before the session re-attaches it

    Ok(snapshot)
}

fn io_err(e: duckdb::Error) -> LoadError {
    LoadError::Io {
        detail: e.to_string(),
    }
}
fn parse_err(e: duckdb::Error) -> LoadError {
    LoadError::Parse {
        detail: e.to_string(),
    }
}
