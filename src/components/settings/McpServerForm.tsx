import { useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";

import {
  type McpProbeResult,
  type McpServerConfig,
  type McpServerDraft,
  type McpTransport,
} from "../../types/mcp";
import {
  clearMcpServerHeaderSecret,
  clearMcpServerSecret,
  probeMcpServer,
  setMcpServerHeaderSecret,
  setMcpServerSecret,
  upsertMcpServer,
} from "../../api";
import { fmtError } from "../../lib/error-presentation";
import {
  configToWebJson,
  normalizeJsonToConfig,
} from "../../lib/mcp-json-parse";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import { PaneHeader, SettingsCard, SettingsRow } from "./settings-chrome";

// MCP server add / edit form (issue #388). A full-page replacement for the
// server list with Form / JSON dual-mode, bidirectional sync, and a save flow:
// upsertMcpServer → setMcpServerSecret / setMcpServerHeaderSecret (per secret
// env / header key) → auto probe → onSaved callback returns the finalized
// config + probe result to the list.
//
// Secrets never appear in the JSON view — only the keychain_env_keys /
// keychain_header_keys key names. Secret values are transient form state; on
// save they go to the OS keychain and are never serialized into app-config.
//
// Issue #901: the key-value editors split by transport — stdio shows the env
// editor (env + keychain_env_keys), http/sse shows the headers editor
// (transport.headers + keychain_header_keys). A legacy remote row's env
// entries are DORMANT: preserved through edits (dormantEnvRef below),
// invisible in both editors, never re-routed.
//
// Issue #904 credential lifecycle, two semantics per secret row:
// - DELETED row → the keychain account is cleared at save (the form's
//   pending-deleted list drives clearMcpServer*Secret; only an explicit row
//   removal records a name — a transport flip or a JSON paste never does, so
//   dormancy survives, which is also why the cleanup lives here and not in
//   the backend upsert's blind diff. A recorded deletion survives a mode
//   switch and clears at the next save of either mode — explicit deletion
//   intent is honored wherever the save happens).
// - EXISTING row left EMPTY → the stored keychain value is kept (a save only
//   writes non-empty values); the editor shows this hint.
// A pure JSON save (no row deleted this session) clears nothing: pasting
// replaces the config shape without any credential-management action —
// accepted gap.

/** One row of the env-var / headers editor. `isSecret` routes the value to
 *  the OS keychain (via setMcpServerSecret / setMcpServerHeaderSecret on
 *  save) instead of the plain `env` / `transport.headers` map. */
type KvEntry = {
  id: number;
  key: string;
  value: string;
  isSecret: boolean;
};

// Monotonic counter for stable KvEntry keys (H1: index-based keys break
// focus/cursor when rows are inserted or deleted mid-list).
let entrySeq = 0;

export type McpServerFormProps = {
  /** Blank server (empty id) for add; existing server for edit. */
  initialServer: McpServerConfig;
  /** Distinguishes the title + whether keychain secrets already exist. */
  isEdit: boolean;
  /** Called after the full save + probe flow completes. The parent syncs the
   *  finalized config into React state, stores the probe result, and switches
   *  back to the list view. */
  onSaved: (finalized: McpServerConfig, probeResult: McpProbeResult) => void;
  /** Return to the list without saving. */
  onCancel: () => void;
};

type FormMode = "form" | "json";

/** Build the initial key-value entry list from a plain map + its keychain
 *  key names (value empty — the keychain is one-way): non-secret entries
 *  from the map, secret entries from the key list. Shared by the env face
 *  (env + keychain_env_keys) and the header face (transport.headers +
 *  keychain_header_keys, issue #901). */
function initKvEntries(
  plain: Record<string, string>,
  secretKeys: string[],
): KvEntry[] {
  const entries: KvEntry[] = Object.entries(plain).map(([key, value]) => ({
    id: entrySeq++,
    key,
    value,
    isSecret: false,
  }));
  for (const key of secretKeys) {
    entries.push({ id: entrySeq++, key, value: "", isSecret: true });
  }
  return entries;
}

/** The header face of a draft (empty on a stdio draft — no transport
 *  headers there, issue #901). */
function headerFaceOf(server: McpServerDraft): {
  plain: Record<string, string>;
  secretKeys: string[];
} {
  return server.transport.type === "stdio"
    ? { plain: {}, secretKeys: [] }
    : { plain: server.transport.headers, secretKeys: server.keychain_header_keys };
}

/** The add / remove / update triplet one key-value editor drives. Shared by
 *  both faces (env / headers, issue #904 fold) so the row lifecycle exists
 *  exactly once. */
type KvEntryActions = {
  add: () => void;
  remove: (index: number) => void;
  update: (index: number, patch: Partial<KvEntry>) => void;
};

/** Build one face's row-action triplet over its state setter (issue #904
 *  fold: the six per-face handlers collapse to two factory calls). The
 *  updater stays pure — face-specific side effects (deletion recording)
 *  wrap these in the component. */
function kvEntryActions(
  setEntries: React.Dispatch<React.SetStateAction<KvEntry[]>>,
): KvEntryActions {
  return {
    add: () =>
      setEntries((prev) => [
        ...prev,
        { id: entrySeq++, key: "", value: "", isSecret: false },
      ]),
    remove: (index) => setEntries((prev) => prev.filter((_, i) => i !== index)),
    update: (index, patch) =>
      setEntries((prev) =>
        prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
      ),
  };
}

/** Capture one face's secret values before a Form→JSON switch so they
 *  survive the round-trip (H2; one call per face since #901 split them). */
function capturePendingSecrets(entries: KvEntry[]): Record<string, string> {
  const pending: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isSecret) {
      pending[entry.key] = entry.value;
    }
  }
  return pending;
}

