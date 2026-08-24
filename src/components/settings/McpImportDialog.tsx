import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronRight, Loader2, RefreshCw, X } from "lucide-react";

import type {
  DiscoveredServer,
  ImportSource,
  McpProbeResult,
  McpServerConfig,
} from "../../types/mcp";
import { discoverMcpServers, probeMcpServer, upsertMcpServer } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

// MCP import dialog (issue #390). Mirrors the skill import dialog UX:
// a single dialog that discovers all sources in parallel, groups servers
// by source in collapsible sections with select-all per source, and imports
// the selected servers via batch upsert + auto-probe.
//
// Sources are fixed (Claude Desktop + Codex) — no custom-path picker.
// Discovery runs on dialog open via useQuery; the Refresh button re-scans.
// Partial failures surface inline (succeeded servers are pruned from the
// list; failed ones remain for retry).

/** One source group with its discovered servers and optional discovery error. */
type McpImportSource = {
  id: ImportSource;
  servers: DiscoveredServer[];
  configPath: string | null;
  error: string | null;
};

export type McpImportDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Display names of servers already in the config. Discovered servers
   *  matching these names are filtered out so the user cannot import
   *  duplicates. */
  existingNames: ReadonlySet<string>;
  /** Called after the batch upsert + probe flow completes. The parent syncs
   *  each finalized config into React state + stores the probe result so the
   *  list shows the new entries + status dots immediately. */
  onImported: (results: { config: McpServerConfig; probeResult: McpProbeResult }[]) => void;
};

const SOURCES: ImportSource[] = ["claude_desktop", "codex"];

/** Composite key `${sourceId}::${displayName}` — unique even if two sources
 *  export a server with the same display_name. */
function selectionKey(source: ImportSource, name: string): string {
  return `${source}::${name}`;
}

