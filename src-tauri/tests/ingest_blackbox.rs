//! Black-box ingest seam (PRD #2 main seam): feed fixture files to `Session` and
//! assert the produced Dataset descriptor + behavior. Fully local, deterministic,
//! no network, no LLM. Never asserts copy-in SQL internals.

use std::fs;
use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Formula, Workbook};
use toptopduck_lib::{
    DatasetDescriptor, DatasetPrivacy, LoadError, LoadOutcome, RectifyProvenance, RenameError,
    Session, SheetGuidance, SheetRectify,
};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn fixture(name: &str) -> PathBuf {
    fixtures_dir().join(name)
}

fn load_ok(session: &mut Session, path: &Path) -> DatasetDescriptor {
    match session.ingest(path) {
        LoadOutcome::Loaded(d) => d,
        LoadOutcome::NeedsGuidance(g) => {
            panic!("expected load to succeed, got NeedsGuidance: {g:?}")
        }
        LoadOutcome::Error(e) => panic!("expected load to succeed, got: {e}"),
    }
}

#[test]
fn loads_csv_into_working_set_as_active() {
    // AC1: pick a CSV -> one Dataset, named after the file stem, becomes active.
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("people.csv"));
    assert_eq!(d.reference_name, "people");
    assert_eq!(d.display_name, "people"); // AC1: named after the filename stem (readable label, ADR-0037)
    assert_eq!(session.list().len(), 1);
    assert_eq!(session.active().expect("active").reference_name, "people");
}

#[test]
fn exposes_canonical_duckdb_types() {
    // AC2: per-column DuckDB inferred types under a single canonical name.
    // (read_csv_auto infers integers as 64-bit BIGINT by default.)
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("people.csv"));
    let types: Vec<(&str, &str)> = d
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.canonical_type.as_str()))
        .collect();
    assert_eq!(
        types,
        vec![
            ("id", "BIGINT"),
            ("name", "VARCHAR"),
            ("joined", "DATE"),
            ("active", "BOOLEAN"),
            ("score", "DOUBLE"),
        ]
    );
}

#[test]
fn surfaces_row_count_and_frozen_first_three_sample() {
    // AC3: total row count + first-3-row sample frozen at copy-in.
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("people.csv"));
    assert_eq!(d.row_count, 5);
    assert_eq!(d.sample.len(), 3);
    assert_eq!(d.sample[0], vec!["1", "Alice", "2021-03-15", "true", "3.5"]);
    assert_eq!(d.sample[2], vec!["3", "Cara", "2022-01-08", "true", "2.8"]);
}

#[test]
fn reloading_same_file_is_deterministic() {
    // AC4: reload the same file -> structurally identical Dataset (deterministic).
    let mut session = Session::new().expect("session");
    let d1 = load_ok(&mut session, &fixture("people.csv"));
    let d2 = load_ok(&mut session, &fixture("people.csv"));
    assert_eq!(d2.reference_name, "people_2"); // de-conflicted
    assert_eq!(d1.columns, d2.columns);
    assert_eq!(d1.row_count, d2.row_count);
    assert_eq!(d1.sample, d2.sample);
    assert_eq!(d1.fingerprint, d2.fingerprint); // deterministic content hash
}

#[test]
fn fingerprint_is_stable_across_sessions() {
    // AC9: cross-session, same file -> same fingerprint.
    let fp1 = {
        let mut s = Session::new().expect("session");
        load_ok(&mut s, &fixture("people.csv")).fingerprint
    };
    let fp2 = {
        let mut s = Session::new().expect("session");
        load_ok(&mut s, &fixture("people.csv")).fingerprint
    };
    assert_eq!(fp1, fp2);
}

#[test]
fn source_snapshot_is_read_only() {
    // AC5: write attempts on the source snapshot are rejected by the engine, and
    // the original file on disk is never modified.
    let mut session = Session::new().expect("session");
    let before = fs::read(fixture("people.csv")).expect("read original");
    load_ok(&mut session, &fixture("people.csv"));

    let writes = [
        r#"INSERT INTO "people".data VALUES (99,'X','2024-01-01',true,1.0)"#,
        r#"UPDATE "people".data SET name = 'X'"#,
        r#"DELETE FROM "people".data"#,
        r#"DROP TABLE "people".data"#,
    ];
    for sql in writes {
        assert!(
            session.execute_batch(sql).is_err(),
            "write should be rejected: {sql}"
        );
    }

    let after = fs::read(fixture("people.csv")).expect("read original again");
    assert_eq!(before, after);
}

