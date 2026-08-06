import { useCallback, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { AlertCircle, Download, Loader2, Monitor, Terminal } from "lucide-react";

import type { DiscoveredServer, ImportSource, McpProbeResult, McpServerConfig } from "../../types/mcp";
import { discoverMcpServers, probeMcpServer, upsertMcpServer } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

// MCP import wizard dialog (issue #390). A multi-step modal:
// 1. Source selection (Claude Desktop / Codex)
// 2. Loading (reading + parsing the external config)
// 3a. Server checklist (name + transport summary, checkboxes)
// 3b. "Not found" empty state (config file does not exist -- not an error)
// 3c. Error state (malformed config)
// 4. Import button → batch upsertMcpServer + auto probe → close
//
// The dialog is controlled by the parent McpSection (open/onClose). Following
// the same pattern as McpServerForm: the dialog calls upsertMcpServer +
// probeMcpServer directly (IPC), then passes the finalized configs + probe
// results to the parent's onImported so the list syncs React state + shows
// status dots immediately.

type Step = "source" | "loading" | "checklist" | "importing";

type DiscoverResult =
  | { kind: "servers"; servers: DiscoveredServer[] }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export type McpImportDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Called after the batch upsert + probe flow completes. The parent syncs
   *  each finalized config into React state + stores the probe result so the
   *  list shows the new entries + status dots immediately. */
  onImported: (results: { config: McpServerConfig; probeResult: McpProbeResult }[]) => void;
};

const SOURCES: { value: ImportSource; icon: typeof Monitor }[] = [
  { value: "claude_desktop", icon: Monitor },
  { value: "codex", icon: Terminal },
];

/** The source-selection buttons. Each FormattedMessage uses a static id literal
 *  so @formatjs/cli extract resolves every key (ADR-0052). */
function SourceButton({
  source,
  onSelect,
}: {
  source: ImportSource;
  onSelect: (src: ImportSource) => void;
}) {
  const Icon = source === "claude_desktop" ? Monitor : Terminal;
  return (
    <button
      type="button"
      data-testid={`mcp-import-source-${source}`}
      className={cn(
        "border-border bg-background hover:bg-accent flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
      )}
      onClick={() => onSelect(source)}
    >
      <Icon className="text-muted-foreground size-5 shrink-0" aria-hidden />
      <span className="text-sm font-medium">
        {source === "claude_desktop" ? (
          <FormattedMessage id="settings.mcp.import.sourceClaudeDesktop" defaultMessage="Claude Desktop" />
        ) : (
          <FormattedMessage id="settings.mcp.import.sourceCodex" defaultMessage="Codex" />
        )}
      </span>
    </button>
  );
}

