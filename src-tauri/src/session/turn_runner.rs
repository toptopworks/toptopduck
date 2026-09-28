//! The turn runner species (ADR-0053 Decision 1): the session's turn
//! orchestration, both runtime faces in one file. [`super::Session::ask_with_phase`]
//! is the single turn entry -- it assembles the turn's window, tool tables,
//! gates, and channels, then dispatches one arm per runtime: the built-in
//! loop (`loop_runtime`) or the external ACP adapter path
//! (`run_external_turn`, which also lands the discovered-runtime snapshot,
//! ADR-0095). Both arms return the same `(TurnOutcome, trace)` shape, and
//! the settled outcome crosses back to the facade's `record_turn` -- the
//! conversation timeline + persistence stay on `session/mod.rs` (ADR-0053
//! Decision 1: they are session concerns, not turn orchestration).
//!
//! `TurnInputs` rides along as the turn's data vocabulary -- everything
//! "passed in" rather than wired -- re-exported by the parent module so the
//! pub turn entry and its parameter type share one public path (the dual
//! path `resume` already rides).
//!
//! The shape is an `impl super::Session` block, not the standalone TurnRunner
//! struct ADR-0053 Decision 1 drew: that struct's roles evolved into the
//! materializer / loop_runtime / outcome_merge species with the session
//! state borrowed per turn through `TurnDeps` (Decision 2/4) -- the
//! boundary, not the struct, is what this file holds.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::approval::{ApprovalSink, ApprovalState};
use crate::mcp::config::McpServerConfig;
use crate::model::{TurnFailure, TurnOutcome, TurnPhase, TurnRecord, TurnRuntime};
use crate::provider::keychain::KeychainStore;
use crate::provider::prompt::ResponseLocale;
use crate::runtime::acp::adapter::{detect_adapter, AdapterSpec};
use crate::runtime::acp::engine::{AcpEngine, AcpTurnInput};
use crate::runtime::acp::wire::McpServer;
use crate::runtime::gateway::server::{bind_gateway, serve_connection, GatewayCtx};
use crate::session::loop_contract::{LoopOutcome, LoopRound};
use crate::session::loop_runtime;
use crate::session::materializer::TurnDeps;
use crate::session::outcome_merge::{merge_outcomes, turn_outcome_from_loop};
use crate::session::skills::SkillTurnState;
use crate::skills::SkillPromptFragment;
use crate::window;

use super::{
    bridge_bin_path, now_epoch_ms, turn_start_invoked, BUILT_IN_RUNTIME_FACE, ENV_PORT, ENV_TOKEN,
    GATEWAY_SERVER_NAME,
};

/// The per-turn borrowed data inputs for [`super::Session::ask_with_phase`] (issue
/// #378): the effective MCP servers, the keychain for secret env resolution,
/// the discovery snapshot's prompt fragments, the user's materialized skill
/// invocations, the machine-level disabled skill names, the skills registry
/// root, the CLI tool configs, and the delegation specs. All of these are
/// "data passed in" rather than orchestration concerns -- the approval
/// state / sink / phase callback are wiring, not data -- so they collapse
/// into one struct. The turn-scope skill pair (the pending invocation
/// accumulation + the turn-start invoked snapshot) rides its own bundle,
/// [`SkillTurnState`] (issue #989 D) -- a mutable turn channel the runtime
/// faces write into, not submit data -- so neither `run_external_turn`
/// (9 params, `#[allow]` retained) nor `ask_with_phase` grows as invocation
/// semantics extend.
pub struct TurnInputs<'a> {
    /// The effective MCP server configs for this turn (the config-level
    /// enabled slice, computed at the command boundary -- ADR-0106 single
    /// axis). The gateway connects each one per turn (ADR-0076).
    pub mcp_servers: &'a [McpServerConfig],
    /// Borrow of the OS keychain (ADR-0029). The gateway reads each server's
    /// secret env values at spawn; the values never cross IPC back out.
    pub keychain: &'a KeychainStore,
    /// The discovery snapshot's prompt fragments (ADR-0119 Decision 3,
    /// issue #983): the session-creation enabled set resolved into index
    /// rows. Both runtime surfaces render the metadata index from this
    /// slice wholesale -- bodies no longer ride the standing disclosure
    /// (each invocation expands once, at its call site, into the turn).
    pub skills: &'a [SkillPromptFragment],
    /// The user's submit-time skill invocations (ADR-0119 Decision 1; the
    /// ADR-0112 picker channel): already materialized -- bodies + hashes
    /// pinned at submit -- they ride the window ahead of the question and
    /// the turn's record.
    pub user_invocations: &'a [crate::model::SkillInvocation],
    /// The machine-level disabled skill names (ADR-0118 enablement axis):
    /// the `invoke_skill` gate reads them mid-turn (invocation eligibility
    /// is the enable axis, not the snapshot). A plain slice -- name-volume is
    /// registry-sized (tens), so a linear contains beats set ceremony.
    pub disabled_skills: &'a [String],
    /// The skills registry root (ADR-0111, issue #714): the attachment read
    /// surface resolves names against it live, mid-turn. The root rides the
    /// turn's data (the same "data passed in" posture as `skills`), keeping
    /// the session I/O-free for skill content.
    pub skills_root: &'a std::path::Path,
    /// The live-config handle (ADR-0122 Decision 1): the `create_skill`
    /// meta-tool's mint needs the config write (the stale-disabled-entry
    /// clear that lands a rebirth enabled) -- the one deliberate config
    /// reachability the turn's data carries. `None` marks a config-less
    /// session (tests): the tool then never advertises on either surface.
    pub live_config: Option<&'a crate::LiveProviderConfig>,
    /// The effective CLI tool registrations for this turn (the config-level
    /// enabled slice, ADR-0106 single axis -- issue #671, ADR-0108). The
    /// turn direct-lists them into the tool table and dispatches their
    /// calls to the spawn engine.
    pub cli_tools: &'a [crate::cli_tools::config::CliToolConfig],
    /// The turn's enabled agent-definition snapshot (issue #933, ADR-0117):
    /// the command boundary's registry scan, already skill-resolved. Each
    /// spec direct-lists one named delegation tool into the table; a
    /// delegation call runs a sub-agent over the subtracted face whose own
    /// dispatches keep crossing the same shared core.
    pub delegations: &'a [crate::agents::DelegationSpec],
}

