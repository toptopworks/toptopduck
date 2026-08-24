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
  // Machine-level persistent enablement (ADR-0106). Enabled = the server
  // enters every session's effective tool surface; disabled = dormant (no
  // connect, no spawn, no keychain secret read, no catalog entry). Mirrors
  // Rust `bool` + serde(default = true) -- Rust always serializes the field,
  // so it is `boolean`, NOT optional. The settings row toggle writes it via
  // upsertMcpServer; the edit form preserves the existing value, new/import
  // entries default true.
  enabled: boolean;
}

// Placeholder `enabled` for parsed / drafted configs (ADR-0106): neither JSON
// mode nor the form edits enablement -- the settings row toggle owns the
// field -- so parsers and the form's draft builder carry this constant and
// the form's save overwrites it with the server's current value (an edit
// never re-arms a disabled server). New / imported entries land enabled as
// explicit intent (Decision 4), not via this placeholder.
export const MCP_ENABLED_PLACEHOLDER = true;

// The user-configured MCP server registry carried by AppConfig.mcp_servers
// (issue #301). Mirrors the Rust McpServerRegistry: insertion-ordered server
// list, unique-id invariant enforced server-side on every write.
export interface McpServerRegistry {
  servers: McpServerConfig[];
}

// One tool entry a connected server advertised, projected to just the fields
// the UI needs (issue #387). Mirrors the Rust McpToolInfo -- the server-native
// name (no namespace prefix) + human-readable description.
export interface McpToolInfo {
  // The server-native tool name (no `mcp__<slug>__` prefix).
  name: string;
  // The human-readable description the server reported ("" when omitted).
  description: string;
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
// mints a uuid on upsert), `timeout_ms` (defaults to null), or `enabled`
// (the import lands enabled, ADR-0106 Decision 4). The import
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
