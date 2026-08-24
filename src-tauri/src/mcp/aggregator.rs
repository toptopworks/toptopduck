//! The gateway's aggregator over connected external MCP servers (ADR-0076,
//! issue #301 slice C-gw).
//!
//! The gateway advertises ONE merged tool surface to the bridge / built-in
//! LLM: the built-in DuckDB tools stay direct-listed, while the external
//! servers' tools surface through the fixed meta-tool trio
//! (`mcp_list_servers` / `mcp_search_tools` / `mcp_invoke`, ADR-0105) instead
//! of a flattened per-tool advertisement. A tool call addressed by its
//! `mcp__<server_slug>__<tool>` handle is parsed here and routed to the
//! matching [`TransportClient`] (the `mcp__<slug>__` prefix is stripped --
//! the server only ever sees its own native tool name). The handle is the
//! single identity across search cards, invoke addressing, approval, and
//! trace, so same-name tools across servers stay distinct and the trace
//! filter (`mcp__` prefix) stays reliable.
//!
//! Turn-local (issue #301 Q2): the gateway constructs one `McpAggregator` per
//! turn via [`McpAggregator::connect_all`] and drops it at turn end, tearing
//! down every transport (killing stdio children, stopping SSE reader threads).
//! A failed connect (transport fault, spawn fault, tools/list error) logs +
//! skips that server rather than failing the turn -- a misconfigured server
//! must not brick the gateway. The search catalog holds only the connected
//! servers; the failed attempts stay visible through `mcp_list_servers`
//! (ADR-0105 Decision 3: no placeholder entries in the catalog).

use serde_json::Value;

use crate::mcp::client::{connect_transport, ClientError, SecretEnv, TransportClient};
use crate::mcp::config::{McpServerConfig, McpServerId};
use crate::mcp::meta_tools;
use crate::mcp::secrets::get_mcp_secret;
use crate::mcp::McpClient;
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
/// their server-native shape. The stored entries stay the raw server shape:
/// a handle is composed only when a search card is built, and routing strips
/// the prefix rather than re-deriving it. `display_name` rides alongside so
/// search cards + the server manifest name the server the way the user
/// configured it (the slug alone loses case + separators).
struct AggregatedServer {
    slug: String,
    display_name: String,
    client: TransportClient,
    tools: Vec<Value>,
}

/// One attempted connect this turn, retained for `mcp_list_servers`
/// (ADR-0105 Decision 1): the manifest shows enabled servers that FAILED to
/// connect too (with the reason), while the search catalog carries only the
/// connected ones. Derived from the [`ConnectResult`] at connect time so the
/// turn paths that discard the returned slice still surface the outcomes
/// through the discovery surface.
struct ConnectRecord {
    display_name: String,
    /// `None` when the connect failed (no slug was allocated).
    slug: Option<String>,
    tool_count: usize,
    error: Option<String>,
}

/// One configured server's per-turn connect outcome (issue #301 slice D).
/// [`McpAggregator::connect_all`] returns one per server; the turn paths
/// discard the slice (the per-session status IPC is retired, ADR-0106), so
/// the outcomes pin the aggregator's integration tests + any future
/// diagnostics. `connected: false` covers every skip path (transport connect
/// fault, spawn fault, tools/list fault) with the reason in `error`;
/// `connected: true` carries the live tool count the gateway advertised that
/// turn.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConnectResult {
    /// The server's stable id (matches [`McpServerConfig::id`]). The id is
    /// the join key back to app-config, so the display label is not carried
    /// here.
    pub id: McpServerId,
    /// Whether the server connected + its tools were listed. `false` for every
    /// skip path (the aggregator logs the detail; this is the boolean the UI
    /// badges).
    pub connected: bool,
    /// The number of tools the server advertised (0 when not connected).
    pub tool_count: usize,
    /// The tool list the server advertised at connect (empty when not
    /// connected), projected to [`McpToolInfo`].
    pub tools: Vec<McpToolInfo>,
    /// The skip reason when `connected: false` (`None` on success).
    pub error: Option<String>,
}

