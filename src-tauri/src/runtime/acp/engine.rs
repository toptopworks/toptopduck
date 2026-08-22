//! The generic ACP adapter engine (ADR-0081, issue #299).
//!
//! [`AcpEngine::run`] drives one agent turn against an external CLI over ACP v1
//! (stdio JSON-RPC). It is the external-runtime counterpart to
//! [`crate::session::agent_loop::AgentLoop::run`]: it takes a windowed turn
//! input and returns the SAME [`LoopOutcome`] shape, so the wiring seam
//! (`Session::ask_with_phase`, slice 9c) maps either runtime's outcome onto
//! `TurnOutcome` identically.
//!
//! Per-turn sequence (ADR-0076 statelessness):
//! 1. spawn the resolved CLI binary with [`AdapterSpec::argv`];
//! 2. `initialize` (negotiate protocol version);
//! 3. `session/new` -- inject the bridge MCP server descriptor (slice 9b fills
//!    the real bridge; the descriptor is opaque data carried from the input);
//! 4. `session/prompt` -- carry the full windowed context blocks; pump
//!    `session/update` notifications into the execution trace (ADR-0078) + the
//!    terminal agent text; service `session/request_permission` via the gateway
//!    policy ([`crate::approval::classify`]);
//! 5. the prompt response's [`StopReason`] terminates the turn and maps onto
//!    [`Termination`].
//!
//! Execution-level safety net (ADR-0081): a step cap (tool-call count, default
//! [`DEFAULT_STEP_CAP`]) + a wall-clock watchdog (default
//! [`DEFAULT_WALL_CLOCK`]) fire `session/cancel`; a stuck agent that does not
//! return within [`CANCEL_GRACE`] is killed (cancel = 整轮中止, ADR-0081).
//! Cancel is responsive via a stdout-reader thread + a recv-timeout pump (a
//! blocking `read_line` would not notice cancel).
//!
//! Promotions are always empty here: a `materialize` promotion is created
//! gateway-side (the bridge → the app's MCP gateway →
//! [`crate::tools::dispatch`]) and observed there. The engine owns only the
//! ACP-driving half of the turn.

use std::collections::HashSet;
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::approval::{
    classify, ApprovalResponse, ApprovalSink, Classification, OperationKind, ToolKey,
};
use crate::cancel::CancelToken;
use crate::model::{ThinkingTrace, TraceEntryView, TurnPhase};
use crate::runtime::acp::adapter::{
    extract_discovered_runtime, AdapterSpec, DiscoveredRuntime, StreamFormat, MODEL_CATEGORY,
    THOUGHT_LEVEL_CATEGORY,
};
use crate::runtime::acp::wire::{
    self, CancelParams, ContentBlock, InitializeParams, McpServer, NewSessionParams, PromptParams,
    Request, RequestId, RequestPermissionOutcome, RequestPermissionParams, RequestPermissionResult,
    Response, SessionUpdate, SessionUpdateParams, StopReason, ToolCallContent, ToolCallStatus,
};
use crate::session::agent_loop::{
    truncate_trace_excerpt, LoopOutcome, LoopRound, Termination, TraceEntry, DEFAULT_STEP_CAP,
    DEFAULT_WALL_CLOCK, TRACE_EXCERPT_MAX,
};

/// Grace period after the engine sends `session/cancel` for the agent to return
/// the prompt response before the engine kills the process. Generous for a
/// cooperative agent (it should respond near-instantly); bounded so a stuck
/// agent cannot hang the turn past the watchdog.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// One ACP turn input. The wiring seam assembles `prompt_blocks` from the
/// same window the built-in loop reads; `mcp_servers` is the bridge
/// descriptor.
#[derive(Debug, Clone)]
pub struct AcpTurnInput {
    /// The working directory passed to `session/new` (absolute).
    pub cwd: String,
    /// The MCP server descriptors injected at `session/new` (the bridge).
    pub mcp_servers: Vec<McpServer>,
    /// The session-level model choice to inject this turn (ADR-0095). `None`
    /// = the CLI's own default. ACP path: one `session/set_config_option`
    /// after the handshake, keyed by the catalog entry's config id (the
    /// category constant is only a fallback) -- `NewSessionRequest` carries
    /// no model field; the non-ACP paths ride argv behind
    /// `AdapterSpec.model_arg`.
    pub model: Option<String>,
    /// The session-level thought-level choice to inject this turn (ADR-0095).
    /// `None` = the CLI's own default. ACP path: one
    /// `session/set_config_option` after the handshake, keyed like `model`;
    /// CodexEventStream path: argv via the `-c` config surface;
    /// ClaudeStreamJson path: argv via the flag surface
    /// (`AdapterSpec.effort`, ADR-0097 Decision 6).
    pub thought_level: Option<String>,
    /// The full windowed context for this turn (the question + history), as
    /// text content blocks. ADR-0076 statelessness: the whole context every
    /// turn.
    pub prompt_blocks: Vec<ContentBlock>,
}

/// The generic ACP adapter engine (ADR-0081). Holds the adapter spec (data),
/// the shared cancel token, and the two execution-level caps. Built per turn;
/// [`Self::run`] consumes it.
pub struct AcpEngine {
    adapter: AdapterSpec,
    cancel: Arc<CancelToken>,
    step_cap: u32,
    wall_clock: Option<Duration>,
}

impl AcpEngine {
    /// Build an engine with the ADR-0081 defaults (step cap 24, wall-clock
    /// 120s) -- the SAME defaults as the built-in loop, so the two runtimes
    /// share one execution-level safety net.
    pub fn new(adapter: AdapterSpec, cancel: Arc<CancelToken>) -> Self {
        Self {
            adapter,
            cancel,
            step_cap: DEFAULT_STEP_CAP,
            wall_clock: Some(DEFAULT_WALL_CLOCK),
        }
    }

    /// Override the default caps (test seam: the step-cap test drives the step
    /// cap deterministically; the watchdog test drives a short wall-clock).
    pub fn with_caps(mut self, step_cap: u32, wall_clock: Option<Duration>) -> Self {
        self.step_cap = step_cap;
        self.wall_clock = wall_clock;
        self
    }

