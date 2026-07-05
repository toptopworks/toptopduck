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

use toptopduck_lib::persistence::SaveError;
use toptopduck_lib::{
    ActiveAbandoned, ActiveResolution, CancelToken, FakeProvider, LoadOutcome, PendingConflict,
    ProviderReply, ResumeError, ResumeEvent, Session, SourceIssue, SourceResolution, TextKind,
    ThreadEntry, TurnOutcome, UnwiredProvider,
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

/// Mirror of `load_source` for the replace path (L5): `replace_source` returns
/// `LoadOutcome`, not `Result`, so a bare call silently drops a non-`Loaded`
/// outcome. Asserting `Loaded` here keeps the replace tests honest if the
/// signature ever flips to a fallible form.
fn replace_source_loaded(session: &mut Session, reference_name: &str, path: &Path) {
    match session.replace_source(reference_name, path) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace_source to load, got {other:?}"),
    }
}

/// AC4 evidence (issue #52): source ops and turn finalization share a single
/// `save_atomic` temp+rename path. After a successful rewrite the `.tmp` is
/// consumed by the rename and the bind dir holds only the `.duck`. A black box
/// cannot name the code path, but this pins its observable signature -- a
/// regression introducing a second non-atomic write would leave a temp residue
/// or a different artifact. `TMP_SUFFIX` is `io.rs`-private, so the `.tmp`
/// literal here is duplicated against that constant.
fn assert_save_atomic_left_no_residue(duck: &Path) {
    let tmp = duck.with_file_name(format!(
        "{}.tmp",
        duck.file_name()
            .expect("duck has a file name")
            .to_str()
            .expect("duck file name is utf-8"),
    ));
    assert!(
        !tmp.exists(),
        "save_atomic must consume its temp via rename; found {tmp:?}",
    );
    let artifacts: Vec<String> = fs::read_dir(duck.parent().expect("duck has a parent"))
        .expect("read bind dir")
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| !t.is_dir()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let expected = duck
        .file_name()
        .expect("duck file name")
        .to_string_lossy()
        .into_owned();
    assert_eq!(
        artifacts,
        vec![expected],
        "bind dir holds only the .duck after atomic rewrite (AC4 single-path signature)",
    );
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

// --- Concurrency: in-process single-writer + external-change detection -----
//
// ADR-0035 Decision 3 / issue #50: the same `.duck` opened twice in one process is
// refused (process-local registry, zero OS locks); every auto-write hashes the
// file first and suspends + surfaces a conflict if the on-disk content drifted
// (never a silent clobber). The three resolutions (reload / keep mine / save
// as new) are each exercised below.

/// AC1: same `.duck` in the same process -> a second open is refused (clear
/// error, never a silent second writer). Both the resume (`open_duck`) and the
/// save (`bind_duck`) entry points enforce the gate.
#[test]
fn single_writer_rejects_opening_same_duck_twice() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let _session = build_session(&duck); // acquires the canonical path; held to end

    // open_duck on the same path -> ResumeError::AlreadyOpen.
    let (_events, cb) = collect_events();
    let err = resume_defaults(&duck, Arc::new(CancelToken::new()), cb)
        .err()
        .expect("AlreadyOpen");
    match err {
        ResumeError::AlreadyOpen(p) => assert_eq!(
            p,
            duck.canonicalize().expect("canonicalize duck"),
            "AlreadyOpen carries the canonical path so the UI can name the file"
        ),
        other => panic!("open_duck should refuse a duplicate opener, got {other:?}"),
    }

    // bind_duck on the same path from a SECOND session -> SaveError::AlreadyOpen.
    let mut second = Session::with_provider(Box::new(FakeProvider::new())).expect("session");
    let err = second.bind_duck(duck.clone(), "第二份".into()).unwrap_err();
    match err {
        SaveError::AlreadyOpen(p) => assert_eq!(
            p,
            duck.canonicalize().expect("canonicalize duck"),
            "AlreadyOpen carries the canonical path so the UI can name the file"
        ),
        other => panic!("bind_duck should refuse a duplicate opener, got {other:?}"),
    }
    // The second session never bound: a subsequent different path works (the
    // failed acquire left no stray registry entry).
    let other = dir.path().join("other.duck");
    second
        .bind_duck(other, "其它".into())
        .expect("bind to a different path after a refused duplicate");
    // `session` + `second` dropped here -> both registry keys released.
}

/// AC2: different `.duck` paths coexist -- two sessions on two files in one
/// process are NOT false-rejected.
#[test]
fn single_writer_allows_two_different_ducks_in_one_process() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck_a = dir.path().join("a.duck");
    let duck_b = dir.path().join("b.duck");
    let session_a = build_session(&duck_a);
    let session_b = build_session(&duck_b);
    assert_eq!(session_a.duck_path(), Some(duck_a.as_path()));
    assert_eq!(session_b.duck_path(), Some(duck_b.as_path()));
    // Both held simultaneously; neither was rejected.
}

/// ADR-0035 Decision 3 (drop + reopen): releasing the registry on Drop is what makes
/// the "reload" conflict-resolution path work -- the caller drops the session,
/// then reopens the file. Verified end-to-end here as a precondition for the
/// reload test below.
#[test]
fn single_writer_releases_on_drop_allowing_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let session = build_session(&duck);
    drop(session); // registry key released

    let (_events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("reopen");
    assert_eq!(resumed.duck_path(), Some(duck.as_path()));
}

/// Re-binding the SAME canonical path on the SAME session is an update (Save
/// over the open file), NOT a second opener -- the registry must not reject a
/// session's own re-save. Without this carve-out every "Save" click on an open
/// file would falsely fail.
#[test]
fn single_writer_rebind_same_path_on_same_session_is_an_update() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let mut session = build_session(&duck);
    session
        .bind_duck(duck.clone(), "改个名".into())
        .expect("re-bind same path on same session is an update");
    assert_eq!(session.session_name(), Some("改个名"));
}

