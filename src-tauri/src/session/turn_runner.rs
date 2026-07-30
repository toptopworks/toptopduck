//! The turn orchestrator, split out as a deep module (ADR-0053).
//!
//! [`TurnRunner`] owns the retry loop, the cancel/in-flight guard, the
//! optional timeout watchdog, and the outcome routing (Materialized / Textual
//! / Failed / Cancelled). It holds the provider and the materializer behind
//! `Box<dyn ...>` (dyn, not generic, so `Session` does not parameterize
//! `commands.rs` / `lib.rs` -- ADR-0053 Decision 4) plus the shared cancel
//! token and the turn timeout.
//!
//! It is pure orchestration: it does NOT read the conversation history and
//! does NOT persist. Assembling the provider request and recording the
//! outcome stay on the `Session::ask` facade -- the runner is the
//! retry / cancel / error-routing surface only, which is what makes a unit
//! test with a fake materializer exhaustive over the five routing branches
//! (Resource / StaleReference / budget exhaustion / cancel-over-textual /
//! NotWired) without constructing a whole Session or touching DuckDB.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::cancel::CancelToken;
use crate::guardrail::ExecErrorKind;
use crate::model::{TurnFailure, TurnOutcome, TurnPhase};
use crate::provider::{Provider, ProviderError, ProviderReply, ProviderRequest};
use crate::session::materializer::{Materializer, TurnDeps};

/// The retry budget (ADR-0028): a turn is attempted up to 3 times total -- the
/// initial attempt plus 2 retries. Permanent failures (Resource /
/// StaleReference / NotWired / Cancelled) short-circuit and never consume the
/// budget; only transient/retryable failures (Schema / Runtime / Unavailable)
/// feed it.
const TURN_RETRY_BUDGET: u32 = 2;

/// Pure turn orchestration (ADR-0053): the retry loop, the cancel/in-flight
/// guard, the optional timeout watchdog, and the outcome routing. Holds the
/// provider and materializer behind `Box<dyn>` (dyn, not generic) plus the
/// shared cancel token and the optional turn timeout. Does NOT read history
/// and does NOT persist -- the `Session::ask` facade assembles the request,
/// computes `result_name`, calls [`Self::run`], then records the returned
/// outcome.
pub(crate) struct TurnRunner {
    provider: Box<dyn Provider>,
    materializer: Box<dyn Materializer>,
    cancel: Arc<CancelToken>,
    turn_timeout: Option<Duration>,
}

impl TurnRunner {
    pub(crate) fn new(
        provider: Box<dyn Provider>,
        materializer: Box<dyn Materializer>,
        cancel: Arc<CancelToken>,
    ) -> Self {
        Self {
            provider,
            materializer,
            cancel,
            turn_timeout: None,
        }
    }

    /// Set a wall-clock ceiling on each turn (ADR-0005/0021 statement-timeout
    /// path). When set, [`Self::run`] arms a watchdog that fires cancel on
    /// expiry; the running query is interrupted and the turn lands as
    /// Cancelled (ADR-0028 outcome D). `None` disables the turn-level timeout
    /// (the default; engine resource caps still apply). Tunable for
    /// deterministic timeout tests.
    pub(crate) fn set_turn_timeout(&mut self, timeout: Option<Duration>) {
        self.turn_timeout = timeout;
    }

    /// Borrow the shared materializer (ADR-0053 Decision 2/3): the resume path
    /// reuses the SAME `Materializer` trait object the live-turn path drives,
    /// so a fake materializer injected for a `Resumer` unit test exercises the
    /// replay branch without DuckDB / a filesystem. Returns `&mut dyn` (dyn, not
    /// generic) so `Session` stays unparameterized across `commands.rs` --
    /// disjoint-field borrow of `session.turn_runner` lets `open_duck` mutably
    /// borrow `session.working_set` concurrently.
    pub(crate) fn materializer_mut(&mut self) -> &mut dyn Materializer {
        &mut *self.materializer
    }

