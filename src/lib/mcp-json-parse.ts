// Normalize common MCP server JSON formats from the web into a single
// McpServerDraft for the server form's JSON mode.
//
// Supported input shapes (single-server form takes the FIRST entry):
// 1. {"mcpServers": {"name": {command, args, env}}}  — Claude Desktop format
// 2. {"name": {command, args, env}}                   — bare server map
// 3. {transport: {type, ...}, display_name, env, ...} — our internal format (passthrough)
//
// Transport detection per entry:
// - "command" present → stdio (args optional, coerced to string[])
// - "url" present     → type from optional "type" field (default "http")
// - "transport" present → assumed to be our internal McpTransport shape

import {
  type McpServerDraft,
  type McpTransport,
} from "../types/mcp";

// --- Secret detection (mirrors Rust) -----------------------------------------
// Mirrors SECRET_KEY_NAMES in src-tauri/src/app_config/io.rs.
export const SECRET_NAME_SUBSTRINGS = [
  "api_key",
  "apikey",
  "anthropic_api_key",
  "anthropic-key",
  "secret",
  "password",
  "credential",
  "access_token",
  "refresh_token",
];

// Mirrors IMPORT_SECRET_SUBSTRINGS in src-tauri/src/mcp/import.rs, plus
// "authorization"/"cookie"/"session" for HTTP request headers (not in the
// Rust import set because the Rust import path only handles stdio env vars;
// the Rust read-time header scan carries the same additions).
export const IMPORT_SECRET_SUBSTRINGS = [
  "token",
  "bearer",
  "jwt",
  "privatekey",
  "authorization",
  "cookie",
  "session",
];

function collapseName(name: string): string {
  return name
    .split("")
    .filter((c) => /[a-zA-Z0-9]/.test(c))
    .join("")
    .toLowerCase();
}

/** Whether an env key name likely holds a secret. Mirrors the combined logic of
 *  is_secret_name + is_secret_env_key in the Rust import path. */
export function isSecretEnvKey(name: string): boolean {
  const collapsed = collapseName(name);
  if (SECRET_NAME_SUBSTRINGS.some((s) => collapsed.includes(collapseName(s)))) {
    return true;
  }
  return IMPORT_SECRET_SUBSTRINGS.some((s) => collapsed.includes(s));
}

// --- Normalizer --------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Type guard: validates that an unknown value is a well-formed McpTransport
 *  (per-variant fields checked: stdio needs string command + string[] args;
 *  sse/http needs string url +, when present, a record-valued `headers` -- a
 *  config written before the field existed carries none and fills empty). */
function isMcpTransport(v: unknown): v is McpTransport {
  if (!isRecord(v) || typeof v.type !== "string") return false;
  if (v.type === "stdio") {
    return (
      typeof v.command === "string" &&
      Array.isArray(v.args) &&
      v.args.every((a) => typeof a === "string")
    );
  }
  if (v.type === "sse" || v.type === "http") {
    return typeof v.url === "string" && (v.headers === undefined || isRecord(v.headers));
  }
  return false;
}

/** Fill a remote transport's `headers` when absent (issue #901): a config
 *  written before the field existed parses without it; the draft carries the
 *  empty map so downstream spread/merge stays total. */
function withDefaultHeaders(t: McpTransport): McpTransport {
  if (t.type === "stdio" || t.headers !== undefined) return t;
  return { ...t, headers: {} };
}

/** Whether a parsed object already matches our internal McpServerConfig shape
 *  (has a well-formed `transport` with per-variant fields validated). */
function isInternalConfig(
  v: unknown,
): v is { transport: McpTransport } & Record<string, unknown> {
  return isRecord(v) && isMcpTransport(v.transport);
}

/** Normalize a parsed JSON value into a McpServerDraft (no `enabled` — the
 *  form's save owns that field; ADR-0106 / #659). Throws on invalid input
 *  or a server entry missing command/url. For map formats, the FIRST entry
 *  is used (the form is single-server). */
export function normalizeJsonToConfig(
  raw: unknown,
  fallbackId: string,
): McpServerDraft {
  if (!isRecord(raw)) {
    throw new Error("Expected a JSON object");
  }

  // Already our internal format — passthrough (fills defaults for missing
  // optional fields so the form renders correctly).
  if (isInternalConfig(raw)) {
    return {
      id: typeof raw.id === "string" ? raw.id : fallbackId,
      display_name:
        typeof raw.display_name === "string" ? raw.display_name : "",
      transport: withDefaultHeaders(raw.transport),
      env: isRecord(raw.env) ? stringifyRecord(raw.env) : {},
      keychain_env_keys: Array.isArray(raw.keychain_env_keys)
        ? raw.keychain_env_keys.filter(
            (x): x is string => typeof x === "string",
          )
        : [],
      keychain_header_keys: Array.isArray(raw.keychain_header_keys)
        ? raw.keychain_header_keys.filter(
            (x): x is string => typeof x === "string",
          )
        : [],
      // A JSON `enabled` field is intentionally ignored (neither form mode
      // edits enablement); the draft carries no `enabled` at all.
      timeout_ms: typeof raw.timeout_ms === "number" ? raw.timeout_ms : null,
    };
  }

  // Unwrap {"mcpServers": {...}} (Claude Desktop format); otherwise treat the
  // root as a bare {name: config} map.
  const serverMap =
    "mcpServers" in raw && isRecord(raw.mcpServers) ? raw.mcpServers : raw;

  const entries = Object.entries(serverMap).filter(([, v]) => isRecord(v));
  if (entries.length === 0) {
    throw new Error("No servers found in JSON");
  }

  // Take the first entry (the form is single-server).
  const [name, config] = entries[0] as [string, Record<string, unknown>];
  return buildConfigFromFlat(name, config, fallbackId);
}

