import type {
  McpProbeResult,
  McpServerConfig,
  McpServerDraft,
} from "../../types/mcp";

// MCP secret lifecycle species (issue #1115) — the single owner of the
// "delete a row / delete a server = clear its keychain accounts" rule and of
// the save-time five-step orchestration:
//   upsert → persist minted id → write env/header secrets → clear deleted
//   accounts → probe.
// Both writers route through here: the settings form's save
// (finalizeMcpServer) and the server list's delete
// (clearRemovedServerSecrets). A clear failure is always non-fatal once the
// upsert / config removal has committed, and always surfaced to the user
// (the save folds it into the probe result's error channel; the delete
// raises it on the pane's error banner) — never a silent console.warn.
//
// Secrets live in the OS keychain, never app-config (ADR-0038 app-config
// holds no secrets; ADR-0029 the keychain transfer is one-way); persistence
// stays per-control (ADR-0075 — no section-level Save is introduced here).
// Anchors: #388 (form base), #901 (dormant env), #904 (clear-on-delete).

/** One row of the env-var / headers editor. `isSecret` routes the value to
 *  the OS keychain on save instead of the plain `env` / `transport.headers`
 *  map. */
export type KvEntry = {
  id: number;
  key: string;
  value: string;
  isSecret: boolean;
};

/** The ipc boundary this species consumes — the six `src/api.ts` entry
 *  points, injected so function-level tests fake one object. The components
 *  pass the real api module's functions (which the component tests mock at
 *  module level, so the mocks flow through unchanged). */
export type McpFinalizeIpc = {
  upsertMcpServer: (config: McpServerConfig) => Promise<McpServerConfig>;
  setMcpServerSecret: (
    id: string,
    key: string,
    value: string,
  ) => Promise<void>;
  setMcpServerHeaderSecret: (
    id: string,
    name: string,
    value: string,
  ) => Promise<void>;
  clearMcpServerSecret: (id: string, key: string) => Promise<void>;
  clearMcpServerHeaderSecret: (id: string, name: string) => Promise<void>;
  probeMcpServer: (server: McpServerConfig) => Promise<McpProbeResult>;
};

/** The two keychain account families' key names (issue #901: env secrets
 *  and header secrets live in distinct families). Labeled fields, never
 *  adjacent bare arrays — a swapped family pair would compile silently and
 *  the idempotent clears would no-op, stranding real credentials in the OS
 *  keychain (issue #1117). */
export type SecretKeyFaces = {
  env: string[];
  header: string[];
};

/** The secret faces one save carries (issue #901 split env / headers into
 *  distinct keychain account families). */
export type McpSecretFaces = {
  /** Secret values the form collected, per face (JSON mode: empty maps — a
   *  JSON save never writes keychain values). Only non-empty values reach
   *  the keychain; an untouched secret row keeps its stored value. */
  envSecrets: Record<string, string>;
  headerSecrets: Record<string, string>;
  /** Secret names whose accounts a deleted row must clear at save (issue
   *  #904). Only explicit Form-mode row removals record names; the form's
   *  deletion recorder passes its ref straight through (issue #1117 — no
   *  flatten/re-nest churn). */
  deletedKeys: SecretKeyFaces;
};

/** The injected dependencies of the finalize orchestration. */
export type FinalizeDeps = {
  ipc: McpFinalizeIpc;
  /** Localized error rendering (fmtError + intl in the components). */
  formatError: (e: unknown) => string;
  /** Called right after the upsert commits, BEFORE the secret writes — the
   *  form persists the minted id here so a retry after a secret-write
   *  failure is idempotent (C1: without it, a retry sends id="" again and
   *  the backend mints a second server). */
  onUpserted: (finalized: McpServerConfig) => void;
};

/** Split one face's rows into its config shape: plain values into a map,
 *  secret names into a key list (the values ride the keychain, never the
 *  config). Shared by the form draft assembly for both faces (issue #904
 *  fold). */
