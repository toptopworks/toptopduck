import { describe, expect, it, vi } from "vitest";

import {
  clearRemovedServerSecrets,
  collectSecretValues,
  finalizeMcpServer,
  headerFaceOf,
  partitionKvEntries,
  restorePendingSecrets,
  withDormantEnv,
  type KvEntry,
  type McpFinalizeIpc,
  type McpSecretFaces,
} from "../mcp-finalize";
import type { McpServerConfig, McpServerDraft } from "../../../types/mcp";

// Function-level seam of the MCP secret lifecycle species (issue #1115):
// the orchestration semantics live here as direct fake-ipc assertions. The
// component tests keep only what the component itself owns (UI routing,
// form state, refs).

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "srv-1",
    display_name: "My Server",
    transport: { type: "stdio", command: "/bin/mcp-server", args: [] },
    env: {},
    keychain_env_keys: [],
    keychain_header_keys: [],
    timeout_ms: null,
    enabled: true,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<McpServerDraft> = {}): McpServerDraft {
  return {
    id: "srv-1",
    display_name: "My Server",
    transport: { type: "stdio", command: "/bin/mcp-server", args: [] },
    env: {},
    keychain_env_keys: [],
    keychain_header_keys: [],
    timeout_ms: null,
    ...overrides,
  };
}

function makeIpc(overrides: Partial<McpFinalizeIpc> = {}): McpFinalizeIpc {
  return {
    upsertMcpServer: vi.fn(),
    setMcpServerSecret: vi.fn().mockResolvedValue(undefined),
    setMcpServerHeaderSecret: vi.fn().mockResolvedValue(undefined),
    clearMcpServerSecret: vi.fn().mockResolvedValue(undefined),
    clearMcpServerHeaderSecret: vi.fn().mockResolvedValue(undefined),
    probeMcpServer: vi
      .fn()
      .mockResolvedValue({ connected: true, tools: [], error: null }),
    ...overrides,
  };
}

function entry(
  i: number,
  key: string,
  value: string,
  isSecret: boolean,
): KvEntry {
  return { id: i, key, value, isSecret };
}

function emptyFaces(): McpSecretFaces {
  return {
    envSecrets: {},
    headerSecrets: {},
    deletedKeys: { env: [], header: [] },
  };
}

