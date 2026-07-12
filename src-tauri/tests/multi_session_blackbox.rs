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
    ActiveResolution, CancelToken, FakeProvider, LoadOutcome, ProviderReply, Session, SessionError,
    SessionId, SessionStore, SourceResolution, TurnOutcome,
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
fn fresh_session(store: &SessionStore) -> SessionId {
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
    assert_eq!(err, SessionError::NotFound);
}

#[test]
fn close_twice_first_ok_second_rejects_unknown_session() {
    // `close` is NOT idempotent on a missing id: the first close removes the
    // entry and returns Ok; a second close of the same id fails the internal
    // `get` lookup and surfaces UNKNOWN_SESSION (the frontend treats any close
    // error on a tab it is discarding as success). Pins the documented
    // behavior so a future "make close truly idempotent" change is intentional.
    let store = SessionStore::new();
    let id = fresh_session(&store);
    store.close(&id).expect("first close");
    let err = store
        .close(&id)
        .expect_err("second close rejects with NotFound");
    assert_eq!(err, SessionError::NotFound);
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
        let mut s = handle_a.session_lock().unwrap();
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
        let s = handle_b.session_lock().unwrap();
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
        let mut s = handle_b2.session_lock().unwrap();
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
        let mut s = handle.session_lock().unwrap();
        s.bind_duck(duck.clone(), "测试".into()).expect("bind");
        let outcome = s.ask("好查询");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "the prior turn should materialize, got {outcome:?}"
        );
    }

    // Spawn the long ask (blocks in the provider until cancel fires).
    let handle_for_thread = Arc::clone(&handle);
    let ask = thread::spawn(move || {
        let mut s = handle_for_thread.session_lock().unwrap();
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
        let s = handle.session_lock().unwrap();
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

// --- close-and-wait-release variant (ADR-0063, issue #93) -------------------
//
// The delete path's close variant: detach (mark closing + fire cancel + remove
// from the map) then block on the drop signal until Session::Drop releases the
// canonical single-writer key. The pure close (ADR-0055) resolves the moment
// the map entry is gone; the wait variant resolves only when the in-flight
// ask's Arc clone has dropped. Tested at the store level (detach +
// take_drop_signal + recv_timeout), mirroring the command's core logic without
// the Tauri State/async plumbing.

/// Bind a fresh session to a .duck path so it acquires the canonical single-
/// writer key, then return the id. The key is held until the session drops.
fn bound_session(store: &SessionStore, duck: &std::path::Path) -> SessionId {
    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new().scripted("好查询", reply_sql("SELECT 1 AS n"));
    let id = store.create(cancel, Box::new(provider)).expect("create");
    let handle = store.get(&id).expect("handle");
    let mut s = handle.session_lock().unwrap();
    s.bind_duck(duck.to_path_buf(), "测试".into())
        .expect("bind");
    drop(s);
    drop(handle);
    id
}

#[test]
fn close_wait_release_resolves_immediately_when_no_ask_in_flight() {
    // ADR-0063 Decision 1: with no in-flight ask, dropping the detached handle
    // is the last Arc -> Session::Drop fires at once -> the signal resolves
    // immediately (no spurious wait). The canonical key is released by the
    // time recv_timeout returns Ok.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");
    let id = bound_session(&store, &duck);

    let canonical = toptopduck_lib::persistence::canonicalize_duck(&duck).expect("canonicalize");
    // Sanity: the session holds the key while alive.
    assert!(
        !toptopduck_lib::persistence::try_acquire(&canonical),
        "key held while session alive"
    );

    // detach + take the drop signal + release our handle clone. No ask is in
    // flight, so refcount hits 0 here and Session::Drop runs synchronously.
    let detached = store.detach(&id).expect("detach");
    let rx = detached
        .take_drop_signal()
        .expect("lock ok")
        .expect("signal present");
    drop(detached);

    // The signal resolves at once (Session::Drop already fired). A short
    // timeout proves it did not block.
    rx.recv_timeout(Duration::from_secs(2))
        .expect("signal fires immediately when no ask in flight");

    // The canonical key is now released -- delete_session's gate would succeed.
    assert!(
        toptopduck_lib::persistence::try_acquire(&canonical),
        "canonical key released after the wait resolved"
    );
    toptopduck_lib::persistence::release(&canonical); // cleanup
}

#[test]
fn close_wait_release_waits_for_inflight_ask_then_releases_canonical_key() {
    // ADR-0063: the core fix for issue #93. With an in-flight ask, detach fires
    // cancel but the ask thread's Arc clone keeps Session::Drop from running.
    // The wait variant blocks on the drop signal; when the ask's post-cancel
    // discard drops its clone, Session::Drop fires -> signal -> the wait
    // resolves -> delete_session's single-writer gate now succeeds. Under pure
    // close (prior behavior), delete would race the ask and hit the gate.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");

    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new()
        .with_cancel(cancel.clone())
        // A normal turn to bind the recipe + acquire the canonical key.
        .scripted("好查询", reply_sql("SELECT 1 AS n"))
        // The long, cancellable turn the close-wait will interrupt.
        .scripted_blocking("慢查询", reply_sql("SELECT 1 AS n"));
    let id = store
        .create(cancel.clone(), Box::new(provider))
        .expect("create");

    // Bind + run the successful turn so the canonical key is held.
    {
        let handle = store.get(&id).expect("handle");
        let mut s = handle.session_lock().unwrap();
        s.bind_duck(duck.clone(), "测试".into()).expect("bind");
        let outcome = s.ask("好查询");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "prior turn materializes, got {outcome:?}"
        );
    }

    // Spawn the long ask; the thread holds the ONLY handle clone once it moves.
    let handle_for_ask = store.get(&id).expect("handle for ask");
    let ask = thread::spawn(move || {
        let mut s = handle_for_ask.session_lock().unwrap();
        s.ask("慢查询")
    });
    await_in_flight(&cancel, Duration::from_secs(2));

    let canonical = toptopduck_lib::persistence::canonicalize_duck(&duck).expect("canonicalize");

    // detach: mark closing + fire cancel + remove from map. Returns a handle
    // clone; take the signal receiver, then drop the clone. The ask thread's
    // clone is the sole remaining Arc, so Session::Drop has NOT run yet.
    let detached = store.detach(&id).expect("detach");
    let rx = detached
        .take_drop_signal()
        .expect("lock ok")
        .expect("signal present");
    drop(detached);

    // The wait resolves once the in-flight ask (cancel fired by detach) winds
    // down and its Arc clone drops -> Session::Drop -> signal. If the wait
    // variant resolved before Session::Drop (the bug), the canonical key would
    // still be held at the assertion below.
    // drop_signal sends unit (); the expect asserts the recv landed Ok (not
    // Disconnected or Timeout) -- the payload itself carries no data.
    rx.recv_timeout(Duration::from_secs(5))
        .expect("signal fires after the in-flight ask wound down");

    let outcome = ask.join().expect("ask thread");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "in-flight turn lands as Cancelled after detach fired cancel, got {outcome:?}"
    );

    assert!(
        toptopduck_lib::persistence::try_acquire(&canonical),
        "canonical key released after the wait resolved -- delete_session's gate succeeds"
    );
    toptopduck_lib::persistence::release(&canonical); // cleanup
}

