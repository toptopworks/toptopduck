//! The gateway's aggregator over connected external MCP servers (ADR-0076,
//! issue #301 slice C-gw).
//!
//! The gateway advertises ONE merged tool table to the bridge / built-in LLM:
//! the built-in DuckDB tools plus every enabled external server's tools,
//! namespaced as `mcp__<server_slug>__<tool>` (ADR-0076) so same-name tools
//! across servers stay distinct and the trace filter (`mcp__` prefix) stays
//! reliable. A `tools/call` carrying a namespaced name is parsed here and
//! routed to the matching [`StdioClient`] (the `mcp__<slug>__` prefix is
//! stripped -- the server only ever sees its own native tool name).
//!
//! Turn-local (issue #301 Q2): the gateway constructs one `McpAggregator` per
//! turn via [`McpAggregator::connect_all`] and drops it at turn end, killing
//! every spawned child. A failed connect (unsupported transport in slice C1,
//! spawn fault, tools/list error) logs + skips that server rather than failing
//! the turn -- a misconfigured server must not brick the gateway.

use serde_json::Value;

use crate::mcp::client::{ClientError, SecretEnv, StdioClient};
use crate::mcp::config::{McpServerConfig, McpServerId};
use crate::mcp::secrets::get_mcp_secret;
use crate::provider::keychain::KeychainStore;

/// The prefix marking a gateway-aggregated external tool name. The bridge /
/// built-in LLM sees `mcp__<server_slug>__<tool>`; the gateway parses the
/// prefix to route, then forwards the bare `<tool>` to the server. Pinned here
/// so the trace filter (ADR-0085) + classify + parse all agree on the token.
const NAMESPACED_PREFIX: &str = "mcp__";

/// The separator between the server slug and the server-native tool name
/// within a namespaced name (`mcp__<slug>__<tool>`).
const NAMESPACED_SEP: &str = "__";

/// One connected external server + its (already-listed) tool entries kept in
/// their server-native shape. The aggregator namespaces the name only when
/// advertising the merged table (so the stored entries stay the raw server
/// shape and routing strips the prefix rather than re-deriving it).
struct AggregatedServer {
    slug: String,
    client: StdioClient,
    tools: Vec<Value>,
}

/// The merged view over every connected external MCP server (ADR-0076). Owns
/// the spawned children; `Drop` kills them via [`StdioClient`]'s `Drop`.
pub struct McpAggregator {
    servers: Vec<AggregatedServer>,
}

impl McpAggregator {
    /// An empty aggregator (no servers connected). The gateway uses this when
    /// the user has configured no servers, or as the starting point before
    /// [`Self::connect_one`] calls.
    pub fn empty() -> Self {
        Self { servers: vec![] }
    }

    /// Spawn + initialize one server, list its tools, and add it under a
    /// unique slug derived from its display name. A failure (unsupported
    /// transport in slice C1, spawn fault, tools/list fault) logs + skips
    /// the server -- the turn is not failed by a misconfigured server.
    pub fn connect_one(&mut self, config: &McpServerConfig, secrets: &[SecretEnv]) {
        let mut client = match StdioClient::connect(config, secrets) {
            Ok(c) => c,
            Err(ClientError::UnsupportedTransport(t)) => {
                log::warn!(
                    target: "toptopduck::mcp",
                    "skipping MCP server {}: slice C1 supports stdio only (got {t})",
                    config.id
                );
                return;
            }
            Err(e) => {
                log::warn!(
                    target: "toptopduck::mcp",
                    "MCP server {} connect failed, skipping: {e}",
                    config.id
                );
                return;
            }
        };
        let tools = match client.list_tools() {
            Ok(t) => t,
            Err(e) => {
                log::warn!(
                    target: "toptopduck::mcp",
                    "MCP server {} tools/list failed, skipping server: {e}",
                    config.id
                );
                // Dropping `client` kills the spawned child (StdioClient::drop);
                // a server whose tools/list is broken contributes nothing to the
                // merged table, so it is not kept around for the turn (matching
                // the connect-failure skip above).
                return;
            }
        };
        let base = slugify(&config.display_name, &config.id);
        let slug = self.unique_slug(&base);
        self.servers.push(AggregatedServer {
            slug,
            client,
            tools,
        });
    }

    /// Spawn + initialize every configured server (issue #301 slice C-gw). Each
    /// server's secret env values are read from the keychain at spawn
    /// ([`get_mcp_secret`], ADR-0029 -- the value never crosses IPC) and passed
    /// to [`Self::connect_one`] alongside the config's non-secret
    /// [`env`](McpServerConfig::env). A server that fails to connect is logged
    /// and skipped via [`Self::connect_one`] -- a misconfigured server does
    /// not brick the turn.
    pub fn connect_all(&mut self, servers: &[McpServerConfig], keychain: &KeychainStore) {
        for server in servers {
            let secrets = collect_secrets(keychain, server);
            self.connect_one(server, &secrets);
        }
    }

