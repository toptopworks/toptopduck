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
//! [`SkillActivationOutcome`] onto their own envelope -- the same
//! Local/Refused mapping they serve the trio's [`crate::mcp::meta_tools::MetaDispatch`] through.
//! Unlike the trio, the classification is NOT pure -- a successful
//! resolution lands a mutable state transition + an immediate atomic
//! persist (real-time by contract: the event reaches the timeline before
//! the tool result returns, and a turn that later fails or is cancelled
//! keeps the activation).
//!
//! The tool's result is the skill's body -- the SAME turn-start
//! [`SkillPromptFragment`] the system prompt assembled from, so the channel
//! and the per-turn injection are one source (ADR-0110 Decision 2's L2).
//! No directory structure rides the result (the third layer is deferred,
//! Decision 6).

use std::path::Path;

use serde_json::{json, Value};

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

/// The resolver's outcome -- exactly the two [`crate::mcp::meta_tools::MetaDispatch`] variants this
/// surface yields, owned and lifetime-free: the trio's borrowed
/// `Resolved`/`Fallthrough` arms exist for its fall-through and are
/// structurally unreachable here, so owning the pair keeps both dispatch
/// matches total with no panicking arms.
#[derive(Debug)]
pub(crate) enum SkillActivationOutcome {
    /// A served activation: the skill name for the trace summary + the
    /// model-facing payload (the body, or the degrade note, as a PLAIN
    /// string).
    Local { summary: String, payload: Value },
    /// A refused activation: the self-correcting message, served as the
    /// bare error result with no trace row.
    Refused(String),
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
/// The two outcome variants are `Local { summary: <skill name>, payload:
/// <the body verbatim, as a plain JSON string> }` and `Refused`; the sites'
/// existing Local/Refused mappings serve them exactly as they serve the
/// trio's (including the trace row: `name` = `activate_skill`, summary =
/// the skill name). The working set + temp path are the two pieces the
/// immediate persist borrows that live inside `TurnDeps` on both dispatch
/// faces.
pub(crate) fn resolve_skill_activation(
    call: &ToolUse,
    ctx: &mut SkillActivationCtx<'_>,
    working_set: &mut WorkingSet,
    temp_path: &Path,
) -> SkillActivationOutcome {
    let Some(name) = call
        .input
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return SkillActivationOutcome::Refused(missing_name_failure());
    };
    let Some(fragment) = ctx.fragments.iter().find(|f| f.name == name) else {
        return SkillActivationOutcome::Refused(unknown_skill_failure(name, ctx.fragments));
    };
    // Fresh or idempotent, the result is the body either way -- the landed
    // bool distinguishes them only for the event/persist pairing inside.
    ctx.land(name, working_set, temp_path);
    let payload = if fragment.body.is_empty() {
        degraded_body_note(name)
    } else {
        fragment.body.clone()
    };
    SkillActivationOutcome::Local {
        summary: name.to_string(),
        payload: Value::String(payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{SkillLifecycleActor, SkillLifecycleKind};
    use crate::session::skills::SkillActivationFixture;
    use crate::workingset::WorkingSet;

    /// One resolver call: the fixture owns the channel state; the working
    /// set + temp path the persist borrows are inert (an unbound persister
    /// persists nothing -- `save_if_bound`'s unbound no-op, pinned by its
    /// own unit test).
    fn resolve(fx: &mut SkillActivationFixture, input: Value) -> SkillActivationOutcome {
        let call = ToolUse {
            id: "tu_s".to_string(),
            name: ACTIVATE_SKILL.to_string(),
            input,
        };
        let mut ws = WorkingSet::default();
        resolve_skill_activation(&call, &mut fx.ctx(), &mut ws, std::path::Path::new(""))
    }

    /// A fresh activation lands one `Activate` event (actor `Agent`) and
    /// returns the fragment's body verbatim as the payload, summarized by
    /// the skill name.
    #[test]
    fn fresh_activation_lands_agent_event_and_returns_body() {
        let mut fx = SkillActivationFixture::new(vec![
            SkillActivationFixture::fragment("sql-coach", "Coach the SQL."),
            SkillActivationFixture::fragment("pdf-tools", "Handle PDFs."),
        ]);
        match resolve(&mut fx, json!({"name": "sql-coach"})) {
            SkillActivationOutcome::Local { summary, payload } => {
                assert_eq!(summary, "sql-coach");
                assert_eq!(payload, Value::String("Coach the SQL.".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(fx.activated, vec!["sql-coach".to_string()]);
        let events = fx.skill_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, SkillLifecycleKind::Activate);
        assert_eq!(events[0].name, "sql-coach");
        assert_eq!(events[0].actor, Some(SkillLifecycleActor::Agent));
    }

    /// A repeat activation lands no second event and still returns the body
    /// (the idempotent posture, locked asymmetric with the mount family).
    #[test]
    fn repeat_activation_lands_nothing_and_returns_body_again() {
        let mut fx = SkillActivationFixture::new(vec![SkillActivationFixture::fragment(
            "sql-coach",
            "Coach the SQL.",
        )]);
        resolve(&mut fx, json!({"name": "sql-coach"}));
        match resolve(&mut fx, json!({"name": "sql-coach"})) {
            SkillActivationOutcome::Local { summary, payload } => {
                assert_eq!(summary, "sql-coach");
                assert_eq!(payload, Value::String("Coach the SQL.".to_string()));
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(fx.skill_events().len(), 1);
    }

    /// An unknown name is refused with EVERY mounted name in the error --
    /// the one-hop self-correction signal.
    #[test]
    fn unknown_name_lists_every_mounted_name() {
        let mut fx = SkillActivationFixture::new(vec![
            SkillActivationFixture::fragment("sql-coach", "Coach the SQL."),
            SkillActivationFixture::fragment("pdf-tools", "Handle PDFs."),
        ]);
        match resolve(&mut fx, json!({"name": "ghost"})) {
            SkillActivationOutcome::Refused(message) => {
                assert!(message.contains("sql-coach"), "{message}");
                assert!(message.contains("pdf-tools"), "{message}");
                assert!(message.contains("ghost"), "{message}");
            }
            other => panic!("expected Refused, got {other:?}"),
        }
        assert!(fx.skill_events().is_empty());
        assert!(fx.activated.is_empty());
    }

    /// A malformed input (missing / non-string / empty name) is refused with
    /// the fixed message, and nothing lands.
    #[test]
    fn malformed_input_is_refused_with_fixed_message() {
        let mut fx = SkillActivationFixture::new(vec![SkillActivationFixture::fragment(
            "sql-coach",
            "Coach the SQL.",
        )]);
        for input in [
            json!({}),
            json!({"name": 7}),
            json!({"name": ""}),
            Value::Null,
        ] {
            match resolve(&mut fx, input) {
                SkillActivationOutcome::Refused(message) => assert_eq!(
                    message,
                    "activate_skill failed: parameter `name`: expected a non-empty string"
                ),
                other => panic!("expected Refused, got {other:?}"),
            }
        }
        assert!(fx.skill_events().is_empty());
    }

    /// A mounted skill whose turn-start body is empty STILL activates (the
    /// transition and the file are two layers), and the result is the
    /// non-empty degrade note -- never `Refused` (a refused activation
    /// would invite a retry death loop that cannot fix a file).
    #[test]
    fn unreadable_body_still_lands_and_returns_degrade_note() {
        let mut fx =
            SkillActivationFixture::new(vec![SkillActivationFixture::fragment("ghost-file", "")]);
        match resolve(&mut fx, json!({"name": "ghost-file"})) {
            SkillActivationOutcome::Local { summary, payload } => {
                assert_eq!(summary, "ghost-file");
                let text = payload.as_str().expect("string payload");
                assert!(!text.is_empty());
                assert!(text.contains("ghost-file"), "{text}");
            }
            other => panic!("expected Local, got {other:?}"),
        }
        assert_eq!(fx.activated, vec!["ghost-file".to_string()]);
        assert_eq!(fx.skill_events().len(), 1);
    }

    /// An unknown name on an EMPTY mounted surface still refuses with an
    /// honest message: a hallucinated `activate_skill` call on a turn that
    /// mounted nothing reaches the intercept (it keys off the name, not
    /// the advertisement), and the message names the empty surface
    /// instead of an empty list.
    #[test]
    fn unknown_name_with_an_empty_mounted_set_names_the_empty_surface() {
        let mut fx = SkillActivationFixture::new(Vec::new());
        match resolve(&mut fx, json!({"name": "ghost"})) {
            SkillActivationOutcome::Refused(message) => assert_eq!(
                message,
                "activate_skill: `ghost` is not mounted. No skills are mounted this turn."
            ),
            other => panic!("expected Refused, got {other:?}"),
        }
        assert!(fx.skill_events().is_empty());
        assert!(fx.activated.is_empty());
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
