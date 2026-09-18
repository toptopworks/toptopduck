//! The turn-assembly projection of the agent-definitions registry (issue
//! #933, ADR-0117): the pure functions that turn enabled registry entries
//! into the built-in runtime's named delegation tool family. Everything
//! here is assembly-time and side-effect-free -- the command boundary
//! snapshots the enabled entries into [`DelegationSpec`]s once per turn
//! (degradation facts flow back as return values: `from_entry` reports
//! skipped bindings for the caller to record, never logs them itself),
//! the session direct-lists each spec's [`DelegationSpec::tool_definition`]
//! into the tool table, and the loop runtime constructs the sub-agent from
//! the spec's [`subagent_preamble`] / [`subagent_tool_face`] when the main
//! agent calls the tool (ADR-0117 Decisions 1/2/4).
//!
//! Face vocabulary (ADR-0117 Decision 4): the sub-agent's tool face is the
//! full gateway face MINUS every delegation tool (depth-1 physical
//! exclusion -- the sub-agent is constructed with no delegation tool
//! mounted, so recursion is structurally impossible, not merely refused)
//! MINUS `invoke_skill` (the invocation channel stays
//! user + main-agent only); `read_skill_file` and the discovery trio
//! survive untouched, and every call the sub-agent makes dispatches
//! through the SAME shared core -- approval, audit, `result_N` promotion
//! -- as the main agent's.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use serde_json::json;

use crate::provider::tool_calling::ToolDefinition;

use super::model::AgentEntry;

/// The sub-agent's internal step cap (ADR-0117 Decision 5): counted inside
/// the sub-agent, independent of the main loop's cap. A delegation call
/// still costs the MAIN loop one step; the sub-agent burning this cap is a
/// tool-level failure the main agent reads, never a turn termination.
pub const SUBAGENT_STEP_CAP: usize = 10;

/// The same-batch delegation cap (ADR-0117 Decision 5): the 9th delegation
/// of one model-turn's batch is refused with an explicit error text. The
/// cap is on batch width, never on the total -- serial later batches stay
/// bounded by the main step cap and the no-progress watchdog.
pub const DELEGATION_BATCH_CAP: usize = 8;

/// One resolved skill binding (ADR-0117 Decision 2): the skill's registry
/// name and its verbatim body, assembled once and carried in `skill_refs`
/// mark order -- the order IS the injection order, pinned by test (the
/// sub-agent's preamble renders each body once, in this order); the named
/// fields keep the construction, render, and assertion sites
/// self-describing where the positional tuple forced `.0`/`.1`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillInjection {
    pub name: String,
    pub body: String,
}

/// One enabled agent definition's turn-assembly snapshot: the declaration
/// face (name / description / preamble) plus the RESOLVED skill bindings
/// (each bound skill's body, fetched once at assembly). Owned data only --
/// it crosses from the command boundary into the loop runtime's driver
/// thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegationSpec {
    /// The identity -- also the delegation tool's name (ADR-0117 Decision 1).
    pub name: String,
    /// The routing description embedded in the tool definition.
    pub description: String,
    /// The Markdown body -- the sub-agent's system prompt base.
    pub preamble: String,
    /// The bound skills' injections in mark order (see [`SkillInjection`]).
    /// Assembled once here; the sub-agent never re-resolves them.
    pub skill_injections: Vec<SkillInjection>,
}

impl DelegationSpec {
    /// Assemble from a registry entry against the registered skills'
    /// bodies, reporting -- alongside the spec -- every `skill_refs` name
    /// that resolved to no registered body. Pure: the caller records the
    /// skips at its own degradation point (`delegation_specs`'s warn
    /// block). The skip arm is structurally unreachable in production
    /// assembly (`scan_registered_skills`'s single scan yields both the
    /// names the entry's marks resolve against and the bodies table handed
    /// in here, so a bound name is always a key); it stands as the
    /// defensive clause for future callers. A dangling name degrades to an
    /// unbound sub-agent, never a refusal -- the ADR-0117 Decision 2
    /// no-breakage clause.
    #[must_use = "the second element carries the skipped bindings for the caller to record at its degradation point"]
    pub fn from_entry(
        entry: &AgentEntry,
        bodies: &BTreeMap<String, String>,
    ) -> (Self, Vec<String>) {
        let mut skipped = Vec::new();
        let skill_injections = entry
            .skill_refs
            .iter()
            .filter_map(|name| match bodies.get(name) {
                Some(body) => Some(SkillInjection {
                    name: name.clone(),
                    body: body.clone(),
                }),
                None => {
                    skipped.push(name.clone());
                    None
                }
            })
            .collect();
        (
            Self {
                name: entry.name.clone(),
                description: entry.description.clone(),
                preamble: entry.preamble.clone(),
                skill_injections,
            },
            skipped,
        )
    }

