//! Black-box query seam (PRD #1 main seam): feed a question to a Session wired
//! with a scripted FakeProvider and assert the ADR-0028 outcome -- result /
//! textual / failed / cancelled -- the always-visible thread, and that result_N
//! advances only for promotions. The turn contract is the native tool-calling
//! agent loop (ADR-0077/0081, issue #318): the scripted model emits
//! explore / materialize tool calls plus a terminal text answer, and the loop
//! dispatches the calls against the real engine. Tool-level errors route back
//! to the model for self-correction (blind retry is abolished); only a
//! non-converging trajectory exhausts the execution caps. Fully local,
//! deterministic, no network, no real LLM -- the fake stands in for the
//! provider (ADR-0007); the loop under test never knows it is not a real model.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::json;
use toptopduck_lib::provider::tool_calling::{
    ToolTurnMessage, ToolTurnReply, ToolTurnRequest, ToolUse,
};
use toptopduck_lib::{
    ActiveResolution, ApprovalRequestBody, ApprovalResponse, ApprovalSink, ApprovalState,
    CancelToken, DatasetPrivacy, FakeProvider, KeychainStore, LoadOutcome, OperationKind,
    ProviderError, ResumeEvent, ResumeProgress, Session, SourceResolution, TextKind, ThreadEntry,
    TraceEntryView, TurnFailure, TurnOutcome, TurnPhase, TurnProgress, TurnRecord,
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

/// A materialize tool call promoting `sql` -- one round-trip's reply. The
/// tool-calling contract's equivalent of the retired single-shot SQL reply.
fn materialize(sql: &str) -> ToolTurnReply {
    ToolTurnReply::ToolCalls(vec![ToolUse {
        id: "tu_1".into(),
        name: "materialize".into(),
        input: json!({ "sql": sql }),
    }])
}

/// An explore tool call -- a scratch query that never promotes.
fn explore(sql: &str) -> ToolTurnReply {
    ToolTurnReply::ToolCalls(vec![ToolUse {
        id: "tu_1".into(),
        name: "explore".into(),
        input: json!({ "sql": sql }),
    }])
}

/// A terminal text answer ending the turn.
fn answer(text: &str) -> ToolTurnReply {
    ToolTurnReply::Text(text.to_string())
}

/// Script a question as one materialize call promoting `sql` plus a terminal
/// text answer -- the standard productive-turn trajectory.
fn productive(sql: &str) -> Vec<Result<ToolTurnReply, ProviderError>> {
    vec![Ok(materialize(sql)), Ok(answer("完成"))]
}

/// Build a session whose provider is scripted so each question runs one
/// materialize call promoting `sql`, then terminates with a text answer. One
/// session per test keeps the script map scoped and deterministic.
fn session_with(scripts: &[(&str, &str)]) -> Session {
    let mut provider = FakeProvider::new();
    for (question, sql) in scripts {
        provider = provider.scripted_tool_turn_seq(question, productive(sql));
    }
    Session::with_provider(Box::new(provider)).expect("session")
}

/// Unpack a Materialized outcome's PRIMARY promotion (the chain tail,
/// ADR-0084) into (reference_name, row_count, columns). Single-result turns
/// carry a one-element chain, so this reads exactly the result they produced.
fn materialized(outcome: TurnOutcome) -> (String, u64, Vec<(String, String)>) {
    match outcome.primary_promotion() {
        Some(primary) => {
            let cols = primary
                .dataset
                .columns
                .iter()
                .map(|c| (c.name.clone(), c.canonical_type.clone()))
                .collect();
            (
                primary.dataset.reference_name.clone(),
                primary.dataset.row_count,
                cols,
            )
        }
        None => panic!("expected Materialized, got {outcome:?}"),
    }
}

/// Unpack a Failed outcome's typed failure, panicking on any other outcome.
fn failed_failure(outcome: TurnOutcome) -> TurnFailure {
    match outcome {
        TurnOutcome::Failed(failure) => failure,
        other => panic!("expected Failed, got {other:?}"),
    }
}

/// The turn-only view of the conversation timeline (ADR-0040): source lifecycle
/// events share the timeline (an ingest appends an `Added` event), so tests
/// asserting on turns filter them out here. Clones so `thread[i].question` /
/// `.outcome` access keeps the same shape it had when conversation() returned
/// `&[TurnRecord]` -- the assertions stay readable.
fn turns(entries: &[ThreadEntry]) -> Vec<TurnRecord> {
    entries
        .iter()
        .filter_map(|e| match e {
            ThreadEntry::Turn(t) => Some(t.clone()),
            ThreadEntry::Source(_) | ThreadEntry::Skill(_) => None,
        })
        .collect()
}

/// The captured tool-turn request a question's turn assembled FIRST (the fake
/// records one capture per round-trip; the first carries the turn's windowed
/// context -- the schema snapshot + window the window assembler built for it).
/// The first round-trip's request ends with the asking question and carries
/// no fed-back tool results yet; later round-trips append ToolResult turns.
fn request_for<'a>(buf: &'a [ToolTurnRequest], question: &str) -> &'a ToolTurnRequest {
    buf.iter()
        .find(|r| {
            let ends_with_question =
                matches!(r.messages.last(), Some(ToolTurnMessage::User { content }) if content == question);
            let first_round = !r
                .messages
                .iter()
                .any(|m| matches!(m, ToolTurnMessage::ToolResult { .. }));
            ends_with_question && first_round
        })
        .unwrap_or_else(|| panic!("no captured first-round request for {question}"))
}

/// The rendered schema-context block of one dataset inside a system prompt:
/// the span from its `引用名 = <name>` line to the next dataset's (or the
/// prompt's end). Lets a test assert per-dataset sample / privacy rendering
/// without parsing the whole prompt structurally.
fn dataset_block<'a>(system: &'a str, name: &str) -> &'a str {
    let marker = format!("引用名 = {name}\n");
    let start = system
        .find(&marker)
        .unwrap_or_else(|| panic!("system prompt missing dataset {name}"));
    let rest = &system[start..];
    let end = rest[marker.len()..]
        .find("引用名 = ")
        .map(|i| i + marker.len())
        .unwrap_or(rest.len());
    &rest[..end]
}

