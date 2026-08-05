import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";

import type { SkillAcquired, SkillEntry, SkillUpdate } from "../../types/skills";
import { createSkill, deleteSkill, listSkills, updateSkill } from "../../api";
import { fmtError } from "../../lib/error-presentation";
import { skillKeys } from "../../session/queryKeys";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { PaneHeader, SettingsCard } from "./settings-chrome";

// Skills settings pane (issue #362, ADR-0086). The registry is a directory
// scan (no app-config entry), so this pane reads list_skills + drives
// create / update / delete through TanStack mutations that invalidate the one
// skills query. `local` skills open a full-edit drawer; `linked` skills open a
// read-only drawer with an "open source location" reveal. The Import header
// button is rendered disabled -- the two-stage import dialog lands in #367.

type AcquiredFilter = "all" | SkillAcquired;

type DrawerState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; name: string };

/** The editable draft carried by the drawer. `currentName` is the CURRENT
 *  directory name when editing (the addressing key for update_skill); it is
 *  empty in create mode. */
type DrawerDraft = {
  currentName: string;
  name: string;
  description: string;
  license: string;
  compatibility: string;
  mcpServers: string[];
  body: string;
  acquired: SkillAcquired;
  linkTarget: string | null;
};

const FILTER_OPTIONS: ReadonlyArray<AcquiredFilter> = ["all", "linked", "local"];

const ROW_CLASS =
  "hover:bg-accent focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 flex cursor-pointer items-center gap-3 px-4 py-3 outline-none";