#[test]
fn close_wait_release_signal_does_not_fire_while_an_arc_clone_is_held() {
    // ADR-0063 Decision 4: the wait variant blocks until the LAST Arc clone
    // drops. A held clone (a long ask, or any leak) keeps Session::Drop from
    // running, so the signal does NOT fire and recv_timeout times out. Once
    // the clone drops, the signal fires on the next recv. This is the timeout
    // contract (aligned to ADR-0021 REQUEST_TIMEOUT in the command) tested at
    // the mechanism level with a short window.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");
    let id = bound_session(&store, &duck);

    // Hold a clone that keeps the Session alive past detach (simulates an
    // in-flight ask whose provider ignores cancel, or any Arc leak).
    let held = store.get(&id).expect("held clone");

    let detached = store.detach(&id).expect("detach");
    let rx = detached
        .take_drop_signal()
        .expect("lock ok")
        .expect("signal present");
    drop(detached);

    // No Session::Drop while `held` is alive -> the signal cannot fire.
    let err = rx
        .recv_timeout(Duration::from_millis(150))
        .expect_err("must time out while a clone is held");
    assert!(
        matches!(err, mpsc::RecvTimeoutError::Timeout),
        "expected Timeout, got {err:?}"
    );

    // Dropping the held clone -> refcount 0 -> Session::Drop -> signal fires.
    // The receiver survives a prior recv_timeout (it borrows &self), so the
    // next recv observes the now-buffered Ok.
    drop(held);
    rx.recv_timeout(Duration::from_secs(2))
        .expect("signal fires once the held clone drops");
}

