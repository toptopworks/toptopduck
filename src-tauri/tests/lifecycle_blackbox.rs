//! Black-box source-lifecycle seam (PRD #3, issue #38): drive add / remove at
//! the Session boundary and assert the consequences the PRD pins -- working-set
//! membership, the source lifecycle event thread (ADR-0040), result_N
//! invariance, the execution-window-free remove path, and that source events
//! never enter the LLM turn window. Fully local, deterministic, no network: the
//! FakeProvider stands in for the LLM (ADR-0007) and the only LLM-touching
//! assertion inspects the request the window assembler produced (captured by
//! the fake), never a real call.

use std::path::{Path, PathBuf};

use toptopduck_lib::{
    FakeProvider, LoadOutcome, ProviderReply, RemoveSourceError, Session, SourceLifecycleKind,
    ThreadEntry, TurnOutcome,
};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn fixture(name: &str) -> PathBuf {
    fixtures_dir().join(name)
}

/// Ingest a fixture, panicking on any non-Loaded outcome -- every test in this
/// file starts from a successfully loaded source, so a load failure is a test
/// setup bug, not a behavior under test.
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

/// A session whose provider scripts one stable SQL reply per question. One
/// session per test keeps the script map scoped and deterministic.
fn session_with_scripts(scripts: &[(&str, &str)]) -> Session {
    let mut provider = FakeProvider::new();
    for (question, sql) in scripts {
        provider = provider.scripted(question, reply_sql(sql));
    }
    Session::with_provider(Box::new(provider)).expect("session")
}

/// Count source lifecycle events of `kind` in the timeline (ADR-0040).
fn count_events(entries: &[ThreadEntry], kind: SourceLifecycleKind) -> usize {
    entries
        .iter()
        .filter(|e| matches!(e, ThreadEntry::Source(ev) if ev.kind == kind))
        .count()
}

#[test]
fn ingest_appends_an_added_event_per_source() {
    // ADR-0040 / issue #38: every ingest path appends an `Added` source
    // lifecycle event -- a first-class thread entry. Regression guard for the
    // closed add paths (#5-#11): they now emit the event without breaking.
    let mut session = session_with_scripts(&[]);
    assert!(session.conversation().is_empty());

    load_source(&mut session, &fixture("people.csv"));
    let entries = session.conversation();
    assert_eq!(entries.len(), 1, "one Added event after the first ingest");
    match &entries[0] {
        ThreadEntry::Source(ev) => {
            assert_eq!(ev.kind, SourceLifecycleKind::Added);
            assert_eq!(ev.reference_name, "people");
            assert!(!ev.display_name.is_empty(), "display label carried");
        }
        other => panic!("expected a Source event, got {other:?}"),
    }
    // A second ingest appends a second Added event -- one per source.
    load_source(&mut session, &fixture("orders.csv"));
    assert_eq!(
        count_events(session.conversation(), SourceLifecycleKind::Added),
        2
    );
}

#[test]
fn remove_source_drops_a_non_active_no_result_source() {
    // AC1/AC2 (issue #38): removing a non-active source with no derived results
    // drops it from the working set (member -1), makes it unreferenceable, and
    // appends exactly one `Deleted` event. The active source is untouched.
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv")); // active = people
    load_source(&mut session, &fixture("orders.csv")); // active = orders now
    assert_eq!(session.list().len(), 2);

    // people is non-active (orders is); no results exist -> safe to remove.
    session
        .remove_source("people")
        .expect("remove non-active source");

    assert_eq!(
        session.list().len(),
        1,
        "working-set member decreased by one"
    );
    assert!(session.get("people").is_none(), "removed source is gone");
    assert!(session.get("orders").is_some(), "other source untouched");
    // active stayed on orders -- removing a non-active source never moves focus.
    assert_eq!(session.active().unwrap().reference_name, "orders");
    // AC1: the removed source is no longer referenceable (read path rejects it).
    assert!(session.read_rows("people", 0, 1).is_err());

    // AC2: exactly one Deleted event, carrying the removed source's identity +
    // the display label captured before removal (so the thread still names it).
    let deleted: Vec<_> = session
        .conversation()
        .iter()
        .filter_map(|e| match e {
            ThreadEntry::Source(ev) if ev.kind == SourceLifecycleKind::Deleted => Some(ev),
            _ => None,
        })
        .collect();
    assert_eq!(deleted.len(), 1, "exactly one Deleted event");
    assert_eq!(deleted[0].reference_name, "people");
    assert!(!deleted[0].display_name.is_empty());
}

#[test]
fn remove_source_refuses_the_active_source() {
    // AC: removing the active source would silently change the user's analysis
    // focus (ADR-0035 forbids a silent jump). Explicit re-selection lands in
    // #39; until then removal of the active source is an honest refusal that
    // leaves the working set untouched.
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv")); // active = people (only source)
    let err = session.remove_source("people").unwrap_err();
    assert!(
        matches!(err, RemoveSourceError::IsActive { .. }),
        "active source removal refused, got {err:?}"
    );
    // Refusal left the working set + thread untouched (no Deleted event).
    assert_eq!(session.list().len(), 1);
    assert!(session.get("people").is_some());
    assert_eq!(
        count_events(session.conversation(), SourceLifecycleKind::Deleted),
        0
    );
}

