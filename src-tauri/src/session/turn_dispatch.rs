//! The shared gated-dispatch core + execution safety net (ADR-0080 / ADR-0107).
//!
//! [`dispatch_gated_call`] routes one model-emitted tool call through the
//! approval gateway and the executor, and is the SINGLE SOURCE for every
//! dispatch decision: the meta-tool trio resolution, the skill /
//! artifact-delivery / workspace interception family, the gate
//! classification ([`classify_with_cli_tool`]), the freeze window
//! (ADR-0115), the routing arms, the trace-entry assembly, and the
//! `result_N` numbering with its panic guard (issue #321, sunk into the
//! core so every runtime gets the snapshot + ghost-rollback ritual by
//! construction). The two runtime surfaces are pure transports around it:
//! the loop runtime's mpsc dispatch server and the gateway's `tools/call`
//! arm each parse their own wire shape, call this core with their
//! [`CallFace`], and map the returned product onto their own response
//! shape (issue #696's mid-term item; the gateway arm-side rebuild is
//! retired).
//!
//! The face discriminates the built-in-only interception points
//! (`present_files`, the workspace tools): a [`CallFace::Bridge`] call
//! falls through them to the unknown-tool refusal -- the bridge never
//! lists those names, so a spoofed call dies at the executor (ADR-0124's
//! not-listed-not-served posture). The one documented per-side divergence
//! is the external envelope: the core renders the routed server envelope
//! ONCE (verbatim under the cap, spilled over it -- see
//! [`external_call_outcome`]) alongside the flattened `ToolResult`, and
//! each face picks its rendering (the bridge relays the envelope verbatim;
//! the loop face consumes the flattened result) -- one decision, two
//! renderings.
//!
//! The panic-detail helpers are runtime-agnostic (ADR-0107's replaceability
//! review): they hold no loop-specific state and survive a runtime swap
//! as-is. (The whole-turn wall-clock timeout helper that once lived here was
//! replaced by the no-progress clock, `crate::session::progress` -- ADR-0115.)
//!
//! Migrated out of the retired built-in loop by the retirement slice
//! (ADR-0107 Decision 1, issue #670); the loop is gone, the shared core
//! stays.

use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use serde_json::{json, Value};

use crate::analysis_tools;
use crate::analysis_tools::definitions;
use crate::analysis_tools::ToolOutcome;
use crate::approval::{
    ApprovalRequest, ApprovalSink, ApprovalState, GateCancelled, GateOutcome, OperationKind,
    ToolKey,
};
use crate::cancel::CancelToken;
use crate::ingest::schema::quote_ident;
use crate::mcp::aggregator::{self, McpAggregator, RouteError};
use crate::mcp::meta_tools;
use crate::model::{Promotion, TraceEntryView, TurnPhase};
use crate::persistence::recipe::truncate_trace_summary;
use crate::provider::tool_calling::{ToolResult, ToolUse};
use crate::session::loop_contract::{
    truncate_trace_excerpt, Termination, TraceEntry, DENIED_BY_GATEWAY_CONTENT, TRACE_EXCERPT_MAX,
};
use crate::session::materializer::{DispatchDeps, Materializer};

/// Extract a human-readable message from a panic payload (the `Err` variant of
/// `catch_unwind`, issue #321). Covers `&str` and `String` — the two common
/// payload types; anything else degrades to a placeholder so the detail string
/// is never empty. MSRV 1.80 precludes `std::panic::panic_message` (1.81+).
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Build the `Transient` termination for a caught panic (issue #321):
/// single-sources the detail format + the log target so the two guard
/// sites stay consistent.
/// The "panicked in ..." detail line both panic consumers render: logged at
/// error level and returned so the caller picks the envelope (a
/// `Termination` on the loop paths, a tool-error result on the gateway).
pub(crate) fn panic_detail(site: &str, payload: &(dyn std::any::Any + Send)) -> String {
    let detail = format!("panicked in {site}: {}", panic_message(payload));
    log::error!(target: "toptopduck::turn_dispatch", "{detail}");
    detail
}

pub(crate) fn panic_to_transient(site: &str, payload: &(dyn std::any::Any + Send)) -> Termination {
    Termination::Transient(panic_detail(site, payload))
}

/// The `result_N` numbering snapshot the issue #321 dispatch guard pairs
/// with its rollback: captured by [`GhostSnapshot::take`] BEFORE the guarded
/// dispatch, consumed by [`rollback_ghost_result`] after a panic. A newtype
/// so the snapshot / rollback pairing is a signature fact, not a caller
/// discipline -- the rollback cannot accidentally receive a bare counter
/// (or the wrong turn's number).
struct GhostSnapshot {
    next: u64,
}

impl GhostSnapshot {
    /// Capture the working set's current `next_result_number` -- the value
    /// the ghost detection diffs against after a panicked dispatch.
    fn take(deps: &DispatchDeps) -> Self {
        Self {
            next: deps.working_set.next_result_number(),
        }
    }
}

/// Roll back a ghost `result_N` left by a panic mid-dispatch (issue #321).
/// `try_materialize` registers `result_N` partway through its body; a panic in
/// any subsequent step (record_provenance, gc_stale_results, apply_display_label,
/// ...) leaves a registered-but-unhistoried result. Detection: compare
/// `next_result_number()` before and after the `catch_unwind`; if it grew, the
/// orphan is `result_{prev_next}` — drop its admin table + unregister it from
/// the working set so the working_set <-> history invariant holds (ADR-0084: no
/// orphan working-set result without a matching promotion in history).
///
/// If the DROP fails the orphan is left registered so `next_result_number`
/// skips it — the visible orphan is manually deletable from the UI, which is
/// safer than rewinding the number and clashing on reuse. The ghost was never
/// user-visible, so ADR-0022's no-reuse constraint does not apply to the
/// rollback itself.
fn rollback_ghost_result(deps: &mut DispatchDeps, snapshot: GhostSnapshot) {
    let prev_next = snapshot.next;
    let curr_next = deps.working_set.next_result_number();
    if curr_next <= prev_next {
        return;
    }
    let ghost = format!("result_{prev_next}");
    log::warn!(
        target: "toptopduck::turn_dispatch",
        "rolling back ghost {ghost} left by a panicked dispatch"
    );
    let drop_sql = format!("DROP TABLE {}", quote_ident(&ghost));
    if let Err(e) = deps.engine.execute_batch(&drop_sql) {
        log::error!(
            target: "toptopduck::turn_dispatch",
            "ghost rollback of {ghost} failed: {e}; leaving result_{prev_next} \
             registered so next_result_number skips it -- delete manually"
        );
        return;
    }
    deps.working_set.remove(&ghost);
}

/// The issue #321 snapshot + ghost-rollback ritual as one reusable guard:
/// capture the `result_N` numbering, run `body` under `catch_unwind`, and on
/// a panic roll any orphan `result_N` back before returning the
/// "panicked in ..." detail. The dispatch core ([`dispatch_gated_call`])
/// wraps the builtin executor in this -- both routing faces dispatch
/// through the core, so every runtime gets the ritual by construction.
pub(crate) fn guarded_dispatch<R>(
    deps: &mut DispatchDeps,
    site: &str,
    body: impl FnOnce(&mut DispatchDeps) -> R,
) -> Result<R, String> {
    let snapshot = GhostSnapshot::take(deps);
    match catch_unwind(AssertUnwindSafe(|| body(deps))) {
        Err(payload) => {
            rollback_ghost_result(deps, snapshot);
            Err(panic_detail(site, &*payload))
        }
        Ok(result) => Ok(result),
    }
}

/// The approval-gateway context [`dispatch_gated_call`] routes every call
/// through (ADR-0080): the session's gate state + the event sink + the cancel
/// token the gate suspends on. Bundled so the call signature stays under
/// clippy's argument-count threshold.
pub(crate) struct GateCtx<'a> {
    pub(crate) approval: &'a ApprovalState,
    pub(crate) sink: &'a dyn ApprovalSink,
    pub(crate) cancel: &'a CancelToken,
}

/// Which runtime face a dispatch entered through (the per-face
/// discriminator [`dispatch_gated_call`] takes): the loop runtime's mpsc
/// dispatch server (`Builtin`) or the gateway's bridge arm (`Bridge`). The
/// face gates the built-in-only interception points -- `present_files`
/// (ADR-0124) and the workspace tools (ADR-0137): a `Bridge` call falls
/// through them to the unknown-tool refusal (the bridge never lists the
/// names; not listed, not served), and derives the approval card's
/// `call_id` (external fold alignment: the bridge echoes the JSON-RPC id,
/// a built-in call has none).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallFace {
    /// The loop runtime's mpsc dispatch server -- every interception point
    /// live, `call_id: None`.
    Builtin,
    /// The gateway's bridge arm -- built-in-only tools fall through, and
    /// the call's wire id rides the approval card.
    Bridge,
}

impl CallFace {
    /// The approval card's `call_id` for a call on this face: the bridge
    /// carries the call's wire id (external fold alignment), a built-in
    /// call has none. One definition for every `ApprovalRequest`
    /// construction in the core.
    fn approval_call_id(self, id: &str) -> Option<String> {
        match self {
            CallFace::Builtin => None,
            CallFace::Bridge => Some(id.to_string()),
        }
    }
}

/// Why a shared-core dispatch aborted (the error side of
/// [`dispatch_gated_call`]): the approval gate cancelled mid-call (the whole
/// turn aborts, every runtime's semantics), or the dispatch panicked (the
/// issue #321 guard, sunk into the core so every runtime gets the snapshot +
/// ghost-rollback ritual by construction -- a third runtime cannot silently
/// omit it). The panic's [`Termination`] is pre-derived so each runtime maps
/// it onto its own failure channel without re-deriving the detail.
#[derive(Debug)]
pub(crate) enum DispatchAbort {
    Gate,
    Panic(Termination),
}

/// The gated dispatch's product: the flattened model-facing result, the
/// call's trace entry (`None` for a meta-tool resolution failure that never
/// reached a tool, ADR-0105 Decision 4), any promotion, and -- on the
/// external routing arm -- the server envelope the bridge face relays
/// verbatim (`None` everywhere else; the loop face ignores it).
pub(crate) type DispatchProduct = (
    ToolResult,
    Option<TraceEntry>,
    Option<Promotion>,
    Option<Value>,
);

/// Route one tool call through the approval gateway + dispatch (ADR-0080 /
/// ADR-0076): the single-source dispatch core behind both runtime faces
/// (the loop runtime's mpsc dispatch server, ADR-0116, and the gateway's
/// bridge arm). Every decision -- the interception family, the gate
/// classification, the routing arms, the trace-entry assembly, and the
/// `result_N` numbering -- lives HERE, so it cannot drift between the
/// runtimes; each face is a pure transport around it. Returns the
/// flattened model-facing result, the call's trace entry (`None` for a
/// meta-tool resolution failure that never reached a tool, ADR-0105
/// Decision 4), any promotion, and -- on the external routing arm only --
/// the server envelope the bridge face relays verbatim (see the module
/// doc's one-decision-two-renderings note; the loop face ignores it).
/// Emits the ADR-0078 phase pair through `on_phase`.
///
/// The freeze (ADR-0115) is held HERE, across the whole gated window: the
/// interception resolvers, an approval pending on the condvar, a CLI
/// tool's run, and a builtin dispatch are waits on an external principal,
/// never billed to the turn's generation cap. This is the single freeze
/// point for both faces -- it retired the three per-side manual freezes.
///
/// The issue #321 dispatch panic guard lives HERE: the `result_N` snapshot +
/// ghost rollback runs for every dispatch by construction, and a panic
/// surfaces as [`DispatchAbort::Panic`] instead of unwinding into either
/// runtime.
#[allow(clippy::too_many_arguments)]
pub(crate) fn dispatch_gated_call(
    call: &ToolUse,
    face: CallFace,
    deps: &mut DispatchDeps,
    materializer: &mut dyn Materializer,
    mcp: &mut McpAggregator,
    cli: &[crate::cli_tools::config::CliToolConfig],
    invocations: &mut crate::skills::invocation::SkillInvocationCtx<'_>,
    presented: &mut Vec<String>,
    read: &crate::skills::read::SkillReadGate<'_>,
    create: &crate::skills::create::SkillCreateGate<'_>,
    gate: &GateCtx<'_>,
    on_phase: &mut impl FnMut(TurnPhase),
    origin: Option<&str>,
) -> Result<DispatchProduct, DispatchAbort> {
    // The ADR-0115 freeze window (see the doc above): held for the whole
    // gated window, dropped at every exit. The clock rides the gate's token
    // (None between turns: no freeze).
    let _frozen = gate.cancel.progress_clock().map(|c| c.freeze());
    // Issue #321: guard the dispatch against a panic. The materialize path
    // registers result_N partway through try_materialize; a panic in any
    // subsequent step (record_provenance, gc_stale_results,
    // apply_display_label, descriptor_json, ToolOutcome construction) can
    // leave a ghost result_N. The shared `guarded_dispatch` ritual detects +
    // reverts any orphan so the working_set <-> history invariant holds
    // (ADR-0084).
    let site = format!("tool dispatch `{}`", call.name);
    match guarded_dispatch(deps, &site, |deps| {
        dispatch_gated_call_inner(
            call,
            face,
            deps,
            materializer,
            mcp,
            cli,
            invocations,
            presented,
            read,
            create,
            gate,
            on_phase,
            origin,
        )
    }) {
        Err(detail) => Err(DispatchAbort::Panic(Termination::Transient(detail))),
        Ok(result) => result.map_err(|GateCancelled| DispatchAbort::Gate),
    }
}