describe("finalizeMcpServer (issue #1115)", () => {
  it("runs upsert → secret writes → clears → probe in order, writing only entered values across both faces", async () => {
    const config = makeConfig({ id: "" });
    // EMPTY_KEY rides the finalized config but carries no entered value —
    // its keychain account must be kept untouched (issue #904).
    const finalized = makeConfig({
      id: "minted",
      keychain_env_keys: ["API_KEY", "EMPTY_KEY"],
      keychain_header_keys: ["Authorization"],
    });
    const ipc = makeIpc({
      upsertMcpServer: vi.fn().mockResolvedValue(finalized),
    });
    const faces: McpSecretFaces = {
      ...emptyFaces(),
      envSecrets: { API_KEY: "sk-secret-123" },
      headerSecrets: { Authorization: "Bearer abc" },
    };

    const result = await finalizeMcpServer(config, faces, {
      ipc,
      formatError: String,
      onUpserted: vi.fn(),
    });

    expect(ipc.upsertMcpServer).toHaveBeenCalledWith(config);
    // One env write (API_KEY only), one header write.
    expect(ipc.setMcpServerSecret).toHaveBeenCalledTimes(1);
    expect(ipc.setMcpServerSecret).toHaveBeenCalledWith(
      "minted",
      "API_KEY",
      "sk-secret-123",
    );
    expect(ipc.setMcpServerHeaderSecret).toHaveBeenCalledWith(
      "minted",
      "Authorization",
      "Bearer abc",
    );
    expect(ipc.probeMcpServer).toHaveBeenCalledWith(finalized);
    // No recorded deletions → nothing clears (a pure save clears nothing).
    expect(ipc.clearMcpServerSecret).not.toHaveBeenCalled();
    expect(ipc.clearMcpServerHeaderSecret).not.toHaveBeenCalled();
    expect(result.finalized).toBe(finalized);
    expect(result.probeResult.error).toBeNull();

    // The steps run in order: upsert strictly before the secret writes,
    // which strictly before the probe.
    const upsertOrder = vi.mocked(ipc.upsertMcpServer).mock.invocationCallOrder[0];
    const envWriteOrder =
      vi.mocked(ipc.setMcpServerSecret).mock.invocationCallOrder[0];
    const probeOrder = vi.mocked(ipc.probeMcpServer).mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(envWriteOrder);
    expect(envWriteOrder).toBeLessThan(probeOrder);
  });

  it("notifies onUpserted before the secret writes, so a write failure still leaves the retry idempotent (C1)", async () => {
    // The minted id must be persisted BEFORE a secret write can fail —
    // otherwise a retry sends id="" again and the backend mints a second
    // server.
    const finalized = makeConfig({
      id: "minted",
      keychain_env_keys: ["API_KEY"],
    });
    const ipc = makeIpc({
      upsertMcpServer: vi.fn().mockResolvedValue(finalized),
      setMcpServerSecret: vi.fn().mockRejectedValue(new Error("keychain locked")),
    });
    const onUpserted = vi.fn();

    // The secret write is fatal: the orchestration rejects (the caller
    // aborts the save instead of handing a half-saved server to the list).
    await expect(
      finalizeMcpServer(
        makeConfig({ id: "" }),
        {
          ...emptyFaces(),
          envSecrets: { API_KEY: "sk" },
        },
        { ipc, formatError: String, onUpserted },
      ),
    ).rejects.toThrow("keychain locked");

    // ...but the minted id was already handed out.
    expect(onUpserted).toHaveBeenCalledTimes(1);
    expect(onUpserted).toHaveBeenCalledWith(finalized);
    expect(onUpserted.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ipc.setMcpServerSecret).mock.invocationCallOrder[0],
    );
  });

  it("wraps a probe failure into a disconnected result instead of rejecting (C2)", async () => {
    const finalized = makeConfig({ id: "minted" });
    const ipc = makeIpc({
      upsertMcpServer: vi.fn().mockResolvedValue(finalized),
      probeMcpServer: vi.fn().mockRejectedValue(new Error("probe timeout")),
    });

    const { probeResult } = await finalizeMcpServer(
      makeConfig(),
      emptyFaces(),
      { ipc, formatError: String, onUpserted: vi.fn() },
    );

    // The server is already saved — the failure surfaces as a disconnected
    // probe result so the caller still commits the config.
    expect(probeResult.connected).toBe(false);
    expect(probeResult.error).toContain("probe timeout");
  });

  it("clears deleted accounts (deduped, re-added names spared on both faces) and folds clear failures into the probe error (issue #904)", async () => {
    // API_KEY was deleted (recorded) then re-added — it rides the finalized
    // config, so the clear-filter must spare its account; X-Test-Token does
    // the same on the header face. OLD_KEY/STALE_KEY stay deleted (OLD_KEY
    // recorded twice — dedup to one clear); STALE_KEY's clear fails,
    // non-fatally.
    const finalized = makeConfig({
      id: "srv-1",
      keychain_env_keys: ["API_KEY"],
      keychain_header_keys: ["X-Test-Token"],
    });
    const ipc = makeIpc({
      upsertMcpServer: vi.fn().mockResolvedValue(finalized),
      clearMcpServerSecret: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("keychain locked")),
    });

    const { probeResult } = await finalizeMcpServer(
      makeConfig(),
      {
        ...emptyFaces(),
        envSecrets: { API_KEY: "sk-secret-123" },
        deletedKeys: {
          env: ["OLD_KEY", "STALE_KEY", "OLD_KEY", "API_KEY"],
          header: ["X-Test-Token", "X-Old-Token"],
        },
      },
      { ipc, formatError: String, onUpserted: vi.fn() },
    );

    // Dedup + clear-filter on the env face: two clears total (OLD_KEY once,
    // STALE_KEY), API_KEY never touched. On the header face the re-added
    // X-Test-Token is spared; only X-Old-Token clears.
    expect(ipc.clearMcpServerSecret).toHaveBeenCalledTimes(2);
    expect(ipc.clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "OLD_KEY");
    expect(ipc.clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "STALE_KEY");
    expect(ipc.clearMcpServerSecret).not.toHaveBeenCalledWith(
      "srv-1",
      "API_KEY",
    );
    expect(ipc.clearMcpServerHeaderSecret).toHaveBeenCalledTimes(1);
    expect(ipc.clearMcpServerHeaderSecret).toHaveBeenCalledWith(
      "srv-1",
      "X-Old-Token",
    );
    expect(ipc.clearMcpServerHeaderSecret).not.toHaveBeenCalledWith(
      "srv-1",
      "X-Test-Token",
    );

    // Non-fatal posture: connected reflects the server, the failed cleanup
    // rides the error channel.
    expect(probeResult.connected).toBe(true);
    expect(probeResult.error).toContain("STALE_KEY: Error: keychain locked");

    // The secret write precedes the clears, which precede the probe — a
    // stale credential must not outlive the save's own status check.
    const envWriteOrder =
      vi.mocked(ipc.setMcpServerSecret).mock.invocationCallOrder[0];
    const clearOrder =
      vi.mocked(ipc.clearMcpServerSecret).mock.invocationCallOrder[0];
    const probeOrder =
      vi.mocked(ipc.probeMcpServer).mock.invocationCallOrder[0];
    expect(envWriteOrder).toBeLessThan(clearOrder);
    expect(clearOrder).toBeLessThan(probeOrder);
  });

  it("appends clear warnings to an existing probe error, joined with '; '", async () => {
    const finalized = makeConfig({ id: "srv-1" });
    const ipc = makeIpc({
      upsertMcpServer: vi.fn().mockResolvedValue(finalized),
      clearMcpServerSecret: vi
        .fn()
        .mockRejectedValueOnce(new Error("clear failed")),
      clearMcpServerHeaderSecret: vi
        .fn()
        .mockRejectedValueOnce(new Error("header clear failed")),
      probeMcpServer: vi
        .fn()
        .mockRejectedValue(new Error("probe timeout")),
    });

    const { probeResult } = await finalizeMcpServer(
      makeConfig(),
      {
        ...emptyFaces(),
        deletedKeys: { env: ["OLD_KEY"], header: ["X-Test-Token"] },
      },
      { ipc, formatError: String, onUpserted: vi.fn() },
    );

    // Both failure channels fold into one message, probe first, each clear
    // failure named by its key.
    expect(probeResult.error).toBe(
      "Error: probe timeout; OLD_KEY: Error: clear failed; X-Test-Token: Error: header clear failed",
    );
  });
});

