// User-configured external MCP server types (ADR-0076, issue #301). Mirrors
// the Rust crate::mcp::config model. A server's SECRET env values (API tokens,
// passwords) live separately in the OS keychain under mcp-<id>-<env_key>
// (ADR-0029); this model carries NON-SECRET env values only -- the key never
// enters app-config (structural + read-time scan, ADR-0029/0036/0038).

// The MCP transport for a configured server. Internally tagged on `type` with
// snake_case variant names, mirroring the Rust McpTransport serde shape
// (crate::mcp::config). stdio = the app spawns `command` with `args` and speaks
// newline-delimited JSON-RPC over the child's stdin/stdout; sse / http carry a
// single endpoint url.
export type McpTransport =
  | { type: "stdio"; command: string; args: string[] }
  | { type: "sse"; url: string }
  | { type: "http"; url: string };

// One user-configured MCP server (ADR-0076, issue #301). The connection
// descriptor (`transport`) plus NON-SECRET env values (`env`). `id` is the
// stable identity (Rust mints a uuid v4 on upsert when the frontend sends an
// empty id); `display_name` is the renamable UI label (Rust fills it from the
// id when empty). Mirrors the Rust McpServerConfig.
export interface McpServerConfig {
  // Stable identity (minted once, never mutated); also the keychain account
  // suffix anchor. Empty when the frontend creates a new server -- Rust mints
  // the id and returns the finalized config.
  id: string;
  // Renamable display label (ADR-0037 display half).
  display_name: string;
  // How the gateway connects to the server.
  transport: McpTransport;
  // NON-SECRET env values the gateway passes at spawn (e.g. LOG_LEVEL=info). A
  // key matching the secret-name scan is refused at config read time; such a
  // value MUST live in the OS keychain. Mirrors Rust BTreeMap (deterministic
  // serialization).
  env: Record<string, string>;
  // The env_key names whose VALUES live in the OS keychain (issue #301,
  // ADR-0029). The gateway reads each via get_mcp_secret at spawn time and
  // injects it into the child env alongside `env`; the values NEVER cross
  // config (structural + read-time scan). Mirrors Rust `Vec<String>` + bare
  // serde(default) -- empty serializes as [] (the project convention), so
  // this field is `string[]`, NOT optional.
  keychain_env_keys: string[];
  // Per-server call timeout in milliseconds (ADR-0076, issue #301). `null` =
  // the gateway's default timeout applies (the gateway client lands in a later
  // slice); a number overrides per server. Mirrors Rust `Option<u32>` + bare
  // serde(default) -- None serializes as JSON null (the project convention,
  // same shape as AppConfig.last_dir), so this field is `number | null`, NOT
  // optional. The gateway enforces the value at connect / call time.
  timeout_ms: number | null;
}

// The user-configured MCP server registry carried by AppConfig.mcp_servers
// (issue #301). Mirrors the Rust McpServerRegistry: insertion-ordered server
// list, unique-id invariant enforced server-side on every write.
export interface McpServerRegistry {
  servers: McpServerConfig[];
}

// The enablement source for a server in this session (issue #369). Mirrors
// the Rust McpEnabledSource adjacently-tagged enum (snake_case variants).
// Distinguishes user-toggled from skill-declared so the "+" panel renders
// three states: off (null) / on-user (can toggle off) / on-skill (read-only,
// labeled "via skill <name>").
export type McpEnabledSource =
  | { kind: "user" }
  | { kind: "skill"; name: string };

// One tool entry a connected server advertised, projected to just the fields
// the UI needs (issue #387). Mirrors the Rust McpToolInfo -- the server-native
// name (no namespace prefix) + human-readable description.
export interface McpToolInfo {
  // The server-native tool name (no `mcp__<slug>__` prefix).
  name: string;
  // The human-readable description the server reported ("" when omitted).
  description: string;
}

// One row of the per-session MCP server status (issue #301 slice D, AC#3 +
// #369 skill sources). Mirrors the Rust McpServerStatusEntry joined at the
// command boundary from the app-config registry + the session's effective
// enablement set (user ∪ skill-declared ∩ configured) + the last turn's
// connect cache. list_mcp_server_status returns one entry per CONFIGURED
// server, enabled or not.
export interface McpServerStatusEntry {
  // The server's stable id (matches McpServerConfig.id).
  id: string;
  // The renamable display label.
  display_name: string;
  // Whether THIS session has the server in the EFFECTIVE enabled set -- user
  // OR skill (issue #369). false when neither source enabled it.
  enabled: boolean;
  // The enablement source (issue #369): null when disabled, { kind: "user" }
  // when user-toggled, { kind: "skill", name } when skill-declared. When both
  // sources enable the same server, skill takes priority (v1 read-only).
  source: McpEnabledSource | null;
  // Whether the last turn's connect succeeded for this server (false when
  // enabled-but-failed or not connected yet this session).
  connected: boolean;
  // The tool count the server advertised at the last connect (0 when not
  // connected).
  tool_count: number;
  // The tool list the server advertised at the last connect (empty when not
  // connected). The settings page renders this in the expandable per-row
  // detail (issue #387).
  tools: McpToolInfo[];
  // The last connect's error message (null on success or when not attempted).
  error: string | null;
}

// The result of a manual connection probe (issue #387). Mirrors the Rust
// McpProbeResult. The settings page's per-row Test button triggers
// probe_mcp_server and receives this.
export interface McpProbeResult {
  // Whether the spawn + initialize + tools/list cycle succeeded.
  connected: boolean;
  // The tools the server advertised (empty when not connected).
  tools: McpToolInfo[];
  // The error message when connected is false (null on success).
  error: string | null;
}

// The external source to import MCP servers from (issue #390). Mirrors the
// Rust ImportSource enum (serde rename = snake_case string over IPC).
export type ImportSource = "claude_desktop" | "codex";

// One server discovered in an external config (issue #390). Mirrors the Rust
// DiscoveredServer. A subset of McpServerConfig without `id` (empty -- Rust
// mints a uuid on upsert) or `timeout_ms` (defaults to null). The import
// checklist renders these; the user selects entries to batch-upsert.
export interface DiscoveredServer {
  display_name: string;
  transport: McpTransport;
  env: Record<string, string>;
  keychain_env_keys: string[];
}

// Result of discovering servers from one external source (issue #390). Includes
// the resolved config file path so the import dialog can display it.
export interface DiscoveryResult {
  servers: DiscoveredServer[];
  config_path: string | null;
}
