//! Offline behavior-contract pins for the loop runtime (ADR-0116, issue
//! #917): every termination + dispatch + fold path driven by rig's offline
//! `MockCompletionModel` (stream-event scripts) or the app-provider bridge
//! (a blocking scripted provider) -- no network, no key, no `Session`.
//! Scripted trajectory + the real materializer + an in-memory DuckDB
//! engine, asserting the `LoopOutcome` shapes these suites pin -- the
//! termination vocabulary, round grouping, and dispatch contract.
//! Loop-detection
//! steer-and-abort is ported at the dispatch seam (issue #918): the steer
//! rides the ADR-0028 error channel -- the refused call genuinely does
//! not run -- and the post-nudge repeat latches the honest abort, so
//! interchangeability is claimed for the pinned surfaces plus this
//! ported seam, never as a blanket equivalence.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
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
    ToolDefinition, ToolTurnMessage, ToolTurnOutcome, ToolTurnReply, ToolTurnRequest,
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

/// A no-op approval sink: these suites never exercise approval flows, so
/// the sink only satisfies the gate's constructor (the recording sink it
/// retires kept a request-id ledger nothing ever read, #922).
struct NoopSink;

impl ApprovalSink for NoopSink {
    fn emit_request(&self, _body: &crate::approval::ApprovalRequestBody) {}
    fn emit_resolved(
        &self,
        _body: &crate::approval::ApprovalRequestBody,
        _response: ApprovalResponse,
    ) {
    }
}

/// A recording sink for the approval pin (issue #928): unlike the no-op
/// sink above -- its ledger was retired in #922 because nothing ever read
/// it -- this one has a reader. The responder thread polls the emitted
/// request ids to time its Deny against the gate's condvar wait. The wire
/// carries ids as strings; they parse once here so the responder answers
/// with the typed id (mirrors the gate-test sink in turn_dispatch's
/// suites).
#[derive(Default)]
struct RecordingSink {
    request_ids: Mutex<Vec<uuid::Uuid>>,
    /// The originator annotation each emitted card carried (issue #934),
    /// parallel to `request_ids`: the origin-wiring pin asserts the
    /// delegating sub-agent's name rode the gate END TO END (None = a
    /// main-loop / external-runtime call).
    origins: Mutex<Vec<Option<String>>>,
}

