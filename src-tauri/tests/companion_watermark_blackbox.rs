//! ADR-0136 blackbox: the per-session tree working set across the restart
//! boundary. A production-shaped session (bound BEFORE any SQL, so source
//! snapshots land in the tree and result history lands in the companion DB)
//! is closed, then `Session::open_recipe` reopens it. The watermark decides:
//! a hit reopens with zero source re-reads and zero SQL re-execution; any
//! miss (corrupt companion, edited chain, a pre-0136 pure-recipe session)
//! falls back to the existing full replay and rebuilds the companion, and
//! the NEXT open hits. Source files missing or changed on a hit degrade to
//! non-blocking notices.

use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use serde_json::json;
use toptopduck_lib::provider::tool_calling::{ToolTurnReply, ToolUse};
use toptopduck_lib::{
    ActiveResolution, CancelToken, FakeProvider, LoadOutcome, ResumeError, ResumeEvent, Session,
    SourceNotice, SourceResolution,
};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn fixture(name: &str) -> PathBuf {
    fixtures_dir().join(name)
}

fn resume_defaults(
    duck: &Path,
    cancel: Arc<CancelToken>,
    on_progress: impl FnMut(ResumeEvent),
) -> Result<Session, ResumeError> {
    Session::open_recipe(
        duck,
        cancel,
        Box::new(toptopduck_lib::UnwiredProvider),
        Default::default(),
        on_progress,
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    )
}

fn load_source(session: &mut Session, path: &Path) {
    match session.ingest(path) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected source to load, got {other:?}"),
    }
}

fn productive(sql: &str) -> Vec<Result<ToolTurnReply, toptopduck_lib::ProviderError>> {
    vec![
        Ok(ToolTurnReply::tool_calls(vec![ToolUse {
            id: "tu_1".into(),
            name: "materialize".into(),
            input: json!({ "sql": sql }),
        }])),
        Ok(ToolTurnReply::Text("完成".to_string())),
    ]
}

/// Build the production-shaped session: bind FIRST (create_session order,
/// ADR-0089), then ingest one CSV source + run two productive turns. Source
/// snapshots land in `{duck_dir}/snapshots/`, the result history in the
/// companion `{duck_dir}/analytics.duckdb`, and each settle stamps the watermark.
/// The caller drops the returned session to simulate a clean close.
fn build_hit_session(duck: &Path, csv: &Path) -> Session {
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "多少人",
            productive("SELECT COUNT(*) AS n FROM \"people\".data"),
        )
        .scripted_tool_turn_seq(
            "平均分",
            productive("SELECT AVG(score) AS a FROM \"people\".data"),
        );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    session
        .bind_recipe(duck.to_path_buf(), "水印分析".into())
        .expect("bind");
    load_source(&mut session, csv);
    let _ = session.ask("多少人");
    let _ = session.ask("平均分");
    session
}

fn collect_events() -> (Rc<RefCell<Vec<ResumeEvent>>>, impl FnMut(ResumeEvent)) {
    let cell: Rc<RefCell<Vec<ResumeEvent>>> = Rc::new(RefCell::new(Vec::new()));
    let cb_cell = Rc::clone(&cell);
    let cb = move |ev: ResumeEvent| cb_cell.borrow_mut().push(ev);
    (cell, cb)
}

fn dataset_names(session: &Session) -> Vec<String> {
    session
        .list()
        .iter()
        .map(|d| d.reference_name.clone())
        .collect()
}

fn turn_questions(session: &Session) -> Vec<String> {
    session
        .conversation()
        .iter()
        .filter_map(|e| match e {
            toptopduck_lib::ThreadEntry::Turn(t) => Some(t.question.clone()),
            _ => None,
        })
        .collect()
}

/// AC1: a closed session reopens through the watermark hit -- zero source
/// re-reads and zero result SQL re-executions (the observable: NO resume
/// progress events fire) -- and the working set, timeline, and active
/// pointer are complete.
#[test]
fn watermark_hit_reopens_without_replay() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let session = build_hit_session(&duck, &fixture("people.csv"));
    let expected_names = dataset_names(&session);
    let expected_questions = turn_questions(&session);
    let expected_active = session.active().map(|d| d.reference_name.clone());
    drop(session); // clean close: CHECKPOINT + snapshot files stay in the tree

    // The tree holds the closed session's working set (ADR-0136 D1/D2).
    let tree = dir.path();
    assert!(tree.join("snapshots").join("people.duckdb").exists());
    assert!(tree.join("analytics.duckdb").exists());

    let (events, cb) = collect_events();
    let mut resumed =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("watermark hit resume");
    assert!(
        events.borrow().is_empty(),
        "hit path fires no source-verify or replay events (got {:?})",
        events.borrow()
    );
    assert_eq!(
        dataset_names(&resumed),
        expected_names,
        "working set restored verbatim from the companion meta"
    );
    assert_eq!(turn_questions(&resumed), expected_questions);
    assert_eq!(
        resumed.active().map(|d| d.reference_name.clone()),
        expected_active
    );
    // The result DATA survived -- not just the registry entries.
    let page = resumed
        .read_rows("result_1", 0, 10)
        .expect("result_1 readable from the companion");
    assert_eq!(page.total, 1, "the COUNT(*) result has one row");
    // Source present + unchanged -> no notices.
    assert!(resumed.take_source_notices().is_empty());
}

