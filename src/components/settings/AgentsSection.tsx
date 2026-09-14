import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

import type { AgentEntry, AgentUpdate } from "../../types/agents";
import type { AppConfig } from "../../types/app-config";
import {
  createAgent,
  deleteAgent,
  listAgents,
  setAgentEnabled,
  updateAgent,
} from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { cn } from "../../lib/utils";
import { agentKeys } from "../../session/queryKeys";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { PaneHeader, SettingsCard } from "./settings-chrome";

// Agents settings pane (issue #932, ADR-0117). The registry is a directory
// scan (no app-config entity -- the definitions are files), so this pane
// reads list_agents + drives create / update / delete through TanStack
// mutations that invalidate the one agents query. Enablement is a separate
// machine-level axis in app-config: the row Switch flips it through
// set_agent_enabled, whose updated FULL config syncs the caller's snapshot
// (the ADR-0109 Decision 9 contract, same channel as the Skills pane).
// Built-in rows keep their name locked and expose no delete entry point
// (disabling is the single shutdown axis); linked rows are read-only.

// The backend name/description rules, mirrored client-side (the
// SkillsSection posture) so the dialog gates Save BEFORE an IPC round-trip.
// The backend remains the authority; these only move the feedback earlier.
const AGENT_NAME_MAX = 64;
const AGENT_DESCRIPTION_MAX = 1024;
const AGENT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type EnabledFilter = "all" | "enabled" | "disabled";

const FILTER_OPTIONS: ReadonlyArray<EnabledFilter> = ["all", "enabled", "disabled"];

function matchesFilter(agent: AgentEntry, filter: EnabledFilter): boolean {
  return filter === "all" || (filter === "enabled") === agent.enabled;
}

function matchesSearch(agent: AgentEntry, query: string): boolean {
  if (query.trim() === "") return true;
  const haystack = `${agent.name}\n${agent.description}`.toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

type DrawerState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; entry: AgentEntry };

