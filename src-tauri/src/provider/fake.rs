//! The offline scripted provider (ADR-0007): maps the asking question verbatim
//! to preset tool-turn outcomes, so the session pipeline is testable offline,
//! deterministically, with no network and no real LLM. The shared test base of
//! the black-box suites -- it implements `Provider::generate_tool_turn`, and
//! the wiring seam bridges it onto the loop runtime as-is (its
//! `turn_model_facts` stays `None`, the bridge's signal).
//!
//! A question maps to a queue of canned outcomes: the first round-trip returns
//! the front of the queue, and once only one remains it sticks (returned on
//! every later round-trip). A single scripted outcome is therefore stable,
//! while a sequence models a multi-step trajectory (ADR-0077/0081): "explore,
//! then materialize, then answer" (or a failing call clamped until the step
//! cap). The single-shot reply face retired with the self-written adapters
//! (ADR-0107 Decision 1, issue #670); this is the tool-calling face only.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::cancel::CancelToken;

use super::tool_calling::{ThinkingBlock, ToolTurnOutcome, ToolTurnReply, ToolTurnRequest};
use super::{Provider, ProviderError};

/// One question's scripted outcomes, drawn in order then clamped to the last.
/// Non-generic: the single-shot reply face retired with the self-written
/// adapters (issue #670), so `ToolTurnOutcome` is the only scripted shape.
struct Script {
    /// Canned results, returned front-first; the last sticks once reached.
    results: Vec<Result<ToolTurnOutcome, ProviderError>>,
    /// How many times this script has been drawn. Interior mutability is
    /// required (the trait takes `&self`); `AtomicUsize` (not `Cell`) so the
    /// fake stays `Sync` (the `Provider` trait's bound, issue #669: the
    /// turn's runner hands the provider across the loop's thread scope).
    calls: std::sync::atomic::AtomicUsize,
}