describe("clearRemovedServerSecrets (issue #904 list twin)", () => {
  it("clears both account families for a removed server and returns each failure (user-visible, never swallowed)", async () => {
    const ipc = makeIpc({
      clearMcpServerSecret: vi.fn().mockRejectedValue(new Error("keychain locked")),
    });

    const warnings = await clearRemovedServerSecrets(
      "srv-1",
      { env: ["API_KEY", "WEBHOOK_SECRET"], header: ["X-Test-Token"] },
      { ipc, formatError: String },
    );

    expect(ipc.clearMcpServerSecret).toHaveBeenCalledWith("srv-1", "API_KEY");
    expect(ipc.clearMcpServerSecret).toHaveBeenCalledWith(
      "srv-1",
      "WEBHOOK_SECRET",
    );
    expect(ipc.clearMcpServerHeaderSecret).toHaveBeenCalledWith(
      "srv-1",
      "X-Test-Token",
    );
    // Every env clear failed; the header clear succeeded — the failures are
    // returned, each named by its key, so the caller can surface them.
    expect(warnings).toEqual([
      "API_KEY: Error: keychain locked",
      "WEBHOOK_SECRET: Error: keychain locked",
    ]);
  });

  it("returns an empty warning list when every clear succeeds", async () => {
    const ipc = makeIpc();

    const warnings = await clearRemovedServerSecrets(
      "srv-1",
      { env: ["API_KEY"], header: [] },
      { ipc, formatError: String },
    );

    expect(warnings).toEqual([]);
  });

  it("keeps the two key families as labeled fields — a positional pair must not compile (issue #1117)", () => {
    // Compile-time pin: pre-#1117 the env/header keys were adjacent bare
    // string[] parameters — a swapped family pair compiled silently and the
    // idempotent clears no-opped, stranding real credentials in the OS
    // keychain. bind() type-checks its arguments without invoking the
    // function, so this pin is exercised by tsc and inert at runtime.
    const positional = clearRemovedServerSecrets.bind(
      null,
      "srv-1",
      // @ts-expect-error pre-#1117 positional shape must stay a type error
      ["API_KEY"],
    );
    expect(positional).toBeTypeOf("function");
  });
});

