//! `SKILL.md` frontmatter split / parse / render (issue #362, ADR-0086).
//!
//! A SKILL.md is a `---` fenced YAML frontmatter block followed by a Markdown
//! body (the Agent Skills spec shape). The parse side extracts the fields the
//! registry reads (`name` / `description` / `license` / `compatibility` /
//! `metadata.toptopduck_mcp_servers`); the write side mutates a PARSED mapping
//! and re-renders it, so spec fields this app does not surface (`allowed-tools`,
//! any third-party key) survive an edit verbatim instead of being clobbered --
//! a copied-in skill keeps its full declaration face.

use serde_yaml::{Mapping, Value};

use super::model::SkillError;

/// A parsed SKILL.md: the whole frontmatter mapping (unknown keys intact) +
/// the Markdown body after the closing fence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkillMd {
    pub frontmatter: Mapping,
    pub body: String,
}

/// The extension key under `metadata` that carries the referenced MCP server
/// ids (ADR-0086 Decision 1, comma-separated ids). Everything else in the
/// frontmatter is spec-native.
pub const MCP_SERVERS_KEY: &str = "toptopduck_mcp_servers";

/// The extension key under `metadata` that carries the referenced CLI tool
/// registration names (ADR-0108 Decision 7, comma-separated names). The exact
/// sibling of [`MCP_SERVERS_KEY`]: same comma-list shape, same degrade
/// posture, same declarative-metadata semantics (a reference never
/// configures or enables anything).
pub const CLI_TOOLS_KEY: &str = "toptopduck_cli_tools";

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

