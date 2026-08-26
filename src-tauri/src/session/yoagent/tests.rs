//! Offline path pins for the yoagent integration layer (issue #668 item 7):
//! every termination + dispatch path driven by a scripted offline
//! `StreamProvider` -- no network, no key, no `Session`. Mirrors the agent
//! loop's own test posture (scripted trajectory + the real materializer +
//! an in-memory DuckDB engine), asserting the SAME `LoopOutcome` shapes the
//! built-in loop's tests pin, so the trace equivalence the AC demands is
//! enforced against a concrete trajectory rather than asserted in prose.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Value as JsonValue};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use yoagent::provider::{ProviderError, StreamConfig, StreamEvent, StreamProvider};
use yoagent::types::{Content, Message, StopReason, Usage};

use crate::approval::{ApprovalResponse, ApprovalSink, ApprovalState};
use crate::cancel::CancelToken;
use crate::mcp::aggregator::McpAggregator;
use crate::model::{ColumnSchema, DatasetPrivacy, RectifyProvenance};
use crate::model::{DatasetDescriptor, TurnPhase};
use crate::provider::tool_calling::{ToolDefinition, ToolTurnMessage, ToolTurnRequest, ToolUse};
use crate::session::agent_loop::{LoopOutcome, Termination};
use crate::session::engine::AdminEngine;
use crate::session::materializer::RealMaterializer;
use crate::session::yoagent::model_config::{resolve_yoagent_model, ResolvedYoagentModel};
use crate::session::yoagent::YoagentLoop;
use crate::tools::builtin_table;
use crate::tools::test_support::inert_deps_with_temp;
use crate::workingset::WorkingSet;

use std::collections::HashMap;

use tempfile::TempDir;

/// A scripted offline provider (issue #668 AC: no network, no key). Pops one
/// full assistant message per stream call -- the multi-turn trajectory the
/// run exercises. Optional hooks drive the cancel and wall-clock paths:
/// `fire_cancel_on` fires the app token mid-stream (the user-cancel path),
/// and `stream_delay` parks each turn long enough for the watchdog to fire.
/// Every received `StreamConfig`'s message list is captured, so the
/// full-window feed is pinnable.
struct ScriptedProvider {
    script: Mutex<VecDeque<Message>>,
    fire_cancel_on: Option<(usize, Arc<CancelToken>)>,
    stream_delay: Option<Duration>,
    seen_windows: Mutex<Vec<Vec<Message>>>,
}

impl ScriptedProvider {
    fn new(script: Vec<Message>) -> Self {
        Self {
            script: Mutex::new(script.into()),
            fire_cancel_on: None,
            stream_delay: None,
            seen_windows: Mutex::new(Vec::new()),
        }
    }

    fn with_cancel_on(mut self, turn: usize, token: Arc<CancelToken>) -> Self {
        self.fire_cancel_on = Some((turn, token));
        self
    }

    fn with_stream_delay(mut self, delay: Duration) -> Self {
        self.stream_delay = Some(delay);
        self
    }

    /// The full window the provider saw on the LAST stream call.
    fn last_window(&self) -> Vec<Message> {
        self.seen_windows
            .lock()
            .expect("seen windows lock poisoned")
            .last()
            .cloned()
            .unwrap_or_default()
    }
}

#[async_trait]
impl StreamProvider for ScriptedProvider {
    async fn stream(
        &self,
        config: StreamConfig,
        tx: mpsc::UnboundedSender<StreamEvent>,
        cancel: CancellationToken,
    ) -> Result<Message, ProviderError> {
        self.seen_windows
            .lock()
            .expect("seen windows lock poisoned")
            .push(config.messages.clone());
        if let Some(delay) = self.stream_delay {
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                _ = cancel.cancelled() => return Err(ProviderError::Cancelled),
            }
        }
        let turn_index = self.seen_windows.lock().expect("lock").len();
        if let Some((fire_at, token)) = &self.fire_cancel_on {
            if *fire_at == turn_index {
                token.request();
            }
        }
        let message = self
            .script
            .lock()
            .expect("script lock poisoned")
            .pop_front()
            .expect("script exhausted before the run ended");
        tx.send(StreamEvent::Start).ok();
        tx.send(StreamEvent::Done {
            message: message.clone(),
        })
        .ok();
        Ok(message)
    }
}

