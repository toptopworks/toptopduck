//! The `invoke_skill` gateway meta-tool (ADR-0119 Decision 4, issue #983):
//! invocation is turn-scoped -- one call expands the skill body once, at the
//! call site, into the current turn's context (the body rides the tool
//! result back and the record persists on the turn). Approval-free (the
//! gate is the machine-level enable axis, shorter than any trust chain) and
//! snapshot-conditional (a turn with an empty discovery snapshot pays no
//! standing tool cost).

use serde_json::{json, Value};

use crate::provider::tool_calling::{ToolDefinition, ToolUse};
use crate::skills::prompt::resolve_one;
use crate::skills::read::canonical_anchor;

/// The `invoke_skill` tool name. Snapshot-conditional (ADR-0119 Decision 4):
/// only a turn whose discovery snapshot is non-empty pays the standing tool
/// cost -- with no discoverable skills there is nothing to invoke.
pub(crate) const INVOKE_SKILL: &str = "invoke_skill";

/// The tool definition as advertised on both tool surfaces (the built-in
/// table and the gateway `tools/list`), attached only when the turn's
/// discovery snapshot is non-empty. English by the two-surface language
/// split. The description teaches the model invocation semantics: the body
/// rides the call once and later turns read it from the conversation
/// history (re-invocation is zero-friction but never required).
pub(crate) fn invoke_skill_definition() -> ToolDefinition {
    ToolDefinition {
        name: INVOKE_SKILL.to_string(),
        description: "Invoke one available skill -- expand its full instructions into \
             this turn. The body rides the call result verbatim and persists on the \
             conversation history: later turns read it from the history, so \
             re-invoking a skill already in the conversation is unnecessary unless \
             you need its current version. Only enabled skills are invocable; a \
             skill enabled after this session started works by name even though it \
             carries no index row."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The skill's name (kebab-case), as listed in the \
                         available-skills index."
                }
            },
            "required": ["name"],
        }),
    }
}

/// The resolver's outcome -- the same two-variant shape as
/// [`crate::skills::activation::SkillActivationOutcome`], which is itself the
/// owning pair of [`crate::mcp::meta_tools::MetaDispatch`]'s two servable
/// arms: both dispatch faces keep their matches total with no panicking
/// arms.
#[derive(Debug)]
pub(crate) enum SkillInvocationOutcome {
    /// A served invocation: the skill name for the trace summary + the
    /// model-facing payload (the body, or the degrade note, as a PLAIN
    /// string).
    Local { summary: String, payload: Value },
    /// A refused invocation: the self-correcting message, served as the bare
    /// error result with no trace row.
    Refused(String),
}

/// The mid-turn skill-invocation channel the dispatch layer serves the
/// `invoke_skill` meta-tool through (ADR-0119 Decision 4): the turn's
/// accumulating invocation records (handed to `record_turn` at the turn's
/// end), the discovery snapshot (the self-correction name listing), and the
/// live resolution inputs (registry root + enable axis). Stateless beyond
/// the pending vec -- invocation persists on the TURN, never on the
/// session.
pub(crate) struct SkillInvocationCtx<'a> {
    /// The in-flight turn's accumulating invocation records. The resolver
    /// appends here (agent actor); the user's submit-time materialization
    /// was already resolved at the command boundary and joins the same turn
    /// record at `record_turn`.
    pub pending: &'a mut Vec<crate::model::SkillInvocation>,
    /// The discovery snapshot's names (ADR-0119 Decision 3) -- what the
    /// unknown-name failure lists. NOT the eligibility gate: a skill enabled
    /// mid-session is invocable by name without carrying an index row.
    pub snapshot: &'a [String],
    /// The skills registry root, for the live invocation-time resolution
    /// (the body + hash pin the invocation-time bytes).
    pub root: &'a std::path::Path,
    /// The machine-level disabled skill names (ADR-0118 enable axis) -- the
    /// invocation eligibility gate. A plain slice (registry-sized volume).
    pub disabled: &'a [String],
}

/// The failure message for an `invoke_skill` call whose `name` is missing,
/// non-string, or empty -- the `mcp_search_tools` malformed-input style,
/// shared by both dispatch sites through the resolver.
fn missing_name_failure() -> String {
    "invoke_skill failed: parameter `name`: expected a non-empty string".to_string()
}