/// AC3 / #50 main seam: open a `.duck` -> edit it externally (change its hash)
/// -> trigger the next auto-write -> the engine detects the mismatch,
/// SUSPENDS the write, and surfaces a [`PendingConflict`]. The on-disk file is
/// left as the external editor left it (NEVER silently clobbered).
#[test]
fn external_edit_suspends_next_write_and_surfaces_conflict() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let mut session = build_session(&duck);

    // Simulate an external edit: another window / text editor / sync tool
    // changed the file's session_name after our baseline write. Keep it a
    // valid recipe so the reload test's open_duck can parse it later.
    let original = fs::read_to_string(&duck).expect("read baseline");
    let external = original.replace("\"分析 A\"", "\"外部编辑\"");
    assert_ne!(external, original, "external edit must change the bytes");
    fs::write(&duck, &external).expect("external write");

    // Trigger an auto-write by adding a source (append_source_event ->
    // persist_if_bound runs the hash check).
    load_source(&mut session, &fixture("orders.csv"));

    // AC: conflict surfaced, not silently clobbered.
    let conflict: PendingConflict = session
        .take_pending_conflict()
        .expect("external edit must surface a conflict");
    assert_eq!(conflict.path, duck);
    assert_ne!(
        conflict.expected_hash, conflict.found_hash,
        "the two hashes differ -- that IS the conflict"
    );

    // AC: the write was suspended -- the disk file is still the external edit.
    let disk = fs::read_to_string(&duck).expect("read disk");
    assert!(
        disk.contains("外部编辑"),
        "disk must be unchanged (write suspended), got: {disk}"
    );
    // The in-memory session DID advance (orders source loaded) -- the turn /
    // source event is never blocked by a persistence conflict.
    assert!(
        session.list().iter().any(|d| d.reference_name == "orders"),
        "in-memory state advanced despite the suspended write"
    );
    // Pending stays Some until the caller resolves (a second take returns None
    // because the first cleared it).
    assert!(session.take_pending_conflict().is_none());
}

/// AC4/5 "Keep Mine": the user explicitly chooses to overwrite the externally-
/// edited file with the in-memory state. After resolution the disk carries the
/// in-memory recipe, the baseline is refreshed, and a subsequent auto-write
/// does NOT re-conflict.
#[test]
fn conflict_keep_mine_overwrites_disk_with_inmemory_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let mut session = build_session(&duck);

    let original = fs::read_to_string(&duck).expect("read baseline");
    fs::write(&duck, original.replace("\"分析 A\"", "\"外部编辑\"")).expect("external write");

    load_source(&mut session, &fixture("orders.csv"));
    let _conflict = session
        .take_pending_conflict()
        .expect("conflict before resolution");

    // Resolve: keep mine (force-overwrite).
    session.conflict_keep_mine().expect("keep mine resolves");

    // Disk now reflects the in-memory recipe (the external edit is gone).
    let disk = fs::read_to_string(&duck).expect("read disk");
    assert!(
        disk.contains("\"分析 A\""),
        "in-memory session_name on disk after keep_mine"
    );
    assert!(
        !disk.contains("外部编辑"),
        "external edit overwritten by explicit keep_mine"
    );
    assert!(
        disk.contains("orders"),
        "the unwritten orders source landed on disk via keep_mine"
    );
    assert!(
        session.take_pending_conflict().is_none(),
        "conflict cleared after resolution"
    );

    // Baseline refreshed -> a follow-up auto-write does NOT re-conflict.
    load_source(&mut session, &fixture("leading_zero.csv"));
    assert!(
        session.take_pending_conflict().is_none(),
        "no re-conflict after keep_mine refreshed the baseline"
    );
}

/// AC4/5 "Save As New": write the in-memory recipe to a NEW path, leaving the
/// original (externally-edited) file untouched. The session re-binds to the
/// new path so subsequent auto-writes target it (not the preserved original).
#[test]
fn conflict_save_as_new_preserves_original_and_rebinds() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let new_duck = dir.path().join("saved.duck");
    let mut session = build_session(&duck);

    let original = fs::read_to_string(&duck).expect("read baseline");
    fs::write(&duck, original.replace("\"分析 A\"", "\"外部编辑\"")).expect("external write");

    load_source(&mut session, &fixture("orders.csv"));
    let _conflict = session.take_pending_conflict().expect("conflict");

    // Resolve: save as new.
    session
        .conflict_save_as_new(new_duck.clone())
        .expect("save as new resolves");

    // Original file is untouched (still the external edit).
    let original_disk = fs::read_to_string(&duck).expect("read original");
    assert!(
        original_disk.contains("外部编辑"),
        "original file preserved verbatim"
    );

    // New file carries the in-memory recipe.
    let new_disk = fs::read_to_string(&new_duck).expect("read new");
    assert!(
        new_disk.contains("\"分析 A\""),
        "new file has the in-memory session_name"
    );
    assert!(!new_disk.contains("外部编辑"));

    // Session re-bound to the new path; subsequent auto-writes land there.
    assert_eq!(session.duck_path(), Some(new_duck.as_path()));
    assert!(
        session.take_pending_conflict().is_none(),
        "conflict cleared"
    );
    load_source(&mut session, &fixture("leading_zero.csv"));
    let new_disk_after = fs::read_to_string(&new_duck).expect("read new again");
    assert!(
        new_disk_after.contains("leading_zero"),
        "follow-up auto-write targeted the new path"
    );
    let original_after = fs::read_to_string(&duck).expect("read original again");
    assert!(
        original_after.contains("外部编辑"),
        "original STILL untouched by the follow-up write"
    );
}

