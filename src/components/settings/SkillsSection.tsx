import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Download, FolderOpen, Plus, Puzzle, RefreshCw, Trash2 } from "lucide-react";

import type {
  SkillAcquired,
  SkillEntry,
  SkippedSkill,
} from "../../types/skills";
import type { AppConfig } from "../../types/app-config";
import {
  deleteSkill,
  getSkillsDir,
  listSkills,
  rescanBuiltinCliTools,
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
import {
  HeaderActionButton,
  NameBadge,
  RowActionButton,
  PaneHeader,
  SettingsCard,
} from "./settings-chrome";
import { matchesSearch, searchableText } from "./settings-filters";

// Skills settings pane (issue #362, ADR-0086; issue #1033, ADR-0122). The
// registry is a directory scan (no app-config entry), so this pane reads
// list_skills + drives enablement / delete through TanStack mutations that
// invalidate the one skills query. There is NO create / edit form: creation
// rides the model-face create_skill meta-tool (the New button's guide dialog
// points there) and edits happen in the external editor each row's reveal
// opens -- `local` reveals its own directory, `linked` its link target,
// `builtin` the reserved-subtree copy. The Import header button opens the
// two-stage drill-down import dialog (issue #367), which links / copies
// skills from external agent libraries and invalidates the same skills query
// on success.

type AcquiredFilter = "all" | SkillAcquired;

const FILTER_OPTIONS: ReadonlyArray<AcquiredFilter> = [
  "all",
  "linked",
  "local",
  "builtin",
];

// The row is list chrome (hover highlight + layout); every action lives in
// the row-end cluster (reveal / delete), never on the text block.
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
  onExitToWorkspace,
}: {
  /** Sync the shell's app-config wholesale after a write command (the
   *  command already persisted and returned the updated full config -- the
   *  same state-only-sync contract the CLI pane's writes use). */
  onAppConfigSync: (cfg: AppConfig) => void;
  /** Close the settings overlay back to the workspace (the create-guide
   *  dialog's action, issue #1033): the SettingsView's single close path
   *  (busy-gated), so the guide's exit honors the same contract as the
   *  rail's "Back to workspace". */
  onExitToWorkspace: () => void;
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

  // The registry root for the local rows' reveal targets (issue #1033): the
  // backend is the path authority (the get_agents_dir posture), fetched once
  // per mount. A fetch failure leaves the local reveals inert (log-only) --
  // the pane stays usable.
  const [skillsRoot, setSkillsRoot] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSkillsDir()
      .then((dir) => {
        if (!cancelled) setSkillsRoot(dir);
      })
      .catch((e) => {
        log.warn("SkillsSection", "get_skills_dir failed", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AcquiredFilter>("all");
  const [createGuideOpen, setCreateGuideOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  // a stale reject -- the banner must not outlive the failure it reported.
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

  /** The row's reveal target (issue #1033): a `local` row's own
   *  `<root>/<name>` directory; a `linked` row's link target and a `builtin`
   *  row's reserved-subtree copy (`link_target` carries both). Null when a
   *  local row is asked before the registry root has resolved -- the reveal
   *  stays inert rather than synthesizing a garbage path. */
  function revealTarget(skill: SkillEntry): string | null {
    if (skill.acquired !== "local") return skill.link_target;
    return skillsRoot === null ? null : `${skillsRoot}/${skill.name}`;
  }

  /** Reveal one skill's directory in the OS file manager (issue #1033): the
   *  external-edit channel. A failure lands on the section-level error line
   *  -- with the drawer gone there is no modal to own it. */
  async function revealSkill(skill: SkillEntry) {
    const target = revealTarget(skill);
    if (!target) return;
    try {
      await revealItemInDir(target);
    } catch (e) {
      setError(fmtError(e, intl));
    }
  }

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
                setCreateGuideOpen(true);
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
                defaultMessage="No skills yet. Create one in a chat, or import it."
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
              onReveal={() => void revealSkill(skill)}
              revealTarget={revealTarget(skill)}
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

      {displayError && (
        <p className="settings-error mt-3 text-destructive text-sm" role="alert">
          {displayError}
        </p>
      )}

      {ignoredDirs.length > 0 && <IgnoredDirectoriesSection skipped={ignoredDirs} />}

      {createGuideOpen && (
        <CreateGuideDialog
          onCancel={() => setCreateGuideOpen(false)}
          onExit={() => {
            setCreateGuideOpen(false);
            onExitToWorkspace();
          }}
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
  /** Reveal the skill's directory in the OS file manager (issue #1033):
   *  the external-edit channel. */
  onReveal: () => void;
  /** The absolute path the reveal opens, shown as the button's hover
   *  tooltip (null only before a local row's registry root resolved). */
  revealTarget: string | null;
  /** Undefined on builtin rows (issue #677): the delete button then renders
   *  disabled, keeping every row's action column aligned. */
  onDelete?: () => void;
};

function SkillRow({
  skill,
  busy = false,
  onToggleEnabled,
  onReveal,
  revealTarget,
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
      {/* Plain text: with the edit drawer retired there is no open-edit
          affordance -- the row's actions all live in the action cluster. */}
      <div className="min-w-0 flex-1">
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
        {/* The reveal (issue #1033): the external-edit channel -- open the
            skill's directory in the OS file manager and edit SKILL.md (or
            the bundled assets) there; the next scan / new-session seed
            re-discovers the change. */}
        <RowActionButton
          label={intl.formatMessage(
            {
              id: "settings.skills.openFolderLabel",
              defaultMessage: "Open skill folder {name}",
            },
            { name: skill.name },
          )}
          icon={FolderOpen}
          onClick={onReveal}
          // The build item's "shows the skill directory path" clause: the
          // hover carries the absolute path the click reveals (the #1015
          // real-touchpoint posture), absent only on a local row asked
          // before the registry root resolved.
          tooltip={revealTarget ?? undefined}
        />
        {/* The row-end cluster renders the same two buttons in every state
            (the reveal + the delete -- disabled on builtin, issue #677), so
            the switch column never shifts across rows. */}
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

/** The create-guide dialog (issue #1033): the New button's landing. With the
 *  create drawer retired there is no in-app authoring form -- creation rides
 *  the model-face create_skill meta-tool, so the guide explains the
 *  conversation channel and offers the exit to the workspace where it lives.
 *  Pre-filling a teaching-skill mention in the composer is left to a later
 *  pass (the issue's implementation-period note). */
type CreateGuideDialogProps = {
  onCancel: () => void;
  onExit: () => void;
};

function CreateGuideDialog({ onCancel, onExit }: CreateGuideDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent className="sm:max-w-md" showCloseButton>
        <DialogHeader>
          <DialogTitle>
            <FormattedMessage
              id="settings.skills.createGuideTitle"
              defaultMessage="Create skills in chat"
            />
          </DialogTitle>
          <DialogDescription>
            <FormattedMessage
              id="settings.skills.createGuideBody"
              defaultMessage={
                "Skills are created through a conversation with your agent. Go back to the " +
                "workspace and ask it to create a skill for you -- the built-in skill-creator " +
                "skill knows the format."
              }
            />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </Button>
          <Button type="button" onClick={onExit}>
            <FormattedMessage
              id="settings.skills.createGuideAction"
              defaultMessage="Back to workspace"
            />
          </Button>
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