/// The failure message for a name the enable axis refuses (ADR-0118): the
/// gate IS the axis, so the fix is a settings toggle, not a retry.
fn disabled_failure(name: &str) -> String {
    format!("invoke_skill: `{name}` is disabled. Enable it in settings to invoke it.")
}

/// The failure message for a name no registry entry carries -- the
/// self-correcting error (ADR-0077 posture): it lists every discovery-
/// snapshot name so the agent can retry with a real one in one hop.
fn unknown_skill_failure(name: &str, snapshot: &[String]) -> String {
    if snapshot.is_empty() {
        format!(
            "invoke_skill: `{name}` is not an available skill. The session's \
             discovery snapshot is empty."
        )
    } else {
        format!(
            "invoke_skill: `{name}` is not an available skill. Available skills: {}.",
            snapshot.join(", ")
        )
    }
}

/// The degrade note for a readable entry whose `SKILL.md` yields no body
/// (unreadable / malformed at invocation time): the invocation is recorded
/// (the name stays visible on the turn) but there is no prose to return.
/// A retry can succeed once the file is repaired -- unlike an activation
/// there is no persistent state that could mask the failure.
fn degraded_body_note(name: &str) -> String {
    format!(
        "Skill `{name}` is invoked. Its SKILL.md was unreadable or malformed, so \
         there are no instructions to return yet; the invocation is recorded and \
         re-invoking after the file is repaired serves the body."
    )
}

/// A dispatch-level-test helper: the invocation channel over a caller-owned
/// pending vec, with nothing invocable (empty snapshot / registry root /
/// enable axis). Reads route nowhere; writes land on the caller's vec.
#[cfg(test)]
pub(crate) fn test_ctx(pending: &mut Vec<crate::model::SkillInvocation>) -> SkillInvocationCtx<'_> {
    SkillInvocationCtx {
        pending,
        snapshot: &[],
        root: std::path::Path::new(""),
        disabled: &[],
    }
}