    /// Run one turn: drive the provider, route the reply, and on a SQL reply
    /// drive the materializer -- retrying transient failures up to the budget
    /// and short-circuiting permanent ones. Returns the terminal outcome; the
    /// caller records it. `on_phase` receives a discrete [`TurnPhase`] marker at
    /// each wait boundary (ADR-0059): `Thinking` before `provider.generate` and
    /// `Querying` before `try_materialize`, each carrying the 1-based attempt
    /// number so a blind retry is honestly distinguishable from the first try.
    /// Pass a no-op callback to ignore the phase channel.
    ///
    /// Pure orchestration (ADR-0053): does not read `history` and does not
    /// call `persist_if_bound`. The retry / cancel / error-routing branches
    /// are exhaustive over a unit test with a fake materializer (Resource /
    /// StaleReference do not retry; budget exhaustion aggregates every
    /// failure's reason; cancel wins over a textual reply; NotWired does not
    /// consume the budget). The phase callback is the only addition; tests that
    /// ignore it pass a no-op and are otherwise unchanged.
    pub(crate) fn run_with_phase(
        &mut self,
        request: &ProviderRequest,
        result_name: String,
        deps: &mut TurnDeps,
        mut on_phase: impl FnMut(TurnPhase),
    ) -> TurnOutcome {
        // Single in-flight + cancellation (ADR-0021, issue #28): begin the turn
        // on the shared token (marks in-flight, clears any stale request from a
        // prior turn) and arm the optional timeout watchdog. The guard is held
        // to end of scope -- its Drop clears in-flight + the interrupt slot on
        // every exit (including the early Cancelled returns below) and
        // invalidates the watchdog so a late timeout cannot fire into the next
        // turn. Clone the Arc into a local so `&cancel` borrows that local, not
        // `&mut self` (the materializer takes a `&CancelToken`).
        let cancel = Arc::clone(&self.cancel);
        let guard = cancel.begin_turn();
        if let Some(timeout) = self.turn_timeout {
            let alive = guard.watchdog_alive();
            let token = Arc::clone(&cancel);
            // Detached: the alive flag is its only tie to this turn. A turn that
            // finishes before the deadline drops the guard -> alive=false -> the
            // watchdog wakes, sees false, and does not fire. KNOWN RACE (follow-up
            // to #28): if the watchdog reads alive=true and then the turn ends and
            // a new turn begins before request() runs, the cancel lands on the new
            // turn. The window is a handful of instructions between the load and
            // request(), only reachable when timeout ~= the prior turn's runtime;
            // default turn_timeout=None spawns nothing, so production exposure is
            // near zero. A generation/turn-id guard closes it fully (deferred).
            // catch_unwind keeps this detached thread self-sufficient: request()
            // degrades on lock poison (see CancelToken::request), but any residual
            // panic is logged instead of killing the thread silently.
            thread::spawn(move || {
                thread::sleep(timeout);
                if alive.load(Ordering::SeqCst)
                    && catch_unwind(AssertUnwindSafe(|| token.request())).is_err()
                {
                    log::error!(
                        target: "toptopduck::session",
                        "turn watchdog panicked firing cancel; timeout path may be impaired"
                    );
                }
            });
        }

        // Collect each attempt's failure so exhaustion surfaces them all, not
        // just the last -- a SQL execution error (the actionable kind) would
        // otherwise be overwritten by a later transient Unavailable. Consecutive
        // identical failures dedupe so a persistently-bad SQL isn't repeated
        // across attempts.
        let mut failures: Vec<String> = Vec::new();
        for attempt in 0..=TURN_RETRY_BUDGET {
            // Cancel check at the loop top: a cancel that arrived before the
            // first attempt or during the prior attempt aborts immediately as
            // Cancelled (ADR-0021/0028 outcome D). No retry -- the user asked to
            // stop, and a timed-out SQL would re-hit the same wall.
            if cancel.is_requested() {
                return TurnOutcome::Cancelled;
            }
            // ADR-0059: signal the discrete "thinking" wait right before the
            // provider call. attempt is 0-based; surface it 1-based so the UI
            // reads "attempt N" naturally and a blind retry is honestly visible.
            // Fired AFTER the cancel pre-check so a pre-cancelled turn emits no
            // phase at all.
            on_phase(TurnPhase::Thinking {
                attempt: attempt + 1,
            });
            match self.provider.generate(request) {
                // Textual branch (ADR-0017/0018): a valid non-result turn -- no
                // retry, no result_N. The provider's text + assumption ride the
                // outcome verbatim. A cancel that arrived during the (possibly
                // slow) provider call wins over a textual reply: the user asked
                // to stop, so this is Cancelled, not a clarification.
                Ok(ProviderReply::Text {
                    kind,
                    body,
                    assumption,
                }) => {
                    if cancel.is_requested() {
                        return TurnOutcome::Cancelled;
                    }
                    return TurnOutcome::Textual {
                        text_kind: kind,
                        body,
                        assumption,
                    };
                }
                // SQL branch: execute + materialize. A schema/runtime failure
                // (bad reference, type error) consumes the budget and retries;
                // a resource-cap hit does NOT retry (the same SQL would hit the
                // same wall, ADR-0005/0028) and fails immediately. A cancel
                // during the query interrupts DuckDB; the resulting error is a
                // Cancelled turn, not a retryable failure. Success materializes
                // result_N.
                Ok(ProviderReply::Sql {
                    sql,
                    viz,
                    assumption,
                }) => {
                    // Re-check after the (possibly slow) provider call: if the
                    // provider blocked past a cancel/timeout, stop now without
                    // touching DuckDB.
                    if cancel.is_requested() {
                        return TurnOutcome::Cancelled;
                    }
                    // ADR-0059: signal the discrete "querying" wait right before
                    // SQL execution + materialization. Same 1-based attempt as
                    // the Thinking marker above. Only the SQL branch fires this
                    // -- a textual / failed / cancelled turn has no query wait.
                    on_phase(TurnPhase::Querying {
                        attempt: attempt + 1,
                    });
                    match self.materializer.try_materialize(
                        &sql,
                        &cancel,
                        result_name.clone(),
                        deps,
                    ) {
                        Ok(dataset) => {
                            return TurnOutcome::Materialized {
                                dataset: Box::new(dataset),
                                sql: Some(sql),
                                viz,
                                assumption,
                            };
                        }
                        Err(exec_err) => {
                            // A cancel during the query (engine interrupt or a
                            // mid-query flag) is Cancelled, not a retryable
                            // failure -- check the flag before routing on kind.
                            if cancel.is_requested() {
                                return TurnOutcome::Cancelled;
                            }
                            match exec_err.kind {
                                // Resource cap: abort now -- retrying cannot help.
                                ExecErrorKind::Resource => {
                                    return TurnOutcome::Failed(TurnFailure::Resource {
                                        detail: exec_err.detail,
                                    });
                                }
                                // Stale reference (issue #40, ADR-0013 invariant
                                // 2): refuse without retry -- the same SQL would
                                // reference the same stale result, so retrying
                                // only burns budget. Honest Failed turn carrying
                                // the dead reference name (exec_err.detail is the
                                // bare reference name; the "stale" wording lives
                                // in the frontend locale, interpolated from it).
                                ExecErrorKind::StaleReference => {
                                    return TurnOutcome::Failed(TurnFailure::StaleReference {
                                        reference_name: exec_err.detail,
                                    });
                                }
                                // Guard-checked above: try_materialize only emits
                                // Cancelled when is_requested() is true, which the
                                // pre-check already routed to TurnOutcome::Cancelled.
                                // The arm turns the invariant into a runtime contract
                                // -- a future second caller of try_materialize that
                                // forgets the pre-check fails loudly here instead of
                                // silently retrying a cancel.
                                ExecErrorKind::Cancelled => unreachable!(
                                    "Cancelled kind is guard-checked above; \
                                     try_materialize only emits it when is_requested() \
                                     is true"
                                ),
                                // Schema/runtime: feed the budget and retry.
                                // The raw engine detail rides the
                                // technical fold on budget exhaustion. It is
                                // engine-emitted verbatim and not guaranteed
                                // English; ADR-0029 audits it to carry no API
                                // key, so it stays out of the user-facing locale
                                // message.
                                _ => push_failure(&mut failures, exec_err.detail),
                            }
                        }
                    }
                }
                // NotWired is permanent (no provider configured) -- retrying
                // cannot help, so the turn fails immediately without consuming
                // the budget.
                Err(ProviderError::NotWired) => {
                    return TurnOutcome::Failed(TurnFailure::NotWired);
                }
                // InvalidConfig is permanent (issue #277): a non-http/https
                // base_url or another configuration fault. Retrying cannot help
                // -- the same config fails identically -- so the turn fails
                // immediately without consuming the budget, the same short-
                // circuit as NotWired. Unlike NotWired the detail rides the
                // fold so the policy reason (e.g. "scheme `file` is not
                // http/https") reaches the UI.
                Err(ProviderError::InvalidConfig(detail)) => {
                    return TurnOutcome::Failed(TurnFailure::InvalidConfig { detail });
                }
                // A contract violation / transient call failure -- consume the
                // budget and retry with the SAME request (blind retry). The real
                // client's error re-feed lands in #29; the scripted fake's queue
                // advances per call.
                Err(ProviderError::Unavailable(detail)) => {
                    push_failure(&mut failures, format!("provider call failed: {detail}"));
                }
            }
        }
        // Budget exhausted: surface the accumulated failures honestly as a typed
        // Execute failure. The "budget exhausted" framing is the locale message
        // (error.turn.execute); the aggregated per-attempt details ride the
        // technical fold. The kind distinguishes this from a permanent NotWired
        // failure (which never consumes the budget, ADR-0028) -- the frontend
        // renders each TurnFailure kind via its own locale message.
        let detail = if failures.is_empty() {
            "unknown error".to_string()
        } else {
            failures.join("; ")
        };
        TurnOutcome::Failed(TurnFailure::Execute { detail })
    }
}

