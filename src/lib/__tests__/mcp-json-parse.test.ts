import { describe, expect, it } from "vitest";

import type { McpServerConfig } from "../../types/mcp";
import {
  configToWebJson,
  HEADER_SECRET_SUBSTRINGS,
  isSecretEnvKey,
  normalizeJsonToConfig,
  SECRET_NAME_SUBSTRINGS,
} from "../mcp-json-parse";

describe("isSecretEnvKey", () => {
  it("detects common secret key names", () => {
    expect(isSecretEnvKey("API_KEY")).toBe(true);
    expect(isSecretEnvKey("api_key")).toBe(true);
    expect(isSecretEnvKey("PASSWORD")).toBe(true);
    expect(isSecretEnvKey("DATABASE_PASSWORD")).toBe(true);
    expect(isSecretEnvKey("ACCESS_TOKEN")).toBe(true);
    expect(isSecretEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isSecretEnvKey("BEARER_TOKEN")).toBe(true);
    expect(isSecretEnvKey("JWT_SECRET")).toBe(true);
    expect(isSecretEnvKey("PRIVATE_KEY")).toBe(true);
  });

  it("does not flag benign keys", () => {
    expect(isSecretEnvKey("LOG_LEVEL")).toBe(false);
    expect(isSecretEnvKey("NODE_PATH")).toBe(false);
    expect(isSecretEnvKey("DEBUG")).toBe(false);
    expect(isSecretEnvKey("PORT")).toBe(false);
  });

  // Drift mirror of the Rust read-time lists (issue #904): every entry of
  // BOTH lists must trip this single two-face scan. Derived from the arrays
  // themselves (no fourth hardcoded copy): the Rust-side pin holds the array
  // CONTENTS to the Rust lists entry for entry, this test holds the FUNCTION
  // to consulting every entry both lists carry.
  it("flags every entry of both secret-name lists (drift mirror)", () => {
    for (const name of [...SECRET_NAME_SUBSTRINGS, ...HEADER_SECRET_SUBSTRINGS]) {
      expect(isSecretEnvKey(name)).toBe(true);
    }
  });
});