/// The dispatch body under the panic guard (see [`dispatch_gated_call`]).
#[allow(clippy::too_many_arguments)]
fn dispatch_gated_call_inner(
    call: &ToolUse,
    face: CallFace,
    deps: &mut DispatchDeps,
    materializer: &mut dyn Materializer,
    mcp: &mut McpAggregator,
    cli: &[crate::cli_tools::config::CliToolConfig],
    invocations: &mut crate::skills::invocation::SkillInvocationCtx<'_>,
    presented: &mut Vec<String>,
    read: &crate::skills::read::SkillReadGate<'_>,
    create: &crate::skills::create::SkillCreateGate<'_>,
    gate: &GateCtx<'_>,
    on_phase: &mut impl FnMut(TurnPhase),
    origin: Option<&str>,
) -> Result<DispatchProduct, GateCancelled> {
    // Meta-tool trio dispatch (ADR-0105): the classification -- list / search
    // run locally against the aggregator's catalog (read-only, short of the
    // gate -- the built-in read tools' trust shape); mcp_invoke resolves its
    // handle BEFORE the enforcement points and falls through under the
    // backend identity, so the gate / trace never see "mcp_invoke"; a
    // resolution / parse / direct-handle failure is the call's own error
    // result with no phase events and no trace entry -- the same semantics as
    // a call that never reached a tool. All of that lives in the shared
    // `meta_tools::resolve_meta_call` (issue #663 review); this site maps
    // each variant onto the loop's `ToolResult` shape.
    let resolved;
    let call: &ToolUse = match meta_tools::resolve_meta_call(mcp, call) {
        meta_tools::MetaDispatch::Local { summary, payload } => {
            let (result, entry) = local_meta_call(call, &summary, payload, on_phase);
            return Ok((result, Some(entry), None, None));
        }
        meta_tools::MetaDispatch::Refused(message) => {
            return Ok((meta_failure(call, &message), None, None, None))
        }
        meta_tools::MetaDispatch::Resolved(replacement) => {
            resolved = replacement;
            &resolved
        }
        meta_tools::MetaDispatch::Fallthrough(call) => call,
    };
    // The skill-invocation meta-tool (ADR-0119 Decision 4, issue #983):
    // intercepted beside the trio match, ahead of any classification /
    // gate -- invocation is approval-free by design (the gate is the
    // machine-level enable axis). The resolver appends the
    // agent-actor record to the turn's pending invocations (persistence
    // rides `record_turn`, never a session transition); the body rides the
    // tool result back into the turn's own context -- the record is for
    // provenance, not injection.
    if call.name == crate::skills::invocation::INVOKE_SKILL {
        return Ok(
            match crate::skills::invocation::resolve_skill_invocation(call, invocations) {
                crate::skills::invocation::SkillInvocationOutcome::Local { summary, payload } => {
                    let (result, entry) = local_meta_call(call, &summary, payload, on_phase);
                    (result, Some(entry), None, None)
                }
                crate::skills::invocation::SkillInvocationOutcome::Refused(message) => {
                    (meta_failure(call, &message), None, None, None)
                }
            },
        );
    }
    // The artifact-delivery meta-tool (ADR-0124 Decision 1, issue #1087):
    // intercepted beside the skill meta-tools, equally ahead of any
    // classification / gate -- delivery is a declaration, approval-free by
    // design (no machine axis is enabled). The resolver appends the
    // declared paths to the turn's channel; validation, resolution, and
    // materialization are SETTLE concerns, one place for both channels.
    // Builtin face only (the face discriminator): the gateway's bridge arm
    // never lists the tool, so a spoofed bridge call falls through to the
    // unknown-tool refusal (ADR-0124 -- injection into external CLIs was
    // rejected).
    if face == CallFace::Builtin && call.name == crate::session::artifacts::PRESENT_FILES {
        return Ok(
            match crate::session::artifacts::resolve_present_files(call, presented) {
                crate::session::artifacts::PresentFilesOutcome::Local { summary, payload } => {
                    let (result, entry) = local_meta_call(call, &summary, payload, on_phase);
                    (result, Some(entry), None, None)
                }
                crate::session::artifacts::PresentFilesOutcome::Refused(message) => {
                    (meta_failure(call, &message), None, None, None)
                }
            },
        );
    }
    // The skill-attachment read surface (ADR-0111, issue #714): intercepted
    // beside the invocation arm, equally ahead of any classification / gate
    // -- reading is the injected body's risk class, so the invoked set is
    // the trust gate (ADR-0111 calibrated by ADR-0119 Decision 4). The
    // resolver unions the turn's pending invocations with the turn-start
    // snapshot (issue #1260), so a mid-turn `invoke_skill` reads in its
    // own turn. The classification is pure (no transitions, no persist);
    // this site maps the two variants exactly as the invocation arm does
    // (a Local read gets the started / completed phase pair + a trace row,
    // a Refused read is the bare error result with no trace entry).
    if call.name == crate::skills::read::READ_SKILL_FILE {
        return Ok(
            match crate::skills::read::resolve_skill_read(
                call,
                read,
                invocations.pending.as_slice(),
            ) {
                crate::skills::read::SkillReadOutcome::Local { summary, payload } => {
                    let (result, entry) = local_meta_call(call, &summary, payload, on_phase);
                    (result, Some(entry), None, None)
                }
                crate::skills::read::SkillReadOutcome::Refused(message) => {
                    (meta_failure(call, &message), None, None, None)
                }
            },
        );
    }
    // The skill-creation meta-tool (ADR-0122 Decisions 1 + 3): unlike the
    // two read-shaped skill meta-tools above, the mint PERSISTS across
    // sessions and its body is a future prompt-injection source, so it
    // GATES -- the resolver validates + pre-checks ahead of the card (a
    // refusal is the model's, never the approver's), and only an approved
    // call executes the live-config composite (mint + stale-entry clear).
    // The discovery snapshot is untouched (ADR-0119's session-immutable
    // posture): the new skill is invocable by name this session and seeded
    // into the next -- except a session that started with no skills never
    // mounts `invoke_skill`, so invocability defers to the next session.
    if call.name == crate::skills::create::CREATE_SKILL {
        return Ok(
            match crate::skills::create::resolve_skill_creation(call, create.root) {
                crate::skills::create::SkillCreateOutcome::Refused(message) => {
                    (meta_failure(call, &message), None, None, None)
                }
                crate::skills::create::SkillCreateOutcome::Gated { summary, markdown } => {
                    let Some(live) = create.live else {
                        return Ok((
                            meta_failure(call, crate::skills::create::UNAVAILABLE_FAILURE),
                            None,
                            None,
                            None,
                        ));
                    };
                    let gate_req = ApprovalRequest {
                        key: crate::approval::ToolKey::builtin(crate::skills::create::CREATE_SKILL),
                        operation_kind: OperationKind::Write,
                        summary: summary.clone(),
                        file_attachments: vec![crate::skills::create::skill_markdown_attachment(
                            &markdown,
                        )],
                        // The originator annotation rides the gate like every
                        // other call's (issue #934); the card's call id is
                        // face-derived (the bridge echoes the wire id, a
                        // built-in call has none).
                        origin_agent: origin.map(str::to_string),
                        call_id: face.approval_call_id(&call.id),
                    };
                    match gate.approval.gate(gate_req, gate.sink, gate.cancel) {
                        Err(GateCancelled) => return Err(GateCancelled),
                        Ok(GateOutcome::Denied) => {
                            let entry = TraceEntry::denied(
                                call.id.clone(),
                                call.name.clone(),
                                OperationKind::Write,
                                summary,
                            );
                            on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
                            (
                                ToolResult {
                                    tool_use_id: call.id.clone(),
                                    content: DENIED_BY_GATEWAY_CONTENT.to_string(),
                                    is_error: true,
                                },
                                Some(entry),
                                None,
                                None,
                            )
                        }
                        Ok(GateOutcome::Allow) => {
                            on_phase(TurnPhase::ToolCallStarted {
                                id: None,
                                name: call.name.clone(),
                                operation_kind: OperationKind::Write,
                                summary: summary.clone(),
                                task: None,
                            });
                            match crate::skills::create::execute_skill_creation(
                                live,
                                create.root,
                                &markdown,
                            ) {
                                Ok(entry_minted) => {
                                    let result = ToolResult {
                                        tool_use_id: call.id.clone(),
                                        content: crate::skills::create::created_skill_result(
                                            &entry_minted,
                                        ),
                                        is_error: false,
                                    };
                                    let entry = TraceEntry::succeeded(
                                        call.id.clone(),
                                        call.name.clone(),
                                        OperationKind::Write,
                                        summary,
                                        String::new(),
                                    );
                                    on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(
                                        &entry,
                                    )));
                                    (result, Some(entry), None, None)
                                }
                                Err(e) => {
                                    // The gate-pending window can race a
                                    // same-name mint -- the typed error rides
                                    // the result so the model self-corrects.
                                    let message = format!("create_skill: {e}");
                                    let entry = TraceEntry::failed(
                                        call.id.clone(),
                                        call.name.clone(),
                                        OperationKind::Write,
                                        summary,
                                        truncate_trace_excerpt(&message, TRACE_EXCERPT_MAX),
                                    );
                                    on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(
                                        &entry,
                                    )));
                                    (
                                        ToolResult {
                                            tool_use_id: call.id.clone(),
                                            content: message,
                                            is_error: true,
                                        },
                                        Some(entry),
                                        None,
                                        None,
                                    )
                                }
                            }
                        }
                    }
                }
            },
        );
    }
    // The workspace tools (ADR-0137): the gated write pair (`write` /
    // `edit`, issue #1406) persists model-authored text files into the
    // session workspace -- the sedimentation channel, deliberately split
    // from the python execution medium (ADR-0108 D4). Like `create_skill`
    // above, the effect outlives the turn, so the pair GATES per call
    // (Write badge; the write payload rides the card as attachments); a
    // resolution failure (an out-of-workspace path, an over-cap or binary
    // payload, an unresolvable edit target, no bound workspace) is refused
    // AHEAD of the card -- the model's error, never the approver's. The
    // read-only discovery trio (`glob` / `grep` / `read`, issue #1385)
    // rides the same predicate but splits inside the module to an ungated
    // arm: an in-workspace read has no approval surface (ADR-0080
    // Decision 1). The whole arm family lives in the module so it owns its
    // ritual end to end. Builtin face only (the face discriminator): the
    // bridge face never lists the names and `analysis_tools::dispatch` has no arm
    // for them, so a spoofed bridge call dies at the unknown-tool error.
    if face == CallFace::Builtin && crate::session::workspace_tools::is_workspace_tool(&call.name) {
        return crate::session::workspace_tools::dispatch_workspace_tool(
            call, deps, gate, on_phase, origin,
        );
    }
    // A registered CLI tool classifies under its own reserved server
    // (ADR-0108 Decision 7): the trust key is the registration name, the
    // badge is Execute, and the summary renders the full argv the approval
    // card shows (the approver signs exactly what will run). The shared
    // helper keeps this identical to the gateway's bridge-originated arm.
    let ResolvedClassification {
        key,
        operation_kind,
        summary,
        file_attachments,
        cli_tool,
    } = classify_with_cli_tool(cli, call, deps.temp_path);
    let gate_req = ApprovalRequest {
        key,
        operation_kind,
        summary: summary.clone(),
        file_attachments,
        // The originator annotation (issue #934): the delegating sub-agent's
        // name rides the gate so the approval card reads "sub-agent X wants
        // to call Y"; a main-loop call carries none. The card's call id is
        // face-derived (the bridge echoes the wire id, a built-in call has
        // none).
        origin_agent: origin.map(str::to_string),
        call_id: face.approval_call_id(&call.id),
    };
    // ADR-0080: every tool call passes the gate before dispatch. Built-in tools
    // classify Allow (zero approval); external tools would suspend here.
    match gate.approval.gate(gate_req, gate.sink, gate.cancel) {
        Err(GateCancelled) => return Err(GateCancelled),
        Ok(GateOutcome::Denied) => {
            // A denial is a tool-level error the agent can self-correct from
            // (ADR-0077) -- e.g. retry without the denied tool, or surface it
            // to the user. The denied call never dispatches, so only the
            // completion event fires (success: false) -- the frontend's
            // pending approval card flips to its resolved-deny row in place.
            let entry =
                TraceEntry::denied(call.id.clone(), call.name.clone(), operation_kind, summary);
            // The completed event carries the persisted-shape view (a failure
            // keeps its message -- here the denial -- so the resolved card
            // and the recorded trace show the same why).
            on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
            return Ok((
                ToolResult {
                    tool_use_id: call.id.clone(),
                    content: DENIED_BY_GATEWAY_CONTENT.to_string(),
                    is_error: true,
                },
                Some(entry),
                None,
                None,
            ));
        }
        Ok(GateOutcome::Allow) => {}
    }
    // ADR-0078: the started event fires post-gate so a suspended approval card
    // is never doubled by a "running" row -- the card flips to resolved (via
    // the gateway's approval-resolved event) and only then does the call show
    // as running. The summary matches the approval card's (both come from
    // classify_call) so the frontend merges the two into one row.
    on_phase(TurnPhase::ToolCallStarted {
        id: None,
        name: call.name.clone(),
        operation_kind,
        summary: summary.clone(),
        task: None,
    });
    // ADR-0076 (slice C-loop) + ADR-0105 Decision 4: route by name shape. A
    // namespaced `mcp__<slug>__<tool>` name goes to the matching external
    // MCP server via the aggregator (the prefix is stripped server-side); a
    // bare name goes to the built-in DuckDB executor. Under the discovery
    // surface the namespaced arm is reached only via the `mcp_invoke`
    // fall-through above (a directly-emitted handle was already refused in
    // the trio match), so this dispatch stays the single external execution
    // point.
    // Both surface the outcome as the typed channel (issue #336): the
    // model-facing `result` (JSON payload on success or an error string on
    // failure -- both feed back to the model; the agent self-corrects on an
    // error) plus the side effect the executor reported. The external path
    // never promotes (external tools do not materialize a working-set
    // result), so `promotion` is always `None` there.
    let (outcome, envelope) = if aggregator::is_namespaced(&call.name) {
        route_external_dual(call, face, mcp, deps.temp_path)
    } else if let Some(tool) = cli_tool {
        // The registered-CLI dispatch arm (issue #671, ADR-0108 Decision 3):
        // direct argv spawn, cancel = the turn's shared token (process-tree
        // termination on round cancel). ADR-0137 (issue #1381): the spawn
        // cwd is the session WORKSPACE -- the built-in runtime's
        // relative-path base, matching the external runtime's cwd. THIS
        // launch is the lazy-mint disk-need moment: a directory-less session
        // mints its default timestamped workspace on the first CLI call, so
        // a pure-chat session stays dirless. The pipeline artifacts stay in
        // the session temp (issue #1408): the temp-dir argument below keeps
        // file-delivery and the spill tee out of the workspace and in the
        // domain the approval classify renders against.
        (
            match deps.launch_dir() {
                Ok(cwd) => crate::cli_tools::executor::execute(
                    tool,
                    call,
                    &cwd,
                    deps.temp_path,
                    gate.cancel,
                    None,
                ),
                // A call-time structured error (the ADR-0108 D2 posture): the
                // shared tail below completes the started row and routes the
                // failure back for self-correction, exactly like an errored
                // executor call.
                Err(detail) => ToolOutcome {
                    result: ToolResult {
                        tool_use_id: call.id.clone(),
                        content: detail,
                        is_error: true,
                    },
                    promotion: None,
                },
            },
            None,
        )
    } else {
        (
            analysis_tools::dispatch(call, deps, gate.cancel, materializer),
            None,
        )
    };
    let result = outcome.result;
    // ADR-0077: a tool-level error routes back to the model. Log it so a
    // non-converging turn (StepCap) leaves an operator-visible trail of what
    // the model was being told, not just the final cap.
    if result.is_error {
        log::debug!(
            target: "toptopduck::turn_dispatch",
            "tool `{}` returned an error (routing back for self-correction): {}",
            call.name,
            truncate_trace_excerpt(&result.content, 200)
        );
    }
    let success = !result.is_error;
    // The executor reports a promotion through the side-effect channel iff one
    // landed (today, only `materialize` produces one, and only on success --
    // the executor builds it from the typed sql + descriptor, so there is no
    // "success but no promotion" contract violation to guard). The core is
    // tool-agnostic: it carries `outcome.promotion` without naming any tool
    // (issue #336).
    let promotion = outcome.promotion;
    let excerpt = truncate_trace_excerpt(&result.content, TRACE_EXCERPT_MAX);
    let entry = if success {
        TraceEntry::succeeded(
            call.id.clone(),
            call.name.clone(),
            operation_kind,
            summary,
            excerpt,
        )
    } else {
        TraceEntry::failed(
            call.id.clone(),
            call.name.clone(),
            operation_kind,
            summary,
            excerpt,
        )
    };
    // ADR-0078: complete the live row with the persisted-shape view (success
    // excerpt emptied -- see TraceEntryView's mapping below), paired with the
    // ToolCallStarted emitted pre-dispatch.
    on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
    Ok((result, Some(entry), promotion, envelope))
}

/// Serve one locally-executed meta-tool (`mcp_list_servers` /
/// `mcp_search_tools`) on the built-in path (ADR-0105). The catalog payload
/// flattens to the model-facing content string (`ToolResult.content` is a
/// flat String on this path), with the standard started / completed phase
/// pair + trace entry so a meta-tool call renders like any other call. These
/// never touch a backend server, so there is no gate suspension (catalog
/// reads carry the built-in read tools' trust shape). Returns the result
/// paired with its trace entry -- the push into the runtime's outputs
/// belongs to the caller (the loop runtime's dispatcher).
fn local_meta_call(
    call: &ToolUse,
    summary: &str,
    payload: serde_json::Value,
    on_phase: &mut impl FnMut(TurnPhase),
) -> (ToolResult, TraceEntry) {
    on_phase(TurnPhase::ToolCallStarted {
        id: None,
        name: call.name.clone(),
        operation_kind: OperationKind::Read,
        summary: summary.to_string(),
        task: None,
    });
    // A success is emptied at the persisted mapping; the in-memory form
    // keeps nothing here either -- the payload itself rides the result.
    let entry = TraceEntry::succeeded(
        call.id.clone(),
        call.name.clone(),
        OperationKind::Read,
        summary.to_string(),
        String::new(),
    );
    on_phase(TurnPhase::ToolCallCompleted(TraceEntryView::from(&entry)));
    (
        ToolResult {
            tool_use_id: call.id.clone(),
            content: meta_tools::meta_payload_text(payload),
            is_error: false,
        },
        entry,
    )
}

/// A meta-tool resolution failure (a malformed `mcp_search_tools` input, or an
/// `mcp_invoke` handle that did not resolve): the call's own error result
/// the agent self-corrects from (ADR-0077), with NO phase events and NO
/// trace entry (ADR-0105 Decision 4 -- the call never reached a tool).
fn meta_failure(call: &ToolUse, message: &str) -> ToolResult {
    ToolResult {
        tool_use_id: call.id.clone(),
        content: message.to_string(),
        is_error: true,
    }
}

