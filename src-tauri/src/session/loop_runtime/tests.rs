//! Offline behavior-contract pins for the loop runtime (ADR-0116, issue
//! #917): every termination + dispatch + fold path driven by rig's offline
//! `MockCompletionModel` (stream-event scripts) or the app-provider bridge
//! (a blocking scripted provider) -- no network, no key, no `Session`.
//! Scripted trajectory + the real materializer + an in-memory DuckDB
//! engine, asserting the SAME `LoopOutcome` shapes the yoagent layer's
//! suites pin, so the two runtimes stay behaviorally interchangeable for
//! the #918 swap.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rig_agent::agent::model::ModelHandle;
use rig_core::completion::Message;
use rig_core::message::UserContent;
use rig_core::test_utils::{MockCompletionModel, MockStreamEvent};

use serde_json::{json, Value as JsonValue};

use crate::approval::{ApprovalResponse, ApprovalSink, ApprovalState};
use crate::cancel::CancelToken;
use crate::mcp::aggregator::McpAggregator;
use crate::model::TurnPhase;
use crate::provider::tool_calling::{
    ToolTurnMessage, ToolTurnOutcome, ToolTurnReply, ToolTurnRequest,
};
use crate::provider::{Provider, ProviderError};
use crate::session::engine::AdminEngine;
use crate::session::loop_contract::{LoopOutcome, Termination};
use crate::session::loop_runtime::LoopRuntime;
use crate::session::materializer::RealMaterializer;
use crate::tools::builtin_table;
use crate::tools::test_support::inert_deps_with_temp;
use crate::workingset::WorkingSet;

use tempfile::TempDir;

/// Script one model turn: committed reasoning, one text delta, the batch's
/// tool calls, then the terminal record every stream turn requires.
fn batch_turn(
    thinking: &str,
    prose: Option<&str>,
    calls: &[(&str, &str, JsonValue)],
) -> Vec<MockStreamEvent> {
    let mut events = Vec::new();
    if !thinking.is_empty() {
        events.push(MockStreamEvent::reasoning(thinking));
    }
    if let Some(p) = prose {
        events.push(MockStreamEvent::text(p));
    }
    for (id, name, args) in calls {
        events.push(MockStreamEvent::tool_call(*id, *name, args.clone()));
    }
    events.push(MockStreamEvent::final_response_with_default_usage());
    events
}

/// Script one terminal text turn.
fn text_turn(text: &str) -> Vec<MockStreamEvent> {
    vec![
        MockStreamEvent::text(text),
        MockStreamEvent::final_response_with_default_usage(),
    ]
}

/// A recording approval sink (mirrors the yoagent suites').
#[derive(Default)]
struct RecordingSink {
    _request_ids: Mutex<Vec<uuid::Uuid>>,
}

impl ApprovalSink for RecordingSink {
    fn emit_request(&self, body: &crate::approval::ApprovalRequestBody) {
        if let Ok(id) = uuid::Uuid::parse_str(&body.request_id) {
            self._request_ids.lock().unwrap().push(id);
        }
    }
    fn emit_resolved(
        &self,
        _body: &crate::approval::ApprovalRequestBody,
        _response: ApprovalResponse,
    ) {
    }
}

/// A scripted app provider driving the bridge path (the cancel / watchdog
/// pins): replies pop in order; optional behaviors fire per turn -- firing
/// the app token before answering (the mid-run user cancel), or blocking
/// the generation until the token requests (the silence the select race
/// and the watchdog must break).
struct BlockingProvider {
    script: Mutex<VecDeque<Result<ToolTurnOutcome, ProviderError>>>,
    /// Request the token before answering the Nth call (1-based).
    fire_cancel_on: Option<(usize, Arc<CancelToken>)>,
    /// Hold every call until the token is requested (the silence pin), then
    /// answer with a transient nobody reads (the driver has abandoned).
    block_until_cancel: Option<Arc<CancelToken>>,
    calls: Mutex<usize>,
}

impl BlockingProvider {
    fn new(script: Vec<Result<ToolTurnOutcome, ProviderError>>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            fire_cancel_on: None,
            block_until_cancel: None,
            calls: Mutex::new(0),
        }
    }

    fn with_fire_cancel_on(mut self, turn: usize, token: Arc<CancelToken>) -> Self {
        self.fire_cancel_on = Some((turn, token));
        self
    }

    fn with_block_until_cancel(mut self, token: Arc<CancelToken>) -> Self {
        self.block_until_cancel = Some(token);
        self
    }
}

