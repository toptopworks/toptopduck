import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  Download,
  Plus,
  Puzzle,
  RefreshCw,
  SquareArrowOutUpRight,
  Trash2,
  X,
} from "lucide-react";

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
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  DialogHeaderButton,
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
// rides the model-face create_skill meta-tool -- the New button exits the
// settings overlay straight to the workspace where that conversation lives --
// and edits happen in the external editor the detail dialog's SKILL.md link
// opens -- `local` anchors at its own directory, `linked` at
// its link target, `builtin` at the reserved-subtree copy. The Import header
// button opens the
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

// The row is list chrome (hover highlight + layout); the text block is the
// detail affordance (click / Enter opens the read-only dialog) and every
// write action lives in the row-end cluster -- never on the text block.
const ROW_CLASS = "hover:bg-accent flex items-center gap-3 px-4 py-3";

/** The registry root's resolution state: `failed` carries the formatted
 *  error the detail dialog's path face reports (issue #1039). */
type SkillsRoot =
  | { phase: "loading" }
  | { phase: "resolved"; root: string }
  | { phase: "failed"; error: string };

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

/** The acquired axis's locale label: the row badge and the detail dialog's
 *  scope value share the one vocabulary -- no second word for the same
 *  axis. */
function AcquiredLabel({ acquired }: { acquired: SkillAcquired }) {
  return acquired === "linked" ? (
    <FormattedMessage
      id="settings.skills.acquiredLinked"
      defaultMessage="linked"
    />
  ) : acquired === "builtin" ? (
    <FormattedMessage
      id="settings.skills.acquiredBuiltin"
      defaultMessage="system"
    />
  ) : (
    <FormattedMessage
      id="settings.skills.acquiredLocal"
      defaultMessage="local"
    />
  );
}

