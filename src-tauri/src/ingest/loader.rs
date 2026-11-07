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

/// Version prefix of the source-hash fingerprint (issue #1507). Recipes
/// recorded before the migration carry a bare post-load hash; the prefix is
/// what resume's algorithm-upgrade branch keys on (and a future fingerprint
/// algorithm bumps it to `v3:`).
pub(crate) const FINGERPRINT_V2_PREFIX: &str = "v2:";

/// The v2 source fingerprint: `v2:` + the streaming SHA256 of the file
/// copy-in actually reads + the reader fn spelling.
///
/// Content-equivalent to the post-load table hash it replaced (issue #1507):
/// the `read_*` builders are deterministic, so the source bytes uniquely
/// determine the built table -- and the fn-name spelling alone pins the
/// parse, because the pinned UTF-16 retry leg is a pure function of the
/// source bytes (a file either triggers the retry on every read or on none).
/// Excel sheets hash their own materialized temp CSVs (what their copy-in
/// reads), so per-sheet identity and rectify sensitivity come for free.
fn source_fingerprint(src: &Path, reader_fn: &str) -> Result<String, LoadError> {
    let digest = crate::util::sha256_file(src).map_err(|e| LoadError::Io {
        detail: e.to_string(),
    })?;
    Ok(format!("{FINGERPRINT_V2_PREFIX}{digest}:{reader_fn}"))
}

/// Copy-in `src` into a per-session temp DuckDB file `<alias>.duckdb` using the
/// given DuckDB reader function (`read_csv_auto` / `read_parquet` /
/// `read_json_auto`) and derive the snapshot descriptor. The descriptor's
/// fingerprint is the v2 source hash (issue #1507; see
/// [`source_fingerprint`]). The file is later attached READ_ONLY by the
/// session.
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
    copy_in_impl(src, temp_dir, alias, reader_fn, true)
}

/// The shape-only face of [`copy_in`] for the shared store (issue #1506):
/// identical build and shape derivation EXCEPT no content fingerprint pass
/// -- the store's identity is its content key, so the returned snapshot's
/// `fingerprint` is empty and the store layer backfills the key.
pub fn copy_in_shape(
    src: &Path,
    temp_dir: &Path,
    alias: &str,
    reader_fn: &str,
) -> Result<Snapshot, LoadError> {
    copy_in_impl(src, temp_dir, alias, reader_fn, false)
}

fn copy_in_impl(
    src: &Path,
    temp_dir: &Path,
    alias: &str,
    reader_fn: &str,
    derive_fingerprint: bool,
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
        let attempt = conn.execute(
            &format!("CREATE TABLE data AS SELECT * FROM {reader_fn}(?)"),
            params![path_str],
        );
        // One pinned-encoding retry for the sniffer's UTF-16 blind spot;
        // anything else fails straight through. The encoding value is a
        // static literal, never user input, so the interpolation stays safe
        // (same contract as `reader_fn` above).
        let attempt = match attempt {
            Err(_) if reader_fn == "read_csv_auto" && is_utf16_le(&path_str) => conn.execute(
                &format!("CREATE TABLE data AS SELECT * FROM {reader_fn}(?, encoding='utf-16')"),
                params![path_str],
            ),
            other => other,
        };
        attempt.map_err(parse_err)?;
        let mut snapshot = Snapshot::from_connection(&conn, file_path.clone())?;
        if derive_fingerprint {
            // The private face's identity (issue #1507): the v2 source hash
            // backfills the shape-only derivation. The shared face
            // (`copy_in_shape`) leaves it empty for the store-key backfill
            // (issue #1506).
            snapshot.fingerprint = source_fingerprint(src, reader_fn)?;
        }
        Ok(snapshot)
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

/// Whether the file is a plausible UTF-16 LE document: an `FF FE` BOM and
/// an even total length (a valid UTF-16 file with a BOM is always 2+2n
/// bytes). The CSV sniffer only tries utf-8, so a UTF-16 export (the Excel
/// "Unicode Text" save) feeds NUL bytes into every candidate and fails the
/// dialect search outright even though the table itself is fine. A `FE FF`
/// (BE) BOM is deliberately not recognized: the engine's utf-16 decoding
/// is little-endian only, so a BE file would transcode to mojibake and
/// import as garbage instead of refusing. The even-length gate keeps
/// odd-tailed garbage in the refuse posture for the same reason -- the
/// decoder is permissive enough to land it as a mojibake table.
fn is_utf16_le(path: &str) -> bool {
    let mut head = [0u8; 2];
    fs::File::open(path)
        .and_then(|mut f| {
            f.read_exact(&mut head)?;
            f.metadata()
        })
        .map(|meta| head == [0xFF, 0xFE] && meta.len() % 2 == 0)
        .unwrap_or(false)
}
