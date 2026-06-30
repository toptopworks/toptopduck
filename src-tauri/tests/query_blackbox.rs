//! Black-box query seam (PRD #1 main seam, issues #22/#23): feed a question to
//! a Session wired with a scripted FakeProvider and assert the ADR-0028 outcome
//! -- result / textual / failed (cancelled is #28), the always-visible thread,
//! and that result_N advances only for results. Fully local, deterministic, no
//! network, no real LLM. The fake stands in for the provider (ADR-0007); the
//! orchestrator under test never knows it is not the real Claude client.

use std::path::{Path, PathBuf};

use toptopduck_lib::{
    DatasetPrivacy, DatasetRef, FakeProvider, LoadOutcome, ProviderError, ProviderReply,
    ProviderRequest, ResponsePayload, Session, TextKind, TurnOutcome, TurnPayload,
};

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

fn reply_sql(sql: &str) -> ProviderReply {
    ProviderReply::Sql {
        sql: sql.to_string(),
        viz: None,
        assumption: None,
    }
}

fn reply_text(kind: TextKind, body: &str) -> ProviderReply {
    ProviderReply::Text {
        kind,
        body: body.to_string(),
        assumption: None,
    }
}

/// Build a session whose provider is scripted with the given (question, sql)
/// pairs (one stable SQL reply each). One session per test keeps the script map
/// scoped and deterministic.
fn session_with(scripts: &[(&str, &str)]) -> Session {
    let mut provider = FakeProvider::new();
    for (question, sql) in scripts {
        provider = provider.scripted(question, reply_sql(sql));
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
        other => panic!("expected Materialized, got {other:?}"),
    }
}

/// Unpack a Failed outcome's reason, panicking on any other outcome.
fn failed_reason(outcome: TurnOutcome) -> String {
    match outcome {
        TurnOutcome::Failed { reason } => reason,
        other => panic!("expected Failed, got {other:?}"),
    }
}

