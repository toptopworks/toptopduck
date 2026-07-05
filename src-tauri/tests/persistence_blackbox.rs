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
    ActiveAbandoned, ActiveResolution, CancelToken, FakeProvider, LoadOutcome, ProviderReply,
    ResumeError, ResumeEvent, Session, SourceIssue, SourceResolution, TextKind, ThreadEntry,
    TurnOutcome, UnwiredProvider,
};

/// Resume with default Abort callbacks for the issue #49 interactive decision
/// points. For happy-path tests that never perturb sources -- equivalent to the
/// pre-#49 `open_duck` seam (any Missing/Drift/ActiveAbandoned aborts, which
/// never fires when sources + active are intact).
fn resume_defaults(
    duck: &Path,
    cancel: Arc<CancelToken>,
    on_progress: impl FnMut(ResumeEvent),
) -> Result<Session, ResumeError> {
    Session::open_duck(
        duck,
        cancel,
        Box::new(UnwiredProvider),
        on_progress,
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    )
}

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
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");

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
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");

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
    let _resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");
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
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");

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

    let outcome = resume_defaults(&duck, Arc::new(CancelToken::new()), |_| {});
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
    let outcome = Session::open_duck(
        &duck,
        cancel,
        Box::new(UnwiredProvider),
        move |_ev| {
            if !fired {
                fired = true;
                cancel_for_cb.request();
            }
        },
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    );
    match outcome {
        Err(ResumeError::Cancelled) => {}
        Err(other) => panic!("expected Cancelled, got: {other}"),
        Ok(_) => panic!("expected error, but resume succeeded"),
    }
}

// --- Issue #49: honest degrade (ADR-0035) -------------------------------------
//
// Re-link / drift / active-abandoned / replay-break. Each test injects a
// source perturbation between close and resume, then asserts the engine's
// honest behavior through the interactive callbacks. All use UnwiredProvider
// (AC7: the degradation path never calls a cloud LLM -- resume re-executes
// stored SQL + asks the caller, not a model, for every decision).

/// Build a single-source session bound to `duck` with the source at
/// `source_path` (a copy the test can move/modify between close and resume).
/// The source file's stem MUST be `people` so the derived reference name is
/// `people` (the scripted SQL names `"people".data`).
fn build_single_source_session(duck: &Path, source_path: &Path) -> Session {
    let provider = FakeProvider::new().scripted(
        "多少人",
        reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, source_path);
    let _ = session.ask("多少人");
    session
        .bind_duck(duck.to_path_buf(), "t".into())
        .expect("bind");
    session
}

/// Copy `people.csv` into `dir` as `people.csv` and return its path.
fn plant_people(dir: &Path) -> PathBuf {
    let p = dir.join("people.csv");
    fs::copy(fixture("people.csv"), &p).expect("copy people.csv");
    p
}

