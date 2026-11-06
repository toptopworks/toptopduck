//! Frozen snapshot descriptor derivation (ADR-0012/0026/0032, recast by issue
//! #1507): given a connection whose some table holds freshly loaded rows,
//! derive the canonical schema, row count, and frozen first-3-row sample --
//! the SHAPE only. The content fingerprint is deliberately NOT derived here:
//! identity is external to the shape. Source copy-in backfills the v2 source
//! hash (what copy-in reads, see `ingest::loader`), the shared store
//! backfills its content key (issue #1506), and a materialized result_N
//! carries no fingerprint at all (its identity is the reference name --
//! zero comparison and zero display consumers). The pre-#1507 full-table
//! export + hash pass is retired.

use std::fs;
use std::path::{Path, PathBuf};

use duckdb::Connection;

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
/// and frozen first-3-row sample. The storage-agnostic core of Snapshot (which
/// adds the on-disk file path for source snapshots) and of a materialized turn
/// result (which has no file -- it lives in the session DB, ADR-0024).
/// Extracted so both paths share one derivation.
pub struct TableShape {
    pub columns: Vec<ColumnSchema>,
    pub row_count: u64,
    pub sample: Vec<Vec<String>>,
    /// Always empty from the derivation: identity is external to the shape
    /// and the caller backfills it (the private copy-in face's v2 source
    /// hash, the shared store's content key) or leaves it empty (a
    /// materialized result_N, whose identity is its reference name) -- never
    /// persist or compare an empty fingerprint as if it were identity.
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

    /// Derive a source snapshot's descriptor's shape facts from its data
    /// table on conn. No content fingerprint pass (no CSV dump, no
    /// full-table scan, no work dir) -- identity is external to the shape:
    /// the caller backfills the v2 source hash (private copy-in) or the
    /// store key (shared face, issue #1506).
    pub fn from_connection(conn: &Connection, file_path: PathBuf) -> Result<Self, LoadError> {
        let shape = derive_shape(conn, "data")?;
        Ok(Self::from_shape(file_path, shape))
    }
}

/// Derive the shape of table on conn: canonical schema, row count, frozen
/// first-3-row sample -- NO content fingerprint (`fingerprint` stays empty
/// for the caller to backfill or leave empty, see [`TableShape::fingerprint`]).
/// Used for both source snapshots (data) and materialized turn results
/// (result_N) -- the only caller-controlled value is the table identifier,
/// which is tool-generated and passed through quote_ident, so the
/// interpolation is safe.
pub fn derive_shape(conn: &Connection, table: &str) -> Result<TableShape, LoadError> {
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

fn parse_err(e: duckdb::Error) -> LoadError {
    LoadError::Parse {
        detail: e.to_string(),
    }
}
