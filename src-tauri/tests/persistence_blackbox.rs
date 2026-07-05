//! Black-box persistence seam (issue #48, ADR-0034/0036/0042): drive a session
//! across the restart boundary at the Session API. A scripted FakeProvider
//! builds productive + no-result turns, the session is bound to a `.duck` and
//! dropped (simulating app close), then `Session::open_duck` resumes it: every
//! source is re-read + fingerprint-verified, the productive SQL chain is
//! eagerly re-executed LLM-free, the no-result turns are statically rendered,
//! and the active pointer + working set + history are restored. The main seam
//! is the application as a black box across the restart -- the .duck internal
//! text layout is asserted only at the contents-boundary level (secrets never,
//! no materialized data), never as a pinned byte layout.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use toptopduck_lib::{
    CancelToken, FakeProvider, LoadOutcome, ProviderReply, ResumeEvent, Session, TextKind,
    ThreadEntry, TurnOutcome, UnwiredProvider,
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

/// Build the pre-close session used by every test: one CSV source, two
/// productive result turns (result_1, result_2), one textual refuse turn (a
/// no-result turn that must be statically rendered on resume, never re-asked).
/// Returns the bound `.duck` path -- the caller drops the session to simulate
/// close, then calls `Session::open_duck` on the same path.
fn build_session(duck: &Path) -> Session {
    let csv = fixture("people.csv");
    let provider = FakeProvider::new()
        .scripted(
            "多少人",
            reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
        )
        .scripted(
            "最高分",
            reply_sql("SELECT MAX(score) AS m FROM \"people\".data"),
        )
        .scripted("预测下个月", {
            // A textual no-result turn (ADR-0017 refuse): the body is carried
            // verbatim and is NOT re-asked on resume (ADR-0034 static render).
            ProviderReply::Text {
                kind: TextKind::Refuse,
                body: "v1 不做预测（仅描述性统计）".into(),
                assumption: None,
            }
        });
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &csv);
    // Two productive turns -> result_1, result_2.
    let _ = session.ask("多少人");
    let _ = session.ask("最高分");
    // One no-result turn (refuse) -- occupies a thread slot, no result_N.
    let _ = session.ask("预测下个月");
    session
        .bind_duck(duck.to_path_buf(), "分析 A".into())
        .expect("bind");
    session
}

/// Collect resume events into a Vec via a shared RefCell so the test can
/// assert progress fired per source + per replayed turn.
fn collect_events() -> (Rc<RefCell<Vec<ResumeEvent>>>, impl FnMut(ResumeEvent)) {
    let cell: Rc<RefCell<Vec<ResumeEvent>>> = Rc::new(RefCell::new(Vec::new()));
    let cb_cell = Rc::clone(&cell);
    let cb = move |ev: ResumeEvent| cb_cell.borrow_mut().push(ev);
    (cell, cb)
}

#[test]
fn resume_restores_working_set_history_and_active() {
    // AC: the working set (sources + result reference names + display names),
    // the full history, and the active pointer are equal before close and
    // after resume. This is the tracer bullet's central end-to-end seam.
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let session = build_session(&duck);

    let before_sources: Vec<(String, String)> = session
        .list()
        .iter()
        .map(|d| (d.reference_name.clone(), d.display_name.clone()))
        .collect();
    let before_active = session.active().map(|d| d.reference_name.clone()).unwrap();
    let before_history: Vec<String> = session
        .conversation()
        .iter()
        .map(|e| match e {
            ThreadEntry::Turn(t) => t.question.clone(),
            ThreadEntry::Source(ev) => format!("<{}>", ev.reference_name),
        })
        .collect();
    let before_result_count = session
        .list()
        .iter()
        .filter(|d| d.reference_name.starts_with("result_"))
        .count();

    drop(session);

    let (_events, cb) = collect_events();
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        cb,
    )
    .expect("resume");

    let after_sources: Vec<(String, String)> = resumed
        .list()
        .iter()
        .map(|d| (d.reference_name.clone(), d.display_name.clone()))
        .collect();
    assert_eq!(
        after_sources, before_sources,
        "working set (reference + display names) restored"
    );
    assert_eq!(
        resumed.active().map(|d| d.reference_name.clone()).unwrap(),
        before_active
    );
    let after_history: Vec<String> = resumed
        .conversation()
        .iter()
        .map(|e| match e {
            ThreadEntry::Turn(t) => t.question.clone(),
            ThreadEntry::Source(ev) => format!("<{}>", ev.reference_name),
        })
        .collect();
    assert_eq!(
        after_history, before_history,
        "full timeline restored verbatim"
    );
    let after_result_count = resumed
        .list()
        .iter()
        .filter(|d| d.reference_name.starts_with("result_"))
        .count();
    assert_eq!(after_result_count, before_result_count);
    assert_eq!(
        after_result_count, 2,
        "two productive turns re-materialized"
    );

    // AC: charts render as TABLES after resume (ADR-0036 -- viz is not
    // persisted). The recipe carries no viz field, and resume_history hard-
    // codes viz=None on every Materialized turn, so a reopened chart comes
    // back as a table the user can re-request a chart on (ADR-0033). Pins the
    // invariant so a future change that accidentally persists/restores viz
    // fails here.
    let viz_persisted = resumed
        .conversation()
        .iter()
        .filter_map(|e| match e {
            ThreadEntry::Turn(t) => match &t.outcome {
                TurnOutcome::Materialized { viz, .. } => Some(viz.is_some()),
                _ => None,
            },
            _ => None,
        })
        .any(|has_viz| has_viz);
    assert!(
        !viz_persisted,
        "viz must not survive resume (ADR-0036); reopened charts render as tables"
    );
}