function matchesSearch(skill: SkillEntry, query: string): boolean {
  if (query.trim() === "") return true;
  const haystack = `${skill.name}\n${skill.description}`.toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

function matchesFilter(skill: SkillEntry, filter: AcquiredFilter): boolean {
  return filter === "all" || skill.acquired === filter;
}

export function SkillsSection({ configuredMcpIds }: { configuredMcpIds: string[] }) {
  const intl = useIntl();
  const queryClient = useQueryClient();

  const { data: skills, refetch, isFetching } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AcquiredFilter>("all");
  const [drawer, setDrawer] = useState<DrawerState>({ mode: "closed" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.all() });
  };

  const createMutation = useMutation({
    mutationFn: ({ name, description }: { name: string; description: string }) =>
      createSkill(name, description),
    onSuccess: () => {
      invalidate();
      setDrawer({ mode: "closed" });
    },
    onError: (e) => setError(fmtError(e, intl)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, update }: { name: string; update: SkillUpdate }) =>
      updateSkill(name, update),
    onSuccess: () => {
      invalidate();
      setDrawer({ mode: "closed" });
    },
    onError: (e) => setError(fmtError(e, intl)),
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => deleteSkill(name),
    onSuccess: () => {
      invalidate();
      setConfirmDelete(null);
    },
    onError: (e) => {
      setError(fmtError(e, intl));
      setConfirmDelete(null);
    },
  });

  const allSkills = useMemo(() => skills ?? [], [skills]);
  const visible = useMemo(
    () =>
      allSkills.filter(
        (s) => matchesSearch(s, search) && matchesFilter(s, filter),
      ),
    [allSkills, search, filter],
  );

  function openEdit(skill: SkillEntry) {
    setDrawer({ mode: "edit", name: skill.name });
  }

  async function openSource(target: string | null) {
    if (!target) return;
    try {
      await revealItemInDir(target);
    } catch (e) {
      setError(fmtError(e, intl));
    }
  }

  const drawerDraft = useMemo<DrawerDraft | null>(() => {
    if (drawer.mode === "create") {
      return {
        currentName: "",
        name: "",
        description: "",
        license: "",
        compatibility: "",
        mcpServers: [],
        body: "",
        acquired: "local",
        linkTarget: null,
      };
    }
    if (drawer.mode === "edit") {
      const skill = allSkills.find((s) => s.name === drawer.name);
      if (!skill) return null;
      return {
        currentName: skill.name,
        name: skill.name,
        description: skill.description,
        license: skill.license ?? "",
        compatibility: skill.compatibility ?? "",
        mcpServers: skill.mcp_servers,
        body: skill.body,
        acquired: skill.acquired,
        linkTarget: skill.link_target,
      };
    }
    return null;
  }, [drawer, allSkills]);

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.skills" defaultMessage="Skills" />}
        description={(
          <FormattedMessage
            id="settings.skills.description"
            defaultMessage="Agent Skills live as directories under the app-data folder. Local skills are editable; linked skills are read-only."
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
              <FormattedMessage id="settings.skills.new" defaultMessage="New" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled
              title={intl.formatMessage({
                id: "settings.skills.importDisabled",
                defaultMessage: "Importing from external agent libraries arrives in a follow-up",
              })}
            >
              <Download className="size-4" aria-hidden />
              <FormattedMessage id="settings.skills.import" defaultMessage="Import" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refetch()}
              aria-label={intl.formatMessage({
                id: "settings.skills.rescan",
                defaultMessage: "Rescan",
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
            id: "settings.skills.searchPlaceholder",
            defaultMessage: "Search skills…",
          })}
          className="max-w-xs"
        />
        <Label htmlFor="skills-acquired-filter" className="sr-only">
          <FormattedMessage
            id="settings.skills.filterLabel"
            defaultMessage="Filter by acquired"
          />
        </Label>
        <select
          id="skills-acquired-filter"
          className="border-border bg-background text-foreground h-9 rounded-md border px-2 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value as AcquiredFilter)}
        >
          {FILTER_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt === "all"
                ? intl.formatMessage({
                    id: "settings.skills.filterAll",
                    defaultMessage: "All",
                  })
                : opt === "linked"
                  ? intl.formatMessage({
                      id: "settings.skills.filterLinked",
                      defaultMessage: "Linked",
                    })
                  : intl.formatMessage({
                      id: "settings.skills.filterLocal",
                      defaultMessage: "Local",
                    })}
            </option>
          ))}
        </select>
      </div>

      <SettingsCard>
        {visible.length === 0 ? (
          <div className="text-muted-foreground px-4 py-8 text-center text-sm">
            {allSkills.length === 0 ? (
              <FormattedMessage
                id="settings.skills.empty"
                defaultMessage="No skills yet. Click New to author one."
              />
            ) : (
              <FormattedMessage
                id="settings.skills.noMatches"
                defaultMessage="No skills match your search."
              />
            )}
          </div>
        ) : (
          visible.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              onOpen={() => openEdit(skill)}
              onDelete={() => setConfirmDelete(skill.name)}
            />
          ))
        )}
      </SettingsCard>

      {error && <p className="settings-error mt-3 text-destructive text-sm">{error}</p>}

      {drawerDraft && (
        <SkillDrawer
          key={drawerDraft.currentName}
          draft={drawerDraft}
          configuredMcpIds={configuredMcpIds}
          saving={saving}
          onCancel={() => setDrawer({ mode: "closed" })}
          onCreate={(name, description) => createMutation.mutate({ name, description })}
          onSave={(update) => updateMutation.mutate({ name: drawerDraft.currentName, update })}
          onOpenSource={(target) => void openSource(target)}
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
                  id="settings.skills.confirmDeleteTitle"
                  defaultMessage="Delete skill?"
                  values={{ name: confirmDelete }}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.skills.confirmDeleteBody"
                  defaultMessage="This permanently removes the skill {name}. This cannot be undone."
                  values={{ name: confirmDelete }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={() => setConfirmDelete(null)}>
                <FormattedMessage
                  id="settings.skills.confirmDeleteCancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => deleteMutation.mutate(confirmDelete)}
              >
                <FormattedMessage
                  id="settings.skills.confirmDeleteConfirm"
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

type SkillRowProps = {
  skill: SkillEntry;
  onOpen: () => void;
  onDelete: () => void;
};

function SkillRow({ skill, onOpen, onDelete }: SkillRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="skill-row"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={ROW_CLASS}
    >
      <Puzzle className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          <Badge variant="secondary" className="shrink-0">
            {skill.acquired === "linked" ? (
              <FormattedMessage
                id="settings.skills.acquiredLinked"
                defaultMessage="linked"
              />
            ) : (
              <FormattedMessage
                id="settings.skills.acquiredLocal"
                defaultMessage="local"
              />
            )}
          </Badge>
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {skill.description}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive shrink-0"
        aria-label={skill.name}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

type SkillDrawerProps = {
  draft: DrawerDraft;
  configuredMcpIds: string[];
  saving: boolean;
  onCancel: () => void;
  onCreate: (name: string, description: string) => void;
  onSave: (update: SkillUpdate) => void;
  onOpenSource: (target: string | null) => void;
};

function SkillDrawer({
  draft,
  configuredMcpIds,
  saving,
  onCancel,
  onCreate,
  onSave,
  onOpenSource,
}: SkillDrawerProps) {
  const isCreate = draft.currentName === "";
  const isLinked = draft.acquired === "linked";
  const readOnly = isLinked;
  // Local draft state so the user can type before committing. Reset when the
  // draft identity changes (switching skills / opening create).
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [license, setLicense] = useState(draft.license);
  const [compatibility, setCompatibility] = useState(draft.compatibility);
  const [mcpServers, setMcpServers] = useState<string[]>(draft.mcpServers);
  const [body, setBody] = useState(draft.body);
  // No effect syncs draft -> local state: the parent keys this drawer by the
  // skill name, so switching skills (or opening create) REMOUNTS it and the
  // useState initializers above re-seed from the new draft. Typing edits only
  // local state -- the key stays stable, no remount, no clobber (React 19
  // "reset state with a key" pattern, cf. react-hooks/set-state-in-effect).

  // The mcp multi-select lists every configured server plus any id the skill
  // already references that is no longer configured (so a stale reference
  // stays visible + removable rather than silently dropping).
  const mcpOptions = useMemo(() => {
    const merged = new Set<string>(configuredMcpIds);
    mcpServers.forEach((id) => merged.add(id));
    return [...merged];
  }, [configuredMcpIds, mcpServers]);

  function toggleMcp(id: string) {
    setMcpServers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function handleSave() {
    if (isCreate) {
      onCreate(name.trim(), description.trim());
      return;
    }
    onSave({
      name: name.trim(),
      description: description.trim(),
      license: license.trim() === "" ? null : license.trim(),
      compatibility: compatibility.trim() === "" ? null : compatibility.trim(),
      mcp_servers: mcpServers,
      body,
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton>
        <DialogTitle className="sr-only">
          {isCreate ? (
            <FormattedMessage
              id="settings.skills.drawerCreateTitle"
              defaultMessage="New skill"
            />
          ) : (
            <FormattedMessage
              id="settings.skills.drawerEditTitle"
              defaultMessage="Edit skill {name}"
              values={{ name: draft.currentName }}
            />
          )}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {isLinked ? (
            <FormattedMessage
              id="settings.skills.readOnlyHint"
              defaultMessage="Linked skills are read-only. Edit the source instead."
            />
          ) : (
            <FormattedMessage
              id="settings.skills.drawerDescription"
              defaultMessage="Edit the skill's declaration."
            />
          )}
        </DialogDescription>

        <div className="grid max-h-[70vh] gap-4 overflow-y-auto">
          <div className="grid gap-1.5">
            <Label htmlFor="skill-name">
              <FormattedMessage
                id="settings.skills.fieldName"
                defaultMessage="Name"
              />
            </Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={readOnly}
              placeholder="pdf-tools"
            />
            <p className="text-muted-foreground text-xs">
              <FormattedMessage
                id="settings.skills.fieldNameHint"
                defaultMessage="kebab-case (lowercase a-z / 0-9 + hyphens); equals the directory name"
              />
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="skill-description">
              <FormattedMessage
                id="settings.skills.fieldDescription"
                defaultMessage="Description"
              />
            </Label>
            <Input
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={readOnly}
            />
          </div>

          {!isCreate && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="skill-license">
                  <FormattedMessage
                    id="settings.skills.fieldLicense"
                    defaultMessage="License"
                  />
                </Label>
                <Input
                  id="skill-license"
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  disabled={readOnly}
                  placeholder="MIT"
                />
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="skill-compatibility">
                  <FormattedMessage
                    id="settings.skills.fieldCompatibility"
                    defaultMessage="Compatibility"
                  />
                </Label>
                <Input
                  id="skill-compatibility"
                  value={compatibility}
                  onChange={(e) => setCompatibility(e.target.value)}
                  disabled={readOnly}
                />
              </div>

              <div className="grid gap-1.5">
                <span className="text-sm font-medium">
                  <FormattedMessage
                    id="settings.skills.fieldMcpServers"
                    defaultMessage="MCP server references"
                  />
                </span>
                {mcpOptions.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    <FormattedMessage
                      id="settings.skills.fieldMcpServersEmpty"
                      defaultMessage="No MCP servers configured."
                    />
                  </p>
                ) : (
                  <div className="grid gap-1">
                    {mcpOptions.map((id) => (
                      <label
                        key={id}
                        className="flex items-center gap-1.5 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={mcpServers.includes(id)}
                          disabled={readOnly}
                          onChange={() => toggleMcp(id)}
                        />
                        {id}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="skill-body">
                  <FormattedMessage
                    id="settings.skills.fieldBody"
                    defaultMessage="Body"
                  />
                </Label>
                <Textarea
                  id="skill-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={readOnly}
                  rows={10}
                  className="font-mono text-sm"
                />
              </div>
            </>
          )}
        </div>

        {isLinked && (
          <p className="text-muted-foreground text-xs">
            <FormattedMessage
              id="settings.skills.readOnlyHint"
              defaultMessage="Linked skills are read-only. Edit the source instead."
            />
          </p>
        )}

        <DialogFooter>
          {isLinked && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenSource(draft.linkTarget)}
              disabled={!draft.linkTarget}
            >
              <FormattedMessage
                id="settings.skills.openSource"
                defaultMessage="Open source location"
              />
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel}>
            <FormattedMessage id="settings.skills.cancel" defaultMessage="Cancel" />
          </Button>
          {!isLinked && (
            <Button type="button" onClick={handleSave} disabled={saving}>
              {saving ? (
                <FormattedMessage
                  id="settings.skills.saving"
                  defaultMessage="Saving…"
                />
              ) : (
                <FormattedMessage id="settings.skills.save" defaultMessage="Save" />
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