    /// Drive one turn against the adapter's CLI. Dispatches on
    /// [`StreamFormat`] (ADR-0094/0097): the ACP path drives the full
    /// JSON-RPC turn; the codex event stream path delegates to
    /// `codex_event_stream::run_codex_event_stream` (codex native
    /// `exec --json`); the claude stream-json path delegates to
    /// `claude_stream_json::run_claude_stream_json` (claude-code native
    /// headless). `binary` is the resolved CLI path (`detect_adapter` in
    /// production, the fake-fixture path in tests). Returns the SAME
    /// [`LoopOutcome`] shape the built-in loop returns.
    pub fn run(
        &self,
        input: &AcpTurnInput,
        binary: &Path,
        approval: &crate::approval::ApprovalState,
        sink: &dyn ApprovalSink,
        on_phase: impl FnMut(TurnPhase),
    ) -> LoopOutcome {
        match self.adapter.stream_format {
            StreamFormat::Acp => self.run_acp(input, binary, approval, sink, on_phase),
            StreamFormat::CodexEventStream => super::codex_event_stream::run_codex_event_stream(
                &self.adapter,
                Arc::clone(&self.cancel),
                self.step_cap,
                self.wall_clock,
                input,
                binary,
                approval,
                sink,
                on_phase,
            ),
            StreamFormat::ClaudeStreamJson => super::claude_stream_json::run_claude_stream_json(
                &self.adapter,
                Arc::clone(&self.cancel),
                self.step_cap,
                self.wall_clock,
                input,
                binary,
                approval,
                sink,
                on_phase,
            ),
        }
    }

    /// The ACP v1 driving path (ADR-0081). The per-format dispatch seam
    /// routes `Acp` specs here.
    fn run_acp(
        &self,
        input: &AcpTurnInput,
        binary: &Path,
        approval: &crate::approval::ApprovalState,
        sink: &dyn ApprovalSink,
        mut on_phase: impl FnMut(TurnPhase),
    ) -> LoopOutcome {
        let cancel = Arc::clone(&self.cancel);
        let guard = cancel.begin_turn();
        // Wall-clock watchdog (ADR-0081): fires the shared token on expiry; the
        // pump notices via cancel.is_requested() and sends session/cancel.
        if let Some(timeout) = self.wall_clock {
            let alive = guard.watchdog_alive();
            let token = Arc::clone(&cancel);
            thread::spawn(move || {
                thread::sleep(timeout);
                if alive.load(std::sync::atomic::Ordering::SeqCst) {
                    token.request();
                }
            });
        }
        // Spawn the CLI. Any spawn failure lands as a transient turn failure
        // (the engine never panics into the host).
        let mut child = match spawn(binary, &self.adapter) {
            Ok(c) => c,
            Err(detail) => {
                return self.outcome(Termination::Transient(detail), Vec::new(), 1, None)
            }
        };
        let stdout = child.inner.stdout.take().expect("piped stdout");
        let stdin = child.inner.stdin.take().expect("piped stdin");
        let mut io = AcpIo::new(stdin, stdout);

        // Handshake: initialize -> session/new. A failure here is a transient
        // turn failure (the CLI is not an ACP agent / crashed).
        let hs = match handshake(&mut io, &self.cancel, input, &self.adapter) {
            Ok(hs) => hs,
            Err(term) => {
                let outcome = self.outcome(term, Vec::new(), 1, None);
                child.kill_and_wait();
                return outcome;
            }
        };
        let session_id = hs.session_id;
        let discovered = Some(hs.discovered.clone());
        // ADR-0095: inject the user's selections via `session/set_config_option`
        // between the handshake and the prompt -- the model and the thought
        // level each ride their own request when selected. The config id keys
        // on the catalog entry's agent-chosen `id` (D4: the ACP schema
        // standardizes the category tag, NOT the id), falling back to the
        // standard category id when discovery saw no usable one. A CLI that
        // rejects the setting fails the turn honestly (the user asked for a
        // setting the CLI does not accept; clearing the selection restores
        // the turn).
        let selections: Vec<(&str, &String)> = [
            input.model.as_ref().map(|m| {
                (
                    discovered_config_id(&hs.discovered.model_config_id, MODEL_CATEGORY),
                    m,
                )
            }),
            input.thought_level.as_ref().map(|l| {
                (
                    discovered_config_id(
                        &hs.discovered.thought_level_config_id,
                        THOUGHT_LEVEL_CATEGORY,
                    ),
                    l,
                )
            }),
        ]
        .into_iter()
        .flatten()
        .collect();
        for (config_id, value) in selections {
            let req = Request::new(
                RequestId::Num(4),
                "session/set_config_option",
                SetConfigOptionParams {
                    session_id: session_id.clone(),
                    config_id: config_id.to_string(),
                    value: value.clone(),
                },
            );
            match io.request_roundtrip::<SetConfigOptionParams, Value>(&self.cancel, req) {
                Err(term) => {
                    let outcome = self.outcome(term, Vec::new(), 1, discovered);
                    child.kill_and_wait();
                    return outcome;
                }
                // An RPC error is a real rejection, not a transport gap --
                // surface it (e.g. the CLI does not accept the id / value),
                // naming both so the user knows which selection to clear.
                Ok(resp) => {
                    if let Some(e) = resp.error {
                        let outcome = self.outcome(
                            Termination::Transient(format!(
                                "session/set_config_option `{config_id}` = `{value}` error: {}",
                                e.message
                            )),
                            Vec::new(),
                            1,
                            discovered,
                        );
                        child.kill_and_wait();
                        return outcome;
                    }
                }
            }
        }

        // Loop-top cancel check (mirrors the built-in loop's pre-step check).
        if self.cancel.is_requested() {
            let outcome = self.outcome(Termination::Cancelled, Vec::new(), 1, discovered);
            child.kill_and_wait();
            return outcome;
        }
        // ADR-0059: signal the "thinking" wait once before the prompt (the ACP
        // turn is one prompt round -- attempt = 1).
        on_phase(TurnPhase::Thinking { attempt: 1 });

        let prompt = Request::new(
            RequestId::Num(3),
            "session/prompt",
            PromptParams {
                session_id: session_id.clone(),
                blocks: input.prompt_blocks.clone(),
            },
        );
        if io.write_json(&prompt).is_err() {
            let outcome = self.outcome(
                Termination::Transient("session/prompt: broken pipe before send".into()),
                Vec::new(),
                1,
                discovered,
            );
            child.kill_and_wait();
            return outcome;
        }

        let mut pump = Pump {
            rounds: vec![RoundAcc::default()],
            text: String::new(),
            pending: Vec::new(),
            tool_call_count: 0,
            cancel_sent_at: None,
            step_cap: self.step_cap,
        };
        let end = io.pump_until_prompt_response(
            &self.cancel,
            &self.adapter,
            &session_id,
            &mut pump,
            approval,
            sink,
            &mut on_phase,
        );
        // Finalize any tool rows still open at turn end (best-effort success),
        // each landing on the round it opened in.
        for row in pump.pending.drain(..) {
            let entry = TraceEntry {
                tool_use_id: row.tool_use_id,
                name: row.name,
                operation_kind: row.operation_kind,
                summary: row.summary,
                success: true,
                result_excerpt: String::new(),
            };
            on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
            pump.rounds[row.round].calls.push(entry);
        }
        // Close the trailing round's thought stream: its ThinkingCompleted
        // fires (the fold renders live), but no RoundText -- the trailing
        // prose rides the terminal text, not a round slot (issue #611).
        let trailing = pump.rounds.len() - 1;
        pump.freeze_thinking(trailing, &mut on_phase);

        let termination = match end {
            PromptEnd::Stop(StopReason::Success | StopReason::Refusal) => {
                Termination::Text(pump.terminal_text())
            }
            PromptEnd::Stop(StopReason::Cancelled) => Termination::Cancelled,
            // The agent's own turn/token ceilings are execution-level caps;
            // map onto our StepCap (the wiring seam renders Failed either way).
            PromptEnd::Stop(StopReason::MaxTurns | StopReason::MaxTokens) => {
                Termination::StepCap(self.step_cap)
            }
            PromptEnd::Cancelled => Termination::Cancelled,
            // Reader EOF / pipe break before a response: a transient turn
            // failure (the agent crashed or closed stdout).
            PromptEnd::Eof => Termination::Transient("ACP agent closed stdout mid-turn".into()),
            // The agent answered with a parse failure / RPC error / empty
            // result -- surface the real diagnostic, NOT "closed stdout".
            PromptEnd::Failed(reason) => Termination::Transient(reason),
        };
        let outcome = self.outcome(termination, pump.settle_rounds(), 1, discovered);
        child.kill_and_wait();
        outcome
    }

