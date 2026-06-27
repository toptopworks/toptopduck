//! Frozen snapshot descriptor derivation (ADR-0012/0026/0032/0042). Given a
//! connection whose `data` table holds a freshly copy-in'd source, derive the
//! canonical schema, row count, frozen first-3-row sample, and content
//! fingerprint. Format-agnostic: every source snapshot has a `data` table.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use duckdb::Connection;
use sha2::{Digest, Sha256};

use crate::ingest::schema::{canonical_type, quote_ident, render_cell};
use crate::model::{ColumnSchema, LoadError};

/// Number of sample rows frozen at copy-in (ADR-0026 contract value).
const SAMPLE_ROW_COUNT: i64 = 3;

pub struct Snapshot {
    pub file_path: PathBuf,
    pub columns: Vec<ColumnSchema>,
    pub row_count: u64,
    pub sample: Vec<Vec<String>>,
    pub fingerprint: String,
}

impl Snapshot {
    /// Derive the descriptor pieces from a `data` table on `conn`. `work_dir` is
    /// used for the transient fingerprint dump (removed after hashing).
    pub fn from_connection(
        conn: &Connection,
        file_path: PathBuf,
        work_dir: &Path,
    ) -> Result<Self, LoadError> {
        let columns = describe_columns(conn)?;
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM data", [], |r| r.get(0))
            .map_err(parse_err)?;
        let sample = read_sample(conn, &columns)?;
        let stem = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("snap");
        let fingerprint = fingerprint_via_copy(conn, work_dir, stem)?;
        Ok(Self {
            file_path,
            columns,
            row_count: row_count.max(0) as u64,
            sample,
            fingerprint,
        })
    }
}

fn describe_columns(conn: &Connection) -> Result<Vec<ColumnSchema>, LoadError> {
    let mut stmt = conn.prepare("DESCRIBE data").map_err(parse_err)?;
    let mut rows = stmt.query([]).map_err(parse_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(parse_err)? {
        // DESCRIBE columns: column_name(0), column_type(1), null(2), key(3), ...
        let name: String = row.get(0).map_err(parse_err)?;
        let raw_type: String = row.get(1).map_err(parse_err)?;
        out.push(ColumnSchema {
            name,
            canonical_type: canonical_type(&raw_type),
        });
    }
    Ok(out)
}

fn read_sample(conn: &Connection, columns: &[ColumnSchema]) -> Result<Vec<Vec<String>>, LoadError> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    // CAST every column to VARCHAR so cells are uniform strings regardless of type.
    let selects: Vec<String> = columns
        .iter()
        .map(|c| format!("CAST({} AS VARCHAR)", quote_ident(&c.name)))
        .collect();
    let sql = format!(
        "SELECT {} FROM data LIMIT {SAMPLE_ROW_COUNT}",
        selects.join(", ")
    );
    let mut stmt = conn.prepare(&sql).map_err(parse_err)?;
    let mut rows = stmt.query([]).map_err(parse_err)?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(parse_err)? {
        let mut cells = Vec::with_capacity(columns.len());
        for i in 0..columns.len() {
            let v: Option<String> = row.get(i).map_err(parse_err)?;
            cells.push(render_cell(v.as_deref()));
        }
        out.push(cells);
    }
    Ok(out)
}

fn fingerprint_via_copy(
    conn: &Connection,
    work_dir: &Path,
    stem: &str,
) -> Result<String, LoadError> {
    // Hash the snapshot's canonical CSV dump (HEADER + values reflect types);
    // ADR-0042: fingerprint = post-copy-in snapshot content. Deterministic for
    // identical copy-in output.
    //
    // `dump_path` is tool-controlled (per-session temp dir + sanitized snapshot
    // stem), never user input, so string interpolation is safe; the user-supplied
    // source path is bound as a parameter during copy-in (see ingest::loader).
    let dump = work_dir.join(format!("{stem}.fingerprint.csv"));
    let dump_path = dump.to_string_lossy();
    conn.execute_batch(&format!(
        "COPY (SELECT * FROM data) TO '{dump_path}' (HEADER, DELIMITER ',')"
    ))
    .map_err(parse_err)?;

    let mut hasher = Sha256::new();
    let mut file = fs::File::open(&dump).map_err(io_err_std)?;
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(io_err_std)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let fingerprint: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    let _ = fs::remove_file(&dump);
    Ok(fingerprint)
}

fn parse_err(e: duckdb::Error) -> LoadError {
    LoadError::Parse {
        detail: e.to_string(),
    }
}
fn io_err_std(e: std::io::Error) -> LoadError {
    LoadError::Io {
        detail: e.to_string(),
    }
}