#[test]
fn pure_close_does_not_release_canonical_key_while_ask_in_flight() {
    // ADR-0055 vs ADR-0063 contrast (issue #93 root cause): the pure close
    // removes the map entry and returns, but the canonical key stays held
    // until the ask's Arc clone drops. A subsequent delete_session would hit
    // the single-writer gate ("该会话已打开") -- the three-state inconsistency
    // the wait variant closes. This test pins the gap so a regression to
    // "close resolves == key released" is caught.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");

    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new()
        .with_cancel(cancel.clone())
        .scripted("好查询", reply_sql("SELECT 1 AS n"))
        .scripted_blocking("慢查询", reply_sql("SELECT 1 AS n"));
    let id = store
        .create(cancel.clone(), Box::new(provider))
        .expect("create");
    {
        let handle = store.get(&id).expect("handle");
        let mut s = handle.session_lock().unwrap();
        s.bind_duck(duck.clone(), "测试".into()).expect("bind");
        let _ = s.ask("好查询");
    }

    let handle_for_ask = store.get(&id).expect("handle for ask");
    let ask = thread::spawn(move || {
        let mut s = handle_for_ask.session_lock().unwrap();
        s.ask("慢查询")
    });
    await_in_flight(&cancel, Duration::from_secs(2));

    let canonical = toptopduck_lib::persistence::canonicalize_duck(&duck).expect("canonicalize");

    // Pure close resolves immediately (map entry gone), but the canonical key
    // is STILL held by the in-flight ask's Arc clone.
    store.close(&id).expect("close resolves immediately");
    assert!(
        !toptopduck_lib::persistence::try_acquire(&canonical),
        "key STILL held right after pure close -- the gap the wait variant closes"
    );

    // Let the ask wind down (close fired cancel); once its clone drops, the
    // key is released. (Cleanup so the gate state does not leak across tests.)
    cancel.request();
    let _ = ask.join();
    toptopduck_lib::persistence::release(&canonical);
}