impl<'a> TurnInputs<'a> {
    /// Build a no-MCP / no-skill input set -- the common case in tests and the
    /// non-command path ([`super::Session::ask`]). Borrows the caller-owned keychain;
    /// `Default` is impossible because the keychain field is a borrowed (not
    /// owned) type.
    pub fn empty(keychain: &'a KeychainStore) -> Self {
        Self {
            mcp_servers: &[],
            keychain,
            skills: &[],
            user_invocations: &[],
            disabled_skills: &[],
            skills_root: std::path::Path::new(""),
            live_config: None,
            cli_tools: &[],
            delegations: &[],
        }
    }
}

impl super::Session {
    /// Snapshot the turn's discovered runtime catalog onto the session
    /// (ADR-0095). Called from BOTH `run_external_turn` faces that follow a
    /// completed handshake -- the serve-Ok merge path and the serve-failure
    /// early return (#856) -- because the handshake's discovery is real
    /// state the next turn reuses regardless of how the turn settles. A
    /// serve failure that lands before the handshake produced discovery
    /// yields `None` and the snapshot no-ops; the `None` semantics ("no
    /// discovery", the previous catalog survives) live on the reader,
    /// [`Self::last_discovered_runtime`].
    fn snapshot_discovered_runtime(&mut self, outcome: &LoopOutcome) {
        if let Some(discovered) = outcome.discovered_runtime.clone() {
            self.set_last_discovered_runtime(discovered);
        }
    }

