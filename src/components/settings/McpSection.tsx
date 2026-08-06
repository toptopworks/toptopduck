import { useState } from "react";
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
  Trash2,
  Zap,
} from "lucide-react";

import type { AppConfig } from "../../types/app-config";
import type { McpProbeResult, McpServerConfig, McpToolInfo } from "../../types/mcp";
import { clearMcpServerSecret, probeMcpServer } from "../../api";
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
import { Button } from "../ui/button";
import { PaneHeader, SettingsCard } from "./settings-chrome";
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
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Monotonic counter that increments each time the import dialog opens, used
  // as the dialog's `key` so React creates a fresh instance (resetting all
  // internal step/state) without a setState-in-effect (react-hooks lint).
  const [importEpoch, setImportEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const servers = appConfig.mcp_servers.servers;

  function handleAdd() {
    setFormTarget({
      server: {
        id: "",
        display_name: "",
        transport: { type: "stdio", command: "", args: [] },
        env: {},
        keychain_env_keys: [],
        timeout_ms: null,
      },
      isEdit: false,
    });
  }

  function handleEdit(server: McpServerConfig) {
    setFormTarget({ server, isEdit: true });
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
        const others = cfg.mcp_servers.servers.filter((s) => s.id !== finalized.id);
        return {
          ...cfg,
          mcp_servers: {
            ...cfg.mcp_servers,
            servers: [...others, finalized],
          },
        };
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
        const others = cfg.mcp_servers.servers.filter((s) => !existingIds.has(s.id));
        return {
          ...cfg,
          mcp_servers: {
            ...cfg.mcp_servers,
            servers: [...others, ...results.map((r) => r.config)],
          },
        };
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
      setProbeStates((prev) => ({ ...prev, [server.id]: { kind: "done", result } }));
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
      const err = await onCommit((cfg) => ({
        ...cfg,
        mcp_servers: {
          ...cfg.mcp_servers,
          servers: cfg.mcp_servers.servers.filter((s) => s.id !== deleteTarget.id),
        },
      }));
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
        title={<FormattedMessage id="settings.nav.mcp" defaultMessage="MCP Servers" />}
        description={(
          <FormattedMessage
            id="settings.mcp.description"
            defaultMessage="External Model Context Protocol servers add tools the agent can call. Test a server to verify connectivity and list its tools."
          />
        )}
        action={(
          <div className="flex gap-2">
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
              <FormattedMessage id="settings.mcp.import.button" defaultMessage="Import" />
            </Button>
            <Button type="button" size="sm" onClick={handleAdd}>
              <Plus className="size-4" aria-hidden />
              <FormattedMessage id="settings.mcp.add" defaultMessage="Add" />
            </Button>
          </div>
        )}
      />

      <SettingsCard data-testid="mcp-server-list">
        {servers.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            <FormattedMessage
              id="settings.mcp.empty"
              defaultMessage="No MCP servers configured yet. Click Add to set one up."
            />
          </div>
        ) : (
          servers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              probeState={probeStates[server.id] ?? { kind: "idle" }}
              expanded={expandedRows.has(server.id)}
              onToggleRow={() => toggleRow(server.id)}
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

      {error && <p className="settings-error mt-3 text-destructive text-sm">{error}</p>}

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
                  defaultMessage="Delete MCP server?"
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
                    id="settings.mcp.confirmDeleteConfirm"
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
  onToggleRow: () => void;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function McpServerRow({
  server,
  probeState,
  expanded,
  onToggleRow,
  onProbe,
  onEdit,
  onDelete,
}: McpServerRowProps) {
  const intl = useIntl();
  return (
    <div data-testid={`mcp-server-row-${server.id}`} className="px-4 py-3">
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
          <span className="text-sm font-medium truncate inline-block">
            {server.display_name}
          </span>
          <span className="text-muted-foreground ml-2 text-xs">
            {"url" in server.transport ? server.transport.url : server.transport.command}
          </span>
        </div>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          aria-label={intl.formatMessage(
            { id: "settings.mcp.editLabel", defaultMessage: "Edit server {name}" },
            { name: server.display_name },
          )}
          onClick={onEdit}
        >
          <Pencil className="size-4" aria-hidden />
        </Button>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={probeState.kind === "testing"}
          onClick={onProbe}
        >
          {probeState.kind === "testing" ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Zap className="size-4" aria-hidden />
          )}
          <FormattedMessage id="settings.mcp.test" defaultMessage="Test" />
        </Button>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive shrink-0"
          aria-label={intl.formatMessage(
            { id: "settings.mcp.deleteLabel", defaultMessage: "Delete server {name}" },
            { name: server.display_name },
          )}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
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
      <span role="img" aria-label="Not tested" className={cn(dotClass, "bg-muted-foreground/40")} />
    );
  }
  if (probeState.kind === "testing") {
    return (
      <span role="img" aria-label="Testing" className={cn(dotClass, "bg-yellow-500 animate-pulse")} />
    );
  }
  if (probeState.result.connected) {
    return (
      <CheckCircle2 role="img" aria-label="Connected" className={cn("size-4 shrink-0 text-green-500")} />
    );
  }
  return (
    <AlertCircle role="img" aria-label="Connection failed" className={cn("size-4 shrink-0 text-destructive")} />
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
        <FormattedMessage id="settings.mcp.probing" defaultMessage="Testing…" />
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
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left font-medium px-2 py-1.5">
              <FormattedMessage id="settings.mcp.toolName" defaultMessage="Tool" />
            </th>
            <th className="text-left font-medium px-2 py-1.5">
              <FormattedMessage id="settings.mcp.toolDescription" defaultMessage="Description" />
            </th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.name} className="border-border border-t">
              <td className="font-mono px-2 py-1.5 whitespace-nowrap">{tool.name}</td>
              <td className="text-muted-foreground px-2 py-1.5 break-words">
                {tool.description || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
