//! Excel .xlsx reading (slice 3a, issue #7). calamine reads each sheet's cell
//! cached values -- formula cells resolve to their cached result, never
//! recomputed (ADR-0015) -- and this module writes one temp CSV per sheet so the
//! shared copy-in path (`read_csv_auto`) can freeze it into a snapshot. DuckDB
//! therefore stays the single type-inference source of truth (ADR-0032): the
//! only format-specific step is the bytes -> CSV materialization here.
//!
//! The DuckDB `excel` *loadable extension* is deliberately bypassed: duckdb-rs's
//! vendored amalgamation cannot statically link it (the manifest ships only
//! core_functions/json/parquet), and pre-bundling a platform-specific extension
//! binary is heavy for this slice. calamine is compiled in, so loading is fully
//! offline with no runtime download (ADR-0014 spirit; see ADR-0043).

use std::fs;
use std::path::{Path, PathBuf};

use calamine::{open_workbook, Data, Reader, Xlsx, XlsxError};

use crate::model::LoadError;

/// One sheet's worth of rows read from a workbook: the sheet name plus its cell
/// grid (each row a vector of cached-value cells).
pub struct SheetRows {
    pub name: String,
    pub rows: Vec<Vec<Data>>,
}

/// Open a .xlsx and read every sheet's cells as cached values, in workbook
/// order. The caller maps each sheet to one Dataset. Any open/read failure
/// (corrupt archive, malformed XML) -> `LoadError::Parse`, leaving the working
/// set untouched (PRD AC6/AC7).
pub fn read_sheets(path: &Path) -> Result<Vec<SheetRows>, LoadError> {
    let mut book: Xlsx<_> = open_workbook(path).map_err(parse_err)?;
    let names = book.sheet_names().to_vec();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        // worksheet_range yields cached cell values (worksheet_formula is the
        // separate path that returns formula *text* -- not used here).
        let range = book.worksheet_range(&name).map_err(parse_err)?;
        let rows: Vec<Vec<Data>> = range.rows().map(|r| r.to_vec()).collect();
        out.push(SheetRows { name, rows });
    }
    Ok(out)
}

/// Materialize one sheet's cached values to a temp CSV at
/// `<dir>/<alias>.xlsx.csv` (header = the sheet's first row, matching DuckDB's
/// default CSV header detection). Returns the path for copy-in. Correct CSV
/// escaping (commas/quotes/newlines in cells) is delegated to the `csv` crate.
pub fn write_sheet_csv(sheet: &SheetRows, dir: &Path, alias: &str) -> Result<PathBuf, LoadError> {
    let path = dir.join(format!("{alias}.xlsx.csv"));
    let file = fs::File::create(&path).map_err(io_err)?;
    let mut wtr = csv::Writer::from_writer(file);
    for row in &sheet.rows {
        let record: Vec<String> = row.iter().map(cell_to_string).collect();
        wtr.write_record(&record).map_err(io_err)?;
    }
    wtr.flush().map_err(io_err)?;
    Ok(path)
}

/// Render a cached cell value to its CSV string form. SQL NULL (calamine Empty)
/// renders as the empty string, matching the frozen-sample contract
/// (`schema::render_cell`, ADR-0026). Int/Float both render via their numeric
/// text so DuckDB re-infers the canonical type from the column (ADR-0032).
fn cell_to_string(cell: &Data) -> String {
    match cell {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => f.to_string(),
        Data::Bool(b) => b.to_string(),
        // Excel dates are serial numbers; render via the ISO datetime calamine
        // decodes (dates feature). Falls back to the raw serial if undecodable.
        Data::DateTime(d) => d
            .as_datetime()
            .map(|dt| dt.to_string())
            .unwrap_or_else(|| d.as_f64().to_string()),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Error(e) => e.to_string(),
    }
}

fn parse_err(e: XlsxError) -> LoadError {
    LoadError::Parse {
        detail: e.to_string(),
    }
}

fn io_err<E: std::error::Error>(e: E) -> LoadError {
    LoadError::Io {
        detail: e.to_string(),
    }
}
