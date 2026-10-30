// The sidebar's workspace section (issue #1392): the registry's `explicit`
// records as collapsible subtree groups -- the group row toggles its bound
// session rows (the SAME row rendering the recent body uses, via the
// parent's renderRows channel), the row-end pill carries the same-workspace
// new-session shortcut (⊕) plus the actions menu (open folder / rename /
// remove from list), and the section head carries the expand/collapse-all
// toggle plus the #1393 naming modal's shape (mirrored locally; the guard
// and locale keys are the shared parts) as the "New workspace" entry.
//
// Mutation stance: rename / remove are explicit user actions served by
// strict IPC commands; a refusal surfaces inline in the rename modal or as
// a failed mutation (the group simply stays). Every success invalidates the
// workspace listing so the pill / popover / sidebar faces re-derive from
// the registry (issue #1392's three-faces rule).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FolderX,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Plus,
  SquarePen,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button-variants";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { bareButtonReset } from "@/lib/buttonReset";
import { log } from "@/lib/log";
import { usePointerCloseIntent } from "@/lib/usePointerCloseIntent";
import { isInvalidWorkspaceName } from "@/lib/workspaceName";
import { createWorkspace, removeWorkspace, renameWorkspace } from "../api";
import { readSidebarExpansion, saveSidebarExpansion } from "./sidebarExpansion";
import { workspaceKeys } from "./queryKeys";
import { SIDEBAR_PREVIEW_CAP as PREVIEW_CAP } from "./sidebarModel";
import type { SidebarEntry, WorkspaceGroup } from "./sidebarModel";
import type { SessionMetadata } from "../types/session";

/** The session-row li shell (the .session-entry marker + the hover ground),
 *  shared VERBATIM with the recent body's rows -- one constant, not two
 *  hand-synced copies (the marker names carry no CSS of their own; this
 *  string IS the style). */
export const ROW_SHELL_CLASS =
  "session-entry group/row relative my-0.5 flex items-stretch rounded-md hover:bg-accent";

/** The row-end pill container, shared VERBATIM with the recent body's
 *  rows: the opacity + pointer-events reveal pair keyed on the row hover
 *  / focus-inside. */
export const PILL_CLASS =
  "session-entry-actions absolute inset-y-0 right-1 z-10 flex items-center gap-0 rounded-md bg-accent opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto";

/** The pill's trigger face: the RowActionsMenu trigger posture (the bare
 *  reset + the size-7 hit area + the focus ring + the busy dim). */
const PILL_TRIGGER_CLASS = `session-row-action ${bareButtonReset} flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50`;

/** The section head's action buttons (expand/collapse-all + the create
 *  entry): the ArchivedToggle posture -- hover-revealed, focus-visible
 *  kept, busy-dimmed. Show/hide snaps (no transition): a fade lags fast
 *  pointer sweeps, the same ruling the working-set row pill carries. */
const HEAD_ACTION_CLASS = `sidebar-archived-toggle ${bareButtonReset} rounded-md p-1 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50`;

/** The "Show more (N)" tail button, shared with the parent's section
 *  renderer (the recent body mounts its own instances). */
export const SHOW_MORE_CLASS =
  "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export type WorkspaceSidebarSectionProps = {
  /** The explicit registry groups, server (LRU) order. */
  groups: WorkspaceGroup[];
  /** The full persisted scan (the groups' upstream): the landing diff runs
   *  on it rather than the late-assembled group buckets. The list itself
   *  starts empty and fills after mount -- gate on sessionsLoaded. */
  sessions: SessionMetadata[];
  /** True once the first listSessions scan resolved: the landing diff's
   *  baseline waits on it, so a cold start's empty-to-full transition is
   *  not mistaken for a landing. */
  sessionsLoaded: boolean;
  disabled: boolean;
  /** The section-level fold, owned by the parent (persists across restarts). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The session rows' renderer from the parent (the recent body's exact
   *  channel: SidebarRow + RowActionsMenu + the hover-card machine). */
  renderRows: (entries: SidebarEntry[]) => ReactNode;
  /** The same-workspace new-session shortcut: the shell stages the binding
   *  (pendingWorkspace) and returns to the cold-start bar. */
  onNewInWorkspace: (path: string, label: string) => void;
  /** The section chrome (grouping + archived toggles) when this section is
   *  the first rendered one. */
  chrome?: ReactNode;
};