/// AC4/5 "Reload": discard the unwritten in-memory changes and re-read from
/// the disk file. Implemented as drop + `open_duck` -- the registry releases
/// on drop, and resume re-acquires + replays from the externally-edited file.
/// The unwritten orders source is discarded; the resumed session reflects the
/// disk state (the external edit's session_name + the original sources).
#[test]
fn conflict_reload_via_drop_and_reopen_adopts_disk_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let mut session = build_session(&duck);

    let original = fs::read_to_string(&duck).expect("read baseline");
    let external = original.replace("\"分析 A\"", "\"外部版本\"");
    fs::write(&duck, &external).expect("external write");

    load_source(&mut session, &fixture("orders.csv"));
    let _conflict = session.take_pending_conflict().expect("conflict");

    // Resolve: reload = drop + reopen.
    drop(session);
    let (_events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("reload");

    // The resumed session carries the DISK state (external edit), not the
    // in-memory orders source that was never written.
    assert_eq!(
        resumed.session_name(),
        Some("外部版本"),
        "session_name from the externally-edited recipe"
    );
    assert!(
        !resumed.list().iter().any(|d| d.reference_name == "orders"),
        "unwritten orders source discarded by reload"
    );
    assert!(
        resumed.list().iter().any(|d| d.reference_name == "people"),
        "original people source restored from disk recipe"
    );
}

/// Edge guard: a STABLE file across resume must NOT produce a false conflict.
/// The resume baseline is seeded from the file as read; resume's own post-
/// resume write refreshes the baseline in lockstep, so the next auto-write
/// compares against what resume wrote (not the pre-resume bytes). This pins
/// the happy path so the external-edit detection does not cry wolf.
#[test]
fn stable_file_across_resume_produces_no_false_conflict() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let session = build_session(&duck);
    drop(session); // write the baseline recipe + release the registry

    let (_events, cb) = collect_events();
    let mut resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");
    assert!(
        resumed.take_pending_conflict().is_none(),
        "no false conflict when the file is stable across resume"
    );
    // A follow-up auto-write (add a source) on the resumed session also stays
    // conflict-free -- the baseline tracked resume's own write.
    load_source(&mut resumed, &fixture("orders.csv"));
    assert!(
        resumed.take_pending_conflict().is_none(),
        "follow-up write after resume does not false-conflict"
    );
}

/// Regression (ADR-0035 Decision 3 / #50): `conflict_save_as_new` must release the
/// OLD canonical key on success so a different session can subsequently open
/// the original file. An earlier ordering released the old key BEFORE the
/// post-write hash; on a hash failure the new key leaked (the session had
/// already dropped the old canonical, so its Drop could not release the new
/// key it never recorded) and the session stayed bound to the old path whose
/// key was gone -- a second session could open the same file, breaking the
/// single-writer contract. The fix hashes before releasing; this test pins
/// the success-path invariant (old key released, original reopenable).
#[test]
fn conflict_save_as_new_releases_old_key_so_original_can_be_reopened() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let new_duck = dir.path().join("saved.duck");
    let mut session = build_session(&duck);

    let original = fs::read_to_string(&duck).expect("read baseline");
    fs::write(&duck, original.replace("\"分析 A\"", "\"外部编辑\"")).expect("external write");

    load_source(&mut session, &fixture("orders.csv"));
    let _conflict = session.take_pending_conflict().expect("conflict");

    session
        .conflict_save_as_new(new_duck.clone())
        .expect("save as new resolves");

    // The original file's registry key was released on the rebind -- once
    // this session drops the new key, a fresh session can resume the
    // original. single-writer must NOT false-reject a path moved away from.
    drop(session);
    let (_events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb)
        .expect("reopen original after save_as_new");
    assert_eq!(resumed.duck_path(), Some(duck.as_path()));
    // The original was preserved verbatim by save_as_new -- resume carries
    // the externally-edited recipe, not the in-memory state that moved away.
    assert_eq!(resumed.session_name(), Some("外部编辑"));
}

// --- Review follow-ups (issue #50 multi-perspective review) -----------------
//
// ADR-0035 Decision 3 edge cases the original slice did not pin: a resume-time
// external edit, suppression of further detection while a conflict is pending,
// and the bind_duck canonicalize-failure path.

/// ADR-0035 Decision 3 / issue #50: an external edit landing DURING the resume
/// phases (re-ingest / replay can take seconds) must surface as a pending
/// conflict at the post-resume persist -- never a silent clobber. The resume
/// baseline is seeded from the file AS READ at `open_duck` entry; the
/// post-resume `persist_if_bound` re-hashes and finds the divergence.
#[test]
fn external_edit_during_resume_surfaces_conflict_at_post_resume_persist() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let session = build_session(&duck);
    drop(session); // write the baseline recipe + release the registry key

    // Inject an external edit on the first Source progress event -- the
    // resume baseline was seeded BEFORE this edit, so the post-resume persist
    // sees a hash divergence.
    let mut injected = false;
    let mut resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |ev| {
            if !injected {
                if let ResumeEvent::Source { .. } = ev {
                    let original = fs::read_to_string(&duck).expect("read baseline");
                    let external = original.replace("\"分析 A\"", "\"外部版本\"");
                    fs::write(&duck, &external).expect("external write during resume");
                    injected = true;
                }
            }
        },
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    )
    .expect("resume completes; the edit surfaces at persist, not as a resume error");

    assert!(injected, "the progress callback fired and the edit landed");
    let conflict = resumed
        .take_pending_conflict()
        .expect("resume-time external edit must surface a conflict");
    assert_eq!(conflict.path, duck);
    assert_ne!(
        conflict.expected_hash, conflict.found_hash,
        "the two hashes differ -- that IS the conflict"
    );

    // The disk file is the external edit -- the post-resume write was suspended.
    let disk = fs::read_to_string(&duck).expect("read disk");
    assert!(
        disk.contains("外部版本"),
        "disk carries the external edit, not the in-memory recipe: {disk}"
    );
}