    /// The merged, namespaced tool entries to advertise alongside the built-in
    /// table. Each entry is the server's own `{name, description, inputSchema}`
    /// shape with `name` rewritten to `mcp__<slug>__<tool>`.
    pub fn aggregated_tools(&self) -> Vec<Value> {
        self.servers
            .iter()
            .flat_map(|s| namespace_tool_entries(&s.slug, &s.tools).into_iter())
            .collect()
    }

    /// Route a `tools/call` whose name is `mcp__<slug>__<tool>` to the matching
    /// server, stripping the prefix so the server sees its native tool name.
    /// Returns the server's tools/call result for the gateway to relay.
    pub fn route(&mut self, namespaced: &str, arguments: &Value) -> Result<Value, RouteError> {
        let (slug, tool) = parse_namespaced(namespaced)
            .ok_or_else(|| RouteError::NotNamespaced(namespaced.to_string()))?;
        let server = self
            .servers
            .iter_mut()
            .find(|s| s.slug == slug)
            .ok_or(RouteError::UnknownServer(slug))?;
        server
            .client
            .call(&tool, arguments)
            .map_err(RouteError::Client)
    }

    /// Resolve a display-name slug collision by appending `_2`, `_3`, ... With
    /// per-turn construction + uuid-stable ids, a collision means two servers
    /// share a display-name slug; the second gets the suffix so both stay
    /// routable. The first occurrence keeps the bare slug.
    fn unique_slug(&self, base: &str) -> String {
        if !self.servers.iter().any(|s| s.slug == base) {
            return base.to_string();
        }
        let mut n = 2;
        loop {
            let candidate = format!("{base}_{n}");
            if !self.servers.iter().any(|s| s.slug == candidate) {
                return candidate;
            }
            n += 1;
        }
    }
}

impl Default for McpAggregator {
    fn default() -> Self {
        Self::empty()
    }
}

/// Read every secret env value for one server from the keychain (ADR-0029). A
/// missing entry contributes nothing; a keychain read error for one env key is
/// logged + skipped so a single OS keychain fault does not brick the whole
/// server (the server may still operate without that secret, and bricking it
/// would let an OS keychain glitch take down the whole tool table).
fn collect_secrets(keychain: &KeychainStore, server: &McpServerConfig) -> Vec<SecretEnv> {
    server
        .keychain_env_keys
        .iter()
        .filter_map(
            |env_key| match get_mcp_secret(keychain, &server.id, env_key) {
                Ok(Some(value)) => Some((env_key.clone(), value)),
                Ok(None) => None,
                Err(e) => {
                    log::warn!(
                        target: "toptopduck::mcp",
                        "MCP server {} keychain read for {} failed, skipping secret: {e}",
                        server.id,
                        env_key
                    );
                    None
                }
            },
        )
        .collect()
}

/// Build the server slug for a configured server (ADR-0076). ASCII
/// alphanumerics are lowercased; whitespace / `_` / `-` collapse to a single
/// `_` separator; other characters (including non-ASCII in a CJK display name)
/// are dropped. A result that trims empty (an all-non-ASCII or empty display
/// name) falls back to `server-<id8>` (the id's first 8 chars -- a uuid v4
/// simple form at mint time, plenty unique within a turn).
pub fn slugify(display_name: &str, id: &McpServerId) -> String {
    let raw: String = display_name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c.is_whitespace() || c == '_' || c == '-' {
                Some('_')
            } else {
                None
            }
        })
        .collect();
    let slug: String = raw
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_");
    if slug.is_empty() {
        let id8: String = id.as_str().chars().take(8).collect();
        format!("server-{id8}")
    } else {
        slug
    }
}

/// Compose the gateway-advertised name for one server-native tool:
/// `mcp__<server_slug>__<tool>`.
pub fn namespaced_name(slug: &str, tool: &str) -> String {
    format!("{NAMESPACED_PREFIX}{slug}{NAMESPACED_SEP}{tool}")
}

/// Parse a gateway-advertised name back into `(server_slug, server-native
/// tool)`. Returns `None` if the name is not a namespaced MCP tool (the
/// built-in tools, or a stray name) -- the gateway treats those as built-in
/// dispatch candidates.
pub fn parse_namespaced(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix(NAMESPACED_PREFIX)?;
    let mut parts = rest.splitn(2, NAMESPACED_SEP);
    let slug = parts.next()?.to_string();
    let tool = parts.next()?.to_string();
    if slug.is_empty() || tool.is_empty() {
        return None;
    }
    Some((slug, tool))
}