impl Provider for BlockingProvider {
    fn generate_tool_turn(
        &self,
        _request: &ToolTurnRequest,
    ) -> Result<ToolTurnOutcome, ProviderError> {
        let turn = {
            let mut calls = self.calls.lock().unwrap();
            *calls += 1;
            *calls
        };
        if let Some((fire_at, token)) = &self.fire_cancel_on {
            if *fire_at == turn {
                token.request();
            }
        }
        if let Some(token) = &self.block_until_cancel {
            while !token.is_requested() {
                std::thread::sleep(Duration::from_millis(5));
            }
            return Err(ProviderError::Unavailable("cancelled in generation".into()));
        }
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .expect("script exhausted before the run ended")
    }
}

/// One turn's harness state: the engine + working set + temp dir + deps
/// stand-ins the real materializer needs (the yoagent suites' harness,
/// mirrored).
struct Harness {
    engine: AdminEngine,
    ws: WorkingSet,
    sources: HashMap<String, std::path::PathBuf>,
    refs: HashMap<String, crate::session::materializer::CachedDerivedRef>,
    temp: TempDir,
    phases: Arc<Mutex<Vec<TurnPhase>>>,
    skills: crate::session::skills::SkillActivationFixture,
    read_fragments: Vec<crate::skills::SkillPromptFragment>,
    read_activated: Vec<String>,
    read_root: std::path::PathBuf,
}

impl Harness {
    fn new() -> Self {
        Self {
            engine: AdminEngine::materialized(),
            ws: WorkingSet::default(),
            sources: HashMap::new(),
            refs: HashMap::new(),
            temp: TempDir::new().unwrap(),
            phases: Arc::new(Mutex::new(Vec::new())),
            skills: crate::session::skills::SkillActivationFixture::new(Vec::new()),
            read_fragments: Vec::new(),
            read_activated: Vec::new(),
            read_root: std::path::PathBuf::new(),
        }
    }

    /// Seed a registered result_1 so explore / materialize have a target.
    fn seed_result_1(&mut self) {
        self.engine
            .conn()
            .execute_batch("CREATE TABLE result_1 (id INTEGER)")
            .unwrap();
        self.engine
            .conn()
            .execute_batch("INSERT INTO result_1 VALUES (1), (2)")
            .unwrap();
        self.ws.register_result(crate::model::DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![crate::model::ColumnSchema {
                name: "id".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 2,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: crate::model::RectifyProvenance::NotApplicable,
            privacy: crate::model::DatasetPrivacy::default(),
            stale: None,
        });
    }

    fn request(&self, question: &str) -> ToolTurnRequest {
        ToolTurnRequest {
            system: "system prompt".into(),
            messages: vec![ToolTurnMessage::user(question)],
            tools: builtin_table(),
            max_tokens: 512,
            thought_level: None,
        }
    }

    fn run(
        &mut self,
        request: &ToolTurnRequest,
        runtime: LoopRuntime,
        cancel: Arc<CancelToken>,
    ) -> LoopOutcome {
        self.run_with_caps(request, runtime, cancel, 24, None)
    }

    fn run_with_caps(
        &mut self,
        request: &ToolTurnRequest,
        runtime: LoopRuntime,
        cancel: Arc<CancelToken>,
        step_cap: u32,
        no_progress_cap: Option<Duration>,
    ) -> LoopOutcome {
        let runtime = runtime.with_caps(step_cap, no_progress_cap);
        let mut deps = inert_deps_with_temp(
            &self.engine,
            &mut self.ws,
            &mut self.sources,
            self.temp.path(),
            &mut self.refs,
        );
        let mut mcp = McpAggregator::empty();
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let phases = Arc::clone(&self.phases);
        let read = crate::skills::read::SkillReadGate {
            fragments: &self.read_fragments,
            activated: &self.read_activated,
            root: &self.read_root,
        };
        let cli: [crate::cli_tools::config::CliToolConfig; 0] = [];
        runtime.run(
            request,
            &mut deps,
            &mut RealMaterializer,
            &mut mcp,
            &cli,
            &mut self.skills.ctx(),
            &read,
            &approval,
            &sink,
            cancel,
            move |phase| phases.lock().unwrap().push(phase),
        )
    }
}

fn mock_runtime(model: MockCompletionModel) -> LoopRuntime {
    LoopRuntime::new(ModelHandle::new(model))
}

fn bridged_runtime(provider: Arc<dyn Provider>) -> LoopRuntime {
    LoopRuntime::bridged(provider)
}

/// Multi-step success with thinking, prose, and two dispatch rounds: the
/// trace is round-grouped exactly as the yoagent layer groups it (thinking
/// and prose on round 1, the batch's entries in dispatch order), the
/// promotion carries the materializer's `result_N` name, and the terminal
/// text lands verbatim. The dispatch path is the shared gateway core, so
/// this doubles as the materialization-discipline pin for the layer.
#[test]
fn multi_step_success_groups_rounds_and_promotes() {
    let mut h = Harness::new();
    h.seed_result_1();
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "count the rows first",
            Some("Looking at the data."),
            &[(
                "tu_1",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            )],
        ),
        batch_turn(
            "now materialize",
            None,
            &[(
                "tu_2",
                "materialize",
                json!({"sql": "SELECT count(*) AS n FROM result_1"}),
            )],
        ),
        text_turn("There are 2 rows."),
    ]);
    let outcome = h.run(
        &h.request("how many rows"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("There are 2 rows.".into())
    );
    assert_eq!(outcome.trace.len(), 2, "one round per tool-call batch");
    let round1 = &outcome.trace[0];
    assert_eq!(
        round1.thinking.as_ref().expect("round 1 thinking").text,
        "count the rows first"
    );
    assert_eq!(round1.thinking.as_ref().unwrap().duration_ms, 0);
    assert_eq!(round1.text.as_deref(), Some("Looking at the data."));
    assert_eq!(round1.calls.len(), 1);
    assert_eq!(round1.calls[0].name, "explore");
    assert!(round1.calls[0].success, "explore succeeds");
    let round2 = &outcome.trace[1];
    assert_eq!(round2.calls[0].name, "materialize");
    // result_1 occupied, so the promotion is result_2 -- the materializer's
    // monotonic naming, unchanged through the adapter.
    assert_eq!(outcome.promotions.len(), 1);
    assert_eq!(outcome.promotions[0].dataset.reference_name, "result_2");
}

