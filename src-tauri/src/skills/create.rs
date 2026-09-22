//! The `create_skill` meta-tool (ADR-0122 Decision 1): the model-facing
//! skill-creation channel. Unlike the read-shaped skill meta-tools the
//! mint PERSISTS across sessions and the body is a future prompt-injection
//! source, so the call is gated (`OperationKind::Write`) instead of served
//! directly -- the approval card carries the whole `skillMarkdown` as its
//! expand-on-demand attachment (full-text informed consent, issue #1009's
//! channel).
//!
//! The parameter is ONE string -- the whole `SKILL.md`. The server-side
//! parse extracts `name` / `description` for per-field typed rejects (the
//! model self-corrects from each), and the bytes land verbatim: unknown
//! frontmatter keys survive (the ecosystem interop interface).

use serde_json::{json, Value};

use crate::approval::{truncate_summary, FileAttachment, SUMMARY_MAX_CHARS};
use crate::provider::tool_calling::{ToolDefinition, ToolUse};
use crate::LiveProviderConfig;

/// The `create_skill` tool name, aligned with the `invoke_skill` /
/// `read_skill_file` family.
pub(crate) const CREATE_SKILL: &str = "create_skill";

/// Compose the success message both dispatch arms serve after an approved
/// mint -- a function (not a format-string const; `format!` demands a
/// literal) so the two per-side envelopes share the exact prose by
/// construction.
pub(crate) fn created_skill_result(name: &str) -> String {
    format!("Created skill `{name}` -- enabled, and invocable by name this session.")
}

/// The refusal for a call that reached a config-less gate (a stray call --
/// the tool never advertises without a live-config handle). Shared by both
/// dispatch arms for the same no-drift reason.
pub(crate) const UNAVAILABLE_FAILURE: &str =
    "create_skill: skill creation is unavailable in this session";

/// The creation channel's runtime bundle: the skills registry root (the
/// mint target) and the live-config handle (the stale-disabled-entry clear
/// that lands a same-name rebirth enabled, the form channel's composite
/// contract). `live: None` marks a config-less session (tests) -- the tool
/// never advertises there, and a stray call is refused rather than minting
/// untracked.
pub(crate) struct SkillCreateGate<'a> {
    pub root: &'a std::path::Path,
    pub live: Option<&'a LiveProviderConfig>,
}

impl SkillCreateGate<'_> {
    /// The dispatch tests' no-op bundle: no live config, an empty root.
    #[cfg(test)]
    pub(crate) fn inert() -> SkillCreateGate<'static> {
        SkillCreateGate {
            root: std::path::Path::new(""),
            live: None,
        }
    }
}

/// The resolver's outcome -- a two-arm shape mirroring the read meta-tools'
/// ([`crate::skills::read::SkillReadOutcome`]), with the served arm split
/// by the gate: `Gated` carries everything the approval card and the
/// post-approval write need, so both dispatch sites stay envelope mappers.
#[derive(Debug)]
pub(crate) enum SkillCreateOutcome {
    /// A refused creation: the self-correcting typed error, served as the
    /// bare error result with no trace row.
    Refused(String),
    /// A validated creation awaiting the gate: the trace / approval
    /// summary, the card's full-text attachment, and the verbatim payload
    /// to write.
    Gated {
        summary: String,
        file_attachments: Vec<FileAttachment>,
        markdown: String,
    },
}

/// The tool definition as advertised on both tool surfaces (the built-in
/// table and the gateway `tools/list`), unconditional on the discovery
/// snapshot -- with the form channel on its retirement path (#1033) this
/// is the in-app creation channel, so a session pays the standing tool
/// cost whatever its snapshot holds. The one mount condition is the
/// live-config handle riding the turn's inputs (the mint needs the config
/// write); a config-less session never advertises. English by the
/// two-surface language split. The description teaches the whole-document
/// parameter shape and the per-field self-correction face.
pub(crate) fn create_skill_definition() -> ToolDefinition {
    ToolDefinition {
        name: CREATE_SKILL.to_string(),
        description: "Create a new skill in the user's library from one complete \
             SKILL.md document. Pass the WHOLE file as a single string: the frontmatter \
             delimiters, YAML frontmatter with `name` (kebab-case, at most 64 chars) and \
             `description`, then the Markdown body. Only `name` and `description` are \
             validated per-field; other frontmatter keys land on disk verbatim. A refused \
             create names its exact defect (invalid name, invalid or missing description, \
             blank body, reserved or taken name) -- fix the markdown and retry. Creating \
             needs user approval, with the full text shown on the approval card; an \
             approved skill lands enabled, is reachable by name in this session, and \
             appears in later sessions' skill index."
            .to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "skillMarkdown": {
                    "type": "string",
                    "description": "The complete SKILL.md document -- frontmatter \
                         delimiters, YAML frontmatter, and the Markdown body, exactly as \
                         it should land on disk."
                }
            },
            "required": ["skillMarkdown"],
        }),
    }
}

/// The failure message for a `create_skill` call whose `skillMarkdown` is
/// missing, non-string, or empty -- the `mcp_search_tools` malformed-input
/// style, shared by both dispatch sites through the resolver.
fn missing_markdown_failure() -> String {
    "create_skill failed: parameter `skillMarkdown`: expected a non-empty string".to_string()
}