/// Record one retry attempt's failure, deduping consecutive identical
/// failures: a persistent error isn't repeated across attempts, while
/// distinct failures (e.g. a SQL error then a transient Unavailable) are
/// all kept so budget exhaustion surfaces the full picture, not just the
/// last attempt.
fn push_failure(failures: &mut Vec<String>, detail: String) {
    match failures.last() {
        Some(last) if last == &detail => {} // consecutive duplicate -- skip
        _ => failures.push(detail),
    }
}

#[cfg(test)]
mod tests {
    //! TurnRunner routing branches (ADR-0053 / issue #65). Each test injects a
    //! precise `ExecErrorKind` (or provider error) via the fakes and asserts
    //! the outcome + the call count -- the assertion that distinguishes "no
    //! retry" (Resource / StaleReference / NotWired) from "budget exhausted"
    //! (Runtime / Unavailable). No DuckDB, no filesystem, no Session.

    use super::*;
    use crate::guardrail::{ExecError, ExecErrorKind};
    use crate::model::TextKind;
    use crate::provider::fake::FakeProvider;
    use crate::provider::{DatasetRef, ProviderReply, ProviderRequest};
    use crate::session::materializer::{FakeMaterializer, TurnDeps};
    use crate::workingset::WorkingSet;

    use duckdb::Connection;
    use std::collections::HashMap;
    use std::path::Path;