impl ApprovalSink for RecordingSink {
    fn emit_request(&self, body: &crate::approval::ApprovalRequestBody) {
        let id = uuid::Uuid::parse_str(&body.request_id).expect("the gate stamps uuid ids");
        self.request_ids.lock().unwrap().push(id);
        self.origins.lock().unwrap().push(body.origin_agent.clone());
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
    /// Every app request the bridge handed over, in arrival order -- the
    /// recording face the module-local translation guards read (issue #926:
    /// system lift + thought-level read-back must redden inside this suite,
    /// not only in the blackbox layers).
    requests: Mutex<Vec<ToolTurnRequest>>,
}

impl BlockingProvider {
    fn new(script: Vec<Result<ToolTurnOutcome, ProviderError>>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            fire_cancel_on: None,
            block_until_cancel: None,
            calls: Mutex::new(0),
            requests: Mutex::new(Vec::new()),
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
        request: &ToolTurnRequest,
    ) -> Result<ToolTurnOutcome, ProviderError> {
        self.requests.lock().unwrap().push(request.clone());
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

/// The harness's optional per-phase test hook: fires on every phase, on
/// the caller thread, before the phase lands in the collected log -- how
/// the mid-batch gate pins request the token at dispatch time.
type PhaseHook = Arc<dyn Fn(&TurnPhase) + Send + Sync>;

/// One turn's harness state: the engine + working set + temp dir + deps
/// stand-ins the real materializer needs.
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
    phase_hook: Option<PhaseHook>,
    /// The turn's delegation specs (issue #933): defaults empty; the
    /// delegation suites seed specs and advertise the matching tool names
    /// on the request.
    delegations: Vec<crate::agents::DelegationSpec>,
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
            phase_hook: None,
            delegations: Vec::new(),
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

    /// A request whose tool table additionally advertises the named tools:
    /// a scripted external call must be advertised for the loop to
    /// dispatch it at all (the unknown-tool fallback would otherwise land
    /// the honest transient).
    fn request_with_tools(&self, question: &str, extra: &[&str]) -> ToolTurnRequest {
        let mut request = self.request(question);
        for name in extra {
            request.tools.push(ToolDefinition {
                name: (*name).into(),
                description: "test-external tool".into(),
                input_schema: json!({"type": "object"}),
            });
        }
        request
    }

    fn run(
        &mut self,
        request: &ToolTurnRequest,
        runtime: LoopRuntime,
        cancel: Arc<CancelToken>,
    ) -> LoopOutcome {
        self.run_with_caps(request, runtime, cancel, 24, None)
    }

    /// The default turn shape: a fresh approval state, the no-op sink, no
    /// CLI tools -- the suites calling this never exercise approval flows.
    fn run_with_caps(
        &mut self,
        request: &ToolTurnRequest,
        runtime: LoopRuntime,
        cancel: Arc<CancelToken>,
        step_cap: u32,
        no_progress_cap: Option<Duration>,
    ) -> LoopOutcome {
        self.run_turn(
            request,
            runtime,
            cancel,
            step_cap,
            no_progress_cap,
            &[],
            &ApprovalState::new(),
            &NoopSink,
        )
    }

    /// The parameterized turn assembly the default entry points and the
    /// approval pin share (issue #928): the gate's recording sink and the
    /// CLI tool table are the approval pin's only extras.
    #[allow(clippy::too_many_arguments)]
    fn run_turn(
        &mut self,
        request: &ToolTurnRequest,
        runtime: LoopRuntime,
        cancel: Arc<CancelToken>,
        step_cap: u32,
        no_progress_cap: Option<Duration>,
        cli: &[crate::cli_tools::config::CliToolConfig],
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
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
        let phases = Arc::clone(&self.phases);
        let phase_hook = self.phase_hook.clone();
        let read = crate::skills::read::SkillReadGate {
            fragments: &self.read_fragments,
            activated: &self.read_activated,
            root: &self.read_root,
        };
        runtime.run(
            request,
            &mut deps,
            &mut RealMaterializer,
            &mut mcp,
            cli,
            &self.delegations,
            &mut self.skills.ctx(),
            &read,
            approval,
            sink,
            cancel,
            move |phase| {
                if let Some(hook) = &phase_hook {
                    hook(&phase);
                }
                phases.lock().unwrap().push(phase);
            },
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
/// trace is round-grouped (thinking
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
    assert_eq!(
        round2.thinking.as_ref().expect("round 2 thinking").text,
        "now materialize",
        "a no-prose turn's thinking rides its batch round, never dropped"
    );
    assert_eq!(
        round2.text.as_deref(),
        None,
        "round 2 streamed no prose; round 1's must not leak into it"
    );
    assert_eq!(round2.calls[0].name, "materialize");
    // result_1 occupied, so the promotion is result_2 -- the materializer's
    // monotonic naming, unchanged through the adapter.
    assert_eq!(outcome.promotions.len(), 1);
    assert_eq!(outcome.promotions[0].dataset.reference_name, "result_2");

    // The phase rail stays per-turn: one RoundText (round 1's prose only,
    // never re-emitted for the prose-less round 2), one ThinkingCompleted
    // per thinking-bearing turn with that turn's thinking alone (never a
    // cross-turn concatenation), and a Thinking marker for every turn
    // opened -- three turns, the terminal one included.
    let phases = h.phases.lock().unwrap();
    let round_texts: Vec<&str> = phases
        .iter()
        .filter_map(|p| match p {
            TurnPhase::RoundText { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(round_texts, vec!["Looking at the data."]);
    let think_done: Vec<&str> = phases
        .iter()
        .filter_map(|p| match p {
            TurnPhase::ThinkingCompleted { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        think_done,
        vec!["count the rows first", "now materialize"],
        "each turn's thinking completes alone, at its own close"
    );
    let attempts: Vec<u32> = phases
        .iter()
        .filter_map(|p| match p {
            TurnPhase::Thinking { attempt } => Some(*attempt),
            _ => None,
        })
        .collect();
    assert_eq!(attempts, vec![1, 2, 3], "every turn opens, prose or not");
}

/// The batched-`tool_result` wire contract (ADR-0116's diagnostic-probe
/// pin): a two-call batch's results ride the NEXT model request as ONE user
/// message carrying both `ToolResult` blocks -- the merge whose absence
/// was the >=2-tool-calls 400 fault. Asserted off the
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

/// A provider-owned 400 body must never strip into the app's
/// `InvalidConfig` class, even when its text happens to start with the
/// legacy human-readable prefix phrase: the live encoding is
/// control-character-led, a shape no provider error body structurally
/// takes, so phrase-shaped text classifies as the honest transient it is.
/// The ambiguity this pin kills: phrase-prefix matching would turn a live
/// provider's own 400 into a permanent fault class (#922).
#[test]
fn provider_owned_400_body_is_transient_even_when_prefix_shaped() {
    let err = rig_core::completion::CompletionError::ProviderResponse(
        rig_core::ProviderResponseError::new(
            http::StatusCode::BAD_REQUEST,
            "invalid config: scheme `file` is not http/https",
        ),
    );
    assert!(
        matches!(
            super::termination_for_completion(&err),
            Termination::Transient(_)
        ),
        "a provider-owned 400 body must not classify as InvalidConfig"
    );
}

/// The bridged face's request-translation guards (issue #926): the loop
/// runtime feeds rig the system prompt through the preamble slot, and the
/// bridge must lift it back onto the app request's own `system` field;
/// the drive thread stamps the posture's thought level under the
/// app-private key, and the bridge must read it back onto
/// `thought_level`. Asserted off the scripted provider's recorded
/// requests, INSIDE the module suite -- the blackbox layers pin the same
/// paths, but a module-local revert (the lift's fallback dropped, the
/// read-back dropped) must redden here first, not only there.
#[test]
fn bridged_requests_keep_the_system_prompt_and_thought_level() {
    let mut h = Harness::new();
    let provider = Arc::new(BlockingProvider::new(vec![Ok(ToolTurnOutcome {
        thinking: Vec::new(),
        reply: ToolTurnReply::Text("ok".into()),
    })]));
    let mut request = h.request("guarded");
    request.thought_level = Some("high".into());
    let outcome = h.run(
        &request,
        bridged_runtime(Arc::clone(&provider) as Arc<dyn Provider>),
        Arc::new(CancelToken::new()),
    );
    assert_eq!(outcome.termination, Termination::Text("ok".into()));
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1, "one round-trip: the reply ends the turn");
    let seen = &requests[0];
    assert_eq!(
        seen.system, "system prompt",
        "the preamble lifts back onto the app request's own system field"
    );
    assert_eq!(
        seen.thought_level.as_deref(),
        Some("high"),
        "the app-private key's stamp reads back onto thought_level"
    );
    // The lifted system prompt must not ALSO ride the conversation as a
    // user turn -- the contract: system as its own field, never a user turn.
    assert!(
        !seen.messages.iter().any(|m| matches!(
            m,
            ToolTurnMessage::User { content } if content == "system prompt"
        )),
        "the system prompt never leaks into the message list: {:?}",
        seen.messages
    );
}

/// Dispatch call ids mint uuid-backed: uniqueness is intrinsic to the
/// mint, never an artifact of counter scope (#922 retired the per-turn
/// `gateway-0` collisions a scoped counter minted). This pin holds the
/// mint's contract -- one distinct id per call, `gateway-` prefixed
/// against provider-issued handles; the retired collision shape is no
/// longer constructible to replay.
#[test]
fn call_ids_mint_distinct_ids() {
    let round_one = super::adapter::next_call_id();
    let round_two = super::adapter::next_call_id();
    assert_ne!(
        round_one, round_two,
        "the mint itself yields distinct ids -- uniqueness rides the mint, not counter scope"
    );
    assert!(round_one.starts_with("gateway-"));
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

/// The step-cap wiring seam (issue #921): a cap of 2 with a two-batch
/// script must run BOTH batches before landing `StepCap` -- asserted off
/// the trace's round count, because the termination alone renders off the
/// configured cap either way. A wiring that silently dropped the
/// `.max_turns` handoff would run rig's default budget of 1 turn and
/// surface only one round, which this pin catches; the sibling pin above
/// (cap 1) shares that default's value and so cannot.
#[test]
fn step_cap_wiring_feeds_the_configured_budget() {
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
        2,
        None,
    );
    assert_eq!(outcome.termination, Termination::StepCap(2));
    assert_eq!(
        outcome.trace.len(),
        2,
        "both capped batches ran: the configured budget crossed the wiring seam, not rig's default"
    );
}

/// The identical-arguments loop detection, ported at the dispatch seam
/// (issue #918, the #920-review-I4 disposition): a model re-issuing one
/// call verbatim executes it twice, the seam then refuses to dispatch
/// (the refusal text rides back as the error result the model can
/// self-correct from -- rig has no mid-run message-injection surface for
/// a nudge, so the steer rides the ADR-0028
/// error channel), and the repeat after that nudge latches an honest
/// abort the cancel watcher stops the run with -- long before the step
/// cap, with the loop's own reason in the termination.
#[test]
fn loop_detection_refuses_identical_arguments_then_aborts() {
    let mut h = Harness::new();
    h.seed_result_1();
    let call = (
        "tu_1",
        "materialize",
        json!({"sql": "SELECT count(*) AS n FROM result_1"}),
    );
    let model = MockCompletionModel::from_stream_turns([
        batch_turn("t1", None, std::slice::from_ref(&call)),
        batch_turn("t2", None, std::slice::from_ref(&call)),
        batch_turn("t3", None, std::slice::from_ref(&call)),
        batch_turn("t4", None, &[call]),
        text_turn("never reached: the abort stops the next model call"),
    ]);
    let outcome = h.run(
        &h.request("stuck"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    match &outcome.termination {
        Termination::Transient(detail) => {
            assert!(
                detail.contains("loop detection aborted the run"),
                "the abort carries the loop's own reason: {detail:?}"
            );
            assert!(
                detail.contains("identical arguments"),
                "the repetition detail rides the termination: {detail:?}"
            );
            assert!(
                detail.contains("after being asked to change approach"),
                "the nudge history is part of the honest reason: {detail:?}"
            );
        }
        other => panic!("expected the loop-detection abort, got {other:?}"),
    }
    // Execution-side discrimination: only the first two calls ran (each
    // promoting once); the refused repeats promote nothing.
    assert_eq!(
        outcome.promotions.len(),
        2,
        "the steered and aborted repeats must not execute"
    );
    // Trace-side: every model-issued call keeps an honest row -- the first
    // two succeed, the refused pair land as failed entries carrying the
    // refusal.
    let calls: Vec<&crate::session::loop_contract::TraceEntry> =
        outcome.trace.iter().flat_map(|r| r.calls.iter()).collect();
    assert_eq!(calls.len(), 4, "one row per model-issued call");
    assert_eq!(
        calls.iter().filter(|c| c.success).count(),
        2,
        "the identical pair executed, the refused pair did not"
    );
    let refused = calls.iter().filter(|c| !c.success).collect::<Vec<_>>();
    assert!(refused
        .iter()
        .all(|c| c.result_excerpt.contains("identical arguments")));
}

/// The detector counts arrivals per (tool name, argument signature)
/// cumulatively over the whole turn: two arrivals of each of two
/// signatures sit below the refuse-at-3 threshold, so a model iterating
/// towards different queries never trips the refusal here. The count is
/// never reset by interleaving -- the mixed-batch pin below pins that
/// half; this one pins only the below-threshold side.
#[test]
fn two_arrivals_of_each_signature_sit_below_the_refusal_threshold() {
    let mut h = Harness::new();
    h.seed_result_1();
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "t1",
            None,
            &[(
                "tu_1",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            )],
        ),
        batch_turn(
            "t2",
            None,
            &[(
                "tu_2",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            )],
        ),
        batch_turn(
            "t3",
            None,
            &[("tu_3", "explore", json!({"sql": "SELECT id FROM result_1"}))],
        ),
        batch_turn(
            "t4",
            None,
            &[("tu_4", "explore", json!({"sql": "SELECT id FROM result_1"}))],
        ),
        text_turn("done"),
    ]);
    let outcome = h.run(
        &h.request("iterating"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );
    assert_eq!(
        outcome.termination,
        Termination::Text("done".into()),
        "per-signature counts sit below the threshold: nothing refused"
    );
    assert!(outcome
        .trace
        .iter()
        .flat_map(|r| r.calls.iter())
        .all(|c| c.success));
}

/// The cumulative semantics of the mixed batch -- the ADR-0116
/// calibration's core behavioral claim: a model re-issuing the SAME
/// two-call batch every round is just as stuck as a single repeated
/// call, so arrivals accumulate per (tool name, argument signature)
/// across the whole turn and the interleaved repeats steer on each
/// pair's third arrival, abort on the fourth. A last-signature-seen
/// design -- a single
/// streak any different call resets -- would take the alternation for
/// progress and release the run to the step cap; this pin is what keeps
/// that design out.
#[test]
fn mixed_batch_repetitions_accumulate_across_rounds() {
    let mut h = Harness::new();
    h.seed_result_1();
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "t1",
            None,
            &[
                (
                    "tu_1",
                    "explore",
                    json!({"sql": "SELECT count(*) FROM result_1"}),
                ),
                ("tu_2", "explore", json!({"sql": "SELECT id FROM result_1"})),
            ],
        ),
        batch_turn(
            "t2",
            None,
            &[
                (
                    "tu_3",
                    "explore",
                    json!({"sql": "SELECT count(*) FROM result_1"}),
                ),
                ("tu_4", "explore", json!({"sql": "SELECT id FROM result_1"})),
            ],
        ),
        batch_turn(
            "t3",
            None,
            &[
                (
                    "tu_5",
                    "explore",
                    json!({"sql": "SELECT count(*) FROM result_1"}),
                ),
                ("tu_6", "explore", json!({"sql": "SELECT id FROM result_1"})),
            ],
        ),
        batch_turn(
            "t4",
            None,
            &[
                (
                    "tu_7",
                    "explore",
                    json!({"sql": "SELECT count(*) FROM result_1"}),
                ),
                ("tu_8", "explore", json!({"sql": "SELECT id FROM result_1"})),
            ],
        ),
        text_turn("never reached: the abort stops the next model call"),
    ]);
    let outcome = h.run(
        &h.request("stuck-batch"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    match &outcome.termination {
        Termination::Transient(detail) => {
            assert!(
                detail.contains("loop detection aborted the run"),
                "the mixed batch aborts, not the step cap: {detail:?}"
            );
            assert!(
                detail.contains("identical arguments"),
                "the repetition detail rides the termination: {detail:?}"
            );
        }
        other => panic!("expected the loop-detection abort, got {other:?}"),
    }
    // Honest rows: the first two rounds execute both calls (four
    // successes), the third round's arrivals both refuse (two failed
    // rows), and the fourth round's first arrival refuses and latches
    // the abort -- its sibling lands gate-cancelled at the loop top (the
    // run is over; the mid-batch check precedes the screen), owing no
    // row of its own.
    let calls: Vec<&crate::session::loop_contract::TraceEntry> =
        outcome.trace.iter().flat_map(|r| r.calls.iter()).collect();
    assert_eq!(calls.len(), 7, "one row per screened call");
    assert_eq!(
        calls.iter().filter(|c| c.success).count(),
        4,
        "the first two rounds executed; the refused repeats did not"
    );
    let refused = calls.iter().filter(|c| !c.success).collect::<Vec<_>>();
    assert_eq!(refused.len(), 3, "two steers and the abort that latched");
    assert!(refused
        .iter()
        .all(|c| c.result_excerpt.contains("identical arguments")));
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

/// A user cancel wins over a SUCCESS reply too (issue #921): the token
/// fires inside the second generation and the provider then returns a
/// text answer -- the in-flight-reply shape the sibling
/// `user_cancel_wins_over_the_reply` pin cannot reach (its blocking
/// provider only ever surfaces an error once unblocked). The win rides
/// the cancel machinery's layered channels: the watcher's text-delta
/// checkpoint stops the run as the reply's content starts flowing, the
/// driver's select race covers the silent stretch, and the runner's
/// post-join turn-over check is the last line. Mutating any single
/// channel is masked by the others (deliberate depth); this pin holds
/// the behavioral contract -- a scripted success reply in flight never
/// lands as the turn's text once the token is requested.
#[test]
fn user_cancel_wins_over_a_late_success_reply() {
    let mut h = Harness::new();
    h.seed_result_1();
    let token = Arc::new(CancelToken::new());
    let provider = BlockingProvider::new(vec![
        Ok(ToolTurnOutcome {
            thinking: Vec::new(),
            reply: ToolTurnReply::ToolCalls {
                text: None,
                calls: vec![crate::provider::tool_calling::ToolUse {
                    id: "tu_1".into(),
                    name: "explore".into(),
                    input: json!({"sql": "SELECT count(*) FROM result_1"}),
                }],
            },
        }),
        Ok(ToolTurnOutcome {
            thinking: Vec::new(),
            reply: ToolTurnReply::Text("late reply after cancel".into()),
        }),
    ])
    .with_fire_cancel_on(2, Arc::clone(&token));
    let outcome = h.run_with_caps(
        &h.request("cancel me"),
        bridged_runtime(Arc::new(provider) as Arc<dyn Provider>),
        token,
        24,
        None,
    );
    assert_eq!(
        outcome.termination,
        Termination::Cancelled,
        "the cancel overrides the in-flight success reply, not just error exits"
    );
}

/// The mid-batch gate (issue #921): a user cancel landing between the
/// calls of a two-call batch -- fired at the first call's completion, the
/// last dispatch-side phase before the queue moves on -- must answer the
/// remaining queued calls instead of running them (the per-call gate the
/// rig executor lacks between one batch's calls). The executed call still
/// accounts (its trace entry lands on the trace); the gated remainder
/// neither lands a trace row nor promotes. Fired at completion rather
/// than start because the tool executors honor the token directly: a
/// start-time fire would short-circuit the call instead of executing it.
#[test]
fn mid_batch_cancel_gates_the_remaining_calls() {
    let mut h = Harness::new();
    h.seed_result_1();
    let token = Arc::new(CancelToken::new());
    let fired = Arc::new(AtomicBool::new(false));
    {
        let token = Arc::clone(&token);
        let fired = Arc::clone(&fired);
        h.phase_hook = Some(Arc::new(move |phase: &TurnPhase| {
            if matches!(phase, TurnPhase::ToolCallCompleted(_))
                && !fired.swap(true, Ordering::SeqCst)
            {
                token.request();
            }
        }));
    }
    let model = MockCompletionModel::from_stream_turns([batch_turn(
        "",
        None,
        &[
            (
                "tu_1",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            ),
            (
                "tu_2",
                "materialize",
                json!({"sql": "SELECT count(*) AS n FROM result_1"}),
            ),
        ],
    )]);
    let outcome = h.run_with_caps(
        &h.request("batch then cancel"),
        mock_runtime(model),
        token,
        24,
        None,
    );
    assert_eq!(outcome.termination, Termination::Cancelled);
    assert_eq!(
        outcome.trace.len(),
        1,
        "the interrupted batch's round survives"
    );
    assert_eq!(
        outcome.trace[0].calls.len(),
        1,
        "only the executed call lands"
    );
    assert_eq!(outcome.trace[0].calls[0].name, "explore");
    assert!(
        outcome.trace[0].calls[0].success,
        "the executed call completed before the gate saw the token"
    );
    assert!(
        outcome.promotions.is_empty(),
        "the never-run materialize promotes nothing"
    );
}

/// The empty-round drop (`loop_contract`'s `retain_landed_rounds`): a
/// round with no thinking, no prose, and no completed call must not
/// survive to the recorded trace -- the frontend fold cannot see such a
/// round (none of its events ever fired), so the recorded trace must
/// match it. The shape is a cancellation between the reply and the first
/// dispatch: the turn opens with an empty-text item (the `Thinking`
/// wait marker fires; empty prose leaves no field), the batch's single
/// call commits the round, and the per-call gate -- which sees the
/// requested token before the executor ever starts -- answers it without
/// running it, so no row lands and the round drops on its way out. The
/// port of the retired layer's trace-empty pin (its suite asserted an
/// un-dispatched round leaves no entry at all); the grouping half is
/// pinned separately by `multi_step_success_groups_rounds_and_promotes`.
#[test]
fn a_fully_gated_round_drops_from_the_trace() {
    let mut h = Harness::new();
    h.seed_result_1();
    let token = Arc::new(CancelToken::new());
    let fired = Arc::new(AtomicBool::new(false));
    {
        let token = Arc::clone(&token);
        let fired = Arc::clone(&fired);
        h.phase_hook = Some(Arc::new(move |phase: &TurnPhase| {
            if matches!(phase, TurnPhase::Thinking { .. }) && !fired.swap(true, Ordering::SeqCst) {
                token.request();
            }
        }));
    }
    let model = MockCompletionModel::from_stream_turns([batch_turn(
        "",
        Some(""),
        &[(
            "tu_1",
            "explore",
            json!({"sql": "SELECT count(*) FROM result_1"}),
        )],
    )]);
    let outcome = h.run_with_caps(
        &h.request("gate the batch before the first dispatch"),
        mock_runtime(model),
        token,
        24,
        None,
    );
    assert_eq!(outcome.termination, Termination::Cancelled);
    assert!(
        outcome.trace.is_empty(),
        "the fully-gated round drops: {:?}",
        outcome.trace
    );
}

/// An executed call interrupted by the cancel still accounts (issue #921):
/// the token fires at the first call's completion phase and the hook then
/// HOLDS the dispatch rail open past the watcher's 25ms poll, so the
/// driver's select race is guaranteed to abandon the silent wait with the
/// call's reply still unsent -- the window where the old adapter's
/// post-`spawn_blocking` recording segment was never polled and the trace
/// row vanished. The executed call's trace entry must still land, through
/// the dispatch-side record-before-send and the finish-time drain of the
/// queue the abandoned stream left behind. The call is a materialize so
/// the recording site's promotion half rides the same window: a revert
/// of the promotion push back into the callback's abandoned segment
/// would drop it with no other pin noticing.
#[test]
fn cancelled_in_flight_call_still_lands_its_trace() {
    let mut h = Harness::new();
    h.seed_result_1();
    let token = Arc::new(CancelToken::new());
    let fired = Arc::new(AtomicBool::new(false));
    {
        let token = Arc::clone(&token);
        let fired = Arc::clone(&fired);
        h.phase_hook = Some(Arc::new(move |phase: &TurnPhase| {
            if matches!(phase, TurnPhase::ToolCallCompleted(_))
                && !fired.swap(true, Ordering::SeqCst)
            {
                token.request();
                // Hold the completed call's reply unsent: the watcher
                // thread (25ms poll) resolves the driver's select on the
                // notification while the stream still waits for this
                // call's result -- deterministic, not a race the
                // assertion hopes to lose.
                std::thread::sleep(Duration::from_millis(120));
            }
        }));
    }
    let model = MockCompletionModel::from_stream_turns([batch_turn(
        "",
        None,
        &[(
            "tu_1",
            "materialize",
            json!({"sql": "SELECT count(*) AS n FROM result_1"}),
        )],
    )]);
    let outcome = h.run_with_caps(
        &h.request("cancel my single call"),
        mock_runtime(model),
        token,
        24,
        None,
    );
    assert_eq!(outcome.termination, Termination::Cancelled);
    assert_eq!(
        outcome.trace.len(),
        1,
        "the round survives the interruption"
    );
    assert_eq!(
        outcome.trace[0].calls.len(),
        1,
        "the executed call's trace row lands despite the abandoned stream"
    );
    assert_eq!(outcome.trace[0].calls[0].name, "materialize");
    assert!(outcome.trace[0].calls[0].success);
    assert_eq!(
        outcome.promotions.len(),
        1,
        "the interrupted materialize's promotion lands despite the abandoned stream"
    );
}

/// A driver-thread panic after a call's result event has folded lands the
/// honest Transient termination (issue #321) without tripping the
/// finish-time exactly-once pairing: the join arm replaces the fold the
/// dead driver had been consuming (its landed calls go with it), while
/// `recorded_calls` survives on the shared state -- the pairing is
/// exempted for the replaced fold, and the drain still salvages whatever
/// the dead stream left queued. The panic rides the phase hook at the
/// second turn's `Thinking` (a DRIVER-side phase, folded on the driver
/// thread -- unlike `ToolCallCompleted`, which the dispatch server emits
/// and whose panics the #321 dispatch guard catches, a path its own pin
/// already covers); the first turn's call has already folded by then,
/// which is what makes the pre-fix assert's arithmetic diverge (0 landed
/// vs 1 recorded).
#[test]
fn driver_panic_after_a_folded_call_lands_transient_cleanly() {
    let mut h = Harness::new();
    h.seed_result_1();
    let fired = Arc::new(AtomicBool::new(false));
    h.phase_hook = Some(Arc::new(move |phase: &TurnPhase| {
        if matches!(phase, TurnPhase::Thinking { attempt: 2.. })
            && !fired.swap(true, Ordering::SeqCst)
        {
            panic!("injected driver failure after the call folded");
        }
    }));
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
        text_turn("late prose that never lands"),
    ]);
    let outcome = h.run_with_caps(
        &h.request("fold one call then die"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
        24,
        None,
    );
    assert!(
        matches!(outcome.termination, Termination::Transient(_)),
        "the driver panic lands the honest Transient, not a crash: {:?}",
        outcome.termination
    );
}

/// The no-progress watchdog's kill (ADR-0115): a generation that goes
/// silent past the cap lands `NoProgress` with the armed cap -- the
/// cancelled-vs-timed-out fork of the same cancel landing. The measured
/// silence must cover the cap (the `NoProgressDetail` contract: "at least
/// the cap") -- the measurement half this pin shares with its retired
/// yoagent original (issue #928).
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
            assert!(
                detail.silence >= detail.cap,
                "the measured silence covers the cap: {detail:?}"
            );
        }
        other => panic!("expected NoProgress, got {other:?}"),
    }
}

/// The freeze (ADR-0115): an approval pending past the cap does NOT kill
/// the turn -- the loop freezes the progress clock across the dispatch
/// (an approval pending on the condvar is a wait on an external
/// principal), and the turn resumes when the responder answers: the Deny
/// feeds back as a tool-level error, the loop self-corrects, the terminal
/// text lands. Ported from the retired yoagent suites (issue #928): the
/// behavior lives in the shared dispatch core, the pin lives here.
#[test]
fn approval_pending_survives_past_the_cap() {
    use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
    let mut h = Harness::new();
    let cli_tool = CliToolConfig {
        name: "pandoc".into(),
        description: "convert".into(),
        executable: "/bin/pandoc".into(),
        argv_template: vec!["-o".into(), "{output}".into()],
        params: vec![CliToolParam {
            name: "output".into(),
            description: "target".into(),
            delivery: CliParamDelivery::Argv,
            varargs: false,
        }],
        env: Default::default(),
        enabled: true,
        source: Default::default(),
        baseline: None,
    };
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "",
            None,
            &[("tu_1", "pandoc", json!({"output": "out.pdf"}))],
        ),
        text_turn("denied, moving on."),
    ]);
    // The gate waits on the shared approval state while the responder
    // parks PAST the cap, then drives the Deny -- if the freeze were
    // missing, the no-progress clock would kill the turn mid-pending.
    let approval = Arc::new(ApprovalState::new());
    let sink = Arc::new(RecordingSink::default());
    let responder = {
        let approval = Arc::clone(&approval);
        let sink = Arc::clone(&sink);
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                if let Some(id) = sink.request_ids.lock().unwrap().first().copied() {
                    // Park past the 100 ms cap before answering.
                    std::thread::sleep(Duration::from_millis(300));
                    approval
                        .respond(id, ApprovalResponse::Deny)
                        .expect("respond ok");
                    return;
                }
                if start.elapsed() > Duration::from_secs(5) {
                    panic!("no approval request arrived");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    let outcome = h.run_turn(
        &h.request_with_tools("call pandoc", &["pandoc"]),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
        24,
        Some(Duration::from_millis(100)),
        std::slice::from_ref(&cli_tool),
        approval.as_ref(),
        sink.as_ref(),
    );
    responder.join().unwrap();
    assert_eq!(
        outcome.termination,
        Termination::Text("denied, moving on.".into()),
        "the turn must survive a pending approval past the cap"
    );
    assert_eq!(
        outcome.trace.len(),
        1,
        "the denied call leaves exactly its resolved-deny row"
    );
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

/// The layer's own history conversion -- the ADR-0116 diagnostic-probe
/// contract at its source. The runtime suites' harness requests start
/// fresh conversations, so rig-assembled histories never exercise this
/// conversion; this pin drives it directly. Consecutive tool results from
/// one assistant batch merge into ONE rig user message, never split across
/// user turns -- the wire shape whose absence was the
/// >=2-tool-calls 400 fault (a split here is exactly that fault's return).
#[test]
fn to_rig_history_merges_batch_results_into_one_user_message() {
    use crate::provider::tool_calling::ThinkingBlock;
    use crate::session::loop_runtime::model::to_rig_history;
    let messages = vec![
        ToolTurnMessage::user("first question"),
        ToolTurnMessage::Assistant {
            text: None,
            tool_calls: vec![
                crate::provider::tool_calling::ToolUse {
                    id: "tu_1".into(),
                    name: "explore".into(),
                    input: json!({"sql": "SELECT 1 AS a"}),
                },
                crate::provider::tool_calling::ToolUse {
                    id: "tu_2".into(),
                    name: "explore".into(),
                    input: json!({"sql": "SELECT 2 AS b"}),
                },
            ],
            thinking: vec![ThinkingBlock::Thinking {
                thinking: "plan".into(),
                signature: "sig".into(),
            }],
        },
        ToolTurnMessage::ToolResult {
            tool_use_id: "tu_1".into(),
            content: "one".into(),
            is_error: false,
        },
        ToolTurnMessage::ToolResult {
            tool_use_id: "tu_2".into(),
            content: "two".into(),
            is_error: false,
        },
        ToolTurnMessage::user("next question"),
    ];
    let history = to_rig_history(&messages);
    // [User, Assistant(thinking + 2 calls), User(merged results), User]:
    // the two results ride exactly one user message between the batch and
    // the next question.
    let user_messages: Vec<&Vec<UserContent>> = history
        .iter()
        .filter_map(|m| match m {
            Message::User { content } => Some(content),
            _ => None,
        })
        .collect();
    assert_eq!(
        user_messages.len(),
        3,
        "three user turns: question, merged results, next question"
    );
    let result_blocks = user_messages[1]
        .iter()
        .filter(|b| matches!(b, UserContent::ToolResult(_)))
        .count();
    assert_eq!(
        result_blocks, 2,
        "both batch results ride ONE user message, never split"
    );
}

/// The empty-string-to-absent signature boundary the shared
/// thinking_to_reasoning helper exists to enforce, driven directly in the
/// history direction: a paired signature rides through as Some, an empty
/// signature converts to absent (never Some("")), and redacted data
/// passes through verbatim. The helper being shared, the same shape
/// governs the outcome direction; the reverse round-trip pin below
/// covers the opposite conversion without routing through the helper.
#[test]
fn to_rig_history_maps_empty_signature_to_absent_and_keeps_signed() {
    use crate::provider::tool_calling::ThinkingBlock;
    use crate::session::loop_runtime::model::to_rig_history;
    use rig_core::message::{AssistantContent, Reasoning, ReasoningContent};

    let messages = vec![ToolTurnMessage::Assistant {
        text: None,
        tool_calls: vec![],
        thinking: vec![
            ThinkingBlock::Thinking {
                thinking: "signed".into(),
                signature: "sig".into(),
            },
            ThinkingBlock::Thinking {
                thinking: "unsigned".into(),
                signature: String::new(),
            },
            ThinkingBlock::Redacted {
                data: "opaque".into(),
            },
        ],
    }];
    let history = to_rig_history(&messages);
    let Message::Assistant { content, .. } = &history[0] else {
        panic!("the assistant turn converts to one rig assistant message");
    };
    let reasoning: Vec<&Reasoning> = content
        .iter()
        .filter_map(|c| match c {
            AssistantContent::Reasoning(r) => Some(r),
            _ => None,
        })
        .collect();
    assert_eq!(reasoning.len(), 3, "one reasoning entry per thinking block");
    assert!(
        matches!(
            &reasoning[0].content[..],
            [ReasoningContent::Text { text, signature }]
                if text == "signed" && signature == &Some("sig".to_string())
        ),
        "a paired signature rides through: {:?}",
        reasoning[0]
    );
    assert!(
        matches!(
            &reasoning[1].content[..],
            [ReasoningContent::Text { text, signature }]
                if text == "unsigned" && signature.is_none()
        ),
        "an empty signature becomes absent, never Some(empty): {:?}",
        reasoning[1]
    );
    assert!(
        matches!(
            &reasoning[2].content[..],
            [ReasoningContent::Redacted { data }] if data == "opaque"
        ),
        "redacted data passes through verbatim: {:?}",
        reasoning[2]
    );
}

/// The bridge's reverse conversion, which the harness never drives past a
/// turn-one fault: a rig assistant turn carrying thinking blocks converts
/// back onto the app vocabulary with the blocks intact, signatures
/// round-tripping through the empty-string-to-absent boundary.
#[test]
fn to_app_messages_round_trips_thinking_blocks() {
    use crate::provider::tool_calling::ThinkingBlock;
    use crate::session::loop_runtime::model::to_app_messages;
    use rig_core::message::{AssistantContent, Reasoning, ReasoningContent};
    let history = vec![Message::Assistant {
        id: None,
        content: vec![
            AssistantContent::Reasoning(Reasoning::new_with_signature(
                "signed",
                Some("sig".to_string()),
            )),
            AssistantContent::Reasoning(Reasoning::new_with_signature("unsigned", None)),
            AssistantContent::Reasoning(Reasoning {
                id: None,
                content: vec![ReasoningContent::Redacted {
                    data: "opaque".into(),
                }],
            }),
            AssistantContent::text("prose"),
        ],
    }];
    let converted = to_app_messages(&history);
    let ToolTurnMessage::Assistant { text, thinking, .. } = &converted[0] else {
        panic!("the assistant turn converts to the app assistant shape");
    };
    assert_eq!(text.as_deref(), Some("prose"));
    assert_eq!(
        thinking,
        &vec![
            ThinkingBlock::Thinking {
                thinking: "signed".into(),
                signature: "sig".into(),
            },
            ThinkingBlock::Thinking {
                thinking: "unsigned".into(),
                signature: String::new(),
            },
            ThinkingBlock::Redacted {
                data: "opaque".into(),
            },
        ],
        "absent signatures land as empty strings, redacted blocks stay redacted"
    );
}

// ---------------------------------------------------------------------------
// Named delegation (issue #933, ADR-0117): the mock model's script queue is
// SHARED between the main loop and every sub-agent (one ModelHandle, one
// Arc'd state), so the scripts below read in global consumption order --
// the main turn's calls, then each delegated sub-agent's turns as the
// sequential executor reaches them, then the main loop's continuation.
// ---------------------------------------------------------------------------

/// The fixture spec: one enabled definition named `analyst`, unbound.
fn analyst_spec() -> crate::agents::DelegationSpec {
    crate::agents::DelegationSpec {
        name: "analyst".to_string(),
        description: "Open-ended analysis delegate.".to_string(),
        preamble: "You are a focused analyst.".to_string(),
        skill_injections: Vec::new(),
    }
}

/// A main-loop turn whose tool table also advertises the harness's seeded
/// delegation specs (the direct-list the session assembly performs).
fn delegation_request(h: &Harness, question: &str) -> ToolTurnRequest {
    let mut request = h.request(question);
    for spec in &h.delegations {
        request.tools.push(spec.tool_definition());
    }
    request
}

/// The happy delegation path plus the AC #5 numbering pin: the main model
/// delegates, the sub-agent runs over the SHARED face (its materialize
/// dispatches through the same server), reports back, and the main loop's
/// own later materialize continues the SAME monotonic `result_N` sequence
/// -- result_2 inside the sub-agent, result_3 after it, one numberer, one
/// promotion list, in dispatch order.
#[test]
fn delegation_runs_a_subagent_over_the_shared_face_with_one_numberer() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "delegate the count",
            None,
            &[(
                "tu_d1",
                "analyst",
                json!({"prompt": "count the rows and materialize the count"}),
            )],
        ),
        // The sub-agent turns, consumed while the delegation callback runs.
        batch_turn(
            "sub: materialize",
            None,
            &[(
                "tu_s1",
                "materialize",
                json!({"sql": "SELECT count(*) AS n FROM result_1"}),
            )],
        ),
        text_turn("sub promoted result_2"),
        // The main loop resumes after the delegation returned.
        batch_turn(
            "main: materialize too",
            None,
            &[(
                "tu_m1",
                "materialize",
                json!({"sql": "SELECT count(*) AS n FROM result_1"}),
            )],
        ),
        text_turn("done with result_3"),
    ]);
    let outcome = h.run(
        &delegation_request(&h, "count and materialize"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("done with result_3".into())
    );
    // One numberer: the sub-agent promotion landed first (result_2), the
    // main loop continues after it (result_3) -- monotonic across the
    // delegation boundary, in dispatch order.
    let promoted: Vec<&str> = outcome
        .promotions
        .iter()
        .map(|p| p.dataset.reference_name.as_str())
        .collect();
    assert_eq!(promoted, vec!["result_2", "result_3"]);
    // The main trace carries the delegation as ONE call row on its round;
    // the sub-agent's rounds hang under it as the NESTED sub-trace
    // (ADR-0117 Decision 6, issue #934), never as additional flat rows.
    assert_eq!(outcome.trace.len(), 2, "main rounds only");
    let round1 = &outcome.trace[0];
    assert_eq!(round1.calls.len(), 1);
    assert_eq!(round1.calls[0].name, "analyst");
    assert!(round1.calls[0].success, "the delegation reported back");
    assert!(
        round1.calls[0]
            .result_excerpt
            .contains("sub promoted result_2"),
        "the report rides the excerpt: {}",
        round1.calls[0].result_excerpt
    );
    // The nested sub-trace: the sub-agent's tool-bearing round with its
    // executed materialize (the result_2 promotion) under the entry.
    let sub = round1.calls[0]
        .sub_trace
        .as_ref()
        .expect("the sub-trace hangs under the delegation entry");
    assert_eq!(sub.len(), 1, "one sub round (the tool-bearing turn)");
    assert_eq!(sub[0].calls.len(), 1);
    assert_eq!(sub[0].calls[0].name, "materialize");
    assert!(sub[0].calls[0].success, "the sub-agent's call succeeded");
    assert_eq!(outcome.trace[1].calls[0].name, "materialize");

    // Live card <-> persisted row are same-source (PR #944 review Advisory
    // G): every call the rail saw as a completed card also lands in the
    // record -- the sub-agent's materialize under the delegation entry, the
    // delegation itself, then the main loop's own. No ghost row runs on the
    // live rail and vanishes from the trace.
    let completed_names: Vec<String> = h
        .phases
        .lock()
        .unwrap()
        .iter()
        .filter_map(|p| match p {
            TurnPhase::ToolCallCompleted(view) => Some(view.name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        completed_names,
        vec!["materialize", "analyst", "materialize"],
        "the sub-agent's card completed first, then the delegation, then the main loop's own"
    );
}

/// AC #3: the same-batch width cap. One model turn carries nine delegation
/// calls; under the pinned sequential execution the first eight run (each
/// consuming its sub-agent script) and the ninth is REFUSED with an
/// explicit text naming the cap -- the row lands failed, the turn itself
/// stays healthy, and the main model reads the refusal and continues.
#[test]
fn the_ninth_delegation_of_one_batch_is_refused_with_an_explicit_text() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let mut calls = Vec::new();
    for n in 1..=9usize {
        calls.push((
            format!("tu_d_{n}"),
            "analyst",
            json!({ "prompt": format!("task number {n}") }),
        ));
    }
    let borrowable: Vec<(&str, &str, JsonValue)> = calls
        .iter()
        .map(|(id, name, args)| (id.as_str(), *name, args.clone()))
        .collect();
    let mut script = vec![batch_turn("delegate nine", None, &borrowable)];
    for n in 1..=8 {
        script.push(text_turn(&format!("sub report {n}")));
    }
    script.push(text_turn("carried on after the refusals"));
    let model = MockCompletionModel::from_stream_turns(script);
    let outcome = h.run(
        &delegation_request(&h, "nine delegations"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("carried on after the refusals".into()),
        "the refusal is a tool result, never a turn failure"
    );
    let round1 = &outcome.trace[0];
    assert_eq!(round1.calls.len(), 9, "every call keeps its honest row");
    let succeeded = round1.calls.iter().filter(|c| c.success).count();
    assert_eq!(succeeded, 8, "the first eight delegations ran");
    let ninth = &round1.calls[8];
    assert!(!ninth.success, "the ninth is refused");
    assert!(
        ninth.result_excerpt.contains("delegation refused"),
        "the refusal names itself: {}",
        ninth.result_excerpt
    );
    assert!(
        ninth.result_excerpt.contains("8"),
        "the refusal names the cap: {}",
        ninth.result_excerpt
    );
}

/// AC #4: a sub-agent that burns its whole step budget feeds an honest
/// failure TEXT back through the tool result -- the main turn keeps
/// running and converges afterwards; the failed delegation row carries
/// the budget wording. (The sub-agent repeated calls use DISTINCT
/// arguments so the dispatch seam identical-arguments screen stays out of
/// the picture -- this pin owns the step-cap path.) The sub-agent's first
/// round MATERIALIZES before the burn, so the pin also carries the orphan
/// note (PR #944 review Advisory G): the promotion entered the shared
/// working set with no visible producer in the report -- the failure text
/// names it -- and the burned rounds persist under the entry.
#[test]
fn a_subagent_step_cap_failure_feeds_back_without_escalating_the_turn() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let mut script = vec![batch_turn(
        "delegate",
        None,
        &[(
            "tu_d1",
            "analyst",
            json!({"prompt": "materialize then explore forever"}),
        )],
    )];
    script.push(batch_turn(
        "sub round 1",
        None,
        &[(
            "tu_s1",
            "materialize",
            json!({"sql": "SELECT count(*) AS n FROM result_1"}),
        )],
    ));
    for n in 2..=10usize {
        script.push(batch_turn(
            &format!("sub round {n}"),
            None,
            &[("tu_s", "explore", json!({ "sql": format!("SELECT {n}") }))],
        ));
    }
    script.push(text_turn("recovered after the sub-agent failed"));
    let model = MockCompletionModel::from_stream_turns(script);
    let outcome = h.run(
        &delegation_request(&h, "delegate then recover"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("recovered after the sub-agent failed".into()),
        "the sub-agent cap is a tool-level failure, never the turn own"
    );
    assert_eq!(
        outcome.trace.len(),
        1,
        "the delegation round alone: the terminal text turn opens no round"
    );
    let row = &outcome.trace[0].calls[0];
    assert_eq!(row.name, "analyst");
    assert!(!row.success, "the budget exhaustion is a failed row");
    assert!(
        row.result_excerpt.contains("did not converge"),
        "the failure words the budget: {}",
        row.result_excerpt
    );
    assert!(
        row.result_excerpt
            .contains("promoted before dying: result_2"),
        "the orphan note names the promotion that outlived the run: {}",
        row.result_excerpt
    );
    // The burned rounds persist under the failed entry: the sub-agent's
    // whole trajectory (the materialize + the explores) stays answerable.
    let sub = row
        .sub_trace
        .as_ref()
        .expect("the burned rounds hang under the failed delegation entry");
    assert_eq!(sub.len(), 10, "one round per burned step");
    assert_eq!(sub[0].calls[0].name, "materialize");
}

/// AC #6: cancellation forwarded into a running sub-agent lands the WHOLE
/// turn Cancelled. The token fires during the sub-agent first generation
/// (the bridged provider second call overall); the sub-agent next dispatch
/// is gate-cancelled, its watcher hook stops it at the following
/// model-call checkpoint, and the main loop own checkpoint lands the
/// ADR-0021 cancel -- the delegation machinery adds no second cancel
/// vocabulary.
#[test]
fn a_cancel_during_the_subagent_lands_the_whole_turn_cancelled() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let token = Arc::new(CancelToken::new());
    let provider = BlockingProvider::new(vec![
        Ok(ToolTurnOutcome {
            thinking: Vec::new(),
            reply: ToolTurnReply::ToolCalls {
                text: None,
                calls: vec![crate::provider::tool_calling::ToolUse {
                    id: "tu_d1".into(),
                    name: "analyst".into(),
                    input: json!({"prompt": "explore the data"}),
                }],
            },
        }),
        // The sub-agent first turn asks for a real dispatch; the token
        // fires while this generation is in flight.
        Ok(ToolTurnOutcome {
            thinking: Vec::new(),
            reply: ToolTurnReply::ToolCalls {
                text: None,
                calls: vec![crate::provider::tool_calling::ToolUse {
                    id: "tu_s1".into(),
                    name: "explore".into(),
                    input: json!({"sql": "SELECT count(*) FROM result_1"}),
                }],
            },
        }),
    ])
    .with_fire_cancel_on(2, Arc::clone(&token));
    let outcome = h.run(
        &delegation_request(&h, "delegate then cancel"),
        bridged_runtime(Arc::new(provider) as Arc<dyn Provider>),
        token,
    );
    assert_eq!(outcome.termination, Termination::Cancelled);
    // The checkpoint-path landing (PR #946 review Important 3): the token
    // fires mid-generation, the sub-agent's own watcher aborts its in-flight
    // request, and the run RETURNS through the checkpoint exit -- the
    // normal collection then lands the cancelled entry (the aborted
    // vocabulary, no sub-trace: nothing completed). The Drop-guard arm --
    // the driver abandoning the future outright -- is the next test.
    let row = outcome
        .trace
        .iter()
        .flat_map(|round| &round.calls)
        .find(|call| call.name == "analyst")
        .expect("the cancelled delegation still lands its trace row");
    assert!(!row.success);
    assert!(
        row.result_excerpt.contains("aborted: cancelled"),
        "the cancelled collection words itself as an abort: {}",
        row.result_excerpt
    );
}

/// The abandonment guard's Drop arm (PR #946 review Important 3): a cancel
/// that lands while the sub-agent is parked on a GATED call's result -- no
/// generation in flight for its own watcher to abort -- is the one window
/// where the driver's notify wins the race and DROPS the delegation's
/// future tree mid-run. The guard then collects and lands the cancelled
/// entry itself: the completed first round (a real explore over result_1)
/// rides under it as the nested sub-trace, instead of vanishing with the
/// dropped future while the trace loses the row entirely. The gated card
/// never resolves -- the cancel is the user's answer to it.
#[test]
fn an_abandoned_delegation_keeps_its_completed_calls_under_the_entry() {
    use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let cli_tool = CliToolConfig {
        name: "pandoc".into(),
        description: "convert".into(),
        executable: "/bin/pandoc".into(),
        argv_template: vec!["-o".into(), "{output}".into()],
        params: vec![CliToolParam {
            name: "output".into(),
            description: "target".into(),
            delivery: CliParamDelivery::Argv,
            varargs: false,
        }],
        env: Default::default(),
        enabled: true,
        source: Default::default(),
        baseline: None,
    };
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "",
            None,
            &[(
                "tu_d1",
                "analyst",
                json!({"prompt": "explore then convert"}),
            )],
        ),
        // The sub-agent's first round: a real dispatch that completes (its
        // entry pairs with the fold's result event).
        batch_turn(
            "",
            None,
            &[(
                "tu_s1",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            )],
        ),
        // The sub-agent's second round: the GATED tool -- the dispatch
        // parks on the approval condvar and the sub parks on its result,
        // which is where the cancel below abandons the run.
        batch_turn(
            "",
            None,
            &[("tu_s2", "pandoc", json!({"output": "out.pdf"}))],
        ),
    ]);
    let approval = Arc::new(ApprovalState::new());
    let sink = Arc::new(RecordingSink::default());
    let token = Arc::new(CancelToken::new());
    // The user's stop: request the token shortly after the gated card
    // appears. The sub is parked on the gated call's result with no
    // generation in flight, so its own watcher has no checkpoint to abort
    // -- the driver's notify wins and drops the delegation future
    // mid-run, deterministically (mutation-verified: disarming the guard
    // reddens this pin).
    let stopper = {
        let sink = Arc::clone(&sink);
        let token = Arc::clone(&token);
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                if !sink.request_ids.lock().unwrap().is_empty() {
                    std::thread::sleep(Duration::from_millis(100));
                    token.request();
                    return;
                }
                if start.elapsed() > Duration::from_secs(5) {
                    panic!("no approval card arrived");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    let mut request = delegation_request(&h, "delegate then stop mid-approval");
    request.tools.push(ToolDefinition {
        name: "pandoc".into(),
        description: "test-external tool".into(),
        input_schema: json!({"type": "object"}),
    });
    let outcome = h.run_turn(
        &request,
        mock_runtime(model),
        Arc::clone(&token),
        24,
        None,
        std::slice::from_ref(&cli_tool),
        approval.as_ref(),
        sink.as_ref(),
    );
    stopper.join().unwrap();
    assert_eq!(outcome.termination, Termination::Cancelled);
    let row = outcome
        .trace
        .iter()
        .flat_map(|round| &round.calls)
        .find(|call| call.name == "analyst")
        .expect("the abandoned delegation still lands its trace row");
    assert!(!row.success);
    assert!(
        row.result_excerpt.contains("aborted: cancelled"),
        "the abandoned collection words itself as an abort: {}",
        row.result_excerpt
    );
    let sub = row
        .sub_trace
        .as_ref()
        .expect("the completed first round rides the cancelled entry");
    assert!(
        sub.iter()
            .any(|round| round.calls.iter().any(|c| c.name == "explore")),
        "the sub-agent's completed explore stays under the entry"
    );
}

/// The approval-origin wiring pin (issue #934, PR #946 review Important 1):
/// a sub-agent's gated call carries its delegator's name onto the approval
/// card END TO END -- the sub-face's dispatch names the sub-agent, the
/// shared dispatch core threads it onto the request, and the emitted card
/// body reads it (the frontend renders "Sub-agent X wants to call Y" from
/// this wire field). A main-loop call in the SAME turn carries no origin
/// (the None half), so the pin covers both arms of the wiring. The gated
/// tool is a CLI tool the harness cannot actually run -- the responder
/// allows, the spawn fails as a route error, and the models converge on
/// their scripted next turns; only the cards are under test.
#[test]
fn subagent_gated_calls_carry_their_originator_onto_the_card() {
    use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
    let mut h = Harness::new();
    h.delegations = vec![analyst_spec()];
    let cli_tool = CliToolConfig {
        name: "pandoc".into(),
        description: "convert".into(),
        executable: "/bin/pandoc".into(),
        argv_template: vec!["-o".into(), "{output}".into()],
        params: vec![CliToolParam {
            name: "output".into(),
            description: "target".into(),
            delivery: CliParamDelivery::Argv,
            varargs: false,
        }],
        env: Default::default(),
        enabled: true,
        source: Default::default(),
        baseline: None,
    };
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "",
            None,
            &[("tu_d1", "analyst", json!({"prompt": "convert the sheet"}))],
        ),
        // The sub-agent's first turn calls the GATED tool -- its card is
        // the pin's subject.
        batch_turn(
            "",
            None,
            &[("tu_s1", "pandoc", json!({"output": "sub.pdf"}))],
        ),
        text_turn("converted under delegation."),
        // The main loop then calls the same gated tool itself -- its card
        // must carry NO originator.
        batch_turn(
            "",
            None,
            &[("tu_2", "pandoc", json!({"output": "main.pdf"}))],
        ),
        text_turn("done both ways."),
    ]);
    let approval = Arc::new(ApprovalState::new());
    let sink = Arc::new(RecordingSink::default());
    let responder = {
        let approval = Arc::clone(&approval);
        let sink = Arc::clone(&sink);
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            let mut answered = 0;
            while answered < 2 {
                let ids = sink.request_ids.lock().unwrap().clone();
                if ids.len() > answered {
                    approval
                        .respond(ids[answered], ApprovalResponse::AllowOnce)
                        .expect("respond ok");
                    answered += 1;
                    continue;
                }
                if start.elapsed() > Duration::from_secs(5) {
                    panic!("only {answered} approval requests arrived");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    // The request must advertise the CLI tool alongside the delegation
    // spec, so the subtracted sub-face carries it (the model-facing table
    // and the CLI config are the two halves of a gated external call).
    let mut request = delegation_request(&h, "delegate a conversion");
    request.tools.push(ToolDefinition {
        name: "pandoc".into(),
        description: "test-external tool".into(),
        input_schema: json!({"type": "object"}),
    });
    let outcome = h.run_turn(
        &request,
        mock_runtime(model),
        Arc::new(CancelToken::new()),
        24,
        None,
        std::slice::from_ref(&cli_tool),
        approval.as_ref(),
        sink.as_ref(),
    );
    responder.join().unwrap();
    assert_eq!(
        outcome.termination,
        Termination::Text("done both ways.".into()),
        "both gated calls feed back and the turn converges"
    );
    let origins = sink.origins.lock().unwrap().clone();
    assert_eq!(
        origins,
        vec![Some("analyst".to_string()), None],
        "the sub-agent's card names its delegator; the main loop's carries none"
    );
}

/// AC #4 (the provider-fault arm): a sub-agent whose model call faults
/// feeds the honest failure text back through the tool result -- the main
/// turn stays healthy and converges on its own next reply. The bridged
/// provider scripts the sub-agent first generation to fail outright.
#[test]
fn a_subagent_provider_fault_feeds_back_without_escalating_the_turn() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let provider = BlockingProvider::new(vec![
        Ok(ToolTurnOutcome {
            thinking: Vec::new(),
            reply: ToolTurnReply::ToolCalls {
                text: None,
                calls: vec![crate::provider::tool_calling::ToolUse {
                    id: "tu_d1".into(),
                    name: "analyst".into(),
                    input: json!({"prompt": "try to explore"}),
                }],
            },
        }),
        // The sub-agent first generation faults (the provider-error arm of
        // the failure vocabulary).
        Err(ProviderError::Unavailable("provider exploded".into())),
        Ok(ToolTurnOutcome {
            thinking: Vec::new(),
            reply: ToolTurnReply::Text("recovered after the provider fault".into()),
        }),
    ]);
    let outcome = h.run(
        &delegation_request(&h, "delegate then survive"),
        bridged_runtime(Arc::new(provider) as Arc<dyn Provider>),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("recovered after the provider fault".into()),
        "the provider fault inside the sub-agent is a tool-level failure"
    );
    let row = &outcome.trace[0].calls[0];
    assert_eq!(row.name, "analyst");
    assert!(!row.success);
    assert!(
        row.result_excerpt.contains("sub-agent failed"),
        "the failure words itself: {}",
        row.result_excerpt
    );
}

/// Review Critical 1 (#944): a mixed batch with a gateway call BEFORE the
/// delegation call must keep every main-trace row's identity. The shared
/// completion queue was one blind FIFO across two consumer families, so the
/// sub-agent's fold stole the earlier sibling's queued entry (rig surfaces
/// a batch's results only after the whole batch settles): the main agent's
/// materialize row vanished and the row carried the sub-agent's entry
/// instead, with the count pairing balanced and nothing logged. This pin
/// owns the observable contract row by row: each row's summary carries its
/// own call's SQL, and the promotions keep their dispatch order.
#[test]
fn a_mixed_batch_keeps_every_main_row_identity() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "gateway call before the delegation",
            None,
            &[
                (
                    "tu_a1",
                    "materialize",
                    json!({"sql": "SELECT count(*) AS main_count FROM result_1"}),
                ),
                (
                    "tu_d1",
                    "analyst",
                    json!({"prompt": "count and materialize the count"}),
                ),
            ],
        ),
        // The sub-agent's own materialize, consumed inside the delegation
        // callback (its entry must land on the DISCARDED local sub fold,
        // never on the main trace's gateway row).
        batch_turn(
            "sub: materialize",
            None,
            &[(
                "tu_s1",
                "materialize",
                json!({"sql": "SELECT count(*) AS sub_count FROM result_1"}),
            )],
        ),
        text_turn("sub reported"),
        // The main loop's own second materialize, after the delegation.
        batch_turn(
            "main: materialize again",
            None,
            &[(
                "tu_a2",
                "materialize",
                json!({"sql": "SELECT count(*) AS main2_count FROM result_1"}),
            )],
        ),
        text_turn("done"),
    ]);
    let outcome = h.run(
        &delegation_request(&h, "mix then delegate"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(outcome.termination, Termination::Text("done".into()));
    // Row identity: the gateway row keeps its OWN SQL on its own row.
    let round1 = &outcome.trace[0];
    assert_eq!(round1.calls.len(), 2);
    assert_eq!(round1.calls[0].name, "materialize");
    assert!(
        round1.calls[0].summary.contains("main_count"),
        "the gateway row carries the main agent's SQL: {}",
        round1.calls[0].summary
    );
    assert!(
        !round1.calls[0].summary.contains("sub_count"),
        "the sub-agent's SQL must not reach the gateway row: {}",
        round1.calls[0].summary
    );
    assert_eq!(round1.calls[1].name, "analyst");
    assert!(round1.calls[1].success);
    assert!(
        round1.calls[1].result_excerpt.contains("sub reported"),
        "the delegation row carries the report: {}",
        round1.calls[1].result_excerpt
    );
    let round2 = &outcome.trace[1];
    assert_eq!(round2.calls.len(), 1);
    assert_eq!(round2.calls[0].name, "materialize");
    assert!(
        round2.calls[0].summary.contains("main2_count"),
        "the post-delegation row carries its own SQL: {}",
        round2.calls[0].summary
    );
    // Promotions keep the dispatch order across the delegation boundary:
    // the main batch's first call promoted before the sub-agent's.
    let promoted: Vec<String> = outcome
        .promotions
        .iter()
        .map(|p| p.dataset.reference_name.clone())
        .collect();
    assert_eq!(promoted, vec!["result_2", "result_3", "result_4"]);
}

/// Review Important 2 (#944): the batch cap scopes to one model turn's
/// batch, never to the total. Two consecutive batches of 8 + 1 delegations
/// all run -- the reset at each turn's usage record is what keeps the 9th
/// of ONE batch the refusal, not the 9th overall (deleting the reset is
/// the mutation this pin kills).
#[test]
fn the_batch_cap_resets_across_model_turns() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    // Turn one: a full batch of eight delegations.
    let mut calls = Vec::new();
    for n in 1..=8usize {
        calls.push((
            format!("tu_d1_{n}"),
            "analyst",
            json!({ "prompt": format!("batch one task {n}") }),
        ));
    }
    let borrowable1: Vec<(&str, &str, JsonValue)> = calls
        .iter()
        .map(|(id, name, args)| (id.as_str(), *name, args.clone()))
        .collect();
    let mut script = vec![batch_turn("eight in batch one", None, &borrowable1)];
    for n in 1..=8 {
        script.push(text_turn(&format!("sub one report {n}")));
    }
    // Turn two: a fresh batch whose own first delegation runs -- the reset
    // made it delegation #1 of ITS batch, not #9 overall.
    script.push(batch_turn(
        "one in batch two",
        None,
        &[("tu_d2_1", "analyst", json!({ "prompt": "batch two task" }))],
    ));
    script.push(text_turn("sub two report"));
    script.push(text_turn("done after two batches"));
    let model = MockCompletionModel::from_stream_turns(script);
    let outcome = h.run(
        &delegation_request(&h, "two batches"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("done after two batches".into()),
        "no refusal anywhere: the cap never spans batches"
    );
    let succeeded: usize = outcome.trace[0].calls.iter().filter(|c| c.success).count();
    assert_eq!(succeeded, 8, "batch one runs all eight");
    assert!(
        outcome.trace[0]
            .calls
            .iter()
            .all(|c| !c.result_excerpt.contains("delegation refused")),
        "batch one never refuses: {:?}",
        outcome.trace[0]
            .calls
            .iter()
            .map(|c| c.result_excerpt.clone())
            .collect::<Vec<_>>()
    );
    let round2 = &outcome.trace[1];
    assert_eq!(round2.calls.len(), 1);
    assert!(round2.calls[0].success, "batch two's first delegation runs");
}

/// Review Advisory A (#944): a delegation call with no prompt parameter is
/// refused up front -- the refusal lands the same failed-row shape the
/// batch cap uses, instead of silently running a sub-agent on an empty
/// task (the schema says required, but providers do not enforce schemas
/// against a misbehaving model).
#[test]
fn a_delegation_without_a_prompt_is_refused_not_run() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "delegate without a prompt",
            None,
            &[(
                "tu_d1",
                "analyst",
                json!({ "task": "not the prompt parameter" }),
            )],
        ),
        text_turn("carried on after the empty-prompt refusal"),
    ]);
    let outcome = h.run(
        &delegation_request(&h, "delegate with no prompt"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("carried on after the empty-prompt refusal".into()),
        "the missing prompt is a tool-level refusal, never a turn failure"
    );
    let row = &outcome.trace[0].calls[0];
    assert_eq!(row.name, "analyst");
    assert!(!row.success, "the refusal lands a failed row");
    assert!(
        row.result_excerpt.contains("no task prompt"),
        "the refusal names itself: {}",
        row.result_excerpt
    );
}