    /// Run one turn AND surface its discrete progress events (ADR-0059,
    /// calibrated by ADR-0078). Same semantics as [`Self::ask`]; the
    /// `on_phase` callback receives the [`TurnPhase`] event stream: Thinking
    /// before each provider round-trip (carrying the 1-based step so a
    /// multi-step trajectory reads honestly, "step N") and the
    /// ToolCallStarted / ToolCallCompleted pair around each tool dispatch --
    /// the trace's live form, so the rail renders the in-flight turn
    /// progressively. The command layer wraps this callback to emit the
    /// side-channel `turn-progress` Tauri event addressed by sessionId
    /// (ADR-0056/0059); the events never enter the [`TurnOutcome`] contract.
    ///
    /// `approval` + `sink` are the session's tiered-approval gateway
    /// (ADR-0080/0083): the store-attached [`ApprovalState`] the
    /// `respond_tool_approval` command wakes, and the Tauri sink that emits
    /// the approval-card events. Both live at the command boundary (the only
    /// layer holding an AppHandle, ADR-0029) and are borrowed per turn, so the
    /// Session stays unparameterized across `commands.rs`.
    pub fn ask_with_phase(
        &mut self,
        question: &str,
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
        on_phase: impl FnMut(TurnPhase) + Send + 'static,
        inputs: &TurnInputs<'_>,
    ) -> TurnOutcome {
        // Facade over the agent loop (ADR-0081, issue #318): assemble the
        // windowed tool-calling request (system prompt + tool table + windowed
        // history, via the window assembler), drive the loop with the shared
        // session state borrowed via TurnDeps + the session's own
        // materializer, map the structured LoopOutcome onto the four-way
        // TurnOutcome, then record it. `record_turn` stays on the facade (the
        // conversation timeline + persistence are session concerns, not turn
        // orchestration -- ADR-0053 Decision 2).
        let turns = self.turns();
        let locale = self.provider.response_locale();
        // ADR-0101: the turn's runtime attribution, snapshotted at the turn
        // top -- the same dispatch the match below reads, taken BEFORE it so
        // the recorded attribution is the turn's own even if the selector
        // changes while the turn runs. An external turn names its adapter
        // (the stable id, persisted + mirrored across IPC); a built-in turn
        // records only the kind. Every outcome kind records it, including a
        // failed external spawn -- the turn was still the external runtime's
        // to run.
        let attribution = match &self.external_runtime {
            Some(spec) => TurnRuntime::External {
                adapter_id: Some(spec.id.as_str().to_string()),
            },
            None => TurnRuntime::BuiltIn,
        };
        // ADR-0119 (issue #983): the turn's accumulating invocation records.
        // The user's submit-time materialization starts the vec; the agent's
        // `invoke_skill` calls append mid-turn through the invocation
        // channel; the whole lands on the turn record at `record_turn` (and
        // the turn's provenance derives from it there).
        let mut pending_invocations: Vec<crate::model::SkillInvocation> =
            inputs.user_invocations.to_vec();
        // The turn-start invoked-set snapshot (ADR-0119 Decision 4): the
        // read-gate eligibility and the read-tool mount read this. The
        // session's monotonic fold PLUS this turn's user invocations -- a
        // user invocation is turn INPUT (assembled ahead of the question),
        // not a mid-turn mutation, so it reads within its own turn (unlike
        // an agent's mid-turn invoke_skill, which joins the NEXT turn's
        // snapshot -- the ADR-0111 no-competition posture, carried over).
        let turn_invoked = turn_start_invoked(&self.invoked_skills, inputs.user_invocations);
        // The turn-scope skill bundle (issue #989 D): the pending records +
        // the turn-start snapshot travel as one parameter through both
        // runtime faces, and `record_turn` consumes it by value.
        let mut skill_state = SkillTurnState {
            pending: &mut pending_invocations,
            start_invoked: &turn_invoked,
        };
        // ADR-0103 (issue #608): the turn's asked-at timestamp, captured at
        // submit (before any round-trip starts) so the recorded value marks
        // the user's ask, not the first provider reply. Stamped onto the
        // TurnRecord + recipe turn at `record_turn`.
        let asked_at = now_epoch_ms();
        // ADR-0124 (issue #1087): the turn's accumulating `present_files`
        // declarations -- the tool channel's counterpart to
        // `pending_invocations`, consumed by value at `record_turn` where
        // it merges with the reply-text scan. The external arm leaves it
        // empty (external CLIs never see the tool).
        let mut presented_files: Vec<String> = Vec::new();
        // The external-runtime branch (issue #299 slice 9c, ADR-0085) replaces
        // the built-in agent loop when an adapter is set; otherwise the built-in
        // loop runs (ADR-0081). Both return a `(outcome, trace)` pair; the
        // post-turn discard + `record_turn` path stays shared (ADR-0055 +
        // ADR-0078). `on_phase` moves into exactly one arm (match arms are
        // exclusive), so the built-in closure and the external engine cannot
        // both hold it.
        let (outcome, trace) = match self.external_runtime.clone() {
            Some(adapter) => self.run_external_turn(
                question,
                &turns,
                locale,
                adapter,
                approval,
                sink,
                on_phase,
                &mut skill_state,
                inputs,
            ),
            None => {
                // Built-in runtime turn (ADR-0081, driven by the loop
                // runtime since ADR-0116 / issue #918): assemble the
                // windowed tool-calling request (ADR-0023 windowing is
                // the app's), then drive the
                // UPSTREAM stateless loop with the shared session state and
                // map the structured LoopOutcome onto TurnOutcome. Single
                // track by decision: the loop runtime is the only built-in
                // loop (each predecessor retired, #670 / #919); there is no
                // runtime switch and no fallback.
                let mut request = window::assemble_tool_turn(
                    question,
                    &self.working_set,
                    &turns,
                    locale,
                    inputs.skills,
                    inputs.user_invocations,
                );
                // ADR-0103 (issue #614): the session posture's thought-level
                // rides the built-in turn's provider request. Read from the
                // same `runtime_facts` storage the ACP turn input injects
                // from -- one source, no mirror (issue #530). The value is
                // read once here, at dispatch: a posture change mid-turn
                // cannot flip thinking on/off between the turn's rounds (an
                // API-invalid interleaving). `None` leaves the request
                // thinking-disabled, byte-identical to the status quo.
                request.thought_level = self.runtime_facts.thought_level.clone();
                // Disjoint field borrows: `TurnDeps` borrows
                // `&self.admin_engine` / `&mut self.source_files` /
                // `&mut self.working_set` / `&self.temp_path` and the loop
                // takes `&mut *self.materializer` (the provider crosses into
                // the loop as an `Arc` clone, not a borrow) -- distinct
                // Session fields, so they coexist without widening to
                // `&mut self`. The block scope drops the borrows before
                // `record_turn` takes its own `&mut self`.
                let (outcome, trace) = {
                    // Connect the user's configured external MCP servers
                    // (issue #301 slice C-loop / slice D): same per-turn
                    // lifecycle as the gateway path (ADR-0076 Decision +
                    // ADR-0085 Consequences -- spawn + initialize each stdio
                    // server here, drop at scope end so the spawned children
                    // die with the aggregator). The external surface is the
                    // fixed meta-tool trio (ADR-0105): it extends the
                    // request's tool table only when a server connected
                    // this turn, and execute_call serves the trio locally
                    // (list / search) or resolves an invoke's handle before
                    // the enforcement points. The per-server connect
                    // outcomes feed `mcp_list_servers`: a failed connect
                    // stays visible in the manifest while the catalog holds
                    // only the connected servers.
                    let mut mcp = crate::mcp::aggregator::McpAggregator::with_tool_output(
                        self.tool_output_path(),
                    );
                    // Cancel-aware teardown (issue #889; connect phase added
                    // by #892): a token fire while the loop is live
                    // terminates every connected transport, unblocking a
                    // tools/call parked inside the dispatch freeze. Arming
                    // runs BEFORE `connect_all` (#892): the watcher expires
                    // each pre-registered connect slot, so a token fire
                    // during the connect phase kills the parked handshake
                    // read instead of waiting out each hung server's budget
                    // (the between-attempts gap check rides the same token).
                    // The flag is RAII ([`TurnDoneFlag`]): dropping it at
                    // block end stands the watcher down whatever way the
                    // block exits -- normal return or a panicking turn -- so
                    // a normally finished turn tears down through the
                    // aggregator's own `Drop` and a panicking turn cannot
                    // leak its poller.
                    let mcp_turn_done = crate::mcp::aggregator::TurnDoneFlag::new();
                    mcp.arm_cancel_teardown(Arc::clone(&self.cancel), mcp_turn_done.flag());
                    mcp.connect_all(inputs.mcp_servers, inputs.keychain);
                    request.tools.extend(mcp.meta_tool_definitions());
                    // ADR-0108 Decision 6: the enabled CLI registrations are
                    // DIRECT-LISTED into the tool table (never via the
                    // discovery trio -- that surface stays MCP-only).
                    request
                        .tools
                        .extend(crate::cli_tools::config::tool_definitions(inputs.cli_tools));
                    // The skill-invocation meta-tool (ADR-0119 Decision 4,
                    // issue #983): mounted iff the turn's discovery snapshot
                    // is non-empty (the fragments resolve FROM the snapshot,
                    // so the two emptiness tests agree) -- the trio's
                    // conditional-attachment posture (ADR-0105 Decision 6).
                    // An empty discovery snapshot pays no standing tool cost.
                    if !inputs.skills.is_empty() {
                        request
                            .tools
                            .push(crate::skills::invocation::invoke_skill_definition());
                    }
                    // The skill-attachment read surface (ADR-0111 Decision 1
                    // calibrated by ADR-0119 Decision 4): mounted iff the
                    // session-INVOKED set is non-empty -- only an invoked
                    // skill's files are readable, so a session that invoked
                    // nothing pays no standing tool cost. A mid-turn
                    // invocation joins the NEXT turn's snapshot (Decision 3's
                    // no-competition posture, carried over).
                    if !skill_state.start_invoked.is_empty() {
                        request
                            .tools
                            .push(crate::skills::read::read_skill_file_definition());
                    }
                    // The skill-creation meta-tool (ADR-0122 Decision 1):
                    // mounted iff the live-config handle rides the turn's
                    // inputs (the mint needs the config write). Unconditional
                    // beyond that -- unlike the read-shaped pair above, a
                    // session pays the standing tool cost whatever its
                    // snapshot holds: this is the creation channel.
                    if inputs.live_config.is_some() {
                        request
                            .tools
                            .push(crate::skills::create::create_skill_definition());
                    }
                    // The named delegation tool family (issue #933, ADR-0117
                    // Decision 1): one tool per enabled agent definition,
                    // direct-listed like the CLI tools. A delegation call
                    // runs a sub-agent the loop runtime constructs from the
                    // spec; disabled definitions simply never list.
                    for spec in inputs.delegations {
                        request.tools.push(spec.tool_definition());
                    }
                    // The artifact-delivery meta-tool (ADR-0124 Decision 1,
                    // issue #1087): mounted unconditionally on the built-in
                    // runtime's table -- the tool face the system prompt's
                    // mandatory delivery clause backs. The declarations
                    // land on `presented_files` and merge with the reply
                    // scan at settle (`record_turn`). Bridge face never
                    // lists it (external CLIs are scan-channel-only).
                    request
                        .tools
                        .push(crate::session::artifacts::present_files_definition());
                    let mut deps = TurnDeps {
                        engine: &self.admin_engine,
                        source_files: &mut self.source_files,
                        working_set: &mut self.working_set,
                        result_row_cap: self.result_row_cap,
                        result_count_cap: self.result_count_cap,
                        temp_path: &self.temp_path,
                        tool_output_refs: &mut self.tool_output_refs,
                    };
                    // The attachment read gate (ADR-0111, calibrated by
                    // ADR-0119): pure classification (no transitions, no
                    // persist), so an immutable bundle -- the turn-start
                    // session-INVOKED snapshot for eligibility, the
                    // enable-axis disabled names (a disabled name's landed
                    // record opens no files), and the registry root for
                    // the live name resolution.
                    let read_gate = crate::skills::read::SkillReadGate {
                        invoked: skill_state.start_invoked,
                        disabled: inputs.disabled_skills,
                        root: inputs.skills_root,
                    };
                    // The creation channel's bundle (ADR-0122 Decision 1):
                    // the registry root + the live-config handle (the mint's
                    // stale-disabled-entry clear needs the config write).
                    // `None` (a config-less test session) never advertises
                    // the tool -- the dispatch arms' guard is defensive only.
                    let create_gate = crate::skills::create::SkillCreateGate {
                        root: inputs.skills_root,
                        live: inputs.live_config,
                    };
                    // The mid-turn invocation channel (ADR-0119 Decision 4):
                    // `invoke_skill` appends to the turn's pending records
                    // and reads the registry live (invocation-time bytes).
                    // Field-disjoint from every borrow above -- the snapshot
                    // is an immutable read of `self.discovery_snapshot`.
                    // The gateway branch below wires its channel through the
                    // SAME constructor, so the two faces cannot drift (#987).
                    let mut invocation_channel =
                        crate::skills::invocation::SkillInvocationCtx::from_session(
                            &mut *skill_state.pending,
                            &self.discovery_snapshot,
                            inputs,
                        );
                    // The switchover (ADR-0116, issue #918): `turn_loop_for`
                    // is the seam's single entry -- a profile-backed provider
                    // constructs the upstream model (sealed inside
                    // `session::loop_runtime`; no upstream type is named
                    // here), a refused facts resolution short-circuits into
                    // the same terminal vocabulary the adapters used.
                    //
                    // Live-phase ordering (issue #668 tail, decided at wiring
                    // time): phases flow from two threads (this thread's
                    // dispatch server + the driver's fold emissions) through
                    // the shared sink, so cross-source ordering is best-effort
                    // -- and stays that way by decision. Phases are transient
                    // UI progress hints (the trace is the ordered, persisted
                    // surface, and `Thinking` carries its 1-based attempt so
                    // a late arrival self-corrects), while a barrier would
                    // couple the dispatch server to the driver's fold cadence
                    // -- a cross-thread round-trip per phase that buys spinner
                    // stability at real deadlock surface.
                    let mut loop_outcome =
                        match loop_runtime::turn_loop_for(Arc::clone(&self.provider)) {
                            Err(termination) => LoopOutcome {
                                termination,
                                promotions: Vec::new(),
                                trace: Vec::new(),
                                discovered_runtime: None,
                            },
                            Ok(runner) => runner.run(
                                &request,
                                &mut deps,
                                &mut *self.materializer,
                                &mut mcp,
                                inputs.cli_tools,
                                inputs.delegations,
                                &mut invocation_channel,
                                &mut presented_files,
                                &read_gate,
                                &create_gate,
                                approval,
                                sink,
                                Arc::clone(&self.cancel),
                                on_phase,
                            ),
                        };
                    // The MCP cancel-teardown watcher stands down through
                    // `mcp_turn_done`'s Drop at block end (issue #889) --
                    // no manual store to skip on an unwinding path.
                    // The loop's real multi-call trace rides alongside the
                    // mapped outcome to record_turn (ADR-0078, issue #319): the
                    // mapper stays focused on the four-way classification, so
                    // the trace rides separately rather than folded into
                    // TurnOutcome -- which crosses IPC as the outcome contract
                    // alone; the trace's DISPLAY view lands on the TurnRecord
                    // at record_turn (issue #297), never on the outcome.
                    // `turn_outcome_from_loop` reads only `termination` +
                    // `promotions`, so the trace is moved out before the outcome
                    // is mapped (no clone on the per-turn record path);
                    // `mem::take` leaves an empty Vec the mapper ignores.
                    let trace = std::mem::take(&mut loop_outcome.trace);
                    (
                        turn_outcome_from_loop(
                            loop_outcome,
                            self.session_id.as_ref(),
                            BUILT_IN_RUNTIME_FACE,
                        ),
                        trace,
                    )
                };
                (outcome, trace)
            }
        };
        // ADR-0055 post-turn discard: if `close_session` marked this session
        // closing while the turn was in flight (it also fired cancel, so the
        // outcome is typically Cancelled, but a turn that squeaked through in
        // the narrow window is discarded too), drop the outcome -- no thread
        // append, no recipe persist. The cancelled turn must not enter the
        // productive chain (ADR-0021) or the recipe (ADR-0034). NOTE: this
        // skips `record_turn` only; `run` may already have materialized a
        // `result_N` into the working set / admin connection (try_materialize
        // runs before this check), but the session is being torn down so that
        // in-memory state is dropped with it and never observed. Log the
        // discard so an operator can tell a close-induced drop apart from a
        // normal user cancel (the outcome alone reads as Cancelled either way).
        if self.is_closing() {
            log::info!(
                target: "toptopduck::session",
                "discarding in-flight turn: session closed during the turn (ADR-0055)"
            );
            return outcome;
        }
        self.record_turn(
            question,
            outcome,
            trace,
            skill_state.into_pending(),
            attribution,
            asked_at,
            presented_files,
        )
    }