/// One tool entry a connected server advertised, projected to just the fields
/// the UI needs (issue #387). The full `{name, description, inputSchema}` entry
/// stays in [`AggregatedServer::tools`] for gateway routing; this is the lean
/// view for `probe_mcp_server` + the aggregator's connect outcomes.
#[derive(Debug, Clone, serde::Serialize)]
pub struct McpToolInfo {
    /// The server-native tool name (no `mcp__<slug>__` prefix -- the raw name
    /// the server reported at `tools/list`).
    pub name: String,
    /// The human-readable description the server reported (`""` when the server
    /// omitted it).
    pub description: String,
}

/// Project a raw `tools/list` entry's `{name, description}` into
/// [`McpToolInfo`]. Missing `name` skips the entry (malformed); missing
/// `description` degrades to empty string (the server may legitimately omit it).
pub fn extract_tool_info(tools: &[Value]) -> Vec<McpToolInfo> {
    tools
        .iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            let description = t
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(McpToolInfo { name, description })
        })
        .collect()
}

/// The merged view over every connected external MCP server (ADR-0076). Owns
/// the transport clients; `Drop` tears down each one (kills the child for
/// stdio, stops the reader thread for SSE, no-op for HTTP).
pub struct McpAggregator {
    servers: Vec<AggregatedServer>,
    /// Every attempted connect this turn (successes + failures), feeding
    /// `mcp_list_servers` (ADR-0105 Decision 1). The search catalog reads
    /// [`Self::servers`] instead -- only connected servers enter it.
    connect_records: Vec<ConnectRecord>,
    /// The per-session tool-output directory path (ADR-0087 Decision 3). Injected
    /// as `TOPTOPDUCK_TOOL_OUTPUT_DIR` into each stdio server's child env at
    /// spawn. `None` in tests (no file output expected).
    tool_output_dir: Option<String>,
}

impl McpAggregator {
    /// An empty aggregator (no servers connected). The gateway uses this when
    /// the user has configured no servers, or as the starting point before
    /// [`Self::connect_one`] calls. `tool_output_dir` is `None` -- use
    /// [`Self::with_tool_output`] for the production path.
    pub fn empty() -> Self {
        Self {
            servers: vec![],
            connect_records: vec![],
            tool_output_dir: None,
        }
    }

    /// Construct an empty aggregator with the session's tool-output directory
    /// set (ADR-0087 Decision 3). Each stdio server spawned via
    /// [`Self::connect_one`] / [`Self::connect_all`] receives the path as
    /// `TOPTOPDUCK_TOOL_OUTPUT_DIR` in its child env.
    pub fn with_tool_output(tool_output_dir: String) -> Self {
        Self {
            servers: vec![],
            connect_records: vec![],
            tool_output_dir: Some(tool_output_dir),
        }
    }

