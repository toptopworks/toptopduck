import { useEffect, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Pencil, Plus, RefreshCw, RotateCcw, Terminal, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

import type { AppConfig } from "../../types/app-config";
import type { BuiltinScanEntry, CliToolConfig } from "../../types/cli-tool";
import {
  removeCliTool,
  rescanBuiltinCliTools,
  restoreBuiltinCliTool,
  upsertCliTool,
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
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  PaneHeader,
  SETTINGS_TOOLTIP_CLASS,
  SettingsCard,
} from "./settings-chrome";
import { blankCliTool } from "../../types/cli-tool";
import { CliToolForm } from "./CliToolForm";

// Registered CLI tools settings pane (issue #671, ADR-0108): the second
// external tool source. Structured like the MCP pane -- "list" shows every
// registered tool with a per-row enable toggle + Edit/Delete, "form" shows
// the add/edit form -- minus the probe / import surfaces (v1 CLI has
// neither: registration never blocks on the executable resolving, and there
// is no external config to import). Every write goes through the backend
// read-modify-write commands, which already persisted and return the
// updated FULL app-config (ADR-0109 Decision 9) -- so each write syncs
// shell state ONLY (the setDefaultRuntime state-only-sync precedent), never
// a second disk write over a snapshot that read nothing.

/** The gated row actions (the delete and the restore both overwrite user
 * state irreversibly, so both route through the shared confirmation
 * dialog before their IPC lands). */
type ConfirmTarget = { kind: "delete" | "restore"; name: string };

export function CliSection({
  appConfig,
  onCliToolsChanged,
}: {
  appConfig: AppConfig;
  onCliToolsChanged: (cfg: AppConfig) => void;
}) {
  const intl = useIntl();
  const [formTarget, setFormTarget] = useState<{
    tool: CliToolConfig;
    isEdit: boolean;
  } | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tools = appConfig.cli_tools.tools;
  const [scan, setScan] = useState<BuiltinScanEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);

  /** Opening the pane refreshes the detection snapshot (issue #675): one
   * read-modify-write IPC returns the full config + snapshot together. A
   * mount failure stays silent -- the explicit Rescan button surfaces
   * errors through the shared error lane. */
  useEffect(() => {
    let cancelled = false;
    rescanBuiltinCliTools()
      .then((result) => {
        if (cancelled) return;
        setScan(result.scan);
        onCliToolsChanged(result.config);
      })
      .catch(() => {
        /* silent on mount; the manual rescan surfaces errors */
      });
    return () => {
      cancelled = true;
    };
    // `onCliToolsChanged` is a stable pass-through from the settings view
    // (the same mount-once contract as the other settings panes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The manual rescan (issue #675): refresh the detection snapshot and
   * sync the registry view from the returned full config; also the
   * conflict catch-up point after the user disposes of a clashing entry. */
  async function handleRescan() {
    setScanning(true);
    setError(null);
    try {
      const result = await rescanBuiltinCliTools();
      setScan(result.scan);
      onCliToolsChanged(result.config);
    } catch (e) {
      setError(fmtError(e, intl));
    } finally {
      setScanning(false);
    }
  }

  /** The shared error half of every write here: surface a resolve-to-error
   *  or rejection through setError (the McpSection runCommit contract). */
  async function runCommit(
    write: () => Promise<string | null>,
  ): Promise<string | null> {
    try {
      const err = await write();
      if (err) setError(err);
      return err;
    } catch (e) {
      const msg = fmtError(e, intl);
      setError(msg);
      return msg;
    }
  }

  /** The row-level enable toggle (ADR-0106 single axis): one-field upsert
   *  over the same command the form uses. The returned full config syncs
   *  shell state wholesale -- the registry order is the backend's truth. */
  async function handleToggleEnabled(tool: CliToolConfig, enabled: boolean) {
    setTogglingName(tool.name);
    setError(null);
    await runCommit(async () => {
      const next = await upsertCliTool({ ...tool, enabled });
      onCliToolsChanged(next);
      return null;
    });
    setTogglingName(null);
  }

  /** Called by the form after ITS upsert lands: the command already
   *  persisted and returned the updated full config -- sync state and
   *  return to the list (no second write). */
  function handleFormSaved(next: AppConfig) {
    onCliToolsChanged(next);
    setFormTarget(null);
  }

  /** The shared confirmation lane for the gated row actions (issue #676
   * folded the restore in beside the delete): the command already
   * persisted and returned the updated full config -- sync and close. */
  async function handleConfirm() {
    if (!confirmTarget) return;
    setConfirmBusy(true);
    setError(null);
    const kind = confirmTarget.kind;
    const name = confirmTarget.name;
    await runCommit(async () => {
      const next =
        kind === "delete"
          ? await removeCliTool(name)
          : await restoreBuiltinCliTool(name);
      onCliToolsChanged(next);
      return null;
    });
    setConfirmBusy(false);
    setConfirmTarget(null);
  }

  // --- Form view ----------------------------------------------------------
  if (formTarget) {
    return (
      <CliToolForm
        key={formTarget.tool.name || "new"}
        initialTool={formTarget.tool}
        isEdit={formTarget.isEdit}
        onSaved={handleFormSaved}
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
            id="settings.nav.cliTools"
            defaultMessage="CLI Tools"
          />
        )}
        description={(
          <FormattedMessage
            id="settings.cli.description"
            defaultMessage="Register non-interactive command-line tools the agent can call. Every call passes the same approval flow as MCP tools; the approval card shows the exact command that will run."
          />
        )}
        action={(
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={scanning}
              onClick={() => void handleRescan()}
            >
              <RefreshCw
                className={cn("size-4", scanning && "animate-spin")}
                aria-hidden
              />
              {scanning ? (
                <FormattedMessage
                  id="settings.cli.rescanning"
                  defaultMessage="Scanning…"
                />
              ) : (
                <FormattedMessage
                  id="settings.cli.rescan"
                  defaultMessage="Rescan"
                />
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => setFormTarget({ tool: blankCliTool(), isEdit: false })}
            >
              <Plus className="size-4" aria-hidden />
              <FormattedMessage id="settings.cli.new" defaultMessage="New" />
            </Button>
          </div>
        )}
      />

      {tools.length > 0 && (
        <p className="mb-2 text-sm">
          <FormattedMessage
            id="settings.cli.configuredCount"
            defaultMessage="Registered CLI tools <muted>{count}</muted>"
            values={{
              count: tools.length,
              muted: (chunks) => (
                <span className="text-muted-foreground">{chunks}</span>
              ),
            }}
          />
        </p>
      )}

      <SettingsCard data-testid="cli-tool-list">
        {tools.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            <FormattedMessage
              id="settings.cli.empty"
              defaultMessage="No CLI tools registered yet. Click New to register one."
            />
          </div>
        ) : (
          tools.map((tool) => (
            <CliToolRow
              key={tool.name}
              tool={tool}
              toggling={togglingName === tool.name}
              onToggleEnabled={(next) => void handleToggleEnabled(tool, next)}
              onEdit={() => setFormTarget({ tool, isEdit: true })}
              // A builtin entry is undeletable (ADR-0109 Decision 2):
              // no delete entry point, disabling is the single shutdown
              // axis. The restore shows only on an EDITED builtin row --
              // FOLLOWING rows already agree with the baseline.
              onDelete={
                tool.source === "builtin"
                  ? undefined
                  : () => setConfirmTarget({ kind: "delete", name: tool.name })
              }
              onRestore={
                tool.source === "builtin" && tool.baseline === "edited"
                  ? () => setConfirmTarget({ kind: "restore", name: tool.name })
                  : undefined
              }
            />
          ))
        )}
      </SettingsCard>

      {scan && (
        <div className="mt-6" data-testid="builtin-cli-panel">
          <p className="text-sm font-medium">
            <FormattedMessage
              id="settings.cli.builtin.title"
              defaultMessage="Built-in tools"
            />
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            <FormattedMessage
              id="settings.cli.builtin.description"
              defaultMessage="Curated tools that register automatically when installed on this machine. Install one, then rescan to use it."
            />
          </p>
          <SettingsCard data-testid="builtin-cli-scan" className="mt-2">
            {scan.map((entry) => (
              <BuiltinRow key={entry.name} entry={entry} />
            ))}
          </SettingsCard>
        </div>
      )}

      {error && (
        <p className="settings-error mt-3 text-destructive text-sm">{error}</p>
      )}

      {confirmTarget && (
        <AlertDialog
          defaultOpen
          onOpenChange={(open) => {
            if (!open && !confirmBusy) setConfirmTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmTarget.kind === "delete" ? (
                  <FormattedMessage
                    id="settings.cli.confirmDeleteTitle"
                    defaultMessage="Delete CLI tool {name}?"
                    values={{ name: confirmTarget.name }}
                  />
                ) : (
                  <FormattedMessage
                    id="settings.cli.confirmRestoreTitle"
                    defaultMessage="Restore built-in definition for {name}?"
                    values={{ name: confirmTarget.name }}
                  />
                )}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmTarget.kind === "delete" ? (
                  <FormattedMessage
                    id="settings.cli.confirmDeleteBody"
                    defaultMessage="This permanently removes the registration {name}. This cannot be undone."
                    values={{ name: confirmTarget.name }}
                  />
                ) : (
                  <FormattedMessage
                    id="settings.cli.confirmRestoreBody"
                    defaultMessage="This discards your edits to {name} and returns it to the definition shipped with the app. This cannot be undone."
                    values={{ name: confirmTarget.name }}
                  />
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={confirmBusy}>
                <FormattedMessage
                  id="settings.cli.confirmDeleteCancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction
                className={cn(
                  confirmTarget.kind === "delete" &&
                  "bg-destructive text-white hover:bg-destructive/90",
                )}
                disabled={confirmBusy}
                onClick={(e) => {
                  // Prevent Radix AlertDialog auto-close so the busy state
                  // can render while the IPC runs (the MCP pane's pattern).
                  e.preventDefault();
                  void handleConfirm();
                }}
              >
                {confirmBusy ? (
                  confirmTarget.kind === "delete" ? (
                    <FormattedMessage
                      id="settings.cli.deleting"
                      defaultMessage="Deleting…"
                    />
                  ) : (
                    <FormattedMessage
                      id="settings.cli.restoring"
                      defaultMessage="Restoring…"
                    />
                  )
                ) : confirmTarget.kind === "delete" ? (
                  <FormattedMessage
                    id="common.delete"
                    defaultMessage="Delete"
                  />
                ) : (
                  <FormattedMessage
                    id="common.restore"
                    defaultMessage="Restore"
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

/** One shipped definition's detection row (issue #675): name + description
 * with the three-state badge; a conflict row swaps the description for the
 * disposition hint (rename or remove the user entry, then rescan). */
function BuiltinRow({ entry }: { entry: BuiltinScanEntry }) {
  return (
    <div
      data-testid={`builtin-cli-row-${entry.name}`}
      className="hover:bg-accent/50 flex items-center gap-3 px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{entry.name}</span>
          {entry.state === "detected" && entry.executable && (
            <span className="text-muted-foreground truncate font-mono text-xs">
              {entry.executable}
            </span>
          )}
        </div>
        {entry.state === "conflict" ? (
          <p className="text-destructive mt-1 text-xs">
            <FormattedMessage
              id="settings.cli.builtin.conflictHint"
              defaultMessage="Your registration owns this name. Remove it, then rescan."
            />
          </p>
        ) : (
          <div className="text-muted-foreground mt-1 truncate text-xs">
            {entry.description}
          </div>
        )}
      </div>
      {/* The DESIGN.md badge token: typography.badge (12px/500) on
       * rounded.md with 2px 8px padding; the secondary coloring, with
       * destructive text only for the conflict state. */}
      <span
        className={cn(
          "bg-muted shrink-0 rounded-md px-2 py-0.5 text-xs font-medium leading-none",
          entry.state === "detected" && "text-muted-foreground",
          entry.state === "dormant" && "text-muted-foreground/60",
          entry.state === "conflict" && "text-destructive",
        )}
      >
        {/* One literal FormattedMessage per state: the extractor needs a
         * static id + defaultMessage (the same rule the delivery labels
         * follow). */}
        {entry.state === "detected" && (
          <FormattedMessage
            id="settings.cli.builtin.state.detected"
            defaultMessage="Installed"
          />
        )}
        {entry.state === "dormant" && (
          <FormattedMessage
            id="settings.cli.builtin.state.dormant"
            defaultMessage="Not detected"
          />
        )}
        {entry.state === "conflict" && (
          <FormattedMessage
            id="settings.cli.builtin.state.conflict"
            defaultMessage="Name conflict"
          />
        )}
      </span>
    </div>
  );
}

function CliToolRow({
  tool,
  toggling,
  onToggleEnabled,
  onEdit,
  onDelete,
  onRestore,
}: {
  tool: CliToolConfig;
  /** The row's enable-toggle write is in flight: the switch and the row's
   *  action buttons gate so an edit form cannot save a stale `enabled` over
   *  the in-flight write (the MCP row's toggling contract). */
  toggling: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  /** Undefined on builtin rows: the entry is undeletable (ADR-0109
   *  Decision 2) -- disabling is the single shutdown axis, so no delete
   *  entry point renders. */
  onDelete?: () => void;
  /** Present only on an EDITED builtin row: the explicit restore action
   *  (ADR-0109 Decision 2) -- the only way back onto the baseline. */
  onRestore?: () => void;
}) {
  const intl = useIntl();
  return (
    <div
      data-testid={`cli-tool-row-${tool.name}`}
      className="hover:bg-accent/50 flex items-center gap-3 px-4 py-3"
    >
      <Terminal
        className={cn(
          "size-4 shrink-0",
          tool.enabled ? "text-muted-foreground" : "text-muted-foreground/40",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-sm font-medium truncate",
              // A disabled tool is dormant (ADR-0106): the quieted name
              // keeps the row's state legible at a glance.
              !tool.enabled && "text-muted-foreground",
            )}
          >
            {tool.name}
          </span>
          {tool.source === "builtin" && (
            <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium leading-none">
              <FormattedMessage
                id="settings.cli.builtinBadge"
                defaultMessage="Built-in"
              />
            </span>
          )}
          {!tool.enabled && (
            <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium leading-none">
              <FormattedMessage
                id="settings.cli.disabledBadge"
                defaultMessage="Disabled"
              />
            </span>
          )}
        </div>
        <div className="text-muted-foreground mt-1 truncate text-xs">
          {tool.executable}
          {" · "}
          <FormattedMessage
            id="settings.cli.paramCount"
            defaultMessage="{count} parameters"
            values={{ count: tool.params.length }}
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {/* The enable toggle (ADR-0106): the row's machine-level state,
         * before the action buttons (the MCP row's layout). */}
        <Tooltip>
          {/* The span isolates the trigger: TooltipTrigger asChild would
           * clobber the Switch's data-state (the MCP row's fix). */}
          <TooltipTrigger asChild>
            <span className="mr-1.5 inline-flex">
              <Switch
                checked={tool.enabled}
                disabled={toggling}
                onCheckedChange={onToggleEnabled}
                aria-label={intl.formatMessage(
                  {
                    id: "settings.cli.enableToggleLabel",
                    defaultMessage: "Toggle tool {name}",
                  },
                  { name: tool.name },
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
            {tool.enabled ? (
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
              disabled={toggling}
              aria-label={intl.formatMessage(
                {
                  id: "settings.cli.editLabel",
                  defaultMessage: "Edit tool {name}",
                },
                { name: tool.name },
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

        {onRestore && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground h-7 w-7 p-0"
                disabled={toggling}
                aria-label={intl.formatMessage(
                  {
                    id: "settings.cli.restoreLabel",
                    defaultMessage: "Restore built-in definition for tool {name}",
                  },
                  { name: tool.name },
                )}
                onClick={onRestore}
              >
                <RotateCcw className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className={SETTINGS_TOOLTIP_CLASS}>
              <FormattedMessage
                id="settings.cli.restoreTooltip"
                defaultMessage="Restore built-in definition"
              />
            </TooltipContent>
          </Tooltip>
        )}

        {onDelete && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive h-7 w-7 p-0"
                disabled={toggling}
                aria-label={intl.formatMessage(
                  {
                    id: "settings.cli.deleteLabel",
                    defaultMessage: "Delete tool {name}",
                  },
                  { name: tool.name },
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
        )}
      </div>
    </div>
  );
}