#[test]
fn unsupported_format_is_rejected() {
    // .xlsx is now supported (issue #7); .txt and other extensions are rejected
    // with the working set unchanged. (.xls is handled in slice 3b.)
    let dir = tempfile::tempdir().expect("tempdir");
    let txt = dir.path().join("notes.txt");
    fs::write(&txt, "just text").expect("write txt");
    let mut session = Session::new().expect("session");
    match session.ingest(&txt) {
        LoadOutcome::Error(LoadError::UnsupportedFormat { .. }) => {}
        other => panic!("expected UnsupportedFormat, got {other:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

#[test]
fn corrupted_csv_is_rejected_and_working_set_unchanged() {
    // AC7: a genuinely unparseable file (invalid UTF-8 bytes) -> clear error,
    // working set unchanged. DuckDB is lenient on messy-but-text CSVs, so binary
    // content is the reliable hard-failure case.
    let dir = tempfile::tempdir().expect("tempdir");
    let bad = dir.path().join("corrupted.csv");
    fs::write(&bad, [0xffu8, 0xfe, 0x80, 0x81, 0xc0, 0xc1, 0x0a]).expect("write corrupted");
    let mut session = Session::new().expect("session");
    match session.ingest(&bad) {
        LoadOutcome::Error(_) => {}
        LoadOutcome::NeedsGuidance(g) => panic!("expected error, got NeedsGuidance: {g:?}"),
        LoadOutcome::Loaded(d) => panic!("expected error for corrupted file, got: {d:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

#[test]
fn nonexistent_file_is_rejected_and_working_set_unchanged() {
    // AC7 robust guard: a failed load always leaves the working set unchanged.
    let mut session = Session::new().expect("session");
    let missing = fixtures_dir().join("does_not_exist.csv");
    match session.ingest(&missing) {
        LoadOutcome::Error(_) => {}
        other => panic!("expected error, got {other:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

#[test]
fn empty_csv_loads_with_zero_rows_and_empty_sample() {
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("empty.csv"));
    assert_eq!(d.row_count, 0);
    assert!(d.sample.is_empty());
    assert!(!d.columns.is_empty());
}

#[test]
fn large_csv_loads_without_freezing() {
    // AC8: a larger file loads and completes (progress UI feedback is a UI-layer
    // concern, handled in the async Tauri command).
    let dir = tempfile::tempdir().expect("tempdir");
    let big = dir.path().join("big.csv");
    let nl = char::from(10);
    let mut content = String::from("id,value");
    content.push(nl);
    for i in 0..20_000 {
        content.push_str(&format!("{i},{i}"));
        content.push(nl);
    }
    fs::write(&big, content).expect("write big csv");

    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &big);
    assert_eq!(d.row_count, 20_000);
    assert_eq!(d.reference_name, "big");
}

#[test]
fn descriptor_carries_disclosure_payload() {
    // AC6 (structural): the descriptor carries the schema + frozen sample that the
    // UI discloses as the default-to-send payload (LLM not wired in slice 1).
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("people.csv"));
    assert!(!d.columns.is_empty());
    assert!(!d.sample.is_empty());
}

/// Generate a `people.parquet` from `people.csv` via DuckDB so no binary fixture
/// is committed. Returns the path plus the temp dir that owns it -- keep both
/// alive for the test's duration. The read path under test is independent of how
/// the fixture was written.
fn parquet_from_people() -> (PathBuf, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let out = dir.path().join("people.parquet");
    // Paths are tool-controlled (fixture + temp dir), not user input, so SQL
    // interpolation is safe -- mirrors the fingerprint COPY in snapshot.rs.
    let csv = fixture("people.csv");
    let csv_path = csv.to_string_lossy().into_owned();
    let parquet_path = out.to_string_lossy().into_owned();
    let conn = duckdb::Connection::open_in_memory().expect("duckdb");
    conn.execute_batch(&format!(
        "COPY (SELECT * FROM read_csv_auto('{csv_path}')) TO '{parquet_path}' (FORMAT PARQUET)"
    ))
    .expect("write parquet fixture");
    (out, dir)
}

/// (column name, canonical type) pairs for a descriptor, in declared order.
fn column_types(d: &DatasetDescriptor) -> Vec<(&str, &str)> {
    d.columns
        .iter()
        .map(|c| (c.name.as_str(), c.canonical_type.as_str()))
        .collect()
}

#[test]
fn loads_parquet_into_working_set_as_active() {
    // AC1 (parquet): pick a Parquet -> one Dataset, becomes active, with the same
    // type/row-count/sample contract as CSV.
    let (parquet, _dir) = parquet_from_people();
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &parquet);
    assert_eq!(d.reference_name, "people");
    assert_eq!(session.active().unwrap().reference_name, "people");
    assert_eq!(
        column_types(&d),
        vec![
            ("id", "BIGINT"),
            ("name", "VARCHAR"),
            ("joined", "DATE"),
            ("active", "BOOLEAN"),
            ("score", "DOUBLE"),
        ]
    );
    assert_eq!(d.row_count, 5);
    assert_eq!(d.sample.len(), 3);
}

#[test]
fn loads_flat_json_with_shared_contract() {
    // AC (flat JSON): the same schema/sample contract as CSV/Parquet.
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("flat.json"));
    assert_eq!(d.reference_name, "flat");
    assert_eq!(
        column_types(&d),
        vec![
            ("id", "BIGINT"),
            ("name", "VARCHAR"),
            ("active", "BOOLEAN"),
            ("score", "DOUBLE"),
        ]
    );
    assert_eq!(d.row_count, 3);
    assert_eq!(d.sample[0], vec!["1", "Alice", "true", "3.5"]);
}

#[test]
fn loads_nested_json_with_fully_expanded_types() {
    // AC (nested JSON): STRUCT fields and LIST elements are fully expanded with
    // canonical type names and preserved field case (ADR-0032). MAP does not arise
    // from read_json_auto (objects infer as STRUCT); MAP canonicalization is
    // covered by the schema projector unit tests.
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("nested.json"));
    let by_name: std::collections::HashMap<&str, &str> = column_types(&d).into_iter().collect();
    assert_eq!(by_name["address"], "STRUCT(city VARCHAR, zip VARCHAR)");
    assert_eq!(by_name["tags"], "LIST(VARCHAR)");
    assert_eq!(by_name["scores"], "LIST(BIGINT)");
    assert_eq!(by_name["prefs"], "STRUCT(theme VARCHAR)");
    assert_eq!(d.row_count, 3);
    assert_eq!(d.sample.len(), 3);
}

#[test]
fn corrupted_parquet_is_rejected_and_working_set_unchanged() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bad = dir.path().join("corrupted.parquet");
    fs::write(&bad, b"not actually a parquet file").expect("write corrupted");
    let mut session = Session::new().expect("session");
    match session.ingest(&bad) {
        LoadOutcome::Error(_) => {}
        LoadOutcome::NeedsGuidance(g) => panic!("expected error, got NeedsGuidance: {g:?}"),
        LoadOutcome::Loaded(d) => panic!("expected error for corrupted parquet, got: {d:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

#[test]
fn corrupted_json_is_rejected_and_working_set_unchanged() {
    let dir = tempfile::tempdir().expect("tempdir");
    let bad = dir.path().join("corrupted.json");
    fs::write(&bad, [0xffu8, 0xfe, 0x80, 0x81, 0xc0, 0xc1, 0x0a]).expect("write corrupted");
    let mut session = Session::new().expect("session");
    match session.ingest(&bad) {
        LoadOutcome::Error(_) => {}
        LoadOutcome::NeedsGuidance(g) => panic!("expected error, got NeedsGuidance: {g:?}"),
        LoadOutcome::Loaded(d) => panic!("expected error for corrupted json, got: {d:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

#[test]
fn shared_contract_across_csv_parquet_and_json() {
    // AC: CSV/Parquet/JSON share one schema/sample/fingerprint payload contract
    // -- no format-specific branches in the descriptor.
    let (parquet, _dir) = parquet_from_people();
    let csv = fixture("people.csv");
    let flat = fixture("flat.json");
    let paths: [&Path; 3] = [&csv, &parquet, &flat];
    let mut session = Session::new().expect("session");
    for path in paths {
        let d = load_ok(&mut session, path);
        assert!(!d.columns.is_empty(), "empty columns for {path:?}");
        assert!(!d.sample.is_empty(), "empty sample for {path:?}");
        assert!(!d.fingerprint.is_empty(), "empty fingerprint for {path:?}");
    }
    assert_eq!(session.list().len(), 3);
}

// --- Excel .xlsx (issue #7, slice 3a) --------------------------------------
//
// Fixtures are generated with rust_xlsxwriter so no binary .xlsx is committed
// (mirrors the parquet helper). calamine reads cell cached values (formulas
// resolve to their cached result, never recomputed -- ADR-0015); each sheet
// becomes one Dataset named after the sheet. duckdb-rs's vendored DuckDB cannot
// statically link the `excel` loadable extension, so xlsx bytes go
// calamine -> per-sheet temp CSV -> read_csv_auto copy-in, keeping DuckDB as the
// single type-inference source of truth (ADR-0032). See ADR-0014/0043.

/// Save a workbook to a temp .xlsx; keep the temp dir alive for the test.
fn save_xlsx(mut wb: Workbook, file_name: &str) -> (PathBuf, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(file_name);
    wb.save(&path).expect("save xlsx fixture");
    (path, dir)
}

/// A single tidy sheet "people" mirroring people.csv so the shared contract
/// (types/rows/sample) holds across CSV and xlsx.
fn people_xlsx() -> (PathBuf, tempfile::TempDir) {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("people").expect("name sheet");
    ws.write_string(0, 0, "id").unwrap();
    ws.write_string(0, 1, "name").unwrap();
    ws.write_string(0, 2, "active").unwrap();
    ws.write_string(0, 3, "score").unwrap();
    let rows: &[(f64, &str, bool, f64)] = &[
        (1.0, "Alice", true, 3.5),
        (2.0, "Bob", false, 2.8),
        (3.0, "Cara", true, 2.8),
        (4.0, "Dave", false, 4.1),
        (5.0, "Eve", true, 3.9),
    ];
    for (i, (id, name, active, score)) in rows.iter().enumerate() {
        let r = (i + 1) as u32;
        ws.write_number(r, 0, *id).unwrap();
        ws.write_string(r, 1, *name).unwrap();
        ws.write_boolean(r, 2, *active).unwrap();
        ws.write_number(r, 3, *score).unwrap();
    }
    save_xlsx(wb, "people.xlsx")
}

#[test]
fn loads_single_sheet_xlsx_named_after_sheet() {
    // AC2: pick a single-sheet .xlsx -> one Dataset named after the sheet, active.
    let (xlsx, _dir) = people_xlsx();
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &xlsx);
    assert_eq!(d.reference_name, "people"); // named after the sheet, not the file
    assert_eq!(d.display_name, "people");
    assert_eq!(session.list().len(), 1);
    assert_eq!(session.active().unwrap().reference_name, "people");
}

#[test]
fn xlsx_shares_type_contract_with_csv() {
    // AC5: same canonical DuckDB types as people.csv (single source of truth,
    // ADR-0032) -- the calamine -> CSV -> read_csv_auto path re-infers in DuckDB.
    let (xlsx, _dir) = people_xlsx();
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &xlsx);
    assert_eq!(
        column_types(&d),
        vec![
            ("id", "BIGINT"),
            ("name", "VARCHAR"),
            ("active", "BOOLEAN"),
            ("score", "DOUBLE"),
        ]
    );
    assert_eq!(d.row_count, 5);
    assert_eq!(d.sample.len(), 3);
    assert_eq!(d.sample[0], vec!["1", "Alice", "true", "3.5"]);
}

#[test]
fn loads_multi_sheet_xlsx_each_sheet_a_dataset() {
    // AC3: each sheet -> its own Dataset, each referenceable independently.
    let mut wb = Workbook::new();
    let people = wb.add_worksheet();
    people.set_name("people").expect("name");
    people.write_string(0, 0, "id").unwrap();
    people.write_number(1, 0, 1.0).unwrap();
    people.write_number(2, 0, 2.0).unwrap();
    let orders = wb.add_worksheet();
    orders.set_name("orders").expect("name");
    orders.write_string(0, 0, "order_id").unwrap();
    orders.write_string(0, 1, "amount").unwrap();
    orders.write_number(1, 0, 100.0).unwrap();
    orders.write_number(1, 1, 9.99).unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "multi.xlsx");

    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &xlsx);
    // active points at the last sheet (ADR-0022: active = most recent source).
    assert_eq!(d.reference_name, "orders");
    assert_eq!(session.list().len(), 2);
    // each sheet is referenceable by its sheet-derived name
    assert!(session.get("people").is_some());
    assert!(session.get("orders").is_some());
    // row counts are per-sheet, not summed
    assert_eq!(session.get("people").unwrap().row_count, 2);
    assert_eq!(session.get("orders").unwrap().row_count, 1);
}

#[test]
fn xlsx_hidden_sheets_are_skipped() {
    // A hidden sheet (Excel state="hidden") is not loaded as a Dataset -- the
    // user hid it in Excel, so it isn't part of the data they want to analyze.
    // Only the visible sheet becomes a Dataset.
    let mut wb = Workbook::new();
    let visible = wb.add_worksheet();
    visible.set_name("visible").expect("name");
    visible.write_string(0, 0, "id").unwrap();
    visible.write_number(1, 0, 1.0).unwrap();
    let hidden = wb.add_worksheet();
    hidden.set_name("hidden").expect("name");
    hidden.set_hidden(true);
    hidden.write_string(0, 0, "id").unwrap();
    hidden.write_number(1, 0, 2.0).unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "hidden.xlsx");

    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &xlsx);
    assert_eq!(d.reference_name, "visible");
    assert_eq!(session.list().len(), 1);
    assert!(session.get("hidden").is_none());
}

#[test]
fn xlsx_formula_cells_use_cached_values() {
    // AC4: formula cells resolve to their cached value (never recomputed). The
    // fixture stores an explicit cached result (exactly what Excel persists);
    // the sample must show that value, never the formula text.
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("calc").expect("name");
    ws.write_string(0, 0, "a").unwrap();
    ws.write_string(0, 1, "sum").unwrap();
    ws.write_number(1, 0, 1.0).unwrap();
    ws.write_formula(1, 1, Formula::new("1+1").set_result("2"))
        .unwrap();
    ws.write_number(2, 0, 2.0).unwrap();
    ws.write_formula(2, 1, Formula::new("B2*5").set_result("10"))
        .unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "calc.xlsx");

    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &xlsx);
    assert_eq!(d.reference_name, "calc");
    assert_eq!(d.sample[0], vec!["1", "2"]); // cached "2", not "=1+1"
    assert_eq!(d.sample[1], vec!["2", "10"]); // cached "10", not "B2*5"
}