#[test]
fn resume_relinks_a_missing_source_and_updates_recipe_path() {
    // AC1: source moved away -> Missing -> user re-links to the new path ->
    // fingerprint matches -> recipe updates ONLY the path (fingerprint +
    // rectify unchanged -- same content) -> replay succeeds.
    use toptopduck_lib::persistence::read_duck;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let original = plant_people(dir.path());
    let session = build_single_source_session(&duck, &original);
    let people_fp = session.get("people").expect("people").fingerprint.clone();
    drop(session);

    // Move the source file (simulating the user relocating it).
    let moved = dir.path().join("moved-people.csv");
    fs::rename(&original, &moved).expect("move");

    let moved_for_cb = moved.clone();
    let issues = Rc::new(RefCell::new(Vec::<SourceIssue>::new()));
    let issues_for_cb = Rc::clone(&issues);
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        move |issue| {
            issues_for_cb.borrow_mut().push(issue.clone());
            match issue {
                SourceIssue::Missing { reference_name, .. } => {
                    assert_eq!(reference_name, "people");
                    SourceResolution::Relink(moved_for_cb.clone())
                }
                SourceIssue::Drift { .. } => panic!("expected Missing, got Drift"),
                SourceIssue::Unreadable { .. } => panic!("expected Missing, got Unreadable"),
            }
        },
        |_| ActiveResolution::Abort,
    )
    .expect("resume");

    // Exactly one Missing issue fired (re-link matched on the first try).
    let issues = issues.borrow();
    assert_eq!(issues.len(), 1, "Missing fired once (re-link matched)");
    assert!(matches!(issues[0], SourceIssue::Missing { .. }));

    // Source is in the working set with the ORIGINAL fingerprint (same content,
    // only the path moved -- ADR-0035 re-link updates only the path).
    let people = resumed.get("people").expect("people present");
    assert_eq!(people.fingerprint, people_fp, "fingerprint unchanged");
    // Replay succeeded (result_1 re-materialized).
    assert!(resumed.get("result_1").is_some(), "result_1 replayed");

    // The persisted recipe now carries the NEW path (re-link survived a
    // hypothetical re-close). Read it back and check.
    let persisted = read_duck(&duck).expect("read persisted");
    let src = persisted
        .sources
        .iter()
        .find(|s| s.reference_name == "people")
        .expect("people in recipe");
    assert_eq!(
        src.source_path,
        moved.to_string_lossy(),
        "recipe path updated to the re-linked location"
    );
    assert_eq!(src.fingerprint, people_fp, "recipe fingerprint unchanged");
}

#[test]
fn resume_abort_in_relink_dialog_stops_resume_and_leaves_recipe_untouched() {
    // AC2: user picks Abort in the re-link dialog -> session is NOT entered,
    // and the on-disk recipe is left byte-for-byte untouched ("原状保留").
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let original = plant_people(dir.path());
    let session = build_single_source_session(&duck, &original);
    drop(session);

    let recipe_before = fs::read_to_string(&duck).expect("read .duck");

    // Move the source away, then Abort on the Missing issue.
    let moved = dir.path().join("moved.csv");
    fs::rename(&original, &moved).expect("move");
    let outcome = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    );
    match outcome {
        Err(ResumeError::Aborted) => {}
        Err(other) => panic!("expected Aborted, got: {other}"),
        Ok(_) => panic!("expected Aborted, but resume succeeded"),
    }

    // The on-disk recipe is unchanged -- Abort does not persist partial state.
    let recipe_after = fs::read_to_string(&duck).expect("read .duck after");
    assert_eq!(
        recipe_before, recipe_after,
        "recipe untouched after Abort (AC2 原状保留)"
    );
}

#[test]
fn resume_reports_drift_without_silently_replaying() {
    // AC3: source content changed at the same path -> Drift -> the engine
    // NEVER silently replays with the new data. User chooses Rebuild -> source
    // dropped, the chain's turn referencing it renders as Failed (not silent).
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let original = plant_people(dir.path());
    let session = build_single_source_session(&duck, &original);
    drop(session);

    // Replace the content in place (different fingerprint = drift).
    fs::write(&original, "id,name,score\n9,Zoe,1.1\n").expect("write drifted content");

    let drift_seen = Rc::new(RefCell::new(false));
    let drift_for_cb = Rc::clone(&drift_seen);
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        move |issue| match issue {
            SourceIssue::Drift { reference_name, .. } => {
                assert_eq!(reference_name, "people");
                *drift_for_cb.borrow_mut() = true;
                SourceResolution::Rebuild
            }
            SourceIssue::Missing { .. } => panic!("expected Drift, got Missing"),
            SourceIssue::Unreadable { .. } => panic!("expected Drift, got Unreadable"),
        },
        // active = people was rebuilt, but no other sources remain -> empty
        // working set, no callback (AC5 supplement).
        |_| ActiveResolution::Abort,
    )
    .expect("resume");

    assert!(
        *drift_seen.borrow(),
        "Drift was reported (no silent replay)"
    );
    // The drifted source was dropped (Rebuild), and result_1's SQL (which
    // names "people") failed on replay -> Failed, not materialized.
    assert!(
        resumed.get("people").is_none(),
        "drifted source dropped after Rebuild"
    );
    assert!(
        resumed.get("result_1").is_none(),
        "result_1 NOT silently materialized from drifted data"
    );
    // The timeline shows result_1 as Failed (ADR-0028 outcome C) -- the
    // honest presentation, not a silent gap.
    let result_1_failed = resumed.conversation().iter().any(|e| match e {
        ThreadEntry::Turn(t) => {
            t.question == "多少人" && matches!(&t.outcome, TurnOutcome::Failed { .. })
        }
        _ => false,
    });
    assert!(
        result_1_failed,
        "result_1 rendered as Failed (drift disclosed)"
    );
}

