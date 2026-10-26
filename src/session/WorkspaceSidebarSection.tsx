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

import { useState, type ReactNode } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderX,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import { openPath } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
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
import { bareButtonReset } from "@/lib/buttonReset";
import { log } from "@/lib/log";
import { usePointerCloseIntent } from "@/lib/usePointerCloseIntent";
import { isInvalidWorkspaceName } from "@/lib/workspaceName";
import { createWorkspace, removeWorkspace, renameWorkspace } from "../api";
import { workspaceKeys } from "./queryKeys";
import { SIDEBAR_PREVIEW_CAP as PREVIEW_CAP } from "./sidebarModel";
import type { SidebarEntry, WorkspaceGroup } from "./sidebarModel";

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
 *  kept, busy-dimmed. */
const HEAD_ACTION_CLASS = `sidebar-archived-toggle ${bareButtonReset} cursor-pointer rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50`;

/** The "Show more (N)" tail button, shared with the parent's section
 *  renderer (the recent body mounts its own instances). */
export const SHOW_MORE_CLASS =
  "flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export type WorkspaceSidebarSectionProps = {
  /** The explicit registry groups, server (LRU) order. */
  groups: WorkspaceGroup[];
  disabled: boolean;
  /** The section-level fold, owned by the parent (per-session state). */
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
  disabled,
  collapsed,
  onToggleCollapsed,
  renderRows,
  onNewInWorkspace,
  chrome,
}: WorkspaceSidebarSectionProps) {
  const intl = useIntl();
  const queryClient = useQueryClient();
  // The subtree expansion state: per-session, not persisted (the AC's
  // "collapse state is valid within a session" applies to the whole
  // section family). Default collapsed -- the expand-all head action is
  // the bulk reveal.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The per-group "Show more" state: per-expansion -- collapsing the
  // group (or the bulk collapse-all) resets it.
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

  function toggleGroup(path: string) {
    // Collapsing resets the preview: re-expanding starts at the cap again
    // ("Show more" is a per-expansion choice, not a sticky one).
    if (expanded.has(path)) {
      setShowAll((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function setAllExpanded(open: boolean) {
    // Collapsing resets every group's preview -- the same
    // collapse-resets-preview rule the single toggle applies, at bulk
    // scale ("Show more" is a per-expansion choice, not a sticky one).
    if (!open) setShowAll(new Set());
    setExpanded(open ? new Set(groups.map((g) => g.path)) : new Set());
  }

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
  // The head toggle's label, two STATIC branches (the extract gate reads
  // call sites at statement level, not inside a JSX attribute ternary).
  const headToggleLabel =
    expanded.size > 0
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
            className="flex w-full cursor-pointer items-center gap-0.5 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="truncate">
              <FormattedMessage id="sidebar.group.workspaces" defaultMessage="Workspaces" />
            </span>
            <span className="shrink-0 tabular-nums">({groups.length})</span>
            <span
              aria-hidden
              className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
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
          <button
            type="button"
            aria-label={headToggleLabel}
            disabled={disabled}
            className={HEAD_ACTION_CLASS}
            onClick={() => setAllExpanded(expanded.size === 0)}
          >
            {expanded.size > 0 ? (
              <ChevronsDownUp className="size-3.5" aria-hidden />
            ) : (
              <ChevronsUpDown className="size-3.5" aria-hidden />
            )}
          </button>
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
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1.5 pl-1.5 pr-2 text-left text-sm text-foreground"
                  >
                    {open ? (
                      <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
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
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-has-[:focus-visible]/row:opacity-100 group-hover/row:opacity-100"
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
                      <Plus className="h-3.5 w-3.5" aria-hidden strokeWidth={2.5} />
                    </button>
                    <WorkspaceGroupMenu
                      group={g}
                      disabled={disabled}
                      onRename={() => openRename(g)}
                      onRemove={() => remove.mutate(g.path)}
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