    /// A minimal request the fakes dispatch on (`question` only). The window
    /// payload is irrelevant to routing -- the provider keys on `question`,
    /// the materializer ignores the request entirely.
    fn request(question: &str) -> ProviderRequest {
        ProviderRequest {
            question: question.to_string(),
            history: Vec::new(),
            datasets: vec![DatasetRef {
                reference_name: "people".into(),
                sql_ref: r#""people".data"#.into(),
                columns: Vec::new(),
                row_count: 5,
                sample: None,
            }],
            active: Some("people".into()),
        }
    }

    fn reply_sql(sql: &str) -> ProviderReply {
        ProviderReply::Sql {
            sql: sql.to_string(),
            viz: None,
            assumption: None,
        }
    }

    /// A throwaway TurnDeps. The fakes never touch DuckDB / the working set /
    /// the temp dir, so the contents are inert -- the struct only needs to
    /// satisfy the `&mut TurnDeps` parameter so the live signature is tested,
    /// not a parallel test-only one. `sources` is passed in (not built inline)
    /// so the borrow outlives the returned struct.
    fn inert_deps<'a>(
        conn: &'a Connection,
        ws: &'a mut WorkingSet,
        sources: &'a HashMap<String, std::path::PathBuf>,
    ) -> TurnDeps<'a> {
        TurnDeps {
            conn,
            source_files: sources,
            working_set: ws,
            result_row_cap: 1_000,
            result_count_cap: 100,
            temp_path: Path::new("."),
        }
    }

    fn run_with(provider: FakeProvider, materializer: FakeMaterializer) -> (TurnOutcome, usize) {
        let calls = materializer.calls_handle();
        let mut runner = TurnRunner::new(
            Box::new(provider),
            Box::new(materializer),
            Arc::new(CancelToken::new()),
        );
        let conn = Connection::open_in_memory().expect("in-memory db");
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        // No-op phase callback: the routing tests do not assert on turn-progress
        // phases, so they ignore the channel (ADR-0059 -- a no-op keeps the
        // phase observer optional).
        let outcome = runner.run_with_phase(&request("q"), "result_1".into(), &mut deps, |_| {});
        (outcome, calls.load(Ordering::SeqCst))
    }

    #[test]
    fn resource_failure_is_not_retried() {
        // ADR-0005/0028: a resource cap (memory / row ceiling / blocked
        // filesystem function) aborts immediately -- the same SQL would hit the
        // same wall, so retrying only burns time. One materialize call, Failed
        // outcome carrying the resource prefix.
        let provider = FakeProvider::new().scripted("q", reply_sql("SELECT 1"));
        let materializer =
            FakeMaterializer::new(vec![Err(ExecError::new(ExecErrorKind::Resource, "cap"))]);
        let (outcome, calls) = run_with(provider, materializer);
        let detail = match outcome {
            TurnOutcome::Failed(TurnFailure::Resource { detail }) => detail,
            other => panic!("expected Resource Failed, got {other:?}"),
        };
        assert_eq!(detail, "cap");
        assert_eq!(calls, 1, "Resource must not retry");
    }

    #[test]
    fn stale_reference_failure_is_not_retried() {
        // ADR-0013 invariant 2 / issue #40: a SQL referencing a stale result_N
        // is refused without retry -- the same SQL references the same stale
        // result on a retry. One materialize call, Failed outcome carrying the
        // dead reference name (the "stale" wording lives in the frontend
        // locale, interpolated from the name -- issue #125).
        let provider = FakeProvider::new().scripted("q", reply_sql("SELECT * FROM result_1"));
        let materializer = FakeMaterializer::new(vec![Err(ExecError::new(
            ExecErrorKind::StaleReference,
            "result_1",
        ))]);
        let (outcome, calls) = run_with(provider, materializer);
        let reference_name = match outcome {
            TurnOutcome::Failed(TurnFailure::StaleReference { reference_name }) => reference_name,
            other => panic!("expected StaleReference Failed, got {other:?}"),
        };
        assert_eq!(reference_name, "result_1");
        assert_eq!(calls, 1, "StaleReference must not retry");
    }

    #[test]
    fn budget_exhaustion_aggregates_distinct_failures() {
        // ADR-0028: a retryable failure (Schema / Runtime) consumes the single
        // budget and retries. After TURN_RETRY_BUDGET+1 attempts the turn
        // fails honestly, and the reason aggregates EVERY distinct failure
        // (consecutive duplicates deduped), prefixed by "重试预算耗尽" so it
        // reads distinctly from a permanent NotWired failure.
        let provider = FakeProvider::new().scripted("q", reply_sql("SELECT bad"));
        // Three distinct Runtime details -> the loop sees one per attempt, none
        // deduped, all surfaced. The queue clamps to the last once exhausted.
        let materializer = FakeMaterializer::new(vec![
            Err(ExecError::new(ExecErrorKind::Runtime, "first")),
            Err(ExecError::new(ExecErrorKind::Runtime, "second")),
            Err(ExecError::new(ExecErrorKind::Runtime, "third")),
        ]);
        let (outcome, calls) = run_with(provider, materializer);
        let detail = match outcome {
            TurnOutcome::Failed(TurnFailure::Execute { detail }) => detail,
            other => panic!("expected Execute Failed, got {other:?}"),
        };
        assert!(detail.contains("first"), "got {detail:?}");
        assert!(detail.contains("second"), "got {detail:?}");
        assert!(detail.contains("third"), "got {detail:?}");
        assert_eq!(
            calls,
            (TURN_RETRY_BUDGET as usize) + 1,
            "budget exhaustion must exhaust every attempt"
        );
    }

    #[test]
    fn budget_exhaustion_dedupes_consecutive_identical_failures() {
        // A persistent bad SQL (same detail every attempt) surfaces ONCE in the
        // exhausted reason -- push_failure dedupes consecutive duplicates so a
        // runaway retry doesn't repeat the same line.
        let provider = FakeProvider::new().scripted("q", reply_sql("SELECT bad"));
        let materializer =
            FakeMaterializer::new(vec![Err(ExecError::new(ExecErrorKind::Runtime, "same"))]);
        let (outcome, calls) = run_with(provider, materializer);
        let detail = match outcome {
            TurnOutcome::Failed(TurnFailure::Execute { detail }) => detail,
            other => panic!("expected Execute Failed, got {other:?}"),
        };
        // Exactly one occurrence of the detail (no "same; same; same").
        assert_eq!(
            detail.matches("same").count(),
            1,
            "consecutive duplicates must dedupe: {detail:?}"
        );
        assert_eq!(calls, (TURN_RETRY_BUDGET as usize) + 1);
    }

    #[test]
    fn cancel_wins_over_a_textual_reply() {
        // ADR-0021/0028 outcome D: a cancel arriving during a (slow) provider
        // call wins over a valid textual reply -- the user asked to stop, so
        // this is Cancelled, not a clarification. The blocking fake polls the
        // token and only returns once cancel is requested; the orchestrator's
        // post-call flag check then routes Cancelled.
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .with_cancel(cancel.clone())
            .scripted_blocking(
                "q",
                ProviderReply::Text {
                    kind: TextKind::Clarify,
                    body: "哪个维度？".into(),
                    assumption: None,
                },
            );
        let materializer = FakeMaterializer::new(vec![]); // never reached
        let calls = materializer.calls_handle();
        let mut runner =
            TurnRunner::new(Box::new(provider), Box::new(materializer), cancel.clone());
        let cancel_for_thread = cancel.clone();
        thread::spawn(move || {
            // Wait until run() has called begin_turn (in_flight=true) before
            // firing: begin_turn unconditionally clears `requested`
            // (cancel.rs), so a request landing before it -- easy on a CI
            // runner where the main thread reaches begin_turn slower than the
            // old 20ms sleep -- is silently dropped and the blocking poll
            // loop in generate() hangs forever. Polling in_flight gates us to
            // "after begin_turn"; the short extra sleep lets generate() enter
            // its blocking loop before we fire.
            while !cancel_for_thread.is_in_flight() {
                thread::sleep(Duration::from_millis(1));
            }
            thread::sleep(Duration::from_millis(5));
            cancel_for_thread.request();
        });
        let conn = Connection::open_in_memory().expect("in-memory db");
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);
        let outcome = runner.run_with_phase(&request("q"), "result_1".into(), &mut deps, |_| {});
        assert!(matches!(outcome, TurnOutcome::Cancelled), "got {outcome:?}");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "textual must not materialize"
        );
    }

    #[test]
    fn not_wired_does_not_consume_the_budget() {
        // ADR-0028/0044: NotWired (no key / refused auth / no provider) is
        // permanent -- it fails immediately on the first attempt, without
        // retrying and without consuming the budget. Even a later scripted Ok
        // is never reached, and the materializer is never called.
        let provider = FakeProvider::new().scripted_seq(
            "q",
            vec![
                Err(ProviderError::NotWired),
                Ok(reply_sql("SELECT 1")), // would succeed -- never reached
            ],
        );
        let materializer = FakeMaterializer::new(vec![Ok(fake_descriptor("result_1"))]);
        let (outcome, calls) = run_with(provider, materializer);
        match outcome {
            TurnOutcome::Failed(TurnFailure::NotWired) => {}
            other => panic!("expected NotWired Failed, got {other:?}"),
        }
        assert_eq!(calls, 0, "NotWired must not reach the materializer");
    }

    #[test]
    fn invalid_config_does_not_retry_and_surfaces_detail() {
        // AC #277: a permanent configuration fault (e.g. a bad base_url scheme)
        // is NOT retried -- generate is called exactly once (the retry budget is
        // not consumed), and the policy detail rides the failure so it reaches
        // the UI fold. A later scripted Ok is never reached, and the materializer
        // is never called. Distinct from Unavailable (which retries and would
        // burn three calls on an identical config) and from NotWired (which
        // drops the detail). The captured-requests handle (one entry per
        // generate call) pins the no-retry contract independently of the
        // outcome variant.
        let detail = "scheme `file` is not http/https";
        let provider = FakeProvider::new().scripted_seq(
            "q",
            vec![
                Err(ProviderError::InvalidConfig(detail.to_string())),
                Ok(reply_sql("SELECT 1")), // would succeed -- never reached
            ],
        );
        let captured = provider.captured();
        let materializer = FakeMaterializer::new(vec![Ok(fake_descriptor("result_1"))]);
        let (outcome, calls) = run_with(provider, materializer);
        let surfaced = match outcome {
            TurnOutcome::Failed(TurnFailure::InvalidConfig { detail }) => detail,
            other => panic!("expected InvalidConfig Failed, got {other:?}"),
        };
        assert_eq!(
            captured.lock().expect("captured requests unpoisoned").len(),
            1,
            "InvalidConfig must not be retried -- generate called exactly once"
        );
        assert_eq!(calls, 0, "InvalidConfig must not reach the materializer");
        assert!(
            surfaced.contains("http/https"),
            "policy detail surfaces to the UI fold: {surfaced}"
        );
    }

    /// Build a minimal active descriptor for the success-path fake queue.
    /// Shape is inert -- the routing tests that reach `Ok` only assert the
    /// outcome variant, never the descriptor contents (those are the
    /// materialize implementation's concern, covered by query_blackbox).
    fn fake_descriptor(reference_name: &str) -> crate::model::DatasetDescriptor {
        use crate::model::{DatasetPrivacy, RectifyProvenance};
        crate::model::DatasetDescriptor {
            reference_name: reference_name.into(),
            display_name: reference_name.into(),
            source_path: String::new(),
            columns: Vec::new(),
            row_count: 0,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        }
    }

    /// ADR-0059 (issue #76): the phase callback fires at each wait boundary
    /// with a 1-based attempt that rises across blind retries. A transient
    /// materialize failure (Runtime) consumes the budget and retries the SAME
    /// request, so the phases read Thinking{1}→Querying{1}→Thinking{2}→...,
    /// letting the UI honestly surface "attempt N" on a retry. The final attempt
    /// (budget = 2 -> 3 attempts total) succeeds, so the last Querying is the
    /// one that materializes.
    #[test]
    fn run_with_phase_emits_rising_attempts_across_retries() {
        let provider = FakeProvider::new().scripted("q", reply_sql("SELECT 1"));
        // Two transient Runtime failures then success: attempts 1 and 2 fail
        // (both still emit Thinking + Querying before failing), attempt 3
        // succeeds.
        let materializer = FakeMaterializer::new(vec![
            Err(ExecError::new(ExecErrorKind::Runtime, "boom-1")),
            Err(ExecError::new(ExecErrorKind::Runtime, "boom-2")),
            Ok(fake_descriptor("result_1")),
        ]);
        let calls = materializer.calls_handle();
        let mut runner = TurnRunner::new(
            Box::new(provider),
            Box::new(materializer),
            Arc::new(CancelToken::new()),
        );
        let conn = Connection::open_in_memory().expect("in-memory db");
        let mut ws = WorkingSet::default();
        let sources = HashMap::new();
        let mut deps = inert_deps(&conn, &mut ws, &sources);

        let mut phases: Vec<TurnPhase> = Vec::new();
        let outcome = runner.run_with_phase(&request("q"), "result_1".into(), &mut deps, |p| {
            phases.push(p)
        });
        assert!(
            matches!(outcome, TurnOutcome::Materialized { .. }),
            "got {outcome:?}"
        );
        assert_eq!(
            phases,
            vec![
                TurnPhase::Thinking { attempt: 1 },
                TurnPhase::Querying { attempt: 1 },
                TurnPhase::Thinking { attempt: 2 },
                TurnPhase::Querying { attempt: 2 },
                TurnPhase::Thinking { attempt: 3 },
                TurnPhase::Querying { attempt: 3 },
            ],
            "each attempt emits Thinking then Querying with a rising 1-based number"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3, "three attempts ran");
    }
}