/// ADR-0035 Decision 3 / issue #50: while a conflict is pending, subsequent
/// auto-writes skip BOTH the hash check AND the write -- the caller has not
/// resolved the prior divergence, so re-detecting would overwrite the stashed
/// notice, and writing would clobber the externally-edited file. Pins the
/// guard so a future refactor cannot silently drop it.
#[test]
fn persist_if_bound_skips_detection_and_write_while_conflict_pending() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");
    let mut session = build_session(&duck);

    // First external edit -> triggers persist_if_bound -> conflict surfaced.
    // The caller does NOT take it (mid-decision); the pending notice stays.
    let original = fs::read_to_string(&duck).expect("read baseline");
    let first_edit = original.replace("\"分析 A\"", "\"外部编辑\"");
    fs::write(&duck, &first_edit).expect("first external write");
    load_source(&mut session, &fixture("orders.csv"));

    // Second external edit + a second auto-write trigger. While the first
    // conflict is pending, persist_if_bound must skip detection AND the write.
    let second_edit = first_edit.replace("外部编辑", "再次外部编辑");
    fs::write(&duck, &second_edit).expect("second external write");
    load_source(&mut session, &fixture("leading_zero.csv"));

    // The disk is still the second external edit -- NO auto-write landed while
    // the conflict was pending.
    let disk = fs::read_to_string(&duck).expect("read disk");
    assert!(
        disk.contains("再次外部编辑"),
        "no write landed while conflict was pending: {disk}"
    );
    assert!(
        !disk.contains("leading_zero"),
        "the second auto-write was suspended (pending conflict): {disk}"
    );

    // The first conflict stayed stashed while pending; taking it now returns
    // the original notice (the caller never resolved it).
    let conflict = session
        .take_pending_conflict()
        .expect("the first conflict is still pending");
    assert_eq!(conflict.path, duck);
    // A second take is None (the first take cleared it).
    assert!(
        session.take_pending_conflict().is_none(),
        "take cleared the conflict; a second take is None"
    );
}

/// ADR-0035 Decision 3 / #50: bind_duck to a path whose parent does not exist
/// fails `canonicalize_duck` -> `SaveError::Io`. The session stays unbound (no
/// stray registry entry, no duck_path set) so a retry on a real path works.
#[test]
fn bind_duck_canonicalize_failure_returns_save_error_io_and_leaves_session_unbound() {
    let dir = tempfile::tempdir().expect("tempdir");
    let nonexistent_parent = dir.path().join("missing-dir").join("a.duck");
    assert!(
        !nonexistent_parent.parent().unwrap().exists(),
        "precondition: parent dir does not exist"
    );

    let mut session = Session::with_provider(Box::new(FakeProvider::new())).expect("session");
    let err = session
        .bind_duck(nonexistent_parent, "失败".into())
        .unwrap_err();
    assert!(
        matches!(err, SaveError::Io(_)),
        "canonicalize failure -> SaveError::Io, got {err:?}"
    );

    // The session stayed unbound: duck_path is None, no registry entry leaked.
    assert!(
        session.duck_path().is_none(),
        "failed bind left no duck_path"
    );

    // Registry hygiene: a fresh bind to a real path works (the failed
    // canonicalize never reached try_acquire, so no key leaked).
    let real = dir.path().join("real.duck");
    session
        .bind_duck(real.clone(), "真实".into())
        .expect("bind to a real path after a canonicalize failure");
    assert_eq!(session.duck_path(), Some(real.as_path()));
}

// --- Issue #51: format_version routing + hybrid source paths (ADR-0036) -----
//
// Two ADR-0036 contracts exercised end-to-end across the open_duck seam:
// (1) format_version routing -- a hand-written LOWER-version .duck
// forward-migrates in memory and the post-resume auto-write lands the
// current-version shape on disk (longevity: older files stay openable, and
// the migration is durable, not just in-memory);
// (2) hybrid source paths -- a source recorded with BOTH a relative and an
// absolute path resolves correctly under folder moves (relative primary),
// falls back to the absolute when the relative dangles, and surfaces re-link
// when both fail (ADR-0035 honest degrade). The "higher version honest
// refuse" path is covered by the io unit test read_refuses_a_higher_format_version.

