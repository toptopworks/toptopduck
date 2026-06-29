//! Black-box query seam (PRD #1 main seam, issue #22): feed a question to a
//! Session wired with a scripted FakeProvider and assert the materialized
//! result_N -- its rows, schema, monotonic numbering, and that the source is
//! untouched. Fully local, deterministic, no network, no real LLM. The fake
//! stands in for the provider (ADR-0007); the orchestrator under test never
//! knows it is not the real Claude client.

use std::path::{Path, PathBuf};

use toptopduck_lib::{FakeProvider, LoadOutcome, ProviderReply, Session, TurnOutcome};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn fixture(name: &str) -> PathBuf {
    fixtures_dir().join(name)
}

fn load_source(session: &mut Session, path: &Path) {
    match session.ingest(path) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected source to load, got {other:?}"),
    }
}

fn reply(sql: &str) -> ProviderReply {
    ProviderReply {
        sql: sql.to_string(),
        viz: None,
        assumption: None,
    }
}

/// Build a session whose provider is scripted with the given (question, sql)
/// pairs. One session per test keeps the script map scoped and deterministic.
fn session_with(scripts: &[(&str, &str)]) -> Session {
    let mut provider = FakeProvider::new();
    for (question, sql) in scripts {
        provider = provider.scripted(question, reply(sql));
    }
    Session::with_provider(Box::new(provider)).expect("session")
}

/// Unpack a Materialized outcome into (reference_name, row_count, columns).
fn materialized(outcome: TurnOutcome) -> (String, u64, Vec<(String, String)>) {
    match outcome {
        TurnOutcome::Materialized { dataset, .. } => {
            let cols = dataset
                .columns
                .iter()
                .map(|c| (c.name.clone(), c.canonical_type.clone()))
                .collect();
            (dataset.reference_name, dataset.row_count, cols)
        }
    }
}

#[test]
fn ask_materializes_one_result_with_rows_and_schema() {
    // AC: a question -> provider SQL -> executed -> result_1 materialized with
    // the projected schema + row count. The fake returns a COUNT query, so the
    // result is one row, one BIGINT column.
    let mut session = session_with(&[("总共几行", r#"SELECT COUNT(*) AS n FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));

    let (name, rows, cols) = materialized(session.ask("总共几行").expect("ask"));
    assert_eq!(name, "result_1");
    assert_eq!(rows, 1);
    assert_eq!(cols, vec![("n".to_string(), "BIGINT".to_string())]);
    // registered in the working set -- a Dataset like any source.
    assert!(session.get("result_1").is_some());
}

#[test]
fn result_number_is_monotonic_across_turns() {
    // AC: result_N is max+1, never reused -- the second turn is result_2.
    let mut session = session_with(&[
        ("数行", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("取名", r#"SELECT name FROM "people".data LIMIT 1"#),
    ]);
    load_source(&mut session, &fixture("people.csv"));

    let (first, _, _) = materialized(session.ask("数行").expect("ask1"));
    assert_eq!(first, "result_1");
    let (second, _, _) = materialized(session.ask("取名").expect("ask2"));
    assert_eq!(second, "result_2");
}

#[test]
fn asking_never_mutates_the_source() {
    // AC: the source Dataset is read-only (ADR-0004/0012) -- a turn reads it,
    // never writes. The row count and every cell survive a turn unchanged.
    let mut session = session_with(&[("数行", r#"SELECT COUNT(*) AS n FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    let before = session
        .read_rows("people", 0, 100)
        .expect("read source before");

    session.ask("数行").expect("ask");

    let after = session
        .read_rows("people", 0, 100)
        .expect("read source after");
    assert_eq!(before.rows, after.rows);
    assert_eq!(session.snapshot_row_count("people").unwrap(), 5);
}

#[test]
fn result_is_referenceable_in_a_later_turn() {
    // ADR-0003 chaining: a later turn can FROM result_1 (a main-DB physical
    // table, referenced bare -- distinct from a source "<ref>".data form).
    let mut session = session_with(&[
        ("源计数", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("数结果", "SELECT COUNT(*) AS m FROM result_1"),
    ]);
    load_source(&mut session, &fixture("people.csv"));

    session.ask("源计数").expect("ask1"); // result_1: 1 row
    let (name, rows, cols) = materialized(session.ask("数结果").expect("ask2"));
    assert_eq!(name, "result_2");
    assert_eq!(rows, 1); // result_1 had exactly 1 row
    assert_eq!(cols, vec![("m".to_string(), "BIGINT".to_string())]);
}

#[test]
fn read_rows_pages_a_materialized_result() {
    // ADR-0024 windowed display: the result is a full physical table; read_rows
    // returns a bounded page plus the honest total (ADR-0030 truncation
    // disclosure).
    let mut session = session_with(&[("全部id", r#"SELECT id FROM "people".data ORDER BY id"#)]);
    load_source(&mut session, &fixture("people.csv"));
    session.ask("全部id").expect("ask"); // result_1: 5 rows (id 1..5)

    let page1 = session.read_rows("result_1", 0, 3).expect("page1");
    assert_eq!(page1.total, 5);
    assert_eq!(page1.rows.len(), 3);
    assert_eq!(page1.rows[0], vec!["1".to_string()]);
    assert_eq!(page1.rows[2], vec!["3".to_string()]);

    let page2 = session.read_rows("result_1", 3, 3).expect("page2");
    assert_eq!(page2.rows.len(), 2); // rows 4, 5
    assert_eq!(page2.rows[0], vec!["4".to_string()]);
}

#[test]
fn ask_surfaces_the_provider_assumption_note() {
    // ADR-0009: the optional assumption note rides the outcome, so the UI can
    // render it as a correctable side note.
    let provider = FakeProvider::new().scripted(
        "数行",
        ProviderReply {
            sql: r#"SELECT COUNT(*) AS n FROM "people".data"#.into(),
            viz: None,
            assumption: Some("把 id 当作主键".into()),
        },
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("数行").expect("ask") {
        TurnOutcome::Materialized { assumption, .. } => {
            assert_eq!(assumption.as_deref(), Some("把 id 当作主键"));
        }
    }
}

#[test]
fn ask_without_a_wired_provider_fails_honestly() {
    // The default Session (UnwiredProvider) refuses every turn with NotWired --
    // no silent no-op, no invented SQL. The real client wires in #29.
    let mut session = Session::new().expect("session");
    load_source(&mut session, &fixture("people.csv"));
    let err = session.ask("任何问题").unwrap_err();
    assert!(err.to_string().contains("尚未接入"));
    // nothing materialized
    assert!(session.get("result_1").is_none());
}

#[test]
fn a_bad_sql_surfaces_as_an_execute_error() {
    // A provider SQL the engine rejects (unknown column) -> Execute error, no
    // result materialized. The single-query retry budget arrives in #23.
    let mut session = session_with(&[("坏查询", r#"SELECT no_such_col FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    let err = session.ask("坏查询").unwrap_err();
    assert!(err.to_string().contains("执行查询失败"));
    assert!(session.get("result_1").is_none());
}

#[test]
fn read_rows_on_unknown_reference_is_rejected() {
    let session = session_with(&[]);
    assert!(session.read_rows("nope", 0, 10).is_err());
}