    /// The main-face tool definition (ADR-0117 Decision 1): tool name =
    /// definition name, description embeds the entry's routing
    /// description, and the single parameter is the natural-language task.
    /// English by the tool-face language split (the established fact the
    /// `invoke_skill` definition also records).
    pub fn tool_definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name.clone(),
            description: format!(
                "Delegate a task to the `{}` sub-agent. {} The sub-agent runs \
                 with its own context window over the shared tool face (no \
                 delegation, no skill activation) and reports back a final \
                 answer; any table it materializes joins the shared working \
                 set.",
                self.name, self.description
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The self-contained task for the sub-agent: goal, \
                             constraints, and what to report back."
                    }
                },
                "required": ["prompt"],
            }),
        }
    }
}

/// The sub-agent's system prompt (ADR-0117 Decision 2): the definition's
/// preamble with each bound skill's body injected ONCE, here at assembly
/// time -- the bodies enter the sub-agent's context through construction
/// alone (the sub-face has no activation channel by design, which makes
/// this injection the only path a skill body reaches a sub-agent). An
/// unbound preamble passes through verbatim.
pub fn subagent_preamble(spec: &DelegationSpec) -> String {
    if spec.skill_injections.is_empty() {
        return spec.preamble.clone();
    }
    let mut prompt = format!(
        "{}\n\n--- Bound skills (injected at assembly; the full skill \
         instructions follow) ---",
        spec.preamble
    );
    for injection in &spec.skill_injections {
        prompt.push_str(&format!(
            "\n\n# Skill: {}\n\n{}",
            injection.name, injection.body
        ));
    }
    prompt
}