#[test]
fn ask_materializes_one_result_with_rows_and_schema() {
    // AC: a question -> provider SQL -> executed -> result_1 materialized with
    // the projected schema + row count. The fake returns a COUNT query, so the
    // result is one row, one BIGINT column.
    let mut session = session_with(&[("总共几行", r#"SELECT COUNT(*) AS n FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));

    let (name, rows, cols) = materialized(session.ask("总共几行"));
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

    let (first, _, _) = materialized(session.ask("数行"));
    assert_eq!(first, "result_1");
    let (second, _, _) = materialized(session.ask("取名"));
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

    session.ask("数行");

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

    session.ask("源计数"); // result_1: 1 row
    let (name, rows, cols) = materialized(session.ask("数结果"));
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
    session.ask("全部id"); // result_1: 5 rows (id 1..5)

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
        ProviderReply::Sql {
            sql: r#"SELECT COUNT(*) AS n FROM "people".data"#.into(),
            viz: None,
            assumption: Some("把 id 当作主键".into()),
        },
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("数行") {
        TurnOutcome::Materialized { assumption, .. } => {
            assert_eq!(assumption.as_deref(), Some("把 id 当作主键"));
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
}

#[test]
fn ask_without_a_wired_provider_fails_honestly() {
    // The default Session (UnwiredProvider) refuses every turn with NotWired --
    // no silent no-op, no invented SQL. NotWired is permanent, so it is NOT
    // retried: the turn fails immediately. The real client wires in #29.
    let mut session = Session::new().expect("session");
    load_source(&mut session, &fixture("people.csv"));
    let reason = failed_reason(session.ask("任何问题"));
    assert!(reason.contains("尚未接入"), "got {reason:?}");
    // nothing materialized
    assert!(session.get("result_1").is_none());
}

#[test]
fn a_persistently_bad_sql_exhausts_the_budget_and_fails() {
    // ADR-0028: a provider SQL the engine rejects is retried up to the single
    // budget; persistent failure yields a failed turn (no result materialized).
    let mut session = session_with(&[("坏查询", r#"SELECT no_such_col FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    let reason = failed_reason(session.ask("坏查询"));
    assert!(reason.contains("执行查询失败"), "got {reason:?}");
    // The budget path prefixes "重试预算耗尽" so it reads distinctly from a
    // permanent NotWired failure (ADR-0028).
    assert!(reason.contains("重试预算耗尽"), "got {reason:?}");
    assert!(session.get("result_1").is_none());
}

#[test]
fn read_rows_on_unknown_reference_is_rejected() {
    let session = session_with(&[]);
    assert!(session.read_rows("nope", 0, 10).is_err());
}

#[test]
fn ask_materializes_a_zero_row_result_normally() {
    // ADR-0030: a SQL that returns 0 rows still materializes a normal result_N
    // (0 rows + projected schema), consumes a number, and is referenceable -- it
    // is never special-cased as "no result".
    let mut session = session_with(&[("没有匹配", r#"SELECT id FROM "people".data WHERE id < 0"#)]);
    load_source(&mut session, &fixture("people.csv"));

    let (name, rows, cols) = materialized(session.ask("没有匹配"));
    assert_eq!(name, "result_1");
    assert_eq!(rows, 0); // a 0-row result materializes normally
    assert_eq!(cols.len(), 1);
    assert_eq!(cols[0].0, "id");
    assert!(session.get("result_1").is_some()); // registered + referenceable

    // The 0-row result reads back as an empty page with the honest total (0).
    let page = session.read_rows("result_1", 0, 100).expect("read");
    assert_eq!(page.rows.len(), 0);
    assert_eq!(page.total, 0);
}

// --- Outcome B: textual (clarify / refuse) -- ADR-0017/0018 ----------------

#[test]
fn a_clarify_question_yields_a_textual_outcome_without_a_result() {
    // ADR-0018: when the provider cannot confidently infer intent it asks back
    // rather than guess. That is a textual outcome -- no SQL runs, no result_N
    // is consumed, but the turn is still recorded (always visible).
    let provider = FakeProvider::new().scripted(
        "哪个名字",
        reply_text(TextKind::Clarify, "按产品名还是客户名汇总？"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("哪个名字") {
        TurnOutcome::Textual {
            text_kind,
            body,
            assumption,
        } => {
            assert_eq!(text_kind, TextKind::Clarify);
            assert_eq!(body, "按产品名还是客户名汇总？");
            assert!(assumption.is_none());
        }
        other => panic!("expected Textual, got {other:?}"),
    }
    assert!(session.get("result_1").is_none()); // no result consumed
}

#[test]
fn a_refuse_question_yields_a_textual_outcome() {
    // ADR-0017: an out-of-scope request is refused honestly (no faked SQL). The
    // refusal is a textual outcome distinct from a clarify.
    let provider = FakeProvider::new().scripted(
        "预测下个月销量",
        reply_text(TextKind::Refuse, "预测/时序建模不在 v1 能力范围内"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("预测下个月销量") {
        TurnOutcome::Textual {
            text_kind, body, ..
        } => {
            assert_eq!(text_kind, TextKind::Refuse);
            assert!(body.contains("不在 v1 能力范围"));
        }
        other => panic!("expected Textual, got {other:?}"),
    }
}

#[test]
fn a_textual_outcome_carries_the_assumption_note() {
    // ADR-0009/0018: the assumption side note rides the textual outcome too
    // (e.g. which interpretation a clarify is resolving).
    let provider = FakeProvider::new().scripted(
        "汇总",
        ProviderReply::Text {
            kind: TextKind::Clarify,
            body: "哪个维度？".into(),
            assumption: Some("当前表有多个可汇总列".into()),
        },
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("汇总") {
        TurnOutcome::Textual { assumption, .. } => {
            assert_eq!(assumption.as_deref(), Some("当前表有多个可汇总列"));
        }
        other => panic!("expected Textual, got {other:?}"),
    }
}

// --- Outcome C: failed -- single retry budget (ADR-0028) -------------------

#[test]
fn retry_recovers_within_the_budget_for_a_contract_violation() {
    // ADR-0028: a malformed contract violation consumes the shared budget and
    // retries. [Err, Err, Ok] -> attempts Err, Err, Ok -> Materialized within
    // the default budget of 2 (3 total attempts). Pinning recovery at the 3rd
    // attempt proves the budget is at least 2 retries.
    let provider = FakeProvider::new().scripted_seq(
        "抖一下",
        vec![
            Err(ProviderError::Unavailable("malformed".into())),
            Err(ProviderError::Unavailable("malformed".into())),
            Ok(reply_sql(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let (name, rows, _) = materialized(session.ask("抖一下"));
    assert_eq!(name, "result_1"); // recovered -> result materialized
    assert_eq!(rows, 1);
}

#[test]
fn retry_exhausts_when_recovery_would_need_a_fourth_attempt() {
    // ADR-0028: the budget is exactly 2 retries (3 attempts). [Err, Err, Err, Ok]
    // -> the three attempts all hit Err; the Ok at index 3 is never reached, so
    // the turn fails. Pinning failure here (against the recovery test above)
    // proves the budget is at most 2 retries.
    let provider = FakeProvider::new().scripted_seq(
        "一直坏",
        vec![
            Err(ProviderError::Unavailable("malformed".into())),
            Err(ProviderError::Unavailable("malformed".into())),
            Err(ProviderError::Unavailable("malformed".into())),
            Ok(reply_sql(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let reason = failed_reason(session.ask("一直坏"));
    assert!(reason.contains("LLM 提供方调用失败"), "got {reason:?}");
    // Budget exhaustion, not a permanent NotWired failure (ADR-0028).
    assert!(reason.contains("重试预算耗尽"), "got {reason:?}");
    assert!(session.get("result_1").is_none()); // never materialized
}

#[test]
fn retry_recovers_when_bad_sql_is_then_fixed() {
    // ADR-0028: a schema/runtime execution error shares the SAME budget as a
    // contract violation. [bad SQL, good SQL] -> attempt 1 fails to execute,
    // attempt 2 materializes. Confirms execution errors enter the single loop.
    let provider = FakeProvider::new().scripted_seq(
        "先错后对",
        vec![
            Ok(reply_sql(r#"SELECT no_such_col FROM "people".data"#)),
            Ok(reply_sql(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let (name, _, _) = materialized(session.ask("先错后对"));
    assert_eq!(name, "result_1"); // second attempt materialized
}

#[test]
fn not_wired_is_not_retried() {
    // NotWired is permanent (no provider configured) -- unlike a contract
    // violation, retrying cannot help. A sequence whose later entries would
    // succeed still fails immediately on the first NotWired.
    let provider = FakeProvider::new().scripted_seq(
        "没接",
        vec![
            Err(ProviderError::NotWired),
            Ok(reply_sql(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let reason = failed_reason(session.ask("没接"));
    assert!(reason.contains("尚未接入"), "got {reason:?}");
    assert!(session.get("result_1").is_none()); // the Ok was never reached
}

// --- Always-visible thread + result_N numbering (ADR-0028/0039) ------------

#[test]
fn non_result_outcomes_do_not_advance_result_numbering() {
    // ADR-0028: only a result advances result_N. A clarify turn occupies a
    // thread slot but consumes no number -- the next result is result_1, not
    // result_2.
    let provider = FakeProvider::new()
        .scripted("先澄清", reply_text(TextKind::Clarify, "哪个维度？"))
        .scripted(
            "再查询",
            reply_sql(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("先澄清") {
        TurnOutcome::Textual { .. } => {}
        other => panic!("expected Textual, got {other:?}"),
    }
    let (name, _, _) = materialized(session.ask("再查询"));
    assert_eq!(name, "result_1"); // textual did not advance the counter
}

#[test]
fn every_turn_is_recorded_in_the_conversation_thread_in_order() {
    // ADR-0028/0039: every turn -- result, textual, failed alike -- is always
    // visible in the thread, in order, labeled by the verbatim question.
    let provider = FakeProvider::new()
        .scripted(
            "查行数",
            reply_sql(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted("哪个名字", reply_text(TextKind::Clarify, "哪个维度？"))
        .scripted_seq(
            "坏查询",
            vec![Ok(reply_sql(r#"SELECT no_such_col FROM "people".data"#))],
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    session.ask("查行数");
    session.ask("哪个名字");
    session.ask("坏查询");

    let thread = session.conversation();
    assert_eq!(thread.len(), 3, "every turn occupies a thread slot");
    // Each entry is labeled by its verbatim question (ADR-0039).
    assert_eq!(thread[0].question, "查行数");
    assert!(matches!(
        thread[0].outcome,
        TurnOutcome::Materialized { .. }
    ));
    assert_eq!(thread[1].question, "哪个名字");
    assert!(matches!(
        thread[1].outcome,
        TurnOutcome::Textual {
            text_kind: TextKind::Clarify,
            ..
        }
    ));
    assert_eq!(thread[2].question, "坏查询");
    assert!(matches!(thread[2].outcome, TurnOutcome::Failed { .. }));
}

#[test]
fn budget_exhaustion_keeps_each_distinct_failure() {
    // ADR-0028 (honest failure): when the retry budget exhausts through a mix
    // of distinct failures, the failed turn surfaces every distinct one, not
    // just the last. Without this, a SQL execution error (the actionable kind)
    // would be silently overwritten by a later transient Unavailable. The
    // consecutive duplicate Unavailable is deduped so it isn't repeated.
    let provider = FakeProvider::new().scripted_seq(
        "又错又抖",
        vec![
            // attempt 1: a SQL the engine rejects
            Ok(reply_sql(r#"SELECT no_such_col FROM "people".data"#)),
            // attempts 2-3: a transient contract violation (consecutive dup)
            Err(ProviderError::Unavailable("malformed".into())),
            Err(ProviderError::Unavailable("malformed".into())),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let reason = failed_reason(session.ask("又错又抖"));
    // The SQL error survives -- not overwritten by the later Unavailable.
    assert!(reason.contains("执行查询失败"), "got {reason:?}");
    // The transient failure is also present, distinct from the SQL error.
    assert!(reason.contains("LLM 提供方调用失败"), "got {reason:?}");
    assert!(reason.contains("重试预算耗尽"), "got {reason:?}");
    assert!(session.get("result_1").is_none());
}

// --- Window assembly + privacy payload wiring (issue #24) -------------------
//
// The window assembler is observed purely through the assembled payload the fake
// provider receives -- the highest seam (PRD testing philosophy: assert the
// payload shape, never prompt-string assembly details). The fake captures every
// request; the last entry is the turn under inspection.

/// Borrow a dataset's payload entry by reference name, panicking if absent.
fn dataset_in<'a>(payload: &'a ProviderRequest, name: &str) -> &'a DatasetRef {
    payload
        .datasets
        .iter()
        .find(|d| d.reference_name == name)
        .unwrap_or_else(|| panic!("payload missing dataset {name}"))
}

#[test]
fn window_assembler_windows_history_and_samples_via_fake_provider() {
    // AC #24: drive N>20 turns through the real loop, then capture the assembled
    // payload at the fake provider and assert the window/summary/sample shape.
    let mut provider = FakeProvider::new();
    for k in 1..=21u8 {
        provider = provider.scripted(&format!("turn {k}"), reply_sql("SELECT 1 AS n"));
    }
    provider = provider.scripted("probe", reply_sql("SELECT 1 AS n"));
    let captured = provider.captured();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    for k in 1..=21u8 {
        let name = materialized(session.ask(&format!("turn {k}"))).0;
        assert_eq!(name, format!("result_{k}"));
    }
    session.ask("probe");

    let buf = captured.lock().expect("capture lock");
    let payload = buf.last().expect("probe request captured");
    assert_eq!(payload.question, "probe");

    // 21 prior turns: the oldest (turn 1 -> result_1) falls out of the N=20
    // window and becomes a verbatim summary; the recent 20 stay full.
    assert_eq!(payload.history.len(), 21);
    assert_eq!(
        payload
            .history
            .iter()
            .filter(|t| matches!(t, TurnPayload::Summary { .. }))
            .count(),
        1
    );
    assert_eq!(
        payload
            .history
            .iter()
            .filter(|t| matches!(t, TurnPayload::Full { .. }))
            .count(),
        20
    );
    match &payload.history[0] {
        TurnPayload::Summary {
            question_excerpt,
            result,
        } => {
            assert_eq!(question_excerpt, "turn 1"); // short -> verbatim, no truncation
            assert_eq!(result.as_deref(), Some("result_1")); // retargetable by name
        }
        other => panic!("oldest turn should be Summary, got {other:?}"),
    }

    // Source always ships full schema + samples (ADR-0023); out-of-window
    // result_1 ships no sample, in-window results do (ADR-0026).
    let people = dataset_in(payload, "people");
    assert_eq!(people.columns.len(), 5); // id,name,joined,active,score
    assert!(people.sample.is_some());
    assert_eq!(dataset_in(payload, "result_1").sample, None); // turn 1 is far
    assert!(dataset_in(payload, "result_2").sample.is_some()); // in-window
    assert!(dataset_in(payload, "result_21").sample.is_some()); // most recent

    // ADR-0023 point 1: a recent materialized turn ships its verbatim SQL so the
    // provider sees its own prior SQL. The most recent turn (turn 21) is Full;
    // its response carries the exact SQL the fake replied with.
    match &payload.history[20] {
        TurnPayload::Full { response, .. } => match response {
            ResponsePayload::Materialized { sql, .. } => {
                assert_eq!(sql.as_deref(), Some("SELECT 1 AS n"));
            }
            other => panic!("expected Materialized response, got {other:?}"),
        },
        other => panic!("recent turn should be Full, got {other:?}"),
    }
}

#[test]
fn privacy_samples_off_withholds_a_sources_cells() {
    // AC #24: DatasetPrivacy.send_samples=false prunes every sample cell of that
    // dataset from the payload (ADR-0011) -- the controls now "take effect" on
    // what is actually sent, not just stored.
    let provider = FakeProvider::new().scripted("q", reply_sql("SELECT 1 AS n"));
    let captured = provider.captured();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    session.set_privacy(
        "people",
        DatasetPrivacy {
            send_samples: false,
            type_only_columns: vec![],
        },
    );

    session.ask("q");
    let buf = captured.lock().expect("lock");
    let payload = buf.last().expect("captured");
    let people = dataset_in(payload, "people");
    assert_eq!(people.sample, None); // no cells ship
                                     // schema still full -- only values are withheld.
    assert_eq!(people.columns.len(), 5);
    assert!(people.columns.iter().all(|c| c.name.is_some()));
}

#[test]
fn privacy_type_only_column_hides_name_and_values() {
    // AC #24: a type-only column ships its type but neither its name nor any
    // sample value (ADR-0011). The "name" column of people.csv is VARCHAR.
    let provider = FakeProvider::new().scripted("q", reply_sql("SELECT 1 AS n"));
    let captured = provider.captured();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    session.set_privacy(
        "people",
        DatasetPrivacy {
            send_samples: true,
            type_only_columns: vec!["name".into()],
        },
    );

    session.ask("q");
    let buf = captured.lock().expect("lock");
    let payload = buf.last().expect("captured");
    let people = dataset_in(payload, "people");
    // Exactly one column is name-redacted, and it is the VARCHAR "name" column.
    let redacted: Vec<_> = people.columns.iter().filter(|c| c.name.is_none()).collect();
    assert_eq!(redacted.len(), 1);
    assert_eq!(redacted[0].canonical_type, "VARCHAR");
    // Sample cells: id ships, name (index 1) withheld at its position.
    let row = people.sample.as_ref().unwrap().first().unwrap();
    assert_eq!(row[0], Some("1".to_string())); // id
    assert_eq!(row[1], None); // name -- type-only, value withheld
}
