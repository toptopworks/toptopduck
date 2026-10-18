import { useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import {
  Archive,
  ArchiveRestore,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { bareButtonReset } from "@/lib/buttonReset";
import { usePointerCloseIntent } from "@/lib/usePointerCloseIntent";
import { cn } from "@/lib/utils";
import type { SidebarEntry } from "./sidebarModel";
import { DeleteSessionDialog, RenameSessionDialog } from "./SessionDialogs";

// One row-end actions menu (ADR-0133, issue #1319): the single `⋯` trigger in
// the hover pill reclaims the row-level Rename / Close / Delete that ADR-0093
// moved to the session header, and absorbs the retired inline buttons (pin /
// archive on main rows, restore / delete on archived rows). Items render by
// row state -- open rows carry Close, archived rows carry only Restore +
// Delete -- and the row-end invariant is ONE trigger button in every state.
// Rename + Delete open local dialog state (the same exported dialogs the
// header menu mounts, so the shared-component rule costs zero logic
// duplication); Close fires the shell callback directly. The trigger mirrors
// SessionHeaderMenu's glyph (MoreHorizontal at h-3.5 w-3.5) inside the pill's
// size-7 hit area.
export function RowActionsMenu({
  entry,
  displayName,
  disabled,
  archived = false,
  onSetPinned,
  onArchive,
  onRename,
  onClose,
  onDelete,
  onMenuOpenChange,
}: {
  entry: SidebarEntry;
  /** Resolved upstream (resolveDisplayName) for the dialogs: the rename
   *  prefill and the delete confirmation both show it. */
  displayName: string;
  /** Busy parity with every sibling control (the WorkingSetList posture):
   *  delete / archive wait on the persistence axis -- a repeat open during
   *  the wait would double-fire the close on an already-closing sid. */
  disabled: boolean;
  archived?: boolean;
  onSetPinned: (path: string, pinned: boolean) => void;
  /** Archive passes the open binding when present (archiving an open row
   *  closes it first, the ADR-0127 Decision 6 contract); restore passes
   *  null -- an archived row is never open (open-is-unarchive). */
  onArchive: (path: string, archived: boolean, sid: string | null) => void;
  onRename: (path: string, sid: string | null, newName: string) => void;
  onClose: (sid: string) => void;
  onDelete: (path: string, sid: string | null) => void;
  /** The DropdownMenu root's open flips, forwarded verbatim: the parent
   *  retires the metadata card on open -- the pointer is necessarily on
   *  the row (it reached the trigger), so the card is necessarily open
   *  and the two row-tail overlays would stack. */
  onMenuOpenChange: (open: boolean) => void;
}) {
  const intl = useIntl();
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const menuLabel = intl.formatMessage({
    id: "sidebar.row.menu.ariaLabel",
    defaultMessage: "Row actions",
  });
  // Narrow once: the open-row branches (the Close item, the sid-bearing
  // callbacks) need the string, and narrowing does not survive into a
  // closure over a property access.
  const sid = entry.sid;
  // How the menu's closing interaction is classified (the #1309 shared
  // hook): Radix always re-focuses the trigger on close, which is right
  // for keyboard (Escape / Enter-select) but strands a focus ring +
  // revealed pill after a pointer select. Last input wins -- the old
  // open-side reset is subsumed, since every close is immediately preceded
  // by the input event that caused it.
  const closedByPointerRef = usePointerCloseIntent();
  return (
    <>
      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger
          disabled={disabled}
          onFocus={(e) => {
            // Pill intent, NOT card intent: the li carries Radix's
            // HoverCard focus wiring, so this focus (click-focus or the
            // close-restore) bubbling up would re-arm the 300 ms card
            // dwell and pop the metadata card back over the open menu.
            // Native :focus-visible styling (pill reveal) still applies --
            // only the React synthetic propagation is stopped.
            e.stopPropagation();
          }}
          className={cn(
            // No cursor-pointer: the pill's icons keep the default arrow
            // (the WorkingSetList ICON_BUTTON_BASE posture, mirrored inline
            // -- the constant is not exported; on the accent pill, color
            // alone marks the hot icon).
            `session-row-action ${bareButtonReset} flex size-7 items-center justify-center rounded-md text-muted-foreground`,
            "transition-colors hover:text-foreground focus-visible:text-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:cursor-progress disabled:opacity-50",
          )}
          aria-label={menuLabel}
          onClick={(e) => {
            // The trigger is a SIBLING of the main activate button, so a
            // click cannot reach it by bubbling; the stopPropagation is
            // defensive against a future row-level handler (issue #1175).
            e.stopPropagation();
          }}
        >
          <MoreHorizontal className="h-3.5 w-3.5" aria-hidden strokeWidth={2.5} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          aria-label={menuLabel}
          onCloseAutoFocus={(e) => {
            // Radix restores trigger focus on every close; a pointer-driven
            // close must not strand it there (the hook's window-level
            // capture saw the pointerdown -- item select included). Keyboard
            // closes keep the restore (the keyboard user's next Tab target
            // depends on it).
            if (closedByPointerRef.current) e.preventDefault();
          }}
        >
          {archived ? (
            <DropdownMenuItem onSelect={() => onArchive(entry.path, false, null)}>
              <ArchiveRestore aria-hidden />
              <FormattedMessage id="sidebar.row.restore" defaultMessage="Restore" />
            </DropdownMenuItem>
          ) : (
            <>
              {/* Pin / Unpin are separate static branches: a dynamic
                  FormattedMessage id would break the i18n:check CI gate. */}
              {entry.pinned ? (
                <DropdownMenuItem onSelect={() => onSetPinned(entry.path, false)}>
                  <PinOff aria-hidden />
                  <FormattedMessage id="sidebar.row.unpin" defaultMessage="Unpin" />
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onSetPinned(entry.path, true)}>
                  <Pin aria-hidden />
                  <FormattedMessage id="sidebar.row.pin" defaultMessage="Pin" />
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setDialog("rename")}>
                <Pencil aria-hidden />
                <FormattedMessage id="common.rename" defaultMessage="Rename" />
              </DropdownMenuItem>
              {sid ? (
                <DropdownMenuItem onSelect={() => onClose(sid)}>
                  <X aria-hidden />
                  <FormattedMessage id="sidebar.row.close" defaultMessage="Close" />
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => onArchive(entry.path, true, sid)}>
                <Archive aria-hidden />
                <FormattedMessage id="sidebar.row.archive" defaultMessage="Archive" />
              </DropdownMenuItem>
            </>
          )}
          {/* Delete rides EVERY row state -- one destructive item, hoisted out
              of the row-state branches. */}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDialog("delete")}
          >
            <Trash2 aria-hidden />
            <FormattedMessage id="sidebar.row.delete" defaultMessage="Delete" />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "rename" && (
        <RenameSessionDialog
          initialName={entry.name}
          onCancel={() => setDialog(null)}
          onSubmit={(newName) => {
            setDialog(null);
            onRename(entry.path, sid, newName);
          }}
        />
      )}
      {dialog === "delete" && (
        <DeleteSessionDialog
          name={displayName}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            onDelete(entry.path, sid);
          }}
        />
      )}
    </>
  );
}
