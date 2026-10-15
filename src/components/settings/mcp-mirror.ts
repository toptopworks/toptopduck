// Pure mirror-list helpers for the MCP settings pane (#659). Split out of the
// component file so the component module only exports components
// (react-refresh) and the list semantics stay testable in isolation.

import type { AppConfig } from "../../types/app-config";
import type { McpServerConfig } from "../../types/mcp";

/** Commit shape shared by every write path in the pane: rebuild the MCP
 *  server list inside an AppConfig immutably. Callers pass the already
 *  rebuilt slice (upsertMirror preserves row order for toggle / save /
 *  import; delete rebuilds via filter). */
export function withMcpServers(
  cfg: AppConfig,
  servers: McpServerConfig[],
): AppConfig {
  return { ...cfg, mcp_servers: { ...cfg.mcp_servers, servers } };
}

/** Upsert one server into a mirror list preserving row order: an existing id
 *  replaces in place, a new id appends — the same semantics as the backend
 *  registry's upsert, so the React mirror never reorders rows the disk kept
 *  in place (#659; a restart would otherwise snap the row back). */
export function upsertMirror(
  servers: McpServerConfig[],
  next: McpServerConfig,
): McpServerConfig[] {
  return servers.some((s) => s.id === next.id)
    ? servers.map((s) => (s.id === next.id ? next : s))
    : [...servers, next];
}