/// AC2: the source file deleted after close -- the hit still opens (the
/// working set is the ingest-time snapshot), reports a Missing notice, and
/// never reaches the blocking re-link / abort decision path.
#[test]
fn watermark_hit_opens_with_a_missing_source_as_a_notice() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    // A private copy of the fixture so the test can delete it.
    let csv = dir.path().join("people.csv");
    fs::copy(fixture("people.csv"), &csv).expect("copy fixture");
    let session = build_hit_session(&duck, &csv);
    drop(session);
    fs::remove_file(&csv).expect("source gone");

    let (events, cb) = collect_events();
    let mut resumed =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("hit opens without source");
    assert!(events.borrow().is_empty(), "still the hit path, no replay");
    assert_eq!(
        dataset_names(&resumed),
        vec!["people".to_string(), "result_1".into(), "result_2".into()],
        "working set complete from the ingest-time snapshot"
    );
    let notices = resumed.take_source_notices();
    assert_eq!(
        notices,
        vec![SourceNotice::Missing {
            reference_name: "people".into()
        }],
        "missing source surfaces as a non-blocking notice"
    );
}

/// The drift face of the notice: the source file rewritten (different
/// size/mtime) after close degrades to a Changed notice, never a Drift
/// decision callback.
#[test]
fn watermark_hit_reports_a_changed_source_as_a_notice() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let csv = dir.path().join("people.csv");
    fs::copy(fixture("people.csv"), &csv).expect("copy fixture");
    let session = build_hit_session(&duck, &csv);
    drop(session);
    fs::write(&csv, "id,name,score,extra\n99,z,1,2\n").expect("rewrite source");

    let (_events, cb) = collect_events();
    let mut resumed =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("hit opens on drift");
    assert_eq!(
        resumed.take_source_notices(),
        vec![SourceNotice::Changed {
            reference_name: "people".into()
        }]
    );
}

/// AC3: a corrupt companion falls back to the existing full replay --
/// progress events fire per source + per turn, the working set rebuilds, and
/// the NEXT open hits (the replay rewrote + re-stamped the companion).
#[test]
fn a_corrupt_companion_falls_back_to_full_replay_then_hits() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let session = build_hit_session(&duck, &fixture("people.csv"));
    drop(session);
    fs::write(dir.path().join("analytics.duckdb"), b"not a duckdb file")
        .expect("corrupt companion");

    let (events, cb) = collect_events();
    let resumed =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("fallback replay rebuilds");
    let fired = events.borrow().clone();
    assert!(
        fired
            .iter()
            .any(|e| matches!(e, ResumeEvent::Source { .. })),
        "fallback re-verifies sources: {fired:?}"
    );
    assert!(
        fired
            .iter()
            .any(|e| matches!(e, ResumeEvent::Replay { .. })),
        "fallback re-executes the chain: {fired:?}"
    );
    assert_eq!(
        dataset_names(&resumed),
        vec!["people".to_string(), "result_1".into(), "result_2".into()]
    );
    drop(resumed);

    // The replay re-stamped -- the second reopen is a hit.
    let (events, cb) = collect_events();
    let mut reopened =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("second open");
    assert!(
        events.borrow().is_empty(),
        "post-rebuild reopen hits: {:?}",
        events.borrow()
    );
    assert!(reopened.take_source_notices().is_empty());
}

