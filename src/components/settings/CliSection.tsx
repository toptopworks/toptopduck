import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { Pencil, Plus, Terminal, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

import type { AppConfig } from "../../types/app-config";
import type { CliToolConfig } from "../../types/cli-tool";
import { upsertCliTool, removeCliTool } from "../../api";
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
// read-modify-write commands, which return the updated FULL app-config
// (ADR-0109 Decision 9), so the commit is a whole-snapshot replace -- no
// per-row mirror list to keep in sync.

type DeleteTarget = { name: string };

export function CliSection({
  appConfig,
  onCommit,
}: {
  appConfig: AppConfig;
  onCommit: (mutate: (cfg: AppConfig) => AppConfig) => Promise<string | null>;
}) {
  const intl = useIntl();
  const [formTarget, setFormTarget] = useState<{
    tool: CliToolConfig;
    isEdit: boolean;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tools = appConfig.cli_tools.tools;

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
   *  over the same command the form uses. The returned full config commits
   *  wholesale -- the registry order is the backend's truth. */
  async function handleToggleEnabled(tool: CliToolConfig, enabled: boolean) {
    setTogglingName(tool.name);
    setError(null);
    await runCommit(async () => {
      const next = await upsertCliTool({ ...tool, enabled });
      return onCommit(() => next);
    });
    setTogglingName(null);
  }

  /** Called by the form after the upsert lands. The command already returned
   *  the updated full config; commit it and return to the list. */
  async function handleFormSaved(next: AppConfig) {
    await runCommit(() => onCommit(() => next));
    setFormTarget(null);
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    await runCommit(async () => {
      const next = await removeCliTool(deleteTarget.name);
      return onCommit(() => next);
    });
    setDeleting(false);
    setDeleteTarget(null);
  }

  // --- Form view ----------------------------------------------------------
  if (formTarget) {
    return (
      <CliToolForm
        key={formTarget.tool.name || "new"}
        initialTool={formTarget.tool}
        isEdit={formTarget.isEdit}
        onSaved={(next) => void handleFormSaved(next)}
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
          <Button
            type="button"
            size="sm"
            onClick={() => setFormTarget({ tool: blankCliTool(), isEdit: false })}
          >
            <Plus className="size-4" aria-hidden />
            <FormattedMessage id="settings.cli.new" defaultMessage="New" />
          </Button>
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
              onDelete={() => setDeleteTarget({ name: tool.name })}
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
                  id="settings.cli.confirmDeleteTitle"
                  defaultMessage="Delete CLI tool {name}?"
                  values={{ name: deleteTarget.name }}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.cli.confirmDeleteBody"
                  defaultMessage="This permanently removes the registration {name}. This cannot be undone."
                  values={{ name: deleteTarget.name }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                <FormattedMessage
                  id="settings.cli.confirmDeleteCancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={deleting}
                onClick={(e) => {
                  // Prevent Radix AlertDialog auto-close so the deleting
                  // state can render while the IPC runs (the MCP pane's
                  // pattern).
                  e.preventDefault();
                  void handleConfirmDelete();
                }}
              >
                {deleting ? (
                  <FormattedMessage
                    id="settings.cli.deleting"
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
    </div>
  );
}

function CliToolRow({
  tool,
  toggling,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  tool: CliToolConfig;
  /** The row's enable-toggle write is in flight: the switch and the row's
   *  action buttons gate so an edit form cannot save a stale `enabled` over
   *  the in-flight write (the MCP row's toggling contract). */
  toggling: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
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
      </div>
    </div>
  );
}
