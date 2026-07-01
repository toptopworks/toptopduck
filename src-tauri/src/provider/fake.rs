//! Scripted provider stand-in (ADR-0007): maps a question verbatim to preset
//! replies, so the turn orchestrator is testable offline, deterministically,
//! with no network and no real LLM. This is the v1 shared test base -- every
//! later query-loop slice tests against a scripted fake rather than the real
//! client.
//!
//! Slice #23 extends the fake from "one stable reply per question" to a
//! per-question queue of canned results: the first call returns the front of
//! the queue, and once only one remains it sticks (returned on every later
//! call). A single scripted reply is therefore stable (the #22 behavior), while
//! a sequence models "fail N times then recover" -- exactly what the single
//! retry budget (ADR-0028) needs to exercise offline.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::{Provider, ProviderError, ProviderReply, ProviderRequest};

/// One question's scripted results, drawn in order then clamped to the last.
struct Script {
    /// Canned results, returned front-first; the last sticks once reached.
    results: Vec<Result<ProviderReply, ProviderError>>,
    /// How many times `generate` has been called for this question. `Cell` (not
    /// `RefCell`) because the counter is a single Copy value -- the trait takes
    /// `&self`, so interior mutability is required, and a Cell suffices.
    calls: Cell<usize>,
}

/// A provider that returns preset replies keyed by the exact question text.
/// An unscripted question yields NotWired -- the fake never invents SQL,
/// preserving "the orchestrator only ever runs provider-supplied SQL" for every
/// test (no hidden default that could mask a wiring bug).
pub struct FakeProvider {
    scripts: HashMap<String, Script>,
    /// Every request handed to `generate`, newest last (one entry per call, so
    /// a retried turn appends repeats of the same request). Shared by `Arc` so
    /// a test can inspect what the window assembler produced after driving the
    /// session -- the fake is consumed into the session, but the capture handle
    /// stays in the test's hand.
    captured: Arc<Mutex<Vec<ProviderRequest>>>,
}