/// Classify one `create_skill` call against the write path (ADR-0122
/// Decisions 1 + 3): the whole-string parse + per-field validation (the
/// registry's shared typed-reject face) and the taken-name pre-check, both
/// BEFORE the gate -- a refusal is the model's to self-correct from, not
/// the approver's to adjudicate, so the user never sees a card for a mint
/// that cannot land. Pure -- no state changes anywhere; the NameTaken
/// window re-checks under the registry's own contract at write time (the
/// gate-pending window can race a same-name mint).
pub(crate) fn resolve_skill_creation(call: &ToolUse, root: &std::path::Path) -> SkillCreateOutcome {
    let Some(markdown) = str_param(&call.input, "skillMarkdown") else {
        return SkillCreateOutcome::Refused(missing_markdown_failure());
    };
    let (name, description) = match crate::skills::registry::parse_skill_markdown(markdown) {
        Ok(fields) => fields,
        Err(e) => return SkillCreateOutcome::Refused(format!("create_skill: {e}")),
    };
    if root.join(&name).exists() {
        return SkillCreateOutcome::Refused(format!(
            "create_skill: {}",
            crate::skills::SkillError::NameTaken(name)
        ));
    }
    SkillCreateOutcome::Gated {
        summary: truncate_summary(
            &format!("Create skill `{name}`: {description}"),
            SUMMARY_MAX_CHARS,
        ),
        // The pre-truncation original: the broadcast copy caps at
        // FILE_ATTACHMENT_MAX_CHARS, the pending-window full-text pull
        // (issue #1009) serves this verbatim copy -- informed consent reads
        // the whole document, never a preview.
        file_attachments: vec![FileAttachment {
            param: "skillMarkdown".to_string(),
            content: markdown.to_string(),
        }],
        markdown: markdown.to_string(),
    }
}

/// Land an approved creation: the live-config composite (registry mint +
/// stale-disabled-entry clear), so a same-name rebirth lands enabled --
/// identical to the form channel's contract by construction.
pub(crate) fn execute_skill_creation(
    live: &LiveProviderConfig,
    root: &std::path::Path,
    markdown: &str,
) -> Result<crate::skills::SkillEntry, crate::skills::SkillError> {
    live.create_skill_from_markdown(root, markdown)
}

/// Extract a non-empty string parameter -- the read surface's `str_param`,
/// same shape (an empty string counts as missing).
fn str_param<'v>(input: &'v Value, key: &str) -> Option<&'v str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(markdown: Value) -> ToolUse {
        ToolUse {
            id: "t1".to_string(),
            name: CREATE_SKILL.to_string(),
            input: json!({"skillMarkdown": markdown}),
        }
    }

    const VALID: &str = "---\nname: sql-coach\ndescription: Coach SQL.\n---\nBody.\n";

    /// The definition advertises the whole-document parameter and its
    /// required shape.
    #[test]
    fn definition_takes_one_whole_document_string() {
        let def = create_skill_definition();
        assert_eq!(def.name, "create_skill");
        assert_eq!(
            def.input_schema["required"],
            json!(["skillMarkdown"]),
            "one required parameter"
        );
        assert!(
            def.description.contains("SKILL.md"),
            "the description teaches the document shape: {}",
            def.description
        );
    }

    /// The refusal face: a missing / non-string / empty parameter, and each
    /// malformed-document shape, surface the typed error with the tool's
    /// name -- the model self-corrects from the message alone.
    #[test]
    fn resolve_refuses_malformed_calls_with_named_errors() {
        let root = tempfile::tempdir().expect("root");
        for (label, input) in [
            ("missing", json!(null)),
            ("non-string", json!(42)),
            ("empty", json!("")),
            (
                "blank body",
                json!("---\nname: sql-coach\ndescription: d.\n---\n \n"),
            ),
            (
                "bad name",
                json!("---\nname: SQL Coach\ndescription: d.\n---\nBody.\n"),
            ),
            (
                "missing description",
                json!("---\nname: sql-coach\n---\nBody.\n"),
            ),
            (
                "overlong description",
                json!(format!(
                    "---\nname: sql-coach\ndescription: {}\n---\nBody.\n",
                    "x".repeat(2000)
                )),
            ),
        ] {
            let SkillCreateOutcome::Refused(message) =
                resolve_skill_creation(&call(input), root.path())
            else {
                panic!("{label}: expected a refusal");
            };
            assert!(
                message.starts_with("create_skill"),
                "{label}: the message names the tool: {message}"
            );
        }
    }

    /// A taken name is refused before the gate -- the approver never sees a
    /// card for a mint that cannot land.
    #[test]
    fn resolve_refuses_a_taken_name_before_the_gate() {
        let root = tempfile::tempdir().expect("root");
        std::fs::create_dir_all(root.path().join("sql-coach")).expect("incumbent");
        match resolve_skill_creation(&call(json!(VALID)), root.path()) {
            SkillCreateOutcome::Refused(message) => {
                assert!(message.contains("already taken"), "{message}");
            }
            _ => panic!("expected a refusal"),
        }
    }

    /// A valid document yields the gated shape: a name-bearing summary, the
    /// whole document as the card's attachment, and the verbatim write
    /// payload.
    #[test]
    fn resolve_yields_the_gated_shape() {
        let root = tempfile::tempdir().expect("root");
        match resolve_skill_creation(&call(json!(VALID)), root.path()) {
            SkillCreateOutcome::Gated {
                summary,
                file_attachments,
                markdown,
            } => {
                assert!(summary.contains("sql-coach"), "{summary}");
                assert_eq!(markdown, VALID);
                assert_eq!(file_attachments.len(), 1);
                assert_eq!(file_attachments[0].param, "skillMarkdown");
                assert_eq!(file_attachments[0].content, VALID);
            }
            _ => panic!("expected the gated shape"),
        }
    }
}
