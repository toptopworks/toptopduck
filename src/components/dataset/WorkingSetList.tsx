import { useRef, useState, type MouseEvent, type ReactNode } from "react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import type { DatasetDescriptor } from "../../types/dataset";

// ADR-0067 (issue #184): the .working-set button rule (all: unset + cursor +
// padding + radius + display:block + width:100%) retired onto Tailwind
// utilities. Tailwind v4's Preflight already resets the button's background
// to transparent, inherits font/color, and zeroes margin/padding, so only the
// residual visual contract is re-stated here: strip the native border +
// appearance and set the var(--radius) corner. Issue #790 splits the former
// single full-width constant into the two row shapes below (select + icon).
// The cursor splits with them: the select button carries the hand (its click
// IS the row's selection -- the honest affordance), while the icon strip
// keeps the default arrow (the #790 decision: the pill's glyphs signal by
// color, not cursor). The pointer does switch cursors where the pill meets
// the button's tail -- accepted with the hand ruling; the button's body is
// one continuous hand either side of that edge (the label's native title
// never touches the cursor, so the old text-vs-everywhere flip is gone).
const BUTTON_CHROME = "appearance-none border-0 rounded-md";
// The select button: fills the row's leftover width (flex-1 + min-w-0 so the
// label can truncate inside), compact padding, left alignment (UA button text
// is centered). The active dataset's font-semibold emphasis layers on via
// cn() at the call site. The selection band and the hover tint are NOT here:
// both live on the row <li> (see DatasetRow) so the pointer anywhere on the
// row -- the action pill included -- lights the same full-height band.
const SELECT_BUTTON_BASE = `${BUTTON_CHROME} p-[0.4rem_0.5rem] flex-1 min-w-0 flex items-center gap-1 text-left cursor-pointer`;
// The row-actions overlay: the rename/replace/delete actions sit in an
// absolutely-positioned pill anchored inside the label-tail wrapper (the
// flow child holding the select button, see DatasetRow), floating ABOVE the
// truncated label instead of reserving flow width -- an un-hovered row gives
// the label the full row width, and a hovered row reveals the pill over the
// label's tail (the select button's truncate point sits under the pill).
// Anchoring inside the wrapper rather than the row keeps the pill
// structurally clear of whatever follows the button in flow: on a stale row
// the chip stays fully hoverable beside the revealed pill. The strip is
// packed tight -- no gap, no inlay: the 28px squares butt together into one
// compact bar (the glyphs keep ~7px of visual air inside their own hit
// areas). The wrapper spans exactly the row's bg-clip-content band (the li's
// py frames it), so inset-y-0 puts name band, selected band and action strip
// all at one height. The pill's ground is bg-accent -- the same tint a
// hovered or selected row carries -- so the strip reads as part of the row
// rather than a
// floating widget (a border/shadow card form would read as a separate widget
// on this ground); being opaque, it still keeps the label underneath from
// bleeding through. Visibility is the #865 hover-reveal contract moved one
// level up: the CONTAINER owns opacity-0 + pointer-events-none, restored on
// row hover (group-hover) or keyboard focus-visible -- any tabbed-into
// action lights the whole pill. Keyboard recovery keys off
// has-[:focus-visible] rather than focus-within: closing a dialog restores
// focus to the opening button, and a focus-WITHIN pill would glow forever
// after that restore even with the pointer parked elsewhere -- focus-visible
// follows the keyboard heuristic, which a script restore after a keyboard
// dialog flow still matches (that window is what focusRestoreRef
// suppresses), so the mouse flow closes clean. Tab order and aria-labels are
// untouched; `invisible` stays rejected (it drops the buttons from the a11y
// tree). Show/hide snaps (no transition): a per-row 150ms fade cross-fades
// the outgoing row's icons with the incoming row's on every row-to-row
// sweep, which reads as the strip flashing.
const ROW_ACTIONS_OVERLAY = `absolute inset-y-0 right-1 z-10 flex items-center gap-0 rounded-md bg-accent opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto has-[:focus-visible]:opacity-100 has-[:focus-visible]:pointer-events-auto`;
// The per-row icon actions (issue #790): a 28px square hit area (h-7 w-7)
// wrapping a 14px glyph -- the #774 header-chrome spec. Visibility is owned
// by the ROW_ACTIONS_OVERLAY container (see above); the buttons carry only
// the per-icon emphasis: the glyph rests muted and highlights to foreground
// on hover / keyboard focus -- on the pill's accent ground there is no
// further background tint to layer (a hover:bg-accent would be invisible
// against it), so color alone marks the hot icon. The cursor stays the
// default arrow (see BUTTON_CHROME); the loading state dims like every
// other action surface (disabled:opacity-50, the sidebar / result forms) --
// the pill container owns visibility, so the dim only marks the one hovered
// row's mid-load state.
const ICON_BUTTON_BASE = `${BUTTON_CHROME} h-7 w-7 flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-progress disabled:opacity-50`;
// The row-tooltip slot identity (which tooltip on which row owns the mutex).
type RowTipKind = "rename" | "replace" | "delete" | "stale";
interface TipKey {
  row: string;
  kind: RowTipKind;
}
const sameTipKey = (a: TipKey, b: TipKey) => a.row === b.row && a.kind === b.kind;