/// Review Advisory C (#944): a sub-agent that promotes before dying leaves
/// the promotion standing on the shared working set (ADR-0117 Decision 5's
/// "stays promoted" clause) -- the failed delegation row is honest about
/// the death, and the promotion survives it.
#[test]
fn a_subagent_that_promotes_then_exhausts_leaves_the_promotion_standing() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let mut script = vec![batch_turn(
        "delegate",
        None,
        &[(
            "tu_d1",
            "analyst",
            json!({"prompt": "materialize then keep exploring"}),
        )],
    )];
    // The sub-agent materializes once, then burns its budget exploring.
    script.push(batch_turn(
        "sub: materialize",
        None,
        &[(
            "tu_s1",
            "materialize",
            json!({"sql": "SELECT count(*) AS sub_count FROM result_1"}),
        )],
    ));
    for n in 1..=10usize {
        script.push(batch_turn(
            &format!("sub round {n}"),
            None,
            &[("tu_s", "explore", json!({ "sql": format!("SELECT {n}") }))],
        ));
    }
    script.push(text_turn("recovered after the sub-agent died"));
    let model = MockCompletionModel::from_stream_turns(script);
    let outcome = h.run(
        &delegation_request(&h, "delegate and lose the sub-agent"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(
        outcome.termination,
        Termination::Text("recovered after the sub-agent died".into()),
        "the sub-agent's budget death is a tool-level failure"
    );
    let row = &outcome.trace[0].calls[0];
    assert_eq!(row.name, "analyst");
    assert!(!row.success, "the budget exhaustion is a failed row");
    assert!(
        row.result_excerpt.contains("did not converge"),
        "the failure words the budget: {}",
        row.result_excerpt
    );
    // The promotion the sub-agent landed before dying stays standing.
    let promoted: Vec<&str> = outcome
        .promotions
        .iter()
        .map(|p| p.dataset.reference_name.as_str())
        .collect();
    assert_eq!(promoted, vec!["result_2"]);
}

/// Review Advisory C (#944): the delegation call fires the live rail's
/// `ToolCallStarted` / `ToolCallCompleted` pair like every dispatched call
/// (the module doc claims the contract; removing the pair survived every
/// committed suite before this pin).
#[test]
fn delegation_fires_the_live_rail_phase_pair() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let seen = Arc::new(std::sync::Mutex::new(Vec::<(bool, String)>::new()));
    {
        let seen = Arc::clone(&seen);
        h.phase_hook = Some(Arc::new(move |phase: &TurnPhase| match phase {
            TurnPhase::ToolCallStarted { name, .. } => {
                seen.lock().unwrap().push((true, name.clone()));
            }
            TurnPhase::ToolCallCompleted(entry) => {
                seen.lock().unwrap().push((false, entry.name.clone()));
            }
            _ => {}
        }));
    }
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "delegate",
            None,
            &[("tu_d1", "analyst", json!({"prompt": "look around"}))],
        ),
        text_turn("sub reported"),
        text_turn("done"),
    ]);
    let outcome = h.run(
        &delegation_request(&h, "delegate once"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert_eq!(outcome.termination, Termination::Text("done".into()));
    let pair: Vec<(bool, String)> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, name)| name == "analyst")
        .cloned()
        .collect();
    assert_eq!(
        pair,
        vec![
            (true, "analyst".to_string()),
            (false, "analyst".to_string())
        ],
        "exactly one started/completed pair fires for the delegation"
    );
}

