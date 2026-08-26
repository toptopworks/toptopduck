//! Scripted provider stand-in (ADR-0007): maps a question verbatim to preset
//! replies, so the turn orchestrator is testable offline, deterministically,
//! with no network and no real LLM. This is the v1 shared test base -- every
//! later query-loop slice tests against a scripted fake rather than the real
//! client.
//!
//! Slice #23 extends the fake from "one stable reply per question" to a
//! per-question queue of canned results: the first call returns the front of
//! the queue, and once only one remains it sticks (returned on every later
//! call). A single scripted reply is therefore stable (the #22 behavior),
//! while a sequence models a multi-step trajectory -- on the tool-calling
//! path (ADR-0077/0081): "explore, then materialize, then answer" (or a
//! failing call clamped until the step cap).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::cancel::CancelToken;

use super::tool_calling::{ThinkingBlock, ToolTurnOutcome, ToolTurnReply, ToolTurnRequest};
use super::{Provider, ProviderError, ProviderReply, ProviderRequest};

/// One question's scripted results, drawn in order then clamped to the last.
/// Generic over the reply type so the single-shot path (`ProviderReply`) and
/// the tool-calling path (`ToolTurnReply`) share one queue shape + draw logic.
struct Script<T> {
    /// Canned results, returned front-first; the last sticks once reached.
    results: Vec<Result<T, ProviderError>>,
    /// How many times this script has been drawn. Interior mutability is
    /// required (the trait takes `&self`); `AtomicUsize` (not `Cell`) so the
    /// fake stays `Sync` (the `Provider` trait's bound, issue #669: the
    /// turn's runner hands the provider across the loop's thread scope).
    calls: std::sync::atomic::AtomicUsize,
}

impl<T: Clone> Script<T> {
    /// Draw the next canned result front-first, clamping to the last once
    /// reached: the first call returns `results[0]`, and once only one remains
    /// it sticks (returned on every later call). A single scripted result is
    /// therefore stable, while a sequence models "explore, then materialize,
    /// then answer" (tool-calling, ADR-0081) or "fail N times then recover"
    /// (legacy single-shot) -- the trajectories the agent loop tests need to
    /// exercise offline. An empty queue yields `NotWired` so a misconfigured
    /// script never invents a reply.
    fn draw(&self) -> Result<T, ProviderError> {
        let calls = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        // Clamp to the last canned result: a single scripted reply is stable
        // (always index 0), and a sequence advances one step per call until it
        // settles on the final result.
        let idx = calls.min(self.results.len().saturating_sub(1));
        self.results
            .get(idx)
            .cloned()
            .unwrap_or(Err(ProviderError::NotWired))
    }
}

/// A provider that returns preset replies keyed by the exact question text.
/// An unscripted question yields NotWired -- the fake never invents SQL,
/// preserving "the orchestrator only ever runs provider-supplied SQL" for every
/// test (no hidden default that could mask a wiring bug).
pub struct FakeProvider {
    scripts: HashMap<String, Script<ProviderReply>>,
    /// Every request handed to `generate`, newest last (one entry per call, so
    /// a retried turn appends repeats of the same request). Shared by `Arc` so
    /// a test can inspect what the window assembler produced after driving the
    /// session -- the fake is consumed into the session, but the capture handle
    /// stays in the test's hand.
    captured: Arc<Mutex<Vec<ProviderRequest>>>,
    /// Optional cancel token: when set, a question in [`Self::blocking`] simulates
    /// a long-running query by polling this token in a tight sleep loop and only
    /// returning once cancel is requested (issue #28). The orchestrator then
    /// sees the flag and lands the turn as Cancelled. `None` for fakes that do
    /// not simulate latency (the #22-#27 behavior -- instant replies).
    cancel: Option<Arc<CancelToken>>,
    /// Questions whose `generate` call blocks until the cancel token is
    /// requested. Models a long, user-cancellable query for the cancel/timeout
    /// black-box tests (ADR-0021). Empty by default.
    blocking: HashSet<String>,
    /// Tool-calling scripts keyed by the asking question (the LAST user
    /// message of the windowed request -- see [`asking_question`]). The agent
    /// loop (#295) drives `generate_tool_turn` once per round-trip; an
    /// unscripted question yields `NotWired`, mirroring the single-shot
    /// path's "never invent a reply" contract.
    tool_scripts: HashMap<String, Script<ToolTurnOutcome>>,
    /// Every `ToolTurnRequest` handed to `generate_tool_turn`, newest last (one
    /// entry per round-trip). Shared by `Arc` so an agent-loop unit test can
    /// assert the assembled conversation (messages + tools + system) after
    /// driving the loop -- the fake is consumed into the loop, but the capture
    /// handle stays in the test's hand.
    tool_captured: Arc<Mutex<Vec<ToolTurnRequest>>>,
}