export function partitionKvEntries(entries: KvEntry[]): {
  plain: Record<string, string>;
  secretKeys: string[];
} {
  const plain: Record<string, string> = {};
  const secretKeys: string[] = [];
  for (const entry of entries) {
    if (!entry.key) continue;
    if (entry.isSecret) {
      secretKeys.push(entry.key);
    } else {
      plain[entry.key] = entry.value;
    }
  }
  return { plain, secretKeys };
}

/** The header face of a draft (empty on a stdio draft — no transport
 *  headers there, issue #901). */
export function headerFaceOf(server: McpServerDraft): {
  plain: Record<string, string>;
  secretKeys: string[];
} {
  return server.transport.type === "stdio"
    ? { plain: {}, secretKeys: [] }
    : { plain: server.transport.headers, secretKeys: server.keychain_header_keys };
}

/** Restore captured secret values onto a freshly rebuilt entry list (the
 *  JSON→Form switch half of the H2 round-trip). */
export function restorePendingSecrets(
  entries: KvEntry[],
  pending: Record<string, string>,
): KvEntry[] {
  return entries.map((entry) =>
    entry.isSecret && pending[entry.key]
      ? { ...entry, value: pending[entry.key] }
      : entry,
  );
}

/** Collect the secret values one face's rows hold for the keychain write.
 *  Empty values are skipped — an existing secret row saved empty keeps its
 *  stored value (issue #904). */
export function collectSecretValues(
  entries: KvEntry[],
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isSecret && entry.value) {
      secrets[entry.key] = entry.value;
    }
  }
  return secrets;
}

/** A remote draft's dormant env face (issue #901): the env values + secret
 *  key names that ride through a form session while the JSON text cannot
 *  express them. The single named declaration — withDormantEnv's parameter
 *  and the form's ref share it (issue #1117). */
export type McpDormantEnv = {
  env: Record<string, string>;
  keychainEnvKeys: string[];
};

/** Keep a remote draft's dormant env face across a JSON-mode parse (issue
 *  #901): the web format cannot express it, so an EMPTY parsed face means
 *  "unchanged" (the dormant face rides through); only an internal-format
 *  paste that explicitly carries env entries replaces it. Stdio drafts pass
 *  through untouched (env is their live face). */
export function withDormantEnv(
  draft: McpServerDraft,
  dormant: McpDormantEnv,
): McpServerDraft {
  if (draft.transport.type === "stdio") return draft;
  if (Object.keys(draft.env).length > 0 || draft.keychain_env_keys.length > 0) {
    return draft;
  }
  return {
    ...draft,
    env: dormant.env,
    keychain_env_keys: dormant.keychainEnvKeys,
  };
}

/** Clear the keychain accounts behind recorded deletions (issue #904),
 *  deduped and filtered against the finalized config's key names so a
 *  re-added name keeps its (possibly re-entered) value. A delete passes
 *  empty finalized lists — the server is gone, every recorded name clears.
 *  Non-fatal the way the probe is (C2): the upsert / config removal already
 *  committed; each failure is collected for the caller to surface. */
async function clearAccounts(
  ipc: Pick<
    McpFinalizeIpc,
    "clearMcpServerSecret" | "clearMcpServerHeaderSecret"
  >,
  serverId: string,
  deleted: SecretKeyFaces,
  finalized: SecretKeyFaces,
  formatError: (e: unknown) => string,
): Promise<string[]> {
  const envClears = [...new Set(deleted.env)].filter(
    (key) => !finalized.env.includes(key),
  );
  const headerClears = [...new Set(deleted.header)].filter(
    (name) => !finalized.header.includes(name),
  );
  // Each warning carries its key name — the raw keychain error names no
  // account, and the key is safe to show (the config file lists it).
  const warnings: string[] = [];
  for (const key of envClears) {
    try {
      await ipc.clearMcpServerSecret(serverId, key);
    } catch (clearErr) {
      warnings.push(`${key}: ${formatError(clearErr)}`);
    }
  }
  for (const name of headerClears) {
    try {
      await ipc.clearMcpServerHeaderSecret(serverId, name);
    } catch (clearErr) {
      warnings.push(`${name}: ${formatError(clearErr)}`);
    }
  }
  return warnings;
}

