//! Black-box ingest seam (PRD #2 main seam): feed fixture files to `Session` and
//! assert the produced Dataset descriptor + behavior. Fully local, deterministic,
//! no network, no LLM. Never asserts copy-in SQL internals.

use std::fs;
use std::path::{Path, PathBuf};

use toptopduck_lib::{DatasetDescriptor, LoadError, LoadOutcome, Session};

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
    // Slice 1 is CSV only; .xlsx is rejected with the working set unchanged.
    let mut session = Session::new().expect("session");
    match session.ingest(&fixture("unsupported.xlsx")) {
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