describe("value-level helpers", () => {
  it("partitionKvEntries splits plain vs secret rows and skips empty keys", () => {
    const entries = [
      entry(0, "LOG_LEVEL", "info", false),
      entry(1, "API_KEY", "sk-1", true),
      entry(2, "", "orphan", false),
    ];

    expect(partitionKvEntries(entries)).toEqual({
      plain: { LOG_LEVEL: "info" },
      secretKeys: ["API_KEY"],
    });
  });

  it("headerFaceOf returns an empty face on stdio, headers + keys on remote (issue #901)", () => {
    const stdio = makeConfig();
    expect(headerFaceOf(stdio)).toEqual({ plain: {}, secretKeys: [] });

    const remote = makeConfig({
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { "X-Api-Version": "2024-11-05" },
      },
      keychain_header_keys: ["Authorization"],
    });
    expect(headerFaceOf(remote)).toEqual({
      plain: { "X-Api-Version": "2024-11-05" },
      secretKeys: ["Authorization"],
    });
  });

  it("restorePendingSecrets refills only secret rows with a captured value (H2)", () => {
    const entries = [
      entry(0, "LOG_LEVEL", "info", false),
      entry(1, "API_KEY", "", true),
      entry(2, "EMPTY_SECRET", "", true),
    ];

    const restored = restorePendingSecrets(entries, {
      API_KEY: "sk-preserve-me",
      LOG_LEVEL: "must-not-apply",
    });

    expect(restored[0].value).toBe("info"); // plain row untouched
    expect(restored[1].value).toBe("sk-preserve-me");
    expect(restored[2].value).toBe(""); // no captured value stays empty
  });

  it("collectSecretValues keeps only non-empty secret values", () => {
    const entries = [
      entry(0, "LOG_LEVEL", "info", false),
      entry(1, "API_KEY", "sk-1", true),
      entry(2, "EMPTY_KEY", "", true),
    ];

    expect(collectSecretValues(entries)).toEqual({ API_KEY: "sk-1" });
  });

  it("withDormantEnv keeps the dormant face on an empty parsed env and passes explicit env through (issue #901)", () => {
    const dormant = {
      env: { LEGACY_ENV: "dormant-value" },
      keychainEnvKeys: ["LEGACY_SECRET"],
    };

    // Stdio drafts pass through untouched (env is their live face).
    const stdioDraft = makeDraft();
    expect(withDormantEnv(stdioDraft, dormant)).toBe(stdioDraft);

    // A remote draft whose parsed env face is EMPTY (the web format cannot
    // express it) keeps the dormant face.
    const emptyFaceDraft = makeDraft({
      transport: { type: "http", url: "https://example.com/mcp", headers: {} },
    });
    expect(withDormantEnv(emptyFaceDraft, dormant)).toEqual({
      ...emptyFaceDraft,
      env: dormant.env,
      keychain_env_keys: dormant.keychainEnvKeys,
    });

    // An internal-format paste that explicitly carries env entries wins.
    const explicitDraft = makeDraft({
      transport: { type: "http", url: "https://example.com/mcp", headers: {} },
      env: { FRESH: "value" },
    });
    expect(withDormantEnv(explicitDraft, dormant)).toBe(explicitDraft);

    // A paste whose env is entirely secret keys also wins — the key list
    // itself proves the paste explicitly touched env.
    const allSecretDraft = makeDraft({
      transport: { type: "http", url: "https://example.com/mcp", headers: {} },
      keychain_env_keys: ["ONLY_SECRET"],
    });
    expect(withDormantEnv(allSecretDraft, dormant)).toBe(allSecretDraft);
  });
});
