import { describe, expect, it } from "vitest";

import type { McpServerConfig } from "../../types/mcp";
import { configToWebJson, isSecretEnvKey, normalizeJsonToConfig } from "../mcp-json-parse";

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
      transport: { type: "http", url: "https://example.com/mcp" },
      env: { FOO: "bar" },
      keychain_env_keys: ["SECRET_KEY"],
      timeout_ms: 5000,
      enabled: true,
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config).toEqual(json);
  });

  it("ignores an `enabled` field in internal-format JSON (ADR-0106)", () => {
    // Enablement is machine-level state owned by the settings row toggle,
    // never imported: a JSON `enabled: false` must not survive
    // normalization (the placeholder governs until the form assembles the
    // real value).
    const json = {
      id: "srv-1",
      display_name: "existing",
      transport: { type: "stdio", command: "cmd-a", args: [] },
      enabled: false,
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.enabled).toBe(true);
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
    });
  });

  it("reads headers (not env) for http/sse servers", () => {
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
    expect(config.env).toEqual({ "X-Custom-Header": "value" });
    expect(config.keychain_env_keys).toContain("Authorization");
  });

  it("falls back to env for http/sse when headers absent", () => {
    const json = {
      "api-server": {
        type: "http",
        url: "https://example.com/mcp",
        env: { "X-Custom-Header": "value" },
      },
    };

    const config = normalizeJsonToConfig(json, "");
    expect(config.env).toEqual({ "X-Custom-Header": "value" });
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
      timeout_ms: null,
      enabled: true,
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
      transport: { type: "http", url: "https://example.com/mcp" },
      env: {},
      keychain_env_keys: [],
      timeout_ms: null,
      enabled: true,
    });

    const parsed = JSON.parse(json);
    expect(parsed["api"].type).toBe("http");
    expect(parsed["api"].url).toBe("https://example.com/mcp");
    // No env/headers key when empty.
    expect(parsed["api"].env).toBeUndefined();
    expect(parsed["api"].headers).toBeUndefined();
  });

  it("serializes http env as headers in web format", () => {
    const json = configToWebJson({
      id: "srv-1",
      display_name: "api",
      transport: { type: "http", url: "https://example.com/mcp" },
      env: { "X-Custom": "val" },
      keychain_env_keys: ["Authorization"],
      timeout_ms: null,
      enabled: true,
    });

    const parsed = JSON.parse(json);
    // http → "headers", NOT "env"
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
      timeout_ms: null,
      enabled: true,
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
      timeout_ms: 60000,
      enabled: true,
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
      timeout_ms: null,
      enabled: true,
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
      transport: { type: "http", url: "https://example.com/mcp" },
      env: { "X-Custom": "val" },
      keychain_env_keys: ["Authorization"],
      timeout_ms: 45000,
      enabled: true,
    };

    const json = configToWebJson(original);
    const restored = normalizeJsonToConfig(JSON.parse(json), "srv-1");

    expect(restored.display_name).toBe("api-server");
    expect(restored.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp",
    });
    // http → serialized as "headers", parsed back via config.headers path.
    expect(restored.env).toEqual({ "X-Custom": "val" });
    expect(restored.keychain_env_keys).toContain("Authorization");
    expect(restored.timeout_ms).toBe(45000);
  });
});