export function WorkspaceSidebarSection({
  groups,
  sessions,
  sessionsLoaded,
  disabled,
  collapsed,
  onToggleCollapsed,
  renderRows,
  onNewInWorkspace,
  chrome,
}: WorkspaceSidebarSectionProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  // The subtree expansion state persists across restarts (issue #1404 -- the
  // #1398 "per-session" ruling flips here). The landing seen baseline joins
  // the same persisted document ON PURPOSE: persisting the expansion without
  // the baseline would replay the cold-start fan-out on every launch (an
  // empty seen set reads every persisted bound row as newly landed). The
  // per-group "Show more" state stays per-expansion -- collapsing the group
  // (or the bulk collapse-all) resets it, and it is never written.
  const [persisted] = useState(readSidebarExpansion);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => persisted.expandedWorkspaces,
  );
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  // The rename modal's draft (the #1393 modal shape: the draft + the
  // backend refusal clear together on close).
  const [renaming, setRenaming] = useState<WorkspaceGroup | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  // The new-workspace modal's draft (the selector's create modal, mirrored).
  const [createOpen, setCreateOpen] = useState(false);
  const [createInput, setCreateInput] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  // The remove-from-list strong-confirm target (the DeleteSessionDialog
  // staging posture): the menu item stages the group, the dialog's confirm
  // fires the mutation.
  const [removing, setRemoving] = useState<WorkspaceGroup | null>(null);

  function toggleGroup(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
    saveSidebarExpansion({ expandedWorkspaces: next });
    // Collapsing resets the preview: re-expanding starts at the cap again
    // ("Show more" is a per-expansion choice, not a sticky one).
    if (expanded.has(path)) {
      const rest = new Set(showAll);
      rest.delete(path);
      setShowAll(rest);
    }
  }

  function setAllExpanded(open: boolean) {
    // Guard: an expand-all before the listing resolves builds the empty
    // set and would wipe the persisted expansion -- the head action is
    // busy-gated only, so the listing's in-flight (or rejected) window
    // is clickable. The collapse-all half needs no guard: the empty set
    // is the collapsed face it promises.
    if (open && groups.length === 0) return;
    const next = open ? new Set(groups.map((g) => g.path)) : new Set<string>();
    setExpanded(next);
    saveSidebarExpansion({ expandedWorkspaces: next });
    // Collapsing resets every group's preview -- the same
    // collapse-resets-preview rule the single toggle applies, at bulk
    // scale ("Show more" is a per-expansion choice, not a sticky one).
    if (!open) setShowAll(new Set());
  }

  // A session landing in a workspace reveals its group (the mint's tail).
  // The diff runs on the `sessions` prop's bound paths -- NOT the groups:
  // the groups are a bucket view that assembles late (the workspaces
  // listing is its own query), and diffing them would mistake the late
  // bucket assembly for a landing. But the list itself is ALSO async --
  // empty until the first listSessions scan resolves -- so the baseline
  // waits for `sessionsLoaded`: recorded on the scan's first completion,
  // it already holds every persisted bound row, and only a NEW recipe
  // path afterwards -- a real mint through any binding path (the ⊕
  // shortcut, the picker, the popover) -- flips its group open. The null
  // sentinel stays: the persisted seen memory (issue #1404) merges INTO the
  // baseline -- it must not become the baseline itself, or a first launch
  // with no store would read every persisted bound row as newly landed.
  // Seen paths are remembered, never re-fanned (across restarts too, now
  // that the memory persists): a row that leaves and returns (the archive /
  // unarchive cycle) is not a second landing, so a group the user folded
  // stays folded. Manual folds are otherwise honored -- only the landed
  // workspaces flip.
  const seenBoundRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!sessionsLoaded) return;
    const seen = seenBoundRef.current;
    const bound = sessions.filter((m) => m.workspace !== null);
    if (seen === null) {
      const baseline = new Set([
        ...persisted.seenWorkspaces,
        ...bound.map((m) => m.recipe_path),
      ]);
      seenBoundRef.current = baseline;
      if (bound.length > 0) saveSidebarExpansion({ seenWorkspaces: baseline });
      return;
    }
    const landed = new Set(
      bound
        .filter((m) => !seen.has(m.recipe_path))
        .map((m) => m.workspace)
        .filter((w): w is string => w !== null),
    );
    let grew = false;
    for (const m of bound) {
      if (!seen.has(m.recipe_path)) {
        seen.add(m.recipe_path);
        grew = true;
      }
    }
    if (grew) saveSidebarExpansion({ seenWorkspaces: seen });
    if (landed.size === 0) return;
    // The landing fan-out is deliberately NOT written back to the persisted
    // expansion: it is the mint's notification reveal (#1398), not a layout
    // choice -- the same non-sticky family as the "Show more" previews. The
    // persisted face changes only under a user action (a toggle, the head
    // bulk toggle); after a restart a landed group reads as folded again.
    setExpanded((existing) => {
      const next = new Set([...existing, ...landed]);
      // No growth means no state change: keep the old reference so the
      // effect never re-renders on its own.
      return next.size === existing.size ? existing : next;
    });
  }, [sessions, sessionsLoaded, persisted]);

  function openRename(group: WorkspaceGroup) {
    setRenaming(group);
    setRenameInput(group.label);
    setRenameError(null);
  }

  function closeRename() {
    setRenaming(null);
    setRenameInput("");
    setRenameError(null);
  }

  function closeCreate() {
    setCreateOpen(false);
    setCreateInput("");
    setCreateError(null);
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.all() });
  };

  const remove = useMutation({
    mutationFn: (path: string) => removeWorkspace(path),
    onSuccess: invalidate,
    // The confirm dialog is already gone when the mutation runs, so a
    // refusal has no modal to surface in: log it -- the ArtifactHeader
    // posture (the record stays, the action is simply retryable).
    onError: (e) =>
      log.warn("WorkspaceSidebarSection", "removeWorkspace failed", e),
  });

  const rename = useMutation({
    mutationFn: ({ path, title }: { path: string; title: string }) =>
      renameWorkspace(path, title),
    onSuccess: () => {
      invalidate();
      closeRename();
    },
    // A refusal surfaces inline and keeps the modal open (the backend's
    // rename guard is trim + non-empty only -- the shared name guard is
    // the full rule's only enforcer on this face).
    onError: (e) =>
      setRenameError(e instanceof Error ? e.message : String(e)),
  });

  const create = useMutation({
    mutationFn: (name: string) => createWorkspace(name),
    onSuccess: () => {
      invalidate();
      closeCreate();
    },
    onError: (e) =>
      setCreateError(e instanceof Error ? e.message : String(e)),
  });

  const renameTrimmed = renameInput.trim();
  const renameInvalid = isInvalidWorkspaceName(renameTrimmed);
  const createTrimmed = createInput.trim();
  const createInvalid = isInvalidWorkspaceName(createTrimmed);
  // The head face keys on groups that actually render: stale expanded
  // entries for gone groups must not distort the toggle (an all-collapsed
  // list would otherwise wear the collapse face and eat a click).
  const anyGroupOpen = groups.some((g) => expanded.has(g.path));
  // The head toggle's label, two STATIC branches (the extract gate reads
  // call sites at statement level, not inside a JSX attribute ternary).
  const headToggleLabel =
    anyGroupOpen
      ? intl.formatMessage({
          id: "sidebar.workspace.collapseAllAria",
          defaultMessage: "Collapse all workspaces",
        })
      : intl.formatMessage({
          id: "sidebar.workspace.expandAllAria",
          defaultMessage: "Expand all workspaces",
        });

  return (
    <li className="session-group mt-3 mb-1" data-section="workspaces">
      <div className="session-group-title-row group relative mb-0.5 flex items-center justify-between px-1">
        {/* The title row itself is the section fold toggle (the whole row
            clicks); the chevron rides the label's tail, hover/focus-revealed
            -- the same posture as the parent's section heads. */}
        <h3 className="session-group-title min-w-0 flex-1 text-xs uppercase tracking-wider text-muted-foreground">
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            className="flex w-full items-center gap-0.5 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="truncate">
              <FormattedMessage id="sidebar.group.workspaces" defaultMessage="Workspaces" />
            </span>
            <span className="shrink-0 tabular-nums">({groups.length})</span>
            <span
              aria-hidden
              className="shrink-0 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
            >
              {collapsed ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </span>
          </button>
        </h3>
        <div className="flex items-center gap-0.5">
          {chrome}
          {/* The head actions (issue #1392): bulk expand/collapse of every
              subtree + the #1393-shaped create modal. The triggers are
              hover-revealed but stay focus-visible for AT users (the
              ArchivedToggle posture). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={headToggleLabel}
                disabled={disabled}
                className={HEAD_ACTION_CLASS}
                onClick={() => setAllExpanded(!anyGroupOpen)}
              >
                {anyGroupOpen ? (
                  <Minimize2 className="size-3.5" aria-hidden />
                ) : (
                  <Maximize2 className="size-3.5" aria-hidden />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>{headToggleLabel}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={intl.formatMessage({
                  id: "composer.workspace.newWorkspace",
                  defaultMessage: "New workspace",
                })}
                disabled={disabled}
                className={HEAD_ACTION_CLASS}
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <FormattedMessage
                id="composer.workspace.newWorkspace"
                defaultMessage="New workspace"
              />
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {!collapsed && (
        <ul className="session-group-list list-none m-0 pb-2 pt-1">
          {groups.length === 0 && (
            <li className="session-empty py-1 pl-7 text-xs text-muted-foreground">
              <FormattedMessage
                id="sidebar.workspace.empty"
                defaultMessage="No sessions"
              />
            </li>
          )}
          {groups.map((g) => {
            const open = expanded.has(g.path);
            const capped =
              !showAll.has(g.path) && g.entries.length > PREVIEW_CAP;
            const shown = capped ? g.entries.slice(0, PREVIEW_CAP) : g.entries;
            return (
              <li key={g.path} data-workspace-group={g.path}>
                <div className={ROW_SHELL_CLASS}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleGroup(g.path)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1.5 pr-2 text-left text-sm text-foreground"
                  >
                    {open ? (
                      <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className="truncate">{g.label}</span>
                    {g.missing && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <FormattedMessage
                          id="sidebar.workspace.missing"
                          defaultMessage="(Folder not found)"
                        />
                      </span>
                    )}
                    {/* The fold chevron rides the label's tail (not the row
                        edge, which the hover pill owns), revealed on row
                        hover / focus -- the whole row button toggles. */}
                    <span
                      aria-hidden
                      className="shrink-0 text-muted-foreground opacity-0 group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100"
                    >
                      {open ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronRight className="size-3.5" />
                      )}
                    </span>
                  </button>
                  {/* The row-end pill: the same-workspace new-session
                      shortcut (the one-step continuation) + the actions
                      menu, on the session rows' exact pill face. */}
                  <div className={PILL_CLASS}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          aria-label={intl.formatMessage({
                            id: "sidebar.workspace.newSessionAria",
                            defaultMessage: "New session in this workspace",
                          })}
                          disabled={disabled}
                          className={PILL_TRIGGER_CLASS}
                          onClick={() => onNewInWorkspace(g.path, g.label)}
                        >
                          <SquarePen className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {intl.formatMessage({
                          id: "sidebar.newSession",
                          defaultMessage: "New session",
                        })}
                      </TooltipContent>
                    </Tooltip>
                    <WorkspaceGroupMenu
                      group={g}
                      disabled={disabled}
                      onRename={() => openRename(g)}
                      onRemove={() => setRemoving(g)}
                    />
                  </div>
                </div>
                {open && shown.length > 0 && (
                  <ul className="ml-4 border-l border-border pl-0.5">
                    {renderRows(shown)}
                    {capped && (
                      <li className="my-0.5">
                        <button
                          type="button"
                          className={SHOW_MORE_CLASS}
                          onClick={() =>
                            setShowAll((prev) => new Set(prev).add(g.path))}
                        >
                          <FormattedMessage
                            id="sidebar.showMore"
                            defaultMessage="Show more ({count})"
                            values={{ count: g.entries.length - PREVIEW_CAP }}
                          />
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* The remove confirm: names the ledger-only consequence (the folder
          and its bound sessions stay), Cancel auto-focused (the safe
          escape), the destructive Action fires the registry mutation. */}
      {removing && (
        <RemoveWorkspaceDialog
          name={removing.label}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const path = removing.path;
            setRemoving(null);
            remove.mutate(path);
          }}
        />
      )}

      {/* The rename modal (issue #1392): the #1393 modal shape -- the
          input pre-fills the current label (the title, else the directory
          tail), the shared guard keeps the Save button honest, Enter
          submits, and every close path clears the draft. The title is the
          only write; the path never moves. */}
      <Dialog open={renaming !== null} onOpenChange={(next) => !next && closeRename()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <FormattedMessage
                id="sidebar.workspace.renameTitle"
                defaultMessage="Rename workspace"
              />
            </DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!renameInvalid && renaming !== null) {
                rename.mutate({ path: renaming.path, title: renameTrimmed });
              }
            }}
          >
            <Input
              autoFocus
              value={renameInput}
              onChange={(e) => {
                setRenameInput(e.target.value);
                setRenameError(null);
              }}
              placeholder={intl.formatMessage({
                id: "composer.workspace.namePlaceholder",
                defaultMessage: "Workspace name",
              })}
              aria-label={intl.formatMessage({
                id: "composer.workspace.namePlaceholder",
                defaultMessage: "Workspace name",
              })}
              aria-invalid={renameInvalid && renameTrimmed.length > 0}
            />
            {renameInvalid && renameTrimmed.length > 0 && (
              <p className="text-xs text-destructive">
                <FormattedMessage
                  id="composer.workspace.invalidName"
                  defaultMessage={"Must be 1-64 characters, no \\ / : * ? \" < > |, and must not end with a dot"}
                />
              </p>
            )}
            {renameError !== null && (
              <p className="text-xs text-destructive">{renameError}</p>
            )}
            <DialogFooter className="mt-2">
              <Button type="button" variant="outline" onClick={closeRename}>
                <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
              </Button>
              <Button type="submit" disabled={renameInvalid}>
                <FormattedMessage id="sidebar.workspace.save" defaultMessage="Save" />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* The new-workspace modal: the selector's create modal, mirrored for
          the section head's entry. A success lands in the listing (the
          record is explicit) and the group appears immediately. */}
      <Dialog open={createOpen} onOpenChange={(next) => !next && closeCreate()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <FormattedMessage
                id="composer.workspace.newWorkspace"
                defaultMessage="New workspace"
              />
            </DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!createInvalid) create.mutate(createTrimmed);
            }}
          >
            <Input
              autoFocus
              value={createInput}
              onChange={(e) => {
                setCreateInput(e.target.value);
                setCreateError(null);
              }}
              placeholder={intl.formatMessage({
                id: "composer.workspace.namePlaceholder",
                defaultMessage: "Workspace name",
              })}
              aria-label={intl.formatMessage({
                id: "composer.workspace.namePlaceholder",
                defaultMessage: "Workspace name",
              })}
              aria-invalid={createInvalid && createTrimmed.length > 0}
            />
            {createInvalid && createTrimmed.length > 0 && (
              <p className="text-xs text-destructive">
                <FormattedMessage
                  id="composer.workspace.invalidName"
                  defaultMessage={"Must be 1-64 characters, no \\ / : * ? \" < > |, and must not end with a dot"}
                />
              </p>
            )}
            {createError !== null && (
              <p className="text-xs text-destructive">{createError}</p>
            )}
            <DialogFooter className="mt-2">
              <Button type="button" variant="outline" onClick={closeCreate}>
                <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
              </Button>
              <Button type="submit" disabled={createInvalid}>
                <FormattedMessage id="composer.workspace.create" defaultMessage="Create" />
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </li>
  );
}

