//! Result-set rows IO species (issue #1113): the read / export / copy leaf
//! face of the session domain. No other `session/` module calls these; the
//! production consumers are the `commands.rs` read / export commands, reached
//! through the one-line delegations on `Session` in `mod.rs`. Every function
//! here is a free function over the session's borrowed state
//! (`&WorkingSet`, `&AdminEngine`, `&CancelToken`) -- the same per-call
//! borrow shape as the materializer's `TurnDeps` seam (ADR-0053) -- so the
//! module's unit tests drive the seam on a `:memory:` engine plus a minimal
//! working set instead of a full scripted session (ADR-0053 Decision 6:
//! module-local tests, blackbox slimming). The e2e properties that need the
//! real session lock / threads / cross-session cancel state (the leftover
//! cancel / watchdog survives and the stopped-export-untouched guarantees)
//! stay in the blackbox suites.

use std::fs;

use crate::cancel::CancelToken;
use crate::ingest::schema::quote_ident;
use crate::model::{ColumnSchema, ExportIoStep, ExportRowsError, RowPage, RowReadError};
use crate::workingset::WorkingSet;

use super::engine::AdminEngine;

/// Upper bound on a single read_rows page (ADR-0005/0024 display cap). A larger
/// requested limit is clamped so a malformed/hostile caller can't pull the whole
/// table into memory; the physical table still holds the full result.
const MAX_READ_ROWS: u64 = 10_000;

/// The full-result confirm threshold (issue #779): a full pull (CSV export or
/// TSV copy) over this many rows is refused with `RowReadError::TooLarge`
/// unless the caller passes `confirmed`. Both full paths hold the session
/// lock for the whole scan (ADR-0021's single-flight gate) -- a
/// multi-million-row pull queues every other command on that session for its
/// duration -- and the TSV half materializes the whole payload, so a pull
/// this large must be a deliberate act, not an accidental click. Sits beside
/// MAX_READ_ROWS on purpose: both bound how much of a table one call may
/// pull, one for the display page, one for the full path.
const MAX_UNCONFIRMED_FULL_ROWS: u64 = 1_000_000;

/// The UTF-8 BOM written ahead of an exported CSV's first record (issue #769):
/// Excel-family spreadsheets autodetect UTF-8 by its presence -- without it a
/// CJK column name or value garbles on open.
const UTF8_BOM: &str = "\u{FEFF}";

pub(super) fn read_rows(
    working_set: &WorkingSet,
    engine: &AdminEngine,
    reference_name: &str,
    offset: u64,
    limit: u64,
) -> Result<RowPage, RowReadError> {
    // Clamp the page size to the display cap (ADR-0005/0024) so a malformed
    // or hostile caller can't pull the whole table into memory.
    let limit = limit.min(MAX_READ_ROWS);
    let (columns, body, total) = full_rows_sql(working_set, reference_name)?;
    let sql = format!("{body} LIMIT {limit} OFFSET {offset}");
    let mut out = Vec::new();
    scan_rows(engine, &sql, columns.len(), |cells| {
        out.push(cells);
        Ok(())
    })?;
    Ok(RowPage {
        columns,
        rows: out,
        total,
        offset,
        limit,
    })
}

/// The shared SELECT body of the paged read and the full-result export /
/// copy paths (issue #769): the working set's FROM fragment with every
/// column CAST to VARCHAR (NULL -> "") for uniform rendering, plus the
/// descriptor's full row count (the paged read's honest `total`). Paged
/// reads append LIMIT/OFFSET; the full paths run it unclamped and stream
/// the rows out instead of paging them. The identifiers and the FROM
/// fragment are tool-generated, so the interpolation is safe.
fn full_rows_sql(
    working_set: &WorkingSet,
    reference_name: &str,
) -> Result<(Vec<ColumnSchema>, String, u64), RowReadError> {
    let descriptor = working_set
        .get(reference_name)
        .ok_or_else(|| RowReadError::UnknownDataset(reference_name.to_string()))?;
    let from = working_set
        .sql_from(reference_name)
        .ok_or_else(|| RowReadError::UnknownDataset(reference_name.to_string()))?;
    let columns = descriptor.columns.clone();
    let selects: Vec<String> = columns
        .iter()
        .map(|c| format!("CAST({} AS VARCHAR)", quote_ident(&c.name)))
        .collect();
    Ok((
        columns,
        format!("SELECT {} FROM {}", selects.join(", "), from),
        descriptor.row_count,
    ))
}

