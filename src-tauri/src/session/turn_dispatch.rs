//! The shared gated-dispatch core + execution safety net (ADR-0080 / ADR-0107).
//!
//! [`dispatch_gated_call`] routes one model-emitted tool call through the
//! approval gateway and the executor. What lives HERE, and therefore cannot
//! drift between the runtimes that dispatch tools, is the meta-tool trio
//! resolution, the skill-activation interception beside it (issue #701),
//! the gate classification ([`classify_with_cli_tool`], which
//! the gateway's `tools/call` arm also consumes), the `result_N` numbering,
//! and the dispatch panic guard (issue #321, sunk into the core so every
//! runtime gets the snapshot + ghost-rollback ritual by construction). The
//! routing arms and the trace-entry assembly are NOT single-sourced: the
//! gateway's `tools/call` arm rebuilds them beside this core on the same
//! shared helpers, with one documented divergence (the gateway relays the
//! JSON-RPC envelope verbatim; this core path flattens to the first text
//! block) -- the cannot-drift claim covers the classification / resolution
//! / numbering, not those two per-side shapes (issue #696).
//!
//! The wall-clock watchdog and the panic-detail helpers are runtime-agnostic
//! (ADR-0107's replaceability review): they hold no loop-specific state and
//! survive a runtime swap as-is.
//!
//! Migrated out of the retired built-in loop by the retirement slice
//! (ADR-0107 Decision 1, issue #670); the loop is gone, the shared core
//! stays.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::Value;

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
use crate::session::materializer::{Materializer, TurnDeps};
use crate::session::skills::SkillActivationCtx;
use crate::skills::activation;
use crate::tools;
use crate::tools::definitions;