/// The chain-edit face of the miss: an edited promotion SQL invalidates the
/// watermark even when the companion itself is intact.
#[test]
fn an_edited_chain_invalidates_the_watermark() {
    use toptopduck_lib::persistence::recipe::{RecipeEntry, RecipeOutcome};
    use toptopduck_lib::persistence::{read_recipe, save_atomic};

    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let session = build_hit_session(&duck, &fixture("people.csv"));
    drop(session);
    let mut recipe = read_recipe(&duck).expect("read recipe");
    for entry in &mut recipe.history {
        if let RecipeEntry::Turn(t) = entry {
            if let RecipeOutcome::Materialized { promotions, .. } = &mut t.outcome {
                promotions[0].sql = format!("{} ", promotions[0].sql); // whitespace edits the chain
            }
        }
    }
    save_atomic(&duck, &recipe).expect("edit recipe");

    let (events, cb) = collect_events();
    let resumed =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("edited chain replays");
    assert!(
        events
            .borrow()
            .iter()
            .any(|e| matches!(e, ResumeEvent::Replay { .. })),
        "watermark mismatch forces a replay"
    );
    assert_eq!(
        dataset_names(&resumed),
        vec!["people".to_string(), "result_1".into(), "result_2".into()]
    );
    drop(resumed);

    // The rebuild re-stamped the companion against the EDITED chain -- the
    // next open hits.
    let (events, cb) = collect_events();
    let _reopened = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("second open");
    assert!(
        events.borrow().is_empty(),
        "post-rebuild reopen hits: {:?}",
        events.borrow()
    );
}

/// AC4: a legacy pure-recipe session (pre-0136 order: SQL ran before the
/// bind, so no companion and no tree snapshots were ever written) opens
/// through the untouched replay path with ZERO migration code, and the
/// rebuild writes it into the hit path -- the next open fires no events.
#[test]
fn a_legacy_pure_recipe_session_replays_once_then_hits() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    // Pre-0136 test order: unbound SQL first, bind last.
    let provider = FakeProvider::new().scripted_tool_turn_seq(
        "多少人",
        productive("SELECT COUNT(*) AS n FROM \"people\".data"),
    );
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    let _ = session.ask("多少人");
    session
        .bind_recipe(duck.to_path_buf(), "旧会话".into())
        .expect("bind");
    drop(session);

    // No companion on disk -- the legacy state.
    assert!(!dir.path().join("analytics.duckdb").exists());

    let (events, cb) = collect_events();
    let resumed =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("legacy session replays");
    assert!(
        events
            .borrow()
            .iter()
            .any(|e| matches!(e, ResumeEvent::Replay { .. })),
        "the one-time replay ran"
    );
    assert_eq!(
        dataset_names(&resumed),
        vec!["people".to_string(), "result_1".into()]
    );
    drop(resumed);

    // The replay rebuilt the companion + tree snapshots in the settle -- the
    // next open is a hit.
    assert!(dir.path().join("analytics.duckdb").exists());
    let (events, cb) = collect_events();
    let _reopened = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("second open");
    assert!(
        events.borrow().is_empty(),
        "post-migration reopen hits: {:?}",
        events.borrow()
    );
}

/// AC5 (clean close): after a checkpointed close the tree holds the recipe,
/// the companion, and the source snapshots, with no leftover WAL.
#[test]
fn a_clean_close_leaves_a_self_contained_tree_without_a_wal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let session = build_hit_session(&duck, &fixture("people.csv"));
    drop(session);

    assert!(duck.exists(), "recipe file");
    assert!(dir.path().join("analytics.duckdb").exists(), "companion");
    assert!(
        dir.path().join("snapshots").join("people.duckdb").exists(),
        "source snapshot"
    );
    assert!(
        !dir.path().join("analytics.duckdb.wal").exists(),
        "clean close folds the WAL into the main file"
    );
}

/// The miss path never lets a stale companion leak data into a rebuilt
/// session: the discard happens BEFORE the replay's engine opens the file,
/// so the rebuilt result tables are recreated, not appended onto stale ones.
#[test]
fn a_watermark_miss_rebuilds_results_from_scratch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let session = build_hit_session(&duck, &fixture("people.csv"));
    drop(session);
    // Force a miss by deleting one tree snapshot (the probe requires all of
    // them) while keeping the companion intact.
    fs::remove_file(dir.path().join("snapshots").join("people.duckdb")).expect("drop snapshot");

    let (_events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb)
        .expect("miss rebuilds from the source file");
    assert_eq!(
        dataset_names(&resumed),
        vec!["people".to_string(), "result_1".into(), "result_2".into()]
    );
    let page = resumed
        .read_rows("result_1", 0, 10)
        .expect("rebuilt result readable");
    assert_eq!(page.total, 1);
}

