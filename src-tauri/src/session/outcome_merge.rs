//! The gateway/ACP outcome merge species (ADR-0085 trace merge, issue #299
//! slice 9c): where the gateway's authoritative dispatch records
//! (`GatewayOutcome`) -- the MCP server the external runtime's bridge
//! connects back to -- and the external ACP engine's loop stream
//! (`LoopOutcome`) fold into one turn record. `turn_outcome_from_loop`
//! projects the loop outcome onto the turn-record outcome (the no-progress
//! kill-log line rides along); `merge_outcomes` pairs gateway rows with
//! engine echoes (by name or through the `mcp_invoke` pool) so one call is
//! one audited row. Deterministic functions only -- no row reads,
//! persistence, or turn driving.

use std::collections::{HashMap, VecDeque};

use crate::model::{CancelledReason, TextKind, TurnFailure, TurnOutcome};
use crate::session::loop_contract::{
    LoopOutcome, LoopRound, NoProgressDetail, Termination, TraceEntry,
};
use crate::SessionId;

// Re-exported with `merge_outcomes`: the pub merge point takes it, so its
// parameter type rides the same public path (the gateway module itself is
// crate-private).
pub use crate::runtime::gateway::server::GatewayOutcome;

/// The NoProgress kill-log line (#886): the session + runtime face
/// attribution and the three trip-side measurements in one shape. A pure
/// function so the attribution is unit-pinnable without a log-capture
/// harness (the same counting-split-from-logging seam the `DiscardLog`
/// family uses); the projection is its only caller.
fn no_progress_kill_summary(
    session_id: Option<&SessionId>,
    runtime_face: &str,
    detail: &NoProgressDetail,
) -> String {
    let session = session_id
        .map(|id| format!("session {id}, "))
        .unwrap_or_default();
    format!(
        "no-progress timeout: {session}runtime `{runtime_face}` silent for {:.1}s (cap {:.1}s, turn ran {:.1}s); aborting the turn",
        detail.silence.as_secs_f64(),
        detail.cap.as_secs_f64(),
        detail.turn_elapsed.as_secs_f64()
    )
}

/// Map the agent loop's structured outcome onto the four-way [`TurnOutcome`]
/// (ADR-0028, calibrated by ADR-0077/0081; issue #318). The termination routes:
///
/// - Converged (terminal text) with >=1 promotion -> [`TurnOutcome::Materialized`].
///   The LAST promotion is the turn's primary result (a later materialize
///   supersedes earlier ones as the analysis focus); its verbatim SQL rides
///   `sql`, the terminal text rides `body` and renders through the same
///   markdown pipeline as a Textual body (#847 -- it previously rode
///   `assumption`, a side-note slot). ADR-0022 monotonic numbering already
///   applied inside the loop (result_1, result_2, ...).
/// - Converged with no promotion -> [`TurnOutcome::Textual`] with
///   [`TextKind::Agent`]: the tool-calling contract carries no structural
///   clarify/refuse marker, so an honest answer, a clarification, and a
///   default-skillset boundary refusal (ADR-0079) all ride the agent kind --
///   the body text itself carries which.
/// - Step cap exhausted (the agent never converged) -> [`TurnOutcome::Failed`]
///   (`Execute`, carrying the cap). Provider faults map by class: NotWired /
///   InvalidConfig permanent, a surfaced transient fault an `Execute` failure
///   (the adapter's HTTP retry already ran; blind retry is abolished), and an
///   external-runtime wiring / transport fault a `Runtime` failure (issue
///   #852 -- the ACP domain never lands the built-in transient kind).
/// - Cancel (user / close) -> [`TurnOutcome::Cancelled`] with no reason; the
///   no-progress watchdog lands [`Termination::NoProgress`] -> `Cancelled`
///   too, carrying the `NoProgress` reason for the presentation split and
///   the technical detail on the warn log (ADR-0115, #883).
///
/// Tool-level errors (SQL failure, approval denial) never land here -- the
/// loop fed them back to the model for self-correction (ADR-0077); only a
/// trajectory that never converges exhausts the step cap.
///
/// `session_id` + `runtime_face` attribute the NoProgress kill log (#886):
/// the projection is the one point all four turn paths share, so the warn
/// names its victim here. `None` = a store-less Session (tests,
/// non-command paths); the warn omits the session then.
pub(super) fn turn_outcome_from_loop(
    outcome: LoopOutcome,
    session_id: Option<&SessionId>,
    runtime_face: &str,
) -> TurnOutcome {
    match outcome.termination {
        Termination::Text(text) => {
            if outcome.promotions.is_empty() {
                TurnOutcome::Textual {
                    text_kind: TextKind::Agent,
                    body: text,
                    assumption: None,
                }
            } else {
                TurnOutcome::Materialized {
                    // ADR-0084: the outcome carries the FULL promotion chain in
                    // promotion order; the chain tail is the primary result
                    // (derived at the read sites, never folded here). Working
                    // set, history, recipe, and resume all see every promotion.
                    promotions: outcome.promotions,
                    // The tool-calling contract carries no viz intent (the
                    // presentation slice is separate); a plain table turn.
                    viz: None,
                    // #847: the terminal text is the turn's prose answer, not a
                    // side note -- it rides `body` (markdown-rendered). No live
                    // agent source emits an assumption note, so `assumption`
                    // stays None.
                    body: if text.trim().is_empty() {
                        None
                    } else {
                        Some(text)
                    },
                    assumption: None,
                }
            }
        }
        Termination::StepCap(cap) => TurnOutcome::Failed(TurnFailure::Execute {
            detail: format!("agent did not converge within {cap} steps"),
        }),
        Termination::Cancelled => TurnOutcome::Cancelled(None),
        Termination::NoProgress(detail) => {
            // The technical "no-progress timeout" fact rides the log AND the
            // cancel reason payload (#883) -- the landing stays a Cancelled
            // (ADR-0115), but one the frontend can present as a timeout. The
            // warn carries the attribution + trip-side measurements (#886):
            // the cap alone is a production constant and attributes nothing.
            log::warn!(
                target: "toptopduck::session",
                "{}",
                no_progress_kill_summary(session_id, runtime_face, &detail)
            );
            TurnOutcome::Cancelled(Some(CancelledReason::NoProgress))
        }
        Termination::NotWired => TurnOutcome::Failed(TurnFailure::NotWired),
        Termination::InvalidConfig(detail) => {
            TurnOutcome::Failed(TurnFailure::InvalidConfig { detail })
        }
        Termination::Transient(detail) => TurnOutcome::Failed(TurnFailure::Execute { detail }),
        Termination::Runtime(detail) => TurnOutcome::Failed(TurnFailure::Runtime { detail }),
    }
}