#[test]
fn resume_aborts_on_drift_without_replaying() {
    // AC3 (中止 branch): source content drifted at the same path -> Drift ->
    // user picks Abort -> resume stops, session is NOT entered, recipe is left
    // byte-for-byte untouched. Mirrors AC2's Missing+Abort contract; the
    // Rebuild branch is covered by resume_reports_drift_without_silently_replaying.
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let original = plant_people(dir.path());
    let session = build_single_source_session(&duck, &original);
    drop(session);

    let recipe_before = fs::read_to_string(&duck).expect("read .duck");

    // Replace the content in place (different fingerprint = drift).
    fs::write(&original, "id,name,score\n9,Zoe,1.1\n").expect("write drifted content");

    let drift_seen = Rc::new(RefCell::new(false));
    let drift_for_cb = Rc::clone(&drift_seen);
    let outcome = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        move |issue| match issue {
            SourceIssue::Drift { reference_name, .. } => {
                assert_eq!(reference_name, "people");
                *drift_for_cb.borrow_mut() = true;
                SourceResolution::Abort
            }
            SourceIssue::Missing { .. } => panic!("expected Drift, got Missing"),
            SourceIssue::Unreadable { .. } => panic!("expected Drift, got Unreadable"),
        },
        |_| ActiveResolution::Abort,
    );
    match outcome {
        Err(ResumeError::Aborted) => {}
        Err(other) => panic!("expected Aborted, got: {other}"),
        Ok(_) => panic!("expected Aborted, but resume succeeded"),
    }

    assert!(
        *drift_seen.borrow(),
        "Drift was reported before abort (no silent replay)"
    );

    // The on-disk recipe is unchanged -- Abort does not persist partial state.
    let recipe_after = fs::read_to_string(&duck).expect("read .duck after");
    assert_eq!(
        recipe_before, recipe_after,
        "recipe untouched after Drift+Abort (AC3 中止原状保留)"
    );
}

#[test]
fn resume_handles_each_source_independently_multi_source() {
    // AC4: a multi-source session where ONE source is missing and the others
    // are intact. The missing source goes through re-link; the intact source
    // verifies normally. Each source is handled independently.
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people_p = plant_people(dir.path());
    let orders_p = dir.path().join("orders.csv");
    fs::copy(fixture("orders.csv"), &orders_p).expect("copy orders.csv");

    let provider = FakeProvider::new()
        .scripted(
            "多少人",
            reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
        )
        .scripted(
            "多少单",
            reply_sql("SELECT COUNT(*) AS n FROM \"orders\".data"),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &people_p);
    load_source(&mut session, &orders_p);
    let _ = session.ask("多少人"); // result_1 from people
    let _ = session.ask("多少单"); // result_2 from orders
    session
        .bind_duck(duck.clone(), "multi".into())
        .expect("bind");
    drop(session);

    // Move ONLY people away; orders stays put.
    let moved_people = dir.path().join("moved-people.csv");
    fs::rename(&people_p, &moved_people).expect("move people");

    let moved_for_cb = moved_people.clone();
    let missing_seen = Rc::new(RefCell::new(0usize));
    let seen_for_cb = Rc::clone(&missing_seen);
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        move |issue| match issue {
            SourceIssue::Missing { reference_name, .. } if reference_name == "people" => {
                *seen_for_cb.borrow_mut() += 1;
                SourceResolution::Relink(moved_for_cb.clone())
            }
            other => panic!("expected Missing for people only, got {other:?}"),
        },
        // active = orders (last registered) is intact, so this never fires.
        |_| ActiveResolution::Abort,
    )
    .expect("resume");

    assert_eq!(
        *missing_seen.borrow(),
        1,
        "people went through re-link exactly once"
    );
    // Both sources ended up in the working set -- people re-linked, orders
    // verified normally without any callback.
    assert!(resumed.get("people").is_some(), "people re-linked");
    assert!(resumed.get("orders").is_some(), "orders verified normally");
    // Both productive turns replayed.
    assert!(resumed.get("result_1").is_some());
    assert!(resumed.get("result_2").is_some());
}

