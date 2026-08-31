import { useMemo, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, Plus, Puzzle, RefreshCw, RotateCcw, Trash2 } from "lucide-react";

import type {
  BuiltinSkillBaseline,
  SkillAcquired,
  SkillEntry,
  SkillUpdate,
  SkippedSkill,
} from "../../types/skills";
import type { AppConfig } from "../../types/app-config";
import {
  createSkill,
  deleteSkill,
  listSkills,
  restoreBuiltinSkill,
  updateSkill,
} from "../../api";
import { ImportSkillsDialog } from "./ImportSkillsDialog";
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
  DialogHeader,
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
// button opens the two-stage drill-down import dialog (issue #367), which
// links / copies skills from external agent libraries and invalidates the same
// skills query on success.

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
  cliTools: string[];
  body: string;
  acquired: SkillAcquired;
  linkTarget: string | null;
};

// The Agent Skills spec ceilings + name rule, mirrored client-side from the
// backend's validate_skill_name / validate_description (skills/model.rs) so
// the drawer can gate Save BEFORE an IPC round-trip instead of surfacing the
// typed reject after one. The backend remains the authority; these only move
// the feedback earlier.
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const FILTER_OPTIONS: ReadonlyArray<AcquiredFilter> = [
  "all",
  "linked",
  "local",
  "builtin",
];

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

