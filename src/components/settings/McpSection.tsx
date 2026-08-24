import { useMemo, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  MinusCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

import type { AppConfig } from "../../types/app-config";
import type {
  McpProbeResult,
  McpServerConfig,
  McpToolInfo,
} from "../../types/mcp";
import {
  clearMcpServerSecret,
  probeMcpServer,
  upsertMcpServer,
} from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { cn } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  PaneHeader,
  SETTINGS_TOOLTIP_CLASS,
  SettingsCard,
} from "./settings-chrome";
import { McpImportDialog } from "./McpImportDialog";
import { McpServerForm } from "./McpServerForm";

// MCP servers settings pane (issue #387 + #388). Two sub-views managed by local
// state: "list" shows every configured server with a connection status dot,
// expandable tool list, per-row Test/Edit/Delete buttons; "form" shows the
// add/edit form (Form/JSON dual-mode) for one server. The Add button and each
// row's Edit button switch to the form; the form's back link returns to the
// list. After save, the form hands the finalized config + probe result back so
// the list shows the new entry + its status dot immediately.

/** Per-server probe status held in local state (issue #387). The initial state
 *  is "untested" (gray); the Test button transitions through "testing" →
 *  "connected" (green) / "failed" (red). */
type ProbeState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "done"; result: McpProbeResult };

type DeleteTarget = {
  id: string;
  displayName: string;
  keychainEnvKeys: string[];
};

type FormTarget = {
  server: McpServerConfig;
  isEdit: boolean;
};

/** Commit shape shared by every write path in this section: rebuild the MCP
 *  server list inside an AppConfig immutably. Callers pass the already
 *  rebuilt slice (map-replace preserves row order for the toggle; save /
 *  import / delete rebuild via filter). */
function withMcpServers(cfg: AppConfig, servers: McpServerConfig[]): AppConfig {
  return { ...cfg, mcp_servers: { ...cfg.mcp_servers, servers } };
}

