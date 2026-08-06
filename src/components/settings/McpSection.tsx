import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  MinusCircle,
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

// MCP servers settings pane (issue #387). Lists every configured MCP server
// from app-config with a connection status dot, expandable tool list, per-row
// Test button (manual probe_mcp_server), and delete (AlertDialog confirm →
// clear secrets + remove config). v1: the Add button is a placeholder (the
// form page lands in a follow-up ticket).

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

export function McpSection({
  appConfig,
  onCommit,
}: {
  appConfig: AppConfig;
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
}) {
  const intl = useIntl();

  // Probe state keyed by server id. Survives across re-renders; a new server
  // added later starts at "idle" (the add flow lands in a follow-up).
  const [probeStates, setProbeStates] = useState<Record<string, ProbeState>>({});
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const servers = appConfig.mcp_servers.servers;

  const visibleServers = useMemo(() => servers, [servers]);

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
      // Clear each keychain secret first, then remove the config entry
      // (ADR-0029: clear-then-remove so orphaned keychain entries are cleaned).
      // The config removal goes through onCommit (the single persistence write
      // that updates React state + disk), same pattern as profile deletion.
      for (const envKey of deleteTarget.keychainEnvKeys) {
        try {
          await clearMcpServerSecret(deleteTarget.id, envKey);
        } catch {
          // Best effort -- a keychain error on one key does not block removal.
          // The config remove is the primary action; a stale keychain entry is
          // inert (keyed by the removed server's uuid id).
        }
      }
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
        // Clean up local state for the removed server.
        setProbeStates((prev) => {
          const next = { ...prev };
          delete next[deleteTarget.id];
          return next;
        });
        setExpandedRows((prev) => {
          const next = new Set(prev);
          next.delete(deleteTarget.id);
          return next;
        });
        setDeleteTarget(null);
      }
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setDeleting(false);
    }
  }

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
          <Button type="button" size="sm" disabled>
            <Plus className="size-4" aria-hidden />
            <FormattedMessage id="settings.mcp.add" defaultMessage="Add" />
          </Button>
        )}
      />

      <SettingsCard data-testid="mcp-server-list">
        {visibleServers.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            <FormattedMessage
              id="settings.mcp.empty"
              defaultMessage="No MCP servers configured yet. Click Add to set one up."
            />
          </div>
        ) : (
          visibleServers.map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              probeState={probeStates[server.id] ?? { kind: "idle" }}
              expanded={expandedRows.has(server.id)}
              onToggleRow={() => toggleRow(server.id)}
              onProbe={() => void handleProbe(server)}
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
              <AlertDialogCancel
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
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
    </div>
  );
}

type McpServerRowProps = {
  server: McpServerConfig;
  probeState: ProbeState;
  expanded: boolean;
  onToggleRow: () => void;
  onProbe: () => void;
  onDelete: () => void;
};

function McpServerRow({
  server,
  probeState,
  expanded,
  onToggleRow,
  onProbe,
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
          {server.transport.type === "stdio" && (
            <span className="text-muted-foreground ml-2 text-xs">
              {server.transport.command}
            </span>
          )}
          {server.transport.type === "sse" && (
            <span className="text-muted-foreground ml-2 text-xs">
              {server.transport.url}
            </span>
          )}
          {server.transport.type === "http" && (
            <span className="text-muted-foreground ml-2 text-xs">
              {server.transport.url}
            </span>
          )}
        </div>

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

/** The colored status dot reflecting the probe outcome. */
function StatusDot({ probeState }: { probeState: ProbeState }) {
  const className = "size-2.5 shrink-0 rounded-full";
  if (probeState.kind === "idle") {
    return <span className={cn(className, "bg-muted-foreground/40")} aria-hidden />;
  }
  if (probeState.kind === "testing") {
    return <span className={cn(className, "bg-yellow-500 animate-pulse")} aria-hidden />;
  }
  if (probeState.result.connected) {
    return <CheckCircle2 className={cn("size-4 shrink-0 text-green-500")} aria-hidden />;
  }
  return <AlertCircle className={cn("size-4 shrink-0 text-destructive")} aria-hidden />;
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