export function McpImportDialog({ open, onClose, onImported }: McpImportDialogProps) {
  const intl = useIntl();

  const [step, setStep] = useState<Step>("source");
  const [source, setSource] = useState<ImportSource | null>(null);
  const [discoverResult, setDiscoverResult] = useState<DiscoverResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const handleSelectSource = useCallback(async (src: ImportSource) => {
    setSource(src);
    setStep("loading");
    setError(null);
    try {
      const servers = await discoverMcpServers(src);
      if (servers.length === 0) {
        setDiscoverResult({ kind: "empty" });
      } else {
        setDiscoverResult({ kind: "servers", servers });
        // Pre-select all servers by default.
        setSelected(new Set(servers.map((s) => s.display_name)));
      }
      setStep("checklist");
    } catch (e) {
      setDiscoverResult({ kind: "error", message: fmtError(e, intl) });
      setStep("checklist");
    }
  }, [intl]);

  const toggleServer = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  async function handleImport() {
    if (!discoverResult || discoverResult.kind !== "servers") return;
    const servers = discoverResult.servers.filter((s) => selected.has(s.display_name));
    if (servers.length === 0) return;

    setStep("importing");
    setError(null);
    const results: { config: McpServerConfig; probeResult: McpProbeResult }[] = [];
    const failures: string[] = [];

    // Process each server independently so one upsert failure does not orphan
    // the servers already written to disk (H1: partial-failure isolation).
    // Successfully imported servers are collected and synced to the parent via
    // onImported after the loop, regardless of individual failures.
    for (const discovered of servers) {
      // Convert DiscoveredServer to McpServerConfig (empty id → Rust mints
      // uuid). Shallow-copy nested fields so the config is independent of the
      // discoverResult state (immutability).
      const config: McpServerConfig = {
        id: "",
        display_name: discovered.display_name,
        transport: { ...discovered.transport },
        env: { ...discovered.env },
        keychain_env_keys: [...discovered.keychain_env_keys],
        timeout_ms: null,
      };
      try {
        // 1. Upsert (writes to disk; returns finalized config with minted id).
        const finalized = await upsertMcpServer(config);

        // 2. Auto-probe so the list shows an immediate status dot. A probe
        //    failure is non-fatal — the server is already saved.
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

    // Sync all successfully imported servers to the parent so the list shows
    // them immediately, even if some servers in the batch failed.
    if (results.length > 0) {
      onImported(results);
    }

    if (failures.length > 0) {
      setError(failures.join("\n"));
      setStep("checklist");
    } else {
      onClose();
    }
  }

  const canImport =
    step === "checklist" &&
    discoverResult?.kind === "servers" &&
    selected.size > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(openState) => {
        if (!openState && step !== "importing") onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="settings.mcp.import.title"
              defaultMessage="Import MCP servers"
            />
          </DialogTitle>
          <DialogDescription>
            {step === "source" ? (
              <FormattedMessage
                id="settings.mcp.import.description"
                defaultMessage="Select a source to import MCP server configurations from."
              />
            ) : source === "claude_desktop" ? (
              <FormattedMessage
                id="settings.mcp.import.sourceClaudeDesktop"
                defaultMessage="Claude Desktop"
              />
            ) : (
              <FormattedMessage
                id="settings.mcp.import.sourceCodex"
                defaultMessage="Codex"
              />
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Step 1: Source selection */}
        {step === "source" && (
          <div className="grid gap-2" data-testid="mcp-import-sources">
            {SOURCES.map((src) => (
              <SourceButton
                key={src.value}
                source={src.value}
                onSelect={(s) => void handleSelectSource(s)}
              />
            ))}
          </div>
        )}

        {/* Step 2: Loading */}
        {step === "loading" && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-6 animate-spin" aria-hidden />
            <span className="text-muted-foreground ml-2 text-sm">
              <FormattedMessage
                id="settings.mcp.import.loading"
                defaultMessage="Reading config…"
              />
            </span>
          </div>
        )}

        {/* Step 3: Checklist / empty / error */}
        {step === "checklist" && discoverResult?.kind === "servers" && (
          <div className="grid gap-1" data-testid="mcp-import-checklist">
            {discoverResult.servers.map((server) => {
              const isSelected = selected.has(server.display_name);
              const transportSummary =
                server.transport.type === "stdio"
                  ? server.transport.command
                  : server.transport.url;
              return (
                <label
                  key={server.display_name}
                  className={cn(
                    "border-border flex cursor-pointer items-center gap-3 rounded-md border p-2.5 transition-colors",
                    isSelected ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleServer(server.display_name)}
                    className="size-4 shrink-0 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {server.display_name}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">
                      {transportSummary}
                    </div>
                  </div>
                  {server.keychain_env_keys.length > 0 && (
                    <span
                      className="text-muted-foreground shrink-0 text-xs"
                      title={intl.formatMessage(
                        {
                          id: "settings.mcp.import.secretsNote",
                          defaultMessage:
                            "{count} secret value(s) need re-entry after import",
                        },
                        { count: server.keychain_env_keys.length },
                      )}
                    >
                      <FormattedMessage
                        id="settings.mcp.import.secretsBadge"
                        defaultMessage="{count} secret(s)"
                        values={{ count: server.keychain_env_keys.length }}
                      />
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        {step === "checklist" && discoverResult?.kind === "empty" && (
          <div
            role="alert"
            className="text-muted-foreground flex flex-col items-center gap-2 py-8 text-center text-sm"
            data-testid="mcp-import-not-found"
          >
            <AlertCircle className="size-6" aria-hidden />
            <FormattedMessage
              id="settings.mcp.import.notFound"
              defaultMessage="No MCP config file found for this source. Make sure the application is installed and has been configured."
            />
          </div>
        )}

        {step === "checklist" && discoverResult?.kind === "error" && (
          <div
            role="alert"
            className="text-destructive flex flex-col items-center gap-2 py-8 text-center text-sm"
            data-testid="mcp-import-error"
          >
            <AlertCircle className="size-6" aria-hidden />
            <span>{discoverResult.message}</span>
          </div>
        )}

        {/* Step 4: Importing */}
        {step === "importing" && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-6 animate-spin" aria-hidden />
            <span className="text-muted-foreground ml-2 text-sm">
              <FormattedMessage
                id="settings.mcp.import.importing"
                defaultMessage="Importing…"
              />
            </span>
          </div>
        )}

        {error && (
          <p className="text-destructive text-sm">{error}</p>
        )}

        <DialogFooter>
          {step === "source" || step === "loading" || step === "importing" ? (
            <Button
              type="button"
              variant="ghost"
              disabled={step === "loading" || step === "importing"}
              onClick={onClose}
            >
              <FormattedMessage
                id="settings.mcp.import.cancel"
                defaultMessage="Cancel"
              />
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onClose}>
                <FormattedMessage
                  id="settings.mcp.import.cancel"
                  defaultMessage="Cancel"
                />
              </Button>
              {discoverResult?.kind === "servers" && (
                <Button
                  type="button"
                  disabled={!canImport}
                  onClick={() => void handleImport()}
                >
                  <Download className="size-4" aria-hidden />
                  <FormattedMessage
                    id="settings.mcp.import.import"
                    defaultMessage="Import {count}"
                    values={{ count: selected.size }}
                  />
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
