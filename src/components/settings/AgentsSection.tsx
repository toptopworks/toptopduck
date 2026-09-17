import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Bot,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import type { AgentEntry, AgentUpdate } from "../../types/agents";
import type { AppConfig } from "../../types/app-config";
import {
  createAgent,
  deleteAgent,
  getAgentsDir,
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  FieldHint,
  HeaderActionButton,
  PaneBackLink,
  RowActionButton,
  NameBadge,
  PaneHeader,
  SettingsCard,
  SettingsRow,
} from "./settings-chrome";
import {
  type EnabledFilter,
  FILTER_OPTIONS,
  matchesFilter,
  matchesSearch,
  searchableText,
} from "./settings-filters";

// The pane's navigation name: the list header and the create/edit form share
// it -- the form keeps the name for section context, without the list-only
// action buttons.
const NAV_TITLE = (
  <FormattedMessage id="settings.agents.title" defaultMessage="Subagents" />
);

// Agents settings pane (issue #932, ADR-0117). The registry is a directory
// scan (no app-config entity -- the definitions are files), so this pane
// reads list_agents + drives create / update / delete through TanStack
// mutations that invalidate the one agents query. Enablement is a separate
// machine-level axis in app-config: the row Switch flips it through
// set_agent_enabled, whose updated FULL config syncs the caller's snapshot
// (the ADR-0109 Decision 9 contract, same channel as the Skills pane).
// Built-in rows keep their name locked and carry a disabled delete button
// (disabling is the single shutdown axis); linked rows are read-only.