/// Classify one `invoke_skill` call against the enable axis + registry and
/// land the invocation record. The three refused cases (malformed input /
/// disabled name / registry miss) serve the bare error with no trace row
/// and land nothing; the served case appends the agent-actor record to the
/// turn's pending invocations and returns the body (or the degrade note) as
/// the payload. The turn's own context re-feeds the body through the tool
/// result -- the record is for persistence + provenance, not injection.
pub(crate) fn resolve_skill_invocation(
    call: &ToolUse,
    ctx: &mut SkillInvocationCtx<'_>,
) -> SkillInvocationOutcome {
    let Some(name) = call
        .input
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return SkillInvocationOutcome::Refused(missing_name_failure());
    };
    if ctx.disabled.iter().any(|d| d == name) {
        return SkillInvocationOutcome::Refused(disabled_failure(name));
    }
    if canonical_anchor(ctx.root, name).is_none() {
        return SkillInvocationOutcome::Refused(unknown_skill_failure(name, ctx.snapshot));
    }
    let fragment = resolve_one(ctx.root, name);
    ctx.pending.push(crate::model::SkillInvocation {
        name: name.to_string(),
        body: fragment.body.clone(),
        actor: crate::model::SkillLifecycleActor::Agent,
        content_hash: fragment.content_hash.clone(),
    });
    let payload = if fragment.body.is_empty() {
        degraded_body_note(name)
    } else {
        fragment.body.clone()
    };
    SkillInvocationOutcome::Local {
        summary: name.to_string(),
        payload: Value::String(payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SkillLifecycleActor;
    use serde_json::json;

    /// One fixture registry: one spec-valid skill with a known body + hash.
    /// Holds the TempDir so its Drop cleans the registry up when the test
    /// ends (the read.rs Fixture's RAII shape).
    struct Fixture {
        root: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("root");
            let dir = root.path().join("sql-coach");
            std::fs::create_dir_all(&dir).unwrap();
            let content = "---\nname: sql-coach\ndescription: Coach SQL.\n---\nCoach the SQL.\n";
            std::fs::write(dir.join("SKILL.md"), content).unwrap();
            Self { root }
        }

        fn ctx<'a>(
            &'a self,
            pending: &'a mut Vec<crate::model::SkillInvocation>,
            snapshot: &'a [String],
            disabled: &'a [String],
        ) -> SkillInvocationCtx<'a> {
            SkillInvocationCtx {
                pending,
                snapshot,
                root: self.root.path(),
                disabled,
            }
        }

        fn call(name: &str) -> ToolUse {
            ToolUse {
                id: "tu_i".to_string(),
                name: INVOKE_SKILL.to_string(),
                input: json!({"name": name}),
            }
        }
    }

    /// A served invocation returns the body verbatim, appends the AGENT-actor
    /// record with the invocation-time hash, and lands exactly one entry.
    #[test]
    fn served_invocation_returns_body_and_lands_agent_record() {
        let fx = Fixture::new();
        let mut pending = Vec::new();
        let snapshot = vec!["sql-coach".to_string()];
        let mut ctx = fx.ctx(&mut pending, &snapshot, &[]);
        match resolve_skill_invocation(&Fixture::call("sql-coach"), &mut ctx) {
            SkillInvocationOutcome::Local { summary, payload } => {
                assert_eq!(summary, "sql-coach");
                assert_eq!(payload, Value::String("Coach the SQL.\n".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].name, "sql-coach");
        assert_eq!(pending[0].body, "Coach the SQL.\n");
        assert_eq!(pending[0].actor, SkillLifecycleActor::Agent);
        assert!(!pending[0].content_hash.is_empty());
    }

    /// A snapshot-OUTSIDE name the registry serves still invokes (ADR-0119
    /// Decision 3): the gate is the enable axis, never the snapshot.
    #[test]
    fn snapshot_outside_registry_name_still_invokes() {
        let fx = Fixture::new();
        let mut pending = Vec::new();
        let mut ctx = fx.ctx(&mut pending, &[], &[]);
        match resolve_skill_invocation(&Fixture::call("sql-coach"), &mut ctx) {
            SkillInvocationOutcome::Local { .. } => {}
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(pending.len(), 1);
    }

    /// A disabled name is refused with the enable-axis fix, and nothing lands.
    #[test]
    fn disabled_name_is_refused_with_the_axis_fix() {
        let fx = Fixture::new();
        let mut pending = Vec::new();
        let disabled = vec!["sql-coach".to_string()];
        let snapshot = vec!["sql-coach".to_string()];
        let mut ctx = fx.ctx(&mut pending, &snapshot, &disabled);
        match resolve_skill_invocation(&Fixture::call("sql-coach"), &mut ctx) {
            SkillInvocationOutcome::Refused(message) => {
                assert!(message.contains("disabled"), "{message}");
                assert!(message.contains("settings"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        assert!(pending.is_empty());
    }

    /// An unknown name lists every snapshot name -- the one-hop
    /// self-correction signal.
    #[test]
    fn unknown_name_lists_every_snapshot_name() {
        let fx = Fixture::new();
        let mut pending = Vec::new();
        let snapshot = vec!["alpha".to_string(), "beta".to_string()];
        let mut ctx = fx.ctx(&mut pending, &snapshot, &[]);
        match resolve_skill_invocation(&Fixture::call("ghost"), &mut ctx) {
            SkillInvocationOutcome::Refused(message) => {
                assert!(message.contains("alpha"), "{message}");
                assert!(message.contains("beta"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        assert!(pending.is_empty());
    }

    /// A malformed input is refused with the fixed message.
    #[test]
    fn malformed_input_is_refused_with_the_fixed_message() {
        let fx = Fixture::new();
        let mut pending = Vec::new();
        let mut ctx = fx.ctx(&mut pending, &[], &[]);
        for input in [
            json!({}),
            json!({"name": ""}),
            json!({"name": 7}),
            Value::Null,
        ] {
            let call = ToolUse {
                id: "tu_i".to_string(),
                name: INVOKE_SKILL.to_string(),
                input,
            };
            match resolve_skill_invocation(&call, &mut ctx) {
                SkillInvocationOutcome::Refused(message) => assert_eq!(
                    message,
                    "invoke_skill failed: parameter `name`: expected a non-empty string"
                ),
                other => panic!("expected Refused, got {other:?}"),
            }
        }
        assert!(pending.is_empty());
    }
}
