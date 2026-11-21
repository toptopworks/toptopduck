//! Invalid-tool-call self-correction (issue #1625): a model turn that
//! reaches for a tool name outside the advertised table feeds back a
//! synthetic error `tool_result` instead of failing the run -- the same
//! ADR-0028 / ADR-0116 self-correction semantics an executed tool's error
//! text already rides (the model reads the failure and adjusts), closed
//! over the one gap those rulings never covered: the name check happens
//! BEFORE dispatch, so the DynamicTool callback (whose results always
//! resolve `Ok`) is structurally unreachable for a hallucinated name.
//!
//! The hook answers rig's `on_invalid_tool_call` with
//! [`InvalidToolCallAction::Skip`] unconditionally: rig synthesizes the
//! `tool_result` (the reason text below), rolls the partial turn back with
//! every same-turn peer aborted (`TOOL_NOT_EXECUTED_DUE_TO_INVALID_PEER`,
//! so the wire keeps no orphan tool call), surfaces the synthetic result
//! on the stream, and the next model turn self-corrects. A pathological
//! hallucination loop is bounded by the run's existing `step_cap` -- the
//! hook itself stays stateless (no dedicated retry counter), the same
//! budget posture every other self-correction channel here rides.
//!
//! The `Fail` arm this hook retires from the default posture stays
//! reachable in the termination mappings (`UnknownToolCall` ->
//! `Termination::Transient` and the sub-agent failure text) as the honest
//! fallback for a hook stack that chooses it. The hook body itself is the
//! one-line delegation of [`skip_reason`] onto
//! [`InvalidToolCallAction::skip`] -- pinned end to end by the
//! self-correction suite in `tests` (the `HookContext` argument is opaque
//! outside rig, so the trait method has no app-side unit seam).

use rig_agent::agent::{AgentHook, HookContext, InvalidToolCallAction, InvalidToolCallContext};

/// The unconditional Skip resolver: one per loop (stateless -- the retry
/// ceiling is the run's `step_cap`, never hook-local state). Registered on
/// both the host loop's step windows and every sub-agent's run.
pub(crate) struct InvalidToolSkipper;

/// The synthetic result's reason text: the hallucinated name plus the full
/// advertised table, so the model's next turn can correct from evidence
/// rather than guess. English (the model-facing channel; the trace renders
/// it verbatim as the failed row's text).
fn skip_reason(tool_name: &str, available_tools: &[String]) -> String {
    format!(
        "tool `{tool_name}` does not exist; available tools: [{}]",
        available_tools.join(", ")
    )
}

impl AgentHook for InvalidToolSkipper {
    fn on_invalid_tool_call(
        &self,
        _ctx: &HookContext,
        event: &InvalidToolCallContext,
    ) -> impl std::future::Future<Output = Option<InvalidToolCallAction>> + Send {
        std::future::ready(Some(InvalidToolCallAction::skip(skip_reason(
            &event.tool_name,
            &event.available_tools,
        ))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason names the hallucination and lists the whole advertised
    /// table -- the correction evidence the next turn reads.
    #[test]
    fn skip_reason_names_the_tool_and_lists_the_table() {
        assert_eq!(
            skip_reason("explode", &["explore".into(), "python".into()]),
            "tool `explode` does not exist; available tools: [explore, python]"
        );
    }

    /// An empty table (a call-only face with nothing advertised) keeps the
    /// honest empty list, not a dangling bracket.
    #[test]
    fn skip_reason_renders_an_empty_table_honestly() {
        assert_eq!(
            skip_reason("explode", &[]),
            "tool `explode` does not exist; available tools: []"
        );
    }
}