/// Route a namespaced external MCP call through the aggregator ONCE and
/// render the face's outcome (issue #696's divergence downgraded to one
/// decision point, two renderings): the route happens here and nowhere
/// else, and each face consumes its own rendering of it. The loop face
/// (`Builtin`) takes the flattened `ToolResult` ([`shape_external_outcome`]
/// -- the trace / numbering single source, the inline-materialize hint
/// included); the bridge face (`Bridge`) takes the server's envelope
/// ([`external_call_outcome`]: the server's own shape relayed verbatim
/// under the cap, spilled over it) with a `ToolResult` flattened from the
/// final envelope's first text block -- the pre-retirement gateway row's
/// excerpt source, so the trace row is byte-identical. A route failure
/// flattens to the same failure text on both faces (each callee's Err arm
/// owns its rendering). No promotion in any branch (external tools never
/// materialize a working-set result).
fn route_external_dual(
    call: &ToolUse,
    face: CallFace,
    mcp: &mut McpAggregator,
    session_temp_dir: &Path,
) -> (analysis_tools::ToolOutcome, Option<Value>) {
    let route_result = mcp.route(&call.name, &call.input);
    match face {
        // The flattened rendering: the trace / numbering single source,
        // the inline-materialize hint included. A route failure flattens
        // through the same callee's Err arm -- the loop face never relays
        // an envelope, so the envelope half is `None` on every exit.
        CallFace::Builtin => (
            shape_external_outcome(
                route_result,
                call,
                session_temp_dir,
                crate::cli_tools::executor::OUTPUT_CAP_BYTES,
            ),
            None,
        ),
        // The verbatim rendering: the server's own envelope (route
        // failures included -- a transport-fault text is as much the data
        // plane as a success's), with a `ToolResult` flattened from the
        // final envelope's first text block -- the pre-retirement gateway
        // row's excerpt source, so the trace row is byte-identical.
        CallFace::Bridge => {
            // The over-cap spill stem (issue #1218): the `mcp__` prefix is
            // stripped so `mcp__<slug>__<tool>` spills as
            // `<slug>__<tool>-<call-id>` -- the CLI channel's naming
            // family, one data-plane switch across both transports.
            let stem = call
                .name
                .strip_prefix(aggregator::NAMESPACED_PREFIX)
                .unwrap_or(&call.name);
            let spill =
                crate::cli_tools::executor::SpillPlan::new(session_temp_dir, stem, &call.id);
            let (envelope, is_error, content) = external_call_outcome(
                &call.name,
                route_result,
                &spill,
                crate::cli_tools::executor::OUTPUT_CAP_BYTES,
            );
            (
                analysis_tools::ToolOutcome {
                    result: ToolResult {
                        tool_use_id: call.id.clone(),
                        content,
                        is_error,
                    },
                    promotion: None,
                },
                Some(envelope),
            )
        }
    }
}

/// Reduce a routed external MCP call's `Result` to the runtime's `ToolOutcome`
/// (issue #301 slice C-loop). Split from [`route_external_dual`] so the
/// envelope-shaping contract is unit-testable without a live server: a
/// successful envelope flattens to its first text block + the server's
/// `isError` flag (defaulting to `false` per the MCP spec -- a conformant
/// server omits it on success); a server-side error envelope keeps the text
/// (the model self-corrects, ADR-0077) but marks `is_error = true`; a route
/// failure becomes a tool error naming the tool. Over the output cap the
/// flattened text spills whole to tool_output/ and the content becomes the
/// preview trio instead (issue #1218 -- the same-module twin
/// [`spill_external_over_cap`]; the cap parameter follows
/// [`external_call_outcome`]'s testing seam). No promotion in any
/// branch (external tools never materialize a working-set result).
fn shape_external_outcome(
    route_result: Result<Value, RouteError>,
    call: &ToolUse,
    session_temp_dir: &Path,
    cap: usize,
) -> analysis_tools::ToolOutcome {
    let (content, is_error) = match route_result {
        Ok(envelope) => {
            let is_error = envelope
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let text = aggregator::first_text_block(&envelope);
            // The over-cap arm runs FIRST and is orthogonal to `isError`:
            // an error envelope's text is as much the data egress as a
            // success's (the gateway arm's ruling). Issue #442: on a
            // success envelope under the cap, structured inline text is
            // materialized to tool_output/ (ADR-0087 D3/D4). An error's
            // text is a message, not data.
            let content = if text.len() > cap {
                spill_text_over_cap(&text, &call.name, &call.id, session_temp_dir, cap)
            } else if is_error {
                text
            } else {
                crate::session::inline_materialize::augment_with_hint(
                    text,
                    &call.id,
                    &session_temp_dir.join(super::TOOL_OUTPUT_DIR_NAME),
                )
            };
            (content, is_error)
        }
        Err(e) => (format!("external tool `{}` failed: {}", call.name, e), true),
    };
    analysis_tools::ToolOutcome {
        result: ToolResult {
            tool_use_id: call.id.clone(),
            content,
            is_error,
        },
        promotion: None,
    }
}

/// Resolve a routed external MCP call into the bridge face's response
/// envelope + the trace inputs. Pure over the aggregator: takes the route
/// result so the verbatim-relay + excerpt shape is unit-testable without a
/// live server.
///
/// On success the server's envelope is returned VERBATIM -- the server's own
/// `{content, isError}` shape, so structured content blocks (multi-block /
/// non-text) survive. Re-wrapping it into a single text block would
/// double-encode the content array and drop every non-text block the server
/// emitted. Over the result cap the relay stops being verbatim BY DESIGN
/// (issue #1218): the data spills whole to `tool_output/` and the envelope
/// carries the preview trio instead (see [`spill_external_over_cap`]). On a
/// route error this builds an `isError` envelope naming the tool so
/// the agent can self-correct (ADR-0077). Returns
/// `(envelope, is_error, excerpt)` for the caller to relay and flatten.
fn external_call_outcome(
    name: &str,
    route_result: Result<Value, aggregator::RouteError>,
    spill: &crate::cli_tools::executor::SpillPlan,
    cap: usize,
) -> (Value, bool, String) {
    let envelope = route_result.unwrap_or_else(|e| {
        json!({
            "content": [{
                "type": "text",
                "text": format!("external tool `{name}` failed: {e}"),
            }],
            "isError": true,
        })
    });
    let is_error = envelope
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let envelope = spill_external_over_cap(envelope, name, spill, cap);
    let excerpt = aggregator::first_text_block(&envelope);
    (envelope, is_error, excerpt)
}

/// The over-cap external-result spill arm (issue #1218): the MCP twin of
/// the CLI stdout tee -- the cap is the data-plane switching point, so an
/// over-cap result's data lands whole under `tool_output/` (readable by
/// `read_*` into the working set through the derived-source chain) and the
/// model context gets the capped head + marker + path instead of the full
/// bytes. The spill bytes are the `content[]` text blocks concatenated in
/// order (non-text blocks are skipped -- they are not the engine's data
/// plane); a result with no text bytes falls back to the
/// `structuredContent` serialization, else the file would be empty.
/// Under the cap the envelope passes through untouched (the verbatim
/// contract). `isError` is orthogonal: an error envelope's text is as
/// much the data egress as a success's (the CLI channel's non-zero-exit
/// twin), so it spills the same way. A failed spill withdraws the path
/// and removes the partial bytes, and the preview carries the truncation
/// and write-error markers -- a half-trusted file reference is worse than
/// none (the CLI reader's doctrine).
fn spill_external_over_cap(
    mut envelope: Value,
    name: &str,
    spill: &crate::cli_tools::executor::SpillPlan,
    cap: usize,
) -> Value {
    // Measure first, spill later: the under-cap path assembles no data
    // buffer (the verbatim relay stays copy-free; the zero-text fallback
    // still pays one serialization probe); only a crossing pays for
    // assembly. The measured data plane is the text blocks only: a
    // non-empty text keeps `structuredContent` out of the measurement
    // entirely (ADR-0105 Decision 5's calibration -- the fallback below
    // is the no-text escape hatch, not a second plane).
    let texts: Vec<&str> = envelope
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let total: usize = texts.iter().map(|t| t.len()).sum();
    let fallback: Option<String> = if total == 0 {
        envelope
            .get("structuredContent")
            .and_then(|sc| serde_json::to_string(sc).ok())
    } else {
        None
    };
    let data_len = fallback.as_ref().map_or(total, String::len);
    if data_len <= cap {
        return envelope;
    }
    let data: Vec<u8> = match &fallback {
        Some(serialized) => serialized.as_bytes().to_vec(),
        None => texts.concat().into_bytes(),
    };
    let head = String::from_utf8_lossy(&data[..cap]).into_owned();
    let extension = crate::cli_tools::executor::spill_extension(data.iter().copied());
    let spilled: Result<std::path::PathBuf, String> = (|| {
        let (mut file, path) = spill.open(extension).map_err(|e| e.to_string())?;
        if let Err(e) = file.write_all(&data) {
            // The half-written file cannot be a data reference: drop the
            // handle (Windows refuses to delete an open file), then remove
            // the partial bytes -- the CLI spill's cleanup doctrine.
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(e.to_string());
        }
        Ok(path)
    })();
    // Logged at warn, not debug: release builds filter debug, and a failed
    // spill is an abnormal actionable event -- the model sees the marker,
    // but the trace excerpt keeps only the preview head, so the operator
    // would otherwise have no persistent trace of a sustained disk-full.
    if let Err(detail) = &spilled {
        log::warn!(
            target: "toptopduck::turn_dispatch",
            "external tool spill write failed for `{name}`: {detail}"
        );
    }
    let preview = crate::cli_tools::executor::spill_preview(&head, cap, &spilled);
    let preview_block = json!({"type": "text", "text": preview});
    // Collapse the text blocks into the preview block at the first text
    // block's position; non-text blocks keep theirs (they were never part
    // of the measured data plane). A missing content array is CREATED --
    // the structuredContent fallback can cross the cap with no array at
    // all, and a spilled file the model has no pointer to would be an
    // orphan.
    let mut rebuilt = Vec::new();
    let mut placed = false;
    if let Some(Value::Array(blocks)) = envelope.get_mut("content") {
        rebuilt.reserve(blocks.len());
        for block in blocks.drain(..) {
            let is_text = block.get("type").and_then(Value::as_str) == Some("text");
            if !is_text {
                rebuilt.push(block);
            } else if !placed {
                rebuilt.push(preview_block.clone());
                placed = true;
            }
        }
    }
    if !placed {
        // No text block existed (or no content array at all): the preview
        // opens the content.
        rebuilt.insert(0, preview_block);
    }
    if let Some(object) = envelope.as_object_mut() {
        object.insert("content".to_string(), Value::Array(rebuilt));
        // The spilled data must not also ride the envelope: the fallback's
        // structuredContent is the bypassed bytes (kept verbatim otherwise --
        // the text plane spilled, not it, and a FAILED spill bypassed nothing).
        if spilled.is_ok() && fallback.is_some() {
            object.remove("structuredContent");
        }
    }
    envelope
}

/// The over-cap spill for the built-in dispatch path (issue #1218): the
/// bridge face's twin of this arm ([`spill_external_over_cap`] above)
/// relays the whole envelope for external runtimes; this one caps the same
/// results on the built-in loop's own dispatch. The whole flattened text
/// spills under `tool_output/` as
/// `<slug>__<tool>-<call-id>` (the `mcp__` prefix stripped -- the CLI
/// channel's naming family, shared with the gateway arm), and the
/// model-facing content becomes the capped head + truncation marker +
/// spill path (the shared [`crate::cli_tools::executor::spill_preview`]).
/// A failed spill withdraws the path, removes the partial bytes (the CLI
/// spill's cleanup doctrine), and is logged at warn -- the marker rides
/// the model context only.
fn spill_text_over_cap(
    text: &str,
    name: &str,
    call_id: &str,
    session_temp_dir: &Path,
    cap: usize,
) -> String {
    let stem = name
        .strip_prefix(aggregator::NAMESPACED_PREFIX)
        .unwrap_or(name);
    let spill = crate::cli_tools::executor::SpillPlan::new(session_temp_dir, stem, call_id);
    let extension = crate::cli_tools::executor::spill_extension(text.bytes());
    let head = String::from_utf8_lossy(&text.as_bytes()[..cap]).into_owned();
    let spilled: Result<std::path::PathBuf, String> = (|| {
        let (mut file, path) = spill.open(extension).map_err(|e| e.to_string())?;
        if let Err(e) = file.write_all(text.as_bytes()) {
            // Windows refuses to delete an open file; drop the handle
            // first, then remove the partial bytes.
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(e.to_string());
        }
        Ok(path)
    })();
    if let Err(detail) = &spilled {
        log::warn!(
            target: "toptopduck::turn_dispatch",
            "external tool spill write failed for `{name}`: {detail}"
        );
    }
    crate::cli_tools::executor::spill_preview(&head, cap, &spilled)
}

/// Classify a tool call for the approval gateway + the trace: the [`ToolKey`]
/// (built-in vs external server), the [`OperationKind`] badge (ADR-0083), and a
/// short agent-readable summary of the arguments. Built-in tools classify from
/// the single metadata table ([`definitions::builtin_metadata`], issue #336) --
/// no tool-name literal `match` here, so adding a built-in tool is one entry in
/// `builtin_tools`, not a parallel edit to this function. An unknown name falls
/// through to the external arm (the gateway surfaces the approval card for it).
/// Hard cap on the external-call argument preview inside the approval
/// summary (issue #661; cap added by the #663 review). Aligned with the
/// trace-summary cap at 512 (issue #826); the constructed frame-inclusive
/// string is re-trimmed to the card-body budget at the construction site
/// ([`crate::approval::SUMMARY_MAX_CHARS`]) so the card, the started event,
/// and the trace entry carry one string and the frontend's exact-match
/// merge holds (an emit-side-only re-trim would fork the channels) -- the
/// fold then recovers the head the card previews, a frame-width fewer
/// payload chars than a built-in summary's 512. The registered-CLI argv
/// summary shares this cap framelessly -- it lands inside the budget
/// directly, no re-trim. A realistic payload still previews its head
/// instead of degrading to a bare JSON fragment the approver cannot read.
const ARGS_PREVIEW_MAX_CHARS: usize = 512;

/// The approval-gateway classification for a registered CLI tool call
/// (ADR-0108 Decision 7): the trust key anchors on the registration name
/// under the reserved `CLI` server, the badge is Execute, and the summary
/// is the card's full-argv rendering. `temp_dir` + `call_id` drive the same
/// deterministic temp paths the execution later renders (issue #672), so the
/// argv the approver signs is exactly the one that runs; the
/// file-delivery values ride along as expandable attachments (ADR-0109
/// Decision 8), captured NOW -- the temp file is deleted when the call
/// ends, so the payload snapshot is the approver's only durable view.
fn classify_cli_tool(
    tool: &crate::cli_tools::config::CliToolConfig,
    input: &Value,
    temp_dir: &Path,
    call_id: &str,
) -> (
    ToolKey,
    OperationKind,
    String,
    Vec<crate::approval::FileAttachment>,
) {
    let summary_and_files = |rendered: crate::cli_tools::config::RenderedCall| {
        let mut argv = Vec::with_capacity(rendered.argv.len() + 1);
        argv.push(tool.executable.clone());
        argv.extend(rendered.argv.iter().cloned());
        let mut attachments = rendered
            .files
            .into_iter()
            .map(|f| crate::approval::FileAttachment {
                param: f.param,
                content: f.content,
            })
            .collect::<Vec<_>>();
        let full_argv = argv.join(" ");
        let summary = crate::approval::truncate_summary(&full_argv, ARGS_PREVIEW_MAX_CHARS);
        // When the cap cut, the ellipsis hides a tail the approver cannot
        // otherwise see -- the full rendering rides along as an expandable
        // audit attachment (issue #1195). Mounted only when the summary is
        // actually shorter than the argv: an in-cap summary already shows
        // the verbatim full argv, and this comparison mirrors
        // `truncate_summary`'s own cut decision.
        if summary.chars().count() < full_argv.chars().count() {
            attachments.push(crate::approval::FileAttachment {
                param: "argv".into(),
                content: full_argv,
            });
        }
        (summary, attachments)
    };
    let (summary, file_attachments) =
        match crate::cli_tools::config::render_call(tool, input, temp_dir, call_id) {
            Ok(rendered) => summary_and_files(rendered),
            // Rendering can fail on a mis-shaped call (a missing parameter);
            // the summary then degrades to naming the failure honestly
            // rather than showing an argv that is NOT what would run.
            Err(detail) => (
                format!("cli tool `{}` argv unavailable: {detail}", tool.name),
                Vec::new(),
            ),
        };
    (
        ToolKey::external(ToolKey::CLI_SERVER, tool.name.clone()),
        OperationKind::Execute,
        summary,
        file_attachments,
    )
}