export function SkillsSection({
  onAppConfigSync,
  onNewSkill,
}: {
  /** Sync the shell's app-config wholesale after a write command (the
   *  command already persisted and returned the updated full config -- the
   *  same state-only-sync contract the CLI pane's writes use). */
  onAppConfigSync: (cfg: AppConfig) => void;
  /** The New button's create exit (#1033): the single busy-gated close path
   *  carrying the "new-skill" intent (see WorkspaceExitIntent). */
  onNewSkill: () => void;
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

  // The registry root for the local rows' open anchors (issue #1033): the
  // backend is the path authority (the get_agents_dir posture). Fetched on
  // mount and re-fetched by a local row's detail-open while unresolved
  // (issue #1039) -- the open click is the retry entry -- so a failed fetch
  // reports on that row's detail dialog (the path face) instead of leaving
  // the open link permanently inert. A re-fetch keeps the previous phase
  // until its response lands, and the fetch callbacks alone write the
  // state: a response landing after unmount is a silent React no-op, so
  // unlike the rescan above there is no cancelled guard to thread through
  // the shared fetcher (its callbacks carry no cross-pane cache write or
  // config sync).
  const [skillsRoot, setSkillsRoot] = useState<SkillsRoot>({
    phase: "loading",
  });

  // Each fetch bumps a generation so a late response from an older fetch
  // cannot overwrite a newer one (the PR #1041 review): with the mount
  // fetch and an open-click re-fetch both in flight, a stale rejection
  // landing after a newer resolve would flip the phase back to failed
  // mid-dialog. The writeGenRef posture above, at fetch scope -- the warn
  // still fires unconditionally so a stale failure stays diagnosable.
  const fetchGenRef = useRef(0);

  function fetchSkillsRoot() {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    getSkillsDir()
      .then((dir) => {
        if (fetchGenRef.current === gen) {
          setSkillsRoot({ phase: "resolved", root: dir });
        }
      })
      .catch((e) => {
        log.warn("SkillsSection", "get_skills_dir failed", e);
        if (fetchGenRef.current === gen) {
          setSkillsRoot({ phase: "failed", error: fmtError(e, intl) });
        }
      });
  }

  useEffect(() => {
    fetchSkillsRoot();
    // fetchSkillsRoot closes over the pane-lifetime intl (stable for the
    // provider's life); the mount-once contract matches the rescan effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AcquiredFilter>("all");
  const [detailName, setDetailName] = useState<string | null>(null);
  // The detail dialog's own error line (the open-file failure face): the
  // section-level line is unreachable while the dialog is up (Radix marks
  // the outside tree aria-hidden), so this failure reports where the user
  // is. Cleared on the next open and the next attempt.
  const [detailError, setDetailError] = useState<string | null>(null);
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

  /** The row's open anchor (issue #1033): a `local` row's own
   *  `<root>/<name>` directory; a `linked` row's link target and a `builtin`
   *  row's reserved-subtree copy (`link_target` carries both). Null when a
   *  local row is asked before the registry root has resolved, or when a
   *  linked row's link target is unreadable -- the open stays inert rather
   *  than synthesizing a garbage path. The root's own separator threads
   *  through the join, so a Windows root reads native backslashes. */
  function revealTarget(skill: SkillEntry): string | null {
    if (skill.acquired !== "local") return skill.link_target;
    if (skillsRoot.phase !== "resolved") return null;
    const sep = skillsRoot.root.includes("\\") ? "\\" : "/";
    return `${skillsRoot.root}${sep}${skill.name}`;
  }

  /** Open the row's read-only detail dialog (the row-click affordance):
   *  name + description + the SKILL.md path bar. Opening clears a stale
   *  pane error so the dialog never replays an unrelated reject under the
   *  overlay. */
  function openDetail(skill: SkillEntry) {
    setError(null);
    setDetailError(null);
    // A local row's path bar needs the registry root: while unresolved --
    // still loading or failed -- ask again now (issue #1039), making the
    // open click the retry entry after a failed fetch.
    if (skill.acquired === "local" && skillsRoot.phase !== "resolved") {
      fetchSkillsRoot();
    }
    setDetailName(skill.name);
  }

  /** Open the SKILL.md file in the OS default editor (issue #1033): the
   *  detail dialog's external-edit channel. The dialog stays open -- the
   *  open is fire-and-forget context, not a navigation away -- so a failure
   *  reports on the dialog's own error line (the section-level one is
   *  aria-hidden behind it). A null path (the registry root unresolved)
   *  stays inert. */
  async function openFile(path: string | null) {
    setDetailError(null);
    if (path === null) return;
    try {
      await openPath(path);
    } catch (e) {
      setDetailError(fmtError(e, intl));
    }
  }

  // A listing refetch that drops the open row unmounts the dialog (the
  // derived detail goes null); clearing the stale name keeps a same-named
  // skill from spontaneously reopening the dialog when it re-enters the
  // registry (issue #1039). The render-phase reset -- the documented
  // "adjusting state when a prop changes" pattern, applied to a memoized
  // derivation here rather than a prop -- keeps the derived detail and its
  // name in lockstep without an effect.
  const [prevSkills, setPrevSkills] = useState(allSkills);
  if (prevSkills !== allSkills) {
    setPrevSkills(allSkills);
    if (detailName !== null && !allSkills.some((s) => s.name === detailName)) {
      setDetailName(null);
    }
  }

  const detail =
    detailName === null
      ? null
      : (allSkills.find((s) => s.name === detailName) ?? null);
  // The path bar anchors at the SKILL.md file: the bar opens it in the
  // OS default editor, one click from the bytes. Null (a local row asked
  // before the registry root resolved) keeps the button inert.
  const detailFile = skillFilePath(detail === null ? null : revealTarget(detail));
  // The local-row face when the root fetch failed (issue #1039): the failed
  // resolution reports under the dialog's path link instead of leaving it
  // inert with no signal. Null on every other row and phase.
  const detailPathUnavailable =
    detail !== null &&
    detail.acquired === "local" &&
    detailFile === null &&
    skillsRoot.phase === "failed"
      ? intl.formatMessage(
          {
            id: "settings.skills.pathUnavailable",
            defaultMessage:
              "Couldn't determine the skills folder path: {detail}",
          },
          { detail: skillsRoot.error },
        )
      : null;

  return (
    <div>
      <PaneHeader
        title={<FormattedMessage id="settings.nav.skills" defaultMessage="Skills" />}
        description={(
          <FormattedMessage
            id="settings.skills.description"
            defaultMessage="Skills add capabilities to your agent. Create them in a chat or import them from other apps."
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
              // No interposing dialog: the New click exits through the
              // single close path (#1033), carrying the create intent
              // (#1040 -- see WorkspaceExitIntent).
              onClick={onNewSkill}
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
              onOpen={() => openDetail(skill)}
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

      {detail && (
        <SkillDetailDialog
          skill={detail}
          file={detailFile}
          pathUnavailable={detailPathUnavailable}
          error={detailError}
          onClose={() => setDetailName(null)}
          onOpenFile={() => void openFile(detailFile)}
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
  /** Open the row's read-only detail dialog (name + description + the
   *  SKILL.md path bar). */
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
      {/* The detail target is the text block alone (the retired edit
          drawer's old posture, now opening a read-only face): the row's
          clickable area stops before the action cluster. */}
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
            <AcquiredLabel acquired={skill.acquired} />
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
        {/* The row-end delete renders in every state (disabled on builtin,
            issue #677) so the switch column never shifts across rows. The
            external-edit channel lives in the detail dialog's SKILL.md path
            bar (issue #1033) -- the row itself stays management-only. */}
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

/** The SKILL.md path from an open anchor directory (null passes through
 *  so the caller renders an inert link): joined with the anchor's own
 *  separator so a Windows root reads native backslashes. */
function skillFilePath(target: string | null): string | null {
  if (target === null) return null;
  return target.includes("\\") ? `${target}\\SKILL.md` : `${target}/SKILL.md`;
}

/** The row's read-only detail dialog (issue #1033's row-click face): the
 *  name header, the description / scope / status metadata, and the SKILL.md
 *  path bar. There is no form here -- creation rides the conversation
 *  channel and edits happen in the external editor the path link opens, so
 *  this dialog only SHOWS the skill and points at where it lives. */
type SkillDetailDialogProps = {
  skill: SkillEntry;
  /** The absolute SKILL.md path the path bar links; null before a local
   *  row's registry root resolved, or when a linked row's link target is
   *  unreadable (the link then stays disabled). */
  file: string | null;
  /** The local-row face when the registry root failed to resolve (issue
   *  #1039); null on every other row and phase. */
  pathUnavailable: string | null;
  /** The open-file failure's dialog-level face (null = no error shown). */
  error: string | null;
  onClose: () => void;
  /** Open the SKILL.md file in the OS default editor. */
  onOpenFile: () => void;
};

function SkillDetailDialog({
  skill,
  file,
  pathUnavailable,
  error,
  onClose,
  onOpenFile,
}: SkillDetailDialogProps) {
  const intl = useIntl();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      {/* The default header X is the sole dismissal chrome; ESC and the
          overlay click still close via Radix. */}
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          {/* The close chrome matches the sibling import dialog: the
              DialogHeaderButton ghost in the header row, not the floating
              corner X (the #964 dialog-action posture). */}
          <div className="flex items-center justify-between gap-2">
            <DialogTitle>{skill.name}</DialogTitle>
            <DialogHeaderButton
              label={intl.formatMessage({
                id: "common.close",
                defaultMessage: "Close",
              })}
              icon={X}
              onClick={onClose}
            />
          </div>
        </DialogHeader>
        <div className="grid gap-5">
          <div className="grid gap-1.5">
            <p className="text-foreground text-sm">
              <FormattedMessage
                id="common.description"
                defaultMessage="Description"
              />
            </p>
            <DialogDescription className="text-sm leading-relaxed">
              {skill.description}
            </DialogDescription>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <p className="text-foreground text-sm">
                <FormattedMessage
                  id="settings.skills.sourceLabel"
                  defaultMessage="Source"
                />
              </p>
              <p className="text-muted-foreground text-sm">
                <AcquiredLabel acquired={skill.acquired} />
              </p>
            </div>
            <div className="grid gap-1.5">
              <p className="text-foreground text-sm">
                <FormattedMessage
                  id="settings.skills.statusLabel"
                  defaultMessage="Status"
                />
              </p>
              <p className="text-muted-foreground text-sm">
                {skill.enabled ? (
                  <FormattedMessage
                    id="settings.skills.statusEnabled"
                    defaultMessage="Enabled"
                  />
                ) : (
                  <FormattedMessage
                    id="settings.skills.statusDisabled"
                    defaultMessage="Disabled"
                  />
                )}
              </p>
            </div>
          </div>
          <div className="grid gap-1.5">
            <p className="text-foreground text-sm">
              <FormattedMessage
                id="settings.skills.pathLabel"
                defaultMessage="File path"
              />
            </p>
            {/* The path is the open-file link (the direct-edit channel):
                hover underlines it, click opens SKILL.md in the OS default
                editor; the glyph rides inline as the affordance. */}
            <button
              type="button"
              onClick={onOpenFile}
              disabled={!file}
              aria-label={intl.formatMessage(
                {
                  id: "settings.skills.openFile",
                  defaultMessage: "Open file {path}",
                },
                { path: file ?? "" },
              )}
              className="text-muted-foreground hover:text-foreground w-fit max-w-full text-left font-mono text-xs underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
            >
              <span className="break-all">{file}</span>
              <SquareArrowOutUpRight
                className="ml-1.5 inline-block size-3.5 align-text-bottom"
                aria-hidden
              />
            </button>
            {/* One error line for the path area's two failure faces,
                mutually exclusive: the failed root fetch (issue #1039)
                shows only while the link above is inert, the open failure
                only after a click on a resolved link. */}
            {(pathUnavailable ?? error) && (
              <p className="text-destructive text-xs" role="alert">
                {pathUnavailable ?? error}
              </p>
            )}
          </div>
        </div>
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
