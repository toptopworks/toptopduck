// The sidebar's workspace section (issue #1392): the registry's `explicit`
// records as collapsible subtree groups -- the group row toggles its bound
// session rows (the SAME row rendering the recent body uses, via the
// parent's renderRows channel), the row-end pill carries the same-workspace
// new-session shortcut (⊕) plus the actions menu (open folder / rename /
// remove from list), and the section head carries the expand/collapse-all
// toggle plus the shared #1393 naming modal as the "New workspace" entry.
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
import { usePointerCloseIntent } from "@/lib/usePointerCloseIntent";
import { cn } from "@/lib/utils";
import { isInvalidWorkspaceName } from "@/lib/workspaceName";
import { createWorkspace, removeWorkspace, renameWorkspace } from "../api";
import { workspaceKeys } from "./queryKeys";
import { SIDEBAR_PREVIEW_CAP as PREVIEW_CAP } from "./sidebarModel";
import type { SidebarEntry, WorkspaceGroup } from "./sidebarModel";

/** The group row's shell classes: the SAME li-shell posture the session
 *  rows use (the shared .session-entry / .session-entry-actions hooks keep
 *  the row visuals and the hover pill aligned across the two row kinds). */
const GROUP_ROW_CLASS =
  "session-entry group/row relative my-0.5 flex items-stretch rounded-md hover:bg-accent";

/** The row-end pill: the session rows' exact container face (the opacity +
 *  pointer-events reveal pair keyed on the row hover / focus-inside). */
const PILL_CLASS =
  "session-entry-actions absolute inset-y-0 right-1 z-10 flex items-center gap-0 rounded-md bg-accent opacity-0 pointer-events-none group-hover/row:opacity-100 group-hover/row:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto";

/** The pill's trigger face: the RowActionsMenu trigger posture (the bare
 *  reset + the size-7 hit area + the focus ring). */
const PILL_TRIGGER_CLASS = `session-row-action ${bareButtonReset} flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;

/** The "Show more (N)" tail button, shared with the parent's section
 *  renderer (the recent body mounts its own instances). */
export const SHOW_MORE_CLASS =
  "flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** The section head's collapse toggle, shared with the parent's section
 *  renderer (the pinned / recent sections mount their own instance). The
 *  collapsed state lives in the parent's per-session Set. */
export function SectionCollapseButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  // Two STATIC branches per arm (the RowActionsMenu pin/unpin precedent):
  // a ternary id string would break the i18n:check extract gate.
  const label = collapsed
    ? intl.formatMessage({
        id: "sidebar.section.expandAria",
        defaultMessage: "Expand section",
      })
    : intl.formatMessage({
        id: "sidebar.section.collapseAria",
        defaultMessage: "Collapse section",
      });
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={label}
      className={cn(
        bareButtonReset,
        "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      )}
      onClick={onToggle}
    >
      {collapsed ? (
        <ChevronRight className="size-3.5" aria-hidden />
      ) : (
        <ChevronDown className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

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
  // The per-group "Show more" state: once revealed, stays revealed.
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
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function setAllExpanded(open: boolean) {
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
    // The backend's refusal (the trust boundary), surfaced inline.
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
    <li className="session-group mt-1.5 mb-0.5" data-section="workspaces">
      <div className="session-group-title-row group relative mb-0.5 flex items-center justify-between px-1">
        <div className="flex min-w-0 items-center gap-0.5">
          <SectionCollapseButton collapsed={collapsed} onToggle={onToggleCollapsed} />
          <h3 className="session-group-title text-xs uppercase tracking-wider text-muted-foreground">
            <FormattedMessage id="sidebar.group.workspaces" defaultMessage="Workspaces" />
          </h3>
          <span className="text-xs tabular-nums text-muted-foreground">{groups.length}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {chrome}
          {/* The head actions (issue #1392): bulk expand/collapse of every
              subtree + the shared naming modal as the create entry. The
              triggers are hover-revealed but stay focus-visible for AT
              users (the ArchivedToggle posture). */}
          <button
            type="button"
            aria-label={headToggleLabel}
            disabled={disabled}
            className={cn(
              `sidebar-archived-toggle ${bareButtonReset} cursor-pointer rounded-md p-1 text-muted-foreground`,
              "opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
              "hover:bg-accent hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              "disabled:cursor-progress disabled:opacity-50",
            )}
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
            className={cn(
              `sidebar-archived-toggle ${bareButtonReset} cursor-pointer rounded-md p-1 text-muted-foreground`,
              "opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
              "hover:bg-accent hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              "disabled:cursor-progress disabled:opacity-50",
            )}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
      {!collapsed && (
        <ul className="session-group-list list-none m-0 p-0">
          {groups.map((g) => {
            const open = expanded.has(g.path);
            const capped =
              !showAll.has(g.path) && g.entries.length > PREVIEW_CAP;
            const shown = capped ? g.entries.slice(0, PREVIEW_CAP) : g.entries;
            return (
              <li key={g.path} data-workspace-group={g.path}>
                <div className={GROUP_ROW_CLASS}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggleGroup(g.path)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1.5 pl-1.5 pr-2 text-left text-sm text-foreground"
                  >
                    {open ? (
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    ) : (
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{g.label}</span>
                    {g.missing && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <FormattedMessage
                          id="sidebar.workspace.missing"
                          defaultMessage="(Folder not found)"
                        />
                      </span>
                    )}
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
                {open && (shown.length > 0 || capped) && (
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
          input pre-fills the current title, the shared guard keeps the
          Save button honest, Enter submits, and every close path clears
          the draft. The title is the only write; the path never moves. */}
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
          onSelect={() => void openPath(group.path)}
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
