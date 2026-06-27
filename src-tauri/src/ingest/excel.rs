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

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use calamine::{open_workbook, Data, Dimensions, Reader, SheetVisible, Xlsx, XlsxError};

use crate::model::LoadError;

/// One sheet's worth of rows read from a workbook: the sheet name plus its cell
/// grid (each row a vector of cached-value cells).
pub struct SheetRows {
    pub name: String,
    pub rows: Vec<Vec<Data>>,
    /// Merged-cell ranges (calamine `Dimensions`, 0-based `(row, col)` start
    /// ..= end). Auto-tidy forward-fills each range's top-left value across the
    /// rest of the range, so merged cells unmerge without touching genuine
    /// NULLs (ADR-0015). Empty when the sheet has no merged cells.
    pub merges: Vec<Dimensions>,
}

/// Open a .xlsx and read every **visible** sheet's cells as cached values, in
/// workbook order. The caller maps each sheet to one Dataset. Hidden / veryHidden
/// sheets (Excel `ST_SheetState`) are skipped -- the user hid them in Excel, so
/// they aren't part of the data the user wants to analyze. Any open/read failure
/// (corrupt archive, malformed XML) -> `LoadError::Parse`, leaving the working
/// set untouched (PRD AC6/AC7).
pub fn read_sheets(path: &Path) -> Result<Vec<SheetRows>, LoadError> {
    let mut book: Xlsx<_> = open_workbook(path).map_err(parse_err)?;
    // Collect hidden sheet names up front as owned Strings, so the `&self`
    // borrow from `sheets_metadata` ends before the `&mut self` worksheet_range
    // calls below.
    let hidden: HashSet<String> = book
        .sheets_metadata()
        .iter()
        .filter(|s| !matches!(s.visible, SheetVisible::Visible))
        .map(|s| s.name.clone())
        .collect();
    let names = book.sheet_names().to_vec();
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        if hidden.contains(&name) {
            continue;
        }
        // worksheet_range yields cached cell values (worksheet_formula is the
        // separate path that returns formula *text* -- not used here).
        let range = book.worksheet_range(&name).map_err(parse_err)?;
        let rows: Vec<Vec<Data>> = range.rows().map(|r| r.to_vec()).collect();
        // worksheet_merge_cells re-reads the sheet XML for its <mergeCells>
        // block; a sheet with no merges yields None, an unreadable block is
        // tolerated (empty merges) rather than failing the whole load -- a
        // sheet without merge info still tidies, just without forward-fill.
        let merges = book
            .worksheet_merge_cells(&name)
            .and_then(Result::ok)
            .unwrap_or_default();
        out.push(SheetRows { name, rows, merges });
    }
    Ok(out)
}

/// Materialize one sheet's cached values to a temp CSV at
/// `<dir>/<alias>.xlsx.csv` (header = the sheet's first row, matching DuckDB's
/// default CSV header detection). Returns the path for copy-in. Correct CSV
/// escaping (commas/quotes/newlines in cells) is delegated to the `csv` crate.
/// On any write failure the partial file is removed so a bad sheet never leaves
/// a transient CSV behind -- the caller's rollback only touches snapshots.
pub fn write_sheet_csv(
    rows: &[Vec<Data>],
    sheet_name: &str,
    dir: &Path,
    alias: &str,
) -> Result<PathBuf, LoadError> {
    let path = dir.join(format!("{alias}.xlsx.csv"));
    if let Err(e) = write_rows(rows, sheet_name, &path) {
        let _ = fs::remove_file(&path);
        return Err(e);
    }
    Ok(path)
}

/// Render the top `n` raw rows of a sheet as strings, for the guided-load
/// preview (pre-rectify -- merged cells appear as Excel shows them). The user
/// locates the header row and marks skips from this preview before re-ingesting
/// via the guided path.
pub fn render_preview(sheet: &SheetRows, n: usize) -> Vec<Vec<String>> {
    sheet
        .rows
        .iter()
        .take(n)
        .map(|r| r.iter().map(cell_to_string).collect())
        .collect()
}

/// Write every row to `path`. While iterating we tally cells whose rendered
/// form would silently distort DuckDB's type inference (ADR-0032 single source
/// of truth): Excel error cells render as `#REF!`-style text and undecodable
/// dates fall back to the raw serial number -- either can flip a whole column's
/// inferred type (e.g. numeric -> VARCHAR) with no signal to the user. We log
/// each kind once per sheet so the degradation is observable, not silent.
fn write_rows(rows: &[Vec<Data>], sheet_name: &str, path: &Path) -> Result<(), LoadError> {
    let file = fs::File::create(path).map_err(io_err)?;
    let mut wtr = csv::Writer::from_writer(file);
    let mut error_cells = 0usize;
    let mut serial_dates = 0usize;
    for row in rows {
        let record: Vec<String> = row
            .iter()
            .map(|c| {
                track_degradation(c, &mut error_cells, &mut serial_dates);
                cell_to_string(c)
            })
            .collect();
        wtr.write_record(&record).map_err(io_err)?;
    }
    wtr.flush().map_err(io_err)?;
    if error_cells > 0 {
        log::warn!(
            target: "toptopduck::ingest::excel",
            "sheet \"{sheet_name}\": {error_cells} Excel error cell(s) rendered as text; columns may infer VARCHAR not numeric",
        );
    }
    if serial_dates > 0 {
        log::warn!(
            target: "toptopduck::ingest::excel",
            "sheet \"{sheet_name}\": {serial_dates} undecodable date cell(s) fell back to serial number; date columns may infer numeric not TIMESTAMP",
        );
    }
    Ok(())
}