/// #1387: a programmatically referenced source whose SQL function name and
/// file extension disagree (`read_json_auto` on a `.txt` original)
/// snapshots fine on first production; a watermark-miss replay must re-read
/// with the SAME reader (persisted on the recipe source ref) instead of
/// extension dispatch (which would refuse `.txt` as unsupported).
#[test]
fn a_watermark_miss_replays_a_reader_mismatch_source_by_the_recorded_reader() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    // JSON bytes under a `.txt` spelling outside the session tree.
    let notes = dir.path().join("notes.txt");
    fs::write(&notes, r#"[{"secret":"PASSWORD"}]"#).expect("write notes");
    let sql = format!(
        "SELECT secret FROM read_json_auto('{}')",
        notes.to_string_lossy()
    );
    let provider = FakeProvider::new().scripted_tool_turn_seq("笔记", productive(&sql));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    session
        .bind_recipe(duck.clone(), "分叉分析".into())
        .expect("bind");
    let _ = session.ask("笔记");
    assert!(session.get("notes").is_some(), "the mismatch registered");
    drop(session);
    // Force a miss by deleting the tree snapshot while keeping the companion.
    fs::remove_file(dir.path().join("snapshots").join("notes.duckdb")).expect("drop snapshot");

    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), |_| {})
        .expect("miss replays by the recorded reader");
    let page = resumed
        .read_rows("notes", 0, 10)
        .expect("the rebuilt source is readable");
    assert_eq!(page.rows.len(), 1, "re-read as json, not refused as .txt");
    assert!(
        page.rows.iter().flatten().any(|c| c.contains("PASSWORD")),
        "the mismatch source's rows survived the replay"
    );

    // Refill pin (review I2): the post-resume rewrite (resume phase 5)
    // rebuilds the recipe from the persister map, so the miss leg must
    // have refilled the reader or the rewrite silently strips the field.
    drop(resumed);
    let disk = fs::read_to_string(&duck).expect("read recipe");
    let v: serde_json::Value = serde_json::from_str(&disk).expect("recipe json");
    assert_eq!(
        v["sources"][0]["reader"],
        json!("read_json_auto"),
        "the miss-leg refill keeps the reader through the post-resume rewrite"
    );
}

/// #1387 review I2: the hit leg never reads files, but the post-resume
/// rewrite rebuilds the recipe from the persister map -- without the
/// refill the rewrite would silently strip the recorded reader
/// (skip_serializing_if) and the NEXT miss would fall back to extension
/// dispatch and its refusals.
#[test]
fn a_watermark_hit_preserves_the_recorded_reader_through_the_rewrite() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    // JSON bytes under a `.txt` spelling outside the session tree.
    let notes = dir.path().join("notes.txt");
    fs::write(&notes, r#"[{"secret":"PASSWORD"}]"#).expect("write notes");
    let sql = format!(
        "SELECT secret FROM read_json_auto('{}')",
        notes.to_string_lossy()
    );
    let provider = FakeProvider::new().scripted_tool_turn_seq("笔记", productive(&sql));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    session
        .bind_recipe(duck.clone(), "分叉分析".into())
        .expect("bind");
    let _ = session.ask("笔记");
    drop(session); // the snapshot stays -- the reopen hits

    let (events, cb) = collect_events();
    let resumed = resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("hit reopen");
    assert!(
        events.borrow().is_empty(),
        "the reopen hits (got {:?})",
        events.borrow()
    );
    drop(resumed);

    let disk = fs::read_to_string(&duck).expect("read recipe");
    let v: serde_json::Value = serde_json::from_str(&disk).expect("recipe json");
    assert_eq!(
        v["sources"][0]["reader"],
        json!("read_json_auto"),
        "the hit-leg refill keeps the reader through the post-resume rewrite"
    );
}

/// #1387 review I1: a replace re-bases the source on extension dispatch --
/// the recipe must not carry the old registration's fn-named reader over
/// the replacement file, or the next watermark miss would re-read the
/// replacement with the WRONG reader.
#[test]
fn a_replace_clears_the_recorded_reader_for_the_replacement() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let notes = dir.path().join("notes.txt");
    fs::write(&notes, r#"[{"secret":"PASSWORD"}]"#).expect("write notes");
    let sql = format!(
        "SELECT secret FROM read_json_auto('{}')",
        notes.to_string_lossy()
    );
    let provider = FakeProvider::new().scripted_tool_turn_seq("笔记", productive(&sql));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    session
        .bind_recipe(duck.clone(), "分叉分析".into())
        .expect("bind");
    let _ = session.ask("笔记");
    // A same-name replace onto a CSV: the replacement is read by ITS
    // extension, so the recorded json reader must be gone.
    let csv = dir.path().join("swap.csv");
    fs::write(&csv, "id,secret\n1,PASSWORD\n").expect("write swap");
    match session.replace_source("notes", &csv) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to load, got {other:?}"),
    }
    drop(session);

    let disk = fs::read_to_string(&duck).expect("read recipe");
    let v: serde_json::Value = serde_json::from_str(&disk).expect("recipe json");
    let src = &v["sources"][0];
    assert_eq!(
        src["reference_name"],
        json!("notes"),
        "the swap kept the name"
    );
    assert!(
        src.get("reader").is_none(),
        "the replace cleared the old registration's reader, got {:?}",
        src["reader"]
    );
}