/// Script helpers -- the same trajectories the built-in loop's tests build,
/// in the upstream message shape.
fn text_reply(text: &str) -> Message {
    Message::assistant(
        vec![Content::Text {
            text: text.to_string(),
        }],
        StopReason::Stop,
        "scripted",
        "scripted",
        Usage::default(),
    )
}

fn thinking_and_batch(thinking: &str, prose: Option<&str>, calls: Vec<ToolUse>) -> Message {
    let mut content = vec![Content::thinking_signed(thinking, "sig")];
    if let Some(p) = prose {
        content.push(Content::Text {
            text: p.to_string(),
        });
    }
    for call in calls {
        content.push(Content::tool_call(call.id, call.name, call.input));
    }
    Message::assistant(
        content,
        StopReason::ToolUse,
        "scripted",
        "scripted",
        Usage::default(),
    )
}

fn call(id: &str, name: &str, input: JsonValue) -> ToolUse {
    ToolUse {
        id: id.to_string(),
        name: name.to_string(),
        input,
    }
}

/// A recording approval sink (mirrors the agent loop's): captures request
/// ids so a responder thread can deny them.
#[derive(Default)]
struct RecordingSink {
    request_ids: Mutex<Vec<uuid::Uuid>>,
}

impl ApprovalSink for RecordingSink {
    fn emit_request(&self, body: &crate::approval::ApprovalRequestBody) {
        if let Ok(id) = uuid::Uuid::parse_str(&body.request_id) {
            self.request_ids.lock().unwrap().push(id);
        }
    }
    fn emit_resolved(
        &self,
        _body: &crate::approval::ApprovalRequestBody,
        _response: ApprovalResponse,
    ) {
    }
}

/// The offline resolved model: a mock-shaped config + an explicit dummy key
/// -- the conversion's two-protocol coverage lives in model_config's own
/// tests; here the key only proves it rides explicitly (never env).
fn offline_model() -> ResolvedYoagentModel {
    resolve_yoagent_model(
        crate::model::Protocol::Anthropic,
        "https://api.anthropic.example.test",
        "scripted-model",
        Some("sk-offline".into()),
    )
    .expect("offline model resolves")
}