#[test]
fn remove_source_refuses_while_results_exist() {
    // AC: without the stale-cascade engine (#40) the session cannot honestly
    // mark dependent result_N stale, so removal is refused while any result
    // exists -- the conservative, provenance-free "no derived dependency" guard.
    let mut session =
        session_with_scripts(&[("count people", r#"SELECT COUNT(*) AS n FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    let outcome = session.ask("count people");
    assert!(matches!(outcome, TurnOutcome::Materialized { .. }));
    assert!(session.get("result_1").is_some(), "a result exists now");

    // people is non-active, but a result exists -> HasDerivatives refusal.
    let err = session.remove_source("people").unwrap_err();
    assert!(
        matches!(err, RemoveSourceError::HasDerivatives),
        "removal refused while results exist, got {err:?}"
    );
    // Refusal left the source in place; no Deleted event.
    assert!(session.get("people").is_some());
    assert_eq!(
        count_events(session.conversation(), SourceLifecycleKind::Deleted),
        0
    );
}

#[test]
fn timeline_interleaves_turns_and_source_events_in_order() {
    // ADR-0040: source events share the timeline with turns and occupy their
    // correct chronological position. ingest -> ingest -> delete -> ask yields
    // [Added, Added, Deleted, Turn] -- the delete is stamped at its own slot
    // (not folded into a turn) and the following turn keeps question + outcome.
    // (The delete must precede the ask: a materialized result would otherwise
    // make the remove guard refuse with HasDerivatives -- the conservative
    // rule this slice pins until cascade-stale lands in #40.)
    let mut session =
        session_with_scripts(&[("count", r#"SELECT COUNT(*) AS n FROM "orders".data"#)]);
    load_source(&mut session, &fixture("people.csv")); // [Added]
    load_source(&mut session, &fixture("orders.csv")); // [Added, Added]; active = orders
    session
        .remove_source("people")
        .expect("remove non-active before any result"); // [Added, Added, Deleted]
    session.ask("count"); // [Added, Added, Deleted, Turn]

    let entries = session.conversation();
    assert_eq!(entries.len(), 4);
    assert!(matches!(
        entries[0],
        ThreadEntry::Source(ref ev) if ev.kind == SourceLifecycleKind::Added
    ));
    assert!(matches!(
        entries[1],
        ThreadEntry::Source(ref ev) if ev.kind == SourceLifecycleKind::Added
    ));
    assert!(matches!(
        entries[2],
        ThreadEntry::Source(ref ev) if ev.kind == SourceLifecycleKind::Deleted
    ));
    assert!(matches!(entries[3], ThreadEntry::Turn(_))); // the ask
}

#[test]
fn source_events_do_not_enter_the_llm_turn_window() {
    // ADR-0040 / AC: source lifecycle events are first-class in the thread but
    // NOT turns -- they never enter the LLM turn window or occupy an N=20 slot.
    // Proved by inspecting the request the window assembler handed the fake: the
    // two Added events are in the timeline yet the windowed history counts only
    // prior turns.
    let mut provider = FakeProvider::new();
    provider = provider
        .scripted(
            "first",
            reply_sql(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted(
            "second",
            reply_sql(r#"SELECT COUNT(*) AS n FROM "orders".data"#),
        );
    let captured = provider.captured();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    load_source(&mut session, &fixture("people.csv")); // Added
    load_source(&mut session, &fixture("orders.csv")); // Added (timeline has 2 source events)

    session.ask("first"); // window built from history BEFORE this turn = [Added, Added]
    session.ask("second"); // window from [Added, Added, Turn(first)] -> turns only

    let captured = captured.lock().expect("capture lock");
    assert_eq!(captured.len(), 2, "one request captured per ask");
    // First ask: no prior turns -> the windowed history is empty. If the two
    // Added events leaked into the window, this would be 2.
    assert_eq!(
        captured[0].history.len(),
        0,
        "Added events must not enter the LLM turn window"
    );
    // Second ask: exactly one prior turn -> windowed history is 1. If Added
    // events counted, this would be 3 (2 Added + 1 turn).
    assert_eq!(
        captured[1].history.len(),
        1,
        "only prior turns enter the window, not source events"
    );
}

#[test]
fn source_events_neither_advance_result_n_nor_are_turns() {
    // ADR-0040: result_N advances only on a Materialized turn -- never on a
    // source event. Two ingests + a delete append three source events, yet the
    // first result is still result_1 (no shift, no gap from the events).
    let mut session =
        session_with_scripts(&[("count", r#"SELECT COUNT(*) AS n FROM "orders".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
                                                       // remove a non-active source (no results yet) -> a Deleted event, no result.
    session.remove_source("people").expect("remove non-active");
    // Three source events now sit in the timeline; the next result is result_1.
    assert_eq!(
        count_events(session.conversation(), SourceLifecycleKind::Added),
        2
    );
    assert_eq!(
        count_events(session.conversation(), SourceLifecycleKind::Deleted),
        1
    );
    let outcome = session.ask("count");
    match outcome {
        TurnOutcome::Materialized { dataset, .. } => {
            assert_eq!(
                dataset.reference_name, "result_1",
                "events did not advance result_N"
            );
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
}