/// A no-op approval sink for the ask_with_phase tests: built-in tools classify
/// Allow at the gateway without emitting, so its methods are unreachable.
struct NullSink;
impl ApprovalSink for NullSink {
    fn emit_request(&self, _body: &ApprovalRequestBody) {}
    fn emit_resolved(&self, _body: &ApprovalRequestBody, _response: ApprovalResponse) {}
}

#[test]
fn ask_materializes_one_result_with_rows_and_schema() {
    // AC: a question -> a materialize tool call -> executed -> result_1
    // promoted with the projected schema + row count. The scripted model
    // issues a COUNT query, so the result is one row, one BIGINT column.
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
fn ask_surfaces_the_terminal_answer_as_the_assumption_note() {
    // The tool-calling contract carries no separate assumption field (the
    // single-SQL JSON contract did): the model's terminal text answer rides
    // the Materialized outcome's assumption when the turn also promoted, so
    // the UI still renders it as a correctable side note.
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "数行",
        vec![
            Ok(materialize(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
            Ok(answer("把 id 当作主键")),
        ],
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
fn multiple_promotions_in_one_turn_land_materialized_with_the_last_as_primary() {
    // AC #318: one question may promote several results in a single turn; the
    // outcome is Materialized carrying the FULL promotion chain in promotion
    // order (ADR-0084), numbering is monotonic (ADR-0022), and the LAST
    // promotion is the turn's primary result (a later materialize supersedes
    // earlier ones as the analysis focus) -- its SQL rides the chain tail.
    // EVERY promotion registers in the working set.
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "两步晋升",
        vec![
            Ok(materialize(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
            Ok(materialize("SELECT MAX(n) AS m FROM result_1")),
            Ok(answer("完成")),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("两步晋升") {
        TurnOutcome::Materialized { promotions, .. } => {
            assert_eq!(
                promotions.len(),
                2,
                "the outcome carries BOTH promotions in promotion order"
            );
            assert_eq!(
                promotions[0].dataset.reference_name, "result_1",
                "the first promotion is the chain head"
            );
            assert_eq!(
                promotions[1].dataset.reference_name, "result_2",
                "the last promotion is the primary result"
            );
            assert!(
                promotions[1].sql.contains("MAX(n)"),
                "the primary promotion's SQL rides the chain tail: {}",
                promotions[1].sql
            );
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
    // Both promotions registered: result_1 AND result_2.
    assert!(session.get("result_1").is_some(), "first promotion kept");
    assert!(session.get("result_2").is_some(), "second promotion kept");
}

#[test]
fn a_multi_promotion_turn_persists_every_result_into_the_recipe_chain() {
    // C1 (ADR-0084): the recipe must capture the FULL promotion chain, not just
    // the primary -- so resume replays every result_N. A turn that promotes
    // result_1 then result_2 (derived FROM result_1) yields a productive chain
    // carrying BOTH in promotion order; dropping result_1 would break the
    // chained replay, since result_2's SQL references result_1.
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "两步晋升",
        vec![
            Ok(materialize(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
            Ok(materialize("SELECT MAX(n) AS m FROM result_1")),
            Ok(answer("完成")),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    session.ask("两步晋升");

    let chain = session.build_recipe().productive_chain();
    let names: Vec<&str> = chain.iter().map(|t| t.reference_name.as_str()).collect();
    assert_eq!(
        names,
        vec!["result_1", "result_2"],
        "the recipe's productive chain carries EVERY promotion in order, so resume replays the full chain"
    );
    assert!(
        chain[1].sql.contains("MAX(n)"),
        "the primary's SQL rides the chain tail: {}",
        chain[1].sql
    );
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

// --- Materialized turns are plain-table turns (ADR-0077) -------------------
//
// The tool-calling contract carries no viz intent (the single-SQL JSON
// contract's `viz` field is retired with it, ADR-0009 superseded): a
// Materialized turn is always a plain table. The TurnOutcome still carries the
// field (serde + frontend compatibility); the live path sets None.

#[test]
fn a_materialized_turn_is_always_a_plain_table_turn() {
    let mut session = session_with(&[("总数", r#"SELECT COUNT(*) AS n FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    match session.ask("总数") {
        TurnOutcome::Materialized { viz, .. } => assert!(viz.is_none()),
        other => panic!("expected Materialized, got {other:?}"),
    }
}

// --- Outcome B: textual (agent answer / boundary refusal) -- ADR-0079 ------

#[test]
fn a_plain_text_answer_yields_a_textual_outcome_without_a_result() {
    // ADR-0077/0081: a turn that ends in the model's terminal text without any
    // promotion is a textual outcome. The tool-calling contract carries no
    // clarify/refuse marker, so every terminal text rides TextKind::Agent --
    // here, a clarification question. No SQL runs, no result_N is consumed,
    // but the turn is still recorded (always visible).
    let provider =
        FakeProvider::new().scripted_tool_turn("哪个名字", answer("按产品名还是客户名汇总？"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("哪个名字") {
        TurnOutcome::Textual {
            text_kind,
            body,
            assumption,
        } => {
            assert_eq!(text_kind, TextKind::Agent);
            assert_eq!(body, "按产品名还是客户名汇总？");
            assert!(assumption.is_none());
        }
        other => panic!("expected Textual, got {other:?}"),
    }
    assert!(session.get("result_1").is_none()); // no result consumed
}

#[test]
fn a_boundary_refusal_rides_a_textual_outcome() {
    // ADR-0079: the default skill set preserves the ADR-0017 boundary as
    // prompt-driven behavior -- an out-of-scope request is refused honestly by
    // the model's terminal text (no faked tool calls), riding a Textual
    // outcome of the Agent kind (the contract has no structural refuse marker).
    let provider = FakeProvider::new().scripted_tool_turn(
        "预测下个月销量",
        answer("预测/时序建模不在 v1 能力范围内，可按季度汇总历史销量看趋势"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    match session.ask("预测下个月销量") {
        TurnOutcome::Textual {
            text_kind, body, ..
        } => {
            assert_eq!(text_kind, TextKind::Agent);
            assert!(body.contains("不在 v1 能力范围"));
        }
        other => panic!("expected Textual, got {other:?}"),
    }
}

// --- Outcome C: failed -- self-correction + execution caps (ADR-0077/0081) -

#[test]
fn tool_error_routes_back_for_self_correction_and_recovers() {
    // ADR-0077: a tool-level SQL error (bad column) routes back to the model,
    // which rewrites the SQL and succeeds. Blind retry is abolished -- the
    // AGENT drives the correction (second call), not a hidden retry loop.
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "先错后对",
        vec![
            Ok(materialize(r#"SELECT no_such_col FROM "people".data"#)),
            Ok(materialize(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
            Ok(answer("改对了")),
        ],
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let (name, _, _) = materialized(session.ask("先错后对"));
    assert_eq!(name, "result_1"); // the corrected call promoted
}

#[test]
fn a_transient_provider_fault_fails_the_turn_without_retry() {
    // ADR-0077/0081: a transient provider fault surfaced after the adapter's
    // own HTTP retry is an honest turn failure -- NOT blindly retried by the
    // loop and NOT fed to the model (transport errors never reach the agent).
    // One round-trip, an Execute failure carrying the transport detail.
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "抖一下",
        vec![Err(ProviderError::Unavailable("connection reset".into()))],
    );
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let detail = match failed_failure(session.ask("抖一下")) {
        TurnFailure::Execute { detail } => detail,
        other => panic!("expected Execute, got {other:?}"),
    };
    assert!(detail.contains("connection reset"), "got {detail:?}");
    assert_eq!(
        captured.lock().expect("capture lock").len(),
        1,
        "no blind retry -- exactly one round-trip"
    );
    assert!(session.get("result_1").is_none());
}

#[test]
fn step_cap_exhaustion_lands_a_failed_turn() {
    // ADR-0081 execution-level safety net: an agent that never converges
    // (keeps exploring) is aborted by the step cap (default 24) as a Failed
    // turn carrying an honest non-convergence detail. The wall-clock watchdog
    // (Cancelled) shares the cancel path; its deterministic coverage lives at
    // the agent-loop unit seam (the 120s default is not tunable through the
    // Session facade).
    let provider = FakeProvider::new().scripted_tool_turn("不收敛", explore("SELECT 1"));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let detail = match failed_failure(session.ask("不收敛")) {
        TurnFailure::Execute { detail } => detail,
        other => panic!("expected Execute, got {other:?}"),
    };
    assert!(detail.contains("did not converge"), "got {detail:?}");
    assert_eq!(
        captured.lock().expect("capture lock").len(),
        24, // ADR-0081 DEFAULT_STEP_CAP
        "ran exactly the step-cap round-trips"
    );
    assert!(session.get("result_1").is_none());
}

// --- Always-visible thread + result_N numbering (ADR-0028/0039) ------------

#[test]
fn non_result_outcomes_do_not_advance_result_numbering() {
    // ADR-0028: only a promotion advances result_N. A textual turn occupies a
    // thread slot but consumes no number -- the next result is result_1, not
    // result_2.
    let provider = FakeProvider::new()
        .scripted_tool_turn("先澄清", answer("哪个维度？"))
        .scripted_tool_turn_seq(
            "再查询",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
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
        .scripted_tool_turn_seq(
            "查行数",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted_tool_turn("哪个名字", answer("哪个维度？"))
        // A non-self-correcting failing call: clamped, re-issued every
        // round-trip until the step cap fails the turn.
        .scripted_tool_turn(
            "坏查询",
            materialize(r#"SELECT no_such_col FROM "people".data"#),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    session.ask("查行数");
    session.ask("哪个名字");
    session.ask("坏查询");

    let thread = turns(session.conversation());
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
            text_kind: TextKind::Agent,
            ..
        }
    ));
    assert_eq!(thread[2].question, "坏查询");
    assert!(matches!(thread[2].outcome, TurnOutcome::Failed { .. }));
}

// --- Window assembly + privacy payload wiring (issue #24) -------------------
//
// The window assembler is observed through the assembled tool-turn request the
// fake provider captures -- the highest seam (PRD testing philosophy: assert
// the payload shape). The windowed context rides the system prompt's schema
// block (datasets + samples + active pointer) and the message array (history
// turns + the asking question); the tool table advertises the four built-ins.

#[test]
fn window_assembler_windows_history_and_samples_via_fake_provider() {
    // AC #24: drive N>20 turns through the real loop, then capture the
    // assembled tool-turn request at the fake provider and assert the
    // window/summary/sample shape on the system prompt + messages.
    let mut provider = FakeProvider::new();
    for k in 1..=21u8 {
        provider =
            provider.scripted_tool_turn_seq(&format!("turn {k}"), productive("SELECT 1 AS n"));
    }
    provider = provider.scripted_tool_turn_seq("probe", productive("SELECT 1 AS n"));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    for k in 1..=21u8 {
        let name = materialized(session.ask(&format!("turn {k}"))).0;
        assert_eq!(name, format!("result_{k}"));
    }
    session.ask("probe");

    let buf = captured.lock().expect("capture lock");
    let payload = request_for(&buf, "probe");

    // The built-in tool table (ADR-0076) is advertised every turn.
    let tool_names: Vec<&str> = payload.tools.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(
        tool_names,
        vec!["explore", "materialize", "describe", "sample"]
    );

    // 21 prior turns + the asking question: each prior turn ships a user
    // message + an assistant message (its rendered prior response); the asking
    // question closes the array.
    assert_eq!(payload.messages.len(), 21 * 2 + 1);
    assert!(
        matches!(&payload.messages[0], ToolTurnMessage::User { content } if content == "turn 1")
    );
    assert!(matches!(
        payload.messages.last(),
        Some(ToolTurnMessage::User { content }) if content == "probe"
    ));

    // The oldest turn (turn 1 -> result_1) fell out of the N=20 window: its
    // assistant message is the verbatim summary note (ADR-0039), retargetable
    // by result name.
    match &payload.messages[1] {
        ToolTurnMessage::Assistant { text, tool_calls } => {
            let text = text.as_deref().unwrap_or_default();
            assert!(
                text.contains("result_1"),
                "summary names its result: {text}"
            );
            assert!(tool_calls.is_empty(), "history turns carry no tool calls");
        }
        other => panic!("expected Assistant summary, got {other:?}"),
    }
    // A recent turn (turn 21, in-window) ships its rendered response including
    // the verbatim SQL (ADR-0023 point 1: the model sees its own prior SQL).
    match &payload.messages[41] {
        ToolTurnMessage::Assistant { text, .. } => {
            let text = text.as_deref().unwrap_or_default();
            assert!(text.contains("result_21"), "got {text}");
            assert!(
                text.contains("SELECT 1 AS n"),
                "prior SQL rides verbatim: {text}"
            );
        }
        other => panic!("expected Assistant response, got {other:?}"),
    }

    // Schema context (system prompt): the active pointer tracks the most
    // recent result; the source always ships samples (ADR-0023); out-of-window
    // result_1 ships schema only, in-window results ship samples (ADR-0026).
    assert!(payload.system.contains("active = result_21"));
    let people = dataset_block(&payload.system, "people");
    assert!(people.contains("id: BIGINT"), "source schema always full");
    assert!(
        people.contains("样本（前几行"),
        "source always ships samples"
    );
    let result_1 = dataset_block(&payload.system, "result_1");
    assert!(
        result_1.contains("仅知 schema"),
        "far result withholds samples"
    );
    let result_2 = dataset_block(&payload.system, "result_2");
    assert!(
        result_2.contains("样本（前几行"),
        "in-window result ships samples"
    );
}

#[test]
fn privacy_samples_off_withholds_a_sources_cells() {
    // AC #24: DatasetPrivacy.send_samples=false prunes every sample cell of that
    // dataset from the payload (ADR-0011) -- the controls now "take effect" on
    // what is actually sent (the system prompt's schema block), not just stored.
    let provider = FakeProvider::new().scripted_tool_turn_seq("q", productive("SELECT 1 AS n"));
    let captured = provider.captured_tool_turns();
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
    let people = dataset_block(&request_for(&buf, "q").system, "people");
    assert!(people.contains("仅知 schema"), "no cells ship: {people}");
    // schema still full -- only values are withheld.
    assert!(people.contains("id: BIGINT"));
}

#[test]
fn privacy_type_only_column_hides_name_and_values() {
    // AC #24: a type-only column ships its type but neither its name nor any
    // sample value (ADR-0011). The "name" column of people.csv is VARCHAR.
    let provider = FakeProvider::new().scripted_tool_turn_seq("q", productive("SELECT 1 AS n"));
    let captured = provider.captured_tool_turns();
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
    let people = dataset_block(&request_for(&buf, "q").system, "people");
    // The VARCHAR column ships type-only: its name is hidden.
    assert!(people.contains("_: VARCHAR (仅类型)"), "got {people}");
    assert!(!people.contains("name: VARCHAR"), "name leaks: {people}");
    // Sample cells: id ships; the type-only cell is withheld at its position.
    assert!(
        people.contains("| 1 | NULL |"),
        "id ships, name withheld: {people}"
    );
}

// --- Engine guardrails (issue #25) -- ADR-0005 ----------------------------
//
// Black-box through the ask -> outcome seam: the scripted model issues SQL
// that touches a guardrail, and we observe the engine refuse it with the
// source intact. Under the agent contract (ADR-0077) the refusal routes back
// to the model as a tool error; a model that never self-corrects (the script
// clamps to the same failing call) exhausts the step cap and the turn fails
// honestly. The guarantees are engine-level -- READ_ONLY attach, the
// `CREATE TABLE result_N AS <query>` wrapping (a non-SELECT statement is a
// parser error before it can touch a source or the filesystem), the sandbox
// lockdown (read_* closure), and resource caps -- never SQL text filtering.

#[test]
fn all_mutating_statements_against_the_source_are_rejected() {
    // AC1: a turn that tries to mutate a source Dataset (DROP/ALTER/INSERT/
    // UPDATE/DELETE) is rejected by the engine, and the source is unchanged.
    // The DML is embedded inside `CREATE TABLE result_N AS <query>`, where it
    // is a parser error; the READ_ONLY attach is the second layer. Each
    // variant routes back as a tool error; the non-correcting script exhausts
    // the step cap (Failed), and people keeps its original 5 rows.
    let mutating = [
        r#"DROP TABLE "people".data"#,
        r#"DELETE FROM "people".data"#,
        r#"UPDATE "people".data SET id = 0"#,
        r#"INSERT INTO "people".data VALUES (99)"#,
        r#"ALTER TABLE "people".data DROP COLUMN name"#,
    ];
    for sql in mutating {
        let provider = FakeProvider::new().scripted_tool_turn("改源", materialize(sql));
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        load_source(&mut session, &fixture("people.csv"));
        let reason = failed_failure(session.ask("改源"));
        assert!(
            matches!(reason, TurnFailure::Execute { .. }),
            "sql={sql} failure={reason:?}"
        );
        // Source content survives every attempt -- nothing was mutated.
        assert_eq!(
            session.snapshot_row_count("people").unwrap(),
            5,
            "source mutated by {sql}"
        );
        assert!(session.get("result_1").is_none()); // nothing promoted
    }
}

#[test]
fn filesystem_statements_are_rejected_by_the_wrapping() {
    // AC2: COPY / ATTACH / INSTALL / LOAD are statements, not query
    // expressions, so embedding them inside `CREATE TABLE ... AS <query>` is a
    // parser error (ADR-0005 engine-level, not text filtering). The tool error
    // routes back; the non-correcting script fails the turn at the step cap.
    // Nothing is written to disk, attached, or loaded.
    let stmts = [
        "COPY result_1 TO 'leak.csv'",
        "ATTACH ':memory:' AS leak",
        "INSTALL httpfs",
        "LOAD httpfs",
    ];
    for sql in stmts {
        let provider = FakeProvider::new().scripted_tool_turn("fs", materialize(sql));
        let mut session = Session::with_provider(Box::new(provider)).expect("session");
        load_source(&mut session, &fixture("people.csv"));
        let reason = failed_failure(session.ask("fs"));
        assert!(
            matches!(reason, TurnFailure::Execute { .. }),
            "sql={sql} failure={reason:?}"
        );
    }
}

#[test]
fn a_query_over_the_row_cap_is_refused_and_never_promotes() {
    // AC3/AC4: a result exceeding the row-count ceiling is refused by the
    // materializer's governor (ADR-0005 L3). Under the agent contract the
    // refusal routes back as a tool error (blind retry is abolished); the
    // non-correcting script exhausts the step cap, and the over-cap result
    // never promotes (the sandbox drops before admin is touched).
    let provider =
        FakeProvider::new().scripted_tool_turn("大查询", materialize("SELECT * FROM range(10)"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    session.set_result_row_cap(3); // small cap for a deterministic hit
    load_source(&mut session, &fixture("people.csv"));

    let failure = failed_failure(session.ask("大查询"));
    assert!(
        matches!(failure, TurnFailure::Execute { .. }),
        "got {failure:?}"
    );
    assert!(session.get("result_1").is_none()); // over-cap result never promoted
}

#[test]
fn a_query_under_the_row_cap_materializes_normally() {
    // AC3 sanity: results at or under the cap materialize in full (no false
    // abort, ADR-0030 full-result preservation). With cap=3, a 3-row result is
    // exact -- count <= cap, so it is kept, not truncated, not aborted.
    let mut session = session_with(&[("ok", "SELECT * FROM range(3)")]);
    session.set_result_row_cap(3);
    let (name, rows, _) = materialized(session.ask("ok"));
    assert_eq!(name, "result_1");
    assert_eq!(rows, 3);
}

#[test]
fn a_read_function_into_arbitrary_disk_is_refused_and_never_promotes() {
    // AC2 (issue #25, read_* closure): a SELECT calling a read_* table
    // function (read_csv_auto / read_parquet / read_json_auto) would let the
    // model read arbitrary disk. The sandbox runs provider SQL with
    // LocalFileSystem disabled, so the engine refuses with "disabled by
    // configuration" -- a tool error that routes back to the model (ADR-0077).
    // The non-correcting script exhausts the step cap; nothing is ever read
    // into a result.
    //
    // The leak target is a real temp file carrying a sentinel secret so the
    // assertion is concrete: had the sandbox not blocked read_csv_auto, the
    // secret would have materialized into result_1.
    let leak_dir = tempfile::tempdir().expect("temp dir");
    let leak = leak_dir.path().join("secret.csv");
    std::fs::write(&leak, "secret\nPASSWORD-LEAKED\n").expect("write leak");
    let leak_sql = format!(
        "SELECT secret FROM read_csv_auto('{}')",
        leak.to_string_lossy()
    );
    let provider = FakeProvider::new().scripted_tool_turn("leak", materialize(&leak_sql));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    let failure = failed_failure(session.ask("leak"));
    assert!(
        matches!(failure, TurnFailure::Execute { .. }),
        "read_* refusal rides the step-cap Failed turn, got {failure:?}"
    );
    // Nothing promoted: the over-disk read never produced a result.
    assert!(session.get("result_1").is_none());
}

// --- Active dataset resolution + natural-language redirect (issue #27) -----
//
// ADR-0010/0022: the dataset a question targets is resolved implicitly. The
// default is the previous step's intermediate result (or the most-recent
// source at session start); the user can redirect by natural language
// ("在原始数据上"). The resolved default rides the system prompt's schema
// context (`active = <name>`); the model may target any dataset by name in
// its tool calls. Observed at the ask -> outcome seam via the captured
// tool-turn request + the materialized outcome's target.

#[test]
fn active_defaults_to_the_most_recent_source_at_session_start() {
    // AC1/AC6: with no turns yet, the schema context's `active` is the
    // most-recently-uploaded source (ADR-0022 active default). Two sources
    // loaded -> the second is active; both sit in the shared namespace.
    let provider = FakeProvider::new().scripted_tool_turn_seq("探针", productive("SELECT 1 AS n"));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // most recent upload

    session.ask("探针");
    let buf = captured.lock().expect("lock");
    let system = &request_for(&buf, "探针").system;
    assert!(system.contains("active = orders"), "active pointer missing");
    // Multi-dataset working set: both sources coexist + referenceable.
    assert!(system.contains("引用名 = people"));
    assert!(system.contains("引用名 = orders"));
    assert!(session.get("people").is_some());
    assert!(session.get("orders").is_some());
}

#[test]
fn active_defaults_to_the_previous_result_after_a_turn() {
    // AC2: once a result exists, the next question's schema context defaults
    // `active` to the most recent prior result ("上一步的中间结果"), not the
    // source.
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "第一步",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted_tool_turn_seq("第二步", productive("SELECT COUNT(*) AS m FROM result_1"));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    session.ask("第一步"); // -> result_1
    session.ask("第二步"); // assembled request for this turn

    let buf = captured.lock().expect("lock");
    assert!(request_for(&buf, "第一步")
        .system
        .contains("active = people"));
    assert!(request_for(&buf, "第二步")
        .system
        .contains("active = result_1"));
}

#[test]
fn active_stays_on_the_last_result_across_a_textual_turn() {
    // AC2 edge: a textual turn produces no intermediate result, so the
    // resolved active stays at the most recent RESULT (result_1), not the most
    // recent turn. The next question still defaults to result_1.
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "第一步",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted_tool_turn("澄清", answer("哪个维度？"))
        .scripted_tool_turn_seq("跟进", productive("SELECT COUNT(*) AS m FROM result_1"));
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    session.ask("第一步"); // result_1
    session.ask("澄清"); // textual -- no result
    session.ask("跟进"); // defaults active to result_1 (still the last result)

    let buf = captured.lock().expect("lock");
    assert!(request_for(&buf, "跟进")
        .system
        .contains("active = result_1"));
}

#[test]
fn a_default_follow_up_targets_the_resolved_active_result() {
    // AC6 (default path): the model's SQL targets the resolved active
    // (result_1) and promotes a new result from it. result_1 holds one row
    // (a COUNT), so counting it yields 1 -- proving the turn acted on
    // result_1, not the 5-row source.
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "源计数",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted_tool_turn_seq("结果计数", productive("SELECT COUNT(*) AS m FROM result_1"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    session.ask("源计数"); // result_1: 1 row
    let (name, rows, _) = materialized(session.ask("结果计数")); // FROM result_1
    assert_eq!(name, "result_2");
    assert_eq!(rows, 1);
    let page = session.read_rows("result_2", 0, 10).expect("read");
    assert_eq!(page.rows, vec![vec!["1".to_string()]]); // counted result_1's 1 row
}

#[test]
fn a_natural_language_redirect_targets_the_named_source_not_the_default() {
    // AC3/AC6 (redirect path): the user says "在原始数据上重算" -- the model's
    // SQL targets the source, not the default active (result_1). The contract:
    // `active` is a default hint; the model may target any dataset by name.
    //
    // Observable two ways: (1) the schema context's `active` is STILL result_1
    // -- the redirect happens in the tool-call SQL, not by moving the pointer;
    // (2) the outcome read the 5-row source (count = 5), not result_1 (1).
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "源计数",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted_tool_turn_seq(
            "在原始数据上重算",
            productive(r#"SELECT COUNT(*) AS k FROM "people".data"#),
        );
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    session.ask("源计数"); // result_1 (1 row); resolved active is now result_1
    let (name, rows, _) = materialized(session.ask("在原始数据上重算"));

    // (1) The default `active` is unchanged by the redirect -- still result_1.
    let buf = captured.lock().expect("lock");
    assert!(request_for(&buf, "在原始数据上重算")
        .system
        .contains("active = result_1"));
    drop(buf);

    // (2) The outcome targeted the 5-row source, not result_1 (1 row).
    assert_eq!(name, "result_2");
    assert_eq!(rows, 1);
    let page = session.read_rows("result_2", 0, 10).expect("read");
    assert_eq!(page.rows, vec![vec!["5".to_string()]]); // people has 5 rows
}

#[test]
fn a_redirect_to_a_named_cosource_targets_it_not_the_default() {
    // AC3/AC6 (multi-dataset redirect): with two sources + a result, the user
    // redirects "在订单表上" to the non-active co-source (orders). The model's
    // SQL targets orders; the outcome reflects orders' 3 rows, not result_1
    // (1) or people (5). Proves redirection across a multi-dataset working set.
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "源计数",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted_tool_turn_seq(
            "在订单表上计数",
            productive(r#"SELECT COUNT(*) AS k FROM "orders".data"#),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv"));

    session.ask("源计数"); // result_1 from people; resolved active is now result_1
    let (name, _, _) = materialized(session.ask("在订单表上计数"));
    assert_eq!(name, "result_2");
    let page = session.read_rows("result_2", 0, 10).expect("read");
    assert_eq!(page.rows, vec![vec!["3".to_string()]]); // orders has 3 rows
}

#[test]
fn the_active_dataset_command_reflects_the_resolved_active() {
    // AC5 wiring: the `active_dataset` surface (UI label) agrees with the
    // schema context -- after a turn, both resolve to the most recent result,
    // so the "当前表" indicator the user sees matches what the next question
    // targets.
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "源计数",
        productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    // Before any turn: active = the source.
    assert_eq!(session.active().expect("active").reference_name, "people");
    session.ask("源计数"); // result_1
                           // After a turn: active = the most recent result, matching the context.
    assert_eq!(session.active().expect("active").reference_name, "result_1");
}

// --- Single in-flight + cancellation (issue #28) -- ADR-0021/0028/0081 -----
//
// ADR-0021 (extended by ADR-0081): at most one turn executes per session; a
// cancel (user / close / wall-clock watchdog) aborts the WHOLE turn -- the
// loop + any in-flight tool call -- via the shared cancel token, landing as
// the Cancelled outcome with the working set untouched. The fake simulates a
// long, cancellable round-trip by blocking in `generate_tool_turn` until the
// token fires (a real long DuckDB query is exercised by the #[ignore]
// interrupt test further down).

/// Poll the shared cancel token's in-flight flag until it goes true (the ask
/// thread has begun its turn). Bounded so a misconfigured test (one that never
/// starts a turn) fails fast instead of hanging.
fn await_in_flight(cancel: &CancelToken, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while !cancel.is_in_flight() {
        if std::time::Instant::now() > deadline {
            panic!("turn never entered in-flight within {timeout:?}");
        }
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn cancelling_an_in_flight_turn_lands_as_cancelled_with_working_set_unchanged() {
    // AC1/AC2/AC4: a blocking round-trip is cancelled mid-flight -> Cancelled
    // outcome, no result_N promoted, source intact (ADR-0021).
    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new()
        .with_cancel(cancel.clone())
        .scripted_tool_turn_blocking("慢查询", answer("never"));
    let session =
        Session::with_provider_and_cancel(Box::new(provider), cancel.clone()).expect("session");
    let session = Arc::new(Mutex::new(session));
    {
        let mut s = session.lock().unwrap();
        load_source(&mut s, &fixture("people.csv"));
    }

    let session_ask = Arc::clone(&session);
    let handle = thread::spawn(move || {
        let mut s = session_ask.lock().unwrap();
        s.ask("慢查询")
    });

    await_in_flight(&cancel, Duration::from_secs(2));
    // While in-flight: the single-in-flight flag is the observable backend
    // truth (AC1) -- exactly one turn is executing.
    assert!(cancel.is_in_flight());
    cancel.request();

    let outcome = handle.join().expect("ask thread");
    assert!(matches!(outcome, TurnOutcome::Cancelled), "got {outcome:?}");
    // Working set unchanged: no result promoted, source intact.
    let s = session.lock().unwrap();
    assert!(s.get("result_1").is_none());
    assert_eq!(s.snapshot_row_count("people").unwrap(), 5);
}

#[test]
fn a_cancelled_turn_is_recorded_in_the_thread_but_advances_no_result_number() {
    // ADR-0028/0039: a cancelled turn is always visible (occupies a thread
    // slot) but does NOT advance result_N. The next result is result_1, not
    // result_2.
    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new()
        .with_cancel(cancel.clone())
        .scripted_tool_turn_blocking("慢查询", answer("never"))
        .scripted_tool_turn_seq(
            "再查",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        );
    let session =
        Session::with_provider_and_cancel(Box::new(provider), cancel.clone()).expect("session");
    let session = Arc::new(Mutex::new(session));
    {
        let mut s = session.lock().unwrap();
        load_source(&mut s, &fixture("people.csv"));
    }

    let session_ask = Arc::clone(&session);
    let handle = thread::spawn(move || session_ask.lock().unwrap().ask("慢查询"));
    await_in_flight(&cancel, Duration::from_secs(2));
    cancel.request();
    let cancelled = handle.join().expect("ask thread");
    assert!(matches!(cancelled, TurnOutcome::Cancelled));

    // The cancelled turn is in the thread, labeled by its verbatim question.
    // (Source lifecycle events share the timeline but are filtered out by the
    // turns() helper, so the leading `Added` event from load_source is not
    // counted here -- the assertion stays about the turn slot.)
    let thread = {
        let s = session.lock().unwrap();
        turns(s.conversation())
    };
    assert_eq!(thread.len(), 1);
    assert_eq!(thread[0].question, "慢查询");
    assert!(matches!(thread[0].outcome, TurnOutcome::Cancelled));

    // A subsequent result is result_1 -- the cancelled turn consumed no number.
    let (name, _, _) = materialized(session.lock().unwrap().ask("再查"));
    assert_eq!(name, "result_1");
}

#[test]
fn a_turn_after_a_cancelled_turn_starts_clean_with_no_stale_request() {
    // begin_turn resets the token: a cancel that landed on the cancelled turn
    // must not leak into the next turn (which would then also cancel). The
    // next turn runs to completion.
    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new()
        .with_cancel(cancel.clone())
        .scripted_tool_turn_blocking("慢查询", answer("never"))
        .scripted_tool_turn_seq(
            "正常",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        );
    let session =
        Session::with_provider_and_cancel(Box::new(provider), cancel.clone()).expect("session");
    let session = Arc::new(Mutex::new(session));
    {
        let mut s = session.lock().unwrap();
        load_source(&mut s, &fixture("people.csv"));
    }

    let session_ask = Arc::clone(&session);
    let handle = thread::spawn(move || session_ask.lock().unwrap().ask("慢查询"));
    await_in_flight(&cancel, Duration::from_secs(2));
    cancel.request();
    assert!(matches!(
        handle.join().expect("ask thread"),
        TurnOutcome::Cancelled
    ));
    // The flag is still set from the cancelled turn; the next ask must clear
    // it via begin_turn and run to completion.
    assert!(cancel.is_requested());
    let (name, rows, _) = materialized(session.lock().unwrap().ask("正常"));
    assert_eq!(name, "result_1"); // promoted, not cancelled
    assert_eq!(rows, 1);
}

#[test]
fn cancelling_when_no_turn_is_in_flight_is_a_harmless_noop() {
    // The cancel command may be called when nothing is running (the user hits
    // 停止 a moment after the turn finished). The flag is set, but the next
    // ask's begin_turn resets it before starting -- so a stray cancel cannot
    // wedge the session.
    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "正常",
        productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
    );
    let mut session =
        Session::with_provider_and_cancel(Box::new(provider), cancel.clone()).expect("session");
    load_source(&mut session, &fixture("people.csv"));

    cancel.request(); // no turn running
    assert!(cancel.is_requested());
    let (name, _, _) = materialized(session.ask("正常")); // resets + runs to completion
    assert_eq!(name, "result_1");
}

#[test]
#[ignore] // exercises the real DuckDB interrupt path; slower, run explicitly
fn a_real_long_duckdb_query_is_interruptible_via_cancel() {
    // ADR-0021/0081 "cancel aborts the whole turn": a genuinely long engine
    // query (a cross-join count over billions of rows) inside a materialize
    // call is aborted at source when cancel fires the registered interrupt
    // handle -> the turn lands as Cancelled (the loop's next check sees the
    // flag). This proves the interrupt-handle wiring in try_materialize, not
    // just the cooperative flag the blocking-fake tests exercise.
    let cancel = Arc::new(CancelToken::new());
    // No blocking fake: the provider returns instantly; the LATENCY is the
    // DuckDB query inside the materialize dispatch.
    let provider = FakeProvider::new().scripted_tool_turn(
        "慢查询",
        materialize("SELECT count(*) AS n FROM range(200000000) t1 CROSS JOIN range(10) t2"),
    );
    let session =
        Session::with_provider_and_cancel(Box::new(provider), cancel.clone()).expect("session");
    let session = Arc::new(Mutex::new(session));
    {
        let mut s = session.lock().unwrap();
        load_source(&mut s, &fixture("people.csv"));
    }

    let session_ask = Arc::clone(&session);
    let handle = thread::spawn(move || {
        let mut s = session_ask.lock().unwrap();
        s.ask("慢查询")
    });

    await_in_flight(&cancel, Duration::from_secs(2));
    // Give the query a moment to start running on the engine before
    // interrupting.
    thread::sleep(Duration::from_millis(100));
    cancel.request();

    let outcome = handle.join().expect("ask thread");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "DuckDB interrupt should land Cancelled, got {outcome:?}"
    );
    let s = session.lock().unwrap();
    assert!(s.get("result_1").is_none()); // rolled back / never installed
}

// --- turn-progress event stream production (ADR-0059, issue #76; calibrated
// by ADR-0078, issue #297) ---------------------------------------------------
//
// ask_with_phase surfaces the discrete turn-progress stream so the command
// layer can emit the side-channel `turn-progress` event: Thinking before each
// provider round-trip + the ToolCallStarted / ToolCallCompleted pair around
// each dispatch (the retired Thinking / Querying phase pair evolved into this
// tool-call event stream -- the trace is its persisted form). The events
// never enter the TurnOutcome contract; they are pure observer feedback. On
// the multi-step agent loop the Thinking attempt number is the 1-based STEP
// (round-trip), so a materialize turn reads Thinking{1} -> Started ->
// Completed -> Thinking{2} (the terminal-text round-trip). These tests pin
// the event SEQUENCE the UI renders the live trace from.

#[test]
fn ask_with_phase_records_the_tool_call_event_stream_on_a_result_turn() {
    // ADR-0059/0078/0081: a one-call result turn emits the first provider
    // round-trip (Thinking{1}), the materialize dispatch's started/completed
    // pair, and the terminal-text round-trip (Thinking{2}). The completed
    // payload mirrors the persisted trace shape (success excerpt emptied).
    let mut session = session_with(&[("建结果", "SELECT 1 AS n")]);
    let approval = ApprovalState::new();
    let sink = NullSink;
    let mut phases: Vec<TurnPhase> = Vec::new();
    let outcome = session.ask_with_phase(
        "建结果",
        &approval,
        &sink,
        |p| phases.push(p),
        &[],
        &KeychainStore::new(),
        &[],
    );
    assert!(
        matches!(outcome, TurnOutcome::Materialized { .. }),
        "got {outcome:?}"
    );
    assert_eq!(
        phases,
        vec![
            TurnPhase::Thinking { attempt: 1 },
            TurnPhase::ToolCallStarted {
                name: "materialize".into(),
                operation_kind: OperationKind::Write,
                summary: "SELECT 1 AS n".into(),
            },
            TurnPhase::ToolCallCompleted(TraceEntryView {
                name: "materialize".into(),
                operation_kind: OperationKind::Write,
                summary: "SELECT 1 AS n".into(),
                success: true,
                result_excerpt: String::new(),
            }),
            TurnPhase::Thinking { attempt: 2 },
        ],
        "a one-call result turn emits Thinking{{1}}, the materialize started/completed pair, Thinking{{2}}"
    );
}

#[test]
fn ask_with_phase_records_only_thinking_on_a_textual_turn() {
    // ADR-0059/0078: a textual turn (terminal text, no tool calls) has only
    // the provider wait -- no tool dispatch, so the tool-call event stream
    // stays empty.
    let provider = FakeProvider::new().scripted_tool_turn("澄清", answer("哪个维度？"));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    let approval = ApprovalState::new();
    let sink = NullSink;

    let mut phases: Vec<TurnPhase> = Vec::new();
    let outcome = session.ask_with_phase(
        "澄清",
        &approval,
        &sink,
        |p| phases.push(p),
        &[],
        &KeychainStore::new(),
        &[],
    );
    assert!(
        matches!(outcome, TurnOutcome::Textual { .. }),
        "got {outcome:?}"
    );
    assert_eq!(
        phases,
        vec![TurnPhase::Thinking { attempt: 1 }],
        "a textual turn emits Thinking only -- no query wait"
    );
}

// --- turn-progress / resume-progress session_id addressing (ADR-0056/0059,
// issue #76) --------------------------------------------------------------
//
// Each progress event is addressed by a session_id so a multi-session frontend
// filters the global Tauri broadcast down to the one SessionPane that owns the
// turn / resume (ADR-0056). The command layer wraps each lib-phase / lib-event
// with the ask's / open_duck's session_id before emitting; these seams drive
// the SAME callback the command layer injects and assert one turn's / one
// resume's whole event sequence is addressable by ONE id -- the precondition
// for the frontend's sessionId filter. (The Tauri emit wrapping itself lives
// in commands.rs and is not reachable without a Tauri runtime; the lib
// callback + the wire types are what these tests pin.)

#[test]
fn turn_progress_events_for_one_turn_share_one_session_id() {
    // AC #76 (ADR-0056/0059): a turn's whole phase sequence is addressable by
    // the ask's single session_id. The command layer wraps each TurnPhase with
    // that id; this seam drives the same callback and asserts every emitted
    // event carries it, so a multi-session frontend can filter on sessionId.
    const SID: &str = "turn-session-id";
    let mut session = session_with(&[("建结果", "SELECT 1 AS n")]);
    let approval = ApprovalState::new();
    let sink = NullSink;
    let mut addressed: Vec<TurnProgress> = Vec::new();
    let outcome = session.ask_with_phase(
        "建结果",
        &approval,
        &sink,
        |phase| {
            addressed.push(TurnProgress {
                session_id: SID.into(),
                phase,
            });
        },
        &[],
        &KeychainStore::new(),
        &[],
    );
    assert!(
        matches!(outcome, TurnOutcome::Materialized { .. }),
        "got {outcome:?}"
    );
    // A one-call result turn emits Thinking{1} + the materialize
    // started/completed pair + Thinking{2} (ADR-0078 event stream).
    assert!(addressed.len() >= 2, "got {addressed:?}");
    assert!(
        addressed.iter().all(|p| p.session_id == SID),
        "every turn-progress event carries the ask's session_id: {addressed:?}"
    );
}

#[test]
fn resume_progress_events_carry_one_session_id_and_cover_the_resume_sequence() {
    // AC #76 (ADR-0034/0056/0059): resume emits a resume-progress event per
    // source verification + per replayed turn, and the whole sequence is
    // addressable by the open_duck's single session_id. This seam also pins
    // that resume ACTUALLY fires Source + Replay events (ADR-0034 visible
    // progress). The command layer wraps each ResumeEvent with the session_id;
    // here we drive the same callback and assert one id addresses every event.
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("resumed.duck");

    // Build + persist a real .duck: one source + one productive turn.
    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "建结果",
        productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
    );
    let mut session =
        Session::with_provider_and_cancel(Box::new(provider), cancel).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    session.ask("建结果"); // result_1
    session
        .bind_duck(duck.clone(), "resumed".into())
        .expect("bind");
    // Drop the building session so the canonical-writer key (ADR-0035
    // single-writer) releases before open_duck re-acquires it.
    drop(session);

    const SID: &str = "resume-session-id";
    let mut addressed: Vec<ResumeProgress> = Vec::new();
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(FakeProvider::new()),
        |ev| {
            addressed.push(ResumeProgress {
                session_id: SID.into(),
                event: ev,
            })
        },
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    )
    .expect("resume");

    // Resume fires at least one Source + one Replay event (ADR-0034 visible
    // progress) -- the emit path the frontend renders its progress bar from.
    assert!(
        addressed
            .iter()
            .any(|p| matches!(p.event, ResumeEvent::Source { .. })),
        "resume emits a Source verification event: {addressed:?}"
    );
    assert!(
        addressed
            .iter()
            .any(|p| matches!(p.event, ResumeEvent::Replay { .. })),
        "resume emits a Replay progress event: {addressed:?}"
    );
    // Every event is addressable by the SAME session_id (frontend filter key).
    assert!(
        addressed.iter().all(|p| p.session_id == SID),
        "every resume-progress event carries the resume's session_id: {addressed:?}"
    );
    // Sanity: the resumed session reconstructed the turn's result via replay.
    assert!(resumed.get("result_1").is_some());
}
