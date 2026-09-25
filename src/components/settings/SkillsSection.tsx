import { useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useQueryClient } from "@tanstack/react-query";
import { openPath } from "@tauri-apps/plugin-opener";
import { Download, Plus, RefreshCw } from "lucide-react";

import type { SkillEntry } from "../../types/skills";
import type { AppConfig } from "../../types/app-config";
import { rescanBuiltinCliTools } from "../../api";
import { IgnoredDirectoriesSection } from "./IgnoredDirectoriesSection";
import { ImportSkillsDialog } from "./ImportSkillsDialog";
import { SkillDetailDialog } from "./SkillDetailDialog";
import { SkillMaterializeFailureRow, SkillRow } from "./SkillRow";
import { fmtError } from "../../lib/error-presentation";
import { log } from "../../lib/log";
import { invalidateSkills, useSkillsRegistry } from "../../skills/registry";
import { useSkillsRoot } from "./useSkillsRoot";
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
import { Input } from "../ui/input";
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
  PaneHeader,
  SettingsCard,
} from "./settings-chrome";
import {
  FILTER_OPTIONS,
  matchesFilter,
  matchesSearch,
  searchableText,
  type EnabledFilter,
} from "./settings-filters";

// Skills settings pane (issue #362, ADR-0086; issue #1033, ADR-0122). The
// registry is a directory scan (no app-config entry), so this pane rides the
// one registry seam for its reads and writes: the listing query pair, the
// enablement / delete mutations, and the mount rescan's invalidation all
// come from src/skills/registry.ts (issue #1077). There is NO create / edit
// form: creation rides the model-face create_skill meta-tool -- the New
// button exits the settings overlay straight to the workspace where that
// conversation lives -- and edits happen in the external editor the detail
// dialog's SKILL.md link opens -- `local` anchors at its own directory,
// `linked` at its link target, `builtin` at the reserved-subtree copy. The
// Import header button opens the two-stage drill-down import dialog (issue
// #367), which links / copies skills from external agent libraries through
// the registry's import mutation.
//
// The pane's embedded species live in sibling files (issue #1083): the row
// family and its shared acquired label (SkillRow.tsx), the read-only
// detail dialog (SkillDetailDialog.tsx), and the skipped-fold diagnostic
// (IgnoredDirectoriesSection.tsx). The registry root's resolution, its
// fetch-generation guard, and the SKILL.md path join ride useSkillsRoot
// (useSkillsRoot.ts) -- this container keeps the retry orchestration (the
// open-click entry) and the failed-phase wording on the detail path face.

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
  // The client the rescan's late invalidate threads through the registry's
  // entry (stable for the provider's life, so the closure outlives the pane).
  const queryClient = useQueryClient();

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

  /** Report a mutation failure on the pane's error banner: the one shared
   *  face of the enablement / delete rejects (formatted once, here). */
  function reportMutationError(e: unknown) {
    setError(fmtError(e, intl));
  }

  // The pane's whole registry surface rides the one seam (issue #1077): the
  // listing read, the enablement / delete mutations, and (below) the mount
  // rescan's invalidation. The wholesale config sync is injected so a
  // successful enablement write lands through the write-generation-guarded
  // path (applyUserWrite above).
  const {
    listing,
    error: queryError,
    refetch,
    isFetching,
    setSkillEnabledMutation,
    deleteSkillMutation,
  } = useSkillsRegistry({ onAppConfigSync: applyUserWrite });

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
        invalidateSkills(queryClient);
      })
      .catch((e) => {
        // Silent in the UI on mount; the failure lane stays absent.
        log.warn("SkillsSection", "builtin-skill mount rescan failed", e);
      });
    return () => {
      cancelled = true;
    };
    // invalidateSkills threads the pane-lifetime client (its closure, like
    // the old invalidate closure, outlives this pane) and
    // `onAppConfigSync` is a stable pass-through from the settings view
    // (the same mount-once contract as the other settings panes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The registry root rides the skills-root seam (issue #1083): the mount
  // fetch, the fetch-generation guard, and the SKILL.md path join live in
  // the hook. This container keeps the retry orchestration (the open-click
  // entry in openDetail below) and the failed phase's wording (the detail
  // dialog's path face).
  const { root, detailFilePath, retry } = useSkillsRoot();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<EnabledFilter>("all");
  const [detailName, setDetailName] = useState<string | null>(null);
  // The detail dialog's own error line (the open-file failure face): the
  // section-level line is unreachable while the dialog is up (Radix marks
  // the outside tree aria-hidden), so this failure reports where the user
  // is. Cleared on the next open and the next attempt.
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The explicit builtin-skill restore (issue #677) retired with ADR-0121:
  // builtin skills are a read-only app cache that re-aligns on every scan,
  // so there is no edited state to restore -- the editable variant is a
  // filesystem copy of the reserved-subtree folder (the fork channel).

  // The enablement / delete mutations ride the registry seam (issue #1077):
  // the seam owns the IPC + the invalidation + the injected config sync,
  // while the per-call callbacks below carry this pane's UI state -- the
  // confirm-dialog close, the banner's stale-reject drop. The
  // enablement-axis row Switch (issue #961) keeps its contract: the command
  // returns the updated FULL config (synced wholesale, the set-contract) and
  // the listing refetches so each row's `enabled` follows.

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
  // while the model keeps resolving old bytes. Its enablement reads off the
  // stale row when one exists, defaulting to enabled when the failed write
  // left none (the default-on startup posture); a name failing the shared
  // enabled-axis filter or the search hides like any row.
  const failedNames = useMemo(
    () =>
      (materializeFailures ?? []).filter((name) => {
        const enabled =
          allSkills.find((s) => s.name === name)?.enabled ?? true;
        return matchesFilter({ enabled }, filter) && matchesSearch(name, search);
      }),
    [materializeFailures, allSkills, filter, search],
  );

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
    if (skill.acquired === "local" && root.phase !== "resolved") {
      retry();
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
  const detailFile = detail === null ? null : detailFilePath(detail);
  // The local-row face when the root fetch failed (issue #1039): the failed
  // resolution reports under the dialog's path link instead of leaving it
  // inert with no signal. Null on every other row and phase.
  const detailPathUnavailable =
    detail !== null &&
    detail.acquired === "local" &&
    detailFile === null &&
    root.phase === "failed"
      ? intl.formatMessage(
          {
            id: "settings.skills.pathUnavailable",
            defaultMessage:
              "Couldn't determine the skills folder path: {detail}",
          },
          { detail: root.error },
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
        <Label htmlFor="skills-enabled-filter" className="sr-only">
          <FormattedMessage
            id="settings.skills.filterLabel"
            defaultMessage="Filter by status"
          />
        </Label>
        <Select value={filter} onValueChange={(v) => setFilter(v as EnabledFilter)}>
          <SelectTrigger
            id="skills-enabled-filter"
            aria-label={intl.formatMessage({
              id: "settings.skills.filterLabel",
              defaultMessage: "Filter by status",
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
                ) : opt === "enabled" ? (
                  <FormattedMessage
                    id="settings.skills.filterEnabled"
                    defaultMessage="Enabled"
                  />
                ) : (
                  <FormattedMessage
                    id="settings.skills.filterDisabled"
                    defaultMessage="Disabled"
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
                setSkillEnabledMutation.isPending &&
                setSkillEnabledMutation.variables?.name === skill.name
              }
              onToggleEnabled={(enabled) =>
                setSkillEnabledMutation.mutate(
                  { name: skill.name, enabled },
                  {
                    // A success also drops a stale reject -- the banner must
                    // not outlive the failure it reported.
                    onSuccess: () => setError(null),
                    onError: reportMutationError,
                  },
                )}
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
                onClick={() =>
                  deleteSkillMutation.mutate(confirmDelete, {
                    onSuccess: () => setConfirmDelete(null),
                    onError: (e) => {
                      reportMutationError(e);
                      setConfirmDelete(null);
                    },
                  })}
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