/// Merge the gateway's per-connection outcome with the ACP engine's loop
/// outcome into one [`LoopOutcome`] (issue #299 slice 9c, ADR-0085 +
/// ADR-0078).
///
/// A gateway-served tool appears in BOTH sources -- the gateway's
/// `tools/call` dispatch record (authoritative, ADR-0076 audit) and the
/// engine's own tool-call notification (the ACP `session/update`, codex
/// `mcp_tool_call`, claude `tool_use` echo -- one merge point, one pairing
/// semantics for all three paths, issue #820). The gateway record wins by
/// REPLACING the echo IN ITS ROUND (issue #817): the paired engine row
/// keeps only its position, every field comes from the gateway row (it ran
/// the call, so its success flag + excerpt are the truth), and the settled
/// read order inside each round stays thinking -> prose -> calls. The
/// pairing is one of two arms:
/// - by name: meta catalog / skill / CLI-registration / built-in calls are
///   recorded under the tool's own name, so a same-named echo pairs
///   directly, one per row under that name (issue #673's registration
///   case is now this arm -- registrations no longer get a special-cased
///   vocabulary; built-ins pair through it too, issue #817 retired the
///   unconditional arm);
/// - by the `mcp_invoke` pool: an external dispatch is recorded under the
///   RESOLVED namespaced handle (the fall-through renames before
///   recording, ADR-0105), so the `mcp_invoke` echo pairs against the
///   turn's namespaced-row total instead. Both arms consume their rows
///   FIFO in gateway trace order.
///
/// An engine row the gateway cannot account for stays silently -- the
/// runtime's own work (bash / edit / etc. never touch the gateway), or
/// wire drift for a built-in the gateway under-recorded; a same-named row
/// past the gateway's count stays too, with a warn -- a name collision is
/// a suspicion, not proof, and the audit surface never silently
/// under-reports. A gateway row no echo consumed (wire drift, a CLI that
/// never reports its calls) trails the engine rounds as one flat residual
/// round -- never swallowed. Promotions are gateway-only (the ACP engine
/// leaves them empty by design, slice 9a); termination is ACP-only
/// (the gateway serves tools, it does not produce a turn termination).
///
/// TODO(issue #299 E2E): a real ACP CLI drive (e.g. gemini-cli) may re-name MCP
/// tool calls (e.g. prefixing `mcp__<server>__`) in its `session/update`
/// notifications, in which case the by-name pairing would miss and the echo
/// survives as a double row. The slice 9c integration test drives a fake
/// CLI that emits the gateway's names; real-CLI naming is verified in the
/// manual E2E checklist, and a normalization layer lands as a follow-up if
/// the E2E shows a rename.
pub fn merge_outcomes(gateway: GatewayOutcome, mut acp: LoopOutcome) -> LoopOutcome {
    acp.promotions = gateway.promotions;
    // ADR-0103 (issues #608 + #611, calibrated by #817): the gateway's
    // authoritative rows replace the engine's echo rows IN PLACE -- a paired
    // engine row keeps only its position inside its round, every field comes
    // from the gateway row (whole-row replacement), so the settled read
    // order inside each round is thinking -> prose -> calls. There is no
    // leading all-gateway round. A gateway row with no engine counterpart
    // (wire drift, a CLI that never reports its calls) is never swallowed:
    // the unconsumed rows trail the engine rounds as one flat fallback
    // round -- the audit surface never under-reports.
    // Pairing (issue #820's unified vocabulary): every gateway row queues
    // under its own name, consumed FIFO in trace order -- built-in names
    // pair through the same per-name quota as every gateway-served name, no
    // unconditional arm. An `mcp_invoke` echo cannot pair by name (the
    // gateway's fall-through records the row under the RESOLVED namespaced
    // handle, ADR-0105), so it instead consumes the turn's namespaced-row
    // pool in the same FIFO order. Every namespaced row counts regardless
    // of result: a denied call is still a real dispatch the gateway
    // recorded (ADR-0085). An echo whose arm has nothing left keeps the
    // engine row with a warn; a name the gateway has NO row under stays
    // silently -- the runtime's own work for a native tool name, wire
    // drift for a built-in the gateway under-recorded.
    let mut by_name: HashMap<String, VecDeque<usize>> = HashMap::new();
    let mut invoke_pool: VecDeque<usize> = VecDeque::new();
    for (index, entry) in gateway.trace.iter().enumerate() {
        if crate::mcp::aggregator::is_namespaced(&entry.name) {
            invoke_pool.push_back(index);
        }
        by_name
            .entry(entry.name.clone())
            .or_default()
            .push_back(index);
    }
    let mut slots: Vec<Option<TraceEntry>> = gateway.trace.into_iter().map(Some).collect();
    let mut rounds = Vec::new();
    for mut round in std::mem::take(&mut acp.trace) {
        // A row the gateway can account for is the gateway's to report: an
        // `mcp_invoke` echo takes one pool row, a same-named row takes the
        // name's next queued row. A name the gateway has NO row under stays
        // silently -- the runtime's own work for a native tool name, wire
        // drift for a built-in the gateway under-recorded; either way the
        // row is real, so it stays, and past the queued rows it stays with
        // a warn (the audit surface never silently under-reports).
        round.calls = round
            .calls
            .into_iter()
            .map(|entry| {
                if entry.name == crate::mcp::meta_tools::META_INVOKE {
                    return match take_next_queued(&mut slots, &mut invoke_pool) {
                        Some(gateway_row) => gateway_row,
                        None => {
                            log::warn!(
                                target: "toptopduck::session",
                                "engine `mcp_invoke` row past the gateway's namespaced-row \
                                 count this turn; keeping the row (likely an external-runtime \
                                 tool of the same name)"
                            );
                            entry
                        }
                    };
                }
                match by_name.get_mut(entry.name.as_str()) {
                    Some(queue) => match take_next_queued(&mut slots, queue) {
                        Some(gateway_row) => gateway_row,
                        None => {
                            log::warn!(
                                target: "toptopduck::session",
                                "engine tool-call row `{}` past the gateway's recorded count \
                                 for the name; keeping the row (likely an external-runtime \
                                 tool of the same name)",
                                entry.name
                            );
                            entry
                        }
                    },
                    None => entry,
                }
            })
            .collect();
        let emptied = round.calls.is_empty() && round.thinking.is_none() && round.text.is_none();
        if !emptied {
            rounds.push(round);
        }
    }
    rounds.extend(LoopRound::flat_wrap(slots.into_iter().flatten().collect()));
    acp.trace = rounds;
    acp
}