/// Read one queried row as display cells: VARCHAR cells verbatim, NULL ->
/// "" -- the cell semantics shared by the paged read and the full-result
/// export / copy paths (lifted from read_rows, issue #769).
fn varchar_cells(row: &duckdb::Row<'_>, len: usize) -> Result<Vec<String>, RowReadError> {
    let mut cells = Vec::with_capacity(len);
    for i in 0..len {
        let v: Option<String> = row
            .get(i)
            .map_err(|e| RowReadError::Execute(e.to_string()))?;
        cells.push(v.unwrap_or_default());
    }
    Ok(cells)
}

/// Run a rows query and hand each row's display cells to `on_row`
/// (issue #769): the one data-access loop shared by the paged read and the
/// full-result export / copy paths -- acquire / prepare / query /
/// scan / cell-shaping live here exactly once, so the three paths share
/// one contract instead of three copies. `E` converts from
/// [`RowReadError`], keeping each caller's own error type.
fn scan_rows<E>(
    engine: &AdminEngine,
    sql: &str,
    ncols: usize,
    mut on_row: impl FnMut(Vec<String>) -> Result<(), E>,
) -> Result<(), E>
where
    E: From<RowReadError>,
{
    let conn = engine
        .acquire()
        .map_err(|e| RowReadError::Execute(e.to_string()))?;
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| RowReadError::Execute(e.to_string()))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| RowReadError::Execute(e.to_string()))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| RowReadError::Execute(e.to_string()))?
    {
        let cells = varchar_cells(row, ncols)?;
        on_row(cells)?;
    }
    Ok(())
}

/// Export every row of a dataset to `path` as UTF-8 CSV (issue #769): the
/// header row leads, then ALL rows -- the same data source and cell
/// semantics as [`read_rows`] but no `MAX_READ_ROWS` clamp and no
/// paging; rows stream through the csv writer's buffer instead of landing
/// in memory, and the frontend never stitches pages together. The file
/// opens with a UTF-8 BOM (see [`UTF8_BOM`]); fields are CSV-escaped by the
/// writer. Destination-file failures (create / write / flush) are
/// [`ExportRowsError::Io`]; everything else matches `read_rows` 1:1. Stale
/// results export too -- the rows are real and the payload carries no
/// status markers.
///
/// Full-path guardrails (issue #779): a result over
/// `MAX_UNCONFIRMED_FULL_ROWS` refuses with `RowReadError::TooLarge`
/// unless `confirmed` (the lock a full pull holds is O(all rows) long, so
/// a pull that large must be deliberate), and a cancel observed mid-scan
/// stops the export with `RowReadError::Cancelled` -- the session's
/// [`CancelToken`] fires without the session lock (ADR-0021's
/// outside-the-lock cancel path), so the export's own lock hold cannot
/// shield it from the cancel command. The pull's start retires the
/// token's generation (see [`start_full_pull`]), so a past stop or
/// a still-sleeping no-progress watchdog from the last turn never kills
/// the pull. A cancelled export leaves no artifact: the destination is a
/// temp sibling until success, and the failed-write cleanup below removes
/// it -- a pre-existing file at the user-chosen path stays untouched.
pub(super) fn export_rows_csv(
    cancel: &CancelToken,
    working_set: &WorkingSet,
    engine: &AdminEngine,
    reference_name: &str,
    path: &str,
    confirmed: bool,
) -> Result<(), ExportRowsError> {
    export_rows_csv_gated(
        cancel,
        working_set,
        engine,
        reference_name,
        path,
        confirmed,
        MAX_UNCONFIRMED_FULL_ROWS,
    )
}