impl Default for FakeProvider {
    /// An empty script map -- every question is refused. Tests build it up with
    /// FakeProvider::scripted / scripted_seq.
    fn default() -> Self {
        Self {
            scripts: HashMap::new(),
            captured: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl FakeProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// A shared handle to every request this fake has been handed, newest last.
    /// Clone the `Arc` before passing the fake into a session, drive turns, then
    /// read the last entry to assert the assembled payload (issue #24 window +
    /// privacy tests).
    pub fn captured(&self) -> Arc<Mutex<Vec<ProviderRequest>>> {
        Arc::clone(&self.captured)
    }

    /// Register one stable reply for a question -- returned on every call. The
    /// common case (a question maps to one deterministic outcome). Builder-style
    /// so a test reads top-to-bottom:
    /// `FakeProvider::new().scripted("count rows", reply_sql("SELECT ..."))`.
    pub fn scripted(self, question: &str, reply: ProviderReply) -> Self {
        self.scripted_seq(question, vec![Ok(reply)])
    }

    /// Register a queue of canned results for a question -- returned front-first
    /// on successive calls, clamping to the last once reached. Models a retry
    /// sequence: `[Err(..), Err(..), Ok(..)]` is "fail twice then recover",
    /// `[Err(..)]` is "always fail" (the single entry sticks). Builder-style.
    pub fn scripted_seq(
        mut self,
        question: &str,
        results: Vec<Result<ProviderReply, ProviderError>>,
    ) -> Self {
        self.scripts.insert(
            question.to_string(),
            Script {
                results,
                calls: Cell::new(0),
            },
        );
        self
    }
}

impl Provider for FakeProvider {
    fn generate(&self, request: &ProviderRequest) -> Result<ProviderReply, ProviderError> {
        // Record the assembled payload before dispatching -- the capture is what
        // lets a black-box test assert the window assembler's output (issue #24).
        // A poisoned lock means a panic left it half-updated; drop the capture
        // silently rather than propagating the poison, so a flaky peer test does
        // not block this one.
        if let Ok(mut buf) = self.captured.lock() {
            buf.push(request.clone());
        }
        let script = self
            .scripts
            .get(request.question.as_str())
            .ok_or(ProviderError::NotWired)?;
        let calls = script.calls.get();
        script.calls.set(calls + 1);
        // Clamp to the last canned result: a single scripted reply is stable
        // (always index 0), and a sequence advances one step per call until it
        // settles on the final result. An empty queue is treated as NotWired so
        // a misconfigured script never invents a reply.
        let idx = calls.min(script.results.len().saturating_sub(1));
        script
            .results
            .get(idx)
            .cloned()
            .unwrap_or(Err(ProviderError::NotWired))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ChartKind, TextKind, VizSpec};
    use crate::provider::{ColumnRef, DatasetRef};

    fn request(question: &str) -> ProviderRequest {
        ProviderRequest {
            question: question.to_string(),
            history: Vec::new(),
            datasets: vec![DatasetRef {
                reference_name: "people".into(),
                sql_ref: r#""people".data"#.into(),
                columns: vec![ColumnRef {
                    name: Some("id".into()),
                    canonical_type: "BIGINT".into(),
                }],
                row_count: 5,
                sample: Some(vec![vec![Some("1".into())]]),
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

    #[test]
    fn scripted_question_returns_its_reply() {
        let provider =
            FakeProvider::new().scripted("how many rows", reply_sql("SELECT COUNT(*) AS n"));
        let got = provider
            .generate(&request("how many rows"))
            .expect("scripted");
        assert_eq!(got, reply_sql("SELECT COUNT(*) AS n"));
    }

    #[test]
    fn carries_viz_and_assumption_through_verbatim() {
        // The full ADR-0009 contract shape round-trips through the fake, so a
        // later slice test can script a viz/assumption without changing types.
        let provider = FakeProvider::new().scripted(
            "plot it",
            ProviderReply::Sql {
                sql: "SELECT 1".into(),
                viz: Some(VizSpec {
                    kind: ChartKind::Bar,
                    spec: "{\"mark\":\"bar\"}".into(),
                }),
                assumption: Some("treated id as a key".into()),
            },
        );
        match provider.generate(&request("plot it")).expect("scripted") {
            ProviderReply::Sql {
                sql,
                viz,
                assumption,
            } => {
                assert_eq!(sql, "SELECT 1");
                let v = viz.expect("viz present");
                assert_eq!(v.kind, ChartKind::Bar);
                assert_eq!(v.spec, "{\"mark\":\"bar\"}");
                assert_eq!(assumption.as_deref(), Some("treated id as a key"));
            }
            ProviderReply::Text { .. } => panic!("expected Sql reply"),
        }
    }

    #[test]
    fn scripted_textual_reply_round_trips() {
        // The textual branch (ADR-0017/0018) round-trips verbatim, so a test can
        // script a clarify/refuse without the orchestrator touching its text.
        let provider = FakeProvider::new().scripted(
            "which name",
            ProviderReply::Text {
                kind: TextKind::Clarify,
                body: "按产品名还是客户名汇总？".into(),
                assumption: Some("当前表有多个 name 列".into()),
            },
        );
        match provider.generate(&request("which name")).expect("scripted") {
            ProviderReply::Text {
                kind,
                body,
                assumption,
            } => {
                assert_eq!(kind, TextKind::Clarify);
                assert_eq!(body, "按产品名还是客户名汇总？");
                assert_eq!(assumption.as_deref(), Some("当前表有多个 name 列"));
            }
            ProviderReply::Sql { .. } => panic!("expected Text reply"),
        }
    }

    #[test]
    fn unscripted_question_is_refused_not_invented() {
        // The fake never invents SQL: a question without a script is refused,
        // so a test cannot accidentally pass against a hidden default.
        let provider = FakeProvider::new().scripted("a", reply_sql("SELECT 1"));
        assert_eq!(
            provider.generate(&request("b")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn a_single_scripted_reply_is_stable_across_calls() {
        // One scripted reply sticks: every call returns it (the #22 behavior),
        // so a stable single-shot test is unaffected by the queue machinery.
        let provider = FakeProvider::new().scripted("q", reply_sql("SELECT 1"));
        for _ in 0..5 {
            assert_eq!(
                provider.generate(&request("q")).unwrap(),
                reply_sql("SELECT 1")
            );
        }
    }

    #[test]
    fn a_sequence_advances_then_clamps_to_last() {
        // A queue models a retry sequence: [Err, Ok, Ok] yields Err first, then
        // Ok, then clamps to Ok on every later call.
        let provider = FakeProvider::new().scripted_seq(
            "flaky",
            vec![
                Err(ProviderError::Unavailable("malformed".into())),
                Ok(reply_sql("SELECT 1")),
                Ok(reply_sql("SELECT 2")),
            ],
        );
        assert_eq!(
            provider.generate(&request("flaky")).unwrap_err(),
            ProviderError::Unavailable("malformed".into())
        );
        assert_eq!(
            provider.generate(&request("flaky")).unwrap(),
            reply_sql("SELECT 1")
        );
        // Subsequent calls clamp to the last entry (SELECT 2), never repeating
        // the earlier ones or running off the end.
        assert_eq!(
            provider.generate(&request("flaky")).unwrap(),
            reply_sql("SELECT 2")
        );
        assert_eq!(
            provider.generate(&request("flaky")).unwrap(),
            reply_sql("SELECT 2")
        );
    }

    #[test]
    fn a_single_error_script_always_fails() {
        // [Err] sticks: always fails -- the shape a budget-exhaustion test
        // scripts (a question whose provider never recovers).
        let provider = FakeProvider::new()
            .scripted_seq("broken", vec![Err(ProviderError::Unavailable("no".into()))]);
        for _ in 0..3 {
            assert_eq!(
                provider.generate(&request("broken")).unwrap_err(),
                ProviderError::Unavailable("no".into())
            );
        }
    }
}