#[test]
fn resume_blocks_when_active_source_abandoned_until_user_picks() {
    // AC5: the active source is rebuilt AND other sources remain -> the engine
    // does NOT auto-fallback. on_active_abandoned fires with the remaining
    // menu; the user must name an explicit continuation source.
    use toptopduck_lib::persistence::read_duck;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people_p = plant_people(dir.path());
    let orders_p = dir.path().join("orders.csv");
    fs::copy(fixture("orders.csv"), &orders_p).expect("copy orders.csv");

    let provider = FakeProvider::new().scripted(
        "多少人",
        reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &orders_p); // orders first
    load_source(&mut session, &people_p); // people second -> active = people
    let _ = session.ask("多少人");
    session
        .bind_duck(duck.clone(), "active-abandon".into())
        .expect("bind");
    drop(session);

    // Sanity: the recipe persisted active = people (the last-registered source).
    let recipe_before = read_duck(&duck).expect("read before");
    assert_eq!(recipe_before.active.as_deref(), Some("people"));

    // Move people (the active source) away + Rebuild it on resume.
    let moved_people = dir.path().join("moved.csv");
    fs::rename(&people_p, &moved_people).expect("move people");

    let active_calls = Rc::new(RefCell::new(0usize));
    let calls_for_cb = Rc::clone(&active_calls);
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        // Rebuild the missing active source.
        |issue| match issue {
            SourceIssue::Missing { reference_name, .. } if reference_name == "people" => {
                SourceResolution::Rebuild
            }
            other => panic!("unexpected issue: {other:?}"),
        },
        move |abandoned: ActiveAbandoned| {
            *calls_for_cb.borrow_mut() += 1;
            assert_eq!(abandoned.abandoned, "people");
            assert!(
                abandoned.remaining.contains(&"orders".to_string()),
                "remaining menu includes orders: {:?}",
                abandoned.remaining
            );
            ActiveResolution::ContinueWith("orders".into())
        },
    )
    .expect("resume");

    assert_eq!(
        *active_calls.borrow(),
        1,
        "on_active_abandoned fired exactly once"
    );
    // orders survived; the active pointer moved to the user's explicit choice.
    assert!(resumed.get("orders").is_some(), "orders still registered");
    assert!(resumed.get("people").is_none(), "people rebuilt (dropped)");
    // The persisted recipe now records active = orders.
    let recipe_after = read_duck(&duck).expect("read after");
    assert_eq!(
        recipe_after.active.as_deref(),
        Some("orders"),
        "active pointer moved to the user's explicit continuation"
    );
}