impl Script {
    /// Draw the next canned result front-first, clamping to the last once
    /// reached: the first call returns `results[0]`, and once only one remains
    /// it sticks (returned on every later call). A single scripted result is
    /// therefore stable, while a sequence models "explore, then materialize,
    /// then answer" (ADR-0081) -- the trajectories the loop tests need to
    /// exercise offline. An empty queue yields `NotWired` so a misconfigured
    /// script never invents a reply.
    fn draw(&self) -> Result<ToolTurnOutcome, ProviderError> {
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

/// A provider that returns preset tool-turn outcomes keyed by the exact asking
/// question text. An unscripted question yields NotWired -- the fake never
/// invents a reply, preserving "the orchestrator only ever runs provider-
/// supplied SQL" for every test (no hidden default that could mask a wiring
/// bug).
pub struct FakeProvider {
    /// Tool-calling scripts keyed by the asking question (the LAST user
    /// message of the windowed request -- see [`asking_question`]). The loop
    /// drives `generate_tool_turn` once per round-trip; an unscripted question
    /// yields `NotWired`, the "never invent a reply" contract.
    tool_scripts: HashMap<String, Script>,
    /// Every `ToolTurnRequest` handed to `generate_tool_turn`, newest last (one
    /// entry per round-trip). Shared by `Arc` so an agent-loop unit test can
    /// assert the assembled conversation (messages + tools + system) after
    /// driving the loop -- the fake is consumed into the loop, but the capture
    /// handle stays in the test's hand.
    tool_captured: Arc<Mutex<Vec<ToolTurnRequest>>>,
    /// Optional cancel token: when set, a question in [`Self::blocking`] simulates
    /// a long round-trip by polling this token in a tight sleep loop and only
    /// returning once cancel is requested (issue #28). The loop then lands the
    /// turn as Cancelled. `None` for fakes that do not simulate latency.
    cancel: Option<Arc<CancelToken>>,
    /// Questions whose `generate_tool_turn` call blocks until the cancel token
    /// is requested. Models a long, user-cancellable round-trip for the
    /// cancel/watchdog tests (ADR-0021). Empty by default.
    blocking: HashSet<String>,
}

impl Default for FakeProvider {
    /// An empty script map -- every question is refused. Tests build it up with
    /// FakeProvider::scripted_tool_turn / scripted_tool_turn_seq.
    fn default() -> Self {
        Self {
            tool_scripts: HashMap::new(),
            tool_captured: Arc::new(Mutex::new(Vec::new())),
            cancel: None,
            blocking: HashSet::new(),
        }
    }
}

impl FakeProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// A shared handle to every `ToolTurnRequest` this fake has been handed,
    /// newest last (one entry per round-trip). The agent-loop unit tests clone
    /// the `Arc` before passing the fake into the loop, drive it, then inspect
    /// the assembled conversation (system / messages / tools).
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
    /// (ADR-0021). The cancel/watchdog tests drive this so a cancel or the
    /// no-progress watchdog (generation silence, ADR-0115) lands the turn as
    /// cancelled without a real slow
    /// provider. Requires [`Self::with_cancel`] -- without a token the block
    /// is a defensive no-op (the reply returns immediately).
    pub fn scripted_tool_turn_blocking(self, question: &str, reply: ToolTurnReply) -> Self {
        self.mark_blocking(question)
            .scripted_tool_turn(question, reply)
    }

    /// Share the session's cancel token so a blocking question can poll it
    /// (issue #28). The token the Session holds is the same one the test (or the
    /// cancel command) fires -- wiring the fake to it is what lets a black-box
    /// test drive cancel/timeout without a real long round-trip. Builder-style.
    pub fn with_cancel(mut self, cancel: Arc<CancelToken>) -> Self {
        self.cancel = Some(cancel);
        self
    }

    /// Mark `question` blocking: a subsequent `generate_tool_turn` for it
    /// polls the cancel token instead of returning immediately (ADR-0021);
    /// [`block_if_requested`] does the actual poll.
    fn mark_blocking(mut self, question: &str) -> Self {
        self.blocking.insert(question.to_string());
        self
    }

    /// If `key` -- a RESOLVED script key (the staged question, never the
    /// framed asking content) -- is registered blocking, poll the cancel
    /// token in a tight sleep loop and only return once cancel is requested
    /// (ADR-0021). Models a long-running call so the loop sees the cancel
    /// flag and lands the turn as Cancelled. Defensive no-op without a token
    /// (a misconfigured test never hangs).
    fn block_if_requested(&self, key: &str) {
        if self.blocking.contains(key) {
            if let Some(cancel) = &self.cancel {
                while !cancel.is_requested() {
                    thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }
}

/// Insert a canned-result queue for `question` into `map` -- the shared spine
/// of the tool-turn builders. Front-first draw with last-stick clamping lives
/// in [`Script::draw`]; the `Script { results, calls: 0 }` construction has
/// one source here. An empty queue yields `NotWired` on draw (a misconfigured
/// script never invents a reply).
fn insert_script(
    map: &mut HashMap<String, Script>,
    question: &str,
    results: Vec<Result<ToolTurnOutcome, ProviderError>>,
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
    // loop-runtime bridge (session::loop_runtime::model) drops them, keeping
    // the bridged request's conversation identical to what the self-written
    // loop fed this fake pre-swap (ADR-0107, issue #669).
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

impl FakeProvider {
    /// Resolve the script for the asking turn's user message (ADR-0119,
    /// issue #983): the message may carry the invocation preamble AHEAD of
    /// the question (the renderer joins them with one blank line), while the
    /// script key stays the verbatim question. Exact match first; then a
    /// preamble-stripped suffix match, admitted only when the content starts
    /// with the invocation frame marker -- the gate IS the marker: content
    /// that does not lead with it never reaches the suffix arm, so a longer
    /// question that merely ends with a scripted key matches only when it
    /// leads with the marker; that is the whole guarantee. Among the keys
    /// that suffix one marker-led content, the LONGEST wins -- deterministic
    /// where two keys suffix the same content (HashMap iteration order
    /// cannot pick). Returns the resolved key beside the script so the
    /// caller's blocking check keys on the staged question, not the framed
    /// content.
    fn script_for(&self, content: &str) -> Option<(&Script, &str)> {
        if let Some((question, script)) = self.tool_scripts.get_key_value(content) {
            return Some((script, question.as_str()));
        }
        if !content.starts_with(super::prompt::INVOCATION_FRAME_MARKER) {
            return None;
        }
        // Longest suffix wins. Two DISTINCT equal-length keys cannot both
        // suffix one content (the length-L suffix is unique), so max_by_key's
        // tie branch is unreachable -- determinism needs no tie-break.
        self.tool_scripts
            .iter()
            .filter(|(question, _)| {
                content.len() > question.len() && content.ends_with(question.as_str())
            })
            .max_by_key(|(question, _)| question.len())
            .map(|(question, script)| (script, question.as_str()))
    }
}

impl Provider for FakeProvider {
    fn generate_tool_turn(
        &self,
        request: &ToolTurnRequest,
    ) -> Result<ToolTurnOutcome, ProviderError> {
        // Record the assembled tool-turn payload before dispatching, so an
        // agent-loop unit test can assert what the loop assembled (system /
        // messages / tools). A poisoned lock means a panic left it
        // half-updated; drop the capture silently rather than propagating the
        // poison, so a flaky peer test does not block this one.
        if let Ok(mut buf) = self.tool_captured.lock() {
            buf.push(request.clone());
        }
        let question = asking_question(request);
        let Some((script, key)) = self.script_for(question.as_str()) else {
            // The fake never invents a reply (fail fast on misconfig), so
            // NotWired doubles as the script table's misconfiguration label
            // -- name the unresolved content at debug level so app-shell
            // debugging points at the missing script key instead of reading
            // as a wiring fault (issue #989 H; pure cargo test has no log
            // sink -- the Cargo.toml log note prescribes an env_logger
            // dev-dep if test diagnostics are ever needed).
            log::debug!(
                target: "provider::fake",
                "no script resolves the asking content (misconfigured script table): {question}"
            );
            return Err(ProviderError::NotWired);
        };
        // A blocking question simulates a long round-trip (ADR-0021); the
        // loop sees the cancel flag and lands the turn as Cancelled. Keyed
        // on the RESOLVED script key (the staged question), so a blocking +
        // staged-invocation combo keeps its long-round-trip semantics even
        // though the asking content carries the preamble frame -- and an
        // unscripted question never blocks (fail fast on misconfig, the
        // "never invent a reply" posture).
        self.block_if_requested(key);
        script.draw()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // --- native tool-calling (#291, exercised by the loop) ------------------
    use super::super::tool_calling::{ToolDefinition, ToolTurnMessage, ToolUse};
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
        // The fake never invents a tool reply, so an unscripted question
        // yields NotWired -- a test cannot accidentally pass against a hidden
        // default.
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

    /// B (#987): two script keys that both suffix one marker-led content --
    /// the longest key wins deterministically (HashMap iteration order can
    /// no longer pick between them).
    #[test]
    fn frame_led_content_prefers_the_longest_suffix_key() {
        let provider = FakeProvider::new()
            .scripted_tool_turn("查天气", ToolTurnReply::Text("long".into()))
            .scripted_tool_turn("天气", ToolTurnReply::Text("short".into()));
        let framed = format!(
            "{}技能 `sql-coach`：\n\nCoach the SQL.\n\n查天气",
            crate::provider::prompt::INVOCATION_FRAME_MARKER
        );
        let got = provider
            .generate_tool_turn(&tool_request(&framed))
            .expect("the frame-led suffix arm resolves");
        assert_eq!(got.reply, ToolTurnReply::Text("long".into()));
    }

    /// B (#987): a blocking + staged-invocation combo keeps its long
    /// round-trip -- the blocking check keys on the RESOLVED
    /// (preamble-stripped) question, not the framed asking content.
    #[test]
    fn blocking_survives_an_invocation_preamble() {
        let cancel = Arc::new(CancelToken::new());
        let provider = FakeProvider::new()
            .with_cancel(Arc::clone(&cancel))
            .scripted_tool_turn_blocking("查天气", ToolTurnReply::Text("done".into()));
        let framed = format!(
            "{}技能 `sql-coach`：\n\nCoach the SQL.\n\n查天气",
            crate::provider::prompt::INVOCATION_FRAME_MARKER
        );
        let request = tool_request(&framed);
        let joined = std::thread::spawn(move || provider.generate_tool_turn(&request));
        // Give the fake a moment to prove it parks on the token (a silent
        // pass-through would have finished by now).
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            !joined.is_finished(),
            "the blocking question did not engage through the preamble"
        );
        cancel.request();
        let got = joined
            .join()
            .expect("the blocked call returns after cancel")
            .expect("the staged script still resolves");
        assert_eq!(got.reply, ToolTurnReply::Text("done".into()));
    }
}