describe("normalizeJsonToConfig", () => {
  it("normalizes Claude Desktop format {mcpServers: {...}}", () => {
    const json = {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { LOG_LEVEL: "debug" },
        },
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.display_name).toBe("filesystem");
    expect(config.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    });
    expect(config.env).toEqual({ LOG_LEVEL: "debug" });
    expect(config.keychain_env_keys).toEqual([]);
    expect(config.timeout_ms).toBeNull();
  });

  it("normalizes bare server map {name: {...}}", () => {
    const json = {
      "my-server": {
        command: "node",
        args: ["server.js"],
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.display_name).toBe("my-server");
    expect(config.transport).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });
  });

  it("takes the first entry when multiple servers are present", () => {
    const json = {
      mcpServers: {
        "first-server": { command: "cmd-a", args: [] },
        "second-server": { command: "cmd-b", args: [] },
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.display_name).toBe("first-server");
    expect(config.transport).toEqual({
      type: "stdio",
      command: "cmd-a",
      args: [],
    });
  });

  it("passes through our internal format (has transport.type)", () => {
    const json = {
      id: "srv-1",
      display_name: "existing",
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-Custom": "val" },
      },
      env: { FOO: "bar" },
      keychain_env_keys: ["SECRET_KEY"],
      keychain_header_keys: ["Authorization"],
      timeout_ms: 5000,
    };

    const config = normalizeJsonToConfig(json, "");
    // The draft carries every field EXCEPT `enabled` (the form's save owns
    // that field; #659). The remote row's env rides along DORMANT (issue
    // #901: preserved through edits, invisible in the editors).
    expect(config).toEqual({
      id: "srv-1",
      display_name: "existing",
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-Custom": "val" },
      },
      env: { FOO: "bar" },
      keychain_env_keys: ["SECRET_KEY"],
      keychain_header_keys: ["Authorization"],
      timeout_ms: 5000,
    });
  });

  it("fills an empty header map when internal format omits headers (issue #901)", () => {
    // A config written before the headers field existed has no
    // transport.headers; the passthrough fills the empty map so downstream
    // spread/merge stays total.
    const json = {
      id: "srv-1",
      display_name: "legacy",
      transport: { type: "sse", url: "https://example.com/sse" },
      env: {},
      keychain_env_keys: [],
    };
    const config = normalizeJsonToConfig(json, "");
    expect(config.transport).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      headers: {},
    });
    expect(config.keychain_header_keys).toEqual([]);
  });

  it("drops an `enabled` field in internal-format JSON (ADR-0106, #659)", () => {
    // Enablement is machine-level state owned by the settings row toggle,
    // never imported: a JSON `enabled: false` must not survive
    // normalization. The Draft shape carries no `enabled` at all, so no
    // consumer of a parsed draft can read a stale value.
    const json = {
      id: "srv-1",
      display_name: "existing",
      transport: { type: "stdio", command: "cmd-a", args: [] },
      enabled: false,
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config).not.toHaveProperty("enabled");
  });

  it("rejects internal format with malformed transport (missing command)", () => {
    // transport.type is "stdio" but command/args are missing — must NOT
    // pass through as-is (would crash downstream). Falls through to map
    // parsing where "transport" is not a valid server entry.
    const json = {
      transport: { type: "stdio" },
    };
    expect(() => normalizeJsonToConfig(json, "")).toThrow();
  });

  it("rejects internal format with invalid transport type", () => {
    const json = {
      transport: { type: "weird" },
    };
    expect(() => normalizeJsonToConfig(json, "")).toThrow();
  });

  it("detects SSE transport from type field", () => {
    const json = {
      "sse-server": {
        url: "https://example.com/sse",
        type: "sse",
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.transport).toEqual({
      type: "sse",
      url: "https://example.com/sse",
      headers: {},
    });
  });

  it("routes web-format headers onto transport.headers for http/sse servers (issue #901)", () => {
    const json = {
      "api-server": {
        type: "http",
        url: "https://example.com/mcp",
        headers: {
          "X-Custom-Header": "value",
          "Authorization": "Bearer xxx",
        },
      },
    };

    const config = normalizeJsonToConfig(json, "");
    // Non-secret values land on the transport's header face (NOT env -- the
    // pre-#901 parser wrote them to env where the http transport never read
    // them).
    expect(config.transport).toMatchObject({
      type: "http",
      headers: { "X-Custom-Header": "value" },
    });
    // Secret-named headers route to the header keychain face; the value is
    // dropped (the user re-enters it via the form Secret checkbox).
    expect(config.keychain_header_keys).toContain("Authorization");
    expect(config.env).toEqual({});
    expect(config.keychain_env_keys).toEqual([]);
  });

  it("falls back to env for http/sse when headers absent (non-standard shape)", () => {
    // Some non-standard web formats put the header map under "env" on an
    // http/sse row: the fallback still routes it to the HEADER face.
    const json = {
      "api-server": {
        type: "http",
        url: "https://example.com/mcp",
        env: { "X-Custom-Header": "value" },
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.transport).toMatchObject({
      headers: { "X-Custom-Header": "value" },
    });
    expect(config.env).toEqual({});
  });

  it("defaults url transport to http when type is absent", () => {
    const json = {
      "http-server": {
        url: "https://example.com/mcp",
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: {},
    });
  });

  it("routes secret-named env keys to keychain_env_keys", () => {
    const json = {
      "secret-server": {
        command: "npx",
        args: ["-y", "@pkg/server"],
        env: {
          LOG_LEVEL: "info",
          API_KEY: "sk-xxx",
          GITHUB_TOKEN: "ghp_xxx",
        },
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.env).toEqual({ LOG_LEVEL: "info" });
    expect(config.keychain_env_keys).toContain("API_KEY");
    expect(config.keychain_env_keys).toContain("GITHUB_TOKEN");
    // Secret values are dropped (user re-enters via form Secret checkbox).
    expect(config.env).not.toHaveProperty("API_KEY");
  });

  it("preserves fallbackId for new servers", () => {
    const json = { server: { command: "run" } };
    const config = normalizeJsonToConfig(json, "existing-id");
    expect(config.id).toBe("existing-id");
  });

  it("throws on non-object input", () => {
    expect(() => normalizeJsonToConfig("hello", "")).toThrow();
    expect(() => normalizeJsonToConfig(42, "")).toThrow();
    expect(() => normalizeJsonToConfig([], "")).toThrow();
  });

  it("throws when server entry has no command or url", () => {
    expect(() =>
      normalizeJsonToConfig({ "bad-server": { foo: "bar" } }, ""),
    ).toThrow("Server \"bad-server\" has no \"command\" or \"url\" field");
  });

  it("throws when no servers found", () => {
    expect(() => normalizeJsonToConfig({ mcpServers: {} }, "")).toThrow(
      "No servers found in JSON",
    );
  });

  it("handles missing args field (defaults to empty array)", () => {
    const json = { server: { command: "npx" } };
    const config = normalizeJsonToConfig(json, "");
    expect(config.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: [],
    });
  });
});