/// The batched-`tool_result` wire contract (ADR-0116's diagnostic-probe
/// pin): a two-call batch's results ride the NEXT model request as ONE user
/// message carrying both `ToolResult` blocks -- the merge whose absence in
/// the yoagent path was the >=2-tool-calls 400 fault. Asserted off the
/// mock's recorded requests (the exact history rig's providers serialize).
#[test]
fn multi_call_batch_merges_results_into_one_user_message() {
    let mut h = Harness::new();
    h.seed_result_1();
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "",
            Some("two at once."),
            &[
                ("tu_1", "explore", json!({"sql": "SELECT 1 AS a"})),
                ("tu_2", "explore", json!({"sql": "SELECT 2 AS b"})),
            ],
        ),
        text_turn("both explored."),
    ]);
    let probe = model.clone();
    let outcome = h.run(
        &h.request("two calls"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );
    assert_eq!(
        outcome.termination,
        Termination::Text("both explored.".into())
    );
    assert_eq!(outcome.trace.len(), 1, "one round per batch, not per call");
    assert_eq!(outcome.trace[0].calls.len(), 2);
    assert!(outcome.trace[0].calls.iter().all(|c| c.success));

    // The wire pin: the second request's history closes with ONE user
    // message carrying BOTH results, following the batch's assistant turn.
    let requests = probe.requests();
    assert!(requests.len() >= 2, "two model round-trips happened");
    let second = &requests[1];
    let last_user = second
        .chat_history
        .iter()
        .rev()
        .find_map(|m| match m {
            Message::User { content } => Some(content.clone()),
            _ => None,
        })
        .expect("a user message carries the batch results");
    let result_count = last_user
        .iter()
        .filter(|b| matches!(b, UserContent::ToolResult(_)))
        .count();
    assert_eq!(
        result_count, 2,
        "both batch results ride one user message, never split"
    );
}

