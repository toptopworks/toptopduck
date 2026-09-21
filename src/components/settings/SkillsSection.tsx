import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";

import type {
  SkillAcquired,
  SkillCreate,
  SkillEntry,
  SkillUpdate,
  SkippedSkill,
} from "../../types/skills";
import type { AppConfig } from "../../types/app-config";
import {
  createSkill,
  deleteSkill,
  listSkills,
  rescanBuiltinCliTools,
  updateSkill,
  setSkillEnabled,
} from "../../api";
import { ImportSkillsDialog } from "./ImportSkillsDialog";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { skillKeys } from "../../session/queryKeys";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  HeaderActionButton,
  NameBadge,
  RowActionButton,
  PaneHeader,
  SettingsCard,
} from "./settings-chrome";
import { matchesSearch, searchableText } from "./settings-filters";

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
  // No edit surface in the drawer: carried as-is and passed back on save so
  // an existing frontmatter key survives an unrelated edit (null = absent).
  license: string | null;
  compatibility: string | null;
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

// The row is list chrome (hover highlight + layout); the open-edit
// affordance is scoped to the row's text block -- never the action cluster.
const ROW_CLASS = "hover:bg-accent flex items-center gap-3 px-4 py-3";

/** One filter-axis half shared by the rows and the failure lane: "all"
 *  passes everything; otherwise the value must match the axis. The lane
 *  calls it with the literal "builtin" -- a failed skill never landed on
 *  disk, so it has no acquired value to compare; the literal is its
 *  declared stand-in. */
function matchesAcquired(filter: AcquiredFilter, acquired: SkillAcquired): boolean {
  return filter === "all" || filter === acquired;
}

function matchesFilter(skill: SkillEntry, filter: AcquiredFilter): boolean {
  return matchesAcquired(filter, skill.acquired);
}