    /// Connect + initialize one server (any transport), list its tools, and
    /// add it under a unique slug derived from its display name (issue #301
    /// slice D + issue #389 SSE/HTTP). A failure (connect fault, tools/list
    /// fault) logs + skips the server -- the turn is not failed by a
    /// misconfigured server -- and the returned [`ConnectResult`] carries
    /// `connected: false` + the reason.
    pub fn connect_one(
        &mut self,
        config: &McpServerConfig,
        secrets: &[SecretEnv],
    ) -> ConnectResult {
        let mut client = match connect_transport(config, secrets, self.tool_output_dir.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    target: "toptopduck::mcp",
                    "MCP server {} connect failed, skipping: {e}",
                    config.id
                );
                self.connect_records.push(ConnectRecord {
                    display_name: config.display_name.clone(),
                    slug: None,
                    tool_count: 0,
                    error: Some(e.to_string()),
                });
                return ConnectResult {
                    id: config.id.clone(),
                    connected: false,
                    tool_count: 0,
                    tools: Vec::new(),
                    error: Some(e.to_string()),
                };
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
                // Dropping `client` tears down the transport (kills the child
                // for stdio, stops the reader thread for SSE, etc.);
                // a server whose tools/list is broken contributes nothing to the
                // discovery catalog, so it is not kept around for the turn
                // (matching the connect-failure skip above).
                self.connect_records.push(ConnectRecord {
                    display_name: config.display_name.clone(),
                    slug: None,
                    tool_count: 0,
                    error: Some(format!("tools/list failed: {e}")),
                });
                return ConnectResult {
                    id: config.id.clone(),
                    connected: false,
                    tool_count: 0,
                    tools: Vec::new(),
                    error: Some(format!("tools/list failed: {e}")),
                };
            }
        };
        let tool_count = tools.len();
        let tool_infos = extract_tool_info(&tools);
        let base = slugify(&config.display_name, &config.id);
        let slug = self.unique_slug(&base);
        self.connect_records.push(ConnectRecord {
            display_name: config.display_name.clone(),
            slug: Some(slug.clone()),
            tool_count,
            error: None,
        });
        self.servers.push(AggregatedServer {
            slug,
            display_name: config.display_name.clone(),
            client,
            tools,
        });
        ConnectResult {
            id: config.id.clone(),
            connected: true,
            tool_count,
            tools: tool_infos,
            error: None,
        }
    }

    /// Spawn + initialize every configured server (issue #301 slice C-gw) and
    /// return each one's [`ConnectResult`] (slice D). Each server's secret env
    /// values are read from the keychain at spawn ([`get_mcp_secret`],
    /// ADR-0029 -- the value never crosses IPC) and passed to
    /// [`Self::connect_one`] alongside the config's non-secret
    /// [`env`](McpServerConfig::env). A server that fails to connect is logged
    /// and skipped via [`Self::connect_one`] -- a misconfigured server does
    /// not brick the turn -- and surfaces as `connected: false` in the
    /// returned slice. ADR-0106 defense-in-depth: entries with
    /// `enabled: false` are skipped here outright -- the semantic axis is
    /// [`LiveProviderConfig::enabled_mcp_servers`](crate::provider::LiveProviderConfig::enabled_mcp_servers),
    /// but this guard holds the dormancy line (no connect, no spawn, no
    /// keychain read) for any caller that hands over an unfiltered registry
    /// snapshot.
    pub fn connect_all(
        &mut self,
        servers: &[McpServerConfig],
        keychain: &KeychainStore,
    ) -> Vec<ConnectResult> {
        servers
            .iter()
            .filter(|server| {
                if server.enabled {
                    true
                } else {
                    log::warn!(
                        target: "toptopduck::mcp",
                        "MCP server {} disabled at the config level (ADR-0106); skipping",
                        server.id
                    );
                    false
                }
            })
            .map(|server| {
                let secrets = collect_secrets(keychain, server);
                self.connect_one(server, &secrets)
            })
            .collect()
    }

    /// The meta-tool trio's definitions for this turn's tool surface
    /// (ADR-0105 Decision 1/6). Empty when NO enabled server was attempted
    /// this turn (a zero-enabled turn attaches no trio and pays no standing
    /// cost). The mount condition is the ATTEMPTED set, not the connected
    /// set: a turn where every enabled server failed to connect still mounts
    /// the trio so `mcp_list_servers` can surface the failure reasons
    /// (Decision 1's manifest) -- the search catalog itself stays empty.
    pub fn meta_tool_definitions(&self) -> Vec<crate::provider::tool_calling::ToolDefinition> {
        if self.connect_records.is_empty() {
            return Vec::new();
        }
        meta_tools::meta_tool_definitions()
    }

    /// Query the catalog for `mcp_search_tools` (ADR-0105 Decision 3). The
    /// catalog holds only servers that connected this turn, iterated in
    /// registry order with each server's tools in its advertised order --
    /// that iteration IS the stable sort (no relevance scoring). A card's
    /// `tool` field is the handle `mcp__<slug>__<tool>` composed here, so the
    /// card's field is byte-wise the `mcp_invoke` addressing argument. Results
    /// cap at [`SEARCH_TOP_K`](meta_tools::SEARCH_TOP_K); `total_matched`
    /// carries the pre-cap count so the agent knows to narrow the query.
    pub fn search_catalog(&self, query: &str) -> Value {
        let mut cards = Vec::new();
        let mut total_matched = 0usize;
        for server in &self.servers {
            for entry in &server.tools {
                let native = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let description = entry
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !meta_tools::matches_query(query, &server.display_name, native, description) {
                    continue;
                }
                total_matched += 1;
                if cards.len() < meta_tools::SEARCH_TOP_K {
                    let handle = namespaced_name(&server.slug, native);
                    let input_schema = entry
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
                    cards.push(meta_tools::search_card(
                        &server.display_name,
                        description,
                        &input_schema,
                        handle,
                    ));
                }
            }
        }
        serde_json::json!({ "tools": cards, "total_matched": total_matched })
    }

    /// The `mcp_list_servers` manifest (ADR-0105 Decision 1): every attempted
    /// connect this turn with its outcome, so an enabled-but-failed server is
    /// visible (with the reason) even though it never entered the catalog.
    /// The agent sees display names + outcomes only -- the slug is internal
    /// routing detail the agent never needs (the handle on a search card
    /// already encodes it).
    pub fn server_listing(&self) -> Value {
        let servers: Vec<Value> = self
            .connect_records
            .iter()
            .map(|r| {
                serde_json::json!({
                    "server": r.display_name,
                    "connected": r.slug.is_some(),
                    "tool_count": r.tool_count,
                    "error": r.error,
                })
            })
            .collect();
        serde_json::json!({ "servers": servers })
    }

    /// Resolve an `mcp_invoke` call input into `(handle, arguments)` BEFORE
    /// the enforcement points (ADR-0105 Decision 4). `Ok` means the input was
    /// well-formed AND the handle is namespaced AND its slug matches a
    /// connected server -- the dispatch site then flows the call through the
    /// regular external path under the backend identity (classify -> gate ->
    /// route -> trace all consume the handle). `Err` carries the failure for
    /// the call's error result: it surfaces as a failed tool result with no
    /// gate suspension and no trace entry -- the same semantics as a call
    /// that never reached a tool.
    pub fn resolve_invoke(&self, input: &Value) -> Result<(String, Value), String> {
        let (handle, arguments) = meta_tools::parse_invoke_input(input)?;
        match parse_namespaced(&handle) {
            None => Err(meta_tools::not_a_handle_failure(&handle)),
            Some((slug, _)) => {
                if self.servers.iter().any(|s| s.slug == slug) {
                    Ok((handle, arguments))
                } else {
                    Err(meta_tools::unknown_server_failure(&handle, &slug))
                }
            }
        }
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
pub(crate) fn collect_secrets(
    keychain: &KeychainStore,
    server: &McpServerConfig,
) -> Vec<SecretEnv> {
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
    } else if slug == crate::approval::ToolKey::BUILTIN_SERVER {
        // Reserved-name guard (issue #312): a display name that normalizes to
        // "builtin" would flow into `ToolKey::external("builtin", ...)` →
        // `is_builtin()` → `classify` returns `Allow`, bypassing the approval
        // gate. Append `_reserved` so the slug never collides with the
        // built-in server namespace. This is distinct from `unique_slug`'s
        // `_2` suffix, whose semantics is collision de-duplication.
        format!("{slug}_reserved")
    } else {
        slug
    }
}