/// AC5/AC8: open a hand-written v0 .duck -> forward-migrates -> resumes
/// normally -> the post-resume auto-write lands the migrated v1 shape on
/// disk. Pins ADR-0036's longevity contract for the lower-version branch.
#[test]
fn open_duck_migrates_a_lower_version_recipe_and_persists_current_shape() {
    use toptopduck_lib::persistence::{read_duck, RECIPE_FORMAT_VERSION};

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("v0.duck");
    let csv = fixture("people.csv");

    // Build a real v1 session first to capture the post-rectify fingerprint of
    // people.csv under the same ingest path the v0 recipe will name.
    let session = build_single_source_session(&duck, &csv);
    let fingerprint = session.get("people").expect("people").fingerprint.clone();
    let csv_path = csv.to_string_lossy().to_string();
    drop(session);

    // Overwrite the .duck with a synthetic v0 shape. Two migration-relevant
    // features: sources[*] missing display_name (filled by the v0->v1
    // transform), and the outcome tagged outcome_kind (renamed to kind). The
    // source lives outside the .duck tempdir (fixture path), so its absolute
    // path is the resolver.
    let v0 = serde_json::json!({
        "format_version": 0,
        "session_name": "v0 分析",
        "sources": [{
            "reference_name": "people",
            "source_path": csv_path,
            "fingerprint": fingerprint,
        }],
        "history": [{
            "entry": "Turn",
            "data": {
                "question": "多少人",
                "outcome": {
                    "outcome_kind": "Materialized",
                    "data": {
                        "reference_name": "result_1",
                        "display_name": "result_1",
                        "sql": "SELECT COUNT(*) AS n FROM \"people\".data",
                    },
                },
            },
        }],
        "active": "people",
    });
    fs::write(&duck, serde_json::to_string(&v0).unwrap()).expect("write v0");

    // Resume: forward-migrate -> re-ingest (fingerprint match) -> replay ->
    // post-resume persist lands the migrated v1 shape.
    let (_events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");

    // The migrated display_name (filled from reference_name) survived into the
    // working set.
    let people = resumed.get("people").expect("people present");
    assert_eq!(
        people.display_name, "people",
        "migrated display_name restored"
    );
    assert!(resumed.get("result_1").is_some(), "result_1 replayed");

    // The on-disk .duck is now the migrated v1 shape (read_duck reads it
    // back at current version; the legacy outcome_kind field is gone).
    let persisted = read_duck(&duck).expect("read persisted");
    assert_eq!(persisted.format_version, RECIPE_FORMAT_VERSION);
    assert_eq!(persisted.sources[0].display_name, "people");
    let disk = fs::read_to_string(&duck).expect("read disk");
    assert!(
        !disk.contains("outcome_kind"),
        "legacy outcome_kind gone after migration persisted: {disk}",
    );

    // ADR-0036 KISS (issue #51 AC5): migration lands the new shape via the
    // normal atomic save -- it does NOT back up the original v0 bytes. The
    // .duck's directory holds exactly the rewritten file: no `.bak`, no `~`,
    // no shadow copy, no stale `.tmp` left by save_atomic.
    let mut dir_entries: Vec<String> = fs::read_dir(duck.parent().expect("duck has parent"))
        .expect("read dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    dir_entries.sort();
    assert_eq!(
        dir_entries,
        vec!["v0.duck".to_string()],
        "no backup produced by migration (only the rewritten .duck on disk)",
    );
}

/// AC1: move the .duck AND its in-subtree source together -> the relative
/// path resolves against the .duck's NEW parent, so no re-link fires and the
/// source re-ingests cleanly. This is the "just works" portability promise
/// ADR-0036 hybrid paths makes for folder moves.
#[test]
fn resume_resolves_relative_path_after_moving_the_folder() {
    use toptopduck_lib::persistence::read_duck;

    let dir = tempfile::tempdir().expect("tempdir");
    let sub = dir.path().join("sub");
    fs::create_dir(&sub).expect("mkdir");
    let csv = sub.join("people.csv");
    fs::copy(fixture("people.csv"), &csv).expect("copy into subtree");
    let duck = sub.join("s.duck");

    let session = build_single_source_session(&duck, &csv);
    // Precondition: in-subtree -> relative path recorded (boundary case where
    // BOTH a relative and an absolute representation are stored).
    let persisted = read_duck(&duck).expect("read");
    assert_eq!(
        persisted.sources[0].relative_path.as_deref(),
        Some("people.csv"),
        "precondition: relative path recorded for in-subtree source",
    );
    drop(session);

    // Move the entire subtree (both .duck + source) to a sibling location.
    let moved = dir.path().join("moved");
    fs::rename(&sub, &moved).expect("move subtree");
    let moved_duck = moved.join("s.duck");

    // Resume on the moved .duck: resolve_source_path joins the relative path
    // against the .duck's NEW parent -> moved/people.csv exists -> match.
    let resumed =
        resume_defaults(&moved_duck, Arc::new(CancelToken::new()), |_| {}).expect("resume");
    assert!(
        resumed.get("people").is_some(),
        "people resolved via relative path after the folder move",
    );
    assert!(
        resumed.get("result_1").is_some(),
        "result_1 replayed without re-link",
    );
}

/// AC3: a boundary-case source (BOTH relative + absolute stored) whose
/// relative candidate is missing falls back to the absolute path and the
/// fingerprint check passes. ADR-0036's "both stored" makes the absolute a
/// real safety net, not a decorative second copy.
#[test]
fn resume_falls_back_to_absolute_when_relative_path_is_missing() {
    use toptopduck_lib::persistence::{save_atomic, Recipe, SourceRef, RECIPE_FORMAT_VERSION};
    use toptopduck_lib::RectifyProvenance;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    // A real source whose absolute path is resolvable.
    let outside = dir.path().join("data.csv");
    fs::write(&outside, "name,score\nAda,9\n").expect("write source");

    // Ingest once to capture the fingerprint, then drop and hand-write a
    // recipe with a STALE relative path (inner/missing.csv) alongside the
    // real absolute path.
    let mut probe = Session::with_provider(Box::new(FakeProvider::new())).expect("session");
    load_source(&mut probe, &outside);
    let fingerprint = probe.get("data").expect("data").fingerprint.clone();
    drop(probe);

    let recipe = Recipe {
        format_version: RECIPE_FORMAT_VERSION,
        session_name: "boundary".into(),
        sources: vec![SourceRef {
            reference_name: "data".into(),
            display_name: "data".into(),
            source_path: outside.to_string_lossy().to_string(),
            relative_path: Some("inner/missing.csv".into()),
            rectify: RectifyProvenance::NotApplicable,
            fingerprint,
        }],
        history: vec![],
        active: None,
    };
    save_atomic(&duck, &recipe).expect("save");

    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), |_| {}).expect("resume");
    assert!(
        resumed.get("data").is_some(),
        "absolute fallback resolved (relative candidate missing)",
    );
}

/// AC4: a boundary-case source (relative + absolute both stored) whose file
/// is gone entirely surfaces as Missing and goes through re-link (ADR-0035
/// honest degrade). The boundary case must not silently pick one
/// representation and paper over the missing-file reality.
#[test]
fn resume_relinks_when_both_relative_and_absolute_paths_fail() {
    let dir = tempfile::tempdir().expect("tempdir");
    let sub = dir.path().join("sub");
    fs::create_dir(&sub).expect("mkdir");
    let csv = sub.join("people.csv");
    fs::copy(fixture("people.csv"), &csv).expect("copy into subtree");
    let duck = sub.join("s.duck");

    let session = build_single_source_session(&duck, &csv);
    // Precondition: boundary case -> relative + absolute both stored.
    let persisted = toptopduck_lib::persistence::read_duck(&duck).expect("read");
    assert!(
        persisted.sources[0].relative_path.is_some(),
        "precondition: relative path stored for in-subtree source",
    );
    drop(session);

    // Remove the source entirely (both representations now dangle).
    fs::remove_file(&csv).expect("remove source");

    // Plant a relink target elsewhere in the subtree.
    let relocated = sub.join("moved-people.csv");
    fs::copy(fixture("people.csv"), &relocated).expect("plant relink target");
    let relocated_for_cb = relocated.clone();

    let missing_seen = Rc::new(RefCell::new(false));
    let seen_for_cb = Rc::clone(&missing_seen);
    let resumed = Session::open_duck(
        &duck,
        Arc::new(CancelToken::new()),
        Box::new(UnwiredProvider),
        |_| {},
        move |issue| match issue {
            SourceIssue::Missing { reference_name, .. } => {
                assert_eq!(reference_name, "people");
                *seen_for_cb.borrow_mut() = true;
                SourceResolution::Relink(relocated_for_cb.clone())
            }
            other => panic!("expected Missing, got {other:?}"),
        },
        |_| ActiveResolution::Abort,
    )
    .expect("resume");

    assert!(
        *missing_seen.borrow(),
        "Missing fired for the boundary-case source",
    );
    assert!(
        resumed.get("people").is_some(),
        "re-linked into the working set"
    );
    assert!(
        resumed.get("result_1").is_some(),
        "result_1 replayed after re-link",
    );
}

