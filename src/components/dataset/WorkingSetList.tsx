import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useIntl, FormattedMessage } from "react-intl";
import { Pencil, RefreshCw, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/button-variants";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "../ui/dialog";
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
import { cn } from "../../lib/utils";
import type { DatasetDescriptor } from "../../types/dataset";

// ADR-0067 (issue #184): the .working-set button rule (all: unset + cursor +
// padding + radius + display:block + width:100%) retired onto Tailwind
// utilities. Tailwind v4's Preflight already resets the button's background
// to transparent, inherits font/color, and zeroes margin/padding, so only the
// residual visual contract is re-stated here: strip the native border +
// appearance and set the var(--radius) corner. Issue #790 splits the former
// single full-width constant into the two row shapes below (select + icon).
const BUTTON_CHROME = "appearance-none border-0 cursor-pointer rounded-md";
// The select button: fills the row's leftover width (flex-1 + min-w-0 so the
// label can truncate inside), compact padding, left alignment (UA button text
// is centered). Active state (bg-accent + font-semibold) layers on via cn()
// at the call site.
const SELECT_BUTTON_BASE = `${BUTTON_CHROME} p-[0.4rem_0.5rem] flex-1 min-w-0 flex items-center gap-1 text-left`;
// The per-row icon actions (issue #790): a 28px square hit area (h-7 w-7)
// wrapping a 14px glyph -- the #774 header-chrome spec. Weakly visible at
// opacity-60 and restored to full opacity on row hover / keyboard focus (the
// #251 sidebar inline-action convention; fully hiding was rejected there).
const ICON_BUTTON_BASE = `${BUTTON_CHROME} h-7 w-7 shrink-0 flex items-center justify-center text-foreground opacity-60 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50`;

// Rename dialog (issue #759, ADR-0037): display label only -- the reference
// name is never touched, so selection / SQL / active references all stay
// valid. The shell is a Radix Dialog (issue #105 lineage): portal + focus-trap
// + scroll-lock + ESC + overlay-click dismiss come from the primitive, and ESC
// / overlay-click route to onCancel via onOpenChange. showCloseButton={false}
// lets Radix auto-focus the Input (the RenameSessionDialog pattern);
// aria-describedby={undefined} opts out of a Description (the visible Label
// already names the field), which also silences Radix's missing-description
// warning. The submit guard expresses the old window.prompt's blank / no-change
// ignore: Save stays disabled while the trimmed draft is blank or still the
// current display name, so onSubmit can only fire with a real, trimmed label.
// Submit closes immediately (the parent's async rename runs after; a backend
// rejection -- display-label collision -- surfaces via the existing error
// channel, same as the native prompt's "dialog gone, async after" shape).
function WorkingSetRenameDialog({
  target,
  onCancel,
  onSubmit,
}: {
  target: DatasetDescriptor;
  onCancel: () => void;
  onSubmit: (newDisplay: string) => void;
}) {
  const [value, setValue] = useState(target.display_name);
  const trimmed = value.trim();
  const canSubmit = trimmed !== "" && trimmed !== target.display_name;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit(trimmed);
          }}
          className="grid gap-4"
        >
          <DialogTitle>
            <FormattedMessage id="workingSet.rename.title" defaultMessage="Rename display label" />
          </DialogTitle>
          <div className="grid gap-2">
            <Label htmlFor="working-set-rename-input">
              <FormattedMessage id="common.displayName" defaultMessage="Display name" />
            </Label>
            <Input
              id="working-set-rename-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onCancel}>
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              <FormattedMessage id="common.save" defaultMessage="Save" />
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Delete dialog (issue #759, ADR-0040): the AlertDialog shell keeps the old
// window.confirm's semantics -- the title names the display name, confirm
// removes, cancel is a no-op -- and adds the irreversibility description
// (deletion drops the reference name from the shared namespace; any SQL FROM
// it will fail, and the file must be re-uploaded). Dismiss is explicit-only
// (issue #105 destructive-confirm intent, same as ActiveSourceDeleteDialog):
// the AlertDialog primitive blocks pointer-outside interactions itself, and
// the onEscapeKeyDown guard below blocks ESC too (the primitive does NOT --
// an unguarded AlertDialog still closes on ESC). An irreversible removal must
// go through 取消 / 删除. The Action closes on click (Radix auto-close, NO
// preventDefault -- the deferred-close retry pattern stays with
// ActiveSourceDeleteDialog's candidate flow): the parent's async remove runs
// after the dialog is gone, and a backend refusal (active source, results
// exist) surfaces via the existing error channel. The destructive variant
// marks the irreversible action (DESIGN.md).
function WorkingSetDeleteDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: DatasetDescriptor;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog defaultOpen>
      <AlertDialogContent onEscapeKeyDown={(e) => e.preventDefault()}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <FormattedMessage
              id="workingSet.delete.confirm"
              defaultMessage="Remove {name} from the working set?"
              values={{ name: target.display_name }}
            />
          </AlertDialogTitle>
          <AlertDialogDescription>
            <FormattedMessage
              id="workingSet.delete.description"
              defaultMessage="The source file is removed and its reference name is dropped from the shared namespace — any SQL reading from it will fail. This cannot be undone; the file must be re-uploaded to restore the source."
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
            <FormattedMessage id="common.delete" defaultMessage="Delete" />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function WorkingSetList({
  datasets,
  activeName,
  onSelect,
  onRename,
  onReplace,
  onDelete,
  loading = false,
}: {
  datasets: DatasetDescriptor[];
  activeName: string | null;
  onSelect: (referenceName: string) => void;
  // Display-only rename (ADR-0037, issue #8): the reference name is never
  // touched, so selection / SQL / active references all stay valid.
  onRename: (referenceName: string, newDisplay: string) => void;
  // Re-upload a file onto this dataset's reference name (ADR-0042, issue #11):
  // a fresh snapshot takes over the name. Distinct from the dropzone's add --
  // the reference name to take over is explicit. Structured files only (the
  // backend rejects xlsx in this slice), so the picker excludes xlsx to match,
  // keeping the two entries (add vs replace) visually distinct (AC4). Optional
  // only so tests that don't exercise replace can skip it; App always supplies
  // it, and the button is hidden when it is absent (no silent no-op).
  onReplace?: (referenceName: string, path: string) => void;
  // Remove a source from the working set (issue #38, ADR-0040). The backend
  // detaches the snapshot, deletes its file, drops the reference name, and
  // appends a Deleted source lifecycle event. Optional only so tests that don't
  // exercise delete can skip it; App always supplies it, and the button is
  // hidden when it is absent (no silent no-op).
  onDelete?: (referenceName: string) => void;
  // Disables the action buttons while an async op (rename / ingest / replace /
  // delete) is in flight OR while a turn is in flight (ADR-0040 execution
  // window: ask in flight -> source management disabled), preventing concurrent
  // IPC and source-vs-turn interleaving.
  loading?: boolean;
}) {
  const intl = useIntl();
  // Which row's rename / delete dialog is open (issue #759). The dialogs
  // mount/unmount on these targets, so each open starts from fresh draft state.
  const [renameTarget, setRenameTarget] = useState<DatasetDescriptor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DatasetDescriptor | null>(null);
  // The row button that opened the dialog. Radix's close-time focus restore
  // targets the DialogTrigger context ref, but the openers here are the list's
  // per-row buttons (not DialogTrigger), so the restore is wired by hand:
  // captured on open, re-focused on close (issue #759 focus-management AC).
  const openTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Fallback restore target for the action-close paths (see closeDialog): the
  // list container is focusable programmatically only (tabIndex -1), so a
  // disabled opener does not strand keyboard focus on <body>.
  const listRef = useRef<HTMLUListElement | null>(null);
  const closeDialog = (clear: () => void) => {
    clear();
    // Deferred past the focus trap: while the scope is still mounted the trap
    // re-focuses the dialog content on any focus-out, and Radix's own
    // unmount-time restore (also a setTimeout(0)) targets a DialogTrigger ref
    // the list's per-row buttons never fill. Restoring on the same tick order
    // lands the close back on the opener. On Save / Delete-confirm the
    // mutation's loading gate has already disabled the opener (onRename /
    // onDelete fire before the close and runSimpleMutation sets loading
    // synchronously, batched into this same commit), and focus() on a
    // disabled button is ignored -- fall back to the list so keyboard users
    // keep a place in the working-set region.
    setTimeout(() => {
      const trigger = openTriggerRef.current;
      if (trigger && trigger.isConnected && !trigger.disabled) {
        trigger.focus();
      } else {
        listRef.current?.focus();
      }
    }, 0);
  };
  const closeRename = () => closeDialog(() => setRenameTarget(null));
  const closeDelete = () => closeDialog(() => setDeleteTarget(null));
  const openRename = (d: DatasetDescriptor, trigger: HTMLButtonElement) => {
    openTriggerRef.current = trigger;
    setRenameTarget(d);
  };
  const openDelete = (d: DatasetDescriptor, trigger: HTMLButtonElement) => {
    openTriggerRef.current = trigger;
    setDeleteTarget(d);
  };

  if (datasets.length === 0) {
    return (
      <p className="text-muted-foreground">
        <FormattedMessage
          id="workingSet.empty"
          defaultMessage="Working set is empty — drop or pick a data file to start."
        />
      </p>
    );
  }

  // Pick a structured file to swap in under this dataset's reference name. The
  // picker excludes .xlsx on purpose: the backend's replace path is structured-
  // only, so this keeps the two entries (add vs replace) visually distinct and
  // avoids offering a choice the backend would then reject.
  const pickReplace = async (d: DatasetDescriptor) => {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: intl.formatMessage({ id: "workingSet.fileFilter", defaultMessage: "Data files" }),
          extensions: ["csv", "parquet", "json", "jsonl", "ndjson"],
        },
      ],
    });
    if (typeof selected === "string") {
      onReplace?.(d.reference_name, selected);
    }
  };

  return (
    // ADR-0067 (issue #184): the working-set list / button / active-state /
    // small visuals ride Tailwind utility on each element below + the
    // BUTTON_CHROME-derived constants above (select + icon actions, issue
    // #790). The active STATE drives the select button's own conditional
    // className (bg-accent + font-semibold). The class hooks (.working-set /
    // .rename / .replace / .delete / .active / .stale) stay on the elements as
    // anchor points for selector queries and future migration slices.
    <>
      <ul ref={listRef} tabIndex={-1} className="working-set list-none m-0 p-0 outline-none">
        {datasets.map((d) => (
          // One horizontal row per dataset (issue #790): the select button and
          // the icon actions side by side; group is the hover hook the icon
          // weak-show restore keys off. A stale dataset renders the badge after
          // the row actions, where its basis-full under flex-wrap puts it alone
          // on the line below -- flex line collection follows source order, so
          // the badge must stay after the icons or it pushes them onto a third
          // line.
          <li
            key={d.reference_name}
            className={cn(
              "group my-[0.2rem] flex flex-wrap items-center gap-1",
              d.reference_name === activeName && "active",
              d.stale && "stale",
            )}
          >
            <button
              type="button"
              title={d.display_name}
              className={cn(
                SELECT_BUTTON_BASE,
                d.reference_name === activeName && "bg-accent font-semibold",
              )}
              onClick={() => onSelect(d.reference_name)}
            >
              <span className="min-w-0 flex-1 truncate">
                {d.display_name}
                {d.reference_name === activeName ? (
                  <FormattedMessage id="workingSet.activeSuffix" defaultMessage=" · current table" />
                ) : null}
              </span>
              {/* font-normal overrides the active button's font-semibold so the
                  row-count annotation stays muted-weight in either state;
                  shrink-0 + nowrap keep truncation from ever eliding the note. */}
              <small className="shrink-0 whitespace-nowrap text-muted-foreground font-normal">
                {" "}
                <FormattedMessage
                  id="workingSet.rowCount"
                  defaultMessage="{count, plural, one {# row} other {# rows}}"
                  values={{ count: d.row_count }}
                />
              </small>
            </button>
            <button
              type="button"
              className={cn(ICON_BUTTON_BASE, "rename")}
              aria-label={intl.formatMessage(
                { id: "workingSet.rename.ariaLabel", defaultMessage: "Rename {name}" },
                { name: d.display_name },
              )}
              title={intl.formatMessage({ id: "workingSet.rename.title", defaultMessage: "Rename display label" })}
              disabled={loading}
              onClick={(e) => openRename(d, e.currentTarget)}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {onReplace && (
              <button
                type="button"
                className={cn(ICON_BUTTON_BASE, "replace")}
                aria-label={intl.formatMessage(
                  { id: "workingSet.replace.ariaLabel", defaultMessage: "Replace source {name}" },
                  { name: d.display_name },
                )}
                title={intl.formatMessage({
                  id: "workingSet.replace.title",
                  defaultMessage: "Re-upload to replace this dataset (keeps the reference name)",
                })}
                disabled={loading}
                onClick={() => void pickReplace(d)}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className={cn(ICON_BUTTON_BASE, "delete")}
                aria-label={intl.formatMessage(
                  { id: "workingSet.delete.ariaLabel", defaultMessage: "Delete {name}" },
                  { name: d.display_name },
                )}
                title={intl.formatMessage({
                  id: "workingSet.delete.title",
                  defaultMessage: "Remove this dataset from the working set",
                })}
                disabled={loading}
                onClick={(e) => openDelete(d, e.currentTarget)}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
            {d.stale && (
              <Badge variant="secondary" className="stale-badge basis-full">
                <FormattedMessage
                  id="workingSet.staleRow"
                  defaultMessage="Invalidated because {name} was {reason, select, Deleted {deleted} Replaced {updated} other {changed}}"
                  values={{ name: d.stale.display_name, reason: d.stale.reason }}
                />
              </Badge>
            )}
          </li>
        ))}
      </ul>
      {renameTarget && (
        <WorkingSetRenameDialog
          target={renameTarget}
          onCancel={closeRename}
          onSubmit={(newDisplay) => {
            onRename(renameTarget.reference_name, newDisplay);
            closeRename();
          }}
        />
      )}
      {deleteTarget && (
        <WorkingSetDeleteDialog
          target={deleteTarget}
          onCancel={closeDelete}
          onConfirm={() => {
            onDelete?.(deleteTarget.reference_name);
            closeDelete();
          }}
        />
      )}
    </>
  );
}