    fn outcome(
        &self,
        termination: Termination,
        rounds: Vec<LoopRound>,
        round_trips: u32,
        discovered: Option<DiscoveredRuntime>,
    ) -> LoopOutcome {
        LoopOutcome {
            termination,
            // Always empty: a materialize promotion is gateway-side
            // (bridge -> MCP gateway -> tools::dispatch), observed there.
            // The ACP engine drives only the ACP half of the turn.
            promotions: Vec::new(),
            // ADR-0103 (issue #611): rounds grouped at the tool-call batch
            // boundary, with per-round thinking + prose slots; the built-in
            // loop's flat wrap no longer funnels through here.
            trace: rounds,
            round_trips,
            // ADR-0095: the handshake's extracted catalog rides every
            // post-handshake exit (None before / on handshake failure).
            discovered_runtime: discovered,
        }
    }
}

// ---------------------------------------------------------------------------
// Handshake: initialize + session/new
// ---------------------------------------------------------------------------

/// The handshake's session facts: the minted session id + the runtime config
/// discovered from the `session/new` response's `config_options` (ADR-0095).
/// Discovery is best-effort data -- a catalog with no model / thought_level
/// entries yields the empty shape, never an error.
pub(crate) struct HandshakeOutcome {
    pub session_id: String,
    pub discovered: DiscoveredRuntime,
}

/// One `session/set_config_option` request body (ADR-0095): sets the option
/// with the given config id to `value` on the freshly minted session --
/// field-for-field schema 0.13.8's `SetSessionConfigOptionRequest`
/// (`session_id` / `config_id` / `value` as the select value id; its
/// optional `_meta` is deliberately not sent). The protocol-standard
/// injection channel for BOTH the model and the thought level
/// (`NewSessionRequest` carries no model field, schema 0.13.8). Sent
/// after the handshake when the user selected either; the response result is
/// ignored (the next turn's handshake re-discovers the truth) but an RPC
/// error fails the turn honestly.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SetConfigOptionParams {
    session_id: String,
    config_id: String,
    value: String,
}

/// The config id to inject for a selection (ADR-0095 D4): the catalog entry's
/// agent-chosen id when discovery saw the category, otherwise the standard
/// category id -- a selection without a matching catalog entry is exactly the
/// stale / manual-call case Decision 7 tolerates (the CLI deals with it at
/// the request).
fn discovered_config_id<'a>(catalog_id: &'a Option<String>, standard: &'static str) -> &'a str {
    catalog_id.as_deref().unwrap_or(standard)
}

fn handshake(
    io: &mut AcpIo,
    cancel: &CancelToken,
    input: &AcpTurnInput,
    adapter: &AdapterSpec,
) -> Result<HandshakeOutcome, Termination> {
    let init = io.request_roundtrip::<InitializeParams, wire::InitializeResult>(
        cancel,
        Request::new(
            RequestId::Num(1),
            "initialize",
            InitializeParams {
                protocol_version: wire::PROTOCOL_VERSION,
                client_info: wire::Implementation::client(),
            },
        ),
    )?;
    match (init.result, init.error) {
        (Some(_), _) => {}
        (None, Some(e)) => {
            return Err(Termination::Transient(format!(
                "initialize error: {}",
                e.message
            )));
        }
        (None, None) => return Err(Termination::Transient("initialize: empty response".into())),
    }
    let new_resp = io.request_roundtrip::<NewSessionParams, wire::NewSessionResult>(
        cancel,
        Request::new(
            RequestId::Num(2),
            "session/new",
            NewSessionParams {
                cwd: input.cwd.clone(),
                mcp_servers: input.mcp_servers.clone(),
            },
        ),
    )?;
    match (new_resp.result, new_resp.error) {
        (Some(r), _) => {
            // Issue #529: stamp the producing adapter onto the catalog so the
            // frontend can detect a cache that predates a runtime switch (the
            // config_options wire carries no adapter identity).
            let mut discovered = extract_discovered_runtime(r.config_options.as_ref());
            discovered.adapter_id = Some(adapter.id.to_string());
            Ok(HandshakeOutcome {
                session_id: r.session_id,
                discovered,
            })
        }
        (None, Some(e)) => Err(Termination::Transient(format!(
            "session/new error: {}",
            e.message
        ))),
        (None, None) => Err(Termination::Transient("session/new: empty response".into())),
    }
}

// ---------------------------------------------------------------------------
// Child process wrapper
// ---------------------------------------------------------------------------

/// The spawned CLI child + its stdio. [`Self::kill_and_wait`] delegates to
/// [`super::process::kill_and_reap`] — the shared kill-reap logic used by both
/// the ACP and JSON event stream engines (prevents drift, ADR-0094 review I-3).
struct ChildHandle {
    inner: Child,
}

impl ChildHandle {
    fn kill_and_wait(&mut self) {
        super::process::kill_and_reap(&mut self.inner);
    }
}

fn spawn(binary: &Path, adapter: &AdapterSpec) -> Result<ChildHandle, String> {
    super::process::spawn_piped(binary, adapter.argv, std::process::Stdio::inherit())
        .map(|inner| ChildHandle { inner })
        .map_err(|e| format!("failed to spawn ACP agent `{}`: {e}", adapter.id))
}