/// Compose the gateway handle for one server-native tool:
/// `mcp__<server_slug>__<tool>`. This is a HANDLE, not an advertised name
/// (ADR-0105): the search card's `tool` field and `mcp_invoke`'s addressing
/// argument both carry this string verbatim, and routing parses it back
/// apart.
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

    #[test]
    fn slugify_appends_reserved_suffix_for_builtin_collision() {
        // Issue #312: a display name that normalizes to "builtin" must not
        // produce the reserved slug — it would bypass the approval gate via
        // `ToolKey::external("builtin", ...)`. Append `_reserved`. The guard
        // catches any input whose alphanumeric chars form "builtin"
        // (case-insensitive) — e.g. "Built.in", "Built,in" also drop to
        // "builtin" because non-alphanumeric-separator chars are discarded.
        // A separator-bearing variant like "built-in" becomes "built_in".
        let id = McpServerId("a1b2c3d4".into());
        assert_eq!(slugify("Builtin", &id), "builtin_reserved");
        assert_eq!(slugify("builtin", &id), "builtin_reserved");
        assert_eq!(slugify("BUILTIN", &id), "builtin_reserved");
        assert_eq!(slugify("builtIn", &id), "builtin_reserved");
        assert_eq!(slugify("Built.in", &id), "builtin_reserved");
    }

    #[test]
    fn slugify_strips_underscores_from_reserved_spoof_sentinel() {
        // Issue #312: RESERVED_SPOOF_SERVER ("_builtin_spoof_") has leading /
        // trailing underscores that slugify's split('_') + filter(!empty)
        // strips. No real display name can produce a slug that collides with
        // the sentinel, so routing always fails gracefully on a spoofed call.
        let id = McpServerId("a1b2c3d4".into());
        assert_eq!(
            slugify(crate::approval::ToolKey::RESERVED_SPOOF_SERVER, &id),
            "builtin_spoof"
        );
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

    // --- aggregator surface shape -------------------------------------------

    /// ADR-0105 Decision 6: a turn whose effective external set is empty
    /// mounts no trio -- the tool surface stays the built-in four only.
    #[test]
    fn empty_aggregator_attaches_no_trio() {
        let agg = McpAggregator::empty();
        assert!(agg.meta_tool_definitions().is_empty());
        assert_eq!(agg.server_listing()["servers"].as_array().unwrap().len(), 0);
        assert_eq!(agg.search_catalog("")["total_matched"], 0);
    }

    #[test]
    fn aggregator_default_is_empty() {
        let agg = McpAggregator::default();
        assert!(agg.servers.is_empty());
        assert!(agg.meta_tool_definitions().is_empty());
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

    // --- extract_tool_info (issue #387) -------------------------------------

    #[test]
    fn extract_tool_info_projects_name_and_description() {
        let tools = vec![
            json!({"name": "search", "description": "Search the web"}),
            json!({"name": "fetch", "description": "Fetch a URL"}),
        ];
        let infos = extract_tool_info(&tools);
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].name, "search");
        assert_eq!(infos[0].description, "Search the web");
        assert_eq!(infos[1].name, "fetch");
        assert_eq!(infos[1].description, "Fetch a URL");
    }

    #[test]
    fn extract_tool_info_degrades_missing_description_to_empty() {
        // A server may legitimately omit description; it degrades to "".
        let tools = vec![json!({"name": "ping"})];
        let infos = extract_tool_info(&tools);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].name, "ping");
        assert_eq!(infos[0].description, "");
    }

    #[test]
    fn extract_tool_info_skips_entries_missing_name() {
        // A malformed entry without a string name is skipped, not paniced.
        let tools = vec![
            json!({"description": "no name here"}),
            json!({"name": 42, "description": "non-string name"}),
            json!({"name": "valid", "description": "ok"}),
        ];
        let infos = extract_tool_info(&tools);
        assert_eq!(infos.len(), 1);
        assert_eq!(infos[0].name, "valid");
    }

    #[test]
    fn extract_tool_info_empty_input_returns_empty() {
        let infos: Vec<McpToolInfo> = extract_tool_info(&[]);
        assert!(infos.is_empty());
    }
}