    /// Drive one external-runtime turn (issue #299 slice 9c, ADR-0085).
    ///
    /// Spawns the external CLI via [`AcpEngine`], which injects the bridge MCP
    /// descriptor at `session/new`; the CLI launches the bridge, the bridge
    /// connects back to a per-bridge gateway, and the gateway serves the
    /// built-in tool table + routes every `tools/call` through the approval
    /// gate + [`crate::tools::dispatch`] -- the same path the built-in loop
    /// takes (ADR-0076 single enforcement point). The gateway serve loop and
    /// the ACP engine run on two scoped threads (ADR-0085); this method joins
    /// both, merges their outcomes (trace de-duplicated: gateway authoritative
    /// for gateway-routed tools, ACP pump for the CLI's own built-in tools),
    /// and returns the same `(TurnOutcome, trace)` shape the built-in branch
    /// does so [`Self::ask_with_phase`]'s post-turn path is shared.
    // Cannot collapse further: question / history / locale / adapter are
    // external-runtime orchestration params with no natural grouping (unlike
    // the data inputs in TurnInputs); approval / sink / on_phase are per-turn
    // wiring callbacks (see TurnInputs doc), not data; the turn-scope skill
    // pair rides SkillTurnState (#989 D) -- one mutable channel and one read
    // snapshot of the same turn, neither orchestration- nor TurnInputs-shaped.
    #[allow(clippy::too_many_arguments)]
    fn run_external_turn<O: FnMut(TurnPhase) + Send>(
        &mut self,
        question: &str,
        history: &[TurnRecord],
        locale: ResponseLocale,
        adapter: AdapterSpec,
        approval: &ApprovalState,
        sink: &dyn ApprovalSink,
        on_phase: O,
        skill_state: &mut SkillTurnState<'_>,
        inputs: &TurnInputs<'_>,
    ) -> (TurnOutcome, Vec<LoopRound>) {
        // 1. Resolve the CLI binary. Not-on-PATH -> an external-runtime
        //    failure (the engine never spawns; nothing to clean up).
        let binary = match detect_adapter(&adapter) {
            Some(p) => p,
            None => {
                return (
                    TurnOutcome::Failed(TurnFailure::Runtime {
                        detail: format!("external runtime `{}` not found on PATH", adapter.id),
                    }),
                    Vec::new(),
                );
            }
        };
        // 2. Bind the per-bridge gateway (random localhost port + 64-hex
        //    token). Bind failure is rare (OS port exhaustion) but surfaces
        //    honestly.
        let handle = match bind_gateway() {
            Ok(h) => h,
            Err(e) => {
                return (
                    TurnOutcome::Failed(TurnFailure::Runtime {
                        detail: format!("gateway bind failed: {e}"),
                    }),
                    Vec::new(),
                );
            }
        };
        // 3. Build the bridge MCP descriptor. The CLI launches this binary as
        //    its MCP server; the bridge reads port + token from env and
        //    connects back to the gateway (ADR-0085 per-bridge lifecycle). A
        //    missing bin path surfaces as an external-runtime failure (the
        //    gateway was bound but never served; dropping the handle releases
        //    the port).
        let bin_path = match bridge_bin_path() {
            Ok(p) => p,
            Err(detail) => {
                return (
                    TurnOutcome::Failed(TurnFailure::Runtime { detail }),
                    Vec::new(),
                );
            }
        };
        let env = BTreeMap::from([
            (ENV_PORT.to_string(), handle.port.to_string()),
            (ENV_TOKEN.to_string(), handle.token.clone()),
        ]);
        let mcp_server = McpServer::stdio_bridge(GATEWAY_SERVER_NAME, bin_path, Vec::new(), env);
        // 4. Assemble the prompt blocks (leading context: locale + schema;
        //    skill block before question; M-contract via gateway tool table).
        let prompt_blocks = window::assemble_acp_turn(
            question,
            &self.working_set,
            history,
            locale,
            inputs.skills,
            inputs.user_invocations,
        );
        let input = AcpTurnInput {
            cwd: self.temp_path.to_string_lossy().to_string(),
            mcp_servers: vec![mcp_server],
            // ADR-0095: the session-level model / thought-level choices ride
            // the turn input (injected per-format inside the engine: ACP
            // set_config_option requests, non-ACP argv). Read from the
            // SAME `runtime_facts` the persister layers onto the recipe
            // header -- one storage, no mirror to drift (issue #530). `None`
            // leaves the CLI's own defaults in place.
            model: self.runtime_facts.model.clone(),
            thought_level: self.runtime_facts.thought_level.clone(),
            prompt_blocks,
        };
        // 5. Drive the gateway serve + the ACP engine on two scoped threads.
        //    The gateway borrows the session's live resources (engine / working
        //    set / materializer / approval / sink / cancel) for `tools/call`
        //    dispatch; the engine drives the ACP protocol with no session
        //    borrows. Scoped threads let the non-`'static` borrows cross the
        //    thread boundary; the two `&` params (approval / sink) are `Copy`
        //    backed by `Sync` types, so both threads may hold them.
        // The ACP engine runs on a scoped thread (it drives the CLI; the CLI
        // spawns the bridge, the bridge connects back to the gateway). The
        // gateway serve runs on THIS thread because `duckdb::Connection` is
        // `!Sync` -- its statement cache + inner handle are `RefCell`-guarded,
        // so `&Connection` is `!Send` and cannot cross a thread boundary. The
        // engine holds no session borrows (owned input/binary/adapter + an
        // `Arc` cancel clone + `&approval`/`&sink`, which are `Sync`-backed) +
        // the `Send`-bounded `on_phase`, so it crosses cleanly; the serve loop
        // keeps the session's live resources on the thread that owns them
        // (ADR-0085: serve borrows in place, engine drives in parallel).
        // The kill-log face (#886): captured before the engine takes
        // ownership of the spec below.
        let runtime_face = adapter.id.as_str();
        let (acp_outcome, gateway_result) = std::thread::scope(|s| {
            let engine = AcpEngine::new(adapter, Arc::clone(&self.cancel));
            // Deterministic serve terminator (issue #357 / ADR-0085): a one-shot
            // flag the engine thread sets when its prompt pump returns. The pump
            // returning means the CLI sent its final session/prompt response,
            // so every tools/call it sent was already served synchronously --
            // serve_connection polls this at its loop top + returns the outcome
            // without waiting for the bridge to close the TCP connection. On
            // Linux the stdio-spawned bridge inherits a leaked stdin write-end
            // (Rust std limitation) and never EOFs, so without this flag serve
            // would park on the bridge socket until the armed no-progress
            // clock fired on the silent generation and the serve's loop-top
            // cancel check exited -- a cap-bounded exit, but a slow one that
            // mislabels a finished turn as a watchdog kill. Production
            // Node-spawned bridges do not leak the fd, but relying on the
            // bridge to close promptly is a correctness gap the flag closes.
            // The engine thread sets the flag when its prompt pump returns. The
            // flag is an `Arc<AtomicBool>` (not a borrowed `&AtomicBool`) because
            // `thread::scope`'s `spawn` requires the closure's captures to be
            // valid for the full `'scope` lifetime, and the borrow checker will
            // not promote a borrow of a scope-body-local to `'scope` -- so the
            // shared reference must be heap-backed. `Arc` is the minimal form.
            let engine_done = Arc::new(AtomicBool::new(false));
            let done_flag = Arc::clone(&engine_done);
            let eng = s.spawn(move || {
                let outcome = engine.run(&input, &binary, approval, sink, on_phase);
                done_flag.store(true, Ordering::SeqCst);
                outcome
            });
            // Connect the user's configured external MCP servers (issue #301
            // slice C-gw / slice D). Per-turn (ADR-0076 Q2): spawn + initialize
            // each stdio server here so the gateway advertises its tools
            // alongside the built-in table and routes namespaced tools/call
            // back through the aggregator. A failed connect logs + skips that
            // server rather than failing the turn (McpAggregator::connect_all
            // / connect_one); the spawned children die with the aggregator
            // when the `GatewayCtx` that owns it returns from
            // `serve_connection`, below. The per-server connect outcomes are
            // discarded (the
            // per-session status IPC that consumed them is retired, ADR-0106;
            // a failed connect logs + skips inside connect_one).
            let mut mcp =
                crate::mcp::aggregator::McpAggregator::with_tool_output(self.tool_output_path());
            // Cancel-aware teardown (issue #889; connect phase added by
            // #892): arming runs BEFORE `connect_all` -- the watcher
            // expires each pre-registered connect slot, so a token fire
            // during the connect phase kills the parked handshake read
            // instead of waiting out each hung server's budget (the
            // between-attempts gap check rides the same token). The
            // stand-down signal is the RAII turn flag (issue #897), NOT
            // `engine_done`: the engine thread parks ahead of the connects,
            // and a fast-finishing CLI stores `engine_done` while the
            // connects are still parked -- standing the watcher down over a
            // turn that has not unwound yet would leave that window's token
            // fire unable to unblock the parked handshake (the session lock
            // stays held for the server's own budget). The flag stores when
            // this scope exits ANY way, mirroring the built-in branch;
            // `engine_done` remains the serve loop's exit signal
            // (`serve_connection`'s loop-top check, below). A token fire
            // while the pump is still parked (the whole CLI -> bridge ->
            // serve chain waits on a frozen MCP call) kills the transports
            // (stdio/SSE idle-read parks; the HTTP kill is a no-op -- that
            // half unwinds by its read bound and the phase budget), the
            // parked read returns `ServerClosed`, serve unwinds, and
            // the scope can end -- the session lock is released.
            let mcp_turn_done = crate::mcp::aggregator::TurnDoneFlag::new();
            mcp.arm_cancel_teardown(Arc::clone(&self.cancel), mcp_turn_done.flag());
            mcp.connect_all(inputs.mcp_servers, inputs.keychain);
            let deps = TurnDeps {
                engine: &self.admin_engine,
                source_files: &mut self.source_files,
                working_set: &mut self.working_set,
                result_row_cap: self.result_row_cap,
                result_count_cap: self.result_count_cap,
                temp_path: &self.temp_path,
                tool_output_refs: &mut self.tool_output_refs,
            };
            // The bridge face's read gate (issue #714; calibrated by
            // ADR-0119): the same immutable bundle the built-in loop's
            // dispatch server gets -- one read semantics on both runtime
            // surfaces (ADR-0111 Decision 7). Eligibility is the turn-start
            // invoked snapshot, derived ONCE at the submit boundary and
            // passed in -- no per-branch refold of the pending vec's
            // user-invocation names. The disabled cross matches the
            // built-in face's gate -- a disabled name's landed record
            // opens no files on either runtime surface.
            let read_gate = crate::skills::read::SkillReadGate {
                invoked: skill_state.start_invoked,
                disabled: inputs.disabled_skills,
                root: inputs.skills_root,
            };
            // The creation channel's bundle (ADR-0122 Decision 1) -- the
            // same root + live-config pairing the built-in branch wires,
            // so the two faces mint with one contract (#987's posture).
            let create_gate = crate::skills::create::SkillCreateGate {
                root: inputs.skills_root,
                live: inputs.live_config,
            };
            // The bridge face's invocation channel (ADR-0119 Decision 4):
            // the external runtime invokes through the SAME turn-record
            // channel by construction -- the CLI's `invoke_skill` calls land
            // on the turn exactly like the built-in loop's, through the same
            // constructor the built-in branch wires (#987).
            let invocation_channel = crate::skills::invocation::SkillInvocationCtx::from_session(
                &mut *skill_state.pending,
                &self.discovery_snapshot,
                inputs,
            );
            let ctx = GatewayCtx {
                deps,
                invocations: invocation_channel,
                read: read_gate,
                create: create_gate,
                materializer: &mut *self.materializer,
                approval,
                sink,
                cancel: &self.cancel,
                mcp,
                // The enabled CLI registrations ride the same turn inputs
                // the built-in loop reads (issue #673, ADR-0108 Decision 6):
                // one registry, one execution engine, two callers.
                cli: inputs.cli_tools,
            };
            let gateway_result = serve_connection(handle, ctx, &engine_done);
            (
                eng.join().expect("acp engine thread panicked"),
                gateway_result,
            )
        });
        // 6. A serve error after spawn surfaces as an external-runtime
        //    failure; the ACP trace still rides (the CLI may have done work
        //    before the gap).
        let gateway_outcome = match gateway_result {
            Ok(o) => o,
            Err(e) => {
                // #856: snapshot the turn's discovery before the early
                // return -- `snapshot_discovered_runtime` carries the
                // rationale (ADR-0095) and no-ops when the serve failure
                // predates the handshake's discovery. The gateway's
                // promotions are dropped here by decision:
                // `serve_connection` returns `io::Result<GatewayOutcome>`,
                // and the Err variant carries no collected outcome, while a
                // `Failed` turn has no promotion slot in
                // `turn_outcome_from_loop` (every non-converged arm drops
                // them, StepCap alike -- the working-set writes the gateway
                // already made stand unreported). The decided shape is
                // pinned in
                // `external_serve_failure_drops_collected_promotions`.
                self.snapshot_discovered_runtime(&acp_outcome);
                return (
                    TurnOutcome::Failed(TurnFailure::Runtime {
                        detail: format!("gateway serve failed: {e}"),
                    }),
                    acp_outcome.trace,
                );
            }
        };
        // 7. Merge + map onto TurnOutcome (same mapper + trace-extraction
        //    pattern as the built-in branch).
        self.snapshot_discovered_runtime(&acp_outcome);
        let mut merged = merge_outcomes(gateway_outcome, acp_outcome);
        let trace = std::mem::take(&mut merged.trace);
        (
            turn_outcome_from_loop(merged, self.session_id.as_ref(), runtime_face),
            trace,
        )
    }
}