/// The loop-detection arm the module doc's failure-honesty paragraph now
/// defers to the status-quo paragraph (#944 review Important 3): a
/// sub-agent's repeated identical calls screen through the SHARED
/// dispatch seam's detector -- the first repeat draws the steer text, and
/// a repeat that ignores the nudge aborts the MAIN turn as its budget
/// protection (an honest Transient), not a sub-agent terminal channel.
/// The pin's discrimination: if the shared screen did not reach sub-agent
/// dispatches, the sub-agent would burn its whole budget and the turn
/// would land Text, not Transient.
#[test]
fn a_nudge_ignoring_subagent_aborts_the_main_turn_as_budget_protection() {
    let mut h = Harness::new();
    h.seed_result_1();
    h.delegations = vec![analyst_spec()];
    let model = MockCompletionModel::from_stream_turns([
        batch_turn(
            "delegate",
            None,
            &[(
                "tu_d1",
                "analyst",
                json!({"prompt": "explore forever identically"}),
            )],
        ),
        // Four identical dispatches: the detector's thresholds are
        // dispatch at arrivals 1-2, steer at 3, abort at 4.
        batch_turn(
            "sub: identical call one",
            None,
            &[(
                "tu_s",
                "explore",
                json!({ "sql": "SELECT count(*) AS n FROM result_1" }),
            )],
        ),
        batch_turn(
            "sub: identical call two",
            None,
            &[(
                "tu_s",
                "explore",
                json!({ "sql": "SELECT count(*) AS n FROM result_1" }),
            )],
        ),
        batch_turn(
            "sub: identical call three",
            None,
            &[(
                "tu_s",
                "explore",
                json!({ "sql": "SELECT count(*) AS n FROM result_1" }),
            )],
        ),
        batch_turn(
            "sub: identical call four",
            None,
            &[(
                "tu_s",
                "explore",
                json!({ "sql": "SELECT count(*) AS n FROM result_1" }),
            )],
        ),
    ]);
    let outcome = h.run(
        &delegation_request(&h, "delegate into a loop"),
        mock_runtime(model),
        Arc::new(CancelToken::new()),
    );

    assert!(
        matches!(outcome.termination, Termination::Transient(ref text) if text.contains("loop")),
        "the nudge-ignoring repeat aborts the main turn as budget protection, got: {:?}",
        outcome.termination
    );
}