/// #1387 review E: the reader entry retires with the snapshot -- a manual
/// re-registration under the freed name must not inherit the programmatic
/// registration's reader (the recipe would pin json dispatch onto an
/// extension-read file).
#[test]
fn a_removal_lets_a_same_name_manual_ingest_start_reader_clean() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let notes = dir.path().join("notes.txt");
    fs::write(&notes, r#"[{"secret":"PASSWORD"}]"#).expect("write notes");
    let sql = format!(
        "SELECT secret FROM read_json_auto('{}')",
        notes.to_string_lossy()
    );
    let provider = FakeProvider::new().scripted_tool_turn_seq("笔记", productive(&sql));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    session
        .bind_recipe(duck.clone(), "分叉分析".into())
        .expect("bind");
    let _ = session.ask("笔记");
    assert!(
        session.get("notes").is_some(),
        "the programmatic source registered"
    );

    // A second source takes over the active-source pointer, so the plain
    // removal path (not remove_active_source's explicit continuation)
    // carries the delete (ADR-0035).
    let other = dir.path().join("orders.csv");
    fs::write(&other, "id,qty\n1,2\n").expect("write other");
    load_source(&mut session, &other);
    session.remove_source("notes").expect("remove");
    // A manual ingest reclaims the freed name (same stem): CSV content,
    // read by extension like every manual ingest.
    let manual = dir.path().join("notes.csv");
    fs::write(&manual, "id,secret\n1,PASSWORD\n").expect("write manual");
    load_source(&mut session, &manual);
    drop(session);

    let disk = fs::read_to_string(&duck).expect("read recipe");
    let v: serde_json::Value = serde_json::from_str(&disk).expect("recipe json");
    let src = v["sources"]
        .as_array()
        .expect("sources array")
        .iter()
        .find(|s| s["reference_name"] == json!("notes"))
        .expect("the manual ingest reclaimed the freed name");
    assert!(
        src.get("reader").is_none(),
        "the removal retired the reader entry with the snapshot, got {:?}",
        src["reader"]
    );
}

/// A replace settles the REPLACEMENT into the tree: the retire step must
/// remove the old snapshot and promote the swap inside `snapshots/` (a
/// temp-dir formal path would strand the stale file in the tree while the
/// stamped watermark describes the replacement -- the reopen hit would then
/// serve pre-replacement data). The reopened hit must read the replaced rows.
#[test]
fn a_replaced_source_survives_close_and_the_reopen_hit_serves_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("s.json");
    let csv_v1 = dir.path().join("people.csv");
    fs::copy(fixture("people.csv"), &csv_v1).expect("copy fixture");
    // Same schema, one extra row: a same-schema replace is the silent-wrong-
    // data shape -- only the row count can tell v1 from v2.
    let csv_v2 = dir.path().join("people_v2.csv");
    fs::write(
        &csv_v2,
        "id,name,joined,active,score\n1,Alice,2021-03-15,true,3.5\n2,Bob,2020-07-22,false,4.2\n3,Cara,2022-01-08,true,2.8\n4,Dan,2019-11-30,false,5.0\n5,Eve,2023-04-04,true,3.9\n6,Fay,2023-06-01,true,4.4\n",
    )
    .expect("write v2");

    let mut session = build_hit_session(&duck, &csv_v1);
    match session.replace_source("people", &csv_v2) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to load, got {other:?}"),
    }
    drop(session); // clean close: the tree must hold the REPLACEMENT

    let (events, cb) = collect_events();
    let mut resumed =
        resume_defaults(&duck, Arc::new(CancelToken::new()), cb).expect("reopen after replace");
    assert!(
        events.borrow().is_empty(),
        "the replacement settled into the watermark: the reopen hits (got {:?})",
        events.borrow()
    );
    let page = resumed
        .read_rows("people", 0, 10)
        .expect("source readable on the hit path");
    // Pin the QUERIED rows, not `total` -- the page's total is the
    // descriptor's row count (restored from the stamped meta), so it would
    // report the replacement's count even over stale snapshot data.
    assert_eq!(
        page.rows.len(),
        6,
        "the reopened hit serves the REPLACED rows"
    );
    assert!(
        page.rows.iter().flatten().any(|c| c.contains("Fay")),
        "the extra v2 row is present in the served data"
    );
    assert!(resumed.take_source_notices().is_empty());
}