describe("configToWebJson", () => {
  it("serializes stdio config into bare server map", () => {
    const json = configToWebJson({
      id: "srv-1",
      display_name: "my-server",
      transport: { type: "stdio", command: "npx", args: ["-y", "@pkg/srv"] },
      env: { LOG_LEVEL: "debug" },
      keychain_env_keys: [],
      keychain_header_keys: [],
      timeout_ms: null,
    });

    const parsed = JSON.parse(json);
    expect(parsed["my-server"].command).toBe("npx");
    expect(parsed["my-server"].args).toEqual(["-y", "@pkg/srv"]);
    expect(parsed["my-server"].env).toEqual({ LOG_LEVEL: "debug" });
    // No internal fields leaked.
    expect(parsed["my-server"].transport).toBeUndefined();
    expect(parsed["my-server"].id).toBeUndefined();
    expect(parsed["my-server"].display_name).toBeUndefined();
  });

  it("serializes http config with type + url", () => {
    const json = configToWebJson({
      id: "srv-1",
      display_name: "api",
      transport: { type: "http", url: "https://example.com/mcp", headers: {} },
      env: {},
      keychain_env_keys: [],
      keychain_header_keys: [],
      timeout_ms: null,
    });

    const parsed = JSON.parse(json);
    expect(parsed["api"].type).toBe("http");
    expect(parsed["api"].url).toBe("https://example.com/mcp");
    // No env/headers key when empty.
    expect(parsed["api"].env).toBeUndefined();
    expect(parsed["api"].headers).toBeUndefined();
  });

  it("serializes transport headers (secret names blanked) as the web-format headers field", () => {
    // Issue #901: the remote face serializes transport.headers (non-secret)
    // + keychain_header_keys (names only, values blanked) under "headers";
    // a remote row's dormant env is NOT serialized (invisible everywhere).
    const json = configToWebJson({
      id: "srv-1",
      display_name: "api",
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-Custom": "val" },
      },
      env: { LEGACY_ENV: "dormant" },
      keychain_env_keys: [],
      keychain_header_keys: ["Authorization"],
      timeout_ms: null,
    });

    const parsed = JSON.parse(json);
    expect(parsed["api"].headers).toEqual({ "X-Custom": "val", "Authorization": "" });
    expect(parsed["api"].env).toBeUndefined();
  });

  it("blanks secret env values", () => {
    const json = configToWebJson({
      id: "srv-1",
      display_name: "secret-srv",
      transport: { type: "stdio", command: "run", args: [] },
      env: { LOG_LEVEL: "info" },
      keychain_env_keys: ["API_KEY"],
      keychain_header_keys: [],
      timeout_ms: null,
    });

    const parsed = JSON.parse(json);
    expect(parsed["secret-srv"].env).toEqual({ LOG_LEVEL: "info", API_KEY: "" });
  });

  it("includes timeout_ms when non-null", () => {
    const json = configToWebJson({
      id: "srv-1",
      display_name: "slow-srv",
      transport: { type: "stdio", command: "run", args: [] },
      env: {},
      keychain_env_keys: [],
      keychain_header_keys: [],
      timeout_ms: 60000,
    });

    const parsed = JSON.parse(json);
    expect(parsed["slow-srv"].timeout_ms).toBe(60000);
  });

  it("always includes type and args for stdio", () => {
    const json = configToWebJson({
      id: "srv-1",
      display_name: "no-args",
      transport: { type: "stdio", command: "run", args: [] },
      env: {},
      keychain_env_keys: [],
      keychain_header_keys: [],
      timeout_ms: null,
    });

    const parsed = JSON.parse(json);
    expect(parsed["no-args"].type).toBe("stdio");
    expect(parsed["no-args"].args).toEqual([]);
  });

  it("round-trips through normalizeJsonToConfig", () => {
    const original: McpServerConfig = {
      id: "srv-1",
      display_name: "round-trip",
      transport: { type: "stdio", command: "npx", args: ["-y", "pkg"] },
      env: { LOG_LEVEL: "debug" },
      keychain_env_keys: ["API_KEY"],
      keychain_header_keys: [],
      timeout_ms: 30000,
      enabled: true,
    };

    const json = configToWebJson(original);
    const restored = normalizeJsonToConfig(JSON.parse(json), "srv-1");

    expect(restored.display_name).toBe("round-trip");
    expect(restored.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
    });
    expect(restored.env).toEqual({ LOG_LEVEL: "debug" });
    // API_KEY was blanked in JSON → normalizeJsonToConfig detects it as secret
    // → routes to keychain_env_keys (value dropped, consistent round-trip).
    expect(restored.keychain_env_keys).toContain("API_KEY");
    expect(restored.timeout_ms).toBe(30000);
  });

  it("round-trips http transport with headers through normalizeJsonToConfig", () => {
    const original: McpServerConfig = {
      id: "srv-1",
      display_name: "api-server",
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-Custom": "val" },
      },
      env: {},
      keychain_env_keys: [],
      keychain_header_keys: ["Authorization"],
      timeout_ms: 45000,
      enabled: true,
    };

    const json = configToWebJson(original);
    const restored = normalizeJsonToConfig(JSON.parse(json), "srv-1");

    expect(restored.display_name).toBe("api-server");
    expect(restored.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { "X-Custom": "val" },
    });
    // Serialized under "headers" (secret blanked), parsed back onto the
    // header face with the secret re-detected.
    expect(restored.keychain_header_keys).toContain("Authorization");
    expect(restored.timeout_ms).toBe(45000);
  });
});