/// AC3: a boundary-case source (BOTH relative + absolute stored, ADR-0036)
/// whose relative candidate resolves FIRST -- the absolute is NOT consulted
/// even when it points at a DIFFERENT file. Pins the "relative primary,
/// absolute fallback" precedence (not "both tried, last wins"): a hand-edited
/// absolute pointing at a decoy must not paper over the in-subtree real file.
#[test]
fn resume_prefers_relative_when_both_paths_stored_and_match_fingerprint() {
    use toptopduck_lib::persistence::{save_atomic, Recipe, SourceRef, RECIPE_FORMAT_VERSION};
    use toptopduck_lib::RectifyProvenance;

    let dir = tempfile::tempdir().expect("tempdir");
    let sub = dir.path().join("sub");
    fs::create_dir(&sub).expect("mkdir");
    let duck = sub.join("s.duck");

    // The real in-subtree source the relative path will resolve to.
    let real = sub.join("data.csv");
    fs::write(&real, "name,score\nAda,9\n").expect("write real");

    // A decoy OUTSIDE the subtree whose content DIFFERS (different fingerprint).
    let decoy = dir.path().join("decoy.csv");
    fs::write(&decoy, "name,score\nBo,1\n").expect("write decoy");

    // Ingest the REAL file once to capture its fingerprint, then hand-write a
    // recipe whose source carries BOTH the decoy absolute and the real
    // relative -- the resolver must pick the relative (real) and the decoy's
    // bytes never reach the working set.
    let mut probe = Session::with_provider(Box::new(FakeProvider::new())).expect("session");
    load_source(&mut probe, &real);
    let fingerprint = probe.get("data").expect("data").fingerprint.clone();
    drop(probe);

    let recipe = Recipe {
        format_version: RECIPE_FORMAT_VERSION,
        session_name: "boundary".into(),
        sources: vec![SourceRef {
            reference_name: "data".into(),
            display_name: "data".into(),
            source_path: decoy.to_string_lossy().to_string(),
            relative_path: Some("data.csv".into()),
            rectify: RectifyProvenance::NotApplicable,
            fingerprint: fingerprint.clone(),
        }],
        history: vec![],
        active: None,
    };
    save_atomic(&duck, &recipe).expect("save");

    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), |_| {}).expect("resume");
    let data = resumed.get("data").expect("data present via relative");
    // The fingerprint matches the REAL file, not the decoy -- proof the
    // resolver went through the relative path, not the absolute.
    assert_eq!(
        data.fingerprint, fingerprint,
        "relative took precedence; decoy absolute never read",
    );
}

/// AC6: opening a hand-written .duck whose format_version is AHEAD of the
/// current app surfaces an honest refusal at the open_duck seam -- never a
/// silent mis-parse, never a partial session. The error reaches the caller
/// as `ResumeError::Load(LoadError::VersionMismatch)`, whose Display carries
/// the "请升级 app" prompt (ADR-0036 / ADR-0017 capability boundary at the
/// format layer). The unit test on `read_duck` covers the io layer; this
/// pins the full open_duck seam (read -> ResumeError::Load -> UI message).
#[test]
fn open_duck_refuses_a_higher_format_version_with_upgrade_prompt() {
    use toptopduck_lib::persistence::{LoadError, RECIPE_FORMAT_VERSION};

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("future.duck");
    let future = serde_json::json!({
        "format_version": RECIPE_FORMAT_VERSION + 1,
        "session_name": "from-the-future",
        "sources": [],
        "history": [],
        "active": null,
    });
    fs::write(&duck, serde_json::to_string(&future).unwrap()).expect("write future");

    let outcome = resume_defaults(&duck, Arc::new(CancelToken::new()), |_| {});
    let err = match outcome {
        Err(e) => e,
        Ok(_) => panic!("expected honest refuse, but resume succeeded"),
    };
    match &err {
        ResumeError::Load(LoadError::VersionMismatch { found, supported }) => {
            assert_eq!(*found, RECIPE_FORMAT_VERSION + 1);
            assert_eq!(*supported, RECIPE_FORMAT_VERSION);
        }
        other => panic!("expected VersionMismatch, got: {other:?}"),
    }
    let msg = err.to_string();
    assert!(
        msg.contains("请升级"),
        "upgrade prompt surfaces to the user: {msg}",
    );
}

// --- Issue #52: source lifecycle atomic write + stale resume exclusion -------
//
// ADR-0034/0040/0041: source ops (add/replace/remove) hit the SAME atomic
// temp+rename write path as turn finalization (AC4), and a cascade-invalidated
// result_N -- a stale dead turn -- stays in the recipe timeline for display +
// the LLM window (ADR-0041 point 2) but is excluded from the replay chain on
// resume (AC5). After reopen the stale result_N is still in the working set,
// marked stale (AC6, ADR-0013 -- never silently discarded).