// The backend name/description rules, mirrored client-side (the
// SkillsSection posture) so the form gates Save BEFORE an IPC round-trip.
// The backend remains the authority; these only move the feedback earlier.
const AGENT_NAME_MAX = 64;
const AGENT_DESCRIPTION_MAX = 1024;
const AGENT_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type FormState =
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
  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Reveal failures live apart from `error`: that state is the open form's
  // error prop, and a late reveal rejection must not render inside a draft
  // (the GeneralSection dirError posture).
  const [dirError, setDirError] = useState<string | null>(null);

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
      setForm({ mode: "closed" });
    },
    onError: (e) => setError(fmtError(e, intl)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, update }: { name: string; update: AgentUpdate }) =>
      updateAgent(name, update),
    onSuccess: () => {
      invalidate();
      setError(null);
      setForm({ mode: "closed" });
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
    () =>
      agents.filter(
        (a) =>
          matchesSearch(searchableText(a.name, a.description), search) &&
          matchesFilter(a, filter),
      ),
    [agents, search, filter],
  );
  const ignoredFiles = useMemo(() => listing?.ignored ?? [], [listing]);
  const warnings = useMemo(() => listing?.warnings ?? [], [listing]);
  const rootError = listing?.root_error ?? null;

  // Derived display error (the SkillsSection priority order): the mutation
  // error first, then the IPC transport error, then the root scan error.
  const displayError = useMemo(() => {
    if (error) return error;
    if (dirError) return dirError;
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
  }, [error, dirError, queryError, rootError, intl]);

  function openEdit(entry: AgentEntry) {
    // The form owns the error face while open (a leftover list error would
    // replay inside an unrelated edit form).
    setError(null);
    setForm({ mode: "edit", entry });
  }

  // Reveal the registry root in the OS file manager (the GeneralSection
  // revealSessionsDir posture): a failure lands on the dedicated pane-level
  // dir error, never the state an open form shares.
  async function openAgentsDir() {
    setDirError(null);
    try {
      await revealItemInDir(await getAgentsDir());
    } catch (e) {
      setDirError(fmtError(e, intl));
    }
  }

  // The create/edit form replaces the whole pane (the McpServerForm posture):
  // a full-page form reads better than a modal over the list it edits. The
  // navigation name stays above the form (the section context); the list
  // header's action buttons do not -- they are list-only.
  if (form.mode !== "closed") {
    return (
      <div>
        <PaneHeader title={NAV_TITLE} />
        <AgentForm
          key={form.mode === "edit" ? form.entry.name : "create"}
          editing={form.mode === "edit" ? form.entry : null}
          saving={createMutation.isPending || updateMutation.isPending}
          error={error}
          onCancel={() => setForm({ mode: "closed" })}
          onCreate={(update) => createMutation.mutate(update)}
          onSave={(name, update) => updateMutation.mutate({ name, update })}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PaneHeader
        title={NAV_TITLE}
        description={(
          <FormattedMessage
            id="settings.agents.intro"
            defaultMessage="Create helpers the main agent can hand work to. Each helper has its own name and instructions."
          />
        )}
        action={(
          <div className="flex items-center gap-1.5">
            <HeaderActionButton
              label={intl.formatMessage({
                id: "settings.agents.add",
                defaultMessage: "New agent",
              })}
              icon={Plus}
              onClick={() => {
                setError(null);
                setForm({ mode: "create" });
              }}
            />
            <HeaderActionButton
              label={intl.formatMessage({
                id: "settings.agents.openDir",
                defaultMessage: "Open agents folder",
              })}
              icon={FolderOpen}
              onClick={() => void openAgentsDir()}
            />
            <HeaderActionButton
              label={intl.formatMessage({
                id: "common.refresh",
                defaultMessage: "Refresh",
              })}
              icon={RefreshCw}
              spinning={isFetching}
              onClick={() => void refetch()}
            />
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
        <Select value={filter} onValueChange={(v) => setFilter(v as EnabledFilter)}>
          <SelectTrigger
            id="agents-enabled-filter"
            aria-label={intl.formatMessage({
              id: "settings.agents.filterLabel",
              defaultMessage: "Filter by status",
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt === "all" ? (
                  <FormattedMessage id="settings.agents.filterAll" defaultMessage="All" />
                ) : opt === "enabled" ? (
                  <FormattedMessage id="settings.agents.filterEnabled" defaultMessage="Enabled" />
                ) : (
                  <FormattedMessage id="settings.agents.filterDisabled" defaultMessage="Disabled" />
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
              // A builtin definition is undeletable: its delete button
              // renders disabled (disabling is the single shutdown axis).
              onDelete={
                agent.source === "builtin" ? undefined : () => setConfirmDelete(agent.name)
              }
            />
          ))
        )}
      </SettingsCard>

      {displayError && (
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

      {warnings.length > 0 && (
        <div className="space-y-1">
          <WarningLine>
            <FormattedMessage
              id="settings.agents.builtinWarnings"
              defaultMessage="Built-in agents are in a degraded state:"
            />
          </WarningLine>
          <ul className="text-muted-foreground list-inside list-disc text-xs">
            {warnings.map((warning) => {
              // The catalog owns each posture's wording (issue #937): the
              // row must name the real cause, never a false attribution.
              // The never guard makes a future backend variant fail at
              // compile time, not render as the wrong posture's cause
              // (the LocalCliTab probe switch pattern).
              switch (warning.state) {
                case "deferred":
                  return (
                    <li key={`${warning.state}-${warning.name}`}>
                      <FormattedMessage
                        id="settings.agents.warningDeferred"
                        defaultMessage="A built-in agent is waiting for the name {name}: it materializes once the file is renamed or removed and the app restarts."
                        values={{ name: warning.name }}
                      />
                    </li>
                  );
                case "read_fault":
                  return (
                    <li key={`${warning.state}-${warning.name}`}>
                      <FormattedMessage
                        id="settings.agents.warningReadFault"
                        defaultMessage="The file holding the built-in agent {name} could not be read."
                        values={{ name: warning.name }}
                      />
                    </li>
                  );
                case "not_materialized":
                  return (
                    <li key={`${warning.state}-${warning.name}`}>
                      <FormattedMessage
                        id="settings.agents.warningNotMaterialized"
                        defaultMessage="The built-in agent {name} has not materialized yet; the next app start retries."
                        values={{ name: warning.name }}
                      />
                    </li>
                  );
                default: {
                  const _exhaustive: never = warning;
                  throw new Error(`Unknown builtin warning state: ${String(_exhaustive)}`);
                }
              }
            })}
          </ul>
        </div>
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
      <Bot
        className={cn(
          "size-4 shrink-0",
          // A disabled agent is dormant: the glyph dims with the name, the
          // CLI row's disabled-icon treatment.
          agent.enabled ? "text-muted-foreground" : "text-muted-foreground/40",
        )}
        aria-hidden
      />
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
          <NameBadge>
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
          </NameBadge>
          {!agent.enabled && (
            <NameBadge>
              <FormattedMessage id="common.disabled" defaultMessage="Disabled" />
            </NameBadge>
          )}
        </div>
        <p
          className={
            agent.enabled
              ? "text-muted-foreground text-xs"
              : "text-muted-foreground/60 text-xs"
          }
        >
          {agent.description}
        </p>
      </div>
      {/* The action cluster (the skills / CLI row posture): one tight
          shrink-0 group hugging the row end, the switch set apart by a
          breath before the gap-0.5 action pair. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <Switch
          className="mr-1.5"
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
        <RowActionButton
          label={intl.formatMessage(
            {
              id: "settings.agents.editLabel",
              defaultMessage: "Edit agent {name}",
            },
            { name: agent.name },
          )}
          icon={Pencil}
          onClick={onEdit}
        />
        {/* The delete renders on EVERY row (disabled on a builtin
            definition): a per-row absent button would shift the switch /
            edit columns across rows. Disabling stays the single shutdown
            axis for builtins. */}
        <RowActionButton
          destructive
          disabled={!onDelete}
          label={intl.formatMessage(
            {
              id: "settings.agents.deleteLabel",
              defaultMessage: "Delete agent {name}",
            },
            { name: agent.name },
          )}
          icon={Trash2}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

/** The create / edit form. A full-page replacement for the pane list (the
 *  McpServerForm posture). A linked row renders everything disabled (the
 *  app never writes through an external link); a builtin row locks only the
 *  name field. The two warning surfaces (dangling backtick skill marks,
 *  dropped community axes) render from the CURRENT entry -- they describe
 *  the on-disk file, not the draft. */
function AgentForm({
  editing,
  saving,
  error,
  onCancel,
  onCreate,
  onSave,
}: {
  /** The registry entry an edit form seeds from; null in create mode. */
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
  // Error surfaces wait for the first edit of each field -- a freshly opened
  // create form shows no red at all (SkillsSection marks touched on blur;
  // here onChange, so a field validates as soon as its first keystroke
  // lands).
  const [nameTouched, setNameTouched] = useState(false);
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [preambleTouched, setPreambleTouched] = useState(false);

  // Client-side pre-validation (the backend stays the authority): name
  // present in create mode (the SkillsSection empty-name flag), name shape
  // + ceiling, description non-blank + ceiling, preamble non-blank.
  const nameInvalid =
    (editing === null && name.trim() === "") ||
    (name !== (editing?.name ?? "") &&
      (!AGENT_NAME_PATTERN.test(name) || name.length > AGENT_NAME_MAX));
  const descriptionInvalid =
    description.trim() === "" || description.length > AGENT_DESCRIPTION_MAX;
  const preambleInvalid = preamble.trim() === "";
  const canSave = !readOnly && !nameInvalid && !descriptionInvalid && !preambleInvalid;

  const update: AgentUpdate = { name, description, preamble };

  return (
    <div>
      <PaneBackLink onClick={onCancel} disabled={saving}>
        <FormattedMessage
          id="settings.agents.backToList"
          defaultMessage="Back to agent list"
        />
      </PaneBackLink>
      <PaneHeader
        size="form"
        title={editing ? (
          <FormattedMessage
            id="settings.agents.editTitle"
            defaultMessage="Edit agent {name}"
            values={{ name: editing.name }}
          />
        ) : (
          <FormattedMessage id="settings.agents.createTitle" defaultMessage="New agent" />
        )}
      />

      <SettingsCard className="divide-y-0">
        <SettingsRow
          dense
          title={(
            <Label htmlFor="agent-name" className="text-muted-foreground">
              <FormattedMessage id="settings.agents.nameLabel" defaultMessage="Name" />
            </Label>
          )}
        >
          <Input
            id="agent-name"
            value={name}
            disabled={readOnly || nameLocked}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
            placeholder={intl.formatMessage({
              id: "settings.agents.namePlaceholder",
              defaultMessage: "data-cleaner",
            })}
            aria-invalid={nameTouched && nameInvalid}
          />
          {nameTouched && nameInvalid && (
            <p className="text-destructive mt-2 text-xs">
              <FormattedMessage
                id="settings.agents.nameInvalid"
                defaultMessage="Lowercase letters, digits, and single hyphens (max 64 chars)"
              />
            </p>
          )}
        </SettingsRow>

        <SettingsRow
          dense
          title={(
            <Label htmlFor="agent-description" className="text-muted-foreground">
              <FormattedMessage
                id="settings.agents.descriptionLabel"
                defaultMessage="Description"
              />
            </Label>
          )}
        >
          <Textarea
            id="agent-description"
            rows={3}
            value={description}
            disabled={readOnly}
            onChange={(e) => {
              setDescription(e.target.value);
              setDescriptionTouched(true);
            }}
            placeholder={intl.formatMessage({
              id: "settings.agents.descriptionPlaceholder",
              defaultMessage: "What the main agent should delegate to it",
            })}
            aria-invalid={descriptionTouched && descriptionInvalid}
          />
        </SettingsRow>

        <SettingsRow
          dense
          title={(
            <span className="flex items-center gap-1">
              <Label htmlFor="agent-preamble" className="text-muted-foreground">
                <FormattedMessage id="settings.agents.preambleLabel" defaultMessage="Preamble" />
              </Label>
              <FieldHint
                label={intl.formatMessage({
                  id: "settings.agents.preambleHintAria",
                  defaultMessage: "Preamble explanation",
                })}
              >
                <FormattedMessage
                  id="settings.agents.preambleHint"
                  defaultMessage={
                    "This becomes the sub-agent's system prompt. Wrap a skill name in " +
                    "backticks (e.g. `pdf-tools`) to bind it at delegation time."
                  }
                />
              </FieldHint>
            </span>
          )}
        >
          <Textarea
            id="agent-preamble"
            rows={8}
            value={preamble}
            disabled={readOnly}
            onChange={(e) => {
              setPreamble(e.target.value);
              setPreambleTouched(true);
            }}
            placeholder={intl.formatMessage({
              id: "settings.agents.preamblePlaceholder",
              defaultMessage: "The sub-agent's system prompt...",
            })}
            aria-invalid={preambleTouched && preambleInvalid}
          />
        </SettingsRow>

        {editing && editing.dangling_skill_refs.length > 0 && (
          <div className="px-4 py-2.5">
            <WarningLine>
              <FormattedMessage
                id="settings.agents.danglingRefs"
                defaultMessage="Unknown skill reference: {refs}"
                values={{ refs: editing.dangling_skill_refs.map((r) => `\`${r}\``).join(", ") }}
              />
            </WarningLine>
          </div>
        )}
        {editing && editing.dropped_axes.length > 0 && (
          <div className="px-4 py-2.5">
            <WarningLine>
              <FormattedMessage
                id="settings.agents.droppedAxes"
                defaultMessage="Ignored by this app: {axes}"
                values={{ axes: editing.dropped_axes.join(", ") }}
              />
            </WarningLine>
          </div>
        )}
        {readOnly && (
          <div className="px-4 py-2.5">
            <p className="text-muted-foreground text-sm">
              <FormattedMessage
                id="settings.agents.linkedReadOnly"
                defaultMessage="This definition is linked from outside the app. Edits happen at the source."
              />
            </p>
          </div>
        )}

        {error && (
          <p className="settings-error text-destructive px-4 py-1.5 text-sm">{error}</p>
        )}

        <div className="flex items-center gap-2 px-4 py-3">
          <Button
            type="button"
            disabled={!canSave || saving}
            onClick={() =>
              editing ? onSave(editing.name, update) : onCreate(update)}
          >
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {saving ? (
              <FormattedMessage id="common.saving" defaultMessage="Saving…" />
            ) : (
              <FormattedMessage id="settings.agents.save" defaultMessage="Save" />
            )}
          </Button>
        </div>
      </SettingsCard>
    </div>
  );
}