#[test]
fn duck_file_carries_no_secrets_or_materialized_data() {
    // AC: the .duck is a recipe text; assert it carries no API key, no
    // materialized result columns / sample / row-count, and no viz spec
    // (ADR-0036 contents boundary + secrets-never).
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let session = build_session(&duck);
    drop(session);

    let text = fs::read_to_string(&duck).expect("read .duck");
    assert!(!text.contains("api_key"), "no api_key field");
    assert!(!text.contains("sk-"), "no key-like token");
    assert!(!text.contains("columns"), "no materialized columns");
    assert!(!text.contains("sample"), "no materialized sample");
    assert!(!text.contains("row_count"), "no materialized row_count");
    assert!(!text.contains("viz"), "no viz spec (ADR-0036)");
    assert!(text.contains("format_version"), "format_version present");
    assert!(
        text.contains("people"),
        "verbatim SQL naming the source is in the recipe"
    );
}

#[test]
fn resume_does_not_replay_no_result_turns() {
    // AC: no-result turns (refuse / clarify / failed / cancelled) are
    // statically rendered on resume; the disambiguation choice is NOT
    // re-asked (ADR-0034). Concretely: the refuse body reappears verbatim in
    // the post-resume history, produced without any provider reply.
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let session = build_session(&duck);
    drop(session);

    let (_events, cb) = collect_events();
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        cb,
    )
    .expect("resume");

    // The refuse turn's body must be present verbatim in the restored thread.
    let refuse_present = resumed.conversation().iter().any(|e| match e {
        ThreadEntry::Turn(t) => {
            matches!(&t.outcome, TurnOutcome::Textual { body, .. } if body.contains("不做预测"))
        }
        _ => false,
    });
    assert!(
        refuse_present,
        "refuse turn statically rendered after resume"
    );
}

#[test]
fn resume_emits_visible_progress_events() {
    // AC: resume shows visible progress (ADR-0034). The events fire per source
    // verification and per replayed productive turn -- here: 1 source + 2
    // productive turns = 3 events, in source-then-replay order.
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let session = build_session(&duck);
    drop(session);

    let (events, cb) = collect_events();
    let _resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        cb,
    )
    .expect("resume");
    let events = events.borrow();

    let source_count = events
        .iter()
        .filter(|e| matches!(e, ResumeEvent::Source { .. }))
        .count();
    let replay_count = events
        .iter()
        .filter(|e| matches!(e, ResumeEvent::Replay { .. }))
        .count();
    assert_eq!(source_count, 1, "one source verified");
    assert_eq!(replay_count, 2, "two productive turns replayed");
    // Order: every source event precedes every replay event.
    let first_replay_idx = events
        .iter()
        .position(|e| matches!(e, ResumeEvent::Replay { .. }))
        .unwrap();
    let last_source_idx = events
        .iter()
        .rposition(|e| matches!(e, ResumeEvent::Source { .. }))
        .unwrap();
    assert!(
        last_source_idx < first_replay_idx,
        "all sources verified before replay starts"
    );
    // Replay events advance index 1 -> 2 (1-based) in order.
    let replay_idxs: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            ResumeEvent::Replay { index, .. } => Some(*index),
            _ => None,
        })
        .collect();
    assert_eq!(replay_idxs, vec![1, 2]);
}