/// AC1: adding a source after bind atomically rewrites the .duck -- the new
/// source is in `sources` and an Added event is in the timeline. The rewrite
/// goes through the same temp+rename path turns use (AC4).
#[test]
fn add_source_atomically_rewrites_duck_with_source_and_added_event() {
    use toptopduck_lib::persistence::{read_duck, RecipeEntry};
    use toptopduck_lib::SourceLifecycleKind;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let csv = fixture("people.csv");
    let mut session = Session::with_provider(Box::new(FakeProvider::new())).expect("session");
    load_source(&mut session, &csv);
    session
        .bind_duck(duck.clone(), "add-test".into())
        .expect("bind");

    let before = read_duck(&duck).expect("read before add");
    assert_eq!(
        before.sources.len(),
        1,
        "precondition: one source before add"
    );

    // Add a second source -- append_source_event -> persist_if_bound rewrites.
    load_source(&mut session, &fixture("orders.csv"));

    let after = read_duck(&duck).expect("read after add");
    assert_eq!(after.sources.len(), 2, "sources grew by one on disk");
    assert!(
        after.sources.iter().any(|s| s.reference_name == "orders"),
        "orders landed in the recipe source set"
    );
    let added_orders = after.history.iter().any(|e| match e {
        RecipeEntry::Source(ev) => {
            ev.kind == SourceLifecycleKind::Added && ev.reference_name == "orders"
        }
        _ => false,
    });
    assert!(added_orders, "Added event for orders in the timeline");
    // The bytes on disk changed -- the add itself triggered a rewrite (AC1),
    // not just the initial bind.
    assert_ne!(
        serde_json::to_string(&before).unwrap(),
        serde_json::to_string(&after).unwrap(),
        "recipe on disk changed after the add"
    );
    // AC4: the rewrite rode the single `save_atomic` temp+rename path shared
    // with turn finalization -- no temp residue, no second artifact in the
    // bind dir. Bytes-changed alone would not catch a non-atomic second path.
    assert_save_atomic_left_no_residue(&duck);
}