/// Terminal fault classification (ADR-0116 Decision 5), driven through the
/// bridge: `NotWired` rides an honest HTTP 401 (the status class the
/// terminal derivation maps to NotWired for every rig provider, live ones
/// included), `InvalidConfig` rides 400 + the module's prefix encoding and
/// strips back to its payload, and everything else lands an honest
/// transient. (A live provider's own 401/403/500 wire shapes get their pins
/// when #918 wires the real clients -- the classification arm itself is the
/// same code path these pins exercise.)
#[test]
fn terminal_faults_classify_by_status_and_encoding() {
    let fault = |err: ProviderError| -> LoopOutcome {
        let mut h = Harness::new();
        let provider = Arc::new(BlockingProvider::new(vec![Err(err)]));
        h.run(
            &h.request("fault"),
            bridged_runtime(provider),
            Arc::new(CancelToken::new()),
        )
    };
    assert_eq!(
        fault(ProviderError::NotWired).termination,
        Termination::NotWired,
        "not-wired rides 401, the not-wired status class"
    );
    assert_eq!(
        fault(ProviderError::InvalidConfig(
            "scheme `file` is not http/https".into()
        ))
        .termination,
        Termination::InvalidConfig("scheme `file` is not http/https".into()),
        "invalid config rides 400 + prefix and strips back to its payload"
    );
    assert!(
        matches!(
            fault(ProviderError::Unavailable("rate limited".into())).termination,
            Termination::Transient(_)
        ),
        "other faults land an honest transient"
    );
}

/// The step cap maps onto the rig `max_turns` budget: a turn that never
/// converges exhausts it and lands `StepCap` carrying the configured cap.
#[test]
fn step_cap_exhaustion_lands_step_cap() {
    let mut h = Harness::new();
    h.seed_result_1();
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "",
            None,
            &[(
                "tu_1",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            )],
        ),
        batch_turn(
            "",
            None,
            &[(
                "tu_2",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            )],
        ),
    ]);
    let outcome = h.run_with_caps(
        &h.request("never converges"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
        1,
        None,
    );
    assert_eq!(outcome.termination, Termination::StepCap(1));
}

/// A user cancel mid-run wins over any reply (ADR-0021): the token fires
/// inside the second generation; the driver's select race abandons the
/// silent wait and the landing is a plain `Cancelled`.
#[test]
fn user_cancel_wins_over_the_reply() {
    let mut h = Harness::new();
    h.seed_result_1();
    let token = Arc::new(CancelToken::new());
    let provider = BlockingProvider::new(vec![Ok(ToolTurnOutcome {
        thinking: Vec::new(),
        reply: ToolTurnReply::ToolCalls {
            text: None,
            calls: vec![crate::provider::tool_calling::ToolUse {
                id: "tu_1".into(),
                name: "explore".into(),
                input: json!({"sql": "SELECT count(*) FROM result_1"}),
            }],
        },
    })]);
    // The second generation goes silent; a background thread requests the
    // token shortly after it starts.
    let fire_token = Arc::clone(&token);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        fire_token.request();
    });
    let provider = provider.with_block_until_cancel(Arc::clone(&token));
    let outcome = h.run_with_caps(
        &h.request("cancel me"),
        bridged_runtime(Arc::new(provider) as Arc<dyn Provider>),
        token,
        24,
        None,
    );
    assert_eq!(outcome.termination, Termination::Cancelled);
}

/// The no-progress watchdog's kill (ADR-0115): a generation that goes
/// silent past the cap lands `NoProgress` with the armed cap -- the
/// cancelled-vs-timed-out fork of the same cancel landing.
#[test]
fn no_progress_silence_lands_no_progress() {
    let mut h = Harness::new();
    let token = Arc::new(CancelToken::new());
    let provider = BlockingProvider::new(Vec::new()).with_block_until_cancel(Arc::clone(&token));
    let outcome = h.run_with_caps(
        &h.request("go silent"),
        bridged_runtime(Arc::new(provider) as Arc<dyn Provider>),
        token,
        24,
        Some(Duration::from_millis(150)),
    );
    match &outcome.termination {
        Termination::NoProgress(detail) => {
            assert_eq!(detail.cap, Duration::from_millis(150));
        }
        other => panic!("expected NoProgress, got {other:?}"),
    }
}

/// The unknown-tool-call fallback (ADR-0116 Decision 5): the model reaching
/// for a tool outside the advertised table lands an honest transient
/// carrying the name -- never a silent success, never a bare cancel.
#[test]
fn unknown_tool_call_lands_honest_transient() {
    let mut h = Harness::new();
    let model = MockCompletionModel::from_stream_turns([batch_turn(
        "",
        None,
        &[("tu_1", "not_a_registered_tool", json!({}))],
    )]);
    let outcome = h.run(
        &h.request("call something unknown"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );
    match &outcome.termination {
        Termination::Transient(detail) => {
            assert!(
                detail.contains("not_a_registered_tool"),
                "the detail names the tool: {detail}"
            );
        }
        other => panic!("expected Transient, got {other:?}"),
    }
}
