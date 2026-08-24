//! The fixed meta-tool discovery surface over external MCP tools (ADR-0105,
//! issue #657).
//!
//! The tool surface carries a fixed trio over external tools --
//! `mcp_list_servers` (connected-server manifest), `mcp_search_tools`
//! (catalog query -> tool cards), `mcp_invoke` (call dispatch) -- and the
//! agent discovers + addresses external tools by handle rather than seeing
//! a per-tool advertisement. The advertising cost is decoupled from how
//! many servers are connected.
//!
//! The handle `mcp__<slug>__<tool>` (ADR-0076 naming) is the single identity
//! across the whole chain: a search card's `tool` field, `mcp_invoke`'s
//! addressing argument, the approval predicate, and the trace record all use
//! the same string -- the agent copies it verbatim and never splits it. The
//! meta-tools themselves use single-underscore names so they never occupy the
//! double-underscore namespace.
//!
//! [`McpAggregator`](super::aggregator::McpAggregator) owns the catalog data
//! (connected servers + their advertised tools); this module owns the pure
//! pieces -- the trio's names + definitions, the search match semantics, and
//! the `mcp_invoke` input parse. The dispatch sites (the gateway server for
//! the bridge path, `execute_call` for the built-in loop) resolve an invoke
//! BEFORE the enforcement points so approval / audit / trace keep consuming
//! the backend tool identity (ADR-0105 Decision 4).

use serde_json::{json, Value};

use crate::provider::tool_calling::ToolDefinition;

/// The `mcp_list_servers` tool name: the connected-server manifest for this
/// turn (display name, connect outcome, tool count).
pub(crate) const META_LIST_SERVERS: &str = "mcp_list_servers";

/// The `mcp_search_tools` tool name: catalog query returning tool cards.
pub(crate) const META_SEARCH_TOOLS: &str = "mcp_search_tools";

/// The `mcp_invoke` tool name: dispatch a backend tool call by handle.
pub(crate) const META_INVOKE: &str = "mcp_invoke";

/// The maximum number of tool cards one `mcp_search_tools` call returns
/// (ADR-0105 Decision 3: top-K = 10, the response advises narrowing the
/// query when more matches exist -- surfaced via `total_matched`).
pub(crate) const SEARCH_TOP_K: usize = 10;

/// The failure message for an `mcp_invoke` tool field that is not a
/// namespaced handle. Shared by both dispatch sites so the agent sees one
/// error shape regardless of which runtime served the call.
pub(crate) fn not_a_handle_failure(handle: &str) -> String {
    format!("mcp_invoke tool `{handle}` is not a namespaced mcp__<slug>__<tool> handle")
}

/// The failure message for an `mcp_invoke` handle whose server slug has no
/// connected server this turn.
pub(crate) fn unknown_server_failure(handle: &str, slug: &str) -> String {
    format!(
        "mcp_invoke tool `{handle}` names server slug `{slug}`, which is not connected this turn"
    )
}

/// The failure message for a `mcp_search_tools` call missing its query
/// parameter.
pub(crate) fn missing_query_failure() -> String {
    "mcp_search_tools failed: parameter `query`: expected a string".to_string()
}

/// The trace/approval summary for one `mcp_search_tools` call.
pub(crate) fn query_summary(query: &str) -> String {
    format!("query \"{query}\"")
}

/// The trio's definitions as advertised on the tool surface. Attached ONLY
/// when the turn's effective external set is non-empty (ADR-0105 Decision 6:
/// a zero-server turn pays no standing trio cost) -- the caller checks the
/// catalog and skips the extend when empty. Unlike the built-in DuckDB tools,
/// these are conditionally mounted, so they do not live in
/// [`crate::tools::definitions`]' always-on table.
pub(crate) fn meta_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: META_LIST_SERVERS.to_string(),
            description: "List the external MCP servers connected this turn, with each \
                 server's display name, connect outcome, and advertised tool count. \
                 Use this to see which servers are live before searching."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {},
            }),
        },
        ToolDefinition {
            name: META_SEARCH_TOOLS.to_string(),
            description: format!(
                "Search the external MCP tool catalog for this turn. The query \
                 is split on whitespace; every token must match (AND), \
                 case-insensitively as a substring of the server display name, \
                 the native tool name, or the tool description. An empty query \
                 returns the whole catalog. Each result card carries the tool \
                 handle, server display name, description, and full inputSchema \
                 -- copy the handle verbatim into mcp_invoke. At most {SEARCH_TOP_K} \
                 cards are returned; narrow the query when total_matched exceeds that."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search keywords (whitespace-separated, AND). \
                             Empty returns the full catalog."
                    }
                },
                "required": ["query"],
            }),
        },
        ToolDefinition {
            name: META_INVOKE.to_string(),
            description: "Invoke one external MCP tool by its handle. The handle is the \
                 `tool` field of a search card (mcp__<server>__<name>) -- copy it \
                 verbatim; do not split or rewrite it. The backend tool's \
                 result is returned as-is, including its isError shape."
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "tool": {
                        "type": "string",
                        "description": "The tool handle from a search card."
                    },
                    "arguments": {
                        "type": "object",
                        "description": "The backend tool's arguments, shaped by the \
                             card's inputSchema."
                    }
                },
                "required": ["tool"],
            }),
        },
    ]
}

