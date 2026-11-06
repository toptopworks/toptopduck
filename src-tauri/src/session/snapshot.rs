//! Frozen snapshot descriptor derivation (ADR-0012/0026/0032/0042). Given a
//! connection whose some table holds freshly loaded rows, derive the canonical
//! schema, row count, frozen first-3-row sample, and content fingerprint.
//! Shared by source copy-in (the data table on an attached read-only snapshot)
//! and turn-result materialization (a result_N physical table, ADR-0024) -- the
//! derivation is table-shape-agnostic, so DRY holds across both paths.
//! The shape-only face (`derive_shape` / `Snapshot::from_connection_shape`)
//! skips the fingerprint for surfaces whose identity is already known by
//! other means (the shared store's content key, issue #1506).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use duckdb::Connection;
use sha2::{Digest, Sha256};

use crate::ingest::schema::{canonical_type, quote_ident, render_cell};
use crate::model::{ColumnSchema, LoadError};

/// Number of sample rows frozen at load (ADR-0026 contract value).
const SAMPLE_ROW_COUNT: i64 = 3;

pub struct Snapshot {
    pub file_path: PathBuf,
    pub columns: Vec<ColumnSchema>,
    pub row_count: u64,
    pub sample: Vec<Vec<String>>,
    pub fingerprint: String,
}

/// The snapshot file's byte size (issue #1485): the data body's on-disk size.
/// MUST be called only after the writing connection is dropped -- DuckDB
/// flushes the main file on close, so a mid-open stat reads a partial figure.
/// A 0 here means the stat failed -- the UI hides the size line rather than
/// showing a fake figure.
pub fn snapshot_len(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// The derived shape of a table on a connection: canonical schema, row count,
/// frozen first-3-row sample, and content fingerprint. The storage-agnostic
/// core of Snapshot (which adds the on-disk file path for source snapshots) and
/// of a materialized turn result (which has no file -- it lives in the session
/// DB, ADR-0024). Extracted so both paths share one derivation.
pub struct TableShape {
    pub columns: Vec<ColumnSchema>,
    pub row_count: u64,
    pub sample: Vec<Vec<String>>,
    /// Empty on the shape-only face (`derive_shape`): identity is external
    /// there and the caller backfills it (issue #1506) -- never persist or
    /// compare an empty fingerprint.
    pub fingerprint: String,
}

impl Snapshot {
    fn from_shape(file_path: PathBuf, shape: TableShape) -> Self {
        Self {
            file_path,
            columns: shape.columns,
            row_count: shape.row_count,
            sample: shape.sample,
            fingerprint: shape.fingerprint,
        }
    }

    /// Derive a source snapshot's descriptor from its data table on conn.
    /// work_dir holds the transient fingerprint dump (removed after hashing).
    pub fn from_connection(
        conn: &Connection,
        file_path: PathBuf,
        work_dir: &Path,
    ) -> Result<Self, LoadError> {
        let stem = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("snap");
        let shape = derive_table(conn, "data", work_dir, stem)?;
        Ok(Self::from_shape(file_path, shape))
    }

    /// The shape-only face of [`Self::from_connection`]: derive the
    /// descriptor's shape facts without the content fingerprint pass -- no
    /// CSV dump, no full-table scan, no work dir. For surfaces whose
    /// identity is external (the shared store's content key IS its file
    /// name); `fingerprint` stays empty and the caller backfills the real
    /// identity (issue #1506).
    pub fn from_connection_shape(conn: &Connection, file_path: PathBuf) -> Result<Self, LoadError> {
        let shape = derive_shape(conn, "data")?;
        Ok(Self::from_shape(file_path, shape))
    }
}

/// Derive the shape of table on conn: canonical schema, row count, frozen
/// first-3-row sample, and SHA256 content fingerprint. Used for both source
/// snapshots (data) and materialized turn results (result_N) -- the only
/// caller-controlled value is the table identifier, which is tool-generated and
/// passed through quote_ident, so the interpolation is safe.
pub fn derive_table(
    conn: &Connection,
    table: &str,
    work_dir: &Path,
    dump_stem: &str,
) -> Result<TableShape, LoadError> {
    let shape = derive_shape(conn, table)?;
    let fingerprint = fingerprint_table(conn, work_dir, dump_stem, table)?;
    Ok(TableShape {
        fingerprint,
        ..shape
    })
}

/// The shape-only core of [`derive_table`]: canonical schema, row count,
/// frozen first-3-row sample, and NO content fingerprint (no CSV dump, no
/// full-table scan). For surfaces whose identity is already known by other
/// means -- the shared store, whose key IS its file name (issue #1506);
/// `fingerprint` stays empty for the caller to backfill.
fn derive_shape(conn: &Connection, table: &str) -> Result<TableShape, LoadError> {
    let columns = describe_table(conn, table)?;
    let row_count = count_rows(conn, table)?;
    let sample = read_table_sample(conn, &columns, table)?;
    Ok(TableShape {
        columns,
        row_count,
        sample,
        fingerprint: String::new(),
    })
}

fn describe_table(conn: &Connection, table: &str) -> Result<Vec<ColumnSchema>, LoadError> {
    let mut stmt = conn
        .prepare(&format!("DESCRIBE {}", quote_ident(table)))
        .map_err(parse_err)?;
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

fn count_rows(conn: &Connection, table: &str) -> Result<u64, LoadError> {
    let count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", quote_ident(table)),
            [],
            |r| r.get(0),
        )
        .map_err(parse_err)?;
    Ok(count.max(0) as u64)
}

fn read_table_sample(
    conn: &Connection,
    columns: &[ColumnSchema],
    table: &str,
) -> Result<Vec<Vec<String>>, LoadError> {
    if columns.is_empty() {
        return Ok(Vec::new());
    }
    // CAST every column to VARCHAR so cells are uniform strings regardless of type.
    let selects: Vec<String> = columns
        .iter()
        .map(|c| format!("CAST({} AS VARCHAR)", quote_ident(&c.name)))
        .collect();
    let sql = format!(
        "SELECT {} FROM {} LIMIT {SAMPLE_ROW_COUNT}",
        selects.join(", "),
        quote_ident(table)
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

fn fingerprint_table(
    conn: &Connection,
    work_dir: &Path,
    stem: &str,
    table: &str,
) -> Result<String, LoadError> {
    // Hash the table's canonical CSV dump (HEADER + values reflect types);
    // ADR-0042: fingerprint = post-load content. Deterministic for identical
    // content. dump_path is tool-controlled (per-session temp dir + sanitized
    // stem), never user input, so string interpolation is safe; the table
    // identifier is tool-generated and quoted.
    let dump = work_dir.join(format!("{stem}.fingerprint.csv"));
    let dump_path = dump.to_string_lossy();
    conn.execute_batch(&format!(
        "COPY (SELECT * FROM {}) TO '{dump_path}' (HEADER, DELIMITER ',')",
        quote_ident(table)
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