export function McpSection({
  appConfig,
  onCommit,
}: {
  appConfig: AppConfig;
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
}) {
  const intl = useIntl();

  // Sub-view: "list" (server list) or "form" (add/edit one server).
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);

  // Probe state keyed by server id. Survives across re-renders; the form's
  // onSaved callback seeds the entry for a newly added/edited server.
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>(
    {},
  );
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Monotonic counter that increments each time the import dialog opens, used
  // as the dialog's `key` so React creates a fresh instance (resetting all
  // internal step/state) without a setState-in-effect (react-hooks lint).
  const [importEpoch, setImportEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // The server whose enable toggle write is in flight (gates just that row's
  // switch so a slow write does not freeze the whole list).
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const servers = appConfig.mcp_servers.servers;
  const existingNames = useMemo(
    () => new Set(servers.map((s) => s.display_name)),
    [servers],
  );
  const filteredServers = searchQuery.trim()
    ? servers.filter((s) =>
        s.display_name.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : servers;

  function handleAdd() {
    setFormTarget({
      server: {
        id: "",
        display_name: "",
        transport: { type: "stdio", command: "", args: [] },
        env: {},
        keychain_env_keys: [],
        timeout_ms: null,
        // A new server saves enabled (ADR-0106 Decision 4 -- the form's save
        // is explicit intent); the row toggle is the only writer afterwards.
        enabled: true,
      },
      isEdit: false,
    });
  }

  function handleEdit(server: McpServerConfig) {
    setFormTarget({ server, isEdit: true });
  }

  /** ADR-0106: the row-level enable toggle. One field edit over the SAME
   *  upsert path the form uses (no dedicated switch IPC -- the toggle is an
   *  upsert, nothing more). Enabled = the server enters every session's
   *  effective tool surface; disabled = dormant (no connect, no spawn, no
   *  keychain secret read). Persists on disk, then syncs the React-state
   *  mirror like every other write here. */
  async function handleToggleEnabled(
    server: McpServerConfig,
    enabled: boolean,
  ) {
    setTogglingId(server.id);
    setError(null);
    try {
      const finalized = await upsertMcpServer({ ...server, enabled });
      const err = await onCommit((cfg) =>
        withMcpServers(
          cfg,
          cfg.mcp_servers.servers.map((s) =>
            s.id === finalized.id ? finalized : s,
          ),
        ),
      );
      if (err) setError(err);
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setTogglingId(null);
    }
  }

  /** Called by the form after upsert + secrets + probe complete. Syncs the
   *  finalized config into React state, stores the probe result, and returns
   *  to the list. Handles both onCommit rejection and resolve-to-error so
   *  no failure path is silently swallowed (C3). */
  async function handleFormSaved(
    finalized: McpServerConfig,
    probeResult: McpProbeResult,
  ) {
    setProbeStates((prev) => ({
      ...prev,
      [finalized.id]: { kind: "done", result: probeResult },
    }));
    if (probeResult.connected) {
      setExpandedRows((prev) => new Set(prev).add(finalized.id));
    }
    // Sync the finalized config into React state so the list shows the
    // new/updated entry immediately. Both rejection and resolve-to-error
    // are surfaced so the user knows the commit failed (C3).
    try {
      const err = await onCommit((cfg) => {
        const others = cfg.mcp_servers.servers.filter(
          (s) => s.id !== finalized.id,
        );
        return withMcpServers(cfg, [...others, finalized]);
      });
      if (err) setError(err);
    } catch (e) {
      setError(fmtError(e, intl));
    }
    setFormTarget(null);
  }

  /** Called by the import dialog after batch upsert + probe complete. Syncs
   *  each finalized config into React state and stores probe results so the
   *  list shows the new entries + status dots immediately (issue #390). */
  async function handleImported(
    results: { config: McpServerConfig; probeResult: McpProbeResult }[],
  ) {
    // Seed probe states for all imported servers.
    setProbeStates((prev) => {
      const next = { ...prev };
      for (const { config, probeResult } of results) {
        next[config.id] = { kind: "done", result: probeResult };
      }
      return next;
    });
    // Auto-expand connected servers so the user sees the tools.
    setExpandedRows((prev) => {
      const next = new Set(prev);
      for (const { config, probeResult } of results) {
        if (probeResult.connected) next.add(config.id);
      }
      return next;
    });
    // Sync all imported configs into React state (one commit for the batch).
    try {
      const err = await onCommit((cfg) => {
        const existingIds = new Set(results.map((r) => r.config.id));
        const others = cfg.mcp_servers.servers.filter(
          (s) => !existingIds.has(s.id),
        );
        return withMcpServers(cfg, [
          ...others,
          ...results.map((r) => r.config),
        ]);
      });
      if (err) setError(err);
    } catch (e) {
      setError(fmtError(e, intl));
    }
  }

  function toggleRow(id: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleProbe(server: McpServerConfig) {
    setProbeStates((prev) => ({ ...prev, [server.id]: { kind: "testing" } }));
    setError(null);
    try {
      const result = await probeMcpServer(server);
      setProbeStates((prev) => ({
        ...prev,
        [server.id]: { kind: "done", result },
      }));
      // Auto-expand the row so the user sees the tools immediately on success.
      if (result.connected) {
        setExpandedRows((prev) => new Set(prev).add(server.id));
      }
    } catch (e) {
      setProbeStates((prev) => ({
        ...prev,
        [server.id]: {
          kind: "done",
          result: { connected: false, tools: [], error: fmtError(e, intl) },
        },
      }));
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      // Remove the config entry first (the primary action). If this fails,
      // the server is still intact — secrets are preserved (reversed from
      // the original clear-then-remove order to avoid a partial-failure
      // window where secrets are wiped but the config persists).
      const err = await onCommit((cfg) =>
        withMcpServers(
          cfg,
          cfg.mcp_servers.servers.filter((s) => s.id !== deleteTarget.id),
        ),
      );
      if (err) {
        setError(err);
      } else {
        // Config removed — clean up local state for the removed server.
        const removedId = deleteTarget.id;
        const removedKeys = deleteTarget.keychainEnvKeys;
        setProbeStates((prev) => {
          const next = { ...prev };
          delete next[removedId];
          return next;
        });
        setExpandedRows((prev) => {
          const next = new Set(prev);
          next.delete(removedId);
          return next;
        });
        setDeleteTarget(null);
        // Clear keychain secrets after successful config removal (best
        // effort). An orphaned keychain entry is inert — keyed by the
        // removed server's uuid id, nothing reads it.
        for (const envKey of removedKeys) {
          try {
            await clearMcpServerSecret(removedId, envKey);
          } catch (e) {
            console.warn("keychain clear failed for", removedId, envKey, e);
          }
        }
      }
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setDeleting(false);
    }
  }

  // --- Form view ----------------------------------------------------------
  if (formTarget) {
    return (
      <McpServerForm
        key={formTarget.server.id || "new"}
        initialServer={formTarget.server}
        isEdit={formTarget.isEdit}
        onSaved={(finalized, probeResult) =>
          void handleFormSaved(finalized, probeResult)}
        onCancel={() => setFormTarget(null)}
      />
    );
  }

  // --- List view ----------------------------------------------------------
  return (
    <div>
      <PaneHeader
        title={(
          <FormattedMessage
            id="settings.nav.mcp"
            defaultMessage="MCP Servers"
          />
        )}
        description={(
          <FormattedMessage
            id="settings.mcp.description"
            defaultMessage="External Model Context Protocol servers add tools the agent can call. Test a server to verify connectivity and list its tools."
          />
        )}
        action={(
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" onClick={handleAdd}>
              <Plus className="size-4" aria-hidden />
              <FormattedMessage id="settings.mcp.new" defaultMessage="New" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setImportEpoch((n) => n + 1);
                setImportOpen(true);
              }}
            >
              <Download className="size-4" aria-hidden />
              <FormattedMessage id="common.import" defaultMessage="Import" />
            </Button>
          </div>
        )}
      />

      {servers.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <Search
            className="text-muted-foreground size-4 shrink-0"
            aria-hidden
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.mcp.searchPlaceholder",
              defaultMessage: "Search servers…",
            })}
            className="text-muted-foreground placeholder:text-muted-foreground/70 focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 h-8 flex-1 rounded-md border-0 bg-transparent text-sm outline-none"
          />
        </div>
      )}

      {servers.length > 0 && (
        <p className="mb-2 text-sm">
          <FormattedMessage
            id="settings.mcp.configuredCount"
            defaultMessage="Configured MCP servers <muted>{count}</muted>"
            values={{
              count: servers.length,
              muted: (chunks: ReactNode) => (
                <span className="text-muted-foreground">{chunks}</span>
              ),
            }}
          />
        </p>
      )}

      <SettingsCard data-testid="mcp-server-list">
        {servers.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            <FormattedMessage
              id="settings.mcp.empty"
              defaultMessage="No MCP servers configured yet. Click Add to set one up."
            />
          </div>
        ) : filteredServers.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            <FormattedMessage
              id="settings.mcp.noResults"
              defaultMessage='No servers match "{query}".'
              values={{ query: searchQuery.trim() }}
            />
          </div>
        ) : (
          filteredServers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              probeState={probeStates[server.id] ?? { kind: "idle" }}
              expanded={expandedRows.has(server.id)}
              toggling={togglingId === server.id}
              onToggleRow={() => toggleRow(server.id)}
              onToggleEnabled={(next) => void handleToggleEnabled(server, next)}
              onProbe={() => void handleProbe(server)}
              onEdit={() => handleEdit(server)}
              onDelete={() =>
                setDeleteTarget({
                  id: server.id,
                  displayName: server.display_name,
                  keychainEnvKeys: server.keychain_env_keys,
                })}
            />
          ))
        )}
      </SettingsCard>

      {error && (
        <p className="settings-error mt-3 text-destructive text-sm">{error}</p>
      )}

      {deleteTarget && (
        <AlertDialog
          defaultOpen
          onOpenChange={(open) => {
            if (!open && !deleting) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="settings.mcp.confirmDeleteTitle"
                  defaultMessage="Delete MCP server {name}?"
                  values={{ name: deleteTarget.displayName }}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.mcp.confirmDeleteBody"
                  defaultMessage="This permanently removes the server {name} and clears its stored secrets. This cannot be undone."
                  values={{ name: deleteTarget.displayName }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                <FormattedMessage
                  id="settings.mcp.confirmDeleteCancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={deleting}
                onClick={(e) => {
                  // Prevent Radix AlertDialog auto-close so the deleting state
                  // can render while the IPC runs (cf. PR #136 pattern).
                  e.preventDefault();
                  void handleConfirmDelete();
                }}
              >
                {deleting ? (
                  <FormattedMessage
                    id="settings.mcp.deleting"
                    defaultMessage="Deleting…"
                  />
                ) : (
                  <FormattedMessage
                    id="common.delete"
                    defaultMessage="Delete"
                  />
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      <McpImportDialog
        key={importEpoch}
        open={importOpen}
        existingNames={existingNames}
        onClose={() => setImportOpen(false)}
        onImported={(results) => void handleImported(results)}
      />
    </div>
  );
}

type McpServerRowProps = {
  server: McpServerConfig;
  probeState: ProbeState;
  expanded: boolean;
  /** The row's enable-toggle write is in flight (ADR-0106): the switch is
   *  gated off so a second click cannot stack onto the pending upsert. */
  toggling: boolean;
  onToggleRow: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function McpServerRow({
  server,
  probeState,
  expanded,
  toggling,
  onToggleRow,
  onToggleEnabled,
  onProbe,
  onEdit,
  onDelete,
}: McpServerRowProps) {
  const intl = useIntl();
  return (
    <div
      data-testid={`mcp-server-row-${server.id}`}
      className="hover:bg-accent/50 px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer"
          onClick={onToggleRow}
          aria-label={server.display_name}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          )}
        </button>

        <StatusDot probeState={probeState} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-sm font-medium truncate",
                // A disabled server is dormant (ADR-0106): the quieted name
                // keeps the row's state legible at a glance.
                !server.enabled && "text-muted-foreground",
              )}
            >
              {server.display_name}
            </span>
            {probeState.kind === "done" &&
              probeState.result.connected &&
              probeState.result.tools.length > 0 && (
              <Badge
                variant="secondary"
                className="shrink-0 text-muted-foreground font-normal"
              >
                <FormattedMessage
                  id="settings.mcp.toolCount"
                  defaultMessage="{count} tools"
                  values={{ count: probeState.result.tools.length }}
                />
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground mt-1 truncate text-xs">
            {server.transport.type}
            {" · "}
            {"url" in server.transport
              ? server.transport.url
              : server.transport.command}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {/* The enable toggle (ADR-0106): the row's machine-level state.
           * Sits BEFORE the action buttons so it reads as the row's primary
           * control, not an action. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Switch
                checked={server.enabled}
                disabled={toggling}
                onCheckedChange={onToggleEnabled}
                aria-label={intl.formatMessage(
                  {
                    id: "settings.mcp.enableToggleLabel",
                    defaultMessage: "Toggle server {name}",
                  },
                  { name: server.display_name },
                )}
                className="mr-1.5"
              />
            </TooltipTrigger>
            <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
              {server.enabled ? (
                <FormattedMessage
                  id="settings.mcp.enabledTooltip"
                  defaultMessage="Enabled"
                />
              ) : (
                <FormattedMessage
                  id="settings.mcp.disabledTooltip"
                  defaultMessage="Disabled"
                />
              )}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground h-7 w-7 p-0"
                disabled={probeState.kind === "testing"}
                aria-label={intl.formatMessage(
                  {
                    id: "settings.mcp.testLabel",
                    defaultMessage: "Test server {name}",
                  },
                  { name: server.display_name },
                )}
                onClick={onProbe}
              >
                {probeState.kind === "testing" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Zap className="size-4" aria-hidden />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
              <FormattedMessage id="settings.mcp.test" defaultMessage="Test" />
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground h-7 w-7 p-0"
                aria-label={intl.formatMessage(
                  {
                    id: "settings.mcp.editLabel",
                    defaultMessage: "Edit server {name}",
                  },
                  { name: server.display_name },
                )}
                onClick={onEdit}
              >
                <Pencil className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
              <FormattedMessage id="settings.mcp.edit" defaultMessage="Edit" />
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive h-7 w-7 p-0"
                aria-label={intl.formatMessage(
                  {
                    id: "settings.mcp.deleteLabel",
                    defaultMessage: "Delete server {name}",
                  },
                  { name: server.display_name },
                )}
                onClick={onDelete}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
              <FormattedMessage id="common.delete" defaultMessage="Delete" />
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {expanded && <ToolList probeState={probeState} />}
    </div>
  );
}

/** The colored status dot reflecting the probe outcome. Uses `role="img"` +
 *  `aria-label` so screen readers announce the connection state (idle / testing
 *  / connected / failed). */
function StatusDot({ probeState }: { probeState: ProbeState }) {
  const dotClass = "size-2.5 shrink-0 rounded-full";
  if (probeState.kind === "idle") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label="Not tested"
            className={cn(dotClass, "bg-muted-foreground/40 cursor-help")}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
          <FormattedMessage
            id="settings.mcp.notTestedHint"
            defaultMessage="Not tested"
          />
        </TooltipContent>
      </Tooltip>
    );
  }
  if (probeState.kind === "testing") {
    return (
      <span
        role="img"
        aria-label="Testing"
        className={cn(dotClass, "bg-yellow-500 animate-pulse")}
      />
    );
  }
  if (probeState.result.connected) {
    return (
      <CheckCircle2
        role="img"
        aria-label="Connected"
        className={cn("size-4 shrink-0 text-green-500")}
      />
    );
  }
  return (
    <AlertCircle
      role="img"
      aria-label="Connection failed"
      className={cn("size-4 shrink-0 text-destructive")}
    />
  );
}

/** The expandable tool list section. */
function ToolList({ probeState }: { probeState: ProbeState }) {
  if (probeState.kind === "idle") {
    return (
      <div className="text-muted-foreground mt-3 pl-7 text-xs">
        <MinusCircle className="mr-1 inline size-3" aria-hidden />
        <FormattedMessage
          id="settings.mcp.notTested"
          defaultMessage="Not tested yet. Click Test to check connectivity."
        />
      </div>
    );
  }
  if (probeState.kind === "testing") {
    return (
      <div className="text-muted-foreground mt-3 pl-7 text-xs">
        <FormattedMessage id="common.testing" defaultMessage="Testing…" />
      </div>
    );
  }
  const { result } = probeState;
  if (!result.connected) {
    return (
      <div className="text-destructive mt-3 pl-7 text-xs">
        <FormattedMessage
          id="settings.mcp.probeFailed"
          defaultMessage="Connection failed: {error}"
          values={{ error: result.error ?? "unknown error" }}
        />
      </div>
    );
  }
  if (result.tools.length === 0) {
    return (
      <div className="text-muted-foreground mt-3 pl-7 text-xs">
        <FormattedMessage
          id="settings.mcp.noTools"
          defaultMessage="Connected, but the server reported no tools."
        />
      </div>
    );
  }
  return <ToolTable tools={result.tools} />;
}

function ToolTable({ tools }: { tools: McpToolInfo[] }) {
  return (
    <div className="border-border mt-3 ml-7 overflow-hidden rounded-md border">
      <table className="w-full table-fixed text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left font-medium px-2 py-1.5 w-2/5">
              <FormattedMessage
                id="settings.mcp.toolName"
                defaultMessage="Tool"
              />
            </th>
            <th className="text-left font-medium px-2 py-1.5">
              <FormattedMessage
                id="common.description"
                defaultMessage="Description"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.name} className="border-border border-t">
              <td className="font-mono px-2 py-1.5 truncate">{tool.name}</td>
              <td className="text-muted-foreground px-2 py-1.5">
                {tool.description ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block truncate">{tool.description}</span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      className={cn(
                        SETTINGS_TOOLTIP_CLASS,
                        "max-w-sm max-h-40 overflow-y-auto",
                      )}
                    >
                      {tool.description}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
