//! The `activate_skill` gateway meta-tool (ADR-0110 Decision 3, issue #701):
//! the agent's discovery-to-instruction channel over MOUNTED skills.
//!
//! Mounting is the only trust gate (ADR-0110 Decision 1); activation is
//! approval-free and zero-friction on both channels -- the user's
//! mounted-list affordance (#699, via the IPC command) and the agent's
//! meta-tool here. Both ride the SAME session transition
//! ([`Session::activate_skill`] / [`SkillActivationCtx::land`] -> the shared
//! `land_skill_activation` body); the actor recorded on the `Activate` event
//! is the only difference.
//!
//! Like the MCP discovery trio ([`crate::mcp::meta_tools`]), this is a
//! gateway-local meta call served BEFORE the approval gate: both dispatch
//! faces (the yoagent dispatch server and the bridge gateway) intercept the
//! name beside `resolve_meta_call`'s match and map the returned
//! [`MetaDispatch`] variant onto their own envelope. Unlike the trio, the
//! classification is NOT pure -- a successful resolution lands a mutable
//! state transition + an immediate atomic persist (real-time by contract:
//! the event reaches the timeline before the tool result returns, and a
//! turn that later fails or is cancelled keeps the activation).
//!
//! The tool's result is the skill's body -- the SAME turn-start
//! [`SkillPromptFragment`] the system prompt assembled from, so the channel
//! and the per-turn injection are one source (ADR-0110 Decision 2's L2).
//! No directory structure rides the result (the third layer is deferred,
//! Decision 6).

use std::path::Path;

use serde_json::{json, Value};

use crate::mcp::meta_tools::MetaDispatch;
use crate::provider::tool_calling::{ToolDefinition, ToolUse};
use crate::session::skills::SkillActivationCtx;
use crate::skills::SkillPromptFragment;
use crate::workingset::WorkingSet;

/// The `activate_skill` tool name. Mount-conditional like the trio's
/// attachment (ADR-0105 Decision 6): a turn with an empty mounted set pays
/// no standing tool cost, so the surface (and therefore this channel) only
/// exists when at least one skill is mounted.
pub(crate) const ACTIVATE_SKILL: &str = "activate_skill";

/// The tool definition as advertised on both tool surfaces (the built-in
/// table and the gateway `tools/list`), attached ONLY when the turn's
/// mounted set is non-empty. The wording is the locked four-part contract:
/// the two triggers (task-description match / user naming), the body as the
/// result, the persistence until unmount, and the idempotent + self-correct
/// postures. English by the two-surface language split (the prompt face is
/// Chinese, the tool face English -- an established fact, not a choice made
/// here).
pub(crate) fn activate_skill_definition() -> ToolDefinition {
    ToolDefinition {
        name: ACTIVATE_SKILL.to_string(),
        description: "Activate a mounted skill and receive its full instructions as the result. \
             Call this when the task matches a mounted skill's description (see the \
             available-skills index in the system prompt) or when the user names a \
             skill. The body persists in every subsequent turn until the skill is \
             unmounted. A repeat activation is idempotent and returns the body again; \
             an unknown name lists every mounted skill name in the error."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The mounted skill's name (kebab-case), as listed in the \
                         available-skills index."
                }
            },
            "required": ["name"],
        }),
    }
}

/// The failure message for an `activate_skill` call whose `name` is missing,
/// non-string, or empty -- the `mcp_search_tools` malformed-input style,
/// shared by both dispatch sites through the resolver.
fn missing_name_failure() -> String {
    "activate_skill failed: parameter `name`: expected a non-empty string".to_string()
}

/// The failure message for a name no mounted skill carries -- the
/// self-correcting error (ADR-0077): it lists EVERY mounted skill name so
/// the agent can retry with a real one in one hop (the `mcp_invoke`
/// handle-failure posture, ADR-0105).
fn unknown_skill_failure(name: &str, fragments: &[SkillPromptFragment]) -> String {
    let mounted: Vec<&str> = fragments.iter().map(|f| f.name.as_str()).collect();
    if mounted.is_empty() {
        format!("activate_skill: `{name}` is not mounted. No skills are mounted this turn.")
    } else {
        format!(
            "activate_skill: `{name}` is not mounted. Mounted skills this turn: {}.",
            mounted.join(", ")
        )
    }
}