export function SkillsSection({
  onAppConfigSync,
}: {
  /** Sync the shell's app-config wholesale after a write command (the
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

  // The materialization-failure lane (issue #1016): the names of the
  // builtin skills the scan window could not write, refreshed by the same
  // mount rescan the CLI pane rides. Null = no scan answer (mount rescan
  // failed): no lane renders, the CLI pane's null-scan posture.
  const [materializeFailures, setMaterializeFailures] = useState<
    string[] | null
  >(null);

  // The write-generation guard (the CliSection #683 contract): advances
  // with every APPLIED user write, so a mount-rescan response arriving
  // after a user write landed skips its config sync instead of rolling
  // the write back.
  const writeGenRef = useRef(0);

  /** Apply a user write's returned config: the sync advances the write
   *  generation, so a mount rescan still in flight skips its (stale)
   *  config sync. */
  function applyUserWrite(next: AppConfig) {
    writeGenRef.current += 1;
    onAppConfigSync(next);
  }

  /** One cache-scope invalidate of the skills keys (the listing plus
   *  every observer on the family -- the picker and rail ride the same
   *  keys): fire-and-forget, used by the mount rescan and the writes. */
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: skillKeys.all() });
  };

  /** Opening the pane refreshes the materialization snapshot (issue
   *  #1016): the same one read-modify-write IPC the CLI pane rides on
   *  mount. A success in this window can materialize missing skills, so
   *  the config syncs (guarded) and the listing refetches to show the
   *  fresh rows, while the failures render as the warning lane below the
   *  toolbar. A mount failure leaves no visible UI state -- it lands one
   *  log.warn so a persistently failing scan is diagnosable (the CLI
   *  pane's silent-mount contract). */
  useEffect(() => {
    let cancelled = false;
    const gen = writeGenRef.current;
    rescanBuiltinCliTools()
      .then((result) => {
        if (!cancelled) {
          setMaterializeFailures(result.skill_materialize_failures);
          if (writeGenRef.current === gen) onAppConfigSync(result.config);
        }
        // The scan may have materialized a skill in this window: the
        // listing refetches so the new row appears beside the lane that
        // would have warned about its absence. Cache-scoped and
        // unmount-safe, so it runs even when the pane closed mid-flight
        // (the picker / rail observers outlive this pane and need the
        // refreshed cache).
        invalidate();
      })
      .catch((e) => {
        // Silent in the UI on mount; the failure lane stays absent.
        log.warn("SkillsSection", "builtin-skill mount rescan failed", e);
      });
    return () => {
      cancelled = true;
    };
    // `invalidate` closes over the pane-lifetime `queryClient` (stable
    // for the provider's life) and `onAppConfigSync` is a stable
    // pass-through from the settings view (the same mount-once contract
    // as the other settings panes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AcquiredFilter>("all");
  const [drawer, setDrawer] = useState<DrawerState>({ mode: "closed" });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (draft: SkillCreate) =>
      createSkill(draft.name, draft.description, draft.body),
    onSuccess: () => {
      invalidate();
      // Drop a stale reject so a reopened drawer never seeds off an
      // outdated error.
      setError(null);
      // One-form create: the body was authored in the drawer itself, so a
      // successful mint closes it -- there is no follow-up edit step.
      setDrawer({ mode: "closed" });
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

  // The explicit builtin-skill restore (issue #677) retired with ADR-0121:
  // builtin skills are a read-only app cache that re-aligns on every scan,
  // so there is no edited state to restore -- the editable variant is a
  // filesystem copy of the reserved-subtree folder (the fork channel).

  // The enablement-axis row Switch (issue #961): the command returns the
  // updated FULL config (synced wholesale, the set-contract) and the
  // listing refetches so each row's `enabled` follows. A success also drops
  // a stale reject (the create/update precedent) -- the banner must not
  // outlive the failure it reported.
  const toggleEnabledMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setSkillEnabled(name, enabled),
    onSuccess: (cfg) => {
      setError(null);
      applyUserWrite(cfg);
      invalidate();
    },
    onError: (e) => setError(fmtError(e, intl)),
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
        (s) =>
          matchesSearch(searchableText(s.name, s.description), search) &&
          matchesFilter(s, filter),
      ),
    [allSkills, search, filter],
  );

  // The materialization lane's visible rows (issue #1016): a failed write
  // leaves the row on disk stale or absent, so the stand-in ALWAYS renders
  // beside any real row -- the write really did fail, and hiding the hint
  // (e.g. behind a stale pre-upgrade row) would report a healthy skill
  // while the model keeps resolving old bytes. Visible under the "all"
  // and "builtin" filters and matched by name (regular rows also match
  // their description; the lane shows no description to match).
  const failedNames = useMemo(
    () =>
      (materializeFailures ?? []).filter(
        (name) =>
          matchesAcquired(filter, "builtin") && matchesSearch(name, search),
      ),
    [materializeFailures, filter, search],
  );

  function openEdit(skill: SkillEntry) {
    // The drawer owns the error face while open: a leftover pane error
    // (e.g. an earlier failed save) would otherwise replay inside an
    // unrelated edit drawer.
    setError(null);
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
        license: null,
        compatibility: null,
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
        license: skill.license,
        compatibility: skill.compatibility,
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
            defaultMessage="Skills add capabilities to your agent. Create your own or import them from other apps."
          />
        )}
        action={(
          <div className="flex items-center gap-1.5">
            <HeaderActionButton
              label={intl.formatMessage({
                id: "settings.skills.new",
                defaultMessage: "New",
              })}
              icon={Plus}
              onClick={() => {
                setError(null);
                setDrawer({ mode: "create" });
              }}
            />
            <HeaderActionButton
              label={intl.formatMessage({
                id: "common.import",
                defaultMessage: "Import",
              })}
              icon={Download}
              onClick={() => {
                setError(null);
                setImportOpen(true);
              }}
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
        <Select value={filter} onValueChange={(v) => setFilter(v as AcquiredFilter)}>
          <SelectTrigger
            id="skills-acquired-filter"
            aria-label={intl.formatMessage({
              id: "settings.skills.filterLabel",
              defaultMessage: "Filter by skill type",
            })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt === "all" ? (
                  <FormattedMessage
                    id="settings.skills.filterAll"
                    defaultMessage="All"
                  />
                ) : opt === "linked" ? (
                  <FormattedMessage
                    id="settings.skills.filterLinked"
                    defaultMessage="Linked"
                  />
                ) : opt === "local" ? (
                  <FormattedMessage
                    id="settings.skills.filterLocal"
                    defaultMessage="Local"
                  />
                ) : (
                  <FormattedMessage
                    id="settings.skills.filterBuiltin"
                    defaultMessage="System"
                  />
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SettingsCard>
        {/* The lane rides above the listing; when a lane row matches the
         * search / filter, it carries the frame alone -- an empty-state
         * caption under a matching row would contradict the row right
         * above it. */}
        {failedNames.map((name) => (
          <SkillMaterializeFailureRow key={name} name={name} />
        ))}
        {visible.length === 0 && failedNames.length === 0 ? (
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
              // Per-row gate (the AgentsSection #932 precedent): only the
              // row whose toggle is in flight locks its switch.
              busy={
                toggleEnabledMutation.isPending &&
                toggleEnabledMutation.variables?.name === skill.name
              }
              onToggleEnabled={(enabled) =>
                toggleEnabledMutation.mutate({ name: skill.name, enabled })}
              onOpen={() => openEdit(skill)}
              // A builtin skill is undeletable (issue #677): its delete
              // button renders disabled -- the shutdown axis is the
              // enablement axis: disable the skill, or for a CLI companion
              // its CLI entry.
              onDelete={
                skill.acquired === "builtin"
                  ? undefined
                  : () => setConfirmDelete(skill.name)
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
          saving={saving}
          error={error}
          onCancel={() => setDrawer({ mode: "closed" })}
          onCreate={(draft) => createMutation.mutate(draft)}
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
  /** The enablement switch is mid-flight on this row: gate this row's
   *  switch (the per-row gate, the AgentsSection #932 precedent). */
  busy?: boolean;
  /** Flip the row's enablement axis (issue #961). */
  onToggleEnabled: (enabled: boolean) => void;
  onOpen: () => void;
  /** Undefined on builtin rows (issue #677): the delete button then renders
   *  disabled, keeping every row's action column aligned. */
  onDelete?: () => void;
};

function SkillRow({
  skill,
  busy = false,
  onToggleEnabled,
  onOpen,
  onDelete,
}: SkillRowProps) {
  const intl = useIntl();
  return (
    <div
      data-testid="skill-row"
      // Dormant-on-disable gray-out (issue #961): the whole row reads
      // faded, switch and actions dimmed with it (management stays
      // operable -- disabling hides from discovery, not from management)
      // and carries data-disabled as the test/styling hook.
      className={`${ROW_CLASS} ${skill.enabled ? "" : "opacity-60"}`}
      data-disabled={skill.enabled ? undefined : "true"}
    >
      <Puzzle className="text-muted-foreground size-4 shrink-0" aria-hidden />
      {/* The open-edit target is the text block alone: the row's clickable
          area stops before the action cluster instead of spanning the whole
          row. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="min-w-0 flex-1 cursor-pointer outline-none focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          <NameBadge>
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
          </NameBadge>
          {skill.covers_builtin && (
            <NameBadge>
              <FormattedMessage
                id="settings.skills.coversBuiltin"
                defaultMessage="covers built-in"
              />
            </NameBadge>
          )}
        </div>
        <p className="text-muted-foreground truncate text-xs">
          {skill.description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Switch
          className="mr-1.5"
          checked={skill.enabled}
          disabled={busy}
          onCheckedChange={onToggleEnabled}
          aria-label={intl.formatMessage(
            {
              id: "settings.skills.enabledLabel",
              defaultMessage: "Enable skill {name}",
            },
            { name: skill.name },
          )}
        />
        {/* The row-end slot is exactly ONE button wide in every state (the
            delete -- disabled on builtin, issue #677) -- so the switch
            column never shifts across rows. Clicks are the action cluster's
            business (see the container above), never the row's. */}
        <RowActionButton
          destructive
          disabled={!onDelete}
          label={intl.formatMessage(
            {
              id: "settings.skills.deleteLabel",
              defaultMessage: "Delete skill {name}",
            },
            { name: skill.name },
          )}
          icon={Trash2}
          onClick={onDelete}
          // The shutdown guidance at the real touchpoint (#1015): the
          // disabled delete explains itself instead of dead-ending --
          // the reachable off-action is the enablement-axis switch on
          // this row (ADR-0118), true for every builtin (knowledge-only
          // skills like vega-chart have no companion CLI to point at).
          tooltip={
            skill.acquired === "builtin"
              ? intl.formatMessage({
                  id: "settings.skills.deleteDisabledHint",
                  defaultMessage:
                    "System skills cannot be deleted; disable the skill instead",
                })
              : undefined
          }
        />
      </div>
    </div>
  );
}

type SkillDrawerProps = {
  draft: DrawerDraft;
  saving: boolean;
  /** The pane's live error (the create / update reject, or a failed source
   *  reveal). Rendered INSIDE the dialog: the modal covers the section-level
   *  error line, so this is the only visible error face while the drawer is
   *  open. */
  error: string | null;
  onCancel: () => void;
  onCreate: (draft: SkillCreate) => void;
  onSave: (update: SkillUpdate) => void;
  onOpenSource: (target: string | null) => void;
};

function SkillDrawer({
  draft,
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
  // Read-only postures: a linked skill (the app never writes through an
  // external link) and a builtin skill (ADR-0121: the reserved-subtree
  // files are an app cache that re-aligns on the next scan -- the editable
  // variant is a filesystem copy of the folder, never an in-app edit).
  const readOnly = isLinked || isBuiltin;
  // The read-only hint sentence, shared by the sr-only dialog description
  // and the visible paragraph under the form -- rendered twice by design so
  // the a11y description and the visual hint agree.
  const readOnlyHint = isLinked ? (
    <FormattedMessage
      id="settings.skills.readOnlyHint"
      defaultMessage="This skill is linked to another folder and can't be edited here."
    />
  ) : (
    <FormattedMessage
      id="settings.skills.builtinReadOnlyHint"
      defaultMessage="This skill ships with the app and is read-only; copy its folder to the skills root to keep your own version."
    />
  );
  // Local draft state so the user can type before committing. Reset when the
  // draft identity changes (switching skills / opening create).
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [body, setBody] = useState(draft.body);
  // Touched flags gate the invalid hints: a freshly opened drawer stays
  // quiet (every field starts "invalid-able"), and blur flags a field only
  // when its value drifted from the draft seed -- the dialog auto-focuses
  // the name input, so pristine click-away blurs are routine and must not
  // yell.
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
    trimmedName === "" ||
    trimmedName.length > SKILL_NAME_MAX ||
    !SKILL_NAME_PATTERN.test(trimmedName);
  const descriptionInvalid = description.trim() === "";
  const bodyInvalid = body.trim() === "";
  const formInvalid = nameInvalid || descriptionInvalid || bodyInvalid;

  function handleSave() {
    if (isCreate) {
      onCreate({ name: name.trim(), description: description.trim(), body });
      return;
    }
    onSave({
      name: name.trim(),
      description: description.trim(),
      // The passthrough pair: no edit surface, so the draft's original values
      // ride back untouched (an unrelated edit must not drop a frontmatter
      // license/compatibility key -- null is the wire's "remove" signal).
      license: draft.license,
      compatibility: draft.compatibility,
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
          {readOnly ? (
            readOnlyHint
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
              onBlur={() => {
                if (name !== draft.name) setNameTouched(true);
              }}
              disabled={readOnly}
              placeholder="pdf-tools"
              maxLength={SKILL_NAME_MAX}
            />
            {nameTouched && nameInvalid ? (
              <p className="text-destructive text-xs">
                <FormattedMessage
                  id="settings.skills.fieldNameInvalid"
                  defaultMessage="Use only lowercase letters, numbers, and hyphens (example: pdf-tools), up to 64 characters."
                />
              </p>
            ) : null}
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
              onBlur={() => {
                if (description !== draft.description) setDescriptionTouched(true);
              }}
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
              onBlur={() => {
                if (body !== draft.body) setBodyTouched(true);
              }}
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
        </div>

        {readOnly && (
          <p className="text-muted-foreground text-xs">{readOnlyHint}</p>
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
          {readOnly && (
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenSource(draft.linkTarget)}
              disabled={!draft.linkTarget}
            >
              {isLinked ? (
                <FormattedMessage
                  id="settings.skills.openSource"
                  defaultMessage="Open original folder"
                />
              ) : (
                <FormattedMessage
                  id="settings.skills.openBuiltinFolder"
                  defaultMessage="Open folder"
                />
              )}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          {!readOnly && (
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
        <NameBadge>
          {skipped.length}
        </NameBadge>
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

/** One materialization-failure row (issue #1016): the CLI pane's
 * conflict-row shape (issue #675) carried over as the skills pane's
 * warning lane -- the #937 agents-pane precedent for surfacing
 * materialization failures. The skill never landed on disk, so the
 * listing has no row for it -- this one stands in with the failure
 * category and the self-heal hint. No open/edit affordance: there is
 * nothing on disk to edit. */
function SkillMaterializeFailureRow({ name }: { name: string }) {
  return (
    <div
      data-testid={`skill-materialize-failure-row-${name}`}
      className={ROW_CLASS}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{name}</div>
        <p className="text-destructive mt-1 text-xs">
          <FormattedMessage
            id="settings.skills.materializeFailureHint"
            defaultMessage="Couldn't write this built-in skill to disk. Check that the skills folder is writable and has disk space; the next scan retries."
          />
        </p>
      </div>
      {/* The DESIGN.md badge token (the CLI conflict row's shape):
       * typography.badge on rounded.md, the destructive coloring marking
       * the failed write. */}
      <span className="bg-muted text-destructive shrink-0 rounded-md px-2 py-0.5 text-xs font-medium leading-none">
        <FormattedMessage
          id="settings.skills.materializeFailureBadge"
          defaultMessage="Write failed"
        />
      </span>
    </div>
  );
}