export function AgentsSection({
  onAppConfigSync,
}: {
  /** Sync the caller's app-config snapshot after delete_agent /
   *  set_agent_enabled (both return the updated FULL config). */
  onAppConfigSync: (cfg: AppConfig) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<EnabledFilter>("all");
  const [drawer, setDrawer] = useState<DrawerState>({ mode: "closed" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: listing, error: queryError, refetch, isFetching } = useQuery({
    queryKey: agentKeys.all(),
    queryFn: listAgents,
  });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: agentKeys.all() });
  }

  const createMutation = useMutation({
    mutationFn: ({ name, description, preamble }: AgentUpdate) =>
      createAgent(name, description, preamble),
    onSuccess: () => {
      invalidate();
      setError(null);
      setDrawer({ mode: "closed" });
    },
    onError: (e) => setError(fmtError(e, intl)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, update }: { name: string; update: AgentUpdate }) =>
      updateAgent(name, update),
    onSuccess: () => {
      invalidate();
      setError(null);
      setDrawer({ mode: "closed" });
    },
    onError: (e) => setError(fmtError(e, intl)),
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => deleteAgent(name),
    onSuccess: (cfg) => {
      // The command returns the updated FULL config (the stale enablement
      // entry dropped server-side) -- sync the caller's snapshot wholesale.
      onAppConfigSync(cfg);
      invalidate();
      setConfirmDelete(null);
      setError(null);
    },
    onError: (e) => {
      setError(fmtError(e, intl));
      setConfirmDelete(null);
    },
  });

  const enableMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setAgentEnabled(name, enabled),
    onSuccess: (cfg) => {
      onAppConfigSync(cfg);
      invalidate();
      setError(null);
    },
    onError: (e) => setError(fmtError(e, intl)),
  });

  const agents = useMemo(() => listing?.agents ?? [], [listing]);
  const visible = useMemo(
    () => agents.filter((a) => matchesSearch(a, search) && matchesFilter(a, filter)),
    [agents, search, filter],
  );
  const ignoredFiles = useMemo(() => listing?.ignored ?? [], [listing]);
  const rootError = listing?.root_error ?? null;

  // Derived display error (the SkillsSection priority order): the mutation
  // error first, then the IPC transport error, then the root scan error.
  const displayError = useMemo(() => {
    if (error) return error;
    if (queryError) return fmtError(queryError, intl);
    if (rootError) {
      return intl.formatMessage(
        {
          id: "settings.agents.scanFailed",
          defaultMessage: "Couldn't load your agents: {detail}",
        },
        { detail: rootError },
      );
    }
    return null;
  }, [error, queryError, rootError, intl]);

  function openEdit(entry: AgentEntry) {
    // The dialog owns the error face while open (a leftover pane error would
    // replay inside an unrelated edit dialog).
    setError(null);
    setDrawer({ mode: "edit", entry });
  }

  return (
    <div className="space-y-4">
      <PaneHeader
        title={intl.formatMessage({
          id: "settings.agents.title",
          defaultMessage: "Subagents",
        })}
        description={(
          <FormattedMessage
            id="settings.agents.intro"
            defaultMessage={
              "Each definition becomes a named delegation tool for the built-in runtime. " +
              "The body is the sub-agent's system prompt; wrap a skill name in backticks to bind it."
            }
          />
        )}
        action={(
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setError(null);
                setDrawer({ mode: "create" });
              }}
            >
              <Plus className="size-4" aria-hidden />
              <FormattedMessage id="settings.agents.add" defaultMessage="New agent" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
              aria-label={intl.formatMessage({
                id: "settings.agents.refreshLabel",
                defaultMessage: "Refresh",
              })}
            >
              <RefreshCw className={cn("size-4", isFetching && "animate-spin")} aria-hidden />
            </Button>
          </div>
        )}
      />

      <div className="mb-3 flex items-center gap-2">
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.agents.searchPlaceholder",
            defaultMessage: "Search agents…",
          })}
          className="max-w-xs"
        />
        <Label htmlFor="agents-enabled-filter" className="sr-only">
          <FormattedMessage
            id="settings.agents.filterLabel"
            defaultMessage="Filter by status"
          />
        </Label>
        <select
          id="agents-enabled-filter"
          className="border-border bg-background text-foreground h-9 rounded-md border px-2 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value as EnabledFilter)}
        >
          {FILTER_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt === "all" ? (
                intl.formatMessage({
                  id: "settings.agents.filterAll",
                  defaultMessage: "All",
                })
              ) : opt === "enabled" ? (
                intl.formatMessage({
                  id: "settings.agents.filterEnabled",
                  defaultMessage: "Enabled",
                })
              ) : (
                intl.formatMessage({
                  id: "settings.agents.filterDisabled",
                  defaultMessage: "Disabled",
                })
              )}
            </option>
          ))}
        </select>
      </div>

      <SettingsCard>
        {visible.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            {agents.length === 0 ? (
              <FormattedMessage
                id="settings.agents.empty"
                defaultMessage="No agent definitions yet. Click New to create one."
              />
            ) : (
              <FormattedMessage
                id="settings.agents.noMatches"
                defaultMessage="No agents match your search."
              />
            )}
          </div>
        ) : (
          visible.map((agent) => (
            <AgentRow
              key={agent.name}
              agent={agent}
              busy={
                enableMutation.isPending && enableMutation.variables?.name === agent.name
              }
              onToggleEnabled={(enabled) =>
                enableMutation.mutate({ name: agent.name, enabled })}
              onEdit={() => openEdit(agent)}
              // A builtin definition is undeletable: no delete entry point
              // renders (disabling is the single shutdown axis).
              onDelete={
                agent.source === "builtin" ? undefined : () => setConfirmDelete(agent.name)
              }
            />
          ))
        )}
      </SettingsCard>

      {displayError && drawer.mode === "closed" && (
        <p className="settings-error text-destructive mt-3 text-sm">{displayError}</p>
      )}

      {ignoredFiles.length > 0 && (
        <div className="space-y-1">
          <WarningLine>
            <FormattedMessage
              id="settings.agents.ignored"
              defaultMessage="Some files in the agents registry could not be loaded:"
            />
          </WarningLine>
          <ul className="text-muted-foreground list-inside list-disc text-xs">
            {ignoredFiles.map((skipped) => (
              <li key={skipped.file} title={skipped.reason}>
                {skipped.file}
              </li>
            ))}
          </ul>
        </div>
      )}

      {drawer.mode !== "closed" && (
        <AgentDialog
          key={drawer.mode === "edit" ? drawer.entry.name : "create"}
          editing={drawer.mode === "edit" ? drawer.entry : null}
          saving={createMutation.isPending || updateMutation.isPending}
          error={error}
          onCancel={() => setDrawer({ mode: "closed" })}
          onCreate={(update) => createMutation.mutate(update)}
          onSave={(name, update) => updateMutation.mutate({ name, update })}
        />
      )}

      {confirmDelete && (
        <AlertDialog
          defaultOpen
          onOpenChange={(open) => {
            if (!open) setConfirmDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="settings.agents.confirmDeleteTitle"
                  defaultMessage="Delete agent {name}?"
                  values={{ name: confirmDelete }}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.agents.confirmDeleteBody"
                  defaultMessage="This permanently removes the agent definition {name}. This cannot be undone."
                  values={{ name: confirmDelete }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmDelete(null)}>
                <FormattedMessage
                  id="settings.agents.confirmDeleteCancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => deleteMutation.mutate(confirmDelete)}
              >
                <FormattedMessage
                  id="settings.agents.confirmDeleteConfirm"
                  defaultMessage="Delete"
                />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}

/** The cautionary-disclosure row (the DESIGN warning-indicator pattern: an
 *  8px amber dot + tinted text, never a solid amber fill). */
function WarningLine({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-warning">
      <span className="inline-block size-2 rounded-full bg-warning" aria-hidden />
      {children}
    </p>
  );
}

/** One registry row: identity + routing description + source badge, the
 *  machine-level enablement switch, and the edit / delete actions. Each
 *  interaction is its own control -- the switch and the action buttons
 *  never ride a row-level click target. */
function AgentRow({
  agent,
  busy,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  agent: AgentEntry;
  busy: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  const intl = useIntl();
  return (
    <div className="hover:bg-accent flex items-center gap-3 px-4 py-3">
      <Bot className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={
              agent.enabled
                ? "truncate text-sm font-medium"
                : "text-muted-foreground/60 truncate text-sm font-medium"
            }
          >
            {agent.name}
          </span>
          <Badge variant="secondary" className="shrink-0">
            {agent.source === "builtin" ? (
              <FormattedMessage
                id="settings.agents.sourceBuiltin"
                defaultMessage="Built-in"
              />
            ) : agent.source === "linked" ? (
              <FormattedMessage id="settings.agents.sourceLinked" defaultMessage="Linked" />
            ) : (
              <FormattedMessage id="settings.agents.sourceUser" defaultMessage="Custom" />
            )}
          </Badge>
        </div>
        <p
          className={
            agent.enabled
              ? "text-muted-foreground truncate text-xs"
              : "text-muted-foreground/60 truncate text-xs"
          }
          title={agent.description}
        >
          {agent.description}
        </p>
      </div>
      <Switch
        checked={agent.enabled}
        disabled={busy}
        onCheckedChange={onToggleEnabled}
        aria-label={intl.formatMessage(
          {
            id: "settings.agents.enabledLabel",
            defaultMessage: "Enable agent {name}",
          },
          { name: agent.name },
        )}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground shrink-0"
        aria-label={intl.formatMessage(
          {
            id: "settings.agents.editLabel",
            defaultMessage: "Edit agent {name}",
          },
          { name: agent.name },
        )}
        onClick={onEdit}
      >
        <Pencil className="size-4" aria-hidden />
      </Button>
      {onDelete && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive shrink-0"
          aria-label={intl.formatMessage(
            {
              id: "settings.agents.deleteLabel",
              defaultMessage: "Delete agent {name}",
            },
            { name: agent.name },
          )}
          onClick={onDelete}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      )}
    </div>
  );
}

/** The create / edit dialog. A linked row renders everything disabled (the
 *  app never writes through an external link); a builtin row locks only the
 *  name field. The two warning surfaces (dangling backtick skill marks,
 *  dropped community axes) render from the CURRENT entry -- they describe
 *  the on-disk file, not the draft. */
function AgentDialog({
  editing,
  saving,
  error,
  onCancel,
  onCreate,
  onSave,
}: {
  /** The registry entry an edit dialog seeds from; null in create mode. */
  editing: AgentEntry | null;
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (update: AgentUpdate) => void;
  onSave: (name: string, update: AgentUpdate) => void;
}) {
  const intl = useIntl();
  // A linked definition is read-only wholesale (the app never writes through
  // an external link); a builtin keeps only its name locked.
  const readOnly = editing?.source === "linked";
  const nameLocked = editing?.source === "builtin";
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [preamble, setPreamble] = useState(editing?.preamble ?? "");

  // Client-side pre-validation (the backend stays the authority): name shape
  // + ceiling, description non-blank + ceiling, preamble non-blank.
  const nameInvalid =
    name !== (editing?.name ?? "") &&
    (!AGENT_NAME_PATTERN.test(name) || name.length > AGENT_NAME_MAX);
  const descriptionInvalid =
    description.trim() === "" || description.length > AGENT_DESCRIPTION_MAX;
  const preambleInvalid = preamble.trim() === "";
  const canSave = !readOnly && !nameInvalid && !descriptionInvalid && !preambleInvalid;

  const update: AgentUpdate = { name, description, preamble };

  return (
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? (
              <FormattedMessage
                id="settings.agents.editTitle"
                defaultMessage="Edit agent {name}"
                values={{ name: editing.name }}
              />
            ) : (
              <FormattedMessage id="settings.agents.createTitle" defaultMessage="New agent" />
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agent-name">
              <FormattedMessage id="settings.agents.nameLabel" defaultMessage="Name" />
            </Label>
            <Input
              id="agent-name"
              value={name}
              disabled={readOnly || nameLocked}
              onChange={(e) => setName(e.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.agents.namePlaceholder",
                defaultMessage: "data-cleaner",
              })}
              aria-invalid={nameInvalid}
            />
            {nameInvalid && (
              <p className="text-destructive text-xs">
                <FormattedMessage
                  id="settings.agents.nameInvalid"
                  defaultMessage="Lowercase letters, digits, and single hyphens (max 64 chars)"
                />
              </p>
            )}
            {nameLocked && (
              <p className="text-muted-foreground text-xs">
                <FormattedMessage
                  id="settings.agents.nameLockedHint"
                  defaultMessage="A built-in agent keeps its name."
                />
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-description">
              <FormattedMessage
                id="settings.agents.descriptionLabel"
                defaultMessage="Description"
              />
            </Label>
            <Input
              id="agent-description"
              value={description}
              disabled={readOnly}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.agents.descriptionPlaceholder",
                defaultMessage: "What the main agent should delegate to it",
              })}
              aria-invalid={descriptionInvalid}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="agent-preamble">
              <FormattedMessage id="settings.agents.preambleLabel" defaultMessage="Preamble" />
            </Label>
            <Textarea
              id="agent-preamble"
              rows={8}
              value={preamble}
              disabled={readOnly}
              onChange={(e) => setPreamble(e.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.agents.preamblePlaceholder",
                defaultMessage: "The sub-agent's system prompt...",
              })}
              aria-invalid={preambleInvalid}
            />
            <p className="text-muted-foreground text-xs">
              <FormattedMessage
                id="settings.agents.preambleHint"
                defaultMessage={
                  "This becomes the sub-agent's system prompt. Wrap a skill name in " +
                  "backticks (e.g. `pdf-tools`) to bind it at delegation time."
                }
              />
            </p>
          </div>

          {editing && editing.dangling_skill_refs.length > 0 && (
            <WarningLine>
              <FormattedMessage
                id="settings.agents.danglingRefs"
                defaultMessage="Unknown skill reference: {refs}"
                values={{ refs: editing.dangling_skill_refs.map((r) => `\`${r}\``).join(", ") }}
              />
            </WarningLine>
          )}
          {editing && editing.dropped_axes.length > 0 && (
            <WarningLine>
              <FormattedMessage
                id="settings.agents.droppedAxes"
                defaultMessage="Ignored by this app: {axes}"
                values={{ axes: editing.dropped_axes.join(", ") }}
              />
            </WarningLine>
          )}
        </div>

        {readOnly && (
          <p className="text-muted-foreground text-sm">
            <FormattedMessage
              id="settings.agents.linkedReadOnly"
              defaultMessage="This definition is linked from outside the app. Edits happen at the source."
            />
          </p>
        )}

        {error && <p className="settings-error text-destructive text-sm">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            <FormattedMessage id="settings.agents.cancel" defaultMessage="Cancel" />
          </Button>
          <Button
            disabled={!canSave || saving}
            onClick={() =>
              editing ? onSave(editing.name, update) : onCreate(update)}
          >
            <FormattedMessage id="settings.agents.save" defaultMessage="Save" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
