//! Multi-session black-box seam (ADR-0055/0056, issue #71): drive the
//! [`SessionStore`] directly at the command-boundary abstraction -- create /
//! close, per-session isolation (ADR-0027), close-with-in-flight discard
//! (ADR-0055), and the concurrency model (the store lock is not held during a
//! long turn, ADR-0056). Fully local and deterministic: a scripted FakeProvider
//! stands in for the LLM (ADR-0007), and a blocking variant simulates a long,
//! cancellable HTTP. The store is exercised as a library type; nothing about
//! `State` internals is asserted.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use toptopduck_lib::{
    CancelToken, FakeProvider, LoadOutcome, ProviderReply, SessionStore, TurnOutcome,
};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn fixture(name: &str) -> PathBuf {
    fixtures_dir().join(name)
}

fn reply_sql(sql: &str) -> ProviderReply {
    ProviderReply::Sql {
        sql: sql.to_string(),
        viz: None,
        assumption: None,
    }
}

/// Poll the cancel token's in-flight flag until it goes true (the ask thread
/// entered its turn), or time out. Mirrors `query_blackbox`'s helper: a
/// blocking FakeProvider only sets in-flight once `ask` calls `begin_turn`,
/// so this synchronizes the test's "close while in flight" step.
fn await_in_flight(cancel: &CancelToken, timeout: Duration) {
    let deadline = std::time::Instant::now() + timeout;
    while !cancel.is_in_flight() {
        if std::time::Instant::now() > deadline {
            panic!("ask never reached in-flight within {timeout:?}");
        }
        thread::sleep(Duration::from_millis(2));
    }
}

/// Create a fresh session backed by an UnwiredProvider (every turn refuses --
/// enough for store-level addressing tests that do not drive a real turn).
fn fresh_session(store: &SessionStore) -> String {
    store
        .create(
            Arc::new(CancelToken::new()),
            Box::new(toptopduck_lib::UnwiredProvider),
        )
        .expect("create session")
}

// --- create / close / addressing -------------------------------------------

#[test]
fn create_returns_unique_ids_and_each_is_addressable() {
    // ADR-0056: create mints a backend-generated id (UUID) per session; two
    // creates produce two distinct ids and both resolve in the store.
    let store = SessionStore::new();
    let a = fresh_session(&store);
    let b = fresh_session(&store);
    assert_ne!(a, b, "two sessions get distinct ids");
    assert!(store.get(&a).is_ok(), "a is addressable");
    assert!(store.get(&b).is_ok(), "b is addressable");
}

#[test]
fn close_removes_session_and_subsequent_lookups_reject() {
    // ADR-0055: close removes the entry; later commands targeting that id
    // reject as unknown session.
    let store = SessionStore::new();
    let id = fresh_session(&store);
    store.close(&id).expect("close");
    let err = store.get(&id).err().expect("closed session rejects");
    assert_eq!(err, toptopduck_lib::UNKNOWN_SESSION);
}

// --- per-session physical isolation (ADR-0027) -----------------------------

#[test]
fn two_sessions_are_physically_isolated() {
    // ADR-0027: each session owns an independent in-memory DuckDB instance.
    // A source ingested into session A is NOT visible to session B, and a SQL
    // referencing A's table in B fails (unknown table) -- the instances cannot
    // reference each other's result_N / sources.
    let store = SessionStore::new();

    // Session A: ingest people.csv (source isolation), then script a turn that
    // materializes result_1 (result isolation). The SQL needs no FROM -- the
    // sandbox runs it on an empty source set; what matters is that result_1
    // lands in A and never in B.
    let cancel_a = Arc::new(CancelToken::new());
    let provider_a = FakeProvider::new().scripted("建结果", reply_sql("SELECT 1 AS n"));
    let a = store
        .create(cancel_a, Box::new(provider_a))
        .expect("create a");
    let handle_a = store.get(&a).expect("handle a");
    {
        let mut s = handle_a.session.lock().unwrap();
        match s.ingest(&fixture("people.csv")) {
            LoadOutcome::Loaded(_) => {}
            other => panic!("expected people to load, got {other:?}"),
        }
        let outcome = s.ask("建结果");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "A's turn should materialize, got {outcome:?}"
        );
        let list = s.list();
        let names: Vec<&str> = list.iter().map(|d| d.reference_name.as_str()).collect();
        assert!(
            names.contains(&"people"),
            "A has the people source: {names:?}"
        );
        assert!(names.contains(&"result_1"), "A has result_1: {names:?}");
    }

    // Session B: empty working set -- A's people / result_1 are NOT visible.
    let b = fresh_session(&store);
    let handle_b = store.get(&b).expect("handle b");
    {
        let s = handle_b.session.lock().unwrap();
        let list = s.list();
        let names: Vec<&str> = list.iter().map(|d| d.reference_name.as_str()).collect();
        assert!(
            !names.contains(&"people"),
            "B must NOT see A's people source: {names:?}"
        );
        assert!(
            !names.contains(&"result_1"),
            "B must NOT see A's result_1: {names:?}"
        );
    }

    // Cross-reference: a SQL naming A's `people` table in B fails (the table
    // does not exist in B's DuckDB) -- the two instances cannot reference each
    // other's objects.
    let cancel_b = Arc::new(CancelToken::new());
    let provider_b = FakeProvider::new().scripted("引用A的表", reply_sql("SELECT * FROM people"));
    let b2 = store
        .create(cancel_b, Box::new(provider_b))
        .expect("create b2");
    let handle_b2 = store.get(&b2).expect("handle b2");
    {
        let mut s = handle_b2.session.lock().unwrap();
        let outcome = s.ask("引用A的表");
        assert!(
            matches!(outcome, TurnOutcome::Failed { .. }),
            "B referencing A's table must fail (isolated DuckDB), got {outcome:?}"
        );
    }
}