/// The full-path size gate (issue #779): a result over `confirm_above`
/// rows refuses unless `confirmed`, quoting the real row count;
/// [`export_rows_csv`] delegates here with the production constant. The
/// threshold is a parameter (not the constant) so tests exercise the gate
/// with small fixtures -- the `read_line_bounded` `max` precedent.
pub(super) fn export_rows_csv_gated(
    cancel: &CancelToken,
    working_set: &WorkingSet,
    engine: &AdminEngine,
    reference_name: &str,
    path: &str,
    confirmed: bool,
    confirm_above: u64,
) -> Result<(), ExportRowsError> {
    let (columns, sql) = start_full_pull(
        cancel,
        working_set,
        reference_name,
        confirmed,
        confirm_above,
    )?;
    // Write to a temp sibling and rename on success (issue #779 review):
    // File::create truncates, so writing the chosen path directly would
    // destroy a pre-existing file the moment the export starts -- a
    // stopped or failed export must leave it exactly as it was. The
    // streaming half writes the BOM to the temp file and hands it to the
    // csv writer (which adds its own buffer and flushes through it at the
    // end). Create / Rename errors report the user-chosen path; the
    // streaming half's Write / Flush errors report the temp sibling (the
    // file the OS actually failed on).
    let temp_path = format!("{path}.part");
    let file =
        fs::File::create(&temp_path).map_err(|e| export_io(ExportIoStep::Create, path, e))?;
    let result = export_csv_stream(cancel, engine, file, &columns, &sql, &temp_path);
    match result {
        Ok(()) => {
            fs::rename(&temp_path, path).map_err(|e| export_io(ExportIoStep::Rename, path, e))
        }
        Err(e) => {
            // The failed write must not leave the half-written artifact
            // behind -- a truncated CSV opens as a valid-looking export.
            // Best-effort removal of the temp sibling; the error itself
            // still crosses IPC and the user-chosen path is untouched.
            let _ = fs::remove_file(&temp_path);
            Err(e)
        }
    }
}

/// The post-create half of [`export_rows_csv`] (issue #769): BOM,
/// header, and every row streamed through the csv writer's buffer. Split
/// out so the caller can remove the truncated destination when this
/// fails.
fn export_csv_stream(
    cancel: &CancelToken,
    engine: &AdminEngine,
    mut file: fs::File,
    columns: &[ColumnSchema],
    sql: &str,
    path: &str,
) -> Result<(), ExportRowsError> {
    use std::io::Write as _;

    file.write_all(UTF8_BOM.as_bytes())
        .map_err(|e| export_io(ExportIoStep::Write, path, e))?;
    let mut wtr = csv::Writer::from_writer(file);
    wtr.write_record(columns.iter().map(|c| c.name.as_str()))
        .map_err(|e| export_io(ExportIoStep::Write, path, e))?;
    scan_rows(engine, sql, columns.len(), |cells| {
        // The cancel checkpoint (issue #779): every row consults the
        // session token, so a cancel during a multi-minute scan stops the
        // export within one row instead of at its natural end.
        if cancel.is_requested() {
            return Err(RowReadError::Cancelled.into());
        }
        wtr.write_record(cells)
            .map_err(|e| export_io(ExportIoStep::Write, path, e))
    })?;
    wtr.flush()
        .map_err(|e| export_io(ExportIoStep::Flush, path, e))?;
    Ok(())
}