#[test]
fn rename_survives_resume_and_references_still_resolve() {
    // AC: renaming a dataset before close -> save -> resume -> all references
    // (SQL FROM / active pointer / recipe chain) still resolve to the same
    // dataset (ADR-0037: reference name is stable, display name is renamable).
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let csv = fixture("people.csv");
    let provider = FakeProvider::new().scripted(
        "多少人",
        reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &csv);
    let _ = session.ask("多少人");
    // Rename the SOURCE's display label (ADR-0037). The reference name
    // "people" is unchanged, so every SQL FROM / recipe chain reference
    // stays valid.
    session
        .rename_display("people", "员工表")
        .expect("rename source");
    // Rename result_1's display label too -- its reference name is stable.
    session
        .rename_display("result_1", "总人数")
        .expect("rename result");
    session
        .bind_duck(duck.clone(), "重命名分析".into())
        .expect("bind");
    drop(session);

    let (_events, cb) = collect_events();
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        cb,
    )
    .expect("resume");

    // Display labels survived resume.
    let people = resumed.get("people").expect("people present");
    assert_eq!(
        people.display_name, "员工表",
        "source display label restored"
    );
    assert_eq!(people.reference_name, "people", "reference name stable");
    let result_1 = resumed.get("result_1").expect("result_1 present");
    assert_eq!(
        result_1.display_name, "总人数",
        "result display label restored"
    );
    assert_eq!(
        result_1.reference_name, "result_1",
        "result reference name stable"
    );

    // The reference name still resolves for reads -- the same path a SQL FROM
    // takes (working_set.sql_from).
    let page = resumed
        .read_rows("people", 0, 1)
        .expect("read people by reference name");
    assert!(page.total > 0, "reference name resolves to the data");
}

#[test]
fn resume_refuses_a_relative_path_that_escapes_the_duck_dir() {
    // Review H1 (path traversal): a hand-edited or externally-sourced .duck
    // whose relative_path escapes the .duck's directory would otherwise let a
    // malicious recipe pull arbitrary files (`~/.ssh/id_rsa`, `/etc/passwd`,
    // ...) into the DuckDB snapshot and from there into LLM samples / column
    // names. resolve_source_path MUST refuse such a path at the resume
    // boundary -- never silently canonicalize back to a file outside the dir.
    use toptopduck_lib::persistence::{save_atomic, Recipe, SourceRef, RECIPE_FORMAT_VERSION};
    use toptopduck_lib::RectifyProvenance;
    use toptopduck_lib::ResumeError;

    let dir = tempfile::tempdir().expect("tempdir");
    // Put the .duck in a sub-dir so "../evil.csv" cleanly escapes it.
    let sub = dir.path().join("sub");
    fs::create_dir(&sub).expect("mkdir");
    let duck = sub.join("session.duck");
    // Plant a sibling file in the .duck dir's PARENT -- canonicalize resolves
    // it to the parent, which does NOT start with the .duck dir.
    let outside = dir.path().join("evil.csv");
    fs::write(&outside, b"col\nval\n").expect("write");

    let malicious = Recipe {
        format_version: RECIPE_FORMAT_VERSION,
        session_name: "evil".into(),
        sources: vec![SourceRef {
            reference_name: "evil".into(),
            display_name: "evil".into(),
            source_path: outside.to_string_lossy().to_string(),
            relative_path: Some("../evil.csv".into()),
            rectify: RectifyProvenance::NotApplicable,
            fingerprint: "any".into(),
        }],
        history: vec![],
        active: None,
    };
    save_atomic(&duck, &malicious).expect("save");

    let outcome = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
    );
    match outcome {
        Err(ResumeError::SourceMissing { detail, .. }) => {
            assert!(
                detail.contains("路径遍历"),
                "expected traversal refusal, got: {detail}"
            );
        }
        Err(other) => panic!("expected SourceMissing, got: {other}"),
        Ok(_) => panic!("expected error, but resume succeeded"),
    }
}

#[test]
fn resume_is_cancellable_mid_replay() {
    // Review H3 (ADR-0021 cancel surface): without an is_requested() poll in
    // the resume loops, a user click of 停止 during resume would only get the
    // engine interrupt on the CURRENT SQL, surface as a `Replay` failure, and
    // look indistinguishable from data corruption. The poll must route a
    // mid-resume cancel to `ResumeError::Cancelled` (a clean signal).
    use toptopduck_lib::ResumeError;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");
    let session = build_session(&duck);
    drop(session);

    let cancel = Arc::new(CancelToken::new());
    let cancel_for_cb = Arc::clone(&cancel);
    // Fire cancel on the FIRST Source event. resume_sources checks
    // is_requested() at the top of each iteration (after on_progress fires),
    // so with a single source the cancel lands cleanly at the first iteration
    // of resume_replay -- before any SQL runs.
    let mut fired = false;
    let outcome = Session::open_duck(&duck, cancel, Box::new(UnwiredProvider), move |_ev| {
        if !fired {
            fired = true;
            cancel_for_cb.request();
        }
    });
    match outcome {
        Err(ResumeError::Cancelled) => {}
        Err(other) => panic!("expected Cancelled, got: {other}"),
        Ok(_) => panic!("expected error, but resume succeeded"),
    }
}