/// One call's classification resolved against the enabled CLI registrations
/// (issue #673): the gate-facing fields plus the matched registration for the
/// dispatch arm. Shared by the dispatch core and the gateway's
/// `handle_tools_call` so the two callers cannot drift on the trust key
/// (ADR-0108 Decision 7) -- a drift here would split the single tool plane's
/// trust axis.
pub(crate) struct ResolvedClassification<'a> {
    pub key: ToolKey,
    pub operation_kind: OperationKind,
    pub summary: String,
    pub file_attachments: Vec<crate::approval::FileAttachment>,
    /// The registration the call's name matched, for the dispatch arm;
    /// `None` when the name is not a registered CLI tool.
    pub cli_tool: Option<&'a crate::cli_tools::config::CliToolConfig>,
}

/// Classify one call with the CLI-registration lookup folded in: a
/// registered name classifies under its own reserved server (`classify_cli_tool`,
/// ADR-0108 Decision 7 -- the approver signs exactly what will run); anything
/// else falls through to the shared builtin/external classification with no
/// file attachments. Registration validation refuses builtin / meta /
/// namespaced names, so the two arms are disjoint.
pub(crate) fn classify_with_cli_tool<'a>(
    cli: &'a [crate::cli_tools::config::CliToolConfig],
    call: &ToolUse,
    temp_dir: &Path,
) -> ResolvedClassification<'a> {
    let cli_tool = cli.iter().find(|t| t.name == call.name);
    match cli_tool {
        Some(tool) => {
            let (key, operation_kind, summary, file_attachments) =
                classify_cli_tool(tool, &call.input, temp_dir, &call.id);
            ResolvedClassification {
                key,
                operation_kind,
                summary,
                file_attachments,
                cli_tool: Some(tool),
            }
        }
        None => {
            let (key, operation_kind, summary) = classify_call(call);
            ResolvedClassification {
                key,
                operation_kind,
                summary,
                file_attachments: Vec::new(),
                cli_tool: None,
            }
        }
    }
}

pub(crate) fn classify_call(call: &ToolUse) -> (ToolKey, OperationKind, String) {
    match definitions::builtin_metadata(&call.name) {
        Some(spec) => (
            ToolKey::builtin(spec.definition.name.as_str()),
            spec.operation_kind,
            summarize_field(&call.input, spec.summary_field, spec.summary_fallback),
        ),
        None => {
            // External arm (issue #301 slice C-loop): a namespaced
            // `mcp__<slug>__<tool>` name resolves the server slug for the
            // approval key + trace so a card / row names the real server; a
            // bare unknown name keeps the "unknown" server. Either way the
            // call badges Network.
            //
            // Issue #312: `try_external` rejects the reserved `"builtin"`
            // server name. A malicious model can spoof `mcp__builtin__*`; we
            // never panic (untrusted input) — the spoof falls back to
            // `RESERVED_SPOOF_SERVER` so classify returns `NeedsApproval`
            // (card surfaces) and routing finds no server (graceful failure).
            let other = call.name.as_str();
            let server = aggregator::parse_namespaced(other)
                .map(|(slug, _)| slug)
                .unwrap_or_else(|| "unknown".to_string());
            let key = match ToolKey::try_external(server, other.to_string()) {
                Ok(k) => k,
                Err(_) => {
                    log::warn!(
                        target: "toptopduck::turn_dispatch",
                        "model emitted tool name `{other}` resolving to reserved \
                         `builtin` server; routing to RESERVED_SPOOF sentinel so \
                         the gate surfaces a card"
                    );
                    ToolKey::external(ToolKey::RESERVED_SPOOF_SERVER, other)
                }
            };
            // The summary carries the call's arguments (issue #661): the
            // approval card's `summary` field is designed for a parameter
            // digest, and a handle-only card makes the user blind-sign
            // whatever the external server is about to receive. The input is
            // compact-JSON'd under the argument-preview cap (issue #663
            // review), then the whole framed string is re-trimmed to the
            // card-body budget HERE -- one string feeds the card, the started
            // event, and the trace entry, so the frontend's exact-match merge
            // holds (an emit-side-only re-trim would re-trim just the
            // broadcast channel and fork the two).
            let summary = crate::approval::truncate_summary(
                &format!(
                    "external tool `{other}` with {}",
                    crate::approval::truncate_summary(
                        &call.input.to_string(),
                        ARGS_PREVIEW_MAX_CHARS,
                    ),
                ),
                crate::approval::SUMMARY_MAX_CHARS,
            );
            (key, OperationKind::Network, summary)
        }
    }
}

/// Render one `input` field as the call summary, truncated. Falls back to
/// `fallback` when the field is absent (a mis-shaped call the executor will
/// itself refuse -- the summary is best-effort). Shared by the `sql`- and
/// `reference_name`-keyed tools so the truncation + fallback shape has one
/// source rather than one near-duplicate per field. The truncation cap +
/// helper live in `persistence::recipe` ([`truncate_trace_summary`]) so a
/// synthetic single-call trace and a live `materialize` summary match.
fn summarize_field(input: &Value, field: &str, fallback: &str) -> String {
    let value = input.get(field).and_then(Value::as_str).unwrap_or(fallback);
    truncate_trace_summary(value)
}

#[cfg(test)]
mod tests {
    //! Dispatch-core contracts (ADR-0078/0080/0085, issue #670 migration):
    //! each test drives [`dispatch_gated_call`] directly -- the same core
    //! every runtime dispatches through -- with the real materializer + an
    //! in-memory DuckDB connection. No loop scaffold: the phase-pair,
    //! denial, CLI-arm, meta-identity, and panic-rollback contracts are the
    //! core's own behavior, asserted without a runtime around it.

    use super::*;
    use crate::approval::{ApprovalRequestBody, ApprovalResponse, ApprovalSink};
    use crate::guardrail::ExecError;
    use crate::model::{DatasetDescriptor, DatasetPrivacy, RectifyProvenance};
    use crate::session::engine::AdminEngine;
    use crate::session::materializer::RealMaterializer;
    use crate::workingset::WorkingSet;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    /// Shared engine setup: a materialized in-memory admin engine + a temp
    /// dir for the materializer. The dispatch tests use literal SQL (no
    /// working-set source registered), so the sandbox runs the same shape
    /// the real engine would for an empty working set.
    struct Engine {
        admin_engine: AdminEngine,
        temp: TempDir,
    }
    impl Engine {
        fn new() -> Self {
            let admin_engine = AdminEngine::materialized();
            let temp = TempDir::new().unwrap();
            Self { admin_engine, temp }
        }
    }

    /// A recording approval sink (mirrors the one in approval's tests). The
    /// core threads it so the gateway can emit approval events; built-in tools
    /// never reach the sink (they classify Allow before emitting). `request_ids`
    /// captures the UUIDs a concurrent responder threads back via
    /// `ApprovalState::respond` to drive the gate-deny path (ADR-0078).
    #[derive(Default)]
    struct RecordingSink {
        requests: Mutex<Vec<String>>,
        request_ids: Mutex<Vec<uuid::Uuid>>,
    }
    impl ApprovalSink for RecordingSink {
        fn emit_request(&self, body: &ApprovalRequestBody) {
            self.requests.lock().unwrap().push(body.summary.clone());
            // body.request_id is a String; parse to the Uuid respond() takes.
            if let Ok(id) = uuid::Uuid::parse_str(&body.request_id) {
                self.request_ids.lock().unwrap().push(id);
            }
        }
        fn emit_resolved(&self, _body: &ApprovalRequestBody, _response: ApprovalResponse) {}
    }

    /// Poll the sink for the first emitted request id (the gate-deny test's
    /// responder waits on this before answering Deny). Uses wall-clock sleep
    /// polling (approval's equivalent switched to condvar, but this local
    /// sink predates that and the cost of porting is not justified here).
    fn poll_request_id(sink: &RecordingSink, timeout: std::time::Duration) -> Option<uuid::Uuid> {
        let start = std::time::Instant::now();
        loop {
            if let Some(id) = sink.request_ids.lock().unwrap().first().copied() {
                return Some(id);
            }
            if start.elapsed() >= timeout {
                return None;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[test]
    fn a_registered_cli_tool_classifies_under_the_cli_server_with_execute_badge() {
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
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
        let (key, kind, summary, attachments) = classify_cli_tool(
            &tool,
            &serde_json::json!({"output": "out.pdf"}),
            std::path::Path::new("/tmp"),
            "tu_1",
        );
        assert_eq!(key.server, ToolKey::CLI_SERVER);
        assert_eq!(key.tool, "pandoc");
        assert_eq!(kind, OperationKind::Execute);
        // ADR-0108 Decision 7: the card renders the complete argv that will
        // run -- the executable plus the rendered template.
        assert_eq!(summary, "/bin/pandoc -o out.pdf");
        assert!(attachments.is_empty(), "no file delivery, no attachments");
    }

    #[test]
    fn a_file_delivery_cli_call_carries_its_value_as_an_approval_attachment() {
        // Issue #672, ADR-0109 Decision 8: the argv shows the deterministic
        // temp path (captured before any file exists -- a denial leaves
        // nothing on disk), and the value itself rides the request as the
        // approver's expandable snapshot.
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
            name: "code-runner".into(),
            description: "runs code".into(),
            executable: "/bin/py".into(),
            argv_template: vec!["{code}".into()],
            params: vec![CliToolParam {
                name: "code".into(),
                description: "source".into(),
                delivery: CliParamDelivery::File,
                varargs: false,
            }],
            env: Default::default(),
            enabled: true,
            source: Default::default(),
            baseline: None,
        };
        let (_, _, summary, attachments) = classify_cli_tool(
            &tool,
            &serde_json::json!({"code": "print(1)"}),
            std::path::Path::new("/session/tmp"),
            "tu_7",
        );
        assert!(
            summary
                .replace('\\', "/")
                .ends_with("/cli-code-runner-code-tu_7.tmp"),
            "the argv carries the temp path, not the value: {summary}"
        );
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].param, "code");
        assert_eq!(attachments[0].content, "print(1)");
    }

    #[test]
    fn cli_summary_degrades_honestly_when_the_argv_cannot_render() {
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
            name: "pandoc".into(),
            description: "convert".into(),
            executable: "/bin/pandoc".into(),
            argv_template: vec!["{output}".into()],
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
        let (_, _, summary, _) = classify_cli_tool(
            &tool,
            &serde_json::json!({}),
            std::path::Path::new("/tmp"),
            "tu_1",
        );
        assert!(
            summary.contains("argv unavailable"),
            "a missing parameter names the failure: {summary}"
        );
    }