impl Default for FakeProvider {
    /// An empty script map -- every question is refused. Tests build it up with
    /// FakeProvider::scripted / scripted_seq.
    fn default() -> Self {
        Self {
            scripts: HashMap::new(),
            captured: Arc::new(Mutex::new(Vec::new())),
            cancel: None,
            blocking: HashSet::new(),
            tool_scripts: HashMap::new(),
            tool_captured: Arc::new(Mutex::new(Vec::new())),
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
        insert_script(&mut self.scripts, question, results);
        self
    }

    /// Share the session's cancel token so a blocking question can poll it
    /// (issue #28). The token the Session holds is the same one the test (or the
    /// cancel command) fires -- wiring the fake to it is what lets a black-box
    /// test drive cancel/timeout without a real long DuckDB query. Builder-style.
    pub fn with_cancel(mut self, cancel: Arc<CancelToken>) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// Register a stable reply for a question AND mark it blocking: `generate`
    /// polls the cancel token (sleep loop) and only returns once cancel is
    /// requested, simulating a long-running query (ADR-0021). Requires
    /// [`Self::with_cancel`] -- without a token the block is a defensive no-op
    /// (the reply returns immediately) so a misconfigured test never hangs. The
    /// reply ultimately returned is discarded by the orchestrator when it sees
    /// the cancel flag -> the turn lands as Cancelled, so the exact reply
    /// matters only in that it must be a valid `ProviderReply`.
    pub fn scripted_blocking(self, question: &str, reply: ProviderReply) -> Self {
        self.mark_blocking(question).scripted(question, reply)
    }

    /// A shared handle to every `ToolTurnRequest` this fake has been handed,
    /// newest last (one entry per `generate_tool_turn` call). The agent-loop
    /// unit tests clone the `Arc` before passing the fake into the loop, drive
    /// it, then inspect the assembled conversation (system / messages / tools).
    pub fn captured_tool_turns(&self) -> Arc<Mutex<Vec<ToolTurnRequest>>> {
        Arc::clone(&self.tool_captured)
    }

    /// Register one stable tool-turn reply for a question -- returned on every
    /// `generate_tool_turn` call. The common case: a question maps to one
    /// deterministic terminal-text outcome (a clarify / refuse with no tools).
    /// Builder-style so a test reads top-to-bottom.
    pub fn scripted_tool_turn(self, question: &str, reply: ToolTurnReply) -> Self {
        self.scripted_tool_turn_seq(question, vec![Ok(reply)])
    }

    /// Register a queue of canned thinking-carrying tool-turn outcomes for a
    /// question (issue #614): each entry pairs the round's reasoning blocks
    /// with its reply, drawn front-first on successive calls exactly like
    /// [`Self::scripted_tool_turn_seq`]. The plain builders wrap replies with
    /// empty thinking, so every existing script reads as a thinking-disabled
    /// turn.
    pub fn scripted_thinking_tool_turn_seq(
        mut self,
        question: &str,
        rounds: Vec<Result<(Vec<ThinkingBlock>, ToolTurnReply), ProviderError>>,
    ) -> Self {
        let outcomes = rounds
            .into_iter()
            .map(|round| round.map(|(thinking, reply)| ToolTurnOutcome { thinking, reply }))
            .collect();
        insert_script(&mut self.tool_scripts, question, outcomes);
        self
    }

    /// Register a queue of canned tool-turn replies for a question -- returned
    /// front-first on successive `generate_tool_turn` calls, clamping to the
    /// last once reached. Models a multi-step agent trajectory: `[ToolCalls
    /// (explore), ToolCalls(materialize), Text("done")]` is "explore, then
    /// promote, then answer". An `Err` entry surfaces a provider-level fault
    /// (`NotWired` permanent / `Unavailable` transient) for the termination
    /// tests. Builder-style.
    pub fn scripted_tool_turn_seq(
        mut self,
        question: &str,
        replies: Vec<Result<ToolTurnReply, ProviderError>>,
    ) -> Self {
        // Wrapping here (not at the draw site) keeps every reply-only script
        // a thinking-disabled turn by construction.
        let outcomes = replies
            .into_iter()
            .map(|r| r.map(ToolTurnOutcome::from))
            .collect();
        insert_script(&mut self.tool_scripts, question, outcomes);
        self
    }

    /// Register a stable tool-turn reply for a question AND mark it blocking:
    /// `generate_tool_turn` polls the cancel token (sleep loop) and only
    /// returns once cancel is requested, simulating a long round-trip
    /// (ADR-0021). The agent-loop cancel/timeout tests drive this so a cancel
    /// or the wall-clock watchdog lands the turn as Cancelled without a real
    /// slow provider. Requires [`Self::with_cancel`] -- without a token the
    /// block is a defensive no-op (the reply returns immediately).
    pub fn scripted_tool_turn_blocking(self, question: &str, reply: ToolTurnReply) -> Self {
        self.mark_blocking(question)
            .scripted_tool_turn(question, reply)
    }

    /// Mark `question` blocking: a subsequent `generate` / `generate_tool_turn`
    /// for it polls the cancel token instead of returning immediately
    /// (ADR-0021). Shared spine of the single-shot and tool-calling blocking
    /// builders; [`block_if_requested`] does the actual poll.
    fn mark_blocking(mut self, question: &str) -> Self {
        self.blocking.insert(question.to_string());
        self
    }

    /// If `question` is registered blocking, poll the cancel token in a tight
    /// sleep loop and only return once cancel is requested (ADR-0021). Models a
    /// long-running call so the orchestrator/loop sees the cancel flag and lands
    /// the turn as Cancelled. Defensive no-op without a token (a misconfigured
    /// test never hangs). Shared by `generate` and `generate_tool_turn`.
    fn block_if_requested(&self, question: &str) {
        if self.blocking.contains(question) {
            if let Some(cancel) = &self.cancel {
                while !cancel.is_requested() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }
}

/// Insert a canned-result queue for `question` into `map` -- the shared spine
/// of the single-shot and tool-calling builders. Front-first draw with
/// last-stick clamping lives in [`Script::draw`]; the builders differ only in
/// which map they populate (and the reply type), so the
/// `Script { results, calls: 0 }` construction has one source here. An empty
/// queue yields `NotWired` on draw (a misconfigured script never invents a
/// reply).
fn insert_script<T>(
    map: &mut HashMap<String, Script<T>>,
    question: &str,
    results: Vec<Result<T, ProviderError>>,
) {
    map.insert(
        question.to_string(),
        Script {
            results,
            calls: std::sync::atomic::AtomicUsize::new(0),
        },
    );
}

/// Extract the asking question from a tool-turn request: the content of the
/// LAST [`ToolTurnMessage::User`] in `messages`. The windowed request carries
/// the conversation history first (prior turns' user/assistant pairs,
/// ADR-0023), then the asking question as the final user turn; within the
/// loop, later round-trips only append Assistant + ToolResult turns, so the
/// last user message stays the asking question across every round-trip of the
/// turn -- the stable script key. Returns an empty string when no user turn
/// is present -- a malformed request that yields `NotWired` (the unscripted
/// fallback).
fn asking_question(request: &ToolTurnRequest) -> String {
    // The LAST user message: the window closes with the asking question, so
    // last-wins keys the script on the current question across every
    // round-trip of the turn. The upstream's own injected User turns (the
    // loop-detection nudge, the stop marker) never reach this shape -- the
    // yoagent bridge (session::yoagent::live) drops them, keeping the bridged
    // request's conversation identical to what the self-written loop fed this
    // fake pre-swap (ADR-0107, issue #669).
    request
        .messages
        .iter()
        .rev()
        .find_map(|m| match m {
            super::tool_calling::ToolTurnMessage::User { content } => Some(content.clone()),
            _ => None,
        })
        .unwrap_or_default()
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
        // A blocking question simulates a long query (ADR-0021); the orchestrator
        // checks the cancel flag after this call returns and lands the turn as
        // Cancelled, so the reply we hand back is discarded.
        self.block_if_requested(request.question.as_str());
        self.scripts
            .get(request.question.as_str())
            .ok_or(ProviderError::NotWired)?
            .draw()
    }

    fn generate_tool_turn(
        &self,
        request: &ToolTurnRequest,
    ) -> Result<ToolTurnOutcome, ProviderError> {
        // Record the assembled tool-turn payload before dispatching, mirroring
        // `generate`'s capture so an agent-loop unit test can assert what the
        // loop assembled (system / messages / tools). Poison tolerance matches
        // `generate`.
        if let Ok(mut buf) = self.tool_captured.lock() {
            buf.push(request.clone());
        }
        // A blocking question simulates a long round-trip (ADR-0021); the loop
        // sees the cancel flag and lands the turn as Cancelled.
        let question = asking_question(request);
        self.block_if_requested(question.as_str());
        self.tool_scripts
            .get(question.as_str())
            .ok_or(ProviderError::NotWired)?
            .draw()
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

    // --- native tool-calling (#291, exercised by the agent loop #295) --------
    use super::super::tool_calling::{ToolDefinition, ToolTurnMessage, ToolTurnRequest, ToolUse};
    use serde_json::json;

    /// A minimal tool-turn request whose first user message keys the script.
    fn tool_request(question: &str) -> ToolTurnRequest {
        ToolTurnRequest {
            system: "sys".into(),
            messages: vec![ToolTurnMessage::user(question)],
            tools: vec![ToolDefinition {
                name: "explore".into(),
                description: "d".into(),
                input_schema: json!({"type": "object"}),
            }],
            max_tokens: 1024,
            thought_level: None,
        }
    }

    #[test]
    fn scripted_tool_turn_returns_its_reply() {
        let provider = FakeProvider::new()
            .scripted_tool_turn("count rows", ToolTurnReply::Text("done".into()));
        let got = provider
            .generate_tool_turn(&tool_request("count rows"))
            .expect("scripted");
        assert_eq!(got.reply, ToolTurnReply::Text("done".into()));
        assert_eq!(got.thinking, Vec::new());
    }

    #[test]
    fn tool_turn_sequence_advances_then_clamps() {
        // [ToolCalls, Text] yields the tool batch first, then the terminal text,
        // then clamps to the text on every later call.
        let provider = FakeProvider::new().scripted_tool_turn_seq(
            "two-step",
            vec![
                Ok(ToolTurnReply::tool_calls(vec![ToolUse {
                    id: "tu_1".into(),
                    name: "explore".into(),
                    input: json!({"sql": "SELECT 1"}),
                }])),
                Ok(ToolTurnReply::Text("done".into())),
            ],
        );
        let first = provider
            .generate_tool_turn(&tool_request("two-step"))
            .expect("first");
        assert!(matches!(first.reply, ToolTurnReply::ToolCalls { .. }));
        let second = provider
            .generate_tool_turn(&tool_request("two-step"))
            .expect("second");
        assert_eq!(second.reply, ToolTurnReply::Text("done".into()));
        // Clamps to the last entry on every later call.
        let third = provider
            .generate_tool_turn(&tool_request("two-step"))
            .expect("third");
        assert_eq!(third.reply, ToolTurnReply::Text("done".into()));
    }

    #[test]
    fn unscripted_tool_turn_is_refused() {
        // Mirrors `generate`: the fake never invents a tool reply, so an
        // unscripted question yields NotWired -- a test cannot accidentally
        // pass against a hidden default.
        let provider = FakeProvider::new().scripted_tool_turn("a", ToolTurnReply::Text("a".into()));
        assert_eq!(
            provider.generate_tool_turn(&tool_request("b")).unwrap_err(),
            ProviderError::NotWired
        );
    }

    #[test]
    fn tool_turn_captures_each_request() {
        // The capture handle records one entry per round-trip so an agent-loop
        // test can assert the assembled conversation after driving the loop.
        let provider =
            FakeProvider::new().scripted_tool_turn("q", ToolTurnReply::Text("done".into()));
        let handle = provider.captured_tool_turns();
        let p2 = provider; // rename for clarity after taking the handle
        p2.generate_tool_turn(&tool_request("q")).unwrap();
        p2.generate_tool_turn(&tool_request("q")).unwrap();
        assert_eq!(
            handle.lock().unwrap().len(),
            2,
            "one capture per generate_tool_turn call"
        );
    }
}