/// AC2: replacing a source atomically rewrites the .duck -- the source's
/// fingerprint + path update, every dependent result_N's turn stays in the
/// timeline marked stale (Replaced anchor), and a Replaced event appends.
#[test]
fn replace_source_atomically_rewrites_duck_with_stale_chain_and_replaced_event() {
    use toptopduck_lib::persistence::{read_duck, RecipeEntry, RecipeOutcome};
    use toptopduck_lib::{SourceLifecycleKind, StaleReason};

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people = fixture("people.csv");
    let orders = fixture("orders.csv");

    let provider = FakeProvider::new().scripted(
        "多少人",
        reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &people);
    let _ = session.ask("多少人"); // result_1 from people
    session
        .bind_duck(duck.clone(), "replace-test".into())
        .expect("bind");

    let people_fp_before = read_duck(&duck)
        .expect("read before")
        .sources
        .iter()
        .find(|s| s.reference_name == "people")
        .expect("people")
        .fingerprint
        .clone();

    // Replace people with orders -- cascade result_1 stale, triggers rewrite.
    replace_source_loaded(&mut session, "people", &orders);

    let recipe = read_duck(&duck).expect("read after replace");
    let people_after = recipe
        .sources
        .iter()
        .find(|s| s.reference_name == "people")
        .expect("people still registered (name stable, backing swapped)");
    assert_ne!(
        people_after.fingerprint, people_fp_before,
        "fingerprint updated to the new snapshot"
    );
    assert_eq!(
        people_after.source_path,
        orders.to_string_lossy().to_string(),
        "source_path updated to the new file"
    );

    // result_1's turn is STILL in history, marked stale with a Replaced anchor
    // (ADR-0041 point 2: kept for display, never silently dropped).
    let stale_anchor = recipe
        .history
        .iter()
        .find_map(|e| match e {
            RecipeEntry::Turn(t) => match &t.outcome {
                RecipeOutcome::Materialized {
                    reference_name,
                    stale: Some(a),
                    ..
                } if reference_name == "result_1" => Some(a.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("result_1 turn present in history and marked stale");
    assert_eq!(stale_anchor.reason, StaleReason::Replaced);
    assert_eq!(
        stale_anchor.reference_name, "people",
        "anchor names the invalidating source event"
    );

    let replaced_event = recipe.history.iter().any(|e| match e {
        RecipeEntry::Source(ev) => {
            ev.kind == SourceLifecycleKind::Replaced && ev.reference_name == "people"
        }
        _ => false,
    });
    assert!(replaced_event, "Replaced event for people appended");
    // AC4: the replace rewrite rode the single `save_atomic` path.
    assert_save_atomic_left_no_residue(&duck);
}

/// AC3: removing a source atomically rewrites the .duck -- the source leaves
/// `sources`, dependent result_N turns stay in the timeline marked stale
/// (Deleted anchor), and a Deleted event appends.
#[test]
fn remove_source_atomically_rewrites_duck_with_stale_chain_and_deleted_event() {
    use toptopduck_lib::persistence::{read_duck, RecipeEntry, RecipeOutcome};
    use toptopduck_lib::{SourceLifecycleKind, StaleReason};

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people = fixture("people.csv");
    let orders = fixture("orders.csv");

    let provider = FakeProvider::new().scripted(
        "多少人",
        reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &people);
    load_source(&mut session, &orders); // active = orders (most recent source)
    let _ = session.ask("多少人"); // result_1 from people
    session
        .bind_duck(duck.clone(), "remove-test".into())
        .expect("bind");

    // Remove people (non-active) -- cascade result_1 stale, triggers rewrite.
    session.remove_source("people").expect("remove people");

    let recipe = read_duck(&duck).expect("read after remove");
    assert!(
        recipe.sources.iter().all(|s| s.reference_name != "people"),
        "people removed from the source set"
    );
    let stale_anchor = recipe
        .history
        .iter()
        .find_map(|e| match e {
            RecipeEntry::Turn(t) => match &t.outcome {
                RecipeOutcome::Materialized {
                    reference_name,
                    stale: Some(a),
                    ..
                } if reference_name == "result_1" => Some(a.clone()),
                _ => None,
            },
            _ => None,
        })
        .expect("result_1 turn present and marked stale");
    assert_eq!(stale_anchor.reason, StaleReason::Deleted);
    let deleted_event = recipe.history.iter().any(|e| match e {
        RecipeEntry::Source(ev) => {
            ev.kind == SourceLifecycleKind::Deleted && ev.reference_name == "people"
        }
        _ => false,
    });
    assert!(deleted_event, "Deleted event for people appended");
    // AC4: the remove rewrite rode the single `save_atomic` path.
    assert_save_atomic_left_no_residue(&duck);
}

/// AC5/AC6/AC7 (replace): cross-restart black-box. A session with a replaced
/// source + a post-replace live result. Close + reopen: the dead turn
/// (result_1, stale) is NOT replayed but stays in the timeline and working set
/// marked stale; the live result_2 IS replayed. The main test seam is the
/// application as a black box across the restart boundary.
#[test]
fn resume_after_replace_excludes_stale_from_replay_but_keeps_marked_stale() {
    use toptopduck_lib::StaleReason;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people = fixture("people.csv");
    let orders = fixture("orders.csv");

    let provider = FakeProvider::new()
        .scripted(
            "多少人",
            reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
        )
        .scripted(
            "现在多少",
            reply_sql("SELECT COUNT(*) AS m FROM \"people\".data"),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &people);
    let _ = session.ask("多少人"); // result_1 from old people
    replace_source_loaded(&mut session, "people", &orders); // result_1 cascade stale (Replaced)
    let _ = session.ask("现在多少"); // result_2 from new people (orders data)
    session
        .bind_duck(duck.clone(), "stale-resume".into())
        .expect("bind");
    drop(session);

    let (events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");
    let events = events.borrow();

    // AC5: replay chain excluded the stale turn -- only result_2 replayed.
    let replayed: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ResumeEvent::Replay { reference_name, .. } => Some(reference_name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        replayed,
        vec!["result_2"],
        "only the live result_2 replayed; result_1 (stale dead turn) skipped"
    );

    // AC6: result_1 in the working set, marked stale (Replaced anchor) -- NOT
    // silently discarded. ADR-0013 stale visibility survives the restart.
    let result_1 = resumed
        .get("result_1")
        .expect("result_1 still in the working set after resume");
    let anchor = result_1.stale.as_ref().expect("result_1 marked stale");
    assert_eq!(anchor.reason, StaleReason::Replaced);
    assert_eq!(anchor.reference_name, "people");
    // result_2 is live (replayed, no stale marker).
    let result_2 = resumed.get("result_2").expect("result_2 present");
    assert!(result_2.stale.is_none(), "result_2 is live after replay");
    // resolve_active never lands on the stale placeholder (ADR-0013 +
    // register_stale_placeholders): the active pointer tracks a live dataset,
    // never a dead turn.
    assert_ne!(
        resumed.active().map(|d| d.reference_name),
        Some("result_1".into()),
        "active must not resolve to the stale placeholder",
    );

    // AC7: the conversation timeline is preserved end-to-end. The stale turn
    // renders as Materialized (carrying the stale descriptor), NOT dropped.
    let has_stale_turn = resumed.conversation().iter().any(|e| match e {
        ThreadEntry::Turn(t) => {
            t.question == "多少人"
                && matches!(
                    &t.outcome,
                    TurnOutcome::Materialized { dataset, .. } if dataset.stale.is_some()
                )
        }
        _ => false,
    });
    assert!(
        has_stale_turn,
        "stale result_1 turn stays in the timeline as a stale Materialized entry"
    );
    let has_live_turn = resumed
        .conversation()
        .iter()
        .any(|e| matches!(e, ThreadEntry::Turn(t) if t.question == "现在多少"));
    assert!(has_live_turn, "live result_2 turn in the timeline");
}

/// AC5/AC6 (remove): cross-restart. After removing a source, its dependent
/// result_N is a stale dead turn -- excluded from replay, but present in the
/// working set marked stale (Deleted anchor) after reopen.
#[test]
fn resume_after_remove_excludes_stale_from_replay_but_keeps_marked_stale() {
    use toptopduck_lib::StaleReason;

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.duck");
    let people = fixture("people.csv");
    let orders = fixture("orders.csv");

    let provider = FakeProvider::new()
        .scripted(
            "多少人",
            reply_sql("SELECT COUNT(*) AS n FROM \"people\".data"),
        )
        .scripted(
            "多少单",
            reply_sql("SELECT COUNT(*) AS m FROM \"orders\".data"),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &people);
    load_source(&mut session, &orders); // active = orders
    let _ = session.ask("多少人"); // result_1 from people
    let _ = session.ask("多少单"); // result_2 from orders
    session.remove_source("people").expect("remove people"); // result_1 stale (Deleted)
    session
        .bind_duck(duck.clone(), "stale-remove".into())
        .expect("bind");
    drop(session);

    let (events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("resume");
    let events = events.borrow();

    let replayed: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            ResumeEvent::Replay { reference_name, .. } => Some(reference_name.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        replayed,
        vec!["result_2"],
        "only result_2 (orders) replayed; result_1 (people-dependent) skipped"
    );

    let result_1 = resumed
        .get("result_1")
        .expect("result_1 still in the working set (stale placeholder)");
    let anchor = result_1.stale.as_ref().expect("marked stale");
    assert_eq!(anchor.reason, StaleReason::Deleted);
    // people is gone (removed); orders + result_2 remain.
    assert!(resumed.get("people").is_none(), "people removed");
    assert!(resumed.get("orders").is_some(), "orders intact");
    assert!(
        resumed.get("result_2").is_some(),
        "result_2 replayed and live"
    );
    // resolve_active never lands on the stale placeholder (ADR-0013 +
    // register_stale_placeholders): the active pointer tracks a live dataset.
    assert_ne!(
        resumed.active().map(|d| d.reference_name),
        Some("result_1".into()),
        "active must not resolve to the stale placeholder",
    );
}