/** One group row's actions menu (issue #1392): the three items -- open the
 *  folder in the OS file manager (the opener scope already allows every
 *  path), rename (opens the modal), remove from list (deletes the REGISTRY
 *  record only; the directory stays and the bound sessions fall back to
 *  the recent list). */
function WorkspaceGroupMenu({
  group,
  disabled,
  onRename,
  onRemove,
}: {
  group: WorkspaceGroup;
  disabled: boolean;
  onRename: () => void;
  onRemove: () => void;
}) {
  const intl = useIntl();
  const menuLabel = intl.formatMessage({
    id: "sidebar.workspace.menu.ariaLabel",
    defaultMessage: "Workspace actions",
  });
  // The RowActionsMenu's close-classification posture (issue #1309): Radix
  // always restores trigger focus on close; a pointer-driven close must not
  // strand it there.
  const closedByPointerRef = usePointerCloseIntent();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        onFocus={(e) => e.stopPropagation()}
        className={PILL_TRIGGER_CLASS}
        aria-label={menuLabel}
        onClick={(e) => e.stopPropagation()}
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden strokeWidth={2.5} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label={menuLabel}
        onCloseAutoFocus={(e) => {
          if (closedByPointerRef.current) e.preventDefault();
        }}
      >
        {/* A missing directory cannot open (the OS would refuse); the item's
            disabled face echoes the row's missing hint. */}
        <DropdownMenuItem
          disabled={group.missing}
          onSelect={() => {
            // The opener can refuse (a folder deleted after the listing
            // snapshot): log it -- the ArtifactHeader posture. The menu is
            // closed by then, so the log is the honest surface.
            openPath(group.path).catch((e: unknown) =>
              log.warn("WorkspaceSidebarSection", "openPath failed", e),
            );
          }}
        >
          <FolderOpen aria-hidden />
          <FormattedMessage id="sidebar.workspace.openFolder" defaultMessage="Open folder" />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>
          <Pencil aria-hidden />
          <FormattedMessage id="common.rename" defaultMessage="Rename" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <FolderX aria-hidden />
          <FormattedMessage id="sidebar.workspace.remove" defaultMessage="Remove from list" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The remove-from-list strong-confirm: removing is a ledger edit -- the
// directory and its bound sessions stay on disk, only the registry record
// (and with it the sidebar group) goes, and the dialog says so before the
// destructive Action fires. The DeleteSessionDialog shell posture: a
// mounted-open AlertDialog, ESC routes to onCancel, the Cancel trigger
// renders first (Radix auto-focuses it, the safe escape), the Action wears
// the destructive buttonVariants via the cn override.
function RemoveWorkspaceDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent onEscapeKeyDown={() => onCancel()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage
              id="sidebar.workspace.removeConfirm.title"
              defaultMessage="Remove {name}?"
              values={{ name }}
            />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="sidebar.workspace.removeConfirm.body"
              defaultMessage="This only removes the workspace from the app. The folder and its sessions on your computer are not deleted."
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>
            <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
          </AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            onClick={onConfirm}
          >
            <FormattedMessage
              id="sidebar.workspace.removeConfirm.confirm"
              defaultMessage="Remove"
            />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