/** Restore captured secret values onto a freshly rebuilt entry list (the
 *  JSON→Form switch half of the H2 round-trip). */
function restorePendingSecrets(
  entries: KvEntry[],
  pending: Record<string, string>,
): KvEntry[] {
  return entries.map((entry) =>
    entry.isSecret && pending[entry.key]
      ? { ...entry, value: pending[entry.key] }
      : entry,
  );
}

/** Split one face's rows into its config shape: plain values into a map,
 *  secret names into a key list (the values ride the keychain, never the
 *  config). Shared by buildConfigFromForm's two faces (issue #904 fold). */
function partitionKvEntries(entries: KvEntry[]): {
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

export function McpServerForm({
  initialServer,
  isEdit,
  onSaved,
  onCancel,
}: McpServerFormProps) {
  const intl = useIntl();

  // Server id state — updated after upsert so a retry (after a secret/probe
  // failure) sends the minted id instead of "", preventing Rust from creating
  // a duplicate server (C1).
  const [serverId, setServerId] = useState(initialServer.id);

  // Pending secret values captured before a Form→JSON switch so they survive
  // the round-trip (H2: buildConfigFromForm serializes only key names, and
  // initKvEntries reconstructs with empty values). One ref per face (issue
  // #901): an env key and a header key may share a name.
  const pendingEnvSecrets = useRef<Record<string, string>>({});
  const pendingHeaderSecrets = useRef<Record<string, string>>({});

  // Secret names whose keychain accounts a deleted row must clear at save
  // (issue #904). Only an EXPLICIT Form-mode row removal records a name: a
  // transport flip (remote→stdio swaps the editor, headers go dormant) and a
  // JSON-mode paste replace the entry lists without deletion intent, so they
  // record nothing — the backend upsert's blind diff would misread a flip as
  // deletions; that is why this cleanup lives in the form. A recorded name
  // survives mode switches and clears at the next save of either mode.
  const deletedSecretKeysRef = useRef<{ env: string[]; header: string[] }>({
    env: [],
    header: [],
  });

  // A legacy remote row's env face rides here while the form is open
  // (issue #901 dormancy): the env editor shows nothing on a remote
  // transport, configToWebJson serializes none of it, but the save path
  // puts the ORIGINAL env values + secret key names back so an edit never
  // drops or migrates them.
  const dormantEnvRef = useRef<{
    env: Record<string, string>;
    keychainEnvKeys: string[];
  }>(
    initialServer.transport.type === "stdio"
      ? { env: {}, keychainEnvKeys: [] }
      : {
          env: initialServer.env,
          keychainEnvKeys: initialServer.keychain_env_keys,
        },
  );

  // --- Flat form state (single source of truth for Form mode) ---------------
  const [displayName, setDisplayName] = useState(initialServer.display_name);
  const [transportType, setTransportType] = useState<"stdio" | "sse" | "http">(
    initialServer.transport.type,
  );
  const [command, setCommand] = useState(
    initialServer.transport.type === "stdio"
      ? initialServer.transport.command
      : "",
  );
  const [argsText, setArgsText] = useState(
    initialServer.transport.type === "stdio"
      ? initialServer.transport.args.join(" ")
      : "",
  );
  const [url, setUrl] = useState(
    "url" in initialServer.transport ? initialServer.transport.url : "",
  );
  // The env editor's rows: populated only on a stdio transport (a remote
  // transport's key-value face is headers, below).
  const [envEntries, setEnvEntries] = useState<KvEntry[]>(() =>
    initialServer.transport.type === "stdio"
      ? initKvEntries(initialServer.env, initialServer.keychain_env_keys)
      : [],
  );
  // The headers editor's rows: populated only on an http/sse transport
  // (issue #901).
  const headerFace = headerFaceOf(initialServer);
  const [headerEntries, setHeaderEntries] = useState<KvEntry[]>(() =>
    initialServer.transport.type === "stdio"
      ? []
      : initKvEntries(headerFace.plain, headerFace.secretKeys),
  );
  const [timeoutMs, setTimeoutMs] = useState(
    initialServer.timeout_ms !== null ? String(initialServer.timeout_ms) : "",
  );

  // --- JSON mode state -------------------------------------------------------
  const [mode, setMode] = useState<FormMode>("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);

  // --- Save flow state -------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Field validation: name is always required; command (stdio) or url
  // (sse/http) is required based on transport type. Disables the Add/Save
  // button until the minimum required fields are filled.
  const isFormValid = useMemo(() => {
    if (mode === "json") {
      try {
        const c = normalizeJsonToConfig(JSON.parse(jsonText), serverId);
        if (!c.display_name?.trim()) return false;
        return c.transport.type === "stdio"
          ? !!c.transport.command?.trim()
          : !!c.transport.url?.trim();
      } catch {
        return false;
      }
    }
    return (
      displayName.trim() !== "" &&
      (transportType === "stdio" ? command.trim() !== "" : url.trim() !== "")
    );
  }, [mode, jsonText, displayName, transportType, command, url, serverId]);

  // Build a McpServerDraft from the current form fields (no `enabled` — the
  // save below is the single assembly point that stamps it; #659). The
  // key-value editors split by transport (issue #901): stdio → env +
  // keychain_env_keys; http/sse → transport.headers + keychain_header_keys,
  // with the dormant env carried through untouched.
  function buildConfigFromForm(): McpServerDraft {
    // Guard against NaN: type="number" rejects most non-numeric input, but
    // a paste / programmatic value could still produce NaN (Rust rejects it,
    // surfacing an error — cleaner to fall back to null here).
    const timeout_ms =
      timeoutMs.trim() && !Number.isNaN(Number(timeoutMs))
        ? Number(timeoutMs)
        : null;

    if (transportType === "stdio") {
      const { plain: env, secretKeys: keychainEnvKeys } =
        partitionKvEntries(envEntries);
      const transport: McpTransport = {
        type: "stdio",
        command,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
      };
      return {
        id: serverId,
        display_name: displayName,
        transport,
        env,
        keychain_env_keys: keychainEnvKeys,
        keychain_header_keys: [],
        timeout_ms,
      };
    }

    const { plain: headers, secretKeys: keychainHeaderKeys } =
      partitionKvEntries(headerEntries);
    const transport: McpTransport = { type: transportType, url, headers };
    return {
      id: serverId,
      display_name: displayName,
      transport,
      // Dormancy (issue #901): the remote save restores the ORIGINAL env
      // face the row carried in — no migration, no deletion, no editor
      // visibility.
      env: dormantEnvRef.current.env,
      keychain_env_keys: dormantEnvRef.current.keychainEnvKeys,
      keychain_header_keys: keychainHeaderKeys,
      timeout_ms,
    };
  }

  /** Parse JSON text into a McpServerDraft, returning an error string on
   *  failure. Accepts our internal format AND common web formats (Claude
   *  Desktop `{"mcpServers": {...}}`, bare `{"name": {...}}` — the first entry
   *  is used). Shared by mode-switch and save (M7). */
  function tryParseConfig(
    text: string,
  ): { ok: true; config: McpServerDraft } | { ok: false; error: string } {
    try {
      const raw = JSON.parse(text);
      return { ok: true, config: normalizeJsonToConfig(raw, serverId) };
    } catch (e) {
      return { ok: false, error: fmtError(e, intl) };
    }
  }

  /** Keep a remote draft's dormant env face across a JSON-mode parse
   *  (issue #901): the web format cannot express it, so an EMPTY parsed
   *  face means "unchanged" (the ref's face rides through); only an
   *  internal-format paste that explicitly carries env entries replaces
   *  it. Stdio drafts pass through untouched (env is their live face). */
  function withDormantEnv(draft: McpServerDraft): McpServerDraft {
    if (draft.transport.type === "stdio") return draft;
    if (Object.keys(draft.env).length > 0 || draft.keychain_env_keys.length > 0) {
      return draft;
    }
    return {
      ...draft,
      env: dormantEnvRef.current.env,
      keychain_env_keys: dormantEnvRef.current.keychainEnvKeys,
    };
  }

  /** Sync FROM JSON text → flat form state (called when switching JSON → Form). */
  function syncFromJson(parsed: McpServerDraft): void {
    setDisplayName(parsed.display_name);
    setTransportType(parsed.transport.type);
    if (parsed.transport.type === "stdio") {
      setCommand(parsed.transport.command);
      setArgsText(parsed.transport.args.join(" "));
      setUrl("");
      dormantEnvRef.current = { env: {}, keychainEnvKeys: [] };
      setEnvEntries(
        // Restore secret values captured before the Form→JSON switch so
        // they survive the round-trip (H2).
        restorePendingSecrets(
          initKvEntries(parsed.env, parsed.keychain_env_keys),
          pendingEnvSecrets.current,
        ),
      );
      setHeaderEntries([]);
    } else {
      setUrl(parsed.transport.url);
      setCommand("");
      setArgsText("");
      // Dormancy (issue #901): a remote draft's env face rides the ref.
      // The web format cannot express a remote row's env (configToWebJson
      // serializes headers only), so an EMPTY parsed face means "unchanged"
      // -- keep the ref across the round trip. Only an internal-format
      // paste that explicitly carries env entries replaces it.
      if (
        Object.keys(parsed.env).length > 0 ||
        parsed.keychain_env_keys.length > 0
      ) {
        dormantEnvRef.current = {
          env: parsed.env,
          keychainEnvKeys: parsed.keychain_env_keys,
        };
      }
      setEnvEntries([]);
      const face = headerFaceOf(parsed);
      setHeaderEntries(
        restorePendingSecrets(
          initKvEntries(face.plain, face.secretKeys),
          pendingHeaderSecrets.current,
        ),
      );
    }
    setTimeoutMs(parsed.timeout_ms !== null ? String(parsed.timeout_ms) : "");
  }

  function handleSwitchMode(next: FormMode) {
    if (next === mode) return;
    if (next === "json") {
      // Capture ALL secret key names + values before serializing so they
      // survive the JSON round-trip (H2). The web-format serializer includes
      // secret key names with blanked values; the actual values are restored
      // from the pending refs on the JSON → Form switch. One ref per face
      // (issue #901).
      pendingEnvSecrets.current = capturePendingSecrets(envEntries);
      pendingHeaderSecrets.current = capturePendingSecrets(headerEntries);
      // Serialize into the common web format (bare server map) so the user
      // sees and edits the same shape they'd copy from online docs.
      const config = buildConfigFromForm();
      setJsonText(configToWebJson(config));
      setJsonError(null);
    } else {
      // Parse JSON text → form state. If invalid, abort the switch and show
      // an error so the user can fix the JSON before returning to Form mode.
      const result = tryParseConfig(jsonText);
      if (!result.ok) {
        setJsonError(result.error);
        return;
      }
      // Key names come solely from the parsed JSON (configToWebJson includes
      // secret keys as blanked entries; normalizeJsonToConfig re-detects them
      // on parse-back). The pending refs only restore VALUES via
      // syncFromJson — do NOT merge key names back, as the user may have
      // intentionally deleted them from the JSON.
      syncFromJson(result.config);
      setJsonError(null);
    }
    setMode(next);
  }

  // One action triplet per face (issue #904 fold of the six per-face
  // handlers); the remove wrappers layer deletion recording on top.
  const envActions = kvEntryActions(setEnvEntries);
  const headerActions = kvEntryActions(setHeaderEntries);

  function removeEnvEntry(index: number) {
    const entry = envEntries[index];
    if (entry?.isSecret && entry.key) {
      deletedSecretKeysRef.current.env.push(entry.key);
    }
    envActions.remove(index);
  }

  function removeHeaderEntry(index: number) {
    const entry = headerEntries[index];
    if (entry?.isSecret && entry.key) {
      deletedSecretKeysRef.current.header.push(entry.key);
    }
    headerActions.remove(index);
  }

  async function handleSave() {
    // Build the draft from the active mode (no `enabled` — neither mode
    // edits it; the assembly below stamps the real value).
    let draft: McpServerDraft;
    // Secret keys the JSON TEXT itself declared (issue #901): only these
    // need the Form-mode value entry below -- a remote row's dormant
    // keychain keys (restored out-of-band by withDormantEnv) already have
    // keychain values and must not block the save.
    let jsonSecretKeys: string[] = [];
    if (mode === "json") {
      const result = tryParseConfig(jsonText);
      if (!result.ok) {
        setJsonError(result.error);
        return;
      }
      jsonSecretKeys = [
        ...result.config.keychain_env_keys,
        ...result.config.keychain_header_keys,
      ];
      // Dormancy (issue #901): the JSON text cannot carry a remote row's
      // dormant env face (the web format has no field for it), so an empty
      // parsed face keeps the ref's face -- the same preservation the Form
      // path's buildConfigFromForm applies. An internal-format paste that
      // explicitly carries env entries wins.
      draft = withDormantEnv(result.config);
    } else {
      draft = buildConfigFromForm();
    }

    // ADR-0106 + #659: `enabled` is owned by the settings row toggle, not
    // this form (neither Form nor JSON mode edits it). This is the SINGLE
    // assembly point — preserve the existing value on edit (a disabled
    // server stays disabled through an edit) and save enabled for a new
    // server (the blank add-mode initialServer carries `enabled: true`,
    // Decision 4's explicit-intent default).
    const config: McpServerConfig = {
      ...draft,
      enabled: initialServer.enabled,
    };

    // In JSON mode the normalizer detects secret key names but drops their
    // values (secrets must go to the OS keychain, not config). Block save
    // and prompt the user to enter values via Form mode, otherwise the
    // config is written with keychain keys that have no keychain entries.
    // Both faces apply (issue #901): env secrets and header secrets -- but
    // only keys the JSON text itself declared; a legacy remote row's
    // dormant keychain keys already have keychain values.
    if (jsonSecretKeys.length > 0) {
      setError(
        intl.formatMessage(
          {
            id: "settings.mcp.form.secretsRequireFormMode",
            defaultMessage:
              "Secret keys detected ({keys}). Switch to Form mode to enter their values before saving.",
          },
          { keys: jsonSecretKeys.join(", ") },
        ),
      );
      return;
    }

    // Capture secret values from the form's entries (only populated in
    // Form mode — JSON mode never has secret values). One map per face
    // (issue #901): env secrets and header secrets go to distinct keychain
    // accounts.
    const secretsToSet: Record<string, string> = {};
    const headerSecretsToSet: Record<string, string> = {};
    if (mode === "form") {
      for (const entry of envEntries) {
        if (entry.isSecret && entry.value) {
          secretsToSet[entry.key] = entry.value;
        }
      }
      for (const entry of headerEntries) {
        if (entry.isSecret && entry.value) {
          headerSecretsToSet[entry.key] = entry.value;
        }
      }
    }

    setSaving(true);
    setError(null);
    try {
      // 1. Upsert (writes to disk; returns finalized config with minted id).
      const finalized = await upsertMcpServer(config);

      // Persist the minted id so a retry (after a secret/probe failure) is
      // idempotent — without this, a retry sends id="" again and Rust mints
      // a second server (C1).
      setServerId(finalized.id);

      // 2. Write each secret to the OS keychain (ADR-0029 one-shot transfer):
      // env secrets under `mcp-<id>-<env_key>`, header secrets under
      // `mcp-<id>-header-<name>` (issue #901).
      for (const key of finalized.keychain_env_keys) {
        const value = secretsToSet[key];
        if (value) {
          await setMcpServerSecret(finalized.id, key, value);
        }
      }
      for (const name of finalized.keychain_header_keys) {
        const value = headerSecretsToSet[name];
        if (value) {
          await setMcpServerHeaderSecret(finalized.id, name, value);
        }
      }

      // 3. Clear the keychain accounts behind rows the user deleted this
      // session (issue #904), filtered against the finalized config so a
      // re-added name keeps its (possibly re-entered) value. Only Form-mode
      // row removals recorded names — flips and pastes record nothing, and a
      // pure JSON save (no recorded deletion) clears nothing.
      const envClears = [...new Set(deletedSecretKeysRef.current.env)].filter(
        (key) => !finalized.keychain_env_keys.includes(key),
      );
      for (const key of envClears) {
        await clearMcpServerSecret(finalized.id, key);
      }
      const headerClears = [
        ...new Set(deletedSecretKeysRef.current.header),
      ].filter((name) => !finalized.keychain_header_keys.includes(name));
      for (const name of headerClears) {
        await clearMcpServerHeaderSecret(finalized.id, name);
      }

      // 4. Auto-probe so the list shows an immediate status. A probe failure
      // is non-fatal — the server is already saved; surface it as a
      // disconnected probe result so the parent still commits the config
      // and switches to the list view (C2).
      let probeResult: McpProbeResult;
      try {
        probeResult = await probeMcpServer(finalized);
      } catch (probeErr) {
        probeResult = {
          connected: false,
          tools: [],
          error: fmtError(probeErr, intl),
        };
      }

      // 5. Hand the finalized config + probe result back to the list.
      onSaved(finalized, probeResult);
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setSaving(false);
    }
  }

  const title = isEdit ? (
    <FormattedMessage
      id="settings.mcp.form.editTitle"
      defaultMessage="Edit MCP server"
    />
  ) : (
    <FormattedMessage
      id="settings.mcp.form.addTitle"
      defaultMessage="New MCP server"
    />
  );

  return (
    <div data-testid="mcp-server-form">
      {/* Back link */}
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground mb-2 flex items-center gap-1.5 text-sm"
        onClick={onCancel}
        disabled={saving}
      >
        <ArrowLeft className="size-4" aria-hidden />
        <FormattedMessage
          id="settings.mcp.backToList"
          defaultMessage="Back to MCP list"
        />
      </button>

      <PaneHeader
        className="mb-3"
        title={title}
        description={(
          <FormattedMessage
            id="settings.mcp.form.description"
            defaultMessage="Configure how this MCP server connects. Secret values are stored in the OS keychain and never appear in the config file."
          />
        )}
        action={(
          <div className="flex items-center gap-2">
            {/* Form / JSON toggle */}
            <div className="bg-muted rounded-md flex p-0.5">
              <ModeButton
                active={mode === "form"}
                disabled={saving}
                onClick={() => handleSwitchMode("form")}
              >
                <FormattedMessage
                  id="settings.mcp.form.modeForm"
                  defaultMessage="Form"
                />
              </ModeButton>
              <ModeButton
                active={mode === "json"}
                disabled={saving}
                onClick={() => handleSwitchMode("json")}
              >
                <FormattedMessage
                  id="settings.mcp.form.modeJson"
                  defaultMessage="JSON"
                />
              </ModeButton>
            </div>
          </div>
        )}
      />

      <SettingsCard data-testid="mcp-server-form-card" className="divide-y-0">
        {mode === "form" ? (
          <FormView
            displayName={displayName}
            onDisplayName={setDisplayName}
            transportType={transportType}
            onTransportType={setTransportType}
            command={command}
            onCommand={setCommand}
            argsText={argsText}
            onArgsText={setArgsText}
            url={url}
            onUrl={setUrl}
            envEntries={envEntries}
            envActions={{
              add: envActions.add,
              remove: removeEnvEntry,
              update: envActions.update,
            }}
            headerEntries={headerEntries}
            headerActions={{
              add: headerActions.add,
              remove: removeHeaderEntry,
              update: headerActions.update,
            }}
            timeoutMs={timeoutMs}
            onTimeoutMs={setTimeoutMs}
          />
        ) : (
          <JsonView
            jsonText={jsonText}
            onJsonText={setJsonText}
            jsonError={jsonError}
          />
        )}

        {mode === "json" && (
          <p className="text-muted-foreground px-4 py-1.5 text-sm">
            <FormattedMessage
              id="settings.mcp.form.jsonHint"
              defaultMessage="Supports pasting {example1} or {example2} directly."
              values={{
                example1: "{\"server-name\": {...}}",
                example2: "{\"mcpServers\": {\"server-name\": {...}}}",
              }}
            />
          </p>
        )}

        {error && (
          <p className="settings-error text-destructive px-4 py-1.5 text-sm">
            {error}
          </p>
        )}

        {/* Save / Cancel */}
        <div className="flex items-center gap-2 px-4 py-3">
          <Button
            type="button"
            disabled={!isFormValid || saving}
            onClick={() => void handleSave()}
          >
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {saving ? (
              <FormattedMessage id="common.saving" defaultMessage="Saving…" />
            ) : isEdit ? (
              <FormattedMessage id="common.save" defaultMessage="Save" />
            ) : (
              <FormattedMessage id="common.add" defaultMessage="Add" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={onCancel}
          >
            <FormattedMessage
              id="settings.mcp.form.cancel"
              defaultMessage="Cancel"
            />
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}

// --- Mode toggle button ------------------------------------------------------

function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
        "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

// --- Form view ---------------------------------------------------------------

type FormViewProps = {
  displayName: string;
  onDisplayName: (v: string) => void;
  transportType: "stdio" | "sse" | "http";
  onTransportType: (v: "stdio" | "sse" | "http") => void;
  command: string;
  onCommand: (v: string) => void;
  argsText: string;
  onArgsText: (v: string) => void;
  url: string;
  onUrl: (v: string) => void;
  envEntries: KvEntry[];
  envActions: KvEntryActions;
  headerEntries: KvEntry[];
  headerActions: KvEntryActions;
  timeoutMs: string;
  onTimeoutMs: (v: string) => void;
};

function FormView({
  displayName,
  onDisplayName,
  transportType,
  onTransportType,
  command,
  onCommand,
  argsText,
  onArgsText,
  url,
  onUrl,
  envEntries,
  envActions,
  headerEntries,
  headerActions,
  timeoutMs,
  onTimeoutMs,
}: FormViewProps) {
  return (
    <>
      <SettingsRow
        className="py-2.5"
        title={(
          <Label htmlFor="mcp-display-name" className="text-muted-foreground">
            <FormattedMessage
              id="settings.mcp.form.name"
              defaultMessage="Name"
            />
          </Label>
        )}
      >
        <Input
          id="mcp-display-name"
          value={displayName}
          onChange={(e) => onDisplayName(e.target.value)}
          placeholder="my-mcp-server"
        />
      </SettingsRow>

      <SettingsRow
        className="py-2.5"
        title={(
          <Label htmlFor="mcp-transport" className="text-muted-foreground">
            <FormattedMessage
              id="settings.mcp.form.type"
              defaultMessage="Type"
            />
          </Label>
        )}
      >
        <Select
          value={transportType}
          onValueChange={(v) => onTransportType(v as "stdio" | "sse" | "http")}
        >
          <SelectTrigger id="mcp-transport">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">stdio</SelectItem>
            <SelectItem value="http">HTTP</SelectItem>
            <SelectItem value="sse">SSE</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>

      <SettingsRow
        className="py-2.5"
        title={(
          <Label htmlFor="mcp-timeout" className="text-muted-foreground">
            <FormattedMessage
              id="settings.mcp.form.timeoutMs"
              defaultMessage="Timeout (ms)"
            />
          </Label>
        )}
      >
        <Input
          id="mcp-timeout"
          type="number"
          value={timeoutMs}
          onChange={(e) => onTimeoutMs(e.target.value)}
          placeholder="30000"
        />
      </SettingsRow>

      {transportType === "stdio" ? (
        <>
          <SettingsRow
            className="py-2.5"
            title={(
              <Label htmlFor="mcp-command" className="text-muted-foreground">
                <FormattedMessage
                  id="settings.mcp.form.command"
                  defaultMessage="Command"
                />
              </Label>
            )}
          >
            <Input
              id="mcp-command"
              value={command}
              onChange={(e) => onCommand(e.target.value)}
              placeholder="npx"
            />
          </SettingsRow>
          <SettingsRow
            className="py-2.5"
            title={(
              <Label htmlFor="mcp-args" className="text-muted-foreground">
                <FormattedMessage
                  id="settings.mcp.form.args"
                  defaultMessage="Arguments (space-separated)"
                />
              </Label>
            )}
          >
            <Input
              id="mcp-args"
              value={argsText}
              onChange={(e) => onArgsText(e.target.value)}
              placeholder="-y @modelcontextprotocol/server_memory"
            />
          </SettingsRow>
        </>
      ) : (
        <SettingsRow
          className="py-2.5"
          title={(
            <Label htmlFor="mcp-url" className="text-muted-foreground">
              <FormattedMessage
                id="settings.mcp.form.url"
                defaultMessage="URL"
              />
            </Label>
          )}
        >
          <Input
            id="mcp-url"
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            placeholder="https://mcp.example.com/mcp"
          />
        </SettingsRow>
      )}

      {transportType === "stdio" ? (
        <KvEditor entries={envEntries} isHeaders={false} actions={envActions} />
      ) : (
        <KvEditor
          entries={headerEntries}
          isHeaders
          actions={headerActions}
        />
      )}
    </>
  );
}

// --- Key-value editor (env vars / request headers) ---------------------------

function KvEditor({
  entries,
  isHeaders,
  actions,
}: {
  entries: KvEntry[];
  isHeaders: boolean;
  actions: KvEntryActions;
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(entries.length > 0);

  function handleExpand() {
    setExpanded(true);
    // Auto-add a blank row when expanding with no entries so the user has
    // an immediate input to fill in.
    if (entries.length === 0) {
      actions.add();
    }
  }

  // Label set switches between env-var and header terminology based on
  // transport type (stdio = env vars, http/sse = request headers). Each
  // intl.formatMessage call has a literal id so the formatjs extractor finds it.
  const L = isHeaders
    ? {
        section: intl.formatMessage({
          id: "settings.mcp.form.headers",
          defaultMessage: "Request headers (optional)",
        }),
        add: intl.formatMessage({
          id: "settings.mcp.form.headersAdd",
          defaultMessage: "Add header",
        }),
        empty: intl.formatMessage({
          id: "settings.mcp.form.headersEmpty",
          defaultMessage: "No request headers. Click Add header to create one.",
        }),
        keyLabel: (row: number) =>
          intl.formatMessage(
            {
              id: "settings.mcp.form.headersKeyLabel",
              defaultMessage: "Header name (row {row})",
            },
            { row },
          ),
        valueLabel: (row: number) =>
          intl.formatMessage(
            {
              id: "settings.mcp.form.headersValueLabel",
              defaultMessage: "Header value (row {row})",
            },
            { row },
          ),
        removeLabel: (row: number) =>
          intl.formatMessage(
            {
              id: "settings.mcp.form.headersRemoveLabel",
              defaultMessage: "Remove header (row {row})",
            },
            { row },
          ),
      }
    : {
        section: intl.formatMessage({
          id: "settings.mcp.form.envVars",
          defaultMessage: "Environment variables (optional)",
        }),
        add: intl.formatMessage({
          id: "settings.mcp.form.envAdd",
          defaultMessage: "Add variable",
        }),
        empty: intl.formatMessage({
          id: "settings.mcp.form.envEmpty",
          defaultMessage:
            "No environment variables. Click Add variable to create one.",
        }),
        keyLabel: (row: number) =>
          intl.formatMessage(
            {
              id: "settings.mcp.form.envKeyLabel",
              defaultMessage: "Variable name (row {row})",
            },
            { row },
          ),
        valueLabel: (row: number) =>
          intl.formatMessage(
            {
              id: "settings.mcp.form.envValueLabel",
              defaultMessage: "Variable value (row {row})",
            },
            { row },
          ),
        removeLabel: (row: number) =>
          intl.formatMessage(
            {
              id: "settings.mcp.form.envRemoveLabel",
              defaultMessage: "Remove variable (row {row})",
            },
            { row },
          ),
      };

  return (
    <div data-testid="mcp-kv-editor" className="px-4 py-2.5">
      {/* Collapsible header — click to expand/collapse */}
      {!expanded ? (
        <button
          type="button"
          onClick={handleExpand}
          className="flex w-full items-center gap-1.5 text-left"
        >
          <ChevronRight
            className="text-muted-foreground size-4 shrink-0"
            aria-hidden
          />
          <span className="text-muted-foreground text-sm font-medium">
            {L.section}
          </span>
        </button>
      ) : (
        <>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="flex items-center gap-1.5 text-left"
            >
              <ChevronRight
                className="text-muted-foreground size-4 shrink-0 rotate-90"
                aria-hidden
              />
              <span className="text-muted-foreground text-sm font-medium">
                {L.section}
              </span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={actions.add}
            >
              <Plus className="size-4" aria-hidden />
              {L.add}
            </Button>
          </div>

          {entries.length === 0 ? (
            <p className="text-muted-foreground text-xs">{L.empty}</p>
          ) : (
            <div className="space-y-1.5">
              {entries.map((entry, i) => (
                <div key={entry.id} className="flex items-center gap-2">
                  <Input
                    className="w-40 font-mono text-xs"
                    value={entry.key}
                    onChange={(e) =>
                      actions.update(i, { key: e.target.value })}
                    placeholder={isHeaders ? "Header" : "KEY"}
                    aria-label={L.keyLabel(i + 1)}
                  />
                  <Input
                    className="flex-1 font-mono text-xs"
                    value={entry.value}
                    onChange={(e) =>
                      actions.update(i, { value: e.target.value })}
                    placeholder={
                      entry.isSecret ? "Stored in keychain" : "value"
                    }
                    type={entry.isSecret ? "password" : "text"}
                    aria-label={L.valueLabel(i + 1)}
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={entry.isSecret}
                      onChange={(e) =>
                        actions.update(i, { isSecret: e.target.checked })}
                      className="size-3.5 cursor-pointer accent-primary"
                      aria-label={intl.formatMessage(
                        {
                          id: "settings.mcp.form.envSecretLabel",
                          defaultMessage: "Secret (row {row})",
                        },
                        { row: i + 1 },
                      )}
                    />
                    <FormattedMessage
                      id="settings.mcp.form.envSecret"
                      defaultMessage="Secret"
                    />
                  </label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive size-7 shrink-0"
                    onClick={() => actions.remove(i)}
                    aria-label={L.removeLabel(i + 1)}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              ))}
              {entries.some((entry) => entry.isSecret) && (
                <p className="text-muted-foreground text-xs">
                  <FormattedMessage
                    id="settings.mcp.form.secretHint"
                    defaultMessage="Leave a secret row's value empty to keep its stored value; deleting a row clears the stored value when you save."
                  />
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// --- JSON view ---------------------------------------------------------------

function JsonView({
  jsonText,
  onJsonText,
  jsonError,
}: {
  jsonText: string;
  onJsonText: (v: string) => void;
  jsonError: string | null;
}) {
  return (
    <div data-testid="mcp-json-editor" className="px-4 py-2.5">
      <Label className="text-muted-foreground mb-1.5 text-sm">
        <FormattedMessage
          id="settings.mcp.form.jsonFullConfig"
          defaultMessage="Full configuration"
        />
      </Label>
      <Textarea
        value={jsonText}
        onChange={(e) => onJsonText(e.target.value)}
        className="min-h-80 font-mono text-xs"
        spellCheck={false}
        placeholder='{ "my-mcp-server": { "command": "npx", "args": [...] } }'
      />
      {jsonError && (
        <p className="text-destructive mt-2 text-xs">
          <FormattedMessage
            id="settings.mcp.form.jsonError"
            defaultMessage="Invalid JSON: {error}"
            values={{ error: jsonError }}
          />
        </p>
      )}
    </div>
  );
}