/// The sub-agent's tool face (ADR-0117 Decision 4): the turn's tool table
/// minus every delegation tool minus `invoke_skill`. Depth-1 physical
/// exclusion: the returned face cannot contain a delegation tool,
/// so a sub-agent has nothing to recurse through even if its model tried.
/// `read_skill_file` and everything else survive verbatim.
pub fn subagent_tool_face(
    tools: &[ToolDefinition],
    delegation_names: &BTreeSet<&str>,
) -> Vec<ToolDefinition> {
    tools
        .iter()
        .filter(|tool| {
            !delegation_names.contains(tool.name.as_str())
                && tool.name != crate::skills::invocation::INVOKE_SKILL
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition(name: &str) -> ToolDefinition {
        ToolDefinition {
            name: name.to_string(),
            description: format!("{name} tool"),
            input_schema: json!({"type": "object"}),
        }
    }

    fn entry(name: &str, skill_refs: &[&str]) -> AgentEntry {
        AgentEntry {
            name: name.to_string(),
            description: "Routes open-ended work.".to_string(),
            preamble: "You are a focused analyst.".to_string(),
            source: super::super::model::AgentSource::User,
            enabled: true,
            link_target: None,
            skill_refs: skill_refs.iter().map(|s| s.to_string()).collect(),
            dangling_skill_refs: Vec::new(),
            dropped_axes: Vec::new(),
        }
    }

    fn bodies(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// AC #1 (face subtraction; ADR-0119 Decision 4): the sub-face strips
    /// every delegation tool and `invoke_skill` while `read_skill_file` and
    /// the built-in table survive verbatim -- the depth-1 exclusion is a
    /// subtraction over the assembled table, so what survives is exactly the
    /// shared gateway face.
    #[test]
    fn subagent_face_strips_delegation_and_invocation_keeps_read() {
        let tools = vec![
            definition("explore"),
            definition("materialize"),
            definition("read_skill_file"),
            definition("invoke_skill"),
            definition("general-purpose"),
            definition("data-cleaner"),
        ];
        let names: BTreeSet<&str> = ["general-purpose", "data-cleaner"].into_iter().collect();
        let face = subagent_tool_face(&tools, &names);
        let surviving: Vec<&str> = face.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(surviving, vec!["explore", "materialize", "read_skill_file"]);
    }

    /// AC #1 (depth-1 physical exclusion): the face the subtraction returns
    /// contains no delegation tool at all -- a sub-agent constructed FROM
    /// this face has nothing to delegate through, whatever name set a
    /// hypothetical depth-2 assembly would strip. Recursion is structurally
    /// unreachable, not merely refused.
    #[test]
    fn subagent_face_has_no_delegation_to_strip_at_depth_two() {
        let tools = vec![
            definition("explore"),
            definition("general-purpose"),
            definition("invoke_skill"),
        ];
        let names: BTreeSet<&str> = ["general-purpose"].into_iter().collect();
        let face = subagent_tool_face(&tools, &names);
        assert!(
            face.iter().all(|t| !names.contains(t.name.as_str())),
            "the sub-face carries no delegation tool to strip"
        );
    }

    /// AC #2 (mark hits): the from-entry assembly resolves each hit mark's
    /// body in mark order -- the injection set IS the intersection the
    /// registry scan computed, carried into the turn as data.
    #[test]
    fn from_entry_resolves_bound_skill_injections_in_mark_order() {
        let (spec, skipped) = DelegationSpec::from_entry(
            &entry("analyst", &["sql", "pdf-tools"]),
            &bodies(&[
                ("pdf-tools", "Extract tables first."),
                ("sql", "Prefer CTEs."),
                ("unused", "Never injected."),
            ]),
        );
        assert_eq!(skipped, Vec::<String>::new());
        assert_eq!(
            spec.skill_injections,
            vec![
                SkillInjection {
                    name: "sql".to_string(),
                    body: "Prefer CTEs.".to_string(),
                },
                SkillInjection {
                    name: "pdf-tools".to_string(),
                    body: "Extract tables first.".to_string(),
                },
            ]
        );
    }

    /// AC #2 (dangling skip): a bound name whose skill vanished between the
    /// scan and the assembly is skipped -- no body, no refusal, the rest of
    /// the bindings still inject (ADR-0117 Decision 2's no-breakage clause).
    /// The skip reports back through the return value, not a side effect --
    /// the caller owns recording it.
    #[test]
    fn from_entry_skips_a_dangling_binding_and_keeps_the_rest() {
        let (spec, skipped) = DelegationSpec::from_entry(
            &entry("analyst", &["sql", "ghost-skill"]),
            &bodies(&[("sql", "Prefer CTEs.")]),
        );
        assert_eq!(
            skipped,
            vec!["ghost-skill".to_string()],
            "the dangling binding reports back for the caller to record"
        );
        assert_eq!(
            spec.skill_injections,
            vec![SkillInjection {
                name: "sql".to_string(),
                body: "Prefer CTEs.".to_string(),
            }]
        );
    }

    /// The preamble render: an unbound spec passes through verbatim; a
    /// bound spec appends each body once under the skill's name.
    #[test]
    fn preamble_passes_through_unbound_and_appends_bound_bodies() {
        let (mut spec, _) = DelegationSpec::from_entry(&entry("analyst", &[]), &bodies(&[]));
        assert_eq!(subagent_preamble(&spec), "You are a focused analyst.");

        spec.skill_injections = vec![SkillInjection {
            name: "sql".to_string(),
            body: "Prefer CTEs.".to_string(),
        }];
        let rendered = subagent_preamble(&spec);
        assert!(rendered.starts_with("You are a focused analyst.\n\n---"));
        assert!(rendered.contains("# Skill: sql\n\nPrefer CTEs."));
        assert_eq!(
            rendered.matches("Prefer CTEs.").count(),
            1,
            "each body injects exactly once"
        );
    }

    /// The main-face definition: tool name = definition name, the routing
    /// description rides inside, and the single parameter is the prompt.
    #[test]
    fn tool_definition_routes_on_name_with_single_prompt_parameter() {
        let (spec, _) = DelegationSpec::from_entry(&entry("data-cleaner", &[]), &bodies(&[]));
        let def = spec.tool_definition();
        assert_eq!(def.name, "data-cleaner");
        assert!(def.description.contains("data-cleaner"));
        assert!(def.description.contains("Routes open-ended work."));
        assert_eq!(def.input_schema["required"], json!(["prompt"]));
        assert_eq!(def.input_schema["properties"]["prompt"]["type"], "string");
    }

    /// The ADR-0117 Decision 5 numbers, pinned where they live: sub-agent
    /// step cap 10, same-batch delegation cap 8.
    #[test]
    fn adr_decision_5_caps_are_pinned() {
        assert_eq!(SUBAGENT_STEP_CAP, 10);
        assert_eq!(DELEGATION_BATCH_CAP, 8);
    }
}