/// Take the next live gateway row a pairing queue can supply, skipping
/// indexes the sibling arm already consumed: every namespaced row seats in
/// BOTH the by-name map and the invoke pool, and the slots are the
/// single-consumption arbiter between the arms. A popped index whose slot
/// is empty means the other arm took that row, not that the gateway
/// under-recorded, so the queue advances past it instead of warning.
fn take_next_queued(
    slots: &mut [Option<TraceEntry>],
    queue: &mut VecDeque<usize>,
) -> Option<TraceEntry> {
    while let Some(index) = queue.pop_front() {
        if let Some(gateway_row) = slots[index].take() {
            return Some(gateway_row);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    // merge_outcomes (issue #299 slice 9c) + the agent-loop / gateway types it
    // composes -- tested in isolation here so a regression in the dedup
    // contract surfaces without driving the full Session -> AcpEngine -> bridge
    // chain.
    use super::{merge_outcomes, no_progress_kill_summary, turn_outcome_from_loop, GatewayOutcome};
    use crate::approval::OperationKind;
    use crate::model::{
        CancelledReason, DatasetDescriptor, ThinkingTrace, TurnFailure, TurnOutcome,
    };
    use crate::session::loop_contract::{
        LoopOutcome, LoopRound, NoProgressDetail, Termination, TraceEntry,
    };
    use crate::session::BUILT_IN_RUNTIME_FACE;

    // --- merge_outcomes (issue #299 slice 9c, ADR-0085 trace merge) -------

    /// A minimal result dataset descriptor (the #847 turn-outcome mapping
    /// tests need one promotion to route the terminal text onto `body`).
    fn test_dataset(reference_name: &str) -> DatasetDescriptor {
        DatasetDescriptor {
            reference_name: reference_name.into(),
            display_name: reference_name.into(),
            source_path: "/tmp/source.csv".into(),
            columns: Vec::new(),
            row_count: 0,
            sample: Vec::new(),
            fingerprint: "fp".into(),
            rectify: crate::model::RectifyProvenance::NotApplicable,
            privacy: Default::default(),
            stale: None,
        }
    }

    /// Build a trace entry with default fields (the merge tests vary
    /// `name` + `success` -- the pairing keys; the in-place tests override
    /// the display fields after construction to pin the whole-row
    /// replacement, issue #817).
    fn trace_entry(id: &str, name: &str, success: bool) -> TraceEntry {
        TraceEntry {
            tool_use_id: id.into(),
            name: name.into(),
            operation_kind: OperationKind::Read,
            summary: format!("{name} summary"),
            success,
            output_truncated: false,
            result_excerpt: format!("{name} excerpt"),
            sub_trace: None,
        }
    }

    /// A gateway outcome carrying `trace` + no promotions.
    fn gateway_outcome(trace: Vec<TraceEntry>) -> GatewayOutcome {
        GatewayOutcome {
            trace,
            promotions: Vec::new(),
        }
    }

    /// An ACP loop outcome carrying `trace` + a textual termination.
    fn acp_outcome(trace: Vec<TraceEntry>) -> LoopOutcome {
        LoopOutcome {
            termination: Termination::Text("acp reply".into()),
            promotions: Vec::new(),
            trace: LoopRound::flat_wrap(trace),
            discovered_runtime: None,
        }
    }

    /// A gateway-routed builtin (`explore`) appears in BOTH sources when the
    /// CLI forwards its own tool-call notification; the gateway record wins
    /// (it ran the SQL, so its `success` flag + excerpt are authoritative),
    /// and the ACP duplicate is replaced in place (issue #817).
    #[test]
    fn merge_outcomes_gateway_builtin_wins_over_acp_duplicate() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "explore", true)]);
        let acp = acp_outcome(vec![trace_entry("a1", "explore", false)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            1,
            "the ACP duplicate is replaced in place"
        );
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "g1");
        assert!(
            merged.trace[0].calls[0].success,
            "the gateway success flag wins"
        );
    }

    /// #847: a converged turn with promotions maps its terminal text onto
    /// `body` (the prose answer, markdown-rendered downstream) -- never onto
    /// `assumption`, which stays reserved for a one-line side note no live
    /// agent source emits.
    #[test]
    fn turn_outcome_maps_terminal_text_to_body_not_assumption() {
        let outcome = LoopOutcome {
            termination: Termination::Text("## 报告\n\n正文 `code`".into()),
            promotions: vec![crate::model::Promotion {
                dataset: test_dataset("result_1"),
                sql: "SELECT 1".into(),
            }],
            trace: Vec::new(),
            discovered_runtime: None,
        };
        match turn_outcome_from_loop(outcome, None, BUILT_IN_RUNTIME_FACE) {
            TurnOutcome::Materialized {
                body, assumption, ..
            } => {
                assert_eq!(body.as_deref(), Some("## 报告\n\n正文 `code`"));
                assert_eq!(assumption, None, "the side-note slot stays empty");
            }
            other => panic!("expected Materialized, got {other:?}"),
        }
    }

    /// Issue #852: the projection maps the ACP domain's `Termination::Runtime`
    /// onto `TurnFailure::Runtime` -- the arm a silent revert to `Execute`
    /// would leave every external-runtime failure wearing the neutral
    /// execution wording with the suite green (the engine tests assert the
    /// pre-projection `Termination`; this pins the projection itself).
    #[test]
    fn turn_outcome_maps_runtime_termination_to_runtime_failure() {
        let outcome = LoopOutcome {
            termination: Termination::Runtime("external runtime `cli-a` not found on PATH".into()),
            promotions: Vec::new(),
            trace: Vec::new(),
            discovered_runtime: None,
        };
        match turn_outcome_from_loop(outcome, None, BUILT_IN_RUNTIME_FACE) {
            TurnOutcome::Failed(TurnFailure::Runtime { detail }) => {
                assert_eq!(detail, "external runtime `cli-a` not found on PATH");
            }
            other => panic!("expected Failed(Runtime), got {other:?}"),
        }
    }

    /// Issue #883: the projection arms the NoProgress landing with the cancel
    /// reason -- a silent revert to a bare cancelled would leave every
    /// watchdog kill presenting as the user's own stop with the suite green
    /// (the #882 watchdog tests assert the pre-projection `Termination`;
    /// this pins the projection itself, like the #852 peer above).
    #[test]
    fn turn_outcome_maps_no_progress_termination_to_cancelled_with_reason() {
        let outcome = LoopOutcome {
            termination: Termination::NoProgress(NoProgressDetail {
                cap: std::time::Duration::from_secs(120),
                silence: std::time::Duration::from_secs(120),
                turn_elapsed: std::time::Duration::from_secs(180),
            }),
            promotions: Vec::new(),
            trace: Vec::new(),
            discovered_runtime: None,
        };
        match turn_outcome_from_loop(outcome, None, BUILT_IN_RUNTIME_FACE) {
            TurnOutcome::Cancelled(reason) => {
                assert_eq!(reason, Some(CancelledReason::NoProgress));
            }
            other => panic!("expected Cancelled(Some(NoProgress)), got {other:?}"),
        }
    }

    /// The kill-log line attributes the session and the runtime face
    /// (#886): the summary is a pure function so the attribution is
    /// pinnable without a log-capture harness -- stripping either leg
    /// from the warn is exactly what the projection tests above (which
    /// pass None) cannot catch.
    #[test]
    fn no_progress_kill_summary_names_session_and_runtime_face() {
        let detail = NoProgressDetail {
            cap: std::time::Duration::from_secs(120),
            silence: std::time::Duration::from_millis(120_400),
            turn_elapsed: std::time::Duration::from_secs(180),
        };
        let id = crate::SessionId::parse("0f0e0d0c-0b0a-4900-8000-000000000001")
            .expect("fixed v4 uuid parses");
        assert_eq!(
            no_progress_kill_summary(Some(&id), BUILT_IN_RUNTIME_FACE, &detail),
            format!(
                "no-progress timeout: session {id}, runtime `built-in` silent for 120.4s \
                 (cap 120.0s, turn ran 180.0s); aborting the turn"
            ),
            "the built-in kill names the session and the built-in face"
        );
        assert_eq!(
            no_progress_kill_summary(None, "cli-a", &detail),
            "no-progress timeout: runtime `cli-a` silent for 120.4s \
             (cap 120.0s, turn ran 180.0s); aborting the turn",
            "a store-less session omits the attribution with no leftover artifacts"
        );
    }

    /// A whitespace-only terminal text carries no prose at all -- neither
    /// slot gets a value (the same empty-text judgment the routing has
    /// always applied).
    #[test]
    fn turn_outcome_blank_terminal_text_yields_no_body() {
        let outcome = LoopOutcome {
            termination: Termination::Text("   \n".into()),
            promotions: vec![crate::model::Promotion {
                dataset: test_dataset("result_1"),
                sql: "SELECT 1".into(),
            }],
            trace: Vec::new(),
            discovered_runtime: None,
        };
        match turn_outcome_from_loop(outcome, None, BUILT_IN_RUNTIME_FACE) {
            TurnOutcome::Materialized {
                body, assumption, ..
            } => {
                assert_eq!(body, None);
                assert_eq!(assumption, None);
            }
            other => panic!("expected Materialized, got {other:?}"),
        }
    }

    /// Issue #673: a registered CLI tool name is gateway-served too, so the
    /// same one-call-one-row rule holds -- the gateway's dispatch record
    /// wins and the engine notification for the identical call is replaced
    /// in place.
    /// Registrations pair through the unified per-name quota (issue #820):
    /// no special-cased vocabulary, the same arm every gateway-served name
    /// takes.
    #[test]
    fn merge_outcomes_gateway_cli_registration_wins_over_acp_duplicate() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "doc-convert", false)]);
        let acp = acp_outcome(vec![trace_entry("a1", "doc-convert", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            1,
            "the engine duplicate is replaced in place"
        );
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "g1");
        assert!(
            !merged.trace[0].calls[0].success,
            "the gateway success flag wins"
        );
    }

    /// Issue #673 review: a registration-named row the gateway did NOT
    /// serve -- the external runtime calling its own same-named tool
    /// (registration validation cannot see the runtime's namespace, so the
    /// collision is legal config) -- keeps its engine row: a name with no
    /// gateway counterpart is the runtime's own work, and the audit surface
    /// never drops real work on a name match.
    #[test]
    fn merge_outcomes_keeps_acp_row_when_no_gateway_counterpart_exists() {
        let gateway = gateway_outcome(Vec::new());
        let acp = acp_outcome(vec![trace_entry("a1", "bash", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 1, "the runtime's own row survives");
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "a1");
    }

    /// The per-name pairing is count-aware: two gateway rows under one name
    /// replace exactly two same-named engine rows at their slots (one per
    /// gateway row), and a third the gateway cannot account for survives
    /// with the collision warn -- the rule consumes quota, it does not erase
    /// a name.
    #[test]
    fn merge_outcomes_dedup_consumes_one_quota_per_gateway_row() {
        let gateway = gateway_outcome(vec![
            trace_entry("g1", "doc-convert", true),
            trace_entry("g2", "doc-convert", false),
        ]);
        let acp = acp_outcome(vec![
            trace_entry("a1", "doc-convert", true),
            trace_entry("a2", "doc-convert", true),
            trace_entry("a3", "doc-convert", true),
        ]);
        let merged = merge_outcomes(gateway, acp);
        // One engine round, no residual: the two paired echoes carry the
        // gateway's rows at their slots, the third (past the gateway's
        // count) survives as the runtime's own.
        assert_eq!(merged.trace.len(), 1, "one engine round, no residual");
        assert_eq!(merged.trace[0].calls.len(), 3);
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "g1");
        assert_eq!(merged.trace[0].calls[1].tool_use_id, "g2");
        assert_eq!(
            merged.trace[0].calls[2].tool_use_id, "a3",
            "the row past the gateway's count is the runtime's own"
        );
    }

    /// The non-builtin engine rows are the pairing's both-ways guardrail
    /// (issue #820 rewrite of the original append-only pin): a same-named
    /// row is replaced by the gateway's authoritative record at its slot,
    /// while a name the gateway has nothing for (bash / edit / etc., which
    /// never touch the gateway) is the runtime's own work and stays.
    #[test]
    fn merge_outcomes_per_name_echo_replaces_while_unknown_name_stays() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "mcp_search_tools", true)]);
        let acp = acp_outcome(vec![
            trace_entry("a1", "mcp_search_tools", false),
            trace_entry("a2", "bash", true),
        ]);
        let merged = merge_outcomes(gateway, acp);
        // One engine round, no residual: the paired echo carries the
        // gateway's row at its slot, the runtime's own call keeps its own.
        assert_eq!(merged.trace.len(), 1);
        assert_eq!(merged.trace[0].calls.len(), 2);
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "g1");
        assert_eq!(merged.trace[0].calls[1].tool_use_id, "a2");
        assert_eq!(merged.trace[0].calls[1].name, "bash");
    }

    /// A mixed turn: the gateway routed an `explore` (builtin) AND the CLI
    /// ran its own `bash` (non-builtin). The CLI's rounds come first; the
    /// gateway row the engine never echoed trails as the flat residual
    /// round -- never swallowed, never promoted above the engine's rounds.
    #[test]
    fn merge_outcomes_gateway_builtin_plus_acp_non_builtin() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "explore", true)]);
        let acp = acp_outcome(vec![trace_entry("a1", "bash", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            2,
            "CLI round + the trailing residual round"
        );
        assert_eq!(merged.trace[0].calls[0].name, "bash");
        assert_eq!(merged.trace[1].calls[0].name, "explore");
    }

    /// The external-dispatch dedup (issue #820): an `mcp_invoke` engine echo
    /// cannot pair by name -- the gateway's fall-through records the row
    /// under the RESOLVED namespaced handle (ADR-0105; no `mcp_invoke`
    /// gateway row ever exists), so the echo instead consumes the pool's
    /// next row FIFO. One dispatch, one surviving row: the gateway's
    /// authoritative record, seated at the echo's slot.
    #[test]
    fn merge_outcomes_mcp_invoke_echo_consumes_the_namespaced_pool() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "mcp__slug__tool", true)]);
        let acp = acp_outcome(vec![trace_entry("a1", "mcp_invoke", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            1,
            "the echo is replaced; the gateway row is the one record"
        );
        assert_eq!(merged.trace[0].calls[0].name, "mcp__slug__tool");
    }

    /// The pool pairs by COUNT, not handle: two dispatches to different
    /// backends (two namespaced rows, one denied -- a denied call is still
    /// a real dispatch the gateway recorded) cover two `mcp_invoke` echoes,
    /// and a third echo past the pool survives -- never silently dropped.
    #[test]
    fn merge_outcomes_invoke_pool_counts_rows_not_handles() {
        let gateway = gateway_outcome(vec![
            trace_entry("g1", "mcp__one__tool", true),
            trace_entry("g2", "mcp__other__tool", false),
        ]);
        let acp = acp_outcome(vec![
            trace_entry("a1", "mcp_invoke", true),
            trace_entry("a2", "mcp_invoke", true),
            trace_entry("a3", "mcp_invoke", true),
        ]);
        let merged = merge_outcomes(gateway, acp);
        // One engine round, no residual: the two paired echoes carry the
        // gateway's rows at their slots, the third (past the pool) survives
        // as the runtime's own.
        assert_eq!(merged.trace.len(), 1, "one engine round, no residual");
        assert_eq!(merged.trace[0].calls.len(), 3);
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "g1");
        assert_eq!(merged.trace[0].calls[1].tool_use_id, "g2");
        assert_eq!(
            merged.trace[0].calls[2].tool_use_id, "a3",
            "the echo past the pool is the runtime's own work"
        );
    }

    /// The pool counts rows, not names: two dispatches to the SAME handle
    /// (two same-named namespaced rows -- the common repeat-call shape)
    /// cover two `mcp_invoke` echoes; a distinct-handle pool would leave
    /// the second echo alive as a ghost double row.
    #[test]
    fn merge_outcomes_invoke_pool_counts_repeat_rows_under_one_handle() {
        let gateway = gateway_outcome(vec![
            trace_entry("g1", "mcp__one__tool", true),
            trace_entry("g2", "mcp__one__tool", true),
        ]);
        let acp = acp_outcome(vec![
            trace_entry("a1", "mcp_invoke", true),
            trace_entry("a2", "mcp_invoke", true),
        ]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            1,
            "both echoes are replaced; the two gateway rows are the records"
        );
        assert_eq!(merged.trace[0].calls.len(), 2);
    }

    /// The pool is fed by namespaced rows ONLY: a turn whose gateway trace
    /// holds none (meta-only here) has an empty pool, so an `mcp_invoke`
    /// echo with nothing to consume survives -- never silently swallowed.
    #[test]
    fn merge_outcomes_invoke_pool_empty_without_namespaced_rows() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "mcp_search_tools", true)]);
        let acp = acp_outcome(vec![trace_entry("a1", "mcp_invoke", true)]);
        let merged = merge_outcomes(gateway, acp);
        // The engine round comes first (its echo stays, keep + warn); the
        // gateway's unpaired meta row trails as the residual.
        assert_eq!(merged.trace.len(), 2);
        assert_eq!(
            merged.trace[0].calls[0].tool_use_id, "a1",
            "the echo with no pool to consume stays (keep + warn)"
        );
        assert_eq!(merged.trace[1].calls[0].name, "mcp_search_tools");
    }

    /// The pool and the per-name arm never cross-consume (issue #820): a
    /// namespaced-NAMED engine echo is the direct-send form -- the gateway
    /// has no row under that name, so it stays (per-name miss); it neither
    /// eats nor feeds the `mcp_invoke` pool, whose one count still covers
    /// the `mcp_invoke` echo.
    #[test]
    fn merge_outcomes_namespaced_echo_neither_eats_nor_feeds_the_pool() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "mcp__one__tool", true)]);
        let acp = acp_outcome(vec![
            trace_entry("a1", "mcp__other__tool", true),
            trace_entry("a2", "mcp_invoke", true),
        ]);
        let merged = merge_outcomes(gateway, acp);
        // One engine round, no residual: the per-name miss keeps its engine
        // row, and the `mcp_invoke` echo carries the gateway's row at its
        // slot (a cross-consuming pool would leave the echo alive too).
        assert_eq!(merged.trace.len(), 1);
        assert_eq!(merged.trace[0].calls.len(), 2);
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "a1");
        assert_eq!(merged.trace[0].calls[1].tool_use_id, "g1");
    }

    /// The meta catalog pair + skill tool calls pair BY NAME (issue #820
    /// per-class pin): the gateway records those dispatches under the
    /// tool's own name (unlike the external fall-through, which renames
    /// -- the fourth meta tool, `mcp_invoke`, takes the pool arm instead,
    /// so it is deliberately absent from this fixture), so each
    /// same-named engine echo is replaced by its gateway row at its slot.
    #[test]
    fn merge_outcomes_meta_and_skill_echos_pair_by_name() {
        let names = [
            "mcp_search_tools",
            "mcp_list_servers",
            "invoke_skill",
            "read_skill_file",
        ];
        let gateway = gateway_outcome(
            names
                .iter()
                .enumerate()
                .map(|(i, n)| trace_entry(&format!("g{i}"), n, true))
                .collect(),
        );
        let acp = acp_outcome(
            names
                .iter()
                .enumerate()
                .map(|(i, n)| trace_entry(&format!("a{i}"), n, true))
                .collect(),
        );
        let merged = merge_outcomes(gateway, acp);
        // One round survives: the engine round carrying the gateway's
        // four authoritative rows at the echo slots.
        assert_eq!(merged.trace.len(), 1);
        assert_eq!(merged.trace[0].calls.len(), 4);
        assert!(merged.trace[0]
            .calls
            .iter()
            .all(|c| c.tool_use_id.starts_with('g')));
    }

    /// The CLI's per-round grouping survives the merge (issue #611): each
    /// ACP round keeps its thinking + prose + calls, a paired row is
    /// replaced INSIDE its round (no leading all-gateway round), and a round
    /// whose only call paired keeps the round alive -- the replacement
    /// occupies the slot, so a round never vanishes because of the merge.
    #[test]
    fn merge_outcomes_preserves_acp_round_prose_and_thinking() {
        let gateway = gateway_outcome(vec![trace_entry("g1", "explore", true)]);
        let acp = LoopOutcome {
            termination: Termination::Text("acp reply".into()),
            promotions: Vec::new(),
            discovered_runtime: None,
            trace: vec![
                LoopRound {
                    thinking: Some(ThinkingTrace {
                        duration_ms: 120,
                        text: "weighing".into(),
                    }),
                    text: Some("checking first".into()),
                    calls: vec![trace_entry("a1", "bash", true)],
                },
                // This round's only call pairs with the gateway's builtin
                // row -- the replacement occupies the slot, so the round
                // survives instead of vanishing.
                LoopRound {
                    thinking: None,
                    text: None,
                    calls: vec![trace_entry("a2", "explore", true)],
                },
            ],
        };
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 2, "both ACP rounds survive");
        let r1 = &merged.trace[0];
        assert_eq!(
            r1.thinking.as_ref().expect("round thinking survives").text,
            "weighing"
        );
        assert_eq!(r1.text.as_deref(), Some("checking first"));
        assert_eq!(r1.calls[0].tool_use_id, "a1");
        let r2 = &merged.trace[1];
        assert!(r2.thinking.is_none() && r2.text.is_none());
        assert_eq!(
            r2.calls[0].tool_use_id, "g1",
            "the paired row carries the gateway's record at the echo's slot"
        );
    }

    /// Termination is ACP-only (the gateway serves tools, it does not
    /// produce a turn termination). The merge preserves the ACP value
    /// verbatim.
    #[test]
    fn merge_outcomes_termination_from_acp() {
        let gateway = gateway_outcome(Vec::new());
        let acp = LoopOutcome {
            discovered_runtime: None,
            termination: Termination::Text("done".into()),
            promotions: Vec::new(),
            trace: Vec::new(),
        };
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.termination, Termination::Text("done".into()));
    }

    /// Promotions are gateway-only (the ACP engine leaves them empty by
    /// design, slice 9a). The merge takes the gateway's promotions verbatim;
    /// a non-empty fixture would require a `DatasetDescriptor`, and the
    /// single-source rule is a one-line Rust assignment (`acp.promotions =
    /// gateway.promotions`) whose semantics the type system guarantees.
    #[test]
    fn merge_outcomes_promotions_single_source_gateway() {
        let gateway = gateway_outcome(Vec::new());
        let acp = acp_outcome(Vec::new());
        let merged = merge_outcomes(gateway, acp);
        assert!(merged.promotions.is_empty());
    }

    /// Issue #817 in-place replacement: a paired engine row keeps only its
    /// POSITION -- every field comes from the gateway's authoritative row
    /// (whole-row replacement, no per-field picking), so the settled read
    /// order inside the round is thinking -> prose -> calls with the
    /// gateway's values substituted at the echo's slot. No leading
    /// all-gateway round exists.
    #[test]
    fn merge_outcomes_replaces_paired_engine_rows_in_place() {
        let mut gateway_row = trace_entry("g1", "explore", false);
        gateway_row.operation_kind = OperationKind::Execute;
        gateway_row.summary = "gateway summary".into();
        gateway_row.result_excerpt = "gateway excerpt".into();
        let gateway = gateway_outcome(vec![gateway_row]);
        let acp = LoopOutcome {
            termination: Termination::Text("acp reply".into()),
            promotions: Vec::new(),
            discovered_runtime: None,
            trace: vec![LoopRound {
                thinking: Some(ThinkingTrace {
                    duration_ms: 90,
                    text: "weighing".into(),
                }),
                text: Some("checking first".into()),
                calls: vec![
                    trace_entry("a1", "explore", true),
                    trace_entry("a2", "bash", true),
                ],
            }],
        };
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            1,
            "no leading round; the engine round is the trace"
        );
        let round = &merged.trace[0];
        assert_eq!(
            round.thinking.as_ref().expect("thinking stays").text,
            "weighing"
        );
        assert_eq!(round.text.as_deref(), Some("checking first"));
        assert_eq!(round.calls.len(), 2, "positions survive, rows are replaced");
        let replaced = &round.calls[0];
        assert_eq!(replaced.tool_use_id, "g1");
        assert_eq!(replaced.name, "explore");
        assert_eq!(replaced.operation_kind, OperationKind::Execute);
        assert_eq!(replaced.summary, "gateway summary");
        assert!(!replaced.success, "the gateway success flag wins");
        assert_eq!(replaced.result_excerpt, "gateway excerpt");
        assert_eq!(
            round.calls[1].tool_use_id, "a2",
            "the unpaired row keeps its slot"
        );
    }

    /// Issue #817 residual tail: gateway rows with no engine counterpart
    /// (wire drift, a CLI that never reports its calls) are never swallowed
    /// -- they trail the engine rounds as one flat fallback round, so the
    /// audit surface never under-reports. The engine rounds come FIRST.
    #[test]
    fn merge_outcomes_residual_gateway_rows_trail_as_flat_round() {
        let gateway = gateway_outcome(vec![
            trace_entry("g1", "explore", true),
            trace_entry("g2", "mcp__slug__tool", false),
        ]);
        let acp = acp_outcome(vec![trace_entry("a1", "bash", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            2,
            "engine round first, residual round trails"
        );
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "a1");
        let residual = &merged.trace[1];
        assert!(
            residual.thinking.is_none() && residual.text.is_none(),
            "the residual round is flat"
        );
        assert_eq!(residual.calls.len(), 2);
        assert_eq!(
            residual.calls[0].tool_use_id, "g1",
            "gateway row order preserved"
        );
        assert_eq!(residual.calls[1].tool_use_id, "g2");
    }

    /// Issue #817 FIFO pairing: same-named gateway rows pair with same-named
    /// echoes in arrival order (gateway rows by trace order, echoes by
    /// in-round order), and the residual is whichever gateway row FIFO left
    /// unconsumed -- the LAST one in trace order.
    #[test]
    fn merge_outcomes_fifo_pairs_same_name_by_arrival() {
        let mut g1 = trace_entry("g1", "doc-convert", true);
        g1.result_excerpt = "first dispatch".into();
        let mut g2 = trace_entry("g2", "doc-convert", true);
        g2.result_excerpt = "second dispatch".into();
        let mut g3 = trace_entry("g3", "doc-convert", true);
        g3.result_excerpt = "third dispatch".into();
        let gateway = gateway_outcome(vec![g1, g2, g3]);
        let acp = acp_outcome(vec![
            trace_entry("a1", "doc-convert", true),
            trace_entry("a2", "doc-convert", true),
        ]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 2, "engine round + the FIFO residual");
        let round = &merged.trace[0];
        assert_eq!(
            round.calls[0].tool_use_id, "g1",
            "first echo pairs the first gateway row"
        );
        assert_eq!(
            round.calls[1].tool_use_id, "g2",
            "second echo pairs the second"
        );
        assert_eq!(
            merged.trace[1].calls[0].tool_use_id, "g3",
            "the residual is the LAST unconsumed gateway row"
        );
    }

    /// Issue #817 builtin quota (retires #820's tail C): a built-in echo
    /// pairs through the SAME per-name quota as every gateway-served name --
    /// no unconditional arm. When the gateway under-records the dispatch
    /// (wire drift: the engine saw a call the gateway never wrote a row
    /// for), the engine row stays instead of being silently dropped: the
    /// audit surface never under-reports.
    #[test]
    fn merge_outcomes_builtin_quota_keeps_engine_row_when_gateway_under_recorded() {
        let gateway = gateway_outcome(Vec::new());
        let acp = acp_outcome(vec![trace_entry("a1", "explore", true)]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(
            merged.trace.len(),
            1,
            "the engine row survives the under-recorded builtin"
        );
        assert_eq!(merged.trace[0].calls[0].tool_use_id, "a1");
        assert_eq!(merged.trace[0].calls[0].name, "explore");
    }

    /// The contention pin (issue #817 review, Important 4): a namespaced
    /// gateway row seats in BOTH the by-name map and the invoke pool, and
    /// the slots are the single-consumption arbiter. A turn that echoes
    /// the handle directly AND dispatches via `mcp_invoke` must still
    /// consume each row exactly once -- the pool skips the index the
    /// by-name arm already took, so neither dispatch double-renders and
    /// no residual trails.
    #[test]
    fn merge_outcomes_same_handle_mixed_arms_pair_once() {
        let gateway = gateway_outcome(vec![
            trace_entry("g1", "mcp__duckdb__query_snapshot", true),
            trace_entry("g2", "mcp__duckdb__query_snapshot", false),
        ]);
        let acp = acp_outcome(vec![
            trace_entry("a1", "mcp__duckdb__query_snapshot", true),
            trace_entry("a2", "mcp_invoke", true),
        ]);
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 1, "one engine round, no residual");
        assert_eq!(merged.trace[0].calls.len(), 2, "one row per dispatch");
        assert_eq!(
            merged.trace[0].calls[0].tool_use_id, "g1",
            "the direct echo pairs the first row"
        );
        assert_eq!(
            merged.trace[0].calls[1].tool_use_id, "g2",
            "the invoke echo skips the stale index and pairs the second"
        );
    }

    /// The emptied-round guard: a round the pump itself left hollow (no
    /// thinking, no prose, no calls) drops at the merge -- empty stays
    /// empty, and the in-place replacement never empties or resurrects a
    /// round (the rewrite orphaned this branch's pin; restored here).
    #[test]
    fn merge_outcomes_drops_hollow_engine_rounds() {
        let gateway = gateway_outcome(Vec::new());
        let acp = LoopOutcome {
            termination: Termination::Text("acp reply".into()),
            promotions: Vec::new(),
            discovered_runtime: None,
            trace: vec![LoopRound {
                thinking: None,
                text: None,
                calls: Vec::new(),
            }],
        };
        let merged = merge_outcomes(gateway, acp);
        assert_eq!(merged.trace.len(), 0, "a hollow round drops");
    }
}