#[test]
fn xlsx_snapshot_is_read_only() {
    // AC5: per-sheet snapshots are engine-level read-only (ADR-0005).
    let (xlsx, _dir) = people_xlsx();
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &xlsx);
    let writes = [
        r#"INSERT INTO "people".data VALUES (99,'X',true,1.0)"#,
        r#"DROP TABLE "people".data"#,
    ];
    for sql in writes {
        assert!(
            session.execute_batch(sql).is_err(),
            "write should be rejected: {sql}"
        );
    }
}

#[test]
fn reloading_xlsx_is_deterministic() {
    // AC5: reload the same xlsx -> structurally identical descriptor per sheet.
    let (xlsx, _dir) = people_xlsx();
    let mut session = Session::new().expect("session");
    let d1 = load_ok(&mut session, &xlsx);
    let d2 = load_ok(&mut session, &xlsx);
    assert_eq!(d2.reference_name, "people_2"); // de-conflicted
    assert_eq!(d1.columns, d2.columns);
    assert_eq!(d1.row_count, d2.row_count);
    assert_eq!(d1.sample, d2.sample);
    assert_eq!(d1.fingerprint, d2.fingerprint);
}

#[test]
fn xlsx_empty_sheets_are_skipped() {
    // A fully blank sheet contributes no Dataset; only sheets with rows load.
    let mut wb = Workbook::new();
    let blank = wb.add_worksheet();
    blank.set_name("blank").expect("name"); // no cells written
    let data = wb.add_worksheet();
    data.set_name("data").expect("name");
    data.write_string(0, 0, "id").unwrap();
    data.write_number(1, 0, 1.0).unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "mixed.xlsx");

    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &xlsx);
    assert_eq!(d.reference_name, "data");
    assert_eq!(session.list().len(), 1);
    assert!(session.get("blank").is_none());
}