/// Rewrite each tool entry's `name` to its namespaced form. The entries are
/// the server's raw `tools/list` shape (cloned); only `name` is rewritten so
/// `description` / `inputSchema` ride verbatim. An entry missing a string
/// `name` is passed through unchanged (a malformed server entry the gateway
/// surfaces honestly rather than silently dropping).
pub fn namespace_tool_entries(slug: &str, tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            let mut entry = t.clone();
            if let Some(name) = entry.get("name").and_then(Value::as_str) {
                entry["name"] = Value::String(namespaced_name(slug, name));
            }
            entry
        })
        .collect()
}

/// Extract the first text block from a standard MCP `tools/call` envelope
/// (ADR-0076, issue #301). Both runtimes reduce the envelope to a flat string
/// via this helper, but in different roles whose asymmetry is deliberate:
/// - The gateway uses it for the turn **trace excerpt** only; the full
///   envelope is relayed to the model VERBATIM (structured content blocks
///   preserved -- see `external_call_outcome` in `runtime::gateway::server`).
/// - The built-in agent loop uses it for the **model-facing
///   `ToolResult.content` itself**, which is a flat `String` on that path, so
///   a multi-block or non-text result reduces to its first text block.
///
/// A non-text or empty result falls back to a placeholder rather than
/// serializing the whole envelope (the model would otherwise have to parse
/// JSON out of a flat string; the trace excerpt would re-introduce the
/// double-encoding the gateway's verbatim relay avoids).
pub fn first_text_block(envelope: &Value) -> String {
    envelope
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|b| {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    b.get("text").and_then(Value::as_str).map(str::to_string)
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| "<non-text MCP result>".to_string())
}