// The row-tooltip mutex plumbing, passed down from WorkingSetList to each row
// (see the openTip state there): the single-source open key, its setter, and
// the two dialog-close guards the action hints consult.
interface RowTipControls {
  openKey: TipKey | null;
  setTip: (key: TipKey, next: boolean) => void;
  dialogClosedAtRef: { current: number };
  focusRestoreRef: { current: boolean };
}

// One row-action icon button + its controlled hint tooltip (the shared shape
// of rename / replace / delete): pointer-enter opens the hint immediately
// (guarded against the dialog-close re-dispatch window), pointer-leave and
// blur close it, keyboard focus-visible opens it, and activating clears the
// slot before handing to the caller (the dialog opens on a clean state).
// The dialog-close programmatic focus restore must not re-open the hint on
// EITHER open path: our own handler checks focusRestoreRef, and Radix's
// internal any-focus open (focus events are non-cancelable, so it cannot be
// refused at the handler) is gated at the Tooltip's onOpenChange below.
// disableHoverableContent: terse non-copyable labels -- Radix's invisible
// hover bridge would hold the tooltip open after the pointer has left the
// icon and shadow the row above.
function RowActionButton({
  hintKey,
  open,
  tip,
  title,
  ariaLabel,
  actionClass,
  icon,
  disabled,
  onActivate,
}: {
  hintKey: TipKey;
  open: boolean;
  tip: RowTipControls;
  title: string;
  ariaLabel: string;
  actionClass: string;
  icon: ReactNode;
  disabled: boolean;
  onActivate: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { setTip, dialogClosedAtRef, focusRestoreRef } = tip;
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        // Radix's internal focus path fires on the dialog-close programmatic
        // restore too (non-cancelable focus, no focus-visible gate inside
        // the trigger): drop open requests while that restore is in flight.
        if (next && focusRestoreRef.current) return;
        setTip(hintKey, next);
      }}
      disableHoverableContent
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(ICON_BUTTON_BASE, actionClass)}
          aria-label={ariaLabel}
          disabled={disabled}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse" && Date.now() - dialogClosedAtRef.current > 300)
              setTip(hintKey, true);
          }}
          onPointerLeave={() => setTip(hintKey, false)}
          onFocus={(e) => {
            // Our own open keys off the keyboard heuristic and skips the
            // dialog-close programmatic restore; Radix's side is gated at
            // the onOpenChange above.
            if (e.target.matches(":focus-visible") && !focusRestoreRef.current)
              setTip(hintKey, true);
          }}
          onBlur={() => setTip(hintKey, false)}
          onClick={(e) => {
            setTip(hintKey, false);
            onActivate(e);
          }}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent
        data-hit-transparent
        className="pointer-events-none data-[state=closed]:animate-none!"
      >
        {title}
      </TooltipContent>
    </Tooltip>
  );
}

