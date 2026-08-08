import { useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { FormattedMessage, useIntl } from "react-intl";

import type { McpProbeResult, McpServerConfig, McpTransport } from "../../types/mcp";
import { probeMcpServer, setMcpServerSecret, upsertMcpServer } from "../../api";
import { fmtError } from "../../lib/error-presentation";
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
// upsertMcpServer → setMcpServerSecret (per secret env key) → auto probe →
// onSaved callback returns the finalized config + probe result to the list.
//
// Secrets never appear in the JSON view — only the keychain_env_keys key names.
// Secret values are transient form state; on save they go to the OS keychain
// via setMcpServerSecret and are never serialized into app-config.

/** One row of the env-var editor. `isSecret` routes the value to the OS
 *  keychain (via setMcpServerSecret on save) instead of the `env` map. */
type EnvEntry = {
  id: number;
  key: string;
  value: string;
  isSecret: boolean;
};

// Monotonic counter for stable EnvEntry keys (H1: index-based keys break
// focus/cursor when rows are inserted or deleted mid-list).
let envEntrySeq = 0;

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

/** Build the initial env-entry list from an existing config: non-secret entries
 *  from `env`, secret entries (value empty — keychain is one-way) from
 *  `keychain_env_keys`. */
function initEnvEntries(server: McpServerConfig): EnvEntry[] {
  const entries: EnvEntry[] = Object.entries(server.env).map(([key, value]) => ({
    id: envEntrySeq++,
    key,
    value,
    isSecret: false,
  }));
  for (const key of server.keychain_env_keys) {
    entries.push({ id: envEntrySeq++, key, value: "", isSecret: true });
  }
  return entries;
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
  // initEnvEntries reconstructs with empty values).
  const pendingSecrets = useRef<Record<string, string>>({});

  // --- Flat form state (single source of truth for Form mode) ---------------
  const [displayName, setDisplayName] = useState(initialServer.display_name);
  const [transportType, setTransportType] = useState<"stdio" | "sse" | "http">(
    initialServer.transport.type,
  );
  const [command, setCommand] = useState(
    initialServer.transport.type === "stdio" ? initialServer.transport.command : "",
  );
  const [argsText, setArgsText] = useState(
    initialServer.transport.type === "stdio"
      ? initialServer.transport.args.join(" ")
      : "",
  );
  const [url, setUrl] = useState(
    "url" in initialServer.transport ? initialServer.transport.url : "",
  );
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>(() =>
    initEnvEntries(initialServer),
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
        const c = JSON.parse(jsonText) as McpServerConfig;
        if (!c.display_name?.trim()) return false;
        return c.transport.type === "stdio"
          ? !!c.transport.command?.trim()
          : !!c.transport.url?.trim();
      } catch {
        return false;
      }
    }
    return displayName.trim() !== "" && (
      transportType === "stdio"
        ? command.trim() !== ""
        : url.trim() !== ""
    );
  }, [mode, jsonText, displayName, transportType, command, url]);

  // Build a McpServerConfig from the current form fields.
  function buildConfigFromForm(): McpServerConfig {
    const transport: McpTransport =
      transportType === "stdio"
        ? {
            type: "stdio",
            command,
            args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
          }
        : { type: transportType, url };

    const env: Record<string, string> = {};
    const keychainEnvKeys: string[] = [];
    for (const entry of envEntries) {
      if (!entry.key) continue;
      if (entry.isSecret) {
        keychainEnvKeys.push(entry.key);
      } else {
        env[entry.key] = entry.value;
      }
    }

    return {
      id: serverId,
      display_name: displayName,
      transport,
      env,
      keychain_env_keys: keychainEnvKeys,
      // Guard against NaN: type="number" rejects most non-numeric input, but
      // a paste / programmatic value could still produce NaN (Rust rejects it,
      // surfacing an error — cleaner to fall back to null here).
      timeout_ms:
        timeoutMs.trim() && !Number.isNaN(Number(timeoutMs))
          ? Number(timeoutMs)
          : null,
    };
  }

  /** Parse JSON text into a McpServerConfig, returning an error string on
   *  failure. Shared by mode-switch and save to avoid duplicating the
   *  try/catch (M7). */
  function tryParseConfig(
    text: string,
  ): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
    try {
      return { ok: true, config: JSON.parse(text) as McpServerConfig };
    } catch (e) {
      return { ok: false, error: fmtError(e, intl) };
    }
  }

  /** Sync FROM JSON text → flat form state (called when switching JSON → Form). */
  function syncFromJson(parsed: McpServerConfig): void {
    setDisplayName(parsed.display_name);
    setTransportType(parsed.transport.type);
    if (parsed.transport.type === "stdio") {
      setCommand(parsed.transport.command);
      setArgsText(parsed.transport.args.join(" "));
      setUrl("");
    } else {
      setUrl(parsed.transport.url);
      setCommand("");
      setArgsText("");
    }
    setEnvEntries(
      // Restore secret values captured before the Form→JSON switch so they
      // survive the round-trip (H2).
      initEnvEntries(parsed).map((entry) =>
        entry.isSecret && pendingSecrets.current[entry.key]
          ? { ...entry, value: pendingSecrets.current[entry.key] }
          : entry,
      ),
    );
    setTimeoutMs(parsed.timeout_ms !== null ? String(parsed.timeout_ms) : "");
  }

  function handleSwitchMode(next: FormMode) {
    if (next === mode) return;
    if (next === "json") {
      // Capture ALL secret key names + values before serializing so they
      // survive the JSON round-trip (H2). keychain_env_keys is stripped from
      // the JSON view entirely — it is an implementation detail the user
      // should not edit directly.
      pendingSecrets.current = {};
      for (const entry of envEntries) {
        if (entry.isSecret) {
          pendingSecrets.current[entry.key] = entry.value;
        }
      }
      // Serialize config WITHOUT keychain_env_keys — the user manages secrets
      // through the Form's Secret checkbox, not via raw JSON.
      const config = buildConfigFromForm();
      const jsonConfig = { ...config, keychain_env_keys: undefined };
      delete jsonConfig.keychain_env_keys;
      setJsonText(JSON.stringify(jsonConfig, null, 2));
      setJsonError(null);
    } else {
      // Parse JSON text → form state. If invalid, abort the switch and show
      // an error so the user can fix the JSON before returning to Form mode.
      const result = tryParseConfig(jsonText);
      if (!result.ok) {
        setJsonError(result.error);
        return;
      }
      // Re-inject secret key names captured before the Form→JSON switch so
      // initEnvEntries reconstructs the secret rows correctly.
      result.config.keychain_env_keys = Object.keys(pendingSecrets.current);
      syncFromJson(result.config);
      setJsonError(null);
    }
    setMode(next);
  }

  function addEnvEntry() {
    setEnvEntries((prev) => [
      ...prev,
      { id: envEntrySeq++, key: "", value: "", isSecret: false },
    ]);
  }

  function removeEnvEntry(index: number) {
    setEnvEntries((prev) => prev.filter((_, i) => i !== index));
  }

  function updateEnvEntry(index: number, patch: Partial<EnvEntry>) {
    setEnvEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    );
  }

  async function handleSave() {
    // Build the config from the active mode.
    let config: McpServerConfig;
    if (mode === "json") {
      const result = tryParseConfig(jsonText);
      if (!result.ok) {
        setJsonError(result.error);
        return;
      }
      config = result.config;
    } else {
      config = buildConfigFromForm();
    }

    // Capture secret values from the form's env entries (only populated in
    // Form mode — JSON mode never has secret values).
    const secretsToSet: Record<string, string> = {};
    if (mode === "form") {
      for (const entry of envEntries) {
        if (entry.isSecret && entry.value) {
          secretsToSet[entry.key] = entry.value;
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

      // 2. Write each secret to the OS keychain (ADR-0029 one-shot transfer).
      for (const key of finalized.keychain_env_keys) {
        const value = secretsToSet[key];
        if (value) {
          await setMcpServerSecret(finalized.id, key, value);
        }
      }

      // 3. Auto-probe so the list shows an immediate status. A probe failure
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

      // 4. Hand the finalized config + probe result back to the list.
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

      <SettingsCard data-testid="mcp-server-form-card">
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
            onAddEnv={addEnvEntry}
            onRemoveEnv={removeEnvEntry}
            onUpdateEnv={updateEnvEntry}
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
      </SettingsCard>

      {error && <p className="settings-error mt-3 text-destructive text-sm">{error}</p>}

      {/* Save / Cancel */}
      <div className="mt-3 flex items-center gap-2">
        <Button type="button" disabled={!isFormValid || saving} onClick={() => void handleSave()}>
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {saving ? (
            <FormattedMessage
              id="common.saving"
              defaultMessage="Saving…"
            />
          ) : isEdit ? (
            <FormattedMessage
              id="common.save"
              defaultMessage="Save"
            />
          ) : (
            <FormattedMessage
              id="common.add"
              defaultMessage="Add"
            />
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
  envEntries: EnvEntry[];
  onAddEnv: () => void;
  onRemoveEnv: (index: number) => void;
  onUpdateEnv: (index: number, patch: Partial<EnvEntry>) => void;
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
  onAddEnv,
  onRemoveEnv,
  onUpdateEnv,
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
          placeholder="My MCP Server"
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
              placeholder="/usr/local/bin/mcp-server"
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
              placeholder="--port 8080 --verbose"
            />
          </SettingsRow>
        </>
      ) : (
        <SettingsRow
          className="py-2.5"
          title={(
            <Label htmlFor="mcp-url" className="text-muted-foreground">
              <FormattedMessage id="settings.mcp.form.url" defaultMessage="URL" />
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

      <EnvEditor
        entries={envEntries}
        onAdd={onAddEnv}
        onRemove={onRemoveEnv}
        onUpdate={onUpdateEnv}
      />
    </>
  );
}

// --- Env var editor ----------------------------------------------------------

function EnvEditor({
  entries,
  onAdd,
  onRemove,
  onUpdate,
}: {
  entries: EnvEntry[];
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<EnvEntry>) => void;
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(entries.length > 0);

  function handleExpand() {
    setExpanded(true);
    // Auto-add a blank row when expanding with no entries so the user has
    // an immediate input to fill in.
    if (entries.length === 0) {
      onAdd();
    }
  }

  return (
    <div data-testid="mcp-env-editor" className="px-4 py-2.5">
      {/* Collapsible header — click to expand/collapse */}
      {!expanded ? (
        <button
          type="button"
          onClick={handleExpand}
          className="flex w-full items-center gap-1.5 text-left"
        >
          <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <span className="text-muted-foreground text-sm font-medium">
            <FormattedMessage
              id="settings.mcp.form.envVars"
              defaultMessage="Environment variables (optional)"
            />
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
                <FormattedMessage
                  id="settings.mcp.form.envVars"
                  defaultMessage="Environment variables (optional)"
                />
              </span>
            </button>
            <Button type="button" variant="ghost" size="sm" onClick={onAdd}>
              <Plus className="size-4" aria-hidden />
              <FormattedMessage
                id="settings.mcp.form.envAdd"
                defaultMessage="Add variable"
              />
            </Button>
          </div>

          {entries.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              <FormattedMessage
                id="settings.mcp.form.envEmpty"
                defaultMessage="No environment variables. Click Add variable to create one."
              />
            </p>
          ) : (
            <div className="space-y-1.5">
              {entries.map((entry, i) => (
                <div key={entry.id} className="flex items-center gap-2">
                  <Input
                    className="w-40 font-mono text-xs"
                    value={entry.key}
                    onChange={(e) => onUpdate(i, { key: e.target.value })}
                    placeholder="KEY"
                    aria-label={intl.formatMessage(
                      { id: "settings.mcp.form.envKeyLabel", defaultMessage: "Variable name (row {row})" },
                      { row: i + 1 },
                    )}
                  />
                  <Input
                    className="flex-1 font-mono text-xs"
                    value={entry.value}
                    onChange={(e) => onUpdate(i, { value: e.target.value })}
                    placeholder={entry.isSecret ? "Stored in keychain" : "value"}
                    type={entry.isSecret ? "password" : "text"}
                    aria-label={intl.formatMessage(
                      { id: "settings.mcp.form.envValueLabel", defaultMessage: "Variable value (row {row})" },
                      { row: i + 1 },
                    )}
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={entry.isSecret}
                      onChange={(e) => onUpdate(i, { isSecret: e.target.checked })}
                      className="size-3.5 cursor-pointer accent-primary"
                      aria-label={intl.formatMessage(
                        { id: "settings.mcp.form.envSecretLabel", defaultMessage: "Secret (row {row})" },
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
                    onClick={() => onRemove(i)}
                    aria-label={intl.formatMessage(
                      { id: "settings.mcp.form.envRemoveLabel", defaultMessage: "Remove variable (row {row})" },
                      { row: i + 1 },
                    )}
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              ))}
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
      <Textarea
        value={jsonText}
        onChange={(e) => onJsonText(e.target.value)}
        className="min-h-80 font-mono text-xs"
        spellCheck={false}
        placeholder="{ &quot;id&quot;: &quot;&quot;, &quot;display_name&quot;: &quot;...&quot; }"
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