// ---------------------------------------------------------------------------
// NDJSON stdio I/O
// ---------------------------------------------------------------------------

/// The turn engine's thin wrapper over the shared
/// [`super::ndjson::NdjsonIo`]: cancel-driven (a round-trip aborts on the
/// shared token; the wall-clock watchdog fires it) and mapped onto
/// [`Termination`]. The multiplexing prompt pump below keeps its own line
/// loop -- it folds `session/update` and services `session/request_permission`
/// -- and shares the reader channel via [`Self::recv_timeout`] and the writer
/// via [`Self::write_json`].
struct AcpIo {
    inner: super::ndjson::NdjsonIo,
}

impl AcpIo {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            inner: super::ndjson::NdjsonIo::new(stdin, stdout),
        }
    }

    /// Delegates to [`super::ndjson::NdjsonIo::write_json`] (one NDJSON line +
    /// flush).
    fn write_json<T: serde::Serialize>(&mut self, msg: &T) -> Result<(), std::io::Error> {
        self.inner.write_json(msg)
    }

    /// One receive step for the prompt pump below.
    fn recv_timeout(&self, timeout: std::time::Duration) -> Result<String, mpsc::RecvTimeoutError> {
        self.inner.recv_timeout(timeout)
    }

    /// Send a request and pump incoming lines until its response arrives.
    /// Stray lines are dropped by the shared loop (see
    /// [`super::ndjson::NdjsonIo::request_roundtrip_cancel`]).
    fn request_roundtrip<P: serde::Serialize, R: serde::de::DeserializeOwned>(
        &mut self,
        cancel: &CancelToken,
        req: Request<P>,
    ) -> Result<Response<R>, Termination> {
        let target = serde_json::to_value(&req.id).unwrap_or(Value::Null);
        self.inner
            .request_roundtrip_cancel(&req, &target, cancel)
            .map_err(map_roundtrip_termination)
    }

    /// Pump incoming lines from the moment `session/prompt` is sent until its
    /// response (id=3) arrives, an abort fires, or the agent EOFs. Folds
    /// `session/update` into the [`Pump`] state and services
    /// `session/request_permission`. Sends `session/cancel` once on cancel /
    /// step-cap trip and continues draining (the agent should then return the
    /// prompt response with [`StopReason::Cancelled`]); gives up after
    /// [`CANCEL_GRACE`] and returns [`PromptEnd::Cancelled`].
    #[allow(clippy::too_many_arguments)]
    fn pump_until_prompt_response(
        &mut self,
        cancel: &CancelToken,
        adapter: &AdapterSpec,
        session_id: &str,
        pump: &mut Pump,
        approval: &crate::approval::ApprovalState,
        sink: &dyn ApprovalSink,
        on_phase: &mut impl FnMut(TurnPhase),
    ) -> PromptEnd {
        let prompt_id_value = serde_json::to_value(RequestId::Num(3)).unwrap_or(Value::Null);
        loop {
            // Cancel / step-cap trip: send session/cancel once, record when.
            let user_cancelled = cancel.is_requested();
            let step_cap_tripped = pump.tool_call_count > pump.step_cap;
            if (user_cancelled || step_cap_tripped) && pump.cancel_sent_at.is_none() {
                let _ = self.write_json(&wire::Notification::new(
                    "session/cancel",
                    CancelParams {
                        session_id: session_id.to_string(),
                    },
                ));
                pump.cancel_sent_at = Some(Instant::now());
            }
            // Grace elapsed after cancel with no response -> give up (the
            // caller kills the child).
            if let Some(sent_at) = pump.cancel_sent_at {
                if sent_at.elapsed() > CANCEL_GRACE {
                    return PromptEnd::Cancelled;
                }
            }
            match self.recv_timeout(super::process::PUMP_POLL_INTERVAL) {
                Ok(line) => {
                    let v: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    // Response to the prompt?
                    if v.get("id") == Some(&prompt_id_value) && v.get("method").is_none() {
                        let resp: Response<wire::PromptResult> = match serde_json::from_value(v) {
                            Ok(r) => r,
                            Err(e) => {
                                return PromptEnd::Failed(format!("prompt response parse: {e}"))
                            }
                        };
                        if let Some(err) = resp.error {
                            return PromptEnd::Failed(format!("prompt error: {}", err.message));
                        }
                        match resp.result {
                            Some(r) => return PromptEnd::Stop(r.stop_reason),
                            None => {
                                return PromptEnd::Failed("prompt response: empty result".into())
                            }
                        }
                    }
                    // Agent-initiated request (session/request_permission)?
                    if let Some(method) = v.get("method").and_then(Value::as_str) {
                        if v.get("id").is_some() && method == "session/request_permission" {
                            let req_id = v["id"].clone();
                            let params: RequestPermissionParams = match serde_json::from_value(
                                v.get("params").cloned().unwrap_or(Value::Null),
                            ) {
                                Ok(p) => p,
                                Err(_) => {
                                    // Malformed permission request: refuse with -32602
                                    // so the agent is not left waiting, and no phantom
                                    // decision is recorded against empty ids.
                                    let _ = self.write_json(&Response::<Value> {
                                        jsonrpc: "2.0".to_string(),
                                        id: parse_id(&req_id),
                                        result: None,
                                        error: Some(wire::RpcError {
                                            code: -32602,
                                            message: "invalid params: session/request_permission"
                                                .into(),
                                            data: None,
                                        }),
                                    });
                                    continue;
                                }
                            };
                            let outcome =
                                decide_permission(adapter, &params, approval, sink, cancel);
                            let _ = self.write_json(&Response::<RequestPermissionResult> {
                                jsonrpc: "2.0".to_string(),
                                id: parse_id(&req_id),
                                result: Some(RequestPermissionResult { outcome }),
                                error: None,
                            });
                            continue;
                        }
                        if v.get("id").is_some() {
                            // Unknown agent request -- respond method-not-found
                            // so the agent is not left waiting.
                            let _ = self.write_json(&Response::<Value> {
                                jsonrpc: "2.0".to_string(),
                                id: parse_id(&v["id"]),
                                result: None,
                                error: Some(wire::RpcError {
                                    code: -32601,
                                    message: "method not found".into(),
                                    data: None,
                                }),
                            });
                            continue;
                        }
                        // Notification -- route session/update; ignore others.
                        if method == "session/update" {
                            match serde_json::from_value::<SessionUpdateParams>(
                                v.get("params").cloned().unwrap_or(Value::Null),
                            ) {
                                Ok(params) => pump.fold_update(&params.update, on_phase),
                                // Dropped, not fatal (protocol robustness) --
                                // but never silent: a shape miss here renders
                                // a whole turn empty while tests stay green,
                                // so the drop stays answerable in logs (the
                                // ndjson reader's issue #543 precedent).
                                Err(e) => {
                                    let payload = v.to_string();
                                    let head: String = payload.chars().take(240).collect();
                                    log::warn!(
                                        target: "toptopduck::acp",
                                        "session/update parse failed, line dropped: {e}; payload head: {head}"
                                    );
                                }
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return if pump.cancel_sent_at.is_some() {
                        PromptEnd::Cancelled
                    } else {
                        PromptEnd::Eof
                    };
                }
            }
        }
    }
}

/// Map the shared round-trip failure onto the turn's termination. The EOF
/// detail is frozen by the integration tests' locale-free diagnostic fold.
/// Exhaustive over the cancel-driven error type -- the deadline-driven abort
/// kind is not representable here (issue #543).
fn map_roundtrip_termination(
    e: super::ndjson::RoundtripError<super::ndjson::Cancelled>,
) -> Termination {
    use super::ndjson::RoundtripError;
    match e {
        RoundtripError::Abort(_) => Termination::Cancelled,
        RoundtripError::Serialize(detail) | RoundtripError::Write(detail) => {
            Termination::Transient(format!("write: {detail}"))
        }
        RoundtripError::Eof => Termination::Transient("ACP agent closed stdout".into()),
        RoundtripError::Parse(detail) => {
            Termination::Transient(format!("response parse: {detail}"))
        }
    }
}

fn parse_id(v: &Value) -> RequestId {
    match v {
        Value::Number(n) => n.as_u64().map(RequestId::Num).unwrap_or(RequestId::Null),
        Value::String(s) => RequestId::Str(s.clone()),
        _ => RequestId::Null,
    }
}

/// Why the prompt pump ended.
enum PromptEnd {
    /// The agent returned a stop reason.
    Stop(StopReason),
    /// The engine cancelled (user / watchdog / step cap) and drained / EOF'd.
    Cancelled,
    /// The agent closed stdout before responding.
    Eof,
    /// The agent returned a response the engine could not treat as a stop
    /// (parse failure / RPC `error` / empty result). Carries the diagnostic so
    /// the turn's `Transient` message names the real cause instead of
    /// "closed stdout".
    Failed(String),
}

// ---------------------------------------------------------------------------
// Pump state -- fold session/update into the trace
// ---------------------------------------------------------------------------

/// The mutable per-turn state the pump accumulates. Mirrors the built-in
/// loop's `CallOutputs` (round-grouped trace); promotions stay empty (gateway
/// side, slice 9c) so only the rounds + terminal text live here.
struct Pump {
    /// The per-round accumulation, oldest first. Round 1 opens at the prompt
    /// (the pre-prompt `Thinking { attempt: 1 }` covers it); a thought or
    /// prose chunk arriving after a round that observed a call opens the next
    /// one (ADR-0103 round boundary = the tool-call batch split, issue #611).
    rounds: Vec<RoundAcc>,
    /// The full agent-message accumulation across the turn -- the terminal
    /// text's fallback when no prose stretch followed the last batch.
    text: String,
    /// Tool calls that started but have not yet reached a terminal status.
    pending: Vec<PendingToolCall>,
    /// Distinct tool calls observed this turn (step-cap counter, ADR-0081).
    tool_call_count: u32,
    /// When `session/cancel` was sent, if it has been (grace tracking).
    cancel_sent_at: Option<Instant>,
    step_cap: u32,
}

/// One round's in-flight accumulation (issue #611): the thought + prose
/// streams the agent emitted since the last tool-call batch, plus the batch's
/// landed calls.
#[derive(Default)]
struct RoundAcc {
    /// The round's frozen thinking block, set when its thought stream ends
    /// (the batch's first tool call, or turn end).
    thinking: Option<ThinkingTrace>,
    /// The live thought accumulation, and when it started (the fold's
    /// duration is measured to the stream's end).
    thinking_buf: String,
    thinking_since: Option<Instant>,
    /// The round's connective prose accumulation (empty = the round carried
    /// no prose).
    text: String,
    /// Whether the round has observed a tool call (landed or pending) -- the
    /// seal that makes a following thought/prose chunk open the next round.
    saw_call: bool,
    calls: Vec<TraceEntry>,
}

/// A tool call that opened a trace row but has not finalized (Completed /
/// Failed). Carries the index of the round it opened in -- a late completion
/// (or the turn-end drain) lands the entry on that round, not whichever round
/// happens to be current.
struct PendingToolCall {
    round: usize,
    tool_use_id: String,
    name: String,
    operation_kind: OperationKind,
    summary: String,
    content: Vec<ToolCallContent>,
}

impl Pump {
    /// The round a thought/prose chunk belongs to: the current one, or a
    /// freshly opened one when the current round already observed a call (the
    /// batch boundary). Opening fires the new round's `Thinking` wait -- the
    /// live channel's round pointer, mirroring the built-in loop's per
    /// round-trip marker.
    fn open_round(&mut self, on_phase: &mut impl FnMut(TurnPhase)) -> &mut RoundAcc {
        if self.rounds.last().is_some_and(|r| r.saw_call) {
            self.rounds.push(RoundAcc::default());
            on_phase(TurnPhase::Thinking {
                attempt: self.rounds.len() as u32,
            });
        }
        self.rounds.last_mut().expect("round 1 opens at the prompt")
    }

    /// Freeze the round's thought stream into its thinking block + emit the
    /// completion event. Idempotent: a second call finds an empty buffer.
    fn freeze_thinking(&mut self, idx: usize, on_phase: &mut impl FnMut(TurnPhase)) {
        let Some(round) = self.rounds.get_mut(idx) else {
            return;
        };
        if round.thinking_buf.is_empty() {
            return;
        }
        let duration_ms = round
            .thinking_since
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        let trace = ThinkingTrace {
            duration_ms,
            text: std::mem::take(&mut round.thinking_buf),
        };
        on_phase(TurnPhase::ThinkingCompleted {
            duration_ms: trace.duration_ms,
            text: trace.text.clone(),
        });
        round.thinking = Some(trace);
    }

    /// The prelude the round's first tool call fires (issue #611): the frozen
    /// thinking block, then the round's prose -- both BEFORE the batch's
    /// `ToolCallStarted` events, the ADR-0103 live order the frontend's round
    /// grouping relies on. Skipped when the round offered neither.
    fn fire_round_prelude(&mut self, idx: usize, on_phase: &mut impl FnMut(TurnPhase)) {
        self.freeze_thinking(idx, on_phase);
        if let Some(round) = self.rounds.get(idx) {
            if !round.text.is_empty() {
                on_phase(TurnPhase::RoundText {
                    text: round.text.clone(),
                });
            }
        }
    }

    fn fold_update(&mut self, update: &SessionUpdate, on_phase: &mut impl FnMut(TurnPhase)) {
        match update {
            SessionUpdate::AgentMessageChunk { content, .. } => {
                if let Some(text) = content.as_text() {
                    self.text.push_str(text);
                    self.open_round(on_phase).text.push_str(text);
                }
            }
            SessionUpdate::AgentThoughtChunk { content, .. } => {
                if let Some(text) = content.as_text() {
                    let round = self.open_round(on_phase);
                    if round.thinking_since.is_none() {
                        round.thinking_since = Some(Instant::now());
                    }
                    round.thinking_buf.push_str(text);
                }
            }
            SessionUpdate::ToolCall {
                tool_call_id,
                title,
                status,
                kind,
                content,
            } => {
                self.tool_call_count += 1;
                let idx = self.rounds.len() - 1;
                // The batch boundary: the round's prelude fires once, before
                // this call's Started event.
                if !self.rounds[idx].saw_call {
                    self.rounds[idx].saw_call = true;
                    self.fire_round_prelude(idx, on_phase);
                }
                let (name, summary) = name_summary(title.as_deref(), tool_call_id);
                let operation_kind = kind
                    .map(|k| k.to_operation_kind())
                    .unwrap_or(OperationKind::Read);
                on_phase(TurnPhase::ToolCallStarted {
                    name: name.clone(),
                    operation_kind,
                    summary: summary.clone(),
                });
                if matches!(status, ToolCallStatus::Completed | ToolCallStatus::Failed) {
                    self.finalize_row(
                        idx,
                        tool_call_id,
                        &name,
                        operation_kind,
                        &summary,
                        content,
                        *status,
                        on_phase,
                    );
                } else {
                    self.pending.push(PendingToolCall {
                        round: idx,
                        tool_use_id: tool_call_id.clone(),
                        name,
                        operation_kind,
                        summary,
                        content: content.clone(),
                    });
                }
            }
            SessionUpdate::ToolCallUpdate {
                tool_call_id,
                status,
                title,
                content,
            } => {
                let pos = self
                    .pending
                    .iter()
                    .position(|p| &p.tool_use_id == tool_call_id);
                if let Some(i) = pos {
                    let mut row = self.pending.remove(i);
                    if let Some(t) = title.as_deref() {
                        if row.summary.is_empty() {
                            row.summary = truncate_trace_excerpt(t, TRACE_EXCERPT_MAX);
                            row.name = t.to_string();
                        }
                    }
                    if !content.is_empty() {
                        row.content = content.clone();
                    }
                    if let Some(final_status) = *status {
                        if matches!(
                            final_status,
                            ToolCallStatus::Completed | ToolCallStatus::Failed
                        ) {
                            self.finalize_row(
                                row.round,
                                &row.tool_use_id,
                                &row.name,
                                row.operation_kind,
                                &row.summary,
                                &row.content,
                                final_status,
                                on_phase,
                            );
                            return;
                        }
                    }
                    self.pending.insert(i, row);
                }
                // An update with no matching pending row (missed the start) is
                // dropped -- the trace stays consistent with the starts seen.
            }
            SessionUpdate::Other => {}
        }
    }

    /// The terminal reply text: the trailing prose stretch (the call-less
    /// last round's chunks) when the agent sent one, else the full
    /// accumulation -- the fallback semantics this slice preserves for agents
    /// that put their answer alongside the final batch.
    fn terminal_text(&self) -> String {
        match self.rounds.last() {
            Some(r) if !r.saw_call && !r.text.is_empty() => r.text.clone(),
            _ => self.text.clone(),
        }
    }

    /// Project the accumulated rounds onto the loop's trace form. The
    /// trailing call-less round is not a round of its own: its prose rode the
    /// terminal text, so only a frozen thinking block keeps it -- a bare
    /// prose-only (or empty) tail drops, keeping the zero-call turn's trace
    /// empty.
    fn settle_rounds(mut self) -> Vec<LoopRound> {
        if self.rounds.last().is_some_and(|r| !r.saw_call) {
            let last = self.rounds.last_mut().expect("checked above");
            last.text.clear();
            if last.thinking.is_none() {
                self.rounds.pop();
            }
        }
        self.rounds
            .into_iter()
            .map(|r| LoopRound {
                thinking: r.thinking,
                text: if r.text.is_empty() {
                    None
                } else {
                    Some(r.text)
                },
                calls: r.calls,
            })
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize_row(
        &mut self,
        round: usize,
        tool_use_id: &str,
        name: &str,
        operation_kind: OperationKind,
        summary: &str,
        content: &[ToolCallContent],
        status: ToolCallStatus,
        on_phase: &mut impl FnMut(TurnPhase),
    ) {
        let success = matches!(status, ToolCallStatus::Completed);
        let result_excerpt = if success {
            String::new()
        } else {
            // Failure: keep the bounded text as the cross-turn failure anchor
            // (ADR-0078). An empty failure excerpt would lose the anchor, so
            // fall back to an honest "failed" marker.
            let text = ToolCallContent::collect_text(content, TRACE_EXCERPT_MAX);
            if text.is_empty() {
                "failed".to_string()
            } else {
                text
            }
        };
        let entry = TraceEntry {
            tool_use_id: tool_use_id.to_string(),
            name: name.to_string(),
            operation_kind,
            summary: summary.to_string(),
            success,
            result_excerpt,
        };
        on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
        self.rounds[round].calls.push(entry);
    }
}

/// Derive a (name, summary) pair from a tool call's title + id. The title is
/// the human-readable description; we use it for both (the bridge's real tool
/// name arrives MCP-side in slice 9b).
fn name_summary(title: Option<&str>, id: &str) -> (String, String) {
    match title.filter(|t| !t.is_empty()) {
        Some(t) => {
            let summary = truncate_trace_excerpt(t, TRACE_EXCERPT_MAX);
            (t.to_string(), summary)
        }
        None => (id.to_string(), id.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Permission decision (ACP session/request_permission -> gateway policy)
// ---------------------------------------------------------------------------

/// Decide the response to an agent's `session/request_permission` (ADR-0081).
/// Maps the tool call to a [`ToolKey`], asks the gateway policy
/// ([`classify`]) whether it is auto-allowed, and selects an allow option if
/// so (or a reject option on fail-fast, ADR-0077 -- the agent self-corrects
/// from a rejection). On cancel, responds `Cancelled`.
///
/// Best-effort emits the in-flow approval card events (ADR-0083) so the
/// frontend can surface that a permission was raised + auto-decided; a sink
/// error must not change the decision.
fn decide_permission(
    adapter: &AdapterSpec,
    params: &RequestPermissionParams,
    approval: &crate::approval::ApprovalState,
    sink: &dyn ApprovalSink,
    cancel: &CancelToken,
) -> RequestPermissionOutcome {
    if cancel.is_requested() {
        return RequestPermissionOutcome::Cancelled;
    }
    let tool_name = params
        .tool_call
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| params.tool_call.tool_call_id.clone());
    // Issue #312: adapter ids are controlled literals (codex / gemini), never
    // the reserved builtin name — `expect` is safe and keeps the type-level
    // invariant visible.
    let key = ToolKey::try_external(adapter.id.as_str(), tool_name)
        .expect("ACP adapter id is not the reserved builtin name");
    let mode = approval.auth_mode();
    let trust: HashSet<ToolKey> = approval.trust_list().into_iter().collect();
    let allowed = classify(&key, mode, &trust) == Classification::Allow;

    let operation_kind = params
        .tool_call
        .kind
        .map(|k| k.to_operation_kind())
        .unwrap_or(OperationKind::Network);
    let body = crate::approval::ApprovalRequestBody {
        request_id: params.tool_call.tool_call_id.clone(),
        server: key.server.clone(),
        tool: key.tool.clone(),
        operation_kind,
        // Reuse `key.tool` (= tool_name with empty-title filter applied) so
        // the summary and tool field stay consistent and we avoid recomputing
        // the title-fallback expression (review M3).
        summary: crate::approval::truncate_summary(&key.tool, crate::approval::SUMMARY_MAX_CHARS),
    };
    if allowed {
        // The policy auto-allows; pick the first allow_* option.
        sink.emit_request(&body);
        let pick = params
            .options
            .iter()
            .find(|o| matches!(o.kind, Some(k) if k.is_allow()));
        let resp = match pick.map(|o| o.kind) {
            Some(Some(wire::PermissionOptionKind::AllowAlways)) => ApprovalResponse::AlwaysAllow,
            _ => ApprovalResponse::AllowOnce,
        };
        sink.emit_resolved(&body, resp);
        match pick {
            Some(o) => RequestPermissionOutcome::Selected {
                option_id: o.id.clone(),
            },
            // Policy allows but the agent offered no allow option (malformed):
            // refuse the call so the agent self-corrects.
            None => RequestPermissionOutcome::Cancelled,
        }
    } else {
        // Fail-fast: pick a reject option so the agent self-corrects
        // (ADR-0077); else Cancelled (no reject available).
        sink.emit_resolved(&body, ApprovalResponse::Deny);
        match params
            .options
            .iter()
            .find(|o| matches!(o.kind, Some(k) if !k.is_allow()))
        {
            Some(o) => RequestPermissionOutcome::Selected {
                option_id: o.id.clone(),
            },
            None => RequestPermissionOutcome::Cancelled,
        }
    }
}

/// A test-only null sink (mirrors the built-in test facade): approvals against
/// the built-in table classify Allow without ever emitting. Exposed so a
/// future in-crate engine unit test can drive the pump without a recording
/// sink.
#[cfg(test)]
pub(crate) struct NullAcpSink;

#[cfg(test)]
impl ApprovalSink for NullAcpSink {
    fn emit_request(&self, _body: &crate::approval::ApprovalRequestBody) {}
    fn emit_resolved(
        &self,
        _body: &crate::approval::ApprovalRequestBody,
        _response: ApprovalResponse,
    ) {
    }
}

/// Test sink that records the last emitted request body (review M1).
#[cfg(test)]
struct RecordingAcpSink {
    last_request: std::sync::Mutex<Option<crate::approval::ApprovalRequestBody>>,
}

#[cfg(test)]
impl RecordingAcpSink {
    fn new() -> Self {
        Self {
            last_request: std::sync::Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl ApprovalSink for RecordingAcpSink {
    fn emit_request(&self, body: &crate::approval::ApprovalRequestBody) {
        *self.last_request.lock().unwrap() = Some(body.clone());
    }
    fn emit_resolved(
        &self,
        _body: &crate::approval::ApprovalRequestBody,
        _response: ApprovalResponse,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::acp::wire::PermissionOptionKind;

    /// name_summary prefers a non-empty title and bounds it; falls back to the
    /// id when the title is missing / empty.
    #[test]
    fn name_summary_prefers_title_and_falls_back_to_id() {
        let (name, summary) = name_summary(Some("explore SELECT 1"), "tc_1");
        assert_eq!(name, "explore SELECT 1");
        assert_eq!(summary, "explore SELECT 1");

        let (name, summary) = name_summary(Some(""), "tc_2");
        assert_eq!(name, "tc_2");
        assert_eq!(summary, "tc_2");

        let (name, _) = name_summary(None, "tc_3");
        assert_eq!(name, "tc_3");
    }

    /// A very long title is bounded to the trace-excerpt cap.
    #[test]
    fn name_summary_bounds_a_long_title() {
        let long = "x".repeat(TRACE_EXCERPT_MAX + 50);
        let (_, summary) = name_summary(Some(&long), "tc");
        assert!(summary.chars().count() <= TRACE_EXCERPT_MAX);
        assert!(summary.ends_with('…'), "bounded summary ends with ellipsis");
    }

    /// decide_permission under no-confirmation selects an allow option.
    #[test]
    fn decide_permission_no_confirmation_selects_allow() {
        use crate::approval::ApprovalState;
        let adapter = crate::runtime::acp::adapter::gemini_cli();
        let approval = ApprovalState::new();
        approval.set_auth_mode(crate::approval::AuthMode::NoConfirmation);
        let params = RequestPermissionParams {
            session_id: "s".into(),
            tool_call: wire::PermissionToolCall {
                tool_call_id: "tc_1".into(),
                title: Some("bash ls".into()),
                kind: Some(wire::ToolKind::Execute),
            },
            options: vec![
                wire::PermissionOption {
                    id: "allow_once".into(),
                    label: "Allow".into(),
                    kind: Some(PermissionOptionKind::AllowOnce),
                },
                wire::PermissionOption {
                    id: "reject".into(),
                    label: "Reject".into(),
                    kind: Some(PermissionOptionKind::RejectOnce),
                },
            ],
        };
        let outcome = decide_permission(
            &adapter,
            &params,
            &approval,
            &NullAcpSink,
            &CancelToken::new(),
        );
        match outcome {
            RequestPermissionOutcome::Selected { option_id } => {
                assert_eq!(option_id, "allow_once");
            }
            other => panic!("expected Selected, got {other:?}"),
        }
    }

    /// decide_permission under per-call + untrusted fail-fasts to a reject
    /// option (the agent self-corrects, ADR-0077).
    #[test]
    fn decide_permission_per_call_untrusted_fail_fasts_to_reject() {
        use crate::approval::ApprovalState;
        let adapter = crate::runtime::acp::adapter::gemini_cli();
        let approval = ApprovalState::new(); // PerCall, empty trust
        let params = RequestPermissionParams {
            session_id: "s".into(),
            tool_call: wire::PermissionToolCall {
                tool_call_id: "tc_1".into(),
                title: Some("bash rm".into()),
                kind: Some(wire::ToolKind::Execute),
            },
            options: vec![
                wire::PermissionOption {
                    id: "allow_once".into(),
                    label: "Allow".into(),
                    kind: Some(PermissionOptionKind::AllowOnce),
                },
                wire::PermissionOption {
                    id: "reject".into(),
                    label: "Reject".into(),
                    kind: Some(PermissionOptionKind::RejectOnce),
                },
            ],
        };
        let outcome = decide_permission(
            &adapter,
            &params,
            &approval,
            &NullAcpSink,
            &CancelToken::new(),
        );
        match outcome {
            RequestPermissionOutcome::Selected { option_id } => {
                assert_eq!(option_id, "reject", "fail-fast picks the reject option");
            }
            other => panic!("expected Selected reject, got {other:?}"),
        }
    }

    /// A cancel in flight short-circuits permission to Cancelled.
    #[test]
    fn decide_permission_cancel_short_circuits() {
        let adapter = crate::runtime::acp::adapter::gemini_cli();
        let approval = crate::approval::ApprovalState::new();
        let cancel = CancelToken::new();
        cancel.request();
        let params = RequestPermissionParams {
            session_id: "s".into(),
            tool_call: wire::PermissionToolCall {
                tool_call_id: "tc_1".into(),
                title: None,
                kind: None,
            },
            options: Vec::new(),
        };
        let outcome = decide_permission(&adapter, &params, &approval, &NullAcpSink, &cancel);
        assert_eq!(outcome, RequestPermissionOutcome::Cancelled);
    }

    /// decide_permission truncates the summary before broadcasting so an
    /// unbounded ACP title cannot flood every pane (review M1 — the gate-side
    /// equivalent is `gate_truncates_summary_before_broadcast` in approval.rs).
    #[test]
    fn decide_permission_truncates_summary_before_broadcast() {
        use crate::approval::ApprovalState;
        let adapter = crate::runtime::acp::adapter::gemini_cli();
        let approval = ApprovalState::new();
        approval.set_auth_mode(crate::approval::AuthMode::NoConfirmation);
        let params = RequestPermissionParams {
            session_id: "s".into(),
            tool_call: wire::PermissionToolCall {
                tool_call_id: "tc_1".into(),
                title: Some("x".repeat(1000)),
                kind: Some(wire::ToolKind::Execute),
            },
            options: vec![wire::PermissionOption {
                id: "allow_once".into(),
                label: "Allow".into(),
                kind: Some(PermissionOptionKind::AllowOnce),
            }],
        };
        let sink = RecordingAcpSink::new();
        let outcome = decide_permission(&adapter, &params, &approval, &sink, &CancelToken::new());
        assert!(matches!(outcome, RequestPermissionOutcome::Selected { .. }));
        let body = sink.last_request.lock().unwrap();
        let body = body.as_ref().expect("request was emitted");
        assert!(
            body.summary.chars().count() <= crate::approval::SUMMARY_MAX_CHARS,
            "broadcast summary {} > {}",
            body.summary.chars().count(),
            crate::approval::SUMMARY_MAX_CHARS
        );
        assert!(body.summary.ends_with("..."));
    }

    /// ADR-0094 dispatch seam: an adapter whose `stream_format` is
    /// `CodexEventStream` routes to the codex event stream driver (not the
    /// ACP path). A nonexistent binary produces a Transient spawn failure
    /// naming the adapter, proving the dispatch fires through the module.
    #[test]
    fn codex_event_stream_dispatches_to_driver() {
        let spec = AdapterSpec {
            id: crate::runtime::acp::adapter::AdapterId::new("stub-test"),
            display_name: "stub-test",
            binary_names: &["nonexistent"],
            argv: &["--json"],
            stream_format: StreamFormat::CodexEventStream,
            probe_argv: Some(&["probe"]),
            model_arg: None,
            effort: None,
        };
        let cancel = Arc::new(CancelToken::new());
        let engine = AcpEngine::new(spec, cancel);
        let input = AcpTurnInput {
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            mcp_servers: Vec::new(),
            model: None,
            thought_level: None,
            prompt_blocks: Vec::new(),
        };
        let approval = crate::approval::ApprovalState::new();
        let sink = RecordingAcpSink::new();
        let outcome = engine.run(
            &input,
            std::path::Path::new("/nonexistent-binary-523"),
            &approval,
            &sink,
            |_| {},
        );
        match &outcome.termination {
            Termination::Transient(msg) => {
                assert!(
                    msg.contains("stub-test"),
                    "spawn failure names the adapter: {msg}"
                );
            }
            other => panic!("expected Transient from spawn failure, got {other:?}"),
        }
        assert!(
            outcome.trace.is_empty(),
            "a spawn failure dispatched nothing"
        );
    }

    /// ADR-0097 dispatch seam: an adapter whose `stream_format` is
    /// `ClaudeStreamJson` routes to the claude stream-json driver (not the
    /// ACP path, not the codex parser). Same nonexistent-binary proof shape
    /// as the codex arm above.
    #[test]
    fn claude_stream_json_dispatches_to_driver() {
        let spec = AdapterSpec {
            id: crate::runtime::acp::adapter::AdapterId::new("stub-claude"),
            display_name: "stub-claude",
            binary_names: &["nonexistent"],
            argv: &["--print", "--output-format", "stream-json"],
            stream_format: StreamFormat::ClaudeStreamJson,
            probe_argv: Some(&["probe"]),
            model_arg: None,
            effort: None,
        };
        let cancel = Arc::new(CancelToken::new());
        let engine = AcpEngine::new(spec, cancel);
        let input = AcpTurnInput {
            cwd: std::env::temp_dir().to_string_lossy().to_string(),
            mcp_servers: Vec::new(),
            model: None,
            thought_level: None,
            prompt_blocks: Vec::new(),
        };
        let approval = crate::approval::ApprovalState::new();
        let sink = RecordingAcpSink::new();
        let outcome = engine.run(
            &input,
            std::path::Path::new("/nonexistent-binary-561"),
            &approval,
            &sink,
            |_| {},
        );
        match &outcome.termination {
            Termination::Transient(msg) => {
                assert!(
                    msg.contains("stub-claude"),
                    "spawn failure names the adapter: {msg}"
                );
            }
            other => panic!("expected Transient from spawn failure, got {other:?}"),
        }
        assert!(
            outcome.trace.is_empty(),
            "a spawn failure dispatched nothing"
        );
    }
}
