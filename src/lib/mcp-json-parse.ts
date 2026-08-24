// Normalize common MCP server JSON formats from the web into a single
// McpServerConfig for the server form's JSON mode.
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
const SECRET_NAME_SUBSTRINGS = [
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
// "authorization" for HTTP request headers (not in the Rust set because the
// Rust import path only handles stdio env vars).
const IMPORT_SECRET_SUBSTRINGS = [
  "token",
  "bearer",
  "jwt",
  "privatekey",
  "authorization",
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
 *  sse/http needs string url). */
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
    return typeof v.url === "string";
  }
  return false;
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
      transport: raw.transport,
      env: isRecord(raw.env) ? stringifyRecord(raw.env) : {},
      keychain_env_keys: Array.isArray(raw.keychain_env_keys)
        ? raw.keychain_env_keys.filter(
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

/** Build a McpServerConfig from a flat web-format server entry
 *  ({command, args, env, url, type, headers}). For http/sse the key-value map
 *  field is "headers" (request headers); for stdio it is "env". */
function buildConfigFromFlat(
  name: string,
  config: Record<string, unknown>,
  fallbackId: string,
): McpServerDraft {
  const transport = parseTransport(name, config);

  // stdio → "env"; http/sse → "headers" (with "env" fallback for non-standard
  // formats that put headers under "env").
  const envSource =
    transport.type === "stdio" ? config.env : (config.headers ?? config.env);
  const rawEnv = isRecord(envSource) ? envSource : {};
  const env: Record<string, string> = {};
  const keychain_env_keys: string[] = [];

  for (const [key, rawValue] of Object.entries(rawEnv)) {
    const value =
      typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    if (isSecretEnvKey(key)) {
      // Route to keychain; value is dropped (same as the Rust import path).
      // The user re-enters the value via the form's Secret checkbox.
      keychain_env_keys.push(key);
    } else {
      env[key] = value;
    }
  }

  return {
    id: fallbackId,
    display_name: name,
    transport,
    env,
    keychain_env_keys,
    timeout_ms:
      typeof config.timeout_ms === "number" ? config.timeout_ms : null,
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
    return { type, url: config.url };
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
 *  routes them to keychain_env_keys automatically. */
export function configToWebJson(config: McpServerDraft): string {
  const entry: Record<string, unknown> = {};

  const isStdio = config.transport.type === "stdio";
  if (config.transport.type === "stdio") {
    entry.type = "stdio";
    entry.command = config.transport.command;
    entry.args = config.transport.args;
  } else {
    entry.type = config.transport.type;
    entry.url = config.transport.url;
  }

  // Merge non-secret values + secret key names (values blanked).
  const kv: Record<string, string> = { ...config.env };
  for (const key of config.keychain_env_keys) {
    kv[key] = "";
  }
  if (Object.keys(kv).length > 0) {
    // stdio → "env"; http/sse → "headers" (matches common web format).
    entry[isStdio ? "env" : "headers"] = kv;
  }

  if (config.timeout_ms !== null) {
    entry.timeout_ms = config.timeout_ms;
  }

  const name = config.display_name || "my-mcp-server";
  return JSON.stringify({ [name]: entry }, null, 2);
}