    #[test]
    fn an_oversize_cli_argv_mounts_the_full_rendering_as_an_audit_attachment() {
        // Issue #1195: when the summary's cap cuts the argv, the hidden
        // tail is exactly the flags the approver is signing for, so the
        // full rendering rides along as an expandable attachment --
        // mounted only when the cap actually cut (the in-cap case is
        // pinned by the badge test's empty-attachments assert above).
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
            name: "pandoc".into(),
            description: "convert".into(),
            executable: "/bin/pandoc".into(),
            argv_template: vec![],
            params: vec![CliToolParam {
                name: "extra".into(),
                description: "extra flags".into(),
                delivery: CliParamDelivery::Argv,
                varargs: true,
            }],
            env: Default::default(),
            enabled: true,
            source: Default::default(),
            baseline: None,
        };
        let long_flag = format!("--metadata title={}", "x".repeat(600));
        let (_, _, summary, attachments) = classify_cli_tool(
            &tool,
            &serde_json::json!({ "extra": ["--toc", &long_flag] }),
            std::path::Path::new("/tmp"),
            "tu_19",
        );
        // The summary keeps its broadcast-budget shape: capped head plus
        // the ellipsis marker (issue #1009 precedent -- the cap itself is
        // not moving).
        assert_eq!(summary.chars().count(), ARGS_PREVIEW_MAX_CHARS);
        assert!(summary.ends_with("..."));
        // The argv attachment carries the full rendering verbatim -- the
        // exact join, separator, and argument order -- and the summary's
        // head is its prefix, so the approver can verify the card against
        // what will actually run.
        let audit = attachments
            .iter()
            .find(|a| a.param == "argv")
            .expect("oversize argv mounts an audit attachment");
        assert_eq!(
            audit.content,
            format!("/bin/pandoc --toc {long_flag}"),
            "the attachment carries the full verbatim join"
        );
        let head = summary.strip_suffix("...").unwrap();
        assert!(
            audit.content.starts_with(head),
            "the card summary is the full rendering's prefix"
        );
    }

    #[test]
    fn an_oversize_cli_argv_mounts_alongside_the_file_delivery_attachments() {
        // The mount is additive: the file-delivery snapshots the approver
        // needs (the temp files are deleted at call end) stay in the list
        // and the argv audit rides after them -- a rebuild instead of a
        // push would drop them silently.
        use crate::cli_tools::config::{CliParamDelivery, CliToolConfig, CliToolParam};
        let tool = CliToolConfig {
            name: "pandoc".into(),
            description: "convert".into(),
            executable: "/bin/pandoc".into(),
            argv_template: vec!["{input_md}".into()],
            params: vec![
                CliToolParam {
                    name: "input_md".into(),
                    description: "source document".into(),
                    delivery: CliParamDelivery::File,
                    varargs: false,
                },
                CliToolParam {
                    name: "extra".into(),
                    description: "extra flags".into(),
                    delivery: CliParamDelivery::Argv,
                    varargs: true,
                },
            ],
            env: Default::default(),
            enabled: true,
            source: Default::default(),
            baseline: None,
        };
        let long_flag = format!("--metadata title={}", "x".repeat(600));
        let (_, _, summary, attachments) = classify_cli_tool(
            &tool,
            &serde_json::json!({ "input_md": "# hi", "extra": ["--toc", &long_flag] }),
            std::path::Path::new("/tmp"),
            "tu_20",
        );
        assert_eq!(summary.chars().count(), ARGS_PREVIEW_MAX_CHARS);
        assert_eq!(
            attachments.len(),
            2,
            "the argv mount is additive, not a rebuild"
        );
        assert_eq!(attachments[0].param, "input_md");
        assert_eq!(attachments[0].content, "# hi");
        assert_eq!(attachments[1].param, "argv");
    }

    /// A route failure (unknown slug) surfaces as a tool error the agent
    /// self-corrects from (ADR-0077) -- not a turn failure. The error names
    /// the slug so the model gets actionable feedback.
    #[test]
    fn route_external_call_surfaces_an_unknown_slug_as_a_tool_error() {
        let mut mcp = McpAggregator::empty();
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_1".into(),
            name: "mcp__ghost__echo".into(),
            input: serde_json::json!({}),
        };
        let (outcome, envelope) =
            route_external_dual(&call, CallFace::Builtin, &mut mcp, dir.path());
        assert!(envelope.is_none(), "the loop face never relays an envelope");
        assert!(outcome.result.is_error, "unknown slug is a tool error");
        assert!(
            outcome.result.content.contains("ghost"),
            "error names the slug: {}",
            outcome.result.content
        );
        assert!(outcome.promotion.is_none());
    }

    /// A successful route flattens the envelope to its first text block and
    /// keeps the server's `isError: false` (issue #301 slice C-loop). Split
    /// from `route_external_call` so the shaping contract is unit-testable
    /// without a live server.
    #[test]
    fn shape_external_outcome_flattens_a_success_envelope() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_ok".into(),
            name: "mcp__github__search".into(),
            input: serde_json::json!({}),
        };
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": "5 rows"}],
            "isError": false,
        });
        let outcome = shape_external_outcome(
            Ok(envelope),
            &call,
            dir.path(),
            crate::cli_tools::executor::OUTPUT_CAP_BYTES,
        );
        assert!(!outcome.result.is_error, "isError:false -> success");
        assert_eq!(outcome.result.content, "5 rows");
        assert_eq!(outcome.result.tool_use_id, "tu_ok");
        assert!(outcome.promotion.is_none(), "external tools never promote");
    }

    /// A server-side error envelope (`isError: true`) keeps the text block
    /// (the model self-corrects, ADR-0077) but marks the result as an error.
    #[test]
    fn shape_external_outcome_marks_a_server_side_error_envelope() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_err".into(),
            name: "mcp__github__search".into(),
            input: serde_json::json!({}),
        };
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": "rate limited"}],
            "isError": true,
        });
        let outcome = shape_external_outcome(
            Ok(envelope),
            &call,
            dir.path(),
            crate::cli_tools::executor::OUTPUT_CAP_BYTES,
        );
        assert!(outcome.result.is_error, "isError:true -> tool error");
        assert_eq!(outcome.result.content, "rate limited");
        assert!(outcome.promotion.is_none());
    }

    /// A successful envelope whose inline text is structured CSV gets
    /// materialized to tool_output/ and the model-facing content includes the
    /// file path so the agent can reference it via read_csv_auto (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_csv_inline_text() {
        let dir = TempDir::new().unwrap();
        // The inline materializer writes into tool_output/ without creating
        // it (the session pre-creates the dir in production).
        std::fs::create_dir_all(dir.path().join("tool_output")).unwrap();
        let call = ToolUse {
            id: "tu_csv".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let csv = "id,name,value\n1,alice,100\n2,bob,200\n";
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": csv}],
            "isError": false,
        });
        let outcome = shape_external_outcome(
            Ok(envelope),
            &call,
            dir.path(),
            crate::cli_tools::executor::OUTPUT_CAP_BYTES,
        );
        assert!(!outcome.result.is_error);
        // The content carries the original CSV text plus a materialization hint.
        assert!(
            outcome
                .result
                .content
                .contains("Structured output saved to"),
            "content includes materialization hint: {}",
            outcome.result.content
        );
        assert!(
            outcome.result.content.contains("tu_csv.csv"),
            "hint names the materialized file: {}",
            outcome.result.content
        );
        // The file was written to the tool_output directory.
        let written =
            std::fs::read_to_string(dir.path().join("tool_output").join("tu_csv.csv")).unwrap();
        assert_eq!(written, csv);
    }

    /// A successful envelope whose inline text is valid JSON gets materialized
    /// with a `.json` extension (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_json_inline_text() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("tool_output")).unwrap();
        let call = ToolUse {
            id: "tu_json".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let json = r#"[{"city":"Tokyo","pop":37},{"city":"Osaka","pop":19}]"#;
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": json}],
            "isError": false,
        });
        let outcome = shape_external_outcome(
            Ok(envelope),
            &call,
            dir.path(),
            crate::cli_tools::executor::OUTPUT_CAP_BYTES,
        );
        assert!(!outcome.result.is_error);
        assert!(
            outcome.result.content.contains("tu_json.json"),
            "hint names the JSON file: {}",
            outcome.result.content
        );
        let written =
            std::fs::read_to_string(dir.path().join("tool_output").join("tu_json.json")).unwrap();
        assert_eq!(written, json);
    }

    /// A successful envelope whose inline text is TSV gets materialized with
    /// a `.tsv` extension (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_tsv_inline_text() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("tool_output")).unwrap();
        let call = ToolUse {
            id: "tu_tsv".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let tsv = "id\tname\n1\talice\n2\tbob\n";
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": tsv}],
            "isError": false,
        });
        let outcome = shape_external_outcome(
            Ok(envelope),
            &call,
            dir.path(),
            crate::cli_tools::executor::OUTPUT_CAP_BYTES,
        );
        assert!(!outcome.result.is_error);
        assert!(
            outcome.result.content.contains("tu_tsv.tsv"),
            "hint names the TSV file: {}",
            outcome.result.content
        );
        let written =
            std::fs::read_to_string(dir.path().join("tool_output").join("tu_tsv.tsv")).unwrap();
        assert_eq!(written, tsv);
    }

    /// An error envelope with structured text must NOT be materialized — an
    /// error's text is a message, not data (issue #442 design decision).
    #[test]
    fn shape_external_outcome_does_not_materialize_error_envelope_with_structured_text() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_err_csv".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let csv = "id,name\n1,alice\n2,bob\n";
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": csv}],
            "isError": true,
        });
        let outcome = shape_external_outcome(
            Ok(envelope),
            &call,
            dir.path(),
            crate::cli_tools::executor::OUTPUT_CAP_BYTES,
        );
        assert!(outcome.result.is_error);
        // No hint appended — content is the raw text only.
        assert_eq!(outcome.result.content, csv);
        // No file was written.
        assert!(dir.path().read_dir().unwrap().next().is_none());
    }

    /// Over-cap text on the built-in dispatch path spills WHOLE and the
    /// model-facing content becomes the preview trio (issue #1218) -- the
    /// built-in twin of the gateway's `external_call_outcome` spill arm.
    /// The file names `<slug>__<tool>-<call-id>` with the `mcp__` prefix
    /// stripped (the CLI channel's naming family).
    #[test]
    fn shape_external_outcome_spills_over_cap_text_whole() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_big".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": "0123456789ABCDEF"}],
            "isError": false,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path(), 8);
        assert!(!outcome.result.is_error);
        let path = dir
            .path()
            .join("tool_output")
            .join("data__export-tu_big.csv");
        let spilled =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("spill {path:?}: {e}"));
        assert_eq!(
            spilled, "0123456789ABCDEF",
            "the flattened text spills whole, not truncated"
        );
        let content = &outcome.result.content;
        assert!(
            content.starts_with("01234567"),
            "the preview opens with the capped head: {content}"
        );
        assert!(
            content.contains("spilled to:"),
            "the model gets the spill pointer: {content}"
        );
        assert!(
            content.contains("data__export-tu_big.csv"),
            "the marker names the stripped-stem file: {content}"
        );
    }

    /// `isError` is orthogonal to the cap on this path too: an error
    /// envelope's text is as much the data egress as a success's (the
    /// gateway arm's ruling), so it spills the same way with its flag
    /// preserved -- and never reaches the inline materializer.
    #[test]
    fn shape_external_outcome_spills_is_error_envelopes_orthogonally() {
        let dir = TempDir::new().unwrap();
        let call = ToolUse {
            id: "tu_big_err".into(),
            name: "mcp__data__export".into(),
            input: serde_json::json!({}),
        };
        let envelope = serde_json::json!({
            "content": [{"type": "text", "text": "ERRORDETAIL-0123456789"}],
            "isError": true,
        });
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path(), 8);
        assert!(outcome.result.is_error, "the error flag survives the spill");
        let path = dir
            .path()
            .join("tool_output")
            .join("data__export-tu_big_err.csv");
        let spilled =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("spill {path:?}: {e}"));
        assert_eq!(spilled, "ERRORDETAIL-0123456789");
        assert!(
            outcome.result.content.contains("spilled to:"),
            "the error path gets the pointer too"
        );
    }

    /// A namespaced name classifies under its server slug (not "unknown") so
    /// the approval card + trace name the real server; a bare unknown name
    /// falls back to "unknown" (issue #301 slice C-loop).
    #[test]
    fn classify_call_keys_a_namespaced_name_under_its_slug() {
        let namespaced = ToolUse {
            id: "tu_1".into(),
            name: "mcp__github__search".into(),
            input: serde_json::json!({}),
        };
        let (key, kind, summary) = classify_call(&namespaced);
        assert_eq!(key, ToolKey::external("github", "mcp__github__search"));
        assert_eq!(kind, OperationKind::Network);
        assert!(summary.contains("mcp__github__search"));

        let bare = ToolUse {
            id: "tu_2".into(),
            name: "stray_tool".into(),
            input: serde_json::json!({}),
        };
        let (key, _, _) = classify_call(&bare);
        assert_eq!(key, ToolKey::external("unknown", "stray_tool"));
    }

    /// Issue #826: the external-call summary shares the 512 bound with the
    /// trace-summary cap, and the constructed frame-inclusive string is
    /// re-trimmed at the construction site so the card, the started event,
    /// and the trace entry carry ONE string -- the frontend merges the card
    /// to its call by exact string match, so a broadcast-only re-trim would
    /// fork the channels. Pinned with literals so an accidental revert of
    /// either cap or of the construction-site re-trim fails here: the framed
    /// summary comes back at exactly 512 chars, frame intact, cut with the
    /// approval ellipsis.
    #[test]
    fn classify_call_caps_the_external_summary_at_the_card_budget() {
        let tool = ToolUse {
            id: "tu_1".into(),
            name: "mcp__github__search".into(),
            input: serde_json::json!({ "q": "z".repeat(600) }),
        };
        let (_, _, summary) = classify_call(&tool);
        assert!(
            summary.starts_with("external tool `mcp__github__search` with "),
            "frame survives the construction-site trim"
        );
        assert_eq!(summary.chars().count(), 512);
        assert!(summary.ends_with("..."), "cut with the approval ellipsis");
    }

    /// The ADR-0078 (issue #297) event stream: a dispatch emits the
    /// started/completed pair around it (completed payload = the display
    /// trace entry, success excerpt emptied), and a failed call's completion
    /// carries the error message.
    #[test]
    fn tool_call_event_stream_pairs_started_and_completed_around_dispatch() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        // A failing explore (unknown table) -- its completion must carry the
        // error excerpt; then a succeeding materialize.
        let failing = ToolUse {
            id: "tu_1".into(),
            name: "explore".into(),
            input: json!({"sql": "SELECT * FROM missing"}),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &failing,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the failing explore dispatches");
        assert!(result.is_error, "the unknown-table explore failed");
        let entry = entry.expect("a dispatched call records an entry");
        assert!(!entry.success);
        assert!(
            !entry.result_excerpt.is_empty(),
            "the failure message rides the trace entry"
        );
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 2, "one dispatch -> Started + Completed");
        assert_eq!(
            phases[0],
            TurnPhase::ToolCallStarted {
                id: None,
                name: "explore".into(),
                operation_kind: OperationKind::Read,
                summary: "SELECT * FROM missing".into(),
                task: None,
            }
        );
        match &phases[1] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(view.name, "explore");
                assert!(!view.success, "the unknown-table explore failed");
                assert!(
                    !view.result_excerpt.is_empty(),
                    "the failure message rides the completion"
                );
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }

        let landing = ToolUse {
            id: "tu_2".into(),
            name: "materialize".into(),
            input: json!({"sql": "SELECT 1 AS x"}),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (_, entry, promotion, _) = dispatch_gated_call(
            &landing,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the materialize dispatches");
        let entry = entry.expect("a dispatched call records an entry");
        assert!(entry.success);
        assert!(promotion.is_some(), "a materialize lands a promotion");
        let phases = phases.into_inner().unwrap();
        assert_eq!(
            phases[0],
            TurnPhase::ToolCallStarted {
                id: None,
                name: "materialize".into(),
                operation_kind: OperationKind::Write,
                summary: "SELECT 1 AS x".into(),
                task: None,
            }
        );
        match &phases[1] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(view.name, "materialize");
                assert!(view.success);
                assert!(view.result_excerpt.is_empty(), "success excerpt emptied");
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }
    }

    /// The `create_skill` dispatch arm (ADR-0122 Decisions 1+3): a
    /// malformed document refuses with the bare typed error (no trace row,
    /// no phase, no card), and a trusted (always-allowed) call executes the
    /// mint -- a Write-shaped started/completed phase pair + trace row, and
    /// the skill lands on disk verbatim + enabled. The trusted mint is
    /// seeded with a STALE disabled entry, so it is the composite's clear
    /// that lands the rebirth enabled -- and the success prose reads as
    /// the enabled branch.
    #[test]
    fn dispatch_serves_create_skill_refusals_and_a_trusted_mint() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let live = crate::LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore,
            engine.temp.path().join("config.json"),
        );
        // Seed the stale disabled entry: the mint's live-config composite
        // (not the registry's default) is what lands the rebirth enabled,
        // which the assertions below pin.
        live.set_skill_enabled("sql-coach", false)
            .expect("stale disable");
        let skills_root = tempfile::tempdir().expect("skills root");
        let create = crate::skills::create::SkillCreateGate {
            root: skills_root.path(),
            live: Some(&live),
        };

        // (a) A malformed document: the bare typed error, nothing else.
        let bad = ToolUse {
            id: "c1".into(),
            name: "create_skill".into(),
            input: json!({"skillMarkdown": "no frontmatter at all"}),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &bad,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &create,
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the refused create returns, not aborts");
        assert!(result.is_error, "a malformed document is the call's error");
        assert!(
            result.content.starts_with("create_skill"),
            "{}",
            result.content
        );
        assert!(entry.is_none(), "a refusal records no trace row");
        assert!(
            phases.into_inner().unwrap().is_empty(),
            "a refusal emits no phase"
        );
        assert!(
            sink.requests.lock().unwrap().is_empty(),
            "a refusal never surfaces a card"
        );

        // (b) A trusted mint: the always-allow short-circuit passes the
        // gate, the composite lands enabled, and the bytes are verbatim.
        approval.seed_trust(&crate::approval::ToolKey::builtin(
            crate::skills::create::CREATE_SKILL,
        ));
        let markdown = "---\nname: sql-coach\ndescription: Coach SQL.\nlicense: MIT\n\
             ---\nCoach the body.\n";
        let good = ToolUse {
            id: "c2".into(),
            name: "create_skill".into(),
            input: json!({ "skillMarkdown": markdown }),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let (result, entry, _, _) = dispatch_gated_call(
            &good,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &create,
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the trusted create dispatches");
        assert!(!result.is_error, "the mint succeeds: {}", result.content);
        assert!(
            result.content.contains("invocable by name this session"),
            "the enabled branch's prose rides the result: {}",
            result.content
        );
        let entry = entry.expect("a served mint records an entry");
        assert!(entry.success);
        assert_eq!(entry.operation_kind, OperationKind::Write);
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 2, "one mint -> Started + Completed");
        assert_eq!(
            phases[0],
            TurnPhase::ToolCallStarted {
                id: None,
                name: "create_skill".into(),
                operation_kind: OperationKind::Write,
                summary: "Create skill `sql-coach`: Coach SQL.".into(),
                task: None,
            }
        );
        let on_disk =
            std::fs::read_to_string(skills_root.path().join("sql-coach/SKILL.md")).expect("read");
        assert_eq!(on_disk, markdown, "the bytes land verbatim");
        assert!(
            !live.load().disabled_skills.contains("sql-coach"),
            "the mint lands enabled"
        );
    }

    /// The workspace write tools' interception arm (issue #1406): a call
    /// with no bound workspace is refused through the shared core AHEAD of
    /// the gate -- the model's error, no card, no trace entry. The returned
    /// message also proves the arm routed the name (an unwired arm would
    /// fall to the unknown-name external classification and suspend on a
    /// card instead of returning).
    #[test]
    fn dispatch_refuses_a_workspace_write_without_a_workspace() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        // The workspace axis connected but unbound -- the production
        // temp-fallback shape the #1406 triage locked the refusal against.
        let mut slot = None;
        let mut d = DispatchDeps::test_deps_with_workspace(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
            &mut slot,
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "w1".into(),
            name: "write".into(),
            input: json!({"file_path": "a.txt", "content": "x"}),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("a refusal is a tool result, not an abort");
        assert!(result.is_error);
        assert!(
            result.content.contains("no session workspace"),
            "{}",
            result.content
        );
        assert!(entry.is_none(), "a pre-gate refusal records no trace entry");
        assert_eq!(sink.requests.lock().unwrap().len(), 0, "no card is emitted");
        let _ = phases.into_inner().unwrap();
    }

    /// The discovery trio's routing through the same interception arm
    /// (issue #1385): an ungated read-only call with no bound workspace
    /// refuses as a tool result (never a card -- an unwired arm would fall
    /// to the unknown-name external classification and suspend), and the
    /// readonly arm records a failed trace entry for the refusal (the
    /// `explore` posture, unlike the write pair's pre-gate refusal). The
    /// responder thread denies any card that DOES appear: if a regression
    /// ever unwires the arm, the parked gate would hang the test forever
    /// (the over-cap precedent) -- the denial converts that regression
    /// into the clean assertion failure below.
    #[test]
    fn dispatch_routes_a_discovery_tool_without_a_card() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut slot = None;
        let mut d = DispatchDeps::test_deps_with_workspace(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
            &mut slot,
        );
        let cancel = CancelToken::new();
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            if let Some(request_id) = poll_request_id(&sink_c, std::time::Duration::from_secs(2)) {
                let _ = approval_c.respond(request_id, ApprovalResponse::Deny);
            }
        });
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "g1".into(),
            name: "grep".into(),
            input: json!({"pattern": "needle"}),
        };
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut |_| {},
            None,
        )
        .expect("a refusal is a tool result, not an abort");
        responder.join().expect("responder exits");
        assert!(result.is_error);
        assert!(
            result.content.contains("no session workspace"),
            "{}",
            result.content
        );
        assert_eq!(sink.requests.lock().unwrap().len(), 0, "no card is emitted");
        let entry = entry.expect("the readonly arm records its refusals");
        assert!(!entry.success);
    }

    /// The positive leg of the same routing: a discovery call under a
    /// bound workspace flows through the full interception arm and
    /// resolves without a card -- the refusal pin above covers the
    /// no-workspace leg only, and the below-arm unit test never passes
    /// through this arm at all.
    #[test]
    fn dispatch_routes_a_discovery_tool_success_without_a_card() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let ws_path = engine.temp.path().join("ws");
        std::fs::create_dir(&ws_path).unwrap();
        std::fs::write(ws_path.join("a.txt"), "hello\n").unwrap();
        let mut slot = Some(std::fs::canonicalize(&ws_path).unwrap());
        let mut d = DispatchDeps::test_deps_with_workspace(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
            &mut slot,
        );
        let cancel = CancelToken::new();
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        // The defensive deny responder again: if a regression ever unwires
        // the arm, the parked gate would hang instead of the assert below.
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            if let Some(request_id) = poll_request_id(&sink_c, std::time::Duration::from_secs(2)) {
                let _ = approval_c.respond(request_id, ApprovalResponse::Deny);
            }
        });
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "g2".into(),
            name: "glob".into(),
            input: json!({"pattern": "*.txt"}),
        };
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut |_| {},
            None,
        )
        .expect("a discovery resolution is a tool result, not an abort");
        responder.join().expect("responder exits");
        assert!(!result.is_error, "{}", result.content);
        assert_eq!(result.content, "a.txt\n");
        assert_eq!(sink.requests.lock().unwrap().len(), 0, "no card is emitted");
        let entry = entry.expect("the readonly arm records its successes");
        assert!(entry.success);
        assert_eq!(entry.name, "glob");
    }

    /// The create arm's denied envelope (ADR-0078's shape on this channel):
    /// a gate denial completes as the tool-level error + one denied trace
    /// row with NO started phase -- and the refusal never mints, so nothing
    /// lands on disk.
    #[test]
    fn dispatch_denies_create_skill_without_minting() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        // PerCall + untrusted: the gate surfaces the card, and the responder
        // answers Deny.
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let live = crate::LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore,
            engine.temp.path().join("config.json"),
        );
        let skills_root = tempfile::tempdir().expect("skills root");
        let create = crate::skills::create::SkillCreateGate {
            root: skills_root.path(),
            live: Some(&live),
        };
        let call = ToolUse {
            id: "c3".into(),
            name: "create_skill".into(),
            input: json!({
                "skillMarkdown": "---\nname: sql-coach\ndescription: Coach SQL.\n---\nBody.\n"
            }),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let request_id = poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            approval_c
                .respond(request_id, ApprovalResponse::Deny)
                .expect("deny ok");
        });
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &create,
            &gate,
            &mut on_phase,
            None,
        )
        .expect("a denial is a tool result, not an abort");
        responder.join().expect("responder thread");

        assert!(result.is_error, "the denial is the call's error");
        assert_eq!(result.content, DENIED_BY_GATEWAY_CONTENT);
        let entry = entry.expect("a denial records an entry");
        assert!(!entry.success);
        assert_eq!(entry.operation_kind, OperationKind::Write);
        assert_eq!(entry.result_excerpt, "denied by approval gateway");
        let phases = phases.into_inner().unwrap();
        assert_eq!(
            phases.len(),
            1,
            "a denial completes without a started phase"
        );
        match &phases[0] {
            TurnPhase::ToolCallCompleted(view) => {
                assert!(!view.success, "the denial completes failure");
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }
        assert!(
            !skills_root.path().join("sql-coach").exists(),
            "the denial never mints"
        );
    }

    /// The parked gate record carries the face-derived call id (the #1267
    /// terminal-echo abandonment aligns on `parked_call_id`): a Bridge
    /// call parks under the call's wire id, a Builtin call parks with
    /// `None` -- both branches of the discriminator pinned through the
    /// real dispatch, so a swapped or regressed arm reddens here.
    #[test]
    fn the_parked_gate_record_carries_the_face_derived_call_id() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let live = crate::LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore,
            engine.temp.path().join("config.json"),
        );
        let skills_root = tempfile::tempdir().expect("skills root");
        let create = crate::skills::create::SkillCreateGate {
            root: skills_root.path(),
            live: Some(&live),
        };
        let read = crate::skills::read::SkillReadGate::inert();

        // (a) The Bridge face: a built-in-only name falls through the face
        // gate to the unknown-external card, parking under the wire id.
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "rpc-7".into(),
            name: "present_files".into(),
            input: json!({}),
        };
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let watcher = std::thread::spawn(move || {
            poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted the unknown-external card");
            let parked = approval_c.parked_call_id();
            approval_c.abandon_pending();
            parked
        });
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let outcome = dispatch_gated_call(
            &call,
            CallFace::Bridge,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &read,
            &create,
            &gate,
            &mut |_| {},
            None,
        );
        let parked = watcher.join().expect("watcher thread");
        assert!(
            matches!(outcome, Err(DispatchAbort::Gate)),
            "the abandonment ends the bridge call as a gate abort"
        );
        assert_eq!(
            parked,
            Some("rpc-7".into()),
            "the bridge card parks under the call's wire id (#1267 echo alignment)"
        );

        // (b) The Builtin face: an unlisted name parks with `None` -- a
        // built-in call has no wire id.
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "tu_9".into(),
            name: "never_listed_tool".into(),
            input: json!({}),
        };
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let watcher = std::thread::spawn(move || {
            poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted the unknown-external card");
            let parked = approval_c.parked_call_id();
            approval_c.abandon_pending();
            parked
        });
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let outcome = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &read,
            &create,
            &gate,
            &mut |_| {},
            None,
        );
        let parked = watcher.join().expect("watcher thread");
        assert!(
            matches!(outcome, Err(DispatchAbort::Gate)),
            "the abandonment ends the built-in call as a gate abort"
        );
        assert_eq!(
            parked, None,
            "a built-in call parks with no wire id for the echo alignment"
        );
    }

    /// The create arm's post-race failure envelope: a same-name mint
    /// landing inside the gate-pending window races the approved write --
    /// the typed NameTaken error rides the result (isError) with a failed
    /// trace row and the started/completed pair intact, so the model
    /// self-corrects from the message alone.
    #[test]
    fn dispatch_serves_a_post_race_create_failure_as_the_calls_error() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let live = crate::LiveProviderConfig::new(
            crate::provider::keychain::KeychainStore,
            engine.temp.path().join("config.json"),
        );
        let skills_root = tempfile::tempdir().expect("skills root");
        let create = crate::skills::create::SkillCreateGate {
            root: skills_root.path(),
            live: Some(&live),
        };
        let call = ToolUse {
            id: "c4".into(),
            name: "create_skill".into(),
            input: json!({
                "skillMarkdown": "---\nname: sql-coach\ndescription: Coach SQL.\n---\nBody.\n"
            }),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        // The post-race seam: the responder takes the name while the card
        // is pending, then allows -- the approved write meets a taken name.
        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let incumbent = skills_root.path().join("sql-coach");
        let responder = std::thread::spawn(move || {
            let request_id = poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            std::fs::create_dir_all(&incumbent).expect("occupy the name mid-window");
            approval_c
                .respond(request_id, ApprovalResponse::AllowOnce)
                .expect("allow ok");
        });
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &create,
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the raced create returns, not aborts");
        responder.join().expect("responder thread");

        assert!(result.is_error, "the raced write is the call's error");
        assert!(
            result.content.starts_with("create_skill") && result.content.contains("already taken"),
            "the typed error rides the result: {}",
            result.content
        );
        let entry = entry.expect("a raced failure records an entry");
        assert!(!entry.success);
        assert_eq!(entry.operation_kind, OperationKind::Write);
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 2, "started + completed survive the failure");
        assert!(
            skills_root.path().join("sql-coach").exists(),
            "the incumbent directory stays"
        );
        assert!(
            !skills_root.path().join("sql-coach/SKILL.md").exists(),
            "no mint landed into the incumbent"
        );
    }

    /// An externally-classified call the gate denies completes WITHOUT
    /// started (the card flips to its resolved-deny row) and never
    /// dispatches (ADR-0078).
    #[test]
    fn gate_denied_call_emits_only_completion_no_started() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        // An unknown tool name classifies as external (the gateway suspends
        // instead of passing through), so the dispatch reaches the deny branch.
        let call = ToolUse {
            id: "tu_1".into(),
            name: "external_tool".into(),
            input: json!({}),
        };
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let phases = Arc::new(std::sync::Mutex::new(Vec::new()));

        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let request_id = poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            approval_c
                .respond(request_id, ApprovalResponse::Deny)
                .expect("deny ok");
        });

        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let shared = Arc::clone(&phases);
        let mut forward = move |p: TurnPhase| shared.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, promotion, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut forward,
            None,
        )
        .expect("a denial is a tool result, not an abort");
        responder.join().expect("responder thread");

        // The denial routes back as a tool-level error (ADR-0077).
        assert!(result.is_error, "the denied call completes failure");
        assert_eq!(result.content, "tool call denied by the approval gateway");
        let entry = entry.expect("the denial records one failure row");
        assert!(!entry.success);
        assert_eq!(entry.result_excerpt, "denied by approval gateway");
        assert!(promotion.is_none());

        let phases = phases.lock().unwrap().clone();
        assert_eq!(phases.len(), 1, "denied call: completion only, no started");
        match &phases[0] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(view.name, "external_tool");
                assert!(!view.success, "the denied call completes failure");
                assert_eq!(view.result_excerpt, "denied by approval gateway");
            }
            other => panic!("expected ToolCallCompleted for the denied call, got {other:?}"),
        }
    }

    /// ADR-0124 (#1087; pin #1090): a malformed `present_files` call
    /// refused at dispatch wires through as the call's OWN error result --
    /// no trace entry, no phase pair, nothing on the presented channel.
    #[test]
    fn present_files_refusal_at_dispatch_is_error_result_without_trace_or_channel() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "tu_pf".into(),
            name: "present_files".into(),
            input: json!({"files": ["/a.pdf", 5]}),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let mut presented: Vec<String> = Vec::new();
        let (result, entry, promotion, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut presented,
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("a refusal is a tool result, not an abort");

        assert!(result.is_error, "the malformed call is the call's error");
        assert!(
            result.content.starts_with("present_files"),
            "the refusal names the tool: {}",
            result.content
        );
        assert!(entry.is_none(), "a refusal records no trace row");
        assert!(promotion.is_none());
        assert!(presented.is_empty(), "nothing lands on the channel");
        assert!(
            phases.into_inner().unwrap().is_empty(),
            "a refusal emits no phase pair"
        );
    }

    /// The registered-CLI dispatch arm (issue #673): a seeded trust key (the
    /// single plane's payoff: one trust axis, two callers) skips the card;
    /// the executor's structured spawn failure feeds back as a tool-level
    /// error with the started/completed pair and one trace row.
    #[test]
    fn dispatch_gated_call_dispatches_a_registered_cli_tool() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        // The same key the gateway arm derives from the registration name
        // bypasses the card on this path too.
        approval.seed_trust(&ToolKey::external(ToolKey::CLI_SERVER, "doc-convert"));
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "tu_1".into(),
            name: "doc-convert".into(),
            input: json!({"value": "yes"}),
        };
        let registration = crate::cli_tools::config::CliToolConfig {
            name: "doc-convert".into(),
            description: "convert a document".into(),
            executable: "/no/such/cli-fixture-exe".into(),
            argv_template: vec!["--flag".into(), "{value}".into()],
            params: vec![crate::cli_tools::config::CliToolParam {
                name: "value".into(),
                description: "a flag value".into(),
                delivery: crate::cli_tools::config::CliParamDelivery::Argv,
                varargs: false,
            }],
            env: Default::default(),
            enabled: true,
            source: crate::cli_tools::config::CliToolSource::User,
            baseline: None,
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, promotion, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            std::slice::from_ref(&registration),
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the CLI call dispatches");
        assert!(
            result.is_error,
            "the dangling executable is a spawn failure"
        );
        assert!(
            result.content.contains("cli-fixture-exe"),
            "the failure names the executable: {}",
            result.content
        );
        assert!(promotion.is_none(), "external executions never promote");
        let entry = entry.expect("one call -> one trace row");
        assert!(!entry.success);
        assert!(
            entry.result_excerpt.contains("cli-fixture-exe"),
            "the failure names the executable: {}",
            entry.result_excerpt
        );
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 2, "started + completed");
        match &phases[0] {
            TurnPhase::ToolCallStarted {
                name,
                operation_kind,
                ..
            } => {
                assert_eq!(name, "doc-convert");
                assert_eq!(*operation_kind, OperationKind::Execute);
            }
            other => panic!("expected ToolCallStarted, got {other:?}"),
        }
        match &phases[1] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(view.name, "doc-convert");
                assert!(!view.success, "the dangling executable is a spawn failure");
                assert!(
                    view.result_excerpt.contains("cli-fixture-exe"),
                    "the failure names the executable: {}",
                    view.result_excerpt
                );
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }
    }

    /// Issue #1408's wiring pin: the dispatch arm's pipeline artifacts ride
    /// `deps.temp_path`, never the launch cwd. The deps here are
    /// distinguishable -- a bound workspace that exists and a session temp
    /// that does not -- so the file-delivery write fails in the missing temp
    /// with the structured error; a wiring that wrongly rode the cwd would
    /// write into the surviving workspace and fail at the spawn instead,
    /// naming the executable, which the assert discriminates against.
    #[test]
    fn dispatch_gated_call_routes_file_delivery_to_the_session_temp() {
        let engine = Engine::new();
        let workspace_dir = TempDir::new().unwrap();
        let gone = TempDir::new().unwrap();
        let missing_temp = gone.path().to_path_buf();
        drop(gone);
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut bound = Some(workspace_dir.path().to_path_buf());
        let mut d = DispatchDeps::test_deps_with_workspace(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            &missing_temp,
            &mut refs,
            &mut bound,
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        approval.seed_trust(&ToolKey::external(ToolKey::CLI_SERVER, "doc-convert"));
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "tu_1".into(),
            name: "doc-convert".into(),
            input: json!({"doc": "hello body"}),
        };
        let registration = crate::cli_tools::config::CliToolConfig {
            name: "doc-convert".into(),
            description: "convert a document".into(),
            executable: "/no/such/cli-fixture-exe".into(),
            argv_template: vec!["--doc".into(), "{doc}".into()],
            params: vec![crate::cli_tools::config::CliToolParam {
                name: "doc".into(),
                description: "the document body".into(),
                delivery: crate::cli_tools::config::CliParamDelivery::File,
                varargs: false,
            }],
            env: Default::default(),
            enabled: true,
            source: crate::cli_tools::config::CliToolSource::User,
            baseline: None,
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, _entry, _promotion, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            std::slice::from_ref(&registration),
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the CLI call dispatches");
        assert!(result.is_error);
        assert!(
            result.content.contains("failed to write a file-delivery"),
            "the write fails in the missing session temp, not the workspace: {}",
            result.content
        );
    }

    /// The denial variant on the CLI arm: a registered tool the gate denies
    /// completes WITHOUT started (the card flips to its resolved-deny row)
    /// and never spawns -- the same ADR-0078 shape the external-classified
    /// denial pins, holding for the CLI classification too.
    #[test]
    fn gate_denied_cli_tool_emits_only_completion_no_started() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let call = ToolUse {
            id: "tu_1".into(),
            name: "doc-convert".into(),
            input: json!({"value": "yes"}),
        };
        let registration = crate::cli_tools::config::CliToolConfig {
            name: "doc-convert".into(),
            description: "convert a document".into(),
            executable: "/no/such/cli-fixture-exe".into(),
            argv_template: vec!["--flag".into(), "{value}".into()],
            params: vec![crate::cli_tools::config::CliToolParam {
                name: "value".into(),
                description: "a flag value".into(),
                delivery: crate::cli_tools::config::CliParamDelivery::Argv,
                varargs: false,
            }],
            env: Default::default(),
            enabled: true,
            source: crate::cli_tools::config::CliToolSource::User,
            baseline: None,
        };
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());

        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let request_id = poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            approval_c
                .respond(request_id, ApprovalResponse::Deny)
                .expect("deny ok");
        });

        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, _, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            std::slice::from_ref(&registration),
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("a denial is a tool result, not an abort");
        responder.join().expect("responder thread");

        assert!(result.is_error);
        let entry = entry.expect("the denial records one failure row");
        assert!(!entry.success);
        assert_eq!(entry.result_excerpt, "denied by approval gateway");

        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 1, "denied CLI call: completion only");
        match &phases[0] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(view.name, "doc-convert");
                assert!(!view.success);
                assert_eq!(view.result_excerpt, "denied by approval gateway");
            }
            other => panic!("expected ToolCallCompleted for the denied CLI call, got {other:?}"),
        }
    }

    /// A denied `mcp_invoke` (ADR-0105 Decision 4 + ADR-0078): the gate
    /// consumed the RESOLVED handle, so the deny completion names the backend
    /// handle -- never "mcp_invoke" (issue #663 review: this identity was
    /// pinned on the allow path only; the deny row's naming had no pin).
    #[test]
    fn denied_invoke_completion_names_the_resolved_handle() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let call = ToolUse {
            id: "tu_1".into(),
            name: "mcp_invoke".into(),
            input: json!({"tool": "mcp__live__echo"}),
        };
        // A live catalog entry (dead-port transport: the denial lands at the
        // gate, before any dispatch, so the server is never contacted).
        // Display "Live" slugifies to "live".
        let mut mcp = McpAggregator::catalog_server_for_test(
            "Live",
            vec![json!({"name": "echo", "description": "echo", "inputSchema": {"type": "object"}})],
        );
        let approval = Arc::new(ApprovalState::new());
        let sink = Arc::new(RecordingSink::default());
        let phases = Arc::new(std::sync::Mutex::new(Vec::new()));

        let approval_c = Arc::clone(&approval);
        let sink_c = Arc::clone(&sink);
        let responder = std::thread::spawn(move || {
            let request_id = poll_request_id(&sink_c, std::time::Duration::from_secs(2))
                .expect("the gate emitted an approval request");
            approval_c
                .respond(request_id, ApprovalResponse::Deny)
                .expect("deny ok");
        });

        let gate = GateCtx {
            approval: &approval,
            sink: &*sink,
            cancel: &cancel,
        };
        let shared = Arc::clone(&phases);
        let mut forward = move |p: TurnPhase| shared.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (_, entry, _, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut forward,
            None,
        )
        .expect("a denial is a tool result, not an abort");
        responder.join().expect("responder thread");

        let entry = entry.expect("the denial records one failure row");
        assert_eq!(
            entry.name, "mcp__live__echo",
            "the deny row names the resolved handle, never mcp_invoke"
        );
        assert!(!entry.success);

        let phases = phases.lock().unwrap().clone();
        let completed: Vec<&TurnPhase> = phases
            .iter()
            .filter(|p| matches!(p, TurnPhase::ToolCallCompleted { .. }))
            .collect();
        assert_eq!(completed.len(), 1, "one completion for the denied invoke");
        match completed[0] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(
                    view.name, "mcp__live__echo",
                    "the deny row names the resolved handle, never mcp_invoke"
                );
                assert!(!view.success);
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }
    }

    /// The allow-path mirror of the deny pin above (ADR-0105 Decision 4; the
    /// issue #696 gap): with the backend handle's trust key seeded, a
    /// resolved `mcp_invoke` passes the gate and dispatches through the
    /// external routing arm -- here against the unreachable test transport,
    /// so the dispatch lands as an honest route failure -- and EVERY surface
    /// (the trace entry, the phase pair, the model-facing error) names the
    /// backend handle, never "mcp_invoke". The full resolved -> allow ->
    /// dispatch -> trace chain in one offline pin.
    #[test]
    fn allowed_invoke_dispatches_and_traces_under_the_resolved_handle() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        let call = ToolUse {
            id: "tu_1".into(),
            name: "mcp_invoke".into(),
            input: json!({"tool": "mcp__live__echo"}),
        };
        // A live catalog entry (dead-port transport: the dispatch genuinely
        // attempts the route and fails honestly). Display "Live" slugifies
        // to "live".
        let mut mcp = McpAggregator::catalog_server_for_test(
            "Live",
            vec![json!({"name": "echo", "description": "echo", "inputSchema": {"type": "object"}})],
        );
        let approval = ApprovalState::new();
        // The backend handle's trust key skips the card (the gate consumes
        // the RESOLVED identity, so the seeded key is the backend's, not
        // mcp_invoke's).
        approval.seed_trust(&ToolKey::external("live", "mcp__live__echo"));
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, promotion, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("an allowed call dispatches");
        // The unreachable transport is a route failure -- a tool-level error
        // naming the backend tool, not a turn abort.
        assert!(
            result.is_error,
            "the dead transport is an honest route failure"
        );
        assert!(
            result.content.contains("mcp__live__echo"),
            "the model-facing error names the backend handle: {}",
            result.content
        );
        assert!(promotion.is_none(), "external tools never promote");
        let entry = entry.expect("the dispatch records one trace row");
        assert_eq!(
            entry.name, "mcp__live__echo",
            "the trace row names the resolved handle, never mcp_invoke"
        );
        assert!(!entry.success, "the route failure lands as a failed call");
        assert!(
            entry.result_excerpt.contains("mcp__live__echo"),
            "the failure anchor names the backend handle: {}",
            entry.result_excerpt
        );
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 2, "started + completed around the dispatch");
        match &phases[0] {
            TurnPhase::ToolCallStarted { name, .. } => {
                assert_eq!(name, "mcp__live__echo", "started names the backend handle");
            }
            other => panic!("expected ToolCallStarted, got {other:?}"),
        }
        match &phases[1] {
            TurnPhase::ToolCallCompleted(view) => {
                assert_eq!(
                    view.name, "mcp__live__echo",
                    "completed names the backend handle"
                );
                assert!(!view.success);
            }
            other => panic!("expected ToolCallCompleted, got {other:?}"),
        }
    }

    // --- panic guards (issue #321) -----------------------------------------

    /// A materializer that registers result_1 then panics in the return
    /// window -- drives the ghost-rollback contract below.
    struct GhostThenPanicMaterializer;
    impl Materializer for GhostThenPanicMaterializer {
        fn try_materialize(
            &self,
            _sql: &str,
            _cancel: &CancelToken,
            result_name: String,
            deps: &mut DispatchDeps,
        ) -> Result<DatasetDescriptor, ExecError> {
            // Create the physical table first (mirrors RealMaterializer's
            // install_result step) so the ghost rollback exercises the DROP
            // TABLE success path.
            let create_sql = format!(
                "CREATE TABLE {} AS SELECT 1 AS x",
                quote_ident(&result_name)
            );
            deps.engine
                .conn()
                .execute_batch(&create_sql)
                .expect("fixture CREATE TABLE");
            let descriptor = DatasetDescriptor {
                reference_name: result_name.clone(),
                display_name: result_name,
                source_path: String::new(),
                columns: Vec::new(),
                row_count: 0,
                sample: Vec::new(),
                fingerprint: String::new(),
                rectify: RectifyProvenance::NotApplicable,
                privacy: DatasetPrivacy::default(),
                stale: None,
            };
            deps.working_set.register_result(descriptor);
            panic!("simulated post-register panic in tool dispatch")
        }
    }

    /// Issue #321: a panic in the dispatch (mid-materialize, after `result_N`
    /// is registered) surfaces as [`DispatchAbort::Panic`] AND rolls back the
    /// ghost `result_N` so the working_set <-> history 1:1 invariant holds.
    #[test]
    fn dispatch_panic_aborts_and_rolls_back_ghost_result() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let cancel = CancelToken::new();
        // The model emits a materialize call; GhostThenPanicMaterializer
        // registers result_1 then panics in the return window.
        let call = ToolUse {
            id: "tu_1".into(),
            name: "materialize".into(),
            input: json!({"sql": "SELECT 1 AS x"}),
        };
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let mut materializer = GhostThenPanicMaterializer;
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let abort = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut materializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut |_| {},
            None,
        )
        .expect_err("a dispatch panic aborts");
        match &abort {
            DispatchAbort::Panic(Termination::Transient(detail)) => {
                assert!(
                    detail.contains("tool dispatch"),
                    "detail names the panic step: {detail}"
                );
                assert!(
                    detail.contains("simulated post-register panic"),
                    "detail carries the panic message: {detail}"
                );
            }
            other => panic!("expected Panic(Transient), got {other:?}"),
        }
        assert_eq!(
            d.working_set.next_result_number(),
            1,
            "ghost result_1 rolled back; next_result_number is back to 1"
        );
        assert!(
            !d.working_set.is_result("result_1"),
            "result_1 unregistered from the working set"
        );
        // Verify the physical table was dropped by the rollback (not just
        // unregistered from the working set).
        let table_count: i64 = d
            .engine
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM information_schema.tables \
                 WHERE table_name = 'result_1'",
                [],
                |row| row.get(0),
            )
            .expect("query information_schema");
        assert_eq!(
            table_count, 0,
            "physical result_1 table dropped by ghost rollback"
        );
    }

    // --- panic_message unit tests ------------------------------------------

    #[test]
    fn panic_message_extracts_str_payload() {
        assert_eq!(panic_message(&"boom"), "boom");
    }

    #[test]
    fn panic_message_extracts_string_payload() {
        assert_eq!(panic_message(&String::from("owned boom")), "owned boom");
    }

    #[test]
    fn panic_message_fallback_for_non_string_payload() {
        let payload: Box<dyn std::any::Any + Send> = Box::new(42i32);
        assert_eq!(panic_message(&*payload), "<non-string panic payload>");
    }

    #[test]
    fn classify_call_pins_builtin_and_external_arms() {
        // explore: builtin server, Read badge, sql summary.
        let explore = classify_call(&ToolUse {
            id: "1".into(),
            name: "explore".into(),
            input: json!({"sql": "SELECT 1"}),
        });
        assert!(explore.0.is_builtin());
        assert_eq!(explore.0.tool, "explore");
        assert_eq!(explore.1, OperationKind::Read);
        assert_eq!(explore.2, "SELECT 1");

        // materialize: builtin server, Write badge, sql summary.
        let materialize = classify_call(&ToolUse {
            id: "2".into(),
            name: "materialize".into(),
            input: json!({"sql": "SELECT 2"}),
        });
        assert!(materialize.0.is_builtin());
        assert_eq!(materialize.0.tool, "materialize");
        assert_eq!(materialize.1, OperationKind::Write);
        assert_eq!(materialize.2, "SELECT 2");

        // describe: builtin server, Read badge, reference_name summary.
        let describe = classify_call(&ToolUse {
            id: "3".into(),
            name: "describe".into(),
            input: json!({"reference_name": "result_1"}),
        });
        assert!(describe.0.is_builtin());
        assert_eq!(describe.0.tool, "describe");
        assert_eq!(describe.1, OperationKind::Read);
        assert_eq!(describe.2, "result_1");

        // sample: builtin server, Read badge, reference_name summary.
        let sample = classify_call(&ToolUse {
            id: "4".into(),
            name: "sample".into(),
            input: json!({"reference_name": "result_2"}),
        });
        assert!(sample.0.is_builtin());
        assert_eq!(sample.0.tool, "sample");
        assert_eq!(sample.1, OperationKind::Read);
        assert_eq!(sample.2, "result_2");

        // External arm: an unknown name keys as external, badges Network, and
        // the summary names the tool so an approval card can surface it.
        let unknown = classify_call(&ToolUse {
            id: "5".into(),
            name: "acme_fetch".into(),
            input: json!({"q": "rust", "depth": 2}),
        });
        assert!(!unknown.0.is_builtin());
        assert_eq!(unknown.0.tool, "acme_fetch");
        assert_eq!(unknown.1, OperationKind::Network);
        assert!(
            unknown.2.contains("acme_fetch"),
            "external summary names the tool: {}",
            unknown.2
        );
        // Issue #661: the external summary carries the call's arguments (the
        // approval card's parameter digest) -- a handle-only summary makes
        // the user blind-sign what the external server receives. The
        // assertion pins actual argument CONTENT (compact JSON), so a
        // summary that hardcodes `{}` and drops the arguments fails here.
        assert!(
            unknown.2.contains(r#""q":"rust""#) && unknown.2.contains(r#""depth":2"#),
            "external summary carries the argument JSON: {}",
            unknown.2
        );
    }

    /// Issue #312: a model-emitted `mcp__builtin__*` spoof must not bypass the
    /// gate. `try_external` rejects the reserved name; the fallback routes to
    /// `RESERVED_SPOOF_SERVER` so classify surfaces a card and routing fails
    /// gracefully (no panic on untrusted input).
    #[test]
    fn classify_call_routes_builtin_spoof_to_reserved_sentinel() {
        let (key, _, _) = classify_call(&ToolUse {
            id: "x".into(),
            name: "mcp__builtin__foo".into(),
            input: json!({}),
        });
        assert_eq!(key.server, ToolKey::RESERVED_SPOOF_SERVER);
        assert!(!key.is_builtin());
        let trust = std::collections::HashSet::new();
        assert_eq!(
            crate::approval::classify(&key, crate::approval::AuthMode::PerCall, &trust),
            crate::approval::Classification::NeedsApproval
        );
    }

    /// A missing summary field falls back to the per-tool placeholder so an
    /// approval card / trace row still renders (the executor will itself refuse
    /// the mis-shaped call). Pinned so the metadata table's `summary_fallback`
    /// reproduces the prior literals.
    #[test]
    fn classify_call_uses_per_tool_summary_fallback_when_field_absent() {
        let explore = classify_call(&ToolUse {
            id: "1".into(),
            name: "explore".into(),
            input: json!({}),
        });
        assert_eq!(explore.2, "<no sql>");
        let describe = classify_call(&ToolUse {
            id: "2".into(),
            name: "describe".into(),
            input: json!({}),
        });
        assert_eq!(describe.2, "<no reference_name>");
    }

    #[test]
    fn classify_call_marks_materialize_as_write() {
        // The operation badge (ADR-0083) is presentation-only; the gate does not
        // branch on it. materialize = Write, the read-shaped tools = Read.
        let explore = classify_call(&ToolUse {
            id: "1".into(),
            name: "explore".into(),
            input: json!({"sql": "SELECT 1"}),
        });
        assert_eq!(explore.1, OperationKind::Read);
        let materialize = classify_call(&ToolUse {
            id: "2".into(),
            name: "materialize".into(),
            input: json!({"sql": "SELECT 1"}),
        });
        assert_eq!(materialize.1, OperationKind::Write);
        let unknown = classify_call(&ToolUse {
            id: "3".into(),
            name: "acme_fetch".into(),
            input: json!({}),
        });
        assert_eq!(unknown.1, OperationKind::Network);
        assert!(!unknown.0.is_builtin(), "unknown tool keys as external");
    }

    /// A locally-served meta-tool (`mcp_search_tools`, ADR-0105) renders like
    /// any other call on the core's built-in arm: the started/completed phase
    /// pair + one trace row, the catalog payload flattened to the
    /// model-facing content.
    #[test]
    fn local_meta_tool_serves_with_a_trace_row() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let mut mcp = McpAggregator::catalog_server_for_test(
            "Live",
            vec![
                json!({"name": "echo", "description": "echo it", "inputSchema": {"type": "object"}}),
            ],
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "tu_1".into(),
            name: "mcp_search_tools".into(),
            input: json!({"query": "echo"}),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, promotion, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("the local meta-tool serves");
        assert!(!result.is_error, "a catalog read succeeds");
        assert!(
            result.content.contains("echo"),
            "the model-facing content carries the payload: {}",
            result.content
        );
        assert!(promotion.is_none(), "meta-tools never promote");
        let entry = entry.expect("a served meta-tool records one row");
        assert_eq!(entry.name, "mcp_search_tools");
        assert!(entry.success);
        let phases = phases.into_inner().unwrap();
        assert_eq!(phases.len(), 2, "started + completed");
        assert!(matches!(phases[0], TurnPhase::ToolCallStarted { .. }));
        assert!(matches!(phases[1], TurnPhase::ToolCallCompleted(_)));
    }

    /// A malformed meta-tool input fails traceless with the shared message
    /// (ADR-0105 Decision 4): no phase events, no trace entry -- the call
    /// never reached a tool; the error routes back for self-correction.
    #[test]
    fn malformed_meta_input_fails_traceless() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = DispatchDeps::test_deps(
            &engine.admin_engine,
            &mut ws,
            &mut sources,
            engine.temp.path(),
            &mut refs,
        );
        let mut mcp = McpAggregator::catalog_server_for_test(
            "Live",
            vec![
                json!({"name": "echo", "description": "echo it", "inputSchema": {"type": "object"}}),
            ],
        );
        let cancel = CancelToken::new();
        let approval = ApprovalState::new();
        let sink = RecordingSink::default();
        let gate = GateCtx {
            approval: &approval,
            sink: &sink,
            cancel: &cancel,
        };
        let call = ToolUse {
            id: "tu_1".into(),
            name: "mcp_search_tools".into(),
            input: json!({}),
        };
        let phases = std::sync::Mutex::new(Vec::new());
        let mut on_phase = |p: TurnPhase| phases.lock().unwrap().push(p);
        let mut invocations: Vec<crate::model::SkillInvocation> = Vec::new();
        let (result, entry, promotion, _) = dispatch_gated_call(
            &call,
            CallFace::Builtin,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::skills::invocation::test_ctx(&mut invocations),
            &mut Vec::new(),
            &crate::skills::read::SkillReadGate::inert(),
            &crate::skills::create::SkillCreateGate::inert(),
            &gate,
            &mut on_phase,
            None,
        )
        .expect("a malformed meta call is the call's own error, not an abort");
        assert!(result.is_error, "a missing query is an error result");
        assert!(
            !result.content.is_empty(),
            "the shared message routes back: {}",
            result.content
        );
        assert!(entry.is_none(), "a resolution failure records no trace row");
        assert!(promotion.is_none());
        assert!(
            phases.into_inner().unwrap().is_empty(),
            "no phase events -- the call never reached a tool"
        );
    }

    // --- external_call_outcome (I1: verbatim-relay + excerpt contract; ----
    // --- issue #1218: over-cap spill arm) ----------------------------------

    /// The external outcome over the production cap against a fresh temp
    /// dir -- the under-cap path every pre-#1218 test takes (the spill
    /// plan is inert there).
    fn relayed(name: &str, result: Result<Value, aggregator::RouteError>) -> (Value, bool, String) {
        let temp = TempDir::new().unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), name, "call-1");
        external_call_outcome(
            name,
            result,
            &spill,
            crate::cli_tools::executor::OUTPUT_CAP_BYTES,
        )
    }

    /// A successful route relays the server's envelope VERBATIM -- the content
    /// array + isError flag survive untouched, not re-wrapped into a text
    /// block (which would double-encode). The excerpt is the first text block.
    /// Pins the contract `handle_tools_call`'s external arm relies on.
    #[test]
    fn external_call_outcome_relays_envelope_verbatim_on_success() {
        let envelope = json!({
            "content": [{"type": "text", "text": "5"}],
            "isError": false,
        });
        let (out, is_error, excerpt) = relayed("mcp__fakemcp__add", Ok(envelope.clone()));
        assert_eq!(out, envelope, "envelope relayed verbatim, not re-wrapped");
        assert!(!is_error);
        assert_eq!(excerpt, "5");
    }

    /// A multi-block envelope (image + text) is relayed verbatim; the excerpt
    /// is the first TEXT block -- the leading image is skipped, not serialized
    /// into the excerpt.
    #[test]
    fn external_call_outcome_preserves_non_text_blocks_and_excerpts_first_text() {
        let envelope = json!({
            "content": [
                {"type": "image", "data": "..."},
                {"type": "text", "text": "first text"},
                {"type": "text", "text": "second text"},
            ],
            "isError": false,
        });
        let (out, is_error, excerpt) = relayed("mcp__fakemcp__tool", Ok(envelope.clone()));
        assert_eq!(out, envelope, "multi-block envelope relayed verbatim");
        assert!(!is_error);
        assert_eq!(excerpt, "first text");
    }

    /// A server-reported `isError` envelope is relayed verbatim (the gateway
    /// does not mask the server's error); `is_error` tracks the flag so the
    /// trace row records the failure.
    #[test]
    fn external_call_outcome_propagates_the_is_error_flag() {
        let envelope = json!({
            "content": [{"type": "text", "text": "tool blew up"}],
            "isError": true,
        });
        let (out, is_error, excerpt) = relayed("mcp__fakemcp__tool", Ok(envelope.clone()));
        assert_eq!(out, envelope);
        assert!(is_error);
        assert_eq!(excerpt, "tool blew up");
    }

    /// A route error (unknown slug / client fault) builds an `isError` envelope
    /// naming the tool so the agent can self-correct (ADR-0077); `is_error` is
    /// true and the excerpt carries the failure text.
    #[test]
    fn external_call_outcome_builds_an_error_envelope_on_route_failure() {
        let (out, is_error, excerpt) = relayed(
            "mcp__ghost__echo",
            Err(aggregator::RouteError::UnknownServer("ghost".into())),
        );
        assert!(is_error);
        assert_eq!(out["isError"], true);
        let text = out["content"][0]["text"]
            .as_str()
            .expect("error envelope has a text block");
        assert!(
            text.contains("mcp__ghost__echo"),
            "error names the tool: {text}"
        );
        assert!(
            text.contains("ghost"),
            "error carries the route failure: {text}"
        );
        assert_eq!(excerpt, text, "excerpt is the error text");
    }

    /// The over-cap arm (issue #1218): the concatenated text blocks spill
    /// WHOLE to `tool_output/<slug>__<tool>-<call-id>.<ext>`, and the
    /// relayed envelope carries the preview trio -- capped head, truncation
    /// marker, spill path -- in place of the text blocks; the non-text
    /// block keeps its position and `structuredContent` rides verbatim
    /// (the text plane spilled, not it).
    #[test]
    fn external_call_outcome_spills_over_cap_text_blocks_whole() {
        let temp = TempDir::new().unwrap();
        let spill =
            crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__query", "call-9");
        let envelope = json!({
            "content": [
                {"type": "text", "text": "AAAA"},
                {"type": "image", "data": "..."},
                {"type": "text", "text": "BBBBBBBB"},
            ],
            "isError": false,
            "structuredContent": {"row_count": 2},
        });
        let (out, is_error, excerpt) =
            external_call_outcome("mcp__fakesrv__query", Ok(envelope), &spill, 8);
        assert!(!is_error);
        let path = temp
            .path()
            .join("tool_output")
            .join("fakesrv__query-call-9.csv");
        let spilled =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("spill file {path:?}: {e}"));
        assert_eq!(
            spilled, "AAAABBBBBBBB",
            "text blocks concatenate in order, whole (not truncated)"
        );
        let blocks = out["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2, "text blocks collapse into the preview");
        let preview = blocks[0]["text"].as_str().unwrap();
        assert!(preview.starts_with("AAAABBBB"), "head preview: {preview}");
        assert!(
            preview.contains(
                "[tool output truncated: exceeded the 8-byte cap; \
                 full output spilled to: "
            ),
            "marker + path: {preview}"
        );
        assert!(
            preview.ends_with(&format!("{}]", path.display())),
            "marker names the spill file: {preview}"
        );
        assert_eq!(blocks[1]["type"], "image", "non-text block keeps its slot");
        assert_eq!(
            out["structuredContent"]["row_count"], 2,
            "structuredContent rides verbatim"
        );
        assert!(
            excerpt.starts_with("AAAABBBB"),
            "excerpt is the preview head"
        );
    }

    /// A JSON-shaped head routes the spill to `.json` -- the extension is
    /// the derived-source dispatcher's only routing signal, so the sniff
    /// is shared with the CLI channel's spill.
    #[test]
    fn external_call_outcome_sniffs_a_json_head_to_the_json_extension() {
        let temp = TempDir::new().unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__query", "c1");
        let body = r#"{"rows":[1,2,3,4,5,6,7,8,9,10,11,12]}"#;
        let envelope = json!({
            "content": [{"type": "text", "text": body}],
            "isError": false,
        });
        let (out, _, _) = external_call_outcome("mcp__fakesrv__query", Ok(envelope), &spill, 8);
        let path = temp
            .path()
            .join("tool_output")
            .join("fakesrv__query-c1.json");
        let spilled =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("spill file {path:?}: {e}"));
        assert_eq!(spilled, body);
        assert!(
            out["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains(&path.display().to_string()),
            "preview names the .json spill"
        );
    }

    /// A result with no text bytes spills the `structuredContent`
    /// serialization instead (else the file would be empty), and the
    /// bypassed bytes do not ALSO ride the envelope -- the field is
    /// removed once the file landed.
    #[test]
    fn external_call_outcome_spills_structured_content_when_text_is_empty() {
        let temp = TempDir::new().unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__read", "c2");
        let envelope = json!({
            "content": [{"type": "resource", "uri": "file:///x"}],
            "structuredContent": {"big": "0123456789ABCDEF"},
            "isError": false,
        });
        let (out, is_error, _) =
            external_call_outcome("mcp__fakesrv__read", Ok(envelope), &spill, 8);
        assert!(!is_error);
        let path = temp
            .path()
            .join("tool_output")
            .join("fakesrv__read-c2.json");
        let spilled =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("spill file {path:?}: {e}"));
        assert_eq!(spilled, r#"{"big":"0123456789ABCDEF"}"#);
        let blocks = out["content"].as_array().unwrap();
        assert_eq!(
            blocks.len(),
            2,
            "preview opens, resource block keeps its slot"
        );
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "resource");
        assert!(
            out.get("structuredContent").is_none(),
            "the bypassed bytes do not ride the envelope twice"
        );
    }

    /// A contentless envelope (no content array at all) whose
    /// structuredContent crosses the cap still spills AND gets a content
    /// array holding the preview -- a spilled file the model has no
    /// pointer to would be an orphan.
    #[test]
    fn external_call_outcome_creates_content_for_a_contentless_spill() {
        let temp = TempDir::new().unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__read", "c5");
        let envelope = json!({
            "structuredContent": {"big": "0123456789ABCDEF"},
            "isError": false,
        });
        let (out, is_error, _) =
            external_call_outcome("mcp__fakesrv__read", Ok(envelope), &spill, 8);
        assert!(!is_error);
        let path = temp
            .path()
            .join("tool_output")
            .join("fakesrv__read-c5.json");
        assert!(
            std::fs::read_to_string(&path).is_ok(),
            "the structuredContent fallback spills with no content array"
        );
        let blocks = out["content"]
            .as_array()
            .expect("a content array is created for the preview");
        assert_eq!(blocks.len(), 1);
        let preview = blocks[0]["text"].as_str().unwrap();
        assert!(
            preview.contains("spilled to:"),
            "the model gets the pointer: {preview}"
        );
        assert!(
            out.get("structuredContent").is_none(),
            "the bypassed bytes do not ride the envelope twice"
        );
    }

    /// `isError` is orthogonal to the cap: an error envelope's text is as
    /// much the data egress as a success's (the CLI channel's non-zero-exit
    /// twin), so it spills the same way with its flag preserved.
    #[test]
    fn external_call_outcome_spills_is_error_envelopes_orthogonally() {
        let temp = TempDir::new().unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__fail", "c3");
        let envelope = json!({
            "content": [{"type": "text", "text": "ERRORDETAIL-0123456789"}],
            "isError": true,
        });
        let (out, is_error, _) =
            external_call_outcome("mcp__fakesrv__fail", Ok(envelope), &spill, 8);
        assert!(is_error, "the error flag survives the spill");
        assert_eq!(out["isError"], true);
        let path = temp.path().join("tool_output").join("fakesrv__fail-c3.csv");
        let spilled =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("spill file {path:?}: {e}"));
        assert_eq!(spilled, "ERRORDETAIL-0123456789");
    }

    /// A failed spill (the `tool_output` path is blocked by a same-named
    /// file) withdraws the path: no file lands, and the preview carries
    /// the truncation + write-error markers instead of a half-trusted
    /// reference. `structuredContent` stays -- nothing was bypassed.
    #[test]
    fn external_call_outcome_marks_a_failed_spill_and_keeps_the_envelope() {
        let temp = TempDir::new().unwrap();
        // A same-named FILE makes create_dir_all fail -- the blocked-path
        // stand-in for an un-writable spill directory.
        std::fs::write(temp.path().join("tool_output"), b"not a dir").unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__query", "c4");
        let envelope = json!({
            "content": [{"type": "text", "text": "0123456789ABCDEF"}],
            "structuredContent": {"small": true},
            "isError": false,
        });
        let (out, is_error, _) =
            external_call_outcome("mcp__fakesrv__query", Ok(envelope), &spill, 8);
        assert!(!is_error);
        assert!(
            std::fs::read_dir(temp.path().join("tool_output")).is_err(),
            "no spill directory was created past the block"
        );
        let preview = out["content"][0]["text"].as_str().unwrap();
        assert!(
            preview.starts_with("01234567"),
            "the capped head still rides: {preview}"
        );
        assert!(
            preview.contains(
                "[tool output truncated: exceeded the 8-byte cap]\n\
                              [tool output spill write error:"
            ),
            "truncation + write-error markers, no path: {preview}"
        );
        assert!(
            !preview.contains("spilled to:"),
            "no half-trusted path reference: {preview}"
        );
        assert_eq!(
            out["structuredContent"]["small"], true,
            "nothing was bypassed -- structuredContent stays"
        );
    }

    /// Exactly `cap` bytes never cross: the envelope relays byte-identical
    /// and no spill directory is even created -- the MCP twin of the CLI
    /// channel's `exactly_cap_does_not_spill`. Pins the boundary against
    /// `<=` degrading to `<`.
    #[test]
    fn external_call_outcome_at_exactly_cap_relays_verbatim() {
        let temp = TempDir::new().unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__query", "cx");
        let envelope = json!({
            "content": [{"type": "text", "text": "01234567"}],
            "isError": false,
        });
        let (out, is_error, excerpt) =
            external_call_outcome("mcp__fakesrv__query", Ok(envelope.clone()), &spill, 8);
        assert!(!is_error);
        assert_eq!(out, envelope, "exactly cap stays verbatim");
        assert_eq!(excerpt, "01234567");
        assert!(
            !temp.path().join("tool_output").exists(),
            "the tool_output dir is not even created"
        );
    }

    /// The measured data plane is the text blocks only (ADR-0105 Decision
    /// 5's calibration): a non-empty text block keeps a byte-heavy
    /// `structuredContent` OUT of the measurement -- it rides verbatim.
    /// Pins the deliberate asymmetry against accidental widening (the
    /// same envelope with the text block removed would spill).
    #[test]
    fn external_call_outcome_does_not_measure_structured_content_when_text_exists() {
        let temp = TempDir::new().unwrap();
        let spill = crate::cli_tools::executor::SpillPlan::new(temp.path(), "fakesrv__read", "cy");
        let envelope = json!({
            "content": [{"type": "text", "text": "see data"}],
            "structuredContent": {"big": "0123456789ABCDEF0123456789ABCDEF"},
            "isError": false,
        });
        let (out, is_error, _) =
            external_call_outcome("mcp__fakesrv__read", Ok(envelope.clone()), &spill, 8);
        assert!(!is_error);
        assert_eq!(
            out, envelope,
            "text present -> structuredContent unmeasured, verbatim relay"
        );
        assert!(!temp.path().join("tool_output").exists(), "nothing spilled");
    }
}