/// Arm the wall-clock watchdog (ADR-0081): a DETACHED thread (sleeping out
/// the full timeout inside the caller's scope would hold the join) that
/// fires the app token on expiry, guarded by the turn's generation. Shared
/// by the yoagent runner and the three ACP turn paths (issue #668) so the
/// posture lives once. The generation is the watchdog's turn identity: a
/// timeout that expires after its turn ended (and a successor began) stands
/// down via [`CancelToken::request_if`] instead of cancelling the successor
/// -- there is no check-then-act window, because the generation and the
/// request flag share one atomic word (issue #696; the retired `alive` flag
/// left this race open). catch_unwind keeps the detached thread
/// self-sufficient (the issue #321 posture): a panicking cancel is logged,
/// never silently eaten.
pub(crate) fn spawn_wall_clock_watchdog(
    generation: crate::cancel::TurnGeneration,
    token: Arc<CancelToken>,
    timeout: Duration,
    log_target: &'static str,
) {
    thread::spawn(move || {
        thread::sleep(timeout);
        if catch_unwind(AssertUnwindSafe(|| token.request_if(generation))).is_err() {
            log::error!(
                target: log_target,
                "wall-clock watchdog panicked firing cancel; timeout path may be impaired"
            );
        }
    });
}

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
    fn take(deps: &TurnDeps) -> Self {
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
fn rollback_ghost_result(deps: &mut TurnDeps, snapshot: GhostSnapshot) {
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
/// "panicked in ..." detail. Both routing faces wrap their builtin executor
/// in this -- the dispatch core ([`dispatch_gated_call`]) and the gateway's
/// `tools/call` builtin arm -- so every runtime gets the ritual by
/// construction.
pub(crate) fn guarded_dispatch<R>(
    deps: &mut TurnDeps,
    site: &str,
    body: impl FnOnce(&mut TurnDeps) -> R,
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

/// Route one tool call through the approval gateway + dispatch (ADR-0080 /
/// ADR-0076): the shared dispatch core behind the yoagent integration layer's
/// gateway tool adapter (issue #668, ADR-0107). The gate classification,
/// meta-tool resolution, and `result_N` numbering cannot drift between the
/// runtimes -- the adapter calls THIS, never a re-assembly -- while the
/// routing arms and the trace-entry assembly stay per-side (the gateway's
/// `tools/call` arm rebuilds them on the same shared helpers; see the module
/// doc for the documented envelope asymmetry, issue #696). Returns the
/// model-facing result, the call's trace entry (`None` for a meta-tool
/// resolution failure that never reached a tool, ADR-0105 Decision 4), and
/// any promotion. Emits the ADR-0078 phase pair through `on_phase`.
///
/// The issue #321 dispatch panic guard lives HERE: the `result_N` snapshot +
/// ghost rollback runs for every dispatch by construction, and a panic
/// surfaces as [`DispatchAbort::Panic`] instead of unwinding into either
/// runtime.
#[allow(clippy::too_many_arguments)]
pub(crate) fn dispatch_gated_call(
    call: &ToolUse,
    deps: &mut TurnDeps,
    materializer: &mut dyn Materializer,
    mcp: &mut McpAggregator,
    cli: &[crate::cli_tools::config::CliToolConfig],
    skills: &mut SkillActivationCtx<'_>,
    gate: &GateCtx<'_>,
    on_phase: &mut impl FnMut(TurnPhase),
) -> Result<(ToolResult, Option<TraceEntry>, Option<Promotion>), DispatchAbort> {
    // Issue #321: guard the dispatch against a panic. The materialize path
    // registers result_N partway through try_materialize; a panic in any
    // subsequent step (record_provenance, gc_stale_results,
    // apply_display_label, descriptor_json, ToolOutcome construction) can
    // leave a ghost result_N. The shared `guarded_dispatch` ritual detects +
    // reverts any orphan so the working_set <-> history invariant holds
    // (ADR-0084).
    let site = format!("tool dispatch `{}`", call.name);
    match guarded_dispatch(deps, &site, |deps| {
        dispatch_gated_call_inner(call, deps, materializer, mcp, cli, skills, gate, on_phase)
    }) {
        Err(detail) => Err(DispatchAbort::Panic(Termination::Transient(detail))),
        Ok(result) => result.map_err(|GateCancelled| DispatchAbort::Gate),
    }
}

/// The dispatch body under the panic guard (see [`dispatch_gated_call`]).
#[allow(clippy::too_many_arguments)]
fn dispatch_gated_call_inner(
    call: &ToolUse,
    deps: &mut TurnDeps,
    materializer: &mut dyn Materializer,
    mcp: &mut McpAggregator,
    cli: &[crate::cli_tools::config::CliToolConfig],
    skills: &mut SkillActivationCtx<'_>,
    gate: &GateCtx<'_>,
    on_phase: &mut impl FnMut(TurnPhase),
) -> Result<(ToolResult, Option<TraceEntry>, Option<Promotion>), GateCancelled> {
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
            return Ok((result, Some(entry), None));
        }
        meta_tools::MetaDispatch::Refused(message) => {
            return Ok((meta_failure(call, &message), None, None))
        }
        meta_tools::MetaDispatch::Resolved(replacement) => {
            resolved = replacement;
            &resolved
        }
        meta_tools::MetaDispatch::Fallthrough(call) => call,
    };
    // The skill-activation meta-tool (ADR-0110 Decision 3, issue #701):
    // intercepted BESIDE the trio match, ahead of any classification / gate
    // -- activation is approval-free by design (mounting is the only trust
    // gate). The resolver lands the `Activate` transition + persists
    // immediately; this site maps its two variants exactly as it maps the
    // trio's (a Local call gets the started / completed phase pair + trace
    // row, a Refused call is the bare error result with no trace entry).
    if call.name == activation::ACTIVATE_SKILL {
        return Ok(
            match activation::resolve_skill_activation(
                call,
                skills,
                deps.working_set,
                deps.temp_path,
            ) {
                meta_tools::MetaDispatch::Local { summary, payload } => {
                    let (result, entry) = local_meta_call(call, &summary, payload, on_phase);
                    (result, Some(entry), None)
                }
                meta_tools::MetaDispatch::Refused(message) => {
                    (meta_failure(call, &message), None, None)
                }
                // The skill resolver only yields Local / Refused; the borrowed
                // variants exist for the trio's fall-through, not this surface.
                meta_tools::MetaDispatch::Resolved(_)
                | meta_tools::MetaDispatch::Fallthrough(_) => {
                    unreachable!("the skill resolver only yields Local / Refused")
                }
            },
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
        name: call.name.clone(),
        operation_kind,
        summary: summary.clone(),
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
    let outcome = if aggregator::is_namespaced(&call.name) {
        let tool_output_dir = deps.temp_path.join(super::TOOL_OUTPUT_DIR_NAME);
        route_external_call(call, mcp, &tool_output_dir)
    } else if let Some(tool) = cli_tool {
        // The registered-CLI dispatch arm (issue #671, ADR-0108 Decision 3):
        // direct argv spawn, cwd = the session's work temp dir, cancel = the
        // turn's shared token (process-tree termination on round cancel).
        crate::cli_tools::executor::execute(tool, call, deps.temp_path, gate.cancel)
    } else {
        tools::dispatch(call, deps, gate.cancel, materializer)
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
    Ok((result, Some(entry), promotion))
}

/// Serve one locally-executed meta-tool (`mcp_list_servers` /
/// `mcp_search_tools`) on the built-in path (ADR-0105). The catalog payload
/// flattens to the model-facing content string (`ToolResult.content` is a
/// flat String on this path), with the standard started / completed phase
/// pair + trace entry so a meta-tool call renders like any other call. These
/// never touch a backend server, so there is no gate suspension (catalog
/// reads carry the built-in read tools' trust shape). Returns the result
/// paired with its trace entry -- the push into the runtime's outputs
/// belongs to the caller (the yoagent dispatcher).
fn local_meta_call(
    call: &ToolUse,
    summary: &str,
    payload: serde_json::Value,
    on_phase: &mut impl FnMut(TurnPhase),
) -> (ToolResult, TraceEntry) {
    on_phase(TurnPhase::ToolCallStarted {
        name: call.name.clone(),
        operation_kind: OperationKind::Read,
        summary: summary.to_string(),
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

/// Route a namespaced external MCP call through the aggregator and shape the
/// outcome the runtime consumes (issue #301 slice C-loop; unlike the gateway's
/// `external_call_outcome`, this path flattens the envelope -- see
/// `aggregator::first_text_block` for the asymmetry). The aggregator strips
/// the `mcp__<slug>__` prefix and forwards the native tool name + arguments
/// to the matching server; the server's envelope is relayed as the
/// model-facing `content` string (the first text block --
/// `ToolResult.content` is a flat string on this path, so a multi-block or
/// non-text result reduces to its first text block, with a placeholder when
/// there is none). A route failure (UnknownServer / Client fault) becomes a
/// tool error the agent self-corrects from (ADR-0077). No promotion:
/// external tools never materialize a working-set result.
fn route_external_call(
    call: &ToolUse,
    mcp: &mut McpAggregator,
    tool_output_dir: &Path,
) -> tools::ToolOutcome {
    shape_external_outcome(mcp.route(&call.name, &call.input), call, tool_output_dir)
}

/// Reduce a routed external MCP call's `Result` to the runtime's `ToolOutcome`
/// (issue #301 slice C-loop). Split from [`route_external_call`] so the
/// envelope-shaping contract is unit-testable without a live server: a
/// successful envelope flattens to its first text block + the server's
/// `isError` flag (defaulting to `false` per the MCP spec -- a conformant
/// server omits it on success); a server-side error envelope keeps the text
/// (the model self-corrects, ADR-0077) but marks `is_error = true`; a route
/// failure becomes a tool error naming the tool. No promotion in any branch
/// (external tools never materialize a working-set result).
fn shape_external_outcome(
    route_result: Result<Value, RouteError>,
    call: &ToolUse,
    tool_output_dir: &Path,
) -> tools::ToolOutcome {
    let (content, is_error) = match route_result {
        Ok(envelope) => {
            let is_error = envelope
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let text = aggregator::first_text_block(&envelope);
            // Issue #442: on a success envelope, structured inline text is
            // materialized to tool_output/ (ADR-0087 D3/D4). An error's text
            // is a message, not data.
            let content = if is_error {
                text
            } else {
                crate::session::inline_materialize::augment_with_hint(
                    text,
                    &call.id,
                    tool_output_dir,
                )
            };
            (content, is_error)
        }
        Err(e) => (format!("external tool `{}` failed: {}", call.name, e), true),
    };
    tools::ToolOutcome {
        result: ToolResult {
            tool_use_id: call.id.clone(),
            content,
            is_error,
        },
        promotion: None,
    }
}

/// Classify a tool call for the approval gateway + the trace: the [`ToolKey`]
/// (built-in vs external server), the [`OperationKind`] badge (ADR-0083), and a
/// short agent-readable summary of the arguments. Built-in tools classify from
/// the single metadata table ([`definitions::builtin_metadata`], issue #336) --
/// no tool-name literal `match` here, so adding a built-in tool is one entry in
/// `builtin_tools`, not a parallel edit to this function. An unknown name falls
/// through to the external arm (the gateway surfaces the approval card for it).
/// Hard cap on the external-call argument preview inside the approval
/// summary (issue #661; cap added by the #663 review): sized so the preview
/// plus its ``external tool `name` with `` frame stays inside the card-body
/// budget ([`crate::approval::SUMMARY_MAX_CHARS`]) -- deliberately larger
/// than the 120-char trace cap so a realistic payload previews its head on
/// the card instead of degrading to a bare JSON fragment the approver cannot
/// read.
const ARGS_PREVIEW_MAX_CHARS: usize = 448;

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
        let attachments = rendered
            .files
            .into_iter()
            .map(|f| crate::approval::FileAttachment {
                param: f.param,
                content: f.content,
            })
            .collect();
        (
            crate::approval::truncate_summary(&argv.join(" "), ARGS_PREVIEW_MAX_CHARS),
            attachments,
        )
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
            // review); the emit-side `truncate_summary` cap backstops the IPC
            // broadcast.
            let summary = format!(
                "external tool `{other}` with {}",
                crate::approval::truncate_summary(&call.input.to_string(), ARGS_PREVIEW_MAX_CHARS)
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
    use std::sync::Mutex;
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

    /// A recording approval sink (mirrors the one in approval.rs's tests). The
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
    /// polling (approval.rs's equivalent switched to condvar, but this local
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
        let outcome = route_external_call(&call, &mut mcp, dir.path());
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
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
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
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
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
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
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
        let written = std::fs::read_to_string(dir.path().join("tu_csv.csv")).unwrap();
        assert_eq!(written, csv);
    }

    /// A successful envelope whose inline text is valid JSON gets materialized
    /// with a `.json` extension (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_json_inline_text() {
        let dir = TempDir::new().unwrap();
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
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(!outcome.result.is_error);
        assert!(
            outcome.result.content.contains("tu_json.json"),
            "hint names the JSON file: {}",
            outcome.result.content
        );
        let written = std::fs::read_to_string(dir.path().join("tu_json.json")).unwrap();
        assert_eq!(written, json);
    }

    /// A successful envelope whose inline text is TSV gets materialized with
    /// a `.tsv` extension (issue #442).
    #[test]
    fn shape_external_outcome_materializes_structured_tsv_inline_text() {
        let dir = TempDir::new().unwrap();
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
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(!outcome.result.is_error);
        assert!(
            outcome.result.content.contains("tu_tsv.tsv"),
            "hint names the TSV file: {}",
            outcome.result.content
        );
        let written = std::fs::read_to_string(dir.path().join("tu_tsv.tsv")).unwrap();
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
        let outcome = shape_external_outcome(Ok(envelope), &call, dir.path());
        assert!(outcome.result.is_error);
        // No hint appended — content is the raw text only.
        assert_eq!(outcome.result.content, csv);
        // No file was written.
        assert!(dir.path().read_dir().unwrap().next().is_none());
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
        let mut d = TurnDeps::test_deps(
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
        let (result, entry, _) = dispatch_gated_call(
            &failing,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut on_phase,
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
                name: "explore".into(),
                operation_kind: OperationKind::Read,
                summary: "SELECT * FROM missing".into(),
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
        let (_, entry, promotion) = dispatch_gated_call(
            &landing,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut on_phase,
        )
        .expect("the materialize dispatches");
        let entry = entry.expect("a dispatched call records an entry");
        assert!(entry.success);
        assert!(promotion.is_some(), "a materialize lands a promotion");
        let phases = phases.into_inner().unwrap();
        assert_eq!(
            phases[0],
            TurnPhase::ToolCallStarted {
                name: "materialize".into(),
                operation_kind: OperationKind::Write,
                summary: "SELECT 1 AS x".into(),
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

    /// An externally-classified call the gate denies completes WITHOUT
    /// started (the card flips to its resolved-deny row) and never
    /// dispatches (ADR-0078).
    #[test]
    fn gate_denied_call_emits_only_completion_no_started() {
        let engine = Engine::new();
        let mut ws = WorkingSet::default();
        let mut sources = HashMap::new();
        let mut refs = HashMap::new();
        let mut d = TurnDeps::test_deps(
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
        let (result, entry, promotion) = dispatch_gated_call(
            &call,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut forward,
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
        let mut d = TurnDeps::test_deps(
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
        let (result, entry, promotion) = dispatch_gated_call(
            &call,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            std::slice::from_ref(&registration),
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut on_phase,
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
        let mut d = TurnDeps::test_deps(
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
        let (result, entry, _) = dispatch_gated_call(
            &call,
            &mut d,
            &mut RealMaterializer,
            &mut McpAggregator::empty(),
            std::slice::from_ref(&registration),
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut on_phase,
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
        let mut d = TurnDeps::test_deps(
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
        let (_, entry, _) = dispatch_gated_call(
            &call,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut forward,
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
        let mut d = TurnDeps::test_deps(
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
        let (result, entry, promotion) = dispatch_gated_call(
            &call,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut on_phase,
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
            deps: &mut TurnDeps,
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
        let mut d = TurnDeps::test_deps(
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
        let abort = dispatch_gated_call(
            &call,
            &mut d,
            &mut materializer,
            &mut McpAggregator::empty(),
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut |_| {},
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
        let mut d = TurnDeps::test_deps(
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
        let (result, entry, promotion) = dispatch_gated_call(
            &call,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut on_phase,
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
        let mut d = TurnDeps::test_deps(
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
        let (result, entry, promotion) = dispatch_gated_call(
            &call,
            &mut d,
            &mut RealMaterializer,
            &mut mcp,
            &[],
            &mut crate::session::skills::SkillActivationFixture::new(Vec::new()).ctx(),
            &gate,
            &mut on_phase,
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
}
