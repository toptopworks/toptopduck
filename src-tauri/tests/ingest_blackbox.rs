//! Black-box ingest seam (PRD #2 main seam): feed fixture files to `Session` and
//! assert the produced Dataset descriptor + behavior. Fully local, deterministic,
//! no network, no LLM. Never asserts copy-in SQL internals.

use std::fs;
use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Formula, Workbook};
use toptopduck_lib::{
    DatasetDescriptor, LoadError, LoadOutcome, Session, SheetGuidance, SheetRectify,
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
    assert_eq!(d.rectify, None); // auto-tidy records no user params (ADR-0042)
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
        Some(SheetRectify {
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