#[test]
fn corrupted_xlsx_is_rejected_and_working_set_unchanged() {
    // AC6: a non-xlsx file passed as .xlsx -> clear error, working set unchanged.
    let dir = tempfile::tempdir().expect("tempdir");
    let bad = dir.path().join("corrupted.xlsx");
    fs::write(&bad, b"not actually an xlsx file (no zip magic)").expect("write corrupted");
    let mut session = Session::new().expect("session");
    match session.ingest(&bad) {
        LoadOutcome::Error(_) => {}
        LoadOutcome::NeedsGuidance(g) => panic!("expected error, got NeedsGuidance: {g:?}"),
        LoadOutcome::Loaded(d) => panic!("expected error for corrupted xlsx, got {d:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

// --- Excel auto-tidy + guided fallback (issue #10, slice 3b) ----------------
//
// Best-effort auto-tidy (ADR-0015): forward-fill merged cells + single-header
// detection. A sheet the auto algorithm can't confidently tidy -> NeedsGuidance
// (no partial load); the user's explicit header/skip choices re-enter via
// ingest_guided and are recorded as rectify params (ADR-0042). .xls is rejected
// with an actionable hint. Fixtures use rust_xlsxwriter incl. merge_range.

fn fmt() -> rust_xlsxwriter::Format {
    rust_xlsxwriter::Format::default()
}

/// A sheet with a leading merged title row + a merged data cell in the region
/// column -- auto-tidy must skip the title, keep the single header, and
/// forward-fill the merged region (AC1).
fn messy_xlsx() -> (PathBuf, tempfile::TempDir) {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("report").expect("name");
    // Row 0: merged banner title across A0:C0.
    ws.merge_range(0, 0, 0, 2, "Sales Report", &fmt()).unwrap();
    // Row 1: the real header.
    ws.write_string(1, 0, "id").unwrap();
    ws.write_string(1, 1, "region").unwrap();
    ws.write_string(1, 2, "amount").unwrap();
    // Row 2: data.
    ws.write_number(2, 0, 1.0).unwrap();
    ws.write_string(2, 1, "North").unwrap();
    ws.write_number(2, 2, 100.0).unwrap();
    // Rows 3-4: region merged "East" down col 1.
    ws.write_number(3, 0, 2.0).unwrap();
    ws.merge_range(3, 1, 4, 1, "East", &fmt()).unwrap();
    ws.write_number(3, 2, 200.0).unwrap();
    ws.write_number(4, 0, 3.0).unwrap();
    ws.write_number(4, 2, 300.0).unwrap();
    save_xlsx(wb, "messy.xlsx")
}

#[test]
fn auto_tidy_skips_title_and_unmerges_data_cells() {
    // AC1: a leading merged title + a merged data region -> a tidy single-header
    // table (title dropped, region forward-filled).
    let (xlsx, _dir) = messy_xlsx();
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &xlsx);
    assert_eq!(d.reference_name, "report");
    assert_eq!(
        column_types(&d),
        vec![
            ("id", "BIGINT"),
            ("region", "VARCHAR"),
            ("amount", "BIGINT"),
        ]
    );
    assert_eq!(d.row_count, 3);
    // Title row gone; header is row 1; region col forward-filled ("East").
    assert_eq!(d.sample[0], vec!["1", "North", "100"]);
    assert_eq!(d.sample[1], vec!["2", "East", "200"]);
    assert_eq!(d.sample[2], vec!["3", "East", "300"]);
    assert_eq!(d.rectify, RectifyProvenance::Auto); // auto-tidy: Auto provenance, no user params (ADR-0042)
}

#[test]
fn multi_row_header_requests_guidance() {
    // AC2: two header-like rows above the data -> NeedsGuidance, working set
    // untouched (no silent dirty table).
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("people").expect("name");
    ws.write_string(0, 0, "meta").unwrap();
    ws.write_string(0, 1, "info").unwrap();
    ws.write_string(0, 2, "contact").unwrap();
    ws.write_string(1, 0, "id").unwrap();
    ws.write_string(1, 1, "name").unwrap();
    ws.write_string(1, 2, "email").unwrap();
    ws.write_number(2, 0, 1.0).unwrap();
    ws.write_string(2, 1, "Alice").unwrap();
    ws.write_string(2, 2, "a@x").unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "multi_header.xlsx");

    let mut session = Session::new().expect("session");
    let guidance = match session.ingest(&xlsx) {
        LoadOutcome::NeedsGuidance(g) => g,
        other => panic!("expected NeedsGuidance, got {other:?}"),
    };
    assert_eq!(session.list().len(), 0); // nothing loaded
    assert_eq!(guidance.workbook_name, "multi_header");
    assert_eq!(guidance.sheets.len(), 1);
    assert_eq!(guidance.sheets[0].name, "people");
    // Preview exposes the raw rows so the user can locate the header.
    assert!(guidance.sheets[0].preview.len() >= 3);
}

#[test]
fn guided_load_records_rectify_params() {
    // AC3: the user's guided choices are recorded as rectify params on the
    // descriptor (ADR-0042 explicit user decision).
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("people").expect("name");
    ws.write_string(0, 0, "meta").unwrap();
    ws.write_string(0, 1, "info").unwrap();
    ws.write_string(1, 0, "id").unwrap();
    ws.write_string(1, 1, "name").unwrap();
    ws.write_number(2, 0, 1.0).unwrap();
    ws.write_string(2, 1, "Alice").unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "guided.xlsx");

    let mut session = Session::new().expect("session");
    let guidance = vec![SheetGuidance {
        name: "people".into(),
        rectify: SheetRectify {
            header_row: 2, // row 1 (0-based) is the real header
            skip_rows: vec![],
        },
    }];
    let d = match session.ingest_guided(&xlsx, &guidance) {
        LoadOutcome::Loaded(d) => d,
        other => panic!("expected guided load to succeed, got {other:?}"),
    };
    assert_eq!(
        d.rectify,
        RectifyProvenance::User(SheetRectify {
            header_row: 2,
            skip_rows: vec![]
        })
    );
    assert_eq!(
        column_types(&d),
        vec![("id", "BIGINT"), ("name", "VARCHAR")]
    );
    assert_eq!(d.row_count, 1);
}