/// The ids under `metadata.<ext_key>` as a comma-separated string, split +
/// trimmed, empties dropped. Absent / mistyped anywhere along the path
/// degrades to an empty list. Shared by both extension keys
/// ([`MCP_SERVERS_KEY`], [`CLI_TOOLS_KEY`]) so their parse semantics stay
/// bit-identical by construction.
fn metadata_refs(map: &Mapping, ext_key: &str) -> Vec<String> {
    let Some(Value::Mapping(metadata)) = map.get(key("metadata")) else {
        return Vec::new();
    };
    let Some(Value::String(list)) = metadata.get(key(ext_key)) else {
        return Vec::new();
    };
    list.split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

/// The referenced MCP server ids: `metadata.toptopduck_mcp_servers` (issue
/// #369). See [`metadata_refs`] for the degrade posture.
pub fn mcp_servers(map: &Mapping) -> Vec<String> {
    metadata_refs(map, MCP_SERVERS_KEY)
}

/// The referenced CLI tool registration names:
/// `metadata.toptopduck_cli_tools` (issue #674, ADR-0108 Decision 7). The
/// exact sibling of [`mcp_servers`].
pub fn cli_tools(map: &Mapping) -> Vec<String> {
    metadata_refs(map, CLI_TOOLS_KEY)
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

/// Write `metadata.<ext_key>` from a reference list. An empty list removes
/// the extension key (and the `metadata` mapping itself when it becomes
/// empty), so a skill with no references carries no toptopduck trace --
/// portability to other agents stays clean (ADR-0086 Why 1.1). Other keys a
/// future extension may park under `metadata` are left intact. Shared by both
/// extension keys so their cleanup semantics stay bit-identical.
fn set_metadata_refs(map: &mut Mapping, ext_key: &str, ids: &[String]) {
    let mut metadata = match map.get(key("metadata")) {
        Some(Value::Mapping(existing)) => existing.clone(),
        _ => Mapping::new(),
    };
    if ids.is_empty() {
        metadata.remove(key(ext_key));
        if metadata.is_empty() {
            map.remove(key("metadata"));
        } else {
            map.insert(key("metadata"), Value::Mapping(metadata));
        }
        return;
    }
    let joined = ids
        .iter()
        .map(|id| id.trim())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if joined.is_empty() {
        // Every id was blank -- same shape as the empty-list path.
        set_metadata_refs(map, ext_key, &[]);
        return;
    }
    metadata.insert(key(ext_key), Value::String(joined));
    map.insert(key("metadata"), Value::Mapping(metadata));
}

/// Write `metadata.toptopduck_mcp_servers` from an id list. See
/// [`set_metadata_refs`] for the cleanup semantics.
pub fn set_mcp_servers(map: &mut Mapping, ids: &[String]) {
    set_metadata_refs(map, MCP_SERVERS_KEY, ids);
}

/// Write `metadata.toptopduck_cli_tools` from a name list (issue #674,
/// ADR-0108 Decision 7). The exact sibling of [`set_mcp_servers`].
pub fn set_cli_tools(map: &mut Mapping, names: &[String]) {
    set_metadata_refs(map, CLI_TOOLS_KEY, names);
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
    fn mcp_servers_parses_comma_list_and_degrades() {
        let raw = "---\nname: s\ndescription: d\nmetadata:\n  toptopduck_mcp_servers: \"github-mcp, fs-server , ,local-mcp\"\n---\nbody\n";
        let parsed = parse_skill_md(raw).unwrap();
        assert_eq!(
            mcp_servers(&parsed.frontmatter),
            vec![
                "github-mcp".to_string(),
                "fs-server".to_string(),
                "local-mcp".to_string()
            ]
        );

        // Absent metadata, mistyped key, non-mapping metadata -- all degrade to
        // an empty list, never a listing failure.
        let plain = parse_skill_md("---\nname: s\ndescription: d\n---\nbody\n").unwrap();
        assert!(mcp_servers(&plain.frontmatter).is_empty());
        let mistyped = parse_skill_md(
            "---\nname: s\ndescription: d\nmetadata:\n  toptopduck_mcp_servers: [1, 2]\n---\nbody\n",
        )
        .unwrap();
        assert!(mcp_servers(&mistyped.frontmatter).is_empty());
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
    fn set_mcp_servers_round_trips_and_cleans_up() {
        let parsed = parse_skill_md(sample()).unwrap();
        let mut map = parsed.frontmatter;

        set_mcp_servers(&mut map, &["a-mcp".into(), "b-mcp".into()]);
        assert_eq!(
            mcp_servers(&map),
            vec!["a-mcp".to_string(), "b-mcp".to_string()]
        );

        // Emptying removes the extension key AND the now-empty metadata mapping.
        set_mcp_servers(&mut map, &[]);
        assert!(mcp_servers(&map).is_empty());
        assert!(map.get(key("metadata")).is_none());

        // A foreign metadata key survives the extension-key cleanup.
        map.insert(
            key("metadata"),
            Value::Mapping({
                let mut m = Mapping::new();
                m.insert(key("other_tool"), Value::String("keep-me".into()));
                m
            }),
        );
        set_mcp_servers(&mut map, &[]);
        let Value::Mapping(metadata) = map.get(key("metadata")).unwrap() else {
            panic!("foreign metadata key must survive")
        };
        assert_eq!(
            metadata.get(key("other_tool")).and_then(Value::as_str),
            Some("keep-me")
        );
    }

    #[test]
    fn cli_tools_parses_comma_list_and_degrades() {
        let raw = "---\nname: s\ndescription: d\nmetadata:\n  toptopduck_cli_tools: \"pandoc, pdftotext , ,office-cli\"\n---\nbody\n";
        let parsed = parse_skill_md(raw).unwrap();
        assert_eq!(
            cli_tools(&parsed.frontmatter),
            vec![
                "pandoc".to_string(),
                "pdftotext".to_string(),
                "office-cli".to_string()
            ]
        );

        // Same degrade ladder as the MCP sibling: absent metadata, mistyped
        // key, non-mapping metadata -- all empty, never a listing failure.
        let plain = parse_skill_md("---\nname: s\ndescription: d\n---\nbody\n").unwrap();
        assert!(cli_tools(&plain.frontmatter).is_empty());
        let mistyped = parse_skill_md(
            "---\nname: s\ndescription: d\nmetadata:\n  toptopduck_cli_tools: [1, 2]\n---\nbody\n",
        )
        .unwrap();
        assert!(cli_tools(&mistyped.frontmatter).is_empty());
    }

    #[test]
    fn both_extension_keys_parse_independently() {
        // One skill declaring both keys: each parses its own list, neither
        // feeds the other (issue #674 AC).
        let raw = "---\nname: s\ndescription: d\nmetadata:\n  toptopduck_mcp_servers: github-mcp\n  toptopduck_cli_tools: pandoc, office-cli\n---\nbody\n";
        let parsed = parse_skill_md(raw).unwrap();
        assert_eq!(
            mcp_servers(&parsed.frontmatter),
            vec!["github-mcp".to_string()]
        );
        assert_eq!(
            cli_tools(&parsed.frontmatter),
            vec!["pandoc".to_string(), "office-cli".to_string()]
        );
    }

    #[test]
    fn set_cli_tools_round_trips_and_cleans_up() {
        let parsed = parse_skill_md(sample()).unwrap();
        let mut map = parsed.frontmatter;

        set_cli_tools(&mut map, &["pandoc".into(), "office-cli".into()]);
        assert_eq!(
            cli_tools(&map),
            vec!["pandoc".to_string(), "office-cli".to_string()]
        );

        // Emptying removes the CLI key AND the now-empty metadata mapping.
        set_cli_tools(&mut map, &[]);
        assert!(cli_tools(&map).is_empty());
        assert!(map.get(key("metadata")).is_none());

        // Emptying the CLI key leaves a live MCP key (and vice versa): the
        // cleanup only removes the mapping when BOTH are gone.
        set_mcp_servers(&mut map, &["github-mcp".into()]);
        set_cli_tools(&mut map, &["pandoc".into()]);
        set_cli_tools(&mut map, &[]);
        assert_eq!(
            mcp_servers(&map),
            vec!["github-mcp".to_string()],
            "clearing the CLI key must not touch the MCP key"
        );
        let Value::Mapping(metadata) = map.get(key("metadata")).unwrap() else {
            panic!("metadata mapping must survive while the MCP key lives")
        };
        assert!(metadata.get(key(CLI_TOOLS_KEY)).is_none());
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
