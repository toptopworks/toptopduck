//! Agent-definition file parse / render (issue #932, ADR-0117).
//!
//! One definition = one markdown file: `---` fenced YAML frontmatter
//! carrying `name` / `description`, then the preamble body (the sub-agent's
//! system prompt), byte-for-byte. The shape aligns with the community
//! subagent file format, so an import is a file copy and an export is the
//! file itself -- zero conversion, no private schema extension
//! (ADR-0117 Decision 2). The community `tools` / `model` axes are parsed
//! then DISCARDED (this app rejects both axes): the parse records the dropped
//! key names for the settings-page warning row -- never a hard refusal,
//! never silent. Unknown frontmatter keys are neither consumed nor dropped;
//! an edit preserves them verbatim (the SKILL.md edit contract).

use serde_yaml::Mapping;

use super::model::AgentError;

/// The community-format axes this app rejects (ADR-0117 Decision 2). A key's
/// PRESENCE (any value shape) is the degradable signal; the value is never
/// read.
pub const DROPPED_AXIS_KEYS: &[&str] = &["tools", "model"];

/// Split a raw definition file into the YAML frontmatter text and the
/// preamble body. Same fence contract as the skills loader, with
/// agent-side wording (the messages ride the `InvalidAgent` detail fold).
fn split(raw: &str) -> Result<(String, String), String> {
    let mut lines = raw.split_inclusive('\n');
    match lines.next() {
        Some(first) if first.trim() == "---" => {}
        _ => {
            return Err("the definition file must start with a `---` frontmatter fence".into());
        }
    }
    let mut yaml = String::new();
    let mut body = String::new();
    let mut closed = false;
    for line in lines {
        if !closed && line.trim() == "---" {
            closed = true;
        } else if closed {
            body.push_str(line);
        } else {
            yaml.push_str(line);
        }
    }
    if !closed {
        return Err("the frontmatter fence is never closed by a second `---`".into());
    }
    Ok((yaml, body))
}

/// A parsed definition file: the frontmatter mapping (unknown keys intact),
/// the preamble, and the community axes the parse dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAgentMd {
    pub frontmatter: Mapping,
    pub preamble: String,
    pub dropped_axes: Vec<String>,
}

/// Parse a raw definition file. Every violation (no fence, bad YAML,
/// non-mapping frontmatter, missing/blank `name` or `description`) carries
/// the reason.
pub fn parse_agent_md(raw: &str) -> Result<ParsedAgentMd, String> {
    let (yaml, preamble) = split(raw)?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(&yaml).map_err(|e| format!("invalid YAML frontmatter: {e}"))?;
    let frontmatter = match value {
        serde_yaml::Value::Mapping(mapping) => mapping,
        _ => return Err("frontmatter must be a YAML mapping".into()),
    };
    for field in ["name", "description"] {
        match crate::skills::frontmatter::get_string(&frontmatter, field) {
            Some(s) if !s.trim().is_empty() => {}
            _ => {
                return Err(format!(
                    "frontmatter `{field}` is required and must not be blank"
                ))
            }
        }
    }
    // The community axes this app rejects: record the PRESENT keys (stable
    // DROPPED_AXIS_KEYS order) and leave the mapping untouched so an edit
    // round-trips the original file shape.
    let dropped_axes = DROPPED_AXIS_KEYS
        .iter()
        .filter(|key| frontmatter.contains_key(serde_yaml::Value::String((*key).to_string())))
        .map(|key| key.to_string())
        .collect();
    Ok(ParsedAgentMd {
        frontmatter,
        preamble,
        dropped_axes,
    })
}

/// Overwrite one string field in the mapping (insertion-order preserving:
/// an existing key updates in place, a new key appends -- serde_yaml keeps
/// mapping order, the skills edit contract).
pub fn set_string(map: &mut Mapping, field: &str, value: &str) {
    map.insert(
        serde_yaml::Value::String(field.to_string()),
        serde_yaml::Value::String(value.to_string()),
    );
}

/// Render the on-disk file: the `---` fenced YAML frontmatter + the
/// preamble.
pub fn render_agent_md(frontmatter: &Mapping, preamble: &str) -> Result<String, AgentError> {
    let yaml = serde_yaml::to_string(frontmatter).map_err(|e| {
        AgentError::FsFailure(format!("serialize agent-definition frontmatter: {e}"))
    })?;
    Ok(format!("---\n{yaml}---\n{preamble}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> &'static str {
        "---\nname: data-cleaner\ndescription: Cleans datasets.\ntools: Read, Write\nmodel: sonnet\n---\nYou clean data.\n"
    }

    #[test]
    fn split_separates_frontmatter_and_preamble() {
        let (yaml, body) = split(sample()).unwrap();
        assert!(yaml.starts_with("name: data-cleaner\n"));
        // The preamble keeps its trailing newline (byte-for-byte read).
        assert_eq!(body, "You clean data.\n");
    }

    #[test]
    fn split_rejects_missing_or_unterminated_fence() {
        assert!(split("no fence\n").is_err());
        assert!(split("").is_err());
        assert!(split("---\nname: x\nno close\n").is_err());
    }

    #[test]
    fn parse_reads_fields_and_records_dropped_axes() {
        let parsed = parse_agent_md(sample()).unwrap();
        assert_eq!(parsed.preamble, "You clean data.\n");
        assert_eq!(parsed.dropped_axes, vec!["tools", "model"]);
        // The dropped keys stay in the mapping (an edit preserves them).
        assert!(parsed
            .frontmatter
            .contains_key(serde_yaml::Value::String("tools".into())));
        assert!(parsed
            .frontmatter
            .contains_key(serde_yaml::Value::String("model".into())));
    }

    #[test]
    fn parse_without_community_axes_records_none() {
        let parsed =
            parse_agent_md("---\nname: sql\ndescription: Runs SQL.\n---\nYou run SQL.\n").unwrap();
        assert!(parsed.dropped_axes.is_empty());
    }

    #[test]
    fn parse_refuses_missing_or_blank_required_fields() {
        assert!(parse_agent_md("---\ndescription: x\n---\nbody\n").is_err());
        assert!(parse_agent_md("---\nname: x\n---\nbody\n").is_err());
        assert!(parse_agent_md("---\nname: \" \"\ndescription: x\n---\nbody\n").is_err());
        assert!(parse_agent_md("---\n- a\n- list\n---\nbody\n").is_err());
    }

    #[test]
    fn render_round_trips_a_parse() {
        let parsed = parse_agent_md(sample()).unwrap();
        let rendered = render_agent_md(&parsed.frontmatter, &parsed.preamble).unwrap();
        assert_eq!(rendered, sample());
        let reparsed = parse_agent_md(&rendered).unwrap();
        assert_eq!(reparsed, parsed);
    }

    #[test]
    fn set_string_updates_in_place() {
        let mut parsed = parse_agent_md(sample()).unwrap();
        set_string(&mut parsed.frontmatter, "description", "New description.");
        let rendered = render_agent_md(&parsed.frontmatter, &parsed.preamble).unwrap();
        assert!(rendered.contains("description: New description.\n"));
        assert!(rendered.contains("name: data-cleaner\n"));
    }
}