/// One turn's harness state: the engine + working set + temp dir + deps
/// stand-ins the real materializer needs.
struct Harness {
    engine: AdminEngine,
    ws: WorkingSet,
    sources: HashMap<String, std::path::PathBuf>,
    refs: HashMap<String, crate::session::materializer::CachedDerivedRef>,
    temp: TempDir,
    phases: Arc<Mutex<Vec<TurnPhase>>>,
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
        }
    }

    /// Seed a registered result_1 so explore / materialize have a target
    /// (mirrors the tools dispatch-test fixture).
    fn seed_result_1(&mut self) {
        self.engine
            .conn()
            .execute_batch("CREATE TABLE result_1 (id INTEGER)")
            .unwrap();
        self.engine
            .conn()
            .execute_batch("INSERT INTO result_1 VALUES (1), (2)")
            .unwrap();
        self.ws.register_result(DatasetDescriptor {
            reference_name: "result_1".into(),
            display_name: "result_1".into(),
            source_path: String::new(),
            columns: vec![ColumnSchema {
                name: "id".into(),
                canonical_type: "INTEGER".into(),
            }],
            row_count: 2,
            sample: Vec::new(),
            fingerprint: String::new(),
            rectify: RectifyProvenance::NotApplicable,
            privacy: DatasetPrivacy::default(),
            stale: None,
        });
    }

    fn request(&self, script_question: &str) -> ToolTurnRequest {
        self.request_with_tools(script_question, &[])
    }

    /// A request whose gateway catalog additionally lists the named tools
    /// (the external discovery surface, ADR-0105 -- a scripted external call
    /// must be advertised for the loop to dispatch it at all).
    fn request_with_tools(&self, script_question: &str, extra: &[&str]) -> ToolTurnRequest {
        let mut tools = builtin_table();
        for name in extra {
            tools.push(ToolDefinition {
                name: (*name).into(),
                description: "test-external tool".into(),
                input_schema: serde_json::json!({"type": "object"}),
            });
        }
        ToolTurnRequest {
            system: "system prompt".into(),
            messages: vec![ToolTurnMessage::user(script_question)],
            tools,
            max_tokens: 512,
            thought_level: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn run(
        &mut self,
        request: &ToolTurnRequest,
        loop_: YoagentLoop,
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
        cancel: Arc<CancelToken>,
    ) -> LoopOutcome {
        self.run_with_cli(request, loop_, approval, sink, cancel, &[])
    }

    /// The full run with registered CLI tools in the dispatch surface
    /// (ADR-0108): the CLI arm of the gateway routes by registration name.
    fn run_with_cli(
        &mut self,
        request: &ToolTurnRequest,
        loop_: YoagentLoop,
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
        cancel: Arc<CancelToken>,
        cli: &[crate::cli_tools::config::CliToolConfig],
    ) -> LoopOutcome {
        let mut deps = inert_deps_with_temp(
            &self.engine,
            &mut self.ws,
            &mut self.sources,
            self.temp.path(),
            &mut self.refs,
        );
        let mut materializer = RealMaterializer;
        let mut mcp = McpAggregator::empty();
        let phases = Arc::clone(&self.phases);
        loop_.run(
            request,
            &mut deps,
            &mut materializer,
            &mut mcp,
            cli,
            approval,
            sink,
            cancel,
            move |phase| phases.lock().unwrap().push(phase),
        )
    }
}

fn offline_loop(provider: Arc<ScriptedProvider>) -> YoagentLoop {
    YoagentLoop::new(provider, offline_model())
}

/// Multi-step success with thinking, prose, and two dispatch rounds: the
/// trace is round-grouped exactly as the built-in loop groups it (thinking
/// and prose on round 1, the batch's entries in dispatch order), the
/// promotion carries the materializer's `result_N` name, and the terminal
/// text lands verbatim. The dispatch path is the shared gateway core, so
/// this doubles as the materialization-discipline pin for the layer.
#[test]
fn multi_step_success_groups_rounds_and_promotes() {
    let mut h = Harness::new();
    h.seed_result_1();
    let provider = Arc::new(ScriptedProvider::new(vec![
        thinking_and_batch(
            "count the rows first",
            Some("Looking at the data."),
            vec![call(
                "tu_1",
                "explore",
                json!({"sql": "SELECT count(*) FROM result_1"}),
            )],
        ),
        thinking_and_batch(
            "now materialize",
            None,
            vec![call(
                "tu_2",
                "materialize",
                json!({"sql": "SELECT count(*) AS n FROM result_1"}),
            )],
        ),
        text_reply("There are 2 rows."),
    ]));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request("how many rows"),
        offline_loop(Arc::clone(&provider)),
        &approval,
        &sink,
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
    assert_eq!(outcome.round_trips, 3);
}

/// Self-correction (ADR-0077): a tool-level error routes back to the model
/// -- the failed entry records success: false with the bounded error
/// excerpt, the turn does NOT fail, and the corrected call succeeds.
#[test]
fn tool_error_routes_back_for_self_correction() {
    let mut h = Harness::new();
    h.seed_result_1();
    let provider = Arc::new(ScriptedProvider::new(vec![
        thinking_and_batch(
            "",
            None,
            vec![call("tu_1", "describe", json!({"reference_name": "ghost"}))],
        ),
        text_reply("no such dataset, answered from what I have."),
    ]));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request("describe ghost"),
        offline_loop(Arc::clone(&provider)),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    assert!(matches!(outcome.termination, Termination::Text(_)));
    assert_eq!(outcome.trace.len(), 1);
    let entry = &outcome.trace[0].calls[0];
    assert_eq!(entry.name, "describe");
    assert!(!entry.success, "unknown dataset is a tool error");
    assert!(
        entry.result_excerpt.contains("ghost"),
        "error excerpt names the dataset: {}",
        entry.result_excerpt
    );
}

/// Step cap (ADR-0081): a non-converging trajectory stops at the configured
/// cap and lands `StepCap` -- the same honest failed outcome the built-in
/// loop produces. Call arguments VARY per turn so loop detection does not
/// fire first.
#[test]
fn step_cap_lands_the_configured_cap() {
    let mut h = Harness::new();
    h.seed_result_1();
    let script: Vec<Message> = (0..5)
        .map(|i| {
            thinking_and_batch(
                "",
                None,
                vec![call(
                    &format!("tu_{i}"),
                    "explore",
                    json!({"sql": format!("SELECT {i}")}),
                )],
            )
        })
        .collect();
    let provider = Arc::new(ScriptedProvider::new(script));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request("loop forever"),
        offline_loop(Arc::clone(&provider)).with_caps(3, None),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    assert_eq!(outcome.termination, Termination::StepCap(3));
    assert_eq!(
        outcome.trace.len(),
        3,
        "three dispatched rounds before the cap"
    );
}

/// Wall clock (ADR-0021 timeout -> cancel): a per-turn delay past the cap
/// fires the caller-thread watchdog, the token maps up, and the turn lands
/// Cancelled.
#[test]
fn wall_clock_fires_cancel() {
    let mut h = Harness::new();
    h.seed_result_1();
    let script: Vec<Message> = (0..4)
        .map(|i| {
            thinking_and_batch(
                "",
                None,
                vec![call(
                    &format!("tu_{i}"),
                    "explore",
                    json!({"sql": format!("SELECT {i}")}),
                )],
            )
        })
        .collect();
    let provider =
        Arc::new(ScriptedProvider::new(script).with_stream_delay(Duration::from_millis(400)));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request("slow"),
        offline_loop(Arc::clone(&provider)).with_caps(24, Some(Duration::from_millis(100))),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    assert_eq!(outcome.termination, Termination::Cancelled);
}

/// User cancel mid-run: the provider fires the app token on turn 2; the
/// watcher maps it up; the turn lands Cancelled even though a scripted
/// reply was in flight (a cancel wins over a reply, ADR-0021).
#[test]
fn user_cancel_wins_over_the_reply() {
    let mut h = Harness::new();
    h.seed_result_1();
    let cancel = Arc::new(CancelToken::new());
    let provider = Arc::new(
        ScriptedProvider::new(vec![
            thinking_and_batch(
                "",
                None,
                vec![call("tu_1", "explore", json!({"sql": "SELECT 1"}))],
            ),
            text_reply("late reply after cancel"),
        ])
        .with_cancel_on(2, Arc::clone(&cancel)),
    );
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request("cancel me"),
        offline_loop(Arc::clone(&provider)).with_caps(24, None),
        &approval,
        &sink,
        cancel,
    );
    assert_eq!(outcome.termination, Termination::Cancelled);
}

