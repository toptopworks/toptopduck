//! Black-box source-lifecycle seam (PRD #3, issue #38): drive add / remove at
//! the Session boundary and assert the consequences the PRD pins -- working-set
//! membership, the source lifecycle event thread (ADR-0040), result_N
//! invariance, the execution-window-free remove path, and that source events
//! never enter the LLM turn window. Fully local, deterministic, no network: the
//! FakeProvider stands in for the LLM (ADR-0007) and the only LLM-touching
//! assertion inspects the request the window assembler produced (captured by
//! the fake), never a real call.

use std::path::{Path, PathBuf};

use rust_xlsxwriter::Workbook;
use serde_json::json;
use toptopduck_lib::provider::tool_calling::{
    ToolTurnMessage, ToolTurnReply, ToolTurnRequest, ToolUse,
};
use toptopduck_lib::{
    FakeProvider, LoadOutcome, RemoveSourceError, Session, SheetGuidance, SheetRectify,
    SourceLifecycleKind, StaleReason, ThreadEntry, TurnFailure, TurnOutcome,
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

/// A materialize tool call promoting `sql` -- one round-trip's reply.
fn materialize(sql: &str) -> ToolTurnReply {
    ToolTurnReply::tool_calls(vec![ToolUse {
        id: "tu_1".into(),
        name: "materialize".into(),
        input: json!({ "sql": sql }),
    }])
}

/// A terminal text answer ending the turn.
fn answer(text: &str) -> ToolTurnReply {
    ToolTurnReply::Text(text.to_string())
}

/// Script a question as one materialize call promoting `sql` plus a terminal
/// text answer -- the standard productive-turn trajectory.
fn productive(sql: &str) -> Vec<Result<ToolTurnReply, toptopduck_lib::ProviderError>> {
    vec![Ok(materialize(sql)), Ok(answer("完成"))]
}

/// A session whose provider scripts each question as one materialize call
/// promoting `sql` plus a terminal text answer. One session per test keeps the
/// script map scoped and deterministic.
fn session_with_scripts(scripts: &[(&str, &str)]) -> Session {
    let mut provider = FakeProvider::new();
    for (question, sql) in scripts {
        provider = provider.scripted_tool_turn_seq(question, productive(sql));
    }
    Session::with_provider(Box::new(provider)).expect("session")
}

/// The captured tool-turn request a question's turn assembled FIRST (one
/// capture per round-trip; the first round-trip ends with the asking question
/// and carries no fed-back tool results yet).
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

/// Count source lifecycle events of `kind` in the timeline (ADR-0040).
fn count_events(entries: &[ThreadEntry], kind: SourceLifecycleKind) -> usize {
    entries
        .iter()
        .filter(|e| matches!(e, ThreadEntry::Source(ev) if ev.kind == kind))
        .count()
}

/// Save a workbook to a temp xlsx. Mirrors `ingest_blackbox`'s helper: each
/// integration-test binary is a separate crate, so the helper is duplicated
/// rather than shared. The returned `TempDir` must outlive the session that
/// reads the file (drop -> the file is removed).
fn save_xlsx(mut wb: Workbook, file_name: &str) -> (PathBuf, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(file_name);
    wb.save(&path).expect("save xlsx fixture");
    (path, dir)
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
        count_events(&session.conversation(), SourceLifecycleKind::Added),
        2
    );
}

#[test]
fn guided_multi_sheet_ingest_appends_an_added_event_per_sheet() {
    // AC3 (issue #38): the guided multi-sheet path (`ingest_guided` ->
    // `commit_excel`) also appends one Added event per sheet, closing the gap
    // left by `ingest_appends_an_added_event_per_source`, which exercises only
    // the plain single-file `ingest`. Two sheets -> two Added events, each
    // carrying its sheet's reference name + display label; both stay registered.
    let mut wb = Workbook::new();
    for name in ["people", "orders"] {
        let ws = wb.add_worksheet();
        ws.set_name(name).expect("name sheet");
        ws.write_string(0, 0, "id").unwrap();
        ws.write_number(1, 0, 1.0).unwrap();
    }
    let (xlsx, _dir) = save_xlsx(wb, "guided_multi.xlsx");

    let mut session = session_with_scripts(&[]);
    let guidance: Vec<SheetGuidance> = ["people", "orders"]
        .iter()
        .map(|name| SheetGuidance {
            name: (*name).into(),
            rectify: SheetRectify {
                header_row: 1,
                skip_rows: vec![],
            },
        })
        .collect();
    match session.ingest_guided(&xlsx, &guidance) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected guided load to succeed, got {other:?}"),
    }

    // Two sheets -> two Added events, one per sheet, in ingest order.
    let conv = session.conversation();
    let added: Vec<_> = conv
        .iter()
        .filter_map(|e| match e {
            ThreadEntry::Source(ev) if ev.kind == SourceLifecycleKind::Added => Some(ev),
            _ => None,
        })
        .collect();
    assert_eq!(added.len(), 2, "one Added event per sheet");
    assert_eq!(added[0].reference_name, "people");
    assert_eq!(added[1].reference_name, "orders");
    assert!(
        added.iter().all(|e| !e.display_name.is_empty()),
        "display label carried per sheet"
    );
    // Both sheets are registered and referenceable.
    assert_eq!(session.list().len(), 2);
    assert!(session.get("people").is_some());
    assert!(session.get("orders").is_some());
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

    // Capture people's display label BEFORE removal so the Deleted event can be
    // checked for naming the EXACT removed source (ADR-0040: "always visible +
    // still names what was removed"), not just a non-empty string -- a regression
    // that blanked or mislabeled the label would slip past a non-empty check.
    let people_display_name = session
        .get("people")
        .expect("people present before removal")
        .display_name;

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
    let conv = session.conversation();
    let deleted: Vec<_> = conv
        .iter()
        .filter_map(|e| match e {
            ThreadEntry::Source(ev) if ev.kind == SourceLifecycleKind::Deleted => Some(ev),
            _ => None,
        })
        .collect();
    assert_eq!(deleted.len(), 1, "exactly one Deleted event");
    assert_eq!(deleted[0].reference_name, "people");
    assert_eq!(
        deleted[0].display_name, people_display_name,
        "Deleted event names the exact removed source's display label"
    );
}