export function McpImportDialog({ open, onClose, existingNames, onImported }: McpImportDialogProps) {
  const intl = useIntl();

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parallel discovery: fire discoverMcpServers for all sources at once.
  // Each source is independent — a read failure on one does not block the
  // others (Promise.allSettled). Per-source errors are shown inline under
  // the affected source row.
  const { data: sources, error: sourcesError, refetch, isFetching } = useQuery({
    queryKey: ["mcp-import-sources"],
    queryFn: async (): Promise<McpImportSource[]> => {
      const results = await Promise.allSettled(
        SOURCES.map((src) => discoverMcpServers(src)),
      );
      return results.map((r, i) => ({
        id: SOURCES[i],
        servers: r.status === "fulfilled" ? r.value.servers : [],
        configPath: r.status === "fulfilled" ? r.value.config_path : null,
        error:
          r.status === "rejected"
            ? fmtError(r.reason, intl)
            : null,
      }));
    },
    enabled: open,
  });

  /** Flat lookup: composite key → { source, server } for every discovered
   *  server across all sources, excluding servers whose display_name is
   *  already in the config (prevents duplicate imports). */
  const serverRegistry = useMemo(() => {
    const map = new Map<string, { source: ImportSource; server: DiscoveredServer }>();
    for (const src of sources ?? []) {
      for (const srv of src.servers) {
        if (existingNames.has(srv.display_name)) continue;
        map.set(selectionKey(src.id, srv.display_name), {
          source: src.id,
          server: srv,
        });
      }
    }
    return map;
  }, [sources, existingNames]);

  const totalDiscovered = serverRegistry.size;

  function toggleServer(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function toggleSourceAll(sourceId: ImportSource) {
    const src = sources?.find((s) => s.id === sourceId);
    if (!src) return;
    // Filter out servers already in the config (mirrors serverRegistry) so
    // select-all never includes duplicates that cannot be imported.
    const keys = src.servers
      .filter((srv) => !existingNames.has(srv.display_name))
      .map((srv) => selectionKey(sourceId, srv.display_name));
    const allSelected = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        keys.forEach((k) => next.delete(k));
      } else {
        keys.forEach((k) => next.add(k));
      }
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function handleImport() {
    if (selected.size === 0) return;
    const items = [...selected]
      .map((key) => serverRegistry.get(key))
      .filter((v): v is { source: ImportSource; server: DiscoveredServer } => v != null);
    if (items.length === 0) return;

    setImporting(true);
    setError(null);

    const results: { config: McpServerConfig; probeResult: McpProbeResult }[] = [];
    const failures: string[] = [];

    // Process each server independently so one upsert failure does not orphan
    // the servers already written to disk (H1: partial-failure isolation).
    for (const { server: discovered } of items) {
      // Convert DiscoveredServer to McpServerConfig (empty id → Rust mints
      // uuid). Shallow-copy nested fields so the config is independent of the
      // discovery state (immutability). Imported servers land enabled
      // (ADR-0106 Decision 4 -- the import checklist pick is explicit intent).
      const config: McpServerConfig = {
        id: "",
        display_name: discovered.display_name,
        transport: { ...discovered.transport },
        env: { ...discovered.env },
        keychain_env_keys: [...discovered.keychain_env_keys],
        timeout_ms: null,
        enabled: true,
      };
      try {
        const finalized = await upsertMcpServer(config);
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
        results.push({ config: finalized, probeResult });
      } catch (upsertErr) {
        failures.push(`${discovered.display_name}: ${fmtError(upsertErr, intl)}`);
      }
    }

    // Sync successfully imported servers to the parent so the list shows them
    // immediately, even if some servers in the batch failed. Prune succeeded
    // servers from the selection so a retry only covers the failed ones.
    if (results.length > 0) {
      onImported(results);
      const succeededNames = new Set(
        results.map((r) => r.config.display_name),
      );
      setSelected((prev) => {
        const next = new Set(prev);
        for (const key of next) {
          const entry = serverRegistry.get(key);
          if (entry && succeededNames.has(entry.server.display_name)) {
            next.delete(key);
          }
        }
        return next;
      });
    }

    if (failures.length > 0) {
      const firstError = failures[0];
      setError(
        failures.length > 1
          ? intl.formatMessage(
              { id: "settings.mcp.import.partialFailure", defaultMessage: "{error} (+{count} more)" },
              { error: firstError, count: failures.length - 1 },
            )
          : firstError,
      );
    } else {
      onClose();
    }

    setImporting(false);
  }

  const selectedCount = selected.size;

  // Build the visible source list from the registry so servers already in the
  // config are excluded, and sources with zero remaining servers are hidden.
  const sourceList = useMemo(() => {
    const bySource = new Map<ImportSource, DiscoveredServer[]>();
    for (const { source, server } of serverRegistry.values()) {
      const list = bySource.get(source) ?? [];
      list.push(server);
      bySource.set(source, list);
    }
    return SOURCES.map((id) => ({
      id,
      servers: bySource.get(id) ?? [],
      configPath: sources?.find((s) => s.id === id)?.configPath ?? null,
      error: sources?.find((s) => s.id === id)?.error ?? null,
    })).filter((s) => s.servers.length > 0);
  }, [serverRegistry, sources]);

  return (
    <Dialog
      open={open}
      onOpenChange={(openState) => {
        if (!openState && !importing) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl"
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          if (importing) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (importing) e.preventDefault();
        }}
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>
              <FormattedMessage
                id="settings.mcp.import.title"
                defaultMessage="Import MCP servers"
              />
            </DialogTitle>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label={intl.formatMessage({
                  id: "settings.mcp.import.refresh",
                  defaultMessage: "Refresh sources",
                })}
                onClick={() => void refetch()}
              >
                <RefreshCw
                  className={cn("size-4", isFetching && "animate-spin")}
                  aria-hidden
                />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                aria-label={intl.formatMessage({
                  id: "common.close",
                  defaultMessage: "Close",
                })}
                onClick={onClose}
                disabled={importing}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
          <DialogDescription>
            <FormattedMessage
              id="settings.mcp.import.description"
              defaultMessage="Import MCP server configurations from external tools. Available sources are scanned automatically."
            />
          </DialogDescription>
        </DialogHeader>

        {sourcesError && (
          <p className="settings-error text-destructive text-sm">
            {fmtError(sourcesError, intl)}
          </p>
        )}

        <div className="flex min-h-[40vh] max-h-[60vh] flex-col gap-1 overflow-y-auto">
          {isFetching && sourceList.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="text-muted-foreground size-6 animate-spin" aria-hidden />
              <span className="text-muted-foreground ml-2 text-sm">
                <FormattedMessage
                  id="settings.mcp.import.loading"
                  defaultMessage="Reading config…"
                />
              </span>
            </div>
          ) : sourceList.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-sm">
              <FormattedMessage
                id="settings.mcp.import.empty"
                defaultMessage="No MCP server sources found."
              />
            </p>
          ) : (
            sourceList.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                expanded={expanded.has(source.id)}
                selected={selected}
                onToggleExpand={() => toggleExpand(source.id)}
                onToggleSourceAll={() => toggleSourceAll(source.id)}
                onToggleServer={toggleServer}
              />
            ))
          )}
        </div>

        {error && (
          <p className="settings-error text-destructive text-sm">{error}</p>
        )}

        <DialogFooter className="sm:items-center">
          <span className="text-muted-foreground text-sm">
            <FormattedMessage
              id="settings.mcp.import.discovered"
              defaultMessage="Discovered {count} importable {count, plural, one {server} other {servers}}"
              values={{ count: totalDiscovered }}
            />
          </span>
          <Button
            type="button"
            variant="ghost"
            className="sm:ml-auto"
            onClick={onClose}
            disabled={importing}
          >
            <FormattedMessage
              id="common.cancel"
              defaultMessage="Cancel"
            />
          </Button>
          <Button
            type="button"
            data-testid="import-action"
            onClick={() => void handleImport()}
            disabled={selectedCount === 0 || importing}
          >
            {importing ? (
              <FormattedMessage
                id="common.importing"
                defaultMessage="Importing…"
              />
            ) : (
              <FormattedMessage
                id="common.importCount"
                defaultMessage="Import {count}"
                values={{ count: selectedCount }}
              />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type SourceRowProps = {
  source: McpImportSource;
  expanded: boolean;
  selected: Set<string>;
  onToggleExpand: () => void;
  onToggleSourceAll: () => void;
  onToggleServer: (key: string) => void;
};

function SourceRow({
  source,
  expanded,
  selected,
  onToggleExpand,
  onToggleSourceAll,
  onToggleServer,
}: SourceRowProps) {
  const intl = useIntl();

  const label =
    source.id === "claude_desktop"
      ? intl.formatMessage({ id: "settings.mcp.import.sourceClaudeDesktop", defaultMessage: "Claude Desktop" })
      : intl.formatMessage({ id: "settings.mcp.import.sourceCodex", defaultMessage: "Codex" });

  const sourceKeys = source.servers.map((srv) =>
    selectionKey(source.id, srv.display_name),
  );
  const selectedInSource = sourceKeys.filter((k) => selected.has(k)).length;
  const allSelected =
    sourceKeys.length > 0 && selectedInSource === sourceKeys.length;

  return (
    <div className="border-border rounded-lg border">
      {/* Collapsed header: select-all checkbox + expand toggle */}
      <div className="hover:bg-accent/50 flex items-center gap-2 px-3 py-2.5">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={onToggleSourceAll}
          disabled={source.servers.length === 0}
          aria-label={label}
          className="size-4"
        />
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? intl.formatMessage(
                  { id: "settings.mcp.import.collapse", defaultMessage: "Collapse {label}" },
                  { label },
                )
              : intl.formatMessage(
                  { id: "settings.mcp.import.expand", defaultMessage: "Expand {label}" },
                  { label },
                )
          }
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 text-sm font-medium">{label}</span>
            {source.configPath && (
              <span
                className="text-muted-foreground truncate font-mono text-xs"
                title={source.configPath}
              >
                {source.configPath}
              </span>
            )}
          </div>
          <Badge variant="secondary" className="ml-auto shrink-0">
            {source.servers.length}
          </Badge>
          <ChevronRight
            className={cn(
              "size-4 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
            aria-hidden
          />
        </button>
      </div>

      {/* Expanded: server checkboxes + selected M / N + select-all link */}
      {expanded && (
        <div className="border-border border-t px-3 py-2">
          {/* Per-source discovery error */}
          {source.error && (
            <div className="text-destructive mb-2 flex items-center gap-2 text-sm" role="alert">
              <AlertCircle className="size-4 shrink-0" aria-hidden />
              <FormattedMessage
                id="settings.mcp.import.sourceError"
                defaultMessage="Failed to read config: {error}"
                values={{ error: source.error }}
              />
            </div>
          )}

          {/* Empty source (config not found / no servers) */}
          {source.servers.length === 0 && !source.error && (
            <p className="text-muted-foreground py-2 text-center text-xs">
              <FormattedMessage
                id="settings.mcp.import.notFound"
                defaultMessage="No MCP config file found for this source. Make sure the application is installed and has been configured."
              />
            </p>
          )}

          {source.servers.length > 0 && (
            <>
              <div className="text-muted-foreground mb-1.5 flex items-center justify-between text-xs">
                <span>
                  <FormattedMessage
                    id="settings.mcp.import.selectedCount"
                    defaultMessage="Selected {selected} / {total}"
                    values={{ selected: selectedInSource, total: source.servers.length }}
                  />
                </span>
                <button
                  type="button"
                  onClick={onToggleSourceAll}
                  className="hover:text-foreground"
                >
                  <FormattedMessage
                    id="settings.mcp.import.selectAll"
                    defaultMessage="Select all"
                  />
                </button>
              </div>
              <div className="grid gap-0.5">
                {source.servers.map((server) => (
                  <ServerRow
                    key={server.display_name}
                    server={server}
                    sourceId={source.id}
                    checked={selected.has(
                      selectionKey(source.id, server.display_name),
                    )}
                    onToggle={() => onToggleServer(selectionKey(source.id, server.display_name))}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

type ServerRowProps = {
  server: DiscoveredServer;
  sourceId: ImportSource;
  checked: boolean;
  onToggle: () => void;
};

function ServerRow({ server, checked, onToggle }: ServerRowProps) {
  const transportSummary =
    server.transport.type === "stdio"
      ? server.transport.command
      : server.transport.url;

  const cbId = `mcp-import-${server.display_name}`;
  return (
    <div
      data-testid="import-server-row"
      className={cn(
        "flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-sm",
        checked ? "bg-accent" : "hover:bg-accent",
      )}
    >
      <input
        id={cbId}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-4 shrink-0 cursor-pointer"
        aria-label={server.display_name}
      />
      <label htmlFor={cbId} className="min-w-0 flex-1 cursor-pointer">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {server.display_name}
          </span>
          {server.keychain_env_keys.length > 0 && (
            <Badge variant="secondary" className="shrink-0">
              <FormattedMessage
                id="settings.mcp.import.secretsBadge"
                defaultMessage="{count} secret(s)"
                values={{ count: server.keychain_env_keys.length }}
              />
            </Badge>
          )}
        </div>
        <div className="text-muted-foreground truncate font-mono text-xs">
          {transportSummary}
        </div>
      </label>
    </div>
  );
}