#[test]
fn take_drop_signal_returns_none_on_second_take_concurrent_close_wait_defense() {
    // ADR-0063: the drop-signal receiver is single-consumption. A second
    // close-wait on the same id (a concurrent double-close, or a retry after
    // the first detached the handle) finds the slot already empty.
    // `take_drop_signal` returns `Ok(None)` (NOT `Err` -- the lock is
    // healthy) so the command's `ok_or_else` surfaces the typed refusal.
    // This pins the single-waiter guard so a regression to "second take
    // re-arms a stale receiver" or "second take panics" is caught.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");
    let id = bound_session(&store, &duck);

    let detached = store.detach(&id).expect("detach");
    let first = detached
        .take_drop_signal()
        .expect("lock ok")
        .expect("first take has the receiver");
    // A second take on the SAME handle finds the slot empty (the receiver
    // was moved out). This is the concurrent-close-wait defensive path.
    let second = detached.take_drop_signal().expect("lock ok");
    assert!(
        second.is_none(),
        "second take returns Ok(None) -- single-consumption guard"
    );
    // Cleanup: drop the first receiver so the channel closes cleanly.
    drop(first);
    drop(detached);
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

    let handle_for_thread = Arc::clone(&handle_a);
    let ask = thread::spawn(move || {
        let mut s = handle_for_thread.session_lock().unwrap();
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

// --- open_duck reuses the session_id (ADR-0056) ----------------------------

#[test]
fn open_duck_replaces_contents_in_place_other_sessions_unaffected() {
    // ADR-0056 acceptance: open_duck resumes INTO an existing session_id --
    // the command layer replaces the handle's Session (`*s = new_session`),
    // it does NOT mint a new id. This black-box test covers the cross-axis
    // invariant the resume unit tests do not: Session::open_duck running in a
    // MULTI-session store. It drives Session::open_duck and installs the result
    // the way the command does, then asserts (1) the save -> open round-trip
    // restored result_1, (2) the subject id still resolves and no new entry was
    // minted, and (3) another session's working set is untouched by the resume
    // (ADR-0027 isolation holds across the resume path).
    //
    // The id-reuse step itself (`*s = new_session` rather than `store.create`)
    // is structural in the command layer and is reproduced here by hand --
    // black-box tests cannot invoke the tauri command, so this is the closest
    // seam that still exercises Session::open_duck end-to-end.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("a.duck");

    // Producer session: bind + one source-free turn so the .duck recipe holds
    // result_1, then close it to release the registry key (held by the binding
    // session until it drops) so open_duck can acquire the same file.
    let cancel_p = Arc::new(CancelToken::new());
    let provider_p = FakeProvider::new().scripted("建结果", reply_sql("SELECT 1 AS n"));
    let producer = store
        .create(cancel_p, Box::new(provider_p))
        .expect("create producer");
    let handle_p = store.get(&producer).expect("handle producer");
    {
        let mut s = handle_p.session_lock().unwrap();
        s.bind_duck(duck.clone(), "P".into()).expect("bind");
        let outcome = s.ask("建结果");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "producer turn should materialize, got {outcome:?}"
        );
    }
    drop(handle_p);
    store.close(&producer).expect("close producer");

    // The multi-session context: A (empty, the open target) + B (with a source
    // A must not see, so isolation is checkable).
    let a = fresh_session(&store);
    let handle_a = store.get(&a).expect("handle a");
    let b = fresh_session(&store);
    let handle_b = store.get(&b).expect("handle b");
    {
        let mut s = handle_b.session_lock().unwrap();
        match s.ingest(&fixture("people.csv")) {
            LoadOutcome::Loaded(_) => {}
            other => panic!("expected people to load, got {other:?}"),
        }
    }

    // Resume-open the .duck and install it INTO A's handle (the command layer's
    // id-reuse swap). Resume is LLM-free -- it re-executes stored SQL in a fresh
    // DuckDB -- so an UnwiredProvider is enough (no turn is asked of it). The
    // source-issue / active-abandoned callbacks never fire: the recipe has no
    // sources and active is None.
    let resumed = Session::open_duck(
        &duck,
        handle_a.cancel_token(),
        Box::new(toptopduck_lib::UnwiredProvider),
        |_| {},
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    )
    .expect("resume open");
    {
        let mut s = handle_a.session_lock().unwrap();
        *s = resumed;
    }

    // (1) Round-trip: result_1 is restored and served through A's same handle.
    {
        let s = handle_a.session_lock().unwrap();
        let list = s.list();
        let names: Vec<&str> = list.iter().map(|d| d.reference_name.as_str()).collect();
        assert!(
            names.contains(&"result_1"),
            "resumed A has result_1: {names:?}"
        );
    }
    assert!(store.get(&a).is_ok(), "A's id still resolves after open");

    // (2) A's resume did not touch B: B's working set is unchanged (ADR-0027
    //     isolation across the resume path).
    assert!(store.get(&b).is_ok(), "B's id still resolves");
    {
        let s = handle_b.session_lock().unwrap();
        let names: Vec<String> = s.list().iter().map(|d| d.reference_name.clone()).collect();
        assert_eq!(
            names,
            vec!["people".to_string()],
            "B's working set must be unchanged by A's resume (ADR-0027)"
        );
    }
}

// --- close after resume reuses the shared closing flag (ADR-0055, issue #73) -

#[test]
fn close_after_resume_discards_inflight_turn_via_shared_closing_flag() {
    // ADR-0055 across resume (issue #73): `open_duck` re-attaches the handle's
    // monotonic `ClosingFlag` to the resumed `Session` (the command layer's
    // `set_closing_flag(handle.closing_flag())` step), so a `close_session`
    // AFTER resume still discards an in-flight turn -- the resumed session and
    // the handle read ONE shared flag. Without the re-attach, the resumed
    // session's default private flag would never trip and close-after-resume
    // would silently append the turn. This pins the runtime behavior the
    // private-field + accessor refactor guards; it had no integration coverage.
    let store = SessionStore::new();
    let dir = tempfile::tempdir().expect("tempdir");
    let duck = dir.path().join("session.duck");

    // Producer: bind + one turn so the .duck recipe holds result_1, then close
    // to release the canonical-writer key so open_duck can re-acquire the file.
    let cancel_p = Arc::new(CancelToken::new());
    let provider_p = FakeProvider::new().scripted("建结果", reply_sql("SELECT 1 AS n"));
    let producer = store
        .create(cancel_p, Box::new(provider_p))
        .expect("create producer");
    let handle_p = store.get(&producer).expect("handle producer");
    {
        let mut s = handle_p.session_lock().unwrap();
        s.bind_duck(duck.clone(), "测试".into()).expect("bind");
        let outcome = s.ask("建结果");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "producer turn should materialize, got {outcome:?}"
        );
    }
    drop(handle_p);
    store.close(&producer).expect("close producer");

    // Subject session A: created with the SAME cancel token the FakeProvider
    // shares, so a blocking turn on the resumed session is observable and
    // cancellable. A starts on an UnwiredProvider (placeholder); resume swaps
    // in the real FakeProvider-backed session.
    let cancel = Arc::new(CancelToken::new());
    let provider = FakeProvider::new()
        .with_cancel(cancel.clone())
        .scripted("好查询", reply_sql("SELECT 1 AS n"))
        .scripted_blocking("慢查询", reply_sql("SELECT 1 AS n"));
    let a = store
        .create(cancel.clone(), Box::new(toptopduck_lib::UnwiredProvider))
        .expect("create a");
    let handle = store.get(&a).expect("handle a");

    // Resume-open the .duck INTO A's handle the way the command does. The
    // CRITICAL step is re-attaching the handle's closing flag (and cancel
    // token) so a close / cancel after resume reaches the resumed session.
    let mut resumed = Session::open_duck(
        &duck,
        handle.cancel_token(),
        Box::new(provider),
        |_| {},
        |_| SourceResolution::Abort,
        |_| ActiveResolution::Abort,
    )
    .expect("resume open");
    {
        let mut s = handle.session_lock().unwrap();
        resumed.set_closing_flag(handle.closing_flag());
        *s = resumed;
    }

    // Run one successful turn on the resumed session, then spawn the long one.
    {
        let mut s = handle.session_lock().unwrap();
        let outcome = s.ask("好查询");
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "resumed session's first turn should materialize, got {outcome:?}"
        );
    }
    let handle_for_thread = Arc::clone(&handle);
    let ask = thread::spawn(move || {
        let mut s = handle_for_thread.session_lock().unwrap();
        s.ask("慢查询")
    });
    await_in_flight(&cancel, Duration::from_secs(2));

    // Close AFTER resume: must still discard the resumed session's in-flight
    // turn via the shared closing flag.
    store.close(&a).expect("close");

    let outcome = ask.join().expect("ask thread");
    assert!(
        matches!(outcome, TurnOutcome::Cancelled),
        "resumed session's in-flight turn must land Cancelled after close, got {outcome:?}"
    );

    // The cancelled turn did NOT enter the thread (ADR-0055 discard).
    {
        let s = handle.session_lock().unwrap();
        let thread_questions: Vec<&str> = s
            .conversation()
            .iter()
            .filter_map(|e| match e {
                toptopduck_lib::ThreadEntry::Turn(r) => Some(r.question.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            !thread_questions.contains(&"慢查询"),
            "the cancelled resumed turn must not enter the thread: {thread_questions:?}"
        );
    }
}