/** The save-time five-step orchestration (issue #1115): upsert → persist
 *  minted id (onUpserted, C1) → write env/header secrets → clear deleted
 *  accounts → probe. A fatal step
 *  (the upsert or a secret write) REJECTS — the caller aborts the save; the
 *  clears and the probe are non-fatal (C2) and their failures ride the
 *  returned probe result's error channel so the row surfaces them while
 *  `connected` still reflects the server itself. */
export async function finalizeMcpServer(
  config: McpServerConfig,
  faces: McpSecretFaces,
  deps: FinalizeDeps,
): Promise<{ finalized: McpServerConfig; probeResult: McpProbeResult }> {
  const { ipc, formatError, onUpserted } = deps;

  // 1. Upsert (writes to disk; returns the finalized config with minted id),
  //    then persist the minted id BEFORE anything can fail below (C1).
  const finalized = await ipc.upsertMcpServer(config);
  onUpserted(finalized);

  // 2. Write each secret to the OS keychain (ADR-0029 one-shot transfer):
  //    env secrets under `mcp-<id>-<env_key>`, header secrets under
  //    `mcp-<id>-header-<name>` (issue #901). The finalized config's key
  //    lists are the write authority — a face value whose key the backend
  //    did not echo back never lands. A row with no entered value writes
  //    nothing — its stored value is kept.
  for (const key of finalized.keychain_env_keys) {
    const value = faces.envSecrets[key];
    if (value) {
      await ipc.setMcpServerSecret(finalized.id, key, value);
    }
  }
  for (const name of finalized.keychain_header_keys) {
    const value = faces.headerSecrets[name];
    if (value) {
      await ipc.setMcpServerHeaderSecret(finalized.id, name, value);
    }
  }

  // 3. Clear the accounts behind rows deleted this session (issue #904).
  //    Aborting before the handoff would leave the list's mirror stale — any
  //    later full-config commit would silently revert this save (I3) — so a
  //    clear failure is collected, not thrown.
  const clearWarnings = await clearAccounts(
    ipc,
    finalized.id,
    faces.deletedKeys,
    {
      env: finalized.keychain_env_keys,
      header: finalized.keychain_header_keys,
    },
    formatError,
  );

  // 4. Auto-probe so the list shows an immediate status. A probe failure is
  //    non-fatal — the server is already saved; surface it as a disconnected
  //    probe result so the caller still commits the config and switches to
  //    the list view (C2).
  let probeResult: McpProbeResult;
  try {
    probeResult = await ipc.probeMcpServer(finalized);
  } catch (probeErr) {
    probeResult = {
      connected: false,
      tools: [],
      error: formatError(probeErr),
    };
  }
  if (clearWarnings.length > 0) {
    // A deleted credential may still sit in the OS keychain — the result
    // tells the user instead of the save silently half-completing.
    const warning = clearWarnings.join("; ");
    probeResult = {
      ...probeResult,
      error: probeResult.error ? `${probeResult.error}; ${warning}` : warning,
    };
  }
  return { finalized, probeResult };
}

/** The delete path's entry into the same lifecycle species: after the config
 *  entry is removed, clear BOTH account families behind the removed server
 *  (issue #901) through the same clearAccounts the save uses. Returns the
 *  failure strings — the caller surfaces them (user-visible), never
 *  swallows them. */
export async function clearRemovedServerSecrets(
  serverId: string,
  deletedKeys: SecretKeyFaces,
  deps: {
    ipc: Pick<
      McpFinalizeIpc,
      "clearMcpServerSecret" | "clearMcpServerHeaderSecret"
    >;
    formatError: (e: unknown) => string;
  },
): Promise<string[]> {
  return clearAccounts(
    deps.ipc,
    serverId,
    deletedKeys,
    { env: [], header: [] },
    deps.formatError,
  );
}