#[test]
fn different_rectify_yields_different_fingerprint() {
    // AC4: same sheet, different rectify -> different materialized snapshot ->
    // different fingerprint (rectify participates via post-rectify content hash).
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("people").expect("name");
    ws.write_string(0, 0, "meta").unwrap();
    ws.write_string(0, 1, "info").unwrap();
    ws.write_string(1, 0, "id").unwrap();
    ws.write_string(1, 1, "name").unwrap();
    ws.write_number(2, 0, 1.0).unwrap();
    ws.write_string(2, 1, "Alice").unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "fingerprint.xlsx");

    let fp_a = {
        let mut s = Session::new().expect("session");
        match s.ingest_guided(
            &xlsx,
            &[SheetGuidance {
                name: "people".into(),
                rectify: SheetRectify {
                    header_row: 1,
                    skip_rows: vec![],
                },
            }],
        ) {
            LoadOutcome::Loaded(d) => d.fingerprint,
            other => panic!("expected load, got {other:?}"),
        }
    };
    let fp_b = {
        let mut s = Session::new().expect("session");
        match s.ingest_guided(
            &xlsx,
            &[SheetGuidance {
                name: "people".into(),
                rectify: SheetRectify {
                    header_row: 2,
                    skip_rows: vec![],
                },
            }],
        ) {
            LoadOutcome::Loaded(d) => d.fingerprint,
            other => panic!("expected load, got {other:?}"),
        }
    };
    assert_ne!(fp_a, fp_b);
}

#[test]
fn guided_load_rejects_out_of_range_header_row() {
    // C1: header_row crosses the IPC boundary (guided ingest is a command); an
    // out-of-range value must be rejected at the rectify seam rather than
    // silently yielding a header-less or header-duplicated table that pollutes
    // the working set. Both 0 (violates 1-based) and beyond the last row are
    // rejected, and the working set stays empty (transactional -- AC6/AC7).
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("people").expect("name");
    ws.write_string(0, 0, "id").unwrap();
    ws.write_string(0, 1, "name").unwrap();
    ws.write_number(1, 0, 1.0).unwrap();
    ws.write_string(1, 1, "Alice").unwrap();
    let (xlsx, _dir) = save_xlsx(wb, "oor_header.xlsx");

    for bad_header_row in [0u32, 99] {
        let mut session = Session::new().expect("session");
        let outcome = session.ingest_guided(
            &xlsx,
            &[SheetGuidance {
                name: "people".into(),
                rectify: SheetRectify {
                    header_row: bad_header_row,
                    skip_rows: vec![],
                },
            }],
        );
        match outcome {
            LoadOutcome::Error(LoadError::Parse { detail }) => {
                assert!(
                    detail.contains("越界"),
                    "header_row {bad_header_row}: expected out-of-range error, got: {detail}"
                );
            }
            other => panic!("header_row {bad_header_row}: expected Error, got {other:?}"),
        }
        assert_eq!(session.list().len(), 0); // nothing loaded -- transactional
    }
}

#[test]
fn auto_tidy_reload_is_deterministic() {
    // AC5: reloading the same messy workbook -> identical descriptor.
    let (xlsx, _dir) = messy_xlsx();
    let mut session = Session::new().expect("session");
    let d1 = load_ok(&mut session, &xlsx);
    let d2 = load_ok(&mut session, &xlsx);
    assert_eq!(d2.reference_name, "report_2");
    assert_eq!(d1.columns, d2.columns);
    assert_eq!(d1.row_count, d2.row_count);
    assert_eq!(d1.sample, d2.sample);
    assert_eq!(d1.fingerprint, d2.fingerprint);
}