/// A routing failure: the name was not namespaced, the slug did not match a
/// connected server, or the server's call returned an error.
#[derive(Debug, thiserror::Error)]
pub enum RouteError {
    #[error("not a namespaced mcp__<slug>__<tool> name: {0}")]
    NotNamespaced(String),
    #[error("no enabled MCP server with slug `{0}`")]
    UnknownServer(String),
    #[error("server call failed: {0}")]
    Client(#[from] ClientError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // --- slugify -------------------------------------------------------------

    #[test]
    fn slugify_lowercases_ascii_alphanumerics() {
        let id = McpServerId("a1b2c3d4e5f6".into());
        assert_eq!(slugify("GitHub", &id), "github");
        assert_eq!(slugify("My MCP Server", &id), "my_mcp_server");
    }

    #[test]
    fn slugify_collapses_separators() {
        // Whitespace / _ / - all collapse to a single _; runs merge into one.
        let id = McpServerId("id".into());
        assert_eq!(slugify("a  b--c", &id), "a_b_c");
        assert_eq!(slugify("-leading", &id), "leading");
        assert_eq!(slugify("trailing_", &id), "trailing");
    }

    #[test]
    fn slugify_drops_non_ascii_then_falls_back_to_server_id8() {
        // A CJK-only display name drops every char -> empty -> server-<id8>.
        let id = McpServerId("a1b2c3d4e5f6g7h8".into());
        assert_eq!(slugify("数据源", &id), "server-a1b2c3d4");
        assert_eq!(slugify("", &id), "server-a1b2c3d4");
    }

    #[test]
    fn slugify_keeps_ascii_in_a_mixed_name() {
        let id = McpServerId("id".into());
        assert_eq!(slugify("GitHub 数据源", &id), "github");
    }

    // --- namespaced name round-trip -----------------------------------------

    #[test]
    fn namespaced_name_round_trips_via_parse() {
        let name = namespaced_name("github", "search");
        assert_eq!(name, "mcp__github__search");
        assert_eq!(
            parse_namespaced(&name),
            Some(("github".into(), "search".into()))
        );
    }

    #[test]
    fn parse_returns_none_for_bare_names() {
        // Built-in tools + stray names are not namespaced -- the gateway treats
        // them as built-in dispatch candidates.
        assert_eq!(parse_namespaced("explore"), None);
        assert_eq!(parse_namespaced("materialize"), None);
        assert_eq!(parse_namespaced(""), None);
    }

    #[test]
    fn parse_returns_none_for_empty_slug_or_tool() {
        assert_eq!(parse_namespaced("mcp___search"), None);
        assert_eq!(parse_namespaced("mcp__github__"), None);
    }

    #[test]
    fn namespaced_separator_only_splits_once_at_first_double_underscore() {
        // A server-native tool name that itself contains `__` must survive:
        // splitn(2) keeps the tail verbatim so the server sees its real name.
        let name = namespaced_name("github", "repo__search");
        assert_eq!(name, "mcp__github__repo__search");
        assert_eq!(
            parse_namespaced(&name),
            Some(("github".into(), "repo__search".into()))
        );
    }

    // --- namespace_tool_entries ---------------------------------------------

    #[test]
    fn namespace_tool_entries_rewrites_name_only() {
        let tools = vec![
            json!({"name": "search", "description": "search docs", "inputSchema": {"type": "object"}}),
            json!({"name": "fetch", "description": "fetch a url"}),
        ];
        let out = namespace_tool_entries("github", &tools);
        assert_eq!(out[0]["name"], "mcp__github__search");
        assert_eq!(out[0]["description"], "search docs");
        assert_eq!(out[0]["inputSchema"]["type"], "object");
        assert_eq!(out[1]["name"], "mcp__github__fetch");
        assert_eq!(out[1]["description"], "fetch a url");
    }

    #[test]
    fn namespace_tool_entries_passes_through_missing_name() {
        // A malformed entry (no string name) is passed through unchanged --
        // the gateway surfaces it honestly rather than silently dropping it.
        let tools = vec![json!({"description": "no name here"})];
        let out = namespace_tool_entries("github", &tools);
        assert_eq!(out.len(), 1);
        assert!(out[0].get("name").is_none());
    }

    // --- first_text_block ----------------------------------------------------

    /// `first_text_block` reads the first `type: text` block from an MCP
    /// tools/call envelope (ADR-0076, issue #301): a single text block wins,
    /// a leading non-text block is skipped to the first text block, and a
    /// non-text / empty result falls back to a placeholder (never a JSON dump
    /// of the envelope). Shared by the gateway (trace excerpt) and the
    /// built-in agent loop (flat model-facing content).
    #[test]
    fn first_text_block_reads_first_text_and_falls_back() {
        // Single text block -> that text.
        let single = json!({
            "content": [{"type": "text", "text": "5"}],
            "isError": false,
        });
        assert_eq!(first_text_block(&single), "5");

        // Multiple blocks -> first text block wins (a leading image is
        // skipped; later text blocks are ignored).
        let multi = json!({
            "content": [
                {"type": "image", "data": "..."},
                {"type": "text", "text": "first text"},
                {"type": "text", "text": "second text"},
            ],
            "isError": false,
        });
        assert_eq!(first_text_block(&multi), "first text");

        // No text block -> placeholder, NOT a JSON dump of the envelope.
        let nontext = json!({
            "content": [{"type": "image", "data": "..."}],
            "isError": false,
        });
        assert_eq!(first_text_block(&nontext), "<non-text MCP result>");

        // Empty content array -> placeholder.
        let empty = json!({"content": [], "isError": false});
        assert_eq!(first_text_block(&empty), "<non-text MCP result>");
    }

    // --- aggregator merged-table shape --------------------------------------

    #[test]
    fn empty_aggregator_advertises_no_tools() {
        let agg = McpAggregator::empty();
        assert!(agg.aggregated_tools().is_empty());
    }

    #[test]
    fn aggregator_default_is_empty() {
        let agg = McpAggregator::default();
        assert!(agg.servers.is_empty());
        assert!(agg.aggregated_tools().is_empty());
    }

    // --- route error branches (no spawn; empty aggregator) ------------------

    #[test]
    fn route_rejects_a_non_namespaced_name() {
        // A built-in tool name (or any bare name) is not the gateway's job to
        // route here -- the gateway dispatches it as a built-in before ever
        // calling route(). route() surfaces the shape mismatch so a programming
        // error (calling route() on a bare name) fails loudly, not silently.
        let mut agg = McpAggregator::empty();
        let err = agg.route("explore", &json!({})).expect_err("bare name");
        assert!(
            matches!(err, RouteError::NotNamespaced(_)),
            "bare name -> NotNamespaced, got {err:?}"
        );
    }

    #[test]
    fn route_rejects_a_namespaced_shape_with_no_matching_slug() {
        // A well-formed namespaced name but a slug no connected server owns --
        // the gateway surfaces this as a tool-level error (ADR-0077) rather
        // than silently dropping the call.
        let mut agg = McpAggregator::empty();
        let err = agg
            .route("mcp__ghost__echo", &json!({}))
            .expect_err("unknown slug");
        assert!(
            matches!(err, RouteError::UnknownServer(ref s) if s == "ghost"),
            "unknown slug -> UnknownServer(\"ghost\"), got {err:?}"
        );
    }
}