/// Gate denial (ADR-0078/0080): a registered CLI tool the approver denies
/// records success: false with the denial excerpt, never dispatches (no
/// child process spawns), and the denial routes back to the model for
/// self-correction -- the turn does not fail. (The CLI arm is the gate's
/// direct-listed external surface, ADR-0108; namespaced MCP handles route
/// through `mcp_invoke` and are pinned by the routing test below.)
#[test]
fn gate_denial_records_failure_and_routes_back() {
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
    let provider = Arc::new(ScriptedProvider::new(vec![
        thinking_and_batch(
            "",
            None,
            vec![call("tu_1", "pandoc", json!({"output": "out.pdf"}))],
        ),
        text_reply("denied, moving on."),
    ]));
    // The gate waits on the shared approval state while the responder
    // thread drives the Deny -- both behind Arc so the run and the
    // responder share them.
    let approval = Arc::new(ApprovalState::new());
    let sink = Arc::new(RecordingSink::default());
    let responder = {
        let approval = Arc::clone(&approval);
        let sink = Arc::clone(&sink);
        // Poll the sink for the first request id, then deny it -- the same
        // drive the built-in loop's gate-deny test uses.
        std::thread::spawn(move || {
            let start = std::time::Instant::now();
            loop {
                if let Some(id) = sink.request_ids.lock().unwrap().first().copied() {
                    approval.respond(id, ApprovalResponse::Deny).unwrap();
                    return;
                }
                if start.elapsed() > Duration::from_secs(5) {
                    panic!("no approval request arrived");
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    let outcome = h.run_with_cli(
        &h.request_with_tools("call pandoc", &["pandoc"]),
        offline_loop(Arc::clone(&provider)),
        approval.as_ref(),
        sink.as_ref(),
        Arc::new(CancelToken::new()),
        std::slice::from_ref(&cli_tool),
    );
    responder.join().unwrap();
    assert!(matches!(outcome.termination, Termination::Text(_)));
    assert_eq!(outcome.trace.len(), 1);
    let entry = &outcome.trace[0].calls[0];
    assert_eq!(entry.name, "pandoc");
    assert!(!entry.success);
    assert_eq!(entry.result_excerpt, "denied by approval gateway");
}

/// External routing (ADR-0105): an un-denied namespaced call routes to the
/// aggregator; with no server connected, the route failure surfaces as a
/// tool error the model self-corrects from (never a turn failure).
#[test]
fn external_call_routes_the_aggregator() {
    let mut h = Harness::new();
    let provider = Arc::new(ScriptedProvider::new(vec![
        // The fixed discovery surface (ADR-0105): external tools are
        // addressed via `mcp_invoke` + handle, never emitted directly.
        thinking_and_batch(
            "",
            None,
            vec![call(
                "tu_1",
                "mcp_invoke",
                json!({"tool": "mcp__nowhere__thing", "arguments": {}}),
            )],
        ),
        text_reply("route failed, answered anyway."),
    ]));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request_with_tools("external", &["mcp_invoke"]),
        offline_loop(Arc::clone(&provider)),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    assert!(matches!(outcome.termination, Termination::Text(_)));
    // A resolution failure (no server connected for the slug) is the call's
    // own error result routed back -- no trace entry, no dispatch (ADR-0105
    // Decision 4: the call never reached a tool).
    assert!(
        outcome.trace.iter().all(|r| r.calls.is_empty()),
        "an unresolved handle never dispatches: {:?}",
        outcome.trace
    );
    // The fed-back result IS an error naming the slug, so the agent can
    // self-correct (ADR-0077).
    let window = provider.last_window();
    if let Message::ToolResult {
        is_error, content, ..
    } = &window[2]
    {
        assert!(*is_error, "unknown server is a tool error");
        assert!(
            content
                .iter()
                .any(|c| matches!(c, Content::Text { text } if text.contains("nowhere"))),
            "the error names the slug"
        );
    } else {
        panic!("expected a tool result in the window: {window:?}");
    }
}

/// Loop detection (ADR-0107 Decision 4): consecutive identical calls steer
/// first (an annotation round, run continues), then abort on the second
/// trip -- the abort lands as an honest Transient failure with the
/// annotation rounds present in the trace.
#[test]
fn loop_detection_annotates_then_aborts() {
    let mut h = Harness::new();
    h.seed_result_1();
    let script: Vec<Message> = (0..8)
        .map(|i| {
            thinking_and_batch(
                "",
                None,
                vec![call(
                    &format!("tu_{i}"),
                    "explore",
                    json!({"sql": "SELECT 1"}),
                )],
            )
        })
        .collect();
    let provider = Arc::new(ScriptedProvider::new(script));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request("stuck"),
        offline_loop(Arc::clone(&provider)).with_caps(24, None),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    let Termination::Transient(detail) = &outcome.termination else {
        panic!(
            "loop abort is an honest failure, got {:?}",
            outcome.termination
        );
    };
    assert!(
        detail.contains("identical arguments"),
        "honest reason: {detail}"
    );
    let annotations: Vec<&str> = outcome
        .trace
        .iter()
        .filter_map(|r| r.text.as_deref())
        .filter(|t| t.starts_with("loop detection:"))
        .collect();
    assert!(
        annotations.len() >= 2,
        "steer + abort annotations recorded: {annotations:?}"
    );
}

/// No upstream built-in surface: a `bash` call (yoagent ships one; the app
/// registers none) is NOT in the gateway catalog, so the loop's own executor
/// answers "tool not found" as an error result routed back -- no dispatch,
/// no trace entry. That is the pin: the only registered surface is the
/// gateway catalog, and bash (read/write/search likewise) is absent from it.
#[test]
fn upstream_builtin_tools_are_not_registered() {
    let mut h = Harness::new();
    let provider = Arc::new(ScriptedProvider::new(vec![
        thinking_and_batch("", None, vec![call("tu_1", "bash", json!({"cmd": "ls"}))]),
        text_reply("no bash here."),
    ]));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    let outcome = h.run(
        &h.request("run bash"),
        offline_loop(Arc::clone(&provider)),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    assert!(matches!(outcome.termination, Termination::Text(_)));
    // No call ever dispatched: the empty round the batch opened is dropped
    // by the outcome assembly, so the trace carries no entry at all.
    assert!(
        outcome.trace.iter().all(|r| r.calls.is_empty()),
        "bash never dispatches: {:?}",
        outcome.trace
    );
    // The not-found result fed back to the model is an error result.
    let window = provider.last_window();
    if let Message::ToolResult {
        is_error, content, ..
    } = &window[2]
    {
        assert!(*is_error, "an unregistered tool is an error result");
        assert!(
            content
                .iter()
                .any(|c| matches!(c, Content::Text { text } if text.contains("bash"))),
            "the error names the tool"
        );
    }
}

/// Full-window feed: the provider's last stream saw the ENTIRE conversation
/// it built (assistant batch + tool results), verbatim -- windowing is the
/// app's and the upstream never rewrites it (no compaction configured).
#[test]
fn the_full_window_rides_verbatim() {
    let mut h = Harness::new();
    h.seed_result_1();
    let provider = Arc::new(ScriptedProvider::new(vec![
        thinking_and_batch(
            "",
            None,
            vec![call("tu_1", "explore", json!({"sql": "SELECT 1"}))],
        ),
        text_reply("done."),
    ]));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    h.run(
        &h.request("window check"),
        offline_loop(Arc::clone(&provider)),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    let window = provider.last_window();
    // user question + assistant batch + tool result -- the conversation the
    // turn itself built, un-truncated.
    assert_eq!(window.len(), 3, "the turn's full conversation rides");
    assert!(matches!(window[2], Message::ToolResult { .. }));
    if let Message::ToolResult { is_error, .. } = &window[2] {
        assert!(!is_error);
    }
    // The system prompt rides the config's own field, not the messages.
    // (Asserted implicitly: the run answered; here we pin the shape.)
    assert!(matches!(window[0], Message::User { .. }));
}

/// Live phase rail order (ADR-0059/0103): thinking wait per stream, the
/// completed + prose pair before the batch's started/completed call pair.
#[test]
fn phase_stream_orders_thinking_before_call_events() {
    let mut h = Harness::new();
    h.seed_result_1();
    let provider = Arc::new(ScriptedProvider::new(vec![
        thinking_and_batch(
            "think",
            Some("prose."),
            vec![call("tu_1", "explore", json!({"sql": "SELECT 1"}))],
        ),
        text_reply("done."),
    ]));
    let approval = ApprovalState::new();
    let sink = RecordingSink::default();
    h.run(
        &h.request("phases"),
        offline_loop(Arc::clone(&provider)),
        &approval,
        &sink,
        Arc::new(CancelToken::new()),
    );
    let phases = h.phases.lock().unwrap().clone();
    let kind = |p: &TurnPhase| -> &'static str {
        match p {
            TurnPhase::Thinking { .. } => "thinking",
            TurnPhase::ThinkingCompleted { .. } => "thinking_completed",
            TurnPhase::RoundText { .. } => "round_text",
            TurnPhase::ToolCallStarted { .. } => "started",
            TurnPhase::ToolCallCompleted(_) => "completed",
        }
    };
    let order: Vec<&str> = phases.iter().map(kind).collect();
    // Within each producer the order is deterministic (thinking ->
    // thinking_completed -> round_text on the fold thread; started ->
    // completed on the dispatch thread, post-gate exactly like the built-in
    // loop). Across the two threads the relative order is best-effort: the
    // event channel and the dispatch channel are independent, so a started
    // can theoretically land before the fold has processed the round-open
    // events. The persisted trace is unaffected (rounds are grouped by the
    // fold alone); #669's wiring decides whether the live rail needs a
    // barrier. This pin asserts the deterministic parts: both event
    // families present, each internally ordered.
    let pos = |needle: &str| order.iter().position(|k| *k == needle);
    assert!(pos("thinking").is_some(), "the thinking wait fires");
    let (tc, rt) = (pos("thinking_completed"), pos("round_text"));
    let (st, cm) = (pos("started"), pos("completed"));
    assert!(tc.is_some() && rt.is_some(), "the round opens: {order:?}");
    assert!(
        st.is_some() && cm.is_some(),
        "the call pair fires: {order:?}"
    );
    assert!(tc.unwrap() < rt.unwrap(), "thinking completes before prose");
    assert!(st.unwrap() < cm.unwrap(), "started precedes completed");
}