/// Tally cells whose rendered CSV form diverges from their logical kind, so
/// [`write_rows`] can warn once per sheet rather than once per cell. Only
/// `Data::Error` and `Data::DateTime` whose `as_datetime()` returns `None`
/// degrade; every other kind renders faithfully.
fn track_degradation(cell: &Data, errors: &mut usize, serial_dates: &mut usize) {
    match cell {
        Data::Error(_) => *errors += 1,
        Data::DateTime(d) if d.as_datetime().is_none() => *serial_dates += 1,
        _ => {}
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::{CellErrorType, ExcelDateTime, ExcelDateTimeType};

    #[test]
    fn cell_to_string_renders_each_kind() {
        assert_eq!(cell_to_string(&Data::Empty), "");
        assert_eq!(cell_to_string(&Data::Int(42)), "42");
        assert_eq!(cell_to_string(&Data::Int(-7)), "-7");
        assert_eq!(cell_to_string(&Data::Float(3.5)), "3.5");
        assert_eq!(cell_to_string(&Data::Float(0.0)), "0");
        assert_eq!(cell_to_string(&Data::Bool(true)), "true");
        assert_eq!(cell_to_string(&Data::Bool(false)), "false");
        assert_eq!(cell_to_string(&Data::String("hello".into())), "hello");
        assert_eq!(
            cell_to_string(&Data::DateTimeIso("2023-01-01T00:00:00".into())),
            "2023-01-01T00:00:00"
        );
        assert_eq!(cell_to_string(&Data::DurationIso("PT30M".into())), "PT30M");
    }

    #[test]
    fn cell_to_string_renders_error_as_hash_marker() {
        // Error cells render as their Excel marker (#REF!, #DIV/0!, ...); a
        // single such cell in a numeric column is exactly what flips it to
        // VARCHAR downstream -- assert the marker shape, not calamine's exact
        // spelling, to stay robust to display changes.
        let rendered = cell_to_string(&Data::Error(CellErrorType::Div0));
        assert!(
            rendered.starts_with('#'),
            "error marker should start with '#', got {rendered}"
        );
    }

    #[test]
    fn cell_to_string_renders_decodable_date_as_iso() {
        // 44197.0 = 2021-01-01 in the Excel 1900 serial calendar; a decodable
        // date renders via its NaiveDateTime (ISO), never the raw serial.
        let d = Data::DateTime(ExcelDateTime::new(
            44197.0,
            ExcelDateTimeType::DateTime,
            false,
        ));
        let rendered = cell_to_string(&d);
        assert!(
            rendered.starts_with("2021-01-01"),
            "expected ISO datetime, got {rendered}"
        );
    }

    #[test]
    fn track_degradation_counts_only_degrading_kinds() {
        let mut errors = 0;
        let mut serial_dates = 0;
        // Normal kinds never tally.
        track_degradation(&Data::Empty, &mut errors, &mut serial_dates);
        track_degradation(&Data::Int(1), &mut errors, &mut serial_dates);
        track_degradation(&Data::Float(2.0), &mut errors, &mut serial_dates);
        track_degradation(&Data::String("x".into()), &mut errors, &mut serial_dates);
        track_degradation(&Data::Bool(true), &mut errors, &mut serial_dates);
        // A decodable DateTime is NOT a serial-date fallback.
        track_degradation(
            &Data::DateTime(ExcelDateTime::new(
                44197.0,
                ExcelDateTimeType::DateTime,
                false,
            )),
            &mut errors,
            &mut serial_dates,
        );
        assert_eq!((errors, serial_dates), (0, 0));
        // Only error cells tally here (as_datetime rarely returns None, so the
        // serial-date branch is defensive -- its undecodable case can't be
        // constructed without calamine internals).
        track_degradation(
            &Data::Error(CellErrorType::Div0),
            &mut errors,
            &mut serial_dates,
        );
        track_degradation(
            &Data::Error(CellErrorType::Ref),
            &mut errors,
            &mut serial_dates,
        );
        assert_eq!((errors, serial_dates), (2, 0));
    }
}