/// Whether one catalog entry matches the query (ADR-0105 Decision 3). The
/// query is split on whitespace; every token must hit (AND), and a token hits
/// when it appears case-insensitively as a substring of ANY of the three
/// fields -- the union of {server display name, native tool name,
/// description}. Pure + allocation-light so the semantics are unit-testable
/// independent of the aggregator.
pub(crate) fn matches_query(query: &str, server: &str, tool: &str, description: &str) -> bool {
    let server_lower = server.to_lowercase();
    let tool_lower = tool.to_lowercase();
    let description_lower = description.to_lowercase();
    query.split_whitespace().all(|token| {
        let token = token.to_lowercase();
        server_lower.contains(&token)
            || tool_lower.contains(&token)
            || description_lower.contains(&token)
    })
}

/// Build one search card: `{tool handle, server display name, description,
/// inputSchema}` -- the card IS the full card (ADR-0105 Decision 3):
/// everything needed to assemble an `mcp_invoke` call, no second hop. The
/// handle is composed by the caller (not re-derived at invoke time) so the
/// card's `tool` field is byte-wise the addressing argument. A missing
/// `inputSchema` degrades to an empty object.
pub(crate) fn search_card(
    display_name: &str,
    description: &str,
    input_schema: &Value,
    handle: String,
) -> Value {
    json!({
        "tool": handle,
        "server": display_name,
        "description": description,
        "inputSchema": input_schema,
    })
}

/// Parse an `mcp_invoke` input into `(handle, arguments)`. The handle must be
/// a non-empty string; `arguments` is optional (a no-argument backend tool
/// needs none) and defaults to an empty object. Anything else is a malformed
/// call the agent self-corrects from (ADR-0077) -- surfaced as the call's
/// error result by the dispatch sites, producing no trace entry.
pub(crate) fn parse_invoke_input(input: &Value) -> Result<(String, Value), String> {
    let handle = input
        .get("tool")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "parameter `tool`: expected a non-empty string handle".to_string())?
        .to_string();
    let arguments = match input.get("arguments") {
        None | Some(Value::Null) => Value::Object(serde_json::Map::new()),
        Some(v @ Value::Object(_)) => v.clone(),
        Some(_) => {
            return Err("parameter `arguments`: expected an object".to_string());
        }
    };
    Ok((handle, arguments))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Token AND over the three-field union, case-insensitive substring.
    #[test]
    fn matches_query_requires_every_token_in_the_union() {
        // Both tokens hit (one via description, one via tool name).
        assert!(matches_query(
            "github search",
            "GitHub",
            "search_issues",
            "Search issues in a repo"
        ));
        // A token hitting only the server display name still counts.
        assert!(matches_query("GITHUB", "GitHub", "unrelated", ""));
        // One token missing everywhere -> no match.
        assert!(!matches_query(
            "github webhook",
            "GitHub",
            "search_issues",
            "Search issues in a repo"
        ));
        // Case-insensitive: query lowercase against mixed-case fields.
        assert!(matches_query("issues", "GitHub", "SearchIssues", ""));
    }

    /// An empty query (or all-whitespace) matches everything -- the
    /// "empty query returns the full catalog" rule rides the same predicate.
    #[test]
    fn matches_query_empty_query_matches_all() {
        assert!(matches_query("", "any", "any", "any"));
        assert!(matches_query("   ", "any", "any", "any"));
    }

    /// The trio's definitions are well-formed (non-empty name + description,
    /// object schema) -- the same contract the provider adapters rely on for
    /// the built-in table.
    #[test]
    fn meta_tool_definitions_are_well_formed() {
        let defs = meta_tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec![META_LIST_SERVERS, META_SEARCH_TOOLS, META_INVOKE]
        );
        for def in &defs {
            assert!(!def.description.is_empty());
            assert_eq!(def.input_schema["type"], "object");
        }
    }

    /// The card carries exactly the four fields, with the handle verbatim.
    #[test]
    fn search_card_is_the_full_card() {
        let schema = json!({"type": "object", "properties": {"q": {"type": "string"}}});
        let card = search_card(
            "GitHub",
            "Search issues",
            &schema,
            "mcp__github__search_issues".into(),
        );
        assert_eq!(card["tool"], "mcp__github__search_issues");
        assert_eq!(card["server"], "GitHub");
        assert_eq!(card["description"], "Search issues");
        assert_eq!(card["inputSchema"]["properties"]["q"]["type"], "string");
        assert_eq!(card.as_object().unwrap().len(), 4);
    }

    /// Invoke input parse: handle required non-empty; arguments optional
    /// (defaults to {}), must be an object when present.
    #[test]
    fn parse_invoke_input_shapes_the_addressing_pair() {
        let (handle, args) =
            parse_invoke_input(&json!({"tool": "mcp__github__search", "arguments": {"q": "x"}}))
                .expect("parse");
        assert_eq!(handle, "mcp__github__search");
        assert_eq!(args, json!({"q": "x"}));

        let (handle, args) = parse_invoke_input(&json!({"tool": "mcp__a__b"})).expect("parse");
        assert_eq!(handle, "mcp__a__b");
        assert_eq!(args, json!({}));

        assert!(parse_invoke_input(&json!({"arguments": {}})).is_err());
        assert!(parse_invoke_input(&json!({"tool": ""})).is_err());
        assert!(parse_invoke_input(&json!({"tool": "mcp__a__b", "arguments": 3})).is_err());
    }
}