// --- close with an in-flight ask (ADR-0055) --------------------------------

#[test]
fn close_with_inflight_ask_discards_turn_not_in_thread_or_recipe() {
    // ADR-0055: closing a session whose turn is in flight fires cancel (the
    // ask finishes as Cancelled), marks closing, and the ask's post-turn check
    // DISCARDS the outcome -- it is not appended to the thread and not
    // persisted to the recipe. A prior successful turn survives in both.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");

    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new()
        .with_cancel(cancel.clone())
        // A normal turn that persists a recipe entry.
        .scripted("好查询", reply_sql("SELECT 1 AS n"))
        // A long, cancellable turn that close_session will interrupt.
        .scripted_blocking("慢查询", reply_sql("SELECT 1 AS n"));
    let id = store
        .create(cancel.clone(), Box::new(provider))
        .expect("create");
    let handle = store.get(&id).expect("handle");

    // Bind to a .duck + run the successful turn (recipe now holds 1 turn).
    {
        let mut s = handle.session.lock().unwrap();
        s.bind_duck(duck.clone(), "测试".into()).expect("bind");
        let outcome = s.ask("好查询");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "the prior turn should materialize, got {outcome:?}"
        );
    }

    // Spawn the long ask (blocks in the provider until cancel fires).
    let session_for_thread = Arc::clone(&handle.session);
    let ask = thread::spawn(move || {
        let mut s = session_for_thread.lock().unwrap();
        s.ask("慢查询")
    });
    await_in_flight(&cancel, Duration::from_secs(2));

    // Close while the turn is in flight: closing + cancel + remove-from-map.
    store.close(&id).expect("close");

    let outcome = ask.join().expect("ask thread");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "in-flight turn lands as Cancelled after close fires cancel, got {outcome:?}"
    );

    // The discarded turn is NOT in the thread -- only the prior "好查询" turn
    // remains. The test's handle Arc keeps the Session alive past close so the
    // conversation is still readable.
    {
        let s = handle.session.lock().unwrap();
        let thread_questions: Vec<&str> = s
            .conversation()
            .iter()
            .filter_map(|e| match e {
                toptopduck_lib::ThreadEntry::Turn(r) => Some(r.question.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            thread_questions,
            vec!["好查询"],
            "the cancelled in-flight turn must not enter the thread"
        );
    }

    // The on-disk recipe also excludes the cancelled turn -- the prior turn's
    // auto-persist is the last write, and close_session writes nothing extra
    // (the cancelled turn's discard happens BEFORE record_turn / persist).
    let recipe = toptopduck_lib::persistence::read_duck(&duck).expect("read recipe back");
    assert_eq!(
        recipe.history.len(),
        1,
        "recipe holds exactly the one successful turn (cancelled turn excluded)"
    );
}

// --- concurrency model: store lock not held during a long turn (ADR-0056) ---

#[test]
fn store_lock_not_held_during_a_long_turn() {
    // ADR-0056 concurrency: a long turn on session A holds only A's session
    // Mutex + a cloned Arc<SessionHandle> -- NOT the store lock. So while A's
    // ask is in flight, a DIFFERENT session's create + close (which take the
    // store write lock) complete without blocking. Had A's ask held the store
    // lock, create(B) would stall until A's turn finished (≤120s) and the
    // channel recv would time out.
    let store = Arc::new(SessionStore::new());
    let cancel_a = Arc::new(CancelToken::new());
    let provider_a = FakeProvider::new()
        .with_cancel(cancel_a.clone())
        .scripted_blocking("慢查询", reply_sql("SELECT 1 AS n"));
    let a = store
        .create(cancel_a.clone(), Box::new(provider_a))
        .expect("create a");
    let handle_a = store.get(&a).expect("handle a");

    let session_for_thread = Arc::clone(&handle_a.session);
    let ask = thread::spawn(move || {
        let mut s = session_for_thread.lock().unwrap();
        s.ask("慢查询")
    });
    await_in_flight(&cancel_a, Duration::from_secs(2));

    // While A's ask is in flight, create + close B on another thread. Both
    // take the store write lock; if A held it, this would block past the
    // timeout and the recv would fail.
    let store_for_b = Arc::clone(&store);
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let b = store_for_b
            .create(
                Arc::new(CancelToken::new()),
                Box::new(toptopduck_lib::UnwiredProvider),
            )
            .expect("create b");
        store_for_b.close(&b).expect("close b");
        let _ = tx.send(());
    });
    rx.recv_timeout(Duration::from_secs(3))
        .expect("create+close B blocked while A's ask was in flight -- store lock held too long (ADR-0056 violation)");

    // Release A's long turn so the test can join and exit cleanly.
    cancel_a.request();
    let outcome = ask.join().expect("ask thread");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "A's turn lands as Cancelled after release, got {outcome:?}"
    );
}