#[test]
fn remove_source_empties_when_last_active_source_removed() {
    // AC4 (issue #39): when the active source IS the last source, removal is
    // allowed through -- the working set goes empty and the UI prompts upload.
    // No silent focus jump happens because there is nothing left to jump to;
    // an empty working set is the user's explicit end state. This is the
    // exception to the IsActive refusal that `remove_active_source` exists to
    // resolve in the multi-source case.
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv")); // active = people (only source)
    session
        .remove_source("people")
        .expect("last active source removal allowed");

    assert!(session.list().is_empty(), "working set is empty");
    assert!(session.get("people").is_none());
    assert!(
        session.active().is_none(),
        "no focus in an empty working set"
    );
    // The Deleted event still lands -- the timeline records what was removed.
    assert_eq!(
        count_events(&session.conversation(), SourceLifecycleKind::Deleted),
        1
    );
}

#[test]
fn remove_source_refuses_active_when_other_sources_remain() {
    // ADR-0035 / issue #39: removing the active source while OTHER sources
    // remain would silently move the user's focus. `remove_source` refuses
    // with `IsActive` so the caller must go through `remove_active_source` to
    // name an explicit continuation (no silent jump). The refusal leaves the
    // working set + thread untouched.
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders now
    assert_eq!(session.list().len(), 2);

    let err = session.remove_source("orders").unwrap_err();
    match err {
        RemoveSourceError::IsActive {
            reference_name,
            display_name,
        } => {
            assert_eq!(reference_name, "orders");
            assert!(!display_name.is_empty(), "display label carried for the UI");
        }
        other => panic!("expected IsActive refusal, got {other:?}"),
    }
    // Refusal left the working set + thread untouched.
    assert_eq!(session.list().len(), 2, "no source dropped on refusal");
    assert!(session.get("orders").is_some());
    assert!(session.get("people").is_some());
    assert_eq!(
        session.active().unwrap().reference_name,
        "orders",
        "focus unchanged"
    );
    assert_eq!(
        count_events(&session.conversation(), SourceLifecycleKind::Deleted),
        0
    );
}

