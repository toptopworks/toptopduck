//! Structured copy-in loader (PRD #2): copy a source into a frozen DuckDB
//! snapshot file (ADR-0004/0012) via DuckDB's native reader, then derive its
//! descriptor. Format-agnostic -- CSV/Parquet/JSON share this single path; only
//! the reader function differs, so the schema/sample contract has no
//! format-specific branches (ADR-0032 single source of truth).

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use duckdb::{params, Connection};

use crate::model::LoadError;
use crate::session::snapshot::Snapshot;

/// Copy-in `src` into a per-session temp DuckDB file `<alias>.duckdb` using the
/// given DuckDB reader function (`read_csv_auto` / `read_parquet` /
/// `read_json_auto`) and derive the snapshot descriptor. The file is later
/// attached READ_ONLY by the session.
///
/// `reader_fn` is a static literal chosen by [`super::reader_for`], never user
/// input, so interpolating it into the SQL is safe; the user-supplied source
/// path is bound as a parameter during copy-in.
pub fn copy_in(
    src: &Path,
    temp_dir: &Path,
    alias: &str,
    reader_fn: &str,
) -> Result<Snapshot, LoadError> {
    // The caller may hand us the tree snapshot directory that does not exist
    // yet (first ingest into a fresh session tree, ADR-0136 D1) -- create it
    // so Connection::open below can land the file. Idempotent for the temp
    // faces, which already exist.
    let _ = fs::create_dir_all(temp_dir);
    let file_path: PathBuf = temp_dir.join(format!("{alias}.duckdb"));
    // Clear any stale file from a previous failed attempt.
    if file_path.exists() {
        let _ = fs::remove_file(&file_path);
    }

    // DuckDB accepts native paths in bind parameters on Windows (backslashes are
    // literal in bind values).
    let path_str = src.to_string_lossy().into_owned();

    // Build inside an immediately-invoked closure so any failure (open / CREATE
    // TABLE / descriptor derivation) flows to `result` instead of early-returning
    // past the cleanup below. `Connection::open` has already created
    // `<alias>.duckdb` on disk by then, so a failure must remove the partial
    // file -- the excel path calls this once per sheet, and without this a
    // mid-workbook failure could orphan several snapshots until the session temp
    // dir is torn down.
    let result = (|| -> Result<Snapshot, LoadError> {
        let conn = Connection::open(&file_path).map_err(io_err)?;
        // The encoding value is a static literal, never user input, so the
        // interpolation stays safe (same contract as `reader_fn` above).
        let build = |encoding: Option<&str>| -> Result<(), duckdb::Error> {
            let sql = match encoding {
                Some(enc) => {
                    format!("CREATE TABLE data AS SELECT * FROM {reader_fn}(?, encoding='{enc}')")
                }
                None => format!("CREATE TABLE data AS SELECT * FROM {reader_fn}(?)"),
            };
            conn.execute(&sql, params![path_str]).map(|_| ())
        };
        // One pinned-encoding retry for the sniffer's UTF-16 blind spot;
        // anything else fails straight through.
        build(None)
            .or_else(|e| {
                if reader_fn == "read_csv_auto" && has_utf16_bom(&path_str) {
                    build(Some("utf-16"))
                } else {
                    Err(e)
                }
            })
            .map_err(parse_err)?;
        Snapshot::from_connection(&conn, file_path.clone(), temp_dir)
    })(); // conn dropped -> file closed before the session re-attaches it

    match result {
        Ok(snapshot) => Ok(snapshot),
        Err(e) => {
            let _ = fs::remove_file(&file_path);
            Err(e)
        }
    }
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

/// Whether the file carries a UTF-16 BOM (`FF FE` LE / `FE FF` BE). The
/// CSV sniffer only tries utf-8, so a UTF-16 export (the Excel "Unicode
/// Text" save) feeds NUL bytes into every candidate and fails the dialect
/// search outright even though the table itself is fine -- the BOM is a
/// cheap, unambiguous signal to retry with the encoding pinned.
fn has_utf16_bom(path: &str) -> bool {
    let mut head = [0u8; 2];
    fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map(|_| head == [0xFF, 0xFE] || head == [0xFE, 0xFF])
        .unwrap_or(false)
}