/// Every row of a dataset as TSV text with the header row leading (issue
/// #769): the full-result clipboard payload. Same data source and cell
/// semantics as [`read_rows`], no clamp and no paging. TSV carries no
/// quoting convention that spreadsheet paste honors, so an embedded tab,
/// CR, or LF would silently split one cell across columns -- those control
/// characters are sanitized to a space (see [`push_tsv_line`]). Stale
/// results copy too; the payload carries no status markers.
///
/// Memory upper bound, deliberately NOT chunked (issue #779 AC3): the
/// clipboard write takes exactly one string, so chunking the scan would
/// only move the peak (the chunks plus the joined result), never lower
/// it. The bound on that peak is the confirm gate -- a result over
/// `MAX_UNCONFIRMED_FULL_ROWS` rows refuses with `RowReadError::TooLarge`
/// unless `confirmed`, so a copy that large is an explicit choice, and a
/// cancel observed mid-scan stops it with `RowReadError::Cancelled`
/// (the [`CancelToken`] fires without the session lock, ADR-0021; the
/// pull's start retires the token's generation -- consuming a leftover
/// request and standing down a still-sleeping no-progress watchdog from
/// the last turn -- see [`start_full_pull`]).
pub(super) fn read_rows_tsv(
    cancel: &CancelToken,
    working_set: &WorkingSet,
    engine: &AdminEngine,
    reference_name: &str,
    confirmed: bool,
) -> Result<String, RowReadError> {
    read_rows_tsv_gated(
        cancel,
        working_set,
        engine,
        reference_name,
        confirmed,
        MAX_UNCONFIRMED_FULL_ROWS,
    )
}

/// The full-path size gate for the TSV copy (issue #779) -- the
/// [`read_rows_tsv`] twin of [`export_rows_csv_gated`]: the
/// threshold is a parameter so tests exercise the gate with small
/// fixtures (the `read_line_bounded` `max` precedent).
pub(super) fn read_rows_tsv_gated(
    cancel: &CancelToken,
    working_set: &WorkingSet,
    engine: &AdminEngine,
    reference_name: &str,
    confirmed: bool,
    confirm_above: u64,
) -> Result<String, RowReadError> {
    let (columns, sql) = start_full_pull(
        cancel,
        working_set,
        reference_name,
        confirmed,
        confirm_above,
    )?;
    let mut out = String::new();
    push_tsv_line(&mut out, columns.iter().map(|c| c.name.as_str()));
    scan_rows(engine, &sql, columns.len(), |cells| {
        // The cancel checkpoint (issue #779), symmetric with the export
        // path's: every row consults the session token.
        if cancel.is_requested() {
            return Err(RowReadError::Cancelled);
        }
        push_tsv_line(&mut out, cells.iter());
        Ok(())
    })?;
    Ok(out)
}

/// The shared full-pull preamble (issue #779): resolve the data source,
/// run the confirm gate over the descriptor's row count, then retire the
/// token's generation -- consuming any leftover cancel request (a stop
/// that landed after the last turn or pull cannot silently kill this pull
/// on its first row) AND standing down any still-sleeping wall-clock
/// watchdog from the last turn, which would otherwise fire into a pull
/// the user never stopped and land as a quiet Cancelled (the begin_turn
/// word update, minus the in-flight half; a pull is not a turn). A
/// request that fires AFTER this point is honored by the row loop's
/// checkpoint; one racing it is either wiped or honored, the same
/// nondeterminism `begin_turn` documents.
fn start_full_pull(
    cancel: &CancelToken,
    working_set: &WorkingSet,
    reference_name: &str,
    confirmed: bool,
    confirm_above: u64,
) -> Result<(Vec<ColumnSchema>, String), RowReadError> {
    let (columns, sql, row_count) = full_rows_sql(working_set, reference_name)?;
    if !confirmed && row_count > confirm_above {
        return Err(RowReadError::TooLarge {
            row_count,
            limit: confirm_above,
        });
    }
    cancel.retire_generation();
    Ok((columns, sql))
}

