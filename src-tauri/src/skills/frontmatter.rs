//! `SKILL.md` frontmatter split / parse / render (issue #362, ADR-0086).
//!
//! A SKILL.md is a `---` fenced YAML frontmatter block followed by a Markdown
//! body (the Agent Skills spec shape). The parse side extracts the fields the
//! registry reads (`name` / `description` / `license` / `compatibility`);
//! the write side mutates a PARSED mapping and re-renders it, so spec fields
//! this app does not surface (`allowed-tools`, any third-party key) survive
//! an edit verbatim instead of being clobbered -- a copied-in skill keeps
//! its full declaration face.

use serde_yaml::{Mapping, Value};

use super::model::SkillError;

/// A parsed SKILL.md: the whole frontmatter mapping (unknown keys intact) +
/// the Markdown body after the closing fence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkillMd {
    pub frontmatter: Mapping,
    pub body: String,
}

fn key(name: &str) -> Value {
    Value::String(name.to_string())
}

/// Split a raw SKILL.md into the YAML frontmatter text and the Markdown body.
/// The file must OPEN with a `---` fence line and CLOSE it with a second one;
/// everything after the close is the body, byte-for-byte (trailing newlines
/// included -- the body is a prompt fragment and later slices hash the whole
/// file, so the read path never normalizes content). A missing fence (or an
/// unterminated one) is a spec violation, reported with the reason.
pub fn split_frontmatter(raw: &str) -> Result<(String, String), String> {
    let mut lines = raw.split_inclusive('\n');
    match lines.next() {
        Some(first) if first.trim() == "---" => {}
        _ => {
            return Err("SKILL.md must start with a `---` frontmatter fence".into());
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
        return Err("SKILL.md frontmatter fence is never closed by a second `---`".into());
    }
    Ok((yaml, body))
}

/// Parse a raw SKILL.md into its frontmatter mapping + body. Every spec
/// violation (no fence, bad YAML, non-mapping frontmatter) carries the reason.
pub fn parse_skill_md(raw: &str) -> Result<ParsedSkillMd, String> {
    let (yaml, body) = split_frontmatter(raw)?;
    let value: Value =
        serde_yaml::from_str(&yaml).map_err(|e| format!("invalid YAML frontmatter: {e}"))?;
    let frontmatter = match value {
        Value::Mapping(mapping) => mapping,
        _ => return Err("frontmatter must be a YAML mapping".into()),
    };
    Ok(ParsedSkillMd { frontmatter, body })
}

/// Read a top-level string field off the frontmatter (None when absent or not
/// a plain string -- a wrong-typed field degrades to absent rather than
/// crashing the listing).
pub fn get_string(map: &Mapping, field: &str) -> Option<String> {
    map.get(key(field))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Set a top-level string field, or REMOVE the key when the value is None /
/// blank -- a cleared optional field disappears from the frontmatter instead of
/// persisting as an empty string.
pub fn set_string_or_remove(map: &mut Mapping, field: &str, value: Option<&str>) {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => {
            map.insert(key(field), Value::String(v.to_string()));
        }
        None => {
            map.remove(key(field));
        }
    }
}

/// Render the on-disk SKILL.md: the `---` fenced YAML frontmatter + the
/// Markdown body. serde_yaml preserves mapping insertion order, so an edit
/// keeps the field order the file had (existing keys update in place; new keys
/// append).
pub fn render_skill_md(frontmatter: &Mapping, body: &str) -> Result<String, SkillError> {
    let yaml = serde_yaml::to_string(frontmatter)
        .map_err(|e| SkillError::FsFailure(format!("serialize SKILL.md frontmatter: {e}")))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> &'static str {
        "---\nname: pdf-tools\ndescription: Work with PDF files.\nlicense: MIT\n---\nBody line one.\nBody line two.\n"
    }

    #[test]
    fn split_separates_frontmatter_and_body() {
        let (yaml, body) = split_frontmatter(sample()).unwrap();
        assert_eq!(
            yaml,
            "name: pdf-tools\ndescription: Work with PDF files.\nlicense: MIT\n"
        );
        // The body keeps its trailing newline (byte-for-byte read).
        assert_eq!(body, "Body line one.\nBody line two.\n");
    }

    #[test]
    fn split_rejects_missing_or_unterminated_fence() {
        assert!(split_frontmatter("no fence here\n").is_err());
        assert!(split_frontmatter("").is_err());
        assert!(split_frontmatter("---\nname: x\nbody without close\n").is_err());
    }

    #[test]
    fn parse_reads_fields_and_body() {
        let parsed = parse_skill_md(sample()).unwrap();
        assert_eq!(
            get_string(&parsed.frontmatter, "name").as_deref(),
            Some("pdf-tools")
        );
        assert_eq!(
            get_string(&parsed.frontmatter, "description").as_deref(),
            Some("Work with PDF files.")
        );
        assert_eq!(parsed.body, "Body line one.\nBody line two.\n");
    }

    #[test]
    fn parse_rejects_bad_yaml_or_non_mapping() {
        assert!(parse_skill_md("---\n: [unclosed\n---\nx\n").is_err());
        assert!(parse_skill_md("---\n- just\n- a list\n---\nbody\n").is_err());
    }

    #[test]
    fn set_string_or_remove_updates_drops_or_removes() {
        let parsed = parse_skill_md(sample()).unwrap();
        let mut map = parsed.frontmatter;
        set_string_or_remove(&mut map, "license", Some("Apache-2.0"));
        assert_eq!(get_string(&map, "license").as_deref(), Some("Apache-2.0"));
        set_string_or_remove(&mut map, "license", Some("   "));
        assert!(get_string(&map, "license").is_none());
        set_string_or_remove(&mut map, "compatibility", Some("requires network"));
        assert_eq!(
            get_string(&map, "compatibility").as_deref(),
            Some("requires network")
        );
    }

    #[test]
    fn render_produces_a_parseable_skill_md() {
        let parsed = parse_skill_md(sample()).unwrap();
        let rendered = render_skill_md(&parsed.frontmatter, &parsed.body).unwrap();
        assert!(rendered.starts_with("---\n"));
        // The render parses back to the identical logical content.
        let back = parse_skill_md(&rendered).unwrap();
        assert_eq!(back.frontmatter, parsed.frontmatter);
        assert_eq!(back.body, parsed.body);
    }

    #[test]
    fn edit_preserves_unknown_spec_fields() {
        // A copied-in skill carrying allowed-tools keeps the field through an
        // edit of the fields this app surfaces.
        let raw = "---\nname: s\ndescription: d\nallowed-tools:\n  - Bash\n---\nbody\n";
        let mut parsed = parse_skill_md(raw).unwrap();
        set_string_or_remove(&mut parsed.frontmatter, "description", Some("new desc"));
        let rendered = render_skill_md(&parsed.frontmatter, "new body\n").unwrap();
        assert!(
            rendered.contains("allowed-tools"),
            "foreign field must survive: {rendered}"
        );
        assert!(rendered.contains("new desc"));
        assert!(rendered.ends_with("new body\n"));
    }
}