#[test]
fn remove_source_cascades_stale_to_dependent_result() {
    // AC1/AC7 (issue #40): deleting a source marks every result_N that derived
    // from it stale (instead of the #38 conservative refusal). result_1 FROM
    // people -> delete people -> result_1 stays registered but carries a stale
    // anchor tracing back to the Deleted people event (ADR-0040 traceability).
    let mut session =
        session_with_scripts(&[("count people", r#"SELECT COUNT(*) AS n FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    let outcome = session.ask("count people");
    assert!(matches!(outcome, TurnOutcome::Materialized { .. }));
    assert!(session.get("result_1").is_some(), "a result exists now");

    // people is non-active -> remove_source proceeds, cascading result_1 stale.
    session
        .remove_source("people")
        .expect("cascade-stale removal instead of refusal");

    // result_1 stays registered (visible) but is now stale, anchored to people.
    let result_1 = session
        .get("result_1")
        .expect("result_1 still registered after cascade");
    let anchor = result_1
        .stale
        .as_ref()
        .expect("result_1 marked stale after its source was deleted");
    assert_eq!(
        anchor.reference_name, "people",
        "anchor names the deleted source event"
    );
    assert!(
        !anchor.display_name.is_empty(),
        "anchor carries the source's display label"
    );
}

#[test]
fn remove_active_source_switches_focus_and_deletes() {
    // AC1/AC2 (issue #39): deleting the active source with an explicit
    // continuation switches the focus pointer to the chosen source, drops the
    // removed source, and appends a Deleted event -- no silent jump, the user
    // picked where focus goes. The alternative of letting `remove_source` fall
    // through would have moved focus implicitly; this is the explicit path.
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    assert_eq!(session.list().len(), 2);

    let orders_display = session
        .get("orders")
        .expect("orders present")
        .display_name
        .clone();

    session
        .remove_active_source("orders", "people")
        .expect("switch focus + delete");

    // Removed source gone; the other source remains.
    assert!(session.get("orders").is_none());
    assert!(session.get("people").is_some());
    assert_eq!(session.list().len(), 1);
    // AC2: focus switched to the user's explicit choice.
    assert_eq!(
        session.active().unwrap().reference_name,
        "people",
        "focus moved to the chosen continuation"
    );
    // AC2: one Deleted event carrying the removed source's identity + display.
    let conv = session.conversation();
    let deleted: Vec<_> = conv
        .iter()
        .filter_map(|e| match e {
            ThreadEntry::Source(ev) if ev.kind == SourceLifecycleKind::Deleted => Some(ev),
            _ => None,
        })
        .collect();
    assert_eq!(deleted.len(), 1, "exactly one Deleted event");
    assert_eq!(deleted[0].reference_name, "orders");
    assert_eq!(
        deleted[0].display_name, orders_display,
        "Deleted event names the removed source's display label"
    );
    // The removed source is no longer referenceable.
    assert!(session.read_rows("orders", 0, 1).is_err());
}

#[test]
fn remove_active_source_refuses_non_active() {
    // The dialog only fires for the active source, so reaching this path with a
    // non-active name means a stale view raced a concurrent mutation (or a
    // direct IPC). Refuse with `NotActive` before touching anything; the
    // caller refreshes and uses `remove_source` instead.
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders

    let err = session
        .remove_active_source("people", "orders")
        .unwrap_err();
    assert!(
        matches!(err, RemoveSourceError::NotActive(ref n) if n == "people"),
        "non-active ref refused, got {err:?}"
    );
    // Refusal left the working set + focus untouched.
    assert_eq!(session.list().len(), 2);
    assert!(session.get("people").is_some());
    assert_eq!(
        session.active().unwrap().reference_name,
        "orders",
        "focus unchanged"
    );
    assert_eq!(
        count_events(&session.conversation(), SourceLifecycleKind::Deleted),
        0
    );
}

#[test]
fn remove_active_source_refuses_invalid_continue() {
    // The continuation must be a remaining source -- not the removed name, not
    // missing. (A registered `result_N` name is unreachable on the live path:
    // the dialog's candidate list filters results out, and the result-name
    // rejection itself is pinned in `workingset::tests`.) Both invalid forms
    // refuse with `InvalidContinueWith` and leave things put.
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders

    // Equal to the removed name (the dialog lists only the OTHER sources).
    let err = session
        .remove_active_source("orders", "orders")
        .unwrap_err();
    assert!(
        matches!(err, RemoveSourceError::InvalidContinueWith(ref n) if n == "orders"),
        "self-continuation refused, got {err:?}"
    );
    // Unknown reference.
    let err = session.remove_active_source("orders", "ghost").unwrap_err();
    assert!(
        matches!(err, RemoveSourceError::InvalidContinueWith(ref n) if n == "ghost"),
        "unknown continuation refused, got {err:?}"
    );
    // Both refusals left the working set + focus untouched.
    assert_eq!(session.list().len(), 2);
    assert!(session.get("orders").is_some());
    assert!(session.get("people").is_some());
    assert_eq!(session.active().unwrap().reference_name, "orders");
    assert_eq!(
        count_events(&session.conversation(), SourceLifecycleKind::Deleted),
        0
    );
}

#[test]
fn remove_active_source_cascades_stale_to_dependent_result() {
    // AC1/AC7 (issue #40): the cascade reaches the active-source path too --
    // deleting the focus source with an explicit continuation still marks its
    // dependent results stale. result_1 FROM orders ->
    // remove_active_source(orders, people) -> result_1 stale (anchored to
    // orders), focus now on the chosen continuation.
    let mut session =
        session_with_scripts(&[("count", r#"SELECT COUNT(*) AS n FROM "orders".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    let outcome = session.ask("count");
    assert!(matches!(outcome, TurnOutcome::Materialized { .. }));
    assert!(session.get("result_1").is_some());

    session
        .remove_active_source("orders", "people")
        .expect("cascade-stale active removal");

    // Focus moved to the explicit continuation (ADR-0035 / issue #39).
    assert_eq!(
        session.active().unwrap().reference_name,
        "people",
        "focus moved to the chosen continuation"
    );
    // result_1 stale, anchored to orders (the removed source).
    let result_1 = session.get("result_1").expect("result_1 still registered");
    let anchor = result_1.stale.as_ref().expect("result_1 marked stale");
    assert_eq!(anchor.reference_name, "orders");
}

#[test]
fn timeline_interleaves_turns_and_source_events_in_order() {
    // ADR-0040: source events share the timeline with turns and occupy their
    // correct chronological position. ingest -> ingest -> delete -> ask yields
    // [Added, Added, Deleted, Turn] -- the delete is stamped at its own slot
    // (not folded into a turn) and the following turn keeps question + outcome.
    // (The delete precedes the ask so result_1 -- produced by the ask -- is
    // not yet registered when people is removed. #40's cascade would otherwise
    // mark a result that derived from people stale; here people has no
    // dependent at delete time, so the cascade is empty and the order only
    // pins the timeline interleaving.)
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
    // Proved by inspecting the tool-turn request the window assembler handed
    // the fake: the two Added events are in the timeline yet the windowed
    // message array counts only prior turns.
    let mut provider = FakeProvider::new();
    provider = provider
        .scripted_tool_turn_seq(
            "first",
            productive(r#"SELECT COUNT(*) AS n FROM "people".data"#),
        )
        .scripted_tool_turn_seq(
            "second",
            productive(r#"SELECT COUNT(*) AS n FROM "orders".data"#),
        );
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");

    load_source(&mut session, &fixture("people.csv")); // Added
    load_source(&mut session, &fixture("orders.csv")); // Added (timeline has 2 source events)

    session.ask("first"); // window built from history BEFORE this turn = [Added, Added]
    session.ask("second"); // window from [Added, Added, Turn(first)] -> turns only

    let captured = captured.lock().expect("capture lock");
    // First ask: no prior turns -> the message array is just the asking
    // question. If the two Added events leaked into the window, this would
    // carry them.
    let first = request_for(&captured, "first");
    assert_eq!(
        first.messages.len(),
        1,
        "Added events must not enter the LLM turn window: {:?}",
        first.messages
    );
    // Second ask: exactly one prior turn -> user + assistant + the asking
    // question = 3 messages. If Added events counted, this would be more.
    let second = request_for(&captured, "second");
    assert_eq!(
        second.messages.len(),
        3,
        "only prior turns enter the window, not source events: {:?}",
        second.messages
    );

    // Stronger ADR-0040 invariant: source events must not leak into the
    // payload in ANY form -- not just that the message count is right. A
    // future refactor that folded source events into the window while keeping
    // the count unchanged would pass the length checks above; this text guard
    // catches it. "Added"/"Deleted" are SourceLifecycleKind variants -- a
    // tool-turn message's Debug never emits them, so any hit is a leak.
    for (i, req) in captured.iter().enumerate() {
        let dump = format!("{:?}", req.messages);
        assert!(
            !dump.contains("Added") && !dump.contains("Deleted"),
            "request {i}: source-event kind leaked into provider payload: {dump}"
        );
    }
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
        count_events(&session.conversation(), SourceLifecycleKind::Added),
        2
    );
    assert_eq!(
        count_events(&session.conversation(), SourceLifecycleKind::Deleted),
        1
    );
    let outcome = session.ask("count");
    match outcome {
        TurnOutcome::Materialized { promotions, .. } => {
            let primary = promotions.last().expect("a result turn carries promotions");
            assert_eq!(
                primary.dataset.reference_name, "result_1",
                "events did not advance result_N"
            );
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
}

#[test]
fn delete_source_cascades_transitively_through_chained_results() {
    // AC2 (issue #40): the cascade is transitive. result_1 FROM orders, then
    // result_2 FROM result_1; deleting orders marks BOTH result_1 (direct) and
    // result_2 (via the now-stale result_1) stale.
    let mut session = session_with_scripts(&[
        ("first", r#"SELECT COUNT(*) AS n FROM "orders".data"#),
        ("second", r#"SELECT * FROM "result_1""#),
    ]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.ask("first"); // result_1 FROM orders
    session.ask("second"); // result_2 FROM result_1
    assert!(session.get("result_2").is_some());

    // delete orders -> cascade: result_1 (direct) + result_2 (via result_1).
    session
        .remove_active_source("orders", "people")
        .expect("cascade");
    let r1 = session.get("result_1").expect("result_1 registered");
    let r2 = session.get("result_2").expect("result_2 registered");
    assert!(r1.stale.is_some(), "result_1 stale (direct dependency)");
    assert!(
        r2.stale.is_some(),
        "result_2 stale (transitive via result_1)"
    );
}

#[test]
fn stale_result_remains_visible_in_working_set_and_thread() {
    // AC3 (issue #40): a stale result stays in the working set list AND its
    // producing turn stays in the thread -- soft invalidation keeps the user's
    // visible history. (Staleness is rendered off the descriptor's anchor; the
    // turn entry itself is unchanged, ADR-0028 always-visible.)
    let mut session =
        session_with_scripts(&[("count", r#"SELECT COUNT(*) AS n FROM "orders".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv"));
    session.ask("count"); // result_1
    session
        .remove_active_source("orders", "people")
        .expect("cascade");

    // Working set still lists result_1 (soft, not removed).
    assert!(
        session
            .list()
            .iter()
            .any(|d| d.reference_name == "result_1"),
        "stale result stays in working set list"
    );
    // Thread still has the producing turn (always-visible, ADR-0028).
    assert!(
        session.conversation().iter().any(|e| matches!(
            e,
            ThreadEntry::Turn(t) if matches!(&t.outcome,
                TurnOutcome::Materialized { promotions, .. }
                if promotions.iter().any(|p| p.dataset.reference_name == "result_1"))
        )),
        "stale result's producing turn stays in thread"
    );
}

#[test]
fn new_question_referencing_stale_result_is_rejected() {
    // AC4 (issue #40, ADR-0013 invariant 2): a stale result_N may not anchor a
    // new derivation -- the provenance pre-check refuses the materialize call
    // before any execution. Under the agent contract (ADR-0077) the refusal
    // routes back to the model as a tool error; a model that never
    // self-corrects (the script clamps to the same stale-referencing call)
    // exhausts the step cap and the turn fails honestly. Nothing derives from
    // the dead reference.
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "count",
            vec![
                Ok(materialize(r#"SELECT COUNT(*) AS n FROM "orders".data"#)),
                Ok(answer("done")),
            ],
        )
        // No terminal answer: the stale-referencing call clamps, re-issued
        // every round-trip until the step cap fails the turn.
        .scripted_tool_turn("again", materialize(r#"SELECT * FROM "result_1""#));
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.ask("count"); // result_1 FROM orders
                          // delete orders -> result_1 (FROM orders) goes stale.
    session
        .remove_active_source("orders", "people")
        .expect("cascade");
    assert!(session.get("result_1").unwrap().stale.is_some());

    let outcome = session.ask("again"); // materialize FROM result_1 -> refused
    match outcome {
        TurnOutcome::Failed(TurnFailure::Execute { detail }) => {
            assert!(
                detail.contains("did not converge"),
                "the non-correcting stale-reference loop exhausts the step cap: {detail:?}"
            );
        }
        other => panic!("step-cap Failed after stale-reference refusal, got {other:?}"),
    }
    assert!(
        session.get("result_2").is_none(),
        "nothing derived from the stale reference"
    );
}

#[test]
fn stale_reference_self_corrects_by_redirecting_to_active_source() {
    // ADR-0077 positive recovery (issue #323): the self-correction routing
    // handles the stale-reference flavor. A model that first references a
    // stale result_N (provenance pre-check rejects, tool error routes back)
    // and then redirects to the active source recovers, landing a Materialized
    // turn. This is the positive diagonal to
    // `new_question_referencing_stale_result_is_rejected` -- that test pins the
    // negative exit (a non-correcting model clamps to the stale call and
    // exhausts the step cap); this one pins the recovery: the model sees the
    // stale tool error, switches to the live source, and the turn succeeds.
    let provider = FakeProvider::new()
        .scripted_tool_turn_seq(
            "count",
            vec![
                Ok(materialize(r#"SELECT COUNT(*) AS n FROM "orders".data"#)),
                Ok(answer("done")),
            ],
        )
        .scripted_tool_turn_seq(
            "recheck",
            vec![
                // First call: reference stale result_1 -- provenance pre-check
                // refuses, the tool error routes back to the model.
                Ok(materialize(r#"SELECT * FROM "result_1""#)),
                // Second call: redirect to the still-active source -- succeeds.
                Ok(materialize(r#"SELECT COUNT(*) AS n FROM "people".data"#)),
                Ok(answer("redirected")),
            ],
        );
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.ask("count"); // result_1 FROM orders
                          // Delete orders -> result_1 cascade-stale (anchored to the deleted source).
    session
        .remove_active_source("orders", "people")
        .expect("cascade");
    assert!(session.get("result_1").unwrap().stale.is_some());

    // Snapshot the capture count to isolate this turn's round-trips.
    let before = captured.lock().expect("capture lock").len();
    let outcome = session.ask("recheck");
    let round_trips = captured.lock().expect("capture lock").len() - before;

    // AC1: the turn landed Materialized, not step-cap-exhausted Failed.
    let primary = outcome
        .primary_promotion()
        .expect("Materialized with a promotion");
    assert_eq!(
        primary.dataset.reference_name, "result_2",
        "redirect produced a fresh active result"
    );

    // AC2: the new result is anchored to the active source, not stale.
    assert!(
        session.get("result_2").unwrap().stale.is_none(),
        "result_2 anchored to the active source"
    );

    // AC3: self-correction converged in 3 round-trips (stale ref -> redirect
    // -> answer), not the 24-step-cap exhaustion a non-correcting loop hits.
    assert_eq!(
        round_trips, 3,
        "self-correction converged in 3 round-trips, not step-cap exhaustion"
    );
}

#[test]
fn stale_result_excluded_from_llm_window() {
    // AC5 (issue #40, ADR-0013 invariant 3): a stale result_N does not enter
    // the LLM-visible working set. Proved by inspecting the tool-turn request
    // the window assembler handed the fake: after result_1 goes stale, the
    // next ask's system-prompt schema context omits it (while the still-active
    // source remains).
    let mut provider = FakeProvider::new();
    provider = provider
        .scripted_tool_turn_seq(
            "count",
            vec![
                Ok(materialize(r#"SELECT COUNT(*) AS n FROM "orders".data"#)),
                Ok(answer("done")),
            ],
        )
        .scripted_tool_turn_seq(
            "next",
            vec![Ok(materialize("SELECT 1 AS n")), Ok(answer("done"))],
        );
    let captured = provider.captured_tool_turns();
    let mut session = Session::with_provider(Box::new(provider)).expect("session");
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.ask("count"); // result_1 from orders
    session
        .remove_active_source("orders", "people")
        .expect("cascade"); // result_1 stale
    session.ask("next"); // window built here

    let reqs = captured.lock().expect("capture lock");
    let system = &request_for(&reqs, "next").system;
    assert!(
        !system.contains("引用名 = result_1"),
        "stale result_1 excluded from the schema context"
    );
    assert!(
        system.contains("引用名 = people"),
        "active source still present in the schema context"
    );
}

#[test]
fn read_rows_returns_history_for_stale_result() {
    // AC6 (issue #40, ADR-0013 invariant 1): a stale result stays VISIBLE --
    // read_rows still returns its historical data (the point of soft
    // invalidation vs a hard delete that would erase the user's results).
    let mut session =
        session_with_scripts(&[("count", r#"SELECT COUNT(*) AS n FROM "orders".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv"));
    session.ask("count"); // result_1 (COUNT -> 1 row)
    session
        .remove_active_source("orders", "people")
        .expect("cascade");
    assert!(session.get("result_1").unwrap().stale.is_some());

    // read_rows still works on the stale result, returning its preserved rows.
    let page = session
        .read_rows("result_1", 0, 10)
        .expect("stale result history is readable");
    assert_eq!(page.total, 1, "result_1 row count preserved while stale");
}

#[test]
fn result_number_takes_max_plus_one_after_stale() {
    // AC8 (issue #40, ADR-0022/0013): after a result goes stale, the next
    // materialization takes max(existing)+1 -- stale numbers are never reused
    // and gaps are never back-filled. result_1 stale -> next is result_2.
    let mut session = session_with_scripts(&[
        ("count", r#"SELECT COUNT(*) AS n FROM "orders".data"#),
        ("more", r#"SELECT COUNT(*) AS n FROM "people".data"#),
    ]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.ask("count"); // result_1 from orders
    session
        .remove_active_source("orders", "people")
        .expect("cascade"); // result_1 stale; people now active source
    assert!(session.get("result_1").unwrap().stale.is_some());

    let outcome = session.ask("more"); // FROM people -> new result
    match outcome {
        TurnOutcome::Materialized { promotions, .. } => {
            let primary = promotions.last().expect("a result turn carries promotions");
            assert_eq!(
                primary.dataset.reference_name, "result_2",
                "next result is max+1, never reusing the stale number"
            );
        }
        other => panic!("expected Materialized result_2, got {other:?}"),
    }
}

#[test]
fn already_stale_result_keeps_first_anchor_on_second_cascade() {
    // ADR-0041 (issue #40): a result already stale keeps its FIRST anchor when
    // a later, independent source delete ripples through it again -- the
    // earliest invalidating event is the truth, and a dead turn is never
    // revived. result_1 depends on BOTH orders and people (a UNION of each
    // source's row count). Deleting orders first marks it stale anchored to
    // orders; a subsequent delete of people reaches it again (it also depends
    // on people), but must NOT overwrite the first anchor.
    //
    // leading_zero is loaded last so it becomes the active source -- both
    // orders and people are then non-active, so each delete goes through the
    // plain `remove_source` path (no active-continuation dance needed).
    let mut session = session_with_scripts(&[(
        "both",
        r#"SELECT COUNT(*) AS n FROM "orders".data UNION ALL SELECT COUNT(*) AS n FROM "people".data"#,
    )]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv"));
    load_source(&mut session, &fixture("leading_zero.csv")); // active = leading_zero
    session.ask("both"); // result_1 depends on {orders, people}
    assert!(session.get("result_1").is_some());

    // First delete: orders -> result_1 stale, anchored to orders.
    session.remove_source("orders").expect("remove orders");
    let r1 = session.get("result_1").expect("result_1 registered");
    assert_eq!(
        r1.stale
            .as_ref()
            .expect("result_1 stale after orders delete")
            .reference_name,
        "orders",
        "first anchor is the first-deleted source"
    );

    // Second delete: people -> the cascade reaches result_1 again (it also
    // depends on people), but result_1 is already stale, so its anchor stays
    // "orders" (ADR-0041 -- a later invalidating event never revises the
    // first).
    session.remove_source("people").expect("remove people");
    let r1 = session.get("result_1").expect("result_1 still registered");
    assert_eq!(
        r1.stale
            .as_ref()
            .expect("result_1 still stale")
            .reference_name,
        "orders",
        "second cascade did not overwrite the first anchor"
    );
}

// --- Source replace cascade (issue #41, ADR-0025/0041) ---------------------
//
// Replacing a source (re-upload under the same reference name) cascades its
// dependent result_N stale, each anchored to a Replaced event. Mirrors the
// delete-cascade shape: the reference name is stable (the new snapshot takes
// it over), so the cascade keys correctly; a result already stale keeps its
// first anchor (ADR-0041 终局死轮). Distinct from delete: the source stays
// registered (now backing onto the new snapshot) and a Replaced event lands.

#[test]
fn replace_source_cascades_stale_to_dependent_result() {
    // AC1 (issue #41): replacing a source marks every result_N that derived
    // from it stale, anchored to the Replaced event (ADR-0040 traceability).
    // result_1 FROM people -> replace people with flat.json -> result_1 stays
    // registered but carries a stale anchor whose reason is Replaced.
    let mut session =
        session_with_scripts(&[("count people", r#"SELECT COUNT(*) AS n FROM "people".data"#)]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    let outcome = session.ask("count people");
    assert!(matches!(outcome, TurnOutcome::Materialized { .. }));
    assert!(session.get("result_1").is_some(), "a result exists now");

    // Replace people (non-active) with flat.json -> cascade result_1 stale.
    match session.replace_source("people", &fixture("flat.json")) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to succeed, got {other:?}"),
    }

    // result_1 stays registered (visible) but is now stale, anchored to people
    // with reason Replaced -- distinguishing a replace-cascade from a delete.
    let result_1 = session
        .get("result_1")
        .expect("result_1 still registered after replace cascade");
    let anchor = result_1
        .stale
        .as_ref()
        .expect("result_1 marked stale after its source was replaced");
    assert_eq!(
        anchor.reference_name, "people",
        "anchor names the replaced source event"
    );
    assert_eq!(
        anchor.reason,
        StaleReason::Replaced,
        "anchor reason is Replaced, distinguishing a delete-cascade"
    );
}

#[test]
fn replace_source_appends_a_replaced_event() {
    // AC1 (issue #41): a replace appends exactly one Replaced source lifecycle
    // event carrying the stable reference name + carried-over display label.
    // First-class in the thread (always visible, occupies a slot) but NOT a
    // turn -- never enters the LLM window (ADR-0040).
    let mut session = session_with_scripts(&[]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    let people_display = session
        .get("people")
        .expect("people present")
        .display_name
        .clone();

    match session.replace_source("people", &fixture("flat.json")) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to succeed, got {other:?}"),
    }

    let conv = session.conversation();
    let replaced: Vec<_> = conv
        .iter()
        .filter_map(|e| match e {
            ThreadEntry::Source(ev) if ev.kind == SourceLifecycleKind::Replaced => Some(ev),
            _ => None,
        })
        .collect();
    assert_eq!(replaced.len(), 1, "exactly one Replaced event");
    assert_eq!(replaced[0].reference_name, "people");
    assert_eq!(
        replaced[0].display_name, people_display,
        "Replaced event carries the source's display label"
    );
    // A replace is NOT also an Added or Deleted -- only Replaced lands.
    assert_eq!(
        count_events(&session.conversation(), SourceLifecycleKind::Added),
        2,
        "two Added events (people + orders) from the initial loads"
    );
    assert_eq!(
        count_events(&session.conversation(), SourceLifecycleKind::Deleted),
        0,
        "a replace never emits a Deleted event"
    );
}

#[test]
fn replace_does_not_revive_stale_result_fresh_ask_yields_new_number() {
    // AC5 / ADR-0041 (issue #41): a stale result_N is never revived. After a
    // replace cascades result_1 stale, asking the same question again does NOT
    // reuse result_1; it produces result_2 (max+1, ADR-0022). The stale SQL
    // stays in the visible thread (a reference for the LLM within the window,
    // ADR-0023) but the system never auto-reruns it.
    let mut session = session_with_scripts(&[
        ("q1", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q2", r#"SELECT COUNT(*) AS n FROM "people".data"#),
    ]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.ask("q1"); // result_1
    assert!(session.get("result_1").is_some());

    match session.replace_source("people", &fixture("flat.json")) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to succeed, got {other:?}"),
    }
    // result_1 is stale now.
    assert!(session.get("result_1").expect("result_1").stale.is_some());

    // Re-asking the same question produces a fresh result_2, NOT a revival of
    // result_1 (ADR-0041 终局死轮; ADR-0022 编号不重用).
    let second = session.ask("q2");
    match second {
        TurnOutcome::Materialized { promotions, .. } => {
            let primary = promotions.last().expect("a result turn carries promotions");
            assert_eq!(
                primary.dataset.reference_name, "result_2",
                "fresh result_2, not a revival of stale result_1"
            );
        }
        other => panic!("expected Materialized, got {other:?}"),
    }
    // result_1 is still registered AND still stale -- visible but dead.
    let r1 = session.get("result_1").expect("result_1 still registered");
    assert!(r1.stale.is_some(), "result_1 stays stale (not revived)");
}

#[test]
fn replace_cascade_keeps_already_stale_first_anchor() {
    // ADR-0041 (issue #41): a result already stale from a delete keeps its
    // first (Deleted) anchor when a later replace of another source ripples
    // through it again -- the earliest invalidating event is the truth. This
    // mirrors `already_stale_result_keeps_first_anchor_on_second_cascade` but
    // with the second cascade triggered by a replace instead of a delete.
    //
    // leading_zero is loaded last so it becomes active; both orders and people
    // are non-active, so the delete + replace go through the plain paths.
    let mut session = session_with_scripts(&[(
        "both",
        r#"SELECT COUNT(*) AS n FROM "orders".data UNION ALL SELECT COUNT(*) AS n FROM "people".data"#,
    )]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv"));
    load_source(&mut session, &fixture("leading_zero.csv")); // active = leading_zero
    session.ask("both"); // result_1 depends on {orders, people}

    // First: delete orders -> result_1 stale, anchored to orders (Deleted).
    session.remove_source("orders").expect("remove orders");
    let r1 = session.get("result_1").expect("result_1");
    let anchor = r1.stale.as_ref().expect("stale after orders delete");
    assert_eq!(
        anchor.reason,
        StaleReason::Deleted,
        "first anchor is a Deleted reason"
    );
    assert_eq!(anchor.reference_name, "orders");

    // Second: replace people -> cascade reaches result_1 again, but it keeps
    // its first anchor (orders, Deleted) -- the replace does not revise it.
    match session.replace_source("people", &fixture("flat.json")) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to succeed, got {other:?}"),
    }
    let r1 = session.get("result_1").expect("result_1 still registered");
    let anchor = r1.stale.as_ref().expect("still stale");
    assert_eq!(
        anchor.reference_name, "orders",
        "first anchor (orders) preserved across the replace cascade"
    );
    assert_eq!(
        anchor.reason,
        StaleReason::Deleted,
        "first anchor reason (Deleted) preserved, not overwritten by Replaced"
    );
}

// --- GC cap (issue #42, ADR-0013) ------------------------------------------
//
// result_N total over M=100 -> auto-reclaim the oldest stale; active results
// are never auto-deleted. Tested with a lowered cap (set_result_count_cap) for
// a fast, deterministic trigger -- the row-cap twin uses the same approach.
// Each result depends on `people` so a replace cascades them stale; the fresh
// question after the replace materializes against the new snapshot and trips
// the cap. GC runs on the materialize path, so these are plain Session asks.

#[test]
fn gc_reclaims_oldest_stale_when_result_count_exceeds_cap() {
    // AC2 (issue #42): materializing past the cap reclaims the oldest stale
    // result -- its reference name + physical table are gone, the younger
    // stale siblings + the fresh active result stay. Three results depend on
    // people; replacing people cascades them stale; the 4th ask trips the cap.
    let mut session = session_with_scripts(&[
        ("q1", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q2", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q3", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q4", r#"SELECT COUNT(*) AS n FROM "people".data"#),
    ]);
    load_source(&mut session, &fixture("people.csv")); // active = people
    load_source(&mut session, &fixture("orders.csv")); // active = orders now
    session.set_result_count_cap(3);

    session.ask("q1"); // result_1 FROM people
    session.ask("q2"); // result_2 FROM people
    session.ask("q3"); // result_3 FROM people
                       // Replace people (non-active) -> result_1/2/3 cascade stale.
    match session.replace_source("people", &fixture("flat.json")) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to succeed, got {other:?}"),
    }
    for n in ["result_1", "result_2", "result_3"] {
        assert!(
            session.get(n).unwrap().stale.is_some(),
            "{n} stale after the replace cascade"
        );
    }

    // q4 materializes against the new people snapshot -> count 4 > cap 3 ->
    // GC reclaims the oldest stale (result_1).
    let outcome = session.ask("q4");
    match outcome {
        TurnOutcome::Materialized { promotions, .. } => {
            let primary = promotions.last().expect("a result turn carries promotions");
            assert_eq!(primary.dataset.reference_name, "result_4");
        }
        other => panic!("expected Materialized result_4, got {other:?}"),
    }

    // result_1 reclaimed: not registered AND not readable (physical table gone).
    assert!(
        session.get("result_1").is_none(),
        "result_1 GC'd from registry"
    );
    assert!(
        session.read_rows("result_1", 0, 1).is_err(),
        "result_1 physical table dropped -> unreadable"
    );
    // result_2 / result_3 stay registered + stale (younger stale, untouched).
    let r2 = session.get("result_2").expect("result_2 still registered");
    assert_eq!(
        r2.stale
            .as_ref()
            .expect("result_2 still stale")
            .reference_name,
        "people"
    );
    assert!(session
        .get("result_3")
        .expect("result_3 still registered")
        .stale
        .is_some());
    // result_4 (the fresh one) is active -- never a GC candidate.
    assert!(
        session.get("result_4").unwrap().stale.is_none(),
        "fresh result is active"
    );
}

#[test]
fn gc_never_reclaims_active_results() {
    // AC1/AC3 (issue #42): with no stale results to reclaim, the count stays
    // over the soft cap -- active results are never auto-deleted. Two active
    // results under a cap of 1: the overshoot finds nothing stale to reclaim.
    let mut session =
        session_with_scripts(&[("q1", r#"SELECT 1 AS n"#), ("q2", r#"SELECT 2 AS n"#)]);
    load_source(&mut session, &fixture("people.csv"));
    session.set_result_count_cap(1);

    session.ask("q1"); // result_1, active; count 1 = cap -> no GC
    session.ask("q2"); // result_2, active; count 2 > cap 1, no stale -> none reclaimed

    for n in ["result_1", "result_2"] {
        let d = session.get(n).expect("active result still registered");
        assert!(d.stale.is_none(), "{n} stays active (never auto-deleted)");
    }
    let result_count = session
        .list()
        .iter()
        .filter(|d| d.reference_name.starts_with("result_"))
        .count();
    assert_eq!(
        result_count, 2,
        "both active results preserved despite the overshoot"
    );
}

#[test]
fn gc_preserves_producing_turn_in_thread() {
    // AC4 (issue #42): a GC'd result's producing turn stays in the thread --
    // visible history is retained; only the result's data becomes
    // unreferenceable. The TurnRecord names result_1 even after result_1 is
    // GC'd (its dataset snapshot is at-materialization-time, never rewritten).
    let mut session = session_with_scripts(&[
        ("q1", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q2", r#"SELECT COUNT(*) AS n FROM "people".data"#),
    ]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.set_result_count_cap(1);

    session.ask("q1"); // result_1 FROM people
    match session.replace_source("people", &fixture("flat.json")) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to succeed, got {other:?}"),
    }
    assert!(session.get("result_1").unwrap().stale.is_some());
    // q2 -> result_2; count 2 > cap 1 -> GC result_1 (the only stale).
    session.ask("q2");

    assert!(session.get("result_1").is_none(), "result_1 reclaimed");
    // The producing turn still names result_1 -- visible history preserved.
    assert!(
        session.conversation().iter().any(|e| matches!(e,
            ThreadEntry::Turn(t) if matches!(&t.outcome,
                TurnOutcome::Materialized { promotions, .. }
                if promotions.iter().any(|p| p.dataset.reference_name == "result_1"))
        )),
        "result_1's producing turn stays in the thread after GC"
    );
}

#[test]
fn gc_leaves_number_holes_never_reused() {
    // AC5 (issue #42): after GC, the next result still takes max(existing)+1 --
    // a GC'd number is a permanent hole (ADR-0022 never-reused). result_1 GC'd
    // -> the next materialization is result_5 (max of 2/3/4 + 1), NOT result_1.
    let mut session = session_with_scripts(&[
        ("q1", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q2", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q3", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q4", r#"SELECT COUNT(*) AS n FROM "people".data"#),
        ("q5", r#"SELECT COUNT(*) AS n FROM "people".data"#),
    ]);
    load_source(&mut session, &fixture("people.csv"));
    load_source(&mut session, &fixture("orders.csv")); // active = orders
    session.set_result_count_cap(3);

    session.ask("q1"); // result_1
    session.ask("q2"); // result_2
    session.ask("q3"); // result_3
    match session.replace_source("people", &fixture("flat.json")) {
        LoadOutcome::Loaded(_) => {}
        other => panic!("expected replace to succeed, got {other:?}"),
    }
    session.ask("q4"); // result_4; GC reclaims result_1 (oldest stale)
    assert!(session.get("result_1").is_none(), "result_1 GC'd");

    // Next materialization: max(2,3,4)+1 = 5, never reusing the result_1 hole.
    let outcome = session.ask("q5");
    match outcome {
        TurnOutcome::Materialized { promotions, .. } => {
            let primary = promotions.last().expect("a result turn carries promotions");
            assert_eq!(
                primary.dataset.reference_name, "result_5",
                "GC'd number is a hole, not reused (ADR-0022)"
            );
        }
        other => panic!("expected Materialized result_5, got {other:?}"),
    }
}