// One working-set row: the select button (label + row count), the floating
// action pill (rename / replace / delete via RowActionButton), and the stale
// chip. See the constants above for the band / pill / icon contracts and the
// openTip state on WorkingSetList for the row-tooltip mutex the hints share.
function DatasetRow({
  d,
  isActive,
  isSelected,
  loading,
  tip,
  onSelect,
  onOpenRename,
  onOpenDelete,
  onPickReplace,
}: {
  d: DatasetDescriptor;
  // The ACTIVE dataset (server truth): bolds the label. The accent band is
  // NOT this state's -- it follows the selection (see isSelected), since a
  // management click must move the highlight with the detail pane.
  isActive: boolean;
  // The detail pick: which row's detail the right pane shows. Puts the
  // accent band on the row -- the same element that carries the hover band,
  // so a picked row and a hovered row read at exactly the same height.
  isSelected: boolean;
  loading: boolean;
  tip: RowTipControls;
  onSelect: (referenceName: string) => void;
  onOpenRename: (d: DatasetDescriptor, trigger: HTMLButtonElement) => void;
  onOpenDelete?: (d: DatasetDescriptor, trigger: HTMLButtonElement) => void;
  onPickReplace?: (d: DatasetDescriptor) => void;
}) {
  const { openKey, setTip } = tip;
  const intl = useIntl();
  const key = (kind: RowTipKind): TipKey => ({ row: d.reference_name, kind });
  const isTipOpen = (kind: RowTipKind) => openKey !== null && sameTipKey(openKey, key(kind));
  return (
    <li
      className={cn(
        "group relative flex items-center gap-1 rounded-md py-[0.1rem] bg-clip-content hover:bg-accent",
        isActive && "active",
        isSelected && "selected bg-accent",
        d.stale && "stale",
      )}
    >
      {/* The label-tail wrapper: the flow child filling the row's leftover
          width. It owns the select button AND the action pill's positioning
          anchor -- the pill's right edge lands at the button's tail,
          structurally clear of whatever follows in flow (the stale chip),
          so the chip keeps its hover beside the revealed pill. The wrapper
          spans the li's content box, i.e. exactly the bg-clip-content band. */}
      <div className="relative flex-1 min-w-0 flex">
        <button
          type="button"
          className={cn(SELECT_BUTTON_BASE, isActive && "font-semibold")}
          onClick={() => onSelect(d.reference_name)}
        >
          {/* The truncated label's full text rides the OS-native title:
            truncation recovery without any Radix machinery (no popper to
            keep pointer-transparent, no mutex slot, no open/close handlers).
            Unlike the action hints' theme-following Radix tooltips (#865
            rejected native titles there -- chrome follows the OS), the name
            surfaces only its own text, so the OS chrome costs nothing. The
            hand cursor on the button below no longer flips when the
            affordance surfaces -- a native title never touches the cursor. */}
          <span className="min-w-0 flex-1 truncate" title={d.display_name}>
            {d.display_name}
          </span>
          {/* font-normal overrides the active button's font-semibold so the
            row-count annotation stays muted-weight in either state;
            shrink-0 + nowrap keep truncation from ever eliding the note.
            text-xs pins the caption token: the preflight small rule (80%)
            would resolve an unsized small at 11.2px under the panel's 14px
            baseline (issue #864) -- below the ladder's 12px floor. */}
          <small className="shrink-0 whitespace-nowrap text-xs text-muted-foreground font-normal">
            {" "}
            <FormattedMessage
              id="workingSet.rowCount"
              defaultMessage="{count, plural, one {# row} other {# rows}}"
              values={{ count: d.row_count }}
            />
          </small>
        </button>
        {/* The action pill (ROW_ACTIONS_OVERLAY): floats over the label's
            tail inside the wrapper; Radix Tooltip renders no DOM wrapper of
            its own, so the pill div is the buttons' direct flex parent and
            the has-focus-visible hook sees each tabbed-into action. */}
        <div className={ROW_ACTIONS_OVERLAY}>
          <RowActionButton
            hintKey={key("rename")}
            open={isTipOpen("rename")}
            tip={tip}
            title={intl.formatMessage({ id: "workingSet.rename.hint", defaultMessage: "Rename" })}
            ariaLabel={intl.formatMessage(
              { id: "workingSet.rename.ariaLabel", defaultMessage: "Rename {name}" },
              { name: d.display_name },
            )}
            actionClass="rename"
            icon={<Pencil className="h-3.5 w-3.5" aria-hidden="true" />}
            disabled={loading}
            onActivate={(e) => onOpenRename(d, e.currentTarget)}
          />
          {onPickReplace && (
            <RowActionButton
              hintKey={key("replace")}
              open={isTipOpen("replace")}
              tip={tip}
              title={intl.formatMessage({
                id: "workingSet.replace.hint",
                defaultMessage: "Replace",
              })}
              ariaLabel={intl.formatMessage(
                { id: "workingSet.replace.ariaLabel", defaultMessage: "Replace source {name}" },
                { name: d.display_name },
              )}
              actionClass="replace"
              icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
              disabled={loading}
              onActivate={() => onPickReplace(d)}
            />
          )}
          {onOpenDelete && (
            <RowActionButton
              hintKey={key("delete")}
              open={isTipOpen("delete")}
              tip={tip}
              title={intl.formatMessage({
                id: "workingSet.delete.hint",
                defaultMessage: "Delete",
              })}
              ariaLabel={intl.formatMessage(
                { id: "workingSet.delete.ariaLabel", defaultMessage: "Delete {name}" },
                { name: d.display_name },
              )}
              actionClass="delete"
              icon={<X className="h-3.5 w-3.5" aria-hidden="true" />}
              disabled={loading}
              onActivate={(e) => onOpenDelete(d, e.currentTarget)}
            />
          )}
        </div>
      </div>
      {d.stale && (
        // #793: a short chip with the full causal sentence on the tooltip --
        // the sentence used to wrap inside the badge and break the chip shape
        // in narrow columns. No action outlet here: the rerun path lives with
        // the result panel's stale banner (#758).
        <Tooltip open={isTipOpen("stale")} onOpenChange={(next) => setTip(key("stale"), next)}>
          <TooltipTrigger asChild>
            <Badge variant="secondary" className="stale-badge shrink-0">
              <FormattedMessage id="workingSet.staleRow" defaultMessage="Stale" />
            </Badge>
          </TooltipTrigger>
          <TooltipContent
            data-hit-transparent
            className="pointer-events-none data-[state=closed]:animate-none!"
          >
            {intl.formatMessage(
              {
                id: "workingSet.staleRow.hint",
                defaultMessage:
                  "Invalidated because {name} was {reason, select, Deleted {deleted} Replaced {updated} other {changed}}",
              },
              { name: d.stale.display_name, reason: d.stale.reason },
            )}
          </TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

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
            <FormattedMessage id="workingSet.rename.title" defaultMessage="Rename" />
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
  selectedName,
  onSelect,
  onRename,
  onReplace,
  onDelete,
  loading = false,
}: {
  datasets: DatasetDescriptor[];
  // The ACTIVE dataset (server truth, ADR-0051): bolds the row's label. The
  // authoritative naming is the tab header's Targets chip; bold is the row's
  // only in-list active marker (since #793 retired the " · current table"
  // suffix, the label weight is the sole carrier of this state -- the accent
  // band moved to the selection with it).
  activeName: string | null;
  // The detail pick (which row's detail the right pane shows): drives the
  // accent band. Passed as the RESOLVED pick (resolveWorkingSetDetail
  // output), so the band rides the deleted-pick fallbacks (active, then
  // first) with the pane and never diverges from what is shown.
  selectedName: string | null;
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
  // SINGLE-SOURCE tooltip mutex for a row: every tooltip on the row (the
  // three action hints, stale) is controlled off this one value, so a second
  // tooltip opening necessarily closes the first. Two mechanisms share the
  // job. Radix-internal opens (the pointermove path every trigger carries;
  // the stale chip is the only row tooltip without our own handlers)
  // broadcast a document tooltip.open event that every MOUNTED TooltipContent
  // answers by closing itself -- peers are gone before the opener's
  // onOpenChange reaches this state. Our direct opens (the hints' pointer
  // handlers) set this state without broadcasting (the dispatch sits inside
  // Radix's own state setter, so a prop-driven open never emits it), and the
  // single-source key is what excludes those. The pointermove path is also
  // transit-gated by the provider (isPointerInTransit, set while the pointer
  // crosses a HOVERABLE tooltip's exit grace area -- the stale chip's, the
  // one row tooltip without disableHoverableContent), so a sweep can
  // silently swallow a Radix-side open; the direct handlers are what
  // actually open the hints. Each Tooltip bridges Radix's internal
  // open/close intent (delayed-open timers, grace-area keeps) through
  // onOpenChange into this state; the action hints keep their direct
  // pointer-enter/-leave/focus/-blur handlers on top of it.
  const [openTip, setOpenTip] = useState<TipKey | null>(null);
  // Closing a dialog lifts Radix's modal pointer-events lock on <body>, and
  // Chromium answers that by re-dispatching a pointer enter at the pointer's
  // current position -- which re-opens the hint that was showing before the
  // click. Hints ignore pointer enters within 300ms of a dialog close; real
  // pointer travel always arrives later than that.
  const dialogClosedAtRef = useRef(0);
  // True while closeDialog's programmatic focus restore is in flight: that
  // restore is not user navigation, so it must not re-open a hint (the
  // keyboard heuristic makes the restored focus :focus-visible).
  const focusRestoreRef = useRef(false);
  const setTip = (key: TipKey, next: boolean) =>
    setOpenTip((current) => {
      // Closes are keyed: a stale-timer close for another tooltip must not
      // clear the one that is open now. Opens just take the slot -- Radix's
      // own opens arrive on an empty slot anyway (their tooltip.open
      // broadcast has already closed the mounted peers, see the openTip
      // comment above), and our direct opens (the action hints' pointer
      // handlers) are ordered pointer-leave-then-enter by the event
      // sequence, so a moving pointer releases the old hint before the next
      // one asks.
      if (!next) return current !== null && sameTipKey(current, key) ? null : current;
      return key;
    });
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
    dialogClosedAtRef.current = Date.now();
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
      focusRestoreRef.current = true;
      const trigger = openTriggerRef.current;
      if (trigger && trigger.isConnected && !trigger.disabled) {
        trigger.focus();
      } else {
        listRef.current?.focus();
      }
      // The focus handler consumed the flag synchronously if the restore
      // landed; clear it regardless so a later real Tab isn't suppressed.
      setTimeout(() => {
        focusRestoreRef.current = false;
      }, 0);
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

  // The empty set never reaches this list: WorkspaceWorkingSet renders the
  // single empty-state card instead (issue #792), so the two-column shell and
  // this list mount only for a non-empty set.

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

  // The row-tooltip mutex + its guards, bundled for the row components (see
  // RowTipControls).
  const tip: RowTipControls = {
    openKey: openTip,
    setTip,
    dialogClosedAtRef,
    focusRestoreRef,
  };

  return (
    // ADR-0067 (issue #184): the working-set list / button / active-state /
    // small visuals ride Tailwind utility on each element below + the
    // BUTTON_CHROME-derived constants above (select + icon actions, issue
    // #790). Two row states layer via cn(): the SELECTION puts the accent
    // band on the row <li> (see DatasetRow's isSelected for the band
    // contract), and the ACTIVE dataset bolds the select button's label.
    // The class hooks (.working-set
    // / .rename / .replace / .delete / .active / .selected / .stale) stay on
    // the elements as anchor points for selector queries and future
    // migration slices.
    <>
      <ul ref={listRef} tabIndex={-1} className="working-set list-none m-0 p-0 outline-none">
        {datasets.map((d) => (
          <DatasetRow
            key={d.reference_name}
            d={d}
            isActive={d.reference_name === activeName}
            isSelected={d.reference_name === selectedName}
            loading={loading}
            tip={tip}
            onSelect={onSelect}
            onOpenRename={openRename}
            onPickReplace={onReplace ? pickReplace : undefined}
            onOpenDelete={onDelete ? openDelete : undefined}
          />
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