/// Append one TSV line (cells joined on tabs, trailing newline) with each
/// cell's embedded tab / CR / LF sanitized to a single space (issue #769) --
/// TSV has no quoting convention that spreadsheet paste honors, so keeping
/// those control characters would silently break the paste's column structure.
fn push_tsv_line<S: AsRef<str>>(out: &mut String, cells: impl IntoIterator<Item = S>) {
    let mut first = true;
    for cell in cells {
        if !first {
            out.push('\t');
        }
        first = false;
        for ch in cell.as_ref().chars() {
            out.push(if matches!(ch, '\t' | '\r' | '\n') {
                ' '
            } else {
                ch
            });
        }
    }
    out.push('\n');
}

/// Build the typed destination-file failure for a CSV export (issue #769):
/// which step failed, at which path, with the underlying io error as the
/// detail.
fn export_io(step: ExportIoStep, path: &str, e: impl std::fmt::Display) -> ExportRowsError {
    ExportRowsError::Io {
        step,
        path: path.to_string(),
        detail: e.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_config::model::EngineDefaults;
    use crate::model::DatasetDescriptor;

    /// The rows-IO seam fixture (ADR-0053 Decision 6): materialize a physical
    /// `result_1` table (ADR-0024 main-DB form) in a `:memory:` engine, register
    /// it in a minimal working set with the table's real row count, and hand
    /// back the borrowed trio the free functions take -- no Session, no
    /// scripted provider, no session tempdir.
    fn rows_fixture(create_sql: &str, columns: &[&str]) -> (WorkingSet, AdminEngine, CancelToken) {
        let engine = AdminEngine::new(EngineDefaults::default());
        engine.execute_batch(create_sql).expect("create table");
        let row_count = engine
            .acquire()
            .expect("acquire")
            .query_row("SELECT COUNT(*) FROM result_1", [], |r| r.get::<_, i64>(0))
            .expect("count") as u64;
        let mut working_set = WorkingSet::default();
        working_set.register_result(DatasetDescriptor {
            reference_name: "result_1".to_string(),
            display_name: "result_1".to_string(),
            source_path: String::new(),
            columns: columns
                .iter()
                .map(|name| ColumnSchema {
                    name: (*name).to_string(),
                    canonical_type: "VARCHAR".to_string(),
                })
                .collect(),
            row_count,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: Default::default(),
            privacy: Default::default(),
            stale: None,
        });
        (working_set, engine, CancelToken::new())
    }

    #[test]
    fn read_rows_pages_a_physical_result() {
        // ADR-0024 windowed display: the result is a full physical table;
        // read_rows returns a bounded page plus the honest total (ADR-0030
        // truncation disclosure).
        let (ws, engine, _cancel) = rows_fixture(
            "CREATE TABLE result_1 AS SELECT i AS id FROM range(1, 6) t(i)",
            &["id"],
        );

        let page1 = read_rows(&ws, &engine, "result_1", 0, 3).expect("page1");
        assert_eq!(page1.total, 5);
        assert_eq!(page1.rows.len(), 3);
        assert_eq!(page1.rows[0], vec!["1".to_string()]);
        assert_eq!(page1.rows[2], vec!["3".to_string()]);

        let page2 = read_rows(&ws, &engine, "result_1", 3, 3).expect("page2");
        assert_eq!(page2.rows.len(), 2); // rows 4, 5
        assert_eq!(page2.rows[0], vec!["4".to_string()]);
    }

    #[test]
    fn read_export_and_copy_on_an_unknown_reference_are_rejected() {
        // Issue #769: the read and both full paths share the typed
        // UnknownDataset refusal -- not a silent empty page / file / payload
        // -- and no file is created: the data source resolves before the
        // open. The fixture registers a real result_1 first, so the refusal
        // is genuinely keyed on the reference name (a fallback-to-registered
        // mutation would hand back result_1's data and fail these asserts).
        let (ws, engine, cancel) = rows_fixture("CREATE TABLE result_1 AS SELECT 1 AS n", &["n"]);
        assert!(read_rows(&ws, &engine, "nope", 0, 10).is_err());
        assert!(matches!(
            export_rows_csv(&cancel, &ws, &engine, "nope", "unused.csv", false),
            Err(ExportRowsError::RowRead(RowReadError::UnknownDataset(_)))
        ));
        assert!(
            !std::path::Path::new("unused.csv").exists(),
            "no file created: the data source resolves before the open"
        );
        assert!(matches!(
            read_rows_tsv(&cancel, &ws, &engine, "nope", false),
            Err(RowReadError::UnknownDataset(_))
        ));
    }

    #[test]
    fn export_rows_csv_writes_every_row_beyond_the_page_cap() {
        // Issue #769: the export path reuses read_rows' data source but runs it
        // unclamped -- a result past MAX_READ_ROWS (10_000) lands in the file in
        // full, header row leading, behind a UTF-8 BOM (Excel-family UTF-8
        // autodetection), with fields CSV-escaped and NULL rendered as an empty
        // cell.
        let (ws, engine, cancel) = rows_fixture(
            r#"CREATE TABLE result_1 AS SELECT
              i AS 序号,
              CASE WHEN i = 1 THEN 'a,b "c"'
                   WHEN i = 2 THEN 'l' || chr(13) || 'm' || chr(10) || 'n'
                   ELSE '值' || i END AS 备注,
              CAST(NULL AS VARCHAR) AS 空值
            FROM range(1, 10002) t(i)"#,
            &["序号", "备注", "空值"],
        );

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("result_1.csv");
        export_rows_csv(
            &cancel,
            &ws,
            &engine,
            "result_1",
            path.to_str().unwrap(),
            false,
        )
        .expect("export");

        let bytes = std::fs::read(&path).expect("read csv");
        assert_eq!(&bytes[..3], b"\xEF\xBB\xBF", "UTF-8 BOM leads");
        let mut reader = csv::Reader::from_reader(&bytes[3..]);
        let headers = reader.headers().expect("headers").clone();
        assert_eq!(headers, vec!["序号", "备注", "空值"]);
        let records: Vec<_> = reader.records().map(|r| r.expect("record")).collect();
        assert_eq!(records.len(), 10_001, "no MAX_READ_ROWS clamp");
        assert_eq!(
            records[0].get(1),
            Some(r#"a,b "c""#),
            "quoted field round-trips"
        );
        assert_eq!(
            records[1].get(1),
            Some("l\rm\nn"),
            "embedded CR/LF round-trips inside the quoted field"
        );
        assert_eq!(records[2].get(1), Some("值3"), "CJK value round-trips");
        assert_eq!(records[0].get(2), Some(""), "NULL -> empty cell");

        // The TSV full path runs the same fixture unclamped too -- a clamp on
        // the copy path alone would fail this count.
        let tsv = read_rows_tsv(&cancel, &ws, &engine, "result_1", false).expect("tsv");
        assert_eq!(
            tsv.lines().count(),
            10_002,
            "tsv unclamped: header + all rows"
        );
    }

    #[test]
    fn read_rows_tsv_carries_the_header_and_sanitizes_control_characters() {
        // Issue #769: the full-copy payload is the header plus every row joined on
        // tabs; TSV has no quoting convention spreadsheet paste honors, so cells
        // with embedded tab/LF are sanitized to spaces to keep the paste's column
        // structure honest.
        let (ws, engine, cancel) = rows_fixture(
            "CREATE TABLE result_1 AS SELECT 'a' || chr(9) || 'b' AS 甲, 'x' || chr(10) || 'y' AS 乙 FROM range(1, 4) t(i)",
            &["甲", "乙"],
        );

        let tsv = read_rows_tsv(&cancel, &ws, &engine, "result_1", false).expect("tsv");
        let lines: Vec<&str> = tsv.lines().collect();
        assert_eq!(lines[0], "甲\t乙", "header row leads");
        assert_eq!(lines[1], "a b\tx y", "tab/LF sanitized to spaces");
        assert_eq!(lines.len(), 4, "header + all 3 rows, no paging");
    }

    #[test]
    fn export_and_copy_on_an_empty_result_carry_the_header_only() {
        // Issue #769: a zero-row result still produces a well-formed payload --
        // BOM + header row for the file, the header line alone for the TSV --
        // and the paged read reports the honest empty page.
        let (ws, engine, cancel) =
            rows_fixture("CREATE TABLE result_1 AS SELECT 1 AS n WHERE 1 = 0", &["n"]);

        let page = read_rows(&ws, &engine, "result_1", 0, 10).expect("page");
        assert_eq!(page.total, 0, "honest total on an empty result");
        assert!(page.rows.is_empty());

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("result_1.csv");
        export_rows_csv(
            &cancel,
            &ws,
            &engine,
            "result_1",
            path.to_str().unwrap(),
            false,
        )
        .expect("export");
        let bytes = std::fs::read(&path).expect("read csv");
        assert_eq!(&bytes[..3], b"\xEF\xBB\xBF", "UTF-8 BOM leads");
        assert_eq!(&bytes[3..], b"n\n", "header row only, no data rows");

        let tsv = read_rows_tsv(&cancel, &ws, &engine, "result_1", false).expect("tsv");
        assert_eq!(tsv, "n\n", "header line only");
    }

    #[test]
    fn export_and_copy_refuse_above_the_confirm_gate_until_confirmed() {
        // Issue #779 AC1: a full pull over the confirm threshold refuses with the
        // real row count until the caller re-sends with confirmed. The threshold
        // is injected small (the gated seam -- the `read_line_bounded` `max`
        // precedent) so a 3-row fixture exercises the same gate the constant
        // guards in production. The refusal lands BEFORE the destination opens,
        // so no file is created.
        let (ws, engine, cancel) = rows_fixture(
            "CREATE TABLE result_1 AS SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3",
            &["n"],
        );

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("result_1.csv");
        assert!(matches!(
            export_rows_csv_gated(
                &cancel,
                &ws,
                &engine,
                "result_1",
                path.to_str().unwrap(),
                false,
                2
            ),
            Err(ExportRowsError::RowRead(RowReadError::TooLarge {
                row_count: 3,
                limit: 2
            }))
        ));
        assert!(!path.exists(), "gate refuses before the destination opens");
        assert!(matches!(
            read_rows_tsv_gated(&cancel, &ws, &engine, "result_1", false, 2),
            Err(RowReadError::TooLarge {
                row_count: 3,
                limit: 2
            })
        ));

        // Confirmed, the same call proceeds: the file lands and the TSV returns.
        export_rows_csv_gated(
            &cancel,
            &ws,
            &engine,
            "result_1",
            path.to_str().unwrap(),
            true,
            2,
        )
        .expect("confirmed export");
        assert!(path.exists());
        let tsv =
            read_rows_tsv_gated(&cancel, &ws, &engine, "result_1", true, 2).expect("confirmed tsv");
        assert_eq!(tsv.lines().count(), 4, "header + 3 rows");
    }

    #[test]
    fn export_rows_csv_destination_failure_is_typed_and_leaves_no_artifact() {
        // Review of #778: a destination that cannot be opened is the typed
        // Io { step: Create, .. } refusal -- the export-domain locale message
        // frontend-side, not the generic internal-error wording.
        let (ws, engine, cancel) = rows_fixture("CREATE TABLE result_1 AS SELECT 1 AS n", &["n"]);

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("no_such_dir").join("result_1.csv");
        assert!(matches!(
            export_rows_csv(
                &cancel,
                &ws,
                &engine,
                "result_1",
                path.to_str().unwrap(),
                false
            ),
            Err(ExportRowsError::Io {
                step: ExportIoStep::Create,
                ..
            })
        ));
    }
}