#[test]
fn legacy_xls_is_rejected_with_hint() {
    // AC6: .xls -> LegacyExcel (actionable "另存为 .xlsx" hint), working set
    // unchanged. dispatch is by extension, so the file need not be a real BIFF8.
    let dir = tempfile::tempdir().expect("tempdir");
    let xls = dir.path().join("legacy.xls");
    fs::write(&xls, b"not a real xls").expect("write");
    let mut session = Session::new().expect("session");
    match session.ingest(&xls) {
        LoadOutcome::Error(LoadError::LegacyExcel) => {}
        other => panic!("expected LegacyExcel, got {other:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

#[test]
fn legacy_xls_with_ole2_signature_is_still_rejected() {
    // AC6 invariant: .xls is rejected by extension before any copy-in, so even a
    // file beginning with the real OLE2/BIFF8 compound-document signature
    // (D0 CF 11 E0 A1 B1 1A E1) is rejected as LegacyExcel. This pins the
    // contract: a future magic-byte sniffer inserted ahead of dispatch can't let
    // a real .xls slip through to the unsupported copy-in path.
    let dir = tempfile::tempdir().expect("tempdir");
    let xls = dir.path().join("real.xls");
    // OLE2 magic + padding; not a parseable workbook, but the signature is
    // exactly what a content sniffer would key on.
    let mut bytes: Vec<u8> = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    bytes.extend_from_slice(&[0u8; 64]);
    fs::write(&xls, &bytes).expect("write");
    let mut session = Session::new().expect("session");
    match session.ingest(&xls) {
        LoadOutcome::Error(LoadError::LegacyExcel) => {}
        other => panic!("expected LegacyExcel, got {other:?}"),
    }
    assert_eq!(session.list().len(), 0);
}

// --- Multi-source naming: display de-conflict + rename (issue #8, slice 4a) -
//
// ADR-0037: every Dataset has a stable reference name (creation-time, used by
// SQL / recipe / active pointer) decoupled from a renamable display label. The
// working set de-conflicts display labels so the UI never shows two identical
// labels, and renaming touches only the label -- no reference is rewritten.

#[test]
fn two_sources_sharing_a_stem_deconflict_both_names() {
    // AC1/AC4: a second source with the same stem coexists in the shared
    // namespace. Reference names de-conflict (`_2`); display labels de-conflict
    // with a human-readable "(2)" so the UI shows distinct labels (ADR-0037).
    let mut session = Session::new().expect("session");
    let d1 = load_ok(&mut session, &fixture("people.csv"));
    let d2 = load_ok(&mut session, &fixture("people.csv"));
    assert_eq!(d1.reference_name, "people");
    assert_eq!(d2.reference_name, "people_2");
    assert_eq!(d1.display_name, "people");
    assert_eq!(d2.display_name, "people (2)");
    // both are independently referenceable by their stable reference names
    assert!(session.get("people").is_some());
    assert!(session.get("people_2").is_some());
}

#[test]
fn renaming_display_label_leaves_reference_name_stable() {
    // AC2/AC3: renaming changes only the display label; the reference name is
    // constant, so every existing reference (and the active pointer, keyed by
    // reference name) stays valid -- nothing is rewritten or propagated.
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("people.csv"));
    assert_eq!(d.reference_name, "people");

    let renamed = session.rename_display("people", "员工表").expect("rename");
    assert_eq!(renamed.reference_name, "people"); // unchanged
    assert_eq!(renamed.display_name, "员工表");

    // still fetched by the unchanged reference name; display updated
    let fetched = session.get("people").expect("still present");
    assert_eq!(fetched.reference_name, "people");
    assert_eq!(fetched.display_name, "员工表");

    // a later source becomes the new active; the renamed one is still reachable
    // by its stable reference name (active pointer is by reference name).
    let _d2 = load_ok(&mut session, &fixture("flat.json"));
    assert_eq!(session.active().unwrap().reference_name, "flat");
    assert!(session.get("people").is_some());
}

#[test]
fn renaming_to_a_taken_display_label_is_rejected() {
    // AC3: display-layer uniqueness holds -- renaming onto another dataset's
    // label is rejected (an explicit rename is rejected, not silently
    // de-conflicted; ADR-0037 allows reject), leaving the working set unchanged.
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv")); // display "people"
    load_ok(&mut session, &fixture("flat.json")); // display "flat"
    let err = session.rename_display("people", "flat").unwrap_err();
    assert_eq!(err, RenameError::DisplayTaken("flat".into()));
    // rejected rename left the label untouched
    assert_eq!(session.get("people").unwrap().display_name, "people");
}

#[test]
fn renaming_unknown_dataset_is_rejected() {
    let mut session = Session::new().expect("session");
    let err = session.rename_display("nope", "X").unwrap_err();
    assert_eq!(err, RenameError::NotFound("nope".into()));
}

#[test]
fn renaming_to_a_blank_label_is_rejected() {
    // A display label must be visible: a whitespace-only answer is rejected at
    // the working set (the authority), leaving the label untouched.
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    let err = session.rename_display("people", "   ").unwrap_err();
    assert_eq!(err, RenameError::InvalidLabel);
    assert_eq!(session.get("people").unwrap().display_name, "people");
}

#[test]
fn xlsx_sheets_deconflict_display_labels_on_reload() {
    // AC4 (Excel): reloading a workbook de-conflicts each sheet's display label
    // against the already-loaded ones, so two loads of the same sheet never show
    // the same label in the UI. Reference names de-conflict in parallel.
    let (xlsx, _dir) = people_xlsx();
    let mut session = Session::new().expect("session");
    let d1 = load_ok(&mut session, &xlsx);
    let d2 = load_ok(&mut session, &xlsx);
    assert_eq!(d1.reference_name, "people");
    assert_eq!(d2.reference_name, "people_2");
    assert_eq!(d1.display_name, "people");
    assert_eq!(d2.display_name, "people (2)");
}

// --- Source replace: re-upload takes over the reference name (issue #11, slice 4b) -
//
// ADR-0042: re-uploading onto a source = swapping its snapshot under the same
// reference name. The new file copy-in's to a fresh snapshot that takes over the
// name; the old snapshot is discarded. Distinct entry from ingest (add): the
// reference name to take over is explicit, and no de-conflicted second entry
// appears. Only structured files (CSV/Parquet/JSON) are supported -- they map
// 1:1 to a single snapshot. This is also the sole fix for a mis-inferred type
// (source snapshots are read-only, ADR-0020). Cascade stale of derived result_N
// is out of scope (#3); these tests assert the takeover + fingerprint only.

fn replace_ok(session: &mut Session, reference_name: &str, path: &Path) -> DatasetDescriptor {
    match session.replace_source(reference_name, path) {
        LoadOutcome::Loaded(d) => d,
        LoadOutcome::NeedsGuidance(g) => {
            panic!("expected replace to succeed, got NeedsGuidance: {g:?}")
        }
        LoadOutcome::Error(e) => panic!("expected replace to succeed, got: {e}"),
    }
}

#[test]
fn replace_takes_over_reference_name_with_new_data() {
    // AC1: re-upload onto a reference name -> the new snapshot takes over; the
    // old one is gone; a query through the name sees the new data. people.csv
    // (5 rows, has a `joined` col) replaced by flat.json (3 rows, no `joined`).
    let mut session = Session::new().expect("session");
    let d1 = load_ok(&mut session, &fixture("people.csv"));
    assert_eq!(d1.reference_name, "people");
    assert_eq!(d1.row_count, 5);
    let old_fp = d1.fingerprint;

    let d2 = replace_ok(&mut session, "people", &fixture("flat.json"));
    assert_eq!(d2.reference_name, "people"); // taken over, not renamed
    assert_eq!(session.list().len(), 1); // not added as a second entry
    assert_eq!(d2.row_count, 3); // new content
    assert_ne!(d2.fingerprint, old_fp); // content changed
                                        // schema changed too: flat.json has no `joined` column
    assert!(d2.columns.iter().all(|c| c.name != "joined"));

    // AC1 (query seam): the reference name now resolves to the new snapshot's
    // rows -- 3, not the original 5.
    assert_eq!(session.snapshot_row_count("people").unwrap(), 3);
}

#[test]
fn replaced_fingerprint_equals_a_fresh_load() {
    // AC2/AC3: the replaced snapshot's fingerprint is the content hash of the
    // post-copy-in snapshot -- identical to a fresh standalone load of the same
    // file, independent of whether it arrived via ingest or replace.
    let fp_fresh = {
        let mut s = Session::new().expect("session");
        load_ok(&mut s, &fixture("flat.json")).fingerprint
    };
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    let d = replace_ok(&mut session, "people", &fixture("flat.json"));
    assert_eq!(d.fingerprint, fp_fresh);
}

#[test]
fn replace_with_same_file_reproduces_fingerprint() {
    // AC3: replacing with the same file -> same fingerprint (deterministic,
    // reproducible). The data doesn't change, so neither does the hash.
    let mut session = Session::new().expect("session");
    let d1 = load_ok(&mut session, &fixture("people.csv"));
    let d2 = replace_ok(&mut session, "people", &fixture("people.csv"));
    assert_eq!(d2.fingerprint, d1.fingerprint);
    assert_eq!(session.snapshot_row_count("people").unwrap(), 5);
}

#[test]
fn replace_fixes_a_mis_loaded_dataset() {
    // AC5: a replace is the sole way to fix a bad load (sources are read-only).
    // Loading flat.json then replacing with people.csv swaps in the richer
    // schema -- the column set of the new file takes effect under the same name.
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("flat.json"));
    assert!(session
        .get("flat")
        .unwrap()
        .columns
        .iter()
        .all(|c| c.name != "joined"));
    let d = replace_ok(&mut session, "flat", &fixture("people.csv"));
    assert!(d.columns.iter().any(|c| c.name == "joined"));
    assert_eq!(d.row_count, 5);
    assert_eq!(d.reference_name, "flat"); // name stable across the swap
}

#[test]
fn replace_carries_display_label_over() {
    // PRD: the display name carries over a replace (a user rename survives).
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    session.rename_display("people", "员工表").expect("rename");
    let d = replace_ok(&mut session, "people", &fixture("flat.json"));
    assert_eq!(d.reference_name, "people");
    assert_eq!(d.display_name, "员工表"); // carried over, not reset
}

#[test]
fn replace_makes_dataset_active() {
    // ADR-0022: a replace is a fresh upload -> active moves to it even when
    // another source was active before.
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    load_ok(&mut session, &fixture("flat.json"));
    assert_eq!(session.active().unwrap().reference_name, "flat");
    replace_ok(&mut session, "people", &fixture("flat.json"));
    assert_eq!(session.active().unwrap().reference_name, "people");
}

#[test]
fn replace_unknown_reference_is_rejected() {
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    match session.replace_source("nope", &fixture("flat.json")) {
        LoadOutcome::Error(_) => {}
        other => panic!("expected Error, got {other:?}"),
    }
    assert_eq!(session.list().len(), 1); // unchanged
    assert_eq!(session.snapshot_row_count("people").unwrap(), 5); // old still queryable
}

#[test]
fn replace_excel_workbook_is_unsupported() {
    // Excel multi-sheet / guided replace semantics are a separate slice; a .xlsx
    // is refused here and the working set is left untouched.
    let (xlsx, _dir) = people_xlsx();
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    match session.replace_source("people", &xlsx) {
        LoadOutcome::Error(_) => {}
        other => panic!("expected Error for xlsx replace, got {other:?}"),
    }
    assert_eq!(session.list().len(), 1);
    assert_eq!(session.snapshot_row_count("people").unwrap(), 5); // old intact
}

#[test]
fn replace_legacy_xls_is_rejected_with_hint() {
    let dir = tempfile::tempdir().expect("tempdir");
    let xls = dir.path().join("legacy.xls");
    fs::write(&xls, b"not a real xls").expect("write");
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    match session.replace_source("people", &xls) {
        LoadOutcome::Error(LoadError::LegacyExcel) => {}
        other => panic!("expected LegacyExcel, got {other:?}"),
    }
    assert_eq!(session.list().len(), 1);
}

#[test]
fn replace_failed_load_leaves_old_snapshot_usable() {
    // Transactional: a failed replace (corrupted new file) leaves the old
    // snapshot intact and queryable under its name; the working set is unchanged.
    let dir = tempfile::tempdir().expect("tempdir");
    let bad = dir.path().join("corrupted.csv");
    fs::write(&bad, [0xffu8, 0xfe, 0x80, 0x81, 0xc0, 0xc1, 0x0a]).expect("write corrupted");
    let mut session = Session::new().expect("session");
    let before = load_ok(&mut session, &fixture("people.csv"));
    match session.replace_source("people", &bad) {
        LoadOutcome::Error(_) => {}
        other => panic!("expected Error for corrupted replace, got {other:?}"),
    }
    assert_eq!(session.list().len(), 1);
    let after = session.get("people").unwrap();
    assert_eq!(after.fingerprint, before.fingerprint); // descriptor unchanged
    assert_eq!(session.snapshot_row_count("people").unwrap(), 5); // old data still there
}

// --- Privacy controls: sample switch + type-only columns (issue #9, slice 5) --
//
// ADR-0011: the user controls what of a source Dataset may leave the local
// trust boundary in the LLM payload -- per-dataset sample switch + per-column
// "type only" (no value, no name). The config rides the descriptor (single
// source of truth) so it persists in the working-set metadata across UI resize
// / active switch / source replace. The actual payload PRUNING happens in the
// query-loop window assembler (PRD #1, cross-PRD contract); these tests assert
// the config is stored, read back, and persisted -- the contract #1 relies on.
// The end-to-end "pruned payload actually left the machine" assertion lives at
// the #1 seam (loading is LLM-free), not here.

#[test]
fn freshly_loaded_dataset_has_default_privacy() {
    // AC1/AC2 default: a just-loaded Dataset ships the ADR-0011 default -- real
    // samples sent, no type-only columns -- so the disclosure UI's starting
    // state matches "samples on, nothing hidden".
    let mut session = Session::new().expect("session");
    let d = load_ok(&mut session, &fixture("people.csv"));
    assert_eq!(d.privacy, DatasetPrivacy::default());
    assert!(d.privacy.send_samples);
    assert!(d.privacy.type_only_columns.is_empty());
}

#[test]
fn turning_off_samples_persists_on_the_dataset() {
    // AC1/AC4: a per-dataset sample switch lands on the descriptor and survives
    // a re-fetch (the config lives in the working set, not transient UI state).
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    let off = DatasetPrivacy {
        send_samples: false,
        type_only_columns: vec![],
    };
    let updated = session.set_privacy("people", off.clone()).expect("set");
    assert!(!updated.privacy.send_samples); // reflected immediately
    assert_eq!(updated.privacy, off);
    // Persists on re-fetch -- the contract #1 reads off the stored descriptor.
    assert_eq!(session.get("people").unwrap().privacy, off);
}

#[test]
fn marking_a_column_type_only_persists_on_the_dataset() {
    // AC2/AC4: a per-column "type only" mark lands on the descriptor and
    // survives a re-fetch. The column NAME rides the config (columns have no
    // separate display name in v1); #1 prunes both the values and the name.
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    let cfg = DatasetPrivacy {
        send_samples: true,
        type_only_columns: vec!["name".into()],
    };
    let updated = session.set_privacy("people", cfg.clone()).expect("set");
    assert_eq!(updated.privacy.type_only_columns, vec!["name"]);
    assert_eq!(session.get("people").unwrap().privacy, cfg);
}

#[test]
fn privacy_config_survives_source_replace() {
    // AC4 (replace): a re-upload onto the same reference name carries the
    // privacy intent over -- the user's sample/type-only decisions are not lost
    // when the underlying snapshot is swapped (the reference name is stable).
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    let cfg = DatasetPrivacy {
        send_samples: false,
        type_only_columns: vec!["name".into()], // people.csv has a `name` column
    };
    session.set_privacy("people", cfg.clone()).expect("set");

    // Replace with flat.json (also has a `name` column) under the same name.
    let d = replace_ok(&mut session, "people", &fixture("flat.json"));
    assert_eq!(d.privacy, cfg); // carried over, not reset to default
    assert!(!d.privacy.send_samples);
    assert_eq!(d.privacy.type_only_columns, vec!["name"]);
}

#[test]
fn type_only_entry_for_a_dropped_column_is_ignored_not_fatal() {
    // ADR-0011 robustness: after a schema-changing replace, a type-only entry
    // for a column that no longer exists is simply ignored at read time -- it
    // must not break the descriptor or the (future) payload assembly. The config
    // is carried verbatim; pruning consults the current column set.
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    // people.csv has `joined`; flat.json does not -- mark `joined` type-only,
    // then replace with flat.json so the column disappears.
    let cfg = DatasetPrivacy {
        send_samples: true,
        type_only_columns: vec!["joined".into()],
    };
    session.set_privacy("people", cfg.clone()).expect("set");
    let d = replace_ok(&mut session, "people", &fixture("flat.json"));
    // The config is carried verbatim (intent preserved); `joined` just no longer
    // matches a column, so the future assembler skips it harmlessly.
    assert_eq!(d.privacy, cfg);
    assert!(d.columns.iter().all(|c| c.name != "joined"));
}

#[test]
fn set_privacy_on_unknown_reference_is_a_noop() {
    // Robustness: setting privacy on a reference name that isn't loaded returns
    // None (the command maps that to an error string) and leaves the working set
    // untouched -- no phantom dataset is created.
    let mut session = Session::new().expect("session");
    load_ok(&mut session, &fixture("people.csv"));
    assert!(session
        .set_privacy("nope", DatasetPrivacy::default())
        .is_none());
    assert_eq!(session.list().len(), 1); // unchanged
}

#[test]
fn setting_privacy_on_one_dataset_does_not_affect_another() {
    // Cross-dataset isolation: privacy config lives on the per-dataset
    // descriptor in a Vec, so setting privacy on A must not leak to B.
    let mut session = Session::new().expect("session");
    let a = load_ok(&mut session, &fixture("people.csv"));
    let b = load_ok(&mut session, &fixture("flat.json"));
    assert_ne!(a.reference_name, b.reference_name);

    let cfg = DatasetPrivacy {
        send_samples: false,
        type_only_columns: vec!["name".into()],
    };
    session.set_privacy(&a.reference_name, cfg).expect("set");

    // A's privacy changed.
    let a_after = session.get(&a.reference_name).unwrap();
    assert!(!a_after.privacy.send_samples);
    assert_eq!(a_after.privacy.type_only_columns, vec!["name"]);

    // B still has the default.
    let b_after = session.get(&b.reference_name).unwrap();
    assert_eq!(b_after.privacy, DatasetPrivacy::default());
}