#[test]
fn resume_active_abandoned_no_sources_left_resumes_empty_without_callback() {
    // AC5 supplement: the ONLY source (which is active) is rebuilt -> the
    // working set goes empty + active becomes None. on_active_abandoned does
    // NOT fire (nothing to choose from -- the empty state IS the honest end).
    use toptopduck_lib::persistence::read_duck;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people_p = plant_people(dir.path());
    let session = build_single_source_session(&duck, &people_p);
    drop(session);

    // Drift the only source -> Rebuild -> empty working set.
    fs::write(&people_p, "id,name,score\n9,Zoe,1.1\n").expect("write drifted");

    let active_called = Rc::new(RefCell::new(false));
    let called_for_cb = Rc::clone(&active_called);
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        |_| SourceResolution::Rebuild,
        move |_| {
            *called_for_cb.borrow_mut() = true;
            ActiveResolution::Abort
        },
    )
    .expect("resume");

    assert!(
        !*active_called.borrow(),
        "no on_active_abandoned callback when no sources remain"
    );
    assert!(resumed.list().is_empty(), "empty working set");
    let recipe = read_duck(&duck).expect("read");
    assert_eq!(recipe.active, None, "active None after empty resume");
    assert!(
        recipe.sources.is_empty(),
        "rebuilt source dropped from recipe"
    );
}

#[test]
fn resume_replay_failure_marks_turn_failed_and_preserves_prior_results() {
    // AC6: replay reaches turn K whose SQL fails -> turn K is rendered as
    // Failed (ADR-0028 outcome C), replay STOPS at K, and the K-1 results
    // already materialized stay in the working set. Turns after K are dropped.
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people_p = plant_people(dir.path());
    let orders_p = dir.path().join("orders.csv");
    fs::copy(fixture("orders.csv"), &orders_p).expect("copy orders.csv");

    let provider = FakeProvider::new()
        .scripted(
            "多少人",
            reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
        )
        .scripted(
            "多少单",
            reply_sql("SELECT COUNT(*) AS n FROM \"orders\".data"),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &orders_p); // orders first
    load_source(&mut session, &people_p); // people second -> active = people
    let _ = session.ask("多少人"); // result_1 from people
    let _ = session.ask("多少单"); // result_2 from orders
    session
        .bind_duck(duck.clone(), "break".into())
        .expect("bind");
    drop(session);

    // Move orders away + Rebuild it on resume. active = people stays valid, so
    // no active-abandoned callback. result_1 (people) replays fine; result_2
    // (orders) fails because orders is gone -> break at result_2.
    let moved_orders = dir.path().join("moved-orders.csv");
    fs::rename(&orders_p, &moved_orders).expect("move orders");

    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        |issue| match issue {
            SourceIssue::Missing { reference_name, .. } if reference_name == "orders" => {
                SourceResolution::Rebuild
            }
            other => panic!("unexpected issue: {other:?}"),
        },
        // active = people is intact -> never fires.
        |_| ActiveResolution::Abort,
    )
    .expect("resume");

    // K-1 = result_1 preserved in the working set.
    assert!(
        resumed.get("result_1").is_some(),
        "result_1 (K-1) preserved after the break"
    );
    // K = result_2 NOT materialized (replay broke here).
    assert!(
        resumed.get("result_2").is_none(),
        "result_2 (K) NOT materialized -- replay stopped"
    );
    // The timeline shows result_2 as Failed (ADR-0028 outcome C) and nothing
    // after it (truncated at the breakpoint).
    let mut found_failed = false;
    let mut idx = 0;
    for (i, entry) in resumed.conversation().iter().enumerate() {
        if let ThreadEntry::Turn(t) = entry {
            if t.question == "多少单" {
                found_failed = matches!(&t.outcome, TurnOutcome::Failed { .. });
                idx = i;
                break;
            }
        }
    }
    assert!(
        found_failed,
        "result_2 rendered as Failed (ADR-0028 outcome C)"
    );
    // No turn entries after the break turn (source events after it are also
    // dropped -- the conversation stops at the breakpoint).
    let after = &resumed.conversation()[idx + 1..];
    assert!(
        after.is_empty(),
        "no entries after the breakpoint, got {after:?}"
    );
    // AC7 (no cloud LLM): resume succeeded with UnwiredProvider, which would
    // have returned NotWired on any provider.generate() call. The whole
    // productive chain replayed LLM-free.
}