/** Build a McpServerDraft from a flat web-format server entry
 *  ({command, args, env, url, type, headers}). For stdio the key-value map
 *  field is "env" and lands on the env face; for http/sse it is "headers"
 *  (with "env" as a non-standard fallback spelling) and lands on the
 *  transport's header face + keychain_header_keys (issue #901) -- secret
 *  detection is the same isSecretEnvKey scan either way. */
function buildConfigFromFlat(
  name: string,
  config: Record<string, unknown>,
  fallbackId: string,
): McpServerDraft {
  const transport = parseTransport(name, config);

  // stdio → "env"; http/sse → "headers" (with "env" fallback for non-standard
  // formats that put headers under "env").
  const kvSource =
    transport.type === "stdio" ? config.env : (config.headers ?? config.env);
  const rawKv = isRecord(kvSource) ? kvSource : {};
  const plain: Record<string, string> = {};
  const secretKeys: string[] = [];

  for (const [key, rawValue] of Object.entries(rawKv)) {
    const value =
      typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    if (isSecretEnvKey(key)) {
      // Route to keychain; value is dropped (same as the Rust import path).
      // The user re-enters the value via the form's Secret checkbox.
      secretKeys.push(key);
    } else {
      plain[key] = value;
    }
  }

  const timeout_ms =
    typeof config.timeout_ms === "number" ? config.timeout_ms : null;

  if (transport.type === "stdio") {
    return {
      id: fallbackId,
      display_name: name,
      transport,
      env: plain,
      keychain_env_keys: secretKeys,
      keychain_header_keys: [],
      timeout_ms,
    };
  }
  // Remote: the whole key-value run is the header face. The env face stays
  // empty -- a remote row's env entries are dormant (issue #901: kept on
  // existing configs, never created here, invisible in the editors).
  return {
    id: fallbackId,
    display_name: name,
    transport: { ...transport, headers: plain },
    env: {},
    keychain_env_keys: [],
    keychain_header_keys: secretKeys,
    timeout_ms,
  };
}

/** Determine the McpTransport from raw config fields. */
function parseTransport(
  name: string,
  config: Record<string, unknown>,
): McpTransport {
  if (typeof config.command === "string") {
    return {
      type: "stdio",
      command: config.command,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
    };
  }
  if (typeof config.url === "string") {
    const rawType = typeof config.type === "string" ? config.type : "http";
    const type = rawType === "sse" ? "sse" : "http";
    return { type, url: config.url, headers: {} };
  }
  throw new Error(`Server "${name}" has no "command" or "url" field`);
}

function stringifyRecord(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = typeof v === "string" ? v : String(v ?? "");
  }
  return out;
}

// --- Serializer (inverse of normalizeJsonToConfig for single server) ---------

/** Serialize a config (draft or full) into the common web-format JSON (bare
 *  server map). The inverse of normalizeJsonToConfig for the single-server
 *  case.
 *
 *  Secret env/header keys are included with empty values — the actual values
 *  live in the OS keychain, never in JSON. On parse-back, normalizeJsonToConfig
 *  routes them to keychain_env_keys / keychain_header_keys automatically. A
 *  remote row's dormant env entries are NOT serialized (issue #901: invisible
 *  in every user-facing surface; the form preserves them out-of-band). */
export function configToWebJson(config: McpServerDraft): string {
  const entry: Record<string, unknown> = {};

  if (config.transport.type === "stdio") {
    entry.type = "stdio";
    entry.command = config.transport.command;
    entry.args = config.transport.args;

    // Merge non-secret env values + secret key names (values blanked).
    const kv: Record<string, string> = { ...config.env };
    for (const key of config.keychain_env_keys) {
      kv[key] = "";
    }
    if (Object.keys(kv).length > 0) {
      entry.env = kv;
    }
  } else {
    entry.type = config.transport.type;
    entry.url = config.transport.url;

    // The header face: non-secret transport headers + secret key names
    // (values blanked), under the common web-format "headers" field.
    const kv: Record<string, string> = { ...config.transport.headers };
    for (const key of config.keychain_header_keys) {
      kv[key] = "";
    }
    if (Object.keys(kv).length > 0) {
      entry.headers = kv;
    }
  }

  if (config.timeout_ms !== null) {
    entry.timeout_ms = config.timeout_ms;
  }

  const name = config.display_name || "my-mcp-server";
  return JSON.stringify({ [name]: entry }, null, 2);
}