/// The result text when the skill activated but its turn-start fragment
/// carries no body (the `SKILL.md` was unreadable / malformed-fenced /
/// spec-name-invalid at assembly -- the honest-degrade ladder). The
/// activation still lands and the tool still succeeds: dressing an I/O
/// failure up as a refused activation would invite a retry death loop
/// (re-activating cannot fix a file), so the note says what happened and
/// what persists instead.
fn degraded_body_note(name: &str) -> String {
    format!(
        "Skill `{name}` is activated. Its SKILL.md was unreadable or malformed at this \
         turn's assembly, so there are no instructions to return yet; the activation \
         persists and later turns inject whatever the file yields once repaired."
    )
}

/// Classify one `activate_skill` call against the skill surface and perform
/// the transition. The five cases (issue #701's locked contract):
/// - a mounted name, fresh: land the `Activate` event (actor `Agent`) +
///   return the body;
/// - a mounted name, already activated: land NOTHING (idempotent) + still
///   return the body;
/// - a name no fragment carries: `Refused`, listing every mounted name;
/// - a malformed input: `Refused`, the fixed message;
/// - a mounted name whose body is empty: land the activation + return the
///   degrade note (never `Refused`).
///
/// The two site-visible variants are `Local { summary: <skill name>,
/// payload: <the body verbatim, as a plain JSON string> }` and `Refused`;
/// the sites' existing Local/Refused mappings serve them exactly as they
/// serve the trio's (including the trace row: `name` = `activate_skill`,
/// summary = the skill name). The working set + temp path are the two
/// pieces the immediate persist borrows that live inside `TurnDeps` on both
/// dispatch faces.
pub(crate) fn resolve_skill_activation<'a>(
    call: &'a ToolUse,
    ctx: &mut SkillActivationCtx<'_>,
    working_set: &mut WorkingSet,
    temp_path: &Path,
) -> MetaDispatch<'a> {
    let Some(name) = call
        .input
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return MetaDispatch::Refused(missing_name_failure());
    };
    let Some(fragment) = ctx.fragments.iter().find(|f| f.name == name) else {
        return MetaDispatch::Refused(unknown_skill_failure(name, ctx.fragments));
    };
    // Fresh or idempotent, the result is the body either way -- the landed
    // bool distinguishes them only for the event/persist pairing inside.
    ctx.land(name, working_set, temp_path);
    let payload = if fragment.body.is_empty() {
        degraded_body_note(name)
    } else {
        fragment.body.clone()
    };
    MetaDispatch::Local {
        summary: name.to_string(),
        payload: Value::String(payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SkillLifecycleActor, SkillLifecycleEvent, SkillLifecycleKind};
    use crate::session::skills::SkillActivationFixture;
    use crate::session::TimelineEntry;
    use crate::workingset::WorkingSet;

    fn fragment(name: &str, body: &str) -> SkillPromptFragment {
        SkillPromptFragment {
            name: name.to_string(),
            description: format!("{name} description"),
            body: body.to_string(),
            content_hash: format!("{name}-hash"),
            mcp_servers: Vec::new(),
            cli_tools: Vec::new(),
        }
    }

    /// The resolver's two site-visible variants, detached from
    /// `MetaDispatch`'s borrowed `Fallthrough` lifetime for asserting.
    #[derive(Debug)]
    enum Outcome {
        Local { summary: String, payload: Value },
        Refused(String),
    }

    /// One resolver call: the fixture owns the channel state; the working
    /// set + temp path the persist borrows are inert (an unbound persister
    /// persists nothing -- `save_if_bound`'s unbound no-op, pinned by its
    /// own unit test).
    fn resolve(fx: &mut SkillActivationFixture, input: Value) -> Outcome {
        let call = ToolUse {
            id: "tu_s".to_string(),
            name: ACTIVATE_SKILL.to_string(),
            input,
        };
        let mut ws = WorkingSet::default();
        match resolve_skill_activation(&call, &mut fx.ctx(), &mut ws, std::path::Path::new("")) {
            MetaDispatch::Local { summary, payload } => Outcome::Local { summary, payload },
            MetaDispatch::Refused(message) => Outcome::Refused(message),
            MetaDispatch::Resolved(_) | MetaDispatch::Fallthrough(_) => {
                panic!("the skill resolver only yields Local / Refused")
            }
        }
    }

    fn skill_events(fx: &SkillActivationFixture) -> Vec<&SkillLifecycleEvent> {
        fx.timeline
            .iter()
            .filter_map(|e| match e {
                TimelineEntry::Skill(ev) => Some(ev),
                _ => None,
            })
            .collect()
    }

    /// A fresh activation lands one `Activate` event (actor `Agent`) and
    /// returns the fragment's body verbatim as the payload, summarized by
    /// the skill name.
    #[test]
    fn fresh_activation_lands_agent_event_and_returns_body() {
        let mut fx = SkillActivationFixture::new(vec![
            fragment("sql-coach", "Coach the SQL."),
            fragment("pdf-tools", "Handle PDFs."),
        ]);
        match resolve(&mut fx, json!({"name": "sql-coach"})) {
            Outcome::Local { summary, payload } => {
                assert_eq!(summary, "sql-coach");
                assert_eq!(payload, Value::String("Coach the SQL.".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(fx.activated, vec!["sql-coach".to_string()]);
        let events = skill_events(&fx);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, SkillLifecycleKind::Activate);
        assert_eq!(events[0].name, "sql-coach");
        assert_eq!(events[0].actor, Some(SkillLifecycleActor::Agent));
    }

    /// A repeat activation lands no second event and still returns the body
    /// (the idempotent posture, locked asymmetric with the mount family).
    #[test]
    fn repeat_activation_lands_nothing_and_returns_body_again() {
        let mut fx = SkillActivationFixture::new(vec![fragment("sql-coach", "Coach the SQL.")]);
        resolve(&mut fx, json!({"name": "sql-coach"}));
        match resolve(&mut fx, json!({"name": "sql-coach"})) {
            Outcome::Local { summary, payload } => {
                assert_eq!(summary, "sql-coach");
                assert_eq!(payload, Value::String("Coach the SQL.".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(skill_events(&fx).len(), 1);
    }

    /// An unknown name is refused with EVERY mounted name in the error --
    /// the one-hop self-correction signal.
    #[test]
    fn unknown_name_lists_every_mounted_name() {
        let mut fx = SkillActivationFixture::new(vec![
            fragment("sql-coach", "Coach the SQL."),
            fragment("pdf-tools", "Handle PDFs."),
        ]);
        match resolve(&mut fx, json!({"name": "ghost"})) {
            Outcome::Refused(message) => {
                assert!(message.contains("sql-coach"), "{message}");
                assert!(message.contains("pdf-tools"), "{message}");
                assert!(message.contains("ghost"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        assert!(skill_events(&fx).is_empty());
        assert!(fx.activated.is_empty());
    }

    /// A malformed input (missing / non-string / empty name) is refused with
    /// the fixed message, and nothing lands.
    #[test]
    fn malformed_input_is_refused_with_fixed_message() {
        let mut fx = SkillActivationFixture::new(vec![fragment("sql-coach", "Coach the SQL.")]);
        for input in [
            json!({}),
            json!({"name": 7}),
            json!({"name": ""}),
            Value::Null,
        ] {
            match resolve(&mut fx, input) {
                Outcome::Refused(message) => assert_eq!(
                    message,
                    "activate_skill failed: parameter `name`: expected a non-empty string"
                ),
                other => panic!("expected Refused, got {other:?}"),
            }
        }
        assert!(skill_events(&fx).is_empty());
    }

    /// A mounted skill whose turn-start body is empty STILL activates (the
    /// transition and the file are two layers), and the result is the
    /// non-empty degrade note -- never `Refused` (a refused activation
    /// would invite a retry death loop that cannot fix a file).
    #[test]
    fn unreadable_body_still_lands_and_returns_degrade_note() {
        let mut fx = SkillActivationFixture::new(vec![fragment("ghost-file", "")]);
        match resolve(&mut fx, json!({"name": "ghost-file"})) {
            Outcome::Local { summary, payload } => {
                assert_eq!(summary, "ghost-file");
                let text = payload.as_str().expect("string payload");
                assert!(!text.is_empty());
                assert!(text.contains("ghost-file"), "{text}");
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(fx.activated, vec!["ghost-file".to_string()]);
        assert_eq!(skill_events(&fx).len(), 1);
    }

    /// The definition is well-formed and carries the locked name (the
    /// reserved-name collision guard and both surfaces key off it).
    #[test]
    fn definition_is_well_formed() {
        let def = activate_skill_definition();
        assert_eq!(def.name, "activate_skill");
        assert!(!def.description.is_empty());
        assert_eq!(def.input_schema["type"], "object");
        assert_eq!(def.input_schema["properties"]["name"]["type"], "string");
        assert_eq!(def.input_schema["required"][0], "name");
    }
}