export function SkillsSection({
  mcpServerLabels,
  configuredCliIds,
  builtinSkillBaselines,
  onAppConfigSync,
}: {
  /** The configured MCP servers as id -> display-name pairs: the drawer's
   *  reference list shows the renamable display name, NOT the raw id (a
   *  uuid); a stale reference no longer configured falls back to the bare
   *  id so it stays visible + removable. */
  mcpServerLabels: Record<string, string>;
  configuredCliIds: string[];
  /** The builtin-skill baseline side table (issue #677): the anchor the
   *  Edited derivation on builtin rows compares each skill's
   *  `content_hash` against. */
  builtinSkillBaselines: Record<string, BuiltinSkillBaseline>;
  /** Sync the shell's app-config wholesale after a restore command (the
   *  command already persisted and returned the updated full config -- the
   *  same state-only-sync contract the CLI pane's writes use). */
  onAppConfigSync: (cfg: AppConfig) => void;
}) {
  const intl = useIntl();
  const queryClient = useQueryClient();

  const { data: listing, error: queryError, refetch, isFetching } = useQuery({
    queryKey: skillKeys.all(),
    queryFn: listSkills,
  });

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AcquiredFilter>("all");
  const [drawer, setDrawer] = useState<DrawerState>({ mode: "closed" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.all() });
  };

  const createMutation = useMutation({
    mutationFn: ({ name, description }: { name: string; description: string }) =>
      createSkill(name, description),
    onSuccess: (entry) => {
      invalidate();
      // A stale reject must not ride into the post-create edit drawer.
      setError(null);
      // Straight into the edit drawer for the minted skill: the backend
      // wrote the skeleton body, and authoring the real one is the natural
      // next step. The key flip ("" -> the name) remounts the drawer seeded
      // from the returned entry (createMutation.data bridges the refetch
      // gap until allSkills carries it).
      setDrawer({ mode: "edit", name: entry.name });
    },
    onError: (e) => setError(fmtError(e, intl)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ name, update }: { name: string; update: SkillUpdate }) =>
      updateSkill(name, update),
    onSuccess: () => {
      invalidate();
      // Drop a stale reject so a reopened drawer never seeds off an
      // outdated error.
      setError(null);
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

  // The explicit builtin-skill restore (issue #677): the command returns the
  // updated full config (synced wholesale) and the skills query refetches so
  // the row's content_hash -- and with it the Edited derivation -- follows.
  const restoreMutation = useMutation({
    mutationFn: (name: string) => restoreBuiltinSkill(name),
    onSuccess: (cfg) => {
      onAppConfigSync(cfg);
      invalidate();
      setConfirmRestore(null);
    },
    onError: (e) => {
      setError(fmtError(e, intl));
      setConfirmRestore(null);
    },
  });

  const allSkills = useMemo<SkillEntry[]>(
    () => listing?.skills ?? [],
    [listing],
  );
  const ignoredDirs = useMemo(
    () => listing?.ignored ?? [],
    [listing],
  );
  const rootError = listing?.root_error ?? null;

  // Derived display error (issue #375): mutation error (explicit state, the
  // user's most recent action) takes priority, then the IPC transport error
  // (list_skills itself failed), then the root scan error (read_dir failed
  // for a reason other than NotFound). All three share the same error face so
  // the user never sees a silent empty registry when something went wrong.
  const displayError = useMemo(() => {
    if (error) return error;
    if (queryError) return fmtError(queryError, intl);
    if (rootError) {
      return intl.formatMessage(
        {
          id: "settings.skills.scanFailed",
          defaultMessage: "Couldn't load your skills: {detail}",
        },
        { detail: rootError },
      );
    }
    return null;
  }, [error, queryError, rootError, intl]);
  const visible = useMemo(
    () =>
      allSkills.filter(
        (s) => matchesSearch(s, search) && matchesFilter(s, filter),
      ),
    [allSkills, search, filter],
  );

  function openEdit(skill: SkillEntry) {
    // The drawer owns the error face while open: a leftover pane error
    // (e.g. an earlier failed save) would otherwise replay inside an
    // unrelated edit drawer.
    setError(null);
    setDrawer({ mode: "edit", name: skill.name });
  }

  // The Edited derivation on builtin rows (issue #677): pure comparison of
  // the listing's whole-file hash against the side table's recorded hash --
  // an external editor's change reads as edited exactly like an in-app edit.
  // A builtin row with no record (config lag) reads as edited: the safer
  // display, and the restore reconciles it.
  function isEditedBuiltin(skill: SkillEntry): boolean {
    return (
      skill.acquired === "builtin" &&
      builtinSkillBaselines[skill.name]?.hash !== skill.content_hash
    );
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
        cliTools: [],
        body: "",
        acquired: "local",
        linkTarget: null,
      };
    }
    if (drawer.mode === "edit") {
      // The create result bridges the refetch gap after a create: once the
      // invalidated query lands, allSkills carries the entry and the
      // mutation result is never read again. The name guard keeps the
      // bridge scoped to the freshly minted skill only.
      const created = createMutation.data;
      const skill =
        allSkills.find((s) => s.name === drawer.name) ??
        (created?.name === drawer.name ? created : null);
      if (!skill) return null;
      return {
        currentName: skill.name,
        name: skill.name,
        description: skill.description,
        license: skill.license ?? "",
        compatibility: skill.compatibility ?? "",
        mcpServers: skill.mcp_servers,
        cliTools: skill.cli_tools,
        body: skill.body,
        acquired: skill.acquired,
        linkTarget: skill.link_target,
      };
    }
    return null;
  }, [drawer, allSkills, createMutation.data]);

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.skills" defaultMessage="Skills" />}
        description={(
          <FormattedMessage
            id="settings.skills.description"
            defaultMessage="Skills add capabilities to your agent. Create your own or import them from other apps."
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
              onClick={() => {
                setError(null);
                setImportOpen(true);
              }}
            >
              <Download className="size-4" aria-hidden />
              <FormattedMessage id="common.import" defaultMessage="Import" />
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
            defaultMessage="Filter by skill type"
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
                  : opt === "builtin"
                    ? intl.formatMessage({
                        id: "settings.skills.filterBuiltin",
                        defaultMessage: "System",
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
                defaultMessage="No skills yet. Click New to create one."
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
              edited={isEditedBuiltin(skill)}
              onOpen={() => openEdit(skill)}
              // A builtin skill is undeletable (issue #677): no delete entry
              // point renders -- disabling the companion CLI tool is the
              // single shutdown axis.
              onDelete={
                skill.acquired === "builtin"
                  ? undefined
                  : () => setConfirmDelete(skill.name)
              }
              // The restore shows only on an EDITED builtin row -- an
              // unedited row already agrees with the shipped baseline.
              onRestore={
                skill.acquired === "builtin" && isEditedBuiltin(skill)
                  ? () => setConfirmRestore(skill.name)
                  : undefined
              }
            />
          ))
        )}
      </SettingsCard>

      {/* While the drawer is open it OWNS the error face: the modal covers
          this line, and rendering the same text twice would read as a
          duplicated alert. The drawer renders `error` itself. */}
      {displayError && !drawerDraft && (
        <p className="settings-error mt-3 text-destructive text-sm">{displayError}</p>
      )}

      {ignoredDirs.length > 0 && <IgnoredDirectoriesSection skipped={ignoredDirs} />}

      {drawerDraft && (
        <SkillDrawer
          key={drawerDraft.currentName}
          draft={drawerDraft}
          mcpServerLabels={mcpServerLabels}
          configuredCliIds={configuredCliIds}
          saving={saving}
          error={error}
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
                  defaultMessage="Delete skill {name}?"
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
                  id="common.delete"
                  defaultMessage="Delete"
                />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {confirmRestore && (
        <AlertDialog
          defaultOpen
          onOpenChange={(open) => {
            if (!open && !restoreMutation.isPending) setConfirmRestore(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="settings.skills.confirmRestoreTitle"
                  defaultMessage="Restore built-in definition for {name}?"
                  values={{ name: confirmRestore }}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="settings.skills.confirmRestoreBody"
                  defaultMessage="This discards your edits to {name} and returns it to the definition shipped with the app. This cannot be undone."
                  values={{ name: confirmRestore }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={restoreMutation.isPending}>
                <FormattedMessage
                  id="common.cancel"
                  defaultMessage="Cancel"
                />
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={restoreMutation.isPending}
                onClick={(e) => {
                  // Prevent Radix AlertDialog auto-close so the busy state
                  // can render while the IPC runs (the CLI pane pattern).
                  e.preventDefault();
                  restoreMutation.mutate(confirmRestore);
                }}
              >
                <FormattedMessage
                  id="settings.skills.restoreAction"
                  defaultMessage="Restore"
                />
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}

      {importOpen && (
        <ImportSkillsDialog
          onClose={() => setImportOpen(false)}
        />
      )}
    </div>
  );
}

type SkillRowProps = {
  skill: SkillEntry;
  /** The Edited derivation (builtin rows only, issue #677). */
  edited: boolean;
  onOpen: () => void;
  /** Undefined on builtin rows: undeletable (issue #677). */
  onDelete?: () => void;
  /** Present only on an EDITED builtin row: the explicit restore (issue #677). */
  onRestore?: () => void;
};

function SkillRow({ skill, edited, onOpen, onDelete, onRestore }: SkillRowProps) {
  const intl = useIntl();
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
            ) : skill.acquired === "builtin" ? (
              <FormattedMessage
                id="settings.skills.acquiredBuiltin"
                defaultMessage="system"
              />
            ) : (
              <FormattedMessage
                id="settings.skills.acquiredLocal"
                defaultMessage="local"
              />
            )}
          </Badge>
          {edited && (
            <span className="bg-muted text-muted-foreground rounded-md px-2 py-0.5 text-xs font-medium leading-none">
              <FormattedMessage
                id="settings.skills.editedBadge"
                defaultMessage="Edited"
              />
            </span>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {skill.description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {onRestore && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label={intl.formatMessage(
              {
                id: "settings.skills.restoreLabel",
                defaultMessage: "Restore built-in definition for skill {name}",
              },
              { name: skill.name },
            )}
            onClick={(e) => {
              e.stopPropagation();
              onRestore();
            }}
          >
            <RotateCcw className="size-4" aria-hidden />
          </Button>
        )}
        {onDelete && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive shrink-0"
            aria-label={intl.formatMessage(
              {
                id: "settings.skills.deleteLabel",
                defaultMessage: "Delete skill {name}",
              },
              { name: skill.name },
            )}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

type SkillDrawerProps = {
  draft: DrawerDraft;
  mcpServerLabels: Record<string, string>;
  configuredCliIds: string[];
  saving: boolean;
  /** The pane's live error (the create / update reject, or a failed source
   *  reveal). Rendered INSIDE the dialog: the modal covers the section-level
   *  error line, so this is the only visible error face while the drawer is
   *  open. */
  error: string | null;
  onCancel: () => void;
  onCreate: (name: string, description: string) => void;
  onSave: (update: SkillUpdate) => void;
  onOpenSource: (target: string | null) => void;
};

function SkillDrawer({
  draft,
  mcpServerLabels,
  configuredCliIds,
  saving,
  error,
  onCancel,
  onCreate,
  onSave,
  onOpenSource,
}: SkillDrawerProps) {
  const isCreate = draft.currentName === "";
  const isLinked = draft.acquired === "linked";
  const isBuiltin = draft.acquired === "builtin";
  const readOnly = isLinked;
  // A builtin skill locks its name (issue #677): the identity the skill's
  // CLI reference and the auto-include pairing anchor on. Everything else
  // stays editable.
  const nameLocked = isBuiltin;
  // Local draft state so the user can type before committing. Reset when the
  // draft identity changes (switching skills / opening create).
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [license, setLicense] = useState(draft.license);
  const [compatibility, setCompatibility] = useState(draft.compatibility);
  const [mcpServers, setMcpServers] = useState<string[]>(draft.mcpServers);
  const [cliTools, setCliTools] = useState<string[]>(draft.cliTools);
  const [body, setBody] = useState(draft.body);
  // Touched flags gate the invalid hints: a freshly opened drawer stays
  // quiet (every field starts "invalid-able"), the hint appears once the
  // user has been in the field and left it.
  const [nameTouched, setNameTouched] = useState(false);
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [bodyTouched, setBodyTouched] = useState(false);
  // No effect syncs draft -> local state: the parent keys this drawer by the
  // skill name, so switching skills (or opening create) REMOUNTS it and the
  // useState initializers above re-seed from the new draft. Typing edits only
  // local state -- the key stays stable, no remount, no clobber (React 19
  // "reset state with a key" pattern, cf. react-hooks/set-state-in-effect).

  // Client-side mirror of the backend's spec validation (skills/model.rs):
  // gate Save here so the user gets immediate feedback instead of an IPC
  // round-trip reject. The backend stays the authority -- this only moves
  // the feedback earlier.
  const trimmedName = name.trim();
  const nameInvalid =
    !nameLocked &&
    (trimmedName === "" ||
      trimmedName.length > SKILL_NAME_MAX ||
      !SKILL_NAME_PATTERN.test(trimmedName));
  const descriptionInvalid = description.trim() === "";
  const bodyInvalid = !isCreate && body.trim() === "";
  const formInvalid = nameInvalid || descriptionInvalid || bodyInvalid;

  // The mcp multi-select lists every configured server plus any id the skill
  // already references that is no longer configured (so a stale reference
  // stays visible + removable rather than silently dropping).
  const mcpOptions = useMemo(() => {
    const merged = new Set<string>(Object.keys(mcpServerLabels));
    mcpServers.forEach((id) => merged.add(id));
    return [...merged];
  }, [mcpServerLabels, mcpServers]);

  // The cli multi-select mirrors the mcp one: every registered tool plus any
  // stale name the skill still references (issue #674).
  const cliOptions = useMemo(() => {
    const merged = new Set<string>(configuredCliIds);
    cliTools.forEach((name) => merged.add(name));
    return [...merged];
  }, [configuredCliIds, cliTools]);

  function toggleMcp(id: string) {
    setMcpServers((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function toggleCli(name: string) {
    setCliTools((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name],
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
      cli_tools: cliTools,
      body,
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Gate dismissal while saving (the ImportSkillsDialog pattern): a
        // mid-flight IPC keeps the drawer up so the busy state stays visible
        // and the draft cannot be abandoned halfway through a write.
        if (!open && !saving) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton
        onEscapeKeyDown={(e) => {
          if (saving) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (saving) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
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
        </DialogHeader>
        <DialogDescription className="sr-only">
          {isLinked ? (
            <FormattedMessage
              id="settings.skills.readOnlyHint"
              defaultMessage="This skill is linked to another folder and can't be edited here."
            />
          ) : (
            <FormattedMessage
              id="settings.skills.drawerDescription"
              defaultMessage="Change the skill's details."
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
              onBlur={() => setNameTouched(true)}
              disabled={readOnly || nameLocked}
              placeholder="pdf-tools"
              maxLength={SKILL_NAME_MAX}
            />
            <p
              className={cn(
                "text-xs",
                !nameLocked && nameTouched && nameInvalid
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {nameLocked ? (
                <FormattedMessage
                  id="settings.skills.fieldNameLockedHint"
                  defaultMessage="Built-in skill names are locked"
                />
              ) : nameTouched && nameInvalid ? (
                <FormattedMessage
                  id="settings.skills.fieldNameInvalid"
                  defaultMessage="Use only lowercase letters, numbers, and hyphens (example: pdf-tools), up to 64 characters."
                />
              ) : (
                <FormattedMessage
                  id="settings.skills.fieldNameHint"
                  defaultMessage="Use lowercase letters, numbers, and hyphens — for example: pdf-tools"
                />
              )}
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="skill-description">
              <FormattedMessage
                id="common.description"
                defaultMessage="Description"
              />
            </Label>
            <Textarea
              id="skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => setDescriptionTouched(true)}
              disabled={readOnly}
              maxLength={SKILL_DESCRIPTION_MAX}
              rows={3}
            />
            {descriptionTouched && descriptionInvalid && (
              <p className="text-destructive text-xs">
                <FormattedMessage
                  id="settings.skills.fieldDescriptionRequired"
                  defaultMessage="Description is required."
                />
              </p>
            )}
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
                        {/* The renamable display name is the row's face; the
                            bare id shows for a stale reference no longer
                            configured, and for a configured server whose
                            display_name loaded empty (a legal wire value
                            from a hand-edited config). */}
                        <span className="truncate">
                          {mcpServerLabels[id] || id}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-1.5">
                <span className="text-sm font-medium">
                  <FormattedMessage
                    id="settings.skills.fieldCliTools"
                    defaultMessage="CLI tool references"
                  />
                </span>
                {cliOptions.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    <FormattedMessage
                      id="settings.skills.fieldCliToolsEmpty"
                      defaultMessage="No CLI tools registered."
                    />
                  </p>
                ) : (
                  <div className="grid gap-1">
                    {cliOptions.map((name) => (
                      <label
                        key={name}
                        className="flex items-center gap-1.5 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={cliTools.includes(name)}
                          disabled={readOnly}
                          onChange={() => toggleCli(name)}
                        />
                        {name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="skill-body">
                  <FormattedMessage
                    id="settings.skills.fieldBody"
                    defaultMessage="Instructions"
                  />
                </Label>
                <Textarea
                  id="skill-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  onBlur={() => setBodyTouched(true)}
                  disabled={readOnly}
                  rows={10}
                  className="font-mono text-sm"
                />
                {bodyTouched && bodyInvalid && (
                  <p className="text-destructive text-xs">
                    <FormattedMessage
                      id="settings.skills.fieldBodyRequired"
                      defaultMessage="Instructions can't be empty."
                    />
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {isLinked && (
          <p className="text-muted-foreground text-xs">
            <FormattedMessage
              id="settings.skills.readOnlyHint"
              defaultMessage="This skill is linked to another folder and can't be edited here."
            />
          </p>
        )}

        {/* The in-drawer error face: while the modal is open it covers the
            section-level error line, so a create / update reject (or a
            failed source reveal) surfaces HERE -- right under the form the
            user just submitted, not behind the overlay. */}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
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
                defaultMessage="Open original folder"
              />
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          {!isLinked && (
            <Button type="button" onClick={handleSave} disabled={saving || formInvalid}>
              {saving ? (
                <FormattedMessage
                  id="common.saving"
                  defaultMessage="Saving…"
                />
              ) : (
                <FormattedMessage id="common.save" defaultMessage="Save" />
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type IgnoredDirectoriesSectionProps = {
  skipped: SkippedSkill[];
};

// Collapsible diagnostic fold for spec-invalid skill directories the scan
// skipped (issue #373). Rendered ONLY when the list is non-empty (a clean
// registry never shows it). Each row shows the directory name + the English
// technical reason verbatim -- the locale catalog owns the title / intro
// wording, NOT the per-row reason (ADR-0052 layer 4). The section does not
// participate in the search / filter / edit flows: it is read-only context.
// Native <details> / <summary> keeps it KISS (no extra state, keyboard +
// screen-reader accessible out of the box); the section is folded shut by
// default so the primary skills list stays the visual focus.
function IgnoredDirectoriesSection({ skipped }: IgnoredDirectoriesSectionProps) {
  return (
    <details
      data-testid="skills-ignored-details"
      className="border-border mt-3 rounded-lg border"
    >
      <summary className="hover:bg-accent flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium select-none">
        <span>
          <FormattedMessage
            id="settings.skills.ignoredTitle"
            defaultMessage="Ignored directories"
          />
        </span>
        <Badge variant="secondary" className="shrink-0">
          {skipped.length}
        </Badge>
      </summary>
      <div className="border-border border-t px-4 py-3">
        <p className="text-muted-foreground mb-2 text-xs">
          <FormattedMessage
            id="settings.skills.ignoredDescription"
            defaultMessage="These skill folders couldn't be loaded. Fix the folder or its SKILL.md file, then rescan."
          />
        </p>
        <ul className="grid gap-1.5">
          {skipped.map((entry) => (
            <li
              key={entry.dir}
              data-testid="ignored-skill-row"
              className="grid gap-0.5 text-xs"
            >
              <span className="font-mono font-medium">{entry.dir}</span>
              <span className="text-muted-foreground break-words">
                {entry.reason}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
